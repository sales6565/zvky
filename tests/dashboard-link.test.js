/* THE LINK BETWEEN THE TWO SCREENS CALLED DASHBOARD.
 *
 * A chip in the Admin Dashboard's Attention Required panel opens that project's
 * board — the per-project screen the tab bar calls Dashboard. The risk this
 * file is about is not whether the click fires; it is everything that has to be
 * true before the board draws what the alert was about:
 *
 *   THE FOUR PLACES THAT SET THE PROJECT used to be four different pieces of
 *      code, and only one of them did the whole job. They now all go through
 *      selectProject(), and the tests below assert the CONSEQUENCES — the
 *      remembered context on disk, the client the picker is filtered by, the
 *      board that is drawn — rather than that a particular line was reached.
 *
 *   THE HEADER'S NARROWING SURVIVES A TAB CHANGE. A search typed last week and
 *      a scope-of-work picked yesterday are still on when an alert is clicked,
 *      and either can hide the very asset the alert is about. Both are cleared,
 *      in the state and in the controls.
 *
 *   THE ART / ANIMATION LENS DEFAULTS TO ART. An alert about three animations
 *      would land on a board that holds none of them. The arrival carries the
 *      statuses the row counted and the lens follows the work.
 *
 * RENDERED, NOT READ. The page is not a module, so the functions are lifted out
 * of it and run against a stub DOM — the mechanism tests/dashboard-lens.test.js
 * uses on renderBoard, for the same reason: asserting on the page's text keeps
 * passing after the code around it changes meaning.
 *
 * FIXED DATA, NO CLOCK. Every fixture here is a literal payload of the shape
 * src/admin-dashboard.js builds, so nothing in this file can flip with the real
 * date — which for a screen about overdue and at-risk work is the obvious way
 * to write a test that passes in the morning and fails at night.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const dashboard = require('../src/admin-dashboard');

function grab(opener, closer = '\n}') {
  const at = PAGE.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener} in the page`);
  const rest = PAGE.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

// ---------------------------------------------------------------------------
// A stub DOM, small enough to read.
// ---------------------------------------------------------------------------

/* The chips, parsed back out of the HTML the page just produced.
 *
 * Only the elements the wiring looks for are modelled, and they carry what it
 * reads: the tag it is (a <button> gets Enter and Space from the browser; a
 * <div> with a click handler does not), its dataset, and its listeners. A
 * "click" below is the handler the page bound — which is exactly what a press
 * of Enter or Space on a focused button dispatches. */
function parseNodes(html) {
  const nodes = [];
  const tagRe = /<(button|span)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrsText] = m;
    const attrs = {};
    const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrsText))) attrs[a[1]] = a[2];
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!k.startsWith('data-')) continue;
      dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    nodes.push({
      tagName: tag.toUpperCase(),
      attrs,
      dataset,
      classes,
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      /* What a mouse click and a keyboard activation both reach. The event is
         the real shape the handler uses — it calls stopPropagation on it. */
      click(bubbled) {
        const ev = { stopPropagation() { this.stopped = true; }, stopped: false };
        for (const fn of this.listeners.click || []) fn(ev);
        if (bubbled) bubbled.push(ev.stopped);
        return ev;
      },
    });
  }
  return nodes;
}

/* The two selectors the wiring uses, and nothing else — so a change to either
   fails here rather than silently matching nothing, which is how a stub lies. */
function select(nodes, sel) {
  if (sel === '#adminDashView .ad-chip[data-project]') {
    return nodes.filter((n) => n.classes.includes('ad-chip') && n.dataset.project);
  }
  if (sel === '#adminDashView [data-more]') return nodes.filter((n) => n.dataset.more);
  if (sel === '#adminDashView [data-less]') return nodes.filter((n) => n.dataset.less);
  /* renderBoard wires its cards and columns for clicks and drags. Nothing here
     asserts on those — tests/dashboard-lens.test.js and the drag tests own them
     — so they answer empty, as they do in that harness. */
  if (sel === '.card' || sel === '.column') return [];
  throw new Error(`the stub DOM does not know the selector ${sel} — update the test deliberately`);
}

const escapeHTML = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* Everything under test, lifted out of the page and given a world to run in.
 *
 * `setTab` is a double — the page's own setTab shows and hides a dozen panels
 * and then calls render(), which is not what this file is about. It records the
 * tab and then draws the board, which is what render() does for the board tab
 * (see render(): `else if(state.view==='board') renderBoard();`). The assertion
 * that openProjectBoard asks for the board tab at all is made against the
 * source as well, below. */
