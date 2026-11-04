/* THE EXACT-HOURS RULE IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE STATIC SUITE CANNOT.
 * tests/timesheet-hours-rule.test.js pins the arithmetic, the routes and the
 * shape of the page's source. It cannot tell you what somebody SEES, and this
 * feature is mostly a thing somebody sees: a sentence, a colour, and a button
 * that will not press. So this one runs the page's own code in Chromium against
 * the real server and reads the result off the screen:
 *
 *     the sentence and the style at SHORT, EXACT and OVER
 *     Submit disabled at short and at over, enabled only at exact, with the
 *       server's own sentence as its helper text AND its tooltip
 *     "Fill remaining" puts the exact remaining figure in the field, and the
 *       day it makes is the one that submits
 *     the Hours field's max follows the remaining time, and never goes negative
 *     editing a line gets its own hours back before the limit is applied
 *     a CALCULATED (locked) value over the remaining time shows the sentence
 *       and keeps Add line disabled, because nothing can be typed to fix it
 *     an exempt designation sees no bar and submits a short day
 *     A SECOND TAB that filled the day first makes the first tab's submit come
 *       back with the 422, shown IN THE PAGE, and the week refetched
 *     no native dialog anywhere
 *
 * REAL ON BOTH SIDES. The server is the application, booted against the test
 * database; every number the page draws came out of /api/timesheets/week on
 * this run. The page's code is LIFTED out of public/index.html rather than
 * retyped — the rule block, the submit button's own renderer, the Hours field's
 * helpers and the form markup — so this drives what ships. Only the surrounding
 * single-page application is stood in for, and /api is proxied with the acting
 * person's token because the page's api() sends none of its own.
 *
 * WHY "OVER" IS REACHABLE AT ALL. A line that would take a day over is refused,
 * so the only honest way to a day that is over is the one a studio can actually
 * produce: fill a day to eight hours, then LOWER the required figure. That is
 * what this suite does, and it is why the over case is worth drawing.
 *
 * NO NATIVE DIALOGS: alert, confirm and prompt throw here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { config, resetSchema, startServer, stopServer, api, openStudio,
  SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const rule = require('../src/timesheet-hours-rule');

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

const cfg = config('tshoursbrowser');
const BROWSER_SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);
const SKIP = cfg ? BROWSER_SKIP : SKIP_REASON;

const PASSWORD = 'HoursBrowser-1!';

/* FIXED DATES, never "today", for the reason the static suite gives: a calendar
   rule tested against the clock passes or fails by the hour it ran at.
   2026-10-07 is a Wednesday, -08 a Thursday, -09 a Friday. */
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';
/* The rule's start date, well before all three, so every day here is under it.
   Set explicitly rather than taking the stamp the switch leaves, because that
   stamp is today and today is not a fixed date. */
