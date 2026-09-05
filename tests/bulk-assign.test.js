/* Assigning and scheduling several assets in one action.
 *
 * The feature is a loop around machinery that already exists, so most of what
 * is worth testing is the seams:
 *
 *   PARITY. A bulk assignment must leave exactly what a single one leaves — the
 *   status, the assignment episode, the history row, the notification. This
 *   route calls the same primitives rather than sharing a function with
 *   PATCH /assets/:id, which is a deliberate choice (that route carries cases
 *   this one cannot reach), and these assertions are what stops the two
 *   drifting apart now that nothing else would notice.
 *
 *   THE SCOPE RULE. Not Assigned only, reported per row rather than silently
 *   skipped, because a mixed selection is the ordinary case and somebody who
 *   ticked twenty rows needs to know which four were left alone.
 *
 *   WHOLE-REQUEST vs PER-ROW refusals. A bad date is wrong for every asset at
 *   once and belongs in a 400; an asset being in review is wrong for that asset
 *   and belongs in its row. Getting this backwards would either fail a batch
 *   over one bad row, or bury a typo in forty identical results.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const schedule = require('../src/asset-schedule');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('bulkAssign');

test('the bulk action has a permission of its own, off by default', () => {
  const perm = catalogue.BY_KEY.get('asset.bulk_assign');
  assert.ok(perm, 'asset.bulk_assign is in the catalogue');
  /* Nobody below the Super Admin tier holds it out of the box: has('manageAccess')
     is held by no other tier, which is the same idiom the client-feedback four
     use. Pinned because "defaults OFF for everyone else" was the requirement,
     and an impliedBy changed to a wider predicate would silently grant a bulk
     action to half the studio. */
  assert.strictEqual(perm.impliedBy({}), false, 'a role with no capabilities does not get it');
  assert.strictEqual(perm.impliedBy({ editAsset: true, createAsset: true }), false,
    'nor does one that may already assign and create assets one at a time');
  assert.strictEqual(perm.impliedBy({ manageAccess: true }), true);
  assert.notStrictEqual(perm.grantable, false, 'and a studio can grant it in Settings');
});

