/* Profit & Loss: two tabs, one set of hours, one figure anybody types.
 *
 * WHAT THIS FEATURE USED TO ASK FOR. A free-text rate card, a per-project team
 * list with hours typed against each person, a contract value, a billing type,
 * an invoiced-to-date amount, a typed Total Cost and a set of ad hoc cost
 * lines. Eight things to keep in step with the truth by hand, when the
 * application already recorded who worked on what and for how long, and
 * Settings already recorded what an hour of each designation costs. A stale
 * figure in a P&L is worse than a missing one, because it looks authoritative.
 *
 * WHAT IT ASKS FOR NOW. One price list in Settings, and one number per project:
 * what it was sold for. Everything else is read.
 *
 *   Total Hours (Budgeted)   every asset's Man Hours estimate, added up
 *   Total Hours Recorded     hours logged on tasks that reached Delivered
 *   Budgeted Cost            the estimate at the Rate Card rate of whoever
 *                            each asset is assigned to
 *   Actual Cost              the recorded hours at the rate of whoever logged
 *                            them
 *   Variance                 budgeted − actual. POSITIVE IS A SAVING.
 *   Total Project Value      the one manual figure, Actual tab only
 *   Profit / Margin          value − cost, and that over the value
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   HAND-WORKED NUMBERS. Every figure is one a person can check on paper —
 *      50 hours estimated at ₹2,000 is ₹1,00,000 — rather than whatever the
 *      code happens to produce. A costing tested against itself agrees with
 *      itself perfectly and is wrong in the one way that costs money.
 *
 *   DELIVERED IS A FILTER, NOT A TALLY. Nothing increments when a task is
 *      delivered. The figure is derived from each asset's current state on
 *      every read, so it is right after a delivery, after an override moves an
 *      asset back out of Delivered, and after a session is added to an asset
 *      that was already delivered.
 *
 *   ONE FIGURE, BOTH TABS. They cannot disagree about how much work was done,
 *      and this file asserts that rather than assuming it.
 *
 *   AN UNPRICED HOUR IS NOT A FREE ONE. Reported on both sides, never folded
 *      into a total at zero.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pnl = require('../src/pnl');
const pnlHours = require('../src/pnl-hours');
const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('pnl');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the arithmetic, with no server -------------------------------------------

const figures = ({ value = null, budgetedHours = 0, budgetedCost = 0,
  recordedHours = 0, recordedCost = 0, budgetedUnpriced = 0, recordedUnpriced = 0 } = {}) =>
  pnl.compute({
    billing: { totalValue: value },
    hours: {
      budgetedHours, budgetedCost, recordedHours, recordedCost,
      budgetedUnpricedHours: budgetedUnpriced, recordedUnpricedHours: recordedUnpriced,
    },
  });

test('Fixed P&L: under budget reads as a saving, and the sign says so', () => {
  /* Estimated 100 hours costing ₹1,64,000; did 65 costing ₹1,00,000. */
  const t = figures({ budgetedHours: 100, budgetedCost: 164000, recordedHours: 65, recordedCost: 100000 });
  assert.strictEqual(t.variance, 64000, 'budgeted minus actual');
  assert.ok(t.variance > 0, 'POSITIVE is the saving — the whole convention rests on this');
  assert.strictEqual(t.variancePercent, 39, '64,000 of 1,64,000');
  assert.strictEqual(t.overBudget, false);
  assert.strictEqual(t.budgeted, true);
});

test('Fixed P&L: over budget reads as an overrun, and the sign says so', () => {
  const t = figures({ budgetedHours: 50, budgetedCost: 100000, recordedHours: 80, recordedCost: 160000 });
  assert.strictEqual(t.variance, -60000, 'negative is the overrun');
  assert.strictEqual(t.variancePercent, -60);
  assert.strictEqual(t.overBudget, true);
});

