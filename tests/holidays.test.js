/* THE DAYS THE STUDIO IS SHUT.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. A holiday is not a new rule beside the
 * recording schedule — it is a day on which the schedule produces no recordable
 * spans, which is the same thing a Sunday already is. One line in
 * src/working-time.js spansOn() does it, and six decisions downstream come out
 * right without any of them mentioning a holiday: the clock stops, Accept and
 * Start is refused, a running timer is put down at the boundary, the overnight
 * resume waits, and a session left open across a closed day is not credited
 * with it.
 *
 * That is an elegant shape and a fragile one, because every one of those six is
 * right for a reason nobody can see at the call site. So the cases below are
 * chosen to fail if the single line is removed, and — more importantly — to
 * fail DIFFERENTLY depending on which consumer stopped asking. The auto-resume
 * back-dating is the one the brief singled out as most likely to be got wrong,
 * and it is the only one of the six that WRITES a stamp rather than reading
 * one, so it has a case of its own with the arithmetic spelled out.
 *
 * THE CLOCK IS OPENED WIDE AND FIXED. openStudio() puts the window at
 * 00:00-24:00 on all seven days with every break cleared, so after it a holiday
 * is the ONLY thing that can stop the clock. That is not just hygiene — it is
 * what makes the assertions mean something: "the session was paused" is
 * evidence about holidays only if nothing else in the schedule could have
 * paused it. The shipped 13:00-14:00 lunch blackout has already broken three
 * suites this way, and the dates below are written out rather than computed
 * from the real clock for the same reason.
 *
 * HOW A HOLIDAY FOR *TODAY* IS BUILT, since the API refuses one. The earliest
 * date the screen accepts is tomorrow, deliberately and for the reason given in
 * src/holidays.js: a holiday dated over a day that has already run would change
 * what work already done was worth. So today's holiday is written with SQL and
 * picked up by RESTARTING the server — which is the production path for the
 * whole mechanism anyway (the mirror loads at startup and the sweep fires
 * once), and is how tests/auto-resume.test.js drives the same sweep. Nothing
 * test-only was added to the application to make this suite possible.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const workingTime = require('../src/working-time');
const idle = require('../src/idle');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio, studioMinute } = require('./helpers');

const cfg = config('holidays');
const PASSWORD = 'Holiday-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROOT = '/admin/settings/holidays';

// ---------------------------------------------------------------------------
// The arithmetic, with no server and no clock.
// ---------------------------------------------------------------------------

/* A day number for a 'YYYY-MM-DD' string. Whole days since the epoch, which is
   what src/working-time.js counts in IST — and the mirror of its istDateOf, so
   a fault in either shows up as the round trip below failing. */
const dayOf = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);

// A schedule with the clock on all day every day, so the only thing that can
// shut the studio is the holiday list. Mirrors what openStudio does live.
const alwaysOpen = (holidays = []) => ({
  workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: 0, dayEnd: 1440, breaks: [], holidays,
});

test('a day number and a studio date are the same day, read either way', () => {
  assert.strictEqual(workingTime.istDateOf(0), '1970-01-01',
    'day 0 is the epoch on the studio calendar, which is what anchors every other day');
  for (const date of ['2026-10-20', '2027-01-01', '2028-02-29', '2026-12-31']) {
    assert.strictEqual(workingTime.istDateOf(dayOf(date)), date, date);
  }
});

/* THE MIDNIGHT BOUNDARY, which is the whole of "dates are calendar dates in
 * IST, not UTC instants".
 *
 * These four instants are the ones a UTC-based comparison gets wrong, and it
 * gets them wrong in a specific, silent way: IST is UTC+5:30, so a server
 * comparing UTC dates would treat the holiday as beginning at 05:30 IST and
 * ending at 05:30 IST the next morning. The first and last cases below are the
 * ones that would then flip — 23:59 on the eve would read as the holiday
 * (because it is already past midnight UTC... no: because 18:29 UTC is still
 * the eve, while 18:30 UTC is not), and the holiday's own evening would read as
 * a working day. Asserted as spans rather than as a boolean so a failure says
 * which direction it went.
 */
test('a holiday begins and ends at midnight on the studio clock', () => {
  const schedule = alwaysOpen(['2026-10-20']);
  const spansAt = (date, minute) => {
    const parts = workingTime.istPartsOf(workingTime.instantAt(dayOf(date), minute));
    return { date: workingTime.istDateOf(parts.day), spans: workingTime.spansOn(parts.day, schedule) };
  };

  const eve = spansAt('2026-10-19', 23 * 60 + 59);
  assert.strictEqual(eve.date, '2026-10-19', '23:59 IST on the eve is still the eve');
  assert.deepStrictEqual(eve.spans, [[0, 1440]], 'and the clock is running');

  const opens = spansAt('2026-10-20', 0);
  assert.strictEqual(opens.date, '2026-10-20');
  assert.deepStrictEqual(opens.spans, [], '00:00 IST on the holiday is shut');

  const closes = spansAt('2026-10-20', 23 * 60 + 59);
  assert.strictEqual(closes.date, '2026-10-20');
  assert.deepStrictEqual(closes.spans, [], 'and it is still shut at 23:59');

  const after = spansAt('2026-10-21', 0);
  assert.strictEqual(after.date, '2026-10-21');
  assert.deepStrictEqual(after.spans, [[0, 1440]], '00:00 IST the day after is open again');

  /* And the same four read through the question the endpoints actually ask.
     isRecording is the predicate /start and both halves of the sweep consult,
     so pinning spansOn alone would leave the funnel untested from above. */
  const recordingAt = (date, minute) =>
    workingTime.isRecording(workingTime.instantAt(dayOf(date), minute), schedule);
  assert.strictEqual(recordingAt('2026-10-19', 1439), true, 'recording on the eve');
  assert.strictEqual(recordingAt('2026-10-20', 0), false, 'not at the stroke of the holiday');
  assert.strictEqual(recordingAt('2026-10-20', 1439), false, 'nor at the end of it');
  assert.strictEqual(recordingAt('2026-10-21', 0), true, 'and recording again the next day');
});

