/* VACATION MODE: a person books their own time off, and it becomes leave.
 *
 * ===========================================================================
 * THERE IS ONE ENGINE AND THIS FILE IS NOT IT.
 *
 * A vacation is a REQUEST — a row in leave_requests with a status on it. It is
 * an intention, and intentions do not change anybody's hours. The moment one is
 * approved it MATERIALISES one ordinary leave row per working day through
 * src/day-status.js's mark(), with source 'planned' and the request's id on it,
 * and from that instant nothing in this application needs to know vacations
 * exist:
 *
 *   countedMs()              removes the hours, because the row is leave
 *   isTimesheetRequired()    excuses a full day, because the row is leave
 *   isExpectedToWorkAt()     stops the nudges, because the row is leave
 *   sweepLeave()             stops a running timer, because the row is leave
 *   the follow-up lists      drop the person, because the row is leave
 *   the half-day snapshot    moves with Settings, because the row is leave
 *
 * SO WHY NOT SKIP THE REQUEST TABLE ENTIRELY and just write the days? Because
 * three things are true of a vacation that are not true of a day: it can be
 * pending approval, it can be cancelled as a whole before it starts, and it can
 * be ended early — and all three are statements about the booking rather than
 * about any one date. "Cancel the rest of my holiday" needs to know which days
 * belong together, and a pile of independent leave rows cannot say.
 *
 * WHAT THIS FILE MUST NEVER DO, stated as a prohibition because the pull is
 * real and this codebase has paid for it four times: it must never be consulted
 * to decide whether an hour counts, whether a timesheet is owed, or whether
 * somebody should be at their desk. The day rows answer those. A test mutates
 * this module into writing its own day table and asserts the time arithmetic
 * notices nothing — because it would not, and that is the bug.
 *
 * ===========================================================================
 * WHOSE DATES ARE WHOSE.
 *
 *   from tomorrow        a person's own booking. The floor is one day and is
 *                        not a setting: today is the one date somebody ELSE
 *                        records, because marking today changes a figure that
 *                        is already being read. Settings may ask for more
 *                        notice; nothing can ask for less.
 *   today and the past   followup.mark_leave on People to follow up, or
 *                        leave.manage_all here. Both are somebody else saying
 *                        what happened, which is a different act from asking.
 *
 * ===========================================================================
 * APPROVAL IS OFF BY DEFAULT and that is the studio's existing choice, carried
 * over unchanged. With it off a booking takes effect on submission; with it on
 * nothing is materialised until somebody holding leave.approve says so, and a
 * rejected request never touched a figure.
 */
const { v4: uuid } = require('uuid');

const dayStatus = require('./day-status');
/* The timesheet half of an approved vacation (Prompt 67 Part C): the Leave
   lines it writes as each day arrives, and the rule that a cancellation takes
   back today and the future and never the past. */
const vacationTimesheet = require('./vacation-timesheet');
const leaveSettings = require('./leave-settings');
const timesheetGate = require('./timesheet-gate');
const holidays = require('./holidays');
const workSchedule = require('./work-schedule');

const STATUS = {
  submitted: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  ended_early: 'ended_early',
};

/* THE STATUSES THAT STILL MEAN TIME IS EXCLUDED. A vacation that was ended
   early kept the days before the cut, so it is live as much as an approved one;
   a rejected or cancelled one has no days at all. */
const LIVE = [STATUS.approved, STATUS.ended_early];

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const unavailable = (err) => /doesn't exist|no such table|Unknown column/i.test(
  (err && (err.sqlMessage || err.message)) || ''
);

const MS_PER_DAY = 86400000;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
const dateAt = (n) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
const addDays = (date, n) => dateAt(dayNumber(date) + n);
const spanDays = (from, to) => dayNumber(to) - dayNumber(from) + 1;

/* ---------------------------------------------------------------------------
 * WHICH DATES A REQUEST COVERS, and the portion on each.
 *
 * NON-WORKING DAYS GET NO ROW AT ALL. A fortnight's holiday over two weekends
 * is ten leave rows, not fourteen: a Sunday is already not a working day, and a
 * leave row on one would be a mark with no effect that reads on the strip as
 * something somebody decided. The holiday calendar is asked, not restated —
 * timesheet-gate's isWorkingDay() with holidays.on(), the same pair
 * src/day-status.js and src/follow-up.js use.
 *
 * THE HALF-DAY PORTIONS LAND ON THE FIRST AND LAST WORKING DAY, not on the
 * first and last CALENDAR day. A vacation booked from a Saturday with a
 * second-half start would otherwise put its half-day on a date with no row,
 * and the Monday — the first day anybody is actually away — would read as a
 * full day. So the portions follow the rows.
 */
