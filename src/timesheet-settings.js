/* The Time Sheet's policy numbers, as a row instead of four constants.
 *
 * WHAT WAS ACTUALLY AN OPTION BEFORE THIS, because the answer decided the shape
 * and it is shorter than it looks. src/timesheets.js held MIN_LINE_HOURS = 0.25
 * and MAX_LINE_HOURS = 24; src/work-schedule.js held TIMESHEET_MAX_HOURS = 8,
 * the soft day cap the form quotes and the week flags against. Those three are
 * decisions somebody made once, enforced in one place each and published to the
 * browser, which is exactly what chat_settings was created for and for the same
 * reason — so they move here.
 *
 * TWO MORE ARE NEW, and that is stated rather than implied: there was no
 * back-dating window and no future-date rule in this application at all. They
 * default to NULL, which means unlimited, which is precisely what the code did
 * before — so a deployment that upgrades and never visits Settings behaves
 * identically. A studio that wants the rule switches it on.
 *
 * AND ONE WAS A FIXED CHOICE NOBODY COULD SEE. The Add line form says "Monday
 * to Friday" and validateEntry refused Saturday and Sunday outright, from an
 * isWeekend() built on the date alone — while Settings -> Working Hours has had
 * a configurable set of working days all along, and a studio that works
 * Saturdays could not log a Saturday. That is a real inconsistency and it is
 * reported rather than silently reconciled: loggableDays defaults to Monday to
 * Friday, which is today's behaviour exactly, and is its own setting rather
 * than being wired to workingDays. Two reasons for the separation. workingDays
 * drives the Idle Report's expected hours, so coupling them would mean widening
 * the timesheet silently changed every utilisation figure in the studio. And
 * they are two questions: which days the studio RECORDS time on, and which days
 * a person may FILE hours for. They coincide today, and a studio that wants
 * them to stay coincident now has one place to say so.
 *
 * NULL MEANS UNLIMITED for the two windows, and it means it everywhere — the
 * column, this cache, the API and the validator all read it the same way. A
 * sentinel like 0 or -1 would put a magic number back into every comparison.
 *
 * MIRRORED IN MEMORY, like chat_settings and work_schedule: one studio-wide
 * row, changed a handful of times in the life of a deployment, and read on
 * every line somebody files and every load of the week.
 */

const workSchedule = require('./work-schedule');

/* Today's behaviour, exactly. Each of these is the constant it replaces, so a
   database with no row behaves as the code did before the row existed. */
const DEFAULTS = {
  maxDayHours: 8,        // was work-schedule's TIMESHEET_MAX_HOURS
  minLineHours: 0.25,    // was timesheets.js MIN_LINE_HOURS
  maxLineHours: 24,      // was timesheets.js MAX_LINE_HOURS
  backdateDays: null,    // new; null = no limit, which is what there was
  futureDays: null,      // new; null = no limit, which is what there was
  loggableDays: [1, 2, 3, 4, 5],
  /* OFF ON EVERY EXISTING INSTALL, and that is the decision rather than the
     cautious default.
     
     Switching it on blocks everybody who has not filled the previous working
     day — which, the morning after a deployment, is most of a studio. A feature
     that locks the floor the moment it ships is one nobody forgives, so this
     arrives inert and the Super Admin turns it on when the studio has been
     told. See the Settings panel's description. */
  requirePreviousDay: false,
};

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* A ceiling on the ceiling. A line longer than a day is a typo however the
   studio sets its policy, and a window measured in years is one nobody meant. */
const HOURS_CEILING = 24;
const WINDOW_CEILING = 3650;

