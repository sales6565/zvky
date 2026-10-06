/* THE DASHBOARD, AFTER A FREELANCER'S WORK IS DELIVERED.
 *
 * "Dashboard" IS TWO THINGS IN THIS APPLICATION and the mix-up has happened
 * before, so: this file is about the tab labelled Dashboard, which is the
 * per-project BOARD (data-tab="board", renderBoard()). The permission-gated
 * ADMIN Dashboard is a different screen and is treated here as a consumer.
 *
 * WHAT THIS FILE USED TO BE ABOUT, and why it is not any more. For two commits
 * Mark delivered landed a freelancer's task in pending_tl_review, so the board
 * drew it in a column of its own — "Back from Freelancer" — to stop it reading
 * as an artist's submission sitting in TL Review. The studio then re-pointed the
 * delivery at the pipeline's own terminal status, 'delivered'. The board has
 * always had a Delivered column, so there is nothing left for an extra column to
 * claim: BOARD_EXTRA_COLUMNS is empty, and OUTSOURCE_DELIVERED_COLUMN survives
 * only as a named record of the superseded destination.
 *
 * SO WHAT THIS FILE VERIFIES NOW is mostly that nothing had to be built: the
 * asset appears in the Delivered column the board already drew, in exactly one
 * column, counted once everywhere. The two things that ARE new are the card's
 * freelancer line — which had to stop being keyed on a column that no longer
 * exists — and the property test, which is worth keeping whatever the columns
 * are: it fails if ANY status the server can set stops mapping to exactly one
 * column, which on a board means a card vanishing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, openStudio } = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cfg = config('boarddel');
const PASSWORD = 'BoardDel-Test-1!';

function grab(opener, closer = '\n}') {
  const at = PAGE.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener} in the page`);
  const rest = PAGE.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

/* From one declaration THROUGH the end of a later one. grab() stops at the first
   closing brace, which is right for a single function and wrong for the column
   block — BOARD_EXTRA_COLUMNS, boardColumnOf and boardColumns are three
   declarations that only work together. */
function grabThrough(opener, lastFn) {
  const at = PAGE.indexOf(opener);
  const from = PAGE.indexOf(lastFn, at);
  assert.ok(at !== -1 && from > at, `could not find ${opener} .. ${lastFn}`);
  const end = PAGE.indexOf('\n}', from) + 2;
  return PAGE.slice(at, end);
}
const COLUMN_SOURCE = grabThrough('const BOARD_EXTRA_COLUMNS = [', 'function boardColumns()');

/* The page's STATUSES, read out of the page. Not a copy: the board's columns are
   built from these and a test below holds them equal to the server's. */
const PAGE_STATUSES = [...PAGE.match(/const STATUSES = \[([\s\S]*?)\n\];/)[1]
  .matchAll(/\{id:'([a-z_]+)', label:'([^']+)', color:'([^']+)'\}/g)]
  .map((m) => ({ id: m[1], label: m[2], color: m[3] }));

/* THE PAGE'S OWN BOARD, RUN. Everything it reaches for is passed in, so what is
 * under test is the function as it ships. fmtDate is stubbed to a fixed format
 * so an assertion on a card cannot depend on the runner's locale, and the
 * fixtures below carry fixed dates so the studio clock cannot interfere. */
