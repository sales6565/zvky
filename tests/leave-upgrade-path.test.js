/* THE UPGRADE PATH, WHICH IS THE ONE A PRODUCTION DATABASE TAKES.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS, AND WHAT IT CLOSES.
 *
 * tests/helpers.js resetSchema() applies sql/schema.sql and the server's
 * migrations then run at boot. leave_settings, user_day_status and
 * leave_requests are NOT in schema.sql — migrate.js creates them — and the
 * CREATE statements there already carry every column these features need. So a
 * fresh install never exercises a single ALTER, and every test in this
 * repository was a fresh install.
 *
 * A production database is the other case: the tables already exist, in the
 * shape the LAST RELEASE left them, and the columns have to arrive by ALTER. A
 * missing one there is a 500 on save while every fresh-schema test passes —
 * which is precisely the failure mode Prompt 56 went looking for.
 *
 * SO THIS BUILDS THE TABLES AS THE LAST RELEASE LEFT THEM and lets the real
 * migrations run over them, twice, and then uses the features. The DDL below is
 * the Prompt 48 migration (commit 1912c99) verbatim in its columns: no
 * client_id, no request_id, none of the five vacation columns, and no
 * leave_requests at all.
 *
 * IT IS DELIBERATELY A LITERAL AND NOT `git show`. A test that read the old DDL
 * out of history would pass the day somebody rewrote history, and would fail
 * for a reason that had nothing to do with the code. This is a fixture: the
 * shape a deployed studio has, written down.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const leaveSettings = require('../src/leave-settings');

const cfg = config('leaveupgrade');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'LeaveUpgrade-1!';

/* ---- the last released shape ------------------------------------------- */

