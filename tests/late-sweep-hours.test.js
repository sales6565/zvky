/* A day's hours do not depend on whether the sweep was running.
 *
 * REPORTED FROM A REAL ASSET. COL-007, started 10:28 and submitted 18:03 on one
 * working day, showed 2h 19m. The studio's own arithmetic against the recording
 * schedule — 09:30-19:00 with breaks at 11:00-11:15, 13:00-14:00 and
 * 16:00-16:15 — is 6h 05m:
 *
 *   10:28-11:00    32m
 *   11:15-13:00  1h 45m
 *   14:00-16:00  2h 00m
 *   16:15-18:03  1h 48m
 *                6h 05m
 *
 * WHAT IT WAS NOT. The arithmetic: workingSecondsBetween(10:28, 18:03) is 365
 * minutes to the second, and each of those four spans comes out exactly. Not
 * the summing either: given those four rows, every reader — the Assets List,
 * the asset panel, the worklog, the P&L — says 6h 05m. Not a display bug: the
 * stored figure and the shown figure were the same number. The rows themselves
 * were wrong.
 *
 * WHAT IT WAS. The sweep stopped running for part of the day — a restart, a
 * deploy, a process that died — and came back after more than one break. Two
 * halves of the same mistake, each throwing away the stretches in between:
 *
 *   PAUSING asked the session when the stretch it BEGAN in ends, and put it
 *      down there. A session open since half past ten, first swept at four,
 *      was stamped as ending at eleven.
 *
 *   RESUMING back-dated to the start of the stretch we are in NOW. A session
 *      paused at eleven and resumed at twenty past four picked up at quarter
 *      past four. Quarter past eleven to one, and two to four, belonged to no
 *      session at all.
 *
 * Together: 32m + 108m = 2h 20m, for a day that was 6h 05m. That is the
 * reported number, within the minute that the replay's own requests take.
 *
 * THE RULE BOTH HALVES NOW OBEY is the one the rest of the sweep was already
 * written around and says so twice: the sweep is a label, not a measurement.
 * Run it every minute or once at the end of the day and the recorded figure is
 * the same, because close() intersects the span with the window and that skips
 * every break and every evening inside it.
 *
 * HOW THE DAY IS REPLAYED. The clock cannot be moved, so the DATA is: at each
 * step the session rows are shifted further into the past and the break windows
 * are re-expressed against the same real "now", so each sweep sees exactly what
 * it would have seen at that boundary. Every sweep is a real server restart,
 * which is the production path.
 */
const test = require('node:test');
const assert = require('node:assert');

const wt = require('../src/working-time');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('latesweep');

// --- the arithmetic, which was never the problem -----------------------------

test('the studio\'s own example, against the pure function', () => {
  const S = {
    workingDays: [1, 2, 3, 4, 5],
    dayStart: 9 * 60 + 30,
    dayEnd: 19 * 60,
    breaks: [
      { start: 11 * 60, end: 11 * 60 + 15 },
      { start: 13 * 60, end: 14 * 60 },
      { start: 16 * 60, end: 16 * 60 + 15 },
    ],
  };
  const ist = (t) => Date.parse(`2026-09-23T${t}+05:30`);
  const mins = (a, b) => wt.workingSecondsBetween(ist(a), ist(b), S) / 60;

  assert.strictEqual(mins('10:28:00', '18:03:00'), 365, '6h 05m for the whole day');
  // And each of the four stretches the schedule breaks it into.
  assert.strictEqual(mins('10:28:00', '11:00:00'), 32);
  assert.strictEqual(mins('11:15:00', '13:00:00'), 105);
  assert.strictEqual(mins('14:00:00', '16:00:00'), 120);
  assert.strictEqual(mins('16:15:00', '18:03:00'), 108);
  assert.strictEqual(32 + 105 + 120 + 108, 365);
});