function renderBoard({ assets, lensId = 'art', statuses = PAGE_STATUSES, realCards = true }) {
  const columns = COLUMN_SOURCE;
  const source = [
    columns,
    grab('const BOARD_LENS = [', '\n];'),
    grab('const boardLensMatch = ()', ';'),
    realCards ? grab('function cardHTML(a)') : '',
    grab('function renderBoard()'),
    grab('function wireBoardLens(el)'),
  ].join('\n');

  let html = '';
  const node = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelectorAll: () => [],
  };
  const sandbox = {
    console,
    document: { getElementById: () => node, querySelectorAll: () => [] },
    state: { currentProjectId: 'p1', assets },
    filteredAssets: () => assets,
    emptyBoardReason: () => 'No assets here yet.',
    visibleStatuses: () => statuses,
    boardLens: lensId,
    escapeHTML: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    // Fixed, so a card assertion does not depend on the runner's locale.
    fmtDate: (v) => `D:${String(v).slice(0, 10)}`,
    typeOf: (t) => ({ label: t, color: '#888' }),
    priorityOf: () => ({ label: 'med' }),
    thumbInner: () => '',
    avatarHTML: (p) => (p && p.id ? `<span class="avatar">${p.name}</span>` : ''),
    pauseWords: () => ({ title: 'Held', short: 'Held' }),
    api: async () => {}, render: () => {}, showToast: () => {}, openDrawer: () => {},
    statusOf: (id) => ({ label: id }),
  };
  if (!realCards) sandbox.cardHTML = (a) => `<div class="card" data-id="${a.id}">${a.name}</div>`;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;__render = renderBoard;`, sandbox);
  sandbox.__render();
  return html;
}

/* Which column each card ended up in, parsed out of the rendered board. */
function placement(html) {
  const per = new Map();
  for (const chunk of html.split('<div class="column"').slice(1)) {
    const col = (chunk.match(/data-status="([a-z_]+)"/) || [])[1];
    const count = Number((chunk.match(/<span class="count">(\d+)<\/span>/) || [])[1]);
    const ids = [...chunk.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
    per.set(col, { count, ids, html: chunk });
  }
  return per;
}
const columnsOf = (html, id) =>
  [...placement(html).entries()].filter(([, v]) => v.ids.includes(id)).map(([k]) => k);

// ---------------------------------------------------------------------------
// Fixtures. Fixed dates throughout.
// ---------------------------------------------------------------------------

const DELIVERED_AT = '2026-10-06T07:30:00.000Z';
const deliveredByFreelancer = (over = {}) => ({
  id: 'f1', code: 'CHR-002', name: 'Lantern Keeper', type: 'character',
  status: 'delivered', assignee_id: null, assignee_name: null,
  man_hours: 24, due_date: null, priority: 'low', tasks: [], held: null,
  outsourced_to: {
    freelancerName: 'Ravi K.', status: 'delivered', stage: 'delivered',
    delivered: true, deliveredByName: 'Priya', deliveredAt: DELIVERED_AT,
  },
  ...over,
});
const ordinary = (id, status, over = {}) => ({
  id, code: `PRP-${id}`, name: `Ours ${id}`, type: 'prop', status,
  assignee_id: 'u1', assignee_name: 'Ana', man_hours: 8, due_date: null,
  priority: 'low', tasks: [], held: null, outsourced_to: null, ...over,
});

// ---------------------------------------------------------------------------
// The column, and the one-column rule.
// ---------------------------------------------------------------------------

test('a freelancer-delivered asset is in the Delivered column and in no other', () => {
  const html = renderBoard({ assets: [deliveredByFreelancer(), ordinary('o1', 'pending_tl_review')] });
  const cols = placement(html);

  assert.deepStrictEqual(columnsOf(html, 'f1'), ['delivered'],
    'exactly one column, and it is the one the board already had');
  assert.deepStrictEqual(columnsOf(html, 'o1'), ['pending_tl_review'],
    'and an artist\'s submission is untouched');
  assert.strictEqual(cols.get('delivered').count, 1);
  assert.strictEqual(cols.get('pending_tl_review').count, 1);

  /* NOTHING WAS BUILT FOR THIS, which is the point of the change: 'delivered' is
     the status the board has drawn since before any outsourcing existed. */
  assert.match(cols.get('delivered').html, /<span class="title">Delivered<\/span>/);
  assert.strictEqual(workflow.transitionFor('outsource_delivered').to, 'delivered');

  /* AND Back from Freelancer IS GONE FROM THE BOARD. Superseded: the constant
     survives as a record of the old destination, listed in no extras array and
     drawn on no screen. A candidate for later clean-up, and this is what fails
     if it comes back. */
  assert.ok(!/Back from Freelancer/.test(html), 'the superseded column is not drawn');
  assert.ok(!cols.has('outsource_delivered'), 'and has no column at all');
  const extras = new Function(`${COLUMN_SOURCE}; return BOARD_EXTRA_COLUMNS;`)();
  assert.deepStrictEqual(extras, [], 'the page lists no extra columns');
  assert.ok(workflow.OUTSOURCE_DELIVERED_COLUMN,
    'the constant is still defined, so the decision stays readable');
  assert.ok(!workflow.STATE_IDS.includes(workflow.OUTSOURCE_DELIVERED_COLUMN.id),
    'and was never a status, so there is nothing to retire');
});

test('Delivered is the last column, and the only way out of it is the reversal', () => {
  const html = renderBoard({ assets: [deliveredByFreelancer()] });
  const order = [...placement(html).keys()];
  assert.strictEqual(order[order.length - 1], 'delivered',
    'the end of the pipeline is the end of the board');
  assert.deepStrictEqual(order, PAGE_STATUSES.map((x) => x.id),
    'and the columns are exactly the statuses, in their order');

  /* TERMINAL, AND THE ONE EXCEPTION IS PERMISSION-GATED. Nothing leads out of
     Delivered but the outsourced reversal, which exists so a mistaken delivery
     can be undone and is held by the designations that hold user.delete. */
  assert.deepStrictEqual(
    workflow.TRANSITIONS.filter((t) => t.from.includes('delivered')).map((t) => t.action),
    ['outsource_reopen']);
});

test('every status the server can set maps to exactly one column', () => {
  /* THE PROPERTY TEST, and the reason it is a property rather than a list: a
     status added to the workflow next year must fail HERE rather than quietly
     having no column, which on a board means the card vanishes. */
  const serverStatuses = workflow.STATE_IDS;
  assert.deepStrictEqual(PAGE_STATUSES.map((s) => s.id), serverStatuses,
    'the page and the workflow list the same statuses in the same order');

  const assets = serverStatuses.map((status, i) => ordinary(`s${i}`, status));
  const html = renderBoard({ assets, statuses: PAGE_STATUSES });
  for (const [i, status] of serverStatuses.entries()) {
    const cols = columnsOf(html, `s${i}`);
    assert.strictEqual(cols.length, 1,
      `an ordinary asset in ${status} is in exactly one column, not ${cols.length} (${cols})`);
    assert.strictEqual(cols[0], status,
      `and it is still its own status column — ordinary work keeps its columns`);
  }

  /* AND NOTHING IS LOST THE OTHER WAY: every card rendered is in some column, so
     the counts add up to the assets on the board. */
  const total = [...placement(html).values()].reduce((n, c) => n + c.ids.length, 0);
  assert.strictEqual(total, assets.length, 'every asset is on the board somewhere');
});

test('one column per asset is structural, and the mapping is the status', () => {
  const fn = new Function(`${COLUMN_SOURCE}; return { boardColumnOf, boardColumns, BOARD_EXTRA_COLUMNS };`)();

  /* WITH NO EXTRA COLUMNS the mapping is the asset's own status — which is what
     this page did before any of it, and is the behaviour the re-pointing
     restored. The machinery stays because it is what makes "exactly one column"
     structural rather than something each caller has to be careful of: ONE
     answer per asset, asked by the board, its counts and the stats band. */
  assert.strictEqual(fn.boardColumnOf(deliveredByFreelancer()), 'delivered');
  assert.strictEqual(fn.boardColumnOf(ordinary('o1', 'pending_tl_review')), 'pending_tl_review');
  for (const status of workflow.STATE_IDS) {
    assert.strictEqual(fn.boardColumnOf(ordinary('x', status)), status,
      `an asset in ${status} maps to its own column`);
  }
  // A delivered assignment no longer changes where the card goes; the status does.
  assert.strictEqual(fn.boardColumnOf(deliveredByFreelancer({ status: 'in_progress' })), 'in_progress');
  assert.strictEqual(fn.boardColumnOf(null), null);

  // And the columns are the visible statuses, with nothing spliced in.
  const statuses = [{ id: 'a' }, { id: 'b' }];
  const cols = new Function('visibleStatuses',
    `${COLUMN_SOURCE}; return boardColumns();`)(() => statuses);
  assert.deepStrictEqual(cols, statuses, 'no extras, so the columns are the statuses');
});

test('the card says whose work it is and when, and shows no hours', () => {
  const html = renderBoard({ assets: [deliveredByFreelancer(), ordinary('o1', 'pending_tl_review')] });
  const mine = placement(html).get('delivered').html;

  assert.match(mine, /class="card-fl"/, 'the card carries the freelancer line');
  assert.match(mine, /Ravi K\./, 'with the freelancer\'s name');
  assert.match(mine, /D:2026-10-06/, 'and the delivered date, through the page\'s own formatter');
  /* WHO RECORDED IT is in the hover and not on the face of the card: the card
     answers "whose work is this", and "who entered it" is a different question
     with a different answer. */
  assert.match(mine, /title="Sent back by Ravi K\. on D:2026-10-06, recorded by Priya"/);

  /* NO HOURS. man_hours is the ESTIMATE and no card has ever shown tracked time
     — but "24h" directly above "Ravi K." reads as hours Ravi logged, and there
     is no such figure, because the studio does not clock somebody it does not
     employ. */
  assert.ok(!/24h/.test(mine), 'the estimate is not printed beside a freelancer\'s name');
  assert.ok(!/time_spent|timeSpent|Still running/.test(mine), 'and no timer of any kind');

  /* AND THE ORDINARY CARD IS UNCHANGED — it keeps its estimate and its avatar,
     and gains no freelancer line. */
  const theirs = placement(html).get('pending_tl_review').html;
  assert.match(theirs, /8h/, 'an ordinary card still shows its estimate');
  assert.ok(!/class="card-fl"/.test(theirs), 'and no freelancer line');
  assert.match(theirs, /class="avatar">Ana</, 'and still its assignee');

  // The due date is not hours, so it stays on a freelancer's card.
  const withDue = renderBoard({ assets: [deliveredByFreelancer({ due_date: '2026-11-02' })] });
  assert.match(placement(withDue).get('delivered').html, /CHR-002 · /,
    'a due date still prints');
});

test('a delivered freelancer card opens and drags exactly like any other', () => {
  const html = renderBoard({ assets: [deliveredByFreelancer()] });
  const mine = placement(html).get('delivered').html;
  /* Same markup, so the handlers renderBoard wires — the click that opens the
     drawer, the dragstart — find it the same way. Nothing special-cases this
     column, which is what makes "behaves like any other card" true rather than
     re-implemented. */
  assert.match(mine, /<div class="card [^"]*" draggable="true" data-id="f1">/);

  const src = grab('function renderBoard()');
  assert.match(src, /document\.querySelectorAll\('\.card'\)\.forEach\(c=>c\.addEventListener\('click'/);
  /* AND A DRAG CANNOT WRITE THE PSEUDO-COLUMN AS A STATUS. The drop handler only
     moves between FREE statuses, and 'outsource_delivered' is not one of them,
     so a card dropped on or dragged out of this column gets the existing toast
     rather than a PATCH with a status that does not exist. */
  assert.match(src, /const FREE = \['not_started','assigned','in_progress'\];/);
  assert.ok(!workflow.STATE_IDS.includes('outsource_delivered'),
    'the superseded column id is deliberately not a status');
  /* AND A DRAG CANNOT MOVE IT OUT. 'delivered' is not in FREE, so the card is
     draggable and every drop involving it gets the existing toast — the reversal
     is the only way back, and it is permission-gated. */
  assert.ok(!['not_started', 'assigned', 'in_progress'].includes('delivered'));
});

// ---------------------------------------------------------------------------
// The half-migrated filter: the lens, the counts, the band.
// ---------------------------------------------------------------------------

test('the Art/Animation lens filters the Delivered column too, and its counts include it', () => {
  const assets = [
    deliveredByFreelancer(),                                            // character -> Art
    deliveredByFreelancer({ id: 'f2', code: 'ANM-001', type: 'animation' }), // -> Animation
    ordinary('o1', 'in_progress'),
  ];

  const art = renderBoard({ assets, lensId: 'art' });
  assert.deepStrictEqual(columnsOf(art, 'f1'), ['delivered'], 'the Art one shows');
  assert.strictEqual(columnsOf(art, 'f2').length, 0, 'the Animation one does not');
  assert.strictEqual(placement(art).get('delivered').count, 1,
    'and the Delivered count follows the lens');

  const anim = renderBoard({ assets, lensId: 'animation' });
  assert.deepStrictEqual(columnsOf(anim, 'f2'), ['delivered']);
  assert.strictEqual(columnsOf(anim, 'f1').length, 0);
  assert.strictEqual(placement(anim).get('delivered').count, 1);

  /* THE SUB-TAB COUNTS INCLUDE DELIVERED WORK. This is the half-migration shape:
     a count built from a pool the new column was excluded from would say
     "Animation (0)" above a board holding one. */
  assert.match(art, /Animation <span class="sub-tab-count">1<\/span>/);
  assert.match(art, /Art <span class="sub-tab-count">2<\/span>/);

  /* AND THE LENS IS STILL ONLY IN renderBoard. filteredAssets() is shared with
     the Assets List, which has its own sub-tabs; a lens in there would narrow a
     different tab nobody asked to filter. */
  const helper = grab('function filteredAssets()');
  assert.ok(!/boardLens|BOARD_LENS/.test(helper), 'the shared helper knows nothing of the lens');
  assert.ok(!/outsourced_to|outsource_delivered/.test(helper),
    'nor of outsourcing at all — the Assets List groups by status and is untouched');
});

test('the stats band agrees with the board, and still ignores its filters', () => {
  const statsSource = [
    COLUMN_SOURCE,
    grab('function renderStats()'),
  ].join('\n');
  const run = (assets, { search = '', filterType = '' } = {}) => {
    let html = '';
    const node = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
    const sandbox = {
      document: { getElementById: () => node },
      state: { view: 'board', assets, search, filterType },
      visibleStatuses: () => PAGE_STATUSES,
      // If renderStats ever consulted these, the assertions below would catch it.
      filteredAssets: () => { throw new Error('the band must not read the board filters'); },
      boardLensMatch: () => { throw new Error('the band must not read the lens'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${statsSource}\n;__run = renderStats;`, sandbox);
    sandbox.__run();
    return html;
  };

  const assets = [deliveredByFreelancer(), ordinary('o1', 'pending_tl_review'),
    ordinary('o2', 'delivered')];
  const html = run(assets);

  assert.match(html, /<div class="num">3<\/div><div class="lbl">Assets<\/div>/,
    'the delivered freelancer asset is counted in the project total');
  /* THE SAME VOCABULARY THE BOARD USES — which is now simply the statuses, so
     the band and the board agree without either having to be told about
     outsourcing. Two in Delivered: the freelancer's and the studio's own. */
  assert.match(html, /<div class="num"[^>]*>2<\/div><div class="lbl">Delivered<\/div>/);
  assert.match(html, /<div class="num"[^>]*>1<\/div><div class="lbl">TL Review<\/div>/,
    'and TL Review counts only the artist\'s own submission');
  assert.ok(!/Back from Freelancer/.test(html), 'the superseded tile is gone');

  /* FINAL % NOW INCLUDES OUTSOURCED DELIVERIES, and that is a consequence of the
     re-pointing worth pinning: the tile is the share of the project in the
     'delivered' STATUS, and a freelancer's work that the studio has attested was
     handed over really is finished. Two of three. */
  assert.match(html, /<div class="num">67%<\/div><div class="lbl">Final<\/div>/);

  /* INDEPENDENT OF THE BOARD'S FILTERS, which is what makes it a project
     summary. The stubs above throw if it reaches for either, and the pool is
     state.assets raw. */
  const narrowed = run(assets, { search: 'nothing matches', filterType: 'fx' });
  assert.strictEqual(narrowed, html, 'a search and a type filter change nothing here');
  const band = grab('function renderStats()');
  assert.match(band, /const pool = state\.assets;/, 'it reads the raw list');
});

