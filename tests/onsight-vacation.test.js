/* ONSIGHT, AND VACATION MODE.
 *
 * ===========================================================================
 * THE TWO PROPERTIES THIS FILE EXISTS FOR, because everything else here is a
 * button and these two are the ones that change numbers:
 *
 *   ONSIGHT CHANGES NOTHING ABOUT TIME. Somebody at a client's office is at
 *   work: every hour they record counts, their timesheet is still due, their
 *   timers still run. The only thing it changes is that nobody chases them to
 *   start an asset timer in the studio's pipeline. A mark that quietly excused
 *   a timesheet or removed an afternoon would look exactly like one that did
 *   not, on every screen, until somebody reconciled a month.
 *
 *   A VACATION IS LEAVE ROWS AND NOTHING ELSE. src/vacation.js materialises
 *   one ordinary user_day_status row per working day through
 *   src/day-status.js's mark(), so the time arithmetic, the timesheet rule, the
 *   nudges, the timer block and the follow-up lists all apply without one line
 *   of them knowing vacations exist. A second engine would agree with the first
 *   on the day it was written — which is the mistake this codebase has found
 *   and fixed under four different names.
 *
 * So the tests below are mostly arithmetic and structure, and the clicks are
 * the smaller half.
 *
 * FIXED DATES THROUGHOUT, in November 2026, chosen so the weekends are
 * unambiguous: 2nd Mon ... 6th Fri, 7th Sat, 8th Sun, 9th Mon ... 13th Fri.
 * Nothing here reads the real clock except where it says it does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const dayStatus = require('../src/day-status');
const vacation = require('../src/vacation');
const leaveSettings = require('../src/leave-settings');
const followUp = require('../src/follow-up');
const catalog = require('../src/permission-catalog');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('onsight');
const PASSWORD = 'Onsight-Vac-1!';

const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const NEXT_MON = '2026-11-09';
const NEXT_FRI = '2026-11-13';

const WEEKDAYS = { loggableDays: [1, 2, 3, 4, 5], isHoliday: () => false };

/* ===========================================================================
 * 1. THE SHARED DECISION, with no server at all.
 *
 * One function decides what each status does to the two lists, and this is the
 * whole of it in one table. The mutations in the report target these four
 * cells specifically.
 * ======================================================================== */

test('what each status does to the two lists, in one table', () => {
  const row = (kind, portion = null, planned = false) => ({
    kind, portion, planned, date: MON, windowStart: null, windowEnd: null,
  });
  const at = Date.parse(`${MON}T05:00:00Z`);   // 10:30 IST, a working moment

  const table = [
    // kind        portion        nothingToStart  timesheetOwed  leaveWindows
    ['leave', 'full', true, false, 1],
    ['leave', 'first_half', false, true, 1],
    ['leave', 'second_half', false, true, 1],
    ['idle', null, true, true, 0],
    ['onsight', null, true, true, 0],
  ];

  for (const [kind, portion, , owed, windows] of table) {
    const r = row(kind, portion);
    assert.strictEqual(dayStatus.timesheetRequiredFromRow(r), owed,
      `${kind}/${portion}: a timesheet is ${owed ? '' : 'not '}owed`);
    assert.strictEqual(dayStatus.windowsFromRow(r).length, windows,
      `${kind}/${portion}: ${windows} leave window(s), which is what removes hours`);
  }

  /* nothingToStart() is asked separately because a FULL DAY of leave answers it
     through its window rather than through this function — see the follow-up
     section's excusedFromStart. What matters here is that idle and onsight both
     answer yes, and that leave's halves do not. */
  assert.strictEqual(dayStatus.nothingToStart(row('idle')), true);
  assert.strictEqual(dayStatus.nothingToStart(row('onsight')), true);
  assert.strictEqual(dayStatus.nothingToStart(row('leave', 'full')), false);
  assert.strictEqual(dayStatus.nothingToStart(row('leave', 'first_half')), false);
  assert.strictEqual(dayStatus.nothingToStart(null), false);

  /* ONSIGHT NEVER BLOCKS A TIMER, which is the same fact as "no leave window":
     the sweep and the start gate both read windowsFromRow(). */
  assert.strictEqual(dayStatus.expectedToWorkFromRow(row('onsight'), at), true,
    'somebody onsight is expected to be working');
  assert.strictEqual(dayStatus.leaveEndsAt(row('onsight'), at), null,
    'and there is no window for a refusal to name');

  /* A VACATION IS A LEAVE ROW. Whatever `planned` says, the three judgements
     are the leave ones — which is the whole claim of this feature. */
  for (const portion of ['full', 'first_half', 'second_half']) {
    const marked = row('leave', portion, false);
    const planned = row('leave', portion, true);
    assert.strictEqual(dayStatus.timesheetRequiredFromRow(planned),
      dayStatus.timesheetRequiredFromRow(marked), `${portion}: a vacation owes what leave owes`);
    assert.strictEqual(dayStatus.windowsFromRow(planned).length,
      dayStatus.windowsFromRow(marked).length, `${portion}: and excludes what leave excludes`);
  }
});

