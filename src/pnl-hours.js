// What a project was estimated at, what it actually took, and what both cost.
//
// ONE FIGURE, READ BY BOTH TABS. `recordedHours` is the hours logged against
// tasks that have reached DELIVERED, and it is the only "actual hours" number
// in the Profit & Loss feature. The Fixed tab compares it against the estimate;
// the Actual tab compares its cost against what the project was sold for. They
// cannot disagree about how much work was done, because there is one number and
// they both read it.
//
// TWO HOUR FIGURES, and they are two because they answer two questions:
//
//   budgetedHours   SUM(assets.man_hours) over the project. What it was
//                   estimated at. The same number, computed the same way, that
//                   the Projects tab has always called Total Bid Hours — not a
//                   second budget that could disagree with the first, and not a
//                   figure anybody types into the P&L screen.
//
//   recordedHours   Work sessions on assets that have reached DELIVERED. Hours
//                   that turned into something the client got.
//
// WHY DELIVERED IS COMPUTED, NOT ACCUMULATED. Nothing increments a running
// total when an asset is delivered. The figure is derived from the asset's
// current state every time it is read, so it is correct after a delivery, after
// an asset is moved back out of Delivered by an override, and after a work
// session is added to an asset that was already delivered. A stored counter
// would have to be right at every one of those moments and would be wrong the
// first time one of them was missed. "Accumulated automatically as tasks
// complete" is satisfied by never being stale rather than by being poked.
//
// THE HOURS ARE ALREADY WORKING HOURS. work_sessions.seconds is the part of a
// session that fell inside the studio's configured working window, in IST —
// see src/working-time.js. Nothing here re-applies that rule, and nothing here
// may undo it: everything below sums the column, so evenings, weekends and
// breaks are out of these figures by construction.
//
// PRICING, and the honesty problem at the centre of it. A work session records
// a USER. A user holds a DESIGNATION. The Rate Card prices a designation per
// hour. So an hour costs whatever that person's designation costs, and an
// ESTIMATE costs whatever the designation of the person it is assigned to
// costs — which is what makes a budgeted-against-actual comparison per role
// possible at all. A designation with no rate row is UNPRICED — NOT free — and
// every function here reports the hours it could not price separately rather
// than folding them in at zero. Costing an unpriced hour at nothing understates
// what a project cost, which is the direction of error that makes a studio
// think a loss was a profit.

const workflow = require('./asset-workflow');

/* The state that means the client has it. Read from the workflow rather than
   typed, so renaming the state in one place cannot leave this silently summing
   a state that no longer exists. */
const DELIVERED = 'delivered';
if (!workflow.STATE_IDS.includes(DELIVERED)) {
  throw new Error(`pnl-hours: the workflow has no "${DELIVERED}" state`);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/* Seconds to hours, to two places. Work sessions are stored in seconds because
   that is what a clock produces; every figure above this line is in hours
   because that is what a rate is quoted in. */
const toHours = (seconds) => round2((Number(seconds) || 0) / 3600);

/* Every designation's hourly rate, as a Map. Absent means unpriced. */
async function roleRates(db) {
  const { rows } = await db.query('SELECT role_key, rate_per_hour FROM role_rates')
    .catch(() => ({ rows: [] }));
  const map = new Map();
  for (const row of rows) map.set(row.role_key, round2(row.rate_per_hour));
  return map;
}

/* What this project was estimated at: every asset's Man Hours, added up without
   condition — no filter on status, and none on which Assets List tab the asset
   sits in. An asset does not stop having been estimated because it was
   delivered. Identical in definition to the Projects tab's Total Bid Hours. */
async function bidHours(db, projectId) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(man_hours), 0) AS h FROM assets WHERE project_id = $1', [projectId]
  ).catch(() => ({ rows: [{ h: 0 }] }));
  return round2(rows[0] ? rows[0].h : 0);
}

/* Hours logged per person, optionally only on delivered assets.
 *
 * Summing session ROWS rather than subtracting the first start from the last
 * end is what makes held stretches fall out automatically: the gap is between
 * two rows, so no row covers it. Same reasoning, same result, as the Projects
 * tab and the Efficiency report. */
