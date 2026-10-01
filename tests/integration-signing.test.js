/* The signature on Dev & QA's calls, as a hosted deployment sees it.
 *
 * Starts a real server whose INTEGRATION_INBOUND_SECRET was pasted with a line break
 * after it (as a hosting screen can keep one), and calls it the way Dev & QA does:
 * the exact /events request the worker makes, several query parameters, a query a
 * proxy reordered, a wrong secret, an unknown key, a stale timestamp. Also checks the
 * fingerprint and that a refused signature is logged with safe facts only.
 * (Dev & QA's own repository runs its real client against this server too.)
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');
const secrets = require('../src/integration-secrets');

const cfg = config('signing');
const SECRET = crypto.randomBytes(32).toString('hex').slice(0, 64);
const WRONG = crypto.randomBytes(32).toString('hex');
const KEY = crypto.randomBytes(32).toString('hex');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

test('the secret inspection rules', () => {
  const ok = secrets.inspect('S', SECRET);
  assert.strictEqual(ok.value, SECRET);
  assert.strictEqual(ok.fingerprint, `sha256:${sha256(SECRET).slice(0, 12)}`);
  assert.deepStrictEqual(ok.notes, []);
  const pasted = secrets.inspect('S', ` ${SECRET}\r\n`);
  assert.strictEqual(pasted.value, SECRET, 'surrounding whitespace is ignored');
  assert.strictEqual(pasted.fingerprint, ok.fingerprint, 'and the fingerprint is the same');
  assert.match(pasted.notes[0], /spaces or line breaks around it/);
  for (const bad of [`"${SECRET}"`, `'${SECRET}'`]) assert.match(secrets.inspect('S', bad).problem, /wrapped in quotes/);
  assert.match(secrets.inspect('S', `${SECRET.slice(0, 30)} ${SECRET.slice(30)}`).problem, /space or line break inside/);
  assert.match(secrets.inspect('S', `${SECRET}$#`).notes[0], /other than letters and digits/);
  assert.match(secrets.inspect('S', 'short').notes[0], /shorter than 32/);
  assert.notStrictEqual(secrets.inspect('S', WRONG).fingerprint, ok.fingerprint, 'different secrets, different fingerprints');
});

test('a quoted secret is refused as a configuration problem, never stripped', () => {
  const saved = process.env.INTEGRATION_INBOUND_SECRET;
  process.env.INTEGRATION_INBOUND_SECRET = `"${SECRET}"`;
  try {
    const sa = require('../src/middleware/service-auth');
    const r = sa.verifySignature({ get: () => 't=1, v1=00', method: 'GET', originalUrl: '/api/integration/v1/events', url: '/events', baseUrl: '/api/integration/v1', rawBody: '' });
    assert.strictEqual(r.status, 503);
    assert.match(r.error, /wrapped in quotes/);
  } finally { if (saved === undefined) delete process.env.INTEGRATION_INBOUND_SECRET; else process.env.INTEGRATION_INBOUND_SECRET = saved; }
});

test('canonical targets: as received, mounted, and with the query in a fixed order', () => {
  const sa = require('../src/middleware/service-auth');
  const t = sa.canonicalTargets({ originalUrl: '/api/integration/v1/handoffs?project_id=p1&limit=5', baseUrl: '/api/integration/v1', url: '/handoffs?project_id=p1&limit=5' });
  assert.deepStrictEqual(t, ['/api/integration/v1/handoffs?project_id=p1&limit=5', '/api/integration/v1/handoffs?limit=5&project_id=p1']);
  // A repeated name keeps its values' order, so a reordering that changes meaning does not verify.
  const r = sa.canonicalTargets({ originalUrl: '/x?b=2&a=1&a=0', baseUrl: '', url: '/x?b=2&a=1&a=0' });
  assert.strictEqual(r[r.length - 1], '/x?a=1&a=0&b=2');
});

test('signed calls against a running server', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  await resetSchema(cfg);
  // Pasted with a trailing line break, as a hosting screen can keep one.
  const server = await startServer(cfg, { INTEGRATION_INBOUND_SECRET: `${SECRET}\n`, INTEGRATION_INBOUND_SECRET_PREVIOUS: '', INTEGRATION_TEST_ENDPOINTS: '' });
  t.after(() => stopServer(server));
  await sql(cfg, 'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) VALUES (UUID(), ?, ?, ?, ?, 1)',
    ['devqa-signing', sha256(KEY), KEY.slice(0, 8), 'health,clients,projects,handoffs,feedback,events']);
  const origin = server.base.replace(/\/api$/, '');

  // Exactly what Dev & QA sends: X-Integration-Key, and "t=<unix>, v1=<hex>" over t.METHOD.target.body.
  async function call(target, { secret = SECRET, key = KEY, signedTarget = target, at = Math.floor(Date.now() / 1000) } = {}) {
    const res = await fetch(origin + target, { headers: { Accept: 'application/json', 'X-Integration-Key': key,
      'X-Integration-Signature': `t=${at}, v1=${hmac(secret, `${at}.GET.${signedTarget}.`)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  await t.test('the start-up log names the fingerprint, and the stray line break', () => {
    const out = server.output();
    assert.match(out, new RegExp(`Integration inbound signing key fingerprint: sha256:${sha256(SECRET).slice(0, 12)}`));
    assert.match(out, /INTEGRATION_INBOUND_SECRET had spaces or line breaks around it; they were ignored/);
    assert.ok(!out.includes(SECRET), 'never the secret');
  });

  await t.test('the exact /events request the worker makes', async () => {
    const r = await call('/api/integration/v1/events?since=0&limit=200');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.events));
  });

  await t.test('every read-only endpoint, with several query parameters', async () => {
    for (const target of ['/api/integration/v1/health', '/api/integration/v1/clients?limit=200', '/api/integration/v1/projects?limit=200',
      '/api/integration/v1/handoffs?limit=200&project_id=none', '/api/integration/v1/feedback?client_bug_id=b1&source_app=devqa']) {
      const r = await call(target);
      assert.strictEqual(r.status, 200, `${target}: ${JSON.stringify(r.body)}`);
    }
  });

  await t.test('a query reordered on the way (signed in fixed order, arrives in another)', async () => {
    const r = await call('/api/integration/v1/handoffs?project_id=none&limit=200', { signedTarget: '/api/integration/v1/handoffs?limit=200&project_id=none' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // and the order the deployed Dev & QA uses, signed as sent
    assert.strictEqual((await call('/api/integration/v1/events?since=0&limit=200')).status, 200);
  });

  await t.test('a signature over a different target, or with a different secret, is refused', async () => {
    assert.strictEqual((await call('/api/integration/v1/events?since=5&limit=200', { signedTarget: '/api/integration/v1/events?since=0&limit=200' })).status, 401);
    const r = await call('/api/integration/v1/events?since=0&limit=200', { secret: WRONG });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.error, 'The request signature does not match.');
  });

  await t.test('a refused signature is logged with safe facts, and says the key was recognised', async () => {
    const out = server.output();
    const line = out.split('\n').find((l) => l.includes('signature mismatch: GET /api/integration/v1/events (query: since, limit'));
    assert.ok(line, out.slice(-2000));
    assert.match(line, /body 0 bytes; signed -?\d+s ago; received signature 64 hex chars, expected 64/);
    assert.match(line, new RegExp(`Inbound signing key sha256:${sha256(SECRET).slice(0, 12)}`));
    assert.match(line, /API key recognised \(devqa-signing\)/);
    for (const s of [SECRET, WRONG, KEY]) assert.ok(!out.includes(s), 'no secret, key or signature in the log');
    assert.ok(!/v1=[0-9a-f]{64}/.test(out));
  });

  await t.test('a bad key and a bad signature are told apart', async () => {
    const unknown = crypto.randomBytes(32).toString('hex');
    const r = await call('/api/integration/v1/health', { key: unknown });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.error, 'That integration key is not recognised.', 'right signature, unknown key');
    await call('/api/integration/v1/health', { key: unknown, secret: WRONG });
    assert.match(server.output(), /signature mismatch: GET \/api\/integration\/v1\/health .*API key not recognised/);
    const forbidden = await call('/api/integration/v1/assets/x');
    assert.strictEqual(forbidden.status, 403, 'right signature and key, action not granted');
  });

  await t.test('replay protection still holds', async () => {
    const old = await call('/api/integration/v1/health', { at: Math.floor(Date.now() / 1000) - 400 });
    assert.strictEqual(old.status, 401);
    assert.match(old.body.error, /out of date/);
    const future = await call('/api/integration/v1/health', { at: Math.floor(Date.now() / 1000) + 400 });
    assert.strictEqual(future.status, 401);
  });
});
