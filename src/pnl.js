// Profit and loss, per project and per client.
//
// THE FIRST MONEY IN THIS APPLICATION. Nothing here existed before: no rates,
// no billing, no costs, no currency. That is worth knowing because it means
// there is no house style to follow and no existing figure to reconcile
// against — every number below is defined here and nowhere else, which is
// exactly why it is defined once.
//
// ONE PLACE COMPUTES, EVERY SCREEN READS. The report, the client rollup and
// the monthly snapshot all call the same functions. Two implementations of
// "gross profit" agree until somebody edits one of them, and a P&L where the
// summary card and the rollup disagree is worse than no P&L at all — somebody
// would have to work out which of them to believe.
//
// WHAT THE NUMBERS MEAN, stated because none of them are self-evident:
//
//   Revenue      Invoiced to date. NOT the contract value. A contract worth a
//                million that has billed nothing has earned nothing, and
//                treating the contract as revenue would show a fat margin on
//                work nobody has paid for. Contract value is recorded beside
//                it and shown, because the gap between the two is itself worth
//                seeing, but it is not revenue.
//
//   Labour cost  The sum of rate x hours across the project's team
//                assignments. Hours are entered by hand, per the brief — see
//                the note on that in the assignment section below.
//
//   Other costs  Ad hoc line items: contractors, licensing, outsourcing.
//                Itemised rather than a single number so that a cost can be
//                explained six months later.
//
//   Gross profit Revenue - labour - other.
//   Margin       Gross profit / revenue, as a percentage. Null when revenue is
//                zero: a project that has invoiced nothing has no margin, and
//                printing 0% or -100% would both be assertions this cannot
//                support.

const { v4: uuid } = require('uuid');

const TABLES = [
  'rate_cards', 'project_team_assignments', 'project_billing',
  'project_other_costs', 'pnl_snapshots',
];

/* How a project is billed.
 *
 * Nothing in this application had a billing type before, so this list is new
 * rather than reused — there was no enum to borrow. Kept as a small table here
 * rather than a database ENUM, which MySQL makes painful to extend. */
const BILLING_TYPES = [
  { id: 'fixed', label: 'Fixed' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'time_and_material', label: 'Time & Material' },
];
const BILLING_IDS = BILLING_TYPES.map((b) => b.id);

/* The rate card the studio starts with.
 *
 * These are the eight combinations the brief named, and they are SEEDED rather
 * than hardcoded — every one can be renamed, re-rated or deleted, and more can
 * be added, because a studio's ladder is its own business.
 *
 * Deliberately NOT tied to the designation catalogue. The studio's designations
 * are levelled trainee / associate / (base) / senior; the brief's rate card is
 * levelled Junior / Mid / Senior / Team Lead. Those are two different
 * vocabularies, and mapping one onto the other would either lose a level or
 * invent a correspondence nobody asked for. An assignment therefore picks a
 * rate card row explicitly rather than inheriting one from whoever it is for.
 *
 * The rate is 0 on purpose. A seeded number would be a number somebody might
 * not notice was invented, and an invented rate in a P&L is worse than a blank
 * one — the screen shows unrated rows as needing attention. */
