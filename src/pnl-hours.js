// What a project actually consumed, and what that cost.
//
// THIS MODULE REPLACED A SET OF TYPED-IN NUMBERS WITH RECORDED ONES. The two
// P&L tabs used to be costed from hours somebody entered by hand against a
// planned team list. They are now costed from what the application already
// knows: the Man Hours estimate on each asset, the work sessions people
// actually logged, and a per-role hourly rate set once in Settings.
//
// THREE HOUR FIGURES, and they are three because they answer three questions:
//
//   bidHours        SUM(assets.man_hours) over the project. What it was
//                   estimated at. The same number, computed the same way, that
//                   the Projects tab has always called Total Bid Hours — not a
//                   second budget that could disagree with the first.
//
//   consumedHours   Every work session on every asset in the project, whatever
//                   state the asset is in. What the studio has spent on it so
//                   far. The same definition the Projects tab calls Spent Time
//                   and the Efficiency report calls totalSeconds.
//
//   deliveredHours  Work sessions on assets that have reached DELIVERED only.
//                   Hours that turned into something the client got. This is
//                   the one that moves when a task is delivered and not before,
//                   and it is what the Fixed tab costs.
//
// WHY DELIVERED IS COMPUTED, NOT ACCUMULATED. Nothing increments a running
// total when an asset is delivered. The figure is derived from the asset's
// current state every time it is read, so it is correct after a delivery, after
// an asset is moved back out of Delivered by an override, and after a work
// session is added to an asset that was already delivered. A stored counter
// would have to be right at every one of those moments and would be wrong the
// first time one of them was missed. "Updates automatically as tasks are
// delivered" is satisfied by never being stale rather than by being poked.
//
// PRICING, and the honesty problem at the centre of it. A work session records
// a USER. A user holds a DESIGNATION. role_rates prices a designation per hour.
// So an hour costs whatever that person's designation costs. A designation with
// no rate row is UNPRICED — NOT free — and every function here reports the
// hours it could not price separately rather than folding them in at zero.
// Costing an unpriced hour at nothing understates what a project cost, which is
// the direction of error that makes a studio think a loss was a profit.

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

/* Everything both tabs need about hours and their cost, for one project. */
async function forProject(db, projectId, { rates = null, roleLabel = (k) => k } = {}) {
  const priceList = rates || await roleRates(db);
  const [bid, consumed, allPeople, deliveredPeople] = await Promise.all([
    bidHours(db, projectId),
    consumedHours(db, projectId),
    hoursByUser(db, projectId),
    hoursByUser(db, projectId, { deliveredOnly: true }),
  ]);

  const delivered = priceHours(deliveredPeople, priceList, roleLabel);
  const all = priceHours(allPeople, priceList, roleLabel);

  /* The BUDGET, priced the same way the actual is: the project's estimated
     hours at the blended rate the delivered work actually ran at. Costing the
     bid at a different rate basis than the actual would make the variance a
     mixture of an hours difference and a rate difference, which is precisely
     the thing a variance is supposed to isolate. A project with no delivered
     hours yet has no blended rate, so its budget is unpriced rather than
     guessed. */
  const blendedRate = delivered.pricedHours > 0
    ? round2(delivered.cost / delivered.pricedHours) : null;

  return {
    bidHours: bid,
    consumedHours: consumed,
    /* THE ACTUAL TAB'S COST, and the breakdown behind it.
     *
     * Every hour logged against the project's assets, whatever state they are
     * in, priced at the logger's designation rate. `consumedCost` was already
     * here as a reference figure beside a cost somebody typed in; the Actual
     * tab is now costed FROM it, so the per-designation rows that produce it
     * have to travel with it. Without them the tab could show a total with no
     * way to see what it is made of, which for a money figure is the same as
     * not showing it.
     *
     * Deliberately NOT the delivered-only set below. The Fixed tab asks "what
     * did the work the client has actually received cost us?"; the Actual tab
     * asks "what has this project cost us so far?" — and work in progress has
     * cost the studio its hours whether or not anybody has received it yet. */
    consumedByRole: all.byRole,
    deliveredHours: round2(deliveredPeople.reduce((t, p) => t + p.hours, 0)),
    /* Hours consumed on work that has NOT been delivered. Stated rather than
       left to be subtracted, because it is the number somebody asks for the
       moment the other two differ. */
    undeliveredHours: round2(consumed - deliveredPeople.reduce((t, p) => t + p.hours, 0)),
    actualCost: delivered.cost,
    actualUnpricedHours: delivered.unpricedHours,
    byRole: delivered.byRole,
    blendedRate,
    budgetedCost: blendedRate === null ? null : round2(bid * blendedRate),
    /* Cost of everything logged, delivered or not. Not shown as a headline —
       it is here so the Actual tab can say what the app's own records imply,
       beside the figure somebody typed in. */
    consumedCost: all.cost,
    consumedUnpricedHours: all.unpricedHours,
    /* Hours that WERE priced, so a caller can say "₹X across Yh" without
       having to subtract the unpriced ones itself and get it subtly wrong. */
    consumedPricedHours: all.pricedHours,
  };
}

module.exports = {
  DELIVERED, roleRates, bidHours, consumedHours, hoursByUser, priceHours,
  forProject, toHours, round2,
};
