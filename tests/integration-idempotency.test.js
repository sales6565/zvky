/* Idempotency on the integration API: the same request twice, one effect.
 *
 * WHAT THESE TESTS HAVE TO SEE is not the response — a replay and a fresh
 * execution return the same body, deliberately, so the response cannot tell them
 * apart. What matters is whether the caller's work RAN, which is why the probe
 * route counts its own executions and writes a row on the transaction. A test
 * that only counted rows in integration_requests would pass while the business
 * write and its record committed separately, which is the one failure this whole
 * arrangement exists to prevent.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');

const cfg = config('idempotency');
const SECRET = 'inbound-secret-for-the-test-suite-only';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('the pure parts: what is hashed, and what is guarded', () => {
  const idem = require('../src/integration-idempotency');

  assert.strictEqual(idem.hashBody('{"a":1}'), sha256('{"a":1}'));
  assert.strictEqual(idem.hashBody(''), sha256(''), 'an empty body still hashes to something');
  assert.strictEqual(idem.hashBody(undefined), sha256(''), 'and so does no body at all');

  /* THE RAW BYTES, not a re-serialization. {"a":1,"b":2} and {"b":2,"a":1} mean
     the same thing and are not the same request: the signature was taken over
     one of them, and hashing a re-serialization would let the other replay it. */
  const raw = '{"b":2,"a":1}';
  assert.strictEqual(idem.requestHash({ rawBody: raw, body: { a: 1, b: 2 } }), sha256(raw));
  assert.notStrictEqual(idem.requestHash({ rawBody: raw, body: { a: 1, b: 2 } }),
    sha256(JSON.stringify({ a: 1, b: 2 })), 'the parsed body is not what is hashed');

  // Reads change nothing, so a repeat of one is not a thing to protect against.
  assert.deepStrictEqual([...idem.GUARDED_METHODS].sort(), ['DELETE', 'POST', 'PUT']);
  assert.ok(!idem.GUARDED_METHODS.has('GET'));

  assert.strictEqual(idem.RETENTION_DAYS, 7, 'the window the spec asks for');
  assert.strictEqual(idem.MAX_KEY_LENGTH, 191, 'the width of the column it is stored in');
});

test('the safety net for a handler that forgets the helper', () => {
  /* requireKey makes sure a key arrived; nothing makes sure anybody used it. A
     route that mutates and never calls withIdempotency is silently
     non-idempotent, which is the kind of gap only ever found by the retry that
     duplicated something — so it says so in the log. Tested here rather than
     through a route, because testing it through a route would mean keeping a
     permanently non-idempotent endpoint around to test it with. */
  const idem = require('../src/integration-idempotency');
  const { EventEmitter } = require('node:events');

  const run = (req, statusCode = 200) => {
    const said = [];
    const res = new EventEmitter();
    res.statusCode = statusCode;
    idem.warnIfUnused((m) => said.push(m))(req, res, () => {});
    res.emit('finish');
    return said;
  };

  const mutating = { method: 'POST', originalUrl: '/api/integration/thing?x=1' };
  assert.match(run({ ...mutating })[0], /without going through withIdempotency/);
  assert.match(run({ ...mutating })[0], /\/api\/integration\/thing/, 'and names the route');

  assert.deepStrictEqual(run({ ...mutating, idempotencyHandled: true }), [],
    'a handler that used it is not nagged');
  assert.deepStrictEqual(run({ method: 'GET', originalUrl: '/api/integration/thing' }), [],
    'and a read was never the concern');
  assert.deepStrictEqual(run({ ...mutating }, 500), [],
    'nor is a request that already failed — the failure is the story, not this');
});

