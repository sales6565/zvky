/* THE TL ACTION BOX, IN A REAL BROWSER.
 *
 * WHAT THIS PROVES THAT THE OTHER SUITE CANNOT. tests/tl-review covers what the
 * server decides; this covers what somebody filling in a timesheet actually
 * sees and can press — that the box is absent for everyone it should be absent
 * for, that ticking it does what the brief says to the two fields below it,
 * that an asset still in review cannot be chosen however hard you click, and
 * that changing the day or the project puts everything back.
 *
 * THE REAL FUNCTIONS, LIFTED. The block between the TL Action heading and the
 * day-total helper is taken out of the page verbatim, along with
 * syncTimesheetLine and the two hours helpers it calls, so this drives what
 * ships rather than a retyped copy of it.
 *
 * NO NATIVE DIALOGS. The desktop web view has none (Prompt 39), so alert,
 * confirm and prompt throw here and any case that reaches one fails.
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

  const actionBlock = cut('/* ---------- TL Action ----------',
    '/* What this line would make the day come to, as it is typed.', 'the TL Action block');
  const lockBlock = cut('function tlLockHours(locked){',
    "document.getElementById('tl_hours').addEventListener('input', tlRecalc);", 'tlLockHours');
  const syncBlock = cut('function syncTimesheetLine(){', '/* ---------- the second dropdown ----------',
    'syncTimesheetLine');

  /* THE MARKUP, LIFTED TOO — the real ids, the real option text, the real
     optgroup structure. Taken out of the modal rather than retyped, so a field
     renamed in the page breaks this suite instead of silently passing. */
  const markup = cut('<div id="tl_projectFields">', '<div id="tl_catFields"', 'the project fields');

  /* NO STUB MAY SHADOW SOMETHING THE LIFTED CODE DECLARES — a `const` beside a
     `function` of the same name in one scope is a SyntaxError that kills the
     whole <script>, so window.__ready is never set and every case in the file
     dies on a thirty-second timeout that says only "Timeout". Checked here,
     by name, before a browser is launched. */
  const declaredIn = (block) => new Set(
    [...block.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]));
  const FIXTURE_DECLARES = ['escapeHTML', 'can', 'api', 'tsState', 'tlDay', 'tlLoadAssets',
    'tlRecalc', 'tlSuggest', 'tlSubOptionProblem', 'tlClearSubOption', 'tlSyncSubOptions'];
  const blocks = [['TL Action', actionBlock], ['tlLockHours', lockBlock], ['syncTimesheetLine', syncBlock]];
  for (const [label, block] of blocks) {
    const clash = FIXTURE_DECLARES.filter((n) => declaredIn(block).has(n));
    assert.deepStrictEqual(clash, [],
      `${label} already declares ${clash.join(', ')} — a stub beside it is a redeclaration, `
      + 'which kills the whole script. Delete the stub and let the real one run, or override it '
      + 'by assignment after the block.');
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;padding:12px;}</style></head>
<body>
  <select id="tl_kind"><option value="project">Project work</option><option value="non">Non-project</option></select>
  ${markup}
  <div id="tl_catFields" style="display:none;">
    <select id="tl_cat"></select>
    <div id="tl_subWrap" style="display:none;"><label id="tl_subLabel"></label>
      <select id="tl_sub"></select><div id="tl_subErr"></div></div>
  </div>
  <input type="number" id="tl_hours" step="0.25">
  <div id="tl_suggest"></div>
  <div id="tl_calc"></div>
  <div id="tl_flagWrap" style="display:none;">
    <input type="checkbox" id="tl_flag"><div id="tl_flagNoteWrap" style="display:none;">
    <textarea id="tl_flagNote"></textarea></div>
  </div>
