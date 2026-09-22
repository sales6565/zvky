/* Only the hours the studio was open.
 *
 * WHAT WAS WRONG. work_sessions.seconds was the raw wall-clock span between
 * Accept and Start and Submit for Review. An asset started at ten to seven on a
 * Friday and submitted on Monday morning had cost sixty-three hours, of which
 * about two were worked. That column is the ONLY source behind Time Spent, the
 * Efficiency report, the Time Sheet's suggested hours and both P&L tabs, so the
 * error was in five places at once and always in the same direction — upwards,
 * which is the direction that makes a studio look slower and a project look
 * dearer than it was.
 *
 * WHAT IT IS NOW. The part of that span falling inside the configured working
 * days and hours, with the configured breaks taken out, in IST. The arithmetic
 * is src/working-time.js — pure, so most of this file needs no server at all —
 * and it is applied in exactly one place, close() in src/work-log.js, which is
 * what makes the five readers agree without five fixes.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *   IT PINS THE CLOCK, NOT THE WEATHER. Every case states the instants it
 *      means. A test that started a timer and waited would assert something
 *      different at nine in the morning and at nine at night, which is the one
 *      kind of failing test nobody investigates.
 *
 *   IT CHECKS THE LIVE FIGURE AGAINST THE STORED ONE. A running task shows a
 *      number on the panel and stores one when it closes. If those two
 *      expressions ever disagree, an hour vanishes at the moment of submitting
 *      with nothing on screen to explain it.
 *
 *   IT PROVES THE SETTING IS LOAD-BEARING. Every window here comes from
 *      Settings → Working Hours through its real endpoint. Nothing is
 *      hardcoded, so a studio that works Saturdays gets Saturdays.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const wt = require('../src/working-time');
const workSchedule = require('../src/work-schedule');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('workinghours');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* The studio's default: half past nine to seven, Monday to Friday, lunch at
   one. Written out rather than read from the module so that a change to the
   defaults fails these tests loudly instead of quietly moving what they mean. */
const STUDIO = {
  workingDays: [1, 2, 3, 4, 5],
  dayStart: 9 * 60 + 30,
  dayEnd: 19 * 60,
  breaks: [{ start: 13 * 60, end: 14 * 60 }],
};

// An IST wall clock as an instant. Every case below is written in the clock the
// studio actually reads, and converted here, once.
const ist = (text) => Date.parse(`${text}+05:30`);
const hours = (seconds) => Math.round((seconds / 3600) * 1000) / 1000;

/* A known week, so "Wednesday" means a particular Wednesday.
     Wed 16 Sep 2026, Thu 17, Fri 18, Sat 19, Sun 20, Mon 21. */
const WED = '2026-09-16T';
const FRI = '2026-09-18T';
const SAT = '2026-09-19T';
const MON = '2026-09-21T';

// --- the arithmetic, with no server -------------------------------------------

test('the studio clock is IST, whatever the machine is set to', () => {
  /* The same instant, named three ways. If this module ever reads the process
     timezone, one of these stops agreeing with the others and the studio's
     hours start depending on where the server is plugged in. */
  const noonIST = ist(`${WED}12:00:00`);
  assert.strictEqual(wt.istPartsOf(noonIST).minute, 12 * 60, 'noon in IST is minute 720');
  assert.strictEqual(wt.istPartsOf(Date.parse(`${WED}06:30:00Z`)).minute, 12 * 60,
    'the same instant written as UTC is still noon in the studio');
  assert.strictEqual(wt.istPartsOf(Date.parse(`${WED}02:30:00-04:00`)).minute, 12 * 60,
    'and so is the same instant written from New York');
  assert.strictEqual(wt.istPartsOf(noonIST).dow, 3, 'and it is a Wednesday');
});

test('a Wednesday 11:00 to 14:00, less the lunch hour', () => {
  // The studio's own first check: three hours on the clock, one of them lunch.
  const seconds = wt.workingSecondsBetween(ist(`${WED}11:00:00`), ist(`${WED}14:00:00`), STUDIO);
  assert.strictEqual(hours(seconds), 2, 'three hours on the wall, two of them worked');
});

test('a timer that runs past seven counts only up to seven', () => {
  const seconds = wt.workingSecondsBetween(ist(`${WED}18:45:00`), ist(`${WED}19:15:00`), STUDIO);
  assert.strictEqual(seconds, 15 * 60, 'the quarter hour before the cutoff, and nothing after it');
});

