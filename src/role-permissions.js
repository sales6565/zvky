// What each role may do, as rows rather than as code.
//
// Every user's permissions come from their role: one lookup by role key, no
// per-user rows. A Super Admin configures a role once and everyone holding it
// changes together.
//
// The tier system underneath has not gone away, and cannot: it carries the
// things a checkbox cannot express. `projectScope` decides how much of the
// studio somebody sees ('all', 'owned', 'team', 'own_work'), `reviewStage`
// which gate they hold, `deleteAsset` how far a deletion reaches. Those are
// values, not booleans, and they stay with the tier. This table carries the
// booleans — what may be done — and the tier still decides how much of the
// studio it may be done to.
//
// A role with no rows yet is seeded from its tier the first time it is read,
// so a designation added in Settings arrives with the permissions its tier
// implies rather than with none.

const { v4: uuid } = require('uuid');
const catalog = require('./permission-catalog');
const { capabilitiesForTier } = require('./role-tiers');
const { roleDef } = require('./roles');

// Permissions a role holds, as a Set. Null when the role is unknown.
async function forRole(db, roleKey) {
  if (!roleKey) return null;
  const { rows } = await db.query(
    'SELECT permission_key FROM role_permissions WHERE role_key = $1 AND enabled = 1',
    [roleKey]
  );
  if (rows.length) return new Set(rows.map((r) => r.permission_key));

  // No rows at all: either a role added since the last seed, or one whose
  // permissions were all switched off. Those are different, and the difference
  // matters — so ask whether the role has been written at all.
  const { rows: any } = await db.query(
    'SELECT COUNT(*) AS n FROM role_permissions WHERE role_key = $1',
    [roleKey]
  );
  if (Number(any[0].n) > 0) return new Set(); // deliberately empty
  return null;                                 // never seeded
}

// The permissions a role's tier implies. The starting state for a role that
// has never been configured, and what "reset to the role's defaults" means.
function defaultsFor(roleKey) {
  const def = roleDef(roleKey);
  if (!def) return new Set();
  const caps = capabilitiesForTier(def.tier) || {};
  return catalog.baselineFor(caps);
}

// Write a role's defaults, for a role that has none. Returns what was written.
async function seedRole(db, roleKey, { actor } = {}) {
  const defaults = defaultsFor(roleKey);
  for (const key of catalog.KEYS) {
    await db.query(
      `INSERT IGNORE INTO role_permissions (role_key, permission_key, enabled, updated_by_email)
       VALUES ($1,$2,$3,$4)`,
      [roleKey, key, defaults.has(key) ? 1 : 0, actor ? actor.email : 'system']
    );
  }
  return defaults;
}

// The permission set to judge a request by. Seeds on first use so a role added
// in Settings works immediately.
async function effectiveFor(db, roleKey) {
  // The Super Admin role holds the whole catalogue, always, without consulting
  // the table. Anything else is how the role that fixes everyone's access ends
  // up unable to reach a feature — see topUpRole below for how that happened.
  if (isSuperAdmin(roleKey)) return new Set(catalog.KEYS);

  const held = await forRole(db, roleKey);
  if (held) {
    // The role has rows, but the catalogue may have grown since they were
    // written. Fill in the gaps at their defaults rather than reading a missing
    // row as "not allowed".
    const topped = await topUpRole(db, roleKey, held);
    return topped;
  }
  await seedRole(db, roleKey);
  return defaultsFor(roleKey);
}

function isSuperAdmin(roleKey) {
  const def = roleDef(roleKey);
  return Boolean(def && def.tier === 'super_admin');
}

// Give a role its defaults for any permission that did not exist when it was
// last written.
//
// This is the bug that took the Projects tab away from Super Admin, and the
// Settings page before it. seedRole only ever ran for a role with NO rows, so
// a role seeded when the catalogue had 29 keys never saw the 30th. A missing
// row reads as "not held", so every role silently failed to hold every
// permission added after it was seeded — including the role whose whole job is
// to hand those permissions out.
//
// Cheap: the INSERT IGNOREs only run when a key is genuinely absent, which is
// once per role per catalogue change and never again.
async function topUpRole(db, roleKey, held) {
  const { rows } = await db.query(
    'SELECT permission_key FROM role_permissions WHERE role_key = $1', [roleKey]
  );
  const written = new Set(rows.map((r) => r.permission_key));
  const missing = catalog.KEYS.filter((k) => !written.has(k));
  if (!missing.length) return held;

  const defaults = defaultsFor(roleKey);
  for (const key of missing) {
    await db.query(
      `INSERT IGNORE INTO role_permissions (role_key, permission_key, enabled, updated_by_email)
       VALUES ($1,$2,$3,'system')`,
      [roleKey, key, defaults.has(key) ? 1 : 0]
    );
    if (defaults.has(key)) held.add(key);
  }
  console.log(`[role-permissions] "${roleKey}" gained ${missing.length} new permission(s) from the catalogue: ${missing.join(', ')}`);
  return held;
}

