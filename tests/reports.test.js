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
    /* Submitting has to start the clock first — an asset cannot be handed in
       from Assigned — so it records whatever the request took. On a loaded
       machine that rounds to a second, and this asset stops being the
       no-tracked-time case it is here to be, which took the next two subtests
       down with it. Zero it, so the case is the case regardless of timing. */
    await sql(cfg, `UPDATE work_sessions SET seconds = 0 WHERE asset_id = '${noTime.id}'`);

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

test('the Reports tab is drawn from the same permissions the API checks', () => {
  /* The blind spot: a tab that opens on one key while its endpoints require
     another gives somebody an empty screen, or hides a report they may read.
     
     This used to pin the literal `can('report.view')`, which broke the moment
     the tab legitimately started opening for a second report with its own
     permission. What it actually cares about is that the two agree, so that is
     what it now asserts: every key the tab gate opens for is a key some report
     endpoint requires, and every report endpoint's key opens the tab. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const gate = page.match(/reportsTabBtn:\s*\(\)\s*=>\s*can\(([^)]*)\)/);
  assert.ok(gate, 'the Reports tab should still be gated');
  const opensFor = [...gate[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.ok(opensFor.length, 'on at least one permission');

  const required = new Set();
  for (const file of ['reports.js', 'idle.js']) {
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
    for (const m of route.matchAll(/requirePermission\('(report\.[^']+)'\)/g)) required.add(m[1]);
  }

  assert.deepStrictEqual(opensFor, [...required].sort(),
    'the tab must open for exactly the report permissions the endpoints require');
  assert.ok(opensFor.includes('report.view'), 'including the efficiency report');
  assert.ok(opensFor.includes('report.idle'), 'and the idle report');
});

test('the schema check knows about every table the app queries', () => {
  /* The blind spot this covers: /api/health exists to answer "which schema
     change has not been applied", and it answered "complete" while four were
     missing — because its list had not been kept up. A schema fault the one
     diagnostic built to name it cannot see is worse than no diagnostic.
     
     This does not try to parse every query. It checks the tables and columns
     this build is known to depend on are all declared, which is the part that
     went stale. */
  const required = require('../src/schema-check').REQUIRED;
  assert.ok(Array.isArray(required), 'schema-check should expose what it requires');
  const declared = new Set(required.map((r) => (r.column ? `${r.table}.${r.column}` : r.table)));

  for (const need of [
    'work_sessions', 'work_sessions.round', 'work_sessions.assignment_id',
    'asset_assignments', 'asset_assignments.ended_status',
    'categories', 'assets.category',
    'role_permissions', 'asset_versions', 'asset_events',
  ]) {
    assert.ok(declared.has(need), `${need} is used by this build but /api/health would not notice it missing`);
  }

  // Every entry names the migration step that adds it, so the answer says what
  // to re-run rather than only what is absent.
  for (const entry of required) {
    assert.ok(entry.step && typeof entry.step === 'string', `${entry.table} has no step named`);
  }
});

test('a report refuses rather than reporting zero when the schema is incomplete', () => {
  /* This used to catch a missing table and return an empty report: "0 assets,
     no efficiency" where the truth was "this database cannot answer". A wrong
     answer given confidently is worse than the error it replaced. */
  const fs = require('fs');
  const path = require('path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  assert.ok(!/ER_NO_SUCH_TABLE/.test(route),
    'the reports query must not swallow a missing table into an empty report');
});

