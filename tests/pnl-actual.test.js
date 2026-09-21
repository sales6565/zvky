/* The Actual P&L tab, after it stopped asking people for numbers it already had.
 *
 * WHAT IT WAS. Five manual inputs: a Total Cost in rupees, a billing type, an
 * invoiced-to-date figure, a team list with hours typed against each person,
 * and a set of ad hoc cost lines. Four of those five were things the
 * application already knew — it records who worked on what and for how long,
 * and Settings records what an hour of each designation costs — so they were
 * four numbers that had to be kept in step with the truth by hand, and drifted
 * the moment nobody did.
 *
 * WHAT IT IS. One manual input: the Total Value, what the project was sold for.
 * Everything else is read:
 *
 *   Total Hours Spent  every work session on the project's assets
 *   Cost               Σ (each person's hours × their designation's rate)
 *   Profit             Total Value − Cost
 *   Margin             Profit ÷ Total Value
 *
 * THE ONE THING THAT COULD NOT BE DERIVED is what the client agreed to pay, so
 * that is the one thing still asked for.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   HAND-WORKED NUMBERS. Every figure below is one a person can check on
 *      paper — 40 hours at ₹2,000 and 25 at ₹800 is ₹1,00,000 — rather than
 *      whatever the code happens to produce. A test that asserts the output of
 *      the thing it is testing proves only that it is deterministic.
 *
 *   THE TWO CONTRACT VALUES STAY APART. Fixed P&L's Client Billing and this
 *      tab's Total Value are separate fields on purpose, because they are
 *      edited under separate permissions. Moving one must not move the other.
 *
 *   NOT ENTERED IS NOT ZERO. A project nobody has priced has no profit and no
 *      margin. Printing a loss equal to its costs would be an assertion the
 *      data cannot support, and it is the direction of error that makes a
 *      healthy project look like a disaster.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pnl = require('../src/pnl');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('pnlactual');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the arithmetic, with no server -------------------------------------------

const figures = (totalValue, consumedCost, consumedHours, unpriced = 0) => pnl.compute({
  billing: { contractValue: 0, invoicedToDate: 0, billingType: null, totalValue },
  assignments: [],
  otherCosts: [],
  hours: { consumedCost, consumedHours, consumedUnpricedHours: unpriced },
});

test('the studio\'s own example: a senior at 40 hours and a junior at 25', () => {
  /* 40 × 2,000 = 80,000. 25 × 800 = 20,000. The tab is costed at the sum. */
  const t = figures(500000, 80000 + 20000, 65);
  assert.strictEqual(t.recordedHours, 65, 'the hours add up');
  assert.strictEqual(t.recordedCost, 100000, 'and so does the cost');
  assert.strictEqual(t.actualProfit, 400000, '5,00,000 − 1,00,000');
  assert.strictEqual(t.actualMarginPercent, 80, '4,00,000 ÷ 5,00,000');
  assert.strictEqual(t.costPerHour, 1538.46, '1,00,000 ÷ 65, to the paisa');
});

test('a project nobody has priced has no profit and no margin', () => {
  const t = figures(null, 100000, 65);
  assert.strictEqual(t.totalValue, null, 'not entered stays not entered');
  assert.strictEqual(t.recordedCost, 100000, 'but the cost is still known');
  assert.strictEqual(t.actualProfit, null, 'no profit — not a loss of 1,00,000');
  assert.strictEqual(t.actualMarginPercent, null, 'and no margin');
});

test('a project priced at zero is a different fact from one not priced', () => {
  const t = figures(0, 100000, 65);
  assert.strictEqual(t.totalValue, 0);
  assert.strictEqual(t.actualProfit, -100000, 'sold for nothing, so the cost is the loss');
  assert.strictEqual(t.actualMarginPercent, null, 'a margin on zero is not a number');
});

test('a project with no hours logged costs nothing and has full margin', () => {
  const t = figures(500000, 0, 0);
  assert.strictEqual(t.recordedCost, 0);
  assert.strictEqual(t.actualProfit, 500000);
  assert.strictEqual(t.actualMarginPercent, 100);
  assert.strictEqual(t.costPerHour, null, 'and no cost per hour, rather than a division by zero');
});