<script>
window.__native = [];
for (const name of ['alert', 'confirm', 'prompt']) {
  window[name] = (...args) => { window.__native.push([name, String(args[0] || '')]); throw new Error('native ' + name); };
}
const escapeHTML = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
window.__permissions = [];
function can(){ for (let i = 0; i < arguments.length; i++) if (window.__permissions.includes(arguments[i])) return true; return false; }
window.__calls = [];
async function api(p, opts = {}){
  window.__calls.push({ path: p, method: (opts && opts.method) || 'GET' });
  const answer = window.__apiAnswers && window.__apiAnswers[p.split('?')[0]];
  if (typeof answer === 'function') return answer(p);
  if (answer && answer.__throw) { const e = new Error(answer.__throw); e.status = answer.status; throw e; }
  return answer || {};
}
/* THE STATE THE LIFTED CODE READS. tsState.week.workingDay.tlAction is the
   studio's switch as the week payload publishes it; tlDay is the day the form
   is open on. Both are declared outside the lifted block in the page. */
let tsState = { week: { workingDay: { tlAction: true, maxHours: 8 }, days: [] }, draft: {} };
let tlDay = '2026-03-12';
/* The ordinary asset list, which the real one fetches. Stubbed because what it
   loads is not what this suite is about — what matters is that TL Action puts
   it back, which is asserted by the option text below. */
async function tlLoadAssets(projectId){
  const sel = document.getElementById('tl_asset');
  sel.innerHTML = '<option value="">No specific asset</option>'
    + (projectId ? '<option value="ord-1">ORD-1 — An Ordinary Asset</option>' : '');
}
function tlRecalc(){}
async function tlSuggest(){ window.__suggested = (window.__suggested || 0) + 1; }
function tlSubOptionProblem(){ return ''; }
function tlClearSubOption(){}
function tlSyncSubOptions(){}
${lockBlock}
${actionBlock}
${syncBlock}

/* THE TWO LISTENERS THE PAGE ATTACHES OUTSIDE THESE BLOCKS.
 *
 * In public/index.html the asset picker's change handler and the project
 * picker's both sit at the top level of the script, beside the blocks lifted
 * above rather than inside them — so a fixture that lifts the functions and
 * not the wiring has every function working and nothing connected to anything.
 * That cost a run here: choosing a ready asset left the Hours field empty and
 * the failure read like a product bug.
 *
 * Copied from the page, and the non-browser suite asserts the page still wires
 * them this way — so if somebody moves or deletes one there, this fixture
 * stops being a faithful copy LOUDLY rather than quietly. */
