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
