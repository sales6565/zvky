/* THE TIME ON A TIMESHEET LINE IS THE OVERLAP WITH THAT DAY'S WORKING HOURS.
 *
 * THE WORKED EXAMPLE THE STUDIO GAVE, which is the acceptance test and the
 * first case below: a task started at 18:00 on day 1 and finished at 11:00 on
 * day 2, against a studio open 09:30 to 19:00 with lunch 13:00 to 14:00.
 *
 *     day 1    18:00 → 19:00           1 h
 *     day 2    09:30 → 11:00           1 h 30 m
 *     asset    the two, added          2 h 30 m
 *
 * Never the asset's total, never a midnight split (about 6 h and 11 h), never
 * the wall clock between the first start and the last end (17 h).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG, AND IT IS SUBTLER THAN "IT CLIPPED AT MIDNIGHT".
 *
 * dayTotalFor APPORTIONED the stored work_sessions.seconds across the days a
 * session touched, in proportion to each day's working milliseconds. On a row
 * written by today's close() that is right, because `seconds` is itself the
 * working-hours intersection of the same span — so the example above came out
 * at 1 h and 1 h 30 m on a clean fixture, which is why four fixtures agreed
 * everything was fine.
 *
 * It is only right while that holds, and two things break it:
 *
 *   A PRE-CUTOVER ROW holds a different figure (src/migrate.js, ensureSession-
 *      EndReason: those rows were deliberately not backfilled). Apportioning a
 *      17-hour wall clock by a 40/60 weighting gives 6.8 h and 10.2 h —
 *      MEASURED, and exactly the "about 6 h and 11 h" that was reported.
 *   A SCHEDULE CHANGE breaks it too: the stored whole was computed under one
 *      set of hours and the weights under another.
 *
 * So the stored column is not read at all. The overlap is computed from the two
 * stamps and the day's own windows, which is the definition. The legacy case is
 * the second block below and it is the regression test for this report.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULE IS SET BY EACH BLOCK, NOT openStudio'd AWAY. The example is
 * ABOUT 09:30, 19:00 and the lunch hour, so a suite that opened the clock
 * around the clock would be testing nothing. setRecordingWindows() puts the
 * studio's real shape in place and every figure below is derived from it rather
 * than from a number typed here. FIXED DATES throughout; the one case that must
 * use the real clock is the running session, and it says so where it does it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  setRecordingWindows, SKIP_REASON } = require('./helpers');
const wt = require('../src/working-time');
const workLog = require('../src/work-log');

const cfg = config('tsworkday');
const PASSWORD = 'WorkDay-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* THE STUDIO IN THE EXAMPLE, as a schedule object — the shape
   workSchedule.trackingWindow() produces, so the arithmetic below is run
   against the same thing src/work-log.js reads. */
const STUDIO = {
  workingDays: [1, 2, 3, 4, 5],
  dayStart: 9 * 60 + 30,                 // 09:30
  dayEnd: 19 * 60,                       // 19:00
  breaks: [{ label: 'Lunch', key: 'lunch', start: 13 * 60, end: 14 * 60 }],
  holidays: [],
  timezone: 'IST',
};

const IST_MS = 5.5 * 3600 * 1000;
const at = (day, h, m = 0, s = 0) =>
  Date.parse(`${day}T00:00:00Z`) - IST_MS + (((h * 60 + m) * 60) + s) * 1000;
const hoursOn = (startMs, endMs, day, schedule = STUDIO) =>
  (wt.workingMsByDay(startMs, endMs, schedule).byDay.get(day) || 0) / 3600000;

const DAY1 = '2026-10-08';     // Thursday
const DAY2 = '2026-10-09';     // Friday
const SAT = '2026-10-10';
const SUN = '2026-10-11';
const MON = '2026-10-12';

// ===========================================================================
// 1. THE ARITHMETIC, with no server. The rule, case by case.
// ===========================================================================

test('THE ACCEPTANCE EXAMPLE: 1 h on day 1, 1 h 30 m on day 2, 2 h 30 m in all', () => {
  const start = at(DAY1, 18, 0);
  const end = at(DAY2, 11, 0);

  assert.strictEqual(hoursOn(start, end, DAY1), 1, 'day 1 is 18:00 to 19:00');
  assert.strictEqual(hoursOn(start, end, DAY2), 1.5, 'day 2 is 09:30 to 11:00');
  assert.strictEqual(wt.workingSecondsBetween(start, end, STUDIO), 2.5 * 3600,
    'and the session is worth two and a half hours in all');

  /* THE THREE WRONG ANSWERS, named so that none of them can come back quietly. */
  const wall = (end - start) / 3600000;
  assert.strictEqual(wall, 17, 'the wall clock is 17 h, and is not the figure');
  const midnightD1 = (at(DAY2, 0, 0) - start) / 3600000;
  const midnightD2 = (end - at(DAY2, 0, 0)) / 3600000;
  assert.strictEqual(midnightD1, 6, 'a midnight split would give 6 h on day 1');
  assert.strictEqual(midnightD2, 11, 'and 11 h on day 2');
  assert.notStrictEqual(hoursOn(start, end, DAY1), midnightD1);
  assert.notStrictEqual(hoursOn(start, end, DAY2), midnightD2);
});