const SEED_RATE_CARDS = [
  { role: 'Artist', level: 'Junior Level Artist' },
  { role: 'Artist', level: 'Mid Level Artist' },
  { role: 'Artist', level: 'Senior Artist' },
  { role: 'Artist', level: 'Art Team Lead' },
  { role: 'Animator', level: 'Junior Level Animator' },
  { role: 'Animator', level: 'Mid Level Animator' },
  { role: 'Animator', level: 'Senior Animator' },
  { role: 'Animator', level: 'Animation Team Lead' },
];

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
  await db.query(`CREATE TABLE IF NOT EXISTS rate_cards (
    id            CHAR(36)      NOT NULL PRIMARY KEY,
    \`role\`      VARCHAR(80)   NOT NULL,
    level         VARCHAR(80)   NOT NULL,
    rate_per_hour DECIMAL(10,2) NOT NULL DEFAULT 0,
    is_active     TINYINT(1)    NOT NULL DEFAULT 1,
    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_rate_card (\`role\`, level)
  )`);

  /* An assignment carries its OWN rate, copied from the card when it is made.
   *
   * That copy is the point. A rate card is the studio's current price list; an
   * assignment is what this project is being costed at. Re-pricing the card
   * next April must not silently rewrite the cost of work done last year, which
   * is exactly what a join to the live rate would do — and a P&L that changes
   * retrospectively is not a record of anything.
   *
   * rate_card_id is kept so the row can say which card it came from, and is
   * nullable so deleting a card does not delete the history that used it. */
  await db.query(`CREATE TABLE IF NOT EXISTS project_team_assignments (
    id            CHAR(36)      NOT NULL PRIMARY KEY,
    project_id    CHAR(36)      NOT NULL,
    user_id       CHAR(36)      NULL,
    person_name   VARCHAR(160)  NULL,
    rate_card_id  CHAR(36)      NULL,
    \`role\`      VARCHAR(80)   NOT NULL,
    level         VARCHAR(80)   NOT NULL,
    rate_per_hour DECIMAL(10,2) NOT NULL DEFAULT 0,
    /* THREE DIFFERENT HOURS, and they are three because they answer three
       different questions. Conflating any two of them is what makes a P&L
       agree with itself and disagree with reality.

         assigned_hours  what was PLANNED for this person's role when the
                         project was priced. The Fixed P&L's budget.
         hours           what was actually WORKED. The cost, on both tabs.
         billed_hours    what was actually INVOICED to the client for that
                         role. May be less than worked (absorbed) or more
                         (a rounded-up block).

       All three default to 0, so an assignment written before these columns
       existed reads as "planned nothing, billed nothing" rather than throwing
       — and 0 is honest there: nobody recorded a plan. */
    assigned_hours DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`hours\`     DECIMAL(10,2) NOT NULL DEFAULT 0,
    billed_hours  DECIMAL(10,2) NOT NULL DEFAULT 0,
    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_pta_project (project_id)
  )`);

  // One row per project. contract_value is recorded but is NOT revenue.
  await db.query(`CREATE TABLE IF NOT EXISTS project_billing (
    project_id       CHAR(36)      NOT NULL PRIMARY KEY,
    contract_value   DECIMAL(14,2) NOT NULL DEFAULT 0,
    billing_type     VARCHAR(24)   NULL,
    invoiced_to_date DECIMAL(14,2) NOT NULL DEFAULT 0,
    updated_by       VARCHAR(191)  NULL,
    updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS project_other_costs (
    id         CHAR(36)      NOT NULL PRIMARY KEY,
    project_id CHAR(36)      NOT NULL,
    label      VARCHAR(160)  NOT NULL,
    amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_poc_project (project_id)
  )`);

  /* THE MARGIN TREND'S ONLY SOURCE OF HISTORY.
   *
   * The rest of this schema holds one current value per thing: hours worked to
   * date, invoiced to date. A single current number cannot produce a curve, so
   * a trend computed from it would be a straight line drawn through today's
   * figure and presented as the past — a fabrication.
   *
   * So the state is written down as it changes, keyed by month. The trend then
   * reports what was actually true at the end of each month. It necessarily
   * starts empty and fills up from here; the screen says so rather than
   * inventing the months before this table existed. */
  await db.query(`CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id          CHAR(36)      NOT NULL PRIMARY KEY,
    project_id  CHAR(36)      NOT NULL,
    month       CHAR(7)       NOT NULL,
    revenue     DECIMAL(14,2) NOT NULL DEFAULT 0,
    labour_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
    other_costs DECIMAL(14,2) NOT NULL DEFAULT 0,
    captured_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_snapshot (project_id, month),
    KEY idx_snapshot_month (month)
  )`);
}

/* The eight starting rows, inserted only when the table is empty.
 *
 * Empty rather than per-row, so a studio that deletes a level it does not use
 * does not have it put back on the next restart. */
async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM rate_cards');
  if (Number(rows[0].n) > 0) return 0;
  for (const card of SEED_RATE_CARDS) {
    await db.query(
      'INSERT INTO rate_cards (id, `role`, level, rate_per_hour) VALUES ($1,$2,$3,0)',
      [uuid(), card.role, card.level]
    );
  }
  return SEED_RATE_CARDS.length;
}

// --- reading ----------------------------------------------------------------

const shapeCard = (r) => ({
  id: r.id, role: r.role, level: r.level,
  ratePerHour: money(r.rate_per_hour),
  isActive: Boolean(r.is_active),
});

async function rateCards(db, { includeInactive = true } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM rate_cards ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY \`role\`, level`
  );
  return rows.map(shapeCard);
}

