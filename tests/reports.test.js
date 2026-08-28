const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const reports = require('../src/reports');
const catalog = require('../src/permission-catalog');

const cfg = config('reports');

// --- the arithmetic, checked against numbers worked out by hand --------------

test('efficiency is the estimate over the actual, as a percentage', () => {
  // 8 hours estimated, 8 hours spent -> exactly on the nose.
  assert.strictEqual(reports.efficiencyOf(8, 8 * 3600), 100);
  // 8 estimated, 4 spent -> took half the time, so twice as efficient.
  assert.strictEqual(reports.efficiencyOf(8, 4 * 3600), 200);
  // 8 estimated, 16 spent -> twice as long as planned.
  assert.strictEqual(reports.efficiencyOf(8, 16 * 3600), 50);
  // 10 estimated, 12.5 spent -> 80%, which is the outlier line.
  assert.strictEqual(reports.efficiencyOf(10, 12.5 * 3600), 80);
});

test('an efficiency that cannot honestly be given is null, not zero', () => {
  /* Zero would drag every average it touched towards nothing, and 100 would
     say "on estimate" about an asset nobody estimated. Both are lies a report
     should not tell, so these are excluded and counted instead. */
  assert.strictEqual(reports.efficiencyOf(null, 3600), null, 'no estimate');
  assert.strictEqual(reports.efficiencyOf(0, 3600), null, 'a zero estimate');
  assert.strictEqual(reports.efficiencyOf(8, 0), null, 'no tracked time — and no divide by zero');
  assert.strictEqual(reports.efficiencyOf(8, null), null);
  assert.strictEqual(reports.efficiencyOf('nonsense', 3600), null);
});

test('an asset is excluded for one stated reason', () => {
  const base = { submitted: true, manHours: 4, totalSeconds: 3600 };
  assert.strictEqual(reports.exclusionReason(base), null);
  assert.strictEqual(reports.exclusionReason({ ...base, submitted: false }), 'never submitted');
  assert.strictEqual(reports.exclusionReason({ ...base, manHours: null }), 'no Man Hours estimate');
  assert.strictEqual(reports.exclusionReason({ ...base, totalSeconds: 0 }), 'no tracked time');
});

test('first pass and total differ exactly by the rework', () => {
  /* Hand-worked: estimated 10 hours. The first pass took 8, then two rounds of
     rework added 4 more, so 12 in total.
       first pass = 10 / 8  = 125%
       total      = 10 / 12 = 83.3%
     The gap between them is the rework, and it is the whole reason both are
     reported: 125% alone says the estimate was good, 83% alone says it was
     not, and only together do they say the estimate was fine and the work came
     back twice. */
  const { included, excluded } = reports.prepare([{
    id: 'a1', code: 'FX-001', name: 'Reworked', submitted: true,
    manHours: 10, firstPassSeconds: 8 * 3600, totalSeconds: 12 * 3600,
  }]);
  assert.strictEqual(excluded.length, 0);
  assert.strictEqual(included[0].firstPass, 125);
  assert.strictEqual(included[0].total, 83.3);
});

test('with no rework the two numbers are the same', () => {
  const { included } = reports.prepare([{
    id: 'a1', code: 'PRP-001', name: 'Clean run', submitted: true,
    manHours: 6, firstPassSeconds: 5 * 3600, totalSeconds: 5 * 3600,
  }]);
  assert.strictEqual(included[0].firstPass, 120);
  assert.strictEqual(included[0].total, 120);
});

test('a group average is the mean of its assets, not weighted by size', () => {
  /* One big asset should not speak for somebody's whole quarter: "they usually
     run over" is a statement about assets, so each asset is one observation. */
  assert.strictEqual(reports.mean([100, 50]), 75);
  assert.strictEqual(reports.mean([100, null, 50]), 75, 'a missing value is skipped, not counted as zero');
  assert.strictEqual(reports.mean([null, null]), null, 'and a group with nothing real in it has no average');
});