// ---------------------------------------------------------------------------
// The Admin Dashboard, as a consumer.
// ---------------------------------------------------------------------------

test('the Admin Dashboard needed no split at all', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin-dashboard.js'), 'utf8');
  /* SUPERSEDED, AND REVERTED. For two commits this split pending_tl_review into
     TL Review and Back from Freelancer. The delivery now targets 'delivered', a
     status the panel has always counted, so the figure needs no splitting: one
     GROUP BY counts an outsourced delivery exactly as it counts everything else. */
  assert.match(src, /function pipelineRows\(\) \{\n\s*return workflow\.STATES\.map/,
    'one row per status, from the workflow');
  assert.ok(!/OUTSOURCE_DELIVERED_COLUMN/.test(src),
    'and the superseded column is not referenced here any more');
  assert.ok(!/backFromFreelancer/.test(src), 'nor is the split it needed');

  /* THE ROW BUILDER STAYS, though, because extracting it fixed a real bug:
     empty() built its pipeline from workflow.STATES while stageCounts() built the
     split list, so a viewer with no projects saw twelve rows and one with a
     project saw thirteen — the panel changed shape with the workload. */
  assert.match(src, /pipeline: pipelineRows\(\),/, 'empty() uses it');
  assert.match(src, /const blank = pipelineRows\(\);/, 'and so does the counted one');

  /* AND THE FOUR READS OF ASSETS, each named with what happened to it:
       stageCounts   back to one row per status; an outsourced delivery lands in
                     the Delivered row.
       waitingCounts UNCHANGED, and it now stops counting the task — a delivered
                     asset is in neither REVIEW_STATES nor CLIENT_STATES, which
                     is right: nobody is waiting on it.
       lateRows      UNCHANGED, and it now EXCLUDES the task, because 'delivered'
                     is DONE_STATES. A delivered task cannot be overdue.
       upcoming      UNCHANGED, for the same reason.
     None of the four needed editing for this change; all four changed answer,
     which is what re-pointing at an existing status buys. */
  assert.match(src, /const DONE_STATES = \['delivered'\];/);
  assert.match(src, /const REVIEW_STATES = \['pending_tl_review', 'pending_cd_review'\];/);
});


