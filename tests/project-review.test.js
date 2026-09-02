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
  /* Give a role some permissions, run something, and put them back whatever
     happens. Without the finally, one failing assertion leaves the role as the
     test left it and every test after it is running against a studio somebody
     else configured — which is how three failures came from one. */
  const withPerms = async (role, extra, run) => {
    const before = await permsOf(role);
    await setPerms(role, [...new Set([...before, ...extra])]);
    try { return await run(before); } finally { await setPerms(role, before); }
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

  await t.test('Submit Feedback is one action, and the feedback is required', async () => {
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/decide' });
    const id = made.body.request.id;
    const answer = (who, body) => as(who, `/project-reviews/${id}/feedback`, { method: 'POST', body });

    /* Nothing written: refused, and it says why. This is the rule that changed
       when the two buttons became one — an approval used to be allowed to carry
       no words, because the button said what it meant. Now the words are the
       whole message. */
    const blank = await answer('cad', {});
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body.field, 'feedback');
    assert.match(blank.body.error, /Write your feedback/);
    assert.strictEqual((await answer('cad', { feedback: '   ' })).status, 400,
      'and whitespace is not feedback');

    // Still pending — a refused answer changes nothing.
    assert.strictEqual((await queue('cad')).requests.find((r) => r.id === id).status, 'pending');

    const ok = await answer('cad', { feedback: 'The lighting is too cold' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.request.status, 'feedback_given', 'one outcome, whatever it says');
    assert.strictEqual(ok.body.request.feedback, 'The lighting is too cold');
    assert.strictEqual(ok.body.request.reviewerEmail, 'cad@zvky.test', 'who answered');
    assert.ok(ok.body.request.reviewedAt, 'and when');
  });

  await t.test('there is no second way to answer one', async () => {
    /* The two-decision endpoint is gone rather than deprecated. A route that
       still set changes_requested or approved_for_client would put the choice
       back into the system by the side door, which is the thing the studio
       asked to remove. */
    const made = await submit('root', { clientId, projectId: otherProjectId, link: 'https://example.test/gone' });
    const res = await as('cad', `/project-reviews/${made.body.request.id}/decision`, {
      method: 'POST', body: { decision: 'approved_for_client' } });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual((await queue('cad')).requests.find((r) => r.id === made.body.request.id).status,
      'pending', 'and it answered nothing on its way out');
  });

  await t.test('an answered submission leaves Pending and stays in the record', async () => {
    const before = await queue('cad');
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/leaves' });
    const id = made.body.request.id;
    assert.strictEqual((await queue('cad')).pending, before.pending + 1);

    await as('cad', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Redo the sky' } });

    const after = await queue('cad');
    assert.strictEqual(after.pending, before.pending, 'out of the waiting count');
    assert.ok(!(await queue('cad', 'pending')).requests.some((r) => r.id === id));
    // And readable in full, which is the point of not deleting it.
    const kept = (await queue('cad', 'feedback_given')).requests.find((r) => r.id === id);
    assert.ok(kept, 'still there under its status');
    assert.strictEqual(kept.feedback, 'Redo the sky');
    assert.ok(after.answered >= 1, 'and counted as answered');

    // The first answer stands; a second is not an error but does not rewrite it.
    const again = await as('cad2', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Actually it is fine' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.alreadyAnswered, true);
    assert.strictEqual(again.body.request.feedback, 'Redo the sky');
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
    const refused = await as('pat', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Looks good to me' } });
    assert.strictEqual(refused.status, 403, 'and cannot answer it');

    await setPerms('producer', [...before, 'project.review_queue', 'project.review_respond']);
    assert.strictEqual((await as('pat', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Looks good to me' } })).status, 200,
      'until the studio grants that too');
    await setPerms('producer', before);
  });

  await t.test('everybody watching the queue is told of the feedback', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/told' });
    await as('cad', `/project-reviews/${made.body.request.id}/feedback`, {
      method: 'POST', body: { feedback: 'Warmer palette' } });

    // cad2 is watching and did not write it, so they are told.
    const got = await inbox('cad2');
    const latest = got[0];
    assert.strictEqual(latest.kind, 'project_review_feedback', 'one kind now, not two');
    assert.match(latest.message, /has given feedback on Nightgarden/);
    assert.strictEqual(latest.projectId, projectId);

    /* And it says the same thing however the feedback reads — there is no
       approval kind left to fall back to. */
    const second = await submit('root', { clientId, projectId: otherProjectId, link: 'https://example.test/told2' });
    await as('cad', `/project-reviews/${second.body.request.id}/feedback`, {
      method: 'POST', body: { feedback: 'This is clear to go to the client' } });
    assert.strictEqual((await inbox('cad2'))[0].kind, 'project_review_feedback');

    // Somebody with no business in the queue is told nothing.
    assert.strictEqual((await inbox('ana')).filter((n) => /project_review/.test(n.kind)).length, 0);
  });

  await t.test('Pending Actions shows each person only what is waiting on them', async () => {
    const pending = (who) => as(who, '/project-reviews/pending-actions').then((r) => r.body);
    const keys = (p) => p.groups.map((g) => g.key);

    /* Without the tab's own permission there is no tab and no endpoint. This
       is the grant the studio asked to be able to withhold on its own. */
    assert.strictEqual((await as('ana', '/project-reviews/pending-actions')).status, 403);

    // A fresh submission, so there is one of each kind waiting.
    const waiting = await submit('root', { clientId, projectId, link: 'https://example.test/pa-1' });
    const answered = await submit('root', { clientId, projectId: otherProjectId, link: 'https://example.test/pa-2' });
    await as('cad', `/project-reviews/${answered.body.request.id}/feedback`, {
      method: 'POST', body: { feedback: 'Second act drags' } });

    // The Creative Director: what is still to be answered, and nothing else.
    const active = (p) => p.groups.filter((g) => g.phase === 'active').map((g) => g.key);
    const cad = await pending('cad');
    assert.deepStrictEqual(active(cad), ['awaiting_review', 'awaiting_followup'],
      'they hold both permissions, so they see both groups');
    // And each of those has a History counterpart, which is the sub-tab split.
    assert.deepStrictEqual(keys(cad).filter((k) => !active(cad).includes(k)),
      ['reviewed_by_me', 'followup_done']);
    const toAnswer = cad.groups.find((g) => g.key === 'awaiting_review');
    assert.ok(toAnswer.items.some((i) => i.id === waiting.body.request.id));
    assert.ok(!toAnswer.items.some((i) => i.id === answered.body.request.id),
      'an answered one is no longer waiting on the reviewer');

    /* Production: given the queue and nothing else, they see only the answers
       to act on — never the ones still waiting on the Creative Director. */
    const before = await permsOf('producer');
    await setPerms('producer', [...before, 'project.review_queue', 'pending.view']);
    const prod = await pending('pat');
    assert.deepStrictEqual(active(prod), ['awaiting_followup'],
      'no review group without the permission to answer');
    const toAct = prod.groups.find((g) => g.key === 'awaiting_followup');
    assert.ok(toAct.items.some((i) => i.id === answered.body.request.id));
    assert.ok(!toAct.items.some((i) => i.id === waiting.body.request.id),
      'and never something the Creative Director has not answered');
    assert.strictEqual(prod.count, toAct.items.length, 'the count is what they can see');
    await setPerms('producer', before);
  });

  await t.test('the tab has its own grant, separate from what it lists', async () => {
    const pending = (who) => as(who, '/project-reviews/pending-actions');
    const before = await permsOf('producer');

    // The workflow without the tab: they can read the queue and act on it, and
    // the tab is closed to them.
    await setPerms('producer', [...before, 'project.review_queue']);
    assert.strictEqual((await as('pat', '/project-reviews')).status, 200, 'the queue itself opens');
    assert.strictEqual((await pending('pat')).status, 403, 'the tab does not');

    // The tab without the workflow: it opens, and there is nothing in it —
    // never somebody else's queue.
    await setPerms('producer', [...before, 'pending.view']);
    const empty = await pending('pat');
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.body.groups, [], 'an empty tab, not a borrowed one');
    assert.strictEqual(empty.body.count, 0);

    await setPerms('producer', before);
  });

  await t.test('answering moves an item from one queue to the other', async () => {
    const pending = (who) => as(who, '/project-reviews/pending-actions').then((r) => r.body);
    /* Phase-aware, because "gone from their list" now means gone from ACTIVE.
       Nothing leaves this tab any more — it moves to History, which is the
       whole point of the split. */
    const inPhase = (p, id, phase) => p.groups
      .some((g) => g.phase === phase && g.items.some((i) => i.id === id));

    await withPerms('producer', ['project.review_queue', 'pending.view'], async () => {
      const made = await submit('root', { clientId, projectId, link: 'https://example.test/handoff' });
      const id = made.body.request.id;
      assert.ok(inPhase(await pending('cad'), id, 'active'), 'waiting on the Creative Director');
      assert.ok(!inPhase(await pending('pat'), id, 'active'), 'and not yet on Production');

      await as('cad', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'Warmer grade' } });

      const cadAfter = await pending('cad');
      assert.ok(!cadAfter.groups.find((g) => g.key === 'awaiting_review').items.some((i) => i.id === id),
        'gone from the reviewer\'s active list');
      assert.ok(inPhase(cadAfter, id, 'history'), 'and into the reviewer\'s History');

      const prodAfter = await pending('pat');
      assert.ok(inPhase(prodAfter, id, 'active'), 'and active for Production');
      const item = prodAfter.groups.find((g) => g.key === 'awaiting_followup')
        .items.find((i) => i.id === id);
      assert.strictEqual(item.feedback, 'Warmer grade', 'with the feedback they have to act on');

      // Production deals with it, and it leaves their ACTIVE list for History.
      const closed = await as('pat', `/project-reviews/${id}/close`, { method: 'POST' });
      assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
      assert.strictEqual(closed.body.request.closerEmail, 'pat@zvky.test', 'who closed it');
      assert.ok(closed.body.request.closedAt, 'and when');
      const done = await pending('pat');
      assert.ok(!inPhase(done, id, 'active'), 'gone from Production\'s active list');
      assert.ok(inPhase(done, id, 'history'), 'and readable in their History');

      // Nothing is deleted: the whole trail is still readable.
      const kept = (await queue('cad')).requests.find((r) => r.id === id);
      assert.strictEqual(kept.status, 'feedback_given');
      assert.strictEqual(kept.feedback, 'Warmer grade');
      assert.strictEqual(kept.submitterEmail, 'root@zvky.test');
      assert.strictEqual(kept.reviewerEmail, 'cad@zvky.test');
      assert.strictEqual(kept.closerEmail, 'pat@zvky.test');

      // Closing twice is not an error and does not rewrite who did it.
      const again = await as('cad', `/project-reviews/${id}/close`, { method: 'POST' });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.alreadyClosed, true);
      assert.strictEqual(again.body.request.closerEmail, 'pat@zvky.test');
    });
  });

  await t.test('rows answered under the old two decisions still work', async () => {
    /* The studio has submissions already carrying changes_requested and
       approved_for_client, from when the Creative Director chose between two
       buttons. Collapsing the buttons must not strand them: they are still
       answered, still Production's to act on, and still closable. Nothing
       rewrites them, because somebody really did make that decision. */
    const pending = (who) => as(who, '/project-reviews/pending-actions').then((r) => r.body);
    const inList = (p, id) => p.groups.some((g) => g.items.some((i) => i.id === id));
    const pending2Active = (p, id) => p.groups
      .some((g) => g.phase === 'active' && g.items.some((i) => i.id === id));

    for (const legacy of ['changes_requested', 'approved_for_client']) {
      const made = await submit('root', { clientId, projectId, link: `https://example.test/old-${legacy}` });
      const id = made.body.request.id;
      // Written straight to the table: there is no longer an endpoint that sets
      // these. The values are literals from this test, not user input.
      await sql(cfg, `UPDATE project_review_requests
                         SET status = '${legacy}', feedback = 'Said under the old buttons',
                             reviewed_at = NOW()
                       WHERE id = '${id}'`);

      assert.ok(inList(await pending('cad'), id), `a ${legacy} row is still waiting to be acted on`);
      assert.ok(pending2Active(await pending('cad'), id), 'and it is Active, not History');
      assert.ok(!(await queue('cad', 'pending')).requests.some((r) => r.id === id),
        'and is not back in the unanswered list');
      const stored = (await queue('cad', legacy)).requests.find((r) => r.id === id);
      assert.strictEqual(stored.status, legacy, 'its own status is left alone');

      const closed = await as('cad', `/project-reviews/${id}/close`, { method: 'POST' });
      assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
      assert.ok(!pending2Active(await pending('cad'), id), 'and it closes off like any other');
      assert.ok(inList(await pending('cad'), id), 'into History, still readable');
    }
  });

  await t.test('nothing can be closed before it has been answered', async () => {
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/tooearly' });
    const res = await as('cad', `/project-reviews/${made.body.request.id}/close`, { method: 'POST' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /has not given feedback on this yet/);

    // And closing takes the queue permission.
    assert.strictEqual((await as('ana', `/project-reviews/${made.body.request.id}/close`,
      { method: 'POST' })).status, 403);
  });


  await t.test('the submitter gets a read-only record of what they sent', async () => {
    // What Production is actually given in a studio that uses this: send it,
    // see the tab, and keep the record.
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'], async () => {
      const mine = await submit('pat', { clientId, projectId,
        link: 'https://example.test/pat-record', description: 'The act two cut.' });
      assert.strictEqual(mine.status, 201, JSON.stringify(mine.body));
      const id = mine.body.request.id;

      const seen = (await as('pat', '/project-reviews/pending-actions')).body;
      const own = seen.groups.find((g) => g.key === 'my_submissions');
      assert.ok(own, `no record group: ${JSON.stringify(seen.groups.map((g) => g.key))}`);

      const row = own.items.find((i) => i.id === id);
      assert.ok(row, 'their own submission is missing from it');
      // Everything the studio asked the record to carry.
      assert.strictEqual(typeof row.clientName, 'string', 'the client they chose');
      assert.ok(row.clientName.length, 'named, not blank');
      assert.strictEqual(row.projectName, 'Nightgarden');
      assert.strictEqual(row.link, 'https://example.test/pat-record');
      assert.strictEqual(row.description, 'The act two cut.');
      assert.ok(row.createdAt, 'and when they sent it');
      assert.strictEqual(row.status, 'pending', 'with where it has got to');

      /* Read-only, said in the data rather than left to the page to remember.
         'none' is what the renderer reads to draw no control at all. */
      assert.strictEqual(own.act, 'none');
      assert.strictEqual(own.countable, false);
    });
  });

  await t.test('their record is not somebody else\'s queue, and does not light the tab',
    async () => {
      await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'], async () => {
        // Somebody else's submission, which they must not see.
        const theirs = await submit('root', { clientId, projectId, link: 'https://example.test/not-pats' });
        const patSent = await submit('pat', { clientId, projectId, link: 'https://example.test/pats-own' });

        const seen = (await as('pat', '/project-reviews/pending-actions')).body;
        assert.deepStrictEqual(seen.groups.map((g) => g.key),
          ['my_submissions', 'my_to_acknowledge', 'my_answered'],
          'the record is all they hold, so it is all they get — split across the two sub-tabs');
        const ids = seen.groups.flatMap((g) => g.items.map((i) => i.id));
        assert.ok(ids.includes(patSent.body.request.id));
        assert.ok(!ids.includes(theirs.body.request.id), 'somebody else\'s submission leaked in');

        /* The badge means "waiting on you". A record that never empties must not
           drive it, or the tab lights up on somebody's first submission and stays
           lit for good — training them to ignore the one signal it has. */
        assert.strictEqual(seen.count, 0,
          `a read-only record must not count: ${JSON.stringify(seen.groups.map((g) => [g.key, g.items.length]))}`);
        assert.strictEqual(seen.counts.active, 0, 'the badge reads Active, and Active is a record');
        assert.ok(seen.groups.some((g) => g.items.length), 'even though there is plenty to read');
      });
    });

  await t.test('the record keeps the item after the Creative Director answers', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine',
      'project.review_queue'], async () => {
      const made = await submit('pat', { clientId, projectId, link: 'https://example.test/pat-outcome' });
      const id = made.body.request.id;
      /* Across both sub-tabs: a submission moves from the Active side of the
         record to the History side when it is answered, and the point of the
         record is that it is still there either way. */
      const mine = async () => (await as('pat', '/project-reviews/pending-actions')).body
        .groups.filter((g) => ['my_submissions', 'my_to_acknowledge', 'my_answered'].includes(g.key))
        .flatMap((g) => g.items.map((i) => ({ ...i, phase: g.phase, act: g.act })))
        .find((i) => i.id === id);

      const first = await mine();
      assert.strictEqual(first.status, 'pending');
      assert.strictEqual(first.phase, 'active', 'unanswered, so it is Active for them');

      await as('cad', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'Tighten the opening.' } });

      /* Still there, which is the whole point of a record over an outbox: the
         submitter asked to be able to see what became of what they sent. */
      /* Answered, and still Active for them: the answer they asked for has
         arrived and reading it is theirs to do. It leaves when they say so. */
      const after = await mine();
      assert.ok(after, 'the submission vanished from its sender\'s view once answered');
      assert.strictEqual(after.status, 'feedback_given');
      assert.strictEqual(after.phase, 'active', 'answered but unread is still theirs to deal with');
      assert.strictEqual(after.act, 'acknowledge');
      assert.ok(after.reviewedAt, 'with when it was answered');

      await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
      const closed = await mine();
      assert.strictEqual(closed.phase, 'history', 'and once acknowledged it moves to History');

      // And closing it off does not take it away either.
      await as('pat', `/project-reviews/${id}/close`, { method: 'POST' });
      assert.ok(await mine(), 'nor does Production finishing with it');
    });
  });

  await t.test('a submitter cannot answer their own submission', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'], async () => {
      const made = await submit('pat', { clientId, projectId, link: 'https://example.test/pat-cannot' });
      const refused = await as('pat', `/project-reviews/${made.body.request.id}/feedback`, {
        method: 'POST', body: { feedback: 'Looks great, if I say so myself' } });
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

      // Seeing your own record grants nothing at all beyond seeing it.
      const seen = (await as('pat', '/project-reviews/pending-actions')).body;
      assert.ok(!seen.groups.some((g) => g.act === 'respond' || g.act === 'close'),
        'the record must not come with anybody else\'s actions attached');
    });
  });

  await t.test('nobody answers their own submission — not even Super Admin', async () => {
    /* The bug the studio reported twice, as a test.
     *
     * It was never the gate: the feedback box is drawn for every row in the
     * "waiting on your review" group, and that group was filtered on status
     * alone. Who sent a row never entered the decision.
     *
     * Super Admin is the case that made it certain rather than merely
     * possible: project.review_send ships to Super Admin alone, so on a studio
     * that has granted sending to nobody else, the ONLY account that can
     * submit is one that also holds review_respond — and it saw a feedback box
     * on everything it sent, every time. */
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/sa-own' });
    const id = made.body.request.id;

    const seen = (await as('root', '/project-reviews/pending-actions')).body;
    const answerable = seen.groups.find((g) => g.key === 'awaiting_review');
    assert.ok(answerable, 'Super Admin still has an answer queue');
    assert.ok(!answerable.items.some((i) => i.id === id),
      'their own submission is in the queue they answer from');

    // And it is refused, not merely hidden — a rule that only removes a button
    // is a button that is hard to find.
    const refused = await as('root', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Answering myself' } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error, /You sent this one/);

    // Still theirs to see, in the read-only record.
    const own = seen.groups.find((g) => g.key === 'my_submissions');
    assert.ok(own && own.items.some((i) => i.id === id), 'and it is still in their record');

    // Somebody else can answer it, which is the whole point of the queue.
    const byCad = await as('cad', `/project-reviews/${id}/feedback`, {
      method: 'POST', body: { feedback: 'Answered by the Creative Director.' } });
    assert.strictEqual(byCad.status, 200, JSON.stringify(byCad.body));
  });

  await t.test('a role holding both send and respond sees no box on its own item', async () => {
    /* The configuration the last fix was not tested against, and the reason it
       passed while the bug stood. Production granted BOTH — a studio choice
       somebody could reasonably make — must still not be able to answer its
       own submission, and must not see the same item twice. */
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine',
      'project.review_respond'], async () => {
      const mine = await submit('pat', { clientId, projectId, link: 'https://example.test/pat-both' });
      const theirs = await submit('root', { clientId, projectId, link: 'https://example.test/root-for-pat' });

      const seen = (await as('pat', '/project-reviews/pending-actions')).body;
      const answerable = seen.groups.find((g) => g.key === 'awaiting_review');
      assert.ok(answerable, 'they hold respond, so the queue is there');

      assert.ok(!answerable.items.some((i) => i.id === mine.body.request.id),
        'their own submission must not be answerable by them');
      assert.ok(answerable.items.some((i) => i.id === theirs.body.request.id),
        'and somebody else\'s still is — the queue is not simply empty');

      // The same item, actionable in one place and read-only in another, is
      // the shape the studio saw. It must not happen for a pending row.
      const record = seen.groups.find((g) => g.key === 'my_submissions');
      const answerableIds = new Set(answerable.items.map((i) => i.id));
      const both = record.items.filter((i) => i.status === 'pending' && answerableIds.has(i.id));
      assert.deepStrictEqual(both, [],
        'a pending submission appeared in both the record and the answer queue');

      const refused = await as('pat', `/project-reviews/${mine.body.request.id}/feedback`, {
        method: 'POST', body: { feedback: 'Approving my own' } });
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    });
  });

  await t.test('Submit Feedback is held by a permission, not by a role name', async () => {
    /* The point of this test is the bug class, not the feature: this app has
       twice shipped a gate written as `role === something`, and a gate like
       that cannot be turned off in Settings. So the proof is behavioural —
       take the permission away from the role that has it and the action must
       go; give it to a role that never had it and the action must appear. */
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/not-hardcoded' });
    const id = made.body.request.id;
    /* Without pending.view there is no tab at all, which is a different answer
       from "the tab is there and the action is not". Both count as "cannot
       respond" here, and conflating them would have let a 403 masquerade as
       proof the gate worked. */
    const canRespond = async (who) => {
      const res = await as(who, '/project-reviews/pending-actions');
      return res.status === 200 && res.body.groups.some((g) => g.act === 'respond');
    };

    // As it ships: the Creative Art Director, and nobody else below Super Admin.
    assert.strictEqual(await canRespond('cad'), true);

    // Off in Settings, and the Creative Art Director loses it — a hardcoded
    // check would sail straight past this.
    const cadPerms = await permsOf('creative_art_director');
    try {
      await setPerms('creative_art_director', cadPerms.filter((p) => p !== 'project.review_respond'));
      assert.strictEqual(await canRespond('cad'), false,
        'the action survived the permission being switched off — it is hardcoded somewhere');
      const blocked = await as('cad', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'still here?' } });
      assert.strictEqual(blocked.status, 403, 'and the endpoint must refuse them too, not just the page');
    } finally {
      await setPerms('creative_art_director', cadPerms);
    }
    assert.strictEqual(await canRespond('cad'), true, 'and switching it back on restores it');

    /* And the other direction. An Art Director is a different designation with
       no claim on this queue; granted the permission, they can answer. A gate
       reading the role name could never do this. */
    assert.strictEqual(await canRespond('dee'), false, 'not theirs to begin with');
    await withPerms('art_director', ['project.review_respond', 'pending.view'], async () => {
      assert.strictEqual(await canRespond('dee'), true, 'granted in Settings, and it works');
      const answered = await as('dee', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'Answered by a designation granted this in Settings.' } });
      assert.strictEqual(answered.status, 200, JSON.stringify(answered.body));
    });
  });

  await t.test('Super Admin keeps the action, as it keeps every permission', async () => {
    /* Stated as a test because the studio asked whether this feature should be
       the first to exclude Super Admin, and the answer was no. Super Admin is
       the role that repairs everyone else's access; a queue it cannot reach is
       a queue nobody can unblock when the Creative Director is away or the
       permission is set wrong. If that answer ever changes, this test is what
       has to change with it. */
    const seen = (await as('root', '/project-reviews/pending-actions')).body;
    assert.ok(seen.groups.some((g) => g.act === 'respond'),
      'Super Admin must keep the answer action');

    /* On somebody else's submission. Super Admin keeping this permission and
       Super Admin not answering its own submission are two different rules,
       and this test used to conflate them — it had Super Admin answer what it
       had just sent, which is exactly the thing that turned out to be the bug.
       Sent by the Creative Art Director here, so the queue has something in it
       that is genuinely Super Admin's to answer. */
    await withPerms('creative_art_director', ['project.review_send'], async () => {
      const made = await submit('cad', { clientId, projectId, link: 'https://example.test/sa-answers' });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      const res = await as('root', `/project-reviews/${made.body.request.id}/feedback`, {
        method: 'POST', body: { feedback: 'Answered by Super Admin.' } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
  });

  await t.test('seeing your own record is its own toggle in Settings', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view'], async (before) => {
      await submit('pat', { clientId, projectId, link: 'https://example.test/toggle' });

      // Sending without the record: the tab opens and holds nothing.
      const without = (await as('pat', '/project-reviews/pending-actions')).body;
      assert.deepStrictEqual(without.groups, [], 'the record must not arrive unasked');

      await setPerms('producer', [...new Set([...before, 'project.review_send', 'pending.view',
        'project.review_mine'])]);
      const withIt = (await as('pat', '/project-reviews/pending-actions')).body;
      assert.deepStrictEqual(withIt.groups.map((g) => g.key),
        ['my_submissions', 'my_to_acknowledge', 'my_answered']);
    });

    // And it is offered in Settings under a name somebody can act on.
    const listed = (await as('root', '/permissions/roles/producer')).body.role.permissions
      .find((p) => p.key === 'project.review_mine');
    assert.ok(listed, 'Settings must offer it');
    const superAdmin = (await as('root', '/permissions/roles/super_admin')).body.role.permissions
      .find((p) => p.key === 'project.review_mine');
    assert.ok(superAdmin && superAdmin.enabled, 'and Super Admin holds it without being toggled');
  });

  await t.test('Active and History mean the same thing for all three roles', async () => {
    /* The studio proposed reading the status field alone, uniformly. That is
       uniform in mechanism and comes apart for Production: every row they ever
       see is feedback_given, so status alone would put their whole workload
       under History and leave Active permanently empty — and, since the badge
       counts Active only, would silence their notification entirely.

       So the rule is uniform in MEANING instead: Active is the part this person
       owes and has not done, History is the part they have. Production's half
       needs nothing new built — "Done, actioned" (POST /:id/close) has been
       there since the tab shipped. */
    const phaseOf = async (who, id) => {
      const { groups } = (await as(who, '/project-reviews/pending-actions')).body;
      const g = groups.find((x) => x.items.some((i) => i.id === id));
      return g ? g.phase : null;
    };
    const badge = async (who) => (await as(who, '/project-reviews/pending-actions')).body.counts.active;

    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine',
      'project.review_queue'], async () => {
      const made = await submit('pat', { clientId, projectId, link: 'https://example.test/three-roles' });
      const id = made.body.request.id;

      // --- submitted, not yet answered ---
      assert.strictEqual(await phaseOf('cad', id), 'active', 'CD: theirs to answer');
      assert.strictEqual(await phaseOf('pat', id), 'active', 'submitter: still waiting on an answer');
      assert.ok((await badge('cad')) > 0, 'and the CD is told there is work');

      // --- answered ---
      await as('cad', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'Bring the grade down half a stop.' } });

      assert.strictEqual(await phaseOf('cad', id), 'history', 'CD: they have answered it');
      assert.strictEqual(await phaseOf('pat', id), 'active',
        'Production: answered is exactly when it becomes theirs to act on');

      /* The heart of it. Under status-alone this would read 'history' for
         Production while still being the thing they have to do. */
      const prodActive = (await as('pat', '/project-reviews/pending-actions')).body
        .groups.find((g) => g.key === 'awaiting_followup');
      assert.ok(prodActive.items.some((i) => i.id === id));
      assert.ok((await badge('pat')) > 0,
        'and Production keeps a badge — status-alone would have left them without one');

      // --- Production finishes with it ---
      await as('pat', `/project-reviews/${id}/close`, { method: 'POST' });
      assert.strictEqual(await phaseOf('pat', id), 'history', 'Production: done with it');
    });
  });

  await t.test('the badge counts Active only, and History never lights it', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine',
      'project.review_queue'], async () => {
      const read = async (who) => (await as(who, '/project-reviews/pending-actions')).body;

      const made = await submit('pat', { clientId, projectId, link: 'https://example.test/badge-split' });
      const id = made.body.request.id;
      await as('cad', `/project-reviews/${id}/feedback`, {
        method: 'POST', body: { feedback: 'Fine as it is.' } });
      await as('pat', `/project-reviews/${id}/close`, { method: 'POST' });

      const cad = await read('cad');
      const history = cad.groups.filter((g) => g.phase === 'history');
      assert.ok(history.some((g) => g.items.length), 'the CD has something in History');
      assert.strictEqual(cad.counts.history > 0, true);
      /* Whatever is in History, the badge is the Active number and only that.
         An item already dealt with must never keep the tab lit. */
      assert.strictEqual(cad.count, cad.counts.active, 'count is the Active count');
      const activeItems = cad.groups.filter((g) => g.phase === 'active' && g.countable !== false)
        .reduce((n, g) => n + g.items.length, 0);
      assert.strictEqual(cad.counts.active, activeItems);
      assert.ok(!cad.groups.some((g) => g.phase === 'history' && g.countable !== false),
        'no History group may be countable');
    });
  });

  await t.test('History keeps everything readable, and offers no action', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'],
      async () => {
        const made = await submit('pat', { clientId, projectId,
          link: 'https://example.test/history-readable', description: 'The whole act.' });
        const id = made.body.request.id;
        await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Warmer through the middle.' } });
        // The submitter closes their side off; that is what puts it in THEIR History.
        await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });

        for (const who of ['pat', 'cad']) {
          const { groups } = (await as(who, '/project-reviews/pending-actions')).body;
          const g = groups.find((x) => x.phase === 'history' && x.items.some((i) => i.id === id));
          assert.ok(g, `${who} lost the item on the way to History`);
          /* A display split, not an archive: everything the row carried is
             still on it. */
          const row = g.items.find((i) => i.id === id);
          assert.strictEqual(row.link, 'https://example.test/history-readable');
          assert.strictEqual(row.description, 'The whole act.');
          assert.strictEqual(row.feedback, 'Warmer through the middle.');
          assert.ok(row.createdAt && row.reviewedAt);
          // And nothing in History can be acted on — least of all re-answered.
          assert.strictEqual(g.act, 'none', `${who}'s History group offers an action`);
        }

        // Not re-answerable, which is what act 'none' is promising.
        const again = await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Changed my mind' } });
        assert.strictEqual(again.body.alreadyAnswered, true, 'the first answer stands');
        assert.strictEqual(again.body.request.feedback, 'Warmer through the middle.');
      });
  });

  await t.test('the submitter closes their own thread, and only their own', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'],
      async () => {
        const made = await submit('pat', { clientId, projectId,
          link: 'https://example.test/ack-flow', description: 'For the CD.' });
        const id = made.body.request.id;
        const groupOf = async (who) => {
          const { groups } = (await as(who, '/project-reviews/pending-actions')).body;
          return groups.find((g) => g.items.some((i) => i.id === id)) || null;
        };

        // Nothing to acknowledge before there is an answer.
        const tooEarly = await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(tooEarly.status, 409, JSON.stringify(tooEarly.body));
        assert.match(tooEarly.body.error, /has not answered this/);
        const waiting = await groupOf('pat');
        assert.strictEqual(waiting.key, 'my_submissions');
        assert.strictEqual(waiting.act, 'none', 'read-only while it is with the Creative Director');

        await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Push the contrast in the last third.' } });

        /* Answered: still Active for them, now with the feedback and an action.
           This is the change — it used to file itself away the moment it was
           written, which is an answer nobody had to read. */
        const toRead = await groupOf('pat');
        assert.strictEqual(toRead.key, 'my_to_acknowledge');
        assert.strictEqual(toRead.phase, 'active');
        assert.strictEqual(toRead.act, 'acknowledge');
        assert.strictEqual(toRead.items.find((i) => i.id === id).feedback,
          'Push the contrast in the last third.', 'with the answer to read');

        /* Somebody else cannot close it, and the two ways of being refused are
           both worth having. The Creative Art Director does not hold
           project.review_mine at all, so they never reach the row. Super Admin
           holds the entire catalogue and reaches it — and is still refused,
           which is the check that matters: this is not "may you close these",
           it is "this one is yours". An acknowledgement by somebody who was not
           waiting on the answer records something that did not happen. */
        const noPermission = await as('cad', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(noPermission.status, 403, JSON.stringify(noPermission.body));

        const notYours = await as('root', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(notYours.status, 403,
          `Super Admin closed off somebody else's thread: ${JSON.stringify(notYours.body)}`);
        assert.match(notYours.body.error, /Only the person who sent this/,
          'and refused for being the wrong person, not for lacking a permission');

        assert.strictEqual((await groupOf('pat')).key, 'my_to_acknowledge', 'and it is untouched');

        const done = await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(done.status, 200, JSON.stringify(done.body));
        assert.strictEqual(done.body.request.acknowledgerEmail, 'pat@zvky.test', 'who closed it');
        assert.ok(done.body.request.acknowledgedAt, 'and when — the audit trail for this step');

        const filed = await groupOf('pat');
        assert.strictEqual(filed.key, 'my_answered');
        assert.strictEqual(filed.phase, 'history');
        assert.strictEqual(filed.act, 'none', 'and it offers nothing further');
        const row = filed.items.find((i) => i.id === id);
        assert.strictEqual(row.link, 'https://example.test/ack-flow', 'the whole thread is kept');
        assert.strictEqual(row.description, 'For the CD.');
        assert.strictEqual(row.feedback, 'Push the contrast in the last third.');
        assert.ok(row.createdAt && row.reviewedAt && row.acknowledgedAt);

        // Twice is not an error, and the first one stands.
        const again = await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.body.alreadyAcknowledged, true);
        assert.strictEqual(again.body.request.acknowledgedAt, done.body.request.acknowledgedAt);
      });
  });

  await t.test('an unread answer counts toward the submitter\'s highlight', async () => {
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'],
      async () => {
        const badge = async () => (await as('pat', '/project-reviews/pending-actions')).body.counts.active;
        const start = await badge();

        const made = await submit('pat', { clientId, projectId, link: 'https://example.test/ack-count' });
        const id = made.body.request.id;
        /* Waiting on the Creative Director is not the submitter's action, so it
           still does not count — the badge means "you", not "something of
           yours is in flight". */
        assert.strictEqual(await badge(), start, 'an unanswered submission is not their action');

        await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Ready to go.' } });
        assert.strictEqual(await badge(), start + 1,
          'an answer they have not read IS their action, and this is the addition the studio asked for');

        await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });
        assert.strictEqual(await badge(), start, 'and it clears when they close it off');
      });
  });

  await t.test('acknowledging is the submitter\'s step and touches nobody else\'s', async () => {
    /* The scope guard. Production's close and the Creative Director's split
       were both explicitly not to change, and both are driven by their own
       column — so an acknowledgement must move nothing for either of them. */
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'],
      async () => {
        const phaseFor = async (who, id) => {
          const { groups } = (await as(who, '/project-reviews/pending-actions')).body;
          const g = groups.find((x) => x.items.some((i) => i.id === id));
          return g ? `${g.key}:${g.phase}` : null;
        };
        const made = await submit('pat', { clientId, projectId, link: 'https://example.test/ack-scope' });
        const id = made.body.request.id;
        await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Fine.' } });

        const cadBefore = await phaseFor('cad', id);
        assert.strictEqual(cadBefore, 'reviewed_by_me:history',
          'the Creative Director is finished the moment they answer, as before');

        await as('pat', `/project-reviews/${id}/acknowledge`, { method: 'POST' });

        assert.strictEqual(await phaseFor('cad', id), cadBefore,
          'and the submitter closing their side moved nothing for the reviewer');

        /* Production: still Active, because acknowledgement is not their close.
           Two people have to be finished, and neither implies the other. */
        await withPerms('art_director', ['project.review_queue', 'pending.view'], async () => {
          assert.strictEqual(await phaseFor('dee', id), 'awaiting_followup:active',
            'Production still has to deal with it — an acknowledgement is not their close');
          await as('dee', `/project-reviews/${id}/close`, { method: 'POST' });
          assert.strictEqual(await phaseFor('dee', id), 'followup_done:history');
        });

        // And closing does not un-acknowledge, or vice versa.
        const row = (await queue('cad')).requests.find((r) => r.id === id);
        assert.ok(row.acknowledgedAt && row.closedAt, 'both marks stand, independently');
        assert.strictEqual(row.acknowledgerEmail, 'pat@zvky.test');
        assert.strictEqual(row.closerEmail, 'dee@zvky.test');
      });
  });

  await t.test('the submitter is told when their answer arrives', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];

    /* Deliberately WITHOUT the queue permissions: Production here can send and
       see their own record, and nothing else. That is the case the old code
       missed — the recipient list was built from who watches the queue, so the
       one person actually waiting on the answer was the one person not told. */
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine'],
      async () => {
        const before = (await inbox('pat')).length;
        const made = await submit('pat', { clientId, projectId, link: 'https://example.test/tell-me' });
        const id = made.body.request.id;
        assert.strictEqual((await inbox('pat')).length, before,
          'sending it is not news to the person who sent it');

        await as('cad', `/project-reviews/${id}/feedback`, {
          method: 'POST', body: { feedback: 'Lift the mids.' } });

        const got = await inbox('pat');
        assert.strictEqual(got.length, before + 1, 'exactly one notification, not none and not two');
        const latest = got[0];
        assert.strictEqual(latest.kind, 'project_review_answered');
        assert.match(latest.message, /has answered your submission on Nightgarden/);
        assert.match(latest.message, /close the thread/, 'and says what to do with it');
        assert.strictEqual(latest.projectId, projectId, 'pointing at the project');
      });
  });

  await t.test('somebody who is both submitter and watcher is told once', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];
    await withPerms('producer', ['project.review_send', 'pending.view', 'project.review_mine',
      'project.review_queue'], async () => {
      const before = (await inbox('pat')).length;
      const made = await submit('pat', { clientId, projectId, link: 'https://example.test/both-hats' });
      await as('cad', `/project-reviews/${made.body.request.id}/feedback`, {
        method: 'POST', body: { feedback: 'Fine.' } });

      const got = await inbox('pat');
      assert.strictEqual(got.length, before + 1,
        `one event, one notification: ${JSON.stringify(got.slice(0, 3).map((n) => n.kind))}`);
      assert.strictEqual(got[0].kind, 'project_review_answered',
        'and it is the sentence addressed to them, not the queue\'s');
    });
  });

  await t.test('the queue still hears about it, and outsiders still do not', async () => {
    const inbox = async (who) => (await as(who, '/notifications')).body.notifications || [];
    const made = await submit('root', { clientId, projectId, link: 'https://example.test/queue-too' });
    await as('cad', `/project-reviews/${made.body.request.id}/feedback`, {
      method: 'POST', body: { feedback: 'Good to go.' } });

    // cad2 watches the queue, did not write it, and did not send it.
    assert.strictEqual((await inbox('cad2'))[0].kind, 'project_review_feedback',
      'a watcher still gets the watcher sentence');
    // Super Admin sent this one, so they get the submitter's sentence instead.
    assert.strictEqual((await inbox('root'))[0].kind, 'project_review_answered');
    // And somebody with no business in this workflow is told nothing at all.
    assert.strictEqual((await inbox('ana')).filter((n) => /project_review/.test(n.kind)).length, 0);
  });

  await t.test('the record holds everything the studio asked it to', async () => {
    const rows = await sql(cfg, 'SELECT * FROM project_review_requests ORDER BY created_at LIMIT 1');
    const r = rows[0];
    for (const column of ['client_id', 'project_id', 'link', 'submitted_by', 'submitter_email',
      'status', 'feedback', 'closed_by', 'closer_email', 'closed_at', 'created_at']) {
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
    await as('cad', `/project-reviews/${made.body.request.id}/feedback`, {
      method: 'POST', body: { feedback: 'Everything is too blue' } });

    const after = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === asset.id).status;
    assert.strictEqual(after, before, 'no asset moved');
    assert.deepStrictEqual(await snapshot(), wasAll,
      'and feedback on the PROJECT moved none of its assets — the whole point of '
      + 'recording it against the submission instead');

    // And no asset event was written for it.
    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%project%'");
    assert.strictEqual(Number(events[0].n), 0, 'a project review is not an asset event');
  });
});
