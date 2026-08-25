const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { upload, uploadImport } = require('../upload');
const {
  canAccessProject,
  canViewAsset,
  canEditAsset,
  canDeleteAsset,
  canCreateAsset,
  isAssignedArtist,
  isTeamLeadOfAsset,
  canReviewAsCD,
  canOverrideReview,
  canMarkDelivered,
  canOverrideStage,
} = require('../permissions');
const { assignableRoles, roleDef } = require('../roles');
const assetImport = require('../asset-import');
const workflow = require('../asset-workflow');
const submissionLink = require('../submission-link');
const referenceData = require('../reference-data');

router.use(authenticate);

async function attachTasksAndNotes(assets) {
  if (!assets.length) return assets;
  const ids = assets.map((a) => a.id);
  const { rows: tasks } = await db.query(
    'SELECT * FROM tasks WHERE asset_id IN ($1) ORDER BY `position`',
    [ids]
  );
  const { rows: notes } = await db.query(
    `SELECT n.*, u.name AS author_name FROM notes n
     LEFT JOIN users u ON u.id = n.author_id
     WHERE n.asset_id IN ($1) ORDER BY n.created_at DESC`,
    [ids]
  );
  const { rows: versions } = await db.query(
    `SELECT v.*, u.name AS uploaded_by_name FROM asset_versions v
     LEFT JOIN users u ON u.id = v.uploaded_by
     WHERE v.asset_id IN ($1) ORDER BY v.version_number DESC`,
    [ids]
  );
  const { rows: feedback } = await db.query(
    `SELECT f.*, u.name AS given_by_name FROM feedback f
     LEFT JOIN users u ON u.id = f.given_by
     WHERE f.asset_id IN ($1) ORDER BY f.created_at DESC`,
    [ids]
  );
  return assets.map((a) => ({
    ...a,
    // MySQL stores the flag as TINYINT(1); hand the browser a real boolean.
    tasks: tasks.filter((t) => t.asset_id === a.id).map((t) => ({ ...t, done: Boolean(t.done) })),
    notes: notes.filter((n) => n.asset_id === a.id),
    versions: versions.filter((v) => v.asset_id === a.id),
    feedback: feedback.filter((f) => f.asset_id === a.id),
  }));
}

const ASSET_SELECT = `SELECT a.*, u.name AS assignee_name FROM assets a LEFT JOIN users u ON u.id = a.assignee_id`;

// GET /api/assets/project/:projectId — role-scoped list for that project
router.get('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  let sql = `${ASSET_SELECT} WHERE a.project_id = $1`;
  const params = [projectId];

  const def = roleDef(req.user.role);
  if (def.assignable) {
    // A contributor only ever sees their own work.
    sql += ' AND a.assignee_id = $2';
    params.push(req.user.id);
  } else if (def.leadsTeam) {
    // A lead sees whatever their reports are carrying on this project.
    sql += ' AND a.assignee_id IN (SELECT id FROM users WHERE team_lead_id = $2)';
    params.push(req.user.id);
  }
  sql += ' ORDER BY a.created_at DESC';

  const { rows } = await db.query(sql, params);
  const withDetails = await attachTasksAndNotes(rows);
  res.json({ assets: withDetails });
});

// POST /api/assets/project/:projectId — create a new asset
router.post('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  const { name, type, priority = assetImport.defaultPriority(), assigneeId = null, due = null, description = '', manHours = null } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Asset name is required' });
  // Asset types are managed in Settings, so validate against the live list
  // rather than one fixed here.
  const assetType = referenceData.get('asset_types', type);
  if (!assetType || !assetType.isActive) {
    return res.status(400).json({
      error: 'Invalid asset type',
      allowed: referenceData.keys('asset_types'),
    });
  }

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS n FROM assets WHERE project_id = $1 AND `type` = $2',
    [projectId, type]
  );
  const code = `${assetType.codePrefix}-${String(Number(countRows[0].n) + 1).padStart(3, '0')}`;

  const id = uuid();
  await db.query(
    `INSERT INTO assets (id, \`code\`, \`name\`, \`type\`, \`status\`, priority, project_id, assignee_id, due_date, description, man_hours)
     VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10)`,
    [id, code, name.trim(), type, priority, projectId, assigneeId, due, description, manHours]
  );
  // Created Not Started, as the pipeline says. If it was created with somebody
  // already on it, the same rule that applies to assigning later applies here:
  // assignment is what starts the work.
  if (assigneeId) {
    const { rows: fresh } = await db.query('SELECT * FROM assets WHERE id = $1', [id]);
    const ctx = await contextFor(req, fresh[0]);
    const verdict = workflow.evaluate('assign', ctx);
    if (verdict.ok) await applyTransition(req, res, fresh[0], verdict, { note: verdict.describe });
  }

  const defaultTasks = ['Rough pass', 'Clean line', 'Color / shade'];
  for (let i = 0; i < defaultTasks.length; i++) {
    await db.query(
      'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ($1,$2,$3,0,$4)',
      [uuid(), id, defaultTasks[i], i]
    );
  }
  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
  const [withDetails] = await attachTasksAndNotes(rows);
  res.status(201).json({ asset: withDetails });
});

