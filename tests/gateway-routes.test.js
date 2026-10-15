/* The gateway's whole surface, exercised against a real server over a real
 * socket, with real tokens minted by Forge's own minting module.
 *
 * TLS is the one thing not exercised here: the handler is mounted on an http
 * server so the test needs no certificate authority. What TLS protects is the
 * wire, which is a deployment property (gateway/README.md, and the self-test
 * button in Settings checks it on the real machine); what these tests are about
 * is what the gateway will and will not DO, which is identical either way.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const gwServer = require('../gateway/src/server');
const gwRouter = require('../gateway/src/router');
const gwTokens = require('../gateway/src/tokens');
const gwConfig = require('../gateway/src/config');
const paths = require('../gateway/src/paths');
const minter = require('../src/server-tokens');

const GATEWAY_ID = 'GW-TEST';

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rt-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-st-'));
  fs.mkdirSync(path.join(root, paths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alpha', 'render.psd'), Buffer.alloc(2048, 5));
  fs.writeFileSync(path.join(root, 'Beta', 'secret.psd'), 'not yours');

  const keys = minter.generate();
  const callbacks = [];
  const local = {
    fileRoot: root, stateDir, gatewayId: GATEWAY_ID, gatewaySecret: 'x'.repeat(64),
    forgeUrl: 'https://forge.example.com', listenAddress: '127.0.0.1', listenPort: 0,
    rateLimitPerMinute: 10000, heartbeatSeconds: 3600, configSeconds: 3600,
    tlsCert: null, tlsKey: null,
  };
  const gw = gwServer.create({
    local,
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  // The configuration a running gateway would have pulled from Forge.
  Object.assign(gw.ctx, {
    config: () => gwConfig.shape({
      version: 7, maxFileBytes: 1024 * 1024, chunkBytes: 64 * 1024,
      keys: [{ kid: keys.kid, publicKey: keys.publicKey }], sharedFolders: ['Shared'],
    }),
    callback: (kind, data) => callbacks.push({ kind, data }),
  });
  const server = http.createServer((req, res) => gw.handler(req, res));
  return { root, stateDir, keys, gw, server, callbacks, local };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function token(keys, op, relative, extra = {}) {
  return minter.mint({ privateKey: keys.privateKey, kid: keys.kid, audience: GATEWAY_ID, userId: 'u-ana', op, path: relative, ...extra }).token;
}

async function call(base, method, p, { token: tok, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a download is bytes */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('the router IS the surface: this exact set of routes, and nothing else', () => {
  /* The point of this assertion is the absence of things. If anybody adds a
     DELETE, a rename, a move, an overwrite or a second way to read the share,
     this fails — which is the studio's hard rule made mechanical rather than
     remembered. Editing it is meant to be a deliberate act with a reason. */
  assert.deepStrictEqual(gwRouter.ROUTES.map((r) => `${r.method} ${r.path}`), [
    'GET /health',
    'GET /v1/app',
    'GET /v1/list',
    'POST /v1/folder',
    'PUT /v1/upload/:id/chunk',
    'GET /v1/upload/:id/status',
    'POST /v1/upload/:id/complete',
    'GET /v1/download',
    'PUT /v1/selftest',
    'GET /v1/selftest',
  ]);
  const verbs = new Set(gwRouter.ROUTES.map((r) => r.method));
  assert.deepStrictEqual([...verbs].sort(), ['GET', 'POST', 'PUT'],
    'no DELETE and no PATCH: there is no verb here that could remove or alter a stored file');
  // And no route name suggests one, which is the second half of the same rule.
  for (const r of gwRouter.ROUTES) {
    assert.ok(!/delete|remove|rename|move|overwrite|replace/i.test(r.path), `${r.path} must not exist`);
  }
});

test('every other route and verb is refused, DELETE loudest of all', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  for (const [method, p] of [['DELETE', '/v1/download'], ['DELETE', '/v1/list'],
    ['PATCH', '/v1/list'], ['POST', '/v1/download'], ['PUT', '/v1/list'], ['DELETE', '/v1/upload/x/chunk']]) {
    const r = await call(base, method, p);
    assert.strictEqual(r.status, 405, `${method} ${p} should be 405`);
    assert.match(r.json.error, /not something this gateway does/);
  }
  for (const p of ['/v1/delete', '/v1/rename', '/v1/move', '/v1/files', '/', '/v1', '/v1/upload']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const r = await call(base, method, p);
      assert.strictEqual(r.status, 404, `${method} ${p} should be 404`);
    }
  }
});

