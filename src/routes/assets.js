const router = require('express').Router();
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
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
  canMarkDelivered,
} = require('../permissions');

router.use(authenticate);

async function attachTasksAndNotes(assets) {
  if (!assets.length) return assets;
  const ids = assets.map((a) => a.id);
  const { rows: tasks } = await pool.query(
    'SELECT * FROM tasks WHERE asset_id = ANY($1) ORDER BY position',
    [ids]
  );
  const { rows: notes } = await pool.query(
    `SELECT n.*, u.name AS author_name FROM notes n
     LEFT JOIN users u ON u.id = n.author_id
     WHERE n.asset_id = ANY($1) ORDER BY n.created_at DESC`,
    [ids]
  );
  const { rows: versions } = await pool.query(
    `SELECT v.*, u.name AS uploaded_by_name FROM asset_versions v
     LEFT JOIN users u ON u.id = v.uploaded_by
     WHERE v.asset_id = ANY($1) ORDER BY v.version_number DESC`,
    [ids]
  );
  const { rows: feedback } = await pool.query(
    `SELECT f.*, u.name AS given_by_name FROM feedback f
     LEFT JOIN users u ON u.id = f.given_by
     WHERE f.asset_id = ANY($1) ORDER BY f.created_at DESC`,
    [ids]
  );
  return assets.map((a) => ({
    ...a,
    tasks: tasks.filter((t) => t.asset_id === a.id),
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

  if (req.user.role === 'artist') {
    sql += ' AND a.assignee_id = $2';
    params.push(req.user.id);
  } else if (req.user.role === 'team_lead') {
    sql += ' AND a.assignee_id IN (SELECT id FROM users WHERE team_lead_id = $2)';
    params.push(req.user.id);
  }
  sql += ' ORDER BY a.created_at DESC';

  const { rows } = await pool.query(sql, params);
  const withDetails = await attachTasksAndNotes(rows);
  res.json({ assets: withDetails });
});

// POST /api/assets/project/:projectId — create a new asset
router.post('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  const { name, type, priority = 'med', assigneeId = null, due = null, description = '', manHours = null } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Asset name is required' });
  const validTypes = ['character', 'prop', 'environment', 'fx', 'animation', 'background'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid asset type' });

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM assets WHERE project_id = $1 AND type = $2',
    [projectId, type]
  );
  const codeMap = { character: 'CHR', prop: 'PRP', environment: 'ENV', fx: 'FX', animation: 'ANI', background: 'BG' };
  const code = `${codeMap[type]}-${String(countRows[0].n + 1).padStart(3, '0')}`;

  const id = uuid();
  await pool.query(
    `INSERT INTO assets (id, code, name, type, status, priority, project_id, assignee_id, due_date, description, man_hours)
     VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10)`,
    [id, code, name.trim(), type, priority, projectId, assigneeId, due, description, manHours]
  );
  const defaultTasks = ['Rough pass', 'Clean line', 'Color / shade'];
  for (let i = 0; i < defaultTasks.length; i++) {
    await pool.query(
      'INSERT INTO tasks (id, asset_id, name, done, position) VALUES ($1,$2,$3,false,$4)',
      [uuid(), id, defaultTasks[i], i]
    );
  }
  const { rows } = await pool.query(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
  const [withDetails] = await attachTasksAndNotes(rows);
  res.status(201).json({ asset: withDetails });
});

// PATCH /api/assets/:id — update status / priority / description / assignee
router.patch('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
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
    if (!FREE_STATUSES.includes(req.body.status) || !FREE_STATUSES.includes(asset.status)) {
      return res.status(409).json({ error: 'Status moves through review are handled by the submit/review/deliver actions, not a direct edit' });
    }
  }
  for (const key of ['status', 'priority', 'description', 'assignee_id', 'due_date', 'man_hours']) {
    const bodyKey = key === 'assignee_id' ? 'assigneeId' : key === 'due_date' ? 'due' : key === 'man_hours' ? 'manHours' : key;
    if (req.body[bodyKey] !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(req.body[bodyKey]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);
  await pool.query(`UPDATE assets SET ${fields.join(', ')} WHERE id = $${i}`, values);

  const { rows: updated } = await pool.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  res.json({ asset: withDetails });
});

// DELETE /api/assets/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canDeleteAsset(req.user, asset))) {
    return res.status(403).json({ error: 'You cannot delete this asset' });
  }
  await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// POST /api/assets/:id/tasks — add a checklist item
