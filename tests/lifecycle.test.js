const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');
const lifecycle = require('../src/lifecycle');
const catalog = require('../src/permission-catalog');

const cfg = config('lifecycle');

// --- the rules, without a database ---------------------------------------------

test('the three states are independent axes', () => {
  const open = { name: 'P', is_active: 1, closed_at: null };
  assert.ok(lifecycle.projectIsOpen(open));
  assert.strictEqual(lifecycle.projectRefusal(open), null);

  assert.ok(!lifecycle.projectIsOpen({ ...open, closed_at: new Date() }));
  assert.match(lifecycle.projectRefusal({ ...open, closed_at: new Date() }), /closed\. Reopen it/);
  assert.ok(!lifecycle.projectIsOpen({ ...open, is_active: 0 }));
  assert.match(lifecycle.projectRefusal({ ...open, is_active: 0 }), /archived\. Restore it/);

  const client = { name: 'C', is_active: 1, deal_closed_at: null };
  assert.ok(lifecycle.clientTakesNewProjects(client));
  assert.match(lifecycle.clientRefusal({ ...client, deal_closed_at: new Date() }), /deal with C is closed/);
  assert.match(lifecycle.clientRefusal({ ...client, is_active: 0 }), /archived/);

  // A closed deal says nothing about whether the client is archived, and a
  // closed project says nothing about its client.
  assert.ok(!lifecycle.clientTakesNewProjects({ ...client, deal_closed_at: new Date() }));
  assert.ok(lifecycle.projectIsOpen(open), 'a project is judged on its own two columns');
});

test('the new permission keys are in the right groups', () => {
  const group = (key) => catalog.GROUPS.find((g) => g.key === key).permissions.map((p) => p.key);
  assert.ok(group('projects').includes('project.close'));
  assert.ok(group('projects').includes('project.delete'));
  assert.ok(group('clients').includes('client.close'));
  assert.ok(group('clients').includes('client.delete'));
});

test('the schema check names every piece this build needs, and the step that adds it', async () => {
  // A unit test rather than a live one: dropping a table out from under a
  // running server blocks on a metadata lock, and the point here is the
  // mapping from "what is missing" to "which step to re-run", not the DDL.
  const check = require('../src/schema-check');
  const stub = (tables, columns) => ({
    query: async (sql) => (/FROM information_schema.TABLES/.test(sql)
      ? { rows: tables.map((t) => ({ t })) }
      : { rows: columns.map(([t, c]) => ({ t, c })) }),
  });

  const everything = [...new Set(check.REQUIRED.map((r) => r.table))];
  const allColumns = check.REQUIRED.filter((r) => r.column).map((r) => [r.table, r.column]);
  assert.deepStrictEqual(await check.missing(stub(everything, allColumns)), [],
    'a complete schema reports nothing missing');

  // One column gone — the shape of the outage.
  const withoutOne = allColumns.filter(([t, c]) => !(t === 'tasks' && c === 'created_by'));
  assert.deepStrictEqual(await check.missing(stub(everything, withoutOne)), [{
    name: 'tasks.created_by', kind: 'column', step: 'asset brief and checklist',
  }]);

  // A whole table gone is reported once, not once per column it holds.
  const withoutTable = everything.filter((t) => t !== 'work_sessions');
  const gaps = await check.missing(stub(withoutTable, allColumns));
  assert.deepStrictEqual(gaps, [{ name: 'work_sessions', kind: 'table', step: 'assigned state and time tracking' }]);

  // And every entry names a real migration step, so the hint is actionable.
  const steps = new Set(require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'src', 'migrate.js'), 'utf8')
    .match(/\['[^']+', ensure[A-Za-z]+\]/g)
    .map((m) => m.slice(2, m.indexOf("',"))));
  for (const need of check.REQUIRED) {
    assert.ok(steps.has(need.step), `"${need.step}" is not a step in migrate.js`);
  }
});

