/* THE DAY MUST ADD UP TO EXACTLY THE REQUIRED HOURS.
 *
 * ===========================================================================
 * THE OWNER'S RULE, in one sentence: a day under this rule can be submitted
 * only when its lines total EXACTLY the required hours — fewer is refused, and
 * more cannot even be filed. This module is the only place that decides it.
 * The submit route, the three line routes, the week payload and the page all
 * ask it; none of them re-derives any part of it.
 *
 * ===========================================================================
 * THE UNIT IS CENTIHOURS, AND THAT IS NOT A STYLE CHOICE.
 *
 * A line's hours are `timesheet_entries.hours DECIMAL(5,2)` — hundredths of an
 * hour, exactly, with nothing below them. So:
 *
 *   MINUTES ARE THE WRONG UNIT. 0.01h is 0.6 of a minute, so 7.99h is not a
 *     whole number of minutes: a rule written in minutes would have to round,
 *     and a rounded comparison is not an exact one. "Exactly eight hours" would
 *     quietly mean "eight hours give or take a third of a minute".
 *
 *   FLOATING POINT IS THE WRONG REPRESENTATION. 0.1 + 0.2 is 0.30000000000000004
 *     in IEEE 754, and a day of 0.1 + 0.2 + 7.7 is not 8 on any comparison that
 *     uses `===` against 8. Every figure here is an INTEGER number of
 *     centihours, converted once at the boundary with Math.round, and every
 *     comparison is integer equality.
 *
 *   AND THE TWO SIDES MATCH. The requirement comes from
 *     timesheet_settings.max_day_hours, DECIMAL(5,2) — the same precision the
 *     lines have. So the requirement is always reachable by some sum of lines,
 *     which is the property that makes "exactly" a rule a person can satisfy
 *     rather than a trap.
 *
 * HALF DAYS ARE WHY THE SETTING IS CONSTRAINED. A half-day leave requires half
 * the value, and half of 825 centihours is 412.5, which no line can hold. So
 * src/timesheet-settings.js refuses a required-hours value whose half is not a
 * whole centihour — see the note there. This module assumes that has been done
 * and asserts nothing about it, because a module that silently rounded here
 * would make the setting screen's refusal pointless.
 *
 * ===========================================================================
 * WHAT COUNTS. Every line on the day, of every kind — project work, TL Action,
 * Training, On Site, Idle with its remarks, Leave, and anything a studio adds
 * to the category list. Idle counts because Idle exists so that a day can be
 * filled honestly; a rule that made people log eight hours of "work" to escape
 * it would be a rule that produced false timesheets.
 *
 * ===========================================================================
 * WHEN IT DOES NOT APPLY, and in all five cases the day behaves exactly as it
 * did before this feature existed — including the old flag-only treatment of
 * hours above the setting:
 *
 *   the switch is off              Settings -> Time Sheet, "Timesheet hours rule"
 *   the day is before the start    hours_rule_from, so turning it on today does
 *                                  not condemn a month of half-filled days
 *   the person is exempt           timesheet.min_hours_exempt
 *   nothing is owed for the day    full-day leave, a holiday, a weekly off, a
 *                                  vacation day, a planned leave — asked of
 *                                  src/day-status.js, never decided here
 *   the required figure is zero    which is the same thing said in numbers
 */

/* One hour, in the unit everything here uses. Named so that no line in this
   file multiplies by a bare 100. */
const CENTI_PER_HOUR = 100;

/* A DECIMAL(5,2) column, or a number a person typed, as an exact integer.
 *
 * Math.round and not a truncation: Number('2.35') * 100 is 234.99999999999997,
 * and a floor would turn two and thirty-five hundredths into 2.34. The value
 * being rounded is always within half a centihour of an integer, because that
 * is what the column can hold, so this is exact for every real input. */
const toCenti = (hours) => {
  const n = Number(hours);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * CENTI_PER_HOUR);
};

/* Back to hours, for a message or a payload field. Never used to compare. */
const toHours = (centi) => Math.round(Number(centi) || 0) / CENTI_PER_HOUR;

/* "8h", "6.5h", "0.25h" — the shortest honest spelling of a centihour figure.
   Trailing zeros dropped, because "8.00h of 8.00h" reads like a bank statement
   and the studio's own screens write 8h. */
function label(centi) {
  const hours = toHours(centi);
  const text = hours.toFixed(2).replace(/\.?0+$/, '');
  return `${text}h`;
}

/* THE DAY'S TOTAL, from its lines. The one place a day is added up for this
   rule, so the cap, the submit check and the page's bar cannot disagree about
   what "logged" means. */
const loggedCenti = (entries) => (entries || [])
  .reduce((n, e) => n + toCenti(e && e.hours), 0);

/* ---------------------------------------------------------------------------
 * HOW MUCH THE DAY ASKS FOR.
 *
 * `timesheetRequired` and `mark` are both src/day-status.js's answers, passed
 * in rather than fetched, because this is called once per day for seven days of
 * a week and that module already fetches the week's marks in one query.
 *
 *   timesheetRequired === false   0. Nothing is owed: a holiday, a weekly off,
 *                                 a full day's leave, a full vacation day, a
 *                                 planned full day. The caller got this from
 *                                 isTimesheetRequired / timesheetRequiredFromRow
 *                                 and the two cases are not separated here,
 *                                 because to this rule they are one case.
 *   a half day's leave            half the setting. Either half: a first-half
 *                                 leave and a second-half leave both leave half
 *                                 a day to account for.
 *   anything else                 the setting in full. Idle, On Site and a
 *                                 normal day are all "a day at the desk".
 */
