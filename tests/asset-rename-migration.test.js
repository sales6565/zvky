/* THE MIGRATION BEHIND EDITING A NAME: two tables, nothing touched.
 *
 * Both are additive and neither exists in sql/schema.sql — a fresh database
 * gets them from the startup step, exactly as chat_settings, leave_settings and
 * the timesheet tables are got. So the three things worth asserting are the
 * three ways a startup repair goes wrong:
 *
 *   it does not run       → the tables are absent and the feature 500s. The
 *                           step is registered in STEPS and named in
 *                           src/schema-check.js, so /api/health says which one.
 *   it runs twice         → a boot is not a one-off. Running the step again must
 *                           change nothing and must not throw.
 *   it runs on a database → rows that are already there must come out exactly as
 *     with data             they went in. No backfill: an asset that has never
 *                           been renamed has no history, which is the honest
 *                           answer rather than an invented "created as" row.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, sql, SKIP_REASON } = require('./helpers');
const migrate = require('../src/migrate');
const schemaCheck = require('../src/schema-check');

const cfg = config('assetrenamemig');
const STEP = 'asset renaming';
const TABLES = ['asset_name_history', 'asset_settings'];

test('the step is registered, and named by the health check', () => {
  const found = migrate.STEPS.find(([n]) => n === STEP);
  assert.ok(found, `there must be an "${STEP}" step, or startup would never run it`);

  /* THE MIRROR LOADS STRAIGHT AFTER IT, like every other settings row in this
     application — so the first request already knows whether the switch is on
     rather than discovering it on the first rename. */
  const names = migrate.STEPS.map(([n]) => n);
  assert.strictEqual(names[names.indexOf(STEP) + 1], 'asset settings mirror');

  for (const need of schemaCheck.REQUIRED.filter((r) => TABLES.includes(r.table))) {
    assert.strictEqual(need.step, STEP,
      `${need.table}${need.column ? `.${need.column}` : ''} names the step that creates it`);
  }
  // Both tables are covered, not just one.
  for (const table of TABLES) {
    assert.ok(schemaCheck.REQUIRED.some((r) => r.table === table && r.column === null),
      `${table} itself is in the health check's list`);
  }
});

test('it creates them, twice is safe, and existing rows are untouched',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let conn;
    let db;
    const said = [];
    const run = () => migrate.STEPS.find(([n]) => n === STEP)[1](db, (m) => said.push(m));

    const tablesPresent = async () => new Set((await sql(cfg,
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)', TABLES
    )).map((r) => r.t));
    const columnsOf = async (table) => new Map((await sql(cfg,
      `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, DATA_TYPE AS t,
              CHARACTER_MAXIMUM_LENGTH AS len
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]
    )).map((r) => [r.c, r]));

    t.before(async () => {
      await resetSchema(cfg);
      const mysql = require('mysql2/promise');
      conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      });
      // $n by order of appearance, the way src/db.js's translate() does it.
      db = { query: async (text, params) => {
        const values = [];
        const sqlText = text.replace(/\$(\d+)/g, (_, n) => {
          values.push((params || [])[Number(n) - 1]); return '?';
        });
        const [rows] = await conn.query(sqlText, values.length ? values : (params || []));
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      } };
    });

    t.after(async () => { if (conn) await conn.end(); });

    await t.test('neither table exists in a fresh schema before the step runs', async () => {
      assert.deepStrictEqual([...await tablesPresent()], [],
        'sql/schema.sql does not carry them — the step is what creates them');
    });

    await t.test('the step creates both, with the shapes the feature needs', async () => {
      await run();
      assert.deepStrictEqual([...await tablesPresent()].sort(), [...TABLES].sort());

      const history = await columnsOf('asset_name_history');
      assert.deepStrictEqual([...history.keys()].sort(),
        ['asset_id', 'changed_at', 'changed_by_email', 'changed_by_user_id', 'id',
          'new_name', 'old_name', 'seq'].sort());
      // Both names are the width of the column they came from, so a history row
      // can never hold a name the asset could not.
      assert.strictEqual(Number(history.get('old_name').len), 255);
      assert.strictEqual(Number(history.get('new_name').len), 255);
      assert.strictEqual(history.get('old_name').n, 'NO', 'a rename has a before');
      assert.strictEqual(history.get('new_name').n, 'NO', 'and an after');
      // Who, nullable: the rename still happened after the account is deleted.
      assert.strictEqual(history.get('changed_by_user_id').n, 'YES');

      // The index the list is read by.
      const keys = await sql(cfg,
        "SHOW INDEX FROM asset_name_history WHERE Key_name = 'idx_asset_name_history_asset'");
      assert.deepStrictEqual(keys.map((k) => k.Column_name), ['asset_id', 'seq'],
        'the history of one asset is one indexed read');

      const settings = await columnsOf('asset_settings');
      assert.strictEqual(settings.get('rename_enabled').d, '1', 'THE SWITCH SHIPS ON');
      const row = await sql(cfg, 'SELECT * FROM asset_settings');
      assert.strictEqual(row.length, 1, 'one studio-wide row');
      assert.strictEqual(Number(row[0].rename_enabled), 1);
      assert.ok(said.some((m) => /asset name editing is on/.test(m)), said);
    });

    await t.test('running it again changes nothing and says nothing new', async () => {
      const before = await sql(cfg, 'SELECT * FROM asset_settings');
      const columnsBefore = await columnsOf('asset_name_history');
      said.length = 0;
      await run();
      await run();
      assert.deepStrictEqual(await sql(cfg, 'SELECT * FROM asset_settings'), before,
        'the studio\'s own choice is not reset by a boot');
      assert.deepStrictEqual([...(await columnsOf('asset_name_history')).keys()].sort(),
        [...columnsBefore.keys()].sort());
      assert.deepStrictEqual(said, [], 'and a step with nothing to do is quiet');
    });

    await t.test('a database with data in it keeps all of it, and gains no history',
      async () => {
        /* A SWITCH SOMEBODY TURNED OFF, and an asset with a rename already
           recorded. Both must survive the step running again on the next boot —
           the failure this guards against is a migration that "resets to the
           default" and silently switches a studio's feature back on. */
        const asset = await sql(cfg, 'SELECT id, `name` FROM assets LIMIT 1');
        await sql(cfg, 'UPDATE asset_settings SET rename_enabled = 0 WHERE id = 1');
        let historyId = null;
        if (asset.length) {
          historyId = crypto.randomUUID();
          await sql(cfg,
            `INSERT INTO asset_name_history (id, asset_id, old_name, new_name, changed_by_email)
             VALUES (?,?,?,?,?)`,
            [historyId, asset[0].id, 'Before', 'After', 'someone@zvky.test']
          );
        }
        const assetsBefore = await sql(cfg, 'SELECT id, `code`, `name` FROM assets ORDER BY id');

        await run();

        assert.strictEqual(Number((await sql(cfg, 'SELECT * FROM asset_settings'))[0].rename_enabled), 0,
          'a studio that switched it off stays switched off');
        assert.deepStrictEqual(await sql(cfg, 'SELECT id, `code`, `name` FROM assets ORDER BY id'),
          assetsBefore, 'and not one asset row is touched');
        const rows = await sql(cfg, 'SELECT * FROM asset_name_history');
        assert.strictEqual(rows.length, historyId ? 1 : 0,
          'no backfill: an asset that was never renamed has no history row');
        if (historyId) assert.strictEqual(rows[0].id, historyId, 'and the one that was is as it was');
      });
  });
