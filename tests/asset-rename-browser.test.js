/* EDITING AN ASSET'S NAME IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE STATIC SUITE CANNOT. tests/asset-name.test.js reads
 * public/index.html and pins the rule, the gate and the markup; this one runs
 * the page's own code in Chromium against the real server and watches what a
 * person actually sees:
 *
 *     the pencil is absent without the key, absent with the switch off, and
 *       visible with both
 *     the modal opens on the current name, and says the sentence about files
 *     the validation messages appear AS SOMEBODY TYPES, in the module's words
 *     Save is disabled while the name is unchanged or invalid
 *     a save changes the name on the server and the view in front of the person
 *     A SECOND BROWSER SESSION that renamed it first makes the first one's Save
 *       come back with the conflict message, in the page, with the offer to
 *       show the current name
 *     the history list shows the entry, with who and when
 *     a designation without the key cannot open the history at all
 *
 * REAL ON BOTH SIDES. The server is the application, booted against the test
 * database; the page's code is lifted out of public/index.html rather than
 * retyped, so this drives what ships. Only the surrounding single-page
 * application is stood in for — signing in, routing and the asset panel's three
 * hundred other lines are not what is under test — and /api is proxied with the
 * acting person's token, because the page's api() sends none of its own.
 *
 * THE PENCIL IS DRAWN THROUGH nameEditPencil() AND ONLY THROUGH IT: the static
 * suite asserts that both real call sites (the asset panel and the Assets List)
 * go through that one function, so a fixture that calls it is testing the gate
 * every screen uses.
 *
 * NO NATIVE DIALOGS: alert, confirm and prompt throw here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const assetName = require('../src/asset-name');

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

const cfg = config('assetrenamebrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'Rename-Browser-1!';

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

  // Lifted, not retyped: the rule, the gate, the modal's code and its wiring.
  const feature = cut("/* ---------- editing an asset's name ---",
    '/* ---------- drawer ---------- */', 'the rename feature');
  const wiring = cut("const assetNameWrap = document.getElementById('assetNameWrap');",
    '/* THE EMOJI PICKER CLOSES', 'the modal wiring');
  const markup = cut('<!-- EDIT ASSET NAME.', '<div class="modal-wrap" id="modalWrap">',
    'the modal markup');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  <!-- Where a screen draws the pencil. The two real call sites put it beside a
       name in the asset panel and in the Assets List; both go through
       nameEditPencil(), which is what this stands in for. -->
  <div id="host"></div>
  <div id="drawer"></div>
  ${markup}
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
window.__permissions = [];
function can(){ for (let i = 0; i < arguments.length; i++) if (window.__permissions.includes(arguments[i])) return true; return false; }
function fmtDate(s){ return s ? String(s) : ''; }
const state = { token: 'proxied', currentUser: { id: null }, assets: [], openAssetId: null,
  view: 'board', assetRenameEnabled: true };
/* The two redraws the save path asks for. Recorded rather than performed: the
   board and the asset panel have their own suites, and what matters here is
   that the page updates the view in front of the person rather than reloading. */
window.__applied = [];
function applyAssetUpdate(updated){
  window.__applied.push(updated && updated.name);
  const at = (state.assets || []).findIndex((x) => x.id === (updated && updated.id));
  if (at === -1) return false;
  state.assets[at] = { ...state.assets[at], ...updated };
  drawHost();
  return true;
}
window.__rendered = 0;
function render(){ window.__rendered += 1; }
window.__drawerOpened = [];
function openDrawer(id){ window.__drawerOpened.push(id); }
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
${feature}
/* The pencil, drawn the way a screen draws it: the markup from
   nameEditPencil() and the delegated click handler the Assets List uses. */
