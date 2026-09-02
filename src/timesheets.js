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

/* --- the studio's working day ----------------------------------------------

   All of it in minutes from midnight, and all of it India Standard Time.

   The unit is the load-bearing decision here. A timesheet time is a WALL CLOCK
   time in the studio — "I started at half nine" — not an instant on a timeline.
   Stored as an instant it would need a timezone to read back, and then the
   studio's 9:30 would land at 04:00 for a server in UTC and at 23:00 for
   somebody logging in from California. Stored as 570 minutes past midnight it
   is 9:30 to everybody, on every machine, for ever, and no conversion happens
   anywhere. IST has no daylight saving, so there is no second case to get
   wrong either.

   The consequence worth naming: these numbers are deliberately NOT comparable
   with the asset pipeline's timestamps, which are real instants. That is the
   same wall the Time Sheet already has with the Efficiency report, and it is
   the right one.
*/
const IST_LABEL = 'IST';
const DAY_START = 9 * 60 + 30;   // 09:30
const DAY_END = 19 * 60;         // 19:00
const LUNCH_START = 13 * 60;     // 13:00
const LUNCH_END = 14 * 60;       // 14:00
/* Eight hours, and it is a WARNING rather than a wall — the studio asked for
   the soft version, and it is the right one: a genuinely long day exists, and a
   form that refuses it teaches somebody to log eight and go home late. The day
   is flagged instead, and the flag travels to whoever approves it. */
const DAY_MAX_MINUTES = 8 * 60;
/* Under eight is silent. A half day of leave is not a problem to report. */

// "09:30", "9:30", "09:30:00" -> 570. Anything else -> null.
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

/* How much of [start, end) is not lunch.
 *
 * Auto-subtracted rather than blocked, as the studio chose: somebody who worked
 * 12:30 to 14:30 worked ninety minutes, and making them file it as two rows to
 * say so is bookkeeping for the form's benefit. The overlap is removed, and the
 * caller is told it happened so the screen can say so rather than quietly
 * showing a smaller number than the person typed.
 */
function workedMinutes(start, end) {
  const gross = Math.max(0, end - start);
  const overlap = Math.max(0, Math.min(end, LUNCH_END) - Math.max(start, LUNCH_START));
  return { gross, lunch: overlap, net: gross - overlap };
}

// Saturday or Sunday, from the date string alone.
function isWeekend(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
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
 * A line is now a stretch of the clock rather than a number of hours: the
 * studio asked for a working window and a lunch break, and neither can be
 * checked against "3.5". The duration is worked out here and stored alongside,
 * so everything that already reads hours — the totals, the exports, the
 * approver's queue — keeps working without knowing about minutes.
 *
 * Two rules that are rules, and everything else is a flag:
 *   the window   09:30-19:00, refused outside it
 *   lunch        13:00-14:00, subtracted from whatever overlaps it
 * Over eight hours in a day and work at the weekend are both allowed and both
 * flagged, because both are real things that happen.
 */
function validateEntry(raw = {}) {
  const date = toISO(raw.date);
  if (!date) return { ok: false, error: 'That is not a date.', field: 'date' };

  const start = parseClock(raw.startTime ?? raw.start);
  const end = parseClock(raw.endTime ?? raw.end);
  if (start === null) return { ok: false, error: 'Give a start time, as 09:30.', field: 'startTime' };
  if (end === null) return { ok: false, error: 'Give an end time, as 17:30.', field: 'endTime' };
  if (end <= start) {
    return { ok: false, error: 'The end time has to be after the start time.', field: 'endTime' };
  }
  if (start < DAY_START || end > DAY_END) {
    return {
      ok: false,
      error: `The working day is ${clockLabel(DAY_START)} to ${clockLabel(DAY_END)} ${IST_LABEL}.`,
      field: start < DAY_START ? 'startTime' : 'endTime',
    };
  }

  const { gross, lunch, net } = workedMinutes(start, end);
  /* A line entirely inside the lunch hour subtracts to nothing. Storing a
     nought-hour row would be storing a line that says nobody worked, so it is
     refused with the reason rather than accepted and silently emptied. */
  if (net <= 0) {
    return {
      ok: false,
      error: `That is entirely within the lunch break (${clockLabel(LUNCH_START)}–${clockLabel(LUNCH_END)}), which is not working time.`,
      field: 'startTime',
    };
  }

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
    // Told, not hidden: the screen says "lunch removed" rather than showing a
    // number smaller than the one that was typed with no explanation.
    lunchSubtracted: lunch,
    value: {
      date,
      startMin: start,
      endMin: end,
      // Kept in hours as well as minutes so the exports, totals and queue read
      // one number and never divide by sixty in four places.
      hours: Math.round((net / 60) * 100) / 100,
      clientId, projectId, assetId,
      nonProject,
      notes: notes || null,
    },
  };
}

/* Do two lines on the same day cover the same minutes?
 *
 * Worth refusing: the same hour claimed twice is the one arithmetic error a
 * timesheet cannot catch by adding up, because the total looks perfectly
 * reasonable. Half-open intervals, so 10:00-11:00 and 11:00-12:00 sit together.
 */
function overlaps(line, others) {
  return others.find((o) => line.startMin < o.endMin && o.startMin < line.endMin) || null;
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
    /* Days worth a second look, and neither is an error. Over eight hours is
       the studio's soft cap; a weekend is work on a day the studio does not
       normally open. Both are flagged for whoever approves rather than refused
       at the form, because both are things that genuinely happen. */
    overLong: days.filter((d) => perDay[d] > DAY_MAX_MINUTES / 60),
    weekend: days.filter((d) => isWeekend(d) && perDay[d] > 0),
  };
}

/* One day's worth, which is what submission and approval now act on. Returns
   the number a person sees plus the two flags an approver needs. */
function dayTotal(entries) {
  const minutes = entries.reduce((n, e) => n + (Number(e.hours) || 0) * 60, 0);
  const hours = Math.round((minutes / 60) * 100) / 100;
  return {
    hours,
    lines: entries.length,
    overLong: minutes > DAY_MAX_MINUTES,
    maxHours: DAY_MAX_MINUTES / 60,
  };
}

module.exports = {
  WEEK_DAYS,
  NON_PROJECT,
  NON_PROJECT_KEYS,
  STATUSES,
  LOCKED,
  // The studio's working day, in one place. Everything that draws a clock, or
  // checks one, reads these rather than repeating 9.5 and 19 anywhere.
  IST_LABEL,
  DAY_START,
  DAY_END,
  LUNCH_START,
  LUNCH_END,
  DAY_MAX_MINUTES,
  parseClock,
  clockLabel,
  workedMinutes,
  isWeekend,
  overlaps,
  weekStart,
  weekDays,
  toISO,
  isLocked,
  validateEntry,
  totals,
  dayTotal,
};