const RELEASED_LEAVE_SETTINGS = `CREATE TABLE IF NOT EXISTS leave_settings (
  id                        TINYINT     NOT NULL PRIMARY KEY,
  enabled                   TINYINT(1)  NOT NULL DEFAULT 0,
  first_half_end_minutes    SMALLINT    NULL,
  second_half_start_minutes SMALLINT    NULL,
  updated_by                CHAR(36)    NULL,
  updated_at                DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

const RELEASED_DAY_STATUS = `CREATE TABLE IF NOT EXISTS user_day_status (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  seq           BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
  user_id       CHAR(36)     NOT NULL,
  \`date\`        DATE         NOT NULL,
  kind          VARCHAR(16)  NOT NULL,
  \`portion\`     VARCHAR(16)  NULL,
  window_start_time SMALLINT NULL,
  window_end_time   SMALLINT NULL,
  note          VARCHAR(500) NULL,
  set_by        CHAR(36)     NULL,
  set_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_by    CHAR(36)     NULL,
  cleared_at    DATETIME     NULL,
  clear_reason  VARCHAR(255) NULL,
  source        VARCHAR(16)  NOT NULL DEFAULT 'manual',
  active_date   DATE AS (CASE WHEN cleared_at IS NULL THEN \`date\` END) STORED,
  UNIQUE KEY uq_day_status_active (user_id, active_date),
  KEY idx_day_status_date (\`date\`, kind),
  KEY idx_day_status_user (user_id, \`date\`)
)`;

/* EVERY COLUMN THESE FEATURES READ, named one at a time rather than as a count.
   A count would pass if a column were renamed, and the point of this list is
   that a production save cannot hit an Unknown column. */
const NEEDED = {
  leave_settings: ['id', 'enabled', 'first_half_end_minutes', 'second_half_start_minutes',
    'updated_by', 'updated_at', 'vacation_enabled', 'vacation_require_approval',
    'vacation_min_notice_days', 'vacation_max_range_days', 'vacation_email_enabled'],
  user_day_status: ['id', 'seq', 'user_id', 'date', 'kind', 'portion', 'window_start_time',
    'window_end_time', 'note', 'set_by', 'set_at', 'cleared_by', 'cleared_at', 'clear_reason',
    'source', 'active_date', 'client_id', 'request_id'],
  leave_requests: ['id', 'seq', 'user_id', 'from_date', 'to_date', 'from_portion', 'to_portion',
    'note', 'status', 'requested_by', 'requested_at', 'decided_by', 'decided_at',
    'decision_note', 'ended_on'],
};

async function releasedSchema() {
  await resetSchema(cfg);
  await sql(cfg, RELEASED_LEAVE_SETTINGS);
  await sql(cfg, RELEASED_DAY_STATUS);
  await sql(cfg, 'INSERT IGNORE INTO leave_settings (id, enabled) VALUES (1, 0)');
}

const columnsOf = async (table) => (await sql(cfg, `SHOW COLUMNS FROM \`${table}\``)).map((r) => r.Field);
const tableExists = async (table) => (await sql(cfg, `SHOW TABLES LIKE '${table}'`)).length > 0;

test('the defaults the code ships with', () => {
  /* ALL THREE PLACES AGREE, which is the whole of the claim "available by
     default": the module's fallback, the fresh install's CREATE, and the ALTER
     an upgraded database takes. */
  assert.strictEqual(leaveSettings.DEFAULTS.enabled, true);
  assert.strictEqual(leaveSettings.DEFAULTS.vacationEnabled, true);
  assert.strictEqual(leaveSettings.DEFAULTS.firstHalfEndMinutes, null,
    'and the split is still unset rather than defaulted, so the prefill stays a suggestion');

  const migrate = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  assert.match(migrate, /enabled\s+TINYINT\(1\)\s+NOT NULL DEFAULT 1/,
    'the fresh install creates it on');
  assert.match(migrate, /vacation_enabled\s+TINYINT\(1\)\s+NOT NULL DEFAULT 1/,
    'and Vacation mode too');
  assert.match(migrate, /\['vacation_enabled', 'TINYINT\(1\) NOT NULL DEFAULT 1'\]/,
    'and an upgraded database gets the column already on — it never existed, '
    + 'so no admin can have chosen otherwise');
});

test('a fresh install has both switches on', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });
  await resetSchema(cfg);
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-fresh', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'lu-fresh', name: 'Root', email: 'root@lu.test', password: PASSWORD } });
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@lu.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);

  const read = await api(server.base, '/admin/settings/leave', { token });
  assert.strictEqual(read.status, 200);
  assert.strictEqual(read.body.settings.enabled, true, 'Leave, Idle & Onsight is on');
  assert.strictEqual(read.body.settings.vacationEnabled, true, 'and so is Vacation mode');
  /* AND THE FEATURES ARE USABLE WITH NO FURTHER SETUP, which is what "available
     by default" has to mean: the Super Admin can mark somebody and book a
     vacation without visiting Settings at all. */
  assert.strictEqual(read.body.split.source !== 'saved', true,
    'the split is still a prefill — nobody has chosen it');
  const mine = await api(server.base, '/leave/mine', { token });
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.body.rules.enabled, true, 'the profile offers Vacation mode');
  assert.strictEqual(mine.body.rules.leaveEnabled, true);

  /* AND THE DASHBOARD BUTTONS ARE THERE, WITH NO OTHER SETUP. The brief asks
     for exactly this: after the fix a Super Admin sees the buttons and the
     Vacation section immediately. Three things have to be true at once and all
     three are the server's answer, not the page's guess — the switch travels in
     the follow-up payload, and the three marking keys travel on /auth/me. */
  const dash = await api(server.base, '/admin-dashboard/follow-up', { token });
  assert.strictEqual(dash.status, 200, JSON.stringify(dash.body));
  assert.strictEqual(dash.body.leave.enabled, true,
    'the section is told the feature is on, so it draws the buttons');
  const held = (await api(server.base, '/auth/me', { token })).body.user.permissions;
  for (const key of ['followup.mark_leave', 'followup.mark_idle', 'followup.mark_onsight',
    'leave.request', 'leave.view_team', 'leave.approve', 'leave.manage_all']) {
    assert.ok(held.includes(key), `the Super Admin holds ${key} out of the box`);
  }
  /* The three times the Leave menu offers, so the menu is usable the moment it
     opens rather than after somebody has chosen a split. */
  assert.match(dash.body.leave.firstHalfEnd, /^\d{2}:\d{2}$/);
  assert.match(dash.body.leave.secondHalfStart, /^\d{2}:\d{2}$/);

  /* AND THE PROFILE IS NOT BEHIND ANOTHER SCREEN. There is no profile PAGE in
     this single-page application; the header carries a permanently visible
     Profile button with no permission gate at all, and the Vacation section is
     a labelled section inside what it opens — beside the person's own email and
     push preferences, which is where everything somebody sets about themselves
     already lives. Asserted off the page so a redesign that buried it fails. */
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /<button class="btn btn-ghost btn-sm" id="profileBtn">Profile<\/button>/,
    'the Profile button is in the header');
  assert.ok(!/UI_GATES\[[^\]]*profileBtn/.test(page) && !/profileBtn:\s*\(\)/.test(page),
    'and it is gated by nothing');
  assert.match(page, /id="pf_vac_section"/, 'the Vacation section is in the profile');
  assert.match(page, /id="pf_vac_from"[\s\S]{0,400}id="pf_vac_to"/,
    'with a From and a To date');
  assert.match(page, /id="pf_vac_banner"/, 'the active banner');
  assert.match(page, /data-vac-end=/, 'End early');
  assert.match(page, /data-vac-cancel=/, 'and Cancel');
});

