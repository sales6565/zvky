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

  await t.test('Super Admin holds the new keys without being given them', async () => {
    const mine = (await as('root', '/auth/me')).body.user.permissions;
    for (const key of ['project.close', 'project.delete', 'client.close', 'client.delete']) {
      assert.ok(mine.includes(key), `Super Admin is missing ${key}`);
    }
    assert.deepStrictEqual([...mine].sort(), [...catalog.KEYS].sort());
  });
});
