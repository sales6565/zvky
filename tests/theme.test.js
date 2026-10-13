/* THE STUDIO'S COLOURS: the catalogue, the validation, the delivery and the editor.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE is the one everything else rests on: with
 * no theme saved, the application looks EXACTLY as it did before colours became
 * tokens. Not approximately — byte for byte. tests/fixtures/colours-before-theme.json
 * is every colour literal and every :root variable in public/index.html at the
 * last commit before this change, and the first group below asserts that every
 * token default, and every value the generator derives from one, is one of them.
 *
 * THE SECOND CLAIM is that a theme editor is not a CSS injection route. A value
 * goes from a text box into a `:root{}` block on every page in the application,
 * which is as direct a path as that gets. The defence is not escaping: it is that
 * canonical() rebuilds every value from its matched hex digits, so the output
 * contains nothing of the input. The injection cases below are not sanitised,
 * they are refused.
 *
 * FIXED VALUES, NO CLOCK. Nothing here depends on what day it is.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const theme = require('../src/theme');
const tokens = require('../src/theme-tokens');
const workflow = require('../src/asset-workflow');
const catalogue = require('../src/permission-catalog');
const { config, resetSchema, startServer, stopServer, api, raw, sql, SKIP_REASON } = require('./helpers');

const cfg = config('theme');
const PASSWORD = 'Theme-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'colours-before-theme.json'), 'utf8'));

// ===========================================================================
// 1. THE DEFAULTS ARE THE COLOURS THE APPLICATION SHIPPED WITH.
// ===========================================================================

/* The fourteen token defaults that are NOT literally in the pre-change file,
 * each with the reason — and each reason is checkable rather than a promise.
 *
 *   a derivation base   the stylesheet only ever drew this colour translucent,
 *                       so the base is new and the DERIVED values are what have
 *                       to match. Asserted separately, and more strongly.
 *   transparent         the stylesheet said `transparent`; #00000000 is the
 *                       same colour, in the form a hex field can hold.
 *   no such state       the application had no tab hover and no active-tab
 *                       indicator. Transparent, so nothing changes until a
 *                       studio sets one.
 */
const EXPLAINED = {
  'surface.sunk': 'derivation base — only ever drawn at .10',
  'surface.overlay': 'derivation base — only ever drawn at .6 and .65',
  'surface.overlay.tour': 'derivation base — only ever drawn at .72',
  'surface.shadow': 'derivation base — only ever drawn at six alphas',
  'surface.scrim': 'derivation base — only ever drawn at .72 and .92',
  'meaning.success.wash': 'derivation base — the shipped palette washed #40C88C and filled #3DDC97',
  'meaning.warning.wash': 'derivation base — the shipped palette washed #FFB020 and filled #F2B33D',
  'meaning.archived': 'derivation base — only ever drawn at 0x33',
  'meaning.closed': 'derivation base — only ever drawn at 0x22',
  'nav.tab.background': 'the stylesheet said `transparent`',
  'nav.tab.hover.background': 'there was no tab hover state; transparent changes nothing',
  'nav.tab.indicator': 'there was no active-tab indicator; transparent changes nothing',
  'subtab.background': 'the stylesheet said `transparent`',
  'table.row.background': 'the stylesheet said `transparent`',
};

const before = {
  literals: new Set(Object.keys(BEFORE.literals).map((v) => v.toUpperCase())),
  vars: new Set(Object.values(BEFORE.rootVars).map((v) => v.toUpperCase())),
};
const wasThere = (v) => before.literals.has(v.toUpperCase()) || before.vars.has(v.toUpperCase());

test('every token default is a colour the application already used', () => {
  const unexplained = [];
  for (const tok of theme.all()) {
    if (wasThere(tok.default)) continue;
    if (EXPLAINED[tok.key]) continue;
    unexplained.push(`${tok.key} = ${tok.default}`);
  }
  assert.deepStrictEqual(unexplained, [],
    'a token default is a colour this application never drew — either it is wrong, or it '
    + 'needs an entry in EXPLAINED saying why');

  // And the exception list names nothing that has since become ordinary.
  for (const key of Object.keys(EXPLAINED)) {
    const tok = theme.all().find((t) => t.key === key);
    assert.ok(tok, `EXPLAINED names a token that no longer exists: ${key}`);
    assert.ok(!wasThere(tok.default) || tok.default === '#00000000',
      `${key} is now a colour the old file had, so its exception is stale`);
  }
});

/* COMPARING COLOURS, NOT SPELLINGS. The pre-change stylesheet was written by
   hand over a long time and spells the same alpha three ways: `.30`, `.3` and
   `.5` all appear, and `rgba(127,127,127,.10)` sits a few lines from
   `rgba(127,20,22,.1)`. CSS cannot tell those apart and neither can a screen, so
   demanding the generator reproduce a redundant zero would be testing my
   typing. Both sides are reduced to the triple plus the alpha as a NUMBER, and
   then the match has to be exact: a wrong base or a wrong alpha still fails. */
const sameColour = (v) => {
  const m = /^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/.exec(v.replace(/\s+/g, ''));
  if (!m) return v.toUpperCase();
  return `${m[1]},${m[2]},${m[3]},${Number(m[4])}`;
};
const beforeColours = new Set(Object.keys(BEFORE.literals).map(sameColour));

