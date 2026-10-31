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

/* HOW LONG A CHAT ATTACHMENT LIVES, in whole hours.
 *
 * Twelve is what the code always meant and what the help text always said; it
 * is a default here rather than a constant because the studio asked to be able
 * to change it without a deploy.
 *
 * WHOLE HOURS, AND NEVER ZERO. "Never delete" is not on offer: chat
 * attachments are not studio records, they live on a shared-hosting disk, and
 * a switch that turns a chat into an unbounded file store is one nobody would
 * be able to turn back off without deleting somebody's files. One hour is the
 * floor and thirty days the ceiling — past a month this is an archive, and an
 * archive belongs somewhere that is backed up. */
const DEFAULT_ATTACHMENT_HOURS = 12;
const MIN_ATTACHMENT_HOURS = 1;
const MAX_ATTACHMENT_HOURS = 720;

/* The two Prompt 58 switches, both ON. Neither blocks anybody: with replies off
   the Reply action is hidden and existing quotes still render, and with the
   picker off typed and pasted emoji go on working, because the switch is about
   the picker and not about emoji. */
const DEFAULT_REPLIES = true;
const DEFAULT_EMOJI_PICKER = true;

let cache = {
  maxGroupMembers: DEFAULT_MAX_GROUP_MEMBERS,
  attachmentHours: DEFAULT_ATTACHMENT_HOURS,
  repliesEnabled: DEFAULT_REPLIES,
  emojiPickerEnabled: DEFAULT_EMOJI_PICKER,
  updatedBy: null,
  updatedAt: null,
};
let loaded = false;

async function load(db) {
  /* THE WIDE READ, THEN THE NARROW ONE. A deployment whose Prompt 58 ALTERs
     have not applied — a refused ALTER is an ordinary outcome on shared
     hosting — still reads its group size rather than losing the whole mirror
     over three columns it does not have. */
  const wide = `SELECT c.max_group_members AS n, c.attachment_hours AS hours,
            c.replies_enabled AS replies, c.emoji_picker_enabled AS picker,
            c.updated_by AS by_id, c.updated_at AS at, u.name AS by_name
       FROM chat_settings c
       LEFT JOIN users u ON u.id = c.updated_by
      WHERE c.id = 1`;
  const narrow = `SELECT c.max_group_members AS n, c.updated_by AS by_id, c.updated_at AS at,
            u.name AS by_name
       FROM chat_settings c
       LEFT JOIN users u ON u.id = c.updated_by
      WHERE c.id = 1`;
  let rows = [];
  try {
    ({ rows } = await db.query(wide));
  } catch (err) {
    if (err && err.code !== 'ER_BAD_FIELD_ERROR') rows = [];
    else ({ rows } = await db.query(narrow).catch(() => ({ rows: [] })));
  }
  const row = rows[0];
  const bool = (value, fallback) => (value === null || value === undefined
    ? fallback : Boolean(Number(value)));
  const hours = row && row.hours !== null && row.hours !== undefined
    ? Number(row.hours) : DEFAULT_ATTACHMENT_HOURS;
  cache = {
    /* CLAMPED ON THE WAY OUT AS WELL AS IN. A value outside the bounds can only
       come from a hand-edited row, and a retention of nought hours read from
       one would delete every attachment the moment it was uploaded. */
    attachmentHours: Number.isInteger(hours) && hours >= MIN_ATTACHMENT_HOURS
      && hours <= MAX_ATTACHMENT_HOURS ? hours : DEFAULT_ATTACHMENT_HOURS,
    repliesEnabled: row ? bool(row.replies, DEFAULT_REPLIES) : DEFAULT_REPLIES,
    emojiPickerEnabled: row ? bool(row.picker, DEFAULT_EMOJI_PICKER) : DEFAULT_EMOJI_PICKER,
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

/* THE ONE QUESTION src/chat-files.js ASKS, every time it needs the retention —
   never captured, because the setting can change while the process runs. */
const attachmentRetentionHours = () => cache.attachmentHours;
const repliesEnabled = () => cache.repliesEnabled;
const emojiPickerEnabled = () => cache.emojiPickerEnabled;

/* WHAT A RETENTION MAY BE, as its own validator so the message says which end
 * was wrong. Whole hours only: a retention of 1.5 would have to be stored as
 * minutes somewhere, and "hours" that are sometimes minutes is the family of
 * bug this whole prompt is about. */
function validateRetention(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { ok: false, errors: [{ field: 'attachmentHours',
      message: `Enter a number of hours between ${MIN_ATTACHMENT_HOURS} and ${MAX_ATTACHMENT_HOURS}.` }] };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { ok: false, errors: [{ field: 'attachmentHours',
      message: 'A retention is a number of hours.' }] };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, errors: [{ field: 'attachmentHours',
      message: 'Whole hours only — 12, not 12.5.' }] };
  }
  if (n < MIN_ATTACHMENT_HOURS) {
    return { ok: false, errors: [{ field: 'attachmentHours',
      message: n <= 0
        ? 'Nought would delete every file the moment it was sent, and "never delete" is not on '
          + `offer. The shortest retention is ${MIN_ATTACHMENT_HOURS} hour.`
        : `The shortest retention is ${MIN_ATTACHMENT_HOURS} hour.` }] };
  }
  if (n > MAX_ATTACHMENT_HOURS) {
    return { ok: false, errors: [{ field: 'attachmentHours',
      message: `The longest retention is ${MAX_ATTACHMENT_HOURS} hours (30 days). Past a month this `
        + 'is an archive, and an archive belongs somewhere that is backed up.' }] };
  }
  return { ok: true, value: n };
}

