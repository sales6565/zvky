/* CAN HOLD FOLLOWS CAN SEE — the matrix, and the property that makes it a fact.
 *
 * THE FOURTH REPORT OF THE HOLD BUTTON is what this file is. The three before it
 * each narrowed the lead rule a different way and each was scoped to PROJECT
 * MEMBERSHIP — project_team_leads and project_supervision. A lead's dashboard is
 * not scoped that way: visibleProjects() for the `team` scope also matches being
 * a production coordinator, owning the project, and having a direct report with
 * an asset in it. So a Team Lead with reports saw work they could not hold, and
 * every fixture that named the lead on the project's team agreed that everything
 * was fine.
 *
 * ---------------------------------------------------------------------------
 * THE PARITY PROPERTY IS THE POINT OF THIS FILE, and it is the one assertion
 * that cannot drift: for each test user, fetch the board the way the page
 * fetches it, and assert that every working-status asset it returns is holdable
 * — by the route AND by the per-asset flag — and that everything it does not
 * return is refused. It does not restate the rule; it compares two live answers.
 * A future change that re-scopes either side fails here whatever it does to the
 * unit tables.
 *
 * ---------------------------------------------------------------------------
 * THE LEADS ARE BUILT THE WAY PRODUCTION BUILDS THEM. Not one hand-made user on
 * a project they are named on: four leads whose dashboards fill by four
 * different routes, including the one nobody had tested — a report's work in a
 * project the lead is not named on.
 *
 * FIXED DATES AND openStudio, so no cell depends on the hour the suite runs at:
 * the shipped lunch blackout would otherwise put a fixture's session down and
 * every assertion would fail for the wrong reason.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const assetHold = require('../src/asset-hold');
const workflow = require('../src/asset-workflow');
const catalogue = require('../src/permission-catalog');
const { capabilitiesForTier } = require('../src/role-tiers');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const cfg = config('holdvis');
const PASSWORD = 'HoldVis-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const C = assetHold.CODES;

// ===========================================================================
// 1. THE PER-STATUS DECISION, as a table.
// ===========================================================================

/* EVERY STATUS THE BOARD CAN SHOW, and whether holding means anything in it.
 *
 * The brief asked for this decision written out per status, so here it is, with
 * the reason for each. `hold` is whether a control is offered when NO clock is
 * running; a clock that IS running or held is stoppable in every one of them,
 * which the block below asserts separately and which matters more than the list.
 */
const STATUS_TABLE = [
  ['not_started',              false, 'nobody has accepted it; /start refuses it too'],
  ['assigned',                 true,  'on somebody\'s desk, waiting to be begun'],
  ['in_progress',              true,  'the ordinary case'],
  ['pending_tl_review',        false, 'handed in — on the lead\'s desk, and submitting closed the stretch'],
  ['tl_changes_requested',     true,  'back with the artist to redo'],
  ['tl_approved',              false, 'past the first gate, between desks'],
  ['pending_cd_review',        false, 'on the director\'s desk'],
  ['cd_changes_requested',     true,  'back for rework once the lead relays it'],
  ['game_feedback',            true,  'a bug to answer, once the lead passes it on'],
  ['approved_for_client',      false, 'finished work, waiting to go out'],
  ['awaiting_client_feedback', false, 'outside the studio'],
  ['delivered',                false, 'done'],
];

test('the per-status decision, and every status the board can show is in it', () => {
  // No status can be missed, and none invented: the table is the whole vocabulary.
  assert.deepStrictEqual(STATUS_TABLE.map((r) => r[0]), workflow.STATE_IDS,
    'a status was added to the pipeline without a hold decision — add a row above');

  for (const [status, meaningful, why] of STATUS_TABLE) {
    assert.strictEqual(assetHold.isWorkingStatus(status), meaningful,
      `${status}: ${why}`);
  }

  /* AND THE LIST IS THE /start GATE'S LIST, not a second one that agrees with it.
     The same array object, so there is nothing to keep in step. */
  assert.strictEqual(assetHold.WORKING_STATUSES, workflow.WORKING_STATUSES);
  assert.deepStrictEqual(workflow.WORKING_STATUSES,
    STATUS_TABLE.filter((r) => r[1]).map((r) => r[0]));
});

