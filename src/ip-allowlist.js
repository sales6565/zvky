// The IP allowlist: which addresses may reach this application at all.
//
// Stored in the database so a Super Admin can change it without a deploy, and
// mirrored in memory because the check runs on every single request — including
// the ones for static files — and cannot afford a query each time. The mirror
// is loaded at startup and reloaded on every write, the same arrangement
// src/reference-data.js uses for the dropdown lists.
//
// The escape hatches deliberately live outside this module, in
// src/middleware/ip-allowlist.js, and read the environment rather than the
// database. A safeguard that can be edited through the thing it safeguards is
// not a safeguard.

const { v4: uuid } = require('uuid');
const ipMatch = require('./ip-match');

let cache = [];
let loaded = false;

function isLoaded() {
  return loaded;
}

async function load(db) {
  const { rows } = await db.query(
    'SELECT * FROM ip_allowlist WHERE is_active = 1 ORDER BY created_at'
  );
  cache = rows.map(shape);
  loaded = true;
  return cache;
}

function shape(row) {
  return {
    id: row.id,
    address: row.address,
    label: row.label || '',
    isActive: Boolean(row.is_active),
    createdBy: row.created_by_email || null,
    createdAt: row.created_at,
  };
}

// Active entries only: the middleware asks this on every request.
function entries() {
  return cache.slice();
}

// Everything, for the management screen, which needs to show what has been
// switched off as well as what is live.
async function listAll(db) {
  const { rows } = await db.query('SELECT * FROM ip_allowlist ORDER BY is_active DESC, created_at');
  return rows.map(shape);
}

// Which entry, if any, lets this address in.
function findMatch(clientIP) {
  return ipMatch.findMatch(clientIP, cache);
}

// An empty allowlist means the gate is off. This is the difference between a
// misconfiguration being recoverable and being a locked door with the key
// inside: deleting the last entry, or deploying against a fresh database,
// leaves the app reachable rather than reachable by nobody.
function isEmpty() {
  return cache.length === 0;
}