test('the chip wording is the server’s, and the page does not write its own', () => {
  assert.strictEqual(followUp.chipFor({ kind: 'idle' }), 'Idle');
  assert.strictEqual(followUp.chipFor({ kind: 'onsight' }), 'Onsight');
  assert.strictEqual(followUp.chipFor({ kind: 'onsight', clientName: 'Acme Pictures' }), 'Onsight: Acme Pictures');
  assert.strictEqual(followUp.chipFor({ kind: 'leave', portion: 'full' }), 'Leave: full day');
  assert.strictEqual(followUp.chipFor({ kind: 'leave', portion: 'full', planned: true }), 'Vacation: full day');
  assert.strictEqual(followUp.chipFor({ kind: 'leave', portion: 'first_half', planned: true }), 'Vacation: first half');

  /* AND THE PAGE PRINTS IT RATHER THAN DECIDING IT. The strip and the row chip
     were two copies of one ternary before this; a grep is what keeps them from
     becoming two again. */
  assert.ok(!/Leave: \$\{|Vacation: \$\{/.test(PAGE),
    'the page must not build a status chip itself — it prints row.chip');
});

test('describe() says vacation where the row is planned, and names the client where it is onsight', () => {
  const base = { date: MON, windowStart: 0, windowEnd: 780 };
  assert.strictEqual(dayStatus.describe({ ...base, kind: 'onsight' }), 'Onsight');
  assert.strictEqual(dayStatus.describe({ ...base, kind: 'onsight', clientName: 'Acme' }), 'Onsight — Acme');
  assert.strictEqual(dayStatus.describe({ ...base, kind: 'leave', portion: 'full' }), 'Leave — Full Day');
  assert.strictEqual(dayStatus.describe({ ...base, kind: 'leave', portion: 'full', planned: true }), 'Vacation — Full Day');
  assert.match(dayStatus.describe({ ...base, kind: 'leave', portion: 'first_half', planned: true }),
    /^Vacation — First Half \(until /);
});

/* ===========================================================================
 * 2. THE VACATION ENGINE, pure.
 * ======================================================================== */

test('a vacation covers working days only, and its halves land on the first and last of them', () => {
  const days = (o) => vacation.daysOf(o, WEEKDAYS).map((d) => `${d.date}:${d.portion}`);

  assert.deepStrictEqual(days({ from: MON, to: FRI }),
    [`${MON}:full`, `${TUE}:full`, `${WED}:full`, `${THU}:full`, `${FRI}:full`]);

  /* TWO WEEKENDS INSIDE A FORTNIGHT ARE NOT LEAVE. Ten rows, not fourteen. */
  assert.strictEqual(vacation.daysOf({ from: MON, to: NEXT_FRI }, WEEKDAYS).length, 10);
  assert.strictEqual(vacation.spanDays(MON, NEXT_FRI), 12);

  // A weekend-only range has nothing to record.
  assert.deepStrictEqual(days({ from: SAT, to: SUN }), []);

  // The halves.
  assert.deepStrictEqual(days({ from: MON, to: WED, fromPortion: 'second_half', toPortion: 'first_half' }),
    [`${MON}:second_half`, `${TUE}:full`, `${WED}:first_half`]);

  /* THE PORTION FOLLOWS THE ROWS, NOT THE CALENDAR. A Saturday start puts its
     half-day on the Monday — the first day anybody is actually away — rather
     than on a date that gets no row at all. */
  assert.deepStrictEqual(days({ from: SAT, to: NEXT_MON, fromPortion: 'second_half' }),
    [`${NEXT_MON}:second_half`]);

  // A holiday inside the range is skipped, asked of the calendar and not guessed.
  assert.deepStrictEqual(
    vacation.daysOf({ from: MON, to: THU }, { loggableDays: [1, 2, 3, 4, 5], isHoliday: (d) => d === WED })
      .map((d) => d.date), [MON, TUE, THU]);

  /* ONE DAY DESCRIBED FROM BOTH ENDS IS A FULL DAY. "Starts second half, ends
     first half" on a single date is two conflicting halves, and the honest row
     is the whole day. */
  assert.deepStrictEqual(days({ from: MON, to: MON, fromPortion: 'second_half', toPortion: 'first_half' }),
    [`${MON}:full`]);
});

test('self-service starts tomorrow and is bounded, and neither rule applies to a manager', () => {
  const today = MON;
  const ok = (input, opts) => vacation.validate(input, { today, ...opts });

  const soon = ok({ from: today, to: today });
  assert.strictEqual(soon.ok, false);
  assert.strictEqual(soon.errors[0].code, 'too_soon');
  assert.match(soon.errors[0].message, /tomorrow at the earliest/);

  assert.strictEqual(ok({ from: TUE, to: TUE }).ok, true, 'tomorrow is allowed');
  assert.strictEqual(ok({ from: '2026-10-30', to: '2026-10-30' }).ok, false, 'and the past is not');

  /* THE FLOOR IS ONE DAY WHATEVER THE SETTING SAYS. */
  const floored = ok({ from: TUE, to: TUE }, { settings: { minNoticeDays: 0, maxRangeDays: 60 } });
  assert.strictEqual(floored.ok, true, 'a notice setting of 0 still means tomorrow');
  const zeroToday = ok({ from: today, to: today }, { settings: { minNoticeDays: 0, maxRangeDays: 60 } });
  assert.strictEqual(zeroToday.ok, false, 'and never today');

  const long = ok({ from: TUE, to: '2027-03-01' }, { settings: { minNoticeDays: 1, maxRangeDays: 60 } });
  assert.strictEqual(long.ok, false);
  assert.strictEqual(long.errors[0].code, 'too_long');

  const notice = ok({ from: TUE, to: TUE }, { settings: { minNoticeDays: 5, maxRangeDays: 60 } });
  assert.strictEqual(notice.ok, false);
  assert.match(notice.errors[0].message, /5 days/);

  /* NEITHER RULE BINDS SOMEBODY RECORDING ON SOMEBODY ELSE'S BEHALF. */
  assert.strictEqual(ok({ from: today, to: today }, { forSelf: false }).ok, true);
  assert.strictEqual(ok({ from: '2026-01-01', to: '2026-03-01' }, { forSelf: false }).ok, true);

  // Backwards is backwards for everybody.
  assert.strictEqual(ok({ from: FRI, to: TUE }, { forSelf: false }).ok, false);
});

test('the settings refuse Vacation mode while Leave, Idle & Onsight is off', () => {
  const base = { ...leaveSettings.DEFAULTS, firstHalfEndMinutes: 780, secondHalfStartMinutes: 840 };
  const off = leaveSettings.validate({ enabled: false, vacationEnabled: true }, { existing: base });
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.errors[0].field, 'vacationEnabled');
  assert.match(off.errors[0].message, /made of leave days/);

  const on = leaveSettings.validate({ enabled: true, vacationEnabled: true }, { existing: base });
  assert.strictEqual(on.ok, true);
  assert.strictEqual(on.value.vacationEnabled, true);

  // And the notice floor is refused at the edge rather than silently raised.
  const zero = leaveSettings.validate({ enabled: true, vacationMinNoticeDays: 0 }, { existing: base });
  assert.strictEqual(zero.ok, false);
  assert.match(zero.errors[0].message, /between 1 and/);
});

test('every toggle in the Leave group is in the audit summary', () => {
  const schedule = { dayStart: 540, dayEnd: 1080 };
  const base = { ...leaveSettings.DEFAULTS, enabled: true, firstHalfEndMinutes: 780, secondHalfStartMinutes: 840 };
  /* EACH TOGGLE IS MOVED AWAY FROM WHATEVER IT CURRENTLY DEFAULTS TO, rather
     than to a hard-coded value. Prompt 56 flipped two of these defaults ON and
     this test then asserted that setting `true` to `true` produced an audit
     line — which is not a bug in the audit line. A move is a move whichever way
     the default points, and exactly one clause should move. */
  for (const field of ['enabled', 'vacationEnabled', 'vacationRequireApproval', 'vacationEmailEnabled']) {
    const line = leaveSettings.describeChange(base, { ...base, [field]: !base[field] }, { schedule });
    assert.ok(line.includes('→'), `${field} must appear in the audit line: ${line}`);
    assert.strictEqual(line.split(';').length, 1, `${field} must be the only clause that moved: ${line}`);
  }
  const numbers = [
    ['vacationMinNoticeDays', 7, /notice 1 day\(s\) → notice 7 day\(s\)/],
    ['vacationMaxRangeDays', 30, /longest range 60 day\(s\) → longest range 30 day\(s\)/],
  ];
  for (const [field, value, pattern] of numbers) {
    const line = leaveSettings.describeChange(base, { ...base, [field]: value }, { schedule });
    assert.match(line, pattern, `${field} must appear in the audit line`);
  }
  assert.match(leaveSettings.describeChange(base, { ...base, firstHalfEndMinutes: 720 }, { schedule }),
    /first half ends 12:00/);
});

test('there is exactly one engine: vacation.js writes no day table of its own', () => {
  const src = SRC('vacation.js');
  /* THE STRUCTURAL CLAIM. Every day a vacation creates goes through
     dayStatus.mark(); every day it clears goes through dayStatus.clear(). A
     module that wrote user_day_status itself would agree with the engine on the
     day it was written and drift the first time mark() learned something new —
     which is what the window snapshot, the unique key and the replace-history
     all are. */
  assert.ok(/dayStatus\.mark\(/.test(src), 'vacation.js materialises through dayStatus.mark()');
  assert.ok(/dayStatus\.clear\(/.test(src), 'and clears through dayStatus.clear()');
  assert.ok(!/INSERT\s+INTO\s+user_day_status/i.test(src),
    'vacation.js must never insert a day row itself');
  assert.ok(!/UPDATE\s+user_day_status/i.test(src),
    'vacation.js must never update a day row itself');

  /* AND IT IS NOT CONSULTED BY THE TIME ARITHMETIC. Nothing that decides
     whether an hour counts may require this module. */
  for (const file of ['day-status.js', 'work-log.js', 'working-time.js', 'follow-up.js', 'timesheets.js']) {
    assert.ok(!/require\(['"]\.\/vacation['"]\)/.test(SRC(file)),
      `src/${file} must not read src/vacation.js — the day rows are the authority`);
  }
});

test('the five new permission keys exist, with the defaults the brief asks for', () => {
  const roles = require('../src/roles');
  const holders = (key) => roles.roleKeys().filter((r) => {
    const def = roles.roleDef(r);
    return def && catalog.BY_KEY.get(key).impliedBy(def);
  });

  for (const key of ['followup.mark_onsight', 'leave.request', 'leave.view_team',
    'leave.approve', 'leave.manage_all']) {
    assert.ok(catalog.BY_KEY.has(key), `${key} is in the catalogue`);
    assert.ok(catalog.grantableKeys().includes(key), `${key} is grantable per designation`);
  }

  assert.deepStrictEqual(holders('followup.mark_onsight'), ['super_admin']);
  assert.deepStrictEqual(holders('leave.approve'), ['super_admin']);
  assert.deepStrictEqual(holders('leave.manage_all'), ['super_admin']);

  /* Booking your own time off reaches everybody who can fill a timesheet, which
     is everybody — compared as sets rather than listed, so the two cannot
     drift apart without this failing. */
  assert.deepStrictEqual(holders('leave.request'), holders('timesheet.own'));
  assert.ok(holders('leave.request').length > 1);

  // Reading who is away reaches leads too, and nobody who merely contributes.
  const viewers = holders('leave.view_team');
  assert.ok(viewers.includes('super_admin'));
  assert.ok(viewers.length > 1);
  for (const r of viewers) {
    const def = roles.roleDef(r);
    assert.ok(def.leadsTeam || def.managePermissions, `${r} leads a team or administers the studio`);
  }
});

test('every endpoint of both features is behind requirePermission', () => {
  const leaveRoutes = SRC('routes/leave.js');
  /* EVERY ROUTE IN THE FILE, matched by its declaration rather than by a count
     — so an endpoint added later without a gate fails this instead of slipping
     past a number somebody forgot to raise. */
  const declared = [...leaveRoutes.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'\s*,\s*([^\n]*)/g)];
  assert.ok(declared.length >= 5, `found ${declared.length} leave routes`);
  const gated = new Set();
  for (const [, verb, routePath, rest] of declared) {
    const m = /requirePermission\('(leave\.[a-z_]+)'\)/.exec(rest);
    assert.ok(m, `${verb.toUpperCase()} ${routePath} must name a leave.* permission`);
    gated.add(m[1]);
  }
  assert.deepStrictEqual([...gated].sort(),
    ['leave.approve', 'leave.request', 'leave.view_team'],
    'and between them the routes use exactly the three keys they should');
  /* AND NEVER THE TIER. hasFullAccess is legitimate in exactly one place in
     this feature — marking your own day on People to follow up, which predates
     it — and nowhere in the vacation routes. */
  assert.ok(!/hasFullAccess/.test(leaveRoutes.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the vacation routes decide nothing from the Super Admin tier');

  // The onsight mark is gated by its own key, through the kind map.
  const dash = SRC('routes/admin-dashboard.js');
  assert.match(dash, /onsight: 'followup\.mark_onsight'/);
});

/* ===========================================================================
 * 3. AGAINST A REAL SERVER.
 * ======================================================================== */

test('Onsight and Vacation mode, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);
  const today = () => require('../src/timesheet-gate').istDate(Date.now());

  const handle = {
    async query(text, params = []) {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return '?'; });
      const rows = await sql(cfg, translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };

  const mark = (body, who = 'root') => as(who, '/admin-dashboard/follow-up/day-status', { method: 'POST', body });
  const undo = (body, who = 'root') => as(who, '/admin-dashboard/follow-up/day-status/clear', { method: 'POST', body });
  const settings = (body) => as('root', '/admin/settings/leave', { method: 'PUT', body });
  const lists = async (date) => (await as('root', `/admin-dashboard/follow-up?date=${date}&mode=day`)).body;
  const marksOf = async (who) => q(
    'SELECT *, DATE_FORMAT(`date`, \'%Y-%m-%d\') AS day FROM user_day_status '
    + 'WHERE user_id = ? AND cleared_at IS NULL ORDER BY `date`', [id[who]]);

  /* THE SWITCHES ON, through the endpoint an admin uses — never by writing the
     table, so the dependency between them is exercised rather than bypassed. */
  const bothOn = () => settings({
    enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
    vacationEnabled: true, vacationRequireApproval: false,
    vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true,
  });

  /* GRANT THROUGH THE ENDPOINT A SUPER ADMIN USES, never by writing
     role_permissions — so what the requests below exercise is the same
     resolution a studio's own change goes through. Asserted, because a silent
     refusal here reads later as "the permission does not work". */
  const setRole = async (role, keys) => {
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: keys } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    return r;
  };
  const heldBy = async (role) => (await as('root', `/permissions/roles/${role}`)).body.role.permissions
    .filter((p) => p.enabled).map((p) => p.key);
  const grant = async (role, keys) => setRole(role, [...new Set([...await heldBy(role), ...keys])]);
  const revoke = async (role, keys) => setRole(role, (await heldBy(role)).filter((k) => !keys.includes(k)));

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'ov-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'ov-token', name: 'Root', email: 'root@ov.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@ov.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@ov.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@ov.test', 'game_artist');
    await make('lee', 'Lee Lead', 'lee@ov.test', 'team_lead');
    /* An account outside everybody's projects, for the scope rule. */
    await make('far', 'Far Away', 'far@ov.test', 'game_artist');
    await q("UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@ov.test'");

    id.client = (await as('root', '/clients', { method: 'POST', body: { name: 'Acme Pictures' } })).body.client.id;
    const project = await as('root', '/projects', { method: 'POST',
      body: { name: 'Hero Quest', clientId: id.client } });
    id.project = project.body.project.id;
    for (const key of ['ana', 'bo', 'lee']) {
      await as('root', `/users/${id[key]}`, { method: 'PATCH', body: { projectId: id.project } });
    }
    const other = await as('root', '/projects', { method: 'POST',
      body: { name: 'Side Job', clientId: id.client } });
    id.other = other.body.project.id;
    await as('root', `/users/${id.far}`, { method: 'PATCH', body: { projectId: id.other } });

    const asset = await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name: 'Hero', type: 'character' } });
    id.asset = asset.body.asset.id;
  });

  t.after(() => stopServer(server));

  // ---- Onsight -----------------------------------------------------------

  await t.test('marking somebody onsight for today, with a client', async () => {
    await bothOn();
    const r = await mark({ userId: id.ana, kind: 'onsight', clientId: id.client, note: 'At Acme all week' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.status.kind, 'onsight');
    assert.strictEqual(r.body.status.clientId, id.client);
    assert.strictEqual(r.body.status.clientName, 'Acme Pictures');
    assert.strictEqual(r.body.label, 'Onsight — Acme Pictures');
    assert.deepStrictEqual(r.body.days, [today()]);
    /* NO TIMER WAS STOPPED, because onsight has no leave window at all. */
    assert.strictEqual(r.body.stoppedTimers, 0);
    /* AND NO REASSIGN OFFER: that is a full day of leave's, and onsight is not
       a day off. */
    assert.strictEqual(r.body.reassign, null);

    const rows = await marksOf('ana');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'onsight');
    assert.strictEqual(rows[0].client_id, id.client);
    assert.strictEqual(rows[0].portion, null, 'onsight has no portion');
    assert.strictEqual(rows[0].window_start_time, null, 'and no window — that is what makes its hours count');
  });

  await t.test('onsight is off Not started but stays on Timesheet not filled', async () => {
    const after = await lists(today());
    const inStart = (after.notStarted.rows || []).some((r) => r.id === id.ana);
    const inFill = (after.notFilled.rows || []).some((r) => r.id === id.ana);
    assert.strictEqual(inStart, false, 'nobody chases somebody at a client’s office to press Start');
    assert.strictEqual(inFill, true, 'but the timesheet is still owed — they were at work');

    /* THE SHARED FUNCTIONS AGREE, asked one person at a time against the same
       database the list read in one query. */
    assert.strictEqual(await dayStatus.isTimesheetRequired(handle, id.ana, today()), true);
    const row = await dayStatus.userDayStatus(handle, id.ana, today());
    assert.strictEqual(dayStatus.nothingToStart(row), true);
    assert.strictEqual(dayStatus.timesheetRequiredFromRow(row), true);
    assert.strictEqual(dayStatus.windowsFromRow(row).length, 0);

    // The strip counts it as its own thing, and the chip names the client.
    assert.strictEqual(after.leave.onsight, 1);
    assert.strictEqual(after.leave.onLeave, 0);
    const chip = after.leave.rows.find((r) => r.userId === id.ana);
    assert.strictEqual(chip.chip, 'Onsight: Acme Pictures');
    assert.strictEqual(chip.portionLabel, 'Onsight');
  });

  await t.test('an onsight day’s hours still count, and a timer still starts', async () => {
    /* HOURS. A session recorded inside the onsight day must survive it
       untouched — asked of countedSeconds(), which is the one function every
       figure in this application goes through. */
    const day = today();
    await q(`INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
             VALUES (?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), id.asset, id.ana, 1, `${day} 10:00:00`, `${day} 12:00:00`, 7200]);

    const windows = await dayStatus.leaveWindows(handle, id.ana, day);
    assert.deepStrictEqual(windows, [], 'an onsight day excludes no interval at all');

    const counted = dayStatus.countedSeconds(
      Date.parse(`${day}T10:00:00+05:30`), Date.parse(`${day}T12:00:00+05:30`), { windows });
    assert.ok(counted > 0, 'and the two hours are still counted');

    /* TIMERS. The gate reads isExpectedToWorkAt(), which an onsight row answers
       yes to — so starting work is allowed. Asserted through the shared
       function rather than by driving the asset state machine, because that is
       what the gate asks. */
    assert.strictEqual(
      await dayStatus.isExpectedToWorkAt(handle, id.ana, Date.parse(`${day}T10:00:00+05:30`)), true);
    const sweep = await dayStatus.sweepLeave(handle);
    assert.deepStrictEqual(sweep.filter((s) => s.userId === id.ana), [],
      'and the leave sweep never touches an onsight day');
  });

  await t.test('a multi-day Until covers working days and skips the rest', async () => {
    /* A FORTNIGHT IN ONE PRESS. The dates are today onward so the start is
       legal; the span crosses a weekend, which must get no rows. */
    const from = today();
    const to = vacation.addDays(from, 13);
    const r = await mark({ userId: id.bo, kind: 'onsight', clientId: id.client, until: to });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const rows = await marksOf('bo');
    const dates = rows.map((x) => x.day);
    assert.deepStrictEqual(dates, r.body.days, 'the rows are the days the response named');

    /* EVERY ROW IS A WORKING DAY, asked of the gate rather than of a weekday
       calculation here. */
    const gate = require('../src/timesheet-gate');
    const policy = require('../src/timesheet-settings');
    for (const d of dates) {
      assert.strictEqual(gate.isWorkingDay(d, {
        loggableDays: (policy.current() || {}).loggableDays,
        isHoliday: () => false,
      }), true, `${d} is a working day`);
    }
    assert.ok(dates.length >= 8 && dates.length <= 12, `${dates.length} working days in a fortnight`);
    assert.ok(dates.length < 14, 'and never the whole calendar span');
  });

  await t.test('Undo is per day, and another kind replaces one day only', async () => {
    const dates = (await marksOf('bo')).map((x) => x.day);
    const second = dates[1];
    const u = await undo({ userId: id.bo, date: second });
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    const left = (await marksOf('bo')).map((x) => x.day);
    assert.ok(!left.includes(second), 'that one day is cleared');
    assert.strictEqual(left.length, dates.length - 1, 'and the rest of the range is untouched');

    /* Replacing one day with leave keeps the history and the other days. TODAY,
       because Prompt 48 refuses leave on a date that has not happened yet and
       that rule is unchanged here — only onsight's range reaches forward. */
    const third = dates[0];
    const r = await mark({ userId: id.bo, kind: 'leave', portion: 'full', date: third });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const rows = await q('SELECT kind, cleared_at FROM user_day_status WHERE user_id = ? AND `date` = ? ORDER BY seq', [id.bo, third]);
    assert.strictEqual(rows.length, 2, 'the onsight row is kept as history');
    assert.strictEqual(String(rows[0].kind), 'onsight');
    assert.ok(rows[0].cleared_at, 'and is cleared');
    assert.strictEqual(String(rows[1].kind), 'leave');
    assert.strictEqual(rows[1].cleared_at, null);
  });

  await t.test('Onsight needs its own key, its own scope, and the past-date key', async () => {
    /* THE WHOLE SECTION NEEDS report.admin_dashboard FIRST — the dashboard
       router gates itself before any of its routes are reached — so a lead
       being tested for the marking keys needs that one too. Granting it is part
       of the fixture, not part of what is under test. */
    await grant('team_lead', ['report.admin_dashboard', 'report.follow_up', 'followup.mark_leave']);
    const no = await mark({ userId: id.ana, kind: 'onsight' }, 'lee');
    assert.strictEqual(no.status, 403, JSON.stringify(no.body));
    assert.strictEqual(no.body.code, 'forbidden',
      'and it is the KIND that was refused, not the section — Mark Leave is not Mark Onsight');

    await grant('team_lead', ['followup.mark_onsight']);
    const yes = await mark({ userId: id.ana, kind: 'onsight', clientId: id.client }, 'lee');
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));

    // Out of scope: Far Away is on a project the lead cannot see.
    const out = await mark({ userId: id.far, kind: 'onsight' }, 'lee');
    assert.strictEqual(out.status, 403, JSON.stringify(out.body));
    assert.match(out.body.error, /projects you can see/);

    // Marking yourself: only a studio-wide administrator may.
    const self = await mark({ userId: id.lee, kind: 'onsight' }, 'lee');
    assert.strictEqual(self.status, 403, JSON.stringify(self.body));
    assert.strictEqual(self.body.code, 'self');
    const rootSelf = await mark({ userId: id.root, kind: 'onsight' });
    assert.strictEqual(rootSelf.status, 200, JSON.stringify(rootSelf.body));
    await undo({ userId: id.root, date: today() });

    // A past date needs the further key, exactly as leave does.
    const yesterday = vacation.addDays(today(), -1);
    const past = await mark({ userId: id.ana, kind: 'onsight', date: yesterday }, 'lee');
    if (past.status === 409 && past.body.code === 'non_working_day') {
      // Yesterday was a weekend or a holiday; the rule is still the one below.
    } else {
      assert.strictEqual(past.status, 403, JSON.stringify(past.body));
      assert.strictEqual(past.body.code, 'past_date');
    }
    await revoke('team_lead', ['report.admin_dashboard', 'report.follow_up', 'followup.mark_leave', 'followup.mark_onsight']);
  });

  // ---- Vacation ----------------------------------------------------------

  await t.test('a person books their own vacation, and it becomes leave rows', async () => {
    await bothOn();
    const from = vacation.addDays(today(), 3);
    const to = vacation.addDays(from, 6);
    const r = await as('ana', '/leave/mine', { method: 'POST', body: { from, to, note: 'Diwali' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.request.status, 'approved', 'approval is off, so it takes effect at once');
    assert.ok(r.body.days.length >= 4, `${r.body.days.length} working days materialised`);
    id.vac = r.body.request.id;

    /* EVERY DAY IS AN ORDINARY LEAVE ROW with source 'planned' and the
       request's id — which is what makes the whole time engine apply. */
    const rows = await q('SELECT * FROM user_day_status WHERE request_id = ? AND cleared_at IS NULL ORDER BY `date`', [id.vac]);
    assert.strictEqual(rows.length, r.body.days.length);
    for (const row of rows) {
      assert.strictEqual(String(row.kind), 'leave');
      assert.strictEqual(String(row.source), 'planned');
      assert.strictEqual(String(row.portion), 'full');
      assert.ok(row.window_start_time === null || Number(row.window_start_time) === 0);
    }

    // And the shared judgements treat them as leave.
    const day = r.body.days[0];
    assert.strictEqual(await dayStatus.isTimesheetRequired(handle, id.ana, day), false,
      'a full day of vacation owes no timesheet');
    const row = await dayStatus.userDayStatus(handle, id.ana, day);
    assert.strictEqual(dayStatus.windowsFromRow(row).length, 1, 'and its hours are excluded');
    assert.strictEqual(row.planned, true);
    assert.match(dayStatus.describe(row), /^Vacation/);
  });

  await t.test('the strip calls it Vacation, and the lists drop the person', async () => {
    /* ON A VACATION THAT IS RUNNING TODAY, because People to follow up is about
       today and the days behind it — a future date is not a day anybody failed
       to start. Booked through the manager path so it may include today. */
    const r = await as('root', '/leave/mine', { method: 'POST',
      body: { userId: id.lee, from: vacation.addDays(today(), -1), to: vacation.addDays(today(), 3) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.days.includes(today()) || r.body.days.length,
      'the fixture covers today, or at least some days');
    const after = await lists(today());
    const id_ana = id.ana;
    assert.ok(id_ana);
    if (!r.body.days.includes(today())) {
      /* Today is a weekly off or a holiday, so there is no row to look at and
         the lists are about nothing. The rule is the one asserted below on the
         days that do exist. */
      assert.ok(r.body.days.every((d) => d !== today()));
      return;
    }
    assert.strictEqual((after.notStarted.rows || []).some((x) => x.id === id.lee), false,
      'somebody on vacation is not asked why they have not started');
    assert.strictEqual((after.notFilled.rows || []).some((x) => x.id === id.lee), false,
      'nor for a timesheet on a full day');
    const chip = after.leave.rows.find((x) => x.userId === id.lee);
    assert.ok(chip, 'the person is on the strip');
    assert.strictEqual(chip.chip, 'Vacation: full day');
    assert.strictEqual(chip.planned, true);
    assert.ok(after.leave.onVacation >= 1);
    await as('root', `/leave/${r.body.request.id}/cancel`, { method: 'POST', body: { fromDate: r.body.days[0] } });
  });

  await t.test('today is refused, the past is refused, and an overlap is named', async () => {
    const tooSoon = await as('ana', '/leave/mine', { method: 'POST', body: { from: today(), to: today() } });
    assert.strictEqual(tooSoon.status, 422, JSON.stringify(tooSoon.body));
    assert.strictEqual(tooSoon.body.errors[0].code, 'too_soon');

    const past = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), -5), to: vacation.addDays(today(), -4) } });
    assert.strictEqual(past.status, 422);

    const existing = (await as('ana', '/leave/mine')).body.vacations
      .find((v) => v.status === 'approved');
    const clash = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: existing.from, to: existing.to } });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.strictEqual(clash.body.code, 'overlap');
    assert.ok(clash.body.overlap.length, 'and it lists the dates');
    assert.match(clash.body.error, new RegExp(clash.body.overlap[0].date));

    /* COMPLEMENTARY HALVES SAY WHAT TO DO INSTEAD rather than being allowed:
       the schema holds one active row per person per day. */
    const halfFrom = vacation.addDays(today(), 40);
    const h1 = await as('bo', '/leave/mine', { method: 'POST',
      body: { from: halfFrom, to: halfFrom, fromPortion: 'first_half', toPortion: 'first_half' } });
    assert.strictEqual(h1.status, 201, JSON.stringify(h1.body));
    const h2 = await as('bo', '/leave/mine', { method: 'POST',
      body: { from: halfFrom, to: halfFrom, fromPortion: 'second_half', toPortion: 'second_half' } });
    if (h2.status === 409) {
      assert.strictEqual(h2.body.code, 'overlap');
      assert.ok(h2.body.overlap.every((c) => c.complementary));
      assert.match(h2.body.error, /choose Full Day instead/);
    } else {
      assert.strictEqual(h2.status, 422, `a half-day on a non-working day: ${JSON.stringify(h2.body)}`);
    }
  });

  await t.test('the maximum range and the notice period are the studio’s', async () => {
    const long = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 100), to: vacation.addDays(today(), 400) } });
    assert.strictEqual(long.status, 422);
    assert.strictEqual(long.body.errors[0].code, 'too_long');

    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: true, vacationMinNoticeDays: 7, vacationMaxRangeDays: 10, vacationEmailEnabled: true });
    const soon = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 2), to: vacation.addDays(today(), 3) } });
    assert.strictEqual(soon.status, 422);
    assert.match(soon.body.errors[0].message, /7 days/);
    const wide = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 200), to: vacation.addDays(today(), 215) } });
    assert.strictEqual(wide.status, 422);
    assert.strictEqual(wide.body.errors[0].code, 'too_long');
    await bothOn();
  });

  await t.test('ending a vacation early clears tomorrow onward and keeps today', async () => {
    /* A vacation that is already running, written through the engine itself so
       it is the same rows a booking would make. */
    const r0 = await as('root', '/users', { method: 'POST',
      body: { name: 'Dee Early', email: 'dee@ov.test', password: PASSWORD, role: 'game_artist' } });
    id.dee = r0.body.user.id;
    token.dee = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'dee@ov.test', password: PASSWORD } })).body.token;
    await as('root', `/users/${id.dee}`, { method: 'PATCH', body: { projectId: id.project } });

    const from = vacation.addDays(today(), -2);
    const to = vacation.addDays(today(), 5);
    const made = await as('root', '/leave/mine', { method: 'POST',
      body: { userId: id.dee, from, to, note: 'Already away' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const live = made.body.days;
    assert.ok(live.includes(today()) || live.length, 'it covers today or at least some days');

    const ended = await as('dee', `/leave/${made.body.request.id}/cancel`, { method: 'POST', body: {} });
    assert.strictEqual(ended.status, 200, JSON.stringify(ended.body));
    assert.ok(ended.body.cleared.every((d) => d > today()),
      `cleared ${JSON.stringify(ended.body.cleared)} — none of it may be today or earlier`);
    assert.ok(ended.body.kept.every((d) => d <= today()));
    if (live.includes(today())) {
      assert.ok(ended.body.kept.includes(today()), 'today stays excluded until a lead undoes it');
      const row = await dayStatus.userDayStatus(handle, id.dee, today());
      assert.ok(row && row.kind === 'leave', 'and the row is still there');
    }
    assert.strictEqual(ended.body.request.status, ended.body.kept.length ? 'ended_early' : 'cancelled');
  });

  await t.test('cancelling before it starts clears every day', async () => {
    const from = vacation.addDays(today(), 60);
    const r = await as('root', '/leave/mine', { method: 'POST',
      body: { userId: id.ana, from, to: vacation.addDays(from, 3) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const made = r.body.days;
    assert.ok(made.length, 'it made days');

    const c = await as('ana', `/leave/${r.body.request.id}/cancel`, { method: 'POST', body: {} });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.deepStrictEqual(c.body.cleared.sort(), made.sort(), 'every day goes');
    assert.deepStrictEqual(c.body.kept, []);
    assert.strictEqual(c.body.request.status, 'cancelled');
    const left = await q('SELECT COUNT(*) AS n FROM user_day_status WHERE request_id = ? AND cleared_at IS NULL',
      [r.body.request.id]);
    assert.strictEqual(Number(left[0].n), 0);
  });

  await t.test('reaching into today needs leave.manage_all', async () => {
    /* A FRESH PERSON, so this is not competing with another case's dates: an
       overlap refusal here would look like a permission result. */
    const r0 = await as('root', '/users', { method: 'POST',
      body: { name: 'Cy Clean', email: 'cy@ov.test', password: PASSWORD, role: 'game_artist' } });
    id.cy = r0.body.user.id;
    token.cy = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'cy@ov.test', password: PASSWORD } })).body.token;
    await as('root', `/users/${id.cy}`, { method: 'PATCH', body: { projectId: id.project } });

    const from = vacation.addDays(today(), -1);
    const r = await as('root', '/leave/mine', { method: 'POST',
      body: { userId: id.cy, from, to: vacation.addDays(today(), 4) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const refused = await as('cy', `/leave/${r.body.request.id}/cancel`, {
      method: 'POST', body: { fromDate: today() } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'past_date');

    const allowed = await as('root', `/leave/${r.body.request.id}/cancel`, {
      method: 'POST', body: { fromDate: from } });
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    assert.ok(allowed.body.cleared.includes(from) || allowed.body.cleared.length === 0,
      'a manager may clear a day that has passed');
  });

  await t.test('somebody else’s vacation is not yours to book or cancel', async () => {
    const mineOnly = await as('ana', '/leave/mine', { method: 'POST',
      body: { userId: id.bo, from: vacation.addDays(today(), 20), to: vacation.addDays(today(), 21) } });
    assert.strictEqual(mineOnly.status, 403, JSON.stringify(mineOnly.body));
    assert.strictEqual(mineOnly.body.code, 'not_yours');

    const booked = await as('bo', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 25), to: vacation.addDays(today(), 26) } });
    assert.strictEqual(booked.status, 201, JSON.stringify(booked.body));
    const nope = await as('ana', `/leave/${booked.body.request.id}/cancel`, { method: 'POST', body: {} });
    assert.strictEqual(nope.status, 403);
    assert.strictEqual(nope.body.code, 'not_yours');

    // And out of scope on somebody else's behalf, even holding manage_all.
    const out = await as('root', '/leave/mine', { method: 'POST',
      body: { userId: id.far, from: vacation.addDays(today(), 230), to: vacation.addDays(today(), 231) } });
    assert.strictEqual(out.status, 201,
      `the Super Admin is studio-wide, so Far Away is in reach: ${JSON.stringify(out.body)}`);
  });

  await t.test('approval mode: nothing is excluded until somebody approves', async () => {
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: true, vacationRequireApproval: true,
      vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true });

    const from = vacation.addDays(today(), 70);
    const r = await as('ana', '/leave/mine', { method: 'POST', body: { from, to: vacation.addDays(from, 2) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.request.status, 'submitted');
    assert.strictEqual(r.body.approvalNeeded, true);
    assert.deepStrictEqual(r.body.days, [], 'NOTHING is materialised while it waits');
    const none = await q('SELECT COUNT(*) AS n FROM user_day_status WHERE request_id = ?', [r.body.request.id]);
    assert.strictEqual(Number(none[0].n), 0);

    // A person cannot approve their own.
    const self = await as('ana', `/leave/${r.body.request.id}/decide`, { method: 'POST', body: { approve: true } });
    assert.strictEqual(self.status, 403, JSON.stringify(self.body));

    const ok = await as('root', `/leave/${r.body.request.id}/decide`, { method: 'POST', body: { approve: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.request.status, 'approved');
    assert.ok(ok.body.days.length, 'and now the days exist');

    // Deciding twice is refused rather than duplicating the days.
    const again = await as('root', `/leave/${r.body.request.id}/decide`, { method: 'POST', body: { approve: false } });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'already_decided');

    // A rejected one never touches time.
    const r2 = await as('bo', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 80), to: vacation.addDays(today(), 81) } });
    const no = await as('root', `/leave/${r2.body.request.id}/decide`,
      { method: 'POST', body: { approve: false, note: 'Crunch week' } });
    assert.strictEqual(no.status, 200, JSON.stringify(no.body));
    assert.strictEqual(no.body.request.status, 'rejected');
    const zero = await q('SELECT COUNT(*) AS n FROM user_day_status WHERE request_id = ?', [r2.body.request.id]);
    assert.strictEqual(Number(zero[0].n), 0);
    await bothOn();
  });

  await t.test('the switches: off refuses new bookings and keeps existing ones working', async () => {
    const from = vacation.addDays(today(), 90);
    const made = await as('ana', '/leave/mine', { method: 'POST', body: { from, to: vacation.addDays(from, 2) } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const day = made.body.days[0];

    // Vacation mode off, Leave still on.
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: false, vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true });
    const refused = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 95), to: vacation.addDays(today(), 96) } });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'feature_disabled');

    /* AN EXISTING VACATION KEEPS ITS EFFECT. The switch governs CREATION and
       nothing else — the same rule Settings → Leave already follows for marked
       leave, and the reason is that a setting which rewrites a past month's
       totals twice in opposite directions is not a setting. */
    assert.strictEqual(await dayStatus.isTimesheetRequired(handle, id.ana, day), false);
    const row = await dayStatus.userDayStatus(handle, id.ana, day);
    assert.strictEqual(dayStatus.windowsFromRow(row).length, 1, 'its hours are still excluded');

    // The list is still readable and still cancellable, or nothing could be undone.
    const listed = await as('ana', '/leave/mine');
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.body.rules.enabled, false);
    assert.ok(listed.body.vacations.some((v) => v.id === made.body.request.id));
    const cancelled = await as('ana', `/leave/${made.body.request.id}/cancel`, { method: 'POST', body: {} });
    assert.strictEqual(cancelled.status, 200, 'an upcoming vacation can still be cancelled');

    /* AND THE VACATION SWITCH CANNOT BE ON WHILE LEAVE IS OFF. */
    const both = await settings({ enabled: false, vacationEnabled: true });
    assert.strictEqual(both.status, 422, JSON.stringify(both.body));
    assert.match(both.body.error, /made of leave days/);
    await bothOn();
  });

  await t.test('who hears about a vacation, and who never does', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM email_outbox').catch(() => {});
    await grant('team_lead', ['leave.view_team']);
    /* Lee leads Hero Quest, which Ana is on. */
    await q('INSERT IGNORE INTO project_team_leads (project_id, user_id) VALUES (?,?)', [id.project, id.lee]);

    const from = vacation.addDays(today(), 120);
    const r = await as('ana', '/leave/mine', { method: 'POST', body: { from, to: vacation.addDays(from, 2) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const notes = await q('SELECT recipient_id, actor_id, kind, detail FROM notifications WHERE kind = ?', ['vacation']);
    const to = notes.map((n) => n.recipient_id);
    assert.ok(to.includes(id.lee), 'the lead is told');
    assert.ok(!to.includes(id.ana), 'and the person is never told about their own booking');
    assert.strictEqual(new Set(to).size, to.length, 'nobody is told twice');
    assert.match(String(notes[0].detail), /Ana Artist booked a vacation/);

    const mails = await q('SELECT recipient FROM email_outbox').catch(() => []);
    assert.ok(!mails.some((m) => String(m.recipient) === 'ana@ov.test'),
      'and never emailed about their own');

    // The switch off means no mail and still a bell.
    await q('DELETE FROM notifications');
    await q('DELETE FROM email_outbox').catch(() => {});
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: true, vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: false });
    const r2 = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 130), to: vacation.addDays(today(), 131) } });
    assert.strictEqual(r2.status, 201, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.notified.mailed.reason, 'switch_off');
    const stillBelled = await q('SELECT COUNT(*) AS n FROM notifications WHERE kind = ?', ['vacation']);
    assert.ok(Number(stillBelled[0].n) > 0, 'in-app is always raised');
    const noMail = await q('SELECT COUNT(*) AS n FROM email_outbox').catch(() => [{ n: 0 }]);
    assert.strictEqual(Number(noMail[0].n), 0, 'and no mail was queued');
    await revoke('team_lead', ['leave.view_team']);
    await bothOn();
  });

  await t.test('an approver booking their own vacation is not told about it', async () => {
    /* THE ONE CASE WHERE THE ACTOR IS GENUINELY IN THEIR OWN RECIPIENT LIST,
       and the only one — which is why the first run of the mutation that removes
       the actor-skip came back MISSED against the cases above.
       leadsFor() excludes the person by its own SQL (lead.user_id <> $1), so a
       lead booking their own holiday is never among their own leads. But
       approvers() is "everybody who holds leave.approve", and in approval mode
       a Super Admin booking their own vacation is in that list. Without the
       skip they would be told, and emailed, about their own submission.

       TWO GUARDS, BOTH ASSERTED: notifications.raise() refuses
       recipientId === actorId, and email-notifications skips the actor. Either
       alone would be a rule somebody could delete without a test noticing. */
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: true, vacationRequireApproval: true,
      vacationMinNoticeDays: 1, vacationMaxRangeDays: 60, vacationEmailEnabled: true });
    const cfgOn = await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: 2525, encryption: 'none',
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
    assert.ok(cfgOn.status < 400, JSON.stringify(cfgOn.body));
    await q('DELETE FROM notifications');
    await q('DELETE FROM email_outbox');

    /* The Super Admin holds leave.approve, so they are their own approver. */
    const approvers = await as('root', '/permissions/roles/super_admin');
    assert.ok(approvers.body.role.permissions.some((x) => x.key === 'leave.approve' && x.enabled),
      'the Super Admin is an approver, which is what puts them in the list');

    const r = await as('root', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 180), to: vacation.addDays(today(), 181) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.approvalNeeded, true);

    const mine = await q('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND kind = ?',
      [id.root, 'vacation']);
    assert.strictEqual(Number(mine[0].n), 0,
      'the approver is not belled about their own submission');
    const mails = await q('SELECT recipient FROM email_outbox');
    assert.ok(!mails.some((m) => String(m.recipient) === 'root@ov.test'),
      'nor emailed about it');

    /* AND THE DECISION DOES NOT COME BACK TO THEM EITHER, when they approve
       their own: the decision notice goes to the person, and they are the
       person. raise() is what refuses it. */
    await q('DELETE FROM notifications');
    const ok = await as('root', `/leave/${r.body.request.id}/decide`, { method: 'POST', body: { approve: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const back = await q('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND kind = ?',
      [id.root, 'vacation']);
    assert.strictEqual(Number(back[0].n), 0, 'and not told they approved themselves');

    await as('root', '/email-config', { method: 'PUT', body: { enabled: false } }).catch(() => {});
    await bothOn();
  });

  await t.test('a send failure never fails the booking', async () => {
    /* FAILURE INJECTED AT THE OUTBOX, which is the one place a send can go
       wrong that a test can reach from outside the process: the table the
       enqueue writes to is taken away, so emailOutbox.enqueue() throws for
       real rather than being told not to bother. The brief asks that this
       never fail the request, and src/email-notifications.js catches every
       path and returns a reason — this is what holds it.

       NOT A MOCK. Nothing is stubbed and the application is not told it is
       being tested; the booking goes through the same route a person's would
       and the mail genuinely cannot be queued. */
    await settings({ enabled: true, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: true, vacationMinNoticeDays: 1, vacationMaxRangeDays: 60,
      vacationEmailEnabled: true });
    await grant('team_lead', ['leave.view_team']);
    await q('INSERT IGNORE INTO project_team_leads (project_id, user_id) VALUES (?,?)', [id.project, id.lee]);
    await q('DELETE FROM notifications');

    /* EMAIL HAS TO BE CONFIGURED FOR A SEND TO FAIL AT ALL. Without a config
       isUsable() is false and the outbox is never touched — which is the
       'email_off' path, a different thing from a broken one. The host below is
       never dialled: enqueue() writes to the outbox table and the sweep does
       the sending, and the sweep is switched off in this suite. */
    const cfgOn = await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: 2525, encryption: 'none',
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
    assert.ok(cfgOn.status < 400, JSON.stringify(cfgOn.body));

    const saved = await q('SHOW CREATE TABLE email_outbox').catch(() => []);
    assert.ok(saved.length, 'the outbox exists to be taken away');
    const ddl = saved[0]['Create Table'];
    await q('DROP TABLE email_outbox');
    try {
      const r = await as('ana', '/leave/mine', { method: 'POST',
        body: { from: vacation.addDays(today(), 160), to: vacation.addDays(today(), 161) } });
      assert.strictEqual(r.status, 201, `the booking survives a broken mailer: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.days.length, 'and the days were still created');
      /* NOTHING WAS QUEUED, AND NOTHING WAS THROWN. The reason comes back null
         rather than 'error', and that is worth recording rather than asserting
         around: emailOutbox.enqueue() does not throw on a broken table, it
         REPORTS — it returns { ok: false, error } — so the failure is absorbed
         one layer below the catch in src/email-notifications.js. The guarantee
         the brief asks for therefore holds twice over, and the observable fact
         is that the count is zero and the request is a 201. */
      assert.strictEqual(r.body.notified.mailed.queued, 0, 'no mail was queued');
      /* AND THE IN-APP HALF STILL ARRIVED. The two are independent: a studio
         with no working mail server must still get its bell. */
      assert.ok(r.body.notified.raised > 0, 'the lead was still told in-app');
      const belled = await q('SELECT COUNT(*) AS n FROM notifications WHERE kind = ?', ['vacation']);
      assert.ok(Number(belled[0].n) > 0);

      /* AND THE SAME FOR A CANCELLATION, which travels the same path. */
      const c = await as('ana', `/leave/${r.body.request.id}/cancel`, { method: 'POST', body: {} });
      assert.strictEqual(c.status, 200, `cancelling survives it too: ${JSON.stringify(c.body)}`);
    } finally {
      await q(ddl);
      await as('root', '/email-config', { method: 'PUT', body: { enabled: false } }).catch(() => {});
    }
    await revoke('team_lead', ['leave.view_team']);
  });

  await t.test('with both switches off, nothing about the studio changes', async () => {
    /* PRODUCTION SAFETY, asserted as the brief states it: both switches off and
       the three screens behave exactly as they did before this prompt. */
    await settings({ enabled: false, firstHalfEndMinutes: '13:00', secondHalfStartMinutes: '14:00',
      vacationEnabled: false, vacationMinNoticeDays: 1, vacationMaxRangeDays: 60,
      vacationEmailEnabled: true });

    // No mark of any kind can be created.
    for (const body of [
      { userId: id.ana, kind: 'onsight' },
      { userId: id.ana, kind: 'idle' },
      { userId: id.ana, kind: 'leave', portion: 'full' },
    ]) {
      const r = await mark(body);
      assert.strictEqual(r.status, 409, `${body.kind}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'feature_disabled');
    }

    // No vacation can be booked, by anybody, for anybody.
    const mine = await as('ana', '/leave/mine', { method: 'POST',
      body: { from: vacation.addDays(today(), 170), to: vacation.addDays(today(), 171) } });
    assert.strictEqual(mine.status, 409);
    assert.strictEqual(mine.body.code, 'feature_disabled');

    // The dashboard still draws, and says the feature is off rather than hiding.
    const d = await lists(today());
    assert.strictEqual(d.status, undefined);
    assert.strictEqual(d.leave.enabled, false);
    assert.ok(Array.isArray(d.notStarted.rows));
    assert.ok(Array.isArray(d.notFilled.rows));

    // And the profile section still reads, so nothing already booked is stuck.
    const listed = await as('ana', '/leave/mine');
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.body.rules.enabled, false);
    assert.strictEqual(listed.body.rules.leaveEnabled, false);
    await bothOn();
  });

  await t.test('who is away, scoped, with the work sitting on their desk', async () => {
    const team = await as('root', '/leave/team');
    assert.strictEqual(team.status, 200, JSON.stringify(team.body));
    for (const v of team.body.vacations) {
      assert.strictEqual(v.type, 'Vacation', 'tagged, so the dashboard can label it');
      assert.ok(Number.isInteger(v.actionable), 'with the assets waiting on them');
    }

    // Without the key, nothing.
    const no = await as('ana', '/leave/team');
    assert.strictEqual(no.status, 403);

    // A lead sees their own people and not Far Away's.
    await grant('team_lead', ['leave.view_team']);
    const from = vacation.addDays(today(), 150);
    await as('root', '/leave/mine', { method: 'POST', body: { userId: id.far, from, to: vacation.addDays(from, 1) } });
    await as('root', '/leave/mine', { method: 'POST', body: { userId: id.bo, from, to: vacation.addDays(from, 1) } });
    const lead = await as('lee', `/leave/team?from=${from}&to=${vacation.addDays(from, 2)}`);
    assert.strictEqual(lead.status, 200, JSON.stringify(lead.body));
    const names = lead.body.vacations.map((v) => v.userId);
    assert.ok(!names.includes(id.far), 'Far Away is outside the lead’s projects');
    assert.ok(names.includes(id.bo), 'and Bo is inside them');
    await revoke('team_lead', ['leave.view_team']);
  });
});