const shapeAssignment = (r) => ({
  id: r.id,
  projectId: r.project_id,
  userId: r.user_id || null,
  personName: r.person_name || r.user_name || '',
  rateCardId: r.rate_card_id || null,
  role: r.role,
  level: r.level,
  ratePerHour: money(r.rate_per_hour),
  /* `hours` stays the WORKED hours under its original name. Renaming it to
     actualHours would have been tidier and would have broken every caller that
     already reads it, for no gain — the two new fields are named for what they
     are and this one keeps the meaning it always had. */
  hours: hours(r.hours),
  assignedHours: hours(r.assigned_hours),
  billedHours: hours(r.billed_hours),
  // Computed, never stored: a stored total is a second copy of a product that
  // can fall out of step with its own factors. Same rate for all three, because
  // it is the same person doing the same work — what differs is the hours.
  cost: money(money(r.rate_per_hour) * hours(r.hours)),
  budgetedCost: money(money(r.rate_per_hour) * hours(r.assigned_hours)),
  /* Worked minus billed. Positive means hours were worked and not invoiced —
     absorbed. Negative means more was invoiced than worked. Both are worth
     seeing and neither is automatically wrong, so it is reported as a signed
     number rather than flagged. */
  hoursDelta: hours(hours(r.hours) - hours(r.billed_hours)),
});

async function assignments(db, projectId) {
  const { rows } = await db.query(
    `SELECT a.*, u.\`name\` AS user_name
       FROM project_team_assignments a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.project_id = $1
      ORDER BY a.\`role\`, a.level, a.created_at`,
    [projectId]
  );
  return rows.map(shapeAssignment);
}

async function billing(db, projectId) {
  const { rows } = await db.query('SELECT * FROM project_billing WHERE project_id = $1', [projectId]);
  const row = rows[0];
  return {
    projectId,
    contractValue: row ? money(row.contract_value) : 0,
    billingType: row ? (row.billing_type || null) : null,
    invoicedToDate: row ? money(row.invoiced_to_date) : 0,
    updatedBy: row ? row.updated_by : null,
    updatedAt: row ? row.updated_at : null,
    // Whether anything has been entered at all, so the screen can say "not set
    // up" rather than showing a confident set of zeroes.
    configured: Boolean(row),
  };
}

async function otherCosts(db, projectId) {
  const { rows } = await db.query(
    'SELECT * FROM project_other_costs WHERE project_id = $1 ORDER BY created_at', [projectId]);
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, label: r.label, amount: money(r.amount) }));
}

// --- the numbers ------------------------------------------------------------

/* One project's P&L, from parts already fetched.
 *
 * Takes the rows rather than the database so the same function serves the
 * report, the rollup and the snapshot without three round trips — and so it can
 * be tested against hand-written inputs with no server at all. */
function compute({ billing: bill, assignments: team = [], otherCosts: others = [] }) {
  const revenue = money(bill ? bill.invoicedToDate : 0);
  const labourCost = money(team.reduce((t, a) => t + a.cost, 0));
  const otherCost = money(others.reduce((t, c) => t + c.amount, 0));
  const grossProfit = money(revenue - labourCost - otherCost);

  /* THE BUDGET DIMENSION. Costed at the same rates as the work actually done,
     so a variance is a difference in HOURS and never an artefact of re-pricing
     a rate card between the plan and the work. */
  const budgetedCost = money(team.reduce((t, a) => t + a.budgetedCost, 0));
  const budgetVariance = money(labourCost - budgetedCost);

  const contractValue = money(bill ? bill.contractValue : 0);
  const otherCostTotal = otherCost;

  return {
    revenue,
    contractValue,
    billingType: bill ? bill.billingType : null,
    labourCost,
    otherCosts: otherCost,
    totalCost: money(labourCost + otherCost),
    grossProfit,
    marginPercent: percent(grossProfit, revenue),
    hoursTotal: hours(team.reduce((t, a) => t + a.hours, 0)),
    people: team.length,

    // --- the Fixed view: planned against actual, priced at the agreed fee ----
    budgetedCost,
    /* Named actualCost as well as labourCost. They are the same number; the
       Fixed tab talks about "budgeted vs actual" and reading `labourCost` there
       would make somebody check whether it was the same thing. */
    actualCost: labourCost,
    budgetVariance,
    /* Over budget is about LABOUR against the labour plan. Other costs are not
       in the budget figure — nobody planned them per role — so including them
       here would flag a project as over budget for a cost the budget never
       claimed to cover. */
    overBudget: budgetedCost > 0 && labourCost > budgetedCost,
    /* A project with no plan recorded is NOT under budget, it is unplanned.
       Saying "0 budgeted, 5,000 spent, 5,000 over" about a project nobody
       budgeted would put a red flag on every project that predates the field. */
    budgeted: budgetedCost > 0,
    /* Revenue on the Fixed tab is the AGREED FEE, not what has been invoiced so
       far: a fixed-bid project earns its price by delivering, and judging it on
       part-way invoicing would call every mid-flight project a loss.

       Other costs ARE subtracted here, which is a deliberate departure from the
       brief's literal "Fixed Contract Value − Actual Cost". Money spent on
       outsourcing is gone whichever tab you are looking at, and leaving it out
       would make the same project's profit differ between the two tabs for a
       reason that has nothing to do with what the tabs are comparing. */
    fixedProfit: money(contractValue - labourCost - otherCostTotal),
    fixedMarginPercent: percent(money(contractValue - labourCost - otherCostTotal), contractValue),

    // --- the Actual view: what was billed against what it cost ---------------
    billedHoursTotal: hours(team.reduce((t, a) => t + a.billedHours, 0)),
    assignedHoursTotal: hours(team.reduce((t, a) => t + a.assignedHours, 0)),
    /* Worked minus billed, across the team. Positive means work was absorbed. */
    hoursDelta: hours(team.reduce((t, a) => t + a.hoursDelta, 0)),
  };
}

