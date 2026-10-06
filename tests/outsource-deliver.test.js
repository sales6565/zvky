/* MARKING A FREELANCER'S WORK DELIVERED, in bulk, from the Outsource tab.
 *
 * THE FINDING THIS SUITE IS BUILT AROUND, because it decided the whole design:
 * there are TWO "delivered" in this application and they are nearly opposites.
 *
 *   review.deliver / the 'deliver' transition: approved_for_client -> delivered.
 *   The CLIENT has the work. The end of the pipeline. It already existed, with
 *   a bulk action, a permission, a modal and tests/bulk-deliver.test.js.
 *
 *   outsource.deliver / the 'outsource_delivered' transition: not_started ->
 *   pending_tl_review. A FREELANCER has handed work back and the studio has not
 *   looked at it yet.
 *
 * Reusing the first for the second would have told every board, the Assets
 * List's Active group and both "open work" queries that the client had been
 * sent something nobody inside the studio had reviewed. The transition table
 * already refused it — `from: ['approved_for_client']` — and the first test
 * below pins that refusal as the premise rather than leaving it as a thing
 * somebody once checked.
 *
 * AND WHY THE DESTINATION IS AN EXISTING STATUS. pending_tl_review is already
 * known to every list that counts or groups statuses: the board's columns, the
 * Assets List's Active group, the Admin Dashboard's in-review tile, the pending
 * queues, the status CHECK constraint, and the `NOT IN ('delivered',
 * 'approved_for_client')` exclusions in src/routes/idle.js and
 * src/routes/projects.js. A NEW status would have been a new entry in each of
 * those, and the one that got forgotten is where this feature would have
 * half-migrated. The cases below walk those surfaces to show it did not.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const outsource = require('../src/outsource');
const workflow = require('../src/asset-workflow');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('osdeliver');
const PASSWORD = 'OsDeliver-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// The premises, read off the source.
// ---------------------------------------------------------------------------

test('the two deliveries are two transitions, and neither reaches the other\'s states', () => {
  const client = workflow.transitionFor('deliver');
  const back = workflow.transitionFor('outsource_delivered');
  assert.ok(client && back, 'both transitions exist');

  assert.deepStrictEqual(client.from, ['approved_for_client']);
  assert.strictEqual(client.to, 'delivered');
  /* WIDENED, AND THE INVARIANT THIS TEST GUARDS IS NOT ABOUT ITS LENGTH. It was
     ['not_started'] on the belief that outsourced work always sits there; a
     studio proved otherwise by dragging an outsourced card to In Progress, after
     which both stages refused the row for ever. The list is the workflow's own
     allow-list now, read rather than copied, and what still has to be true is
     the DISJOINTNESS asserted below. */
  assert.deepStrictEqual(back.from, workflow.OUTSOURCE_STAGE_FROM);
  assert.ok(back.from.includes('not_started'), 'where outsourced work belongs is still on it');
  assert.ok(!back.from.includes('delivered') && !back.from.includes('approved_for_client'),
    'and nothing closed or approved is');
  assert.strictEqual(back.to, 'pending_tl_review');

  /* NO OVERLAP IN EITHER DIRECTION. This is the assertion that would fail if
     somebody later "simplified" the two into one by widening a `from` — which
     is the change that would ship unreviewed work to a client. */
  assert.deepStrictEqual(client.from.filter((st) => back.from.includes(st)), [],
    'the two are legal from disjoint states');
  assert.notStrictEqual(client.to, back.to, 'and they land in different places');
  assert.notStrictEqual(client.who, back.who, 'behind different actor gates');

  // Each has its own refusal sentence. A missing entry falls through to a
  // fallback that reads the action id as English, which works for none of them.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  /* NOT "by the freelancer" ANY MORE — that wording told a member of staff who
     had just clicked Mark delivered that the freelancer could not do it, and
     freelancers have no logins. The sentence now names the statuses the action
     needs, GENERATED from the allow-list so it cannot promise a status the table
     refuses. */
  assert.match(src, /outsource_delivered: `recorded as delivered — the task has to be in \$\{allowedStatuses\(\)\}`/,
    'the refusal says what the action needs, from the list that enforces it');
  assert.ok(!/cannot be marked delivered by the freelancer/.test(src));
});

