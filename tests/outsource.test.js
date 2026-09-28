/* The Outsource tab: freelancers, and the work given to them.
 *
 * WHAT THE STUDIO ASKED FOR, and the three things worth guarding:
 *
 *   NO MEASURED TIME. decided_man_hours is typed, revised by hand, and is the
 *   only hours column. Nothing here starts a timer or writes a work session,
 *   and the last test in this file proves that by doing the work and then
 *   looking at work_sessions.
 *
 *   PAY RATES ARE THEIR OWN PERMISSION. Not hidden on the screen — LEFT OUT of
 *   the response, and refused on the way in. A rate the server still sends to
 *   somebody who may not see it is not hidden, it is one request away.
 *
 *   THE P&L WAS WRONG BEFORE THIS. It costs work sessions at the Rate Card rate
 *   of the designation that logged them; a freelancer logs no sessions and
 *   holds no designation, so a project that outsourced half its work reported
 *   half its cost and a profit to match. Outsourced cost now lands in both
 *   tabs, which is checked end to end rather than by reading the arithmetic.
 */
const test = require('node:test');
const assert = require('node:assert');

const outsource = require('../src/outsource');
const pnl = require('../src/pnl');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('outsource');

// --- validation and arithmetic, with no server ------------------------------

test('what an assignment and a freelancer may say', () => {
  const badFields = (input) => outsource.validateAssignment(input).errors.map((e) => e.field);
  const ok = { freelancerId: 'f1', projectId: 'p1', decidedManHours: 12 };

  assert.ok(outsource.validateAssignment(ok).ok);
  assert.strictEqual(outsource.validateAssignment(ok).value.decidedManHours, 12);
  assert.strictEqual(outsource.validateAssignment({ ...ok, decidedManHours: '7.5' }).value.decidedManHours, 7.5,
    'a form sends strings');
  assert.strictEqual(outsource.validateAssignment({ ...ok, decidedManHours: 0 }).value.decidedManHours, 0,
    'zero is a real answer: handed over before the hours were settled');

  assert.deepStrictEqual(badFields({ ...ok, decidedManHours: -1 }), ['decidedManHours']);
  assert.deepStrictEqual(badFields({ ...ok, decidedManHours: '' }), ['decidedManHours']);
  assert.deepStrictEqual(badFields({ ...ok, decidedManHours: 99999 }), ['decidedManHours'],
    'five person-years on one assignment is a typo');
  assert.deepStrictEqual(badFields({ projectId: 'p1', decidedManHours: 1 }), ['freelancerId']);
  assert.deepStrictEqual(badFields({ freelancerId: 'f1', decidedManHours: 1 }), ['projectId']);
  assert.deepStrictEqual(badFields({ ...ok, status: 'nonsense' }), ['status']);
  assert.deepStrictEqual(badFields({ ...ok, dueDate: 'next tuesday' }), ['dueDate']);
  assert.strictEqual(outsource.validateAssignment({ ...ok, dueDate: '' }).value.dueDate, null,
    'blank is no due date, not an invalid one');
  assert.strictEqual(outsource.validateAssignment({ ...ok, assetId: '' }).value.assetId, null,
    'and blank is ad hoc work, not a broken link');

  /* NULL IS NOT ZERO for a rate: a freelancer nobody has priced must not cost
     the project nothing. */
  assert.strictEqual(outsource.validateFreelancer({ name: 'A' }).value.ratePerHour, null);
  assert.strictEqual(outsource.validateFreelancer({ name: 'A', ratePerHour: '' }).value.ratePerHour, null);
  assert.strictEqual(outsource.validateFreelancer({ name: 'A', ratePerHour: 0 }).value.ratePerHour, 0,
    'but an explicit zero is a rate somebody chose');
  assert.deepStrictEqual(outsource.validateFreelancer({ name: '' }).errors.map((e) => e.field), ['name']);
  assert.deepStrictEqual(outsource.validateFreelancer({ name: 'A', email: 'nope' }).errors.map((e) => e.field), ['email']);
  assert.deepStrictEqual(outsource.validateFreelancer({ name: 'A', ratePerHour: -5 }).errors.map((e) => e.field), ['ratePerHour']);
});

