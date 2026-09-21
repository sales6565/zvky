// Profit and loss, per project and per client.
//
// TWO TABS, ONE SET OF HOURS. Both read the same figure — the hours logged
// against tasks that have reached Delivered — and differ only in what they
// compare its cost against:
//
//   Fixed P&L    against the ESTIMATE. What the project was budgeted at, in
//                hours, costed at the same rates. Nothing is entered by hand;
//                there is no contract value, no billing and no revenue on this
//                tab at all. It answers "did the work cost more or less than we
//                said it would".
//
//   Actual P&L   against the PRICE. What the project was sold for, which is the
//                one figure in the whole feature somebody types in. It answers
//                "what are we making on this".
//
// WHAT THIS USED TO BE. Eight manual inputs across the two tabs: a free-text
// rate card, a per-project team list with hours typed against each person, a
// contract value, a billing type, an invoiced-to-date figure, a typed Total
// Cost and a set of ad hoc cost lines. Every one of them was either a number
// the application already knew or a number nobody kept up to date, and a stale
// figure in a P&L is worse than a missing one because it looks authoritative.
// They are gone. What is left is one price list in Settings, one typed figure
// per project, and arithmetic.
//
// ONE PLACE COMPUTES, EVERY SCREEN READS. The report, the client rollup and the
// per-project panel all call the same functions. Two implementations of
// "variance" agree until somebody edits one of them.
//
// WHAT THE NUMBERS MEAN, stated because none of them are self-evident:
//
//   Budgeted hours  Every asset's Man Hours estimate, added up. The same
//                   figure the Projects tab calls Total Bid Hours.
//   Recorded hours  Work sessions on assets that reached Delivered. Already
//                   clamped to the studio's working window in IST — see
//                   src/working-time.js — so evenings and weekends are out of
//                   it by construction.
//   Cost            Hours × the Rate Card rate of the designation that logged
//                   them, or, for the budget, of the designation the asset is
//                   assigned to. One rate table, one method, both sides.
//   Variance        Budgeted cost − actual cost. POSITIVE is a saving,
//                   NEGATIVE is an overrun. That direction is the studio's, and
//                   it is the opposite of the convention this file used before.
//   Total Value     What the project was sold for. Manual, Actual tab only.
//   Profit          Total Value − actual cost.
//   Margin          Profit ÷ Total Value, as a percentage. Null when no Total
//                   Value has been entered: a project nobody has priced has no
//                   margin, and printing 0% or −100% would both be assertions
//                   this cannot support.

/* The tables this feature needs to work, checked by /api/health.
 *
 * Four fewer than there were. rate_cards, project_team_assignments,
 * project_other_costs and pnl_snapshots backed the manual inputs and the margin
 * trend that have been removed; they are not created on a new deployment and
 * not required on an old one, where the rows are simply left where they are. */
const TABLES = ['role_rates', 'project_billing'];

// --- money ------------------------------------------------------------------

/* Two decimal places, and the rounding happens once.
 *
 * Every figure that reaches a screen goes through this. Rounding in some places
 * and not others is how a column of numbers stops adding up to its own total —
 * the reader adds the displayed values, the app adds the stored ones, and they
 * differ by a few pence with no explanation on the screen. */
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* Hours, to two places. A quarter of an hour is the smallest unit anybody
   enters, but two places costs nothing and survives a third of an hour. */
const hours = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* A percentage to one place, or null.
 *
 * NULL, not zero, when the denominator is zero. "0% margin" says the project
 * broke even; "no margin yet" says nothing has been invoiced. They are
 * different facts and a P&L that confuses them is misleading in the direction
 * that costs money. */
