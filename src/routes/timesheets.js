const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { holds } = require('../permissions');
const sheets = require('../timesheets');
const workSchedule = require('../work-schedule');
const xlsx = require('xlsx');
const branding = require('../branding');
const exporter = require('../report-export');
const reportPdf = require('../report-pdf');

router.use(authenticate);

/* The manual timesheet.
 *
 * Independent of work_sessions and of the Efficiency and Idle reports, and
 * nothing here reads or writes either. Those measure the clock between Accept
 * and Submit on one asset; this records what a person says they did, including
 * the parts of a day that are not an asset. One feeding the other would make
 * "Time Spent" mean two things and leave neither answer trustworthy.
 */

// The table arrives with a migration, and a step can fail. An unavailable table
// reads as an empty week rather than a 500 — the same bargain the rest of this
// codebase makes with its newer tables.
const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

const ENTRY_SELECT = `
  SELECT e.id, e.user_id AS userId, e.entry_date AS date, e.hours, e.notes,
         e.start_min AS startMin, e.end_min AS endMin,
         e.non_project AS nonProject,
         e.client_id AS clientId,  c.\`name\` AS clientName,
         e.project_id AS projectId, p.\`name\` AS projectName,
         e.asset_id AS assetId,     a.\`code\` AS assetCode, a.\`name\` AS assetName
    FROM timesheet_entries e
    LEFT JOIN clients  c ON c.id = e.client_id
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN assets   a ON a.id = e.asset_id`;

/* Whose sheet may this person open?
 *
 * Three answers, widening: your own always; your team if you hold
 * timesheet.team; anybody if you hold timesheet.all. "Your team" is the
 * reporting line the rest of the app already uses — reports_to_id or
 * team_lead_id — rather than a second idea of a team invented here.
 *
 * Returns null when the answer is "no", so a caller can 403 without a second
 * lookup deciding the same thing differently.
 */
async function mayRead(viewer, targetId) {
  if (!targetId || targetId === viewer.id) return { ok: true, scope: 'own' };
  if (holds(viewer, 'timesheet.all')) return { ok: true, scope: 'all' };
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT 1 AS ok FROM users WHERE id = $1 AND (reports_to_id = $2 OR team_lead_id = $2)',
      [targetId, viewer.id]
    );
    if (rows.length) return { ok: true, scope: 'team' };
  }
  return { ok: false };
}

// Everybody whose sheet this person may read, for the picker and the queue.
async function readableUserIds(viewer) {
  if (holds(viewer, 'timesheet.all')) {
    // Everybody. This application deactivates ROLES rather than people, so
    // there is no is_active on a user to filter by — and somebody who has left
    // still has the weeks they filled in, which is the point of keeping them.
    const { rows } = await db.query('SELECT id FROM users');
    return rows.map((r) => r.id);
  }
  const mine = [viewer.id];
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT id FROM users WHERE reports_to_id = $1 OR team_lead_id = $1', [viewer.id]
    );
    rows.forEach((r) => mine.push(r.id));
  }
  return [...new Set(mine)];
}

// The week row, made on demand. A week nobody has touched has no row, which is
// the right default: a draft is the absence of a decision, not a record of one.
async function dayRow(userId, workDate) {
  const { rows } = await db.query(
    'SELECT * FROM timesheet_days WHERE user_id = $1 AND work_date = $2', [userId, workDate]
  );
  return rows[0] || null;
}

async function ensureDay(userId, workDate) {
  const found = await dayRow(userId, workDate);
  if (found) return found;
  await db.query(
    'INSERT INTO timesheet_days (id, user_id, work_date, status) VALUES ($1,$2,$3,$4)',
    [uuid(), userId, workDate, 'draft']
  );
  return dayRow(userId, workDate);
}

/* Every change to a timesheet, on the record.
 *
 * Hours are the input to somebody's pay, so this covers edits a person makes to
 * their own week as well as decisions made about it — the self-edits are
 * exactly what a dispute turns on. Swallowed on failure for the reason
 * notifications are: an edit that happened and was not logged beats an edit
 * refused because the log could not be written.
 */