function daysOf({ from, to, fromPortion = 'full', toPortion = 'full' }, { loggableDays = null, isHoliday = null } = {}) {
  if (!isDate(from) || !isDate(to) || to < from) return [];
  const policy = loggableDays || (require('./timesheet-settings').current() || {}).loggableDays;
  const holiday = isHoliday || ((d) => Boolean(holidays.on(d)));
  const working = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n += 1) {
    const d = dateAt(n);
    if (timesheetGate.isWorkingDay(d, { loggableDays: policy, isHoliday: holiday })) working.push(d);
  }
  if (!working.length) return [];
  return working.map((date, i) => {
    let portion = dayStatus.PORTIONS.full;
    if (i === 0 && fromPortion !== dayStatus.PORTIONS.full) portion = fromPortion;
    if (i === working.length - 1 && toPortion !== dayStatus.PORTIONS.full) {
      /* ONE DAY WITH TWO HALVES ASKED OF IT IS A FULL DAY. A single-day
         vacation whose first day starts second-half and whose last day ends
         first-half is somebody describing one date from both ends; the honest
         row is the whole day, not two conflicting halves. */
      portion = (i === 0 && fromPortion !== dayStatus.PORTIONS.full && fromPortion !== toPortion)
        ? dayStatus.PORTIONS.full : toPortion;
    }
    return { date, portion };
  });
}

/* ---------------------------------------------------------------------------
 * VALIDATION, which is where every rule the brief states actually lives.
 */
