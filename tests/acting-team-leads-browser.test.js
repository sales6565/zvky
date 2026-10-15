/* ACTING TEAM LEADS, IN A REAL BROWSER.
 *
 * WHAT A BROWSER PROVES THAT A STRING ASSERTION DOES NOT: that the section is
 * drawn, that its boxes can actually be ticked, that ticking somebody in Team
 * Leads closes them in Acting while the form is open, and that none of it
 * reaches for a native dialog — which the desktop application's web view does
 * not have (Prompt 39).
 *
 * The real stylesheet and the real markup, driven through the same
 * `new Function` slice the other page tests use. The form's own data comes from
 * stubbed endpoints: what is under test is the FORM, and a live server would
 * make this a slower copy of tests/acting-team-leads.test.js's end-to-end half.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (err) { chromium = null; }

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : null,
  '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => {
  try { return fs.statSync(p).isFile(); } catch (err) { return false; }
}) || null;

const SKIP = !chromium
  ? 'playwright-core is not installed — run `npm install` to include the browser tests.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

/* The page's stylesheet and the three functions this form is built from. */
function fixture() {
  const styles = [];
  const re = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(PAGE))) styles.push(m[1]);
  const css = styles.slice(0, 2).join('\n').replace(/@import[^;]+;/g, '');

  const from = PAGE.indexOf('function epChecklist');
  const to = PAGE.indexOf('async function openEditProject');
  assert.ok(from !== -1 && to > from, 'the checklist helpers are in the page');

  /* The markup of the Edit Project sections, lifted from the page so the test
     draws what the application draws rather than a hand-written stand-in. */
  const formFrom = PAGE.indexOf('<label>Team leads on this project</label><div class="checklist" id="ep_leads">');
  const formTo = PAGE.indexOf('id="ep_supervision"');
  assert.ok(formFrom !== -1 && formTo > formFrom);
  const form = PAGE.slice(formFrom, PAGE.indexOf('</div>', formTo) + 6);

  return {
    helpers: PAGE.slice(from, to),
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
      + `<body><div id="app"><div class="modal">${form}</div></div></body></html>`,
  };
}

const PEOPLE = [
  { id: 'u-lead', name: 'Lee Lead' },
  { id: 'u-ana', name: 'Ana Artist' },
  { id: 'u-bo', name: 'Bo Artist' },
];

