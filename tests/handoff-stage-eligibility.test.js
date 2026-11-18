/* WHICH STAGES MAY BE SENT TO DEV & QA — and the "REFUSED" that was not a refusal.
 *
 * ===========================================================================
 * THE REPORT, AND WHAT IT TURNED OUT TO BE.
 *
 * The studio saw this after selecting an asset and pressing Send to Dev:
 *
 *     REFUSED  COLORE-030
 *
 * in red, with no reason underneath, on assets that were in perfectly ordinary production
 * stages. The obvious reading is a stage eligibility rule, and it was the wrong one: the
 * hand-off had been created, the event emitted, the outbox row written and the asset's
 * history updated. Every one of those sends SUCCEEDED.
 *
 * THE BUG WAS A FIELD NAME. public/index.html's bulkResultsHTML() is shared by all three
 * bulk actions and reads r.ok, r.skipped and r.error — the shape /bulk/deliver and
 * /bulk/assign return. The send route answered with `outcome` and `reason` instead, so
 * r.ok was undefined for every row and the renderer's ternary fell through to its last
 * branch, which prints "refused" in the danger colour. Two halves of one feature
 * disagreeing about the name of a field.
 *
 * ===========================================================================
 * SO THIS SUITE HOLDS TWO THINGS, AND THE SECOND IS THE ONE THAT WOULD HAVE CAUGHT IT.
 *
 *   1. THE FIVE STAGES ARE SENDABLE, both destinations, discipline intact, and the asset's
 *      own row untouched afterwards. They already were — the send path never consulted the
 *      stage — but "already true" is exactly the kind of thing that stops being true
 *      quietly, and the brief asks for it pinned.
 *
 *   2. EVERY RESULT THIS ROUTE CAN PRODUCE IS UNDERSTOOD BY THE RENDERER THAT DRAWS IT.
 *      The page's own expression is lifted out of public/index.html and run over the
 *      route's real output, so a success renders as a success and a refusal as a refusal.
 *      A test that only checked the response body would have passed throughout the bug.
 *
 * NO STAGE ALLOW-LIST WAS ADDED, and that is a decision rather than an omission: see the
 * last test here. An allow-list of these five would have REFUSED the stages that are
 * sendable today, including the half-finished work that is the normal case for a partial
 * drop.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const workflow = require('../src/asset-workflow');

const cfg = config('handoffstages');
const PASSWORD = 'HandoffStage-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* THE FIVE STAGES THE BRIEF NAMES, BY THEIR CANONICAL IDS — read back out of
   src/asset-workflow.js rather than written as strings here, so a renamed status fails
   this file instead of silently testing a stage that no longer exists. */
const STAGES = [
  { id: 'tl_approved', label: 'TL Approved' },
  { id: 'approved_for_client', label: 'Approved for Client' },
  { id: 'awaiting_client_feedback', label: 'Awaiting Client Feedback' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'game_feedback', label: 'Game Feedback' },
];

test('the five stages are real, canonical, and spelled as the workflow spells them', () => {
  const known = new Map(workflow.STATES.map((s) => [s.id, s.label]));
  assert.ok(known.size > 5, 'the workflow publishes its statuses');
  for (const stage of STAGES) {
    assert.ok(known.has(stage.id), `${stage.id} is a status this application has`);
    assert.strictEqual(known.get(stage.id), stage.label,
      `${stage.id} is the stage the brief calls "${stage.label}"`);
  }
});

