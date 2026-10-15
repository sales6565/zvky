/* SETTINGS -> START-OF-DAY NUDGES. The three numbers that govern reminders.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS HERE BEFORE: NOTHING. Stated first, because the brief for this
 * change asked for settings to be ADDED to an existing "Start-of-day nudges"
 * section, and there is no such section — nor any automatic reminder, anywhere
 * in this application. `grep -ri nudge src/` finds three comments about a
 * clock being "nudged backwards" and nothing else.
 *
 * So this file is the section, created rather than extended, and it is the
 * stub the report names. It holds exactly the four switches the manual
 * reminders need and NOT ONE MORE: no schedule, no sweep, no "send at 10:30",
 * because inventing the automatic half from a sentence in a brief would be
 * inventing a studio policy nobody has stated. When the automatic nudge is
 * built it adds its own rows here and writes to the same reminder_log with
 * source = 'auto' (see src/reminders.js), which is why that column exists
 * already.
 *
 * ---------------------------------------------------------------------------
 * WHY EMAIL DEFAULTS OFF while manual reminders default on.
 *
 * An in-app notice reaches somebody inside the tool they are already in. An
 * email leaves the building through a shared sales mailbox (see the README on
 * the Gmail transport) and cannot be recalled. Switching a new outbound email
 * on by default, for a studio that has not yet decided it wants its staff
 * mailed about attendance, is the kind of default nobody forgives — the same
 * reasoning timesheet_settings.requirePreviousDay arrives inert for.
 *
 * The in-app half therefore works the moment this ships, and the email half is
 * one checkbox away. The brief named a default for the other three and was
 * silent on this one; this is the decision and it is reported.
 *
 * ---------------------------------------------------------------------------
 * MIRRORED IN MEMORY, like timesheet_settings, chat_settings and work_schedule:
 * one studio-wide row, changed a handful of times in the life of a deployment,
 * and read on every draw of the follow-up section and every reminder sent. The
 * mirror is what makes a change take effect without a redeploy — load() runs at
 * boot and again on every save, so the next request sees the new value.
 */

/* Today's behaviour, in so far as there was any. Manual reminders on, because
   a feature that ships switched off is one nobody finds; email off, for the
   reason above; one reminder per person per kind per day, which is what the
   brief asked for and what the unique key enforces; and a streak marker at
   three working days. */
const DEFAULTS = {
  manualEnabled: true,
  emailEnabled: false,
  dailyCap: 1,
  streakThreshold: 3,
};

/* CEILINGS, so a typo cannot turn a nudge into a mailing list.
 *
 * Ten is far more than a studio would ever mean by "remind somebody again" —
 * the point of the cap is that it is small — and a streak threshold beyond the
 * look-back window in src/last-activity.js could never be reached, so a marker
 * set above it would simply never appear. The validator says so rather than
 * accepting a number that does nothing. */
const CAP_CEILING = 10;
const STREAK_CEILING = 30;

let cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;

async function load(db) {
  const { rows } = await db.query(
    `SELECT r.*, u.\`name\` AS updated_by_name
       FROM reminder_settings r
       LEFT JOIN users u ON u.id = r.updated_by
      WHERE r.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  /* NO ROW is a deployment that has not migrated, and it keeps the defaults
     above — which is the same reading timesheet-settings gives, for the same
     reason: a server must boot and behave sanely before anybody has visited
     Settings. */
  cache = row ? {
    manualEnabled: Boolean(Number(row.manual_enabled)),
    emailEnabled: Boolean(Number(row.email_enabled)),
    dailyCap: Number(row.daily_cap) || DEFAULTS.dailyCap,
    streakThreshold: Number(row.streak_threshold) || DEFAULTS.streakThreshold,
    updatedBy: row.updated_by || null,
    updatedByName: row.updated_by_name || null,
    updatedAt: row.updated_at || null,
  } : { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;
const current = () => ({ ...cache });

/* VALIDATION IS THE SERVER'S, and the page's number inputs are a convenience.
 *
 * Returns every error rather than the first, because the section saves four
 * fields at once and a form that corrects one mistake per round trip is a form
 * people give up on. An ABSENT field means "leave it as it was", which is what
 * makes a partial save safe. */
function validate(input = {}, { existing = cache } = {}) {
  const errors = [];
  const pick = (key) => (input[key] === undefined ? existing[key] : input[key]);

  /* Read loosely on purpose: a checkbox posts a boolean, a form post sends the
     string 'true', and either must mean the same thing. */
  const flag = (key) => {
    const raw = pick(key);
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  };
  const manualEnabled = flag('manualEnabled');
  const emailEnabled = flag('emailEnabled');

  const whole = (key, label, ceiling, floor = 1) => {
    const raw = pick(key);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < floor || n > ceiling) {
      errors.push({
        field: key,
        message: `${label} is a whole number between ${floor} and ${ceiling}.`,
      });
      return existing[key];
    }
    return n;
  };
  const dailyCap = whole('dailyCap', 'The daily cap per person per kind', CAP_CEILING);
  /* TWO IS THE FLOOR, not one, and it is the floor because the marker is only
     DRAWN from two upwards — a threshold of one would mean "mark every single
     miss", which is every row on the list and therefore no marker at all. */
  const streakThreshold = whole('streakThreshold', 'The inactivity streak marker', STREAK_CEILING, 2);

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value: { manualEnabled, emailEnabled, dailyCap, streakThreshold } };
}

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const v = checked.value;
  await db.query(
    `INSERT INTO reminder_settings
       (id, manual_enabled, email_enabled, daily_cap, streak_threshold, updated_by)
     VALUES (1, $1, $2, $3, $4, $5)
     ON DUPLICATE KEY UPDATE
       manual_enabled = $1, email_enabled = $2, daily_cap = $3,
       streak_threshold = $4, updated_by = $5`,
    [v.manualEnabled ? 1 : 0, v.emailEnabled ? 1 : 0, v.dailyCap, v.streakThreshold,
      userId || null]
  );
  /* THE MIRROR, RELOADED HERE. This is the whole of "no redeploy needed": the
     next reminder sent and the next draw of the section read the new row
     because this line put it in the cache they read. */
  await load(db);
  return { ok: true, before, settings: current() };
}

/* One line a person reads, for the audit trail — the same job
   timesheet-settings.summarise does, and named the same way so the Activity Log
   renders the two alike. */
const summarise = (s) => [
  `manual reminders ${s.manualEnabled ? 'on' : 'OFF'}`,
  `email reminders ${s.emailEnabled ? 'on' : 'off'}`,
  `at most ${s.dailyCap} per person per kind per day`,
  `inactivity marker at ${s.streakThreshold} working days`,
].join(', ');

module.exports = {
  DEFAULTS, CAP_CEILING, STREAK_CEILING,
  load, isLoaded, current, validate, save, summarise,
};