test('idempotency, against a running server', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEY = 'idem-key-0123456789abcdef';
  const OTHER = 'other-key-0123456789abcde';

  /* Signs exactly the bytes it sends, like the service-auth suite: an HMAC over
     a re-serialized object is not an HMAC over what arrived — and here the same
     bytes are also what gets hashed for the idempotency record. */
  const call = async (path, {
    key = KEY, body = {}, method = 'POST', idem = crypto.randomUUID(), rawBody = null,
  } = {}) => {
    const raw = rawBody !== null ? rawBody : (body === null ? '' : JSON.stringify(body));
    const stamp = Math.floor(Date.now() / 1000);
    const target = `/api${path}`;
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.${method.toUpperCase()}.${target}.${raw}`).digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'X-Integration-Key': key,
      'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
    };
    if (idem !== null) headers['Idempotency-Key'] = idem;
    const res = await fetch(`${server.base}${path}`, { method, headers, body: raw || undefined });
    return {
      status: res.status,
      replay: res.headers.get('idempotent-replay'),
      body: await res.json().catch(() => ({})),
    };
  };

  // The counter, read through the API rather than guessed at. A GET, so it needs
  // no key of its own and cannot itself disturb what it is reporting.
  const counter = async (name = 'probe') => {
    const r = await call(`/integration/counter?counter=${encodeURIComponent(name)}`,
      { method: 'GET', body: null, idem: null });
    return r.body.count;
  };

  const rowsFor = async (idemKey) => (await sql(cfg,
    'SELECT client_id, endpoint, request_hash, response_status, response_body '
    + 'FROM integration_requests WHERE idempotency_key = ?', [idemKey]));

  const outboxCount = async () => Number((await sql(cfg,
    'SELECT COUNT(*) AS n FROM integration_outbox'))[0].n);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      INTEGRATION_INBOUND_SECRET: SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    const add = (name, presented, actions, active = 1) => sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, ?)',
      [name, sha256(presented), presented.slice(0, 8), actions, active]);
    await add('Dev and QA', KEY, 'counter,ping');
    await add('Second Tool', OTHER, 'counter,ping');
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('a mutation with no Idempotency-Key is refused', async () => {
    const r = await call('/integration/counter', { idem: null });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /idempotency-key/i);
    assert.strictEqual(r.body.header, 'idempotency-key');

    /* AND ON A ROUTE THAT NEVER CALLS withIdempotency, which is the only case
       that tests the middleware rather than the helper: /ping does not open a
       transaction, so a 400 here can have come from nowhere else. This is the
       half that covers a handler somebody forgets to wire up. */
    const ping = await call('/integration/ping', { idem: null });
    assert.strictEqual(ping.status, 400,
      `the blanket check must not depend on the handler: ${JSON.stringify(ping.body)}`);
    assert.strictEqual(ping.body.header, 'idempotency-key');
  });

  await t.test('and one whose key is too long for the column it is stored in', async () => {
    const r = await call('/integration/counter', { idem: 'k'.repeat(192) });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /192 characters.*limit is 191/);
  });

  await t.test('a GET needs no key at all', async () => {
    const r = await call('/integration/counter', { method: 'GET', body: null, idem: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(typeof r.body.count, 'number');
  });

  await t.test('the first call runs, and is recorded in the same transaction', async () => {
    const before = await counter('first');
    const outboxBefore = await outboxCount();
    const idem = crypto.randomUUID();

    const r = await call('/integration/counter', { body: { counter: 'first' }, idem });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.count, before + 1, 'the caller\'s work ran');
    assert.strictEqual(r.replay, null, 'a first call is not a replay');

    const rows = await rowsFor(idem);
    assert.strictEqual(rows.length, 1, 'one idempotency row');
    assert.strictEqual(rows[0].response_status, 200);
    assert.strictEqual(rows[0].endpoint, 'POST /api/integration/counter');
    assert.strictEqual(rows[0].request_hash, sha256(JSON.stringify({ counter: 'first' })),
      'the hash is over the bytes that arrived');
    assert.deepStrictEqual(JSON.parse(rows[0].response_body), { counter: 'first', count: before + 1 });
    assert.strictEqual(await outboxCount(), outboxBefore + 1, 'and the business write committed with it');
  });

  await t.test('the same key and the same body replays, and runs nothing', async () => {
    const idem = crypto.randomUUID();
    const body = { counter: 'replay' };

    const first = await call('/integration/counter', { body, idem });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const after = await counter('replay');
    const outboxAfter = await outboxCount();

    const again = await call('/integration/counter', { body, idem });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.replay, 'true', 'the header that tells the caller this is a replay');
    assert.deepStrictEqual(again.body, first.body, 'the stored response, byte for byte');

    assert.strictEqual(await counter('replay'), after,
      'THE POINT OF ALL THIS: the counter did not move, so the work did not run');
    assert.strictEqual(await outboxCount(), outboxAfter, 'and no second business write');
    assert.strictEqual((await rowsFor(idem)).length, 1, 'still one record');
  });

  await t.test('the same key with a different body is 422, and runs nothing', async () => {
    const idem = crypto.randomUUID();
    await call('/integration/counter', { body: { counter: 'clash' }, idem });
    const after = await counter('clash');
    const outboxAfter = await outboxCount();

    const r = await call('/integration/counter', { body: { counter: 'clash', extra: 1 }, idem });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /already used for a request with a different body/);
    assert.strictEqual(r.replay, null, 'a refusal is not a replay');

    assert.strictEqual(await counter('clash'), after, 'the work did not run');
    assert.strictEqual(await outboxCount(), outboxAfter);
    // And it said nothing about what the first request was.
    assert.ok(!JSON.stringify(r.body).includes('count'), 'the first response is not leaked');
  });

  await t.test('a failed attempt leaves nothing behind, and the same key retries cleanly', async () => {
    const idem = crypto.randomUUID();
    const before = await counter('rollback');
    const outboxBefore = await outboxCount();

    const failed = await call('/integration/counter', { body: { counter: 'rollback', fail: true }, idem });
    assert.ok(failed.status >= 500, `the failure is reported: ${failed.status}`);

    /* fn RAN — the in-memory counter moved, because memory is not in the
       transaction. That is what makes the next two assertions meaningful rather
       than vacuous: the work was genuinely attempted, and the database still
       shows no trace of it. */
    assert.strictEqual(await counter('rollback'), before + 1, 'the work was attempted');
    assert.strictEqual(await outboxCount(), outboxBefore,
      'the business write rolled back — this is the atomicity claim');
    assert.strictEqual((await rowsFor(idem)).length, 0, 'and no idempotency row was written');

    // So the same key is free to be used again, which is the whole reason for
    // recording only on success.
    const retry = await call('/integration/counter', { body: { counter: 'rollback' }, idem });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.replay, null, 'a retry after a failure is a fresh run, not a replay');
    assert.strictEqual(retry.body.count, before + 2, 'and it ran');
    assert.strictEqual((await rowsFor(idem)).length, 1, 'now there is a record');
    assert.strictEqual(await outboxCount(), outboxBefore + 1);
  });

  await t.test('a refusal the handler returned is not remembered either', async () => {
    /* Only a SUCCESS is recorded. A 4xx the handler chose to return is not a
       state to hold the caller in for seven days — their corrected request has to
       be allowed to run, and it will usually carry the same key, because the
       caller has no reason to think the first attempt counted. */
    const idem = crypto.randomUUID();
    const before = await counter('refused');

    const no = await call('/integration/counter', { body: { counter: 'refused', reject: true }, idem });
    assert.strictEqual(no.status, 409, JSON.stringify(no.body));
    assert.strictEqual(await counter('refused'), before + 1, 'the handler did run and decide');
    assert.strictEqual((await rowsFor(idem)).length, 0, 'and nothing was remembered');

    const fixed = await call('/integration/counter', { body: { counter: 'refused' }, idem });
    assert.strictEqual(fixed.status, 200,
      `the same key must work after a refusal: ${JSON.stringify(fixed.body)}`);
    assert.strictEqual(fixed.replay, null, 'and it runs rather than replaying the 409');
    assert.strictEqual((await rowsFor(idem)).length, 1);
  });

  await t.test('the key belongs to the credential that chose it', async () => {
    /* Two credentials picking the same string are two different requests. The
       table was created with idempotency_key alone as its primary key and its
       own DDL called scoping a decision about the API; this is that decision
       asserted, because without it the second caller is handed the first one's
       response — a cross-tenant leak wearing a cache's clothes. */
    const shared = `shared-${crypto.randomUUID()}`;
    const body = { counter: 'scoped' };
    const before = await counter('scoped');

    const mine = await call('/integration/counter', { body, idem: shared });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));

    const theirs = await call('/integration/counter', { body, idem: shared, key: OTHER });
    assert.strictEqual(theirs.status, 200, JSON.stringify(theirs.body));
    assert.strictEqual(theirs.replay, null, 'the other credential is not replaying my response');
    assert.strictEqual(await counter('scoped'), before + 2, 'both ran');

    const rows = await rowsFor(shared);
    assert.strictEqual(rows.length, 2, 'one row each');
    assert.notStrictEqual(rows[0].client_id, rows[1].client_id);
  });

  await t.test('two identical requests at the same instant commit once', async () => {
    /* THE RACE, and the exact shape of what is guaranteed here — which is worth
       being precise about rather than comfortable about.
     *
     * The lookup cannot prevent this: both requests find nothing and both
     * proceed. What prevents a double effect is the PRIMARY KEY, on insert, and
     * that is a guarantee about the TRANSACTION and nothing else. So:
     *
     *   committed effects   exactly one — one outbox row, one record
     *   both responses      the same answer, the winner's
     *   fn itself           may be ENTERED TWICE
     *
     * The counter below proves that last line rather than hiding it. It lives in
     * memory, memory is not in the transaction, and so it shows two where the
     * database shows one. Any side effect fn performs that is NOT on the
     * connection it was handed — an email, a file, a call to somebody else's
     * API — behaves like that counter. See src/integration-idempotency.js.
     */
    const idem = crypto.randomUUID();
    const body = { counter: 'race' };
    const before = await counter('race');
    const outboxBefore = await outboxCount();

    const [a, b] = await Promise.all([
      call('/integration/counter', { body, idem }),
      call('/integration/counter', { body, idem }),
    ]);

    assert.deepStrictEqual([a.status, b.status], [200, 200], `${a.status} / ${b.status}`);
    assert.deepStrictEqual(a.body, b.body, 'both callers got the same answer');
    assert.strictEqual(await outboxCount(), outboxBefore + 1,
      'EXACTLY ONE committed effect, however they interleaved');
    assert.strictEqual((await rowsFor(idem)).length, 1, 'and exactly one record');
    assert.ok(a.replay === 'true' || b.replay === 'true',
      'the loser was answered with the winner\'s response, not a 500 for work that succeeded');

    // And the honest half: fn was entered twice, which is why only transactional
    // work is safe inside it.
    assert.strictEqual(await counter('race'), before + 2,
      'fn ran twice — the non-transactional counter is the evidence, and the caveat');
  });

  await t.test('the seven-day window is swept, and only past it', async () => {
    const idem = require('../src/integration-idempotency');
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db = { query: async (text, params) => {
      const [rows] = await conn.query(text.replace(/\$(\d+)/g, '?'), params || []);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };

    try {
      const client = (await sql(cfg, 'SELECT id FROM integration_clients LIMIT 1'))[0].id;
      const seed = (key, daysAgo) => db.query(
        'INSERT INTO integration_requests '
        + '(idempotency_key, client_id, endpoint, request_hash, response_status, created_at) '
        + `VALUES (?, ?, 'POST /x', ?, 200, NOW() - INTERVAL ${daysAgo} DAY)`,
        [key, client, sha256(key)]
      );
      await seed('sweep-old', 8);
      await seed('sweep-edge', 6);

      const result = await idem.sweep(db);
      assert.strictEqual(result.days, 7);
      assert.ok(result.removed >= 1, `something was removed: ${result.removed}`);

      const left = await sql(cfg,
        "SELECT idempotency_key FROM integration_requests WHERE idempotency_key LIKE 'sweep-%'");
      const keys = left.map((r) => r.idempotency_key);
      assert.ok(!keys.includes('sweep-old'), 'eight days old is forgotten');
      assert.ok(keys.includes('sweep-edge'), 'six days old is still remembered');
    } finally {
      await conn.end();
    }
  });
});
