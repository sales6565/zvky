/* THE SUBMIT-WORK UPLOAD, IN A REAL BROWSER, AGAINST THE REAL FORGE AND THE
 * REAL GATEWAY.
 *
 * ===========================================================================
 * EVERY PIECE HERE IS THE SHIPPED ONE EXCEPT THE SCREEN AROUND IT.
 *
 *   Forge        the application, booted by the test harness against the test
 *                database. Every endpoint the page calls is the real one —
 *                which matters more here than anywhere else in this feature,
 *                because WHERE A FILE GOES is the server's decision and a
 *                stub would be me asserting my own arithmetic.
 *   the gateway  the shipped package, serving a temporary share over http on
 *                loopback, verifying real Ed25519 tokens minted by Forge.
 *   the page     the real markup and the real functions, lifted out of
 *                public/index.html.
 *
 * The only stand-in is the surrounding single-page application: the fixture
 * draws the project form's link field and the submit box, and nothing else.
 * Signing in, routing and the asset drawer are not what is under test, and a
 * browser driven through the whole application to reach this form would fail
 * for a hundred reasons that have nothing to do with uploading a file.
 *
 * ONE PROXY, AND WHY. The page's own api() is same-origin and sends no token —
 * the real one attaches it from memory after sign-in. So /api is proxied to
 * Forge with the Authorization header of whoever the test is acting as. The
 * request bodies, the routes and the answers are untouched.
 *
 * NO NATIVE DIALOGS. The desktop web view has none (Prompt 39): alert, confirm
 * and prompt throw, and every test fails if one is reached.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const gwServer = require('../gateway/src/server');
const gwConfig = require('../gateway/src/config');
const gwPaths = require('../gateway/src/paths');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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

const cfg = config('submitbrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'Submit-Browser-1!';
const PREFIX = '\\\\SERVER\\Projects';
const GATEWAY_ID = 'GW-SUB';
/* The studio's chunk size, and a file that needs three of them. */
const CHUNK = 1024 * 1024;
const BIG = Math.floor(2.5 * CHUNK);

/* ---- the page under test ------------------------------------------------ */

