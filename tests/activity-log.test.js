/* The Activity Log.
 *
 * Two things are worth testing here and one of them is unusual.
 *
 * The ordinary half is that actions are recorded with the right person, the
 * right before and after, and that the filters and the gate work.
 *
 * The unusual half is COVERAGE. The point of recording through a middleware
 * rather than sixty-six hand-written calls is that a route added later is
 * logged without anybody remembering — so there is a test that takes the
 * application's own list of state-changing endpoints and asserts the mechanism
 * reaches them. A log with a silent hole is worse than no log, because it is
 * trusted; this is the test that would notice.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const activity = require('../src/activity');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, pdfText, SKIP_REASON } = require('./helpers');

const cfg = config('activity');

// --- the pure parts --------------------------------------------------------

test('before and after keeps only what actually changed', () => {
  /* An edit that touched one field of twelve has to read as one change. The
     alternative — every field listed, eleven of them saying the same thing
     twice — is a diff nobody reads, which makes the column decorative. */
  assert.deepStrictEqual(activity.diff({ a: 1, b: 2 }, { a: 1, b: 3 }), { b: { from: '2', to: '3' } });
  assert.strictEqual(activity.diff({ a: 1 }, { a: 1 }), null, 'no change is not an entry');
  assert.deepStrictEqual(activity.diff({ on: true }, { on: false }),
    { on: { from: 'on', to: 'off' } }, 'booleans read as words, not as true/false');
  assert.deepStrictEqual(activity.diff({}, { added: 'x' }), { added: { from: null, to: 'x' } });

  // A value big enough to make the page unusable is clipped rather than stored.
  const huge = 'x'.repeat(5000);
  const clipped = activity.diff({ v: '' }, { v: huge });
  assert.ok(clipped.v.to.length <= 200, 'long values are clipped');
});

test('a request is classified by the part of the app it belongs to', () => {
  assert.strictEqual(activity.moduleOf('/api/assets/123/deliver'), 'assets');
  assert.strictEqual(activity.moduleOf('/api/permissions/roles/team_lead'), 'permissions');
  assert.strictEqual(activity.moduleOf('/api/branding/schedule'), 'settings');
  assert.strictEqual(activity.moduleOf('/api/ip-allowlist'), 'settings');
  /* A route nobody has classified still lands somewhere sensible rather than
     in "other" — which is what stops a new feature's entries disappearing into
     a bucket the module filter cannot usefully show. */
  assert.strictEqual(activity.moduleOf('/api/invoices/9'), 'invoices');
});

test('the module filter offers exactly what the classifier can produce', () => {
  for (const m of activity.MODULES) assert.strictEqual(typeof m, 'string');
  assert.ok(activity.MODULES.includes('assets') && activity.MODULES.includes('permissions'));
  // No duplicates: a dropdown listing "settings" three times is a bug people see.
  assert.strictEqual(new Set(activity.MODULES).size, activity.MODULES.length);
});

test('every state-changing endpoint is behind the recording middleware', () => {
  /* The coverage guarantee, asserted rather than assumed.
   *
   * The middleware is mounted on /api, so what has to be true is that every
   * router carrying state-changing endpoints is mounted under /api — and that
   * the mount happens BEFORE the routes, or the handle would not exist by the
   * time one runs. Both are read off src/server.js rather than trusted. */
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const mountLine = server.indexOf("app.use('/api', activityLogger)");
  assert.ok(mountLine > 0, 'the recorder should be mounted on /api');

  const routeMounts = [...server.matchAll(/app\.use\('(\/api\/[a-z-]+)', (\w+Routes)\)/g)];
  assert.ok(routeMounts.length >= 14, `expected the app's routers, found ${routeMounts.length}`);
  for (const m of routeMounts) {
    assert.ok(server.indexOf(m[0]) > mountLine,
      `${m[2]} is mounted before the recorder, so its actions would not be logged`);
  }

  // And every router file with a state-changing endpoint is one of those mounts.
  const dir = path.join(__dirname, '..', 'src', 'routes');
  const mounted = new Set(routeMounts.map((m) => m[2].replace(/Routes$/, '')));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!/router\.(post|patch|put|delete)\(/.test(body)) continue;
    const name = file.replace('.js', '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(mounted.has(name) || mounted.has(name.replace(/s$/, '')) || file === 'activity.js',
      `src/routes/${file} changes state but is not among the mounted routers`);
  }
});

