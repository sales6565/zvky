const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects } = require('../permissions');
const referenceData = require('../reference-data');
const reports = require('../reports');

router.use(authenticate);

/* GET /api/reports/efficiency
 *
 * Estimated Man Hours against tracked Time Spent, per asset, rolled up every
 * way the Reports tab offers. The maths is in src/reports.js; this is the query
 * that feeds it and the filters that narrow it.
 *
 * Scoped, like everything else: a report never reaches a project the reader
 * cannot already open. Holding "View Reports" says what you may look at, never
 * how much of the studio you may look at — same rule the rest of the
 * permissions follow.
 */
router.get('/efficiency', requirePermission('report.view'), async (req, res) => {
  const projects = await visibleProjects(req.user);
  if (!projects.length) {
    return res.json({
      ...reports.build([]),
      filters: { projects: [], clients: [], users: [], categories: [], scopes: [] },
      scope: { projects: 0 },
    });
  }
  const projectIds = projects.map((p) => p.id);

  const where = ['a.project_id IN ($1)'];
  const params = [projectIds];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (req.query.projectId) add('a.project_id = ?', req.query.projectId);
  if (req.query.clientId) add('p.client_id = ?', req.query.clientId);
  if (req.query.assigneeId) add('a.assignee_id = ?', req.query.assigneeId);
  if (req.query.category) add('a.category = ?', req.query.category);
  if (req.query.scope) add('a.`type` = ?', req.query.scope);

  /* The date range applies to when the work FINISHED, not when the asset was
     created — "how did we do in October" is a question about work that landed
     in October. An asset created in September and delivered in October belongs
     to October. */
  /* When the work landed. Delivery if it got there — assets carry no
     delivered_at column, so that date comes from the deliver event — otherwise
     the last submission, which is the bar for being in this report at all. */
  const finishedAt = `COALESCE(
      (SELECT MAX(e.created_at) FROM asset_events e WHERE e.asset_id = a.id AND e.action = 'deliver'),
      (SELECT MAX(v.created_at) FROM asset_versions v WHERE v.asset_id = a.id))`;
  if (req.query.from) add(`${finishedAt} >= ?`, `${req.query.from} 00:00:00`);
  if (req.query.to) add(`${finishedAt} <= ?`, `${req.query.to} 23:59:59`);

  /* One row per asset.
   *
   * The two time numbers come from work_sessions, which records one row per
   * stretch of work with the round it belonged to. `round` is set at start to
   * (submissions so far + 1), so round 1 is everything done before the first
   * submission — the first pass, without having to guess from timestamps.
   *
   * `contributors` counts the people who have held the asset, so a By User row
   * can say how much of its work was somebody else's. */
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.\`name\`, a.\`type\`, a.category, a.man_hours AS manHours,
            a.status, a.assignee_id AS assigneeId, u.\`name\` AS assigneeName,
            a.project_id AS projectId, p.\`name\` AS projectName,
            p.client_id AS clientId, c.\`name\` AS clientName,
            ${finishedAt} AS finishedAt,
            (a.status = 'delivered') AS delivered,
            (SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id) AS rounds,
            (SELECT COUNT(DISTINCT x.user_id) FROM asset_assignments x WHERE x.asset_id = a.id) AS contributors,
            COALESCE((SELECT SUM(COALESCE(w.seconds, 0)) FROM work_sessions w
                       WHERE w.asset_id = a.id), 0) AS totalSeconds,
            COALESCE((SELECT SUM(COALESCE(w.seconds, 0)) FROM work_sessions w
                       WHERE w.asset_id = a.id AND w.round = 1), 0) AS firstPassSeconds
       FROM assets a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = a.assignee_id
      WHERE ${where.join(' AND ')}`,
    params
  ).catch((err) => {
    /* work_sessions or asset_assignments missing means a deployment that has
       not run the timer migration yet. A report with no time data is empty, not
       a 500. */
    if (/ER_NO_SUCH_TABLE|doesn't exist/i.test(err.message || '')) return { rows: [] };
    throw err;
  });

  // Labels, so the report reads in the studio's own words rather than in keys.
  const labelFrom = (collection) => {
    const list = referenceData.list(collection, { includeInactive: true });
    return new Map(list.map((e) => [e.key, e.label]));
  };
  const categories = labelFrom('categories');
  const scopes = labelFrom('asset_types');

  const prepared = rows.map((r) => ({
    ...r,
    // An asset is in the report once it has been submitted at least once —
    // before that there is nothing to have been efficient about.
    submitted: Number(r.rounds) > 0,
    categoryLabel: categories.get(r.category) || r.category,
    typeLabel: scopes.get(r.type) || r.type,
  }));

  const grain = req.query.grain === 'month' ? 'month' : 'week';
  const report = reports.build(prepared, { grain });

  /* What the filter dropdowns offer: drawn from the reader's own scope, so
     they cannot pick a project the report would then refuse to show. */
  const { rows: people } = await db.query(
    `SELECT DISTINCT u.id, u.\`name\` FROM users u
       JOIN assets a ON a.assignee_id = u.id
      WHERE a.project_id IN ($1) ORDER BY u.\`name\``,
    [projectIds]
  );
  const clients = [];
  const seenClient = new Set();
  for (const p of projects) {
    if (p.client_id && !seenClient.has(p.client_id)) seenClient.add(p.client_id);
  }
  if (seenClient.size) {
    const { rows: clientRows } = await db.query(
      'SELECT id, `name` FROM clients WHERE id IN ($1) ORDER BY `name`', [[...seenClient]]
    );
    clients.push(...clientRows);
  }

  res.json({
    ...report,
    filters: {
      projects: projects.map((p) => ({ id: p.id, name: p.name, clientId: p.client_id })),
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      users: people.map((u) => ({ id: u.id, name: u.name })),
      categories: referenceData.list('categories').map((c) => ({ key: c.key, label: c.label })),
      scopes: referenceData.list('asset_types').map((t) => ({ key: t.key, label: t.label })),
    },
    scope: { projects: projects.length },
  });
});

module.exports = router;