async function record(userId, workDate, action, actor, detail) {
  try {
    await db.query(
      `INSERT INTO timesheet_events (id, user_id, work_date, action, actor_id, actor_email, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), userId, workDate, action, actor.id, actor.email, detail || null]
    );
  } catch (err) {
    console.warn(`[timesheet] could not log ${action} on ${workDate}: ${err.message}`);
  }
}

/* One line, in the words the audit trail should carry: what it was against,
   not which row it was. */
function describeLine(row) {
  if (!row) return 'a line';
  if (row.nonProject) {
    const found = sheets.NON_PROJECT.find((n) => n.key === row.nonProject);
    return found ? found.label : row.nonProject;
  }
  const where = [row.clientName, row.projectName].filter(Boolean).join(' / ') || 'a project';
  return row.assetCode ? `${where} · ${row.assetCode}` : where;
}

/* One day, in the shape the page and the exports both read.
 *
 * `dayTotal` carries the two flags an approver needs — over eight hours, and
 * work on a weekend — which are flags rather than refusals because both are
 * real things that happen and a form that blocks them teaches people to lie to
 * it. Everything to do with the clock is minutes past midnight IST, which is
 * what makes the times identical for a reader in any timezone.
 */
const shapeDay = (day, entries, workDate) => {
  const total = sheets.dayTotal(entries, workSchedule.timesheetWindow());
  return {
    date: workDate,
    status: day ? day.status : 'draft',
    submittedAt: day ? day.submitted_at : null,
    decidedAt: day ? day.decided_at : null,
    decidedBy: day ? day.decider_email : null,
    rejectionReason: day ? day.rejection_reason : null,
    locked: sheets.isLocked(day ? day.status : 'draft'),
    entries: entries.map((e) => ({
      ...e,
      date: sheets.toISO(e.date),
      hours: Number(e.hours),
      startMin: Number(e.startMin),
      endMin: Number(e.endMin),
      // Rendered here so the page never turns a number into a clock itself.
      startLabel: sheets.clockLabel(Number(e.startMin)),
      endLabel: sheets.clockLabel(Number(e.endMin)),
    })),
    hours: total.hours,
    overLong: total.overLong,
    weekend: sheets.isWeekend(workDate),
  };
};

/* The studio's working day, handed to the page rather than repeated in it.
   It comes from Settings -> Working Hours, so changing the window there changes
   the form, its refusals and its hints together, with nothing to redeploy.
   hasLunch is false for a studio with no fixed break, which is a real answer
   and not the same as a lunch hour of length zero. */
const workingDay = () => {
  const win = workSchedule.timesheetWindow();
  return {
    timezone: win.timezone,
    dayStart: sheets.clockLabel(win.dayStart),
    dayEnd: sheets.clockLabel(win.dayEnd),
    hasLunch: win.lunchStart !== null && win.lunchEnd !== null,
    lunchStart: sheets.clockLabel(win.lunchStart),
    lunchEnd: sheets.clockLabel(win.lunchEnd),
    maxHours: win.maxHours,
  };
};

/* GET /api/timesheets/week?date=&userId= — seven days, for filling in.
 *
 * Still a week on screen even though submission is now daily: a week is how
 * somebody wants to SEE their time, and one day at a time is seven navigations
 * to do one job. Each day carries its own status and its own lock, which is
 * what changed.
 */
router.get('/week', requirePermission('timesheet.own'), async (req, res) => {
  const anchor = sheets.toISO(req.query.date) || sheets.toISO(new Date().toISOString().slice(0, 10));
  const days = sheets.weekDays(anchor);
  const userId = req.query.userId || req.user.id;

  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  try {
    const { rows: entries } = await db.query(
      `${ENTRY_SELECT} WHERE e.user_id = $1 AND e.entry_date BETWEEN $2 AND $3
        ORDER BY e.entry_date, e.start_min`,
      [userId, days[0], days[6]]
    );
    const { rows: dayRows } = await db.query(
      'SELECT * FROM timesheet_days WHERE user_id = $1 AND work_date BETWEEN $2 AND $3',
      [userId, days[0], days[6]]
    );
    const byDate = new Map(dayRows.map((d) => [sheets.toISO(d.work_date), d]));
    const { rows: who } = await db.query('SELECT id, `name`, email FROM users WHERE id = $1', [userId]);

    const shaped = days.map((d) =>
      shapeDay(byDate.get(d) || null, entries.filter((e) => sheets.toISO(e.date) === d), d));

    res.json({
      user: who[0] || null,
      mine: userId === req.user.id,
      mayEdit: userId === req.user.id,
      mayDecide: holds(req.user, 'timesheet.approve') && userId !== req.user.id,
      nonProjectTypes: sheets.NON_PROJECT,
      workingDay: workingDay(),
      days: shaped,
      weekStart: days[0],
      weekEnd: days[6],
      weekHours: Math.round(shaped.reduce((n, d) => n + d.hours, 0) * 100) / 100,
    });
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] timesheet tables unavailable (${err.code}); the week reads empty.`);
    res.json({
      user: null, mine: true, mayEdit: false, mayDecide: false, unavailable: true,
      nonProjectTypes: sheets.NON_PROJECT, workingDay: workingDay(),
      days: days.map((d) => shapeDay(null, [], d)),
      weekStart: days[0], weekEnd: days[6], weekHours: 0,
    });
  }
});

