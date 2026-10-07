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
//
// THAT INDEPENDENCE IS WORTH RESTATING, because it answers a question this file
// keeps being asked: nothing outside this module and its route reads
// timesheet_entries. Not the Efficiency report, not the Idle Report, not the
// Admin Dashboard, not either P&L tab — every one of those reads work_sessions.
// So a new non-project category cannot be "counted by one report and not
// another": the only aggregates over these hours are the day and week totals
// below, and the two exports that print them.
//
// NOT PURE ANY MORE, and the two things it now reads are in-memory mirrors
// rather than queries. The non-project category list is reference data a Super
// Admin manages (src/reference-data.js) and the policy numbers are one row
// (src/timesheet-settings.js). Both are synchronous property reads, so every
// function here is still a function of its arguments plus a studio-wide
// setting, and still testable without a server.

const referenceData = require('./reference-data');
const timesheetSettings = require('./timesheet-settings');
// For the one back-dating exemption below. Required lazily inside the check
// rather than here, because src/timesheet-gate.js requires this module's
// settings sibling and a top-level require would make the cycle plain.
const holidays = require('./holidays');

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

/* The days a week actually offers, which is not the same as the days it spans.
 *
 * The studio does not work weekends, so Saturday and Sunday are not fillable —
 * they are not shown as rows at all. weekDays() above still returns all seven,
 * because the RANGE a week's entries are read over is still Monday to Sunday
 * and its totals still have to add up whatever is in there.
 *
 * `alsoShow` is what stops the removal hiding anything. A weekend day that
 * already carries filed hours — from before this rule, or from a deployment
 * that had it switched off — is still listed, so its hours stay visible in the
 * week and in its total. It just cannot be added to. Dropping those rows from
 * the view would leave a week whose days do not sum to its own total, and
 * somebody's Saturday quietly missing from their own record.
 */