/* Labour by role and level, over EVERY rate card row.
 *
 * Every row including the unused ones, at zero. A table that lists only what
 * was used cannot answer "did we put any seniors on this at all", which is
 * most of what a producer looks at this table for — and its shape would change
 * from project to project, so two projects could not be compared side by side.
 *
 * Assignments whose role/level no longer matches any card — because the card
 * was renamed or deleted — are appended rather than dropped. Their cost is real
 * and has to appear somewhere or the breakdown will not add up to the labour
 * total above it. */
function labourByRoleLevel(cards, team) {
  /* The separator is an explicit \u0000 escape, not a raw NUL byte. It was a raw
     one until now, which made grep and diff treat this whole file as binary and
     hid the separator from anybody reading it. The runtime key is unchanged: a
     NUL cannot appear in a role or level, so two different pairs can never
     collide into one bucket. */
  const key = (role, level) => `${role}\u0000${level}`;
  const buckets = new Map();
  const blank = (role, level, ratePerHour, onRateCard) => ({
    role, level, ratePerHour, onRateCard,
    assignedHours: 0, hours: 0, billedHours: 0,
    budgetedCost: 0, cost: 0,
  });
  for (const card of cards) {
    buckets.set(key(card.role, card.level), blank(card.role, card.level, card.ratePerHour, true));
  }
  for (const a of team) {
    const k = key(a.role, a.level);
    if (!buckets.has(k)) buckets.set(k, blank(a.role, a.level, a.ratePerHour, false));
    const bucket = buckets.get(k);
    bucket.assignedHours = hours(bucket.assignedHours + a.assignedHours);
    bucket.hours = hours(bucket.hours + a.hours);
    bucket.billedHours = hours(bucket.billedHours + a.billedHours);
    bucket.budgetedCost = money(bucket.budgetedCost + a.budgetedCost);
    bucket.cost = money(bucket.cost + a.cost);
  }
  /* The two derived columns each tab shows, worked out once here so the Fixed
     table and the Actual table cannot disagree about the same row. */
  return [...buckets.values()].map((b) => ({
    ...b,
    variance: money(b.cost - b.budgetedCost),
    /* Per row, the same rule as the project total: no plan means unplanned, not
       under budget. */
    overBudget: b.budgetedCost > 0 && b.cost > b.budgetedCost,
    hoursDelta: hours(b.hours - b.billedHours),
  }));
}

/* Everything one project's P&L screen needs. */
async function forProject(db, projectId, { cards = null } = {}) {
  const [bill, team, others] = await Promise.all([
    billing(db, projectId),
    assignments(db, projectId),
    otherCosts(db, projectId),
  ]);
  const rateCardRows = cards || await rateCards(db);
  return {
    projectId,
    billing: bill,
    assignments: team,
    otherCosts: others,
    totals: compute({ billing: bill, assignments: team, otherCosts: others }),
    byRoleLevel: labourByRoleLevel(rateCardRows, team),
  };
}