test('the boundaries the sweep and the resume are put at', () => {
  const schedule = alwaysOpen(['2026-10-20']);
  const at = (date, minute) => workingTime.instantAt(dayOf(date), minute);

  /* WHERE A RUNNING TIMER IS PUT DOWN. lastStoppedAt is what pauseOverdue asks,
     and the answer has to be the holiday's own midnight — the last moment
     anything was recordable — not the session's start and not the sweep's own
     clock. A holiday-blind lastStoppedAt would walk no further than the day it
     is standing on and hand back a boundary inside the holiday. */
  assert.strictEqual(workingTime.lastStoppedAt(at('2026-10-20', 12 * 60), schedule),
    at('2026-10-20', 0), 'midday on the holiday: the clock last ran at its midnight');

  /* WHEN IT PICKS UP AGAIN. resumesAt is what resumeOverdue back-dates the new
     session to, and it is the one the brief named as most likely to be wrong:
     it must step OVER the closed day. Asked from the eve's evening, which is
     where a session paused before a holiday leaves off. */
  assert.strictEqual(workingTime.resumesAt(at('2026-10-19', 23 * 60 + 30), schedule),
    at('2026-10-19', 23 * 60 + 30), 'already recordable on the eve, so: now');
  assert.strictEqual(workingTime.resumesAt(at('2026-10-20', 9 * 60 + 30), schedule),
    at('2026-10-21', 0), 'from inside the holiday, the next working moment is the day after');

  // Two holidays back to back, which is the case a single-day skip would pass
  // and a correct walk gets right for nothing.
  const two = alwaysOpen(['2026-10-20', '2026-10-21']);
  assert.strictEqual(workingTime.resumesAt(at('2026-10-20', 9 * 60 + 30), two),
    at('2026-10-22', 0), 'and it steps over both');
  assert.strictEqual(workingTime.stopsAt(at('2026-10-20', 9 * 60 + 30), two), null,
    'there is nothing for a timer on a holiday to run until');
});

/* SECONDS, WHICH IS WHERE A HALF-MIGRATED RULE WOULD SHOW UP AS MONEY.
 *
 * work_sessions.seconds is the single column behind Time Spent, the Efficiency
 * report, the Time Sheet's suggestions and both P&L tabs. A session left open
 * across a holiday — a restart, a sweep that missed a tick, somebody who never
 * submitted — must not be credited with it, or the studio is billed for a day
 * it was closed, in five places at once and always upwards.
 */
test('a span across a holiday is not credited with it', () => {
  const at = (date, minute) => workingTime.instantAt(dayOf(date), minute);
  const open = alwaysOpen();
  const shut = alwaysOpen(['2026-10-20']);

  const from = at('2026-10-19', 22 * 60);        // 22:00 on the eve
  const to = at('2026-10-21', 2 * 60);           // 02:00 the day after

  assert.strictEqual(workingTime.workingSecondsBetween(from, to, open), 28 * 3600,
    'with no holiday, 28 hours of wall clock are all recordable');
  assert.strictEqual(workingTime.workingSecondsBetween(from, to, shut), 4 * 3600,
    'with the holiday declared, only the two hours before it and the two after');

  // And the day itself is worth nothing, asked the other way round.
  assert.strictEqual(workingTime.workableMinutesPerDay(shut, dayOf('2026-10-20')), 0);
  assert.strictEqual(workingTime.workableMinutesPerDay(shut, dayOf('2026-10-21')), 1440);
});

/* THE WEEKLY SHAPE IS NOT TOUCHED, and this is a real decision rather than an
 * accident of where the line went. The Recording Hours screen draws a week from
 * spansFromEntries and src/work-schedule.js derives `workingDays` from it — so
 * if the holiday check had gone in there, a studio with one holiday next March
 * would lose that weekday from its schedule summary for ever. */
test('a holiday does not remove a weekday from the recurring schedule', () => {
  const entries = [{ type: 'recording', start: 0, end: 1440, daysOfWeek: [1, 2, 3, 4, 5], enabled: true }];
  const holiday = dayOf('2026-10-20');       // a Tuesday
  assert.deepStrictEqual(workingTime.spansFromEntries(holiday, entries), [[0, 1440]],
    'the weekly shape still says Tuesday records');
  assert.deepStrictEqual(
    workingTime.spansOn(holiday, { entries, holidays: ['2026-10-20'] }), [],
    'while the day itself is shut'
  );
});

test('the holiday list is read whether it arrives as a Set or an array', () => {
  // Both shapes exist in the codebase: holidays.dates() keeps a Set and
  // work-schedule publishes a sorted array so it survives JSON. A reader that
  // handled only one would fail silently as "no holidays", which looks exactly
  // like a working day.
  const day = dayOf('2026-10-20');
  assert.strictEqual(workingTime.isClosedDay(day, { holidays: new Set(['2026-10-20']) }), true);
  assert.strictEqual(workingTime.isClosedDay(day, { holidays: ['2026-10-20'] }), true);
  assert.strictEqual(workingTime.isClosedDay(day, { holidays: [] }), false);
  assert.strictEqual(workingTime.isClosedDay(day, {}), false, 'and no list at all is no holidays');
});

// ---------------------------------------------------------------------------
// Every consumer of "available work time".
// ---------------------------------------------------------------------------

/* THE BUG THIS PROJECT KEEPS FINDING, stated as a test: the timer blocked and
 * the report still expecting eight hours. The Idle Report's expectedHours and
 * the Admin Dashboard's capacity panel are the same arithmetic — team-capacity
 * is built from buildIdleReport by construction — so pinning idle.js pins both.
 */