test('every DERIVED value is a colour the stylesheet already drew', () => {
  /* THE STRONGER HALF, and the one that makes the derivation trustworthy: the
     nine bases above are colours the file never drew opaque, so the only way to
     know the base is right is that every value generated FROM it comes back as
     a colour the file did draw. rgba(255,90,54,.12) and #E8402C14 both have to
     land on an existing one. */
  const css = theme.cssFor();
  const derived = [...css.matchAll(/--([a-z0-9-]+)-t[0-9a-f]{2,3}:([^;]+);/g)]
    .map((m) => ({ css: m[1], value: m[2] }));
  assert.ok(derived.length > 50, `the generator still derives alphas (${derived.length})`);

  /* THE ONE CATEGORY THAT CANNOT BE IN THE FIXTURE: a status tint. The page used
     to append '22' to a status colour in JavaScript, at render time, so the full
     eight-digit string never appeared anywhere in the file — only the six-digit
     base did. That is still exactly the colour the page produced, so it is
     allowed, but narrowly: the base has to be a colour the file had, and the
     alpha has to be the 0x22 the old code appended. */
  const runtime = [];
  const strays = [];
  for (const d of derived) {
    if (beforeColours.has(sameColour(d.value))) continue;
    const tinted = /^(#[0-9A-F]{6})22$/.exec(d.value);
    if (tinted && d.css.startsWith('status-') && beforeColours.has(tinted[1])) {
      runtime.push(d.css);
      continue;
    }
    strays.push(`--${d.css}: ${d.value}`);
  }
  assert.deepStrictEqual(strays, [],
    'a derived alpha is not a colour the stylesheet drew — the alpha or the base is wrong');

  /* And the exception reaches the status badges and nothing else. Not every
     status needs it: the two Feedbacks states are #E8402C, whose 0x22 tint was
     also written out by hand elsewhere, so they matched on the ordinary path.
     Which ones land here is an accident of how the old file was typed, so what
     is asserted is that they are all statuses and that the exception is in use
     at all — the loop above is what keeps it narrow. */
  const statusCss = new Set(workflow.STATES.map((st) => `status-${st.id.replace(/_/g, '-')}`));
  assert.ok(runtime.length > 0, 'the runtime-tint exception is actually needed');
  for (const css of runtime) {
    assert.ok(statusCss.has(css), `${css} took the status exception but is not a status`);
  }
});

test('the generated defaults block in the page matches the catalogue', () => {
  /* The page carries the whole default palette so it renders with no server, no
     database and no request. Generated by scripts/build-theme-defaults.js; this
     is the failure that tells somebody to run it. */
  const open = '<style id="themeDefaults">';
  const at = PAGE.indexOf(open);
  assert.ok(at !== -1);
  const end = PAGE.indexOf('</style>', at);
  const block = PAGE.slice(at + open.length, end);
  assert.ok(block.includes(theme.cssFor()),
    'public/index.html carries a stale defaults block — run: node scripts/build-theme-defaults.js');
});

test('with nothing saved, the generated CSS is exactly the defaults', () => {
  assert.strictEqual(theme.cssFor({}), theme.cssFor());
  const css = theme.cssFor();
  for (const tok of theme.all()) {
    assert.ok(css.includes(`--${tok.css}:${tok.default};`),
      `${tok.key} is missing from the generated CSS`);
  }
});

test('every old :root variable that survives still holds its old value', () => {
  /* The CSS property names are the ones the page already used, which is what
     kept 791 var() uses from needing an edit. A property that survived must not
     have quietly changed value. */
  const byCss = new Map(theme.all().map((t) => [t.css, t]));
  const checked = [];
  for (const [name, old] of Object.entries(BEFORE.rootVars)) {
    const tok = byCss.get(name);
    if (!tok) continue;                      // renamed or retired — covered elsewhere
    assert.strictEqual(tok.default, old.toUpperCase(),
      `--${name} shipped as ${old} and the token now defaults to ${tok.default}`);
    checked.push(name);
  }
  assert.ok(checked.length >= 15,
    `most of the old palette should still be recognisable (${checked.length} matched)`);
});

// ===========================================================================
// 2. THE CATALOGUE, AND THE STATUS FALLBACK.
// ===========================================================================

/* A TOKEN NOTHING READS IS A CONTROL THAT DOES NOTHING, which is worse than a
   missing one: an admin changes the Toast background, saves, sees no difference
   and concludes the whole screen is broken. Three shipped that way on the first
   pass — the placeholder, the toast and the stat-tile border all had a token
   whose default matched the colour on screen while the rule went on reading the
   property next door — and one of the three had a default that was not even the
   right colour, which nothing else could have caught: --toast said #262A33
   while .toast drew var(--surface-3), #30343E. */
test('every token actually controls something on the page', () => {
  const at = PAGE.indexOf('<style id="themeDefaults">');
  const end = PAGE.indexOf('</style>', at);
  const body = PAGE.slice(0, at) + PAGE.slice(end);   // everything but the defaults
  const read = new Set([...body.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]));

  const dead = [];
  for (const tok of theme.all()) {
    /* A DERIVATION BASE COUNTS AS READ through its alphas: --shadow is never
       drawn opaque, only as --shadow-t28 and its five siblings, and editing the
       base moves all six. */
    if (read.has(tok.css)) continue;
    if (Object.keys(tok.alphas || {}).some((suffix) => read.has(`${tok.css}-${suffix}`))) continue;
    dead.push(`${tok.key} (--${tok.css})`);
  }
  assert.deepStrictEqual(dead, [],
    'a token is offered in Settings that no rule reads — either wire it up or drop it');

  /* And the status tints, which no rule can name because statusTint() builds the
     property name at render time. Asserted through the helper instead. */
  assert.match(PAGE, /function statusTint\(colour\)\{[\s\S]*?var\(--\$\{ref\[1\]\}-t22\)/,
    'the status pill tint is derived from the status token, not concatenated');
});

test('the catalogue is complete and internally consistent', () => {
  const all = theme.all();
  assert.ok(all.length > 100, `${all.length} tokens`);
  assert.strictEqual(new Set(all.map((t) => t.key)).size, all.length, 'keys are unique');
  assert.strictEqual(new Set(all.map((t) => t.css)).size, all.length, 'CSS names are unique');
  for (const tok of all) {
    assert.ok(tok.key && tok.css && tok.label && tok.group && tok.default && tok.describe,
      `${tok.key} is missing a field`);
    assert.ok(tokens.GROUPS.includes(tok.group), `${tok.key} is in an unlisted group "${tok.group}"`);
    const checked = tokens.canonical(tok.default);
    assert.ok(!checked.error, `${tok.key}'s default is not a colour`);
    assert.strictEqual(checked.value, tok.default, `${tok.key}'s default is not canonical`);
    if (checked.alpha) assert.ok(tok.alpha, `${tok.key} has an alpha default but does not allow alpha`);
  }
  // Every group the brief named is covered.
  for (const group of ['Navigation tabs', 'Sub-tabs', 'Surfaces', 'Text', 'Buttons', 'Forms',
    'Tables', 'Meaning', 'Workflow statuses', 'Charts and tiles', 'Sign-in']) {
    assert.ok(all.some((t) => t.group === group), `no tokens in "${group}"`);
  }
});

test('a status with no colour of its own falls back to a defined grey', () => {
  /* THE BRIEF'S OWN REQUIREMENT, and the reason the status tokens are generated
     from the pipeline's list rather than written out: a status added next year
     must appear in Settings as a grey anybody can change, not as an invisible
     column. */
  const made = tokens.statusTokens([
    { id: 'brand_new_stage', label: 'Brand New Stage' },
    { id: 'in_progress', label: 'In Progress' },
  ]);
  assert.strictEqual(made[0].css, 'status-brand-new-stage');
  assert.strictEqual(made[0].default, tokens.STATUS_FALLBACK);
  assert.ok(!tokens.canonical(tokens.STATUS_FALLBACK).error, 'and the fallback is a real colour');
  assert.strictEqual(made[1].default, '#F2B33D', 'a known status keeps its own');
  assert.strictEqual(made[0].group, 'Workflow statuses', 'and it lands in Settings');

  // Every real status has an entry, so none is relying on the fallback today.
  for (const tok of tokens.statusTokens(workflow.STATES)) {
    assert.notStrictEqual(tok.default, tokens.STATUS_FALLBACK,
      `${tok.key} has no colour of its own — add it to STATUS_DEFAULTS`);
  }
});

test('the pipeline and the page name the same status colours', () => {
  /* The two status lists have always had to agree (tests/asset-workflow.test.js
     holds them together); now they agree by both pointing at the same token. */
  const pageList = PAGE.slice(PAGE.indexOf('const STATUSES = ['), PAGE.indexOf('];', PAGE.indexOf('const STATUSES = [')));
  for (const state of workflow.STATES) {
    const css = `var(--status-${state.id.replace(/_/g, '-')})`;
    assert.strictEqual(state.color, css, `the server has ${state.id} as ${state.color}`);
    assert.ok(pageList.includes(`color:'${css}'`), `the page has ${state.id} as something else`);
  }
});

// ===========================================================================
// 3. VALIDATION, AND THE INJECTION CASES.
// ===========================================================================

test('#RGB expands, and canonical form is uppercase six digits', () => {
  assert.deepStrictEqual(theme.validate({ 'surface.page': '#abc' }).values, { 'surface.page': '#AABBCC' });
  assert.deepStrictEqual(theme.validate({ 'surface.page': '  #1d2027  ' }).values, { 'surface.page': '#1D2027' });
  assert.deepStrictEqual(theme.validate({ 'surface.page': '#1D2027' }).values, { 'surface.page': '#1D2027' });
});

test('every injection shape is refused by name, and nothing is stored', () => {
  const nasty = [
    'red; } body { display:none',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '#fff; background:url(//evil/x)',
    'var(--bg)',
    '#1D2027 !important',
    'rgb(255,0,0)',
    'red',
    'transparent',
    '#12345',                           // five digits
    '#1234567',                         // seven
    '#GGGGGG',
    '#ＡＢＣ',         // full-width lookalikes
    '#1D2027\u0000',
    `#${'A'.repeat(5000)}`,
    '',
    null,
    undefined,
    0,
    {},
    [],
    true,
  ];
  for (const value of nasty) {
    const out = theme.validate({ 'surface.page': value });
    assert.strictEqual(out.ok, false, `accepted ${JSON.stringify(value)}`);
    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.errors[0].token, 'surface.page', 'and names which colour');
    assert.match(out.errors[0].message, /Page background/, 'by its label, not its key');
  }
});

