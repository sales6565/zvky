/* Upgrading a studio that is already keeping weekly timesheets.
 *
 * The rest of the timesheet suite starts from the current schema, which is the
 * easy case. This one starts from the schema that shipped — timesheet_weeks,
 * entries with a week_start and no clock — puts real rows in it, and runs the
 * migration the way a deployment does on its next restart.
 *
 * It is the only test in the suite that can catch the failure that matters
 * most here: somebody's already-approved hours arriving as a broken row, or
 * not arriving at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { config, sql, SKIP_REASON } = require('./helpers');

const cfg = config('tsmig');
const OLD_SCHEMA = '3865766';   // the last commit on the weekly shape

test('a weekly timesheet install migrates to the daily one', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const mysql = require('mysql2/promise');
  const { execFileSync } = require('node:child_process');

  // 1. Stand up the schema as it shipped, weekly tables and all.
  const shipped = execFileSync('git', ['show', `${OLD_SCHEMA}:sql/schema.sql`],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const admin = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
  await admin.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${cfg.database}\``);
  await admin.query(shipped);
  await admin.end();

  const has = async (table) => (await sql(cfg,
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`)).length > 0;
  assert.ok(await has('timesheet_weeks'), 'the fixture really is the weekly shape');

  /* And a work_schedule as it stood before the window was a setting: the two
     columns it had, holding a studio that had already changed its hours. The
     upgrade must add the clock without touching what they set. */
  await sql(cfg, `
    CREATE TABLE work_schedule (
      id            TINYINT      NOT NULL PRIMARY KEY,
      hours_per_day DECIMAL(4,2) NOT NULL DEFAULT 8.00,
      working_days  VARCHAR(32)  NOT NULL DEFAULT '1,2,3,4,5',
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
    INSERT INTO work_schedule (id, hours_per_day, working_days) VALUES (1, 7.50, '1,2,3,4,5,6');
  `);

  // 2. A person with a week already approved, and a second week still in draft.
  const U = '11111111-1111-1111-1111-111111111111';
  await sql(cfg, `
    INSERT INTO users (id, \`name\`, email, password_hash, \`role\`)
      VALUES ('${U}', 'Ana Diaz', 'ana@zvky.test', 'x', 'game_artist');
    INSERT INTO timesheet_weeks (id, user_id, week_start, status, submitted_at, decider_email, decided_at)
      VALUES (UUID(), '${U}', '2026-03-02', 'approved', '2026-03-09 09:00:00', 'lee@zvky.test', '2026-03-09 10:00:00');
    INSERT INTO timesheet_weeks (id, user_id, week_start, status)
      VALUES (UUID(), '${U}', '2026-03-09', 'draft');
    INSERT INTO timesheet_entries (id, user_id, week_start, entry_date, non_project, hours, notes, created_at) VALUES
      ('e1', '${U}', '2026-03-02', '2026-03-02', 'admin', 3.00, 'first',  '2026-03-02 18:00:00'),
      ('e2', '${U}', '2026-03-02', '2026-03-02', 'admin', 2.00, 'second', '2026-03-02 18:00:01'),
      ('e3', '${U}', '2026-03-02', '2026-03-02', 'admin', 4.00, 'third',  '2026-03-02 18:00:02'),
      ('e4', '${U}', '2026-03-02', '2026-03-04', 'leave', 8.00, 'a full day', '2026-03-04 18:00:00'),
      ('e5', '${U}', '2026-03-09', '2026-03-09', 'admin', 1.50, 'next week', '2026-03-09 18:00:00');
    INSERT INTO timesheet_events (id, user_id, week_start, actor_email, action, detail)
      VALUES (UUID(), '${U}', '2026-03-02', 'ana@zvky.test', 'submitted', 'the week');
  `);

  /* 3. Run the migration the way a restart does — through the real db module,
     pointed at this database. src/db reads its settings from the environment
     when it is first required, and node's test runner gives each file its own
     process, so setting them here is enough and affects nothing else. */
  process.env.DB_HOST = cfg.host;
  process.env.DB_PORT = String(cfg.port);
  process.env.DB_USER = cfg.user;
  process.env.DB_PASSWORD = cfg.password;
  process.env.DB_NAME = cfg.database;
  delete process.env.DATABASE_URL;
  const db = require('../src/db');
  /* The pool has to be closed however this ends. Left open on a failed
     assertion it holds the process alive, and a test process that never exits
     hangs the runner with its output still buffered — the failure disappears
     behind a timeout instead of being reported. */
  t.after(() => db.end().catch(() => {}));
  const said = [];
  await require('../src/migrate').run(db, (line) => said.push(String(line)));

  // --- the weekly shape is gone -------------------------------------------
  assert.strictEqual(await has('timesheet_weeks'), false, 'timesheet_weeks is dropped');
  const entryCols = (await sql(cfg,
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_entries'`)).map((r) => r.c);
  assert.ok(!entryCols.includes('week_start'), 'and so is the entries week_start');
  assert.ok(entryCols.includes('start_min') && entryCols.includes('end_min'), 'the clock arrived');

  // --- nobody's hours were lost -------------------------------------------
  const lines = await sql(cfg,
    `SELECT id, DATE_FORMAT(entry_date, '%Y-%m-%d') AS day, start_min AS s, end_min AS e, hours
       FROM timesheet_entries ORDER BY entry_date, start_min`);
  assert.strictEqual(lines.length, 5, 'every line survived');
  assert.strictEqual(lines.reduce((n, l) => n + Number(l.hours), 0), 18.5, 'and every hour');

  /* Monday's three lines are laid end to end from 09:30, stepping over lunch:
     3h from 09:30 fills 09:30-12:30; 2h would cross 13:00 so it starts at
     14:00 and runs to 16:00; 4h then runs 16:00-19:00 and stops at the end of
     the day rather than inventing an evening. */
  const monday = lines.filter((l) => l.day === '2026-03-02');
  assert.deepStrictEqual(monday.map((l) => [Number(l.s), Number(l.e)]),
    [[570, 750], [840, 960], [960, 1140]], 'laid end to end, around lunch, inside the day');
  for (const line of lines) {
    assert.ok(Number(line.s) >= 570 && Number(line.e) <= 1140,
      `line ${line.id} sits inside the working day`);
    assert.ok(Number(line.e) > Number(line.s), `line ${line.id} ends after it starts`);
  }

  // --- the week's verdict reached each of its days -------------------------
  const days = await sql(cfg,
    `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS d, status, decider_email AS decider
       FROM timesheet_days ORDER BY work_date`);
  assert.deepStrictEqual(days.map((d) => [d.d, d.status]), [
    ['2026-03-02', 'approved'],
    ['2026-03-04', 'approved'],
    ['2026-03-09', 'draft'],
  ], 'a day per day that had lines, carrying its week\'s status');
  assert.strictEqual(days[0].decider, 'lee@zvky.test', 'and who decided it');

  /* --- the working day became a setting, without changing what it was ------
     The values seeded are exactly the constants that were compiled into the
     Time Sheet before this, so a studio upgrading gets the behaviour it already
     had and can then change it. What they had already set is left alone. */
  const schedule = (await sql(cfg,
    `SELECT hours_per_day AS hours, working_days AS days, day_start_min AS ds,
            day_end_min AS de, lunch_start_min AS ls, lunch_end_min AS le
       FROM work_schedule WHERE id = 1`))[0];
  assert.strictEqual(Number(schedule.hours), 7.5, 'their hours per day is untouched');
  assert.strictEqual(schedule.days, '1,2,3,4,5,6', 'and so are their working days');
  assert.deepStrictEqual(
    [Number(schedule.ds), Number(schedule.de), Number(schedule.ls), Number(schedule.le)],
    [570, 1140, 780, 840],
    'and the window arrives as 09:30-19:00 with lunch 13:00-14:00');

  // --- the audit trail keys on the day now, without losing its history -----
  const events = await sql(cfg, `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS d, action FROM timesheet_events`);
  assert.strictEqual(events.length, 1, 'the old event is still there');
  assert.strictEqual(events[0].d, '2026-03-02');

  /* --- and it is safe to run twice ----------------------------------------
     Which is not a hypothetical: a deployment restarts, and every restart runs
     the whole chain again. A migration that is only correct the first time
     corrupts the data on the second. */
  await require('../src/migrate').run(db, () => {});
  const after = await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_entries');
  assert.strictEqual(Number(after[0].n), 5, 'a second restart changes nothing');
  const daysAgain = await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_days');
  assert.strictEqual(Number(daysAgain[0].n), 3, 'and does not duplicate the days');
});