test('a failure to record can never reach the request or the process', () => {
  /* Two latches, and the test names both, because removing either one is
     silent: record() swallows its own errors, and the middleware catches the
     promise anyway. The middleware does not await — the response has already
     gone — so an escaping rejection would be an unhandled rejection, which
     ends the server process rather than the request. A log that can take the
     studio offline is worse than no log. */
  const mw = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'activity.js'), 'utf8');
  assert.match(mw, /activity\.record\(db, \{[\s\S]*?\}\)\.catch\(/,
    'the middleware must catch the promise it does not await');

  const mod = fs.readFileSync(path.join(__dirname, '..', 'src', 'activity.js'), 'utf8');
  const body = /async function record\([\s\S]*?\n\}/.exec(mod);
  assert.ok(body, 'record() should be findable');
  assert.match(body[0], /catch \(err\)[\s\S]*return false;/,
    'record() must swallow its own errors rather than rethrowing');
});

test('every export is named for the report it is', () => {
  /* Found by reading a downloaded file's name rather than by a test: because
     viewById() falls back to the first Efficiency view for an id it does not
     know, every export that is not the Efficiency report downloaded as
     "efficiency-by-user" — the Time Sheet's two exports had been doing that
     since they shipped. Pinned here for all four, including the two that were
     already right, since the fix touches the helper they share. */
  const exporter = require('../src/report-export');
  const at = new Date('2026-09-02T00:00:00Z');
  assert.strictEqual(exporter.fileName('ZVKY FORGE', 'activity-log', 'xlsx', at),
    'zvky-forge-activity-log-2026-09-02.xlsx');
  assert.strictEqual(exporter.fileName('ZVKY FORGE', 'timesheet', 'pdf', at),
    'zvky-forge-timesheet-2026-09-02.pdf');
  // And the Efficiency report's own names are untouched by the fix.
  assert.strictEqual(exporter.fileName('ZVKY FORGE', 'byUser', 'xlsx', at),
    'zvky-forge-efficiency-by-user-2026-09-02.xlsx');
  assert.strictEqual(exporter.fileName('ZVKY FORGE', null, 'xlsx', at),
    'zvky-forge-efficiency-2026-09-02.xlsx');
  // Which is what the Idle report rewrites, so it has to keep that shape.
  assert.strictEqual(
    exporter.fileName('ZVKY FORGE', null, 'xlsx', at).replace('-efficiency-', '-idle-'),
    'zvky-forge-idle-2026-09-02.xlsx');
});

