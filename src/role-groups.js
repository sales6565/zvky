/* ROLE GROUPS: an ADDITIVE layer over role permissions, and nothing else.
 *
 * A group is a named bag of permissions with a list of member roles. A role's
 * effective permissions are its own plus the grants of every group it is in.
 * That is the whole feature, and the three things it deliberately is NOT are
 * worth stating because each one would change the existing model:
 *
 *   NO GROUP-LEVEL DENY. Groups only ever add. A permission a group does not
 *      grant is a permission the group has no opinion about.
 *   NO NESTING. A group contains roles, never other groups. One hop, so the
 *      answer is a single join and cannot cycle.
 *   NO CAPABILITIES. Groups grant catalogue keys. projectScope, reviewStage and
 *      deleteAsset are values rather than booleans and stay with the tier — see
 *      the note at the top of src/role-permissions.js.
 *
 * ---------------------------------------------------------------------------
 * HOW AN EXPLICIT ROLE-LEVEL "OFF" INTERACTS WITH A GROUP GRANT, and why.
 *
 * In this application "off" is a ROW, not an absence: role_permissions holds one
 * row per (role, permission) with enabled 0 or 1, and setForRole() writes all
 * ninety-six keys on every save. So after a Super Admin has saved a role once,
 * every permission that role does not hold carries an explicit enabled = 0 row
 * with that admin's email on it — including the ninety keys they never looked
 * at. The column therefore CANNOT distinguish "deliberately revoked" from
 * "never granted"; only updated_by_email hints at it, and one save stamps the
 * same email on every row.
 *
 * THE DECISION: a group grant is additive and is not blocked by enabled = 0.
 * A group can re-grant something an administrator unticked on the role.
 *
 * THE CONSEQUENCE, STATED RATHER THAN HIDDEN: that is a real behaviour an
 * administrator can be surprised by, so it is made visible rather than silent —
 * the role's permission view marks every inherited key with the group it comes
 * from, deleting a group lists what will be lost before confirming, and every
 * change is audited. The alternative — "role-level off wins" — needs a third
 * state in role_permissions (granted / silent / revoked) to be expressible at
 * all, which is a change to the existing storage and to what a save means, and
 * the brief's hard constraint is that existing role permissions do not change.
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY PER REQUEST, and it does not grow.
 *
 * effectiveFor() runs on every authenticated request. Group grants are fetched
 * with a single join keyed on role_key — not one query per group and not one
 * per permission — so a studio with forty groups costs exactly what a studio
 * with one costs.
 */
const { v4: uuid } = require('uuid');
const catalog = require('./permission-catalog');
const { roleDef } = require('./roles');

/* WHAT A GROUP IS FOR, as a fixed vocabulary.
 *
 * Three kinds because the studio named three ways it thinks about roles — by
 * department, by seniority, and "a set we made up for this" — and a free-text
 * field would have become all three plus typos. Validated against this list, so
 * a kind the screen does not offer cannot arrive through the API. */
const KINDS = ['department', 'level', 'custom'];
const KIND_LABELS = { department: 'Department', level: 'Level', custom: 'Custom' };

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;

/* THE TWO KEYS A GROUP MAY NEVER GRANT, and they are the two that would let a
 * group hand out the power to make more groups.
 *
 *   settings.permissions  the role-permission screen itself. The catalogue
 *                         already marks it grantable: false and setForRole
 *                         strips it from any role but Super Admin's; a group
 *                         granting it would be the same door left open one
 *                         level up.
 *   settings.role_groups  this screen. A group that could grant it could add
 *                         its own members to a group that grants everything.
 *
 * Checked on the write, not only on the screen. */
const NEVER_GRANTABLE = ['settings.permissions', 'settings.role_groups'];

const MANAGE_KEY = 'settings.role_groups';

function grantable(key) {
  return catalog.isPermission(key) && !NEVER_GRANTABLE.includes(key);
}