async function hoursByUser(db, projectId, { deliveredOnly = false } = {}) {
  const { rows } = await db.query(
    `SELECT w.user_id, u.\`name\` AS user_name, u.\`role\` AS role_key,
            COALESCE(SUM(w.seconds), 0) AS seconds
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
       LEFT JOIN users u ON u.id = w.user_id
      WHERE a.project_id = $1 ${deliveredOnly ? 'AND a.status = $2' : ''}
      GROUP BY w.user_id, u.\`name\`, u.\`role\``,
    deliveredOnly ? [projectId, DELIVERED] : [projectId]
  ).catch(() => ({ rows: [] }));

  return rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name || null,
    roleKey: r.role_key || null,
    hours: toHours(r.seconds),
  })).filter((r) => r.hours > 0);
}

/* The ESTIMATE, split by the designation it is assigned to.
 *
 * Each asset carries a Man Hours estimate and an assignee; the assignee holds a
 * designation; the Rate Card prices a designation. So an estimate can be costed
 * exactly the way a logged hour is, and the Fixed tab's budgeted-against-actual
 * comparison can be made per role rather than only as one project-wide number.
 *
 * Shaped identically to hoursByUser above so that priceHours can cost either
 * without knowing which it was handed. That symmetry is the point: the budget
 * and the actual are priced by the same function against the same rate table,
 * so a variance between them is a difference in HOURS and never an artefact of
 * the two sides being priced differently.
 *
 * AN ASSET WITH NOBODY ON IT still has an estimate, and that estimate is part
 * of the budget. It lands in the no-designation bucket, where it is counted and
 * not priced — which reads on screen as "these hours are budgeted and we cannot
 * say what they should cost", rather than vanishing from a total that then does
 * not add up to the project's own Total Bid Hours. */
async function budgetByUser(db, projectId) {
  const { rows } = await db.query(
    `SELECT a.assignee_id AS user_id, u.\`name\` AS user_name, u.\`role\` AS role_key,
            COALESCE(SUM(a.man_hours), 0) AS hours
       FROM assets a
       LEFT JOIN users u ON u.id = a.assignee_id
      WHERE a.project_id = $1
      GROUP BY a.assignee_id, u.\`name\`, u.\`role\``,
    [projectId]
  ).catch(() => ({ rows: [] }));

  return rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name || null,
    roleKey: r.role_key || null,
    hours: round2(r.hours),
  })).filter((r) => r.hours > 0);
}

/* Total hours consumed on the project, every asset, every state. The Actual
   tab's headline hours figure. */
