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

  await t.test('a stale status constraint under any name is repaired, not reported fixed', async () => {
    // What a real deployment looked like: the narrow status constraint was
    // under a different name — an older schema, or a table recreated by a
    // hosting panel — so the migration dropped nothing, added a second, wider
    // constraint called chk_assets_status, read that one back and logged
    // success. Both are enforced, so every write landing an asset in 'assigned'
    // still failed, and /api/health said ok.
    const mysql = require('mysql2/promise');
    const open = async () => {
      const conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      });
      return { conn, db: { query: async (text, params = []) => {
        const ordered = [];
        const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
        const [rows] = await conn.query(sqlText, ordered.length ? ordered : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      } } };
    };

    const statusChecks = async () => sql(cfg,
      `SELECT cc.CONSTRAINT_NAME n, cc.CHECK_CLAUSE c
         FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        WHERE tc.TABLE_NAME = 'assets' AND tc.CONSTRAINT_TYPE = 'CHECK'
          AND tc.CONSTRAINT_SCHEMA = DATABASE() AND cc.CHECK_CLAUSE LIKE '%not_started%'`);

    // Park the assigned rows so a narrow constraint can be applied at all,
    // then install one under a name nothing looks for.
    const parked = await sql(cfg, "SELECT id FROM assets WHERE `status` = 'assigned'");
    await sql(cfg, "UPDATE assets SET `status` = 'not_started' WHERE `status` = 'assigned'");
    try { await sql(cfg, 'ALTER TABLE assets DROP CONSTRAINT chk_assets_status'); } catch { /* absent */ }
    await sql(cfg, `ALTER TABLE assets ADD CONSTRAINT legacy_assets_status CHECK (\`status\` IN (
      'not_started','in_progress','pending_tl_review','tl_changes_requested',
      'pending_cd_review','cd_changes_requested','approved_for_client','delivered'))`);
    assert.ok((await statusChecks()).some((c) => c.n === 'legacy_assets_status'), 'the stale one is installed');

    // Health must see it even though it is not called chk_assets_status.
    const schemaCheck = require('../src/schema-check');
    const probe = await open();
    try {
      const gaps = await schemaCheck.gaps(probe.db);
      assert.ok(
        gaps.some((g) => g.kind === 'constraint' && g.name === 'legacy_assets_status'),
        `health should name the stale constraint whatever it is called — got ${JSON.stringify(gaps)}`
      );
    } finally { await probe.conn.end(); }

    // And the migration must drop it, not sit a good one beside it.
    const migrate = require('../src/migrate');
    const runner = await open();
    const messages = [];
    try { await migrate.run(runner.db, (m) => messages.push(m)); } finally { await runner.conn.end(); }

    const after = await statusChecks();
    assert.ok(!after.some((c) => c.n === 'legacy_assets_status'), 'the stale constraint was dropped');
    for (const c of after) {
      assert.ok(String(c.c).includes("'assigned'"),
        `${c.n} still rejects 'assigned': ${c.c}`);
    }
    assert.ok(!messages.some((m) => /\*\*\*/.test(m)), `no loud failure expected — got ${messages.join(' | ')}`);

    // The proof that matters: the write that used to fail now works.
    const asset = await newAsset('After The Repair');
    assert.strictEqual((await assetRow(asset.id)).status, 'assigned');
    for (const p of parked) {
      await sql(cfg, `UPDATE assets SET \`status\` = 'assigned' WHERE id = '${p.id}'`);
    }
  });

  await t.test('an anonymous status constraint is dropped, and a lost table does not block it', async () => {
    // The deployment that produced this: two log lines from one cause.
    //
    //   PATCH /api/assets/... failed: Check constraint 'assets_chk_2' is violated
    //   [schema] work_sessions unavailable (ER_NO_SUCH_TABLE)
    //
    // assets_chk_2 is a name MySQL generates for a CHECK declared without one,
    // so nothing that looked the constraint up by name could find it. And
    // creating work_sessions used to run first inside the same migration step
    // as the constraint repair — so when the table could not be created, the
    // step threw and the repair below it never ran at all.
    const mysql = require('mysql2/promise');
    const open = async () => {
      const conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      });
      return { conn, db: { query: async (text, params = []) => {
        const ordered = [];
        const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
        const [out] = await conn.query(sqlText, ordered.length ? ordered : params);
        return { rows: Array.isArray(out) ? out : [], result: out };
      } } };
    };

    const parked = await sql(cfg, "SELECT id FROM assets WHERE `status` = 'assigned'");
    await sql(cfg, "UPDATE assets SET `status` = 'not_started' WHERE `status` = 'assigned'");
    for (const name of ['chk_assets_status', 'legacy_assets_status']) {
      try { await sql(cfg, `ALTER TABLE assets DROP CONSTRAINT \`${name}\``); } catch { /* absent */ }
    }
    // Declared with no name, so the engine picks one — assets_chk_N.
    await sql(cfg, `ALTER TABLE assets ADD CHECK (\`status\` IN (
      'not_started','in_progress','pending_tl_review','tl_changes_requested',
      'pending_cd_review','cd_changes_requested','approved_for_client','delivered'))`);
    // And the table the step above the repair creates, gone.
    await sql(cfg, 'DROP TABLE IF EXISTS work_sessions');

    const anonymous = (await sql(cfg,
      `SELECT cc.CONSTRAINT_NAME n FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        WHERE tc.TABLE_NAME = 'assets' AND tc.CONSTRAINT_TYPE = 'CHECK'
          AND tc.CONSTRAINT_SCHEMA = DATABASE() AND cc.CHECK_CLAUSE LIKE '%not_started%'`))
      .map((r) => r.n);
    assert.ok(anonymous.length, 'the engine named it for us');
    assert.ok(!anonymous.includes('chk_assets_status'), `and not with our name — got ${anonymous}`);

    // Health must name it even though nothing knows what it is called.
    const schemaCheck = require('../src/schema-check');
    const probe = await open();
    try {
      const gaps = await schemaCheck.gaps(probe.db);
      assert.ok(gaps.some((g) => g.kind === 'constraint' && anonymous.includes(g.name)),
        `health should name the anonymous constraint — got ${JSON.stringify(gaps)}`);
      assert.ok(gaps.some((g) => g.name === 'work_sessions'), 'and the missing table');
    } finally { await probe.conn.end(); }

    const runner = await open();
    const messages = [];
    try { await require('../src/migrate').run(runner.db, (m) => messages.push(m)); }
    finally { await runner.conn.end(); }

    // Both jobs done, neither blocked by the other.
    const after = await sql(cfg,
      `SELECT cc.CONSTRAINT_NAME n, cc.CHECK_CLAUSE c FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        WHERE tc.TABLE_NAME = 'assets' AND tc.CONSTRAINT_TYPE = 'CHECK'
          AND tc.CONSTRAINT_SCHEMA = DATABASE() AND cc.CHECK_CLAUSE LIKE '%not_started%'`);
    for (const c of after) {
      assert.ok(schemaCheck.normalizeCheckClause(c.c).includes("'assigned'"),
        `${c.n} still rejects 'assigned': ${c.c}`);
    }
    const tables = await sql(cfg, "SHOW TABLES LIKE 'work_sessions'");
    assert.strictEqual(tables.length, 1, 'work_sessions was recreated');

    // The write that was failing now works, end to end.
    const asset = await newAsset('After Both Repairs');
    assert.strictEqual((await assetRow(asset.id)).status, 'assigned');
    for (const p of parked) {
      await sql(cfg, `UPDATE assets SET \`status\` = 'assigned' WHERE id = '${p.id}'`);
    }
  });

  await t.test('a create that fails part-way leaves nothing behind', async () => {
    // FX-001's real shape: the asset row was written, the assign transition
    // then failed on a stale constraint, and the default checklist never ran.
    // The request 500'd and left a real asset behind — assigned to somebody,
    // status not_started, no tasks, sitting in the Not Assigned column. The
    // three writes are one transaction now, so a failure leaves no row at all.
    const before = await sql(cfg, 'SELECT COUNT(*) AS n FROM assets');

    // Make the transition fail, the same way a stale constraint does, without
    // touching the constraint every other subtest depends on.
    await sql(cfg, `CREATE TRIGGER refuse_assigned BEFORE UPDATE ON assets FOR EACH ROW
      BEGIN IF NEW.\`status\` = 'assigned' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated stale constraint';
      END IF; END`);
    let res;
    try {
      res = await as('pat', `/assets/project/${projectId}`, {
        method: 'POST', body: { name: 'Doomed Create', type: 'character', assigneeId: people.ana },
      });
    } finally {
      await sql(cfg, 'DROP TRIGGER refuse_assigned');
    }

    assert.strictEqual(res.status, 500, 'the create fails, as it should');
    const after = await sql(cfg, 'SELECT COUNT(*) AS n FROM assets');
    assert.strictEqual(Number(after[0].n), Number(before[0].n),
      'and leaves no half-created asset behind');
    const orphan = await sql(cfg, "SELECT id FROM assets WHERE `name` = 'Doomed Create'");
    assert.strictEqual(orphan.length, 0, 'specifically, not this one');
  });

  await t.test('handing submitted work on: new person, Assigned, a clock at nothing', async () => {
    // The case this exists for. Ana works, submits, and while a reviewer is
    // holding it the lead gives it to Bo — who has done none of it. Bo starts
    // from the beginning, with a clock of their own. Ana's hours and Ana's
    // submission are not discarded; they stay on Ana's now-closed round.
    const asset = await newAsset('Handed In Review');
    await start('ana', asset.id);
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/ana-v1', description: 'Ana first pass' },
    });
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');
    const anaSpent = (await timerOf(asset.id)).currentSeconds;
    assert.ok(anaSpent >= 1, `ana recorded something — got ${anaSpent}`);

    const handed = await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo, note: 'ana is on the trailer' },
    });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));
    assert.strictEqual(handed.body.reassigned.inReview, true);
    assert.strictEqual(handed.body.reassigned.handedOverSeconds, anaSpent,
      'the audit carries the number ana finished on');

    const row = await assetRow(asset.id);
    assert.strictEqual(row.status, 'assigned', 'back to Assigned for the person who has not done it');
    assert.strictEqual(row.assignee_id, people.bo);

    const after = await timerOf(asset.id);
    assert.strictEqual(after.currentSeconds, 0, "bo's clock starts at nothing");
    assert.strictEqual(after.totalSeconds, anaSpent,
      "and ana's hours are still on the asset — not carried into bo's counter, not thrown away");

    // Two rounds on the list, not one overwritten.
    const listed = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(listed.assignments.length, 2, 'one row each');
    const [first, second] = listed.assignments;
    assert.strictEqual(first.userName, 'ana');
    assert.strictEqual(first.active, false);
    assert.strictEqual(first.seconds, anaSpent);
    assert.strictEqual(first.endedStatus, 'pending_tl_review', 'where ana left it');
    assert.deepStrictEqual(first.submissions.map((v) => v.link), ['https://example.test/ana-v1'],
      "ana's submission stays on ana's round");
    assert.strictEqual(second.userName, 'bo');
    assert.strictEqual(second.active, true);
    assert.strictEqual(second.seconds, 0);
    assert.deepStrictEqual(second.submissions, [], 'bo has submitted nothing yet');

    // And the audit says who, from whom, to whom, and on what number.
    const history = (await as('root', `/assets/${asset.id}/history`)).body.events;
    const event = history[history.length - 1];
    assert.strictEqual(event.action, 'reassign_review');
    assert.strictEqual(event.fromStatus, 'pending_tl_review');
    assert.strictEqual(event.toStatus, 'assigned');
    assert.strictEqual(event.actor, 'lee');
    assert.match(event.note, /from ana to bo/);
    assert.match(event.note, /ana is on the trailer/);
    assert.match(event.note, /ana recorded/);

    // Bo can now work it, and their clock is theirs alone.
    assert.strictEqual((await start('bo', asset.id)).status, 200);
    await sleep(1100);
    await pauseIt('bo', asset.id);
    const bosOwn = await timerOf(asset.id);
    assert.ok(bosOwn.currentSeconds >= 1, 'bo accrues');
    assert.ok(bosOwn.currentSeconds < bosOwn.totalSeconds,
      "bo's round is a part of the asset's lifetime, not the whole of it");
  });

  await t.test('the panel dropdown hands work on the same way the button does', async () => {
    // Two controls, one operation. The Hand over button ran the transition and
    // the panel's assignee dropdown did not, so changing the assignee of
    // submitted work through the dropdown left it in TL Review with the new
    // person's name on it — assigned to them, and absent from the Assigned
    // column they were looking in. Both routes must land in the same place.
    const asset = await newAsset('Dropdown Handover');
    await start('ana', asset.id);
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/dd-v1' },
    });
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');
    const anaSpent = (await timerOf(asset.id)).currentSeconds;

    // pat created it, so pat is who the dropdown is offered to.
    const res = await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const row = await assetRow(asset.id);
    assert.strictEqual(row.status, 'assigned',
      'the dropdown moves it to Assigned, exactly as the Hand over button does');
    assert.strictEqual(row.assignee_id, people.bo);

    // And it is a genuinely new round, not a rename of the old one.
    const after = await timerOf(asset.id);
    assert.strictEqual(after.currentSeconds, 0, "bo's clock starts at nothing here too");
    assert.strictEqual(after.totalSeconds, anaSpent, "and ana's hours survive");

    const episodes = await sql(cfg,
      `SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(episodes[0].n), 2, 'two stretches, one each');

    // The trail says the same thing either route was taken.
    const history = (await as('root', `/assets/${asset.id}/history`)).body.events;
    const event = history[history.length - 1];
    assert.strictEqual(event.action, 'reassign_review');
    assert.strictEqual(event.toStatus, 'assigned');
    assert.match(event.note, /from ana to bo/);
    assert.match(event.note, /ana recorded/);

    // The whole point: bo can now find it where they would look.
    const bosBoard = (await as('bo', `/assets/project/${projectId}`)).body.assets
      .filter((a) => a.status === 'assigned' && a.id === asset.id);
    assert.strictEqual(bosBoard.length, 1, 'it is in the new assignee\'s Assigned column');
  });

  await t.test("a new assignee's counter never shows the last person's hours", async () => {
    // What made the Accept and Start button disappear. The panel decides
    // between "Accept and Start" and "Resume" on whether the CURRENT round has
    // any time in it, and that figure fell back to the asset's LIFETIME total
    // whenever there was no assignment episode to read — on a deployment where
    // asset_assignments could not be created, every reassigned asset therefore
    // told its new owner they were mid-session on somebody else's hours.
    const asset = await newAsset('Counter Scope');
    await start('ana', asset.id);
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/cs-v1' },
    });
    const anaSpent = (await timerOf(asset.id)).currentSeconds;
    assert.ok(anaSpent >= 1);

    await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    });

    // With episodes, and — the case that broke — without them.
    const withEpisodes = await timerOf(asset.id);
    assert.strictEqual(withEpisodes.currentSeconds, 0);

    await sql(cfg, `UPDATE work_sessions SET assignment_id = NULL WHERE asset_id = '${asset.id}'`);
    const withoutEpisodes = await timerOf(asset.id);
    assert.strictEqual(withoutEpisodes.currentSeconds, 0,
      "with nothing to scope by, it falls back to the current assignee's own sessions — never to the lifetime");
    assert.strictEqual(withoutEpisodes.totalSeconds, anaSpent, 'the lifetime is still reported, separately');

    // And the list carries the same distinction, which is what the panel reads.
    const listed = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(listed.round_seconds, 0, 'the new owner is at nothing');
    assert.strictEqual(listed.time_spent_seconds, anaSpent, 'the asset is not');
  });

  await t.test('handing work across teams does not refuse the person handing it', async () => {
    // The actor check was re-derived from the asset row AFTER the assignee had
    // been written, so it asked "is this lead in charge of the person receiving
    // it" rather than "of the person handing it over". Within one team both
    // answers agree, which is why it went unnoticed; across teams the handover
    // was refused after the write, rolled back, and reported with a message
    // that made no sense to the lead reading it.
    const otherLead = await call('/users', {
      token: token.root, method: 'POST',
      body: { name: 'mira', email: 'mira@zvky.test', role: 'team_lead', password: PASSWORD, projectId },
    });
    assert.strictEqual(otherLead.status, 201, JSON.stringify(otherLead.body));
    const theirArtist = await call('/users', {
      token: token.root, method: 'POST',
      body: { name: 'nell', email: 'nell@zvky.test', role: 'game_artist', password: PASSWORD,
              projectId, teamLeadId: otherLead.body.user.id },
    });
    assert.strictEqual(theirArtist.status, 201, JSON.stringify(theirArtist.body));

    const asset = await newAsset('Across Teams');
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/at-v1' },
    });
    // lee leads ana, not nell. lee is the reviewer holding it, so lee may hand
    // it on — to anybody assignable on the project.
    const handed = await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: theirArtist.body.user.id },
    });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));
    const row = await assetRow(asset.id);
    assert.strictEqual(row.status, 'assigned');
    assert.strictEqual(row.assignee_id, theirArtist.body.user.id);
  });

  await t.test('an assignee with no team lead does not strand the review gate', async () => {
    // The picker offers everybody assignable on the project, and some of them
    // report to nobody. Work submitted by such a person sat in TL Review with
    // no lead able to approve it and nothing saying why — the review flow just
    // stopped. Where there is no lead to be the gate, any lead who can see the
    // work is.
    const loner = await call('/users', {
      token: token.root, method: 'POST',
      body: { name: 'oona', email: 'oona@zvky.test', role: 'game_artist', password: PASSWORD, projectId },
    });
    assert.strictEqual(loner.status, 201, JSON.stringify(loner.body));
    const loose = await sql(cfg, "SELECT reports_to_id r, team_lead_id t FROM users WHERE email = 'oona@zvky.test'");
    assert.ok(!loose[0].r && !loose[0].t, 'nobody leads them');

    const asset = await newAsset('No Lead');
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/nl-v1' },
    });
    assert.strictEqual((await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: loner.body.user.id },
    })).status, 200);

    const theirToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'oona@zvky.test', password: PASSWORD },
    })).body.token;
    const resubmitted = await call(`/assets/${asset.id}/submit`, {
      token: theirToken, method: 'POST', body: { link: 'https://example.test/nl-v2' },
    });
    assert.strictEqual(resubmitted.status, 201, JSON.stringify(resubmitted.body));
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');

    const approved = await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.strictEqual(approved.status, 200,
      `a lead who can see it must be able to approve it — got ${JSON.stringify(approved.body)}`);
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_cd_review');
  });

  await t.test('the same person getting work back is NOT a new round of assignment', async () => {
    // The older rule, which this must not have broken: changes sent back to
    // whoever submitted them do not change the assignee, so no new stretch
    // begins and their clock keeps climbing.
    const asset = await newAsset('Back To Ana');
    await start('ana', asset.id);
    await sleep(1100);
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/loop-v1' },
    });
    const before = (await timerOf(asset.id)).currentSeconds;

    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });
    assert.strictEqual((await assetRow(asset.id)).assignee_id, people.ana, 'still ana');

    const episodes = await sql(cfg,
      `SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(episodes[0].n), 1, 'one stretch, not two');

    await start('ana', asset.id);
    await sleep(1100);
    await pauseIt('ana', asset.id);
    const after = await timerOf(asset.id);
    assert.ok(after.currentSeconds > before,
      `the same person's clock keeps climbing across the round — ${before} then ${after.currentSeconds}`);
    assert.strictEqual(after.currentSeconds, after.totalSeconds,
      'and with one person on it, the round and the asset are the same hours');
    assert.ok(after.rounds.length > 1, 'the per-round breakdown still separates them');
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