test('bulk assign and schedule', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Bulk-Plan-1!';
  let server;
  const token = {};
  const people = {};
  let projectId;
  let n = 0;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const makeAsset = async (name, body = {}) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', ...body },
  })).body.asset;
  // A fresh Not Assigned asset, named so a failure says which one.
  const fresh = () => makeAsset(`Unheld ${++n}`);
  const bulk = (who, body) => as(who, '/assets/bulk/assign', { method: 'POST', body });
  const read = async (id) => (await as('root', `/assets/project/${projectId}`)).body.assets
    .find((x) => x.id === id);
  const eventsOn = (id) => sql(cfg,
    'SELECT action, from_status, to_status, note, batch_id FROM asset_events WHERE asset_id = ? ORDER BY created_at, id',
    [id]);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'bulk-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'bulk-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Planning' } })).body.project.id;
    const person = async (name, email, role) => (await as('root', '/users', { method: 'POST', body: {
      name, email, role, password: PASSWORD, projectId,
    } })).body.user.id;
    people.ana = await person('Ana', 'ana@zvky.test', 'game_artist');
    people.bo = await person('Bo', 'bo@zvky.test', 'game_artist');
    token.ana = await login('ana@zvky.test');
  });

  t.after(() => stopServer(server));

  await t.test('one assignee, no dates, applied to all of them', async () => {
    const a = await fresh();
    const b = await fresh();
    const c = await fresh();

    const res = await bulk('root', { assetIds: [a.id, b.id, c.id], assigneeId: people.ana });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.applied, 3);
    assert.strictEqual(res.body.failed, 0);
    assert.ok(res.body.results.every((r) => r.ok), JSON.stringify(res.body.results));

    for (const asset of [a, b, c]) {
      const after = await read(asset.id);
      assert.strictEqual(after.status, 'assigned', `${asset.code} moved to Assigned`);
      assert.strictEqual(after.assignee_name, 'Ana');
      // The dates were not part of the request, so they are untouched.
      assert.strictEqual(schedule.asISODate(after.start_date), null);
      assert.strictEqual(schedule.asISODate(after.due_date), null);
    }
  });

  await t.test('only dates, and who holds the asset is not touched', async () => {
    /* The second half of "each field optional", and the case a combined panel
       exists for: a coordinator scheduling next month's work has no business
       reassigning it at the same time. */
    const a = await fresh();
    const b = await fresh();

    const res = await bulk('root', { assetIds: [a.id, b.id], startDate: '2026-11-02', due: '2026-11-30' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.applied, 2);

    for (const asset of [a, b]) {
      const after = await read(asset.id);
      assert.strictEqual(schedule.asISODate(after.start_date), '2026-11-02');
      assert.strictEqual(schedule.asISODate(after.due_date), '2026-11-30');
      assert.strictEqual(after.status, 'not_started', 'setting dates assigns nothing');
      assert.strictEqual(after.assignee_id, null);
    }

    // And no history row, because nothing about the asset's stage moved.
    const events = await eventsOn(a.id);
    assert.strictEqual(events.length, 0, 'scheduling is an edit, not a transition');
  });

  await t.test('a bulk assignment leaves what a single one leaves', async () => {
    /* The parity that matters. This route deliberately does not share a
       function with PATCH /assets/:id, so nothing but this test stops the two
       diverging — and a bulk assignment that skipped the episode would produce
       assets with no Round in the Assets List and no notification to the person
       who now has the work. */
    const single = await fresh();
    const batched = await fresh();

    await as('root', `/assets/${single.id}`, { method: 'PATCH', body: { assigneeId: people.ana } });
    const res = await bulk('root', { assetIds: [batched.id], assigneeId: people.ana });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const one = await read(single.id);
    const many = await read(batched.id);
    assert.strictEqual(many.status, one.status, 'same status');
    assert.strictEqual(many.routed_to_id, one.routed_to_id, 'routed to the same person');

    // The assignment episode: one open round, to the right person, with the
    // person who did it recorded.
    const episodes = (who) => sql(cfg,
      'SELECT user_id, assigned_by_id, status_at_assignment, ended_at FROM asset_assignments WHERE asset_id = ?',
      [who]);
    const [oneEp] = await episodes(single.id);
    const [manyEp] = await episodes(batched.id);
    assert.ok(manyEp, 'a bulk assignment opens a round');
    assert.strictEqual(manyEp.user_id, oneEp.user_id);
    assert.strictEqual(manyEp.assigned_by_id, oneEp.assigned_by_id);
    assert.strictEqual(manyEp.status_at_assignment, oneEp.status_at_assignment);
    assert.strictEqual(manyEp.ended_at, null, 'and leaves it open');
    assert.strictEqual(many.assignments.length, 1, 'so the Assets List shows a Round for it');

    // The history row, which is what the asset's own panel reads.
    const oneEvents = await eventsOn(single.id);
    const manyEvents = await eventsOn(batched.id);
    assert.strictEqual(manyEvents.length, oneEvents.length, 'the same number of history rows');
    assert.strictEqual(manyEvents[0].action, oneEvents[0].action);
    assert.strictEqual(manyEvents[0].from_status, 'not_started');
    assert.strictEqual(manyEvents[0].to_status, 'assigned');
    assert.strictEqual(manyEvents[0].note, oneEvents[0].note);
    // What the bulk row adds, and the only thing it adds.
    assert.strictEqual(oneEvents[0].batch_id, null);
    assert.strictEqual(manyEvents[0].batch_id, res.body.batchId, 'saying which act it was part of');

    // And the person is told, exactly as they are told about a single one.
    const notes = await sql(cfg,
      'SELECT asset_id FROM notifications WHERE recipient_id = ? AND asset_id IN (?, ?)',
      [people.ana, single.id, batched.id]);
    assert.strictEqual(notes.length, 2, 'both assignments notified Ana');
  });

  await t.test('the batch is recorded as one act', async () => {
    const a = await fresh();
    const b = await fresh();
    const res = await bulk('root', { assetIds: [a.id, b.id], assigneeId: people.bo });
    const [batch] = await sql(cfg,
      'SELECT action, actor_email, requested, succeeded FROM asset_event_batches WHERE id = ?',
      [res.body.batchId]);
    assert.ok(batch, 'the batch row exists');
    assert.strictEqual(batch.action, 'assign_schedule');
    assert.strictEqual(batch.actor_email, 'root@zvky.test');
    assert.strictEqual(Number(batch.requested), 2);
    assert.strictEqual(Number(batch.succeeded), 2);
  });

  await t.test('work already under way is left alone, and said so', async () => {
    /* The scope rule. A mixed selection is the ordinary case — somebody ticks
       a screenful — so the eligible ones must still land, and the rest must
       come back with a reason rather than silently doing nothing. */
    const notStarted = await fresh();
    const started = await makeAsset('Under Way', { assigneeId: people.ana });
    assert.strictEqual((await as('ana', `/assets/${started.id}/start`, { method: 'POST' })).status, 200);

    const res = await bulk('root', { assetIds: [notStarted.id, started.id], assigneeId: people.bo });
    assert.strictEqual(res.status, 200, 'the batch is not failed by the ineligible one');
    assert.strictEqual(res.body.applied, 1);
    assert.strictEqual(res.body.failed, 1);

    const good = res.body.results.find((r) => r.id === notStarted.id);
    const left = res.body.results.find((r) => r.id === started.id);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(left.ok, false);
    assert.strictEqual(left.skipped, true, 'marked as out of scope rather than as an error');
    assert.match(left.error, /In Progress/i, 'and the reason names the stage it is in');
    assert.match(left.error, /one asset at a time/i, 'and points at the flow that does handle it');

    // Untouched, in every way that matters.
    const after = await read(started.id);
    assert.strictEqual(after.assignee_id, people.ana, 'still Ana\'s');
    assert.strictEqual(after.status, 'in_progress');
    const open = await sql(cfg,
      'SELECT id FROM work_sessions WHERE asset_id = ? AND ended_at IS NULL', [started.id]);
    assert.strictEqual(open.length, 1, 'and her work session is still open');

    // Hand it in, so Ana's one-active-task slot is free for the subtests below.
    // Left open, it blocked a later Accept and Start for a reason that had
    // nothing to do with what that test was checking.
    await as('ana', `/assets/${started.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/underway' } });
  });

  await t.test('a start date after the end date is refused for the whole request', async () => {
    /* A whole-request refusal, not forty identical rows: the mistake is in what
       was typed, not in any asset, and nothing should be written before it is
       corrected. */
    const a = await fresh();
    const b = await fresh();
    const res = await bulk('root', {
      assetIds: [a.id, b.id], startDate: '2026-12-20', due: '2026-12-01',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.field, 'startDate');
    assert.match(res.body.error, /cannot be due before it begins/i);
    assert.match(res.body.error, /2026-12-20/, 'and quotes both dates back');
    assert.match(res.body.error, /2026-12-01/);

    // Nothing was written.
    for (const asset of [a, b]) {
      const after = await read(asset.id);
      assert.strictEqual(schedule.asISODate(after.start_date), null);
      assert.strictEqual(schedule.asISODate(after.due_date), null);
    }

    // The same two dates are fine the right way round, and equal is fine too:
    // a task that begins and is due on one day is a day's work, not an error.
    assert.strictEqual((await bulk('root', {
      assetIds: [a.id], startDate: '2026-12-01', due: '2026-12-20',
    })).status, 200);
    assert.strictEqual((await bulk('root', {
      assetIds: [b.id], startDate: '2026-12-05', due: '2026-12-05',
    })).status, 200, 'one day is a schedule');
  });

  await t.test('the assignee has to be a real person', async () => {
    /* Existence is the whole check, and the test says so rather than leaving
       the absence looking like an oversight: this application has no
       active/inactive flag on people — an account exists or has been deleted —
       so there is no dormant state to screen out. */
    const a = await fresh();
    const missing = await bulk('root', {
      assetIds: [a.id], assigneeId: '11111111-2222-3333-4444-555555555555',
    });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.body.field, 'assigneeId');
    assert.match(missing.body.error, /not in this studio/i);
    assert.strictEqual((await read(a.id)).assignee_id, null, 'and nothing was assigned');

    /* Somebody who has since been deleted, which is what a stale dropdown
       actually produces. The refusal is the same one, and it happens before any
       asset is touched — an id that is wrong is wrong for the whole batch. */
    const goneId = (await as('root', '/users', { method: 'POST', body: {
      name: 'Gone', email: 'gone@zvky.test', role: 'game_artist', password: PASSWORD, projectId,
    } })).body.user.id;
    await as('root', `/users/${goneId}`, { method: 'DELETE' });
    const b = await fresh();
    const deleted = await bulk('root', { assetIds: [a.id, b.id], assigneeId: goneId });
    assert.strictEqual(deleted.status, 400, JSON.stringify(deleted.body));
    assert.match(deleted.body.error, /not in this studio/i);
    assert.strictEqual((await read(b.id)).assignee_id, null, 'and no asset in the batch was touched');

    /* Somebody real but not on this project IS allowed, matching the single
       flow: that restriction was deliberately dropped from handover so work can
       go to somebody brought in from another team. */
    const outsiderId = (await as('root', '/users', { method: 'POST', body: {
      name: 'Outsider', email: 'outsider@zvky.test', role: 'game_artist', password: PASSWORD,
    } })).body.user.id;
    const c = await fresh();
    const away = await bulk('root', { assetIds: [c.id], assigneeId: outsiderId });
    assert.strictEqual(away.status, 200, JSON.stringify(away.body));
    assert.strictEqual(away.body.applied, 1, 'project membership is not a condition here either');
  });

  await t.test('a request that changes nothing is refused', async () => {
    const a = await fresh();
    const nothing = await bulk('root', { assetIds: [a.id] });
    assert.strictEqual(nothing.status, 400);
    assert.match(nothing.body.error, /at least one of/i);

    const none = await bulk('root', { assetIds: [], assigneeId: people.ana });
    assert.strictEqual(none.status, 400);
    assert.strictEqual(none.body.field, 'assetIds');
  });

  await t.test('unassigning in bulk is possible, and is not a handover', async () => {
    /* null means clear, as it does in PATCH. Worth a test because the two
       meanings of "not sent" and "sent as null" are easy to collapse into one
       when a form is doing the sending. */
    const a = await fresh();
    await bulk('root', { assetIds: [a.id], assigneeId: people.ana });
    assert.strictEqual((await read(a.id)).status, 'assigned');

    /* And now it is Assigned, so the scope rule refuses it — which is right:
       taking work off somebody is the same kind of decision as giving it to
       somebody else, and it goes through the asset's own panel. */
    const res = await bulk('root', { assetIds: [a.id], assigneeId: null });
    assert.strictEqual(res.body.applied, 0);
    assert.strictEqual(res.body.results[0].skipped, true);
    assert.strictEqual((await read(a.id)).assignee_id, people.ana, 'still theirs');
  });

  await t.test('a bulk-assigned asset obeys the start date gate', async () => {
    /* The two features meeting. Scheduling work to begin next week and handing
       it out in the same action is the whole point of the panel, and it would
       be worth very little if the person could start it that afternoon. */
    const day = (offset) => schedule.todayInIST(new Date(Date.now() + offset * 86400000));
    const later = await fresh();
    const today = await fresh();

    assert.strictEqual((await bulk('root', {
      assetIds: [later.id], assigneeId: people.ana, startDate: day(3), due: day(10),
    })).status, 200);
    assert.strictEqual((await bulk('root', {
      assetIds: [today.id], assigneeId: people.ana, startDate: day(0), due: day(10),
    })).status, 200);

    const refused = await as('ana', `/assets/${later.id}/start`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /cannot be started until/i);
    assert.strictEqual(refused.body.startsOn, day(3));

    assert.strictEqual((await as('ana', `/assets/${today.id}/start`, { method: 'POST' })).status, 200,
      'and one scheduled for today opens normally');
    await as('ana', `/assets/${today.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/today' } });
  });

  await t.test('the permission is what opens the action, and it is not on by default', async () => {
    const a = await fresh();
    // An artist holds asset.hold and timesheet.own out of the box but not this.
    const refused = await bulk('ana', { assetIds: [a.id], assigneeId: people.bo });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual((await read(a.id)).assignee_id, null, 'and nothing happened');
  });

  await t.test('the permission opens the action without widening whose assets it reaches', async () => {
    /* The design point worth pinning: asset.bulk_assign is a key to the bulk
       DOOR, not a grant over other people's work. Granting it to a role that
       cannot assign a given asset one at a time must not let it assign that
       asset in a batch — otherwise one checkbox in Settings quietly becomes
       studio-wide reach, which no other permission in this app gives. */
    const grant = async (role, keys) => {
      const current = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      const wanted = [...new Set([...current, ...keys])];
      const res = await as('root', `/permissions/roles/${role}`, {
        method: 'PUT', body: { permissions: wanted } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return current;
    };
    const before = await grant('game_artist', ['asset.bulk_assign']);

    const a = await fresh();      // created by Root, so not Ana's to assign
    const res = await bulk('ana', { assetIds: [a.id], assigneeId: people.bo });
    assert.strictEqual(res.status, 200, 'the door opens');
    assert.strictEqual(res.body.applied, 0, 'but the asset is still refused');
    assert.match(res.body.results[0].error, /cannot assign this asset/i);
    assert.strictEqual((await read(a.id)).assignee_id, null);

    await as('root', `/permissions/roles/game_artist`, { method: 'PUT', body: { permissions: before } });
  });

  await t.test('one act, one line in the Activity Log', async () => {
    /* Forty assets moved in one click is one thing a person did. The middleware
       writes one entry per request and applyTransition counts the transitions
       inside it, so this asserts the count rather than a wall of identical
       rows — which is what would bury everything else that happened that day. */
    const a = await fresh();
    const b = await fresh();
    /* Counted as a BEFORE and AFTER around this one request. Counting every
       '/bulk/assign' row in the log would count the ones the subtests above
       wrote and prove nothing about how many this call added — which is the
       only thing the assertion is about. */
    const logged = async () => (await as('root', '/activity?module=assets&limit=100')).body
      .entries.filter((e) => String(e.path || '').includes('/bulk/assign'));
    const before = (await logged()).length;

    const res = await bulk('root', { assetIds: [a.id, b.id], assigneeId: people.ana });
    assert.strictEqual(res.body.applied, 2);

    const after = await logged();
    assert.strictEqual(after.length - before, 1,
      'two assets moved in one request is one line, not one line per asset');
    assert.strictEqual(after[0].actor.email, 'root@zvky.test');
  });

  await t.test('an asset that vanished between drawing and applying', async () => {
    const a = await fresh();
    const b = await fresh();
    await as('root', `/assets/${b.id}`, { method: 'DELETE' });

    const res = await bulk('root', { assetIds: [a.id, b.id], assigneeId: people.ana });
    assert.strictEqual(res.body.applied, 1, 'the survivor still lands');
    const gone = res.body.results.find((r) => r.id === b.id);
    assert.strictEqual(gone.ok, false);
    assert.match(gone.error, /no longer exists/i);
  });

  await t.test('the same asset sent twice is done once', async () => {
    const a = await fresh();
    const res = await bulk('root', { assetIds: [a.id, a.id, a.id], assigneeId: people.ana });
    assert.strictEqual(res.body.requested, 1, 'de-duplicated before anything is written');
    assert.strictEqual(res.body.results.length, 1, 'and reported once');
    const episodes = await sql(cfg,
      'SELECT id FROM asset_assignments WHERE asset_id = ?', [a.id]);
    assert.strictEqual(episodes.length, 1, 'one round, not three');
  });
});

test('a bulk route is never shadowed by the single-asset route of the same name', () => {
  /* Express matches in definition order, so POST '/:id/deliver' declared ABOVE
     POST '/bulk/deliver' would swallow the bulk path with id = "bulk" and
     answer "Asset not found" — a routing mistake that reads as a missing asset.
     
     The rule is narrower than "bulk routes go first", which is how the comment
     in the route file reads and how this test first asserted it. '/:id/tasks'
     is declared above both bulk routes and shadows neither, because 'deliver'
     and 'assign' are not 'tasks'. What actually matters is the PAIR: for each
     '/bulk/X' there must be no earlier POST '/:id/X'. Stating it that way is
     what makes the test fail on the real hazard and only on it. */
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');

  const bulkRoutes = [...source.matchAll(/router\.post\('\/bulk\/([a-z-]+)'/g)];
  assert.ok(bulkRoutes.length >= 2, 'both bulk routes are here');
  for (const match of bulkRoutes) {
    const name = match[1];
    const twin = source.indexOf(`router.post('/:id/${name}'`);
    if (twin === -1) continue;          // nothing of that name to be shadowed by
    assert.ok(twin > match.index,
      `POST /:id/${name} is declared above POST /bulk/${name}, so the bulk path `
      + 'will match it with id = "bulk" and answer "Asset not found"');
  }
});