let browser = null;
async function open() {
  if (!browser) {
    browser = await chromium.launch({
      executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}
test.after(async () => { if (browser) await browser.close(); browser = null; });

async function draw(width = 1440, { chosen = [], leadsChosen = [] } = {}) {
  const b = await open();
  const context = await b.newContext({ viewport: { width, height: 900 } });
  await context.route('**', (route) => (route.request().url().startsWith('http')
    ? route.abort() : route.continue()));
  const page = await context.newPage();
  const f = fixture();
  await page.setContent(f.html, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ helpers, people, chosen: picked, leadsChosen: leads }) => {
    /* NO NATIVE DIALOG MAY FIRE. Replaced with recorders that throw: a real one
       in a headless browser BLOCKS, so a page that called it would hang this
       test rather than fail it. */
    window.__native = [];
    for (const name of ['alert', 'confirm', 'prompt']) {
      window[name] = (...args) => {
        window.__native.push({ name, args: args.map(String) });
        throw new Error(`native ${name}() was called`);
      };
    }
    const escapeHTML = (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const api = new Function('escapeHTML', `${helpers}
      return { epChecklist, actingDisabledMap, wireActingSync };`)(escapeHTML);
    window.__fn = api;
    api.epChecklist('ep_leads', people, leads, { empty: 'No leads or supervisors visible to you.' });
    api.epChecklist('ep_acting', people, picked,
      { disabled: api.actingDisabledMap('ep_leads'), empty: 'No active users to choose from.' });
    api.wireActingSync('ep_leads', 'ep_acting', people);
  }, { helpers: f.helpers, people: PEOPLE, chosen, leadsChosen });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { page, context };
}

const STATE = `(() => Array.from(document.querySelectorAll('#ep_acting label')).map((l) => ({
  name: l.textContent.trim(),
  disabled: l.querySelector('input').disabled,
  checked: l.querySelector('input').checked,
  title: l.getAttribute('title') || '',
})))()`;

test('the section draws every active user, and the picked ones are ticked', { skip: SKIP }, async () => {
  const { page, context } = await draw(1440, { chosen: ['u-ana'] });
  try {
    const rows = await page.evaluate(STATE);
    assert.deepStrictEqual(rows.map((r) => r.name), ['Lee Lead', 'Ana Artist', 'Bo Artist'],
      'all three, because the picker is everybody and not a designation');
    assert.deepStrictEqual(rows.filter((r) => r.checked).map((r) => r.name), ['Ana Artist']);
    assert.deepStrictEqual(rows.filter((r) => r.disabled), [], 'nobody is a Team Lead yet');
    assert.deepStrictEqual(await page.evaluate(() => window.__native), []);
  } finally { await context.close(); }
});

test('ticking somebody in Team Leads closes them in Acting, with the reason',
  { skip: SKIP }, async () => {
    const { page, context } = await draw(1440);
    try {
      /* THE RULE, IN THE FORM, WITHOUT A SAVE IN BETWEEN. */
      await page.click('#ep_leads input[value="u-lead"]');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const rows = await page.evaluate(STATE);
      const lee = rows.find((r) => r.name === 'Lee Lead');
      assert.strictEqual(lee.disabled, true);
      assert.strictEqual(lee.title, 'Already a Team Lead on this project');
      assert.ok(rows.filter((r) => r.name !== 'Lee Lead').every((r) => !r.disabled),
        'and nobody else is affected');

      /* AND UNTICKING THEM FREES THEM AGAIN. */
      await page.click('#ep_leads input[value="u-lead"]');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      assert.strictEqual((await page.evaluate(STATE)).find((r) => r.name === 'Lee Lead').disabled, false);
      assert.deepStrictEqual(await page.evaluate(() => window.__native), []);
    } finally { await context.close(); }
  });

test('a tick that becomes illegal is dropped rather than left to be refused',
  { skip: SKIP }, async () => {
    const { page, context } = await draw(1440, { chosen: ['u-bo'] });
    try {
      await page.click('#ep_leads input[value="u-bo"]');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const bo = (await page.evaluate(STATE)).find((r) => r.name === 'Bo Artist');
      assert.strictEqual(bo.disabled, true);
      assert.strictEqual(bo.checked, false,
        'the acting tick goes with them — the server would have answered 409 for it');
    } finally { await context.close(); }
  });

test('the section lays out without overlap at 1280, 1440 and 1920',
  { skip: SKIP }, async () => {
    for (const width of [1280, 1440, 1920]) {
      const { page, context } = await draw(width, { chosen: ['u-ana'], leadsChosen: ['u-lead'] });
      try {
        const bad = await page.evaluate(() => {
          const hits = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          const labels = Array.from(document.querySelectorAll('#ep_acting label'));
          const out = [];
          for (let i = 0; i < labels.length; i += 1) {
            for (let j = i + 1; j < labels.length; j += 1) {
              if (hits(labels[i].getBoundingClientRect(), labels[j].getBoundingClientRect())) {
                out.push(`${labels[i].textContent.trim()} >< ${labels[j].textContent.trim()}`);
              }
            }
          }
          return { out, scroll: document.documentElement.scrollWidth, inner: window.innerWidth };
        });
        assert.deepStrictEqual(bad.out, [], `rows overlap at ${width}px`);
        assert.ok(bad.scroll <= bad.inner + 1, `the form scrolls sideways at ${width}px`);
      } finally { await context.close(); }
    }
  });
