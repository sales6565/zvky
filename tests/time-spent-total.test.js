/* Time Spent is the whole asset, and you can see what it is made of.
 *
 * WHAT WAS WRONG. The Assets List column read the CURRENT round. An asset that
 * went through TL Feedbacks and was reassigned opened a new round, so the
 * column showed the new round's minutes and the first round's hours appeared to
 * have been lost. Nothing was lost — the hours were in the database, in the
 * P&L, and in a sub-line on the asset panel — but the column was answering a
 * narrower question than its heading asks, and the number went DOWN after a
 * reassignment, which is the shape of a bug whether or not it is one.
 *
 * WHAT IT IS NOW. The asset's whole recorded time, every round summed, computed
 * from the rows each time the list is drawn — there is no stored total to go
 * stale. Beside it, what the sum is made of.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   THE PARTS ADD UP TO THE TOTAL. Asserted as an identity over rows the test
 *      did not choose the arithmetic for, rather than against a hand-worked
 *      number that could be right for the wrong reason.
 *
 *   THREE ROUNDS, NOT TWO. A sum that works for two can be the last round plus
 *      one, and a test with two rounds cannot tell the difference.
 *
 *   THE HISTORY TAB IS NOT A REGRESSION. A row there IS one finished round and
 *      shows that round's own time; the total rides beside it. The two readings
 *      are one function, so the column and the Time Spent FILTER cannot come to
 *      different answers about the same row.
 *
 *   THE BREAKS ARE STILL OUT. Each round's figure is work_sessions.seconds,
 *      which is already clamped to the recording schedule, so summing rounds
 *      cannot put back what the schedule took out. Proved with a round that
 *      straddles a break rather than assumed from the fact that it should.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('timespent');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- what the column reads ---------------------------------------------------

test('the column reads the asset, not the round in front of it', () => {
  /* rowFacts is the one place the cell and the Time Spent filter both read, so
     what it answers here is what both of them show. A live row must be the
     asset's lifetime; a History row is one finished round and says so. */
  const start = PAGE.indexOf('function rowFacts(row){');
  assert.ok(start > 0);
  const body = PAGE.slice(start, PAGE.indexOf('\n}\n', start));
  assert.match(body, /seconds: past \? \(ep\.seconds \|\| 0\) : \(a\.time_spent_seconds \|\| 0\)/,
    'the live row is the asset total — reading ep.seconds there was the bug');
  assert.match(body, /totalSeconds: a\.time_spent_seconds \|\| 0/,
    'and the total is on every row, so a History row can say "of X"');
  assert.match(body, /roundsSpent: Array\.isArray\(a\.rounds_spent\)/);

  // There is no cached total anywhere: the cell reads the payload every draw.
  const cell = PAGE.slice(PAGE.indexOf('function timeSpentCell(f){'));
  assert.ok(!/localStorage|cache/i.test(cell.slice(0, cell.indexOf('\n}'))),
    'nothing is remembered between draws');
});

test('the breakdown is offered on the cell and as plain hover text', () => {
  const cell = PAGE.slice(PAGE.indexOf('function timeSpentCell(f){'));
  const body = cell.slice(0, cell.indexOf('\n}\n'));
  assert.match(body, /Round \$\{r\.round\}: \$\{fmtDuration\(r\.seconds\)\}/,
    'each round, named and timed');
  assert.match(body, /Total: \$\{total\}/, 'and the total, in the same tooltip');
  assert.match(body, /class="ts-more"/, 'with a control that opens the full panel');
  assert.match(body, /of \$\{escapeHTML\(total\)\} in total/,
    'and a History row carries the asset total beside its own round');
});

// --- against a live server ---------------------------------------------------

