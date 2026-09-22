/* A filter for every column of the Assets List, on every one of its sub-tabs.
 *
 * WHAT THE STUDIO ASKED FOR. The table has thirteen headings and had two
 * filters, both on one tab. It now has one control per heading, the same
 * controls on every tab, combining with AND, and one button that clears them.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   THE FILTERS RUN, they are not grepped for. The logic lives in the page, so
 *      the block is lifted out of public/index.html and executed here against
 *      rows built by hand. A test that only searched the file for the word
 *      "filter" would pass against a bar that filtered nothing.
 *
 *   ONE PER COLUMN, IN ORDER. Asserted against the table's own <thead>, parsed
 *      out of the page — so adding a fourteenth column without a filter fails
 *      here, which is the whole requirement expressed as something checkable.
 *
 *   THE FILTER AND THE CELL READ THE SAME VALUE. This list's unit is a ROW, and
 *      five columns show the ROUND'S value rather than the asset's: a finished
 *      round shows the status the person left it at, who they were and what
 *      they put in. A filter reading a.status while the cell reads the round's
 *      would hand back rows whose Status cell says something else. Both go
 *      through rowFacts(), and the test that proves it uses a row where the two
 *      answers differ — which is the only kind of row that can catch it.
 *
 *   AND, NOT OR. Asserted as "each filter alone returns more than both
 *      together, and every row in both passes both" rather than by counting,
 *      because a count can be right for the wrong reason.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* The filter machinery, lifted out of the page and run for real.
 *
 * The four reference lookups it calls are the studio's own label tables, which
 * live elsewhere in the page and read from the server. They are stubbed to
 * return the id, because every test here is about VALUES: the filters match on
 * ids and never on displayed text, so a stub that returns the id cannot hide a
 * bug and would expose one that matched on labels. */
const FILTERS = (() => {
  const start = PAGE.indexOf('function rowFacts(row){');
  const end = PAGE.indexOf('\n}\n', PAGE.indexOf('function alMatches(f, v){')) + 3;
  assert.ok(start > 0 && end > start, 'the filter block is in the page');
  const src = PAGE.slice(start, end);
  const make = new Function(`
    const categoryLabel = (id)=>id, typeOf = (id)=>({ label:id }), statusOf = (id)=>({ label:id });
    ${src}
    return { rowFacts, taskState, ASSET_LIST_FILTERS, alPresent, emptyListFilter,
             alIsSet, alAnySet, alMatches, alDateOnly, alInRange, alNumInRange };
  `);
  return make();
})();

const { rowFacts, ASSET_LIST_FILTERS, emptyListFilter, alAnySet, alMatches, alPresent } = FILTERS;

/* A row of the list, with sensible defaults, so each test names only the
   field it is about. `ep` is the assignment episode — null for an asset
   nobody has been put on, active for the live round, inactive for a
   finished one. */
let seq = 0;
function row(over = {}) {
  const n = ++seq;
  const { ep, ...asset } = over;
  return {
    a: {
      id: 'a' + n, code: 'PRP-' + String(n).padStart(3, '0'), name: 'Asset ' + n,
      category: 'hero_model', type: 'prop', man_hours: 4,
      start_date: '2026-03-01', due_date: '2026-06-15',
      status: 'in_progress', priority: 'medium',
      assignee_id: 'u1', assignee_name: 'Ana Artist',
      tasks: [], time_spent_seconds: 3600,
      ...asset,
    },
    ep: ep === undefined ? null : ep,
  };
}
const facts = (r) => rowFacts(r);
const pass = (r, v) => alMatches(rowFacts(r), { ...emptyListFilter(), ...v });
const keep = (rows, v) => rows.filter(r => pass(r, v));

// --- one control per column ------------------------------------------------

