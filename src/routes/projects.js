const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects, canAccessProject } = require('../permissions');
const { assignableRoles, roleDef } = require('../roles');

router.use(authenticate);

// GET /api/projects — only the projects this user is allowed to see
router.get('/', async (req, res) => {
  const projects = await visibleProjects(req.user);
  res.json({ projects });
});

// POST /api/projects — anyone whose role can create projects. The creator becomes the owner.
router.post('/', requirePermission('project.add'), async (req, res) => {
  const { name, teamLeadIds = [], coordinatorIds = [] } = req.body || {};
  const verdict = checkName(name);
  if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: verdict.field });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const id = uuid();
    await client.query(
      'INSERT INTO projects (id, name, code, owner_id) VALUES ($1,$2,$3,$4)',
      [id, verdict.value, codeFor(verdict.value), req.user.id]
    );
    for (const leadId of teamLeadIds) {
      await client.query(
        'INSERT IGNORE INTO project_team_leads (project_id, user_id) VALUES ($1,$2)',
        [id, leadId]
      );
    }
    for (const coordId of coordinatorIds) {
      await client.query(
        'INSERT IGNORE INTO project_coordinators (project_id, user_id) VALUES ($1,$2)',
        [id, coordId]
      );
    }
    await client.query('COMMIT');
    const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
    res.status(201).json({ project: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the project' });
  } finally {
    client.release();
  }
});

// The name rule, in one place, so creating and editing cannot disagree about
// what a valid project name is.
function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Project name is required', field: 'name' };
  }
  if (name.trim().length > 255) {
    return { ok: false, error: 'Project name is too long (255 characters at most)', field: 'name' };
  }
  return { ok: true, value: name.trim() };
}

// The code is derived from the name and referenced by nothing else — asset
// codes are built from the asset type's prefix, not from this. Rederiving it on
// rename keeps the column meaning one thing.
function codeFor(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
}

// Whether this caller may change this particular project. The same reach rule
// delete uses: a studio-wide role reaches every project, everyone else only the
// ones they created. The permission says whether they may edit at all; the
// role's scope says which ones — the two are different questions.
function mayChange(user, project) {
  return roleDef(user.role).projectScope === 'all' || project.owner_id === user.id;
}

// PATCH /api/projects/:id — rename a project and change who is attached to it.
//
// Deliberately narrow: it writes the projects row and the two membership
// tables, and nothing else. Assets keep their project_id, their assignees and
// their place in the pipeline; contributors in project_members are not touched,
// because taking a lead off a project is not a statement about the artists
// working on it.
router.patch('/:id', requirePermission('project.edit'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only edit projects you created' });
  }

  const { name, teamLeadIds, coordinatorIds } = req.body || {};

  // Every field is optional; only what was sent is written. Sending nothing is
  // not an error, it just changes nothing.
  let newName = null;
  if (name !== undefined) {
    const verdict = checkName(name);
    if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: verdict.field });
    newName = verdict.value;
  }
  for (const [value, label] of [[teamLeadIds, 'teamLeadIds'], [coordinatorIds, 'coordinatorIds']]) {
    if (value !== undefined && !Array.isArray(value)) {
      return res.status(400).json({ error: `${label} must be a list of user ids`, field: label });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (newName !== null) {
      await client.query('UPDATE projects SET `name` = $1, `code` = $2 WHERE id = $3',
        [newName, codeFor(newName), project.id]);
    }
    // Replaced wholesale rather than diffed: the form sends the complete list
    // it is showing, so anything missing from it was unticked.
    for (const [ids, table] of [[teamLeadIds, 'project_team_leads'], [coordinatorIds, 'project_coordinators']]) {
      if (ids === undefined) continue;
      await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [project.id]);
      for (const userId of ids) {
        await client.query(`INSERT IGNORE INTO ${table} (project_id, user_id) VALUES ($1,$2)`,
          [project.id, userId]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not save the project' });
  } finally {
    client.release();
  }

  const { rows: saved } = await db.query('SELECT * FROM projects WHERE id = $1', [project.id]);
  console.log(`${req.user.email} updated project "${saved[0].name}".`);
  return res.json({ project: await withMembers(saved[0]) });
});

// GET /api/projects/:id — one project with who is attached to it, for the edit
// form. Readable by anyone who can reach the project; editing is gated above.
router.get('/:id', async (req, res) => {
  const allowed = await canAccessProject(req.user, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: await withMembers(rows[0]) });
});

// A project plus the ids attached to it, which is what the edit form needs to
// tick the right boxes.
async function withMembers(project) {
  const [leads, coords] = await Promise.all([
    db.query('SELECT user_id FROM project_team_leads WHERE project_id = $1', [project.id]),
    db.query('SELECT user_id FROM project_coordinators WHERE project_id = $1', [project.id]),
  ]);
  return {
    ...project,
    teamLeadIds: leads.rows.map((r) => r.user_id),
    coordinatorIds: coords.rows.map((r) => r.user_id),
  };
}

// DELETE /api/projects/:id — a studio-wide role may delete any project,
// everyone else only the ones they own.
router.delete('/:id', requirePermission('project.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only delete projects you created' });
  }
  await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/projects/:id/artists — everyone eligible for assignment on this
// project: any contributor designation reporting to one of its leads. If the
// project has no leads attached yet, fall back to every contributor so the
// assignee picker is never empty.
router.get('/:id/artists', async (req, res) => {
  const allowed = await canAccessProject(req.user, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  const { rows: leads } = await db.query(
    'SELECT user_id FROM project_team_leads WHERE project_id = $1',
    [req.params.id]
  );

  const sql = leads.length
    ? `SELECT u.id, u.name, u.role FROM users u
       WHERE u.role IN ($1) AND u.team_lead_id IN ($2)
       ORDER BY u.name`
    : `SELECT u.id, u.name, u.role FROM users u
       WHERE u.role IN ($1) ORDER BY u.name`;
  const params = leads.length
    ? [assignableRoles(), leads.map((l) => l.user_id)]
    : [assignableRoles()];

  const { rows } = await db.query(sql, params);
  res.json({ artists: rows });
});

module.exports = router;
