/* The three tables behind the Dev & QA integration.
 *
 * STORAGE ONLY. Nothing reads these yet: they are added on their own so the
 * schema change and the behaviour that uses it are separate deployments. What
 * is asserted here is therefore what a migration owes regardless of what comes
 * next — that it runs, that running it twice is harmless, and that /api/health
 * would notice if it had not run.
 *
 * THE LAST OF THOSE IS THE ONE WITH A HISTORY. src/schema-check.js carries a
 * comment about four tables that went missing from its REQUIRED list, during
 * which the one endpoint built to name schema gaps reported "complete". A table
 * added to the app and not to that list is invisible to it, so the test below
 * asserts the declaration as firmly as it asserts the table.
 */
const test = require('node:test');
const assert = require('node:assert');

const schemaCheck = require('../src/schema-check');
const { config, resetSchema, sql, SKIP_REASON } = require('./helpers');

const cfg = config('integtables');

const TABLES = ['integration_clients', 'integration_requests', 'integration_outbox'];

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

  /* The columns something will later read BY NAME. A table created by an older
     build with CREATE TABLE IF NOT EXISTS keeps whatever columns it had, so the
     table being present is not the same as the table being current — which is
     exactly the case asset_events was added to this list for. */
  for (const [table, column] of [
    ['integration_clients', 'key_hash'],
    ['integration_clients', 'allowed_actions'],
    ['integration_requests', 'idempotency_key'],
    ['integration_requests', 'request_hash'],
    ['integration_outbox', 'seq'],
    ['integration_outbox', 'next_attempt_at'],
  ]) {
    assert.ok(declared.get(table).has(column),
      `${table}.${column} is read by name but not declared, so a half-migrated copy of `
      + `${table} would pass the health check`);
  }

  /* Same rule the rest of the list follows: name the step to re-run — and THE STEP
     THAT ACTUALLY ADDS IT, which is not always the one that created the table.
     Columns added later by their own migration step have to name that step, or the
     health check would send somebody to re-run a step that creates nothing they are
     missing. So this asserts the step is one of the real ones rather than one
     particular one. */
  const STEPS = new Set([
    'integration tables',
    'integration idempotency reservation',
    // The rotation overlap: a second hash and its expiry, so a key can be replaced
    // without an outage.
    'integration key rotation',
  ]);
  for (const need of schemaCheck.REQUIRED.filter((r) => TABLES.includes(r.table))) {
    assert.ok(STEPS.has(need.step),
      `${need.table}${need.column ? `.${need.column}` : ''} names "${need.step}", which is not a `
      + `migration step that adds it — one of: ${[...STEPS].join(', ')}`);
  }

  /* And the reservation's own columns, which the claim rests on: without status
     every row reads as complete and the exclusion is gone, and without updated_at
     nothing can tell a live claim from wreckage. */
  for (const column of ['status', 'updated_at']) {
    assert.ok(declared.get('integration_requests').has(column),
      `integration_requests.${column} carries the reservation's state and must be declared`);
    const need = schemaCheck.REQUIRED.find(
      (r) => r.table === 'integration_requests' && r.column === column);
    assert.strictEqual(need.step, 'integration idempotency reservation',
      'and must name the step that adds it, not the one that created the table');
  }
});