// Who this person may look at, for the picker beside the week.
router.get('/people', requirePermission('timesheet.own'), async (req, res) => {
  const ids = await readableUserIds(req.user);
  if (!ids.length) return res.json({ users: [] });
  const holes = ids.map((_, n) => `$${n + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT id, \`name\`, email, \`role\` FROM users WHERE id IN (${holes}) ORDER BY \`name\``, ids
  );
  res.json({ users: rows, scope: holds(req.user, 'timesheet.all') ? 'all'
    : (holds(req.user, 'timesheet.team') ? 'team' : 'own') });
});

/* POST /api/timesheets/entries — add a line to your own day.
 *
 * Your own, always: there is no path here to writing hours onto somebody else's
 * sheet. An approver sends a day back for its owner to correct rather than
 * correcting it themselves, because a timesheet somebody else edited is no
 * longer that person's statement of their day.
 */
router.post('/entries', requirePermission('timesheet.own'), async (req, res) => {
  const verdict = sheets.validateEntry(req.body || {}, workSchedule.timesheetWindow());
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;

  const day = await ensureDay(req.user.id, line.date).catch((err) => {
    if (unavailable(err)) return null;
    throw err;
  });
  if (!day) {
    return res.status(503).json({
      error: 'Timesheets are not available on this deployment yet — the database is missing the '
        + 'timesheet tables. See /api/health.',
    });
  }
  if (sheets.isLocked(day.status)) {
    return res.status(409).json({
      error: day.status === 'approved'
        ? 'That day has been approved and can no longer be changed.'
        : 'That day is with your approver. Ask them to send it back if it needs changing.',
      status: day.status,
    });
  }

  /* The same hour claimed twice is the one arithmetic error a timesheet cannot
     catch by adding up — the total looks perfectly reasonable. */
  const { rows: existing } = await db.query(
    'SELECT start_min AS startMin, end_min AS endMin FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2',
    [req.user.id, line.date]
  );
  const clash = sheets.overlaps(line, existing.map((e) => ({ startMin: Number(e.startMin), endMin: Number(e.endMin) })));
  if (clash) {
    return res.status(409).json({
      error: `That overlaps ${sheets.clockLabel(clash.startMin)}–${sheets.clockLabel(clash.endMin)}, which is already logged.`,
      field: 'startTime',
    });
  }

  const id = uuid();
  await db.query(
    `INSERT INTO timesheet_entries
       (id, user_id, entry_date, start_min, end_min, client_id, project_id, asset_id, non_project, hours, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, req.user.id, line.date, line.startMin, line.endMin, line.clientId, line.projectId,
     line.assetId, line.nonProject, line.hours, line.notes]
  );

  const { rows } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
  const said = `${sheets.clockLabel(line.startMin)}–${sheets.clockLabel(line.endMin)} `
    + `(${line.hours}h) — ${describeLine(rows[0])}`;
  await record(req.user.id, line.date, 'entry_added', req.user, said);
  req.activity({
    module: 'timesheet', action: 'timesheet.entry', entityType: 'day',
    entityId: id, entityLabel: line.date,
    summary: `Logged ${said} on ${line.date}`,
  });
  res.status(201).json({
    entry: { ...rows[0], date: sheets.toISO(rows[0].date), hours: Number(rows[0].hours) },
    // Said out loud rather than shown as a smaller number with no explanation.
    lunchSubtracted: verdict.lunchSubtracted || 0,
  });
});

// PATCH /api/timesheets/entries/:id — change one of your own lines.
router.patch('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }

  const wasOn = sheets.toISO(found[0].entry_date);
  const day = await dayRow(req.user.id, wasOn);
  if (day && sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day is locked.', status: day.status });
  }

  // Validated as a whole rather than field by field: the window, the lunch hour
  // and the either/or rule are all about the row, not about one cell.
  const merged = {
    date: req.body.date ?? wasOn,
    startTime: req.body.startTime ?? Number(found[0].start_min),
    endTime: req.body.endTime ?? Number(found[0].end_min),
    clientId: 'clientId' in req.body ? req.body.clientId : found[0].client_id,
    projectId: 'projectId' in req.body ? req.body.projectId : found[0].project_id,
    assetId: 'assetId' in req.body ? req.body.assetId : found[0].asset_id,
    nonProject: 'nonProject' in req.body ? req.body.nonProject : found[0].non_project,
    notes: 'notes' in req.body ? req.body.notes : found[0].notes,
  };
  const verdict = sheets.validateEntry(merged, workSchedule.timesheetWindow());
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;

  const { rows: others } = await db.query(
    'SELECT start_min AS startMin, end_min AS endMin FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2 AND id <> $3',
    [req.user.id, line.date, req.params.id]
  );
  const clash = sheets.overlaps(line, others.map((e) => ({ startMin: Number(e.startMin), endMin: Number(e.endMin) })));
  if (clash) {
    return res.status(409).json({
      error: `That overlaps ${sheets.clockLabel(clash.startMin)}–${sheets.clockLabel(clash.endMin)}, which is already logged.`,
      field: 'startTime',
    });
  }
  // Moving a line to another day needs that day to exist and to be unlocked.
  if (line.date !== wasOn) {
    const target = await ensureDay(req.user.id, line.date);
    if (sheets.isLocked(target.status)) {
      return res.status(409).json({ error: 'That day is locked.', status: target.status });
    }
  }

  await db.query(
    `UPDATE timesheet_entries
        SET entry_date = $1, start_min = $2, end_min = $3, client_id = $4, project_id = $5,
            asset_id = $6, non_project = $7, hours = $8, notes = $9
      WHERE id = $10`,
    [line.date, line.startMin, line.endMin, line.clientId, line.projectId, line.assetId,
     line.nonProject, line.hours, line.notes, req.params.id]
  );
  const { rows } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [req.params.id]);
  await record(req.user.id, line.date, 'entry_edited', req.user,
    `now ${sheets.clockLabel(line.startMin)}–${sheets.clockLabel(line.endMin)} (${line.hours}h) — ${describeLine(rows[0])}`);
  res.json({
    entry: { ...rows[0], date: sheets.toISO(rows[0].date), hours: Number(rows[0].hours) },
    lunchSubtracted: verdict.lunchSubtracted || 0,
  });
});

// DELETE /api/timesheets/entries/:id
router.delete('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }
  const on = sheets.toISO(found[0].entry_date);
  const day = await dayRow(req.user.id, on);
  if (day && sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day is locked.', status: day.status });
  }
  await db.query('DELETE FROM timesheet_entries WHERE id = $1', [req.params.id]);
  await record(req.user.id, on, 'entry_removed', req.user,
    `${sheets.clockLabel(Number(found[0].start_min))}–${sheets.clockLabel(Number(found[0].end_min))} removed`);
  res.json({ ok: true });
});

/* POST /api/timesheets/submit — hand ONE DAY to your approver.
 * body: { date }
 *
 * Daily, replacing the weekly cycle the feature shipped with. A day is what
 * gets approved now, which means a Tuesday can be approved while Wednesday is
 * still being filled in — the thing a weekly row could not express.
 */
router.post('/submit', requirePermission('timesheet.own'), async (req, res) => {
  const date = sheets.toISO(req.body.date || new Date().toISOString().slice(0, 10));
  if (!date) return res.status(400).json({ error: 'Which day?', field: 'date' });

  const day = await ensureDay(req.user.id, date).catch((err) => {
    if (unavailable(err)) return null; throw err;
  });
  if (!day) return res.status(503).json({ error: 'Timesheets are not available on this deployment yet.' });
  if (sheets.isLocked(day.status)) {
    return res.status(409).json({ error: 'That day has already been submitted.', status: day.status });
  }

  const { rows } = await db.query(
    'SELECT hours FROM timesheet_entries WHERE user_id = $1 AND entry_date = $2',
    [req.user.id, date]
  );
  // An empty day is not a submission. Somebody who worked nothing has nothing
  // to approve, and a queue of empty days is a queue nobody reads.
  if (!rows.length) {
    return res.status(400).json({ error: 'There is nothing on that day to submit.' });
  }

  await db.query(
    `UPDATE timesheet_days SET status = 'submitted', submitted_at = NOW(),
        decided_by = NULL, decider_email = NULL, decided_at = NULL, rejection_reason = NULL
      WHERE user_id = $1 AND work_date = $2`,
    [req.user.id, date]
  );
  const total = sheets.dayTotal(rows, workSchedule.timesheetWindow());
  await record(req.user.id, date, 'submitted', req.user,
    `${total.hours}h across ${total.lines} line(s)${total.overLong ? ' — over the eight-hour day' : ''}`);
  console.log(`${req.user.email} submitted their timesheet for ${date} (${total.hours}h).`);

  req.activity({
    module: 'timesheet', action: 'timesheet.submit', entityType: 'day', entityLabel: date,
    summary: `Submitted their timesheet for ${date} — ${total.hours}h across ${total.lines} line(s)`,
    changes: { status: { from: 'draft', to: 'submitted' } },
  });

  const saved = await dayRow(req.user.id, date);
  res.json({
    day: { date, status: saved.status, submittedAt: saved.submitted_at, locked: true },
    overLong: total.overLong,
  });
});

/* GET /api/timesheets/pending — submitted DAYS waiting on this approver.
 * Scoped exactly as reading is: your team, or the studio if you hold all.
 */
router.get('/pending', requirePermission('timesheet.approve'), async (req, res) => {
  const ids = (await readableUserIds(req.user)).filter((id) => id !== req.user.id);
  if (!ids.length) return res.json({ days: [], count: 0 });
  const holes = ids.map((_, n) => `$${n + 1}`).join(',');
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.user_id AS userId, d.work_date AS date, d.status,
              d.submitted_at AS submittedAt, u.\`name\` AS userName, u.email AS userEmail,
              (SELECT COALESCE(SUM(e.hours), 0) FROM timesheet_entries e
                WHERE e.user_id = d.user_id AND e.entry_date = d.work_date) AS hours
         FROM timesheet_days d
         JOIN users u ON u.id = d.user_id
        WHERE d.status = 'submitted' AND d.user_id IN (${holes})
        ORDER BY d.work_date DESC, u.\`name\``,
      ids
    );
    res.json({
      days: rows.map((r) => {
        const date = sheets.toISO(r.date);
        const hours = Number(r.hours);
        return {
          ...r, date, hours,
          /* The two things worth an approver's second look, carried into the
             queue so they are visible before opening the day. */
          overLong: hours > workSchedule.timesheetWindow().maxHours,
          weekend: sheets.isWeekend(date),
        };
      }),
      count: rows.length,
      maxHours: workSchedule.timesheetWindow().maxHours,
    });
  } catch (err) {
    if (!unavailable(err)) throw err;
    res.json({ days: [], count: 0, unavailable: true });
  }
});

