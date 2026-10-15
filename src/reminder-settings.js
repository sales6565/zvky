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
  /* THE MASTER SWITCH. ON, and the two halves it governs default differently —
     see below. Off means the banner is not drawn, the indicator is not drawn, and
     no reminder of either sort is sent: one switch a studio can reach for when
     it wants the whole thing to stop. */
  enabled: true,
  /* THE BANNER AND THE INDICATOR ARE ON ON AN EXISTING INSTALL, and the email is
     off. The brief asked for that choice to be stated: the first two are screen
     furniture on a screen the person is already looking at, and a studio that
     dislikes them switches them off having seen them. An email leaves the
     building through a shared mailbox and cannot be recalled, so it arrives
     inert — the same reasoning requirePreviousDay ships inert for. */
  bannerEnabled: true,
  indicatorEnabled: true,
  inAppEnabled: true,
  emailEnabled: false,
  /* HOW LONG AFTER THE STUDIO OPENS before somebody counts as not having
     started. src/follow-up.js's GRACE_MINUTES is the default, and that module
     now reads this value: one number, one place, configurable. */
  graceMinutes: 60,
  /* THE SECOND REMINDER, as minutes past midnight IST — the frame every other
     time in this schema is stored in (work_schedule.day_start_min and the
     recording windows). 690 is 11:30. */
  secondReminderMinutes: 690,
  /* HOW LONG A DISMISSED BANNER STAYS DISMISSED. Per user, in the browser, and
     never permanent. */
  snoozeMinutes: 30,
  manualEnabled: true,
  dailyCap: 1,
  streakThreshold: 3,
};

/* 11:30, written out, so the test and the README quote the same number as the
   code. */
const SECOND_DEFAULT_LABEL = '11:30';

/* CEILINGS, so a typo cannot turn a nudge into a mailing list.
 *
 * Ten is far more than a studio would ever mean by "remind somebody again" —
 * the point of the cap is that it is small — and a streak threshold beyond the
 * look-back window in src/last-activity.js could never be reached, so a marker
 * set above it would simply never appear. The validator says so rather than
 * accepting a number that does nothing. */
const CAP_CEILING = 10;
const STREAK_CEILING = 30;
/* THE GRACE PERIOD'S RANGE. Below ten minutes the banner is the whole studio at
   nine thirty-one — which is what the grace period exists to prevent — and above
   four hours it is not a start-of-day nudge any more. */
