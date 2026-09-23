/* What part of a stretch of time the studio was actually open.
 *
 * WHY THIS EXISTS. A work session recorded the raw wall-clock span between
 * Accept and Start and Submit for Review. Start something at five to seven on a
 * Friday, submit it on Monday morning, and the asset had cost sixty-three
 * hours — most of them a weekend nobody worked. That number is not a rounding
 * error in one report: work_sessions.seconds is the single column behind Time
 * Spent, the Efficiency report, the Time Sheet's suggested hours and the Fixed
 * and Actual P&L, so one wrong span is wrong in five places at once and in the
 * same direction, always upwards.
 *
 * So this module answers one question — given two instants, how many seconds of
 * them fall inside the studio's working window — and everything that records or
 * reads elapsed time asks it rather than subtracting two timestamps.
 *
 * IT IS IST, AND IT IS IST EVERYWHERE. The window is a wall clock in one
 * office: half past nine to seven, Monday to Friday. Neither the server's
 * timezone nor the browser's has any bearing on whether the studio was open, so
 * neither appears here. Every function takes an instant — milliseconds since
 * the epoch, which is the same number on every machine on earth — and converts
 * it to the Indian wall clock itself, with a fixed offset. India has never
 * observed daylight saving, so that offset is a constant rather than a lookup;
 * src/asset-schedule.js and src/timesheets.js already rest on the same fact.
 *
 * NO DATABASE, NO CLOCK, NO STATE. Every function is pure and takes both the
 * instants and the schedule as arguments. That is what lets the whole of this —
 * every boundary, every weekend, every break — be tested against hand-worked
 * numbers without a server, and it is why the awkward cases below are cheap
 * enough to have tests at all.
 *
 * WHAT IT DELIBERATELY DOES NOT KNOW. Holidays. A studio closed for Diwali
 * still counts Diwali as a working day here, because nothing in the application
 * records a holiday calendar and inventing one silently would be worse than the
 * gap. Working days are configurable, so a closure can be handled by editing
 * the schedule for that week, and the limitation is written down rather than
 * discovered.
 */

/* India, once, as a number. Not a timezone database lookup: there is exactly
   one offset in the country's history and this is it. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MS_PER_MINUTE;

/* An instant, as the Indian wall clock reads it.
 *
 * `day` is a day number rather than a date: whole days since the epoch, counted
 * in IST. Nothing here ever needs to know that day 20718 is a Monday in
 * September — it needs to know which day two instants share and which day comes
 * next, and integers answer both without a Date object and without a calendar.
 *
 * `dow` is ISO: 1 = Monday … 7 = Sunday, matching work_schedule.workingDays.
 * Day 0 of the epoch — 1 January 1970 — was a Thursday, which is ISO 4, so the
 * +3 below is that anchor and not an arbitrary shift.
 */
function istPartsOf(ms) {
  const shifted = ms + IST_OFFSET_MS;
  const day = Math.floor(shifted / MS_PER_DAY);
  return {
    day,
    // Minutes past midnight IST, as a fraction — a session does not start on a
    // minute boundary and rounding here would leak seconds into or out of the
    // window at every edge.
    minute: (shifted - day * MS_PER_DAY) / MS_PER_MINUTE,
    dow: dowOf(day),
  };
}

/* The ISO weekday of a day number, on its own — the walks below hold a day
   number and need its weekday without building an instant to ask. */
function dowOf(day) {
  return ((day % 7) + 7 + 3) % 7 + 1;
}

// The instant at which a given IST day reaches a given minute past midnight.
// The inverse of istPartsOf, and the only other place the offset appears.
const instantAt = (day, minute) => day * MS_PER_DAY + minute * MS_PER_MINUTE - IST_OFFSET_MS;

const isWorkingDay = (dow, schedule) => (schedule.workingDays || []).includes(dow);

/* The minutes of a working day that actually count, as [from, to) pairs.
 *
 * The configured day with the configured breaks cut out of it. Breaks are
 * already validated in src/work-schedule.js as sitting inside the day and not
 * overlapping each other, so this walks them in order and takes what is left
 * rather than re-checking any of that — one definition of a valid break, in the
 * module that owns the setting.
 *
 * A studio with no breaks configured gets the single span, which is what the
 * setting's nulls have always meant.
 */