test('the boundary a late sweep must put an overdue session down at', () => {
  const S = {
    workingDays: [1, 2, 3, 4, 5], dayStart: 9 * 60 + 30, dayEnd: 19 * 60,
    breaks: [{ start: 11 * 60, end: 11 * 60 + 15 }, { start: 13 * 60, end: 14 * 60 },
      { start: 16 * 60, end: 16 * 60 + 15 }],
  };
  const ist = (t) => Date.parse(`${t}+05:30`);
  const at = (t) => wt.lastStoppedAt(ist(t), S);

  assert.strictEqual(at('2026-09-23T11:05:00'), ist('2026-09-23T11:00:00'),
    'swept just after the morning break began: eleven o\'clock');
  assert.strictEqual(at('2026-09-23T13:30:00'), ist('2026-09-23T13:00:00'), 'during lunch: one');
  assert.strictEqual(at('2026-09-23T21:00:00'), ist('2026-09-23T19:00:00'), 'at night: seven');
  assert.strictEqual(at('2026-09-23T09:00:00'), ist('2026-09-22T19:00:00'),
    'before the studio opens: seven the previous working evening');
  assert.strictEqual(at('2026-09-19T11:00:00'), ist('2026-09-18T19:00:00'),
    'on a Saturday: seven on Friday, not a boundary in the weekend');
});

// --- the day itself, replayed through the real sweep ------------------------

