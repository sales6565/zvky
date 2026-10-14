const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const catalog = require('../permission-catalog');
const roleGroups = require('../role-groups');
const rolePermissions = require('../role-permissions');
const { entries: roleEntries, roleDef } = require('../roles');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

/* Role groups: the additive permission layer.
 *
 * GATED ON ITS OWN KEY, settings.role_groups, and gated with requirePermission
 * rather than on a tier. The tier is not the question — "has whoever runs this
 * studio given this person the group screen" is, and the answer comes from the
 * permission set the server resolved for this session. It defaults to the Super
 * Admin tier alone through the catalogue's implication, so the starting position
 * is the same as the role screen's without the gate being a tier check.
 *
 * Every write records who did it, in role_group_audit and in the Activity Log.
 */
router.use(authenticate);
router.use(requirePermission(roleGroups.MANAGE_KEY));

/* What the editor may hand out, as a Set — the escalation rule's input.
 *
 * req.permissions is what authenticate() resolved for this session, which since
 * role groups exist is the person's own role plus their groups. So somebody who
 * holds a permission BY INHERITANCE can grant it onward; they hold it, and the
 * rule is about not granting what you do not have rather than about where yours
 * came from. */
const editorHolds = (req) => req.permissions || new Set();

function groupPayload(group) {
  return {
    ...group,
    permissionLabels: group.permissions.map((k) => ({
      key: k, label: (catalog.BY_KEY.get(k) || {}).label || k,
    })),
  };
}

// GET /api/role-groups — every group, the kinds, and the roles that can join one.
router.get('/', async (req, res) => {
  const groups = await roleGroups.list(db);
  res.json({
    groups: groups.map(groupPayload),
    kinds: roleGroups.KINDS.map((k) => ({ key: k, label: roleGroups.KIND_LABELS[k] })),
    roles: roleEntries({ includeInactive: true }).map((r) => ({
      key: r.key, label: r.label, group: r.group, tier: r.tier, isActive: r.isActive,
    })),
    /* The keys this editor may grant: the catalogue, less the two no group may
       ever grant, less anything they do not hold themselves. Sent so the picker
       cannot offer a permission the write would refuse. */
    grantable: catalog.KEYS.filter((k) => roleGroups.grantable(k) && editorHolds(req).has(k)),
    neverGrantable: roleGroups.NEVER_GRANTABLE,
    limits: { nameMax: roleGroups.NAME_MAX, descriptionMax: roleGroups.DESCRIPTION_MAX },
  });
});

// GET /api/role-groups/audit — who changed which group, and when.
router.get('/audit', async (req, res) => {
  res.json({ entries: await roleGroups.audit(db, req.query.limit) });
});

/* GET /api/role-groups/:id/impact — what deleting this group would actually cost.
 *
 * Asked BEFORE the confirmation, and it answers per role rather than in
 * totals: a role that holds a permission in its own right loses nothing when
 * the group goes, and a warning that said otherwise would be noise. */
router.get('/:id/impact', async (req, res) => {
  const impact = await roleGroups.impactOfDeleting(db, req.params.id,
    (roleKey) => rolePermissions.ownFor(db, roleKey));
  if (!impact) return res.status(404).json({ error: 'That group does not exist.' });
  res.json({
    group: groupPayload(impact.group),
    losses: impact.losses.map((l) => ({
      ...l,
      lostLabels: l.lost.map((k) => (catalog.BY_KEY.get(k) || {}).label || k),
    })),
  });
});

router.post('/', async (req, res) => {
  const result = await roleGroups.create(db, req.body || {}, req.user);
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  req.activity({
    module: 'permissions',
    action: 'role_group.create',
    entityType: 'role_group',
    entityId: result.group.id,
    entityLabel: result.group.name,
    summary: `Created the ${result.group.kindLabel.toLowerCase()} group "${result.group.name}"`,
  });
  res.status(201).json({ ok: true, group: groupPayload(result.group) });
});