function harness({ projects, clients = [], assets = {}, currentProject = null, client = null }) {
  const columnSource = (() => {
    const at = PAGE.indexOf('const BOARD_EXTRA_COLUMNS = [');
    const last = PAGE.indexOf('function boardColumns()', at);
    assert.ok(at !== -1 && last > at, 'the board still builds its columns here');
    return PAGE.slice(at, PAGE.indexOf('\n}', last) + 2);
  })();

  const source = [
    grab('const BOARD_LENS = [', '\n];'),
    grab('const BOARD_LENS_DEFAULT', ';'),
    'let boardLens = BOARD_LENS_DEFAULT;',
    grab('const boardLensMatch = () =>', ';'),
    grab('let boardLensArrival = null;', ';'),
    grab('function arrivalLens(pool, statuses, current)'),
    columnSource,
    grab('function renderBoard()'),
    grab('function wireBoardLens(el)'),
    grab('function contextKey()'),
    grab('function saveContext()'),
    grab('function selectProject(projectId)'),
    grab('const projectReachable = (projectId)=>', ';'),
    grab('function clearBoardNarrowing()'),
    grab('function openProjectBoard(projectId, statuses)'),
    grab('const ATTENTION_CHIP_CAP = 6;', ';'),
    grab('const ATTENTION_OPEN = new Set();', ';'),
    grab('const attentionKey = (r)=>', ';'),
    grab('function attentionChip(p, statuses)'),
    grab('function renderAttention(rows, thresholds)'),
    grab('function wireAdminDashboard()'),
    'let ADMIN_DASH = null;',
    /* The double. Named here rather than grabbed, and the reason is in the note
       on harness() above. */
    'function setTab(tab){ nav.tab = tab; nav.tabs.push(tab); state.view = tab; renderBoard(); }',
  ].join('\n');

  const state = {
    view: 'admin', search: '', filterType: '', assets: [],
    projects, clients,
    currentProjectId: currentProject, clientContextId: client,
    currentUser: { id: 'u-me', name: 'Me' },
  };
  const nav = { tab: null, tabs: [], pickers: 0, gates: [] };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const captured = { board: '' };
  const boardNode = {
    set innerHTML(v) { captured.board = v; },
    get innerHTML() { return captured.board; },
    querySelectorAll: () => [],
  };
  const inputs = { search: { value: 'crate' }, filterType: { value: 'character' } };
  let nodes = [];
  const document = {
    getElementById: (id) => {
      if (id === 'boardView') return boardNode;
      if (id === 'search') return inputs.search;
      if (id === 'filterType') return inputs.filterType;
      if (id === 'adminDashView') return { querySelector: () => null };
      return null;
    },
    querySelectorAll: (sel) => select(nodes, sel),
  };

  const api = new Function(
    'document', 'state', 'nav', 'localStorage', 'escapeHTML', 'filteredAssets',
    'emptyBoardReason', 'visibleStatuses', 'cardHTML', 'applyGate', 'renderContextPickers',
    `${source};
     return {
       renderAttention, wireAdminDashboard, openProjectBoard, selectProject, renderBoard,
       clearBoardNarrowing, arrivalLens, attentionChip, ATTENTION_OPEN,
       setDash: (d)=>{ ADMIN_DASH = d; },
       lens: ()=>boardLens, setLens:(l)=>{ boardLens = l; },
       arrival: ()=>boardLensArrival,
     };`
  )(
    document, state, nav, localStorage, escapeHTML,
    /* The page's own filteredAssets, in miniature: the search and the scope
       filter, which are the two things clearBoardNarrowing clears. Written out
       so the test proves the clearing changes what the board shows. */
    () => {
      let pool = state.assets;
      if (state.filterType) pool = pool.filter((a) => a.type === state.filterType);
      if (state.search) {
        const q = state.search.toLowerCase();
        pool = pool.filter((a) => a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q));
      }
      return pool;
    },
    () => 'No assets here yet.',
    () => [{ id: 'in_progress', label: 'In Progress', color: '#111' },
      { id: 'pending_tl_review', label: 'TL Review', color: '#222' },
      { id: 'awaiting_client_feedback', label: 'With Client', color: '#333' }],
    (a) => `<div class="card" data-id="${a.id}">${a.name}</div>`,
    (id) => nav.gates.push(id),
    () => { nav.pickers += 1; },
  );

  /* The board's assets come from the server per project, which is what
     loadAssets() does inside render(). The double above calls renderBoard, so
     the pool has to follow the chosen project the same way. */
  const loadFor = () => { state.assets = assets[state.currentProjectId] || []; };
  const draw = (html) => { nodes = parseNodes(html); };
  return { api, state, nav, store, inputs, captured, loadFor, draw, nodes: () => nodes };
}

