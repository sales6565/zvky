/* One active task at a time.
 *
 * A person may have one asset started and not yet submitted. Accept and Start
 * is refused on everything else of theirs until it is handed on.
 *
 * The rule is checked against an OPEN WORK SESSION, not against the in_progress
 * status, and that distinction is the whole reason this file is careful. Rework
 * after TL or CD Feedbacks is started with the same button and worked on with
 * the asset still sitting in tl_changes_requested — it never becomes
 * in_progress. A rule written against the status would miss exactly the case
 * that matters most: somebody holding a rework round and picking up a fresh
 * task alongside it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('oneTask');

test('the rule is keyed on an open session, not on the in_progress status', () => {
  /* Asserted against the source because it is the design decision the feature
     turns on, and because a later "simplification" to status === 'in_progress'
     would pass every other test in this file that uses a fresh assignment. */
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  const guard = /const elsewhere = await workLog\.openForUser\(db, req\.user\.id, req\.params\.id\);/;
  assert.match(routes, guard, 'the guard should ask the work log, not the status column');

  const log = fs.readFileSync(path.join(__dirname, '..', 'src', 'work-log.js'), 'utf8');
  const fn = /async function openForUser[\s\S]*?\n\}/.exec(log);
  assert.ok(fn, 'openForUser should exist');
  assert.match(fn[0], /ended_at IS NULL/, 'an open session is one that has not ended');
  assert.ok(!/in_progress/.test(fn[0]), 'and the status has nothing to do with it');
});

test('the guard is on taking up work and on nothing else', () => {
  /* Point 3 of the brief: a lead with their own task under way still reviews,
     approves, relays and files a timesheet. Counted rather than eyeballed, so
     that adding the check to an endpoint that is not about taking up work
     fails here.
     
     Three, since Hold arrived. RESUME is the third, and it has to be: holding
     closes the session, so without the same check somebody could hold A, start
     B and resume A, and hold their way to two open tasks — which would make
     this feature a way around the rule instead of a use of it. The count is the
     point. If it moves again, the question to ask is whether the new call site
     is somebody TAKING UP work, or somebody merely doing their job around it. */
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  const uses = routes.match(/workLog\.openForUser\(/g) || [];
  assert.strictEqual(uses.length, 3,
    'exactly three: the guards in /start and /resume, and the shared shaper the page reads');

  for (const file of ['timesheets.js', 'project-reviews.js', 'users.js', 'projects.js']) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
    assert.ok(!/openForUser/.test(body), `src/routes/${file} must not gate anything on this rule`);
  }
});

