/* Which addresses the Dev & QA integration may reach this application from.
 *
 * A SECOND LIST, DELIBERATELY SEPARATE from src/ip-allowlist.js. That one
 * answers "who may reach the studio's own app" and is maintained by whoever
 * runs the studio; this one answers "which machine is the integration", and the
 * two have different answers, different owners and different consequences when
 * wrong. Merging them would mean adding a build server to the list that governs
 * whether the studio's people can sign in.
 *
 * ITS ARCHITECTURE IS COPIED RATHER THAN INVENTED, and every piece of that copy
 * is load-bearing:
 *
 *   the tables live HERE, not in migrate.js   so that whoever needs them can
 *                                             create them — startup, and a
 *                                             management screen that finds them
 *                                             missing. Both are IF NOT EXISTS.
 *   an in-memory mirror                       the gate runs on every integration
 *                                             request and cannot afford a query
 *                                             each time. Loaded at startup,
 *                                             reloaded on every write.
 *   four readiness states, not a boolean      "we could not look" must never be
 *                                             read as "there is nothing there".
 *                                             That distinction is the whole
 *                                             reason the original tracks a state.
 *   the escape hatches live in the MIDDLEWARE not here, and read the environment
 *                                             rather than this table. A
 *                                             safeguard that can be edited
 *                                             through the thing it safeguards is
 *                                             not a safeguard.
 */

const { v4: uuid } = require('uuid');
const ipMatch = require('./ip-match');
const { applyTableOptions } = require('./db-collation');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS integration_ip_allowlist (
      id CHAR(36) NOT NULL PRIMARY KEY,
      address VARCHAR(64) NOT NULL,
      label VARCHAR(120) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by_id CHAR(36) NULL,
      created_by_email VARCHAR(191) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_integration_ip_address (address),
      KEY idx_integration_ip_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS integration_ip_allowlist_audit (
      id CHAR(36) NOT NULL PRIMARY KEY,
      action VARCHAR(24) NOT NULL,
      address VARCHAR(64) NULL,
      label VARCHAR(120) NULL,
      actor_id CHAR(36) NULL,
      actor_email VARCHAR(191) NULL,
      actor_ip VARCHAR(64) NULL,
      detail VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_integration_ip_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let cache = [];

/*   ready          the tables are there and the mirror reflects them
 *   missing-tables they do not exist — the migration did not run, or could not
 *   unavailable    they exist but could not be read (permissions, connection)
 *   not-loaded     nothing has tried yet
 */
let storage = { state: 'not-loaded', detail: null, code: null };

const storageStatus = () => ({ ...storage, ok: storage.state === 'ready' });

// True only when the list is a faithful copy of the table.
const isLoaded = () => storage.state === 'ready';

async function ensureTables(db) {
  for (const sql of TABLES) await db.query(await applyTableOptions(db, sql));
}

/* Catching up with a change this process did not make.
 *
 * Every worker keeps its own copy of this list, because the gate runs on every
 * request and cannot wait on a query. Writes refresh the copy belonging to the
 * worker that handled them — and do nothing for any other worker, which would
 * otherwise carry a stale list until it was restarted. That means the answer to
 * "is this address allowed" depends on which worker took the request: a newly
 * added office is let in intermittently, and, worse, a REVOKED one keeps working.
 *
 * The same shape as referenceData.refreshIfChanged, deliberately — this codebase
 * already had this exact problem with roles and already answered it. The reload is
 * unconditional and cheap (one indexed read of a table with a handful of rows);
 * the comparison only decides whether it is worth saying anything.
 */
async function refreshIfChanged(db) {
  const signature = () => cache.map((e) => `${e.id}:${e.address}`).join('|');
  const before = signature();
  const ok = await load(db);
  return { ok, changed: ok && before !== signature() };
}

function fault(err) {
  const was = storage.state;
  storage = {
    state: err.code === 'ER_NO_SUCH_TABLE' ? 'missing-tables' : 'unavailable',
    detail: err.sqlMessage || err.message,
    code: err.code || null,
  };
  if (was !== storage.state) {
    console.error(
      `[integration-ip] NOT RESTRICTING: ${storage.state === 'missing-tables'
        ? 'the integration_ip_allowlist tables do not exist'
        : 'the integration_ip_allowlist tables could not be read'} `
      + `(${storage.code || 'error'}: ${storage.detail}). `
      + 'Integration traffic is not being restricted by address.'
    );
  }
}

/* Read the table into the mirror. A failure is recorded rather than thrown:
   every caller is startup or a write, and neither should die because the
   feature is not installed. */
async function load(db) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM integration_ip_allowlist WHERE is_active = 1 ORDER BY created_at'
    );
    cache = rows.map(shape);
    storage = { state: 'ready', detail: null, code: null };
    return true;
  } catch (err) {
    /* Emptied rather than left stale: whatever is in here would be acted on by
       the gate, and acting on a copy that can no longer be verified is worse
       than admitting the list cannot be seen. */
    cache = [];
    fault(err);
    return false;
  }
}

