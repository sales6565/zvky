// What a full working day is.
//
// Nothing in this app knew this before. There is no shift model, no roster, no
// capacity field and no calendar — the timer records how long work took and
// nothing recorded how long a day is supposed to be. The Idle Report needs both
// halves, so this is the second half.
//
// One row, id 1, the same shape as branding: it is a studio-wide setting
// changed a handful of times in the life of a deployment and read on every
// report, so it is mirrored in memory rather than queried per request.

const DEFAULTS = {
  // The studio's answer: an eight-hour day, Monday to Friday.
  hoursPerDay: 8,
  // 1 = Monday … 7 = Sunday, matching ISO. Stored as a sorted CSV.
  workingDays: [1, 2, 3, 4, 5],
  /* And when in the day that happens. Minutes past midnight, which is the same
     unit timesheet_entries stores a line in, and for the same reason: these are
     wall clock times in the studio, not instants, so there is no timezone in
     them and nothing to convert. 570 is half past nine to every reader on every
     machine.

     lunchStart/lunchEnd are null when the studio has no fixed break. */
  dayStart: 9 * 60 + 30,   // 09:30
  dayEnd: 19 * 60,         // 19:00
  lunchStart: 13 * 60,     // 13:00
  lunchEnd: 14 * 60,       // 14:00
  /* NULL, not an invented time. Lunch arrived with 13:00-14:00 because that was
     the studio's actual break; nobody has said when their morning and evening
     breaks are, and defaulting them would quietly subtract half an hour a day
     from every person's tracked time in a deployment that never asked for it.
     Null means "no such break" and the maths skips it. */
  morningStart: null,
  morningEnd: null,
  eveningStart: null,
  eveningEnd: null,
};

/* The three breaks, as one list.
 *
 * Lunch was the only one, hard-coded through parsing, validation, saving and
 * display. Adding two more by copying that four times would have been four
 * places to keep in step; naming them once means the fourth break — if a studio
 * ever asks — is one row here.
 *
 * `key` prefixes the in-memory fields (lunchStart/lunchEnd) and `column`
 * prefixes the database ones (lunch_start_min/lunch_end_min). They differ only
 * in case convention, and both are spelled out rather than derived so a grep
 * for either finds this table. */
const BREAKS = [
  { key: 'morning', column: 'morning', label: 'Morning break' },
  { key: 'lunch',   column: 'lunch',   label: 'Lunch' },
  { key: 'evening', column: 'evening', label: 'Evening break' },
];
const startField = (b) => `${b.key}Start`;
const endField = (b) => `${b.key}End`;

/* The break windows that are actually set, as {start, end} minute pairs.
 *
 * The single place anything asks "when is this studio not working?". The idle
 * maths, the timesheet window and the Settings screen all read this rather than
 * each knowing which three pairs exist. Sorted, so a caller can walk them in
 * order without sorting again. */