test('the schema check covers constraints, not just tables and columns', async () => {
  // The gap that let a broken deployment report itself healthy: every table
  // and column was present, so the check said "complete", while the status
  // CHECK constraint still refused 'assigned' — and both of the studio's
  // commonest writes failed with a database error.
  const check = require('../src/schema-check');
  const stub = (clause) => ({
    query: async (sql) => (/CHECK_CONSTRAINTS/.test(sql)
      ? { rows: [{ n: 'chk_assets_status', c: clause }] }
      : { rows: [] }),
  });

  const current = "`status` in ('not_started','assigned','in_progress','delivered')";
  assert.deepStrictEqual(await check.staleConstraints(stub(current)), [],
    'a widened constraint is not reported');

  const stale = "`status` in ('not_started','in_progress','delivered')";
  const gaps = await check.staleConstraints(stub(stale));
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].name, 'chk_assets_status');
  assert.strictEqual(gaps[0].kind, 'constraint');
  assert.strictEqual(gaps[0].step, 'assigned state and time tracking');
  assert.match(gaps[0].detail, /does not allow "assigned"/);

  // A database that will not report its constraints raises no false alarm.
  const silent = { query: async () => { throw new Error('no such view'); } };
  assert.deepStrictEqual(await check.staleConstraints(silent), []);
});