/* POST /api/timesheets/:userId/:date/decision — approve a day, or send it back.
 * body: { decision: 'approve' | 'reject', reason? }
 */
router.post('/:userId/:date/decision', requirePermission('timesheet.approve'), async (req, res) => {
  const { decision, reason } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Say whether this is an approval or a rejection.', field: 'decision' });
  }
  const note = String(reason || '').trim();
  if (decision === 'reject' && !note) {
    return res.status(400).json({
      error: 'Say what needs correcting — a day sent back without a reason cannot be fixed.',
      field: 'reason',
    });
  }

  const userId = req.params.userId;
  if (userId === req.user.id) {
    // Nobody approves their own hours. The same rule the project review queue
    // learned: a decision by the person it is about is not a decision.
    return res.status(403).json({ error: 'You cannot decide on your own timesheet.' });
  }
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not somebody you approve for.' });

  const date = sheets.toISO(req.params.date);
  if (!date) return res.status(400).json({ error: 'That is not a date.' });
  const day = await dayRow(userId, date);
  if (!day) return res.status(404).json({ error: 'There is no timesheet for that day.' });
  if (day.status !== 'submitted') {
    return res.status(409).json({
      error: day.status === 'draft'
        ? 'That day has not been submitted yet.'
        : `That day has already been ${day.status}.`,
      status: day.status,
    });
  }

  const next = decision === 'approve' ? 'approved' : 'rejected';
  await db.query(
    `UPDATE timesheet_days
        SET status = $1, decided_by = $2, decider_email = $3, decided_at = NOW(), rejection_reason = $4
      WHERE user_id = $5 AND work_date = $6`,
    [next, req.user.id, req.user.email, decision === 'reject' ? note : null, userId, date]
  );
  await record(userId, date, next, req.user, decision === 'reject' ? note : 'approved');
  console.log(`${req.user.email} ${next} the timesheet of ${userId} for ${date}.`);

  /* Whose day it was, by name. Read here rather than carried down from the
     authorisation check above, which only needed the id — an entry saying
     "approved the timesheet of 8f3c-..." is not a record anybody can read. */
  const { rows: whoRows } = await db.query('SELECT `name` FROM users WHERE id = $1', [userId]);
  const whose = (whoRows[0] || {}).name || userId;
  req.activity({
    module: 'timesheet', action: `timesheet.${next}`, entityType: 'day',
    entityId: userId, entityLabel: `${date} — ${whose}`,
    summary: `${next === 'approved' ? 'Approved' : 'Sent back'} the timesheet of ${whose} for ${date}`
      + (decision === 'reject' && note ? ` — ${note.slice(0, 120)}` : ''),
    changes: { status: { from: 'submitted', to: next } },
  });

  const saved = await dayRow(userId, date);
  res.json({
    day: {
      date, status: saved.status, decidedBy: saved.decider_email,
      decidedAt: saved.decided_at, rejectionReason: saved.rejection_reason,
      locked: sheets.isLocked(saved.status),
    },
  });
});

