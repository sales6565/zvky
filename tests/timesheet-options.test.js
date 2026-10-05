/* THE TIME SHEET'S OPTIONS: the Idle category, and the admin screen behind them.
 *
 * THE FINDING THAT SHAPED THIS, because it decides what "counts toward
 * utilisation" can even mean here: NOTHING outside src/timesheets.js and its
 * route reads timesheet_entries. Not the Efficiency report, not the Idle Report,
 * not the Admin Dashboard, not either P&L tab — every one of those reads
 * work_sessions, which is measured time between Accept and Submit. The module's
 * own header has said so from the start: "Deliberately independent of
 * work_sessions and the Efficiency and Idle reports... Merging them would make
 * Time Spent mean two things at once."
 *
 * So the only aggregates over these hours are the day and week totals and the
 * two exports. Idle therefore COUNTS toward hours logged — the week really was
 * that long, and a total that hid the hours would not add up — and is SHOWN
 * SEPARATELY, which is the whole of its treatment and the whole available to it.
 * The first test below asserts the premise against the source so that a later
 * change wiring a report to timesheet hours fails here rather than silently
 * acquiring an Idle bug.
 *
 * KEYED ON 'idle', NEVER ON THE LABEL, which is what makes the category
 * renameable. Its reference row is is_system, so it can be renamed and cannot be
 * retired — asserted in both directions, including a rename followed by the
 * totals still splitting correctly.
 *
 * FIXTURES USE FIXED DATES AND openStudio. Every date below is a written-out
 * Wednesday or Thursday in October 2026, never "today", because the loggable-days
 * rule and the back-dating window are both about the calendar and a suite that
 * computed its dates from the clock would pass or fail by the hour it ran at.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sheets = require('../src/timesheets');
const tsSettings = require('../src/timesheet-settings');
const referenceData = require('../src/reference-data');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const defaults = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('tsoptions');
const PASSWORD = 'TimeSheetOptions-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROOT = '/admin/settings/timesheet';
const CATS = '/reference/timesheet-categories';

// Fixed dates. 2026-10-07 is a Wednesday; -08 Thursday; -10 Saturday; -11 Sunday.
const WED = '2026-10-07';
const THU = '2026-10-08';
const SAT = '2026-10-10';

// ---------------------------------------------------------------------------
// The premises, read off the source.
// ---------------------------------------------------------------------------

test('no report outside the Time Sheet reads timesheet hours', () => {
  /* THE SCOPE OF THE IDLE DECISION, asserted rather than asserted-in-a-comment.
     If somebody later points the Efficiency report or the Admin Dashboard at
     timesheet_entries, this fails and they are made to decide what Idle means
     there before shipping it — which is the half-migrated shape the brief is
     about. */
  const root = path.join(__dirname, '..');
  const files = ['src', 'public'].flatMap(function walk(dir) {
    const full = path.join(root, dir);
    return fs.readdirSync(full, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  }).filter((f) => /\.(js|html)$/.test(f));

  const allowed = new Set([
    'src/timesheets.js', 'src/routes/timesheets.js',
    'src/migrate.js',        // creates the table
    'src/schema-check.js',   // reports on it
    'src/work-schedule.js',  // names it in a comment about units
    /* Names it as the usedBy target for the category list — "how many lines hold
       this value", which is what makes "deactivate it instead" the answer. That
       is a usage count, not a report of hours, and it reads non_project rather
       than hours. */
    'src/reference-data.js',
  ]);
  const readers = files.filter((f) => !allowed.has(f)
    && fs.readFileSync(path.join(root, f), 'utf8').includes('timesheet_entries'));
  assert.deepStrictEqual(readers, [],
    'something new reads timesheet hours — decide what Idle means to it');

  // And the module still says so, which is where a reader looks first.
  const src = fs.readFileSync(path.join(root, 'src', 'timesheets.js'), 'utf8');
  assert.match(src, /Deliberately independent of work_sessions/);
  assert.match(src, /nothing outside this module and its route reads\s*\n\/\/ timesheet_entries/);
});