function percent(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

// --- schema -----------------------------------------------------------------

async function ensureTables(db) {
  /* THE RATE CARD. One price list, keyed on the designation catalogue.
   *
   * It is keyed that way because nothing else can work. A work_sessions row
   * records a user and a number of seconds; a user holds a designation; so a
   * designation is the only thing a recorded hour can be priced against
   * without somebody hand-matching every person to a row every time. The same
   * key prices an ESTIMATE, through the designation of whoever the asset is
   * assigned to, which is what makes budgeted-against-actual possible per role.
   *
   * IT IS ROLE AND LEVEL, because the studio's designations already are:
   * Senior Game Artist, Game Artist, Associate Game Artist, Trainee Game
   * Artist. There was a second, free-text rate_cards table of Artist/Senior
   * Artist pairs; it priced the manual team assignment and nothing else, so
   * when that went it had no reader. One list now, and it is this one.
   *
   * Rates are in the same plain currency as every other figure in this module;
   * the screens label it INR.
   *
   * A role with no row is NOT zero — it is UNPRICED, and the difference matters
   * enough that the read side reports the hours it could not price rather than
   * costing them at nothing and quietly understating what a project cost. */
  await db.query(`CREATE TABLE IF NOT EXISTS role_rates (
    role_key      VARCHAR(80)   NOT NULL PRIMARY KEY,
    rate_per_hour DECIMAL(10,2) NOT NULL DEFAULT 0,
    updated_by    VARCHAR(191)  NULL,
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  /* ONE FIELD ON THIS ROW THAT ANYBODY WRITES.
   *
   * contract_value, billing_type, invoiced_to_date and total_cost are created
   * for compatibility with a deployment that already has them — dropping a
   * column deletes figures somebody entered and stood behind, and that is a
   * migration nobody can undo — but nothing reads or writes them any more. The
   * Fixed tab has no revenue side at all now, and the Actual tab's cost is
   * computed rather than typed.
   *
   * total_value is what is left: the Actual tab's Total Project Value. NULL
   * means nobody has entered one, which is a different fact from zero. */
  await db.query(`CREATE TABLE IF NOT EXISTS project_billing (
    project_id       CHAR(36)      NOT NULL PRIMARY KEY,
    contract_value   DECIMAL(14,2) NOT NULL DEFAULT 0,
    billing_type     VARCHAR(24)   NULL,
    invoiced_to_date DECIMAL(14,2) NOT NULL DEFAULT 0,
    total_cost       DECIMAL(14,2) NULL,
    total_value      DECIMAL(14,2) NULL,
    updated_by       VARCHAR(191)  NULL,
    updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

// --- reading ----------------------------------------------------------------

async function billing(db, projectId) {
  const { rows } = await db.query('SELECT * FROM project_billing WHERE project_id = $1', [projectId]);
  const row = rows[0];
  /* NULL, not 0, when nobody has entered a Total Project Value. "This project
     is worth nothing" and "nobody has said what this project is worth" are
     different facts, and only one of them is ever true. The screen shows a dash
     for the second. */
  return {
    projectId,
    totalValue: row && row.total_value !== null && row.total_value !== undefined
      ? money(row.total_value) : null,
    updatedBy: row ? row.updated_by : null,
    updatedAt: row ? row.updated_at : null,
    configured: Boolean(row && row.total_value !== null && row.total_value !== undefined),
  };
}

// --- the numbers ------------------------------------------------------------

/* One project's P&L, from parts already fetched.
 *
 * Takes the rows rather than the database so the same function serves the
 * report, the rollup and the per-project panel without three round trips — and
 * so it can be tested against hand-written inputs with no server at all.
 *
 * `worked` is what src/pnl-hours.js returned: the budgeted hours and the
 * recorded hours, both already costed against the Rate Card. Everything below
 * is arithmetic on those and on the one typed figure. */
function compute({ billing: bill, hours: worked = null }) {
  const budgetedHours = worked ? hours(worked.budgetedHours) : 0;
  const budgetedCost = worked ? money(worked.budgetedCost) : 0;
  const recordedHours = worked ? hours(worked.recordedHours) : 0;
  const recordedCost = worked ? money(worked.recordedCost) : 0;

  /* NOT ENTERED IS NOT ZERO — see the note in billing(). */
  const totalValue = bill && bill.totalValue !== null && bill.totalValue !== undefined
    ? money(bill.totalValue) : null;

  return {
    // --- the Fixed tab: the estimate against what it took --------------------
    budgetedHours,
    budgetedCost,
    recordedHours,
    recordedCost,
    /* Budgeted minus actual: POSITIVE is a saving, NEGATIVE an overrun. */
    variance: money(budgetedCost - recordedCost),
    variancePercent: budgetedCost > 0
      ? percent(money(budgetedCost - recordedCost), budgetedCost) : null,
    /* A project nobody estimated is UNPLANNED, not under budget. Every project
       that predates the Man Hours field would otherwise carry a red flag that
       means nothing. */
    budgeted: budgetedHours > 0,
    overBudget: budgetedCost > 0 && recordedCost > budgetedCost,
    /* Hours nobody could price, on either side. Reported, never folded in at
       zero: the costs above are then LOWER than the truth, and the screen has
       to be able to say so. */
    unpricedHours: worked
      ? hours(worked.recordedUnpricedHours + worked.budgetedUnpricedHours) : 0,
    recordedUnpricedHours: worked ? hours(worked.recordedUnpricedHours) : 0,
    budgetedUnpricedHours: worked ? hours(worked.budgetedUnpricedHours) : 0,

    // --- the Actual tab: the price against what it took ----------------------
    totalValue,
    actualProfit: totalValue === null ? null : money(totalValue - recordedCost),
    actualMarginPercent: totalValue === null ? null
      : percent(money(totalValue - recordedCost), totalValue),
    /* What an hour on this project actually cost, blended. Derived, so it
       cannot disagree with the two figures it comes from. */
    costPerHour: recordedHours > 0 ? money(recordedCost / recordedHours) : null,
  };
}

/* Everything one project's P&L screen needs. */
async function forProject(db, projectId, { hours: worked = null } = {}) {
  const bill = await billing(db, projectId);
  return {
    projectId,
    billing: bill,
    totals: compute({ billing: bill, hours: worked }),
    byRole: worked ? worked.byRole : [],
  };
}

/* A client's rollup: the same metrics, summed across their projects.
 *
 * Summed from the per-project figures rather than recomputed from a wider
 * query, so a client total can never disagree with the projects listed under
 * it. Percentages are recomputed from the summed figures rather than averaged —
 * an average of percentages weights a 50,000 project the same as a 50,00,000
 * one, which is how a rollup ends up flattering a loss. */
function rollup(perProject) {
  const sum = (pick) => perProject.reduce((t, p) => t + pick(p.totals), 0);
  const budgetedCost = money(sum((t) => t.budgetedCost));
  const recordedCost = money(sum((t) => t.recordedCost));
  /* Total Value only adds up across the projects that HAVE one, and how many
     did is reported beside it — "₹20,00,000 across 3 of 7 projects" cannot then
     be misread as the value of all seven. A project with no Total Value
     contributes nothing rather than a zero that would drag the margin down as
     if it had been sold for nothing. */
  const totalValue = money(sum((t) => (t.totalValue === null ? 0 : t.totalValue)));
  const actualProfit = money(sum((t) => (t.actualProfit === null ? 0 : t.actualProfit)));
  const recordedHours = hours(sum((t) => t.recordedHours));

  return {
    projects: perProject.length,

    // Fixed
    budgetedHours: hours(sum((t) => t.budgetedHours)),
    budgetedCost,
    recordedHours,
    recordedCost,
    variance: money(budgetedCost - recordedCost),
    variancePercent: budgetedCost > 0 ? percent(money(budgetedCost - recordedCost), budgetedCost) : null,
    /* A COUNT, not a flag: a rollup over ten projects of which two are over is
       not "over budget", it is "two over budget". */
    overBudgetProjects: perProject.filter((p) => p.totals.overBudget).length,
    budgetedProjects: perProject.filter((p) => p.totals.budgeted).length,
    unpricedHours: hours(sum((t) => t.unpricedHours)),

    // Actual
    totalValue,
    projectsWithTotalValue: perProject.filter((p) => p.totals.totalValue !== null).length,
    actualProfit,
    actualMarginPercent: percent(actualProfit, totalValue),
    costPerHour: recordedHours > 0 ? money(recordedCost / recordedHours) : null,
  };
}

module.exports = {
  TABLES,
  ensureTables,
  billing, forProject, compute, rollup,
  money, hours, percent,
};
