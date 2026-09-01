const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const { supervisionRoles, entries } = require('../src/roles');

const cfg = config('supervision');

/* Supervision and Creative Direction on a project.
 *
 * Two questions decide whether this feature works, and they are different
 * questions: WHO the section offers, and HOW MANY of them it takes.
 *
 * The first is the one worth guarding hardest. The section is a filtered list,
 * and a filter that is too narrow does not look broken — it looks like the
 * person you wanted is not in the studio. So the role list is asserted against
 * the catalogue's own groups rather than against a copy of itself.
 */

// --- who the section offers, without a database --------------------------------

test('the section offers supervision and creative direction, and nothing else', () => {
  const offered = new Set(supervisionRoles());
  const all = entries();

  // Every role in either group, whatever it is called. A role added to
  // Supervision in Settings tomorrow has to appear without a code change.
  for (const role of all) {
    const inGroup = role.group === 'Supervision' || role.group === 'Creative Direction';
    if (inGroup) {
      assert.ok(offered.has(role.key),
        `${role.label} is in ${role.group} and should be offered`);
    }
  }

  // The named roles, spelled out. This is the half a group rename would break
  // silently, and the section going empty is the failure the studio would see.
  for (const key of ['art_supervisor', 'art_director', 'associate_art_director',
    'creative_art_director', 'associate_animation_supervisor', 'technical_manager',
    'team_lead', 'senior_team_lead', 'associate_team_lead']) {
    assert.ok(offered.has(key), `${key} should be offered`);
  }

  // Creative Producer sits in Production, so no group rule reaches it. It is
  // offered because the studio asked for it by name — an exception, and the
  // only one.
  assert.strictEqual(entries().find((r) => r.key === 'creative_producer').group, 'Production',
    'if Creative Producer has moved group, the exception in src/roles.js is now redundant');
  assert.ok(offered.has('creative_producer'));

  // Nothing else from Production, and nothing from the contributor groups: this
  // is a list of who is answerable for the work, not of who does it.
  for (const key of ['producer', 'coordinator', 'senior_producer', 'project_manager',
    'game_artist', 'senior_game_artist', 'game_animator', 'unity_developer',
    'junior_accountant', 'cto']) {
    assert.ok(!offered.has(key), `${key} should not be offered`);
  }
});

// --- against a live server -----------------------------------------------------

