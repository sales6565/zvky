/* The Dashboard's Art / Animation sub-tabs.
 *
 * WHAT THE SPLIT IS BUILT ON, established before any of it was written and recorded here
 * because the obvious guesses are all wrong:
 *
 *   `discipline` exists only as free text on freelancers.
 *   projects.category is drawn from project_categories, which ships EMPTY on purpose.
 *   milestone_types DOES hold exactly {art, animation} — but project_milestones joins a
 *     type to a PROJECT, never to an asset, so it cannot partition a board.
 *
 * That leaves assets.type, seeded from the asset_types reference table, where `animation`
 * is one of six values. So Animation is `type === 'animation'` and Art is everything else
 * — a decision, not a reading, and the test below says so out loud: asset_types is
 * editable in Settings, so a new type lands in Art without being asked.
 *
 * THE RISK THIS FILE IS REALLY ABOUT is the half-migrated filter — the shape behind the
 * canHandOverInReview gap. A lens applied to the cards but not to the counts, or applied
 * to a helper the Assets List shares, would look right on the screen somebody tested and
 * be wrong somewhere else. So the board is RENDERED here, with the page's own function
 * against a stub DOM, and the output is read.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* One declaration or function out of the page, evaluated here. The same mechanism
   tests/asset-workflow.test.js uses on visibleStatuses and tests/hold-permission.test.js
   on the Hold gate: the page is not a module, so the alternative is asserting on its text,
   which keeps passing when the code around it changes meaning. */
function grab(opener, closer = '\n}') {
  const at = PAGE.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener} in the page`);
  const rest = PAGE.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

const lensSource = grab('const BOARD_LENS = [', '\n];')
  + '\n' + grab('const BOARD_LENS_DEFAULT');

const lens = () => new Function(`${lensSource}; return { BOARD_LENS, BOARD_LENS_DEFAULT };`)();

// --- the field, and what each tab claims ------------------------------------

test('the two lenses partition every asset type, with nothing in both and nothing in neither', () => {
  const { BOARD_LENS } = lens();
  assert.deepStrictEqual(BOARD_LENS.map((l) => l.id), ['art', 'animation'],
    'two sub-tabs, Art first');
  assert.deepStrictEqual(BOARD_LENS.map((l) => l.label), ['Art', 'Animation']);

  /* Every type the studio ships with, plus one it does not — because asset_types is a
     reference table a Super Admin edits, and where an unknown type lands is the decision
     this split rests on. */
  const seeded = require('../src/reference-defaults').ASSET_TYPES.map((t) => t.key);
  assert.ok(seeded.includes('animation'), 'animation is a seeded asset type');
  assert.strictEqual(seeded.length, 6, 'six seeded types; a change here is a decision to re-read');

  for (const type of [...seeded, 'rigging', 'layout', '']) {
    const hits = BOARD_LENS.filter((l) => l.match({ type }));
    assert.strictEqual(hits.length, 1,
      `"${type}" must land in exactly one sub-tab, not ${hits.length}`);
  }

  // The named halves, explicitly.
  assert.ok(BOARD_LENS[1].match({ type: 'animation' }), 'Animation holds animation');
  assert.ok(!BOARD_LENS[0].match({ type: 'animation' }), 'and Art does not');
  for (const type of seeded.filter((t) => t !== 'animation')) {
    assert.ok(BOARD_LENS[0].match({ type }), `Art holds ${type}`);
    assert.ok(!BOARD_LENS[1].match({ type }), `and Animation does not hold ${type}`);
  }

  /* THE INFERENCE, pinned so changing it is deliberate: a type the studio adds later is
     Art. If that stops being right, the fix is a discipline flag on asset_types — not a
     longer list of strings in this file. */
  assert.ok(BOARD_LENS[0].match({ type: 'rigging' }),
    'a type added in Settings lands in Art — see the note on BOARD_LENS');

  // Nothing here reads anything but the type: no project, no status, no permission.
  for (const l of BOARD_LENS) {
    const body = String(l.match);
    assert.ok(/\ba\.type\b/.test(body), `${l.id} reads the asset's type`);
    assert.ok(!/project|status|can\(|caps\(|assignee/.test(body),
      `${l.id} must narrow by type and by nothing else — found: ${body}`);
  }
});