function breakWindows(from = cache) {
  return BREAKS
    .map((b) => ({ label: b.label, key: b.key, start: from[startField(b)], end: from[endField(b)] }))
    .filter((w) => w.start !== null && w.start !== undefined
      && w.end !== null && w.end !== undefined && w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

/* How many minutes of a day the studio is on a break. */
function breakMinutes(from = cache) {
  return breakWindows(from).reduce((total, w) => total + (w.end - w.start), 0);
}

/* The Time Sheet's cap on one day, which is not this setting and is deliberately
   not merged into it. hoursPerDay is what a full day is EXPECTED to be, and the
   Idle Report divides by it; this is the point past which a day is worth a
   second look. They are both eight, and they are not the same statement — a
   studio could expect eight and only want flagging above ten. Kept here so the
   window can be checked against it in one place. */
const TIMESHEET_MAX_HOURS = 8;

/* The studio is in India and the stored times have no timezone in them, so this
   is display only — see the note on current().timezone. */
const TIMEZONE_LABEL = 'IST';

// "09:30" | "9:30" | 570 -> 570. Anything else -> null.
function parseClock(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 && value <= 24 * 60 ? value : null;
  }
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// 570 -> "09:30". The only place minutes become something a person reads.
function clockLabel(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const number = (value, fallback) =>
  (value === null || value === undefined ? fallback : Number(value));

let cache = { ...DEFAULTS };
let loaded = false;

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function parseDays(text) {
  if (text === null || text === undefined || text === '') return [...DEFAULTS.workingDays];
  const days = String(text).split(',')
    .map((d) => Number(String(d).trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

async function load(db) {
  /* The window columns arrived after the table did, so this selects * and reads
     what is there. A deployment mid-upgrade — the table created, the columns
     not yet added — falls back to the defaults rather than throwing, which is
     the difference between a slow restart and a broken one. */
  const { rows } = await db.query('SELECT * FROM work_schedule WHERE id = 1')
    .catch(() => ({ rows: [] }));
  const row = rows[0] || {};
  const has = (key) => row[key] !== null && row[key] !== undefined;
  cache = {
    hoursPerDay: has('hours_per_day') ? Number(row.hours_per_day) : DEFAULTS.hoursPerDay,
    workingDays: rows.length ? parseDays(row.working_days) : [...DEFAULTS.workingDays],
    dayStart: has('day_start_min') ? Number(row.day_start_min) : DEFAULTS.dayStart,
    dayEnd: has('day_end_min') ? Number(row.day_end_min) : DEFAULTS.dayEnd,
    // Null is a real value here — it means no fixed lunch break — so it is only
    // replaced by the default when the column itself is missing.
    lunchStart: 'lunch_start_min' in row ? numberOrNull(row.lunch_start_min) : DEFAULTS.lunchStart,
    lunchEnd: 'lunch_end_min' in row ? numberOrNull(row.lunch_end_min) : DEFAULTS.lunchEnd,
    /* Same guard as the lunch pair above: these columns arrived after the table
       did, so a process running new code against a database that has not been
       migrated yet reads the default rather than throwing. */
    morningStart: 'morning_start_min' in row ? numberOrNull(row.morning_start_min) : DEFAULTS.morningStart,
    morningEnd: 'morning_end_min' in row ? numberOrNull(row.morning_end_min) : DEFAULTS.morningEnd,
    eveningStart: 'evening_start_min' in row ? numberOrNull(row.evening_start_min) : DEFAULTS.eveningStart,
    eveningEnd: 'evening_end_min' in row ? numberOrNull(row.evening_end_min) : DEFAULTS.eveningEnd,
  };
  loaded = true;
  return cache;
}

const numberOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function current() {
  return {
    ...cache,
    workingDayNames: cache.workingDays.map((d) => DAY_NAMES[d]),
    // The same numbers as labels, so no screen and no export formats a clock
    // for itself.
    dayStartLabel: clockLabel(cache.dayStart),
    dayEndLabel: clockLabel(cache.dayEnd),
    lunchStartLabel: clockLabel(cache.lunchStart),
    lunchEndLabel: clockLabel(cache.lunchEnd),
    hasLunch: cache.lunchStart !== null && cache.lunchEnd !== null,
    morningStartLabel: clockLabel(cache.morningStart),
    morningEndLabel: clockLabel(cache.morningEnd),
    eveningStartLabel: clockLabel(cache.eveningStart),
    eveningEndLabel: clockLabel(cache.eveningEnd),
    /* The set that is actually configured, already labelled and sorted, so the
       Settings screen and the Idle Report read the same list rather than each
       working out which of the three pairs are in use. */
    breaks: breakWindows().map((w) => ({
      ...w, startLabel: clockLabel(w.start), endLabel: clockLabel(w.end),
      minutes: w.end - w.start,
    })),
    breakMinutes: breakMinutes(),
    maxHours: TIMESHEET_MAX_HOURS,
    /* A label, not a conversion. The times above are minutes past midnight with
       no timezone in them, so this says which clock a reader should picture and
       changes nothing if it is edited. Kept here so the Settings screen and the
       Time Sheet say the same word. */
    timezone: TIMEZONE_LABEL,
    defaults: { ...DEFAULTS },
  };
}

/* The shape src/timesheets.js checks a line against.
 *
 * A plain object rather than the module itself, so the timesheet arithmetic
 * stays a pure function of its inputs and can be unit-tested without a
 * database, and so there is exactly one translation between "the setting" and
 * "the rule". */
function timesheetWindow() {
  return {
    dayStart: cache.dayStart,
    dayEnd: cache.dayEnd,
    lunchStart: cache.lunchStart,
    lunchEnd: cache.lunchEnd,
    /* All three, for anything computing how much of a day is workable. Lunch
       stays named separately above because src/timesheets.js already reads it
       by name and this is not the change to rewrite that. */
    breaks: breakWindows(),
    breakMinutes: breakMinutes(),
    maxHours: TIMESHEET_MAX_HOURS,
    timezone: TIMEZONE_LABEL,
  };
}

function isLoaded() { return loaded; }

/* What a day may be.
 *
 * A zero-hour day would make every idle percentage a division by zero, and a
 * day longer than 24 hours is a typo rather than a policy. Both are refused
 * with the number in the message, because "invalid" on its own leaves somebody
 * guessing which end they got wrong. */
function cleanHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'Enter the number of hours in a standard working day.' };
  if (n <= 0) return { error: 'A working day has to be longer than zero hours.' };
  if (n > 24) return { error: `${n} hours is longer than a day.` };
  // Quarter-hours: enough for a 7.5-hour day, not enough to invite nonsense.
  return { value: Math.round(n * 4) / 4 };
}

function cleanDays(value) {
  const days = Array.isArray(value) ? value : parseDays(value);
  const clean = [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))]
    .sort((a, b) => a - b);
  if (!clean.length) {
    return { error: 'Choose at least one working day, or every period would expect zero hours.' };
  }
  return { value: clean };
}

/* When the day runs, and when lunch is.
 *
 * Every check here exists because the setting feeds a form somebody has to be
 * able to fill in. A window that is backwards, or a lunch break outside the
 * day, or a day too short to hold the hours the Time Sheet allows, all produce
 * the same symptom at the other end — a Time Sheet that refuses everything —
 * and by then nobody remembers this screen was touched. Each is refused here,
 * with the numbers in the message, rather than discovered there.
 */
function cleanWindow(input) {
  const { dayStart, dayEnd } = input;
  const errors = [];
  const start = parseClock(dayStart);
  const end = parseClock(dayEnd);
  if (start === null) {
    errors.push({ field: 'dayStart', message: 'Give the time the working day starts, as 09:30.' });
  }
  if (end === null) {
    errors.push({ field: 'dayEnd', message: 'Give the time the working day ends, as 19:00.' });
  }
  if (errors.length) return { errors };

  if (end <= start) {
    return { errors: [{ field: 'dayEnd', message: 'The working day has to end after it starts.' }] };
  }

  /* Both blank is the studio with no such break, and it is a real answer rather
     than an omission — so it is accepted, and only half of one is refused. The
     same three rules apply to each of the three breaks, which is why they are
     one loop and not three copies. */
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const value = { dayStart: start, dayEnd: end };
  const set = [];

  for (const b of BREAKS) {
    const rawStart = input[startField(b)];
    const rawEnd = input[endField(b)];
    value[startField(b)] = null;
    value[endField(b)] = null;
    if (blank(rawStart) && blank(rawEnd)) continue;

    const bStart = parseClock(rawStart);
    const bEnd = parseClock(rawEnd);
    if (bStart === null || bEnd === null) {
      return {
        errors: [{
          field: bStart === null ? startField(b) : endField(b),
          message: `Give both ends of ${b.label.toLowerCase()}, or leave both empty for no such break.`,
        }],
      };
    }
    if (bEnd <= bStart) {
      return { errors: [{ field: endField(b), message: `${b.label} has to end after it starts.` }] };
    }
    if (bStart < start || bEnd > end) {
      return {
        errors: [{
          field: startField(b),
          message: `${b.label} has to sit inside the working day (${clockLabel(start)}–${clockLabel(end)}).`,
        }],
      };
    }
    /* Overlapping breaks would be double-subtracted from everybody's tracked
       hours — an hour counted twice as not-working — so they are refused rather
       than silently merged. Merging would also mean the screen showed something
       different from what was saved. */
    const clash = set.find((o) => bStart < o.end && bEnd > o.start);
    if (clash) {
      return {
        errors: [{
          field: startField(b),
          message: `${b.label} overlaps ${clash.label.toLowerCase()} `
            + `(${clockLabel(clash.start)}–${clockLabel(clash.end)}). Breaks cannot overlap.`,
        }],
      };
    }
    set.push({ label: b.label, start: bStart, end: bEnd });
    value[startField(b)] = bStart;
    value[endField(b)] = bEnd;
  }

  /* The check that catches the setting nobody would notice was wrong: a window
     that cannot hold a full day's work. Eight hours between 09:30 and 15:00 is
     not a stricter policy, it is a Time Sheet that can never be completed.
     Every break comes off, not just lunch. */
  const breakTotal = set.reduce((t, w) => t + (w.end - w.start), 0);
  const loggable = (end - start) - breakTotal;
  if (loggable < TIMESHEET_MAX_HOURS * 60) {
    const hours = Math.round((loggable / 60) * 100) / 100;
    return {
      errors: [{
        field: 'dayEnd',
        message: `That leaves ${hours} loggable hours a day, and the Time Sheet allows up to `
          + `${TIMESHEET_MAX_HOURS}. Widen the day, or shorten the breaks.`,
      }],
    };
  }

  return { value };
}

async function save(db, input = {}) {
  const { hoursPerDay, workingDays, dayStart, dayEnd } = input;
  const errors = [];
  /* Omitted means unchanged, matching workingDays below and the window further
     down. Without this, a caller changing only the break times — which the
     endpoint's own comment says is supported — was refused for not having sent
     a number it was not trying to change. */
  const hours = cleanHours(hoursPerDay === undefined ? cache.hoursPerDay : hoursPerDay);
  if (hours.error) errors.push({ field: 'hoursPerDay', message: hours.error });
  const days = cleanDays(workingDays === undefined ? cache.workingDays : workingDays);
  if (days.error) errors.push({ field: 'workingDays', message: days.error });

  /* Omitting the window leaves it as it is, so a caller that only wants to
     change the hours per day — the shape this endpoint had before the window
     existed — still works and does not silently reset the clock. */
  const windowInput = {
    dayStart: dayStart === undefined ? cache.dayStart : dayStart,
    dayEnd: dayEnd === undefined ? cache.dayEnd : dayEnd,
  };
  /* Field by field, so a caller that sends only the morning break does not
     silently wipe lunch — the shape this endpoint had before the two extra
     breaks existed still works and still means the same thing. */
  for (const b of BREAKS) {
    windowInput[startField(b)] = input[startField(b)] === undefined
      ? cache[startField(b)] : input[startField(b)];
    windowInput[endField(b)] = input[endField(b)] === undefined
      ? cache[endField(b)] : input[endField(b)];
  }
  const window = cleanWindow(windowInput);
  if (window.errors) errors.push(...window.errors);

  if (errors.length) return { ok: false, status: 400, errors };

  await db.query(
    `INSERT INTO work_schedule
       (id, hours_per_day, working_days, day_start_min, day_end_min,
        lunch_start_min, lunch_end_min, morning_start_min, morning_end_min,
        evening_start_min, evening_end_min)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON DUPLICATE KEY UPDATE hours_per_day = VALUES(hours_per_day),
       working_days = VALUES(working_days), day_start_min = VALUES(day_start_min),
       day_end_min = VALUES(day_end_min), lunch_start_min = VALUES(lunch_start_min),
       lunch_end_min = VALUES(lunch_end_min),
       morning_start_min = VALUES(morning_start_min), morning_end_min = VALUES(morning_end_min),
       evening_start_min = VALUES(evening_start_min), evening_end_min = VALUES(evening_end_min)`,
    [hours.value, days.value.join(','), window.value.dayStart, window.value.dayEnd,
     window.value.lunchStart, window.value.lunchEnd,
     window.value.morningStart, window.value.morningEnd,
     window.value.eveningStart, window.value.eveningEnd]
  );
  await load(db);
  return { ok: true, schedule: current() };
}

module.exports = {
  DEFAULTS, DAY_NAMES, TIMESHEET_MAX_HOURS, TIMEZONE_LABEL, BREAKS,
  breakWindows, breakMinutes,
  load, current, isLoaded, save,
  cleanHours, cleanDays, cleanWindow, parseDays, parseClock, clockLabel,
  timesheetWindow,
};
