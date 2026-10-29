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

/* ---------------------------------------------------------------------------
 * WRITING.
 */

/* MATERIALISE: the request becomes days. The ONE function that creates a
   vacation's effect, and every day it creates goes through dayStatus.mark() —
   so a planned day and a day a lead marked by hand are the same row, with the
   same window snapshot, the same unique key and the same history. */
async function materialise(db, request, { setBy = null, loggableDays = null, isHoliday = null } = {}) {
  const wanted = daysOf(request, { loggableDays, isHoliday });
  const made = [];
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
  const days = approvalNeeded ? [] : await materialise(db, { ...v, id, userId }, { setBy: (actor && actor.id) || userId });
  return { ok: true, request: await byId(db, id, { today: day }), days, approvalNeeded };
}

async function decide(db, { requestId, approve, actor, note = null, today = null }) {
  const day = today || timesheetGate.istDate();
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
    days = await materialise(db, request, { setBy: (actor && actor.id) || null });
  }
  return { ok: true, request: await byId(db, requestId, { today: day }), days, approved: Boolean(approve) };
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
    kept: left,
    status,
  };
}

module.exports = {
  STATUS, LIVE,
  daysOf, validate, conflicts, overlapMessage, describe,
  listFor, byId, inWindow, daysOfRequest,
  submit, decide, cancel, materialise,
  addDays, spanDays,
};