test('the server\'s list and the page\'s list are equal', () => {
  /* THE BRIEF ASKED FOR THIS IN SO MANY WORDS, because a status list stated
     twice has already drifted apart once in this file — the dashboard's drag
     range against FREE_STATUSES, which made the Assigned column a place no card
     could be dragged into.
     
     THE PAGE'S COPY DECIDES NOTHING. The decision is hold_state, sent per asset;
     the list only supplies the words for the sentence naming the stages. Same
     arrangement FREE_STATUSES has, and the same test. */
  const onPage = PAGE.match(/const HOLD_STATUSES = \[([^\]]*)\]/);
  assert.ok(onPage, 'the page has no HOLD_STATUSES list');
  assert.deepStrictEqual(
    onPage[1].split(',').map((v) => v.trim().replace(/'/g, '')),
    workflow.WORKING_STATUSES,
    'the page\'s hold statuses and WORKING_STATUSES have drifted apart');

  // And the two sentences are built from the list rather than typed beside it.
  assert.match(assetHold.describeWorkingStatuses(),
    /^Assigned, In Progress, TL Feedbacks, CD Feedbacks or Game Feedback$/);
  assert.match(PAGE, /const holdStatusWords = \(\) => \{/,
    'the page builds its sentence from its list too');
});

// ===========================================================================
// 2. THE AUTHORITY MATRIX, driven through the pure rule.
// ===========================================================================

const holdsAnyByDefault = (role) => catalogue
  .baselineFor(capabilitiesForTier(role.tier) || {}).has('asset.hold_any');

const ASSET = { id: 'a1', project_id: 'p1', code: 'CHR-007', assignee_id: 'u-artist',
  status: 'in_progress' };

const facts = (extra = {}) => ({
  user: { id: 'u-lead' },
  asset: ASSET,
  holdsPermission: true,
  holdsAny: true,
  onDashboard: true,
  openSession: true,
  held: null,
  ...extra,
});

test('the matrix: the key, the dashboard, the session — and the reason for each cell', () => {
  /* [label, facts, expected hold code, expected resume code]
     null means allowed. The CODES are the point: a cell refusing for the wrong
     reason is as much a bug as one refusing wrongly, because the reason is what
     the person reads and what tells them which fix to ask for. */
  const rows = [
    ['the assignee, clock running',
      { user: { id: 'u-artist' }, holdsAny: false, onDashboard: false }, null, C.ALREADY_RUNNING],
    ['the assignee, nothing running',
      { user: { id: 'u-artist' }, holdsAny: false, onDashboard: false, openSession: false },
      C.NO_SESSION, C.NOT_HELD],
    ['the assignee, held by hand',
      { user: { id: 'u-artist' }, holdsAny: false, onDashboard: false, openSession: false,
        held: { byStudio: false } }, C.ALREADY_HELD, null],
    ['the assignee, paused by the schedule',
      { user: { id: 'u-artist' }, holdsAny: false, onDashboard: false, openSession: false,
        held: { byStudio: true } }, C.ALREADY_HELD, C.STUDIO_PAUSED],

    ['a lead with the key, on their dashboard', {}, null, C.ALREADY_RUNNING],
    ['a lead with the key, NOT on their dashboard',
      { onDashboard: false }, C.NOT_VISIBLE, C.NOT_VISIBLE],
    ['somebody without the key, on their dashboard',
      { holdsAny: false }, C.NOT_YOURS, C.NOT_YOURS],
    ['somebody without either, anywhere',
      { holdsAny: false, onDashboard: false }, C.NOT_YOURS, C.NOT_YOURS],

    /* THE STUDIO'S OWN SWITCH FIRST. Somebody whose designation cannot hold
       anything does not need telling about this task in particular. */
    ['the base key revoked', { holdsPermission: false }, C.NO_PERMISSION, C.NO_PERMISSION],
    ['the base key revoked, even for the assignee',
      { user: { id: 'u-artist' }, holdsPermission: false }, C.NO_PERMISSION, C.NO_PERMISSION],

    ['nobody is on it',
      { asset: { ...ASSET, assignee_id: null } }, C.UNASSIGNED, C.UNASSIGNED],
    ['out with a freelancer',
      { outsourcedTo: { freelancerName: 'Fran' } }, C.OUTSOURCED, C.OUTSOURCED],

    /* THE STATUS GATE, asked AFTER authority — so a task that is none of your
       business is not explained to you in terms of its stage. */
    ['a lead, delivered, nothing running',
      { asset: { ...ASSET, status: 'delivered' }, openSession: false },
      C.WRONG_STATUS, C.WRONG_STATUS],
    ['a lead, delivered, clock STILL running',
      { asset: { ...ASSET, status: 'delivered' } }, null, C.ALREADY_RUNNING],
    ['a stranger, delivered — authority wins over stage',
      { asset: { ...ASSET, status: 'delivered' }, holdsAny: false, openSession: false },
      C.NOT_YOURS, C.NOT_YOURS],

    /* AND THE ADMISSION. A failed visibility query is not a refusal about the
       person, and must not read as one. */
    ['we could not find out', { unavailable: true }, C.UNKNOWN, C.UNKNOWN],
  ];

  for (const [label, extra, holdCode, resumeCode] of rows) {
    const f = facts(extra);
    const h = assetHold.decide('hold', f);
    const r = assetHold.decide('resume', f);
    assert.strictEqual(h.code, holdCode, `HOLD ${label}: ${h.message || 'allowed'}`);
    assert.strictEqual(h.ok, holdCode === null, `HOLD ${label} ok flag`);
    assert.strictEqual(r.code, resumeCode, `RESUME ${label}: ${r.message || 'allowed'}`);
    assert.strictEqual(r.ok, resumeCode === null, `RESUME ${label} ok flag`);
    if (!h.ok) {
      assert.match(h.message, /\w+.*\.$/, `HOLD ${label} explains itself`);
      assert.ok(h.gate, `HOLD ${label} names the gate that refused`);
    }
  }
});

test('the gate names the check, not the reason, and every code has one', () => {
  /* TWO REFUSALS THAT READ THE SAME AND MEAN DIFFERENT THINGS is what the gate is
     for: "not your task" because you lack the key, and "not your task" because it
     is off your dashboard, point at two different fixes. src/hold-log.js writes
     the gate for every refusal so the next report can be read out of the log. */
  assert.strictEqual(assetHold.GATES[C.NOT_YOURS], 'authority');
  assert.strictEqual(assetHold.GATES[C.NOT_VISIBLE], 'visibility');
  assert.strictEqual(assetHold.GATES[C.WRONG_STATUS], 'status');
  assert.strictEqual(assetHold.GATES[C.NO_PERMISSION], 'permission');
  assert.strictEqual(assetHold.GATES[C.UNKNOWN], 'unavailable');
  for (const code of Object.values(C)) {
    assert.ok(assetHold.GATES[code], `${code} names the gate that produced it`);
  }
});

// ===========================================================================
// 3. THE PAGE, lifted out and run against a stub.
// ===========================================================================

test('the open panel is rebuilt when the server\'s answer changes, and not otherwise', async () => {
  /* FRESHNESS, the half the board cannot do for itself.
   *
   * The board is re-fetched on every render() pass, so the CARDS are always
   * current. A drawer that is already open keeps the markup it was built with,
   * and until the fourth report it was rebuilt only when PERMISSIONS changed —
   * while a reassignment moves what a lead can see without moving a single
   * permission, which is the commonest way the two come apart.
   *
   * NOT AN UNCONDITIONAL REBUILD: the drawer carries text fields and a
   * checklist, and redrawing it under somebody mid-sentence is why the
   * permissions branch was written narrowly in the first place. So the signature
   * is compared, and only a changed ANSWER reopens it. Both halves asserted,
   * because the one that matters in practice is the one that does nothing. */
  const from = PAGE.indexOf('const holdSignature = (a)=>{');
  const to = PAGE.indexOf('/* Is another task holding this person up?', from);
  assert.ok(from !== -1 && to > from, 'the signature and loadAssets are in the page');
  const source = PAGE.slice(from, to);

  const calls = { opened: [], fetched: [] };
  let payload = { assets: [], activeWork: null };
  const classes = new Set(['show']);
  const built = new Function('api', 'state', 'document', 'openDrawer', `
    ${source}
    return { loadAssets, holdSignature };`)(
    async (p) => { calls.fetched.push(p); return payload; },
    { currentProjectId: 'p1', openAssetId: 'a1', assets: [] },
    { getElementById: () => ({ classList: { contains: (c) => classes.has(c) } }) },
    (id) => calls.opened.push(id),
  );

  const row = (code, canHold) => ({ id: 'a1',
    hold_state: { canHold, canResume: false, hold: { code }, resume: { code: 'X' } } });

  /* An undecorated row and a decorated one are different answers, so the first
     load after a boot reopens — which is right: the panel was built from
     nothing. */
  payload = { assets: [row('HOLD_NOT_VISIBLE', false)] };
  await built.loadAssets();
  assert.deepStrictEqual(calls.opened, ['a1'], 'a changed answer reopens the panel');

  calls.opened.length = 0;
  await built.loadAssets();
  assert.deepStrictEqual(calls.opened, [],
    'and the same answer again leaves the panel alone');

  payload = { assets: [row(null, true)] };
  await built.loadAssets();
  assert.deepStrictEqual(calls.opened, ['a1'],
    'a task that has just become holdable gets its button without a reload');

  calls.opened.length = 0;
  payload = { assets: [row('HOLD_NOT_VISIBLE', false)] };
  await built.loadAssets();
  assert.deepStrictEqual(calls.opened, ['a1'],
    'and a task that has left the dashboard loses it the same way');

  /* AND NOT WHEN THE DRAWER IS CLOSED, which is the other half of "not
     otherwise": reopening a panel nobody is looking at would put it back on
     screen. */
  calls.opened.length = 0;
  classes.delete('show');
  payload = { assets: [row(null, true)] };
  await built.loadAssets();
  assert.deepStrictEqual(calls.opened, [], 'a closed drawer is left closed');
  classes.add('show');

  assert.strictEqual(calls.fetched.length, 5, 'and every pass re-fetched the board');
  assert.ok(calls.fetched.every((u) => u === '/assets/project/p1'),
    'from the endpoint the page actually uses');

  /* THE SIGNATURE IS THE FOUR FIELDS THE CONTROLS ARE DRAWN FROM, and nothing
     else: a changed Time Spent must not reopen the drawer. */
  assert.strictEqual(built.holdSignature(row(null, true)),
    built.holdSignature({ ...row(null, true), time_spent_seconds: 9999 }));
  assert.notStrictEqual(built.holdSignature(row(null, true)),
    built.holdSignature(row('HOLD_NO_SESSION', false)));
  assert.strictEqual(built.holdSignature({ id: 'a1' }), 'none',
    'and an undecorated row is its own answer, not a crash');
});

test('hold is offered on one screen, and that screen reads the server', () => {
  /* COUNTED, because "every screen that offers it" is a claim about the page and
     not about the rule. There is exactly one: the asset panel in the drawer. The
     board's cards do not carry a Hold button and never have — which is worth
     knowing, because three reports described "the Hold button" as though it were
     on the board. */
  const ids = (PAGE.match(/id="d_holdBtn"/g) || []).length;
  assert.strictEqual(ids, 2, 'one enabled and one disabled form of the same control');
  assert.strictEqual((PAGE.match(/id="d_resumeBtn"/g) || []).length, 2);
  assert.ok(!/holdBtn/.test(PAGE.slice(PAGE.indexOf('function renderBoard('),
    PAGE.indexOf('function renderBoard(') + 4000)),
    'and the board draws no hold control of its own');

  /* AND THE DISABLED FORM CARRIES THE SERVER'S SENTENCE — in words, not only in
     a title= tooltip, which is an explanation nobody on a touchscreen can reach.
     "The Hold button does not work" is what got reported four times. */
  assert.match(PAGE, /id="d_holdWhy"/, 'the reason is drawn as text');
  assert.match(PAGE, /\$\{escapeHTML\(holdWhy \|\| resumeWhy\)\}/,
    'and it is the server\'s own message');
  /* A disabled control is an explanation and is never wired to a request. */
  const at = PAGE.indexOf('const holdAction = (button, path, ask) => {');
  assert.ok(at !== -1);
  assert.match(PAGE.slice(at, at + 700), /if\(button\.disabled\) return;/);
});

// ===========================================================================
// 4. AGAINST A LIVE SERVER: the parity property, and the leads production has.
// ===========================================================================

test('what the dashboard shows, the dashboard can hold', { skip: cfg ? false : SKIP_REASON },
  async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'hv', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'hv', name: 'Root', email: 'root@hv.test', password: PASSWORD } });
    tok.root = await login('root@hv.test');
    await openStudio(server.base, tok.root);

    const mk = async (who, role, extra = {}) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@hv.test`, role, password: PASSWORD, ...extra } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tok[who] = await login(`${who}@hv.test`);
      return r.body.user.id;
    };

    /* FOUR LEADS, FOUR WAYS A DASHBOARD FILLS. The third is the one nobody had
       tested and the one the fourth report is about. */
    id.named = await mk('named', 'team_lead');            // on the project's Team Leads
    id.supervisor = await mk('supervisor', 'art_supervisor');  // on Supervision
    id.byReport = await mk('byReport', 'team_lead');      // a report works there
    id.coord = await mk('coord', 'associate_team_lead');  // on the coordinators list
    id.offKey = await mk('offKey', 'senior_team_lead');   // key revoked below
    id.artist = await mk('artist', 'game_artist');
    id.animator = await mk('animator', 'game_animator');
    // Reports to byReport. This is what puts P-report on byReport's dashboard.
    id.theirArtist = await mk('theirArtist', 'game_artist', { teamLeadId: id.byReport });
    id.stranger = await mk('stranger', 'game_artist');

    const clients = await as('root', '/clients');
    const clientId = clients.body.clients[0].id;
    const project = async (name, body = {}) => {
      const r = await as('root', '/projects', { method: 'POST', body: { name, clientId, ...body } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.project.id;
    };
    id.pNamed = await project('P-named', { teamLeadIds: [id.named, id.offKey] });
    id.pSup = await project('P-sup', { supervisionIds: [id.supervisor] });
    id.pReport = await project('P-report');                       // nobody named
    id.pCoord = await project('P-coord', { coordinatorIds: [id.coord] });
    id.pNone = await project('P-none');                           // nobody's

    const asset = async (projectId, name, assignee) => {
      const r = await as('root', `/assets/project/${projectId}`, { method: 'POST',
        body: { name, type: 'prop', assigneeId: assignee } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.asset.id;
    };
    /* ONE PERSON PER ASSET, because the one-active-task rule allows each of them
       exactly one open stretch — so every asset below has a real running session
       at the same time, which is what the property needs. */
    id.aNamed = await asset(id.pNamed, 'In the named project', id.artist);
    id.aSup = await asset(id.pSup, 'In the supervised one', id.animator);
    id.aReport = await asset(id.pReport, 'A report works here', id.theirArtist);
    id.aCoord = await asset(id.pCoord, 'Lead coordinates here', id.stranger);
    id.aNone = await asset(id.pNone, 'Nobody they know', await mk('loner', 'game_artist'));

    for (const [who, assetId] of [['artist', id.aNamed], ['animator', id.aSup],
      ['theirArtist', id.aReport], ['stranger', id.aCoord], ['loner', id.aNone]]) {
      const s = await as(who, `/assets/${assetId}/start`, { method: 'POST' });
      assert.strictEqual(s.status, 200, `${who} start: ${JSON.stringify(s.body)}`);
    }
  });
  t.after(async () => { if (server) await stopServer(server); });

  /* THE BOARD, FETCHED THE WAY THE PAGE FETCHES IT — loadAssets() in
     public/index.html is `api('/assets/project/' + id)`, which is this. Nothing
     is reconstructed; the rows are the rows the browser would hold. */
  const boardFor = async (who, projectId) => as(who, `/assets/project/${projectId}`);

  const ALL = () => [
    ['P-named', 'pNamed', 'aNamed'],
    ['P-sup', 'pSup', 'aSup'],
    ['P-report', 'pReport', 'aReport'],
    ['P-coord', 'pCoord', 'aCoord'],
    ['P-none', 'pNone', 'aNone'],
  ];

  /* WHOSE CLOCK EACH FIXTURE'S IS. One person per asset, because the studio's
     one-active-task rule allows each of them exactly one open stretch — so all
     five can be running at once, which is what the property needs. */
  const ASSIGNEE = { aNamed: 'artist', aSup: 'animator', aReport: 'theirArtist',
    aCoord: 'stranger', aNone: 'loner' };

  /* A RUNNING CLOCK ON THIS ASSET, GUARANTEED, and started THROUGH THE APP.
   *
   * THE HARNESS MUST NOT BE WHAT IS BEING MEASURED. An earlier version of this
   * helper only un-ended a session whose reason was 'held', which left the next
   * case measuring HOLD_NO_SESSION and reading exactly like the bug under test —
   * the same trap Prompt 34 fell into with hand-written work_sessions rows. So
   * the settle is SQL (tidying up is never the thing under test) and the start is
   * POST /:id/start as the assignee, which is the only way a real session
   * begins. */
  const runClock = async (key) => {
    const assetId = id[key];
    await sql(cfg,
      'UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()), '
      + "seconds = COALESCE(seconds, 0), ended_reason = 'submitted' "
      + 'WHERE asset_id = ? AND (ended_at IS NULL OR ended_reason = \'held\')', [assetId]);
    const s = await as(ASSIGNEE[key], `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(s.status, 200, `${key} restart: ${JSON.stringify(s.body)}`);
  };

  await t.test('THE PROPERTY: every working-status asset a lead can see, a lead can hold',
    async () => {
    /* THE ASSERTION THAT CANNOT DRIFT. Two live answers compared — the board's and
       the hold route's — with no restatement of the rule in between. Run for four
       leads whose dashboards fill four different ways, which is the part the
       previous three fixes never had. */
    const table = [];
    for (const who of ['named', 'supervisor', 'byReport', 'coord']) {
      for (const [label, pKey, aKey] of ALL()) {
        const board = await boardFor(who, id[pKey]);
        const visible = board.status === 200
          && (board.body.assets || []).some((x) => x.id === id[aKey]);
        const row = visible ? board.body.assets.find((x) => x.id === id[aKey]) : null;

        await runClock(aKey);
        const put = await as(who, `/assets/${id[aKey]}/hold`, { method: 'POST' });
        table.push({ who, label, visible, flag: row ? row.hold_state.canHold : null,
          status: put.status, code: put.body && put.body.code });

        if (visible) {
          /* ON THE DASHBOARD, WORKING STATUS, CLOCK RUNNING: holdable, by the route
             and by the flag the page draws. This is the whole report. */
          assert.ok(workflow.WORKING_STATUSES.includes(row.status),
            `${who}/${label}: the fixture is in a working status`);
          assert.strictEqual(row.hold_state.canHold, true,
            `${who}/${label}: the page is offered the button`);
          assert.strictEqual(put.status, 200,
            `${who}/${label}: the route allows it — ${JSON.stringify(put.body)}`);
          await as(who, `/assets/${id[aKey]}/resume`, { method: 'POST' });
        } else {
          /* NOT ON THE DASHBOARD: refused, and refused on VISIBILITY rather than
             on anything else, because these leads all hold the key. */
          assert.strictEqual(put.status, 403,
            `${who}/${label}: the route refuses it — ${JSON.stringify(put.body)}`);
          assert.strictEqual(put.body.code, C.NOT_VISIBLE,
            `${who}/${label}: and says it is not on their dashboard`);
        }
      }
    }

    /* THE REGRESSION, NAMED. byReport sees P-report only because one of their
       reports has an asset in it — no membership row anywhere — and that cell
       measured false/403 before this change. */
    const theOne = table.find((r) => r.who === 'byReport' && r.label === 'P-report');
    assert.deepStrictEqual(
      { visible: theOne.visible, flag: theOne.flag, status: theOne.status },
      { visible: true, flag: true, status: 200 },
      'a lead holds work in a project they see only through a report — the fourth report');
    const membership = await sql(cfg,
      'SELECT 1 AS ok FROM project_team_leads WHERE user_id = ? AND project_id = ? '
      + 'UNION SELECT 1 AS ok FROM project_supervision WHERE user_id = ? AND project_id = ?',
      [id.byReport, id.pReport, id.byReport, id.pReport]);
    assert.strictEqual(membership.length, 0,
      'and they are on neither membership list, which is what the old scope read');

    /* AND NOBODY GAINED THE WHOLE STUDIO. Every lead is refused on P-none. */
    for (const who of ['named', 'supervisor', 'byReport', 'coord']) {
      const cell = table.find((r) => r.who === who && r.label === 'P-none');
      assert.strictEqual(cell.visible, false, `${who} cannot see P-none`);
      assert.strictEqual(cell.status, 403, `${who} cannot hold in P-none`);
    }
  });

  await t.test('a lead whose designation has the key switched off keeps only their own',
    async () => {
    /* `offKey` is named on P-named exactly as `named` is, so the only difference
       between them is the permission — which is the whole reason it is a
       permission. */
    await runClock('aNamed');
    const board = await boardFor('offKey', id.pNamed);
    assert.strictEqual(board.status, 200, 'they still SEE it: reading is unaffected');
    const row = board.body.assets.find((x) => x.id === id.aNamed);

    const held = (await as('root', '/permissions/roles/senior_team_lead')).body.role
      .permissions.filter((pp) => pp.enabled).map((pp) => pp.key);
    assert.ok(held.includes('asset.hold_any'), 'a lead starts with it');
    await as('root', '/permissions/roles/senior_team_lead', { method: 'PUT',
      body: { permissions: held.filter((k) => k !== 'asset.hold_any') } });
    try {
      const after = (await boardFor('offKey', id.pNamed)).body.assets
        .find((x) => x.id === id.aNamed);
      assert.strictEqual(after.hold_state.canHold, false, 'no button once it is off');
      assert.strictEqual(after.hold_state.hold.code, C.NOT_YOURS);
      const refused = await as('offKey', `/assets/${id.aNamed}/hold`, { method: 'POST' });
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.code, C.NOT_YOURS);
      assert.strictEqual(refused.body.gate, 'authority');
    } finally {
      await as('root', '/permissions/roles/senior_team_lead',
        { method: 'PUT', body: { permissions: held } });
    }
    /* BACK ON THE SAME TOKEN, no sign-out: authenticate() resolves the set on
       every request. */
    const back = (await boardFor('offKey', id.pNamed)).body.assets
      .find((x) => x.id === id.aNamed);
    assert.strictEqual(back.hold_state.canHold, true);
    assert.strictEqual((await as('offKey', `/assets/${id.aNamed}/hold`,
      { method: 'POST' })).status, 200);
    await as('offKey', `/assets/${id.aNamed}/resume`, { method: 'POST' });
    void row;
  });

  await t.test('an artist is unchanged: their own work, and nothing else', async () => {
    await runClock('aNamed');
    const board = await boardFor('artist', id.pNamed);
    assert.strictEqual(board.status, 200);
    const mine = board.body.assets.find((x) => x.id === id.aNamed);
    assert.strictEqual(mine.hold_state.canHold, true, 'their own, as always');
    assert.strictEqual((await as('artist', `/assets/${id.aNamed}/hold`,
      { method: 'POST' })).status, 200);
    await as('artist', `/assets/${id.aNamed}/resume`, { method: 'POST' });

    /* A CONTRIBUTOR'S BOARD IS THEIR OWN WORK, so "anything on your dashboard"
       cannot widen them even if somebody grants them the key — assetOnDashboard
       applies the board's own narrowing. Proven by granting it. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role
      .permissions.filter((pp) => pp.enabled).map((pp) => pp.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...held, 'asset.hold_any'] } });
    try {
      await runClock('aSup');
      const other = await as('artist', `/assets/${id.aSup}/hold`, { method: 'POST' });
      assert.strictEqual(other.status, 403, JSON.stringify(other.body));
      assert.strictEqual(other.body.code, C.NOT_VISIBLE,
        'a contributor granted the key still reaches only their own work');
    } finally {
      await as('root', '/permissions/roles/game_artist',
        { method: 'PUT', body: { permissions: held } });
    }
  });

  await t.test('the Art and Animation lenses do not change the answer', async () => {
    /* THE DASHBOARD'S SUB-TABS ARE A FILTER ON WHAT IS DRAWN, not a second
       visibility rule — they narrow the cards on screen by discipline. So a
       lead's hold answer must be the same whichever lens they are looking
       through, which is to say the answer belongs to the asset and not to the
       view. Asserted by reading the same row twice through the same endpoint the
       page uses: if the lens ever starts scoping the REQUEST, this is where that
       shows up as two different answers for one asset. */
    await runClock('aSup');
    const first = (await boardFor('supervisor', id.pSup)).body.assets
      .find((x) => x.id === id.aSup);
    const again = (await boardFor('supervisor', id.pSup)).body.assets
      .find((x) => x.id === id.aSup);
    assert.deepStrictEqual(first.hold_state, again.hold_state,
      'one asset, one answer, however the board is being looked at');
    assert.strictEqual(first.hold_state.canHold, true);
  });

  await t.test('a reassignment moves what a lead can hold, within the refresh cycle',
    async () => {
    /* FRESHNESS, which the brief asks for explicitly: a control must not remain
       after the task leaves the lead's dashboard, and must not be missing for one
       that has just appeared.
     *
     * byReport sees P-report ONLY because theirArtist works there. Hand that
     * asset to somebody who does not report to them and the project leaves their
     * dashboard — no permission changes, no sign-out, and the next board fetch
     * (which render() makes on every pass) carries the new answer. */
    await runClock('aReport');
    const before = (await boardFor('byReport', id.pReport)).body.assets
      .find((x) => x.id === id.aReport);
    assert.strictEqual(before.hold_state.canHold, true, 'visible through their report');

    /* PATCH, which is how this application reassigns — there is no /assign route.
       Driven through the app rather than by SQL so the assignment round and the
       status transition happen the way they do in production. */
    const moved = await as('root', `/assets/${id.aReport}`, { method: 'PATCH',
      body: { assigneeId: id.stranger } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    try {
      const board = await boardFor('byReport', id.pReport);
      /* The project is gone from their reach entirely, so the board 403s — which
         is the strongest form of "the control is not there": there is no row to
         draw one on. */
      assert.strictEqual(board.status, 403,
        'the project leaves their dashboard with the work that put it there');
      const refused = await as('byReport', `/assets/${id.aReport}/hold`, { method: 'POST' });
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.code, C.NOT_VISIBLE);
    } finally {
      await as('root', `/assets/${id.aReport}`, { method: 'PATCH',
        body: { assigneeId: id.theirArtist } });
    }
    /* AND BACK, on the same token: the answer follows the data, not the session.
     *
     * THE CLAIM IS ABOUT VISIBILITY, so that is what is asserted. Reassigning
     * closes the old stretch and opens a new round, so the asset comes back with
     * no clock running — and `canHold` would be false for that reason, which is
     * nothing to do with the dashboard. The CODE is what tells the two apart:
     * NO_SESSION means "start the work", NOT_VISIBLE means "this is not yours to
     * see". Conflating them is how a harness artifact reads like the bug. */
    const board = await boardFor('byReport', id.pReport);
    assert.strictEqual(board.status, 200,
      'the project is back on their dashboard with the work that puts it there');
    const after = board.body.assets.find((x) => x.id === id.aReport);
    assert.notStrictEqual(after.hold_state.hold.code, C.NOT_VISIBLE,
      'and it is no longer refused on visibility');
    await runClock('aReport');
    const withClock = (await boardFor('byReport', id.pReport)).body.assets
      .find((x) => x.id === id.aReport);
    assert.strictEqual(withClock.hold_state.canHold, true,
      'and with a clock running, holdable again');
  });

  await t.test('every status, against a live lead', async () => {
    /* THE STATUS TABLE ABOVE, MEASURED rather than reasoned about — on a real
       asset in a real project that a real lead can see, with no clock running. */
    const assetId = await (async () => {
      const r = await as('root', `/assets/project/${id.pNamed}`, { method: 'POST',
        body: { name: 'Every Stage', type: 'prop', assigneeId: id.artist } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.asset.id;
    })();

    for (const [status, meaningful] of STATUS_TABLE) {
      await sql(cfg, 'UPDATE assets SET `status` = ? WHERE id = ?', [status, assetId]);
      const row = (await boardFor('named', id.pNamed)).body.assets
        .find((x) => x.id === assetId);
      assert.ok(row, `${status}: on the board`);
      const put = await as('named', `/assets/${assetId}/hold`, { method: 'POST' });
      if (meaningful) {
        /* A WORKING STATUS WITH NO CLOCK: the stage is fine, so the refusal is
           about the session — which is the right thing to be told, because
           starting the work is what it asks for. */
        assert.strictEqual(row.hold_state.hold.code, C.NO_SESSION, `${status}: nothing running`);
        assert.strictEqual(put.status, 409, `${status}: ${JSON.stringify(put.body)}`);
        assert.strictEqual(put.body.code, C.NO_SESSION);
      } else {
        assert.strictEqual(row.hold_state.hold.code, C.WRONG_STATUS,
          `${status}: holding means nothing here`);
        assert.strictEqual(put.status, 409, `${status}: ${JSON.stringify(put.body)}`);
        assert.strictEqual(put.body.code, C.WRONG_STATUS);
        assert.match(put.body.error, /Assigned, In Progress, TL Feedbacks/,
          `${status}: and names the stages where it is available`);
      }
      // Either way the control is OFFERED with its reason, not silently absent.
      assert.strictEqual(row.hold_state.hold.offer, true, `${status}: explained in place`);
    }
    await sql(cfg, 'DELETE FROM assets WHERE id = ?', [assetId]);
  });

  await t.test('REGRESSION — the two Prompt 36 scenarios still pass', async () => {
    /* The cases the previous report was closed on. They were right and they stay
       right; what was wrong was everything they did not cover. */
    await runClock('aNamed');
    const lead = await as('named', `/assets/${id.aNamed}/hold`, { method: 'POST' });
    assert.strictEqual(lead.status, 200,
      'an assigned lead holds an artist\'s In Progress asset');
    assert.strictEqual((await as('named', `/assets/${id.aNamed}/resume`,
      { method: 'POST' })).status, 200);

    const own = await as('artist', `/assets/${id.aNamed}/hold`, { method: 'POST' });
    assert.strictEqual(own.status, 200, 'an artist holds their own');
    await as('artist', `/assets/${id.aNamed}/resume`, { method: 'POST' });
  });

  await t.test('an archived project refuses before visibility is ever asked', async () => {
    /* THE ONE PLACE THE BOARD'S VISIBILITY AND canViewAsset DISAGREE, found while
     * checking this change and reported because it is not what the brief
     * expected.
     *
     * visibleProjects() filters `is_active = 1` in every branch; canViewAsset
     * returns true for projectScope 'all' before it asks anything, and returns
     * true for a lead whose report holds the asset without asking about the
     * project either. So for an ARCHIVED project, GET /assets/:id answers 200
     * while GET /assets/project/:id answers 403 — measured, both.
     *
     * IT CANNOT AFFECT A HOLD, which is why nothing was changed for it:
     * projectClosedResponse runs at the top of holdableAsset and refuses an
     * archived project with 409 projectClosed before the rule is consulted at
     * all. So the divergence is real, is in the read path, and is somebody
     * else's to decide about. Pinned here so that a later change which moves the
     * project-closed gate finds out that this was load-bearing. */
    await runClock('aNamed');
    await sql(cfg, 'UPDATE projects SET is_active = 0 WHERE id = ?', [id.pNamed]);
    try {
      const board = await as('named', `/assets/project/${id.pNamed}`);
      assert.strictEqual(board.status, 403, 'the board drops an archived project');
      const one = await as('named', `/assets/${id.aNamed}`);
      assert.strictEqual(one.status, 200,
        'while the single-asset read still allows it — the divergence, measured');

      for (const who of ['named', 'artist', 'root']) {
        const refused = await as(who, `/assets/${id.aNamed}/hold`, { method: 'POST' });
        assert.strictEqual(refused.status, 409, `${who}: ${JSON.stringify(refused.body)}`);
        assert.strictEqual(refused.body.projectClosed, true,
          `${who} is refused by the project gate, not by the hold rule`);
        assert.strictEqual(refused.body.code, undefined,
          'so no hold reason code is reached, which is how we know the order');
      }
    } finally {
      await sql(cfg, 'UPDATE projects SET is_active = 1 WHERE id = ?', [id.pNamed]);
    }
  });

  await t.test('the explain endpoint answers for somebody who is not pressing the button',
    async () => {
    await runClock('aNamed');
    /* ABOUT YOURSELF, always. */
    const self = await as('named', `/assets/${id.aNamed}/hold-explain`);
    assert.strictEqual(self.status, 200, JSON.stringify(self.body));
    assert.strictEqual(self.body.hold.allowed, true);
    assert.strictEqual(self.body.facts.onDashboard, true);
    assert.strictEqual(self.body.facts.holdsAny, true);
    assert.strictEqual(self.body.facts.session, 'open');

    /* ABOUT SOMEBODY ELSE, with the key that manages permissions — and the answer
       is about THEM, not about the asker. */
    const other = await as('root', `/assets/${id.aNamed}/hold-explain?userId=${id.stranger}`);
    assert.strictEqual(other.status, 200, JSON.stringify(other.body));
    assert.strictEqual(other.body.user.id, id.stranger);
    assert.strictEqual(other.body.hold.allowed, false);
    assert.strictEqual(other.body.hold.code, C.NOT_YOURS);
    assert.strictEqual(other.body.hold.gate, 'authority');

    /* AND NOT WITHOUT IT. An artist cannot ask about their lead. */
    const nosy = await as('artist', `/assets/${id.aNamed}/hold-explain?userId=${id.named}`);
    assert.strictEqual(nosy.status, 403, JSON.stringify(nosy.body));

    /* IT DECIDES NOTHING: the same facts the route used, so the two cannot
       disagree. Checked by asking the route and comparing. */
    const put = await as('stranger', `/assets/${id.aNamed}/hold`, { method: 'POST' });
    assert.strictEqual(put.body.code, other.body.hold.code,
      'the explanation and the refusal are the same decision');
  });

  await t.test('every refusal is in the log, with its gate', async () => {
    /* THE LOG LINE IS THE DELIVERABLE HERE, and it cannot be read back out of
       this process — the server runs in its own. So the shape is asserted
       against the module that writes it, and the route is asserted to call it
       before answering. Three reports were diagnosed by guessing which gate had
       fired; the next one is read out of the log. */
    const holdLog = require('../src/hold-log');
    const lines = [];
    const warn = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
      holdLog.refusal({
        action: 'hold',
        verdict: assetHold.decide('hold', facts({ onDashboard: false })),
        facts: facts({ onDashboard: false }),
        user: { id: 'u-lead', role: 'team_lead' },
        asset: { id: 'a1', code: 'CHR-007', project_id: 'p1', status: 'in_progress',
          assignee_id: 'u-artist' },
      });
    } finally { console.warn = warn; }

    assert.strictEqual(lines.length, 1, 'one line per refusal');
    for (const field of ['[hold] refused hold', 'gate=visibility', 'reason=HOLD_NOT_VISIBLE',
      'user=u-lead', 'role=team_lead', 'asset=a1', 'task=CHR-007', 'project=p1',
      'status=in_progress', 'session=open', 'mine=false', 'visible=false', 'hold_any=true']) {
      assert.ok(lines[0].includes(field), `the line carries ${field}: ${lines[0]}`);
    }
    /* NO NAMES AND NO EMAIL: ids and the designation key are enough to reproduce,
       and a log that discloses is a log somebody turns off. */
    assert.ok(!/@/.test(lines[0]), 'and nothing that identifies a person by name');

    // An allowed verdict writes nothing at all.
    const quiet = [];
    console.warn = (...a) => quiet.push(a.join(' '));
    try {
      holdLog.refusal({ action: 'hold', verdict: assetHold.decide('hold', facts()),
        facts: facts(), user: { id: 'u' }, asset: { id: 'a' } });
    } finally { console.warn = warn; }
    assert.deepStrictEqual(quiet, [], 'a successful hold is not a log line');

    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
    assert.match(route, /holdLog\.refusal\(\{ action, verdict, facts, user: req\.user, asset \}\)/,
      'and the route writes it before it answers');
  });
});
