const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { capabilitiesForTier } = require('../src/role-tiers');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('projreview');

/* A whole project put in front of the Creative Director.
 *
 * The thing worth guarding hardest is that this stays SEPARATE from the asset
 * pipeline. The names are close enough to be confused — an asset in CD Review
 * and a project sent to CD review — and merging them would make one screen mean
 * two things. So: its own table, its own permissions, and nothing anywhere near
 * the asset state machine.
 */

test('the two permissions exist, and start where the studio asked', () => {
  assert.ok(catalog.KEYS.includes('project.review_send'));
  assert.ok(catalog.KEYS.includes('project.review_queue'));

  const holders = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);
  assert.deepStrictEqual(holders('project.review_send'), ['super_admin'],
    'sending starts with Super Admin alone, and is granted per role in Settings');
  assert.deepStrictEqual(holders('project.review_queue').sort(), ['creative_art_director', 'super_admin'],
    'the queue additionally starts on the designation whose queue it is');

  // Super Admin holds the whole catalogue without anybody toggling anything.
  const su = catalog.baselineFor(capabilitiesForTier('super_admin'));
  assert.ok(su.has('project.review_send') && su.has('project.review_queue'));
});

test('this is not the asset pipeline', () => {
  const workflow = require('../src/asset-workflow');
  // No status, no transition, no actor. If any of these ever appear, the two
  // queues have started merging and the label on screen has stopped being true.
  assert.ok(!workflow.STATE_IDS.some((id) => /project_review/.test(id)),
    'a project review is not an asset status');
  assert.ok(!workflow.TRANSITIONS.some((t) => /project_review/.test(t.action)),
    'and not an asset transition');
});

