/* Upgrading a running Forge to the Dev & QA contract, version 1.
 *
 * Starts from the schema as it stood before the contract (every startup step but
 * the contract's), with rows already in it: clients, a project, Game Feedback of
 * both legacy kinds and an outbox row. Then runs the startup migration the way a
 * restart does, twice, and checks that existing data is kept exactly — including
 * every timestamp — and that the second run changes nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { config, sql, SKIP_REASON } = require('./helpers');

const cfg = config('contractmig');

test('the contract migration keeps existing data and is safe to rerun', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
  await admin.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${cfg.database}\``);
  await admin.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));
  await admin.end();

  process.env.DB_HOST = cfg.host;
  process.env.DB_PORT = String(cfg.port);
  process.env.DB_USER = cfg.user;
  process.env.DB_PASSWORD = cfg.password;
  process.env.DB_NAME = cfg.database;
  delete process.env.DATABASE_URL;
  const db = require('../src/db');
  t.after(() => db.end().catch(() => {}));
  const migrate = require('../src/migrate');

  // 1. The schema as it stood before the contract: every step but its own.
  for (const [name, step] of migrate.STEPS) if (name !== 'integration contract v1') await step(db, () => {});
  const cols = async (table) => (await sql(cfg, `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`)).map((r) => r.n);
  assert.ok(!(await cols('external_feedback')).includes('state'), 'the fixture really is pre-contract');
  assert.ok(!(await cols('clients')).includes('updated_at'));

  // 2. Rows a studio already has.
  const U = '11111111-1111-1111-1111-111111111111';
  const C = '22222222-2222-2222-2222-222222222222';
  const P = '33333333-3333-3333-3333-333333333333';
  const A = '44444444-4444-4444-4444-444444444444';
  await sql(cfg, `
    INSERT INTO users (id, \`name\`, email, password_hash, \`role\`) VALUES ('${U}', 'Ana Diaz', 'ana@zvky.test', 'x', 'super_admin');
    INSERT INTO clients (id, \`name\`, created_at) VALUES ('${C}', 'Neon Client', '2026-08-01 09:00:00');
    INSERT INTO projects (id, client_id, \`name\`, \`code\`, owner_id, created_at) VALUES ('${P}', '${C}', 'Neon Game', 'NG', '${U}', '2026-08-02 09:00:00');
    INSERT INTO assets (id, project_id, \`code\`, \`name\`, \`type\`) VALUES ('${A}', '${P}', 'NG-A1', 'Reel symbol', 'prop');
    INSERT INTO external_feedback (id, asset_id, round, source, bug_ref, note, prev_status, created_at, updated_at) VALUES
      ('55555555-5555-5555-5555-555555555551', '${A}', 1, 'dev_qa', 'NG-101', 'a note', NULL, '2026-09-01 10:00:00', '2026-09-01 10:00:00'),
      ('55555555-5555-5555-5555-555555555552', '${A}', 2, 'dev_qa', 'NG-102', 'moved it', 'approved', '2026-09-02 11:00:00', '2026-09-03 12:00:00');
  `);
  const fb = async () => sql(cfg, 'SELECT id, round, bug_ref, note, prev_status, created_at, updated_at FROM external_feedback ORDER BY id');
  const before = JSON.stringify(await fb());
  const outboxBefore = JSON.stringify(await sql(cfg, 'SELECT * FROM integration_outbox ORDER BY seq'));

  // 3. The restart that brings the contract in.
  const said = [];
  await migrate.run(db, (line) => said.push(String(line)));
  assert.ok(!said.some((l) => /could not be applied|did not apply/.test(l)), said.join('\n'));
  assert.ok(said.some((l) => /external_feedback carries the Dev & QA bug fields/.test(l)));

  assert.equal(JSON.stringify(await fb()), before, 'every existing feedback field, timestamps included, is kept');
  const states = await sql(cfg, 'SELECT bug_ref, `state` FROM external_feedback ORDER BY bug_ref');
  assert.deepStrictEqual(states.map((r) => [r.bug_ref, r.state]), [['NG-101', 'noted_legacy'], ['NG-102', 'legacy']]);
  const [client] = await sql(cfg, `SELECT created_at, updated_at FROM clients WHERE id = '${C}'`);
  assert.equal(String(client.updated_at), String(client.created_at), 'the new cursor column starts at created_at');
  const [project] = await sql(cfg, `SELECT created_at, updated_at FROM projects WHERE id = '${P}'`);
  assert.equal(String(project.updated_at), String(project.created_at));
  assert.equal(JSON.stringify((await sql(cfg, 'SELECT * FROM integration_outbox ORDER BY seq')).map((r) => { const { event_type, entity_type, entity_id, entity_version, project_id, ...rest } = r; return rest; })), outboxBefore);

  // 4. Every later restart: nothing to do, nothing changed.
  const snapshot = async () => JSON.stringify([await fb(), await sql(cfg, 'SELECT bug_ref, `state` FROM external_feedback ORDER BY bug_ref'), await sql(cfg, 'SELECT * FROM clients ORDER BY id'), await sql(cfg, 'SELECT * FROM projects ORDER BY id')]);
  const settled = await snapshot();
  const again = [];
  await migrate.run(db, (line) => again.push(String(line)));
  assert.ok(!again.some((l) => /integration_outbox carries|added clients\.updated_at|added projects\.updated_at|external_feedback carries/.test(l)), again.join('\n'));
  assert.equal(await snapshot(), settled);
});