test('the default sub-tab is Art, and the choice is deliberately not remembered', () => {
  const { BOARD_LENS_DEFAULT } = lens();
  assert.strictEqual(BOARD_LENS_DEFAULT, 'art',
    'Art is the landing tab — the larger of the two, so a new viewer sees most of the project');
  assert.match(PAGE, /let boardLens = BOARD_LENS_DEFAULT;/,
    'and the live value starts there on every load');

  /* NOT PERSISTED, and this is the assertion that keeps it that way. saveContext() is the
     per-user localStorage the header's client and project pickers use; the lens is
     deliberately absent from it, so a reload always lands on Art rather than on a filter
     somebody set last week and cannot see they set. Every one of the page's other sub-tab
     groups resets the same way. */
  const ctx = grab('function saveContext()');
  assert.ok(!/lens/i.test(ctx), 'the lens is not written to the remembered context');
  const restore = grab('function restoreContext()');
  assert.ok(!/lens/i.test(restore), 'nor read back from it');

  // And it is a plain variable, like the six sub-tab groups that came before it.
  assert.ok(!/localStorage[^\n]*lens/i.test(PAGE), 'the lens touches no storage at all');
});

// --- the board itself, rendered ---------------------------------------------

/* The page's renderBoard, run against a stub DOM.
 *
 * Everything it reaches for is passed in, so what is under test is the function as it
 * ships rather than a paraphrase of it. The stub records innerHTML; the handlers it wires
 * are no-ops, because what is asserted is what a viewer would see. */
function renderWith({ assets, lensId, statuses }) {
  const source = grab('function renderBoard()')
    + '\n' + grab('function wireBoardLens(el)');
  const captured = { html: '' };
  const node = {
    set innerHTML(v) { captured.html = v; },
    get innerHTML() { return captured.html; },
    querySelectorAll: () => [],
  };
  const document = {
    getElementById: () => node,
    querySelectorAll: () => [],
  };
  const state = { currentProjectId: 'p1', assets };
  const escapeHTML = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fn = new Function(
    'document', 'state', 'filteredAssets', 'emptyBoardReason', 'visibleStatuses',
    'cardHTML', 'escapeHTML', 'BOARD_LENS', 'boardLens', 'boardLensMatch',
    `${source}; return renderBoard;`
  )(
    document, state,
    () => state.assets,
    () => 'No assets here yet.',
    () => statuses,
    (a) => `<div class="card" data-id="${a.id}">${a.name}</div>`,
    escapeHTML,
    lens().BOARD_LENS,
    lensId,
    () => (lens().BOARD_LENS.find((l) => l.id === lensId) || lens().BOARD_LENS[0]).match
  );
  fn();
  return captured.html;
}

const STATUSES = [{ id: 'in_progress', label: 'In Progress', color: '#fff' },
  { id: 'delivered', label: 'Delivered', color: '#000' }];

const FIXTURE = [
  { id: 'a1', name: 'Hero',     type: 'character',   status: 'in_progress' },
  { id: 'a2', name: 'Crate',    type: 'prop',        status: 'in_progress' },
  { id: 'a3', name: 'Alley',    type: 'environment', status: 'delivered'   },
  { id: 'a4', name: 'Smoke',    type: 'fx',          status: 'delivered'   },
  { id: 'a5', name: 'Sky',      type: 'background',  status: 'in_progress' },
  { id: 'a6', name: 'RunCycle', type: 'animation',   status: 'in_progress' },
  { id: 'a7', name: 'IdleLoop', type: 'animation',   status: 'delivered'   },
];