// PATCH /api/assets/:id — update status / priority / description / assignee
router.patch('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canEditAsset(req.user, asset))) {
    return res.status(403).json({ error: 'You cannot edit this asset' });
  }

  const fields = [];
  const values = [];
  let i = 1;
  const FREE_STATUSES = ['not_started', 'in_progress'];
  if (req.body.status !== undefined) {
    const freeMove = FREE_STATUSES.includes(req.body.status) && FREE_STATUSES.includes(asset.status);
    // Anything else is a move the pipeline would not make. Allowed only for
    // somebody holding the override permission, and recorded as an event so a
    // status that skipped the review flow is not a mystery later.
    if (!freeMove && !canOverrideStage(req.user)) {
      return res.status(409).json({ error: 'Status moves through review are handled by the submit/review/deliver actions, not a direct edit' });
    }
    if (!freeMove && !workflow.STATE_IDS.includes(req.body.status)) {
      return res.status(400).json({ error: `"${req.body.status}" is not a status.`, field: 'status' });
    }
    if (!freeMove) {
      await db.query(
        `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, routed_to_id)
         VALUES ($1,$2,'override',$3,$4,$5,$6,$7,$8)`,
        [uuid(), asset.id, asset.status, req.body.status, req.user.id, req.user.email,
         'Status forced outside the review flow', asset.routed_to_id]
      );
    }
  }

  // Reassignment is its own permission, separate from editing the asset.
  if (req.body.assigneeId !== undefined && req.body.assigneeId !== asset.assignee_id
      && !req.permissions.has('asset.assign')) {
    return res.status(403).json({ error: 'You do not have permission to assign this asset.', field: 'assigneeId' });
  }
  for (const key of ['status', 'priority', 'description', 'assignee_id', 'due_date', 'man_hours']) {
    const bodyKey = key === 'assignee_id' ? 'assigneeId' : key === 'due_date' ? 'due' : key === 'man_hours' ? 'manHours' : key;
    if (req.body[bodyKey] !== undefined) {
      fields.push(`\`${key}\` = $${i++}`);
      values.push(req.body[bodyKey]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);
  await db.query(`UPDATE assets SET ${fields.join(', ')} WHERE id = $${i}`, values);

  // Assigning the asset is what starts the work — there is no separate "start"
  // action for someone to forget. Only from Not Started: reassigning something
  // that is already in review must not drag it backwards.
  const assigneeChanged = req.body.assigneeId !== undefined && req.body.assigneeId !== asset.assignee_id;
  if (assigneeChanged && req.body.assigneeId && asset.status === 'not_started') {
    const { rows: fresh } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
    const ctx = await contextFor(req, fresh[0]);
    const verdict = workflow.evaluate('assign', ctx);
    if (verdict.ok) {
      await applyTransition(req, res, fresh[0], verdict, { note: verdict.describe });
    }
  } else if (assigneeChanged) {
    // Still note who it moved to, so the trail does not lose a reassignment
    // made mid-review.
    await db.query('UPDATE assets SET routed_to_id = $1 WHERE id = $2 AND routed_to_id IS NOT NULL',
      [req.body.assigneeId || null, req.params.id]);
  }

  const { rows: updated } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  res.json({ asset: withDetails });
});

// DELETE /api/assets/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canDeleteAsset(req.user, asset))) {
    return res.status(403).json({ error: 'You cannot delete this asset' });
  }
  await db.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// POST /api/assets/:id/tasks — add a checklist item