test('COL-007\'s day, on time and late', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'LateSweep-Probe-1!';
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
  const clock = (m) => {
    const x = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  };

  /* The three breaks, given as [startedMinutesAgo, endedMinutesAgo]. A negative
     figure is in the future, which is how a break that has only just begun is
     expressed. The day itself is left wide so that ONLY the breaks are out. */
  const setBreaks = async (breaks) => {
    const N = nowMin();
    const slot = (i) => (breaks[i] ? [clock(N - breaks[i][0]), clock(N - breaks[i][1])] : ['', '']);
    const [ms, me] = slot(0); const [ls, le] = slot(1); const [es, ee] = slot(2);
    const r = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: {
        hoursPerDay: 1, workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: 0, dayEnd: 24 * 60,
        morningStart: ms, morningEnd: me, lunchStart: ls, lunchEnd: le, eveningStart: es, eveningEnd: ee,
      },
    });
    assert.ok(r.status < 400, `setting the breaks: ${JSON.stringify(r.body)}`);
  };
  /* Wind every stretch of this asset further into the past, which is how time
     is made to pass without waiting for it. */
  const shift = (assetId, minutes) => sql(cfg,
    `UPDATE work_sessions
        SET started_at = started_at - INTERVAL ${minutes} MINUTE,
            ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ended_at - INTERVAL ${minutes} MINUTE END
      WHERE asset_id = '${assetId}'`);
  const rowsOf = (assetId) => sql(cfg,
    `SELECT seconds, ended_reason FROM work_sessions WHERE asset_id = '${assetId}' ORDER BY started_at`);
  const totalOf = async (assetId) =>
    (await rowsOf(assetId)).reduce((n, r) => n + Number(r.seconds || 0), 0);

  /* One sweep, run the way production runs it. */
  const sweep = async () => {
    await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    tok.root = await login('root@zvky.test');
    tok.sunil = await login('sunil@zvky.test');
  };

  let made = 0;
  const startedAsset = async () => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Quick Hits ${made += 1}`, type: 'prop', assigneeId: id.sunil } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    await setBreaks([]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    return assetId;
  };
  // Free the artist's one active slot between scenarios.
  const settle = () => sql(cfg,
    `UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()), seconds = COALESCE(seconds, 0),
            ended_reason = 'submitted'
      WHERE user_id = '${id.sunil}' AND (ended_at IS NULL OR ended_reason = 'off_hours')`);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('sunil', 'Macharla Venkat Sunil', 'sunil@zvky.test', 'game_artist', id.lead);

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Cherry Crush MN', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- 1: the reported day, swept at every boundary ------------------------ */

  await t.test('swept at every boundary, the day is 6h 05m', async () => {
    await settle();
    const assetId = await startedAsset();

    await shift(assetId, 32);  await setBreaks([[0, -15]]);                       // 11:00
    await sweep();
    await shift(assetId, 15);  await setBreaks([[15, 0]]);                        // 11:15
    await sweep();
    await shift(assetId, 105); await setBreaks([[120, 105], [0, -60]]);           // 13:00
    await sweep();
    await shift(assetId, 60);  await setBreaks([[180, 165], [60, 0]]);            // 14:00
    await sweep();
    await shift(assetId, 120); await setBreaks([[300, 285], [180, 120], [0, -15]]); // 16:00
    await sweep();
    await shift(assetId, 15);  await setBreaks([[315, 300], [195, 135], [15, 0]]);  // 16:15
    await sweep();
    await shift(assetId, 108); await setBreaks([[423, 408], [303, 243], [123, 108]]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);

    const rows = await rowsOf(assetId);
    assert.strictEqual(rows.length, 4, 'four stretches, one per span of the day');
    assert.deepStrictEqual(rows.map((r) => Math.round(r.seconds / 60)), [32, 105, 120, 108]);
    const total = await totalOf(assetId);
    assert.ok(Math.abs(total - 365 * 60) < 120,
      `6h 05m; got ${Math.floor(total / 3600)}h ${Math.round((total % 3600) / 60)}m`);
  });

  /* --- the same day, with the sweep away in the middle of it --------------- */

  await t.test('swept at eleven and not again until twenty past four, still 6h 05m', async () => {
    /* The reported case. The sweep pauses at eleven and the process then goes
       away — a restart, a deploy — coming back after the afternoon break. The
       two stretches in between belonged to no session, and the day read
       2h 20m. */
    await settle();
    const assetId = await startedAsset();

    await shift(assetId, 32); await setBreaks([[0, -15]]);                        // 11:00
    await sweep();
    assert.strictEqual(Math.round((await rowsOf(assetId))[0].seconds / 60), 32,
      'the first stretch is right, and always was');

    // Five hours and twenty minutes with nothing sweeping at all.
    await shift(assetId, 320); await setBreaks([[320, 305], [200, 140], [20, 5]]);  // 16:20
    await sweep();

    await shift(assetId, 103); await setBreaks([[423, 408], [303, 243], [123, 108]]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);

    const total = await totalOf(assetId);
    assert.ok(Math.abs(total - 365 * 60) < 180,
      `the day is 6h 05m however often the sweep ran; got `
      + `${Math.floor(total / 3600)}h ${Math.round((total % 3600) / 60)}m`);
  });

  await t.test('never swept at all until the submission, still 6h 05m', async () => {
    /* The far end of the same argument: no sweep touched this session between
       Accept and Start and Submit. Nothing is ever put down, one stretch spans
       the whole day, and the breaks come out of it because close() intersects
       with the window. */
    await settle();
    const assetId = await startedAsset();
    await shift(assetId, 455);
    await setBreaks([[423, 408], [303, 243], [123, 108]]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);

    const rows = await rowsOf(assetId);
    assert.strictEqual(rows.length, 1, 'one stretch, never interrupted');
    const total = await totalOf(assetId);
    assert.ok(Math.abs(total - 365 * 60) < 120,
      `6h 05m; got ${Math.floor(total / 3600)}h ${Math.round((total % 3600) / 60)}m`);
  });

  await t.test('a session is not put down while recording is happening', async () => {
    /* The pause half of the fix, on its own. A sweep that wakes up inside a
       recordable stretch must leave an open session alone however many
       boundaries it slept through — putting it down at the first one after it
       began is what threw the rest of the day away. */
    await settle();
    const assetId = await startedAsset();
    await shift(assetId, 320);
    // Three breaks behind us, and recording right now.
    await setBreaks([[300, 285], [200, 140], [40, 25]]);
    await sweep();

    const rows = await rowsOf(assetId);
    assert.strictEqual(rows.length, 1, 'no new stretch');
    assert.strictEqual(rows[0].ended_reason, null, 'and the one that was open is still open');

    const board = await as('root', `/assets/project/${projectId}`);
    const a = board.body.assets.find((x) => x.id === assetId);
    // 320 minutes open, 90 of them break: 230 recorded and still running.
    assert.ok(Math.abs(a.time_spent_seconds - 230 * 60) < 180,
      `expected about 230 minutes, got ${Math.round(a.time_spent_seconds / 60)}`);
    assert.strictEqual(a.held, null, 'and it does not read as paused');
  });

  /* --- 2: one break only -------------------------------------------------- */

  await t.test('a session crossing one break only', async () => {
    /* The studio's second step, worked by hand: 10:00 to 11:30 across the
       morning break is 60 + 15 = 1h 15m, not 1h 30m. */
    await settle();
    const assetId = await startedAsset();
    await shift(assetId, 90);
    await setBreaks([[30, 15]]);
    await sweep();
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);

    const total = await totalOf(assetId);
    assert.ok(Math.abs(total - 75 * 60) < 120,
      `ninety minutes less a fifteen-minute break is 1h 15m; got ${Math.round(total / 60)} minutes`);
  });

  /* --- 4 and 5: rounds, and the figures downstream ------------------------ */

  await t.test('a second round adds a second day, and the P&L costs both', async () => {
    await settle();
    const assetId = await startedAsset();
    await shift(assetId, 455);
    await setBreaks([[423, 408], [303, 243], [123, 108]]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);
    assert.strictEqual((await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'again' } })).status, 200);
    assert.strictEqual((await as('lead', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.sunil } })).status, 200);

    // A second round: ninety minutes across one break, as above.
    await setBreaks([]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await sql(cfg,
      `UPDATE work_sessions SET started_at = started_at - INTERVAL 90 MINUTE
        WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
    await setBreaks([[30, 15]]);
    assert.strictEqual((await as('sunil', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v2' } })).status, 201);

    const board = await as('root', `/assets/project/${projectId}`);
    const a = board.body.assets.find((x) => x.id === assetId);
    const byRound = Object.fromEntries(a.rounds_spent.map((r) => [r.round, Math.round(r.seconds / 60)]));
    assert.ok(Math.abs(byRound[1] - 365) < 3, `round one is 6h 05m; got ${byRound[1]} minutes`);
    assert.ok(Math.abs(byRound[2] - 75) < 3, `round two is 1h 15m; got ${byRound[2]} minutes`);
    assert.ok(Math.abs(a.time_spent_seconds - (365 + 75) * 60) < 240,
      'and the column is both of them');
    assert.strictEqual(
      a.rounds_spent.reduce((n, r) => n + r.seconds, 0), a.time_spent_seconds);

    /* On to Delivered, and the P&L must read the same hours. It was
       under-counting for exactly the same reason everything else was: there is
       one column behind all of them. */
    assert.strictEqual((await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } })).status, 200);
    assert.strictEqual((await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('root', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } })).status, 200);
    assert.strictEqual((await as('root', `/assets/${assetId}/deliver`, { method: 'POST' })).status, 200);
    await as('root', '/pnl/role-rates/game_artist', { method: 'PUT', body: { ratePerHour: 1000 } });

    const pnl = await as('root', `/pnl/projects/${projectId}`);
    assert.strictEqual(pnl.status, 200, JSON.stringify(pnl.body));
    const expected = a.time_spent_seconds / 3600;
    assert.ok(Math.abs(pnl.body.hours.recordedHours - expected) < 0.05,
      `the P&L records ${pnl.body.hours.recordedHours}h; the Assets List shows ${expected.toFixed(2)}h`);
    assert.ok(Math.abs(pnl.body.hours.recordedCost - expected * 1000) < 60,
      'and the cost follows the hours');
  });
});