function requiredCentiFor({ requiredHours, mark = null, timesheetRequired = true } = {}) {
  if (!timesheetRequired) return 0;
  const full = toCenti(requiredHours);
  if (full <= 0) return 0;
  const half = isHalfDayLeave(mark);
  if (!half) return full;
  /* INTEGER HALVING, and a value whose half is not whole cannot get here: the
     settings validator refuses one. Math.round rather than a bare division so
     that a hand-edited row cannot produce a fractional requirement that no line
     could ever match — it would be unsatisfiable, and the nearest whole
     centihour is at least reachable. */
  return Math.round(full / 2);
}

/* A HALF DAY, asked of the row's own fields rather than re-derived. The two
   portion values are src/day-status.js's PORTIONS; they are compared by their
   string values so this module does not have to require that one (it requires
   this one, through the route, and a cycle would be the result). */
function isHalfDayLeave(mark) {
  return Boolean(mark && mark.kind === 'leave'
    && (mark.portion === 'first_half' || mark.portion === 'second_half'));
}

/* ---------------------------------------------------------------------------
 * THE WHOLE VERDICT FOR ONE PERSON ON ONE DAY.
 *
 * Returns the same shape whether the rule applies or not, so no caller has to
 * remember which fields exist:
 *
 *   applies    false when the switch is off, the day is before the start date,
 *              the person is exempt, or nothing is owed for the day.
 *   required   centihours. 0 when nothing is owed.
 *   logged     centihours, from the lines.
 *   remaining  required - logged. Negative when over.
 *   status     'short' | 'exact' | 'over', and null when the rule does not
 *              apply — a day it says nothing about must not read as 'exact',
 *              which is a state with a meaning.
 *   canSubmit  true unless the rule applies and the status is not 'exact'.
 *   reason     why canSubmit is false, in the studio's own words.
 */
function decide({
  enabled = false, requiredHours = 0, effectiveFrom = null, date = null,
  exempt = false, mark = null, timesheetRequired = true, entries = null,
  logged = null,
} = {}) {
  const loggedNow = logged === null || logged === undefined ? loggedCenti(entries) : Math.round(logged);
  const required = requiredCentiFor({ requiredHours, mark, timesheetRequired });

  const applies = Boolean(enabled) && !exempt && required > 0 && onOrAfter(date, effectiveFrom);
  if (!applies) {
    return {
      applies: false,
      required: enabled && !exempt ? required : 0,
      logged: loggedNow,
      remaining: null,
      status: null,
      canSubmit: true,
      reason: null,
      /* WHY IT DOES NOT APPLY, for the page's one-line note and for the tests
         that prove each case is reached for its own reason rather than by
         accident. */
      inactiveBecause: !enabled ? 'switch_off'
        : (exempt ? 'exempt'
          : (required <= 0 ? 'nothing_owed' : 'before_effective_from')),
    };
  }

  const remaining = required - loggedNow;
  const status = remaining > 0 ? 'short' : (remaining === 0 ? 'exact' : 'over');
  return {
    applies: true,
    required,
    logged: loggedNow,
    remaining,
    status,
    canSubmit: status === 'exact',
    reason: status === 'exact' ? null
      : (status === 'short'
        ? `Log ${label(remaining)} more to submit.`
        : `This day is ${label(-remaining)} over ${label(required)}. Edit or delete lines to submit.`),
    inactiveBecause: null,
  };
}

/* IS THIS DAY ON OR AFTER THE DAY THE RULE STARTED. ISO dates compare as
   strings, which is why every date in this application is stored as one; no
   Date object is built, so no timezone can enter. A missing start date means
   the rule has not been started, so no day is under it — the switch and the
   date are turned on together by src/timesheet-settings.js, and a row with one
   and not the other is a row nobody should be ruled by. */
function onOrAfter(date, effectiveFrom) {
  const day = String(date || '');
  const from = String(effectiveFrom || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return false;
  return day >= from;
}

/* ---------------------------------------------------------------------------
 * WHAT A NEW OR CHANGED LINE IS ALLOWED TO BE.
 *
 * `own` is the line's current hours when one is being EDITED, so the room it
 * already takes is given back before the limit is applied; zero when a line is
 * being added. Returns the verdict and the headroom, so the caller can answer
 * with both the refusal and the number that would have fitted.
 */
function lineFits({ verdict, wanted, own = 0 }) {
  const want = Math.round(wanted);
  const headroom = verdict.applies ? verdict.required - (verdict.logged - Math.round(own)) : null;
  if (!verdict.applies) return { ok: true, headroom: null };
  if (want <= headroom) return { ok: true, headroom };
  return { ok: false, headroom };
}

module.exports = {
  CENTI_PER_HOUR,
  toCenti, toHours, label, loggedCenti,
  requiredCentiFor, isHalfDayLeave, decide, onOrAfter, lineFits,
};
