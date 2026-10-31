/* WHEN A CHAT ATTACHMENT DIES, and the bug that made it four hours.
 *
 * ===========================================================================
 * THE BUG THIS FILE IS THE RECORD OF. expires_at was written from Node as a JS
 * Date — which the driver renders as a wall clock in the NODE process's zone —
 * while created_at beside it is written by MariaDB's CURRENT_TIMESTAMP, a wall
 * clock in the DATABASE SESSION's zone. Two columns in one row, in two zones,
 * neither saying which. A boot migration then overwrote expires_at with
 * `created_at + INTERVAL 12 HOUR`, replacing Node's rendering with the
 * database's, while the sweep went on comparing it against a Node-rendered now.
 *
 * The lifetime became 12h + (dbOffset − nodeOffset). The first test below is
 * the reproduction, and it produces 4.00 hours on a session at -08:00 — which
 * is the number the studio reported, not an approximation of it.
 *
 * THE MATRIX IS THE POINT. Three process timezones crossed with three database
 * session timezones, nine combinations, and the expiry instant has to be the
 * same in all nine. That is the property the fix buys and the one no amount of
 * reading the code establishes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const chatFiles = require('../src/chat-files');
const chatSettings = require('../src/chat-settings');

const cfg = config('chatexp');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Chat-Expiry-11!';

/* THE SCHEMA, AND SOMETHING FOR AN ATTACHMENT TO HANG OFF.
 *
 * resetSchema() applies sql/schema.sql only, and the chat tables are created by
 * the migration — so a case that wants chat_attachments has to boot the app
 * once to get it. And chat_attachments.message_id has a foreign key, so every
 * fixture row needs a real message; one conversation and one message are made
 * here for all of them to point at. */
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';
async function prepare() {
  await resetSchema(cfg);
  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'prep', CHAT_SWEEP_MINUTES: '0' });
  stopServer(server);
  await sql(cfg, "INSERT IGNORE INTO chat_conversations (id, kind) VALUES ('conv-expiry', 'direct')");
  await sql(cfg,
    "INSERT IGNORE INTO chat_messages (id, conversation_id, body) VALUES (?, 'conv-expiry', 'x')",
    [MESSAGE_ID]);
}

/* A connection of our own, so a case can set the SESSION time_zone — which is
   the variable half of the bug and cannot be reached through the app. */
async function connect(zone) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
  });
  if (zone) await conn.query(`SET time_zone = '${zone}'`);
  return conn;
}

