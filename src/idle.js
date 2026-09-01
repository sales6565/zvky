// Idle time.
//
//   Idle = the working hours in a period during which somebody had nothing in
//          progress.
//
// Every hard part of this is in that sentence, so it is written down rather
// than left in the code.
//
// WHY IT IS NOT "EXPECTED HOURS MINUS TIME SPENT". That is what it used to be,
// and it stopped being arithmetic the moment Time Spent became wall-clock. Time
// Spent is now the span from Accept and Start to Submit for Review — see
// src/work-log.js — and two facts follow that summing it cannot survive:
//
//   Spans overlap. Nothing stops one person holding three assets open at once,
//   and each of them counts the same afternoon. Somebody with two assets open
//   Monday to Friday "spent" 208 hours in a 40-hour week. Subtracting that
//   gives 0 idle and 168 hours of overtime, for one ordinary week's work.
//
//   Spans cover nights and weekends. Work started on Friday afternoon and
//   handed in on Monday morning is one span of 64 hours, almost none of them
//   working hours.
//
// So the sum is not a quantity of work at all. This measures COVERAGE instead:
// take the union of somebody's [started, submitted] spans, intersect it with
// the period's working days, and idle is whatever working time is left over.
// The union is what stops concurrent assets counting twice; the intersection is
// what stops a weekend counting at all.
//
// WHAT A PERIOD EXPECTS. The number of working days in the range multiplied by
// the standard day (src/work-schedule.js). Weekends are excluded because they
// are not working days; without that a week expects 56 hours and everybody
// reads as half idle, which would make the report useless on the first
// morning.
//
// WHERE THE WORKING HOURS SIT IN THE DAY. Nowhere: this app has no shift model
// and no start-of-day time, only a length. So a day's coverage is measured
// against the whole calendar day and then CAPPED at the standard day — somebody
// who had something in progress from 07:00 to 19:00 on a Tuesday is credited
// with a full eight-hour day, not twelve. It is the honest reading of what is
// actually recorded, and it is stated on the report.
//
// WHAT IT DOES NOT KNOW. Public holidays, annual leave, sickness, and the day
// somebody joined. None of these are modelled anywhere in this app, and each of
// them makes a person look idle when they were not there to work. That is a
// real limitation, not a rounding error — a fortnight's holiday reads as 80
// hours of idleness — so `caveats` says so on the report itself rather than
// leaving a manager to draw a conclusion from a number nobody qualified.
//
// AND IT DOES NOT KNOW WHETHER SOMEBODY WAS ACTUALLY AT THE DESK. An asset left
// open overnight covers the night; an asset handed in at lunchtime and not
// replaced leaves the afternoon idle even if the person spent it on something
// this app never sees. Coverage is a measure of what work was open, not of
// effort. That is the whole trade the studio accepted when the running timer
// was removed, and the report says so rather than implying a precision it does
// not have.
//
// THERE IS NO OVERTIME COLUMN ANY MORE, AND THAT IS DELIBERATE. The old report
// had one, as the mirror of idle: track 50 hours against a 40-hour week and you
// were 0 idle and 10 over. Coverage cannot produce that number honestly.
//
//   Idle can no longer go negative at all. A working day's coverage is capped
//   at the standard day, so engaged never exceeds expected and the mirror
//   quantity is always zero on a working day.
//
//   And a span across a rest day says nothing about hours. Work started on
//   Friday afternoon and handed in on Monday morning covers all of Saturday
//   and all of Sunday. Reporting that as 48 hours of overtime would accuse
//   somebody of working a weekend they spent at home, every weekend, for every
//   asset not handed in by Friday. It is not a rounding error, it is a
//   fabrication, and it would appear on more rows than not.
//
// What CAN be said truthfully is that work was open across a rest day — so that
// is what the row carries: `restDaysCovered`, a count of days, not a quantity
// of hours. A manager who sees it can go and ask; a manager shown "48h
// overtime" would have been told something nobody knows.

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

/* The union of a set of spans, in milliseconds.
 *
 * The single most important function in this file. Without it, a person holding
 * three assets open through the same afternoon is credited with three
 * afternoons — and under wall-clock timing that is not a rare edge case, it is
 * what a busy week looks like.
 *
 * Spans are half-open [start, end): an asset submitted at exactly 14:00 and
 * another started at 14:00 are one continuous stretch, not two with a
 * zero-length hole, and neither is double-counted at the join. */