function workingDays(date, { alsoShow = [] } = {}) {
  const keep = new Set(alsoShow.map((d) => toISO(d)).filter(Boolean));
  return weekDays(date).filter((day) => !isWeekend(day) || keep.has(day));
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
 * THIS WAS A HARDCODED ARRAY, and the comment that stood here said why and what
 * the way out would be: "Fixed rather than a Settings collection: these five are
 * what every studio means by them, and a timesheet that cannot be filled in
 * until somebody configures a list is a timesheet nobody fills in. Moving them
 * into reference data later is a migration, not a redesign — the column already
 * holds a key."
 *
 * That is what has happened. timesheet_entries.non_project did already hold a
 * key, so the reference table ADOPTS the five keys rather than migrating
 * anything, and no existing line was touched. The seeded-not-empty half of that
 * reasoning still holds and is honoured: src/migrate.js seeds the list, unlike
 * the two asset/project category lists which start empty on purpose.
 *
 * FUNCTIONS, NOT CONSTANTS, and that is the load-bearing part of the change. A
 * module-level array captured at import time would go stale the moment an admin
 * added a category — which is exactly the bug src/reference-data.js exists to
 * prevent and which its own comment on roles warns about ("re-exported as
 * functions rather than arrays: a value captured at import time would go stale
 * the moment one is added"). Both of these read the in-memory mirror, which is a
 * synchronous property read, so validateEntry stays a pure function of its
 * arguments plus that mirror.
 *
 * INACTIVE CATEGORIES ARE STILL VALID TO *VIEW*, AND NOT TO *FILE*. nonProject()
 * is what the form's dropdown is built from and what a new line is checked
 * against — deactivating Training stops new Training lines. labelFor() reads the
 * whole list including inactive ones, so the forty-eight Training lines already
 * filed keep saying Training rather than falling back to their raw key. Those
 * are two different questions and they are answered by two different functions
 * on purpose.
 */
/* THE SHIPPED LIST WHEN THE MIRROR HAS NOTHING, which is a real fallback and
 * not belt-and-braces. An empty cache would make nonProjectKeys() empty, and an
 * empty allow-list refuses EVERY non-project line with "that is not a
 * category" — so a request arriving before the mirror loaded, or on a
 * deployment whose reference table could not be read, would reject leave and
 * training alike while the dropdown sat empty beside it.
 *
 * The same reasoning src/work-log.js gives for its own schedule fallback:
 * "before the schedule has been loaded... this hands back the defaults, which
 * are the studio's real answer. So the worst case is the right window rather
 * than no window." Here the worst case is the six the migration seeds rather
 * than none of them.
 *
 * NO ROWS is the only case this covers. A studio that has genuinely retired
 * five of the six has one row, which is not empty, and is honoured. */
const seededCategories = () => require('./reference-defaults').TIMESHEET_CATEGORIES
  .map((c) => ({ key: c.key, label: c.label, color: c.color || null }));

const nonProject = () => {
  const held = referenceData.list('timesheet_categories');
  if (!held.length && !referenceData.list('timesheet_categories', { includeInactive: true }).length) {
    return seededCategories();
  }
  return held.map((e) => ({ key: e.key, label: e.label, color: e.color || null }));
};
const nonProjectKeys = () => nonProject().map((n) => n.key);

/* The label to SHOW for a key, including categories that have been retired.
 * Falls back to the key itself, which is what a line filed against a category
 * somebody later deleted outright would otherwise render as nothing. */
const nonProjectLabel = (key) => {
  if (!key) return '';
  const all = referenceData.list('timesheet_categories', { includeInactive: true });
  const found = (all.length ? all : seededCategories()).find((e) => e.key === key);
  return found ? found.label : key;
};

/* THE ONE KEY THE CODE KNOWS BY NAME, and the only one.
 *
 * The week's totals split idle time out from project work and from other
 * non-project time, so this string appears in arithmetic rather than only in a
 * dropdown. That is exactly why its reference row is is_system: it can be
 * RENAMED — a studio calling it "Bench time" changes the label and nothing here
 * notices — but it cannot be deactivated or deleted, because the split would
 * then read nought while the hours were still being logged.
 *
 * Nothing else in this file compares non_project to a literal. If a second one
 * is ever needed, it goes here beside this and its row gets is_system too. */
const IDLE = 'idle';

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

/* DAY_WARN_HOURS = 24 was declared here and read by nothing — not by this
   module, not by its route, not by the page, and not exported. A constant
   nothing reads is a claim that something still works this way, so it is gone
   rather than left to be found again. What actually warns about a long day is
   maxDayHours, the studio's soft cap, which the day total flags against. */

/* The smallest and largest a line can be, and the soft day cap, ARE SETTINGS NOW.
 *
 * They were the constants MIN_LINE_HOURS = 0.25 and MAX_LINE_HOURS = 24 here,
 * and TIMESHEET_MAX_HOURS = 8 in src/work-schedule.js. The reasoning that chose
 * those numbers still stands and has moved to src/timesheet-settings.js with
 * them, as the defaults: a quarter of an hour is the finest grain anybody fills
 * a timesheet in at, a line of nought hours is a line saying nobody worked, and
 * twenty-four is the ceiling on ONE line while the day's soft warning is a
 * separate and much lower number.
 *
 * What changed is who decides. They are read through timesheetSettings.current()
 * at the moment they are needed rather than captured here, for the same reason
 * the category list is a function: a Super Admin can change them while the
 * server is up, and a line filed after that must be judged by the setting in
 * force when it was filed. */

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
/* WHICH DAYS A LINE MAY BE FILED ON, and this was Saturday and Sunday, fixed.
 *
 * It read `isWeekend(date)` — a function of the date alone — while Settings ->
 * Working Hours has had a configurable set of working days all along. A studio
 * that works Saturdays could configure one and then not be able to log it. That
 * inconsistency is now a setting rather than a surprise: loggableDays defaults
 * to Monday-to-Friday, which is exactly what this refused before, and an admin
 * can widen it.
 *
 * DELIBERATELY ITS OWN SETTING rather than wired to workingDays. Two reasons,
 * both load-bearing. workingDays drives the Idle Report's expected hours, so
 * coupling them would mean widening the timesheet silently changed every
 * utilisation figure in the studio. And they are two questions — which days the
 * studio RECORDS time on, and which days a person may FILE hours for — that
 * happen to coincide today.
 *
 * Checked in validateEntry rather than at the route, so the API and the form
 * give the same answer and a client that has not been updated cannot put a row
 * somewhere the screen will not show it. */
const isoDayOf = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
};

/* Today, on the studio's wall calendar — for the back-dating window.
 *
 * IST, like every other date question in this application, and for the reason
 * src/working-time.js gives: a timesheet date is a day in one office, and a
 * server in UTC must not decide that yesterday is still today for five and a
 * half hours. Taken from the same offset rather than a second copy of it. */
const studioToday = (at = Date.now()) => {
  const shifted = new Date(at + (5 * 60 + 30) * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};

// Whole days between two 'YYYY-MM-DD' dates. Positive when `then` is earlier.
const daysBefore = (then, today) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${then}T00:00:00Z`)) / 86400000);

function validateEntry(raw = {}, win, { now = Date.now() } = {}) {
  const { maxHours } = windowOf(win);
  const policy = timesheetSettings.current();
  const date = toISO(raw.date);
  if (!date) return { ok: false, error: 'That is not a date.', field: 'date' };

  if (!policy.loggableDays.includes(isoDayOf(date))) {
    return {
      ok: false,
      field: 'date',
      error: `The studio logs hours on ${policy.loggableDays.length === 7 ? 'every day'
        : policy.loggableDayNames.join(', ')}, so nothing can be logged on a `
        + `${timesheetSettings.DAY_NAMES[isoDayOf(date)]}.`,
    };
  }

  /* THE TWO WINDOWS, AND WHAT THEY DO NOT TOUCH.
   *
   * Both default to no limit, which is what this application did before they
   * existed, so a deployment that never visits Settings behaves identically.
   *
   * EXISTING LINES ARE NEVER RE-JUDGED. A studio that tightens back-dating to
   * seven days does not invalidate the line somebody filed three weeks ago: the
   * rule is checked when a line is created or edited, and nothing walks the
   * table looking for lines that would now be refused. That is the only
   * defensible reading — a rule applied backwards would make a submitted week
   * unopenable and a figure already reported unexplainable — and it is the one
   * the Settings screen states in as many words. */
  const today = studioToday(now);
  if (policy.backdateDays !== null) {
    const behind = daysBefore(date, today);
    /* THE ONE DAY THE WINDOW DOES NOT CLOSE ON, while the previous-day rule is
     * switched on.
     *
     * THE CONFLICT THIS RESOLVES, which the two settings create between them:
     * the rule refuses to let somebody start work until they have filled the
     * previous working day, and backdateDays could put that very day out of
     * reach. A window of 1 and a Monday morning is the plain case — Friday is
     * three days back — and the result would be a person told to fill a day the
     * form then refuses, with no way out of either. A rule that demands the
     * impossible is worse than no rule.
     *
     * So the gate's own day is always fillable. Exactly that day, and only
     * while the rule is on: every other date keeps the window the studio set.
     * src/timesheet-gate.js decides which day it is, so there is one answer and
     * it cannot drift from the one the refusal names. */
    const gate = require('./timesheet-gate');
    const owed = gate.exemptBackdate(policy)
      ? gate.previousWorkingDay(today, {
        loggableDays: policy.loggableDays,
        isHoliday: (d) => Boolean(holidays.on(d)),
      })
      : null;
    if (behind > policy.backdateDays && date !== owed) {
      return {
        ok: false,
        field: 'date',
        error: `${date} is ${behind} days ago, and the studio allows lines to be filed up to `
          + `${policy.backdateDays} day${policy.backdateDays === 1 ? '' : 's'} back. `
          + 'Lines filed before this rule was set are unaffected.',
      };
    }
  }
  if (policy.futureDays !== null) {
    const ahead = -daysBefore(date, today);
    if (ahead > policy.futureDays) {
      return {
        ok: false,
        field: 'date',
        error: policy.futureDays === 0
          ? `${date} is in the future, and the studio does not allow hours to be logged ahead of today.`
          : `${date} is ${ahead} days ahead, and the studio allows lines up to `
            + `${policy.futureDays} day${policy.futureDays === 1 ? '' : 's'} ahead.`,
      };
    }
  }

  const hours = parseHours(raw.hours);
  if (hours === null) {
    return { ok: false, error: 'Say how many hours, as 3 or 3.5.', field: 'hours' };
  }
  if (hours < policy.minLineHours) {
    return {
      ok: false,
      error: hours <= 0
        ? 'A line has to be more than nought hours.'
        : `The smallest a line can be is ${policy.minLineHours} of an hour.`,
      field: 'hours',
    };
  }
  if (hours > policy.maxLineHours) {
    return { ok: false, error: `A single line cannot be more than ${policy.maxLineHours} hours.`, field: 'hours' };
  }

  const nonProject = raw.nonProject ? String(raw.nonProject).trim() : null;
  const projectId = raw.projectId || null;
  const clientId = raw.clientId || null;
  const assetId = raw.assetId || null;

  if (nonProject) {
    /* ACTIVE categories only, which is what makes deactivating one mean
       something: Training disappears from the dropdown AND is refused on a new
       line. An old line already holding it keeps rendering, because the label
       lookup reads the whole list — see nonProjectLabel. */
    const allowed = nonProjectKeys();
    if (!allowed.includes(nonProject)) {
      /* Named differently when the category EXISTS but has been retired, because
         "that is not a category" is a confusing thing to read about a word that
         is on screen in last week's rows. */
      const retired = referenceData.list('timesheet_categories', { includeInactive: true })
        .find((e) => e.key === nonProject);
      return {
        ok: false,
        field: 'nonProject',
        error: retired
          ? `"${retired.label}" is no longer one of the studio's categories. Existing lines keep it; new ones cannot use it.`
          : 'That is not a category.',
        allowed,
      };
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

  /* The dispute path for a figure nobody can edit.
   *
   * A flag with no reason is a flag nobody can act on, so the reason is
   * required when the flag is set — and setting the reason is what sets the
   * flag, so the two cannot disagree. */
  const flagNote = String(raw.flagNote ?? '').trim().slice(0, 500);
  if (raw.flagged && !flagNote) {
    return { ok: false, error: 'Say briefly what looks wrong with the figure.', field: 'flagNote' };
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
      flagNote: flagNote || null,
      nonProject,
      notes: notes || null,
    },
  };
}

