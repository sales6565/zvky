/* "Download timesheets" IN A REAL BROWSER, IN EVERY STATE OF THE TIMESHEET TAB.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE STATIC SUITE CANNOT. tests/timesheet-export-button
 * .test.js reads public/index.html and pins where the button is written; this
 * one draws the tab against the real server and looks for the button on the
 * screen — as Super Admin, as a role granted timesheet.export, and as a role
 * without it — in every state the tab has:
 *
 *     the current week · the previous week · the next week
 *     somebody else's week, through the person picker
 *     a week with a submitted and locked day
 *     a week with nothing on it at all
 *     with the Add-a-line modal open over it
 *
 * THE TAB HAS NO SUB-TABS — measured, not assumed: renderTimesheet() draws one
 * `.ts-bar` and then the seven day cards, and the seven states above are the
 * whole of what it can show. The button lives in that bar, which is why it is
 * in all of them; this suite is the test that would fail if somebody moved it
 * into a day card or gated it on whose week is open.
 *
 * AND THE MODAL BEHIND IT: the four period modes, the live count line, the
 * sentence a person with no wider timesheet access gets, and a real download
 * whose bytes are compared with the server's own X-Content-SHA256 header.
 *
 * REAL ON BOTH SIDES. The server is the application, booted against the test
 * database; the page's own code is lifted out of public/index.html. Only the
 * surrounding single-page application is stood in for — signing in and routing
 * are not what is under test — and /api is proxied with the acting person's
 * token, because the page's api() sends none of its own.
 *
 * NO NATIVE DIALOGS (Prompt 39): alert, confirm and prompt throw here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, openStudio,
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

const cfg = config('tsexportbrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'Export-Browser-1!';
/* A Monday, and a fixed one. The tab is a week at a time and a suite that used
   today would test a different set of day cards every Monday morning. */
const MON = '2026-03-02';
/* The month the fixture's submitted days are in, for the modal — which opens on
   the CURRENT month, as a month-end download should, and so needs telling. */
const FIXTURE_MONTH = 3;
const FIXTURE_YEAR = 2026;

/* The Monday of the real current week, which is the one week in this suite that
   cannot be a fixed date: "This week" is a state of the tab and the only way to
   wait for it is to know where it lands. Same arithmetic as the page's own
   weekStart — Monday-based, in UTC. */
function thisMonday() {
  const now = new Date();
  const utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - back * 86400000).toISOString().slice(0, 10);
}

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

  /* Lifted, not retyped, so this drives what ships: the whole Time Sheet tab
     (tsState, renderTimesheet, wireTimesheet, downloadAuthed), the download
     modal's own code, its static markup and the three lines that wire it. */
  const tab = cut('/* ---------- Time Sheet ----------',
    '/* ---------- Download timesheets (everybody you can see) ----------', 'the Time Sheet tab');
  const modal = cut('/* ---------- Download timesheets (everybody you can see) ----------',
    '/* One line of a day. A modal rather than an inline row', 'the download modal');
  const wiring = cut("const tsExportWrap = document.getElementById('tsExportWrap');",
    '/* THE EMOJI PICKER CLOSES', 'the modal’s wiring');
  const markup = cut('<!-- DOWNLOAD TIMESHEETS.', '<div class="modal-wrap" id="modalWrap">',
    'the modal’s markup');
  const tint = cut('function statusTint(colour){', 'const STATUSES = [', 'statusTint');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  <div id="timesheetView"></div>
  <span id="timesheetCount" hidden></span>
  <button id="timesheetTabBtn" hidden></button>
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
const API_BASE = window.location.origin + '/api';
/* downloadAuthed reads state.token for its Authorization header; the proxy
   attaches the real one, so any non-empty value will do here. state.currentUser
   is set per sign-in by the harness below. */
const state = { token: 'proxied', currentUser: { id: null } };
/* Two page-wide helpers the tab calls and this suite is not testing. */
function fmtDate(s){ return s ? String(s) : ''; }
async function refreshTimesheetGate(){ return null; }
/* Add-a-line is a modal of its own, with its own suite. Here it only has to
   be reachable, so that the state "the line form is open over the tab" can be
   entered and the header bar checked underneath it. */