router.post('/:id/tasks', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canEditAsset(req.user, asset))) return res.status(403).json({ error: 'You cannot edit this asset' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Task name is required' });
  const { rows: posRows } = await db.query('SELECT COUNT(*) AS n FROM tasks WHERE asset_id = $1', [req.params.id]);
  const id = uuid();
  await db.query(
    'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ($1,$2,$3,0,$4)',
    [id, req.params.id, name.trim(), Number(posRows[0].n)]
  );
  res.status(201).json({ task: { id, asset_id: req.params.id, name: name.trim(), done: false } });
});

// PATCH /api/tasks/:id — toggle done
router.patch('/tasks/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.*, a.project_id, a.assignee_id AS asset_assignee_id, a.id AS parent_asset_id
     FROM tasks t JOIN assets a ON a.id = t.asset_id WHERE t.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Task not found' });
  const pseudoAsset = { id: row.parent_asset_id, project_id: row.project_id, assignee_id: row.asset_assignee_id };
  if (!(await canEditAsset(req.user, pseudoAsset))) return res.status(403).json({ error: 'You cannot edit this task' });
  const { done } = req.body || {};
  await db.query('UPDATE tasks SET done = $1 WHERE id = $2', [done ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

// POST /api/assets/:id/notes — leave a review note
router.post('/:id/notes', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text is required' });
  const id = uuid();
  await db.query(
    'INSERT INTO notes (id, asset_id, author_id, `text`) VALUES ($1,$2,$3,$4)',
    [id, req.params.id, req.user.id, text.trim()]
  );
  res.status(201).json({ note: { id, asset_id: req.params.id, author_id: req.user.id, author_name: req.user.name, text: text.trim() } });
});

// POST /api/assets/:id/submit — artist uploads a file for review.
// Where it routes depends on what stage the asset is coming from:
//  - fresh work or a team-lead rework request goes to the team lead
//  - a creative-director rework request goes straight back to the CD (already passed TL)
// Everything the state machine needs to judge a move. Gathered once so the
// permission questions are asked the same way for every action.
async function contextFor(req, asset) {
  return {
    user: req.user,
    asset,
    isTeamLead: await isTeamLeadOfAsset(req.user, asset),
    canOverride: canOverrideReview(req.user),
    canEdit: await canEditAsset(req.user, asset),
    canDeliver: await canMarkDelivered(req.user, asset),
  };
}

// Apply a transition the state machine has approved: move the asset, record the
// event, and hand back the asset as the API describes it everywhere else.
//
// The event row is the point. Status alone cannot answer "who sent this back
// and what did they say", and that is the question the asset detail view exists
// to answer.
async function applyTransition(req, res, asset, verdict, { note, versionId } = {}) {
  await db.query(
    'UPDATE assets SET `status` = $1, routed_to_id = $2 WHERE id = $3',
    [verdict.to, verdict.routedTo, asset.id]
  );
  await db.query(
    `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, version_id, routed_to_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [uuid(), asset.id, verdict.action, asset.status, verdict.to, req.user.id, req.user.email,
     String(note || '').trim() || null, versionId || null, verdict.routedTo]
  );
  const { rows: updated } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [asset.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  return withDetails;
}

// POST /api/assets/:id/submit — the assignee sends work for review.
// body: { link (required), description (optional) }; a file may still be
// attached alongside, for studios that were uploading them.
router.post('/:id/submit', upload.single('file'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('submit', ctx);
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

  const link = submissionLink.validate(req.body ? req.body.link : '');
  if (!link.ok) return res.status(400).json({ error: link.error, field: 'link' });
  const description = String((req.body && req.body.description) || '').trim() || null;

  // Which gate this submission is aimed at, so the reviewer sees the round that
  // was meant for them.
  const stage = verdict.to === 'pending_cd_review' ? 'cd' : 'tl';

  const { rows: vCount } = await db.query('SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = $1', [req.params.id]);
  const versionNumber = Number(vCount[0].n) + 1;
  const versionId = uuid();
  await db.query(
    `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description, file_name, file_path, file_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [versionId, req.params.id, versionNumber, stage, link.link, description,
     req.file ? req.file.originalname : null, req.file ? req.file.filename : null,
     req.file ? req.file.size : null, req.user.id]
  );

  // Every round is kept: the submission table is append-only, so a re-submission
  // after changes adds a version rather than replacing the one that was rejected.
  const withDetails = await applyTransition(req, res, asset, verdict, { note: description, versionId });
  res.status(201).json({ asset: withDetails });
});

// GET /api/assets/versions/:versionId/download — stream the uploaded file
router.get('/versions/:versionId/download', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM asset_versions WHERE id = $1', [req.params.versionId]);
  const version = rows[0];
  if (!version) return res.status(404).json({ error: 'File not found' });
  const { rows: assetRows } = await db.query('SELECT * FROM assets WHERE id = $1', [version.asset_id]);
  const asset = assetRows[0];
  if (!asset || !(await canViewAsset(req.user, asset))) {
    return res.status(403).json({ error: 'No access to this file' });
  }
  const filePath = path.join(__dirname, '..', '..', 'uploads', version.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });
  res.download(filePath, version.file_name);
});