async function consumedHours(db, projectId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(w.seconds), 0) AS s
       FROM work_sessions w JOIN assets a ON a.id = w.asset_id
      WHERE a.project_id = $1`, [projectId]
  ).catch(() => ({ rows: [{ s: 0 }] }));
  return toHours(rows[0] ? rows[0].s : 0);
}

/* Price a set of per-person hours against the role rates.
 *
 * Returns the cost AND what it could not cost, because those two numbers
 * together are the honest answer and either one alone is not. */
function priceHours(people, rates, roleLabel = (k) => k) {
  const byRole = new Map();
  let cost = 0;
  let pricedHours = 0;
  let unpricedHours = 0;

  for (const person of people) {
    const rate = person.roleKey !== null && rates.has(person.roleKey)
      ? rates.get(person.roleKey) : null;
    const key = person.roleKey || '(no designation)';
    if (!byRole.has(key)) {
      byRole.set(key, {
        roleKey: person.roleKey,
        roleLabel: person.roleKey ? roleLabel(person.roleKey) : 'No designation',
        ratePerHour: rate,
        priced: rate !== null,
        hours: 0,
        cost: 0,
        people: [],
      });
    }
    const bucket = byRole.get(key);
    bucket.hours = round2(bucket.hours + person.hours);
    bucket.people.push(person.userName || 'Unknown');
    if (rate === null) {
      unpricedHours = round2(unpricedHours + person.hours);
    } else {
      const line = round2(person.hours * rate);
      bucket.cost = round2(bucket.cost + line);
      cost = round2(cost + line);
      pricedHours = round2(pricedHours + person.hours);
    }
  }

  return {
    cost,
    pricedHours,
    /* Hours from somebody whose designation has no rate. Reported, never
       folded into the cost at zero — see the note at the top of this file. */
    unpricedHours,
    byRole: [...byRole.values()].sort((a, b) => b.hours - a.hours),
  };
}

/* Everything both tabs need about hours and their cost, for one project.
 *
 * ONE ROUND OF QUERIES, ONE SET OF NUMBERS. Both tabs are served from this, so
 * the Fixed tab's "actual" and the Actual tab's "recorded" are not two figures
 * that happen to agree — they are the same figure, read twice.
 *
 * THE ROLE BREAKDOWN IS THE UNION of the two sides. A designation that was
 * budgeted for and never logged an hour has to appear, or the table cannot
 * answer "what did we plan for that nobody did"; a designation that logged
 * hours nobody budgeted for has to appear, or the table will not add up to the
 * actual cost printed above it. So the rows are merged rather than taken from
 * either side.
 */
async function forProject(db, projectId, { rates = null, roleLabel = (k) => k } = {}) {
  const priceList = rates || await roleRates(db);
  const [budgetPeople, recordedPeople] = await Promise.all([
    budgetByUser(db, projectId),
    hoursByUser(db, projectId, { deliveredOnly: true }),
  ]);

  const budget = priceHours(budgetPeople, priceList, roleLabel);
  const recorded = priceHours(recordedPeople, priceList, roleLabel);

  const budgetedHours = round2(budgetPeople.reduce((t, p) => t + p.hours, 0));
  const recordedHours = round2(recordedPeople.reduce((t, p) => t + p.hours, 0));

  /* VARIANCE, AND ITS SIGN. Budgeted minus actual, so POSITIVE is money the
     studio did not have to spend — a saving — and NEGATIVE is an overrun. That
     is the direction the studio asked for, and it is the opposite of the
     convention the old Fixed tab used (actual minus budget, where positive was
     bad). Stated here, once, so no screen has to decide it.

     The percentage is against the BUDGET, not against the actual: "we came in
     20% under what we planned" is a statement about the plan. Null when there
     is no budget to be under, because a percentage of nothing is not a number
     and printing 0% would say the project came in exactly on a plan that does
     not exist. */
  const variance = round2(budget.cost - recorded.cost);
  const variancePercent = budget.cost > 0
    ? Math.round((variance / budget.cost) * 1000) / 10 : null;

  return {
    // --- the shared figure both tabs read ------------------------------------
    recordedHours,
    recordedCost: recorded.cost,
    recordedUnpricedHours: recorded.unpricedHours,

    // --- the Fixed tab's other half ------------------------------------------
    budgetedHours,
    budgetedCost: budget.cost,
    budgetedUnpricedHours: budget.unpricedHours,
    variance,
    variancePercent,
    /* Whether there is a plan at all. A project nobody estimated is UNPLANNED,
       not under budget — "0 budgeted, 5,000 spent, 5,000 over" on every project
       that predates the Man Hours field would be a red flag with no meaning. */
    budgeted: budgetedHours > 0,

    // --- the breakdown both tabs show ----------------------------------------
    byRole: mergeRoles(budget.byRole, recorded.byRole),
  };
}

/* The budget rows and the actual rows, zipped into one table.
 *
 * Keyed on the designation, so each appears once with both sides against it.
 * A row present on one side only is kept with zeroes on the other, because
 * "budgeted 40 hours, did none" and "did 40 hours nobody budgeted for" are
 * exactly the two things this table exists to show. */
function mergeRoles(budgetRows, recordedRows) {
  const rows = new Map();
  const bucket = (r) => {
    const key = r.roleKey || '(none)';
    if (!rows.has(key)) {
      rows.set(key, {
        roleKey: r.roleKey,
        roleLabel: r.roleLabel,
        ratePerHour: r.ratePerHour,
        priced: r.priced,
        budgetedHours: 0, budgetedCost: 0,
        recordedHours: 0, recordedCost: 0,
        people: new Set(),
      });
    }
    return rows.get(key);
  };
  for (const r of budgetRows) {
    const b = bucket(r);
    b.budgetedHours = round2(b.budgetedHours + r.hours);
    b.budgetedCost = round2(b.budgetedCost + r.cost);
  }
  for (const r of recordedRows) {
    const b = bucket(r);
    b.recordedHours = round2(b.recordedHours + r.hours);
    b.recordedCost = round2(b.recordedCost + r.cost);
    for (const n of (r.people || [])) b.people.add(n);
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      people: [...r.people].sort(),
      variance: round2(r.budgetedCost - r.recordedCost),
      hoursVariance: round2(r.budgetedHours - r.recordedHours),
    }))
    /* Biggest commitment first, budget or actual — a role with a large budget
       and no hours yet is as interesting as one that has burned through. */
    .sort((a, b) => Math.max(b.budgetedHours, b.recordedHours) - Math.max(a.budgetedHours, a.recordedHours));
}

module.exports = {
  DELIVERED, roleRates, bidHours, consumedHours, hoursByUser, budgetByUser,
  priceHours, mergeRoles, forProject, toHours, round2,
};
