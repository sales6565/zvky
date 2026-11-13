/* THE ASSET'S DATES ARE INFORMATION. THEY DECIDE NOTHING.
 *
 * An asset can carry a Start Date (the day the work is scheduled to begin) and
 * an End Date, stored as `due_date` (the day it is wanted). Both are planning
 * fields: they are shown, sorted, filtered, counted and put in reminders, and
 * NOTHING in Forge is allowed, refused, enabled, disabled, shown or hidden
 * because of either of them.
 *
 * ===========================================================================
 * WHAT THIS FILE USED TO DO, AND WHY IT WAS WRONG.
 *
 * It owned a gate. `startsInFuture()` compared the start date against today in
 * IST and `notYetMessage()` worded the refusal, and two callers asked:
 * POST /api/assets/:id/start answered 409, and the board disabled Accept and
 * Start with "This task can't be started until <date>".
 *
 * The reasoning was careful and it was about the wrong thing. It worried about
 * the button and the endpoint disagreeing, and about a missed start date
 * becoming a permanent lockout — real failures, both, of a rule that should not
 * have existed. The owner's position is that these dates are for information
 * only: a schedule is what the studio INTENDS, and an artist who has been given
 * a task and is sitting in front of it must be able to start it. A planning
 * field that refuses work is a planning field that gets left blank, and then
 * the schedule nobody can trust is the one thing the field was for.
 *
 * So the two gate functions are GONE rather than left unused. A dead
 * `startsInFuture()` is an invitation: the next person who wants "not before
 * its date" finds a function that already says it and one caller away from a
 * gate. tests/asset-start-date.test.js fails if either name comes back, and
 * fails if anything outside the display and reminder modules reads an asset's
 * start or end date to decide an action.
 *
 * ===========================================================================
 * WHAT IS LEFT IS DATE HANDLING, AND IT IS STILL NEEDED.
 *
 * Storing, editing and showing a DATE correctly is the part that was never
 * about gating: asISODate() is what keeps a stored date from shifting a day
 * when it crosses a timezone, and every route that writes one of these columns
 * goes through it. todayInIST() remains because the studio's day is IST
 * everywhere in this application and the import, the dashboard and the
 * reminders all ask what today is.
 *
 *   TODAY IS IST. The studio's day boundaries are already IST in the Time
 *   Sheet, and India has never observed daylight saving, so the offset is a
 *   constant rather than a lookup — the same reasoning src/timesheets.js relies
 *   on for storing clock times as minutes.
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30;

// Today in the studio's timezone, as YYYY-MM-DD.
function todayInIST(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/* A stored date as YYYY-MM-DD, or null.
 *
 * MySQL hands a DATE back as a JS Date in this driver, and a Date built from
 * "2026-09-12" is midnight UTC — which toISOString() renders as the 11th for
 * anybody east of Greenwich. So the calendar parts are read directly rather
 * than via an ISO round trip. A string is passed through after a shape check,
 * which is what an already-formatted value from the API looks like. */
function asISODate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? match[0] : null;
}

module.exports = { todayInIST, asISODate, IST_OFFSET_MINUTES };
