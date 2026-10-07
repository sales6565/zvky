/* YESTERDAY'S TIMESHEET AS A CONDITION OF STARTING TODAY'S WORK.
 *
 * TWO DEFINITIONS CARRY THIS WHOLE FEATURE and both are easy to get wrong, so
 * both are written out here rather than left to be read off the code.
 *
 * "PREVIOUS WORKING DAY" is the most recent day before today, in IST, that is
 * BOTH on timesheetSettings.loggableDays — the studio's own weekly-off list,
 * Mon-Fri by default and editable in Settings — AND not on the holiday calendar
 * (Prompt 22). NOT work_schedule.workingDays, which is the list the CLOCK uses:
 * this rule asks for a TIMESHEET, and validateEntry() refuses a date outside
 * loggableDays outright, so a day the clock counts but the timesheet will not
 * accept is a day nobody can comply for. The two are identical by default.
 *
 * "FILLED" is at least one line for that date. Any line — project, non-project,
 * or Idle (Prompt 24), which is what makes compliance always possible. DRAFT
 * COUNTS: the draft/submitted distinction lives on timesheet_days.status, not on
 * the lines, and submitting LOCKS them, so reading "filled" as "submitted" would
 * mean the only way to satisfy the rule also prevents correcting it. Not an
 * hours threshold and not configurable — maxDayHours is a soft cap the form
 * quotes, not a floor, and a floor would block somebody whose Tuesday honestly
 * was three hours.
 *
 * IT FAILS OPEN, everywhere. A missing timesheet table, an unloaded holiday
 * mirror, a query that throws: not blocked. A rule about paperwork must never be
 * the reason the whole floor stops, and the fail-open case is pinned below
 * against a live server with the table actually dropped.
 *
 * FIXED DATES THROUGHOUT. Every case that depends on which day it is passes an
 * explicit `now`; nothing here reads the real clock, so the suite answers the
 * same on a Monday as on a Saturday.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const gate = require('../src/timesheet-gate');
const timesheetSettings = require('../src/timesheet-settings');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cfg = config('tsgate');
const PASSWORD = 'TsGate-Test-1!';

// Mon–Fri, the default.
const WEEK = [1, 2, 3, 4, 5];
// 2026: 1 Oct is a Thursday, so 2 Oct Fri, 3 Oct Sat, 4 Oct Sun, 5 Oct Mon.
const asIST = (iso) => Date.parse(iso);

// ---------------------------------------------------------------------------
// "Previous working day", as arithmetic.
// ---------------------------------------------------------------------------

test('the previous working day walks back over weekends and holidays', () => {
  const prev = (today, opts = {}) => gate.previousWorkingDay(today, { loggableDays: WEEK, ...opts });

  // An ordinary midweek day is simply yesterday.
  assert.strictEqual(prev('2026-10-07'), '2026-10-06', 'Wednesday asks for Tuesday');
  assert.strictEqual(prev('2026-10-02'), '2026-10-01', 'Friday asks for Thursday');

  /* MONDAY ASKS FOR FRIDAY, not for Sunday. The brief's headline case, and the
     reason the walk is a loop rather than a subtraction. */
  assert.strictEqual(prev('2026-10-05'), '2026-10-02', 'Monday asks for Friday');

  // UNLESS FRIDAY WAS A HOLIDAY, in which case Thursday.
  assert.strictEqual(prev('2026-10-05', { isHoliday: (d) => d === '2026-10-02' }), '2026-10-01',
    'Monday after a Friday holiday asks for Thursday');

  /* A WEEKEND-ONLY GAP, from the other side: Saturday and Sunday are not
     loggable, so a studio that somehow starts a task on Sunday is asked for
     Friday — the walk does not care which day it starts from. */
  assert.strictEqual(prev('2026-10-04'), '2026-10-02', 'Sunday asks for Friday');
  assert.strictEqual(prev('2026-10-03'), '2026-10-02', 'Saturday asks for Friday');

  /* THE FIRST WORKING DAY AFTER A LONG RUN. Mon 5 to Fri 9 October all closed:
     Monday the 12th asks for Friday the 2nd, ten days back, walked through. */
  const shutdown = (d) => d >= '2026-10-05' && d <= '2026-10-09';
  assert.strictEqual(prev('2026-10-12', { isHoliday: shutdown }), '2026-10-02',
    'the first day back asks for the last day worked');

  /* A SIX-DAY STUDIO gets Saturday, because the list is the studio's and not a
     hardcoded weekend — which is what the brief asked to be reused rather than
     assumed. */
  assert.strictEqual(gate.previousWorkingDay('2026-10-05', { loggableDays: [1, 2, 3, 4, 5, 6] }),
    '2026-10-03', 'a studio that logs Saturdays asks for Saturday');

  /* NO ANSWER IS A REAL ANSWER, and it means nobody is blocked: a studio with no
     loggable days, or a holiday run longer than the lookback, owes nothing. */
  assert.strictEqual(prev('2026-10-07', { loggableDays: [] }), null);
  assert.strictEqual(prev('2026-10-07', { isHoliday: () => true }), null,
    'every day a holiday is not every day blocked');
  assert.strictEqual(gate.previousWorkingDay('2026-10-07', {}), null, 'nor is a missing list');
});

