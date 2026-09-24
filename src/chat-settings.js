/* How big a chat group may be.
 *
 * WHY THIS IS A ROW AND NOT A CONSTANT ANY MORE. It was `const
 * MAX_GROUP_MEMBERS = 30` in src/chat.js — a number chosen when the studio was
 * smaller than it is, enforced in two places, published to the browser in two
 * more, and quoted in a permission's description. Thirty is not a fact about
 * chat; it is a decision somebody made once, and the studio has since grown
 * past the point where it can be left in the source.
 *
 * NULL MEANS UNLIMITED, and it means it everywhere: the column, this module's
 * cache, the API and the maths in src/chat.js all read null the same way. The
 * alternative — a sentinel like -1 or 0 — puts a magic number back in exactly
 * the places this change is taking one out of, and every comparison would have
 * to remember it. `limit === null` is the whole of the special case.
 *
 * MIRRORED IN MEMORY, like work_schedule and branding, and for the same reason:
 * it is one studio-wide value, changed a handful of times in the life of a
 * deployment, and read on every group create, every member add and every load
 * of the chat panel. A query per read would be a query per poll.
 */

const DEFAULT_MAX_GROUP_MEMBERS = 30;

/* A ceiling, and it is about the page rather than the database.
 *
 * There is no infrastructural limit worth naming: chat_members is an ordinary
 * table and a row per person costs nothing. What does not survive is the
 * screen — the member list renders every person in one column, and the add
 * dialog holds the whole studio in a checklist. Somewhere past a few hundred
 * that stops being a list anybody can read.
 *
 * So this is not enforced as a hard maximum. It is the number the admin help
 * text names, and anything above it is accepted with the warning shown; a
 * studio that genuinely wants a thousand-person group is not going to be
 * argued out of it by a validator, and refusing would only send them to
 * Unlimited, which is larger. */
const COMFORTABLE_MAX = 500;

let cache = { maxGroupMembers: DEFAULT_MAX_GROUP_MEMBERS, updatedBy: null, updatedAt: null };
let loaded = false;

async function load(db) {
  const { rows } = await db.query(
    `SELECT c.max_group_members AS n, c.updated_by AS by_id, c.updated_at AS at, u.name AS by_name
       FROM chat_settings c
       LEFT JOIN users u ON u.id = c.updated_by
      WHERE c.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = {
    /* A row with NULL in the column is a studio that chose Unlimited. NO row at
       all is a deployment that has not migrated yet, which keeps the number the
       constant always held — the two are different answers and the difference
       is the whole reason this reads `rows[0]` before it reads the column. */
    maxGroupMembers: row ? (row.n === null || row.n === undefined ? null : Number(row.n))
      : DEFAULT_MAX_GROUP_MEMBERS,
    updatedBy: row ? row.by_id || null : null,
    updatedByName: row ? row.by_name || null : null,
    updatedAt: row ? row.at || null : null,
  };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;

/* THE ONE QUESTION EVERYTHING ASKS. Null is unlimited; a number is the cap. */
const maxGroupMembers = () => cache.maxGroupMembers;
const isUnlimited = () => cache.maxGroupMembers === null;

/* Would a group of this size be allowed? The single predicate, so no caller
   writes `>=` against a value that might be null and get `false` for a studio
   that said unlimited. */
const roomFor = (currentSize, adding = 1) => {
  const limit = cache.maxGroupMembers;
  if (limit === null) return true;
  return currentSize + adding <= limit;
};

/* How many more will fit, or null for unlimited — what the screens print. */
const remaining = (currentSize) => {
  const limit = cache.maxGroupMembers;
  if (limit === null) return null;
  return Math.max(0, limit - currentSize);
};

function current() {
  return {
    maxGroupMembers: cache.maxGroupMembers,
    unlimited: cache.maxGroupMembers === null,
    updatedBy: cache.updatedBy,
    updatedByName: cache.updatedByName || null,
    updatedAt: cache.updatedAt,
    defaults: { maxGroupMembers: DEFAULT_MAX_GROUP_MEMBERS },
    comfortableMax: COMFORTABLE_MAX,
  };
}

/* What a limit may be.
 *
 * Zero and negatives are refused, as the studio asked. They are refused with
 * the number in the message, because "invalid" leaves somebody guessing which
 * end they got wrong — and because zero in particular is a plausible thing to
 * type when what was meant was Unlimited, so the message says where that
 * actually lives. */
function validate({ unlimited, maxGroupMembers: wanted }) {
  if (unlimited) return { ok: true, value: null };
  if (wanted === null || wanted === undefined || wanted === '') {
    return { ok: false, errors: [{ field: 'maxGroupMembers', message: 'Enter a number, or tick Unlimited.' }] };
  }
  const n = Number(wanted);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, errors: [{ field: 'maxGroupMembers', message: 'A group size is a whole number of people.' }] };
  }
  if (n <= 0) {
    return {
      ok: false,
      errors: [{
        field: 'maxGroupMembers',
        message: n === 0
          ? 'Zero would mean no group could exist. Tick Unlimited if that is what you meant, or enter 1 or more.'
          : `${n} is not a number of people. Enter 1 or more, or tick Unlimited.`,
      }],
    };
  }
  return { ok: true, value: n };
}

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  await db.query(
    `INSERT INTO chat_settings (id, max_group_members, updated_by)
     VALUES (1, $1, $2)
     ON DUPLICATE KEY UPDATE max_group_members = VALUES(max_group_members),
                             updated_by = VALUES(updated_by)`,
    [checked.value, userId || null]
  );
  await load(db);
  return { ok: true, before, settings: current() };
}

// "30 people" | "unlimited" — one phrasing, for the audit trail and the screens.
const describe = (limit) => (limit === null || limit === undefined ? 'unlimited'
  : `${limit} ${limit === 1 ? 'person' : 'people'}`);

module.exports = {
  DEFAULT_MAX_GROUP_MEMBERS, COMFORTABLE_MAX,
  load, isLoaded, current, maxGroupMembers, isUnlimited, roomFor, remaining,
  validate, save, describe,
};
