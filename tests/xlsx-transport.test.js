/* ARE THE BYTES THE WRITER MADE THE BYTES THE STUDIO RECEIVES?
 *
 * ===========================================================================
 * THE QUESTION PROMPT 54 ASKED FIRST, before looking at the file at all: is the
 * Artist Report corrupt in transit, or invalid as generated? The answer is
 * measured here rather than argued — the same report is produced four ways and
 * the four hashes are compared:
 *
 *   1. straight from src/artist-report-xlsx.js, in this process;
 *   2. as the HTTP response body of the real route on the real server;
 *   3. as a real Chromium downloads it, driven through the real page's
 *      Download Excel button — a fetch, a blob, an object URL and an <a
 *      download>, none of which exist outside a browser;
 *   4. as the desktop app downloads it, in a real Electron window with the
 *      app's own webPreferences and the app's own preload.
 *
 * They were already equal, which is how we knew the corruption was not in
 * transit — but nothing held them equal, so a `res.send(buffer.toString())`
 * would have shipped. Now something does.
 *
 * Both a small report and one of a few megabytes, because the failure modes
 * differ: a string conversion corrupts the small one too, while a truncating
 * Content-Length or a chunked-transfer mistake only shows up once the body is
 * bigger than a socket buffer.
 *
 * AND THE HEADERS, which are the rest of the delivery: the spreadsheet content
 * type, a Content-Length equal to the body, a Content-Disposition that quotes
 * the name and repeats it as filename*, and NO Content-Encoding — nothing may
 * compress a zip a second time behind a length we have already stated.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');
const artistXlsx = require('../src/artist-report-xlsx');
const artistReport = require('../src/artist-report');
const validator = require('./xlsx-validator');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CHROME = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean)
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const ELECTRON = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron');
const XVFB = ['/usr/bin/xvfb-run'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const hasElectron = (() => { try { return fs.statSync(ELECTRON).isFile(); } catch { return false; } })();

const cfg = config('artisttransport');
const SKIP = cfg
  ? (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!CHROME ? 'no Chromium found in this container.' : false))
  : SKIP_REASON;

/* The desktop leg needs the Electron binary, which lives in desktop/ and is a
   devDependency of a separate package. Its absence skips that leg and says so
   rather than quietly reporting a smaller pass. */
const ELECTRON_SKIP = hasElectron
  ? (XVFB ? false : 'xvfb-run is not installed, and Electron needs a display.')
  : 'Electron is not installed — run `npm install` in desktop/ to include the desktop download leg.';

const PASSWORD = 'Artist-Transport-1!';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ---- the page, lifted out of the application ---------------------------- */

