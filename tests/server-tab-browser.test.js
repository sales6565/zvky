/* THE SERVER TAB, IN A REAL BROWSER, AGAINST THE REAL GATEWAY.
 *
 * What a browser proves that a string assertion cannot: that the folder table
 * draws, that a drag-and-drop upload actually slices a file and sends it chunk
 * by chunk, that a reload resumes from the bytes already on the share, that a
 * download is a top-level link and not a buffered blob, that the deletion
 * modal is in the page rather than a native dialog — and that the bytes land on
 * disk, byte for byte, where the share says they should.
 *
 * REAL ON BOTH SIDES OF THE WIRE. The gateway here is the shipped package,
 * serving a temporary directory over http on loopback; the tokens are minted by
 * the shipped minter with a real Ed25519 key, and the gateway verifies them. Only
 * Forge's own API is a stub, and only because what is under test is the tab.
 *
 * NO NATIVE DIALOGS. The desktop application's web view has none (Prompt 39), so
 * window.alert, confirm and prompt are replaced with recorders that throw, and
 * every test fails if one is reached.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const gwServer = require('../gateway/src/server');
const gwConfig = require('../gateway/src/config');
const gwPaths = require('../gateway/src/paths');
const minter = require('../src/server-tokens');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : null,
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}) || null;
const SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

const GATEWAY_ID = 'GW-BROWSER';

/* ---- the page under test ------------------------------------------------- */

