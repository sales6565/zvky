/* THE DASHBOARD'S "Back from Freelancer" COLUMN.
 *
 * "Dashboard" IS TWO THINGS IN THIS APPLICATION and the mix-up has happened
 * before, so: this file is about the tab labelled Dashboard, which is the
 * per-project BOARD (data-tab="board", renderBoard()). The permission-gated
 * ADMIN Dashboard is a different screen and is treated here as a CONSUMER —
 * src/admin-dashboard.js reads assets in four places and one of them had to
 * learn the same split.
 *
 * WHAT WAS TRUE BEFORE THIS, established by reproduction rather than assumed:
 * a freelancer-delivered asset holds status pending_tl_review — a REAL workflow
 * status — so it sat in the TL Review column beside an artist's own submission,
 * in exactly one column, visible. Nothing vanished. What was missing was any
 * sign that it had come from outside: the card's only difference was an empty
 * avatar slot, which reads as "nobody has picked this up" about work that has
 * been done and handed back.
 *
 * "DELIVERED" IS NOT THE ASSET'S STATUS. The asset holds pending_tl_review and
 * the ASSIGNMENT holds 'delivered' (outsource_assignments.status, with
 * delivered_by and delivered_at). There is also a `delivered` asset status and
 * it is the OPPOSITE end of the pipeline — the client has the work — which is
 * why this column is NOT called Delivered. Two columns under one word meaning
 * near opposites is the confusion the README's "Two permissions called Mark as
 * Delivered" exists to prevent.
 *
 * THE RISK THIS FILE IS REALLY ABOUT is the half-migrated filter, the shape
 * behind the canHandOverInReview and REWORK_STATUSES gaps: a column added to
 * the cards but not to the counts, or a lens applied to the old columns and not
 * the new one. So the board is RENDERED with the page's own function and the
 * output is read, and the property test at the end fails if ANY status the
 * server can set stops mapping to exactly one column.
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
const backFromFreelancer = (over = {}) => ({
  id: 'f1', code: 'CHR-002', name: 'Lantern Keeper', type: 'character',
  status: 'pending_tl_review', assignee_id: null, assignee_name: null,
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

test('a freelancer-delivered asset is in Back from Freelancer and in no other column', () => {
  const html = renderBoard({ assets: [backFromFreelancer(), ordinary('o1', 'pending_tl_review')] });
  const cols = placement(html);

  assert.deepStrictEqual(columnsOf(html, 'f1'), ['outsource_delivered'],
    'exactly one column, and it is the new one');
  assert.deepStrictEqual(columnsOf(html, 'o1'), ['pending_tl_review'],
    'and the artist\'s own submission stays where it was');

  // The counts are of the cards actually in each column, not of the status.
  assert.strictEqual(cols.get('outsource_delivered').count, 1);
  assert.strictEqual(cols.get('pending_tl_review').count, 1);

  /* THE HEADER IS NOT "Delivered". `delivered` is a status meaning the client
     has the work, and it has its own column further along — two columns under
     one word would be the confusion this whole feature had to avoid. */
  assert.match(cols.get('outsource_delivered').html, /<span class="title">Back from Freelancer<\/span>/);
  assert.ok(cols.has('delivered'), 'the client Delivered column is still there');
  assert.notStrictEqual(workflow.OUTSOURCE_DELIVERED_COLUMN.label, 'Delivered');
});