/* ---------- reading ---------------------------------------------------------- */

/* THE ONE QUERY. Every group grant that reaches this role, in one hop.
 *
 * Returns a Set of permission keys. An empty Set for a role in no group, which
 * is what makes the no-groups case identical to the behaviour before this
 * existed — asserted against a snapshot of every role taken before the feature
 * was written (tests/fixtures/role-permissions-before-groups.json).
 *
 * UNKNOWN KEYS ARE DROPPED ON READ as well as refused on write: the catalogue
 * can shrink, and a key that is no longer a permission must not travel as one.
 */
async function grantsForRole(db, roleKey) {
  if (!roleKey) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT gp.permission_key
       FROM role_group_members gm
       JOIN role_group_permissions gp ON gp.group_id = gm.group_id
      WHERE gm.role_key = $1`,
    [roleKey]
  );
  return new Set(rows.map((r) => r.permission_key).filter((k) => catalog.isPermission(k)));
}

/* The same answer, but saying WHICH group each grant came from — for the role's
   permission view, which has to show inheritance rather than just the union. */
async function inheritanceForRole(db, roleKey) {
  if (!roleKey) return [];
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.kind, gp.permission_key
       FROM role_group_members gm
       JOIN role_groups g ON g.id = gm.group_id
       LEFT JOIN role_group_permissions gp ON gp.group_id = g.id
      WHERE gm.role_key = $1
      ORDER BY g.name, gp.permission_key`,
    [roleKey]
  );
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.id)) {
      byGroup.set(row.id, { id: row.id, name: row.name, kind: row.kind, permissions: [] });
    }
    if (row.permission_key && catalog.isPermission(row.permission_key)) {
      byGroup.get(row.id).permissions.push(row.permission_key);
    }
  }
  return [...byGroup.values()];
}

/* Every group, with its members and grants, for the screen. Three queries for
   the whole screen rather than three per group. */
async function list(db) {
  const { rows: groups } = await db.query(
    'SELECT id, name, kind, description, created_at, updated_at FROM role_groups ORDER BY kind, name'
  );
  if (!groups.length) return [];
  const { rows: members } = await db.query('SELECT group_id, role_key FROM role_group_members');
  const { rows: grants } = await db.query('SELECT group_id, permission_key FROM role_group_permissions');

  const byId = new Map(groups.map((g) => [g.id, {
    ...g,
    kindLabel: KIND_LABELS[g.kind] || g.kind,
    roles: [],
    permissions: [],
  }]));
  for (const m of members) {
    const g = byId.get(m.group_id);
    if (!g) continue;
    const def = roleDef(m.role_key);
    g.roles.push({ key: m.role_key, label: def ? def.label : m.role_key, known: Boolean(def) });
  }
  for (const p of grants) {
    const g = byId.get(p.group_id);
    if (!g || !catalog.isPermission(p.permission_key)) continue;
    g.permissions.push(p.permission_key);
  }
  for (const g of byId.values()) {
    g.roles.sort((a, b) => a.label.localeCompare(b.label));
    g.permissions.sort();
  }
  return [...byId.values()];
}

async function get(db, id) {
  const all = await list(db);
  return all.find((g) => g.id === id) || null;
}

/* WHAT DELETING THIS GROUP WOULD COST, asked before anybody confirms.
 *
 * Not "n roles and m permissions" — which roles, and which permissions each one
 * would actually LOSE. A role that holds a permission in its own right loses
 * nothing when the group goes, and saying otherwise would make the warning
 * noise rather than information. The caller passes the own-permission lookup so
 * this module does not have to know how a role's own set is built. */