test('an unknown token is refused, and named', () => {
  const out = theme.validate({ 'surface.page': '#1D2027', 'not.a.token': '#FFFFFF' });
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.errors.map((e) => e.token), ['not.a.token']);
  assert.match(out.errors[0].message, /not a colour this application has/);
  // Every error, not just the first: an imported file with four bad values says so once.
  const many = theme.validate({ a: '#fff', b: '#fff', 'surface.page': 'nope' });
  assert.strictEqual(many.errors.length, 3);
});

test('alpha is allowed only where the token is an overlay or a shadow', () => {
  const overlay = theme.all().find((t) => t.alpha);
  assert.ok(overlay, 'some token allows alpha');
  assert.strictEqual(theme.validate({ [overlay.key]: '#11223344' }).ok, true);
  const solid = theme.all().find((t) => !t.alpha);
  const out = theme.validate({ [solid.key]: '#11223344' });
  assert.strictEqual(out.ok, false);
  assert.match(out.errors[0].message, /cannot be transparent/);

  /* AND THE RULE IS THE DOCUMENTED ONE: every alpha-allowing token is an
     overlay, a shadow, or a background that was `transparent` to begin with.
     Asserted so that "alpha only on overlays" stays true rather than becoming
     "alpha wherever somebody needed it". */
  for (const tok of theme.all().filter((t) => t.alpha)) {
    assert.match(`${tok.key} ${tok.describe}`,
      /overlay|shadow|scrim|veil|Transparent|transparent|sunk|hairline|indicator|badge/i,
      `${tok.key} allows alpha and is not an overlay, a shadow or a transparent background`);
  }
});