test('the date boundary is midnight IST, not midnight UTC', () => {
  /* THE TRAP THIS PINS. 18:30 UTC is already the next day in IST, so a server
     reading UTC would ask for the wrong day for five and a half hours out of
     every twenty-four — and would do it in the evening, when people are still
     working. */
  assert.strictEqual(gate.istDate(asIST('2026-10-06T18:29:00Z')), '2026-10-06',
    '23:59 IST is still Tuesday');
  assert.strictEqual(gate.istDate(asIST('2026-10-06T18:30:00Z')), '2026-10-07',
    '00:00 IST is Wednesday');
  // What a UTC reading would have said at that instant, for contrast.
  assert.strictEqual(new Date(asIST('2026-10-06T18:30:00Z')).toISOString().slice(0, 10), '2026-10-06');

  const prev = (at) => gate.previousWorkingDay(gate.istDate(at), { loggableDays: WEEK });
  assert.strictEqual(prev(asIST('2026-10-06T18:29:00Z')), '2026-10-05', 'at 23:59 it asks for Monday');
  assert.strictEqual(prev(asIST('2026-10-06T18:30:00Z')), '2026-10-06', 'one minute later, Tuesday');

  // And the ISO weekday is read through UTC, so the server's own zone cannot shift it.
  assert.strictEqual(gate.isoDayOf('2026-10-05'), 1, 'Monday is 1');
  assert.strictEqual(gate.isoDayOf('2026-10-04'), 7, 'Sunday is 7');
});

test('the date is named in words a person can match to the day picker', () => {
  assert.strictEqual(gate.label('2026-10-08'), 'Thursday 8 Oct');
  assert.strictEqual(gate.label('2026-10-02'), 'Friday 2 Oct');
  assert.strictEqual(gate.label('2026-01-01'), 'Thursday 1 Jan');
  // Nonsense in, nonsense out rather than a crash inside a refusal message.
  assert.strictEqual(gate.label(null), '');
});

// ---------------------------------------------------------------------------
// The switch, and the settings it lives in.
// ---------------------------------------------------------------------------

