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
  const moves = [
    ['vacationEnabled', true, /Vacation mode OFF → Vacation mode on/],
    ['vacationRequireApproval', true, /approval not required → .*approval required/],
    ['vacationMinNoticeDays', 7, /notice 1 day\(s\) → notice 7 day\(s\)/],
    ['vacationMaxRangeDays', 30, /longest range 60 day\(s\) → longest range 30 day\(s\)/],
    ['vacationEmailEnabled', false, /vacation email on → vacation email off/],
  ];
  for (const [field, value, pattern] of moves) {
    const line = leaveSettings.describeChange(base, { ...base, [field]: value }, { schedule });
    assert.match(line, pattern, `${field} must appear in the audit line`);
  }
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