function validate(input = {}, { today, forSelf = true, settings = null } = {}) {
  const errors = [];
  const from = String(input.from || '');
  const to = String(input.to || from);
  const fromPortion = input.fromPortion || dayStatus.PORTIONS.full;
  const toPortion = input.toPortion || dayStatus.PORTIONS.full;

  if (!isDate(from)) errors.push({ field: 'from', message: 'Which day does it start?' });
  if (!isDate(to)) errors.push({ field: 'to', message: 'Which day does it end?' });
  for (const [key, value] of [['fromPortion', fromPortion], ['toPortion', toPortion]]) {
    if (!dayStatus.PORTIONS[value]) errors.push({ field: key, message: 'First half, second half or full day.' });
  }
  if (errors.length) return { ok: false, errors };

  if (to < from) {
    errors.push({ field: 'to', message: 'The last day is before the first.' });
    return { ok: false, errors };
  }

  /* THE NOTICE, which only applies to a person booking their own. Somebody with
     leave.manage_all is recording what happened or arranging it on request, and
     both of those legitimately reach today and backwards. */
  if (forSelf) {
    const notice = (settings ? settings.minNoticeDays : null) || leaveSettings.minNoticeDays();
    const earliest = addDays(today, Math.max(leaveSettings.MIN_NOTICE_FLOOR, notice));
    if (from < earliest) {
      errors.push({
        field: 'from',
        code: 'too_soon',
        message: notice <= 1
          ? `A vacation you book yourself starts tomorrow at the earliest (${earliest}). `
            + 'For today or a day that has passed, ask somebody who records attendance.'
          : `This studio asks for ${notice} days’ notice, so the earliest is ${earliest}.`,
      });
    }
    const max = (settings ? settings.maxRangeDays : null) || leaveSettings.maxRangeDays();
    const length = spanDays(from, to);
    if (length > max) {
      errors.push({
        field: 'to',
        code: 'too_long',
        message: `That is ${length} days. The longest you can book yourself is ${max}.`,
      });
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { from, to, fromPortion, toPortion, note: input.note ? String(input.note).slice(0, 500) : null },
  };
}

/* ---------------------------------------------------------------------------
 * OVERLAP, ASKED OF THE DAY ROWS AND NOT OF THE REQUEST TABLE.
 *
 * That is the important half. Two approved vacations cannot overlap, but
 * neither can a vacation overlap a leave a lead marked by hand — and that mark
 * is not a request, it is a day row. Asking the requests would have found the
 * first collision and missed the second, which is the same class of mistake as
 * keeping a second time engine: the authority on "is this person already away
 * on the 14th" is user_day_status, so that is what is asked.
 *
 * COMPLEMENTARY HALVES ARE NAMED RATHER THAN ALLOWED. First-half leave plus
 * second-half leave is a full day written as two rows, and the schema holds one
 * active row per person per day — so it cannot be stored, and "choose Full Day
 * instead" is the only useful thing to say.
 */
async function conflicts(db, userId, wanted, { ignoreRequestId = null } = {}) {
  if (!wanted.length) return [];
  const existing = await dayStatus.statusesFor(db, [userId], wanted[0].date, wanted[wanted.length - 1].date);
  const out = [];
  for (const want of wanted) {
    const row = existing.get(`${userId}|${want.date}`);
    if (!row) continue;
    if (ignoreRequestId && row.requestId === ignoreRequestId) continue;
    /* An onsight or idle mark is replaced rather than refused: being at a
       client's site is not being away, and the schema's one-row rule means the
       newer statement wins, which is how a lead correcting a mark already
       behaves. Only leave genuinely collides. */
    if (row.kind !== dayStatus.KINDS.leave) continue;
    const complementary = (row.portion === dayStatus.PORTIONS.first_half && want.portion === dayStatus.PORTIONS.second_half)
      || (row.portion === dayStatus.PORTIONS.second_half && want.portion === dayStatus.PORTIONS.first_half);
    out.push({
      date: want.date,
      existing: dayStatus.describe(row, { schedule: workSchedule.current() }),
      wanted: dayStatus.PORTION_LABELS[want.portion] || want.portion,
      complementary,
      planned: row.planned,
    });
  }
  return out;
}

function overlapMessage(list) {
  const dates = list.map((c) => c.date).join(', ');
  if (list.length && list.every((c) => c.complementary)) {
    return `You are already on leave for part of ${dates}. Two halves of one day cannot be `
      + 'booked separately — choose Full Day instead.';
  }
  return `You are already away on ${dates}.`;
}

/* ---------------------------------------------------------------------------
 * READING.
 */
const SELECT = `SELECT r.id, r.user_id AS userId, r.status,
       DATE_FORMAT(r.from_date, '%Y-%m-%d') AS \`from\`,
       DATE_FORMAT(r.to_date, '%Y-%m-%d') AS \`to\`,
       r.from_portion AS fromPortion, r.to_portion AS toPortion,
       r.note, r.requested_by AS requestedBy, r.requested_at AS requestedAt,
       r.decided_by AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote,
       DATE_FORMAT(r.ended_on, '%Y-%m-%d') AS endedOn,
       u.\`name\` AS personName, rb.\`name\` AS requestedByName, db2.\`name\` AS decidedByName
  FROM leave_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users rb ON rb.id = r.requested_by
  LEFT JOIN users db2 ON db2.id = r.decided_by`;

function shape(row, { today = null } = {}) {
  if (!row) return null;
  const live = LIVE.includes(row.status);
  const lastDay = row.endedOn || row.to;
  return {
    id: row.id,
    userId: row.userId,
    personName: row.personName,
    status: row.status,
    from: row.from,
    to: row.to,
    fromPortion: row.fromPortion,
    toPortion: row.toPortion,
    note: row.note || null,
    requestedBy: row.requestedBy || null,
    requestedByName: row.requestedByName || null,
    requestedAt: row.requestedAt ? new Date(row.requestedAt).toISOString() : null,
    decidedBy: row.decidedBy || null,
    decidedByName: row.decidedByName || null,
    decisionNote: row.decisionNote || null,
    endedOn: row.endedOn || null,
    /* THE THREE WORDS THE PROFILE SORTS AND LABELS BY, decided here so the page
       does not compare dates a second time against the browser's clock. */
    phase: !today ? null
      : (!live ? 'over'
        : (today < row.from ? 'upcoming' : (today > lastDay ? 'past' : 'active'))),
    active: Boolean(today && live && today >= row.from && today <= lastDay),
    label: describe(row),
  };
}

function describe(row) {
  const half = (p) => (p === 'first_half' ? ' (first half)' : (p === 'second_half' ? ' (second half)' : ''));
  const one = row.from === row.to;
  const span = one
    ? `${row.from}${half(row.fromPortion) || half(row.toPortion)}`
    : `${row.from}${half(row.fromPortion)} to ${row.to}${half(row.toPortion)}`;
  if (row.status === STATUS.ended_early && row.endedOn) return `Vacation ${span}, ended ${row.endedOn}`;
  return `Vacation ${span}`;
}

async function listFor(db, userId, { today = null } = {}) {
  const { rows } = await db.query(`${SELECT} WHERE r.user_id = $1 ORDER BY r.from_date DESC`, [userId])
    .catch((err) => { if (!unavailable(err)) throw err; return { rows: [] }; });
  return rows.map((r) => shape(r, { today }));
}

async function byId(db, id, { today = null } = {}) {
  if (!id) return null;
  const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id])
    .catch((err) => { if (!unavailable(err)) throw err; return { rows: [] }; });
  return shape(rows[0], { today });
}

