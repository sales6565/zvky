/* AN APPROVED VACATION FILLS THE TIMESHEET IN, AS LEAVE.
 *
 * ===========================================================================
 * WHAT THE OWNER ASKED FOR, and the whole of it: "if a user's Vacation is
 * approved, automatically fill their timesheet as a leave". Somebody who is
 * away for a fortnight should not come back to fourteen empty days, a
 * previous-day gate that will not let them start work, and a fortnight of
 * submissions to make for time they were not here for.
 *
 * ===========================================================================
 * WHAT IS CREATED, AND WHEN.
 *
 * For each WORKING day the vacation covers — src/vacation.js daysOf() already
 * decides which those are, skipping weekly offs and holidays — ONE Leave line
 * on that person's timesheet, for the studio's full-day hours, noted "Vacation
 * (approved)", with no client and no project. The day is then marked submitted
 * by the system.
 *
 * NEVER BEFORE THE DAY ARRIVES. On approval, the days that are already today
 * or past are filled in; every later day waits for its own morning. That is not
 * tidiness — a fortnight of rows written in advance is a fortnight of rows to
 * find and remove if the vacation is cancelled on the third day, and anything
 * missed is a submitted day of leave for time somebody actually worked. The
 * sweep below brings each day in as it comes, which makes the stale row
 * impossible rather than merely unlikely.
 *
 * ===========================================================================
 * WHAT IS NEVER TOUCHED.
 *
 *   A DAY WITH A LINE ON IT ALREADY. If the person has filed anything for that
 *   day, this writes nothing: their record of their own day wins over an
 *   inference from a date range. Listed in the audit entry as skipped, with
 *   why, so it is visible rather than silent.
 *
 *   A DAY THEY SUBMITTED THEMSELVES. Same reason, and submitting is the
 *   stronger statement of the two.
 *
 *   A DAY THAT IS NOT A WORKING DAY. daysOf() has already dropped it.
 *
 *   THE PAST, ON CANCELLATION. A vacation cancelled or ended early clears only
 *   TODAY AND THE DAYS AFTER IT. The days already lived through stay exactly as
 *   recorded — rewriting them would be editing history, and the person was in
 *   fact away for them. The brief says this in those words and it is the rule
 *   with the most ways to get it subtly wrong, so it is one function, here.
 *
 *   ANY LINE A PERSON TYPED. Every statement in this module is keyed on
 *   `leave_request_id`, which only this module ever sets. A line without one is
 *   not ours and is not read, moved or deleted by anything here.
 *
 * ===========================================================================
 * IT IS NOT WORKED TIME. A Leave line is already excluded from everything that
 * counts work: the timesheet export drops Leave rows outright (NO_ROW in
 * src/timesheet-export.js), nothing about an asset reads the timesheet at all
 * (Time Spent, efficiency, bid-vs-spent, the Artist Report and the P&L all read
 * work_sessions), and a full-day leave day requires no hours, so the
 * exact-hours rule and the previous-day gate have nothing to ask of it. These
 * lines inherit all of that by being ordinary Leave lines; what makes them
 * different is only who wrote them.
 */

const dayStatus = require('./day-status');
const vacation = require('./vacation');
const timesheetGate = require('./timesheet-gate');
const leaveSettings = require('./leave-settings');
const timesheetSettings = require('./timesheet-settings');

/* The note every system line carries, and the words the brief chose. One
   constant so the writer, the reader and the tests cannot disagree. */
const NOTE = 'Vacation (approved)';

/* What the Timesheet and History show in place of a person's name against a
   day the system submitted. */
const SUBMITTED_BY = 'Auto (Vacation)';

/* The category a vacation day is filed under. The studio's own Leave category,
   not one of this feature's — a vacation IS leave, and a second word for it
   would split every figure that groups by category. */
const CATEGORY = 'leave';

/* THE FULL-DAY HOURS, from the studio's setting, with the brief's fallback.
 *
 * Read at the moment a line is written and never again: a line already filed
 * keeps the hours it was filed with, so moving the studio's day from 8 to 9
 * does not silently rewrite last month's leave. That is the same promise every
 * other filed line makes. */