router.post('/:id/tasks', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canEditAsset(req.user, asset))) return res.status(403).json({ error: 'You cannot edit this asset' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Task name is required' });
  const { rows: posRows } = await pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE asset_id = $1', [req.params.id]);
  const id = uuid();
  await pool.query(
    'INSERT INTO tasks (id, asset_id, name, done, position) VALUES ($1,$2,$3,false,$4)',
    [id, req.params.id, name.trim(), posRows[0].n]
  );
  res.status(201).json({ task: { id, asset_id: req.params.id, name: name.trim(), done: false } });
});

// PATCH /api/tasks/:id — toggle done
router.patch('/tasks/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, a.project_id, a.assignee_id AS asset_assignee_id, a.id AS parent_asset_id
     FROM tasks t JOIN assets a ON a.id = t.asset_id WHERE t.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Task not found' });
  const pseudoAsset = { id: row.parent_asset_id, project_id: row.project_id, assignee_id: row.asset_assignee_id };
  if (!(await canEditAsset(req.user, pseudoAsset))) return res.status(403).json({ error: 'You cannot edit this task' });
  const { done } = req.body || {};
  await pool.query('UPDATE tasks SET done = $1 WHERE id = $2', [!!done, req.params.id]);
  res.json({ ok: true });
});

// POST /api/assets/:id/notes — leave a review note
router.post('/:id/notes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text is required' });
  const id = uuid();
  await pool.query(
    'INSERT INTO notes (id, asset_id, author_id, text) VALUES ($1,$2,$3,$4)',
    [id, req.params.id, req.user.id, text.trim()]
  );
  res.status(201).json({ note: { id, asset_id: req.params.id, author_id: req.user.id, author_name: req.user.name, text: text.trim() } });
});

// POST /api/assets/:id/submit — artist uploads a file for review.
// Where it routes depends on what stage the asset is coming from:
//  - fresh work or a team-lead rework request goes to the team lead
//  - a creative-director rework request goes straight back to the CD (already passed TL)
router.post('/:id/submit', upload.single('file'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!isAssignedArtist(req.user, asset)) {
    return res.status(403).json({ error: 'Only the assigned artist can submit this asset' });
  }
  const allowedFrom = ['not_started', 'in_progress', 'tl_changes_requested', 'cd_changes_requested'];
  if (!allowedFrom.includes(asset.status)) {
    return res.status(409).json({ error: `Can't submit from status "${asset.status}"` });
  }
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  const stage = asset.status === 'cd_changes_requested' ? 'cd' : 'tl';
  const nextStatus = stage === 'cd' ? 'pending_cd_review' : 'pending_tl_review';

  const { rows: vCount } = await pool.query('SELECT COUNT(*)::int AS n FROM asset_versions WHERE asset_id = $1', [req.params.id]);
  const versionNumber = vCount[0].n + 1;
  const versionId = uuid();
  await pool.query(
    `INSERT INTO asset_versions (id, asset_id, version_number, stage, file_name, file_path, file_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [versionId, req.params.id, versionNumber, stage, req.file.originalname, req.file.filename, req.file.size, req.user.id]
  );
  await pool.query('UPDATE assets SET status = $1 WHERE id = $2', [nextStatus, req.params.id]);

  const { rows: updated } = await pool.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  res.status(201).json({ asset: withDetails });
});

// GET /api/assets/versions/:versionId/download — stream the uploaded file
router.get('/versions/:versionId/download', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM asset_versions WHERE id = $1', [req.params.versionId]);
  const version = rows[0];
  if (!version) return res.status(404).json({ error: 'File not found' });
  const { rows: assetRows } = await pool.query('SELECT * FROM assets WHERE id = $1', [version.asset_id]);
  const asset = assetRows[0];
  if (!asset || !(await canViewAsset(req.user, asset))) {
    return res.status(403).json({ error: 'No access to this file' });
  }
  const filePath = path.join(__dirname, '..', '..', 'uploads', version.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });
  res.download(filePath, version.file_name);
});

// POST /api/assets/:id/review — a team lead or creative director records a decision
// on the pending submission. body: { decision: 'approved' | 'changes_requested', text }
router.post('/:id/review', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const { decision, text } = req.body || {};
  if (!['approved', 'changes_requested'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "changes_requested"' });
  }

  let stage, nextStatus;
  if (asset.status === 'pending_tl_review') {
    if (!(await isTeamLeadOfAsset(req.user, asset)) && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only this artist\'s team lead can review it right now' });
    }
    stage = 'tl';
    nextStatus = decision === 'approved' ? 'pending_cd_review' : 'tl_changes_requested';
  } else if (asset.status === 'pending_cd_review') {
    if (!canReviewAsCD(req.user)) {
      return res.status(403).json({ error: 'Only a creative director can review it right now' });
    }
    stage = 'cd';
    nextStatus = decision === 'approved' ? 'approved_for_client' : 'cd_changes_requested';
  } else {
    return res.status(409).json({ error: `Asset isn't awaiting review (status: ${asset.status})` });
  }

  const { rows: latestVersion } = await pool.query(
    'SELECT id FROM asset_versions WHERE asset_id = $1 AND stage = $2 ORDER BY version_number DESC LIMIT 1',
    [req.params.id, stage]
  );
  await pool.query(
    'INSERT INTO feedback (id, asset_id, version_id, stage, decision, given_by, text) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuid(), req.params.id, latestVersion[0]?.id || null, stage, decision, req.user.id, (text || '').trim() || null]
  );
  await pool.query('UPDATE assets SET status = $1 WHERE id = $2', [nextStatus, req.params.id]);

  const { rows: updated } = await pool.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  res.json({ asset: withDetails });
});

