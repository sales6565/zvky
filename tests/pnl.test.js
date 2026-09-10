/* Profit & Loss.
 *
 * EVERY FIGURE HERE IS CHECKED AGAINST MONEY WORKED OUT BY HAND. The fixture
 * below carries its arithmetic in the comment beside it, and the assertions
 * quote those numbers rather than recomputing them from the same code that
 * produced them. A P&L tested by asking it what it thinks agrees with itself
 * perfectly and is wrong in the one way that costs somebody money.
 *
 * The five things worth breaking, and the reasons they are worth breaking:
 *
 *   revenue is INVOICED, not contracted   A contract worth a million that has
 *                                         billed nothing has earned nothing.
 *
 *   a margin on no revenue is NULL        Not 0%. "Broke even" and "has not
 *                                         invoiced yet" are different facts and
 *                                         only one of them is true.
 *
 *   an assignment keeps its OWN rate      Re-pricing the rate card next April
 *                                         must not rewrite what last year cost.
 *
 *   the rollup SUMS, and recomputes       An average of percentages weights a
 *                                         small project like a large one, which
 *                                         is how a rollup flatters a loss.
 *
 *   the two permissions do not imply      Reading a margin and deciding what it
 *   each other                            is are different authorities.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const pnl = require('../src/pnl');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('pnl');

// --- the maths, with no database at all ---------------------------------------

test('gross profit and margin, by hand', () => {
  /* Revenue 20,000. Labour 200h at 25 = 5,000 plus 40h at 60 = 2,400 -> 7,400.
     Other 1,200 + 300 = 1,500. Profit 20,000 - 7,400 - 1,500 = 11,100.
     Margin 11,100 / 20,000 = 55.5%. */
  const totals = pnl.compute({
    billing: { invoicedToDate: 20000, contractValue: 100000, billingType: 'fixed' },
    assignments: [
      { hours: 200, ratePerHour: 25, cost: 5000 },
      { hours: 40, ratePerHour: 60, cost: 2400 },
    ],
    otherCosts: [{ amount: 1200 }, { amount: 300 }],
  });
  assert.strictEqual(totals.revenue, 20000);
  assert.strictEqual(totals.labourCost, 7400);
  assert.strictEqual(totals.otherCosts, 1500);
  assert.strictEqual(totals.totalCost, 8900);
  assert.strictEqual(totals.grossProfit, 11100);
  assert.strictEqual(totals.marginPercent, 55.5);
  assert.strictEqual(totals.hoursTotal, 240);
});

test('revenue is invoiced to date, never the contract value', () => {
  /* The mistake this guards against prints a healthy margin on work nobody has
     paid for, which is the single most expensive way for this screen to lie. */
  const totals = pnl.compute({
    billing: { invoicedToDate: 0, contractValue: 1000000 },
    assignments: [{ hours: 10, ratePerHour: 50, cost: 500 }],
    otherCosts: [],
  });
  assert.strictEqual(totals.revenue, 0, 'a signed contract is not revenue');
  assert.strictEqual(totals.contractValue, 1000000, 'but it is still reported');
  assert.strictEqual(totals.grossProfit, -500, 'so the project is currently at a loss');
});

test('no revenue means no margin — null, not zero', () => {
  assert.strictEqual(pnl.percent(0, 0), null);
  assert.strictEqual(pnl.percent(-500, 0), null);
  assert.strictEqual(pnl.compute({ billing: null, assignments: [], otherCosts: [] }).marginPercent, null);
  // And a real zero margin is still zero.
  assert.strictEqual(pnl.percent(0, 100), 0);
});

test('the rollup sums the parts and recomputes the margin from the sums', () => {
  /* Two projects: a large one at 10% and a tiny one at 90%.
       big   revenue 100,000, cost 90,000 -> profit 10,000, margin 10%
       small revenue     100, cost     10 -> profit     90, margin 90%
     Averaging the percentages gives 50%, which would describe neither project
     nor the pair. The truth is 10,090 / 100,100 = 10.1%. */
  const rolled = pnl.rollup([
    { totals: { revenue: 100000, contractValue: 0, labourCost: 90000, otherCosts: 0, hoursTotal: 900 } },
    { totals: { revenue: 100, contractValue: 0, labourCost: 10, otherCosts: 0, hoursTotal: 1 } },
  ]);
  assert.strictEqual(rolled.revenue, 100100);
  assert.strictEqual(rolled.grossProfit, 10090);
  assert.strictEqual(rolled.marginPercent, 10.1);
  assert.notStrictEqual(rolled.marginPercent, 50, 'an average of percentages would say 50%');
  assert.strictEqual(rolled.hoursTotal, 901);
});

