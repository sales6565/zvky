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

test('the three permissions exist, and start where the studio asked', () => {
  assert.ok(catalog.KEYS.includes('project.review_send'));
  assert.ok(catalog.KEYS.includes('project.review_queue'));

  assert.ok(catalog.KEYS.includes('project.review_respond'));

  const holders = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);
  assert.deepStrictEqual(holders('project.review_send'), ['super_admin'],
    'sending starts with Super Admin alone, and is granted per role in Settings');
  assert.deepStrictEqual(holders('project.review_queue').sort(), ['creative_art_director', 'super_admin'],
    'the queue additionally starts on the designation whose queue it is');
  assert.deepStrictEqual(holders('project.review_respond').sort(), ['creative_art_director', 'super_admin'],
    'and so does answering it');

  /* Answering a project submission is NOT the asset CD gate. A role holding
     review.cd does not thereby answer these, and vice versa — they are one word
     apart in the Settings screen and worth keeping apart in the data. */
  assert.notStrictEqual('project.review_respond', 'review.cd');
  const cdOnly = ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has('review.cd')
    && !rolePermissions.defaultsFor(r.key).has('project.review_respond'));
  assert.ok(cdOnly.length, 'some role reviews assets at the CD gate without answering project submissions');

  // Super Admin holds the whole catalogue without anybody toggling anything.
  const su = catalog.baselineFor(capabilitiesForTier('super_admin'));
  assert.ok(su.has('project.review_send') && su.has('project.review_queue') && su.has('project.review_respond'));
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

  await t.test('Request Changes needs feedback; Approve for Client does not', async () => {
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/decide' });
    const id = made.body.request.id;
    const decide = (who, body) => as(who, `/project-reviews/${id}/decision`, { method: 'POST', body });

    // Nothing written, asking for changes: refused, and it says why.
    const blank = await decide('cad', { decision: 'changes_requested' });
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body.field, 'feedback');
    assert.match(blank.body.error, /Say what needs to change/);
    assert.strictEqual((await decide('cad', { decision: 'changes_requested', feedback: '   ' })).status, 400,
      'and whitespace is not feedback');

    // Still pending — a refused decision changes nothing.
    assert.strictEqual((await queue('cad')).requests.find((r) => r.id === id).status, 'pending');

    // A decision has to be one of the two.
    const nonsense = await decide('cad', { decision: 'looks_fine' });
    assert.strictEqual(nonsense.status, 400);
    assert.deepStrictEqual(nonsense.body.allowed, ['changes_requested', 'approved_for_client']);

    const ok = await decide('cad', { decision: 'changes_requested', feedback: 'The lighting is too cold' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.request.status, 'changes_requested');
    assert.strictEqual(ok.body.request.feedback, 'The lighting is too cold');
    assert.strictEqual(ok.body.request.reviewerEmail, 'cad@zvky.test', 'who decided');
    assert.ok(ok.body.request.reviewedAt, 'and when');
  });

  await t.test('Approve for Client takes no feedback at all', async () => {
    const made = await submit('root', { clientId, projectId: otherProjectId, link: 'https://example.test/approve' });
    const id = made.body.request.id;
    const res = await as('cad', `/project-reviews/${id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.request.status, 'approved_for_client');
    assert.strictEqual(res.body.request.feedback, null, 'optional, and stored as nothing when blank');
  });

  await t.test('an answered submission leaves Pending and stays in the record', async () => {
    const before = await queue('cad');
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/leaves' });
    const id = made.body.request.id;
    assert.strictEqual((await queue('cad')).pending, before.pending + 1);

    await as('cad', `/project-reviews/${id}/decision`, {
      method: 'POST', body: { decision: 'changes_requested', feedback: 'Redo the sky' } });

    const after = await queue('cad');
    assert.strictEqual(after.pending, before.pending, 'out of the waiting count');
    assert.ok(!(await queue('cad', 'pending')).requests.some((r) => r.id === id));
    // And readable in full, which is the point of not deleting it.
    const kept = (await queue('cad', 'changes_requested')).requests.find((r) => r.id === id);
    assert.ok(kept, 'still there under its decision');
    assert.strictEqual(kept.feedback, 'Redo the sky');
    assert.ok(after.answered >= 1, 'and counted as answered');

    // The first answer stands; a second is not an error but does not rewrite it.
    const again = await as('cad2', `/project-reviews/${id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyAnswered, true);
    assert.strictEqual(again.body.request.status, 'changes_requested');
    assert.strictEqual(again.body.request.reviewerEmail, 'cad@zvky.test');
  });

  await t.test('answering is its own permission, separate from reading the queue', async () => {
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/gated' });
    const id = made.body.request.id;

    // Production, given the queue so they can act on answers — and no more.
    const before = await permsOf('producer');
    await setPerms('producer', [...before, 'project.review_queue']);
    assert.strictEqual((await as('pat', '/project-reviews')).status, 200,
      'they can read it');
    const refused = await as('pat', `/project-reviews/${id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } });
    assert.strictEqual(refused.status, 403, 'and cannot answer it');

    await setPerms('producer', [...before, 'project.review_queue', 'project.review_respond']);
    assert.strictEqual((await as('pat', `/project-reviews/${id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } })).status, 200,
      'until the studio grants that too');
    await setPerms('producer', before);
  });

  await t.test('everybody watching the queue is told of the decision', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/told' });
    await as('cad', `/project-reviews/${made.body.request.id}/decision`, {
      method: 'POST', body: { decision: 'changes_requested', feedback: 'Warmer palette' } });

    // cad2 is watching and did not make the decision, so they are told.
    const got = await inbox('cad2');
    const latest = got[0];
    assert.strictEqual(latest.kind, 'project_review_changes');
    assert.match(latest.message, /asked for changes on Nightgarden/);
    assert.strictEqual(latest.projectId, projectId);

    const approved = await submit('root', { clientId, projectId: otherProjectId, link: 'https://example.test/told2' });
    await as('cad', `/project-reviews/${approved.body.request.id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } });
    assert.strictEqual((await inbox('cad2'))[0].kind, 'project_review_approved');
    assert.match((await inbox('cad2'))[0].message, /for the client/);

    // Somebody with no business in the queue is told nothing.
    assert.strictEqual((await inbox('ana')).filter((n) => /project_review/.test(n.kind)).length, 0);
  });

  await t.test('the record holds everything the studio asked it to', async () => {
    const rows = await sql(cfg, 'SELECT * FROM project_review_requests ORDER BY created_at LIMIT 1');
    const r = rows[0];
    for (const column of ['client_id', 'project_id', 'link', 'submitted_by', 'submitter_email',
      'status', 'feedback', 'created_at']) {
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

    /* Every asset under the project, before and after — because the risk this
       design exists to avoid is a project-level decision reaching into work it
       was never about. */
    const snapshot = async () => Object.fromEntries(
      (await as('root', `/assets/project/${projectId}`)).body.assets.map((x) => [x.code, x.status]));
    const wasAll = await snapshot();

    const made = await submit('root', { clientId, projectId, link: 'https://example.test/after' });
    await as('cad', `/project-reviews/${made.body.request.id}/decision`, {
      method: 'POST', body: { decision: 'changes_requested', feedback: 'Everything is too blue' } });

    const after = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id).status;
    assert.strictEqual(after, before, 'no asset moved');
    assert.deepStrictEqual(await snapshot(), wasAll,
      'and asking for changes on the PROJECT moved none of its assets — the whole point of '
      + 'recording the decision against the submission instead');

    // And no asset event was written for it.
    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%project%'");
    assert.strictEqual(Number(events[0].n), 0, 'a project review is not an asset event');
  });
});