test('summing the rounds', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'TimeSpent-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  const onBoard = async (assetId) => {
    const r = await as('root', `/assets/project/${projectId}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.assets.find((a) => a.id === assetId);
  };
  const backdate = (assetId, minutes) => sql(cfg,
    `UPDATE work_sessions SET started_at = started_at - INTERVAL ${minutes} MINUTE
      WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

  let made = 0;
  const newAsset = async (who, manHours = 4) => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Rounds ${made += 1}`, type: 'prop', assigneeId: id[who], manHours },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };
  /* One round of work, of a stated length, ending in a submission. */
  const workRound = async (assetId, who, minutes) => {
    assert.strictEqual((await as(who, `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await backdate(assetId, minutes);
    const sent = await as(who, `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: `https://example.com/v${minutes}` } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
  };
  const sendBack = (assetId) => as('lead', `/assets/${assetId}/review`, {
    method: 'POST', body: { decision: 'changes_requested', text: 'again' } });
  const reassign = (assetId, who) => as('lead', `/assets/${assetId}/reassign`, {
    method: 'POST', body: { assigneeId: id[who] } });

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
    /* Hold the studio open, so a round's length is the length this file gave
       it. The break case below sets its own window on purpose. */
    await openStudio(server.base, tok.root);

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.lead);
    await make('ben', 'Ben Bhatt', 'ben@zvky.test', 'game_artist', id.lead);

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Roundhouse', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- 1: two rounds, same user and different user ------------------------- */

  await t.test('a second round adds to the first rather than replacing it', async () => {
    const assetId = await newAsset('ana');
    await workRound(assetId, 'ana', 90);
    const afterOne = await onBoard(assetId);
    assert.strictEqual(afterOne.time_spent_seconds, 90 * 60, 'the first round');

    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ana')).status, 200, 'Reassign to Same User');
    /* The moment that used to read wrong: a new round, nothing in it yet, and
       the column must still show the ninety minutes already spent. */
    const between = await onBoard(assetId);
    assert.strictEqual(between.round_seconds, 0, 'the new round is empty');
    assert.strictEqual(between.time_spent_seconds, 90 * 60,
      'and the column still shows what the asset has cost — this is the bug');

    await workRound(assetId, 'ana', 45);
    const afterTwo = await onBoard(assetId);
    assert.strictEqual(afterTwo.time_spent_seconds, (90 + 45) * 60, 'both rounds');
  });

  /* --- 5: three or more, and a different person --------------------------- */

  await t.test('three rounds, across two people, still sum', async () => {
    const assetId = await newAsset('ana');
    await workRound(assetId, 'ana', 90);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ana')).status, 200);
    await workRound(assetId, 'ana', 45);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ben')).status, 200, 'Reassign to Any User');
    await workRound(assetId, 'ben', 20);

    const a = await onBoard(assetId);
    assert.strictEqual(a.time_spent_seconds, (90 + 45 + 20) * 60,
      'ninety, then forty-five, then twenty — not the last one, and not two of them');
    /* Said again as an identity, because the sum above could be right for the
       wrong reason and this cannot: whatever the parts are, they add to the
       whole. */
    assert.strictEqual(
      a.rounds_spent.reduce((n, r) => n + r.seconds, 0), a.time_spent_seconds,
      'the parts add up to the total');
  });

  /* --- 2: the breakdown says what the parts are ---------------------------- */

  await t.test('the breakdown names each round, its time and who worked it', async () => {
    const assetId = await newAsset('ana');
    await workRound(assetId, 'ana', 60);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ben')).status, 200);
    await workRound(assetId, 'ben', 30);

    const a = await onBoard(assetId);
    assert.deepStrictEqual(
      a.rounds_spent.map((r) => ({ round: r.round, seconds: r.seconds, who: r.who, open: r.open })),
      [
        { round: 1, seconds: 3600, who: 'Ana Artist', open: false },
        { round: 2, seconds: 1800, who: 'Ben Bhatt', open: false },
      ]);

    /* And the asset panel's own breakdown is the same numbers — it is a
       different endpoint, and two breakdowns of one total that disagree is
       worse than having only one. */
    /* Read as root: Ana handed this to Ben, so she is no longer the assignee
       and a contributor sees only their own work. */
    const work = (await as('root', `/assets/${assetId}/worklog`)).body.work;
    assert.deepStrictEqual(work.rounds.map((r) => [r.round, r.seconds]),
      a.rounds_spent.map((r) => [r.round, r.seconds]));
    assert.strictEqual(work.totalSeconds, a.time_spent_seconds);
  });

  await t.test('a round still running is counted, and marked as running', async () => {
    const assetId = await newAsset('ana');
    await workRound(assetId, 'ana', 60);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ana')).status, 200);
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await backdate(assetId, 20);

    const a = await onBoard(assetId);
    const live = a.rounds_spent.find((r) => r.open);
    assert.ok(live, 'the running round is in the breakdown');
    assert.strictEqual(live.round, 2);
    assert.ok(Math.abs(live.seconds - 20 * 60) < 120, 'with the time it has run so far');
    assert.ok(Math.abs(a.time_spent_seconds - 80 * 60) < 120,
      'and the total is the finished round plus the running one');
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v3' } });
  });

  /* --- 3: the schedule is still respected, round by round ------------------ */

  await t.test('a break inside a round is still out of the total', async () => {
    /* Summing rounds must not put back what the recording schedule took out.
       Each round's figure is work_sessions.seconds, which close() has already
       intersected with the window — so this is a check that nothing along the
       way re-derives the number from the stamps. */
    const nowMin = () => {
      const d = new Date(Date.now() + 330 * 60 * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };
    const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // Needs an hour of the day behind it to put a break in the recent past.
    if (nowMin() < 3 * 60) return;

    const assetId = await newAsset('ana');
    await workRound(assetId, 'ana', 60);          // round 1, no break, one hour

    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ana')).status, 200);

    /* Round 2 runs for an hour with a fifteen-minute break in the middle of it.
       The day is left wide so only the break is taken out. */
    const set = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: {
        hoursPerDay: 1, workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: 0, dayEnd: 24 * 60,
        lunchStart: clock(nowMin() - 40), lunchEnd: clock(nowMin() - 25),
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '',
      },
    });
    assert.ok(set.status < 400, JSON.stringify(set.body));
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await backdate(assetId, 60);
    assert.strictEqual((await as('ana', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v2' } })).status, 201);

    const a = await onBoard(assetId);
    const second = a.rounds_spent.find((r) => r.round === 2);
    assert.ok(Math.abs(second.seconds - 45 * 60) < 180,
      `round two ran an hour with fifteen minutes of break in it: expected about 45, `
      + `got ${Math.round(second.seconds / 60)} minutes`);
    assert.ok(Math.abs(a.time_spent_seconds - (60 + 45) * 60) < 180,
      'and the total is an hour plus three quarters, not two hours');
    assert.strictEqual(
      a.rounds_spent.reduce((n, r) => n + r.seconds, 0), a.time_spent_seconds);

    await openStudio(server.base, tok.root);
  });

  /* --- 4: and the same figure reaches the P&L ----------------------------- */

  await t.test('the P&L costs every round, not the last one', async () => {
    const assetId = await newAsset('ana', 4);
    await workRound(assetId, 'ana', 90);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ana')).status, 200);
    await workRound(assetId, 'ana', 45);
    assert.strictEqual((await sendBack(assetId)).status, 200);
    assert.strictEqual((await reassign(assetId, 'ben')).status, 200);
    await workRound(assetId, 'ben', 20);

    // On to Delivered, because the P&L counts finished work.
    assert.strictEqual((await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } })).status, 200);
    assert.strictEqual((await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('root', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } })).status, 200);
    assert.strictEqual((await as('root', `/assets/${assetId}/deliver`, { method: 'POST' })).status, 200);

    await as('root', '/pnl/role-rates/game_artist', { method: 'PUT', body: { ratePerHour: 1000 } });
    const pnl = await as('root', `/pnl/projects/${projectId}`);
    assert.strictEqual(pnl.status, 200, JSON.stringify(pnl.body));

    const a = await onBoard(assetId);
    const expected = a.time_spent_seconds / 3600;
    assert.ok(Math.abs(pnl.body.hours.recordedHours - expected) < 0.02,
      `the P&L records ${pnl.body.hours.recordedHours}h; the Assets List shows `
      + `${expected.toFixed(2)}h. They read the same rows and must agree.`);
    assert.ok(Math.abs(pnl.body.hours.recordedCost - expected * 1000) < 20,
      'and the cost is those hours priced, so it follows the total too');

    /* Both people are on it, which is the other half of "not just the latest
       round": a P&L that took the current assignee's hours would credit Ben
       alone. */
    const people = pnl.body.hours.byRole.flatMap((r) => r.people || []);
    assert.deepStrictEqual([...people].sort(), ['Ana Artist', 'Ben Bhatt']);
  });
});