/* Everybody who is away, or about to be, within a window — for the Admin
   Dashboard's "Upcoming leaves" and the assignee picker's warning chip. Scoped
   by the caller, which hands in the ids it may show. */
async function inWindow(db, userIds, from, to) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length || !isDate(from) || !isDate(to)) return [];
  const { rows } = await db.query(
    `${SELECT} WHERE r.user_id IN ($1) AND r.status IN ($2)
        AND r.from_date <= $3 AND COALESCE(r.ended_on, r.to_date) >= $4
      ORDER BY r.from_date`,
    [ids, LIVE, to, from]
  ).catch((err) => { if (!unavailable(err)) throw err; return { rows: [] }; });
  return rows.map((r) => shape(r, { today: timesheetGate.istDate() }));
}

/* EVERY BOOKING STILL WAITING FOR A DECISION, for the approver's list.
 *
 * SCOPED BY THE CALLER, like inWindow above: the route hands in the ids it may
 * show, because who a person may see is permissions.visibleProjects()'s
 * question and not this module's. `null` means no scoping — the studio-wide
 * case — and an EMPTY array means "nobody", which is a different answer and
 * must not be read as "everybody". That distinction is the whole reason this
 * takes null rather than defaulting to [].
 *
 * OLDEST FIRST, because the queue is a queue: the booking that has been waiting
 * longest is the one somebody is still wondering about. The dates ordering used
 * by listFor is the wrong one here — a request made this morning for next
 * December would sit at the bottom of a list sorted by from_date.
 */
async function pending(db, { scopeIds = null, today = null } = {}) {
  const day = today || timesheetGate.istDate();
  if (Array.isArray(scopeIds) && !scopeIds.length) return [];
  const where = Array.isArray(scopeIds)
    ? 'r.status = $1 AND r.user_id IN ($2)' : 'r.status = $1';
  const params = Array.isArray(scopeIds) ? [STATUS.submitted, scopeIds] : [STATUS.submitted];
  const { rows } = await db.query(
    `${SELECT} WHERE ${where} ORDER BY r.requested_at ASC`, params
  ).catch((err) => { if (!unavailable(err)) throw err; return { rows: [] }; });
  return rows.map((r) => shape(r, { today: day }));
}

/* ---------------------------------------------------------------------------
 * WRITING.
 */

/* MATERIALISE: the request becomes days. The ONE function that creates a
   vacation's effect, and every day it creates goes through dayStatus.mark() —
   so a planned day and a day a lead marked by hand are the same row, with the
   same window snapshot, the same unique key and the same history. */
async function materialise(db, request, { setBy = null, loggableDays = null, isHoliday = null,
  now = null } = {}) {
  const wanted = daysOf(request, { loggableDays, isHoliday });
  const made = [];
  /* A VACATION THAT STARTS TODAY IS LEAVE FROM THE MOMENT IT WAS BOOKED.
   *
   * WHY NOT FROM MIDNIGHT, which is what a full-day leave row has always meant:
   * because somebody who worked an hour this morning and then decided to take
   * the day has worked that hour. The brief is explicit — time already recorded
   * stays recorded, and only time after the booking is cut — and a window
   * opening at midnight would take the morning back.
   *
   * THE DAY IS STILL FULL-DAY LEAVE. That is what matters for everything other
   * than the arithmetic: nothing is owed on the timesheet (so the person is not
   * asked for hours they now cannot log), they are off the follow-up lists, and
   * the strip says they are away. Only the hours arithmetic reads the window.
   *
   * TODAY ONLY, and only when `now` is supplied. Every other day of the
   * vacation, and every vacation booked in advance, is the whole day as before —
   * so this is reachable only through a same-day booking, which needs the
   * studio to have set the notice period to 0. */
  const todayHere = now === null ? null : timesheetGate.istDate(now);
  const fromMinute = now === null
    ? null : require('./working-time').istPartsOf(now).minute;
  for (const day of wanted) {
    const one = await dayStatus.mark(db, {
      userId: request.userId,
      date: day.date,
      kind: dayStatus.KINDS.leave,
      portion: day.portion,
      note: request.note || null,
      setBy,
      source: dayStatus.SOURCES.planned,
      requestId: request.id,
      fromMinute: day.date === todayHere ? fromMinute : null,
    });
    if (one.ok) made.push(day.date);
  }
  return made;
}

/* The days of a request that are still ahead, which is what "end early" and
   "cancel" may clear without reaching into time that has been reported on. */