async function impactOfDeleting(db, id, ownFor) {
  const group = await get(db, id);
  if (!group) return null;
  const losses = [];
  for (const role of group.roles) {
    /* Everything this role would still have: its own set, plus every OTHER
       group it is in. Only what is left over is a real loss. */
    const own = await ownFor(role.key);
    const otherGroups = (await inheritanceForRole(db, role.key))
      .filter((g) => g.id !== id)
      .flatMap((g) => g.permissions);
    const keeps = new Set([...own, ...otherGroups]);
    const lost = group.permissions.filter((k) => !keeps.has(k));
    if (lost.length) losses.push({ role: role.key, label: role.label, lost });
  }
  return { group, losses };
}

/* ---------- writing --------------------------------------------------------- */

function validateName(name) {
  const trimmed = String(name === undefined || name === null ? '' : name).trim();
  if (!trimmed) return { ok: false, status: 400, field: 'name', error: 'Give the group a name.' };
  if (trimmed.length > NAME_MAX) {
    return { ok: false, status: 400, field: 'name',
      error: `That name is longer than ${NAME_MAX} characters.` };
  }
  return { ok: true, name: trimmed };
}

function validateKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (!KINDS.includes(value)) {
    return { ok: false, status: 400, field: 'kind',
      error: `A group is a ${KINDS.join(', a ')} — not "${kind}".` };
  }
  return { ok: true, kind: value };
}

/* THE PERMISSIONS A GROUP MAY BE GIVEN, judged against the catalogue AND against
 * the person doing the giving.
 *
 * THREE RULES, and the second is the escalation one:
 *
 *   1. it has to be a permission        unknown keys are refused by name rather
 *                                       than dropped, so a typo is visible
 *   2. the editor has to hold it        nobody grants through a group what they
 *                                       could not grant directly. Read off
 *                                       req.permissions, which the server
 *                                       resolved for this session
 *   3. never the two bootstrap keys     NEVER_GRANTABLE above
 *
 * Duplicates collapse rather than erroring: sending a key twice is a request
 * for it to be granted, which it is. */
function validatePermissions(keys, editorHolds) {
  if (!Array.isArray(keys)) {
    return { ok: false, status: 400, field: 'permissions',
      error: 'Send the permissions this group should grant.' };
  }
  const unknown = [...new Set(keys.filter((k) => !catalog.isPermission(k)))];
  if (unknown.length) {
    return { ok: false, status: 400, field: 'permissions',
      error: `Not a permission: ${unknown.join(', ')}` };
  }
  const forbidden = [...new Set(keys.filter((k) => NEVER_GRANTABLE.includes(k)))];
  if (forbidden.length) {
    return { ok: false, status: 400, field: 'permissions',
      error: `A group cannot grant ${forbidden.map((k) => label(k)).join(' or ')}. `
        + 'Those are the keys that decide who may hand out permissions, so they are granted '
        + 'per role by a Super Admin and never inherited.' };
  }
  const beyond = [...new Set(keys.filter((k) => !editorHolds.has(k)))];
  if (beyond.length) {
    return { ok: false, status: 403, field: 'permissions',
      error: `You cannot grant ${beyond.map((k) => label(k)).join(', ')} through a group, `
        + 'because you do not hold it yourself.' };
  }
  return { ok: true, permissions: [...new Set(keys)] };
}

const label = (key) => (catalog.BY_KEY.get(key) || {}).label || key;

/* THE ROLES A GROUP MAY CONTAIN.
 *
 * Unknown role keys are refused. Super Admin is allowed in — it changes nothing,
 * because effectiveFor() short-circuits that tier to the whole catalogue before
 * any of this is consulted, so a group can neither add to nor take from it.
 * Refusing it would be a rule with no effect to explain. */
function validateRoles(keys) {
  if (!Array.isArray(keys)) {
    return { ok: false, status: 400, field: 'roles', error: 'Send the roles in this group.' };
  }
  const unknown = [...new Set(keys.filter((k) => !roleDef(k)))];
  if (unknown.length) {
    return { ok: false, status: 400, field: 'roles',
      error: `Not a role: ${unknown.join(', ')}` };
  }
  return { ok: true, roles: [...new Set(keys)] };
}

