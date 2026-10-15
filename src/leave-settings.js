/* SETTINGS -> LEAVE. The master switch and the half-day split.
 *
 * ===========================================================================
 * WHY THIS SWITCH SHIPS OFF WHEN THE NUDGES SWITCH SHIPS ON.
 *
 * src/reminder-settings.js argues that a feature shipping switched off is one
 * nobody finds, and that is right for a screen that draws a banner. It is the
 * wrong default here, and the difference is what the switch governs: marking
 * somebody on leave CHANGES WHAT THEIR HOURS ADD UP TO. A studio that upgrades
 * on a Tuesday and finds a Leave button beside every name has been handed a
 * control that can silently remove an afternoon from a person's recorded day,
 * before anybody has decided what the studio's half-day even is. So it arrives
 * inert, exactly as timesheet_settings.requirePreviousDay does, and an admin
 * turns it on having seen it.
 *
 * ===========================================================================
 * WHAT "OFF" DOES AND DOES NOT MEAN, because this is the part that is easy to
 * get wrong and expensive to get wrong.
 *
 * OFF STOPS NEW MARKS. No buttons, no POST (409 feature_disabled), no new idle
 * rows.
 *
 * OFF DOES NOT UNDO EXISTING ONES. A row that is already there keeps its full
 * effect: the time exclusion, the timesheet rule, the nudge rules, the block on
 * starting a timer. The alternative — "off means ignore the rows" — would mean
 * that flipping a switch changed a past month's totals, twice, in opposite
 * directions. A setting that rewrites history is not a setting. So the switch
 * is read at the point a row would be CREATED and nowhere else, and
 * src/day-status.js never asks it when reading.
 *
 * The one thing that still runs with the switch off is the idle AUTO-CLEAR,
 * because an idle row that cannot clear itself is a row that is stuck.
 *
 * ===========================================================================
 * THE SPLIT IS NULL UNTIL SOMEBODY SAVES IT, and that is a real state rather
 * than a missing value. NULL means "prefill from the studio's lunch break and
 * show the admin what they are about to agree to"; a number means an admin has
 * agreed to it. Without the distinction, "the lunch break moved" and "the admin
 * chose 12:30" are indistinguishable, and the Reset link has nothing to reset
 * to.
 *
 * MIRRORED IN MEMORY like every other settings row in this application
 * (work_schedule, timesheet_settings, chat_settings, reminder_settings): one
 * studio-wide row, changed a handful of times in the life of a deployment, read
 * on every draw of the follow-up section and every timer start. load() runs at
 * boot and again on every save, so a change takes effect with no redeploy.
 */

const workSchedule = require('./work-schedule');

const MINUTES_PER_DAY = 24 * 60;

/* The day's two ends, as the whole-calendar-date bounds a Full Day covers and
   the open ends of the two halves. A half-day window is deliberately WIDE —
   first half is midnight to the split, not "the studio's opening to the split"
   — because time outside working hours is already excluded by the working-time
   helper, and narrowing it here would be a second, weaker copy of that rule. */
const DAY_START = 0;
const DAY_END = MINUTES_PER_DAY;

const DEFAULTS = {
  enabled: false,
  firstHalfEndMinutes: null,
  secondHalfStartMinutes: null,
};

let cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;