async function daysOfRequest(db, requestId) {
  if (!requestId) return [];
  const { rows } = await db.query(
    `SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS \`date\`
       FROM user_day_status
      WHERE request_id = $1 AND cleared_at IS NULL
      ORDER BY \`date\``, [requestId]
  ).catch((err) => { if (!unavailable(err)) throw err; return { rows: [] }; });
  return rows.map((r) => r.date);
}

async function submit(db, { userId, input, actor, today = null, forSelf = true }) {
  const day = today || timesheetGate.istDate();
  if (!leaveSettings.vacationEnabled()) return { ok: false, status: 409, code: 'feature_disabled' };

  const checked = validate(input, { today: day, forSelf });
  if (!checked.ok) return { ok: false, status: 422, code: 'invalid', errors: checked.errors };
  const v = checked.value;

  const wanted = daysOf(v);
  if (!wanted.length) {
    return {
      ok: false,
      status: 422,
      code: 'no_working_days',
      errors: [{ field: 'from', message: 'Every day in that range is already a weekly off or a holiday.' }],
    };
  }

  const clash = await conflicts(db, userId, wanted);
  if (clash.length) {
    return { ok: false, status: 409, code: 'overlap', overlap: clash, error: overlapMessage(clash) };
  }

  const approvalNeeded = leaveSettings.vacationApprovalRequired();
  const id = uuid();
  await db.query(
    `INSERT INTO leave_requests
       (id, user_id, from_date, to_date, from_portion, to_portion, note, status, requested_by,
        decided_by, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, userId, v.from, v.to, v.fromPortion, v.toPortion, v.note,
      approvalNeeded ? STATUS.submitted : STATUS.approved,
      (actor && actor.id) || userId,
      approvalNeeded ? null : ((actor && actor.id) || userId),
      approvalNeeded ? null : new Date()]
  );

  /* NOTHING IS MATERIALISED WHILE IT WAITS FOR APPROVAL. "Only approved
     vacations affect time" is this line and not a filter somewhere downstream. */
  const days = approvalNeeded
    ? []
    : await materialise(db, { ...v, id, userId },
      { setBy: (actor && actor.id) || userId, now: Date.now() });
  return { ok: true, request: await byId(db, id, { today: day }), days, approvalNeeded };
}

/* ---------------------------------------------------------------------------
 * TURNING THE APPROVAL OPTION OFF ACTIVATES WHAT WAS WAITING.
 *
 * THE RULE THE BRIEF STATES: pending items follow the OFF rule, so they become
 * active. The alternative — leaving them pending with nobody able to approve
 * them, because the screen that approves them is now hidden — is a set of
 * bookings that can never take effect and that their owners believe are in.
 * That is the failure this exists to prevent.
 *
 * ONLY WHAT WAS STILL WAITING. A rejected or cancelled request is a decision
 * somebody made and is not reopened by a settings change; an approved one is
 * already live. Only STATUS.submitted moves.
 *
 * AND NOTHING THAT HAS GONE BY. A request whose last day is behind us is
 * activated as a record — its status becomes approved so the person's history
 * is honest about what was booked — but materialise() only writes the days
 * daysOf() yields, and the day rows it writes for past dates would be marks on
 * time that has already been reported on. So past-only requests are left
 * alone and reported separately: a studio turning this off in April does not
 * retroactively put somebody on leave in February.
 *
 * EXISTING VACATIONS ARE UNTOUCHED, which is the brief's other instruction and
 * follows from the status filter rather than from a special case.
 */
async function activatePending(db, { actor = null, today = null } = {}) {
  const day = today || timesheetGate.istDate();
  let rows = [];
  try {
    const got = await db.query(
      `SELECT id, user_id AS userId, DATE_FORMAT(to_date, '%Y-%m-%d') AS \`to\`
         FROM leave_requests WHERE status = $1 ORDER BY from_date`, [STATUS.submitted]
    );
    rows = got.rows;
  } catch (err) {
    if (!unavailable(err)) throw err;
    return { activated: [], skippedPast: [] };
  }

  const activated = [];
  const skippedPast = [];
  for (const row of rows) {
    if (String(row.to) < day) { skippedPast.push(row.id); continue; }
    await db.query(
      `UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = NOW(),
              decision_note = $3 WHERE id = $4 AND status = $5`,
      [STATUS.approved, (actor && actor.id) || null,
        'Approval was switched off in Settings, so this took effect.', row.id, STATUS.submitted]
    );
    const request = await byId(db, row.id, { today: day });
    if (!request) continue;
    /* AND THE SAME WHEN A SETTINGS CHANGE ACTIVATES A WAITING BOOKING. */
    const days = await materialise(db, request, { setBy: (actor && actor.id) || null, now: Date.now() });
    activated.push({ id: row.id, userId: row.userId, label: request.label, days });
  }
  if (activated.length) {
    for (const who of new Set(activated.map((a) => a.userId))) {
      await dayStatus.recount(db, { userId: who }).catch(() => {});
    }
  }
  return { activated, skippedPast };
}