test('work costing more than it sold for reads as a loss, not as nothing', () => {
  const t = figures(50000, 120000, 60);
  assert.strictEqual(t.actualProfit, -70000);
  assert.strictEqual(t.actualMarginPercent, -140);
});

test('unpriced hours are reported, never folded in at zero', () => {
  /* Somebody whose designation has no rate. Their hours are real and are in
     the hours figure; their cost is not in the cost figure, because nobody has
     said what it is. Costing them at nothing would understate what the project
     cost, which is the direction of error that turns a loss into a profit. */
  const t = figures(500000, 100000, 80, 15);
  assert.strictEqual(t.recordedHours, 80, 'all the hours are counted');
  assert.strictEqual(t.recordedCost, 100000, 'only the priced ones are costed');
  assert.strictEqual(t.unpricedHours, 15, 'and the gap is reported rather than hidden');
});

test('the manual inputs this tab used to have are gone from the figures it uses', () => {
  /* Given a project with a typed Total Cost, a billing type, an invoiced
     figure, a team list and other costs, NONE of them may touch the Actual
     tab's four numbers. Handed to compute() precisely so that this can be
     asserted rather than assumed. */
  const t = pnl.compute({
    billing: {
      contractValue: 900000, invoicedToDate: 250000, billingType: 'fixed',
      totalCost: 777777, totalValue: 500000,
    },
    assignments: [{
      role: 'Artist', level: 'Senior Artist', ratePerHour: 9999,
      assignedHours: 100, hours: 100, billedHours: 100,
      cost: 999900, budgetedCost: 999900, hoursDelta: 0,
    }],
    otherCosts: [{ label: 'Outsourcing', amount: 333333 }],
    hours: { consumedCost: 100000, consumedHours: 65, consumedUnpricedHours: 0 },
  });
  assert.strictEqual(t.totalValue, 500000, 'the Total Value is the one manual figure read');
  assert.strictEqual(t.recordedCost, 100000, 'the cost ignores the team list and the typed cost');
  assert.strictEqual(t.actualProfit, 400000, 'and so does the profit');
  assert.strictEqual(t.actualMarginPercent, 80, 'and the margin');
});

// --- the page -----------------------------------------------------------------