test('every column of the table has a filter, in the same order', () => {
  /* The table's own headings, read out of the page. The tick-box column has no
     text and is not a column of data, so it drops out with the empty ones. */
  const head = PAGE.slice(PAGE.indexOf('<table><thead><tr>${headBox}'));
  const thead = head.slice(0, head.indexOf('</tr>'));
  const columns = [...thead.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1].trim());

  assert.ok(columns.length >= 10, 'the headings were found: ' + JSON.stringify(columns));
  assert.deepStrictEqual(
    ASSET_LIST_FILTERS.map(f => f.col), columns,
    'one filter per heading, named the same and in the same order — a column '
    + 'added without a filter, or a filter left behind by a column that went '
    + 'away, fails here'
  );
});

test('each filter is matched to what its column holds', () => {
  const kindOf = Object.fromEntries(ASSET_LIST_FILTERS.map(f => [f.col, f.kind]));
  assert.deepStrictEqual(kindOf, {
    // free text — you type a fragment
    'Code': 'text',
    'Assets Name': 'text',
    // a value from a list
    'Category': 'select',
    'Scope of Work': 'select',
    'Status': 'multi',          // several stages at once, see below
    'Assignee': 'select',
    'Round': 'select',
    'Priority': 'select',
    'Tasks': 'select',
    // a range, entered as two boxes
    'Man Hours': 'number',
    'Start Date': 'date',
    'End Date (Deadline)': 'date',
    'Time Spent': 'number',
  });
});

// --- the guard that matters: the filter reads what the cell shows -----------

test('a finished round is filtered by ITS status, not the asset\'s', () => {
  /* The row that catches a filter reading the wrong field. The asset has moved
     on to Approved for Client; this round ended back at TL Review, and TL
     Review is what its Status cell says. */
  const r = row({
    status: 'approved_for_client',
    ep: { id:'e1', active:false, endedStatus:'pending_tl_review',
          statusAtAssignment:'assigned', userId:'u9', userName:'Ben Bhatt', seconds: 7200 },
  });
  assert.strictEqual(facts(r).status, 'pending_tl_review', 'rowFacts reads the round');

  assert.ok(pass(r, { statuses:['pending_tl_review'] }),
    'filtering for TL Review finds the round whose cell says TL Review');
  assert.ok(!pass(r, { statuses:['approved_for_client'] }),
    'and filtering for the asset\'s CURRENT stage does not — the cell does not say that');
});

test('a finished round is filtered by who held it and what they put in', () => {
  const r = row({
    assignee_id:'u1', assignee_name:'Ana Artist', time_spent_seconds: 360000,
    ep: { id:'e1', active:false, endedStatus:'tl_changes_requested',
          userId:'u9', userName:'Ben Bhatt', seconds: 7200 },
  });
  const f = facts(r);
  assert.strictEqual(f.assigneeId, 'u9', 'the person who held THAT round');
  assert.strictEqual(f.seconds, 7200, 'and the hours they put in, not the asset\'s lifetime');

  assert.ok(pass(r, { assignee:'u9' }));
  assert.ok(!pass(r, { assignee:'u1' }), 'the current assignee is not on this row');
  assert.ok(pass(r, { spentMin:'1', spentMax:'3' }), '7200s is two hours');
  assert.ok(!pass(r, { spentMin:'90' }), 'and not the hundred the asset has in total');
});

// --- combining --------------------------------------------------------------

test('filters combine with AND', () => {
  const rows = [
    row({ name:'Alpha', priority:'high',   type:'prop' }),
    row({ name:'Beta',  priority:'high',   type:'character' }),
    row({ name:'Gamma', priority:'low',    type:'prop' }),
    row({ name:'Delta', priority:'low',    type:'character' }),
  ];
  const byPriority = keep(rows, { priority:'high' });
  const byType = keep(rows, { type:'prop' });
  const both = keep(rows, { priority:'high', type:'prop' });

  assert.strictEqual(byPriority.length, 2);
  assert.strictEqual(byType.length, 2);
  assert.strictEqual(both.length, 1, 'narrower than either on its own');
  assert.strictEqual(both[0].a.name, 'Alpha');
  /* Said as a property rather than a count, because a count can be right for
     the wrong reason: everything that survives both must survive each. */
  for (const r of both) {
    assert.ok(byPriority.includes(r) && byType.includes(r));
  }

  // Three at once, and a fourth that rules everything out.
  assert.strictEqual(keep(rows, { priority:'high', type:'prop', name:'alph' }).length, 1);
  assert.strictEqual(keep(rows, { priority:'high', type:'prop', name:'zzz' }).length, 0);
});

