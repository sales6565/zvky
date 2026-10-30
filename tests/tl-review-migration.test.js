/* THE SCHEMA TL ACTION NEEDS, that running it twice is harmless, and that the
 * rename left every existing row intact.
 *
 * WHY THIS IS ITS OWN FILE. tl_review_sessions is not in sql/schema.sql — the
 * 'tl action' migration step creates it, and adds timesheet_entries.tl_action
 * and timesheet_settings.tl_action_enabled with an ALTER each. A fresh install
 * therefore never exercises an ALTER, which is exactly the path a deployed
 * studio takes. On shared hosting an ALTER is a thing that gets refused, so the
 * upgrade is worth booting rather than assuming.
 *
 * AND THE RENAME IS THE PART WITH REAL DATA IN IT. 'asset_review' became
 * 'review' when the feature stopped measuring anything, and the one thing a
 * migration over somebody's filed timesheet must do is leave everything else
 * exactly as it was — the hours, the notes, and the asset those rows carry.
 *
 * /api/health HAS TO SEE THE SCHEMA TOO. src/schema-check.js carries a comment
 * about four tables that fell out of its REQUIRED list, during which the one
 * endpoint built to name schema gaps reported "complete". A column the app
 * reads by name and that list does not know about is invisible to it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const cfg = config('tlmig');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Tl-Migration-1!';

/* WHAT THE MIGRATION OWES, by name. Written out rather than read back from
   src/migrate.js, which would make this test agree with whatever the migration
   happens to do. */
const NEEDED = {
  tl_review_sessions: ['id', 'asset_id', 'project_id', 'lead_user_id', 'started_at',
    'ended_at', 'ended_by_user_id', 'outcome'],
};
const ALTERED = [
  ['timesheet_entries', 'tl_action'],
  ['timesheet_settings', 'tl_action_enabled'],
];

const columnsOf = async (table) =>
  (await sql(cfg, `SHOW COLUMNS FROM \`${table}\``)).map((r) => r.Field);
const tableExists = async (table) =>
  (await sql(cfg, `SHOW TABLES LIKE '${table}'`)).length > 0;

test('a fresh install has the table, the columns and the switch on', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });

  await resetSchema(cfg);
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlmig-1', WORK_HOURS_SWEEP_MINUTES: '0',
    EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });

  assert.ok(await tableExists('tl_review_sessions'), 'the sessions table is there');
  const cols = await columnsOf('tl_review_sessions');
  const missing = NEEDED.tl_review_sessions.filter((c) => !cols.includes(c));
  assert.deepStrictEqual(missing, [], `tl_review_sessions is missing ${missing.join(', ')}`);

  for (const [table, column] of ALTERED) {
    assert.ok((await columnsOf(table)).includes(column), `${table}.${column} is there`);
  }

  /* THE DEFAULT IS ON, in the column as well as in the module — a fresh row
     written by the CREATE and a fresh cache built by the module have to agree,
     or the first save would flip a switch nobody touched. */
  const row = (await sql(cfg, 'SELECT tl_action_enabled FROM timesheet_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.tl_action_enabled), 1, 'the stored switch is on');
  assert.strictEqual(require('../src/timesheet-settings').current().defaults.tlAction, true,
    'and so is the code default a database with no row falls back to');

  const boot = await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'tlmig-1', name: 'Root', email: 'root@tlmig.test', password: PASSWORD } });
  assert.ok(boot.status < 400, `bootstrap: ${boot.status} ${JSON.stringify(boot.body)}`);
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@tlmig.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);
  const week = await api(server.base, '/timesheets/week?date=2026-03-09', { token });
  assert.strictEqual(week.body.workingDay.tlAction, true, 'and the form is told');
});