function drawHost(){
  const host = document.getElementById('host');
  host.innerHTML = (state.assets || []).map((a) =>
    '<div class="row" data-row="' + a.id + '"><span class="nm">' + escapeHTML(a.name) + '</span>'
    + nameEditPencil(a.id) + '</div>').join('');
  host.querySelectorAll('[data-rename]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      openAssetRename(btn.dataset.rename);
    });
  });
}
${wiring}
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('editing an asset name, in a browser', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const html = fixture();
  /* WHICH TOKEN THE PROXY ATTACHES, per browser context — two sessions are open
     at once in the conflict test, so this cannot be one variable for the suite. */
  const actingFor = new Map();

  const newAsset = async (name, assigneeId) => {
    const res = await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  };
  const nameOf = async (assetId) => (await as('root', `/assets/project/${id.project}`))
    .body.assets.find((a) => a.id === assetId).name;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'arb-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'arb-token', name: 'Root', email: 'root@arb.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@arb.test');
    await openStudio(server.base, token.root);

    id.client = await systemClientId(server.base, token.root);
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { clientId: id.client, name: 'Rename Browser' } })).body.project.id;

    /* THREE DESIGNATIONS, which is the point of the suite.
       root  Super Admin — holds everything by construction.
       lee   team_lead — holds assets.rename by default, and is the SECOND
             browser session in the conflict test.
       dir   art_director — Creative Direction, which holds no asset-editing
             key: the negative case, and it sees every project, so the key is
             the only thing that can be refusing it. */
    for (const [who, role, name] of [['lee', 'team_lead', 'Lee Lead'],
      ['dir', 'art_director', 'Dee Direction']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@arb.test`, role, password: PASSWORD, projectId: id.project } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      id[who] = made.body.user.id;
      token[who] = await login(`${who}@arb.test`);
    }

    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    probe.close();
    await new Promise((r) => probe.on('close', r));
    pageOrigin = `http://127.0.0.1:${port}`;
    pageServer = http.createServer((req, res) => {
      if (!req.url.startsWith('/api')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      /* The acting person is named by the context's own header, set per page in
         open() — so two browser sessions can be signed in as two people at the
         same moment, which is what the conflict test needs. */
      const who = req.headers['x-acting'] || 'root';
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const out = await fetch(`${server.base}${req.url.slice(4)}`, {
          method: req.method,
          headers: {
            authorization: `Bearer ${token[who] || token.root}`,
            ...(body.length ? { 'content-type': req.headers['content-type'] || 'application/json' } : {}),
          },
          body: body.length ? body : undefined,
        });
        const buffer = Buffer.from(await out.arrayBuffer());
        res.writeHead(out.status, {
          'content-type': out.headers.get('content-type') || 'application/json',
        });
        res.end(buffer);
      });
    });
    await new Promise((r) => pageServer.listen(port, '127.0.0.1', r));
  });

  t.after(async () => {
    if (pageServer) pageServer.close();
    await stopServer(server);
  });

  async function open(who, assets, { switchOn = true } = {}) {
    if (!browser) {
      browser = await chromium.launch({ executablePath: EXECUTABLE,
        args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    }
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-acting': who } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.goto(pageOrigin, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true');
    const me = await as(who, '/auth/me');
    actingFor.set(page, who);
    await page.evaluate(({ perms, user, rows, on }) => {
      window.__permissions = perms;
      state.currentUser = { id: user.id, name: user.name };
      state.assets = rows;
      state.assetRenameEnabled = on;
      drawHost();
    }, { perms: (me.body.user && me.body.user.permissions) || [], user: me.body.user,
      rows: assets, on: switchOn });
    const native = async () => {
      assert.deepStrictEqual(await page.evaluate('window.__native'), [],
        'nothing reached for a native dialog');
      assert.deepStrictEqual(errors.filter((e) => /native (alert|confirm|prompt)/.test(e)), []);
    };
    return { page, errors, native, who, close: () => context.close() };
  }

  const rows = (assets) => assets.map((a) => ({ id: a.id, code: a.code, name: a.name }));

  /* ---- the gate -------------------------------------------------------- */

  await t.test('no key, no pencil — on a designation that can see every project',
    async () => {
      const asset = await newAsset('Direction Cannot Rename Me');
      const h = await open('dir', rows([asset]));
      try {
        assert.strictEqual(await h.page.$('[data-rename]'), null,
          'Creative Direction is offered nothing to press');
        assert.ok(await h.page.$('.nm'), 'though the name itself is on the screen');
        // And the history is not reachable either, even by calling it.
        await h.page.evaluate((assetId) => openNameHistory(assetId), asset.id);
        assert.strictEqual(await h.page.isVisible('#assetHistoryWrap'), false,
          'a designation without the key cannot open the name history');
        await h.native();
      } finally { await h.close(); }
    });

  await t.test('the key but the switch off: still no pencil', async () => {
    const asset = await newAsset('Switched Off For Me');
    const h = await open('lee', rows([asset]), { switchOn: false });
    try {
      assert.strictEqual(await h.page.$('[data-rename]'), null,
        'the studio switch takes the control away from somebody who holds the key');
      // And it comes back when the switch moves, on the page's own state — which
      // is what the /auth/me poll sets.
      await h.page.evaluate(() => { state.assetRenameEnabled = true; drawHost(); });
      assert.ok(await h.page.$('[data-rename]'), 'and comes back when it is switched on');
      await h.native();
    } finally { await h.close(); }
  });

  /* ---- the modal ------------------------------------------------------- */

  await t.test('the pencil opens the modal on the current name, with the file sentence',
    async () => {
      const asset = await newAsset('Rough Pass');
      const h = await open('lee', rows([asset]));
      try {
        assert.ok(await h.page.isVisible('[data-rename]'), 'the pencil is on the screen');
        assert.strictEqual(await h.page.isVisible('#assetNameWrap'), false,
          'and the modal is not, until it is pressed');

        await h.page.click('[data-rename]');
        await h.page.waitForSelector('#assetNameWrap.show');
        assert.strictEqual(await h.page.inputValue('#an_name'), 'Rough Pass',
          'the box starts on the name it has');
        const current = await h.page.textContent('#anCurrent');
        assert.match(current, new RegExp(asset.code), 'the code is shown beside it');
        assert.match(current, /currently/);
        const modal = await h.page.textContent('#assetNameWrap');
        assert.match(modal, /Files already stored are not renamed or moved\./,
          'the promise about files is in front of the person making the change');

        // Unchanged, so there is nothing to save.
        assert.strictEqual(await h.page.isDisabled('#an_save'), true);

        // Cancel closes it and changes nothing.
        await h.page.click('#an_cancel');
        await h.page.waitForSelector('#assetNameWrap', { state: 'hidden' });
        assert.strictEqual(await nameOf(asset.id), 'Rough Pass');
        await h.native();
      } finally { await h.close(); }
    });

  await t.test('the validation messages appear as somebody types, in the module\'s words',
    async () => {
      const asset = await newAsset('Live Validation');
      const h = await open('lee', rows([asset]));
      try {
        await h.page.click('[data-rename]');
        await h.page.waitForSelector('#assetNameWrap.show');

        // Emptied: the required message, and Save closed.
        await h.page.fill('#an_name', '');
        await h.page.waitForFunction(
          (msg) => document.getElementById('an_err').textContent.trim() === msg,
          assetName.MESSAGES.required
        );
        assert.strictEqual(await h.page.isDisabled('#an_save'), true);

        // Whitespace only is the same answer: it normalises to nothing.
        await h.page.fill('#an_name', '    ');
        await h.page.waitForFunction(
          (msg) => document.getElementById('an_err').textContent.trim() === msg,
          assetName.MESSAGES.required
        );
        assert.strictEqual(await h.page.isDisabled('#an_save'), true);

        // Too long: the other message, with the number in it.
        await h.page.fill('#an_name', 'x'.repeat(256));
        await h.page.waitForFunction(
          (msg) => document.getElementById('an_err').textContent.trim() === msg,
          assetName.MESSAGES.tooLong
        );
        assert.strictEqual(await h.page.isDisabled('#an_save'), true);

        // 255 exactly is fine, which is the boundary the message quotes.
        await h.page.fill('#an_name', 'y'.repeat(255));
        await h.page.waitForFunction(() => !document.getElementById('an_save').disabled);
        assert.strictEqual((await h.page.textContent('#an_err')).trim(), '');

        /* THE SAME NAME WITH SPACES ROUND IT IS THE SAME NAME. Save stays shut,
           because the comparison is made on the normalised value — otherwise a
           trailing space would look like a change and write a history row
           saying "Live Validation -> Live Validation". */
        await h.page.fill('#an_name', '  Live Validation  ');
        await h.page.waitForFunction(() => document.getElementById('an_save').disabled);
        assert.strictEqual((await h.page.textContent('#an_err')).trim(), '');

        // A real change opens it.
        await h.page.fill('#an_name', 'Live Validation II');
        await h.page.waitForFunction(() => !document.getElementById('an_save').disabled);
        await h.native();
      } finally { await h.close(); }
    });

  await t.test('a save changes the name on the server and on the screen', async () => {
    const asset = await newAsset('Before The Save');
    const h = await open('lee', rows([asset]));
    try {
      await h.page.click('[data-rename]');
      await h.page.waitForSelector('#assetNameWrap.show');
      /* TYPED WITH THE MESS A PASTE BRINGS: a tab, a double space and a
         trailing space. What lands on the server is the normalised name. */
      await h.page.fill('#an_name', '  After\tThe   Save  ');
      await h.page.waitForFunction(() => !document.getElementById('an_save').disabled);
      await h.page.click('#an_save');
      await h.page.waitForSelector('#assetNameWrap', { state: 'hidden' });

      assert.strictEqual(await nameOf(asset.id), 'After The Save',
        'the server has the normalised name');
      assert.deepStrictEqual(await h.page.evaluate('window.__applied'), ['After The Save'],
        'and the view in front of the person was updated rather than reloaded');
      assert.strictEqual(await h.page.evaluate('window.__rendered'), 0,
        'no full redraw was needed');
      assert.strictEqual((await h.page.textContent('.nm')).trim(), 'After The Save',
        'the row on the screen says the new name');
      assert.deepStrictEqual(await h.page.evaluate('window.__toasts'), ['Name updated.']);
      await h.native();
    } finally { await h.close(); }
  });

  /* ---- two people, one asset ------------------------------------------- */

  await t.test('a second browser session makes the first one\'s Save a conflict',
    async () => {
      const asset = await newAsset('Contested In A Browser');
      const first = await open('lee', rows([asset]));
      const second = await open('root', rows([asset]));
      try {
        // Both have the panel open on the same name.
        await first.page.click('[data-rename]');
        await first.page.waitForSelector('#assetNameWrap.show');
        await second.page.click('[data-rename]');
        await second.page.waitForSelector('#assetNameWrap.show');

        // The Super Admin saves first.
        await second.page.fill('#an_name', 'Root Got There First');
        await second.page.waitForFunction(() => !document.getElementById('an_save').disabled);
        await second.page.click('#an_save');
        await second.page.waitForSelector('#assetNameWrap', { state: 'hidden' });
        assert.strictEqual(await nameOf(asset.id), 'Root Got There First');

        // The lead's form is now stale. Their Save is refused, IN THE PAGE.
        await first.page.fill('#an_name', 'Lee Was Too Slow');
        await first.page.waitForFunction(() => !document.getElementById('an_save').disabled);
        await first.page.click('#an_save');
        await first.page.waitForSelector('#an_reload');
        assert.strictEqual(await first.page.isVisible('#assetNameWrap'), true,
          'the modal stays open — the typing is not thrown away');
        const message = await first.page.textContent('#an_err');
        assert.match(message, /Somebody else changed this name while you were editing it/);
        assert.match(message, /It is now "Root Got There First"/, 'it says what the name is now');
        assert.match(message, /changed by Root/, 'and who changed it');
        assert.strictEqual(await nameOf(asset.id), 'Root Got There First',
          'and nothing was overwritten');

        // The offer: show me the current name. Then the save goes through.
        await first.page.click('#an_reload');
        await first.page.waitForFunction(
          () => document.getElementById('an_name').value === 'Root Got There First');
        assert.strictEqual((await first.page.textContent('#an_err')).trim(), '',
          'the conflict notice goes once it has been answered');
        await first.page.fill('#an_name', 'Lee, With The Current Name In Hand');
        await first.page.waitForFunction(() => !document.getElementById('an_save').disabled);
        await first.page.click('#an_save');
        await first.page.waitForSelector('#assetNameWrap', { state: 'hidden' });
        assert.strictEqual(await nameOf(asset.id), 'Lee, With The Current Name In Hand');

        await first.native();
        await second.native();
      } finally { await first.close(); await second.close(); }
    });

  /* ---- the history ----------------------------------------------------- */

  await t.test('the history list shows every rename, newest first, in the page',
    async () => {
      const asset = await newAsset('Chapter One');
      assert.strictEqual((await as('lee', `/assets/${asset.id}/name`, { method: 'PATCH',
        body: { name: 'Chapter Two', expected_name: 'Chapter One' } })).status, 200);
      assert.strictEqual((await as('root', `/assets/${asset.id}/name`, { method: 'PATCH',
        body: { name: 'Chapter Three', expected_name: 'Chapter Two' } })).status, 200);

      const h = await open('lee', rows([{ ...asset, name: 'Chapter Three' }]));
      try {
        await h.page.evaluate((assetId) => openNameHistory(assetId), asset.id);
        await h.page.waitForSelector('#assetHistoryWrap.show .an-hist-row');
        const shown = await h.page.$$eval('.an-hist-row',
          (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
        assert.strictEqual(shown.length, 2);
        assert.match(shown[0], /Chapter Two → Chapter Three/, 'newest first');
        assert.match(shown[0], /Root/, 'with who made it');
        assert.match(shown[1], /Chapter One → Chapter Two/);
        assert.match(shown[1], /Lee Lead/);

        await h.page.click('#ah_close');
        await h.page.waitForSelector('#assetHistoryWrap', { state: 'hidden' });
        await h.native();
      } finally { await h.close(); }
    });

  await t.test('an asset nobody has renamed says so rather than showing an empty list',
    async () => {
      const asset = await newAsset('Never Renamed');
      const h = await open('lee', rows([asset]));
      try {
        await h.page.evaluate((assetId) => openNameHistory(assetId), asset.id);
        await h.page.waitForSelector('#assetHistoryWrap.show .an-hist-empty');
        // Whitespace collapsed: the sentence is wrapped across lines in the markup.
        const said = (await h.page.textContent('.an-hist-empty')).replace(/\s+/g, ' ').trim();
        assert.match(said, /has always been called Never Renamed/);
        assert.match(said, /Nothing has been renamed/);
        await h.native();
      } finally { await h.close(); }
    });
});