test('/health says only that it is up', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const r = await call(base, 'GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true });
  // Nothing about the share, the studio, the version or the configuration.
  assert.strictEqual(/root|share|version|config|key|secret/i.test(r.text), false, r.text);
});

test('a token is required, and every way of being wrong is refused', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  const cases = [
    ['no token', undefined, 403],
    ['nonsense', 'not-a-token', 403],
    ['alg none', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'forge', aud: GATEWAY_ID, sub: 'u', op: 'list', path: '', exp: Math.floor(Date.now() / 1000) + 30, jti: 'x' })).toString('base64url')}.`, 403],
  ];
  for (const [why, tok, status] of cases) {
    const r = await call(base, 'GET', '/v1/list?path=Alpha', { token: tok });
    assert.strictEqual(r.status, status, `${why}: ${r.text}`);
  }
  // Wrong audience: a token for another gateway must not work on this one.
  const other = minter.mint({ privateKey: h.keys.privateKey, kid: h.keys.kid, audience: 'GW-SOMEWHERE-ELSE', userId: 'u', op: 'list', path: 'Alpha' }).token;
  assert.strictEqual((await call(base, 'GET', '/v1/list?path=Alpha', { token: other })).json.reason, 'audience');
  // Wrong operation: a list token cannot download.
  const listTok = token(h.keys, 'list', 'Alpha');
  assert.strictEqual((await call(base, 'GET', '/v1/download?path=Alpha/render.psd', { token: listTok })).json.reason, 'operation');
  // Expired.
  const old = minter.mint({ privateKey: h.keys.privateKey, kid: h.keys.kid, audience: GATEWAY_ID, userId: 'u', op: 'list', path: 'Alpha', now: Date.now() - 120000 }).token;
  const expired = await call(base, 'GET', '/v1/list?path=Alpha', { token: old });
  assert.strictEqual(expired.status, 401);
  assert.strictEqual(expired.json.reason, 'expired');
  // Signed by a key the gateway does not have.
  const stranger = minter.generate();
  const forged = minter.mint({ privateKey: stranger.privateKey, kid: stranger.kid, audience: GATEWAY_ID, userId: 'u', op: 'list', path: 'Alpha' }).token;
  assert.strictEqual((await call(base, 'GET', '/v1/list?path=Alpha', { token: forged })).json.reason, 'kid');
});

test('a download token works once and then never again', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const tok = token(h.keys, 'download', 'Alpha/render.psd');

  const first = await call(base, 'GET', `/v1/download?path=Alpha/render.psd&token=${encodeURIComponent(tok)}`);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(Buffer.byteLength(first.text, 'binary'), 2048);
  assert.match(first.headers.get('content-disposition'), /^attachment;/);
  assert.strictEqual(first.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(first.headers.get('content-type'), 'application/octet-stream');

  const second = await call(base, 'GET', `/v1/download?path=Alpha/render.psd&token=${encodeURIComponent(tok)}`);
  assert.strictEqual(second.status, 401);
  assert.strictEqual(second.json.reason, 'replay');
});

test('a list token is multi-use within its folder, and reaches no further', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const tok = token(h.keys, 'list', 'Alpha');

  // Multi-use: pagination is several calls with one token.
  for (let i = 0; i < 3; i += 1) {
    const r = await call(base, 'GET', '/v1/list?path=Alpha', { token: tok });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.entries.map((e) => e.name), ['render.psd']);
  }
  // A subfolder of what was granted is fine; a sibling is not.
  const outside = await call(base, 'GET', '/v1/list?path=Beta', { token: tok });
  assert.strictEqual(outside.status, 403);
  assert.match(outside.json.error, /does not reach that folder/);
  // And neither is a traversal dressed up as a subfolder.
  for (const p of ['Alpha/../Beta', 'Alpha/../../etc', '/etc', 'Alpha%2f..%2fBeta']) {
    const r = await call(base, 'GET', `/v1/list?path=${encodeURIComponent(p)}`, { token: tok });
    assert.ok(r.status === 403 || r.status === 404, `${p} gave ${r.status}`);
  }
});

test('a client path is never trusted over the token, even for a download', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  // A token for Alpha/render.psd, pointed at Beta/secret.psd.
  const tok = token(h.keys, 'download', 'Alpha/render.psd');
  const r = await call(base, 'GET', `/v1/download?path=Beta/secret.psd&token=${encodeURIComponent(tok)}`);
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /different folder/);
});

test('an upload goes up in chunks, resumes, and is reported to Forge', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  const body = crypto.randomBytes(100 * 1024);
  const uploadId = crypto.randomUUID();
  const tok = minter.mint({
    privateKey: h.keys.privateKey, kid: h.keys.kid, audience: GATEWAY_ID, userId: 'u-ana',
    op: 'upload', path: 'Alpha', uploadId, maxBytes: body.length, name: 'new.psd',
  }).token;

  const chunk = 32 * 1024;
  // First two chunks, then ask what arrived, then the rest — a page reload in
  // the middle of a large upload, which is the case this exists for.
  for (const i of [0, 1]) {
    const slice = body.subarray(i * chunk, Math.min((i + 1) * chunk, body.length));
    const r = await call(base, 'PUT', `/v1/upload/${uploadId}/chunk?offset=${i * chunk}`, { token: tok, raw: slice, headers: { 'content-type': 'application/octet-stream' } });
    assert.strictEqual(r.status, 200, r.text);
  }
  const mid = await call(base, 'GET', `/v1/upload/${uploadId}/status`, { token: tok });
  assert.deepStrictEqual(mid.json.received, [[0, 2 * chunk]]);
  assert.strictEqual(mid.json.complete, false);

  for (const i of [2, 3]) {
    const slice = body.subarray(i * chunk, Math.min((i + 1) * chunk, body.length));
    await call(base, 'PUT', `/v1/upload/${uploadId}/chunk?offset=${i * chunk}`, { token: tok, raw: slice, headers: { 'content-type': 'application/octet-stream' } });
  }
  const done = await call(base, 'POST', `/v1/upload/${uploadId}/complete`, { token: tok, body: {} });
  assert.strictEqual(done.status, 200, done.text);
  assert.strictEqual(done.json.path, 'Alpha/new.psd');
  assert.deepStrictEqual(fs.readFileSync(path.join(h.root, 'Alpha', 'new.psd')), body);

  const kinds = h.callbacks.map((c) => c.kind);
  assert.ok(kinds.includes('upload_completed'), `Forge should be told: ${kinds.join(',')}`);
  const sent = h.callbacks.find((c) => c.kind === 'upload_completed');
  assert.strictEqual(sent.data.id, uploadId, 'idempotent by the upload id');
  assert.strictEqual(sent.data.size, body.length);
});

test('an upload token is bound to its own upload id', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const mine = crypto.randomUUID();
  const theirs = crypto.randomUUID();
  const tok = minter.mint({ privateKey: h.keys.privateKey, kid: h.keys.kid, audience: GATEWAY_ID, userId: 'u', op: 'upload', path: 'Alpha', uploadId: mine, maxBytes: 10, name: 'a.psd' }).token;
  const r = await call(base, 'PUT', `/v1/upload/${theirs}/chunk?offset=0`, { token: tok, raw: Buffer.alloc(5), headers: { 'content-type': 'application/octet-stream' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.reason, 'uid');
});

test('the gateway enforces the size and extension rules it pulled from Forge', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  // maxFileBytes in this harness is 1 MB. A token claiming more is refused
  // even though Forge signed it: the share is the gateway's to protect.
  const big = minter.mint({ privateKey: h.keys.privateKey, kid: h.keys.kid, audience: GATEWAY_ID, userId: 'u', op: 'upload', path: 'Alpha', uploadId: crypto.randomUUID(), maxBytes: 50 * 1024 * 1024, name: 'huge.psd' });
  const r1 = await call(base, 'PUT', `/v1/upload/${big.claims.uid}/chunk?offset=0`, { token: big.token, raw: Buffer.alloc(16), headers: { 'content-type': 'application/octet-stream' } });
  assert.strictEqual(r1.status, 413, r1.text);

  const exe = minter.mint({ privateKey: h.keys.privateKey, kid: h.keys.kid, audience: GATEWAY_ID, userId: 'u', op: 'upload', path: 'Alpha', uploadId: crypto.randomUUID(), maxBytes: 16, name: 'payload.exe' });
  const r2 = await call(base, 'PUT', `/v1/upload/${exe.claims.uid}/chunk?offset=0`, { token: exe.token, raw: Buffer.alloc(16), headers: { 'content-type': 'application/octet-stream' } });
  assert.strictEqual(r2.status, 415, r2.text);
});

test('a folder is created exclusively, and never over an existing one', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const tok = token(h.keys, 'mkdir', 'Alpha');

  const made = await call(base, 'POST', '/v1/folder', { token: tok, body: { path: 'Alpha', name: 'scenes' } });
  assert.strictEqual(made.status, 201, made.text);
  assert.ok(fs.existsSync(path.join(h.root, 'Alpha', 'scenes')));

  const again = await call(base, 'POST', '/v1/folder', { token: token(h.keys, 'mkdir', 'Alpha'), body: { path: 'Alpha', name: 'scenes' } });
  assert.strictEqual(again.status, 409);
  assert.match(again.json.error, /already there/);

  const escape = await call(base, 'POST', '/v1/folder', { token: token(h.keys, 'mkdir', 'Alpha'), body: { path: 'Alpha', name: '../../evil' } });
  assert.strictEqual(escape.status, 400);
  assert.strictEqual(fs.existsSync(path.join(h.root, '..', 'evil')), false);
});

test('Range requests work, because a 40 GB download is resumed not restarted', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const r = await fetch(`${base}/v1/download?path=Alpha/render.psd&token=${encodeURIComponent(token(h.keys, 'download', 'Alpha/render.psd'))}`, {
    headers: { range: 'bytes=100-199' },
  });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 100-199/2048');
  assert.strictEqual((await r.arrayBuffer()).byteLength, 100);
});

test('CORS is Forge and nobody else', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  const good = await fetch(`${base}/health`, { headers: { origin: 'https://forge.example.com' } });
  assert.strictEqual(good.headers.get('access-control-allow-origin'), 'https://forge.example.com');

  for (const origin of ['https://evil.example', 'http://forge.example.com', 'https://forge.example.com.evil.test', 'null']) {
    const bad = await fetch(`${base}/health`, { headers: { origin } });
    assert.strictEqual(bad.headers.get('access-control-allow-origin'), null, `${origin} must not be allowed`);
  }
  // And never the wildcard, which would make every page on the internet a client.
  const any = await fetch(`${base}/health`, { headers: { origin: 'https://forge.example.com' } });
  assert.notStrictEqual(any.headers.get('access-control-allow-origin'), '*');
});

test('the self-test writes and reads a kilobyte inside .incoming and cleans up', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());

  const put = await call(base, 'PUT', '/v1/selftest', { token: token(h.keys, 'selftest', ''), raw: Buffer.alloc(1024, 3), headers: { 'content-type': 'application/octet-stream' } });
  assert.strictEqual(put.status, 200, put.text);
  const got = await call(base, 'GET', '/v1/selftest', { token: token(h.keys, 'selftest', '') });
  assert.strictEqual(got.status, 200, got.text);
  assert.strictEqual(got.json.bytes, 1024);
  assert.strictEqual(got.json.cleaned, true);

  // Nothing in the studio's folders, and nothing left in .incoming either.
  assert.deepStrictEqual(fs.readdirSync(path.join(h.root, 'Alpha')), ['render.psd']);
  const left = fs.readdirSync(path.join(h.root, paths.INCOMING, 'selftest'));
  assert.deepStrictEqual(left, [], 'the self-test blob is removed when it is read back');
});

test('the office link page is served, scoped to Forge, and reads nothing from the share', async (t) => {
  const h = harness();
  const base = await listen(h.server);
  t.after(() => h.server.close());
  const r = await call(base, 'GET', '/v1/app');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /forge-gateway/);
  assert.ok(r.text.includes('https://forge.example.com'), 'the page only talks to the configured Forge origin');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  // It needs no token precisely because it carries no data: nothing from the
  // share is in it, and every call it later makes carries a token of its own.
  assert.strictEqual(/render\.psd|secret\.psd/.test(r.text), false);
});

test('the mint and the verifier agree about how long each kind of token lives', () => {
  /* Two codebases, one table each, and a mismatch is either an outage (Forge
     mints longer than the gateway accepts) or a false promise (the studio is
     told sixty seconds and gets an hour). Pinned against each other rather
     than each against a number written twice. */
  assert.deepStrictEqual(
    minter.LIFETIMES,
    Object.fromEntries(Object.entries(gwTokens.OPS).map(([op, def]) => [op, def.maxSeconds]))
  );
  // And the single-use ones are the ones that travel in a URL or act once.
  assert.deepStrictEqual(
    Object.entries(gwTokens.OPS).filter(([, d]) => d.single).map(([op]) => op).sort(),
    ['download', 'mkdir']
  );
});