test('a filter left empty is not asked', () => {
  const rows = [row(), row({ priority:'high' }), row({ assignee_id:'', assignee_name:'' })];
  assert.strictEqual(keep(rows, {}).length, rows.length, 'an empty bar is the whole list');
  assert.strictEqual(alAnySet(emptyListFilter()), false);
  assert.strictEqual(alAnySet({ ...emptyListFilter(), priority:'high' }), true);
  assert.strictEqual(alAnySet({ ...emptyListFilter(), statuses:['assigned'] }), true,
    'including the multi-pick, whose empty value is an empty list rather than a string');
});

// --- each data type ---------------------------------------------------------

test('text filters match a fragment, either case', () => {
  const r = row({ name:'Neon Drift Hero', code:'CHR-042' });
  assert.ok(pass(r, { name:'drift' }), 'a fragment from the middle, lower case');
  assert.ok(pass(r, { name:'NEON' }));
  assert.ok(!pass(r, { name:'neondrift' }), 'but not a fragment that is not there');
  assert.ok(pass(r, { code:'chr' }));
  assert.ok(pass(r, { code:'042' }));
  assert.ok(!pass(r, { code:'043' }));
});

test('date filters are an inclusive range, and exclude rows with no date', () => {
  const june = row({ due_date:'2026-06-15' });
  const may  = row({ due_date:'2026-05-31' });
  const july = row({ due_date:'2026-07-01' });
  const none = row({ due_date:null });

  const inJune = { dueFrom:'2026-06-01', dueTo:'2026-06-30' };
  assert.ok(pass(june, inJune));
  assert.ok(!pass(may, inJune));
  assert.ok(!pass(july, inJune));
  assert.ok(!pass(none, inJune),
    'an asset with no deadline is not "inside" a range of deadlines — it would '
    + 'otherwise show up in every date search that was meant to narrow past it');

  // The ends are included, and one end on its own is a half-open range.
  assert.ok(pass(row({ due_date:'2026-06-01' }), inJune));
  assert.ok(pass(row({ due_date:'2026-06-30' }), inJune));
  assert.ok(pass(july, { dueFrom:'2026-06-01' }), 'from only: everything after');
  assert.ok(pass(may, { dueTo:'2026-06-30' }), 'to only: everything before');

  // Start Date is its own range and does not read the deadline.
  assert.ok(pass(row({ start_date:'2026-03-01', due_date:'2026-12-01' }),
    { startFrom:'2026-02-01', startTo:'2026-03-31' }));
  assert.ok(!pass(row({ start_date:'2026-12-01', due_date:'2026-03-01' }),
    { startFrom:'2026-02-01', startTo:'2026-03-31' }));
});

test('a date that arrives as a timestamp is compared as a day', () => {
  /* MySQL hands back a plain 'YYYY-MM-DD' for a DATE column and a full
     timestamp for a DATETIME one, and a driver may hand back a Date object.
     All three are the same day to a person reading the column. */
  const range = { dueFrom:'2026-06-15', dueTo:'2026-06-15' };
  assert.ok(pass(row({ due_date:'2026-06-15' }), range));
  assert.ok(pass(row({ due_date:'2026-06-15T00:00:00.000Z' }), range));
  assert.ok(pass(row({ due_date:new Date('2026-06-15T09:30:00.000Z') }), range));
});

