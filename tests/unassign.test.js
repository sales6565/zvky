/* Taking work back off somebody.
 *
 * THE REPORT. "On an already-assigned asset, selecting Unassigned from the
 * assignee dropdown doesn't actually move it to the unassigned state — nothing
 * happens." It was not nothing: the assignee WAS cleared. What did not happen
 * was the stage. The asset stayed in Assigned, so on a board that groups by
 * status the card never left the column it was in, and the one visible
 * consequence of the click was a name disappearing from a panel that was about
 * to be redrawn anyway.
 *
 * WHERE IT CAME FROM, since the question was asked directly: NOT from the
 * assignee-validation change that added recipient role checks to PATCH
 * /assets/:id and POST /assets/bulk/assign. That guard reads
 * `if (wantsAssign && req.body.assigneeId)` and so has never applied to a
 * clear. The line responsible —
 *
 *     const moveFor = assigneeChanged && req.body.assigneeId ? ... : null
 *
 * — predates it by three weeks and by an unrelated commit. The asymmetry is
 * the bug: assignment ran a transition, withdrawal ran none, so one dropdown's
 * two directions did not undo each other.
 *
 * TWO DEFECTS, and the second is the one nobody had hit yet: '' from a blank
 * <select> option reached the UPDATE verbatim and MySQL refused it against the
 * assignee foreign key — a 500 on clearing an assignee. The drawer happened to
 * send `|| null`; nothing obliged any other caller to.
 *
 * WHAT MUST NOT COME BACK WITH THE FIX:
 *
 *   A submitted round must keep its place. Unassigning from a review queue
 *      must NOT drop the asset to Not Assigned — that would discard the
 *      reviewer's queue position over a change of hands.
 *
 *   A handover is not an unassignment. Moving work from one person to another
 *      leaves the stage where it was, and still must.
 *
 *   The role check stays shut. Assigning to a designation that is not assigned
 *      work is still refused, on every route — the hole the earlier change
 *      closed is not reopened by exempting null from it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');
const workflow = require('../src/asset-workflow');

const cfg = config('unassign');

/* The set the fix returns an asset to Not Assigned FROM. Asserted against the
   workflow's own list rather than restated, because the route reads that list:
   if a status is added to it there, this test is what says the unassign path
   was considered too. */
test('the stages an unassignment can return work from are the free ones', () => {
  assert.deepStrictEqual(workflow.FREE_STATUSES, ['not_started', 'assigned', 'in_progress'],
    'src/routes/assets.js returns an unassigned asset to Not Assigned from exactly these');
});