test('outsourced cost lands in the P&L, and unpriced hours are reported not zeroed', () => {
  const worked = {
    budgetedHours: 100, budgetedCost: 100000,
    recordedHours: 80, recordedCost: 80000,
    recordedUnpricedHours: 0, budgetedUnpricedHours: 0, byRole: [],
  };
  const bill = { totalValue: 200000 };

  const without = pnl.compute({ billing: bill, hours: worked });
  assert.strictEqual(without.outsourcedCost, 0);
  assert.strictEqual(without.combinedCost, 80000);
  assert.strictEqual(without.variance, 20000, 'a saving against the estimate');
  assert.strictEqual(without.actualProfit, 120000);

  const withSent = pnl.compute({
    billing: bill, hours: worked,
    outsource: { hours: 40, cost: 40000, unpricedHours: 0, assignments: 2 },
  });
  assert.strictEqual(withSent.outsourcedHours, 40);
  assert.strictEqual(withSent.outsourcedCost, 40000);
  assert.strictEqual(withSent.combinedCost, 120000, 'its own people plus what it paid outside');
  assert.strictEqual(withSent.variance, -20000, 'and the saving was really an overrun');
  assert.strictEqual(withSent.overBudget, true);
  assert.strictEqual(withSent.actualProfit, 80000, 'profit falls by exactly what the freelancers cost');
  assert.strictEqual(withSent.costPerHour, 1000, 'blended across both kinds of hour');

  /* A freelancer nobody priced contributes hours and no cost, and says so —
     never folded in at zero, which would make the project look cheaper. */
  const unpriced = pnl.compute({
    billing: bill, hours: worked,
    outsource: { hours: 40, cost: 0, unpricedHours: 40, assignments: 1 },
  });
  assert.strictEqual(unpriced.outsourcedHours, 40);
  assert.strictEqual(unpriced.outsourcedCost, 0);
  assert.strictEqual(unpriced.unpricedHours, 40, 'reported, so the screen can say the cost is understated');
});

test('the summary totals by freelancer and by project', () => {
  const rows = [
    { freelancerId: 'a', freelancerName: 'Asha', projectId: 'p1', projectName: 'One', decidedManHours: 10 },
    { freelancerId: 'a', freelancerName: 'Asha', projectId: 'p1', projectName: 'One', decidedManHours: 5 },
    { freelancerId: 'a', freelancerName: 'Asha', projectId: 'p2', projectName: 'Two', decidedManHours: 20 },
    { freelancerId: 'b', freelancerName: 'Bo', projectId: 'p1', projectName: 'One', decidedManHours: 3 },
  ];
  const summary = outsource.summarise(rows);
  assert.strictEqual(summary.length, 2);
  assert.strictEqual(summary[0].freelancerName, 'Asha', 'most hours first');
  assert.strictEqual(summary[0].hours, 35);
  assert.strictEqual(summary[0].assignments, 3);
  assert.deepStrictEqual(summary[0].projects.map((p) => [p.projectName, p.hours]), [['Two', 20], ['One', 15]]);
  assert.strictEqual(summary[1].hours, 3);
});

// --- the tab, end to end ----------------------------------------------------