test('each sub-tab shows only its own work, and nothing from the other leaks in', () => {
  const art = renderWith({ assets: FIXTURE, lensId: 'art', statuses: STATUSES });
  for (const a of FIXTURE.filter((x) => x.type !== 'animation')) {
    assert.ok(art.includes(`data-id="${a.id}"`), `Art shows ${a.name}`);
  }
  for (const a of FIXTURE.filter((x) => x.type === 'animation')) {
    assert.ok(!art.includes(`data-id="${a.id}"`), `Art must not show ${a.name}`);
  }

  const anim = renderWith({ assets: FIXTURE, lensId: 'animation', statuses: STATUSES });
  for (const a of FIXTURE.filter((x) => x.type === 'animation')) {
    assert.ok(anim.includes(`data-id="${a.id}"`), `Animation shows ${a.name}`);
  }
  for (const a of FIXTURE.filter((x) => x.type !== 'animation')) {
    assert.ok(!anim.includes(`data-id="${a.id}"`), `Animation must not show ${a.name}`);
  }

  // Together they account for everything, so the split loses nothing.
  const shown = (html) => FIXTURE.filter((a) => html.includes(`data-id="${a.id}"`)).map((a) => a.id);
  assert.deepStrictEqual([...shown(art), ...shown(anim)].sort(),
    FIXTURE.map((a) => a.id).sort(), 'every asset appears under exactly one sub-tab');
});

