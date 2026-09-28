/* Game Feedback's storage, and the one thing it must not do: invent rounds.
 *
 * A revision round in this application is a SUBMISSION. work_log's currentRound() is
 * COUNT(*) FROM asset_versions + 1, the Efficiency report's `rounds` is COUNT(*) FROM
 * asset_versions, and work_sessions.round stores which submission a stretch of work
 * belongs to. Nothing records rounds as entities, and TL and CD feedback do not
 * create them — feedback sends the asset back, the artist submits again, and that
 * submission is the round.
 *
 * So the tables here RECORD which round they concern and never count one. The first
 * test in this file is a guard against that changing: a second rounds mechanism would
 * make the Efficiency report wrong for exactly the work this feature exists to track,
 * and it would do so silently, because the report would keep returning a number.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, sql, SKIP_REASON } = require('./helpers');
const schemaCheck = require('../src/schema-check');
const workflow = require('../src/asset-workflow');

const cfg = config('gamefeedback');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TABLES = ['handoffs', 'handoff_assets', 'external_feedback', 'asset_ingame'];

test('rounds are recorded here, never counted here', () => {
  const migrate = read('src/migrate.js');
  const reports = read('src/routes/reports.js');
  const workLog = read('src/work-log.js');

  /* THE ONE DEFINITION, still the only one. Both of these read asset_versions, and
     the Efficiency report's number and a work session's round have to mean the same
     thing or the report is wrong about rework. */
  assert.match(reports, /FROM asset_versions v WHERE v\.asset_id = a\.id\) AS rounds/,
    'the Efficiency report still derives rounds from submissions');
  assert.match(workLog, /SELECT COUNT\(\*\) AS n FROM asset_versions WHERE asset_id/,
    'and so does currentRound()');

  // No table called rounds, and nothing here generating round numbers of its own.
  assert.ok(!/CREATE TABLE IF NOT EXISTS (asset_)?rounds\b/.test(migrate),
    'a rounds table would be a second mechanism the report does not read');

  /* The two round columns are plain INTs that something else supplies. An
     AUTO_INCREMENT round, or a unique key on (asset_id, round) alone, would make one
     of these tables the thing that DECIDES what round it is — which is the drift this
     test exists to catch. */
  for (const table of ['handoff_assets', 'external_feedback']) {
    const block = migrate.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) ENGINE`));
    assert.ok(block, `${table} should be created in migrate.js`);
    assert.match(block[1], /round\s+INT\s+NOT NULL DEFAULT 1/, `${table}.round is a recorded INT`);
    assert.ok(!/round\s+[A-Z]*\s*AUTO_INCREMENT/i.test(block[1]),
      `${table}.round must not generate its own numbering`);
  }
});

test('game_feedback is in the status vocabulary in every place that carries it', () => {
  /* FIVE PLACES, not three. The migration's list drives the CHECK repair on an
     existing database; sql/schema.sql builds a fresh one; asset-workflow.js is what
     the server reasons with; and public/index.html carries TWO copies — the STATUSES
     list, which is pinned to match the server's, and ASSET_LIST_GROUPS, which every
     status must appear in exactly once. Any one of them left behind is a status that
     works everywhere except one screen, or a database that refuses it. */
  const migrate = read('src/migrate.js');
  const schema = read('sql/schema.sql');
  const page = read('public/index.html');

  const values = migrate.match(/const STATUS_VALUES = \[([\s\S]*?)\n\];/);
  assert.ok(values, 'STATUS_VALUES should be one named list');
  const declared = [...values[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(declared.includes('game_feedback'), '1. migrate.js STATUS_VALUES');

  const check = schema.match(/chk_assets_status CHECK \(`status` IN \(([\s\S]*?)\)\)/);
  assert.ok(check, 'the CHECK should be in sql/schema.sql');
  const checked = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(checked.includes('game_feedback'), '2. sql/schema.sql CHECK');

  /* And the two lists agree in full, which is what stops this copy falling behind
     again — it had lost 'tl_approved', and only a database built from this file was
     affected, because the startup repair fixes an existing one. */
  assert.deepStrictEqual([...checked].sort(), [...declared].sort(),
    'the CHECK in sql/schema.sql and STATUS_VALUES must list the same statuses');

  assert.ok(workflow.STATE_IDS.includes('game_feedback'), '3. asset-workflow.js STATES');

  const statuses = page.match(/const STATUSES = \[([\s\S]*?)\n\];/);
  assert.ok(statuses, 'STATUSES should be one named list in the page');
  const drawn = [...statuses[1].matchAll(/id:'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(drawn, workflow.STATE_IDS,
    '4. public/index.html STATUSES must match the server, in order');

  const groups = page.match(/const ASSET_LIST_GROUPS = \[([\s\S]*?)\n\];/);
  /* Only what is inside statuses:[...] — the group ids and labels are quoted too, and
     scooping those up would make this pass for the wrong reason. */
  const placed = [...groups[1].matchAll(/statuses:\[([\s\S]*?)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  assert.ok(placed.includes('game_feedback'), '5. public/index.html ASSET_LIST_GROUPS');
  assert.deepStrictEqual([...placed].sort(), [...workflow.STATE_IDS].sort(),
    'every status is placed exactly once');

  // And the vocabulary agrees with what the database will accept.
  assert.deepStrictEqual([...declared].sort(), [...workflow.STATE_IDS].sort(),
    'the statuses the app can write and the ones the constraint admits are one set');
});

test('adding a status introduces no transition, so nothing else is owed yet', () => {
  /* actors, refusal() and the PHRASE map are keyed by TRANSITION, not by status —
     checked here rather than assumed, because the brief asked whether adding
     game_feedback owes them an entry. It does not: no transition exists into or out
     of it yet, and the whole of tests/asset-workflow.test.js passing is the other
     half of that answer.
     
     When the transition does land it owes all three, plus REWORK_STATUSES in
     src/permissions.js, which is pinned to exactly two values by
     tests/asset-ownership.test.js and will fail until it is updated deliberately. */
  const source = read('src/asset-workflow.js');
  /* actors and PHRASE are module-private; TRANSITIONS is the exported list of the
     same keys, which is what makes this checkable from outside. */
  const transitions = Object.keys(workflow.TRANSITIONS || {});
  assert.ok(transitions.length, 'TRANSITIONS should be keyed by transition name');
  for (const id of workflow.STATE_IDS) {
    assert.ok(!transitions.includes(id),
      `transitions are named for the action, not the status (${id})`);
  }
  // And no transition mentions the new status yet, in either direction.
  const actorsBlock = source.match(/const actors = \{([\s\S]*?)\n\};/);
  assert.ok(actorsBlock, 'actors should be one named map');
  assert.ok(!/game_feedback/.test(actorsBlock[1]),
    'no actor rule refers to it yet, because no transition does');

  const { REWORK_STATUSES } = require('../src/permissions');
  assert.deepStrictEqual(REWORK_STATUSES, ['tl_changes_requested', 'cd_changes_requested'],
    'still two: game_feedback joins this when its transition is built, not before');
});

test('/api/health would notice these tables missing', () => {
  const declared = new Map();
  for (const need of schemaCheck.REQUIRED) {
    if (!declared.has(need.table)) declared.set(need.table, new Set());
    if (need.column) declared.get(need.table).add(need.column);
  }

  for (const table of TABLES) {
    assert.ok(declared.has(table),
      `${table} is created by the migration but absent from schema-check's REQUIRED list, `
      + 'so /api/health would report "complete" on a database that does not have it');
  }

  // The columns something will read BY NAME. A table created by an older build with
  // CREATE TABLE IF NOT EXISTS keeps whatever columns it had, so the table being
  // present is not the same as the table being current.
  for (const [table, column] of [
    ['handoff_assets', 'round'],
    ['handoff_assets', 'status'],
    ['external_feedback', 'round'],
    ['external_feedback', 'prev_status'],
    ['external_feedback', 'prev_routed_to_id'],
    ['asset_ingame', 'in_game_build_seq'],
    ['assets', 'needs_tech_art'],
  ]) {
    assert.ok(declared.get(table) && declared.get(table).has(column),
      `${table}.${column} is read by name but not declared`);
  }

  // Each names the step that actually adds it, so the health check sends somebody to
  // re-run something that would create what they are missing.
  const steps = new Set(['game feedback tables', 'assets.needs_tech_art']);
  for (const need of schemaCheck.REQUIRED.filter((r) => TABLES.includes(r.table))) {
    assert.ok(steps.has(need.step),
      `${need.table}${need.column ? `.${need.column}` : ''} names "${need.step}"`);
  }
  const techArt = schemaCheck.REQUIRED.find(
    (r) => r.table === 'assets' && r.column === 'needs_tech_art');
  assert.strictEqual(techArt.step, 'assets.needs_tech_art');
});

