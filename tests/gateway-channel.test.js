/* The gateway's outbound channel: how it is signed, how configuration survives
   Forge being down, and how a callback survives everything. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const forge = require('../gateway/src/forge');
const signing = require('../gateway/src/signing');
const gwConfig = require('../gateway/src/config');
const serviceAuth = require('../src/middleware/service-auth');

const localFor = (stateDir, over = {}) => ({
  fileRoot: stateDir, stateDir, gatewayId: 'GW-1', gatewaySecret: 'k'.repeat(64),
  forgeUrl: 'https://forge.example.com', listenAddress: '127.0.0.1', listenPort: 8443,
  heartbeatSeconds: 30, configSeconds: 300, rateLimitPerMinute: 600, ...over,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ch-'));

test('the gateway signs exactly the way Forge already verifies', () => {
  /* The shape is defined in src/middleware/service-auth.js, which has verified
     the Dev & QA integration for months. gateway/src/signing.js restates it
     because that package ships alone, with no src/ beside it — so the restating
     is pinned HERE against the original rather than hoped to match. */
  const secret = 's'.repeat(64);
  const t = 1760000000;
  const body = JSON.stringify({ kind: 'upload_completed', id: 'abc' });
  const mine = signing.sign(secret, { method: 'POST', target: '/api/gateway/callback', body, t });

  const theirs = crypto.createHmac('sha256', secret)
    .update(serviceAuth.signingPayload(t, 'POST', '/api/gateway/callback', body))
    .digest('hex');

  assert.strictEqual(mine.v1, theirs, 'the two sides must compute the same HMAC');
  assert.strictEqual(signing.payload(t, 'post', '/x', 'b'), serviceAuth.signingPayload(t, 'post', '/x', 'b'));
  assert.strictEqual(signing.MAX_SKEW_SECONDS, serviceAuth.MAX_SKEW_SECONDS, 'and allow the same clock skew');
  // Parsed by the same parser, so "t=…, v1=…" cannot drift apart either.
  const parsed = serviceAuth.parseSignature(mine.header);
  assert.strictEqual(parsed.v1, theirs);
  assert.strictEqual(Number(parsed.t), t);
});

test('a signature covers the method, the path and the body — change any and it fails', () => {
  const secret = 'q'.repeat(64);
  const t = 1760000000;
  const base = signing.sign(secret, { method: 'POST', target: '/api/gateway/callback', body: '{"a":1}', t });
  const variants = [
    signing.sign(secret, { method: 'PUT', target: '/api/gateway/callback', body: '{"a":1}', t }),
    signing.sign(secret, { method: 'POST', target: '/api/gateway/heartbeat', body: '{"a":1}', t }),
    signing.sign(secret, { method: 'POST', target: '/api/gateway/callback', body: '{"a":2}', t }),
    signing.sign(secret, { method: 'POST', target: '/api/gateway/callback', body: '{"a":1}', t: t + 1 }),
    signing.sign('other-secret', { method: 'POST', target: '/api/gateway/callback', body: '{"a":1}', t }),
  ];
  for (const v of variants) assert.notStrictEqual(v.v1, base.v1);
});

test('configuration is cached, so the office keeps working while Forge is down', async () => {
  const stateDir = tmp();
  const local = localFor(stateDir);
  const good = {
    version: 12, maxFileBytes: 1024, chunkBytes: 256, parallelChunks: 2,
    deniedExtensions: ['EXE'], sharedFolders: ['Shared'],
    keys: [{ kid: 'k1', publicKey: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n' }],
  };
  const shaped = gwConfig.shape(good);
  assert.deepStrictEqual(shaped.deniedExtensions, ['.exe'], 'extensions are normalised to a leading dot, lower case');
  assert.strictEqual(gwConfig.writeCache(stateDir, shaped), true);

  // A fresh process with no Forge at all reads the last good answer.
  const back = gwConfig.readCache(stateDir);
  assert.strictEqual(back.version, 12);
  assert.strictEqual(back.cached, true);
  assert.strictEqual(back.keys.length, 1);

  // And with neither cache nor Forge: the documented limits, and NO keys — so
  // it serves nobody rather than serving everybody.
  const empty = gwConfig.readCache(tmp());
  assert.strictEqual(empty, null);
  assert.deepStrictEqual(gwConfig.DEFAULTS.keys, []);

  // A pull that fails leaves the cache alone.
  const client = forge.client({ local, fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }), log: () => {} });
  const r = await client.pullConfig();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(gwConfig.readCache(stateDir).version, 12, 'the cached configuration is still there');
});

test('the cache is written with owner-only permissions, because it holds public keys and limits', () => {
  const stateDir = tmp();
  gwConfig.writeCache(stateDir, gwConfig.shape({ version: 1 }));
  const mode = fs.statSync(gwConfig.cacheFile(stateDir)).mode & 0o777;
  assert.strictEqual(mode & 0o077, 0, `the cache should not be world or group readable (mode ${mode.toString(8)})`);
});