function fixture() {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  const cut = (fromText, toText, what) => {
    const from = PAGE.indexOf(fromText);
    const to = PAGE.indexOf(toText, from + 1);
    assert.ok(from !== -1 && to > from, `found ${what} in the page`);
    return PAGE.slice(from, to);
  };

  // The state object, and one run of code: the link field, the submit box, the
  // transport, the gateway call and the Server tab, exactly as they ship.
  const srv = cut('const SRV = {', '\n};', 'the Server state object') + '\n};';
  const code = cut('function srvFoldLink(text){', '/* ---------- Settings → Server',
    'the Server tab and the link field');

  // The two bits of markup, lifted rather than written out again here.
  const linkField = cut('<div class="srv-link-field" id="p_serverWrap"', '<label>Team leads on this project</label>',
    'the project form’s server link field');
  const submitForm = cut('<input type="text" id="submitLink"', '<button class="btn btn-brand" id="submitAssetBtn"',
    'the submit-work link field and the upload box');

  // And the page's own submit handler, which is what must stay unchanged.
  const handler = cut("document.getElementById('submitAssetBtn').onclick = async (ev)=>{",
    '\n  }\n  if(canRelay){', 'the submit button’s handler');

  const askFrom = PAGE.indexOf('const askWrap = document.getElementById');
  const askTo = PAGE.indexOf('window.askText = askText;') + 'window.askText = askText;'.length;
  const ask = PAGE.slice(askFrom, askTo);
  const askMarkupFrom = PAGE.indexOf('<div class="modal-wrap" id="askWrap">');
  const askMarkup = PAGE.slice(askMarkupFrom, PAGE.indexOf('</div>\n</div>', askMarkupFrom) + 13);

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  ${askMarkup}
  <div class="modal" id="projectForm">${linkField}</div>
  <div class="modal" id="submitForm">
    ${submitForm}
    <button class="btn btn-brand" id="submitAssetBtn">Submit for review</button>
  </div>
  <div id="serverView"></div>
  <!-- Where the test draws one submission's references box, which in the
       application is inside each round in the drawer. -->
  <div id="refsHost"></div>
<script>
window.__native = [];
for (const name of ['alert', 'confirm', 'prompt']) {
  window[name] = (...args) => { window.__native.push([name, String(args[0] || '')]); throw new Error('native ' + name); };
}
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
window.__toasts = [];
function showToast(msg){ window.__toasts.push(String(msg)); document.getElementById('toast').textContent = msg; }
function applyGate(){ /* no nav bar in the fixture */ }
/* THE PERMISSION, as the page asks it. Set by the test to whatever the person
   it is acting as actually holds, which is read from /auth/me rather than
   decided here. */
window.__permissions = [];
function can(key){ return window.__permissions.includes(key); }
window.__closed = 0;
function closeDrawer(){ window.__closed += 1; }
window.__tab = null;
function setTab(tab){ window.__tab = tab; }
window.__drawRefs = (versionId) => {
  document.getElementById('refsHost').innerHTML =
    '<div class="srv-refs" data-refs="' + versionId + '"></div>';
};
function render(){ /* the board, which this fixture has not got */ }
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
${srv}
${code}
/* The page wires this when it draws the drawer; the fixture wires it on
   demand, with the same code. */
function wireSubmit(id){
${handler}
}
window.wireSubmit = wireSubmit;
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the Submit Work upload, in a browser', { skip: SKIP }, async (t) => {
  let server;
  let gatewayHttp;
  let pageServer;
  let share;
  let pageOrigin;
  let gatewayUrl;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);
  const html = fixture();
  let acting = 'root';            // whose token the /api proxy attaches
  let forgeConfig = {};           // the config the gateway pulls from Forge

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'sb-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      EMAIL_ENCRYPTION_KEY: 'b'.repeat(64),
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'sb-token', name: 'Root', email: 'root@sb.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@sb.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@sb.test', 'game_artist');
    /* A project manager who may edit projects and holds NO Server permission —
       the Server keys ship Super Admin only, so this is every studio's normal
       state on the day the feature is switched on. The link field has to work
       for exactly this person. */
    await make('pm', 'Pat Manager', 'pm@sb.test', 'admin');

    for (const [key, label] of [['art', 'Art'], ['animation', 'Animation']]) {
      const made = await as('root', '/reference/categories', { method: 'POST', body: { key, label } });
      assert.ok(made.status === 201 || made.status === 200, JSON.stringify(made.body));
    }

    id.client = await systemClientId(server.base, token.root);
    const mkProject = async (key, name) => {
      const r = await as('root', '/projects', { method: 'POST', body: { name, clientId: id.client } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('hero', 'Hero Quest');
    await mkProject('second', 'Second Project');

    const mkAsset = async (key, projectKey, category) => {
      const r = await as('root', `/assets/project/${id[projectKey]}`, { method: 'POST',
        body: { name: `Asset ${key}`, type: 'character', category } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.asset.id;
      await as('root', `/assets/${id[key]}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    };
    await mkAsset('heroArt', 'hero', 'art');
    /* STARTED HERE AND NOWHERE ELSE. Submitting work that was never started is
       refused by this application ("click Accept and Start"), and an artist has
       one asset in progress at a time — so each test that submits starts its
       own asset first rather than the setup starting all of them. */
    const started = await as('ana', `/assets/${id.heroArt}/start`, { method: 'POST' });
    assert.ok(started.status === 200 || started.status === 201, JSON.stringify(started.body));
    await mkAsset('heroAnim', 'hero', 'animation');
    await mkAsset('secondArt', 'second', 'art');
    // A spare, for the test that turns the switch off: an asset already in
    // review cannot be submitted again, which is the application's own rule.
    await mkAsset('heroSpare', 'hero', 'art');

    /* The share, with the two project folders ALREADY THERE. The gateway never
       creates a project folder, which is why they are made here and not by the
       first upload. */
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-share-'));
    fs.mkdirSync(path.join(share, gwPaths.INCOMING), { recursive: true });
    fs.mkdirSync(path.join(share, 'Hero Quest'), { recursive: true });
    fs.mkdirSync(path.join(share, 'Second Project'), { recursive: true });

    /* The page's origin is decided before the gateway starts, because the
       gateway's CORS is derived from it exactly as it is in production. */
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const pagePort = probe.address().port;
    probe.close();
    await new Promise((r) => probe.on('close', r));
    pageOrigin = `http://127.0.0.1:${pagePort}`;

    const keys = await as('root', '/admin/settings/server/keys', { method: 'POST' });
    const secret = await as('root', '/admin/settings/server/secret', { method: 'POST' });
    const gw = gwServer.create({
      local: {
        fileRoot: share, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-state-')),
        gatewayId: GATEWAY_ID, gatewaySecret: secret.body.secret,
        forgeUrl: pageOrigin, listenAddress: '127.0.0.1', listenPort: 0,
        rateLimitPerMinute: 100000, heartbeatSeconds: 3600, configSeconds: 3600,
      },
      log: () => {},
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    });
    /* THE GATEWAY'S CONFIG IS FORGE'S CONFIG. In production the gateway pulls it
       from /api/gateway/config, so the two cannot disagree about the chunk size.
       Handing it a different one here is not a shortcut, it is a different
       system: the gateway refuses a body larger than twice its OWN chunk size
       (gateway/src/server.js), so a mismatched pair failed the first upload
       with "Failed to fetch" and nothing explaining it. */
    Object.assign(gw.ctx, {
      config: () => gwConfig.shape({
        version: 1,
        maxFileBytes: forgeConfig.maxFileBytes,
        chunkBytes: forgeConfig.chunkBytes,
        keys: [{ kid: keys.body.kid, publicKey: keys.body.publicKey }],
      }),
      callback: () => {},
    });
    gatewayHttp = http.createServer((req, res) => gw.handler(req, res));
    await new Promise((r) => gatewayHttp.listen(0, '127.0.0.1', r));
    gatewayUrl = `http://127.0.0.1:${gatewayHttp.address().port}`;

    /* The page, and /api proxied to Forge with the acting person's token. */
    pageServer = http.createServer((req, res) => {
      if (!req.url.startsWith('/api')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const out = await fetch(`${server.base}${req.url.slice(4)}`, {
          method: req.method,
          headers: {
            authorization: `Bearer ${token[acting]}`,
            ...(body.length ? { 'content-type': req.headers['content-type'] || 'application/json' } : {}),
          },
          body: body.length ? body : undefined,
        });
        const text = await out.text();
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(text);
      });
    });
    await new Promise((r) => pageServer.listen(pagePort, '127.0.0.1', r));

    // Both switches on, the prefix set, and the pilot limited to Hero Quest
    // and Second Project — which is the shape this ships in.
    const patch = (b) => as('root', '/admin/settings/server', { method: 'PATCH', body: b });
    /* ONE MEGABYTE, which is the smallest the settings allow, so a file of a few
       megabytes goes up in several chunks and the resume arithmetic is real. */
    await patch({ gatewayUrl: 'https://files.office.test', gatewayId: GATEWAY_ID, enabled: true,
      linkPrefix: PREFIX, chunkBytes: 1024 * 1024 });
    await patch({ submitUploadEnabled: true, submitScope: 'selected' });
    for (const key of ['hero', 'second']) {
      const r = await as('root', `/projects/${id[key]}`, { method: 'PATCH',
        body: { serverLink: `${PREFIX}\\${key === 'hero' ? 'Hero Quest' : 'Second Project'}` } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const on = await as('root', `/admin/settings/server/projects/${id[key]}/submit`,
        { method: 'PATCH', body: { enabled: true } });
      assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    }
    /* What the gateway would have pulled from /api/gateway/config. Read after
       the patches above, because that is what it would serve. */
    forgeConfig = (await as('root', '/admin/settings/server')).body.settings.limits;
    assert.strictEqual(forgeConfig.chunkBytes, CHUNK, JSON.stringify(forgeConfig));

    /* And the artist may use it. The key ships Super Admin only, which is the
       point of it — a studio grants it when the office machine is there. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((x) => x.enabled).map((x) => x.key);
    const granted = await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'server.submit_upload'])] } });
    assert.strictEqual(granted.status, 200, JSON.stringify(granted.body));
  });

  t.after(async () => {
    if (pageServer) pageServer.close();
    if (gatewayHttp) gatewayHttp.close();
    await stopServer(server);
  });

  /* A page, as somebody. The transport is pinned to `direct`: this Chromium
     reports a Local Network Access gate it would never apply to 127.0.0.1, and
     which transport a browser picks is pinned in
     tests/server-tab-browser.test.js rather than through seven screens here. */
  async function open(who) {
    acting = who;
    if (!browser) {
      browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    /* The browser's own complaints — a refused cross-origin request says
       "Failed to fetch" to the page and the REASON only here. */
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(pageOrigin, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true');
    const me = await as(who, '/auth/me');
    /* `me.body.user.permissions`, not `me.body.permissions`. The list rides on
       the user object — src/middleware/auth.js puts it there — and reading the
       wrong one handed the page an empty array, which made can() answer no to
       everything and the upload box draw nothing at all. */
    await page.evaluate(({ perms, url }) => {
      window.__permissions = perms;
      /* THE ADDRESS, not the logic. Settings will only store an https address —
         http would be mixed content on a page served over https and would put
         the studio's files on the office wifi in the clear — and the gateway in
         this test is http on loopback. Everything else about reaching it is the
         shipped code. */
      window.__gatewayUrl = url;
    }, { perms: (me.body.user && me.body.user.permissions) || [], url: gatewayUrl });
    const close = async () => { await context.close(); };
    const native = async () => {
      assert.deepStrictEqual(await page.evaluate('window.__native'), [], 'nothing reached for a native dialog');
      assert.deepStrictEqual(errors.filter((e) => /native (alert|confirm|prompt)/.test(e)), []);
    };
    /* THE STATE A SIGNED-IN BROWSER REALLY HAS at this point: the switch, from
       /auth/me, which every browser re-polls. NOT /server/state — neither the
       project manager nor the artist in these tests holds `server.view`, and
       calling it for them would be testing a browser nobody has. Everything
       else the two screens need, they fetch themselves. */
    const ready = async () => {
      await page.evaluate((url) => {
        SRV.enabled = true;
        SRV.gatewayUrl = url;          // https in production; http on loopback here
        SRV.transport = 'direct';
      }, gatewayUrl);
    };
    return { page, close, native, errors, ready };
  }

  /* Submitted, or the reason it was not — whichever happened. Waiting only for
     success turns every refusal into a thirty-second timeout that says nothing
     about why. */
  async function submitted(h) {
    await h.page.waitForFunction(
      "window.__closed === 1 || document.getElementById('submitErr').textContent.trim() !== ''",
      { timeout: 20000 });
    const err = await h.page.$eval('#submitErr', (e) => e.textContent.trim());
    assert.strictEqual(err, '', `the submission was refused: ${err}`);
    assert.strictEqual(await h.page.evaluate('window.__closed'), 1);
  }

  // =======================================================================

  await t.test('a project manager pastes the folder link and checks it', async () => {
    const h = await open('pm');
    try {
      /* NO /server/state HERE, because this person cannot have it: that is the
         tab's request and it needs server.view. What they do get is the switch,
         from /auth/me, which every signed-in browser re-polls — so the field is
         drawn from the switch and fetches the prefix itself. */
      const refused = await as('pm', '/server/state');
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      const me = await as('pm', '/auth/me');
      assert.strictEqual(me.body.serverEnabled, true);
      assert.ok(!(me.body.user.permissions || []).includes('server.view'),
        'and they hold no Server-tab permission');
      assert.ok((me.body.user.permissions || []).includes('project.edit'),
        'but they may edit a project, which is what the field belongs to');
      await h.ready();
      await h.page.evaluate("srvWireLinkField('p', '')");
      /* THE PREFIX ARRIVED, through the one route that answers to project.edit.
         Without it this field disables itself and says an admin has not set a
         prefix — which is what it did until tests/server-submit-browser.test.js
         was written. */
      assert.strictEqual(await h.page.evaluate('SRV.linkPrefix'), PREFIX);
      assert.strictEqual(await h.page.$eval('#p_serverLink', (e) => e.disabled), false);
      await h.page.waitForSelector('#p_serverWrap:not([style*="display: none"])');

      // A link outside the prefix is refused as it is typed, with the reason.
      await h.page.fill('#p_serverLink', '\\\\OTHER\\Share\\Hero Quest');
      await h.page.waitForFunction(
        "document.getElementById('p_serverWarn').textContent.includes('has to start with')");

      /* A good link, and Check folder says it is really there. The CHECK is the
         server's: Forge mints a token for that path and the gateway answers
         whether it can list it. */
      await h.page.fill('#p_serverLink', `${PREFIX}\\Hero Quest`);
      await h.page.click('#p_serverCheck');
      await h.page.waitForFunction(
        "/Found\\./.test(document.getElementById('p_serverWarn').textContent)", { timeout: 20000 });
      assert.match(await h.page.$eval('#p_serverWarn', (e) => e.textContent), /Hero Quest exists/);

      // A link under the prefix that is NOT there yet: said plainly, and saving
      // is still allowed, because IT may be about to create it.
      await h.page.fill('#p_serverLink', `${PREFIX}\\Not Made Yet`);
      await h.page.click('#p_serverCheck');
      await h.page.waitForFunction(
        "/Not found/.test(document.getElementById('p_serverWarn').textContent)", { timeout: 20000 });
      assert.match(await h.page.$eval('#p_serverWarn', (e) => e.textContent), /Saving is still fine/);
      /* AND CHECKING CREATED NOTHING. A "check" that made the folder would be a
         way to create project folders through Forge, which is the one thing the
         gateway refuses to do. */
      assert.strictEqual(fs.existsSync(path.join(share, 'Not Made Yet')), false);
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('an artist uploads several files, and they land in their own folder', async () => {
    const h = await open('ana');
    try {
      await h.ready();
      const project = (await as('root', `/projects/${id.hero}`)).body.project;
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroArt, p: project });
      await h.page.waitForSelector('#srvSubmitDrop');
      assert.match(await h.page.$eval('.srv-submit-note', (e) => e.textContent), /your own folder/);

      /* Three files at once, through the real gateway — the first of them big
         enough to need three chunks at the studio's chunk size.
         GENERATED IN THE PAGE: two and a half million numbers do not need to
         travel through the debugging protocol to prove a file arrived, and the
         pattern is reproduced on the other side to check the bytes. */
      await h.page.evaluate(({ assetId, big }) => {
        const pattern = (n) => {
          const a = new Uint8Array(n);
          for (let i = 0; i < n; i += 1) a[i] = i % 251;
          return a;
        };
        srvSubmitQueue(assetId, [
          new File([pattern(big)], 'walk.psd'),
          new File([pattern(300 * 1024)], 'run.psd'),
          new File([pattern(300)], 'notes.txt'),
        ]);
      }, { assetId: id.heroArt, big: BIG });
      await h.page.waitForFunction(
        `SRV_SUBMIT.get(${JSON.stringify(id.heroArt)}).jobs.every(j => j.state === 'done' || j.state === 'failed')`,
        { timeout: 60000 });
      const states = await h.page.evaluate(
        `SRV_SUBMIT.get(${JSON.stringify(id.heroArt)}).jobs.map(j => [j.state, j.note])`);
      assert.deepStrictEqual(states.map((x) => x[0]), ['done', 'done', 'done'],
        `${JSON.stringify(states)} ${JSON.stringify(h.errors)}`);
      /* AND THEN THE RECORDING, which is a separate request after the last file
         — so waiting for the jobs is not waiting for the link. */
      await h.page.waitForFunction(
        `Boolean(SRV_SUBMIT.get(${JSON.stringify(id.heroArt)}).link)`, { timeout: 20000 });

      /* WHERE THEY LANDED: the project's folder, the discipline that follows
         from the ASSET'S CATEGORY, and this person's own folder. Read off the
         filesystem, not off the answer. */
      const dir = path.join(share, 'Hero Quest', 'Artist', 'Ana Artist');
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'run.psd', 'walk.psd']);
      assert.strictEqual(fs.statSync(path.join(dir, 'walk.psd')).size, BIG);
      /* THE BYTES, not just the size — and across the chunk boundaries, which is
         where an upload assembled out of order goes wrong. */
      const landed = fs.readFileSync(path.join(dir, 'walk.psd'));
      for (const at of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, BIG - 1]) {
        assert.strictEqual(landed[at], at % 251, `byte ${at}`);
      }
      // And nothing was left in the gateway's scratch area.
      assert.deepStrictEqual(fs.readdirSync(path.join(share, gwPaths.INCOMING)), []);

      /* THE LINK FIELD WAS FILLED IN — with the FOLDER, because several files
         went up and a link points at one place. And it says so. */
      const link = await h.page.$eval('#submitLink', (e) => e.value);
      assert.strictEqual(link, `${PREFIX}\\Hero Quest\\Artist\\Ana Artist`, link);
      assert.match(await h.page.$eval('.srv-submit-done', (e) => e.textContent),
        /folder you uploaded.*several files share their folder/);

      // The references are recorded, as references — no bytes, no file index.
      const refs = await q(
        'SELECT `name`, relative_path FROM server_submission_files WHERE asset_id = ? ORDER BY `name`',
        [id.heroArt]);
      assert.deepStrictEqual(refs.map((r) => r.name), ['notes.txt', 'run.psd', 'walk.psd']);
      assert.ok(refs.every((r) => r.relative_path.startsWith('Hero Quest/Artist/Ana Artist/')),
        JSON.stringify(refs));

      // And now submitting works, with the link the server composed.
      await h.page.evaluate((assetId) => wireSubmit(assetId), id.heroArt);
      await h.page.click('#submitAssetBtn');
      await submitted(h);
      const versions = await q('SELECT link FROM asset_versions WHERE asset_id = ?', [id.heroArt]);
      assert.strictEqual(versions.length, 1);
      assert.strictEqual(versions[0].link, `${PREFIX}\\Hero Quest\\Artist\\Ana Artist`);
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('a second project uses its own folder, and the discipline follows the category', async () => {
    const h = await open('ana');
    try {
      await h.ready();
      const second = (await as('root', `/projects/${id.second}`)).body.project;
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.secondArt, p: second });
      await h.page.waitForSelector('#srvSubmitDrop');
      await h.page.evaluate((assetId) => {
        srvSubmitQueue(assetId, [new File([new Uint8Array(1024)], 'second.psd')]);
      }, id.secondArt);
      await h.page.waitForFunction(
        `SRV_SUBMIT.get(${JSON.stringify(id.secondArt)}).jobs.every(j => j.state === 'done' || j.state === 'failed')`,
        { timeout: 60000 });
      await h.page.waitForFunction(
        `Boolean(SRV_SUBMIT.get(${JSON.stringify(id.secondArt)}).link)`, { timeout: 20000 });
      assert.ok(fs.existsSync(path.join(share, 'Second Project', 'Artist', 'Ana Artist', 'second.psd')),
        fs.readdirSync(path.join(share, 'Second Project')).join(','));
      // One file: the link is the FILE itself.
      assert.strictEqual(await h.page.$eval('#submitLink', (e) => e.value),
        `${PREFIX}\\Second Project\\Artist\\Ana Artist\\second.psd`);
      assert.match(await h.page.$eval('.srv-submit-done', (e) => e.textContent), /file you uploaded/);

      /* AND AN ANIMATION ASSET IN THE SAME PROJECT GOES TO THE ANIMATOR'S
         FOLDER — the discipline is the asset's category, not the person's role.
         Same person, same project, different folder. */
      const hero = (await as('root', `/projects/${id.hero}`)).body.project;
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroAnim, p: hero });
      await h.page.waitForSelector('#srvSubmitDrop');
      await h.page.evaluate((assetId) => {
        srvSubmitQueue(assetId, [new File([new Uint8Array(512)], 'cycle.ma')]);
      }, id.heroAnim);
      await h.page.waitForFunction(
        `SRV_SUBMIT.get(${JSON.stringify(id.heroAnim)}).jobs.every(j => j.state === 'done' || j.state === 'failed')`,
        { timeout: 60000 });
      await h.page.waitForFunction(
        `Boolean(SRV_SUBMIT.get(${JSON.stringify(id.heroAnim)}).link)`, { timeout: 20000 });
      assert.ok(fs.existsSync(path.join(share, 'Hero Quest', 'Animator', 'Ana Artist', 'cycle.ma')),
        fs.readdirSync(path.join(share, 'Hero Quest')).join(','));
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('the old way still works: a pasted link, with the box sitting there unused', async () => {
    const h = await open('ana');
    try {
      await h.ready();
      const hero = (await as('root', `/projects/${id.hero}`)).body.project;
      /* THE ASSET THAT WAS SUBMITTED WITH AN UPLOAD IS NOT THIS ONE. A second
         round on heroArt, this time typed by hand — which is the thing that
         must keep working while the pilot runs. */
      const started = await as('ana', `/assets/${id.heroAnim}/start`, { method: 'POST' });
      assert.ok(started.status === 200 || started.status === 201, JSON.stringify(started.body));
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroAnim, p: hero });
      await h.page.waitForSelector('#srvSubmitDrop');
      await h.page.fill('#submitLink', '\\\\OLD-NAS\\drops\\cycle-v4.ma');
      await h.page.evaluate((assetId) => wireSubmit(assetId), id.heroAnim);
      await h.page.click('#submitAssetBtn');
      await submitted(h);
      const versions = await q(
        'SELECT link FROM asset_versions WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1', [id.heroAnim]);
      /* STORED EXACTLY AS TYPED, from a machine that has nothing to do with the
         prefix. The upload box being on screen changed nothing about it. */
      assert.strictEqual(versions[0].link, '\\\\OLD-NAS\\drops\\cycle-v4.ma');
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('the uploaded files show under the submission, and open from it', async () => {
    const version = (await q(
      'SELECT id FROM asset_versions WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1',
      [id.heroArt]))[0].id;

    /* THE ARTIST WHO UPLOADED THEM. She holds server.submit_upload and not
       server.view, so she sees what she sent and no button — the Server tab is
       not hers to open. */
    const artist = await open('ana');
    try {
      await artist.ready();
      await artist.page.evaluate((v) => window.__drawRefs(v), version);
      await artist.page.evaluate((a) => srvSubmissionRefs(a), id.heroArt);
      await artist.page.waitForSelector('.srv-ref');
      const names = await artist.page.$$eval('.srv-ref .srv-ref-name',
        (els) => els.map((e) => e.textContent.trim()).sort());
      assert.deepStrictEqual(names, ['notes.txt', 'run.psd', 'walk.psd']);
      assert.strictEqual(await artist.page.$$eval('[data-openref]', (els) => els.length), 0,
        'no Server tab for her, so no button into it');
      await artist.native();
    } finally { await artist.close(); }

    /* SOMEBODY WHO MAY BROWSE. The button opens the FOLDER the file is in, in
       the Server tab — not a download, and not the file on its own. */
    const admin = await open('root');
    try {
      await admin.ready();
      await admin.page.evaluate((v) => window.__drawRefs(v), version);
      await admin.page.evaluate((a) => srvSubmissionRefs(a), id.heroArt);
      await admin.page.waitForSelector('[data-openref]');
      assert.strictEqual(await admin.page.$$eval('[data-openref]', (els) => els.length), 3);
      // The size is shown beside each name, read off the stored reference.
      assert.match(await admin.page.$eval('.srv-ref .srv-ref-size', (e) => e.textContent), /\d/);
      await admin.page.click('[data-openref]');
      await admin.page.waitForFunction("window.__tab === 'server'");
      assert.strictEqual(await admin.page.evaluate('SRV.path'), 'Hero Quest/Artist/Ana Artist');
      assert.strictEqual(await admin.page.evaluate('window.__closed'), 1, 'and the drawer closed');
      await admin.native();
    } finally { await admin.close(); }
  });

  await t.test('submitting is held while an upload is still going', async () => {
    const h = await open('ana');
    try {
      await h.ready();
      const hero = (await as('root', `/projects/${id.hero}`)).body.project;
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroArt, p: hero });
      await h.page.waitForSelector('#srvSubmitDrop');
      // A job that is deliberately left running, with no chunk ever answered.
      await h.page.evaluate((assetId) => {
        SRV_SUBMIT.get(assetId).jobs.push({ key: 'held', name: 'big.psd', size: 1e9, state: 'running',
          progress: 10, sent: 0, paused: false, note: null });
        srvSubmitRender(assetId);
      }, id.heroArt);
      await h.page.evaluate((assetId) => wireSubmit(assetId), id.heroArt);
      await h.page.fill('#submitLink', `${PREFIX}\\Hero Quest`);
      await h.page.click('#submitAssetBtn');
      await h.page.waitForFunction(
        "document.getElementById('submitErr').textContent.includes('Wait for the upload')");
      assert.match(await h.page.$eval('.srv-submit-busy', (e) => e.textContent), /held until the upload finishes/);
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('a switch turned off mid-session takes the box away and leaves the form', async () => {
    const h = await open('ana');
    try {
      await h.ready();
      const hero = (await as('root', `/projects/${id.hero}`)).body.project;
      const started = await as('ana', `/assets/${id.heroSpare}/start`, { method: 'POST' });
      assert.ok(started.status === 200 || started.status === 201, JSON.stringify(started.body));
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroSpare, p: hero });
      await h.page.waitForSelector('#srvSubmitDrop');

      // The admin turns the upload switch off while the artist has the drawer open.
      await as('root', '/admin/settings/server', { method: 'PATCH', body: { submitUploadEnabled: false } });

      /* The next time the drawer draws, the box is gone — and the link field it
         sat under is untouched, which is the whole safety property: turning the
         pilot off puts every artist back on the flow they had this morning. */
      await h.page.evaluate('SRV.loaded = false; SRV.contextLoaded = false;');
      await h.page.evaluate(({ assetId, p }) => srvSubmitBox(assetId, p), { assetId: id.heroSpare, p: hero });
      await h.page.waitForFunction("document.getElementById('submitUploadWrap').children.length === 0");
      assert.strictEqual(await h.page.$('#srvSubmitDrop'), null);
      assert.ok(await h.page.$('#submitLink'), 'the link field is still there');

      // And it still submits, by hand, with nothing else changed.
      await h.page.fill('#submitLink', '/mnt/shared/hero/walk-v9.psd');
      await h.page.evaluate((assetId) => wireSubmit(assetId), id.heroSpare);
      await h.page.click('#submitAssetBtn');
      await submitted(h);
      const versions = await q(
        'SELECT link FROM asset_versions WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1', [id.heroSpare]);
      assert.strictEqual(versions[0].link, '/mnt/shared/hero/walk-v9.psd');
      await h.native();
    } finally {
      await as('root', '/admin/settings/server', { method: 'PATCH', body: { submitUploadEnabled: true } });
      await h.close();
    }
  });
});