/* GET /api/timesheets/history?userId=&date= — the audit trail for a day. */
router.get('/history', requirePermission('timesheet.own'), async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });
  const date = sheets.toISO(req.query.date || new Date().toISOString().slice(0, 10));
  try {
    const { rows } = await db.query(
      `SELECT action, actor_email AS actorEmail, detail, created_at AS at
         FROM timesheet_events WHERE user_id = $1 AND work_date = $2 ORDER BY seq`,
      [userId, date]
    );
    res.json({ date, events: rows });
  } catch (err) {
    if (!unavailable(err)) throw err;
    res.json({ date, events: [], unavailable: true });
  }
});

/* --- exports ---------------------------------------------------------------

   The spreadsheet and the document, built from the same rows the screen shows.
   Gated on reading rather than on a permission of their own: the studio's
   Reports exports work the same way — being able to download a report is being
   able to read it, in another shape. Scope is the same mayRead as everywhere
   else in this file, so an export can never reach further than the tab can.
*/
async function exportRows(req) {
  const userId = req.query.userId || req.user.id;
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return { ok: false };

  const from = sheets.toISO(req.query.from) || sheets.weekStart(new Date().toISOString().slice(0, 10));
  const to = sheets.toISO(req.query.to) || from;

  const { rows } = await db.query(
    `${ENTRY_SELECT} WHERE e.user_id = $1 AND e.entry_date BETWEEN $2 AND $3
      ORDER BY e.entry_date, e.start_min`,
    [userId, from, to]
  );
  const { rows: who } = await db.query('SELECT `name`, email FROM users WHERE id = $1', [userId]);
  /* Status per DAY now, not per week — an export of a fortnight can legitimately
     show some days approved and others still in draft, which the weekly shape
     could not express. */
  const { rows: dayRows } = await db.query(
    'SELECT work_date AS date, status FROM timesheet_days WHERE user_id = $1 AND work_date BETWEEN $2 AND $3',
    [userId, from, to]
  );
  const statusOf = new Map(dayRows.map((d) => [sheets.toISO(d.date), d.status]));

  const nonProjectLabel = Object.fromEntries(sheets.NON_PROJECT.map((n) => [n.key, n.label]));
  return {
    ok: true,
    person: who[0] || { name: 'Unknown', email: '' },
    from,
    to,
    total: Math.round(rows.reduce((n, r) => n + Number(r.hours), 0) * 100) / 100,
    rows: rows.map((r) => ({
      Date: sheets.toISO(r.date),
      // The clock, as the studio reads it. IST for every reader, because these
      // are minutes past midnight rather than instants needing a timezone.
      Start: sheets.clockLabel(Number(r.startMin)),
      End: sheets.clockLabel(Number(r.endMin)),
      Client: r.clientName || '',
      Project: r.projectName || '',
      Asset: r.assetCode ? `${r.assetCode} — ${r.assetName}` : '',
      Category: r.nonProject ? (nonProjectLabel[r.nonProject] || r.nonProject) : '',
      Hours: Number(r.hours),
      Notes: r.notes || '',
      Status: statusOf.get(sheets.toISO(r.date)) || 'draft',
    })),
  };
}