test('an upgraded database gains every column, twice, and then works', { skip: SKIP }, async (t) => {
  await releasedSchema();

  const beforeLeave = await columnsOf('leave_settings');
  assert.ok(!beforeLeave.includes('vacation_enabled'),
    'the fixture really is the released shape, without the vacation columns');
  assert.ok(!(await columnsOf('user_day_status')).includes('client_id'));
  assert.strictEqual(await tableExists('leave_requests'), false);

  let server;
  t.after(() => { if (server) stopServer(server); });

  /* TWICE, in two boots, which is the idempotency check: a second run of the
     migrations must add nothing, change nothing and fail nothing. */
  for (const pass of [1, 2]) {
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: `lu-up-${pass}`, WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
    for (const [table, needed] of Object.entries(NEEDED)) {
      assert.strictEqual(await tableExists(table), true, `pass ${pass}: ${table} exists`);
      const have = await columnsOf(table);
      const missing = needed.filter((c) => !have.includes(c));
      assert.deepStrictEqual(missing, [], `pass ${pass}: ${table} is missing ${missing.join(', ')}`);
    }
    if (pass === 1) stopServer(server);
  }

  /* AND THE SAVE THE OWNER COULD NOT DO, on this upgraded database. */
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'lu-up-2', name: 'Root', email: 'root@lu2.test', password: PASSWORD } }).catch(() => {});
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@lu2.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);

  const saved = await api(server.base, '/admin/settings/leave', { method: 'PUT', token, body: {
    enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
    vacationEnabled: true, vacationRequireApproval: false,
    vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true } });
  assert.strictEqual(saved.status, 200, `the save works on an upgraded database: ${JSON.stringify(saved.body)}`);
  assert.strictEqual(saved.body.settings.enabled, true);
  assert.strictEqual(saved.body.settings.vacationEnabled, true);

  /* AND BOTH FEATURES WORK on it, end to end, which is more than the columns
     existing: an onsight mark needs client_id and a vacation needs request_id
     and leave_requests. */
  const me = (await api(server.base, '/auth/me', { token })).body.user;
  const client = (await api(server.base, '/clients', { method: 'POST', token, body: { name: 'Acme' } })).body.client;
  const project = (await api(server.base, '/projects', { method: 'POST', token,
    body: { name: 'Upgraded', clientId: client.id } })).body.project;
  const person = (await api(server.base, '/users', { method: 'POST', token,
    body: { name: 'Ana', email: 'ana@lu2.test', password: PASSWORD, role: 'game_artist' } })).body.user;
  await api(server.base, `/users/${person.id}`, { method: 'PATCH', token, body: { projectId: project.id } });

  const marked = await api(server.base, '/admin-dashboard/follow-up/day-status', { method: 'POST', token,
    body: { userId: person.id, kind: 'onsight', clientId: client.id } });
  assert.ok([200, 409].includes(marked.status), `onsight on an upgraded database: ${JSON.stringify(marked.body)}`);
  if (marked.status === 409) {
    assert.strictEqual(marked.body.code, 'non_working_day', JSON.stringify(marked.body));
  } else {
    assert.strictEqual(marked.body.status.clientId, client.id, 'client_id survived the upgrade');
  }

  const today = require('../src/timesheet-gate').istDate();
  const vac = require('../src/vacation');
  const booked = await api(server.base, '/leave/mine', { method: 'POST', token,
    body: { userId: person.id, from: vac.addDays(today, 3), to: vac.addDays(today, 5) } });
  assert.strictEqual(booked.status, 201, `a vacation on an upgraded database: ${JSON.stringify(booked.body)}`);
  assert.ok(booked.body.days.length, 'and its days were materialised');
  const rows = await sql(cfg, 'SELECT request_id FROM user_day_status WHERE request_id IS NOT NULL');
  assert.ok(rows.length, 'request_id survived the upgrade and is in use');
  assert.strictEqual(me.id === person.id, false);
});