test('Idle is seeded, is the only system category, and is keyed not named', () => {
  const idle = defaults.TIMESHEET_CATEGORIES.find((c) => c.key === 'idle');
  assert.ok(idle, 'Idle is in the seed');
  assert.strictEqual(idle.isSystem, true, 'and is protected');
  assert.deepStrictEqual(
    defaults.TIMESHEET_CATEGORIES.filter((c) => c.isSystem).map((c) => c.key), ['idle'],
    'the only one: the other five are protected the ordinary way, by usedBy'
  );
  // The five that were hardcoded are all still there, under the keys existing
  // lines already hold — the table adopts them rather than migrating anything.
  assert.deepStrictEqual(defaults.TIMESHEET_CATEGORIES.map((c) => c.key),
    ['leave', 'holiday', 'meeting', 'training', 'admin', 'idle']);

  /* THE KEY, NOT THE LABEL. src/timesheets.js compares non_project to exactly
     one literal — IDLE — and that constant is the key. A comparison against
     "Idle" anywhere would break the moment a studio renamed it, which is the
     whole reason the row is renameable. */
  assert.strictEqual(sheets.IDLE, 'idle');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'timesheets.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/['"]Idle['"]/.test(code), 'nothing compares against the display name');
  assert.strictEqual((code.match(/const IDLE = 'idle';/g) || []).length, 1,
    'the key is named once');

  // usedBy points at the column that holds it, which is what makes "deactivate
  // instead" the answer for a category with lines against it.
  assert.deepStrictEqual(referenceData.COLLECTIONS.timesheet_categories.usedBy,
    { table: 'timesheet_entries', column: 'non_project' });
});

test('the three kinds of time, and which one Idle is', () => {
  // kindOf is the single classifier the day total, the week total and the
  // exports all share, so no two of them can split differently.
  assert.strictEqual(sheets.kindOf({ nonProject: null }), 'project');
  assert.strictEqual(sheets.kindOf({ nonProject: 'training' }), 'nonProject');
  assert.strictEqual(sheets.kindOf({ nonProject: 'idle' }), 'idle');
  // The database spelling as well as the API's, because both reach these.
  assert.strictEqual(sheets.kindOf({ non_project: 'idle' }), 'idle');

  const week = [
    { nonProject: null, hours: 6 },
    { nonProject: null, hours: 2.5 },
    { nonProject: 'training', hours: 3 },
    { nonProject: 'leave', hours: 8 },
    { nonProject: 'idle', hours: 4.25 },
  ];
  assert.deepStrictEqual(sheets.splitHours(week),
    { project: 8.5, nonProject: 11, idle: 4.25 });
  /* IDLE IS IN THE HOURS LOGGED. The three parts add to the whole, which is the
     assertion that fails if somebody later "excludes" it by subtracting it from
     a total rather than naming it beside one. */
  const total = week.reduce((n, e) => n + e.hours, 0);
  const split = sheets.splitHours(week);
  assert.strictEqual(Math.round((split.project + split.nonProject + split.idle) * 100) / 100,
    Math.round(total * 100) / 100, 'the split accounts for every hour, none dropped');

  // And it is NOT folded in with the other non-project time, which is the
  // separation a manager is looking at.
  assert.notStrictEqual(split.nonProject, 11 + 4.25);
});

test('the policy defaults are exactly the constants they replaced', () => {
  /* The upgrade promise: a deployment that takes this release and never visits
     Settings behaves identically. Each of these was a constant in the source. */
  assert.strictEqual(tsSettings.DEFAULTS.maxDayHours, 8, 'was TIMESHEET_MAX_HOURS');
  assert.strictEqual(tsSettings.DEFAULTS.minLineHours, 0.25, 'was MIN_LINE_HOURS');
  assert.strictEqual(tsSettings.DEFAULTS.maxLineHours, 24, 'was MAX_LINE_HOURS');
  /* NULL, not a number, and that is the previous behaviour rather than a missing
     default: there was no back-dating rule and no future-date rule at all. */
  assert.strictEqual(tsSettings.DEFAULTS.backdateDays, null);
  assert.strictEqual(tsSettings.DEFAULTS.futureDays, null);
  // Monday to Friday is what isWeekend() hardcoded.
  assert.deepStrictEqual(tsSettings.DEFAULTS.loggableDays, [1, 2, 3, 4, 5]);
});