test('the generated CSS cannot be made to contain anything but declarations', () => {
  /* THE BELT TO THE BRACES. validate() refuses a bad value, and cssFor()
     re-validates on the way OUT of the database — so a row edited by hand, or
     restored from a backup taken before any of this existed, still cannot put a
     brace into a stylesheet. */
  const poisoned = {
    'surface.page': 'red; } body { display:none; } :root { --x:',
    'surface.panel': 'url(javascript:1)',
    'not.a.token': '} * { display:none } ',
  };
  const css = theme.cssFor(poisoned);
  assert.strictEqual(css.indexOf('}'), css.length - 1, 'exactly one closing brace, at the end');
  assert.strictEqual((css.match(/\{/g) || []).length, 1, 'and exactly one opening brace');
  assert.ok(!/javascript|expression|url\(|display/.test(css));
  assert.ok(css.includes(`--bg:${theme.defaults()['surface.page']};`),
    'the poisoned token fell back to its default');
  assert.ok(!css.includes('not.a.token') && !css.includes('--not-a-token'));
});

test('the size cap is a number the route can enforce', () => {
  assert.strictEqual(typeof tokens.MAX_BODY_BYTES, 'number');
  assert.ok(tokens.MAX_BODY_BYTES > 4096 && tokens.MAX_BODY_BYTES < 1024 * 1024);
  /* A full theme has to fit inside it with room to spare, or the cap would
     refuse a legitimate save. */
  const full = JSON.stringify(theme.defaults());
  assert.ok(Buffer.byteLength(full) * 4 < tokens.MAX_BODY_BYTES,
    `a whole theme is ${Buffer.byteLength(full)} bytes against a cap of ${tokens.MAX_BODY_BYTES}`);
});

// ===========================================================================
// 4. CONTRAST.
// ===========================================================================

test('the contrast figures are right for colours with known ratios', () => {
  /* CHECKED AGAINST THE FORMULA, not against itself. Black on white is 21:1 by
     definition. #767676 on white is the pair WCAG's own notes use as the
     borderline AA case, and 4.5422 is where it lands. The last two were computed
     independently from WCAG 2.1's relative-luminance definition rather than
     taken from this module, which is the point of asserting them. */
  assert.strictEqual(theme.contrast('#000000', '#FFFFFF'), 21);
  assert.strictEqual(theme.contrast('#FFFFFF', '#000000'), 21, 'and it is symmetric');
  assert.strictEqual(theme.contrast('#FFFFFF', '#FFFFFF'), 1);
  assert.strictEqual(theme.contrast('#767676', '#FFFFFF'), 4.54);     // 4.5422…
  assert.strictEqual(theme.contrast('#EF6B6F', '#14161B'), 6.03);     // 6.0351…
  assert.strictEqual(theme.contrast('#EDEFF2', '#14161B'), 15.71);    // 15.7107…

  /* ROUNDED DOWN, deliberately: a pair computing to 4.4999 must never be
     reported as 4.5, because the figure is a floor on what the viewer gets. */
  assert.strictEqual(theme.contrast('#8B909C', '#262A33'), 4.49);     // 4.4937…
});

test('a translucent colour is measured over the page background', () => {
  /* A ratio against something see-through is a ratio against nothing anybody
     sees. #FFFFFF at half opacity over black is mid-grey, and that is what the
     figure has to be about. */
  const overBlack = theme.contrast('#FFFFFF80', '#000000', '#000000');
  const grey = theme.contrast('#808080', '#000000', '#000000');
  assert.ok(Math.abs(overBlack - grey) < 0.3,
    `half-opaque white over black (${overBlack}) should read like grey (${grey})`);
  // And the backdrop matters: the same colour over white is far lighter.
  assert.ok(theme.contrast('#FFFFFF80', '#000000', '#FFFFFF') > overBlack);
});

test('the pairs that matter are all checked', () => {
  const labels = theme.ratios({}).map((r) => r.label);
  for (const want of [
    /Inactive tab label/, /Active tab label/, /Tab label under the pointer/,
    /Active sub-tab label/, /Primary button label/, /Secondary button label/,
    /Destructive action label/, /Body text on the page/, /A link on the page/,
    /Placeholder inside a field/, /Sign-in refusal/,
  ]) {
    assert.ok(labels.some((l) => want.test(l)), `no pair for ${want}`);
  }
  // One per status badge, generated like the tokens.
  for (const state of workflow.STATES) {
    assert.ok(labels.some((l) => l === `${state.label} badge`), `no badge pair for ${state.id}`);
  }
  for (const row of theme.ratios({})) {
    assert.ok(row.required === theme.AA_NORMAL || row.required === theme.AA_LARGE);
    assert.strictEqual(row.passes, row.ratio >= row.required);
    assert.strictEqual(row.severe, row.ratio < theme.AA_LARGE);
  }
});

test('the focus ring cannot be saved into its own background without a warning', () => {
  assert.deepStrictEqual(theme.focusRingWarnings({}), [],
    'the shipped ring is visible on every surface it is drawn on');
  const vanished = theme.focusRingWarnings({ 'nav.focus.ring': theme.defaults()['surface.page'] });
  assert.ok(vanished.length >= 1, 'a ring the colour of the page is warned about');
  assert.ok(vanished.every((w) => w.severe), 'and severely — keyboard users lose the application');
  assert.match(vanished[0].label, /Focus ring/);
});

test('the shipped palette has three pairs below 3:1, and that is a finding', () => {
  /* NOT INTRODUCED BY THIS CHANGE — these are the colours the application has
     always drawn, and the editor now says so. They are listed here so the number
     cannot creep up unnoticed, and so the confirmation the editor asks for can
     tell "you made this unreadable" apart from "this always was". */
  const severe = theme.warningsFor({}).filter((w) => w.severe).map((w) => w.label).sort();
  assert.deepStrictEqual(severe, [
    'Muted text on a panel',
    'Placeholder inside a field',
    'Sub-tab counter',
  ]);
});

// ===========================================================================
// 5. THE PAGE, lifted out and run against a stub.
// ===========================================================================

function themeHarness({ permissions = ['settings.theme'], api: override = null } = {}) {
  const from = PAGE.indexOf('let THEME_VERSION = null;');
  const to = PAGE.indexOf("/* ---------- settings: where the studio's email goes out from");
  assert.ok(from !== -1 && to > from, 'the theme runtime is in the page');
  const source = PAGE.slice(from, to);

  const calls = { api: [], toasts: [], confirms: [] };
  const styles = {};
  const head = { appendChild(el) { styles[el.id] = el; } };
  const nodes = {};
  /* A NODE THE STUB CAN FIND AGAIN. appendChild registers whatever it is given by
     id, and so does an element's own appendChild, because the banner is a div
     with a button inside it and the test has to be able to click the button. */
  const register = (el) => { if (el && el.id) nodes[el.id] = el; };
  const body = { appendChild: register };
  const document = {
    head,
    body,
    getElementById: (id) => styles[id] || nodes[id] || null,
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), textContent: '', id: '', className: '',
        innerHTML: '', type: '', children: [], listeners: {},
        remove() { delete styles[this.id]; delete nodes[this.id]; },
        appendChild(child) { this.children.push(child); register(child); return child; },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        click() { if (this.listeners.click) this.listeners.click(); },
        querySelectorAll: () => [], style: {} };
      return el;
    },
    querySelectorAll: () => [],
  };
  const api = override || (async (path, options = {}) => {
    calls.api.push(`${(options.method || 'GET')} ${path}`);
    if (path === '/theme') return { version: 7, values: { 'surface.page': '#102030' } };
    if (path === '/theme.css') return ':root{--bg:#102030;}';
    if (path === '/theme/editor') {
      return {
        groups: tokens.GROUPS,
        tokens: theme.all().map((t) => ({ key: t.key, css: t.css, label: t.label, group: t.group,
          default: t.default, describe: t.describe, alpha: Boolean(t.alpha) })),
        values: {}, version: 0, contrast: theme.ratios({}),
        severeByDefault: theme.warningsFor({}).filter((w) => w.severe).map((w) => w.label),
        history: [], presets: [], limits: { maxPresets: 12, historyLimit: 20 },
      };
    }
    throw new Error(`unexpected ${path}`);
  });

  const built = new Function(
    'document', 'api', 'can', 'escapeHTML', 'showToast', 'window', 'state', 'Blob', 'URL',
    `${source}
     return { applyThemeVersion, refreshTheme, themeShowPreview, themeCancelPreview,
       themeCss, themeLearnCatalogue, themeBannerSync, themeStyleEl,
       styleOf: (id) => document.getElementById(id),
       preview: () => THEME_PREVIEW, versionNow: () => THEME_VERSION,
       setVersion: (v) => { THEME_VERSION = v; } };`
  )(
    document, api,
    (...keys) => keys.some((k) => permissions.includes(k)),
    (s) => String(s === null || s === undefined ? '' : s),
    (t) => calls.toasts.push(t),
    { confirm: (q) => { calls.confirms.push(q); return true; }, addEventListener() {} },
    {},
    function Blob() {}, { createObjectURL: () => '', revokeObjectURL() {} },
  );
  return { ...built, calls, styles };
}

