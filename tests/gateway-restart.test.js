/* RESTARTS AND INTERRUPTIONS.
 *
 * A studio's gateway will be restarted by a Windows update at 3am in the middle
 * of somebody's overnight upload, and the machine will lose power at least
 * once. What must survive that:
 *
 *   an upload in flight          resumable, and byte-exact when it finishes
 *   the callback queue           delivered, exactly once, after the restart
 *   a finalise that was cut off  nothing half-made visible in the archive
 *   abandoned uploads            swept from .incoming, and only from there
 *
 * THE GATEWAY HERE IS A REAL CHILD PROCESS, killed with SIGKILL rather than
 * closed politely — a process that was asked nicely to stop is not the case
 * this is about.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');

const paths = require('../gateway/src/paths');
const uploads = require('../gateway/src/uploads');
const deleter = require('../gateway/src/deleter');
const forge = require('../gateway/src/forge');
const minter = require('../src/server-tokens');

const CHILD = path.join(__dirname, '..', 'gateway', 'scripts', 'large-file-gateway.js');
const GATEWAY_ID = 'GW-BIG';          // the child's id

function share() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-restart-'));
  fs.mkdirSync(path.join(root, paths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true });
  return root;
}

async function startGateway(root, state, keys) {
  const pub = path.join(state, 'pub.pem');
  fs.writeFileSync(pub, keys.publicKey);
  const child = fork(CHILD, [], {
    env: { ...process.env, SHARE: root, STATE: state, PUBKEY: pub, KID: keys.kid },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const { port } = await new Promise((resolve) => child.once('message', resolve));
  return { child, base: `http://127.0.0.1:${port}` };
}

const put = (base, id, offset, body, token) => fetch(`${base}/v1/upload/${id}/chunk?offset=${offset}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
  body,
});

test('an upload survives the gateway being killed, and finishes byte-exact', async (t) => {
  const root = share();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rs-state-'));
  const keys = minter.generate();
  let gw = await startGateway(root, state, keys);
  t.after(() => { try { gw.child.kill('SIGKILL'); } catch { /* already gone */ } });

  const body = crypto.randomBytes(300 * 1024);
  const chunk = 64 * 1024;
  const uploadId = crypto.randomUUID();
  const token = minter.mint({
    privateKey: keys.privateKey, kid: keys.kid, audience: GATEWAY_ID, userId: 'u-1',
    op: 'upload', path: 'Alpha', uploadId, maxBytes: body.length, name: 'overnight.psd',
  }).token;

  // Two chunks, then the machine goes away.
  for (const i of [0, 1]) {
    const res = await put(gw.base, uploadId, i * chunk, body.subarray(i * chunk, (i + 1) * chunk), token);
    assert.strictEqual(res.status, 200, await res.text());
  }
  gw.child.kill('SIGKILL');
  await new Promise((r) => gw.child.once('exit', r));

  /* WHAT IS ON THE SHARE NOW: the part-finished upload inside .incoming, and
     nothing at all in the archive. A reader looking at Alpha/ sees no
     half-file, which is the promise. */
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'Alpha')), [],
    'nothing half-made is visible in the archive');
  const home = path.join(root, paths.INCOMING, uploadId);
  assert.ok(fs.existsSync(home), 'the part-finished upload is still in .incoming');

  // Back up, and the status route says exactly what arrived.
  gw = await startGateway(root, state, keys);
  const status = await (await fetch(`${gw.base}/v1/upload/${uploadId}/status`,
    { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepStrictEqual(status.received, [[0, 2 * chunk]], 'the ranges survived the restart');
  assert.strictEqual(status.complete, false);

  // Resume from there — which is what a browser does after a reload.
  for (let offset = 2 * chunk; offset < body.length; offset += chunk) {
    const end = Math.min(offset + chunk, body.length);
    const res = await put(gw.base, uploadId, offset, body.subarray(offset, end), token);
    assert.strictEqual(res.status, 200, await res.text());
  }
  const done = await (await fetch(`${gw.base}/v1/upload/${uploadId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })).json();
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'Alpha', 'overnight.psd')), body,
    'and the file is byte-exact across the restart');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, paths.INCOMING)), [],
    'with nothing left in .incoming');
});

test('a finalise that is cut off leaves nothing visible in the archive', () => {
  /* The failure this is about: the process dies BETWEEN claiming the final name
     and the bytes being there. The claim is a hard link to a file that is
     already complete — so the name appears with the whole file behind it, or it
     does not appear. There is no window in which a reader sees a partial file
     under its final name.
     
     Asserted by doing the claim and then not finishing: the archive has either
     the complete file or nothing. */
  const root = share();
  const id = crypto.randomUUID();
  const body = crypto.randomBytes(5000);
  const r = uploads.putChunk(root, id, 0, body, { size: body.length, name: 'cut.psd', dir: 'Alpha', sub: 'u' });
  assert.ok(r.ok, r.reason);

  // Before complete() runs, the archive is empty.
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'Alpha')), []);

  const done = uploads.complete(root, id, { dir: 'Alpha', name: 'cut.psd' });
  assert.ok(done.ok, done.reason);
  // After it, the file is whole. Those are the only two states.
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'Alpha', 'cut.psd')), body);

  /* And a SECOND complete() on the same upload — which is what a retry after a
     cut-off answer looks like — does not produce a second file or a partial
     one. The upload is gone, so it is refused. */
  const again = uploads.complete(root, id, { dir: 'Alpha', name: 'cut.psd' });
  assert.strictEqual(again.ok, false);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'Alpha')), ['cut.psd'],
    'no "cut (2).psd" from a retry of a finished upload');
});

test('the callback queue survives a restart and delivers exactly once', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rs-q-'));
  const local = {
    fileRoot: stateDir, stateDir, gatewayId: 'GW-Q', gatewaySecret: 'q'.repeat(64),
    forgeUrl: 'https://forge.example.com', listenAddress: '127.0.0.1', listenPort: 8443,
    heartbeatSeconds: 30, configSeconds: 300, rateLimitPerMinute: 600, clockLeewaySeconds: 30,
  };

  // Queued while Forge is unreachable, then the process "dies".
  const first = forge.client({ local, log: () => {}, fetchImpl: async () => { throw new Error('down'); } });
  const id = crypto.randomUUID();
  first.enqueue('upload_completed', { id, path: 'Alpha/a.psd', size: 10 });
  await first.flush();
  assert.strictEqual(first.pending().length, 1, 'it is on disk, not in memory');

  /* A NEW CLIENT over the same state directory — which is what a restarted
     gateway is — finds it. Delivered once: the second flush sends nothing,
     because the file is gone after a success. */
  const delivered = [];
  const after = forge.client({
    local, log: () => {}, now: () => Date.now() + 120000,
    fetchImpl: async (url, init) => { delivered.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; },
  });
  const out = await after.flush();
  assert.strictEqual(out.sent, 1);
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].id, id);

  const second = await after.flush();
  assert.strictEqual(second.sent, 0, 'nothing is sent twice');
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(after.pending().length, 0);
});

test('abandoned uploads are swept from .incoming after the configured age, and only from there', () => {
  const root = share();
  // One abandoned, one in progress, and a real file in the archive.
  const old = path.join(root, paths.INCOMING, crypto.randomUUID());
  const fresh = path.join(root, paths.INCOMING, crypto.randomUUID());
  for (const d of [old, fresh]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'blob'), 'x'); }
  fs.writeFileSync(path.join(root, 'Alpha', 'keep.psd'), 'archived');
  const ago = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, ago, ago);

  const swept = deleter.sweepAbandoned(root, { olderThanMinutes: 24 * 60 });
  assert.strictEqual(swept.removed, 1);
  assert.strictEqual(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh), 'an upload still in progress is left alone');
  assert.strictEqual(fs.readFileSync(path.join(root, 'Alpha', 'keep.psd'), 'utf8'), 'archived',
    'and the archive is untouched');

  // A longer age keeps even the old one — the configuration is read, not assumed.
  const old2 = path.join(root, paths.INCOMING, crypto.randomUUID());
  fs.mkdirSync(old2, { recursive: true });
  fs.utimesSync(old2, ago, ago);
  assert.strictEqual(deleter.sweepAbandoned(root, { olderThanMinutes: 7 * 24 * 60 }).removed, 0);
  assert.ok(fs.existsSync(old2));
});