function openSpans(schedule) {
  const dayStart = Number(schedule.dayStart);
  const dayEnd = Number(schedule.dayEnd);
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || dayEnd <= dayStart) return [];

  const spans = [];
  let from = dayStart;
  for (const b of (schedule.breaks || []).slice().sort((x, y) => x.start - y.start)) {
    const start = Math.max(dayStart, Math.min(dayEnd, Number(b.start)));
    const end = Math.max(dayStart, Math.min(dayEnd, Number(b.end)));
    if (!(end > start)) continue;
    if (start > from) spans.push([from, start]);
    from = Math.max(from, end);
  }
  if (dayEnd > from) spans.push([from, dayEnd]);
  return spans;
}

/* ---------------------------------------------------------------------------
 * NAMED WINDOWS, THE SUPER ADMIN'S VERSION OF ALL OF THE ABOVE.
 *
 * openSpans answers one shape of question: ONE recording window with a handful
 * of breaks cut out of it, the same on every working day. That is the studio's
 * schedule and it was enough while the schedule was a fixed form with four time
 * pairs on it.
 *
 * It is no longer the only shape. A Super Admin can now name any number of
 * windows in either list — Recording Hours and Non-Recording Hours — each with
 * its own days of the week, so Saturday can be a half day, a night shift can
 * run 22:00 to 06:00, and "Lunch block" can apply on weekdays and not at the
 * weekend. None of that fits a single [dayStart, dayEnd] with a break list.
 *
 * So when a schedule carries `entries`, THOSE are the schedule and the four
 * time pairs are ignored. The arithmetic is the same either way and deliberately
 * so: a day is a union of recording intervals with the union of non-recording
 * intervals taken out of it. The old form is exactly the special case of one
 * recording interval and three cuts, which is why nothing downstream of
 * spansOn() had to change — isRecording, stopsAt, startsAt, resumesAt and
 * lastStoppedAt all ask spansOn and none of them knows which form produced the
 * answer.
 * ------------------------------------------------------------------------- */

const MINUTES_PER_DAY = 24 * 60;

/* Does this entry apply on this weekday? An empty or absent day list means
   every day, which is the default the table stores and the API's documented
   meaning of leaving days_of_week off. */
function appliesOn(entry, dow) {
  const days = entry.daysOfWeek;
  if (!Array.isArray(days) || !days.length) return true;
  return days.includes(dow);
}

/* Overlapping intervals flattened into a sorted, disjoint list.
 *
 * Two recording windows that overlap are ONE stretch of recording, not two —
 * which matters because every caller above walks the result expecting the spans
 * not to touch: two overlapping spans would otherwise let lastStoppedAt hand
 * back a boundary in the middle of a stretch that is still running. */
