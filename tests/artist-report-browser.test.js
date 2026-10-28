/* THE ARTIST REPORT, IN A REAL BROWSER, AGAINST THE REAL SERVER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE OTHER SUITE CANNOT: that the screen draws, that the
 * filters narrow it, and that pressing Download Excel produces a file on disk
 * whose contents and formatting are the attached template's. The download is
 * the part worth driving in a browser — it is a fetch, a blob, an object URL
 * and an <a download>, four things that only exist in one, and the file that
 * comes out the other end is what the studio actually receives.
 *
 * REAL ON BOTH SIDES. The server is the application, booted against the test
 * database; the page's own functions are lifted out of public/index.html. Only
 * the surrounding single-page application is stood in for: signing in and
 * routing are not what is under test, and /api is proxied with the acting
 * person's token because the page's api() sends none of its own.
 *
 * NO NATIVE DIALOGS. The desktop web view has none (Prompt 39), so alert,
 * confirm and prompt throw here and every test fails if one is reached.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const xlsx = require('xlsx');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

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

const cfg = config('artistbrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'Artist-Browser-1!';

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

  /* One run of code: the section switch, the colour bands the table shares with
     the Efficiency report, and the Artist Report itself. Lifted rather than
     retyped, so this drives what ships. */
  const sections = cut('function reportSections(){', '/* ---------- Idle Report ----------', 'the report sections');
  const colours = cut('function effColor(v){', 'function effCell(v){', 'the efficiency colour bands');
  const artist = cut('/* ---------- Artist Report ----------', 'async function renderTeam(){', 'the Artist Report');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  <div id="reportsView"></div>
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
const API_BASE = window.location.origin + '/api';
/* The page reads state.token for the download's Authorization header; the proxy
   below attaches the real one, so any non-empty value will do here. */