test('a theme version change on /auth/me re-applies the theme', async () => {
  const h = themeHarness();
  h.setVersion(3);                       // what the injected block was built from
  await h.applyThemeVersion(3);
  assert.deepStrictEqual(h.calls.api, [], 'an unchanged version costs nothing');

  await h.applyThemeVersion(4);
  assert.ok(h.calls.api.includes('GET /theme.css'), 'a changed version fetches the stylesheet');
  assert.strictEqual(h.styleOf('themeSaved').textContent, ':root{--bg:#102030;}',
    'and applies it');
});

test('the first load does not refetch what it was served', async () => {
  /* The page ARRIVES wearing the theme, so the first /auth/me must not throw
     away a block the server already built and ask for it again. */
  const h = themeHarness();
  await h.applyThemeVersion(9);
  assert.deepStrictEqual(h.calls.api, [], 'the injected block is already that version');
  assert.strictEqual(h.versionNow(), 9, 'but the version is remembered');
});

test('a failed theme fetch falls back to the defaults, never to nothing', async () => {
  /* THE WORST CASE IS NOT A WRONG COLOUR, it is a page with no colours at all.
     The saved block is the only thing a failed fetch is allowed to touch, and
     emptying it leaves the generated defaults block as the whole palette — which
     is what the application shipped with. */
  const good = themeHarness();
  good.setVersion(1);
  await good.applyThemeVersion(2);
  assert.strictEqual(good.styleOf('themeSaved').textContent, ':root{--bg:#102030;}',
    'first, a fetch that works');

  const h = themeHarness({ api: async () => { throw new Error('502 from the proxy'); } });
  h.setVersion(1);
  const ok = await h.refreshTheme();
  assert.strictEqual(ok, false, 'the failure is reported, not swallowed into success');
  assert.strictEqual(h.styleOf('themeSaved').textContent, '',
    'and the saved block is emptied, which hands the page back to the defaults');

  /* AND THE SAME IF IT HAPPENS MID-SESSION, with a theme already applied: the
     block must not be left holding half a stylesheet. */
  const mid = themeHarness();
  mid.setVersion(1);
  await mid.applyThemeVersion(2);
  assert.ok(mid.styleOf('themeSaved').textContent.length > 0);
  const broken = themeHarness({ api: async () => { throw new Error('network'); } });
  broken.setVersion(5);
  broken.themeStyleEl().textContent = ':root{--bg:#102030;}';
  await broken.applyThemeVersion(6);
  assert.strictEqual(broken.styleOf('themeSaved').textContent, '',
    'a version change that cannot be fetched clears rather than keeps the stale sheet');
});

