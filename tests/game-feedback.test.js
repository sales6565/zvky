/* Game Feedback end to end: a bug arrives, and the studio answers it.
 *
 * THE ONE RULE under test is idle-or-not. An asset is pulled into Game Feedback only if
 * nobody is working on it — Delivered or Approved for Client with no open round.
 * Everything else takes the feedback as a NOTE and does not move, and the three cases the
 * design treated separately (first pass in progress, mid-fix on an earlier round, already
 * carrying an open game bug) are all the same case here, because in all three somebody is
 * already working.
 *
 * AND THE REFUSAL-VERSUS-THROW distinction, which is easy to get backwards and expensive
 * when it is: a permanent business refusal must replay identically on a retry with the
 * same key, so it has to come back as a status through withIdempotency. A transient
 * failure must throw, leaving no idempotency row, so the retry actually runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('gamefeedbackflow');
const SECRET = 'inbound-secret-for-the-test-suite-only';
const PASSWORD = 'GameFeedback-Test-1!';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('a bug from the build, and what the studio does about it',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEY = 'gf-key-0123456789abcdef01';
  const tokens = {};
  const ids = {};

  const raise = async (assetId, body = {}, { idem = crypto.randomUUID() } = {}) => {
    const payload = JSON.stringify({
      source: 'qa', note: 'it clips through the floor', bug_ref: `QA-${crypto.randomUUID().slice(0, 8)}`,
      ...body,
    });
    const stamp = Math.floor(Date.now() / 1000);
    const target = `/api/integration/v1/assets/${assetId}/feedback`;
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.POST.${target}.${payload}`).digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'X-Integration-Key': KEY,
      'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
    };
    if (idem) headers['Idempotency-Key'] = idem;
    const res = await fetch(`${server.base}/integration/v1/assets/${assetId}/feedback`,
      { method: 'POST', headers, body: payload });
    return { status: res.status, replay: res.headers.get('idempotent-replay'), body: await res.json().catch(() => ({})) };
  };

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });
  const statusOf = async (assetId) =>
    (await sql(cfg, 'SELECT `status`, routed_to_id AS routed FROM assets WHERE id = ?', [assetId]))[0];
  const eventsOf = (assetId) => sql(cfg,
    'SELECT seq, action, from_status, to_status, acted_via, note FROM asset_events '
    + 'WHERE asset_id = ? ORDER BY seq', [assetId]);
  const feedbackOf = (assetId) => sql(cfg,
    'SELECT id, round, source, bug_ref, prev_status, prev_routed_to_id, note FROM external_feedback '
    + 'WHERE asset_id = ? ORDER BY created_at', [assetId]);

  // An asset parked in a given status, with an optional open round.
  const asset = async (status, { assignee = null, open = false, project = null } = {}) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id, routed_to_id) '
      + 'VALUES (?,?,?,?,?,?,?,?)',
      [id, project || ids.project, `GF-${id.slice(0, 6)}`, 'Bug Bait', 'character', status,
        assignee, assignee]);
    if (open) {
      await sql(cfg,
        'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at) VALUES (?,?,?,?,NOW())',
        [crypto.randomUUID(), id, assignee || ids.artist, 1]);
    }
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'gf-bootstrap',
      INTEGRATION_INBOUND_SECRET: SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'assets,projects']);

    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'gf-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    tokens.root = await login('root@zvky.test');

    const make = async (name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      tokens[name] = await login(email);
      return r.body.user.id;
    };
    ids.artist = await make('artist', 'artist@zvky.test', 'game_artist');
    ids.lead = await make('lead', 'lead@zvky.test', 'team_lead');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Shipped Game', clientId: client.body.client.id, teamLeadIds: [ids.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  // --- IDLE: the asset moves ------------------------------------------------

  await t.test('a delivered asset with no open round is pulled into Game Feedback', async () => {
    const id = await asset('delivered', { assignee: ids.artist });
    const r = await raise(id, { note: 'falls through the world at CP2', build: 'build-1041' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.movedAsset, true);
    assert.strictEqual(r.body.assetStatus, 'game_feedback');

    const now = await statusOf(id);
    assert.strictEqual(now.status, 'game_feedback');
    assert.strictEqual(now.routed, null,
      'routed to nobody: the first gate is a queue, and canActAtTlGate decides who may take from it');

    /* THE RESTORE PAIR, copied from the asset as it was. Neither is recoverable
       afterwards — the status is gone the moment it changes. */
    const [fb] = await feedbackOf(id);
    assert.strictEqual(fb.prev_status, 'delivered');
    assert.strictEqual(fb.prev_routed_to_id, ids.artist);
    assert.strictEqual(Number(fb.round), 1, 'the round it was raised against, recorded not invented');
  });

  await t.test('and so is one in Approved for Client', async () => {
    const id = await asset('approved_for_client');
    const r = await raise(id);
    assert.strictEqual(r.body.movedAsset, true);
    assert.strictEqual((await statusOf(id)).status, 'game_feedback');
  });

  // --- NOT IDLE: a note, and nothing moves ---------------------------------

  await t.test('work in its first pass takes a note and does not move', async () => {
    const id = await asset('in_progress', { assignee: ids.artist, open: true });
    const r = await raise(id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.movedAsset, false);
    assert.strictEqual((await statusOf(id)).status, 'in_progress', 'taking it off them would lose their round');

    const [fb] = await feedbackOf(id);
    assert.strictEqual(fb.prev_status, null, 'nothing moved, so there is nothing to restore');
    assert.strictEqual(fb.prev_routed_to_id, null);
  });

  await t.test('a DELIVERED asset with an open round is also not idle', async () => {
    /* Both halves of the rule matter. A delivered asset somebody has reopened and started
       has an open session, and the status alone would say it was idle. */
    const id = await asset('delivered', { assignee: ids.artist, open: true });
    const r = await raise(id);
    assert.strictEqual(r.body.movedAsset, false, 'the open round is what decides, not the status');
    assert.match(r.body.reason, /round is already open/);
    assert.strictEqual((await statusOf(id)).status, 'delivered');
  });

  await t.test('an asset already carrying an open game bug takes a note', async () => {
    // The third case the design treated separately, and it is the same case: somebody is
    // already working, so nothing moves.
    const id = await asset('delivered', { assignee: ids.artist });
    assert.strictEqual((await raise(id)).body.movedAsset, true);

    const second = await raise(id, { note: 'and the hands are inside out' });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.movedAsset, false, 'one game bug open at a time moves the asset');
    assert.strictEqual((await statusOf(id)).status, 'game_feedback');
    assert.strictEqual((await feedbackOf(id)).length, 2, 'but both are recorded');
  });

  await t.test('mid-fix on an earlier round is the same case again', async () => {
    const id = await asset('tl_changes_requested', { assignee: ids.artist, open: true });
    const r = await raise(id);
    assert.strictEqual(r.body.movedAsset, false);
    assert.strictEqual((await statusOf(id)).status, 'tl_changes_requested');
  });

  // --- the three permanent refusals ----------------------------------------

  await t.test('REFUSAL: on hold, archived and a closed project are all REFUSED, not thrown',
    async () => {
      /* Returned as a status so withIdempotency records them — a permanent business
         answer must replay identically on a retry with the same key.
         
         ARCHIVED IS THE PROJECT'S, not the asset's: `assets` has no archived flag in this
         schema. The Assets List's "Archived" tab is status = delivered, which is the idle
         state that SHOULD take a bug, so that is not what this means. */
      const clientId = (await sql(cfg, 'SELECT id FROM clients LIMIT 1'))[0].id;
      const shelf = await as('root', '/projects',
        { method: 'POST', body: { name: 'Shelved Game', clientId } });
      const shelfId = shelf.body.project.id;
      const archived = await asset('delivered', { project: shelfId });
      await sql(cfg, 'UPDATE projects SET is_active = 0 WHERE id = ?', [shelfId]);
      const a = await raise(archived);
      assert.strictEqual(a.status, 409, JSON.stringify(a.body));
      assert.strictEqual(a.body.code, 'project_archived');
      assert.match(a.body.error, /archived/);

      // On hold is DERIVED: the newest session belonging to the holder, ended 'held'.
      const held = await asset('delivered', { assignee: ids.artist });
      await sql(cfg,
        'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
        + 'VALUES (?,?,?,?,NOW() - INTERVAL 60 MINUTE, NOW() - INTERVAL 30 MINUTE, 1800, ?)',
        [crypto.randomUUID(), held, ids.artist, 1, 'held']);
      const h = await raise(held);
      assert.strictEqual(h.status, 409, JSON.stringify(h.body));
      assert.strictEqual(h.body.code, 'asset_on_hold');
      assert.strictEqual((await statusOf(held)).status, 'delivered', 'and it did not move');

      const closedProject = await as('root', '/projects', {
        method: 'POST',
        body: { name: 'Finished Game', clientId: (await sql(cfg, 'SELECT id FROM clients LIMIT 1'))[0].id },
      });
      const pid = closedProject.body.project.id;
      const shelved = crypto.randomUUID();
      await sql(cfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
        [shelved, pid, 'GF-CLOSED', 'Shelved', 'character', 'delivered']);
      await sql(cfg, 'UPDATE projects SET closed_at = NOW() WHERE id = ?', [pid]);
      const c = await raise(shelved);
      assert.strictEqual(c.status, 409, JSON.stringify(c.body));
      assert.strictEqual(c.body.code, 'project_closed');
    });

  await t.test('REFUSAL REPLAYS: the same key gets the identical refusal back', async () => {
    /* THE POINT OF RETURNING RATHER THAN THROWING. A thrown error writes no idempotency
       row, so the retry would run again; a returned refusal is recorded and replays. */
    const clientId = (await sql(cfg, 'SELECT id FROM clients LIMIT 1'))[0].id;
    const shelf = await as('root', '/projects',
      { method: 'POST', body: { name: 'Replay Shelf', clientId } });
    const archived = await asset('delivered', { project: shelf.body.project.id });
    await sql(cfg, 'UPDATE projects SET is_active = 0 WHERE id = ?', [shelf.body.project.id]);
    const idem = crypto.randomUUID();
    const first = await raise(archived, {}, { idem });
    assert.strictEqual(first.status, 409);

    const again = await raise(archived, { }, { idem });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body.code, 'project_archived');
    assert.deepStrictEqual(again.body, first.body, 'byte for byte, which is what replay means');
  });

  await t.test('THROW, not refuse: a transient failure leaves no trace and retries cleanly',
    async () => {
      /* THE OTHER HALF OF THE DISTINCTION, and the half a test is easiest to forget. A
         permanent business refusal is RETURNED so it replays; a transient failure must
         THROW, so no idempotency row is written and the caller's retry actually runs
         rather than replaying a stale error for seven days.
         
         The fault is made real rather than simulated: a column the insert names is taken
         away, which is what a half-applied migration or an unavailable database looks
         like from inside the handler. */
      const id = await asset('delivered');
      const idem = crypto.randomUUID();

      await sql(cfg, 'ALTER TABLE external_feedback DROP COLUMN link');
      let broke;
      try {
        broke = await raise(id, { bug_ref: 'QA-TRANSIENT' }, { idem });
      } finally {
        await sql(cfg, 'ALTER TABLE external_feedback ADD COLUMN link VARCHAR(2048) NULL');
      }
      assert.ok(broke.status >= 500, `it fails loudly: ${broke.status} ${JSON.stringify(broke.body)}`);

      // Nothing was written, and the asset was not moved.
      assert.strictEqual((await feedbackOf(id)).length, 0, 'no feedback row survives the rollback');
      assert.strictEqual((await statusOf(id)).status, 'delivered', 'and the asset did not move');

      /* And the key is free. A row IS there — the claim, which is committed before the
         handler runs — but marked failed rather than holding an answer, which is what
         makes it takeable. */
      const claim = await sql(cfg,
        'SELECT `status`, response_status FROM integration_requests WHERE idempotency_key = ?', [idem]);
      assert.strictEqual(claim.length, 1);
      assert.strictEqual(claim[0].status, 'failed', 'nothing to replay');
      assert.strictEqual(claim[0].response_status, null);

      // THE SAME KEY, now that the fault is gone, runs properly.
      const retry = await raise(id, { bug_ref: 'QA-TRANSIENT' }, { idem });
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
      assert.strictEqual(retry.replay, null, 'a retry after a throw runs rather than replaying');
      assert.strictEqual(retry.body.movedAsset, true);
      assert.strictEqual((await feedbackOf(id)).length, 1);
    });

  await t.test('THROW rolls back a write the handler had already made', async () => {
    /* THE CASE THAT ACTUALLY DISTINGUISHES throw FROM return, and it took finding.
       
       withIdempotency does not record a status >= 400, so a RETURNED 500 and a THROWN
       error look identical whenever the failure is the handler's first write — which is
       why a mutation swapping them survives the test above. The difference is what
       happens to writes made BEFORE the failure: a throw rolls the transaction back, a
       returned status COMMITS it. So the fault is placed after the feedback row is
       written and before the event row is, by taking away a column the SECOND insert
       names. */
    const id = await asset('in_progress', { assignee: ids.artist, open: true });
    const idem = crypto.randomUUID();

    await sql(cfg, 'ALTER TABLE asset_events DROP COLUMN note');
    let broke;
    try {
      broke = await raise(id, { bug_ref: 'QA-ROLLBACK' }, { idem });
    } finally {
      await sql(cfg, 'ALTER TABLE asset_events ADD COLUMN note TEXT NULL');
    }
    assert.ok(broke.status >= 500, `${broke.status} ${JSON.stringify(broke.body)}`);

    /* The feedback row had already been inserted when the event insert failed. A returned
       status would have committed it and left a bug recorded against a round nobody was
       told about; the throw takes it back. */
    assert.strictEqual((await feedbackOf(id)).length, 0,
      'the feedback row written before the failure is rolled back, not committed');
    assert.strictEqual((await eventsOf(id)).length, 0);

    // And the key is free, so the retry does the whole thing properly.
    const retry = await raise(id, { bug_ref: 'QA-ROLLBACK' }, { idem });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual((await feedbackOf(id)).length, 1);
    assert.strictEqual((await eventsOf(id)).length, 1);
  });

  await t.test('and the unique key is the second guard, on a FRESH idempotency key', async () => {
    const id = await asset('delivered');
    const bug = 'QA-SAME-REF';
    const one = await raise(id, { bug_ref: bug });
    assert.strictEqual(one.body.movedAsset, true);

    const two = await raise(id, { bug_ref: bug }, { idem: crypto.randomUUID() });
    assert.strictEqual(two.status, 200, JSON.stringify(two.body));
    assert.strictEqual(two.body.alreadyRaised, true, 'one defect, one round, however many calls');
    assert.strictEqual((await feedbackOf(id)).length, 1);
  });

  // --- the studio answers it ------------------------------------------------

  await t.test('the lead passes it to the artist — no round-creation logic anywhere', async () => {
    const id = await asset('delivered', { assignee: ids.artist });
    await raise(id);

    const r = await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actedVia, 'team_lead');

    const now = await statusOf(id);
    assert.strictEqual(now.status, 'game_feedback', 'still open; routing says whose move it is');
    assert.strictEqual(now.routed, ids.artist);

    /* The round comes from the artist's next submission through asset_versions, which is
       why nothing here creates one. Asserted as the absence of any round row. */
    const rounds = await sql(cfg, 'SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = ?', [id]);
    assert.strictEqual(Number(rounds[0].n), 0, 'passing it creates no submission and no round');
  });

  await t.test('the lead declines it, and the asset goes back where it was', async () => {
    const id = await asset('delivered', { assignee: ids.artist });
    await raise(id, { bug_ref: 'QA-DECLINE-1' });
    assert.strictEqual((await statusOf(id)).status, 'game_feedback');

    const r = await as('lead', `/assets/${id}/game-feedback`, {
      method: 'POST', body: { decision: 'decline', reason: 'working as designed at CP2' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const now = await statusOf(id);
    assert.strictEqual(now.status, 'delivered', 'restored from the round\'s stored prev_status');
    assert.strictEqual(now.routed, ids.artist, 'and its prev_routed_to_id');

    // The reason is on the event, and Dev & QA are told through the outbox.
    const events = await eventsOf(id);
    const declined = events.find((e) => e.action === 'game_feedback_decline');
    assert.match(declined.note, /working as designed/);

    const out = await sql(cfg, 'SELECT payload FROM integration_outbox ORDER BY seq DESC LIMIT 1');
    const payload = JSON.parse(out[0].payload);
    assert.strictEqual(payload.event, 'feedback.declined');
    assert.strictEqual(payload.assetId, id);
    assert.strictEqual(payload.restoredTo, 'delivered');
    assert.match(payload.reason, /working as designed/);
  });

  await t.test('declining needs a reason, and a decision needs an open round', async () => {
    const id = await asset('delivered');
    await raise(id);
    const bare = await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'decline' } });
    assert.strictEqual(bare.status, 400, JSON.stringify(bare.body));
    assert.strictEqual(bare.body.field, 'note');

    // And an asset with no game bug open cannot be acted on at all.
    const quiet = await asset('delivered');
    const nope = await as('lead', `/assets/${quiet.id || quiet}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(nope.status, 409, JSON.stringify(nope.body));
  });

  await t.test('the artist cannot decide what happens to it, and is told why', async () => {
    const id = await asset('delivered', { assignee: ids.artist });
    await raise(id);
    const r = await as('artist', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /this project's review team/,
      'its own refusal, not the generic one — the reader delivered this asset themselves');
  });

  await t.test('full access reaches it too, and is recorded as the override it is', async () => {
    /* The Super Admin reaches every gate whether staffed on the project or not, which is
       most of what the tier is for. Tagged distinctly so the history and the Efficiency
       report can tell a round the team turned round from one an administrator pushed
       through. */
    const id = await asset('delivered', { assignee: ids.artist });
    await raise(id);
    const r = await as('root', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actedVia, 'full_access_override');

    const events = await eventsOf(id);
    const passed = events.find((e) => e.action === 'game_feedback_pass');
    assert.strictEqual(passed.acted_via, 'full_access_override', 'on the row, not just in the reply');
  });

  // --- Dev & QA can actually SEE all of this -------------------------------

  await t.test('every step is visible on the incremental sync cursor', async () => {
    /* THE GAP THIS WOULD HAVE BEEN. Dev & QA poll
       GET /projects/:id/assets?updated_since=<seq>, and that cursor is
       MAX(asset_events.seq). A Game Feedback arrival or resolution that wrote no event
       would land invisibly — they would never learn the studio had answered them. */
    const id = await asset('delivered', { assignee: ids.artist });

    const before = await sql(cfg, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM asset_events');
    const from = Number(before[0].seq);

    await raise(id, { bug_ref: 'QA-VISIBLE-1' });
    await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });

    const events = await eventsOf(id);
    assert.deepStrictEqual(events.map((e) => e.action), ['game_feedback_raised', 'game_feedback_pass'],
      'both an arrival and a resolution write one');
    assert.ok(events.every((e) => Number(e.seq) > from), 'and both advance the cursor');

    // Now read it the way Dev & QA would.
    const stamp = Math.floor(Date.now() / 1000);
    const target = `/api/integration/v1/projects/${ids.project}/assets?updated_since=${from}`;
    const v1 = crypto.createHmac('sha256', SECRET).update(`${stamp}.GET.${target}.`).digest('hex');
    const res = await fetch(`${server.base}/integration/v1/projects/${ids.project}/assets?updated_since=${from}`, {
      headers: { 'X-Integration-Key': KEY, 'X-Integration-Signature': `t=${stamp}, v1=${v1}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const seen = body.assets.find((a) => a.id === id);
    assert.ok(seen, `the asset must appear on the incremental sync: ${JSON.stringify(body.assets.map((a) => a.id))}`);
    assert.ok(seen.updatedSeq > from, 'with a marker past where they had got to');

    // A note-only arrival is visible too — that is the case most likely to be missed.
    const busy = await asset('in_progress', { assignee: ids.artist, open: true });
    const mark = Number((await sql(cfg, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM asset_events'))[0].seq);
    await raise(busy, { bug_ref: 'QA-VISIBLE-2' });
    const noteEvents = await eventsOf(busy);
    assert.deepStrictEqual(noteEvents.map((e) => e.action), ['game_feedback_note']);
    assert.ok(Number(noteEvents[0].seq) > mark, 'a note advances the cursor as well');
  });
});