/* ---------------------------------------------------------------------------
 * CHANGING THE DATES OF A BOOKING THAT IS ALREADY IN.
 *
 * THE OWNER MAY ALWAYS DO THIS, which is what the brief asks for, and the
 * validation is the booking's own: same notice period, same maximum range, same
 * overlap check, same "every day is a weekly off" refusal. One validate(), so a
 * rule the studio sets cannot be enforced on booking and skipped on editing.
 *
 * WHAT MAY MOVE DEPENDS ON WHETHER IT HAS STARTED, and this is the one rule
 * here that the brief does not state:
 *
 *   not started yet    the whole range may change. Nothing has happened, no
 *                      figure has been affected, so this is a re-booking.
 *   already started     only the END may move. The days already behind the
 *                      cut excluded somebody's hours, were counted by the
 *                      follow-up lists, and may be in a report that has been
 *                      sent. Moving the start of a vacation that began on
 *                      Monday would be rewriting what happened on Monday, and
 *                      "the vacation's effect on past days is never rewritten"
 *                      is the brief's own instruction.
 *
 * So a started vacation can be shortened, extended, or ended today — all of
 * which are statements about the future — and cannot be made to have begun on a
 * different day. An owner who genuinely needs that asks somebody with
 * leave.manage_all to cancel it, which is the existing route for reaching into
 * time that has already happened.
 *
 * THE CUT is tomorrow for the owner, exactly as cancel() computes it, and for
 * the same reason: today's figure is already being read.
 *
 * DAYS ARE RECONCILED, NOT REBUILT. Days at or after the cut that the new range
 * does not want are cleared; days it wants that are not marked are
 * materialised; days before the cut are not touched at all. A test asserts that
 * a day before the cut survives an edit that no longer covers it.
 */
async function edit(db, { requestId, input, actor, today = null, forSelf = true }) {
  const day = today || timesheetGate.istDate();
  if (!leaveSettings.vacationEnabled()) return { ok: false, status: 409, code: 'feature_disabled' };

  const request = await byId(db, requestId, { today: day });
  if (!request) return { ok: false, status: 404, code: 'not_found' };
  if (![STATUS.submitted, ...LIVE].includes(request.status)) {
    return { ok: false, status: 409, code: 'already_closed', request };
  }

  const started = String(request.from) <= day;
  const checked = validate(
    /* A STARTED VACATION KEEPS ITS OWN START, whatever was sent. Taking it from
       the request rather than refusing a payload that repeats it means the
       screen can send the whole booking back unchanged, which is what a form
       does, without having to know this rule. */
    started ? { ...input, from: request.from, fromPortion: request.fromPortion } : input,
    { today: day, forSelf }
  );
  if (!checked.ok) return { ok: false, status: 422, code: 'invalid', errors: checked.errors };
  const v = checked.value;

  if (started && (String(input.from || request.from) !== String(request.from))) {
    return {
      ok: false,
      status: 422,
      code: 'started',
      errors: [{ field: 'from', message: `This vacation began on ${request.from}, so its start `
        + 'cannot be moved — those days have already excluded your hours. The end date can '
        + 'still change.' }],
    };
  }

  const wanted = daysOf(v);
  if (!wanted.length) {
    return {
      ok: false,
      status: 422,
      code: 'no_working_days',
      errors: [{ field: 'from', message: 'Every day in that range is already a weekly off or a holiday.' }],
    };
  }

  /* ITS OWN DAYS ARE NOT A CLASH WITH ITSELF. */
  const clash = await conflicts(db, request.userId, wanted, { ignoreRequestId: requestId });
  if (clash.length) {
    return { ok: false, status: 409, code: 'overlap', overlap: clash, error: overlapMessage(clash) };
  }

  const cut = addDays(day, 1);
  const live = await daysOfRequest(db, requestId);
  const wantedDates = new Set(wanted.map((d) => d.date));

  const cleared = [];
  for (const d of live) {
    if (d < cut || wantedDates.has(d)) continue;
    const gone = await dayStatus.clear(db, {
      userId: request.userId, date: d,
      clearedBy: (actor && actor.id) || null,
      reason: 'vacation dates changed',
    });
    if (gone && gone.ok !== false) cleared.push(d);
  }

  /* MATERIALISED ONLY IF THE REQUEST IS LIVE. One awaiting approval still has
     no days, and editing it must not conjure them — the approval is what does
     that, and a test edits a pending request and asserts it still has none. */
  const liveNow = LIVE.includes(request.status);
  const haveNow = new Set(await daysOfRequest(db, requestId));
  const added = [];
  if (liveNow) {
    for (const d of wanted) {
      if (d.date < cut || haveNow.has(d.date)) continue;
      const one = await dayStatus.mark(db, {
        userId: request.userId,
        date: d.date,
        kind: dayStatus.KINDS.leave,
        portion: d.portion,
        note: request.note || null,
        setBy: (actor && actor.id) || null,
        source: dayStatus.SOURCES.planned,
        requestId,
      });
      if (one.ok) added.push(d.date);
    }
  }
  await dayStatus.recount(db, { userId: request.userId }).catch(() => {});

  await db.query(
    `UPDATE leave_requests SET from_date = $1, to_date = $2, from_portion = $3, to_portion = $4,
            note = $5 WHERE id = $6`,
    [started ? request.from : v.from, v.to, started ? request.fromPortion : v.fromPortion,
      v.toPortion, v.note, requestId]
  );

  return {
    ok: true,
    request: await byId(db, requestId, { today: day }),
    cleared,
    added,
    started,
  };
}