// POST /api/assets/:id/review — a review decision at whichever gate the asset
// is sitting at. body: { decision: 'approved' | 'changes_requested', text }
//
// Which gate that is, and who may act on it, is the state machine's answer, not
// this handler's: it maps the decision onto a transition and applies whatever
// comes back.
router.post('/:id/review', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const { decision, text } = req.body || {};
  if (!['approved', 'changes_requested'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "changes_requested"' });
  }

  const stage = asset.status === 'pending_cd_review' ? 'cd' : 'tl';
  const action = `${stage}_${decision === 'approved' ? 'approve' : 'request_changes'}`;

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate(action, ctx, { note: text });
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });
  }

  const { rows: latestVersion } = await db.query(
    'SELECT id FROM asset_versions WHERE asset_id = $1 ORDER BY version_number DESC LIMIT 1',
    [req.params.id]
  );
  const versionId = latestVersion.length ? latestVersion[0].id : null;

  await db.query(
    'INSERT INTO feedback (id, asset_id, version_id, stage, decision, given_by, `text`) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuid(), req.params.id, versionId, stage, decision, req.user.id, String(text || '').trim() || null]
  );

  const withDetails = await applyTransition(req, res, asset, verdict, { note: text, versionId });
  res.json({ asset: withDetails });
});

// POST /api/assets/:id/relay — the team lead passes the Creative Director's
// notes to the assignee.
//
// A separate action because the status does not move: the asset stays in CD
// Changes and only changes desk. Without it the assignee could pick work up
// before the lead who relayed the request had said anything about it.
router.post('/:id/relay', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.assignee_id) {
    return res.status(409).json({ error: 'This asset has nobody assigned to pass it to.' });
  }

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('relay', ctx, { note: req.body && req.body.text });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });

  const withDetails = await applyTransition(req, res, asset, verdict, { note: req.body && req.body.text });
  res.json({ asset: withDetails });
});

// POST /api/assets/:id/deliver — mark a client-approved asset as delivered.
router.post('/:id/deliver', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('deliver', ctx, { note: req.body && req.body.text });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

  const withDetails = await applyTransition(req, res, asset, verdict, { note: req.body && req.body.text });
  res.json({ asset: withDetails });
});

// GET /api/assets/:id/history — the whole back-and-forth, in order.
//
// Submissions, review decisions and status changes are three tables; this
// stitches them into the one sequence a person actually wants to read.
router.get('/:id/history', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) {
    return res.status(403).json({ error: 'No access to this asset' });
  }

  const { rows: events } = await db.query(
    `SELECT e.*, u.\`name\` AS actor_name, v.version_number, v.link, v.description AS version_description
       FROM asset_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN asset_versions v ON v.id = e.version_id
      WHERE e.asset_id = $1
      ORDER BY e.seq`,
    [req.params.id]
  );

  res.json({
    assetId: asset.id,
    status: asset.status,
    statusLabel: workflow.label(asset.status),
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.from_status,
      fromLabel: e.from_status ? workflow.label(e.from_status) : null,
      toStatus: e.to_status,
      toLabel: workflow.label(e.to_status),
      actor: e.actor_name || e.actor_email || 'system',
      note: e.note,
      link: e.link,
      versionNumber: e.version_number,
      at: e.created_at,
    })),
  });
});

// GET /api/assets/import-template.csv — the sample file for the bulk import.
// Generated from the same column definitions the import validates against, so
// it cannot describe a format that would then be rejected.
router.get('/import-template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="zvky-asset-import-template.csv"');
  res.send(assetImport.buildTemplateCsv());
});

// GET /api/assets/import-format — what the importer expects, for the UI to show.
router.get('/import-format', (req, res) => res.json(assetImport.describeFormat()));