async function record(db, { groupId, groupName, action, detail, actor }) {
  await db.query(
    `INSERT INTO role_group_audit (id, group_id, group_name, action, detail, actor_id, actor_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuid(), groupId || null, groupName || null, action, detail || null,
      actor ? actor.id : null, actor ? actor.email : null]
  );
  console.log(`[role-groups] ${actor ? actor.email : 'system'} ${action} "${groupName}"`
    + `${detail ? ` — ${detail}` : ''}`);
}

async function create(db, { name, kind, description }, actor) {
  const named = validateName(name);
  if (!named.ok) return named;
  const kinded = validateKind(kind);
  if (!kinded.ok) return kinded;

  const { rows: clash } = await db.query('SELECT id FROM role_groups WHERE name = $1', [named.name]);
  if (clash.length) {
    return { ok: false, status: 409, field: 'name', error: `There is already a group called "${named.name}".` };
  }
  const id = uuid();
  await db.query(
    'INSERT INTO role_groups (id, name, kind, description, created_by_email) VALUES ($1,$2,$3,$4,$5)',
    [id, named.name, kinded.kind, String(description || '').trim().slice(0, DESCRIPTION_MAX) || null,
      actor ? actor.email : null]
  );
  await record(db, { groupId: id, groupName: named.name, action: 'created',
    detail: KIND_LABELS[kinded.kind], actor });
  return { ok: true, group: await get(db, id) };
}

async function rename(db, id, { name, kind, description }, actor) {
  const before = await get(db, id);
  if (!before) return { ok: false, status: 404, error: 'That group does not exist.' };

  const patch = {};
  if (name !== undefined) {
    const named = validateName(name);
    if (!named.ok) return named;
    if (named.name !== before.name) {
      const { rows: clash } = await db.query(
        'SELECT id FROM role_groups WHERE name = $1 AND id <> $2', [named.name, id]);
      if (clash.length) {
        return { ok: false, status: 409, field: 'name',
          error: `There is already a group called "${named.name}".` };
      }
    }
    patch.name = named.name;
  }
  if (kind !== undefined) {
    const kinded = validateKind(kind);
    if (!kinded.ok) return kinded;
    patch.kind = kinded.kind;
  }
  if (description !== undefined) {
    patch.description = String(description || '').trim().slice(0, DESCRIPTION_MAX) || null;
  }
  if (!Object.keys(patch).length) return { ok: true, group: before, unchanged: true };

  await db.query(
    'UPDATE role_groups SET name = COALESCE($1, name), kind = COALESCE($2, kind), '
    + 'description = CASE WHEN $3 = 1 THEN $4 ELSE description END WHERE id = $5',
    [patch.name === undefined ? null : patch.name,
      patch.kind === undefined ? null : patch.kind,
      'description' in patch ? 1 : 0,
      patch.description === undefined ? null : patch.description,
      id]
  );
  const detail = Object.entries(patch)
    .map(([k, v]) => `${k}: ${before[k] === v ? 'unchanged' : `"${before[k] || ''}" → "${v || ''}"`}`)
    .join(', ');
  await record(db, { groupId: id, groupName: patch.name || before.name, action: 'renamed', detail, actor });
  return { ok: true, group: await get(db, id) };
}

async function remove(db, id, actor) {
  const before = await get(db, id);
  if (!before) return { ok: false, status: 404, error: 'That group does not exist.' };
  /* The members and the grants go with it, by the foreign keys — see the
     migration. Deleting the parent row is the whole delete, which is what makes
     "no orphan rows" a property of the schema rather than of this function
     remembering. */
  await db.query('DELETE FROM role_groups WHERE id = $1', [id]);
  await record(db, { groupId: null, groupName: before.name, action: 'deleted',
    detail: `${before.roles.length} role(s), ${before.permissions.length} permission(s)`, actor });
  return { ok: true, deleted: before };
}

async function setRoles(db, id, roleKeys, actor) {
  const group = await get(db, id);
  if (!group) return { ok: false, status: 404, error: 'That group does not exist.' };
  const checked = validateRoles(roleKeys);
  if (!checked.ok) return checked;

  const had = new Set(group.roles.map((r) => r.key));
  const wanted = new Set(checked.roles);
  const added = [...wanted].filter((k) => !had.has(k));
  const removed = [...had].filter((k) => !wanted.has(k));

  for (const key of removed) {
    await db.query('DELETE FROM role_group_members WHERE group_id = $1 AND role_key = $2', [id, key]);
  }
  for (const key of added) {
    await db.query(
      'INSERT IGNORE INTO role_group_members (group_id, role_key, added_by_email) VALUES ($1,$2,$3)',
      [id, key, actor ? actor.email : null]
    );
  }
  if (added.length || removed.length) {
    await record(db, { groupId: id, groupName: group.name, action: 'members',
      detail: [added.length ? `+${added.join(', ')}` : '', removed.length ? `-${removed.join(', ')}` : '']
        .filter(Boolean).join(' '),
      actor });
  }
  return { ok: true, group: await get(db, id), added, removed };
}

async function setPermissions(db, id, keys, actor, editorHolds) {
  const group = await get(db, id);
  if (!group) return { ok: false, status: 404, error: 'That group does not exist.' };
  const checked = validatePermissions(keys, editorHolds || new Set());
  if (!checked.ok) return checked;

  const had = new Set(group.permissions);
  const wanted = new Set(checked.permissions);
  const added = [...wanted].filter((k) => !had.has(k));
  const removed = [...had].filter((k) => !wanted.has(k));

  for (const key of removed) {
    await db.query('DELETE FROM role_group_permissions WHERE group_id = $1 AND permission_key = $2',
      [id, key]);
  }
  for (const key of added) {
    await db.query(
      'INSERT IGNORE INTO role_group_permissions (group_id, permission_key, added_by_email) VALUES ($1,$2,$3)',
      [id, key, actor ? actor.email : null]
    );
  }
  if (added.length || removed.length) {
    await record(db, { groupId: id, groupName: group.name, action: 'permissions',
      detail: [added.length ? `+${added.join(', ')}` : '', removed.length ? `-${removed.join(', ')}` : '']
        .filter(Boolean).join(' '),
      actor });
  }
  return { ok: true, group: await get(db, id), added, removed };
}

/* A DESIGNATION WAS DELETED: forget it everywhere.
 *
 * Called by the reference-data delete path. There is no foreign key to roles —
 * role_permissions has never had one either, because a designation lives in
 * reference data that loads into memory — so this is the cleanup, and the
 * migration sweeps anything an older install left behind. */
async function forgetRole(db, roleKey) {
  if (!roleKey) return 0;
  const { result } = await db.query('DELETE FROM role_group_members WHERE role_key = $1', [roleKey]);
  return (result && result.affectedRows) || 0;
}

async function audit(db, limit = 100) {
  const capped = Math.min(Number(limit) || 100, 500);
  const { rows } = await db.query(
    'SELECT * FROM role_group_audit ORDER BY seq DESC LIMIT $1', [capped]);
  return rows.map((r) => ({
    id: r.id,
    group: r.group_name,
    action: r.action,
    detail: r.detail,
    actor: r.actor_email || 'system',
    at: r.created_at,
  }));
}

module.exports = {
  KINDS, KIND_LABELS, NAME_MAX, DESCRIPTION_MAX, NEVER_GRANTABLE, MANAGE_KEY,
  grantable, grantsForRole, inheritanceForRole, list, get, impactOfDeleting,
  create, rename, remove, setRoles, setPermissions, forgetRole, audit,
  validateName, validateKind, validatePermissions, validateRoles,
};