// ---------------------------------------------------------------------------
// THE SKIPPED STAGES, and what downstream makes of them.
// ---------------------------------------------------------------------------

test('nothing downstream assumes Delivered was reached through the pipeline', () => {
  /* THE DELIBERATE CHOICE THIS GUARDS. An outsourced task marked delivered from
     In Progress jumps TL Review, TL Approved, CD Review, Approved for Client and
     Awaiting Client Feedback in one move. Every consumer that could have assumed
     otherwise is listed here with the reason it tolerates the absence — and
     NOTHING was back-filled: no fake review round, no invented
     awaiting_client_feedback step, no synthetic 'deliver' event. */

  /* 1. THE EFFICIENCY REPORT excludes outsourced work by name, before it asks
        anything about submissions or hours — so no average, hour total or
        turnaround figure moves. This is the one that matters most, because it is
        the only report that divides by hours. */
  const reports = require('../src/reports');
  assert.strictEqual(
    reports.exclusionReason({ outsourced: true, submitted: false, manHours: 24, totalSeconds: 0 }),
    'outsourced — no tracked time');
  const prepared = reports.prepare([
    { id: 'f1', code: 'CHR-002', name: 'Lantern', outsourced: true, submitted: false,
      manHours: 24, totalSeconds: 0, firstPassSeconds: 0 },
  ]);
  assert.strictEqual(prepared.included.length, 0, 'it reaches no average');
  assert.deepStrictEqual(prepared.excluded.map((x) => x.reason), ['outsourced — no tracked time']);

  /* 2. TURNAROUND TIMESTAMPS. finishedAt COALESCEs the last 'deliver' EVENT then
        the last submitted version. This action is 'outsource_delivered', and an
        outsourced task has no versions — so finishedAt is NULL and a
        date-filtered report simply does not include the row, which is the same
        answer the exclusion above already gives. Pinned as source because the
        tolerance is in the COALESCE, and a change to either arm would alter it. */
  const reportRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  assert.match(reportRoute, /WHERE e\.asset_id = a\.id AND e\.action = 'deliver'/,
    'the turnaround date keys on the client delivery event, not on this one');
  assert.ok(!/action = 'outsource_delivered'/.test(reportRoute),
    'and no synthetic event was invented to satisfy it');
  assert.match(reportRoute, /submitted: Number\(r\.rounds\) > 0,/,
    'review counts are COUNT(asset_versions), which is 0 and reads as never submitted');

  /* 3. FEEDBACK ROUNDS are rows in `feedback`, written by the review routes.
        None exists for an outsourced delivery and none is required; nothing reads
        `feedback` expecting a row per delivered asset. */
  const workflowSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  assert.match(workflowSrc, /feedback rounds/, 'the decision is recorded beside the transition');

  /* 4. THE P&L sums work_sessions on delivered assets. An outsourced task has
        none, so it adds nought HOURS — and the agreed hours and their cost come
        from outsource.costFor() instead, which is where an outsourced figure
        belongs. So "delivered with no sessions" is a shape the P&L already had. */
  const pnl = fs.readFileSync(path.join(__dirname, '..', 'src', 'pnl-hours.js'), 'utf8');
  assert.match(pnl, /const DELIVERED = 'delivered';/);
  assert.match(pnl, /if \(!workflow\.STATE_IDS\.includes\(DELIVERED\)\)/,
    'and it checks the state exists rather than assuming a path to it');

  /* 5. THE PROJECT LIFECYCLE counts anything not 'delivered' as unfinished, so an
        outsourced delivery now lets a project be closed. That is correct under
        the new meaning — the studio has attested the work went out — and is the
        one consumer whose ANSWER changes rather than staying the same. */
  const lifecycle = fs.readFileSync(path.join(__dirname, '..', 'src', 'lifecycle.js'), 'utf8');
  assert.match(lifecycle, /const ASSET_DONE = 'delivered';/);

  /* 6. DEV & QA can raise a bug on it: IDLE_STATUSES includes 'delivered' and an
        outsourced task has no open round, so a bug pulls it into Game Feedback.
        Correct under the new meaning — it shipped and came back — and nothing had
        to change for it. */
  const integration = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'integration.js'), 'utf8');
  assert.match(integration, /const IDLE_STATUSES = \['delivered', 'approved_for_client'\];/);
});

