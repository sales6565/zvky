/* The timer picks itself up again the next working morning.
 *
 * WHAT CHANGED, AND THAT IT IS A REVERSAL. When the working-hours rule was
 * built, a timer the studio closed around at seven stayed down until somebody
 * pressed Resume. That was a deliberate choice — it avoids crediting the hours
 * between the studio opening and a person actually sitting down — and the
 * studio has since decided the other way: the clock starts again on its own at
 * half past nine the next WORKING morning, and somebody who is not at their
 * desk puts the task on hold.
 *
 * So the thing this file guards is not "does it resume" — that is one line. It
 * is the four ways the world can have changed overnight, each of which means
 * the answer is no, and each of which is asked AT HALF PAST NINE rather than
 * assumed from what was true at seven:
 *
 *   submitted     the status left the set work continues in
 *   reassigned    somebody else holds it now
 *   unassigned    nobody does
 *   busy          they started something else, and the studio's rule is one
 *                 active task
 *
 * AND ONE THAT IS NOT A CHANGE AT ALL: a hold somebody chose is left exactly
 * where they left it. Undoing a person's decision overnight is the difference
 * between a rule and a bug, and the two pauses are one column apart.
 *
 * WHAT ELSE THIS FILE IS CAREFUL ABOUT:
 *
 *   THE CLOCK IS PINNED, NOT WAITED FOR. Every case moves the studio's window
 *      to make "the day has ended" or "the day has begun" true at whatever hour
 *      the suite runs. A test that waited for half past nine would assert
 *      something different every time it ran.
 *
 *   THE STAMP IS THE OPENING, NOT THE TICK. The studio asked for somebody
 *      signing in at eleven to find the morning already counted. That only
 *      works if the resumed session is back-dated, so a sweep that stamped its
 *      own clock would leave an hour and a half missing — and would pass every
 *      assertion that only counted sessions.
 *
 *   IT RUNS WITH NOBODY LOOKING. The resume is proved through a server
 *      RESTART, which is the production path: the sweep runs on a timer and
 *      once at startup, so nothing here depends on a page being open.
 */
const test = require('node:test');
const assert = require('node:assert');

const wt = require('../src/working-time');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('autoresume');

/* The studio's default window, written out so a change to the defaults fails
   loudly here rather than quietly moving what these cases mean. */
const STUDIO = {
  workingDays: [1, 2, 3, 4, 5],
  dayStart: 9 * 60 + 30,
  dayEnd: 19 * 60,
  breaks: [{ start: 13 * 60, end: 14 * 60 }],
};
const ist = (text) => Date.parse(`${text}+05:30`);

// --- where "the next working day" comes from, with no server ----------------

test('the next opening skips the weekend', () => {
  /* Requirement 3, and it needs no new arithmetic: opensAt already answers
     "when does the studio next take work", and it already skips every day that
     is not a working day. This pins that the auto-resume is built on it rather
     than on "tomorrow".
       Fri 18 Sep 2026, Sat 19, Sun 20, Mon 21. */
  const friday7pm = ist('2026-09-18T19:00:00');
  assert.strictEqual(wt.opensAt(friday7pm, STUDIO), ist('2026-09-21T09:30:00'),
    'paused Friday at seven, opens Monday at half past nine — not Saturday');

  const thursday7pm = ist('2026-09-17T19:00:00');
  assert.strictEqual(wt.opensAt(thursday7pm, STUDIO), ist('2026-09-18T09:30:00'),
    'and an ordinary night is the next morning');

  /* A studio that works Saturdays gets Saturday, because this reads the
     configured days rather than a weekend anybody assumed. */
  const sixDays = { ...STUDIO, workingDays: [1, 2, 3, 4, 5, 6] };
  assert.strictEqual(wt.opensAt(friday7pm, sixDays), ist('2026-09-19T09:30:00'));

  /* And a studio closed Monday too skips both. */
  const noMonday = { ...STUDIO, workingDays: [2, 3, 4, 5] };
  assert.strictEqual(wt.opensAt(friday7pm, noMonday), ist('2026-09-22T09:30:00'));
});

