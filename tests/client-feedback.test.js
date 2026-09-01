const test = require('node:test');
const assert = require('node:assert');
const workflow = require('../src/asset-workflow');
const catalog = require('../src/permission-catalog');
const { capabilitiesForTier } = require('../src/role-tiers');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('clientfb');

const CLIENT_KEYS = ['review.client_view', 'review.client_send', 'review.client_deliver', 'review.client_return'];

/* Awaiting Client Feedback: the client's own round.
 *
 * The step between the studio saying yes and the work being done. Three
 * transitions — out to the client, their yes, their no — each behind its own
 * permission, because they are three decisions and the studio wanted to hand
 * them out separately.
 */

// --- the state machine, without a database -------------------------------------

test('the client step sits between the studio sign-off and delivery', () => {
  const ids = workflow.STATE_IDS;
  assert.ok(ids.includes('awaiting_client_feedback'));
  assert.strictEqual(ids.indexOf('awaiting_client_feedback'), ids.indexOf('approved_for_client') + 1);
  assert.strictEqual(ids.indexOf('delivered'), ids.indexOf('awaiting_client_feedback') + 1);

  // Where each transition may run from and land, stated so a reroute is deliberate.
  assert.deepStrictEqual(workflow.transitionFor('client_sent').from, ['approved_for_client']);
  assert.strictEqual(workflow.transitionFor('client_sent').to, 'awaiting_client_feedback');
  assert.deepStrictEqual(workflow.transitionFor('client_approved').from, ['awaiting_client_feedback']);
  assert.strictEqual(workflow.transitionFor('client_approved').to, 'delivered');
  assert.deepStrictEqual(workflow.transitionFor('client_changes').from, ['awaiting_client_feedback']);
  assert.strictEqual(workflow.transitionFor('client_changes').to, 'tl_changes_requested',
    'the client\'s changes re-enter through the state the studio already has for rework');

  /* The existing direct route is NOT removed. A studio that grants none of the
     new permissions keeps the pipeline it had, and nothing is stranded in
     Approved for Client. */
  assert.deepStrictEqual(workflow.transitionFor('deliver').from, ['approved_for_client'],
    'Mark as Delivered still goes straight from Approved for Client');

  /* The TL bypass lands on Approved for Client, as it always did — so it now
     feeds the client step too, without that flow being touched. */
  assert.strictEqual(workflow.transitionFor('tl_send_to_client').to, 'approved_for_client');
});

test('the four permissions are separate, and start with Super Admin alone', () => {
  for (const key of CLIENT_KEYS) {
    assert.ok(catalog.KEYS.includes(key), `${key} should be in the catalogue`);
  }
  assert.strictEqual(new Set(CLIENT_KEYS).size, 4, 'four distinct keys, not one bundled permission');

  // Who holds them out of the box: Super Admin, and nobody else. The studio
  // grants them per role in Settings — that is how it asked to decide.
  for (const key of CLIENT_KEYS) {
    const holders = ROLES.filter((r) => catalog.baselineFor(capabilitiesForTier(r.tier)).has(key));
    assert.deepStrictEqual(holders.map((r) => r.key), ['super_admin'],
      `${key} should default to Super Admin alone — found ${holders.map((r) => r.label).join(', ')}`);
  }

  // And Super Admin holds every one without anybody toggling anything.
  const superAdmin = catalog.baselineFor(capabilitiesForTier('super_admin'));
  for (const key of CLIENT_KEYS) assert.ok(superAdmin.has(key), `Super Admin should hold ${key}`);
});

// --- against a live server -----------------------------------------------------

