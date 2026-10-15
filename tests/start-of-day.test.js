/* THE START-OF-DAY BANNER, THE TWO REMINDERS, AND THE TOP-BAR TIMER.
 *
 * ===========================================================================
 * WHAT THIS FILE IS GUARDING, and it is three different things.
 *
 * THE STATE IS A QUESTION ABOUT THE STUDIO'S CLOCK, which spans a weekly off, a
 * holiday calendar, three break windows and a timezone. Every case below passes
 * an explicit `now` into a schedule written out in the fixture, because a test
 * of "is it lunch" that read the real clock would pass all morning and fail at
 * half past one — and the bug it is guarding against is a banner that appears
 * during lunch, which is exactly what a wrong answer to that question looks
 * like.
 *
 * THE REMINDERS ARE A QUESTION ABOUT A RACE, and about a server that was down.
 * Exactly once per person per occasion per day has to hold against a sweep that
 * runs every minute, two workers racing, a restart, and a catch-up pass hours
 * later. The test that matters is the one that runs the sweep three times and
 * counts one row — and the one that fires two passes at the same instant.
 *
 * THE INDICATOR IS A QUESTION ABOUT DRIFT. Its elapsed figure is working
 * seconds from the database's own clock, re-sent on every poll; the page adds
 * one per second only while the server says the clock is recording. A tab left
 * open through lunch must not count lunch.
 *
 * ===========================================================================
 * NOTHING HERE IS A NEW DEFINITION, and the first group asserts it: the state
 * module borrows "expected" from Prompt 34, "started on D" from
 * src/follow-up.js, "waiting" from src/waiting-work.js, the clock from
 * src/working-time.js and the start gates from the ordinary start route. Each
 * of those is mutated in the run that accompanies this file and this suite
 * moves with it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, setRecordingWindows, SKIP_REASON } = require('./helpers');

const dayState = require('../src/day-state');
const startReminders = require('../src/start-reminders');
const reminderSettings = require('../src/reminder-settings');
const reminders = require('../src/reminders');
const followUp = require('../src/follow-up');
const waitingWork = require('../src/waiting-work');
const workflow = require('../src/asset-workflow');
const catalog = require('../src/permission-catalog');
const holidays = require('../src/holidays');
const workingTime = require('../src/working-time');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('startday');
const PASSWORD = 'Follow-Up-1!';

/* 2026 March: 16th Mon, 17th Tue, 18th Wed, 19th Thu, 20th Fri, 21st Sat, 22nd Sun. */
const MON = '2026-03-16';
const TUE = '2026-03-17';
const WED = '2026-03-18';
const SAT = '2026-03-21';
const SUN = '2026-03-22';
const ist = (text) => Date.parse(`${text}+05:30`);

/* 11:45, AND NOT 11:00, FOR "MID-MORNING".
 *
 * The schedule below has a quarter of an hour of tea at 11:00 — so 11:00 IST is
 * the first minute of a break, and a case meaning "the studio is recording"
 * written at that minute asserts the opposite of what it says. The first draft
 * of this file did exactly that and five cases failed together, which is the
 * useful kind of failure: the clock really is where the state comes from. */
const MID_MORNING = `${WED}T11:45:00`;

/* THE STUDIO'S SCHEDULE, WRITTEN OUT. 09:30 to 19:00 with an hour for lunch and
   a quarter of an hour for tea, in the named-window shape Settings → Recording
   Hours stores and src/working-time.js reads. Written here rather than taken
   from the live mirror so no case moves when somebody edits the studio's hours. */
const SCHEDULE = {
  workingDays: [1, 2, 3, 4, 5],
  entries: [
    { daysOfWeek: [1, 2, 3, 4, 5], start: 570, end: 1140, type: 'recording' },
    { daysOfWeek: [1, 2, 3, 4, 5], start: 780, end: 840, type: 'non_recording' },
    { daysOfWeek: [1, 2, 3, 4, 5], start: 660, end: 675, type: 'non_recording' },
  ],
  holidays: [],
};
const SHUT = { ...SCHEDULE, holidays: [WED] };

const SETTINGS = { ...reminderSettings.DEFAULTS };

/* THE SAME HOURS, ON EVERY DAY OF THE WEEK, for the live half.
 *
 * The arithmetic cases above choose their own date — 18 March 2026, a Wednesday
 * — and test the weekend and the holiday by asking about a Saturday or a
 * declared day. The LIVE cases cannot choose the date: the sessions and the
 * assets they drive are created by the test and carry the real one, and the
 * sweep's "did they start today" is asked about the day its `now` falls on. So
 * those cases keep the real date, pick the MINUTE, and use a schedule with no
 * weekday restriction — otherwise the whole live half would fail every Saturday,
 * which is precisely the test this codebase keeps deleting.
 *
 * `daysOfWeek` omitted means every day; see appliesOn() in src/working-time.js. */
const LIVE_SCHEDULE = {
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  entries: [
    { start: 570, end: 1140, type: 'recording' },
    { start: 780, end: 840, type: 'non_recording' },
    { start: 660, end: 675, type: 'non_recording' },
  ],
  holidays: [],
};

function stubDb(answers = []) {
  const calls = [];
  return {
    calls,
    sqlFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).sql || ''; },
    paramsFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).params || []; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of answers) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows, result: {} };
      }
      return { rows: [], result: {} };
    },
  };
}

const ARTIST = {
  id: 'u-1', name: 'Ana', email: 'ana@x.test', role: 'game_artist',
  is_active: 1, created_at: '2026-01-02 04:00:00', deactivated_at: null,
};

/* An asset row of the shape src/waiting-work.js's listFor returns. */
const waitingRow = (over = {}) => ({
  id: 'a-1', code: 'CH-001', name: 'Hero', type: 'character', status: 'assigned',
  priority: 'med', dueDate: null, projectId: 'p-1', projectName: 'Alpha', projectCode: 'ALP',
  clientId: 'c-1', clientName: 'Acme', routedToId: null,
  heldSince: '2026-03-18 04:00:00', stateSince: null, ...over,
});

