/* WHAT IS WAITING ON ONE PERSON — the figure, and the list behind the button.
 *
 * ===========================================================================
 * WHAT THIS FILE IS REALLY GUARDING, and it is not the grouping.
 *
 * THE FIGURE AND THE LIST MUST BE THE SAME QUESTION. A row saying "4 waiting on
 * them" above a panel showing three assets is the one failure that would stop
 * the studio trusting either number, and it is the easy failure to write: two
 * queries, each correct on its own, drifting apart the first time somebody
 * changes what counts. So the first group below does not check any list — it
 * checks that both come out of ONE predicate, by asserting on the SQL both
 * build and by asserting the panel's count is taken from the rows it groups.
 *
 * AND THE FIGURE CHANGED MEANING IN THIS CHANGE. src/follow-up.js's heldCounts()
 * counted assignment EPISODES with no status filter at all, so an asset the
 * person submitted days ago and which now sits with a reviewer counted toward
 * "N waiting on them". That is true of "held that day" and false of "waiting on
 * them"; the section had always printed two different words over one number.
 * The cases below pin the narrowing — in progress, in review, not started and
 * outsourced all excluded — and one of them pins the old behaviour where it is
 * still right, for a past date.
 *
 * ===========================================================================
 * NO SECOND DEFINITION OF ANYTHING. "On this person's desk" is
 * src/asset-workflow.js's `assignee` actor, and "waiting for rework" is
 * src/permissions.js's REWORK_STATUSES. The first tests below mutate those two
 * published lists and assert this file's predicate moves with them, which is
 * the same thing tests/follow-up.test.js does for the four definitions that
 * section borrows.
 *
 * FIXED DATES THROUGHOUT, in March 2026, and every case that depends on the
 * hour passes an explicit `now`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const waitingWork = require('../src/waiting-work');
const workflow = require('../src/asset-workflow');
const permissions = require('../src/permissions');
const followUp = require('../src/follow-up');
const holidays = require('../src/holidays');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const cfg = config('waiting');
const PASSWORD = 'Follow-Up-1!';

const MON = '2026-03-16';
const TUE = '2026-03-17';
const WED = '2026-03-18';
const ist = (text) => Date.parse(`${text}+05:30`);

function stubDb(answers = []) {
  const calls = [];
  return {
    calls,
    sqlFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).sql || ''; },
    paramsFor(re) { return (calls.find((c) => re.test(c.sql)) || {}).params || []; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of answers) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows, result: {} };
      }
      return { rows: [], result: {} };
    },
  };
}

// ===========================================================================
// 1. ONE PREDICATE. The figure and the list cannot disagree.
// ===========================================================================

test('the definition is the two lists this application already publishes', () => {
  /* 'assigned' — given and not started — plus the studio's own "waiting for
     rework" list. Written as a composition rather than as four strings, so a
     status joining or leaving REWORK_STATUSES joins or leaves this. */
  assert.deepStrictEqual(waitingWork.WAITING_STATUSES,
    ['assigned', ...permissions.REWORK_STATUSES]);
  assert.deepStrictEqual(permissions.REWORK_STATUSES,
    ['tl_changes_requested', 'cd_changes_requested', 'game_feedback']);

  /* And the ones that are theirs even when the asset is routed to nobody are
     derived from the workflow's own list, not retyped. */
  assert.deepStrictEqual(waitingWork.UNROUTED_STATUSES,
    waitingWork.WAITING_STATUSES.filter((s) => workflow.ASSIGNEE_STATUSES.includes(s)));
  assert.deepStrictEqual(waitingWork.UNROUTED_STATUSES, ['assigned', 'tl_changes_requested']);

  /* NEITHER LIST IS COPIED INTO THIS FILE. A second spelling of either would
     agree for months and part company the first time one of them moved. */
  const src = SRC('waiting-work.js');
  assert.match(src, /require\('\.\/asset-workflow'\)/);
  assert.match(src, /REWORK_STATUSES/);
  for (const copied of ['tl_changes_requested', 'cd_changes_requested', 'game_feedback']) {
    assert.ok(!src.includes(`'${copied}'`), `${copied} is asked for, never written out here`);
  }
});

test('MUTATION 1 — the figure and the list are built from the same WHERE clause', async () => {
  const count = stubDb();
  await waitingWork.countsFor(count, ['u-1'], { studioWide: true });
  const list = stubDb();
  await waitingWork.listFor(list, 'u-1', { studioWide: true });

  /* lastIndexOf, not indexOf: listFor's two correlated subqueries carry WHERE
     clauses of their own and the predicate is the LAST one in the statement.
     The count's trailing GROUP BY is dropped so the two are comparable. */
  const clauseOf = (text) => text.slice(text.lastIndexOf('WHERE'))
    .split('GROUP BY')[0].replace(/\s+/g, ' ').trim();
  const a = clauseOf(count.sqlFor(/FROM assets a/));
  const b = clauseOf(list.sqlFor(/FROM assets a/));
  assert.ok(a.length > 40, 'there is a clause to compare');
  assert.strictEqual(a, b,
    'the count and the list ask the same question — a mutant that gave either its own copy fails here');

  /* AND THE PANEL'S COUNT IS THE LENGTH OF WHAT IT GROUPED, not a second read.
     Four rows in, four out, whatever the grouping does with them. */
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `a-${i}`, code: `CH-00${i}`, name: `Asset ${i}`, type: 'character', status: 'assigned',
    projectId: 'p-1', projectName: 'Alpha', clientId: 'c-1', clientName: 'Acme',
    heldSince: '2026-03-16 04:00:00', stateSince: null, dueDate: null,
  }));
  const db = stubDb([[/FROM assets a/, rows]]);
  const panel = await waitingWork.panelFor(db, 'u-1', { studioWide: true, today: WED, now: ist(`${WED}T11:00:00`) });
  assert.strictEqual(panel.count, 4);
  assert.strictEqual(
    panel.clients.reduce((n, c) => n + c.projects.reduce((m, p) => m + p.assets.length, 0), 0),
    panel.count,
    'the number and the list agree by construction');
});

test('MUTATION 2 — in progress, in review and not started are not waiting', async () => {
  const db = stubDb();
  await waitingWork.countsFor(db, ['u-1'], { studioWide: true });
  const statuses = db.paramsFor(/FROM assets a/)[1];

  assert.ok(!statuses.includes('in_progress'),
    'an asset they have started is not waiting — the clock is running on it');
  assert.ok(!statuses.includes('not_started'),
    'an asset nobody has been given is not waiting on anybody');
  for (const review of ['pending_tl_review', 'pending_cd_review', 'tl_approved',
    'approved_for_client', 'awaiting_client_feedback', 'delivered']) {
    assert.ok(!statuses.includes(review), `${review} is waiting on somebody else`);
  }
  assert.deepStrictEqual(statuses.slice().sort(),
    ['assigned', 'cd_changes_requested', 'game_feedback', 'tl_changes_requested']);

  /* THE POINT OF EXCLUDING in_progress, stated as the case it is about:
     somebody with a timer running on one asset still has the others waiting, so
     the exclusion is per asset and never per person. */
  const rows = [
    { id: 'a-1', name: 'One', status: 'assigned', type: 'character', projectId: 'p', projectName: 'P',
      clientId: 'c', clientName: 'C', heldSince: '2026-03-16 04:00:00', stateSince: null, dueDate: null },
    { id: 'a-2', name: 'Two', status: 'tl_changes_requested', type: 'character', projectId: 'p', projectName: 'P',
      clientId: 'c', clientName: 'C', heldSince: '2026-03-16 04:00:00', stateSince: null, dueDate: null },
  ];
  const panel = await waitingWork.panelFor(stubDb([[/FROM assets a/, rows]]), 'u-1',
    { studioWide: true, today: WED, now: ist(`${WED}T11:00:00`) });
  assert.strictEqual(panel.count, 2, 'the asset on the clock is simply not in the answer');
});