test('number filters are an inclusive range, and exclude rows with no number', () => {
  assert.ok(pass(row({ man_hours:4 }), { hoursMin:'3', hoursMax:'5' }));
  assert.ok(pass(row({ man_hours:3 }), { hoursMin:'3', hoursMax:'5' }), 'the bottom end counts');
  assert.ok(pass(row({ man_hours:5 }), { hoursMin:'3', hoursMax:'5' }), 'and the top');
  assert.ok(!pass(row({ man_hours:6 }), { hoursMin:'3', hoursMax:'5' }));
  assert.ok(!pass(row({ man_hours:null }), { hoursMin:'3' }),
    'an estimate nobody has given is not a number in the range');
  assert.ok(pass(row({ man_hours:9 }), { hoursMin:'3' }), 'min only');
  assert.ok(pass(row({ man_hours:1 }), { hoursMax:'3' }), 'max only');

  // Time Spent is entered in hours and held in seconds.
  assert.ok(pass(row({ time_spent_seconds: 5400 }), { spentMin:'1', spentMax:'2' }),
    '5400s is an hour and a half');
  assert.ok(!pass(row({ time_spent_seconds: 5400 }), { spentMin:'2' }));
});

test('the Status filter takes several stages at once', () => {
  const rows = [
    row({ status:'pending_tl_review' }),
    row({ status:'tl_changes_requested' }),
    row({ status:'tl_approved' }),
    row({ status:'pending_cd_review' }),
    row({ status:'delivered' }),
  ];
  /* The question this screen is actually asked — the three stages around the
     first review gate — which a single dropdown cannot answer. */
  const gate = keep(rows, { statuses:['pending_tl_review','tl_changes_requested','tl_approved'] });
  assert.deepStrictEqual(gate.map(r => r.a.status),
    ['pending_tl_review','tl_changes_requested','tl_approved']);
  assert.strictEqual(keep(rows, { statuses:['delivered'] }).length, 1, 'one is fine too');
  assert.strictEqual(keep(rows, { statuses:[] }).length, rows.length, 'none set is all of them');
});

test('Assignee reaches the rows nobody is on', () => {
  const rows = [
    row({ assignee_id:'u1', assignee_name:'Ana' }),
    row({ assignee_id:'', assignee_name:'' }),
    row({ assignee_id:null, assignee_name:null }),
  ];
  assert.strictEqual(keep(rows, { assignee:'u1' }).length, 1);
  assert.strictEqual(keep(rows, { assignee:'__none__' }).length, 2,
    'unassigned is an answer to "who is on this", not a value the filter cannot reach');

  const entry = ASSET_LIST_FILTERS.find(f => f.col === 'Assignee');
  const opts = entry.options(rows.map(rowFacts));
  assert.ok(opts.some(o => o.id === '__none__'), 'and it is offered when such a row is there');
  assert.ok(!entry.options([rowFacts(rows[0])]).some(o => o.id === '__none__'),
    'and not offered when every row has somebody on it');
});

test('the Round column filters the three things it can say', () => {
  const live = row({ ep:{ id:'e1', active:true, userId:'u1', userName:'Ana', seconds:60 } });
  const done = row({ ep:{ id:'e2', active:false, endedStatus:'assigned', userId:'u1', userName:'Ana', seconds:60 } });
  const never = row();
  assert.deepStrictEqual([live, done, never].map(r => rowFacts(r).round),
    ['current', 'handed_on', 'none']);
  assert.strictEqual(keep([live, done, never], { round:'current' }).length, 1);
  assert.strictEqual(keep([live, done, never], { round:'handed_on' }).length, 1);
  assert.strictEqual(keep([live, done, never], { round:'none' }).length, 1);
});

test('the Tasks column filters on what its fraction means', () => {
  const t = (done, total) => row({
    tasks: Array.from({ length: total }, (_, i) => ({ done: i < done })),
  });
  assert.strictEqual(keep([t(0,0), t(0,3), t(1,3), t(3,3)], { tasks:'none' }).length, 1);
  assert.strictEqual(keep([t(0,0), t(0,3), t(1,3), t(3,3)], { tasks:'not_started' }).length, 1);
  assert.strictEqual(keep([t(0,0), t(0,3), t(1,3), t(3,3)], { tasks:'part' }).length, 1);
  assert.strictEqual(keep([t(0,0), t(0,3), t(1,3), t(3,3)], { tasks:'complete' }).length, 1);
});

