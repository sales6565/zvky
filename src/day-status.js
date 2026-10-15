/* WHAT KIND OF DAY DID THIS PERSON HAVE: leave, idle, or an ordinary one.
 *
 * ===========================================================================
 * THE NAME, FIRST, BECAUSE "IDLE" IS ALREADY TAKEN.
 *
 * src/idle.js is a REPORT. Its "idle" is a measured quantity — the working
 * hours in a period during which somebody had nothing open — computed from
 * coverage and never recorded anywhere. This module's "idle" is a MARK: a lead
 * saying "this person has nothing to do today". Two different ideas with one
 * word between them, and conflating them would mean a report quietly reading a
 * lead's opinion as a measurement. So nothing here is called `idle.js`, nothing
 * there changes, and the report's own caveats still say what it cannot see.
 *
 * ===========================================================================
 * THE SHARED DEFINITIONS, which is what this file is for. Each of these is
 * stated once and called everywhere; none of them is restated in a route, in
 * the page, or in a test fixture.
 *
 *   userDayStatus()          what is recorded for one person on one day
 *   statusesFor()            the same for a list, in ONE query — the follow-up
 *                            section draws 116 rows and may not ask 116 times
 *   leaveWindows()           the instants a leave covers, FROM THE SNAPSHOT
 *   countedMs()              Prompt 40's working-time intersection MINUS those
 *                            windows. Every hour this application counts comes
 *                            through here.
 *   expectedWorkingMinutes() what the day asked of them, after leave
 *   isTimesheetRequired()    whether they owe a timesheet for it
 *   isExpectedToWorkAt()     whether they should be at the desk at an instant.
 *                            The "not started" judgement, the nudges, the
 *                            Remind action and the emails all ask this.
 *   onAssigned()             the idle auto-clear, called from assignments.open()
 *                            so that no assign path can forget it
 *
 * ===========================================================================
 * WHY THE WINDOW IS READ FROM THE ROW AND NEVER FROM THE SETTINGS.
 *
 * A half-day is "until the split", and the split is a setting a Super Admin can
 * move. If leaveWindows() read the live setting, moving the split at four
 * o'clock would change what every half-day in the studio's history had meant —
 * last month's totals would differ from the figures somebody already signed
 * off. So the window is SNAPSHOTTED onto the row when the row is made, this
 * function reads the snapshot, and src/leave-settings.js re-snapshots only rows
 * dated strictly after today when the split moves.
 *
 * ===========================================================================
 * WHY "DISABLED" IS NEVER ASKED HERE.
 *
 * leaveIdleEnabled() governs whether a row may be CREATED. It has no bearing on
 * what an existing row means, because a switch whose effect is to change last
 * month's recorded hours is not a switch, it is a time machine. See the header
 * of src/leave-settings.js. Every function in this file reads rows; none of
 * them asks the setting. The route that creates rows asks it, once.
 */

const workingTime = require('./working-time');
const workSchedule = require('./work-schedule');
const leaveSettings = require('./leave-settings');
const timesheetGate = require('./timesheet-gate');
const holidays = require('./holidays');
const workflow = require('./asset-workflow');
const { v4: uuid } = require('uuid');

const KINDS = { leave: 'leave', idle: 'idle' };
const PORTIONS = { full: 'full', first_half: 'first_half', second_half: 'second_half' };
const SOURCES = { manual: 'manual' };

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const IST_OFFSET_MS = workingTime.IST_OFFSET_MINUTES * MS_PER_MINUTE;

/* ---------------------------------------------------------------------------
 * WHAT COUNTS AS WORK THIS PERSON COULD BE DOING, which is the whole of the
 * Idle button's precondition.
 *
 * DERIVED, NOT WRITTEN OUT. Two lists already answer halves of this question
 * and both live in src/asset-workflow.js:
 *
 *   ASSIGNEE_STATUSES  the stages that are the ASSIGNEE'S to move — which is
 *                      where not_started comes from: an asset handed to
 *                      somebody who has not accepted it yet is still work they
 *                      have.
 *   WORKING_STATUSES   the stages where the clock can run (= /start's
 *                      STARTABLE, = the hold list) — which is where the three
 *                      rework stages come from.
 *
 * Their union is "a stage at which this person has something to do", and
 * deriving it means a studio that adds a stage to either list gets it here
 * without anybody remembering to. Writing the six names out again would be a
 * third copy of a list this codebase has already been bitten by duplicating —
 * see the note above FREE_STATUSES.
 *
 * ON HOLD IS NOT A STATUS. The brief asks for "On Hold if relevant": in this
 * application holding is a property of the SESSION, not of the asset, so an
 * asset whose timer is paused is still sitting in one of these stages and is
 * still the person's to pick up. It counts, and it counts without a special
 * case.
 *
 * OUTSOURCED WORK IS NOT COUNTED, and it falls out rather than being excluded:
 * an outsourced asset has assignee_id NULL (src/outsource.js's exclusivity
 * rule), so it is nobody's actionable work.
 */
