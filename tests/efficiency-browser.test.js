/* THE 72,431.8% SCREEN, IN A REAL BROWSER, SHOWING 127.9%.
 *
 * ===========================================================================
 * WHY A BROWSER TEST FOR AN ARITHMETIC FIX. Because the arithmetic was never
 * the part anybody could see. The owner's screenshot had the two right numbers
 * on it — 143.6 hours estimated, 112.3 spent — beside a percentage that had
 * nothing to do with them, and no amount of correct server code proves that the
 * strip and the row a person actually reads now agree.
 *
 * So this seeds the shape of that screenshot against the real application,
 * renders the real Work Efficiency tab out of public/index.html, and reads the
 * KPI strip and the By User row off the rendered DOM — including the tooltips,
 * which are the fix's own promise that a reader can check the division.
 *
 * NO NATIVE DIALOGS: the desktop web view has none, so alert, confirm and
 * prompt throw here and any test that reaches one fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

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

const cfg = config('effbrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'Eff-Browser-1!';

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

  /* The Work Efficiency screen as it ships: the colour bands, the cell and bar
     renderers, the loader and the whole of renderReports(). Lifted rather than
     retyped, so what this drives is what the studio sees. */
  /* The screen's own state and view table, then the colour bands, the cells
     and the bar. Lifted together because renderReports() reads all of them. */
  const stateAndViews = cut('const reportState = { data:null', 'function effColor(v){', 'the report state');
  const colours = cut('function effColor(v){', 'async function loadReport(){', 'the colour bands and cells');
  const loader = cut('async function loadReport(){', '/* The Reports tab now holds two reports', 'the report loader');
  const render = cut('async function renderReports(sections = reportSections()){',
    '/* ---------- Artist Report ----------', 'the report renderer');
  /* The aside drawn under the figures where the meaning of the recorded hours
     changes. Real, not stubbed: it renders inside the block under test. */
  const cutover = cut('function cutoverNote(cutover){', '\n}\n', 'the cutover note') + '\n}';

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
const state = { token: 'proxied' };
/* The section list the real page builds from permissions; this screen is the
   efficiency one and the Idle/Artist tabs are not what is under test. */
function reportSections(){ return [{ id:'efficiency', label:'Work Efficiency', allowed:true }]; }
/* The two helpers renderReports() calls to draw and wire the section switch.
   With one section the real page draws nothing, which is what these do. */