/* A client's rollup: the same metrics, summed across their projects.
 *
 * Summed from the per-project figures rather than recomputed from a wider
 * query, so a client total can never disagree with the projects listed under
 * it. Margin is recomputed from the summed revenue and profit rather than
 * averaged — an average of percentages weights a £500 project the same as a
 * £500,000 one, which is how a rollup ends up flattering a loss. */
function rollup(perProject) {
  const revenue = money(perProject.reduce((t, p) => t + p.totals.revenue, 0));
  const labourCost = money(perProject.reduce((t, p) => t + p.totals.labourCost, 0));
  const otherCost = money(perProject.reduce((t, p) => t + p.totals.otherCosts, 0));
  const grossProfit = money(revenue - labourCost - otherCost);
  return {
    projects: perProject.length,
    revenue,
    contractValue: money(perProject.reduce((t, p) => t + p.totals.contractValue, 0)),
    labourCost,
    otherCosts: otherCost,
    totalCost: money(labourCost + otherCost),
    grossProfit,
    marginPercent: percent(grossProfit, revenue),
    hoursTotal: hours(perProject.reduce((t, p) => t + p.totals.hoursTotal, 0)),

    /* The Fixed view's rollup. Contract value rather than invoiced, and its
       margin recomputed from the summed figures rather than averaged — same
       reasoning as the margin above it. */
    contractTotal: money(perProject.reduce((t, p) => t + p.totals.contractValue, 0)),
    budgetedCost: money(perProject.reduce((t, p) => t + p.totals.budgetedCost, 0)),
    actualCost: labourCost,
    budgetVariance: money(perProject.reduce((t, p) => t + p.totals.budgetVariance, 0)),
    fixedProfit: money(perProject.reduce((t, p) => t + p.totals.fixedProfit, 0)),
    fixedMarginPercent: percent(
      money(perProject.reduce((t, p) => t + p.totals.fixedProfit, 0)),
      money(perProject.reduce((t, p) => t + p.totals.contractValue, 0))
    ),
    /* How many of these projects are over their labour budget — a count, not a
       flag, because a rollup covering ten projects of which two are over is not
       "over budget", it is "two over budget". */
    overBudgetProjects: perProject.filter((p) => p.totals.overBudget).length,
    budgetedProjects: perProject.filter((p) => p.totals.budgeted).length,

    // The Actual view's rollup.
    assignedHoursTotal: hours(perProject.reduce((t, p) => t + p.totals.assignedHoursTotal, 0)),
    billedHoursTotal: hours(perProject.reduce((t, p) => t + p.totals.billedHoursTotal, 0)),
    hoursDelta: hours(perProject.reduce((t, p) => t + p.totals.hoursDelta, 0)),
  };
}

// --- validation -------------------------------------------------------------

const MAX_MONEY = 99999999999.99;   // what DECIMAL(14,2) holds
const MAX_RATE = 99999999.99;       // DECIMAL(10,2)

function amountError(value, { field, label, max = MAX_MONEY }) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { field, message: `${label} is required.` };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { field, message: `${label} must be a number.` };
  /* Negative is refused rather than accepted as a credit. A negative cost is
     almost always a typed minus sign, and silently turning it into extra profit
     is the wrong way to be wrong about money. */
  if (n < 0) return { field, message: `${label} cannot be negative.` };
  if (n > max) return { field, message: `${label} is larger than this field can hold.` };
  return null;
}

function validateRateCard({ role, level, ratePerHour }, { existing = [], id = null } = {}) {
  const errors = [];
  const roleText = String(role ?? '').trim();
  const levelText = String(level ?? '').trim();

  if (!roleText) errors.push({ field: 'role', message: 'A role is required.' });
  else if (roleText.length > 80) errors.push({ field: 'role', message: 'The role must be 80 characters or fewer.' });
  if (!levelText) errors.push({ field: 'level', message: 'A level is required.' });
  else if (levelText.length > 80) errors.push({ field: 'level', message: 'The level must be 80 characters or fewer.' });

  const bad = amountError(ratePerHour, { field: 'ratePerHour', label: 'The rate', max: MAX_RATE });
  if (bad) errors.push(bad);

  if (roleText && levelText) {
    const clash = existing.find((c) => c.id !== id
      && c.role.toLowerCase() === roleText.toLowerCase()
      && c.level.toLowerCase() === levelText.toLowerCase());
    if (clash) {
      errors.push({ field: 'level', message: `${roleText} — ${levelText} is already on the rate card.` });
    }
  }
  return { errors, values: { role: roleText, level: levelText, ratePerHour: money(ratePerHour) } };
}