const ACTIONABLE_STATUSES = [...new Set([
  ...workflow.ASSIGNEE_STATUSES,
  ...workflow.WORKING_STATUSES,
])];

const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/* The IST midnight that opens a calendar date, as an instant. The one
   conversion in this file, and it is the same arithmetic src/work-log.js and
   src/working-time.js use. */
const startOfDay = (date) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;

/* ---------------------------------------------------------------------------
 * READING THE ROWS.
 */
/* `portion` is BACK-TICKED EVERYWHERE: it is reserved in MariaDB 10.4 and
   later (FOR PORTION OF, for application-time period tables), and unquoted it
   fails the statement outright. */
const SELECT = `SELECT s.id, s.user_id AS userId, DATE_FORMAT(s.\`date\`, '%Y-%m-%d') AS \`date\`,
       s.kind, s.\`portion\` AS \`portion\`, s.window_start_time AS windowStart, s.window_end_time AS windowEnd,
       s.note, s.set_by AS setBy, s.set_at AS setAt, s.source,
       u.\`name\` AS setByName
  FROM user_day_status s
  LEFT JOIN users u ON u.id = s.set_by`;

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    date: row.date,
    kind: row.kind,
    portion: row.portion || null,
    windowStart: row.windowStart === null || row.windowStart === undefined
      ? null : Number(row.windowStart),
    windowEnd: row.windowEnd === null || row.windowEnd === undefined
      ? null : Number(row.windowEnd),
    note: row.note || null,
    setBy: row.setBy || null,
    setByName: row.setByName || null,
    setAt: row.setAt ? new Date(row.setAt).toISOString() : null,
    source: row.source || SOURCES.manual,
    planned: (row.source || SOURCES.manual) !== SOURCES.manual,
  };
}

/* ONE QUERY FOR A WHOLE LIST, which is the shape the follow-up section needs:
   116 people and one round trip. Keyed `userId|date` so a caller walking rows
   does a map lookup and never a second query. */