// Every role's settings at once, for the screen.
async function all(db) {
  const { rows } = await db.query('SELECT role_key, permission_key, enabled FROM role_permissions');
  const byRole = new Map();
  for (const row of rows) {
    if (!byRole.has(row.role_key)) byRole.set(row.role_key, new Set());
    if (row.enabled) byRole.get(row.role_key).add(row.permission_key);
  }
  // The screen reads this, so it has to agree with what the checks enforce.
  for (const key of byRole.keys()) {
    if (isSuperAdmin(key)) byRole.set(key, new Set(catalog.KEYS));
  }
  return byRole;
}

// --- writing -----------------------------------------------------------------

// Permissions the Super Admin role may never lose: all of them.
//
// This used to be two keys — the pair that, switched off, removed the only way
// to switch them back on — with the rest changeable behind a confirmation. That
// left the role that grants everyone else's access able to lose its own, and
// the catalogue-growth bug above meant it could lose access it never knowingly
// gave up. Super Admin now means "every permission in the catalogue", as a
// definition rather than as a row somebody has to maintain.
//
// Kept as a named export because tests and the screen both ask what cannot be
// switched off, and "everything" is a perfectly good answer to that.
const SUPER_ADMIN_LOCKED = catalog.KEYS;

function lockedFor(roleKey) {
  return isSuperAdmin(roleKey) ? [...catalog.KEYS] : [];
}

// Set a role's permissions to exactly this set, recording each change.
//
// A diff rather than a rewrite, so the audit trail says what changed instead of
// "saved 28 permissions".
async function setForRole(db, roleKey, wantedKeys, actor) {
  const wanted = new Set((wantedKeys || []).filter((k) => catalog.isPermission(k)));

  // The locked ones stay on whatever anybody sends. For Super Admin that is the
  // whole catalogue, so this call cannot take anything away from it.
  for (const key of lockedFor(roleKey)) wanted.add(key);

  // And settings.permissions is never switched on for anything but the Super
  // Admin role. A role holding it could give itself every other permission, so
  // enabling it elsewhere is a door that only opens outwards.
  const def = roleDef(roleKey);
  if (!def || def.tier !== 'super_admin') wanted.delete('settings.permissions');

  const current = (await forRole(db, roleKey)) || defaultsFor(roleKey);
  const enabled = [...wanted].filter((k) => !current.has(k));
  const disabled = [...current].filter((k) => !wanted.has(k));

  for (const key of catalog.KEYS) {
    const on = wanted.has(key) ? 1 : 0;
    await db.query(
      `INSERT INTO role_permissions (role_key, permission_key, enabled, updated_by_id, updated_by_email)
       VALUES ($1,$2,$3,$4,$5)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
         updated_by_id = VALUES(updated_by_id), updated_by_email = VALUES(updated_by_email)`,
      [roleKey, key, on, actor ? actor.id : null, actor ? actor.email : null]
    );
  }

  for (const [keys, action] of [[enabled, 'enabled'], [disabled, 'disabled']]) {
    for (const key of keys) {
      await db.query(
        `INSERT INTO role_permission_audit (id, role_key, permission_key, action, actor_id, actor_email)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuid(), roleKey, key, action, actor ? actor.id : null, actor ? actor.email : null]
      );
      console.log(`[role-permissions] ${actor ? actor.email : 'system'} ${action} "${key}" for role "${roleKey}"`);
    }
  }

  return { enabled, disabled, permissions: [...wanted] };
}

async function audit(db, roleKey, limit = 100) {
  const capped = Math.min(Number(limit) || 100, 500);
  const { rows } = roleKey
    ? await db.query('SELECT * FROM role_permission_audit WHERE role_key = $1 ORDER BY seq DESC LIMIT $2', [roleKey, capped])
    : await db.query('SELECT * FROM role_permission_audit ORDER BY seq DESC LIMIT $1', [capped]);
  return rows.map((r) => ({
    id: r.id,
    role: r.role_key,
    roleLabel: (roleDef(r.role_key) || {}).label || r.role_key,
    permission: r.permission_key,
    permissionLabel: (catalog.BY_KEY.get(r.permission_key) || {}).label || r.permission_key,
    action: r.action,
    actor: r.actor_email || 'system',
    at: r.created_at,
  }));
}

module.exports = {
  forRole, defaultsFor, seedRole, topUpRole, effectiveFor, all, setForRole, audit,
  lockedFor, isSuperAdmin, SUPER_ADMIN_LOCKED,
};