test('the removed inputs are not on the Actual tab', () => {
  /* The studio's fifth check, read off the page rather than clicked through.
     Each of these four is still in the file — the Fixed tab needs every one of
     them — so what is asserted is that the Actual branch does not reach them. */
  const detail = PAGE.match(/function paintPnlDetail\(\)\{([\s\S]*?)\n  wirePnlDetail\(\);/);
  assert.ok(detail, 'public/index.html has no paintPnlDetail');
  assert.match(detail[1], /const fixed = PNL\.view === 'fixed';/,
    'the detail panel knows which tab it is open under');
  /* The HEADINGS, not the words. An earlier version of this test looked for
     the bare phrase "Client Billing" and matched the comment at the top of the
     function explaining which sections are the Fixed tab's — so it reported the
     section as rendered before the branch when it is not rendered there at all.
     A heading is markup and can only be in the output. */
  const heads = [...detail[1].matchAll(/<h4 class="pnl-sub-h">([^<]+)<\/h4>/g)].map((m) => m[1]);
  for (const label of ['Client Billing', 'Project Team', 'Other Costs']) {
    assert.ok(heads.includes(label), `${label} is still there for the Fixed tab: ${heads}`);
  }
  /* And all three sit inside the fixed-only branch, which opens right after the
     Actual tab's own content and closes at the end of the panel. */
  const branch = detail[1].indexOf('${!fixed ?');
  assert.ok(branch > -1, 'the panel splits on which tab it is under');
  for (const label of ['Client Billing', 'Project Team', 'Other Costs']) {
    const at = detail[1].indexOf(`<h4 class="pnl-sub-h">${label}</h4>`);
    assert.ok(at > branch, `${label} is rendered only on the Fixed side of the branch`);
  }
});

test('the Actual tab renders the Total Value editor and no cost editor', () => {
  assert.ok(PAGE.includes('function pnlTotalValueEditorHTML('), 'the Total Value editor exists');
  assert.ok(!PAGE.includes('function pnlTotalCostEditorHTML('),
    'and the Total Cost editor it replaced is gone, not merely unreferenced');
  assert.ok(!PAGE.includes('/total-cost'), 'nothing still calls the old endpoint');
});

test('the Total Value field is disabled without the permission', () => {
  const fn = PAGE.match(/function pnlTotalValueEditorHTML\(d\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /can\('pnl\.actual'\)\?'':'disabled'/,
    'the input is disabled for somebody without Access Actual P&L');
  assert.match(fn[1], /can\('pnl\.actual'\) \? '<button[^>]*id="pnl_saveTotalValue"/,
    'and the Save button is not drawn at all');
});

test('the tab keeps its breakdown and its comparison visual', () => {
  assert.ok(PAGE.includes('function pnlConsumedByRoleHTML('), 'the per-designation breakdown');
  assert.ok(PAGE.includes('function pnlActualCompareHTML('), 'and the value-against-cost bars');
  assert.match(PAGE, /pnlActualCompareHTML\(r\)/, 'which the Actual tab renders');
  assert.match(PAGE, /pnlConsumedByRoleHTML\(d\.consumedByRole\)/, 'fed by the recorded hours');
});

// --- against a live server ------------------------------------------------------

test('costed from the work that was actually done', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Actual-Test-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const report = async (who = 'root') =>
    (await as(who, `/pnl/report?projectId=${projectId}`)).body;
  const totals = async () => (await report()).projects[0].totals;

  /* Log `hrs` hours for somebody, through the real start/submit path, on an
     asset of their own. The clock is wound back rather than waited out — the
     point under test is what the hours cost, not how long a test takes. */
  let made = 0;
  const logHours = async (who, hrs) => {
    const a = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Task ${made += 1}`, type: 'prop' },
    });
    const assetId = a.body.asset.id;
    await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { assigneeId: id[who] } });
    await as(who, `/assets/${assetId}/start`, { method: 'POST' });
    await sql(cfg, `UPDATE work_sessions SET started_at = started_at - INTERVAL ${hrs * 60} MINUTE
                     WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
    const done = await as(who, `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v' } });
    assert.ok(done.status < 400, `submit: ${JSON.stringify(done.body)}`);
    return assetId;
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

    // The price list, set once in Settings → Role Rates.
    for (const [key, rate] of [['senior_game_artist', 2000], ['trainee_game_animator', 800]]) {
      const r = await as('root', `/pnl/role-rates/${key}`, { method: 'PUT', body: { ratePerHour: rate } });
      assert.strictEqual(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('a Total Value is entered and saved', async () => {
    const r = await as('root', `/pnl/projects/${projectId}/total-value`, {
      method: 'PUT', body: { totalValue: 500000 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.billing.totalValue, 500000);
    assert.strictEqual((await totals()).totalValue, 500000, 'and it survives a round trip');
  });

  await t.test('hours and cost arrive on their own, with nothing entered by hand', async () => {
    await logHours('senior', 40);
    await logHours('junior', 25);

    const t1 = await totals();
    assert.strictEqual(t1.recordedHours, 65, '40 + 25, from the work sessions');
    assert.strictEqual(t1.recordedCost, 100000, '40 × 2,000 + 25 × 800');

    /* And the team list is genuinely not involved: there is none. */
    const detail = (await as('root', `/pnl/projects/${projectId}`)).body;
    assert.deepStrictEqual(detail.assignments, [],
      'nobody was added to a Project Team, and the cost is right anyway');
    assert.deepStrictEqual(detail.otherCosts, [], 'and there are no cost lines');
  });

  await t.test('the breakdown is per designation, at that designation\'s rate', async () => {
    const rows = (await report()).consumedByRole;
    const senior = rows.find((r) => r.roleKey === 'senior_game_artist');
    const junior = rows.find((r) => r.roleKey === 'trainee_game_animator');
    assert.ok(senior && junior, `both designations are listed: ${rows.map((r) => r.roleKey)}`);
    assert.strictEqual(senior.hours, 40);
    assert.strictEqual(senior.ratePerHour, 2000);
    assert.strictEqual(senior.cost, 80000);
    assert.strictEqual(junior.hours, 25);
    assert.strictEqual(junior.ratePerHour, 800);
    assert.strictEqual(junior.cost, 20000);
    assert.deepStrictEqual(senior.people, ['Senior Sam'], 'and who it was');

    const sum = rows.reduce((total, r) => total + r.cost, 0);
    assert.strictEqual(sum, (await totals()).recordedCost,
      'the table adds up to the Cost card above it');
  });

  await t.test('profit and margin follow from the two', async () => {
    const t1 = await totals();
    assert.strictEqual(t1.actualProfit, 400000, '5,00,000 − 1,00,000');
    assert.strictEqual(t1.actualMarginPercent, 80);
    assert.strictEqual(t1.costPerHour, 1538.46, '1,00,000 ÷ 65 hours');
  });

  await t.test('more hours from a different role move the cost and the margin', async () => {
    /* The studio's third check. Ten more senior hours at ₹2,000 is ₹20,000
       more cost and ₹20,000 less profit, with nobody touching a form. */
    await logHours('senior', 10);
    const t2 = await totals();
    assert.strictEqual(t2.recordedHours, 75);
    assert.strictEqual(t2.recordedCost, 120000, '1,00,000 + 10 × 2,000');
    assert.strictEqual(t2.actualProfit, 380000);
    assert.strictEqual(t2.actualMarginPercent, 76);

    const rows = (await report()).consumedByRole;
    assert.strictEqual(rows.find((r) => r.roleKey === 'senior_game_artist').hours, 50,
      'and the breakdown moved with it');
  });

  await t.test('a rate change re-costs the project, because nothing was copied', async () => {
    /* The consequence of pricing from the live rate rather than a figure
       stamped onto a row: correcting a rate corrects every project it applies
       to. Worth pinning because it is a real difference from the Fixed tab's
       team assignments, which deliberately keep the rate they were costed at. */
    await as('root', '/pnl/role-rates/trainee_game_animator', { method: 'PUT', body: { ratePerHour: 1000 } });
    const t3 = await totals();
    assert.strictEqual(t3.recordedCost, 125000, '50 × 2,000 + 25 × 1,000');
    await as('root', '/pnl/role-rates/trainee_game_animator', { method: 'PUT', body: { ratePerHour: 800 } });
    assert.strictEqual((await totals()).recordedCost, 120000, 'and back again');
  });

  await t.test('an unpriced designation is reported, not costed at nothing', async () => {
    await as('root', '/pnl/role-rates/senior_game_artist', { method: 'PUT', body: { ratePerHour: null } });
    const t4 = await totals();
    assert.strictEqual(t4.recordedHours, 75, 'the hours are all still there');
    assert.strictEqual(t4.recordedCost, 20000, 'but only the junior is costed');
    assert.strictEqual(t4.unpricedHours, 50, 'and the 50 unpriced hours are named');

    const row = (await report()).consumedByRole.find((r) => r.roleKey === 'senior_game_artist');
    assert.strictEqual(row.priced, false, 'the row stays in the table');
    assert.strictEqual(row.hours, 50, 'with its hours');
    assert.strictEqual(row.cost, 0, 'and no cost');

    await as('root', '/pnl/role-rates/senior_game_artist', { method: 'PUT', body: { ratePerHour: 2000 } });
    assert.strictEqual((await totals()).recordedCost, 120000);
  });

  await t.test('Fixed P&L\'s Client Billing is a separate field and is unaffected', async () => {
    /* The studio's sixth check. Setting Client Billing must not move the Actual
       tab's Total Value, and setting the Total Value must not move Client
       Billing — they are two fields under two permissions. */
    const before = await totals();
    const bill = await as('root', `/pnl/projects/${projectId}/billing`, {
      method: 'PUT', body: { contractValue: 900000, billingType: 'fixed', invoicedToDate: 250000 },
    });
    assert.strictEqual(bill.status, 200, JSON.stringify(bill.body));

    const after = await totals();
    assert.strictEqual(after.totalValue, before.totalValue, 'the Total Value did not move');
    assert.strictEqual(after.actualProfit, before.actualProfit, 'nor the profit');
    assert.strictEqual(after.contractValue, 900000, 'and Client Billing took the value it was given');
    assert.strictEqual(after.revenue, 250000, 'including invoiced-to-date, which Fixed still reads');

    await as('root', `/pnl/projects/${projectId}/total-value`, { method: 'PUT', body: { totalValue: 600000 } });
    const back = await totals();
    assert.strictEqual(back.contractValue, 900000, 'and the reverse: Client Billing is untouched');
    assert.strictEqual(back.revenue, 250000);
    assert.strictEqual(back.totalValue, 600000);
    await as('root', `/pnl/projects/${projectId}/total-value`, { method: 'PUT', body: { totalValue: 500000 } });
  });

  await t.test('Fixed P&L still costs delivered work, on its own basis', async () => {
    /* The other half of the sixth check: the Fixed tab was not quietly changed
       into the Actual one. Nothing here is delivered, so its cost is zero while
       the Actual tab's is ₹1,20,000 — two different questions, two answers. */
    const d = (await report()).projects[0];
    assert.strictEqual(d.hours.actualCost, 0, 'nothing delivered, so nothing costed on Fixed');
    assert.strictEqual(d.totals.recordedCost, 120000, 'while the Actual tab counts every hour');
    assert.ok(d.hours.deliveredHours < d.totals.recordedHours,
      'the two hour figures are genuinely different questions');
  });

  await t.test('without Access Actual P&L, the field cannot be seen or edited', async () => {
    /* The studio's seventh check, both halves: the write is refused, and so is
       the read it would be made from. */
    const edit = await as('outsider', `/pnl/projects/${projectId}/total-value`, {
      method: 'PUT', body: { totalValue: 1 },
    });
    assert.strictEqual(edit.status, 403, 'the edit is refused');

    const read = await as('outsider', `/pnl/report?projectId=${projectId}`);
    assert.strictEqual(read.status, 403, 'and so is the report');

    assert.strictEqual((await totals()).totalValue, 500000, 'and nothing changed');
  });

  await t.test('the permission is a grant, not a designation', async () => {
    /* Granting pnl.actual to the outsider's role lets them in, and taking it
       away shuts them out again — the same person, the same project. That is
       what makes it a permission a Super Admin controls rather than a rule in
       the code. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('pnl.actual'), 'not held out of the box');

    const on = await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'pnl.actual'] },
    });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    try {
      const read = await as('outsider', `/pnl/report?projectId=${projectId}`);
      assert.strictEqual(read.status, 200, 'now they can reach the report');
      assert.strictEqual(read.body.canSeeActual, true, 'and it says the tab is theirs');
      /* WHAT THE GRANT DOES NOT DO: widen whose projects they can see. This
         person is a contributor with no work on this project, so the report is
         empty for them — the permission decides whether the money is shown for
         the projects they could already open, not which projects those are.
         Asserted rather than glossed over, because an empty report could
         otherwise be read as the grant having failed. */
      assert.strictEqual(read.body.projects.length, 0,
        'the grant shows the tab; it does not widen project scope');

      const edit = await as('outsider', `/pnl/projects/${projectId}/total-value`, {
        method: 'PUT', body: { totalValue: 500000 },
      });
      assert.strictEqual(edit.status, 404,
        'and a project they cannot see is still out of reach, by 404 rather than 403');
    } finally {
      const off = await as('root', '/permissions/roles/game_artist', {
        method: 'PUT', body: { permissions: held },
      });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    }
    assert.strictEqual((await as('outsider', `/pnl/report?projectId=${projectId}`)).status, 403,
      'and taking it away shuts them out again');
  });

  await t.test('the change is in the Activity Log with its old and new value', async () => {
    const log = await as('root', '/activity?module=pnl&limit=100');
    assert.strictEqual(log.status, 200);
    const entry = (log.body.entries || []).find((e) => e.action === 'pnl.total_value_changed');
    assert.ok(entry, 'setting a Total Value is recorded');
    assert.ok(entry.changes && entry.changes.totalValue, 'with the figure that changed');
    assert.ok(entry.changes.totalValue.to !== undefined, 'and what it became');
  });
});