// ---------------------------------------------------------------------------
// The fixture: one payload of the shape the server builds, and three projects.
// ---------------------------------------------------------------------------

const PROJECTS = [
  { id: 'p-art', name: 'Art Heavy', client_id: 'c-1' },
  { id: 'p-anim', name: 'Anim Only', client_id: 'c-2' },
  { id: 'p-mixed', name: 'Mixed Bag', client_id: 'c-2' },
];

const ASSETS = {
  'p-art': [
    { id: 'a1', code: 'CHR-001', name: 'Hero', type: 'character', status: 'in_progress' },
    { id: 'a2', code: 'PRP-001', name: 'Crate', type: 'prop', status: 'pending_tl_review' },
  ],
  // Every asset an animation: the project that makes the Art default wrong.
  'p-anim': [
    { id: 'b1', code: 'ANM-001', name: 'RunCycle', type: 'animation', status: 'pending_tl_review' },
    { id: 'b2', code: 'ANM-002', name: 'IdleLoop', type: 'animation', status: 'in_progress' },
  ],
  'p-mixed': [
    { id: 'c1', code: 'CHR-009', name: 'Villain', type: 'character', status: 'in_progress' },
    { id: 'c2', code: 'ANM-009', name: 'Walk', type: 'animation', status: 'awaiting_client_feedback' },
  ],
};

const THRESHOLDS = { atRiskDays: 7 };

/* The four rows src/admin-dashboard.js builds, with this file's projects in
   them. Shape-checked against the real builder below. */
const ROWS = [
  { severity: 'overdue', count: 1, label: 'project overdue',
    detail: 'Past its end date, or holding work already past its due date.',
    projects: [{ id: 'p-anim', name: 'Anim Only', count: null }], statuses: [] },
  { severity: 'at-risk', count: 1, label: 'project at risk',
    detail: 'Something due inside 7 days is not finished.',
    projects: [{ id: 'p-art', name: 'Art Heavy', count: null }], statuses: [] },
  { severity: 'at-risk', count: 2, label: 'assets waiting on review',
    detail: 'Submitted, and sitting with a team lead or the Creative Director.',
    projects: [{ id: 'p-anim', name: 'Anim Only', count: 1 },
      { id: 'p-art', name: 'Art Heavy', count: 1 }],
    statuses: ['pending_tl_review', 'pending_cd_review'] },
  { severity: 'client', count: 1, label: 'asset awaiting client feedback',
    detail: 'Delivered to the client and waiting on their word.',
    projects: [{ id: 'p-mixed', name: 'Mixed Bag', count: 1 }],
    statuses: ['awaiting_client_feedback'] },
];

const row = (label) => ROWS.find((r) => r.label === label);

// ---------------------------------------------------------------------------
// The inventory, and what each row links to.
// ---------------------------------------------------------------------------