function fullDayHours(settings = null) {
  const s = settings || timesheetSettings.current() || {};
  const n = Number(s.maxDayHours);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/* A HALF DAY IS LEFT TO THE PERSON, and this is the sharpest decision in the
 * module.
 *
 * A vacation can start after lunch, so daysOf() hands back a portion per day.
 * The first design filed half the hours for a half day — arithmetically right,
 * and wrong in practice: this feature SUBMITS the day it fills, a submitted day
 * takes no more lines, and the person who worked the morning would have been
 * locked out of filing the only hours on that day that were theirs. Four hours
 * of leave, submitted, and a morning's work with nowhere to go.
 *
 * So a part day is skipped and named as skipped. The person files their own
 * half and submits the day themselves, which is what they would have done
 * before this feature existed — and the brief's own wording is "hours = the
 * full-day required hours setting", which is a rule about full days. */
const isFullDay = (portion) => portion === dayStatus.PORTIONS.full;

const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

/* A DATE COLUMN AS 'YYYY-MM-DD', WHATEVER THE DRIVER HANDED BACK.
 *
 * src/db.js asks mysql2 for `dateStrings: ['DATE']`, so in the application a
 * DATE arrives as a string and slicing ten characters off it is right. It is
 * not right for every caller: a handle built another way — which is how the
 * tests drive this module against their own database — hands back a Date, and
 * String(new Date(...)).slice(0, 10) is 'Mon Nov 0'.
 *
 * THE COST OF GETTING THIS WRONG IS NOT A CRASH, which is why it is a function
 * with a comment rather than an inline slice. A mis-keyed date means the lookup
 * for "is our line already on this day" never matches, so every sweep writes
 * the day again: duplicate leave lines, multiplying every minute, found by the
 * idempotency test and by nothing else. */
function isoDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value === undefined || value === null ? '' : value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

const isOn = () => {
  const s = leaveSettings.current() || {};
  return s.vacationAutoTimesheet !== false;
};

/* ---- reading what is already there -------------------------------------- */

/* Every line on this person's day, split into ours and theirs.
 *
 * ONE QUERY FOR THE WHOLE RANGE rather than one per day: a fortnight's
 * vacation would otherwise be fourteen round trips every time the sweep runs,
 * on every person who is away. */
async function linesIn(db, userId, dates) {
  if (!dates.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, entry_date AS entryDate, leave_request_id AS requestId
       FROM timesheet_entries
      WHERE user_id = $1 AND entry_date IN ($2)`,
    [userId, dates]
  );
  const by = new Map();
  for (const row of rows) {
    const date = isoDate(row.entryDate);
    if (!date) continue;
    if (!by.has(date)) by.set(date, []);
    by.get(date).push(row);
  }
  return by;
}

async function daysIn(db, userId, dates) {
  if (!dates.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, work_date AS workDate, status, auto_submitted AS autoSubmitted
       FROM timesheet_days
      WHERE user_id = $1 AND work_date IN ($2)`,
    [userId, dates]
  );
  return new Map(rows.map((r) => [isoDate(r.workDate), r]).filter(([d]) => d));
}

/* ---- filling in --------------------------------------------------------- */

/* THE DAYS OF A REQUEST THAT ARE DUE: working days at or before today.
 *
 * `daysOf` is src/vacation.js's, so which days a vacation covers is decided in
 * exactly one place and this one does not re-derive weekends or holidays. */
function dueDays(request, now = Date.now(), options = {}) {
  const today = timesheetGate.istDate(now);
  return vacation.daysOf(request, options).filter((d) => d.date <= today);
}

/* Fill in one approved vacation, as far as today.
 *
 * IDEMPOTENT, and that is what makes the sweep safe to run every minute and
 * safe to run twice at once: a day that already has OUR line is left alone, and
 * the insert names the day it is for, so a second process doing the same work
 * finds the same rows. Returns what it did and what it left, which is what the
 * audit entry is made of. */
async function fill(db, request, { now = Date.now(), settings = null,
  loggableDays = null, isHoliday = null } = {}) {
  const created = [];
  const skipped = [];
  if (!request || !request.userId) return { created, skipped };
  if (!vacation.LIVE.includes(request.status)) {
    return { created, skipped, reason: 'not an approved vacation' };
  }
  if (!isOn()) return { created, skipped, reason: 'switched off' };

  const due = dueDays(request, now, { loggableDays, isHoliday });
  if (!due.length) return { created, skipped };
  const dates = due.map((d) => d.date);

  let existing;
  let days;
  try {
    existing = await linesIn(db, request.userId, dates);
    days = await daysIn(db, request.userId, dates);
  } catch (err) {
    if (unavailable(err)) return { created, skipped, reason: 'timesheet tables are not there' };
    throw err;
  }

  const hours = fullDayHours(settings);
  const crypto = require('node:crypto');

  for (const day of due) {
    const theirs = (existing.get(day.date) || []);
    if (theirs.some((l) => l.requestId === request.id)) continue; // already ours
    /* A LINE SOMEBODY TYPED. Theirs wins — this writes nothing and says so. */
    if (theirs.length) { skipped.push({ date: day.date, why: 'the day already has lines on it' }); continue; }
    /* A PART DAY IS THEIRS TO FILE. See isFullDay() above: filling and
       submitting half a day would lock the person out of the half they
       worked. */
    if (!isFullDay(day.portion)) {
      skipped.push({ date: day.date, why: 'a half day — the other half is theirs to file' });
      continue;
    }
    const existingDay = days.get(day.date);
    if (existingDay && existingDay.status !== 'draft' && !Number(existingDay.autoSubmitted)) {
      skipped.push({ date: day.date, why: `the day is already ${existingDay.status}` });
      continue;
    }

    try {
      await db.query(
        `INSERT INTO timesheet_entries
           (id, user_id, entry_date, non_project, hours, notes, leave_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), request.userId, day.date, CATEGORY, hours, NOTE, request.id]
      );
    } catch (err) {
      if (unavailable(err)) return { created, skipped, reason: 'timesheet tables are not there' };
      throw err;
    }
    await submitDay(db, request.userId, day.date);
    created.push(day.date);
  }
  return { created, skipped };
}

/* THE DAY, SUBMITTED BY THE SYSTEM.
 *
 * `auto_submitted` is what tells this apart from a person pressing Submit, and
 * it is what lets the removal below know which submissions are ours to reopen.
 * ON DUPLICATE KEY, because the day row may already exist as a draft. */
async function submitDay(db, userId, date) {
  const crypto = require('node:crypto');
  await db.query(
    `INSERT INTO timesheet_days (id, user_id, work_date, status, submitted_at, auto_submitted)
     VALUES ($1,$2,$3,'submitted',NOW(),1)
     ON DUPLICATE KEY UPDATE status = 'submitted', submitted_at = NOW(), auto_submitted = 1`,
    [crypto.randomUUID(), userId, date]
  ).catch((err) => { if (!unavailable(err)) throw err; });
}

/* ---- taking it back ----------------------------------------------------- */

/* Remove this vacation's system lines from TODAY ONWARDS, and nothing else.
 *
 * THE PAST STAYS. A vacation cancelled on Wednesday does not un-say that
 * Monday and Tuesday were leave — the person was away for them, the days are
 * submitted, and rewriting a submitted past is the one thing this feature must
 * never do. The brief is explicit and this is the function that keeps it.
 *
 * ONLY OUR LINES, and only our submissions: `leave_request_id` and
 * `auto_submitted` are set by this module and by nothing else, so a day the
 * person filed or submitted themselves is untouched even if it falls inside the
 * range.
 */
async function clear(db, request, { now = Date.now(), from = null } = {}) {
  if (!request || !request.id || !request.userId) return { removed: [], reopened: [] };
  const today = timesheetGate.istDate(now);
  const edge = from && from > today ? from : today;

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, entry_date AS entryDate FROM timesheet_entries
        WHERE leave_request_id = $1 AND user_id = $2 AND entry_date >= $3`,
      [request.id, request.userId, edge]
    ));
  } catch (err) {
    if (unavailable(err)) return { removed: [], reopened: [] };
    throw err;
  }
  if (!rows.length) return { removed: [], reopened: [] };

  const dates = [...new Set(rows.map((r) => isoDate(r.entryDate)).filter(Boolean))];
  await db.query(
    `DELETE FROM timesheet_entries
      WHERE leave_request_id = $1 AND user_id = $2 AND entry_date >= $3`,
    [request.id, request.userId, edge]
  );

  /* AND THE SUBMISSION THAT WENT WITH IT. Only where the system made it: a day
     the person had submitted themselves before the vacation existed keeps its
     submission, because it was never ours to undo. The day goes back to draft
     rather than being deleted, so an admin reading the week sees an empty day
     and not a missing one. */
  const reopened = [];
  for (const date of dates) {
    const { result } = await db.query(
      `UPDATE timesheet_days SET status = 'draft', submitted_at = NULL, auto_submitted = NULL
        WHERE user_id = $1 AND work_date = $2 AND auto_submitted = 1`,
      [request.userId, date]
    ).catch(() => ({ result: null }));
    if (result && result.affectedRows) reopened.push(date);
  }
  return { removed: dates, reopened };
}

/* ---- the sweep ---------------------------------------------------------- */

/* Every live vacation whose days have started arriving, filled in as far as
 * today. Driven by the database rather than by anything held in memory, so it
 * is restart-safe by construction and two processes running it at once do the
 * same idempotent work.
 *
 * Called from the minute tick in src/work-log.js, beside the leave sweep that
 * stops running timers — the two answer the same question about the same
 * people, one for the clock and one for the sheet.
 */
async function sweep(db, { now = Date.now(), log = null, userId = null } = {}) {
  if (!isOn()) return [];
  const today = timesheetGate.istDate(now);
  let rows;
  try {
    /* THE COLUMNS ARE from_date AND to_date, and leave_requests holds only
       vacations — there is no `kind` to filter on. Taken from src/vacation.js's
       own queries rather than guessed; the guess cost a run, and silently,
       because an unknown column reads as "the table is not there" to the
       tolerance below and the sweep would have gone on returning nothing.
       
       THE WINDOW IS THE REQUEST'S OWN END, not a fixed look-back: a vacation
       that ended early is cut by `ended_on`, which is what src/vacation.js
       reads everywhere else. */
    ({ rows } = await db.query(
      `SELECT id, user_id AS userId,
              DATE_FORMAT(from_date, '%Y-%m-%d') AS \`from\`,
              DATE_FORMAT(COALESCE(ended_on, to_date), '%Y-%m-%d') AS \`to\`,
              from_portion AS fromPortion, to_portion AS toPortion, status, note
         FROM leave_requests
        WHERE status IN ($1) AND from_date <= $2
          ${userId ? 'AND user_id = $3' : ''}`,
      userId ? [vacation.LIVE, today, userId] : [vacation.LIVE, today]
    ));
  } catch (err) {
    if (unavailable(err)) return [];
    throw err;
  }

  const done = [];
  for (const row of rows) {
    const made = await fill(db, { ...row, id: row.id, userId: row.userId }, { now })
      .catch((err) => {
        if (log) log(`[vacation] timesheet fill failed for ${row.id}: ${err.sqlMessage || err.message}`);
        return { created: [], skipped: [] };
      });
    if (made.created.length) {
      done.push({ requestId: row.id, userId: row.userId, created: made.created, skipped: made.skipped });
      if (log) {
        log(`[vacation] filled ${made.created.length} leave day(s) for ${row.userId} `
          + `from request ${row.id}.`);
      }
    }
  }
  return done;
}

module.exports = {
  NOTE, SUBMITTED_BY, CATEGORY, isoDate,
  fullDayHours, isFullDay, dueDays,
  fill, clear, sweep, submitDay, isOn,
};