test('THE REPRODUCTION: the old rule gave four hours on a -08:00 database', { skip: SKIP }, async (t) => {
  await resetSchema(cfg);
  const conn = await connect(null);
  t.after(() => conn.end());

  await conn.query(`CREATE TABLE IF NOT EXISTS expiry_repro (
    id INT AUTO_INCREMENT PRIMARY KEY,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

  /* THE OLD CODE, exactly: Node computes upload + 12h as a Date, the database
     stamps created_at itself, and the boot migration then restamps from
     created_at. Node here runs on UTC, which is what the test runner gives us
     and what a great many Node deployments use. */
  const measured = {};
  for (const zone of ['+00:00', '+05:30', '-08:00']) {
    await conn.query(`SET time_zone = '${zone}'`);
    await conn.query('TRUNCATE expiry_repro');
    await conn.query('INSERT INTO expiry_repro (expires_at) VALUES (?)',
      [new Date(Date.now() + 12 * 60 * 60 * 1000)]);
    await conn.query(`UPDATE expiry_repro SET expires_at = created_at + INTERVAL 12 HOUR
                       WHERE expires_at <> created_at + INTERVAL 12 HOUR`);
    const [[row]] = await conn.query('SELECT expires_at FROM expiry_repro');
    measured[zone] = Math.round((new Date(row.expires_at).getTime() - Date.now()) / 360000) / 10;
  }

  assert.strictEqual(measured['+00:00'], 12, 'with both clocks agreeing, twelve — which is why it hid');
  assert.strictEqual(measured['-08:00'], 4, 'and on a -08:00 database, exactly the four hours reported');
  assert.strictEqual(measured['+05:30'], 17.5, 'the same mechanism the other way makes it late');

  /* AND THE ARITHMETIC IS THE OFFSET, which is what makes this a diagnosis
     rather than three numbers: lifetime = 12h + (dbOffset − nodeOffset). */
  assert.strictEqual(measured['-08:00'], 12 - 8);
  assert.strictEqual(measured['+05:30'], 12 + 5.5);
});

test('THE FIX: the expiry instant is the same in every timezone combination',
  { skip: SKIP }, async (t) => {
  await prepare();
  const conn = await connect(null);
  t.after(() => conn.end());

  /* The real table, and the real statement src/chat-files.js writes with. What
     is measured is the UTC instant the row means — through UNIX_TIMESTAMP,
     which is the database converting its own stored value with its own session
     zone, i.e. the only reading of it that is not a guess. */
  const instants = [];
  for (const dbZone of ['SYSTEM', '+00:00', '+05:30']) {
    await conn.query(`SET time_zone = '${dbZone}'`);
    await conn.query('DELETE FROM chat_attachments');
    await conn.query(
      `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
       VALUES (UUID(), '${MESSAGE_ID}', 'x.png', 1, 'x.png', NOW() + INTERVAL 12 HOUR)`
    );
    const [[row]] = await conn.query(
      'SELECT UNIX_TIMESTAMP(expires_at) AS at, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS left_s FROM chat_attachments'
    );
    instants.push({ dbZone, at: Number(row.at), left: Number(row.left_s) });
  }

  /* THE SAME INSTANT, to the second, whatever zone the session was in. Written
     with the database's clock and read back with the database's clock, the zone
     cancels out — which is the whole of the fix. */
  const spread = Math.max(...instants.map((i) => i.at)) - Math.min(...instants.map((i) => i.at));
  assert.ok(spread <= 2, `the expiry instant does not move with the session zone: ${JSON.stringify(instants)}`);

  /* AND WHAT A READER GETS IS TWELVE HOURS, in all three, because it is a
     DIFFERENCE and differences have no zone. */
  for (const i of instants) {
    assert.ok(Math.abs(i.left - 12 * 3600) <= 2,
      `${i.dbZone}: twelve hours left, not ${(i.left / 3600).toFixed(2)}`);
  }
});

test('the process timezone does not move the expiry either', { skip: SKIP }, async (t) => {
  /* THE OTHER HALF OF THE MATRIX. The database writes and reads the stamp, so
     the Node process's zone should be irrelevant — asserted by running a real
     server under three of them and comparing what each stores.
     
     THREE BOOTS, not three connections: TZ is read by the process at start, so
     setting it afterwards proves nothing. */
  await prepare();
  const seen = [];
  for (const TZ of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const server = await startServer(cfg, { BOOTSTRAP_TOKEN: `tz-${TZ}`, TZ,
      CHAT_SWEEP_MINUTES: '0' });
    try {
      await sql(cfg, 'DELETE FROM chat_attachments');
      /* Through the module, in a child carrying this TZ — which is what makes
         the process zone the variable under test. */
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, ['-e',
        "const db=require('./src/db');const f=require('./src/chat-files');"
        + `f.record(db,{messageId:'${MESSAGE_ID}',file:{originalname:'x.png',size:1,filename:'x.png'}})`
        + ".then(()=>db.end()).catch((e)=>{console.error(e);process.exit(1);});"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TZ, DB_HOST: cfg.host, DB_PORT: String(cfg.port),
          DB_NAME: cfg.database, DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
      });
      const rows = await sql(cfg,
        'SELECT UNIX_TIMESTAMP(expires_at) AS at, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS left_s FROM chat_attachments');
      seen.push({ TZ, at: Number(rows[0].at), left: Number(rows[0].left_s) });
    } finally { stopServer(server); }
  }

  const spread = Math.max(...seen.map((s) => s.at)) - Math.min(...seen.map((s) => s.at));
  assert.ok(spread <= 30, `the stored instant does not follow the process zone: ${JSON.stringify(seen)}`);
  for (const s of seen) {
    assert.ok(Math.abs(s.left - 12 * 3600) <= 30,
      `${s.TZ}: twelve hours, not ${(s.left / 3600).toFixed(2)}`);
  }
});

test('not deleted at 11h59m; deleted after 12h', { skip: SKIP }, async (t) => {
  await prepare();
  const conn = await connect(null);
  t.after(() => conn.end());

  const db = {
    query: async (text, params = []) => {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return '?'; });
      const [rows, fields] = await conn.query(translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows, fields };
    },
  };

  /* THE CLOCK IS INJECTED BY MOVING THE ROW, not by moving the machine. The
     expiry is a stamp the database compares against its own NOW(), so "it is
     now 11h59m later" and "the stamp is 1 minute in the future" are the same
     statement — and the second is the one a test can make. */
  const make = async (id, minutesLeft) => {
    await conn.query(
      `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
       VALUES (?, '${MESSAGE_ID}', ?, 1, ?, NOW() + INTERVAL ? MINUTE)`,
      [id, `${id}.png`, `${id}.png`, minutesLeft]
    );
    fs.mkdirSync(chatFiles.CHAT_DIR, { recursive: true });
    fs.writeFileSync(path.join(chatFiles.CHAT_DIR, `${id}.png`), 'bytes');
  };

  await conn.query('DELETE FROM chat_attachments');
  await make('almost', 1);    // 11h59m into a twelve-hour life
  await make('past', -1);     // just past it

  const out = await chatFiles.sweep(db, { log: () => {} });
  assert.strictEqual(out.rows, 1, 'exactly one row was past its expiry');
  assert.deepStrictEqual(out.ids, ['past']);

  assert.ok(fs.existsSync(path.join(chatFiles.CHAT_DIR, 'almost.png')),
    'a minute short of the deadline is not expired');
  assert.ok(!fs.existsSync(path.join(chatFiles.CHAT_DIR, 'past.png')),
    'a minute past it is');

  const rows = await sql(cfg, 'SELECT id, deleted_at, stored_name FROM chat_attachments ORDER BY id');
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.get('almost').deleted_at, null);
  assert.ok(byId.get('past').deleted_at, 'and the row records that it went');
  assert.strictEqual(byId.get('past').stored_name, null);

  /* IDEMPOTENT: a second sweep finds nothing to do and does not error. */
  const again = await chatFiles.sweep(db, { log: () => {} });
  assert.strictEqual(again.rows, 0);

  fs.rmSync(path.join(chatFiles.CHAT_DIR, 'almost.png'), { force: true });
});

test('two sweepers at once delete each file once, and neither errors', { skip: SKIP }, async (t) => {
  await prepare();
  const a = await connect(null);
  const b = await connect(null);
  t.after(() => Promise.all([a.end(), b.end()]));

  const wrap = (conn) => ({
    query: async (text, params = []) => {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  });

  await a.query('DELETE FROM chat_attachments');
  fs.mkdirSync(chatFiles.CHAT_DIR, { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    await a.query(
      `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
       VALUES (?, '${MESSAGE_ID}', ?, 1, ?, NOW() - INTERVAL 1 MINUTE)`,
      [`race${i}`, `race${i}.png`, `race${i}.png`]
    );
    fs.writeFileSync(path.join(chatFiles.CHAT_DIR, `race${i}.png`), 'bytes');
  }

  /* BOTH AT ONCE, on separate connections — which is two Passenger workers, the
     case the comment in src/chat-files.js promises is safe. */
  const [first, second] = await Promise.all([
    chatFiles.sweep(wrap(a), { log: () => {} }),
    chatFiles.sweep(wrap(b), { log: () => {} }),
  ]);

  /* COUNTED ONCE BETWEEN THEM. The UPDATE narrows on deleted_at IS NULL, so the
     loser of each race matches no rows and reports nothing — rather than both
     claiming six and the log saying twelve files went. */
  assert.strictEqual(first.rows + second.rows, 6,
    `six rows, counted once: ${first.rows} + ${second.rows}`);
  const ids = [...first.ids, ...second.ids].sort();
  assert.strictEqual(new Set(ids).size, 6, 'and no id is claimed twice');
  for (let i = 0; i < 6; i += 1) {
    assert.ok(!fs.existsSync(path.join(chatFiles.CHAT_DIR, `race${i}.png`)), `race${i}.png is gone`);
  }
});

test('a stored path outside the upload root is never followed', { skip: SKIP }, async (t) => {
  await prepare();
  const conn = await connect(null);
  t.after(() => conn.end());
  const db = {
    query: async (text, params = []) => {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };

  /* A FILE THE SWEEP MUST NOT TOUCH, outside the chat upload root. There is no
     legitimate way for a row to point at one, which is exactly why a guard that
     is only basename() is worth not relying on: it is one edit away from a
     join() that walks out. */
  const outside = path.join(chatFiles.CHAT_DIR, '..', 'not-a-chat-file.txt');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'this belongs to something else');

  await conn.query('DELETE FROM chat_attachments');
  await conn.query(
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
     VALUES ('traverse', '${MESSAGE_ID}', 'x.txt', 1, ?, NOW() - INTERVAL 1 MINUTE)`,
    ['../not-a-chat-file.txt']
  );

  /* TWO MORE THAT MUST ALSO BE REFUSED, each caught by a DIFFERENT HALF of the
     guard — which is what makes both halves worth having.

     '..' passes the basename test (basename('..') IS '..') and is caught only
     by the resolved-path test. 'nested/file.txt' passes the resolved-path test
     — it resolves to somewhere properly inside the root — and is caught only
     by the basename test. A mutation that takes out either half alone fails
     here; without these two rows, either half alone covered the '../' case and
     removing one proved nothing. Found by exactly that mutation coming back
     green. */
  const nested = path.join(chatFiles.CHAT_DIR, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'file.txt'), 'nested, so not from here');
  for (const [id, stored] of [['dotdot', '..'], ['nested', 'nested/file.txt']]) {
    await conn.query(
      `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
       VALUES (?, '${MESSAGE_ID}', 'x.txt', 1, ?, NOW() - INTERVAL 1 MINUTE)`,
      [id, stored]
    );
  }

  const lines = [];
  const out = await chatFiles.sweep(db, { log: (m) => lines.push(String(m)) });

  assert.ok(fs.existsSync(outside), 'the file outside the root is still there');
  assert.ok(fs.existsSync(path.join(nested, 'file.txt')), 'and the nested one');
  assert.ok(fs.existsSync(chatFiles.CHAT_DIR), 'and the upload root itself');
  assert.strictEqual(out.refused, 3, 'and the sweep says it refused all three');
  assert.strictEqual(out.rows, 0, 'no row is marked deleted');
  for (const id of ['dotdot', 'nested']) {
    assert.ok(lines.some((l) => /outside the chat/i.test(l) && new RegExp(id).test(l)),
      `${id} is logged by id: ${lines.join(' | ')}`);
    const r = await sql(cfg, 'SELECT deleted_at FROM chat_attachments WHERE id = ?', [id]);
    assert.strictEqual(r[0].deleted_at, null, `${id} is left for somebody to look at`);
  }
  fs.rmSync(nested, { recursive: true, force: true });
  assert.ok(lines.some((l) => /outside the chat/i.test(l) && /traverse/.test(l)),
    `and it is logged by id: ${lines.join(' | ')}`);

  /* LEFT ALONE, not marked gone: marking it deleted would hide the only sign
     that something needs looking at. */
  const rows = await sql(cfg, 'SELECT deleted_at FROM chat_attachments WHERE id = ?', ['traverse']);
  assert.strictEqual(rows[0].deleted_at, null);
  fs.rmSync(outside, { force: true });
});