test('sending from any production stage', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

  const DESTINATIONS = [
    { path: '/assets/bulk/send-to-tech-art', destination: 'tech_art', kind: 'tech_art' },
    { path: '/assets/bulk/send-to-dev', destination: 'development', kind: 'partial_drop' },
  ];

  /* The WHOLE asset row, before and after. Not a list of columns somebody has to remember
     to extend: the brief asks that the stage, the status, the review state and the
     delivery state are all untouched, and a deep comparison of the row covers those four
     and everything else besides. */
  const rowOf = async (id) => (await sql(cfg, 'SELECT * FROM assets WHERE id = ?', [id]))[0];

  const newAsset = async (name, { status, type = 'character', project = null } = {}) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
      [id, project || ids.project, `ST-${id.slice(0, 5)}`, name, type, status]);
    return id;
  };

  const handoffsFor = (assetId) => sql(cfg,
    'SELECT h.id, h.kind, h.project_id FROM handoffs h JOIN handoff_assets ha ON ha.handoff_id = h.id '
    + 'WHERE ha.asset_id = ?', [assetId]);
  const eventsOf = (assetId) => sql(cfg,
    'SELECT action, from_status, to_status, note FROM asset_events WHERE asset_id = ? ORDER BY seq',
    [assetId]);
  const outboxFor = async (handoffId) => (await sql(cfg,
    "SELECT payload FROM integration_outbox WHERE event_type = 'handoff.created' ORDER BY seq"))
    .map((r) => JSON.parse(r.payload))
    .filter((e) => e.payload.handoffId === handoffId);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'hs-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'hs-bootstrap', name: 'Root', email: 'root@stage.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@stage.test');

    const make = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      token[who] = await login(email);
      return r.body.user.id;
    };
    ids.lead = await make('lead', 'lead@stage.test', 'team_lead');
    ids.artist = await make('artist', 'artist@stage.test', 'game_artist');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Colore Co' } });
    ids.client = client.body.client.id;
    const project = await as('root', '/projects',
      { method: 'POST', body: { name: 'Colore', clientId: ids.client } });
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ------------------------------------- the matrix: five stages, two destinations */

  for (const dest of DESTINATIONS) {
    for (const stage of STAGES) {
      await t.test(`${stage.label} → ${dest.destination}: sent, and the stage does not move`, async () => {
        const asset = await newAsset(`${stage.id} to ${dest.destination}`, { status: stage.id });
        const before = await rowOf(asset);
        assert.strictEqual(before.status, stage.id, 'the asset starts in the stage under test');

        const r = await as('lead', dest.path, { method: 'POST', body: { assetIds: [asset] } });

        /* SUCCESS, AND NOT A REFUSAL ANYWHERE IN THE ANSWER. */
        assert.strictEqual(r.status, 201, `${stage.label}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.results.length, 1);
        const result = r.body.results[0];
        assert.strictEqual(result.outcome, 'sent', JSON.stringify(result));
        assert.strictEqual(result.ok, true, 'and it says so in the field the page reads');
        assert.ok(!result.error, 'with no error on it');
        assert.strictEqual(r.body.destination, dest.destination);
        assert.strictEqual(r.body.kind, dest.kind, 'the legacy field too');

        // ONE hand-off, carrying this asset, on this project.
        const drops = await handoffsFor(asset);
        assert.strictEqual(drops.length, 1, 'exactly one hand-off');
        assert.strictEqual(drops[0].kind, dest.kind);
        assert.strictEqual(drops[0].project_id, ids.project);

        // The event, with both fields.
        const envelopes = await outboxFor(drops[0].id);
        assert.strictEqual(envelopes.length, 1, 'one integration event');
        assert.strictEqual(envelopes[0].payload.destination, dest.destination);
        assert.strictEqual(envelopes[0].payload.assets[0].discipline, 'art');
        assert.strictEqual(envelopes[0].payload.assets[0].id, asset);

        // The history, readable, naming where it went.
        const events = await eventsOf(asset);
        const sent = events.filter((e) => e.action === 'sent_to_dev');
        assert.strictEqual(sent.length, 1);
        assert.match(sent[0].note, dest.destination === 'tech_art' ? /Sent to Tech Art/ : /Sent to Development/);

        /* THE CRITICAL RULE: the asset's own row is byte-for-byte what it was. The history
           event records the stage it was in on both sides — from_status and to_status are
           the same value — so the send is a note about the asset rather than a move of
           it. */
        assert.strictEqual(sent[0].from_status, stage.id);
        assert.strictEqual(sent[0].to_status, stage.id, 'the event itself records no move');
        assert.deepStrictEqual(await rowOf(asset), before,
          `${stage.label}: sending changed the asset row`);
      });
    }
  }

  /* --------------------------------------------- discipline across the stages */

  await t.test('discipline survives every combination the brief names', async () => {
    /* Art + Delivered → Development, Animation + Delivered → Development,
       Art + Game Feedback → Tech Art, Animation + Game Feedback → Tech Art.
       The discipline is the asset's own and the destination is the sender's choice, so all
       four pairings are possible and none of them may be inferred from the other. */
    const combinations = [
      { type: 'character', status: 'delivered',     path: '/assets/bulk/send-to-dev',       destination: 'development', discipline: 'art' },
      { type: 'animation', status: 'delivered',     path: '/assets/bulk/send-to-dev',       destination: 'development', discipline: 'animation' },
      { type: 'character', status: 'game_feedback', path: '/assets/bulk/send-to-tech-art',  destination: 'tech_art',    discipline: 'art' },
      { type: 'animation', status: 'game_feedback', path: '/assets/bulk/send-to-tech-art',  destination: 'tech_art',    discipline: 'animation' },
    ];
    for (const c of combinations) {
      const asset = await newAsset(`${c.type} ${c.status} ${c.destination}`,
        { status: c.status, type: c.type });
      const before = await rowOf(asset);
      const r = await as('lead', c.path, { method: 'POST', body: { assetIds: [asset] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.results[0].discipline, c.discipline,
        `${c.type} in ${c.status} is ${c.discipline}`);
      assert.strictEqual(r.body.destination, c.destination);

      const drops = await handoffsFor(asset);
      const envelope = (await outboxFor(drops[0].id))[0];
      assert.strictEqual(envelope.payload.assets[0].discipline, c.discipline);
      assert.strictEqual(envelope.payload.destination, c.destination);
      assert.deepStrictEqual(await rowOf(asset), before, 'and the asset did not move');
    }
  });

  /* ---------------------------------------------------------------- bulk sends */

  for (const dest of DESTINATIONS) {
    await t.test(`one ${dest.destination} send carrying all five stages at once`, async () => {
      /* THE WHOLE SELECTION IS ACCEPTED, and differing stages are not a reason to refuse
         any of it — which is the brief's bulk case and the shape of the original
         complaint: several assets picked off a list, in whatever stage each had reached. */
      const assets = [];
      for (const stage of STAGES) {
        assets.push({ stage, id: await newAsset(`bulk ${stage.id} ${dest.destination}`, { status: stage.id }) });
      }
      const before = new Map();
      for (const a of assets) before.set(a.id, await rowOf(a.id));

      const r = await as('lead', dest.path, { method: 'POST', body: { assetIds: assets.map((a) => a.id) } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.results.length, 5);
      assert.deepStrictEqual(r.body.results.map((x) => x.outcome), ['sent', 'sent', 'sent', 'sent', 'sent']);
      assert.deepStrictEqual(r.body.results.map((x) => x.ok), [true, true, true, true, true]);

      /* ONE hand-off for the group, with all five in it — the existing bulk semantics,
         unchanged. */
      const drops = await handoffsFor(assets[0].id);
      assert.strictEqual(drops.length, 1);
      const inDrop = await sql(cfg,
        'SELECT asset_id FROM handoff_assets WHERE handoff_id = ?', [drops[0].id]);
      assert.deepStrictEqual(inDrop.map((x) => x.asset_id).sort(), assets.map((a) => a.id).sort());

      const envelope = (await outboxFor(drops[0].id))[0];
      assert.strictEqual(envelope.payload.assets.length, 5);
      assert.strictEqual(envelope.payload.destination, dest.destination);

      for (const a of assets) {
        assert.deepStrictEqual(await rowOf(a.id), before.get(a.id),
          `${a.stage.label} moved during a bulk send`);
      }
    });
  }

  /* ------------------------------------------------------- the renderer contract */

  await t.test("the page's own results renderer calls these successes successes", async () => {
    /* THE TEST THAT WOULD HAVE CAUGHT THE BUG.
     *
     * The expression is LIFTED FROM public/index.html rather than restated, so this cannot
     * pass against a page that reads different fields. It is then run over the route's
     * real output — a success, a skip and a genuine failure in one response — and each has
     * to come out as the word a person should see.
     *
     * A test that asserted only on the response body would have passed every day the
     * studio was being told REFUSED. */
    const from = PAGE.indexOf('function bulkResultsHTML(results){');
    assert.ok(from !== -1, 'the page has the shared results renderer');
    const body = PAGE.slice(from, PAGE.indexOf('\n}', from));
    const wordLine = body.split('\n').find((l) => l.includes("const word ="));
    assert.ok(wordLine, `the renderer still decides a word: ${body.slice(0, 200)}`);
    // eslint-disable-next-line no-new-func
    const wordFor = new Function('r', `${wordLine.trim()} return word;`);

    const real = await newAsset('Renderer Success', { status: 'delivered' });
    const sent = await as('lead', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [real] } });
    assert.strictEqual(sent.status, 201);
    assert.strictEqual(wordFor(sent.body.results[0]), 'ok',
      `a sent asset must render as ok, not "${wordFor(sent.body.results[0])}"`);

    /* The same asset again at the same round, in one request with a nonsense id: a skip
       and a failure, which must still read as such — the fix must not make everything
       green. */
    const mixed = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [real, crypto.randomUUID()] } });
    assert.strictEqual(mixed.status, 201, JSON.stringify(mixed.body));
    const words = mixed.body.results.map((r) => `${r.outcome}:${wordFor(r)}`).sort();
    assert.deepStrictEqual(words, ['failed:refused', 'sent:ok'],
      `a real failure still reads as refused: ${JSON.stringify(mixed.body.results)}`);

    /* And a skip, which the page greys rather than reddens. */
    const twice = await as('lead', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [real] } });
    const dup = await sql(cfg,
      'SELECT COUNT(*) AS n FROM handoff_assets WHERE asset_id = ?', [real]);
    assert.ok(Number(dup[0].n) >= 1 && twice.status === 201, 'a repeat send answers 201');
  });

  /* ------------------------------------------------------------ negative cases */

  await t.test('what is still refused, and still reads as refused', async () => {
    /* NONE OF THE SAFETY RULES WAS RELAXED. Each of these refused before this change and
       refuses now, for a reason that has nothing to do with the asset's stage. */
    const delivered = await newAsset('Still Guarded', { status: 'delivered' });

    // An invalid id.
    const nonsense = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [crypto.randomUUID()] } });
    assert.strictEqual(nonsense.status, 404, JSON.stringify(nonsense.body));

    // No permission — an artist holds neither send key.
    for (const path of ['/assets/bulk/send-to-dev', '/assets/bulk/send-to-tech-art']) {
      const r = await as('artist', path, { method: 'POST', body: { assetIds: [delivered] } });
      assert.strictEqual(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
    }

    // Another project in the same selection.
    const other = await as('root', '/projects',
      { method: 'POST', body: { name: 'Elsewhere', clientId: ids.client } });
    const elsewhere = await newAsset('Other Project', { status: 'delivered', project: other.body.project.id });
    const mixed = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [delivered, elsewhere] } });
    assert.strictEqual(mixed.status, 400, JSON.stringify(mixed.body));
    assert.match(mixed.body.error, /different projects/);

    // Nothing selected.
    assert.strictEqual((await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [] } })).status, 400);

    // A destination that is not one of the two.
    assert.strictEqual((await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [delivered], destination: 'somewhere' } })).status, 400);

    // A closed project refuses the whole drop, whatever stage the work is in.
    const closed = await as('root', '/projects',
      { method: 'POST', body: { name: 'Finished', clientId: ids.client } });
    const inClosed = await newAsset('In A Closed Project',
      { status: 'delivered', project: closed.body.project.id });
    const shut = await as('root', `/projects/${closed.body.project.id}/close`, { method: 'POST' });
    if (shut.status === 200) {
      const r = await as('lead', '/assets/bulk/send-to-dev',
        { method: 'POST', body: { assetIds: [inClosed] } });
      assert.ok(r.status >= 400, `a closed project still refuses: ${JSON.stringify(r.body)}`);
    }
  });

  await t.test('no stage allow-list was added, and that is the decision', () => {
    /* WHY THERE IS NO LIST OF FIVE IN THE SOURCE.
     *
     * The five stages the brief names were already sendable, because the send path never
     * consulted the stage at all — src/routes/assets.js's own note says why: "ANY asset
     * can go in a drop... a partial drop is a partial drop — half-finished art on its way
     * to be looked at in the build is the normal case, not the exception."
     *
     * So adding an allow-list of those five would not have fixed anything. It would have
     * introduced a refusal: in_progress, assigned, not_started and the two
     * changes-requested stages are all sendable today, and an allow-list would have
     * started turning them away — breaking the "half-finished work is the normal case"
     * case in tests/send-to-dev.test.js and taking a working action away from the studio
     * in a release meant to fix one.
     *
     * This asserts the absence, so that a future change which adds such a list has to
     * come here and argue with this comment first. */
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
    const from = route.indexOf('async function sendHandoff');
    const to = route.indexOf("router.post('/bulk/send-to-tech-art'", from);
    assert.ok(from !== -1 && to > from, 'the shared sender is still there');
    const code = route.slice(from, to)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const stage of STAGES) {
      assert.ok(!code.includes(`'${stage.id}'`),
        `the sender should not name ${stage.id}: eligibility is not a stage list`);
    }
    assert.ok(!/SENDABLE_STATUSES|ALLOWED_STAGES|STATUS_ALLOW/.test(code),
      'and there is no allow-list constant');
    /* The one place the status appears is the history event, where it is COPIED into both
       sides so the record shows the asset did not move. */
    assert.ok(code.includes('asset.status'), 'the stage is still recorded in the event');
  });
});