test('freelancers, assignments and what they cost', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Outsource-Probe-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  let projectA;
  let projectB;
  let assetA;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('artist', 'Ravi Artist', 'ravi@zvky.test', 'game_artist', id.lead);

    const clients = await as('root', '/clients');
    const clientId = clients.body.clients[0].id;
    const mk = async (name, leads) => {
      const r = await as('root', '/projects', {
        method: 'POST', body: { name, clientId, ...(leads ? { teamLeadIds: leads } : {}) } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.project.id;
    };
    projectA = await mk('Cherry Crush', [id.lead]);
    projectB = await mk('Quick Hits');
    const a = await as('root', `/assets/project/${projectA}`, {
      method: 'POST', body: { name: 'Reel A', type: 'prop', manHours: 40 } });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    assetA = a.body.asset.id;
  });
  t.after(() => stopServer(server));

  await t.test('a contributor cannot see the tab at all', async () => {
    assert.strictEqual((await as('artist', '/outsource/assignments')).status, 403);
    assert.strictEqual((await as('artist', '/outsource/freelancers')).status, 403);
    assert.strictEqual((await as('artist', '/outsource/freelancers', {
      method: 'POST', body: { name: 'Sneaky' } })).status, 403);
  });

  await t.test('a freelancer is a record, not an account', async () => {
    const made = await as('root', '/outsource/freelancers', {
      method: 'POST',
      body: { name: 'Asha Freelance', email: 'asha@example.test', discipline: 'Rigging', ratePerHour: 900 } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    id.asha = made.body.freelancer.id;

    /* THE POINT OF "records only": nothing was written to users, so there is no
       account, no password and no designation anywhere in the studio. */
    const asUser = await sql(cfg, "SELECT id FROM users WHERE email = 'asha@example.test'");
    assert.strictEqual(asUser.length, 0, 'a freelancer is not a user');

    const second = await as('root', '/outsource/freelancers', {
      method: 'POST', body: { name: 'Bo Unpriced', discipline: 'Animation' } });
    assert.strictEqual(second.status, 201);
    id.bo = second.body.freelancer.id;
    assert.strictEqual(second.body.freelancer.ratePerHour, null, 'no rate is null, not zero');
  });

  await t.test('pay rates are their own permission, left OUT rather than hidden', async () => {
    /* The lead holds outsource.view and outsource.manage by designation, and
       does NOT hold outsource.rates — which is implied by managePermissions,
       the Super Admin alone. */
    const seen = await as('lead', '/outsource/freelancers');
    assert.strictEqual(seen.status, 200, JSON.stringify(seen.body));
    assert.strictEqual(seen.body.canManage, true, 'they may still assign work');
    assert.strictEqual(seen.body.canSeeRates, false);
    for (const f of seen.body.freelancers) {
      assert.ok(!('ratePerHour' in f),
        `the rate is still in the payload for ${f.name}: ${JSON.stringify(f)}`);
    }
    // And root, who does hold it, sees the figure.
    const root = await as('root', '/outsource/freelancers');
    assert.strictEqual(root.body.canSeeRates, true);
    assert.strictEqual(root.body.freelancers.find((f) => f.id === id.asha).ratePerHour, 900);

    // Setting one is refused, not quietly dropped.
    const tried = await as('lead', `/outsource/freelancers/${id.asha}`, {
      method: 'PUT', body: { name: 'Asha Freelance', ratePerHour: 1 } });
    assert.strictEqual(tried.status, 403, JSON.stringify(tried.body));
    const after = await as('root', '/outsource/freelancers');
    assert.strictEqual(after.body.freelancers.find((f) => f.id === id.asha).ratePerHour, 900,
      'and the rate did not change');
  });

  await t.test('work can be assigned to an asset, or ad hoc with no asset at all', async () => {
    const linked = await as('root', '/outsource/assignments', {
      method: 'POST',
      body: { freelancerId: id.asha, projectId: projectA, assetId: assetA,
        decidedManHours: 30, description: 'Rig the hero prop', dueDate: '2026-11-01' } });
    assert.strictEqual(linked.status, 201, JSON.stringify(linked.body));
    id.linked = linked.body.assignment.id;
    assert.strictEqual(linked.body.assignment.assetCode !== null, true);
    /* The asset's OWN estimate travels beside the decided hours rather than
       being replaced by it. Two numbers about the same work, both visible. */
    assert.strictEqual(linked.body.assignment.assetManHours, 40);
    assert.strictEqual(linked.body.assignment.decidedManHours, 30);

    const adhoc = await as('root', '/outsource/assignments', {
      method: 'POST',
      body: { freelancerId: id.bo, projectId: projectA, decidedManHours: 10,
        description: 'Concept sketches, not a tracked asset' } });
    assert.strictEqual(adhoc.status, 201, JSON.stringify(adhoc.body));
    assert.strictEqual(adhoc.body.assignment.assetId, null);
    id.adhoc = adhoc.body.assignment.id;

    // An asset from another project would cost the wrong project.
    const wrong = await as('root', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.asha, projectId: projectB, assetId: assetA, decidedManHours: 1 } });
    assert.strictEqual(wrong.status, 422);
    assert.strictEqual(wrong.body.errors[0].field, 'assetId');
  });

  await t.test('an inactive freelancer takes no new work', async () => {
    const off = await as('root', `/outsource/freelancers/${id.bo}`, {
      method: 'PUT', body: { name: 'Bo Unpriced', status: 'inactive' } });
    assert.strictEqual(off.status, 200);
    const refused = await as('root', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.bo, projectId: projectA, decidedManHours: 5 } });
    assert.strictEqual(refused.status, 422);
    assert.strictEqual(refused.body.errors[0].field, 'freelancerId');
    // Work already given to them is untouched.
    const still = await as('root', '/outsource/assignments');
    assert.ok(still.body.assignments.some((a) => a.id === id.adhoc), 'their existing assignment remains');
    await as('root', `/outsource/freelancers/${id.bo}`, {
      method: 'PUT', body: { name: 'Bo Unpriced', status: 'active' } });
  });

  await t.test('reach is the role\'s: a lead sees their own projects only', async () => {
    assert.strictEqual((await as('root', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.asha, projectId: projectB, decidedManHours: 8 } })).status, 201);

    const mine = await as('lead', '/outsource/assignments');
    assert.strictEqual(mine.status, 200);
    const projects = [...new Set(mine.body.assignments.map((a) => a.projectId))];
    assert.deepStrictEqual(projects, [projectA],
      'the lead is on Cherry Crush and sees its outsourced work, not the studio\'s');

    const all = await as('root', '/outsource/assignments');
    assert.strictEqual([...new Set(all.body.assignments.map((a) => a.projectId))].length, 2,
      'and a studio-wide designation sees both');

    // Assigning into a project they cannot see is refused.
    const out = await as('lead', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.asha, projectId: projectB, decidedManHours: 4 } });
    assert.strictEqual(out.status, 403, JSON.stringify(out.body));
  });

  await t.test('revising the agreed hours is logged with the old figure', async () => {
    const changed = await as('root', `/outsource/assignments/${id.linked}`, {
      method: 'PUT', body: { decidedManHours: 45, status: 'in_progress' } });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.strictEqual(changed.body.assignment.decidedManHours, 45);

    const log = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'outsource.hours_revised');
    assert.ok(log.length, 'a revision is its own kind of entry');
    assert.match(log[0].summary, /from 30h to 45h/, 'with both figures in the sentence');
    assert.strictEqual(log[0].changes.decidedManHours.from, '30');
    assert.strictEqual(log[0].changes.decidedManHours.to, '45');
    assert.strictEqual(log[0].actor.email, 'root@zvky.test');

    const added = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'outsource.freelancer_added');
    assert.ok(added.length, 'and creating a freelancer is recorded');
    const deact = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'outsource.freelancer_deactivated');
    assert.ok(deact.length, 'as is deactivating one');
  });

  await t.test('THE GAP IT CLOSES: outsourced cost reaches both P&L tabs', async () => {
    /* Cherry Crush now has 45h from Asha at 900/h and 10h from Bo, who has no
       rate. Nobody in the studio logged a second against it, so before this the
       project's cost was zero and its profit was the whole of its value. */
    await as('root', '/pnl/role-rates/game_artist', { method: 'PUT', body: { ratePerHour: 1000 } });
    await as('root', `/pnl/projects/${projectA}/total-value`, {
      method: 'PUT', body: { totalValue: 100000 } });

    const figures = await as('root', `/pnl/projects/${projectA}`);
    assert.strictEqual(figures.status, 200, JSON.stringify(figures.body));
    const t2 = figures.body.totals;
    assert.strictEqual(t2.outsourcedHours, 55, '45 from Asha and 10 from Bo');
    assert.strictEqual(t2.outsourcedCost, 45 * 900, 'costed at the freelancer\'s own rate');
    assert.strictEqual(t2.outsourcedUnpricedHours, 10, 'and Bo\'s hours are reported as unpriced');
    assert.strictEqual(t2.combinedCost, t2.recordedCost + t2.outsourcedCost);
    assert.strictEqual(t2.actualProfit, 100000 - t2.combinedCost,
      'profit is the price less everything the project cost, freelancers included');
    assert.ok(t2.unpricedHours >= 10, 'the unpriced hours are surfaced on the tab');

    // And the studio-wide report agrees with the per-project screen.
    const report = await as('root', `/pnl/report?projectId=${projectA}`);
    assert.strictEqual(report.status, 200);
    const row = report.body.projects.find((p) => p.projectId === projectA);
    assert.strictEqual(row.totals.outsourcedCost, t2.outsourcedCost);
    assert.strictEqual(row.totals.combinedCost, t2.combinedCost);
  });

  await t.test('NO TIMER, NO SESSION, ANYWHERE', async () => {
    /* The studio was explicit: decided man hours is the only hours figure, and
       none of the recording machinery applies. Everything above has created
       freelancers, assigned work, revised hours and costed a P&L. If any of it
       had touched the clock, this is where it would show. */
    const sessions = await sql(cfg, 'SELECT COUNT(*) AS n FROM work_sessions');
    assert.strictEqual(Number(sessions[0].n), 0,
      'outsourced work wrote a work session, which it must never do');

    const cols = await sql(cfg,
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('freelancers','outsource_assignments')
          AND (COLUMN_NAME LIKE '%session%' OR COLUMN_NAME LIKE '%time_spent%'
               OR COLUMN_NAME LIKE '%started_at%' OR COLUMN_NAME LIKE '%seconds%')`);
    assert.deepStrictEqual(cols.map((c) => c.COLUMN_NAME), [],
      'and the tables carry no measured-time column at all');
  });
});