test('the disk pass removes orphans and never a live file', { skip: SKIP }, async (t) => {
  await prepare();
  const conn = await connect(null);
  t.after(() => conn.end());
  const db = {
    query: async (text, params = []) => {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => { values.push(params[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };

  /* THE CASE THE OLD DISK PASS GOT WRONG. It deleted every file older than the
     retention by mtime, whatever the database said — so raising the retention
     to 48 hours would have left rows saying 48 while the bytes went at 12. */
  fs.mkdirSync(chatFiles.CHAT_DIR, { recursive: true });
  const live = path.join(chatFiles.CHAT_DIR, 'live-and-old.png');
  const orphan = path.join(chatFiles.CHAT_DIR, 'nobody-claims-me.png');
  const fresh = path.join(chatFiles.CHAT_DIR, 'just-uploaded.png');
  for (const f of [live, orphan, fresh]) fs.writeFileSync(f, 'bytes');
  // Both the live file and the orphan are a day old; the third is new.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(live, dayAgo, dayAgo);
  fs.utimesSync(orphan, dayAgo, dayAgo);

  await conn.query('DELETE FROM chat_attachments');
  await conn.query(
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
     VALUES ('alive', '${MESSAGE_ID}', 'live-and-old.png', 1, 'live-and-old.png', NOW() + INTERVAL 40 HOUR)`
  );

  const out = await chatFiles.sweep(db, { log: () => {} });

  assert.ok(fs.existsSync(live),
    'a file a live row claims is kept, however old it is — its row says when it goes');
  assert.ok(!fs.existsSync(orphan), 'a file no row claims is an orphan and goes');
  assert.ok(fs.existsSync(fresh),
    'and one uploaded moments ago is inside the grace period, because its row may still be in flight');
  assert.strictEqual(out.orphans, 1);

  for (const f of [live, fresh]) fs.rmSync(f, { force: true });
});

test('the retention setting', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'chatexp', CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'chatexp', name: 'Root', email: 'root@chatexp.test', password: PASSWORD } });
    tok.root = await login('root@chatexp.test');
    /* Something for the fixture attachments to hang off: chat_attachments has a
       foreign key on message_id. */
    await sql(cfg, "INSERT IGNORE INTO chat_conversations (id, kind) VALUES ('conv-expiry', 'direct')");
    await sql(cfg,
      "INSERT IGNORE INTO chat_messages (id, conversation_id, body) VALUES (?, 'conv-expiry', 'x')",
      [MESSAGE_ID]);
    const made = await as('root', '/users', { method: 'POST',
      body: { name: 'Ana', email: 'ana@chatexp.test', password: PASSWORD, role: 'game_artist' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    tok.ana = await login('ana@chatexp.test');
  });
  t.after(() => { if (server) stopServer(server); });

  await t.test('the key defaults to the Super Admin alone, and is grantable', () => {
    const catalog = require('../src/permission-catalog');
    const roles = require('../src/roles');
    assert.ok(catalog.isPermission('settings.chat_retention'));
    assert.ok(catalog.grantableKeys().includes('settings.chat_retention'));
    const holders = roles.roleKeys()
      .filter((k) => catalog.baselineFor(roles.capabilitiesFor(k)).has('settings.chat_retention'));
    assert.deepStrictEqual(holders, ['super_admin']);
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.match(readme, /settings\.chat_retention/, 'the README lists it');
  });

  await t.test('the default is twelve, and the bounds come with it', async () => {
    const r = await as('root', '/admin/settings/chat-policy');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.settings.attachmentHours, 12);
    assert.deepStrictEqual(r.body.settings.attachmentHoursBounds, { min: 1, max: 720 });
  });

  await t.test('a value without the permission is refused', async () => {
    const read = await as('ana', '/admin/settings/chat-policy');
    assert.strictEqual(read.status, 403, JSON.stringify(read.body));
    const write = await as('ana', '/admin/settings/chat-policy',
      { method: 'PUT', body: { attachmentHours: 24 } });
    assert.strictEqual(write.status, 403, JSON.stringify(write.body));
  });

  await t.test('what a retention may be', async () => {
    for (const [what, hours] of [['zero', 0], ['negative', -5], ['a fraction', 12.5],
      ['empty', ''], ['words', 'twelve'], ['over the ceiling', 721]]) {
      const r = await as('root', '/admin/settings/chat-policy',
        { method: 'PUT', body: { attachmentHours: hours } });
      assert.strictEqual(r.status, 422, `${what}: ${JSON.stringify(r.body)}`);
      assert.ok(String(r.body.error || '').length > 10, `${what}: and it says why`);
    }
    /* NOUGHT SAYS WHY IN PARTICULAR, because it is the plausible thing to type
       when what was meant is "never delete" — which is not on offer. */
    const nought = await as('root', '/admin/settings/chat-policy',
      { method: 'PUT', body: { attachmentHours: 0 } });
    assert.match(nought.body.error, /not on offer|never delete/i);

    for (const hours of [1, 12, 48, 720]) {
      const r = await as('root', '/admin/settings/chat-policy',
        { method: 'PUT', body: { attachmentHours: hours } });
      assert.strictEqual(r.status, 200, `${hours}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.settings.attachmentHours, hours);
    }
  });

  await t.test('the change is in the audit trail, with who and what it was', async () => {
    await as('root', '/admin/settings/chat-policy', { method: 'PUT', body: { attachmentHours: 12 } });
    await as('root', '/admin/settings/chat-policy', { method: 'PUT', body: { attachmentHours: 36 } });
    const rows = await sql(cfg,
      `SELECT actor_name, summary FROM activity_log WHERE action = 'settings.chat_retention'
        ORDER BY seq DESC LIMIT 1`);
    assert.ok(rows.length, 'a line was written');
    assert.match(rows[0].summary, /12 hours/, 'and it says what it was');
    assert.match(rows[0].summary, /36 hours/, 'and what it became');
    assert.strictEqual(rows[0].actor_name, 'Root', 'and who did it');
  });

  await t.test('changing it never moves an expiry already written', async () => {
    await as('root', '/admin/settings/chat-policy', { method: 'PUT', body: { attachmentHours: 12 } });
    await sql(cfg, 'DELETE FROM chat_attachments');
    await sql(cfg,
      `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, expires_at)
       VALUES ('already', '${MESSAGE_ID}', 'x.png', 1, 'x.png', NOW() + INTERVAL 12 HOUR)`);
    const before = (await sql(cfg,
      'SELECT TIMESTAMPDIFF(MINUTE, NOW(), expires_at) AS left_m FROM chat_attachments WHERE id = ?',
      ['already']))[0].left_m;

    /* SHORTENED TO AN HOUR, which under the old design would have been the
       dangerous direction: a setting that reached back would wipe files people
       were counting on this afternoon. */
    await as('root', '/admin/settings/chat-policy', { method: 'PUT', body: { attachmentHours: 1 } });
    const after = (await sql(cfg,
      'SELECT TIMESTAMPDIFF(MINUTE, NOW(), expires_at) AS left_m FROM chat_attachments WHERE id = ?',
      ['already']))[0].left_m;
    assert.ok(Math.abs(Number(after) - Number(before)) <= 1,
      `the existing file keeps its twelve hours: ${before} -> ${after}`);

    /* AND A NEW UPLOAD TAKES THE NEW VALUE, which is the other half of the
       promise the screen makes. */
    await sql(cfg, "UPDATE chat_settings SET attachment_hours = 1 WHERE id = 1");
    const fresh = await startServer(cfg, { BOOTSTRAP_TOKEN: 'chatexp2', CHAT_SWEEP_MINUTES: '0' });
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, ['-e',
        "const db=require('./src/db');const f=require('./src/chat-files');"
        + `require('./src/chat-settings').load(db).then(()=>f.record(db,{messageId:'${MESSAGE_ID}',`
        + "file:{originalname:'n.png',size:1,filename:'n.png'}})).then(()=>db.end())"
        + ".catch((e)=>{console.error(e);process.exit(1);});"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DB_HOST: cfg.host, DB_PORT: String(cfg.port),
          DB_NAME: cfg.database, DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
      });
      const rows = await sql(cfg,
        `SELECT TIMESTAMPDIFF(MINUTE, NOW(), expires_at) AS left_m FROM chat_attachments
          WHERE file_name = 'n.png'`);
      assert.ok(Math.abs(Number(rows[0].left_m) - 60) <= 2,
        `a file uploaded under a one-hour retention gets one hour: ${rows[0].left_m} minutes`);
    } finally { stopServer(fresh); }

    await as('root', '/admin/settings/chat-policy', { method: 'PUT', body: { attachmentHours: 12 } });
  });
});