test('the desk test has both of the workflow\'s branches, and only those', async () => {
  const db = stubDb();
  await waitingWork.countsFor(db, ['u-1'], { studioWide: true });
  const sql = db.sqlFor(/FROM assets a/).replace(/\s+/g, ' ');

  /* THE SAME TWO BRANCHES as src/asset-workflow.js's `assignee` actor:
     routed to them, OR routed to nobody in a status that is theirs by
     definition. The second is the CD Feedbacks relay — that state is routed to
     NOBODY until the lead passes it on, and without the status list "routed to
     nobody" would read as "routed to anybody". */
  assert.match(sql, /a\.assignee_id IN \(\$\d\)/);
  assert.match(sql, /a\.routed_to_id IN \(\$\d\) OR \(a\.routed_to_id IS NULL AND a\.`status` IN \(\$\d\)\)/);

  const actor = SRC('asset-workflow.js');
  assert.match(actor, /if \(ctx\.asset\.routed_to_id === ctx\.user\.id\) return true;/);
  assert.match(actor, /return ctx\.asset\.routed_to_id == null && ASSIGNEE_STATUSES\.includes\(ctx\.asset\.status\);/,
    'the predicate this file turns into SQL is still the one the workflow enforces');
});

test('MUTATION 4 — scope is in the clause, and a viewer with no projects asks nothing', async () => {
  const wide = stubDb();
  await waitingWork.countsFor(wide, ['u-1'], { studioWide: true, projectIds: ['p-1'] });
  assert.ok(!/project_id IN/.test(wide.sqlFor(/FROM assets a/)),
    'nothing is narrowed for somebody who sees the studio');

  const narrow = stubDb();
  await waitingWork.countsFor(narrow, ['u-1'], { studioWide: false, projectIds: ['p-1', 'p-2'] });
  assert.match(narrow.sqlFor(/FROM assets a/), /a\.project_id IN \(\$\d\)/,
    'and narrowed for everybody else — a mutant that dropped this shows work from projects the viewer cannot open');
  assert.deepStrictEqual(narrow.paramsFor(/FROM assets a/).slice(-1)[0], ['p-1', 'p-2']);

  /* A NARROWER VIEWER WITH NO PROJECTS can see nothing, and asking would be a
     query whose answer is already known. The same early return heldCounts has. */
  const none = stubDb();
  assert.strictEqual((await waitingWork.countsFor(none, ['u-1'], { studioWide: false, projectIds: [] })).size, 0);
  assert.deepStrictEqual(await waitingWork.listFor(none, 'u-1', { studioWide: false, projectIds: [] }), []);
  assert.strictEqual(none.calls.length, 0, 'and no query was issued at all');
});

test('outsourced work cannot appear, and it is the schema that says so', () => {
  /* NOT A FILTER, A PROPERTY — the same shape as the follow-up section's note
     on freelancers having no users row at all.
     
     The two assignment routes are mutually exclusive and both guards are in
     src/outsource.js: outsourceBlocked() refuses while assignee_id is set, and
     internalAssignBlocked() refuses while a live outsource assignment exists.
     So an asset out with a freelancer has assignee_id NULL, and this predicate
     requires assignee_id = the person. Nothing to exclude.
     
     THE PREMISE IS ASSERTED rather than assumed, so a future relaxation of
     exclusivity has to come past this line and decide whether freelance work
     should start counting as somebody's queue. */
  const src = SRC('outsource.js');
  assert.match(src, /async function outsourceBlocked\(db, assetId\)/);
  assert.match(src, /if \(!rows\[0\]\.assignee_id\) return null;/,
    'an asset with an internal assignee cannot be sent outside');
  assert.match(src, /async function internalAssignBlocked\(db, assetId\)/);
  assert.match(src, /const held = await activeForAsset\(db, assetId\);\n  if \(!held\) return null;/,
    'and one with a live freelancer cannot be given to somebody inside');

  assert.match(SRC('waiting-work.js'), /a\.assignee_id/,
    'and the predicate is keyed on the internal assignee, which outsourced work does not have');
  assert.ok(!/outsource/i.test(SRC('waiting-work.js').split('module.exports')[0].split('const workflow')[1] || ''),
    'so there is no outsource filter to get wrong');
});

// ===========================================================================
// 2. THE GROUPS, THE ORDER AND THE WAIT. Arithmetic over rows.
// ===========================================================================

const row = (over = {}) => ({
  id: 'a-1', code: 'CH-001', name: 'Hero', type: 'character', status: 'assigned',
  priority: 'med', dueDate: null, projectId: 'p-1', projectName: 'Alpha', projectCode: 'ALP',
  clientId: 'c-1', clientName: 'Acme', routedToId: null,
  heldSince: '2026-03-16 04:00:00', stateSince: null, ...over,
});

const panelOf = (rows, opts = {}) => waitingWork.panelFor(stubDb([[/FROM assets a/, rows]]), 'u-1',
  { studioWide: true, today: WED, now: ist(`${WED}T11:00:00`), ...opts });

test('MUTATION 5 — grouped by client, then project, with the totals on the headings', async () => {
  const p = await panelOf([
    row({ id: 'a-1', name: 'Hero', clientId: 'c-1', clientName: 'Acme', projectId: 'p-1', projectName: 'Alpha' }),
    row({ id: 'a-2', name: 'Crate', clientId: 'c-1', clientName: 'Acme', projectId: 'p-1', projectName: 'Alpha' }),
    row({ id: 'a-3', name: 'Tree', clientId: 'c-1', clientName: 'Acme', projectId: 'p-2', projectName: 'Beta' }),
    row({ id: 'a-4', name: 'Door', clientId: 'c-2', clientName: 'Zenith', projectId: 'p-3', projectName: 'Gamma' }),
  ]);
  assert.strictEqual(p.count, 4);

  const acme = p.clients.find((c) => c.name === 'Acme');
  assert.ok(acme, 'the client is a group');
  assert.strictEqual(acme.total, 3, 'and its heading carries its own total');
  assert.deepStrictEqual(acme.projects.map((x) => `${x.name}:${x.total}`), ['Alpha:2', 'Beta:1']);
  assert.strictEqual(p.clients.find((c) => c.name === 'Zenith').total, 1);

  /* THE TOTALS ADD UP, which a mutant grouping by the wrong key — the project
     where the client belongs, or the asset's type — would break while still
     producing a tidy-looking panel. */
  assert.strictEqual(p.clients.reduce((n, c) => n + c.total, 0), p.count);
  for (const c of p.clients) {
    assert.strictEqual(c.projects.reduce((n, x) => n + x.total, 0), c.total);
  }
  /* AND THE KEY IS THE CLIENT'S ID, not its name: two clients may not share a
     name today (there is a unique key on it) but grouping on a name is one
     rename away from merging two clients' work into one heading. */
  assert.match(SRC('waiting-work.js'), /const key = asset\.clientId && asset\.clientName \? asset\.clientId : NO_CLIENT;/);
});

test('a project with no readable client gets its own group, named, and last', async () => {
  const p = await panelOf([
    row({ id: 'a-1', name: 'Orphan', clientId: 'ghost-id', clientName: null, projectId: 'p-9', projectName: 'Legacy' }),
    row({ id: 'a-2', name: 'Hero', clientId: 'c-1', clientName: 'Acme' }),
  ]);
  const names = p.clients.map((c) => c.name);
  assert.deepStrictEqual(names, ['Acme', waitingWork.NO_CLIENT_LABEL]);
  assert.strictEqual(waitingWork.NO_CLIENT_LABEL, 'No client');
  const unknown = p.clients[1];
  assert.strictEqual(unknown.unknown, true, 'flagged, so the page can say it is a gap in the data');
  assert.strictEqual(unknown.id, null, 'and it carries no id to pretend it is a client');
  assert.strictEqual(unknown.total, 1);
  assert.strictEqual(p.count, 2, 'and the asset is still counted — never dropped');
});

