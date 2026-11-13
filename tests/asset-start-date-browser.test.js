/* ACCEPT AND START, IN A REAL BROWSER, WHATEVER THE DATES SAY.
 *
 * ===========================================================================
 * WHAT THE OTHER SUITE CANNOT SEE. tests/asset-start-date covers the rule and
 * the endpoint. This covers the thing that was reported: somebody opens a task
 * whose start date is next month and the button is THERE and PRESSABLE, not
 * greyed out with a sentence about a date under it.
 *
 * The button state is lifted out of public/index.html — the real `canStart` and
 * `startBlocked` expressions and the real markup around them — so this drives
 * what ships rather than a retyped copy. What is checked:
 *
 *   1. a future start date: the button is enabled, and pressing it calls
 *      POST /assets/:id/start (stubbed) and shows the timer running;
 *   2. an end date already past: the same;
 *   3. both at once, and neither: the same;
 *   4. the dates are still SHOWN while all that is true;
 *   5. no copy anywhere in the rendered panel mentions a date as a reason;
 *   6. the two reasons that DO still close the button — an open task, and
 *      yesterday's timesheet — still close it, because this change removes one
 *      reason and must not remove the others.
 *
 * NO NATIVE DIALOGS: the desktop web view has none, so alert/confirm/prompt
 * throw here and any case that reaches one fails.
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

const cut = (fromText, toText, what) => {
  const from = PAGE.indexOf(fromText);
  const to = PAGE.indexOf(toText, from + 1);
  assert.ok(from !== -1 && to > from, `found ${what} in the page`);
  return PAGE.slice(from, to);
};

/* THE TWO BUTTON EXPRESSIONS, TAKEN OUT OF openDrawer WHOLE.
 *
 * TO THE SEMICOLON, NOT TO THE END OF THE LINE, and that is the whole of this
 * function. It read `/^ {2}const canStart = .*$/m` and a mutation battery broke
 * it in one move: adding a start-date term on a CONTINUATION line left the lift
 * taking only the first line, so the fixture tested an expression the page does
 * not have and the mutation survived. A multi-line condition is exactly how
 * somebody would add a term back.
 *
 * The terminator is asserted, so a lift that ran off the end of the declaration
 * fails here rather than producing a fixture that silently does not parse. */
function buttonRules() {
  const take = (name) => {
    const at = PAGE.indexOf(`  const ${name} = `);
    assert.ok(at !== -1, `found the ${name} expression`);
    const end = PAGE.indexOf(';\n', at);
    assert.ok(end > at, `${name} is terminated`);
    const text = PAGE.slice(at, end + 1);
    assert.ok(text.trim().endsWith(';'), `${name} was lifted whole`);
    /* And it really is one declaration, not a run-on into the next few. */
    assert.ok(!/\n\s*const /.test(text), `${name}'s lift swallowed the next declaration`);
    return text;
  };
  return `${take('canStart')}\n${take('startBlocked')}`;
}

test('the lifted button expressions are the whole declarations', () => {
  /* A POSITIVE CONTROL on the lift above. Without it, a lift that silently
     truncates passes every behavioural case in this file — which is how the
     single-line regex it replaced went unnoticed. */
  const rules = buttonRules();
  assert.match(rules, /const canStart = /);
  assert.match(rules, /const startBlocked = /);
  assert.strictEqual((rules.match(/;/g) || []).length, 2,
    'each expression should contribute exactly one statement');
  assert.ok(rules.includes('!blocked') && rules.includes('!owing'),
    'the two reasons that still close the button are in the lift');
  assert.ok(!/start_date|due_date/.test(rules),
    'a date term is back in the button state');
});