// --- the dropdowns offer what is there --------------------------------------

test('a dropdown only offers values the rows actually hold', () => {
  const rows = [row({ priority:'high' }), row({ priority:'high' }), row({ priority:'low' })]
    .map(rowFacts);
  const entry = ASSET_LIST_FILTERS.find(f => f.col === 'Priority');
  assert.deepStrictEqual(entry.options(rows).map(o => o.id), ['high', 'low'],
    'no duplicates, and nothing offered that would empty the table');
  assert.deepStrictEqual(alPresent(rows, f => f.priority, id => id).map(o => o.id).sort(),
    ['high', 'low']);
});

// --- reset ------------------------------------------------------------------

test('Reset clears every key every filter owns', () => {
  /* Built from the filter table rather than spelled out, so a filter added
     there is cleared without anybody remembering to come back here. */
  const blank = emptyListFilter();
  for (const entry of ASSET_LIST_FILTERS) {
    for (const key of entry.keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(blank, key), `${entry.col} clears ${key}`);
      assert.deepStrictEqual(blank[key], entry.kind === 'multi' ? [] : '');
    }
  }
  assert.strictEqual(alAnySet(blank), false);

  // Everything set, then cleared, is the whole list again.
  const rows = [row({ priority:'high' }), row({ priority:'low' })];
  const set = { ...blank, priority:'high', name:'Asset', statuses:['in_progress'], hoursMin:'1' };
  assert.strictEqual(rows.filter(r => alMatches(rowFacts(r), set)).length, 1);
  assert.strictEqual(rows.filter(r => alMatches(rowFacts(r), emptyListFilter())).length, 2);
});

// --- how it sits on the page ------------------------------------------------

test('the bar is on every sub-tab, and the tab decides which rows it filters', () => {
  const fn = PAGE.slice(PAGE.indexOf('function renderList(){'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  assert.match(body, /const filterBar = \(\(\)=>\{/,
    'the bar is built unconditionally, not for one tab');
  assert.ok(!/state\.listGroup !== 'inactive'\) return ''/.test(body),
    'and no longer returns nothing on the other three');

  /* Within the tab, never instead of it: the rows being narrowed are the ones
     the tab already chose. */
  assert.match(body, /const groupRows = inGroup\(state\.listGroup\);/);
  assert.match(body, /const shownRows = narrow\(groupRows\);/);
  assert.match(body, /const narrow = \(rows\)=>rows\.filter\(r=>alMatches\(rowFacts\(r\), state\.listFilter\)\)/);

  assert.match(body, /id="lfReset"/, 'and there is a reset');
});

test('the filters are kept when the tab changes, and never reach the Board', () => {
  /* Kept: switching tab only writes state.listGroup, so whatever is in
     state.listFilter is still there — the same thing the header's search
     already does on this screen. */
  const fn = PAGE.slice(PAGE.indexOf('function renderList(){'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const tabClick = body.slice(body.indexOf(".sub-tab').forEach"));
  const handler = tabClick.slice(0, tabClick.indexOf('});'));
  assert.match(handler, /state\.listGroup = b\.dataset\.group; renderList\(\);/);
  assert.ok(!handler.includes('listFilter'), 'changing tab does not clear the filters');

  /* And never reach the Board: filteredAssets() is the pool the Board, the
     header search and the pruning of the bulk selection all read. Folding a
     choice made in this table into it would change all three. */
  const pool = PAGE.slice(PAGE.indexOf('function filteredAssets(){'));
  assert.ok(!pool.slice(0, pool.indexOf('\n}')).includes('listFilter'));
});