test('the one-time flip touches only a row nobody has ever changed', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });

  /* CASE ONE: the released row, both off, no audit line. Brought to the new
     default, because it is at the old one by accident rather than by decision. */
  await releasedSchema();
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-flip-1', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  let row = (await sql(cfg, 'SELECT * FROM leave_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.enabled), 1, 'a never-touched row is switched on');
  assert.strictEqual(Number(row.vacation_enabled), 1);
  stopServer(server);

  /* AND AGAIN: idempotent, with nothing left to do. */
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-flip-1b', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  row = (await sql(cfg, 'SELECT * FROM leave_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.enabled), 1);
  stopServer(server);

  /* CASE TWO: an admin HAS changed these settings — there is a 'leave_updated'
     line — and they are off. Left exactly alone, because switching a feature on
     for a studio that decided against it is the same mistake as switching one
     off. */
  await releasedSchema();
  await sql(cfg,
    `INSERT INTO activity_log (id, actor_id, actor_name, actor_role, module, action,
       entity_type, entity_id, entity_label, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [require('node:crypto').randomUUID(), null, 'An Admin', 'super_admin', 'settings',
      'leave_updated', 'setting', 'leave_settings', 'Leave',
      'Changed the Leave settings: Leave, Idle & Onsight on → Leave, Idle & Onsight OFF']);

  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-flip-2', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  row = (await sql(cfg, 'SELECT * FROM leave_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.enabled), 0,
    'an admin’s choice is not overridden by a default change');
  assert.strictEqual(Number(row.vacation_enabled), 1,
    'though the brand-new column is on — it never existed, so there was no choice to override');
  /* AND THE PAIR IS THEREFORE INERT, which is the honest outcome: Vacation mode
     needs Leave & Idle, so a studio that turned the master off has both off. */
  const log = server.output();
  assert.match(log, /an admin has changed these settings before/,
    `the boot log says what it decided and why: ${log.slice(-600)}`);
  stopServer(server);

  /* CASE THREE: the flip ran, then an admin switched something off. The audit
     line their save wrote is what stops the next boot putting it back. */
  await releasedSchema();
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-flip-3', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'lu-flip-3', name: 'Root', email: 'root@lu3.test', password: PASSWORD } });
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@lu3.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);
  const off = await api(server.base, '/admin/settings/leave', { method: 'PUT', token, body: {
    enabled: false, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
    vacationEnabled: false, vacationRequireApproval: false,
    vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true } });
  assert.strictEqual(off.status, 200, JSON.stringify(off.body));
  assert.strictEqual(Number((await sql(cfg, 'SELECT * FROM leave_settings WHERE id = 1'))[0].enabled), 0);
  stopServer(server);

  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lu-flip-3b', WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  row = (await sql(cfg, 'SELECT * FROM leave_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.enabled), 0,
    'the admin switched it off and the next boot left it off');
  assert.strictEqual(Number(row.vacation_enabled), 0);
});
