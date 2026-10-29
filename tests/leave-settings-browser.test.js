/* SAVING THE LEAVE AND VACATION SETTINGS, IN A REAL BROWSER AGAINST THE REAL
 * SERVER.
 *
 * ===========================================================================
 * THE REPORT THIS FILE IS AN ANSWER TO: "the Super Admin cannot save the Leave
 * and Vacation mode settings", with no reason shown.
 *
 * WHY IT HAD TO BE A BROWSER. The endpoint was tried first, every combination
 * of it, on a fresh database AND on one upgraded from the last released schema
 * — and every save returned 200. So whatever the owner hit was not the
 * validator and not a missing column; it was between the form and the request,
 * which is the one place no test in this repository was looking.
 *
 * REAL ON BOTH SIDES. The server is the application booted against the test
 * database; the page's own renderLeaveSettings() and its save handler are
 * lifted out of public/index.html. Only signing in is stood in for, and /api is
 * proxied with the Super Admin's token because the lifted api() carries none.
 *
 * EVERY REQUEST AND RESPONSE IS RECORDED, because "it does not save" is a
 * report about a request somebody could not see.
 *
 * NO NATIVE DIALOGS: the desktop web view has none (Prompt 39), so alert,
 * confirm and prompt throw here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('leavesetbrowser');
const BROWSER_SKIP = !chromium ? 'playwright-core is not installed — run `npm install`.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;
const PASSWORD = 'LeaveSet-Browser-1!';

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
  const block = cut('const leaveState = { data:null', 'async function renderNudgeSettings(){', 'the Leave settings section');

  /* NO STUB MAY SHADOW WHAT THE LIFTED CODE DECLARES — a const beside a
     function of the same name is a SyntaxError that kills the whole script, and
     the symptom is a silent page. Checked before a browser is launched. */
  const declared = new Set([...block.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]));
  const mine = ['escapeHTML', 'api', 'FOLLOW_UP_SHOWN', 'can'];
  assert.deepStrictEqual(mine.filter((n) => declared.has(n)), [],
    'the lifted block already declares one of the fixture\'s own names');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="leaveSettingsSection"></div>
<script>
window.__native = [];
for (const name of ['alert', 'confirm', 'prompt']) {
  window[name] = (...a) => { window.__native.push([name, String(a[0] || '')]); throw new Error('native ' + name); };
}
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
let FOLLOW_UP_SHOWN = 'something';
function can(){ return true; }
/* THE REAL api(), in the shape public/index.html's own uses: it throws an Error
   carrying .status and .body on a non-2xx, which is what the save handler's
   catch reads. A stub that resolved on an error would be testing a different
   application. */