test('the preview applies, and Cancel removes it rather than reconstructing it', () => {
  const h = themeHarness();
  h.themeLearnCatalogue(theme.all().map((t) => ({ key: t.key, css: t.css, alpha: Boolean(t.alpha) })));
  assert.strictEqual(h.preview(), null);

  h.themeShowPreview({ 'surface.page': '#FF0000', 'text.primary': '#00FF00' });
  const block = h.styleOf('themePreview').textContent;
  assert.match(block, /--bg:#FF0000;/);
  assert.match(block, /--ink:#00FF00;/);
  assert.ok(h.preview(), 'and the banner knows');

  h.themeCancelPreview();
  assert.strictEqual(h.styleOf('themePreview').textContent, '',
    'Cancel empties the preview block');
  assert.strictEqual(h.preview(), null);
  /* AND THE SAVED BLOCK IS UNTOUCHED THROUGHOUT. The preview is a third style
     element precisely so that Cancel is a removal and not a reconstruction —
     which is the difference between a Cancel that always works and one that
     works until somebody saves while the preview is open. */
  assert.ok(!h.styleOf('themeSaved') || h.styleOf('themeSaved').textContent === '');
});

test('the browser refuses the same values the server refuses', () => {
  const h = themeHarness();
  h.themeLearnCatalogue(theme.all().map((t) => ({ key: t.key, css: t.css, alpha: Boolean(t.alpha) })));
  const css = h.themeCss({
    'surface.page': 'red; } body { display:none',
    'text.primary': '#00FF00',
    'not.a.token': '#FFFFFF',
    'surface.panel': '#11223344',          // alpha on a solid token
  });
  assert.match(css, /--ink:#00FF00;/, 'the good one is written');
  assert.ok(!css.includes('display:none') && !css.includes('--bg'), 'the bad one is not');
  assert.ok(!css.includes('not-a-token'));
  assert.ok(!css.includes('--surface:'), 'and nor is alpha on a token that forbids it');
});

test('the Theme section is gated on the permission, never on the tier', () => {
  const render = PAGE.slice(PAGE.indexOf('async function renderThemeSection()'));
  const body = render.slice(0, render.indexOf('\nfunction themeSectionHTML('));
  assert.match(body, /can\('settings\.theme'\)/);
  assert.ok(!/caps\(/.test(body), 'caps() is the tier, and a permission is not a tier');

  // Both directions, through the page's own gate.
  const section = PAGE.slice(PAGE.indexOf("    ${can('settings.theme') ? '<div id=\"themeSection\"></div>'"));
  assert.match(section.slice(0, 200), /can\('settings\.theme'\)/);
  assert.match(PAGE, /if\(can\('settings\.theme'\)\) renderThemeSection\(\);/);
});

test('the Theme section\'s own controls ignore the theme', () => {
  /* THE SAFETY FEATURE. A theme that made the text the colour of the page would
     otherwise make the screen you need to fix it unreadable. */
  const panel = PAGE.slice(PAGE.indexOf('function themeSectionHTML()'), PAGE.indexOf('function themeSampleHTML'));
  assert.match(panel, /class="theme-safe"/, 'the panel is on the fixed palette');
  assert.ok(!/var\(--/.test(panel), 'and reads no token at all');

  const start = PAGE.indexOf('/* THEME-SAFE-BLOCK:START');
  const end = PAGE.indexOf('/* THEME-SAFE-BLOCK:END */');
  const css = PAGE.slice(start, end);
  assert.ok(!/var\(--/.test(css), 'and neither does its stylesheet');
  assert.match(css, /#[0-9A-Fa-f]{6}/, 'it states its colours outright');

  // The revert control lives inside it, which is the point.
  assert.match(PAGE, /data-theme-revert=/);
  const history = PAGE.slice(PAGE.indexOf('function themeHistoryHTML()'));
  assert.match(history.slice(0, history.indexOf('\n}')), /theme-safe-btn/,
    'the revert button is drawn on the fixed palette');
});

test('the contrast warning and the below-3:1 confirmation are both in the page', () => {
  const panel = PAGE.slice(PAGE.indexOf('function themeSectionHTML()'), PAGE.indexOf('function themeGroupHTML'));
  assert.match(panel, /below 3:1/, 'the severe warning names the level');
  assert.match(panel, /recommended against/, 'and says it is recommended against');
  assert.match(panel, /4\.5:1 WCAG AA level/, 'and the AA level is named too');

  const put = PAGE.slice(PAGE.indexOf('async function themePut('));
  const body = put.slice(0, put.indexOf('\nasync function themeAfterWrite('));
  assert.match(body, /requiresConfirmation/, 'the 409 is handled');
  /* ASKED IN THE PAGE NOW, not with window.confirm. Electron throws on prompt()
     and blocks the renderer on confirm(), so every native dialog in this file was
     replaced by the shared openAsk() modal — see tests/no-native-dialogs.test.js,
     which fails the build if one comes back. The claim here is unchanged: the
     severe-contrast 409 is answered by ASKING rather than by giving up. */
  assert.match(body, /await askConfirm\(/, 'by asking');
  assert.match(body, /Save anyway/, 'and the question says what saying yes does');
  assert.match(body, /themePut\(values, true\)/, 'and re-sending with the confirmation');
});

test('unsaved colours warn before leaving, by both routes out', () => {
  assert.match(PAGE, /window\.addEventListener\('beforeunload'/, 'leaving the page');
  const setTab = PAGE.slice(PAGE.indexOf('function setTab(tab){'));
  assert.match(setTab.slice(0, 900), /themeDirty\(\)/, 'and leaving the tab');
  assert.match(setTab.slice(0, 900), /unsaved colours/i);
});

// ===========================================================================
// 6. AGAINST A LIVE SERVER.
// ===========================================================================

test('the theme, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const site = () => server.base.replace(/\/api$/, '');

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'theme-boot' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'theme-boot', name: 'Root', email: 'root@theme.test', password: PASSWORD } });
    tok.root = await login('root@theme.test');
    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Ana', email: 'ana@theme.test', role: 'game_artist', password: PASSWORD } });
    id.ana = r.body.user.id;
    tok.ana = await login('ana@theme.test');
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('reading it needs no session at all', async () => {
    const r = await api(server.base, '/theme');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['values', 'version'],
      'and returns only the token values and the version — nothing else lives here');
    assert.strictEqual(r.body.version, 0);
    assert.deepStrictEqual(r.body.values, {});
  });

  await t.test('the stylesheet carries cache headers and an ETag', async () => {
    const r = await raw(site(), '/api/theme.css');
    assert.strictEqual(r.status, 200);
    assert.match(r.contentType, /text\/css/);
    assert.ok(r.text.startsWith(':root{'), 'and is a stylesheet');
    assert.strictEqual(r.text, theme.cssFor(), 'exactly the defaults, with nothing saved');
  });

  await t.test('the page arrives already wearing the theme', async () => {
    const r = await raw(site(), '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('<style id="themeDefaults">'), 'the defaults are in the page');
    assert.ok(r.text.includes('<style id="themeSaved">'), 'and so is the saved block');
    assert.ok(!r.text.includes('THEME:INJECT'), 'the marker is consumed');
    /* THE ORDER IS THE WHOLE MECHANISM: the saved block has to come after the
       defaults, or a saved colour would lose to its own default. */
    assert.ok(r.text.indexOf('<style id="themeSaved">') > r.text.indexOf('<style id="themeDefaults">'));
    // And /index.html, which express.static would otherwise have answered.
    const direct = await raw(site(), '/index.html');
    assert.ok(direct.text.includes('<style id="themeSaved">'));
  });

  await t.test('403 without the key, and success on the same token after a grant', async () => {
    const refused = await as('ana', '/theme', { method: 'PUT', body: { values: { 'surface.page': '#101010' } } });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual((await as('ana', '/theme/editor')).status, 403, 'and the editor too');

    const held = (await as('root', '/permissions/roles/game_artist')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    const grant = await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'settings.theme'] } });
    assert.ok(grant.status < 400, JSON.stringify(grant.body));

    /* THE SAME TOKEN, with no sign-out: permissions are resolved per request
       from the role, which is what makes a grant take effect inside the
       twenty-second poll rather than at the next sign-in. */
    const allowed = await as('ana', '/theme/editor');
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual((await as('ana', '/theme', { method: 'PUT',
      body: { values: { 'surface.page': '#101010' } } })).status, 200);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: held } });
    await as('root', '/theme', { method: 'PUT', body: { values: {} } });   // back to defaults
  });

  await t.test('a save normalises, increments the version and writes an audit line', async () => {
    const before = (await api(server.base, '/theme')).body.version;
    /* A READABLE PAIR ON PURPOSE. `#abc` would be a pale page behind pale text,
       which the server rightly refuses without a confirmation — that path is
       subtest 9. This one is about normalising and recording, so the colours are
       a shade of the ones already there: `#1a1c22` proves the uppercasing and
       `#eee` proves a three-digit value expands. */
    const r = await as('root', '/theme', { method: 'PUT',
      body: { values: { 'surface.page': '#1a1c22', 'text.primary': '#eee' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.values['surface.page'], '#1A1C22', 'uppercased');
    assert.strictEqual(r.body.values['text.primary'], '#EEEEEE', 'and expanded');
    assert.strictEqual(r.body.version, before + 1);
    assert.ok(Array.isArray(r.body.contrast) && r.body.contrast.length > 20,
      'and the server returns the ratios it computed');

    const changed = r.body.changed.find((c) => c.token === 'surface.page');
    assert.ok(changed && changed.from === '#14161B' && changed.to === '#1A1C22',
      'old and new, per token');

    const log = await sql(cfg,
      "SELECT actor_email, summary, changes FROM activity_log WHERE action = 'theme.updated' ORDER BY seq DESC LIMIT 1");
    assert.strictEqual(log.length, 1, 'the change is in the Activity Log');
    assert.strictEqual(log[0].actor_email, 'root@theme.test', 'naming who');
    assert.match(log[0].summary, /Changed 2 colours/);
    const diff = JSON.parse(log[0].changes);
    assert.strictEqual(diff['surface.page'].from, '#14161B', 'with the old value');
    assert.strictEqual(diff['surface.page'].to, '#1A1C22', 'and the new one');

    // The version moved, so the ETag moved with it.
    const css = await raw(site(), '/api/theme.css');
    assert.ok(css.text.includes('--bg:#1A1C22;'));
    const json = await api(server.base, '/theme');
    assert.strictEqual(json.body.version, before + 1);
  });

  await t.test('the ETag changes on update, and a matching one gets a 304', async () => {
    const first = await raw(site(), '/api/theme.css');
    const etag = (await fetch(`${site()}/api/theme.css`)).headers.get('etag');
    assert.ok(etag, 'an ETag is sent');
    const again = await fetch(`${site()}/api/theme.css`, { headers: { 'If-None-Match': etag } });
    assert.strictEqual(again.status, 304, 'and honoured');

    await as('root', '/theme', { method: 'PUT', body: { values: { 'surface.page': '#010203' } } });
    const after = (await fetch(`${site()}/api/theme.css`)).headers.get('etag');
    assert.notStrictEqual(after, etag, 'and it changes when the theme does');
    const stale = await fetch(`${site()}/api/theme.css`, { headers: { 'If-None-Match': etag } });
    assert.strictEqual(stale.status, 200, 'so a stale cache gets the new sheet');
    void first;
  });

  await t.test('/auth/me carries the version, so an open screen notices', async () => {
    const me = await as('root', '/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(typeof me.body.themeVersion, 'number');
    assert.strictEqual(me.body.themeVersion, (await api(server.base, '/theme')).body.version);
  });

  await t.test('invalid values, unknown tokens and oversized payloads store nothing', async () => {
    const was = (await api(server.base, '/theme')).body;
    for (const body of [
      { values: { 'surface.page': 'red; } body { display:none' } },
      { values: { 'surface.page': 'url(javascript:1)' } },
      { values: { 'surface.page': 'expression(1)' } },
      { values: { 'surface.page': `#${'A'.repeat(9000)}` } },
      { values: { 'nope.nope': '#FFFFFF' } },
      { values: { 'surface.page': '#11223344' } },
    ]) {
      const r = await as('root', '/theme', { method: 'PUT', body });
      assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(r.body.errors && r.body.errors[0].token, 'and names the token');
    }
    const huge = {};
    for (let i = 0; i < 4000; i += 1) huge[`k${i}`] = '#FFFFFF';
    const big = await as('root', '/theme', { method: 'PUT', body: { values: huge } });
    assert.strictEqual(big.status, 400);
    assert.match(big.body.error, /bytes|not a colour this application has/);

    const now = (await api(server.base, '/theme')).body;
    assert.deepStrictEqual(now, was, 'and nothing was stored by any of it');
  });

  await t.test('a severe pair needs a confirmation, and the server reports the ratios', async () => {
    const unreadable = { 'text.primary': '#141619', 'surface.page': '#14161B' };
    const refused = await as('root', '/theme', { method: 'PUT', body: { values: unreadable } });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.requiresConfirmation, true);
    assert.match(refused.body.error, /below 3:1/);
    assert.match(refused.body.error, /recommended against/);
    assert.ok(refused.body.severe.some((w) => /Body text on the page/.test(w.label)));

    const confirmed = await as('root', '/theme', { method: 'PUT',
      body: { values: unreadable, confirmLowContrast: true } });
    assert.strictEqual(confirmed.status, 200, 'and goes through when confirmed');
    /* THE SERVER'S FIGURES, not the browser's, which is the point of computing
       them here: the same numbers come back whether or not anybody looked. */
    const pair = confirmed.body.contrast.find((r) => r.label === 'Body text on the page');
    assert.ok(pair.ratio < 3 && !pair.passes && pair.severe);
    assert.strictEqual(pair.ratio, theme.contrast('#141619', '#14161B', '#14161B'));
  });

  await t.test('revert restores a previous theme, as a new version', async () => {
    const editor = await as('root', '/theme/editor');
    assert.ok(editor.body.history.length >= 2, 'the history has something to go back to');
    const target = editor.body.history[1];
    const back = await as('root', '/theme/revert', { method: 'POST', body: { version: target.version } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    assert.ok(back.body.version > target.version,
      'the version only ever goes up, so every cache notices');

    const atTarget = await sql(cfg,
      'SELECT values_json FROM studio_theme_history WHERE version = ? LIMIT 1', [target.version]);
    assert.deepStrictEqual(back.body.values, JSON.parse(atTarget[0].values_json));

    const log = await sql(cfg,
      "SELECT summary FROM activity_log WHERE action = 'theme.reverted' ORDER BY seq DESC LIMIT 1");
    assert.match(log[0].summary, new RegExp(`Reverted the theme to version ${target.version}`));

    const missing = await as('root', '/theme/revert', { method: 'POST', body: { version: 9999 } });
    assert.strictEqual(missing.status, 404);
  });

  await t.test('the history is capped at twenty', async () => {
    for (let i = 0; i < 6; i += 1) {
      await as('root', '/theme', { method: 'PUT', body: { values: { 'surface.page': `#0000${i}${i}` } } });
    }
    const rows = await sql(cfg, 'SELECT COUNT(*) AS n FROM studio_theme_history');
    assert.ok(Number(rows[0].n) <= tokens.HISTORY_LIMIT,
      `${rows[0].n} history rows against a limit of ${tokens.HISTORY_LIMIT}`);
    const editor = await as('root', '/theme/editor');
    assert.ok(editor.body.history.length <= tokens.HISTORY_LIMIT);
  });

  await t.test('presets go through the same validation, and are bounded', async () => {
    const bad = await as('root', '/theme/presets', { method: 'POST',
      body: { name: 'Nope', values: { 'surface.page': 'red; }' } } });
    assert.strictEqual(bad.status, 400, 'a preset is a theme; there is no second rule');

    const saved = await as('root', '/theme/presets', { method: 'POST',
      body: { name: 'House Style', values: { 'surface.page': '#0A0A0A' } } });
    assert.strictEqual(saved.status, 201, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.presets.length, 1);
    assert.deepStrictEqual(saved.body.presets[0].values, { 'surface.page': '#0A0A0A' });

    const nameless = await as('root', '/theme/presets', { method: 'POST', body: { values: {} } });
    assert.strictEqual(nameless.status, 400);

    for (let i = 0; i < tokens.MAX_PRESETS; i += 1) {
      await as('root', '/theme/presets', { method: 'POST',
        body: { name: `Preset ${i}`, values: { 'surface.page': '#0B0B0B' } } });
    }
    const over = await as('root', '/theme/presets', { method: 'POST',
      body: { name: 'One Too Many', values: {} } });
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, new RegExp(String(tokens.MAX_PRESETS)));

    const list = (await as('root', '/theme/editor')).body.presets;
    const gone = await as('root', `/theme/presets/${list[0].id}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.body.presets.length, list.length - 1);
  });

  await t.test('the contrast endpoint answers for unsaved values', async () => {
    const r = await as('root', '/theme/contrast', { method: 'POST',
      body: { values: { 'text.primary': '#141619' } } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.warnings.some((w) => w.severe));
    const bad = await as('root', '/theme/contrast', { method: 'POST',
      body: { values: { 'text.primary': 'nope' } } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await as('ana', '/theme/contrast', { method: 'POST', body: { values: {} } })).status, 403);
  });

  await t.test('a hand-edited database row still cannot inject anything', async () => {
    /* THE LAST LINE OF DEFENCE. A row restored from a backup taken before this
       validation existed, or edited with a SQL client, has to be harmless. */
    await sql(cfg, 'UPDATE studio_theme SET values_json = ? WHERE id = 1',
      [JSON.stringify({ 'surface.page': 'red; } body { display:none', 'text.primary': '#00FF00' })]);
    await stopServer(server);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'theme-boot' });
    tok.root = await login('root@theme.test');

    const css = await raw(site(), '/api/theme.css');
    assert.ok(!css.text.includes('display:none'));
    assert.ok(css.text.includes('--ink:#00FF00;'), 'the good value survives');
    assert.ok(css.text.includes(`--bg:${theme.defaults()['surface.page']};`),
      'and the poisoned one falls back to its default');
    const page = await raw(site(), '/');
    assert.ok(!page.text.includes('display:none; } :root'));
  });
});