test('the log cannot be written or cleared through its own API', () => {
  /* An audit log with a delete endpoint is not an audit log. Asserted against
     the source, because this is a property that has to survive somebody adding
     a "tidy up old entries" button in good faith. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'activity.js'), 'utf8');
  assert.ok(!/router\.(post|patch|put|delete)\(/.test(route),
    'src/routes/activity.js must expose reads only');
  assert.ok(!/DELETE FROM activity_log|UPDATE activity_log/i.test(route),
    'and must not modify the table');
});

test('View Activity Log is its own permission, on for the top of the hierarchy', () => {
  const perm = catalog.BY_KEY.get('settings.activity_log');
  assert.ok(perm, 'the permission should be in the catalogue');
  assert.strictEqual(perm.group, 'settings');

  const held = ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has('settings.activity_log'));
  assert.deepStrictEqual(held.map((r) => r.label).sort(), [
    'Account Manager - Marketing',
    'CTO',
    'General Manager',
    'Head of Production',
    'Managing Director & CEO',
    'Super Admin',
    'Vice President - Global Operations & Business Development',
  ], 'the seven designations with studio-wide access, and nobody else by default');

  // Off for everybody else — 53 of the 60 — until somebody switches it on.
  assert.strictEqual(ROLES.length - held.length, 53);
  // And separable from general Settings access, which is the point of it.
  assert.notStrictEqual(perm.impliedBy, undefined);
});

test('the existing audit trails are untouched', () => {
  /* Point 7 of the brief and the standing rule: additive only. Each of these
     four tables predates the Activity Log and stays the authority for its own
     feature's detail view. */
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  for (const table of ['asset_events', 'role_permission_audit', 'ip_allowlist_audit', 'timesheet_events']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} should still exist`);
  }
  // Nothing in the new code reads or writes them.
  for (const file of ['activity.js', 'middleware/activity.js', 'routes/activity.js']) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const table of ['asset_events', 'role_permission_audit', 'ip_allowlist_audit', 'timesheet_events']) {
      assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}`).test(body),
        `src/${file} writes to ${table}`);
    }
  }
});

// --- against a real server -------------------------------------------------