function merge(intervals) {
  const sorted = intervals
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/* `spans` with `cuts` taken out of them. Both are expected disjoint and sorted,
   which merge() above guarantees for each list separately. */
function subtract(spans, cuts) {
  let out = spans;
  for (const [cutFrom, cutTo] of cuts) {
    const next = [];
    for (const [from, to] of out) {
      if (cutTo <= from || cutFrom >= to) { next.push([from, to]); continue; }
      if (cutFrom > from) next.push([from, cutFrom]);
      if (cutTo < to) next.push([cutTo, to]);
    }
    out = next;
  }
  return out;
}

/* Every interval of one named list that lands on this day, in minutes past
 * midnight of THIS day.
 *
 * A window that spans midnight contributes to two days: the tail of the day it
 * starts on, and the head of the day after. Its days_of_week is read as the day
 * it STARTS on — "Monday 22:00–06:00" is Monday night, running into Tuesday
 * morning — because that is how a person naming a night shift means it, and the
 * alternative (the day it ends on) would make a Monday-only night shift record
 * nothing on Monday.
 */
function intervalsFor(entries, day, type) {
  const dow = dowOf(day);
  const dowBefore = dowOf(day - 1);
  const out = [];
  for (const entry of entries) {
    if (!entry || entry.type !== type || entry.enabled === false) continue;
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (entry.spansMidnight) {
      // The evening half, on its own day; and the morning half, on the next.
      if (start < MINUTES_PER_DAY && appliesOn(entry, dow)) out.push([start, MINUTES_PER_DAY]);
      if (end > 0 && appliesOn(entry, dowBefore)) out.push([0, end]);
    } else if (appliesOn(entry, dow)) {
      out.push([start, end]);
    }
  }
  return merge(out);
}

/* One day's recordable spans, from the named windows. */
function spansFromEntries(day, entries) {
  return subtract(
    intervalsFor(entries, day, 'recording'),
    intervalsFor(entries, day, 'non_recording')
  );
}

/* How many minutes of a full working day are workable.
 *
 * With named windows a day is not one length any more — a studio can record
 * eight hours on a weekday and four on a Saturday — so this answers for the
 * LONGEST day the week contains, which is the reading "a full working day" has
 * always had here. Callers wanting a particular day pass its day number. */
function workableMinutesPerDay(schedule, day = null) {
  const total = (spans) => spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (!Array.isArray(schedule.entries)) return total(openSpans(schedule));
  if (day !== null) return total(spansOn(day, schedule));
  let most = 0;
  // Any seven consecutive days are one of each weekday; 0 to 6 will do.
  for (let d = 0; d < 7; d += 1) most = Math.max(most, total(spansFromEntries(d, schedule.entries)));
  return most;
}

/* A sanity bound on the walk below.
 *
 * Under the auto-pause rule no live session survives past the end of its own
 * day, so the loop runs once or twice in practice. It is bounded anyway because
 * this also runs over historical rows, and one corrupt started_at — a stamp
 * from 1970, which is what a zeroed DATETIME parses as — would otherwise spin
 * through nineteen thousand iterations on a page load. Ten years of days is far
 * past any real session and far short of anything a person would notice. */
const MAX_DAYS_WALKED = 3660;

/* THE FUNCTION EVERYTHING ELSE IS FOR: seconds of [startMs, endMs) that fall
 * inside the studio's open hours.
 *
 * Walks the IST days the span touches and adds up the overlap with each day's
 * open spans. Days the studio is shut contribute nothing, which is how a
 * weekend, an overnight and a lunch hour all come out right without any of them
 * being a special case in here.
 *
 * Returns whole seconds, rounded, because that is what work_sessions.seconds
 * holds and a fraction of a second stored there would only ever be noise.
 */
function workingSecondsBetween(startMs, endMs, schedule) {
  const from = Number(startMs);
  const to = Number(endMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;

  /* Asked per day rather than once, because with named windows a Saturday and a
     Tuesday do not have the same spans. For the legacy shape spansOn returns the
     same list every working day, so this is the same walk it always was. */
  const first = istPartsOf(from).day;
  const last = istPartsOf(to).day;
  let ms = 0;
  for (let day = first; day <= last && day - first <= MAX_DAYS_WALKED; day += 1) {
    for (const [a, b] of spansOn(day, schedule)) {
      const openFrom = Math.max(from, instantAt(day, a));
      const openTo = Math.min(to, instantAt(day, b));
      if (openTo > openFrom) ms += openTo - openFrom;
    }
  }
  return Math.round(ms / 1000);
}

/* The recordable spans of ONE DAY, by day number. Empty on a day the studio
   does not work, which is what makes every walk below skip weekends without
   any of them knowing what a weekend is.
 *
 * THE ONE FUNNEL. isRecording, stopsAt, startsAt, resumesAt, lastStoppedAt and
 * workingSecondsBetween all ask this and nothing else, which is what let named
 * windows arrive without any of them changing: the two forms of schedule are
 * told apart here, once.
 *
 * An `entries` array — even an empty one — means the Super Admin's named
 * windows are in force and the four legacy time pairs are not consulted. Empty
 * therefore records nothing, which is the honest reading of a studio that has
 * switched every window off, and the Settings screen says so in as many words
 * rather than quietly falling back to hours nobody chose. */
function spansOn(day, schedule) {
  if (Array.isArray(schedule.entries)) return spansFromEntries(day, schedule.entries);
  return isWorkingDay(dowOf(day), schedule) ? openSpans(schedule) : [];
}

/* Is time being recorded at this instant?
 *
 * A working day, inside the day, AND NOT INSIDE A BREAK. That last clause is
 * the studio's final rule and it reverses what this function used to say: a
 * break was once "open but not working" — subtracted from the total without
 * stopping the clock, so nobody had to press anything at two o'clock. The
 * studio now wants the clock itself to stop at eleven, at one and at four, and
 * start again at quarter past, at two and at quarter past.
 *
 * So there is no longer a difference between "open" and "recording", and this
 * file no longer draws one. Everything asks the same question, which is the
 * only question the application actually has: is this instant being counted?
 */
function isRecording(ms, schedule) {
  const { day, minute } = istPartsOf(ms);
  return spansOn(day, schedule).some(([from, to]) => minute >= from && minute < to);
}

/* When the recordable span this instant sits in ENDS — or null if it is not in
 * one.
 *
 * The auto-pause boundary, and the whole of it. It is now the next stop of any
 * kind: the start of a break as much as the end of the day, so a timer running
 * at eleven is put down at eleven and one running at seven is put down at
 * seven, by one rule rather than two.
 *
 * Null is the answer for an instant at nine in the evening, on a Saturday, or
 * in the middle of lunch, and callers read that null as "there is nothing for
 * this to have run until" — which is what makes a timer started inside a break
 * and a timer that ran into one end up in the same state by the same route.
 */
function stopsAt(ms, schedule) {
  const { day, minute } = istPartsOf(ms);
  for (const [from, to] of spansOn(day, schedule)) {
    if (minute >= from && minute < to) return instantAt(day, to);
  }
  return null;
}

/* And when it STARTED — the other end of the same span.
 *
 * What the automatic resume back-dates to. Half past nine on an ordinary
 * morning, quarter past eleven after the morning break, two o'clock after
 * lunch: the beginning of the stretch being counted now, whichever stretch
 * that is. Null when nothing is being recorded.
 */
function startsAt(ms, schedule) {
  const { day, minute } = istPartsOf(ms);
  for (const [from, to] of spansOn(day, schedule)) {
    if (minute >= from && minute < to) return instantAt(day, from);
  }
  return null;
}

/* When recording last STOPPED, at or before this instant.
 *
 * The mirror of resumesAt, and the boundary an overdue session should be put
 * down at. stopsAt answers "when does the stretch this instant is in end",
 * which is the right question for an instant inside a stretch and the wrong one
 * for a session that has been open across several of them: it hands back the
 * FIRST boundary after the session began, and everything the session was open
 * for after that is thrown away.
 *
 * That is not a theoretical difference. A sweep that stops running at eleven
 * and comes back at twenty past four — a restart, a deploy, a process that
 * died — put the session down at eleven and then opened a new one at quarter
 * past four, losing the two stretches in between: three hours and forty-five
 * minutes, gone, with nothing on screen to say so.
 *
 * Scans backwards a bounded number of days for the same reason resumesAt scans
 * forwards: a schedule with no working days cannot be saved but could be edited
 * into the database by hand, and a hang is a worse answer than a null.
 */
function lastStoppedAt(ms, schedule) {
  const { day, minute } = istPartsOf(ms);
  for (let i = 0; i <= 14; i += 1) {
    const d = day - i;
    const spans = spansOn(d, schedule);
    for (let k = spans.length - 1; k >= 0; k -= 1) {
      const [, to] = spans[k];
      // Today, only a stretch that has already ended; on an earlier day, its last.
      if (i > 0 || to <= minute) return instantAt(d, to);
    }
  }
  return null;
}

/* When recording next becomes possible, at or after this instant.
 *
 * Returns the instant itself when it is already inside a recordable span, so a
 * caller can use it as "from when does this count" without asking isRecording
 * first.
 *
 * It now lands on the end of a break as readily as on the start of a day —
 * paused at one o'clock, this says two — and it still skips every day the
 * studio does not work, because spansOn hands back nothing for those. A Friday
 * evening pause therefore answers Monday morning without this function
 * containing the word weekend.
 *
 * Scans a bounded number of days rather than looping: a schedule with no
 * working days cannot be saved, but a database edited by hand could hold one,
 * and an unbounded scan would hang the request rather than report the problem.
 */
function resumesAt(ms, schedule) {
  const { day, minute } = istPartsOf(ms);
  for (let i = 0; i <= 14; i += 1) {
    const d = day + i;
    for (const [from, to] of spansOn(d, schedule)) {
      if (i > 0) return instantAt(d, from);        // the first span of a later day
      if (minute >= from && minute < to) return ms;  // already inside one
      if (minute < from) return instantAt(d, from);  // later today
    }
  }
  return null;
}

module.exports = {
  IST_OFFSET_MINUTES,
  istPartsOf, dowOf, instantAt, openSpans, spansOn, spansFromEntries, workableMinutesPerDay,
  merge, subtract,
  workingSecondsBetween, isRecording, stopsAt, startsAt, resumesAt, lastStoppedAt,
};