test('grouping counts what it could not place rather than inventing a group', () => {
  const assets = [
    { category: 'slot', categoryLabel: 'Slot', firstPass: 100, total: 100, manHours: 4, totalSeconds: 3600 },
    { category: 'slot', categoryLabel: 'Slot', firstPass: 50, total: 50, manHours: 4, totalSeconds: 3600 },
    { category: null, firstPass: 90, total: 90, manHours: 4, totalSeconds: 3600 },
  ];
  const { groups, ungrouped } = reports.groupBy(assets, (a) => a.category, (a) => a.categoryLabel);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].assets, 2);
  assert.strictEqual(groups[0].total, 75);
  assert.strictEqual(ungrouped, 1, 'the uncategorised asset is counted, not filed under "null"');
});

test('groups come back worst first, with unknowns last', () => {
  const assets = [
    { k: 'good', total: 130, firstPass: 130 },
    { k: 'bad', total: 60, firstPass: 60 },
    { k: 'unknown', total: null, firstPass: null },
  ];
  const { groups } = reports.groupBy(assets, (a) => a.k, (a) => a.k);
  assert.deepStrictEqual(groups.map((g) => g.key), ['bad', 'good', 'unknown']);
});

test('an outlier needs to be both bad and repeated', () => {
  /* One asset that ran long is an anecdote. Flagging it would make the report
     cry wolf, and a report nobody trusts is worse than no report. */
  assert.strictEqual(reports.isOutlier({ total: 60, assets: 5 }), true);
  assert.strictEqual(reports.isOutlier({ total: 60, assets: 1 }), false, 'one asset is not a pattern');
  assert.strictEqual(reports.isOutlier({ total: 95, assets: 9 }), false, 'and slightly over is not a problem');
  assert.strictEqual(reports.isOutlier({ total: null, assets: 9 }), false, 'nor is unknown');
});

test('the trend buckets by the week or month the work landed in', () => {
  const row = { finishedAt: '2026-03-18T10:00:00Z' };
  assert.strictEqual(reports.periodKey(row, 'month'), '2026-03');
  assert.strictEqual(reports.periodKey(row, 'week'), '2026-W12');
  assert.strictEqual(reports.periodKey({ finishedAt: null }, 'week'), null);

  const points = reports.trend([
    { finishedAt: '2026-03-18T10:00:00Z', total: 50, firstPass: 50 },
    { finishedAt: '2026-01-05T10:00:00Z', total: 150, firstPass: 150 },
  ], 'month');
  assert.deepStrictEqual(points.map((p) => p.key), ['2026-01', '2026-03'],
    'a trend read out of order is not a trend');
});

test('build produces every breakdown the tab draws', () => {
  const report = reports.build([
    { id: '1', code: 'A-1', name: 'One', submitted: true, manHours: 10,
      firstPassSeconds: 8 * 3600, totalSeconds: 12 * 3600,
      assigneeId: 'u1', assigneeName: 'Anna', category: 'slot', categoryLabel: 'Slot',
      type: 'fx', typeLabel: 'FX', projectId: 'p1', projectName: 'Proj', clientId: 'c1',
      clientName: 'Client', finishedAt: '2026-03-18T10:00:00Z', rounds: 3, contributors: 2 },
    { id: '2', code: 'A-2', name: 'Two', submitted: false, manHours: 4, totalSeconds: 0 },
  ]);
  assert.strictEqual(report.summary.assets, 1);
  assert.strictEqual(report.summary.excluded, 1);
  assert.strictEqual(report.excluded[0].reason, 'never submitted');
  for (const key of ['byUser', 'byCategory', 'byScope', 'byProject', 'byClient']) {
    assert.strictEqual(report.groups === undefined, true);
    assert.strictEqual(report[key].groups.length, 1, `${key} should have one group`);
  }
  assert.strictEqual(report.byUser.groups[0].label, 'Anna');
  assert.strictEqual(report.byUser.groups[0].handedOver, 1,
    'a By User row says when its work passed through more than one pair of hands');
  assert.strictEqual(report.trend.length, 1);
  assert.strictEqual(report.assets[0].rounds, 3);
});

