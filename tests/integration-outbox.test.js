/* The outbox worker: delivery, the retry schedule, and its isolation from the
 * request that caused the row.
 *
 * THE SCHEDULE IS TESTED AS A PURE FUNCTION, deliberately. It spans a little over
 * a day, and a test that waited for six hours to see the fourth delay would not be
 * a test. nextState() takes the attempt count and the outcome and returns the next
 * state and delay, so every step of the schedule is asserted exactly, in
 * milliseconds, and the integration tests below only have to show that the wiring
 * reaches it.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');

/* A socket that accepts and never answers, and CAN BE SHUT DOWN AGAIN.
 *
 * server.close() waits for open connections to end, and the whole point of this
 * one is connections that never end — so closing it without destroying its sockets
 * first hangs the test run rather than failing it, which is a far more annoying
 * failure to diagnose than an assertion. The sockets are kept and destroyed by
 * hand; closeAllConnections() would also do it, but this says what it is doing. */
async function blackHole() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: (path = '/hooks/forge') => `http://127.0.0.1:${server.address().port}${path}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((done) => server.close(done));
    },
  };
}

const cfg = config('outbox');
const OUT_SECRET = 'outbound-secret-for-the-test-suite';
const IN_SECRET = 'inbound-secret-for-the-test-suite-only';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('the retry schedule, exactly as specified', () => {
  const outbox = require('../src/integration-outbox');

  assert.deepStrictEqual(outbox.BACKOFF_SECONDS, [60, 300, 1800, 7200, 21600, 86400],
    '1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 24 hours');

  // Spelled out in the units the schedule was written in, so a wrong number is
  // wrong here in a way somebody reading it would notice.
  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  assert.deepStrictEqual(outbox.BACKOFF_SECONDS,
    [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 24 * HOUR]);

  /* attempts is the count INCLUDING the attempt just made, because it is
     incremented when the row is claimed rather than when the outcome is known —
     so an attempt that kills the process has still been used. */
  const delayAfter = (n) => outbox.nextState(n, 'retry').delaySeconds;
  assert.strictEqual(delayAfter(1), 1 * MINUTE, 'after the first attempt');
  assert.strictEqual(delayAfter(2), 5 * MINUTE);
  assert.strictEqual(delayAfter(3), 30 * MINUTE);
  assert.strictEqual(delayAfter(4), 2 * HOUR);
  assert.strictEqual(delayAfter(5), 6 * HOUR);
  assert.strictEqual(delayAfter(6), 24 * HOUR, 'the last retry');

  const seventh = outbox.nextState(7, 'retry');
  assert.strictEqual(seventh.status, 'failed', 'and then it is given up on, not retried forever');
  assert.strictEqual(seventh.delaySeconds, null);
  assert.strictEqual(seventh.exhausted, true);
  assert.strictEqual(outbox.nextState(99, 'retry').status, 'failed');

  // Seven attempts in all, spanning a bit over a day.
  const total = outbox.BACKOFF_SECONDS.reduce((a, b) => a + b, 0);
  assert.ok(total > 24 * HOUR && total < 36 * HOUR, `the whole schedule is ${total}s`);

  assert.strictEqual(outbox.nextState(1, 'sent').status, 'sent');
  assert.strictEqual(outbox.nextState(1, 'sent').delaySeconds, null);

  /* A receiver saying the message itself is wrong is not a thing to retry. Sending
     it another six times is noise on their end and a row that fails tomorrow
     instead of now. */
  assert.strictEqual(outbox.nextState(1, 'rejected').status, 'failed');
  assert.strictEqual(outbox.nextState(1, 'rejected').delaySeconds, null);

  // The status vocabulary, matching the VARCHAR the table already declares.
  assert.deepStrictEqual(Object.keys(outbox.STATUS).sort(),
    ['failed', 'pending', 'sending', 'sent']);
});

test('the signature, and the two secrets that must not be one', () => {
  const outbox = require('../src/integration-outbox');

  /* THE SAME ENVELOPE the inbound side verifies — t.METHOD.path.rawBody — so the
     other end implements one verifier rather than two. Different key, same shape. */
  const inbound = require('../src/middleware/service-auth');
  assert.strictEqual(
    outbox.signingPayload(7, 'post', '/hooks/forge', '{"a":1}'),
    inbound.signingPayload(7, 'post', '/hooks/forge', '{"a":1}'),
    'both directions construct the signed string identically');

  const header = outbox.sign('a-secret', { t: 111, path: '/hooks/forge', body: '{"a":1}' });
  const parsed = inbound.parseSignature(header);
  assert.strictEqual(parsed.t, '111');
  assert.strictEqual(parsed.v1, crypto.createHmac('sha256', 'a-secret')
    .update('111.POST./hooks/forge.{"a":1}').digest('hex'));

  // And the key really is the key: the same bytes under a different secret differ.
  assert.notStrictEqual(
    outbox.sign('one', { t: 1, path: '/x', body: '{}' }),
    outbox.sign('two', { t: 1, path: '/x', body: '{}' }));

  // The path is taken from the configured URL, query string included, because that
  // is what the receiver will be verifying against.
  assert.strictEqual(outbox.pathOf('https://devqa.example/hooks/forge?v=2'), '/hooks/forge?v=2');
  assert.strictEqual(outbox.pathOf('not a url'), '/', 'and a nonsense URL signs something rather than throwing');

  /* ONE SECRET FOR BOTH DIRECTIONS is refused, not warned about. Whoever can
     VERIFY a message could then also FORGE one, which removes the only thing a
     signature proves — and it would look like it was working. */
  const keep = { out: process.env.INTEGRATION_OUTBOUND_SECRET, in: process.env.INTEGRATION_INBOUND_SECRET };
  try {
    process.env.INTEGRATION_OUTBOUND_SECRET = 'same';
    process.env.INTEGRATION_INBOUND_SECRET = 'same';
    assert.strictEqual(outbox.secretsCollide(), true);
    process.env.INTEGRATION_INBOUND_SECRET = 'different';
    assert.strictEqual(outbox.secretsCollide(), false);
    delete process.env.INTEGRATION_INBOUND_SECRET;
    assert.strictEqual(outbox.secretsCollide(), false, 'one of them unset is not a collision');
  } finally {
    if (keep.out === undefined) delete process.env.INTEGRATION_OUTBOUND_SECRET;
    else process.env.INTEGRATION_OUTBOUND_SECRET = keep.out;
    if (keep.in === undefined) delete process.env.INTEGRATION_INBOUND_SECRET;
    else process.env.INTEGRATION_INBOUND_SECRET = keep.in;
  }

  assert.notStrictEqual(outbox.OUTBOUND_SECRET_VAR, outbox.INBOUND_SECRET_VAR);
});

test('delivery, retries and the claim', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const outbox = require('../src/integration-outbox');
  let server;      // the app, with its own worker deliberately inert
  let receiver;    // stands in for Dev & QA
  let received = [];
  let answer = { status: 200, body: '{"ok":true}' };
  let conn;
  let db;

  const KEY = 'outbox-key-0123456789abcdef';

  const rowsOf = () => sql(cfg,
    'SELECT id, `status`, attempts, last_error, next_attempt_at, '
    + 'TIMESTAMPDIFF(SECOND, NOW(), next_attempt_at) AS dueIn, payload '
    + 'FROM integration_outbox ORDER BY seq');

  const seed = async (payload = { hello: 'devqa' }, extra = {}) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO integration_outbox (id, payload, `status`, attempts, next_attempt_at) '
      + 'VALUES (?, ?, ?, ?, ?)',
      [id, JSON.stringify(payload), extra.status || 'pending',
        extra.attempts || 0, extra.nextAttemptAt || null]);
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({
          signature: req.headers['x-integration-signature'],
          delivery: req.headers['x-integration-delivery'],
          attempt: req.headers['x-integration-attempt'],
          contentType: req.headers['content-type'],
          body,
        });
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(answer.body);
      });
    });
    await new Promise((done) => receiver.listen(0, '127.0.0.1', done));

    /* The app boots WITHOUT the outbound settings, so its own worker is inert and
       every sweep below is one this test asked for. Otherwise the startup pass
       would deliver rows before they could be looked at. */
    server = await startServer(cfg, {
      INTEGRATION_INBOUND_SECRET: IN_SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'counter,ping']);

    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    db = { query: async (text, params) => {
      const [rows] = await conn.query(text.replace(/\$(\d+)/g, '?'), params || []);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };

    /* The worker's settings live in THIS process, since this is where sweep runs.
       BOTH SECRETS are set, as production has them — they live in one .env. Without
       the inbound one present, code that signed with the wrong variable would fall
       back to the right value and every assertion below would pass anyway: a
       mutation swapping them survived until this line existed. */
    process.env.INTEGRATION_OUTBOUND_URL = `http://127.0.0.1:${receiver.address().port}/hooks/forge`;
    process.env.INTEGRATION_OUTBOUND_SECRET = OUT_SECRET;
    process.env.INTEGRATION_INBOUND_SECRET = IN_SECRET;
    process.env.INTEGRATION_OUTBOUND_TIMEOUT_MS = '1500';
  });

  t.after(async () => {
    if (conn) await conn.end();
    if (server) await stopServer(server);
    if (receiver) await new Promise((done) => receiver.close(done));
    delete process.env.INTEGRATION_OUTBOUND_URL;
    delete process.env.INTEGRATION_OUTBOUND_SECRET;
    delete process.env.INTEGRATION_INBOUND_SECRET;
    delete process.env.INTEGRATION_OUTBOUND_TIMEOUT_MS;
  });

  const reset = async () => {
    await sql(cfg, 'DELETE FROM integration_outbox');
    received = [];
    answer = { status: 200, body: '{"ok":true}' };
  };

  await t.test('a due row is delivered, signed with the OUTBOUND secret', async () => {
    await reset();
    const id = await seed({ event: 'asset.delivered', assetId: 'abc' });

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.sent, 1, JSON.stringify(tally));
    assert.strictEqual(received.length, 1);

    const got = received[0];
    assert.strictEqual(got.contentType, 'application/json');
    assert.strictEqual(got.delivery, id, 'the row id travels, so the receiver can dedupe our retries');
    assert.strictEqual(got.attempt, '1');
    assert.deepStrictEqual(JSON.parse(got.body), { event: 'asset.delivered', assetId: 'abc' });

    // Verified the way the receiver would: recompute over the bytes that arrived.
    const { t: stamp, v1 } = require('../src/middleware/service-auth').parseSignature(got.signature);
    assert.strictEqual(v1, crypto.createHmac('sha256', OUT_SECRET)
      .update(`${stamp}.POST./hooks/forge.${got.body}`).digest('hex'),
    'signed with the outbound secret, over the exact bytes sent');
    assert.notStrictEqual(v1, crypto.createHmac('sha256', IN_SECRET)
      .update(`${stamp}.POST./hooks/forge.${got.body}`).digest('hex'),
    'and NOT with the inbound one');

    const rows = await rowsOf();
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(Number(rows[0].attempts), 1);
    assert.strictEqual(rows[0].next_attempt_at, null, 'nothing further is scheduled');
  });

  await t.test('a 500 is retried, one minute out, and counts an attempt', async () => {
    await reset();
    await seed();
    answer = { status: 500, body: 'nope' };

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.retry, 1, JSON.stringify(tally));

    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'pending', 'back in the queue, not failed');
    assert.strictEqual(Number(row.attempts), 1);
    assert.ok(Number(row.dueIn) >= 58 && Number(row.dueIn) <= 60,
      `due in about a minute, not now: ${row.dueIn}s`);
    assert.match(row.last_error, /answered 500/);
  });

  await t.test('and is not picked up again until it is due', async () => {
    // The row from the previous subtest is still there, one minute out.
    received = [];
    const tally = await outbox.sweep(db, { log: () => {} });
    assert.deepStrictEqual([tally.sent, tally.retry, tally.failed], [0, 0, 0]);
    assert.strictEqual(received.length, 0, 'a backoff that is not honoured is not a backoff');
  });

  await t.test('a 4xx is given up on at once — retrying cannot fix it', async () => {
    await reset();
    await seed();
    answer = { status: 400, body: 'that payload is malformed' };

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.failed, 1, JSON.stringify(tally));

    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(Number(row.attempts), 1, 'one attempt, not seven');
    assert.match(row.last_error, /refused it \(400\)/);
    assert.match(row.last_error, /malformed/, 'and says what they said');
  });

  await t.test('429 is a wait, not a refusal', async () => {
    await reset();
    await seed();
    answer = { status: 429, body: 'slow down' };

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.retry, 1, 'being asked to slow down is the one 4xx worth retrying');
    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'pending');
  });

  await t.test('the last attempt in the schedule is the last one', async () => {
    await reset();
    // Six attempts already used, so the next failure is the seventh.
    await seed({ nearly: 'done' }, { attempts: 6 });
    answer = { status: 503, body: 'still down' };

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.failed, 1, JSON.stringify(tally));

    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(Number(row.attempts), 7, 'seven in all: the first plus six retries');
    assert.strictEqual(row.next_attempt_at, null);
  });

  await t.test('a timeout is a retry, and does not hold the row forever', async () => {
    await reset();
    /* A socket that accepts and never answers — the shape that actually hurts. A
       refused connection fails in a millisecond; a black hole would hold this row's
       claim until the process restarted if there were no deadline. */
    const blackhole = await blackHole();
    const was = process.env.INTEGRATION_OUTBOUND_URL;
    process.env.INTEGRATION_OUTBOUND_URL = blackhole.url();

    try {
      await seed();
      const started = Date.now();
      const tally = await outbox.sweep(db, { log: () => {} });
      const took = Date.now() - started;

      assert.strictEqual(tally.retry, 1, JSON.stringify(tally));
      assert.ok(took >= 1400 && took < 6000, `it waited its deadline and then gave up: ${took}ms`);
      const [row] = await rowsOf();
      assert.strictEqual(row.status, 'pending', 'released, not left marked sending');
      assert.match(row.last_error, /no answer within 1500ms/);
    } finally {
      process.env.INTEGRATION_OUTBOUND_URL = was;
      await blackhole.close();
    }
  });

  await t.test('two workers sweeping at once deliver each row once', async () => {
    await reset();
    for (let i = 0; i < 4; i += 1) await seed({ n: i });

    /* Two sweeps on two connections, as two Passenger workers would. The claim is
       the only thing standing between this and four duplicate webhooks — and
       delivering a webhook twice is not like deleting a file twice, which is why
       the chat sweep needs no claim and this one does. */
    const mysql = require('mysql2/promise');
    const second = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db2 = { query: async (text, params) => {
      const [rows] = await second.query(text.replace(/\$(\d+)/g, '?'), params || []);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };

    try {
      const [a, b] = await Promise.all([
        outbox.sweep(db, { log: () => {} }),
        outbox.sweep(db2, { log: () => {} }),
      ]);
      assert.strictEqual(a.sent + b.sent, 4, `four rows, four deliveries: ${a.sent}+${b.sent}`);
      assert.strictEqual(received.length, 4, 'and the receiver saw each exactly once');

      const ids = received.map((r) => r.delivery);
      assert.strictEqual(new Set(ids).size, 4, 'four distinct rows, none sent twice');
      const rows = await rowsOf();
      assert.ok(rows.every((r) => r.status === 'sent' && Number(r.attempts) === 1),
        JSON.stringify(rows.map((r) => [r.status, r.attempts])));
    } finally {
      await second.end();
    }
  });

  await t.test('a row abandoned by a stopped worker is reclaimed', async () => {
    await reset();
    /* Marked sending and untouched since — which is what a worker killed
       mid-delivery leaves behind. Nothing will ever finish it, and without this the
       row is stuck in that state forever. */
    const id = await seed({ orphan: true }, { status: 'sending', attempts: 2 });
    await sql(cfg, 'UPDATE integration_outbox SET updated_at = NOW() - INTERVAL 600 SECOND WHERE id = ?', [id]);

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.reclaimed, 1, JSON.stringify(tally));

    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'pending', 'back in the queue');
    assert.strictEqual(Number(row.attempts), 2,
      'attempts is untouched — it was already counted when the dead worker claimed it');
    assert.ok(Number(row.dueIn) > 0, 'and not retried instantly: it may be what took the worker down');
    assert.match(row.last_error, /worker stopped/);
  });

  await t.test('but a claim that is merely in flight is left alone', async () => {
    await reset();
    const id = await seed({ busy: true }, { status: 'sending', attempts: 1 });
    await sql(cfg, 'UPDATE integration_outbox SET updated_at = NOW() - INTERVAL 5 SECOND WHERE id = ?', [id]);

    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.reclaimed, 0, 'five seconds in is not abandoned');
    const [row] = await rowsOf();
    assert.strictEqual(row.status, 'sending', 'still somebody else\'s to finish');
    assert.strictEqual(received.length, 0);
  });

  await t.test('unconfigured, and mis-configured, deliver nothing', async () => {
    await reset();
    await seed();
    const keep = {
      url: process.env.INTEGRATION_OUTBOUND_URL,
      sec: process.env.INTEGRATION_OUTBOUND_SECRET,
      inb: process.env.INTEGRATION_INBOUND_SECRET,
    };
    try {
      delete process.env.INTEGRATION_OUTBOUND_URL;
      assert.strictEqual((await outbox.sweep(db, { log: () => {} })).skipped, 'not-configured');
      assert.strictEqual(received.length, 0, 'rows accumulate rather than going somewhere unintended');

      /* And the dangerous misconfiguration: both directions on one secret. Refused
         rather than warned about, because whoever can verify a message could then
         forge one — and it would look like it was working. */
      process.env.INTEGRATION_OUTBOUND_URL = keep.url;
      /* BOTH have to be visible to the process doing the checking, which is this
         one here and the app's own in production — they live in the same .env. The
         inbound secret was only ever passed to the spawned server above, so without
         this line there would be nothing for the outbound one to collide WITH, and
         the assertion would pass for the wrong reason. */
      process.env.INTEGRATION_INBOUND_SECRET = IN_SECRET;
      process.env.INTEGRATION_OUTBOUND_SECRET = IN_SECRET;
      assert.strictEqual((await outbox.sweep(db, { log: () => {} })).skipped, 'secrets-collide');
      assert.strictEqual(received.length, 0);

      const said = [];
      outbox.describeAtStartup((m) => said.push(m));
      assert.match(said.join(' '), /REFUSING TO DELIVER/);
      assert.match(said.join(' '), /forge/, 'and says why, not just that');
    } finally {
      process.env.INTEGRATION_OUTBOUND_URL = keep.url;
      process.env.INTEGRATION_OUTBOUND_SECRET = keep.sec;
      if (keep.inb === undefined) delete process.env.INTEGRATION_INBOUND_SECRET;
      else process.env.INTEGRATION_INBOUND_SECRET = keep.inb;
    }
  });

  await t.test('the probe writes a real row, on its transaction', async () => {
    await reset();
    const idem = crypto.randomUUID();
    const body = { counter: 'delivery', outbox: { event: 'probe.ran', at: 'now' } };
    const raw = JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', IN_SECRET)
      .update(`${stamp}.POST./api/integration/counter.${raw}`).digest('hex');

    const res = await fetch(`${server.base}/integration/counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': KEY,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
        'Idempotency-Key': idem,
      },
      body: raw,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.json().catch(() => ({}))));

    const rows = await rowsOf();
    assert.strictEqual(rows.length, 1, 'the request wrote one row and delivered nothing itself');
    assert.deepStrictEqual(JSON.parse(rows[0].payload), { event: 'probe.ran', at: 'now' });
    assert.strictEqual(rows[0].status, 'pending');

    // And it is deliverable, which is the point of having it.
    const tally = await outbox.sweep(db, { log: () => {} });
    assert.strictEqual(tally.sent, 1);
    assert.deepStrictEqual(JSON.parse(received[0].body), { event: 'probe.ran', at: 'now' });
  });
});

test('a failing delivery cannot touch the request that caused the row',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  /* THE CLAIM THIS MECHANISM RESTS ON, asserted directly rather than argued from
   * the code's shape.
   *
   * The app is booted with its worker pointed at a socket that ACCEPTS and never
   * answers — a black hole, not a refused port, because a refusal fails in a
   * millisecond and would prove nothing. The worker is therefore genuinely stuck
   * in a delivery attempt, holding it for the full timeout, on a one-second sweep
   * so it keeps being stuck. Requests issued into that are what is measured.
   */
  let server;
  let blackhole;
  const KEY = 'isolation-key-0123456789ab';

  t.before(async () => {
    await resetSchema(cfg);
    blackhole = await blackHole();

    server = await startServer(cfg, {
      INTEGRATION_INBOUND_SECRET: IN_SECRET,
      INTEGRATION_OUTBOUND_SECRET: OUT_SECRET,
      INTEGRATION_OUTBOUND_URL: blackhole.url(),
      INTEGRATION_OUTBOX_SWEEP_SECONDS: '1',
      INTEGRATION_OUTBOUND_TIMEOUT_MS: '8000',
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'counter,ping']);
    // Rows for the worker to be stuck on.
    for (let i = 0; i < 3; i += 1) {
      await sql(cfg,
        'INSERT INTO integration_outbox (id, payload, `status`) VALUES (UUID(), ?, ?)',
        [JSON.stringify({ stuck: i }), 'pending']);
    }
  });

  t.after(async () => {
    if (server) await stopServer(server);
    if (blackhole) await blackhole.close();
  });

  const write = async (n) => {
    const idem = crypto.randomUUID();
    const body = { counter: `isolated-${n}` };
    const raw = JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', IN_SECRET)
      .update(`${stamp}.POST./api/integration/counter.${raw}`).digest('hex');
    const started = Date.now();
    const res = await fetch(`${server.base}/integration/counter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': KEY,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
        'Idempotency-Key': idem,
      },
      body: raw,
    });
    return { status: res.status, ms: Date.now() - started, body: await res.json().catch(() => ({})) };
  };

  await t.test('the request neither fails nor slows while delivery is hanging', async () => {
    // Let the worker get into a delivery it cannot finish.
    await new Promise((done) => { setTimeout(done, 1200); });

    const runs = [];
    for (let n = 0; n < 5; n += 1) runs.push(await write(n));

    for (const r of runs) {
      assert.strictEqual(r.status, 200,
        `a hanging receiver must not fail the request that wrote the row: ${JSON.stringify(r.body)}`);
      /* Generous against a loaded CI box, and still two orders of magnitude under
         the 8s the worker is stuck for — the point is that the request does not
         WAIT on delivery, not that it is fast in absolute terms. */
      assert.ok(r.ms < 2000, `it should not wait on the delivery attempt: ${r.ms}ms`);
    }

    const slowest = Math.max(...runs.map((r) => r.ms));
    assert.ok(slowest < 2000, `slowest was ${slowest}ms while a delivery hung for 8s`);

    // The rows those requests wrote are there, queued, untouched by any of it.
    const queued = await sql(cfg,
      "SELECT COUNT(*) AS n FROM integration_outbox WHERE `status` IN ('pending','sending')");
    assert.ok(Number(queued[0].n) >= 5, `the rows are queued, not lost: ${queued[0].n}`);
  });
});
