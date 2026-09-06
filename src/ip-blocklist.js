// The IP blocklist: addresses that are refused whatever else says otherwise.
//
// WHY THIS EXISTS ALONGSIDE THE ALLOWLIST. An allowlist answers "who may come
// in"; a blocklist answers "this one may not". Those overlap but are not the
// same question, and the case that needs both is a single address INSIDE an
// allowed range — a compromised laptop on the office network, someone whose
// access ended on Friday. Restructuring the ranges to carve one address out is
// a bigger, riskier edit than naming it here.
//
// SO IT BEATS THE ALLOWLIST, AND NOTHING ELSE. See src/middleware/ip-allowlist.js
// for where it sits in the order. Two halves of that matter:
//
//   It runs BEFORE the allowlist, so an address on both is refused. That is the
//   whole point of the feature.
//
//   It runs AFTER loopback, the bypass token and the emergency addresses. Those
//   are the ways back in when something here is wrong, and a blocklist that
//   could override them would make a mistake unrecoverable without editing the
//   database by hand. A safeguard you can lock yourself out of is not one.
//
// IT DENIES IN MONITOR MODE TOO, which is the one place this deliberately does
// not follow the allowlist. Monitor mode means "I have not finished deciding
// who is allowed" — it exists so an unfinished allowlist cannot lock out a
// studio. A blocklist entry is the opposite: somebody named one address and
// said keep it out. Honouring that only in enforce mode would mean blocking a
// compromised device on a monitor-mode deployment does nothing at all, which is
// worse than not having the feature, because it looks like it worked.
//
// EXPIRY IS EVALUATED ON READ, never by a sweep. A block that has run out stops
// biting the moment it runs out, on a process that has not been restarted and
// with nothing scheduled to notice. The row stays, so the history of who was
// blocked and when does not evaporate.

const { v4: uuid } = require('uuid');
const ipMatch = require('./ip-match');
const { applyTableOptions } = require('./db-collation');

/* Its own table, not a column on ip_allowlist. The two lists have different
   lifetimes, different permissions and different meanings, and a shared table
   with an `is_block` flag would make every existing allowlist query a query
   that has to remember to filter. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS ip_blocklist (
      id CHAR(36) NOT NULL PRIMARY KEY,
      address VARCHAR(64) NOT NULL,
      label VARCHAR(120) NULL,
      reason VARCHAR(255) NULL,
      expires_at DATETIME NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by_id CHAR(36) NULL,
      created_by_email VARCHAR(191) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ip_blocklist_address (address),
      KEY idx_ip_blocklist_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let cache = [];

/* Whether this feature's storage can be read, tracked for the same reason the
 * allowlist tracks its own: "we could not look" and "there is nothing there"
 * are opposite facts that look identical from an empty array.
 *
 * The consequence is REVERSED here, and that is worth stating. An unreadable
 * allowlist means the gate cannot tell who is permitted, so it opens. An
 * unreadable blocklist means it cannot tell who is barred — and the safe
 * failure for a blocklist is also to let traffic through, because the
 * alternative is refusing everybody on the strength of a list nobody can see.
 * So a broken blocklist blocks nothing, loudly.
 */
let storage = { state: 'not-loaded', detail: null, code: null };

function storageStatus() {
  return { ...storage, ok: storage.state === 'ready' };
}

function isLoaded() {
  return storage.state === 'ready';
}

async function ensureTables(db) {
  for (const sql of TABLES) await db.query(await applyTableOptions(db, sql));
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
      `[ip-blocklist] NOT BLOCKING: ${storage.state === 'missing-tables'
        ? 'the ip_blocklist table does not exist'
        : 'the ip_blocklist table could not be read'} ` +
      `(${storage.code || 'error'}: ${storage.detail}). ` +
      'Blocked addresses can currently reach this app. ' +
      'Repair it on Settings -> Blocked IP Addresses.'
    );
  }
}