test('View Reports is a real permission, held by full access and grantable', () => {
  assert.ok(catalog.isPermission('report.view'));
  assert.ok(catalog.grantableKeys().includes('report.view'), 'a Super Admin can grant it to other roles');
  const { capabilitiesForTier } = require('../src/role-tiers');
  assert.ok(catalog.baselineFor(capabilitiesForTier('super_admin')).has('report.view'));
  assert.ok(catalog.baselineFor(capabilitiesForTier('full_access')).has('report.view'));
  assert.ok(!catalog.baselineFor(capabilitiesForTier('staff')).has('report.view'),
    'and not something an ordinary contributor gets by default');
});

// --- against a live server ---------------------------------------------------

test('efficiency reports', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Reports-Test-1!';
  let server; let root; let projectId; let clientId;
  const tokens = {};
  const people = {};

  const call = (path, opts) => api(server.base, path, opts);
  const as = (who, path, opts = {}) => call(path, { ...opts, token: tokens[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tok' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    tokens.root = root;
    clientId = await systemClientId(server.base, root);
    projectId = (await call('/projects', { method: 'POST', token: root,
      body: { clientId, name: 'Reported' } })).body.project.id;

    for (const [who, role, lead] of [['lee', 'team_lead', null], ['anna', 'game_artist', 'lee'],
                                     ['ben', 'game_artist', 'lee']]) {
      const made = await call('/users', { method: 'POST', token: root,
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId,
                ...(lead ? { teamLeadId: people[lead] } : {}) } });
      people[who] = made.body.user.id;
      tokens[who] = (await call('/auth/login', { method: 'POST',
        body: { email: `${who}@zvky.test`, password: PASSWORD } })).body.token;
    }
  });
  t.after(() => stopServer(server));

  /* Real seconds are too slow to build a report from, so the sessions are
     written straight to work_sessions with the durations the test needs. That
     is the same table the timer writes, with the same `round` meaning, so the
     query under test is exercised exactly as it is in production. */
  const logWork = async (assetId, round, seconds, userId) => {
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
       VALUES (UUID(), '${assetId}', '${userId}', ${round}, NOW(), NOW(), ${seconds})`);
  };

  const makeAsset = async (name, { manHours, category, type = 'prop', assignee = 'anna' }) => {
    const made = await call(`/assets/project/${projectId}`, { method: 'POST', token: root,
      body: { name, type, manHours, ...(category ? { category } : {}),
              assigneeId: people[assignee] } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    return made.body.asset;
  };
  const submit = async (assetId, who, link) => {
    await as(who, `/assets/${assetId}/timer/start`, { method: 'POST' });
    const r = await as(who, `/assets/${assetId}/submit`, { method: 'POST', body: { link } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
  };

  await t.test('a simple case matches the hand calculation', async () => {
    // 10 hours estimated, 5 hours tracked, one pass -> 200%.
    const asset = await makeAsset('Simple', { manHours: 10 });
    await logWork(asset.id, 1, 5 * 3600, people.anna);
    await submit(asset.id, 'anna', 'https://example.test/simple');

    const { body } = await as('root', '/reports/efficiency');
    const row = body.assets.find((a) => a.name === 'Simple');
    assert.ok(row, JSON.stringify(body.excluded));
    assert.strictEqual(row.manHours, 10);
    assert.strictEqual(row.totalHours, 5);
    assert.strictEqual(row.firstPass, 200);
    assert.strictEqual(row.total, 200, 'with no rework the two are the same');
  });

  await t.test('a reworked case separates first pass from total', async () => {
    /* 10 estimated. 8 hours on the first pass, sent back, 4 more on the second.
         first pass = 10 / 8  = 125%
         total      = 10 / 12 = 83.3%  */
    const asset = await makeAsset('Reworked', { manHours: 10 });
    await logWork(asset.id, 1, 8 * 3600, people.anna);
    await submit(asset.id, 'anna', 'https://example.test/rework-1');
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST',
      body: { decision: 'changes_requested', text: 'again please' } });
    await logWork(asset.id, 2, 4 * 3600, people.anna);
    await submit(asset.id, 'anna', 'https://example.test/rework-2');

    const { body } = await as('root', '/reports/efficiency');
    const row = body.assets.find((a) => a.name === 'Reworked');
    assert.ok(row, JSON.stringify(body.excluded));
    assert.strictEqual(row.firstPassHours, 8);
    assert.strictEqual(row.totalHours, 12);
    assert.strictEqual(row.firstPass, 125);
    assert.strictEqual(row.total, 83.3);
    assert.strictEqual(row.rounds, 2, 'and it says how many rounds that took');
  });

  await t.test('assets missing an estimate or time are excluded, with the reason', async () => {
    const noEstimate = await makeAsset('No Estimate', { manHours: null });
    await logWork(noEstimate.id, 1, 3600, people.anna);
    await submit(noEstimate.id, 'anna', 'https://example.test/no-estimate');

    const noTime = await makeAsset('No Time', { manHours: 5 });
    await submit(noTime.id, 'anna', 'https://example.test/no-time');

    await makeAsset('Never Submitted', { manHours: 5 });

    const { body } = await as('root', '/reports/efficiency');
    const reasonFor = (name) => (body.excluded.find((e) => e.name === name) || {}).reason;
    assert.strictEqual(reasonFor('No Estimate'), 'no Man Hours estimate');
    assert.strictEqual(reasonFor('No Time'), 'no tracked time');
    assert.strictEqual(reasonFor('Never Submitted'), 'never submitted');
    for (const name of ['No Estimate', 'No Time', 'Never Submitted']) {
      assert.ok(!body.assets.some((a) => a.name === name), `${name} must not be averaged in`);
    }
  });

  await t.test('the breakdowns roll the same assets up every way', async () => {
    const { body } = await as('root', '/reports/efficiency');
    // Simple 200% and Reworked 83.3% -> mean 141.7 on total.
    assert.strictEqual(body.summary.assets, 2);
    assert.strictEqual(body.summary.total, 141.7);
    assert.strictEqual(body.summary.firstPass, 162.5, '(200 + 125) / 2');

    assert.strictEqual(body.byUser.groups.length, 1);
    assert.strictEqual(body.byUser.groups[0].label, 'anna');
    assert.strictEqual(body.byUser.groups[0].assets, 2);
    assert.strictEqual(body.byUser.groups[0].total, 141.7);
    assert.strictEqual(body.byProject.groups[0].label, 'Reported');
    assert.strictEqual(body.byScope.groups[0].label, 'Prop', 'labelled the way the studio names it');
    assert.ok(body.byClient.groups.length >= 1);
  });

  await t.test('filters narrow the same report', async () => {
    const other = await call('/projects', { method: 'POST', token: root,
      body: { clientId, name: 'Other Project' } });
    const elsewhere = await call(`/assets/project/${other.body.project.id}`, { method: 'POST', token: root,
      body: { name: 'Elsewhere', type: 'fx', manHours: 4, assigneeId: people.ben } });
    await logWork(elsewhere.body.asset.id, 1, 2 * 3600, people.ben);
    await submit(elsewhere.body.asset.id, 'ben', 'https://example.test/elsewhere');

    const all = (await as('root', '/reports/efficiency')).body;
    assert.strictEqual(all.summary.assets, 3);

    const byProject = (await as('root', `/reports/efficiency?projectId=${projectId}`)).body;
    assert.strictEqual(byProject.summary.assets, 2, 'the project filter drops the other project');

    const byUser = (await as('root', `/reports/efficiency?assigneeId=${people.ben}`)).body;
    assert.strictEqual(byUser.summary.assets, 1);
    assert.strictEqual(byUser.assets[0].name, 'Elsewhere');

    const byScope = (await as('root', '/reports/efficiency?scope=fx')).body;
    assert.deepStrictEqual(byScope.assets.map((a) => a.name), ['Elsewhere']);

    const future = (await as('root', '/reports/efficiency?from=2099-01-01')).body;
    assert.strictEqual(future.summary.assets, 0, 'a date range with nothing in it reports nothing');

    const monthly = (await as('root', '/reports/efficiency?grain=month')).body;
    assert.ok(monthly.trend.every((p) => /^\d{4}-\d{2}$/.test(p.key)), 'months, not weeks');
  });

  await t.test('the tab is closed to a role without View Reports', async () => {
    assert.strictEqual((await as('anna', '/reports/efficiency')).status, 403,
      'an artist cannot read the studio\'s efficiency figures');
    assert.strictEqual((await as('lee', '/reports/efficiency')).status, 403,
      'nor a team lead, until it is granted');

    // And granting it in Settings opens it, without changing their tier.
    // The screen sends the whole set a role should hold, so add to what it has.
    const current = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const granted = await as('root', '/permissions/roles/team_lead', {
      method: 'PUT', body: { permissions: [...new Set([...current, 'report.view'])] },
    });
    assert.ok(granted.status < 400, JSON.stringify(granted.body));
    assert.strictEqual((await as('lee', '/reports/efficiency')).status, 200,
      'once granted, the lead can read it');
  });

  await t.test('a report never reaches a project the reader cannot open', async () => {
    /* The permission says what you may look at, never how much of the studio.
       
       mo is a lead with report.view, no reports and no project — so the query
       is scoped to nothing and the report is empty rather than studio-wide.
       (lee is NOT the test for this: ben reports to lee and has an asset in the
       other project, so lee's team scope legitimately reaches it.) */
    const mo = await call('/users', { method: 'POST', token: root,
      body: { name: 'mo', email: 'mo@zvky.test', role: 'team_lead', password: PASSWORD } });
    assert.strictEqual(mo.status, 201, JSON.stringify(mo.body));
    tokens.mo = (await call('/auth/login', { method: 'POST',
      body: { email: 'mo@zvky.test', password: PASSWORD } })).body.token;

    const seen = await as('mo', '/reports/efficiency');
    assert.strictEqual(seen.status, 200, 'the grant reaches them — team_lead holds it now');
    assert.strictEqual(seen.body.scope.projects, 0);
    assert.deepStrictEqual(seen.body.assets, [], 'and it reports on nothing they cannot open');

    // Meanwhile lee, who does lead people on both, sees both.
    const leeSees = (await as('lee', '/reports/efficiency')).body;
    assert.ok(leeSees.assets.some((a) => a.name === 'Elsewhere'),
      'a lead does see the projects their own reports work on');
  });
});

test('every gated tab button is actually applied at boot', () => {
  /* The bug this covers: the list of gates applied when the page loads was
     typed out by hand in two places. Adding the Reports tab to UI_GATES but
     not to both copies left it hidden from everyone including Super Admin —
     a new tab that simply never appears, with nothing to indicate why.
     
     Both sites now derive the list, and this checks they do, so the next tab
     cannot be added into the same hole. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const gates = page.slice(page.indexOf('const UI_GATES = {'));
  const ids = [...gates.slice(0, gates.indexOf('};')).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  const tabIds = ids.filter((id) => id.endsWith('TabBtn'));
  assert.ok(tabIds.length >= 5, `expected several gated tabs, found ${tabIds.join(', ')}`);
  assert.ok(tabIds.includes('reportsTabBtn'), 'the Reports tab should be gated');

  // Nowhere may hand-write a list of tab buttons to apply.
  const handWritten = page.match(/\[[^\]]*'\w+TabBtn'[^\]]*\]\.forEach\(id=>applyGate/g);
  assert.strictEqual(handWritten, null,
    `a hand-written gate list will go stale: ${handWritten && handWritten[0]}`);

  // And the derived one has to exist and be used at both sites.
  assert.match(page, /const TAB_GATE_IDS = Object\.keys\(UI_GATES\)/);
  const uses = page.match(/\[\.\.\.TAB_GATE_IDS[^\]]*\]\.forEach\(id=>applyGate\(id\)\)/g) || [];
  assert.strictEqual(uses.length, 2,
    'both the boot-time pass and the permission refresh should apply the derived list');
});

test('the Reports tab is drawn from the same permission the API checks', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /reportsTabBtn:\s*\(\)\s*=>\s*can\('report\.view'\)/,
    'the tab gate must ask for the same key the endpoint requires');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  assert.match(route, /requirePermission\('report\.view'\)/);
});
