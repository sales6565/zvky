/* A task is the studio's, or a freelancer's, and never both.
 *
 * WHY THIS IS ITS OWN FILE. The rule spans two features that know nothing about
 * each other — the asset pipeline and the Outsource tab — and it is enforced in
 * two directions across four routes. A rule guarded on one door is not a rule,
 * so what is asserted here is EVERY door: the panel's assign, the handover, the
 * bulk assign, and both of the outsource writes.
 *
 * THE ONE THAT IS NOT A DOOR is creating an asset with an assignee. The asset
 * does not exist when that request arrives, so nothing can be outsourced
 * against it yet and there is nothing to collide with. Asserted below anyway,
 * because "we thought about it and it cannot happen" and "we forgot" look
 * identical in a diff.
 *
 * AD HOC OUTSOURCED WORK IS OUTSIDE THE RULE, necessarily: an assignment need
 * not name a task at all, and one that names none conflicts with none.
 */
const test = require('node:test');
const assert = require('node:assert');

const outsource = require('../src/outsource');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('assignexcl');

test('cancelled is not a status anybody can type', () => {
  /* Taking work back has its own endpoint, its own permission check and its own
     audit entry. Letting it arrive as a plain status edit would be a second,
     quieter way to do the same thing. */
  assert.ok(!outsource.STATUSES.includes('cancelled'));
  assert.strictEqual(outsource.validateAssignment({
    freelancerId: 'f', projectId: 'p', decidedManHours: 1, status: 'cancelled',
  }).ok, false);
  assert.strictEqual(outsource.isActive('cancelled'), false);
  assert.strictEqual(outsource.isActive('assigned'), true);
  assert.strictEqual(outsource.STATUS_LABELS.cancelled, 'Cancelled');
});

