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
/* The clock these times are read on. A label, not a conversion: the numbers
   below are minutes past midnight with no timezone in them. Owned by
   src/work-schedule.js, which is where the rest of the window now lives; this
   is the fallback for a caller that passes no window at all. */
const IST_LABEL = 'IST';

/* The window is a SETTING now (Settings -> Working Hours), not a constant, so
   every function that checks a clock takes it as an argument. These are the
   fallbacks, and they are the values that were compiled in before, so a caller
   that passes nothing behaves exactly as the feature did when the numbers were
   hardcoded — which is what keeps the arithmetic here a pure function and
   testable without a database.

   maxHours is eight, and it is a WARNING rather than a wall — the studio asked
   for the soft version, and it is the right one: a genuinely long day exists,
   and a form that refuses it teaches somebody to log eight and go home late.
   The day is flagged instead, and the flag travels to whoever approves it.
   Under eight is silent: a half day of leave is not a problem to report. */
const DEFAULT_WINDOW = {
  dayStart: 9 * 60 + 30,   // 09:30
  dayEnd: 19 * 60,         // 19:00
  lunchStart: 13 * 60,     // 13:00
  lunchEnd: 14 * 60,       // 14:00
  maxHours: 8,
  timezone: IST_LABEL,
};

/* Fills in whatever a caller left out. Written once because a half-supplied
   window — a day start with no day end — would otherwise compare a number
   against undefined, and every such comparison is false, which is the quiet
   kind of wrong: the check would simply stop happening. */
function windowOf(win) {
  if (!win) return { ...DEFAULT_WINDOW };
  const pick = (key) => (win[key] === undefined ? DEFAULT_WINDOW[key] : win[key]);
  return {
    dayStart: Number(pick('dayStart')),
    dayEnd: Number(pick('dayEnd')),
    // Null is meaningful: the studio with no fixed lunch break.
    lunchStart: pick('lunchStart') === null ? null : Number(pick('lunchStart')),
    lunchEnd: pick('lunchEnd') === null ? null : Number(pick('lunchEnd')),
    maxHours: Number(pick('maxHours')),
    timezone: pick('timezone'),
  };
}

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

/* Lunch was subtracted from a span here, and there is no span any more.
 *
 * Removed rather than left unused: a function nothing calls is a claim that
 * something still works this way, and the next person to read it would spend a
 * while working out where the lunch rule went. It went with the clock. */

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

/* The smallest and largest a line can be.
 *
 * A quarter of an hour is the finest grain anybody fills a timesheet in at, and
 * a line of nought hours is a line saying nobody worked — refused rather than
 * stored, the same answer the clock version gave a span that subtracted to
 * nothing. Twenty-four is the ceiling on ONE line; the day's soft warning is a
 * separate and much lower number.
 */
const MIN_LINE_HOURS = 0.25;
const MAX_LINE_HOURS = 24;

/* Hours, from whatever the form sent. Accepts "3", "3.5", " 3.50 " and 3.5.
 * Rejects anything that is not a finite number, which is what an empty field
 * and a typed word both come through as. */
function parseHours(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  // Two decimals, which is what the column stores and what quarter hours need.
  return Math.round(n * 100) / 100;
}

/* One line, checked. Returns { ok, value } or { ok: false, error, field }.
 *
 * A line is a NUMBER OF HOURS against one asset, project or non-project
 * category. It was a stretch of the clock, and the studio asked for the simpler
 * shape; what that costs is worth writing down rather than discovering later:
 *
 *   THE WORKING WINDOW AND THE LUNCH RULE ARE GONE. Both were checks against a
 *   clock, and there is no clock here to check. 09:30-19:00 and the lunch hour
 *   are no longer read by anything, which is why the fields that set them have
 *   been taken out of Settings rather than left there configuring nothing.
 *
 *   SO IS THE OVERLAP CHECK, AND THAT ONE IS A REAL LOSS. Two lines claiming
 *   the same minutes used to be refused, and it is the one arithmetic error a
 *   timesheet cannot catch by adding up — the total looks perfectly reasonable.
 *   With hours alone there is nothing to compare, so the day total and its
 *   warning are the only defence left. Nothing here can bring it back; it needs
 *   the clock times to return.
 *
 * What survives is the soft eight-hour day, which is a warning and not a wall,
 * and the rule that a line is either project work or non-project time.
 */
function validateEntry(raw = {}, win) {
  const { maxHours } = windowOf(win);
  const date = toISO(raw.date);
  if (!date) return { ok: false, error: 'That is not a date.', field: 'date' };

  const hours = parseHours(raw.hours);
  if (hours === null) {
    return { ok: false, error: 'Say how many hours, as 3 or 3.5.', field: 'hours' };
  }
  if (hours < MIN_LINE_HOURS) {
    return {
      ok: false,
      error: hours <= 0
        ? 'A line has to be more than nought hours.'
        : `The smallest a line can be is ${MIN_LINE_HOURS} of an hour.`,
      field: 'hours',
    };
  }
  if (hours > MAX_LINE_HOURS) {
    return { ok: false, error: `A single line cannot be more than ${MAX_LINE_HOURS} hours.`, field: 'hours' };
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
    /* Over the soft cap on this line alone, which the day total also reports.
       Neither refuses; a genuinely long day exists and a form that refuses one
       teaches somebody to log eight and go home late. */
    overLong: hours > maxHours,
    value: {
      date,
      // Null, not a made-up span. These stay filled on lines written while the
      // form asked for clock times, and empty on everything since.
      startMin: null,
      endMin: null,
      hours,
      clientId, projectId, assetId,
      nonProject,
      notes: notes || null,
    },
  };
}

/* The totals the grid shows while somebody types, worked out here so the number
   on screen and the number in the export come from one place. Hours arrive from
   MySQL as strings (DECIMAL), which is why everything is put through Number. */
function totals(entries, date, win) {
  const { maxHours } = windowOf(win);
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
    overLong: days.filter((d) => perDay[d] > maxHours),
    weekend: days.filter((d) => isWeekend(d) && perDay[d] > 0),
  };
}

/* One day's worth, which is what submission and approval now act on. Returns
   the number a person sees plus the two flags an approver needs. */
function dayTotal(entries, win) {
  const { maxHours } = windowOf(win);
  const minutes = entries.reduce((n, e) => n + (Number(e.hours) || 0) * 60, 0);
  const hours = Math.round((minutes / 60) * 100) / 100;
  return {
    hours,
    lines: entries.length,
    overLong: minutes > maxHours * 60,
    maxHours,
  };
}

module.exports = {
  WEEK_DAYS,
  NON_PROJECT,
  NON_PROJECT_KEYS,
  STATUSES,
  LOCKED,
  /* The studio's working day, which is now ONE number: how long a day is
     expected to be, used as the soft warning. The clock window and the lunch
     hour went with the clock times — see validateEntry.
     
     parseClock and clockLabel stay because lines filed before the change still
     hold their spans, and the exports still print them. Nothing writes one any
     more. */
  IST_LABEL,
  DEFAULT_WINDOW,
  windowOf,
  parseClock,
  clockLabel,
  isWeekend,
  MIN_LINE_HOURS,
  MAX_LINE_HOURS,
  parseHours,
  weekStart,
  weekDays,
  toISO,
  isLocked,
  validateEntry,
  totals,
  dayTotal,
};
