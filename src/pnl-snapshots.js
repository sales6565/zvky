// The margin trend's memory.
//
// WHY THIS TABLE HAS TO EXIST. Everything else in the P&L schema holds one
// CURRENT value per thing: hours worked to date, invoiced to date, this cost.
// A single current number cannot produce a curve. A "trend" computed from it
// would be today's margin drawn backwards across twelve months and presented as
// history — a straight line that looks like data and is a fabrication.
//
// So the state is written down as it changes, one row per project per month.
// The trend then reports what was actually true, and it necessarily starts
// empty: there is no back-history to synthesise, and the screen says so rather
// than filling the gap with a flat line. Three months from now it has three
// months. That is the honest version of this feature and the only one worth
// putting a percentage on.
//
// A snapshot is REWRITTEN, not appended, within its month. The row means "where
// this project stood at the end of this month", so the last write of the month
// is the one that counts; appending would turn a busy afternoon of edits into
// six points on a chart that all belong to the same day.
//
// Never throws. Recording that the numbers moved must not be able to stop them
// moving — a failed snapshot costs a point on a chart, and a failed save costs
// somebody their work.

const { v4: uuid } = require('uuid');
const pnl = require('./pnl');

const monthOf = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/* Write this project's current position into this month's row. */
async function capture(db, projectId, { now = new Date() } = {}) {
  try {
    const [bill, team, others] = await Promise.all([
      pnl.billing(db, projectId),
      pnl.assignments(db, projectId),
      pnl.otherCosts(db, projectId),
    ]);
    const totals = pnl.compute({ billing: bill, assignments: team, otherCosts: others });

    await db.query(
      `INSERT INTO pnl_snapshots (id, project_id, month, revenue, labour_cost, other_costs)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON DUPLICATE KEY UPDATE revenue = VALUES(revenue),
         labour_cost = VALUES(labour_cost), other_costs = VALUES(other_costs)`,
      [uuid(), projectId, monthOf(now), totals.revenue, totals.labourCost, totals.otherCosts]
    );
    return true;
  } catch (err) {
    console.warn(`[pnl] could not snapshot ${projectId}: ${err.message}`);
    return false;
  }
}

/* Gross margin by month across a set of projects.
 *
 * Summed per month across the projects, then the margin recomputed from those
 * sums — not averaged. An average of percentages weights a small project the
 * same as a large one, which is how a rollup ends up flattering a loss.
 *
 * A month in which a project has no snapshot contributes nothing rather than
 * zero. Zero would read as "that project earned nothing that month" when the
 * truth is "nothing about it changed, so nothing was recorded" — and a chart
 * cannot tell those apart unless the data does.
 */
async function trend(db, projectIds, { from = null, to = null } = {}) {
  if (!projectIds || !projectIds.length) return { months: [], from: null, to: null, empty: true };

  const params = [projectIds];
  let where = 'project_id IN ($1)';
  if (/^\d{4}-\d{2}$/.test(from || '')) { params.push(from); where += ` AND month >= $${params.length}`; }
  if (/^\d{4}-\d{2}$/.test(to || '')) { params.push(to); where += ` AND month <= $${params.length}`; }

  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT month,
              SUM(revenue) AS revenue,
              SUM(labour_cost) AS labourCost,
              SUM(other_costs) AS otherCosts,
              COUNT(*) AS projects
         FROM pnl_snapshots
        WHERE ${where}
        GROUP BY month
        ORDER BY month`,
      params
    ));
  } catch (err) {
    return { months: [], empty: true, unavailable: err.code || 'error' };
  }

  const months = rows.map((r) => {
    const revenue = pnl.money(r.revenue);
    const cost = pnl.money(pnl.money(r.labourCost) + pnl.money(r.otherCosts));
    const grossProfit = pnl.money(revenue - cost);
    return {
      month: r.month,
      revenue,
      cost,
      grossProfit,
      marginPercent: pnl.percent(grossProfit, revenue),
      projects: Number(r.projects) || 0,
    };
  });

  return {
    months,
    from: months.length ? months[0].month : null,
    to: months.length ? months[months.length - 1].month : null,
    empty: months.length === 0,
    /* Said out loud on the screen. The trend begins when this feature was
       installed, and a reader who does not know that will take a two-month
       chart for a two-month-old studio. */
    note: 'Each point is where these projects stood at the end of that month. '
      + 'Months before the Profit & Loss feature was set up have no snapshot and are not shown.',
  };
}

module.exports = { capture, trend, monthOf };