test('MUTATION 6 — overdue first, then longest waiting, and the cap takes the top of that', async () => {
  const p = await panelOf([
    row({ id: 'a-1', name: 'Fresh', dueDate: '2099-01-01', heldSince: '2026-03-18 04:00:00' }),
    row({ id: 'a-2', name: 'Old', dueDate: null, heldSince: '2026-03-01 04:00:00' }),
    row({ id: 'a-3', name: 'Late', dueDate: '2026-03-10', heldSince: '2026-03-17 04:00:00' }),
  ]);
  const order = p.clients[0].projects[0].assets.map((a) => a.name);
  assert.deepStrictEqual(order, ['Late', 'Old', 'Fresh'],
    'the overdue one leads, then the longest wait');
  assert.strictEqual(p.overdue, 1);

  /* THE CAP IS APPLIED TO THE FLAT, ORDERED LIST — not per group. Capping each
     group would show a few of every client and call it the cap, which is a
     different list from "the most urgent". */
  const many = Array.from({ length: 60 }, (_, i) => row({
    id: `a-${i}`, name: `Asset ${String(i).padStart(2, '0')}`,
    clientId: `c-${i % 6}`, clientName: `Client ${i % 6}`,
    projectId: `p-${i % 12}`, projectName: `Project ${i % 12}`,
    dueDate: i < 3 ? '2026-03-01' : null,
  }));
  const capped = await panelOf(many);
  assert.strictEqual(capped.count, 60, 'the total is the whole truth');
  assert.strictEqual(capped.shownCount, waitingWork.ASSET_CAP);
  assert.strictEqual(capped.more, 60 - waitingWork.ASSET_CAP);
  const drawn = capped.clients.flatMap((c) => c.projects.flatMap((x) => x.assets));
  assert.strictEqual(drawn.length, waitingWork.ASSET_CAP);
  assert.strictEqual(drawn.filter((a) => a.overdue).length, 3,
    'and all three overdue ones survived the cap, whichever clients they were under');

  const all = await panelOf(many, { all: true });
  assert.strictEqual(all.shownCount, 60);
  assert.strictEqual(all.more, 0);
});

test('how long it has been waiting is the later of the two moments, and it says which', async () => {
  const now = ist(`${WED}T11:00:00`);

  /* ASSIGNED ON MONDAY, NOTHING SINCE. The wait runs from the assignment. */
  const assigned = (await panelOf([row({ heldSince: '2026-03-16 04:00:00', stateSince: null })], { now }))
    .clients[0].projects[0].assets[0];
  assert.strictEqual(assigned.waitingFrom, 'assigned');
  assert.strictEqual(assigned.waitingDays, 2, 'Monday 09:30 IST to Wednesday 11:00 IST');

  /* ASSIGNED A FORTNIGHT AGO AND SENT BACK YESTERDAY. The wait runs from the
     status change: what they are waiting to do changed, so the clock restarts —
     measured from the assignment it would make the studio look slower than it
     is. */
  const sentBack = (await panelOf([row({
    status: 'tl_changes_requested', heldSince: '2026-03-04 04:00:00', stateSince: '2026-03-17 04:00:00',
  })], { now })).clients[0].projects[0].assets[0];
  assert.strictEqual(sentBack.waitingFrom, 'status');
  assert.strictEqual(sentBack.waitingDays, 1);

  /* REASSIGNED AFTER THE FEEDBACK. For the new person it is new work, so the
     wait runs from the assignment even though the status is older. */
  const moved = (await panelOf([row({
    status: 'tl_changes_requested', heldSince: '2026-03-18 04:00:00', stateSince: '2026-03-10 04:00:00',
  })], { now })).clients[0].projects[0].assets[0];
  assert.strictEqual(moved.waitingFrom, 'assigned');
  assert.strictEqual(moved.waitingDays, 0);

  /* NEITHER RECORDED — an asset assigned before asset_assignments existed with
     no event for its current status. Null, not fifty-six years. */
  const unknown = (await panelOf([row({ heldSince: null, stateSince: null })], { now }))
    .clients[0].projects[0].assets[0];
  assert.strictEqual(unknown.waitingSince, null);
  assert.strictEqual(unknown.waitingDays, null);
  assert.match(PAGE, /waiting, since when is not recorded/, 'and the page says so in words');
});

test('overdue is a comparison of calendar days, not of instants', async () => {
  const assets = (await panelOf([
    row({ id: 'a-1', name: 'Yesterday', dueDate: TUE }),
    row({ id: 'a-2', name: 'Today', dueDate: WED }),
    row({ id: 'a-3', name: 'Tomorrow', dueDate: '2026-03-19' }),
    row({ id: 'a-4', name: 'None', dueDate: null }),
  ], { today: WED })).clients[0].projects[0].assets;
  const by = (n) => assets.find((a) => a.name === n);
  assert.strictEqual(by('Yesterday').overdue, true);
  assert.strictEqual(by('Today').overdue, false,
    'a thing due today is not overdue at nine in the morning, and not at six in the evening either');
  assert.strictEqual(by('Tomorrow').overdue, false);
  assert.strictEqual(by('None').overdue, false, 'and no due date is not an overdue one');
  assert.strictEqual(by('Yesterday').dueInDays, -1);
  assert.strictEqual(by('Tomorrow').dueInDays, 1);
});

test('the status is on the row, so it is clear why it counts', async () => {
  const assets = (await panelOf([
    row({ id: 'a-1', status: 'assigned' }),
    row({ id: 'a-2', status: 'tl_changes_requested' }),
    row({ id: 'a-3', status: 'cd_changes_requested' }),
    row({ id: 'a-4', status: 'game_feedback' }),
  ])).clients[0].projects[0].assets;
  const labels = assets.map((a) => a.statusLabel).sort();
  assert.deepStrictEqual(labels, ['Assigned', 'CD Feedbacks', 'Game Feedback', 'TL Feedbacks']);
  /* THE LABELS ARE THE WORKFLOW'S, not a second set written here — the board,
     the drawer and this panel say the same word for the same state. */
  for (const a of assets) assert.strictEqual(a.statusLabel, workflow.label(a.status));
});

test('what "waiting" means is stated once, by the module that decides it', () => {
  const e = waitingWork.EXPLAINER;
  assert.match(e, /assigned to this person and on their desk/);
  assert.match(e, /Assigned and not started/);
  assert.match(e, /TL Feedbacks, CD Feedbacks or Game Feedback/);
  assert.match(e, /In Progress\) is not waiting/);
  assert.match(e, /nor is anything sitting with a reviewer/);
  assert.match(e, /work out with a freelancer/);
  /* THE PANEL PRINTS THE SERVER'S SENTENCE. A second description in the browser
     would go on saying this after somebody changed the predicate. */
  assert.match(PAGE, /p\.explainer \|\| \(d && d\.waitingExplainer\)/);
  assert.ok(!PAGE.includes('Assigned and not started'),
    'the page does not carry its own copy of the rule');
});

// ===========================================================================
// 3. THE PAGE. Clicked, not read.
// ===========================================================================

/* The follow-up section lifted out and run against a stub DOM, the same way
 * tests/follow-up.test.js and tests/follow-up-reminders.test.js lift it — with
 * the four things the panel reaches for added to the stubs:
 *
 *   api                 the one call per person
 *   openProjectBoard    the navigation the Attention Required chips use
 *   revealAsset         the drawer half openNotification uses
 *   projectReachable /  the project snapshot, because this panel is about work
 *   refreshProjects     that has moved since the page loaded
 *
 * THE LAST THREE ARE STUBS AND NOT COPIES. Asserting that they were called,
 * with what, is the whole of "the link uses the existing navigation" — a test
 * that reimplemented them here would pass over a handler that had its own.
 */
