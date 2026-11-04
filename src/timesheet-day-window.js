/* WHETHER A TIMESHEET DAY IS OPEN FOR ENTRY. ONE FUNCTION, FOUR ROUTES.
 *
 * ===========================================================================
 * THERE IS NO NEW WINDOW HERE, AND THAT IS THE POINT.
 *
 * Settings → Time Sheet has had two date windows since Prompt 51:
 *
 *   backdateDays   how far back a line may be filed. NULL = no limit.
 *   futureDays     how far ahead.                    NULL = no limit.
 *
 * `backdateDays = 1` with `futureDays = 0` is "today and the previous day", and
 * NULL on both is the behaviour this application had before either existed. So
 * the switch somebody would otherwise have built is the pair being NULL or not,
 * and a second setting beside them could only ever disagree with them — which is
 * what the studio ruled when this was specified as a new switch and an integer.
 *
 * WHAT WAS ACTUALLY MISSING was enforcement. The windows were checked in
 * sheets.validateEntry(), which POST and PATCH call — and nothing else. DELETE
 * and submit never looked at the date at all, so a day outside the window could
 * be emptied and filed. This module is where that check now lives for all four,
 * and validateEntry calls it too, so there is one implementation and not a
 * second one that happens to agree today.
 *
 * ===========================================================================
 * THE THREE THINGS THAT OPEN A CLOSED DAY, and why each exists.
 *
 *   the previous-day carve-out   The gate refuses to let somebody start work
 *                                until they have filled the previous working
 *                                day, and backdateDays can put that very day out
 *                                of reach — a window of 1 on a Monday makes
 *                                Friday three days back. A rule that demands the
 *                                impossible is worse than no rule, so the gate's
 *                                own owed day is always fillable. This predates
 *                                this prompt and is deliberately unchanged;
 *                                timesheet-gate.exemptBackdate() owns the
 *                                condition and previousWorkingDay() owns the
 *                                date, so there is one answer and the refusal
 *                                cannot name a different day from the gate.
 *
 *   timesheet.backdate           A person who may file on any day. For the
 *                                studio's own back-office: somebody has to be
 *                                able to fix last month, and a window with no
 *                                key behind it means that person is the window's
 *                                hostage too.
 *
 *   an unlock row                One person, one day, opened by somebody holding
 *                                timesheet.unlock_day, and it closes itself when
 *                                the day is submitted. This is the answer to "I
 *                                was away and now I cannot file Tuesday" that
 *                                does not involve widening the studio's window
 *                                for everybody or handing out a permanent key.
 *
 * ORDER DOES NOT MATTER among the three: any one of them opens the day, and the
 * reason reported says which, because "why am I allowed to edit this?" is a
 * question an admin asks when a figure looks wrong.
 *
 * ===========================================================================
 * THE STUDIO'S TIMEZONE, NOT THE PROCESS'S.
 *
 * `today` is timesheetGate.istDate(now) — the same date source the gate, the
 * reminders, the follow-up lists and the exact-hours rule use. This server runs
 * in UTC and the studio is in India, so between 18:30 and midnight UTC "today"
 * is already tomorrow in the office: a window computed from the process's own
 * calendar would close the studio's current day for five and a half hours every
 * evening. Nothing here builds a Date or reads a local method.
 */
const timesheetGate = require('./timesheet-gate');
const timesheetSettings = require('./timesheet-settings');
const holidays = require('./holidays');

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

const MS_PER_DAY = 86400000;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
/* POSITIVE WHEN `then` IS BEFORE `today`. The same expression src/timesheets.js
   uses, over the same ISO strings, so the two cannot disagree about what "two
   days back" means. */
const daysBefore = (then, today) => dayNumber(today) - dayNumber(then);

const CODE = 'TIMESHEET_DAY_LOCKED';

/* WHICH DAY THE PREVIOUS-DAY GATE IS ASKING FOR, or null when it is switched
   off. Asked of timesheet-gate so this module never works out a working day for
   itself. */
function owedDay(policy, today) {
  if (!timesheetGate.exemptBackdate(policy)) return null;
  return timesheetGate.previousWorkingDay(today, {
    loggableDays: policy.loggableDays,
    isHoliday: (d) => Boolean(holidays.on(d)),
  });
}

/* THE DECISION, PURE. No database, no request, no clock of its own beyond the
 * `now` it is given — so it is testable as a table, which is how the boundaries
 * in this feature are pinned.
 *
 * `backdateKey` and `unlocked` are resolved by the caller, because one is a
 * permission and the other is a row, and neither is this function's business to
 * look up. openFor() below does both and then calls this.
 */
