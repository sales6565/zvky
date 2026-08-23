const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requireCapability } = require('../middleware/auth');
const { ROLES, isRole, roleDef, capabilitiesFor } = require('../roles');
const passwordPolicy = require('../password-policy');

router.use(authenticate);

const DEFAULT_PASSWORD = 'zvky2026'; // demo default; real deployments should force a reset on first login

// Which designations a given manager is allowed to hand out. Super admins can
// assign anything; an admin can staff up their own projects but cannot mint
// another account that manages users or sees the whole studio.
function assignableRolesFor(user) {
  const def = roleDef(user.role);
  if (!def || !def.manageUsers) return [];
  if (def.projectScope === 'all') return Object.keys(ROLES);
  return Object.keys(ROLES).filter((key) => {
    const r = roleDef(key);
    return !r.manageUsers && r.projectScope !== 'all';
  });
}

// GET /api/users?search=&limit=&offset=&role=
// A studio-wide manager sees everyone; an admin sees only users they added.
router.get('/', requireCapability('manageUsers'), async (req, res) => {
  const { search = '', limit = 60, offset = 0, role } = req.query;
  const params = [];
  let sql = 'SELECT id, name, email, role, manager_id, team_lead_id, created_at FROM users WHERE 1=1';

  if (roleDef(req.user.role).projectScope !== 'all') {
    params.push(req.user.id);
    sql += ` AND manager_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    sql += ` AND (lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length})`;
  }
  // `role` may be a single key or a comma-separated list, so the frontend can
  // ask for "anyone who can be assigned work" in one call.
  if (role) {
    const wanted = String(role).split(',').map((r) => r.trim()).filter(isRole);
    if (!wanted.length) return res.json({ users: [], total: 0 });
    params.push(wanted);
    sql += ` AND role IN ($${params.length})`;
  }

  const { rows: countRows } = await db.query(`SELECT COUNT(*) AS n FROM (${sql}) x`, params);
  sql += ' ORDER BY name';
  params.push(Number(limit));
  sql += ` LIMIT $${params.length}`;
  params.push(Number(offset));
  sql += ` OFFSET $${params.length}`;

  const { rows } = await db.query(sql, params);
  res.json({ users: rows, total: Number(countRows[0].n) });
});

// POST /api/users — create an account with one of the studio's designations.
router.post('/', requireCapability('manageUsers'), async (req, res) => {
  const { name, email, role, teamLeadId, projectId, password } = req.body || {};
  if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
  if (!isRole(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!assignableRolesFor(req.user).includes(role)) {
    return res.status(403).json({ error: `You cannot create accounts with the ${roleDef(role).label} role` });
  }

  // Only when an administrator types one. The generated default below is a
  // temporary credential the new user is expected to replace on first sign-in.
  if (password !== undefined && password !== '') {
    const verdict = passwordPolicy.check(password);
    if (!verdict.valid) return res.status(400).json({ error: verdict.message, failed: verdict.failed });
  }

  const { rows: existing } = await db.query('SELECT 1 AS ok FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.length) return res.status(409).json({ error: 'That email is already in use' });

  const def = roleDef(role);
  const hash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  const id = uuid();

  // Only contributors report to a lead; a lead or coordinator does not.
  const leadId = def.assignable ? teamLeadId || null : null;

  await db.query(
    `INSERT INTO users (id, name, email, password_hash, role, manager_id, team_lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name.trim(), email.trim(), hash, role, req.user.id, leadId]
  );

  // Attach them to the project they were created for, on whichever side of the
  // project their role sits.
  if (projectId) {
    if (def.projectScope === 'assigned') {
      await db.query(
        'INSERT IGNORE INTO project_coordinators (project_id, user_id) VALUES ($1,$2)',
        [projectId, id]
      );
    } else if (def.leadsTeam) {
      await db.query(
        'INSERT IGNORE INTO project_team_leads (project_id, user_id) VALUES ($1,$2)',
        [projectId, id]
      );
    }
  }

  const { rows } = await db.query(
    'SELECT id, name, email, role, manager_id, team_lead_id FROM users WHERE id = $1',
    [id]
  );
  res.status(201).json({
    user: { ...rows[0], capabilities: capabilitiesFor(role) },
    temporaryPassword: password ? undefined : DEFAULT_PASSWORD,
  });
});

// PATCH /api/users/:id — change someone's designation (or their reporting line).
router.patch('/:id', requireCapability('manageUsers'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (roleDef(req.user.role).projectScope !== 'all' && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only change users you added' });
  }

  const { role, teamLeadId } = req.body || {};
  const fields = [];
  const values = [];

  if (role !== undefined) {
    if (!isRole(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!assignableRolesFor(req.user).includes(role)) {
      return res.status(403).json({ error: `You cannot assign the ${roleDef(role).label} role` });
    }
    fields.push(`role = $${fields.length + 1}`);
    values.push(role);
    // A designation that isn't assigned work has no reporting lead.
    if (!roleDef(role).assignable) {
      fields.push('team_lead_id = NULL');
    }
  }
  if (teamLeadId !== undefined && (role === undefined || roleDef(role).assignable)) {
    fields.push(`team_lead_id = $${fields.length + 1}`);
    values.push(teamLeadId || null);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.params.id);
  await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);

  const { rows: updated } = await db.query(
    'SELECT id, name, email, role, manager_id, team_lead_id FROM users WHERE id = $1',
    [req.params.id]
  );
  res.json({ user: { ...updated[0], capabilities: capabilitiesFor(updated[0].role) } });
});

// DELETE /api/users/:id
router.delete('/:id', requireCapability('manageUsers'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(403).json({ error: 'You cannot remove your own account' });
  if (roleDef(target.role) && roleDef(target.role).projectScope === 'all' && roleDef(target.role).manageUsers) {
    return res.status(403).json({ error: 'Super admins cannot be removed here' });
  }
  if (roleDef(req.user.role).projectScope !== 'all' && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only remove users you added' });
  }
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