test('the sweep cannot change the answer: one row or two give the same figures', () => {
  /* THE PROPERTY THAT MAKES THIS A RULE RATHER THAN A COINCIDENCE. Overlap is
     additive, so it makes no difference whether the evening sweep cut the
     session at 19:00 and the overnight resume opened a new one at 09:30. The
     old apportionment got this right only because the stored whole happened to
     agree with the weights it was divided by. */
  const whole = [at(DAY1, 18, 0), at(DAY2, 11, 0)];
  const split = [[at(DAY1, 18, 0), at(DAY1, 19, 0)], [at(DAY2, 9, 30), at(DAY2, 11, 0)]];

  for (const day of [DAY1, DAY2]) {
    const one = hoursOn(whole[0], whole[1], day);
    const two = split.reduce((n, [a, b]) => n + hoursOn(a, b, day), 0);
    assert.strictEqual(two, one, `${day}: swept and unswept agree`);
  }
  assert.strictEqual(
    split.reduce((n, [a, b]) => n + wt.workingSecondsBetween(a, b, STUDIO), 0),
    wt.workingSecondsBetween(whole[0], whole[1], STUDIO),
    'and so do the totals');
});

test('the lunch blackout is out of the middle of a session', () => {
  // 12:30 to 14:30: half an hour before lunch, half an hour after.
  const h = hoursOn(at(DAY2, 12, 30), at(DAY2, 14, 30), DAY2);
  assert.strictEqual(h, 1, '30 m before lunch and 30 m after, so one hour');
  assert.strictEqual(hoursOn(at(DAY2, 13, 10), at(DAY2, 13, 50), DAY2), 0,
    'and a session entirely inside lunch is worth nothing');
});

test('a weekend contributes nothing, and Monday starts at 09:30', () => {
  const start = at(DAY2, 18, 0);        // Friday evening
  const end = at(MON, 11, 0);           // Monday morning
  assert.strictEqual(hoursOn(start, end, DAY2), 1, 'Friday 18:00 to 19:00');
  assert.strictEqual(hoursOn(start, end, SAT), 0, 'nothing on Saturday');
  assert.strictEqual(hoursOn(start, end, SUN), 0, 'nothing on Sunday');
  assert.strictEqual(hoursOn(start, end, MON), 1.5, 'Monday 09:30 to 11:00');
  assert.strictEqual(wt.workingSecondsBetween(start, end, STUDIO), 2.5 * 3600);
});

test('a holiday contributes nothing, and the day after is unaffected', () => {
  /* HOLIDAYS ARE BUILT (Prompt 22) and they reach the clock through one line:
     spansOn() returns no spans for a closed day — see src/working-time.js. So
     this needs no clause of its own anywhere, which is the thing being
     asserted. */
  const withHoliday = { ...STUDIO, holidays: [DAY2] };
  const start = at(DAY1, 18, 0);
  const end = at(MON, 11, 0);
  assert.strictEqual(hoursOn(start, end, DAY1, withHoliday), 1, 'day 1 is unaffected');
  assert.strictEqual(hoursOn(start, end, DAY2, withHoliday), 0, 'nothing on the holiday');
  assert.strictEqual(hoursOn(start, end, MON, withHoliday), 1.5, 'Monday is itself again');
  // And without the holiday the same span DOES count that day, so the test is about it.
  assert.strictEqual(hoursOn(start, end, DAY2, STUDIO), 9.5 - 1,
    'the same day is worth a full day less lunch when the studio is open');
});

test('a session entirely outside working hours is worth nothing', () => {
  assert.strictEqual(hoursOn(at(DAY2, 20, 0), at(DAY2, 23, 0), DAY2), 0, 'an evening');
  assert.strictEqual(hoursOn(at(DAY2, 5, 0), at(DAY2, 8, 0), DAY2), 0, 'an early morning');
  assert.strictEqual(hoursOn(at(SAT, 10, 0), at(SAT, 17, 0), SAT), 0, 'a Saturday');
});

test('a session that starts before the studio opens counts from 09:30', () => {
  assert.strictEqual(hoursOn(at(DAY2, 9, 0), at(DAY2, 11, 0), DAY2), 1.5,
    '09:00 to 11:00 is counted from 09:30');
  assert.strictEqual(hoursOn(at(DAY2, 17, 0), at(DAY2, 21, 0), DAY2), 2,
    'and one that runs past 19:00 stops there');
});