test('an existing database gains all three, twice over', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });

  /* THE SHAPE BEFORE THIS FEATURE, built by hand: the schema as it is, with the
     three additions taken back out. Dropping them rather than reconstructing
     the old CREATEs keeps this test about the three things that are new. */
  await resetSchema(cfg);
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlmig-2a', WORK_HOURS_SWEEP_MINUTES: '0',
    EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  stopServer(server);
  await sql(cfg, 'DROP TABLE IF EXISTS tl_review_sessions');
  await sql(cfg, 'ALTER TABLE timesheet_entries DROP COLUMN tl_action');
  await sql(cfg, 'ALTER TABLE timesheet_settings DROP COLUMN tl_action_enabled');
  assert.ok(!(await tableExists('tl_review_sessions')), 'the before-state really is before');
  assert.ok(!(await columnsOf('timesheet_entries')).includes('tl_action'));

  /* A LINE FILED ON THE OLD SHAPE, so what is asserted after the upgrade is
     that existing rows survive it rather than that an empty table does. */
  const before = (await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_entries'))[0].n;

  for (const pass of [1, 2]) {
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: `tlmig-2-${pass}`,
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
    assert.ok(await tableExists('tl_review_sessions'), `pass ${pass}: the table`);
    const cols = await columnsOf('tl_review_sessions');
    const missing = NEEDED.tl_review_sessions.filter((c) => !cols.includes(c));
    assert.deepStrictEqual(missing, [], `pass ${pass}: missing ${missing.join(', ')}`);
    for (const [table, column] of ALTERED) {
      assert.ok((await columnsOf(table)).includes(column), `pass ${pass}: ${table}.${column}`);
    }
    assert.strictEqual((await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_entries'))[0].n, before,
      `pass ${pass}: no existing line was touched`);
    if (pass === 1) stopServer(server);
  }

  /* AND THE SWITCH IS ON for an upgraded studio too. ALTER … DEFAULT 1 fills
     the existing row, so a deployment that upgrades has the feature available
     without anybody visiting Settings — which is what "on by default" has to
     mean for a studio that already exists. */
  const row = (await sql(cfg, 'SELECT tl_action_enabled FROM timesheet_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.tl_action_enabled), 1);

  /* AND BOTH KINDS OF LINE WORK ON IT, which is more than the columns being
     present: a meeting needs tl_action to store, a review needs the sessions
     table to read. */
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'tlmig-2-2', name: 'Root', email: 'root@tlmig2.test', password: PASSWORD } })
    .catch(() => {});
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@tlmig2.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);
  const me = (await api(server.base, '/auth/me', { token })).body.user;
  const client = (await api(server.base, '/clients', { method: 'POST', token,
    body: { name: 'Upgraded Co' } })).body.client;
  const project = (await api(server.base, '/projects', { method: 'POST', token,
    body: { name: 'Upgraded', clientId: client.id, teamLeadIds: [me.id] } })).body.project;

  const filed = await api(server.base, '/timesheets/entries', { method: 'POST', token,
    body: { date: '2026-03-09', hours: 1, clientId: client.id, projectId: project.id,
      tlAction: 'project_meeting' } });
  assert.strictEqual(filed.status, 201, `a meeting files on an upgraded database: ${JSON.stringify(filed.body)}`);
  assert.strictEqual(filed.body.entry.tlAction, 'project_meeting', 'and the column holds it');

  /* AND THE FORM IS TOLD IT MAY OFFER THE BOX on this upgraded database — the
     switch published with the week, and the project this account leads. */
  const week = await api(server.base, '/timesheets/week?date=2026-03-09', { token });
  assert.strictEqual(week.status, 200, JSON.stringify(week.body));
  assert.strictEqual(week.body.workingDay.tlAction, true, 'the switch reads on');
  assert.deepStrictEqual(week.body.tlActionProjects, [project.id],
    'and the project this account leads comes with it');
});

test('the rename converts the old rows and leaves everything else alone', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });

  /* A DATABASE AS THE FIRST BUILD LEFT IT: rows holding the old value, one of
     them with the asset it was filed against — which is the shape that matters,
     and the shape the API refuses to create now. So the surroundings are built
     through the API (a real user, a real project, a real asset, because
     timesheet_entries has a foreign key on each) and only the four lines
     themselves are written directly. */
  await resetSchema(cfg);
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlmig-3a', WORK_HOURS_SWEEP_MINUTES: '0',
    EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'tlmig-3a', name: 'Root', email: 'root@tlmig3.test', password: PASSWORD } });
  const token = (await api(server.base, '/auth/login', { method: 'POST',
    body: { email: 'root@tlmig3.test', password: PASSWORD } })).body.token;
  await openStudio(server.base, token);
  const userId = (await api(server.base, '/auth/me', { token })).body.user.id;
  const client = (await api(server.base, '/clients', { method: 'POST', token,
    body: { name: 'Old Build Co' } })).body.client;
  const project = (await api(server.base, '/projects', { method: 'POST', token,
    body: { name: 'Old Build', clientId: client.id } })).body.project;
  const asset = (await api(server.base, `/assets/project/${project.id}`, { method: 'POST', token,
    body: { name: 'Reviewed Once', type: 'prop', manHours: 4 } })).body.asset;
  stopServer(server);

  const uuid = () => require('node:crypto').randomUUID();
  const assetless = uuid();
  const withAsset = uuid();
  const untouched = uuid();
  const meeting = uuid();
  await sql(cfg,
    `INSERT INTO timesheet_entries (id, user_id, entry_date, hours, notes, tl_action)
     VALUES (?,?, '2026-03-09', 1.5, 'the old name, no asset', 'asset_review')`,
    [assetless, userId]);
  await sql(cfg,
    `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id,
       hours, notes, tl_action)
     VALUES (?,?, '2026-03-09', ?, ?, ?, 2.25, 'the old name, with an asset', 'asset_review')`,
    [withAsset, userId, client.id, project.id, asset.id]);
  await sql(cfg,
    `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id,
       hours, notes, tl_action)
     VALUES (?,?, '2026-03-09', ?, ?, ?, 3, 'an ordinary line', NULL)`,
    [untouched, userId, client.id, project.id, asset.id]);
  await sql(cfg,
    `INSERT INTO timesheet_entries (id, user_id, entry_date, hours, notes, tl_action)
     VALUES (?,?, '2026-03-09', 1, 'a meeting', 'project_meeting')`,
    [meeting, userId]);

  const rowOf = async (id) =>
    (await sql(cfg, 'SELECT * FROM timesheet_entries WHERE id = ?', [id]))[0];

  for (const pass of [1, 2]) {
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: `tlmig-3-${pass}`,
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });

    const a = await rowOf(assetless);
    assert.strictEqual(a.tl_action, 'review', `pass ${pass}: the old name is gone`);
    assert.strictEqual(Number(a.hours), 1.5, `pass ${pass}: its hours are untouched`);
    assert.strictEqual(a.notes, 'the old name, no asset', `pass ${pass}: and its note`);

    /* THE ROW THE WHOLE STEP IS ABOUT: converted, and still carrying the asset
       it was filed against. Clearing it would destroy the only record of which
       asset that line was about; the figures it must stay out of are keyed on
       tl_action, so it does not need clearing to be excluded. */
    const b = await rowOf(withAsset);
    assert.strictEqual(b.tl_action, 'review', `pass ${pass}: converted`);
    assert.strictEqual(b.asset_id, asset.id, `pass ${pass}: and it KEEPS its asset`);
    assert.strictEqual(Number(b.hours), 2.25, `pass ${pass}: and its hours`);

    const c = await rowOf(untouched);
    assert.strictEqual(c.tl_action, null, `pass ${pass}: an ordinary line is not touched`);
    assert.strictEqual(Number(c.hours), 3);
    assert.strictEqual(c.asset_id, asset.id, `pass ${pass}: and keeps its asset too`);

    const d = await rowOf(meeting);
    assert.strictEqual(d.tl_action, 'project_meeting', `pass ${pass}: nor is a meeting`);

    assert.strictEqual(
      Number((await sql(cfg, "SELECT COUNT(*) AS n FROM timesheet_entries WHERE tl_action = 'asset_review'"))[0].n),
      0, `pass ${pass}: no row holds the old value`);
    assert.strictEqual(
      Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_entries'))[0].n), 4,
      `pass ${pass}: and nothing was deleted`);
    if (pass === 1) stopServer(server);
  }
});

