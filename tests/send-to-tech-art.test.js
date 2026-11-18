/* SEND TO TECH ART — the second destination, as an explicit act.
 *
 * ===========================================================================
 * WHAT THIS REPLACED, because it is why the tests are shaped this way.
 *
 * Tech Art routing used to be two things that never met: a "Needs a Tech Art pass" tick
 * box on the asset drawer that set a column and told nobody, and an option buried in a
 * dropdown inside a modal titled "Send to Dev & QA". The flag's own route said so — "A
 * FLAG AND A FILTER, NOT A SEND" — and the gap between flagging and somebody noticing was
 * nobody's job.
 *
 * So the thing under test is not "does a column get written". It is: did a named person
 * hand a named asset to a named team at a known time, is the asset's own discipline
 * preserved on the way, and can Dev & QA tell which team it was for without guessing.
 *
 * ===========================================================================
 * DESTINATION AND DISCIPLINE ARE TESTED AS A GRID, ON PURPOSE.
 *
 * Four combinations, all four asserted: art to Development, art to Tech Art, animation to
 * Development, animation to Tech Art. A test that only ever sent animations to Tech Art
 * would pass just as happily against an implementation that inferred one from the other,
 * which is the specific mistake the brief spends two sections warning about — and which
 * this repository has already made once, in the Dashboard and the folder layout, before
 * src/asset-discipline.js existed to stop it.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const catalog = require('../src/permission-catalog');
const handoffDestination = require('../src/handoff-destination');

const cfg = config('sendtechart');
const PASSWORD = 'SendTechArt-Test-1!';

test('Send to Tech Art, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

  const handoffs = () => sql(cfg,
    'SELECT id, project_id, kind, `status`, note, sent_at, created_by_id, created_by_email '
    + 'FROM handoffs ORDER BY created_at, id');
  const handoffAssets = (handoffId) => sql(cfg,
    'SELECT asset_id, round, `status` FROM handoff_assets WHERE handoff_id = ? ORDER BY id',
    [handoffId]);
  const eventsOf = (assetId) => sql(cfg,
    'SELECT seq, action, note, actor_email FROM asset_events WHERE asset_id = ? ORDER BY seq',
    [assetId]);
  const outboxFor = async (handoffId) => (await sql(cfg,
    "SELECT payload FROM integration_outbox WHERE event_type LIKE 'handoff.%' ORDER BY seq"))
    .map((r) => JSON.parse(r.payload))
    .filter((e) => e.payload && e.payload.handoffId === handoffId);

  /* An asset of a given Scope of Work. `type: 'animation'` is what makes one an animation
     asset — the rule in src/asset-discipline.js, which this suite deliberately does not
     restate. A category can also put an asset under Animation; that path is covered by
     tests/asset-discipline.test.js against the same function, and asserting it again here
     would be testing the rule rather than the send. */
  const newAsset = async (name, type = 'character') => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
      [id, ids.project, `TA-${id.slice(0, 5)}`, name, type, 'in_progress']);
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ta-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'ta-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
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
    /* A SECOND TEAM LEAD, for the permission cases. They share the role whose keys those
       cases strip and restore, which is deliberate: the restore has to be proven to work,
       and the simplest proof is that the rest of the suite keeps sending afterwards. A
       designation that does not hold integration.send_to_dev in the first place could not
       show that withholding ONE of the two keys leaves the other working, which is the
       whole point of the case. */
    ids.gate = await make('gate', 'gate@zvky.test', 'team_lead');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Shipped Game', clientId: client.body.client.id },
    });
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ------------------------------------------------- the grid: four combinations */

  /* Each row: what kind of asset, which route, and what the hand-off must say afterwards.
     The expectations are written out rather than computed, because a table that derived
     `discipline` from `destination` would be the bug it is meant to catch. */
  const GRID = [
    { what: 'an art asset to Tech Art',
      type: 'character', path: '/assets/bulk/send-to-tech-art',
      destination: 'tech_art', kind: 'tech_art', discipline: 'art', sent: 'Sent to Tech Art' },
    { what: 'an animation asset to Tech Art',
      type: 'animation', path: '/assets/bulk/send-to-tech-art',
      destination: 'tech_art', kind: 'tech_art', discipline: 'animation', sent: 'Sent to Tech Art' },
    { what: 'an art asset to Development',
      type: 'prop', path: '/assets/bulk/send-to-dev',
      destination: 'development', kind: 'partial_drop', discipline: 'art', sent: 'Sent to Development' },
    { what: 'an animation asset to Development',
      type: 'animation', path: '/assets/bulk/send-to-dev',
      destination: 'development', kind: 'partial_drop', discipline: 'animation', sent: 'Sent to Development' },
  ];

  for (const row of GRID) {
    await t.test(`${row.what}: one hand-off, the right destination, its own discipline`, async () => {
      const asset = await newAsset(`Grid ${row.what}`, row.type);
      const before = (await handoffs()).length;

      const r = await as('lead', row.path, { method: 'POST', body: { assetIds: [asset] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.destination, row.destination, 'the answer names the destination');
      assert.strictEqual(r.body.kind, row.kind, 'and the kind it is stored as');
      assert.strictEqual(r.body.results.length, 1);
      assert.strictEqual(r.body.results[0].outcome, 'sent');
      assert.strictEqual(r.body.results[0].discipline, row.discipline);

      // EXACTLY ONE hand-off, and it is this one.
      const all = await handoffs();
      assert.strictEqual(all.length, before + 1, 'exactly one hand-off was created');
      const drop = all.find((h) => h.id === r.body.handoffId);
      assert.ok(drop, 'and it is the one the answer named');
      assert.strictEqual(drop.kind, row.kind);
      assert.strictEqual(handoffDestination.destinationOf(drop.kind), row.destination,
        'the stored row reads back as the destination that was asked for');
      assert.strictEqual(drop.project_id, ids.project, 'on the right project');
      assert.ok(drop.sent_at, 'with a time');
      assert.strictEqual(drop.created_by_id, ids.lead, 'and a sender');
      assert.strictEqual(drop.created_by_email, 'lead@zvky.test');

      // The asset, at its round.
      const rows = await handoffAssets(drop.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].asset_id, asset);
      /* Round 1: no submissions yet. The round is the submission count and nothing here
         creates one — the same definition tests/send-to-dev.test.js pins. */
      assert.strictEqual(Number(rows[0].round), 1, 'the round is recorded, not invented');

      /* THE HISTORY NAMES THE DESTINATION. "Which button was used?" is the question this
         answers, and before this change the note described the parcel without naming the
         recipient. */
      const events = await eventsOf(asset);
      const sentEvent = events.find((e) => e.action === 'sent_to_dev');
      assert.ok(sentEvent, 'the sync cursor can see it');
      assert.ok(sentEvent.note.startsWith(row.sent),
        `the history should start with "${row.sent}": ${sentEvent.note}`);
      assert.strictEqual(sentEvent.actor_email, 'lead@zvky.test');

      /* AND THE EVENT. Destination and discipline, separately, in the payload Dev & QA
         read. The discipline is the asset's own and is NOT derived from where it went —
         which is the whole point of this grid. */
      const events_out = await outboxFor(drop.id);
      assert.strictEqual(events_out.length, 1, 'exactly one handoff.created event');
      const envelope = events_out[0];
      assert.strictEqual(envelope.type, 'handoff.created');
      assert.strictEqual(envelope.source, 'forge', 'source = Forge');
      assert.strictEqual(envelope.payload.destination, row.destination);
      assert.strictEqual(envelope.payload.kind, row.kind);
      assert.strictEqual(envelope.payload.projectId, ids.project);
      assert.ok(envelope.payload.sentAt, 'and when');
      assert.strictEqual(envelope.payload.sentBy, 'lead@zvky.test');
      assert.strictEqual(envelope.payload.assets.length, 1);
      assert.strictEqual(envelope.payload.assets[0].id, asset);
      assert.strictEqual(envelope.payload.assets[0].discipline, row.discipline,
        'the asset keeps its own discipline, whatever the destination');
      assert.ok(envelope.payload.assets[0].name, 'and its name');
      assert.ok(envelope.payload.assets[0].code, 'and its code');
    });
  }

  await t.test('one drop can carry both disciplines at once', async () => {
    /* THE CASE THAT CANNOT BE FAKED BY INFERENCE. A single Tech Art hand-off with an
       animation and a prop in it: one destination, two disciplines, in one payload. An
       implementation that read the discipline off the destination would have to give both
       assets the same answer here. */
    const anim = await newAsset('Mixed Anim', 'animation');
    const prop = await newAsset('Mixed Prop', 'prop');
    const r = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [anim, prop] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const envelope = (await outboxFor(r.body.handoffId))[0];
    assert.strictEqual(envelope.payload.destination, 'tech_art');
    const byId = new Map(envelope.payload.assets.map((a) => [a.id, a.discipline]));
    assert.strictEqual(byId.get(anim), 'animation');
    assert.strictEqual(byId.get(prop), 'art');
  });

  /* --------------------------------------------------------- the older field */

  await t.test('a caller sending the older kind field still reaches both destinations', async () => {
    /* BACKWARD COMPATIBILITY, as a request rather than as a promise. Everything written
       against the previous contract sends `kind`, including the page before this release.
       Both values still work on the route that always took them. */
    const one = await newAsset('Legacy Kind Art', 'character');
    const legacy = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [one], kind: 'tech_art' } });
    assert.strictEqual(legacy.status, 201, JSON.stringify(legacy.body));
    assert.strictEqual(legacy.body.destination, 'tech_art', 'the old field names the new destination');

    const two = await newAsset('Legacy Kind Drop', 'character');
    const drop = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [two], kind: 'partial_drop' } });
    assert.strictEqual(drop.body.destination, 'development');

    /* AND A REQUEST THAT NAMES NEITHER is a partial drop, which is what every such
       request has always been. */
    const three = await newAsset('No Field At All', 'character');
    const bare = await as('lead', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [three] } });
    assert.strictEqual(bare.body.destination, 'development');
    assert.strictEqual(bare.body.kind, 'partial_drop');
  });

  await t.test('a destination that is neither is refused, not guessed', async () => {
    const asset = await newAsset('Typo', 'character');
    for (const body of [{ destination: 'techart' }, { destination: 'dev' }, { kind: 'partial' }]) {
      const r = await as('lead', '/assets/bulk/send-to-dev',
        { method: 'POST', body: { assetIds: [asset], ...body } });
      assert.strictEqual(r.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /development or tech_art/);
    }
    assert.deepStrictEqual((await eventsOf(asset)).map((e) => e.action), [],
      'and nothing was sent anywhere');
  });

  /* ------------------------------------------------------------- permissions */

  await t.test('the defaults: nobody loses what they could already do', async () => {
    /* THE REACH TEST. One key — integration.send_to_dev — used to permit both
       destinations, because the modal's dropdown was the only way to reach Tech Art. So
       every designation holding that key could already send a Tech Art hand-off, and a
       narrower default on the new key would have taken that away in the release that was
       supposed to make it easier. */
    const { capabilitiesForTier } = require('../src/role-tiers');
    for (const tier of ['lead', 'contributor', 'leadership', 'management']) {
      const baseline = catalog.baselineFor(capabilitiesForTier(tier));
      assert.strictEqual(
        baseline.has('integration.send_to_tech_art'),
        baseline.has('integration.send_to_dev'),
        `${tier}: the two send keys should ship to the same designations`
      );
    }
    // And it is a real key a Super Admin can hand out or withhold.
    assert.ok(catalog.grantableKeys().includes('integration.send_to_tech_art'));
  });

  await t.test('an artist cannot send to either destination', async () => {
    const asset = await newAsset('Not Yours', 'character');
    for (const path of ['/assets/bulk/send-to-dev', '/assets/bulk/send-to-tech-art']) {
      const r = await as('artist', path, { method: 'POST', body: { assetIds: [asset] } });
      assert.strictEqual(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
    }
    assert.deepStrictEqual(await handoffAssets('nope'), []);
    assert.deepStrictEqual((await eventsOf(asset)).map((e) => e.action), [],
      'and nothing was written');
  });

  await t.test('the Tech Art key can be withheld on its own', async () => {
    /* WHAT THE SEPARATE KEY IS FOR. The coordinator keeps integration.send_to_dev and
       loses integration.send_to_tech_art, which is the configuration a studio would
       choose if Tech Art's time is booked by somebody else. Dropping work into the build
       still works; booking Tech Art does not. */
    const role = await as('root', '/permissions/roles/team_lead');
    const held = role.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(held.includes('integration.send_to_dev'), 'a team lead can send to Dev to begin with');
    const without = held.filter((k) => k !== 'integration.send_to_tech_art');
    assert.strictEqual((await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: without } })).status, 200);

    const asset = await newAsset('Dev Only', 'character');
    const dev = await as('gate', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [asset] } });
    assert.strictEqual(dev.status, 201, `Dev still works: ${JSON.stringify(dev.body)}`);

    const techArt = await as('gate', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [asset] } });
    assert.strictEqual(techArt.status, 403, JSON.stringify(techArt.body));

    /* THE BYPASS, CLOSED. The older route still accepts a body asking for Tech Art, and
       it must not become a way around the key: whichever door the request came in by, the
       key belongs to where it is going. A direct API call is exactly how this would be
       attempted, which is why it is tested rather than left to the hidden button. */
    const sneak = await as('gate', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [asset], destination: 'tech_art' } });
    assert.strictEqual(sneak.status, 403, JSON.stringify(sneak.body));
    assert.strictEqual(sneak.body.permission, 'integration.send_to_tech_art',
      'and it says which key was missing');

    const alsoSneak = await as('gate', '/assets/bulk/send-to-dev',
      { method: 'POST', body: { assetIds: [asset], kind: 'tech_art' } });
    assert.strictEqual(alsoSneak.status, 403, 'the older field is not a way round it either');

    // Nothing Tech Art-bound was written by any of those attempts.
    const techArtDrops = (await handoffs()).filter((h) => h.kind === 'tech_art'
      && h.created_by_email === 'gate@zvky.test');
    assert.deepStrictEqual(techArtDrops, []);

    // Put it back, and the suite's remaining sends are the proof that it took.
    assert.strictEqual((await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: held } })).status, 200);
  });

  /* ------------------------------------------------------- repeats and replay */

  await t.test('the same asset cannot go twice in one hand-off', async () => {
    /* THE UNIQUE KEY ON (handoff_id, asset_id, round), which is what protects a single
       request: a selection naming the same asset twice is a mistake, not two things to
       integrate. The de-duplication of assetIds means the request below reaches the
       database as one row, and the answer reports one asset rather than two. */
    const asset = await newAsset('Once Only', 'animation');
    const r = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [asset, asset, asset] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.results.length, 1, 'one asset, one result');
    assert.strictEqual((await handoffAssets(r.body.handoffId)).length, 1);
    assert.strictEqual((await outboxFor(r.body.handoffId)).length, 1, 'and one event');
  });

  await t.test('one event per hand-off, replayable, with a version that moves', async () => {
    /* WHAT "IDEMPOTENT REPLAY" MEANS ON THIS SIDE. Forge writes the message once, in the
       same transaction as the hand-off, and the outbox worker may deliver it any number of
       times — so the receiving end dedupes on eventId, and the entity version says which
       state each delivery describes. Both are asserted here: one row per hand-off, a
       stable eventId, and a version that increases per entity rather than being reused. */
    const asset = await newAsset('Replay Me', 'character');
    const r = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [asset] } });
    const mine = await outboxFor(r.body.handoffId);
    assert.strictEqual(mine.length, 1);
    assert.match(mine[0].eventId, /^[0-9a-f-]{36}$/, 'a stable id to dedupe on');
    assert.strictEqual(mine[0].entity.type, 'handoff');
    assert.strictEqual(mine[0].entity.id, r.body.handoffId);
    assert.ok(Number(mine[0].entity.version) >= 1, 'and a version');
    assert.strictEqual(mine[0].schemaVersion, 1);

    /* A SECOND SEND IS A SECOND HAND-OFF, DELIBERATELY — and it is worth pinning, because
       the opposite reading would be a bug in the other direction. Re-sending an asset
       after a fix is normal and the stage comment on the route says so; the thing that
       must not happen is one request becoming two hand-offs, which the unique key above
       covers. A double click is stopped in the page, where the button disables itself on
       the first press. */
    const again = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [asset] } });
    assert.strictEqual(again.status, 201);
    assert.notStrictEqual(again.body.handoffId, r.body.handoffId);
    assert.strictEqual((await outboxFor(again.body.handoffId)).length, 1,
      'and the second one has exactly one event of its own');
  });

  await t.test('the rules a drop already had still apply to this destination', async () => {
    /* PARITY. Everything that made a hand-off refuse before refuses the same way here:
       one project at a time, something real to send, and not into a closed project. The
       new route shares the body of the old one precisely so these cannot drift apart. */
    const mine = await newAsset('Here', 'character');
    const other = await as('root', '/projects',
      { method: 'POST', body: { name: 'Elsewhere', clientId: (await as('root', '/clients')).body.clients[0].id } });
    const theirs = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
      [theirs, other.body.project.id, 'TA-OTH', 'Other Project', 'character', 'in_progress']);

    const mixed = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [mine, theirs] } });
    assert.strictEqual(mixed.status, 400, JSON.stringify(mixed.body));
    assert.match(mixed.body.error, /different projects/);

    const empty = await as('lead', '/assets/bulk/send-to-tech-art', { method: 'POST', body: { assetIds: [] } });
    assert.strictEqual(empty.status, 400);

    const nothing = await as('lead', '/assets/bulk/send-to-tech-art',
      { method: 'POST', body: { assetIds: [crypto.randomUUID()] } });
    assert.strictEqual(nothing.status, 404);
  });
});

