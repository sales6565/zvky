/* YESTERDAY'S TIMESHEET, AS A CONDITION OF STARTING TODAY'S WORK.
 *
 * When the studio switches it on, a person who has not filled their timesheet
 * for the previous working day cannot start or resume a task. Fill it and the
 * clock unlocks on the next poll — no sign-out, no waiting.
 *
 * ONE MODULE BECAUSE THERE ARE TWO DEFINITIONS AND BOTH ARE EASY TO GET WRONG.
 * "Previous working day" and "filled" are decided here, once, and every caller
 * — POST /:id/start, POST /:id/resume, the overnight sweep, and the field
 * /auth/me hands the browser — reads the same answer. The gates in this
 * application have drifted before precisely by having two copies of a date
 * rule, so the browser is given the answer rather than the inputs.
 *
 * ---------------------------------------------------------------------------
 * WHAT "PREVIOUS WORKING DAY" MEANS, and why it is not the recording schedule.
 *
 * The most recent day before today, in IST, that is BOTH:
 *
 *   on timesheetSettings.loggableDays   the studio's own weekly-off list for
 *                                       timesheets, Mon-Fri by default and
 *                                       editable in Settings; and
 *   not on the holiday calendar         src/holidays.js, Prompt 22's list.
 *
 * NOT work_schedule.workingDays, which is the list the CLOCK uses, and the
 * difference is deliberate. This rule asks for a TIMESHEET, and
 * timesheets.validateEntry() refuses a date outside loggableDays outright — so
 * a day the recording schedule counts as working but the timesheet will not
 * accept is a day nobody can comply for. Demanding it would be demanding the
 * impossible. The two lists are the same by default; a studio that makes them
 * differ gets the timesheet's answer, which is the only one it can act on.
 *
 * WEEKENDS AND HOLIDAYS ARE SKIPPED BY WALKING BACK, not by naming Saturday:
 * Monday's answer is Friday, and Friday being a holiday makes it Thursday. A
 * long shutdown is walked straight through.
 *
 * ---------------------------------------------------------------------------
 * WHAT "FILLED" MEANS: at least one line exists for that date.
 *
 * Any line. A project line, a non-project line, or an IDLE line (Prompt 24),
 * which is what makes compliance always possible — a day with nothing to report
 * is still a day somebody can account for in one entry.
 *
 * DRAFT COUNTS. The draft/submitted distinction lives on timesheet_days.status,
 * not on the lines, and submitting LOCKS the lines (timesheets.LOCKED). Reading
 * "filled" as "submitted" would mean the rule could only be satisfied by an act
 * that also prevents correcting it, and would couple starting work to an
 * approver's queue. Somebody who has written down their day has done what was
 * asked.
 *
 * NOT AN HOURS THRESHOLD, and not configurable. maxDayHours exists but is a
 * soft CAP the form quotes, not a floor; a floor would block somebody whose
 * Tuesday honestly was three hours. The brief invited a Super-Admin number and
 * the honest answer is that one line is not a number worth configuring — the
 * switch itself is the policy.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS OPEN. Every error path below returns "not blocked": a missing
 * timesheet table, an unloaded holiday cache, a query that throws. A rule about
 * paperwork must never be the reason nobody in the studio can work, and a bug
 * here would otherwise stop the whole floor at once.
 */

const timesheetSettings = require('./timesheet-settings');
const holidays = require('./holidays');

// The IST calendar date of an instant, as 'YYYY-MM-DD'. Same arithmetic as
// timesheets.studioToday and holidays.todayISO — IST has no daylight saving, so
// the offset is a constant and there is no second case to get wrong.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function istDate(at = Date.now()) {
  const d = new Date(at + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The ISO weekday (1 = Monday … 7 = Sunday) of a 'YYYY-MM-DD'. Read through UTC
// so the server's own zone cannot shift it.
function isoDayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const js = d.getUTCDay();
  return js === 0 ? 7 : js;
}

const shiftDays = (date, by) =>
  istDate(Date.parse(`${date}T00:00:00Z`) + by * 86400000 - IST_OFFSET_MS);

/* How far back to look before giving up.
 *
 * Twenty-eight days covers any shutdown a studio takes in one run — the longest
 * the holiday calendar is likely to hold — and bounds the walk so a
 * misconfiguration (loggableDays emptied, every day a holiday) ends in "no
 * previous working day, so nobody is blocked" rather than in a loop. */
const LOOKBACK_DAYS = 28;

/* THE MOST RECENT WORKING DAY BEFORE `today`, or null.
 *
 * Null is a real answer and it means NOT BLOCKED: a studio with no loggable
 * days, or a holiday run longer than the lookback, has no day to demand.
 */
