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
  /* ON, unlike requirePreviousDay above, and the difference is worth stating
     because the two sit next to each other.
     
     requirePreviousDay arrives off because switching it on BLOCKS people — the
     morning after a deployment most of a studio has not filled yesterday. This
     one blocks nobody and adds nothing to anybody's day: with it on, a lead who
     holds timesheet.tl_action and leads the selected project sees one more
     check box on the Add line form, and everyone else sees exactly what they
     saw before. A feature that costs nothing to have on is one the studio asked
     to have on. */
  tlAction: true,
  /* ON, for the same reason as tlAction above: it blocks nobody and adds
     nothing to anybody's day. With it on, a role holding timesheet.export sees
     one more button on the Timesheet tab; everybody else sees exactly what
     they saw before. Off hides the button and the endpoint refuses, so a studio
     that would rather nobody took a copy of everybody's hours can say so. */
  exportEnabled: true,
  /* THE EXACT-HOURS RULE, OFF, and off for the same reason requirePreviousDay
     is off: switching it on stops people submitting. The morning after a
     deployment most of a studio has a day that is not exactly eight hours, and
     a feature that locks the floor the moment it ships is one nobody forgives.
     The Super Admin turns it on when the studio has been told, and the date
     below is what stops it reaching backwards when they do. */
  hoursRuleEnabled: false,
  /* THE DAY THE RULE STARTS, as an ISO date, or null for "it has never been
     started". Set to today in the studio's timezone the first time the switch
     goes on, and editable after that — see save(). Days before it submit
     exactly as they did before this feature existed, which is the whole of the
     no-backlog promise. */
  hoursRuleFrom: null,
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

/* A DATE column, or a string, as the ISO date this application compares with.
   mysql2 hands back a Date for a DATE column, and a Date carries a timezone
   that an ISO date does not — so it is formatted from its UTC parts, which are
   the parts the driver filled from the stored y-m-d. Anything else is null,
   because a half-parsed date would put the rule's start day somewhere nobody
   chose. */
const isoDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

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
    /* Same tolerance, same reason: a database whose ALTER has not run yet reads
       undefined here and gets the default — which for this one is ON. */
    tlAction: row.tl_action_enabled === undefined
      ? DEFAULTS.tlAction : Boolean(Number(row.tl_action_enabled)),
    exportEnabled: row.export_enabled === undefined || row.export_enabled === null
      ? DEFAULTS.exportEnabled : Boolean(Number(row.export_enabled)),
    /* Two more columns added after the table shipped, so the same tolerance as
       the three above: a database whose ALTER has not run reads undefined and
       gets the default, which is the rule switched off. A deployment that
       cannot add the columns is a deployment where this feature does not
       exist, which is the safe end of it. */
    hoursRuleEnabled: row.hours_rule_enabled === undefined || row.hours_rule_enabled === null
      ? DEFAULTS.hoursRuleEnabled : Boolean(Number(row.hours_rule_enabled)),
    hoursRuleFrom: isoDate(row.hours_rule_from),
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
  /* THE REQUIRED HOURS, and the three constraints the exact-hours rule puts on
   * them. It is the same number it always was — the soft cap the day total is
   * flagged against — and since Prompt 64 it is also what a day under the rule
   * must add up to EXACTLY. That second job is what narrows it:
   *
   *   AT LEAST AN HOUR, AT MOST A DAY. 0.01h was allowed when this was only a
   *     flag threshold; as a requirement it would mean a studio where every day
   *     must be thirty-six seconds.
   *   A QUARTER OF AN HOUR AT A TIME, which is the step the form offers and the
   *     smallest a line can be by default.
   *   AND ITS HALF MUST BE STORABLE. A half-day leave requires half of it, and
   *     half of 8.25h is 4.125h — which `timesheet_entries.hours DECIMAL(5,2)`
   *     cannot hold, so no combination of lines could ever satisfy that day. A
   *     value like that is refused here rather than producing an unsatisfiable
   *     day for whoever next takes a half day. In practice this means multiples
   *     of half an hour.
   *
   * ALL THREE APPLY WHETHER THE RULE IS ON OR OFF, deliberately: the value is
   * one value, and a studio that sets 8.25 with the switch off would find its
   * half-days unsatisfiable the moment somebody turned it on. */
  const maxDayHours = hours('maxDayHours', 'The hours required each day', { min: 1, max: 24 });
  if (!errors.some((e) => e.field === 'maxDayHours')) {
    const centi = Math.round(maxDayHours * 100);
    if (centi % 25 !== 0) {
      errors.push({
        field: 'maxDayHours',
        message: `The hours required each day go in quarter hours — ${maxDayHours} is not one of `
          + 'them. Try 7.75, 8 or 8.25.',
      });
    } else if (centi % 2 !== 0) {
      errors.push({
        field: 'maxDayHours',
        message: `A half day would be ${Math.round((maxDayHours / 2) * 1000) / 1000}h, which a `
          + `timesheet line cannot hold — hours are stored to two decimal places. Choose a value `
          + `whose half is a round figure: ${Math.floor(maxDayHours * 2) / 2} or `
          + `${Math.ceil(maxDayHours * 2) / 2}.`,
      });
    }
  }

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
  const bool = (key) => {
    const raw = pick(key, cache[key]);
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  };
  const requirePreviousDay = bool('requirePreviousDay');
  const tlAction = bool('tlAction');
  /* THE DOWNLOAD SWITCH, AND WHY ITS ABSENCE HERE WAS A BUG.
   *
   * save() below writes `v.exportEnabled ? 1 : 0`. Until this line existed,
   * validate() never put exportEnabled into `value` at all — so every save of
   * the Time Sheet options screen, whatever it was changing, wrote 0 to
   * export_enabled and silently switched the whole studio's timesheet download
   * off. The default is ON, so a fresh installation was fine and the first
   * person to press Save on an unrelated setting broke it.
   *
   * bool() reads the CURRENT value when the field is absent (pick(key,
   * cache[key])), which is what makes "leave this as it was" work for an older
   * page that does not send the field — so this is also the line that stops a
   * stale tab turning it off. */
  const exportEnabled = bool('exportEnabled');

  /* THE EXACT-HOURS RULE'S OWN TWO FIELDS.
   *
   * The DATE is validated but never defaulted here: whether an absent date
   * means "today" or "leave it as it was" depends on whether the switch is
   * moving, and that is save()'s business — see the note there. '' is how a
   * form clears a date input, and it reads as null, which is "never started". */
  const hoursRuleEnabled = bool('hoursRuleEnabled');
  let hoursRuleFrom = cache.hoursRuleFrom;
  if (input.hoursRuleFrom !== undefined) {
    const raw = input.hoursRuleFrom;
    if (raw === null || raw === '' || raw === undefined) {
      hoursRuleFrom = null;
    } else {
      const text = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
        errors.push({
          field: 'hoursRuleFrom',
          message: 'The date the rule starts from is a day, as 2026-04-01.',
        });
      } else {
        hoursRuleFrom = text;
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { maxDayHours, minLineHours, maxLineHours, backdateDays, futureDays, loggableDays,
      requirePreviousDay, tlAction, exportEnabled, hoursRuleEnabled, hoursRuleFrom },
  };
}

/* TODAY, IN THE STUDIO'S TIMEZONE, as an ISO date. Asked of the module that
   owns the studio's clock rather than built from a local Date: this server runs
   in UTC and the studio is in India, so between 18:30 and midnight UTC "today"
   is already tomorrow in the office. Turning the rule on at 7pm IST must not
   set its start date to yesterday. */
const istToday = (now = Date.now()) => require('./timesheet-gate').istDate(now);

