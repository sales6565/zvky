/* Settings -> MIS Project Access. Who from the studio's staff side may see
 * which projects.
 *
 * SUPER ADMIN ONLY, ENFORCED HERE. requireSuperAdmin reads the designation the
 * server resolved for the session rather than anything the browser claimed. The
 * Settings page also hides the section, and that hiding is a courtesy to
 * everybody else's page: a person who knows the URL gets 403 from every handler
 * below with the page never consulted.
 *
 * TWO DOORS, ONE TABLE. The screen is person-first — pick somebody, tick the
 * projects — because that is how the studio described the job. The
 * project-first pair is here too, for attaching one person to one project from
 * somewhere else later. Both write the same rows; neither is a second source of
 * truth.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const oversight = require('../project-oversight');
const activity = require('../activity');

const PERMISSION = 'settings.mis_access';

router.use(authenticate);
router.use(requireSuperAdmin(PERMISSION));

async function payload() {
  const [roster, projects] = await Promise.all([
    oversight.roster(db),
    db.query(
      `SELECT p.id, p.\`name\`, p.\`code\`, c.\`name\` AS client_name
         FROM projects p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.is_active = 1
        ORDER BY c.\`name\`, p.\`name\``
    ).then((r) => r.rows),
  ]);
  return {
    people: roster,
    projects: projects.map((p) => ({ id: p.id, name: p.name, code: p.code, clientName: p.client_name || '' })),
    /* Said in the payload rather than only in the UI copy, so anything reading
       this API knows what the assignment does and does not hand over. */
    grants: 'view',
  };
}

const nameOf = async (userId) => {
  const { rows } = await db.query('SELECT `name` FROM users WHERE id = $1', [userId]);
  return rows.length ? rows[0].name : 'somebody';
};
const projectNames = async (ids) => {
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT `name` FROM projects WHERE id IN ($1)', [ids]);
  return rows.map((r) => r.name);
};

// GET /api/admin/mis-assignments
router.get('/', async (req, res) => {
  res.json(await payload());
});

/* PUT /api/admin/mis-assignments/:userId { projectIds: [] }
   The multi-select the screen offers: these projects and no others. */
router.put('/:userId', async (req, res) => {
  const { projectIds } = req.body || {};
  const result = await oversight.setProjects(db, req.params.userId,
    Array.isArray(projectIds) ? projectIds : [], req.user.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  if (result.added.length || result.removed.length) {
    const who = await nameOf(req.params.userId);
    const [addedNames, removedNames] = await Promise.all([
      projectNames(result.added), projectNames(result.removed),
    ]);
    const parts = [];
    if (addedNames.length) parts.push(`gave ${who} sight of ${addedNames.join(', ')}`);
    if (removedNames.length) parts.push(`took away ${who}’s sight of ${removedNames.join(', ')}`);
    req.activity({
      module: 'settings',
      action: 'settings.mis_access',
      entityType: 'user',
      entityId: req.params.userId,
      entityLabel: who,
      summary: parts.join('; '),
      changes: activity.diff(
        { projects: removedNames.join(', ') || null },
        { projects: addedNames.join(', ') || null }
      ),
    });
  }
  res.json(await payload());
});

/* The project-first pair, as one pairing at a time. Mounted separately (see the
   export below) so the path reads the way it names the thing:
   /api/admin/projects/:projectId/mis-assignments. */
const byProject = asyncRouter();
byProject.use(authenticate);
byProject.use(requireSuperAdmin(PERMISSION));

// POST /api/admin/projects/:projectId/mis-assignments { userId }
byProject.post('/:projectId/mis-assignments', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'Say who to attach.', field: 'userId' });
  const result = await oversight.attach(db, req.params.projectId, String(userId), req.user.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (result.changed) {
    const [who, [project]] = await Promise.all([nameOf(String(userId)), projectNames([req.params.projectId])]);
    req.activity({
      module: 'settings', action: 'settings.mis_access', entityType: 'user',
      entityId: String(userId), entityLabel: who,
      summary: `gave ${who} sight of ${project || 'a project'}`,
      changes: activity.diff({ projects: null }, { projects: project || req.params.projectId }),
    });
  }
  res.status(result.changed ? 201 : 200).json(await payload());
});

// DELETE /api/admin/projects/:projectId/mis-assignments/:userId
byProject.delete('/:projectId/mis-assignments/:userId', async (req, res) => {
  const result = await oversight.detach(db, req.params.projectId, req.params.userId);
  if (result.changed) {
    const [who, [project]] = await Promise.all([nameOf(req.params.userId), projectNames([req.params.projectId])]);
    req.activity({
      module: 'settings', action: 'settings.mis_access', entityType: 'user',
      entityId: req.params.userId, entityLabel: who,
      summary: `took away ${who}’s sight of ${project || 'a project'}`,
      changes: activity.diff({ projects: project || req.params.projectId }, { projects: null }),
    });
  }
  res.json(await payload());
});

module.exports = router;
module.exports.byProject = byProject;