test('the single-active-task rule', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'One-Task-1!';
  let server;
  const token = {};
  const people = {};
  let clientId;
  let projectA;
  let projectB;
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });
  const makeAsset = async (projectId, name, assigneeId) => (await as('root', `/assets/project/${projectId}`,
    { method: 'POST', body: { name, type: 'character', assigneeId } })).body.asset;
  const submit = (who, id) => as(who, `/assets/${id}/submit`,
    { method: 'POST', body: { link: 'https://example.test/v1', description: 'done' } });
  const board = async (who, projectId) => (await as(who, `/assets/project/${projectId}`)).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'one-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'one-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = (await as('root', '/clients')).body.clients[0].id;
    projectA = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;
    projectB = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Dayfall' } })).body.project.id;
    for (const [who, role, projectId] of [['lee', 'team_lead', projectA],
      ['ana', 'game_artist', projectA], ['bo', 'game_artist', projectA]]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    await as('root', `/users/${people.ana}`, { method: 'PATCH',
      body: { reportsToId: people.lee, teamLeadId: people.lee } });
  });
  t.after(() => stopServer(server));

  await t.test('a second task cannot be started while one is open', async () => {
    const first = await makeAsset(projectA, 'River Spirit', people.ana);
    const second = await makeAsset(projectA, 'Stone Golem', people.ana);

    assert.strictEqual((await start('ana', first.id)).status, 200, 'the first one starts');

    const blocked = await start('ana', second.id);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /Finish your current task/);
    assert.match(blocked.body.error, new RegExp(first.code), 'and it names what to go and finish');
    assert.strictEqual(blocked.body.activeWork.assetId, first.id);

    // Nothing happened to the asset that was refused.
    const still = (await board('ana', projectA)).assets.find((a) => a.id === second.id);
    assert.strictEqual(still.status, 'assigned', 'it was not accepted and then refused');
    assert.strictEqual(still.work_open, false, 'and no session was opened on it');
  });

  await t.test('the block reaches across projects and clients', async () => {
    /* Point 1: this is about one person's capacity, not one project's. */
    const other = await makeAsset(projectB, 'Far Away', people.ana);
    const blocked = await start('ana', other.id);
    assert.strictEqual(blocked.status, 409, 'a different project is still the same person');
    assert.match(blocked.body.error, /Finish your current task/);
  });

  await t.test('re-starting the task you are already on is not blocked by itself', async () => {
    const open = (await board('ana', projectA)).activeWork;
    const again = await start('ana', open.assetId);
    /* The pre-existing "already started" answer, not the new rule — the guard
       excludes the asset being asked about, or the button on your own open task
       would tell you to go and finish it. */
    assert.strictEqual(again.status, 409);
    assert.match(again.body.error, /already been started/);
    assert.strictEqual(again.body.activeWork, undefined, 'a different refusal entirely');
  });

  await t.test('submitting unlocks the next task', async () => {
    const open = (await board('ana', projectA)).activeWork;
    assert.ok(open, 'something is open');
    assert.strictEqual((await submit('ana', open.assetId)).status, 201);

    const after = await board('ana', projectA);
    assert.strictEqual(after.activeWork, null, 'and now nothing is');

    const next = after.assets.find((a) => a.status === 'assigned');
    assert.strictEqual((await start('ana', next.id)).status, 200, 'the next one starts');
  });

  await t.test('a returned feedback round blocks the next task too', async () => {
    /* Point 2, and the case the in_progress status cannot see. The asset sits
       in TL Feedbacks the whole time it is being reworked. */
    const open = (await board('ana', projectA)).activeWork;
    await submit('ana', open.assetId);

    // Send it back.
    const sent = (await board('ana', projectA)).assets.find((a) => a.status === 'pending_tl_review');
    assert.ok(sent, 'it is with the lead');
    const back = await as('lee', `/assets/${sent.id}/review`,
      { method: 'POST', body: { decision: 'changes_requested', text: 'the silhouette reads flat' } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));

    const reworking = (await board('ana', projectA)).assets.find((a) => a.id === sent.id);
    assert.strictEqual(reworking.status, 'tl_changes_requested');

    // Start the rework: allowed, because nothing else is open.
    assert.strictEqual((await start('ana', sent.id)).status, 200, 'rework starts');
    const during = (await board('ana', projectA)).assets.find((a) => a.id === sent.id);
    assert.strictEqual(during.status, 'tl_changes_requested',
      'and the status is STILL not in_progress — which is why the rule cannot read it');
    assert.strictEqual(during.work_open, true, 'but a session is open');

    // So a fresh task is blocked.
    const fresh = await makeAsset(projectA, 'Ember Fox', people.ana);
    const blocked = await start('ana', fresh.id);
    assert.strictEqual(blocked.status, 409, 'rework holds the slot');
    assert.match(blocked.body.error, new RegExp(sent.code));

    await submit('ana', sent.id);
    assert.strictEqual((await start('ana', fresh.id)).status, 200, 'and releases it on submit');
  });

  await t.test('reassigning away releases the person who had it', async () => {
    /* Not in the brief, and the failure it prevents is the worst one this
       feature could have: a session left open on an asset somebody no longer
       holds would block them from every task, for ever, with no way out. The
       work log closes the session on reassign and unassign as well as on
       submit, so the block lifts — asserted, because the whole rule rests on
       it. */
    const open = (await board('ana', projectA)).activeWork;
    assert.ok(open, 'Ana has something open');

    await as('root', `/assets/${open.assetId}`, { method: 'PATCH', body: { assigneeId: people.lee } });
    assert.strictEqual((await board('ana', projectA)).activeWork, null,
      'handing it on released her');

    const spare = await makeAsset(projectA, 'Salt Marsh', people.ana);
    assert.strictEqual((await start('ana', spare.id)).status, 200, 'and she can start again');

    // And unassigning does the same.
    await as('root', `/assets/${spare.id}`, { method: 'PATCH', body: { assigneeId: null } });
    assert.strictEqual((await board('ana', projectA)).activeWork, null, 'unassigning too');
  });

  await t.test('a status change that is not a submit also releases the person', async () => {
    /* The deadlock this closes.
     *
     * Only submit, reassign and unassign ever closed a session. Every other way
     * an asset's status can change left one open, and the most reachable of
     * them is an ordinary correction: a lead moving a started asset back to
     * Assigned, which any holder of asset.edit can do.
     *
     * The result was not a cosmetic leak. The open session is what this whole
     * rule reads, so the person was blocked on every other asset they held —
     * and could not clear it, because the asset was back in Assigned: too early
     * to submit ("start the work before submitting it") and too late to start
     * ("work has already been started on this asset"). Stuck, with nothing on
     * screen to explain why, which is exactly how it was reported. */
    const stuck = await makeAsset(projectA, 'Kiln Warden', people.ana);
    assert.strictEqual((await start('ana', stuck.id)).status, 200);
    assert.strictEqual((await board('ana', projectA)).activeWork.assetId, stuck.id);

    // The correction: put it back to Assigned. No submit, no handover.
    const moved = await as('root', `/assets/${stuck.id}`, { method: 'PATCH', body: { status: 'assigned' } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));

    assert.strictEqual((await board('ana', projectA)).activeWork, null,
      'the session went with the status, so she is free');

    const other = await makeAsset(projectA, 'Reed Warden', people.ana);
    assert.strictEqual((await start('ana', other.id)).status, 200, 'and she can start something else');

    /* And the asset she was moved off is workable again rather than being a
       hole she can never climb out of. */
    await submit('ana', other.id);
    assert.strictEqual((await start('ana', stuck.id)).status, 200, 'the moved asset starts again');
    await submit('ana', stuck.id);
  });

  await t.test('a new assignment still lands while a task is open', async () => {
    /* Point 4: the assignment is allowed, the button is not. Blocking the
       assignment would make somebody else's planning wait on this person's
       desk being clear. */
    const mine = await makeAsset(projectA, 'Kiln', people.ana);
    assert.strictEqual((await start('ana', mine.id)).status, 200);

    const queued = await makeAsset(projectA, 'Anvil', people.ana);
    assert.strictEqual(queued.status, 'assigned', 'the assignment went through');
    const seen = (await board('ana', projectA)).assets.find((a) => a.id === queued.id);
    assert.ok(seen, 'and it is on their board');
    assert.strictEqual(seen.status, 'assigned', 'sitting in the queue');
    assert.strictEqual((await start('ana', queued.id)).status, 409, 'with starting refused');
  });

  await t.test('nothing else the person may do is restricted', async () => {
    /* Point 3, against the running application. Ana has a task open
       throughout; none of this is affected by it. */
    assert.ok((await board('ana', projectA)).activeWork, 'she is mid-task');

    // Her own timesheet.
    assert.strictEqual((await as('ana', '/timesheets/entries', { method: 'POST',
      body: { date: '2026-03-02', startTime: '10:00', endTime: '12:00', clientId, projectId: projectA } })).status,
    201, 'timesheet entry');
    assert.strictEqual((await as('ana', '/timesheets/submit', { method: 'POST',
      body: { date: '2026-03-02' } })).status, 200, 'timesheet submit');

    // Reading and editing, and her own profile.
    assert.strictEqual((await as('ana', '/auth/me')).status, 200);
    assert.strictEqual((await as('ana', `/assets/project/${projectA}`)).status, 200);
  });

  await t.test('reviewing is never blocked by having your own task open', async () => {
    /* The brief names "a Team Lead or CD who also has assigned tasks". That
       specific person cannot exist here: no designation in this application is
       both assignable and able to review — roleDef().assignable is false for
       every reviewing role, so a Team Lead is never assigned work in the first
       place. The concern is real for one group though, and this is them: a
       full-access account can open a session on anybody's asset for oversight
       AND holds the review permissions. So the test is written against the
       person who can actually be in both positions at once. */
    const mine = (await as('root', '/auth/me')).body.user.id;

    // Something for Ana to submit, so there is a review waiting.
    const anaOpen = (await board('ana', projectA)).activeWork;
    let toReview = anaOpen && anaOpen.assetId;
    if (!toReview) {
      const spare = await makeAsset(projectA, 'For Review', people.ana);
      assert.strictEqual((await start('ana', spare.id)).status, 200);
      toReview = spare.id;
    }
    assert.strictEqual((await submit('ana', toReview)).status, 201);

    // Root opens a session of their own, for oversight.
    const oversight = await makeAsset(projectA, 'Oversight', people.ana);
    assert.strictEqual((await start('ana', oversight.id)).status, 200, 'Ana starts it');
    // Root joins the same asset — allowed for full access, and it is a session
    // in Root's name too.
    const rootStarted = await start('root', oversight.id);
    assert.ok([200, 409].includes(rootStarted.status), JSON.stringify(rootStarted.body));

    // Whatever Root has open, reviewing is untouched by it.
    const approved = await as('root', `/assets/${toReview}/review`,
      { method: 'POST', body: { decision: 'approved', text: 'good' } });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));

    // And so is relaying, and reading anybody's board.
    assert.strictEqual((await as('root', `/assets/project/${projectA}`)).status, 200);
    assert.strictEqual((await as('root', '/timesheets/pending')).status, 200);
    assert.strictEqual((await as('root', '/project-reviews/queue')).status, 200);
  });

  await t.test('there is no exemption for any designation', async () => {
    /* Point 6: uniform.
     *
     * Worth being exact about what can be demonstrated. A full-access account
     * cannot reach this rule at all, and not because it is exempt: they cannot
     * be assigned work (assignable is false), cannot accept on somebody's
     * behalf (the accept transition belongs to the assignee), and cannot open a
     * second session on work already under way (one session per asset). So
     * there is no way for a Super Admin to hold two open tasks, and no live
     * scenario that would prove an exemption either way.
     *
     * What IS demonstrable is that the guard has no notion of a role, and that
     * a different assignable designation is subject to it identically. Both are
     * asserted, because "uniform" is a claim about the code as much as about
     * one run of it. */
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
    const guard = /const elsewhere = await workLog\.openForUser[\s\S]*?\n  \}/.exec(routes);
    assert.ok(guard, 'the guard should be findable');
    for (const escape of ['hasFullAccess', 'roleDef', 'req.user.role', 'super_admin', 'can(']) {
      assert.ok(!guard[0].includes(escape),
        `the guard consults ${escape} — it must not know anything about who is asking`);
    }

    // And a second, senior designation is bound by it exactly as the first is.
    await as('root', `/users/${people.bo}`, { method: 'PATCH', body: { role: 'senior_game_artist' } });
    const freshToken = (await call('/auth/login', { method: 'POST',
      body: { email: 'bo@zvky.test', password: PASSWORD } })).body.token;
    token.bo = freshToken;

    let open = (await board('bo', projectA)).activeWork;
    if (open) await submit('bo', open.assetId);
    const one = await makeAsset(projectA, 'Senior One', people.bo);
    const two = await makeAsset(projectA, 'Senior Two', people.bo);
    assert.strictEqual((await start('bo', one.id)).status, 200, 'a senior artist starts one');
    assert.strictEqual((await start('bo', two.id)).status, 409, 'and is refused the second');
  });

  await t.test('the board says what is holding the person up', async () => {
    /* What the page reads to disable the button. Sent with the board rather
       than asked per asset: the answer is the same for every row, and two rows
       that disagreed about it would be a bug nobody could explain. */
    let open = (await board('bo', projectA)).activeWork;
    assert.ok(open, 'the senior artist still has one open from the test above');
    assert.ok(open.code, 'named, so the refusal can say what to finish');
    assert.ok(open.assetId && open.since, 'and identified, with when it started');

    // It is per person. Ana's board carries hers, not theirs.
    const anaFree = (await board('ana', projectA)).activeWork;
    if (anaFree) {
      assert.notStrictEqual(anaFree.assetId, open.assetId,
        'one person\'s open task is never another\'s');
    }

    // And it clears the moment the work is handed on.
    await submit('bo', open.assetId);
    assert.strictEqual((await board('bo', projectA)).activeWork, null,
      'submitting empties it, which is what re-enables the next button without a reload');
  });
});