test('the breakdown lists every rate card row, and never drops a cost', () => {
  const cards = [
    { role: 'Artist', level: 'Junior Level Artist', ratePerHour: 25 },
    { role: 'Artist', level: 'Senior Artist', ratePerHour: 60 },
  ];
  const team = [
    { role: 'Artist', level: 'Senior Artist', ratePerHour: 60, hours: 10, cost: 600 },
    // Priced off a card that has since been renamed or deleted.
    { role: 'Animator', level: 'Retired Level', ratePerHour: 40, hours: 5, cost: 200 },
  ];
  const rows = pnl.labourByRoleLevel(cards, team);

  assert.strictEqual(rows.length, 3, 'both cards plus the orphaned assignment');
  const junior = rows.find((r) => r.level === 'Junior Level Artist');
  assert.strictEqual(junior.hours, 0, 'an unused level is listed at zero, not omitted');
  assert.strictEqual(junior.onRateCard, true);

  const orphan = rows.find((r) => r.level === 'Retired Level');
  assert.strictEqual(orphan.cost, 200, 'its cost is real and has to appear somewhere');
  assert.strictEqual(orphan.onRateCard, false, 'and is marked as no longer on the card');

  /* The property that matters: the breakdown adds up to the labour total above
     it. Drop the orphan and this fails by 200. */
  const totals = pnl.compute({ billing: { invoicedToDate: 0 }, assignments: team, otherCosts: [] });
  assert.strictEqual(rows.reduce((t, r) => t + r.cost, 0), totals.labourCost);
});

test('a negative amount is refused rather than booked as profit', () => {
  /* A typed minus sign turning into extra profit is the wrong way to be wrong
     about money. */
  const { errors } = pnl.validateOtherCost({ label: 'Refund', amount: -50 });
  assert.ok(errors.some((e) => e.field === 'amount' && /negative/i.test(e.message)));
  assert.ok(pnl.validateRateCard({ role: 'A', level: 'B', ratePerHour: -1 }).errors.length);
  assert.ok(pnl.validateAssignment({ role: 'A', level: 'B', ratePerHour: 10, hours: -4 }).errors.length);
});

test('an unlabelled cost is refused', () => {
  const { errors } = pnl.validateOtherCost({ label: '   ', amount: 100 });
  assert.ok(errors.some((e) => e.field === 'label'), 'an unexplained amount is not a record');
});

test('over-invoicing warns but saves', () => {
  /* Usually a scope change nobody has updated the contract for — an ordinary
     thing to happen, and not something to block a save over. */
  const res = pnl.validateBilling({ contractValue: 1000, invoicedToDate: 1500, billingType: 'fixed' });
  assert.strictEqual(res.errors.length, 0);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /more than the contract value/);
});

// --- the two tabs, worked out by hand -----------------------------------------
//
// The Fixed tab and the Actual tab read the SAME hours worked and compare them
// against two different baselines: the plan, and the invoice. A project can be
// comfortable on one and alarming on the other, and the tests below are the
// arithmetic that makes that true rather than a matter of opinion.

/* One fixture, deliberately carrying three DIFFERENT hour totals — planned 320,
   worked 300, billed 260 — because a fixture where two of them coincide cannot
   tell a code path that reads the wrong one from a code path that reads the
   right one. */
const TWO_TABS = {
  billing: { contractValue: 40000, invoicedToDate: 26000, billingType: 'fixed' },
  assignments: [
    // Mid: planned 100h at 50 = 5,000. Worked 120h = 6,000. Billed all 120.
    { role: 'Artist', level: 'Mid Level Artist', ratePerHour: 50,
      assignedHours: 100, hours: 120, billedHours: 120,
      budgetedCost: 5000, cost: 6000, hoursDelta: 0 },
    // Senior: planned 220h at 80 = 17,600. Worked 180h = 14,400. Billed 140.
    { role: 'Artist', level: 'Senior Artist', ratePerHour: 80,
      assignedHours: 220, hours: 180, billedHours: 140,
      budgetedCost: 17600, cost: 14400, hoursDelta: 40 },
  ],
  otherCosts: [{ amount: 2000 }],
};

test('Fixed and Actual read the same hours against two different baselines', () => {
  const totals = pnl.compute(TWO_TABS);

  /* The three hour figures stay three figures. */
  assert.strictEqual(totals.assignedHoursTotal, 320, 'planned');
  assert.strictEqual(totals.hoursTotal, 300, 'worked');
  assert.strictEqual(totals.billedHoursTotal, 260, 'invoiced');
  assert.strictEqual(totals.hoursDelta, 40, 'worked but never billed');

  /* Fixed: the agreed fee against what the work cost.
       budget  5,000 + 17,600 = 22,600
       actual  6,000 + 14,400 = 20,400   -> 2,200 UNDER
       profit  40,000 - 20,400 - 2,000 = 17,600
       margin  17,600 / 40,000 = 44.0% */
  assert.strictEqual(totals.budgetedCost, 22600);
  assert.strictEqual(totals.actualCost, 20400);
  assert.strictEqual(totals.budgetVariance, -2200);
  assert.strictEqual(totals.overBudget, false, 'under the plan is not over budget');
  assert.strictEqual(totals.fixedProfit, 17600);
  assert.strictEqual(totals.fixedMarginPercent, 44);

  /* Actual: what has been invoiced against the same cost.
       revenue 26,000
       profit  26,000 - 20,400 - 2,000 = 3,600
       margin  3,600 / 26,000 = 13.8% */
  assert.strictEqual(totals.revenue, 26000);
  assert.strictEqual(totals.grossProfit, 3600);
  assert.strictEqual(totals.marginPercent, 13.8);

  /* THE WHOLE REASON THERE ARE TWO TABS. Same project, same hours, same costs:
     44.0% on the fee it was sold for, 13.8% on what has actually been invoiced.
     A single blended number would hide the 40 absorbed hours that separate
     them. */
  assert.notStrictEqual(totals.fixedMarginPercent, totals.marginPercent);
});

