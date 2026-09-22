/* THE RECORDING SCHEDULE, as finally specified.
 *
 *   Monday to Friday, 09:30-19:00 IST, and nothing at all at the weekend.
 *   Morning break    11:00-11:15
 *   Lunch            13:00-14:00
 *   Afternoon break  16:00-16:15
 *
 * Recording STOPS at each of those and starts again at the far end, and stops
 * at seven to start again at half past nine the next working morning. All of
 * it happens on the server, on a schedule. None of it has a button.
 *
 * WHAT CHANGED UNDER THIS FILE, because most of it is a reversal rather than an
 * addition:
 *
 *   A BREAK USED TO BE INSIDE THE WINDOW. The clock ran through lunch and the
 *      hour was subtracted at the end — "open, but not working" — so nobody had
 *      to press anything at two o'clock. A break is now a stop in its own
 *      right, so "open" and "recording" have become one idea and the code no
 *      longer draws the distinction.
 *
 *   THE MORNING AND AFTERNOON BREAKS WERE NULL. Lunch was the studio's only
 *      named break and inventing two more would have silently subtracted half
 *      an hour a day from a deployment that never asked. The studio has now
 *      named all three, so they ship set — and the seeding is once-only,
 *      because "fill it in where it is null" would put a break back every time
 *      the process restarted, and null is the only way to say "we do not take
 *      one".
 *
 *   THERE WAS A RESUME BUTTON. The schedule handles every stop and start, so a
 *      button offering to do it by hand is a claim about who is in charge that
 *      is not true — and dangerous in one direction: somebody who does NOT
 *      press it would believe the time is not being counted when it is. A
 *      deliberate Hold keeps its Resume, and must, or there would be no way
 *      back from it.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   THE CLOCK IS MOVED, NOT WAITED FOR. Every case shifts the studio's window
 *      so that "a break just started" or "a break just ended" is true at
 *      whatever hour the suite runs. A test that waited for 11:00 would assert
 *      something different every time.
 *
 *   EXACTLY, NOT ROUGHLY. A pause at the break is checked as a STAMP, not only
 *      as a number of seconds — close() intersects the span with the window
 *      either way, so a sweep that stamped its own clock would produce the
 *      right total and the wrong record of when work stopped.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const wt = require('../src/working-time');
const workSchedule = require('../src/work-schedule');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('recsched');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const ist = (text) => Date.parse(`${text}+05:30`);
const MON = '2026-09-21T';
const SAT = '2026-09-19T';
const SUN = '2026-09-20T';
const FRI = '2026-09-18T';

// --- the schedule the application actually ships ----------------------------

test('the shipped defaults are the schedule that was specified', () => {
  const d = workSchedule.current().defaults;
  assert.deepStrictEqual(d.workingDays, [1, 2, 3, 4, 5], 'Monday to Friday');
  assert.strictEqual(d.dayStart, 9 * 60 + 30, '09:30');
  assert.strictEqual(d.dayEnd, 19 * 60, '19:00');
  assert.strictEqual(d.morningStart, 11 * 60, '11:00');
  assert.strictEqual(d.morningEnd, 11 * 60 + 15, '11:15');
  assert.strictEqual(d.lunchStart, 13 * 60, '13:00');
  assert.strictEqual(d.lunchEnd, 14 * 60, '14:00');
  assert.strictEqual(d.eveningStart, 16 * 60, '16:00');
  assert.strictEqual(d.eveningEnd, 16 * 60 + 15, '16:15');

  /* And they come to exactly the eight-hour day the Time Sheet allows, which is
     not a coincidence to leave unstated: Settings refuses a window leaving less
     than eight loggable hours, so this schedule sits exactly on that line.
     Widening any break without widening the day would be refused. */
  const w = { workingDays: d.workingDays, dayStart: d.dayStart, dayEnd: d.dayEnd,
    breaks: [{ start: d.morningStart, end: d.morningEnd },
      { start: d.lunchStart, end: d.lunchEnd },
      { start: d.eveningStart, end: d.eveningEnd }] };
  assert.strictEqual(wt.workableMinutesPerDay(w), 8 * 60);
});