/* Save the retention and the two switches. Separate from save() above because
   it is a different screen, a different permission and a different audit line —
   folding them together would mean a Super Admin who may change the group size
   could change the retention by posting one more field. */
async function saveAttachmentPolicy(db, input, userId) {
  const checked = validateRetention(input.attachmentHours);
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const bit = (value, fallback) => (value === undefined ? (fallback ? 1 : 0)
    : (value === true || value === 'true' || value === 1 || value === '1' ? 1 : 0));
  await db.query(
    `INSERT INTO chat_settings (id, attachment_hours, replies_enabled, emoji_picker_enabled, updated_by)
     VALUES (1, $1, $2, $3, $4)
     ON DUPLICATE KEY UPDATE attachment_hours = VALUES(attachment_hours),
                             replies_enabled = VALUES(replies_enabled),
                             emoji_picker_enabled = VALUES(emoji_picker_enabled),
                             updated_by = VALUES(updated_by)`,
    [checked.value, bit(input.repliesEnabled, cache.repliesEnabled),
      bit(input.emojiPickerEnabled, cache.emojiPickerEnabled), userId || null]
  );
  await load(db);
  return { ok: true, before, settings: current() };
}

/* One line a person reads, for the audit trail — the same job
   timesheet-settings' summarise() does, and the same reason. */
const describeAttachmentPolicy = (s) => [
  `attachments kept ${s.attachmentHours} hour${s.attachmentHours === 1 ? '' : 's'}`,
  `replies ${s.repliesEnabled ? 'on' : 'off'}`,
  `emoji picker ${s.emojiPickerEnabled ? 'on' : 'off'}`,
].join('; ');
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
    attachmentHours: cache.attachmentHours,
    repliesEnabled: cache.repliesEnabled,
    emojiPickerEnabled: cache.emojiPickerEnabled,
    attachmentHoursBounds: { min: MIN_ATTACHMENT_HOURS, max: MAX_ATTACHMENT_HOURS },
    updatedBy: cache.updatedBy,
    updatedByName: cache.updatedByName || null,
    updatedAt: cache.updatedAt,
    defaults: {
      maxGroupMembers: DEFAULT_MAX_GROUP_MEMBERS,
      attachmentHours: DEFAULT_ATTACHMENT_HOURS,
      repliesEnabled: DEFAULT_REPLIES,
      emojiPickerEnabled: DEFAULT_EMOJI_PICKER,
    },
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
  DEFAULT_ATTACHMENT_HOURS, MIN_ATTACHMENT_HOURS, MAX_ATTACHMENT_HOURS,
  DEFAULT_REPLIES, DEFAULT_EMOJI_PICKER,
  load, isLoaded, current, maxGroupMembers, isUnlimited, roomFor, remaining,
  validate, save, describe,
  attachmentRetentionHours, repliesEnabled, emojiPickerEnabled,
  validateRetention, saveAttachmentPolicy, describeAttachmentPolicy,
};
