/* THE TL ACTION BOX, IN A REAL BROWSER.
 *
 * WHAT THIS PROVES THAT THE OTHER SUITE CANNOT. tests/tl-review covers what the
 * server decides; this covers what somebody filling in a timesheet actually
 * sees and can press — that the box is absent for everyone it should be absent
 * for, that ticking either option takes the Asset field off the form entirely
 * and leaves Hours to be typed, and that changing the project or the kind of
 * time, or un-ticking, puts the ordinary form back.
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

  /* THE MARKUP, LIFTED TOO — the real ids and the real option text, taken out
     of the modal rather than retyped, so a field renamed in the page breaks
     this suite instead of silently passing. Two pieces: the project fields
     (which hold the box and the asset picker) and the pair of sentences under
     the Hours field, which TL Action swaps between. */
  const markup = cut('<div id="tl_projectFields">', '<div id="tl_catFields"', 'the project fields');
  const helpMarkup = cut('<div id="tl_help"', '<div id="tl_calc"', 'the two hours sentences');

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
  ${helpMarkup}
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
/* EVERY REQUEST THIS PAGE MAKES, recorded — because one of the things this
   suite asserts is that the TL Action box makes NONE. The projects somebody
   leads come down with the week; the form asks nothing while it is open. */
window.__calls = [];
async function api(p, opts = {}){
  window.__calls.push({ path: p, method: (opts && opts.method) || 'GET' });
  const answer = window.__apiAnswers && window.__apiAnswers[p.split('?')[0]];
  if (typeof answer === 'function') return answer(p);
  if (answer && answer.__throw) { const e = new Error(answer.__throw); e.status = answer.status; throw e; }
  return answer || {};
}
/* THE STATE THE LIFTED CODE READS, which is the week payload: the studio's
   switch, and the ids of the projects this reader leads — the server's answer
   to "do you lead it", including Acting Team Leads. Both are declared outside
   the lifted block in the page. */
let tsState = { week: { workingDay: { tlAction: true, maxHours: 8 }, tlActionProjects: [], days: [] }, draft: {} };
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

