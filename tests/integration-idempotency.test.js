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

  /* The claim's states, and the window a claim is believed for. Two minutes is
     two of the outbox's minimum one-minute retry intervals: the first retry after
     a crash is still told to wait, the second takes the key over. Shorter than one
     interval and a healthy request would have its key stolen by its own retry,
     which is the duplicate execution all of this exists to prevent. */
  assert.deepStrictEqual(Object.keys(idem.STATUS).sort(), ['complete', 'failed', 'pending']);
  assert.strictEqual(idem.STALE_SECONDS, 120);
  assert.ok(idem.STALE_SECONDS > 60, 'longer than one retry interval, or a live claim gets stolen');

  // Two 4xx answers that mean opposite things to a machine: wait, versus you have
  // a bug. Distinct codes are the only way a client can tell them apart.
  assert.notStrictEqual(idem.IN_PROGRESS_CODE, idem.REUSED_CODE);
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

  const mutating = { method: 'POST', originalUrl: '/api/integration/v1/thing?x=1' };
  assert.match(run({ ...mutating })[0], /without going through withIdempotency/);
  assert.match(run({ ...mutating })[0], /\/api\/integration\/v1\/thing/, 'and names the route');

  assert.deepStrictEqual(run({ ...mutating, idempotencyHandled: true }), [],
    'a handler that used it is not nagged');
  assert.deepStrictEqual(run({ method: 'GET', originalUrl: '/api/integration/v1/thing' }), [],
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
      retryAfter: res.headers.get('retry-after'),
      body: await res.json().catch(() => ({})),
    };
  };

  // The counter, read through the API rather than guessed at. A GET, so it needs
  // no key of its own and cannot itself disturb what it is reporting.
  const counter = async (name = 'probe') => {
    const r = await call(`/integration/v1/counter?counter=${encodeURIComponent(name)}`,
      { method: 'GET', body: null, idem: null });
    return r.body.count;
  };

  const rowsFor = async (idemKey) => (await sql(cfg,
    'SELECT client_id, endpoint, request_hash, `status`, response_status, response_body '
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
    const r = await call('/integration/v1/counter', { idem: null });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /idempotency-key/i);
    assert.strictEqual(r.body.header, 'idempotency-key');

    /* AND ON A ROUTE THAT NEVER CALLS withIdempotency, which is the only case
       that tests the middleware rather than the helper: /ping does not open a
       transaction, so a 400 here can have come from nowhere else. This is the
       half that covers a handler somebody forgets to wire up. */
    const ping = await call('/integration/v1/ping', { idem: null });
    assert.strictEqual(ping.status, 400,
      `the blanket check must not depend on the handler: ${JSON.stringify(ping.body)}`);
    assert.strictEqual(ping.body.header, 'idempotency-key');
  });

  await t.test('and one whose key is too long for the column it is stored in', async () => {
    const r = await call('/integration/v1/counter', { idem: 'k'.repeat(192) });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /192 characters.*limit is 191/);
  });

  await t.test('a GET needs no key at all', async () => {
    const r = await call('/integration/v1/counter', { method: 'GET', body: null, idem: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(typeof r.body.count, 'number');
  });

  await t.test('the first call runs, and is recorded in the same transaction', async () => {
    const before = await counter('first');
    const outboxBefore = await outboxCount();
    const idem = crypto.randomUUID();

    const r = await call('/integration/v1/counter', { body: { counter: 'first' }, idem });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.count, before + 1, 'the caller\'s work ran');
    assert.strictEqual(r.replay, null, 'a first call is not a replay');

    const rows = await rowsFor(idem);
    assert.strictEqual(rows.length, 1, 'one idempotency row');
    assert.strictEqual(rows[0].response_status, 200);
    assert.strictEqual(rows[0].endpoint, 'POST /api/integration/v1/counter');
    assert.strictEqual(rows[0].request_hash, sha256(JSON.stringify({ counter: 'first' })),
      'the hash is over the bytes that arrived');
    assert.deepStrictEqual(JSON.parse(rows[0].response_body), { counter: 'first', count: before + 1 });
    assert.strictEqual(await outboxCount(), outboxBefore + 1, 'and the business write committed with it');
  });

  await t.test('the same key and the same body replays, and runs nothing', async () => {
    const idem = crypto.randomUUID();
    const body = { counter: 'replay' };

    const first = await call('/integration/v1/counter', { body, idem });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const after = await counter('replay');
    const outboxAfter = await outboxCount();

    const again = await call('/integration/v1/counter', { body, idem });
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
    await call('/integration/v1/counter', { body: { counter: 'clash' }, idem });
    const after = await counter('clash');
    const outboxAfter = await outboxCount();

    const r = await call('/integration/v1/counter', { body: { counter: 'clash', extra: 1 }, idem });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /already used for a request with a different body/);
    assert.strictEqual(r.replay, null, 'a refusal is not a replay');

    assert.strictEqual(await counter('clash'), after, 'the work did not run');
    assert.strictEqual(await outboxCount(), outboxAfter);
    // And it said nothing about what the first request was.
    assert.ok(!JSON.stringify(r.body).includes('count'), 'the first response is not leaked');
  });

  await t.test('a failed attempt keeps nothing it could replay, and the same key retries cleanly', async () => {
    const idem = crypto.randomUUID();
    const before = await counter('rollback');
    const outboxBefore = await outboxCount();

    const failed = await call('/integration/v1/counter', { body: { counter: 'rollback', fail: true }, idem });
    assert.ok(failed.status >= 500, `the failure is reported: ${failed.status}`);

    /* fn RAN — the in-memory counter moved, because memory is not in the
       transaction. That is what makes the next two assertions meaningful rather
       than vacuous: the work was genuinely attempted, and the database still
       shows no trace of it. */
    assert.strictEqual(await counter('rollback'), before + 1, 'the work was attempted');
    assert.strictEqual(await outboxCount(), outboxBefore,
      'the business write rolled back — this is the atomicity claim');

    /* THIS CHANGED when the claim moved ahead of fn, and the change is the point
       rather than a regression. The claim is committed on its own, so a rollback
       cannot reach it: there IS a row now, and what matters is that it is marked
       failed rather than holding an answer. A failed row is takeable immediately,
       which is what keeps the retry below clean — the observable behaviour the old
       "no row at all" assertion was really protecting. */
    const after = await rowsFor(idem);
    assert.strictEqual(after.length, 1, 'the claim survives its own rollback');
    assert.strictEqual(after[0].status, 'failed', 'and says so, rather than looking in flight');
    assert.strictEqual(after[0].response_status, null, 'with nothing to replay');

    // So the same key is free to be used again, which is the whole reason for
    // recording only on success.
    const retry = await call('/integration/v1/counter', { body: { counter: 'rollback' }, idem });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.replay, null, 'a retry after a failure is a fresh run, not a replay');
    assert.strictEqual(retry.body.count, before + 2, 'and it ran');
    const done = await rowsFor(idem);
    assert.strictEqual(done.length, 1, 'the same row, taken over rather than a second one');
    assert.strictEqual(done[0].status, 'complete');
    assert.strictEqual(await outboxCount(), outboxBefore + 1);
  });

  await t.test('a refusal the handler returned is not remembered either', async () => {
    /* Only a SUCCESS is recorded. A 4xx the handler chose to return is not a
       state to hold the caller in for seven days — their corrected request has to
       be allowed to run, and it will usually carry the same key, because the
       caller has no reason to think the first attempt counted. */
    const idem = crypto.randomUUID();
    const before = await counter('refused');

    const no = await call('/integration/v1/counter', { body: { counter: 'refused', reject: true }, idem });
    assert.strictEqual(no.status, 409, JSON.stringify(no.body));
    assert.strictEqual(await counter('refused'), before + 1, 'the handler did run and decide');
    const held = await rowsFor(idem);
    assert.strictEqual(held.length, 1, 'the claim is there, because it was committed before fn ran');
    assert.strictEqual(held[0].status, 'failed', 'released rather than recorded as an answer');
    assert.strictEqual(held[0].response_status, null, 'the 409 is not something to replay');

    const fixed = await call('/integration/v1/counter', { body: { counter: 'refused' }, idem });
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

    const mine = await call('/integration/v1/counter', { body, idem: shared });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));

    const theirs = await call('/integration/v1/counter', { body, idem: shared, key: OTHER });
    assert.strictEqual(theirs.status, 200, JSON.stringify(theirs.body));
    assert.strictEqual(theirs.replay, null, 'the other credential is not replaying my response');
    assert.strictEqual(await counter('scoped'), before + 2, 'both ran');

    const rows = await rowsFor(shared);
    assert.strictEqual(rows.length, 2, 'one row each');
    assert.notStrictEqual(rows[0].client_id, rows[1].client_id);
  });

  await t.test('a duplicate arriving mid-flight is told to wait, and does not run', async () => {
    /* THE CASE THE OLD ORDER COULD NOT HANDLE, made deterministic rather than
       raced: the first request holds its claim open, the second lands while it is
       genuinely in flight. Under check-run-record both entered fn and only their
       commits were deduplicated. Now the second never reaches fn at all.

       Deterministic on purpose — as a Promise.all race this would sometimes
       interleave the other way and pass without testing anything. */
    const idem = crypto.randomUUID();
    /* Long enough to land the duplicate inside it, short enough that this does not
       hold an open write transaction across a server shared with every other
       suite — a longer hold measurably caused failures in unrelated ones. */
    const body = { counter: 'inflight', hold: 250 };
    const before = await counter('inflight');

    const first = call('/integration/v1/counter', { body, idem });
    await new Promise((done) => { setTimeout(done, 80); });   // comfortably inside it

    const second = await call('/integration/v1/counter', { body, idem });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body.code, 'idempotency_in_progress',
      'its own code, so a client can tell this from a reused key');
    assert.notStrictEqual(second.body.code, 'idempotency_key_reused');
    assert.strictEqual(second.retryAfter, '2', 'and is told to come straight back');
    /* One execution in flight, and only one: the held request incremented the
       counter on its way in, the refused duplicate never got that far. `before`
       itself would be wrong here — the first request has already run. */
    assert.strictEqual(await counter('inflight'), before + 1,
      'THE GUARANTEE: the duplicate did not enter fn, so fn ran once, not twice');

    const done = await first;
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body.count, before + 1, 'and the first request ran exactly once');

    // Now that it has finished, the same key returns its real result.
    const later = await call('/integration/v1/counter', { body, idem });
    assert.strictEqual(later.status, 200, JSON.stringify(later.body));
    assert.strictEqual(later.replay, 'true');
    assert.deepStrictEqual(later.body, done.body, 'the retry gets the real answer it was promised');
    assert.strictEqual(await counter('inflight'), before + 1, 'still exactly one execution');
  });

  await t.test('two identical requests at the same instant: fn runs once', async () => {
    /* The same thing without the hold, which is how it actually arrives. Either
       ordering is acceptable — the loser may be told to wait or handed the real
       answer, depending on whether the winner had finished — but there is no
       ordering in which fn runs twice, and that is what this pins down.

       Contrast with what this asserted before the reservation existed: it had to
       accept a counter of two, because both requests entered fn and only the
       commits were deduplicated. */
    const idem = crypto.randomUUID();
    const body = { counter: 'race' };
    const before = await counter('race');
    const outboxBefore = await outboxCount();

    const [a, b] = await Promise.all([
      call('/integration/v1/counter', { body, idem }),
      call('/integration/v1/counter', { body, idem }),
    ]);

    assert.strictEqual(await counter('race'), before + 1,
      `fn ran exactly once, however they interleaved (${a.status}/${b.status})`);
    assert.strictEqual(await outboxCount(), outboxBefore + 1, 'and committed exactly one effect');
    assert.strictEqual((await rowsFor(idem)).length, 1, 'one record');

    const winner = [a, b].find((r) => r.status === 200 && r.replay === null);
    const loser = [a, b].find((r) => r !== winner);
    assert.ok(winner, `one of them ran it: ${JSON.stringify([a.body, b.body])}`);
    assert.ok(loser.replay === 'true' || loser.body.code === 'idempotency_in_progress',
      `the other was either replayed or told to wait, never refused oddly: ${JSON.stringify(loser)}`);
    if (loser.replay === 'true') assert.deepStrictEqual(loser.body, winner.body);
  });

  await t.test('a claim abandoned by a crash goes stale, and a retry takes it over', async () => {
    /* Without this, one crashed process would poison an idempotency key forever —
       a worse failure than the duplicate work the claim prevents, because nothing
       ever clears it.

       Written as a row rather than by killing a process mid-handler: what is under
       test is how a pending claim of a given age is treated, and back-dating it
       states that directly. TIMESTAMPDIFF and NOW() are second-resolution, so the
       age is set well clear of the boundary rather than one second past it. */
    const idem = `abandoned-${crypto.randomUUID()}`;
    const client = (await sql(cfg, 'SELECT id FROM integration_clients LIMIT 1'))[0].id;
    const body = { counter: 'stale' };
    const before = await counter('stale');

    await sql(cfg,
      'INSERT INTO integration_requests '
      + '(idempotency_key, client_id, endpoint, request_hash, `status`, created_at, updated_at) '
      + "VALUES (?, ?, 'POST /api/integration/v1/counter', ?, 'pending', "
      + 'NOW() - INTERVAL 600 SECOND, NOW() - INTERVAL 600 SECOND)',
      [idem, client, sha256(JSON.stringify(body))]);

    const r = await call('/integration/v1/counter', { body, idem });
    assert.strictEqual(r.status, 200, `the key is reusable once abandoned: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.replay, null, 'and it really ran rather than replaying a claim');
    assert.strictEqual(await counter('stale'), before + 1);

    const rows = await rowsFor(idem);
    assert.strictEqual(rows.length, 1, 'the same row was taken over, not duplicated');
    assert.strictEqual(rows[0].status, 'complete');
  });

  await t.test('but a claim that is merely young is not stolen from its own retry', async () => {
    /* The failure direction that matters most. If the staleness window were
       shorter than a caller's retry interval, a request that was simply slow would
       have its key taken by its own retry — and fn would run twice, which is the
       exact thing the reservation exists to prevent. A fresh pending claim must be
       refused, not reclaimed. */
    const idem = `young-${crypto.randomUUID()}`;
    const client = (await sql(cfg, 'SELECT id FROM integration_clients LIMIT 1'))[0].id;
    const body = { counter: 'young' };
    const before = await counter('young');

    await sql(cfg,
      'INSERT INTO integration_requests '
      + '(idempotency_key, client_id, endpoint, request_hash, `status`, updated_at) '
      + "VALUES (?, ?, 'POST /api/integration/v1/counter', ?, 'pending', NOW() - INTERVAL 30 SECOND)",
      [idem, client, sha256(JSON.stringify(body))]);

    const r = await call('/integration/v1/counter', { body, idem });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'idempotency_in_progress');
    assert.strictEqual(r.body.startedSecondsAgo, 30, 'and says how long it has been waiting');
    assert.strictEqual(await counter('young'), before, 'fn was not entered');
  });

  await t.test('a failed claim is takeable at once, whatever the body', async () => {
    /* STATUS IS CHECKED BEFORE THE HASH, and this is why. A failed attempt
       answered nothing, so a corrected body under the same key is not a conflict —
       it is the normal way a caller recovers. Checking the hash first would answer
       422 to exactly that, and the caller would have no way forward short of
       inventing a new key for work they already have one for. */
    const idem = `recovered-${crypto.randomUUID()}`;

    const failed = await call('/integration/v1/counter',
      { body: { counter: 'recovery', fail: true }, idem });
    assert.ok(failed.status >= 500, `${failed.status}`);
    assert.strictEqual((await rowsFor(idem))[0].status, 'failed');

    // A DIFFERENT body, same key, immediately.
    const fixed = await call('/integration/v1/counter', { body: { counter: 'recovery' }, idem });
    assert.strictEqual(fixed.status, 200,
      `a corrected body must be allowed after a failure: ${JSON.stringify(fixed.body)}`);
    assert.strictEqual((await rowsFor(idem))[0].status, 'complete');

    /* And once it HAS answered, the same key with a different body is a conflict
       again — the hash check is not gone, it is conditional on there being an
       answer to conflict with. */
    const clash = await call('/integration/v1/counter', { body: { counter: 'recovery', x: 1 }, idem });
    assert.strictEqual(clash.status, 422, JSON.stringify(clash.body));
    assert.strictEqual(clash.body.code, 'idempotency_key_reused');
  });

  await t.test('the migration does not mistake a finished row for a live claim', async () => {
    /* THE UPGRADE HAZARD, and it is the dangerous direction.
     *
     * Rows written before the reservation existed have no status column, and the
     * column's default is 'pending'. A finished row left describing itself as
     * pending would be read as an abandoned claim by the next caller to use that
     * key — who would take it over and overwrite a stored response somebody may
     * still retry for. So the migration backfills them, and this asserts that it
     * does, by putting the table back in its old shape and running the real
     * migration over it rather than by trusting the code to say so.
     */
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

      // Back to the old shape: no status, no updated_at, a response that is not null.
      await db.query('ALTER TABLE integration_requests DROP COLUMN `status`');
      await db.query('ALTER TABLE integration_requests DROP COLUMN updated_at');
      const old = `pre-upgrade-${crypto.randomUUID()}`;
      await db.query(
        'INSERT INTO integration_requests '
        + '(idempotency_key, client_id, endpoint, request_hash, response_status, response_body) '
        + "VALUES (?, ?, 'POST /api/integration/v1/counter', ?, 200, ?)",
        [old, client, sha256('{}'), JSON.stringify({ was: 'already answered' })]
      );

      /* ONLY THIS STEP, not the whole migration. Running all of them to reach one
         means dozens of DDL statements taking metadata locks on a server shared
         with every other suite, which made this test a measurable cause of
         failures in unrelated ones. */
      const migrate = require('../src/migrate');
      const step = migrate.STEPS.find(([name]) => name === 'integration idempotency reservation');
      assert.ok(step, 'the step must be in the list, or startup would never run it');
      await step[1](db, () => {});

      const rows = await sql(cfg,
        'SELECT `status`, response_status FROM integration_requests WHERE idempotency_key = ?', [old]);
      assert.strictEqual(rows.length, 1, 'the row survived the migration');
      assert.strictEqual(rows[0].status, 'complete',
        'a row that already held an answer is complete, not a claim somebody may seize');
      assert.strictEqual(Number(rows[0].response_status), 200, 'and its answer is untouched');
    } finally {
      await conn.end();
    }
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