test('a holiday expects no hours, and is counted rather than measured', () => {
  const week = { from: '2026-10-19', to: '2026-10-23', workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8 };

  assert.strictEqual(idle.workingDaysBetween(week.from, week.to, week.workingDays), 5,
    'Monday to Friday with nothing declared');
  assert.strictEqual(idle.workingDaysBetween(week.from, week.to, week.workingDays, ['2026-10-20']), 4,
    'and four once the Tuesday is a holiday');
  assert.strictEqual(
    idle.workingDaysBetween(week.from, week.to, week.workingDays, new Set(['2026-10-20', '2026-10-21'])), 3,
    'two of them, as a Set'
  );
  // A holiday on a Sunday takes nothing away, because the Sunday was never
  // counted. Double-subtraction is the obvious way to get this wrong.
  assert.strictEqual(idle.workingDaysBetween('2026-10-19', '2026-10-25', week.workingDays, ['2026-10-25']), 5,
    'a holiday on a rest day costs no expected hours twice');

  const open = idle.forUser({ spans: [], ...week });
  const shut = idle.forUser({ spans: [], ...week, holidays: ['2026-10-20'] });
  assert.strictEqual(open.expectedHours, 40);
  assert.strictEqual(shut.expectedHours, 32, 'the holiday is not expected of anybody');
  assert.strictEqual(shut.idleHours, 32, 'and nobody is idle for a day that expected nothing');

  /* Somebody who DID work on the holiday. The day expects nothing, so its hours
     cannot be engaged against it — they fall to restDaysCovered, which is the
     treatment a worked Saturday already gets and the only reading under which
     expected and engaged still add up. */
  const worked = idle.forUser({
    spans: [[Date.parse('2026-10-20T04:00:00Z'), Date.parse('2026-10-20T12:00:00Z')]],
    ...week, holidays: ['2026-10-20'],
  });
  assert.strictEqual(worked.expectedHours, 32);
  assert.strictEqual(worked.engagedHours, 0, 'the holiday is not engaged time');
  assert.strictEqual(worked.restDaysCovered, 1, 'it is a day something was open across');
  assert.ok(worked.idleHours <= worked.expectedHours, 'and idle never exceeds expected');
});

test('the report no longer claims holidays are unrecorded', () => {
  /* The caveat said "public holidays, annual leave and sickness are not
     recorded anywhere in this app". Half of that stopped being true, and a
     caveat telling a manager to distrust a figure that has just become right is
     worse than none. */
  const schedule = { hoursPerDay: 8, workingDayNames: ['Monday', 'Friday'] };
  const plain = idle.caveats(schedule).join(' | ');
  assert.ok(!/Public holidays.*are not recorded/i.test(plain),
    'the stale sentence is gone');
  assert.match(plain, /Declared holidays ARE/, 'and replaced by what is true now');
  assert.match(plain, /Annual leave and sickness are not recorded/,
    'while leave and sickness, which still are not, are kept');

  /* AND NO PER-PERIOD COUNT IN HERE. These sentences have to read identically
     on the Idle Report and on the Admin Dashboard's capacity panel —
     tests/team-capacity.test.js asserts exactly that, "not a second wording of
     it" — and the capacity panel carries three periods at once. So the number
     of holidays a period dropped is a field on the payload instead, asserted
     against the live report below. */
  assert.ok(!/in this period/.test(plain), 'the caveats say nothing period-specific');
  assert.strictEqual(idle.caveats.length, 1, 'and take only the schedule');
});

// ---------------------------------------------------------------------------
// The two gates, read off the source.
// ---------------------------------------------------------------------------

test('the page and the server ask the same two keys, and never the tier', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'holidays.js'), 'utf8');
  /* Comments stripped before the tier check below. The route's own header
     explains at length why it does NOT use requireSuperAdmin, and a comment is
     not a gate — the same distinction tests/hold-permission.test.js draws when
     it counts asset.hold over code rather than over the whole file. */
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* requirePermission, NOT requireSuperAdmin — which is the difference from
     Recording Hours beside it and the reason this feature can be gated
     identically on both sides. requireSuperAdmin passes on the TIER or on the
     key, and can() in the browser knows nothing about tiers, so a page written
     against it would be the fourth instance of the bug public/index.html
     carries a note about. */
  assert.ok(!/requireSuperAdmin/.test(routeCode),
    'the holiday routes do not gate on the tier, so the page can mirror them exactly');
  assert.match(route, /router\.get\('\/', requirePermission\(VIEW\)/, 'the list is behind the view key');
  for (const verb of ['post', 'put', 'delete']) {
    assert.match(route, new RegExp(`router\\.${verb}\\('[^']*', requirePermission\\(MANAGE\\)`),
      `${verb.toUpperCase()} is behind the manage key`);
  }
  assert.match(route, /const VIEW = 'settings\.holidays_view';/);
  assert.match(route, /const MANAGE = 'settings\.holidays';/);

  /* The page's side. The section is drawn behind the view key and every control
     inside it behind the manage key, both through can() over the server's own
     permission list. */
  assert.match(PAGE, /\$\{can\('settings\.holidays_view'\) \? '<div id="holidaysSection"><\/div>' : ''\}/,
    'the section is behind the view key');
  assert.match(PAGE, /if\(can\('settings\.holidays_view'\)\) renderHolidays\(\);/,
    'and so is loading it');
  assert.match(PAGE, /const may = holState\.data\.canManage && \(opts\.isDraft \|\| row\.editable\);/,
    'the row controls follow the server\'s own answer for the key and the date');

  /* AND THE TIER IS NOT CONSULTED ANYWHERE NEAR ANY OF IT. Counted over code
     with comments stripped, because the prose above the section names the keys
     and a comment is not a gate. */
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const start = code.indexOf('function holRowHTML');
  const end = code.indexOf('function holScheduleChanged');
  assert.ok(start !== -1 && end > start, 'the Holidays section is still where this test reads it');
  assert.ok(!/caps\(/.test(code.slice(start, end)),
    'nothing in the Holidays section asks the tier');
});