// Read the uploaded file into rows plus its header row. Throws a tagged error
// for anything that makes the file unreadable, so the caller answers 400
// rather than 500.
function readImportFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const fail = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    fail('The uploaded file could not be read.');
  }
  if (stats.size === 0) fail('That file is empty.');
  if (stats.size > assetImport.MAX_BYTES) {
    fail(`That file is ${(stats.size / 1048576).toFixed(1)}MB; the limit is ${(assetImport.MAX_BYTES / 1048576).toFixed(0)}MB.`);
  }

  let headers = [];
  let records = [];
  try {
    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      records = parse(content, {
        bom: true,                // Excel writes a byte-order mark; without this the first header reads as junk
        columns: (found) => { headers = found; return found; },
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // a ragged row becomes a row error, not a dead import
      });
    } else {
      const workbook = XLSX.readFile(filePath, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) fail('That workbook has no sheets.');
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
      if (!grid.length) fail('That sheet is empty.');
      headers = grid[0];
      records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }
  } catch (err) {
    if (err.status) throw err;
    // csv-parse and xlsx both throw on structurally broken files, and their
    // messages name the line, which is worth passing on.
    fail(`That file could not be read: ${err.message}`);
  }

  if (!headers.length) fail('That file has no header row. The first row must name the columns.');
  return { headers, records };
}