const open = async (browser, { permissions = ['timesheet.tl_action'], tlAction = true,
  leads = ['p1'] } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(fixture(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.evaluate(([perms, on, led]) => {
    window.__permissions = perms;
    tsState.week.workingDay.tlAction = on;
    tsState.week.tlActionProjects = led;
  }, [permissions, tlAction, leads]);
  return { page, errors };
};
const box = (page) => page.evaluate(() => ({
  wrap: document.getElementById('tl_actionWrap').style.display,
  ticked: document.getElementById('tl_action').checked,
  typeWrap: document.getElementById('tl_actionTypeWrap').style.display,
  type: document.getElementById('tl_actionType').value,
  /* VISIBLE, not merely enabled — the brief's word is "hidden", and the two
     are different things to somebody looking at the form. offsetParent is null
     for an element no display:none ancestor is showing, which is the browser's
     own answer rather than a reading of the style attribute. */
  assetShown: Boolean(document.getElementById('tl_asset').offsetParent),
  assetLabelShown: Boolean(document.getElementById('tl_assetWrap').offsetParent),
  assetDisabled: document.getElementById('tl_asset').disabled,
  assetValue: document.getElementById('tl_asset').value,
  assetOptions: [...document.getElementById('tl_asset').options].map((o) => o.textContent),
  hours: document.getElementById('tl_hours').value,
  hoursLocked: document.getElementById('tl_hours').readOnly,
  helpShown: Boolean(document.getElementById('tl_help').offsetParent),
  typedHelpShown: Boolean(document.getElementById('tl_helpTyped').offsetParent),
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

  await t.test('no key, no box', async () => {
    const { page, errors } = await open(browser, { permissions: [], leads: ['p1'] });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, 'none', 'the box is not drawn');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });

  await t.test('the switch off hides it, even for a lead who holds the key', async () => {
    const { page } = await open(browser, { tlAction: false });
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, 'none');
    await page.close();
  });

  await t.test('a lead of another project does not get it on this one', async () => {
    /* The server sends the projects this person leads; p1 is not among them. */
    const { page } = await open(browser, { leads: ['p2'] });
    await chooseProject(page, 'p1');
    assert.strictEqual((await box(page)).wrap, 'none');
    await page.close();
  });

  await t.test('an Acting Team Lead gets it, because the list is the server\'s answer', async () => {
    /* THE WHOLE POINT OF TAKING THE LIST FROM THE SERVER. An Acting Team Lead
       is a lead of one project and may hold any designation at all — there is
       nothing about the role the page could read to work this out. */
    const { page } = await open(browser, { leads: ['p1'] });
    await chooseProject(page, 'p1');
    assert.strictEqual((await box(page)).wrap, '');
    await page.close();
  });

  await t.test('non-project time has no TL Action box', async () => {
    const { page } = await open(browser);
    await chooseProject(page);
    assert.strictEqual((await box(page)).wrap, '', 'it is there for project work');
    await page.selectOption('#tl_kind', 'non');
    await page.evaluate(() => syncTimesheetLine());
    await page.waitForFunction(() => document.getElementById('tl_actionWrap').style.display === 'none');
    assert.strictEqual((await box(page)).wrap, 'none', 'and gone for a non-project category');
    await page.close();
  });

  await t.test('it sits after Project and before Asset, and reads as one line', async () => {
    const { page } = await open(browser);
    await chooseProject(page);
    const order = await page.evaluate(() => {
      const y = (id) => document.getElementById(id).getBoundingClientRect().top;
      return { project: y('tl_project'), box: y('tl_actionWrap'), asset: y('tl_asset') };
    });
    assert.ok(order.project < order.box, 'below the project picker');
    assert.ok(order.box < order.asset, 'and above the asset picker');

    const rows = await page.evaluate(() => {
      const label = document.querySelector('.tl-action-box');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return { tick: mid(label.querySelector('input')), hint: mid(label.querySelector('.tl-action-hint')),
        height: label.getBoundingClientRect().height };
    });
    assert.ok(Math.abs(rows.tick - rows.hint) < 6, 'the tick and its hint share a line');
    assert.ok(rows.height < 40, `and the box is one line tall, not two — ${rows.height}px`);
    await page.close();
  });

  await t.test('ticking it offers exactly two kinds, and chooses neither', async () => {
    const { page } = await open(browser);
    await chooseProject(page);
    await page.check('#tl_action');
    const shown = await box(page);
    assert.strictEqual(shown.typeWrap, '', 'the dropdown appears');
    assert.strictEqual(shown.type, '', 'on the placeholder');
    const options = await page.evaluate(() =>
      [...document.getElementById('tl_actionType').options].map((o) => [o.value, o.textContent]));
    assert.deepStrictEqual(options, [['', 'Choose…'], ['project_meeting', 'Project Meeting'],
      ['review', 'Review']], 'exactly two kinds, and the old name is not among them');

    /* TICKING IT CHOOSES NOTHING YET, so the form is left alone — a box that
       emptied the asset field the instant it was ticked would punish somebody
       who ticked it to see what it did. */
    assert.strictEqual(shown.assetShown, true, 'the asset field is untouched so far');
    await page.close();
  });

  for (const kind of ['project_meeting', 'review']) {
    await t.test(`${kind}: the Asset field goes, and Hours is typed`, async () => {
      const { page, errors } = await open(browser);
      await chooseProject(page);
      await page.evaluate(() => tlLoadAssets('p1'));
      await page.selectOption('#tl_asset', 'ord-1');
      await page.check('#tl_action');
      await page.selectOption('#tl_actionType', kind);

      const shown = await box(page);
      /* HIDDEN, LABEL AND ALL — not disabled. A disabled select is still a
         labelled control asking to be filled in for a kind of line that has no
         asset; a lone heading above nothing reads as a field that failed. */
      assert.strictEqual(shown.assetShown, false, 'the asset field is not visible');
      assert.strictEqual(shown.assetLabelShown, false, 'and neither is its label');
      assert.strictEqual(shown.assetValue, '', 'and the chosen asset is cleared, not just hidden');

      assert.strictEqual(shown.hoursLocked, false, 'the hours are the lead\'s to type');
      assert.strictEqual(shown.helpShown, false, 'the clock sentence is gone');
      assert.strictEqual(shown.typedHelpShown, true, 'and says to type the hours instead');

      await page.fill('#tl_hours', '1.5');
      assert.strictEqual((await box(page)).hours, '1.5', 'and typing works');
      assert.deepStrictEqual(errors, []);
      await page.close();
    });
  }

  await t.test('the box makes no request of any kind', async () => {
    /* THE LIST COMES WITH THE WEEK, so nothing is fetched while somebody is
       filling in the form — which is also what makes the box instant. */
    const { page } = await open(browser);
    await page.evaluate(() => { window.__calls = []; });
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'review');
    await page.selectOption('#tl_actionType', 'project_meeting');
    await page.uncheck('#tl_action');
    const calls = await page.evaluate(() => window.__calls.map((c) => c.path));
    assert.deepStrictEqual(calls.filter((p) => !p.startsWith('/assets/project/')), [],
      `the box asks the server nothing: ${calls.join(' | ')}`);
    await page.close();
  });

  await t.test('un-ticking puts the asset field and the clock sentence back', async () => {
    const { page } = await open(browser);
    await chooseProject(page);
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'review');
    await page.waitForFunction(() => !document.getElementById('tl_asset').offsetParent);

    await page.uncheck('#tl_action');
    await page.waitForFunction(() => Boolean(document.getElementById('tl_asset').offsetParent));
    const shown = await box(page);
    assert.strictEqual(shown.typeWrap, 'none', 'the kind dropdown goes');
    assert.strictEqual(shown.type, '', 'and is cleared, not merely hidden');
    assert.strictEqual(shown.assetShown, true, 'the asset field is back');
    assert.strictEqual(shown.assetLabelShown, true, 'with its label');
    assert.strictEqual(shown.helpShown, true, 'and the clock sentence returns');
    assert.strictEqual(shown.typedHelpShown, false);
    assert.ok(shown.assetOptions.some((t) => t.includes('An Ordinary Asset')),
      'and the project\'s own assets are back in it');
    await page.close();
  });

  await t.test('changing the project clears the box', async () => {
    const { page } = await open(browser, { leads: ['p1', 'p2'] });
    await chooseProject(page, 'p1');
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'review');
    await page.waitForFunction(() => !document.getElementById('tl_asset').offsetParent);

    await page.evaluate(() => { document.getElementById('tl_project').innerHTML =
      '<option value="p1">A Project</option><option value="p2">Another Project</option>'; });
    await page.selectOption('#tl_project', 'p2');
    await page.waitForFunction(() => document.getElementById('tl_action').checked === false);
    const shown = await box(page);
    assert.strictEqual(shown.ticked, false, 'the tick goes');
    assert.strictEqual(shown.type, '', 'the kind goes');
    assert.strictEqual(shown.assetShown, true, 'and the asset field comes back');
    assert.strictEqual(shown.wrap, '', 'the box itself stays, because this project is led too');
    await page.close();
  });

  await t.test('changing to a project the person does not lead takes the box away', async () => {
    const { page } = await open(browser, { leads: ['p1'] });
    await chooseProject(page, 'p1');
    await page.check('#tl_action');
    await page.selectOption('#tl_actionType', 'review');

    await page.evaluate(() => { document.getElementById('tl_project').innerHTML =
      '<option value="p1">A Project</option><option value="p2">Another Project</option>'; });
    await page.selectOption('#tl_project', 'p2');
    await page.waitForFunction(() => document.getElementById('tl_actionWrap').style.display === 'none');
    const shown = await box(page);
    assert.strictEqual(shown.ticked, false);
    assert.strictEqual(shown.assetShown, true, 'and the ordinary form is back');
    await page.close();
  });

  await t.test('the form refuses a half-filled TL Action beside the dropdown, not in a dialog', async () => {
    const { page } = await open(browser);
    await chooseProject(page);
    await page.check('#tl_action');
    assert.match(await page.evaluate(() => tlActionProblem()), /what kind of TL Action/);

    await page.selectOption('#tl_actionType', 'review');
    assert.strictEqual(await page.evaluate(() => tlActionProblem()), '',
      'and nothing is wrong once a kind is chosen — there is no asset left to choose');

    assert.deepStrictEqual(await page.evaluate(() => window.__native), [],
      'no native dialog was reached');
    await page.close();
  });
});