function previousWorkingDay(today, { loggableDays, isHoliday } = {}) {
  const days = Array.isArray(loggableDays) && loggableDays.length
    ? loggableDays
    : null;
  if (!days) return null;
  const holiday = typeof isHoliday === 'function' ? isHoliday : () => false;
  for (let back = 1; back <= LOOKBACK_DAYS; back += 1) {
    const date = shiftDays(today, -back);
    if (!days.includes(isoDayOf(date))) continue;
    if (holiday(date)) continue;
    return date;
  }
  return null;
}

// "Thursday 9 Oct" — the form the refusal names the date in, so somebody can
// match it against the day picker without translating an ISO string.
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function label(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return String(date || '');
  const [, m, d] = date.split('-');
  return `${DAY_NAMES[isoDayOf(date)]} ${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/* The one error code in this application, and it is here because the brief
   asked for a distinct one. Everything else refuses with a NAMED FIELD beside
   the sentence — `holiday`, `startsOn`, `opensAt` — which is the convention the
   body below also follows. */
const CODE = 'TIMESHEET_INCOMPLETE';

/* IS THIS PERSON BLOCKED, and if so for which date?
 *
 * Returns { blocked, date, dateLabel, code, error, reason }. `reason` says why
 * when it is NOT blocked, because "off", "nothing owed" and "already filled"
 * are three different answers and the sweep logs which.
 */
async function check(db, user, { now = Date.now(), settings = null } = {}) {
  const free = (reason) => ({ blocked: false, reason, date: null, dateLabel: null });
  try {
    if (!user || !user.id) return free('no user');
    const policy = settings || timesheetSettings.current();
    if (!policy || !policy.requirePreviousDay) return free('off');

    const today = istDate(now);
    /* The holiday cache, asked only if it is loaded. An unloaded mirror means
       "we do not know which days were holidays", and guessing none would demand
       a timesheet for Diwali. Fail open. */
    if (!holidays.isLoaded()) return free('holiday calendar unavailable');
    const date = previousWorkingDay(today, {
      loggableDays: policy.loggableDays,
      isHoliday: (d) => Boolean(holidays.on(d)),
    });
    if (!date) return free('no previous working day');

    /* NOT BLOCKED FOR A DAY THEY WERE NOT HERE. The account's created_at is the
       obligation's start: somebody who joined this morning owes nothing for
       yesterday, and a new starter's first act must not be filling in a day
       they did not work. Compared as IST dates, so an account made at 23:00 IST
       is not treated as having existed the previous day. */
    const joined = user.created_at || user.createdAt || null;
    if (joined) {
      const joinedDate = istDate(typeof joined === 'number' ? joined : Date.parse(joined));
      if (/^\d{4}-\d{2}-\d{2}$/.test(joinedDate) && joinedDate > date) {
        return free('joined after that day');
      }
    }

    /* AND NOT BLOCKED FOR A DAY THEY CANNOT FILL. backdateDays is a Super Admin
       setting and it could put the previous working day out of reach — Monday
       needing Friday is three days back, so a window of 1 would demand the
       impossible. timesheets.validateEntry() grants this exact date an
       exemption while the rule is on (see the note there), so this is the
       belt to that braces: if the day is somehow still unfillable, nobody is
       blocked for it. */
    const behind = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000
    );
    if (policy.backdateDays !== null && policy.backdateDays !== undefined
        && behind > Number(policy.backdateDays) && !exemptBackdate(policy)) {
      return free('previous working day is outside the back-dating window');
    }

    /* "FILLED" IS ASKED OF src/timesheets.js RATHER THAN OF THE TABLE, and the
       require is lazy because that module reaches back here for the back-dating
       exemption. Nothing outside it and its route touches the lines table —
       tests/timesheet-options.test.js greps the tree to keep it that way, so
       that a new reader of these hours has to decide what Idle means to it
       first; that is also why this comment does not name the table. The
       decision is written out beside hasLineOn(): every line counts, Idle
       included. */
    const timesheets = require('./timesheets');
    if (await timesheets.hasLineOn(db, user.id, date)) return free('filled');

    return {
      blocked: true,
      reason: 'not filled',
      date,
      dateLabel: label(date),
      code: CODE,
      error: `Fill your timesheet for ${label(date)} to start work. Open the Time Sheet tab, `
        + 'add a line for that day — an Idle line counts — and this unlocks straight away.',
    };
  } catch (err) {
    /* FAIL OPEN, LOUDLY. A missing table, an unreachable database, anything:
       the clock keeps working and the server says why in the log. The opposite
       choice would make a bug in this file an outage for the whole studio. */
    console.warn(`[timesheet gate] failing open for ${user && user.id}: ${err.message}`);
    return free('error');
  }
}

/* Is the back-dating window waived for the gate's own day? True whenever the
   rule is on, which is what makes the policy and the gate agree — see
   validateEntry in src/timesheets.js, which grants the same exemption. One
   predicate, both callers. */
const exemptBackdate = (policy) => Boolean(policy && policy.requirePreviousDay);

module.exports = {
  CODE, LOOKBACK_DAYS,
  istDate, isoDayOf, previousWorkingDay, label, check, exemptBackdate,
};