// POST /api/assets/:id/deliver — mark a client-approved asset as delivered
router.post('/:id/deliver', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.status !== 'approved_for_client') {
    return res.status(409).json({ error: 'Asset must be approved for client before it can be delivered' });
  }
  if (!(await canMarkDelivered(req.user, asset))) {
    return res.status(403).json({ error: 'You cannot deliver this asset' });
  }
  await pool.query('UPDATE assets SET status = $1 WHERE id = $2', ['delivered', req.params.id]);
  const { rows: updated } = await pool.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  res.json({ asset: withDetails });
});

// POST /api/assets/project/:projectId/bulk — CSV or Excel (.xls/.xlsx) import.
// Expected columns: name, type, priority, assignee_email, man_hours, deadline, description
// Only "name" and "type" are required; everything else is optional.
router.post('/project/:projectId/bulk', uploadImport.single('file'), async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  if (!req.file) return res.status(400).json({ error: 'A CSV or Excel file is required' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  let records;
  try {
    if (ext === '.csv') {
      const content = fs.readFileSync(req.file.path, 'utf8');
      records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    } else {
      // .xls / .xlsx
      const workbook = XLSX.readFile(req.file.path, { cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Could not read that file: ' + err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // it's just an import staging file, not a review asset — don't keep it
  }

  const validTypes = ['character', 'prop', 'environment', 'fx', 'animation', 'background'];
  const codeMap = { character: 'CHR', prop: 'PRP', environment: 'ENV', fx: 'FX', animation: 'ANI', background: 'BG' };
  const created = [];
  const errors = [];
  const typeCounters = {};
  for (const t of validTypes) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM assets WHERE project_id = $1 AND type = $2', [projectId, t]);
    typeCounters[t] = rows[0].n;
  }

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowNum = i + 2; // header is row 1
    const name = (row.name || '').trim();
    const type = (row.type || '').trim().toLowerCase();
    if (!name) { errors.push(`Row ${rowNum}: missing name`); continue; }
    if (!validTypes.includes(type)) { errors.push(`Row ${rowNum}: invalid type "${row.type}" (must be one of ${validTypes.join(', ')})`); continue; }

    let assigneeId = null;
    if (row.assignee_email) {
      const emailStr = String(row.assignee_email).trim();
      const { rows: u } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) AND role = $2', [emailStr, 'artist']);
      if (!u.length) { errors.push(`Row ${rowNum}: no artist found with email ${emailStr}`); }
      else assigneeId = u[0].id;
    }

    const priority = ['low', 'med', 'high'].includes(String(row.priority || '').toLowerCase()) ? String(row.priority).toLowerCase() : 'med';
    const manHours = row.man_hours ? Number(row.man_hours) : null;
    let deadline = null;
    if (row.deadline instanceof Date) {
      deadline = row.deadline.toISOString().slice(0, 10);
    } else if (row.deadline) {
      deadline = String(row.deadline).trim() || null;
    }

    typeCounters[type] += 1;
    const code = `${codeMap[type]}-${String(typeCounters[type]).padStart(3, '0')}`;
    const id = uuid();
    await pool.query(
      `INSERT INTO assets (id, code, name, type, status, priority, project_id, assignee_id, due_date, description, man_hours)
       VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10)`,
      [id, code, name, type, priority, projectId, assigneeId, deadline, (row.description || '').trim(), manHours]
    );
    const defaultTasks = ['Rough pass', 'Clean line', 'Color / shade'];
    for (let t = 0; t < defaultTasks.length; t++) {
      await pool.query('INSERT INTO tasks (id, asset_id, name, done, position) VALUES ($1,$2,$3,false,$4)', [uuid(), id, defaultTasks[t], t]);
    }
    created.push({ id, code, name });
  }

  res.status(207).json({ created: created.length, createdAssets: created, errors });
});

module.exports = router;