test('unassigning', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Unassign-Test-1!';
  let server;
  let admin;
  let artistTok;
  const ids = {};
  let projectId;

  const call = (p, options) => api(server.base, p, options);
  const login = async (email) =>
    (await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    admin = await login('root@zvky.test');

    const make = async (name, email, role) => {
      const r = await call('/users', { token: admin, method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      return r.body.user.id;
    };
    ids.lead = await make('Lena Lead', 'lead@zvky.test', 'team_lead');
    ids.artist = await make('Ana Artist', 'artist@zvky.test', 'game_artist');
    ids.other = await make('Otto Other', 'other@zvky.test', 'game_artist');
    ids.producer = await make('Percy Producer', 'producer@zvky.test', 'producer');
    artistTok = await login('artist@zvky.test');

    const clients = await call('/clients', { token: admin });
    const project = await call('/projects', {
      token: admin, method: 'POST',
      body: { name: 'Unassigning', clientId: clients.body.clients[0].id, teamLeadIds: [ids.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  const newAsset = async (name) => {
    const r = await call(`/assets/project/${projectId}`, {
      token: admin, method: 'POST', body: { name, type: 'prop' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset;
  };
  /* Read back through the per-project list. There is no GET /api/assets/:id —
     that path falls through to the SPA catch-all and answers index.html with a
     200, which would make any assertion against it pass. */
  const fetchAsset = async (id) => {
    const r = await call(`/assets/project/${projectId}`, { token: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.assets.find((a) => a.id === id);
  };
  const assign = async (id, who) => {
    const r = await call(`/assets/${id}`, { token: admin, method: 'PATCH', body: { assigneeId: who } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.asset;
  };

  await t.test('THE BUG: an assigned asset returns to Not Assigned', async () => {
    const asset = await newAsset('Give It Back');
    await assign(asset.id, ids.artist);
    assert.strictEqual((await fetchAsset(asset.id)).status, 'assigned', 'setup');

    const r = await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: null } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const after = await fetchAsset(asset.id);
    assert.strictEqual(after.assignee_id, null, 'the assignee is cleared');
    assert.strictEqual(after.status, 'not_started',
      'the card stayed in the Assigned column with nobody on it — the whole of the report');
    assert.strictEqual(after.routed_to_id, null, 'and it is on nobody\'s desk');

    /* The PATCH response is what the panel redraws from, so it has to carry the
       new stage as well as the database. They were the same object before this
       change too, but a fix that wrote the status in a second query AFTER
       building the reply would pass everything above and still leave the screen
       looking unchanged, which is the symptom being fixed. */
    assert.strictEqual(r.body.asset.status, 'not_started', 'the response says so too');
    assert.strictEqual(r.body.asset.assignee_name, null);
  });

  await t.test('work that was under way goes back too, and the clock stops', async () => {
    const asset = await newAsset('Started Then Taken');
    await assign(asset.id, ids.artist);
    const started = await call(`/assets/${asset.id}/start`, { token: artistTok, method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    assert.strictEqual((await fetchAsset(asset.id)).status, 'in_progress', 'setup');

    await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: null } });
    assert.strictEqual((await fetchAsset(asset.id)).status, 'not_started');

    /* The open session is what "one active task at a time" reads. Left open on
       an asset nobody holds, the artist is blocked on everything else with
       nothing on screen to explain it. */
    const active = await call('/assets/mine/active', { token: artistTok });
    assert.ok(!active.body.active || active.body.active.assetId !== asset.id,
      'the artist is still blocked by a session on work they no longer hold');
  });

  await t.test('a submitted round keeps its place in the queue', async () => {
    const asset = await newAsset('Already Handed In');
    await assign(asset.id, ids.artist);
    await call(`/assets/${asset.id}/start`, { token: artistTok, method: 'POST' });
    const submitted = await call(`/assets/${asset.id}/submit`, {
      token: artistTok, method: 'POST', body: { link: 'https://example.com/v1', description: 'round one' },
    });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    assert.strictEqual((await fetchAsset(asset.id)).status, 'pending_tl_review', 'setup');

    await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: null } });
    const after = await fetchAsset(asset.id);
    assert.strictEqual(after.assignee_id, null, 'the name still comes off');
    assert.strictEqual(after.status, 'pending_tl_review',
      'a submitted round was thrown out of the review queue by a change of assignee');
  });

  await t.test('a handover is not an unassignment', async () => {
    const asset = await newAsset('Passed Along');
    await assign(asset.id, ids.artist);
    const moved = await assign(asset.id, ids.other);
    assert.strictEqual(moved.assignee_id, ids.other);
    assert.strictEqual((await fetchAsset(asset.id)).status, 'assigned',
      'giving work to somebody else must not drop it to Not Assigned');
  });

  await t.test('a status sent in the same request wins', async () => {
    /* { assigneeId: null, status: 'in_progress' } is somebody saying both
       things at once. Theirs is the explicit instruction; the automatic move
       must not overwrite it a line later. */
    const asset = await newAsset('Both At Once');
    await assign(asset.id, ids.artist);
    const r = await call(`/assets/${asset.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: null, status: 'in_progress' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const after = await fetchAsset(asset.id);
    assert.strictEqual(after.assignee_id, null);
    assert.strictEqual(after.status, 'in_progress', 'the status the request asked for was overwritten');
  });

  await t.test('the history says it was an unassignment, not a reassignment to "nobody"', async () => {
    const asset = await newAsset('Read The Trail');
    await assign(asset.id, ids.artist);
    await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: null } });

    const h = await call(`/assets/${asset.id}/history`, { token: admin });
    assert.strictEqual(h.status, 200, JSON.stringify(h.body));
    const ev = h.body.events[h.body.events.length - 1];
    assert.strictEqual(ev.action, 'unassign');
    assert.strictEqual(ev.fromStatus, 'assigned');
    assert.strictEqual(ev.toStatus, 'not_started', 'the trail has to record the move that was made');
    assert.match(ev.note, /Ana Artist/, 'and who it was taken off');
  });

  /* --- the blank option ---------------------------------------------------- */

  await t.test('an empty string means nobody, not a foreign key violation', async () => {
    const asset = await newAsset('Blank Option');
    await assign(asset.id, ids.artist);
    const r = await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: '' } });
    assert.strictEqual(r.status, 200,
      `'' reached the database and was refused against the assignee foreign key: ${JSON.stringify(r.body)}`);
    const after = await fetchAsset(asset.id);
    assert.strictEqual(after.assignee_id, null);
    assert.strictEqual(after.status, 'not_started', 'and it is the same operation as null, all the way down');
  });

  await t.test('a blank in bulk is read the same way', async () => {
    const asset = await newAsset('Blank In Bulk');
    const r = await call('/assets/bulk/assign', {
      token: admin, method: 'POST', body: { assetIds: [asset.id], assigneeId: '' },
    });
    assert.strictEqual(r.status, 200,
      `a blank was reported as a missing person: ${JSON.stringify(r.body)}`);
  });

  /* --- and the hole that was closed stays closed --------------------------- */

  await t.test('exempting null did not exempt everybody', async () => {
    /* The guard is `if (wantsAssign && req.body.assigneeId)`. Written as
       `!== undefined` it would catch null and refuse every unassignment;
       dropped altogether it would reopen the hole the earlier change closed.
       Both routes, because both carry their own copy of it. */
    const asset = await newAsset('Not For A Producer');
    const one = await call(`/assets/${asset.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: ids.producer },
    });
    assert.strictEqual(one.status, 400, 'PATCH handed work to a Producer');
    assert.match(one.body.error, /not assigned work/);

    const bulk = await call('/assets/bulk/assign', {
      token: admin, method: 'POST', body: { assetIds: [asset.id], assigneeId: ids.producer },
    });
    assert.strictEqual(bulk.status, 400, 'bulk/assign handed work to a Producer');
  });

  await t.test('and assigning still works', async () => {
    const asset = await newAsset('Ordinary Assignment');
    const r = await assign(asset.id, ids.artist);
    assert.strictEqual(r.assignee_id, ids.artist);
    assert.strictEqual((await fetchAsset(asset.id)).status, 'assigned');
  });
});