/* WHAT KIND OF TIME A LINE IS, in one place.
 *
 * Three answers, not two, and the third is the whole of the Idle decision:
 *
 *   project   a line against a client, project or asset. Work on the studio's
 *             own output.
 *   nonProject  leave, a holiday, a meeting, training, admin — recorded time
 *             that is not project work but is not idleness either. Somebody was
 *             doing something.
 *   idle      nobody had anything to give them. Recorded, and counted in the
 *             hours logged, because the day really was eight hours long and a
 *             timesheet that hid them would make the week not add up. But it is
 *             not work, and a figure that folded it in with training would say
 *             the studio was busier than it was.
 *
 * IT COUNTS TOWARD HOURS LOGGED AND IS SHOWN SEPARATELY. That is the whole
 * treatment, and it is the whole treatment available: nothing outside this
 * module reads timesheet_entries, so there is no productive-versus-billable
 * figure elsewhere for Idle to be excluded from. Saying it is "excluded from
 * utilisation" would be describing an exclusion from a calculation that does not
 * exist. The Idle Report and the Admin Dashboard's utilisation are built from
 * work_sessions, and an idle hour produces no session — which is why they
 * already read it as idle, by its absence, and why none of them changed.
 *
 * KEYED ON 'idle', NEVER ON THE LABEL. A studio renaming it to "Bench time"
 * changes what the dropdown says and nothing here. */