test('the switch is off by default and lives in the settings that already existed', () => {
  /* OFF ON EVERY EXISTING INSTALL. Switching it on blocks everybody who has not
     filled the previous working day, which the morning after a deployment is
     most of a studio. A feature that locks the floor the moment it ships is one
     nobody forgives. */
  assert.strictEqual(timesheetSettings.DEFAULTS.requirePreviousDay, false);

  /* NO SECOND SETTINGS MECHANISM, which the brief asked for explicitly. This is
     timesheet POLICY, so it is a column on timesheet_settings — the one-row,
     mirrored-in-memory table Prompt 24 built — and it inherits that table's
     route, its permission, its audit entry and its Settings panel. A new table
     would have been a second place to look for the same kind of answer. */
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  assert.match(mig, /require_previous_day TINYINT\(1\) NOT NULL DEFAULT 0/,
    'a column on the existing table, defaulting to off');
  assert.match(mig, /ALTER TABLE timesheet_settings ADD COLUMN require_previous_day/,
    'and added idempotently for a database whose table predates it');
  assert.match(mig, /COLUMN_NAME = 'require_previous_day'/, 'guarded by information_schema');

  /* THE AUDIT LINE NAMES IT. The log already records the hour limits; a change
     to the one setting here that can stop somebody working must not be the one
     it leaves out. */
  const on = timesheetSettings.summarise({
    ...timesheetSettings.DEFAULTS, requirePreviousDay: true, loggableDayShort: ['Mon'] });
  assert.match(on, /yesterday's sheet REQUIRED before starting work/);
  const off = timesheetSettings.summarise({
    ...timesheetSettings.DEFAULTS, requirePreviousDay: false, loggableDayShort: ['Mon'] });
  assert.match(off, /yesterday's sheet not required/);

  // A checkbox posts a boolean; a form post may send a string. Both read true.
  for (const raw of [true, 'true', 1, '1']) {
    assert.strictEqual(timesheetSettings.validate({ requirePreviousDay: raw }).value.requirePreviousDay,
      true, `${JSON.stringify(raw)} is on`);
  }
  for (const raw of [false, 'false', 0, '']) {
    assert.strictEqual(timesheetSettings.validate({ requirePreviousDay: raw }).value.requirePreviousDay,
      false, `${JSON.stringify(raw)} is off`);
  }
});

test('the key that guards it is the one that already guards this panel', () => {
  /* NO NEW PERMISSION, and that is a decision rather than an omission.
   *
   * timesheet.options already gates the Time Sheet Options panel this toggle
   * sits in: Super Admin only by impliedBy has('managePermissions'), enforced by
   * requirePermission on the server and by can() on the page. Every property the
   * brief asked for is already true of it. A second key for one checkbox inside
   * a form gated by the first would mean somebody could hold one and not the
   * other while both controls sit in the same Save — a worse screen than either
   * answer. */
  const entry = catalog.BY_KEY.get('timesheet.options');
  assert.ok(entry, 'the key exists');
  assert.strictEqual(entry.groupLabel, 'Time Sheet');

  const { ROLES } = require('../src/reference-defaults');
  const held = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);
  assert.deepStrictEqual(held('timesheet.options'), ['super_admin'],
    'Super Admin only by default, which is what the switch needs');
  assert.ok(catalog.grantableKeys().includes('timesheet.options'),
    'and a studio can still hand it to a production manager');

  /* THE SERVER ASKS requirePermission, NOT THE TIER — the bug this page carries
     a note about, and the reason the route was written that way. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'timesheet-options.js'), 'utf8');
  assert.match(route, /router\.use\(requirePermission\(PERMISSION\)\);/);
  assert.ok(!/requireSuperAdmin\s*\(/.test(route), 'never the tier — the file only names it in the note saying why not');

  // And the page gates the panel with can() on the same key.
  assert.match(PAGE, /if\(can\('timesheet\.options'\)\) renderTimesheetOptions\(\);/);
});

// ---------------------------------------------------------------------------
// The page reads the server's answer and never recomputes it.
// ---------------------------------------------------------------------------

function pageBlock(gateField) {
  const at = PAGE.indexOf('function timesheetBlock()');
  assert.ok(at !== -1, 'the page still has the reader this test runs');
  const src = PAGE.slice(at, PAGE.indexOf('\n}', at) + 2);
  const sandbox = { state: { timesheetGate: gateField } };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;__r = timesheetBlock();`, sandbox);
  return sandbox.__r;
}

test('the page holds no date logic of its own', () => {
  /* THE DRIFT THIS PREVENTS. The rule spans a weekly-off list, a holiday
     calendar and an IST boundary. Two copies of that is a copy that will
     disagree, and the gates in this application have drifted exactly that way
     before — REWORK_STATUSES and canHandOverInReview both. So the browser is
     given the answer, not the inputs. */
  const at = PAGE.indexOf('function timesheetBlock()');
  const body = PAGE.slice(at, PAGE.indexOf('\n}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of ['loggableDays', 'holiday', '86400000', 'getUTCDay', 'previousWorking']) {
    assert.ok(!new RegExp(forbidden, 'i').test(body),
      `the page does not reach for ${forbidden} — the server decides`);
  }
  assert.match(body, /state\.timesheetGate/, 'it reads the field /auth/me sends');

  // Blocked, not blocked, absent, and a payload from an older server.
  assert.deepStrictEqual(pageBlock({ blocked: true, date: '2026-10-06', dateLabel: 'Tuesday 6 Oct' }),
    { blocked: true, date: '2026-10-06', dateLabel: 'Tuesday 6 Oct' });
  assert.strictEqual(pageBlock({ blocked: false, date: null }), null);
  /* NULL ON A MISSING FIELD, which matters on the first paint and against an
     older server: a button must not be disabled for a reason nobody can state. */
  assert.strictEqual(pageBlock(null), null);
  assert.strictEqual(pageBlock(undefined), null);

  // And both reads of /auth/me store it, so a reload and a poll agree.
  assert.strictEqual((PAGE.match(/state\.timesheetGate = timesheetGate \|\| null;/g) || []).length, 2,
    'the boot read and the twenty-second poll both keep it');
});

test('the blocked Start button says what to do and links to the day', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = code.indexOf('const owing = timesheetBlock();');
  assert.ok(at !== -1, 'the drawer asks the question');

  /* A THIRD INDEPENDENT REASON, folded into the two that were already there —
     the open-task rule and the start date — rather than a fourth code path. */
  assert.match(code, /&& !blocked && !waiting && !owing;/, 'it closes the button');
  assert.match(code, /Boolean\(blocked \|\| waiting \|\| owing\)/, 'and opens the explanation');

  /* OFFERED AND REFUSED, not absent — the rule this panel already states for
     the other two reasons. A disabled button with the reason beats a missing
     one. */
  const panel = code.slice(code.indexOf('${startBlocked ? (owing ?'), code.indexOf(': blocked ? `'));
  assert.match(panel, /<button class="btn btn-brand" id="d_startBtn" disabled/);
  assert.match(panel, /Fill your timesheet for/);
  assert.match(panel, /An Idle line counts/, 'and names the quick way to comply');
  assert.match(panel, /data-tsgate="\$\{escapeHTML\(owing\.date \|\| ''\)\}"/,
    'with a link carrying the date');

  /* THE LINK OPENS THE TIME SHEET ON THAT DATE, not on today — otherwise the
     explanation names a day and the tab lands somewhere else. */
  assert.match(code, /if\(date\) tsState\.date = date;/);
  assert.match(code, /setTab\('timesheet'\);/);
});

test('the toggle is in the panel that already existed, with the warning on it', () => {
  const panel = PAGE.slice(PAGE.indexOf('async function renderTimesheetOptions()'));
  const body = panel.slice(0, panel.indexOf('\n}\n'));
  assert.match(body, /id="tso_requirePreviousDay"/, 'a checkbox in the Time Sheet Options panel');
  assert.match(body, /requirePreviousDay: document\.getElementById\('tso_requirePreviousDay'\)\.checked,/,
    'posted with the rest of the form, through the route that already exists');
  /* THE DESCRIPTION SAYS WHAT TURNING IT ON DOES, which for this setting is the
     difference between a considered change and locking the floor by accident. */
  assert.match(body, /switching it on blocks people straight away/i);
  assert.match(body, /Idle/, 'and names the quick way to comply');
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('the rule, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  const setGate = async (on) => {
    const r = await as('root', '/admin/settings/timesheet', {
      method: 'PUT', body: { requirePreviousDay: on } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r;
  };
  const meGate = async (who) => (await as(who, '/auth/me')).body.timesheetGate;
  const mk = async (name, assigneeId = id.ana) => (await as('root', `/assets/project/${id.project}`, {
    method: 'POST', body: { name, type: 'prop', assigneeId, manHours: 4 } })).body.asset;
  const start = (who, assetId) => as(who, `/assets/${assetId}/start`, { method: 'POST' });
  const fill = (who, date, body = {}) => as(who, '/timesheets/entries', {
    method: 'POST', body: { date, hours: 2, nonProject: 'idle', ...body } });
  const statusOf = async (assetId) => (await as('root', `/assets/project/${id.project}`))
    .body.assets.find((a) => a.id === assetId).status;

  /* THE SWEEP RUNS AT STARTUP, so the way to run it is to restart the process —
     which is also the production path the auto-resume suite uses: the sweep
     fires once on boot precisely so a server that was down overnight does what
     nobody was there to do. WORK_HOURS_SWEEP_MINUTES: '0' leaves the periodic
     timer off, so the boot sweep is the only one and the cases below are not
     racing a tick. The tokens survive a restart because the test JWT secret is
     fixed in the environment. */
  const restart = async () => {
    await stopServer(server);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tsg-token', WORK_HOURS_SWEEP_MINUTES: '0' });
  };
  const openSessions = async (assetId) => Number((await sql(cfg,
    `SELECT COUNT(*) AS n FROM work_sessions
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`))[0].n);
  /* Wait for the sweep to have SAID something about this asset, up to a few
     seconds. Without this the next assertion — that nothing was resumed —
     would also pass on a sweep that had not run yet, which is the way a
     negative case lies. */
  const sweptLine = async (re) => {
    for (let i = 0; i < 80; i += 1) {
      if (re.test(server.output())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tsg-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tsg-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* The clock opened wide. The shipped 13:00-14:00 lunch blackout has broken
       three suites by refusing a start mid-case, and this one starts work in
       nearly every assertion. */
    await openStudio(server.base, tok.root);
    const clientId = (await as('root', '/clients')).body.clients[0].id;
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Gate', clientId } })).body.project.id;
    for (const [who, name] of [['ana', 'Ana'], ['bo', 'Bo']]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@zvky.test`, role: 'game_artist', password: PASSWORD,
          projectId: id.project } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[who] = r.body.user.id;
      tok[who] = await login(`${who}@zvky.test`);
    }
    /* BACK-DATED ACCOUNTS, so these two owe the previous working day. A user
       created today is not blocked — that is its own case below — so without
       this the whole suite would pass for the wrong reason. */
    await sql(cfg, `UPDATE users SET created_at = '2026-01-01 00:00:00'
                     WHERE id IN ('${id.ana}', '${id.bo}')`);
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('switch off: an empty timesheet starts work exactly as today', async () => {
    const asset = await mk('Switch Off');
    assert.strictEqual((await meGate('ana')).blocked, false, 'and the page is told so');
    const r = await start('ana', asset.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(await statusOf(asset.id), 'in_progress');
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/a' } });
  });

  await t.test('switch on: start is refused with its own code, naming the date', async () => {
    await setGate(true);
    const asset = await mk('Switch On');

    const g = await meGate('ana');
    assert.strictEqual(g.blocked, true);
    assert.match(g.date, /^\d{4}-\d{2}-\d{2}$/, 'the page is told which date');
    assert.ok(g.dateLabel && /\d/.test(g.dateLabel), 'in words it can print');
    assert.match(g.message, /Fill your timesheet for/, 'and the sentence the server would refuse with');

    const r = await start('ana', asset.id);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'TIMESHEET_INCOMPLETE', 'a distinct code');
    assert.match(r.body.error, new RegExp(`Fill your timesheet for ${g.dateLabel}`),
      'the message names the date that is missing');
    assert.match(r.body.error, /Time Sheet tab/, 'and where to fix it');
    /* THE NAMED FIELD beside the sentence, which is the convention every other
       refusal here follows — `holiday`, `startsOn`, `opensAt`. */
    assert.deepStrictEqual(r.body.timesheetGate, { date: g.date, dateLabel: g.dateLabel });

    assert.strictEqual(await statusOf(asset.id), 'assigned', 'and nothing moved');
    const sessions = await sql(cfg, `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(sessions[0].n), 0, 'no session was opened');
  });

  await t.test('filling it unlocks the start on the same token — a normal line, then an Idle one', async () => {
    const owed = (await meGate('ana')).date;

    /* A NORMAL NON-PROJECT LINE FIRST. Any line counts, which is the definition
       under test; this proves it is not Idle-specific. */
    const first = await fill('ana', owed, { nonProject: 'meeting' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual((await meGate('ana')).blocked, false, 'the page is told at once');

    const asset = await mk('Unlocked');
    const r = await start('ana', asset.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/b' } });

    /* NO SIGN-OUT ANYWHERE IN THAT. The same token that was refused a moment
       ago succeeds — which is the brief's "they can start immediately". */

    // And now the same thing for Bo, with an IDLE line, which is the escape
    // hatch for a day with nothing to report.
    const owedBo = (await meGate('bo')).date;
    assert.strictEqual((await meGate('bo')).blocked, true, 'Bo still owes it');
    const idle = await fill('bo', owedBo, { nonProject: 'idle' });
    assert.strictEqual(idle.status, 201, JSON.stringify(idle.body));
    assert.strictEqual((await meGate('bo')).blocked, false, 'an Idle line counts as filled');
    const boAsset = await mk('Bo Unlocked', id.bo);
    assert.strictEqual((await start('bo', boAsset.id)).status, 200);
    await as('bo', `/assets/${boAsset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/c' } });
  });

  await t.test('a draft line counts — submitting is not required, and would lock it', async () => {
    const owed = (await meGate('ana')).date;
    const day = await sql(cfg,
      `SELECT status FROM timesheet_days WHERE user_id = '${id.ana}' AND work_date = '${owed}'`);
    /* THE LINE IS THERE AND THE DAY IS NOT SUBMITTED, which is the state the
       previous case left — and it is enough. Reading "filled" as "submitted"
       would mean the only way to satisfy the rule is an act that LOCKS the
       lines (timesheets.LOCKED), so a person could not then correct the day
       they had just been forced to file. */
    assert.ok(!day.length || day[0].status === 'draft',
      `the day is a draft: ${JSON.stringify(day)}`);
    assert.strictEqual((await meGate('ana')).blocked, false, 'and the gate is satisfied');
  });

  await t.test('resume follows the same rule', async () => {
    /* Bo holds a task, puts it down, and the studio switches the rule on while
       the previous day is unfilled again. Resume asks the same question /start
       asks, because resume is starting work too. */
    const asset = await mk('Resume Me', id.bo);
    assert.strictEqual((await start('bo', asset.id)).status, 200);
    const hold = await as('bo', `/assets/${asset.id}/hold`, { method: 'POST', body: { reason: 'lunch' } });
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    // Take Bo's line away, so the previous working day is unfilled again.
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.bo}' AND entry_date = '${owed}'`);
    assert.strictEqual((await meGate('bo')).blocked, true);

    const r = await as('bo', `/assets/${asset.id}/resume`, { method: 'POST' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'TIMESHEET_INCOMPLETE');

    // Fill it and resume works, same token.
    assert.strictEqual((await fill('bo', owed)).status, 201);
    const ok = await as('bo', `/assets/${asset.id}/resume`, { method: 'POST' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    await as('bo', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/d' } });
  });

  await t.test('a session already running is never stopped by switching the rule on', async () => {
    /* THE RULE IS ABOUT STARTING. Somebody mid-round when the Super Admin flips
       the switch keeps their clock — killing it would lose time they had
       genuinely worked, for a reason that is about paperwork. */
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await setGate(false);
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.ana}' AND entry_date = '${owed}'`);
    const asset = await mk('Mid Round');
    assert.strictEqual((await start('ana', asset.id)).status, 200);

    await setGate(true);
    assert.strictEqual((await meGate('ana')).blocked, true, 'Ana is now blocked from STARTING');
    const open = await sql(cfg,
      `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}' AND ended_at IS NULL`);
    assert.strictEqual(Number(open[0].n), 1, 'and her running session is untouched');
    // She can still submit it — the rule gates starting, not finishing.
    const sub = await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/e' } });
    assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));
  });

  await t.test('the overnight sweep leaves a blocked user paused, and records why', async () => {
    /* THE THIRD WAY A SESSION OPENS, and the one nobody is watching. /start and
       /resume refuse a person to their face; the sweep would have resumed them
       at half past nine and left /start refusing them while their clock ran.
       It stays down instead, and says so in the log — a timer that did not come
       back is the kind of thing somebody asks about afterwards. */
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await setGate(false);
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.bo}' AND entry_date = '${owed}'`);
    await sql(cfg, `UPDATE work_sessions SET ended_at = NOW(), seconds = 0,
                      ended_reason = 'submitted' WHERE user_id = '${id.bo}' AND ended_at IS NULL`);

    const asset = await mk('Overnight', id.bo);
    assert.strictEqual((await start('bo', asset.id)).status, 200);
    /* The studio's own pause, written the way the cutoff writes it: the stretch
       closed with off_hours and the asset still in a status work continues in.
       Through the database rather than by winding the clock, because what is
       under test here is the gate and not the cutoff arithmetic — tests/
       auto-resume.test.js owns that, at length. */
    await sql(cfg, `UPDATE work_sessions SET ended_at = NOW(), seconds = 60,
                      ended_reason = 'off_hours'
                     WHERE asset_id = '${asset.id}' AND ended_at IS NULL`);
    assert.strictEqual(await openSessions(asset.id), 0, 'put down for the night');

    await setGate(true);
    await restart();
    assert.ok(await sweptLine(new RegExp(`\\[resume sweep\\] .*stays paused: ${id.bo} has not filled ${owed}`)),
      'the sweep ran, decided, and named the person and the day');
    assert.strictEqual(await openSessions(asset.id), 0,
      'and did not resume into a state the server would refuse');

    // The other half of the claim: the round is still there to pick up.
    assert.strictEqual((await fill('bo', owed)).status, 201);
    await restart();
    for (let i = 0; i < 80 && await openSessions(asset.id) === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(await openSessions(asset.id), 1,
      'filled, and the next sweep picks the paused round up');

    /* Closed here rather than left running: the one-active-task rule is shared
       state across these cases, and a session left open would refuse a later
       Start and report a failure that is not about anything. */
    await sql(cfg, `UPDATE work_sessions SET ended_at = NOW(), seconds = 0,
                      ended_reason = 'submitted'
                     WHERE asset_id = '${asset.id}' AND ended_at IS NULL`);
  });

  await t.test('a user created today is not asked for a day they were not here', async () => {
    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Newby', email: 'newby@zvky.test', role: 'game_artist', password: PASSWORD,
        projectId: id.project } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    tok.newby = await login('newby@zvky.test');
    const g = await meGate('newby');
    assert.strictEqual(g.blocked, false, 'a new starter owes nothing for yesterday');

    const asset = await mk('New Starter', r.body.user.id);
    assert.strictEqual((await start('newby', asset.id)).status, 200);
    await as('newby', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/f' } });
  });

  await t.test('a holiday on the previous working day moves the demand back a day', async () => {
    /* THE HOLIDAY LIST IS THE ONE PROMPT 22 BUILT, read through the same mirror
       the clock reads. Declared for whatever yesterday happens to be when this
       runs, so the assertion holds on any day of the week. */
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.ana}' AND entry_date = '${owed}'`);
    assert.strictEqual((await meGate('ana')).date, owed, 'the day owed before the holiday');

    /* WRITTEN STRAIGHT TO THE TABLE, because holidays.create refuses a past
       date on purpose (Prompt 22) and the day owed is always in the past.
       Inserting the row is not enough on its own: the server answers from the
       in-memory mirror every mirrored setting here keeps, and that mirror
       reloads on a WRITE through the route — a GET leaves a loaded cache alone.
       So a throwaway future holiday is declared and removed, and the reload it
       triggers is what picks the past row up. That is a test mechanic and not a
       production path: a real past holiday was declared while it was still in
       the future, so the mirror already holds it. */
    await sql(cfg,
      `INSERT INTO studio_holidays (id, holiday_date, name) VALUES (UUID(), '${owed}', 'Test Closure')`);
    const reloadMirror = async () => {
      const made = await as('root', '/admin/settings/holidays', {
        method: 'POST', body: { date: '2099-01-01', name: 'Mirror reload' } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      const gone = await as('root', `/admin/settings/holidays/${made.body.entry.id}`,
        { method: 'DELETE' });
      assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    };
    await reloadMirror();

    const after = await meGate('ana');
    const expected = gate.previousWorkingDay(gate.istDate(), {
      loggableDays: WEEK, isHoliday: (d) => d === owed });
    assert.strictEqual(after.date, expected,
      'the demand moved back past the holiday, not onto it');
    assert.notStrictEqual(after.date, owed);

    await sql(cfg, `DELETE FROM studio_holidays WHERE holiday_date = '${owed}'`);
    await reloadMirror();
  });

  await t.test('the back-dating window never makes the owed day unfillable', async () => {
    /* THE CONFLICT BETWEEN TWO SETTINGS, and the brief asked for it to be found
       rather than discovered. backdateDays could put the previous working day
       out of reach — a window of 1 and a Monday morning is the plain case, since
       Friday is three days back — and the rule would then demand a day the form
       refuses, with no way out of either. */
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.ana}' AND entry_date = '${owed}'`);
    const r = await as('root', '/admin/settings/timesheet', {
      method: 'PUT', body: { requirePreviousDay: true, backdateDays: 0 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    try {
      assert.strictEqual((await meGate('ana')).blocked, true, 'still asked for it');
      // AND STILL ABLE TO FILE IT, though 0 days back would otherwise refuse.
      const line = await fill('ana', owed);
      assert.strictEqual(line.status, 201,
        `the owed day is fillable despite the window: ${JSON.stringify(line.body)}`);
      assert.strictEqual((await meGate('ana')).blocked, false);

      /* AND EVERY OTHER DATE KEEPS THE WINDOW. The exemption is one day wide,
         not a hole in the policy. */
      const older = gate.previousWorkingDay(owed, { loggableDays: WEEK });
      const refused = await fill('ana', older);
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.error, /days ago/);
    } finally {
      await as('root', '/admin/settings/timesheet', {
        method: 'PUT', body: { requirePreviousDay: true, backdateDays: '' } });
    }
  });

  await t.test('a freelancer-assigned task is unaffected, having no timer at all', async () => {
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.ana}' AND entry_date = '${owed}'`);
    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Ravi K.', discipline: 'rigging' } });
    const asset = (await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Outsourced', type: 'prop', manHours: 8 } })).body.asset;
    const assignment = (await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: fl.body.freelancer.id, projectId: id.project, assetId: asset.id,
        decidedManHours: 8 } })).body.assignment;

    /* REFUSED FOR THE OUTSOURCING REASON, not the timesheet one — the order of
       the gates in /start, and the honest answer: there is no timer here to
       gate. Prompt 25's guard is asked first. */
    const r = await start('ana', asset.id);
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /is out with Ravi K\./);
    assert.notStrictEqual(r.body.code, 'TIMESHEET_INCOMPLETE');

    // And marking it delivered is not gated either: no session is opened.
    const d = await as('root', '/assets/bulk/outsource-stage', { method: 'POST',
      body: { stage: 'delivered', assignmentIds: [assignment.id] } });
    assert.strictEqual(d.body.succeeded, 1, JSON.stringify(d.body.results));
  });

  await t.test('it fails open when the timesheet table is gone', async () => {
    /* THE ROLLOUT SAFETY THE BRIEF ASKED TO BE PINNED. A rule about paperwork
       must never be the reason nobody in the studio can work. The table is
       really dropped, not stubbed. */
    const owed = gate.previousWorkingDay(gate.istDate(), { loggableDays: WEEK });
    await sql(cfg, `DELETE FROM timesheet_entries WHERE user_id = '${id.ana}' AND entry_date = '${owed}'`);
    assert.strictEqual((await meGate('ana')).blocked, true, 'blocked while the table exists');

    await sql(cfg, 'DROP TABLE timesheet_entries');
    try {
      assert.strictEqual((await meGate('ana')).blocked, false, 'and not blocked once it is gone');
      const asset = await mk('Fail Open');
      const r = await start('ana', asset.id);
      assert.strictEqual(r.status, 200, `the clock still runs: ${JSON.stringify(r.body)}`);
      await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/g' } });
    } finally {
      /* Rebuilt from the schema this suite's database was made from, so the
         cases after this one are not running against a crippled install. */
      const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
      const at = ddl.indexOf('CREATE TABLE IF NOT EXISTS timesheet_entries');
      const end = ddl.indexOf('ENGINE=InnoDB', at);
      await sql(cfg, `${ddl.slice(at, end)}ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }
  });

  await t.test('the settings route: 403 without the key, then success on the same token', async () => {
    const held = (await as('root', '/permissions/roles/admin')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('timesheet.options'),
      'an Admin does not hold it by default — Super Admin only');

    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Adi', email: 'adi@zvky.test', role: 'admin', password: PASSWORD } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    tok.adi = await login('adi@zvky.test');

    const refused = await as('adi', '/admin/settings/timesheet', {
      method: 'PUT', body: { requirePreviousDay: false } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    const grant = await as('root', '/permissions/roles/admin', {
      method: 'PUT', body: { permissions: [...held, 'timesheet.options'] } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    try {
      /* THE SAME TOKEN, no sign-out — the page re-polls /auth/me every twenty
         seconds and this is the server half of that promise. */
      const ok = await as('adi', '/admin/settings/timesheet', {
        method: 'PUT', body: { requirePreviousDay: false } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.settings.requirePreviousDay, false, 'and it persisted');

      /* RECORDED IN THE AUDIT the other settings use, naming the change. */
      const log = await as('root', '/activity?module=settings&limit=20');
      const row = (log.body.entries || []).find((e) => e.action === 'timesheet.options_updated'
        && /yesterday's sheet/.test(e.summary || ''));
      assert.ok(row, `the change is in the Activity Log: ${JSON.stringify((log.body.entries || []).slice(0, 3))}`);
      assert.match(row.summary, /yesterday's sheet not required/, 'with the new value in words');
    } finally {
      await as('root', '/permissions/roles/admin', { method: 'PUT', body: { permissions: held } });
    }
  });
});