test('the catalogue entries, and the defaults they are chosen to give', () => {
  const view = catalog.BY_KEY.get('settings.holidays_view');
  const manage = catalog.BY_KEY.get('settings.holidays');
  assert.ok(view && manage, 'both keys are in the catalogue');

  // Every key in this catalogue sits in the group its prefix names — which is
  // why these are settings.* and not holiday.*.
  assert.strictEqual(view.groupLabel, 'Settings / Admin');
  assert.strictEqual(manage.groupLabel, 'Settings / Admin');
  // Grantable, both of them: a studio that wants its production manager
  // entering next year's calendar, or its calendar narrowed, can say so.
  assert.ok(catalog.grantableKeys().includes('settings.holidays'));
  assert.ok(catalog.grantableKeys().includes('settings.holidays_view'));
  // Neither is pending: both are read by code in this same change.
  assert.ok(!view.pending && !manage.pending);

  /* THE DEFAULTS, PINNED WITH THE REASON FOR EACH.
   *
   * VIEW IS ON FOR EVERY DESIGNATION. `impliedBy: () => true`, the same
   * predicate that gives every role asset.hold. Knowing which days the studio
   * is closed is something every person in the building needs to plan their own
   * work, and withholding it would only send them to ask somebody who can see
   * it. It is a key rather than no key so that a Super Admin can still narrow
   * it — the code has not decided for them.
   *
   * AND IT IS NOT WHAT EXPLAINS A REFUSED TIMER. The brief asked whether the
   * existing off-hours messaging already covers that, and it does: the 409 from
   * POST /start names the holiday in its body and the paused label comes from
   * describePause() in src/work-log.js, neither of which consults this key. The
   * live cases below assert that from a session that does not hold it.
   *
   * MANAGE IS OFF FOR EVERY DESIGNATION BUT SUPER ADMIN. implied by
   * managePermissions, which is the front door settings.recording_hours uses
   * two entries above and which only the Super Admin tier carries — so the
   * Super Admin picks it up with nobody switching it on, and anybody else gets
   * it only when a Super Admin grants it in Settings. NOT manageSettings, which
   * would hand it to every designation already trusted with the priorities and
   * the branding: those lists rename a dropdown, this one stops the clock for
   * the whole studio.
   */
  assert.strictEqual(view.impliedBy(), true, 'view is implied for every role, whatever its tier');

  const { ROLES } = require('../src/reference-defaults');
  const withManage = ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has('settings.holidays'));
  assert.deepStrictEqual(withManage.map((r) => r.key), ['super_admin'],
    'exactly one designation manages holidays by default');
  const withoutView = ROLES.filter((r) => !rolePermissions.defaultsFor(r.key).has('settings.holidays_view'));
  assert.deepStrictEqual(withoutView.map((r) => r.key), [],
    'and every designation can read the calendar');
});