test('naming supervision and creative direction on a project', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Supervision-Test-1!';
  let server;
  let clientId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  // A project with whatever supervision it was given, and the ids it came back with.
  const create = (supervisionIds, name = `P${Math.random().toString(36).slice(2, 8)}`) =>
    as('root', '/projects', { method: 'POST', body: { clientId, name, supervisionIds } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'supervision-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'supervision-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);

    for (const [who, role] of [
      ['sup', 'art_supervisor'],
      ['dir', 'art_director'],
      ['prod', 'creative_producer'],
      ['third', 'associate_art_director'],
      ['artist', 'game_artist'],
    ]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('two people are saved and come back on the project', async () => {
    const res = await create([people.sup, people.dir], 'Nightgarden');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(
      [...res.body.project.supervisionIds].sort(),
      [people.sup, people.dir].sort(),
      'the create response should say who was saved, not just that it worked');

    // And on the way back out, which is what ticks the boxes on the edit form.
    const read = await as('root', `/projects/${res.body.project.id}`);
    assert.deepStrictEqual([...read.body.project.supervisionIds].sort(),
      [people.sup, people.dir].sort());
  });

  await t.test('naming nobody is allowed, and is not the same as naming everybody', async () => {
    const res = await create([], 'Empty');
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body.project.supervisionIds, []);

    // The field is optional in the body too — a caller that has never heard of
    // it must still be able to create a project.
    const bare = await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Bare' } });
    assert.strictEqual(bare.status, 201);
    assert.deepStrictEqual(bare.body.project.supervisionIds, []);
  });

  await t.test('a third person is refused, and nothing is written', async () => {
    const res = await create([people.sup, people.dir, people.third], 'Crowded');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.field, 'supervisionIds');
    assert.match(res.body.error, /2 people at most/,
      'the message should say what the limit is, not just that the request was bad');

    // The whole request fails, rather than the project appearing with the first
    // two attached: the browser disables the boxes past two, so anything
    // reaching here with three came from outside the form.
    const all = (await as('root', '/projects')).body.projects;
    assert.ok(!all.some((p) => p.name === 'Crowded'), 'the project should not exist at all');
  });

  await t.test('the same person twice is one person, not two', async () => {
    // Otherwise a duplicated id would eat the second slot, and INSERT IGNORE
    // would quietly write one row for a request that looked full.
    const res = await create([people.sup, people.sup], 'Doubled');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.project.supervisionIds, [people.sup]);
  });

  await t.test('somebody outside those designations is refused by name', async () => {
    const res = await create([people.artist], 'Wrong');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /artist is not in a supervision or creative direction designation/,
      'the message should name who was rejected — the form offers several people at once');

    const gone = await create(['no-such-user'], 'Ghost');
    assert.strictEqual(gone.status, 400);
    assert.match(gone.body.error, /no longer exists/);
  });

  await t.test('creative producer is accepted, being the one role outside both groups', async () => {
    const res = await create([people.prod], 'Producer led');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.project.supervisionIds, [people.prod]);
  });

  await t.test('editing replaces the list wholesale', async () => {
    const made = await create([people.sup], 'Editable');
    const id = made.body.project.id;

    const swapped = await as('root', `/projects/${id}`, {
      method: 'PATCH', body: { supervisionIds: [people.dir, people.third] },
    });
    assert.strictEqual(swapped.status, 200, JSON.stringify(swapped.body));
    assert.deepStrictEqual([...swapped.body.project.supervisionIds].sort(),
      [people.dir, people.third].sort(), 'the person who was there is gone, not kept');

    // Unticking both is a real answer and has to be writable.
    const cleared = await as('root', `/projects/${id}`, { method: 'PATCH', body: { supervisionIds: [] } });
    assert.deepStrictEqual(cleared.body.project.supervisionIds, []);

    // And an edit that does not mention the field leaves it alone — the other
    // two lists behave that way, and renaming a project must not empty it.
    await as('root', `/projects/${id}`, { method: 'PATCH', body: { supervisionIds: [people.sup] } });
    const renamed = await as('root', `/projects/${id}`, { method: 'PATCH', body: { name: 'Renamed' } });
    assert.deepStrictEqual(renamed.body.project.supervisionIds, [people.sup]);
  });

  await t.test('an edit past the limit changes nothing at all', async () => {
    const made = await create([people.sup], 'Guarded');
    const id = made.body.project.id;

    const res = await as('root', `/projects/${id}`, {
      method: 'PATCH',
      body: { name: 'Renamed by the same request', supervisionIds: [people.sup, people.dir, people.third] },
    });
    assert.strictEqual(res.status, 400);

    // The rename rode along in the rejected request. It must not have landed:
    // the check runs before the transaction opens.
    const read = (await as('root', `/projects/${id}`)).body.project;
    assert.strictEqual(read.name, 'Guarded');
    assert.deepStrictEqual(read.supervisionIds, [people.sup]);
  });

  await t.test('being named on a project is enough to see it', async () => {
    // An art supervisor's designation reaches a project through the people
    // reporting to them. Named on the project and holding nobody's work, they
    // would otherwise be attached to something they could not open.
    const res = await create([people.sup], 'Supervised');
    const id = res.body.project.id;

    const theirs = (await as('sup', '/projects')).body.projects;
    assert.ok(theirs.some((p) => p.id === id),
      'the supervisor named on the project should see it in their list');
    assert.strictEqual((await as('sup', `/projects/${id}`)).status, 200);

    // Not a permission grant, though: somebody not named on it is unaffected.
    const others = (await as('third', '/projects')).body.projects;
    assert.ok(!others.some((p) => p.id === id));
  });

  await t.test('the rows are really rows, and go when the project does', async () => {
    const res = await create([people.sup, people.dir], 'Disposable');
    const id = res.body.project.id;
    const before = await sql(cfg, `SELECT * FROM project_supervision WHERE project_id = '${id}'`);
    assert.strictEqual(before.length, 2);

    // A hard delete of an empty project, so the foreign key has to cascade
    // rather than refuse.
    const gone = await as('root', `/projects/${id}?purge=1`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    const after = await sql(cfg, `SELECT * FROM project_supervision WHERE project_id = '${id}'`);
    assert.strictEqual(after.length, 0, 'the rows should go with the project');
  });
});