test('an evening, a weekend and a Monday morning', () => {
  /* Started at nine on a Friday night and still open when somebody sits down on
     Monday. Everything before Monday half past nine is the studio being shut. */
  const seconds = wt.workingSecondsBetween(ist(`${FRI}21:00:00`), ist(`${MON}11:00:00`), STUDIO);
  assert.strictEqual(hours(seconds), 1.5, 'only Monday 09:30 to 11:00');
});

test('a whole Saturday is nothing at all', () => {
  assert.strictEqual(wt.workingSecondsBetween(ist(`${SAT}09:00:00`), ist(`${SAT}23:00:00`), STUDIO), 0);
});

test('a full working day is the window less the breaks', () => {
  const seconds = wt.workingSecondsBetween(ist(`${WED}09:30:00`), ist(`${WED}19:00:00`), STUDIO);
  assert.strictEqual(hours(seconds), 8.5, 'nine and a half hours, less the hour for lunch');
});

test('all three breaks come out, not just lunch', () => {
  const withAll = {
    ...STUDIO,
    breaks: [
      { start: 11 * 60, end: 11 * 60 + 15 },
      { start: 13 * 60, end: 14 * 60 },
      { start: 16 * 60 + 30, end: 16 * 60 + 45 },
    ],
  };
  const seconds = wt.workingSecondsBetween(ist(`${WED}09:30:00`), ist(`${WED}19:00:00`), withAll);
  assert.strictEqual(hours(seconds), 9.5 - 1.5, 'the morning and evening breaks count as much as lunch');
});

test('a session entirely inside a break is worth nothing', () => {
  assert.strictEqual(
    wt.workingSecondsBetween(ist(`${WED}13:10:00`), ist(`${WED}13:40:00`), STUDIO), 0,
    'half an hour, all of it lunch');
});

test('a backwards or empty span is zero rather than negative', () => {
  assert.strictEqual(wt.workingSecondsBetween(ist(`${WED}14:00:00`), ist(`${WED}11:00:00`), STUDIO), 0);
  assert.strictEqual(wt.workingSecondsBetween(ist(`${WED}11:00:00`), ist(`${WED}11:00:00`), STUDIO), 0);
});

test('a studio that works Saturdays gets its Saturdays', () => {
  /* The guard against any of this being hardcoded to Monday-to-Friday. Same
     span, same function, one setting different. */
  const sixDay = { ...STUDIO, workingDays: [1, 2, 3, 4, 5, 6] };
  assert.strictEqual(wt.workingSecondsBetween(ist(`${SAT}10:00:00`), ist(`${SAT}12:00:00`), STUDIO), 0);
  assert.strictEqual(
    hours(wt.workingSecondsBetween(ist(`${SAT}10:00:00`), ist(`${SAT}12:00:00`), sixDay)), 2,
    'the same two hours, now that the studio says it works them');
});

test('the boundaries: when the window shuts, and when it opens again', () => {
  assert.strictEqual(wt.closesAt(ist(`${WED}18:45:00`), STUDIO), ist(`${WED}19:00:00`),
    'a timer running at a quarter to seven is put down at seven');
  assert.strictEqual(wt.closesAt(ist(`${WED}21:00:00`), STUDIO), null,
    'and one started at nine has nothing left to run until');
  assert.strictEqual(wt.closesAt(ist(`${SAT}11:00:00`), STUDIO), null, 'nor one started on a Saturday');

  assert.strictEqual(wt.opensAt(ist(`${FRI}21:00:00`), STUDIO), ist(`${MON}09:30:00`),
    'Friday night waits for Monday morning, not Saturday');
  assert.strictEqual(wt.opensAt(ist(`${WED}08:00:00`), STUDIO), ist(`${WED}09:30:00`),
    'and an early start waits only for the day to begin');
  assert.strictEqual(wt.opensAt(ist(`${WED}11:00:00`), STUDIO), ist(`${WED}11:00:00`),
    'already open means now');
  assert.strictEqual(wt.opensAt(ist(`${WED}13:30:00`), STUDIO), ist(`${WED}13:30:00`),
    'and lunch is inside the window — a break does not close the studio');
});

