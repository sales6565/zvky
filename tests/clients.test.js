const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
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
    const systemClient = await systemClientId(server.base, token.root);
    const seed = (await as('root', '/projects', { method: 'POST', body: { clientId: systemClient, name: 'Seed' } })).body.project.id;
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

  await t.test('whoever creates a client can see it, before it holds anything', async () => {
    /* The bug behind "the client I just made is not in the dropdown".
     *
     * Clients are reached through the projects you can see, and a brand-new
     * client has no projects — so for any role that is not studio-wide, the
     * client vanished the instant it was created. In the Add Project form that
     * is worse than an odd list: the client is created in order to put a
     * project under it, and the option to do so was gone.
     *
     * Nine of the sixty designations have studio-wide scope, which is why this
     * held for the accounts that built the feature and not the ones using it. */
    const admin = (await as('root', '/users', { method: 'POST',
      body: { name: 'Amy Admin', email: 'amy@zvky.test', role: 'admin', password: PASSWORD } })).body.user;
    assert.ok(admin, 'the fixture needs a client-creating role that is not studio-wide');
    token.amy = (await call('/auth/login', { method: 'POST',
      body: { email: 'amy@zvky.test', password: PASSWORD } })).body.token;

    const made = await as('amy', '/clients', { method: 'POST', body: { name: 'Zephyr Interactive' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));

    const mine = await listed('amy');
    assert.ok(mine.some((c) => c.name === 'Zephyr Interactive'),
      `the creator cannot see the client they just made: ${JSON.stringify(mine.map((c) => c.name))}`);
    assert.strictEqual((await one(made.body.client.id, 'amy')).name, 'Zephyr Interactive',
      'and can open it');

    /* Which is the whole point: the project it was created for can now be made.
       Without this the inline flow was a dead end, not merely an untidy list. */
    const project = await as('amy', '/projects', { method: 'POST',
      body: { clientId: made.body.client.id, name: 'Aurora Rise' } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
  });

  await t.test('and it is still only reach, not a customer list for everybody', async () => {
    /* The exception is narrow on purpose. Somebody who neither created the
       client nor has work under it still sees nothing — otherwise the fix for
       an empty dropdown would have quietly published the studio's client list
       to every artist. */
    const made = await as('amy', '/clients', { method: 'POST', body: { name: 'Private Holdings' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));

    const artist = await listed('ana');
    assert.ok(!artist.some((c) => c.name === 'Private Holdings'),
      `an artist with no work under it should not see it: ${JSON.stringify(artist.map((c) => c.name))}`);
    /* 404 rather than 403, which is the stronger answer: telling somebody they
       are forbidden from a client confirms it exists. Asserted as "not 200" and
       then pinned, so the intent survives if the convention is ever revisited. */
    const direct = await as('ana', `/clients/${made.body.client.id}`);
    assert.notStrictEqual(direct.status, 200, 'nor open it directly');
    assert.strictEqual(direct.status, 404, 'and is not told it exists');

    // A studio-wide role sees it, as it always did.
    assert.ok((await listed('root')).some((c) => c.name === 'Private Holdings'));
  });

  await t.test('the inline flow and the Add Client screen are one path', async () => {
    /* There is no second creation route to drift: the Add Project form POSTs to
       /clients exactly as the client screen does, so a client made either way
       is the same row with the same creator recorded on it. Asserted through
       the API because that is the thing both buttons call. */
    const inline = await as('amy', '/clients', { method: 'POST', body: { name: 'One Path Co' } });
    assert.strictEqual(inline.status, 201);
    const [row] = await sql(cfg, "SELECT created_by FROM clients WHERE `name` = 'One Path Co'");
    assert.ok(row, 'the client reached the database');
    assert.strictEqual(row.created_by, (await as('amy', '/auth/me')).body.user.id,
      'with the creator recorded, which is what the visibility rule reads');
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

  await t.test('deleting archives by default, and destroys only what is empty', async () => {
    // The convention the value lists set: something with records under it is
    // deactivated, never deleted. ?purge=1 is the deliberate hard delete, and
    // it only works on something holding nothing.
    const acme = await named('Acme Corp');
    const purge = await as('root', `/clients/${acme.id}?purge=1`, { method: 'DELETE' });
    assert.strictEqual(purge.status, 409);
    assert.strictEqual(purge.body.projectCount, 4);
    assert.match(purge.body.error, /archive it instead/i);

    const system = (await listed()).find((c) => c.isSystem);
    const refused = await as('root', `/clients/${system.id}`, { method: 'DELETE' });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /cannot be deleted/i);

    // An empty one archives by default, and is really gone with ?purge=1.
    const quiet = await named('Quiet Co');
    const archived = await as('root', `/clients/${quiet.id}`, { method: 'DELETE' });
    assert.strictEqual(archived.status, 200);
    assert.strictEqual(archived.body.archived, true);
    assert.strictEqual(await named('Quiet Co'), undefined, 'out of the live list');

    const withArchived = (await as('root', '/clients?includeArchived=1')).body.clients;
    const stillThere = withArchived.find((c) => c.name === 'Quiet Co');
    assert.ok(stillThere, 'but still there when asked for');
    assert.strictEqual(stillThere.status, 'archived');

    assert.strictEqual((await as('root', `/clients/${quiet.id}/restore`, { method: 'POST' })).status, 200);
    assert.ok(await named('Quiet Co'), 'and restoring brings it back');

    await as('root', `/clients/${quiet.id}`, { method: 'DELETE' });
    assert.strictEqual((await as('root', `/clients/${quiet.id}?purge=1`, { method: 'DELETE' })).status, 200);
    const gone = (await as('root', '/clients?includeArchived=1')).body.clients;
    assert.ok(!gone.some((c) => c.name === 'Quiet Co'), 'purge really removes it');
  });

  await t.test('the list says how much it is hiding, and each project says whether it is empty', async () => {
    /* Two things the Projects screen needs from this endpoint, and neither was
       here before.
     *
     * The count, because archiving takes a client out of the default list and
       the Delete permanently button only exists once it IS archived — so the
       thing somebody just archived and the button for finishing it off vanish
       together. Reported as the delete option going missing, which is a fair
       reading of it. A list that hides something now says how much.
     *
     * The asset count, because permanent deletion of a project is refused
       unless it holds nothing, and until now the page had no way to know that
       — so it could only offer the button blindly or not at all. It offered it
       not at all, which left the endpoint unreachable from the screen. */
    const spare = (await as('root', '/clients', { method: 'POST', body: { name: 'Countable Co' } })).body.client;

    const before = (await as('root', '/clients')).body;
    assert.strictEqual(before.archivedCount, 0, 'nothing archived, nothing hidden');

    await as('root', `/clients/${spare.id}`, { method: 'DELETE' });
    const after = (await as('root', '/clients')).body;
    assert.ok(!after.clients.some((c) => c.name === 'Countable Co'), 'out of the default list');
    assert.strictEqual(after.archivedCount, 1, 'but the list admits it is hiding one');

    // The same number whether or not the archived ones are being listed.
    assert.strictEqual((await as('root', '/clients?includeArchived=1')).body.archivedCount, 1);
    await as('root', `/clients/${spare.id}?purge=1`, { method: 'DELETE' });

    // And every project row carries what it holds.
    const acme = await named('Acme Corp');
    const detail = (await as('root', `/clients/${acme.id}`)).body.client;
    for (const p of [...detail.projects, ...detail.archivedProjects]) {
      assert.strictEqual(typeof p.assetCount, 'number', `${p.name} should report its asset count`);
    }
  });

  await t.test('an empty project can be deleted outright; one holding work cannot', async () => {
    const acme = await named('Acme Corp');
    const empty = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Nothing Here', clientId: acme.id } })).body.project;

    const detail = () => as('root', `/clients/${acme.id}`).then((r) => r.body.client);
    const rowFor = async (name) => {
      const c = await detail();
      return [...c.projects, ...c.archivedProjects].find((p) => p.name === name);
    };
    assert.strictEqual((await rowFor('Nothing Here')).assetCount, 0);

    // Archive first, then purge — the same two steps the screen offers.
    assert.strictEqual((await as('root', `/projects/${empty.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await as('root', `/projects/${empty.id}?purge=1`, { method: 'DELETE' })).status, 200);
    assert.strictEqual(await rowFor('Nothing Here'), undefined, 'really gone');

    /* A project holding work is refused, and says to archive instead. This is
       what the button's asset-count condition mirrors: offering it here would
       be offering something the server will always refuse. */
    const target = (await detail()).projects[0];
    assert.ok(target, 'a project to put an asset in');
    assert.strictEqual((await as('root', `/assets/project/${target.id}`, { method: 'POST',
      body: { name: 'Ballast', type: 'prop' } })).status, 201);

    const busy = await rowFor(target.name);
    assert.strictEqual(busy.assetCount, 1, 'and the row now says it holds one');
    const refused = await as('root', `/projects/${busy.id}?purge=1`, { method: 'DELETE' });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /archive it instead/i);
    assert.ok(await rowFor(busy.name), 'and it is still there');
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

  await t.test('a project cannot be created without naming a client', async () => {
    // The header pickers and the + Project form both make this true in the UI;
    // this is the half that holds when somebody calls the API directly.
    const res = await as('root', '/projects', { method: 'POST', body: { name: 'Homeless' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.field, 'clientId');

    assert.strictEqual((await as('root', '/projects', {
      method: 'POST', body: { clientId: 'no-such-client', name: 'Homeless' },
    })).status, 400, 'and not by naming one that does not exist');

    assert.ok(!(await as('root', '/projects')).body.projects.some((p) => p.name === 'Homeless'));

    // "Unassigned" now holds only what predates clients — nothing new lands
    // there by accident, which was the point of removing the fallback.
    const system = (await listed()).find((c) => c.isSystem);
    assert.strictEqual((await as('root', '/projects', {
      method: 'POST', body: { clientId: system.id, name: 'Deliberately Unassigned' },
    })).status, 201, 'though it can still be chosen on purpose');
  });

  await t.test('every project reports the client it belongs to', async () => {
    // What the header's Project picker filters on. Without client_id on the
    // row the cascade would need a request per client.
    const projects = (await as('root', '/projects')).body.projects;
    assert.ok(projects.length);
    for (const project of projects) {
      assert.ok(project.client_id, `${project.name} has no client`);
    }
    const acme = await named('Acme Corp');
    const under = projects.filter((p) => p.client_id === acme.id).map((p) => p.name).sort();
    assert.deepStrictEqual(under, acme.projects.map((p) => p.name).sort(),
      'and grouping by it gives the same answer the client endpoint does');
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