test('the destination is a status every list already knows', () => {
  /* The half-migration guard, and it is a grep rather than a sentiment. Every
     place in the codebase that enumerates statuses is asked whether it knows
     the one this transition lands in. A NEW status would have failed most of
     these and the feature would have been invisible on whichever surface got
     missed. */
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const PLACES = [
    ['src/migrate.js', 'the status CHECK constraint'],
    ['src/admin-dashboard.js', 'the Admin Dashboard\'s in-review count'],
    ['src/routes/assets.js', 'the pending queues'],
    ['src/permissions.js', 'the handover gate'],
    ['public/index.html', 'the board columns and the Assets List groups'],
  ];
  for (const [file, what] of PLACES) {
    assert.match(read(file), /pending_tl_review/, `${what} (${file}) knows the destination`);
  }

  /* And the two "open work" exclusions, which must NOT list it: a task a
     freelancer has just handed back is work in flight, and excluding it would
     drop it out of the project's own open-work count. */
  for (const file of ['src/routes/idle.js', 'src/routes/projects.js']) {
    const text = read(file);
    const m = text.match(/NOT IN \('delivered', 'approved_for_client'\)/);
    assert.ok(m, `${file} still excludes only the two finished states`);
    assert.ok(!/NOT IN \([^)]*pending_tl_review/.test(text),
      `${file} does not exclude work that has just come back`);
  }

  // The page's own status list and its Active group.
  assert.match(PAGE, /\{id:'pending_tl_review', label:'TL Review'/, 'the page has the status');
  const activeAt = PAGE.indexOf("{ id:'active',   label:'Active'");
  assert.ok(activeAt !== -1);
  assert.match(PAGE.slice(activeAt, activeAt + 400), /pending_tl_review/,
    'and counts it as active work');
});

test('the page and the server mirror one deliverability rule', () => {
  /* Three things have to agree about which rows can be delivered: the module,
     the page's tick boxes, and the transition's own `from`. The first two are
     compared by evaluating BOTH over the same inputs rather than by reading
     them, so a difference in either shows up as a wrong answer here. */
  const at = PAGE.indexOf('function osDeliverable(a)');
  assert.ok(at !== -1, 'the page still has the predicate this test reads');
  /* Sliced to the closing brace rather than to the end of the line: the
     predicate grew a second clause (the task's status, against the allow-list
     the server publishes) and a one-line slice then cut it in half and threw. */
  const body = PAGE.slice(at, PAGE.indexOf('\n}', at) + 2);
  /* osStageReachable is stubbed TRUE here on purpose. This test is about the
     ASSIGNMENT half of the rule — which assignment statuses can be delivered —
     and the task half is held to the server's list in
     tests/outsource-stage.test.js, where the renderer is run for real. */
  // eslint-disable-next-line no-new-func
  const onPage = new Function(`const osStageReachable = () => true; ${body} return osDeliverable;`)();

  for (const status of [...outsource.STATUSES, outsource.CANCELLED]) {
    assert.strictEqual(onPage({ status }), outsource.isDeliverable({ status }),
      `the page and src/outsource.js disagree about "${status}"`);
  }
  assert.strictEqual(onPage(null), false, 'and neither offers a box on nothing');
  assert.strictEqual(outsource.isDeliverable(null), false);

  /* Which rows those actually are, spelled out so a change of mind is visible.
     'completed' IS AMONG THEM, and it is the one entry here that is a decision
     rather than an obvious consequence: the stages are Assigned -> Completed ->
     Delivered, and a row the studio has already marked completed is precisely a
     row waiting to be delivered. Going straight from Assigned to Delivered in
     one action is allowed too, which is why 'assigned' is still here beside it. */
  assert.deepStrictEqual(
    [...outsource.STATUSES, outsource.CANCELLED].filter((st) => outsource.isDeliverable({ status: st })),
    ['assigned', 'in_progress', 'completed', 'revision_requested'],
    'anything a freelancer still holds or has finished; nothing already delivered or taken back'
  );
});

test('the page gates the boxes and the button on the permission, never the tier', () => {
  /* The bug this page carries a note about, appearing a fifth time would look
     exactly like this: a screen asking caps() about something the API decides
     from permissions. Both halves are pinned — the key, and the absence of the
     tier anywhere near it. */
  assert.match(PAGE, /function osMayDeliver\(\)\{ return can\('outsource\.deliver'\); \}/,
    'the page asks the permission');
  /* RENAMED, not loosened. One key, outsource.deliver, now opens BOTH forward
     stages — Mark completed and Mark delivered — so the variable says what it
     gates. osMayRecordStage() reads that same key; the pair is pinned below so
     the two cannot drift into asking different things. */
  assert.match(PAGE, /function osMayRecordStage\(\)\{ return can\('outsource\.deliver'\); \}/,
    'recording either forward stage is the same key');
  assert.match(PAGE, /const mayRecord = Boolean\(d\.canDeliver\) && osMayRecordStage\(\);/,
    'and the server\'s own answer alongside it');
  /* Undoing one is a DIFFERENT key, read separately. A page that reused
     mayRecord here would offer Reopen to everybody who may record. */
  assert.match(PAGE, /function osMayReopen\(\)\{ return can\('outsource\.reopen'\); \}/,
    'the reversal has its own key');
  assert.match(PAGE, /const mayReopen = Boolean\(d\.canReopen\) && osMayReopen\(\);/,
    'and its own flag from the server');

  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const from = code.indexOf('function osRenderAssignments');
  const to = code.indexOf('function osCostOf');
  assert.ok(from !== -1 && to > from, 'the Assigned work renderer is still where this reads it');
  const area = code.slice(from, to);
  assert.ok(!/caps\(/.test(area), 'the tier is not consulted in the Assigned work list');
  assert.ok(/data-ospick/.test(area) && /osPickAll/.test(area) && /osDeliverGo/.test(area),
    'the boxes, the select-all and the button are all drawn here');
  /* All three inside the SAME gate. A box drawn outside it would be tickable by
     somebody the button is withheld from. */
  assert.ok(/mayRecord \? `<td class="pick-col">/.test(area), 'the row box is behind the gate');
  assert.ok(/const headBox = mayRecord/.test(area), 'the select-all is behind the gate');
  assert.ok(/const bar = \(mayRecord && chosen\.length\)/.test(area), 'and so is the button');

  /* THE SELECTION OUTLIVES A REDRAW, which it can only do by living outside the
     cache that a refresh drops. */
  assert.match(PAGE, /^let selectedAssignments = new Set\(\);$/m,
    'the selection is module-level, not inside osState.data');
  assert.match(code, /for\(const id of \[\.\.\.selectedAssignments\]\) if\(!selectableIds\.has\(id\)\) selectedAssignments\.delete\(id\);/,
    'and is pruned on every render to rows still on screen and still deliverable');
});

test('the server gates it with requirePermission, and the reach per row', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  /* THE GATE MOVED, not the rule. The three stages share one endpoint, so the
     key depends on which stage was asked for and a middleware cannot read the
     body — it is asked in the handler instead, from a table, and the older
     /bulk/outsource-deliver path forces the one stage it ever recorded and hands
     straight over rather than keeping a second copy of any of this. */
  const stageKeys = route.slice(route.indexOf('const STAGE_PERMISSION = {'));
  assert.match(stageKeys.slice(0, stageKeys.indexOf('};') + 2),
    /completed: 'outsource\.deliver', delivered: 'outsource\.deliver', reopened: 'outsource\.reopen'/,
    'each stage names its key in one place');
  assert.match(route, /if \(!can\(req, STAGE_PERMISSION\[stage\]\)\) \{\n\s*return res\.status\(403\)/,
    'and the handler refuses 403 once for somebody without it');
  assert.match(route, /router\.post\('\/bulk\/outsource-deliver', \(req, res, next\) => \{[\s\S]{0,200}?stage: 'delivered'/,
    'the older path still answers, by delegating rather than repeating');
  assert.match(route, /await canDeliverOutsourced\(req\.user, \{ project_id: assignment\.projectId \}\)/,
    'and the project reach is asked again per row, which a middleware cannot do');

  /* Reach is the role's, by the same shape review.deliver uses. Compared as
     source rather than described, because the pairing is the thing: a key
     without the scope check would deliver across the whole studio. */
  const perms = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  const fn = perms.slice(perms.indexOf('async function canDeliverOutsourced'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /holds\(user, 'outsource\.deliver'\)/);
  assert.match(body, /projectScope === 'all'/);
  assert.match(body, /canAccessProject\(user, asset\.project_id\)/);

  // And the generic edit route no longer writes the status directly.
  const os = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outsource.js'), 'utf8');
  assert.match(os, /const wantsDelivered = body\.status === outsource\.DELIVERED/);
  assert.match(os, /&& existing\.status !== outsource\.DELIVERED;/,
    'only a move INTO delivered is refused, so a delivered row stays editable');
});

test('the catalogue entry, and the default it is chosen to give', () => {
  const entry = catalog.BY_KEY.get('outsource.deliver');
  assert.ok(entry, 'the key is in the catalogue');
  // Every key sits in the group its prefix names.
  assert.strictEqual(entry.groupLabel, 'Outsourcing');
  assert.ok(catalog.grantableKeys().includes('outsource.deliver'), 'and can be handed out');
  assert.ok(!entry.pending, 'it is read by code in this same change');

  /* THE DEFAULT, PINNED WITH THE REASON.
   *
   * EXACTLY THE SET outsource.manage ALREADY HAS, which is the brief's "off by
   * default except for the roles that already manage outsourcing" read
   * literally: that predicate IS that set. Anything narrower would have been a
   * regression dressed as caution — those designations can already mark an
   * assignment delivered through the edit form, so a key they did not hold
   * would mean the same studio act was possible one way and refused the other.
   *
   * A SEPARATE KEY all the same, because this one moves the TASK into a team
   * lead's review queue, which setting Assigned or In Progress does not. A
   * Super Admin can withhold it without withholding the rest of the tab. */
  const { ROLES } = require('../src/reference-defaults');
  const held = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);
  assert.deepStrictEqual(held('outsource.deliver'), held('outsource.manage'),
    'the same designations that manage outsourcing can deliver it, and no others');
  assert.ok(held('outsource.deliver').includes('super_admin'));
  assert.ok(!held('outsource.deliver').includes('game_artist'),
    'and a contributor does not pick it up');

  // NOT the same key as the client-facing delivery.
  assert.notStrictEqual(
    JSON.stringify(held('outsource.deliver')), JSON.stringify(held('review.deliver')),
    'the two deliveries are not the same grant'
  );
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('delivering a freelancer\'s work', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};

  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const deliver = (who, assignmentIds) =>
    as(who, '/assets/bulk/outsource-deliver', { method: 'POST', body: { assignmentIds } });

  const setPerms = async (roleKey, keys) => {
    const r = await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT', body: { permissions: keys } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const heldBy = async (roleKey) => {
    const r = await as('root', `/permissions/roles/${roleKey}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  };

  // A task nobody in the studio holds, given to a freelancer. Built through the
  // real routes rather than written, so what is delivered below is a row the
  // application really makes.
  const outsourced = async (name, projectId = id.project) => {
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'prop' } })).body.asset;
    assert.strictEqual(asset.status, 'not_started',
      'an unassigned task is Not Assigned, which is the only status outsourced work holds');
    const r = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: id.freelancer, projectId, assetId: asset.id, decidedManHours: 8 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return { asset, assignment: r.body.assignment };
  };
  const adHoc = async (description) => {
    const r = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: id.freelancer, projectId: id.project, decidedManHours: 3, description } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.assignment;
  };
  const statusOf = async (assetId, projectId = id.project) =>
    (await as('root', `/assets/project/${projectId}`)).body.assets.find((a) => a.id === assetId).status;
  const assignmentRow = async (assignmentId) =>
    (await as('root', '/outsource/assignments')).body.assignments.find((a) => a.id === assignmentId);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'osdeliver-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'osdeliver-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* The clock opened wide. This feature has no timer in it — see below — but
       the shipped 13:00-14:00 lunch blackout has broken three suites by putting
       a session down mid-case, and a suite that asserts "no sessions were
       touched" must not be the fourth. */
    await openStudio(server.base, tok.root);

    const clientId = (await as('root', '/clients')).body.clients[0].id;
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Outsourced', clientId } })).body.project.id;
    id.other = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Somebody Else\'s', clientId } })).body.project.id;

    for (const [who, email, role, projectId] of [
      ['lee', 'lee@zvky.test', 'team_lead', id.project],
      ['ana', 'ana@zvky.test', 'game_artist', id.project],
    ]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email, role, password: PASSWORD, projectId } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[who] = r.body.user.id;
      tok[who] = await login(email);
    }

    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Ravi Freelance', discipline: 'rigging', ratePerHour: 600 } });
    assert.strictEqual(fl.status, 201, JSON.stringify(fl.body));
    id.freelancer = fl.body.freelancer.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the client-facing delivery still refuses outsourced work, in its own words', async () => {
    /* THE PREMISE, PROVED AGAINST THE RUNNING SERVER rather than read off the
       table. If this ever starts succeeding, the two deliveries have been
       merged and unreviewed work can reach a client. */
    const { asset, assignment } = await outsourced('Premise');
    const r = await as('root', '/assets/bulk/deliver', { method: 'POST', body: { assetIds: [asset.id] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /only work the client has approved can be delivered/);
    assert.strictEqual(await statusOf(asset.id), 'not_started', 'and it did not move');
    // Left undelivered for nothing else to trip over.
    await as('root', `/outsource/assignments/${assignment.id}/cancel`, { method: 'POST' });
  });

  await t.test('a delivered assignment moves its task to TL Review, and records who and when', async () => {
    const { asset, assignment } = await outsourced('Rig Pass');
    const before = Date.now();

    const r = await deliver('root', [assignment.id]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.requested, 1);
    assert.strictEqual(r.body.delivered, 1);
    assert.strictEqual(r.body.failed, 0);
    assert.strictEqual(r.body.results[0].ok, true);
    assert.strictEqual(r.body.results[0].movedAsset, true);
    assert.strictEqual(r.body.results[0].status, 'pending_tl_review');

    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review',
      'the task is in the team lead\'s queue');

    const row = await assignmentRow(assignment.id);
    assert.strictEqual(row.status, 'delivered');
    assert.strictEqual(row.delivered, true);
    assert.strictEqual(row.deliveredByName, 'Root', 'who delivered it');
    assert.ok(row.deliveredAt, 'and when');
    assert.ok(Date.parse(row.deliveredAt) >= before - 60000, 'the stamp is now, not a default');

    /* THE TASK'S OWN HISTORY, through the table rather than a status write — the
       same asset_events row a single transition writes, carrying the action id
       so "how often does outsourced work come back" is answerable later. */
    const events = await sql(cfg,
      `SELECT action, from_status, to_status, actor_email, batch_id FROM asset_events
        WHERE asset_id = '${asset.id}' ORDER BY created_at DESC LIMIT 1`);
    assert.strictEqual(events[0].action, 'outsource_delivered');
    assert.strictEqual(events[0].from_status, 'not_started');
    assert.strictEqual(events[0].to_status, 'pending_tl_review');
    assert.strictEqual(events[0].actor_email, 'root@zvky.test');
    assert.strictEqual(events[0].batch_id, r.body.batchId, 'and says which act it was part of');

    // The batch row, with its own action id so the two deliveries stay countable apart.
    const batch = await sql(cfg,
      `SELECT action, requested, succeeded, actor_email FROM asset_event_batches WHERE id = '${r.body.batchId}'`);
    /* PER STAGE, not one word for all three: "how often is a delivery reopened"
       is a question the log can only answer if a reversal is not recorded as a
       delivery. The same id the asset_events row above carries. */
    assert.strictEqual(batch[0].action, 'outsource_delivered');
    assert.strictEqual(Number(batch[0].requested), 1);
    assert.strictEqual(Number(batch[0].succeeded), 1);

    /* AND NOW THE TEAM LEAD CAN ACT ON IT, with no assignee on the asset at all.
       This is the part that would have stranded the work: canActAtTlGate guards
       every read of assignee_id, so the project's lead stands at the gate. */
    const review = await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(review.status, 200, JSON.stringify(review.body));
    assert.strictEqual(await statusOf(asset.id), 'tl_approved',
      'the freelancer\'s work goes through the same review an artist\'s does');
  });

  await t.test('no timer is touched, because an outsourced task has none', async () => {
    /* VERIFIED, NOT ASSUMED, which is what the brief asked for. src/outsource.js
       opens with "there is no timer here, no work session"; the reason it holds
       is structural rather than a matter of discipline — outsourceBlocked()
       refuses to send out a task that has an internal assignee, and /start now
       refuses an outsourced task OUTRIGHT. So there is nothing for delivery to
       close.
       
       IT USED TO BE A 403 HERE, and that was luck rather than design: the
       refusal came from not being the assignee, and a task that had drifted to
       In Progress could be started by anybody with full access. /start asks
       about the assignment first now, so the refusal is a 409 that names the
       freelancer — see tests/outsource-stage.test.js, which holds it for all
       three roles. */
    const { asset, assignment } = await outsourced('No Clock');
    const start = await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual(start.status, 409,
      'nobody can start work on an outsourced task, whatever their role');
    assert.match(start.body.error, /is out with Ravi Freelance/, 'and the reason names who has it');

    await deliver('root', [assignment.id]);
    const sessions = await sql(cfg,
      `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(sessions[0].n), 0, 'and so no session exists to close');
  });

  await t.test('ad hoc work delivers its own status and moves no task', async () => {
    const assignment = await adHoc('Marketing stinger, no asset');
    const r = await deliver('root', [assignment.id]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.delivered, 1);
    assert.strictEqual(r.body.results[0].movedAsset, false,
      'said plainly rather than implying a transition that did not happen');
    assert.strictEqual(r.body.results[0].status, null);
    assert.strictEqual((await assignmentRow(assignment.id)).status, 'delivered');
  });

  await t.test('delivering twice, and delivering what was taken back, are refused by name', async () => {
    const { assignment } = await outsourced('Once Only');
    assert.strictEqual((await deliver('root', [assignment.id])).body.delivered, 1);

    const again = await deliver('root', [assignment.id]);
    assert.strictEqual(again.status, 200, 'the request is well-formed');
    assert.strictEqual(again.body.delivered, 0, 'and nothing happened');
    assert.strictEqual(again.body.results[0].ok, false);
    assert.match(again.body.results[0].error, /already delivered this/,
      'refused cleanly, not silently succeeded');

    const taken = await outsourced('Taken Back');
    await as('root', `/outsource/assignments/${taken.assignment.id}/cancel`, { method: 'POST' });
    const cancelled = await deliver('root', [taken.assignment.id]);
    assert.strictEqual(cancelled.body.results[0].ok, false);
    /* One sentence for all three stages now, because the reason is the same
       whichever was asked for: there is no stage to record on work nobody holds. */
    assert.match(cancelled.body.results[0].error, /was cancelled, so there is no stage to record/);
    assert.strictEqual(await statusOf(taken.asset.id), 'not_started', 'and the task did not move');
  });

  await t.test('a task somebody in the studio has taken on is refused by the table', async () => {
    /* The transition's `from` is the guard, not a check somebody remembered. The
       freelancer is unassigned, an artist picks the work up, and the stale
       assignment can no longer be delivered. */
    const { asset, assignment } = await outsourced('Taken Internally');
    await as('root', `/outsource/assignments/${assignment.id}/cancel`, { method: 'POST' });
    const patched = await as('root', `/assets/${asset.id}`, {
      method: 'PATCH', body: { assigneeId: id.ana } });
    assert.ok(patched.status < 400, JSON.stringify(patched.body));
    assert.strictEqual(await statusOf(asset.id), 'assigned');

    /* Re-opened by hand so there is a live assignment pointing at a task that
       has moved on — the state a stale browser tab would send. */
    await sql(cfg,
      `UPDATE outsource_assignments SET status = 'assigned', cancelled_by = NULL, cancelled_at = NULL
        WHERE id = '${assignment.id}'`);
    const r = await deliver('root', [assignment.id]);
    assert.strictEqual(r.body.results[0].ok, false);
    /* THE REFUSAL MOVED FROM THE STATUS TO THE ASSIGNEE, and this test is why.
       'assigned' is on the allow-list now — it has to be, because a drifted
       outsourced task can sit there — so a guard reading only the status would
       have let this through and handed back work an artist was doing. The real
       invariant is the exclusivity rule: a task with an internal assignee is not
       the freelancer's, whatever status it holds. */
    assert.match(r.body.results[0].error, /is assigned to somebody in the studio now/);
    assert.match(r.body.results[0].error, /Clear the internal assignee first/,
      'and says what to do about it');
    assert.ok(!/by the freelancer/.test(r.body.results[0].error),
      'and no longer blames somebody who has no login');
    assert.strictEqual(await statusOf(asset.id), 'assigned', 'the task is untouched');
    assert.strictEqual((await assignmentRow(assignment.id)).status, 'assigned',
      'and so is the assignment — a refused asset move leaves both halves alone');
  });

  await t.test('a mixed batch applies the good rows and reports each refusal', async () => {
    const good = await Promise.all([outsourced('Mix A'), outsourced('Mix B')]);
    const already = await outsourced('Mix Delivered');
    await deliver('root', [already.assignment.id]);
    const ids = [good[0].assignment.id, already.assignment.id, good[1].assignment.id,
      '00000000-0000-0000-0000-000000000000'];

    const r = await deliver('root', ids);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.requested, 4);
    assert.strictEqual(r.body.delivered, 2, 'the two that could be, were');
    assert.strictEqual(r.body.failed, 2);

    const byId = new Map(r.body.results.map((x) => [x.id, x]));
    assert.strictEqual(byId.get(good[0].assignment.id).ok, true);
    assert.strictEqual(byId.get(good[1].assignment.id).ok, true);
    assert.match(byId.get(already.assignment.id).error, /already delivered/);
    assert.match(byId.get('00000000-0000-0000-0000-000000000000').error, /no longer exists/);

    /* NEVER ROLLED BACK SILENTLY: the two good ones really did land, which is
       the whole point of a per-row reply rather than a status code. */
    for (const g of good) {
      assert.strictEqual(await statusOf(g.asset.id), 'pending_tl_review');
      assert.strictEqual((await assignmentRow(g.assignment.id)).status, 'delivered');
    }
    // One batch row covering the act, holding what actually happened.
    const batch = await sql(cfg,
      `SELECT requested, succeeded FROM asset_event_batches WHERE id = '${r.body.batchId}'`);
    assert.strictEqual(Number(batch[0].requested), 4);
    assert.strictEqual(Number(batch[0].succeeded), 2);
  });

  await t.test('the request itself is checked', async () => {
    assert.strictEqual((await deliver('root', [])).status, 400);
    assert.strictEqual((await deliver('root', 'nope')).status, 400);
    const many = await deliver('root', Array.from({ length: 201 }, (_, i) => `id-${i}`));
    assert.strictEqual(many.status, 400);
    assert.match(many.body.error, /200 at a time/);
    // De-duplicated: a list sent twice delivers once and reports once.
    const { assignment } = await outsourced('Twice In One List');
    const dup = await deliver('root', [assignment.id, assignment.id]);
    assert.strictEqual(dup.body.requested, 1, 'one row, not two');
    assert.strictEqual(dup.body.delivered, 1);
  });

  await t.test('a project the deliverer cannot reach is refused, per row', async () => {
    /* REACH IS THE ROLE'S. A team lead granted the key delivers the outsourced
       work on their own projects and no further — and the refusal is per row,
       so a batch spanning both projects delivers the half it may. */
    const mine = await outsourced('Lead\'s Own');
    const theirs = await outsourced('Off Project', id.other);

    const held = await heldBy('team_lead');
    assert.ok(held.includes('outsource.deliver'), 'a lead holds it by default');

    const r = await deliver('lee', [mine.assignment.id, theirs.assignment.id]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const byId = new Map(r.body.results.map((x) => [x.id, x]));
    assert.strictEqual(byId.get(mine.assignment.id).ok, true, 'their own project delivers');
    assert.strictEqual(byId.get(theirs.assignment.id).ok, false);
    assert.match(byId.get(theirs.assignment.id).error,
      /permission to record a stage on outsourced work on that project/);
    assert.strictEqual(await statusOf(theirs.asset.id, id.other), 'not_started',
      'and the off-project task is untouched');
  });

  await t.test('the permission, off and on again on the same token', async () => {
    const { asset, assignment } = await outsourced('Gated');
    const held = await heldBy('team_lead');

    await setPerms('team_lead', held.filter((k) => k !== 'outsource.deliver'));
    try {
      const me = await as('lee', '/auth/me');
      assert.ok(!me.body.user.permissions.includes('outsource.deliver'),
        'the session the page reads says no');
      const refused = await deliver('lee', [assignment.id]);
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual(await statusOf(asset.id), 'not_started', 'and nothing moved');
    } finally {
      await setPerms('team_lead', held);
    }

    /* GRANTED BACK, AND IT WORKS ON THE SAME TOKEN — no sign-out. The page
       re-reads /auth/me every twenty seconds, so this is the page's own
       question. */
    const me = await as('lee', '/auth/me');
    assert.ok(me.body.user.permissions.includes('outsource.deliver'), 'the grant is visible');
    const ok = await deliver('lee', [assignment.id]);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.delivered, 1);
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');

    /* AND THE PAYLOAD THE PAGE GATES ON FOLLOWS IT, in both directions — which
       is what stops the boxes being drawn for somebody the server would refuse. */
    assert.strictEqual((await as('lee', '/outsource/assignments')).body.canDeliver, true);
    await setPerms('team_lead', held.filter((k) => k !== 'outsource.deliver'));
    try {
      assert.strictEqual((await as('lee', '/outsource/assignments')).body.canDeliver, false,
        'revoked, the tab stops offering the boxes');
    } finally {
      await setPerms('team_lead', held);
    }
  });

  await t.test('the status dropdown no longer writes a delivery', async () => {
    /* Delivery is a transition now, so the generic edit refuses a move into it
       and names the action. Everything else about the form still saves. */
    const { asset, assignment } = await outsourced('Via The Form');
    const r = await as('root', `/outsource/assignments/${assignment.id}`, {
      method: 'PUT',
      body: { freelancerId: id.freelancer, projectId: id.project, assetId: asset.id,
        decidedManHours: 8, status: 'delivered' } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /Use Mark as Delivered/);
    assert.strictEqual(r.body.field, 'status');
    assert.strictEqual((await assignmentRow(assignment.id)).status, 'assigned', 'nothing was written');
    assert.strictEqual(await statusOf(asset.id), 'not_started');

    // The other three still save exactly as before.
    const fine = await as('root', `/outsource/assignments/${assignment.id}`, {
      method: 'PUT',
      body: { freelancerId: id.freelancer, projectId: id.project, assetId: asset.id,
        decidedManHours: 12, status: 'in_progress' } });
    assert.strictEqual(fine.status, 200, JSON.stringify(fine.body));
    assert.strictEqual(fine.body.assignment.decidedManHours, 12);

    /* And a row that is ALREADY delivered stays editable — the form sends its
       status back unchanged with every save, so refusing on the value alone
       would have frozen those rows. */
    await deliver('root', [assignment.id]);
    const after = await as('root', `/outsource/assignments/${assignment.id}`, {
      method: 'PUT',
      body: { freelancerId: id.freelancer, projectId: id.project, assetId: asset.id,
        decidedManHours: 14, status: 'delivered' } });
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    assert.strictEqual(after.body.assignment.decidedManHours, 14,
      'the agreed figure can still be corrected after delivery');
  });

  await t.test('both sides of the screen reflect it on the normal refresh', async () => {
    const { asset, assignment } = await outsourced('Both Views');
    await deliver('root', [assignment.id]);

    // The outsourcer side: the Outsource tab's own list.
    const row = await assignmentRow(assignment.id);
    assert.strictEqual(row.statusLabel, 'Delivered');
    assert.ok(row.deliveredAt && row.deliveredByName, 'with the deliverer on it');

    // The internal side: the board's own payload, and the lead's pending queue.
    const board = (await as('lee', `/assets/project/${id.project}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(board.status, 'pending_tl_review', 'the board has it in TL Review');
    /* AND THE SURFACES THAT COUNT STATUSES, which is where a new state would
       have half-migrated. The Admin Dashboard's Attention Required reads
       REVIEW_STATES = ['pending_tl_review','pending_cd_review'], so a delivered
       outsourced task is counted as work waiting on a decision — without a line
       of dashboard code having changed, because the destination is a status it
       already knew. */
    const dash = await as('root', '/admin-dashboard');
    assert.ok(dash.status < 400, JSON.stringify(dash.body));
    /* `attention` is a list of rows, each with its own count — and the rows with
        a count of nought are filtered out, so finding the row AT ALL is half the
        assertion. */
    const waiting = (dash.body.attention || []).find((r) => /waiting on review/.test(r.label || ''));
    assert.ok(waiting, `the dashboard has a waiting-on-review row (saw ${JSON.stringify(dash.body.attention)})`);
    assert.ok(Number(waiting.count) >= 1, 'counting at least this one');
    assert.ok((waiting.projects || []).some((pr) => pr.id === id.project),
      'and it names the project to open, which is what makes the number actionable');

    /* NOT in Pending Actions, and that is correct rather than a gap. That queue
       is about project review REQUESTS and game bugs; a lead's queue of work to
       review is the board's TL Review column, which is asserted above. Pinned so
       the distinction is recorded rather than rediscovered as a bug. */
    const held = await heldBy('team_lead');
    await setPerms('team_lead', [...held, 'pending.view']);
    try {
      const pending = await as('lee', '/project-reviews/pending-actions');
      assert.strictEqual(pending.status, 200, JSON.stringify(pending.body));
      assert.ok(!JSON.stringify(pending.body).includes(asset.id),
        'Pending Actions is for review requests and game bugs, not for assets in TL Review');
    } finally {
      await setPerms('team_lead', held);
    }
  });
});