async function install(db) {
  try {
    await ensureTables(db);
  } catch (err) {
    cache = [];
    fault(err);
    return { ok: false, ...storageStatus() };
  }
  const ok = await load(db);
  return { ok, ...storageStatus() };
}

const shape = (row) => ({
  id: row.id,
  address: row.address,
  label: row.label || '',
  isActive: Boolean(row.is_active),
  createdBy: row.created_by_email || null,
  createdAt: row.created_at,
});

// Active entries only. Empty unless the mirror is known good, so an unreadable
// table cannot be mistaken for a short one.
const entries = () => (isLoaded() ? cache.slice() : []);
const isEmpty = () => entries().length === 0;

// Everything, for a management screen that has to show what is switched off.
async function listAll(db) {
  const { rows } = await db.query(
    'SELECT * FROM integration_ip_allowlist ORDER BY is_active DESC, created_at');
  return rows.map(shape);
}

// Never answers from a mirror this module cannot vouch for.
const findMatch = (clientIP) => (isLoaded() ? ipMatch.findMatch(clientIP, cache) : null);

/* Writes reload the mirror before returning, so the next request judges against
   what was just saved rather than what was there a moment ago. */
async function add(db, { address, label = null, actor = null }) {
  const clean = String(address || '').trim();
  if (!clean) return { ok: false, error: 'Give an address or range.' };
  if (!ipMatch.isValidEntry(clean)) return { ok: false, error: `"${clean}" is not an address or CIDR range.` };
  const id = uuid();
  await db.query(
    `INSERT INTO integration_ip_allowlist (id, address, label, created_by_id, created_by_email)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, clean, label || null, actor ? actor.id : null, actor ? actor.email : null]
  );
  await audit(db, { action: 'add', address: clean, label, actor });
  await load(db);
  return { ok: true, id };
}

async function remove(db, id, { actor = null } = {}) {
  const { rows } = await db.query('SELECT * FROM integration_ip_allowlist WHERE id = $1', [id]);
  if (!rows.length) return { ok: false, error: 'No such entry.' };
  await db.query('DELETE FROM integration_ip_allowlist WHERE id = $1', [id]);
  await audit(db, { action: 'remove', address: rows[0].address, label: rows[0].label, actor });
  await load(db);
  return { ok: true };
}

async function setActive(db, id, isActive, { actor = null } = {}) {
  const { rows } = await db.query('SELECT * FROM integration_ip_allowlist WHERE id = $1', [id]);
  if (!rows.length) return { ok: false, error: 'No such entry.' };
  await db.query('UPDATE integration_ip_allowlist SET is_active = $1 WHERE id = $2',
    [isActive ? 1 : 0, id]);
  await audit(db, {
    action: isActive ? 'enable' : 'disable', address: rows[0].address, label: rows[0].label, actor });
  await load(db);
  return { ok: true };
}

// Never throws: an audit row that cannot be written must not undo the change it
// was recording.
async function audit(db, { action, address, label, actor, detail = null }) {
  await db.query(
    `INSERT INTO integration_ip_allowlist_audit
       (id, action, address, label, actor_id, actor_email, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuid(), action, address || null, label || null,
      actor ? actor.id : null, actor ? actor.email : null, detail]
  ).catch((err) => console.warn(`[integration-ip] audit write failed: ${err.sqlMessage || err.message}`));
}

module.exports = {
  TABLES, install, load, refreshIfChanged, entries, isEmpty, isLoaded, storageStatus,
  findMatch, listAll, add, remove, setActive,
};