test('the migration creates them, and is safe to run twice',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let conn;
  let db;

  const step = (name) => {
    const found = require('../src/migrate').STEPS.find(([n]) => n === name);
    assert.ok(found, `there should be a "${name}" step, or startup would never run it`);
    return found[1];
  };

  // ONLY the new steps, never migrate.run(). Running the whole list to reach one
  // means dozens of DDL statements taking metadata locks on a server shared with
  // every other suite, which measurably caused failures in unrelated ones.
  const runNewSteps = async () => {
    const said = [];
    await step('game feedback tables')(db, (m) => said.push(m));
    await step('assets.needs_tech_art')(db, (m) => said.push(m));
    return said;
  };

  const columns = async (table) => new Map((await sql(cfg,
    `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, DATA_TYPE AS t
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]))
    .map((r) => [r.c, r]));

  t.before(async () => {
    await resetSchema(cfg);
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    db = { query: async (text, params) => {
      /* Ordered by APPEARANCE, the way src/db.js's translate() does it — a naive
         $n-to-? swap breaks the moment a query names the same placeholder twice, and
         the staleness guard below names its sequence in both SET and WHERE. */
      const values = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { values.push((params || [])[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(sqlText, values.length ? values : (params || []));
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };
  });

  t.after(async () => { if (conn) await conn.end(); });

  await t.test('none of it exists before the step runs', async () => {
    const present = await sql(cfg,
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?)', TABLES);
    assert.deepStrictEqual(present.map((r) => r.t), [],
      'otherwise this proves nothing about the step');
    assert.ok(!(await columns('assets')).has('needs_tech_art'));
  });

  await t.test('the step creates all four, and the column', async () => {
    const said = await runNewSteps();
    const present = await sql(cfg,
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?) ORDER BY TABLE_NAME', TABLES);
    assert.deepStrictEqual(present.map((r) => r.t).sort(), [...TABLES].sort());
    assert.match(said.join('\n'), /handoffs, handoff_assets, external_feedback and asset_ingame ready/);
    assert.match(said.join('\n'), /needs_tech_art/);
  });

  await t.test('running it again changes nothing and reports nothing', async () => {
    const said = await runNewSteps();
    assert.ok(!said.some((m) => /needs_tech_art/.test(m)),
      'the column add is guarded, so a second run is silent about it');
    const present = await sql(cfg,
      'SELECT COUNT(*) AS n FROM information_schema.TABLES '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?)', TABLES);
    assert.strictEqual(Number(present[0].n), 4, 'and no duplicates, obviously');
  });

  await t.test('the status columns are VARCHAR with a default, not ENUM and not `state`',
    async () => {
      for (const table of ['handoffs', 'handoff_assets']) {
        const cols = await columns(table);
        assert.ok(cols.has('status'), `${table}.status`);
        assert.ok(!cols.has('state'), `${table} must not carry a second spelling of the same idea`);
        assert.strictEqual(cols.get('status').t, 'varchar',
          `${table}.status is VARCHAR, so a fifth value is a row's value not a migration`);
        assert.strictEqual(cols.get('status').n, 'NO');
        // MariaDB reports a string default WITH its quotes; MySQL without them.
        assert.strictEqual(String(cols.get('status').d).replace(/^'|'$/g, ''), 'queued',
          'queued is where a hand-off starts');
      }
      const ingame = await columns('asset_ingame');
      assert.strictEqual(ingame.get('engine_status').t, 'varchar');
      assert.ok(!ingame.has('state'));
    });

  await t.test('needs_tech_art is a boolean that defaults to false', async () => {
    const cols = await columns('assets');
    const col = cols.get('needs_tech_art');
    assert.ok(col, 'the column exists');
    assert.strictEqual(col.n, 'NO', 'not nullable — a third state for a yes/no question');
    assert.strictEqual(Number(col.d), 0, 'and false by default, so no existing asset changes meaning');
  });

  await t.test('asset_ingame holds one row per asset, keyed by the asset', async () => {
    const keys = await sql(cfg,
      `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_ingame'
          AND CONSTRAINT_NAME = 'PRIMARY'`);
    assert.deepStrictEqual(keys.map((k) => k.c), ['asset_id'],
      'the asset IS the key — its state in the game is replaced, not accumulated');
  });
});

