/* PROMPT 65 PARTS B AND C IN A REAL BROWSER.
 *
 * ===========================================================================
 * TWO SCREENS, ONE FIXTURE, BECAUSE THEY ARE TWO VIEWS OF THE SAME DAYS.
 *
 * Part B put a window around which days accept entry; Part C added a tab that
 * shows those days as a record. Both are mostly things somebody SEES, and the
 * static suites cannot see anything:
 *
 *   tests/timesheet-day-window.test.js pins the window's arithmetic, its four
 *   routes and the shape of the page's source. It cannot tell you that a closed
 *   day is still readable, or that its tooltip says what to do.
 *
 *   tests/history.test.js pins the payload. It cannot tell you that the cards
 *   come out newest first, that the Submit button is disabled with the server's
 *   own sentence beside it, or that the person selector is absent without the
 *   key.
 *
 * REAL ON BOTH SIDES. The server is the application against the test database;
 * the page's code is LIFTED out of public/index.html rather than retyped. Only
 * the surrounding single-page application is stood in for, and /api is proxied
 * with the acting person's token because the page's api() sends none of its own.
 *
 * NO NATIVE DIALOGS: alert, confirm and prompt throw here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
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

const cfg = config('historybrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'HistBrowser-1!';

/* ---- the page under test ------------------------------------------------ */