test('every row the panel can draw is accounted for, and only project chips are links', () => {
  /* THE INVENTORY, asserted against the builder rather than against a list
     somebody typed here. Four row types; a fifth added later fails this and has
     to be given a click target deliberately. */
  const built = String(dashboard.build);
  const labels = [...built.matchAll(/label: [^\n]*\? '([^']+)' : '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual(labels,
    ['projects overdue', 'projects at risk', 'assets waiting on review', 'assets awaiting client feedback'],
    'four kinds of row; a new one is a new decision about where it goes');

  const h = harness({ projects: PROJECTS });
  const html = h.api.renderAttention(ROWS, THRESHOLDS);

  /* THE ROW'S OWN COUNT IS NOT A LINK. "2 assets waiting on review" spans two
     projects here, and picking one of them to open would be a guess — which is
     the one thing the brief for this change was most explicit about. */
  const leads = [...html.matchAll(/<div class="ad-flag-lead">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.strictEqual(leads.length, 4, 'one lead per row');
  for (const lead of leads) {
    assert.ok(!/data-project|<button|<a /.test(lead), `the aggregate lead is plain text: ${lead}`);
  }

  // And every project named in any row is a chip with a destination.
  const nodes = parseNodes(html);
  const linked = nodes.filter((n) => n.dataset.project).map((n) => n.dataset.project);
  assert.deepStrictEqual(linked, ['p-anim', 'p-art', 'p-anim', 'p-art', 'p-mixed'],
    'every project named in every row, in the order the rows name them');

  /* THE STATUSES RIDE ON THE ASSET ROWS ONLY. A project row has no asset to aim
     a lens at, and carrying an empty list says so. */
  const byRow = (label) => parseNodes(h.api.renderAttention([row(label)], THRESHOLDS))
    .filter((n) => n.dataset.project);
  assert.deepStrictEqual(byRow('project overdue').map((n) => n.dataset.statuses), [''],
    'a project row carries no statuses');
  assert.deepStrictEqual(byRow('assets waiting on review').map((n) => n.dataset.statuses),
    ['pending_tl_review,pending_cd_review', 'pending_tl_review,pending_cd_review'],
    'an asset row carries the ones the server counted');
});

test('a chip is a real button, labelled with where it goes', () => {
  const h = harness({ projects: PROJECTS });
  const nodes = parseNodes(h.api.renderAttention([row('project overdue')], THRESHOLDS));
  const chip = nodes.find((n) => n.dataset.project);

  /* A BUTTON, and that is the whole of the keyboard support: focusable in
     document order, activated by Enter and by Space, announced as a button. A
     <div onclick> is none of those, and is what this assertion exists to
     prevent somebody writing instead. */
  assert.strictEqual(chip.tagName, 'BUTTON');
  assert.strictEqual(chip.attrs.type, 'button', 'and not a submit button');
  assert.strictEqual(chip.attrs['aria-label'], 'Open Anim Only dashboard',
    'the label says where it goes, not just which project it is');
  assert.ok(!/onclick=/.test(h.api.renderAttention(ROWS, THRESHOLDS)),
    'nothing in the panel is wired by an inline attribute');

  /* The hover and the focus ring, which are style rather than markup — asserted
     against the sheet because a control a keyboard can reach and cannot see is
     only half built. */
  assert.match(PAGE, /\.ad-chip:hover\{/);
  assert.match(PAGE, /\.ad-chip:focus-visible\{outline:2px solid var\(--brand-accent\)/);
});

test('a project this page cannot open is named, not linked', () => {
  /* THE REACH CASE. The two screens cannot actually disagree — both ask
     permissions.visibleProjects — so what is left is a project that has
     appeared since this page's own list was read. Either way the answer is the
     same: name it, and do not draw a control that would land nowhere. */
  const h = harness({ projects: [PROJECTS[0]] });     // only Art Heavy is reachable
  const html = h.api.renderAttention(ROWS, THRESHOLDS);
  const nodes = parseNodes(html);

  const plain = nodes.filter((n) => n.classes.includes('ad-chip-plain'));
  assert.ok(plain.length >= 1, 'the unreachable projects are still named');
  for (const n of plain) {
    assert.strictEqual(n.tagName, 'SPAN', 'not a button, so not in the tab order');
    assert.strictEqual(n.dataset.project, undefined, 'and nothing to click');
    assert.match(n.attrs.title, /reload/i, 'with a reason a reader can act on');
  }
  assert.ok(html.includes('Anim Only'), 'the name is on screen either way');

  // Only the reachable one is a link, and the wiring never sees the others.
  assert.deepStrictEqual(nodes.filter((n) => n.dataset.project).map((n) => n.dataset.project),
    ['p-art', 'p-art'], 'Art Heavy twice — the at-risk row and the review row');
});

// ---------------------------------------------------------------------------
// The click, end to end.
// ---------------------------------------------------------------------------

function clickChip({ h, rows = ROWS, projectId }) {
  const html = h.api.renderAttention(rows, THRESHOLDS);
  h.draw(html);
  h.api.setDash({ attention: rows, thresholds: THRESHOLDS });
  h.api.wireAdminDashboard();
  const chip = h.nodes().find((n) => n.dataset.project === projectId);
  assert.ok(chip, `a chip for ${projectId}`);
  /* The board's assets arrive with the project, as loadAssets() inside render()
     fetches them. Hooked to the click so the order is the real one: context
     first, then the pool, then the draw. */
  const origin = h.state.currentProjectId;
  chip.listeners.click.unshift(() => { /* before: nothing is loaded yet */ });
  const ev = (() => {
    const before = h.state.currentProjectId;
    assert.strictEqual(before, origin);
    /* The pool is swapped in by the double's renderBoard call, so it is set
       here from the project the handler is about to choose. */
    h.state.assets = ASSETS[projectId] || [];
    return chip.click();
  })();
  return { chip, ev };
}

test('clicking a project chip lands on that project\'s board, through the one funnel', () => {
  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  clickChip({ h, projectId: 'p-mixed' });

  // The tab, and the board actually drawn for the clicked project.
  assert.strictEqual(h.nav.tab, 'board', 'the board tab is the destination');
  assert.ok(h.captured.board.includes('data-id="c1"') || h.captured.board.includes('data-id="c2"'),
    `the board drew the clicked project's assets: ${h.captured.board.slice(0, 200)}`);

  // The header, in all three of the places that have to agree.
  assert.strictEqual(h.state.currentProjectId, 'p-mixed', 'the chosen project');
  assert.strictEqual(h.state.clientContextId, 'c-2',
    'and its client — without this the picker filters the project it is showing back out');
  assert.ok(h.nav.pickers > 0, 'the pickers were redrawn, so the <select> shows it');
  assert.ok(h.nav.gates.includes('editProjectBtn'), 'and the project buttons were re-decided');

  /* THE PERSISTED CONTEXT, read back off the stub disk. This is the assertion
     that "went through the funnel" means something: the old chip handler set
     the id and saved nothing, so a reload undid the navigation. */
  const saved = JSON.parse(h.store['zvky_ctx_u-me']);
  assert.deepStrictEqual(saved, { clientId: 'c-2', projectId: 'p-mixed' },
    'the click is remembered exactly as if the picker had been used');
});

test('a different project from the one already selected is selected correctly', () => {
  /* The shape of the bug this guards: a handler that reads the first row's id,
     or that short-circuits when something is already chosen. */
  const h = harness({ projects: PROJECTS, currentProject: 'p-anim', client: 'c-2' });
  clickChip({ h, projectId: 'p-art' });
  assert.strictEqual(h.state.currentProjectId, 'p-art');
  assert.strictEqual(h.state.clientContextId, 'c-1', 'across clients, too');
  assert.strictEqual(JSON.parse(h.store['zvky_ctx_u-me']).projectId, 'p-art');
  assert.ok(h.captured.board.includes('data-id="a1"'), 'and Art Heavy is what is drawn');

  // Each chip carries its own project: the second row's chips are not the first's.
  const ids = h.nodes().filter((n) => n.dataset.project).map((n) => n.dataset.project);
  assert.ok(new Set(ids).size > 1, 'the chips are not all the same id');
});

test('the header\'s search and scope filter are cleared on arrival', () => {
  /* THE FAILURE THIS IS FOR. Both survive a tab change by design — the search
     box is written back from state.search by setTab — so an alert clicked a
     week later lands on a board narrowed by something nobody remembers
     setting, and the asset the alert is about is the one hidden. */
  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  h.state.search = 'crate';
  h.state.filterType = 'character';

  clickChip({ h, projectId: 'p-anim' });

  assert.strictEqual(h.state.search, '', 'the search is cleared');
  assert.strictEqual(h.state.filterType, '', 'and the scope of work');
  /* AND THE CONTROLS, not only the state. Nothing syncs the scope picker from
     state, so clearing one without the other leaves a box reading "Characters"
     over a board showing everything. */
  assert.strictEqual(h.inputs.search.value, '', 'the box on screen agrees');
  assert.strictEqual(h.inputs.filterType.value, '', 'and so does the picker');

  // The board is not empty, which is what the clearing is for: 'crate' and
  // 'character' between them match nothing in Anim Only.
  assert.ok(h.captured.board.includes('data-id="b1"'), 'the alerting work is on screen');
  assert.ok(!/No assets match your filters/.test(h.captured.board));
});

test('the Assets List\'s own column filters are deliberately left alone', () => {
  /* A DECISION, recorded because it looks like an omission. state.listFilter is
     the Assets List's filter bar: it does not narrow the board at all (see
     filteredAssets), it is drawn on screen with a Reset beside it wherever it
     applies, and its own note says it is kept across a project change on
     purpose. Clearing another tab's controls from this navigation would be a
     surprise rather than a courtesy. */
  const clear = grab('function clearBoardNarrowing()');
  assert.ok(!/listFilter/.test(clear.replace(/\/\*[\s\S]*?\*\//g, '')),
    'clearBoardNarrowing touches the board\'s own two narrowings and nothing else');
  const filtered = grab('function filteredAssets()');
  assert.ok(!/listFilter/.test(filtered), 'and the board never read listFilter in the first place');
});

// ---------------------------------------------------------------------------
// The lens.
// ---------------------------------------------------------------------------

test('an alert about assets opens the lens that holds them', () => {
  /* Anim Only is every-asset-animation, and the review row names it. Landing on
     the Art default would show "Nothing in Art here" for an alert somebody had
     just clicked — a link that appears to go nowhere. */
  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  assert.strictEqual(h.api.lens(), 'art', 'the default, before anything is clicked');

  clickChip({ h, rows: [row('assets waiting on review')], projectId: 'p-anim' });
  assert.strictEqual(h.api.lens(), 'animation', 'the lens followed the alerting work');
  assert.ok(h.captured.board.includes('data-id="b1"'), 'which is what is drawn');
  assert.strictEqual(h.api.arrival(), null, 'and the arrival was spent, not left armed');
});

test('an alert about a project leaves the lens at its default', () => {
  const h = harness({ projects: PROJECTS, currentProject: 'p-anim', client: 'c-2' });
  clickChip({ h, rows: [row('project at risk')], projectId: 'p-art' });
  assert.strictEqual(h.api.lens(), 'art',
    'no asset was named, so the default stands — Art, the larger half');
  assert.ok(h.captured.board.includes('data-id="a1"'));
});

test('the default never wins when it would draw an empty board', () => {
  /* The other half of the same rule, and the one that cannot be solved by the
     statuses: a PROJECT row naming a project that holds only animations. There
     is no alerting asset to follow, and Art is empty. */
  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  clickChip({ h, rows: [row('project overdue')], projectId: 'p-anim' });
  assert.strictEqual(h.api.lens(), 'animation', 'the lens moved to where the work is');
  assert.ok(!/Nothing in Art here/.test(h.captured.board));
  assert.ok(h.captured.board.includes('data-id="b1"'));
});

test('arrivalLens never picks an empty lens over a full one, and never overrules a deliberate click', () => {
  const h = harness({ projects: PROJECTS });
  const art = ASSETS['p-art'];
  const anim = ASSETS['p-anim'];
  const mixed = ASSETS['p-mixed'];

  // The statuses win when they match something.
  assert.strictEqual(h.api.arrivalLens(mixed, ['awaiting_client_feedback'], 'art'), 'animation',
    'the client-feedback asset in Mixed Bag is the animation');
  assert.strictEqual(h.api.arrivalLens(mixed, ['in_progress'], 'animation'), 'art',
    'and the in-progress one is the character');

  // Statuses that match nothing here fall back to the current lens.
  assert.strictEqual(h.api.arrivalLens(art, ['awaiting_client_feedback'], 'art'), 'art');

  // Empty is never chosen when the other side has something.
  assert.strictEqual(h.api.arrivalLens(anim, [], 'art'), 'animation');
  assert.strictEqual(h.api.arrivalLens(art, [], 'animation'), 'art');
  // Nothing at all: the lens stays where it is rather than flapping.
  assert.strictEqual(h.api.arrivalLens([], [], 'animation'), 'animation');

  /* AND IT IS ONE-SHOT. A lens that corrected itself on every draw would
     overrule somebody who had just clicked Animation on an Art-only project —
     which is the existing "Nothing in Animation here" screen, and is the right
     answer for a choice just made. */
  const board = grab('function renderBoard()');
  assert.match(board, /if\(boardLensArrival !== null\)\{/);
  assert.match(board, /boardLensArrival = null;/, 'spent on the draw it steers');
  h.api.setLens('animation');
  h.state.currentProjectId = 'p-art';
  h.state.assets = art;
  h.api.renderBoard();
  assert.strictEqual(h.api.lens(), 'animation', 'a deliberate choice is left alone');
  assert.match(h.captured.board, /Nothing in Animation here/);
});

// ---------------------------------------------------------------------------
// The wiring: one funnel, nested controls, re-renders.
// ---------------------------------------------------------------------------

test('every way of choosing a project goes through selectProject', () => {
  /* THE DRIFT THIS CLOSES. Four pieces of code set the project, and only the
     notification one also moved the client, saved the context and redrew the
     pickers — so the same act had four outcomes depending on where it was
     started from. */
  const funnel = grab('function selectProject(projectId)');
  for (const must of ['state.currentProjectId = target.id;', 'state.clientContextId = target.client_id;',
    'saveContext();', 'renderContextPickers();', 'applyGate(\'editProjectBtn\');']) {
    assert.ok(funnel.includes(must), `the funnel does ${must}`);
  }

  const picker = grab('  projSel.onchange = ()=>{', '\n  };');
  assert.match(picker, /selectProject\(projSel\.value\)/, 'the header picker');

  const open = grab('  document.querySelectorAll(\'.openProjectBtn\')', '\n  }));');
  assert.match(open, /selectProject\(b\.dataset\.id\)/, 'the Projects tab\'s Open');
  assert.ok(!/state\.currentProjectId\s*=/.test(open), 'and nothing by hand any more');

  const wire = grab('function wireAdminDashboard()');
  assert.match(wire, /openProjectBoard\(b\.dataset\.project, statuses\)/, 'the Admin Dashboard chip');
  assert.ok(!/state\.currentProjectId\s*=/.test(wire),
    'which must not set the project itself — that is the whole point of the funnel');
  assert.ok(!/sel\.value|projectSelect/.test(wire),
    'nor poke the <select> behind the picker\'s back');

  const notif = grab('async function openNotification(');
  assert.match(notif, /selectProject\(project\)/, 'and a notification');
  assert.ok(!/state\.clientContextId\s*=/.test(notif), 'with its own copy removed');

  // openProjectBoard is the arrival, and it does all three parts.
  const arrive = grab('function openProjectBoard(projectId, statuses)');
  assert.match(arrive, /selectProject\(projectId\)/);
  assert.match(arrive, /clearBoardNarrowing\(\);/);
  assert.match(arrive, /setTab\('board'\);/);
});

test('a click on a chip is not also a click on the row around it', () => {
  /* The row carries no handler at all — the chips are the only controls in the
     panel, which is what keeps the text of an alert selectable. The chip stops
     the event anyway, so that stays true if a row ever becomes clickable. */
  const wire = grab('function wireAdminDashboard()');
  assert.match(wire, /ev\.stopPropagation\(\);/);
  assert.ok(!/\.ad-flag['"]\)\.forEach|ad-flag-body['"]\)\.forEach/.test(wire),
    'nothing is bound to the row or its body');

  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  const { ev } = clickChip({ h, projectId: 'p-mixed' });
  assert.strictEqual(ev.stopped, true, 'the chip stops the click reaching anything larger');

  /* And the disclosure button beside the chips is not a chip: pressing it must
     not navigate. */
  const many = [{ ...row('assets waiting on review'),
    projects: Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, count: 9 - i })) }];
  h.draw(h.api.renderAttention(many, THRESHOLDS));
  h.api.setDash({ attention: many, thresholds: THRESHOLDS });
  const before = h.state.currentProjectId;
  h.api.wireAdminDashboard();
  const more = h.nodes().find((n) => n.dataset.more);
  assert.ok(more, 'the cap offers the rest');
  assert.strictEqual(more.dataset.project, undefined, 'and is not itself a destination');
  more.click();
  assert.strictEqual(h.state.currentProjectId, before, 'pressing it navigated nowhere');
});

test('the chip cap opens out, and a redraw does not close it', () => {
  const projects = Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, count: 9 - i }));
  const rows = [{ ...row('project overdue'), count: 9, projects }];
  const h = harness({ projects: projects.map((p) => ({ ...p, client_id: 'c-1' })) });

  const first = h.api.renderAttention(rows, THRESHOLDS);
  assert.strictEqual(parseNodes(first).filter((n) => n.dataset.project).length, 6,
    'six chips, which is the cap');
  assert.match(first, /\+3 more/);
  assert.match(first, /aria-label="Show 3 more projects in this alert"/);

  h.draw(first);
  h.api.setDash({ attention: rows, thresholds: THRESHOLDS });
  h.api.wireAdminDashboard();
  h.nodes().find((n) => n.dataset.more).click();

  const opened = h.api.renderAttention(rows, THRESHOLDS);
  assert.strictEqual(parseNodes(opened).filter((n) => n.dataset.project).length, 9,
    'all nine, once asked for');
  assert.match(opened, /show fewer/, 'and a way back');

  /* THE REDRAW. This panel is rebuilt from scratch by innerHTML whenever the
     screen is drawn again, so "what somebody is doing" has to live outside the
     render or it collapses under their hands. */
  const again = h.api.renderAttention(rows, THRESHOLDS);
  assert.strictEqual(parseNodes(again).filter((n) => n.dataset.project).length, 9,
    'still open after a full redraw');

  // And closing it again works.
  h.draw(again);
  h.api.wireAdminDashboard();
  h.nodes().find((n) => n.dataset.less).click();
  assert.strictEqual(parseNodes(h.api.renderAttention(rows, THRESHOLDS))
    .filter((n) => n.dataset.project).length, 6);
});

test('a redraw leaves the links working', () => {
  /* The panel is re-wired on every draw because the nodes it was wired to are
     thrown away with the innerHTML. Two draws, a click on the second: if the
     wiring were done once at boot this would navigate nowhere. */
  const h = harness({ projects: PROJECTS, currentProject: 'p-art', client: 'c-1' });
  h.draw(h.api.renderAttention(ROWS, THRESHOLDS));
  h.api.setDash({ attention: ROWS, thresholds: THRESHOLDS });
  h.api.wireAdminDashboard();

  // Drawn again, as switching tabs and coming back does.
  h.draw(h.api.renderAttention(ROWS, THRESHOLDS));
  h.api.wireAdminDashboard();
  const chip = h.nodes().find((n) => n.dataset.project === 'p-mixed');
  h.state.assets = ASSETS['p-mixed'];
  chip.click();
  assert.strictEqual(h.state.currentProjectId, 'p-mixed', 'the second draw\'s chip works');
  assert.strictEqual(h.nav.tab, 'board');

  // The Admin Dashboard's own state is intact: the payload it drew from is
  // still there, so the panel can redraw itself without another request.
  assert.match(grab('function wireAdminDashboard()'), /ADMIN_DASH/,
    'the redraw reads the payload it already has');
});

test('the dashboard decides its chips against a current project list', () => {
  /* Both screens ask permissions.visibleProjects, so a project named here is
     one the picker holds — but state.projects is read once at boot. Without
     this refresh, "plain text" would sometimes mean "this page is out of date"
     rather than "you cannot open this". */
  const render = grab('async function renderAdminDashboard()');
  assert.match(render, /await refreshProjects\(\);/);
  const refresh = grab('async function refreshProjects()');
  assert.match(refresh, /api\('\/projects'\)/);
  assert.ok(!/restoreContext/.test(refresh),
    'and not bootApp, which would move the header back mid-navigation');
});

// ---------------------------------------------------------------------------
// What was NOT introduced.
// ---------------------------------------------------------------------------

test('the app still has no routing, and this change did not add any', () => {
  /* Checked before anything was written, and recorded because it decides what
     "back" means: there is no hash, no pushState, no popstate handler anywhere
     in the page. location is read twice — once for the API base, once for the
     redirect after signing out. So the destination is not addressable and the
     browser's Back button does not retrace a tab change; the way back to the
     Admin Dashboard is the tab bar. Introducing routing for one link would be a
     navigation model for the whole app, which is a bigger change than this. */
  assert.ok(!/location\.hash/.test(PAGE), 'no hash routing');
  assert.ok(!/history\.(pushState|replaceState)/.test(PAGE), 'no history API');
  assert.ok(!/popstate|hashchange/.test(PAGE), 'and nothing listening for either');
  /* Three mentions, on two lines: the API base, and the sign-out redirect —
     `window.location.replace(window.location.pathname)` names it twice. */
  assert.strictEqual((PAGE.match(/window\.location/g) || []).length, 3,
    'location is read for the API base and the sign-out redirect, and nowhere else');
});

test('no new permission key, because the two screens already share one reach rule', () => {
  /* ASKED AND ANSWERED IN THE SOURCE. The Admin Dashboard lists
     permissions.visibleProjects(user); GET /api/projects returns that same
     call; canAccessProject, which guards the board's own request, IS that call.
     So there is no gap for a key to close, and the server stays the authority
     for the request the page makes. */
  const perms = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  assert.match(perms, /async function canAccessProject\(user, projectId\) \{\s*\n\s*const projects = await visibleProjects\(user\);/,
    'the board\'s reach IS the dashboard\'s reach');

  const projectsRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'projects.js'), 'utf8');
  assert.match(projectsRoute, /const projects = await visibleProjects\(req\.user\);/,
    'and so is the list the page draws its chips from');

  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin-dashboard.js'), 'utf8');
  assert.match(dash, /projects = await permissions\.visibleProjects\(user\)/);

  // No key was added for this.
  const catalogue = require('../src/permission-catalog');
  assert.ok(!catalogue.BY_KEY.has('report.admin_dashboard_links'),
    'nothing invented for a gap that does not exist');
  assert.ok(catalogue.BY_KEY.has('report.admin_dashboard'), 'the existing gate is still the gate');
});
