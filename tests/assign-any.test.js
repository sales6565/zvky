const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, systemClientId } = require('/home/user/zvky/tests/helpers');

const cfg = config('assignany');

test('Assign Work to Anyone, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Assign-Any-1!';
  let server; let projectId; let otherProjectId;
  const token = {}; const people = {};
  const call = (p, o) => api(server.base, p, o);
  const as = (who, p, o = {}) => call(p, { ...o, token: token[who] });

  // Everything a role holds, as the screen sends it back.
  const permsOf = async (role) => (await as('root', `/permissions/roles/${role}`))
    .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  const setPerms = async (role, keys) => {
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: keys } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tok' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await call('/projects', { token: token.root, method: 'POST',
      body: { clientId, name: 'Main' } })).body.project.id;
    otherProjectId = (await call('/projects', { token: token.root, method: 'POST',
      body: { clientId, name: 'Elsewhere' } })).body.project.id;

    for (const [who, role, proj] of [
      ['pat', 'producer', projectId],          // creates the assets
      ['coord', 'coordinator', projectId],     // the test role
      ['lee', 'team_lead', projectId],
      ['ana', 'game_artist', projectId],
      ['bo', 'game_artist', projectId],
      ['far', 'game_artist', otherProjectId],  // on the other project only
    ]) {
      const res = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId: proj } });
      assert.strictEqual(res.status, 201, `${who}: ${JSON.stringify(res.body)}`);
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });
  t.after(() => stopServer(server));

  const newAsset = async (who, name, assignee) => (await as(who, `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', manHours: 4, ...(assignee ? { assigneeId: assignee } : {}) },
  })).body.asset;
  const assigneeOf = async (id) => ((await as('root', `/assets/project/${projectId}`))
    .body.assets.find((a) => a.id === id) || {}).assignee_id;

  await t.test('a role with neither permission cannot assign anything', async () => {
    await setPerms('coordinator', (await permsOf('coordinator'))
      .filter((k) => k !== 'asset.assign' && k !== 'asset.assign_any'));
    const asset = await newAsset('pat', 'Neither', people.ana);

    const patch = await as('coord', `/assets/${asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual(patch.status, 403, JSON.stringify(patch.body));
    assert.strictEqual(await assigneeOf(asset.id), people.ana, 'and nothing moved');
  });

  await t.test('granting only the broad one lets them assign an asset they did not create', async () => {
    const before = await permsOf('coordinator');
    assert.ok(!before.includes('asset.assign'), 'the test role has no ownership-based permission');
    await setPerms('coordinator', [...before, 'asset.assign_any']);

    const asset = await newAsset('pat', 'Not Mine', people.ana);
    assert.notStrictEqual(asset.created_by, people.coord, 'somebody else created it');

    const patch = await as('coord', `/assets/${asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
    assert.strictEqual(await assigneeOf(asset.id), people.bo);

    // Including an unassigned one, which is the ordinary case.
    const bare = await newAsset('pat', 'Nobody On It', null);
    const second = await as('coord', `/assets/${bare.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana } });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(await assigneeOf(bare.id), people.ana);
  });

  await t.test('and during a change request, where handing on is the action', async () => {
    const asset = await newAsset('pat', 'In Rework', people.ana);
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://ex.test/v1' } });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST',
      body: { decision: 'changes_requested', text: 'again' } });

    const options = await as('coord', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(options.status, 200, JSON.stringify(options.body));
    const handed = await as('coord', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo } });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));
    assert.strictEqual(handed.body.asset.status, 'assigned');
  });

  await t.test('it does not reach a project the role cannot open', async () => {
    /* A permission says what somebody may do, never how much of the studio.
       Ownership was quietly enforcing that for asset.assign; dropping it
       without putting the project check back would have made one checkbox
       studio-wide. */
    const far = await as('root', `/assets/project/${otherProjectId}`, {
      method: 'POST', body: { name: 'Far Away', type: 'prop', manHours: 4 } });
    assert.strictEqual(far.status, 201, JSON.stringify(far.body));
    const refused = await as('coord', `/assets/${far.body.asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.far } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
  });

  await t.test('the ownership-based one still works on its own, unaffected', async () => {
    // Take the broad one away again; producer keeps only asset.assign.
    await setPerms('coordinator', (await permsOf('coordinator')).filter((k) => k !== 'asset.assign_any'));

    const producer = await permsOf('producer');
    assert.ok(producer.includes('asset.assign'), 'producer has the ownership-based one');
    assert.ok(!producer.includes('asset.assign_any'), 'and not the broad one');

    const mine = await newAsset('pat', 'Pat Owns This', people.ana);
    const ok = await as('pat', `/assets/${mine.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await assigneeOf(mine.id), people.bo, 'the creator can still reassign their own');

    // And is still stopped on somebody else's, exactly as before.
    const theirs = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Root Owns This', type: 'prop', manHours: 4, assigneeId: people.ana } });
    const refused = await as('pat', `/assets/${theirs.body.asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual(refused.status, 403,
      'holding asset.assign alone is still limited to your own assets');

    // The coordinator, back to neither, is refused again.
    const nowRefused = await as('coord', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana } });
    assert.strictEqual(nowRefused.status, 403, 'revoking the broad one takes the reach away again');
  });
});