// Yield to the event loop. Between batches this keeps the server answering
// other requests during a long import instead of appearing hung.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// POST /api/assets/project/:projectId/bulk — CSV or Excel (.xls/.xlsx) import.
//
// Nothing here can take the server down: the file is checked before it is
// parsed, every row is validated before it reaches the database, inserts go in
// batches with a row-by-row fallback so one bad row cannot fail its batch, and
// the loop yields between batches. A row that fails is reported with its row
// number, the column at fault and why; the rest of the file still imports.
router.post('/project/:projectId/bulk', requirePermission('asset.bulk_upload'), uploadImport.single('file'), async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  if (!req.file) return res.status(400).json({ error: 'A CSV or Excel file is required' });

  let headers;
  let records;
  try {
    ({ headers, records } = readImportFile(req.file.path, req.file.originalname));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // staging file, not a review asset
  }

  // --- file-level checks, before any row is touched -------------------------
  const headerCheck = assetImport.validateHeaders(headers);
  if (!headerCheck.ok) {
    // A file whose headers are the user importer's template. Saying so by name
    // is more use than listing missing columns and leaving someone to work out
    // that they picked the wrong button.
    const userOnly = ['email', 'role', 'reports_to_email', 'password'];
    const wrongFile = userOnly.filter((c) => headerCheck.present.includes(c)).length >= 2;
    return res.status(400).json({
      error: wrongFile
        ? 'That looks like the user import file, not the asset one. Upload it under Bulk Upload Users, or download the asset sample format here.'
        : `That file is missing required column${headerCheck.missing.length > 1 ? 's' : ''}: ${headerCheck.missing.join(', ')}.`,
      wrongTemplate: wrongFile ? 'users' : undefined,
      missingColumns: headerCheck.missing,
      foundColumns: headerCheck.present,
      expectedColumns: assetImport.COLUMN_NAMES,
      hint: 'Download the sample file for the exact format.',
    });
  }
  if (!records.length) {
    return res.status(400).json({
      error: 'That file has a header row but no data rows.',
      expectedColumns: assetImport.COLUMN_NAMES,
    });
  }
  if (records.length > assetImport.MAX_ROWS) {
    return res.status(400).json({
      error: `That file has ${records.length} rows; the limit is ${assetImport.MAX_ROWS} per import. Split it and upload again.`,
      rowCount: records.length,
      maxRows: assetImport.MAX_ROWS,
    });
  }

  // --- validate every row up front -----------------------------------------
  // Nothing is written until the whole file has been checked, so an error on
  // the last row is reported the same way as one on the first.
  const errors = [];
  const valid = [];
  const seenInFile = new Map(); // name + type, within this file

  // Existing assets, so re-uploading a file does not silently duplicate them.
  const { rows: existingRows } = await db.query(
    'SELECT `name`, `type` FROM assets WHERE project_id = $1',
    [projectId]
  );
  const existing = new Set(existingRows.map((r) => `${String(r.name).toLowerCase()} ${r.type}`));

  for (let i = 0; i < records.length; i++) {
    const rowNumber = i + 2; // the header is row 1
    const result = assetImport.validateRow(records[i], rowNumber);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    const { values } = result;
    const identity = `${values.name.toLowerCase()} ${values.type}`;

    if (seenInFile.has(identity)) {
      errors.push({
        row: rowNumber, column: 'name', value: values.name,
        message: `duplicates row ${seenInFile.get(identity)} in this file (same name and type)`,
      });
      continue;
    }
    if (existing.has(identity)) {
      errors.push({
        row: rowNumber, column: 'name', value: values.name,
        message: 'an asset with this name and type already exists in this project',
      });
      continue;
    }
    seenInFile.set(identity, rowNumber);
    valid.push({ rowNumber, values });

    if (i % 500 === 499) await yieldToLoop(); // stay responsive on a big file
  }

  // Resolve assignee emails in one query rather than one per row.
  const emails = [...new Set(valid.map((v) => v.values.assignee_email).filter(Boolean))];
  const assigneeByEmail = new Map();
  if (emails.length) {
    const { rows } = await db.query(
      'SELECT id, email FROM users WHERE lower(email) IN ($1) AND role IN ($2)',
      [emails.map((e) => e.toLowerCase()), assignableRoles()]
    );
    rows.forEach((r) => assigneeByEmail.set(String(r.email).toLowerCase(), r.id));
  }

  const ready = [];
  for (const entry of valid) {
    const email = entry.values.assignee_email;
    if (email && !assigneeByEmail.has(email.toLowerCase())) {
      errors.push({
        row: entry.rowNumber, column: 'assignee_email', value: email,
        message: 'no assignable team member has this email address',
      });
      continue;
    }
    entry.assigneeId = email ? assigneeByEmail.get(email.toLowerCase()) : null;
    ready.push(entry);
  }

  // --- asset codes ---------------------------------------------------------
  const codeMap = Object.fromEntries(
    referenceData.list('asset_types', { includeInactive: true }).map((t) => [t.key, t.codePrefix])
  );
  const typeCounters = {};
  for (const t of assetImport.assetTypes()) {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM assets WHERE project_id = $1 AND `type` = $2',
      [projectId, t]
    );
    typeCounters[t] = Number(rows[0].n);
  }
  for (const entry of ready) {
    typeCounters[entry.values.type] += 1;
    entry.id = uuid();
    entry.code = `${codeMap[entry.values.type]}-${String(typeCounters[entry.values.type]).padStart(3, '0')}`;
  }

  // --- insert in batches ---------------------------------------------------
  const DEFAULT_TASKS = ['Rough pass', 'Clean line', 'Color / shade'];
  const ASSET_INSERT =
    'INSERT INTO assets (id, `code`, `name`, `type`, `status`, priority, project_id, assignee_id, due_date, description, man_hours) VALUES ?';
  const TASK_INSERT = 'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ?';
  const assetRow = (e) => [
    e.id, e.code, e.values.name, e.values.type, 'not_started', e.values.priority,
    projectId, e.assigneeId, e.values.deadline, e.values.description, e.values.man_hours,
  ];
  const taskRows = (e) => DEFAULT_TASKS.map((name, position) => [uuid(), e.id, name, 0, position]);

  const created = [];
  for (let i = 0; i < ready.length; i += assetImport.BATCH_SIZE) {
    const batch = ready.slice(i, i + assetImport.BATCH_SIZE);
    try {
      await db.query(ASSET_INSERT, [batch.map(assetRow)]);
      await db.query(TASK_INSERT, [batch.flatMap(taskRows)]);
      batch.forEach((e) => created.push({ id: e.id, code: e.code, name: e.values.name }));
    } catch (batchErr) {
      // The batch failed as a unit, so retry row by row to find which rows are
      // actually at fault and let the rest through.
      console.error(`Bulk import batch failed (${batchErr.code || batchErr.message}); retrying row by row.`);
      for (const entry of batch) {
        try {
          await db.query(ASSET_INSERT, [[assetRow(entry)]]);
          await db.query(TASK_INSERT, [taskRows(entry)]);
          created.push({ id: entry.id, code: entry.code, name: entry.values.name });
        } catch (rowErr) {
          errors.push({
            row: entry.rowNumber,
            column: null,
            value: entry.values.name,
            message: `could not be saved (${rowErr.code || 'database error'})`,
          });
        }
      }
    }
    await yieldToLoop();
  }

  errors.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  // 207 when some rows were skipped, 201 when the whole file went in.
  res.status(errors.length ? 207 : 201).json({
    created: created.length,
    skipped: errors.length,
    totalRows: records.length,
    createdAssets: created,
    errors,
  });
});

module.exports = router;