window.__calls = [];
async function api(p, opts = {}){
  const res = await fetch('/api' + p, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  window.__calls.push({ path: p, method: opts.method || 'GET', sent: opts.body || null, status: res.status, got: data });
  if (!res.ok) {
    const e = new Error((data && data.error) || ('HTTP ' + res.status));
    e.status = res.status; e.body = data; throw e;
  }
  return data;
}
${block}
window.__ready = true;
</script>
</body></html>`;
}

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the Leave and Vacation settings save, from the page', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  let token;
  let page;
  const html = fixture();
  const q = (text, params) => sql(cfg, text, params);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'lsb-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'lsb-token', name: 'Root', email: 'root@lsb.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@lsb.test', password: PASSWORD } })).body.token;
    await openStudio(server.base, token);

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
      const upstream = new URL(server.base + req.url.replace(/^\/api/, ''));
      const proxied = http.request({
        hostname: upstream.hostname, port: upstream.port,
        path: upstream.pathname + upstream.search, method: req.method,
        headers: { ...req.headers, host: upstream.host, Authorization: `Bearer ${token}` },
      }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      proxied.on('error', () => { res.writeHead(502); res.end('{}'); });
      req.pipe(proxied);
    });
    await new Promise((r) => pageServer.listen(port, '127.0.0.1', r));
    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  });

  t.after(async () => {
    if (page) await page.close().catch(() => {});
    if (pageServer) await new Promise((r) => pageServer.close(r));
    if (server) stopServer(server);
  });

  const openSection = async () => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${pageOrigin}/`);
    await page.waitForFunction('window.__ready === true');
    await page.evaluate(() => { leaveState.data = null; leaveState.errors = []; leaveState.msg = null; });
    await page.evaluate(() => renderLeaveSettings());
    await page.waitForSelector('#lv_save');
    assert.deepStrictEqual(errors, [], `the section draws without a page error: ${errors.join(' | ')}`);
    page.__errors = errors;
    return page;
  };

  /* PRESS SAVE AND REPORT EVERYTHING: what the form sent, what came back, and
     what the reader is left looking at. */
  const save = async (p) => {
    await p.evaluate(() => { window.__calls = []; });
    await p.click('#lv_save');
    await p.waitForFunction('window.__calls.some(c => c.method === "PUT")', null, { timeout: 20000 });
    await p.waitForFunction('document.getElementById("lv_save") && !document.getElementById("lv_save").disabled',
      null, { timeout: 20000 });
    const call = (await p.evaluate(() => window.__calls)).find((c) => c.method === 'PUT');
    const shown = await p.evaluate(() => ({
      msg: (document.querySelector('.pm-msg') || {}).textContent || null,
      msgKind: document.querySelector('.pm-msg.err') ? 'err' : (document.querySelector('.pm-msg.ok') ? 'ok' : null),
      fieldErrors: [...document.querySelectorAll('.rh-err')].map((e) => e.textContent.trim()),
      first: (document.getElementById('lv_first') || {}).value,
      second: (document.getElementById('lv_second') || {}).value,
      enabled: (document.getElementById('lv_enabled') || {}).checked,
      vacation: (document.getElementById('lv_vac') || {}).checked,
      notice: (document.getElementById('lv_vac_notice') || {}).value,
      range: (document.getElementById('lv_vac_range') || {}).value,
    }));
    /* READ ON THIS SIDE, not inside the page: the recorder is a Node-side
       array and naming it in a browser callback is a ReferenceError. */
    shown.pageErrors = p.__errors.slice();
    return { call, shown };
  };

  const stored = async () => (await q('SELECT * FROM leave_settings WHERE id = 1'))[0];

  /* PUT THE STORED STATE WHERE A CASE NEEDS IT, THROUGH THE ENDPOINT.
   *
   * NOT with an UPDATE behind the server's back, which is what the first run of
   * this file did and why two cases failed: src/leave-settings.js keeps the
   * settings in a process cache and reloads it only at boot and after its own
   * save(), so a direct write is invisible to the running application and the
   * page is then drawn from values nobody stored. (On the live site that cache
   * is correct — one Passenger process, and save() reloads it — but a test that
   * writes round it is testing a database rather than a program.) */
  const setStored = async (over) => {
    const now = (await api(server.base, '/admin/settings/leave', { token })).body.settings;
    const r = await api(server.base, '/admin/settings/leave', { method: 'PUT', token, body: {
      enabled: over.enabled,
      firstHalfEndMinutes: '13:00',
      secondHalfStartMinutes: '14:00',
      vacationEnabled: over.vacationEnabled,
      vacationRequireApproval: now.vacationRequireApproval,
      vacationMinNoticeDays: now.vacationMinNoticeDays,
      vacationMaxRangeDays: now.vacationMaxRangeDays,
      vacationEmailEnabled: now.vacationEmailEnabled,
    } });
    assert.ok(r.status < 400, `could not set up the stored state: ${JSON.stringify(r.body)}`);
  };

  await t.test('STEP 0a: the section draws, and every control the brief names is on it', async () => {
    const p = await openSection();
    for (const id of ['lv_enabled', 'lv_first', 'lv_second', 'lv_save',
      'lv_vac', 'lv_vac_approve', 'lv_vac_notice', 'lv_vac_range', 'lv_vac_mail']) {
      assert.strictEqual(await p.locator(`#${id}`).count(), 1, `#${id} is on the page`);
    }
    assert.deepStrictEqual(await p.evaluate(() => window.__native), []);
  });

  await t.test('STEP 0a: saving with no changes at all', async () => {
    const p = await openSection();
    const { call, shown } = await save(p);
    assert.strictEqual(call.status, 200, `${JSON.stringify(call)} / shown ${JSON.stringify(shown)}`);
    assert.strictEqual(shown.msgKind, 'ok', `a confirmation is shown: ${JSON.stringify(shown)}`);
    assert.match(shown.msg, /Saved/);
  });

  await t.test('STEP 0a: the Leave & Idle switch alone', async () => {
    const p = await openSection();
    await p.check('#lv_enabled');
    const { call, shown } = await save(p);
    assert.strictEqual(call.status, 200, JSON.stringify({ call, shown }));
    assert.strictEqual(call.sent.enabled, true, 'the form sent it');
    assert.strictEqual(Number((await stored()).enabled), 1, 'and it is stored');
    assert.strictEqual(shown.msgKind, 'ok');
  });

  await t.test('STEP 0a: THE OWNER’S CASE — both switches in one save', async () => {
    /* FROM BOTH OFF, which is the state a studio upgrades into and the state
       the reproduction has to start from. */
    await setStored({ enabled: false, vacationEnabled: false });
    const p = await openSection();
    assert.strictEqual(await p.isChecked('#lv_enabled'), false);
    assert.strictEqual(await p.isChecked('#lv_vac'), false);

    /* AND THIS IS THE BUG. The Vacation checkbox is rendered DISABLED while the
       master switch is off, and a disabled input is still disabled after the
       master switch is ticked unless something enables it. Playwright refuses
       to tick a disabled control, exactly as a person's mouse does nothing. */
    await p.check('#lv_enabled');
    const vacEnabledNow = await p.isEnabled('#lv_vac');
    assert.strictEqual(vacEnabledNow, true,
      'ticking Leave & Idle must enable the Vacation switch in the same breath, '
      + 'or the pair can never be turned on together');

    await p.check('#lv_vac');
    const { call, shown } = await save(p);
    assert.strictEqual(call.status, 200, JSON.stringify({ call, shown }));
    assert.strictEqual(call.sent.enabled, true);
    assert.strictEqual(call.sent.vacationEnabled, true);
    const row = await stored();
    assert.strictEqual(Number(row.enabled), 1);
    assert.strictEqual(Number(row.vacation_enabled), 1, 'both are stored from one save');
    assert.strictEqual(shown.msgKind, 'ok', JSON.stringify(shown));
  });

  await t.test('STEP 0a: every other field, one at a time', async () => {
    const steps = [
      ['the half-day split', async (p) => { await p.fill('#lv_first', '12:30'); await p.fill('#lv_second', '13:30'); },
        (row) => assert.strictEqual(Number(row.first_half_end_minutes), 750)],
      ['approval', async (p) => { await p.check('#lv_vac_approve'); },
        (row) => assert.strictEqual(Number(row.vacation_require_approval), 1)],
      ['minimum notice', async (p) => { await p.fill('#lv_vac_notice', '5'); },
        (row) => assert.strictEqual(Number(row.vacation_min_notice_days), 5)],
      ['maximum range', async (p) => { await p.fill('#lv_vac_range', '21'); },
        (row) => assert.strictEqual(Number(row.vacation_max_range_days), 21)],
      ['the email switch', async (p) => { await p.uncheck('#lv_vac_mail'); },
        (row) => assert.strictEqual(Number(row.vacation_email_enabled), 0)],
    ];
    for (const [label, act, check] of steps) {
      const p = await openSection();
      await act(p);
      const { call, shown } = await save(p);
      assert.strictEqual(call.status, 200, `${label}: ${JSON.stringify({ call, shown })}`);
      assert.strictEqual(shown.msgKind, 'ok', `${label}: a confirmation`);
      check(await stored());
    }
  });

  await t.test('a refusal shows its reason on the page and keeps what was typed', async () => {
    const p = await openSection();
    await p.fill('#lv_first', '15:00');
    await p.fill('#lv_second', '11:00');
    const { call, shown } = await save(p);
    assert.strictEqual(call.status, 422, JSON.stringify(call));
    /* THE READER MUST BE TOLD. A field error under the input, or a message
       beside Save, or both — but never nothing, which is what "no reason" in
       the report means. */
    const told = (shown.fieldErrors.length > 0) || Boolean(shown.msg);
    assert.ok(told, `the page shows the server's reason: ${JSON.stringify(shown)}`);
    assert.ok(shown.fieldErrors.concat(shown.msg || '').join(' ').length > 10,
      `and it is a sentence, not an empty box: ${JSON.stringify(shown)}`);
    // AND THE INPUT SURVIVES, so a correction is one keystroke and not a retype.
    assert.strictEqual(shown.first, '15:00', 'what was typed is still there');
    assert.strictEqual(shown.second, '11:00');
    assert.deepStrictEqual(await p.evaluate(() => window.__native), [], 'and never a native dialog');
  });

  await t.test('turning Leave & Idle off while Vacation is on is refused, and says what to do', async () => {
    await setStored({ enabled: true, vacationEnabled: true });
    const p = await openSection();
    assert.strictEqual(await p.isChecked('#lv_vac'), true);
    await p.uncheck('#lv_enabled');
    /* UNTICKING THE MASTER SWITCH MUST NOT SILENTLY UNTICK VACATION FOR THE
       READER — if it did, the refusal below could never be reached from the
       page and a studio would quietly lose Vacation mode by touching the other
       switch. */
    const { call, shown } = await save(p);
    if (call.status === 200) {
      /* If the page cleared the Vacation box for us, the save is legitimate and
         Vacation is off afterwards — but then the reader has to have been told,
         because this is a feature being switched off. */
      assert.strictEqual(Number((await stored()).vacation_enabled), 0);
      assert.ok(shown.msg, `switching the pair off has to say so: ${JSON.stringify(shown)}`);
    } else {
      assert.strictEqual(call.status, 422, JSON.stringify(call));
      const text = shown.fieldErrors.concat(shown.msg || '').join(' ');
      assert.match(text, /Vacation|vacation/, `the reason names the feature: ${JSON.stringify(shown)}`);
      assert.strictEqual(Number((await stored()).vacation_enabled), 1, 'and nothing changed');
    }
  });

  await t.test('a 403 and a server error each show a reason and keep the input', async () => {
    const p = await openSection();
    await p.fill('#lv_first', '12:00');
    /* THE PROXY ANSWERS INSTEAD OF THE APPLICATION for one press, which is the
       only way to produce a 403 and a 500 without breaking the server. */
    await p.route('**/api/admin/settings/leave', (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      return route.fulfill({ status: 403, contentType: 'application/json',
        body: JSON.stringify({ error: 'You do not have permission to do that' }) });
    });
    const forbidden = await save(p);
    assert.strictEqual(forbidden.call.status, 403);
    assert.ok(forbidden.shown.msg, `a 403 is shown: ${JSON.stringify(forbidden.shown)}`);
    assert.match(forbidden.shown.msg, /permission/i);
    assert.strictEqual(forbidden.shown.first, '12:00', 'and the input is kept');

    await p.unroute('**/api/admin/settings/leave');
    await p.route('**/api/admin/settings/leave', (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      return route.fulfill({ status: 500, contentType: 'text/html', body: '<html>boom</html>' });
    });
    const broke = await save(p);
    assert.strictEqual(broke.call.status, 500);
    assert.ok(broke.shown.msg, `a 500 is shown rather than swallowed: ${JSON.stringify(broke.shown)}`);
    assert.strictEqual(broke.shown.first, '12:00');
    assert.deepStrictEqual(await p.evaluate(() => window.__native), []);
  });
});