test('the migration creates them, and is safe to run twice',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    /* A connection bound to THIS suite's database, the way the schema-repair
       test in asset-workflow does it. src/db's pool is built from the
       environment when it is first required, so handing migrate that module
       would run the whole startup path against whichever database happened to
       be configured — which is how the first version of this test passed its
       migration and then found no tables. */
    const mysql = require('mysql2/promise');
    let conn;
    const db = { query: async (text, params = []) => {
      const ordered = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
      const [out] = await conn.query(sqlText, ordered.length ? ordered : params);
      return { rows: Array.isArray(out) ? out : [], result: out };
    } };

    t.before(async () => {
      await resetSchema(cfg);
      conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user,
        password: cfg.password, database: cfg.database,
      });
      // The whole startup path, not the one step — a step that only works when
      // run alone is not a migration.
      await require('../src/migrate').run(db, () => {});
    });
    t.after(async () => { if (conn) await conn.end(); });

    await t.test('all three exist', async () => {
      const rows = await sql(cfg,
        `SELECT TABLE_NAME AS t FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
                ('integration_clients','integration_requests','integration_outbox')`);
      assert.deepStrictEqual(rows.map((r) => r.t).sort(), [...TABLES].sort());
    });

    await t.test('the credential stores a hash and never a key', async () => {
      const cols = await sql(cfg,
        `SELECT COLUMN_NAME AS c, DATA_TYPE AS d, IS_NULLABLE AS n, COLUMN_DEFAULT AS dflt
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_clients'`);
      const by = new Map(cols.map((c) => [c.c, c]));

      assert.ok(by.has('key_hash'), 'the hash is stored');
      assert.strictEqual(by.get('key_hash').d, 'char', 'as fixed-width hex');
      /* THE POINT OF THE TABLE. A column that could hold the key itself is the
         one mistake this design exists to prevent, so its absence is asserted
         rather than assumed from the column list being right today. */
      for (const forbidden of ['key', 'api_key', 'secret', 'token', 'plain_key']) {
        assert.ok(!by.has(forbidden),
          `integration_clients.${forbidden} would store a credential in clear`);
      }

      assert.ok(by.has('allowed_actions'), 'what it may do');
      assert.ok(by.has('is_active'), 'is_active, matching the eight other tables that spell it so');
      assert.ok(!by.has('active'), 'and not a second spelling of the same idea');
      assert.strictEqual(by.get('last_used_at').n, 'YES',
        'null until first use, which is how an unused key is told from a live one');
    });

    await t.test('the idempotency key is the primary key, scoped to the client', async () => {
      /* WAS idempotency_key alone, and this test used to assert exactly that.
         The DDL said in as many words that scoping it per client was a decision
         about the API rather than about storage; the API now exists and the
         decision is made, by the 'integration idempotency scope' migration step.
         Two credentials that happen to choose the same key are two different
         requests, and handing the second caller the first one's response would
         be a cross-tenant leak wearing a cache's clothes.

         Order matters as much as membership: client_id first is what makes the
         key usable for "everything this credential has done" — and it is why the
         separate index on client_id is redundant rather than load-bearing. */
      const keys = await sql(cfg,
        `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_requests'
            AND CONSTRAINT_NAME = 'PRIMARY'
          ORDER BY ORDINAL_POSITION`);
      assert.deepStrictEqual(keys.map((k) => k.c), ['client_id', 'idempotency_key']);

      // And client_id cannot be null, or MySQL would quietly rewrite it to the
      // empty string and every unattributed row would collide with every other.
      const nullable = await sql(cfg,
        `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_requests'
            AND COLUMN_NAME = 'client_id'`);
      assert.strictEqual(nullable[0].n, 'NO');

      const cols = await sql(cfg,
        `SELECT COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_requests'`);
      const by = new Map(cols.map((c) => [c.c, c.d]));
      assert.strictEqual(by.get('request_hash'), 'char', 'a hash, not the body');
      /* A response truncated at TEXT's 64KB is a replay that silently differs
         from the original, which defeats the table. */
      assert.strictEqual(by.get('response_body'), 'mediumtext');
    });

    await t.test('the outbox is ordered, not merely queued', async () => {
      const cols = await sql(cfg,
        `SELECT COLUMN_NAME AS c, EXTRA AS extra, DATA_TYPE AS d FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_outbox'`);
      const by = new Map(cols.map((c) => [c.c, c]));
      assert.ok(/auto_increment/i.test(by.get('seq').extra || ''),
        'seq must be auto-increment — created_at is second-resolution, so rows written in '
        + 'the same second have no order between them and an outbox for ordered replay cannot have ties');
      assert.strictEqual(by.get('seq').d, 'bigint');
      assert.ok(by.has('attempts') && by.has('next_attempt_at') && by.has('last_error'));

      // And it really does hand out increasing numbers.
      for (const n of [1, 2, 3]) {
        await sql(cfg,
          `INSERT INTO integration_outbox (id, payload) VALUES (UUID(), '{"n":${n}}')`);
      }
      const rows = await sql(cfg, 'SELECT seq FROM integration_outbox ORDER BY seq');
      const seqs = rows.map((r) => Number(r.seq));
      assert.strictEqual(seqs.length, 3);
      assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b), 'strictly increasing');
      assert.ok(seqs[1] > seqs[0] && seqs[2] > seqs[1], 'and no ties');
    });

    await t.test('running the migration again changes nothing', async () => {
      /* Every step is written to be safe on every boot; this one is checked
         because it is new, and because a CREATE that is not idempotent fails
         the WHOLE startup run for a studio that restarts. */
      const before = await sql(cfg, 'SELECT COUNT(*) AS n FROM integration_outbox');
      const result = await require('../src/migrate').run(db, () => {});
      assert.ok(!result.failed.includes('integration tables'),
        `the step failed on a second run: ${result.failed.join(', ')}`);
      const after = await sql(cfg, 'SELECT COUNT(*) AS n FROM integration_outbox');
      assert.strictEqual(Number(after[0].n), Number(before[0].n),
        'a re-run must not touch rows that are already there');
    });

    await t.test('the health check now reports the schema complete', async () => {
      const gaps = await require('../src/schema-check').gaps(db);
      const mine = gaps.filter((g) => g.name.startsWith('integration_'));
      assert.deepStrictEqual(mine, [],
        `the tables were created but health still reports them missing: ${JSON.stringify(mine)}`);
    });
  });
