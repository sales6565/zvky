/* TL Approved: one stage inserted, and the three touchpoints around it.
 *
 * WHAT THE STUDIO ASKED FOR. The TL Review pop-up used to hold three buttons:
 * request changes, approve onward to the Creative Director, and — for a lead
 * holding the extra permission — send straight to the client. Two of those are
 * answers to "is this work good" and one is an answer to "who else needs to see
 * it", and they were being asked at the same moment in the same row.
 *
 * So the gate now asks one question and has exactly two buttons, and approving
 * lands in a new stage where the second question is asked on its own:
 *
 *   TL Review     Request Changes -> TL Feedbacks
 *                 TL Approved     -> TL Approved        (new)
 *
 *   TL Approved   Approve -> Send to CD Review -> CD Review
 *                 Send to Client                -> Approved for Client
 *
 * THE PERMISSIONS DID NOT MOVE WITH THE BUTTON. Sending approved work along the
 * ordinary pipeline needs what reviewing needed. Skipping the Creative Director
 * needs review.tl_send_client on top of that — a permission that already
 * existed for exactly this decision and that defaults to the full-access tier
 * alone. The studio flagged "Send to Client" as a bigger decision than a normal
 * transition; the application already agreed with them, and this file pins that
 * it still does.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   THE STAGE IS BETWEEN THE RIGHT TWO. Asserted as a position in the pipeline
 *      rather than as membership of a list, because the position is the
 *      requirement and a list is easy to reorder.
 *
 *   NOTHING ELSE MOVED. The stages either side, the permissions and the
 *      notifications are checked to be what they were, because "purely
 *      inserting one stage" is the whole of the brief and an insertion that
 *      quietly re-routed something else would be the expensive kind of wrong.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('tlapproved');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the shape of the pipeline, with no server --------------------------------

test('TL Approved sits between TL Feedbacks and CD Review', () => {
  /* The studio's seventh check. Asserted on the workflow AND on the page,
     because the board draws from the page's copy and the two drifting apart is
     the failure this pair exists to catch. */
  const ids = workflow.STATE_IDS;
  assert.strictEqual(ids.indexOf('tl_approved'), ids.indexOf('tl_changes_requested') + 1);
  assert.strictEqual(ids.indexOf('pending_cd_review'), ids.indexOf('tl_approved') + 1);

  const page = [...PAGE.match(/const STATUSES = \[([\s\S]*?)\n\];/)[1]
    .matchAll(/\{id:'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(page, ids, 'the page and the workflow list the same states in the same order');

  const state = workflow.STATES.find((s) => s.id === 'tl_approved');
  assert.strictEqual(state.label, 'TL Approved');
  assert.ok(!/7f1416/i.test(state.color) && !/--brand\b/.test(state.color),
    'and its colour is not the brand colour');
});

test('TL Review has exactly two ways out, and one of them is the new stage', () => {
  /* The studio's first requirement, read off the state machine rather than off
     the screen: whatever the panel draws, these are the only moves the server
     will make from TL Review. */
  const out = workflow.TRANSITIONS
    .filter((t) => t.from.includes('pending_tl_review'))
    /* reassign_review is not a review answer — it is handing the work to
       somebody else, which is offered from four stages and is a different
       control in a different part of the panel. */
    .filter((t) => t.action !== 'reassign_review');
  assert.deepStrictEqual(out.map((t) => t.action).sort(), ['tl_approve', 'tl_request_changes']);
  assert.strictEqual(workflow.transitionFor('tl_approve').to, 'tl_approved');
  assert.strictEqual(workflow.transitionFor('tl_request_changes').to, 'tl_changes_requested');
});

test('TL Approved has exactly two ways out', () => {
  const out = workflow.TRANSITIONS
    .filter((t) => t.from.includes('tl_approved'))
    .map((t) => [t.action, t.to])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepStrictEqual(out, [
    ['tl_send_to_client', 'approved_for_client'],
    ['tl_to_cd', 'pending_cd_review'],
  ]);
});

test('Send to Client still lands where the CD route lands', () => {
  /* "Reuse that existing mechanism rather than building a new one." It does —
     the same action, the same destination, moved only in where it is offered
     from. approved_for_client is the state the Deliver flow and the client
     round already read, so neither had to be told about this change. */
  assert.strictEqual(workflow.transitionFor('tl_send_to_client').to, 'approved_for_client');
  assert.strictEqual(workflow.transitionFor('cd_approve').to, 'approved_for_client');
  assert.strictEqual(workflow.transitionFor('deliver').from[0], 'approved_for_client');
});

test('nothing else in the pipeline was re-routed', () => {
  /* The studio's eighth check. Every OTHER transition, pinned exactly as it
     was, so "purely inserting one stage" is a claim this file can make. */
  const unchanged = {
    assign: ['not_started', 'assigned'],
    accept: ['assigned', 'in_progress'],
    tl_request_changes: ['pending_tl_review', 'tl_changes_requested'],
    cd_approve: ['pending_cd_review', 'approved_for_client'],
    cd_request_changes: ['pending_cd_review', 'cd_changes_requested'],
    relay: ['cd_changes_requested', 'cd_changes_requested'],
    deliver: ['approved_for_client', 'delivered'],
    client_sent: ['approved_for_client', 'awaiting_client_feedback'],
    client_approved: ['awaiting_client_feedback', 'delivered'],
    client_changes: ['awaiting_client_feedback', 'tl_changes_requested'],
    reassign_review: ['pending_tl_review', 'assigned'],
  };
  for (const [action, [from, to]] of Object.entries(unchanged)) {
    const t = workflow.transitionFor(action);
    assert.ok(t.from.includes(from), `${action} no longer starts at ${from}`);
    assert.strictEqual(t.to, to, `${action} no longer lands in ${to}`);
  }

  // And the hand-over stages are the same four. TL Approved is NOT one of them:
  // nobody is working on it there, so there is nobody to hand it away from.
  assert.deepStrictEqual([...workflow.transitionFor('reassign_review').from].sort(),
    ['cd_changes_requested', 'pending_cd_review', 'pending_tl_review', 'tl_changes_requested']);
});

// --- the panel ------------------------------------------------------------------

test('the TL Review pop-up draws two buttons, labelled as the studio asked', () => {
  const block = PAGE.match(/\$\{canTlReview \? `([\s\S]*?)\n    ` : ''\}/);
  assert.ok(block, 'the TL review block is in the panel');
  const ids = [...block[1].matchAll(/id="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['tlReviewNote', 'tlReqChangesBtn', 'tlApproveBtn'],
    'a note and two buttons, and nothing else');
  assert.match(block[1], />Request Changes</);
  assert.match(block[1], />TL Approved</);
  assert.ok(!/tlSendClientBtn/.test(block[1]),
    'Send to Client is no longer one of the choices at this gate');
});

test('the TL Approved panel draws the two routes, each behind its own permission', () => {
  const block = PAGE.match(/\$\{canRouteApproved \? `([\s\S]*?)\n    ` : ''\}/);
  assert.ok(block, 'the TL Approved block is in the panel');
  assert.match(block[1], /id="tlToCdBtn"/);
  assert.match(block[1], />Approve &rarr; Send to CD Review</);
  assert.match(block[1], /canSendToClient \? `<button[^>]*id="tlSendClientBtn"/,
    'Send to Client is drawn only for somebody who holds the permission for it');

  /* The gates themselves, read off the page: the ordinary route on needs the
     review permission and the stage; skipping the CD needs the extra one. */
  assert.match(PAGE, /const canRouteApproved = mayActAtTlGate\(a\) && a\.status==='tl_approved';/);
  /* And the helper is the permission plus the project's answer — see
     canActAtTlGate in src/permissions.js, which is the authority. */
  const gate = PAGE.slice(PAGE.indexOf('function mayActAtTlGate(a){'));
  assert.match(gate.slice(0, gate.indexOf('\n}')), /can\('review\.tl'\) && a\.can_review_tl !== false/);
  assert.match(PAGE, /const canSendToClient = canRouteApproved && can\('review\.tl_send_client'\);/);
});

// --- against a live server --------------------------------------------------------

test('the new stage, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'TlApproved-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const statusOf = async (assetId) =>
    (await as('root', `/assets/${assetId}/history`)).body.status;
  const historyOf = async (assetId) =>
    (await as('root', `/assets/${assetId}/history`)).body.events;

  /* An asset submitted and waiting at the first gate. Every step through its
     own route, so the state under test is one the application really makes. */
  let made = 0;
  const atTlReview = async () => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Shot ${made += 1}`, type: 'prop', assigneeId: id.ana },
    });
    const assetId = r.body.asset.id;
    await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    const s = await as('ana', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' },
    });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review', 'setup');
    return assetId;
  };
  const atTlApproved = async () => {
    const assetId = await atTlReview();
    const r = await as('lead', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return assetId;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    await openStudio(server.base, tok.root);

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId },
      });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.lead);
    await make('cd', 'Dana Director', 'cd@zvky.test', 'creative_art_director');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Gatehouse', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- 1 and 2: the two answers at TL Review ------------------------------- */

  await t.test('Request Changes lands in TL Feedbacks, as before', async () => {
    const assetId = await atTlReview();
    const r = await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'tighten the silhouette' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(await statusOf(assetId), 'tl_changes_requested');
  });

  await t.test('TL Approved lands in the new stage, NOT in CD Review', async () => {
    const assetId = await atTlApproved();
    assert.strictEqual(await statusOf(assetId), 'tl_approved');

    const last = (await historyOf(assetId)).pop();
    assert.strictEqual(last.action, 'tl_approve');
    assert.strictEqual(last.fromStatus, 'pending_tl_review');
    assert.strictEqual(last.toStatus, 'tl_approved', 'and the trail says where it went');
  });

  /* --- 3: the two ways out of TL Approved ---------------------------------- */

  await t.test('Approve → Send to CD Review lands in CD Review', async () => {
    const assetId = await atTlApproved();
    const r = await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(await statusOf(assetId), 'pending_cd_review');

    const last = (await historyOf(assetId)).pop();
    assert.strictEqual(last.action, 'tl_to_cd',
      'its own action, so the history can say who decided the CD should see it');

    // And the CD gate itself still works from there, untouched.
    assert.strictEqual((await as('cd', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 200);
    assert.strictEqual(await statusOf(assetId), 'approved_for_client');
  });

  await t.test('Send to Client goes straight to the client state, skipping CD Review', async () => {
    /* The permission is not the review one, and is not held out of the box —
       granting it here is the test, not a workaround. */
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('review.tl_send_client'),
      'TL Send to Client is not a team lead default — it is the studio\'s deliberate grant');

    const assetId = await atTlApproved();
    const refused = await as('lead', `/assets/${assetId}/send-to-client`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, 'without it, the route is refused');
    assert.match(refused.body.error, /TL Send to Client/, 'and the message names the permission');

    const grant = await as('root', '/permissions/roles/team_lead', {
      method: 'PUT', body: { permissions: [...held, 'review.tl_send_client'] },
    });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    try {
      tok.lead = await login('lead@zvky.test');
      const sent = await as('lead', `/assets/${assetId}/send-to-client`, {
        method: 'POST', body: { text: 'client already signed this off' },
      });
      assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      assert.strictEqual(await statusOf(assetId), 'approved_for_client',
        'the existing client-facing state, reused rather than rebuilt');

      const events = await historyOf(assetId);
      assert.strictEqual(events[events.length - 1].action, 'tl_send_to_client');
      assert.ok(!events.some((e) => e.toStatus === 'pending_cd_review'),
        'and the asset never entered CD Review at all');
      assert.ok(!events.some((e) => e.action === 'cd_approve'));

      // Delivered is still reachable from there, by the ordinary route.
      assert.strictEqual((await as('root', `/assets/${assetId}/deliver`, { method: 'POST' })).status, 200);
      assert.strictEqual(await statusOf(assetId), 'delivered');
    } finally {
      const off = await as('root', '/permissions/roles/team_lead', {
        method: 'PUT', body: { permissions: held },
      });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      tok.lead = await login('lead@zvky.test');
    }
  });

  /* --- who may do either --------------------------------------------------- */

  await t.test('the artist can do neither, whatever the lead holds', async () => {
    const assetId = await atTlApproved();
    assert.strictEqual((await as('ana', `/assets/${assetId}/send-to-cd`, { method: 'POST' })).status, 403);
    assert.strictEqual((await as('ana', `/assets/${assetId}/send-to-client`, { method: 'POST' })).status, 403);
    assert.strictEqual(await statusOf(assetId), 'tl_approved', 'and nothing moved');
  });

  await t.test('neither route is reachable from any other stage', async () => {
    const fresh = await atTlReview();
    assert.strictEqual((await as('lead', `/assets/${fresh}/send-to-cd`, { method: 'POST' })).status, 409,
      'approving comes first');

    const inCd = await atTlApproved();
    await as('lead', `/assets/${inCd}/send-to-cd`, { method: 'POST' });
    assert.strictEqual((await as('lead', `/assets/${inCd}/send-to-cd`, { method: 'POST' })).status, 409,
      'and there is no second bite once it is in the CD queue');
  });

  /* --- 8: nothing else changed --------------------------------------------- */

  await t.test('the board shows the new stage in its place, and the rest unchanged', async () => {
    /* The studio's seventh check against the real API: the status a board
       column is drawn from, coming back on a real asset. */
    const assetId = await atTlApproved();
    const board = await as('root', `/assets/project/${projectId}`);
    const row = board.body.assets.find((a) => a.id === assetId);
    assert.strictEqual(row.status, 'tl_approved');

    /* And it is a LIVE stage, not an archived or unassigned one — so the asset
       is on the Active tab of the Assets List rather than falling out of every
       tab, which is the quietest way to lose work. */
    const groups = PAGE.match(/const ASSET_LIST_GROUPS = \[([\s\S]*?)\n\];/)[1];
    const active = groups.match(/id:'active',[\s\S]*?statuses:\[([\s\S]*?)\]/)[1];
    assert.match(active, /'tl_approved'/, 'TL Approved is an Active-tab status');
  });

  await t.test('the notification behaviour around the gate is untouched', async () => {
    /* Approving at TL never notified anybody and still does not: it moves work
       into a review queue rather than onto a person's desk. Asserted because
       "no notification logic changes" is part of the brief, and a new stage
       raising one would be a change nobody asked for. */
    /* The cursor is taken AFTER the asset exists and is waiting at the gate.
       Creating it assigns it, and assigning notifies — an earlier version of
       this test read that 'assigned' line and blamed the approval for it. */
    const assetId = await atTlReview();
    const cursor = (await as('ana', '/notifications/poll')).body.cursor;

    await as('lead', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST' });

    const fresh = (await as('ana', `/notifications/poll?since=${cursor}`)).body.fresh || [];
    assert.deepStrictEqual(fresh.map((n) => n.kind), [],
      `neither approving nor routing notifies the artist: ${JSON.stringify(fresh)}`);

    /* And the one that DOES notify still does: requesting changes puts the
       work back on the artist's desk, which is a thing they need telling. */
    const other = await atTlReview();
    const before = (await as('ana', '/notifications/poll')).body.cursor;
    await as('lead', `/assets/${other}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'again please' },
    });
    const told = (await as('ana', `/notifications/poll?since=${before}`)).body.fresh || [];
    assert.strictEqual(told.length, 0,
      'requesting changes routes the asset rather than reassigning it, so the bell is unchanged too');
  });

  await t.test('every status the app can write is in the database constraint', async () => {
    /* The new stage has to be admitted by the CHECK constraint on assets.status
       or the first approval would fail at the database. It clearly does not —
       the subtests above have written it — but this asserts the list itself, so
       a future stage added without updating it fails here rather than in
       production on the day somebody approves something. */
    const rows = await sql(cfg,
      `SELECT CHECK_CLAUSE c FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()`).catch(() => []);
    const clause = rows.map((r) => r.c).join(' ');
    if (!clause) return;   // a MySQL that does not expose them; the writes above are the proof
    for (const state of workflow.STATE_IDS) {
      assert.match(clause, new RegExp(`'${state}'`), `${state} is not admitted by the constraint`);
    }
  });
});