async function save(db, input, userId) {
  const checked = validate(input || {});
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const before = current();
  const v = checked.value;

  /* THE DAY THE RULE STARTS, decided here and not in validate(), because it
   * depends on what the switch is DOING rather than on what was sent:
   *
   *   turning it ON with no date stored   today, in the studio's timezone. This
   *                                       is the no-backlog promise: the rule
   *                                       starts the day somebody starts it,
   *                                       and a month of half-filled days
   *                                       behind it submit as they always did.
   *   turning it ON with a date stored    that date, kept. A studio that set a
   *                                       date, switched the rule off for a
   *                                       fortnight and switched it back on has
   *                                       not asked for the date to move.
   *   a date sent explicitly              that date, whatever the switch does.
   *                                       The field is editable, which the
   *                                       brief asks for.
   *   turning it OFF                      the date is left alone, so turning it
   *                                       on again does not silently re-rule a
   *                                       stretch of days nobody looked at.
   */
  if (v.hoursRuleEnabled && !v.hoursRuleFrom && input.hoursRuleFrom === undefined) {
    v.hoursRuleFrom = istToday();
  }
  /* THE WIDE WRITE, THEN THE NARROW ONE. A deployment whose tl_action_enabled
     ALTER has not applied still saves the other seven settings rather than
     failing the whole screen over a column it does not have — the same
     fallback src/leave-settings.js save() makes, and the same reason: on
     shared hosting an ALTER is a thing that gets refused. */
  const widest = `INSERT INTO timesheet_settings
       (id, max_day_hours, min_line_hours, max_line_hours, backdate_days, future_days,
        loggable_days, require_previous_day, tl_action_enabled, export_enabled,
        hours_rule_enabled, hours_rule_from, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON DUPLICATE KEY UPDATE
       max_day_hours = $1, min_line_hours = $2, max_line_hours = $3,
       backdate_days = $4, future_days = $5, loggable_days = $6,
       require_previous_day = $7, tl_action_enabled = $8, export_enabled = $9,
       hours_rule_enabled = $10, hours_rule_from = $11,
       updated_by = $12`;
  const wide = `INSERT INTO timesheet_settings
       (id, max_day_hours, min_line_hours, max_line_hours, backdate_days, future_days,
        loggable_days, require_previous_day, tl_action_enabled, export_enabled, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON DUPLICATE KEY UPDATE
       max_day_hours = $1, min_line_hours = $2, max_line_hours = $3,
       backdate_days = $4, future_days = $5, loggable_days = $6,
       require_previous_day = $7, tl_action_enabled = $8, export_enabled = $9,
       updated_by = $10`;
  const narrow = `INSERT INTO timesheet_settings
       (id, max_day_hours, min_line_hours, max_line_hours, backdate_days, future_days,
        loggable_days, require_previous_day, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON DUPLICATE KEY UPDATE
       max_day_hours = $1, min_line_hours = $2, max_line_hours = $3,
       backdate_days = $4, future_days = $5, loggable_days = $6,
       require_previous_day = $7, updated_by = $8`;
  const core = [v.maxDayHours, v.minLineHours, v.maxLineHours, v.backdateDays, v.futureDays,
    v.loggableDays.join(','), v.requirePreviousDay ? 1 : 0];
  /* THREE WIDTHS NOW, tried widest first and each falling back on
     ER_BAD_FIELD_ERROR alone. The reason is the one the two-width version
     already gave: on shared hosting an ALTER is a thing that gets refused, and
     a studio whose hours_rule columns never arrived must still be able to save
     the eight settings it does have rather than losing the whole screen. */
  try {
    await db.query(widest, [...core, v.tlAction ? 1 : 0, v.exportEnabled ? 1 : 0,
      v.hoursRuleEnabled ? 1 : 0, v.hoursRuleFrom || null, userId || null]);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    try {
      await db.query(wide, [...core, v.tlAction ? 1 : 0, v.exportEnabled ? 1 : 0, userId || null]);
    } catch (err2) {
      if (err2.code !== 'ER_BAD_FIELD_ERROR') throw err2;
      await db.query(narrow, [...core, userId || null]);
    }
  }
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
  `TL Action ${s.tlAction ? 'on' : 'off'}`,
  /* ALSO NAMED, for the same reason: this is the switch that makes everybody's
     hours downloadable, and a log that recorded the hour limits but not the day
     it was turned on would be missing the entry somebody came for. */
  `timesheet download ${s.exportEnabled ? 'on' : 'off'}`,
  /* THE EXACT-HOURS RULE, named with its start date, because this is the switch
     that decides whether anybody can submit at all. "Who turned it on, when,
     and from which day" is the question that will be asked, and a log that
     recorded the hour limits and not this would not answer it. */
  `exact hours ${s.hoursRuleEnabled ? `REQUIRED from ${s.hoursRuleFrom || 'no date'}` : 'not required'}`,
].join(', ');

module.exports = {
  DEFAULTS, DAY_NAMES, DAY_SHORT, HOURS_CEILING, WINDOW_CEILING,
  load, isLoaded, current, parseDays, validate, save, summarise,
};