test('Fixed P&L: a project nobody estimated is unplanned, not under budget', () => {
  /* "0 budgeted, 1,00,000 spent, 1,00,000 over" on every project that predates
     the Man Hours field would be a red flag that means nothing. */
  const t = figures({ budgetedHours: 0, budgetedCost: 0, recordedHours: 40, recordedCost: 100000 });
  assert.strictEqual(t.budgeted, false);
  assert.strictEqual(t.overBudget, false, 'not over a budget that does not exist');
  assert.strictEqual(t.variancePercent, null, 'and no percentage of nothing');
});

test('Actual P&L: profit and margin from the value and the recorded cost', () => {
  const t = figures({ value: 500000, recordedHours: 65, recordedCost: 100000 });
  assert.strictEqual(t.actualProfit, 400000);
  assert.strictEqual(t.actualMarginPercent, 80);
  assert.strictEqual(t.costPerHour, 1538.46, '1,00,000 ÷ 65, to the paisa');
});

test('Actual P&L: a project nobody has priced has no profit and no margin', () => {
  const t = figures({ value: null, recordedHours: 65, recordedCost: 100000 });
  assert.strictEqual(t.totalValue, null);
  assert.strictEqual(t.recordedCost, 100000, 'the cost is still known');
  assert.strictEqual(t.actualProfit, null, 'no profit — NOT a loss of 1,00,000');
  assert.strictEqual(t.actualMarginPercent, null);
});

test('Actual P&L: priced at zero is a different fact from not priced', () => {
  const t = figures({ value: 0, recordedHours: 65, recordedCost: 100000 });
  assert.strictEqual(t.actualProfit, -100000, 'sold for nothing, so the cost is the loss');
  assert.strictEqual(t.actualMarginPercent, null, 'a margin on zero is not a number');
});

test('work costing more than it sold for reads as a loss', () => {
  const t = figures({ value: 50000, recordedHours: 60, recordedCost: 120000 });
  assert.strictEqual(t.actualProfit, -70000);
  assert.strictEqual(t.actualMarginPercent, -140);
});

test('nothing recorded yet: no cost, no cost per hour, full margin', () => {
  const t = figures({ value: 500000, budgetedHours: 100, budgetedCost: 200000 });
  assert.strictEqual(t.recordedCost, 0);
  assert.strictEqual(t.costPerHour, null, 'rather than a division by zero');
  assert.strictEqual(t.actualProfit, 500000);
  assert.strictEqual(t.actualMarginPercent, 100);
  assert.strictEqual(t.variance, 200000, 'and the whole budget is still unspent');
});

test('unpriced hours are reported from both sides, never folded in at zero', () => {
  const t = figures({
    value: 500000, budgetedHours: 100, budgetedCost: 150000,
    recordedHours: 80, recordedCost: 100000,
    budgetedUnpriced: 20, recordedUnpriced: 15,
  });
  assert.strictEqual(t.budgetedUnpricedHours, 20);
  assert.strictEqual(t.recordedUnpricedHours, 15);
  assert.strictEqual(t.unpricedHours, 35, 'both sides, so the banner can say one number');
  assert.strictEqual(t.recordedCost, 100000, 'the cost is only what could be priced');
});

test('the rollup sums the projects rather than recomputing from a wider query', () => {
  const p = (totals) => ({ totals });
  const r = pnl.rollup([
    p(figures({ value: 500000, budgetedHours: 100, budgetedCost: 200000, recordedHours: 65, recordedCost: 100000 })),
    p(figures({ value: null, budgetedHours: 50, budgetedCost: 50000, recordedHours: 40, recordedCost: 60000 })),
  ]);
  assert.strictEqual(r.projects, 2);
  assert.strictEqual(r.budgetedHours, 150);
  assert.strictEqual(r.recordedHours, 105);
  assert.strictEqual(r.budgetedCost, 250000);
  assert.strictEqual(r.recordedCost, 160000);
  assert.strictEqual(r.variance, 90000);
  assert.strictEqual(r.overBudgetProjects, 1, 'the second one ran over, the first did not');
  /* Total Value adds up only across the projects that HAVE one, and how many
     did is reported beside it — "₹5,00,000 across 1 of 2" cannot be misread as
     the value of both. */
  assert.strictEqual(r.totalValue, 500000);
  assert.strictEqual(r.projectsWithTotalValue, 1);
  assert.strictEqual(r.actualMarginPercent, 80, 'recomputed from the sums, not averaged');
});