test('the column counts follow the split — no half-migrated filter', () => {
  /* THE FAILURE THIS EXISTS FOR. Cards filtered and counts not would be a board showing
     two Animation cards under a heading that says five, which is the same shape as a
     screen gated one way and a server gated another. */
  const anim = renderWith({ assets: FIXTURE, lensId: 'animation', statuses: STATUSES });
  const counts = [...anim.matchAll(/<span class="count">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(counts, [1, 1],
    'one animation in progress and one delivered — not the whole project');

  const art = renderWith({ assets: FIXTURE, lensId: 'art', statuses: STATUSES });
  const artCounts = [...art.matchAll(/<span class="count">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(artCounts, [3, 2], 'and Art counts only Art');
  assert.strictEqual(artCounts.reduce((a, b) => a + b, 0)
    + counts.reduce((a, b) => a + b, 0), FIXTURE.length, 'the two boards add up to the project');
});

test('the sub-tab counts say what clicking the other one would show', () => {
  const art = renderWith({ assets: FIXTURE, lensId: 'art', statuses: STATUSES });
  const tabCounts = [...art.matchAll(/class="sub-tab-count">(\d+)</g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(tabCounts, [5, 2], 'five Art, two Animation, from the same pool');
  // The open one is marked, and only it.
  assert.match(art, /class="sub-tab active" data-lens="art"/);
  assert.strictEqual((art.match(/sub-tab active/g) || []).length, 1);

  const anim = renderWith({ assets: FIXTURE, lensId: 'animation', statuses: STATUSES });
  assert.match(anim, /class="sub-tab active" data-lens="animation"/);
  assert.deepStrictEqual([...anim.matchAll(/class="sub-tab-count">(\d+)</g)].map((m) => Number(m[1])),
    [5, 2], 'and the counts do not move with the tab — they describe the project');
});

test('an empty lens still shows its sub-tabs, and says which one is empty', () => {
  /* A board with no way off it is the failure here: somebody lands on Animation in a
     project that has none, and without the tabs there is nothing to click back to. */
  const artOnly = FIXTURE.filter((a) => a.type !== 'animation');
  const html = renderWith({ assets: artOnly, lensId: 'animation', statuses: STATUSES });
  assert.match(html, /data-lens="art"/, 'the way back is on screen');
  assert.match(html, /data-lens="animation"/);
  assert.match(html, /Nothing in Animation here/, 'and it names the empty tab');
  assert.ok(!/class="board"/.test(html), 'with no columns drawn');
});

// --- what must NOT have moved -----------------------------------------------

test('the lens narrows by type only — the board keeps the scope it had', () => {
  /* The board has always been ONE project, chosen in the header — the Assets List's own
     comment says the pickers "narrow the Board with it". So the thing to guard is that the
     lens did not become a second, accidental narrowing: same project, same statuses, same
     assets, minus one type. */
  const source = grab('function renderBoard()');
  assert.ok(!/project_id|projectId\s*===|clientContext/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')),
    'renderBoard does not filter by project — state.assets is already this project');
  assert.match(source, /const pool = filteredAssets\(\);/,
    'the pool is the existing filtered set, unchanged');

  // Every status column the viewer could see before is still drawn.
  const html = renderWith({ assets: FIXTURE, lensId: 'art', statuses: STATUSES });
  for (const s of STATUSES) assert.ok(html.includes(s.label), `${s.label} is still a column`);
});

test('the Assets List is untouched: the split is in renderBoard, not in the shared helper', () => {
  /* filteredAssets() feeds the Assets List as well. A lens folded into it would have
     silently halved a different tab — which is exactly the half-migrated shape this file
     is guarding, pointed the other way. */
  const helper = grab('function filteredAssets()');
  assert.ok(!/lens|animation/i.test(helper),
    'filteredAssets knows nothing about the lens');
  const list = grab('function renderList()');
  assert.ok(!/boardLens|BOARD_LENS/.test(list),
    'and the Assets List does not read it either');
});

test('nobody gains or loses the Dashboard: the split carries no permission', () => {
  /* The tab itself has no gate and did not acquire one — it is the only main tab with no
     id and no display:none, which is what makes it everybody's landing screen. */
  const tabRow = PAGE.slice(PAGE.indexOf('<div class="tabs" id="mainTabs">'),
    PAGE.indexOf('</div>', PAGE.indexOf('<div class="tabs" id="mainTabs">')));
  const boardBtn = tabRow.split('\n').find((l) => l.includes('data-tab="board"'));
  assert.ok(boardBtn, 'the Dashboard tab is in the row');
  assert.ok(!/display:none/.test(boardBtn), 'and is not hidden behind anything');
  assert.ok(!/id="/.test(boardBtn), 'it has no id for applyGate to gate it by');

  // And no permission is consulted anywhere in the lens or the board it draws.
  const source = grab('const BOARD_LENS = [', '\n];')
    + grab('function renderBoard()') + grab('function wireBoardLens(el)');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const gate of ['can(', 'caps(', 'hasFullAccess', 'requirePermission', 'holds(']) {
    assert.ok(!code.includes(gate), `the lens must not gate on anything — found ${gate}`);
  }
  // visibleStatuses() is still what decides the columns, so a role that could not see the
  // CD columns still cannot, under either sub-tab.
  assert.match(source, /visibleStatuses\(\)/, 'the columns are still permission-shaped as before');
});

test('the project stats band is deliberately NOT lensed, and says the project', () => {
  /* THE ONE AGGREGATE THAT DOES NOT FOLLOW THE SPLIT, pinned rather than left incidental.
   *
   * #stats sits ABOVE the tab row and is drawn on every tab but Users, so it is a summary
   * of the project rather than of the Dashboard. It already ignores the board's search and
   * type filter — it reads state.assets, not filteredAssets() — so "the band summarises
   * the project, the board shows your current view" is the meaning it already had, not one
   * this change introduced. Making it follow a Dashboard sub-tab would make it wrong on
   * the five other tabs it appears on.
   *
   * The per-discipline numbers are on the sub-tabs, which is where the counts belong. */
  const stats = grab('function renderStats()');
  assert.match(stats, /const pool = state\.assets;/,
    'the band counts the whole project');
  assert.ok(!/boardLens|BOARD_LENS/.test(stats),
    'and is deliberately not lensed — see the note in this test');
  assert.ok(PAGE.indexOf('<div class="stats" id="stats">')
    < PAGE.indexOf('<div class="tabs" id="mainTabs">'),
  'because it is drawn above the tabs, not inside the Dashboard');
});