test('the studio is shut between the cutoff and the opening, so nothing accrues', () => {
  /* The gap the resume spans, stated as the figure that must come out of it:
     nothing at all between seven on Friday and half past nine on Monday. */
  assert.strictEqual(
    wt.workingSecondsBetween(ist('2026-09-18T19:00:00'), ist('2026-09-21T09:30:00'), STUDIO), 0);
});

test('only the studio\'s own pause is eligible, never a person\'s hold', () => {
  /* Read off the source, because it is one word and the wrong one would make
     the sweep undo a decision somebody made. Every other predicate in
     src/work-log.js asks PAUSE_REASONS — held and off_hours together — and is
     right to; this one must not. */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'work-log.js'), 'utf8');
  const start = src.indexOf('async function resumeOverdue(db) {');
  assert.ok(start > 0, 'the resume sweep is a function of its own');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  assert.match(body, /ended_reason = '\$\{REASONS\.off_hours\}'|ended_reason = '\${REASONS\.off_hours}'/,
    'it asks for the studio\'s pause by name');
  assert.ok(!body.includes('PAUSED_SQL'),
    'and not for the list that also holds a deliberate hold');
  // The four overnight changes, each asked here rather than assumed.
  assert.match(body, /worksIn\(row\.status\)/, 'submitted or moved');
  assert.match(body, /row\.assignee_id !== row\.userId/, 'reassigned or unassigned');
  assert.match(body, /openForUser\(db, row\.userId, row\.assetId\)/, 'one active task');
  assert.match(body, /projectRefusal/, 'and the project is still open');
});

// --- against a live server --------------------------------------------------