const FROM = '2026-01-01';

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

  /* THE RULE BLOCK, whole: tsHours, tsRuleLine, tsNothingOwed, tsSubmitHelp,
     TS_LEAVE_HINT and tsHoursRefusal. */
  const ruleBlock = cut('/* ---------- the exact-hours rule ---',
    '/* ---------- Time Sheet ----------', "the page's rule block");

  /* THE SUBMIT BUTTON'S OWN RENDERER, lifted out of the day card. It is an
     IIFE in the page, so the cut stops before the `})()` that closes it and the
     body is wrapped in a function of (day) here — the same parameter it reads
     there, under the same name. Retyping the button would make this fixture
     test a copy of the markup rather than the markup. */
  const submitBody = cut('const rule = day.hoursRule || null;', "          })() : ''}",
    "the submit button's renderer");

  /* THE HOURS FIELD'S HELPERS: tlRuleFor, tlRemainingCenti, tlSyncRemaining
     (the max, the sentence and Fill remaining) and tlSyncSaveState (Add line). */
  const fieldHelpers = cut('function tlRuleFor(day){', 'function tlLockHours(locked){',
    "the Hours field's helpers");

  /* AND THE FORM MARKUP THEY DRIVE, in two pieces because tl_suggest and the
     rest of the form sit between them and bring in helpers this fixture has
     no business standing in for. */
  const hoursField = cut('<label>Hours</label>', '<div id="tl_suggest"', 'the Hours field');
  const actions = cut('<div class="ref-err" id="tl_err"></div>', '<div id="tl_window"',
    "the form's error row and Add line");

  /* EVERY LIFTED SPAN MUST BE DISJOINT. Overlapping cuts duplicate a function
     declaration, and the page then dies on load with a redeclaration error that
     looks like a bug in the feature. (This is not hypothetical: an overlapping
     cut in a sibling suite silently killed ten of its tests.) */
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i][0] >= sorted[i - 1][1],
      `the lifted spans are disjoint: ${sorted[i - 1][2]} overlaps ${sorted[i][2]}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="toast"></div>
  <!-- Where the day card draws the rule's sentence and its button. -->
  <div id="host"></div>
  <!-- The add-line form, its real markup. -->
  <div id="form">
    ${hoursField}
    ${actions}
  </div>
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
function fmtDate(s){ return s ? String(s) : ''; }
const tsState = { date: null, userId: null, week: null, people: [], draft: null };
/* THE REFETCH tsHoursRefusal ASKS FOR, done for real against the server and
   recorded. The whole Time Sheet renderer is not what is under test — the
   refetch is, because a 422 here means this tab was out of date. */
window.__refetched = 0;
async function renderTimesheet(){
  window.__refetched += 1;
  const week = await api('/timesheets/week?date=' + (tsState.date || ''));
  tsState.week = week;
  drawHost();
  tlSyncRemaining();
}
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
${ruleBlock}
${fieldHelpers}
/* The submit button, drawn by the page's own code. */
function tsSubmitButton(day){
${submitBody}
}
/* A day card's two rule-bearing parts, which is all of the card this feature
   touches: the sentence above the lines, and the button below them. */
function drawHost(){
  const host = document.getElementById('host');
  const days = ((tsState.week && tsState.week.days) || [])
    .filter((d) => !tsState.only || d.date === tsState.only);
  host.innerHTML = days.map((day) =>
    '<div class="ts-day" data-day="' + day.date + '">'
    + tsRuleLine(day.hoursRule ? { ...day.hoursRule, day, date: day.date } : null)
    + tsSubmitButton(day)
    + '</div>').join('');
  for (const btn of host.querySelectorAll('.ts-submit-day')) {
    btn.addEventListener('click', async () => {
      try {
        await api('/timesheets/submit', { method: 'POST', body: { date: btn.dataset.day } });
        await renderTimesheet();
      } catch (e) {
        /* The page's own handler, on the page's own path: show it where the
           person is looking, then refetch. */
        if (await tsHoursRefusal(e, null)) return;
        showToast(e.message);
      }
    });
  }
}
/* Add line, on the page's own path: the save handler's two rule-aware steps. */
document.getElementById('tl_save').addEventListener('click', async () => {
  const draft = tsState.draft || {};
  document.getElementById('tl_err').textContent = '';
  try {
    await api('/timesheets/entries', { method: 'POST', body: {
      date: draft.day, hours: Number(document.getElementById('tl_hours').value),
      nonProject: 'leave' } });
    await renderTimesheet();
  } catch (e) {
    if (await tsHoursRefusal(e, 'tl_err')) { tlSyncRemaining(); return; }
    document.getElementById('tl_err').textContent = e.message;
  }
});
document.getElementById('tl_hours').addEventListener('input', () => tlSyncRemaining());
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness -------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

test('the exact-hours rule, in a browser', { skip: SKIP }, async (t) => {
  let server;
  let pageServer;
  let pageOrigin;
  const token = {};
  const people = {};
  const html = fixture();

  const call = (p, options) => api(server.base, p, options);
  const as = (who, p, options = {}) => call(p, { ...options, token: token[who] });
  const settings = (body) => as('root', '/admin/settings/timesheet', { method: 'PUT', body });
  const setRule = async (body) => {
    const res = await settings(body);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };
  const add = (who, date, hours) => as(who, '/timesheets/entries',
    { method: 'POST', body: { date, hours, nonProject: 'leave' } });
  const dayOf = async (who, date) => {
    const res = await as(who, `/timesheets/week?date=${date}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.days.find((d) => d.date === date);
  };
  /* Leave is a MARK on the day, not a line — which is the whole reason the
     requirement shrinks without anybody typing anything. */
  const mark = (who, date, kind, portion) => as('root', '/admin-dashboard/follow-up/day-status',
    { method: 'POST', body: { userId: people[who], date, kind, portion } });
  const unmark = (who, date) => as('root', '/admin-dashboard/follow-up/day-status/clear',
    { method: 'POST', body: { userId: people[who], date, reason: 'browser test' } });
  const clear = async (who, date) => {
    let day = await dayOf(who, date);
    if (day.locked) await as(who, '/timesheets/reopen', { method: 'POST', body: { date } });
    day = await dayOf(who, date);
    for (const e of day.entries) await as(who, `/timesheets/entries/${e.id}`, { method: 'DELETE' });
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'hours-browser-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'hours-browser-token', name: 'Root', email: 'root@hb.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@hb.test');
    await openStudio(server.base, token.root);

    const clientId = (await as('root', '/clients')).body.clients[0].id;
    const projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Hours Browser' } })).body.project.id;
    /* TWO ARTISTS, so the stale-tab test has one day with two tabs on it, and
       the exempt test has somebody who is NOT exempt to compare against.
       root is the Super Admin and holds timesheet.min_hours_exempt. */
    for (const who of ['ana', 'bo']) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@hb.test`, role: 'game_artist',
          password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@hb.test`);
    }
    /* A HUNDREDTH OF AN HOUR AS THE SMALLEST LINE, for the reason the static
       suite gives: the boundary this feature is about is one centihour wide, and
       the studio's default quarter-hour minimum would stop the suite expressing
       it. The rule's own start date is fixed rather than stamped. */
    await setRule({ loggableDays: [1, 2, 3, 4, 5], backdateDays: null, futureDays: null,
      minLineHours: 0.01, maxDayHours: 8, hoursRuleEnabled: true, hoursRuleFrom: FROM });

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
      /* The acting person is named by the context's own header, so two tabs can
         be two different people — or the same person twice, which is the
         stale-tab case. */
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

  /* Opens a tab signed in as `who`, looking at the week `date` falls in, with
     the day card narrowed to `only` so the assertions name one day. The week is
     fetched by the page itself, from the real route. */
  async function open(who, date, { only = null, draft = null } = {}) {
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
    await page.evaluate(async ({ on, which, d }) => {
      tsState.date = on;
      tsState.only = which;
      tsState.draft = d;
      await renderTimesheet();
      window.__refetched = 0;
    }, { on: date, which: only, d: draft });
    const clean = async () => {
      assert.deepStrictEqual(await page.evaluate('window.__native'), [],
        'nothing reached for a native dialog');
      assert.deepStrictEqual(errors, [], 'and the page threw nothing');
    };
    return { page, errors, clean, close: () => context.close() };
  }

  /* The sentence, the class and the bar's width, read off the screen. */
  const onScreen = (page) => page.evaluate(() => {
    const el = document.querySelector('.ts-rule');
    const fill = document.querySelector('.ts-rule-fill');
    const btn = document.querySelector('.ts-submit-day');
    const help = document.querySelector('.ts-submit-help');
    return {
      classes: el ? el.className : null,
      text: el ? (el.querySelector('.ts-rule-text') || el).textContent.trim() : null,
      width: fill ? fill.style.width : null,
      colour: el ? getComputedStyle(el.querySelector('.ts-rule-text') || el).color : null,
      barColour: fill ? getComputedStyle(fill).backgroundColor : null,
      disabled: btn ? btn.disabled : null,
      tooltip: btn ? btn.getAttribute('title') : null,
      describedBy: btn ? btn.getAttribute('aria-describedby') : null,
      helpId: help ? help.id : null,
      helpText: help ? help.textContent.trim() : null,
      tag: btn ? btn.tagName : null,
    };
  });

  /* ---- the three states, as somebody sees them ------------------------ */

  await t.test('short: the sentence, the bar and a Submit that will not press', async () => {
    await add('ana', WED, 6.5);
    const tab = await open('ana', WED, { only: WED });
    const seen = await onScreen(tab.page);

    assert.ok(seen.classes.includes('ts-rule'), 'the bar is drawn');
    assert.ok(seen.classes.includes('short'), `the short style: ${seen.classes}`);
    assert.strictEqual(seen.text, '6.5h of 8h logged, 1.5h to go');
    /* 650 of 800 is 81%, from the server's own two integers. */
    assert.strictEqual(seen.width, '81%');

    assert.strictEqual(seen.tag, 'BUTTON', 'a real button, in the tab order');
    assert.strictEqual(seen.disabled, true, 'and it is disabled, not hidden');
    /* THE SAME SENTENCE IN BOTH PLACES, and it is the SERVER'S: a tooltip is
       unreachable on a touchscreen and visible text is unreachable by a reader
       on the button alone, so the day needs both. */
    const verdict = (await dayOf('ana', WED)).hoursRule;
    assert.strictEqual(seen.tooltip, verdict.reason);
    assert.ok(seen.helpText.startsWith(verdict.reason), seen.helpText);
    assert.strictEqual(seen.describedBy, seen.helpId, 'the button points at it');
    /* AND THE ONE WAY OUT IT NAMES, which is not a button. */
    assert.ok(seen.helpText.includes('ask your admin to mark it'), seen.helpText);

    await tab.clean();
    await tab.close();
  });

  await t.test('exact: the success style, and Submit presses', async () => {
    await add('ana', WED, 1.5);
    const tab = await open('ana', WED, { only: WED });
    const seen = await onScreen(tab.page);

    assert.ok(seen.classes.includes('exact'), `the exact style: ${seen.classes}`);
    assert.strictEqual(seen.text, '8h of 8h, ready to submit');
    assert.strictEqual(seen.width, '100%');
    assert.strictEqual(seen.disabled, false, 'the button presses');
    assert.strictEqual(seen.tooltip, null, 'with nothing to explain');
    assert.strictEqual(seen.helpText, undefined === seen.helpText ? undefined : null);

    /* THE THREE STATES ARE TOLD APART BY COLOUR TOO, which is the only thing a
       person glancing at the page reads. Compared against the short state's
       colour rather than against a hex figure, because the figure is the
       studio's own and this suite must not pin a palette. */
    await add('ana', THU, 4);
    const other = await open('ana', THU, { only: THU });
    const short = await onScreen(other.page);
    assert.ok(short.classes.includes('short'));
    assert.notStrictEqual(seen.colour, short.colour, 'exact does not look like short');
    assert.notStrictEqual(seen.barColour, short.barColour);

    const press = await tab.page.evaluate(async () => {
      document.querySelector('.ts-submit-day').click();
      await new Promise((r) => setTimeout(r, 400));
      return { refetched: window.__refetched, toasts: window.__toasts };
    });
    assert.strictEqual(press.refetched, 1, 'and submitting refetched the week');
    assert.deepStrictEqual(press.toasts, [], 'with nothing to complain about');
    assert.strictEqual((await dayOf('ana', WED)).status, 'submitted');

    await tab.clean();
    await other.clean();
    await tab.close();
    await other.close();
  });

  await t.test('over: the warning style, and Submit will not press either', async () => {
    /* THE ONLY HONEST ROUTE TO AN OVER DAY. A line that would take a day over is
       refused, so this is what a studio would actually do to produce one: a day
       filled to eight, and then the figure lowered under it. */
    await clear('bo', FRI);
    await add('bo', FRI, 8);
    await setRule({ maxDayHours: 7 });
    try {
      const tab = await open('bo', FRI, { only: FRI });
      const seen = await onScreen(tab.page);
      assert.ok(seen.classes.includes('over'), `the over style: ${seen.classes}`);
      assert.strictEqual(seen.text, '8h of 7h, 1h over: edit or delete lines to submit');
      /* THE BAR IS CLAMPED. 800 of 700 is 114%, which would draw past its own
         track; the page floors and ceilings the percentage and says the rest in
         words. */
      assert.strictEqual(seen.width, '100%');
      assert.strictEqual(seen.disabled, true);
      /* AND NO LEAVE HINT HERE: being over is not something leave explains, and
         the sentence that fixes it is the one about editing lines. */
      assert.ok(!seen.helpText.includes('ask your admin'), seen.helpText);
      await tab.clean();
      await tab.close();
    } finally {
      await setRule({ maxDayHours: 8 });
    }
  });

  await t.test('a full day\'s leave draws a note instead of a bar', async () => {
    /* A DAY THE RULE SAYS NOTHING ABOUT. There is a note, because a day with no
       bar on it would otherwise just look broken — and crucially NO disabled
       Submit, because there is nothing to submit and a disabled button would
       read as a fault.

       FULL-DAY LEAVE rather than a weekly off: a weekend only appears in the
       week payload when something is already logged on it, and logging on one
       is itself refused while loggableDays is Mon-Fri. Leave is the case
       somebody actually meets. */
    await clear('ana', FRI);
    const marked = await mark('ana', FRI, 'leave', 'full');
    assert.strictEqual(marked.status, 200, JSON.stringify(marked.body));
    try {
      const tab = await open('ana', FRI, { only: FRI });
      const seen = await tab.page.evaluate(() => {
        const el = document.querySelector('.ts-rule');
        return { classes: el ? el.className : null, text: el ? el.textContent.trim() : null,
          bars: document.querySelectorAll('.ts-rule-bar').length,
          disabled: document.querySelector('.ts-submit-day').disabled };
      });
      assert.ok(seen.classes.includes('none'), `the quiet style: ${seen.classes}`);
      assert.match(seen.text, /: nothing to fill\.$/, seen.text);
      assert.strictEqual(seen.bars, 0, 'with no progress bar at all');
      assert.strictEqual(seen.disabled, false, 'and a button that still presses');
      /* THE SERVER AGREES IT IS THAT CASE and not one of the other four. */
      assert.strictEqual((await dayOf('ana', FRI)).hoursRule.inactiveBecause, 'nothing_owed');
      await tab.clean();
      await tab.close();
    } finally {
      await unmark('ana', FRI);
    }
  });

  await t.test('half a day\'s leave draws half the figure, and four hours submits',
    async () => {
      /* THE HALVING IS THE SERVER'S, and this is what it looks like: the bar
         asks for four, not eight, without the page knowing a half day exists. */
      await clear('ana', FRI);
      assert.strictEqual((await mark('ana', FRI, 'leave', 'second_half')).status, 200);
      try {
        await add('ana', FRI, 3.5);
        const tab = await open('ana', FRI, { only: FRI,
          draft: { day: FRI, ownCenti: 0 } });
        const seen = await onScreen(tab.page);
        assert.ok(seen.classes.includes('short'), seen.classes);
        assert.strictEqual(seen.text, '3.5h of 4h logged, 0.5h to go');
        assert.strictEqual(seen.disabled, true);
        /* AND THE FIELD'S CEILING IS HALF THE DAY'S REMAINDER TOO. */
        const max = await tab.page.evaluate(() => {
          tlSyncRemaining();
          return document.getElementById('tl_hours').max;
        });
        assert.strictEqual(max, '0.5');

        const after = await tab.page.evaluate(async () => {
          document.getElementById('tl_fill').click();
          const typed = document.getElementById('tl_hours').value;
          document.getElementById('tl_save').click();
          await new Promise((r) => setTimeout(r, 500));
          const el = document.querySelector('.ts-rule');
          return { typed, classes: el ? el.className : null,
            text: el.querySelector('.ts-rule-text').textContent.trim(),
            disabled: document.querySelector('.ts-submit-day').disabled };
        });
        assert.strictEqual(after.typed, '0.5');
        assert.ok(after.classes.includes('exact'), after.classes);
        assert.strictEqual(after.text, '4h of 4h, ready to submit');
        assert.strictEqual(after.disabled, false, 'four hours on a half day submits');
        await tab.clean();
        await tab.close();
      } finally {
        await clear('ana', FRI);
        await unmark('ana', FRI);
      }
    });

  /* ---- the Hours field ------------------------------------------------- */

  await t.test('the Hours field\'s max follows the remaining time', async () => {
    await clear('bo', THU);
    await add('bo', THU, 5.25);
    const tab = await open('bo', THU, { only: THU, draft: { day: THU, ownCenti: 0 } });
    const field = await tab.page.evaluate(() => {
      tlSyncRemaining();
      const f = document.getElementById('tl_hours');
      return { max: f.max, note: document.getElementById('tl_remaining').textContent.trim(),
        fill: Boolean(document.getElementById('tl_fill')) };
    });
    assert.strictEqual(field.max, '2.75', 'the field cannot be typed past the room left');
    assert.ok(field.note.startsWith('2.75h left today.'), field.note);
    assert.ok(field.fill, 'and Fill remaining is offered');
    await tab.clean();
    await tab.close();
  });

  await t.test('Fill remaining puts in the exact figure, and the day it makes submits',
    async () => {
      /* A FIGURE A DIVISION WOULD GET WRONG. 8 - 5.33 is 2.67 exactly in
         centihours (800 - 533 = 267) but 2.6700000000000004 as doubles, so a
         page that divided would type a value the server then refuses. */
      await clear('bo', THU);
      await add('bo', THU, 5.33);
      const tab = await open('bo', THU, { only: THU, draft: { day: THU, ownCenti: 0 } });
      const typed = await tab.page.evaluate(async () => {
        tlSyncRemaining();
        document.getElementById('tl_fill').click();
        return document.getElementById('tl_hours').value;
      });
      assert.strictEqual(typed, '2.67', 'the exact remaining figure, not a float');

      const after = await tab.page.evaluate(async () => {
        document.getElementById('tl_save').click();
        await new Promise((r) => setTimeout(r, 500));
        const el = document.querySelector('.ts-rule');
        return { err: document.getElementById('tl_err').textContent.trim(),
          classes: el ? el.className : null,
          disabled: document.querySelector('.ts-submit-day').disabled };
      });
      assert.strictEqual(after.err, '', 'the server took it');
      assert.ok(after.classes.includes('exact'), `and the day is exact: ${after.classes}`);
      assert.strictEqual(after.disabled, false, 'so Submit presses');
      assert.strictEqual((await dayOf('bo', THU)).hours, 8);
      await tab.clean();
      await tab.close();
    });

  await t.test('a full day has no room, and says so instead of offering to fill it',
    async () => {
      const tab = await open('bo', THU, { only: THU, draft: { day: THU, ownCenti: 0 } });
      const field = await tab.page.evaluate(() => {
        tlSyncRemaining();
        return { max: document.getElementById('tl_hours').max,
          note: document.getElementById('tl_remaining').textContent.trim(),
          fill: Boolean(document.getElementById('tl_fill')) };
      });
      assert.strictEqual(field.max, '0', 'never a negative max, which no browser can satisfy');
      assert.strictEqual(field.note,
        'This day already has all its hours. Edit or delete a line to make room.');
      assert.strictEqual(field.fill, false, 'and nothing to fill');
      await tab.clean();
      await tab.close();
    });

  await t.test('editing a line gets its own hours back before the limit', async () => {
    /* THE CASE THAT WOULD OTHERWISE BE ABSURD: a full day, and the line being
       corrected is itself three of those hours. Without `own` the form would
       offer no room to retype a line that is already in the total. */
    const day = await dayOf('bo', THU);
    const mine = day.entries[0];
    const tab = await open('bo', THU, { only: THU,
      draft: { day: THU, ownCenti: Math.round(Number(mine.hours) * 100) } });
    const field = await tab.page.evaluate(() => {
      tlSyncRemaining();
      return { max: document.getElementById('tl_hours').max,
        note: document.getElementById('tl_remaining').textContent.trim() };
    });
    assert.strictEqual(field.max, String(Number(mine.hours)),
      `a ${mine.hours}h line may be retyped up to its own ${mine.hours}h`);
    assert.ok(field.note.startsWith(`${Number(mine.hours)}h left today.`), field.note);
    await tab.clean();
    await tab.close();
  });

  await t.test('a locked calculated value over the room left says so and keeps Add shut',
    async () => {
      /* THE CASE THE BRIEF NAMES. The hours came from the clock and the field is
         readOnly, so nothing can be typed to make it fit — the button has to say
         why rather than fail on the press. */
      await clear('bo', FRI);
      await add('bo', FRI, 6.5);
      const tab = await open('bo', FRI, { only: FRI, draft: { day: FRI, ownCenti: 0 } });
      const seen = await tab.page.evaluate(() => {
        const f = document.getElementById('tl_hours');
        f.value = '3';
        f.readOnly = true;
        tlSyncRemaining();
        const btn = document.getElementById('tl_save');
        return { note: document.getElementById('tl_remaining').textContent.replace(/\s+/g, ' ').trim(),
          disabled: btn.disabled, tooltip: btn.title,
          fill: Boolean(document.getElementById('tl_fill')) };
      });
      assert.strictEqual(seen.note,
        'This line (3h) is more than the time left today (1.5h). Edit or delete other lines first.');
      assert.strictEqual(seen.disabled, true, 'Add line is shut');
      assert.strictEqual(seen.tooltip,
        'This line is more than the time left today (1.5h).');
      assert.strictEqual(seen.fill, false,
        'and Fill remaining is not offered on a value that cannot be changed');

      /* UNLOCK IT AND THE BUTTON COMES BACK, which proves the refusal is about
         the value being unchangeable and not about the day. */
      const freed = await tab.page.evaluate(() => {
        const f = document.getElementById('tl_hours');
        f.readOnly = false;
        tlSyncRemaining();
        return { disabled: document.getElementById('tl_save').disabled,
          fill: Boolean(document.getElementById('tl_fill')) };
      });
      assert.strictEqual(freed.disabled, false);
      assert.strictEqual(freed.fill, true);
      await tab.clean();
      await tab.close();
    });

  await t.test('a line the page let through is still refused by the server, in the page',
    async () => {
      /* THE FIELD'S max IS A COURTESY. A number input's max does not stop a
         value being set programmatically, and this is what a stale tab does. The
         refusal has to arrive as text in the form, not as a native dialog. */
      const tab = await open('bo', FRI, { only: FRI, draft: { day: FRI, ownCenti: 0 } });
      const out = await tab.page.evaluate(async () => {
        document.getElementById('tl_hours').value = '5';
        document.getElementById('tl_save').click();
        await new Promise((r) => setTimeout(r, 500));
        return { err: document.getElementById('tl_err').textContent.trim(),
          refetched: window.__refetched, toasts: window.__toasts };
      });
      assert.match(out.err, /1\.5h/, `the room left, in the form: ${out.err}`);
      assert.ok(out.refetched >= 1, 'and the week was refetched');
      assert.deepStrictEqual(out.toasts, [], 'nothing shouted at the person');
      assert.strictEqual((await dayOf('bo', FRI)).hours, 6.5, 'and no line was filed');
      await tab.clean();
      await tab.close();
    });

  /* ---- the exemption, and a stale tab ---------------------------------- */

  await t.test('an exempt designation sees no bar and submits a short day', async () => {
    /* root is the Super Admin, which holds timesheet.min_hours_exempt by
       default and is the only designation that does. */
    await clear('root', WED);
    await add('root', WED, 2);
    const tab = await open('root', WED, { only: WED });
    const seen = await tab.page.evaluate(() => {
      const el = document.querySelector('.ts-rule');
      return { bar: Boolean(el), disabled: document.querySelector('.ts-submit-day').disabled };
    });
    assert.strictEqual(seen.bar, false, 'nothing is drawn: there is nothing to explain');
    assert.strictEqual(seen.disabled, false);

    const press = await tab.page.evaluate(async () => {
      document.querySelector('.ts-submit-day').click();
      await new Promise((r) => setTimeout(r, 400));
      return { toasts: window.__toasts };
    });
    assert.deepStrictEqual(press.toasts, []);
    assert.strictEqual((await dayOf('root', WED)).status, 'submitted',
      'two hours, submitted, because the exemption is the one way round the rule');
    /* AND IT IS THE PERSON, NOT THE DAY: the same date for somebody without the
       key is still under the rule. */
    const theirs = (await dayOf('bo', WED)).hoursRule;
    assert.strictEqual(theirs.inactiveBecause, null);
    assert.strictEqual(theirs.applies, true);
    await tab.clean();
    await tab.close();
  });

  await t.test('a stale tab is told by the server, in the page, and catches up', async () => {
    /* TWO TABS, ONE PERSON, which is a laptop and a phone. The first tab reads a
       day at 8h and sees Submit enabled. The second tab deletes a line. The
       first tab's button is now wrong — nothing told it — and pressing it must
       produce the 422 as text and a refetched week, not a submitted day. */
    await clear('bo', WED);
    await add('bo', WED, 8);
    const stale = await open('bo', WED, { only: WED });
    assert.strictEqual(await stale.page.evaluate(
      () => document.querySelector('.ts-submit-day').disabled), false,
    'the stale tab sees a button it may press');

    const day = await dayOf('bo', WED);
    await as('bo', `/timesheets/entries/${day.entries[0].id}`, { method: 'DELETE' });
    await add('bo', WED, 3);

    const out = await stale.page.evaluate(async () => {
      document.querySelector('.ts-submit-day').click();
      await new Promise((r) => setTimeout(r, 600));
      const el = document.querySelector('.ts-rule');
      return { toasts: window.__toasts, refetched: window.__refetched,
        classes: el ? el.className : null,
        text: el ? el.querySelector('.ts-rule-text').textContent.trim() : null,
        disabled: document.querySelector('.ts-submit-day').disabled };
    });
    assert.strictEqual(out.toasts.length, 1, 'one message, in the page');
    /* THE SERVER'S OWN SENTENCE, which says what to do rather than restating
       the arithmetic — the bar underneath carries the figures, and after the
       refetch below it carries the right ones. */
    assert.strictEqual(out.toasts[0], 'Log 5h more to submit.');
    assert.strictEqual(out.toasts[0], (await dayOf('bo', WED)).hoursRule.reason,
      'and it is the reason the day itself reports');
    assert.strictEqual(out.refetched, 1, 'and the week was read again');
    /* THE TAB IS NOW CORRECT, which is the point of refetching rather than only
       complaining. */
    assert.ok(out.classes.includes('short'), out.classes);
    assert.strictEqual(out.text, '3h of 8h logged, 5h to go');
    assert.strictEqual(out.disabled, true);
    assert.strictEqual((await dayOf('bo', WED)).status, 'draft', 'and nothing was submitted');
    await stale.clean();
    await stale.close();
  });

  await t.test('every number on the screen came from the server\'s own module', async () => {
    /* THE WHOLE POINT, CHECKED ONCE AGAINST THE MODULE ITSELF: the sentence the
       page drew for a day is the same sentence the module's own formatter
       produces from the same integers. If the page ever formatted differently —
       a rounding, a stray decimal — the two would part. */
    await clear('ana', FRI);
    await add('ana', FRI, 3.33);
    const verdict = (await dayOf('ana', FRI)).hoursRule;
    const tab = await open('ana', FRI, { only: FRI });
    const seen = await onScreen(tab.page);
    assert.strictEqual(seen.text,
      `${rule.label(verdict.logged)} of ${rule.label(verdict.required)} logged, ${
        rule.label(verdict.remaining)} to go`);
    assert.strictEqual(seen.text, '3.33h of 8h logged, 4.67h to go');
    await tab.clean();
    await tab.close();
  });
});