async function load(db) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ip_blocklist WHERE is_active = 1 ORDER BY created_at'
    );
    cache = rows.map(shape);
    storage = { state: 'ready', detail: null, code: null };
    return true;
  } catch (err) {
    // Emptied rather than left stale: a mirror that cannot be verified must not
    // be the thing refusing somebody.
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

function shape(row) {
  return {
    id: row.id,
    address: row.address,
    label: row.label || '',
    reason: row.reason || '',
    expiresAt: row.expires_at || null,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by_email || null,
    createdAt: row.created_at,
  };
}

// Has this entry run out? A row with no expiry never has.
function isExpired(entry, now = Date.now()) {
  if (!entry || !entry.expiresAt) return false;
  const at = new Date(entry.expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/* The entries actually in force: active, and not expired as of this instant.
   The gate asks this on every request, which is why expiry is a comparison here
   rather than a scheduled job somewhere else. */
function entries(now = Date.now()) {
  return isLoaded() ? cache.filter((e) => !isExpired(e, now)) : [];
}

/* Which entry, if any, bars this address.
 *
 * Never answers from a mirror this module cannot vouch for: an unreadable table
 * refuses nobody. Returning the entry rather than a boolean so the gate can log
 * WHICH rule did it, which is the first thing anybody asks. */
function findMatch(clientIP, now = Date.now()) {
  // ipMatch.findMatch hands back the entry it matched, not a boolean, so the
  // gate gets the rule and the reason without a second pass.
  return isLoaded() ? ipMatch.findMatch(clientIP, entries(now)) : null;
}

async function listAll(db) {
  const { rows } = await db.query('SELECT * FROM ip_blocklist ORDER BY is_active DESC, created_at DESC');
  const now = Date.now();
  return rows.map(shape).map((e) => ({ ...e, expired: isExpired(e, now) }));
}

// --- writing -----------------------------------------------------------------

function validate(address, { label, reason, expiresAt, existingId = null } = {}) {
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

  const canonical = text && ipMatch.isValidEntry(text) ? ipMatch.normaliseEntry(text) : null;
  if (canonical) {
    const clash = cache.find((e) => e.id !== existingId && ipMatch.normaliseEntry(e.address) === canonical);
    if (clash) errors.push({ field: 'address', message: `${canonical} is already blocked.` });
  }

  if (String(label ?? '').length > 120) {
    errors.push({ field: 'label', message: 'The note must be 120 characters or fewer.' });
  }
  if (String(reason ?? '').length > 255) {
    errors.push({ field: 'reason', message: 'The reason must be 255 characters or fewer.' });
  }

  /* An expiry in the past would be a block that never blocks — accepted
     silently it looks like the address is barred when it is not, which is the
     failure this whole feature is meant to avoid. */
  let expiry = null;
  if (expiresAt !== undefined && expiresAt !== null && String(expiresAt).trim() !== '') {
    const at = new Date(expiresAt);
    if (!Number.isFinite(at.getTime())) {
      errors.push({ field: 'expiresAt', message: 'That expiry is not a date and time.' });
    } else if (at.getTime() <= Date.now()) {
      errors.push({ field: 'expiresAt', message: 'That expiry has already passed, so the block would never take effect.' });
    } else {
      expiry = at;
    }
  }

  return { errors, canonical, expiry };
}

async function create(db, { address, label, reason, expiresAt }, { actor, actorIp }) {
  const { errors, canonical, expiry } = validate(address, { label, reason, expiresAt });
  if (errors.length) return { ok: false, status: 400, errors };

  const id = uuid();
  await db.query(
    `INSERT INTO ip_blocklist (id, address, label, reason, expires_at, is_active, created_by_id, created_by_email)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
    [
      id, canonical,
      String(label ?? '').trim() || null,
      String(reason ?? '').trim() || null,
      /* The Date itself, not a formatted string. mysql2 serialises a Date using
         the connection's timezone and reads a DATETIME back the same way, so it
         round-trips; a UTC-shaped string written by hand comes back shifted by
         the server's offset, which on an IST host means a one-hour block reads
         as already expired and silently never blocks anybody. Same reason
         src/chat-files.js passes expiryFor() as a Date. */
      expiry || null,
      actor ? actor.id : null, actor ? actor.email : null,
    ]
  );
  console.log(
    `[ip-blocklist] blocked ${canonical}${actor ? ` by ${actor.email}` : ''}${actorIp ? ` from ${actorIp}` : ''}`
    + `${expiry ? ` until ${expiry.toISOString()}` : ''}${reason ? ` — ${reason}` : ''}`
  );
  await load(db);
  return { ok: true, status: 201, entry: cache.find((e) => e.id === id) || null };
}

async function remove(db, id, { actor, actorIp }) {
  const { rows } = await db.query('SELECT * FROM ip_blocklist WHERE id = $1', [id]);
  if (!rows.length) return { ok: false, status: 404, errors: [{ message: 'That block does not exist.' }] };
  const target = shape(rows[0]);

  /* Deleted, not deactivated. The allowlist keeps deactivated rows because a
     removed entry there is often re-added — you take an office off the list for
     a week. An unblocked address is a decision that it is fine now, and leaving
     a switched-off block on the screen invites somebody to switch it back on
     without knowing why it was lifted. The Activity Log holds the history. */
  await db.query('DELETE FROM ip_blocklist WHERE id = $1', [id]);
  console.log(
    `[ip-blocklist] unblocked ${target.address}${actor ? ` by ${actor.email}` : ''}${actorIp ? ` from ${actorIp}` : ''}`
  );
  await load(db);
  return { ok: true, status: 200, removed: target };
}

module.exports = {
  TABLES,
  ensureTables,
  install,
  load,
  isLoaded,
  storageStatus,
  entries,
  listAll,
  findMatch,
  isExpired,
  validate,
  create,
  remove,
};