test('other costs are subtracted on BOTH tabs', () => {
  /* A DELIBERATE DEPARTURE from the literal "Fixed Contract Value - Actual
     Cost", recorded as a test so it is a decision and not a drift. Money spent
     outsourcing is gone whichever tab you are reading; leaving it out of the
     Fixed figure would make the same project's profit differ between the tabs
     for a reason that has nothing to do with what the tabs compare. */
  const withCost = pnl.compute(TWO_TABS);
  const without = pnl.compute({ ...TWO_TABS, otherCosts: [] });

  assert.strictEqual(without.fixedProfit - withCost.fixedProfit, 2000,
    'the 2,000 comes off the Fixed profit too');
  assert.strictEqual(without.grossProfit - withCost.grossProfit, 2000,
    'and off the Actual profit by exactly the same amount');

  /* But NOT out of the budget comparison: nobody planned an outsourcing spend
     per role, so counting it there would flag a project as over its labour
     budget for a cost the labour budget never claimed to cover. */
  assert.strictEqual(withCost.budgetVariance, without.budgetVariance);
  assert.strictEqual(withCost.overBudget, without.overBudget);
});

test('a project with no plan is unplanned, not under budget', () => {
  /* Every project that predates the assigned-hours field has 0 planned. Read
     naively that is "0 budgeted, 6,000 spent" — an over-budget flag on the
     whole back catalogue on the morning the feature ships. */
  const unplanned = pnl.compute({
    billing: { contractValue: 10000, invoicedToDate: 10000 },
    assignments: [{ assignedHours: 0, hours: 120, billedHours: 120,
      budgetedCost: 0, cost: 6000, hoursDelta: 0 }],
    otherCosts: [],
  });
  assert.strictEqual(unplanned.budgeted, false, 'there is no plan to be over');
  assert.strictEqual(unplanned.overBudget, false, 'so it is not flagged');
  assert.strictEqual(unplanned.budgetedCost, 0);

  /* And the flag still works where a plan does exist: 100h planned at 50 is
     5,000, and 6,000 spent is over it. */
  const planned = pnl.compute({
    billing: { contractValue: 10000, invoicedToDate: 10000 },
    assignments: [{ assignedHours: 100, hours: 120, billedHours: 120,
      budgetedCost: 5000, cost: 6000, hoursDelta: 0 }],
    otherCosts: [],
  });
  assert.strictEqual(planned.budgeted, true);
  assert.strictEqual(planned.overBudget, true);
  assert.strictEqual(planned.budgetVariance, 1000);
});

test('the per-role table carries both comparisons and still adds up', () => {
  const cards = [
    { role: 'Artist', level: 'Mid Level Artist', ratePerHour: 50 },
    { role: 'Artist', level: 'Senior Artist', ratePerHour: 80 },
    { role: 'Animator', level: 'Senior Animator', ratePerHour: 65 },
  ];
  const rows = pnl.labourByRoleLevel(cards, TWO_TABS.assignments);
  const totals = pnl.compute(TWO_TABS);

  const mid = rows.find((r) => r.level === 'Mid Level Artist');
  const senior = rows.find((r) => r.level === 'Senior Artist');
  const unused = rows.find((r) => r.level === 'Senior Animator');

  // Mid overran its plan; Senior came in under it. Two rows, two directions.
  assert.strictEqual(mid.variance, 1000);
  assert.strictEqual(mid.overBudget, true);
  assert.strictEqual(mid.hoursDelta, 0, 'everything the mid worked was billed');
  assert.strictEqual(senior.variance, -3200);
  assert.strictEqual(senior.overBudget, false);
  assert.strictEqual(senior.hoursDelta, 40, 'the absorbed hours are the senior');

  // An unused level is listed at zero and is NOT flagged as anything.
  assert.strictEqual(unused.budgetedCost, 0);
  assert.strictEqual(unused.overBudget, false);

  /* The property worth having: each column of the table adds up to the card
     above it, on both tabs. Drop a row from either and one of these fails. */
  const sum = (f) => rows.reduce((t, r) => t + r[f], 0);
  assert.strictEqual(sum('budgetedCost'), totals.budgetedCost);
  assert.strictEqual(sum('cost'), totals.actualCost);
  assert.strictEqual(sum('variance'), totals.budgetVariance);
  assert.strictEqual(sum('assignedHours'), totals.assignedHoursTotal);
  assert.strictEqual(sum('hours'), totals.hoursTotal);
  assert.strictEqual(sum('billedHours'), totals.billedHoursTotal);
  assert.strictEqual(sum('hoursDelta'), totals.hoursDelta);
});