async function load(db) {
  const { rows } = await db.query(
    `SELECT l.*, u.\`name\` AS updated_by_name
       FROM leave_settings l
       LEFT JOIN users u ON u.id = l.updated_by
      WHERE l.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  const num = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  cache = row ? {
    /* A column added after the table shipped reads as its default rather than
       as false — the same reading reminder-settings gives. Here the default IS
       false, so the distinction only matters if this switch ever defaults on. */
    enabled: row.enabled === undefined || row.enabled === null
      ? DEFAULTS.enabled : Boolean(Number(row.enabled)),
    firstHalfEndMinutes: num(row.first_half_end_minutes),
    secondHalfStartMinutes: num(row.second_half_start_minutes),
    updatedBy: row.updated_by || null,
    updatedByName: row.updated_by_name || null,
    updatedAt: row.updated_at || null,
  } : { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;
const current = () => ({ ...cache });

/* THE ONE QUESTION EVERY CALLER ASKS, and it is a function rather than a
   property so that nothing can capture it at require time and go on answering
   the value it had at boot. */
const leaveIdleEnabled = () => Boolean(cache.enabled);

/* ---------------------------------------------------------------------------
 * THE PREFILL.
 *
 * FIRST CHOICE: the studio's lunch break. src/work-schedule.js's breakWindows()
 * is the single place this application knows when the studio is not working,
 * and the break named `lunch` is the one a half-day splits around — the
 * fifteen-minute tea breaks are not a split point and the morning one is not
 * the middle of anything. Seeded at 13:00-14:00, which is what the brief
 * expected to see.
 *
 * SECOND CHOICE: the midpoint of the working day, used for both ends, so a
 * studio with no lunch break at all still gets a sensible, legal pair rather
 * than an empty form.
 *
 * Returns the two numbers AND where they came from, because the Settings screen
 * says so and the Reset link needs to know what it would restore.
 */
function prefill({ schedule = workSchedule.current(), breaks = null } = {}) {
  const windows = breaks || workSchedule.breakWindows(schedule);
  const lunch = windows.find((w) => w.key === 'lunch');
  if (lunch && Number.isFinite(lunch.start) && Number.isFinite(lunch.end)) {
    return { firstHalfEndMinutes: lunch.start, secondHalfStartMinutes: lunch.end, from: 'lunch' };
  }
  const open = Number(schedule.dayStart);
  const close = Number(schedule.dayEnd);
  if (Number.isFinite(open) && Number.isFinite(close) && close > open) {
    const mid = Math.round((open + close) / 2);
    return { firstHalfEndMinutes: mid, secondHalfStartMinutes: mid, from: 'midpoint' };
  }
  /* A schedule with no working day at all. Noon, so the form is still legal and
     the admin is not shown an error about a field they have not touched. */
  return { firstHalfEndMinutes: 12 * 60, secondHalfStartMinutes: 12 * 60, from: 'noon' };
}

/* THE SPLIT IN FORCE: the saved values, or the prefill while nothing is saved.
   Every reader of "where does the day divide" comes through here, so the screen
   that shows the times and the row that snapshots them cannot differ. */
function split({ settings = cache, schedule = workSchedule.current() } = {}) {
  const saved = Number.isFinite(settings.firstHalfEndMinutes)
    && Number.isFinite(settings.secondHalfStartMinutes);
  if (saved) {
    return {
      firstHalfEndMinutes: settings.firstHalfEndMinutes,
      secondHalfStartMinutes: settings.secondHalfStartMinutes,
      from: 'saved',
    };
  }
  return prefill({ schedule });
}

/* THE WINDOW A PORTION COVERS, in minutes past midnight, from a given split.
 * The single definition — the snapshot written on a row and the times shown in
 * the Leave menu are both this function, so a menu that says "until 13:00"
 * cannot produce a row that means something else. */
function windowFor(portion, { firstHalfEndMinutes, secondHalfStartMinutes }) {
  if (portion === 'first_half') return { start: DAY_START, end: Number(firstHalfEndMinutes) };
  if (portion === 'second_half') return { start: Number(secondHalfStartMinutes), end: DAY_END };
  /* Full day, and idle, are the whole calendar date — stored as NULL rather
     than as 0..1440 so that "no window" is one value and not two. */
  return null;
}

/* Minutes past midnight as a wall clock. One formatter for the validator's
   sentences, the audit line, the API's labels and the Leave menu. */
function clock(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* Accepts HH:MM (what <input type="time"> sends) or minutes past midnight (what
   the column holds). Both, for the same reason reminder-settings does it: the
   control a person should get for a time of day is a time input, and the column
   has one meaning. */
function readClock(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n >= MINUTES_PER_DAY) return null;
  return n;
}

/* ---------------------------------------------------------------------------
 * VALIDATION, and it returns every error rather than the first: the group saves
 * three fields at once and a form that corrects one mistake per round trip is a
 * form people give up on.
 *
 * THE GAP WARNING IS NOT AN ERROR. "First half ends at 12:00, second half
 * starts at 15:00" leaves three hours that belong to neither half and therefore
 * count as ordinary working time on BOTH half-days. That is a legitimate thing
 * for a studio to want and a surprising thing to do by accident, so it is said
 * out loud and the save proceeds. Blocking it would be this code deciding a
 * studio's hours for it.
 */
function validate(input = {}, { existing = cache, schedule = workSchedule.current() } = {}) {
  const errors = [];
  const warnings = [];
  const pick = (key) => (input[key] === undefined ? existing[key] : input[key]);

  const raw = pick('enabled');
  const enabled = raw === true || raw === 'true' || raw === 1 || raw === '1';

  const base = split({ settings: existing, schedule });
  const readOne = (key, label, fallback) => {
    const value = pick(key);
    if (value === undefined || value === null || value === '') return fallback;
    const n = readClock(value);
    if (n === null) {
      errors.push({ field: key, message: `${label} is a time of day, as HH:MM.` });
      return fallback;
    }
    return n;
  };
  const firstHalfEndMinutes = readOne('firstHalfEndMinutes', 'First Half ends at', base.firstHalfEndMinutes);
  const secondHalfStartMinutes = readOne('secondHalfStartMinutes', 'Second Half starts at', base.secondHalfStartMinutes);

  const open = Number(schedule.dayStart);
  const close = Number(schedule.dayEnd);
  const haveDay = Number.isFinite(open) && Number.isFinite(close) && close > open;

  /* BOTH INSIDE WORKING HOURS. A split outside them would divide a day at a
     moment the studio is shut, which makes one half the whole day and the other
     nothing — a Full Day wearing a half-day's name. */
  if (haveDay) {
    const inside = (n, key, label) => {
      if (errors.some((e) => e.field === key)) return;
      if (n < open || n > close) {
        errors.push({ field: key,
          message: `${label} must be inside working hours, ${clock(open)} to ${clock(close)}.` });
      }
    };
    inside(firstHalfEndMinutes, 'firstHalfEndMinutes', 'First Half ends at');
    inside(secondHalfStartMinutes, 'secondHalfStartMinutes', 'Second Half starts at');
  }

  /* THE ORDER. Second half may start exactly where the first ended — that is a
     studio with no break at the split — but never before it, which would make
     the two halves overlap and count an hour as absent twice. */
  if (!errors.length && secondHalfStartMinutes < firstHalfEndMinutes) {
    errors.push({ field: 'secondHalfStartMinutes',
      message: `Second Half starts at ${clock(secondHalfStartMinutes)}, which is before First Half `
        + `ends at ${clock(firstHalfEndMinutes)}. The second half cannot begin before the first ends.` });
  }

  /* THE GAP, measured against the studio's own breaks rather than against the
     clock: an hour of lunch between the two halves is the normal case and is
     not worth a warning; an hour of WORKING time between them is. */
  if (!errors.length && secondHalfStartMinutes > firstHalfEndMinutes) {
    const breaks = workSchedule.breakWindows(schedule);
    let covered = 0;
    for (const w of breaks) {
      const from = Math.max(firstHalfEndMinutes, Number(w.start));
      const to = Math.min(secondHalfStartMinutes, Number(w.end));
      if (to > from) covered += to - from;
    }
    const gap = secondHalfStartMinutes - firstHalfEndMinutes;
    if (gap - covered > 0) {
      warnings.push({ field: 'secondHalfStartMinutes',
        message: `Time between ${clock(firstHalfEndMinutes)} and ${clock(secondHalfStartMinutes)} `
          + 'counts as normal working time on half-day leave.' });
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors: [],
    warnings,
    value: { enabled, firstHalfEndMinutes, secondHalfStartMinutes },
  };
}

const summarise = (s, { schedule = workSchedule.current() } = {}) => {
  const sp = split({ settings: s, schedule });
  return [
    `Leave & Idle ${s.enabled ? 'on' : 'OFF'}`,
    `first half ends ${clock(sp.firstHalfEndMinutes)}`,
    `second half starts ${clock(sp.secondHalfStartMinutes)}`,
  ].join(', ');
};

/* Only the clauses that moved — the same rule, and the same reason, as
   reminder-settings.describeChange: activity_log.summary is VARCHAR(500) and a
   line that stops mid-word is worse than one that says what changed. */
function describeChange(before, after, { schedule = workSchedule.current() } = {}) {
  const was = summarise(before, { schedule }).split(', ');
  const now = summarise(after, { schedule }).split(', ');
  const moved = [];
  for (let i = 0; i < Math.max(was.length, now.length); i += 1) {
    if (was[i] !== now[i]) moved.push(`${was[i]} → ${now[i]}`);
  }
  if (!moved.length) return 'Saved the Leave settings with no change';
  const line = `Changed the Leave settings: ${moved.join('; ')}`;
  return line.length <= 480 ? line : `${line.slice(0, 460)}… (${moved.length} settings changed)`;
}

/* ---------------------------------------------------------------------------
 * SAVING, AND THE RE-SNAPSHOT THAT GOES WITH IT.
 *
 * Moving the split must not move a half-day that has already happened, and must
 * not move today's either — somebody marked on first-half leave this morning
 * worked their afternoon against the window they were told about. So the
 * re-snapshot touches ACTIVE half-day rows dated STRICTLY AFTER today and
 * nothing else. Prompt 49's planned leaves are exactly those rows, which is why
 * this is written now rather than when they arrive.
 *
 * The UPDATE is the whole re-snapshot: one statement over a handful of rows,
 * inside the same call that changed the setting, so there is no window in which
 * the setting and the future rows disagree.
 */
async function save(db, input, userId, { schedule = workSchedule.current(), today = null } = {}) {
  const checked = validate(input || {}, { schedule });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors, warnings: checked.warnings };
  const before = current();
  const v = checked.value;
  await db.query(
    `INSERT INTO leave_settings
       (id, enabled, first_half_end_minutes, second_half_start_minutes, updated_by)
     VALUES (1, $1, $2, $3, $4)
     ON DUPLICATE KEY UPDATE
       enabled = $1, first_half_end_minutes = $2, second_half_start_minutes = $3, updated_by = $4`,
    [v.enabled ? 1 : 0, v.firstHalfEndMinutes, v.secondHalfStartMinutes, userId || null]
  );

  const day = today || require('./timesheet-gate').istDate();
  let resnapshotted = 0;
  if (before.firstHalfEndMinutes !== v.firstHalfEndMinutes
      || before.secondHalfStartMinutes !== v.secondHalfStartMinutes) {
    const { result } = await db.query(
      `UPDATE user_day_status
          SET window_start_time = CASE \`portion\` WHEN 'first_half' THEN 0 ELSE $1 END,
              window_end_time   = CASE \`portion\` WHEN 'first_half' THEN $2 ELSE ${DAY_END} END
        WHERE cleared_at IS NULL AND kind = 'leave'
          AND \`portion\` IN ('first_half', 'second_half')
          AND \`date\` > $3`,
      [v.secondHalfStartMinutes, v.firstHalfEndMinutes, day]
    ).catch(() => ({ result: { affectedRows: 0 } }));
    resnapshotted = Number((result && result.affectedRows) || 0);
  }

  await load(db);
  return { ok: true, before, settings: current(), warnings: checked.warnings, resnapshotted };
}

module.exports = {
  DEFAULTS, MINUTES_PER_DAY, DAY_START, DAY_END,
  load, isLoaded, current, leaveIdleEnabled,
  prefill, split, windowFor, clock, readClock,
  validate, save, summarise, describeChange,
};
