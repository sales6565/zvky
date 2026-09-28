/* The v1 surface: what Dev & QA can read, and the two writes it can make.
 *
 * Every route here is behind the same four locks as everything else on this path, so
 * what these tests are about is the ROUTES — what they return, and the two
 * business-level guards that are not the generic idempotency-key replay and must not
 * be mistaken for it:
 *
 *   ACKING A HAND-OFF TWICE. withIdempotency handles a repeated CALL (same key,
 *   replayed). This handles a repeated FACT: a second ack with a FRESH key, from a
 *   caller that lost its bookkeeping. Same build is 200 and idempotent; a different
 *   build is 409, because one drop cannot have landed in two builds.
 *
 *   A STALE IN-GAME REPORT. Reports arrive out of order because the sender retries, so
 *   a write is conditional on the stored sequence. An older one answers 200
 *   { applied: false } and changes nothing — not 4xx, because the caller did nothing
 *   wrong and a retrying client would treat a 4xx as a failure to fix.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');
const { UPLOAD_DIR } = require('../src/upload');

const cfg = config('integrationv1');
const SECRET = 'inbound-secret-for-the-test-suite-only';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Everything the six endpoints need between them.
const FULL = 'projects,assets,files,handoffs,counter,ping';

test('the v1 surface', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEY = 'v1-full-key-0123456789abcd';
  const NARROW = 'v1-narrow-key-0123456789ab';   // assets only
  const ids = {};
  const stored = [];   // files written into UPLOAD_DIR, removed afterwards

  const call = async (p, {
    method = 'GET', body = null, key = KEY, idem = crypto.randomUUID(), rawOut = false,
  } = {}) => {
    const raw = body === null ? '' : JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000);
    const target = `/api${p}`;
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.${method.toUpperCase()}.${target}.${raw}`).digest('hex');
    const headers = {
      'X-Integration-Key': key,
      'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
    };
    if (raw) headers['Content-Type'] = 'application/json';
    if (idem) headers['Idempotency-Key'] = idem;
    const res = await fetch(`${server.base}${p}`, { method, headers, body: raw || undefined });
    if (rawOut) return res;
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      INTEGRATION_INBOUND_SECRET: SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });

    const add = (name, k, actions) => sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      [name, sha256(k), k.slice(0, 8), actions]);
    await add('Dev and QA', KEY, FULL);
    await add('Assets Only Tool', NARROW, 'assets');

    ids.owner = crypto.randomUUID();
    ids.client = crypto.randomUUID();
    ids.project = crypto.randomUUID();
    ids.otherProject = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO users (id, name, email, password_hash, `role`) VALUES (?,?,?,?,?)',
      [ids.owner, 'V1 Owner', 'v1owner@zvky.test', 'x', 'super_admin']);
    await sql(cfg, 'INSERT INTO clients (id, name) VALUES (?, ?)', [ids.client, 'Ubisoft Pune']);
    await sql(cfg, 'INSERT INTO projects (id, client_id, owner_id, name) VALUES (?,?,?,?)',
      [ids.project, ids.client, ids.owner, 'Shadow Realm']);
    await sql(cfg, 'INSERT INTO projects (id, client_id, owner_id, name) VALUES (?,?,?,?)',
      [ids.otherProject, ids.client, ids.owner, 'Somebody Else\'s Project']);

    /* Six assets, each given a different number of events so the change markers are
       distinct and a cursor walk is observable. One is left with NO events, which is
       the case creating an asset actually produces. */
    ids.assets = [];
    for (let i = 1; i <= 6; i += 1) {
      const id = crypto.randomUUID();
      ids.assets.push(id);
      await sql(cfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status, needs_tech_art) '
        + 'VALUES (?,?,?,?,?,?,?)',
        [id, ids.project, `SR-00${i}`, `Asset ${i}`, 'character', 'in_progress', i === 2 ? 1 : 0]);
      if (i > 1) {
        await sql(cfg,
          'INSERT INTO asset_events (id, asset_id, action, from_status, to_status, note) '
          + 'VALUES (UUID(), ?, ?, ?, ?, ?)',
          [id, 'submit', 'in_progress', 'pending_tl_review', `round for asset ${i}`]);
      }
    }
    ids.noEvents = ids.assets[0];
    ids.asset = ids.assets[1];

    // A submission with a real file on disk, and one that is a link only.
    ids.fileVersion = crypto.randomUUID();
    ids.linkVersion = crypto.randomUUID();
    const onDisk = `v1-test-${crypto.randomUUID()}.txt`;
    fs.writeFileSync(path.join(UPLOAD_DIR, onDisk), 'the delivered mesh, allegedly');
    stored.push(onDisk);
    await sql(cfg,
      'INSERT INTO asset_versions (id, asset_id, version_number, stage, file_path, file_name, description) '
      + 'VALUES (?,?,?,?,?,?,?)',
      [ids.fileVersion, ids.asset, 1, 'tl', onDisk, 'hero_mesh_v1.fbx', 'first pass']);
    await sql(cfg,
      'INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description) '
      + 'VALUES (?,?,?,?,?,?)',
      [ids.linkVersion, ids.asset, 2, 'tl', 'https://drive.example/x', 'second pass, a link']);

    /* A row whose stored path climbs out of the uploads directory, AT A FILE THAT REALLY
       EXISTS. The first version of this pointed at ../../etc/passwd, which resolves to
       somewhere that does not exist — so the 404 came from the existence check and the
       test passed without either guard doing anything. ../package.json is one level up
       from uploads/ and is certainly there, so a missing guard serves it. */
    ids.escapeVersion = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO asset_versions (id, asset_id, version_number, stage, file_path, file_name) '
      + 'VALUES (?,?,?,?,?,?)',
      [ids.escapeVersion, ids.asset, 3, 'tl', '../package.json', 'notes.txt']);

    ids.handoff = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO handoffs (id, project_id, kind, label) VALUES (?,?,?,?)',
      [ids.handoff, ids.project, 'partial_drop', 'Drop 1']);
    ids.secondHandoff = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO handoffs (id, project_id, kind, label) VALUES (?,?,?,?)',
      [ids.secondHandoff, ids.project, 'tech_art', 'Tech Art pass 1']);
  });

  t.after(async () => {
    if (server) await stopServer(server);
    for (const name of stored) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch { /* already gone */ }
    }
  });

  // --- GET /projects --------------------------------------------------------

  await t.test('GET /projects lists them all, with the client', async () => {
    const r = await call('/integration/v1/projects', { idem: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const names = r.body.projects.map((p) => p.name);
    assert.ok(names.includes('Shadow Realm'), JSON.stringify(names));
    const mine = r.body.projects.find((p) => p.id === ids.project);
    assert.strictEqual(mine.clientName, 'Ubisoft Pune', 'the client comes with it');
    assert.strictEqual(mine.isActive, true);

    /* UNPAGINATED, like the internal GET /api/projects. A studio has tens of projects,
       and a second pagination shape for this one would be machinery for nothing. */
    assert.ok(!('hasMore' in r.body), 'no cursor where none is needed');
  });

  // --- GET /projects/:id/assets --------------------------------------------

  await t.test('GET /projects/:id/assets returns that project\'s assets only', async () => {
    const r = await call(`/integration/v1/projects/${ids.project}/assets`, { idem: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.assets.length, 6, 'all six, on a full sync');
    assert.ok(r.body.assets.every((a) => a.projectId === ids.project));
    assert.strictEqual(r.body.assets.filter((a) => a.needsTechArt).length, 1,
      'and the new column comes through as a boolean');

    const empty = await call(`/integration/v1/projects/${ids.otherProject}/assets`, { idem: null });
    assert.deepStrictEqual(empty.body.assets, [], 'a project with none returns none');
  });

  await t.test('updated_since is a sequence, and pages walk forward on lastSeq', async () => {
    /* THE CURSOR IS asset_events.seq, not a timestamp — that table's own DDL explains
       why: created_at is accurate to the second and submit/approve/relay land in the
       same second routinely, so ordering by time scrambles them. */
    const seen = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const r = await call(
        `/integration/v1/projects/${ids.project}/assets?updated_since=${since}&limit=2`,
        { idem: null });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      pages += 1;
      for (const a of r.body.assets) seen.push(a.id);
      if (!r.body.hasMore) break;
      assert.strictEqual(r.body.assets.length, 2, 'hasMore means the page was full');
      since = r.body.lastSeq;
      assert.ok(pages < 10, 'this should not loop');
    }
    assert.strictEqual(new Set(seen).size, 6, 'every asset exactly once across the pages');

    // A cursor past the end is empty, not an error — being caught up is not a failure.
    const high = (await call(`/integration/v1/projects/${ids.project}/assets`, { idem: null }))
      .body.highWater;
    const past = await call(
      `/integration/v1/projects/${ids.project}/assets?updated_since=${high + 100}`, { idem: null });
    assert.strictEqual(past.status, 200);
    assert.deepStrictEqual(past.body.assets, []);
    assert.strictEqual(past.body.hasMore, false);
  });

  await t.test('an asset with no events shows on a full sync and not on an incremental one',
    async () => {
      /* Creating an asset writes no asset_event, so its marker is 0. That means it
         appears when the caller asks for everything and not when they ask for changes
         since something — which is right for this consumer: nothing has happened to it,
         so there is nothing to integrate. */
      const full = await call(`/integration/v1/projects/${ids.project}/assets`, { idem: null });
      const untouched = full.body.assets.find((a) => a.id === ids.noEvents);
      assert.ok(untouched, 'present on a full sync');
      assert.strictEqual(untouched.updatedSeq, 0, 'with a marker of zero');

      const incremental = await call(
        `/integration/v1/projects/${ids.project}/assets?updated_since=1`, { idem: null });
      assert.ok(!incremental.body.assets.some((a) => a.id === ids.noEvents),
        'and absent once the caller is asking for changes');
    });

  await t.test('a malformed updated_since is refused, and the limit is capped', async () => {
    for (const bad of ['yesterday', '-5', '2026-09-28T10:00:00Z']) {
      const r = await call(
        `/integration/v1/projects/${ids.project}/assets?updated_since=${encodeURIComponent(bad)}`,
        { idem: null });
      assert.strictEqual(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'updated_since');
      assert.match(r.body.error, /not a timestamp/, 'and says what it wants instead');
    }

    const capped = await call(
      `/integration/v1/projects/${ids.project}/assets?limit=99999`, { idem: null });
    assert.strictEqual(capped.body.limit, 200, 'the same cap as /events and the internal reports');
  });

  await t.test('an unknown project is a 404, not an empty list', async () => {
    const r = await call(`/integration/v1/projects/${crypto.randomUUID()}/assets`, { idem: null });
    assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  });

  // --- GET /assets/:id ------------------------------------------------------

  await t.test('GET /assets/:id carries its files and its place in the build', async () => {
    const r = await call(`/integration/v1/assets/${ids.asset}`, { idem: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.asset.id, ids.asset);
    assert.strictEqual(r.body.asset.code, 'SR-002');
    assert.strictEqual(r.body.asset.needsTechArt, true);
    assert.strictEqual(r.body.inGame, null, 'nothing reported about it yet');

    // Newest submission first, which is what anybody integrating wants.
    assert.deepStrictEqual(r.body.files.map((f) => f.versionNumber), [3, 2, 1]);
    const link = r.body.files.find((f) => f.id === ids.linkVersion);
    assert.strictEqual(link.fileName, null, 'a link submission has nothing to stream');
    const file = r.body.files.find((f) => f.id === ids.fileVersion);
    assert.strictEqual(file.fileName, 'hero_mesh_v1.fbx');

    const missing = await call(`/integration/v1/assets/${crypto.randomUUID()}`, { idem: null });
    assert.strictEqual(missing.status, 404);
  });

  // --- GET /files/:id -------------------------------------------------------

  await t.test('GET /files/:id streams the file, named as it was uploaded', async () => {
    const res = await call(`/integration/v1/files/${ids.fileVersion}`, { idem: null, rawOut: true });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /hero_mesh_v1\.fbx/,
      'res.download carries the original name, as the internal route does');
    assert.strictEqual(await res.text(), 'the delivered mesh, allegedly');
  });

  await t.test('a link-only submission, a missing file and a nonexistent id are all 404',
    async () => {
      const link = await call(`/integration/v1/files/${ids.linkVersion}`, { idem: null });
      assert.strictEqual(link.status, 404, JSON.stringify(link.body));
      assert.match(link.body.error, /link rather than an upload/);

      // A row pointing at a file that is not there — the case the internal route also
      // answers 404 for rather than 500.
      const goneId = crypto.randomUUID();
      await sql(cfg,
        'INSERT INTO asset_versions (id, asset_id, version_number, stage, file_path, file_name) '
        + 'VALUES (?,?,?,?,?,?)',
        [goneId, ids.asset, 4, 'tl', 'this-file-was-never-written.bin', 'gone.bin']);
      const gone = await call(`/integration/v1/files/${goneId}`, { idem: null });
      assert.strictEqual(gone.status, 404);
      assert.match(gone.body.error, /missing from storage/);

      const nope = await call(`/integration/v1/files/${crypto.randomUUID()}`, { idem: null });
      assert.strictEqual(nope.status, 404);
    });

  await t.test('a stored path cannot climb out of the uploads directory', async () => {
    /* The stored name is data, not a path. Another route, a hand-edited row or an older
       import could put anything in that column, and the answer must be a refusal rather
       than a file from outside the uploads directory.
       
       The target is ../package.json — a file that DEMONSTRABLY exists — because a
       traversal aimed at something absent is refused by the existence check and proves
       nothing about the guards. */
    const res = await call(`/integration/v1/files/${ids.escapeVersion}`, { idem: null, rawOut: true });
    const text = await res.text();
    assert.ok(!/"dependencies"/.test(text) && !/"name":/.test(text),
      `it must not serve a file from outside uploads: ${text.slice(0, 120)}`);
    assert.strictEqual(res.status, 404, 'and says no such file');
  });

  // --- POST /handoffs/:id/ack ----------------------------------------------

  await t.test('acking a hand-off records the build it landed in', async () => {
    const r = await call(`/integration/v1/handoffs/${ids.handoff}/ack`,
      { method: 'POST', body: { build: 'build-1041', note: 'in and running' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.acked, true);
    assert.strictEqual(r.body.alreadyAcked, false);
    assert.strictEqual(r.body.handoff.build, 'build-1041');
    assert.strictEqual(r.body.handoff.status, 'received');

    const row = await sql(cfg, 'SELECT `status`, build, note FROM handoffs WHERE id = ?',
      [ids.handoff]);
    assert.strictEqual(row[0].build, 'build-1041', 'and it is on the row, not just in the reply');
    assert.strictEqual(row[0].note, 'in and running');
  });

  await t.test('GUARD: the same build again is 200 and changes nothing — with a FRESH key',
    async () => {
      /* A DIFFERENT idempotency key on purpose. With the same key this would be the
         generic replay from src/integration-idempotency.js and would prove nothing
         about this handler. A fresh key is a caller that genuinely lost track of
         whether it had acked, which is the case this guard is for. */
      const before = await sql(cfg, 'SELECT updated_at AS u FROM handoffs WHERE id = ?',
        [ids.handoff]);
      const r = await call(`/integration/v1/handoffs/${ids.handoff}/ack`,
        { method: 'POST', body: { build: 'build-1041' }, idem: crypto.randomUUID() });

      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.acked, true);
      assert.strictEqual(r.body.alreadyAcked, true, 'and it says so, rather than pretending it acted');
      assert.strictEqual(r.body.handoff.build, 'build-1041');

      const after = await sql(cfg, 'SELECT updated_at AS u, note FROM handoffs WHERE id = ?',
        [ids.handoff]);
      assert.strictEqual(String(after[0].u), String(before[0].u), 'the row was not touched');
      assert.strictEqual(after[0].note, 'in and running', 'and its note was not overwritten');
      // Not a replay header either: nothing was replayed, the handler ran and declined.
      assert.notStrictEqual(r.body.alreadyAcked, undefined);
    });

  await t.test('GUARD: a DIFFERENT build is 409, with its own code', async () => {
    const r = await call(`/integration/v1/handoffs/${ids.handoff}/ack`,
      { method: 'POST', body: { build: 'build-1099' }, idem: crypto.randomUUID() });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'handoff_build_mismatch');
    assert.strictEqual(r.body.ackedBuild, 'build-1041', 'and names the build that actually took it');
    assert.strictEqual(r.body.received, 'build-1099');

    const row = await sql(cfg, 'SELECT build FROM handoffs WHERE id = ?', [ids.handoff]);
    assert.strictEqual(row[0].build, 'build-1041',
      'the first record survives — overwriting it would destroy the only note of which build took it');
  });

  await t.test('an ack with no build is refused, and an unknown hand-off is a 404', async () => {
    const bare = await call(`/integration/v1/handoffs/${ids.secondHandoff}/ack`,
      { method: 'POST', body: { note: 'forgot the build' } });
    assert.strictEqual(bare.status, 400, JSON.stringify(bare.body));
    assert.strictEqual(bare.body.field, 'build');

    const nope = await call(`/integration/v1/handoffs/${crypto.randomUUID()}/ack`,
      { method: 'POST', body: { build: 'build-1' } });
    assert.strictEqual(nope.status, 404);
  });

  await t.test('and it still needs an Idempotency-Key, like every other write here',
    async () => {
      const r = await call(`/integration/v1/handoffs/${ids.secondHandoff}/ack`,
        { method: 'POST', body: { build: 'build-2' }, idem: null });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.header, 'idempotency-key',
        'the business guard is in ADDITION to the generic one, not instead of it');
    });

  // --- PUT /assets/:id/in-game ---------------------------------------------

  await t.test('PUT /assets/:id/in-game records where it sits', async () => {
    const r = await call(`/integration/v1/assets/${ids.asset}/in-game`, {
      method: 'PUT',
      body: {
        build_seq: 42, build: 'build-1041', cp_stage: 'CP2',
        engine_status: 'in', open_bugs: 3, link: 'https://engine.example/a',
      },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.applied, true);
    assert.strictEqual(r.body.buildSeq, 42);
    assert.strictEqual(r.body.inGame.openBugs, 3);

    // And it shows up on the asset, which is where anybody would look for it.
    const asset = await call(`/integration/v1/assets/${ids.asset}`, { idem: null });
    assert.strictEqual(asset.body.inGame.build, 'build-1041');
    assert.strictEqual(asset.body.inGame.buildSeq, 42);
  });

  await t.test('GUARD: a report about an OLDER build is 200 applied:false and changes nothing',
    async () => {
      /* Reports arrive out of order because the sender retries. An older one is not an
         error — the caller did nothing wrong — so 4xx would make a retrying client treat
         a correct outcome as something to fix. */
      const r = await call(`/integration/v1/assets/${ids.asset}/in-game`, {
        method: 'PUT',
        body: { build_seq: 41, build: 'build-1040', engine_status: 'broken', open_bugs: 99 },
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.applied, false);
      assert.match(r.body.reason, /newer build has already been reported/);
      assert.strictEqual(r.body.buildSeq, 42, 'the stored sequence is untouched');
      assert.strictEqual(r.body.inGame.build, 'build-1041', 'and so is everything else');
      assert.strictEqual(r.body.inGame.openBugs, 3);

      const row = await sql(cfg,
        'SELECT build, open_bugs AS bugs, in_game_build_seq AS seq FROM asset_ingame WHERE asset_id = ?',
        [ids.asset]);
      assert.strictEqual(row[0].build, 'build-1041');
      assert.strictEqual(Number(row[0].bugs), 3);
      assert.strictEqual(Number(row[0].seq), 42);
    });

  await t.test('GUARD: the SAME sequence again also changes nothing', async () => {
    // The commonest shape of a duplicate: the sender re-delivering the same report.
    const r = await call(`/integration/v1/assets/${ids.asset}/in-game`, {
      method: 'PUT',
      body: { build_seq: 42, build: 'build-1041-again', open_bugs: 77 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.applied, false, 'equal is not newer');
    assert.strictEqual(r.body.inGame.build, 'build-1041');
    assert.strictEqual(r.body.inGame.openBugs, 3);
  });

  await t.test('and a NEWER one is applied', async () => {
    const r = await call(`/integration/v1/assets/${ids.asset}/in-game`, {
      method: 'PUT',
      body: { build_seq: 50, build: 'build-1050', engine_status: 'in', open_bugs: 1 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.applied, true);
    assert.strictEqual(r.body.buildSeq, 50);
    assert.strictEqual(r.body.inGame.build, 'build-1050');
    assert.strictEqual(r.body.inGame.openBugs, 1);
  });

  await t.test('two FIRST reports at once: the newer one wins, whichever lands first',
    async () => {
      /* THE ONE CASE WHERE THE SQL GUARD IS LOAD-BEARING, and the reason it is kept
         alongside the decision rather than tidied away.
         
         The handler decides `applied` from a SELECT ... FOR UPDATE. On an asset that
         already has a row that lock serialises everything, and the IF() in the
         statement is redundant — a mutation removing it survives, correctly. But an
         asset with NO row yet has nothing to lock: two first reports can both read
         nothing, both decide they apply, and then one inserts while the other's ON
         DUPLICATE KEY UPDATE fires. There the IF() is the only thing deciding which
         survives, and without it the LATER-ARRIVING request wins rather than the
         newer build.
         
         This test earned its keep twice over. It first caught the handler taking
         SELECT ... FOR UPDATE on a row that does not exist yet, which gap-locks and
         deadlocks two concurrent first reports into a 500 — a far worse answer than the
         momentarily optimistic flag the plain read can give. The lock is gone, and the
         IF() in the statement is what makes that safe.
         
         HONESTLY, on coverage: whether the two requests genuinely interleave is timing,
         so a mutation removing the IF() may still survive on a run where they
         serialise. What this pins is that the outcome is correct under whichever
         ordering happens, which is the most a black-box test can do. */
      const fresh = ids.assets[4];
      const [a1, b1] = await Promise.all([
        call(`/integration/v1/assets/${fresh}/in-game`,
          { method: 'PUT', body: { build_seq: 10, build: 'older-10', open_bugs: 9 } }),
        call(`/integration/v1/assets/${fresh}/in-game`,
          { method: 'PUT', body: { build_seq: 20, build: 'newer-20', open_bugs: 1 } }),
      ]);
      assert.deepStrictEqual([a1.status, b1.status], [200, 200],
        `${JSON.stringify(a1.body)} / ${JSON.stringify(b1.body)}`);

      const row = await sql(cfg,
        'SELECT build, in_game_build_seq AS seq, open_bugs AS bugs FROM asset_ingame WHERE asset_id = ?',
        [fresh]);
      assert.strictEqual(row.length, 1, 'one row, however they raced');
      assert.strictEqual(Number(row[0].seq), 20, 'the NEWER build is stored, not the last to arrive');
      assert.strictEqual(row[0].build, 'newer-20');
      assert.strictEqual(Number(row[0].bugs), 1, 'and its figures, not the older report\'s');
    });

  await t.test('a report with no build_seq is refused, and an unknown asset is 404', async () => {
    const bare = await call(`/integration/v1/assets/${ids.asset}/in-game`,
      { method: 'PUT', body: { build: 'build-9' } });
    assert.strictEqual(bare.status, 400, JSON.stringify(bare.body));
    assert.strictEqual(bare.body.field, 'build_seq');

    const nope = await call(`/integration/v1/assets/${crypto.randomUUID()}/in-game`,
      { method: 'PUT', body: { build_seq: 1 } });
    assert.strictEqual(nope.status, 404);
  });

  // --- the action-per-path-segment rule, applied to these paths -------------

  await t.test('each route needs the action its first path segment names', async () => {
    /* The narrow credential holds "assets" and nothing else. What it can and cannot
       reach is the rule working, and includes the consequence worth knowing:
       /projects/:id/assets needs "projects", because the resource family it enters is
       projects. */
    const ok = await call(`/integration/v1/assets/${ids.asset}`, { key: NARROW, idem: null });
    assert.strictEqual(ok.status, 200, 'it holds assets, so one asset by id is fine');

    for (const [p, action] of [
      ['/integration/v1/projects', 'projects'],
      [`/integration/v1/projects/${ids.project}/assets`, 'projects'],
      [`/integration/v1/files/${ids.fileVersion}`, 'files'],
    ]) {
      const r = await call(p, { key: NARROW, idem: null });
      assert.strictEqual(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.action, action, `${p} needs "${action}"`);
    }

    const ack = await call(`/integration/v1/handoffs/${ids.secondHandoff}/ack`,
      { method: 'POST', body: { build: 'b' }, key: NARROW });
    assert.strictEqual(ack.status, 403);
    assert.strictEqual(ack.body.action, 'handoffs');

    // And a write it DOES hold the action for gets through the gate.
    const write = await call(`/integration/v1/assets/${ids.asset}/in-game`,
      { method: 'PUT', body: { build_seq: 60 }, key: NARROW });
    assert.strictEqual(write.status, 200, JSON.stringify(write.body));
  });
});