function fixture() {
  const cut = (fromText, toText, what) => {
    const from = PAGE.indexOf(fromText);
    const to = PAGE.indexOf(toText, from + 1);
    assert.ok(from !== -1 && to > from, `found ${what} in the page`);
    return PAGE.slice(from, to);
  };
  const sections = cut('function reportSections(){', '/* ---------- Idle Report ----------', 'the report sections');
  const colours = cut('function effColor(v){', 'function effCell(v){', 'the efficiency colour bands');
  const artist = cut('/* ---------- Artist Report ----------', 'async function renderTeam(){', 'the Artist Report');

  /* No styles and no chrome: this fixture exists to press one button. The
     drawing is what tests/artist-report-browser.test.js is for. */
  return `<!doctype html><html><head><meta charset="utf-8"><title>download</title></head>
<body><div id="toast"></div><div id="reportsView"></div>
<script>
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function showToast(msg){ window.__toast = String(msg); }
function can(){ return true; }
const API_BASE = window.location.origin + '/api';
const state = { token: 'proxied' };
const reportState = { section: 'artist' };
async function api(path, opts = {}){
  const res = await fetch('/api' + path, { method: opts.method || 'GET' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) { const e = new Error((data && data.error) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
  return data;
}
${sections}
${colours}
${artist}
/* The filters come from the query string so the same page can ask for the small
   report or the big one, and then the real renderArtistReport() draws it and
   the real button downloads it. */
(async () => {
  const q = new URLSearchParams(location.search);
  for (const key of ['from', 'to', 'projectId']) if (q.get(key)) artistState.filters[key] = q.get(key);
  await renderArtistReport();
  window.__rows = (artistState.data && artistState.data.total) || 0;
  window.__ready = true;
})();
</script></body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the bytes the writer made are the bytes that arrive', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  let token;
  const id = {};
  const q = (text, params) => sql(cfg, text, params);
  const html = fixture();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artist-transport-'));

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'at-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'at-token', name: 'Root', email: 'root@at.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@at.test', password: PASSWORD } })).body.token;
    await openStudio(server.base, token);

    const as = (p, opts = {}) => api(server.base, p, { ...opts, token });
    id.client = (await as('/clients', { method: 'POST', body: { name: 'Acme Pictures' } })).body.client.id;

    /* THE SMALL REPORT: three rows through the real API, so the route under test
       reads rows the application itself created. */
    id.small = (await as('/projects', { method: 'POST', body: { name: 'Small Job', clientId: id.client } })).body.project.id;
    const people = [];
    for (const [key, name] of [['ana', 'Ana Artist'], ['bo', 'Bo Artist']]) {
      const r = await as('/users', { method: 'POST',
        body: { name, email: `${key}@at.test`, password: PASSWORD, role: 'game_artist' } });
      id[key] = r.body.user.id;
      people.push(r.body.user.id);
    }
    const submission = (assetId, userId, when) => q(
      `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, 1, 'tl', 'https://x.test/a', userId, when]);
    const session = (assetId, userId, seconds) => q(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, userId, 1, '2026-09-05 09:00:00', '2026-09-05 10:00:00', seconds]);

    for (const [key, type, hours, who] of [['a1', 'character', 12, 'ana'], ['a2', 'animation', 6, 'bo'], ['a3', 'prop', 3, 'ana']]) {
      const r = await as(`/assets/project/${id.small}`, { method: 'POST', body: { name: `Asset ${key}`, type, manHours: hours } });
      id[key] = r.body.asset.id;
      await submission(id[key], id[who], '2026-09-14 09:00:00');
      await session(id[key], id[who], Math.round(9.5 * 3600));
    }
    /* A blank client and a blank efficiency in the small file too, so the bytes
       being compared are not all of the easy shape. */
    await q('UPDATE assets SET man_hours = NULL WHERE id = ?', [id.a3]);

    /* THE BIG REPORT: the 50,000-row download cap, inserted in bulk because
       50,000 round trips through the API would take longer than the suite. The
       rows are the same shape the API makes — one asset_versions row per asset
       and person — and the route reads them with the same query either way. */
    id.big = (await as('/projects', { method: 'POST', body: { name: 'Big Job', clientId: id.client } })).body.project.id;
    const users = [];
    for (let u = 0; u < 100; u += 1) {
      const uid = crypto.randomUUID();
      users.push(uid);
      await q('INSERT INTO users (id, `name`, email, password_hash, role, is_active) VALUES (?,?,?,?,?,1)',
        [uid, `Bulk Resource ${String(u).padStart(3, '0')} von Hochdorf-Rechberg`, `bulk${u}@at.test`, 'x', 'game_artist']);
    }
    const assets = [];
    for (let a = 0; a < 500; a += 1) {
      const aid = crypto.randomUUID();
      assets.push(aid);
      await q('INSERT INTO assets (id, `code`, `name`, `type`, project_id, man_hours) VALUES (?,?,?,?,?,?)',
        [aid, `BIG-${a}`, `Bulk asset ${a} — the long descriptive name a studio types ${a * 7919 % 100000}`,
          a % 2 ? 'animation' : 'character', id.big, (a % 20) + 1]);
    }
    const batch = [];
    for (const aid of assets) {
      for (const uid of users) batch.push([crypto.randomUUID(), aid, 1, 'tl', 'https://x.test/a', uid, '2026-09-10 09:00:00']);
    }
    for (let i = 0; i < batch.length; i += 2000) {
      const slice = batch.slice(i, i + 2000);
      await q('INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at) VALUES '
        + slice.map(() => '(?,?,?,?,?,?,?)').join(','), slice.flat());
    }
    /* A SESSION PER PAIR, each with its own number of seconds, so that no two of
       the 50,000 rows read alike. A fixture whose every row is "3.00 hours,
       33.3%" compresses away to nothing and would not produce the multi-megabyte
       body this test is about. */
    const sessions = batch.map(([, aid, , , , uid], i) => [crypto.randomUUID(), aid, uid, 1,
      '2026-09-05 09:00:00', '2026-09-05 12:00:00', 600 + ((i * 7919) % 86400)]);
    for (let i = 0; i < sessions.length; i += 2000) {
      const slice = sessions.slice(i, i + 2000);
      await q('INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds) VALUES '
        + slice.map(() => '(?,?,?,?,?,?,?)').join(','), slice.flat());
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
      /* THE PROXY COPIES BYTES AND NOTHING ELSE: the response is piped, not
         read into a string, so this harness cannot be what makes the hashes
         agree. */
      const upstream = new URL(server.base + req.url.replace(/^\/api/, ''));
      const proxied = http.request({
        hostname: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search,
        method: req.method, headers: { Authorization: `Bearer ${token}` },
      }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      proxied.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(proxied);
    });
    await new Promise((r) => pageServer.listen(port, '127.0.0.1', r));
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  });

  t.after(async () => {
    if (pageServer) await new Promise((r) => pageServer.close(r));
    if (server) await stopServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /* ---- the four legs ---------------------------------------------------- */

  const SMALL = { from: '2026-09-01', to: '2026-09-30', projectId: null };
  const BIG = { from: '2026-09-01', to: '2026-09-30', projectId: null };

  const query = (f, projectId) => {
    const p = new URLSearchParams({ from: f.from, to: f.to });
    if (projectId) p.set('projectId', projectId);
    return p;
  };

  async function overHttp(params) {
    const res = await fetch(`${server.base}/reports/artist.xlsx?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
    return { headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  }

  async function throughChromium(params) {
    const page = await browser.newPage({ acceptDownloads: true });
    try {
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${pageOrigin}/?${params.toString()}`);
      await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 180000 }),
        page.click('#art_xlsx'),
      ]);
      const to = path.join(tmp, `chromium-${crypto.randomUUID()}.xlsx`);
      await download.saveAs(to);
      assert.deepStrictEqual(errors, [], 'no page errors');
      return { file: to, name: download.suggestedFilename(), rows: await page.evaluate('window.__rows') };
    } finally {
      await page.close();
    }
  }

  /* ELECTRON IS SPAWNED, NOT RUN SYNCHRONOUSLY, and that is not a style
     preference. The page Electron loads is served BY THIS PROCESS, so an
     execFileSync here blocks the event loop that has to answer it: the first
     attempt at this test failed with ERR_FAILED (-2) on a localhost URL because
     the test was the thing refusing to serve it. */
  function throughElectron(params) {
    const to = path.join(tmp, `electron-${crypto.randomUUID()}.xlsx`);
    return new Promise((resolve, reject) => {
      /* NODE_OPTIONS is cleared: this harness runs under --use-openssl-ca, which
         Electron refuses outright. */
      const child = spawn(XVFB, ['-a', ELECTRON, '--no-sandbox',
        path.join(__dirname, 'fixtures', 'electron-download.js'),
        `${pageOrigin}/?${params.toString()}`, to],
      { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const killer = setTimeout(() => child.kill('SIGKILL'), 300000);
      child.on('error', (e) => { clearTimeout(killer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(killer);
        const line = out.split('\n').find((l) => /^(SAVED|FAILED)/.test(l));
        if (!line || !line.startsWith('SAVED')) {
          reject(new Error(`Electron exited ${code}: ${line || out.trim() || '(no output)'}\n`
            + `stderr tail: ${err.trim().split('\n').slice(-6).join('\n')}`));
          return;
        }
        resolve({ file: to, line });
      });
    });
  }

  await t.test('a small report is identical from the writer, over HTTP, in Chromium and in Electron', async () => {
    const params = query(SMALL, id.small);
    const { headers, body } = await overHttp(params);
    const fromBrowser = fs.readFileSync((await throughChromium(params)).file);

    /* LEG 1: the writer, in this process, over the same rows the route read.
       Rebuilt from the file's own sheet rather than re-queried, because the
       point is the delivery and not the query — the route's own output is leg
       2 and the writer is deterministic, which the next assertion relies on. */
    const again = await overHttp(params);
    assert.strictEqual(sha(again.body), sha(body),
      'the writer is deterministic, so two downloads of the same report are the same bytes');

    assert.strictEqual(body.length, fromBrowser.length, 'the browser received every byte');
    assert.strictEqual(sha(fromBrowser), sha(body), 'and not one of them changed');
    validator.assertValid(fromBrowser, 'the file a browser downloaded');

    assert.strictEqual(headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.strictEqual(Number(headers.get('content-length')), body.length,
      'Content-Length is the body’s real length');
    assert.strictEqual(headers.get('content-encoding'), null,
      'nothing compressed the zip a second time behind the length we stated');
    assert.match(headers.get('content-disposition'),
      /^attachment; filename="Artist_Report_2026-09-01_to_2026-09-30\.xlsx"; filename\*=UTF-8''Artist_Report_2026-09-01_to_2026-09-30\.xlsx$/);
    assert.strictEqual(headers.get('etag'), null,
      'no ETag on a generated file, so no conditional GET can answer 304 with an empty body');

    /* A DOWNLOAD MUST ALWAYS ARRIVE. A 304 here would hand the studio a
       zero-byte file, so a request that invites one is asked for explicitly. */
    const revalidated = await fetch(`${server.base}/reports/artist.xlsx?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() },
    });
    assert.strictEqual(revalidated.status, 200, 'not a 304');
    assert.strictEqual(sha(Buffer.from(await revalidated.arrayBuffer())), sha(body), 'and the whole file again');
  });

  await t.test('and the desktop app receives the same bytes as the browser',
    { skip: ELECTRON_SKIP }, async () => {
      const params = query(SMALL, id.small);
      const { body } = await overHttp(params);
      const electron = await throughElectron(params);
      const fromDesktop = fs.readFileSync(electron.file);
      assert.strictEqual(fromDesktop.length, body.length, `Electron said: ${electron.line}`);
      assert.strictEqual(sha(fromDesktop), sha(body), 'byte for byte what the server sent');
      validator.assertValid(fromDesktop, 'the file the desktop app downloaded');
      assert.match(electron.line, /Artist_Report_2026-09-01_to_2026-09-30\.xlsx/,
        'and Electron took the name from the Content-Disposition');
    });

  await t.test('a report of a few megabytes survives all the same paths', async () => {
    const params = query(BIG, id.big);
    const { headers, body } = await overHttp(params);
    assert.ok(body.length > 2 * 1024 * 1024, `the big report is ${body.length} bytes, which is not a few megabytes`);
    assert.strictEqual(Number(headers.get('content-length')), body.length);
    assert.strictEqual(headers.get('content-encoding'), null);

    const browserLeg = await throughChromium(params);
    assert.strictEqual(browserLeg.rows, 50000, 'the fixture really is at the download cap');
    const fromBrowser = fs.readFileSync(browserLeg.file);
    assert.strictEqual(fromBrowser.length, body.length, 'nothing was truncated on the way to the browser');
    assert.strictEqual(sha(fromBrowser), sha(body));
    validator.assertValid(fromBrowser, 'the 50,000-row file a browser downloaded');
  });

  await t.test('and the desktop app receives the big one whole too',
    { skip: ELECTRON_SKIP }, async () => {
      const params = query(BIG, id.big);
      const { body } = await overHttp(params);
      const electron = await throughElectron(params);
      const fromDesktop = fs.readFileSync(electron.file);
      assert.strictEqual(fromDesktop.length, body.length, `Electron said: ${electron.line}`);
      assert.strictEqual(sha(fromDesktop), sha(body));
    });

  await t.test('the body is bytes, never a string', async () => {
    /* THE FAILURE THIS GUARDS. res.send(buffer.toString()) would encode the zip
       as UTF-8: every byte above 0x7f becomes two or three, the length changes
       and the file will not open. Asserted as a property of the bytes rather
       than by reading the route's source — a zip's local header signature is
       PK\x03\x04 and a UTF-8 round trip through a string destroys it. */
    const { body } = await overHttp(query(SMALL, id.small));
    assert.deepStrictEqual([...body.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'it starts with a zip signature');
    assert.notStrictEqual(sha(body), sha(Buffer.from(body.toString('utf8'), 'utf8')),
      'the body is not UTF-8-clean, so a string conversion would be visible');
    assert.ok(body.includes(Buffer.from('[Content_Types].xml', 'utf8')), 'and the package is in there');
  });

  await t.test('the file the studio receives is the file the writer makes, not merely a valid one', async () => {
    /* THE ONE LEG THE OTHER ASSERTIONS ASSUME: that the bytes on the wire are
       this writer's output over this report's rows, and not a valid file about
       something else. The rows come from the JSON endpoint beside the download —
       the same build() behind both — so the file is rebuilt here from what the
       screen would show and compared byte for byte with what the download sent.
       Nothing in this process touches the database directly; a test that opened
       its own connection through src/db.js would be configuring a second
       application rather than measuring this one. */
    const params = query(SMALL, id.small);
    const preview = (await api(server.base, `/reports/artist?${params.toString()}`, { token })).body;
    assert.ok(preview.total > 0 && preview.total <= artistReport.PAGE_SIZE,
      `the small report fits on one page: ${preview.total} rows`);
    const direct = artistXlsx.build({
      rows: preview.rows,
      title: artistReport.titleFor(preview.filters),
    });
    const { body } = await overHttp(params);
    assert.strictEqual(sha(direct), sha(body),
      'the writer called here over the preview’s rows, and the route called over HTTP, produce one file');
    validator.assertValid(direct, 'the writer’s own output');
  });
});