test('the constraint rebuild acts when it cannot confirm the constraint is current', () => {
  // The bug: the old code read the constraint's text and, when the read
  // returned nothing, concluded there was nothing to do. On a database where
  // the constraint was real but unreadable, the rebuild never ran and every
  // write landing an asset in 'assigned' failed. Unknown must not read as
  // "already fine" — asserted from the source, because the failure only
  // appears on a database that hides its constraints.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');

  // And the clause is normalized before it is read: MySQL 8 escapes the quotes
  // in CHECK_CLAUSE, which is how a clause-based search still missed one.
  assert.match(source, /normalizeCheckClause\(r\.clause\)/,
    'the status clause must be normalized before it is matched');

  assert.match(source, /const stale = await staleStatusConstraints\(db\);/,
    'the constraints are looked up before deciding');
  assert.match(source, /if \(stale === null \|\| stale\.length\) \{/,
    'unknown must act, not be treated as already fine');
  // And it verifies afterwards rather than assuming the ALTER worked.
  assert.match(source, /const after = await staleStatusConstraints\(db\)/);
  // And it finds them by what they constrain, never by their name — a stale
  // constraint under another name is still enforced.
  assert.doesNotMatch(source, /CONSTRAINT_NAME = 'chk_assets_status'/,
    'looking the constraint up by name is what let a stale one survive');
});

test('a CHECK clause reads the same whichever engine wrote it', () => {
  const { normalizeCheckClause } = require('../src/schema-check');

  // How MySQL 8 renders it: a charset introducer, and escaped quotes. This is
  // the rendering that defeated a clause-based search and let an auto-named
  // constraint (assets_chk_2) go on rejecting 'assigned'.
  const mysql8 = "(`status` in (_utf8mb4\\'not_started\\',_utf8mb4\\'in_progress\\'))";
  // How MariaDB renders the identical constraint.
  const mariadb = "`status` in ('not_started','in_progress')";

  for (const [engine, clause] of [['MySQL 8', mysql8], ['MariaDB', mariadb]]) {
    const normalized = normalizeCheckClause(clause);
    assert.ok(normalized.includes("'not_started'"), `${engine}: a listed value is found`);
    assert.ok(normalized.includes("'in_progress'"), `${engine}: and so is the next one`);
    assert.ok(!normalized.includes("'assigned'"), `${engine}: an absent value is still absent`);
    assert.ok(!normalized.includes('_utf8mb4'), `${engine}: the introducer is gone`);
    assert.ok(!normalized.includes("\\'"), `${engine}: the quotes are unescaped`);
  }

  // The wide constraint this build writes must read as current under both.
  const wide = "(`status` in (_utf8mb4\\'not_started\\',_utf8mb4\\'assigned\\'))";
  assert.ok(normalizeCheckClause(wide).includes("'assigned'"),
    'a constraint that does admit assigned must not be rebuilt every boot');
});

// --- against a live server -----------------------------------------------------

test('client and project lifecycle', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Lifecycle-Test-1!';
  let server;
  let systemClient;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const listed = async (opts = '') => (await as('root', `/clients${opts}`)).body.clients;
  const named = async (name, opts = '') => (await listed(opts)).find((c) => c.name === name);
  const projectsOf = async (who = 'root') => (await as(who, '/projects')).body.projects;

  async function newClientWith(name, projects) {
    const res = await as('root', '/clients', { method: 'POST', body: { name, projects } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { id: res.body.client.id, projects: res.body.projects };
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'life-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'life-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    systemClient = await systemClientId(server.base, token.root);

    const seed = (await as('root', '/projects', {
      method: 'POST', body: { clientId: systemClient, name: 'Seed' },
    })).body.project.id;
    for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId: seed },
      });
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    await as('root', `/users/${people.ana}`, {
      method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee },
    });
  });

  t.after(() => stopServer(server));

  // --- closing a project ---------------------------------------------------------

  await t.test('a closed project takes no new work and its assets go read-only', async () => {
    const { id: clientId, projects } = await newClientWith('Closing Co', [{ name: 'Winding Down' }]);
    const projectId = projects[0].id;
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'In Flight', type: 'character', assigneeId: people.ana },
    })).body.asset;

    // Undelivered work asks once before it goes read-only.
    const warned = await as('root', `/projects/${projectId}/close`, { method: 'POST', body: {} });
    assert.strictEqual(warned.status, 409);
    assert.strictEqual(warned.body.requiresConfirmation, true);
    assert.strictEqual(warned.body.unfinished, 1);
    assert.match(warned.body.error, /read-only/);

    const closed = await as('root', `/projects/${projectId}/close`, { method: 'POST', body: { confirm: true } });
    assert.strictEqual(closed.status, 200);

    // Every write path, not a sample of them.
    const refusals = [
      ['POST', `/assets/project/${projectId}`, { name: 'Late Addition', type: 'prop' }],
      ['PATCH', `/assets/${asset.id}`, { description: 'tweak' }],
      ['DELETE', `/assets/${asset.id}`, undefined],
      ['POST', `/assets/${asset.id}/tasks`, { name: 'Another step' }],
      ['POST', `/assets/${asset.id}/notes`, { text: 'a thought' }],
      ['POST', `/assets/${asset.id}/submit`, { link: 'https://example.test/v1', description: 'done' }],
      ['POST', `/assets/${asset.id}/review`, { decision: 'approved' }],
      ['POST', `/assets/${asset.id}/deliver`, {}],
      ['POST', `/assets/${asset.id}/reassign`, { assigneeId: people.ana }],
    ];
    for (const [method, path, body] of refusals) {
      const res = await as('root', path, { method, body });
      assert.strictEqual(res.status, 409, `${method} ${path} was allowed`);
      assert.strictEqual(res.body.projectClosed, true);
    }
    // Including the artist's own checklist.
    const seen = (await as('root', `/assets/project/${projectId}`)).body.assets[0];
    assert.strictEqual((await as('ana', `/assets/tasks/${seen.tasks[0].id}`, {
      method: 'PATCH', body: { done: true },
    })).status, 409);

    // Reading is untouched — that is the point of closing rather than deleting.
    assert.strictEqual((await as('root', `/assets/project/${projectId}`)).status, 200);
    assert.strictEqual((await as('root', `/assets/${asset.id}/history`)).status, 200);
    assert.strictEqual((await as('root', '/projects')).body.projects.filter((p) => p.id === projectId).length, 1,
      'and a closed project is still listed — it is finished, not hidden');

    // Reopening restores everything.
    assert.strictEqual((await as('root', `/projects/${projectId}/reopen`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Late Addition', type: 'prop' },
    })).status, 201);
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'done' },
    })).status, 201);

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('closing a project with nothing in flight does not ask twice', async () => {
    const { id: clientId, projects } = await newClientWith('Quiet Close Co', [{ name: 'Empty' }]);
    const res = await as('root', `/projects/${projects[0].id}/close`, { method: 'POST', body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.unfinished, 0);
    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  // --- archiving -----------------------------------------------------------------

  await t.test('archiving a project keeps every asset and its history', async () => {
    const { id: clientId, projects } = await newClientWith('Archive Co', [{ name: 'Old Work' }]);
    const projectId = projects[0].id;
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Kept', type: 'character', assigneeId: people.ana },
    })).body.asset;
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    });

    const warned = await as('root', `/projects/${projectId}`, { method: 'DELETE' });
    assert.strictEqual(warned.status, 409);
    assert.strictEqual(warned.body.requiresConfirmation, true);
    assert.strictEqual(warned.body.unfinished, 1);

    const done = await as('root', `/projects/${projectId}?confirm=1`, { method: 'DELETE' });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.archived, true);
    assert.strictEqual(done.body.assetCount, 1);

    // Out of every list, and out of every scope.
    assert.ok(!(await projectsOf()).some((p) => p.id === projectId));
    assert.ok(!(await projectsOf('ana')).some((p) => p.id === projectId));
    assert.strictEqual((await as('root', `/assets/project/${projectId}`)).status, 403,
      'and unreachable while archived, since it is out of scope');

    // But nothing was destroyed.
    const rows = await sql(cfg, `SELECT COUNT(*) AS n FROM assets WHERE project_id = '${projectId}'`);
    assert.strictEqual(Number(rows[0].n), 1, 'the asset is still in the database');
    const versions = await sql(cfg, `SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(versions[0].n), 1, 'and so is the submission');
    const events = await sql(cfg, `SELECT COUNT(*) AS n FROM asset_events WHERE asset_id = '${asset.id}'`);
    assert.ok(Number(events[0].n) >= 2, 'and the review history');

    // Restoring brings it back exactly as it was.
    assert.strictEqual((await as('root', `/projects/${projectId}/restore`, { method: 'POST' })).status, 200);
    const back = (await as('root', `/assets/project/${projectId}`)).body.assets;
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].versions.length, 1);
    assert.strictEqual(back[0].status, 'pending_tl_review', 'and at the same stage');

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('a project holding assets cannot be purged, only archived', async () => {
    const { id: clientId, projects } = await newClientWith('Purge Co', [{ name: 'Has Work' }, { name: 'Empty One' }]);
    const busy = projects.find((p) => p.name === 'Has Work').id;
    const empty = projects.find((p) => p.name === 'Empty One').id;
    await as('root', `/assets/project/${busy}`, { method: 'POST', body: { name: 'A', type: 'prop' } });

    const refused = await as('root', `/projects/${busy}?purge=1`, { method: 'DELETE' });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.assetCount, 1);
    assert.match(refused.body.error, /archive it instead/i);

    assert.strictEqual((await as('root', `/projects/${empty}?purge=1`, { method: 'DELETE' })).status, 200);
    const gone = await sql(cfg, `SELECT COUNT(*) AS n FROM projects WHERE id = '${empty}'`);
    assert.strictEqual(Number(gone[0].n), 0, 'an empty project really is deleted');

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('archiving a client warns about live projects, then takes them with it', async () => {
    const { id: clientId, projects } = await newClientWith('Big Co', [{ name: 'One' }, { name: 'Two' }]);

    const warned = await as('root', `/clients/${clientId}`, { method: 'DELETE' });
    assert.strictEqual(warned.status, 409);
    assert.strictEqual(warned.body.requiresConfirmation, true);
    assert.deepStrictEqual(warned.body.activeProjects.map((p) => p.name).sort(), ['One', 'Two']);
    assert.match(warned.body.error, /mark the deal closed instead/);

    const done = await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.archived, true);

    assert.strictEqual(await named('Big Co'), undefined, 'gone from the live list');
    for (const p of projects) {
      assert.ok(!(await projectsOf()).some((x) => x.id === p.id), `${p.name} went with it`);
    }
    const kept = await sql(cfg, `SELECT COUNT(*) AS n FROM projects WHERE client_id = '${clientId}'`);
    assert.strictEqual(Number(kept[0].n), 2, 'but both rows are still there');

    const archived = await named('Big Co', '?includeArchived=1');
    assert.ok(archived);
    assert.strictEqual(archived.status, 'archived');
    assert.strictEqual(archived.archivedProjects.length, 2);

    assert.strictEqual((await as('root', `/clients/${clientId}/restore`, { method: 'POST' })).status, 200);
    const restored = await named('Big Co');
    assert.strictEqual(restored.projectCount, 2, 'and restoring brings the projects back too');

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('a project archived on its own stays archived when its client comes back', async () => {
    const { id: clientId, projects } = await newClientWith('Mixed Co', [{ name: 'Keep' }, { name: 'Already Gone' }]);
    const gone = projects.find((p) => p.name === 'Already Gone').id;
    await as('root', `/projects/${gone}?confirm=1`, { method: 'DELETE' });
    await new Promise((r) => setTimeout(r, 1100)); // archived_at is second-resolution

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
    await as('root', `/clients/${clientId}/restore`, { method: 'POST' });

    // The detail view is what the Projects tab reads, and it always lists the
    // archived ones so they can be found and restored.
    const back = (await as('root', `/clients/${clientId}`)).body.client;
    assert.deepStrictEqual(back.projects.map((p) => p.name), ['Keep'],
      'the one archived separately was a separate decision');
    assert.deepStrictEqual(back.archivedProjects.map((p) => p.name), ['Already Gone']);

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  // --- the deal ------------------------------------------------------------------

  await t.test('a closed deal stops new projects and leaves the running ones alone', async () => {
    const { id: clientId, projects } = await newClientWith('Deal Co', [{ name: 'Running' }]);
    const projectId = projects[0].id;
    await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Ongoing', type: 'prop', assigneeId: people.ana },
    });

    const closed = await as('root', `/clients/${clientId}/close-deal`, { method: 'POST' });
    assert.strictEqual(closed.status, 200);
    assert.deepStrictEqual(closed.body.stillRunning.map((p) => p.name), ['Running'],
      'and it says so rather than leaving somebody to wonder');

    const badge = await named('Deal Co');
    assert.strictEqual(badge.status, 'deal_closed');
    assert.strictEqual(badge.takesNewProjects, false);

    // No new projects, through either door.
    const direct = await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Nope' } });
    assert.strictEqual(direct.status, 409);
    assert.match(direct.body.error, /deal with Deal Co is closed/);
    const viaClient = await as('root', `/clients/${clientId}`, {
      method: 'PATCH', body: { projects: [{ name: 'Nope' }] },
    });
    assert.strictEqual(viaClient.status, 409);
    // Nor by moving an existing one onto it.
    const other = (await as('root', '/projects', { method: 'POST', body: { clientId: systemClient, name: 'Elsewhere' } })).body.project.id;
    assert.strictEqual((await as('root', `/projects/${other}`, { method: 'PATCH', body: { clientId } })).status, 409);

    // The work already there is completely unaffected — this is the decision
    // flagged as "leave projects independent".
    assert.strictEqual((await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Still Fine', type: 'prop' },
    })).status, 201, 'a running project under a closed deal keeps running');

    assert.strictEqual((await as('root', `/clients/${clientId}/reopen-deal`, { method: 'POST' })).status, 200);
    assert.strictEqual((await named('Deal Co')).status, 'active');
    assert.strictEqual((await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Now Fine' } })).status, 201);

    await as('root', `/projects/${other}?confirm=1`, { method: 'DELETE' });
    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('the placeholder client has no deal to close', async () => {
    const res = await as('root', `/clients/${systemClient}/close-deal`, { method: 'POST' });
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /no deal to close/);
  });

  // --- permissions ---------------------------------------------------------------

  await t.test('every lifecycle action needs its own permission', async () => {
    const { id: clientId, projects } = await newClientWith('Perms Co', [{ name: 'Guarded' }]);
    const projectId = projects[0].id;

    for (const [method, path] of [
      ['POST', `/projects/${projectId}/close`],
      ['POST', `/projects/${projectId}/reopen`],
      ['DELETE', `/projects/${projectId}`],
      ['POST', `/projects/${projectId}/restore`],
      ['POST', `/clients/${clientId}/close-deal`],
      ['POST', `/clients/${clientId}/reopen-deal`],
      ['DELETE', `/clients/${clientId}`],
      ['POST', `/clients/${clientId}/restore`],
    ]) {
      assert.strictEqual((await as('ana', path, { method })).status, 403, `${method} ${path}`);
    }

    // A Team Lead granted project.close can close, and still cannot archive.
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/team_lead', {
      method: 'PUT', body: { confirm: true, permissions: [...new Set([...held, 'project.close'])] },
    });
    // Reach still applies: the lead did not create this project.
    assert.strictEqual((await as('lee', `/projects/${projectId}/close`, { method: 'POST', body: {} })).status, 403,
      'the permission says whether, projectScope says which');
    assert.strictEqual((await as('lee', `/projects/${projectId}`, { method: 'DELETE' })).status, 403);
    await as('root', '/permissions/roles/team_lead/reset', { method: 'POST', body: {} });

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('health says whether every schema repair applied', async () => {
    // A partially-applied migration used to be visible only in the server log,
    // and code assuming a column that never arrived blanked the whole app.
    // /api/health now answers the question from a URL.
    const res = await call('/health', {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.schemaRepairs, { applied: true });
    assert.deepStrictEqual(res.body.schema, { complete: true });
  });

  await t.test('a stale status constraint is named, not reported as a mystery', async () => {
    // Both of the studio's commonest writes — creating an asset with an
    // assignee, and assigning an existing one — land it in 'assigned'. When
    // the constraint has not been widened, both fail; the message now says
    // which constraint and where to look.
    // MariaDB validates existing rows when a CHECK is added, and this suite has
    // assets sitting in 'assigned'. Park them while the narrow constraint is in
    // place, exactly as a real database would have had none of them yet.
    await sql(cfg, "UPDATE assets SET `status` = 'not_started' WHERE `status` = 'assigned'");
    await sql(cfg, 'ALTER TABLE assets DROP CONSTRAINT chk_assets_status');
    await sql(cfg, `ALTER TABLE assets ADD CONSTRAINT chk_assets_status CHECK (\`status\` IN (
      'not_started','in_progress','pending_tl_review','tl_changes_requested',
      'pending_cd_review','cd_changes_requested','approved_for_client','delivered'))`);

    const health = await call('/health', {});
    assert.strictEqual(health.body.ok, false);
    assert.strictEqual(health.body.schema.missing.length, 1);
    assert.match(health.body.schema.missing[0], /chk_assets_status \(constraint\)/);
    assert.match(health.body.schema.missing[0], /does not allow "assigned"/);

    const { id: clientId, projects } = await newClientWith('Constraint Co', [{ name: 'Blocked' }]);
    const project = projects[0].id;
    const refused = await as('root', `/assets/project/${project}`, {
      method: 'POST', body: { name: 'Cannot Assign', type: 'prop', assigneeId: people.ana },
    });
    assert.strictEqual(refused.status, 500);
    assert.strictEqual(refused.body.constraint, 'chk_assets_status',
      'the response names the constraint rather than saying "a database error"');
    assert.match(refused.body.error, /has not been updated for this version/);
    assert.match(refused.body.error, /api\/health/);

    // Unassigned creation is unaffected, which is why only some actions broke.
    assert.strictEqual((await as('root', `/assets/project/${project}`, {
      method: 'POST', body: { name: 'Fine', type: 'prop' },
    })).status, 201);

    await sql(cfg, 'ALTER TABLE assets DROP CONSTRAINT chk_assets_status');
    await sql(cfg, `ALTER TABLE assets ADD CONSTRAINT chk_assets_status CHECK (\`status\` IN (
      'not_started','assigned','in_progress','pending_tl_review','tl_changes_requested',
      'pending_cd_review','cd_changes_requested','approved_for_client','delivered'))`);
    assert.deepStrictEqual((await call('/health', {})).body.schema, { complete: true });

    // And with it widened, both actions work.
    const made = await as('root', `/assets/project/${project}`, {
      method: 'POST', body: { name: 'Now Fine', type: 'prop', assigneeId: people.ana },
    });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.asset.status, 'assigned');

    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('health names the missing piece, and the asset list still draws', async () => {
    // The outage in one line: the app runs against a schema it does not have,
    // and every endpoint touching the gap answers "a database error" with no
    // clue which gap. Two things had to change — the gap gets named, and a
    // missing enrichment stops taking the studio's main screen down with it.
    await sql(cfg, 'ALTER TABLE tasks DROP FOREIGN KEY fk_tasks_author');
    await sql(cfg, 'ALTER TABLE tasks DROP COLUMN created_by');

    const health = await call('/health', {});
    assert.strictEqual(health.body.ok, false);
    assert.deepStrictEqual(health.body.schema.missing, ['tasks.created_by (column)']);
    assert.deepStrictEqual(health.body.schema.steps, ['asset brief and checklist']);

    // The board used to answer 500 here. Who added a checklist item is a
    // label; the asset list is the app.
    const { id: clientId, projects } = await newClientWith('Schema Gap Co', [{ name: 'Still Draws' }]);
    const project = projects[0].id;
    await as('root', `/assets/project/${project}`, {
      method: 'POST', body: { name: 'Survives', type: 'prop', assigneeId: people.ana },
    });
    const assets = await as('root', `/assets/project/${project}`);
    assert.strictEqual(assets.status, 200, JSON.stringify(assets.body));
    assert.ok(Array.isArray(assets.body.assets));
    for (const asset of assets.body.assets) {
      assert.ok(Array.isArray(asset.tasks), 'and the checklist still comes back');
    }

    await sql(cfg, 'ALTER TABLE tasks ADD COLUMN created_by CHAR(36) NULL');
    assert.deepStrictEqual((await call('/health', {})).body.schema, { complete: true });
    await as('root', `/clients/${clientId}?confirm=1`, { method: 'DELETE' });
  });

  await t.test('Super Admin holds the new keys without being given them', async () => {
    const mine = (await as('root', '/auth/me')).body.user.permissions;
    for (const key of ['project.close', 'project.delete', 'client.close', 'client.delete']) {
      assert.ok(mine.includes(key), `Super Admin is missing ${key}`);
    }
    assert.deepStrictEqual([...mine].sort(), [...catalog.KEYS].sort());
  });
});