// --- the audit trail ---------------------------------------------------------
// Every change is recorded with who made it, from where, and when. Deletions
// included — especially deletions, since the interesting question after a
// lockout is who removed what.
async function record(db, { action, address, label, actor, actorIp, detail }) {
  await db.query(
    `INSERT INTO ip_allowlist_audit (id, action, address, label, actor_id, actor_email, actor_ip, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      uuid(), action, address || null, label || null,
      actor ? actor.id : null, actor ? actor.email : null, actorIp || null, detail || null,
    ]
  );
  console.log(
    `[ip-allowlist] ${action} ${address || ''}` +
    `${actor ? ` by ${actor.email}` : ' by the system'}${actorIp ? ` from ${actorIp}` : ''}` +
    `${detail ? ` — ${detail}` : ''}`
  );
}

async function auditTrail(db, limit = 50) {
  const { rows } = await db.query(
    'SELECT * FROM ip_allowlist_audit ORDER BY created_at DESC, id DESC LIMIT $1',
    [Math.min(Number(limit) || 50, 200)]
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    address: row.address,
    label: row.label,
    actor: row.actor_email,
    actorIp: row.actor_ip,
    detail: row.detail,
    at: row.created_at,
  }));
}

// --- writing -----------------------------------------------------------------

function validate(address, label, { existingId = null } = {}) {
  const errors = [];
  const text = String(address ?? '').trim();

  if (!text) {
    errors.push({ field: 'address', message: 'An IP address or CIDR range is required.' });
  } else if (!ipMatch.isValidEntry(text)) {
    errors.push({
      field: 'address',
      message: `"${text}" is not a valid IP address or CIDR range. Examples: 106.51.81.61, 106.51.81.0/24, 2001:db8::/32`,
    });
  }

  const canonical = text ? ipMatch.normaliseEntry(text) : null;
  if (canonical) {
    const clash = cache.find((e) => e.id !== existingId && ipMatch.normaliseEntry(e.address) === canonical);
    if (clash) errors.push({ field: 'address', message: `${canonical} is already on the list.` });
  }

  if (String(label ?? '').length > 120) {
    errors.push({ field: 'label', message: 'The note must be 120 characters or fewer.' });
  }

  return { errors, canonical };
}

async function create(db, { address, label }, { actor, actorIp }) {
  const { errors, canonical } = validate(address, label);
  if (errors.length) return { ok: false, status: 400, errors };

  const id = uuid();
  await db.query(
    `INSERT INTO ip_allowlist (id, address, label, is_active, created_by_id, created_by_email)
     VALUES ($1,$2,$3,1,$4,$5)`,
    [id, canonical, String(label ?? '').trim() || null, actor ? actor.id : null, actor ? actor.email : null]
  );
  await record(db, { action: 'added', address: canonical, label, actor, actorIp });
  await load(db);
  return { ok: true, status: 201, entry: cache.find((e) => e.id === id) || null };
}

async function update(db, id, { address, label, isActive }, { actor, actorIp }) {
  const { rows } = await db.query('SELECT * FROM ip_allowlist WHERE id = $1', [id]);
  if (!rows.length) return { ok: false, status: 404, errors: [{ message: 'That entry does not exist.' }] };
  const current = shape(rows[0]);

  const nextAddress = address === undefined ? current.address : address;
  const nextLabel = label === undefined ? current.label : label;
  const { errors, canonical } = validate(nextAddress, nextLabel, { existingId: id });
  if (errors.length) return { ok: false, status: 400, errors };

  const nextActive = isActive === undefined ? current.isActive : Boolean(isActive);
  await db.query(
    'UPDATE ip_allowlist SET address = $1, label = $2, is_active = $3 WHERE id = $4',
    [canonical, String(nextLabel ?? '').trim() || null, nextActive ? 1 : 0, id]
  );

  const changes = [];
  if (canonical !== current.address) changes.push(`address ${current.address} -> ${canonical}`);
  if (nextActive !== current.isActive) changes.push(nextActive ? 'reactivated' : 'deactivated');
  if ((String(nextLabel ?? '').trim() || null) !== (current.label || null)) changes.push('note changed');

  await record(db, {
    action: 'changed', address: canonical, label: nextLabel, actor, actorIp,
    detail: changes.join('; ') || 'no effective change',
  });
  await load(db);
  return { ok: true, status: 200, entry: cache.find((e) => e.id === id) || shape({ ...rows[0], address: canonical, is_active: nextActive ? 1 : 0 }) };
}

async function remove(db, id, { actor, actorIp }) {
  const { rows } = await db.query('SELECT * FROM ip_allowlist WHERE id = $1', [id]);
  if (!rows.length) return { ok: false, status: 404, errors: [{ message: 'That entry does not exist.' }] };
  const current = shape(rows[0]);

  await db.query('DELETE FROM ip_allowlist WHERE id = $1', [id]);
  await record(db, {
    action: 'removed', address: current.address, label: current.label, actor, actorIp,
    // Worth recording explicitly: this is the change most likely to be regretted.
    detail: actorIp && ipMatch.matches(actorIp, current.address) ? 'this entry covered the actor\'s own address' : null,
  });
  await load(db);
  return { ok: true, status: 200, removed: current, nowEmpty: isEmpty() };
}

// Seeded on first run so the gate has something in it before anyone signs in.
async function seed(db, addresses) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM ip_allowlist');
  if (Number(rows[0].n) > 0) return 0;
  let added = 0;
  for (const { address, label } of addresses) {
    const canonical = ipMatch.normaliseEntry(address);
    if (!canonical) continue;
    await db.query(
      `INSERT INTO ip_allowlist (id, address, label, is_active, created_by_id, created_by_email)
       VALUES ($1,$2,$3,1,NULL,'system')`,
      [uuid(), canonical, label || null]
    );
    await record(db, { action: 'seeded', address: canonical, label, actor: null, detail: 'initial allowlist' });
    added++;
  }
  return added;
}

module.exports = {
  load,
  isLoaded,
  entries,
  listAll,
  findMatch,
  isEmpty,
  validate,
  create,
  update,
  remove,
  seed,
  record,
  auditTrail,
};
