const router = require('express').Router();
const bcrypt = require('bcrypt');
const { v4: uuid } = require('uuid');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

const ROLE_COLORS = ['super_admin', 'admin', 'team_lead', 'coordinator', 'artist', 'creative_director'];
const DEFAULT_PASSWORD = 'zvky2026'; // demo default; real deployments should force a reset on first login

// GET /api/users?search=&limit=&offset=&role=
// super_admin sees everyone; admin sees only users they personally added.
router.get('/', requireRole('super_admin', 'admin'), async (req, res) => {
  const { search = '', limit = 60, offset = 0, role } = req.query;
  const params = [];
  let sql = 'SELECT id, name, email, role, manager_id, team_lead_id, created_at FROM users WHERE 1=1';

  if (req.user.role === 'admin') {
    params.push(req.user.id);
    sql += ` AND manager_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    sql += ` AND (lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length})`;
  }
  if (role && ROLE_COLORS.includes(role)) {
    params.push(role);
    sql += ` AND role = $${params.length}`;
  }

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM (${sql}) x`, params);
  sql += ' ORDER BY name';
  params.push(Number(limit));
  sql += ` LIMIT $${params.length}`;
  params.push(Number(offset));
  sql += ` OFFSET $${params.length}`;

  const { rows } = await pool.query(sql, params);
  res.json({ users: rows, total: countRows[0].n });
});

// POST /api/users — super_admin can create any role; admin limited to
// team_lead / coordinator / artist, and becomes their manager.
router.post('/', requireRole('super_admin', 'admin'), async (req, res) => {
  const { name, email, role, teamLeadId, projectId, password } = req.body || {};
  if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
  if (!ROLE_COLORS.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (req.user.role === 'admin' && !['team_lead', 'coordinator', 'artist'].includes(role)) {
    return res.status(403).json({ error: 'Admins can only add team leads, coordinators, and artists' });
  }

  const { rows: existing } = await pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.length) return res.status(409).json({ error: 'That email is already in use' });

  const hash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  const id = uuid();
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role, manager_id, team_lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name.trim(), email.trim(), hash, role, req.user.id, role === 'artist' ? teamLeadId || null : null]
  );
  if (role === 'coordinator' && projectId) {
    await pool.query(
      'INSERT INTO project_coordinators (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [projectId, id]
    );
  }
  const { rows } = await pool.query('SELECT id, name, email, role, manager_id, team_lead_id FROM users WHERE id = $1', [id]);
  res.status(201).json({ user: rows[0], temporaryPassword: password ? undefined : DEFAULT_PASSWORD });
});

// DELETE /api/users/:id
router.delete('/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'Super admins cannot be removed here' });
  if (req.user.role === 'admin' && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only remove users you added' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