function pageHarness({ permissions: perms = ['report.follow_up', 'user.view'],
  payload = null, responses = {} } = {}) {
  const from = PAGE.indexOf('let FOLLOW_UP = null;');
  const to = PAGE.indexOf('let THEME_VERSION = null;');
  assert.ok(from !== -1 && to > from, 'the follow-up section is in the page');
  const section = PAGE.slice(from, to);

  /* AND THE RESET renderAdminDashboard DOES ON EVERY DRAW, taken the same way:
     whatever it does to this section's module state is what a redraw does. The
     panel surviving it is a property of what is NOT in these lines. */
  const resetFrom = PAGE.indexOf('  FOLLOW_UP = d.followUp || null;');
  const resetTo = PAGE.indexOf('  /* THE CHIPS ARE DECIDED AGAINST A CURRENT PROJECT LIST');
  assert.ok(resetFrom !== -1 && resetTo > resetFrom);
  const reset = PAGE.slice(resetFrom, resetTo);

  const calls = { api: [], board: [], revealed: [], toasts: [], refreshed: 0 };
  const captured = { html: '' };
  let nodes = [];
  let byId = {};

  function parse(html) {
    const out = [];
    const ids = {};
    const re = /<(button|input|span|div)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
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
      const node = {
        tagName: tag.toUpperCase(),
        attrs, dataset,
        disabled: /(^|\s)disabled(\s|$)/.test(attrsText),
        classes: (attrs.class || '').split(/\s+/).filter(Boolean),
        value: attrs.value || '',
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        fire(type) {
          const ev = { stopPropagation() { this.stopped = true; }, stopped: false };
          for (const fn of this.listeners[type] || []) fn(ev);
          return ev;
        },
        click() { return this.fire('click'); },
      };
      out.push(node);
      if (attrs.id) ids[attrs.id] = node;
    }
    nodes = out;
    byId = ids;
    return out;
  }

  const slot = {
    set innerHTML(v) { captured.html = v; parse(v); },
    get innerHTML() { return captured.html; },
  };
  const document = {
    getElementById: (id) => (id === 'followUpSlot' ? slot : (byId[id] || null)),
    querySelectorAll: (sel) => {
      const m = sel.match(/\[([a-z-]+)\]/);
      if (!m) return [];
      const key = m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return nodes.filter((n) => key in n.dataset);
    },
  };

  const api = async (url, opts) => {
    calls.api.push({ url, opts });
    const who = (url.match(/waiting\/([^?]+)/) || [])[1];
    if (who !== undefined) {
      const answer = responses[who];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(url);
      if (answer === undefined) throw new Error(`no stub for ${who}`);
      return answer;
    }
    return payload;
  };

  const built = new Function(
    'document', 'escapeHTML', 'can', 'caps', 'api', 'openUserDetail', 'showToast', 'askConfirm',
    'openProjectBoard', 'revealAsset', 'projectReachable', 'refreshProjects',
    `${section}
     ${'function __redraw(d){\n' + reset + '\n}'}
     return {
       renderFollowUp, wireFollowUp, paintFollowUp, loadFollowUp,
       toggleWaiting, loadWaiting, openWaitingAsset,
       redraw: __redraw,
       set: (d) => { FOLLOW_UP = d; }, get: () => FOLLOW_UP,
       setAsk: (a) => { FOLLOW_UP_ASK = a; FOLLOW_UP_SHOWN = a; },
       open: () => FU_OPEN, panel: () => FU_PANEL, busy: () => FU_PANEL_BUSY,
       perr: () => FU_PANEL_ERR,
     };`
  )(
    document,
    (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    (...keys) => keys.some((k) => perms.includes(k)),
    () => ({ projectScope: 'all', manageUsers: true }),
    api,
    () => {},
    (t) => calls.toasts.push(t),
    async () => true,
    (projectId, statuses) => { calls.board.push({ projectId, statuses }); return true; },
    async (assetId) => { calls.revealed.push(assetId); return true; },
    () => true,
    async () => { calls.refreshed += 1; return true; },
  );

  if (payload) built.set(payload);
  return { ...built, calls, captured, nodes: () => nodes, slot };
}

const waitRow = (over = {}) => ({
  id: 'u-1', name: 'Ana', role: 'game_artist', roleLabel: 'Game Artist',
  held: 3, expandable: true, missed: 1, both: false, days: [WED],
  activity: null,
  remind: { kind: 'start', subjectDate: WED, permitted: false, may: false, code: 'ok',
    reason: null, sent: 0, cap: 1, last: null, auto: null },
  ...over,
});

const waitPayload = (rows, over = {}) => ({
  ok: true, unavailable: null, mode: 'day', date: WED, from: WED, to: WED,
  today: WED, previousWorkingDay: TUE,
  startedFor: { from: WED, to: WED, days: [WED] },
  filledFor: null, workingDay: true,
  grace: { minutes: 60, holds: false, until: null, opensAt: null, clockShut: false },
  notStarted: { rows, total: rows.length, more: 0 },
  notFilled: { rows: [], total: 0, more: 0 },
  overlap: 0, expected: rows.length, heldLabel: 'waiting on them',
  earliest: '2026-01-02', cap: 25, maxRangeDays: 31, notes: [],
  scope: { projects: 1, studioWide: true, roles: 8 },
  activityExplainer: 'x', streakThreshold: 3, streakLookBack: 30,
  lastSeenRecorded: true, sort: 'urgency', cached: false,
  waitingExplainer: waitingWork.EXPLAINER, waitingFigure: true,
  reminders: { permitted: false, manualEnabled: true, emailEnabled: false, cap: 1,
    logged: true, window: { ok: true } },
  ...over,
});

const panelAnswer = (over = {}) => ({
  count: 3, shownCount: 3, more: 0, cap: 50, overdue: 1, today: WED,
  userId: 'u-1', elsewhere: false, studioWide: true, explainer: waitingWork.EXPLAINER,
  clients: [{
    id: 'c-1', name: 'Acme', unknown: false, total: 2, overdue: 1,
    projects: [{
      id: 'p-1', name: 'Alpha', code: 'ALP', total: 2, overdue: 1,
      assets: [
        { id: 'a-1', code: 'CH-001', name: 'Hero', type: 'character', typeLabel: 'Character',
          status: 'tl_changes_requested', statusLabel: 'TL Feedbacks', dueDate: '2026-03-10',
          overdue: true, dueInDays: -8, waitingDays: 2, waitingFrom: 'status',
          waitingSince: '2026-03-16T04:00:00.000Z', projectId: 'p-1' },
        { id: 'a-2', code: 'PR-002', name: 'Crate', type: 'prop', typeLabel: 'Prop',
          status: 'assigned', statusLabel: 'Assigned', dueDate: null, overdue: false,
          dueInDays: null, waitingDays: 1, waitingFrom: 'assigned',
          waitingSince: '2026-03-17T04:00:00.000Z', projectId: 'p-1' },
      ],
    }],
  }, {
    id: null, name: 'No client', unknown: true, total: 1, overdue: 0,
    projects: [{
      id: 'p-9', name: 'Legacy', code: null, total: 1, overdue: 0,
      assets: [
        { id: 'a-3', code: null, name: 'Orphan', type: 'character', typeLabel: 'Character',
          status: 'assigned', statusLabel: 'Assigned', dueDate: null, overdue: false,
          dueInDays: null, waitingDays: 0, waitingFrom: 'assigned',
          waitingSince: '2026-03-18T04:00:00.000Z', projectId: 'p-9' },
      ],
    }],
  }],
  ...over,
});

