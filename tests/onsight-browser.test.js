/* THE FOUR BUTTONS, THE ONSIGHT MODAL AND VACATION MODE, IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT THE OTHER SUITE CANNOT: that the four controls fit
 * beside each other without overlapping at the three widths the studio uses,
 * and that the modal, the menu and the profile section actually work when
 * pressed rather than merely rendering.
 *
 * OVERLAP IS MEASURED, NOT EYEBALLED. Every button's bounding box is read from
 * the layout engine and compared with its neighbour's — which is the only way
 * to assert "no overlap" at all, and the reason Prompt 47's layout rule exists:
 * as nine siblings these badges could only be fitted by squeezing the name
 * until its text ran underneath them.
 *
 * NO NATIVE DIALOGS. The desktop web view has none (Prompt 39), so alert,
 * confirm and prompt throw here and any test that reaches one fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const SKIP = !chromium ? 'playwright-core is not installed — run `npm install`.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

const WIDTHS = [1280, 1440, 1920];

/* ---- the page under test, lifted out of the application ---------------- */

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

  /* THE REAL FUNCTIONS, lifted rather than retyped, so this drives what ships.
     fuRow and everything it calls, through to the Onsight modal. */
  const rowBlock = cut('function fuRow(r, heldLabel, d){', '/* ---------- the "waiting on them" panel ----------', 'the follow-up row');
  const vacBlock = cut('/* ---------- Vacation mode, in your own profile ----------', 'async function loadEmailPreference(){', 'Vacation mode');

  /* NO STUB MAY SHADOW SOMETHING THE LIFTED CODE DECLARES, and this is checked
   * here rather than discovered in a browser.
   *
   * It cost two runs to learn why: a `const` beside a `function` of the same
   * name in one script scope is a SyntaxError, so the whole <script> fails to
   * parse, window.__ready is never set, and every case in this file dies on a
   * thirty-second waitForFunction that says only "Timeout". The failure is as
   * far as it is possible to get from its cause.
   *
   * So the two lifted blocks are scanned for their top-level declarations and
   * compared with the fixture's own. A clash fails the suite immediately, by
   * name, before a browser is even launched. */
  const declaredIn = (block) => new Set(
    [...block.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const FIXTURE_DECLARES = ['escapeHTML', 'showToast', 'can', 'openAsk', 'api',
    'FOLLOW_UP', 'FOLLOW_UP_ASK', 'FU_MARKING', 'FU_MARK_MSG', 'FU_SENDING', 'FU_ROW_MSG',
    'FU_LEAVE_MENU', 'FU_OPEN', 'FU_REASSIGN', 'FU_PANEL', 'FU_PANEL_BUSY', 'FU_PANEL_ERR',
    'FU_PANEL_ALL', 'fuKey', 'fuDate'];
  for (const [label, block] of [['the follow-up row', rowBlock], ['Vacation mode', vacBlock]]) {
    const clash = FIXTURE_DECLARES.filter((n) => declaredIn(block).has(n));
    assert.deepStrictEqual(clash, [],
      `${label} already declares ${clash.join(', ')} \u2014 a stub beside it is a redeclaration, `
      + 'which kills the whole script. Delete the stub and let the real one run, or override it '
      + 'by assignment after the block.');
  }
  /* And the three overridden by assignment below must exist to be overridden. */
  for (const name of ['fuWaitingPanel', 'fuStreak', 'paintFollowUp']) {
    assert.ok(declaredIn(rowBlock).has(name), `${name} is declared in the lifted block`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;}#reportsView{padding:12px;}</style></head>
<body>
  <div id="toast"></div>
  <div id="followUpSlot"></div>
  <div id="pf_vac_section" hidden>
    <div id="pf_vac_banner" hidden></div>
    <div id="pf_vac_off" hidden></div>
    <div id="pf_vac_form">
      <input type="date" id="pf_vac_from"><input type="date" id="pf_vac_to">
      <select id="pf_vac_from_portion"><option value="full">All day</option><option value="second_half">From the afternoon</option></select>
      <select id="pf_vac_to_portion"><option value="full">All day</option><option value="first_half">Until lunch</option></select>
      <input type="text" id="pf_vac_note">
      <div id="pf_vac_rules"></div><div id="pf_vac_err"></div>
      <button id="pf_vac_save">Book vacation</button>
    </div>
    <div id="pf_vac_list"></div>
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
function showToast(msg){ window.__toasts.push(String(msg)); }
window.__permissions = [];
function can(){ for (let i = 0; i < arguments.length; i++) if (window.__permissions.includes(arguments[i])) return true; return false; }
window.__asked = [];
async function openAsk(o){ window.__asked.push(o); return window.__askAnswer === undefined ? true : window.__askAnswer; }
window.__posted = [];
async function api(p, opts = {}){
  window.__posted.push({ path: p, body: (opts && opts.body) || null, method: (opts && opts.method) || 'GET' });
  if (window.__apiThrow) throw new Error(window.__apiThrow);
  return (window.__apiAnswers && window.__apiAnswers[p]) || {};
}
/* THE STATE THE LIFTED CODE READS, and NOTHING THE LIFTED CODE ALREADY
   DECLARES. That distinction cost a run: stubbing fuShownDate, paintFollowUp,
   fuFindRow and six others alongside a block that declares them is a
   redeclaration, which is a SyntaxError that kills the whole <script> — so
   window.__ready was never set and every case failed on a 30-second
   waitForFunction with no hint as to why. The real versions are used instead,
   which is better anyway: fewer stubs is more of the application under test. */
let FOLLOW_UP = null;
let FOLLOW_UP_ASK = null;
const FU_MARKING = new Set();
const FU_MARK_MSG = new Map();
/* Declared OUTSIDE the lifted block in the page, so they have to be here:
   fuRemind() reads both, and a ReferenceError inside the draw is a page error
   rather than a failed assertion. */
const FU_SENDING = new Set();
const FU_ROW_MSG = new Map();
let FU_LEAVE_MENU = null;
let FU_OPEN = null;
let FU_REASSIGN = null;
let FU_PANEL = null, FU_PANEL_BUSY = false, FU_PANEL_ERR = null, FU_PANEL_ALL = false;
const fuKey = (k, id) => k + '|' + id;
const fuDate = (d) => String(d || '');
${rowBlock}
${vacBlock}
/* THE FEW OVERRIDES, BY ASSIGNMENT RATHER THAN DECLARATION — which is legal
   where a redeclaration is not. Only the three that would pull in the whole
   dashboard payload: the waiting panel, the streak marker and the repaint. */
fuWaitingPanel = () => '';
fuStreak = () => '';
paintFollowUp = () => window.__draw();
window.__draw = () => {
  const d = FOLLOW_UP;
  const slot = document.getElementById('followUpSlot');
  slot.innerHTML = (d.notStarted.rows || []).map(r => fuRow(r, d.heldLabel, d)).join('') + fuOnsightModal();
  slot.querySelectorAll('[data-fu-onsight]').forEach(b => b.onclick = () => openOnsight(b.dataset.fuOnsight));
  slot.querySelectorAll('[data-fu-leave]').forEach(b => b.onclick = () => {
    FU_LEAVE_MENU = FU_LEAVE_MENU === b.dataset.fuLeave ? null : b.dataset.fuLeave;
    window.__draw();
  });
  document.querySelectorAll('[data-fu-os-cancel]').forEach(b => b.onclick = () => { FU_ONSIGHT = null; window.__draw(); });
  document.querySelectorAll('[data-fu-os-save]').forEach(b => b.onclick = () => saveOnsight());
  /* THE SPAN LINE, wired exactly as wireFollowUp() wires it in the page — the
     listener goes on after each paint because the field only exists while the
     modal is open. Omitting it here cost a run: the test read the default
     sentence and reported a product failure. */
  const until = document.getElementById('fu_os_until');
  if(until) until.addEventListener('change', ()=>{
    const span = document.getElementById('fu_os_span');
    const dd = FOLLOW_UP && FOLLOW_UP.leave;
    const start = fuShownDate() || (dd && dd.date);
    if(!span || !start) return;
    if(!until.value || until.value === start){ span.textContent = 'Weekends and holidays are skipped.'; return; }
    const days = Math.round((Date.parse(until.value + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z'))/86400000) + 1;
    span.textContent = days > 0
      ? days + ' calendar days. Weekends and holidays are skipped, so fewer rows than that.'
      : 'The last day is before the first.';
  });
};
/* And the profile's Save, bound once as the page binds it beside
   profileModalWrap — which is outside both lifted blocks. */
(() => {
  const save = document.getElementById('pf_vac_save');
  if(save) save.addEventListener('click', ()=>{ saveVacation(); });
  const vfrom = document.getElementById('pf_vac_from');
  const vto = document.getElementById('pf_vac_to');
  if(vfrom && vto) vfrom.addEventListener('change', ()=>{
    vto.min = vfrom.value || vto.min;
    if(vto.value && vto.value < vfrom.value) vto.value = vfrom.value;
  });
})();
window.__ready = true;
</script>
</body></html>`;
}

/* ---- the harness ------------------------------------------------------- */

let browser = null;
test.after(async () => { if (browser) await browser.close(); browser = null; });

const ROW = (over = {}) => ({
  id: 'u-ana', name: 'Ana Artist', roleLabel: 'Game Artist', held: 0,
  missed: 1, expandable: false, both: false, activity: null, dayStatus: null,
  /* THE REAL fuRemind() DRAWS THIS, so the shape is the server's rather than a
     stub's — which is the point of lifting the code at all. */
  remind: { kind: 'start', permitted: true, may: true, last: null, auto: null }, ...over,
});

const DATA = (over = {}) => ({
  heldLabel: 'waiting on them',
  notStarted: { rows: [ROW()], total: 1, more: 0 },
  notFilled: { rows: [], total: 0, more: 0 },
  leave: {
    enabled: true, today: true, date: '2026-11-02', rows: [],
    onLeave: 0, onVacation: 0, idle: 0, onsight: 0,
    firstHalfEnd: '13:00', secondHalfStart: '14:00',
    actionableStatuses: ['not_started', 'in_progress'],
    clients: [{ id: 'c-1', name: 'Acme Pictures' }, { id: 'c-2', name: 'Zed Studio' }],
  },
  ...over,
});

test('the four buttons, the Onsight modal and Vacation mode in a browser', { skip: SKIP }, async (t) => {
  const html = fixture();
  let page;

  t.before(async () => {
    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  });

  const open = async (width, { permissions, data }) => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent(html);
    await page.waitForFunction('window.__ready === true');
    await page.evaluate(([perms, d]) => {
      window.__permissions = perms;
      // eslint-disable-next-line no-undef
      FOLLOW_UP = d;
      window.__draw();
    }, [permissions, data]);
    assert.deepStrictEqual(errors, [], 'no page errors');
    return page;
  };

  await t.test('all four controls fit beside each other at 1280, 1440 and 1920', async () => {
    const perms = ['followup.mark_leave', 'followup.mark_idle', 'followup.mark_onsight', 'report.remind'];
    for (const width of WIDTHS) {
      const p = await open(width, { permissions: perms, data: DATA() });
      const boxes = await p.evaluate(() => {
        const sels = ['[data-fu-remind]', '[data-fu-idle]', '[data-fu-leave]', '[data-fu-onsight]'];
        return sels.map((s) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { s, x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent.trim() };
        });
      });
      for (const b of boxes) assert.ok(b, `${width}: every control is drawn — ${JSON.stringify(boxes)}`);
      for (const b of boxes) {
        assert.ok(b.w > 8 && b.h > 8, `${width}: ${b.s} has a real size (${b.w}×${b.h})`);
      }
      /* NO OVERLAP, measured pairwise. Rectangles that intersect at all fail,
         which is stricter than "the text is readable" and is the property the
         layout rule actually promises. */
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          assert.ok(!hit, `${width}: ${a.s} and ${b.s} overlap — ${JSON.stringify([a, b])}`);
        }
      }
      // And they are in the brief's order, left to right.
      const order = [...boxes].sort((a, b) => a.x - b.x).map((b) => b.text.replace(/[▸▾]/g, '').trim());
      assert.deepStrictEqual(order, ['Remind', 'Idle', 'Leave', 'Onsight'], `${width}: the order`);
    }
  });

  await t.test('the marked and reminded states keep the row tidy', async () => {
    const perms = ['followup.mark_leave', 'followup.mark_idle', 'followup.mark_onsight', 'report.remind'];
    /* MARKED: one Undo and no marking buttons, because the row has one state —
       offering "First Half" beside an existing mark would be offering to
       replace it without saying so. */
    const marked = DATA({
      notStarted: { rows: [ROW({ dayStatus: { kind: 'onsight', chip: 'Onsight: Acme Pictures', label: 'Onsight — Acme Pictures' } })], total: 1, more: 0 },
    });
    const p = await open(1280, { permissions: perms, data: marked });
    assert.strictEqual(await p.locator('[data-fu-onsight]').count(), 0, 'no Onsight beside a mark');
    assert.strictEqual(await p.locator('[data-fu-leave]').count(), 0, 'no Leave beside a mark');
    assert.strictEqual(await p.locator('[data-fu-undo]').count(), 1, 'one Undo');
    assert.match(await p.locator('.fu-mark').first().innerText(), /Onsight: Acme Pictures/);

    /* And the chip the server sent is printed, not rebuilt: a vacation reads
       "Vacation", not "Leave". */
    const vac = DATA({
      notStarted: { rows: [ROW({ dayStatus: { kind: 'leave', portion: 'full', planned: true, chip: 'Vacation: full day' } })], total: 1, more: 0 },
    });
    const p2 = await open(1280, { permissions: perms, data: vac });
    assert.match(await p2.locator('.fu-mark').first().innerText(), /Vacation: full day/);
  });

  await t.test('the Leave menu offers three portions with the configured times', async () => {
    const p = await open(1280, { permissions: ['followup.mark_leave'], data: DATA() });
    await p.click('[data-fu-leave]');
    const items = await p.locator('.fu-leave-item').allInnerTexts();
    assert.strictEqual(items.length, 3, JSON.stringify(items));
    assert.match(items[0], /First Half/);
    assert.match(items[0], /until 13:00/);
    assert.match(items[1], /Second Half/);
    assert.match(items[1], /from 14:00/);
    assert.match(items[2], /Full Day/);
    assert.deepStrictEqual(await p.evaluate(() => window.__native), [], 'no native dialog was reached');
  });

  await t.test('the Onsight modal takes a client, a note and an Until, and posts them', async () => {
    const p = await open(1280, { permissions: ['followup.mark_onsight'], data: DATA() });
    await p.click('[data-fu-onsight]');
    await p.waitForSelector('#fuOnsightWrap');

    // The client picker is filled from the payload, with "not recorded" first.
    const options = await p.locator('#fu_os_client option').allInnerTexts();
    assert.strictEqual(options.length, 3, JSON.stringify(options));
    assert.match(options[0], /not recorded/);
    assert.match(options[1], /Acme Pictures/);

    // Until defaults to the day in view and cannot be set before it.
    assert.strictEqual(await p.inputValue('#fu_os_until'), '2026-11-02');
    assert.strictEqual(await p.getAttribute('#fu_os_until', 'min'), '2026-11-02');

    await p.selectOption('#fu_os_client', 'c-1');
    await p.fill('#fu_os_until', '2026-11-13');
    await p.fill('#fu_os_note', 'At Acme for the shoot');
    /* The calendar span is said as the date moves, and labelled as a span so
       nobody reads it as the number of rows. */
    assert.match(await p.locator('#fu_os_span').innerText(), /12 calendar days/);
    assert.match(await p.locator('#fu_os_span').innerText(), /Weekends and holidays are skipped/);

    await p.evaluate(() => { window.__apiAnswers = { '/admin-dashboard/follow-up/day-status': { days: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], status: {} } }; });
    await p.click('[data-fu-os-save]');
    await p.waitForFunction('window.__posted.length > 0');
    const posted = (await p.evaluate(() => window.__posted)).pop();
    assert.strictEqual(posted.path, '/admin-dashboard/follow-up/day-status');
    assert.strictEqual(posted.method, 'POST');
    assert.deepStrictEqual(posted.body, {
      userId: 'u-ana', kind: 'onsight', date: '2026-11-02',
      clientId: 'c-1', until: '2026-11-13', note: 'At Acme for the shoot',
    });
    // The count in the confirmation is the SERVER'S, not a weekday calculation.
    assert.match((await p.evaluate(() => [...FU_MARK_MSG.values()]))[0].text, /8 working days/);
    assert.deepStrictEqual(await p.evaluate(() => window.__native), []);
  });

  await t.test('Cancel closes the Onsight modal and posts nothing', async () => {
    const p = await open(1280, { permissions: ['followup.mark_onsight'], data: DATA() });
    await p.click('[data-fu-onsight]');
    await p.waitForSelector('#fuOnsightWrap');
    await p.click('[data-fu-os-cancel]');
    assert.strictEqual(await p.locator('#fuOnsightWrap').count(), 0);
    assert.deepStrictEqual(await p.evaluate(() => window.__posted), []);
  });

  await t.test('without the key there is no Onsight button at all', async () => {
    const p = await open(1280, { permissions: ['followup.mark_idle'], data: DATA() });
    assert.strictEqual(await p.locator('[data-fu-onsight]').count(), 0);
    assert.strictEqual(await p.locator('[data-fu-idle]').count(), 1);
    assert.strictEqual(await p.locator('[data-fu-leave]').count(), 0);
  });

  // ---- Vacation mode, in the profile ------------------------------------

  const VAC_RULES = {
    enabled: true, leaveEnabled: true, approvalRequired: false,
    minNoticeDays: 1, maxRangeDays: 60, earliest: '2026-11-03', today: '2026-11-02',
    firstHalfEnd: '13:00', secondHalfStart: '14:00',
  };

  const openProfile = async (answer) => {
    const p = await open(1280, { permissions: ['leave.request'], data: DATA() });
    await p.evaluate((a) => {
      window.__apiAnswers = { '/leave/mine': a };
      window.__permissions = ['leave.request'];
    }, answer);
    await p.evaluate(() => loadVacations());
    await p.waitForFunction('document.getElementById("pf_vac_section").hidden === false');
    return p;
  };

  await t.test('a person sees the rules, books a vacation, and the form posts what they chose', async () => {
    const p = await openProfile({ rules: VAC_RULES, vacations: [] });
    const rules = await p.locator('#pf_vac_rules').innerText();
    assert.match(rules, /Earliest: 3 Nov/);
    assert.match(rules, /Longest: 60 days/);
    assert.match(rules, /Takes effect straight away/);
    assert.match(rules, /Half days split at 13:00 \/ 14:00/);
    // THE EARLIEST DATE IS THE SERVER'S, and it is the input's own floor.
    assert.strictEqual(await p.getAttribute('#pf_vac_from', 'min'), '2026-11-03');
    assert.strictEqual(await p.inputValue('#pf_vac_from'), '2026-11-03');
    assert.match(await p.locator('#pf_vac_list').innerText(), /None booked/);

    await p.fill('#pf_vac_from', '2026-11-09');
    await p.fill('#pf_vac_to', '2026-11-13');
    await p.selectOption('#pf_vac_to_portion', 'first_half');
    await p.fill('#pf_vac_note', 'Diwali');
    await p.evaluate(() => { window.__posted = []; window.__apiAnswers['/leave/mine'] = { days: ['a', 'b', 'c', 'd'], request: {}, approvalNeeded: false, rules: {}, vacations: [] }; });
    await p.click('#pf_vac_save');
    await p.waitForFunction('window.__posted.length > 0');
    const posted = (await p.evaluate(() => window.__posted))[0];
    assert.deepStrictEqual(posted.body, {
      from: '2026-11-09', to: '2026-11-13',
      fromPortion: 'full', toPortion: 'first_half', note: 'Diwali',
    });
    assert.match((await p.evaluate(() => window.__toasts)).join(' '), /4 working days/);
  });

  await t.test('an active vacation shows the banner, and End early says what it will not touch', async () => {
    const p = await openProfile({
      rules: VAC_RULES,
      vacations: [{
        id: 'v-1', label: 'Vacation 2026-10-30 to 2026-11-06', status: 'approved',
        from: '2026-10-30', to: '2026-11-06', phase: 'active', active: true, note: 'Away',
      }],
    });
    assert.strictEqual(await p.locator('#pf_vac_banner').isVisible(), true);
    assert.match(await p.locator('#pf_vac_banner').innerText(), /You’re on vacation until 6 Nov/);
    assert.match(await p.locator('.pf-vac-state').innerText(), /On vacation now/);

    await p.evaluate(() => { window.__asked = []; window.__posted = []; });
    await p.click('[data-vac-end]');
    await p.waitForFunction('window.__asked.length > 0');
    const asked = (await p.evaluate(() => window.__asked))[0];
    assert.match(asked.title, /End this vacation early/);
    assert.match(asked.message, /from tomorrow onward/);
    assert.match(asked.message, /Today stays as it is/);
    assert.deepStrictEqual(await p.evaluate(() => window.__native), [], 'and it is never a native confirm');
  });

  await t.test('an upcoming vacation offers Cancel, which clears every day', async () => {
    const p = await openProfile({
      rules: VAC_RULES,
      vacations: [{
        id: 'v-2', label: 'Vacation 2026-12-01 to 2026-12-04', status: 'approved',
        from: '2026-12-01', to: '2026-12-04', phase: 'upcoming', active: false,
      }],
    });
    assert.strictEqual(await p.locator('#pf_vac_banner').isVisible(), false);
    assert.match(await p.locator('.pf-vac-state').innerText(), /Upcoming/);
    await p.evaluate(() => { window.__asked = []; });
    await p.click('[data-vac-cancel]');
    await p.waitForFunction('window.__asked.length > 0');
    const asked = (await p.evaluate(() => window.__asked))[0];
    assert.match(asked.title, /Cancel this vacation/);
    assert.match(asked.message, /Every day of it/);
  });

  await t.test('switched off, the form goes and the list stays', async () => {
    const p = await openProfile({
      rules: { ...VAC_RULES, enabled: false },
      vacations: [{
        id: 'v-3', label: 'Vacation 2026-12-01 to 2026-12-04', status: 'approved',
        from: '2026-12-01', to: '2026-12-04', phase: 'upcoming', active: false,
      }],
    });
    assert.strictEqual(await p.locator('#pf_vac_form').isVisible(), false, 'no new bookings');
    assert.strictEqual(await p.locator('#pf_vac_off').isVisible(), true);
    assert.match(await p.locator('#pf_vac_off').innerText(), /switched off in Settings/);
    assert.match(await p.locator('#pf_vac_off').innerText(), /still cancel an upcoming one/);
    /* AND THE CANCEL IS STILL THERE, or a vacation already booked would be one
       nobody could undo. */
    assert.strictEqual(await p.locator('[data-vac-cancel]').count(), 1);

    // Leave itself off reads differently, and says which switch.
    const p2 = await openProfile({ rules: { ...VAC_RULES, enabled: false, leaveEnabled: false }, vacations: [] });
    assert.match(await p2.locator('#pf_vac_off').innerText(), /Leave, Idle & Onsight is switched off/);
  });

  await t.test('without leave.request the section is not drawn at all', async () => {
    const p = await open(1280, { permissions: [], data: DATA() });
    await p.evaluate(() => { window.__apiAnswers = { '/leave/mine': { rules: {}, vacations: [] } }; window.__posted = []; });
    await p.evaluate(() => loadVacations());
    assert.strictEqual(await p.locator('#pf_vac_section').isVisible(), false);
    assert.deepStrictEqual(await p.evaluate(() => window.__posted), [],
      'and nothing is even asked for — offering a control the server would refuse is worse than none');
  });
});
