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

// The tables, owned here rather than in the migration, so that whoever needs
// them can create them: startup, and the management screen when it finds them
// missing. Both statements are idempotent.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS ip_allowlist (
      id CHAR(36) NOT NULL PRIMARY KEY,
      address VARCHAR(64) NOT NULL,
      label VARCHAR(120) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by_id CHAR(36) NULL,
      created_by_email VARCHAR(191) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ip_allowlist_address (address),
      KEY idx_ip_allowlist_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ip_allowlist_audit (
      id CHAR(36) NOT NULL PRIMARY KEY,
      action VARCHAR(24) NOT NULL,
      address VARCHAR(64) NULL,
      label VARCHAR(120) NULL,
      actor_id CHAR(36) NULL,
      actor_email VARCHAR(191) NULL,
      actor_ip VARCHAR(64) NULL,
      detail VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_ip_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let cache = [];

// Whether the tables behind this feature can actually be read.
//
// This is tracked rather than assumed because the alternative was worse: the
// first version let a failed load throw out of whatever called it, so a missing
// table meant the management screen answered "a database error" while the gate
// quietly passed every request. The feature has to know when its own storage is
// gone, or it cannot say so.
//
//   ready          the tables are there and the mirror below reflects them
//   missing-tables they do not exist — the migration did not run, or could not
//   unavailable    they exist but could not be read (permissions, connection)
//   not-loaded     nothing has tried yet
let storage = { state: 'not-loaded', detail: null, code: null };

function storageStatus() {
  return { ...storage, ok: storage.state === 'ready' };
}

// True only when the list below is a faithful copy of the table. The gate reads
// this: it must never treat "we could not look" as "there is nothing there".
function isLoaded() {
  return storage.state === 'ready';
}

// Create the tables. Safe to call at any time; both statements are IF NOT
// EXISTS. Throws on a permission problem, which the caller reports rather than
// hides — a Super Admin who cannot restrict access needs to know why.
async function ensureTables(db) {
  for (const sql of TABLES) await db.query(sql);
}

// Read the table into the mirror. A failure is recorded rather than thrown:
// every caller of this is either startup or a write, and neither should die
// because the feature is not installed. Returns true when the mirror is good.
async function load(db) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ip_allowlist WHERE is_active = 1 ORDER BY created_at'
    );
    cache = rows.map(shape);
    storage = { state: 'ready', detail: null, code: null };
    return true;
  } catch (err) {
    // Deliberately empty rather than stale: whatever is in here would be acted
    // on by the gate, and acting on a copy we can no longer verify is worse
    // than admitting we cannot see the list.
    cache = [];
    fault(err);
    return false;
  }
}

// Record a storage failure, and say so the moment it is discovered rather than
// waiting for the next request to notice. Every path that finds the storage
// broken comes through here, so this is the one place that has to announce it.
function fault(err) {
  const was = storage.state;
  storage = {
    state: err.code === 'ER_NO_SUCH_TABLE' ? 'missing-tables' : 'unavailable',
    detail: err.sqlMessage || err.message,
    code: err.code || null,
  };
  if (was !== storage.state) {
    console.error(
      `[ip-allowlist] NOT ENFORCING: ${storage.state === 'missing-tables'
        ? 'the ip_allowlist tables do not exist'
        : 'the ip_allowlist tables could not be read'} ` +
      `(${storage.code || 'error'}: ${storage.detail}). ` +
      'Every address can currently reach this app unless IP_ALLOWLIST_FAIL_CLOSED is set. ' +
      'Repair it on Settings -> Allowed IP Addresses.'
    );
  }
}

// Create the tables if needed, seed a first address into an empty list, and
// load the mirror. Returns what happened so the caller can report it.
async function install(db, seedAddresses = []) {
  try {
    await ensureTables(db);
  } catch (err) {
    cache = [];
    fault(err);
    return { ok: false, seeded: 0, ...storageStatus() };
  }
  let seeded = 0;
  try {
    seeded = await seed(db, seedAddresses);
  } catch (err) {
    // Seeding is a convenience; failing it must not leave the tables unread.
    console.warn(`[ip-allowlist] could not seed the initial address: ${err.sqlMessage || err.message}`);
  }
  const ok = await load(db);
  return { ok, seeded, ...storageStatus() };
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

// Active entries only: the middleware asks this on every request. Empty unless
// the mirror is known good, so an unreadable table cannot be mistaken for a
// short one.
function entries() {
  return isLoaded() ? cache.slice() : [];
}

// Everything, for the management screen, which needs to show what has been
// switched off as well as what is live.
async function listAll(db) {
  const { rows } = await db.query('SELECT * FROM ip_allowlist ORDER BY is_active DESC, created_at');
  return rows.map(shape);
}

// Which entry, if any, lets this address in. Never answers from a mirror the
// module cannot vouch for.
function findMatch(clientIP) {
  return isLoaded() ? ipMatch.findMatch(clientIP, cache) : null;
}

// An empty allowlist means the gate is off. This is the difference between a
// misconfiguration being recoverable and being a locked door with the key
// inside: deleting the last entry, or deploying against a fresh database,
// leaves the app reachable rather than reachable by nobody.
function isEmpty() {
  return cache.length === 0;
}

// "Nothing is listed", as distinct from "we could not read the list". The two
// look identical from the cache and mean opposite things: the first is a gate
// nobody has configured, the second is a gate that has lost its configuration.
function isConfiguredEmpty() {
  return isLoaded() && cache.length === 0;
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
  TABLES,
  ensureTables,
  install,
  load,
  isLoaded,
  storageStatus,
  isConfiguredEmpty,
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
