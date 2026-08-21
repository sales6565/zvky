const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requireCapability } = require('../middleware/auth');
const { visibleProjects, canAccessProject } = require('../permissions');
const { ASSIGNABLE_ROLES, roleDef } = require('../roles');

router.use(authenticate);

// GET /api/projects — only the projects this user is allowed to see
router.get('/', async (req, res) => {
  const projects = await visibleProjects(req.user);
  res.json({ projects });
});

// POST /api/projects — anyone whose role can create projects. The creator becomes the owner.
router.post('/', requireCapability('createProject'), async (req, res) => {
  const { name, teamLeadIds = [], coordinatorIds = [] } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const id = uuid();
    const code = name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase();
    await client.query(
      'INSERT INTO projects (id, name, code, owner_id) VALUES ($1,$2,$3,$4)',
      [id, name.trim(), code, req.user.id]
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

// DELETE /api/projects/:id — a studio-wide role may delete any project,
// everyone else only the ones they own.
router.delete('/:id', requireCapability('createProject'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (roleDef(req.user.role).projectScope !== 'all' && project.owner_id !== req.user.id) {
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
    ? [ASSIGNABLE_ROLES, leads.map((l) => l.user_id)]
    : [ASSIGNABLE_ROLES];

  const { rows } = await db.query(sql, params);
  res.json({ artists: rows });
});

module.exports = router;