const EXPORT_HEADERS = ['Date', 'Start', 'End', 'Client', 'Project', 'Asset', 'Category',
  'Hours', 'Notes', 'Status'];

router.get('/export.xlsx', requirePermission('timesheet.own'), async (req, res) => {
  const data = await exportRows(req);
  if (!data.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  const book = xlsx.utils.book_new();
  const head = [
    [branding.current().appName],
    ['Time sheet'],
    [],
    ['Person', `${data.person.name} <${data.person.email}>`],
    ['From', data.from],
    ['To', data.to],
    ['Total hours', data.total],
    ['Times shown in', workSchedule.timesheetWindow().timezone],
    [],
  ];
  const sheet = xlsx.utils.aoa_to_sheet(head);
  xlsx.utils.sheet_add_json(sheet, data.rows, { header: EXPORT_HEADERS, origin: -1 });
  xlsx.utils.book_append_sheet(book, sheet, 'Time sheet');

  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'timesheet', 'xlsx')}"`);
  res.send(buffer);
});

router.get('/export.pdf', requirePermission('timesheet.own'), async (req, res) => {
  const data = await exportRows(req);
  if (!data.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  const logo = await branding.readLogo(db).catch(() => null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'timesheet', 'pdf')}"`);
  reportPdf.write(res, {
    appName: branding.current().appName,
    tagline: branding.current().tagline,
    logo,
    view: { label: 'Time sheet', sheet: 'Time sheet' },
    title: 'Time sheet',
    blurb: `Every line logged in this range, in ${workSchedule.timesheetWindow().timezone}. `
      + 'Hours exclude the lunch break. Status is the state of the day the line belongs to.',
    footer: 'time sheet',
    emptyMessage: 'No time was logged in this range.',
    headers: EXPORT_HEADERS,
    /* The row objects, not a positional mapping of them. report-pdf reads each
       cell by header name, so mapping to arrays here produced a document with
       the right totals and forty blank rows under them. */
    rows: data.rows,
    filters: [
      ['Person', `${data.person.name} <${data.person.email}>`],
      ['From', data.from],
      ['To', data.to],
    ],
    summary: [['Total hours', String(data.total)], ['Lines', String(data.rows.length)]],
    excluded: [],
  });
});

module.exports = router;
module.exports.readableUserIds = readableUserIds;
module.exports.mayRead = mayRead;
