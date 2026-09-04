/* When an asset may be started.
 *
 * An asset can carry a Start Date: the day the work is scheduled to begin.
 * Until that day arrives, Accept and Start is refused. Three decisions are
 * written down here rather than in the two places that ask, because the button
 * and the endpoint disagreeing is the failure this shape exists to prevent —
 * a person told they may start being refused when they click.
 *
 *   1. ON OR AFTER, not on the day itself. A task whose start date slipped past
 *      unnoticed is late, not forbidden; strictly-that-day would make every
 *      missed schedule a permanent lockout with no way back except editing the
 *      date, which turns a planning field into a trap.
 *
 *   2. NO START DATE MEANS NO WAITING. The field is optional everywhere it is
 *      offered, and blank has to keep meaning what it meant before it existed:
 *      nothing scheduled, so nothing to wait for.
 *
 *   3. TODAY IS IST. The studio's day boundaries are already IST in the Time
 *      Sheet, and a rule about "has the day arrived" that used the server's
 *      clock would open a task five and a half hours early for everybody in
 *      the office. India has never observed daylight saving, so the offset is
 *      a constant rather than a lookup — the same reasoning src/timesheets.js
 *      relies on for storing clock times as minutes.
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

/* Has the day arrived? Comparing YYYY-MM-DD strings is comparing dates: the
   format sorts lexicographically, so there is no arithmetic to get wrong and
   no timezone left in the comparison. */
function startsInFuture(asset, now = new Date()) {
  const start = asISODate(asset && (asset.start_date ?? asset.startDate));
  if (!start) return false;
  return start > todayInIST(now);
}

// The refusal, worded once so the button's tooltip and the API say the same.
function notYetMessage(asset, now = new Date()) {
  const start = asISODate(asset && (asset.start_date ?? asset.startDate));
  if (!start) return null;
  return `This task cannot be started until ${start} — its start date has not arrived yet.`
    + ` Today is ${todayInIST(now)} in IST.`;
}

module.exports = { todayInIST, asISODate, startsInFuture, notYetMessage, IST_OFFSET_MINUTES };