function mergeSpans(spans) {
  const clean = (spans || [])
    .map(([a, b]) => [Number(a), Number(b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [start, end] of clean) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/* How much of a period somebody had something in progress for, in seconds.
 *
 * Day by day, because the two rules that make this honest are both per-day:
 * a non-working day contributes nothing at all, and a working day contributes
 * at most one standard day however long the span ran.
 *
 * Rest days are counted rather than measured. See the note at the top of this
 * file: an open span tells you work was on somebody's desk across a Saturday,
 * and nothing whatever about whether they touched it. */
function coverage(spans, { from, to, workingDays = [1, 2, 3, 4, 5], hoursPerDay = 8 }) {
  const merged = mergeSpans(spans);
  const start = atUTC(from);
  const end = atUTC(to);
  if (!merged.length || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return { workingDaySeconds: 0, restDaysCovered: 0 };
  }
  const wanted = new Set(workingDays);
  const capMs = Math.max(0, hoursPerDay) * HOUR * 1000;

  let workingDayMs = 0;
  let restDaysCovered = 0;
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dayStart = cursor.getTime();
    const dayEnd = dayStart + DAY_MS;
    let inDay = 0;
    for (const [a, b] of merged) {
      if (b <= dayStart) continue;
      if (a >= dayEnd) break;                 // merged is sorted, so nothing later overlaps
      inDay += Math.min(b, dayEnd) - Math.max(a, dayStart);
    }
    if (wanted.has(isoDay(cursor))) workingDayMs += Math.min(inDay, capMs);
    else if (inDay > 0) restDaysCovered += 1;
  }
  return { workingDaySeconds: Math.round(workingDayMs / 1000), restDaysCovered };
}

/* One person's idle time over a period.
 *
 * `spans` is every stretch they had something in progress, from any asset in
 * the range — whole-person, deliberately. When the report is filtered to a
 * project it uses that filter to decide WHO is listed, never to shrink this
 * number: a person who worked a full day entirely on another project is not
 * idle, and reporting them as 100% idle on this one would be a confident wrong
 * answer. */
function forUser({ spans = [], from, to, workingDays = [1, 2, 3, 4, 5], hoursPerDay = 8 }) {
  const days = workingDaysBetween(from, to, workingDays);
  const expectedHours = round(days * hoursPerDay);
  const covered = coverage(spans, { from, to, workingDays, hoursPerDay });

  /* Engaged is what counts against the working day. A rest day is counted, not
     measured — see the note at the top of this file. */
  const engagedHours = round(covered.workingDaySeconds / HOUR);
  const idleHours = round(Math.max(0, expectedHours - engagedHours));
  return {
    expectedHours,
    engagedHours,
    idleHours,
    restDaysCovered: covered.restDaysCovered,
    // Null rather than 0 when a period expects nothing (a range of weekends):
    // "0% idle" would read as a full week's work.
    idlePercent: expectedHours > 0 ? round((idleHours / expectedHours) * 100) : null,
    // What the answer to the filtered question actually is: hours idle per day.
    idlePerDay: days > 0 ? round(idleHours / days) : null,
    workingDays: days,
  };
}

const round = (n) => Math.round(Number(n || 0) * 10) / 10;

/* How long since this person last had anything in progress, in seconds.
 *
 * `lastActivity` is the most recent submit stamp (or start stamp for a stretch
 * still open) across their work. Null means they have never started anything,
 * which is different from having finished a long time ago and is shown
 * differently.
 *
 * There is deliberately no "stale" flag here any more. It used to warn about a
 * timer left running overnight, on the reasoning that nobody works for fifteen
 * hours straight — but with the running timer gone, a stretch open for three
 * days is what work left on somebody's desk over a weekend now looks like. It
 * is the ordinary case, not an anomaly, and flagging it would train people to
 * ignore the flag. The per-day cap in coverage() is what stops a long span
 * inflating anybody's hours, which is what the warning was really for. */
function idleFor(lastActivity, now = new Date()) {
  if (!lastActivity) return null;
  const then = lastActivity instanceof Date ? lastActivity : new Date(lastActivity);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

/* What the report cannot see. Printed with the numbers, because a manager
   reading "62% idle" deserves to know what that does and does not account
   for. */
function caveats(schedule) {
  return [
    `A working day is ${schedule.hoursPerDay} hours, ${schedule.workingDayNames.join(', ')}.`,
    'Idle means no asset was in progress — between Accept and Start and Submit for Review. '
      + 'It measures what work was open, not whether somebody was at their desk.',
    `A day counts at most ${schedule.hoursPerDay} hours however long work was left open across it, `
      + 'because this app records no shift times — only the length of a standard day.',
    'Work open across two assets at once counts once, not twice.',
    'Public holidays, annual leave and sickness are not recorded anywhere in this app, '
      + 'so time away reads as idle time.',
    'Work open across a rest day is counted as a day, not as hours: an asset left open '
      + 'over a weekend cannot be told apart from one worked over it, so no overtime is claimed.',
  ];
}

module.exports = {
  HOUR,
  isoDay, workingDaysBetween, periodRange, mergeSpans, coverage, forUser, idleFor, caveats, round,
};