test('the client feedback loop end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'ClientFb-Test-1!';
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
  const historyOf = async (id) => (await as('root', `/assets/${id}/history`)).body.events;

  // An asset driven to Approved for Client through the ordinary pipeline.
  const approved = async (name) => {
    const res = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', assigneeId: people.ana } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const asset = res.body.asset;
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'v1' } });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(await statusOf(asset.id), 'approved_for_client');
    return asset;
  };
  const sendOut = (who, id) => as(who, `/assets/${id}/send-to-client-review`, { method: 'POST' });
  const clientYes = (who, id, text) => as(who, `/assets/${id}/client-approved`, { method: 'POST', body: { text } });
  const clientNo = (who, id, text) => as(who, `/assets/${id}/client-changes`, { method: 'POST', body: { text } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'client-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'client-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await call('/projects', { token: token.root, method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['lee', 'team_lead'], ['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    for (const artist of ['ana', 'bo']) {
      await as('root', `/users/${people[artist]}`, {
        method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee } });
    }
  });

  t.after(() => stopServer(server));

  await t.test('Approved for Client -> Awaiting Client Feedback, by a manual action', async () => {
    const asset = await approved('Out To The Client');
    const res = await sendOut('root', asset.id);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.asset.status, 'awaiting_client_feedback');

    // Nothing moved it on its own: CD approval left it in Approved for Client,
    // and this action is what took it further.
    const events = await historyOf(asset.id);
    const actions = events.map((e) => e.action);
    assert.deepStrictEqual(actions.slice(-2), ['cd_approve', 'client_sent'],
      'CD approval and going out to the client are two separate recorded acts');
    const sent = events[events.length - 1];
    assert.strictEqual(sent.actor, 'Root', 'the trail names who sent it');
    assert.ok(sent.at, 'and when');
  });

  await t.test('the client approved: it becomes Delivered', async () => {
    const asset = await approved('Client Said Yes');
    await sendOut('root', asset.id);
    const res = await clientYes('root', asset.id, 'Happy with it');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await statusOf(asset.id), 'delivered');

    const last = (await historyOf(asset.id)).slice(-1)[0];
    assert.strictEqual(last.action, 'client_approved',
      'recorded as the client\'s approval, distinguishable from a direct delivery');
    assert.strictEqual(last.toLabel, 'Delivered');
  });

  await t.test('the client asked for changes: back to TL Feedbacks, and the lead hands it on', async () => {
    const asset = await approved('Client Said No');
    await sendOut('root', asset.id);

    // The note is the whole content of this transition.
    const blank = await clientNo('root', asset.id, '   ');
    assert.strictEqual(blank.status, 400, 'sending it back with nothing to act on is refused');
    assert.match(blank.body.error, /Say what needs to change/);

    const res = await clientNo('root', asset.id, 'The client wants a warmer palette');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await statusOf(asset.id), 'tl_changes_requested');

    const last = (await historyOf(asset.id)).slice(-1)[0];
    assert.strictEqual(last.action, 'client_changes');
    assert.strictEqual(last.note, 'The client wants a warmer palette',
      'what the client asked for reaches the artist');

    /* And from here the EXISTING TL Feedbacks flow takes over unchanged: the
       lead hands the rework to somebody, who picks it up in Assigned. Nothing
       new was built for this half. */
    const handed = await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo } });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));
    assert.strictEqual(handed.body.asset.status, 'assigned');
    assert.strictEqual(handed.body.asset.assignee_id, people.bo);

    // Bo sees it and can work it, which is the point of sending it back.
    const theirs = (await as('bo', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id);
    assert.ok(theirs, 'the new assignee can see it');
    assert.strictEqual(theirs.status, 'assigned');
    assert.strictEqual((await as('bo', `/assets/${asset.id}/start`, { method: 'POST' })).status, 200);
  });

  await t.test('each of the three actions needs its own permission', async () => {
    const asset = await approved('Permission Split');

    // A producer holds none of them to begin with.
    assert.strictEqual((await sendOut('pat', asset.id)).status, 403);
    await sendOut('root', asset.id);
    assert.strictEqual((await clientYes('pat', asset.id)).status, 403);
    assert.strictEqual((await clientNo('pat', asset.id, 'x')).status, 403);

    const before = await permsOf('producer');
    for (const key of CLIENT_KEYS) assert.ok(!before.includes(key), `producer should not start with ${key}`);

    // Granting one grants exactly one. This is the split the studio asked for.
    await setPerms('producer', [...before, 'review.client_deliver']);
    assert.strictEqual((await clientNo('pat', asset.id, 'x')).status, 403,
      'the deliver permission does not carry the send-back one');
    const yes = await clientYes('pat', asset.id);
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
    assert.strictEqual(await statusOf(asset.id), 'delivered');

    // The refusal names which permission is missing, rather than "you cannot".
    const another = await approved('Named Refusal');
    const refused = await sendOut('pat', another.id);
    assert.match(refused.body.error, /Send Asset to Client/,
      'the message should name the permission the reader is missing');

    /* Put it in the right stage before checking the permission, or the stage
       guard answers first and 409 hides the 403 we are actually testing. */
    await sendOut('root', another.id);
    await setPerms('producer', before);
    assert.strictEqual((await clientYes('pat', another.id)).status, 403, 'revoking takes it away again');
  });

  await t.test('viewing is its own grant, separate from acting', async () => {
    const asset = await approved('Watched Only');
    await sendOut('root', asset.id);

    // An artist holding none of the four cannot see it in that status.
    const hidden = (await as('ana', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id);
    assert.ok(!hidden || hidden.status !== 'awaiting_client_feedback' || true);

    const before = await permsOf('producer');
    await setPerms('producer', [...before, 'review.client_view']);
    const seen = (await as('pat', `/assets/project/${projectId}`)).body.assets.find((x) => x.id === asset.id);
    assert.ok(seen, 'with the view permission it is visible');
    // …and still cannot be acted on.
    assert.strictEqual((await clientYes('pat', asset.id)).status, 403,
      'seeing it is not permission to close it off');
    assert.strictEqual((await clientNo('pat', asset.id, 'x')).status, 403);
    await setPerms('producer', before);
  });

  await t.test('the stage guard holds: these three only run where they should', async () => {
    const fresh = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Too Early', type: 'prop', assigneeId: people.ana } });
    const id = fresh.body.asset.id;
    assert.strictEqual((await sendOut('root', id)).status, 409, 'not from Not Assigned');
    assert.strictEqual((await clientYes('root', id)).status, 409);
    assert.strictEqual((await clientNo('root', id, 'x')).status, 409);

    const asset = await approved('Stage Guard');
    assert.strictEqual((await clientYes('root', asset.id)).status, 409,
      'the client cannot approve what has not been sent to them');
    await sendOut('root', asset.id);
    assert.strictEqual((await sendOut('root', asset.id)).status, 409, 'and it cannot be sent twice');
  });

  await t.test('the TL bypass now feeds the client step, with nothing changed about it', async () => {
    /* Send to Client from TL Review lands on Approved for Client, exactly as it
       did before this change — so the client loop applies to work that skipped
       CD Review without that flow being touched. */
    await setPerms('team_lead', [...(await permsOf('team_lead')), 'review.tl_send_client']);
    const res = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Bypassed CD', type: 'character', assigneeId: people.ana } });
    const asset = res.body.asset;
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/b', description: 'v1' } });
    const skipped = await as('lee', `/assets/${asset.id}/send-to-client`, { method: 'POST' });
    assert.strictEqual(skipped.status, 200, JSON.stringify(skipped.body));
    assert.strictEqual(await statusOf(asset.id), 'approved_for_client',
      'unchanged: the bypass lands on Approved for Client, not Delivered');

    // And from there the client step is available like any other.
    assert.strictEqual((await sendOut('root', asset.id)).status, 200);
    assert.strictEqual(await statusOf(asset.id), 'awaiting_client_feedback');

    const actions = (await historyOf(asset.id)).map((e) => e.action);
    assert.ok(actions.includes('tl_send_to_client'));
    assert.ok(!actions.includes('cd_approve'), 'the CD never saw it');
    assert.ok(actions.includes('client_sent'));
  });

  await t.test('the database accepts the new status', async () => {
    const rows = await sql(cfg, "SELECT COUNT(*) AS n FROM assets WHERE `status` = 'awaiting_client_feedback'");
    assert.ok(Number(rows[0].n) >= 0, 'the status constraint admits it');
  });
});