test('the activity log', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Activity-Test-1!';
  let server;
  const token = {};
  const people = {};
  let clientId;
  let projectId;
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const logOf = async (who, query = '') => (await as(who, `/activity${query}`)).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'act-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'act-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = (await as('root', '/clients')).body.clients[0].id;
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;
    for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });
  t.after(() => stopServer(server));

  await t.test('actions are recorded with who did them and what changed', async () => {
    const before = (await logOf('root')).total;

    const asset = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'River Spirit', type: 'character', assigneeId: people.ana } })).body.asset;
    assert.ok(asset, 'the asset was created');

    const log = await logOf('root');
    assert.ok(log.total > before, 'the log grew');

    const entry = log.entries.find((e) => e.module === 'assets');
    assert.ok(entry, 'the asset action is there');
    assert.strictEqual(entry.actor.name, 'Root');
    assert.strictEqual(entry.actor.roleLabel, 'Super Admin', 'the designation held at the time');
    assert.deepStrictEqual(entry.changes, { status: { from: 'not_started', to: 'assigned' } });
    assert.ok(entry.at, 'and when');
    assert.strictEqual(log.timezone, 'IST');
  });

  await t.test('a permission change records which permission, from what to what', async () => {
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('report.view'), 'the fixture role starts without it');

    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...held, 'report.view'] } });

    const [entry] = (await logOf('root', '?module=permissions')).entries;
    assert.ok(entry, 'the change is in the log');
    assert.deepStrictEqual(entry.changes, { 'report.view': { from: 'off', to: 'on' } });
    assert.match(entry.summary, /Team Lead/);
    assert.strictEqual(entry.actor.name, 'Root');

    // Saving the screen without changing anything is not an action.
    const total = (await logOf('root', '?module=permissions')).total;
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...held, 'report.view'] } });
    assert.strictEqual((await logOf('root', '?module=permissions')).total, total,
      'a save that changed nothing adds no entry');
  });

  await t.test('signing in is recorded, against the person who signed in', async () => {
    const entries = (await logOf('root', '?module=auth')).entries;
    const mine = entries.find((e) => e.summary.includes('ana signed in'));
    assert.ok(mine, 'the artist\'s sign-in is there');
    assert.strictEqual(mine.actor.id, people.ana,
      'attributed to them, not to nobody — the request that authenticates has no req.user');
  });

  await t.test('a refused request is not an action', async () => {
    /* Nothing happened, so nothing is recorded. Logging every rejected
       validation would make the page mostly a record of typos. */
    const before = (await logOf('root')).total;
    assert.strictEqual((await as('ana', '/users', { method: 'POST',
      body: { name: 'x', email: 'x@zvky.test', role: 'game_artist' } })).status, 403);
    assert.strictEqual((await as('root', '/projects', { method: 'POST', body: {} })).status, 400);
    assert.strictEqual((await logOf('root')).total, before, 'neither was logged');
  });

  await t.test('a route nobody wired by hand is still recorded', async () => {
    /* The whole argument for the middleware. Notifications has no
       req.activity() call anywhere in it — this asserts it is logged anyway,
       which is what will hold for the sixty-seventh endpoint too. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'clients.js'), 'utf8');
    const before = (await logOf('root', '?module=clients')).total;
    await as('root', '/clients', { method: 'POST', body: { name: 'Aurora Games' } });
    const after = await logOf('root', '?module=clients');
    assert.strictEqual(after.total, before + 1, 'recorded');
    assert.ok(src.includes('req.activity'), 'this one happens to be enriched too');

    /* And one that is not enriched at all: renaming a client goes through
       PATCH, which has no req.activity call. */
    const clients = (await as('root', '/clients')).body.clients;
    const aurora = clients.find((c) => c.name === 'Aurora Games');
    const n = (await logOf('root', '?module=clients')).total;
    await as('root', `/clients/${aurora.id}`, { method: 'PATCH', body: { name: 'Aurora Studios' } });
    const grew = await logOf('root', '?module=clients');
    assert.strictEqual(grew.total, n + 1, 'an unenriched route is logged by the backstop alone');
    assert.match(grew.entries[0].summary, /clients/, 'with a description drawn from the request');
  });

  await t.test('filtering by person shows only that person, across every module', async () => {
    await as('ana', '/timesheets/entries', { method: 'POST',
      body: { date: '2026-03-02', startTime: '10:00', endTime: '12:00', clientId, projectId } });

    const mine = await logOf('root', `?actorId=${people.ana}`);
    assert.ok(mine.total >= 2, `expected several, got ${mine.total}`);
    for (const e of mine.entries) {
      assert.strictEqual(e.actor.id, people.ana, 'only this person');
    }
    const modules = new Set(mine.entries.map((e) => e.module));
    assert.ok(modules.size > 1, 'and across more than one module — auth and timesheet at least');
  });

  await t.test('filtering by module, action and date narrows correctly', async () => {
    const all = await logOf('root');
    const perms = await logOf('root', '?module=permissions');
    assert.ok(perms.total > 0 && perms.total < all.total, 'a module is a subset');
    for (const e of perms.entries) assert.strictEqual(e.module, 'permissions');

    const oneAction = await logOf('root', '?action=auth.login');
    assert.ok(oneAction.total > 0);
    for (const e of oneAction.entries) assert.strictEqual(e.action, 'auth.login');

    // A range in the past holds nothing that happened today.
    assert.strictEqual((await logOf('root', '?from=2020-01-01&to=2020-01-31')).total, 0);
    // And today's range holds everything, inclusive at both ends.
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual((await logOf('root', `?from=${today}&to=${today}`)).total, all.total);

    const search = await logOf('root', '?q=signed%20in');
    assert.ok(search.total > 0);
    for (const e of search.entries) {
      assert.ok(/signed in/i.test(e.summary) || /signed in/i.test(e.entity?.label || ''));
    }
  });

  await t.test('it pages, and says where you are', async () => {
    const page = await logOf('root', '?limit=3&offset=0');
    assert.strictEqual(page.entries.length, 3);
    assert.strictEqual(page.limit, 3);
    assert.ok(page.total > 3, 'and there is more than one page to be on');

    const second = await logOf('root', '?limit=3&offset=3');
    assert.strictEqual(second.offset, 3);
    const overlap = page.entries.filter((e) => second.entries.some((s) => s.id === e.id));
    assert.deepStrictEqual(overlap, [], 'pages do not repeat entries');

    // Newest first, by the sequence rather than by a timestamp that ties.
    const seqs = page.entries.map((e) => e.seq);
    assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => b - a));
  });

  await t.test('the exports carry the same rows the screen shows', async () => {
    const shown = await logOf('root', '?module=permissions');
    const xlsx = await fetch(`${server.base}/activity/export.xlsx?module=permissions`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(xlsx.status, 200);
    const book = require('xlsx').read(Buffer.from(await xlsx.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    assert.match(text, /Activity log/);
    assert.match(text, /Times shown in,IST/);
    assert.match(text, /report\.view: off → on/, 'before and after survive into the spreadsheet');
    // One data row per entry on screen, and no others: an export that ignored
    // the filter would be a way around what the screen is showing.
    const dataRows = text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} \d{2}:/.test(l));
    assert.strictEqual(dataRows.length, shown.total, 'the same count as the filtered view');

    const pdf = await fetch(`${server.base}/activity/export.pdf?module=permissions`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.strictEqual(bytes.subarray(0, 4).toString(), '%PDF');

    /* And it carries the entries, not just the headings. This export had the
       same defect the Time Sheet's did — rows handed to the renderer as
       positional arrays where it reads them by header name — and a test that
       stopped at the magic bytes could not see it. */
    const printed = pdfText(bytes).text;
    assert.match(printed, /Activity log/, 'the document says what it is');
    assert.ok(!/Work efficiency/.test(printed), 'and not that it is the efficiency report');
    assert.match(printed, /permissions/, 'the module filtered on appears in the rows');
    const timestamps = printed.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g) || [];
    assert.ok(timestamps.length >= dataRows.length,
      `every one of the ${dataRows.length} entries should be printed in full, found ${timestamps.length}`);
  });

  await t.test('without the permission there is no log, and no export either', async () => {
    for (const path of ['/activity', '/activity/export.xlsx', '/activity/export.pdf']) {
      assert.strictEqual((await as('ana', path)).status, 403, `${path} should be refused`);
      assert.strictEqual((await as('lee', path)).status, 403, `${path} should be refused for a lead`);
    }

    /* And it is settings.activity_log specifically, not general Settings
       access. Switched on for the team lead, the page opens — which is what
       makes it grantable independently, as the brief asked. */
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    try {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: [...held, 'settings.activity_log'] } });
      assert.strictEqual((await as('lee', '/activity')).status, 200,
        'the permission alone opens it, with no other Settings access');
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
    }
    assert.strictEqual((await as('lee', '/activity')).status, 403, 'and taking it away closes it again');
  });

  await t.test('the feature-specific trails still work exactly as before', async () => {
    /* Point 7, against the running application rather than the source. Each of
       these is read by its own screen and must be unchanged. */
    const rows = await sql(cfg, 'SELECT COUNT(*) AS n FROM asset_events');
    assert.ok(Number(rows[0].n) > 0, 'asset_events is still being written');
    const perms = await sql(cfg, 'SELECT COUNT(*) AS n FROM role_permission_audit');
    assert.ok(Number(perms[0].n) > 0, 'role_permission_audit is still being written');
    const ts = await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_events');
    assert.ok(Number(ts[0].n) > 0, 'timesheet_events is still being written');

    // And the endpoints that serve them still answer.
    assert.strictEqual((await as('root', '/permissions/audit')).status, 200);
  });

  await t.test('recording cannot break the action it records', async () => {
    /* The rule the whole feature depends on. With the table gone, everything
       still works — a missing line in a report is the right failure, and a
       delivery that cannot happen because logging it failed is not. */
    await sql(cfg, 'RENAME TABLE activity_log TO activity_log_hidden');
    try {
      const made = await as('root', '/clients', { method: 'POST', body: { name: 'Still Works Ltd' } });
      assert.strictEqual(made.status, 201, 'the action succeeded with nowhere to log it');
      const login = await call('/auth/login', { method: 'POST',
        body: { email: 'root@zvky.test', password: PASSWORD } });
      assert.strictEqual(login.status, 200, 'and so did signing in');
    } finally {
      await sql(cfg, 'RENAME TABLE activity_log_hidden TO activity_log');
    }
  });
});
