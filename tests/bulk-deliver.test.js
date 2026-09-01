const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('bulkdeliver');

/* Marking several assets delivered in one action.
 *
 * The design is "the single-asset route, N times, reporting on each", so most
 * of what is asserted here is that it really is the same route: the same
 * permission, the same state-machine guard, the same event row. A bulk action
 * that quietly took a shortcut past any of those would be a way to ship work to
 * a client without it having been reviewed, which is the one thing this must
 * not become.
 */
test('bulk delivery', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Bulk-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const permsOf = async (role) => (await as('root', `/permissions/roles/${role}`))
    .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  const setPerms = async (role, keys) => {
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: keys } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
  };
  const statusOf = async (id) =>
    (await as('root', `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id).status;

  const newAsset = async (name) => {
    const res = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', assigneeId: people.ana },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  };
  // Drive an asset all the way to Approved for Client, the one state delivery
  // is legal from.
  const approved = async (name) => {
    const asset = await newAsset(name);
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'v1' } });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(await statusOf(asset.id), 'approved_for_client', `${name} should be ready to deliver`);
    return asset;
  };
  const bulk = (who, assetIds) => as(who, '/assets/bulk/deliver', { method: 'POST', body: { assetIds } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'bulk-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'bulk-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await call('/projects', { token: token.root, method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['lee', 'team_lead'], ['ana', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    await as('root', `/users/${people.ana}`, {
      method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee } });
  });

  t.after(() => stopServer(server));

  await t.test('the route is reachable at all', async () => {
    /* Express matches in definition order and '/:id/deliver' matches
       '/bulk/deliver' with id="bulk". If this endpoint is ever moved below the
       ':id' routes it answers "Asset not found" and every other test here fails
       for a reason that looks nothing like the cause. Asserted first, and on
       its own, so that failure is legible. */
    const res = await bulk('root', ['not-a-real-asset']);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.results[0].error, 'That asset no longer exists.',
      'a missing asset is reported per-asset, not as a routing 404');
  });

  await t.test('three approved assets are delivered in one action', async () => {
    const assets = [await approved('One'), await approved('Two'), await approved('Three')];
    const res = await bulk('root', assets.map((a) => a.id));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.delivered, 3);
    assert.strictEqual(res.body.failed, 0);
    assert.ok(res.body.batchId, 'the batch has an id');
    for (const a of assets) {
      assert.strictEqual(await statusOf(a.id), 'delivered', `${a.name} should be delivered`);
      assert.ok(res.body.results.find((r) => r.id === a.id && r.ok), `${a.name} reported ok`);
    }
  });

  await t.test('each asset gets the same event a single delivery writes', async () => {
    const asset = await approved('Solo Compare');
    await as('root', `/assets/${asset.id}/deliver`, { method: 'POST' });
    const single = (await as('root', `/assets/${asset.id}/history`)).body.events.slice(-1)[0];

    const other = await approved('Bulk Compare');
    const res = await bulk('root', [other.id]);
    const fromBulk = (await as('root', `/assets/${other.id}/history`)).body.events.slice(-1)[0];

    // Same action, same transition, same actor — the bulk path is not a second
    // implementation of delivery.
    assert.strictEqual(fromBulk.action, 'deliver');
    assert.strictEqual(fromBulk.action, single.action);
    assert.strictEqual(fromBulk.toLabel, single.toLabel);
    assert.strictEqual(fromBulk.fromLabel, single.fromLabel);

    // And the event knows which batch it belonged to, while the single one does not.
    const rows = await sql(cfg,
      `SELECT asset_id, batch_id FROM asset_events WHERE action = 'deliver' AND asset_id IN ('${asset.id}','${other.id}')`);
    const byAsset = Object.fromEntries(rows.map((r) => [r.asset_id, r.batch_id]));
    assert.strictEqual(byAsset[asset.id], null, 'a single delivery belongs to no batch');
    assert.strictEqual(byAsset[other.id], res.body.batchId, 'a bulk one points at its batch');
  });

  await t.test('the batch itself is recorded, with who and how many', async () => {
    const assets = [await approved('Batch A'), await approved('Batch B')];
    const res = await bulk('pat', assets.map((a) => a.id));
    assert.strictEqual(res.body.delivered, 2, JSON.stringify(res.body));

    const [batch] = await sql(cfg, `SELECT * FROM asset_event_batches WHERE id = '${res.body.batchId}'`);
    assert.ok(batch, 'the batch row exists');
    assert.strictEqual(batch.action, 'deliver');
    assert.strictEqual(batch.actor_id, people.pat, 'who did it');
    assert.strictEqual(batch.actor_email, 'pat@zvky.test');
    assert.strictEqual(Number(batch.requested), 2);
    assert.strictEqual(Number(batch.succeeded), 2);
    assert.ok(batch.created_at, 'and when');

    // The per-asset events are still there in their own right.
    const events = await sql(cfg,
      `SELECT asset_id FROM asset_events WHERE batch_id = '${res.body.batchId}'`);
    assert.deepStrictEqual(events.map((e) => e.asset_id).sort(), assets.map((a) => a.id).sort(),
      'one event per asset, all pointing at the batch');
  });

  await t.test('one refusal does not take the batch with it', async () => {
    const good = [await approved('Good One'), await approved('Good Two')];
    // Still in review: the state machine refuses this one and only this one.
    const early = await newAsset('Not Ready');
    await as('ana', `/assets/${early.id}/start`, { method: 'POST' });
    assert.strictEqual(await statusOf(early.id), 'in_progress');

    const res = await bulk('root', [good[0].id, early.id, good[1].id]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.delivered, 2);
    assert.strictEqual(res.body.failed, 1);

    assert.strictEqual(await statusOf(good[0].id), 'delivered');
    assert.strictEqual(await statusOf(good[1].id), 'delivered');
    assert.strictEqual(await statusOf(early.id), 'in_progress', 'the refused one is untouched');

    const refused = res.body.results.find((r) => r.id === early.id);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, early.code, 'named, so the reader knows which one');
    assert.match(refused.error, /In Progress/,
      'and told why — the state machine says which state it is actually in');
    assert.match(refused.error, /cannot be marked delivered/,
      'in a readable sentence: this used to end "cannot be deliver." because the '
      + 'action had no phrase, which one asset at a time nobody ever saw');

    // The batch row records the shortfall rather than claiming three.
    const [batch] = await sql(cfg, `SELECT * FROM asset_event_batches WHERE id = '${res.body.batchId}'`);
    assert.strictEqual(Number(batch.requested), 3);
    assert.strictEqual(Number(batch.succeeded), 2);
  });

  await t.test('review cannot be skipped in bulk any more than singly', async () => {
    /* The whole safety argument in one test. Every status that is not Approved
       for Client is refused, by the same transition table that refuses it one
       at a time — so there is no bulk route to a client that bypasses review. */
    const stages = {};
    let a = await newAsset('Stage Walk');
    stages.assigned = a.id;
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'assigned');

    await as('ana', `/assets/${a.id}/start`, { method: 'POST' });
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'in_progress');

    await as('ana', `/assets/${a.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'v1' } });
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'pending_tl_review');

    await as('lee', `/assets/${a.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'no' } });
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'tl_changes_requested');

    await as('ana', `/assets/${a.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${a.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'v2' } });
    await as('lee', `/assets/${a.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'pending_cd_review');

    await as('root', `/assets/${a.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 1, 'approved_for_client — and only here');
    assert.strictEqual(await statusOf(a.id), 'delivered');

    // Already delivered is refused too, so a double submission cannot re-deliver.
    assert.strictEqual((await bulk('root', [a.id])).body.delivered, 0, 'delivered again');
    assert.ok(stages.assigned);
  });

  await t.test('it takes the same permission the single-asset action takes', async () => {
    const asset = await approved('Permission Check');
    // The artist holds no delivery permission, in bulk or singly.
    const refused = await bulk('ana', [asset.id]);
    assert.strictEqual(refused.status, 200, 'still a per-asset report, not a blanket 403');
    assert.strictEqual(refused.body.delivered, 0);
    assert.match(refused.body.results[0].error, /deliver/i);
    assert.strictEqual((await as('ana', `/assets/${asset.id}/deliver`, { method: 'POST' })).status, 403,
      'and the single-asset route refuses them the same way');

    // Take review.deliver off the producer and the bulk action goes with it —
    // no separate permission was invented for this.
    const before = await permsOf('producer');
    assert.ok(before.includes('review.deliver'), 'a producer can deliver to begin with');
    await setPerms('producer', before.filter((k) => k !== 'review.deliver'));
    assert.strictEqual((await bulk('pat', [asset.id])).body.delivered, 0,
      'revoking the single-asset permission revokes the bulk action too');
    await setPerms('producer', before);
    assert.strictEqual((await bulk('pat', [asset.id])).body.delivered, 1, 'and granting it back restores it');
  });

  await t.test('the request itself is checked', async () => {
    assert.strictEqual((await bulk('root', [])).status, 400, 'nothing selected');
    assert.strictEqual((await as('root', '/assets/bulk/deliver', {
      method: 'POST', body: { assetIds: 'not-a-list' } })).status, 400);

    // The same asset twice is one delivery and one line, not two.
    const asset = await approved('Sent Twice');
    const res = await bulk('root', [asset.id, asset.id]);
    assert.strictEqual(res.body.requested, 1, 'de-duplicated before anything is written');
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(res.body.delivered, 1);

    const big = await bulk('root', Array.from({ length: 201 }, (_, i) => `id-${i}`));
    assert.strictEqual(big.status, 400);
    assert.match(big.body.error, /200 at a time/);
  });
});