let cache = { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;

/* ISO weekdays from a stored CSV. Same reading recording_hour_configs.days_of_week
   has, and deliberately the same shape: a sorted, de-duplicated list of 1..7. */
function parseDays(value) {
  if (value === null || value === undefined || value === '') return [...DEFAULTS.loggableDays];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const days = list
    .map((d) => Number(String(d).trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

const numberOrNull = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

async function load(db) {
  const { rows } = await db.query(
    `SELECT t.*, u.\`name\` AS updated_by_name
       FROM timesheet_settings t
       LEFT JOIN users u ON u.id = t.updated_by
      WHERE t.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  /* NO ROW is a deployment that has not migrated, and it keeps the constants
     the code always had. A row with NULL in a window column is a studio that
     chose "no limit" — two different answers, which is why this reads `row`
     before it reads any column. */
  cache = row ? {
    maxDayHours: numberOrNull(row.max_day_hours, DEFAULTS.maxDayHours),
    minLineHours: numberOrNull(row.min_line_hours, DEFAULTS.minLineHours),
    maxLineHours: numberOrNull(row.max_line_hours, DEFAULTS.maxLineHours),
    backdateDays: row.backdate_days === null || row.backdate_days === undefined
      ? null : Number(row.backdate_days),
    futureDays: row.future_days === null || row.future_days === undefined
      ? null : Number(row.future_days),
    loggableDays: parseDays(row.loggable_days),
    /* A column added after the table shipped, so a database part-way through
       its migration has the row without it: undefined reads as the default,
       which is off. */
    requirePreviousDay: row.require_previous_day === undefined
      ? DEFAULTS.requirePreviousDay : Boolean(Number(row.require_previous_day)),
    updatedBy: row.updated_by || null,
    updatedByName: row.updated_by_name || null,
    updatedAt: row.updated_at || null,
  } : { ...DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;

/* What every reader gets. A copy, and loggableDays copied too — a caller that
   sorted the array in place would be editing the studio's settings. */
const current = () => ({
  ...cache,
  loggableDays: [...cache.loggableDays],
  loggableDayNames: cache.loggableDays.map((d) => DAY_NAMES[d]),
  loggableDayShort: cache.loggableDays.map((d) => DAY_SHORT[d]),
  defaults: { ...DEFAULTS, loggableDays: [...DEFAULTS.loggableDays] },
});

// --- validation -------------------------------------------------------------

/* One save's worth of checking, as a list of {field, message} — the shape every
   other settings screen in this application answers with. */
function validate(input) {
  const errors = [];
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const hours = (key, label, { min, max }) => {
    const raw = pick(key, cache[key]);
    const n = Number(raw);
    if (raw === null || raw === undefined || String(raw).trim?.() === '' || !Number.isFinite(n)) {
      errors.push({ field: key, message: `${label} is a number of hours.` });
      return cache[key];
    }
    if (n < min || n > max) {
      errors.push({ field: key, message: `${label} has to be between ${min} and ${max} hours.` });
      return cache[key];
    }
    return Math.round(n * 100) / 100;
  };

  const minLineHours = hours('minLineHours', 'The smallest a line can be', { min: 0.01, max: HOURS_CEILING });
  const maxLineHours = hours('maxLineHours', 'The largest a line can be', { min: 0.01, max: HOURS_CEILING });
  const maxDayHours = hours('maxDayHours', 'The length of a normal day', { min: 0.01, max: HOURS_CEILING });

  if (!errors.length && minLineHours > maxLineHours) {
    errors.push({
      field: 'minLineHours',
      message: `The smallest a line can be (${minLineHours}h) cannot be more than the largest (${maxLineHours}h).`,
    });
  }

  /* THE COUPLING WITH THE RECORDING WINDOW, which would otherwise be discovered
     by the Working Hours screen refusing to save.
     
     src/work-schedule.js refuses a day that cannot hold a full timesheet day:
     "That leaves 5.5 loggable hours a day, and the Time Sheet allows up to 8."
     That check reads this number, so raising it past what the studio's windows
     can hold would leave Working Hours unable to save its own current value —
     a setting made unreachable from another screen. Refused here instead, where
     the person changing it can read why. */
  if (!errors.length) {
    const win = workSchedule.timesheetWindow();
    const loggable = (Number(win.dayEnd) - Number(win.dayStart)) - Number(win.breakMinutes || 0);
    if (Number.isFinite(loggable) && loggable > 0 && maxDayHours * 60 > loggable) {
      errors.push({
        field: 'maxDayHours',
        message: `The studio's recording windows leave ${Math.round((loggable / 60) * 100) / 100} `
          + `loggable hours a day, so a normal day cannot be ${maxDayHours}. Widen the windows in `
          + 'Recording Hours first, or choose a smaller number.',
      });
    }
  }

  const window = (key, label) => {
    const raw = pick(key, cache[key]);
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;   // unlimited
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > WINDOW_CEILING) {
      errors.push({ field: key, message: `${label} is a whole number of days, or blank for no limit.` });
      return cache[key];
    }
    return n;
  };
  const backdateDays = window('backdateDays', 'How far back a line may be filed');
  const futureDays = window('futureDays', 'How far ahead a line may be filed');

  const loggableDays = parseDays(pick('loggableDays', cache.loggableDays));
  if (!loggableDays.length) {
    errors.push({
      field: 'loggableDays',
      message: 'Choose at least one day. A Time Sheet with no loggable days is one nobody can fill in.',
    });
  }

  /* A BOOLEAN, so there is nothing to validate but the shape. Read loosely on
     purpose — a checkbox posts true/false, a form post may send the string
     'true', and an absent field means "leave it as it was", which is what
     pick() already does for every other setting here. */
  const raw = pick('requirePreviousDay', cache.requirePreviousDay);
  const requirePreviousDay = raw === true || raw === 'true' || raw === 1 || raw === '1';

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { maxDayHours, minLineHours, maxLineHours, backdateDays, futureDays, loggableDays,
      requirePreviousDay },
  };
}

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const v = checked.value;
  await db.query(
    `INSERT INTO timesheet_settings
       (id, max_day_hours, min_line_hours, max_line_hours, backdate_days, future_days,
        loggable_days, require_previous_day, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON DUPLICATE KEY UPDATE
       max_day_hours = $1, min_line_hours = $2, max_line_hours = $3,
       backdate_days = $4, future_days = $5, loggable_days = $6,
       require_previous_day = $7, updated_by = $8`,
    [v.maxDayHours, v.minLineHours, v.maxLineHours, v.backdateDays, v.futureDays,
      v.loggableDays.join(','), v.requirePreviousDay ? 1 : 0, userId || null]
  );
  await load(db);
  return { ok: true, before, settings: current() };
}

/* One line a person reads, for the audit trail. The same job
   recording-hours' summarise() does, and the same reason: a sentence before and
   a sentence after is what makes the log worth keeping. */
const summarise = (s) => [
  `a normal day is ${s.maxDayHours}h`,
  `a line is ${s.minLineHours}–${s.maxLineHours}h`,
  `back-dating ${s.backdateDays === null ? 'unlimited' : `${s.backdateDays} days`}`,
  `ahead ${s.futureDays === null ? 'unlimited' : `${s.futureDays} days`}`,
  `days ${s.loggableDays.length === 7 ? 'every day' : (s.loggableDayShort || []).join('/')}`,
  /* NAMED IN THE AUDIT LINE, because this is the one setting here that can stop
     somebody working. A log that recorded the hour limits and not the switch
     would be missing the only change anybody would come looking for. */
  `yesterday's sheet ${s.requirePreviousDay ? 'REQUIRED before starting work' : 'not required'}`,
].join(', ');

module.exports = {
  DEFAULTS, DAY_NAMES, DAY_SHORT, HOURS_CEILING, WINDOW_CEILING,
  load, isLoaded, current, parseDays, validate, save, summarise,
};