test('the boundary instants land on the right side', () => {
  /* 18:59:59 AND 19:00:00, 09:29:59 AND 09:30:00, which is where an off-by-one
     in the comparison shows up and nowhere else. */
  assert.strictEqual(
    Math.round(hoursOn(at(DAY2, 18, 59, 59), at(DAY2, 23, 0), DAY2) * 3600), 1,
    'a session beginning at 18:59:59 is worth its one second');
  assert.strictEqual(hoursOn(at(DAY2, 19, 0, 0), at(DAY2, 23, 0), DAY2), 0,
    'one beginning at 19:00:00 is worth nothing');
  assert.strictEqual(
    Math.round(hoursOn(at(DAY2, 5, 0), at(DAY2, 9, 29, 59), DAY2) * 3600), 0,
    'one ending at 09:29:59 is worth nothing');
  assert.strictEqual(
    Math.round(hoursOn(at(DAY2, 5, 0), at(DAY2, 9, 30, 0), DAY2) * 3600), 0,
    'and one ending at 09:30:00 exactly is still nothing — the day has not begun');
  assert.strictEqual(
    Math.round(hoursOn(at(DAY2, 9, 29, 59), at(DAY2, 9, 31), DAY2) * 3600), 60,
    'while 09:29:59 to 09:31 is the minute from 09:30');
});

test('the daily figures sum to the session total exactly, with no rounding drift', () => {
  /* ROUNDED ONCE, AT DISPLAY. The per-day figures come back as milliseconds, so
     a hundred awkward spans cannot accumulate a second between them. */
  const awkward = [
    [at(DAY1, 18, 17, 23), at(DAY2, 10, 41, 7)],
    [at(DAY1, 9, 31, 1), at(DAY2, 18, 59, 59)],
    [at(DAY2, 12, 59, 59), at(DAY2, 14, 0, 1)],
    [at(DAY1, 0, 0, 1), at(MON, 23, 59, 59)],
  ];
  for (const [a, b] of awkward) {
    const byDay = wt.workingMsByDay(a, b, STUDIO);
    const summed = [...byDay.byDay.values()].reduce((n, v) => n + v, 0);
    assert.strictEqual(summed, byDay.total, 'the parts are the whole, in milliseconds');
    assert.strictEqual(Math.round(summed / 1000), wt.workingSecondsBetween(a, b, STUDIO),
      'and agree with what close() stores for the same span');
  }
});