const GRACE_MIN = 10;
const GRACE_MAX = 240;
const MINUTES_PER_DAY = 1440;
/* And the snooze. One minute is not a snooze and a day is a dismissal. */
const SNOOZE_MIN = 5;
const SNOOZE_MAX = 240;

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
  /* A COLUMN ADDED AFTER THE TABLE SHIPPED reads as its default, not as false:
     `undefined` from a database part-way through its migration must not switch
     the banner off for everybody. The same reading timesheet_settings gives
     require_previous_day. */
  const flag = (value, fallback) => (value === undefined || value === null
    ? fallback : Boolean(Number(value)));
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && value !== null && value !== undefined ? n : fallback;
  };
  cache = row ? {
    enabled: flag(row.enabled, DEFAULTS.enabled),
    bannerEnabled: flag(row.banner_enabled, DEFAULTS.bannerEnabled),
    indicatorEnabled: flag(row.indicator_enabled, DEFAULTS.indicatorEnabled),
    inAppEnabled: flag(row.in_app_enabled, DEFAULTS.inAppEnabled),
    emailEnabled: flag(row.email_enabled, DEFAULTS.emailEnabled),
    graceMinutes: num(row.grace_minutes, DEFAULTS.graceMinutes),
    secondReminderMinutes: num(row.second_reminder_minutes, DEFAULTS.secondReminderMinutes),
    snoozeMinutes: num(row.snooze_minutes, DEFAULTS.snoozeMinutes),
    manualEnabled: flag(row.manual_enabled, DEFAULTS.manualEnabled),
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
function validate(input = {}, { existing = cache, schedule = null } = {}) {
  const errors = [];
  const pick = (key) => (input[key] === undefined ? existing[key] : input[key]);

  /* Read loosely on purpose: a checkbox posts a boolean, a form post sends the
     string 'true', and either must mean the same thing. */
  const flag = (key) => {
    const raw = pick(key);
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  };
  const enabled = flag('enabled');
  const bannerEnabled = flag('bannerEnabled');
  const indicatorEnabled = flag('indicatorEnabled');
  const inAppEnabled = flag('inAppEnabled');
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
  const graceMinutes = whole('graceMinutes', 'The grace period', GRACE_MAX, GRACE_MIN);
  const snoozeMinutes = whole('snoozeMinutes', 'The banner snooze', SNOOZE_MAX, SNOOZE_MIN);

  /* THE SECOND REMINDER'S TIME, accepted as HH:MM or as minutes past midnight.
   *
   * HH:MM IS WHAT THE FORM SENDS, because <input type="time"> is the control a
   * person should get for a time of day, and minutes are what the column holds —
   * the frame work_schedule and the recording windows already use. Both are read
   * here so the API is usable either way and the column has one meaning. */
  const secondReminderMinutes = (() => {
    const raw = pick('secondReminderMinutes');
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(text);
    const n = hhmm ? Number(hhmm[1]) * 60 + Number(hhmm[2]) : Number(text);
    if (!Number.isInteger(n) || n < 0 || n >= MINUTES_PER_DAY
        || (hhmm && Number(hhmm[2]) > 59)) {
      errors.push({ field: 'secondReminderMinutes',
        message: 'The second reminder is a time of day, as HH:MM.' });
      return existing.secondReminderMinutes;
    }
    return n;
  })();

  const dailyCap = whole('dailyCap', 'The daily cap per person per kind', CAP_CEILING);
  /* TWO IS THE FLOOR, not one, and it is the floor because the marker is only
     DRAWN from two upwards — a threshold of one would mean "mark every single
     miss", which is every row on the list and therefore no marker at all. */
  const streakThreshold = whole('streakThreshold', 'The inactivity streak marker', STREAK_CEILING, 2);

  /* THE SECOND REMINDER MUST COME AFTER THE FIRST, AND INSIDE WORKING HOURS.
   *
   * Both are checked against the STUDIO'S OWN SCHEDULE, handed in rather than
   * read here so this function stays pure and the caller decides which schedule
   * it is validating against. The first reminder is "the studio opened plus the
   * grace period", so the two rules are one comparison each and neither is a
   * number written down twice.
   *
   * A studio with no recording windows at all is not refused: there is nothing
   * to be inside, and a validator that blocked the save would leave a Super
   * Admin unable to correct the schedule and the reminder in either order. */
  if (schedule && !errors.some((e) => e.field === 'secondReminderMinutes')) {
    const open = schedule.openMinute;
    const close = schedule.closeMinute;
    if (Number.isFinite(open) && Number.isFinite(close) && close > open) {
      const first = open + graceMinutes;
      if (secondReminderMinutes <= first) {
        errors.push({ field: 'secondReminderMinutes',
          message: `The second reminder must come after the first, which is ${clock(first)} `
            + `— the studio opens at ${clock(open)} and the grace period is ${graceMinutes} minutes.` });
      } else if (secondReminderMinutes >= close) {
        errors.push({ field: 'secondReminderMinutes',
          message: `The second reminder must be inside working hours, which end at ${clock(close)}.` });
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      enabled, bannerEnabled, indicatorEnabled, inAppEnabled, emailEnabled,
      graceMinutes, secondReminderMinutes, snoozeMinutes,
      manualEnabled, dailyCap, streakThreshold,
    },
  };
}

/* WHAT ACTUALLY CHANGED, as a sentence — and this exists because the full
 * summary outgrew the column.
 *
 * activity_log.summary is VARCHAR(500). With four switches the whole policy fit
 * in it; with eleven it does not, and the first thing that happened when the
 * start-of-day half landed was an audit line cut off mid-word at "inactivity
 * marker a". A test caught it.
 *
 * SO THE SUMMARY NAMES ONLY THE CLAUSES THAT MOVED, which is also the better
 * line: "grace 60 minutes → grace 90 minutes" is what somebody auditing this
 * came looking for, where eleven unchanged clauses either side of an arrow is
 * something they have to diff by eye. The WHOLE policy still goes into the
 * entry's `changes` field, which is TEXT and renders as two columns.
 */
function describeChange(before, after) {
  const was = summarise(before).split(', ');
  const now = summarise(after).split(', ');
  const moved = [];
  for (let i = 0; i < Math.max(was.length, now.length); i += 1) {
    if (was[i] !== now[i]) moved.push(`${was[i]} → ${now[i]}`);
  }
  if (!moved.length) return 'Saved the Start-of-day nudge settings with no change';
  /* Sliced to the column, with the count of what did not fit — a truncated
     sentence that says it is truncated is readable; one that stops mid-word is
     the bug this function exists for. */
  const line = `Changed the Start-of-day nudges: ${moved.join('; ')}`;
  return line.length <= 480 ? line
    : `${line.slice(0, 460)}… (${moved.length} settings changed)`;
}

/* Minutes past midnight as a wall clock. One formatter, used by the validator's
   sentences, the audit line and the API's label — so the three cannot disagree
   about what 690 means. */
function clock(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function save(db, input, userId, { schedule = null } = {}) {
  const checked = validate(input || {}, { schedule });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const v = checked.value;
  await db.query(
    `INSERT INTO reminder_settings
       (id, manual_enabled, email_enabled, daily_cap, streak_threshold,
        enabled, banner_enabled, indicator_enabled, in_app_enabled,
        grace_minutes, second_reminder_minutes, snooze_minutes, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON DUPLICATE KEY UPDATE
       manual_enabled = $1, email_enabled = $2, daily_cap = $3,
       streak_threshold = $4, enabled = $5, banner_enabled = $6,
       indicator_enabled = $7, in_app_enabled = $8, grace_minutes = $9,
       second_reminder_minutes = $10, snooze_minutes = $11, updated_by = $12`,
    [v.manualEnabled ? 1 : 0, v.emailEnabled ? 1 : 0, v.dailyCap, v.streakThreshold,
      v.enabled ? 1 : 0, v.bannerEnabled ? 1 : 0, v.indicatorEnabled ? 1 : 0,
      v.inAppEnabled ? 1 : 0, v.graceMinutes, v.secondReminderMinutes, v.snoozeMinutes,
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
  /* THE MASTER SWITCH FIRST, because it is the one change somebody will come
     looking for: with it off nothing below it does anything. */
  `nudges ${s.enabled ? 'on' : 'OFF'}`,
  `banner ${s.bannerEnabled ? 'on' : 'off'}`,
  `indicator ${s.indicatorEnabled ? 'on' : 'off'}`,
  `in-app reminders ${s.inAppEnabled ? 'on' : 'off'}`,
  `email reminders ${s.emailEnabled ? 'on' : 'off'}`,
  `grace ${s.graceMinutes} minutes`,
  `second reminder ${clock(s.secondReminderMinutes)}`,
  `banner snooze ${s.snoozeMinutes} minutes`,
  `manual reminders ${s.manualEnabled ? 'on' : 'OFF'}`,
  `at most ${s.dailyCap} per person per kind per day`,
  `inactivity marker at ${s.streakThreshold} working days`,
].join(', ');

module.exports = {
  DEFAULTS, CAP_CEILING, STREAK_CEILING, GRACE_MIN, GRACE_MAX, SNOOZE_MIN, SNOOZE_MAX,
  SECOND_DEFAULT_LABEL, MINUTES_PER_DAY,
  load, isLoaded, current, validate, save, summarise, describeChange, clock,
};
