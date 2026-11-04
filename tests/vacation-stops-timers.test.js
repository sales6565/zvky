/* PART A OF PROMPT 65: A VACATION PUTS A RUNNING TIMER DOWN.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS REALLY ABOUT: that there is ONE mechanism and not two.
 *
 * The brief asks for the timer to stop "using the SAME mechanism Leave uses",
 * and the reason that wording matters is that a second mechanism would be easy
 * and nearly right. Leave stops a timer through dayStatus.sweepLeave(): it
 * finds everybody inside a leave window at this instant, closes their open
 * work_sessions with reason `on_leave` at `max(sessionStart, windowStart)`, and
 * resumeOverdue() then ignores that reason so nothing comes back on its own. A
 * vacation materialises into ordinary leave rows, so the same function already
 * covers it — and a plausible second implementation (close the session, write
 * `vacation`, stop the clock at `now`) would pass a careless test while
 * recording a different number, resuming at the wrong moment and being
 * invisible to the sweep that has to catch a vacation whose day simply arrived.
 *
 * So several tests here assert the MECHANISM and not only the outcome: the
 * reason written on the closed session, that nothing resumes it, and that the
 * stop is driven by database state rather than by anything held in memory
 * (which is what makes a future vacation work at all, and what makes it survive
 * a restart).
 *
 * THE SWITCH IS ABOUT VACATIONS AND NOT ABOUT LEAVE, which is the one piece of
 * genuinely new logic: a lead marking somebody on leave this afternoon must
 * still stop their timer however the vacation switch is set.
 *
 * AND THE HOURS ARE EXCLUDED EITHER WAY. With the switch off the timer runs on
 * and the leave window is still subtracted from it. A test asserts that,
 * because somebody reading the switch's name could reasonably conclude the
 * opposite.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const DAY_STATUS = fs.readFileSync(path.join(ROOT, 'src', 'day-status.js'), 'utf8');
const LEAVE_ROUTE = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'leave.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const leaveSettings = require('../src/leave-settings');
const workLog = require('../src/work-log');

const cfg = config('vacstoptimers');
const PASSWORD = 'VacTimers-Test-1!';

/* ---- the switch and the floor, as pure values -------------------------- */

test('the two new settings: defaults, and what they are allowed to be', () => {
  /* DEFAULT ON, which is the brief's instruction and the right way round: a
     timer left running through a holiday records nothing anyway, so the only
     thing it can do is mislead somebody looking at a screen. */
  assert.strictEqual(leaveSettings.DEFAULTS.vacationStopTimers, true);

  /* AND THE NOTICE FLOOR IS NOW ZERO WHILE THE DEFAULT IS STILL ONE. Both
     halves matter: zero is what lets somebody start a vacation today, and the
     default being untouched is what makes this change invisible on upgrade. */
  assert.strictEqual(leaveSettings.MIN_NOTICE_FLOOR, 0);
  assert.strictEqual(leaveSettings.DEFAULTS.vacationMinNoticeDays, 1);

  const base = { ...leaveSettings.DEFAULTS, enabled: true,
    firstHalfEndMinutes: 780, secondHalfStartMinutes: 840 };
  for (const [value, ok] of [[0, true], [1, true], [180, true], [-1, false], [181, false]]) {
    const v = leaveSettings.validate({ enabled: true, vacationMinNoticeDays: value },
      { existing: base });
    assert.strictEqual(v.ok, ok, `notice ${value} should be ${ok ? 'accepted' : 'refused'}`);
  }
  for (const value of [true, false]) {
    const v = leaveSettings.validate({ enabled: true, vacationStopTimers: value },
      { existing: base });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.value.vacationStopTimers, value);
  }
  /* IT IS IN THE AUDIT SENTENCE, because a switch that changes what happens to
     somebody's running timer and leaves no trail is a switch nobody can
     account for afterwards. */
  const line = leaveSettings.summarise({ ...base, vacationStopTimers: false },
    { schedule: { dayStart: 540, dayEnd: 1080 } });
  assert.match(line, /vacation stops timers OFF/);
});

/* ---- the mechanism, read off the source -------------------------------- */