const kindOf = (entry) => {
  const key = entry.nonProject || entry.non_project || null;
  if (!key) return 'project';
  return key === IDLE ? 'idle' : 'nonProject';
};

/* The same split, as three sums. Used by the week totals and by the day total,
   so a figure on the grid and the same figure in the export cannot disagree. */
function splitHours(entries) {
  const out = { project: 0, nonProject: 0, idle: 0 };
  for (const entry of entries) out[kindOf(entry)] += Number(entry.hours) || 0;
  const round = (n) => Math.round(n * 100) / 100;
  return { project: round(out.project), nonProject: round(out.nonProject), idle: round(out.idle) };
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
    /* Days the studio does not log hours on that nevertheless have some. Read
       from the setting rather than from isWeekend, so a studio that logs
       Saturdays does not have every Saturday flagged for review. */
    weekend: days.filter((d) => !timesheetSettings.current().loggableDays.includes(isoDayOf(d))
      && perDay[d] > 0),
    /* THE SPLIT, over the whole week. This is where Idle becomes visible to a
       manager: the week's hours, and how many of them were nobody's project,
       nobody's meeting and nobody's training. */
    ...splitHours(entries),
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
    // The same three sums the week carries, so a day row and the week footer
    // read the same arithmetic.
    ...splitHours(entries),
  };
}

