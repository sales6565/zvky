// The manual timesheet: what somebody says they worked on.
//
// Everything about a week that is not a database call lives here — which day a
// week starts on, what the totals are, whether a line is well-formed, and who
// may look at whose. The route does the reading and writing; this decides what
// any of it means, so the same answers hold in the API, the exports and the
// tests without three copies of the arithmetic.
//
// Deliberately independent of work_sessions and the Efficiency and Idle
// reports, which read measured time (the clock between Accept and Submit).
// This is declared time, including the parts of a day that are not an asset at
// all. Merging them would make "Time Spent" mean two things at once.

const WEEK_DAYS = 7;

/* Weeks run Monday to Sunday.
 *
 * One function, used everywhere, because "which week is this date in" is the
 * question the lock, the totals, the queue and the export all turn on — and two
 * implementations of it disagree first about Sundays and then about everything.
 *
 * Dates are handled as plain YYYY-MM-DD strings rather than as Date objects on
 * purpose: a timesheet day is a calendar day in the studio, not an instant, and
 * putting it through a timezone is how somebody's Monday becomes their Sunday.
 */
function weekStart(date) {
  const iso = toISO(date);
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 is Sunday, so Sunday steps back six days and Monday none.
  const back = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
}

// The seven days of the week a date falls in, in order.
function weekDays(date) {
  const start = weekStart(date);
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: WEEK_DAYS }, (_, i) => {
    const at = new Date(Date.UTC(y, m - 1, d + i));
    return at.toISOString().slice(0, 10);
  });
}

/* A date as the database stores it. Accepts what MySQL hands back (a Date), what
   a browser sends (a string) and what a test writes, and gives one shape back —
   the alternative is every caller remembering which it has. */
function toISO(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/* What a day can be spent on that is not a project.
 *
 * Fixed rather than a Settings collection: these five are what every studio
 * means by them, and a timesheet that cannot be filled in until somebody
 * configures a list is a timesheet nobody fills in. Moving them into reference
 * data later is a migration, not a redesign — the column already holds a key. */
const NON_PROJECT = [
  { key: 'leave',    label: 'Leave' },
  { key: 'holiday',  label: 'Holiday' },
  { key: 'meeting',  label: 'Internal Meeting' },
  { key: 'training', label: 'Training' },
  { key: 'admin',    label: 'Admin' },
];
const NON_PROJECT_KEYS = NON_PROJECT.map((n) => n.key);

// Where a week can be. A sheet is locked to the person whose it is in exactly
// two of these, and that is the whole of the approval cycle.
const STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const LOCKED = ['submitted', 'approved'];

/* Whether the person whose sheet it is may still change it.
 *
 * Rejected counts as editable, which is the point of rejecting rather than
 * deleting: it goes back with a reason and they fix it. Approved does not,
 * because an approval that can be edited afterwards approves nothing. */
const isLocked = (status) => LOCKED.includes(status);

/* A soft ceiling, as the studio asked. Twenty-four hours in a day is not a
   rule anybody should be stopped by — a night shift crossing midnight is
   legitimately logged as a long day — but it is almost always a typo, and the
   right response to "almost always" is to say so rather than to refuse. */
const DAY_WARN_HOURS = 24;

/* One line, checked. Returns { ok, value } or { ok: false, error, field }.
 *
 * The rule worth stating: a line is EITHER project work OR non-project time,
 * never both and never neither. A row carrying a client and "Leave" is one
 * nobody can report on — it would be counted twice or thrown away, depending on
 * which report ran. */
function validateEntry(raw = {}) {
  const date = toISO(raw.date);
  if (!date) return { ok: false, error: 'That is not a date.', field: 'date' };

  const hours = Number(raw.hours);
  if (!Number.isFinite(hours)) {
    return { ok: false, error: 'Hours must be a number.', field: 'hours' };
  }
  if (hours <= 0) return { ok: false, error: 'Hours must be more than zero.', field: 'hours' };
  if (hours > DAY_WARN_HOURS) {
    return { ok: false, error: `One line cannot be more than ${DAY_WARN_HOURS} hours.`, field: 'hours' };
  }
  // Quarter hours. Storing 2.4372 would be false precision on a number somebody
  // typed, and DECIMAL(5,2) would silently round it anyway.
  const rounded = Math.round(hours * 4) / 4;

  const nonProject = raw.nonProject ? String(raw.nonProject).trim() : null;
  const projectId = raw.projectId || null;
  const clientId = raw.clientId || null;
  const assetId = raw.assetId || null;

  if (nonProject) {
    if (!NON_PROJECT_KEYS.includes(nonProject)) {
      return { ok: false, error: 'That is not a category.', field: 'nonProject', allowed: NON_PROJECT_KEYS };
    }
    if (projectId || clientId || assetId) {
      return {
        ok: false,
        error: 'A line is either project work or non-project time, not both.',
        field: 'nonProject',
      };
    }
  } else {
    if (!clientId) return { ok: false, error: 'Choose a client.', field: 'clientId' };
    if (!projectId) return { ok: false, error: 'Choose a project.', field: 'projectId' };
  }

  const notes = String(raw.notes ?? '').trim();
  if (notes.length > 2000) {
    return { ok: false, error: 'Those notes are too long.', field: 'notes' };
  }

  return {
    ok: true,
    value: {
      date,
      weekStart: weekStart(date),
      hours: rounded,
      clientId, projectId, assetId,
      nonProject,
      notes: notes || null,
    },
  };
}

/* The totals the grid shows while somebody types, worked out here so the number
   on screen and the number in the export come from one place. Hours arrive from
   MySQL as strings (DECIMAL), which is why everything is put through Number. */
function totals(entries, date) {
  const days = weekDays(date);
  const perDay = Object.fromEntries(days.map((d) => [d, 0]));
  let week = 0;
  for (const entry of entries) {
    const day = toISO(entry.date || entry.entry_date);
    const hours = Number(entry.hours) || 0;
    if (day in perDay) perDay[day] += hours;
    week += hours;
  }
  // Rounded once, at the end: adding a column of quarter hours in floating
  // point otherwise shows 7.999999999999999 on a perfectly ordinary week.
  const round = (n) => Math.round(n * 100) / 100;
  return {
    days,
    perDay: Object.fromEntries(days.map((d) => [d, round(perDay[d])])),
    week: round(week),
    // Which days look like a mistake rather than a long shift.
    overLong: days.filter((d) => perDay[d] > DAY_WARN_HOURS),
  };
}

module.exports = {
  WEEK_DAYS,
  NON_PROJECT,
  NON_PROJECT_KEYS,
  STATUSES,
  LOCKED,
  DAY_WARN_HOURS,
  weekStart,
  weekDays,
  toISO,
  isLocked,
  validateEntry,
  totals,
};