test('the per-role table merges the two sides and keeps rows present on one', () => {
  /* "Budgeted 40 hours, did none" and "did 40 hours nobody budgeted for" are
     exactly the two things this table exists to show. */
  const rows = pnlHours.mergeRoles(
    [{ roleKey: 'a', roleLabel: 'A', ratePerHour: 100, priced: true, hours: 40, cost: 4000, people: [] },
     { roleKey: 'gone', roleLabel: 'Gone', ratePerHour: 50, priced: true, hours: 10, cost: 500, people: [] }],
    [{ roleKey: 'a', roleLabel: 'A', ratePerHour: 100, priced: true, hours: 30, cost: 3000, people: ['Ann'] },
     { roleKey: 'extra', roleLabel: 'Extra', ratePerHour: 20, priced: true, hours: 5, cost: 100, people: ['Bo'] }]
  );
  const by = Object.fromEntries(rows.map((r) => [r.roleKey, r]));
  assert.strictEqual(by.a.budgetedHours, 40);
  assert.strictEqual(by.a.recordedHours, 30);
  assert.strictEqual(by.a.variance, 1000, '4,000 budgeted against 3,000 spent');
  assert.deepStrictEqual(by.a.people, ['Ann']);
  assert.strictEqual(by.gone.recordedHours, 0, 'budgeted for and never worked — kept');
  assert.strictEqual(by.extra.budgetedHours, 0, 'worked and never budgeted — kept');
  const total = rows.reduce((t, r) => t + r.recordedCost, 0);
  assert.strictEqual(total, 3100, 'and the rows add up to the actual cost');
});

test('Delivered is read from the workflow, not spelled in a string', () => {
  assert.ok(workflow.STATE_IDS.includes(pnlHours.DELIVERED),
    'renaming the state in the workflow must not leave this summing one that is gone');
});

// --- the page -----------------------------------------------------------------