test('the figure is a button, and clicking it opens the panel with its groups', async () => {
  const h = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': panelAnswer() } });
  h.paintFollowUp();

  const figure = h.nodes().find((n) => 'fuWaiting' in n.dataset);
  assert.ok(figure, 'the figure is drawn as a control');
  assert.strictEqual(figure.tagName, 'BUTTON',
    'a <button>, so Enter and Space and the tab order come for free');
  assert.strictEqual(figure.attrs['aria-expanded'], 'false');
  assert.match(figure.attrs['aria-label'], /Show the 3 assets waiting on Ana/);

  figure.click();
  await new Promise((r) => setImmediate(r));

  const html = h.captured.html;
  assert.match(html, /Acme/, 'the client is a heading');
  assert.match(html, /Alpha/, 'and the project under it');
  assert.match(html, /CH-001 · Hero/, 'with the asset named');
  assert.match(html, /TL Feedbacks/, 'and the status that says why it counts');
  assert.match(html, /Overdue — due 2026-03-10/);
  assert.match(html, /2 days in TL Feedbacks/, 'and how long it has been waiting');
  assert.match(html, /1 day since assigned/);
  assert.match(html, /No client/, 'the orphan group is named');
  assert.match(html, /Character/, 'the type is shown');
  assert.match(html, /Assigned and not started/, 'and the help line says what waiting means');

  /* THE TOTALS ON THE HEADINGS ARE THE SERVER'S. 2 under Acme, 1 under No
     client, 3 at the top. */
  assert.match(html, /<span class="fu-cg-n">2 · 1 overdue<\/span>/);
  assert.match(html, /<span class="fu-pg-n">2 · 1 overdue<\/span>/);
  assert.match(html, /<strong>3<\/strong>\s*waiting on Ana/);

  const after = h.nodes().find((n) => 'fuWaiting' in n.dataset);
  assert.strictEqual(after.attrs['aria-expanded'], 'true', 'and the control says it is expanded');
  assert.match(after.attrs['aria-label'], /Hide the 3 assets/);

  /* ONE CALL PER PERSON, and the whole panel came back in it. */
  const asks = h.calls.api.filter((c) => /waiting\//.test(c.url));
  assert.strictEqual(asks.length, 1);
  assert.strictEqual(asks[0].url, '/admin-dashboard/follow-up/waiting/u-1');
});

test('clicking it again closes it', async () => {
  const h = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': panelAnswer() } });
  h.paintFollowUp();
  h.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  await new Promise((r) => setImmediate(r));
  assert.ok(h.open());

  h.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  assert.strictEqual(h.open(), null);
  assert.strictEqual(h.panel(), null);
  assert.ok(!/fu-panel/.test(h.captured.html));
  assert.strictEqual(h.nodes().find((n) => 'fuWaiting' in n.dataset).attrs['aria-expanded'], 'false');
});

test('MUTATION 9 — the link opens that asset\'s own project, on the right lens', async () => {
  const h = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': panelAnswer() } });
  h.paintFollowUp();
  h.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  await new Promise((r) => setImmediate(r));

  const links = h.nodes().filter((n) => 'fuAsset' in n.dataset);
  assert.strictEqual(links.length, 3, 'one per asset');
  /* The orphan asset is in project p-9, not in p-1 — a mutant that handed the
     first project on the panel to every link passes every other assertion. */
  const orphan = links.find((l) => l.dataset.fuAsset === 'a-3');
  assert.strictEqual(orphan.dataset.fuAssetProject, 'p-9');

  await h.openWaitingAsset(orphan.dataset.fuAssetProject, orphan.dataset.fuAsset,
    orphan.dataset.fuAssetStatus);
  assert.deepStrictEqual(h.calls.board, [{ projectId: 'p-9', statuses: ['assigned'] }],
    'the project it belongs to, with its status handed to the lens');
  assert.deepStrictEqual(h.calls.revealed, ['a-3'], 'and the asset itself is opened');

  const hero = links.find((l) => l.dataset.fuAsset === 'a-1');
  await h.openWaitingAsset(hero.dataset.fuAssetProject, hero.dataset.fuAsset, hero.dataset.fuAssetStatus);
  assert.deepStrictEqual(h.calls.board[1], { projectId: 'p-1', statuses: ['tl_changes_requested'] });

  /* BOTH HALVES ARE THE APPLICATION'S OWN, and this is what makes the link land
     on a board that is not still narrowed by last week's search: the clearing
     and the lens live in openProjectBoard, which the Attention Required chips
     use. */
  assert.match(PAGE, /function openProjectBoard\(projectId, statuses\)\{\n  if\(!selectProject\(projectId\)\) return false;\n  clearBoardNarrowing\(\);\n  boardLensArrival = /);
  const slice = PAGE.slice(PAGE.indexOf('let FOLLOW_UP = null;'), PAGE.indexOf('let THEME_VERSION = null;'));
  assert.ok(!/clearBoardNarrowing|boardLensArrival|selectProject\(/.test(slice),
    'and this section reimplements none of it');
});

test('MUTATION 7 — the panel survives the timed refresh, filled and open', async () => {
  const h = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': panelAnswer() } });
  h.paintFollowUp();
  h.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  await new Promise((r) => setImmediate(r));
  const before = h.calls.api.filter((c) => /waiting\//.test(c.url)).length;

  /* THE REDRAW renderAdminDashboard DOES, exactly: a new payload into
     FOLLOW_UP, FOLLOW_UP_SHOWN and FOLLOW_UP_ERR cleared. A panel held in those
     — or cleared beside them — would vanish every twenty seconds. */
  /* The DASHBOARD payload, not the section's: the reset block reads d.followUp,
     which is what renderAdminDashboard hands it. */
  h.redraw({ followUp: waitPayload([waitRow()]) });
  h.paintFollowUp();

  assert.strictEqual(h.open(), 'start|u-1', 'still open');
  assert.ok(h.panel(), 'and still filled');
  assert.match(h.captured.html, /CH-001 · Hero/, 'drawing the same assets');
  assert.strictEqual(h.calls.api.filter((c) => /waiting\//.test(c.url)).length, before,
    'with no second request — a refetch on every poll is not "surviving" it');
});

test('MUTATION 8 — a slower earlier answer never overwrites a newer one', async () => {
  let releaseAna;
  const anaHeld = new Promise((r) => { releaseAna = r; });
  const h = pageHarness({
    payload: waitPayload([waitRow(), waitRow({ id: 'u-2', name: 'Bo' })]),
    responses: {
      'u-1': () => anaHeld,
      'u-2': panelAnswer({ userId: 'u-2', count: 1, shownCount: 1, overdue: 0, clients: [{
        id: 'c-9', name: 'Zenith', unknown: false, total: 1, overdue: 0,
        projects: [{ id: 'p-7', name: 'Omega', code: null, total: 1, overdue: 0, assets: [
          { id: 'a-9', code: 'CH-009', name: 'Bo asset', type: 'character', typeLabel: 'Character',
            status: 'assigned', statusLabel: 'Assigned', dueDate: null, overdue: false,
            dueInDays: null, waitingDays: 0, waitingFrom: 'assigned',
            waitingSince: '2026-03-18T04:00:00.000Z', projectId: 'p-7' }] }],
      }] }),
    },
  });
  h.paintFollowUp();

  // Ana first — her answer is held open.
  const ana = h.loadWaiting('start|u-1');
  // Then Bo, which answers immediately.
  await h.loadWaiting('start|u-2');
  assert.match(h.captured.html, /Bo asset/);

  // Ana's answer arrives last, for a panel nobody is looking at any more.
  releaseAna(panelAnswer());
  await ana;
  assert.strictEqual(h.open(), 'start|u-2', 'Bo is still the open one');
  assert.match(h.captured.html, /Bo asset/);
  assert.ok(!/CH-001 · Hero/.test(h.captured.html),
    'and Ana\'s assets were never drawn under Bo\'s name');
});

test('loading and failure are both said, and a failure keeps the panel open', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const h = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': () => held } });
  h.paintFollowUp();
  const pending = h.loadWaiting('start|u-1');
  assert.ok(h.busy());
  assert.match(h.captured.html, /Reading what is waiting on Ana…/);
  release(panelAnswer());
  await pending;
  assert.ok(!h.busy());

  const bad = pageHarness({
    payload: waitPayload([waitRow()]),
    responses: { 'u-1': new Error('the server said no') },
  });
  bad.paintFollowUp();
  await bad.loadWaiting('start|u-1');
  assert.match(bad.captured.html, /That could not be read — the server said no\./,
    'the server\'s own words');
  assert.match(bad.captured.html, /data-fu-waiting-retry/, 'with a retry');
  assert.strictEqual(bad.open(), 'start|u-1',
    'and the panel stays open — one that closed itself would look like a figure with nothing behind it');

  /* AND THE RETRY REALLY RETRIES. */
  const retry = bad.nodes().find((n) => 'fuWaitingRetry' in n.dataset);
  assert.ok(retry);
  retry.click();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bad.calls.api.filter((c) => /waiting\//.test(c.url)).length, 2);
});

test('a past date\'s figure is plain text, with no control and no panel', async () => {
  const past = waitPayload([waitRow({ expandable: false })],
    { date: TUE, from: TUE, to: TUE, heldLabel: 'held that day', waitingFigure: false });
  const h = pageHarness({ payload: past, responses: {} });
  h.paintFollowUp();
  assert.match(h.captured.html, /<span class="fu-held">3 held that day<\/span>/);
  assert.ok(!/data-fu-waiting=/.test(h.captured.html),
    'nothing to click — the panel cannot be reconstructed for a past date');
  assert.ok(!/fu-panel/.test(h.captured.html));

  /* AND A PANEL OPEN WHEN SOMEBODY PICKS A PAST DATE IS CLOSED, not left under
     a number that now means something else. */
  const open = pageHarness({ payload: waitPayload([waitRow()]), responses: { 'u-1': panelAnswer() } });
  open.paintFollowUp();
  open.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  await new Promise((r) => setImmediate(r));
  assert.ok(open.open());
  open.setAsk({ mode: 'day', date: WED });
  await open.loadFollowUp({ mode: 'day', date: TUE });
  assert.strictEqual(open.open(), null, 'picking another date closes it');
});

test('"show all" asks again with the cap lifted', async () => {
  const h = pageHarness({
    payload: waitPayload([waitRow({ held: 60 })]),
    responses: { 'u-1': (url) => panelAnswer(url.includes('all=1')
      ? { count: 60, shownCount: 60, more: 0 }
      : { count: 60, shownCount: 50, more: 10 }) },
  });
  h.paintFollowUp();
  h.nodes().find((n) => 'fuWaiting' in n.dataset).click();
  await new Promise((r) => setImmediate(r));
  assert.match(h.captured.html, /showing 50/);
  assert.match(h.captured.html, /show all 60/);

  h.nodes().find((n) => 'fuWaitingAll' in n.dataset).click();
  await new Promise((r) => setImmediate(r));
  const asks = h.calls.api.filter((c) => /waiting\//.test(c.url));
  assert.match(asks[asks.length - 1].url, /\?all=1$/);
});

// ===========================================================================
// 4. THE QUERY BUDGET. One read for the panel, whatever is in it.
// ===========================================================================

test('MUTATION 3 — the panel is one query, for one asset and for two hundred', async () => {
  const one = stubDb([[/FROM assets a/, [row()]]]);
  await waitingWork.panelFor(one, 'u-1', { studioWide: true, today: WED, now: ist(`${WED}T11:00:00`) });
  assert.strictEqual(one.calls.length, 1);

  /* THE CLIENT IS DERIVED FROM THE PROJECT, because that is how the schema
     works: a project belongs to exactly one client. Forty projects spread over
     eight clients, five projects each. */
  const many = Array.from({ length: 200 }, (_, i) => {
    const project = i % 40;
    return row({
      id: `a-${i}`, name: `Asset ${i}`,
      clientId: `c-${project % 8}`, clientName: `Client ${project % 8}`,
      projectId: `p-${project}`, projectName: `Project ${project}`,
    });
  });
  const big = stubDb([[/FROM assets a/, many]]);
  const panel = await waitingWork.panelFor(big, 'u-1', { studioWide: true, today: WED, now: ist(`${WED}T11:00:00`), all: true });
  assert.strictEqual(big.calls.length, 1,
    'one read — fifteen clients and forty projects do not become fifty-five more queries');
  assert.strictEqual(panel.count, 200);
  assert.strictEqual(panel.clients.length, 8);
  assert.strictEqual(panel.clients.reduce((n, c) => n + c.projects.length, 0), 40);

  /* THE GROUPING IS DONE IN JAVASCRIPT FROM ONE FLAT READ, which is what makes
     that true. The two correlated subqueries are part of the same statement, so
     they are one round trip however many rows come back. */
  const src = SRC('waiting-work.js');
  const listBody = src.slice(src.indexOf('async function listFor'), src.indexOf('ONE ROW, AS THE PANEL READS IT'));
  assert.strictEqual((listBody.match(/db\.query/g) || []).length, 1,
    'listFor issues exactly one query');
  assert.ok(!/for \(|\.map\(async|await .*\bin\b/.test(listBody.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and nothing in it awaits inside a loop');

  /* AND NEITHER DOES THE HANDLER. A per-asset or per-project read there would
     be an N+1 the module above could not prevent. */
  const route = SRC('routes/admin-dashboard.js');
  const handler = route.slice(route.indexOf("router.get('/follow-up/waiting/:userId'"),
    route.indexOf('THE TWO REMINDER ENDPOINTS'));
  assert.ok(!/for \(|forEach|\.map\(async/.test(handler), 'the handler has no loop in it');
  assert.strictEqual((handler.match(/await /g) || []).length, 4,
    'four awaits: the projects, the reach check, the panel, and the out-of-reach count');
});

// ===========================================================================
// 5. END TO END.
// ===========================================================================

test('the panel, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let root;
  const token = {};
  const id = {};

  const as = (who, p, opts = {}) => api(server.base, p, { token: token[who], ...opts });
  const panel = (who, userId, q = '') => as(who, `/admin-dashboard/follow-up/waiting/${userId}${q}`);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'w-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'w-token', name: 'Root', email: 'root@wk.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@wk.test');
    root = token.root;
    await openStudio(server.base, root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@wk.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@wk.test', 'game_artist');
    await make('lead', 'Lee Lead', 'lee@wk.test', 'team_lead');
    /* An Admin — projectScope 'owned' — who will own one project and not the
       other, which is the scope case. */
    await make('sol', 'Sol Admin', 'sol@wk.test', 'admin');
    /* AND ONE WHO OWNS NOTHING AT ALL, for the empty-scope case below. */
    await make('nob', 'Nob Admin', 'nob@wk.test', 'admin');
    await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@wk.test'");

    const client = async (name) => (await as('root', '/clients', { method: 'POST', body: { name } })).body.client.id;
    id.acme = await client('Acme');
    id.zenith = await client('Zenith');
    id.unassigned = await systemClientId(server.base, root);

    const project = async (name, clientId, owner = 'root') => {
      const r = await as(owner, '/projects', { method: 'POST', body: { name, clientId } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.project.id;
    };
    id.alpha = await project('Alpha', id.acme);
    id.beta = await project('Beta', id.acme);
    id.gamma = await project('Gamma', id.zenith);
    /* SOL'S OWN PROJECT, so a narrower viewer has exactly one in reach. */
    id.solo = await project('Solo', id.zenith, 'sol');

    for (const key of ['ana', 'bo', 'lead']) {
      for (const p of [id.alpha, id.beta, id.gamma, id.solo]) {
        await as('root', `/users/${id[key]}`, { method: 'PATCH', body: { projectId: p } });
      }
    }

    /* Every asset is created with its assignee, then moved to the status the
       case is about. The create route always starts an asset at 'assigned' for
       somebody — see the note in src/routes/assets.js — so the status is set
       straight afterwards, which is also how a fixed fixture avoids driving the
       whole review pipeline for each row. */
    id.assets = {};
    const asset = async (key, projectId, who, { status = null, due = null, routed = false, name = key } = {}) => {
      const r = await as('root', `/assets/project/${projectId}`, {
        method: 'POST', body: { name, type: 'character', assigneeId: id[who], due } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id.assets[key] = r.body.asset.id;
      if (status) {
        await sql(cfg, 'UPDATE assets SET `status` = ?, routed_to_id = ? WHERE id = ?',
          [status, routed ? id[who] : null, r.body.asset.id]);
      }
      return r.body.asset.id;
    };

    // Ana, in Alpha: one overdue assigned, one assigned with no date, one relayed CD Feedbacks.
    await asset('a_overdue', id.alpha, 'ana', { due: '2026-03-10', name: 'Overdue Hero' });
    await asset('a_plain', id.alpha, 'ana', { name: 'Plain Crate' });
    await asset('a_cd', id.alpha, 'ana', { status: 'cd_changes_requested', routed: true, name: 'Relayed Tree' });
    // And in Beta: a TL Feedbacks, which is theirs even unrouted.
    await asset('a_tl', id.beta, 'ana', { status: 'tl_changes_requested', name: 'Sent Back Door' });
    // Not waiting: started, in review, approved.
    await asset('a_running', id.alpha, 'ana', { status: 'in_progress', name: 'On The Clock' });
    await asset('a_review', id.alpha, 'ana', { status: 'pending_tl_review', name: 'With The Lead' });
    await asset('a_appr', id.alpha, 'ana', { status: 'approved_for_client', name: 'Done With' });
    /* CD FEEDBACKS NOT YET RELAYED — routed to nobody, so it is the LEAD's to
       pass on and not Ana's to act on. The branch that would be wrong if
       "routed to nobody" read as "routed to anybody". */
    await asset('a_cd_unrelayed', id.beta, 'ana', { status: 'cd_changes_requested', name: 'Unrelayed Note' });
    // Ana also holds one in Sol's project, which only Sol and a studio-wide viewer can see.
    await asset('a_solo', id.solo, 'ana', { name: 'Solo Work' });

    // Bo: one waiting, in Gamma under a different client.
    await asset('b_one', id.gamma, 'bo', { due: '2026-03-10', name: 'Bo Overdue' });

    /* A PROJECT WHOSE CLIENT CANNOT BE READ. projects.client_id is NOT NULL with
       a RESTRICT key, so this cannot happen through the API — but
       ensureClients() logs "the foreign key is still missing" for a database
       whose earlier boot could not create it, and that is the deployment this
       case is about. The key is dropped to reach it, exactly as such a database
       would be, and put back afterwards. */
    id.legacy = await project('Legacy', id.acme);
    await asset('a_orphan', id.legacy, 'ana', { name: 'Orphan Prop' });
    await sql(cfg, 'ALTER TABLE projects DROP FOREIGN KEY fk_projects_client');
    await sql(cfg, 'UPDATE projects SET client_id = ? WHERE id = ?',
      ['00000000-0000-0000-0000-000000000000', id.legacy]);
  });

  t.after(() => stopServer(server));

  await t.test('the right assets, grouped Client then Project, with the totals', async () => {
    const r = await panel('root', id.ana);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const names = r.body.clients.flatMap((c) => c.projects.flatMap((p) => p.assets.map((a) => a.name))).sort();
    assert.deepStrictEqual(names, [
      'Orphan Prop', 'Overdue Hero', 'Plain Crate', 'Relayed Tree', 'Sent Back Door', 'Solo Work',
    ], 'the six that are waiting, and none of the five that are not');
    assert.strictEqual(r.body.count, 6);

    const acme = r.body.clients.find((c) => c.name === 'Acme');
    assert.strictEqual(acme.total, 4, 'Alpha\'s three and Beta\'s one');
    assert.deepStrictEqual(acme.projects.map((p) => `${p.name}:${p.total}`).sort(), ['Alpha:3', 'Beta:1']);
    assert.strictEqual(r.body.clients.find((c) => c.name === 'Zenith').total, 1);

    // The group whose client cannot be read is named, and last.
    assert.strictEqual(r.body.clients[r.body.clients.length - 1].name, 'No client');
    assert.strictEqual(r.body.clients[r.body.clients.length - 1].unknown, true);
    assert.strictEqual(r.body.clients[r.body.clients.length - 1].total, 1);

    // Statuses, due dates and the overdue flag, on the rows.
    const flat = r.body.clients.flatMap((c) => c.projects.flatMap((p) => p.assets));
    const by = (n) => flat.find((a) => a.name === n);
    assert.strictEqual(by('Overdue Hero').statusLabel, 'Assigned');
    assert.strictEqual(by('Overdue Hero').dueDate, '2026-03-10');
    assert.strictEqual(by('Overdue Hero').overdue, true);
    assert.strictEqual(by('Plain Crate').dueDate, null);
    assert.strictEqual(by('Plain Crate').overdue, false);
    assert.strictEqual(by('Relayed Tree').statusLabel, 'CD Feedbacks');
    assert.strictEqual(by('Sent Back Door').statusLabel, 'TL Feedbacks');
    assert.strictEqual(by('Overdue Hero').typeLabel, 'Character');
    assert.strictEqual(r.body.overdue, 1);
    // The wait is recorded, from one of the two moments, for every row.
    for (const a of flat) {
      assert.ok(a.waitingSince, `${a.name} knows when it started waiting`);
      assert.ok(['assigned', 'status'].includes(a.waitingFrom));
      assert.ok(a.waitingDays >= 0);
    }
    // And the first group's first row is the overdue one.
    assert.strictEqual(r.body.clients[0].projects[0].assets[0].name, 'Overdue Hero');
  });

  await t.test('MUTATION 1 (live) — the number on the row is the number in the panel', async () => {
    const section = await as('root', '/admin-dashboard/follow-up');
    assert.strictEqual(section.status, 200, JSON.stringify(section.body));
    const rows = [...section.body.notStarted.rows, ...(section.body.notFilled.rows || [])];
    const seen = new Set();
    let checked = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      // eslint-disable-next-line no-await-in-loop
      const p = await panel('root', r.id);
      assert.strictEqual(p.status, 200, JSON.stringify(p.body));
      assert.strictEqual(p.body.count, r.held,
        `${r.name}: the row says ${r.held} and the panel holds ${p.body.count}`);
      assert.strictEqual(r.expandable, r.held > 0);
      checked += 1;
    }
    assert.ok(checked >= 2, `several people were checked, not one (${checked})`);
    assert.strictEqual(section.body.heldLabel, 'waiting on them');
    assert.strictEqual(section.body.waitingFigure, true);
  });

  await t.test('MUTATION 2 (live) — the one on the clock, and the ones in review, are not in it', async () => {
    const r = await panel('root', id.ana);
    const ids = r.body.clients.flatMap((c) => c.projects.flatMap((p) => p.assets.map((a) => a.id)));
    for (const key of ['a_running', 'a_review', 'a_appr', 'a_cd_unrelayed']) {
      assert.ok(!ids.includes(id.assets[key]), `${key} is not waiting on Ana`);
    }
    /* AND ANA STILL HAS THE OTHERS. The exclusion is per asset: somebody with a
       timer running has not thereby cleared their queue. */
    assert.ok(ids.includes(id.assets.a_plain));
    assert.strictEqual(r.body.count, 6);

    /* THE UNRELAYED CD FEEDBACKS IS THE SUBTLE ONE: routed to nobody, so it is
       the lead's to pass on. A predicate that read "routed to nobody" as
       "routed to anybody" would put it in Ana's queue and let her resubmit past
       the lead who was supposed to brief her. */
    const unrelayed = await sql(cfg, 'SELECT `status`, routed_to_id FROM assets WHERE id = ?',
      [id.assets.a_cd_unrelayed]);
    assert.strictEqual(unrelayed[0].status, 'cd_changes_requested');
    assert.strictEqual(unrelayed[0].routed_to_id, null);
  });

  await t.test('work out with a freelancer is not in anybody\'s queue', async () => {
    /* THE SCHEMA SAYS SO, not a filter: the two assignment routes are mutually
       exclusive. Sending Ana's asset outside is REFUSED while she holds it,
       which is the premise — and once the assignee is cleared the asset has no
       internal assignee to be waiting on. */
    const refused = await as('root', '/outsource/assignments', { method: 'POST', body: {
      freelancerId: '00000000-0000-0000-0000-000000000001',
      projectId: id.alpha, assetId: id.assets.a_plain, decidedManHours: 4 } });
    assert.ok(refused.status >= 400, `outsourcing an assigned task is refused (${refused.status})`);

    const before = (await panel('root', id.ana)).body.count;
    await sql(cfg, 'UPDATE assets SET assignee_id = NULL, routed_to_id = NULL WHERE id = ?',
      [id.assets.a_plain]);
    const after = (await panel('root', id.ana)).body.count;
    assert.strictEqual(after, before - 1,
      'clearing the internal assignee — which is what outsourcing requires — takes it out of her queue');
    await sql(cfg, 'UPDATE assets SET assignee_id = ? WHERE id = ?', [id.ana, id.assets.a_plain]);
  });

  await t.test('MUTATION 4 (live) — a narrower viewer sees only their reach, and the count agrees', async () => {
    /* Sol is an Admin: projectScope 'owned', and they own exactly one project.
       Ana holds one asset in it and five elsewhere. */
    const held = (await as('root', '/permissions/roles/admin')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/admin', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard', 'report.follow_up'])] } });

    const r = await panel('sol', id.ana);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.count, 1, 'only the asset in the project Sol owns');
    const names = r.body.clients.flatMap((c) => c.projects.flatMap((p) => p.assets.map((a) => a.name)));
    assert.deepStrictEqual(names, ['Solo Work']);
    assert.strictEqual(r.body.studioWide, false);

    /* AND THE NUMBER ON SOL'S OWN ROW IS THE SAME ONE. The figure shown to a
       viewer counts only what that viewer can see, which is the whole of why
       the panel and the row have to share a predicate AND a scope. */
    const section = await as('sol', '/admin-dashboard/follow-up');
    const row_ = [...section.body.notStarted.rows, ...(section.body.notFilled.rows || [])]
      .find((x) => x.id === id.ana);
    if (row_) assert.strictEqual(row_.held, r.body.count, 'the row and the panel agree for Sol too');

    /* THE OUT-OF-REACH NOTE IS A BOOLEAN AND NOT A COUNT. "Some of their work
       is elsewhere" tells the reader the panel is a view; a number would tell an
       Admin how busy somebody is on projects they are not on. */
    assert.strictEqual(r.body.elsewhere, true);
    assert.ok(!Object.keys(r.body).some((k) => /elsewhereCount|hidden|outside/i.test(k)),
      'and nothing in the payload counts what is hidden');
    assert.strictEqual((await panel('root', id.ana)).body.elsewhere, false,
      'a studio-wide viewer has nothing outside their reach');

    // Somebody not in reach at all is refused, and the refusal describes nothing.
    const stranger = await panel('sol', id.bo);
    if (stranger.status === 403) {
      assert.ok(!/waiting|asset|project [A-Z]/.test(stranger.body.error), stranger.body.error);
    } else {
      assert.strictEqual(stranger.body.count, 0,
        'or, if they are in reach through a shared project, the panel is simply empty of unreachable work');
    }
    await as('root', '/permissions/roles/admin', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('MUTATION 4b — a viewer with no projects is refused, never shown the studio', async () => {
    /* AN ADMIN WHO OWNS NOTHING, which is the only clean way to have nothing in
       view: projectScope 'owned', and visibleProjects() matches on ownership
       alone for that tier. Lee would not do — a Team Lead is reachable through
       project_team_leads as well as project_members, so "take them off the
       members table" is not the same as "they can see nothing", and an earlier
       draft of this case passed for the wrong reason. */
    const held = (await as('root', '/permissions/roles/admin')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/admin', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard', 'report.follow_up'])] } });

    const r = await panel('nob', id.ana);
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /no projects in view/);
    assert.ok(!/waiting|asset|Alpha|Acme/.test(r.body.error),
      'and the refusal describes none of the work it is withholding');
    await as('root', '/permissions/roles/admin', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('MUTATION 5 (live) — the section\'s own key, and a grant lands on the same token', async () => {
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard'])].filter((k) => k !== 'report.follow_up') } });
    assert.strictEqual((await panel('lead', id.ana)).status, 403,
      'the panel is behind the same key as the list it belongs to');

    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.admin_dashboard', 'report.follow_up'])] } });
    const after = await panel('lead', id.ana);
    assert.strictEqual(after.status, 200,
      'and the same token passes once it is granted — authenticate() resolves per request');
    assert.ok(after.body.count >= 1);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('a past date prints the reconstruction and offers no button', async () => {
    const past = await as('root', `/admin-dashboard/follow-up?date=${TUE}`);
    assert.strictEqual(past.status, 200, JSON.stringify(past.body));
    assert.strictEqual(past.body.heldLabel, 'held that day');
    assert.strictEqual(past.body.waitingFigure, false);
    for (const r of [...past.body.notStarted.rows, ...(past.body.notFilled.rows || [])]) {
      assert.strictEqual(r.expandable, false,
        `${r.name}: a past date's figure is a reconstruction from assignment history, with no list behind it`);
    }
    /* AND THE TWO FIGURES REALLY DIFFER, which is why only one of them is
       clickable — and this is the measurement the report quotes.
       
       THE EPISODES ARE BACK-DATED to make the comparison possible at all: the
       fixture's assets were created by this test, so their assignment episodes
       begin today and overlap no day in March. With them opened on the Monday,
       Tuesday's "held that day" is every asset Ana has ever been given and not
       let go of — the ones in review and the one on the clock included, because
       an episode ends only on reassignment, unassignment or delivery — while
       "waiting on them" is the six she can actually do something about. */
    await sql(cfg, "UPDATE asset_assignments SET assigned_at = '2026-03-16 04:00:00' WHERE user_id = ?",
      [id.ana]);
    /* ASKED WITH all=1, WHICH IS A DIFFERENT CACHE KEY. src/follow-up.js keeps a
       past date's lists for a minute (per viewer, per ask) and that cache lives
       in the SERVER's process — followUp.forget() here would clear this test
       process's copy and nothing the server reads. Changing the ask is the
       honest way to get a fresh draw, and it is also the one the page uses. */
    const again = await as('root', `/admin-dashboard/follow-up?date=${TUE}&all=1`);
    const ana = [...again.body.notStarted.rows, ...(again.body.notFilled.rows || [])]
      .find((r) => r.id === id.ana);
    const now = (await panel('root', id.ana)).body.count;
    assert.ok(ana, 'Ana is on Tuesday\'s list');
    assert.strictEqual(now, 6, 'six are waiting on her now');
    assert.ok(ana.held > now,
      `held that day (${ana.held}) counts more than waiting now (${now}) — episodes, not statuses`);
    /* THE MEASUREMENT, PINNED. Ten assets were ever given to Ana and none was
       reassigned, unassigned or delivered, so every episode is open: the old
       figure counted all ten on a day she held them, where six were hers to act
       on. That is the size of the correction this change made to the row, on
       this fixture, and it is the number the report quotes. */
    assert.strictEqual(ana.held, 10, 'ten episodes were open on Tuesday');
    assert.strictEqual(ana.expandable, false, 'and it is still not a button');
  });

  await t.test('the panel grows with the work and stays one call', async () => {
    /* TWELVE MORE PROJECTS AND SIXTY MORE ASSETS. The assertion is that the
       answer is still right and still arrives in one request — the per-query
       budget is pinned in arithmetic above, where the count can be read. */
    for (let p = 0; p < 12; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pid = (await as('root', '/projects', { method: 'POST',
        body: { name: `Bulk ${p}`, clientId: p % 2 ? id.acme : id.zenith } })).body.project.id;
      for (let a = 0; a < 5; a += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await as('root', `/assets/project/${pid}`, { method: 'POST',
          body: { name: `Bulk ${p}-${a}`, type: 'character', assigneeId: id.bo } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      }
    }
    const r = await panel('root', id.bo);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.count, 61, 'the one from the fixture and the sixty just made');
    assert.strictEqual(r.body.shownCount, waitingWork.ASSET_CAP);
    assert.strictEqual(r.body.more, 61 - waitingWork.ASSET_CAP);
    const all = await panel('root', id.bo, '?all=1');
    assert.strictEqual(all.body.shownCount, 61);

    // And the row still agrees with it.
    const section = await as('root', '/admin-dashboard/follow-up');
    const bo = [...section.body.notStarted.rows, ...(section.body.notFilled.rows || [])]
      .find((x) => x.id === id.bo);
    if (bo) assert.strictEqual(bo.held, 61, 'the figure and the panel agree at sixty-one too');
  });

  await t.test('the index the figure needs is in place after a migration', async () => {
    const keys = await sql(cfg, 'SHOW INDEX FROM assets');
    const names = new Set(keys.map((k) => k.Key_name));
    assert.ok(names.has('idx_assets_assignee'), 'assets is indexed on the assignee');
    assert.ok(names.has('idx_assets_routed'), 'and on the routing');
    assert.ok(names.has('idx_assets_status'));
  });
});
