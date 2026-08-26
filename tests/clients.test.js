const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const clients = require('../src/clients');

const cfg = config('clients');

// --- validation, without a database --------------------------------------------

test('a client needs a name and little else', () => {
  assert.ok(!clients.validateClient({}).ok);
  assert.strictEqual(clients.validateClient({}).errors[0].field, 'name');
  assert.ok(!clients.validateClient({ name: '   ' }).ok);
  assert.ok(clients.validateClient({ name: 'Acme' }).ok, 'a name alone is enough');

  const full = clients.validateClient({
    name: '  Acme Corp ', contactName: ' Jo ', contactEmail: ' jo@acme.test ', notes: ' hi ',
  });
  assert.ok(full.ok);
  assert.deepStrictEqual(full.values,
    { name: 'Acme Corp', contactName: 'Jo', notes: 'hi', contactEmail: 'jo@acme.test' },
    'and everything is trimmed');

  assert.ok(!clients.validateClient({ name: 'A', contactEmail: 'not-an-address' }).ok);
  assert.ok(!clients.validateClient({ name: 'x'.repeat(clients.NAME_MAX + 1) }).ok);

  // An edit sends only what changed; absent is not blank.
  assert.ok(clients.validateClient({ notes: 'later' }, { partial: true }).ok);
  assert.ok(!clients.validateClient({ name: '' }, { partial: true }).ok,
    'but sending a blank name is still a blank name');
});

test('project rows are checked as a set, and every problem is reported at once', () => {
  assert.ok(clients.validateProjectRows(undefined).ok, 'no rows at all is fine — zero projects is allowed');
  assert.deepStrictEqual(clients.validateProjectRows([]).values, []);

  const good = clients.validateProjectRows([{ name: ' One ' }, { name: 'Two', teamLeadIds: ['u1'] }]);
  assert.ok(good.ok);
  assert.deepStrictEqual(good.values.map((v) => v.name), ['One', 'Two']);
  assert.deepStrictEqual(good.values[1].teamLeadIds, ['u1']);

  // Three separate problems, each carrying the row it came from — a form with
  // five rows cannot mark the right one without the index.
  const bad = clients.validateProjectRows([
    { name: 'Fine' }, { name: '' }, { name: 'Dupe' }, { name: 'dupe' }, { name: 'Bad', teamLeadIds: 'nope' },
  ]);
  assert.ok(!bad.ok);
  assert.deepStrictEqual(bad.errors.map((e) => e.index), [1, 3, 4]);
  assert.match(bad.errors[1].error, /named twice/);
  assert.match(bad.errors[2].error, /list of user ids/);

  // And against what the client already holds.
  const clash = clients.validateProjectRows([{ name: 'Nightgarden' }], { existingNames: ['Nightgarden'] });
  assert.ok(!clash.ok);
  assert.match(clash.errors[0].error, /already exists under this client/);
});

// --- against a live server -----------------------------------------------------