test('the figure is read from the configured schedule, never from a number in the code', () => {
  /* NO HARD-CODED 9:30, 19:00 OR 13:00. The rule is one call to the schedule the
     work-hours logic reads, so changing the studio's hours changes the figure —
     which is asserted here by changing them. */
  const log = fs.readFileSync(path.join(__dirname, '..', 'src', 'work-log.js'), 'utf8');
  const fn = log.slice(log.indexOf('async function dayTotalFor('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/\b(?:570|1140|780|840)\b/.test(body),
    'dayTotalFor holds no clock minute of its own');
  assert.match(body, /workingTime\.workingMsByDay\(from, to, schedule\(\)\)/,
    'it asks the schedule, once');
  assert.ok(!/row\.seconds|Number\(row\.seconds\)/.test(body),
    'and never reads the stored seconds column');

  const shorter = { ...STUDIO, dayEnd: 18 * 60 };
  assert.strictEqual(hoursOn(at(DAY1, 18, 0), at(DAY2, 11, 0), DAY1, shorter), 0,
    'a day ending at 18:00 makes the 18:00 start worth nothing');
  const later = { ...STUDIO, dayStart: 10 * 60 };
  assert.strictEqual(hoursOn(at(DAY1, 18, 0), at(DAY2, 11, 0), DAY2, later), 1,
    'and a day starting at 10:00 makes day 2 one hour');
});

// ===========================================================================
// 2. AGAINST A LIVE SERVER, with the studio's real shape in place.
// ===========================================================================

test('the figure, end to end, against the real schedule', { skip: cfg ? false : SKIP_REASON },
  async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  const ask = async (who, assetId, day, extra = '') => {
    const r = await as(who, `/timesheets/suggest?assetId=${encodeURIComponent(assetId)}`
      + `&date=${day}${extra}`);
    assert.strictEqual(r.status, 200, `${day}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  /* A ROW WRITTEN AS THE SERVER WRITES ONE: `seconds` is what close() stores,
     the open-hours intersection of the span. Computed from the same module the
     server uses rather than typed, so the fixture cannot disagree with it. */
  const stretch = async (assetId, startMs, endMs, { userId = id.ana, seconds = null } = {}) => {
    const secs = seconds === null
      ? wt.workingSecondsBetween(startMs, endMs, STUDIO) : seconds;
    await sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
      + "VALUES (UUID(), ?, ?, 1, ?, ?, ?, 'submitted')",
      [assetId, userId, stamp(startMs), stamp(endMs), secs]);
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'twd', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'twd', name: 'Root', email: 'root@twd.test', password: PASSWORD } });
    tok.root = await login('root@twd.test');

    /* THE EXAMPLE'S OWN STUDIO, put in place rather than assumed: Monday to
       Friday 09:30 to 19:00 with one lunch hour, and no other break — the two
       fifteen-minute breaks the seed ships would make every figure here about
       them instead. */
    await api(server.base, '/branding/schedule', { method: 'PUT', token: tok.root,
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
        dayStart: 9 * 60 + 30, dayEnd: 19 * 60,
        lunchStart: '13:00', lunchEnd: '14:00',
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '' } });
    await setRecordingWindows(server.base, tok.root, [
      { type: 'recording', label: 'Core hours', startTime: '09:30', endTime: '19:00',
        daysOfWeek: [1, 2, 3, 4, 5] },
      { type: 'non_recording', label: 'Lunch', startTime: '13:00', endTime: '14:00' },
    ]);

    const mk = async (who, role, extra = {}) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@twd.test`, role, password: PASSWORD, ...extra } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      tok[who] = await login(`${who}@twd.test`);
      return r.body.user.id;
    };
    id.tl = await mk('tl', 'team_lead');
    id.ana = await mk('ana', 'game_artist', { teamLeadId: id.tl });
    id.bo = await mk('bo', 'game_artist');
    const clients = await as('root', '/clients');
    const pr = await as('root', '/projects', { method: 'POST',
      body: { name: 'Overnight', clientId: clients.body.clients[0].id, teamLeadIds: [id.tl] } });
    id.project = pr.body.project.id;
  });
  t.after(async () => { if (server) await stopServer(server); });

  let n = 0;
  const asset = async (name, who = id.ana) => {
    const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: `${name} ${++n}`, type: 'prop', assigneeId: who } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };

  await t.test('THE CONFIGURED HOURS ARE THE ONES THE EXAMPLE ASSUMES', async () => {
    /* ASSERTED, NOT ASSUMED. If a studio's day does not start at 09:30 or end at
       19:00 the figures below are about a different studio, and the acceptance
       example would be measuring the fixture rather than the rule. */
    const rows = await sql(cfg,
      'SELECT day_start_min AS s, day_end_min AS e, lunch_start_min AS ls, lunch_end_min AS le, '
      + 'working_days AS d FROM work_schedule WHERE id = 1');
    assert.strictEqual(Number(rows[0].s), 570, 'the day starts at 09:30');
    assert.strictEqual(Number(rows[0].e), 1140, 'and ends at 19:00');
    assert.strictEqual(Number(rows[0].ls), 780, 'lunch starts at 13:00');
    assert.strictEqual(Number(rows[0].le), 840, 'and ends at 14:00');
    assert.strictEqual(rows[0].d, '1,2,3,4,5', 'Monday to Friday');
  });

  await t.test('THE ACCEPTANCE EXAMPLE, through the endpoint the form calls', async () => {
    const a = await asset('Started Late Finished Next Morning');
    await stretch(a, at(DAY1, 18, 0), at(DAY2, 11, 0));

    const d1 = await ask('ana', a, DAY1);
    const d2 = await ask('ana', a, DAY2);
    assert.strictEqual(d1.onThisDay, 1, 'day 1 is one hour');
    assert.strictEqual(d1.onThisDayLabel, '1 h', 'and reads as one hour');
    assert.strictEqual(d2.onThisDay, 1.5, 'day 2 is an hour and a half');
    assert.strictEqual(d2.onThisDayLabel, '1 h 30 m', 'and reads as one');
    assert.strictEqual(d1.onThisDay + d2.onThisDay, 2.5, 'and the two are the session');

    /* NOT the three wrong answers. */
    for (const wrong of [17, 6, 11, 2.5]) {
      assert.notStrictEqual(d1.onThisDay, wrong, `day 1 is not ${wrong}`);
    }
    assert.strictEqual(d1.crossing, 1, 'and the form is told the stretch ran outside the day');
  });

  await t.test('THE REGRESSION: the same span with a pre-cutover seconds column', async () => {
    /* THE ROW SHAPE THAT PRODUCED THE REPORT. src/migrate.js says rows written
       before `seconds` became the open-hours intersection hold a different
       figure and were deliberately not backfilled. Apportioning its 17-hour wall
       clock by a 40/60 weighting gave 6.8 h and 10.2 h — measured, on the code
       this replaces. Computed from the stamps, it is 1 h and 1 h 30 m. */
    const a = await asset('A Row From Before The Rule');
    const wall = Math.round((at(DAY2, 11, 0) - at(DAY1, 18, 0)) / 1000);
    assert.strictEqual(wall, 17 * 3600, 'the fixture really is the wall clock');
    await stretch(a, at(DAY1, 18, 0), at(DAY2, 11, 0), { seconds: wall });

    assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 1);
    assert.strictEqual((await ask('ana', a, DAY2)).onThisDay, 1.5);

    /* AND A ROW WHOSE STORED FIGURE IS NONSENSE IS STILL RIGHT, which is the
       general form of the same claim: the column is not read. */
    const b = await asset('Nonsense Seconds');
    await stretch(b, at(DAY1, 18, 0), at(DAY2, 11, 0), { seconds: 999999 });
    assert.strictEqual((await ask('ana', b, DAY1)).onThisDay, 1);
    assert.strictEqual((await ask('ana', b, DAY2)).onThisDay, 1.5);
    const c = await asset('Zero Seconds');
    await stretch(c, at(DAY1, 18, 0), at(DAY2, 11, 0), { seconds: 0 });
    assert.strictEqual((await ask('ana', c, DAY1)).onThisDay, 1);
  });

  await t.test('swept into segments gives the identical answer', async () => {
    /* THE SAME WORK, STORED THE WAY THE SWEEP STORES IT: the evening sweep closed
       it at 19:00 and the overnight resume opened a new row at 09:30. Two rows,
       two rounds, same two figures. */
    const a = await asset('Swept And Resumed');
    await stretch(a, at(DAY1, 18, 0), at(DAY1, 19, 0));
    await sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
      + "VALUES (UUID(), ?, ?, 2, ?, ?, ?, 'submitted')",
      [a, id.ana, stamp(at(DAY2, 9, 30)), stamp(at(DAY2, 11, 0)), 1.5 * 3600]);

    assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 1);
    assert.strictEqual((await ask('ana', a, DAY2)).onThisDay, 1.5);
    assert.strictEqual((await ask('ana', a, DAY1)).crossing, 0,
      'and neither segment ran outside its day');
  });

  await t.test('lunch, a weekend and an outside-hours session, live', async () => {
    const lunch = await asset('Across Lunch');
    await stretch(lunch, at(DAY2, 12, 30), at(DAY2, 14, 30));
    const l = await ask('ana', lunch, DAY2);
    assert.strictEqual(l.onThisDay, 1, '30 m each side of lunch');
    assert.strictEqual(l.onThisDayLabel, '1 h');

    const weekend = await asset('Friday To Monday');
    await stretch(weekend, at(DAY2, 18, 0), at(MON, 11, 0));
    assert.strictEqual((await ask('ana', weekend, DAY2)).onThisDay, 1, 'Friday evening');
    assert.strictEqual((await ask('ana', weekend, SAT)).onThisDay, 0, 'nothing on Saturday');
    assert.strictEqual((await ask('ana', weekend, SUN)).onThisDay, 0, 'nothing on Sunday');
    assert.strictEqual((await ask('ana', weekend, MON)).onThisDay, 1.5, 'Monday morning');

    /* OUTSIDE THE HOURS IS TOLD APART FROM NOTHING RECORDED, because they need
       different answers and the second one reads as the clock having lost
       something. */
    const evening = await asset('An Evening');
    await stretch(evening, at(DAY2, 20, 0), at(DAY2, 23, 0));
    const e = await ask('ana', evening, DAY2);
    assert.strictEqual(e.onThisDay, 0, 'worth nothing');
    assert.strictEqual(e.outside, 1, 'and the form is told why');
    const sat = await ask('ana', weekend, SAT);
    assert.strictEqual(sat.outside, 1, 'a Saturday too');
  });

  await t.test('a holiday counts nothing, and declaring one changes the figure', async () => {
    const a = await asset('Across A Holiday');
    await stretch(a, at(DAY1, 18, 0), at(MON, 11, 0));
    const before = await ask('ana', a, DAY2);
    assert.ok(before.onThisDay > 0, `day 2 is a working day to begin with (${before.onThisDay})`);

    /* THE API DELIBERATELY REFUSES A PAST DATE, and that is a finding rather than
     * an obstacle: src/holidays.js validate() rejects anything before tomorrow,
     * on the stated grounds that "a holiday takes a day out of the schedule, and
     * the schedule is what every session's seconds are measured against — so a
     * holiday dated today or earlier would change what work already done was
     * worth."
     *
     * Which is exactly the protection the WORKING HOURS do not have: the hours
     * can be changed for any day, past included, and this suite asserts that
     * happening three cases below. Reported, and it is the argument for
     * recording the schedule on each closed session.
     *
     * So the row goes in by SQL and the mirror is reloaded through the API's own
     * read, because this case is about the CLIP, not about the holiday form —
     * which has its own suite. */
    await sql(cfg,
      'INSERT INTO studio_holidays (id, holiday_date, name) VALUES (UUID(), ?, ?)',
      [DAY2, 'Studio closed']);
    /* Any write through the holidays routes reloads the in-memory mirror. A
       harmless one — declaring, then removing, a date far in the future. */
    const far = '2099-01-04';
    const bump = await as('root', '/admin/settings/holidays', { method: 'POST',
      body: { date: far, name: 'Mirror reload' } });
    assert.strictEqual(bump.status, 201, JSON.stringify(bump.body));
    try {
      const after = await ask('ana', a, DAY2);
      assert.strictEqual(after.onThisDay, 0, 'the holiday is worth nothing');
      assert.strictEqual(after.outside, 1, 'and the form is told the studio was shut');
      assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 1, 'day 1 is unaffected');
      assert.strictEqual((await ask('ana', a, MON)).onThisDay, 1.5, 'and so is Monday');
    } finally {
      await sql(cfg, 'DELETE FROM studio_holidays WHERE holiday_date IN (?, ?)', [DAY2, far]);
      await as('root', '/admin/settings/holidays', { method: 'POST',
        body: { date: '2099-01-05', name: 'Mirror reload' } });
      await sql(cfg, 'DELETE FROM studio_holidays WHERE holiday_date = ?', ['2099-01-05']);
      await as('root', '/admin/settings/holidays', { method: 'POST', body: { date: '2099-01-06', name: 'r' } });
      await sql(cfg, 'DELETE FROM studio_holidays WHERE holiday_date = ?', ['2099-01-06']);
    }
  });

  await t.test('a day with no sessions is zero, and a future day is zero', async () => {
    const a = await asset('Untouched');
    const empty = await ask('ana', a, DAY1);
    assert.strictEqual(empty.onThisDay, 0);
    assert.strictEqual(empty.onThisDayLabel, '0 m');
    assert.strictEqual(empty.outside, 0, 'nothing touched the day at all');
    const future = await ask('ana', a, '2099-01-01');
    assert.strictEqual(future.onThisDay, 0);
    assert.strictEqual(future.future, true, 'and says it has not happened yet');
  });

  await t.test('a running session counts to now for today, and never past the day', async () => {
    /* THE ONE CASE MEASURED AGAINST THE REAL CLOCK, because a live session is.
     *
     * The studio in this suite is shut outside 09:30–19:00, so a session running
     * NOW is worth whatever the overlap is at this moment — which is nought
     * outside the hours and cannot be asserted as a duration. What CAN be
     * asserted without the clock is the pair of bounds the rule guarantees, and
     * those are the claims: never more than the day's own open time, and nothing
     * at all once the day is over.
     *
     * The overnight case is then pinned with FIXED stamps, which is where the
     * "never past the end of the working day" claim actually bites. */
    const live = await asset('Still Going');
    await sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
      + 'VALUES (UUID(), ?, ?, 1, NOW() - INTERVAL 30 MINUTE, NULL, NULL, NULL)',
      [live, id.ana]);
    const istDay = (offset = 0) => new Date(Date.now() + IST_MS + offset * 86400000)
      .toISOString().slice(0, 10);
    const today = await ask('ana', live, istDay(0));
    assert.ok(today.onThisDay <= 8.5 + 0.01,
      `never more than the day's own open time — got ${today.onThisDay}`);
    assert.ok(today.onThisDay <= 0.5 + 0.01, `and never more than it has run — got ${today.onThisDay}`);
    const past = await ask('ana', live, '2026-03-17');
    assert.strictEqual(past.onThisDay, 0, 'a past day gets nothing from a session running now');

    /* STILL OPEN SINCE DAY 1 AT 18:00 — the sweep never closed it. Day 1 is
       worth its own hour and no more, whatever the clock says now, and that is
       the "never past the end of the working day" claim with fixed stamps. */
    const stuck = await asset('Never Closed');
    await sql(cfg,
      'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason) '
      + 'VALUES (UUID(), ?, ?, 1, ?, NULL, NULL, NULL)',
      [stuck, id.bo, stamp(at(DAY1, 18, 0))]);
    const d1 = await ask('bo', stuck, DAY1);
    assert.strictEqual(d1.onThisDay, 1, '18:00 to 19:00 and no further');
    assert.strictEqual(d1.openCapped, 1, 'and the caller is told the figure was capped');
    assert.strictEqual((await ask('bo', stuck, SAT)).onThisDay, 0,
      'and a Saturday it spans is still nothing');
  });

  await t.test('another person\'s time is excluded, and a lead reads the owner\'s', async () => {
    const shared = await asset('Handed On');
    await stretch(shared, at(DAY1, 18, 0), at(DAY1, 19, 0), { userId: id.ana });
    await stretch(shared, at(DAY1, 15, 0), at(DAY1, 18, 0), { userId: id.bo });

    assert.strictEqual((await ask('ana', shared, DAY1)).onThisDay, 1, 'ana sees her hour');
    assert.strictEqual((await ask('bo', shared, DAY1)).onThisDay, 3, 'bo sees his three');

    /* FILLING ON BEHALF OF SOMEBODY USES THE SHEET OWNER. There is no on-behalf
       WRITE path today — POST /entries always files for the caller — so the
       parameter exists for the read a lead already has, and so that an
       on-behalf write arrives with the figure already right rather than quietly
       the lead's own hours. */
    const onBehalf = await ask('tl', shared, DAY1, `&userId=${id.ana}`);
    assert.strictEqual(onBehalf.onThisDay, 1, 'the lead reading ana\'s sheet sees ana\'s hour');
    const ownSheet = await ask('tl', shared, DAY1);
    assert.strictEqual(ownSheet.onThisDay, 0, 'and their own sheet shows their own nothing');

    /* AND NOT ANYBODY'S. bo does not report to tl and is not readable by ana. */
    const nosy = await as('ana', `/timesheets/suggest?assetId=${encodeURIComponent(shared)}`
      + `&date=${DAY1}&userId=${id.bo}`);
    assert.strictEqual(nosy.status, 403, JSON.stringify(nosy.body));
  });

  await t.test('the save files the day figure, and the days add up', async () => {
    /* THE FORM AND THE SAVE ARE ONE FUNCTION, which is the property that stopped
       a form showing three and a save filing five. Both days filed, and the two
       lines sum to the session. */
    const a = await asset('Filed On Both Days');
    await stretch(a, at(DAY1, 18, 0), at(DAY2, 11, 0));
    const clientId = (await as('root', '/clients')).body.clients[0].id;
    const one = await as('ana', '/timesheets/entries', { method: 'POST',
      body: { date: DAY1, kind: 'project', clientId, projectId: id.project, assetId: a, hours: 99 } });
    assert.strictEqual(one.status, 201, JSON.stringify(one.body));
    assert.strictEqual(Number(one.body.entry.hours), 1, 'the typed 99 is ignored for the day figure');
    const two = await as('ana', '/timesheets/entries', { method: 'POST',
      body: { date: DAY2, kind: 'project', clientId, projectId: id.project, assetId: a, hours: 99 } });
    assert.strictEqual(two.status, 201, JSON.stringify(two.body));
    assert.strictEqual(Number(two.body.entry.hours), 1.5);

    const filed = await sql(cfg,
      'SELECT COALESCE(SUM(hours), 0) AS h FROM timesheet_entries WHERE asset_id = ? AND user_id = ?',
      [a, id.ana]);
    assert.strictEqual(Number(filed[0].h), 2.5, 'and the two lines are the session, exactly');

    // A second line on the same day is refused: all of it is already filed.
    const again = await as('ana', '/timesheets/entries', { method: 'POST',
      body: { date: DAY1, kind: 'project', clientId, projectId: id.project, assetId: a, hours: 1 } });
    assert.strictEqual(again.status, 400, JSON.stringify(again.body));
    assert.match(again.body.error, /already on your timesheet/i);
  });

  await t.test('an awkward span is rounded ONCE, at the end', async () => {
    /* ROUNDING IS A DISPLAY STEP, and this is the case that tells the two apart.
       18:17:23 to 10:41:07 the next morning is 42 m 37 s of day 1 and 71 m 7 s
       of day 2 — neither a whole minute nor a whole hundredth. The figures below
       are the exact overlaps rounded to the two places the column stores:

         day 1   2557 s = 0.710277…h -> 0.71
         day 2   4267 s = 1.185277…h -> 1.19
         whole   6824 s = 1.895555…h -> 1.90

       Round inside the calculation instead — to the nearest minute, say, which
       is the plausible mistake — and day 1 becomes 0.72 and the parts stop being
       the whole. Asserted on both days and on their sum. */
    const a = await asset('Awkward Seconds');
    const start = at(DAY1, 18, 17, 23);
    const end = at(DAY2, 10, 41, 7);
    await stretch(a, start, end);

    const one = await ask('ana', a, DAY1);
    const two = await ask('ana', a, DAY2);
    assert.strictEqual(one.onThisDay, 0.71, 'day 1 is the exact overlap, rounded once');
    assert.strictEqual(two.onThisDay, 1.19, 'and so is day 2');
    assert.strictEqual(one.onThisDayLabel, '43 m');
    assert.strictEqual(two.onThisDayLabel, '1 h 11 m');

    const whole = wt.workingSecondsBetween(start, end, STUDIO);
    assert.strictEqual(whole, 6824, 'the stretch is worth this many working seconds');
    assert.strictEqual(Math.round((one.onThisDay + two.onThisDay) * 100) / 100,
      Math.round((whole / 3600) * 100) / 100,
      'and the days are the stretch, to the place the column keeps');
  });

  await t.test('changing the schedule changes future calculations, as stated', async () => {
    /* THE SCHEDULE KEEPS NO HISTORY — work_schedule is one row and
       recording_hour_configs has no validity dates — so a past day is recomputed
       under whatever the hours are now. That is a consequence rather than a
       choice, and this is it happening: shorten the day and last Thursday is
       worth less. Asserted rather than left in a comment, because somebody will
       otherwise read the README note and wonder whether it is true. */
    const a = await asset('Recomputed Under New Hours');
    await stretch(a, at(DAY1, 18, 0), at(DAY2, 11, 0));
    assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 1, 'one hour, under 09:30–19:00');

    await setRecordingWindows(server.base, tok.root, [
      { type: 'recording', label: 'Shorter', startTime: '09:30', endTime: '18:00',
        daysOfWeek: [1, 2, 3, 4, 5] },
      { type: 'non_recording', label: 'Lunch', startTime: '13:00', endTime: '14:00' },
    ]);
    try {
      assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 0,
        'a day ending at 18:00 makes the same past evening worth nothing');
      assert.strictEqual((await ask('ana', a, DAY2)).onThisDay, 1.5,
        'and the morning is unaffected, because its end did not move');
    } finally {
      await setRecordingWindows(server.base, tok.root, [
        { type: 'recording', label: 'Core hours', startTime: '09:30', endTime: '19:00',
          daysOfWeek: [1, 2, 3, 4, 5] },
        { type: 'non_recording', label: 'Lunch', startTime: '13:00', endTime: '14:00' },
      ]);
    }
    assert.strictEqual((await ask('ana', a, DAY1)).onThisDay, 1, 'and back when the hours are');
  });

  await t.test('the asset\'s own total is still the asset\'s, across everybody', async () => {
    /* THE NUMBER THAT IS CORRECTLY THE WHOLE ASSET'S, left alone. Time Spent,
       the Efficiency report and the P&L are what the asset COST, summed over
       everybody who held it — and that figure has no business in a line about
       one person's day. Asserted so that making the timesheet right cannot be
       mistaken for making this wrong. */
    const shared = await asset('Two People');
    await stretch(shared, at(DAY1, 10, 0), at(DAY1, 12, 0), { userId: id.ana });
    await stretch(shared, at(DAY2, 10, 0), at(DAY2, 12, 0), { userId: id.bo });
    const board = await as('root', `/assets/project/${id.project}`);
    const row = board.body.assets.find((x) => x.id === shared);
    assert.strictEqual(row.time_spent_seconds, 4 * 3600,
      'the asset carries both people\'s four hours');
    assert.strictEqual((await ask('ana', shared, DAY1)).onThisDay, 2,
      'while ana\'s line is worth her two');
  });
});

