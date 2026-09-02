const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');

const cfg = config('timetrack');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('assigned, accepted, stamped', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Timer-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const assetRow = async (id, who = 'root') =>
    (await as(who, `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id);
  const workOf = async (id, who = 'root') => (await as(who, `/assets/${id}/worklog`)).body.work;
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });
  const submit = (who, id, link, description) => as(who, `/assets/${id}/submit`, {
    method: 'POST', body: { link, description },
  });
  const sessionsOf = (id) => sql(cfg,
    `SELECT started_at, ended_at, seconds, round, ended_reason
       FROM work_sessions WHERE asset_id = '${id}' ORDER BY started_at, id`);

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
    const asset = await newAsset('Whose Stamp');

    assert.strictEqual((await start('pat', asset.id)).status, 403,
      'not the creator — the stamp is the assignee\'s own');
    assert.strictEqual((await start('lee', asset.id)).status, 403, 'not the reviewer');
    assert.strictEqual((await start('bo', asset.id)).status, 403, 'not another artist');

    const accepted = await start('ana', asset.id);
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(accepted.body.asset.status, 'in_progress');
    assert.strictEqual(accepted.body.work.open, true, 'started and not yet handed in');
    assert.ok(accepted.body.work.startedAt, 'and the moment is recorded');
    assert.strictEqual(accepted.body.work.submittedAt, null, 'with no submit stamp yet');

    // Nothing a person can click ends a stretch on its own. Pause and Resume
    // were removed with the running timer, and the endpoint went with them.
    assert.strictEqual((await as('ana', `/assets/${asset.id}/timer/pause`,
      { method: 'POST' })).status, 404, 'there is no pause to click');
    assert.strictEqual((await as('root', `/assets/${asset.id}/timer/pause`,
      { method: 'POST' })).status, 404, 'not for oversight either');
    assert.strictEqual((await workOf(asset.id)).open, true, 'so the stretch is still open');

    /* And hand it on, which is what this test does not otherwise do. An artist
       may now hold only one task at a time, so a stretch left open here would
       refuse Accept and Start for every test below — in a file about stamps,
       not about that rule. */
    await as('ana', `/assets/${asset.id}/submit`,
      { method: 'POST', body: { link: 'https://example.test/park', description: 'park' } });
  });

  await t.test('a second start is refused, not doubled', async () => {
    // The double-click, and the same asset open in another tab. A second start
    // stamp would silently move the beginning of the round forward and shorten
    // Time Spent, which under wall-clock is the whole measurement.
    const asset = await newAsset('One Stamp');
    const first = await start('ana', asset.id);
    assert.strictEqual(first.status, 200);

    const again = await start('ana', asset.id);
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.open, true);
    assert.ok(again.body.since, 'and says when the one that is open began');

    // Exactly one open session exists, whatever was clicked, and its start
    // stamp is the first one.
    const rows = await sessionsOf(asset.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ended_at, null);
    assert.strictEqual(new Date(rows[0].started_at).toISOString(),
      new Date(first.body.work.startedAt).toISOString(), 'the original start, not a later one');

    // Released for the same reason as above: one open task at a time.
    await as('ana', `/assets/${asset.id}/submit`,
      { method: 'POST', body: { link: 'https://example.test/one-stamp', description: 'park' } });
  });

  await t.test('one round is one row: the two stamps and the gap between them', async () => {
    // The definition the studio chose. A round is the wall-clock span from
    // Accept and Start to Submit for Review — one row, two stamps, and Time
    // Spent is their difference. Nothing subtracts breaks from it, because
    // nothing records breaks any more.
    const asset = await newAsset('Two Stamps');
    const started = await start('ana', asset.id);
    assert.ok(started.body.work.startedAt);
    await sleep(2100);

    const submitted = await submit('ana', asset.id, 'https://example.test/gap', 'First pass');
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));

    const rows = await sessionsOf(asset.id);
    assert.strictEqual(rows.length, 1, 'one round, one row — there is nothing left that splits it');
    const [row] = rows;
    assert.ok(row.ended_at, 'closed by the submission');
    assert.strictEqual(row.round, 1);
    assert.strictEqual(row.ended_reason, 'submitted', 'and says what closed it');

    // The stored figure is exactly the gap, not an accumulation of stretches.
    const elapsed = Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000);
    assert.strictEqual(row.seconds, elapsed,
      `Time Spent is submittedAt - startedAt — stored ${row.seconds}s against a ${elapsed}s gap`);
    assert.ok(row.seconds >= 2, `and the wait is in it (${row.seconds}s)`);

    // The same two stamps come back through the API.
    const work = await workOf(asset.id);
    assert.strictEqual(work.open, false);
    assert.strictEqual(new Date(work.startedAt).toISOString(), new Date(row.started_at).toISOString());
    assert.strictEqual(new Date(work.submittedAt).toISOString(), new Date(row.ended_at).toISOString());
    assert.strictEqual(work.totalSeconds, row.seconds);
  });

  await t.test('submitting stamps the end and finalises the total', async () => {
    const asset = await newAsset('Submitted');
    await start('ana', asset.id);
    await sleep(1100);

    const submitted = await submit('ana', asset.id, 'https://example.test/v1', 'First pass');
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    assert.strictEqual(submitted.body.asset.status, 'pending_tl_review');

    const work = await workOf(asset.id);
    assert.strictEqual(work.open, false, 'closed by the submit');
    assert.ok(work.submittedAt, 'with the moment it was handed in');
    assert.ok(work.totalSeconds >= 1);

    // Visible on the list row without opening the asset — the figure and both
    // stamps, so somebody reading a long Time Spent can see what it spans.
    const row = await assetRow(asset.id);
    assert.ok(row.time_spent_seconds >= 1, 'the Assets List can show Time Spent');
    assert.strictEqual(row.work_open, false);
    assert.ok(row.started_at, 'and when it started');
    assert.ok(row.submitted_at, 'and when it was handed in');

    // And work cannot be started again while a reviewer holds it.
    assert.strictEqual((await start('ana', asset.id)).status, 409);
  });

  await t.test('a rework round adds on top, and the breakdown says which round', async () => {
    const asset = await newAsset('Two Rounds');
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/v1', 'First pass');
    const round1 = (await workOf(asset.id)).totalSeconds;

    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });

    // The same cycle again: start (round 2, no status change), work, submit.
    const rework = await start('ana', asset.id);
    assert.strictEqual(rework.status, 200, JSON.stringify(rework.body));
    assert.notStrictEqual(rework.body.accepted, true, 'no accept transition — the status is TL Feedbacks');
    assert.strictEqual((await assetRow(asset.id)).status, 'tl_changes_requested', 'and stays there');
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/v2', 'Reworked');

    const work = await workOf(asset.id);
    assert.strictEqual(work.rounds.length, 2, 'one entry per round');
    assert.deepStrictEqual(work.rounds.map((r) => r.round), [1, 2]);
    assert.strictEqual(work.rounds[0].seconds, round1, 'round 1 is untouched by round 2');
    assert.ok(work.rounds[1].seconds >= 1);
    assert.strictEqual(work.totalSeconds, work.rounds[0].seconds + work.rounds[1].seconds,
      'the total is all rounds combined');

    // Each round carries its own pair of stamps, and the second begins after
    // the first ended — a rework loop is a new span, not an extension.
    for (const r of work.rounds) {
      assert.ok(r.startedAt && r.submittedAt, `round ${r.round} has both stamps`);
      assert.strictEqual(r.open, false);
    }
    assert.ok(new Date(work.rounds[1].startedAt) >= new Date(work.rounds[0].submittedAt),
      'round 2 starts no earlier than round 1 was handed in');
    const closes = (await sessionsOf(asset.id)).map((r) => r.ended_reason);
    assert.deepStrictEqual(closes, ['submitted', 'submitted']);
  });

  await t.test('CD Feedbacks: no start until the lead relays the notes', async () => {
    const asset = await newAsset('Relay First');
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
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
    assert.strictEqual((await submit('ana', asset.id, 'https://example.test/relay-v2')).status, 201);
  });

  await t.test('work cannot be started outside the working states', async () => {
    const asset = await newAsset('Wrong Moment');
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'Done' },
    });
    for (const [who, action, body] of [
      ['lee', 'review', { decision: 'approved' }],
      ['dana', 'review', { decision: 'approved' }],
      ['root', 'deliver', {}],
    ]) {
      const refused = await start('ana', asset.id);
      assert.strictEqual(refused.status, 409, `no start in ${(await assetRow(asset.id)).status}`);
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

  await t.test('handing submitted work on: new person, Assigned, a fresh start stamp', async () => {
    // The case this exists for. Ana works, submits, and while a reviewer is
    // holding it the lead gives it to Bo — who has done none of it. Bo starts
    // from the beginning, with a start stamp of their own recorded when they
    // click Accept and Start. Ana's hours and Ana's submission are not
    // discarded; they stay on Ana's now-closed round.
    const asset = await newAsset('Handed In Review');
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/ana-v1', 'Ana first pass');
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');
    const anaSpent = (await workOf(asset.id)).currentSeconds;
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

    const after = await workOf(asset.id);
    assert.strictEqual(after.currentSeconds, 0, "bo has recorded nothing yet");
    assert.strictEqual(after.startedAt, null, 'and has no start stamp until they accept');
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

    // Bo can now work it, and the stamp that opens their stretch is their own.
    const bosStart = await start('bo', asset.id);
    assert.strictEqual(bosStart.status, 200);
    assert.ok(bosStart.body.work.startedAt, "bo's own start stamp, recorded on their click");
    await sleep(1100);
    await submit('bo', asset.id, 'https://example.test/bo-v1');
    const bosOwn = await workOf(asset.id);
    assert.ok(bosOwn.currentSeconds >= 1, 'bo accrues');
    assert.ok(bosOwn.currentSeconds < bosOwn.totalSeconds,
      "bo's round is a part of the asset's lifetime, not the whole of it");

    // Ana's stretch was closed by the hand-over, not by anything ana did.
    const closes = (await sessionsOf(asset.id)).map((r) => r.ended_reason);
    assert.deepStrictEqual(closes, ['submitted', 'submitted'],
      "ana's was already closed by her submission before the hand-over reached it");
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
    await submit('ana', asset.id, 'https://example.test/dd-v1');
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');
    const anaSpent = (await workOf(asset.id)).currentSeconds;

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
    const after = await workOf(asset.id);
    assert.strictEqual(after.currentSeconds, 0, 'bo has recorded nothing here either');
    assert.strictEqual(after.startedAt, null, 'and has no start stamp yet');
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
    // whether to offer Accept and Start on whether the CURRENT round has
    // any time in it, and that figure fell back to the asset's LIFETIME total
    // whenever there was no assignment episode to read — on a deployment where
    // asset_assignments could not be created, every reassigned asset therefore
    // told its new owner they were mid-session on somebody else's hours.
    const asset = await newAsset('Counter Scope');
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/cs-v1');
    const anaSpent = (await workOf(asset.id)).currentSeconds;
    assert.ok(anaSpent >= 1);

    await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    });

    // With episodes, and — the case that broke — without them.
    const withEpisodes = await workOf(asset.id);
    assert.strictEqual(withEpisodes.currentSeconds, 0);

    await sql(cfg, `UPDATE work_sessions SET assignment_id = NULL WHERE asset_id = '${asset.id}'`);
    const withoutEpisodes = await workOf(asset.id);
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
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
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
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/nl-v1' },
    });
    assert.strictEqual((await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: loner.body.user.id },
    })).status, 200);

    const theirToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'oona@zvky.test', password: PASSWORD },
    })).body.token;
    await call(`/assets/${asset.id}/start`, { token: theirToken, method: 'POST' });
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

  await t.test('work cannot be handed in before it has been started', async () => {
    // An asset in Assigned is one nobody has picked up. Submitting from there
    // recorded a round nobody worked, so it is refused — and the refusal says
    // what to do, because this is one a person meets in normal use.
    const asset = await newAsset('Not Started Yet');
    assert.strictEqual((await assetRow(asset.id)).status, 'assigned');

    const early = await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/too-soon' },
    });
    assert.strictEqual(early.status, 409, 'the API refuses it, not just the button');
    assert.match(early.body.error, /Start the work before submitting it/);
    assert.strictEqual((await assetRow(asset.id)).status, 'assigned', 'and nothing moved');

    // Accept and Start, then it goes.
    assert.strictEqual((await start('ana', asset.id)).status, 200);
    assert.strictEqual((await assetRow(asset.id)).status, 'in_progress');
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/now-ok' },
    })).status, 201);
    assert.strictEqual((await assetRow(asset.id)).status, 'pending_tl_review');
  });

  await t.test('one Accept and Start is enough — nothing can take it back', async () => {
    // Accepting is what unlocks submitting. There is nothing left that could
    // undo it: the stretch stays open from the click to the submission, and
    // the only endpoint that used to close one early is gone.
    const asset = await newAsset('Left Open Midway');
    await start('ana', asset.id);
    await sleep(1100);
    assert.strictEqual((await assetRow(asset.id)).status, 'in_progress');
    assert.strictEqual((await workOf(asset.id)).open, true, 'still open, hours later or minutes');

    // A second click changes nothing, and refusing it is not a state change.
    assert.strictEqual((await start('ana', asset.id)).status, 409);
    assert.strictEqual((await assetRow(asset.id)).status, 'in_progress', 'still In Progress');

    assert.strictEqual((await submit('ana', asset.id, 'https://example.test/left-open')).status, 201,
      'and it can be handed in');
  });

  await t.test('a reassigned asset makes its new owner start it too', async () => {
    // Handing work on returns it to Assigned, so the rule applies to whoever
    // takes it — consistent with their clock beginning at nothing.
    const asset = await newAsset('Handed Then Submitted');
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/ana-v1');
    await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    });
    assert.strictEqual((await assetRow(asset.id)).status, 'assigned');

    const early = await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/bo-too-soon' },
    });
    assert.strictEqual(early.status, 409, 'the new owner starts from the beginning too');
    assert.match(early.body.error, /Start the work before submitting it/);

    const bosStart = await start('bo', asset.id);
    assert.strictEqual(bosStart.status, 200);
    assert.ok(bosStart.body.work.startedAt, 'a fresh start stamp, recorded on their click');
    assert.strictEqual((await workOf(asset.id)).currentSeconds, 0, 'their round begins at nothing');
    assert.strictEqual((await submit('bo', asset.id, 'https://example.test/bo-v1')).status, 201);
  });

  await t.test('a rework round needs no second acceptance', async () => {
    // There is no accept step out of a change request — the work is already
    // underway. Requiring one would strand every round after the first.
    const asset = await newAsset('Rework Round');
    await start('ana', asset.id);
    await submit('ana', asset.id, 'https://example.test/rr-v1');
    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });
    assert.strictEqual((await assetRow(asset.id)).status, 'tl_changes_requested');
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/rr-v2' },
    })).status, 201, 'straight back in, no Accept and Start needed');
  });

  await t.test('nowhere to write the stamp does not trap the work in Assigned', async () => {
    // Accepting and recording the stamp are two things, and only the second one
    // is optional. They ran the other way round — a 503 above the transition —
    // so on a deployment whose work_sessions table could not be created the
    // artist could not accept, and once submitting required In Progress the
    // asset would have been stuck in Assigned for good.
    const asset = await newAsset('No Table To Write To');
    await sql(cfg, 'DROP TABLE IF EXISTS work_sessions');
    try {
      const accepted = await start('ana', asset.id);
      assert.strictEqual(accepted.status, 200, 'accepting still works');
      assert.strictEqual(accepted.body.accepted, true);
      assert.strictEqual(accepted.body.workLogUnavailable, true, 'and says nothing could be recorded');
      assert.strictEqual((await assetRow(asset.id)).status, 'in_progress');

      assert.strictEqual((await submit('ana', asset.id, 'https://example.test/no-log')).status, 201,
        'and the work can still be handed in');
    } finally {
      await sql(cfg, `CREATE TABLE IF NOT EXISTS work_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY, asset_id CHAR(36) NOT NULL, user_id CHAR(36) NULL,
        round INT NOT NULL DEFAULT 1, assignment_id CHAR(36) NULL,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at DATETIME NULL, seconds INT NULL,
        ended_reason VARCHAR(24) NULL,
        KEY idx_ws_asset (asset_id), KEY idx_ws_open (asset_id, ended_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }
  });

  await t.test('the same person getting work back is NOT a new round of assignment', async () => {
    // The older rule, which this must not have broken: changes sent back to
    // whoever submitted them do not change the assignee, so no new stretch
    // begins and their clock keeps climbing.
    const asset = await newAsset('Back To Ana');
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/loop-v1');
    const before = (await workOf(asset.id)).currentSeconds;

    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });
    assert.strictEqual((await assetRow(asset.id)).assignee_id, people.ana, 'still ana');

    const episodes = await sql(cfg,
      `SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(episodes[0].n), 1, 'one stretch, not two');

    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/loop-v2');
    const after = await workOf(asset.id);
    assert.ok(after.currentSeconds > before,
      `the same person's time keeps climbing across the round — ${before} then ${after.currentSeconds}`);
    assert.strictEqual(after.currentSeconds, after.totalSeconds,
      'and with one person on it, the round and the asset are the same hours');
    assert.ok(after.rounds.length > 1, 'the per-round breakdown still separates them');
    // One stretch, two rounds inside it — the episode did not end, so the
    // stamps that matter are per round, not per person.
    assert.strictEqual(after.startedAt !== null, true);
  });

  await t.test('a database full of old pause/resume data upgrades without lying about it', async () => {
    /* What every existing deployment looks like on the morning after this
       change: rounds made of several rows, because the artist paused for lunch,
       and `seconds` on each of them meaning ACTIVE worked time. Those rows must
       survive untouched — and must not be quietly relabelled as elapsed time,
       because they are not. */
    const asset = await newAsset('Recorded Under The Old Rule');

    // Three stretches in one round, the way Pause and Resume used to write
    // them, with no ended_reason because nothing recorded one.
    const ep = await sql(cfg,
      `SELECT id FROM asset_assignments WHERE asset_id = '${asset.id}' AND ended_at IS NULL`);
    for (const [from, to, secs] of [
      ['2026-02-02 09:00:00', '2026-02-02 12:00:00', 10800],
      ['2026-02-02 13:00:00', '2026-02-02 15:00:00', 7200],
      ['2026-02-02 15:30:00', '2026-02-02 17:00:00', 5400],
    ]) {
      await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, assignment_id,
        started_at, ended_at, seconds, ended_reason)
        VALUES (UUID(), '${asset.id}', '${people.ana}', 1, ${ep.length ? `'${ep[0].id}'` : 'NULL'},
                '${from}', '${to}', ${secs}, NULL)`);
    }

    // Six and a half worked hours across an eight-hour span. That distinction
    // is the whole reason the old rows are left alone.
    const work = await workOf(asset.id);
    assert.strictEqual(work.totalSeconds, 23400, 'the recorded active time, to the second');
    assert.strictEqual(work.rounds.length, 1, 'still one round');
    assert.ok(new Date(work.submittedAt) - new Date(work.startedAt) === 8 * 3600 * 1000,
      'while the two stamps are eight hours apart — which is exactly the difference');

    // Running the migration again must not backfill a reason onto them. A guess
    // would destroy the only marker distinguishing old rows from new ones.
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db = { query: async (text, params = []) => {
      const ordered = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
      const [out] = await conn.query(sqlText, ordered.length ? ordered : params);
      return { rows: Array.isArray(out) ? out : [], result: out };
    } };
    try { await require('../src/migrate').run(db, () => {}); } finally { await conn.end(); }

    const after = await sessionsOf(asset.id);
    assert.strictEqual(after.length, 3, 'the three rows are still three rows');
    assert.deepStrictEqual(after.map((r) => r.ended_reason), [null, null, null],
      'and still carry no reason — the marker that says they mean something else');
    assert.deepStrictEqual(after.map((r) => r.seconds), [10800, 7200, 5400], 'untouched');

    /* And the reports say so rather than presenting both kinds as one series.
       The cutover is derived from the data: the earliest row that HAS a reason. */
    const workLog = require('../src/work-log');
    const cutover = await workLog.cutover({ query: async (text) => {
      const c = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      });
      try { const [out] = await c.query(text); return { rows: out, result: out }; }
      finally { await c.end(); }
    } });
    assert.ok(cutover.mixed, 'the deployment is flagged as holding both kinds');
    assert.ok(cutover.legacyRows >= 3, `and counts the old rows — got ${cutover.legacyRows}`);
    assert.match(cutover.date, /^\d{4}-\d{2}-\d{2}$/, 'with a date the exports can print');

    const exporter = require('../src/report-export');
    const basis = exporter.timeBasis(cutover);
    assert.strictEqual(basis.length, 2, 'so every export carries the warning line');
    assert.match(basis[1][1], new RegExp(cutover.date));
  });

  await t.test('the whole loop: TL Feedbacks, CD Feedbacks, and a hand-over', async () => {
    /* One asset through every path that opens or closes a stretch, checking the
       stamps and the reason at each step. The rounds and the hand-over were
       each covered on their own above; what this pins is that they compose —
       that four rounds across two people produce four spans, each with its own
       pair of stamps, none of them overlapping, and every close explained. */
    const asset = await newAsset('The Long Way Round');

    // Round 1: ana accepts, works, submits.
    await start('ana', asset.id);
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/lw-v1');

    // TL sends it back. Same person, so no new episode — a new round inside it.
    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });
    assert.strictEqual((await assetRow(asset.id)).status, 'tl_changes_requested');
    await start('ana', asset.id);            // round 2
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/lw-v2');

    // TL passes it up; the CD sends it back; the lead relays it.
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('dana', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Rework the silhouette' },
    });
    assert.strictEqual((await start('ana', asset.id)).status, 409, 'not until the notes are relayed');
    await as('lee', `/assets/${asset.id}/relay`, { method: 'POST', body: {} });
    await start('ana', asset.id);            // round 3
    await sleep(1100);
    await submit('ana', asset.id, 'https://example.test/lw-v3');

    // And now it goes to bo, who starts a stretch of their own.
    const anaTotal = (await workOf(asset.id)).currentSeconds;
    await as('lee', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    });
    const handed = await workOf(asset.id);
    assert.strictEqual(handed.currentSeconds, 0, 'bo starts with nothing recorded');
    assert.strictEqual(handed.startedAt, null, 'and no start stamp until they accept');
    assert.strictEqual(handed.totalSeconds, anaTotal, "and ana's three rounds survive intact");

    await start('bo', asset.id);             // round 4
    await sleep(1100);
    await submit('bo', asset.id, 'https://example.test/lw-v4');

    // Four rounds, four rows, four pairs of stamps, all closed by a submission.
    const rows = await sessionsOf(asset.id);
    assert.strictEqual(rows.length, 4, 'one row per round — nothing split, nothing merged');
    assert.deepStrictEqual(rows.map((r) => r.round), [1, 2, 3, 4]);
    assert.deepStrictEqual(rows.map((r) => r.ended_reason),
      ['submitted', 'submitted', 'submitted', 'submitted'],
      'every close is explained, and none of them was a person clicking Pause');

    // No two spans overlap, and each starts after the one before it ended —
    // which is what makes summing them the same as their union for one person.
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(new Date(rows[i].started_at) >= new Date(rows[i - 1].ended_at),
        `round ${i + 1} starts no earlier than round ${i} was handed in`);
    }
    for (const row of rows) {
      assert.ok(row.seconds >= 1, `round ${row.round} recorded a span`);
      assert.strictEqual(row.seconds,
        Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000),
        `round ${row.round}: the stored figure is the gap between its two stamps`);
    }

    // The API agrees, and attributes the last round to bo alone.
    const work = await workOf(asset.id);
    assert.strictEqual(work.rounds.length, 4);
    assert.strictEqual(work.currentSeconds, work.rounds[3].seconds, "bo's stretch is round 4 only");
    assert.strictEqual(work.totalSeconds,
      work.rounds.reduce((n, r) => n + r.seconds, 0), 'and the total is all four');

    // Two episodes on the list: ana's three rounds, then bo's one.
    const listed = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(listed.assignments.length, 2);
    assert.strictEqual(listed.assignments[0].rounds, 3, "ana's stretch holds three rounds");
    assert.strictEqual(listed.assignments[1].rounds, 1, "bo's holds one");
  });

  await t.test('reassigning mid-round closes the outgoing stretch and keeps its time', async () => {
    // Total is lifetime effort on the asset, whoever spent it. The hand-over is
    // what closes ana's stretch — she never clicked anything to end it, because
    // there is nothing left to click.
    const asset = await newAsset('Handed Over');
    await start('ana', asset.id);
    await sleep(1100);
    assert.strictEqual((await workOf(asset.id)).open, true, 'open while ana holds it');

    await as('pat', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });

    const closed = await sessionsOf(asset.id);
    assert.strictEqual(closed.length, 1);
    assert.ok(closed[0].ended_at, 'the hand-over closed it');
    assert.strictEqual(closed[0].ended_reason, 'reassigned', 'and recorded why');
    assert.ok(closed[0].seconds >= 1, 'with the elapsed span on it');
    const before = (await workOf(asset.id)).totalSeconds;

    assert.strictEqual((await start('ana', asset.id)).status, 403, 'the old assignee cannot start it again');
    assert.strictEqual((await start('bo', asset.id)).status, 200, 'the new one records their own start');
    assert.ok((await workOf(asset.id)).totalSeconds >= before, 'nothing already spent was lost');

    // Taking it off everybody closes the stretch too, and says so.
    await as('pat', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: null } });
    const reasons = (await sessionsOf(asset.id)).map((r) => r.ended_reason);
    assert.deepStrictEqual(reasons, ['reassigned', 'unassigned'],
      'every close records what caused it — nothing a person clicks ends one');
  });
});