test('the holiday check lives in the schedule, not beside it', () => {
  /* THE MUTATION THIS SUITE IS BUILT AROUND, asserted structurally as well as
     behaviourally. If a later change moves the holiday test out of spansOn and
     into the six callers, every live case below still passes while the shape
     the feature was asked for is gone — and the next consumer added will forget
     it. So the single funnel is pinned here, and the behaviour is pinned
     below. */
  const wt = fs.readFileSync(path.join(__dirname, '..', 'src', 'working-time.js'), 'utf8');
  assert.match(wt, /function spansOn\(day, schedule\) \{[\s\S]{0,2200}?if \(isClosedDay\(day, schedule\)\) return \[\];/,
    'spansOn is where a closed day becomes no spans');
  const body = wt.slice(wt.indexOf('function spansOn('));
  assert.strictEqual((wt.match(/isClosedDay\(/g) || []).length, 2,
    'isClosedDay is defined once and asked once — the funnel, not a check per caller');
  assert.ok(body.length > 0);
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('holidays stop the clock, and only a Super Admin declares one',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const ids = {};
  let projectId;

  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });

  /* Restart, which is how production runs the sweep and how the holiday mirror
     is reloaded. tests/auto-resume.test.js drives the same sweep the same way:
     "the sweep fires once at startup precisely so a server that was down
     overnight comes back and does what nobody was there to do". */
  const restart = async () => {
    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'holiday-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    for (const who of Object.keys(ids)) tok[who] = await login(ids[who].email);
    tok.root = await login('root@zvky.test');
  };

  // Today and tomorrow on the studio's own calendar, from the module that owns
  // the question rather than from the test's idea of a date.
  const holidays = require('../src/holidays');
  const today = () => holidays.todayISO();
  const tomorrow = () => holidays.tomorrowISO();
  const plusDays = (n) => workingTime.istDateOf(workingTime.istPartsOf(Date.now()).day + n);

  /* A holiday for TODAY, which the API refuses and rightly. Written straight to
     the table and picked up by the restart that follows — see the suite header.
     `name` is quoted because it is a reserved word. */
  const declareToday = async (name) => {
    await sql(cfg, `INSERT INTO studio_holidays (id, holiday_date, \`name\`, note)
      VALUES (UUID(), '${today()}', '${name}', 'written for the test, read by the real code')`);
  };
  const undeclareToday = async () => {
    await sql(cfg, `DELETE FROM studio_holidays WHERE holiday_date = '${today()}'`);
  };

  const assetFor = async (who, name) => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'prop', assigneeId: ids[who].id } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };
  const sessions = (assetId) => sql(cfg,
    `SELECT started_at, ended_at, seconds, ended_reason FROM work_sessions
      WHERE asset_id = '${assetId}' ORDER BY started_at`);

  /* WAIT FOR THE SWEEP, rather than assuming the restart finished it.
   *
   * A real race, found by this suite failing intermittently on one subtest and
   * worth writing down because it is not obvious from either side.
   * src/server.js awaits migrate.run() — so the holiday mirror IS loaded before
   * the port opens — and then calls workLog.scheduleAutoPause(db) WITHOUT
   * awaiting it, because it is a scheduler rather than a step. startServer()
   * returns the moment /health answers. So the first pass of the sweep can
   * still be in flight when the first assertion runs, and a subtest that reads
   * work_sessions immediately sees the state from before it.
   *
   * Polling the condition rather than sleeping a fixed time: the sweep is quick
   * and the wait is usually one tick, and a fixed delay would be either flaky
   * on a loaded box or slow on an idle one. Ten seconds is far longer than a
   * pass over a handful of rows and short enough to fail as a test rather than
   * as a hung suite — and the message says what was being waited for, because
   * "timed out" on its own would send somebody looking at the sweep when the
   * fault is in the fixture. */
  const sweptUntil = async (assetId, done, what) => {
    const deadline = Date.now() + 10000;
    let rows = await sessions(assetId);
    while (!done(rows) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await sessions(assetId);
    }
    assert.ok(done(rows), `the startup sweep never ${what} — rows: ${JSON.stringify(rows)}`);
    return rows;
  };
  // Free the one-active-task slot without going through a route, so a case
  // about holidays does not fail over a rule it is not testing.
  const clearOpen = (who) => sql(cfg,
    `UPDATE work_sessions SET ended_at = NOW(), seconds = 0, ended_reason = 'moved'
      WHERE user_id = '${ids[who].id}' AND ended_at IS NULL`);

  const setPerms = async (roleKey, keys) => {
    const r = await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT', body: { permissions: keys } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const heldBy = async (roleKey) => {
    const r = await as('root', `/permissions/roles/${roleKey}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  };

  t.before(async () => {
    await resetSchema(cfg);
    /* The sweep off on the timer, so every case runs it at the moment it
       means — a sweep firing between two assertions would be a second author. */
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'holiday-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'holiday-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');

    /* THE CLOCK OPENED WIDE. After this a holiday is the only thing that can
       stop recording, which is what makes every pause below evidence about
       holidays. See the suite header. */
    await openStudio(server.base, tok.root);

    for (const [who, email, role] of [
      ['ana', 'ana@zvky.test', 'game_artist'],
      ['pat', 'pat@zvky.test', 'producer'],
    ]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      ids[who] = { id: r.body.user.id, email };
      tok[who] = await login(email);
    }

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', { method: 'POST',
      body: { name: 'Closed Days', clientId: clients.body.clients[0].id } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* --- the calendar, as a Super Admin keeps it ----------------------------- */

  await t.test('a holiday is declared for a future date, and refused for today or the past', async () => {
    const list = await as('root', ROOT);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.deepStrictEqual(list.body.upcoming, [], 'the studio starts with none of its own');
    assert.strictEqual(list.body.earliest, tomorrow(), 'and the earliest date it offers is tomorrow');
    assert.strictEqual(list.body.canManage, true);

    const made = await as('root', ROOT, { method: 'POST',
      body: { date: plusDays(30), name: 'Diwali', note: 'Office closed' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.entry.date, plusDays(30));
    assert.strictEqual(made.body.entry.name, 'Diwali');
    assert.strictEqual(made.body.entry.editable, undefined, 'the entry itself carries no verdict');
    assert.strictEqual(made.body.upcoming.length, 1);
    assert.strictEqual(made.body.upcoming[0].editable, true, 'a future holiday can still be changed');

    /* TODAY IS REFUSED. The rule the whole design rests on: a holiday dated over
       a day that has already run would change what work already done was
       worth. The message says so rather than reading as a format error. */
    const now = await as('root', ROOT, { method: 'POST', body: { date: today(), name: 'Today' } });
    assert.strictEqual(now.status, 422, JSON.stringify(now.body));
    assert.match(now.body.error, /cannot be added for today/i);
    assert.match(now.body.error, new RegExp(tomorrow()), 'and names the earliest date that works');
    assert.strictEqual(now.body.errors[0].field, 'date', 'against the field it belongs to');

    const past = await as('root', ROOT, { method: 'POST', body: { date: plusDays(-7), name: 'Last week' } });
    assert.strictEqual(past.status, 422, JSON.stringify(past.body));
    assert.match(past.body.error, /has passed/i);
    assert.match(past.body.error, /hours already recorded are never changed/i);

    // DUPLICATES ARE REFUSED, naming the holiday already on that date.
    const dup = await as('root', ROOT, { method: 'POST', body: { date: plusDays(30), name: 'Also Diwali' } });
    assert.strictEqual(dup.status, 422, JSON.stringify(dup.body));
    assert.match(dup.body.error, /already a holiday — "Diwali"/);
    // And at the table too, which is what settles two admins saving at once.
    await assert.rejects(
      () => sql(cfg, `INSERT INTO studio_holidays (id, holiday_date, \`name\`) VALUES (UUID(), '${plusDays(30)}', 'Third')`),
      /Duplicate entry/i, 'the UNIQUE key is really there');

    // A name is required: it is what the refusal says.
    const unnamed = await as('root', ROOT, { method: 'POST', body: { date: plusDays(31), name: '  ' } });
    assert.strictEqual(unnamed.status, 422);
    assert.strictEqual(unnamed.body.errors[0].field, 'name');

    // Not a date at all, and a date that is not one.
    for (const bad of ['tomorrow', '2026-13-01', '2027-02-30']) {
      const r = await as('root', ROOT, { method: 'POST', body: { date: bad, name: 'Nope' } });
      assert.strictEqual(r.status, 422, `${bad} was accepted`);
      assert.strictEqual(r.body.errors[0].field, 'date', bad);
    }

    // Edit and delete, on a date still in the future.
    const id = made.body.entry.id;
    const moved = await as('root', `${ROOT}/${id}`, { method: 'PUT',
      body: { date: plusDays(31), name: 'Diwali', note: null } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.entry.date, plusDays(31));
    assert.strictEqual(moved.body.entry.note, null);
    // Moving one ONTO a past day is refused for the same reason adding one is.
    const back = await as('root', `${ROOT}/${id}`, { method: 'PUT', body: { date: plusDays(-1), name: 'Diwali' } });
    assert.strictEqual(back.status, 422, JSON.stringify(back.body));

    const gone = await as('root', `${ROOT}/${id}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.deepStrictEqual(gone.body.upcoming, []);

    // Every one of those is on the record.
    const log = (await as('root', '/activity?module=settings&limit=50')).body.entries || [];
    const actions = log.map((e) => e.action).filter((a) => String(a).startsWith('settings.holidays'));
    for (const want of ['settings.holidays.create', 'settings.holidays.update', 'settings.holidays.delete']) {
      assert.ok(actions.includes(want), `${want} is logged (saw ${actions.join(', ')})`);
    }
  });

  await t.test('a day that has begun is read-only, edit and delete alike', async () => {
    await declareToday('Republic Day');
    await restart();
    try {
      const list = await as('root', ROOT);
      assert.strictEqual(list.status, 200, JSON.stringify(list.body));
      const mine = list.body.upcoming.find((e) => e.date === today());
      assert.ok(mine, 'today is listed under upcoming, because it has not finished');
      assert.strictEqual(mine.editable, false, 'and the server says it cannot be changed');

      for (const [verb, options] of [
        ['PUT', { method: 'PUT', body: { date: plusDays(40), name: 'Moved' } }],
        ['DELETE', { method: 'DELETE' }],
      ]) {
        const r = await as('root', `${ROOT}/${mine.id}`, options);
        assert.strictEqual(r.status, 409, `${verb}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /has begun and can no longer be/i, verb);
        assert.match(r.body.error, /the record is kept rather than rewritten/i, verb);
      }
    } finally {
      await undeclareToday();
      await restart();
    }
  });

  /* --- what a holiday does to the clock ------------------------------------ */

  await t.test('work starts on an ordinary day, and a holiday tomorrow changes nothing today', async () => {
    const assetId = await assetFor('ana', 'Ordinary');
    const planned = await as('root', ROOT, { method: 'POST', body: { date: tomorrow(), name: 'Tomorrow Off' } });
    assert.strictEqual(planned.status, 201, JSON.stringify(planned.body));
    try {
      const started = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
      assert.strictEqual(started.status, 200, JSON.stringify(started.body));
      /* THE OTHER HALF OF "refused on a holiday": the refusal has to be about
         the day and not about holidays existing. A holiday declared for
         tomorrow must leave today alone, which is the same assertion as
         "allowed on the next day" seen from the other side of midnight — and
         it is the one an off-by-one in the date comparison would fail. */
      const rows = await sessions(assetId);
      assert.strictEqual(rows.length, 1, 'a session is open');
      assert.strictEqual(rows[0].ended_at, null, 'and the clock is running');
    } finally {
      await as('root', `${ROOT}/${planned.body.entry.id}`, { method: 'DELETE' });
      await clearOpen('ana');
    }
  });

  await t.test('on a holiday, Accept and Start is refused by name', async () => {
    const assetId = await assetFor('ana', 'Closed Day Start');
    await declareToday('Diwali');
    await restart();
    try {
      const r = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      /* THE HOLIDAY'S OWN NAME, not the generic off-hours sentence. "The working
         day ended" read at eleven in the morning sends somebody looking for
         what else has gone wrong, which is the complaint that split pausedFor
         into break and day in the first place. */
      assert.match(r.body.error, /closed for Diwali/, JSON.stringify(r.body));
      assert.ok(!/working day ended/i.test(r.body.error), 'and not the off-hours wording');
      assert.strictEqual(r.body.holiday.date, today());
      assert.strictEqual(r.body.holiday.name, 'Diwali');

      // Nothing was accepted and nothing was stamped: the refusal is above the
      // transition, so the asset did not move either.
      assert.strictEqual((await sessions(assetId)).length, 0, 'no session was opened');
      const board = await as('ana', `/assets/project/${projectId}`);
      assert.strictEqual(board.status, 200, JSON.stringify(board.body));
      const row = (board.body.assets || []).find((x) => x.id === assetId);
      assert.strictEqual(row.status, 'assigned', 'and the asset was not accepted');

      /* AND THE REASON REACHES SOMEBODY WHO CANNOT SEE THE CALENDAR. This is
         the brief's question about whether a view permission is needed to
         understand a refused timer: it is not, and must not be. */
      const held = await heldBy('game_artist');
      await setPerms('game_artist', held.filter((k) => k !== 'settings.holidays_view'));
      try {
        const me = await as('ana', '/auth/me');
        assert.ok(!me.body.user.permissions.includes('settings.holidays_view'),
          'this session cannot read the calendar');
        const again = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
        assert.strictEqual(again.status, 409);
        assert.match(again.body.error, /closed for Diwali/,
          'and is still told which holiday refused them');
      } finally {
        await setPerms('game_artist', held);
      }
    } finally {
      await undeclareToday();
      await restart();
      /* Defensive, and it earns its place: a FAILURE here — or a mutant that
         lets the start through — leaves a session open, and the one-active-task
         rule then fails the next case for a reason that has nothing to do with
         it. One red subtest should not read as three. */
      await clearOpen('ana');
    }
  });

  await t.test('on a holiday, Resume is refused by name too', async () => {
    const assetId = await assetFor('ana', 'Closed Day Resume');
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    const put = await as('ana', `/assets/${assetId}/hold`, { method: 'POST', body: { note: 'back later' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    await declareToday('Holi');
    await restart();
    try {
      const r = await as('ana', `/assets/${assetId}/resume`, { method: 'POST' });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /closed for Holi/, JSON.stringify(r.body));
      /* NOT the "the recording schedule paused this and starts it again on its
         own" sentence, which is true and says nothing about which day — and not
         "use Accept and Start", which is advice that cannot be taken. The
         holiday check sits above all three answers for exactly that reason. */
      assert.ok(!/starts it again on its own/.test(r.body.error));
      assert.ok(!/Accept and Start/.test(r.body.error));
      assert.strictEqual(r.body.holiday.name, 'Holi');
    } finally {
      await undeclareToday();
      await restart();
      await clearOpen('ana');
    }
  });

  /* THE SWEEP AND THE RESUME, which is where the arithmetic is.
   *
   * A session open since before the holiday began. The sweep must put it down
   * at the holiday's midnight — crediting the hours before it and none of the
   * holiday — and the automatic resume must then leave it alone until the
   * studio opens again. Those are two separate consumers of the same funnel and
   * they fail differently, so both are asserted from one setup.
   */
  await t.test('a timer running when a holiday begins is put down at its midnight, and not resumed into it', async () => {
    await clearOpen('ana');
    const assetId = await assetFor('ana', 'Across Midnight');
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);

    /* Open since two hours before the studio's own midnight — so two hours of
       it fall on the eve, which the clock was running for, and everything after
       falls on the holiday, which it was not. Computed from studioMinute()
       rather than from a wall clock, so the suite means the same thing at any
       hour it runs at. */
    const minutesIntoToday = studioMinute();
    const backSeconds = (minutesIntoToday + 120) * 60;
    await sql(cfg, `UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL ${backSeconds} SECOND)
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

    await declareToday('Pongal');
    await restart();
    try {
      const rows = await sweptUntil(assetId, (r) => r.length === 1 && r[0].ended_at !== null,
        'put the open stretch down');
      assert.strictEqual(rows.length, 1, 'still one stretch — the sweep closed it, it did not open another');
      assert.strictEqual(rows[0].ended_reason, 'off_hours',
        'put down by the studio, with the reason the lunch blackout already uses');
      assert.ok(rows[0].ended_at, 'and it is closed');

      /* TWO HOURS, NOT TWO HOURS PLUS THE HOLIDAY SO FAR. This is the number
         that moves if workingSecondsBetween stops consulting the holiday, and
         it moves upwards — the studio billed for a day it was closed. A minute
         of tolerance because the session's start and the sweep's run are two
         real instants. */
      const hours = Number(rows[0].seconds) / 3600;
      assert.ok(Math.abs(hours - 2) < 0.02,
        `the eve's two hours were credited and the holiday was not — got ${hours.toFixed(3)}h`);

      /* AND THE RESUME DID NOT FIRE, which is the case the brief singled out.
         The sweep that just ran does both halves: if resumesAt had ignored
         holidays, resumeOverdue would have opened a second session back-dated
         into the closed day, and the row count above would be two. Asserted
         again from the other direction so a failure is unambiguous. */
      assert.strictEqual(rows.filter((r) => r.ended_at === null).length, 0,
        'nothing was resumed into the holiday');

      // A second restart changes nothing: the holiday is still on, so the
      // resume is still a no-op rather than something that fires once.
      await restart();
      /* The opposite shape: here the claim is that NOTHING changes, so there is
         no condition to wait for. Waiting for the sweep to have run at all is
         the nearest honest thing — it has run when the open stretch is still
         closed and still alone — and a pass that was going to open a second
         session would have to do it before this settles. */
      const after = await sweptUntil(assetId, (r) => r.length >= 1 && r[0].ended_at !== null,
        'run its second pass');
      assert.strictEqual(after.length, 1, 'and a later sweep opens nothing either');

      // The paused state the panel reads names the holiday rather than the day.
      const work = (await as('ana', `/assets/${assetId}/worklog`)).body.work;
      assert.ok(work.held, 'the panel sees a pause');
      assert.strictEqual(work.held.reason, 'off_hours');
      assert.strictEqual(work.held.pausedFor, 'holiday',
        'and a third sentence, not "the working day ended"');
      assert.strictEqual(work.held.holiday.name, 'Pongal');
    } finally {
      await undeclareToday();
    }

    /* AND NOW THE HOLIDAY IS OVER. The same sweep, with the only thing that was
       holding the session down removed, resumes it — which is what proves the
       holiday was doing the work above rather than some other closure. */
    await restart();
    const resumed = await sweptUntil(assetId, (r) => r.length === 2, 'picked the stretch back up');
    assert.strictEqual(resumed.length, 2, 'the studio is open again, so the stretch is picked up');
    assert.strictEqual(resumed[1].ended_at, null, 'and it is running');
    await clearOpen('ana');
  });

  /* THE BACK-DATED STAMP, WHICH IS THE ONE THE BRIEF SINGLED OUT.
   *
   * resumeOverdue is the only consumer of the funnel that WRITES an instant
   * rather than reading one: it back-dates the resumed session to
   * resumesAt(pausedAt), so somebody who signs in at eleven finds the morning
   * already counted. If resumesAt does not step over a closed day, that stamp
   * lands INSIDE the holiday and the holiday is then credited — silently, on a
   * day nobody could have worked.
   *
   * THE CASES ABOVE CANNOT CATCH THAT, and it is worth saying why rather than
   * leaving it to be rediscovered. On the holiday itself resumeOverdue returns
   * at its first line — isRecording(now) is false — so resumesAt is never
   * reached. The mutation only bites when the sweep runs on an OPEN day with a
   * closed one between it and the pause:
   *
   *   two days ago ... a holiday, and a session put down by the studio
   *   yesterday ...... a holiday
   *   now ............ the studio open, the sweep running
   *
   * TWO HOLIDAYS, NOT ONE, and the pause sitting on the first of them. Under
   * this suite's 00:00-24:00 clock every other instant is inside a recordable
   * span, so resumesAt would hand the pause straight back and there would be no
   * day for a holiday to be skipped over — the gap has to BE the holidays.
   *
   * AND THE ASSERTION IS A DATE, NOT A NUMBER OF MINUTES. A first attempt at
   * this compared ages in minutes and was wrong in a way worth recording: a
   * holiday-blind resumesAt hands back an instant two days old, which
   * start()'s own clamp then pulls to exactly twenty-four hours — so the
   * mutant's stamp and the correct one can be a single minute apart when the
   * suite happens to run just before midnight IST. The IST DAY the stamp falls
   * on separates them cleanly at every hour: today if the holidays were
   * stepped over, yesterday if they were not.
   */
  await t.test('the overnight resume is stamped at today\'s opening, not the holiday\'s', async () => {
    await clearOpen('ana');
    const assetId = await assetFor('ana', 'Resume Past A Holiday');
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);

    /* Put down by the studio two days ago. Written rather than swept, because
       the sweep cannot be made to run two days ago — and this is the exact row
       shape resumeOverdue reads: off_hours, the current round, nothing newer. */
    await sql(cfg, `UPDATE work_sessions
         SET started_at = DATE_SUB(NOW(), INTERVAL 50 HOUR),
             ended_at   = DATE_SUB(NOW(), INTERVAL 48 HOUR),
             seconds    = 7200,
             ended_reason = 'off_hours'
       WHERE asset_id = '${assetId}'`);

    const closed = [plusDays(-1), plusDays(-2)];
    for (const date of closed) {
      await sql(cfg, `INSERT INTO studio_holidays (id, holiday_date, \`name\`, note)
        VALUES (UUID(), '${date}', 'Pujo ${date}', 'between the pause and the sweep')`);
    }
    try {
      await restart();

      const rows = await sweptUntil(assetId, (r) => r.length === 2, 'picked the stretch back up');
      assert.strictEqual(rows.length, 2, 'the sweep picked the stretch up — the studio is open today');
      assert.strictEqual(rows[1].ended_at, null, 'and it is running');

      /* WHICH DAY THE RESUMED STRETCH SAYS IT BEGAN ON, read with the same
         +5:30 shift src/work-log.js uses for its own day questions, so no
         DATETIME is converted in the test either. */
      const [{ began }] = await sql(cfg,
        `SELECT DATE(started_at + INTERVAL 330 MINUTE) AS began FROM work_sessions
          WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
      const beganISO = require('../src/holidays').toISODate(began);
      assert.strictEqual(beganISO, plusDays(0),
        `the resume stepped over both closed days and stamped today — got ${beganISO}, `
        + `and ${plusDays(-1)} would be the holiday itself`);

      /* AND THE SECONDS FOLLOW THE STAMP. Nothing from either closed day is in
         the figure, which is the consequence that costs money if the stamp is
         wrong: work_sessions.seconds is the one column behind Time Spent, the
         Efficiency report, the Time Sheet's suggestions and both P&L tabs. */
      const [{ credited }] = await sql(cfg,
        `SELECT COALESCE(SUM(seconds), 0) AS credited FROM work_sessions
          WHERE asset_id = '${assetId}' AND ended_at IS NOT NULL`);
      assert.strictEqual(Number(credited), 7200,
        'the closed stretch keeps the two hours it was recorded with, and gains nothing');
    } finally {
      for (const date of closed) {
        await sql(cfg, `DELETE FROM studio_holidays WHERE holiday_date = '${date}'`);
      }
      await restart();
      await clearOpen('ana');
    }
  });

  /* --- the permission, in both directions --------------------------------- */

  await t.test('the calendar is readable by everyone and writable by a Super Admin alone', async () => {
    // A Producer holds the view key by default and not the manage key.
    const held = await heldBy('producer');
    assert.ok(held.includes('settings.holidays_view'), 'view is on by default');
    assert.ok(!held.includes('settings.holidays'), 'manage is not');

    const read = await as('pat', ROOT);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body.canManage, false,
      'and the payload tells the page to draw it read-only');

    for (const options of [
      { method: 'POST', body: { date: plusDays(50), name: 'No' } },
      { method: 'PUT', body: { date: plusDays(51), name: 'No' } },
      { method: 'DELETE' },
    ]) {
      const p = options.method === 'POST' ? ROOT : `${ROOT}/whatever`;
      const r = await as('pat', p, options);
      assert.strictEqual(r.status, 403, `${options.method}: ${JSON.stringify(r.body)}`);
    }

    /* A GRANT REACHES THE SAME TOKEN, with no sign-out. The page re-reads
       /auth/me every twenty seconds, so this is the page's own question. */
    await setPerms('producer', [...held, 'settings.holidays']);
    try {
      const me = await as('pat', '/auth/me');
      assert.ok(me.body.user.permissions.includes('settings.holidays'),
        'the session it belongs to sees the grant without signing in again');
      const made = await as('pat', ROOT, { method: 'POST', body: { date: plusDays(50), name: 'Granted' } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.strictEqual(made.body.canManage, true);
      const back = await as('pat', ROOT);
      assert.strictEqual(back.body.canManage, true, 'and the read says so too');
      await as('pat', `${ROOT}/${made.body.entry.id}`, { method: 'DELETE' });
    } finally {
      await setPerms('producer', held);
    }

    // And a revoke closes it again, on that same token.
    const after = await as('pat', ROOT, { method: 'POST', body: { date: plusDays(52), name: 'Revoked' } });
    assert.strictEqual(after.status, 403, JSON.stringify(after.body));

    /* THE VIEW KEY REVOKED. The list closes — and the refusal from /start does
       not, which is asserted in the Accept and Start case above. */
    await setPerms('producer', held.filter((k) => k !== 'settings.holidays_view'));
    try {
      assert.strictEqual((await as('pat', ROOT)).status, 403, 'the calendar closes');
    } finally {
      await setPerms('producer', held);
      assert.strictEqual((await as('pat', ROOT)).status, 200, 'and opens again');
    }
  });

  /* --- the other consumers of a closed day -------------------------------- */

  await t.test('the Idle Report and the Time Sheet both know about a holiday', async () => {
    const planned = await as('root', ROOT, { method: 'POST', body: { date: tomorrow(), name: 'Tomorrow Shut' } });
    assert.strictEqual(planned.status, 201, JSON.stringify(planned.body));
    try {
      /* THE SCHEDULE CARRIES IT, as a JSON-safe array. A Set here would reach
         every screen as `{}` and read as "no holidays" while the clock knew
         better, which is why work-schedule publishes an array. */
      const sched = (await as('root', '/branding/schedule')).body.schedule;
      assert.ok(Array.isArray(sched.holidays), 'holidays survive JSON as a list');
      assert.ok(sched.holidays.includes(tomorrow()), 'and the declared day is in it');

      /* THE REPORT EXPECTS LESS. Asked over a range that contains tomorrow, so
         the holiday is inside the period rather than beside it. */
      const from = today();
      const to = plusDays(2);
      const report = (await as('root', `/idle/report?from=${from}&to=${to}`)).body;
      assert.strictEqual(report.status, undefined);
      const open = idle.workingDaysBetween(from, to, sched.workingDays);
      assert.strictEqual(report.workingDays, open - 1,
        'one working day fewer than the same range with nothing declared');
      assert.strictEqual(report.holidaysInPeriod, 1,
        'and the report says why, rather than leaving a smaller number unexplained');
      /* Carried beside the working-day figure it explains, and NOT in the
         caveats — which have to match the Admin Dashboard's word for word. */
      const capacity = (await as('root', '/admin-dashboard')).body.capacity;
      if (capacity) {
        assert.deepStrictEqual(capacity.caveats, report.caveats,
          'the dashboard and the report still print the same sentences');
      }

      // THE TIME SHEET LABELS THE DAY and still offers the row — see the note
      // in shapeDay for why a holiday parts company with a weekend here.
      const week = (await as('ana', `/timesheets/week?date=${tomorrow()}`)).body;
      const day = (week.days || []).find((d) => d.date === tomorrow());
      assert.ok(day, 'the holiday is still a fillable row, unlike a weekend');
      assert.strictEqual(day.holiday.name, 'Tomorrow Shut');
      const ordinary = (week.days || []).find((d) => d.date !== tomorrow() && !d.weekend);
      if (ordinary) assert.strictEqual(ordinary.holiday, null, 'and an ordinary day carries no label');
    } finally {
      await as('root', `${ROOT}/${planned.body.entry.id}`, { method: 'DELETE' });
    }
  });
});