function isTimesheetDayOpen({ policy = null, date, now = Date.now(),
  backdateKey = false, unlocked = false } = {}) {
  const p = policy || timesheetSettings.current();
  const today = timesheetGate.istDate(now);
  const window = {
    backdateDays: p.backdateDays === null || p.backdateDays === undefined
      ? null : Number(p.backdateDays),
    futureDays: p.futureDays === null || p.futureDays === undefined
      ? null : Number(p.futureDays),
    today,
  };
  if (!isDate(date)) return { open: false, reason: 'bad_date', window, owed: null };

  const owed = owedDay(p, today);
  const behind = daysBefore(date, today);
  const ahead = -behind;

  /* NO LIMIT EITHER WAY IS THE DEFAULT AND IS SAID FIRST, so the ordinary
     deployment answers in two comparisons and never reaches the rest. */
  const tooOld = window.backdateDays !== null && behind > window.backdateDays;
  const tooFarAhead = window.futureDays !== null && ahead > window.futureDays;
  if (!tooOld && !tooFarAhead) return { open: true, reason: 'in_window', window, owed };

  /* THE CARVE-OUT IS CHECKED BEFORE THE KEYS because it is not a privilege —
     it is the window declining to contradict the gate, and it applies to
     everybody including a person holding nothing. */
  if (owed && date === owed) return { open: true, reason: 'owed_day', window, owed };
  if (backdateKey) return { open: true, reason: 'backdate_key', window, owed };
  if (unlocked) return { open: true, reason: 'unlocked', window, owed };

  return {
    open: false,
    reason: tooOld ? 'too_old' : 'too_far_ahead',
    behind: tooOld ? behind : null,
    ahead: tooFarAhead ? ahead : null,
    window,
    owed,
  };
}

/* HOW THE REFUSAL READS. One sentence per reason, naming the window, because
 * "that day is closed" with no figure makes somebody guess which day is not.
 *
 * THE WORDING OF THE TWO WINDOW CASES IS THE WORDING validateEntry HAS ALWAYS
 * USED, deliberately: those sentences are on screens and in tests already, and
 * a feature that reworded an existing refusal while adding enforcement
 * elsewhere would make the change impossible to review.
 */
function refusalFor(verdict) {
  const w = verdict.window || {};
  if (verdict.reason === 'too_old') {
    return `${verdict.date || 'That day'} is ${verdict.behind} days ago, and the studio allows `
      + `lines to be filed up to ${w.backdateDays} day${w.backdateDays === 1 ? '' : 's'} back. `
      + 'Lines filed before this rule was set are unaffected.';
  }
  if (verdict.reason === 'too_far_ahead') {
    return w.futureDays === 0
      ? `${verdict.date || 'That day'} is in the future, and the studio does not allow hours to `
        + 'be logged ahead of today.'
      : `${verdict.date || 'That day'} is ${verdict.ahead} days ahead, and the studio allows `
        + `lines up to ${w.futureDays} day${w.futureDays === 1 ? '' : 's'} ahead.`;
  }
  return 'That day is closed for entry. Ask your admin to open it.';
}

/* THE PAYLOAD A REFUSED ROUTE RETURNS, with the window in it so a stale page can
   redraw from the answer rather than from another request. */
const refusal = (verdict, date) => ({
  error: refusalFor({ ...verdict, date }),
  code: CODE,
  reason: verdict.reason,
  openFrom: verdict.window.backdateDays === null
    ? null : timesheetGate.shiftDays(verdict.window.today, -verdict.window.backdateDays),
  openTo: verdict.window.futureDays === null
    ? null : timesheetGate.shiftDays(verdict.window.today, verdict.window.futureDays),
  today: verdict.window.today,
  owedDay: verdict.owed || null,
});

/* ---------------------------------------------------------------------------
 * AN UNLOCK: one person, one day, until it is submitted.
 */

/* IS THERE A LIVE UNLOCK for this person and day. `closed_at IS NULL` is the
   whole of "live" — a submitted day closes its own unlock, so there is no
   expiry to compute and no sweep to run. */