function fixture() {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  // The state object, the tab's own code, and the in-page question dialog —
  // all lifted, so this draws and behaves as the application does.
  const objFrom = PAGE.indexOf('const SRV = {');
  const objTo = PAGE.indexOf('\n};', objFrom) + 3;
  const codeFrom = PAGE.indexOf("const SRV_RESUME_KEY = 'zvkyServerUploads';");
  const codeTo = PAGE.indexOf('/* ---------- Settings → Server');
  const askFrom = PAGE.indexOf('const askWrap = document.getElementById');
  const askTo = PAGE.indexOf('window.askText = askText;') + 'window.askText = askText;'.length;
  assert.ok(objFrom > 0 && codeFrom > objTo && codeTo > codeFrom && askFrom > 0 && askTo > askFrom,
    'found the Server tab and the dialog helpers in the page');

  const askMarkupFrom = PAGE.indexOf('<div class="modal-wrap" id="askWrap">');
  const askMarkup = PAGE.slice(askMarkupFrom, PAGE.indexOf('</div>\n</div>', askMarkupFrom) + 13);

  const code = PAGE.slice(objFrom, objTo) + '\n' + PAGE.slice(codeFrom, codeTo);
  const ask = PAGE.slice(askFrom, askTo);

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  ${askMarkup}
  <div id="serverView"></div>
<script>
/* Native dialogs do not exist in the desktop web view. Anything reaching for
   one is a bug, so they throw here and the test sees it. */
window.__native = [];
for (const name of ['alert', 'confirm', 'prompt']) {
  window[name] = (...args) => { window.__native.push([name, String(args[0] || '')]); throw new Error('native ' + name); };
}
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function showToast(msg){ window.__toasts = window.__toasts || []; window.__toasts.push(String(msg));
  const t = document.getElementById('toast'); t.textContent = msg; }
function applyGate(){ /* no nav bar in the fixture */ }
/* The page's own api(), narrowed: what is under test is the tab, and the stub
   below is a real HTTP server minting real tokens. */
async function api(path, opts = {}){
  const res = await fetch('/api' + path, {
    method: (opts.method || 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) { const e = new Error((data && data.error) || ('HTTP ' + res.status)); e.status = res.status; e.body = data; throw e; }
  return data;
}
${ask}
${code}
window.__ready = true;
</script>
</body></html>`;
}

/* ---- Forge, stubbed, but minting real tokens ----------------------------- */

function forgeStub({ gatewayUrl, keys, state }) {
  const html = fixture();
  const requests = [];
  const mint = (op, relative, extra = {}) => minter.mint({
    privateKey: keys.privateKey, kid: keys.kid, audience: GATEWAY_ID,
    userId: 'u-root', op, path: relative, ...extra,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    const read = () => new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    });

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/api/server/state') {
      return send(200, {
        enabled: state.enabled, gatewayUrl, gatewayId: GATEWAY_ID,
        chunkBytes: state.chunkBytes, parallelChunks: 1, maxFileBytes: 64 * 1024 * 1024,
        deniedExtensions: ['.exe'], allowedExtensions: [],
        submitUploadEnabled: state.submitUploadEnabled, linkPrefix: state.linkPrefix,
        gateway: { lastSeen: new Date().toISOString(), ageSeconds: 2, online: true, version: '1.0.0', freeBytes: 1e12, configVersion: 1, queued: 0, staleAfterSeconds: 120 },
        roots: state.roots,
        openRequests: state.requests.filter((r) => r.status === 'open').map((r) => ({ id: r.id, path: r.path, type: r.type })),
        may: { download: true, upload: true, requestDelete: true, manageRequests: true, browseAll: true, viewAudit: true },
      });
    }
    if (url.pathname === '/api/server/token' && req.method === 'POST') {
      return read().then((body) => {
        requests.push(['token', body.op, body.path]);
        if (!state.enabled) return send(409, { error: 'off', code: 'feature_disabled' });
        const out = mint(body.op, body.path || '');
        send(200, { token: out.token, expiresAt: out.expiresAt, gatewayUrl, path: body.path || '' });
      });
    }
    if (url.pathname === '/api/server/upload-session' && req.method === 'POST') {
      return read().then((body) => {
        const uploadId = crypto.randomUUID();
        requests.push(['session', body.name, body.size]);
        /* THE FIRST TOKEN IS DELIBERATELY SHORT-LIVED when the test asks for it,
           so the renewal path is exercised rather than asserted about. */
        /* ALREADY EXPIRED, AND PAST THE LEEWAY — which takes both arguments.
           An upload token lives thirty minutes, so minting one in the past is
           not enough on its own; and the gateway allows ±30s of clock skew on
           expiry (gateway/src/tokens.js), so one second of life is not enough
           either. Issued two minutes ago with one second of life is expired by
           119 seconds however either side rounds it. */
        const out = mint('upload', body.path || '', { uploadId, maxBytes: body.size, name: body.name,
          ...(state.shortTokens ? { now: Date.now() - 120000, seconds: 1 } : {}) });
        send(200, { uploadId, token: out.token, gatewayUrl, path: body.path || '', name: body.name,
          chunkBytes: state.chunkBytes, parallelChunks: 1, renewed: false });
      });
    }
    const renew = url.pathname.match(/^\/api\/server\/upload-session\/([^/]+)\/renew$/);
    if (renew && req.method === 'POST') {
      return read().then((body) => {
        requests.push(['renew', renew[1]]);
        const out = mint('upload', body.path || '', { uploadId: renew[1], maxBytes: body.size, name: body.name });
        send(200, { uploadId: renew[1], token: out.token, gatewayUrl, path: body.path || '', name: body.name,
          chunkBytes: state.chunkBytes, parallelChunks: 1, renewed: true });
      });
    }
    if (url.pathname === '/api/server/deletion-requests' && req.method === 'POST') {
      return read().then((body) => {
        if (state.requests.some((r) => r.status === 'open' && r.path.toLowerCase() === String(body.path).toLowerCase())) {
          return send(409, { error: 'There is already an open deletion request for this.', code: 'already_requested' });
        }
        const row = { id: crypto.randomUUID(), path: body.path, type: body.type || 'file', reason: body.reason,
          status: 'open', requesterName: 'Root', createdAt: new Date().toISOString(), adminNote: null };
        state.requests.push(row);
        requests.push(['delete-request', body.path, body.reason]);
        send(201, { id: row.id, path: row.path, type: row.type, status: 'open', notified: 1 });
      });
    }
    if (url.pathname === '/api/server/deletion-requests') {
      return send(200, { requests: state.requests, mayManage: true });
    }
    const resolve = url.pathname.match(/^\/api\/server\/deletion-requests\/([^/]+)\/resolve$/);
    if (resolve && req.method === 'POST') {
      return read().then((body) => {
        const row = state.requests.find((r) => r.id === resolve[1]);
        if (row) { row.status = body.status; row.adminNote = body.note || null; }
        requests.push(['resolve', resolve[1], body.status]);
        send(200, { ok: true, id: resolve[1], status: body.status });
      });
    }
    send(404, { error: 'not in the stub' });
  });
  return { server, requests };
}

/* ---- the harness --------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

/* WHY THE TRANSPORT IS AN ARGUMENT AND NOT LEFT TO THE CAPABILITY CHECK.
 *
 * srvDecideTransport() asks the engine whether it has a Local Network Access
 * gate, and nothing else — no address, no request, because making one is the
 * thing that would raise a prompt. Headless Chromium 141 answers `prompt`, so
 * the page's honest answer here is "use the bridge", even though this fixture
 * is 127.0.0.1 talking to 127.0.0.1 and no gate would ever have applied to it.
 *
 * Measured, not assumed: Chromium 141 (`HeadlessChrome/141.0.0.0`) resolves
 * navigator.permissions.query({name:'local-network-access'}) with state
 * `prompt`.
 *
 * So each test says which transport it is about. The DECISION itself has its own
 * test below ("which transport this browser chooses"), which is where the three
 * engine answers are pinned; everything else would otherwise be re-testing that
 * one function through seven screens.
 */
async function harness({ transport = 'direct', roots = { all: true, entries: [], shared: [] } } = {}) {
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-br-share-'));
  fs.mkdirSync(path.join(share, gwPaths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(share, 'Alpha'), { recursive: true });
  fs.writeFileSync(path.join(share, 'Alpha', 'render.psd'), Buffer.alloc(3000, 9));
  fs.writeFileSync(path.join(share, 'Alpha', 'notes.txt'), 'hello');
  fs.mkdirSync(path.join(share, 'Beta'), { recursive: true });

  const keys = minter.generate();
  const state = { enabled: true, chunkBytes: 16 * 1024, requests: [], shortTokens: false,
    roots, submitUploadEnabled: false, linkPrefix: null };

  // The page's own origin has to be decided before the gateway starts, because
  // the gateway's CORS is derived from it — as it is in production.
  const pageServer = http.createServer();
  await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
  const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
  pageServer.close();

  const gw = gwServer.create({
    local: {
      fileRoot: share, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'srv-br-state-')),
      gatewayId: GATEWAY_ID, gatewaySecret: 'b'.repeat(64),
      forgeUrl: pageOrigin, listenAddress: '127.0.0.1', listenPort: 0,
      rateLimitPerMinute: 100000, heartbeatSeconds: 3600, configSeconds: 3600,
    },
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  Object.assign(gw.ctx, {
    config: () => gwConfig.shape({ version: 1, maxFileBytes: 64 * 1024 * 1024, chunkBytes: state.chunkBytes,
      keys: [{ kid: keys.kid, publicKey: keys.publicKey }] }),
    callback: () => {},
  });
  const gatewayHttp = http.createServer((req, res) => gw.handler(req, res));
  await new Promise((r) => gatewayHttp.listen(0, '127.0.0.1', r));
  const gatewayUrl = `http://127.0.0.1:${gatewayHttp.address().port}`;

  const stub = forgeStub({ gatewayUrl, keys, state });
  await new Promise((r) => stub.server.listen(Number(pageOrigin.split(':')[2]), '127.0.0.1', r));

  if (!browser) {
    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(pageOrigin, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  if (transport) await page.evaluate(`SRV.transport = ${JSON.stringify(transport)};`);

  const close = async () => {
    await context.close();
    gatewayHttp.close();
    stub.server.close();
  };
  return { page, share, state, stub, gatewayUrl, pageOrigin, close, errors };
}

const noNative = async (h) => {
  assert.deepStrictEqual(await h.page.evaluate('window.__native'), [],
    'nothing reached for a native dialog');
  assert.deepStrictEqual(h.errors.filter((e) => /native (alert|confirm|prompt)/.test(e)), []);
};

// ===========================================================================

test('browse, filter and sort a real share', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate('renderServer()');
    await h.page.waitForSelector('.srv-table tbody tr');
    const names = await h.page.$$eval('.srv-row .srv-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names, ['Alpha', 'Beta'], `the share's top level: ${names.join(',')}`);

    // Into a folder, by clicking it.
    await h.page.click('.srv-link[data-open="Alpha"]');
    /* NOT a row count: the root has two rows as well, so "length === 2" was
       satisfied by the table that was already on screen and this passed or
       failed depending on how loaded the machine was. Waited on something only
       the new listing has. */
    await h.page.waitForFunction(
      "SRV.path === 'Alpha' && [...document.querySelectorAll('.srv-row .srv-name')]"
      + ".some((e) => e.textContent.includes('render.psd'))");
    const inside = await h.page.$$eval('.srv-row .srv-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(inside.sort(), ['notes.txt', 'render.psd']);

    // The breadcrumb went with it, and leads back.
    const crumbs = await h.page.$$eval('.srv-crumbs *', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    assert.ok(crumbs.includes('Office server') && crumbs.includes('Alpha'), crumbs.join('|'));

    // The filter is client-side: no further request, and the rows narrow.
    const before = h.stub.requests.length;
    await h.page.fill('#srvFilter', 'notes');
    await h.page.waitForFunction("document.querySelectorAll('.srv-row').length === 1");
    assert.strictEqual(h.stub.requests.length, before, 'filtering asked Forge for nothing');
    await h.page.fill('#srvFilter', '');
    await h.page.waitForFunction("document.querySelectorAll('.srv-row').length === 2");

    // Sorting by size puts the big one first on the second click.
    await h.page.click('.srv-sort[data-key="size"]');
    await h.page.click('.srv-sort[data-key="size"]');
    const sorted = await h.page.$$eval('.srv-row .srv-name', (els) => els.map((e) => e.textContent.trim()));
    assert.strictEqual(sorted[0], 'render.psd', `sorted by size: ${sorted.join(',')}`);

    await noNative(h);
  } finally { await h.close(); }
});

test('a multi-chunk upload reports progress and lands byte for byte', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    await h.page.waitForSelector('#srvFileInput', { state: 'attached' });

    /* 70 KB against a 16 KB chunk: five chunks, so the progress bar has
       something to do and the resume arithmetic is exercised. */
    const bytes = Array.from({ length: 70 * 1024 }, (_, i) => i % 251);
    await h.page.evaluate(async (data) => {
      const file = new File([new Uint8Array(data)], 'walk-cycle.psd', { type: 'application/octet-stream' });
      window.__seen = [];
      const was = window.renderServer;
      window.renderServer = async () => { window.__seen.push(SRV.uploads.map((u) => Math.round(u.progress))); return was(); };
      srvQueue([file]);
    }, bytes);

    await h.page.waitForFunction("SRV.uploads.length && SRV.uploads[0].state === 'done'", { timeout: 20000 });
    const seen = await h.page.evaluate('window.__seen.flat()');
    assert.ok(seen.some((p) => p > 0 && p < 100), `progress was reported while it ran: ${seen.join(',')}`);

    const landed = path.join(h.share, 'Alpha', 'walk-cycle.psd');
    assert.ok(fs.existsSync(landed), `the file is on the share: ${fs.readdirSync(path.join(h.share, 'Alpha')).join(',')}`);
    assert.deepStrictEqual([...fs.readFileSync(landed)], bytes, 'byte for byte');
    // And nothing was left in the gateway's scratch area.
    assert.deepStrictEqual(fs.readdirSync(path.join(h.share, gwPaths.INCOMING)), []);
    await noNative(h);
  } finally { await h.close(); }
});

test('an upload can be paused, resumed, and resumed after a reload', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    const bytes = Array.from({ length: 70 * 1024 }, (_, i) => i % 97);

    // Pause part-way: the job stops with what it has and offers Resume.
    await h.page.evaluate(async (data) => {
      const file = new File([new Uint8Array(data)], 'paused.psd');
      window.__realSrvCall = window.srvCall;
      let sent = 0;
      window.srvCall = async (p, opts) => {
        const out = await window.__realSrvCall(p, opts);
        if (/\/chunk/.test(p) && ++sent === 2) SRV.uploads[0].paused = true;   // as the Pause button does
        return out;
      };
      srvQueue([file]);
    }, bytes);
    await h.page.waitForFunction("SRV.uploads[0] && SRV.uploads[0].state === 'paused'", { timeout: 20000 });
    const partial = await h.page.evaluate('SRV.uploads[0].sent');
    assert.ok(partial > 0 && partial < 70 * 1024, `it stopped part-way: ${partial}`);
    assert.strictEqual(fs.existsSync(path.join(h.share, 'Alpha', 'paused.psd')), false,
      'and nothing is on the share until it finishes');

    // The gateway knows exactly which ranges it has, which is what resuming reads.
    const id = await h.page.evaluate('SRV.uploads[0].id');
    const incoming = path.join(h.share, gwPaths.INCOMING, id);
    assert.ok(fs.existsSync(incoming), 'the part-finished upload is in .incoming');
    const ranges = JSON.parse(fs.readFileSync(path.join(incoming, 'ranges.json'), 'utf8'));
    assert.strictEqual(ranges[0][0], 0);
    assert.strictEqual(ranges[0][1], partial);

    // Resume finishes it, and the file is whole.
    await h.page.evaluate("window.srvCall = window.__realSrvCall; SRV.uploads[0].paused = false; SRV.uploads[0].state = 'queued'; srvPump()");
    await h.page.waitForFunction("SRV.uploads[0].state === 'done' || SRV.uploads[0].state === 'failed'", { timeout: 20000 });
    const finished = await h.page.evaluate('SRV.uploads[0].state');
    assert.strictEqual(finished, 'done', await h.page.evaluate('SRV.uploads[0].note'));
    assert.deepStrictEqual([...fs.readFileSync(path.join(h.share, 'Alpha', 'paused.psd'))], bytes,
      'resumed from the bytes the share already had, and the whole file is right');

    /* AFTER A RELOAD. The browser will not hand back a File across a page load
       and nothing is stored on the Forge server to read it from, so what
       survives is the FACT — offered, with the same file to be picked again. */
    await h.page.evaluate(`localStorage.setItem('zvkyServerUploads', JSON.stringify([
      { id: '${id}', name: 'paused.psd', size: ${70 * 1024}, path: 'Alpha', at: Date.now() }]))`);
    await h.page.reload({ waitUntil: 'load' });
    await h.page.waitForFunction('window.__ready === true');
    await h.page.evaluate("SRV.transport = 'direct'; srvResumeNotice(); renderServer()");
    await h.page.waitForSelector('.srv-up');
    const note = await h.page.$eval('.srv-up .srv-up-state', (e) => e.textContent.trim());
    assert.match(note, /Interrupted by a reload/);
    await noNative(h);
  } finally { await h.close(); }
});

test('an expired upload token is renewed through Forge and the chunk retried', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    h.state.shortTokens = true;          // the session's token lives one second
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    const bytes = Array.from({ length: 40 * 1024 }, (_, i) => i % 13);
    await h.page.evaluate(async (data) => {
      srvQueue([new File([new Uint8Array(data)], 'renewed.psd')]);
    }, bytes);
    await h.page.waitForFunction("SRV.uploads[0] && (SRV.uploads[0].state === 'done' || SRV.uploads[0].state === 'failed')", { timeout: 25000 });
    assert.strictEqual(await h.page.evaluate('SRV.uploads[0].state'), 'done',
      await h.page.evaluate('SRV.uploads[0].note'));
    assert.ok(h.stub.requests.some((r) => r[0] === 'renew'), 'Forge was asked for a fresh token');
    assert.deepStrictEqual([...fs.readFileSync(path.join(h.share, 'Alpha', 'renewed.psd'))], bytes);
    await noNative(h);
  } finally { await h.close(); }
});

test('a download is a top-level link with a single-use token', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    await h.page.waitForSelector('[data-dl]');
    const [download] = await Promise.all([
      h.page.waitForEvent('download', { timeout: 15000 }),
      h.page.click('[data-dl="Alpha/render.psd"]'),
    ]);
    assert.strictEqual(download.suggestedFilename(), 'render.psd');
    const saved = await download.path();
    assert.strictEqual(fs.statSync(saved).size, 3000, 'the browser got the whole file');
    assert.ok(h.stub.requests.some((r) => r[0] === 'token' && r[1] === 'download' && r[2] === 'Alpha/render.psd'),
      'and asked Forge for a token naming exactly that file');
    await noNative(h);
  } finally { await h.close(); }
});

test('New folder uses the in-page question, not a native prompt', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    await h.page.click('#srvNewFolder');
    await h.page.waitForSelector('#askWrap.show');
    assert.match(await h.page.$eval('#ask_title', (e) => e.textContent), /New folder/);
    await h.page.fill('#ask_input', 'scenes');
    await h.page.click('#ask_confirm');
    await h.page.waitForFunction("document.querySelectorAll('.srv-row').length === 3", { timeout: 15000 });
    assert.ok(fs.existsSync(path.join(h.share, 'Alpha', 'scenes')), 'the folder is on the share');

    // The same name again is refused by the gateway and said out loud.
    await h.page.click('#srvNewFolder');
    await h.page.waitForSelector('#askWrap.show');
    await h.page.fill('#ask_input', 'scenes');
    await h.page.click('#ask_confirm');
    await h.page.waitForFunction("(window.__toasts || []).some(t => /already there/.test(t))", { timeout: 15000 });
    await noNative(h);
  } finally { await h.close(); }
});

test('requesting a deletion, and an admin resolving it', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; renderServer()");
    await h.page.waitForSelector('[data-del]');
    await h.page.click('[data-del="Alpha/notes.txt"]');
    await h.page.waitForSelector('#askWrap.show');
    assert.match(await h.page.$eval('#ask_title', (e) => e.textContent), /Request deletion/);
    assert.match(await h.page.$eval('#ask_message', (e) => e.textContent), /Forge cannot delete anything/);

    // A reason is required: the confirm button is disabled until there is one.
    assert.strictEqual(await h.page.$eval('#ask_confirm', (e) => e.disabled), true,
      'no reason, no request');
    await h.page.fill('#ask_input', 'Superseded');
    await h.page.waitForFunction("document.getElementById('ask_confirm').disabled === false");
    await h.page.click('#ask_confirm');
    await h.page.waitForFunction("(window.__toasts || []).some(t => /Request sent/.test(t))", { timeout: 15000 });

    // The row now carries the tag, and the file is still on the share.
    await h.page.waitForSelector('.srv-tag');
    assert.match(await h.page.$eval('.srv-tag', (e) => e.textContent), /Deletion requested/);
    assert.ok(fs.existsSync(path.join(h.share, 'Alpha', 'notes.txt')), 'nothing was deleted');

    // Asking twice is refused with a sentence.
    const again = await h.page.evaluate(`(async () => {
      try { await api('/server/deletion-requests', { method:'POST', body:{ path:'Alpha/notes.txt', reason:'again' } }); return 'allowed'; }
      catch (e) { return e.body && e.body.code; }
    })()`);
    assert.strictEqual(again, 'already_requested');

    // And the admin view resolves it — with the file still there afterwards.
    await h.page.evaluate('srvToggleRequests()');
    await h.page.waitForSelector('[data-done]');
    await h.page.click('[data-done]');
    await h.page.waitForSelector('#askWrap.show');
    assert.match(await h.page.$eval('#ask_message', (e) => e.textContent), /Forge deletes nothing/);
    await h.page.click('#ask_confirm');
    await h.page.waitForFunction("SRV.requests.length && SRV.requests[0].status === 'done'", { timeout: 15000 });
    assert.ok(fs.existsSync(path.join(h.share, 'Alpha', 'notes.txt')), 'resolving deleted nothing');
    await noNative(h);
  } finally { await h.close(); }
});

test('off the office network the tab says so and shows nothing', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    /* The gateway is unreachable, which from the browser's side is
       indistinguishable from being at home — and is exactly what being at home
       looks like. */
    await h.page.evaluate('renderServer()');
    await h.page.waitForSelector('.srv-table');
    /* The address is taken away AFTER the tab has loaded its settings —
       otherwise the next render fetches them again and puts the real one back,
       which is what makes this look like a test that passes by accident. */
    await h.page.evaluate(`SRV.gatewayUrl = 'http://127.0.0.1:1'; SRV.transport = 'direct'; SRV.path = 'Alpha';`);
    await h.page.evaluate('srvGo()');
    await h.page.waitForSelector('.srv-off', { timeout: 20000 });
    const words = await h.page.$eval('.srv-off', (e) => e.textContent.trim());
    assert.strictEqual(words, 'Open Forge from the office network to use Server files.');
    const rows = await h.page.$$eval('.srv-row', (els) => els.length);
    assert.strictEqual(rows, 0, 'and no data at all');
    await noNative(h);
  } finally { await h.close(); }
});

test('with the feature switched off the tab draws its disabled state', { skip: SKIP }, async () => {
  const h = await harness();
  try {
    h.state.enabled = false;
    await h.page.evaluate('SRV.loaded = false; renderServer()');
    await h.page.waitForFunction("document.querySelector('#serverView').textContent.includes('switched off')", { timeout: 15000 });
    const text = await h.page.$eval('#serverView', (e) => e.textContent);
    assert.match(text, /Settings → Server/);
    assert.strictEqual(await h.page.$$eval('.srv-row', (els) => els.length), 0);
    await noNative(h);
  } finally { await h.close(); }
});

test('which transport this browser chooses, and that choosing costs no request', { skip: SKIP }, async () => {
  /* THE DECISION, PINNED AT ITS THREE ANSWERS. The page must never make a
     request to find out how to make requests — that is the whole point of
     asking the permission registry instead of trying a fetch — so this also
     asserts that deciding sent nothing anywhere. */
  const cases = [
    // The desktop app's Chromium 130 has no such permission name at all.
    { name: 'an engine with no Local Network Access gate', script:
      "navigator.permissions.query = async () => { throw new TypeError('unknown'); };", expect: 'direct' },
    // A policy-managed browser: LocalNetworkAccessAllowedForUrls.
    { name: 'a policy-managed browser', script:
      "navigator.permissions.query = async () => ({ state: 'granted' });", expect: 'direct' },
    // Everything else, which is what this very Chromium answers unprompted.
    { name: 'an ordinary current Chromium', script:
      "navigator.permissions.query = async () => ({ state: 'prompt' });", expect: 'link' },
  ];
  for (const c of cases) {
    const h = await harness({ transport: null });
    try {
      await h.page.addInitScript(c.script);
      await h.page.reload({ waitUntil: 'load' });
      await h.page.waitForFunction('window.__ready === true');
      const before = h.stub.requests.length;
      const chosen = await h.page.evaluate('srvDecideTransport()');
      assert.strictEqual(chosen, c.expect, c.name);
      assert.strictEqual(h.stub.requests.length, before, `${c.name}: deciding asked Forge for nothing`);
      await noNative(h);
    } finally { await h.close(); }
  }

  /* And unstubbed, this engine answers for itself — recorded here so the day
     Chromium changes its mind, a test says so rather than a screen going quiet. */
  const h = await harness({ transport: null });
  try {
    const state = await h.page.evaluate(`(async () => {
      try { return (await navigator.permissions.query({ name: 'local-network-access' })).state; }
      catch (e) { return 'threw:' + e.name; }
    })()`);
    assert.ok(['prompt', 'granted', 'denied', 'threw:TypeError'].includes(state), state);
    assert.strictEqual(await h.page.evaluate('srvDecideTransport()'),
      (state === 'granted' || state === 'threw:TypeError') ? 'direct' : 'link',
      `the transport follows this engine's answer (${state})`);
  } finally { await h.close(); }
});

test('the office link window is never opened without a click', { skip: SKIP }, async () => {
  const h = await harness({ transport: 'link' });
  try {
    /* A LISTING THAT NEEDS THE BRIDGE DOES NOT OPEN ONE. It asks. Anything else
       is a window appearing on its own, which is what a pop-up blocker exists
       for — and a blocked window would leave the tab silently empty. */
    let popped = false;
    h.page.on('popup', () => { popped = true; });
    await h.page.evaluate("SRV.path = 'Alpha'; srvGo()");
    await h.page.waitForSelector('#srvConnect', { timeout: 20000 });
    assert.strictEqual(popped, false, 'nothing opened a window by itself');
    assert.match(await h.page.$eval('.srv-banner', (e) => e.textContent),
      /needs the office server window/);
    assert.strictEqual(await h.page.$eval('.srv-transport', (e) => e.textContent.trim()),
      'Bridge window needed');
    assert.strictEqual(await h.page.$$eval('.srv-row', (els) => els.length), 0,
      'and no listing was invented in the meantime');
    await noNative(h);
  } finally { await h.close(); }
});

test('Connect to office server opens the bridge, which then relays listing and uploads', { skip: SKIP }, async () => {
  const h = await harness({ transport: 'link' });
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; srvGo()");
    await h.page.waitForSelector('#srvConnect', { timeout: 20000 });

    const [popup] = await Promise.all([
      h.page.waitForEvent('popup', { timeout: 15000 }),
      h.page.click('#srvConnect'),
    ]);
    await popup.waitForLoadState('load');
    assert.match(await popup.title(), /Office file link/);
    // It says what it is for, and that it holds nothing.
    assert.match(await popup.$eval('body', (e) => e.textContent), /nothing is stored here/);

    await h.page.waitForFunction(
      "SRV.path === 'Alpha' && [...document.querySelectorAll('.srv-row .srv-name')]"
      + ".some((e) => e.textContent.includes('render.psd'))", { timeout: 20000 });
    const names = await h.page.$$eval('.srv-row .srv-name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(names.sort(), ['notes.txt', 'render.psd'],
      'the folder was listed through the relay');
    // And the label now says how the files travel.
    assert.strictEqual(await h.page.$eval('.srv-transport', (e) => e.textContent.trim()),
      'Via bridge window');

    // An upload goes up the same way — the Blob travels by structured clone.
    const bytes = Array.from({ length: 20 * 1024 }, (_, i) => i % 7);
    await h.page.evaluate(async (data) => {
      srvQueue([new File([new Uint8Array(data)], 'relayed.psd')]);
    }, bytes);
    await h.page.waitForFunction("SRV.uploads[0] && (SRV.uploads[0].state === 'done' || SRV.uploads[0].state === 'failed')", { timeout: 25000 });
    assert.strictEqual(await h.page.evaluate('SRV.uploads[0].state'), 'done',
      await h.page.evaluate('SRV.uploads[0].note'));
    assert.deepStrictEqual([...fs.readFileSync(path.join(h.share, 'Alpha', 'relayed.psd'))], bytes);

    /* NO TOKEN IN THE WINDOW'S URL. The bridge's address is in the browser's
       history and in the person's title bar; what travels over it is the page,
       and everything else arrives by postMessage. */
    const url = popup.url();
    assert.match(url, /\/v1\/app$/, url);
    assert.ok(!/[?#]/.test(url), `no query and no fragment: ${url}`);
    await noNative(h);
  } finally { await h.close(); }
});

test('closing the bridge mid-upload pauses it, and reopening carries on', { skip: SKIP }, async () => {
  const h = await harness({ transport: 'link' });
  try {
    await h.page.evaluate("SRV.path = 'Alpha'; srvGo()");
    await h.page.waitForSelector('#srvConnect', { timeout: 20000 });
    const [popup] = await Promise.all([
      h.page.waitForEvent('popup', { timeout: 15000 }),
      h.page.click('#srvConnect'),
    ]);
    await popup.waitForLoadState('load');
    await h.page.waitForFunction('srvBridgeReady()', { timeout: 20000 });

    /* 70 KB against a 16 KB chunk, with the window shut after the second chunk:
       what is already on the share stays there and the job stops. A closed
       window is a PAUSE — the person shut a window, they did not lose an
       upload. */
    const bytes = Array.from({ length: 70 * 1024 }, (_, i) => i % 61);
    await h.page.evaluate(async (data) => {
      window.__realSrvCall = window.srvCall;
      let sent = 0;
      window.srvCall = async (p, opts) => {
        const out = await window.__realSrvCall(p, opts);
        if (/\/chunk/.test(p) && ++sent === 2) SRV.linkWindow.close();
        return out;
      };
      srvQueue([new File([new Uint8Array(data)], 'interrupted.psd')]);
    }, bytes);
    await h.page.waitForFunction(
      "SRV.uploads[0] && (SRV.uploads[0].state === 'paused' || SRV.uploads[0].state === 'failed')",
      { timeout: 25000 });
    assert.strictEqual(await h.page.evaluate('SRV.uploads[0].state'), 'paused',
      await h.page.evaluate('SRV.uploads[0].note'));
    /* EITHER SENTENCE. Which one depends on where the close landed: a call
       already in flight is told the window went away, and the next call is told
       there is no window to use. Both are a pause with the same consequence,
       and pinning one of them would be pinning a race. */
    assert.match(await h.page.evaluate('SRV.uploads[0].note || ""'),
      /office server window (was closed|is not open)/);
    assert.match(await h.page.evaluate('SRV.uploads[0].note || ""'), /carries on/);
    assert.strictEqual(fs.existsSync(path.join(h.share, 'Alpha', 'interrupted.psd')), false,
      'and nothing was finished while it was shut');

    // Reopen, resume, and the file is whole — resumed from what the share had.
    await h.page.evaluate('window.srvCall = window.__realSrvCall; renderServer()');
    await h.page.waitForSelector('#srvConnect', { timeout: 20000 });
    const [again] = await Promise.all([
      h.page.waitForEvent('popup', { timeout: 15000 }),
      h.page.click('#srvConnect'),
    ]);
    await again.waitForLoadState('load');
    await h.page.waitForFunction('srvBridgeReady()', { timeout: 20000 });
    await h.page.evaluate("srvResume(SRV.uploads[0].id)");
    await h.page.waitForFunction("SRV.uploads[0].state === 'done' || SRV.uploads[0].state === 'failed'",
      { timeout: 30000 });
    assert.strictEqual(await h.page.evaluate('SRV.uploads[0].state'), 'done',
      await h.page.evaluate('SRV.uploads[0].note'));
    assert.deepStrictEqual([...fs.readFileSync(path.join(h.share, 'Alpha', 'interrupted.psd'))], bytes,
      'byte for byte, across a closed window');
    await noNative(h);
  } finally { await h.close(); }
});

/* ---- the virtual Projects list ------------------------------------------ */

/* What a non-admin's first screen is: not the share's root, which they may not
   read, but the projects they can already see that have a usable server link.
   Forge answers it; the gateway is not asked. */
const PROJECT_ROOTS = {
  all: false,
  entries: [
    { name: 'Alpha', label: 'Alpha', path: 'Alpha', type: 'folder', kind: 'project',
      projectId: 'p-alpha', subtitle: '\\\\SERVER\\Projects\\Alpha' },
    /* A project whose FOLDER is not named after it, which is the ordinary case
       on a share that predates Forge — the row says the project and shows the
       link underneath. */
    { name: 'Beta the Second', label: 'Beta the Second', path: 'Beta', type: 'folder', kind: 'project',
      projectId: 'p-beta', subtitle: '\\\\SERVER\\Projects\\Beta' },
  ],
  shared: [],
  unavailable: [{ name: 'Gamma', why: 'No server folder link yet.' }],
};

test('the Projects list is the first screen, and the breadcrumb stops at the project', { skip: SKIP }, async () => {
  const h = await harness({ roots: PROJECT_ROOTS });
  try {
    await h.page.evaluate('renderServer()');
    await h.page.waitForSelector('.srv-row .srv-name');

    /* THE PROJECT'S NAME, not the folder's. The link may point several segments
       under the prefix and the folder may be called anything at all; what the
       artist knows is the project. */
    const names = await h.page.$$eval('.srv-row .srv-name',
      (els) => els.map((e) => e.firstElementChild.textContent.trim()));
    assert.deepStrictEqual(names, ['Alpha', 'Beta the Second'], names.join('|'));
    // And the link it points at, underneath, for whoever has to check it.
    const subs = await h.page.$$eval('.srv-row .srv-sub', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(subs, ['\\\\SERVER\\Projects\\Alpha', '\\\\SERVER\\Projects\\Beta'], subs.join('|'));

    // Nothing was asked of the office server to draw it.
    assert.deepStrictEqual(h.stub.requests.filter((r) => r[0] === 'token'), [],
      'the Projects list cost no token and no listing');

    // A project with no usable link is named, with why, and is not a row.
    const unavailable = await h.page.$$eval('.srv-unavailable .srv-check-row',
      (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(unavailable.length, 1, unavailable.join('|'));
    assert.match(unavailable[0], /no server link.*Gamma.*No server folder link yet/);

    // Into the project, and the breadcrumb goes Projects → Beta the Second.
    await h.page.click('.srv-link[data-open="Beta"]');
    /* NOT "SRV.path === 'Beta'": the click handler sets the path before it
       re-renders, so that is satisfied while the old breadcrumb is still on
       screen — and this test then read the root's crumbs and failed depending
       on how loaded the machine was. Waited on the drawn crumb instead. */
    await h.page.waitForFunction(
      "SRV.path === 'Beta' && [...document.querySelectorAll('.srv-crumbs *')]"
      + ".some(e => e.textContent.trim() === 'Beta the Second')");
    const crumbs = await h.page.$$eval('.srv-crumbs *',
      (els) => els.map((e) => e.textContent.trim()).filter((t) => t && t !== '/'));
    assert.deepStrictEqual(crumbs, ['Projects', 'Beta the Second'], crumbs.join('|'));
    /* AND NOTHING ABOVE IT. There is no crumb for the share's root, because
       they may not read it — a breadcrumb that leads to a refusal reads as a
       bug, not as a permission. */
    assert.strictEqual(await h.page.$$eval('.srv-crumb[data-path=""]', (els) => els.length), 1,
      'exactly one crumb leads anywhere above the project, and it is Projects');

    // Back to the list, from that crumb.
    await h.page.click('.srv-crumb[data-path=""]');
    await h.page.waitForFunction("SRV.path === '' && document.querySelectorAll('.srv-row').length === 2");
    await noNative(h);
  } finally { await h.close(); }
});

test('the gateway refuses a path outside the project, however the page asks', { skip: SKIP }, async () => {
  const h = await harness({ roots: PROJECT_ROOTS });
  try {
    await h.page.evaluate('renderServer()');
    await h.page.waitForSelector('.srv-row .srv-name');
    /* The page is made to ask for the share's root with a token minted for it —
       the stub mints whatever is asked, which is the point: this is the
       gateway's own check, not Forge's. A real Forge refuses to mint it at all,
       and tests/server-tab.test.js pins that side. */
    const out = await h.page.evaluate(`(async () => {
      const minted = await api('/server/token', { method:'POST', body:{ op:'list', path:'Alpha' } });
      return srvCall('/v1/list?path=' + encodeURIComponent('Alpha/../Beta'), { token: minted.token });
    })()`);
    assert.ok(!out.ok, JSON.stringify(out));
    assert.ok(out.status === 403 || out.status === 400, `refused with ${out.status}`);
    await noNative(h);
  } finally { await h.close(); }
});