test('no manual entry field exists anywhere on Fixed P&L', () => {
  /* The studio's first check, read off the page. The Fixed branch renders
     cards, the shared breakdown table and nothing else — every input on this
     screen is inside the Actual tab's Total Project Value box. */
  const paint = PAGE.match(/function paintPnl\(\)\{([\s\S]*?)\n  wirePnl\(\);/);
  assert.ok(paint, 'public/index.html has no paintPnl');
  const editor = paint[1].indexOf('pnlTotalValueEditorHTML');
  assert.ok(editor > -1, 'the value editor is rendered');
  assert.match(paint[1], /\$\{fixed \? '' : pnlTotalValueEditorHTML\(d\)\}/,
    'and only on the Actual tab');

  const fixedCards = PAGE.match(/function pnlFixedCardsHTML\(r\)\{([\s\S]*?)\n\}/);
  assert.ok(fixedCards);
  assert.ok(!/<input/.test(fixedCards[1]), 'the Fixed cards hold no input');
  assert.ok(!/<select/.test(fixedCards[1]), 'and no select');
});

test('the removed inputs are gone from the page, not merely hidden', () => {
  /* The studio's sixth check. These are asserted against the rendered markup —
     a heading, a label, an element id — rather than the bare words, which also
     appear in comments explaining why they were removed. */
  for (const gone of [
    '<h4 class="pnl-sub-h">Client Billing</h4>',
    '<h4 class="pnl-sub-h">Project Team</h4>',
    '<h4 class="pnl-sub-h">Other Costs</h4>',
    'id="pb_type"', 'id="pb_invoiced"', 'id="pb_contract"',
    'id="ta_add"', 'id="oc_add"', 'id="rc_add"',
    'id="rateCardsSection"',
  ]) {
    assert.ok(!PAGE.includes(gone), `${gone} is still in the page`);
  }
  for (const fn of ['renderRateCards', 'paintRateCards', 'wireRateCards', 'pnlTrendHTML', 'pnlCompareHTML']) {
    assert.ok(!PAGE.includes(`function ${fn}(`), `${fn} is still defined`);
  }
});

test('Settings offers one Rate Card, not two rate lists', () => {
  assert.match(PAGE, /label:'Rate Card',\s+heading:'Rate Card'/, 'one entry in the Settings index');
  assert.ok(!PAGE.includes("label:'Role Rates'"), 'and the second list is gone');
  assert.match(PAGE, /<h3>Rate Card<\/h3>/, 'the section renders under that name');
});

test('the Total Project Value field is disabled without the permission', () => {
  const fn = PAGE.match(/function pnlTotalValueEditorHTML\(d\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /can\('pnl\.actual'\)\?'':'disabled'/, 'the input is disabled');
  assert.match(fn[1], /can\('pnl\.actual'\) \? '<button[^>]*id="pnl_saveTotalValue"/,
    'and the Save button is not drawn at all');
});

// --- against a live server ------------------------------------------------------

test('costed from the estimate and the work', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Pnl-Test-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const report = async (who = 'root') => (await as(who, `/pnl/report?projectId=${projectId}`)).body;
  const totals = async () => (await report()).projects[0].totals;

  /* An asset with a Man Hours estimate, assigned, worked on for `hrs`, and
     optionally driven all the way to Delivered through the real routes. The
     clock is wound back rather than waited out — the point under test is what
     the hours cost, not how long a test takes. */
  let made = 0;
  const task = async (who, estimate, hrs, { deliver = false } = {}) => {
    const a = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Task ${made += 1}`, type: 'prop', manHours: estimate },
    });
    const assetId = a.body.asset.id;
    await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { assigneeId: id[who] } });
    await as(who, `/assets/${assetId}/start`, { method: 'POST' });
    await sql(cfg, `UPDATE work_sessions SET started_at = started_at - INTERVAL ${hrs * 60} MINUTE
                     WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
    const done = await as(who, `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v' } });
    assert.ok(done.status < 400, `submit: ${JSON.stringify(done.body)}`);
    if (deliver) await toDelivered(assetId);
    return assetId;
  };
  const toDelivered = async (assetId) => {
    await as('root', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
    const d = await as('root', `/assets/${assetId}/deliver`, { method: 'POST' });
    assert.ok(d.status < 400, `deliver: ${d.status} ${JSON.stringify(d.body)}`);
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    /* The studio open around the clock, so the hours wound back above land
       inside the working window whatever time this suite runs at. */
    await openStudio(server.base, tok.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('senior', 'Senior Sam', 'senior@zvky.test', 'senior_game_artist');
    await make('junior', 'Junior Jo', 'junior@zvky.test', 'trainee_game_animator');
    await make('outsider', 'No Access', 'outsider@zvky.test', 'game_artist');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Costed', clientId: clients.body.clients[0].id },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;

    // The Rate Card, set once in Settings.
    for (const [key, rate] of [['senior_game_artist', 2000], ['trainee_game_animator', 800]]) {
      const r = await as('root', `/pnl/role-rates/${key}`, { method: 'PUT', body: { ratePerHour: rate } });
      assert.strictEqual(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    }
  });

  t.after(() => stopServer(server));

  let pending;

  await t.test('budgeted hours are the project\'s own estimate, and nothing is entered', async () => {
    /* 50h estimated for the senior, 30h for the junior, 20h more for the
       senior on a task that will NOT be delivered yet. */
    await task('senior', 50, 40, { deliver: true });
    await task('junior', 30, 25, { deliver: true });
    pending = await task('senior', 20, 15);

    const t1 = await totals();
    assert.strictEqual(t1.budgetedHours, 100, '50 + 30 + 20, straight from the assets');

    /* And it is the SAME figure the rest of the app calls Total Bid Hours, not
       a second budget that could disagree with it. */
    const projects = await as('root', '/clients');
    assert.ok(projects.status < 400);
    const direct = await sql(cfg,
      `SELECT COALESCE(SUM(man_hours),0) AS h FROM assets WHERE project_id = '${projectId}'`);
    assert.strictEqual(Number(direct[0].h), 100, 'the same sum, computed the same way');
  });

  await t.test('recorded hours count delivered work only', async () => {
    /* The studio's second check. 40 + 25 delivered; the 15 logged against the
       undelivered task is not in it. */
    const t1 = await totals();
    assert.strictEqual(t1.recordedHours, 65, '40 + 25 — the undelivered 15 is excluded');
  });

  await t.test('both sides are costed from the Rate Card', async () => {
    const t1 = await totals();
    // Budget: the senior holds 50 + 20 = 70h at 2,000; the junior 30h at 800.
    assert.strictEqual(t1.budgetedCost, 70 * 2000 + 30 * 800, '₹1,64,000');
    // Actual: 40h at 2,000, 25h at 800.
    assert.strictEqual(t1.recordedCost, 40 * 2000 + 25 * 800, '₹1,00,000');
  });

  await t.test('Fixed P&L shows a saving when the work came in under the estimate', async () => {
    /* The studio's third check. */
    const t1 = await totals();
    assert.strictEqual(t1.variance, 64000, '1,64,000 − 1,00,000');
    assert.ok(t1.variance > 0, 'positive, and that means a saving');
    assert.strictEqual(t1.variancePercent, 39);
    assert.strictEqual(t1.overBudget, false);
  });

  await t.test('and the role breakdown splits both sides correctly', async () => {
    const rows = (await report()).byRole;
    const senior = rows.find((r) => r.roleKey === 'senior_game_artist');
    const junior = rows.find((r) => r.roleKey === 'trainee_game_animator');
    assert.ok(senior && junior, `both designations listed: ${rows.map((r) => r.roleKey)}`);

    assert.strictEqual(senior.budgetedHours, 70, '50 + 20 estimated');
    assert.strictEqual(senior.budgetedCost, 140000);
    assert.strictEqual(senior.recordedHours, 40, 'and 40 delivered');
    assert.strictEqual(senior.recordedCost, 80000);
    assert.strictEqual(senior.variance, 60000);

    assert.strictEqual(junior.budgetedHours, 30);
    assert.strictEqual(junior.recordedHours, 25);
    assert.strictEqual(junior.variance, 4000, '24,000 − 20,000');

    const t1 = await totals();
    assert.strictEqual(rows.reduce((s, r) => s + r.recordedCost, 0), t1.recordedCost,
      'the table adds up to the Actual Cost card');
    assert.strictEqual(rows.reduce((s, r) => s + r.budgetedCost, 0), t1.budgetedCost,
      'and to the Budgeted Cost card');
  });

  await t.test('a task reaching Delivered moves both tabs the same way', async () => {
    /* The studio's fifth check, and the reason there is one hours figure rather
       than two. Before and after are compared on BOTH tabs' fields, which are
       the same fields — if they ever stop being, this is what catches it. */
    const before = await totals();
    await toDelivered(pending);
    const after = await totals();

    assert.strictEqual(after.recordedHours, before.recordedHours + 15, '80 hours now');
    assert.strictEqual(after.recordedCost, before.recordedCost + 15 * 2000, '₹1,30,000');
    assert.strictEqual(after.budgetedHours, before.budgetedHours, 'the estimate did not move');
    /* The Actual tab reads the same two fields. There is genuinely one figure,
       so this cannot drift — which is what the assertion is for. */
    assert.strictEqual(after.variance, after.budgetedCost - after.recordedCost);
    assert.strictEqual(after.costPerHour, 1625, '1,30,000 ÷ 80');
  });

  await t.test('Actual P&L: a Total Project Value is entered and drives profit and margin', async () => {
    /* The studio's fourth check. */
    const set = await as('root', `/pnl/projects/${projectId}/total-value`, {
      method: 'PUT', body: { totalValue: 500000 },
    });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));

    const t1 = await totals();
    assert.strictEqual(t1.totalValue, 500000);
    assert.strictEqual(t1.recordedCost, 130000, 'the same cost the Fixed tab uses');
    assert.strictEqual(t1.actualProfit, 370000, '5,00,000 − 1,30,000');
    assert.strictEqual(t1.actualMarginPercent, 74);

    // Clearing goes back to "nobody has said", not to zero.
    await as('root', `/pnl/projects/${projectId}/total-value`, { method: 'PUT', body: { totalValue: null } });
    const cleared = await totals();
    assert.strictEqual(cleared.totalValue, null);
    assert.strictEqual(cleared.actualProfit, null);
    assert.strictEqual(cleared.actualMarginPercent, null);

    // A typed minus sign is refused rather than booked as a loss.
    const neg = await as('root', `/pnl/projects/${projectId}/total-value`, { method: 'PUT', body: { totalValue: -1 } });
    assert.strictEqual(neg.status, 400);
    await as('root', `/pnl/projects/${projectId}/total-value`, { method: 'PUT', body: { totalValue: 500000 } });
  });

  await t.test('a Rate Card change re-costs both sides, because nothing is copied', async () => {
    await as('root', '/pnl/role-rates/trainee_game_animator', { method: 'PUT', body: { ratePerHour: 1000 } });
    const t1 = await totals();
    assert.strictEqual(t1.recordedCost, 55 * 2000 + 25 * 1000, 'the actual side moved');
    assert.strictEqual(t1.budgetedCost, 70 * 2000 + 30 * 1000, 'and so did the budget');
    await as('root', '/pnl/role-rates/trainee_game_animator', { method: 'PUT', body: { ratePerHour: 800 } });
    assert.strictEqual((await totals()).recordedCost, 130000, 'and back again');
  });

  await t.test('an unpriced designation is reported on both sides, not costed at nothing', async () => {
    await as('root', '/pnl/role-rates/senior_game_artist', { method: 'PUT', body: { ratePerHour: null } });
    const t1 = await totals();
    assert.strictEqual(t1.recordedHours, 80, 'the hours are all still there');
    assert.strictEqual(t1.budgetedHours, 100, 'and so is the estimate');
    assert.strictEqual(t1.recordedCost, 20000, 'but only the junior is costed');
    assert.strictEqual(t1.recordedUnpricedHours, 55);
    assert.strictEqual(t1.budgetedUnpricedHours, 70);
    assert.strictEqual(t1.unpricedHours, 125, 'both sides, for the one banner');

    const row = (await report()).byRole.find((r) => r.roleKey === 'senior_game_artist');
    assert.strictEqual(row.priced, false, 'the row stays in the table');
    assert.strictEqual(row.recordedHours, 55, 'with its hours');
    assert.strictEqual(row.recordedCost, 0, 'and no cost');

    await as('root', '/pnl/role-rates/senior_game_artist', { method: 'PUT', body: { ratePerHour: 2000 } });
    assert.strictEqual((await totals()).recordedCost, 130000);
  });

  await t.test('the removed endpoints are gone from the API', async () => {
    /* The studio's sixth check, on the server side. An unmatched GET falls
       through to the single-page app's catch-all and answers 200 with the HTML
       page — that is how every unmatched GET in this application behaves and is
       not something these routes do — so a GET is judged on whether it answered
       with DATA, and everything else on its status. */
    for (const [method, path] of [
      ['PUT', `/pnl/projects/${projectId}/billing`],
      ['POST', `/pnl/projects/${projectId}/assignments`],
      ['POST', `/pnl/projects/${projectId}/other-costs`],
      ['POST', '/pnl/rate-cards'],
    ]) {
      const r = await as('root', path, { method, body: {} });
      assert.strictEqual(r.status, 404, `${method} ${path} still answers ${r.status}`);
    }
    const listing = await as('root', '/pnl/rate-cards');
    assert.ok(!(listing.body && Object.keys(listing.body).length),
      `GET /pnl/rate-cards still returns data: ${JSON.stringify(listing.body).slice(0, 120)}`);
  });

  await t.test('the report carries none of the removed figures either', async () => {
    const d = await report();
    const one = d.projects[0];
    for (const gone of ['contractValue', 'billingType', 'invoicedToDate', 'totalCost', 'otherCosts', 'labourCost']) {
      assert.strictEqual(one.totals[gone], undefined, `totals.${gone} is still being sent`);
    }
    assert.strictEqual(d.rateCards, undefined, 'and the rate card list is not in the payload');
    assert.strictEqual(d.trend, undefined, 'nor the margin trend');
    assert.strictEqual(d.byRoleLevel, undefined, 'nor the old breakdown');
    assert.ok(Array.isArray(d.byRole), 'the one breakdown is there');
  });

  await t.test('permission gating: both tabs and the Rate Card', async () => {
    /* The studio's seventh check. */
    assert.strictEqual((await as('outsider', `/pnl/report?projectId=${projectId}`)).status, 403,
      'holding neither tab, the report is refused');
    assert.strictEqual((await as('outsider', `/pnl/projects/${projectId}/total-value`, {
      method: 'PUT', body: { totalValue: 1 },
    })).status, 403, 'and the Total Project Value cannot be edited');
    assert.strictEqual((await as('outsider', '/pnl/role-rates/senior_game_artist', {
      method: 'PUT', body: { ratePerHour: 1 },
    })).status, 403, 'and the Rate Card cannot be changed');
    assert.strictEqual((await totals()).totalValue, 500000, 'and nothing was changed by the attempts');
  });

  await t.test('the permissions are grants, not designations', async () => {
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('pnl.fixed') && !held.includes('pnl.actual'), 'not held out of the box');

    const on = await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'pnl.fixed'] },
    });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    try {
      const read = await as('outsider', `/pnl/report?projectId=${projectId}`);
      assert.strictEqual(read.status, 200, 'granting Access Fixed P&L opens the report');
      assert.strictEqual(read.body.canSeeFixed, true);
      assert.strictEqual(read.body.canSeeActual, false, 'and not the other tab');
      /* Still refused the Actual tab's field, which belongs to the other
         grant — the two are genuinely separate. */
      assert.strictEqual((await as('outsider', `/pnl/projects/${projectId}/total-value`, {
        method: 'PUT', body: { totalValue: 1 },
      })).status, 403);
    } finally {
      const off = await as('root', '/permissions/roles/game_artist', {
        method: 'PUT', body: { permissions: held },
      });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    }
    assert.strictEqual((await as('outsider', `/pnl/report?projectId=${projectId}`)).status, 403,
      'and taking it away shuts them out again');
  });

  await t.test('every change is in the Activity Log with its old and new value', async () => {
    const log = await as('root', '/activity?module=pnl&limit=100');
    assert.strictEqual(log.status, 200);
    const actions = (log.body.entries || []).map((e) => e.action);
    for (const wanted of ['pnl.total_value_changed', 'pnl.role_rate_changed']) {
      assert.ok(actions.includes(wanted), `${wanted} is recorded`);
    }
    const rate = (log.body.entries || []).find((e) => e.action === 'pnl.role_rate_changed' && e.changes);
    assert.ok(rate && rate.changes.ratePerHour, 'a rate change carries its before and after');
  });
});