// ===========================================================================
// 3. THE PAGE: it shows what it is given, and nothing stale.
// ===========================================================================

test('the page prints the server\'s label and does no arithmetic of its own', () => {
  const from = PAGE.indexOf('async function tlSuggest(){');
  const to = PAGE.indexOf('function syncTimesheetLine(){', from);
  assert.ok(from !== -1 && to > from, 'the form\'s lookup is in the page');
  const fn = PAGE.slice(from, to);
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(code, /onThisDayLabel/, 'it prints the label the server built');
  assert.match(code, /&date=\$\{askedFor\}/, 'and sends the date it is on');
  /* NO CLOCK MINUTE, NO DAY ARITHMETIC, NO SCHEDULE. Every one of these would be
     a second copy of the rule, and a second copy is how the figure on screen and
     the figure that gets filed come apart. */
  for (const leak of ['570', '1140', 'dayStart', 'dayEnd', 'lunch', '* 3600', '/ 3600',
    '86400', 'getTimezoneOffset']) {
    assert.ok(!code.includes(leak), `the form must not compute with ${leak}`);
  }

  /* THE STALE GUARD, all three counts — a newer ticket, a changed day, a changed
     asset — plus the server's own echo. */
  assert.match(code, /const ticket = \+\+tlSuggestTicket;/);
  assert.match(code, /if\(ticket !== tlSuggestTicket\) return;/);
  assert.match(code, /if\(askedFor !== tlDay \|\| askedAbout !== document\.getElementById\('tl_asset'\)\.value\) return;/);
  assert.match(code, /if\(s\.date !== askedFor \|\| \(s\.assetId && s\.assetId !== askedAbout\)\) return;/);

  /* AND AN ERROR STATE RATHER THAN A STALE NUMBER. */
  assert.match(code, /Could not read the clock for this asset and day/);
  assert.match(code, /field\.value = '';/, 'the last asset\'s hours are cleared on failure');

  /* OUTSIDE THE HOURS IS ITS OWN SENTENCE. */
  assert.match(code, /none of it fell/, 'a stretch worth nothing says why');
});