function fixture() {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  const spans = [];
  const cut = (fromText, toText, what) => {
    const from = PAGE.indexOf(fromText);
    const to = PAGE.indexOf(toText, from + 1);
    assert.ok(from !== -1 && to > from, `found ${what} in the page`);
    spans.push([from, to, what]);
    return PAGE.slice(from, to);
  };

  /* THE HISTORY BLOCK, whole: HIST, the chip map, the event sentences, the
     card, the renderer and its wiring. */
  const historyBlock = cut('const HIST = {', '/* ---------- the exact-hours rule ---',
    "the page's History block");

  /* AND THE TIME SHEET TAB, which carries Part B's closed-day rendering inside
     renderTimesheet. The cut starts at the exact-hours rule because
     renderTimesheet calls into it — the same dependency tests/timesheet-export-
     browser.test.js documents after a frozen run caught it going stale. */
  const tab = cut('/* ---------- the exact-hours rule ---',
    '/* ---------- Download timesheets (everybody you can see) ----------',
    'the Time Sheet tab');
  for (const needed of ['function tsRuleLine(', 'async function renderTimesheet(',
    'const closed = Boolean(day.entryWindow']) {
    assert.ok(tab.includes(needed), `the lifted tab carries ${needed}`);
  }
  const tint = cut('function statusTint(colour){', 'const STATUSES = [', 'statusTint');

  /* EVERY LIFTED SPAN MUST BE DISJOINT, or a function is declared twice and the
     page dies on load with an error that looks like a bug in the feature. */
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i][0] >= sorted[i - 1][1],
      `the lifted spans are disjoint: ${sorted[i - 1][2]} overlaps ${sorted[i][2]}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  <div id="timesheetView"></div>
  <div id="historyView"></div>
  <span id="timesheetCount" hidden></span>
  <button id="timesheetTabBtn" hidden></button>
  <button id="historyTabBtn" hidden>My History</button>
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
const state = { token: 'proxied', currentUser: { id: null }, historyEnabled: true };
function fmtDate(s){ return s ? String(s) : ''; }
async function refreshTimesheetGate(){ return null; }
window.__lineOpenFor = null;
function openTimesheetLine(day){ window.__lineOpenFor = day; }
/* THE IN-PAGE ASK DIALOG, recorded and answered. The real one is a modal with
   its own suite; what matters here is that the page asks IN THE PAGE and never
   reaches for a native confirm. */
window.__asked = [];
window.__answer = true;
async function openAsk(opts){ window.__asked.push(opts); return window.__answer; }
/* WHICH TAB WAS ASKED FOR. "Open in Timesheet" is a navigation, and the
   assertion is that it carries the day. */
window.__tab = null;
function setTab(name){ window.__tab = name; }
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
${tint}
${tab}
${historyBlock}
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('My History and the entry window, in a browser', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  const token = {};
  const people = {};
  let projectId;
  let clientId;
  const asset = {};
  const html = fixture();

  const call = (p, options) => api(server.base, p, options);
  const as = (who, p, options = {}) => call(p, { ...options, token: token[who] });
  const q = (statement, params) => sql(cfg, statement, params);
  const today = () => require('../src/timesheet-gate').istDate();
  const shift = (n) => require('../src/timesheet-gate').shiftDays(today(), n);

  const setTimesheet = async (body) => {
    const res = await as('root', '/admin/settings/timesheet', { method: 'PUT', body });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  };
  const tsBody = (over = {}) => ({
    loggableDays: [1, 2, 3, 4, 5, 6, 7], minLineHours: 0.25, maxLineHours: 24,
    backdateDays: null, futureDays: null, requirePreviousDay: false,
    hoursRuleEnabled: false, hoursRuleFrom: null, ...over });
  const setHistory = async (body) => {
    const res = await as('root', '/admin/settings/history', { method: 'PUT', body });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  };
  const grant = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: [...new Set([...held, ...keys])] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const revoke = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: held.filter((k) => !keys.includes(k)) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'hb-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'hb-token', name: 'Root', email: 'root@hb2.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@hb2.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'History Browser' } })).body.project.id;

    for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@hb2.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@hb2.test`);
    }
    /* THE PEOPLE EXISTED BEFORE TODAY, or no past day can be drawn at all —
       src/history.js suppresses days before an account was made, and in a fresh
       test database every account is made this second. */
    await q('UPDATE users SET created_at = DATE_SUB(NOW(), INTERVAL 400 DAY) WHERE id IN (?, ?)',
      [people.ana, people.bo]);
    await setTimesheet(tsBody());
    await setHistory({ enabled: true, defaultDays: 30, submitFromHistory: true });

    const made = await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'Browser Asset', type: 'character', assigneeId: people.ana } });
    asset.id = made.body.asset.id;
    asset.code = made.body.asset.code;

    /* A DAY WITH REAL WORK ON IT. Closed in SQL because no route records an
       hour of the past, and the alternative is a test that waits an hour. */
    assert.strictEqual((await as('ana', `/assets/${asset.id}/start`,
      { method: 'POST', body: {} })).status, 200);
    await q(
      `UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL 120 MINUTE),
          ended_at = NOW(), seconds = 7200, ended_reason = 'submit'
        WHERE user_id = ? AND ended_at IS NULL`, [people.ana]);

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

  async function open(who) {
    if (!browser) {
      browser = await chromium.launch({ executablePath: EXECUTABLE,
        args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    }
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-acting': who } });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto(pageOrigin, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true');
    const me = await as(who, '/auth/me');
    await page.evaluate(({ perms, user }) => {
      window.__permissions = perms;
      state.currentUser = { id: user.id, name: user.name };
    }, { perms: (me.body.user && me.body.user.permissions) || [], user: me.body.user });
    const clean = async () => {
      assert.deepStrictEqual(await page.evaluate('window.__native'), [],
        'nothing reached for a native dialog');
      assert.deepStrictEqual(errors, [], 'and nothing threw or logged an error');
      assert.deepStrictEqual(failed, [], 'and no request failed');
    };
    return { page, errors, failed, clean, close: () => context.close() };
  }

  const drawHistory = (page) => page.evaluate(async () => {
    await renderHistory();
    return document.querySelectorAll('.hist-card').length;
  });

  /* ---- Part C: the cards ----------------------------------------------- */

  await t.test('the tab lists days newest first, with the work and the figures',
    async () => {
      const tab = await open('ana');
      const count = await drawHistory(tab.page);
      assert.ok(count >= 1, `cards were drawn: ${count}`);

      const seen = await tab.page.evaluate(() => {
        const cards = [...document.querySelectorAll('.hist-card')];
        return {
          dates: cards.map((c) => c.dataset.day),
          first: {
            chip: (cards[0].querySelector('.hist-chip') || {}).textContent,
            code: (cards[0].querySelector('.hist-code') || {}).textContent,
            time: (cards[0].querySelector('.hist-time') || {}).textContent,
            where: (cards[0].querySelector('.hist-where') || {}).textContent,
          },
        };
      });
      /* NEWEST FIRST, asserted as an ordering rather than by naming a date —
         the suite must not depend on which day it runs on. */
      const sorted = [...seen.dates].sort().reverse();
      assert.deepStrictEqual(seen.dates, sorted, 'newest first');
      assert.match(seen.first.chip.trim(), /Worked/);
      assert.strictEqual(seen.first.code.trim(), asset.code);
      /* TWO HOURS, LABELLED BY THE SERVER. The page prints what it was given. */
      assert.strictEqual(seen.first.time.trim(), '2 h');
      assert.match(seen.first.where, /History Browser/);
      await tab.clean();
      await tab.close();
    });

  await t.test('Submit is disabled with the server\'s own sentence when the day is short',
    async () => {
      await setTimesheet(tsBody({ maxDayHours: 8, hoursRuleEnabled: true,
        hoursRuleFrom: shift(-30) }));
      assert.strictEqual((await as('ana', '/timesheets/entries', { method: 'POST',
        body: { date: today(), hours: 3, nonProject: 'leave' } })).status, 201);
      try {
        const tab = await open('ana');
        await drawHistory(tab.page);
        const seen = await tab.page.evaluate(() => {
          const card = document.querySelector('.hist-card');
          const btn = card.querySelector('.hist-ts-actions button');
          const why = card.querySelector('.hist-why');
          return {
            label: btn ? btn.textContent.trim() : null,
            disabled: btn ? btn.disabled : null,
            tag: btn ? btn.tagName : null,
            tooltip: btn ? btn.getAttribute('title') : null,
            describedBy: btn ? btn.getAttribute('aria-describedby') : null,
            whyId: why ? why.id : null,
            whyText: why ? why.textContent.trim() : null,
          };
        });
        assert.strictEqual(seen.tag, 'BUTTON', 'a real button, in the tab order');
        assert.strictEqual(seen.disabled, true);
        assert.strictEqual(seen.label, 'Submit timesheet');
        /* THE SERVER'S OWN SENTENCE IN BOTH PLACES — a tooltip is unreachable on
           a touchscreen and visible text is unreachable by a reader on the
           button alone, so the day needs both. */
        const card = (await as('ana', '/history')).body.days
          .find((d) => d.date === today());
        assert.strictEqual(seen.tooltip, card.timesheet.reason);
        assert.strictEqual(seen.whyText, card.timesheet.reason);
        assert.strictEqual(seen.describedBy, seen.whyId);
        await tab.clean();
        await tab.close();
      } finally {
        await setTimesheet(tsBody());
      }
    });

  await t.test('Submit works from History when the day is exact', async () => {
    await setTimesheet(tsBody({ maxDayHours: 8, hoursRuleEnabled: true,
      hoursRuleFrom: shift(-30) }));
    try {
      assert.strictEqual((await as('ana', '/timesheets/entries', { method: 'POST',
        body: { date: today(), hours: 5, nonProject: 'leave' } })).status, 201);
      const tab = await open('ana');
      await drawHistory(tab.page);
      const pressed = await tab.page.evaluate(async () => {
        const btn = document.querySelector('.hist-submit');
        if (!btn) return { found: false };
        btn.click();
        await new Promise((r) => setTimeout(r, 700));
        const card = document.querySelector('.hist-card');
        return {
          found: true,
          toasts: window.__toasts,
          state: (card.querySelector('.hist-ts-state') || {}).textContent,
          stillHasButton: Boolean(card.querySelector('.hist-submit')),
        };
      });
      assert.strictEqual(pressed.found, true, 'the button is drawn on an exact day');
      assert.ok(pressed.toasts.some((m) => /submitted/i.test(m)), JSON.stringify(pressed.toasts));
      assert.match(pressed.state.trim(), /Submitted/);
      assert.strictEqual(pressed.stillHasButton, false, 'and it is gone afterwards');
      /* AND THE SERVER AGREES, which is what makes it the same route. */
      const res = await as('ana', `/timesheets/week?date=${today()}`);
      assert.strictEqual(res.body.days.find((d) => d.date === today()).status, 'submitted');
      await tab.clean();
      await tab.close();
    } finally {
      await setTimesheet(tsBody());
    }
  });

  await t.test('the person selector appears only with the second key', async () => {
    /* WITHOUT history.view_others: no selector at all. The route answers with
       just this person, so there is nothing to choose between. */
    const plain = await open('ana');
    await drawHistory(plain.page);
    assert.strictEqual(await plain.page.evaluate(
      () => Boolean(document.getElementById('hist_user'))), false,
    'no selector without the key');
    await plain.clean();
    await plain.close();

    /* WITH IT, and with somebody to choose: the Super Admin holds both keys and
       timesheet.all, so the studio is in the list. */
    const admin = await open('root');
    await drawHistory(admin.page);
    const names = await admin.page.evaluate(() => {
      const sel = document.getElementById('hist_user');
      return sel ? [...sel.options].map((o) => o.textContent) : null;
    });
    assert.ok(Array.isArray(names) && names.length > 1,
      `the selector is drawn with the people they may see: ${JSON.stringify(names)}`);
    assert.ok(names.includes('ana'));
    await admin.clean();
    await admin.close();
  });

  await t.test('the range shortcuts and the date filters redraw from the server',
    async () => {
      const tab = await open('ana');
      await drawHistory(tab.page);
      const out = await tab.page.evaluate(async () => {
        document.querySelector('.hist-span[data-days="7"]').click();
        await new Promise((r) => setTimeout(r, 600));
        const from = document.getElementById('hist_from').value;
        const to = document.getElementById('hist_to').value;
        return { from, to, cards: document.querySelectorAll('.hist-card').length };
      });
      /* THE RANGE CAME BACK FROM THE SERVER, which clamped and ordered it — the
         page did not work out what seven days means. */
      const span = (Date.parse(`${out.to}T00:00:00Z`) - Date.parse(`${out.from}T00:00:00Z`))
        / 86400000;
      assert.strictEqual(span, 6, 'seven days inclusive');
      await tab.clean();
      await tab.close();
    });

  await t.test('Open in Timesheet carries the day, and History never edits a line',
    async () => {
      const tab = await open('ana');
      await drawHistory(tab.page);
      const out = await tab.page.evaluate(async () => {
        const btn = document.querySelector('.hist-open-ts');
        if (!btn) return { found: false };
        const day = btn.dataset.day;
        btn.click();
        await new Promise((r) => setTimeout(r, 100));
        return { found: true, day, tab: window.__tab, tsDate: tsState.date };
      });
      if (out.found) {
        assert.strictEqual(out.tab, 'timesheet', 'it navigates to the Time Sheet tab');
        assert.strictEqual(out.tsDate, out.day, 'at that day');
      }
      /* AND THERE IS NO WAY TO EDIT A LINE FROM A CARD: no inputs, no editable
         cells, no delete. A history you can type into is a draft. */
      const writable = await tab.page.evaluate(() => {
        const cards = [...document.querySelectorAll('.hist-card')];
        return cards.reduce((n, c) => n
          + c.querySelectorAll('input, textarea, select, [contenteditable="true"]').length, 0);
      });
      assert.strictEqual(writable, 0, 'a card holds no editable control');
      await tab.clean();
      await tab.close();
    });

  await t.test('with the tab switched off the page says so and draws nothing',
    async () => {
      await setHistory({ enabled: false, defaultDays: 30, submitFromHistory: true });
      try {
        const tab = await open('ana');
        const out = await tab.page.evaluate(async () => {
          await renderHistory();
          return {
            cards: document.querySelectorAll('.hist-card').length,
            err: (document.querySelector('.hist-err') || {}).textContent || '',
          };
        });
        assert.strictEqual(out.cards, 0, 'no cards');
        assert.match(out.err, /switched off/, 'and the server\'s own sentence, in the page');
        /* A 409 IS AN EXPECTED ANSWER HERE, so the request-failed check would be
           wrong to apply: the page asked, the server declined, and the page said
           so. Only the native-dialog and page-error checks apply. */
        assert.deepStrictEqual(await tab.page.evaluate('window.__native'), []);
        await tab.close();
      } finally {
        await setHistory({ enabled: true, defaultDays: 30, submitFromHistory: true });
      }
    });

  /* ---- Part B: a closed day in the Time Sheet tab ---------------------- */

  await t.test('a closed day is readable, has no write controls, and says why',
    async () => {
      const old = shift(-5);
      assert.strictEqual((await as('bo', '/timesheets/entries', { method: 'POST',
        body: { date: old, hours: 2, nonProject: 'leave' } })).status, 201);
      await setTimesheet(tsBody({ backdateDays: 1, futureDays: 0 }));
      try {
        const tab = await open('bo');
        const seen = await tab.page.evaluate(async ({ day }) => {
          tsState.date = day;
          await renderTimesheet();
          const card = [...document.querySelectorAll('.ts-day')]
            .find((c) => (c.querySelector('.ts-day-date') || {}).textContent
              && c.className.includes('closed'));
          const all = [...document.querySelectorAll('.ts-day')];
          return {
            closedCards: all.filter((c) => c.className.includes('closed')).length,
            totalCards: all.length,
            chip: card ? (card.querySelector('.ts-flag.closed') || {}).textContent : null,
            tooltip: card ? (card.querySelector('.ts-flag.closed') || {}).title : null,
            note: card ? (card.querySelector('.ts-closed-note') || {}).textContent : null,
            /* THE WRITE CONTROLS, counted on the closed cards only. */
            addButtons: all.filter((c) => c.className.includes('closed'))
              .reduce((n, c) => n + c.querySelectorAll('.ts-add').length, 0),
            submitButtons: all.filter((c) => c.className.includes('closed'))
              .reduce((n, c) => n + c.querySelectorAll('.ts-submit-day').length, 0),
            /* AND THE LINES ARE STILL THERE, which is the point of not hiding
               the day: it stays readable. */
            lines: all.filter((c) => c.className.includes('closed'))
              .reduce((n, c) => n + c.querySelectorAll('.ts-lines tr').length, 0),
          };
        }, { day: old });

        assert.ok(seen.closedCards > 0, `some days are closed: ${JSON.stringify(seen)}`);
        /* EVERY DAY OF THAT WEEK IS CLOSED, and that is correct rather than a
           wall: the week being looked at is five days back and the window is
           "today and yesterday", so none of its days is open. The window being
           a window is asserted on the CURRENT week below, where the two kinds
           of day sit side by side — which is the honest way to show it. */
        assert.strictEqual(seen.closedCards, seen.totalCards,
          'the whole of a past week is closed, since none of its days is within the window');
        assert.match((seen.chip || '').trim(), /Closed for entry/);
        assert.ok((seen.tooltip || '').length > 0, 'the chip carries the reason');
        assert.ok((seen.note || '').length > 0, 'and it is said in the card too');
        assert.strictEqual(seen.addButtons, 0, 'no Add a line on a closed day');
        assert.strictEqual(seen.submitButtons, 0, 'and no Submit');
        assert.ok(seen.lines > 0, 'but the lines are still readable');

        /* AND THE CURRENT WEEK HAS BOTH KINDS, which is what makes this a
           window: today and yesterday accept entry, the rest of the week does
           not, and the same page draws both from the same payload. */
        const now = await tab.page.evaluate(async ({ day }) => {
          tsState.date = day;
          await renderTimesheet();
          const all = [...document.querySelectorAll('.ts-day')];
          return {
            closed: all.filter((c) => c.className.includes('closed')).length,
            open: all.filter((c) => !c.className.includes('closed')).length,
            addOnOpen: all.filter((c) => !c.className.includes('closed'))
              .reduce((n, c) => n + c.querySelectorAll('.ts-add').length, 0),
          };
        }, { day: today() });
        assert.ok(now.open > 0, `some days of this week are open: ${JSON.stringify(now)}`);
        assert.ok(now.closed > 0, 'and some are not');
        assert.ok(now.addOnOpen > 0, 'and the open ones keep their write controls');
        await tab.clean();
        await tab.close();
      } finally {
        await setTimesheet(tsBody());
      }
    });

  await t.test('a holder of timesheet.backdate sees the same old day as open',
    async () => {
      const old = shift(-5);
      await grant('game_artist', ['timesheet.backdate']);
      await setTimesheet(tsBody({ backdateDays: 1, futureDays: 0 }));
      try {
        const tab = await open('bo');
        const seen = await tab.page.evaluate(async ({ day }) => {
          tsState.date = day;
          await renderTimesheet();
          const all = [...document.querySelectorAll('.ts-day')];
          return {
            closedCards: all.filter((c) => c.className.includes('closed')).length,
            addButtons: all.reduce((n, c) => n + c.querySelectorAll('.ts-add').length, 0),
          };
        }, { day: old });
        assert.strictEqual(seen.closedCards, 0,
          'the key opens every day, so none of them is drawn closed');
        assert.ok(seen.addButtons > 0, 'and the write controls are back');
        await tab.clean();
        await tab.close();
      } finally {
        await setTimesheet(tsBody());
        await revoke('game_artist', ['timesheet.backdate']);
      }
    });

  await t.test('an admin opens a day from History, and its owner can then fill it',
    async () => {
      /* A DAY THAT HAS SOMETHING ON IT, and that is not an incidental choice.
       *
       * History does not draw a day with no activity at all — which is the
       * brief's own rule and the right one — so a day nobody has ever touched
       * has no card and therefore no "Open this day" button on it. My first
       * version of this test picked an untouched day and failed with a list of
       * one card, which is the feature behaving correctly.
       *
       * SO THE TIMESHEET TAB IS WHERE AN EMPTY CLOSED DAY IS OPENED: it draws
       * all seven days of a week whether or not anything is on them. History's
       * button is for a day that has something on it and still needs finishing,
       * which is the case somebody actually goes looking for. This is written
       * down because it is a real limit of the History button, not a bug. */
      const old = shift(-5);
      await setTimesheet(tsBody({ backdateDays: 1, futureDays: 0 }));
      try {
        /* THE OWNER CANNOT, TO BEGIN WITH. */
        assert.strictEqual((await as('bo', '/timesheets/entries', { method: 'POST',
          body: { date: old, hours: 1, nonProject: 'leave' } })).status, 422);
        /* AND THE DAY HAS A CARD, because an earlier test filed a line on it —
           asserted rather than assumed, so a reordering of this file fails here
           with a clear reason instead of on the button. */
        const cardThere = (await as('root', `/history?userId=${people.bo}`)).body.days
          .some((d) => d.date === old);
        assert.ok(cardThere, `${old} has a card for the admin to act on`);

        /* THE ADMIN OPENS IT FROM THE CARD, through the page's own ask dialog —
           no native confirm anywhere. */
        const admin = await open('root');
        const out = await admin.page.evaluate(async ({ who, day }) => {
          HIST.userId = who;
          await renderHistory();
          const card = [...document.querySelectorAll('.hist-card')]
            .find((c) => c.dataset.day === day);
          const btn = card && card.querySelector('.hist-unlock');
          if (!btn) return { found: false, dates: [...document.querySelectorAll('.hist-card')]
            .map((c) => c.dataset.day) };
          btn.click();
          await new Promise((r) => setTimeout(r, 700));
          return { found: true, asked: window.__asked.length, toasts: window.__toasts };
        }, { who: people.bo, day: old });

        assert.strictEqual(out.found, true,
          `the Open this day button is on that card: ${JSON.stringify(out.dates || [])}`);
        assert.ok(out.asked >= 1, 'it asked first, in the page');
        assert.ok(out.toasts.some((m) => /open/i.test(m)), JSON.stringify(out.toasts));
        await admin.clean();
        await admin.close();

        /* AND NOW THE OWNER CAN FILL AND SUBMIT IT. */
        const made = await as('bo', '/timesheets/entries', { method: 'POST',
          body: { date: old, hours: 1, nonProject: 'leave' } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        assert.strictEqual((await as('bo', '/timesheets/submit',
          { method: 'POST', body: { date: old } })).status, 200);

        /* AND THE UNLOCK CLOSED ITSELF, which is the whole of its lifetime. */
        const rows = await q(
          'SELECT closed_at FROM timesheet_day_unlocks WHERE user_id = ? AND `date` = ?',
          [people.bo, old]);
        assert.ok(rows.length >= 1);
        assert.ok(rows.every((r) => r.closed_at), 'every row for that day is closed');
      } finally {
        await setTimesheet(tsBody());
      }
    });
});