const state = { token: 'proxied' };
const reportState = { section: 'artist' };
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
${sections}
${colours}
${artist}
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the Artist Report, in a browser', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);
  const html = fixture();
  let acting = 'root';

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'ab-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'ab-token', name: 'Root', email: 'root@ab.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@ab.test');
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@ab.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@ab.test', 'game_artist');

    id.acme = (await as('root', '/clients', { method: 'POST', body: { name: 'Acme Pictures' } })).body.client.id;
    const project = await as('root', '/projects', { method: 'POST',
      body: { name: 'Hero Quest', clientId: id.acme } });
    id.hero = project.body.project.id;

    const mkAsset = async (key, type, manHours, assignee) => {
      const r = await as('root', `/assets/project/${id.hero}`, { method: 'POST',
        body: { name: `Asset ${key}`, type, manHours } });
      id[key] = r.body.asset.id;
      await as('root', `/assets/${id[key]}`, { method: 'PATCH', body: { assigneeId: id[assignee] } });
    };
    await mkAsset('art', 'character', 12, 'ana');
    await mkAsset('anim', 'animation', 6, 'bo');
    await mkAsset('late', 'character', 3, 'ana');

    const submission = async (assetId, userId, when) => q(
      `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, 1, 'tl', 'https://x.test/a', userId, when]);
    const session = async (assetId, userId, seconds) => q(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, userId, 1, '2026-10-05 09:00:00', '2026-10-05 10:00:00', seconds]);

    await submission(id.art, id.ana, '2026-10-14 09:00:00');
    await session(id.art, id.ana, Math.round(9.5 * 3600));
    await submission(id.anim, id.bo, '2026-10-02 09:00:00');
    await session(id.anim, id.bo, 3 * 3600);
    // Outside the October range, so the date filter has something to exclude.
    await submission(id.late, id.ana, '2026-11-03 09:00:00');
    await session(id.late, id.ana, 1 * 3600);

    /* The page, and /api proxied to the application with the acting person's
       token — the page's api() is same-origin and carries none. */
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
        const buffer = Buffer.from(await out.arrayBuffer());
        const headers = { 'content-type': out.headers.get('content-type') || 'application/json' };
        const disposition = out.headers.get('content-disposition');
        if (disposition) headers['content-disposition'] = disposition;
        res.writeHead(out.status, headers);
        res.end(buffer);
      });
    });
    await new Promise((r) => pageServer.listen(port, '127.0.0.1', r));
  });

  t.after(async () => {
    if (pageServer) pageServer.close();
    await stopServer(server);
  });

  async function open(who) {
    acting = who;
    if (!browser) {
      browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    }
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'artist-dl-'));
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.goto(pageOrigin, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true');
    const me = await as(who, '/auth/me');
    await page.evaluate((perms) => { window.__permissions = perms; },
      (me.body.user && me.body.user.permissions) || []);
    const native = async () => {
      assert.deepStrictEqual(await page.evaluate('window.__native'), [], 'nothing reached for a native dialog');
      assert.deepStrictEqual(errors.filter((e) => /native (alert|confirm|prompt)/.test(e)), []);
    };
    return { page, downloads, errors, native, close: () => context.close() };
  }

  const draw = async (h, filters = {}) => {
    await h.page.evaluate((f) => {
      Object.assign(artistState.filters, f);
      artistState.data = null;
      artistState.page = 1;
      return renderArtistReport();
    }, { from: '2026-10-01', to: '2026-10-31', ...filters });
    await h.page.waitForSelector('.art-table tbody tr');
  };

  const bodyRows = (h) => h.page.$$eval('.art-table tbody tr',
    (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));

  await t.test('the report draws, filters, and says what it leaves out', async () => {
    const h = await open('root');
    try {
      await draw(h);
      const rows = await bodyRows(h);
      assert.deepStrictEqual(rows, [
        ['Acme Pictures', 'Hero Quest', 'Art', 'Asset art', 'Ana Artist', '2026-10-14', '12.00', '9.50', '126.3'],
        ['Acme Pictures', 'Hero Quest', 'Animation', 'Asset anim', 'Bo Artist', '2026-10-02', '6.00', '3.00', '200.0'],
      ], JSON.stringify(rows));
      // The nine columns, in the attached file's order.
      assert.deepStrictEqual(await h.page.$$eval('.art-table thead th', (th) => th.map((x) => x.textContent.trim())), [
        'Client Name', 'Project Name', 'Department', 'Assets Name', 'Resource Name',
        'Submit Date', 'Bid Hours', 'Spent Hours', 'Efficiency (%)',
      ]);
      assert.match(await h.page.$eval('.art-count', (e) => e.textContent), /2 rows/);
      /* THE NOTE A READER CANNOT INFER: the range picks the assets, not the
         hours. Said on the screen rather than left to be worked out. */
      const notes = await h.page.$$eval('.art-note', (n) => n.map((x) => x.textContent));
      assert.ok(notes.some((n) => /not only what falls inside the dates/.test(n)), notes.join(' | '));

      // The department filter narrows to one row, through the real endpoint.
      await h.page.selectOption('#art_dept', 'animation');
      await h.page.waitForFunction("document.querySelectorAll('.art-table tbody tr').length === 1");
      assert.strictEqual((await bodyRows(h))[0][3], 'Asset anim');

      // And the date range excludes November's submission.
      await h.page.selectOption('#art_dept', '');
      await h.page.waitForFunction("document.querySelectorAll('.art-table tbody tr').length === 2");
      await h.page.fill('#art_from', '2026-11-01');
      await h.page.fill('#art_to', '2026-11-30');
      await h.page.dispatchEvent('#art_to', 'change');
      await h.page.waitForFunction(
        "[...document.querySelectorAll('.art-table tbody tr td')].some(td => td.textContent.includes('Asset late'))");
      assert.strictEqual((await bodyRows(h)).length, 1);
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('Download Excel produces the attached format, with the rows on screen', async () => {
    const h = await open('root');
    try {
      await draw(h);
      const [download] = await Promise.all([
        h.page.waitForEvent('download', { timeout: 20000 }),
        h.page.click('#art_xlsx'),
      ]);
      assert.strictEqual(download.suggestedFilename(), 'Artist_Report_2026-10-01_to_2026-10-31.xlsx',
        'named after the range, from the server’s Content-Disposition');
      const file = path.join(h.downloads, download.suggestedFilename());
      await download.saveAs(file);

      /* THE FILE THE STUDIO RECEIVES, parsed. Values and types through SheetJS;
         the formatting through the XML, because the community build cannot
         report a fill colour — see tests/artist-report.test.js. */
      const buffer = fs.readFileSync(file);
      const book = xlsx.read(buffer, { type: 'buffer', cellDates: true });
      assert.deepStrictEqual(book.SheetNames, ['Artist Report']);
      const sheet = book.Sheets['Artist Report'];
      assert.strictEqual(sheet.D1.v, 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026');
      assert.deepStrictEqual(['A2', 'C2', 'F2', 'I2'].map((r) => sheet[r].v),
        ['Client Name', 'Department', 'Submit Date', 'Efficiency (%)']);
      // The same two rows the screen is showing, in the same order.
      assert.strictEqual(sheet.D3.v, 'Asset art');
      assert.strictEqual(sheet.E3.v, 'Ana Artist');
      assert.strictEqual(sheet.F3.t, 'd', 'a real date cell');
      assert.strictEqual(sheet.F3.v.toISOString().slice(0, 10), '2026-10-14');
      assert.strictEqual(sheet.G3.v, 12);
      assert.strictEqual(sheet.H3.v, 9.5);
      assert.strictEqual(sheet.I3.v, 126.3);
      assert.strictEqual(sheet.D4.v, 'Asset anim');
      assert.strictEqual(sheet.A5, undefined, 'and no third row');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artist-unz-'));
      require('node:child_process').execFileSync('unzip', ['-q', '-o', file, '-d', dir]);
      const stylesXml = fs.readFileSync(path.join(dir, 'xl/styles.xml'), 'utf8');
      const sheetXml = fs.readFileSync(path.join(dir, 'xl/worksheets/sheet1.xml'), 'utf8');
      assert.match(stylesXml, /<fgColor rgb="FF70AD47"\/>/, 'the green title fill');
      assert.match(stylesXml, /<fgColor rgb="FFFFFF00"\/>/, 'the yellow headers');
      assert.match(stylesXml, /<fgColor rgb="FFED7D31"\/>/, 'the orange two');
      assert.match(sheetXml, /<mergeCell ref="D1:F1"\/>/);
      assert.match(sheetXml, /state="frozen"/);
      assert.match(sheetXml, /<autoFilter ref="A2:I4"\/>/);

      // The button came back, and nothing reached for a dialog.
      assert.strictEqual(await h.page.$eval('#art_xlsx', (b) => b.disabled), false);
      assert.strictEqual(await h.page.$eval('#art_xlsx', (b) => b.textContent.trim()), 'Download Excel');
      assert.ok((await h.page.evaluate('window.__toasts')).includes('Downloaded.'));
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('a filtered download is the filtered report', async () => {
    const h = await open('root');
    try {
      await draw(h, {});
      await h.page.selectOption('#art_dept', 'animation');
      await h.page.waitForFunction("document.querySelectorAll('.art-table tbody tr').length === 1");
      const [download] = await Promise.all([
        h.page.waitForEvent('download', { timeout: 20000 }),
        h.page.click('#art_xlsx'),
      ]);
      const file = path.join(h.downloads, 'filtered.xlsx');
      await download.saveAs(file);
      const sheet = xlsx.read(fs.readFileSync(file), { type: 'buffer' }).Sheets['Artist Report'];
      assert.strictEqual(sheet.D3.v, 'Asset anim', 'the file carries the filter the screen is showing');
      assert.strictEqual(sheet.A4, undefined, 'and nothing else');
      await h.native();
    } finally { await h.close(); }
  });

  await t.test('without the permission there is no Artist Report to open', async () => {
    const h = await open('ana');
    try {
      /* Ana holds no report key at all. reportSections() is the same function
         the tab uses, so an empty list here is an absent section there — and
         the endpoint refuses her as well, which the other suite pins. */
      const sections = await h.page.evaluate('reportSections().map(s => s.id)');
      assert.deepStrictEqual(sections, []);
      await h.page.evaluate('renderArtistReport()');
      assert.strictEqual(await h.page.$eval('#reportsView', (e) => e.innerHTML.trim()), '');
      await h.native();
    } finally { await h.close(); }
  });
});