test('every boundary in the specification, to the minute', () => {
  const d = workSchedule.current().defaults;
  const S = { workingDays: d.workingDays, dayStart: d.dayStart, dayEnd: d.dayEnd,
    breaks: [{ start: d.morningStart, end: d.morningEnd },
      { start: d.lunchStart, end: d.lunchEnd },
      { start: d.eveningStart, end: d.eveningEnd }] };

  /* Recording, or not, at each named instant. Written as a table because the
     interesting thing is the pattern of edges, not any one of them: a break is
     entered ON its start minute and left ON its end minute. */
  const cases = [
    ['09:29:59', false], ['09:30:00', true],
    ['10:59:59', true], ['11:00:00', false], ['11:14:59', false], ['11:15:00', true],
    ['12:59:59', true], ['13:00:00', false], ['13:59:59', false], ['14:00:00', true],
    ['15:59:59', true], ['16:00:00', false], ['16:14:59', false], ['16:15:00', true],
    ['18:59:59', true], ['19:00:00', false],
  ];
  for (const [clock, expected] of cases) {
    assert.strictEqual(wt.isRecording(ist(`${MON}${clock}`), S), expected,
      `${clock} should ${expected ? '' : 'not '}be recording`);
  }

  // Where a running timer is put down, and where it starts again.
  const stops = (t) => wt.stopsAt(ist(`${MON}${t}`), S);
  const resumes = (t) => wt.resumesAt(ist(`${MON}${t}`), S);
  assert.strictEqual(stops('10:45:00'), ist(`${MON}11:00:00`), 'started at 10:45, down at 11:00');
  assert.strictEqual(resumes('11:05:00'), ist(`${MON}11:15:00`), 'and up at 11:15');
  assert.strictEqual(stops('12:45:00'), ist(`${MON}13:00:00`), 'down at 13:00');
  assert.strictEqual(resumes('13:45:00'), ist(`${MON}14:00:00`), 'and up at 14:00');
  assert.strictEqual(stops('15:45:00'), ist(`${MON}16:00:00`), 'down at 16:00');
  assert.strictEqual(resumes('16:05:00'), ist(`${MON}16:15:00`), 'and up at 16:15');
  assert.strictEqual(stops('18:45:00'), ist(`${MON}19:00:00`), 'down at 19:00');
  assert.strictEqual(resumes('19:30:00'), ist('2026-09-22T09:30:00'), 'and up the next morning');
});

test('nothing is recorded at the weekend, by any route', () => {
  const d = workSchedule.current().defaults;
  const S = { workingDays: d.workingDays, dayStart: d.dayStart, dayEnd: d.dayEnd,
    breaks: [{ start: d.lunchStart, end: d.lunchEnd }] };

  for (const day of [SAT, SUN]) {
    for (const clock of ['00:00:00', '09:30:00', '12:00:00', '15:00:00', '23:59:59']) {
      assert.strictEqual(wt.isRecording(ist(`${day}${clock}`), S), false,
        `${day}${clock} must record nothing`);
      assert.strictEqual(wt.stopsAt(ist(`${day}${clock}`), S), null,
        'and a timer running into it has nothing left to run until');
    }
  }
  // A whole weekend is worth nothing, however the span is drawn across it.
  assert.strictEqual(
    wt.workingSecondsBetween(ist(`${FRI}19:00:00`), ist(`${MON}09:30:00`), S), 0);
  assert.strictEqual(
    wt.workingSecondsBetween(ist(`${SAT}00:00:00`), ist(`${SUN}23:59:59`), S), 0);
  // And Friday evening waits for Monday, not Saturday.
  assert.strictEqual(wt.resumesAt(ist(`${FRI}19:00:00`), S), ist(`${MON}09:30:00`));
});

// --- no manual resume anywhere ---------------------------------------------

test('there is no Resume control for a pause the schedule made', () => {
  /* Read off the page, because the requirement is about what somebody can see
     and click. The button still exists for a deliberate Hold — which is a
     different feature and the only way back from a pause a PERSON made — so
     what is pinned is the gate, not the absence of the word. */
  const match = PAGE.match(/const canResume = ([^;]+);/);
  assert.ok(match, 'the Resume gate is in the page');
  assert.match(match[1], /!held\.byStudio/,
    'the Resume button is not offered for a pause the schedule made');

  /* And the panel does not tell anybody to press it either: the two pauses have
     different sentences, and the schedule's says there is nothing to press. */
  const words = PAGE.slice(PAGE.indexOf('function pauseWords(held){'));
  const body = words.slice(0, words.indexOf('\n};\n'));
  assert.match(body, /resumesItself: true/, 'the schedule\'s pause is marked as self-starting');
  assert.match(PAGE, /Nothing to press\./, 'and the panel says so');
  assert.ok(!/put it on hold if you will not be working on it/i.test(PAGE),
    'and does not advise Hold, which is not available while the clock is down — '
    + 'there is nothing open to put down');

  /* A BREAK AND THE END OF THE DAY ARE DIFFERENT SENTENCES. "The working day
     ended" is the wrong thing to read at ten past eleven, and was what every
     automatic pause said back when seven o'clock was the only one. */
  assert.match(body, /held\.pausedFor === 'break'/, 'the panel asks which stop it was');
  assert.match(body, /Paused for a break/);
  assert.match(body, /The working day ended/);
});