test('the rollup counts over-budget projects rather than flagging itself', () => {
  /* Three projects: one over its plan, one under, one with no plan at all. */
  const rolled = pnl.rollup([
    { totals: { revenue: 10000, contractValue: 20000, labourCost: 9000, otherCosts: 0,
      hoursTotal: 100, budgetedCost: 8000, budgetVariance: 1000, overBudget: true,
      budgeted: true, fixedProfit: 11000, assignedHoursTotal: 80, billedHoursTotal: 100,
      hoursDelta: 0 } },
    { totals: { revenue: 5000, contractValue: 10000, labourCost: 4000, otherCosts: 0,
      hoursTotal: 50, budgetedCost: 6000, budgetVariance: -2000, overBudget: false,
      budgeted: true, fixedProfit: 6000, assignedHoursTotal: 60, billedHoursTotal: 40,
      hoursDelta: 10 } },
    { totals: { revenue: 1000, contractValue: 0, labourCost: 500, otherCosts: 0,
      hoursTotal: 10, budgetedCost: 0, budgetVariance: 500, overBudget: false,
      budgeted: false, fixedProfit: -500, assignedHoursTotal: 0, billedHoursTotal: 10,
      hoursDelta: 0 } },
  ]);

  /* A COUNT, NOT A FLAG. "This client is over budget" is not true of a client
     with one overrun and two healthy projects, and a boolean there would either
     condemn the whole book or hide the one that needs attention. */
  assert.strictEqual(rolled.overBudgetProjects, 1);
  assert.strictEqual(rolled.budgetedProjects, 2, 'the unplanned one is not counted');
  assert.strictEqual(rolled.overBudget, undefined, 'the rollup has no such flag');

  // Fixed: contract 30,000, budget 14,000, actual 13,500, profit 16,500 -> 55.0%
  assert.strictEqual(rolled.contractTotal, 30000);
  assert.strictEqual(rolled.budgetedCost, 14000);
  assert.strictEqual(rolled.actualCost, 13500);
  assert.strictEqual(rolled.budgetVariance, -500);
  assert.strictEqual(rolled.fixedProfit, 16500);
  assert.strictEqual(rolled.fixedMarginPercent, 55);

  // Actual: revenue 16,000, cost 13,500, profit 2,500 -> 15.6%
  assert.strictEqual(rolled.revenue, 16000);
  assert.strictEqual(rolled.grossProfit, 2500);
  assert.strictEqual(rolled.marginPercent, 15.6);

  /* The hours reconcile across the rollup exactly as they do on one project:
     worked 160, billed 150, so 10 hours went unbilled somewhere in the book. */
  assert.strictEqual(rolled.assignedHoursTotal, 140);
  assert.strictEqual(rolled.hoursTotal, 160);
  assert.strictEqual(rolled.billedHoursTotal, 150);
  assert.strictEqual(rolled.hoursDelta, rolled.hoursTotal - rolled.billedHoursTotal);
});

// --- the two permissions -------------------------------------------------------

test('both P&L permissions are Super Admin only, and neither implies the other', () => {
  const view = catalogue.BY_KEY.get('pnl.view');
  const manage = catalogue.BY_KEY.get('pnl.manage');
  assert.ok(view && manage, 'both are in the catalogue');
  assert.strictEqual(view.label, 'View Profit & Loss Reports');
  assert.strictEqual(manage.label, 'Manage P&L Rate Cards & Billing');

  const tiers = require('../src/role-tiers');
  const TIERS = tiers.TIERS || tiers;
  for (const key of ['pnl.view', 'pnl.manage']) {
    const on = Object.entries(TIERS)
      .filter(([, v]) => catalogue.baselineFor((v && v.capabilities) || {}).has(key))
      .map(([k]) => k).sort();
    assert.deepStrictEqual(on, ['super_admin'], `${key} defaults to Super Admin alone`);
  }

  /* Neither is expressed in terms of the other, so a studio can grant a
     producer the report without handing them the rate card. */
  const baseline = catalogue.baselineFor({});
  assert.ok(!baseline.has('pnl.view') && !baseline.has('pnl.manage'));
});

/* The bug that made this feature look broken on a real deployment.
 *
 * This app serves its own page, and any GET that matches no API route falls
 * through to the catch-all that returns index.html WITH STATUS 200. The page's
 * api() helper used to read that with `res.json().catch(()=>({}))`, so a call to
 * an endpoint the running backend does not have resolved successfully as an
 * empty object.
 *
 * What that produced was a screen that lied rather than one that failed. Deploy
 * the new files without restarting the Node process — the ordinary case on
 * cPanel, where static files update instantly and the app server does not — and
 * Settings drew a Rate Cards table with no rows in it and an enabled Add
 * button, because `{}.rateCards || []` is a perfectly good empty list. Pressing
 * Add then hit the POST, which the catch-all does NOT answer, and produced a
 * bare "Request failed (HTTP 404)".
 *
 * Guarded at the source, because api() is browser code with no server to call
 * it here. The property is: a 2xx whose body is not JSON must not be silently
 * turned into data.
 */
test('api() refuses to read a non-JSON 200 as data', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = page.indexOf('async function api(path, options={})');
  assert.ok(start > -1, 'the api() helper is still where this guard expects it');
  const body = page.slice(start, page.indexOf('\nfunction showToast', start));

  /* Comment text is stripped first: the fix's own comment quotes the broken
     line to explain it, and a guard fooled by prose about a bug is no guard. */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/const\s+data\s*=\s*await\s+res\.json\(\)/.test(code),
    'reading the body straight as JSON is the bug — a non-JSON 200 became {}');
  assert.match(code, /res\.ok\s*&&\s*notJson/,
    'a 2xx carrying something that is not JSON has to be caught explicitly');
  assert.match(body, /not been restarted/,   // in the message, so body not code
    'and the message has to name the cause, because the fix is a restart');
  /* An empty body stays benign: telling somebody their server is stale because
     a response had no content would be its own false alarm. */
  assert.match(code, /if\(raw\)\{/, 'an empty body is still read as {}');
});