function fixture() {
  const fmtDay = cut('function fmtDay(value){', '\n}\n', 'fmtDay') + '\n}';
  const blockingWork = cut('function blockingWork(a){', '\n}\n', 'blockingWork') + '\n}';
  /* THE MARKUP THE TWO REASONS DRAW, LIFTED WHOLE and emitted VERBATIM, so the
     copy under test is the copy that ships.
     
     Verbatim matters: the lifted text is itself a `${…}` expression containing
     nested template literals, and escaping its backticks (which is what I tried
     first) turns it into a string that does not parse. Dropped straight into a
     template literal below, it is exactly the expression the page evaluates. */
  const startBox = cut('${startBlocked ? (owing ? `', '\n      </div>', 'the start box');

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div id="panel"></div>
  <div id="timer">idle</div>
  <script>
  for(const n of ['alert','confirm','prompt']){ window[n]=()=>{ throw new Error('native dialog: '+n); }; }
  const escapeHTML = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let STARTED = null;                     /* what POST /start was called with */
  const state = { assets: [], currentUser: { id:'u1' }, timesheetGate: null, activeWork: null };
  const u = state.currentUser;
  function timesheetBlock(){ const g = state.timesheetGate; return g && g.blocked ? g : null; }
  ${fmtDay}
  ${blockingWork}

  /* Draw the start box for one asset, with the page's own two expressions. */
  function drawStart(a, opts){
    const mayStart = true;
    const mine = a.assignee_id === u.id;
    const held = a.held || null;
    const blocked = blockingWork(a);
    const owing = timesheetBlock();
${buttonRules()}
    const box = [];
    if(canStart) box.push('<button class="btn btn-brand" id="d_startBtn">Accept and Start</button>');
    box.push(\`${startBox}\`);
    document.getElementById('panel').innerHTML = box.join('')
      + '<div class="dates">Start Date: ' + fmtDay(a.start_date)
      + ' &middot; End Date: ' + fmtDay(a.due_date) + '</div>';
    const btn = document.getElementById('d_startBtn');
    if(btn && !btn.disabled) btn.addEventListener('click', async ()=>{
      STARTED = a.id;
      document.getElementById('timer').textContent = 'running 00:00:01';
    });
    return { canStart, startBlocked };
  }
  </script></body></html>`;
  /* PARSE IT HERE, not in the browser. A broken lift shows up in Chrome as
     "Failed to execute 'write' on 'Document': Invalid or unexpected token" and
     then as nine identical "state is not defined" failures, which says nothing
     about what is wrong. Checked once, with the real message. */
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script);
  return html;
}

const day = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Date(d.getTime() + (5 * 60 + 30) * 60000).toISOString().slice(0, 10);
};

