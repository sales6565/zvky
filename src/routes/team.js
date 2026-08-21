const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// GET /api/team — the current team lead's artists with progress stats
router.get('/', requireRole('team_lead'), async (req, res) => {
  const { rows: members } = await pool.query(
    'SELECT id, name, email FROM users WHERE role = $1 AND team_lead_id = $2 ORDER BY name',
    ['artist', req.user.id]
  );
  if (!members.length) return res.json({ members: [] });

  const ids = members.map((m) => m.id);
  const { rows: stats } = await pool.query(
    `SELECT a.assignee_id,
            COUNT(DISTINCT a.id)::int AS asset_count,
            COUNT(t.id)::int AS total_tasks,
            COUNT(t.id) FILTER (WHERE t.done)::int AS done_tasks
     FROM assets a
     LEFT JOIN tasks t ON t.asset_id = a.id
     WHERE a.assignee_id = ANY($1)
     GROUP BY a.assignee_id`,
    [ids]
  );

  const withStats = members.map((m) => {
    const s = stats.find((x) => x.assignee_id === m.id) || { asset_count: 0, total_tasks: 0, done_tasks: 0 };
    return {
      ...m,
      assetCount: s.asset_count,
      totalTasks: s.total_tasks,
      doneTasks: s.done_tasks,
      progressPct: s.total_tasks ? Math.round((s.done_tasks / s.total_tasks) * 100) : 0,
    };
  });
  res.json({ members: withStats });
});

module.exports = router;
