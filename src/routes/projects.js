const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { visibleProjects, canAccessProject, canCreateProject } = require('../permissions');

router.use(authenticate);

// GET /api/projects — only the projects this user is allowed to see
router.get('/', async (req, res) => {
  const projects = await visibleProjects(req.user);
  res.json({ projects });
});

// POST /api/projects — super_admin or admin only. The creator becomes the owner.
router.post('/', requireRole('super_admin', 'admin'), async (req, res) => {
  const { name, teamLeadIds = [], coordinatorIds = [] } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });

  const client = await pool.connect();
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
        'INSERT INTO project_team_leads (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, leadId]
      );
    }
    for (const coordId of coordinatorIds) {
      await client.query(
        'INSERT INTO project_coordinators (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, coordId]
      );
    }
    await client.query('COMMIT');
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    res.status(201).json({ project: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the project' });
  } finally {
    client.release();
  }
});

// DELETE /api/projects/:id — super_admin any project, admin only their own
router.delete('/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role === 'admin' && project.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete projects you created' });
  }
  await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/projects/:id/artists — artists eligible for assignment on this project
// (i.e. artists reporting to one of this project's team leads)
router.get('/:id/artists', async (req, res) => {
  const allowed = await canAccessProject(req.user, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  const { rows } = await pool.query(
    `SELECT u.id, u.name FROM users u
     WHERE u.role = 'artist' AND u.team_lead_id IN (
       SELECT user_id FROM project_team_leads WHERE project_id = $1
     ) ORDER BY u.name`,
    [req.params.id]
  );
  res.json({ artists: rows });
});

module.exports = router;
