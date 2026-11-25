const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const catalog = require('../permission-catalog');
const roleGroups = require('../role-groups');
const rolePermissions = require('../role-permissions');
const notifications = require('../notifications');
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
  /* THE EDITOR'S OWN SET, passed for the escalation guard — handing a group to
     a designation hands out its keys. See mayHandOut() in src/role-groups.js
     for why attaching a role is now checked the way attaching a user is. */
  const result = await roleGroups.setRoles(db, req.params.id, wanted, req.user, editorHolds(req));
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

/* PUT /api/role-groups/:id/users — who is in this group as an individual.
 *
 * ===========================================================================
 * THE WHOLE LIST, NOT A DIFF, which is the same shape as /roles above it and is
 * worth stating because an add/remove pair of endpoints was the obvious
 * alternative. The editor on the screen holds a set of chips; what it knows is
 * the set it wants, and sending that lets the server work out the difference
 * and audit exactly what moved. Two endpoints would have made the page compute
 * the difference, which is the page deciding something.
 *
 * IDEMPOTENT by construction: a list identical to what is stored writes
 * nothing, audits nothing and notifies nobody. Sending somebody who is already
 * in the group leaves their row and their added_at as they were.
 *
 * THE SAME GUARDS AS EVERY OTHER WRITE HERE: requirePermission on the router
 * for the management key, and mayHandOut() inside setUsers() for the escalation
 * rule. Neither is this handler's own.
 */
/* GET /api/role-groups/users?search= — who can be added, as the picker needs them.
 *
 * ===========================================================================
 * WHY THIS IS NOT GET /api/users, which already searches the roster.
 *
 * That route is behind user.view, and this screen is behind settings.role_groups.
 * They are different permissions on purpose: whoever runs the studio's groups is
 * not thereby trusted with the staff directory, and somebody holding the group
 * screen alone would have had a picker that answered 403. Borrowing the other
 * route's key here would have widened it for everybody who holds this one.
 *
 * So it is its own endpoint under this router's own guard, and it returns the
 * four fields the picker draws and nothing else — no email history, no
 * reporting line, no deactivation detail, no photo. A directory is not what
 * this is.
 *
 * ACTIVE ACCOUNTS ONLY, because they are the only ones that may be added:
 * validateUsers() refuses a deactivated account, so offering one would be
 * offering a refusal.
 *
 * CAPPED AND TOLD. Twenty-five rows with the true total beside them, so the
 * picker can say "25 of 140 — keep typing" rather than silently showing a
 * slice. A studio with two hundred people typing two letters should not get
 * two hundred rows in a dropdown.
 */
router.get('/users', async (req, res) => {
  const search = String((req.query && req.query.search) || '').trim();
  const LIMIT = 25;
  const where = ['is_active = 1'];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push('(`name` LIKE $1 OR email LIKE $1)');
  }
  const sql = `FROM users WHERE ${where.join(' AND ')}`;
  const { rows: total } = await db.query(`SELECT COUNT(*) AS n ${sql}`, params);
  const { rows } = await db.query(
    `SELECT id, \`name\`, email, \`role\` ${sql} ORDER BY \`name\` LIMIT ${LIMIT}`, params);

  res.json({
    users: rows.map((u) => {
      const def = roleDef(u.role);
      return {
        id: u.id, name: u.name, email: u.email, role: u.role,
        roleLabel: def ? def.label : u.role,
      };
    }),
    total: Number(total[0].n) || 0,
    limit: LIMIT,
  });
});

router.put('/:id/users', async (req, res) => {
  const wanted = req.body && req.body.users;
  const result = await roleGroups.setUsers(db, req.params.id, wanted, req.user, editorHolds(req));
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });

  const nameOf = (id) => {
    const found = (result.group.users || []).find((u) => u.id === id);
    return found ? found.name : id;
  };

  if (result.added.length || result.removed.length) {
    req.activity({
      module: 'permissions',
      action: 'role_group.users',
      entityType: 'role_group',
      entityId: result.group.id,
      entityLabel: result.group.name,
      summary: `"${result.group.name}": ${result.added.length} user(s) added, `
        + `${result.removed.length} removed`,
      /* NAMED, not id'd: the Activity Log is read by people. */
      changes: {
        ...Object.fromEntries(result.added.map((id) => [nameOf(id), { from: 'out', to: 'in' }])),
        ...Object.fromEntries(result.removed.map((id) => [id, { from: 'in', to: 'out' }])),
      },
    });
  } else { req.activitySkip(); }

  /* TOLD, ONE BY ONE, AND ONLY THE PEOPLE ADDED. The notice names the group and
     never its keys — see KINDS.role_group. Failing to notify must not fail the
     membership: the permission is already granted at this point, and an
     undelivered notice is worth less than a refused save that leaves the owner
     wondering what happened. */
  for (const id of result.added) {
    await notifications.addedToRoleGroup(db, {
      userId: id, byId: req.user.id, groupName: result.group.name,
    }).catch((err) => console.warn(`[role-groups] could not notify ${id}: ${err.message}`));
  }

  res.json({
    ok: true,
    group: groupPayload(result.group),
    added: result.added,
    removed: result.removed,
    summary: result.added.length || result.removed.length
      ? `${result.added.length} added, ${result.removed.length} removed — in effect on their `
        + 'next request.'
      : 'No changes.',
  });
});

/* GET /api/role-groups/:id/members — the roles and the users in one group.
 *
 * The screen does not need this: GET / already carries every group with both
 * lists on it, in three queries for the whole page. This exists for the people
 * and tools that ask about ONE group — a support question, a script, a check
 * after a save — and it answers from the same list() call, so it cannot
 * disagree with the screen.
 */
router.get('/:id/members', async (req, res) => {
  const group = await roleGroups.get(db, req.params.id);
  if (!group) return res.status(404).json({ error: 'That group does not exist.' });
  res.json({
    group: { id: group.id, name: group.name, kind: group.kind, kindLabel: group.kindLabel },
    roles: group.roles,
    users: group.users,
    counts: { roles: group.roles.length, users: group.users.length,
      /* How many of the direct members gain nothing from being one, because
         their designation is in the group as well. The screen marks these; a
         caller asking this endpoint gets the number without counting. */
      usersAlreadyViaRole: group.users.filter((u) => u.viaRole).length },
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