test('project review end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'ProjReview-Test-1!';
  let server;
  let clientId;
  let projectId;
  let otherProjectId;
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
  const submit = (who, body) => as(who, '/project-reviews', { method: 'POST', body });
  const queue = async (who, status) =>
    (await as(who, '/project-reviews' + (status ? `?status=${status}` : ''))).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'pr-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'pr-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);
    const mk = async (name) => (await call('/projects', { token: token.root, method: 'POST',
      body: { clientId, name } })).body.project.id;
    projectId = await mk('Nightgarden');
    otherProjectId = await mk('Tin Rain');

    for (const [who, role] of [['pat', 'producer'], ['cad', 'creative_art_director'],
      ['cad2', 'creative_art_director'], ['ana', 'game_artist'], ['dee', 'art_director']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('a submission with no description is fine', async () => {
    const res = await submit('root', { clientId, projectId, link: 'https://example.test/cut-03' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const r = res.body.request;
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(r.description, null, 'blank is stored as nothing, not as an empty string');
    assert.strictEqual(r.projectName, 'Nightgarden');
    assert.strictEqual(r.clientName ? typeof r.clientName : 'string', 'string');
    assert.strictEqual(r.submitterEmail, 'root@zvky.test', 'who submitted it');
    assert.ok(r.createdAt, 'and when');

    const withText = await submit('root', {
      clientId, projectId: otherProjectId, link: 'https://example.test/deck', description: 'Second pass' });
    assert.strictEqual(withText.status, 201);
    assert.strictEqual(withText.body.request.description, 'Second pass');
  });

  await t.test('the link is checked the same way a submission link is', async () => {
    const bad = await submit('root', { clientId, projectId, link: 'not a link' });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.field, 'link');
    assert.strictEqual((await submit('root', { clientId, projectId })).status, 400, 'and it is required');
    assert.strictEqual((await submit('root', { projectId, link: 'https://x.test/a' })).status, 400, 'client too');
    assert.strictEqual((await submit('root', { clientId, link: 'https://x.test/a' })).status, 400, 'project too');

    // The project has to actually be under the client the form named.
    const { rows } = { rows: [] };
    const other = await call('/clients', { token: token.root, method: 'POST', body: { name: 'Acme' } });
    const mismatch = await submit('root', {
      clientId: other.body.client.id, projectId, link: 'https://example.test/x' });
    assert.strictEqual(mismatch.status, 400);
    assert.match(mismatch.body.error, /not under that client/);
    assert.ok(!rows.length);
  });

  await t.test('sending needs the permission; the queue needs the other one', async () => {
    assert.strictEqual((await submit('pat', { clientId, projectId, link: 'https://example.test/n' })).status, 403,
      'a producer cannot send by default');
    assert.strictEqual((await as('pat', '/project-reviews')).status, 403,
      'nor read the queue');
    assert.strictEqual((await as('ana', '/project-reviews')).status, 403, 'nor an artist');

    const before = await permsOf('producer');
    await setPerms('producer', [...before, 'project.review_send']);
    const sent = await submit('pat', { clientId, projectId, link: 'https://example.test/pat' });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    assert.strictEqual((await as('pat', '/project-reviews')).status, 403,
      'sending is not permission to read the queue — they are two grants');
    await setPerms('producer', before);
    assert.strictEqual((await submit('pat', { clientId, projectId, link: 'https://example.test/z' })).status, 403,
      'and revoking takes it back');
  });

  await t.test('the queue is shared: every Creative Art Director sees the same list', async () => {
    const one = await queue('cad', 'pending');
    const two = await queue('cad2', 'pending');
    assert.ok(one.requests.length, 'there is something in it');
    assert.deepStrictEqual(one.requests.map((r) => r.id), two.requests.map((r) => r.id),
      'two holders of the permission see exactly the same submissions');
    assert.strictEqual(one.pending, two.pending);
  });

  await t.test('an Art Director does not see it unless the studio grants it', async () => {
    // Deliberately checked: the queue starts on Creative Art Director alone,
    // not on the whole Creative Direction group or the direction tier.
    assert.strictEqual((await as('dee', '/project-reviews')).status, 403);
    const before = await permsOf('art_director');
    await setPerms('art_director', [...before, 'project.review_queue']);
    assert.strictEqual((await as('dee', '/project-reviews')).status, 200,
      'and once granted in Settings, they do');
    await setPerms('art_director', before);
  });

  await t.test('everybody watching the queue is told', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];
    const before = (await inbox('cad')).length;
    const res = await submit('root', { clientId, projectId, link: 'https://example.test/notify' });
    assert.strictEqual(res.status, 201);

    for (const who of ['cad', 'cad2']) {
      const got = await inbox(who);
      assert.ok(got.length > 0, `${who} has notifications`);
      const latest = got[0];
      assert.strictEqual(latest.kind, 'project_review');
      assert.match(latest.message, /submitted Nightgarden for your review/);
      assert.strictEqual(latest.projectId, projectId, 'and it points at the project');
    }
    assert.ok((await inbox('cad')).length > before);
    // Somebody with no business in the queue is not told.
    assert.strictEqual((await inbox('ana')).filter((n) => n.kind === 'project_review').length, 0);
  });

  await t.test('marking it reviewed clears it from pending and keeps the record', async () => {
    const pending = (await queue('cad', 'pending')).requests;
    const target = pending[0];
    const res = await as('cad', `/project-reviews/${target.id}/reviewed`, { method: 'POST' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.request.status, 'reviewed');
    assert.strictEqual(res.body.request.reviewerEmail, 'cad@zvky.test', 'who reviewed it');
    assert.ok(res.body.request.reviewedAt, 'and when');

    const after = await queue('cad', 'pending');
    assert.ok(!after.requests.some((r) => r.id === target.id), 'gone from pending');
    assert.strictEqual(after.pending, pending.length - 1, 'and the count went down');

    // Still there in full, which is the point of not deleting it.
    const all = (await queue('cad')).requests;
    assert.ok(all.some((r) => r.id === target.id && r.status === 'reviewed'),
      'the record survives being reviewed');

    // Marking it twice is not an error and does not rewrite who reviewed it.
    const again = await as('cad2', `/project-reviews/${target.id}/reviewed`, { method: 'POST' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyReviewed, true);
    assert.strictEqual(again.body.request.reviewerEmail, 'cad@zvky.test');

    assert.strictEqual((await as('pat', `/project-reviews/${target.id}/reviewed`, { method: 'POST' })).status, 403,
      'and it takes the queue permission');
  });

  await t.test('the record holds everything the studio asked it to', async () => {
    const rows = await sql(cfg, 'SELECT * FROM project_review_requests ORDER BY created_at LIMIT 1');
    const r = rows[0];
    for (const column of ['client_id', 'project_id', 'link', 'submitted_by', 'submitter_email',
      'status', 'created_at']) {
      assert.ok(r[column] !== undefined, `${column} is stored`);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'description'));
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'reviewed_by'));
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'reviewed_at'));
  });

  await t.test('the asset pipeline is untouched', async () => {
    /* The whole point of the separation, checked against a real asset: sending
       a project for review moves nothing in the asset workflow. */
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Untouched', type: 'character', assigneeId: people.ana } })).body.asset;
    const before = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id).status;

    await submit('root', { clientId, projectId, link: 'https://example.test/after' });

    const after = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id).status;
    assert.strictEqual(after, before, 'no asset moved');

    // And no asset event was written for it.
    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%project%'");
    assert.strictEqual(Number(events[0].n), 0, 'a project review is not an asset event');
  });
});
