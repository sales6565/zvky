const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');

const cfg = config('timetrack');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('assigned, accepted, timed', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Timer-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const assetRow = async (id, who = 'root') =>
    (await as(who, `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id);
  const timerOf = async (id, who = 'root') => (await as(who, `/assets/${id}/timer`)).body.timer;
  const start = (who, id) => as(who, `/assets/${id}/timer/start`, { method: 'POST' });
  const pauseIt = (who, id) => as(who, `/assets/${id}/timer/pause`, { method: 'POST' });

  async function newAsset(name) {
    const res = await as('pat', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', assigneeId: people.ana },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'timer-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'timer-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', {
      method: 'POST', body: { clientId, name: 'Timed Work' },
    })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['lee', 'team_lead'],
      ['dana', 'art_director'], ['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    for (const artist of ['ana', 'bo']) {
      await as('root', `/users/${people[artist]}`, {
        method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee },
      });
    }
  });

  t.after(() => stopServer(server));

  await t.test('assignment lands in Assigned, not In Progress', async () => {
    const asset = await newAsset('Parked');
    assert.strictEqual(asset.status, 'assigned', 'created with an assignee');

    // And assigning later does the same.
    const bare = (await as('pat', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Bare', type: 'character' },
    })).body.asset;
    assert.strictEqual(bare.status, 'not_started');
    const assigned = await as('pat', `/assets/${bare.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana },
    });
    assert.strictEqual(assigned.body.asset.status, 'assigned');
  });

  await t.test('Accept and Start is the assignee\'s act alone', async () => {
    const asset = await newAsset('Whose Clock');

    assert.strictEqual((await start('pat', asset.id)).status, 403,
      'not the creator — the clock measures the assignee\'s own time');
    assert.strictEqual((await start('lee', asset.id)).status, 403, 'not the reviewer');
    assert.strictEqual((await start('bo', asset.id)).status, 403, 'not another artist');

    const accepted = await start('ana', asset.id);
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(accepted.body.asset.status, 'in_progress');
    assert.strictEqual(accepted.body.timer.running, true);

    // Full access can pause for oversight.
    assert.strictEqual((await pauseIt('root', asset.id)).status, 200);
    assert.strictEqual((await timerOf(asset.id)).running, false);
  });

  await t.test('a second start while running is refused, not doubled', async () => {
    // The double-click, and the same asset open in another tab.
    const asset = await newAsset('One Clock');
    assert.strictEqual((await start('ana', asset.id)).status, 200);

    const again = await start('ana', asset.id);
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.running, true);

    // Exactly one open session exists, whatever was clicked.
    const rows = await sql(cfg,
      `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}' AND ended_at IS NULL`);
    assert.strictEqual(Number(rows[0].n), 1);
    await pauseIt('ana', asset.id);
  });

  await t.test('paused time is not counted; each stretch is its own row', async () => {
    const asset = await newAsset('Stopwatch');
    await start('ana', asset.id);
    await sleep(1100);
    assert.strictEqual((await pauseIt('ana', asset.id)).status, 200);
    const afterFirst = await timerOf(asset.id);
    assert.ok(afterFirst.totalSeconds >= 1, `first stretch counted (${afterFirst.totalSeconds}s)`);
    assert.strictEqual(afterFirst.running, false);

    // The pause itself costs nothing.
    await sleep(1100);
    const stillPaused = await timerOf(asset.id);
    assert.strictEqual(stillPaused.totalSeconds, afterFirst.totalSeconds, 'no clock while paused');

    // Resume is the same start, and pausing a paused clock is a no-op.
    assert.strictEqual((await pauseIt('ana', asset.id)).status, 200, 'idempotent');
    await start('ana', asset.id);
    await sleep(1100);
    await pauseIt('ana', asset.id);
    const afterSecond = await timerOf(asset.id);
    assert.ok(afterSecond.totalSeconds >= afterFirst.totalSeconds + 1, 'the second stretch added on');

    // Two closed rows, each with its own start and end — the auditable log.
    const rows = await sql(cfg,
      `SELECT started_at, ended_at, seconds, round FROM work_sessions WHERE asset_id = '${asset.id}' ORDER BY started_at`);
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.ended_at, 'closed');
      assert.ok(row.seconds >= 1);
      assert.strictEqual(row.round, 1, 'all before the first submission');
    }
  });

  await t.test('submitting stops the clock and finalises the total', async () => {
    const asset = await newAsset('Submitted');
    await start('ana', asset.id);
    await sleep(1100);

    const submitted = await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    assert.strictEqual(submitted.body.asset.status, 'pending_tl_review');

    const timer = await timerOf(asset.id);
    assert.strictEqual(timer.running, false, 'auto-paused by the submit');
    assert.ok(timer.totalSeconds >= 1);

    // Visible on the list row without opening the asset.
    const row = await assetRow(asset.id);
    assert.ok(row.time_spent_seconds >= 1, 'the Assets List can show Time Spent');
    assert.strictEqual(row.timer_running, false);

    // And the clock cannot be run while a reviewer holds it.
    assert.strictEqual((await start('ana', asset.id)).status, 409);
  });

  await t.test('a rework round adds on top, and the breakdown says which round', async () => {
    const asset = await newAsset('Two Rounds');
    await start('ana', asset.id);
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    });
    const round1 = (await timerOf(asset.id)).totalSeconds;

    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });

    // The same cycle again: start (round 2, no status change), work, submit.
    const rework = await start('ana', asset.id);
    assert.strictEqual(rework.status, 200, JSON.stringify(rework.body));
    assert.notStrictEqual(rework.body.accepted, true, 'no accept transition — the status is TL Changes');
    assert.strictEqual((await assetRow(asset.id)).status, 'tl_changes_requested', 'and stays there');
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'Reworked' },
    });

    const timer = await timerOf(asset.id);
    assert.strictEqual(timer.rounds.length, 2, 'one entry per round');
    assert.deepStrictEqual(timer.rounds.map((r) => r.round), [1, 2]);
    assert.strictEqual(timer.rounds[0].seconds, round1, 'round 1 is untouched by round 2');
    assert.ok(timer.rounds[1].seconds >= 1);
    assert.strictEqual(timer.totalSeconds, timer.rounds[0].seconds + timer.rounds[1].seconds,
      'the total is all rounds combined');
  });

  await t.test('CD Changes: no clock until the lead relays the notes', async () => {
    const asset = await newAsset('Relay First');
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First' },
    });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('dana', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Rework the silhouette' },
    });

    const early = await start('ana', asset.id);
    assert.strictEqual(early.status, 409);
    assert.match(early.body.error, /has not passed the Creative Director/);

    await as('lee', `/assets/${asset.id}/relay`, { method: 'POST', body: {} });
    assert.strictEqual((await start('ana', asset.id)).status, 200, 'and then the cycle runs again');
    await pauseIt('ana', asset.id);
  });

  await t.test('the clock never runs outside the working states', async () => {
    const asset = await newAsset('Wrong Moment');
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'Done' },
    });
    for (const [who, action, body] of [
      ['lee', 'review', { decision: 'approved' }],
      ['dana', 'review', { decision: 'approved' }],
      ['root', 'deliver', {}],
    ]) {
      const refused = await start('ana', asset.id);
      assert.strictEqual(refused.status, 409, `no clock in ${(await assetRow(asset.id)).status}`);
      await as(who, `/assets/${asset.id}/${action}`, { method: 'POST', body });
    }
    assert.strictEqual((await start('ana', asset.id)).status, 409, 'nor after delivery');
  });

  await t.test('assets assigned before the Assigned state existed are moved into it', async () => {
    // What a database that predates the Assigned state looks like: under the
    // old rule, assigning moved an asset straight to in_progress, so nothing
    // ever wrote a row that had an assignee and still read not_started. After
    // the upgrade, every such row that did exist sat in the Not Assigned column
    // wearing its assignee's avatar, because nothing re-ran the transition over
    // rows that were already there.
    const stuck = await newAsset('Assigned Long Ago');
    const midPipeline = await newAsset('Already Working');
    await as('ana', `/assets/${midPipeline.id}/accept`, { method: 'POST' });
    const untouched = (await as('pat', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Genuinely Unassigned', type: 'character' },
    })).body.asset;
    assert.strictEqual(untouched.status, 'not_started');

    // Wind the two assigned ones back to what the old schema would have held.
    await sql(cfg, `UPDATE assets SET \`status\` = 'not_started', routed_to_id = NULL
                      WHERE id IN ('${stuck.id}', '${midPipeline.id}')`);

    const migrate = require('../src/migrate');
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db = { query: async (text, params = []) => {
      const ordered = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(sqlText, ordered.length ? ordered : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };
    const messages = [];
    try {
      await migrate.run(db, (m) => messages.push(m));
    } finally {
      await conn.end();
    }

    assert.strictEqual((await assetRow(stuck.id)).status, 'assigned', 'the stuck one was moved');
    assert.strictEqual((await assetRow(midPipeline.id)).status, 'assigned', 'so was the other');
    assert.strictEqual((await assetRow(untouched.id)).status, 'not_started',
      'an asset with nobody on it is genuinely Not Assigned and stays there');
    assert.ok(
      messages.some((m) => /Not Assigned. Moved to Assigned/.test(m)),
      `the repair should say what it did — got: ${messages.join(' | ')}`
    );

    // Running it again finds nothing left to do and says nothing.
    const second = [];
    const conn2 = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db2 = { query: async (text, params = []) => {
      const ordered = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
      const [rows] = await conn2.query(sqlText, ordered.length ? ordered : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };
    try {
      await migrate.run(db2, (m) => second.push(m));
    } finally {
      await conn2.end();
    }
    assert.ok(!second.some((m) => /Moved to Assigned/.test(m)), 'the repair is idempotent');
  });

  await t.test('reassigning mid-round keeps the time already spent', async () => {
    // Total is lifetime effort on the asset, whoever spent it.
    const asset = await newAsset('Handed Over');
    await start('ana', asset.id);
    await sleep(1100);
    await pauseIt('ana', asset.id);
    const before = (await timerOf(asset.id)).totalSeconds;

    await as('pat', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual((await start('ana', asset.id)).status, 403, 'the old assignee lost the clock');
    assert.strictEqual((await start('bo', asset.id)).status, 200, 'the new one has it');
    await pauseIt('bo', asset.id);
    assert.ok((await timerOf(asset.id)).totalSeconds >= before, 'nothing already spent was lost');
  });
});