router.patch('/:id', async (req, res) => {
  const result = await roleGroups.rename(db, req.params.id, req.body || {}, req.user);
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  if (result.unchanged) { req.activitySkip(); } else {
    req.activity({
      module: 'permissions',
      action: 'role_group.update',
      entityType: 'role_group',
      entityId: result.group.id,
      entityLabel: result.group.name,
      summary: `Updated the group "${result.group.name}"`,
    });
  }
  res.json({ ok: true, group: groupPayload(result.group) });
});

/* DELETE /api/role-groups/:id — and everything it was granting goes with it.
 *
 * The members and the grants cascade by foreign key, so there is no orphan to
 * sweep up afterwards. Every member role loses the group's grants on its very
 * next request — nobody signs out. */
router.delete('/:id', async (req, res) => {
  const impact = await roleGroups.impactOfDeleting(db, req.params.id,
    (roleKey) => rolePermissions.ownFor(db, roleKey));
  if (!impact) return res.status(404).json({ error: 'That group does not exist.' });

  const result = await roleGroups.remove(db, req.params.id, req.user);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  req.activity({
    module: 'permissions',
    action: 'role_group.delete',
    entityType: 'role_group',
    entityId: null,
    entityLabel: result.deleted.name,
    summary: `Deleted the group "${result.deleted.name}" — `
      + `${result.deleted.roles.length} role(s) stop inheriting `
      + `${result.deleted.permissions.length} permission(s)`,
    changes: Object.fromEntries(impact.losses.map((l) => [l.role,
      { from: 'inherited', to: `lost ${l.lost.length}` }])),
  });
  res.json({
    ok: true,
    deleted: result.deleted.name,
    losses: impact.losses,
    summary: `"${result.deleted.name}" is gone. `
      + `${impact.losses.length} role(s) lost something, in effect on their next request.`,
  });
});

router.put('/:id/roles', async (req, res) => {
  const wanted = req.body && req.body.roles;
  const result = await roleGroups.setRoles(db, req.params.id, wanted, req.user);
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  if (result.added.length || result.removed.length) {
    req.activity({
      module: 'permissions',
      action: 'role_group.members',
      entityType: 'role_group',
      entityId: result.group.id,
      entityLabel: result.group.name,
      summary: `"${result.group.name}": ${result.added.length} role(s) added, `
        + `${result.removed.length} removed`,
      changes: {
        ...Object.fromEntries(result.added.map((k) => [k, { from: 'out', to: 'in' }])),
        ...Object.fromEntries(result.removed.map((k) => [k, { from: 'in', to: 'out' }])),
      },
    });
  } else { req.activitySkip(); }
  res.json({
    ok: true,
    group: groupPayload(result.group),
    added: result.added,
    removed: result.removed,
    summary: result.added.length || result.removed.length
      ? `${result.added.length} added, ${result.removed.length} removed — in effect for everyone `
        + 'holding those roles on their next request.'
      : 'No changes.',
  });
});

router.put('/:id/permissions', async (req, res) => {
  const wanted = req.body && req.body.permissions;
  const result = await roleGroups.setPermissions(db, req.params.id, wanted, req.user, editorHolds(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  if (result.added.length || result.removed.length) {
    req.activity({
      module: 'permissions',
      action: 'role_group.permissions',
      entityType: 'role_group',
      entityId: result.group.id,
      entityLabel: result.group.name,
      summary: `"${result.group.name}": ${result.added.length} permission(s) granted, `
        + `${result.removed.length} withdrawn`,
      changes: {
        ...Object.fromEntries(result.added.map((k) => [k, { from: 'off', to: 'granted' }])),
        ...Object.fromEntries(result.removed.map((k) => [k, { from: 'granted', to: 'off' }])),
      },
    });
  } else { req.activitySkip(); }
  res.json({
    ok: true,
    group: groupPayload(result.group),
    added: result.added,
    removed: result.removed,
    summary: result.added.length || result.removed.length
      ? `${result.added.length} granted, ${result.removed.length} withdrawn — in effect for every `
        + `role in "${result.group.name}" on their next request.`
      : 'No changes.',
  });
});

module.exports = router;