test('the catalogue entry, and the default it is chosen to give', () => {
  const entry = catalog.BY_KEY.get('timesheet.options');
  assert.ok(entry, 'the key exists');
  assert.strictEqual(entry.groupLabel, 'Time Sheet', 'in the group its prefix names');
  assert.ok(catalog.grantableKeys().includes('timesheet.options'));
  assert.ok(!entry.pending, 'it is read by code in this change');

  const { ROLES } = defaults;
  const held = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);

  /* MANAGE IS SUPER ADMIN ONLY, through managePermissions — the same front door
     settings.recording_hours uses, and the only capability that tier carries
     exclusively. NOT manageSettings, which is every designation already trusted
     with the priorities and the branding: a category retired here disappears
     from every person's form, and a back-dating window set here decides whether
     last month can still be corrected. */
  assert.deepStrictEqual(held('timesheet.options'), ['super_admin'],
    'exactly one designation manages the Time Sheet options by default');

  /* AND NOBODY LOSES THE ABILITY TO LOG THEIR OWN TIME. timesheet.own is implied
     for every designation and is untouched by this — the point of a separate key
     rather than widening an existing one. */
  assert.strictEqual(held('timesheet.own').length, ROLES.length,
    'every designation still fills in its own hours');
  assert.notDeepStrictEqual(held('timesheet.options'), held('timesheet.own'));
});

test('the page and the server ask the same key, and never the tier', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'timesheet-options.js'), 'utf8');
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/requireSuperAdmin/.test(routeCode),
    'the policy route does not gate on the tier, so the page can mirror it exactly');
  assert.match(route, /const PERMISSION = 'timesheet\.options';/);
  assert.match(route, /router\.use\(requirePermission\(PERMISSION\)\);/);

  // The category list goes through the ordinary reference route, on the same key.
  const ref = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reference.js'), 'utf8');
  assert.match(ref, /'timesheet-categories': 'timesheet\.options',/,
    'one key for both halves of the section');
  assert.match(ref, /'timesheet-categories': 'timesheet_categories',/);

  /* The page's side: the section, its render call, and the reference-list entry
     all behind can() over the server's own permission list. */
  assert.match(PAGE, /\$\{can\('timesheet\.options'\) \? '<div id="timesheetOptionsSection"><\/div>' : ''\}/);
  assert.match(PAGE, /if\(can\('timesheet\.options'\)\) renderTimesheetOptions\(\);/);
  assert.match(PAGE, /collection: 'timesheet-categories',\s*\n\s*permission: 'timesheet\.options',/,
    'the category list is gated on the same key');
  // And it is in SETTINGS_SECTIONS, which is what canOpenSettings() is built
  // from — a permission whose screen cannot be reached is a switch that lies.
  assert.match(PAGE, /\{ permission:'timesheet\.options', label:'Time Sheet'/);

  // THE TIER IS NOT CONSULTED ANYWHERE NEAR IT. Counted over code with comments
  // stripped, because the prose above the panel names the key.
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const from = code.indexOf('async function renderTimesheetOptions');
  const to = code.indexOf('/* ---------- Chat settings');
  assert.ok(from !== -1, 'the panel is still where this test reads it');
  assert.ok(!/caps\(/.test(code.slice(from, to > from ? to : from + 6000)),
    'nothing in the Time Sheet Options panel asks the tier');
});