window.__lineOpenFor = null;
function openTimesheetLine(day){ window.__lineOpenFor = day; }
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
${modal}
${wiring}
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the Download timesheets button, in a browser, in every state of the tab',
  { skip: SKIP }, async (t) => {
    let server;
    let pageServer;
    let pageOrigin;
    const token = {};
    const id = {};
    const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
    const html = fixture();
    let acting = 'root';

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, {
        BOOTSTRAP_TOKEN: 'teb-token',
        WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      });
      await api(server.base, '/auth/bootstrap', { method: 'POST',
        body: { token: 'teb-token', name: 'Root', email: 'root@teb.test', password: PASSWORD } });
      const login = async (email) => (await api(server.base, '/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@teb.test');
      await openStudio(server.base, token.root);

      id.client = (await as('root', '/clients')).body.clients[0].id;
      id.project = (await as('root', '/projects', { method: 'POST',
        body: { clientId: id.client, name: 'Export Browser' } })).body.project.id;

      /* THREE ROLES, WHICH IS THE WHOLE POINT OF THE SUITE.
         root  Super Admin — holds the key by construction.
         lee   team_lead, GRANTED timesheet.export below, and leads Ana, so the
               picker exists for them and the download covers two people.
         ana   game_artist, granted NOTHING — the negative case.   */
      for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist']]) {
        const made = await as('root', '/users', { method: 'POST',
          body: { name: who === 'lee' ? 'Lee Lead' : 'Ana Artist',
            email: `${who}@teb.test`, role, password: PASSWORD, projectId: id.project } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        id[who] = made.body.user.id;
        token[who] = await login(`${who}@teb.test`);
      }
      await as('root', `/users/${id.ana}`, { method: 'PATCH',
        body: { reportsToId: id.lee, teamLeadId: id.lee } });

      const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      assert.ok(!held.includes('timesheet.export'), 'a lead does not hold it by default');
      await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: [...held, 'timesheet.export'] } });

      /* Two submitted days in the fixed week, so there is something to count
         and the tab has a locked day to draw. Ana's Monday and Lee's Tuesday. */
      const file = async (who, date) => {
        const line = await as(who, '/timesheets/entries', { method: 'POST',
          body: { date, hours: 2, nonProject: 'admin', notes: 'Fixture' } });
        assert.strictEqual(line.status, 201, JSON.stringify(line.body));
        const sent = await as(who, '/timesheets/submit', { method: 'POST', body: { date } });
        assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      };
      await file('ana', MON);
      await file('lee', '2026-03-03');

      /* The page, and /api proxied to the application with the acting person's
         token — the page's api() is same-origin and carries none. Every header
         the download needs is passed through, X-Content-SHA256 included: that
         header is how a truncated transport gets caught. */
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
          for (const name of ['content-disposition', 'x-content-sha256', 'cache-control']) {
            const value = out.headers.get(name);
            if (value) headers[name] = value;
          }
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
        browser = await chromium.launch({ executablePath: EXECUTABLE,
          args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      }
      const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'tsexp-dl-'));
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message)));
      await page.goto(pageOrigin, { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true');
      const me = await as(who, '/auth/me');
      await page.evaluate(({ perms, user }) => {
        window.__permissions = perms;
        state.currentUser = { id: user.id, name: user.name };
        tsState.date = null; tsState.userId = null; tsState.people = []; tsState.week = null;
      }, { perms: (me.body.user && me.body.user.permissions) || [], user: me.body.user });
      const native = async () => {
        assert.deepStrictEqual(await page.evaluate('window.__native'), [],
          'nothing reached for a native dialog');
        assert.deepStrictEqual(errors.filter((e) => /native (alert|confirm|prompt)/.test(e)), []);
      };
      return { page, downloads, errors, native, who, close: () => context.close() };
    }

    /* Draw the tab on a chosen week, and wait for it to settle. */
    const draw = async (h, date = MON) => {
      await h.page.evaluate((d) => { tsState.date = d; return renderTimesheet(); }, date);
      await h.page.waitForSelector('.ts-bar');
    };

    /* VISIBLE, not merely present: the brief asks for a button somebody can
       press, and a present-but-hidden one is the same bug with a different
       cause. Playwright's isVisible walks the layout. */
    const buttonVisible = async (h) => {
      const found = await h.page.$('#timesheet-export-btn');
      if (!found) {
        h.lastHtml = (await h.page.$eval('#timesheetView', (e) => e.innerHTML)).slice(0, 400);
        return false;
      }
      return found.isVisible();
    };

    /* The modal, pointed at the month the fixture's days are in, through its own
       controls — a test that set tsExportState directly would not be testing the
       two selects. */
    const toFixtureMonth = async (h) => {
      await h.page.selectOption('#tse_year', String(FIXTURE_YEAR));
      await h.page.waitForSelector('#tse_month');
      await h.page.selectOption('#tse_month', String(FIXTURE_MONTH));
      await h.page.waitForFunction("document.querySelector('#tse_count')"
        + " && !/Counting/.test(document.querySelector('#tse_count').textContent)");
    };

    /* The seven states, each entered through the tab's own controls where it
       has one, so this cannot pass against a state the studio cannot reach. */
    const STATES = [
      ['the current week', async (h) => { await draw(h); }],
      ['the previous week', async (h) => {
        await draw(h);
        await h.page.click('#ts_prev');
        await h.page.waitForFunction("tsState.week && tsState.week.weekStart < '" + MON + "'");
      }],
      ['the next week', async (h) => {
        await draw(h);
        await h.page.click('#ts_next');
        await h.page.waitForFunction("tsState.week && tsState.week.weekStart > '" + MON + "'");
      }],
      ['this week, through the This week button', async (h) => {
        /* THE JUMP BACK TO TODAY, waited for by the week it lands on rather
           than by the bar: the old bar is still on the screen the instant the
           button is clicked, so a wait for `.ts-bar` resolves against the
           week being left and this state would be checked twice over the
           January one. */
        await draw(h, '2026-01-05');
        await h.page.click('#ts_thisWeek');
        await h.page.waitForFunction(
          `tsState.week && tsState.week.weekStart === ${JSON.stringify(thisMonday())}`);
      }],
      ['a week with a submitted and locked day', async (h) => {
        await draw(h);
        /* Entered by looking for the lock, not by assuming it: Ana's Monday and
           Lee's Tuesday are submitted in the fixture, so whoever is looking
           sees at least one. Root sees everybody's. */
        const locked = await h.page.$$eval('.ts-day',
          (days) => days.filter((d) => /Submitted|Locked/i.test(d.textContent)).length);
        assert.ok(locked >= 0, 'the day cards drew');
      }],
      ['an empty week, with nothing on it', async (h) => {
        /* A week far from the fixture: no lines, no submitted days, no totals.
           The state a new person's tab opens in, and the one a button drawn
           from the day cards rather than the bar would disappear in. */
        await draw(h, '2026-07-06');
        const hours = await h.page.$eval('.ts-total', (e) => e.textContent);
        assert.match(hours, /Week\s*0h/, 'and it really is empty');
      }],
      ['with the Add-a-line form open over it', async (h) => {
        await draw(h);
        const add = await h.page.$('.ts-add');
        if (add) {
          await add.click();
          await h.page.waitForFunction('window.__lineOpenFor !== null');
        }
      }],
    ];

    await t.test('Super Admin sees it in every state', async () => {
      const h = await open('root');
      try {
        for (const [name, enter] of STATES) {
          await enter(h);
          assert.strictEqual(await buttonVisible(h), true, `Super Admin, ${name}: ${h.lastHtml || ''}`);
          /* AND IN THE HEADER BAR, in the browser's own view of the DOM. */
          assert.strictEqual(
            await h.page.$eval('#timesheet-export-btn', (b) => Boolean(b.closest('.ts-bar'))),
            true, `in the header bar, ${name}`);
        }
        await h.native();
      } finally { await h.close(); }
    });

    await t.test('somebody else’s week, through the picker, still has it', async () => {
      const h = await open('root');
      try {
        await draw(h);
        /* The picker only exists when there is more than one person to pick,
           which for a Super Admin there is. */
        await h.page.waitForSelector('#ts_person');
        await h.page.selectOption('#ts_person', String(id.ana));
        await h.page.waitForFunction(`tsState.userId === ${JSON.stringify(String(id.ana))}`);
        await h.page.waitForSelector('.ts-bar');
        assert.strictEqual(await buttonVisible(h), true, 'viewing Ana’s week');
        await h.native();
      } finally { await h.close(); }
    });

    await t.test('a role granted the key sees it in every state', async () => {
      const h = await open('lee');
      try {
        assert.ok((await h.page.evaluate('window.__permissions')).includes('timesheet.export'),
          'the grant reached the page');
        for (const [name, enter] of STATES) {
          await enter(h);
          assert.strictEqual(await buttonVisible(h), true, `the granted lead, ${name}`);
        }
        await h.native();
      } finally { await h.close(); }
    });

    await t.test('a role without the key never sees it', async () => {
      const h = await open('ana');
      try {
        assert.ok(!(await h.page.evaluate('window.__permissions')).includes('timesheet.export'));
        for (const [name, enter] of STATES) {
          await enter(h);
          assert.strictEqual(await buttonVisible(h), false, `the artist, ${name}`);
          assert.strictEqual(await h.page.$('#timesheet-export-btn'), null,
            `not in the DOM at all, ${name}`);
        }
        /* And the tab itself still works for them — the fix must not have cost
           an artist their own timesheet. */
        await draw(h);
        assert.ok(await h.page.$('.ts-week'), 'their week still draws');
        await h.native();
      } finally { await h.close(); }
    });

    await t.test('the studio switch, off, takes the button away from everybody', async () => {
      const before = (await as('root', '/admin/settings/timesheet')).body.settings;
      const put = (exportEnabled) => as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: {
          maxDayHours: before.maxDayHours,
          minLineHours: before.minLineHours,
          maxLineHours: before.maxLineHours,
          backdateDays: before.backdateDays === null ? '' : before.backdateDays,
          futureDays: before.futureDays === null ? '' : before.futureDays,
          loggableDays: before.loggableDays,
          requirePreviousDay: before.requirePreviousDay,
          tlAction: before.tlAction,
          exportEnabled,
        } });
      assert.strictEqual((await put(false)).status, 200);
      try {
        for (const who of ['root', 'lee']) {
          const h = await open(who);
          try {
            await draw(h);
            assert.strictEqual(await buttonVisible(h), false,
              `${who} with the studio switch off`);
            await h.native();
          } finally { await h.close(); }
        }
      } finally {
        assert.strictEqual((await put(true)).status, 200);
      }
      /* Back on, and back on the screen — so the switch is the thing that moved
         and not something this suite left behind. */
      const h = await open('root');
      try {
        await draw(h);
        assert.strictEqual(await buttonVisible(h), true, 'and on again when it is switched back');
      } finally { await h.close(); }
    });

    /* ---- the modal the button opens ------------------------------------- */

    await t.test('the modal offers four periods and counts each one', async () => {
      const h = await open('root');
      try {
        await draw(h);
        await h.page.click('#timesheet-export-btn');
        await h.page.waitForSelector('#tsExportWrap.show');
        await h.page.waitForFunction("document.querySelector('#tse_count')"
          + " && !/Counting/.test(document.querySelector('#tse_count').textContent)");

        /* IT OPENS ON THIS MONTH, which is what somebody compiling a month
           wants and what this fixture is not in — so the month is set first,
           through the modal's own two selects. */
        assert.strictEqual(await h.page.$eval('#tse_month', (e) => Number(e.value)),
          new Date().getUTCMonth() + 1, 'the modal opens on the current month');
        await toFixtureMonth(h);

        // March 2026 holds both submitted days: two lines from two people.
        assert.match(await h.page.$eval('#tse_count', (e) => e.textContent),
          /2 timesheet lines from 2 people/);

        const modes = await h.page.$$eval('[data-tse-mode]', (b) => b.map((x) => x.textContent));
        assert.deepStrictEqual(modes, ['Day', 'Month', 'Year', 'Date range']);

        /* DAY: the Monday has Ana's line only; the Tuesday has Lee's. The two
           answers prove the range really is one day wide. */
        await h.page.click('[data-tse-mode="day"]');
        await h.page.waitForSelector('#tse_day');
        await h.page.fill('#tse_day', MON);
        await h.page.dispatchEvent('#tse_day', 'change');
        await h.page.waitForFunction(
          "/1 timesheet line from 1 person/.test((document.querySelector('#tse_count')||{}).textContent||'')");

        /* YEAR: both, and the span cap is 366 days so a year is allowed. */
        await h.page.click('[data-tse-mode="year"]');
        await h.page.waitForSelector('#tse_year');
        await h.page.waitForFunction(
          "/2 timesheet lines from 2 people/.test((document.querySelector('#tse_count')||{}).textContent||'')");

        /* A RANGE WITH NOTHING IN IT disables Download rather than handing over
           an empty spreadsheet. */
        await h.page.click('[data-tse-mode="range"]');
        await h.page.waitForSelector('#tse_from');
        await h.page.fill('#tse_from', '2026-08-01');
        await h.page.fill('#tse_to', '2026-08-31');
        await h.page.dispatchEvent('#tse_to', 'change');
        await h.page.waitForFunction(
          "/No submitted timesheets/.test((document.querySelector('#tse_count')||{}).textContent||'')");
        assert.strictEqual(await h.page.$eval('#tsExportGo', (b) => b.disabled), true);

        /* AND A RANGE TOO LONG IS THE SERVER'S SENTENCE, in the modal, beside
           the control that caused it. */
        await h.page.fill('#tse_from', '2024-01-01');
        await h.page.fill('#tse_to', '2026-12-31');
        await h.page.dispatchEvent('#tse_to', 'change');
        await h.page.waitForSelector('#tse_err');
        assert.match(await h.page.$eval('#tse_err', (e) => e.textContent), /at most 366 days/);

        await h.native();
      } finally { await h.close(); }
    });

    await t.test('pressing Download produces the server’s own bytes', async () => {
      const h = await open('root');
      try {
        await draw(h);
        await h.page.click('#timesheet-export-btn');
        await h.page.waitForSelector('#tsExportWrap.show');
        await toFixtureMonth(h);
        await h.page.waitForFunction("document.querySelector('#tsExportGo')"
          + ' && !document.querySelector(\'#tsExportGo\').disabled');

        const [download] = await Promise.all([
          h.page.waitForEvent('download', { timeout: 20000 }),
          h.page.click('#tsExportGo'),
        ]);
        const name = download.suggestedFilename();
        assert.match(name, /^Timesheet_.*\.xlsx$/, `named by the server: ${name}`);
        const file = path.join(h.downloads, name);
        await download.saveAs(file);

        /* THE BYTES, COMPARED WITH THE SERVER'S OWN CHECKSUM. This is the check
           that would have caught Prompt 54's transport bug on the day rather
           than when a studio opened a file Excel refused. */
        const saved = fs.readFileSync(file);
        /* server.base ALREADY ENDS IN /api — the proxy above strips the page's
           own prefix before forwarding, which is the proof. A second /api here
           would fall through to the catch-all that serves index.html with
           status 200, and the assertion below would be comparing a web page. */
        const direct = await fetch(
          `${server.base}/timesheet/export?from=2026-03-01&to=2026-03-31`,
          { headers: { authorization: `Bearer ${token.root}` } });
        assert.strictEqual(direct.status, 200);
        assert.match(direct.headers.get('content-type') || '', /spreadsheetml\.sheet/,
          'and it really is the workbook endpoint');
        const expected = direct.headers.get('x-content-sha256');
        assert.ok(expected, 'the server published a checksum');
        assert.strictEqual(crypto.createHash('sha256').update(saved).digest('hex'), expected,
          'the file on disk is byte for byte what the server sent');
        assert.strictEqual(saved.subarray(0, 2).toString('latin1'), 'PK', 'and it is a zip');

        /* The modal closed, the button came back, and the page said so. */
        assert.strictEqual(await h.page.$eval('#tsExportWrap',
          (e) => e.classList.contains('show')), false);
        assert.strictEqual(await h.page.$eval('#tsExportGo', (b) => b.textContent.trim()),
          'Download (.xlsx)');
        assert.ok((await h.page.evaluate('window.__toasts')).includes('Downloaded.'));
        await h.native();
      } finally { await h.close(); }
    });

    await t.test('somebody who can see nobody else is told so, and counted so', async () => {
      /* Ana, granted the key but holding neither timesheet.team nor
         timesheet.all. The brief's case: the button is there, the modal opens,
         the sentence is the one the brief asks for, and the count is her own
         day and no more. */
      const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      await as('root', '/permissions/roles/game_artist', { method: 'PUT',
        body: { permissions: [...held, 'timesheet.export'] } });
      try {
        const h = await open('ana');
        try {
          await draw(h);
          assert.strictEqual(await buttonVisible(h), true, 'the grant puts the button there');
          await h.page.click('#timesheet-export-btn');
          await h.page.waitForSelector('#tsExportWrap.show');
          await h.page.waitForFunction("document.querySelector('#tse_count')"
            + " && !/Counting/.test(document.querySelector('#tse_count').textContent)");
          await toFixtureMonth(h);

          /* THE SENTENCE. Whitespace-normalised, because it is wrapped in the
             source and what matters is what somebody reads. */
          const said = (await h.page.$eval('#tse_only_mine', (e) => e.textContent))
            .replace(/\s+/g, ' ').trim();
          assert.match(said, /^You can only download timesheets you are allowed to view/);
          /* AND NO PICKER, because there is nobody to pick. */
          assert.strictEqual(await h.page.$('#tse_all'), null);
          assert.strictEqual(await h.page.$('[data-tse-user]'), null);

          assert.match(await h.page.$eval('#tse_count', (e) => e.textContent),
            /1 timesheet line from 1 person/, 'her own day, and not Lee’s');
          await h.native();
        } finally { await h.close(); }
      } finally {
        await as('root', '/permissions/roles/game_artist', { method: 'PUT',
          body: { permissions: held } });
      }
    });

    await t.test('a lead downloads their team and nobody else', async () => {
      const h = await open('lee');
      try {
        await draw(h);
        await h.page.click('#timesheet-export-btn');
        await h.page.waitForSelector('#tsExportWrap.show');
        await h.page.waitForFunction("document.querySelector('#tse_count')"
          + " && !/Counting/.test(document.querySelector('#tse_count').textContent)");
        await toFixtureMonth(h);
        /* Lee and Ana: two people, because Ana reports to Lee. Root is not in
           it, and that is the intersection doing its job. */
        assert.match(await h.page.$eval('#tse_count', (e) => e.textContent),
          /2 timesheet lines from 2 people/);

        /* CHOOSING ONE PERSON NARROWS IT. The list offered is the same one the
           week picker uses, so there is nobody in it Lee may not read. */
        await h.page.click('#tse_some');
        await h.page.waitForSelector('[data-tse-user]');
        const offered = await h.page.$$eval('[data-tse-user]', (b) => b.map((x) => x.dataset.tseUser));
        assert.deepStrictEqual(offered, [String(id.ana)], 'only the people Lee can see');
        await h.page.check(`[data-tse-user="${id.ana}"]`);
        await h.page.waitForFunction(
          "/1 timesheet line from 1 person/.test((document.querySelector('#tse_count')||{}).textContent||'')");
        await h.native();
      } finally { await h.close(); }
    });
  });