async function decide(db, { requestId, approve, actor, note = null, today = null }) {
  const day = today || timesheetGate.istDate();
  let filled = { created: [], skipped: [] };
  const request = await byId(db, requestId, { today: day });
  if (!request) return { ok: false, status: 404, code: 'not_found' };
  if (request.status !== STATUS.submitted) {
    return { ok: false, status: 409, code: 'already_decided', request };
  }
  await db.query(
    'UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $4',
    [approve ? STATUS.approved : STATUS.rejected, (actor && actor.id) || null,
      note ? String(note).slice(0, 500) : null, requestId]
  );
  let days = [];
  if (approve) {
    /* THE OVERLAP IS RE-ASKED AT APPROVAL. Between submission and a decision
       somebody may have marked the same days by hand, and approving into that
       would hit the schema's one-row rule a day at a time and leave half a
       vacation materialised. */
    const wanted = daysOf(request);
    const clash = await conflicts(db, request.userId, wanted, { ignoreRequestId: requestId });
    if (clash.length) {
      await db.query('UPDATE leave_requests SET status = $1 WHERE id = $2', [STATUS.submitted, requestId]);
      return { ok: false, status: 409, code: 'overlap', overlap: clash, error: overlapMessage(clash), request };
    }
    /* THE SAME MOMENT RULE AS BOOKING. An approval that lands mid-morning on
       the vacation's first day makes the day leave from now, not from midnight
       — otherwise an approver's timing would silently erase the hours the
       person worked while waiting for it. */
    days = await materialise(db, request, { setBy: (actor && actor.id) || null, now: Date.now() });
    /* AND THE TIMESHEET IS FILLED IN AS FAR AS TODAY (Prompt 67 Part C).
       Only the days that have already arrived: every later day waits for the
       sweep and its own morning, so a vacation cancelled on the third day has
       no stale future rows to find. */
    filled = await vacationTimesheet
      .fill(db, await byId(db, requestId, { today: day }), { now: Date.now() })
      .catch(() => ({ created: [], skipped: [] }));
  }
  /* A REJECTION AFTER AN APPROVAL takes the lines back the same way a
     cancellation does — today and the days after it, never the past. */
  if (!approve) {
    filled = { created: [], skipped: [] };
    await vacationTimesheet.clear(db, request).catch(() => ({ removed: [] }));
  }
  return { ok: true, request: await byId(db, requestId, { today: day }), days, filled,
    approved: Boolean(approve) };
}

/* CANCEL, AND END EARLY, which are the same act with two different cut dates.
 *
 *   before it starts     every day goes; the request is cancelled.
 *   after it starts      the days from the cut onward go; the request is
 *                        ended_early and keeps the days before it.
 *
 * THE CUT IS TOMORROW, NOT TODAY, for somebody acting on their own vacation —
 * and that is the brief's rule and the right one: today's exclusion may already
 * be in a figure somebody has read, and a person un-excusing their own morning
 * retroactively is exactly the separation leave.manage_all exists for.
 * Somebody holding leave.manage_all may cut from today or from any past date,
 * and the day rows they clear are cleared through dayStatus.clear() like any
 * other undo, so the history says who did it.
 */