test('the Category dropdown is for non-project lines only', () => {
  /* The form has two shapes and the category belongs to one of them. The
     structural choice — project work or non-project — is deliberately NOT a
     configurable option: it is what a line IS, and validateEntry refuses a line
     that is both. */
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /tl_catFields/, 'the category lives in its own field group');
  const sync = code.slice(code.indexOf('function syncTimesheetLine'));
  const body = sync.slice(0, sync.indexOf('\n}'));
  assert.match(body, /tl_kind/, 'which is shown or hidden by the kind picker');
  assert.match(body, /tl_catFields/);
  assert.match(body, /tl_projectFields/);

  /* THE MIRROR, SEEDED. In a process with no database the reference cache is
     empty and every category is invalid — correctly, but it would make this case
     pass for the wrong reason. seedCache is what src/reference-data.js exports
     for exactly this, and the values are the seed the migration writes. */
  referenceData.seedCache('timesheet_categories',
    defaults.TIMESHEET_CATEGORIES.map((c) => ({ ...c, id: c.key, isActive: true })));

  // And the server refuses a line that claims both, whatever the form did.
  const both = sheets.validateEntry(
    { date: WED, hours: 2, nonProject: 'idle', projectId: 'p', clientId: 'c' },
    { maxHours: 8 });
  assert.strictEqual(both.ok, false);
  assert.match(both.error, /either project work or non-project time, not both/);
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('Idle, the categories and the policy, end to end',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};

  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const line = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const week = async (who, date) => (await as(who, `/timesheets/week?date=${date}`)).body;
  const setPolicy = (who, body) => as(who, ROOT, { method: 'PUT', body });

  const setPerms = async (roleKey, keys) => {
    const r = await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT', body: { permissions: keys } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const heldBy = async (roleKey) => {
    const r = await as('root', `/permissions/roles/${roleKey}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  };
  const restart = async () => {
    await stopServer(server);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tso-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    tok.root = await login('root@zvky.test');
    tok.ana = await login('ana@zvky.test');
  };
  // Back to the shipped policy, so one case cannot decide the next one's rules.
  const resetPolicy = () => setPolicy('root', {
    maxDayHours: 8, minLineHours: 0.25, maxLineHours: 24,
    backdateDays: '', futureDays: '', loggableDays: [1, 2, 3, 4, 5],
  });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tso-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tso-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* The clock opened wide. Nothing here reads a timer — the Time Sheet is
       declared time — but the shipped 13:00-14:00 blackout has broken three
       suites by acting between assertions, and openStudio also widens the
       recording window, which the maxDayHours validator reads. */
    await openStudio(server.base, tok.root);

    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    id.ana = r.body.user.id;
    tok.ana = await login('ana@zvky.test');
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* --- the category, and the migration ------------------------------------ */

  await t.test('the six categories are seeded, and seeding twice adds one Idle', async () => {
    const list = await as('root', CATS);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.deepStrictEqual(list.body.entries.map((e) => e.key),
      ['leave', 'holiday', 'meeting', 'training', 'admin', 'idle']);
    const idle = list.body.entries.find((e) => e.key === 'idle');
    assert.strictEqual(idle.label, 'Idle');
    assert.strictEqual(idle.isSystem, true);
    assert.strictEqual(idle.isActive, true);

    /* IDEMPOTENT, AND ON A POPULATED DATABASE. A line is filed first, then the
       whole migration runs again by restarting — which is how it runs in
       production — and the assertion is that there is still exactly one Idle row
       and the line is untouched. That is the brief's "running it twice creates
       one row" and "adds Idle to an existing populated database without
       disturbing existing lines" in one case, because they are one risk. */
    assert.strictEqual((await line('ana', { date: WED, nonProject: 'training', hours: 4 })).status, 201);
    const before = await sql(cfg, 'SELECT id, non_project, hours FROM timesheet_entries ORDER BY id');

    await restart();
    await restart();

    const rows = await sql(cfg, "SELECT COUNT(*) AS n FROM timesheet_categories WHERE `key` = 'idle'");
    assert.strictEqual(Number(rows[0].n), 1, 'one Idle row after three migrations');
    const all = await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_categories');
    assert.strictEqual(Number(all[0].n), 6, 'and six categories, not twelve');
    const after = await sql(cfg, 'SELECT id, non_project, hours FROM timesheet_entries ORDER BY id');
    assert.deepStrictEqual(after.map((r) => `${r.id}:${r.non_project}:${r.hours}`),
      before.map((r) => `${r.id}:${r.non_project}:${r.hours}`),
      'and every line exactly as it was');
  });

  await t.test('an Idle line is accepted, counted in the hours, and shown apart', async () => {
    /* Three lines, filed one at a time. An earlier draft put the second one
       inside the first one's assertion MESSAGE, which Node evaluates before the
       assertion — so the line was filed as a side effect of describing a
       failure, and the totals below counted an hour nobody could see in the
       test. Written out instead. */
    for (const [cat, hours] of [['idle', 3], ['idle', 0.5], ['training', 2]]) {
      const r = await line('ana', { date: THU, nonProject: cat, hours });
      assert.strictEqual(r.status, 201, `${cat} ${hours}h: ${JSON.stringify(r.body)}`);
    }

    const w = await week('ana', THU);
    const day = w.days.find((d) => d.date === THU);
    assert.ok(day, 'the day is on the week');
    /* COUNTED IN THE HOURS LOGGED. 3 idle + 0.5 idle + 2 training is the day,
       and the day says so — a figure that excluded idle would read 2.5. */
    assert.strictEqual(day.hours, 5.5, 'idle is in the day total');
    assert.strictEqual(day.idle, 3.5, 'and named apart from it');
    assert.strictEqual(day.nonProject, 2, 'not folded in with training');
    assert.strictEqual(day.project, 0);

    // The week carries the same split, over its whole range.
    assert.ok(w.weekSplit, 'the week is split too');
    assert.strictEqual(w.weekSplit.idle, 3.5);
    assert.strictEqual(w.weekSplit.nonProject, 6, 'the Wednesday training is in here too');
    assert.strictEqual(
      Math.round((w.weekSplit.project + w.weekSplit.nonProject + w.weekSplit.idle) * 100) / 100,
      w.weekHours, 'and the three parts account for the week');
  });

  await t.test('a bogus category is refused, and the dropdown is the server\'s list', async () => {
    const bad = await line('ana', { date: THU, nonProject: 'productive_vibes', hours: 1 });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /not a category/);
    assert.ok(Array.isArray(bad.body.allowed) && bad.body.allowed.includes('idle'),
      'and the refusal says what is allowed');

    const w = await week('ana', THU);
    assert.deepStrictEqual((w.nonProjectTypes || []).map((n) => n.key),
      ['leave', 'holiday', 'meeting', 'training', 'admin', 'idle'],
      'the form is built from the same list the server validates against');
  });

  await t.test('Idle can be renamed, and the reports keep working', async () => {
    const renamed = await as('root', `${CATS}/idle`, { method: 'PATCH', body: { label: 'Bench time' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual(renamed.body.entry.label, 'Bench time');
    try {
      /* THE KEY DID NOT MOVE, which is the whole point of renameable-but-keyed.
         A line filed as Idle now reads "Bench time", and the split still finds
         it — a comparison against the display name would have made the idle
         figure drop to nought here while the hours were still logged. */
      const w = await week('ana', THU);
      assert.strictEqual(w.weekSplit.idle, 3.5, 'the split still finds it');
      const label = (w.days.find((d) => d.date === THU).entries || [])
        .find((e) => e.nonProject === 'idle');
      assert.ok(label, 'the line still holds the key');
      assert.ok((w.nonProjectTypes || []).some((n) => n.key === 'idle' && n.label === 'Bench time'),
        'and the dropdown shows the new name');
      // A new line still files under the key, not the label.
      assert.strictEqual((await line('ana', { date: THU, nonProject: 'idle', hours: 1 })).status, 201);
      assert.strictEqual((await line('ana', { date: THU, nonProject: 'Bench time', hours: 1 })).status, 400,
        'the label is not a key');
    } finally {
      await as('root', `${CATS}/idle`, { method: 'PATCH', body: { label: 'Idle' } });
    }
  });

  await t.test('Idle cannot be retired or deleted; an ordinary category can be retired', async () => {
    const off = await as('root', `${CATS}/idle`, { method: 'PATCH', body: { isActive: false } });
    assert.strictEqual(off.status, 400, JSON.stringify(off.body));
    assert.match(JSON.stringify(off.body), /built-in value cannot be deactivated/);
    const gone = await as('root', `${CATS}/idle`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 400, JSON.stringify(gone.body));
    assert.match(JSON.stringify(gone.body), /built in and cannot be deleted/);

    /* AND A CATEGORY WITH LINES AGAINST IT IS NOT DELETABLE EITHER — deactivated
       instead, which is the ordinary protection and the reason only Idle needs
       is_system. Training has lines on it from the first case. */
    const usage = await as('root', `${CATS}/training/usage`);
    assert.strictEqual(usage.status, 200, JSON.stringify(usage.body));
    assert.ok(usage.body.inUse > 0, 'Training is in use');
    assert.strictEqual(usage.body.canDelete, false);
    const del = await as('root', `${CATS}/training`, { method: 'DELETE' });
    assert.strictEqual(del.status, 409, JSON.stringify(del.body));
    assert.match(del.body.error, /Deactivate it instead/);
    assert.ok(del.body.inUse > 0, 'and says how many lines hold it');
    assert.strictEqual(del.body.alternative, 'deactivate');
  });

  await t.test('a retired category leaves the form, refuses new lines, and old lines still read', async () => {
    const off = await as('root', `${CATS}/training`, { method: 'PATCH', body: { isActive: false } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    try {
      const w = await week('ana', WED);
      assert.ok(!(w.nonProjectTypes || []).some((n) => n.key === 'training'),
        'gone from the dropdown');

      const refused = await line('ana', { date: WED, nonProject: 'training', hours: 1 });
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      /* Named as retired rather than as "not a category", because the word is on
         screen in last week's rows and "that is not a category" about it reads as
         a bug. */
      assert.match(refused.body.error, /no longer one of the studio's categories/);
      assert.match(refused.body.error, /Existing lines keep it/);

      /* AND THE LINE ALREADY FILED AGAINST IT STILL RENDERS BY NAME. This is the
         one the label lookup exists for: the active list no longer contains
         Training, so a lookup over the active list would print the raw key. */
      const row = (w.days.find((d) => d.date === WED).entries || [])
        .find((e) => e.nonProject === 'training');
      assert.ok(row, 'the old line is still there');
      const history = await as('ana', `/timesheets/history?date=${WED}`);
      assert.ok(history.status < 400, JSON.stringify(history.body));
      assert.ok(JSON.stringify(history.body).includes('Training'),
        'and the audit trail still names it rather than its key');

      const sheet = await as('root', '/timesheets/export.xlsx?userId=' + id.ana);
      assert.ok(sheet.status < 400 || sheet.status === 404, `export answered ${sheet.status}`);
    } finally {
      await as('root', `${CATS}/training`, { method: 'PATCH', body: { isActive: true } });
    }
  });

  await t.test('a new category added in Settings is accepted by the server at once', async () => {
    /* The half-migrated shape the brief names first: a category added in the
       form but unknown to validation. There is only one list now, so this is a
       round trip rather than two places to keep in step — and that is what is
       being checked. */
    const made = await as('root', CATS, { method: 'POST', body: { label: 'Recruitment' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const key = made.body.entry.key;
    assert.strictEqual(key, 'recruitment', 'the key is derived once, from the label');
    try {
      const w = await week('ana', WED);
      assert.ok((w.nonProjectTypes || []).some((n) => n.key === key), 'the form offers it');
      /* Read before, compared after. An absolute figure here would depend on how
         many idle lines the cases above happened to file, which is a fact about
         the order of this suite rather than about the category. */
      const idleBefore = w.weekSplit.idle;
      const npBefore = w.weekSplit.nonProject;
      assert.strictEqual((await line('ana', { date: WED, nonProject: key, hours: 1 })).status, 201,
        'and the server takes it');
      const after = await week('ana', WED);
      assert.strictEqual(after.weekSplit.idle, idleBefore, 'a new category is not idle');
      assert.strictEqual(after.weekSplit.nonProject, Math.round((npBefore + 1) * 100) / 100,
        'it is ordinary non-project time');
    } finally {
      await sql(cfg, "DELETE FROM timesheet_entries WHERE non_project = 'recruitment'");
      await as('root', `${CATS}/recruitment`, { method: 'DELETE' });
    }
  });

  /* --- the policy numbers -------------------------------------------------- */

  await t.test('the line limits are enforced on create and on edit', async () => {
    const made = await line('ana', { date: WED, nonProject: 'admin', hours: 4 });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const entryId = made.body.entry.id;

    const saved = await setPolicy('root', {
      maxDayHours: 8, minLineHours: 1, maxLineHours: 6,
      backdateDays: '', futureDays: '', loggableDays: [1, 2, 3, 4, 5],
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    try {
      const small = await line('ana', { date: WED, nonProject: 'admin', hours: 0.5 });
      assert.strictEqual(small.status, 400, JSON.stringify(small.body));
      assert.match(small.body.error, /smallest a line can be is 1/);
      const big = await line('ana', { date: WED, nonProject: 'admin', hours: 7 });
      assert.strictEqual(big.status, 400);
      assert.match(big.body.error, /cannot be more than 6 hours/);

      /* ON EDIT TOO, which is the half a form-only rule would miss. */
      const edit = await as('ana', `/timesheets/entries/${entryId}`, {
        method: 'PATCH', body: { hours: 0.5 } });
      assert.strictEqual(edit.status, 400, JSON.stringify(edit.body));
      assert.match(edit.body.error, /smallest a line can be is 1/);

      /* AND THE LINE THAT ALREADY VIOLATES IT IS UNTOUCHED. It was filed at 4
         hours under the old rule, which is still inside 1-6, so a better proof:
         the 0.25h line from an earlier case is now below the minimum and is
         still there, still counted. */
      const w = await week('ana', WED);
      const existing = (w.days.find((d) => d.date === WED).entries || []);
      assert.ok(existing.length, 'the day still has its lines');
      assert.ok(Number(w.weekHours) > 0, 'and they still count');
    } finally {
      await resetPolicy();
    }
  });

  await t.test('tightening back-dating refuses new lines and leaves old ones alone', async () => {
    /* A line far in the past, filed while there is no window — which is the
       shipped default and so the state every upgrade starts in. */
    const old = await line('ana', { date: '2026-01-07', nonProject: 'admin', hours: 2 });
    assert.strictEqual(old.status, 201, JSON.stringify(old.body));
    const oldId = old.body.entry.id;

    assert.strictEqual((await setPolicy('root', { backdateDays: 7 })).status, 200);
    try {
      const refused = await line('ana', { date: '2026-01-08', nonProject: 'admin', hours: 2 });
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.error, /the studio allows lines to be filed up to 7 days back/);
      assert.match(refused.body.error, /Lines filed before this rule was set are unaffected/);

      /* EXISTING LINES ARE NEVER RE-JUDGED. The January line is still readable,
         still counted, and nothing walked the table looking for it. */
      const still = await sql(cfg, `SELECT hours FROM timesheet_entries WHERE id = '${oldId}'`);
      assert.strictEqual(still.length, 1, 'the old line is still there');
      assert.strictEqual(Number(still[0].hours), 2, 'with its hours');
      const w = await week('ana', '2026-01-07');
      assert.ok(Number(w.weekHours) >= 2, 'and it still counts in its own week');
    } finally {
      await resetPolicy();
      await sql(cfg, `DELETE FROM timesheet_entries WHERE id = '${oldId}'`);
    }
  });

  await t.test('future dates can be closed off, and the loggable days widened', async () => {
    assert.strictEqual((await setPolicy('root', { futureDays: 0 })).status, 200);
    try {
      const ahead = await line('ana', { date: '2099-01-07', nonProject: 'admin', hours: 1 });
      assert.strictEqual(ahead.status, 400, JSON.stringify(ahead.body));
      assert.match(ahead.body.error, /does not allow hours to be logged ahead of today/);
    } finally { await resetPolicy(); }

    /* SATURDAY, WHICH WAS HARDCODED AS IMPOSSIBLE. The form said "Monday to
       Friday" and validateEntry refused the date outright, while Settings ->
       Working Hours has had a configurable set of days all along. */
    const refused = await line('ana', { date: SAT, nonProject: 'admin', hours: 2 });
    assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, /nothing can be logged on a Saturday/);

    assert.strictEqual((await setPolicy('root', { loggableDays: [1, 2, 3, 4, 5, 6] })).status, 200);
    try {
      assert.strictEqual((await line('ana', { date: SAT, nonProject: 'admin', hours: 2 })).status, 201,
        'a studio that works Saturdays can log one');
      const w = await week('ana', SAT);
      assert.ok((w.workingDay.loggableDayNames || []).includes('Saturday'),
        'and the form says so rather than contradicting the server');
      assert.ok(!(w.totals ? w.totals.weekend : []).includes(SAT),
        'a logged Saturday is no longer flagged as unusual');
    } finally {
      await sql(cfg, `DELETE FROM timesheet_entries WHERE entry_date = '${SAT}'`);
      await resetPolicy();
    }
  });

  await t.test('the policy is checked, and the recording window is respected', async () => {
    const bad = await setPolicy('root', { minLineHours: 5, maxLineHours: 2 });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    assert.match(bad.body.error, /cannot be more than the largest/);

    assert.strictEqual((await setPolicy('root', { loggableDays: [] })).status, 422);
    assert.strictEqual((await setPolicy('root', { backdateDays: 'soon' })).status, 422);
    assert.strictEqual((await setPolicy('root', { maxDayHours: 99 })).status, 422);

    /* THE COUPLING WITH THE RECORDING WINDOW, refused here rather than
       discovered later by the Working Hours screen being unable to save its own
       current value. */
    /* A FIXED 09:00-13:00, and the fixed part is load-bearing. A first draft used
       windowAgo(studioMinute(), 120, -120), which crosses midnight whenever the
       suite runs before 02:00 IST — and a window that crosses midnight is one the
       legacy four time pairs cannot express, so openStudio()'s write-through is
       refused (canWriteThrough in src/routes/branding.js) and the narrow window
       SURVIVES the restore. Every later case then ran against four loggable hours
       and the policy saves failed for a reason nothing to do with them. Four
       hours written as clock times cannot wrap, whatever hour the suite runs at. */
    const { setRecordingWindows } = require('./helpers');
    await setRecordingWindows(server.base, tok.root, [
      { type: 'recording', label: 'Short day', startTime: '09:00', endTime: '13:00' },
    ]);
    try {
      const over = await setPolicy('root', { maxDayHours: 8 });
      assert.strictEqual(over.status, 422, JSON.stringify(over.body));
      assert.match(over.body.error, /loggable hours a day/);
      assert.match(over.body.error, /Recording Hours/);
    } finally {
      await openStudio(server.base, tok.root);
      await resetPolicy();
    }
  });

  /* --- the permission ----------------------------------------------------- */

  await t.test('the options are Super Admin\'s, and a grant reaches the same token', async () => {
    const held = await heldBy('game_artist');
    assert.ok(held.includes('timesheet.own'), 'an artist fills in their own hours');
    assert.ok(!held.includes('timesheet.options'), 'and does not manage the studio\'s policy');

    assert.strictEqual((await as('ana', ROOT)).status, 403);
    assert.strictEqual((await setPolicy('ana', { maxDayHours: 10 })).status, 403);
    assert.strictEqual((await as('ana', CATS, { method: 'POST', body: { label: 'Nope' } })).status, 403,
      'nor the category list, which is the same key');
    // The read-only dropdown list stays open to everybody — the form needs it.
    assert.strictEqual((await as('ana', CATS)).status, 200);
    assert.strictEqual((await as('ana', `${CATS}?includeInactive=1`)).status, 403,
      'but the management view does not');

    await setPerms('game_artist', [...held, 'timesheet.options']);
    try {
      /* THE SAME TOKEN, NO SIGN-OUT — which is the page's own question, since it
         re-reads /auth/me every twenty seconds. */
      const me = await as('ana', '/auth/me');
      assert.ok(me.body.user.permissions.includes('timesheet.options'), 'the session sees the grant');
      assert.strictEqual((await as('ana', ROOT)).status, 200);
      const saved = await setPolicy('ana', { maxDayHours: 7.5 });
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
      assert.strictEqual(saved.body.settings.maxDayHours, 7.5);
      assert.strictEqual((await as('ana', CATS, { method: 'POST', body: { label: 'Granted' } })).status, 201);
      await as('ana', `${CATS}/granted`, { method: 'DELETE' });
    } finally {
      await setPerms('game_artist', held);
      await resetPolicy();
    }

    // And a revoke closes it again, on that same token.
    assert.strictEqual((await as('ana', ROOT)).status, 403);
    assert.strictEqual((await setPolicy('ana', { maxDayHours: 10 })).status, 403);
    // Still able to log their own time, which nobody loses.
    assert.strictEqual((await line('ana', { date: WED, nonProject: 'admin', hours: 1 })).status, 201);
  });

  await t.test('every change to the policy is on the record', async () => {
    assert.strictEqual((await setPolicy('root', { backdateDays: 30 })).status, 200);
    await resetPolicy();
    const log = (await as('root', '/activity?module=settings&limit=50')).body.entries || [];
    const mine = log.filter((e) => e.action === 'timesheet.options_updated');
    assert.ok(mine.length >= 2, `the saves are logged (saw ${log.map((e) => e.action).join(', ')})`);
    assert.match(mine[0].summary, /Time Sheet options/);
    assert.match(JSON.stringify(mine[0]), /back-dating/,
      'and the sentence names the policy on both sides');
  });
});