async function statusesFor(db, userIds, from, to = from) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length || !isDate(from) || !isDate(to)) return out;
  const { rows } = await db.query(
    `${SELECT} WHERE s.cleared_at IS NULL AND s.user_id IN ($1)
       AND s.\`date\` >= $2 AND s.\`date\` <= $3`,
    [ids, from, to]
  ).catch((err) => {
    /* An unmigrated deployment has no leave at all, which is the truthful
       reading: it cannot have marked anybody. Never a reason to refuse to draw
       the list. */
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  for (const row of rows) out.set(`${row.userId}|${row.date}`, shape(row));
  return out;
}

async function userDayStatus(db, userId, date) {
  if (!userId || !isDate(date)) return null;
  const map = await statusesFor(db, [userId], date);
  return map.get(`${userId}|${date}`) || null;
}

/* Everybody marked on one date, for the strip under the lists. */
async function markedOn(db, date) {
  if (!isDate(date)) return [];
  const { rows } = await db.query(
    `${SELECT} , (SELECT \`name\` FROM users WHERE id = s.user_id) AS personName
       WHERE s.cleared_at IS NULL AND s.\`date\` = $1
       ORDER BY s.kind, s.set_at`,
    [date]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  return rows.map((r) => ({ ...shape(r), name: r.personName || null }));
}

/* ---------------------------------------------------------------------------
 * THE WINDOWS A LEAVE COVERS, as instants.
 *
 * [] for no leave and for idle — IDLE EXCLUDES NO TIME. It says "there is
 * nothing to do", not "do not count what was done"; somebody marked idle who
 * then works an hour has worked an hour, and pretending otherwise would be this
 * module deciding that a lead's guess outranks a recorded session.
 *
 * ONE INTERVAL, NEVER TWO. A full day is the whole calendar date; a half day is
 * one end of it. The windows are deliberately WIDE — first half is midnight to
 * the split rather than the studio's opening to the split — because time
 * outside working hours is already excluded by the working-time helper, and
 * narrowing them here would be a second, weaker copy of that rule that could
 * disagree with it the day somebody changes the schedule.
 */
function windowsFromRow(row) {
  if (!row || row.kind !== KINDS.leave) return [];
  const base = startOfDay(row.date);
  if (!Number.isFinite(base)) return [];
  if (row.portion === PORTIONS.full || row.windowStart === null || row.windowEnd === null) {
    return [{ from: base, to: base + MS_PER_DAY }];
  }
  const from = base + row.windowStart * MS_PER_MINUTE;
  const to = base + row.windowEnd * MS_PER_MINUTE;
  return to > from ? [{ from, to }] : [];
}

async function leaveWindows(db, userId, date) {
  return windowsFromRow(await userDayStatus(db, userId, date));
}

/* ---------------------------------------------------------------------------
 * THE ONE PLACE HOURS ARE COUNTED.
 *
 *   countedMsByDay(span) = workingMsByDay(span) - workingMsByDay(span ∩ leave)
 *
 * Written as a subtraction over the SAME function rather than as a second walk
 * that knows about both, so there is exactly one piece of code in this
 * application that decides what "inside working hours" means, and leave is a
 * thing removed from its answer rather than a competing opinion about it.
 *
 * `windows` is handed in — a Map from statusesFor(), or nothing. The callers
 * that count one person's day fetch it themselves; the callers that count four
 * hundred assets fetch it once for everybody involved. Neither asks per row.
 */
function countedMsByDay(startMs, endMs, { schedule = workSchedule.trackingWindow(), windows = [] } = {}) {
  const gross = workingTime.workingMsByDay(startMs, endMs, schedule);
  if (!windows.length) return gross;
  const byDay = new Map(gross.byDay);
  let total = gross.total;
  for (const w of windows) {
    const from = Math.max(Number(startMs), w.from);
    const to = Math.min(Number(endMs), w.to);
    if (to <= from) continue;
    const inside = workingTime.workingMsByDay(from, to, schedule);
    total -= inside.total;
    for (const [day, ms] of inside.byDay) {
      const left = (byDay.get(day) || 0) - ms;
      if (left > 0) byDay.set(day, left); else byDay.delete(day);
    }
  }
  return { total: Math.max(0, total), byDay };
}

/* The same answer as a single number of seconds, which is what work_sessions
   stores and what every "how long did this take" figure is. */
function countedSeconds(startMs, endMs, opts) {
  return Math.round(countedMsByDay(startMs, endMs, opts).total / 1000);
}

/* THE WINDOWS COVERING A SPAN, for one person — the fetch the two functions
   above expect to be handed. Walks the calendar dates the span touches, which
   is at most a handful for a session and is capped for a pathological one. */
const MAX_SPAN_DAYS = 400;
async function windowsForSpan(db, userId, startMs, endMs) {
  if (!userId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const first = workingTime.istPartsOf(startMs).day;
  const last = workingTime.istPartsOf(endMs).day;
  if (last - first > MAX_SPAN_DAYS) return [];
  const from = workingTime.istDateOf(first);
  const to = workingTime.istDateOf(last);
  const map = await statusesFor(db, [userId], from, to);
  const out = [];
  for (const row of map.values()) out.push(...windowsFromRow(row));
  return out;
}

/* The convenience the hot paths do NOT use: one person, one span, one query.
   Used where a single session is being closed or a single day totalled. */
async function countedMs(db, { userId, from, to, schedule = workSchedule.trackingWindow() }) {
  const windows = await windowsForSpan(db, userId, from, to);
  return countedMsByDay(from, to, { schedule, windows });
}

/* ---------------------------------------------------------------------------
 * HOW MUCH THE DAY ASKED OF THEM.
 *
 * The studio's working minutes on that date, less whatever the leave covers.
 * Zero on a full day, zero on a weekend or a holiday — and zero for the same
 * reason in all three: there was nothing to be at the desk for.
 */
async function expectedWorkingMinutes(db, userId, date, { schedule = workSchedule.trackingWindow() } = {}) {
  if (!isDate(date)) return 0;
  const base = startOfDay(date);
  const windows = windowsFromRow(await userDayStatus(db, userId, date));
  return Math.round(countedMsByDay(base, base + MS_PER_DAY, { schedule, windows }).total / MS_PER_MINUTE);
}

/* ---------------------------------------------------------------------------
 * DOES THIS PERSON OWE A TIMESHEET FOR THIS DAY.
 *
 * FALSE on a weekend, on a holiday and on a FULL day's leave — nothing
 * happened, so there is nothing to write down.
 *
 * TRUE on a half day, because they worked the other half and that half is
 * exactly what the timesheet is for. A half-day that excused the timesheet
 * would lose the morning's work from every report that reads these lines.
 *
 * TRUE on an idle day, and this is the decision the brief asked to be stated.
 * Idle says there was nothing to pick up, not that the person was absent: they
 * were at the desk, the day is a working day, and "I had no work" is itself
 * something a studio wants recorded rather than inferred from a blank.
 *
 * The weekend and holiday halves are ASKED OF src/timesheet-gate.js rather than
 * decided here — it is the module that owns "is this a working day" and it
 * already reads the holiday calendar from Prompt 22.
 */
async function isTimesheetRequired(db, userId, date, { settings = null, isHoliday = null } = {}) {
  if (!isDate(date)) return false;
  const loggableDays = (settings && settings.loggableDays)
    || require('./timesheet-settings').current().loggableDays;
  const holiday = isHoliday || ((d) => Boolean(holidays.on(d)));
  if (!timesheetGate.isWorkingDay(date, { loggableDays, isHoliday: holiday })) return false;
  return timesheetRequiredFromRow(await userDayStatus(db, userId, date));
}

/* ---------------------------------------------------------------------------
 * SHOULD THIS PERSON BE AT THE DESK AT THIS INSTANT.
 *
 * The single judgement behind "not started", behind both automatic nudges,
 * behind the Remind action and behind the emails. Four reasons it can be false
 * and they are asked in the order that costs least:
 *
 *   outside the studio's recording windows   isRecording() — which is also what
 *                                            makes lunch false, because lunch
 *                                            is the gap between two windows and
 *                                            not a flag
 *   not a working day / a holiday            timesheet-gate, the owner of that
 *   inside a leave window                    this module
 *
 * A FIRST-HALF PERSON IS NOT "NOT STARTED" BEFORE THE SPLIT, and a second-half
 * person is judged normally until it and not after. That falls out of the
 * window rather than being written as two cases.
 */
async function isExpectedToWorkAt(db, userId, at, {
  schedule = workSchedule.trackingWindow(), settings = null, isHoliday = null, row = undefined,
} = {}) {
  const now = Number(at);
  if (!Number.isFinite(now)) return false;
  if (!workingTime.isRecording(now, schedule)) return false;
  const date = timesheetGate.istDate(now);
  const loggableDays = (settings && settings.loggableDays)
    || require('./timesheet-settings').current().loggableDays;
  const holiday = isHoliday || ((d) => Boolean(holidays.on(d)));
  if (!timesheetGate.isWorkingDay(date, { loggableDays, isHoliday: holiday })) return false;
  const status = row === undefined ? await userDayStatus(db, userId, date) : row;
  return expectedToWorkFromRow(status, now);
}

/* ---------------------------------------------------------------------------
 * THE SAME THREE JUDGEMENTS, FROM A ROW ALREADY IN HAND.
 *
 * The async functions above are the definition for one person; these are the
 * definition for a list, and they are not a second copy of it — the async ones
 * CALL these, having fetched the row, and the follow-up section calls these
 * directly, having fetched 116 rows in one query. One rule, two fetch
 * strategies, and a test asserts the pair agree on every portion.
 */

/* IS THIS A MOMENT THEY SHOULD BE AT THE DESK, as far as the MARK is concerned.
   Leave only. Idle is deliberately not here: somebody idle is at work, they
   simply have nothing to pick up, and a function that said otherwise would
   excuse them from the timesheet too. */
function expectedToWorkFromRow(row, at) {
  const now = Number(at);
  return !windowsFromRow(row).some((w) => now >= w.from && now < w.to);
}

function insideLeaveWindow(row, at) {
  return !expectedToWorkFromRow(row, at);
}

/* NOTHING TO START, which is a different sentence from "not here". It is what
   the start nudges, the start reminder and list 1 skip somebody for; the
   timesheet reminder and list 2 do not, because a day with no work in it still
   has to be written down. */
function nothingToStart(row) {
  return Boolean(row && row.kind === KINDS.idle);
}

/* DOES THIS PERSON OWE A TIMESHEET, given the day is already known to be a
   working day. Full-day leave is the only excuse: a half day worked the other
   half, and an idle day was still a day at the desk. */
function timesheetRequiredFromRow(row) {
  return !(row && row.kind === KINDS.leave && row.portion === PORTIONS.full);
}

/* When the current leave window ends, as an instant, or null. What the refusal
   sentence names: "You're on leave until 14:00". */
function leaveEndsAt(row, at) {
  const now = Number(at);
  for (const w of windowsFromRow(row)) if (now >= w.from && now < w.to) return w.to;
  return null;
}

/* ---------------------------------------------------------------------------
 * ACTIONABLE WORK, for the Idle precondition and its server re-check.
 */
/* THE ASSETS THEMSELVES, for the "Reassign assets" offer after a full day's
 * leave. The same predicate as the count below — ACTIONABLE_STATUSES — so the
 * number the Idle button reads and the list this offers cannot disagree. */
async function actionableAssets(db, userId) {
  if (!userId) return [];
  const { rows } = await db.query(
    `SELECT a.id, a.\`code\`, a.\`name\`, a.\`status\`, a.project_id AS projectId,
            p.\`name\` AS projectName
       FROM assets a
       LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.assignee_id = $1 AND a.\`status\` IN ($2)
      ORDER BY a.\`code\`, a.\`name\``,
    [userId, ACTIONABLE_STATUSES]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  return rows.map((r) => ({
    id: r.id, code: r.code || null, name: r.name,
    status: r.status, statusLabel: workflow.label(r.status),
    projectId: r.projectId || null, projectName: r.projectName || null,
  }));
}

async function actionableCount(db, userId) {
  if (!userId) return 0;
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM assets
      WHERE assignee_id = $1 AND status IN ($2)`,
    [userId, ACTIONABLE_STATUSES]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [{ n: 0 }] };
  });
  return Number(rows[0].n) || 0;
}

/* ---------------------------------------------------------------------------
 * WRITING.
 *
 * MARKING REPLACES. One active row per person per day is the rule, so marking
 * something else clears what was there and keeps it in the table as history —
 * the row is not updated in place, because "they were on first-half leave and
 * then somebody changed it to full" is a thing an audit should be able to see.
 *
 * THE UNIQUE KEY IS THE GUARANTEE, not the clear above it. Two leads marking
 * one person in the same second both read "nothing recorded" and both insert;
 * the clear-then-insert pair cannot close that gap and does not pretend to. The
 * key on (user_id, active_date) does, and the duplicate error is caught and
 * answered rather than thrown.
 */
const DUPLICATE = (err) => err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);

async function clearRow(db, { userId, date, clearedBy, reason }) {
  const { result } = await db.query(
    `UPDATE user_day_status
        SET cleared_at = NOW(), cleared_by = $1, clear_reason = $2
      WHERE user_id = $3 AND \`date\` = $4 AND cleared_at IS NULL`,
    [clearedBy || null, (reason || '').slice(0, 255) || null, userId, date]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { result: { affectedRows: 0 } };
  });
  return Number((result && result.affectedRows) || 0);
}

async function mark(db, { userId, date, kind, portion = null, note = null, setBy = null,
  source = SOURCES.manual, schedule = workSchedule.current() }) {
  if (!userId || !isDate(date) || !KINDS[kind]) return { ok: false, code: 'bad_request' };
  if (kind === KINDS.leave && !PORTIONS[portion]) return { ok: false, code: 'bad_portion' };

  const sp = leaveSettings.split({ schedule });
  const win = kind === KINDS.leave ? leaveSettings.windowFor(portion, sp) : null;

  /* MARKING THE SAME THING TWICE IS A NO-OP, checked before the clear so that a
     double-click does not turn one row into two history rows that say the same
     thing. */
  const existing = await userDayStatus(db, userId, date);
  if (existing && existing.kind === kind && (existing.portion || null) === (portion || null)) {
    return { ok: true, unchanged: true, row: existing };
  }

  await clearRow(db, { userId, date, clearedBy: setBy, reason: `replaced by ${kind}` });
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO user_day_status
         (id, user_id, \`date\`, kind, \`portion\`, window_start_time, window_end_time,
          note, set_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, userId, date, kind, kind === KINDS.leave ? portion : null,
        win ? win.start : null, win ? win.end : null,
        note ? String(note).slice(0, 500) : null, setBy || null, source]
    );
  } catch (err) {
    if (DUPLICATE(err)) return { ok: false, code: 'race' };
    if (unavailable(err)) return { ok: false, code: 'unavailable' };
    throw err;
  }
  return { ok: true, row: await userDayStatus(db, userId, date), replaced: existing };
}

async function clear(db, { userId, date, clearedBy = null, reason = 'undone' }) {
  const existing = await userDayStatus(db, userId, date);
  if (!existing) return { ok: true, unchanged: true, row: null };
  await clearRow(db, { userId, date, clearedBy, reason });
  return { ok: true, row: null, cleared: existing };
}

/* ---------------------------------------------------------------------------
 * THE IDLE AUTO-CLEAR.
 *
 * CALLED FROM src/assignments.js's open(), which is the ONE function every
 * assign path in this application goes through — the single asset dropdown, the
 * bulk assign, the reassign, the create-with-assignee and the history repair.
 * Putting it there rather than at the five call sites means the sixth path
 * somebody adds later is covered without them having to remember, which is the
 * same argument that file already makes for raising notifications there.
 *
 * IT NEVER BLOCKS AND IT NEVER THROWS. An assignment that failed because an
 * idle mark could not be cleared would be a worse bug than a stale mark, and
 * the mark is cosmetic beside the assignment. Idle does not gate assignment,
 * does not gate starting work, and is not consulted by either.
 *
 * SAME TRANSACTION as the assignment, because `db` here is the caller's
 * connection. A mark cleared in a transaction that then rolls back must come
 * back, and it does.
 */
async function onAssigned(db, userId, assetId, { now = Date.now() } = {}) {
  if (!userId) return false;
  const date = timesheetGate.istDate(now);
  try {
    const { result } = await db.query(
      `UPDATE user_day_status
          SET cleared_at = NOW(), cleared_by = NULL,
              clear_reason = $1
        WHERE user_id = $2 AND \`date\` = $3 AND kind = '${KINDS.idle}' AND cleared_at IS NULL`,
      [`assigned ${assetId || 'an asset'}`.slice(0, 255), userId, date]
    );
    return Number((result && result.affectedRows) || 0) > 0;
  } catch (err) {
    if (unavailable(err)) return false;
    /* Swallowed for the reason above: this is told to nobody and blocks
       nothing. Logged so a studio whose table is broken finds out. */
    console.warn('[day-status] idle auto-clear failed:', err.message);
    return false;
  }
}


/* ---------------------------------------------------------------------------
 * PUTTING THE TIMERS DOWN, AND KEEPING THE CACHED FIGURES HONEST.
 *
 * Two jobs that both follow from a mark, written here rather than in the route
 * because the sweep below runs them for rows nobody has just marked: a
 * second-half leave recorded at ten in the morning has to stop a timer at two,
 * and nothing is going to call the route at two.
 */

/* EVERY OPEN SESSION BELONGING TO SOMEBODY INSIDE A LEAVE WINDOW, put down at
 * the moment the window began.
 *
 * `at` is what makes the stop exact however late the sweep is — the same
 * mechanism pauseOverdue() uses for the seven o'clock cutoff, and for the same
 * reason. A sweep that ran five minutes late would otherwise record five
 * minutes of a window that is supposed to record nothing.
 *
 * A SESSION STARTED YESTERDAY AND STILL RUNNING IS STOPPED TOO, and its earlier
 * portion keeps counting under the ordinary rules: close() stores
 * countedSeconds over the whole span, which subtracts the window and nothing
 * else.
 *
 * NOT RESUMED AFTERWARDS. The reason written is REASONS.on_leave, and
 * resumeOverdue() picks up off_hours and only off_hours, so a leave pause is
 * invisible to it. The person starts again themselves, which is what the brief
 * asked for.
 */
async function sweepLeave(db, { now = Date.now(), log = null } = {}) {
  const workLog = require('./work-log');
  const index = await liveWindowsNow(db, now);
  if (!index.size) return [];
  let rows = [];
  try {
    const got = await db.query(
      `SELECT w.id, w.asset_id AS assetId, w.user_id AS userId,
              TIMESTAMPDIFF(SECOND, w.started_at, NOW()) AS age_seconds,
              a.\`code\`, a.\`name\`
         FROM work_sessions w
         JOIN assets a ON a.id = w.asset_id
        WHERE w.ended_at IS NULL AND w.user_id IN ($1)`,
      [[...index.keys()]]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return [];
  }

  const stopped = [];
  for (const row of rows) {
    const windows = index.get(row.userId) || [];
    const hit = windows.find((w) => now >= w.from && now < w.to);
    if (!hit) continue;
    const startedAt = now - (Number(row.age_seconds) || 0) * 1000;
    /* Never before the session began: a window that opened this morning and a
       timer started inside it close at the start, not at a stamp before it. */
    const at = Math.max(startedAt, hit.from);
    await workLog.close(db, row.assetId, 'on_leave', null, { at });
    stopped.push({ userId: row.userId, assetId: row.assetId, code: row.code, name: row.name });
  }
  if (stopped.length && log) {
    log(`[leave] stopped ${stopped.length} timer(s) for people on leave.`);
  }
  return stopped;
}

/* Who is inside a leave window at this instant, as intervals. One query, no
   user filter, for the reason liveLeaveIndex gives in src/work-log.js: leave is
   rare and the whole of today's is a handful of rows. */
async function liveWindowsNow(db, now = Date.now()) {
  const today = timesheetGate.istDate(now);
  const yesterday = timesheetGate.shiftDays(today, -1);
  const index = new Map();
  const map = await activeBetween(db, yesterday, today);
  for (const row of map) {
    const wins = windowsFromRow(row).filter((w) => now >= w.from && now < w.to);
    if (wins.length) index.set(row.userId, (index.get(row.userId) || []).concat(wins));
  }
  return index;
}

/* Every active row across a range of dates, for everybody. */
async function activeBetween(db, from, to) {
  if (!isDate(from) || !isDate(to)) return [];
  const { rows } = await db.query(
    `${SELECT} WHERE s.cleared_at IS NULL AND s.\`date\` >= $1 AND s.\`date\` <= $2`,
    [from, to]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  return rows.map(shape);
}

/* ---------------------------------------------------------------------------
 * RECOUNTING THE CACHE.
 *
 * work_sessions.seconds holds countedSeconds() over the session's span, worked
 * out when the session closed. Marking a leave over a day that already has
 * closed sessions makes that figure stale, and undoing the mark makes it stale
 * again in the other direction. So it is RECOMPUTED here, for exactly the
 * sessions the date touches, on every mark and every undo.
 *
 * THIS IS WHY "UNDO RESTORES EXACTLY THE PREVIOUS NUMBERS" is a fact rather
 * than a hope: the recount does not remember what the figure used to be, it
 * derives it again from the two stamps and whatever leave is recorded now. With
 * the leave gone, that is the number that was there before it arrived.
 *
 * NOTHING IS DELETED. The sessions stay, the timesheet lines stay; what changes
 * is one derived column. The brief is explicit about that and so is this.
 */
async function recount(db, { userId, date, schedule = workSchedule.trackingWindow() }) {
  if (!userId || !isDate(date)) return 0;
  const dayStart = startOfDay(date);
  const dayEnd = dayStart + MS_PER_DAY;
  let rows = [];
  try {
    const got = await db.query(
      `SELECT id,
              TIMESTAMPDIFF(SECOND, started_at, NOW()) AS start_age,
              TIMESTAMPDIFF(SECOND, ended_at, NOW()) AS end_age
         FROM work_sessions
        WHERE user_id = $1 AND ended_at IS NOT NULL
          AND started_at < DATE_ADD($2, INTERVAL 1 DAY) AND ended_at > $3`,
      [userId, `${date} 00:00:00`, `${date} 00:00:00`]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return 0;
  }
  if (!rows.length) return 0;

  const now = Date.now();
  let touched = 0;
  for (const row of rows) {
    const from = now - (Number(row.start_age) || 0) * 1000;
    const to = now - (Number(row.end_age) || 0) * 1000;
    if (to <= from) continue;
    /* The whole span, not the part inside the day: a session that straddles
       midnight has one `seconds` figure covering both days, and recomputing it
       from only one of them would lose the other. */
    const windows = await windowsForSpan(db, userId, from, to);
    const seconds = countedSeconds(from, to, { schedule, windows });
    await db.query('UPDATE work_sessions SET seconds = $1 WHERE id = $2', [seconds, row.id])
      .catch(() => {});
    touched += 1;
  }
  return touched;
}

/* HOW MUCH IS ALREADY RECORDED INSIDE A WINDOW, for the confirmation sentence
   "X h Y m already recorded in this period will not be counted". Asked BEFORE
   the mark, from the same arithmetic that will do the removing — so the number
   shown and the number lost cannot differ. */
async function recordedInside(db, { userId, date, portion, schedule = workSchedule.trackingWindow() }) {
  if (!userId || !isDate(date)) return { seconds: 0, sessions: 0 };
  const sp = leaveSettings.split({ schedule: workSchedule.current() });
  const win = leaveSettings.windowFor(portion, sp);
  const base = startOfDay(date);
  const window = win
    ? { from: base + win.start * 60000, to: base + win.end * 60000 }
    : { from: base, to: base + MS_PER_DAY };
  let rows = [];
  try {
    const got = await db.query(
      `SELECT TIMESTAMPDIFF(SECOND, started_at, NOW()) AS start_age,
              TIMESTAMPDIFF(SECOND, COALESCE(ended_at, NOW()), NOW()) AS end_age
         FROM work_sessions
        WHERE user_id = $1
          AND started_at < DATE_ADD($2, INTERVAL 1 DAY) AND COALESCE(ended_at, NOW()) > $3`,
      [userId, `${date} 00:00:00`, `${date} 00:00:00`]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return { seconds: 0, sessions: 0 };
  }
  const now = Date.now();
  let seconds = 0;
  let sessions = 0;
  for (const row of rows) {
    const from = Math.max(now - (Number(row.start_age) || 0) * 1000, window.from);
    const to = Math.min(now - (Number(row.end_age) || 0) * 1000, window.to);
    if (to <= from) continue;
    const inside = Math.round(
      workingTime.workingMsByDay(from, to, schedule).total / 1000
    );
    if (inside > 0) { seconds += inside; sessions += 1; }
  }
  return { seconds, sessions };
}

/* "1 h 30 m", the way every other duration in this application reads. */
function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!h && !m) return '0 m';
  return [h ? `${h} h` : null, m ? `${m} m` : null].filter(Boolean).join(' ');
}

/* A sentence for a row, used by the strip, the notification and the audit line
   — so the three cannot describe the same mark differently. */
function describe(row, { schedule = workSchedule.current() } = {}) {
  if (!row) return 'no mark';
  if (row.kind === KINDS.idle) return 'Idle';
  const c = leaveSettings.clock;
  if (row.portion === PORTIONS.first_half) {
    return `Leave — First Half (until ${c(row.windowEnd)})`;
  }
  if (row.portion === PORTIONS.second_half) {
    return `Leave — Second Half (from ${c(row.windowStart)})`;
  }
  return 'Leave — Full Day';
}

const PORTION_LABELS = {
  full: 'Full day',
  first_half: 'First half',
  second_half: 'Second half',
};

module.exports = {
  KINDS, PORTIONS, SOURCES, ACTIONABLE_STATUSES, PORTION_LABELS,
  MS_PER_DAY, startOfDay,
  statusesFor, userDayStatus, markedOn,
  leaveWindows, windowsFromRow, windowsForSpan,
  countedMsByDay, countedSeconds, countedMs,
  expectedWorkingMinutes, isTimesheetRequired, isExpectedToWorkAt,
  insideLeaveWindow, leaveEndsAt, expectedToWorkFromRow, nothingToStart, timesheetRequiredFromRow,
  actionableCount, actionableAssets, mark, clear, clearRow, onAssigned, describe,
  sweepLeave, liveWindowsNow, activeBetween, recount, recordedInside, durationLabel,
};
