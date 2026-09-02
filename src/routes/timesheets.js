const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { holds } = require('../permissions');
const sheets = require('../timesheets');
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
async function weekRow(userId, weekStart) {
  const { rows } = await db.query(
    'SELECT * FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2', [userId, weekStart]
  );
  return rows[0] || null;
}

async function ensureWeek(userId, weekStart) {
  const found = await weekRow(userId, weekStart);
  if (found) return found;
  await db.query(
    'INSERT INTO timesheet_weeks (id, user_id, week_start, status) VALUES ($1,$2,$3,$4)',
    [uuid(), userId, weekStart, 'draft']
  );
  return weekRow(userId, weekStart);
}

/* Every change to a timesheet, on the record.
 *
 * Hours are the input to somebody's pay, so this covers edits a person makes to
 * their own week as well as decisions made about it — the self-edits are
 * exactly what a dispute turns on. Swallowed on failure for the reason
 * notifications are: an edit that happened and was not logged beats an edit
 * refused because the log could not be written.
 */
async function record(userId, weekStart, action, actor, detail) {
  try {
    await db.query(
      `INSERT INTO timesheet_events (id, user_id, week_start, action, actor_id, actor_email, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), userId, weekStart, action, actor.id, actor.email, detail || null]
    );
  } catch (err) {
    console.warn(`[timesheet] could not log ${action} on ${weekStart}: ${err.message}`);
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

const shape = (week, entries, weekStart) => ({
  weekStart,
  status: week ? week.status : 'draft',
  submittedAt: week ? week.submitted_at : null,
  decidedAt: week ? week.decided_at : null,
  decidedBy: week ? week.decider_email : null,
  rejectionReason: week ? week.rejection_reason : null,
  locked: sheets.isLocked(week ? week.status : 'draft'),
  entries: entries.map((e) => ({ ...e, date: sheets.toISO(e.date), hours: Number(e.hours) })),
  totals: sheets.totals(entries, weekStart),
});

/* GET /api/timesheets/week?date=&userId= — one person's week.
 *
 * `date` is any day in the week wanted; the Monday is worked out here so the
 * browser never has to. Omitting userId means your own, which is what the tab
 * opens on.
 */
router.get('/week', requirePermission('timesheet.own'), async (req, res) => {
  const weekStart = sheets.weekStart(req.query.date || new Date().toISOString().slice(0, 10));
  const userId = req.query.userId || req.user.id;

  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });

  try {
    const week = await weekRow(userId, weekStart);
    const { rows } = await db.query(
      `${ENTRY_SELECT} WHERE e.user_id = $1 AND e.week_start = $2 ORDER BY e.entry_date, e.created_at`,
      [userId, weekStart]
    );
    const { rows: who } = await db.query('SELECT id, `name`, email FROM users WHERE id = $1', [userId]);
    res.json({
      user: who[0] || null,
      mine: userId === req.user.id,
      // What this reader may do with what they are looking at, decided here so
      // the page does not have to work it out from a permission list.
      mayEdit: userId === req.user.id,
      mayDecide: holds(req.user, 'timesheet.approve') && userId !== req.user.id,
      nonProjectTypes: sheets.NON_PROJECT,
      warnHours: sheets.DAY_WARN_HOURS,
      ...shape(week, rows, weekStart),
    });
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] timesheet tables unavailable (${err.code}); the week reads empty.`);
    res.json({ user: null, mine: true, mayEdit: false, mayDecide: false, unavailable: true,
      nonProjectTypes: sheets.NON_PROJECT, warnHours: sheets.DAY_WARN_HOURS,
      ...shape(null, [], weekStart) });
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

/* POST /api/timesheets/entries — add a line to your own week.
 *
 * Your own, always: there is no path here to writing hours onto somebody else's
 * sheet. An approver sends a week back for its owner to correct rather than
 * correcting it themselves, because a timesheet somebody else edited is no
 * longer that person's statement of their week.
 */
router.post('/entries', requirePermission('timesheet.own'), async (req, res) => {
  const verdict = sheets.validateEntry(req.body || {});
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;

  const week = await ensureWeek(req.user.id, line.weekStart).catch((err) => {
    if (unavailable(err)) return null;
    throw err;
  });
  if (!week) {
    return res.status(503).json({
      error: 'Timesheets are not available on this deployment yet — the database is missing the '
        + 'timesheet tables. See /api/health.',
    });
  }
  if (sheets.isLocked(week.status)) {
    return res.status(409).json({
      error: week.status === 'approved'
        ? 'That week has been approved and can no longer be changed.'
        : 'That week is with your approver. Ask them to send it back if it needs changing.',
      status: week.status,
    });
  }

  const id = uuid();
  await db.query(
    `INSERT INTO timesheet_entries
       (id, user_id, week_start, entry_date, client_id, project_id, asset_id, non_project, hours, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, req.user.id, line.weekStart, line.date, line.clientId, line.projectId, line.assetId,
     line.nonProject, line.hours, line.notes]
  );
  const { rows } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
  /* Logged from the row as read back, so the trail names the project rather
     than its id. An audit line somebody has to look up is an audit line nobody
     reads. */
  await record(req.user.id, line.weekStart, 'entry_added', req.user,
    `${line.date}: ${line.hours}h — ${describeLine(rows[0])}`);
  res.status(201).json({ entry: { ...rows[0], date: sheets.toISO(rows[0].date), hours: Number(rows[0].hours) } });
});

// PATCH /api/timesheets/entries/:id — change one of your own lines.
router.patch('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }

  const week = await weekRow(req.user.id, sheets.toISO(found[0].week_start));
  if (week && sheets.isLocked(week.status)) {
    return res.status(409).json({ error: 'That week is locked.', status: week.status });
  }

  // Validated as a whole rather than field by field: the either/or rule between
  // project work and non-project time is about the row, not about one cell.
  const merged = {
    date: req.body.date ?? sheets.toISO(found[0].entry_date),
    hours: req.body.hours ?? Number(found[0].hours),
    clientId: 'clientId' in req.body ? req.body.clientId : found[0].client_id,
    projectId: 'projectId' in req.body ? req.body.projectId : found[0].project_id,
    assetId: 'assetId' in req.body ? req.body.assetId : found[0].asset_id,
    nonProject: 'nonProject' in req.body ? req.body.nonProject : found[0].non_project,
    notes: 'notes' in req.body ? req.body.notes : found[0].notes,
  };
  const verdict = sheets.validateEntry(merged);
  if (!verdict.ok) return res.status(400).json(verdict);
  const line = verdict.value;

  await db.query(
    `UPDATE timesheet_entries
        SET entry_date = $1, week_start = $2, client_id = $3, project_id = $4, asset_id = $5,
            non_project = $6, hours = $7, notes = $8
      WHERE id = $9`,
    [line.date, line.weekStart, line.clientId, line.projectId, line.assetId,
     line.nonProject, line.hours, line.notes, req.params.id]
  );
  const { rows } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [req.params.id]);
  await record(req.user.id, line.weekStart, 'entry_edited', req.user,
    `${line.date}: now ${line.hours}h — ${describeLine(rows[0])}`);
  res.json({ entry: { ...rows[0], date: sheets.toISO(rows[0].date), hours: Number(rows[0].hours) } });
});

// DELETE /api/timesheets/entries/:id
router.delete('/entries/:id', requirePermission('timesheet.own'), async (req, res) => {
  const { rows: found } = await db.query('SELECT * FROM timesheet_entries WHERE id = $1', [req.params.id])
    .catch(() => ({ rows: [] }));
  if (!found.length) return res.status(404).json({ error: 'That line does not exist.' });
  if (found[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'That line is on somebody else\'s timesheet.' });
  }
  const weekStart = sheets.toISO(found[0].week_start);
  const week = await weekRow(req.user.id, weekStart);
  if (week && sheets.isLocked(week.status)) {
    return res.status(409).json({ error: 'That week is locked.', status: week.status });
  }
  await db.query('DELETE FROM timesheet_entries WHERE id = $1', [req.params.id]);
  await record(req.user.id, weekStart, 'entry_removed', req.user,
    `${sheets.toISO(found[0].entry_date)}: ${Number(found[0].hours)}h removed`);
  res.json({ ok: true });
});

/* POST /api/timesheets/submit — hand a week to your approver.
 * body: { weekStart } (or any date in the week)
 */
router.post('/submit', requirePermission('timesheet.own'), async (req, res) => {
  const weekStart = sheets.weekStart(req.body.weekStart || req.body.date || new Date().toISOString().slice(0, 10));
  const week = await ensureWeek(req.user.id, weekStart).catch((err) => {
    if (unavailable(err)) return null; throw err;
  });
  if (!week) return res.status(503).json({ error: 'Timesheets are not available on this deployment yet.' });
  if (sheets.isLocked(week.status)) {
    return res.status(409).json({ error: 'That week has already been submitted.', status: week.status });
  }

  const { rows } = await db.query(
    'SELECT hours, entry_date FROM timesheet_entries WHERE user_id = $1 AND week_start = $2',
    [req.user.id, weekStart]
  );
  // An empty week is not a submission. Somebody who worked nothing that week has
  // nothing to approve, and a queue full of empty weeks is a queue nobody reads.
  if (!rows.length) {
    return res.status(400).json({ error: 'There is nothing on that week to submit.' });
  }

  await db.query(
    `UPDATE timesheet_weeks SET status = 'submitted', submitted_at = NOW(),
        decided_by = NULL, decider_email = NULL, decided_at = NULL, rejection_reason = NULL
      WHERE user_id = $1 AND week_start = $2`,
    [req.user.id, weekStart]
  );
  const total = sheets.totals(rows.map((r) => ({ date: r.entry_date, hours: r.hours })), weekStart).week;
  await record(req.user.id, weekStart, 'submitted', req.user, `${total}h across ${rows.length} lines`);
  console.log(`${req.user.email} submitted their timesheet for the week of ${weekStart} (${total}h).`);

  const saved = await weekRow(req.user.id, weekStart);
  res.json({ week: { weekStart, status: saved.status, submittedAt: saved.submitted_at, locked: true } });
});

/* GET /api/timesheets/pending — submitted weeks waiting on this approver.
 * Scoped exactly as reading is: your team, or the studio if you hold all.
 */
router.get('/pending', requirePermission('timesheet.approve'), async (req, res) => {
  const ids = (await readableUserIds(req.user)).filter((id) => id !== req.user.id);
  if (!ids.length) return res.json({ weeks: [], count: 0 });
  const holes = ids.map((_, n) => `$${n + 1}`).join(',');
  try {
    const { rows } = await db.query(
      `SELECT w.id, w.user_id AS userId, w.week_start AS weekStart, w.status,
              w.submitted_at AS submittedAt, u.\`name\` AS userName, u.email AS userEmail,
              (SELECT COALESCE(SUM(e.hours), 0) FROM timesheet_entries e
                WHERE e.user_id = w.user_id AND e.week_start = w.week_start) AS hours
         FROM timesheet_weeks w
         JOIN users u ON u.id = w.user_id
        WHERE w.status = 'submitted' AND w.user_id IN (${holes})
        ORDER BY w.week_start DESC, u.\`name\``,
      ids
    );
    res.json({
      weeks: rows.map((r) => ({ ...r, weekStart: sheets.toISO(r.weekStart), hours: Number(r.hours) })),
      count: rows.length,
    });
  } catch (err) {
    if (!unavailable(err)) throw err;
    res.json({ weeks: [], count: 0, unavailable: true });
  }
});

/* POST /api/timesheets/:userId/:weekStart/decision — approve, or send it back.
 * body: { decision: 'approve' | 'reject', reason? }
 *
 * A rejection carries a reason and is refused without one: returning somebody's
 * week with no explanation asks them to guess at their own hours. An approval
 * needs none — the decision is the whole of it.
 */
router.post('/:userId/:weekStart/decision', requirePermission('timesheet.approve'), async (req, res) => {
  const { decision, reason } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Say whether this is an approval or a rejection.', field: 'decision' });
  }
  const note = String(reason || '').trim();
  if (decision === 'reject' && !note) {
    return res.status(400).json({
      error: 'Say what needs correcting — a week sent back without a reason cannot be fixed.',
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

  const weekStart = sheets.weekStart(req.params.weekStart);
  const week = await weekRow(userId, weekStart);
  if (!week) return res.status(404).json({ error: 'There is no timesheet for that week.' });
  if (week.status !== 'submitted') {
    return res.status(409).json({
      error: week.status === 'draft'
        ? 'That week has not been submitted yet.'
        : `That week has already been ${week.status}.`,
      status: week.status,
    });
  }

  const next = decision === 'approve' ? 'approved' : 'rejected';
  await db.query(
    `UPDATE timesheet_weeks
        SET status = $1, decided_by = $2, decider_email = $3, decided_at = NOW(), rejection_reason = $4
      WHERE user_id = $5 AND week_start = $6`,
    [next, req.user.id, req.user.email, decision === 'reject' ? note : null, userId, weekStart]
  );
  await record(userId, weekStart, next, req.user, decision === 'reject' ? note : 'approved');
  console.log(`${req.user.email} ${next} the timesheet of ${userId} for the week of ${weekStart}.`);

  const saved = await weekRow(userId, weekStart);
  res.json({
    week: {
      weekStart, status: saved.status, decidedBy: saved.decider_email,
      decidedAt: saved.decided_at, rejectionReason: saved.rejection_reason,
      locked: sheets.isLocked(saved.status),
    },
  });
});

/* GET /api/timesheets/history?userId=&weekStart= — the audit trail for a week.
 * Read by whoever may read the week itself; there is nothing in it that is not
 * already visible on the sheet, only when and by whom.
 */
router.get('/history', requirePermission('timesheet.own'), async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const verdict = await mayRead(req.user, userId);
  if (!verdict.ok) return res.status(403).json({ error: 'That is not your timesheet.' });
  const weekStart = sheets.weekStart(req.query.weekStart || req.query.date || new Date().toISOString().slice(0, 10));
  try {
    const { rows } = await db.query(
      `SELECT action, actor_email AS actorEmail, detail, created_at AS at
         FROM timesheet_events WHERE user_id = $1 AND week_start = $2 ORDER BY seq`,
      [userId, weekStart]
    );
    res.json({ weekStart, events: rows });
  } catch (err) {
    if (!unavailable(err)) throw err;
    res.json({ weekStart, events: [], unavailable: true });
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
      ORDER BY e.entry_date, e.created_at`,
    [userId, from, to]
  );
  const { rows: who } = await db.query('SELECT `name`, email FROM users WHERE id = $1', [userId]);
  const { rows: weeks } = await db.query(
    'SELECT week_start AS weekStart, status FROM timesheet_weeks WHERE user_id = $1 AND week_start BETWEEN $2 AND $3',
    [userId, sheets.weekStart(from), to]
  );
  const statusOf = new Map(weeks.map((w) => [sheets.toISO(w.weekStart), w.status]));

  const nonProjectLabel = Object.fromEntries(sheets.NON_PROJECT.map((n) => [n.key, n.label]));
  return {
    ok: true,
    person: who[0] || { name: 'Unknown', email: '' },
    from,
    to,
    total: Math.round(rows.reduce((n, r) => n + Number(r.hours), 0) * 100) / 100,
    rows: rows.map((r) => ({
      Date: sheets.toISO(r.date),
      Client: r.clientName || '',
      Project: r.projectName || '',
      Asset: r.assetCode ? `${r.assetCode} — ${r.assetName}` : '',
      Category: r.nonProject ? (nonProjectLabel[r.nonProject] || r.nonProject) : '',
      Hours: Number(r.hours),
      Notes: r.notes || '',
      Status: statusOf.get(sheets.weekStart(sheets.toISO(r.date))) || 'draft',
    })),
  };
}

const EXPORT_HEADERS = ['Date', 'Client', 'Project', 'Asset', 'Category', 'Hours', 'Notes', 'Status'];

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
    headers: EXPORT_HEADERS,
    rows: data.rows.map((r) => EXPORT_HEADERS.map((h) => r[h])),
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