test('the overnight resume, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'AutoResume-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* The studio's clock right now, in minutes since midnight IST. Every case
     moves the window relative to this, which is the only way to exercise a
     cutoff and an opening at whatever hour the suite happens to run. */
  const nowMin = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  /* Midnight as an END is the integer, not "24:00" — the form takes a clock
     face and there is no such face, so the endpoint takes minutes for that one
     value. The same reason the all-day window below passes 24 * 60. */
  const endAt = (m) => (m >= 24 * 60 ? 24 * 60 : clock(m));
  const istDow = () => {
    const d = new Date(Date.now() + 330 * 60 * 1000);
    return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  };

  /* THE TIMELINE EVERY CASE BELOW USES, and why it is computed rather than written.
   *
   * Three instants have to be in this order, and the suite runs at whatever
   * hour it runs:
   *
   *     cutoff ......... the studio shut with the timer running   (the pause)
   *     open ........... the studio opened again                  (the resume)
   *     now ............ the sweep runs
   *
   * Settings will not save a window narrower than the Time Sheet's daily cap —
   * "that leaves 7.08 loggable hours a day, and the Time Sheet allows up to 8"
   * — so BOTH windows have to be at least eight hours wide. That rule is about
   * the Time Sheet and nothing to do with what is being tested here, but it is
   * a real rule and working around it by lowering the cap would be testing a
   * studio that cannot exist. So the hours are chosen to satisfy it instead.
   *
   * `open` is an hour before now where the day allows, and never later than
   * 16:00 IST, because eight hours from any later would run past midnight.
   * Everything else follows from it. The whole arrangement needs mid-morning
   * IST or later; earlier than that there is not enough day behind `now` to
   * fit the shut window, and the cases say so rather than asserting nonsense.
   */
  const plan = (breakMins = 0) => {
    const now = nowMin();
    /* Eight LOGGABLE hours, so a break has to be bought on top of them — the
       cap subtracts every break before it checks. */
    const wide = 8 * 60 + breakMins;
    const open = Math.min(now - 60, 24 * 60 - wide);
    return {
      now,
      open,
      openedAgo: now - open,
      cutoff: open - 60,               // the pause, an hour before the opening
      dayEnd: Math.min(open + wide, 24 * 60),
    };
  };
  // Below this there is not enough day behind `now` for an eight-hour shut window.
  const tooEarly = (breakMins = 0) => plan(breakMins).cutoff < 8 * 60;

  /* hoursPerDay is deliberately 1 rather than the studio's 8.
   *
   * Settings refuses a window narrower than the Time Sheet's daily cap — "that
   * leaves 7.08 loggable hours a day, and the Time Sheet allows up to 8" — and
   * several cases below need a window that opened half an hour ago, which is
   * narrower than any real studio day. The cap is a Time Sheet rule and has
   * nothing to do with what is being tested here, so it is lowered out of the
   * way rather than worked around. */
  const setWindow = async ({ days, from, to, lunch = ['', ''], hours = 1 }) => {
    const r = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: {
        hoursPerDay: hours, workingDays: days, dayStart: from, dayEnd: to,
        lunchStart: lunch[0], lunchEnd: lunch[1],
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '',
      },
    });
    assert.ok(r.status < 400, `setting the window: ${JSON.stringify(r.body)}`);
  };
  const allDay = () => setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 24 * 60 });

  const sessions = (assetId) => sql(cfg,
    `SELECT id, started_at, ended_at, seconds, ended_reason,
            TIMESTAMPDIFF(SECOND, started_at, NOW()) AS age
       FROM work_sessions WHERE asset_id = '${assetId}' ORDER BY started_at, id`);
  const workOf = async (assetId, who) => (await as(who, `/assets/${assetId}/worklog`)).body.work;
  const statusOf = async (assetId) => (await as('root', `/assets/${assetId}/history`)).body.status;

  let made = 0;
  const assignedAsset = async (who = 'ana') => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Overnight ${made += 1}`, type: 'prop' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    const patched = await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { assigneeId: id[who] } });
    assert.ok(patched.status < 400, JSON.stringify(patched.body));
    return assetId;
  };

  const backdateStart = (assetId, minutes) => sql(cfg,
    `UPDATE work_sessions SET started_at = started_at - INTERVAL ${minutes} MINUTE
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

  /* Leave nothing running behind us. The one-active-task rule is shared state
     across these cases, so a session left open by a case that FAILED would
     refuse the next case's Accept and Start and report a second failure that
     is not about anything. Closed through the database rather than by
     submitting, so tidying up cannot itself be the thing under test. */
  const clearOpen = (who) => sql(cfg,
    `UPDATE work_sessions SET ended_at = NOW(), seconds = 0, ended_reason = 'submitted'
      WHERE user_id = '${id[who]}' AND ended_at IS NULL`);

  /* Run the sweep the way production runs it: restart the process. The sweep
     fires once at startup precisely so a server that was down overnight comes
     back and does what nobody was there to do, and that is the claim. */
  const restart = async () => {
    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    tok.root = await login('root@zvky.test');
    tok.ana = await login('ana@zvky.test');
    tok.ben = await login('ben@zvky.test');
  };

  /* An asset whose timer the studio put down last night.
   *
   * Built by running the real cutoff — start it, wind the start back, shut the
   * studio behind it, sweep — rather than by writing the row, so what is
   * resumed below is a row the application really makes. */
  const pausedOvernight = async (who = 'ana', breakMins = 0) => {
    const p = plan(breakMins);
    await clearOpen(who);
    await allDay();
    const assetId = await assignedAsset(who);
    const started = await as(who, `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    /* Open since an hour before the cutoff, so an hour of it counted and
       everything after the cutoff did not. */
    await backdateStart(assetId, p.now - p.cutoff + 60);
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: clock(p.cutoff) });
    await restart();
    const rows = await sessions(assetId);
    assert.strictEqual(rows.length, 1, 'one stretch, put down');
    assert.strictEqual(rows[0].ended_reason, 'off_hours', 'by the studio, not the person');
    return assetId;
  };

  /* And now the studio is open again — opened a while ago, so the back-dating
     has something to prove. Returns how long ago that was, because the answer
     depends on the hour the suite is running at and the assertions have to be
     made against the real figure rather than a hoped-for one. */
  const reopen = async ({ lunch } = {}) => {
    const p = plan(lunch ? lunch[1] - lunch[0] : 0);
    await setWindow({
      days: [1, 2, 3, 4, 5, 6, 7], from: clock(p.open), to: endAt(p.dayEnd),
      lunch: lunch ? [clock(p.open + lunch[0]), clock(p.open + lunch[1])] : ['', ''],
    });
    return p.openedAgo;
  };

  t.before(async () => {
    await resetSchema(cfg);
    /* The sweep off between cases, so each one runs it at the moment it means.
       A sweep firing between two assertions would be a second author. */
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
    await make('ben', 'Ben Bhatt', 'ben@zvky.test', 'game_artist');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Nightshift', clientId: clients.body.clients[0].id },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(async () => { await allDay().catch(() => {}); stopServer(server); });

  /* --- 1 and 2: it pauses, and it picks itself up ------------------------- */

  await t.test('a timer the studio put down starts again when the studio opens', async () => {
    /* Needs an hour of the day behind it to shut the studio "an hour ago", and
       room to reopen it ninety minutes ago below. */
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    assert.strictEqual((await workOf(asset, 'ana')).held.byStudio, true, 'down, and the studio did it');

    const openedAgo = await reopen();
    await restart();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 2, 'a second stretch, opened by nobody');
    assert.strictEqual(rows[1].ended_at, null, 'and it is running');
    assert.strictEqual((await workOf(asset, 'ana')).held, null, 'the panel no longer says paused');

    /* THE STAMP IS THE OPENING, NOT THE TICK. The studio opened ninety minutes
       ago and the sweep has only just run; somebody signing in now must find
       the morning counted rather than a minute. Without this the test passes on
       a sweep that stamped NOW() and an hour and a half would be lost. */
    const age = Number(rows[1].age);
    assert.ok(Math.abs(age - openedAgo * 60) < 180,
      `the resumed stretch is stamped ${Math.round(age / 60)} minutes ago; the studio `
      + `opened ${openedAgo} minutes ago. The sweep stamped its own clock rather than the opening.`);

    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
  });

  await t.test('it is the same round, not a new one', async () => {
    /* Resuming is picking the work back up, so the round carries on — which is
       what keeps the two stretches summing into one Time Spent rather than
       reading as two attempts at the asset. */
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    await reopen();
    await restart();
    const rounds = await sql(cfg,
      `SELECT DISTINCT round FROM work_sessions WHERE asset_id = '${asset}'`);
    assert.strictEqual(rounds.length, 1, 'both stretches belong to one round');
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  /* --- 4: submitted overnight --------------------------------------------- */

  await t.test('work submitted before the studio opened does NOT start counting again', async () => {
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    /* Submitted while the studio was shut — which is allowed, and is exactly
       the case that must not go on accruing. */
    const sent = await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v3' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    assert.strictEqual(await statusOf(asset), 'pending_tl_review');

    await reopen();
    await restart();

    const rows = await sessions(asset);
    assert.strictEqual(rows.filter((r) => r.ended_at === null).length, 0,
      'nothing is running on submitted work');
    assert.strictEqual(await statusOf(asset), 'pending_tl_review', 'and it is still submitted');
  });

  /* --- 5: reassigned or unassigned overnight ------------------------------- */

  await t.test('work handed to somebody else does NOT start counting again for the old holder', async () => {
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    const moved = await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.ben } });
    assert.ok(moved.status < 400, JSON.stringify(moved.body));

    await reopen();
    await restart();

    const rows = await sessions(asset);
    const open = rows.filter((r) => r.ended_at === null);
    assert.strictEqual(open.length, 0,
      'no stretch is running — not under Ana, who no longer holds it, and not '
      + 'under Ben, who has not accepted it');
    /* Ben's clock starts when Ben starts it, through Accept and Start, with a
       round of his own. The overnight rule does not reach across an assignment. */
    assert.strictEqual((await workOf(asset, 'ben')).currentSeconds, 0);
  });

  await t.test('work taken off everybody does NOT start counting again', async () => {
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    const off = await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: null } });
    assert.ok(off.status < 400, JSON.stringify(off.body));

    await reopen();
    await restart();
    assert.strictEqual((await sessions(asset)).filter((r) => r.ended_at === null).length, 0);
  });

  /* --- the one-active-task rule -------------------------------------------- */

  await t.test('it does not start a second clock for somebody already working', async () => {
    /* The studio's rule is one active task, and POST /resume refuses by hand
       for exactly this reason. An automatic resume that ignored it would be a
       way around the rule rather than a use of it — and would put two timers
       on one person, which no screen in the application can show. */
    if (tooEarly()) return;
    const paused = await pausedOvernight();

    await reopen();
    // Ana starts something else this morning, by hand.
    const other = await assignedAsset('ana');
    const started = await as('ana', `/assets/${other}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));

    await restart();

    assert.strictEqual((await sessions(paused)).filter((r) => r.ended_at === null).length, 0,
      'last night\'s timer stays down while she is on something else');
    assert.strictEqual((await sessions(other)).filter((r) => r.ended_at === null).length, 1,
      'and the task she actually chose keeps running');
    assert.strictEqual((await workOf(paused, 'ana')).held.byStudio, true,
      'it is still there to be picked up by hand');

    await as('ana', `/assets/${other}/submit`, { method: 'POST', body: { link: 'https://example.com/v4' } });
  });

  /* --- a hold is a decision, and is left alone ----------------------------- */

  await t.test('a task somebody put down by hand is NOT started for them', async () => {
    if (tooEarly()) return;
    await clearOpen('ana');
    await allDay();
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    const held = await as('ana', `/assets/${asset}/hold`, { method: 'POST', body: { note: 'waiting on a brief' } });
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));

    await reopen();
    await restart();

    assert.strictEqual((await sessions(asset)).filter((r) => r.ended_at === null).length, 0,
      'the studio does not undo a decision somebody made');
    const work = await workOf(asset, 'ana');
    assert.strictEqual(work.held.byStudio, false, 'and it still reads as their hold');
    assert.strictEqual(work.held.note, 'waiting on a brief');
  });

  /* --- 6: nobody has the app open ------------------------------------------ */

  await t.test('it happens with nobody signed in, and the person is told', async () => {
    /* The restart above is already the proof that no page is involved — the
       sweep runs in the process, not in a browser. What this adds is the other
       half of the studio's ask: somebody who finds their clock running must be
       able to see that the studio started it, and when. */
    if (tooEarly()) return;
    const before = await sql(cfg,
      `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = '${id.ana}' AND kind = 'work_resumed'`);
    const asset = await pausedOvernight();
    await reopen();
    await restart();

    const after = await sql(cfg,
      `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = '${id.ana}' AND kind = 'work_resumed'`);
    assert.strictEqual(Number(after[0].n), Number(before[0].n) + 1,
      'one notification, raised by the sweep');

    const row = await sql(cfg,
      `SELECT actor_id, asset_id FROM notifications
        WHERE recipient_id = '${id.ana}' AND kind = 'work_resumed'
        ORDER BY seq DESC LIMIT 1`);
    assert.strictEqual(row[0].actor_id, null, 'with no actor, because no person did it');
    assert.strictEqual(row[0].asset_id, asset);

    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v5' } });
  });

  await t.test('the sweep is a label, not a measurement — a late one costs nothing', async () => {
    /* The same claim the pause makes, and it has to hold in both directions or
       a server that was asleep would quietly change the numbers. Two sweeps in
       a row must leave exactly one resumed stretch, with the same stamp. */
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    await reopen();
    await restart();
    const first = await sessions(asset);
    await restart();
    const second = await sessions(asset);

    assert.strictEqual(second.length, first.length, 'the second sweep opened nothing new');
    assert.strictEqual(String(second[1].started_at), String(first[1].started_at),
      'and moved no stamp — compared as text because the driver hands back a '
      + 'fresh Date object each read, and two equal ones are not the same object');
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v6' } });
  });

  /* --- 7: breaks still come out -------------------------------------------- */

  await t.test('breaks are still taken out of what the resumed stretch records', async () => {
    /* The studio's sixth requirement. It needs no new arithmetic — a resumed
       stretch is an ordinary session and close() intersects it with the window
       like any other — but "needs no new code" and "is true" are different
       claims, and this is the one worth having.
       
       Arranged so the stretch spans a break: the studio opened two hours ago
       with a one-hour lunch an hour after that, so of the two hours since,
       one was lunch. */
    if (tooEarly(30)) return;
    const asset = await pausedOvernight('ana', 30);

    /* A lunch break sitting entirely inside the stretch that is about to be
       resumed: it starts ten minutes after the studio opens and runs for half
       an hour, and the resume is back-dated to the opening. So of the minutes
       since, thirty were lunch. */
    const openedAgo = await reopen({ lunch: [10, 40] });
    const expected = (openedAgo - 30) * 60;
    await restart();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 2, 'it resumed');
    /* The live figure, which is the one on the panel — and it must already have
       the break out of it, or the number would drop when the session closed. */
    const live = await workOf(asset, 'ana');
    const resumedSeconds = live.currentSeconds - Number(rows[0].seconds);
    assert.ok(Math.abs(resumedSeconds - expected) < 240,
      `${openedAgo} minutes since the studio opened, 30 of them lunch: expected about `
      + `${openedAgo - 30}, got ${Math.round(resumedSeconds / 60)} minutes`);

    // And the stored figure agrees with the one that was on screen.
    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v7' } });
    const closed = await sessions(asset);
    assert.ok(Math.abs(Number(closed[1].seconds) - expected) < 240,
      `stored ${Math.round(Number(closed[1].seconds) / 60)} minutes; the panel said `
      + `${Math.round(resumedSeconds / 60)}`);
  });

  await t.test('the resume is never stamped earlier than the pause it follows', async () => {
    /* The other end of the clamp, and the one that would double-count.
     *
     * The back-dating reaches back to when the studio opened. If that is all it
     * did, a window WIDENED after the pause would hand the resumed stretch a
     * start before the paused one ended — and the overlap would be counted
     * twice, once in each row, with nothing on screen to show why an asset had
     * gained hours nobody worked.
     *
     * Arranged the way it really happens: a Super Admin widens the day in
     * Settings after a timer has already been put down by the narrower one. */
    if (tooEarly()) return;
    const p = plan();
    await clearOpen('ana');
    await allDay();
    const asset = await assignedAsset();
    await as('ana', `/assets/${asset}/start`, { method: 'POST' });
    await backdateStart(asset, p.now - p.cutoff + 60);
    await setWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: clock(p.cutoff) });
    await restart();
    assert.strictEqual((await sessions(asset))[0].ended_reason, 'off_hours', 'put down');

    // The day now runs from midnight, which is hours before that pause.
    await allDay();
    await restart();

    const rows = await sessions(asset);
    assert.strictEqual(rows.length, 2, 'it resumed');
    const age = Number(rows[1].age);
    const sincePause = (p.now - p.cutoff) * 60;
    assert.ok(Math.abs(age - sincePause) < 180,
      `the resumed stretch is stamped ${Math.round(age / 60)} minutes ago; the pause was `
      + `${p.now - p.cutoff} minutes ago. Back-dating past the pause counts the gap twice.`);

    /* And the arithmetic says the same thing: the two stretches together are
       the time actually worked, not that plus the gap between them. */
    const live = await workOf(asset, 'ana');
    assert.ok(live.currentSeconds <= (p.now - p.cutoff + 60) * 60 + 240,
      `the two stretches sum to ${Math.round(live.currentSeconds / 60)} minutes, which is `
      + 'more than the session has been open at all');

    await as('ana', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'https://example.com/v8' } });
  });

  /* --- the screen says what will happen ------------------------------------ */

  await t.test('a paused task says it will start again on its own', async () => {
    if (tooEarly()) return;
    const asset = await pausedOvernight();
    const held = (await workOf(asset, 'ana')).held;
    assert.strictEqual(held.byStudio, true);
    assert.ok(held.opensAt, 'and says when the studio next opens, so the page can say so');
    assert.ok(new Date(held.opensAt).getTime() > Date.now() - 86400000);
    await allDay();
  });
});