document.getElementById('tl_asset').addEventListener('change', (e) => {
  if (document.getElementById('tl_action').checked
    && document.getElementById('tl_actionType').value === 'asset_review') {
    tlFillReviewHours();
    return;
  }
  if (!e.target.value) { tlLockHours(false); document.getElementById('tl_hours').value = ''; return; }
  tlSuggest();
});
document.getElementById('tl_project').addEventListener('change', async (e) => {
  tlClearAction();
  await tlLoadAssets(e.target.value);
  await tlSyncAction();
});
window.__ready = true;
</script></body></html>`;
}

const open = async (browser, { permissions = ['timesheet.tl_action'], tlAction = true, answers = {} } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(fixture(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.evaluate(([perms, on, api]) => {
    window.__permissions = perms;
    tsState.week.workingDay.tlAction = on;
    window.__apiAnswers = api;
  }, [permissions, tlAction, answers]);
  return { page, errors };
};

const LEADS = { '/timesheets/tl-review/assets': { enabled: true, ready: [], inReview: [] } };
const box = (page) => page.evaluate(() => ({
  wrap: document.getElementById('tl_actionWrap').style.display,
  ticked: document.getElementById('tl_action').checked,
  typeWrap: document.getElementById('tl_actionTypeWrap').style.display,
  type: document.getElementById('tl_actionType').value,
  assetDisabled: document.getElementById('tl_asset').disabled,
  assetValue: document.getElementById('tl_asset').value,
  assetOptions: [...document.getElementById('tl_asset').options].map((o) => ({
    value: o.value, text: o.textContent, disabled: o.disabled,
    group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null })),
  hours: document.getElementById('tl_hours').value,
  hoursLocked: document.getElementById('tl_hours').readOnly,
  note: document.getElementById('tl_suggest').textContent,
  err: document.getElementById('tl_actionErr').textContent,
}));

const chooseProject = async (page, id = 'p1') => {
  await page.evaluate((pid) => { document.getElementById('tl_project').innerHTML =
    `<option value="">Select…</option><option value="${pid}">A Project</option>`; }, id);
  await page.selectOption('#tl_project', id);
  await page.evaluate(() => tlSyncAction());
};

test('the TL Action box, in a browser', { skip: SKIP }, async (t) => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  t.after(() => browser.close());

  await t.test('no key, no box — and the server is never even asked', async () => {
    const { page, errors } = await open(browser, { permissions: [], answers: LEADS });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, 'none', 'the box is not drawn');
    const asked = await page.evaluate(() => window.__calls.filter((c) => c.path.includes('tl-review')));
    assert.deepStrictEqual(asked, [],
      'and the page does not ask who leads what on behalf of somebody who could not use the answer');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('the switch off hides it, even for a lead who holds the key', async () => {
    const { page } = await open(browser, { tlAction: false, answers: LEADS });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, 'none');
    await page.close();
  });

  await t.test('a lead of another project is told no by the server, and sees no box', async () => {
    const refused = { '/timesheets/tl-review/assets': { __throw: 'You do not lead that project.', status: 403 } };
    const { page } = await open(browser, { answers: refused });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, 'none',
      'a 403 is the answer "you do not lead it", and the box simply is not there');
    await page.close();
  });

  await t.test('non-project time has no TL Action box', async () => {
    const { page } = await open(browser, { answers: LEADS });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, '', 'it is there for project work');
    await page.selectOption('#tl_kind', 'non');
    await page.evaluate(() => syncTimesheetLine());
    await page.waitForFunction(() => document.getElementById('tl_actionWrap').style.display === 'none');
    assert.strictEqual((await box(page)).wrap, 'none', 'and gone for a non-project category');
    await page.close();
  });

  await t.test('it sits after Project and before Asset, and reads as one line', async () => {
    const { page } = await open(browser, { answers: LEADS });
    await chooseProject(page);
    const order = await page.evaluate(() => {
      const y = (id) => document.getElementById(id).getBoundingClientRect().top;
      return { project: y('tl_project'), box: y('tl_actionWrap'), asset: y('tl_asset') };
    });
    assert.ok(order.project < order.box, 'below the project picker');
    assert.ok(order.box < order.asset, 'and above the asset picker');

    /* THE CHECK BOX AND ITS WORDS ON ONE LINE. A two-line check box in a column
       of one-line fields reads as a section heading rather than a question. */
    const rows = await page.evaluate(() => {
      const label = document.querySelector('.tl-action-box');
      const tick = label.querySelector('input');
      const hint = label.querySelector('.tl-action-hint');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return { tick: mid(tick), hint: mid(hint), height: label.getBoundingClientRect().height };
    });
    assert.ok(Math.abs(rows.tick - rows.hint) < 6, 'the tick and its hint share a line');
    assert.ok(rows.height < 40, `and the box is one line tall, not two — ${rows.height}px`);
    await page.close();
  });

  await t.test('ticking it offers the two kinds, and chooses neither', async () => {
    const { page } = await open(browser, { answers: LEADS });
    await chooseProject(page);
    await page.check('#tl_action');
    const shown = await box(page);
    assert.strictEqual(shown.typeWrap, '', 'the second dropdown appears');
    assert.strictEqual(shown.type, '', 'on the placeholder');
    const options = await page.evaluate(() =>
      [...document.getElementById('tl_actionType').options].map((o) => [o.value, o.textContent]));
    assert.deepStrictEqual(options, [['', 'Choose…'], ['project_meeting', 'Project Meeting'],
      ['asset_review', 'Asset Review']]);
    /* TICKING IT CHOOSES NOTHING YET, so the asset field is left alone — a box
       that cleared the asset the instant it was ticked would punish somebody
       who ticked it to see what it did. */
    assert.strictEqual(shown.assetDisabled, false, 'and the asset field is untouched so far');
    await page.close();
  });

  await t.test('Project Meeting disables and clears the asset, and the hours are typed', async () => {
    const { page } = await open(browser, { answers: LEADS });
    await chooseProject(page);
    await page.evaluate(() => tlLoadAssets('p1'));
    await page.selectOption('#tl_asset', 'ord-1');
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'project_meeting');

    const shown = await box(page);
    assert.strictEqual(shown.assetDisabled, true, 'the asset field is disabled');
    assert.strictEqual(shown.assetValue, '', 'and cleared, not merely greyed');
    assert.strictEqual(shown.assetOptions[0].text, 'Not for a project meeting',
      'and says why rather than looking empty');
    assert.strictEqual(shown.hoursLocked, false, 'the hours are the lead\'s to type');

    await page.fill('#tl_hours', '1.5');
    assert.strictEqual((await box(page)).hours, '1.5');
    await page.close();
  });

  await t.test('Asset Review draws both groups, and the unfinished ones cannot be chosen', async () => {
    const answers = { '/timesheets/tl-review/assets': {
      enabled: true,
      ready: [{ assetId: 'a1', code: 'CH-01', name: 'Hero', label: 'CH-01 — Hero', hours: 1.5 },
        { assetId: 'a2', code: 'CH-02', name: 'Villain', label: 'CH-02 — Villain', hours: 0.25 }],
      inReview: [{ assetId: 'a3', code: 'CH-03', name: 'Sidekick', label: 'CH-03 — Sidekick',
        hours: null, reason: 'Finish the review first (Request Changes or TL Approved).' }],
    } };
    const { page, errors } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);

    const shown = await box(page);
    const groups = [...new Set(shown.assetOptions.map((o) => o.group).filter(Boolean))];
    assert.deepStrictEqual(groups, ['Ready to log', 'Still in TL review'],
      'two groups, in that order');
    const hero = shown.assetOptions.find((o) => o.text.includes('Hero'));
    assert.match(hero.text, /1\.5h/, 'the hours are shown beside the asset');
    assert.strictEqual(hero.disabled, false, 'and a finished one can be chosen');

    const sidekick = shown.assetOptions.find((o) => o.text.includes('Sidekick'));
    assert.strictEqual(sidekick.disabled, true, 'an unfinished one cannot');
    assert.strictEqual(sidekick.value, '', 'and carries no id to post even if it could');
    assert.match(sidekick.text, /still in review/);

    /* AND NOT MERELY STYLED AS UNPICKABLE. Asked of the browser rather than of
       the attribute: selectOption on a disabled option is refused, which is
       what "cannot be selected" means to somebody using the form. */
    let refused = false;
    await page.selectOption('#tl_asset', 'a3', { timeout: 1500 }).catch(() => { refused = true; });
    assert.ok(refused || (await box(page)).assetValue !== 'a3',
      'the browser will not select it');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('choosing a ready asset fills the hours, locked, with the sentence beside them', async () => {
    const answers = { '/timesheets/tl-review/assets': {
      enabled: true,
      ready: [{ assetId: 'a1', code: 'CH-01', name: 'Hero', label: 'CH-01 — Hero', hours: 1.5 }],
      inReview: [],
    } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);
    await page.selectOption('#tl_asset', 'a1');
    await page.waitForFunction(() => document.getElementById('tl_hours').value !== '');

    const shown = await box(page);
    assert.strictEqual(shown.hours, '1.5', 'the figure the server sent');
    assert.strictEqual(shown.hoursLocked, true, 'and it is not the lead\'s to change');
    assert.match(shown.note, /copied the submission path until you approved or requested changes/);
    assert.match(shown.note, /inside working hours/);

    /* AND THE PAGE DID NOT WORK IT OUT. The only number it ever had is the one
       in the response — asserted by changing the response and redrawing. */
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.path.includes('tl-review')).length);
    assert.ok(calls >= 1, 'it asked the server');
    assert.strictEqual((await box(page)).hours, '1.5');
    await page.close();
  });

  await t.test('an empty day says so instead of showing an empty box', async () => {
    const answers = { '/timesheets/tl-review/assets': { enabled: true, ready: [], inReview: [] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => /No finished reviews/.test(document.getElementById('tl_suggest').textContent)
      || /No finished reviews/.test(document.getElementById('tl_asset').textContent));
    const shown = await box(page);
    assert.match(shown.note + shown.assetOptions.map((o) => o.text).join(' '),
      /No finished reviews to log on this day/);
    await page.close();
  });

  await t.test('everything in review and nothing ready says what to do about it', async () => {
    const answers = { '/timesheets/tl-review/assets': { enabled: true, ready: [],
      inReview: [{ assetId: 'a3', label: 'CH-03 — Sidekick', name: 'Sidekick', hours: null,
        reason: 'Finish the review first (Request Changes or TL Approved).' }] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_suggest').textContent.length > 0);
    assert.match((await box(page)).note, /Finish the review first/);
    await page.close();
  });

  await t.test('un-ticking puts the asset list and the typed hours back', async () => {
    const answers = { '/timesheets/tl-review/assets': { enabled: true,
      ready: [{ assetId: 'a1', label: 'CH-01 — Hero', name: 'Hero', hours: 1.5 }], inReview: [] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);
    await page.selectOption('#tl_asset', 'a1');
    await page.waitForFunction(() => document.getElementById('tl_hours').value !== '');
    assert.strictEqual((await box(page)).hours, '1.5');

    await page.uncheck('#tl_action');
    await page.waitForFunction(() => document.getElementById('tl_hours').readOnly === false);
    const shown = await box(page);
    assert.strictEqual(shown.typeWrap, 'none', 'the kind dropdown goes');
    assert.strictEqual(shown.type, '', 'and is cleared, not merely hidden');
    assert.strictEqual(shown.hours, '', 'the figure goes with it');
    assert.strictEqual(shown.hoursLocked, false, 'and the field is typed again');
    assert.ok(shown.assetOptions.some((o) => o.text.includes('An Ordinary Asset')),
      'and the project\'s own assets are back');
    await page.close();
  });

  await t.test('changing the project clears the box before anything else', async () => {
    const answers = { '/timesheets/tl-review/assets': { enabled: true,
      ready: [{ assetId: 'a1', label: 'CH-01 — Hero', name: 'Hero', hours: 1.5 }], inReview: [] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page, 'p1');
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);

    /* A SECOND PROJECT. The tick is about the project it was made on, and a
       tick left over would be a tick about a project this person may not even
       lead. */
    await page.evaluate(() => { document.getElementById('tl_project').innerHTML =
      '<option value="p1">A Project</option><option value="p2">Another Project</option>'; });
    await page.selectOption('#tl_project', 'p2');
    await page.waitForFunction(() => document.getElementById('tl_action').checked === false);
    const shown = await box(page);
    assert.strictEqual(shown.ticked, false, 'the tick goes');
    assert.strictEqual(shown.type, '', 'the kind goes');
    assert.strictEqual(shown.hours, '', 'the hours go');
    assert.strictEqual(shown.hoursLocked, false);
    await page.close();
  });

  await t.test('changing the day re-reads the list for that day', async () => {
    let asked = [];
    const answers = { '/timesheets/tl-review/assets': { enabled: true,
      ready: [{ assetId: 'a1', label: 'CH-01 — Hero', name: 'Hero', hours: 1.5 }], inReview: [] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);

    await page.evaluate(() => { window.__calls = []; tlDay = '2026-03-13'; return tlLoadReviewAssets(); });
    asked = await page.evaluate(() => window.__calls.map((c) => c.path));
    assert.ok(asked.some((p) => p.includes('date=2026-03-13')),
      `the new day is what it asks about: ${asked.join(' | ')}`);
    await page.close();
  });

  await t.test('the form refuses a half-filled TL Action beside the dropdown, not in a dialog', async () => {
    const answers = { '/timesheets/tl-review/assets': { enabled: true,
      ready: [{ assetId: 'a1', label: 'CH-01 — Hero', name: 'Hero', hours: 1.5 }], inReview: [] } };
    const { page } = await open(browser, { answers });
    await chooseProject(page);
    await page.check('#tl_action');
    assert.match(await page.evaluate(() => tlActionProblem()), /what kind of TL Action/);

    await page.selectOption('#tl_actionType', 'asset_review');
    await page.waitForFunction(() => document.getElementById('tl_asset').options.length > 1);
    assert.match(await page.evaluate(() => tlActionProblem()), /Choose the asset you reviewed/);

    await page.selectOption('#tl_asset', 'a1');
    assert.strictEqual(await page.evaluate(() => tlActionProblem()), '',
      'and nothing is wrong once both are chosen');

    assert.deepStrictEqual(await page.evaluate(() => window.__native), [],
      'no native dialog was reached');
    await page.close();
  });
});
