const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const catalog = require('../permission-catalog');
const rolePermissions = require('../role-permissions');
const { activeRoles, roleDef, entries: roleEntries } = require('../roles');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Configuring what a role may do.
//
// Gated on settings.permissions, which the Super Admin role holds and cannot
// lose — see SUPER_ADMIN_LOCKED in src/role-permissions.js. Without that lock a
// Super Admin could switch off the screen that switches it back on.
router.use(authenticate);
router.use(requirePermission('settings.permissions'));

// GET /api/permissions/catalog — the master list, grouped for the screen.
router.get('/catalog', (req, res) => {
  res.json({ groups: catalog.describe() });
});

// GET /api/permissions/roles — every role, with how many permissions it holds.
router.get('/roles', async (req, res) => {
  const configured = await rolePermissions.all(db);
  const roles = roleEntries({ includeInactive: true });
  res.json({
    roles: roles.map((r) => ({
      key: r.key,
      label: r.label,
      group: r.group,
      tier: r.tier,
      tierLabel: r.tierLabel,
      isActive: r.isActive,
      isSystem: r.isSystem,
      enabledCount: (configured.get(r.key) || rolePermissions.defaultsFor(r.key)).size,
      total: catalog.KEYS.length,
    })),
  });
});

// One role's checklist, plus which of its permissions cannot be switched off.
async function describeRole(roleKey) {
  const def = roleDef(roleKey);
  const held = await rolePermissions.effectiveFor(db, roleKey);
  const defaults = rolePermissions.defaultsFor(roleKey);
  const locked = rolePermissions.lockedFor(roleKey);

  return {
    key: roleKey,
    label: def ? def.label : roleKey,
    tier: def ? def.tier : null,
    tierLabel: def ? def.tierLabel : null,
    // Said plainly, because it is the thing that surprises people: turning a
    // permission off here turns it off for everyone holding this role.
    isSuperAdmin: Boolean(def && def.tier === 'super_admin'),
    lockedKeys: locked,
    permissions: catalog.KEYS.map((key) => ({
      key,
      enabled: held.has(key),
      // What the role's tier would give it, so "changed from the default" is
      // visible without remembering what the default was.
      isDefault: defaults.has(key) === held.has(key),
      locked: locked.includes(key),
    })),
  };
}

// GET /api/permissions/roles/:key
router.get('/roles/:key', async (req, res) => {
  if (!roleDef(req.params.key)) return res.status(404).json({ error: 'That role does not exist.' });
  res.json({ role: await describeRole(req.params.key) });
});

// PUT /api/permissions/roles/:key — set exactly which permissions this role has.
//
// Applies to every user holding the role on their next request: the permission
// set is read per request in authenticate(), so nobody has to sign out and in
// again.
router.put('/roles/:key', async (req, res) => {
  const def = roleDef(req.params.key);
  if (!def) return res.status(404).json({ error: 'That role does not exist.' });

  const wanted = Array.isArray(req.body && req.body.permissions) ? req.body.permissions : null;
  if (!wanted) {
    return res.status(400).json({ error: 'Send the permissions this role should have.', field: 'permissions' });
  }
  const unknown = wanted.filter((k) => !catalog.isPermission(k));
  if (unknown.length) {
    return res.status(400).json({ error: `Not a permission: ${unknown.join(', ')}`, field: 'permissions' });
  }

  // Changing the Super Admin role takes an explicit confirmation. It is the
  // role that can put mistakes right, so a mistaken save here is the expensive
  // kind.
  const isSuperAdmin = def.tier === 'super_admin';
  if (isSuperAdmin && req.body.confirm !== true) {
    return res.status(409).json({
      error: `${def.label} is the role that can undo mistakes made on this screen. Confirm to change it.`,
      requiresConfirmation: true,
      lockedKeys: rolePermissions.lockedFor(req.params.key),
    });
  }

  const before = await rolePermissions.effectiveFor(db, req.params.key);
  const result = await rolePermissions.setForRole(db, req.params.key, wanted, req.user);

  // Names anything that was asked for and refused, rather than saving quietly
  // and letting the screen show something that did not happen.
  const refused = rolePermissions.lockedFor(req.params.key).filter((k) => !wanted.includes(k));

  res.json({
    ok: true,
    role: await describeRole(req.params.key),
    enabled: result.enabled,
    disabled: result.disabled,
    refused,
    summary: result.enabled.length || result.disabled.length
      ? `${result.enabled.length} enabled, ${result.disabled.length} disabled — in effect for everyone with this role on their next request.`
      : 'No changes.',
    ...(refused.length
      ? { warning: `${refused.join(', ')} cannot be switched off for ${def.label} — it is the only way back if this screen is misconfigured.` }
      : {}),
    ...(before.size && !result.permissions.length ? { warning: 'This role now has no permissions at all.' } : {}),
  });
});

// POST /api/permissions/roles/:key/reset — back to what the role's tier implies.
router.post('/roles/:key/reset', async (req, res) => {
  const def = roleDef(req.params.key);
  if (!def) return res.status(404).json({ error: 'That role does not exist.' });
  if (def.tier === 'super_admin' && req.body && req.body.confirm !== true) {
    return res.status(409).json({ error: `Confirm to reset ${def.label}.`, requiresConfirmation: true });
  }
  const defaults = rolePermissions.defaultsFor(req.params.key);
  await rolePermissions.setForRole(db, req.params.key, [...defaults], req.user);
  res.json({ ok: true, role: await describeRole(req.params.key), summary: 'Reset to this role\'s defaults.' });
});

// GET /api/permissions/audit — who changed which permission for which role.
router.get('/audit', async (req, res) => {
  res.json({ entries: await rolePermissions.audit(db, req.query.role || null, req.query.limit) });
});

module.exports = router;