test('the superseded destination is unreachable, and nothing else uses it', () => {
  /* THE BRIEF'S QUESTION: does Back from Freelancer remain for any legitimate
     use? NO. It claimed assets in pending_tl_review whose assignment was
     delivered, and that combination is no longer produced, so nothing can reach
     it. It is listed in no extras array, drawn on no screen, counted in no panel. */
  const col = workflow.OUTSOURCE_DELIVERED_COLUMN;
  assert.ok(col, 'the constant is still defined, so the decision stays readable');
  assert.strictEqual(col.from, 'pending_tl_review',
    'and records which status the old delivery landed in, which the audit query looks for');
  assert.notStrictEqual(workflow.transitionFor('outsource_delivered').to, col.from,
    'the delivery no longer lands there, so the column can never claim anything');

  // NOT a status, so there is no state to retire and no row to rewrite.
  assert.ok(!workflow.STATE_IDS.includes(col.id));

  // Nothing renders it.
  const extras = new Function(`${COLUMN_SOURCE}; return BOARD_EXTRA_COLUMNS;`)();
  assert.deepStrictEqual(extras, []);
  const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin-dashboard.js'), 'utf8');
  assert.ok(!/OUTSOURCE_DELIVERED_COLUMN/.test(dash));

  /* THE CARD'S FREELANCER LINE SURVIVED IT, re-keyed on the assignment rather
     than on the column — which is the question the line was really asking. */
  const card = grab('function cardHTML(a)');
  assert.match(card, /a\.outsourced_to && a\.outsourced_to\.stage === 'delivered'/,
    'the line asks the assignment, not a column');
  assert.ok(!/boardColumnOf\(a\) === 'outsource_delivered'/.test(card),
    'and no longer asks a column that cannot exist');
});