test('a database error names itself rather than saying "a database error"', () => {
  /* Twice in a row a studio saw "The server could not complete that request
     because of a database error" and had nothing else to go on — no shell, no
     log, and a health check that said the schema was complete. The reply now
     carries the driver's own message, which names the table or column at
     fault. It describes SCHEMA, not data: no row values, no credentials. */
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  assert.ok(!/error: 'The server could not complete that request because of a database error\.'/.test(server),
    'the opaque message should no longer be what a database fault returns');
  assert.match(server, /The database refused that request: \$\{message/,
    'the driver message belongs in the reply, not only in a log nobody can reach');
  assert.match(server, /ER_BAD_FIELD_ERROR/, 'a missing column is named specifically');
  assert.match(server, /health\/errors/, 'and the reply points at where the recent ones are listed');

  // The recent-faults endpoint is authenticated and behind full access.
  assert.match(server, /app\.get\('\/api\/health\/errors'[\s\S]{0,200}authenticate/);
  assert.match(server, /hasFullAccess\(req\.user\)/);
});

test('the report names a value added by another process', () => {
  /* The reference lists are mirrored in memory and only reloaded when THIS
     process writes to them. Under Passenger there can be several Node workers,
     so a category added by one — or by a script on the host — left the others
     printing "table_game" where the report should say "Table Game". */
  const fs = require('fs');
  const path = require('path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  assert.match(route, /referenceData\.refresh\(db\)/,
    'an unrecognised key should send the mirror back to the database once');
  assert.match(route, /const unnamed = rows\.some/,
    'and only when there is actually a key it cannot name');
});

test('every table is created with the schema\'s own collation', () => {
  /* The failure this prevents: `DEFAULT CHARSET=utf8mb4` with no COLLATE takes
     the SERVER's default — utf8mb4_0900_ai_ci on MySQL 8, utf8mb4_general_ci
     on MariaDB — so a table created without src/db-collation.js disagrees with
     the rest of the schema. Any query comparing a string column across the two
     dies with "Illegal mix of collations", which is what the Reports tab hit
     on clients.id = projects.client_id. A foreign key cannot span the boundary
     either, so the schema also quietly loses constraints it asked for. */
  const fs = require('fs');
  const path = require('path');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');

  const lines = migrate.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/\bCREATE TABLE\b/.test(line)) return;
    if (/^\s*(\/\/|\*|log\()/.test(line)) return;            // comments and log text
    // The reference tables are declared as bare strings and wrapped where they
    // are used, so look at the two lines around the statement.
    const context = lines.slice(Math.max(0, i - 1), i + 1).join('\n');
    if (/applyTableOptions/.test(context)) return;
    if (/^\s*\w+:\s*`CREATE TABLE/.test(line)) return;        // REFERENCE_TABLES entries
    offenders.push(`line ${i + 1}: ${line.trim().slice(0, 70)}`);
  });
  assert.deepStrictEqual(offenders, [],
    `these CREATE TABLE statements bypass applyTableOptions:\n${offenders.join('\n')}`);

  // And every REFERENCE_TABLES entry must be wrapped where it is executed.
  assert.match(migrate, /for \(const sql of Object\.values\(REFERENCE_TABLES\)\) await db\.query\(await applyTableOptions/);
});

test('a collation mismatch is repaired at startup and named until it is', () => {
  const fs = require('fs');
  const path = require('path');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  const check = require('../src/schema-check');

  assert.match(migrate, /ensureCollationConsistency/, 'the repair should exist');
  assert.ok(typeof check.mixedCollations === 'function',
    '/api/health should be able to report a mismatch it could not repair');

  /* Order matters: a foreign key cannot be created between two columns whose
     collations disagree, so the alignment has to happen before any step that
     adds one — otherwise the schema is repaired but stays short a constraint. */
  const steps = migrate.slice(migrate.indexOf('const STEPS = ['));
  const alignment = steps.indexOf("'collation alignment'");
  const clients = steps.indexOf("'client hierarchy'");
  assert.ok(alignment !== -1 && clients !== -1, 'both steps should be registered');
  assert.ok(alignment < clients,
    'collation alignment must run before the step that adds the clients foreign key');
});

test('the brand colour is readable everywhere it is used', () => {
  /* #7f1416 is a DARK red. It is fine as a fill with white on it, and unusable
     as text on this app's dark background — 1.7:1, which is no contrast at all.
     So it is two tokens, and this checks both do the job they are given. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const tokenOf = (name) => {
    const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(page);
    assert.ok(m, `--${name} should be defined`);
    return m[1];
  };
  const hex = (h) => { const v = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
  const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (Math.max(L(a), L(b)) + 0.05) / (Math.min(L(a), L(b)) + 0.05);

  const brand = tokenOf('brand');
  const brandInk = tokenOf('brand-ink');
  const accent = tokenOf('brand-accent');
  const bg = tokenOf('bg');

  assert.strictEqual(brand.toLowerCase(), '#7f1416', 'the studio red');
  assert.ok(ratio(brand, brandInk) >= 4.5,
    `text on the brand fill is ${ratio(brand, brandInk).toFixed(2)}:1, under AA`);
  assert.ok(ratio(accent, bg) >= 4.5,
    `the accent reads ${ratio(accent, bg).toFixed(2)}:1 on the page background, under AA`);

  // The dark red must never be used AS text — that is the mistake this splits.
  assert.ok(!/color:var\(--brand\)[^-]/.test(page),
    'the dark fill colour must not be used as a text colour');
});

test('the workflow colours are untouched and still tell each other apart', () => {
  /* They carry meaning on the Dashboard, so branding does not get to change
     them — and the new accent must not be mistakable for one of them either. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const STATUS = {
    not_started: 'var(--not)', assigned: '#5b8def', in_progress: 'var(--prog)',
    pending_tl_review: 'var(--review)', tl_changes_requested: '#e8402c',
    pending_cd_review: '#9b7ef0', cd_changes_requested: '#e8402c',
    approved_for_client: 'var(--approved)', delivered: 'var(--final)',
  };
  for (const [id, colour] of Object.entries(STATUS)) {
    const row = new RegExp(`id:\\s*'${id}'[^}]*color:\\s*'${colour.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    assert.match(page, row, `${id} should still be ${colour}`);
  }

  // The tokens behind them, unchanged.
  for (const [name, value] of [['not', '#6b7280'], ['prog', '#f2b33d'], ['review', '#9b7ef0'],
    ['approved', '#3ddc97'], ['final', '#d4ff3d']]) {
    assert.match(page, new RegExp(`--${name}:\\s*${value}`), `--${name} should still be ${value}`);
  }

  // And the accent keeps its distance from the nearest of them.
  const hex = (h) => { const v = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
  const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const lab = (h) => {
    const [r, g, b] = hex(h).map(lin);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const dE = (a, b) => { const A = lab(a); const B = lab(b);
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };

  const accent = /--brand-accent:\s*(#[0-9a-fA-F]{6})/.exec(page)[1];
  for (const colour of ['#6b7280', '#5b8def', '#f2b33d', '#9b7ef0', '#e8402c', '#3ddc97', '#d4ff3d']) {
    assert.ok(dE(accent, colour) >= 25,
      `the brand accent is ΔE ${dE(accent, colour).toFixed(0)} from ${colour} — too close to tell apart`);
  }
});