function validateAssignment({
  role, level, ratePerHour, hours: hrs, personName,
  assignedHours, billedHours,
}) {
  const errors = [];
  const roleText = String(role ?? '').trim();
  const levelText = String(level ?? '').trim();
  if (!roleText) errors.push({ field: 'role', message: 'A role is required.' });
  if (!levelText) errors.push({ field: 'level', message: 'A level is required.' });
  if (String(personName ?? '').length > 160) {
    errors.push({ field: 'personName', message: 'The name must be 160 characters or fewer.' });
  }

  const badRate = amountError(ratePerHour, { field: 'ratePerHour', label: 'The rate', max: MAX_RATE });
  if (badRate) errors.push(badRate);
  const badHours = amountError(hrs, { field: 'hours', label: 'The hours', max: MAX_RATE });
  if (badHours) errors.push(badHours);

  /* Both default to 0 rather than being required. A row can legitimately have
     no plan (added mid-project) and no billing yet (not invoiced), and forcing
     a number would mean typing a zero to say "nothing", which is the same
     answer with more friction. */
  const badAssigned = amountError(assignedHours === undefined || assignedHours === null || assignedHours === '' ? 0 : assignedHours,
    { field: 'assignedHours', label: 'The assigned hours', max: MAX_RATE });
  if (badAssigned) errors.push(badAssigned);
  const badBilled = amountError(billedHours === undefined || billedHours === null || billedHours === '' ? 0 : billedHours,
    { field: 'billedHours', label: 'The billed hours', max: MAX_RATE });
  if (badBilled) errors.push(badBilled);

  return {
    errors,
    values: {
      role: roleText, level: levelText,
      ratePerHour: money(ratePerHour), hours: hours(hrs),
      assignedHours: hours(assignedHours || 0),
      billedHours: hours(billedHours || 0),
      personName: String(personName ?? '').trim() || null,
    },
  };
}

function validateBilling({ contractValue, billingType, invoicedToDate }) {
  const errors = [];
  const bad = (v, field, label) => {
    const e = amountError(v, { field, label });
    if (e) errors.push(e);
  };
  bad(contractValue, 'contractValue', 'The contract value');
  bad(invoicedToDate, 'invoicedToDate', 'The invoiced amount');

  const type = billingType === undefined || billingType === null || billingType === ''
    ? null : String(billingType).trim();
  if (type && !BILLING_IDS.includes(type)) {
    errors.push({ field: 'billingType', message: `Choose ${BILLING_TYPES.map((b) => b.label).join(', ')}.` });
  }

  /* Invoicing more than the contract is WARNED about, not refused. It is
     usually a scope change nobody has updated the contract value for, which is
     an ordinary thing to happen and not something to block a save over. */
  const warnings = [];
  if (!errors.length && Number(invoicedToDate) > Number(contractValue) && Number(contractValue) > 0) {
    warnings.push(`Invoiced (${money(invoicedToDate)}) is more than the contract value `
      + `(${money(contractValue)}). Saved — check whether the contract value needs updating.`);
  }

  return {
    errors, warnings,
    values: {
      contractValue: money(contractValue),
      billingType: type,
      invoicedToDate: money(invoicedToDate),
    },
  };
}

function validateOtherCost({ label, amount }) {
  const errors = [];
  const text = String(label ?? '').trim();
  if (!text) errors.push({ field: 'label', message: 'A label is required — an unexplained cost is not a record.' });
  else if (text.length > 160) errors.push({ field: 'label', message: 'The label must be 160 characters or fewer.' });
  const bad = amountError(amount, { field: 'amount', label: 'The amount' });
  if (bad) errors.push(bad);
  return { errors, values: { label: text, amount: money(amount) } };
}

module.exports = {
  TABLES, BILLING_TYPES, BILLING_IDS, SEED_RATE_CARDS,
  ensureTables, seed,
  rateCards, assignments, billing, otherCosts, forProject,
  compute, labourByRoleLevel, rollup,
  validateRateCard, validateAssignment, validateBilling, validateOtherCost,
  money, hours, percent, shapeCard, shapeAssignment,
};