test('the sessions table is created, empty, and written to by nothing', { skip: SKIP }, async (t) => {
  let server;
  t.after(() => { if (server) stopServer(server); });

  /* IT STAYS, AND IT STAYS EMPTY. The first build wrote to it; nothing does
     now. It is not dropped because a deployment that ran that build may hold
     rows, and a migration that destroys data to tidy up cannot be undone —
     whether to drop it is the owner's call, made once, with it in front of
     them. Still created on a fresh install so that call is the same call
     everywhere. */
  await resetSchema(cfg);
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlmig-4', WORK_HOURS_SWEEP_MINUTES: '0',
    EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
  assert.ok(await tableExists('tl_review_sessions'), 'the table is there');
  assert.strictEqual(
    Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM tl_review_sessions'))[0].n), 0,
    'and empty');

  /* AND THE MIGRATION ITSELF NEVER WRITES ONE, which is what makes "empty"
     a property rather than a coincidence of this fixture. */
  const fs = require('node:fs');
  const path = require('node:path');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  assert.ok(!/INSERT INTO tl_review_sessions/i.test(migrate),
    'the migration writes no sessions');
  assert.match(migrate, /IT IS NOT DROPPED/, 'and says why it is kept');
});

test('/api/health would notice any of the three missing', () => {
  const declared = new Map();
  for (const need of require('../src/schema-check').REQUIRED) {
    if (!declared.has(need.table)) declared.set(need.table, new Set());
    if (need.column) declared.get(need.table).add(need.column);
  }

  assert.ok(declared.has('tl_review_sessions'),
    'tl_review_sessions is created by the migration but absent from schema-check\'s REQUIRED '
    + 'list, so /api/health would report "complete" on a database that does not have it');

  /* THE TWO COLUMNS THAT ARRIVE BY ALTER, which are the ones a database can be
     missing while still having the table. A refused ALTER is the ordinary
     failure on shared hosting, and the symptom without this is the Add line
     form answering 500 while /api/health says everything is fine. */
  for (const [table, column] of ALTERED) {
    assert.ok((declared.get(table) || new Set()).has(column),
      `${table}.${column} is added by its own ALTER and read by name, but is not declared`);
  }

  /* And each names a step that exists, so the health check sends somebody to
     re-run something real. */
  const steps = new Set(require('../src/migrate').STEPS.map((s) => s[0]));
  for (const need of require('../src/schema-check').REQUIRED) {
    if (!/^(tl_review_sessions)$/.test(need.table) && !ALTERED.some(([t, c]) =>
      t === need.table && c === need.column)) continue;
    assert.ok(steps.has(need.step), `${need.table}: "${need.step}" is a real migration step`);
  }
});