test('a callback is written to disk before it is sent, and survives a restart', async () => {
  const stateDir = tmp();
  const local = localFor(stateDir);
  let attempts = 0;
  const client = forge.client({
    local, log: () => {},
    fetchImpl: async () => { attempts += 1; throw new Error('office internet is out'); },
  });
  const { id } = client.enqueue('upload_completed', { id: crypto.randomUUID(), path: 'Alpha/a.psd', size: 10 });
  assert.strictEqual(client.pending().length, 1, 'queued on disk immediately');

  const first = await client.flush();
  assert.strictEqual(first.sent, 0);
  assert.strictEqual(first.held, 1);
  assert.strictEqual(attempts, 1);

  // Backoff: the next flush does not even try until the wait has passed.
  const second = await client.flush();
  assert.strictEqual(attempts, 1, 'held off rather than hammering');
  assert.strictEqual(second.held, 1);

  // A NEW client object over the same state directory — a restarted gateway —
  // finds the record and sends it when Forge comes back.
  let sentBody = null;
  const after = forge.client({
    local, log: () => {}, now: () => Date.now() + 60_000,
    fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '{}' }; },
  });
  const third = await after.flush();
  assert.strictEqual(third.sent, 1);
  assert.strictEqual(after.pending().length, 0);
  assert.strictEqual(sentBody.id, id, 'the same id, so a duplicate is recognisable as one');
  assert.strictEqual(sentBody.kind, 'upload_completed');
});

test('a callback Forge refuses permanently is dropped instead of blocking the queue', async () => {
  const stateDir = tmp();
  const lines = [];
  const client = forge.client({
    local: localFor(stateDir), log: (m) => lines.push(m),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{"error":"no such upload"}' }),
  });
  client.enqueue('upload_completed', { id: crypto.randomUUID(), path: 'a' });
  const out = await client.flush();
  assert.strictEqual(out.dropped, 1);
  assert.strictEqual(client.pending().length, 0);
  assert.ok(lines.some((l) => /permanently/.test(l)), 'and it says so in the log');
});

test('a 429 or a 5xx is retried, not dropped', async () => {
  for (const status of [408, 429, 500, 502, 503]) {
    const client = forge.client({
      local: localFor(tmp()), log: () => {},
      fetchImpl: async () => ({ ok: false, status, text: async () => 'later' }),
    });
    client.enqueue('checksum_ready', { id: crypto.randomUUID(), sha256: 'x' });
    const out = await client.flush();
    assert.strictEqual(out.held, 1, `HTTP ${status} should be retried`);
    assert.strictEqual(out.dropped, 0);
  }
});

test('the heartbeat says what Forge needs and nothing it does not', async () => {
  let body = null;
  let target = null;
  const client = forge.client({
    local: localFor(tmp()), log: () => {},
    fetchImpl: async (url, init) => { target = url; body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '{"ok":true}' }; },
  });
  const r = await client.heartbeat({ version: '1.0.0', configVersion: 7, freeBytes: 123, queued: 0 });
  assert.strictEqual(r.ok, true);
  assert.match(target, /\/api\/gateway\/heartbeat$/);
  assert.deepStrictEqual(Object.keys(body).sort(), ['configVersion', 'freeBytes', 'queued', 'version']);
  // No path, no file name, no user: a heartbeat is about the machine.
  assert.strictEqual(/path|file|user|token|secret/i.test(JSON.stringify(body)), false);
});

test('every outbound request carries the gateway id and a signature, and no secret', async () => {
  let headers = null;
  const client = forge.client({
    local: localFor(tmp()), log: () => {},
    fetchImpl: async (url, init) => { headers = init.headers; return { ok: true, status: 200, text: async () => '{}' }; },
  });
  await client.heartbeat({ version: '1' });
  assert.strictEqual(headers[signing.ID_HEADER], 'GW-1');
  assert.match(headers[signing.SIGNATURE_HEADER], /^t=\d+, v1=[0-9a-f]{64}$/);
  assert.strictEqual(JSON.stringify(headers).includes('k'.repeat(64)), false, 'the secret itself is never sent');
});

test('tokens and signatures are redacted everywhere a line could be logged', () => {
  const token = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  for (const line of [
    `GET /v1/download?path=a&token=${token}`,
    `Authorization: Bearer ${token}`,
    `x-gateway-signature: t=1760000000, v1=${'f'.repeat(64)}`,
    `failed to fetch https://forge.example.com/api/x?t=${token}`,
  ]) {
    const out = forge.redact(line);
    assert.strictEqual(out.includes(token), false, `token leaked: ${out}`);
    assert.strictEqual(out.includes('f'.repeat(64)), false, `signature leaked: ${out}`);
  }
  // And the redaction does not eat the useful part of the line.
  assert.match(forge.redact(`GET /v1/download?path=Alpha/a.psd&token=${token}`), /\/v1\/download\?path=Alpha\/a\.psd/);
});