test('the two sections, and the way back', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Exclusive-Probe-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  let projectId;

  const newAsset = async (name) => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'prop', manHours: 20 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };
  const sendOut = async (assetId, hours = 12) => {
    const r = await as('root', '/outsource/assignments', {
      method: 'POST',
      body: { freelancerId: id.asha, projectId, assetId, decidedManHours: hours } });
    return r;
  };
  const assignInternally = (assetId, userId) => as('root', `/assets/${assetId}`, {
    method: 'PATCH', body: { assigneeId: userId } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('artist', 'Ravi Artist', 'ravi@zvky.test', 'game_artist', id.lead);
    await make('other', 'Nita Artist', 'nita@zvky.test', 'game_artist', id.lead);

    const clients = await as('root', '/clients');
    const p = await as('root', '/projects', {
      method: 'POST', body: { name: 'Cherry Crush', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] } });
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
    projectId = p.body.project.id;

    const f = await as('root', '/outsource/freelancers', {
      method: 'POST', body: { name: 'Asha Rao', discipline: 'Rigging', ratePerHour: 900 } });
    assert.strictEqual(f.status, 201, JSON.stringify(f.body));
    id.asha = f.body.freelancer.id;
  });
  t.after(() => stopServer(server));

  await t.test('a task out with a freelancer cannot be assigned internally — by ANY route', async () => {
    const assetId = await newAsset('Out with Asha');
    assert.strictEqual((await sendOut(assetId)).status, 201);

    // 1. the panel / Edit form
    const patched = await assignInternally(assetId, id.artist);
    assert.strictEqual(patched.status, 409, JSON.stringify(patched.body));
    assert.match(patched.body.error, /Asha Rao/, 'and it says who holds it');
    assert.match(patched.body.error, /Unassign/, 'and how to get it back');

    /* 2. the handover — and it has to refuse for the RIGHT reason. This route
       has refusals of its own (a task in the wrong stage cannot be handed on at
       all), so a bare status check passes whether or not the exclusivity guard
       is there. The sentence is what tells the two apart. */
    const handed = await as('root', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.artist } });
    assert.strictEqual(handed.status, 409, JSON.stringify(handed.body));
    assert.match(handed.body.error, /Asha Rao/,
      `the handover must be refused because it is outsourced, not for some other reason: `
      + JSON.stringify(handed.body));

    // 3. the bulk action — refused per row, by name, without failing the batch
    const other = await newAsset('Free to assign');
    const bulk = await as('root', '/assets/bulk/assign', {
      method: 'POST', body: { assetIds: [assetId, other], assigneeId: id.artist } });
    assert.strictEqual(bulk.status, 200, JSON.stringify(bulk.body));
    const byId = new Map((bulk.body.results || []).map((r) => [r.id || r.assetId, r]));
    const refused = [...byId.values()].filter((r) => !r.ok);
    assert.strictEqual(refused.length, 1, `exactly one row refused: ${JSON.stringify(bulk.body.results)}`);
    assert.match(refused[0].error, /Asha Rao/);
    const [row] = await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${other}'`);
    assert.strictEqual(String(row.assignee_id), String(id.artist), 'and the other one went through');

    // And nothing moved on the outsourced task.
    const [still] = await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${assetId}'`);
    assert.strictEqual(still.assignee_id, null, 'no route wrote an assignee');
  });

  await t.test('a task somebody in the studio holds cannot be sent out', async () => {
    const assetId = await newAsset('Ravi has this');
    assert.strictEqual((await assignInternally(assetId, id.artist)).status, 200);

    const sent = await sendOut(assetId);
    assert.strictEqual(sent.status, 409, JSON.stringify(sent.body));
    assert.match(sent.body.error, /Ravi Artist/, 'naming who holds it');
    const rows = await sql(cfg, `SELECT id FROM outsource_assignments WHERE asset_id = '${assetId}'`);
    assert.strictEqual(rows.length, 0, 'and nothing was written');
  });

  await t.test('an EDIT cannot move an assignment onto a task somebody holds', async () => {
    /* The quieter door: an assignment already exists, and changing its asset is
       a second way of putting a freelancer on a task. */
    const held = await newAsset('Nita has this');
    assert.strictEqual((await assignInternally(held, id.other)).status, 200);
    const adhoc = await as('root', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.asha, projectId, decidedManHours: 6 } });
    assert.strictEqual(adhoc.status, 201, JSON.stringify(adhoc.body));

    const moved = await as('root', `/outsource/assignments/${adhoc.body.assignment.id}`, {
      method: 'PUT', body: { assetId: held } });
    assert.strictEqual(moved.status, 409, JSON.stringify(moved.body));
    assert.match(moved.body.error, /Nita Artist/);

    // Re-saving an assignment on the asset it is already on is not a collision.
    const onIts = await newAsset('Asha keeps this');
    const mine = await sendOut(onIts, 9);
    assert.strictEqual(mine.status, 201);
    const resaved = await as('root', `/outsource/assignments/${mine.body.assignment.id}`, {
      method: 'PUT', body: { decidedManHours: 11 } });
    assert.strictEqual(resaved.status, 200, `re-saving must not refuse itself: ${JSON.stringify(resaved.body)}`);
  });

  await t.test('ad hoc outsourced work is outside the rule', async () => {
    /* An assignment naming no task conflicts with no task — and a task nobody
       outsourced is assignable however much ad hoc work the project carries. */
    const free = await newAsset('Nothing to do with the ad hoc work');
    const adhoc = await as('root', '/outsource/assignments', {
      method: 'POST', body: { freelancerId: id.asha, projectId, decidedManHours: 20,
        description: 'Concept sketches' } });
    assert.strictEqual(adhoc.status, 201, JSON.stringify(adhoc.body));
    assert.strictEqual((await assignInternally(free, id.artist)).status, 200,
      'ad hoc work must not lock the project\'s tasks');
  });

  await t.test('unassigning a freelancer gives the task back, and keeps the figure', async () => {
    const assetId = await newAsset('Switching type');
    const sent = await sendOut(assetId, 25);
    assert.strictEqual(sent.status, 201);
    const assignmentId = sent.body.assignment.id;

    // Blocked, as above.
    assert.strictEqual((await assignInternally(assetId, id.artist)).status, 409);

    const cancelled = await as('root', `/outsource/assignments/${assignmentId}/cancel`, { method: 'POST' });
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.strictEqual(cancelled.body.assignment.cancelled, true);
    assert.strictEqual(cancelled.body.assignment.decidedManHours, 25,
      'the agreed figure is kept — it may already have been quoted');

    // KEPT, not deleted.
    const rows = await sql(cfg,
      `SELECT status, cancelled_by, cancelled_at FROM outsource_assignments WHERE id = '${assignmentId}'`);
    assert.strictEqual(rows.length, 1, 'the record survives');
    assert.strictEqual(rows[0].status, 'cancelled');
    assert.ok(rows[0].cancelled_by, 'with who took it back');
    assert.ok(rows[0].cancelled_at, 'and when');

    // And the task is the studio's again.
    assert.strictEqual((await assignInternally(assetId, id.artist)).status, 200,
      'both sections are open again');

    // Cancelling twice says so rather than pretending.
    assert.strictEqual((await as('root', `/outsource/assignments/${assignmentId}/cancel`,
      { method: 'POST' })).status, 409);
  });

  await t.test('clearing the internal assignee opens the freelancer side again', async () => {
    const assetId = await newAsset('The other direction');
    assert.strictEqual((await assignInternally(assetId, id.artist)).status, 200);
    assert.strictEqual((await sendOut(assetId)).status, 409);

    assert.strictEqual((await assignInternally(assetId, null)).status, 200, 'Unassign');
    assert.strictEqual((await sendOut(assetId)).status, 201, 'and now it may go out');
  });

  await t.test('cancelled work stops costing the project', async () => {
    /* The arithmetic half of "kept for its history, not for its sums". A
       cancelled assignment left in the cost would charge the project for work
       it did not buy. */
    const assetId = await newAsset('Cost check');
    const sent = await sendOut(assetId, 100);
    assert.strictEqual(sent.status, 201);

    const before = (await as('root', `/pnl/projects/${projectId}`)).body.totals;
    assert.ok(before.outsourcedHours >= 100, `the hours are in the P&L: ${before.outsourcedHours}`);

    assert.strictEqual((await as('root', `/outsource/assignments/${sent.body.assignment.id}/cancel`,
      { method: 'POST' })).status, 200);

    const after = (await as('root', `/pnl/projects/${projectId}`)).body.totals;
    assert.strictEqual(after.outsourcedHours, before.outsourcedHours - 100,
      'and they come back out of it');
    assert.strictEqual(after.outsourcedCost, before.outsourcedCost - 100 * 900);
  });

  await t.test('taking work back needs the permission that gave it out', async () => {
    const assetId = await newAsset('Who may unassign');
    const sent = await sendOut(assetId, 8);
    assert.strictEqual(sent.status, 201);
    const cancelPath = `/outsource/assignments/${sent.body.assignment.id}/cancel`;

    // A contributor holds neither key, so the router refuses at the door.
    assert.strictEqual((await as('artist', cancelPath, { method: 'POST' })).status, 403);

    /* THE ONE THAT MATTERS: somebody who may SEE the tab but not manage it. The
       two permissions share a default, so this has to be made rather than
       found — and without it the check inside the handler is never reached and
       could be deleted with nothing failing. */
    const held = await as('root', '/permissions/roles/team_lead');
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    /* body.role.permissions, and the flag is `enabled`. Reading the wrong shape
       here yields an empty list, and granting [...that, oneKey] would silently
       STRIP the designation of everything else — a test that passes while doing
       something quite different from what it says. */
    const perms = held.body.role.permissions;
    assert.ok(Array.isArray(perms) && perms.length, 'the role reads back its checklist');
    const keys = perms.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(keys.includes('outsource.manage'), 'a lead manages outsourcing by default');
    assert.ok(keys.length > 5, 'and a good deal else, which must survive this test');
    const viewOnly = keys.filter((k) => k !== 'outsource.manage');
    assert.strictEqual((await as('root', '/permissions/roles/team_lead', {
      method: 'PUT', body: { permissions: viewOnly } })).status, 200);
    tok.lead = await login('lead@zvky.test');

    assert.strictEqual((await as('lead', '/outsource/assignments')).status, 200,
      'they can still see the tab');
    const tried = await as('lead', cancelPath, { method: 'POST' });
    assert.strictEqual(tried.status, 403, `viewing is not taking back: ${JSON.stringify(tried.body)}`);

    const [row] = await sql(cfg,
      `SELECT status FROM outsource_assignments WHERE id = '${sent.body.assignment.id}'`);
    assert.strictEqual(row.status, 'assigned', 'and nothing changed');

    // Put the designation back, so later subtests see the studio as it was.
    assert.strictEqual((await as('root', '/permissions/roles/team_lead', {
      method: 'PUT', body: { permissions: keys } })).status, 200);
  });

  await t.test('the unassign is in the audit trail, with the figure', async () => {
    const log = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'outsource.unassigned');
    assert.ok(log.length, 'taking work back is its own kind of entry');
    assert.match(log[0].summary, /Took \d+h back from Asha Rao/,
      'with what was agreed before it was taken back');
    assert.strictEqual(log[0].actor.email, 'root@zvky.test');
  });

  await t.test('the panel is told which section is committed', async () => {
    const assetId = await newAsset('Panel state');
    const board = async () => (await as('root', `/assets/project/${projectId}`))
      .body.assets.find((x) => x.id === assetId);

    assert.strictEqual((await board()).outsourced_to, null, 'neither side, to begin with');
    assert.strictEqual((await sendOut(assetId, 14)).status, 201);
    const held = (await board()).outsourced_to;
    assert.ok(held, 'the board says the task is out');
    assert.strictEqual(held.freelancerName, 'Asha Rao');
    assert.strictEqual(held.decidedManHours, 14, 'with the agreed figure, so the panel can show it');

    assert.strictEqual((await as('root', `/outsource/assignments/${held.id}/cancel`,
      { method: 'POST' })).status, 200);
    assert.strictEqual((await board()).outsourced_to, null,
      'and a cancelled one does not hold the panel shut');
  });
});