/* How many hours this person has already filed against one asset, ever.
 *
 * The other half of the Hours figure: recorded time minus this, clamped at
 * zero, is what has not been written down yet. Counted across EVERY day rather
 * than the one being filled in, which is the whole point — an asset worked on
 * over three days offers its first day's hours, then only what accrued since,
 * then only what accrued after that. The three add up to the recorded total
 * instead of to three times it.
 *
 * Drafts count as well as submitted days. A line somebody has filed but not
 * yet submitted is still hours they have claimed; leaving it out would offer
 * them the same hours twice on the same afternoon.
 *
 * `exceptId` takes a line out of the sum — the one being edited. Without it,
 * re-opening a 3-hour line would subtract its own 3 hours from what is left
 * and offer 3 fewer than it should.
 */
async function hoursLoggedOn(db, { assetId, userId, exceptId = null }) {
  if (!assetId || !userId) return 0;
  const params = [userId, assetId];
  let where = 'user_id = $1 AND asset_id = $2';
  if (exceptId) { where += ' AND id <> $3'; params.push(exceptId); }
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(hours), 0) AS hours FROM timesheet_entries WHERE ${where}`,
    params
  ).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) {
      return { rows: [{ hours: 0 }] };
    }
    throw err;
  });
  return Math.round((Number(rows[0].hours) || 0) * 100) / 100;
}

/* IS THERE ANY LINE AT ALL ON THIS DAY — the whole of "filled" for the
 * previous-working-day rule in src/timesheet-gate.js.
 *
 * IT LIVES HERE BECAUSE THE TABLE DOES. Nothing outside this module and its
 * route reads timesheet_entries, and tests/timesheet-options.test.js enforces
 * that so a new reader of these hours has to decide what Idle means to it
 * before shipping. This is that decision, written where somebody will find it:
 * EVERY LINE COUNTS, Idle included. Idle is the honest answer for a day with
 * nothing to report, and a rule that refused it would be a rule nobody could
 * comply with on a quiet day — they would invent a line instead, which is worse
 * for the figures than the truth.
 *
 * COUNT OF LINES, NOT SUM OF HOURS, and not a category filter: the gate asks
 * whether the day was filled in, not whether it was filled in acceptably. The
 * soft cap is the form's business.
 *
 * DRAFTS COUNT, which is not a choice this function makes but a fact about the
 * schema: draft-versus-submitted lives on timesheet_days.status and the lines
 * carry no status of their own. Submitting LOCKS them, so reading "filled" as
 * "submitted" would mean the only way to satisfy the rule was also the way to
 * stop correcting it.
 *
 * MISSING TABLE READS AS "CANNOT TELL", not as "empty" — the distinction the
 * gate needs to fail open. hoursLoggedOn() above swallows ER_NO_SUCH_TABLE and
 * answers 0 because a missing table genuinely means no hours were offered; here
 * 0 would mean "block them", so the error is left to reach the caller. */
async function hasLineOn(db, userId, date) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2',
    [userId, date]
  );
  return Number(rows[0].n) > 0;
}

module.exports = {
  WEEK_DAYS,
  /* Functions, not arrays. See the note on nonProject(): a value captured at
     import time goes stale the moment an admin adds a category. */
  nonProject,
  nonProjectKeys,
  nonProjectLabel,
  IDLE,
  kindOf,
  splitHours,
  isoDayOf,
  studioToday,
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
  /* The policy numbers moved to src/timesheet-settings.js. Re-exported as
     getters so the handful of callers that quote them in a message read the
     studio's setting rather than a constant this module no longer owns. */
  get MIN_LINE_HOURS() { return timesheetSettings.current().minLineHours; },
  get MAX_LINE_HOURS() { return timesheetSettings.current().maxLineHours; },
  /* WEEKEND_REFUSAL was exported here and read by nothing — not the route, not
     the page, not a test. It was one hardcoded sentence about Saturday and
     Sunday, and which days may be logged is a setting now, so the sentence is
     built from that setting inside validateEntry rather than being a constant
     somebody could quote without it. */
  parseHours,
  weekStart,
  weekDays,
  workingDays,
  toISO,
  isLocked,
  validateEntry,
  totals,
  dayTotal,
  hoursLoggedOn,
  hasLineOn,
};