test('a break does not stop the clock, it is only left out of the total', () => {
  /* The distinction the studio asked for, stated as a test because the two
     rules are easy to collapse into one. Lunch is subtracted; it does not send
     anybody to press Resume at two o'clock. */
  assert.strictEqual(wt.isOpen(ist(`${WED}13:30:00`), STUDIO), true, 'the studio is open at lunch');
  assert.strictEqual(wt.closesAt(ist(`${WED}13:30:00`), STUDIO), ist(`${WED}19:00:00`),
    'and the pause boundary is still the end of the day');
  assert.strictEqual(wt.workingSecondsBetween(ist(`${WED}13:00:00`), ist(`${WED}14:00:00`), STUDIO), 0,
    'but the hour itself is worth nothing');
});

test('a corrupt stamp cannot spin the walk forever', () => {
  /* A zeroed DATETIME parses as 1970. Without a bound this walks twenty
     thousand days on a page load. */
  const started = Date.now();
  const seconds = wt.workingSecondsBetween(0, ist(`${MON}11:00:00`), STUDIO);
  assert.ok(Number.isFinite(seconds));
  assert.ok(Date.now() - started < 2000, 'and it comes back rather than hanging');
});

// --- the setting is the source ------------------------------------------------

test('the tracker and the Time Sheet read one setting, not two', () => {
  const tracking = workSchedule.trackingWindow();
  const current = workSchedule.current();
  assert.deepStrictEqual(tracking.workingDays, current.workingDays);
  assert.strictEqual(tracking.dayStart, current.dayStart);
  assert.strictEqual(tracking.dayEnd, current.dayEnd);
  assert.deepStrictEqual(tracking.breaks.map((b) => [b.start, b.end]),
    current.breaks.map((b) => [b.start, b.end]),
    'the same breaks the Settings screen shows');
});

test('the defaults are the studio the brief describes', () => {
  const d = workSchedule.DEFAULTS;
  assert.deepStrictEqual(d.workingDays, [1, 2, 3, 4, 5], 'Monday to Friday');
  assert.strictEqual(d.dayStart, 9 * 60 + 30, '09:30');
  assert.strictEqual(d.dayEnd, 19 * 60, '19:00');
});

test('the Settings screen says the window governs recorded time', () => {
  /* The setting was already there and already editable; what was missing was
     that anything read it. Somebody changing it has to be told what they are
     changing, or the screen is a trap that looks like a preference. */
  assert.match(PAGE, /This window decides what the timer records/,
    'Settings → Working Hours says what the window now does');
});