async function cancel(db, { requestId, actor, today = null, fromDate = null, mayManageAll = false }) {
  const day = today || timesheetGate.istDate();
  const request = await byId(db, requestId, { today: day });
  if (!request) return { ok: false, status: 404, code: 'not_found' };
  if (![STATUS.submitted, ...LIVE].includes(request.status)) {
    return { ok: false, status: 409, code: 'already_closed', request };
  }

  /* WHERE THE CUT FALLS. The default is the earliest date this actor may
     legitimately clear: tomorrow for an ordinary cancel, today or earlier only
     with leave.manage_all and only when asked for explicitly. */
  const earliest = mayManageAll ? null : addDays(day, 1);
  let cut = fromDate && isDate(fromDate) ? fromDate : (request.from > day ? request.from : addDays(day, 1));
  if (earliest && cut < earliest) cut = earliest;
  if (mayManageAll && fromDate && isDate(fromDate)) cut = fromDate;

  const live = await daysOfRequest(db, requestId);
  const clearing = live.filter((d) => d >= cut);
  for (const d of clearing) {
    await dayStatus.clear(db, {
      userId: request.userId, date: d,
      clearedBy: (actor && actor.id) || null,
      reason: request.from > day ? 'vacation cancelled' : 'vacation ended early',
    });
  }
  await dayStatus.recount(db, { userId: request.userId }).catch(() => {});

  /* AND THE TIMESHEET LINES THIS VACATION WROTE, FROM TODAY ONWARDS.
   *
   * NEVER THE PAST, whatever the cut date is. A holder of leave.manage_all may
   * cut a vacation from a past date — the day rows go, because an exclusion is
   * a claim about availability that somebody with that key may revise — but the
   * TIMESHEET is a record of what was done, and the person really was away on
   * Monday. Removing a submitted Monday would be rewriting history, which the
   * brief forbids in those words. So clear() takes the later of the cut and
   * today, and src/vacation-timesheet.js is where that is decided. */
  const unfilled = await vacationTimesheet.clear(db, request, { from: cut })
    .catch(() => ({ removed: [], reopened: [] }));

  /* WHICH STATUS IT LANDS IN depends on whether anything survived, not on which
     button was pressed — so a "cancel" that happens to leave two days behind is
     honestly recorded as ended early rather than as never having happened. */
  const left = live.filter((d) => d < cut);
  const status = left.length ? STATUS.ended_early : STATUS.cancelled;
  await db.query(
    'UPDATE leave_requests SET status = $1, ended_on = $2, decided_by = $3, decided_at = NOW() WHERE id = $4',
    [status, left.length ? left[left.length - 1] : null, (actor && actor.id) || null, requestId]
  );
  return {
    ok: true,
    request: await byId(db, requestId, { today: day }),
    cleared: clearing,
    unfilled,
    kept: left,
    status,
  };
}

/* THE SOFT WARNING ON AN ASSIGNEE PICKER, and the reason it lives here.
 *
 * src/routes/assets.js is pinned line for line by tests/server-tab.test.js
 * against the commit before the office file server — it is the file the one
 * endpoint every artist uses lives in — so a feature that wanted four lines
 * there could have had one. The window, the permission and the de-duplication
 * are this module's business anyway.
 *
 * A WARNING AND NEVER A FILTER. The option stays selectable: somebody back on
 * Thursday is a perfectly good person to give Friday's work to, and a picker
 * that silently dropped names would send a coordinator hunting for somebody who
 * had vanished from a list with no explanation.
 *
 * BEHIND leave.view_team, because it is somebody else's time off. Without the
 * key the options are exactly what they were — `away` is absent, not null, so
 * nothing on the page can tell the difference between "not away" and "you may
 * not know".
 *
 * MUTATES IN PLACE AND RETURNS THE SAME ARRAY, so the caller's one line can be
 * a statement rather than a reassignment. */
async function annotateAway(db, user, options) {
  if (!Array.isArray(options) || !options.length) return options;
  const permissions = require('./permissions');
  if (!permissions.holds(user, 'leave.view_team')) return options;
  const from = timesheetGate.istDate();
  const list = await inWindow(db, options.map((o) => o.id), from, addDays(from, 14)).catch(() => []);
  const away = new Map();
  for (const v of list) {
    if (!away.has(v.userId)) away.set(v.userId, { from: v.from, to: v.endedOn || v.to, label: v.label });
  }
  for (const option of options) option.away = away.get(option.id) || null;
  return options;
}

module.exports = {
  edit, activatePending, pending,
  STATUS, LIVE, annotateAway,
  daysOf, validate, conflicts, overlapMessage, describe,
  listFor, byId, inWindow, daysOfRequest,
  submit, decide, cancel, materialise,
  addDays, spanDays,
};