// ---------------------------------------------------------------------------
// Against a live server: the data the board reads, and freshness.
// ---------------------------------------------------------------------------

test('from the Outsource tab to the board', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'bd-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'bd-token', name: 'Priya', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    // The clock opened wide: nothing here records time, and the shipped lunch
    // blackout has broken suites that assert about sessions.
    await openStudio(server.base, tok.root);
    const clientId = (await as('root', '/clients')).body.clients[0].id;
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Board', clientId } })).body.project.id;
    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Ravi K.', discipline: 'rigging' } });
    id.freelancer = fl.body.freelancer.id;
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('THE REPORTED SCENARIO: In Progress, delivered, and on the board in Delivered', async () => {
    const asset = (await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Lantern Keeper', type: 'character', manHours: 24 } })).body.asset;
    const assignment = (await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: id.freelancer, projectId: id.project, assetId: asset.id,
        decidedManHours: 24 } })).body.assignment;

    /* THE EXACT SCENARIO FROM THE REPORT: the card is dragged to In Progress on
       the board — a free move that asks nothing about outsourcing — and then the
       work comes back and is marked delivered. */
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
    const before = (await as('root', `/assets/project/${id.project}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(before.status, 'in_progress');
    assert.strictEqual(before.outsourced_to.stage, 'with_freelancer');
    assert.deepStrictEqual(columnsOf(renderBoard({ assets: [before] }), asset.id), ['in_progress']);

    // Marked delivered on the Outsource tab.
    const r = await as('root', '/assets/bulk/outsource-stage', { method: 'POST',
      body: { stage: 'delivered', assignmentIds: [assignment.id] } });
    assert.strictEqual(r.body.succeeded, 1, JSON.stringify(r.body.results));

    /* AFTER, AND THIS IS THE FRESHNESS TEST. The board holds no cache: setTab()
       ends in render(), and render() calls loadAssets() for the board and the
       list every time — so switching to the Dashboard refetches from the server
       and cannot show a stale state. What loadAssets() would receive is exactly
       this request, and it is enough to place the card. */
    const after = (await as('root', `/assets/project/${id.project}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(after.status, 'delivered', 'the status the delivery sets');
    assert.strictEqual(after.outsourced_to.stage, 'delivered');
    assert.strictEqual(after.outsourced_to.freelancerName, 'Ravi K.');
    assert.ok(after.outsourced_to.deliveredAt, 'with the date the card prints');
    assert.strictEqual(after.time_spent_seconds, 0, 'and no tracked time to show');

    const html = renderBoard({ assets: [after] });
    assert.deepStrictEqual(columnsOf(html, asset.id), ['delivered'],
      'the board shows it in Delivered on the next refresh, with no reload');
    assert.match(placement(html).get('delivered').html, /Ravi K\./,
      'and the card still says whose work it was');
    assert.ok(!/Back from Freelancer/.test(html));

    /* THE MECHANISM, PINNED. If render() ever started drawing the board from a
       cache, this is the line that would have to change. */
    const render = grab('async function render()');
    assert.match(render, /if\(state\.view==='board' \|\| state\.view==='list'\)\{ await loadAssets\(\); \}/);
    assert.match(grab('function setTab(tab)'), /render\(\);/);
  });

  await t.test('the Admin Dashboard counts it once, and as Delivered', async () => {
    const d = await as('root', '/admin-dashboard');
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const row = (id2) => (d.body.pipeline || []).find((s) => s.id === id2);
    assert.strictEqual(row('delivered').count, 1, 'counted in the Delivered row');
    assert.strictEqual(row('pending_tl_review').count, 0, 'and not in TL Review');
    assert.strictEqual(row('in_progress').count, 0, 'nor where the card used to sit');
    assert.strictEqual((d.body.pipeline || []).reduce((n, s) => n + s.count, 0), 1,
      'the panel adds up to the number of assets — counted once');
    assert.strictEqual((d.body.pipeline || []).length, workflow.STATE_IDS.length,
      'one row per status; the superseded row is gone');
    assert.ok(!(d.body.pipeline || []).some((s) => s.id === 'outsource_delivered'));

    /* NOT WAITING ON ANYBODY, which is the inverse of what this asserted when the
       delivery landed in TL Review — and is right for the same reason it was
       right then. A delivered task is in neither REVIEW_STATES nor CLIENT_STATES.
       Nothing in the dashboard changed; the status did. */
    const waiting = (d.body.attention || []).find((a) => /waiting on review/.test(a.label || ''));
    assert.ok(!waiting || Number(waiting.count) === 0,
      `a delivered task is not waiting on a reviewer: ${JSON.stringify(d.body.attention)}`);
  });
});
