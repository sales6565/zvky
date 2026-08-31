// Idle time.
//
//   Idle = the hours a period was expected to hold, minus the hours actually
//          tracked against assets in it.
//
// Every hard part of this is in the first half of that sentence, so it is
// written down rather than left in the code.
//
// WHAT A PERIOD EXPECTS. The number of working days in the range multiplied by
// the standard day (src/work-schedule.js). Weekends are excluded because they
// are not working days; without that a week expects 56 hours and everybody
// reads as half idle, which would make the report useless on the first
// morning.
//
// WHAT IT DOES NOT KNOW. Public holidays, annual leave, sickness, and the day
// somebody joined. None of these are modelled anywhere in this app, and each of
// them makes a person look idle when they were not there to work. That is a
// real limitation, not a rounding error — a fortnight's holiday reads as 80
// hours of idleness — so `caveats` says so on the report itself rather than
// leaving a manager to draw a conclusion from a number nobody qualified.
//
// OVERTIME IS NOT NEGATIVE IDLE. Somebody who tracks 50 hours against a 40-hour
// week is not "minus 10 hours idle"; they are 0 idle and 10 over. Reporting the
// negative would let it cancel out a colleague's genuine idleness in any total,
// which is the sort of averaging that hides the thing the report exists to
// show. So idle floors at zero and the excess is carried separately.

const HOUR = 3600;

/* ISO day of week, 1 = Monday … 7 = Sunday.
 *
 * Built from the date parts rather than getDay() on a parsed timestamp, so a
 * server running in any timezone counts the same days. The report is about
 * calendar days in the studio, not instants. */
function isoDay(date) {
  const d = date.getUTCDay();          // 0 = Sunday
  return d === 0 ? 7 : d;
}

const atUTC = (ymd) => new Date(`${ymd}T00:00:00Z`);

/* Whole days from `from` to `to` inclusive that fall on a working day.
 *
 * Inclusive at both ends because a report "for the 4th of March" covers that
 * day, and a week runs Monday to Sunday. */
function workingDaysBetween(from, to, workingDays = [1, 2, 3, 4, 5]) {
  if (!from || !to) return 0;
  const start = atUTC(from);
  const end = atUTC(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const wanted = new Set(workingDays);
  let count = 0;
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (wanted.has(isoDay(cursor))) count += 1;
  }
  return count;
}

/* The four period shapes the report offers, resolved to a date range.
 *
 * `anchor` is any date inside the period. A week runs Monday to Sunday, which
 * is what "this week" means to a studio that works Monday to Friday. */
function periodRange(kind, anchor) {
  const base = atUTC(anchor);
  if (Number.isNaN(base.getTime())) return null;
  const ymd = (d) => d.toISOString().slice(0, 10);

  if (kind === 'day') return { from: ymd(base), to: ymd(base), label: ymd(base) };

  if (kind === 'week') {
    const start = new Date(base);
    start.setUTCDate(start.getUTCDate() - (isoDay(start) - 1));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { from: ymd(start), to: ymd(end), label: `Week of ${ymd(start)}` };
  }

  if (kind === 'month') {
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    return { from: ymd(start), to: ymd(end), label: ymd(start).slice(0, 7) };
  }

  if (kind === 'year') {
    const year = base.getUTCFullYear();
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
  }
  return null;
}

/* One person's idle time over a period.
 *
 * `trackedSeconds` is every second they logged against any asset in the range —
 * whole-person, deliberately. When the report is filtered to a project it uses
 * that filter to decide WHO is listed, never to shrink this number: a person
 * who worked a full day entirely on another project is not idle, and reporting
 * them as 100% idle on this one would be a confident wrong answer. */
function forUser({ trackedSeconds = 0, workingDays = 0, hoursPerDay = 8 }) {
  const expectedHours = round(workingDays * hoursPerDay);
  const trackedHours = round(Number(trackedSeconds || 0) / HOUR);
  const rawIdle = expectedHours - trackedHours;
  const idleHours = round(Math.max(0, rawIdle));
  const overtimeHours = round(Math.max(0, -rawIdle));
  return {
    expectedHours,
    trackedHours,
    idleHours,
    overtimeHours,
    // Null rather than 0 when a period expects nothing (a range of weekends):
    // "0% idle" would read as a full week's work.
    idlePercent: expectedHours > 0 ? round((idleHours / expectedHours) * 100) : null,
    // What the answer to the filtered question actually is: hours idle per day.
    idlePerDay: workingDays > 0 ? round(idleHours / workingDays) : null,
    workingDays,
  };
}

const round = (n) => Math.round(Number(n || 0) * 10) / 10;

/* How long since this person last had a timer running, in seconds.
 *
 * `lastActivity` is the most recent ended_at (or started_at for a session still
 * open) across their work. Null means they have never tracked anything, which
 * is different from having stopped a long time ago and is shown differently. */
function idleFor(lastActivity, now = new Date()) {
  if (!lastActivity) return null;
  const then = lastActivity instanceof Date ? lastActivity : new Date(lastActivity);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

/* A timer nobody stopped.
 *
 * src/work-timer.js is explicit that there is no inactivity timeout: the clock
 * runs until somebody pauses it, so closing the browser leaves it running. That
 * makes "has a running timer" a poor proxy for "is working" past a certain
 * length, and it is the same data problem the idle list exists to surface —
 * seen from the other side. Anything past this reads as forgotten rather than
 * busy, and is called out rather than silently counted as work. */
const STALE_TIMER_SECONDS = Number(process.env.IDLE_STALE_TIMER_SECONDS || 12 * HOUR);

const isStaleTimer = (runningForSeconds) =>
  Number(runningForSeconds || 0) >= STALE_TIMER_SECONDS;

/* What the report cannot see. Printed with the numbers, because a manager
   reading "62% idle" deserves to know what that does and does not account
   for. */
function caveats(schedule) {
  return [
    `A working day is ${schedule.hoursPerDay} hours, ${schedule.workingDayNames.join(', ')}.`,
    'Public holidays, annual leave and sickness are not recorded anywhere in this app, '
      + 'so time away reads as idle time.',
    'Idle is never negative: work beyond a full day is shown as overtime instead.',
  ];
}

module.exports = {
  HOUR, STALE_TIMER_SECONDS,
  isoDay, workingDaysBetween, periodRange, forUser, idleFor, isStaleTimer, caveats, round,
};
