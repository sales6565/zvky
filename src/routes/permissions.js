const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const catalog = require('../permission-catalog');
const userPermissions = require('../user-permissions');
const { capabilitiesFor, roleDef } = require('../roles');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Granting permissions to individuals.
//
// Gated on settings.permissions, which no tier below Super Admin holds and
// which cannot itself be granted — otherwise one grant would be enough to
// grant everything else.
router.use(authenticate);
router.use(requirePermission('settings.permissions'));

// What a person's permissions are, split into where each one comes from.
//
// The split is the point of the screen: a checkbox that is ticked because of
// somebody's job is a different thing from one ticked for them personally, and
// only the second can be unticked here.
async function describeUser(row) {
  const capabilities = capabilitiesFor(row.role);
  const granted = await userPermissions.grantedFor(db, row.id);
  const baseline = catalog.baselineFor(capabilities);
  const effective = catalog.effectiveFor(capabilities, granted);

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: (roleDef(row.role) || {}).label || row.role,
    permissions: catalog.KEYS.map((key) => ({
      key,
      fromRole: baseline.has(key),
      granted: granted.includes(key),
      effective: effective.has(key),
    })),
  };
}

// GET /api/permissions/catalog — the master list, grouped for the screen.
router.get('/catalog', (req, res) => {
  res.json({ groups: catalog.describe() });
});

// GET /api/permissions/users — everyone, for the picker.
router.get('/users', async (req, res) => {
  const search = String(req.query.search || '').toLowerCase();
  const params = [];
  let sql = 'SELECT id, `name`, email, `role` FROM users WHERE 1=1';
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (lower(\`name\`) LIKE $${params.length} OR lower(email) LIKE $${params.length})`;
  }
  sql += ' ORDER BY `name` LIMIT 200';
  const { rows } = await db.query(sql, params);

  const grants = await userPermissions.grantedForMany(db, rows.map((r) => r.id));
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleLabel: (roleDef(r.role) || {}).label || r.role,
      grantCount: (grants.get(r.id) || []).length,
    })),
  });
});

// GET /api/permissions/users/:id — one person's checklist.
router.get('/users/:id', async (req, res) => {
  const { rows } = await db.query('SELECT id, `name`, email, `role` FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: await describeUser(rows[0]), isYou: rows[0].id === req.user.id });
});

// PUT /api/permissions/users/:id — replace this person's individual grants.
//
// The body is the set of grants wanted, not a diff: the screen sends what the
// checkboxes say, and the store works out what changed so the audit trail
// records the change rather than the state.
router.put('/users/:id', async (req, res) => {
  const { rows } = await db.query('SELECT id, `name`, email, `role` FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const subject = rows[0];

  // Nobody edits their own permissions here.
  //
  // Not a confirmation step: the mistake this prevents — an administrator
  // removing their own access to the screen that would put it back — is one
  // that cannot be undone from inside the app, and a dialog is a poor guard
  // against a thing that has no remedy.
  if (subject.id === req.user.id) {
    return res.status(403).json({
      error: 'You cannot change your own permissions. Ask another Super Admin to make the change.',
    });
  }

  const wanted = Array.isArray(req.body && req.body.permissions) ? req.body.permissions : null;
  if (!wanted) return res.status(400).json({ error: 'Send the permissions you want this person to have.', field: 'permissions' });

  const unknown = wanted.filter((k) => !catalog.isPermission(k));
  if (unknown.length) {
    return res.status(400).json({ error: `Not a permission: ${unknown.join(', ')}`, field: 'permissions' });
  }
  const withheld = wanted.filter((k) => !catalog.grantableKeys().includes(k));
  if (withheld.length) {
    return res.status(400).json({
      error: `${withheld.join(', ')} cannot be granted individually — it belongs to the Super Admin role.`,
      field: 'permissions',
    });
  }

  const result = await userPermissions.setGrants(db, subject, wanted, req.user);
  res.json({
    ok: true,
    user: await describeUser(subject),
    added: result.added,
    removed: result.removed,
    // So the screen can say what happened rather than "saved".
    summary: result.added.length || result.removed.length
      ? `${result.added.length} granted, ${result.removed.length} revoked.`
      : 'No changes.',
  });
});

// GET /api/permissions/audit — who changed what, for whom, when.
router.get('/audit', async (req, res) => {
  res.json({ entries: await userPermissions.auditFor(db, req.query.userId || null, req.query.limit) });
});

module.exports = router;