test('the form says the schedule keeps no history', () => {
  /* ON THE SCREEN, not only in the README. work_schedule is one row and
     recording_hour_configs has no validity dates, so changing the studio's
     hours changes what past days are worth — and the person reading a figure is
     the person who needs to know that. */
  const help = PAGE.slice(PAGE.indexOf('id="tl_help"'), PAGE.indexOf('id="tl_calc"'));
  assert.match(help, /inside that day's\s*\n?\s*working hours/,
    'it says what the figure is');
  assert.match(help, /Breaks, evenings, weekly offs and holidays are not counted/);
  assert.match(help, /not kept with a history/, 'and the caveat');

  /* AND THE OLD WORDING IS GONE. "ran past midnight" was the previous rule
     describing itself, and midnight is not the boundary. */
  const fn = PAGE.slice(PAGE.indexOf('async function tlSuggest(){'),
    PAGE.indexOf('function syncTimesheetLine(){'));
  assert.ok(!/ran past midnight/.test(fn.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the form no longer tells anybody about midnight');
});

test('one function answers this, and the consumers all call it', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'timesheets.js'), 'utf8');
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /* ONE CALL to the rule, from one gatherer — dayFigure — which both the form's
     endpoint and the save path read. Two call sites computing "the same" figure
     is how a form showing three and a save filing five happened once already. */
  assert.strictEqual((code.match(/workLog\.dayTotalFor\(/g) || []).length, 1,
    'dayTotalFor is called in exactly one place');
  assert.strictEqual((code.match(/dayFigure\(/g) || []).length, 3,
    'and dayFigure is defined once and read by /suggest and hoursFor');
  assert.match(code, /const figure = await dayFigure\(userId, \{ assetId, date \}/,
    '/suggest asks for the sheet owner');
  assert.match(code, /const figure = await dayFigure\(userId, \{ assetId, date \}, \{ exceptId \}\)/,
    'and so does the save');

  /* AND THE WHOLE-ASSET READER IS NOT CALLED FROM THE TIMESHEET AT ALL. */
  assert.ok(!/recordedFor\(/.test(code),
    'the timesheet never reads the asset\'s whole recorded time');
});