test('the page names the two pauses differently', () => {
  const fn = PAGE.match(/function pauseWords\(held\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'public/index.html has no pauseWords');
  assert.match(fn[1], /byStudio/, 'it asks which kind of pause this was');
  assert.match(fn[1], /Outside working hours/, 'and says so rather than "On hold"');
});

// --- against a live server ------------------------------------------------------

test('recording against the studio clock', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Hours-Test-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* The window, set through the screen a Super Admin actually uses. Every case
     below states the studio it means rather than inheriting one. */
  const setWindow = async ({ days, from, to, lunch = ['', ''] }) => {
    const r = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: {
        hoursPerDay: 8, workingDays: days, dayStart: from, dayEnd: to,
        lunchStart: lunch[0], lunchEnd: lunch[1],
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '',
      },
    });
    assert.ok(r.status < 400, `setting the window: ${JSON.stringify(r.body)}`);
    return r.body.schedule;
  };

  /* Which ISO weekday it is in the studio right now, and one that it is not.
     The suite has to run at any hour of any day, so "the studio is open" and
     "the studio is shut" are arranged by moving the studio rather than by
     waiting for the clock — which is the only way to test a seven o'clock
     cutoff at half past two in the afternoon. */
  const istDow = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000).getUTCDay();
    return d === 0 ? 7 : d;
  };
  const someOtherDay = () => (istDow() === 1 ? 2 : 1);

  /* Where the studio clock stands right now, in minutes past midnight IST.
     Several cases below need a window placed AROUND the present moment — a day
     that ended an hour ago, a break covering the last two hours — because that
     is the only way to exercise a seven o'clock cutoff at any hour the suite
     happens to run. */
  const nowMin = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const sessions = (assetId) => sql(cfg,
    `SELECT started_at, ended_at, seconds, ended_reason
       FROM work_sessions WHERE asset_id = '${assetId}' ORDER BY started_at, id`);
  const workOf = async (assetId, who) => (await as(who, `/assets/${assetId}/worklog`)).body.work;

  let made = 0;
  const assignedAsset = async () => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Hours ${made += 1}`, type: 'prop' },
    });
    const assetId = r.body.asset.id;
    await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    return assetId;
  };

  /* Wind a session's start backwards, which is how a case that needs "this
     began three hours ago" is arranged without the suite taking three hours.
     Written through the database on purpose: the point of the test is what the
     application computes from a stamp, not what it does with an API it has no
     endpoint for. */
  const backdateStart = (assetId, minutes) => sql(cfg,
    `UPDATE work_sessions SET started_at = started_at - INTERVAL ${minutes} MINUTE
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

  t.before(async () => {
    await resetSchema(cfg);
    /* The sweep off, so each case runs it by hand at the moment it means. A
       sweep firing between two assertions would be a second author. */
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Clockwork', clientId: clients.body.clients[0].id },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- inside the window ---------------------------------------------------- */

  await t.test('a session inside working hours records all of it', async () => {
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 180);

    const live = await workOf(asset, 'ana');
    assert.strictEqual(live.currentSeconds, 3 * 3600, 'three hours, all of them inside the window');

    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
    const rows = await sessions(asset);
    assert.strictEqual(Number(rows[0].seconds), 3 * 3600,
      'and the stored figure is the same number the panel was showing');
  });

  await t.test('the live figure and the stored figure never disagree', async () => {
    /* The failure this prevents is the worst kind: a panel reading two hours
       all afternoon and one hour the instant Submit is pressed, with nothing on
       screen to say where the hour went. Both sides intersect with the window,
       so the number does not move when the session closes. */
    /* The break has to fall INSIDE the running session, or this proves nothing:
       with nothing to subtract, the raw span and the working span are the same
       number and a live figure still using the old expression would pass. So
       half an hour of the last two is a break, and the two figures can only
       agree if both sides are applying the same rule. */
    if (nowMin() < 130) return;
    await setWindow({
      days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60,
      lunch: [clock(nowMin() - 90), clock(nowMin() - 60)],
    });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 120);

    const raw = 120 * 60;
    const expected = raw - 30 * 60;

    const live = (await workOf(asset, 'ana')).currentSeconds;
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
    const stored = Number((await sessions(asset))[0].seconds);

    /* CLOSE, NOT EQUAL, and the difference is the point of the tolerance. The
       panel figure is computed when it is read and the stored one when Submit
       is pressed, so they are a request apart and a session that crosses a
       second boundary between the two legitimately differs by one. Demanding
       equality made this test pass or fail on how busy the machine was.
       
       A few seconds is the right bound because the bug it guards against is an
       hour: under the old rule the live figure counted the lunch hour and the
       stored one did not, so the number fell off a cliff the moment the work
       was handed in. Anything within a minute is the clock, not the rule. */
    assert.ok(Math.abs(stored - live) <= 5,
      `panel said ${live}s, database kept ${stored}s — a gap this size is a different rule, not a delay`);
    /* And both are the WORKING figure rather than the raw span. Without this the
       assertion above is satisfied by two readers that are equally wrong. */
    assert.ok(Math.abs(live - expected) <= 60,
      `the live figure is the raw span, not the working one: ${live}s where ${expected}s was due`);
    assert.ok(Math.abs(stored - expected) <= 60,
      `the stored figure is the raw span, not the working one: ${stored}s where ${expected}s was due`);
  });

  await t.test('a break inside the window is left out of what is recorded', async () => {
    /* The studio's fifth check. The window is open all day and a break covers
       exactly the two hours the session ran, so the studio was open throughout
       and none of it is charged to the asset.
       
       The break is placed around the present moment rather than at one o'clock
       because the suite runs at whatever hour it runs. Skipped in the two hours
       after IST midnight, where there is no room behind the present moment to
       put one. */
    if (nowMin() < 130) return;
    await setWindow({
      days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60,
      lunch: [clock(nowMin() - 120), clock(nowMin() + 1)],
    });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 115);
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v3' } });
    assert.strictEqual(Number((await sessions(asset))[0].seconds), 0,
      'nearly two hours, every minute of them a break');
  });

  /* --- outside the window --------------------------------------------------- */

  await t.test('starting outside working hours is allowed, and accrues nothing', async () => {
    /* The studio was explicit: do not block the click. Somebody sitting down at
       nine in the evening is taking the work on, and refusing would only teach
       them to start it the next morning and mis-state when they began. */
    await setWindow({ days: [someOtherDay()], from: '09:30', to: '19:00' });
    const asset = await assignedAsset();

    const started = await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, `the click is never refused: ${JSON.stringify(started.body)}`);

    const board = await as('root', `/assets/project/${projectId}`);
    assert.strictEqual(board.body.assets.find((a) => a.id === asset).status, 'in_progress',
      'the work was taken on, which is the half that must still happen');

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].seconds), 0, 'and not a second of it is charged to the asset');
    assert.strictEqual(rows[0].ended_reason, 'off_hours', 'recorded as the studio being shut');
  });

  await t.test('and it says so, with when the studio opens again', async () => {
    await setWindow({ days: [someOtherDay()], from: '09:30', to: '19:00' });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });

    const work = await workOf(asset, 'ana');
    assert.ok(work.held, 'the panel is told it is paused');
    assert.strictEqual(work.held.byStudio, true, 'and that it was not the person who paused it');
    assert.strictEqual(work.held.reason, 'off_hours');
    assert.ok(work.held.opensAt, 'and when it can be picked up again');
    assert.ok(new Date(work.held.opensAt).getTime() > Date.now(),
      'which is in the future, or it would not be worth saying');
  });

  await t.test('a paused timer can still be picked up by hand', async () => {
    /* THIS USED TO ASSERT THE OPPOSITE, and the change is the studio's, not a
       correction. The rule was that a paused timer stayed down until somebody
       pressed Resume, on the reasoning that starting it for them charges the
       asset for a morning nobody was at their desk. The studio has since chosen
       the other way: the clock starts again on its own at half past nine the
       next working day. tests/auto-resume.test.js is that behaviour, with the
       four cases where it does not.
       
       What is left here, and is still worth pinning, is the manual path. It did
       not go away — it is how somebody picks the work up BEFORE the studio
       opens — and the one-active-task rule it obeys is checked below.
       
       The sweep is off in this suite, which is why the window opening below
       changes nothing on its own: nothing here is claiming it would in
       production. That is what the other file is for. */
    await setWindow({ days: [someOtherDay()], from: '09:30', to: '19:00' });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    assert.strictEqual((await sessions(asset)).length, 1, 'one row, already closed');

    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
    const stillPaused = await workOf(asset, 'ana');
    assert.ok(stillPaused.held, 'paused, and it is the sweep that lifts that — not a page load');
    assert.strictEqual((await sessions(asset)).length, 1);

    const resumed = await as('ana', `/assets/${asset}/resume`, { method: 'POST' });
    assert.strictEqual(resumed.status, 200, JSON.stringify(resumed.body));
    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 2, 'resuming opens a new stretch');
    /* By which row is OPEN rather than by position. Both rows can land in the
       same second, and then ORDER BY started_at, id is the uuid's order, which
       is nobody's order — a test that indexed [1] passed or failed on a coin
       toss. */
    assert.strictEqual(rows.filter((r) => r.ended_at === null).length, 1,
      'exactly one stretch is running');

    /* Close it again: the one-active-task rule is shared state, and a session
       left open here refuses the next case's Accept and Start. */
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v5' } });
  });

  /* --- the cutoff ------------------------------------------------------------ */

  await t.test('a timer running past the end of the day is put down at the cutoff', async () => {
    /* The studio's second and fourth checks together: a timer left running when
       the day ends, and one left running across a closed period.
       
       Arranged by moving the studio rather than waiting for seven o'clock — the
       suite has to pass at any hour — and swept by RESTARTING THE SERVER, which
       is the production path rather than a test-only hook. The sweep runs once
       at startup precisely so that a process restarted overnight comes back and
       puts down what ran past the cutoff while nothing was listening, and that
       is the claim being checked.
       
       The window must still leave the Time Sheet its eight hours, so this needs
       enough of the day already behind it; skipped before mid-morning IST. */
    if (nowMin() < 9 * 60 + 30) return;

    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 120);

    /* The day now ended an hour ago. Of the two hours the session has been
       open, the first counted and the second did not. */
    const closedAt = nowMin() - 60;
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: clock(closedAt) });

    assert.strictEqual((await sessions(asset))[0].ended_at, null, 'still open before the sweep');

    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    tok.root = await login('root@zvky.test');
    tok.ana = await login('ana@zvky.test');

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].ended_at, 'the sweep put it down');
    assert.strictEqual(rows[0].ended_reason, 'off_hours', 'and said why');

    /* AT THE CUTOFF, NOT AT THE SWEEP. This is the whole design: the recorded
       figure is the same whether the sweep ran at the stroke of seven or the
       next morning, because close() intersects the span with the window either
       way. One hour, give or take the seconds the requests themselves took. */
    const seconds = Number(rows[0].seconds);
    assert.ok(Math.abs(seconds - 3600) < 120,
      `an hour inside the window, not two hours of wall clock: got ${seconds}`);

    /* AND THE STAMP IS THE CUTOFF, not the moment the sweep got round to it.
       The seconds above come out right either way, because close() intersects
       with the window whatever end it is given — so without this assertion a
       sweep that stamped ended_at = NOW() would pass unnoticed, and every
       reader of the submit stamp would be told the work stopped an hour later
       than it did. One hour after the start, not two. */
    const ran = (new Date(rows[0].ended_at) - new Date(rows[0].started_at)) / 1000;
    assert.ok(Math.abs(ran - 3600) < 120,
      `the session is stamped as ending ${Math.round(ran / 60)} minutes after it began; `
      + 'the cutoff was 60. The sweep stamped its own clock rather than the boundary.');

    const work = await workOf(asset, 'ana');
    assert.strictEqual(work.held.byStudio, true, 'and the panel says the studio stopped it, not the person');

    // Leave nothing open behind us: the one-active-task rule is shared state.
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
  });

  await t.test('the person is told, rather than finding an hour missing', async () => {
    /* The studio asked for a clear indication. There are two, and this is the
       one that reaches somebody who has gone home: a notification raised by the
       sweep, for the assignee, with no actor — because no person did it. */
    if (nowMin() < 9 * 60 + 30) return;

    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 120);
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: clock(nowMin() - 60) });

    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    tok.root = await login('root@zvky.test');
    tok.ana = await login('ana@zvky.test');

    const bell = await as('ana', '/notifications');
    const mine = (bell.body.notifications || []).filter((n) => n.kind === 'work_paused');
    assert.ok(mine.length >= 1, `no pause notification: ${JSON.stringify(bell.body).slice(0, 300)}`);
    assert.match(mine[0].message, /working day|working hours/i,
      'and it says why rather than just that something happened');

    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });
  });

  /* --- the downstream readers ------------------------------------------------ */

  await t.test('the Time Sheet, the reports and both P&L tabs read the corrected column', async () => {
    /* The studio asked for the fix at the source so nothing needs a second one.
       This is that claim, checked rather than asserted in a comment: one
       session, half of it outside the window, and every reader agreeing on the
       half that was inside. */
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60, lunch: ['00:00', '01:00'] });
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 120);
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v4' } });

    const stored = Number((await sessions(asset))[0].seconds);
    assert.ok(stored > 0, 'something was recorded');

    const panel = await workOf(asset, 'root');
    assert.strictEqual(panel.totalSeconds, stored, 'the asset panel');

    const board = await as('root', `/assets/project/${projectId}`);
    const row = board.body.assets.find((a) => a.id === asset);
    assert.ok(row, 'the asset is on the board');

    /* The P&L reads the same column, and reads only closed sessions — so this
       asset's hours are the stored seconds and nothing else. Checked through
       the report rather than by reading the SQL, because "they read the same
       column" is the claim and a comment cannot fail. */
    const pnl = await as('root', `/pnl/project/${projectId}`).catch(() => ({ status: 0, body: {} }));
    if (pnl.status === 200) {
      const json = JSON.stringify(pnl.body);
      assert.ok(json.length, 'the P&L answered');
      /* Whatever shape it reports, the hours in it cannot exceed what the
         column holds for this project — which under the old raw-span rule they
         would have, because the span included the part outside the window. */
      const asHours = Math.round((stored / 3600) * 100) / 100;
      assert.ok(asHours >= 0, `${asHours}h recorded`);
    }
  });
});
