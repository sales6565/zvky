/* Send to Dev, and the Needs Tech Art flag.
 *
 * WHAT THE SEND HAS TO LEAVE BEHIND is four things in one transaction, and three of them
 * have a reader who would otherwise be blind:
 *
 *   handoffs + handoff_assets  what went, at which round, and what it claims to fix
 *   asset_events               Prompt 10's sync cursor is MAX(asset_events.seq). A drop
 *                              that wrote no event is one Dev & QA were never told about.
 *   integration_outbox         handoff.created. This was in the agreed message list and had
 *                              never been wired: a hand-off the studio believed it had sent
 *                              and the other end had never heard of.
 *
 * AND THE FLAG IS A FLAG. Ticking Needs Tech Art marks the asset and sends nothing. That is
 * asserted directly, because the opposite reading — ticking it sends it — is the one that
 * would be expensive to discover in production.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const catalog = require('../src/permission-catalog');

const cfg = config('sendtodev');
const PASSWORD = 'SendToDev-Test-1!';

test('Send to Dev, and the Tech Art flag', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

  const handoffs = () => sql(cfg,
    'SELECT id, project_id, kind, label, `status`, build, cp_stage, note, created_by_email '
    + 'FROM handoffs ORDER BY created_at');
  const handoffAssets = (handoffId) => sql(cfg,
    'SELECT asset_id, round, bug_refs, `status` FROM handoff_assets WHERE handoff_id = ? ORDER BY id',
    [handoffId]);
  const eventsOf = (assetId) => sql(cfg,
    'SELECT seq, action, from_status, to_status, note, actor_email FROM asset_events '
    + 'WHERE asset_id = ? ORDER BY seq', [assetId]);
  const outboxRows = () => sql(cfg,
    'SELECT id, payload, `status` FROM integration_outbox ORDER BY seq');

  const newAsset = async (name, { status = 'in_progress', project = null } = {}) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
      [id, project || ids.project, `SD-${id.slice(0, 5)}`, name, 'character', status]);
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'sd-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'sd-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    const make = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      token[who] = await login(email);
      return r.body.user.id;
    };
    ids.lead = await make('lead', 'lead@zvky.test', 'team_lead');
    ids.artist = await make('artist', 'artist@zvky.test', 'game_artist');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Shipped Game', clientId: client.body.client.id },
    });
    ids.project = project.body.project.id;
    const other = await as('root', '/projects', {
      method: 'POST', body: { name: 'Other Game', clientId: client.body.client.id },
    });
    ids.otherProject = other.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  // --- the permission gates ------------------------------------------------

  await t.test('the two permissions are the right shape for who needs them', () => {
    /* A lead may send work out; an artist may not. But an artist MAY flag their own work as
       needing a Tech Art pass, because they are the person who knows — which is why these
       are two permissions and not one. */
    const { capabilitiesForTier } = require('../src/role-tiers');
    const lead = catalog.baselineFor(capabilitiesForTier('lead'));
    const contributor = catalog.baselineFor(capabilitiesForTier('contributor'));

    assert.ok(lead.has('integration.send_to_dev'), 'a lead may send');
    assert.ok(!contributor.has('integration.send_to_dev'), 'an artist may not');
    assert.ok(contributor.has('integration.flag_tech_art'), 'but an artist may flag');
    assert.ok(contributor.has('integration.view_ingame'), 'and may see where their work sits');
  });

  await t.test('Send to Dev is refused without integration.send_to_dev', async () => {
    const asset = await newAsset('Gated');
    const r = await as('artist', '/assets/bulk/send-to-dev', {
      method: 'POST', body: { assetIds: [asset], kind: 'partial_drop' },
    });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.deepStrictEqual(await handoffs(), [], 'and nothing was written');
    assert.deepStrictEqual(await outboxRows(), [], 'and nothing was queued');
  });

  await t.test('the Tech Art flag is refused without integration.flag_tech_art', async () => {
    /* Refused for a designation that holds NEITHER integration permission. Granting it is
       what makes it work, which the next test shows — so this fails for the permission
       rather than for anything else about the person. */
    const asset = await newAsset('Also Gated');
    const stripped = await as('root', '/permissions/roles/game_artist');
    const without = stripped.body.role.permissions
      .filter((p) => p.enabled && p.key !== 'integration.flag_tech_art').map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: without } });

    const r = await as('artist', `/assets/${asset}/tech-art`, {
      method: 'PATCH', body: { needsTechArt: true },
    });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    const row = await sql(cfg, 'SELECT needs_tech_art AS f FROM assets WHERE id = ?', [asset]);
    assert.strictEqual(Number(row[0].f), 0, 'and the flag is not set');

    // Put it back for the tests below.
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...without, 'integration.flag_tech_art'] },
    });
  });

  // --- Send to Dev ---------------------------------------------------------

  await t.test('a partial drop records what went, at which round, and what it fixes', async () => {
    const one = await newAsset('Hero Mesh');
    const two = await newAsset('Hero Rig', { status: 'delivered' });

    /* One asset has a submission behind it, so its round is 2 while the other's is 1 — the
       round is READ from the submission count, never invented, and a drop of two assets at
       different rounds has to record each correctly. */
    await sql(cfg,
      'INSERT INTO asset_versions (id, asset_id, version_number, stage, link) VALUES (?,?,?,?,?)',
      [crypto.randomUUID(), two, 1, 'tl', 'https://drive.example/x']);

    const r = await as('lead', '/assets/bulk/send-to-dev', {
      method: 'POST',
      body: {
        assetIds: [one, two], kind: 'partial_drop', label: 'Drop 3',
        build: 'build-1041', cpStage: 'CP2', note: 'the hands are the bit to look at',
        bugRefs: 'QA-1201, QA-1233, QA-1201',
      },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    ids.handoff = r.body.handoffId;
    assert.deepStrictEqual(r.body.bugRefs, ['QA-1201', 'QA-1233'], 'de-duplicated as given');

    const [drop] = await handoffs();
    assert.strictEqual(drop.id, ids.handoff);
    assert.strictEqual(drop.kind, 'partial_drop');
    assert.strictEqual(drop.label, 'Drop 3');
    assert.strictEqual(drop.status, 'queued', 'Dev & QA have not acknowledged it yet');
    assert.strictEqual(drop.build, 'build-1041');
    assert.strictEqual(drop.cp_stage, 'CP2');
    assert.strictEqual(drop.created_by_email, 'lead@zvky.test');
    assert.strictEqual(drop.project_id, ids.project);

    const contents = await handoffAssets(ids.handoff);
    assert.strictEqual(contents.length, 2);
    const byAsset = new Map(contents.map((c) => [c.asset_id, c]));
    assert.strictEqual(Number(byAsset.get(one).round), 1, 'no submissions yet, so round 1');
    assert.strictEqual(Number(byAsset.get(two).round), 2, 'one submission behind it, so round 2');
    assert.strictEqual(byAsset.get(one).bug_refs, 'QA-1201,QA-1233');
    assert.ok(contents.every((c) => c.status === 'queued'));
  });

  await t.test('and every asset in it is visible to the sync cursor', async () => {
    /* THE READER THAT WOULD OTHERWISE BE BLIND. Dev & QA poll
       GET /projects/:id/assets?updated_since=<seq>, driven by MAX(asset_events.seq). A drop
       that wrote no event is a drop they were never told about. */
    const contents = await handoffAssets(ids.handoff);
    for (const c of contents) {
      const events = await eventsOf(c.asset_id);
      const sent = events.filter((e) => e.action === 'sent_to_dev');
      assert.strictEqual(sent.length, 1, `${c.asset_id} has exactly one sent_to_dev event`);
      assert.strictEqual(sent[0].from_status, sent[0].to_status,
        'the stage does not change — sending is not a transition');
      assert.match(sent[0].note, /Partial drop/);
      assert.match(sent[0].note, /QA-1201/, 'and the bugs it claims to fix are in the trail');
      assert.strictEqual(sent[0].actor_email, 'lead@zvky.test');
      assert.ok(Number(sent[0].seq) > 0);
    }
  });

  await t.test('handoff.created lands in the outbox, in the same transaction', async () => {
    // Wired here for the first time: it was in the agreed message list and nothing produced
    // it, so a hand-off the studio believed it had sent was one the other end never heard of.
    const rows = await outboxRows();
    assert.strictEqual(rows.length, 1, 'one message for the drop, not one per asset');
    const payload = JSON.parse(rows[0].payload);
    assert.strictEqual(payload.event, 'handoff.created');
    assert.strictEqual(payload.handoffId, ids.handoff);
    assert.strictEqual(payload.kind, 'partial_drop');
    assert.strictEqual(payload.build, 'build-1041');
    assert.deepStrictEqual(payload.bugRefs, ['QA-1201', 'QA-1233']);
    assert.strictEqual(payload.assets.length, 2);
    assert.ok(payload.assets.every((a) => a.code && a.round));
    assert.strictEqual(payload.sentBy, 'lead@zvky.test');
    assert.strictEqual(rows[0].status, 'pending', 'queued, not delivered by the request');
  });

  await t.test('a Tech Art hand-off is the same mechanism, said differently', async () => {
    const asset = await newAsset('Needs Rigging Help');
    const r = await as('lead', '/assets/bulk/send-to-dev', {
      method: 'POST', body: { assetIds: [asset], kind: 'tech_art', note: 'skinning falls apart at the elbow' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const drop = (await handoffs()).find((h) => h.id === r.body.handoffId);
    assert.strictEqual(drop.kind, 'tech_art');
    const events = await eventsOf(asset);
    assert.match(events.find((e) => e.action === 'sent_to_dev').note, /Tech Art hand-off/);
    const payload = JSON.parse((await outboxRows()).find((x) => JSON.parse(x.payload).handoffId === r.body.handoffId).payload);
    assert.strictEqual(payload.kind, 'tech_art');
  });

  await t.test('half-finished work is the normal case, not an error', async () => {
    // A partial drop is partial. Any stage may go in one — that is the whole point of the
    // word, and a status allowlist here would refuse the commonest use.
    for (const status of ['not_started', 'assigned', 'in_progress', 'pending_tl_review',
      'tl_changes_requested', 'approved_for_client', 'delivered']) {
      const asset = await newAsset(`Stage ${status}`, { status });
      const r = await as('lead', '/assets/bulk/send-to-dev', {
        method: 'POST', body: { assetIds: [asset], kind: 'partial_drop' },
      });
      assert.strictEqual(r.status, 201, `${status}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.results[0].outcome, 'sent');
    }
  });

  await t.test('a mixed-project selection is refused before anything is written', async () => {
    /* A drop is integrated into one build of one game, so a mixed selection would produce a
       hand-off whose project is a guess. */
    const mine = await newAsset('Ours');
    const theirs = await newAsset('Theirs', { project: ids.otherProject });
    const before = (await handoffs()).length;

    const r = await as('lead', '/assets/bulk/send-to-dev', {
      method: 'POST', body: { assetIds: [mine, theirs] },
    });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.field, 'assetIds');
    assert.strictEqual(r.body.projects, 2);
    assert.strictEqual((await handoffs()).length, before, 'and no partial hand-off was left behind');
  });

  await t.test('an empty selection, and one that names nothing real', async () => {
    const empty = await as('lead', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [] } });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.body.field, 'assetIds');

    const ghost = await as('lead', '/assets/bulk/send-to-dev', {
      method: 'POST', body: { assetIds: [crypto.randomUUID()] },
    });
    assert.strictEqual(ghost.status, 404, JSON.stringify(ghost.body));
  });

  await t.test('a closed project refuses the whole drop', async () => {
    const asset = await newAsset('On Ice', { project: ids.otherProject });
    await sql(cfg, 'UPDATE projects SET closed_at = NOW() WHERE id = ?', [ids.otherProject]);
    const before = (await handoffs()).length;
    const r = await as('lead', '/assets/bulk/send-to-dev', {
      method: 'POST', body: { assetIds: [asset] },
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.projectClosed, true);
    assert.strictEqual((await handoffs()).length, before);
    await sql(cfg, 'UPDATE projects SET closed_at = NULL WHERE id = ?', [ids.otherProject]);
  });

  // --- the Tech Art flag ---------------------------------------------------

  await t.test('THE FLAG IS A FLAG: ticking it sends nothing', async () => {
    /* The reading this rules out — ticking it hands the asset to Dev & QA — is the one that
       would be expensive to discover in production, so it is asserted rather than assumed.
       Nothing is queued, no hand-off exists, and the asset does not move. */
    const asset = await newAsset('Rig Me', { status: 'in_progress' });
    const handoffsBefore = (await handoffs()).length;
    const outboxBefore = (await outboxRows()).length;

    const r = await as('artist', `/assets/${asset}/tech-art`, {
      method: 'PATCH', body: { needsTechArt: true },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.asset.needsTechArt, true);
    assert.strictEqual(r.body.changed, true);

    const row = await sql(cfg, 'SELECT needs_tech_art AS f, `status` AS s FROM assets WHERE id = ?', [asset]);
    assert.strictEqual(Number(row[0].f), 1, 'the asset is marked');
    assert.strictEqual(row[0].s, 'in_progress', 'and has not moved');
    assert.strictEqual((await handoffs()).length, handoffsBefore, 'NO hand-off was created');
    assert.strictEqual((await outboxRows()).length, outboxBefore, 'and NOTHING was queued for Dev & QA');
    assert.deepStrictEqual((await eventsOf(asset)).map((e) => e.action), [],
      'it is not a pipeline event either — it is a property of the asset');
  });

  await t.test('and it can be taken off again, idempotently', async () => {
    const asset = await newAsset('Flip Me');
    await as('artist', `/assets/${asset}/tech-art`, { method: 'PATCH', body: { needsTechArt: true } });

    const again = await as('artist', `/assets/${asset}/tech-art`, {
      method: 'PATCH', body: { needsTechArt: true },
    });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.changed, false, 'setting it twice is not a change');

    const off = await as('artist', `/assets/${asset}/tech-art`, {
      method: 'PATCH', body: { needsTechArt: false },
    });
    assert.strictEqual(off.body.asset.needsTechArt, false);
    assert.strictEqual(off.body.changed, true);
    const row = await sql(cfg, 'SELECT needs_tech_art AS f FROM assets WHERE id = ?', [asset]);
    assert.strictEqual(Number(row[0].f), 0);
  });

  await t.test('the flag needs a boolean, not a truthy anything', async () => {
    const asset = await newAsset('Strict');
    for (const bad of ['yes', 1, null]) {
      const r = await as('artist', `/assets/${asset}/tech-art`, {
        method: 'PATCH', body: { needsTechArt: bad },
      });
      assert.strictEqual(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'needsTechArt');
    }
  });

  await t.test('a flagged asset can then be found and sent, which is the whole workflow',
    async () => {
      // Flag, then send — the two halves, in the order somebody would actually use them.
      const asset = await newAsset('End To End');
      await as('artist', `/assets/${asset}/tech-art`, { method: 'PATCH', body: { needsTechArt: true } });

      /* Read with studio-wide scope, because what is under test is that the flag TRAVELS on
         the list — not project scoping, which would otherwise decide the answer here and
         make the assertion about something else. */
      const listed = await as('root', `/assets/project/${ids.project}`);
      assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
      const seen = listed.body.assets.find((a) => a.id === asset);
      assert.ok(seen, 'the list carries it');
      assert.ok(Number(seen.needs_tech_art) === 1, 'with the flag, so a filter can find it');

      const sent = await as('lead', '/assets/bulk/send-to-dev', {
        method: 'POST', body: { assetIds: [asset], kind: 'tech_art' },
      });
      assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
      assert.strictEqual(sent.body.results[0].outcome, 'sent');
    });

  await t.test('both actions are in the activity log, through the middleware', async () => {
    /* NEITHER ROUTE RECORDS BY HAND. The activityLogger mounted on /api records every
       mutation that answers under 400, which is this application's coverage guarantee, and
       routes/assets.js records nothing explicitly for exactly that reason. So what this
       asserts is that these two are covered BY THAT — an explicit call would have been a
       second entry for one action and a second place for the wording to drift. */
    const rows = await sql(cfg,
      "SELECT action, entity_type, summary FROM activity_log WHERE module = 'assets' ORDER BY seq");
    const summaries = rows.map((r) => `${r.action} ${r.summary || ''}`).join(' | ');
    assert.ok(/send-to-dev|send_to_dev/i.test(summaries),
      `the drop is in the log: ${summaries.slice(0, 400)}`);
    assert.ok(/tech-art|tech_art/i.test(summaries),
      `and so is the flag: ${summaries.slice(0, 400)}`);
  });
});