test('the guards actually refuse things', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let conn;
  let db;
  let assetId;

  t.before(async () => {
    await resetSchema(cfg);
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    db = { query: async (text, params) => {
      /* Ordered by APPEARANCE, the way src/db.js's translate() does it — a naive
         $n-to-? swap breaks the moment a query names the same placeholder twice, and
         the staleness guard below names its sequence in both SET and WHERE. */
      const values = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { values.push((params || [])[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(sqlText, values.length ? values : (params || []));
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };
    const migrate = require('../src/migrate');
    await migrate.STEPS.find(([n]) => n === 'game feedback tables')[1](db, () => {});

    /* A real owner, project and asset to hang the rows off, because the foreign keys
       are real and every NOT NULL column without a default has to be given. */
    const ownerId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    assetId = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO users (id, name, email, password_hash, `role`) VALUES (?, ?, ?, ?, ?)',
      [ownerId, 'Guard Owner', 'guard@zvky.test', 'x', 'super_admin']);
    await sql(cfg, 'INSERT INTO clients (id, name) VALUES (?, ?)', [clientId, 'Guard Test Client']);
    await sql(cfg, 'INSERT INTO projects (id, client_id, owner_id, name) VALUES (?, ?, ?, ?)',
      [projectId, clientId, ownerId, 'Guard Test Project']);
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?, ?, ?, ?, ?, ?)',
      [assetId, projectId, 'GRD-001', 'Guard Test Asset', 'character', 'delivered']);
  });

  t.after(async () => { if (conn) await conn.end(); });

  const raise = (bugRef, round = 1, source = 'qa') => sql(cfg,
    'INSERT INTO external_feedback (id, asset_id, round, source, bug_ref, note) VALUES (?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), assetId, round, source, bugRef, 'it clips through the floor']);

  await t.test('the same bug on the same round cannot be raised twice', async () => {
    /* THE GUARD THAT MATTERS. A retried call is the normal behaviour of every
       integration that ever times out, and without this it would raise one defect
       twice and send the asset round twice for it. */
    await raise('QA-1201');
    await assert.rejects(() => raise('QA-1201'), (err) => {
      assert.strictEqual(err.code, 'ER_DUP_ENTRY');
      return true;
    }, 'the database refuses it, rather than the route remembering to');

    const rows = await sql(cfg,
      'SELECT COUNT(*) AS n FROM external_feedback WHERE bug_ref = ?', ['QA-1201']);
    assert.strictEqual(Number(rows[0].n), 1, 'one row, one round');
  });

  await t.test('but the same bug on a LATER round is a new thing to fix', async () => {
    // The fix went in, the asset was submitted again, and it is still broken. That is
    // genuinely a second piece of feedback, not a duplicate of the first.
    await raise('QA-1201', 2);
    const rows = await sql(cfg,
      'SELECT round FROM external_feedback WHERE bug_ref = ? ORDER BY round', ['QA-1201']);
    assert.deepStrictEqual(rows.map((r) => Number(r.round)), [1, 2]);
  });

  await t.test('and a different source reporting the same reference is not a duplicate',
    async () => {
      await raise('QA-1201', 1, 'dev');
      const rows = await sql(cfg,
        'SELECT source FROM external_feedback WHERE bug_ref = ? AND round = 1 ORDER BY source',
        ['QA-1201']);
      assert.deepStrictEqual(rows.map((r) => r.source), ['dev', 'qa']);
    });

  await t.test('an empty bug reference is still guarded, which NULL would not be', async () => {
    /* bug_ref is NOT NULL DEFAULT '' precisely for this. MySQL permits any number of
       rows whose unique-key columns are NULL, so a nullable bug_ref would mean
       feedback without a reference — the commonest kind — had no guard at all. */
    await raise('', 3);
    await assert.rejects(() => raise('', 3), (err) => err.code === 'ER_DUP_ENTRY',
      'unreferenced feedback is guarded too');

    const nullable = await sql(cfg,
      `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_feedback'
          AND COLUMN_NAME = 'bug_ref'`);
    assert.strictEqual(nullable[0].n, 'NO', 'and it cannot be made nullable without losing that');
  });

  await t.test('one asset round cannot be put in the same hand-off twice', async () => {
    const handoffId = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO handoffs (id, project_id, kind) VALUES (?, ?, ?)',
      [handoffId, (await sql(cfg, 'SELECT project_id AS p FROM assets WHERE id = ?', [assetId]))[0].p,
        'partial_drop']);
    const add = () => sql(cfg,
      'INSERT INTO handoff_assets (id, handoff_id, asset_id, round) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), handoffId, assetId, 4]);

    await add();
    await assert.rejects(add, (err) => err.code === 'ER_DUP_ENTRY',
      'sending the same round twice in one drop is a mistake, not two things to integrate');

    // A different round of the same asset in the same drop is fine, though.
    await sql(cfg,
      'INSERT INTO handoff_assets (id, handoff_id, asset_id, round) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), handoffId, assetId, 5]);
  });

  await t.test('the staleness guard rejects an older build and accepts a newer one', async () => {
    /* The column is only half of it; the other half is that writes are CONDITIONAL on
       it. Asserted as the conditional write itself, because the column alone protects
       nothing — exactly the ordering integration_outbox.seq gives ordered replay,
       where DATETIME cannot, two writes in one second having no order between them. */
    await sql(cfg,
      'INSERT INTO asset_ingame (asset_id, build, in_game_build_seq) VALUES (?, ?, ?)',
      [assetId, 'build-42', 42]);

    const apply = async (build, seq) => {
      const { result } = await db.query(
        `UPDATE asset_ingame SET build = $1, in_game_build_seq = $2
          WHERE asset_id = $3 AND in_game_build_seq < $2`,
        [build, seq, assetId]
      );
      return (result && result.affectedRows) || 0;
    };

    assert.strictEqual(await apply('build-41', 41), 0, 'an older report is not applied');
    assert.strictEqual((await sql(cfg, 'SELECT build AS b FROM asset_ingame WHERE asset_id = ?',
      [assetId]))[0].b, 'build-42', 'and the newer truth is still there');

    assert.strictEqual(await apply('build-42', 42), 0, 'nor is the same one, re-delivered');

    assert.strictEqual(await apply('build-43', 43), 1, 'a newer one is');
    assert.strictEqual((await sql(cfg, 'SELECT build AS b FROM asset_ingame WHERE asset_id = ?',
      [assetId]))[0].b, 'build-43');
  });

  await t.test('an asset can actually be set to game_feedback', async () => {
    // The whole point of the vocabulary change: the CHECK admits it. On a database
    // built from sql/schema.sql, which is what resetSchema does.
    await sql(cfg, 'UPDATE assets SET status = ? WHERE id = ?', ['game_feedback', assetId]);
    const rows = await sql(cfg, 'SELECT status AS s FROM assets WHERE id = ?', [assetId]);
    assert.strictEqual(rows[0].s, 'game_feedback');

    await assert.rejects(
      () => sql(cfg, 'UPDATE assets SET status = ? WHERE id = ?', ['invented_status', assetId]),
      'and still refuses one nobody declared');
  });
});