test('the stop goes through sweepLeave and writes the leave reason', () => {
  /* ONE CALL SITE SHAPE, ASSERTED AGAINST THE SOURCE. The route must reach the
     stop through dayStatus.sweepLeave and nothing else — not workLog.close
     directly, which would bypass the window arithmetic, and not a reason of its
     own, which would make the pause resumable. */
  assert.match(LEAVE_ROUTE, /dayStatus\.sweepLeave\(db, \{[^}]*at[^}]*userId/,
    'the route calls sweepLeave with a user and a moment');
  assert.ok(!/workLog\.close\(/.test(LEAVE_ROUTE),
    'and never closes a session itself');
  assert.ok(!/'vacation'/.test(LEAVE_ROUTE.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')),
  'no second reason string: the reason is on_leave, written by sweepLeave');

  /* AND sweepLeave STILL WRITES on_leave, which is what keeps resumeOverdue
     away from it. If this ever became a reason of its own, a vacation pause
     would start coming back by itself at the start of the working day. */
  assert.match(DAY_STATUS, /workLog\.close\(db, row\.assetId, 'on_leave'/);
  const resume = DAY_STATUS.slice(DAY_STATUS.indexOf('async function resumeOverdue'));
  assert.ok(!/on_leave/.test(resume.slice(0, 2000)),
    'resumeOverdue does not look at the leave reason, so nothing auto-resumes');
});

test('the page holds no copy of the rule and reaches for no native dialog', () => {
  const block = PAGE.slice(PAGE.indexOf('async function saveVacation()'),
    PAGE.indexOf('async function endVacation('));
  /* THE PAGE COUNTS WHAT IT WAS TOLD AND DECIDES NOTHING. It may not work out
     whether a vacation covers now, which days are working days, or whether the
     switch is on — all three are the server's, and a page that answered any of
     them would be a second rule. */
  for (const forbidden of ['vacationStopTimers', 'istDate', 'loggableDays', 'sweepLeave']) {
    assert.ok(!block.includes(forbidden), `the page does not consult ${forbidden}`);
  }
  assert.match(block, /out\.stoppedTimers/, 'it reads the server\'s own list');
  for (const native of ['alert(', 'confirm(', 'prompt(']) {
    assert.ok(!block.includes(native), `no ${native} in the vacation save path`);
  }
  /* THE DECLINE REASON GOES THROUGH THE PAGE'S OWN ASK DIALOG. */
  const queue = PAGE.slice(PAGE.indexOf('async function decideVacation('));
  assert.match(queue.slice(0, 2000), /openAsk\(\{/);
});

/* ---- end to end --------------------------------------------------------- */

test('a vacation that covers now, end to end', { skip: cfg ? false : SKIP_REASON },
  async (t) => {
    let server;
    const token = {};
    const people = {};
    let projectId;
    let clientId;

    const call = (p, options) => api(server.base, p, options);
    const as = (who, p, options = {}) => call(p, { ...options, token: token[who] });
    const q = (statement, params) => sql(cfg, statement, params);

    const setLeave = async (body) => {
      const res = await as('root', '/admin/settings/leave', { method: 'PUT', body });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };
    /* THE WHOLE SETTINGS BODY EVERY TIME. The PUT replaces the row, so sending
       one field would silently reset the others — the same trap the timesheet
       settings have, and the same answer. */
    const leaveBody = (over = {}) => ({
      enabled: true, vacationEnabled: true, vacationRequireApproval: false,
      vacationMinNoticeDays: 0, vacationMaxRangeDays: 60, vacationEmailEnabled: false,
      vacationStopTimers: true, ...over,
    });
    const newAsset = async (name, assigneeId) => {
      const res = await as('root', `/assets/project/${projectId}`, { method: 'POST',
        body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.asset;
    };
    const startTimer = (who, assetId) =>
      as(who, `/assets/${assetId}/start`, { method: 'POST', body: {} });
    /* `ended_reason` and `seconds` are the column names — not end_reason and
       not counted_seconds, which is what I first wrote and the run corrected. */
    const openSessions = async (userId) => (await q(
      `SELECT id, asset_id AS assetId, ended_at AS endedAt, ended_reason AS reason,
              seconds
         FROM work_sessions WHERE user_id = ? ORDER BY started_at`, [userId]));
    const book = (who, body) => as(who, '/leave/mine', { method: 'POST', body });

    /* ---------------------------------------------------------------------
     * A DATABASE HANDLE FOR THE SWEEPS THIS SUITE DRIVES ITSELF.
     *
     * NOT handle, and tests/day-status.test.js already says why
     * at length — I wrote this suite against src/db first and the run proved
     * the warning: that handle points at TEST_DB_NAME rather than at this
     * suite's own database, so every in-process call failed with "Unknown
     * database". (It also builds a pool that outlives the test and stops
     * node:test exiting.)
     *
     * So: the same $n -> ? translation src/db.js does, over sql(cfg, …), and
     * the same { rows, result } shape the modules expect back. */
    const handle = {
      async query(text, params = []) {
        const values = [];
        const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
          values.push(params[Number(n) - 1]);
          return '?';
        });
        const rows = await sql(cfg, translated, values.length ? values : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      },
    };
    const today = () => require('../src/timesheet-gate').istDate();

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, {
        BOOTSTRAP_TOKEN: 'vac-timers-token',
        /* THE SWEEP IS OFF so every stop in this suite is one this code asked
           for. A sweep ticking in the background would make it impossible to
           tell "the booking stopped it" from "the sweep happened to run". The
           one test that needs the sweep calls it directly. */
        WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      });
      await call('/auth/bootstrap', { method: 'POST', body: {
        token: 'vac-timers-token', name: 'Root', email: 'root@vt.test', password: PASSWORD } });
      const login = async (email) => (await call('/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@vt.test');
      people.root = (await as('root', '/auth/me')).body.user.id;
      await openStudio(server.base, token.root);

      clientId = await systemClientId(server.base, token.root);
      projectId = (await as('root', '/projects', { method: 'POST',
        body: { clientId, name: 'Vacation Timers' } })).body.project.id;

      /* FOUR PEOPLE, AND dee EXISTS BECAUSE OF THE ONE-TIMER RULE. A person may
         have one running session, so the test that leaves Lee's timer running on
         purpose (the switch-off case) makes Lee unusable for any later test that
         needs to start one. Giving the reassignment test its own person is
         cheaper than unpicking somebody else's deliberate state. */
      for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist'],
        ['lee', 'team_lead'], ['dee', 'game_artist']]) {
        const made = await call('/users', { token: token.root, method: 'POST',
          body: { name: who, email: `${who}@vt.test`, role, password: PASSWORD, projectId } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        people[who] = made.body.user.id;
        token[who] = await login(`${who}@vt.test`);
      }
      await setLeave(leaveBody());
    });

    t.after(() => stopServer(server));

    await t.test('notice 0 lets somebody start today, and the timer stops at once',
      async () => {
        const asset = await newAsset('Stops Now', people.ana);
        assert.strictEqual((await startTimer('ana', asset.id)).status, 200);
        const before = await openSessions(people.ana);
        assert.strictEqual(before.filter((r) => !r.endedAt).length, 1, 'it is running');

        const made = await book('ana', { from: today(), to: today() });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        assert.strictEqual(made.body.approvalNeeded, false);

        /* THE ROUTE REPORTS WHAT IT STOPPED, which is what the page shows. */
        assert.strictEqual((made.body.stoppedTimers || []).length, 1,
          JSON.stringify(made.body.stoppedTimers));
        assert.strictEqual(made.body.stoppedTimers[0].assetId, asset.id);

        const after = await openSessions(people.ana);
        assert.strictEqual(after.filter((r) => !r.endedAt).length, 0, 'nothing is running');
        /* THE SAME REASON LEAVE WRITES. This is the assertion that makes it the
           same mechanism rather than a lookalike. */
        assert.strictEqual(after[after.length - 1].reason, 'on_leave');
      });

    await t.test('nothing resumes it, and a vacation day records nothing', async () => {
      /* resumeOverdue() is the function that brings a timer back at the start of
         the working day. It picks up off_hours and only off_hours, so running it
         here must change nothing — which is how "the timer does not auto-resume"
         is true without anybody writing a rule for it. */
      const resumed = await workLog.resumeOverdue(handle);
      assert.deepStrictEqual(resumed, [], 'nothing came back');
      const still = await openSessions(people.ana);
      assert.strictEqual(still.filter((r) => !r.endedAt).length, 0);

      /* AND THE DAY IS WORTH NOTHING. The window covers the whole day, so
         whatever the session's wall-clock span was, the counted time inside a
         vacation day is zero. */
      const row = await q(
        `SELECT seconds FROM work_sessions
          WHERE user_id = ? ORDER BY started_at DESC LIMIT 1`, [people.ana]);
      assert.strictEqual(Number(row[0].seconds), 0,
        'a vacation day counts nothing, which is the leave row doing it');
    });

    await t.test('time worked before the booking stays recorded', async () => {
      /* THE REASON `at` EXISTS. The vacation's window opens at midnight, so a
         sweep would close this session at midnight and throw away the morning.
         The session is backdated by an hour and the booking is made now; the
         hour must survive.

         BACKDATED IN SQL because there is no route that starts a timer in the
         past, and the alternative is a test that waits an hour. */
      await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
        body: { userId: people.bo, date: today(), reason: 'test setup' } }).catch(() => {});
      const asset = await newAsset('Morning Kept', people.bo);
      assert.strictEqual((await startTimer('bo', asset.id)).status, 200);
      await q(
        `UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL 60 MINUTE)
          WHERE user_id = ? AND ended_at IS NULL`, [people.bo]);

      const made = await book('bo', { from: today(), to: today() });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.strictEqual((made.body.stoppedTimers || []).length, 1);

      const row = await q(
        `SELECT seconds,
                TIMESTAMPDIFF(SECOND, started_at, ended_at) AS span
           FROM work_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1`, [people.bo]);
      /* ABOUT AN HOUR, NOT ZERO AND NOT THE WHOLE DAY. Asserted as a range
         because the fixture's own clock moves while it runs; the point is that
         the hour before the booking survived and nothing after it was added. */
      const counted = Number(row[0].seconds);
      assert.ok(counted >= 3540 && counted <= 3660,
        `the hour before the booking is kept, got ${counted}s (span ${row[0].span}s)`);
    });

    await t.test('with the switch off the timer runs on, and the hours are still cut',
      async () => {
        await setLeave(leaveBody({ vacationStopTimers: false }));
        try {
          const asset = await newAsset('Left Running', people.lee);
          assert.strictEqual((await startTimer('lee', asset.id)).status, 200);
          const made = await book('lee', { from: today(), to: today() });
          assert.strictEqual(made.status, 201, JSON.stringify(made.body));
          assert.deepStrictEqual(made.body.stoppedTimers, [],
            'the switch is off, so nothing was put down');
          const open = await openSessions(people.lee);
          assert.strictEqual(open.filter((r) => !r.endedAt).length, 1, 'it is still running');

          /* AND YET THE TIME DOES NOT COUNT. This is the assertion that stops
             somebody reading the switch as "charge the vacation day" — the leave
             window is subtracted from the live figure whatever the switch says,
             because excluding the hours is the leave row's job and not the
             timer's. */
          const live = await workLog.liveLeaveIndex(handle);
          assert.ok((live.get(people.lee) || []).length > 0,
            'the vacation day is a leave window as far as the figures are concerned');
          /* dayTotalFor takes an object and wants the asset too — it answers
             "this person on this asset on this day", which is the figure the
             card shows. */
          const total = await workLog.dayTotalFor(handle,
            { assetId: asset.id, userId: people.lee, day: today() }).catch(() => null);
          assert.ok(total, 'the figure is drawable');
          assert.strictEqual(total.seconds, 0,
            'and it is nothing, because the vacation day is a leave window');
        } finally {
          await setLeave(leaveBody());
        }
      });

    await t.test('ordinary leave still stops a timer however the switch is set',
      async () => {
        /* THE SWITCH IS ABOUT VACATIONS. A lead marking somebody on leave this
           afternoon is a different act with a different source, and it must not
           be governed by a vacation setting. This is the one test that would
           pass with the filter written on the wrong field. */
        await setLeave(leaveBody({ vacationStopTimers: false }));
        try {
          const asset = await newAsset('Hand Marked', people.bo);
          await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
            body: { userId: people.bo, date: today(), reason: 'test' } }).catch(() => {});
          assert.strictEqual((await startTimer('bo', asset.id)).status, 200);
          const marked = await as('root', '/admin-dashboard/follow-up/day-status', {
            method: 'POST',
            body: { userId: people.bo, date: today(), kind: 'leave', portion: 'full' },
          });
          assert.strictEqual(marked.status, 200, JSON.stringify(marked.body));

          /* THE MARK ROUTE ITSELF ALREADY STOPPED IT, which is the thing being
             asserted and which I first got wrong: I expected to find work left
             for a sweep of my own, and there was none because the route calls
             sweepLeave as part of marking somebody on leave. So the assertion
             belongs on the SESSION, not on a second sweep's return value — and
             reading the session is the stronger assertion anyway, because it
             says what was written rather than what was returned. */
          const sessions = await openSessions(people.bo);
          const mine = sessions.filter((r) => r.assetId === asset.id);
          assert.strictEqual(mine.length, 1);
          assert.ok(mine[0].endedAt,
            'hand-marked leave stopped the timer with the vacation switch off');
          assert.strictEqual(mine[0].reason, 'on_leave',
            'and through the same mechanism, with the same reason');
        } finally {
          await setLeave(leaveBody());
          await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
            body: { userId: people.bo, date: today(), reason: 'test cleanup' } }).catch(() => {});
        }
      });

    await t.test('a future vacation stops nothing now, and the sweep stops it on the day',
      async () => {
        /* NO IN-MEMORY TIMER, which is the brief's requirement and the reason
           this works at all after a restart: the stop is decided by reading
           user_day_status at the moment somebody asks. The future case is
           simulated by asking the sweep what it would do AT a time inside the
           vacation — the same `now` the real sweep passes when the day
           arrives — and no state is carried between the two calls. */
        const tomorrow = require('../src/timesheet-gate').shiftDays(today(), 1);
        const asset = await newAsset('Tomorrow', people.ana);
        await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
          body: { userId: people.ana, date: today(), reason: 'test' } }).catch(() => {});
        assert.strictEqual((await startTimer('ana', asset.id)).status, 200);

        const made = await book('ana', { from: tomorrow, to: tomorrow });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        assert.deepStrictEqual(made.body.stoppedTimers, [],
          'a vacation that starts tomorrow stops nothing today');
        assert.strictEqual((await openSessions(people.ana)).filter((r) => !r.endedAt).length, 1);

        /* NOW ASK AS IF IT WERE TOMORROW. Nothing was scheduled and nothing is
           remembered; the day having arrived is the whole trigger. */
        const db = handle;
        const atTomorrow = Date.parse(`${tomorrow}T06:00:00Z`);
        const stopped = await require('../src/day-status')
          .sweepLeave(db, { now: atTomorrow, userId: people.ana });
        assert.strictEqual(stopped.length, 1, 'the day arriving is what stops it');
        assert.strictEqual(stopped[0].assetId, asset.id);
      });

    await t.test('deleting a vacation never starts anything', async () => {
      const asset = await newAsset('No Resume', people.bo);
      await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
        body: { userId: people.bo, date: today(), reason: 'test' } }).catch(() => {});
      assert.strictEqual((await startTimer('bo', asset.id)).status, 200);
      const made = await book('bo', { from: today(), to: today() });
      assert.strictEqual((made.body.stoppedTimers || []).length, 1);

      /* END IT. The days go, the person is working again as far as the rules
         are concerned — and the timer stays down, because starting somebody's
         clock for them is not something a cancellation may do. */
      const ended = await as('bo', `/leave/${made.body.request.id}/cancel`,
        { method: 'POST', body: {} });
      assert.strictEqual(ended.status, 200, JSON.stringify(ended.body));
      const open = await openSessions(people.bo);
      assert.strictEqual(open.filter((r) => !r.endedAt).length, 0,
        'nothing was started on the person\'s behalf');
    });

    await t.test('a reassigned asset\'s new assignee is unaffected', async () => {
      /* THE STOP IS ABOUT A PERSON, NOT AN ASSET. Ana is away; the asset moves
         to Lee; Lee's timer on it runs normally. A stop keyed on the asset
         rather than on the session's user would fail this. */
      const asset = await newAsset('Handed Over', people.ana);
      await as('root', '/admin-dashboard/follow-up/day-status/clear', { method: 'POST',
        body: { userId: people.ana, date: today(), reason: 'test' } }).catch(() => {});
      const made = await book('ana', { from: today(), to: today() });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));

      const moved = await as('root', `/assets/${asset.id}`, { method: 'PATCH',
        body: { assigneeId: people.dee } });
      assert.ok(moved.status === 200 || moved.status === 204, JSON.stringify(moved.body));
      assert.strictEqual((await startTimer('dee', asset.id)).status, 200,
        'the new assignee starts work on it as normal');
      const stopped = await require('../src/day-status')
        .sweepLeave(handle, { userId: people.dee });
      assert.deepStrictEqual(stopped, [],
        'and is not swept up by the vacation of the person who used to have it');
      const open = await openSessions(people.dee);
      assert.strictEqual(open.filter((r) => !r.endedAt).length, 1, 'still running');
    });
  });