test('clients and their projects', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Clients-Test-1!';
  let server;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const listed = async (who = 'root') => (await as(who, '/clients')).body.clients;
  const one = async (id, who = 'root') => (await as(who, `/clients/${id}`)).body.client;
  const named = async (name) => (await listed()).find((c) => c.name === name);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'clients-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'clients-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');

    // Somebody needs a project to be attached to before they can be created on
    // one, so the placeholder client's first project does that job.
    const seed = (await as('root', '/projects', { method: 'POST', body: { name: 'Seed' } })).body.project.id;
    for (const [who, role] of [['pat', 'producer'], ['ana', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId: seed },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('the migration leaves one system client holding everything', async () => {
    const all = await listed();
    const system = all.filter((c) => c.isSystem);
    assert.strictEqual(system.length, 1, 'exactly one placeholder');
    assert.strictEqual(system[0].name, 'Unassigned');
    assert.ok(system[0].projects.some((p) => p.name === 'Seed'),
      'and a project created without naming a client lands in it');
  });

  await t.test('a client is created with several projects in one submission', async () => {
    const res = await as('root', '/clients', {
      method: 'POST',
      body: {
        name: 'Acme Corp', contactName: 'Jo Diaz', contactEmail: 'jo@acme.test', notes: 'Q3 slate',
        projects: [{ name: 'Nightgarden' }, { name: 'Tin Rain' }, { name: 'Skyfall' }],
      },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.projects.length, 3);

    const acme = await one(res.body.client.id);
    assert.deepStrictEqual(acme.projects.map((p) => p.name).sort(),
      ['Nightgarden', 'Skyfall', 'Tin Rain']);
    assert.strictEqual(acme.projectCount, 3);
    assert.strictEqual(acme.contactName, 'Jo Diaz');
    assert.strictEqual(acme.contactEmail, 'jo@acme.test');

    // And they really are projects, not just rows on a client.
    const projects = (await as('root', '/projects')).body.projects;
    assert.ok(projects.some((p) => p.name === 'Nightgarden' && p.client_id === acme.id));
  });

  await t.test('zero projects is a complete submission', async () => {
    assert.strictEqual((await as('root', '/clients', {
      method: 'POST', body: { name: 'Quiet Co' },
    })).status, 201);
    assert.strictEqual((await named('Quiet Co')).projectCount, 0);
  });

  await t.test('one bad row saves nothing at all', async () => {
    const res = await as('root', '/clients', {
      method: 'POST',
      body: { name: 'Broken Co', projects: [{ name: 'Good' }, { name: '' }, { name: 'Also Good' }] },
    });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body.errors.map((e) => e.index), [1], 'and says which row');

    assert.strictEqual(await named('Broken Co'), undefined, 'no half-made client');
    const projects = (await as('root', '/projects')).body.projects;
    assert.ok(!projects.some((p) => p.name === 'Good' || p.name === 'Also Good'),
      'and none of the rows that were fine');
  });

  await t.test('a duplicate client name is refused', async () => {
    const res = await as('root', '/clients', { method: 'POST', body: { name: 'Acme Corp' } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.field, 'name');
  });

  await t.test('editing a client adds projects without disturbing the ones there', async () => {
    const acme = await named('Acme Corp');
    const before = acme.projects.map((p) => p.id).sort();

    const res = await as('root', `/clients/${acme.id}`, {
      method: 'PATCH', body: { notes: 'Q3 and Q4', projects: [{ name: 'Cold Harbour' }] },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.added.map((p) => p.name), ['Cold Harbour']);

    const after = await one(acme.id);
    assert.strictEqual(after.projectCount, 4);
    assert.strictEqual(after.notes, 'Q3 and Q4', 'the client fields changed too');
    assert.strictEqual(after.name, 'Acme Corp', 'and what was not sent did not');
    for (const id of before) {
      assert.ok(after.projects.some((p) => p.id === id), 'every project that was there still is');
    }
  });

  await t.test('an edit uses the same rules as a create', async () => {
    const acme = await named('Acme Corp');
    // Same validation module, so the same three refusals.
    const dupeInside = await as('root', `/clients/${acme.id}`, {
      method: 'PATCH', body: { projects: [{ name: 'New One' }, { name: 'new one' }] },
    });
    assert.strictEqual(dupeInside.status, 400);
    assert.match(dupeInside.body.errors[0].error, /named twice/);

    const dupeExisting = await as('root', `/clients/${acme.id}`, {
      method: 'PATCH', body: { projects: [{ name: 'Tin Rain' }] },
    });
    assert.strictEqual(dupeExisting.status, 400);
    assert.match(dupeExisting.body.error, /already exists under this client/);

    // And a bad row leaves the client fields alone as well as the projects.
    const withRename = await as('root', `/clients/${acme.id}`, {
      method: 'PATCH', body: { name: 'Acme Renamed', projects: [{ name: '' }] },
    });
    assert.strictEqual(withRename.status, 400);
    assert.strictEqual((await one(acme.id)).name, 'Acme Corp', 'the rename did not go through either');
    assert.strictEqual((await one(acme.id)).projectCount, 4);
  });

  await t.test('a client can only be deleted once it is empty, and never the system one', async () => {
    const acme = await named('Acme Corp');
    const busy = await as('root', `/clients/${acme.id}`, { method: 'DELETE' });
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.projectCount, 4);

    const system = (await listed()).find((c) => c.isSystem);
    const refused = await as('root', `/clients/${system.id}`, { method: 'DELETE' });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /cannot be deleted/i);

    const quiet = await named('Quiet Co');
    assert.strictEqual((await as('root', `/clients/${quiet.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual(await named('Quiet Co'), undefined);
  });

  await t.test('a project can be moved to another client', async () => {
    // How the Unassigned pile gets sorted out.
    const acme = await named('Acme Corp');
    const system = (await listed()).find((c) => c.isSystem);
    const seed = system.projects.find((p) => p.name === 'Seed');

    assert.strictEqual((await as('root', `/projects/${seed.id}`, {
      method: 'PATCH', body: { clientId: acme.id },
    })).status, 200);
    assert.strictEqual((await one(acme.id)).projectCount, 5);
    assert.strictEqual((await one(system.id)).projectCount, 0);

    assert.strictEqual((await as('root', `/projects/${seed.id}`, {
      method: 'PATCH', body: { clientId: 'no-such-client' },
    })).status, 400);
    // Put it back, so the fixture's users keep a project.
    await as('root', `/projects/${seed.id}`, { method: 'PATCH', body: { clientId: system.id } });
  });

  await t.test('the client list is scoped the way projects are', async () => {
    // A contributor sees the clients whose projects they have work in, not the
    // studio's customer list.
    const mine = await listed('ana');
    assert.ok(!mine.some((c) => c.name === 'Acme Corp'),
      'a client whose projects they cannot see is not listed');
    assert.strictEqual((await as('ana', `/clients/${(await named('Acme Corp')).id}`)).status, 404);
    assert.ok((await listed('root')).some((c) => c.name === 'Acme Corp'), 'while root sees it');
  });

  await t.test('adding projects through a client needs the project permission too', async () => {
    // "Add a client" and "add a project" are different things to be trusted
    // with, and one form doing both is not a way around the second.
    const enabled = (await as('root', '/permissions/roles/producer')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/producer', {
      method: 'PUT',
      body: { confirm: true, permissions: [...new Set([...enabled, 'client.add', 'client.edit'])].filter((k) => k !== 'project.add') },
    });

    const res = await as('pat', '/clients', {
      method: 'POST', body: { name: 'Half Rights Co', projects: [{ name: 'Nope' }] },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.field, 'projects');
    assert.strictEqual((await as('pat', '/clients', {
      method: 'POST', body: { name: 'Half Rights Co' },
    })).status, 201, 'the client alone is still allowed');

    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('every client action is refused without its permission', async () => {
    const acme = await named('Acme Corp');
    // A Game Artist holds client.view by default and nothing else.
    for (const [method, path, body] of [
      ['POST', '/clients', { name: 'Sneaky Co' }],
      ['PATCH', `/clients/${acme.id}`, { name: 'Renamed' }],
      ['DELETE', `/clients/${acme.id}`],
    ]) {
      assert.strictEqual((await as('ana', path, { method, body })).status, 403, `${method} ${path}`);
    }
    assert.strictEqual((await as('ana', '/clients')).status, 200, 'but the list itself is open');

    // And with client.view switched off, not even that.
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { confirm: true, permissions: held.filter((k) => k !== 'client.view') },
    });
    assert.strictEqual((await as('ana', '/clients')).status, 403);
    await as('root', '/permissions/roles/game_artist/reset', { method: 'POST', body: {} });
  });
});