/* The answers day-state asks for, in the order it asks them. */
function answersFor({ open = [], held = [], started = [], waiting = [] } = {}) {
  return [
    [/FROM work_sessions s/, open],
    [/FROM work_sessions w WHERE .*HELD|hold_note/, held],
    [/DATE_FORMAT\(DATE_ADD\(w\.started_at/, started],
    [/FROM assets a\s+JOIN projects p/, waiting],
  ];
}

const forUser = (opts = {}) => dayState.forUser(
  stubDb(opts.answers || answersFor(opts.fixture || {})),
  opts.user || ARTIST,
  {
    now: opts.now === undefined ? ist(`${WED}T11:45:00`) : opts.now,
    gate: opts.gate || null,
    settings: opts.settings || SETTINGS,
    schedule: opts.schedule || SCHEDULE,
  }
);

test.before(async () => {
  await holidays.load({ query: async () => ({ rows: [] }) });
});

// ===========================================================================
// 1. THE STATE. Every case the indicator has to draw.
// ===========================================================================

test('nothing is restated: every fact comes from the module that owns it', () => {
  const src = SRC('day-state.js');
  for (const borrowed of [
    "require('./work-log')", "require('./working-time')", "require('./follow-up')",
    "require('./waiting-work')", "require('./timesheet-gate')", "require('./holidays')",
  ]) assert.ok(src.includes(borrowed), `${borrowed} is asked, not reimplemented`);

  /* NO SECOND READING OF THE CALENDAR OR THE CLOCK. A working-day list, a
     holiday comparison or a break window written out here would be the fourth
     copy of a rule this application has already had drift apart. */
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const smell of ['loggableDays', 'getDay()', 'lunch', '13:00', '780', '1140']) {
    assert.ok(!body.includes(smell), `the state module does not carry "${smell}"`);
  }
  assert.ok(!/isWorkingDay/.test(body), 'and it has no working-day rule of its own');
});

test('MUTATION 1 — running, with a live figure in WORKING seconds', async () => {
  const out = await forUser({
    fixture: { open: [{ id: 's-1', assetId: 'a-1', since: '2026-03-18 04:00:00',
      age_seconds: 5400, code: 'CH-001', name: 'Hero', status: 'in_progress', projectId: 'p-1' }] },
  });
  assert.strictEqual(out.state, 'running');
  assert.strictEqual(out.running.code, 'CH-001');
  /* 5,400 WALL SECONDS AND 4,500 RECORDED ONES. Ninety minutes back from 11:45
     IST is 10:15, and the quarter of an hour of tea at 11:00 falls inside it —
     so the figure the indicator shows is the seventy-five minutes the studio
     counted, not the ninety the wall clock did. That is the whole point of it
     being working seconds: the top bar agrees with the timesheet instead of
     being a larger number beside it. */
  assert.strictEqual(out.running.ageSeconds, 5400, 'ninety wall minutes');
  assert.strictEqual(out.running.elapsedSeconds, 4500, 'and seventy-five recorded ones');
  assert.strictEqual(out.running.ticking, true, 'the clock is recording, so the page may tick');
  assert.strictEqual(out.running.startedAt, new Date(ist(`${WED}T10:15:00`)).toISOString(),
    'the start instant is recovered from the age, never parsed from the stamp');
  assert.strictEqual(out.banner.show, false);
  assert.strictEqual(out.banner.why, 'a timer is running');
  assert.strictEqual(out.startedToday, true);
});

test('a session that ran through lunch does not count lunch', async () => {
  /* Opened at 12:30 and asked at 14:30: two wall hours, of which one was the
     break. The figure is the hour that was recorded — so the indicator agrees
     with the timesheet instead of being a larger number beside it. */
  const out = await forUser({
    now: ist(`${WED}T14:30:00`),
    fixture: { open: [{ id: 's-1', assetId: 'a-1', since: '2026-03-18 07:00:00',
      age_seconds: 7200, code: 'CH-001', name: 'Hero', status: 'in_progress', projectId: 'p-1' }] },
  });
  assert.strictEqual(out.running.ageSeconds, 7200, 'two wall hours');
  assert.strictEqual(out.running.elapsedSeconds, 3600, 'and one recorded hour');
});

test('MUTATION 1b — a running timer is not ticking during a break', async () => {
  const out = await forUser({
    now: ist(`${WED}T13:30:00`),
    fixture: { open: [{ id: 's-1', assetId: 'a-1', since: '2026-03-18 04:00:00',
      age_seconds: 12600, code: 'CH-001', name: 'Hero', status: 'in_progress', projectId: 'p-1' }] },
  });
  assert.strictEqual(out.state, 'running', 'the session is still open');
  assert.strictEqual(out.running.ticking, false,
    'and the page is told to stop counting — a tab left open through lunch must not count lunch');
  assert.match(PAGE, /if\(!DAY_STATE \|\| DAY_STATE\.state !== 'running' \|\| !DAY_STATE\.running\s*\n\s*\|\| !DAY_STATE\.running\.ticking\)\{ clearInterval/,
    'which the tick obeys');
});

test('MUTATION 2 — not running, in working hours, is its own state', async () => {
  const out = await forUser({ fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(out.state, 'idle');
  assert.strictEqual(out.label, 'No timer running');
  assert.strictEqual(out.reason, null, 'nothing is wrong, so there is nothing to explain');
  assert.strictEqual(out.assignedCount, 1);
});

test('MUTATION 3 — lunch, off hours, a weekend and a holiday each say why', async () => {
  const at = async (now, schedule = SCHEDULE) =>
    forUser({ now, schedule, fixture: { waiting: [waitingRow()] } });

  const lunch = await at(ist(`${WED}T13:30:00`));
  assert.strictEqual(lunch.state, 'paused');
  assert.strictEqual(lunch.label, 'Paused – break');
  assert.match(lunch.reason, /on a break/);
  assert.strictEqual(lunch.banner.show, false);
  assert.strictEqual(lunch.banner.why, 'the studio is on a break',
    'A BANNER DURING LUNCH IS THE THING THAT CANNOT HAPPEN');

  const tea = await at(ist(`${WED}T11:05:00`));
  assert.strictEqual(tea.state, 'paused', 'the fifteen-minute break stops the clock too');

  const early = await at(ist(`${WED}T08:00:00`));
  assert.strictEqual(early.state, 'off_hours');
  assert.strictEqual(early.label, 'Outside hours');
  assert.strictEqual(early.banner.why, 'outside working hours');

  const late = await at(ist(`${WED}T20:00:00`));
  assert.strictEqual(late.state, 'off_hours');

  const weekend = await at(ist(`${SAT}T11:45:00`));
  assert.strictEqual(weekend.state, 'closed_day');
  assert.strictEqual(weekend.label, 'Studio closed');
  assert.strictEqual(weekend.banner.why, 'the studio is closed today');
  assert.strictEqual((await at(ist(`${SUN}T11:45:00`))).state, 'closed_day');

  /* A HOLIDAY IS A DAY WITH NO RECORDING SPANS, which is how spansOn() already
     answers it — so the state module needs no holiday rule and this case proves
     it by declaring one in the schedule rather than by stubbing anything here. */
  const holiday = await at(ist(`${WED}T11:45:00`), SHUT);
  assert.strictEqual(holiday.state, 'closed_day');
  assert.strictEqual(holiday.banner.show, false);
  assert.strictEqual(holiday.banner.why, 'the studio is closed today');
});

test('on hold is the person\'s own, and told apart from the studio\'s pause', async () => {
  const mine = await forUser({
    fixture: { held: [{ asset_id: 'a-1', ended_at: '2026-03-18 05:30:00',
      hold_note: null, round: 1, ended_reason: 'held' }], waiting: [waitingRow()] },
  });
  assert.strictEqual(mine.state, 'held');
  assert.strictEqual(mine.label, 'On hold');
  assert.match(mine.reason, /You put this task down/);
  assert.strictEqual(mine.held.assetId, 'a-1');
  assert.strictEqual(mine.held.byStudio, false);

  /* THE STUDIO'S OWN PAUSE IS NOT A HOLD. The sweep writes ended_reason
     'off_hours', and at half past one that is lunch — "you put this down" would
     be a lie about who stopped the clock. */
  const theirs = await forUser({
    now: ist(`${WED}T13:30:00`),
    fixture: { held: [{ asset_id: 'a-1', ended_at: '2026-03-18 07:30:00',
      hold_note: null, round: 1, ended_reason: 'off_hours' }], waiting: [waitingRow()] },
  });
  assert.strictEqual(theirs.state, 'paused', 'the studio stopped it, so it is a break');
  assert.strictEqual(theirs.held.byStudio, true);
});

test('MUTATION 4 — the blocked reason is the gate\'s, and it replaces the button', async () => {
  const gate = {
    blocked: true, date: TUE, dateLabel: 'Tuesday 17 Mar',
    error: 'Fill your timesheet for Tuesday 17 Mar to start work. Open the Time Sheet tab, '
      + 'add a line for that day — an Idle line counts — and this unlocks straight away.',
  };
  const out = await forUser({ gate, fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(out.banner.show, true);
  assert.strictEqual(out.banner.variant, 'blocked',
    'blocked outranks start — offering Start would be a button the server refuses');
  assert.strictEqual(out.blocked.dateLabel, 'Tuesday 17 Mar');
  assert.strictEqual(out.blocked.message, gate.error);

  /* AND THE GATE IS HANDED IN, NOT ASKED AGAIN. /auth/me has already run it for
     its own field; running it twice would be the same query twice on the
     most-polled endpoint and, worse, two answers inside one response. */
  const src = SRC('day-state.js');
  assert.ok(!/timesheetGate\.check\(/.test(src), 'the state module never runs the gate itself');
  assert.match(SRC('routes/auth.js'), /dayStateFor\.forUser\(db, req\.user, \{ gate \}\)/);
});

test('MUTATION 5 — no tasks is a different banner, with no Start', async () => {
  const out = await forUser({ fixture: { waiting: [] } });
  assert.strictEqual(out.banner.show, true);
  assert.strictEqual(out.banner.variant, 'none');
  assert.strictEqual(out.assignedCount, 0);
  assert.deepStrictEqual(out.tasks, []);
  assert.match(PAGE, /You have no tasks assigned today/);
  /* AND THE WORDS SAY THE COUNT when there is one. */
  assert.match(PAGE, /You have \$\{n\} task\$\{n===1\?'':'s'\} assigned/);
});

test('MUTATION 6 — the grace period is read from Settings and gates the banner', async () => {
  /* Opening is 09:30; the default grace is sixty minutes, so 10:29 is inside
     and 10:30 is not. A banner at 09:31 would be the whole studio. */
  const inside = await forUser({ now: ist(`${WED}T10:29:00`), fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(inside.banner.show, false);
  assert.strictEqual(inside.banner.why, 'inside the grace period');
  assert.strictEqual(inside.banner.graceUntil, new Date(ist(`${WED}T10:30:00`)).toISOString(),
    'and it says when it would appear rather than drawing nothing unexplained');

  const after = await forUser({ now: ist(`${WED}T10:30:00`), fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(after.banner.show, true);

  /* A STUDIO THAT MOVED THE GRACE MOVES THE BANNER WITH IT — the number is a
     Settings value and nothing compares to a constant. */
  const wide = await forUser({
    now: ist(`${WED}T10:30:00`), settings: { ...SETTINGS, graceMinutes: 120 },
    fixture: { waiting: [waitingRow()] },
  });
  assert.strictEqual(wide.banner.show, false);
  assert.strictEqual(wide.banner.graceMinutes, 120);
  assert.strictEqual((await forUser({
    now: ist(`${WED}T11:30:00`), settings: { ...SETTINGS, graceMinutes: 120 },
    fixture: { waiting: [waitingRow()] },
  })).banner.show, true);

  /* AND IT IS THE SAME NUMBER THE FOLLOW-UP SECTION USES. One grace period, one
     place — src/follow-up.js reads this setting, with its own constant as the
     default. */
  assert.strictEqual(followUp.GRACE_MINUTES, reminderSettings.DEFAULTS.graceMinutes);
  assert.match(SRC('follow-up.js'), /const graceMinutes = \(\) => \{[\s\S]*?reminderSettings\.current\(\)/);
});

test('MUTATION 7 — somebody who has started today gets no banner', async () => {
  const out = await forUser({ fixture: { started: [{ userId: 'u-1', day: WED }], waiting: [waitingRow()] } });
  assert.strictEqual(out.startedToday, true);
  assert.strictEqual(out.banner.show, false);
  assert.strictEqual(out.banner.why, 'already started today');
  /* AND "STARTED" IS src/follow-up.js'S DEFINITION, asked of it — a second
     reading would be the one that disagrees about a session opened at half past
     midnight IST. */
  assert.match(SRC('day-state.js'), /followUp\.startedDays\(db, \[user\.id\], \{ from: today, to: today \}\)/);
});

test('who is expected is Prompt 34\'s rule, and nobody else gets a banner', () => {
  const on = (over) => dayState.isExpected({ ...ARTIST, ...over }, { today: WED });
  assert.strictEqual(on({}), true);
  /* A DESIGNATION THE STUDIO GIVES WORK TO. Administrators, directors and
     production are not assignable and do not clock time against an asset. */
  assert.strictEqual(on({ role: 'admin' }), false);
  assert.strictEqual(on({ role: 'super_admin' }), false);
  // Deactivated, and dated so.
  assert.strictEqual(on({ is_active: 0, deactivated_at: '2026-02-01 04:00:00' }), false);
  /* CREATED TODAY: on the books, and still not expected. Somebody's first hour
     in the tool should not open with a scolding banner. */
  assert.strictEqual(on({ created_at: `${WED} 04:00:00` }), false);
  /* AND YESTERDAY EVENING IS YESTERDAY. The stamp is UTC — every DATETIME in
     this schema is — so 18:00 UTC on the 17th is 23:30 IST on the 17th, which is
     the hour this comparison has to get right: read naively it would land on the
     18th and the newest starter in the studio would be let off their first full
     day. */
  assert.strictEqual(on({ created_at: `${TUE} 18:00:00` }), true, 'yesterday evening IST is yesterday');
  assert.strictEqual(on({ created_at: `${TUE} 19:00:00` }), false,
    'and half past midnight IST on the 18th is today');
  /* AND THE RULE IS BORROWED: onBooksOn is src/follow-up.js's. */
  assert.match(SRC('day-state.js'), /followUp\.onBooksOn\(person, today\)/);
});

test('the indicator is drawn for a person with a clock, and not for everybody', async () => {
  const artist = await forUser({ fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(artist.indicator.show, true);

  /* AN ADMINISTRATOR IS NOT EXPECTED TO CLOCK TIME, so there is no timer state
     to show them — until they start something, which mayStartWork() lets full
     access do. Then it is their own clock and they see it. */
  const admin = await forUser({ user: { ...ARTIST, role: 'admin' }, fixture: { waiting: [] } });
  assert.strictEqual(admin.expected, false);
  assert.strictEqual(admin.indicator.show, false);
  assert.strictEqual(admin.banner.show, false);
  assert.strictEqual(admin.banner.why, 'not expected to be working today');

  const adminRunning = await forUser({
    user: { ...ARTIST, role: 'admin' },
    fixture: { open: [{ id: 's-1', assetId: 'a-1', since: '2026-03-18 04:00:00', age_seconds: 600,
      code: 'CH-001', name: 'Hero', status: 'in_progress', projectId: 'p-1' }] },
  });
  assert.strictEqual(adminRunning.state, 'running');
  assert.strictEqual(adminRunning.indicator.show, true, 'their own running clock is still theirs');
});

test('MUTATION 8 — the master switch and each half switch it off', async () => {
  const off = await forUser({ settings: { ...SETTINGS, enabled: false } });
  assert.strictEqual(off.on, false);
  assert.strictEqual(off.state, 'off');
  assert.strictEqual(off.banner.show, false);
  assert.strictEqual(off.indicator.show, false);
  /* AND IT COSTS NOTHING: with nothing to draw there is nothing to ask the
     database, on an endpoint every open browser polls every twenty seconds. */
  const db = stubDb();
  await dayState.forUser(db, ARTIST, { now: ist(`${WED}T11:45:00`), settings: { ...SETTINGS, enabled: false } });
  assert.strictEqual(db.calls.length, 0);

  const noBanner = await forUser({ settings: { ...SETTINGS, bannerEnabled: false },
    fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(noBanner.banner.show, false);
  assert.strictEqual(noBanner.banner.why, 'banner switched off');
  assert.strictEqual(noBanner.indicator.show, true, 'the indicator is a separate switch');

  const noPill = await forUser({ settings: { ...SETTINGS, indicatorEnabled: false },
    fixture: { waiting: [waitingRow()] } });
  assert.strictEqual(noPill.indicator.show, false);
  assert.strictEqual(noPill.banner.show, true);
});

test('MUTATION 9 — what the state costs on the poll', async () => {
  const running = stubDb(answersFor({ open: [{ id: 's-1', assetId: 'a-1',
    since: '2026-03-18 04:00:00', age_seconds: 600, code: 'C', name: 'N', status: 'in_progress' }] }));
  await dayState.forUser(running, ARTIST, { now: ist(`${WED}T11:45:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(running.calls.length, 2,
    'a running timer is two: the session, and what kind of day this person is having');

  const idle = stubDb(answersFor({ waiting: [waitingRow()] }));
  await dayState.forUser(idle, ARTIST, { now: ist(`${WED}T11:45:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(idle.calls.length, 5,
    'an idle morning is five: the session, the day mark, the hold, started-today and what is '
    + 'waiting');
  /* FIXED, NOT PER TASK. Forty waiting assets are the same five queries. */
  const many = stubDb(answersFor({
    waiting: Array.from({ length: 40 }, (_, i) => waitingRow({ id: `a-${i}`, name: `A${i}` })),
  }));
  const out = await dayState.forUser(many, ARTIST, { now: ist(`${WED}T11:45:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(many.calls.length, 5);
  assert.strictEqual(out.assignedCount, 40);
  assert.strictEqual(out.tasks.length, dayState.BANNER_TASKS, 'and three of them are offered');
  assert.strictEqual(out.moreTasks, 37);
});

test('the three tasks are the ones the follow-up panel would list, in the same order', async () => {
  const out = await forUser({ fixture: { waiting: [
    waitingRow({ id: 'a-1', name: 'Fresh', heldSince: '2026-03-18 04:00:00' }),
    waitingRow({ id: 'a-2', name: 'Late', dueDate: '2026-03-10' }),
    waitingRow({ id: 'a-3', name: 'Old', heldSince: '2026-03-02 04:00:00' }),
    waitingRow({ id: 'a-4', name: 'Newer', heldSince: '2026-03-17 04:00:00' }),
  ] } });
  assert.deepStrictEqual(out.tasks.map((t) => t.name), ['Late', 'Old', 'Newer'],
    'overdue first, then longest waiting — src/waiting-work.js\'s own order');
  assert.strictEqual(out.tasks[0].overdue, true);
  /* THE SAME PREDICATE AS THE FOLLOW-UP FIGURE, so "N tasks assigned" and the
     "N waiting on them" a lead reads are the same N. */
  assert.match(SRC('day-state.js'), /waitingWork\.listFor\(db, user\.id, \{ studioWide: true \}\)/);
  assert.match(SRC('day-state.js'), /waitingWork\.assetUrgency/);
  /* AND EVERY TASK IT OFFERS IS IN A STATUS THE START ROUTE ACCEPTS: the waiting
     statuses are the startable ones minus in_progress, which is exactly the one
     they have already begun. */
  for (const status of waitingWork.WAITING_STATUSES) {
    assert.ok(workflow.WORKING_STATUSES.includes(status),
      `${status} is startable, so the banner never offers a Start the route refuses`);
  }
  assert.deepStrictEqual(
    workflow.WORKING_STATUSES.filter((s) => !waitingWork.WAITING_STATUSES.includes(s)),
    ['in_progress']);
});

// ===========================================================================
// 2. THE TWO REMINDERS. Windows, and the once-a-day rule.
// ===========================================================================

test('the two occasions take two slots in the table that was built for them', () => {
  /* reminder_log's unique key already spanned `source` and `slot`, and `slot` is
     which of the day's sends this is — so the first reminder takes slot 0 and
     the second slot 1, and "the first, for Ana, today" is one row the database
     accepts once. Nothing in that table or its migration changed. */
  assert.strictEqual(startReminders.SLOT[startReminders.FIRST], 0);
  assert.strictEqual(startReminders.SLOT[startReminders.SECOND], 1);
  assert.match(SRC('migrate.js'),
    /UNIQUE KEY uq_reminder_slot \(recipient_id, kind, source, sent_on, slot\)/);
  assert.strictEqual(reminders.SOURCES.auto, 'auto');
  /* AND THE AUTOMATIC SENDER USES THE EXISTING claim(), so the INSERT is the
     check and there is no read-then-write for a second pass to slip between. */
  assert.match(SRC('start-reminders.js'), /await reminders\.claim\(db, \{/);
  const body = SRC('start-reminders.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/SELECT .*reminder_log/i.test(body), 'nothing is read from the log first');
});

test('MUTATION 10 — the first window ends where the second begins', () => {
  const w = startReminders.windowsFor({
    now: ist(`${WED}T11:45:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(w.open, 570, 'the studio opens at 09:30');
  assert.strictEqual(w.close, 1140, 'and closes at 19:00');
  /* The first is the opening plus the grace, so 10:30; the second is 11:30. */
  assert.deepStrictEqual(w.windows[startReminders.FIRST], { from: 630, to: 690 });
  assert.deepStrictEqual(w.windows[startReminders.SECOND], { from: 690, to: 1140 });

  const due = (text) => startReminders.dueNow({
    now: ist(`${WED}T${text}`), settings: SETTINGS, schedule: SCHEDULE }).due;
  assert.deepStrictEqual(due('10:00:00'), [], 'inside the grace period, nothing is due');
  assert.deepStrictEqual(due('10:30:00'), [startReminders.FIRST]);
  assert.deepStrictEqual(due('11:29:00'), [startReminders.FIRST], 'still catching up');
  assert.deepStrictEqual(due('11:30:00'), [startReminders.SECOND]);
  /* THE FIRST IS NEVER SENT AFTER THE SECOND'S TIME HAS PASSED, which the brief
     asks for: a first reminder at half past two is noise about a morning that is
     over. A mutant that left the first window open to the end of the day sends
     it, and fails here. */
  assert.deepStrictEqual(due('14:00:00'), [startReminders.SECOND]);
  assert.deepStrictEqual(due('19:00:00'), [], 'and neither after the studio shuts');

  /* A STUDIO THAT MOVED EITHER NUMBER MOVES THE WINDOWS. */
  const later = startReminders.windowsFor({ now: ist(`${WED}T11:45:00`),
    settings: { ...SETTINGS, graceMinutes: 90, secondReminderMinutes: 750 }, schedule: SCHEDULE });
  assert.deepStrictEqual(later.windows[startReminders.FIRST], { from: 660, to: 750 });
  assert.deepStrictEqual(later.windows[startReminders.SECOND], { from: 750, to: 1140 });
});

test('a day the studio does not work has no windows at all', () => {
  for (const day of [SAT, SUN]) {
    assert.strictEqual(startReminders.windowsFor({
      now: ist(`${day}T11:00:00`), settings: SETTINGS, schedule: SCHEDULE }), null, day);
  }
  assert.strictEqual(startReminders.windowsFor({
    now: ist(`${WED}T11:45:00`), settings: SETTINGS, schedule: SHUT }), null, 'a holiday');
});

test('MUTATION 11 — nothing is sent on a weekend, a holiday, at lunch or out of hours', async () => {
  const run = (now, schedule = SCHEDULE) => startReminders.sweep(stubDb(), {
    now, settings: SETTINGS, schedule });

  for (const [label, now, schedule] of [
    ['a Saturday', ist(`${SAT}T11:45:00`), SCHEDULE],
    ['a Sunday', ist(`${SUN}T11:45:00`), SCHEDULE],
    ['a holiday', ist(`${WED}T11:45:00`), SHUT],
    ['lunch', ist(`${WED}T13:30:00`), SCHEDULE],
    ['the tea break', ist(`${WED}T11:05:00`), SCHEDULE],
    ['before the studio opens', ist(`${WED}T08:00:00`), SCHEDULE],
    ['after it closes', ist(`${WED}T20:00:00`), SCHEDULE],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await run(now, schedule);
    assert.strictEqual(out.sent, 0, label);
    assert.strictEqual(out.reasons.not_recording, 1, `${label}: the clock said so`);
  }

  /* ALL FOUR ARE ONE QUESTION, asked of the studio's own clock — spansOn() is
     where the weekly off and the holiday calendar already meet, so none of them
     is a rule in the sweep. A mutant that dropped the check sends on a holiday,
     and fails above. */
  assert.match(SRC('start-reminders.js'), /if \(!workingTime\.isRecording\(now, schedule\)\) \{/);
});

test('MUTATION 12 — the master switch and the channels stop the sweep before it reads', async () => {
  const off = stubDb();
  const a = await startReminders.sweep(off, { now: ist(`${WED}T10:30:00`),
    settings: { ...SETTINGS, enabled: false }, schedule: SCHEDULE });
  assert.strictEqual(a.sent, 0);
  assert.strictEqual(a.reasons.disabled, 1);
  assert.strictEqual(off.calls.length, 0, 'and nothing was asked of the database');

  const mute = stubDb();
  const b = await startReminders.sweep(mute, { now: ist(`${WED}T10:30:00`),
    settings: { ...SETTINGS, inAppEnabled: false, emailEnabled: false }, schedule: SCHEDULE });
  assert.strictEqual(b.reasons.no_channel, 1, 'with both channels off there is nothing to send');
  assert.strictEqual(mute.calls.length, 0);
});

test('MUTATION 13 — nobody who has started, and nobody with nothing to start', async () => {
  const people = [[/FROM users u/, [{ id: 'u-1', name: 'Ana', email: 'a@x', role: 'game_artist',
    isActive: 1, deactivatedAt: null, createdAt: '2026-01-02 04:00:00' }]]];

  const started = await startReminders.sweep(stubDb([
    ...people,
    [/DATE_FORMAT\(DATE_ADD\(w\.started_at/, [{ userId: 'u-1', day: WED }]],
    [/FROM assets a\s+WHERE/, [{ userId: 'u-1', n: 3 }]],
  ]), { now: ist(`${WED}T10:30:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(started.sent, 0);
  assert.strictEqual(started.reasons.started, 1,
    'A REMINDER SENT AFTER A USER STARTS IS A BUG — and it is checked at send time');

  /* NO TASKS, NO REMINDER — the decision the brief asked to be stated: a nudge
     to start work when there is nothing to start is a message whose only
     possible action is to ignore it. The banner says it on their own screen,
     where it costs nothing; a notice and an email do not. */
  const empty = await startReminders.sweep(stubDb([...people]), {
    now: ist(`${WED}T10:30:00`), settings: SETTINGS, schedule: SCHEDULE });
  assert.strictEqual(empty.sent, 0);
  assert.strictEqual(empty.reasons.no_tasks, 1);
  assert.match(SRC('start-reminders.js'), /NO TASKS, NO REMINDER/);
});

test('the sentences name the count, and the second says it is the second', () => {
  assert.strictEqual(
    startReminders.sentenceFor({ occasion: startReminders.FIRST, count: 4 }),
    'You haven’t started work today. You have 4 tasks waiting.');
  assert.strictEqual(
    startReminders.sentenceFor({ occasion: startReminders.FIRST, count: 1 }),
    'You haven’t started work today. You have 1 task waiting.');
  assert.match(
    startReminders.sentenceFor({ occasion: startReminders.SECOND, count: 2 }),
    /^Still not started: you have 2 tasks waiting\./);
});

test('the notice and the email go through the existing mechanisms, unchanged', () => {
  const src = SRC('start-reminders.js');
  /* ONE NOTIFICATION PATH: raise() is the choke point the bell, the desktop
     notice and the phone push all hang off, and the kind is the one the manual
     reminder already uses. */
  assert.match(src, /notifications\.raise\(db, \{/);
  assert.match(src, /kind: notifications\.KINDS\.start_reminder/);
  assert.ok(!/INSERT INTO notifications/.test(src), 'and the table is never written directly');
  /* NO ACTOR: raise() drops a recipient who is also the actor, so null is what
     lets a notice reach the person it is about — the same reasoning the
     work-hours sweep's own notices carry. */
  assert.match(src, /actorId: null,\s*\n\s*kind: notifications\.KINDS\.start_reminder/);

  /* ONE EMAIL QUEUE, so the retry policy and the permanent-failure behaviour
     are inherited rather than restated. */
  assert.match(src, /emailNotifications\.reminder\(db, \{/);
  assert.ok(!/BACKOFF|attempts|retry/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the sweep holds no retry policy of its own');
  const outbox = require('../src/email-outbox');
  assert.strictEqual(outbox.BACKOFF_SECONDS, require('../src/integration-outbox').BACKOFF_SECONDS);
  assert.strictEqual(outbox.MAX_ATTEMPTS, 7);
});

test('the sweep keeps the shape of the work-hours sweep beside it', () => {
  /* An immediate pass so a restarted process catches up at once, then an
     unref'd interval so a pending tick cannot keep a worker alive. The same
     shape scheduleAutoPause() uses, and for the same reasons. */
  const src = SRC('start-reminders.js');
  assert.match(src, /tick\(\);\n  if \(!Number\.isFinite\(minutes\) \|\| minutes <= 0\) return null;/);
  assert.match(src, /if \(timer\.unref\) timer\.unref\(\);/);
  assert.match(src, /START_REMINDER_SWEEP_MINUTES/);
  assert.match(SRC('work-log.js'), /if \(timer\.unref\) timer\.unref\(\);/);
  /* AND IT IS WIRED BESIDE IT. */
  assert.match(SRC('server.js'), /workLog\.scheduleAutoPause\(db\);[\s\S]{0,400}require\('\.\/start-reminders'\)\.schedule\(db\)/);
});

// ===========================================================================
// 3. THE SETTINGS. Validation, in arithmetic.
// ===========================================================================

test('MUTATION 14 — the second reminder must follow the first and sit inside hours', () => {
  const schedule = { openMinute: 570, closeMinute: 1140 };
  const ok = reminderSettings.validate({ secondReminderMinutes: '11:30' }, { schedule });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.secondReminderMinutes, 690);

  const early = reminderSettings.validate({ secondReminderMinutes: '10:00' }, { schedule });
  assert.strictEqual(early.ok, false);
  assert.match(early.errors[0].message, /must come after the first, which is 10:30/);
  assert.match(early.errors[0].message, /the grace period is 60 minutes/);

  const late = reminderSettings.validate({ secondReminderMinutes: '20:00' }, { schedule });
  assert.match(late.errors[0].message, /inside working hours, which end at 19:00/);

  /* AND THE FIRST MOVES WITH THE GRACE, so the two rules are one comparison
     each against numbers the studio set — never a time written down twice. */
  const wide = reminderSettings.validate(
    { graceMinutes: 180, secondReminderMinutes: '11:30' }, { schedule });
  assert.strictEqual(wide.ok, false);
  assert.match(wide.errors[0].message, /which is 12:30/);

  // HH:MM or minutes, both read; nonsense refused.
  assert.strictEqual(reminderSettings.validate({ secondReminderMinutes: 700 }, { schedule }).value
    .secondReminderMinutes, 700);
  assert.match(reminderSettings.validate({ secondReminderMinutes: 'noon' }, { schedule })
    .errors[0].message, /a time of day, as HH:MM/);
  assert.match(reminderSettings.validate({ secondReminderMinutes: '11:70' }, { schedule })
    .errors[0].message, /a time of day, as HH:MM/);

  /* A STUDIO WITH NO HOURS IS NOT REFUSED, or a Super Admin could not fix the
     schedule and the reminder in either order. */
  assert.strictEqual(reminderSettings.validate({ secondReminderMinutes: '20:00' },
    { schedule: null }).ok, true);
});

test('the ranges are the server\'s, and every mistake is reported', () => {
  const bad = reminderSettings.validate({ graceMinutes: 2, snoozeMinutes: 1, dailyCap: 0,
    streakThreshold: 1 }, { schedule: null });
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.errors.map((e) => e.field).sort(),
    ['dailyCap', 'graceMinutes', 'snoozeMinutes', 'streakThreshold'],
    'all four, not the first');
  assert.match(bad.errors.find((e) => e.field === 'graceMinutes').message,
    new RegExp(`between ${reminderSettings.GRACE_MIN} and ${reminderSettings.GRACE_MAX}`));
  assert.strictEqual(reminderSettings.validate({ graceMinutes: 999 }, { schedule: null }).ok, false);
});

test('the defaults are the ones stated, and the audit line says all of them', () => {
  const d = reminderSettings.DEFAULTS;
  assert.strictEqual(d.enabled, true);
  assert.strictEqual(d.bannerEnabled, true, 'the banner is on for an existing install');
  assert.strictEqual(d.indicatorEnabled, true, 'and the indicator');
  assert.strictEqual(d.inAppEnabled, true);
  assert.strictEqual(d.emailEnabled, false, 'and the email is off');
  assert.strictEqual(d.graceMinutes, 60);
  assert.strictEqual(d.secondReminderMinutes, 690);
  assert.strictEqual(reminderSettings.clock(690), '11:30');
  assert.strictEqual(d.snoozeMinutes, 30);

  const line = reminderSettings.summarise({ ...d });
  for (const part of ['nudges on', 'banner on', 'indicator on', 'in-app reminders on',
    'email reminders off', 'grace 60 minutes', 'second reminder 11:30', 'banner snooze 30 minutes']) {
    assert.ok(line.includes(part), `the audit line says "${part}"`);
  }
});

// ===========================================================================
// 4. THE PAGE. No native dialogs, no schedule arithmetic, no browser notices.
// ===========================================================================

test('MUTATION 15 — the page does its own schedule arithmetic nowhere', () => {
  const from = PAGE.indexOf('let DAY_STATE = null;');
  const to = PAGE.indexOf("/* ---------- login/session ---------- */");
  assert.ok(from !== -1 && to > from, 'the start-of-day block is in the page');
  const block = PAGE.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  /* EVERY ONE OF THESE WOULD BE A SECOND COPY of a rule that spans a weekly
     off, a holiday calendar, three break windows and a timezone. The page is
     told "paused, lunch, back at 14:00" and renders it. */
  for (const smell of ['getDay()', 'getHours()', 'holiday', 'lunch', 'loggableDays',
    '13:00', '09:30', 'graceMinutes >', 'isWorkingDay']) {
    assert.ok(!block.includes(smell), `the page does not carry "${smell}"`);
  }
  /* AND THE WORDS ARE THE SERVER'S. A label composed in this block would be a
     second description of the state — checked against THE BLOCK and not the
     whole page, because the page legitimately spells "outside working hours"
     elsewhere: it is the title of the work_paused notification, which the hours
     sweep raises and which has nothing to do with this indicator. An earlier
     draft asserted it over the whole file and failed on exactly that. */
  for (const invented of ['Outside working hours', 'Paused – lunch', 'Paused - lunch',
    'The studio is closed', 'is on a break']) {
    assert.ok(!block.includes(invented), `this block never spells "${invented}" itself`);
  }
  assert.match(block, /d\.label \|\| 'No timer running'/);
  assert.match(block, /el\.title = d\.reason \|\|/);
});

test('MUTATION 16 — no native dialog, and no browser Notification API', () => {
  const from = PAGE.indexOf('let DAY_STATE = null;');
  const to = PAGE.indexOf("/* ---------- login/session ---------- */");
  const block = PAGE.slice(from, to);
  for (const native of ['confirm(', 'alert(', 'prompt(']) {
    assert.ok(!block.includes(native), `${native} must not appear in this block`);
  }
  /* THE DESKTOP SHELL'S WEB VIEW DOES NOT SUPPORT THEM, and the whole page is
     pinned elsewhere — tests/no-native-dialogs.test.js fails the build if one
     reappears anywhere, which is the latch that does not depend on this file. */
  assert.ok(fs.existsSync(path.join(__dirname, 'no-native-dialogs.test.js')));
  /* AND NOTHING RELIES ON new Notification(): in-app and email are the
     channels, because the API may not work in the application at all. */
  assert.ok(!/new Notification\(/.test(block));
  assert.ok(!/Notification\.requestPermission/.test(block));
});

test('the banner and the indicator are keyboard-reachable and say their state in words', () => {
  /* A <button>, which gets Enter, Space, the tab order and a focus ring for
     free — and an aria-label that carries the state, because the colour is not
     the message. */
  assert.match(PAGE, /<button class="tmr" id="timerPill" hidden aria-live="polite"><\/button>/);
  assert.match(PAGE, /el\.setAttribute\('aria-label', `Timer running on/);
  assert.match(PAGE, /\.tmr:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  assert.match(PAGE, /\.db-close:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  assert.match(PAGE, /\.db-all:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  /* THE WORDS ARE DRAWN BESIDE THE COLOUR for every state, which is the
     accessibility requirement rather than a preference. */
  assert.match(PAGE, /<span class="tmr-what">\$\{escapeHTML\(d\.label \|\| 'No timer running'\)\}<\/span>/);
  /* AND THE FOUR TOKENS EXIST, so a Super Admin can restyle them. */
  const theme = require('../src/theme-tokens');
  for (const key of ['indicator.running', 'indicator.idle', 'indicator.paused', 'indicator.held']) {
    const tok = theme.TOKENS.find((t) => t.key === key);
    assert.ok(tok, `${key} is in the catalogue`);
    assert.match(PAGE, new RegExp(`var\\(--${tok.css}\\)`), `and the page reads --${tok.css}`);
  }
});

test('the banner never shoves the page down after it has settled', () => {
  /* The container is ALWAYS in the document and empty when there is nothing to
     say, and the state arrives with the boot payload — so the first paint either
     contains a banner or does not. A slot created on demand would appear a
     moment after the page settled and move everything below it. */
  assert.match(PAGE, /<div id="dayBannerSlot"><\/div>/);
  const bootAt = PAGE.indexOf('applyDayState(dayState);\n      booting = false;');
  assert.ok(bootAt > 0, 'the state is applied before the frame is drawn');
  assert.match(PAGE, /BEFORE THE FRAME IS DRAWN/);
});

test('MUTATION 17 — the banner\'s Start is the ordinary route and nothing else', () => {
  const from = PAGE.indexOf('async function startFromBanner');
  const to = PAGE.indexOf("/* ---------- login/session ---------- */");
  const fn = PAGE.slice(from, to);
  assert.match(fn, /await api\(`\/assets\/\$\{encodeURIComponent\(assetId\)\}\/start`, \{ method:'POST' \}\)/);
  /* NO SECOND ENDPOINT AND NO FLAG. A banner that could start work by another
     door would be a door past seven gates: the outsource check, mayStartWork,
     STARTABLE, the awaiting-handover stages, the start date, the holiday, the
     previous-day timesheet rule and the one-active-task rule. */
  assert.ok(!/banner|nudge|force|skip/i.test(fn.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/startFromBanner|DAY_BANNER_[A-Z]+|paintDayBanner/g, '')),
  'nothing is passed that the board does not pass');
  const route = SRC('routes/assets.js');
  /* THE START ROUTE'S OWN BODY, to the next route definition after it — the
     submit route is ABOVE it in the file, so slicing to that gave an empty
     string and every gate "passed" by being absent from nothing. */
  const routeFrom = route.indexOf("router.post('/:id/start'");
  const routeTo = route.indexOf("router.get('/:id/hold-explain'", routeFrom);
  assert.ok(routeFrom > 0 && routeTo > routeFrom, 'the start route is where it was');
  const start = route.slice(routeFrom, routeTo);
  for (const gate of ['oversightOutsource.activeForAsset', 'mayStartWork(req, asset)',
    'STARTABLE.includes(asset.status)', 'AWAITING_HANDOVER[asset.status]',
    'assetSchedule.startsInFuture(asset)', "holidayRefusal('started')", 'timesheetRefusal(req)']) {
    assert.ok(start.includes(gate), `${gate} is still on the one start route`);
  }
  /* AND THE REFUSAL IS SHOWN ON THE BANNER, not as a toast that is gone before
     anybody reads it. */
  assert.match(fn, /DAY_BANNER_ERR = \(err && err\.message\)/);
});

test('MUTATION 18 — the dismissal is per user, per day, in the browser, and never permanent', () => {
  assert.match(PAGE, /const daySnoozeKey = \(d\) => `zvky_day_snooze_\$\{\(state\.currentUser && state\.currentUser\.id\) \|\| '\?'\}_\$\{\(d && d\.today\) \|\| '\?'\}`/);
  /* THE KEY CARRIES THE SERVER'S IST DATE, so it expires twice over: when the
     snooze runs out, and when the date changes. */
  assert.match(PAGE, /localStorage\.setItem\(daySnoozeKey\(d\), String\(Date\.now\(\) \+ minutes\*60000\)\)/);
  /* THE SNOOZE RETURNS EARLY AND THE LEAVE MARK SURVIVES IT. The guard used to
     read `return ''`; it now returns markBanner, because a dismissal is about
     the start-of-day PROMPT and a leave mark is a statement of fact on
     somebody's own screen — snoozing a fact is not a thing. Repinned to the
     guard itself rather than to the word that followed it. */
  assert.match(PAGE, /if\(Date\.now\(\) < daySnoozedUntil\(d\)\) return markBanner;/);
  assert.match(PAGE, /if\(!d\.banner \|\| !d\.banner\.show\) return markBanner;/);
  /* AN UNREADABLE VALUE READS AS "NOT DISMISSED", which is the safe direction —
     the worst case is a banner somebody dismisses again. */
  assert.match(PAGE, /return Number\.isFinite\(at\) \? at : 0;/);
  /* AND NOT ON THE SERVER. A dismissal is a fact about this browser in this
     hour, and on the server it would also follow somebody to their phone. */
  assert.ok(!/snooze/i.test(SRC('day-state.js').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/snoozeMinutes/g, '')), 'the server stores no dismissal');
  assert.ok(!/snooze/i.test(SRC('routes/auth.js')));
});

// ===========================================================================
// 5. END TO END.
//
// The schedule is set through the application's own Recording Hours so the
// server's clock is the fixture's clock — openStudio() does exactly that — and
// every case that depends on the hour drives the sweep with an explicit `now`.
// The one thing a live test cannot choose is what time it is when /auth/me is
// called, so the cases that read the endpoint assert on the SHAPE and on the
// facts that do not depend on the hour, and the hour-dependent states are
// decided in arithmetic above, where the clock is an argument.
// ===========================================================================

test('the banner, the reminders and the indicator, end to end',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let server;
    let root;
    const token = {};
    const id = {};
    const as = (who, p, opts = {}) => api(server.base, p, { token: token[who], ...opts });

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, {
        BOOTSTRAP_TOKEN: 'sd-token',
        WORK_HOURS_SWEEP_MINUTES: '0',
        /* THE SWEEP IS OFF IN THE SERVER, so every reminder below is one this
           test drove with an explicit `now` rather than one a timer happened to
           fire. A background pass would make the row counts a race. */
        START_REMINDER_SWEEP_MINUTES: '0',
        EMAIL_SWEEP_MS: '0',
        EMAIL_BATCH_MS: '0',
      });
      await api(server.base, '/auth/bootstrap', { method: 'POST',
        body: { token: 'sd-token', name: 'Root', email: 'root@sd.test', password: PASSWORD } });
      const login = async (email) => (await api(server.base, '/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@sd.test');
      root = token.root;
      await openStudio(server.base, root);

      const make = async (key, name, email, role) => {
        const r = await as('root', '/users', { method: 'POST',
          body: { name, email, password: PASSWORD, role } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        id[key] = r.body.user.id;
        token[key] = await login(email);
      };
      await make('ana', 'Ana Artist', 'ana@sd.test', 'game_artist');
      await make('bo', 'Bo Artist', 'bo@sd.test', 'game_artist');
      await make('idle', 'Ida Artist', 'ida@sd.test', 'game_artist');
      await make('lead', 'Lee Lead', 'lee@sd.test', 'team_lead');
      /* BACK-DATED, because "created today" is not expected — which is a rule
         this fixture would otherwise trip over for every single account. */
      await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@sd.test'");

      const client = await systemClientId(server.base, root);
      id.project = (await as('root', '/projects', { method: 'POST',
        body: { name: 'Alpha', clientId: client } })).body.project.id;
      for (const key of ['ana', 'bo', 'idle', 'lead']) {
        await as('root', `/users/${id[key]}`, { method: 'PATCH', body: { projectId: id.project } });
      }

      const asset = async (key, who, over = {}) => {
        const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
          body: { name: over.name || key, type: 'character', assigneeId: id[who], due: over.due || null } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        id[key] = r.body.asset.id;
        return r.body.asset.id;
      };
      /* Ana has two waiting, Bo has one, Ida has none. */
      await asset('a_one', 'ana', { name: 'Hero', due: '2026-03-10' });
      await asset('a_two', 'ana', { name: 'Crate' });
      await asset('b_one', 'bo', { name: 'Door' });
    });

    t.after(() => stopServer(server));

    const me = (who) => as(who, '/auth/me');

    await t.test('/auth/me carries the state, with the gate handed to it once', async () => {
      const r = await me('ana');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const d = r.body.dayState;
      assert.ok(d, 'the field is there');
      assert.strictEqual(d.on, true);
      assert.strictEqual(d.expected, true, 'a Game Artist on the books since January');
      assert.strictEqual(d.assignedCount, 2, 'the two waiting on her');
      assert.strictEqual(d.tasks.length, 2);
      assert.strictEqual(d.tasks[0].name, 'Hero', 'overdue first');
      assert.strictEqual(d.tasks[0].overdue, true);
      assert.strictEqual(d.running, null);
      assert.strictEqual(d.startedToday, false);
      assert.ok(['idle', 'paused', 'off_hours', 'closed_day'].includes(d.state), d.state);
      assert.ok(d.today && /^\d{4}-\d{2}-\d{2}$/.test(d.today));
      assert.ok(d.serverNow);
      /* THE SAME NUMBER THE FOLLOW-UP SECTION WOULD PRINT FOR HER, which is what
         sharing the predicate buys. */
      const section = await as('root', '/admin-dashboard/follow-up');
      const row = [...section.body.notStarted.rows, ...(section.body.notFilled.rows || [])]
        .find((x) => x.id === id.ana);
      if (row) assert.strictEqual(row.held, d.assignedCount, 'the banner and the row agree');
    });

    await t.test('somebody with nothing assigned gets the other variant', async () => {
      const d = (await me('idle')).body.dayState;
      assert.strictEqual(d.assignedCount, 0);
      assert.deepStrictEqual(d.tasks, []);
      assert.ok(d.banner.variant === 'none' || d.banner.show === false,
        'no tasks means no Start, whatever the hour');
    });

    await t.test('somebody the studio does not give work to is not expected', async () => {
      /* A TEAM LEAD WOULD NOT DO, and the first draft of this case used one: in
         this studio team_lead IS in assignableRoles() — leads take work as well
         as review it — so Lee is expected and sees a banner like anybody else.
         The non-expected side of the rule is an administrator, who holds no
         assignable designation and clocks no time against an asset. */
      const { assignableRoles } = require('../src/roles');
      assert.ok(assignableRoles().includes('team_lead'),
        'a lead is given work in this studio, which is why they ARE expected');
      assert.ok(!assignableRoles().includes('super_admin'));

      const lead = (await me('lead')).body.dayState;
      assert.strictEqual(lead.expected, true, 'so Lee is expected');

      const root_ = (await me('root')).body.dayState;
      assert.strictEqual(root_.expected, false);
      assert.strictEqual(root_.banner.show, false);
      assert.strictEqual(root_.banner.why, 'not expected to be working today');
      assert.strictEqual(root_.indicator.show, false, 'and no timer state to show them');
    });

    await t.test('starting a task turns the indicator to running, through the ordinary route', async () => {
      const start = await as('ana', `/assets/${id.a_one}/start`, { method: 'POST' });
      assert.strictEqual(start.status, 200, JSON.stringify(start.body));

      const d = (await me('ana')).body.dayState;
      assert.strictEqual(d.state, 'running');
      assert.strictEqual(d.running.assetId, id.a_one);
      assert.strictEqual(d.running.name, 'Hero');
      assert.strictEqual(d.running.projectId, id.project);
      assert.ok(d.running.ageSeconds >= 0);
      assert.ok(d.running.startedAt, 'and the start instant, recovered from the age');
      assert.strictEqual(d.startedToday, true);
      assert.strictEqual(d.banner.show, false);
      assert.strictEqual(d.banner.why, 'a timer is running');
      /* ONE QUERY'S WORTH OF STATE: the count is not computed while a timer
         runs, because the banner is not drawn. */
      assert.strictEqual(d.assignedCount, null);
    });

    await t.test('putting it on hold shows the held state, with its own words', async () => {
      const hold = await as('ana', `/assets/${id.a_one}/hold`, { method: 'POST', body: {} });
      assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));
      const d = (await me('ana')).body.dayState;
      assert.strictEqual(d.state, 'held');
      assert.strictEqual(d.label, 'On hold');
      assert.strictEqual(d.held.assetId, id.a_one);
      assert.strictEqual(d.held.byStudio, false);
      assert.match(d.reason, /You put this task down/);
      /* AND THE BANNER STAYS AWAY, because she has started today — a held round
         is work begun. */
      assert.strictEqual(d.startedToday, true);
      assert.strictEqual(d.banner.show, false);
    });

    await t.test('MUTATION 19 (live) — the blocked reason comes back with the state', async () => {
      /* The previous-day timesheet rule, switched on, which is what the banner's
         "blocked" variant is about. Bo has not filled anything. */
      await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: { requirePreviousDay: true } });
      const d = (await me('bo')).body.dayState;
      if (d.blocked) {
        assert.strictEqual(d.blocked.blocked, true);
        assert.ok(d.blocked.dateLabel, 'and it names the day that is owed');
        assert.match(d.blocked.message, /Fill your timesheet for/);
        /* AND THE ORDINARY ROUTE REFUSES THE START, which is the point: the
           banner's variant is a courtesy and the gate is the rule. */
        const refused = await as('bo', `/assets/${id.b_one}/start`, { method: 'POST' });
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
        assert.match(refused.body.error, /Fill your timesheet/);
        if (d.banner.show) assert.strictEqual(d.banner.variant, 'blocked');
      }
      await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: { requirePreviousDay: false } });
    });

    await t.test('MUTATION 20 — the sweep sends each occasion once, however often it runs', async () => {
      await sql(cfg, 'DELETE FROM reminder_log');
      await sql(cfg, "DELETE FROM notifications WHERE kind = 'start_reminder'");
      const dayStateModule = require('../src/day-state');
      assert.ok(dayStateModule, 'loaded');

      /* DRIVEN IN THIS PROCESS, against the same database, with an explicit
         `now` — so the hour is the fixture's and not the container's. */
      const db = dbFor();
      const settings = { ...reminderSettings.DEFAULTS };
      const run = (now) => startReminders.sweep(db, { now, settings, schedule: LIVE_SCHEDULE });

      /* Bo has one task and has started nothing; Ana has started, so she is not
         reminded. Ida has no tasks. */
      const first = await run(atMinute('10:30'));
      assert.strictEqual(first.sent, 1, JSON.stringify(first));
      assert.deepStrictEqual(first.due, [startReminders.FIRST]);

      /* AND AGAIN, TWICE, AT THE SAME MINUTE AND THE NEXT. The sweep runs every
         minute in life; "exactly once" has to hold against that and it is the
         unique key that makes it, not a memory of having run. */
      assert.strictEqual((await run(atMinute('10:30'))).sent, 0);
      assert.strictEqual((await run(atMinute('10:45'))).sent, 0);
      assert.strictEqual((await run(atMinute('11:29'))).sent, 0);

      const rows = await sql(cfg, "SELECT * FROM reminder_log WHERE source = 'auto' ORDER BY slot");
      assert.strictEqual(rows.length, 1, 'one row, four passes');
      assert.strictEqual(rows[0].recipient_id, id.bo);
      assert.strictEqual(rows[0].kind, 'start');
      assert.strictEqual(rows[0].slot, 0, 'the first occasion is slot 0');
      assert.strictEqual(rows[0].sender_id, null, 'the studio did this, not a person');
      assert.strictEqual(rows[0].channels, 'in_app', 'email is off by default');
      assert.strictEqual(rows[0].result, 'sent');

      /* THE NOTICE IS IN BO'S BELL, with the sentence stored on it. */
      const bell = await as('bo', '/notifications');
      const notice = bell.body.notifications.find((n) => n.kind === 'start_reminder');
      assert.ok(notice, 'the reminder reached the bell');
      assert.match(notice.message, /You haven’t started work today\. You have 1 task waiting\./);

      /* THE SECOND OCCASION IS A SECOND SLOT, and it goes at its own time. */
      const second = await run(atMinute('11:30'));
      assert.strictEqual(second.sent, 1, JSON.stringify(second));
      assert.deepStrictEqual(second.due, [startReminders.SECOND]);
      assert.strictEqual((await run(atMinute('11:31'))).sent, 0, 'and once only');
      const both = await sql(cfg, "SELECT slot FROM reminder_log WHERE source = 'auto' ORDER BY slot");
      assert.deepStrictEqual(both.map((r) => Number(r.slot)), [0, 1]);
    });

    await t.test('MUTATION 21 — a late pass sends a missed occasion, but never the first after the second\'s time', async () => {
      await sql(cfg, 'DELETE FROM reminder_log');
      const db = dbFor();
      const settings = { ...reminderSettings.DEFAULTS };
      const run = (now) => startReminders.sweep(db, { now, settings, schedule: LIVE_SCHEDULE });

      /* THE SERVER WAS DOWN AT 10:30 and comes back at 10:55. The same code path
         sends it, because every pass asks the same question — which is why there
         is no scheduler and nothing stored about when the sweep last ran. */
      const late = await run(atMinute('10:55'));
      assert.strictEqual(late.sent, 1, JSON.stringify(late));
      assert.deepStrictEqual(late.due, [startReminders.FIRST]);

      /* AND A SERVER THAT CAME BACK AT TWO O'CLOCK owes only the second: the
         first's window closed when the second's opened. A mutant that left the
         first window open to the end of the day sends a start-of-day nudge at
         half past two. */
      await sql(cfg, 'DELETE FROM reminder_log');
      const afternoon = await run(atMinute('14:00'));
      assert.deepStrictEqual(afternoon.due, [startReminders.SECOND]);
      const rows = await sql(cfg, "SELECT slot FROM reminder_log WHERE source = 'auto'");
      assert.deepStrictEqual(rows.map((r) => Number(r.slot)), [1],
        'only the second, and in its own slot');

      /* AND AFTER THE STUDIO SHUTS, NEITHER. */
      await sql(cfg, 'DELETE FROM reminder_log');
      assert.strictEqual((await run(atMinute('19:30'))).sent, 0);
      assert.strictEqual((await sql(cfg, 'SELECT * FROM reminder_log')).length, 0);
    });

    await t.test('MUTATION 22 — two passes at the same instant send one reminder', async () => {
      await sql(cfg, 'DELETE FROM reminder_log');
      await sql(cfg, "DELETE FROM notifications WHERE kind = 'start_reminder'");
      const settings = { ...reminderSettings.DEFAULTS };
      /* TWO CONNECTIONS, FIRED TOGETHER — two workers, which is what a studio
         running more than one process has. Both read "nothing sent" and both try
         to claim slot 0; the key decides.
         
         THIS IS THE TEST A READ-THEN-WRITE CANNOT PASS. Removing the unique key
         from the migration leaves every other case in this file green. */
      const [a, b] = await Promise.all([
        startReminders.sweep(dbFor(), { now: atMinute('10:30'), settings, schedule: LIVE_SCHEDULE }),
        startReminders.sweep(dbFor(), { now: atMinute('10:30'), settings, schedule: LIVE_SCHEDULE }),
      ]);
      assert.strictEqual(a.sent + b.sent, 1, `one between them (${a.sent} and ${b.sent})`);
      const rows = await sql(cfg, "SELECT * FROM reminder_log WHERE source = 'auto'");
      assert.strictEqual(rows.length, 1, 'one row');
      const notices = await sql(cfg,
        "SELECT * FROM notifications WHERE kind = 'start_reminder' AND recipient_id = ?", [id.bo]);
      assert.strictEqual(notices.length, 1, 'and one notice');
    });

    await t.test('MUTATION 23 — a reminder is never sent to somebody who has started', async () => {
      await sql(cfg, 'DELETE FROM reminder_log');
      const db = dbFor();
      const settings = { ...reminderSettings.DEFAULTS };
      /* Bo starts, and then the sweep runs. The check is at SEND time, not at
         the time the occasion came due — which is the difference between a
         correct reminder and the bug the brief names. */
      const start = await as('bo', `/assets/${id.b_one}/start`, { method: 'POST' });
      assert.strictEqual(start.status, 200, JSON.stringify(start.body));
      const out = await startReminders.sweep(db, {
        now: atMinute('10:30'), settings, schedule: LIVE_SCHEDULE });
      assert.strictEqual(out.sent, 0, JSON.stringify(out));
      assert.strictEqual((await sql(cfg, 'SELECT * FROM reminder_log')).length, 0);
      await as('bo', `/assets/${id.b_one}/hold`, { method: 'POST', body: {} });
    });

    await t.test('the email goes through the existing queue when it is switched on', async () => {
      await sql(cfg, 'DELETE FROM reminder_log');
      await sql(cfg, 'DELETE FROM email_outbox');
      await as('root', '/email-config', { method: 'PUT', body: {
        enabled: true, host: '127.0.0.1', port: 2599, encryption: 'none',
        fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvky.test' } });

      const db = dbFor();
      /* THE MAIL CONFIG IS A PER-PROCESS MIRROR, and the sweep is being driven
         in THIS process rather than in the server's — so it has to be loaded
         here or emailConfig.isUsable() answers false and the email half is
         skipped for a reason that has nothing to do with the case. That is
         exactly how the first draft of this case failed. */
      await require('../src/email-config').load(db);
      /* Bo has started today now, so the one left to remind is Ana — whose own
         held round means she has started too. Ida has no tasks. So a third
         artist is given a task for this case. */
      const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
        body: { name: 'Mail Me', type: 'character', assigneeId: id.idle } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));

      const out = await startReminders.sweep(db, { now: atMinute('10:30'),
        settings: { ...reminderSettings.DEFAULTS, emailEnabled: true }, schedule: LIVE_SCHEDULE });
      assert.strictEqual(out.sent, 1, JSON.stringify(out));
      const row = (await sql(cfg, "SELECT * FROM reminder_log WHERE source = 'auto'"))[0];
      assert.strictEqual(row.recipient_id, id.idle);
      assert.strictEqual(row.channels, 'in_app,email');

      /* ON THE STUDIO'S EXISTING OUTBOX, with the counters its retry policy
         reads. The sweep holds no retry policy of its own. */
      const queued = await sql(cfg, 'SELECT * FROM email_outbox');
      assert.strictEqual(queued.length, 1);
      assert.strictEqual(queued[0].recipient, 'ida@sd.test');
      assert.strictEqual(queued[0].status, 'pending');
      assert.strictEqual(Number(queued[0].attempts), 0);
      assert.match(queued[0].body_text, /You haven’t started work today/);

      /* AND WITH IT OFF, NOTHING IS QUEUED. */
      await sql(cfg, 'DELETE FROM reminder_log');
      await sql(cfg, 'DELETE FROM email_outbox');
      const quiet = await startReminders.sweep(dbFor(), { now: atMinute('10:30'),
        settings: { ...reminderSettings.DEFAULTS, emailEnabled: false }, schedule: LIVE_SCHEDULE });
      assert.strictEqual(quiet.sent, 1);
      assert.strictEqual((await sql(cfg, 'SELECT * FROM email_outbox')).length, 0);
    });

    await t.test('MUTATION 24 — the settings screen demands its own key, and a grant lands on the same token', async () => {
      const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: held.filter((k) => k !== 'settings.nudges') } });
      for (const [method, body] of [['GET', undefined], ['PUT', { graceMinutes: 60 }]]) {
        const res = await as('lead', '/admin/settings/nudges',
          method === 'GET' ? {} : { method, body });
        assert.strictEqual(res.status, 403, `${method} is refused without the key`);
      }

      await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: [...new Set([...held, 'settings.nudges'])] } });
      /* THE SAME TOKEN, NO SIGN-OUT: authenticate() resolves permissions per
         request. */
      assert.strictEqual((await as('lead', '/admin/settings/nudges')).status, 200);
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
    });

    await t.test('the settings are validated, audited, and apply without a redeploy', async () => {
      const bad = await as('root', '/admin/settings/nudges', { method: 'PUT',
        body: { graceMinutes: 2, snoozeMinutes: 1 } });
      assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
      const fields = bad.body.errors.map((e) => e.field).sort();
      assert.deepStrictEqual(fields, ['graceMinutes', 'snoozeMinutes'],
        'both, not the first');

      /* THE ORDERING RULE, AGAINST THIS STUDIO'S OWN HOURS. openStudio() opens
         the clock all day, every day — so the first reminder is 00:00 plus the
         grace, and 00:30 is before it. Written relative to the studio's window
         rather than to a clock time, because a case that said "09:00 is too
         early" would be asserting about a 09:30 opening this fixture does not
         have; the arithmetic cases above pin the rule against one that does. */
      const early = await as('root', '/admin/settings/nudges', { method: 'PUT',
        body: { graceMinutes: 60, secondReminderMinutes: '00:30' } });
      assert.strictEqual(early.status, 422, JSON.stringify(early.body));
      assert.match(early.body.errors[0].message, /must come after the first/);

      const ok = await as('root', '/admin/settings/nudges', { method: 'PUT',
        body: { enabled: true, bannerEnabled: true, indicatorEnabled: true, inAppEnabled: true,
          emailEnabled: false, graceMinutes: 90, secondReminderMinutes: '12:15',
          snoozeMinutes: 45, manualEnabled: true, dailyCap: 1, streakThreshold: 3 } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.settings.graceMinutes, 90);
      assert.strictEqual(ok.body.settings.secondReminderMinutes, 735);
      assert.strictEqual(ok.body.secondReminderLabel, '12:15');
      /* THE FIRST IS THE OPENING PLUS THE NEW GRACE, whatever the opening is —
         this studio's clock is open from midnight, so ninety minutes after it
         is 01:30. The number is the studio's, not a constant. */
      assert.strictEqual(ok.body.occasions.opensAt, '00:00');
      assert.strictEqual(ok.body.occasions.first, '01:30', 'the opening plus the new grace');
      assert.strictEqual(ok.body.occasions.second, '12:15');
      assert.strictEqual(ok.body.automatic, true, 'the sweep exists now');

      /* WITHOUT A REDEPLOY: the next request on the SAME process reads the new
         values, because save() reloaded the mirror every reader reads. */
      const after = (await me('ana')).body.dayState;
      assert.strictEqual(after.banner.graceMinutes, 90);
      assert.strictEqual(after.settings.snoozeMinutes, 45);
      /* AND THE FOLLOW-UP SECTION MOVES WITH IT — one grace period, one place. */
      const section = await as('root', '/admin-dashboard/follow-up');
      assert.strictEqual(section.body.grace.minutes, 90);

      const audit = await as('root', '/activity?module=settings');
      const entry = audit.body.entries.find((e) => e.action === 'nudges_updated');
      assert.ok(entry, 'the save is in the Activity Log');
      assert.match(entry.summary, /grace 60 minutes → grace 90 minutes/);
      assert.match(entry.summary, /second reminder 11:30 → second reminder 12:15/);
      assert.ok(entry.summary.length < 500,
        'and it fits activity_log.summary, which the full eleven-clause policy does not');

      /* THE MASTER SWITCH REACHES THE STATE ON THE NEXT REQUEST TOO. */
      await as('root', '/admin/settings/nudges', { method: 'PUT', body: { enabled: false } });
      const off = (await me('ana')).body.dayState;
      assert.strictEqual(off.on, false);
      assert.strictEqual(off.state, 'off');
      assert.strictEqual(off.indicator.show, false);
      await as('root', '/admin/settings/nudges', { method: 'PUT',
        body: { enabled: true, graceMinutes: 60, secondReminderMinutes: '11:30', snoozeMinutes: 30 } });
    });

    /* TODAY, AT A CHOSEN WALL CLOCK. The date is the studio's real one — which
       is what makes "did they start today" and reminder_log.sent_on line up with
       the sessions this test creates — and the minute is the fixture's, which is
       what makes every window assertion deterministic. */
    function atMinute(hhmm){
      const today = require('../src/timesheet-gate').istDate(Date.now());
      return Date.parse(`${today}T${hhmm}:00+05:30`);
    }

    /* A DATABASE HANDLE OVER sql(), so this file never requires src/db.js — a
       pool built at require time outlives the test and has hung this suite
       before. The $n placeholders are translated the way src/db.js does, by
       order of appearance. */
    function dbFor() {
      return {
        async query(text, params = []) {
          const flat = [];
          const sqlText = String(text).replace(/\$(\d+)/g, (_, n) => {
            const value = params[Number(n) - 1];
            if (Array.isArray(value)) { flat.push(...value); return value.map(() => '?').join(','); }
            flat.push(value);
            return '?';
          });
          const rows = await sql(cfg, sqlText, flat);
          return { rows: Array.isArray(rows) ? rows : [], result: rows };
        },
      };
    }
  });