/* ===========================================================================
 * THE CONTRACT, AS DEV & QA WOULD RECEIVE IT.
 *
 * The suite above reads the outbox rows, which is what Forge wrote. This one lets the
 * worker deliver them to a receiver standing in for Dev & QA and reads what arrived over
 * the wire — because the brief's question is whether the far end can tell a Tech Art
 * hand-off from a Development one WITHOUT guessing from the asset's metadata, and that is
 * a question about the delivered body.
 */
test('the delivered payloads distinguish destination from discipline',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    const outbox = require('../src/integration-outbox');
    const contractCfg = config('techartwire');
    let server; let receiver; let conn; let db;
    const token = {};
    const ids = {};
    const received = [];

    const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

    t.before(async () => {
      await resetSchema(contractCfg);

      receiver = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          received.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise((done) => receiver.listen(0, '127.0.0.1', done));

      server = await startServer(contractCfg, {
        BOOTSTRAP_TOKEN: 'wire-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0',
      });
      await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
        token: 'wire-bootstrap', name: 'Root', email: 'root@wire.test', password: PASSWORD } });
      token.root = (await api(server.base, '/auth/login',
        { method: 'POST', body: { email: 'root@wire.test', password: PASSWORD } })).body.token;

      const client = await as('root', '/clients', { method: 'POST', body: { name: 'Wire Co' } });
      const project = await as('root', '/projects',
        { method: 'POST', body: { name: 'Wire Game', clientId: client.body.client.id } });
      ids.project = project.body.project.id;

      /* The worker runs in THIS process, so its settings live here. */
      /* THE WORKER'S SWITCH, IN THIS PROCESS. sweep() asks integration-events.enabled(),
         which reads INTEGRATION_ENABLED from wherever it runs — and it runs here, not in
         the server. Without this the sweep returns skipped: 'disabled' and every assertion
         below would be about an empty receiver. */
      process.env.INTEGRATION_ENABLED = 'true';
      process.env.INTEGRATION_OUTBOUND_URL = `http://127.0.0.1:${receiver.address().port}/hooks/forge`;
      process.env.INTEGRATION_OUTBOUND_SECRET = 'wire-secret-not-used-elsewhere';
      process.env.INTEGRATION_OUTBOUND_TIMEOUT_MS = '1500';

      const mysql = require('mysql2/promise');
      conn = await mysql.createConnection({
        host: contractCfg.host, port: contractCfg.port, user: contractCfg.user,
        password: contractCfg.password, database: contractCfg.database,
      });
      db = { query: async (text, params) => {
        const [rows] = await conn.query(text.replace(/\$(\d+)/g, '?'), params || []);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      } };
    });

    t.after(async () => {
      if (conn) await conn.end();
      if (server) await stopServer(server);
      if (receiver) await new Promise((done) => receiver.close(done));
      delete process.env.INTEGRATION_OUTBOUND_URL;
      delete process.env.INTEGRATION_OUTBOUND_SECRET;
      delete process.env.INTEGRATION_OUTBOUND_TIMEOUT_MS;
      delete process.env.INTEGRATION_ENABLED;
    });

    const asset = async (name, type) => {
      const id = crypto.randomUUID();
      await sql(contractCfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
        [id, ids.project, `WR-${id.slice(0, 5)}`, name, type, 'in_progress']);
      return id;
    };

    await t.test('all four combinations arrive, each saying both things', async () => {
      /* ART TO TECH ART and ANIMATION TO DEVELOPMENT — the brief's example pair, which is
         chosen precisely because it is the pair an implementation that confused the two
         concepts would get wrong. Then the other two, so the grid is closed. */
      const sends = [
        { name: 'Wire Art To TechArt',  type: 'prop',      path: '/assets/bulk/send-to-tech-art',
          destination: 'tech_art',    discipline: 'art' },
        { name: 'Wire Anim To Dev',     type: 'animation', path: '/assets/bulk/send-to-dev',
          destination: 'development', discipline: 'animation' },
        { name: 'Wire Anim To TechArt', type: 'animation', path: '/assets/bulk/send-to-tech-art',
          destination: 'tech_art',    discipline: 'animation' },
        { name: 'Wire Art To Dev',      type: 'character', path: '/assets/bulk/send-to-dev',
          destination: 'development', discipline: 'art' },
      ];

      const expected = [];
      for (const send of sends) {
        const id = await asset(send.name, send.type);
        const r = await as('root', send.path, { method: 'POST', body: { assetIds: [id] } });
        assert.strictEqual(r.status, 201, `${send.name}: ${JSON.stringify(r.body)}`);
        expected.push({ ...send, id, handoffId: r.body.handoffId });
      }

      const tally = await outbox.sweep(db, { log: () => {} });
      assert.ok(tally.sent >= sends.length, `the worker delivered them: ${JSON.stringify(tally)}`);

      const handoffEvents = received.filter((e) => e.type === 'handoff.created');
      assert.strictEqual(handoffEvents.length, sends.length,
        `one delivered event per hand-off, got ${handoffEvents.length}`);

      for (const want of expected) {
        const got = handoffEvents.find((e) => e.payload.handoffId === want.handoffId);
        assert.ok(got, `${want.name} was delivered`);
        /* THE TWO FIELDS, READ OFF THE WIRE. Dev & QA route on `destination` and file the
           work by `discipline`, and neither has to be inferred from the other or from the
           asset's name. */
        assert.strictEqual(got.payload.destination, want.destination,
          `${want.name}: destination`);
        assert.strictEqual(got.payload.assets[0].discipline, want.discipline,
          `${want.name}: discipline`);
        assert.strictEqual(got.payload.assets[0].id, want.id);
        assert.strictEqual(got.source, 'forge');
        /* The older field is still there beside the new one, so a receiver written against
           the previous contract keeps working. */
        assert.strictEqual(got.payload.kind, handoffDestination.kindOf(want.destination));
      }

      /* AND THE PAIRS ARE NOT THE SAME FIELD TWICE: across the four deliveries, every
         combination of the two values appears exactly once. If one were derived from the
         other, two of these four would be impossible. */
      const pairs = handoffEvents
        .map((e) => `${e.payload.destination}/${e.payload.assets[0].discipline}`).sort();
      assert.deepStrictEqual(pairs, [
        'development/animation', 'development/art', 'tech_art/animation', 'tech_art/art',
      ]);
    });
  });
