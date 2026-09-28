/* The integration API's front door: address, signature, credential, action.
 *
 * FOUR LOCKS IN A ROW, and what is asserted here is that each one holds on its
 * own — a chain where three checks pass because the fourth already refused is
 * a chain with three checks nobody has tested.
 *
 * NO PERSON IS INVOLVED. There is no JWT here, no req.user and no
 * req.permissions: a credential is a machine, and routing it through the gates
 * built for designations would make every projectScope and ownership check in
 * the codebase start answering questions about a build server. The last test
 * in this file asserts that absence directly, because it is the kind of thing a
 * later convenience quietly undoes.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');

const cfg = config('serviceauth');

const SECRET = 'inbound-secret-for-the-test-suite-only';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('the signature payload and the timing-safe compare, with no server', () => {
  const sa = require('../src/middleware/service-auth');

  assert.strictEqual(sa.signingPayload(123, 'post', '/api/integration/ping', '{"a":1}'),
    '123.POST./api/integration/ping.{"a":1}', 'the method is upper-cased and the parts joined by dots');

  assert.deepStrictEqual(sa.parseSignature('t=1, v1=abc'), { t: '1', v1: 'abc' });
  assert.deepStrictEqual(sa.parseSignature(' t=1 ,  v1=abc '), { t: '1', v1: 'abc' },
    'spacing is the caller\'s business, not a failure');
  assert.deepStrictEqual(sa.parseSignature('t=1, v1=abc, v2=xyz').v1, 'abc',
    'an unknown version is ignored rather than refused, so adding v2 later breaks no caller');

  assert.strictEqual(sa.safeEqualHex('abcd', 'abcd'), true);
  assert.strictEqual(sa.safeEqualHex('abcd', 'abce'), false);
  /* timingSafeEqual THROWS on a length mismatch — which would be both a 500 and
     a timing signal. Answered as an ordinary mismatch instead. */
  assert.strictEqual(sa.safeEqualHex('abc', 'abcd'), false, 'a length mismatch must not throw');
  assert.strictEqual(sa.safeEqualHex('', ''), false, 'and empty is never a match');
  assert.strictEqual(sa.safeEqualHex(undefined, undefined), false);

  assert.strictEqual(sa.MAX_SKEW_SECONDS, 300);
});