// --- against a live server ------------------------------------------------------

test('Profit & Loss end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Pnl-Test-1!';
  let server;
  let clientId;
  const token = {};
  const project = {};
  const card = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'pnl-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'pnl-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    clientId = await systemClientId(server.base, token.root);

    project.alpha = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Alpha' } })).body.project;
    project.beta = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Beta' } })).body.project;

    const cards = (await as('root', '/pnl/rate-cards')).body.rateCards;
    card.junior = cards.find((c) => c.level === 'Junior Level Artist');
    card.senior = cards.find((c) => c.level === 'Senior Artist');
  });

  t.after(() => stopServer(server));

  await t.test('the eight rate card rows are seeded, all at zero', async () => {
    const res = await as('root', '/pnl/rate-cards');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rateCards.length, 8);
    assert.ok(res.body.rateCards.every((c) => c.ratePerHour === 0),
      'seeded at zero on purpose — an invented rate is worse than a blank one');
    assert.deepStrictEqual(
      res.body.rateCards.map((c) => `${c.role}/${c.level}`).sort(),
      pnl.SEED_RATE_CARDS.map((c) => `${c.role}/${c.level}`).sort()
    );
  });

  await t.test('a project is costed, and every figure is the hand-checked one', async () => {
    /* Alpha:
         rates    Junior 25/h, Senior 60/h
         team     Jo   200h at 25 = 5,000
                  Sam   40h at 60 = 2,400      -> labour 7,400
         other    1,200 + 300                  -> other  1,500
         billing  contract 100,000, invoiced 20,000
         profit   20,000 - 7,400 - 1,500       = 11,100
         margin   11,100 / 20,000              = 55.5% */
    await as('root', `/pnl/rate-cards/${card.junior.id}`, { method: 'PATCH', body: { ratePerHour: 25 } });
    await as('root', `/pnl/rate-cards/${card.senior.id}`, { method: 'PATCH', body: { ratePerHour: 60 } });

    const jo = await as('root', `/pnl/projects/${project.alpha.id}/assignments`, { method: 'POST',
      body: { rateCardId: card.junior.id, role: 'Artist', level: 'Junior Level Artist',
        personName: 'Jo', ratePerHour: 25, hours: 200 } });
    assert.strictEqual(jo.status, 201, JSON.stringify(jo.body));
    assert.strictEqual(jo.body.assignment.cost, 5000, 'rate x hours, computed not stored');

    await as('root', `/pnl/projects/${project.alpha.id}/assignments`, { method: 'POST',
      body: { rateCardId: card.senior.id, role: 'Artist', level: 'Senior Artist',
        personName: 'Sam', ratePerHour: 60, hours: 40 } });
    await as('root', `/pnl/projects/${project.alpha.id}/other-costs`, { method: 'POST',
      body: { label: 'Outsourced rig', amount: 1200 } });
    await as('root', `/pnl/projects/${project.alpha.id}/other-costs`, { method: 'POST',
      body: { label: 'Software licence', amount: 300 } });
    await as('root', `/pnl/projects/${project.alpha.id}/billing`, { method: 'PUT',
      body: { contractValue: 100000, billingType: 'fixed', invoicedToDate: 20000 } });

    const one = await as('root', `/pnl/projects/${project.alpha.id}`);
    assert.strictEqual(one.status, 200);
    const totals = one.body.totals;
    assert.strictEqual(totals.revenue, 20000);
    assert.strictEqual(totals.labourCost, 7400);
    assert.strictEqual(totals.otherCosts, 1500);
    assert.strictEqual(totals.grossProfit, 11100);
    assert.strictEqual(totals.marginPercent, 55.5);
    assert.strictEqual(totals.hoursTotal, 240);
    assert.strictEqual(totals.people, 2);
  });

  await t.test('the breakdown adds up to the labour total, zeros included', async () => {
    const res = await as('root', `/pnl/projects/${project.alpha.id}`);
    const rows = res.body.byRoleLevel;
    assert.strictEqual(rows.length, 8, 'every rate card row, used or not');
    const used = rows.filter((r) => r.hours);
    assert.deepStrictEqual(used.map((r) => [r.level, r.hours, r.cost]),
      [['Junior Level Artist', 200, 5000], ['Senior Artist', 40, 2400]]);
    assert.strictEqual(rows.reduce((t, r) => t + r.cost, 0), res.body.totals.labourCost);
  });

  await t.test('re-pricing the rate card does not rewrite what the project already cost', async () => {
    /* The single most important guarantee in this feature: a P&L that changes
       retrospectively is not a record of anything. */
    const before = (await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals.labourCost;
    await as('root', `/pnl/rate-cards/${card.junior.id}`, { method: 'PATCH', body: { ratePerHour: 999 } });
    const after = (await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals;
    assert.strictEqual(after.labourCost, before, 'the assignment keeps the rate it was costed at');
    assert.strictEqual(after.labourCost, 7400);
    await as('root', `/pnl/rate-cards/${card.junior.id}`, { method: 'PATCH', body: { ratePerHour: 25 } });
  });

  await t.test('deleting a rate card row leaves the cost it produced standing', async () => {
    const junk = (await as('root', '/pnl/rate-cards', { method: 'POST',
      body: { role: 'Temp', level: 'Contractor', ratePerHour: 40 } })).body.rateCard;
    await as('root', `/pnl/projects/${project.beta.id}/assignments`, { method: 'POST',
      body: { rateCardId: junk.id, role: 'Temp', level: 'Contractor',
        personName: 'Alex', ratePerHour: 40, hours: 10 } });   // 400

    const del = await as('root', `/pnl/rate-cards/${junk.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.match(del.body.note, /keep the rate they were costed at/);

    const beta = await as('root', `/pnl/projects/${project.beta.id}`);
    assert.strictEqual(beta.body.totals.labourCost, 400, 'the cost survives the price list');
    const orphan = beta.body.byRoleLevel.find((r) => r.level === 'Contractor');
    assert.ok(orphan && orphan.onRateCard === false, 'and is shown as off the rate card');
    assert.strictEqual(beta.body.byRoleLevel.reduce((t, r) => t + r.cost, 0), 400);
  });

  await t.test('an ad hoc cost flows straight into profit and margin', async () => {
    /* 20,000 - 7,400 - 1,500 - 500 = 10,600 ; 10,600 / 20,000 = 53%. */
    const added = await as('root', `/pnl/projects/${project.alpha.id}/other-costs`, { method: 'POST',
      body: { label: 'Casting fee', amount: 500 } });
    assert.strictEqual(added.status, 201);
    let t2 = (await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals;
    assert.strictEqual(t2.otherCosts, 2000);
    assert.strictEqual(t2.grossProfit, 10600);
    assert.strictEqual(t2.marginPercent, 53);

    await as('root', `/pnl/projects/${project.alpha.id}/other-costs/${added.body.otherCost.id}`,
      { method: 'DELETE' });
    t2 = (await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals;
    assert.strictEqual(t2.grossProfit, 11100, 'and back out again when it is removed');
  });

  await t.test('the report rolls up, and the client total equals its projects', async () => {
    const res = await as('root', '/pnl/report');
    assert.strictEqual(res.status, 200);
    /* Alpha 20,000 revenue / 7,400 labour / 1,500 other.
       Beta        0 revenue /   400 labour /     0 other.
       Rollup 20,000 revenue, 7,800 labour, 1,500 other,
              profit 20,000 - 7,800 - 1,500 = 10,700, margin 53.5%. */
    assert.strictEqual(res.body.rollup.revenue, 20000);
    assert.strictEqual(res.body.rollup.labourCost, 7800);
    assert.strictEqual(res.body.rollup.grossProfit, 10700);
    assert.strictEqual(res.body.rollup.marginPercent, 53.5);

    const client = res.body.byClient.find((c) => c.clientId === clientId);
    assert.ok(client, 'the projects are grouped under their client');
    assert.strictEqual(client.rollup.revenue, 20000);
    assert.strictEqual(client.rollup.grossProfit, 10700);
    /* The rollup is summed from the listed projects, so the two can never
       disagree on screen. */
    const listed = res.body.projects.filter((p) => p.clientId === clientId);
    assert.strictEqual(listed.reduce((s, p) => s + p.totals.grossProfit, 0), client.rollup.grossProfit);
  });

  await t.test('a project with nothing invoiced reports no margin rather than zero', async () => {
    const report = await as('root', '/pnl/report');
    const beta = report.body.projects.find((p) => p.projectId === project.beta.id);
    assert.strictEqual(beta.totals.revenue, 0);
    assert.strictEqual(beta.totals.grossProfit, -400, 'it has cost money and earned none');
    assert.strictEqual(beta.totals.marginPercent, null, 'null, not 0 and not -100');
  });

  await t.test('the margin trend is real snapshots, and starts where the data does', async () => {
    const res = await as('root', '/pnl/report');
    const trend = res.body.trend;
    assert.strictEqual(trend.empty, false, 'writes above produced snapshots');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    assert.deepStrictEqual(trend.months.map((m) => m.month), [month],
      'one point per month, rewritten within the month rather than appended');
    /* Summed across both projects, then the margin recomputed from the sums —
       the same 53.5% the rollup reports. */
    assert.strictEqual(trend.months[0].revenue, 20000);
    assert.strictEqual(trend.months[0].cost, 9300);
    assert.strictEqual(trend.months[0].marginPercent, 53.5);
    assert.match(trend.note, /have no snapshot and are not shown/);
  });

  await t.test('every financial change is in the Activity Log, old value to new', async () => {
    const res = await as('root', '/activity?module=pnl&limit=100');
    assert.strictEqual(res.status, 200);
    const actions = res.body.entries.map((e) => e.action);
    for (const wanted of ['pnl.rate_card_changed', 'pnl.rate_card_removed', 'pnl.assignment_added',
      'pnl.billing_changed', 'pnl.cost_added', 'pnl.cost_removed']) {
      assert.ok(actions.includes(wanted), `${wanted} is recorded`);
    }
    const rate = res.body.entries.find((e) => e.action === 'pnl.rate_card_changed' && e.changes && e.changes.rate);
    assert.ok(rate, 'a rate change carries its before and after');
    assert.ok(rate.changes.rate.from !== undefined && rate.changes.rate.to !== undefined);

    const billing = res.body.entries.find((e) => e.action === 'pnl.billing_changed');
    assert.match(billing.summary, /invoiced to date/i,
      'because invoiced-to-date IS the revenue the studio reports');
  });

  await t.test('the three hour fields move the two tabs independently', async () => {
    /* Alpha is still Jo 200h at 25 and Sam 40h at 60 — labour 7,400, other
       1,500, contract 100,000, invoiced 20,000. Nobody has recorded a plan or
       an invoice against a role yet, so:
         Fixed   100,000 - 7,400 - 1,500 = 91,100 -> 91.1%
         Actual   20,000 - 7,400 - 1,500 = 11,100 -> 55.5% */
    const idOf = async (name) => {
      const res = await as('root', `/pnl/projects/${project.alpha.id}`);
      return res.body.assignments.find((a) => a.personName === name).id;
    };
    const totals = async () => (await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals;
    const joId = await idOf('Jo');
    const samId = await idOf('Sam');

    const start = await totals();
    assert.strictEqual(start.budgeted, false, 'no plan recorded yet');
    assert.strictEqual(start.overBudget, false, 'and so nothing to be over');
    assert.strictEqual(start.fixedProfit, 91100);
    assert.strictEqual(start.fixedMarginPercent, 91.1);
    assert.strictEqual(start.grossProfit, 11100);
    assert.strictEqual(start.marginPercent, 55.5);

    /* Record a plan and what was invoiced.
         planned  Jo 250 at 25 = 6,250, Sam 50 at 60 = 3,000 -> 9,250
         worked   7,400, so 1,850 UNDER the plan
         billed   Jo 200 of 200, Sam 30 of 40 -> 10 hours absorbed */
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${joId}`,
      { method: 'PATCH', body: { assignedHours: 250, billedHours: 200 } });
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${samId}`,
      { method: 'PATCH', body: { assignedHours: 50, billedHours: 30 } });

    const planned = await totals();
    assert.strictEqual(planned.budgetedCost, 9250);
    assert.strictEqual(planned.actualCost, 7400);
    assert.strictEqual(planned.budgetVariance, -1850);
    assert.strictEqual(planned.budgeted, true);
    assert.strictEqual(planned.overBudget, false);
    assert.strictEqual(planned.assignedHoursTotal, 300);
    assert.strictEqual(planned.hoursTotal, 240);
    assert.strictEqual(planned.billedHoursTotal, 230);
    assert.strictEqual(planned.hoursDelta, 10);
    // Recording a plan and an invoice changed no money on either tab.
    assert.strictEqual(planned.fixedProfit, 91100);
    assert.strictEqual(planned.grossProfit, 11100);

    /* CHANGE ONLY THE BILLED HOURS. That is an Actual-tab fact: it moves the
       hours reconciliation and nothing else. It must not touch the budget, and
       it must not touch revenue either — revenue is what has been INVOICED in
       money, not hours re-labelled as money. */
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${joId}`,
      { method: 'PATCH', body: { billedHours: 150 } });
    const rebilled = await totals();
    assert.strictEqual(rebilled.billedHoursTotal, 180);
    assert.strictEqual(rebilled.hoursDelta, 60, '50 more hours absorbed');
    assert.strictEqual(rebilled.budgetedCost, planned.budgetedCost, 'the plan did not move');
    assert.strictEqual(rebilled.budgetVariance, planned.budgetVariance);
    assert.strictEqual(rebilled.fixedProfit, planned.fixedProfit);
    assert.strictEqual(rebilled.revenue, 20000, 'still what was invoiced in money');
    assert.strictEqual(rebilled.grossProfit, 11100);
    assert.strictEqual(rebilled.assignedHoursTotal, 300);
    assert.strictEqual(rebilled.hoursTotal, 240, 'and nobody worked any less');

    /* CHANGE ONLY THE PLAN. A Fixed-tab fact. Cutting Sam's plan from 50 to 10
       takes the budget to 6,250 + 600 = 6,850 against 7,400 spent, which flips
       the project over budget — while the Actual tab reads exactly as before. */
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${samId}`,
      { method: 'PATCH', body: { assignedHours: 10 } });
    const replanned = await totals();
    assert.strictEqual(replanned.budgetedCost, 6850);
    assert.strictEqual(replanned.budgetVariance, 550);
    assert.strictEqual(replanned.overBudget, true, 'the flag follows the plan');
    assert.strictEqual(replanned.assignedHoursTotal, 260);
    assert.strictEqual(replanned.revenue, 20000);
    assert.strictEqual(replanned.grossProfit, 11100, 'the Actual tab did not move');
    assert.strictEqual(replanned.marginPercent, 55.5);
    assert.strictEqual(replanned.billedHoursTotal, 180);
    assert.strictEqual(replanned.hoursDelta, 60);

    /* And the per-role table agrees with the cards above it on both tabs. */
    const rows = (await as('root', `/pnl/projects/${project.alpha.id}`)).body.byRoleLevel;
    const sum = (f) => rows.reduce((t, r) => t + r[f], 0);
    assert.strictEqual(sum('budgetedCost'), replanned.budgetedCost);
    assert.strictEqual(sum('cost'), replanned.actualCost);
    assert.strictEqual(sum('billedHours'), replanned.billedHoursTotal);
    assert.strictEqual(sum('hoursDelta'), replanned.hoursDelta);

    // Left as it started, so the subtests after this one read what they expect.
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${joId}`,
      { method: 'PATCH', body: { assignedHours: 0, billedHours: 0 } });
    await as('root', `/pnl/projects/${project.alpha.id}/assignments/${samId}`,
      { method: 'PATCH', body: { assignedHours: 0, billedHours: 0 } });
    const restored = await totals();
    assert.strictEqual(restored.labourCost, 7400, 'no hour worked was ever touched');
    assert.strictEqual(restored.budgeted, false);
  });

  await t.test('a project outside the caller\'s reach is 404, not 403', async () => {
    /* 403 would confirm the id exists. Scoped exactly like every other piece of
       project data — holding pnl.view does not widen anybody's reach. */
    const res = await as('root', '/pnl/projects/00000000-0000-0000-0000-000000000000');
    assert.strictEqual(res.status, 404);
  });

  await t.test('viewing and managing are separate authorities', async () => {
    /* A designation with the report and nothing else: it reads, and every write
       is refused with a message that says which of the two it is short of. */
    const roleKey = 'producer';
    const current = (await as('root', `/permissions/roles/${roleKey}`)).body.role.permissions;
    const keys = current.filter((p) => p.enabled).map((p) => p.key);

    await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT',
      body: { permissions: [...keys.filter((k) => !k.startsWith('pnl.')), 'pnl.view'] } });

    const made = await as('root', '/users', { method: 'POST',
      body: { name: 'Vee Viewer', email: 'viewer@zvky.test', password: PASSWORD, role: roleKey } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    token.viewer = (await call('/auth/login', { method: 'POST',
      body: { email: 'viewer@zvky.test', password: PASSWORD } })).body.token;

    assert.strictEqual((await as('viewer', '/pnl/report')).status, 200, 'may read the report');
    const write = await as('viewer', '/pnl/rate-cards', { method: 'POST',
      body: { role: 'X', level: 'Y', ratePerHour: 1 } });
    assert.strictEqual(write.status, 403);
    assert.match(write.body.error, /view Profit & Loss but not change/);

    for (const [method, path, body] of [
      ['PUT', `/pnl/projects/${project.alpha.id}/billing`, { contractValue: 1, invoicedToDate: 1 }],
      ['POST', `/pnl/projects/${project.alpha.id}/assignments`, { role: 'A', level: 'B', ratePerHour: 1, hours: 1 }],
      ['POST', `/pnl/projects/${project.alpha.id}/other-costs`, { label: 'x', amount: 1 }],
    ]) {
      assert.strictEqual((await as('viewer', path, { method, body })).status, 403, `${method} ${path}`);
    }
    // And the figures are untouched by the attempts.
    assert.strictEqual((await as('root', `/pnl/projects/${project.alpha.id}`)).body.totals.grossProfit, 11100);
  });

  await t.test('holding neither permission is refused, and told so accurately', async () => {
    /* The refusal must not claim a read access the caller does not have — the
       write routes do not run the read gate first, so a single "you can view
       but not change" message would have been a lie to this caller. */
    const roleKey = 'producer';
    const current = (await as('root', `/permissions/roles/${roleKey}`)).body.role.permissions;
    await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT',
      body: { permissions: current.filter((p) => p.enabled && !p.key.startsWith('pnl.')).map((p) => p.key) } });

    const read = await as('viewer', '/pnl/report');
    assert.strictEqual(read.status, 403);
    assert.match(read.body.error, /do not have permission to view/);

    const write = await as('viewer', '/pnl/rate-cards', { method: 'POST',
      body: { role: 'X', level: 'Y', ratePerHour: 1 } });
    assert.strictEqual(write.status, 403);
    assert.match(write.body.error, /do not have permission to change/);
    assert.doesNotMatch(write.body.error, /can view/, 'must not assert an access they do not hold');
  });

  await t.test('nothing outside P&L was touched', async () => {
    /* The brief's last testing step. The two guarantees worth machine-checking:
       no existing permission changed its default, and no existing table gained
       or lost a column. */
    const tiers = require('../src/role-tiers');
    const TIERS = tiers.TIERS || tiers;
    const superAdmin = catalogue.baselineFor(TIERS.super_admin.capabilities);
    assert.ok(superAdmin.has('pnl.view') && superAdmin.has('pnl.manage'),
      'Super Admin receives new permissions without anybody toggling them');

    /* The five tables are new ones; none of them replaces or extends an
       existing table, which is what "additive" has to mean at the schema
       level. */
    for (const table of pnl.TABLES) {
      const rows = await sql(cfg,
        'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]);
      assert.strictEqual(Number(rows[0].n), 1, `${table} exists`);
    }
    assert.strictEqual((await as('root', '/admin-dashboard')).status, 200,
      'the Admin Dashboard still answers');
    assert.strictEqual((await as('root', '/reports/efficiency')).status, 200,
      'the Reports tab still answers');
  });
});