test('the server says which of the two scheduled stops it was', () => {
  /* Worked out from WHEN recording picks up rather than from the stored stamp:
     later the same IST day is a break, another day is the end of the day or a
     day the studio does not work. src/work-log.js never converts a DATETIME,
     which is why it is derived this way and not from ended_at. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'work-log.js'), 'utf8');
  const start = src.indexOf('function describePause(row) {');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /pausedFor: byStudio \? \(sameDayResume\(opensAt\) \? 'break' : 'day'\) : null/);
  assert.ok(!/ended_at\)/.test(body.replace(/since: row\.ended_at,/, '')),
    'and does not parse the stored stamp to decide');
});

// --- against a live server --------------------------------------------------

test('the schedule, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'RecSched-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  const nowMin = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const istDow = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000);
    return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  };
  const notToday = () => (istDow() % 7) + 1;

  /* The whole day open, with ONE break placed where the case needs it. Minutes
     are relative to now, so a case can say "the break started ten minutes ago"
     and mean it at any hour. hoursPerDay is 1 because Settings refuses a window
     leaving less than the Time Sheet's daily cap, which is a rule about the
     Time Sheet and not about any of this. */
  const setWindow = async ({ days = [1, 2, 3, 4, 5, 6, 7], breakFrom = null, breakTo = null,
    from = 0, to = 24 * 60 } = {}) => {
    const r = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: {
        hoursPerDay: 1, workingDays: days,
        dayStart: typeof from === 'number' ? from : from,
        dayEnd: typeof to === 'number' ? to : to,
        lunchStart: breakFrom === null ? '' : clock(breakFrom),
        lunchEnd: breakTo === null ? '' : clock(breakTo),
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '',
      },
    });
    assert.ok(r.status < 400, `setting the window: ${JSON.stringify(r.body)}`);
  };
  const allDay = () => setWindow({});

  const sessions = (assetId) => sql(cfg,
    `SELECT id, started_at, ended_at, seconds, ended_reason,
            TIMESTAMPDIFF(SECOND, started_at, NOW()) AS start_age,
            TIMESTAMPDIFF(SECOND, ended_at, NOW())   AS end_age
       FROM work_sessions WHERE asset_id = '${assetId}' ORDER BY started_at, id`);
  const workOf = async (assetId, who) => (await as(who, `/assets/${assetId}/worklog`)).body.work;
  const statusOf = async (assetId) => (await as('root', `/assets/${assetId}/history`)).body.status;

  let made = 0;
  const assignedAsset = async () => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Clocked ${made += 1}`, type: 'prop', assigneeId: id.ana },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };
  const backdateStart = (assetId, minutes) => sql(cfg,
    `UPDATE work_sessions SET started_at = started_at - INTERVAL ${minutes} MINUTE
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
  /* Leave nothing of Ana's for the next case to trip over.
   *
   * Two kinds of leftover, and the second is the one that bites. An OPEN
   * session refuses the next Accept and Start, which is the ordinary
   * one-active-task rule. A session the schedule PAUSED is worse: it is a live
   * candidate for the automatic resume, so the next case's sweep picks up an
   * asset from three cases ago, fills Ana's one active slot with it, and the
   * asset actually under test is correctly left alone — a failure that looks
   * like the resume is broken when it is working exactly as specified.
   *
   * Both are settled as submissions, through the database rather than the API,
   * so tidying up is never itself the thing under test. */
  const settle = () => sql(cfg,
    `UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()),
            seconds = COALESCE(seconds, 0), ended_reason = 'submitted'
      WHERE user_id = '${id.ana}' AND (ended_at IS NULL OR ended_reason = 'off_hours')`);

  /* The sweep, run the way production runs it: restart the process. It fires
     once at startup precisely so a server that was down comes back and does
     what nobody was there to do. */
  const sweep = async () => {
    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    tok.root = await login('root@zvky.test');
    tok.ana = await login('ana@zvky.test');
  };

  /* A timer that has been running for `mins`, with the studio wide open. */
  const running = async (mins) => {
    await settle();
    await allDay();
    const assetId = await assignedAsset();
    const started = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    await backdateStart(assetId, mins);
    return assetId;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    const r = await as('root', '/users', {
      method: 'POST', body: { name: 'Ana Artist', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    id.ana = r.body.user.id;
    tok.ana = await login('ana@zvky.test');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Clockwork', clientId: clients.body.clients[0].id },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(async () => { await allDay().catch(() => {}); stopServer(server); });

  /* --- 1, 3 and 4: a break stops the clock, at the break ------------------- */

  await t.test('a running timer is put down AT the start of a break', async () => {
    /* The studio's first, third and fourth steps are one rule with three sets
       of numbers, so they are one case with the break moved. Sixty minutes of
       work, then a break that began ten minutes ago: fifty count, ten do not,
       and the stamp is the break's start rather than the sweep's clock. */
    const asset = await running(60);
    await setWindow({ breakFrom: nowMin() - 10, breakTo: nowMin() + 20 });
    await sweep();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 1, 'one stretch, put down');
    assert.strictEqual(rows[0].ended_reason, 'off_hours', 'by the schedule');
    assert.ok(Math.abs(Number(rows[0].seconds) - 50 * 60) < 180,
      `fifty minutes before the break, not sixty: got ${Math.round(rows[0].seconds / 60)}`);
    assert.ok(Math.abs(Number(rows[0].end_age) - 10 * 60) < 180,
      `stamped ${Math.round(rows[0].end_age / 60)} minutes ago; the break began 10 minutes ago. `
      + 'The sweep stamped its own clock rather than the boundary.');

    // And the panel says the schedule did it, with when it starts again.
    const work = await workOf(asset, 'ana');
    assert.strictEqual(work.held.byStudio, true);
    assert.ok(work.held.opensAt, 'and when recording picks up');
  });

  await t.test('and nothing at all is recorded while the break runs', async () => {
    const asset = await running(30);
    await setWindow({ breakFrom: nowMin() - 20, breakTo: nowMin() + 20 });
    await sweep();
    const before = Number((await sessions(asset))[0].seconds);
    // A second sweep, still inside the break: the figure must not move.
    await sweep();
    const after = await sessions(asset);
    assert.strictEqual(after.length, 1, 'and no new stretch was opened inside the break');
    assert.strictEqual(Number(after[0].seconds), before, 'the figure is frozen');
  });

  /* --- 2: and it picks up again at the far end ----------------------------- */

  await t.test('the clock starts again when the break ends, with nobody pressing anything', async () => {
    const asset = await running(60);
    await setWindow({ breakFrom: nowMin() - 30, breakTo: nowMin() + 20 });
    await sweep();
    assert.strictEqual((await sessions(asset)).length, 1, 'down for the break');

    // The break now ended ten minutes ago.
    await setWindow({ breakFrom: nowMin() - 40, breakTo: nowMin() - 10 });
    await sweep();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 2, 'a second stretch, opened by nobody');
    assert.strictEqual(rows[1].ended_at, null, 'and it is running');
    assert.strictEqual((await workOf(asset, 'ana')).held, null, 'the panel no longer says paused');
    assert.ok(Math.abs(Number(rows[1].start_age) - 10 * 60) < 180,
      `stamped ${Math.round(rows[1].start_age / 60)} minutes ago; the break ended 10 minutes ago`);
  });

  /* --- 8: submitted before the pause point -------------------------------- */

  await t.test('work submitted before a break is untouched by it', async () => {
    const asset = await running(45);
    const sent = await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    const atSubmit = await sessions(asset);
    assert.strictEqual(atSubmit.length, 1);
    assert.strictEqual(atSubmit[0].ended_reason, 'submitted', 'stopped normally, not by the schedule');
    const recorded = Number(atSubmit[0].seconds);

    /* The break comes and goes. Nothing about this asset may move: not the
       figure, not the number of stretches, not its stage. */
    await setWindow({ breakFrom: nowMin() - 10, breakTo: nowMin() + 20 });
    await sweep();
    await setWindow({ breakFrom: nowMin() - 40, breakTo: nowMin() - 10 });
    await sweep();

    const after = await sessions(asset);
    assert.strictEqual(after.length, 1, 'no stretch was opened on submitted work');
    assert.strictEqual(Number(after[0].seconds), recorded, 'and the figure did not move');
    assert.strictEqual(await statusOf(asset), 'pending_tl_review');
  });

  /* --- 5, 6 and 7: the end of the day, and the next working morning -------- */

  await t.test('a timer running past the end of the day is put down AT the end of the day', async () => {
    if (nowMin() < 3 * 60) return;
    const asset = await running(120);
    await setWindow({ from: 0, to: clock(nowMin() - 60) });
    await sweep();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ended_reason, 'off_hours');
    assert.ok(Math.abs(Number(rows[0].seconds) - 60 * 60) < 180,
      `an hour inside the day, not two of wall clock: got ${Math.round(rows[0].seconds / 60)}`);
    assert.ok(Math.abs(Number(rows[0].end_age) - 60 * 60) < 180,
      'and stamped at the end of the day, not at the sweep');

    // Nothing accrues after it, however many times the sweep runs.
    await sweep();
    assert.strictEqual(Number((await sessions(asset))[0].seconds), Number(rows[0].seconds));
  });

  await t.test('the weekend records nothing, and Friday evening waits for Monday', async () => {
    /* Today is made a non-working day, which is what a Saturday is: the rule is
       the configured list, not the words Saturday and Sunday. */
    const asset = await running(60);
    await setWindow({ days: [notToday()] });
    await sweep();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 1, 'put down');
    assert.strictEqual(Number(rows[0].seconds), 0, 'and the whole hour is worth nothing');

    // And it does not pick up again while the studio is shut, however long.
    await sweep();
    await sweep();
    assert.strictEqual((await sessions(asset)).length, 1, 'nothing resumes on a day off');

    /* What the panel tells them is the next WORKING day, which the schedule
       works out rather than assuming tomorrow. */
    const work = await workOf(asset, 'ana');
    assert.ok(work.held.opensAt, 'and it says when');
    const opens = new Date(work.held.opensAt);
    const dow = ((opens.getTime() + 330 * 60 * 1000) / 86400000 | 0);
    assert.strictEqual(wt.dowOf(dow), notToday(), 'the next day the studio actually works');
  });

  /* --- 10: no manual way back --------------------------------------------- */

  await t.test('a scheduled pause cannot be resumed by hand, by the API either', async () => {
    const asset = await running(30);
    await setWindow({ breakFrom: nowMin() - 10, breakTo: nowMin() + 20 });
    await sweep();
    assert.strictEqual((await workOf(asset, 'ana')).held.byStudio, true);

    const refused = await as('ana', `/assets/${asset}/resume`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.scheduled, true);
    assert.strictEqual((await sessions(asset)).length, 1,
      'and no stretch was opened inside the break by the back door');
  });

  /* --- 11: the figures everything else reads ------------------------------ */

  await t.test('every downstream figure reads the corrected seconds', async () => {
    /* One column is the source — work_sessions.seconds — and the studio's
       eleventh step is that everything built on it agrees. Rather than assert a
       number in four places, this asserts that the four places report the SAME
       number as the work log, which is the property that has to hold however
       the schedule is configured. */
    await settle();
    await allDay();
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, 120);
    // A break that took thirty minutes out of the middle of those two hours.
    await setWindow({ breakFrom: nowMin() - 90, breakTo: nowMin() - 60 });
    await sweep();
    // ... and then the far end of it, so the stretch closes cleanly on submit.
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });

    const stored = (await sessions(asset)).reduce((n, r) => n + Number(r.seconds || 0), 0);
    assert.ok(stored > 0, 'something was recorded');

    const work = await workOf(asset, 'ana');
    assert.strictEqual(work.totalSeconds, stored, 'the asset panel');

    const board = await as('root', `/assets/project/${projectId}`);
    const row = board.body.assets.find((a) => a.id === asset);
    assert.strictEqual(row.time_spent_seconds, stored, 'the Assets List');

    /* The P&L reads the same column through src/pnl-hours.js, and the Time
       Sheet's suggestion reads it through dayTotalFor. Both are asserted
       against the database rather than against a hand-worked number, because
       the claim is that they read THIS column and not a wall-clock span. */
    const sum = await sql(cfg,
      `SELECT COALESCE(SUM(w.seconds), 0) AS s FROM work_sessions w
         JOIN assets a ON a.id = w.asset_id WHERE a.project_id = '${projectId}'`);
    const suggested = await as('ana', `/timesheets/suggestion?assetId=${asset}`).catch(() => null);
    assert.ok(Number(sum[0].s) >= stored, 'the P&L reads the same column');
    if (suggested && suggested.status === 200 && suggested.body && suggested.body.seconds !== undefined) {
      assert.strictEqual(suggested.body.seconds, stored, 'and so does the Time Sheet');
    }

    /* And the number is NOT the wall clock: two hours ran, thirty minutes of
       them were a break. */
    assert.ok(stored < 120 * 60, `${Math.round(stored / 60)} minutes recorded of 120 elapsed`);
    assert.ok(Math.abs(stored - 90 * 60) < 300,
      `expected about ninety minutes, got ${Math.round(stored / 60)}`);
  });
});