test('the integration front door', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEYS = {
    live: 'live-key-0123456789abcdef',
    off: 'inactive-key-0123456789abc',
    narrow: 'narrow-key-0123456789abcd',
  };

  /* Signs and sends exactly the bytes it signed. The api() helper in
     tests/helpers.js re-serializes its body, which is fine everywhere else and
     useless here: an HMAC over a re-serialized object is not an HMAC over what
     arrived. */
  const call = async (path, {
    key = KEYS.live, body = { hello: 'world' }, method = 'POST',
    t: stamp = Math.floor(Date.now() / 1000), secret = SECRET, signature = null,
    omitSignature = false, omitKey = false,
  } = {}) => {
    const raw = body === null ? '' : JSON.stringify(body);
    const target = `/api${path}`;
    const v1 = signature !== null ? signature : crypto.createHmac('sha256', secret)
      .update(`${stamp}.${method.toUpperCase()}.${target}.${raw}`).digest('hex');
    const headers = { 'Content-Type': 'application/json' };
    if (!omitKey) headers['X-Integration-Key'] = key;
    if (!omitSignature) headers['X-Integration-Signature'] = `t=${stamp}, v1=${v1}`;
    const res = await fetch(`${server.base}${path}`, { method, headers, body: raw || undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const boot = async (extraEnv = {}) => {
    if (server) await stopServer(server);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token',
      WORK_HOURS_SWEEP_MINUTES: '0',
      INTEGRATION_INBOUND_SECRET: SECRET,
      ...extraEnv,
    });
  };

  t.before(async () => {
    await resetSchema(cfg);
    await boot();
    // Three credentials, inserted as the real thing would be: the key itself is
    // never stored, only its hash.
    const add = (name, key, actions, active) => sql(cfg,
      `INSERT INTO integration_clients (id, \`name\`, key_hash, key_prefix, allowed_actions, is_active)
       VALUES (UUID(), '${name}', '${sha256(key)}', '${key.slice(0, 8)}', '${actions}', ${active})`);
    await add('Dev and QA', KEYS.live, 'ping,assets', 1);
    await add('Retired Tool', KEYS.off, 'ping', 0);
    await add('Narrow Tool', KEYS.narrow, 'assets', 1);
  });
  t.after(() => stopServer(server));

  // --- the signature ---------------------------------------------------------

  await t.test('a correctly signed request gets through', async () => {
    const r = await call('/integration/ping');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.client, 'Dev and QA');
    assert.strictEqual(r.body.action, 'ping');
    assert.deepStrictEqual(r.body.echo, { hello: 'world' },
      'and the body survived being read for the signature and parsed as JSON');
  });

  await t.test('a wrong signature is refused', async () => {
    const wrong = await call('/integration/ping', { signature: 'f'.repeat(64) });
    assert.strictEqual(wrong.status, 401, JSON.stringify(wrong.body));
    assert.match(wrong.body.error, /signature does not match/);

    // Signed with the right shape and the wrong secret — the realistic failure.
    const other = await call('/integration/ping', { secret: 'not-the-inbound-secret' });
    assert.strictEqual(other.status, 401);

    /* THE ONE THAT MATTERS MOST: signed correctly, then the body changed. This
       is what the HMAC is for, and it only holds because the raw bytes are kept
       before express.json() sees them. */
    const stamp = Math.floor(Date.now() / 1000);
    const signedFor = JSON.stringify({ hello: 'world' });
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.POST./api/integration/ping.${signedFor}`).digest('hex');
    const res = await fetch(`${server.base}/integration/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': KEYS.live,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
      },
      body: JSON.stringify({ hello: 'tampered' }),
    });
    assert.strictEqual(res.status, 401, 'a body changed after signing must not verify');
  });

  await t.test('an expired signature is refused, in both directions', async () => {
    const old = await call('/integration/ping', { t: Math.floor(Date.now() / 1000) - 301 });
    assert.strictEqual(old.status, 401, JSON.stringify(old.body));
    assert.match(old.body.error, /out of date/);

    /* A timestamp far in the FUTURE is as much a replay as one far in the past,
       and is what a caller with a wrong clock actually sends. */
    const ahead = await call('/integration/ping', { t: Math.floor(Date.now() / 1000) + 301 });
    assert.strictEqual(ahead.status, 401, JSON.stringify(ahead.body));

    // And just inside the window still works.
    const fresh = await call('/integration/ping', { t: Math.floor(Date.now() / 1000) - 290 });
    assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  });

  await t.test('a missing signature or key is refused', async () => {
    const noSig = await call('/integration/ping', { omitSignature: true });
    assert.strictEqual(noSig.status, 401);
    assert.match(noSig.body.error, /x-integration-signature/i);

    const noKey = await call('/integration/ping', { omitKey: true });
    assert.strictEqual(noKey.status, 401);
    assert.match(noKey.body.error, /x-integration-key/i);
  });

  // --- the credential --------------------------------------------------------

  await t.test('inactive and unknown keys are refused, and are indistinguishable', async () => {
    const inactive = await call('/integration/ping', { key: KEYS.off });
    const unknown = await call('/integration/ping', { key: 'no-such-key-at-all-0123456' });
    assert.strictEqual(inactive.status, 401, JSON.stringify(inactive.body));
    assert.strictEqual(unknown.status, 401, JSON.stringify(unknown.body));
    /* THE SAME SENTENCE, on purpose: two different answers would let anybody
       enumerate which credentials this studio has issued by watching which came
       back. */
    assert.strictEqual(inactive.body.error, unknown.body.error,
      'a deactivated key must not be distinguishable from one that never existed');
  });

  await t.test('the key itself is never stored', async () => {
    const rows = await sql(cfg, 'SELECT key_hash, key_prefix FROM integration_clients');
    for (const row of rows) {
      assert.strictEqual(row.key_hash.length, 64, 'a SHA-256 hex digest');
      for (const key of Object.values(KEYS)) {
        assert.notStrictEqual(row.key_hash, key);
        assert.ok(!String(row.key_hash).includes(key), 'and not the key with anything around it');
      }
    }
  });

  await t.test('last_used_at is stamped on a successful call', async () => {
    await sql(cfg, "UPDATE integration_clients SET last_used_at = NULL WHERE `name` = 'Dev and QA'");
    assert.strictEqual((await call('/integration/ping')).status, 200);
    /* The stamp is written without being awaited, so the request can answer
       before it lands. Poll briefly rather than assume either way. */
    let stamped = null;
    for (let i = 0; i < 40 && !stamped; i += 1) {
      const [row] = await sql(cfg,
        "SELECT last_used_at FROM integration_clients WHERE `name` = 'Dev and QA'");
      stamped = row.last_used_at;
      if (!stamped) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(stamped, 'a successful call records when the credential was last used');
  });

  // --- the action ------------------------------------------------------------

  await t.test('an action outside allowed_actions is 403, not 401', async () => {
    /* Narrow Tool may do "assets" and not "ping". The status matters: 401 says
       "I do not know you", 403 says "I know you and the answer is no", and a
       caller debugging their credential needs to know which. */
    const r = await call('/integration/ping', { key: KEYS.narrow });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /not allowed to "ping"/);
    assert.deepStrictEqual(r.body.allowed, ['assets'], 'and it says what the key MAY do');

    // The same credential on an action it holds is fine — 404 from the router,
    // which is past every check in service-auth.
    const allowed = await call('/integration/assets', { key: KEYS.narrow });
    assert.strictEqual(allowed.status, 404,
      `"assets" is allowed, so this should reach the router: ${JSON.stringify(allowed.body)}`);
  });

  // --- the activity log ------------------------------------------------------

  await t.test('a write is attributed to integration:<name>, not to nobody', async () => {
    assert.strictEqual((await call('/integration/ping')).status, 200);

    let entry = null;
    for (let i = 0; i < 40 && !entry; i += 1) {
      const rows = await sql(cfg,
        `SELECT actor_id, actor_name, actor_role, method, path FROM activity_log
          WHERE path = '/api/integration/ping' ORDER BY seq DESC LIMIT 1`);
      entry = rows[0] || null;
      if (!entry) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(entry, 'the call is in the Activity Log');
    /* THE POINT. activity.record reads actor.NAME off an object — a bare string
       actor would record NULL here, which is the blank entry the actor call
       exists to prevent. */
    assert.strictEqual(entry.actor_name, 'integration:Dev and QA');
    assert.strictEqual(entry.actor_role, 'integration');
    assert.ok(entry.actor_id, 'and the credential id, so a revoked key\'s history stays findable');
  });

  await t.test('no person is invented: no req.user, no req.permissions', async () => {
    /* Asserted by reading the middleware, because the failure it guards against
       is a later convenience — "just set req.user so the existing helpers
       work" — which would make every ownership and projectScope check in the
       codebase start answering about a build server. */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'middleware', 'service-auth.js'), 'utf8');
    const code = src.split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    for (const forbidden of ['req.user =', 'req.permissions =', 'requirePermission', 'requireSuperAdmin']) {
      assert.ok(!code.includes(forbidden),
        `service-auth must not use ${forbidden} — a credential is not a person`);
    }
    assert.ok(code.includes('req.integration ='), 'it leaves req.integration instead');
  });

  // --- the address list ------------------------------------------------------

  await t.test('the new IP list ships in monitor mode: logs, does not block', async () => {
    /* Loopback is allowed before the list is consulted at all, so testing the
       list from 127.0.0.1 means switching that shortcut off. */
    await boot({ INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK: 'false' });
    await sql(cfg,
      "INSERT INTO integration_ip_allowlist (id, address, label) VALUES (UUID(), '203.0.113.7', 'somewhere else')");
    // The mirror is loaded at startup, so restart to pick the row up.
    await boot({ INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK: 'false' });

    const r = await call('/integration/ping');
    assert.strictEqual(r.status, 200,
      `monitor mode must not block: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.address.decision, 'would-deny',
      'and it must record that it would have');
    assert.ok(/MONITOR: would have denied/.test(server.output()),
      'and say so in the log, which is what somebody reads before switching to enforce');
  });

  await t.test('and refuses once somebody sets enforce deliberately', async () => {
    await boot({
      INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK: 'false',
      INTEGRATION_IP_ALLOWLIST_MODE: 'enforce',
    });
    const r = await call('/integration/ping');
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /not allowed to reach the integration API/);

    // An address on the list gets through, which is what enforce is for.
    await sql(cfg, "DELETE FROM integration_ip_allowlist");
    await sql(cfg,
      "INSERT INTO integration_ip_allowlist (id, address, label) VALUES (UUID(), '127.0.0.1', 'the test runner')");
    await boot({
      INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK: 'false',
      INTEGRATION_IP_ALLOWLIST_MODE: 'enforce',
    });
    const ok = await call('/integration/ping');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.address.decision, 'allowed');

    await boot();   // back to the default for anything after this
  });

  await t.test('the studio IP gate no longer governs this path', async () => {
    /* The studio's list is about which offices may sign in. Leaving it in front
       of the integration API would mean it silently decided whether a build
       server could reach it. */
    /* The studio gate only bites when its list is non-empty and loopback is not
       waved through, so arm it properly — an empty list is treated as "not
       configured" and opens, which would make the control half below prove
       nothing. */
    await sql(cfg, "DELETE FROM ip_allowlist");
    await sql(cfg,
      "INSERT INTO ip_allowlist (id, address, label) VALUES (UUID(), '198.51.100.9', 'somewhere else')");
    await boot({ IP_ALLOWLIST_MODE: 'enforce', IP_ALLOWLIST_ALLOW_LOOPBACK: 'false' });
    const mine = await call('/integration/ping');
    assert.strictEqual(mine.status, 200,
      `the studio gate must not block integration traffic: ${JSON.stringify(mine.body)}`);

    // And it still governs everything else.
    const studio = await fetch(`${server.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@zvky.test', password: 'x' }),
    });
    assert.strictEqual(studio.status, 403,
      'the studio path is still gated — otherwise this test proves nothing');

    await sql(cfg, "DELETE FROM ip_allowlist");
    await boot();
  });

  await t.test('no other route\'s body parsing changed', async () => {
    /* The raw capture is mounted ahead of the global express.json(), scoped to
       one path prefix. Two probes, because the first alone does not prove the
       scoping: a capture mounted globally would still hand JSON routes a parsed
       object, so JSON passing tells you nothing about where it is mounted.
       MULTIPART is the case that breaks — express.raw() reads the stream and
       sets req._body, after which multer finds no file — so an upload route is
       what actually holds the mount in place. */
    const r = await fetch(`${server.base}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test',
        password: 'ServiceAuth-Probe-1!',
      }),
    });
    const body = await r.json().catch(() => ({}));
    assert.strictEqual(r.status, 201,
      `an ordinary JSON route must still parse its body: ${JSON.stringify(body)}`);
    assert.strictEqual(body.user.email, 'root@zvky.test');

    const signIn = await fetch(`${server.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'root@zvky.test', password: 'ServiceAuth-Probe-1!' }),
    });
    const session = await signIn.json().catch(() => ({}));
    assert.strictEqual(signIn.status, 200, JSON.stringify(session));

    // A PNG only in its declared type, which is all the logo route inspects.
    const form = new FormData();
    form.append('logo', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')],
      { type: 'image/png' }), 'probe.png');
    const upload = await fetch(`${server.base}/branding/logo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: form,
    });
    const uploaded = await upload.json().catch(() => ({}));
    assert.strictEqual(upload.status, 200,
      `multipart uploads must still reach multer: ${JSON.stringify(uploaded)}`);
    assert.strictEqual(uploaded.branding.logoType, 'image/png');
  });

  await t.test('the traffic is rate limited, like sign-in is', async () => {
    /* The limiter sits AHEAD of serviceAuth on purpose: a caller hammering the
       door with rubbish credentials is the case that most needs bounding, and a
       limit that only applies once you are authenticated does not bound it.
       So this counts refused requests, which is what proves the order. */
    await boot({ INTEGRATION_RATE_MAX: '2', INTEGRATION_RATE_WINDOW_MINUTES: '5' });
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await call('/integration/ping', { signature: 'deadbeef' });
      codes.push(r.status);
    }
    assert.deepStrictEqual(codes.slice(0, 2), [401, 401],
      `the first two are judged on their merits: ${codes.join(',')}`);
    assert.ok(codes.slice(2).every((c) => c === 429),
      `and the rest are turned away by the limiter: ${codes.join(',')}`);
    await boot();
  });

  await t.test('the secret is required, never assumed absent means open', async () => {
    await boot({ INTEGRATION_INBOUND_SECRET: '' });
    const r = await call('/integration/ping');
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.error, /not configured/);
    await boot();
  });
});