function reportSectionTabs(){ return ''; }
function wireReportSections(){}
function renderReportsTab(){ return renderReports(); }
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
${stateAndViews}
${colours}
${loader}
${cutover}
${render}
window.__ready = true;
</script>
</body></html>`;
}

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('Work Efficiency, in a browser', { skip: SKIP }, async (t) => {
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
      BOOTSTRAP_TOKEN: 'eb-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'eb-token', name: 'Root', email: 'root@eb.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@eb.test');
    await openStudio(server.base, token.root);

    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Aadhil', email: 'aadhil@eb.test', password: PASSWORD, role: 'game_artist' } });
    id.aadhil = r.body.user.id;
    token.aadhil = await login('aadhil@eb.test');

    id.client = (await as('root', '/clients', { method: 'POST', body: { name: 'Acme' } })).body.client.id;
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Hero Quest', clientId: id.client } })).body.project.id;

    const submission = (assetId, userId) => q(
      `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, 1, 'tl', 'https://x.test/a', userId, '2026-10-14 09:00:00']);
    const session = (assetId, userId, seconds) => q(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, userId, 1, '2026-10-05 09:00:00', '2026-10-05 10:00:00', seconds]);

    /* THE SHAPE OF THE SCREENSHOT: 26 assets, 143.6 estimated hours against
       112.3 spent, one of them the asset with a real estimate and ONE SECOND
       recorded that carried the old headline into the tens of thousands. */
    /* THE NUMBERS ARE CHOSEN TO SURVIVE THE DATABASE. assets.man_hours is
       DECIMAL(6,1) and work_sessions.seconds is an integer, so a fixture of
       5.5352 hours each silently became 5.5 and the totals missed by nearly a
       whole hour. 25 assets at 5.5 plus one at 6.1 is exactly 143.6; 25
       sessions of 16171 seconds plus one of 1 is 112.2989 hours, which the
       report shows as 112.3 — and 143.6 / 112.3 is the 127.9 under test. */
    const tinyMan = 6.1;
    const man = 5.5;
    const sec = 16171;
    for (let i = 0; i < 26; i += 1) {
      const tiny = i === 25;
      const made = await as('root', `/assets/project/${id.project}`, { method: 'POST',
        body: { name: tiny ? 'One second' : `Asset ${i}`, type: 'character',
          manHours: tiny ? tinyMan : man } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      const assetId = made.body.asset.id;
      await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { assigneeId: id.aadhil } });
      await submission(assetId, id.aadhil);
      await session(assetId, id.aadhil, tiny ? 1 : sec);
      /* Submitting through the API would have started a clock of its own; these
         rows are written directly, so the seconds are exactly the fixture's. */
      await q('UPDATE work_sessions SET seconds = ? WHERE asset_id = ?',
        [tiny ? 1 : sec, assetId]);
    }

    const probe = http.createServer();
    await new Promise((res) => probe.listen(0, '127.0.0.1', res));
    const port = probe.address().port;
    probe.close();
    await new Promise((res) => probe.on('close', res));
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
        res.writeHead(out.status, { 'content-type': out.headers.get('content-type') || 'application/json' });
        res.end(buffer);
      });
    });
    await new Promise((res) => pageServer.listen(port, '127.0.0.1', res));
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
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.goto(pageOrigin, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true');
    const me = await as(who, '/auth/me');
    await page.evaluate((perms) => { window.__permissions = perms; },
      (me.body.user && me.body.user.permissions) || []);
    return {
      page,
      errors,
      close: async () => { await context.close(); },
      draw: async () => {
        await page.evaluate(() => renderReports());
        await page.waitForSelector('.stats .stat');
      },
    };
  }

  await t.test('the KPI strip shows 127.9%, and says which two numbers that is', async () => {
    const h = await open('root');
    try {
      await h.draw();

      const stats = await h.page.$$eval('.stats .stat', (nodes) => nodes.map((n) => ({
        num: n.querySelector('.num').textContent.trim(),
        lbl: n.querySelector('.lbl').textContent.trim(),
        title: n.getAttribute('title') || '',
      })));
      const by = (label) => stats.find((s) => s.lbl === label);

      assert.strictEqual(by('Assets reported').num, '26');
      assert.strictEqual(by('Man Hours estimated').num, '143.6');
      assert.strictEqual(by('Time Spent (h)').num, '112.3');

      /* THE FIGURE THE OWNER REPORTED, AND WHAT IT SAYS NOW. */
      assert.strictEqual(by('Total efficiency').num, '127.9%',
        'the owner\'s own arithmetic: 143.6 / 112.3');
      assert.notStrictEqual(by('Total efficiency').num, '72431.8%');

      /* AND THE TOOLTIP IS THE DIVISION. This is the whole promise of the fix:
         the percentage on screen can be checked against the two numbers that
         made it, without leaving the page. */
      assert.strictEqual(by('Total efficiency').title, '143.6h / 112.3h');
      assert.match(by('First-pass efficiency').title, /^143\.6h \/ [\d.]+h$/);

      assert.deepStrictEqual(await h.page.evaluate(() => window.__native), [],
        'no native dialog was reached');
      assert.deepStrictEqual(h.errors, []);
    } finally { await h.close(); }
  });

  await t.test('the By User row agrees with the strip, and carries its own tooltip', async () => {
    const h = await open('root');
    try {
      await h.draw();
      const row = await h.page.evaluate(() => {
        const tr = document.querySelector('table tbody tr');
        const cells = [...tr.children].map((td) => ({
          text: td.textContent.trim(), title: td.getAttribute('title') || '',
        }));
        return cells;
      });
      // Label, Assets, First pass, Total, bar, Man Hours, Time Spent, Shared, Skipped CD
      assert.strictEqual(row[0].text, 'Aadhil');
      assert.strictEqual(row[1].text, '26');
      assert.strictEqual(row[3].text, '127.9%', 'the By User row says what the strip says');
      assert.strictEqual(row[3].title, '143.6h / 112.3h');
      assert.strictEqual(row[5].text, '143.6h');
      assert.strictEqual(row[6].text, '112.3h');

      /* THE READER'S OWN CHECK, performed here: the two numbers on the row,
         divided, are the percentage on the row. */
      const man = Number(row[5].text.replace('h', ''));
      const spent = Number(row[6].text.replace('h', ''));
      assert.strictEqual(Math.round((man / spent) * 100 * 10) / 10,
        Number(row[3].text.replace('%', '')));
      assert.deepStrictEqual(h.errors, []);
    } finally { await h.close(); }
  });

  await t.test('the one-second asset is counted, and wears its chip', async () => {
    const h = await open('root');
    try {
      await h.draw();
      await h.page.evaluate(() => { reportState.view = 'assets'; return renderReports(); });
      await h.page.waitForSelector('table tbody tr');

      const marked = await h.page.$$eval('.rep-tiny', (nodes) => nodes.map((n) => ({
        text: n.textContent.trim(), title: n.getAttribute('title') || '',
      })));
      assert.strictEqual(marked.length, 1, 'exactly the one asset with a second against it');
      assert.strictEqual(marked[0].text, 'very little time');
      assert.match(marked[0].title, /Less than 0\.1h of time was recorded/);
      assert.match(marked[0].title, /counted in the figures/,
        'and it says the asset is still in the numbers, which is the point');

      // It is in the table, not hidden from it.
      const names = await h.page.$$eval('table tbody tr td:nth-child(2)',
        (nodes) => nodes.map((n) => n.textContent.trim()));
      assert.ok(names.includes('One second'));
      assert.strictEqual(names.length, 26);
      assert.deepStrictEqual(h.errors, []);
    } finally { await h.close(); }
  });
});