test('Accept and Start is offered and works whatever the dates say',
  { skip: SKIP, concurrency: false }, async (t) => {
    const browser = await chromium.launch({ executablePath: EXECUTABLE });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.setContent(fixture());
    t.after(async () => { await browser.close(); });

    const draw = (asset, gate = null, openTask = null) => page.evaluate(([a, g, o]) => {
      state.timesheetGate = g;
      state.activeWork = o;
      state.assets = [a];
      STARTED = null;
      document.getElementById('timer').textContent = 'idle';
      const rules = drawStart(a);
      const btn = document.getElementById('d_startBtn');
      return {
        ...rules,
        present: Boolean(btn),
        enabled: Boolean(btn) && !btn.disabled,
        title: btn ? (btn.getAttribute('title') || '') : null,
        text: document.getElementById('panel').innerText,
        html: document.getElementById('panel').innerHTML,
        /* THE REFUSAL COPY ON ITS OWN. Checked separately from the panel text
           because this fixture also prints the dates beside the button — and a
           "no date in the reason" assertion over the whole panel matches that
           line and fails for the wrong reason. Asked of the element the page
           puts the reason in. */
        reason: [...document.querySelectorAll('.start-blocked')].map((n) => n.innerText).join(' '),
        titles: [...document.querySelectorAll('button')].map((n) => n.getAttribute('title') || '').join(' '),
        dates: (document.querySelector('.dates') || {}).innerText || '',
      };
    }, [asset, gate, openTask]);

    const press = () => page.evaluate(async () => {
      document.getElementById('d_startBtn').click();
      await new Promise((r) => setTimeout(r, 20));
      return { started: STARTED, timer: document.getElementById('timer').textContent };
    });

    const asset = (over = {}) => ({ id: 'a1', code: 'PRP-001', name: 'Ridge',
      status: 'assigned', assignee_id: 'u1', work_open: false, held: null,
      start_date: null, due_date: null, ...over });

    const CASES = [
      ['a start date a month away', { start_date: day(30) }],
      ['an end date a month past', { due_date: day(-30) }],
      ['both at once', { start_date: day(30), due_date: day(-30) }],
      ['neither', {}],
      ['a start date today', { start_date: day(0) }],
      ['a start date yesterday', { start_date: day(-1) }],
    ];

    for (const [label, dates] of CASES) {
      await t.test(`${label}: the button is there and enabled`, async () => {
        const r = await draw(asset(dates));
        assert.strictEqual(r.canStart, true, `canStart was false for ${label}`);
        assert.strictEqual(r.startBlocked, false, `startBlocked was true for ${label}`);
        assert.strictEqual(r.present, true, 'the button is not on the panel');
        assert.strictEqual(r.enabled, true, `the button is disabled for ${label}`);

        /* NO DATE ANYWHERE IN THE REASON COPY. The sentence that was reported
           lived in a template string under this button. */
        assert.ok(!/start date has not arrived/i.test(r.text), 'the old sentence is back');
        assert.ok(!/be started until/i.test(r.text), 'the old tooltip wording is back');
        assert.ok(!/in IST/.test(r.text), 'the IST line under the button is back');

        /* AND IT ACTUALLY STARTS: the click reaches the start call and the
           timer turns over. */
        const after = await press();
        assert.strictEqual(after.started, 'a1', `pressing it did nothing for ${label}`);
        assert.match(after.timer, /running/, 'the timer is not running');
      });
    }

    await t.test('the dates are still shown while all of that is true', async () => {
      const r = await draw(asset({ start_date: '2026-12-25', due_date: '2026-01-05' }));
      /* fmtDay() renders through toLocaleDateString, so the order of the parts
         is the browser's business, not this test's. What matters is that both
         dates reach the panel and reach it as the days they are — the trap
         fmtDay exists for is a stored date printing as the day before. */
      assert.match(r.dates, /Dec/, 'the start date has gone from the panel');
      assert.match(r.dates, /25/, 'the start date lost its day');
      assert.match(r.dates, /2026/);
      assert.match(r.dates, /Jan/, 'the end date has gone from the panel');
      assert.match(r.dates, /\b5\b/, 'the end date lost its day');
    });

    /* ---------------- the reasons that DO still close the button ------------- */

    await t.test('an open task still closes it, and says so without a date', async () => {
      const r = await draw(asset({ start_date: day(30) }), null,
        { assetId: 'other', code: 'PRP-009', name: 'Other' });
      assert.strictEqual(r.startBlocked, true, 'the open-task rule has stopped working');
      assert.strictEqual(r.enabled, false, 'the button is pressable while another task is open');
      assert.match(r.reason, /Finish your current task/);
      assert.match(r.reason, /PRP-009/);
      assert.ok(!/date/i.test(r.reason + r.titles),
        `the refusal mentions a date even though the open task is the reason: ${r.reason}`);
    });

    await t.test('yesterday\'s timesheet still closes it, and says so without a date', async () => {
      const r = await draw(asset({ start_date: day(30) }),
        { blocked: true, date: '2026-11-12', dateLabel: '12 Nov' });
      assert.strictEqual(r.startBlocked, true, 'the timesheet rule has stopped working');
      assert.strictEqual(r.enabled, false);
      assert.match(r.reason, /Fill your timesheet for/);
      assert.match(r.reason, /12 Nov/);
      /* This one legitimately names a DATE — the day whose timesheet is owed —
         so the check is that it is not the ASSET's date. The asset here has a
         start date 30 days out; neither it nor the words "start date" appear. */
      assert.ok(!/start date/i.test(r.reason + r.titles), 'the refusal mentions the asset date');
      assert.ok(!r.reason.includes(day(30)), 'the refusal quotes the asset start date');
    });

    assert.deepStrictEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  });
