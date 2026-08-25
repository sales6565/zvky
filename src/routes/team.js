const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// GET /api/team — the reports of whoever is asking, with progress stats.
// Available to any designation that runs a team: Team Lead, Senior Team Lead,
// Associate Team Lead, Art Supervisor, Associate Animation Supervisor.
router.get('/', requirePermission('user.view_team'), async (req, res) => {
  const { rows: members } = await db.query(
    'SELECT id, name, email, role FROM users WHERE team_lead_id = $1 ORDER BY name',
    [req.user.id]
  );
  if (!members.length) return res.json({ members: [] });

  const ids = members.map((m) => m.id);
  const { rows: stats } = await db.query(
    `SELECT a.assignee_id,
            COUNT(DISTINCT a.id) AS asset_count,
            COUNT(t.id) AS total_tasks,
            SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS done_tasks
     FROM assets a
     LEFT JOIN tasks t ON t.asset_id = a.id
     WHERE a.assignee_id IN ($1)
     GROUP BY a.assignee_id`,
    [ids]
  );

  const withStats = members.map((m) => {
    const s = stats.find((x) => x.assignee_id === m.id);
    const totalTasks = Number(s ? s.total_tasks : 0);
    const doneTasks = Number(s ? s.done_tasks : 0);
    return {
      ...m,
      assetCount: Number(s ? s.asset_count : 0),
      totalTasks,
      doneTasks,
      progressPct: totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0,
    };
  });
  res.json({ members: withStats });
});

module.exports = router;
