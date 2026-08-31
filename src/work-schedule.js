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
};

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
  const { rows } = await db.query(
    'SELECT hours_per_day, working_days FROM work_schedule WHERE id = 1'
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = {
    hoursPerDay: row && row.hours_per_day !== null && row.hours_per_day !== undefined
      ? Number(row.hours_per_day) : DEFAULTS.hoursPerDay,
    workingDays: row ? parseDays(row.working_days) : [...DEFAULTS.workingDays],
  };
  loaded = true;
  return cache;
}

function current() {
  return {
    ...cache,
    workingDayNames: cache.workingDays.map((d) => DAY_NAMES[d]),
    defaults: { ...DEFAULTS },
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

async function save(db, { hoursPerDay, workingDays }) {
  const errors = [];
  const hours = cleanHours(hoursPerDay);
  if (hours.error) errors.push({ field: 'hoursPerDay', message: hours.error });
  const days = cleanDays(workingDays === undefined ? cache.workingDays : workingDays);
  if (days.error) errors.push({ field: 'workingDays', message: days.error });
  if (errors.length) return { ok: false, status: 400, errors };

  await db.query(
    `INSERT INTO work_schedule (id, hours_per_day, working_days) VALUES (1, $1, $2)
     ON DUPLICATE KEY UPDATE hours_per_day = VALUES(hours_per_day), working_days = VALUES(working_days)`,
    [hours.value, days.value.join(',')]
  );
  await load(db);
  return { ok: true, schedule: current() };
}

module.exports = { DEFAULTS, DAY_NAMES, load, current, isLoaded, save, cleanHours, cleanDays, parseDays };