test('the column sits straight after TL Review, not last', () => {
  const html = renderBoard({ assets: [backFromFreelancer()] });
  const order = [...placement(html).keys()];
  assert.strictEqual(order[order.indexOf('pending_tl_review') + 1], 'outsource_delivered',
    'beside the queue it is waiting in');
  /* NOT LAST, and that is a decision against the brief's recommendation. This
     work is waiting on a team lead and leaves the column the moment one acts, so
     it is not an end state; filing it past three approval stages and next to the
     client's finished work is where it would stop being noticed. */
  assert.notStrictEqual(order[order.length - 1], 'outsource_delivered');
  assert.strictEqual(order[order.length - 1], 'delivered',
    'the last column is still the client delivery, which IS an end state');
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

test('the claim needs BOTH halves, so the card moves on when a lead acts', () => {
  const fn = new Function(`${COLUMN_SOURCE}; return { boardColumnOf, BOARD_EXTRA_COLUMNS };`)();

  const delivered = backFromFreelancer();
  assert.strictEqual(fn.boardColumnOf(delivered), 'outsource_delivered');

  /* A LEAD APPROVES IT. The review does not touch the assignment, so the stage
     is STILL 'delivered' — and claiming on the stage alone would hold this card
     in the column for ever and it would never appear in TL Approved. */
  const approved = backFromFreelancer({ status: 'tl_approved' });
  assert.strictEqual(approved.outsourced_to.stage, 'delivered', 'the assignment has not changed');
  assert.strictEqual(fn.boardColumnOf(approved), 'tl_approved',
    'but the card has moved on, because the claim asks about the status too');

  // Still with the freelancer, or completed but not handed back: its own status.
  assert.strictEqual(fn.boardColumnOf(backFromFreelancer({
    status: 'not_started', outsourced_to: { stage: 'with_freelancer' } })), 'not_started');
  assert.strictEqual(fn.boardColumnOf(backFromFreelancer({
    status: 'not_started', outsourced_to: { stage: 'completed' } })), 'not_started');
  // Reopened: the assignment goes back to with_freelancer and the task to Not Assigned.
  assert.strictEqual(fn.boardColumnOf(ordinary('x', 'not_started')), 'not_started');
  // And nothing at all is not a column.
  assert.strictEqual(fn.boardColumnOf(null), null);

  /* THE COLUMN'S VOCABULARY COMES FROM THE SERVER, so the board and the Admin
     Dashboard cannot name the same thing differently. */
  const col = workflow.OUTSOURCE_DELIVERED_COLUMN;
  const [onPage] = fn.BOARD_EXTRA_COLUMNS;
  assert.strictEqual(onPage.id, col.id);
  assert.strictEqual(onPage.label, col.label);
  assert.strictEqual(onPage.color, col.color);
  assert.strictEqual(onPage.after, col.after);
  /* AND THE STATUS IT CLAIMS OUT OF IS THE ONE THE DELIVERY LANDS IN. If the
     transition ever moved, this fails rather than the column silently emptying. */
  assert.strictEqual(col.from, workflow.transitionFor('outsource_delivered').to);
  // No stage colour is the brand red.
  assert.ok(!/7f1416/i.test(col.color));
});

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

test('the card says whose work it is and when, and shows no hours', () => {
  const html = renderBoard({ assets: [backFromFreelancer(), ordinary('o1', 'pending_tl_review')] });
  const mine = placement(html).get('outsource_delivered').html;

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
  const withDue = renderBoard({ assets: [backFromFreelancer({ due_date: '2026-11-02' })] });
  assert.match(placement(withDue).get('outsource_delivered').html, /CHR-002 · /,
    'a due date still prints');
});

test('a card in the new column opens and drags exactly like any other', () => {
  const html = renderBoard({ assets: [backFromFreelancer()] });
  const mine = placement(html).get('outsource_delivered').html;
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
    'the column id is deliberately not a status');
});

// ---------------------------------------------------------------------------
// The half-migrated filter: the lens, the counts, the band.
// ---------------------------------------------------------------------------

test('the Art/Animation lens filters the new column too, and its counts include it', () => {
  const assets = [
    backFromFreelancer(),                                            // character -> Art
    backFromFreelancer({ id: 'f2', code: 'ANM-001', type: 'animation' }), // -> Animation
    ordinary('o1', 'in_progress'),
  ];

  const art = renderBoard({ assets, lensId: 'art' });
  assert.deepStrictEqual(columnsOf(art, 'f1'), ['outsource_delivered'], 'the Art one shows');
  assert.strictEqual(columnsOf(art, 'f2').length, 0, 'the Animation one does not');
  assert.strictEqual(placement(art).get('outsource_delivered').count, 1,
    'and the column count follows the lens');

  const anim = renderBoard({ assets, lensId: 'animation' });
  assert.deepStrictEqual(columnsOf(anim, 'f2'), ['outsource_delivered']);
  assert.strictEqual(columnsOf(anim, 'f1').length, 0);
  assert.strictEqual(placement(anim).get('outsource_delivered').count, 1);

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
    'nor of the new column — the Assets List groups by status and is untouched');
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

  const assets = [backFromFreelancer(), ordinary('o1', 'pending_tl_review'),
    ordinary('o2', 'delivered')];
  const html = run(assets);

  assert.match(html, /<div class="num">3<\/div><div class="lbl">Assets<\/div>/,
    'the delivered freelancer asset is counted in the project total');
  /* THE SAME VOCABULARY THE BOARD USES. The band sits directly above the board
     on the same tab, so "TL Review 1" over an empty TL Review column is exactly
     the drift this is about. */
  assert.match(html, /<div class="num"[^>]*>1<\/div><div class="lbl">Back from Freelancer<\/div>/);
  assert.match(html, /<div class="num"[^>]*>1<\/div><div class="lbl">TL Review<\/div>/,
    'and TL Review counts only the artist\'s own submission');

  // Final % is still a share of the `delivered` STATUS — the client's end.
  assert.match(html, /<div class="num">33%<\/div><div class="lbl">Final<\/div>/);

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

test('the Admin Dashboard splits the same figure the same way', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin-dashboard.js'), 'utf8');
  /* ONE VOCABULARY. The panel takes the id, label, colour and position from the
     workflow, like the board does, so the two screens cannot name it
     differently or place it differently. */
  assert.match(src, /const col = workflow\.OUTSOURCE_DELIVERED_COLUMN;/);
  /* ONE BUILDER FOR THE ROWS, and this is the bug it was extracted for: empty()
     built its pipeline from workflow.STATES while stageCounts() built the split
     one, so a viewer with no projects got twelve rows and a viewer with one got
     thirteen — the panel changed shape depending on how much work there was. */
  assert.match(src, /function pipelineRows\(\) \{/, 'the rows come from one function');
  assert.match(src, /if \(s\.id === col\.after\) rows\.push\(/, 'spliced in after its anchor');
  assert.match(src, /pipeline: pipelineRows\(\),/, 'and empty\(\) uses it too');
  assert.match(src, /const blank = pipelineRows\(\);/, 'as does the counted one');
  /* COUNTED ONCE: the row it is added to is the row it is taken out of. */
  assert.match(src, /if \(s\.id === col\.from\) return \{ \.\.\.s, count: \(counts\.get\(s\.id\) \|\| 0\) - backOut \};/);

  /* AND THE FOUR READS OF ASSETS, each named with what happened to it:
       stageCounts   SPLIT, above.
       waitingCounts LEFT ALONE — it answers "what is sitting with somebody for a
                     decision", and this work is. Not double counting: a
                     different question.
       lateRows      LEFT ALONE — excludes DONE_STATES ('delivered'), and a
                     freelancer hand-back is not done; if it is overdue it is
                     overdue.
       upcoming      LEFT ALONE, for the same reason. */
  assert.match(src, /const DONE_STATES = \['delivered'\];/,
    'done still means the client has it, which this is not');
  assert.match(src, /const REVIEW_STATES = \['pending_tl_review', 'pending_cd_review'\];/,
    'and work back from a freelancer is still waiting on a reviewer');
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

  await t.test('the asset the board fetches carries what the column needs', async () => {
    const asset = (await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Lantern Keeper', type: 'character', manHours: 24 } })).body.asset;
    const assignment = (await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: id.freelancer, projectId: id.project, assetId: asset.id,
        decidedManHours: 24 } })).body.assignment;

    /* BEFORE: with the freelancer, so the board shows it in Not Assigned. */
    const before = (await as('root', `/assets/project/${id.project}`)).body.assets
      .find((a) => a.id === asset.id);
    assert.strictEqual(before.status, 'not_started');
    assert.strictEqual(before.outsourced_to.stage, 'with_freelancer');
    assert.deepStrictEqual(columnsOf(renderBoard({ assets: [before] }), asset.id), ['not_started']);

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
    assert.strictEqual(after.status, 'pending_tl_review', 'the status the delivery sets');
    assert.strictEqual(after.outsourced_to.stage, 'delivered');
    assert.strictEqual(after.outsourced_to.freelancerName, 'Ravi K.');
    assert.ok(after.outsourced_to.deliveredAt, 'with the date the card prints');
    assert.strictEqual(after.time_spent_seconds, 0, 'and no tracked time to show');

    const html = renderBoard({ assets: [after] });
    assert.deepStrictEqual(columnsOf(html, asset.id), ['outsource_delivered'],
      'the board puts it in the new column on the next refresh, with no reload');
    assert.match(placement(html).get('outsource_delivered').html, /Ravi K\./);

    /* THE MECHANISM, PINNED. If render() ever started drawing the board from a
       cache, this is the line that would have to change. */
    const render = grab('async function render()');
    assert.match(render, /if\(state\.view==='board' \|\| state\.view==='list'\)\{ await loadAssets\(\); \}/);
    assert.match(grab('function setTab(tab)'), /render\(\);/);
  });

  await t.test('the Admin Dashboard counts it once, and as Back from Freelancer', async () => {
    const d = await as('root', '/admin-dashboard');
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const row = (id2) => (d.body.pipeline || []).find((s) => s.id === id2);
    assert.strictEqual(row('outsource_delivered').count, 1, 'counted as its own row');
    assert.strictEqual(row('pending_tl_review').count, 0,
      'and taken out of TL Review, so nothing is counted twice');
    assert.strictEqual((d.body.pipeline || []).reduce((n, s) => n + s.count, 0), 1,
      'the panel still adds up to the number of assets');
    /* NOT IN PROGRESS, which it never was — this panel counts by status and
       in_progress is its own row. Pinned so a later change cannot fold it in. */
    assert.strictEqual(row('in_progress').count, 0);

    /* STILL WAITING ON A REVIEWER, deliberately. A different question from the
       pipeline's, and the honest answer to it is yes. */
    const waiting = (d.body.attention || []).find((a) => /waiting on review/.test(a.label));
    assert.ok(waiting && waiting.count === 1,
      `it is still counted as waiting on review: ${JSON.stringify(d.body.attention)}`);

    // The label the dashboard prints is the label the board prints.
    assert.strictEqual(row('outsource_delivered').label, workflow.OUTSOURCE_DELIVERED_COLUMN.label);
  });
});