async function unlockedFor(db, userId, date) {
  if (!userId || !isDate(date)) return false;
  try {
    const { rows } = await db.query(
      `SELECT id FROM timesheet_day_unlocks
        WHERE user_id = $1 AND \`date\` = $2 AND closed_at IS NULL LIMIT 1`,
      [userId, date]
    );
    return rows.length > 0;
  } catch (err) {
    /* AN UNMIGRATED DEPLOYMENT HAS NO UNLOCKS, which is not the same as being
       unable to answer: it means nobody has been given one, so the window
       applies. Never a reason to refuse to decide. */
    if (unavailable(err)) return false;
    throw err;
  }
}

/* CLOSED BY SUBMISSION, and that is the only thing that closes one.
 *
 * WHY NOT A TIME LIMIT: an unlock exists so one specific day can be filed, and
 * the act that finishes the job is filing it. A day-long expiry would strand
 * somebody who was handed an unlock at five o'clock, and a permanent one would
 * quietly become a second window nobody remembers granting.
 *
 * EVERY LIVE ROW FOR THAT DAY, not one: two admins may each have opened it, and
 * leaving the second row live would reopen a submitted day. */
async function closeOnSubmit(db, userId, date) {
  if (!userId || !isDate(date)) return 0;
  try {
    const { result } = await db.query(
      `UPDATE timesheet_day_unlocks SET closed_at = NOW()
        WHERE user_id = $1 AND \`date\` = $2 AND closed_at IS NULL`,
      [userId, date]
    );
    return Number((result && result.affectedRows) || 0);
  } catch (err) {
    if (unavailable(err)) return 0;
    throw err;
  }
}

async function openDay(db, { userId, date, by }) {
  if (!userId || !isDate(date)) return { ok: false, code: 'bad_request' };
  /* ALREADY OPEN IS NOT AN ERROR. Two admins pressing the same button is a
     thing that happens, and the second press should report the state rather
     than a conflict. */
  if (await unlockedFor(db, userId, date)) {
    return { ok: true, already: true };
  }
  const { v4: uuid } = require('uuid');
  try {
    await db.query(
      `INSERT INTO timesheet_day_unlocks (id, user_id, \`date\`, unlocked_by)
       VALUES ($1, $2, $3, $4)`,
      [uuid(), userId, date, (by && by.id) || null]
    );
  } catch (err) {
    if (unavailable(err)) return { ok: false, code: 'unavailable' };
    throw err;
  }
  return { ok: true, already: false };
}

/* Every live unlock for a person, for the History tab's "this day was opened
   for you" note and for the tests. */
async function liveFor(db, userId, { from = null, to = null } = {}) {
  if (!userId) return [];
  const clauses = ['user_id = $1', 'closed_at IS NULL'];
  const params = [userId];
  if (isDate(from)) { clauses.push(`\`date\` >= $${params.length + 1}`); params.push(from); }
  if (isDate(to)) { clauses.push(`\`date\` <= $${params.length + 1}`); params.push(to); }
  try {
    const { rows } = await db.query(
      `SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS \`date\`, unlocked_by AS unlockedBy,
              unlocked_at AS unlockedAt
         FROM timesheet_day_unlocks WHERE ${clauses.join(' AND ')} ORDER BY \`date\``,
      params
    );
    return rows;
  } catch (err) {
    if (unavailable(err)) return [];
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * THE COMPOSITION THE ROUTES CALL: policy, permission and unlock in one place.
 *
 * `conn` so a route inside a transaction asks the same question against its own
 * connection — the same reason the exact-hours rule takes one.
 */
async function openFor(db, user, date, { conn = null, now = Date.now(), policy = null } = {}) {
  const p = policy || timesheetSettings.current();
  const permissions = require('./permissions');
  const backdateKey = Boolean(user && permissions.holds(user, 'timesheet.backdate'));
  /* THE UNLOCK IS ONLY LOOKED UP WHEN IT COULD MATTER. A day inside the window,
     or a holder of the key, is already open — and the ordinary deployment has
     NULL windows, so this costs nothing on almost every request. */
  const dry = isTimesheetDayOpen({ policy: p, date, now, backdateKey, unlocked: false });
  if (dry.open) return dry;
  const unlocked = await unlockedFor(conn || db, (user && user.id) || null, date);
  if (!unlocked) return dry;
  return isTimesheetDayOpen({ policy: p, date, now, backdateKey, unlocked: true });
}

module.exports = {
  CODE,
  isTimesheetDayOpen,
  openFor,
  refusal,
  refusalFor,
  owedDay,
  unlockedFor,
  closeOnSubmit,
  openDay,
  liveFor,
};
