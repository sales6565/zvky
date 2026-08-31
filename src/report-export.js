// Turning a report into a file.
//
// The columns are defined once, here, and both writers read them: the
// spreadsheet and the PDF cannot disagree about what "First-pass %" means or
// which order the columns come in, and a test can assert against the same
// definition rather than against a copy of it.
//
// Nothing in this file writes bytes or touches the database. It takes the exact
// payload the Reports tab already draws from and returns plain rows. That
// matters for the promise the download makes: the file says what the screen
// says because it is built from the same object, not from a second query that
// might filter differently.

/* The seven views, in the order the sub-tabs show them, with the head column
 * named the way the screen names it. Keep this in step with REPORT_VIEWS in
 * public/index.html — a test asserts they match, so the two cannot drift. */
const VIEWS = [
  { id: 'byUser', label: 'By User', head: 'Assignee', sheet: 'By User' },
  { id: 'byCategory', label: 'By Category', head: 'Category', sheet: 'By Category' },
  { id: 'byScope', label: 'By Scope of Work', head: 'Scope of Work', sheet: 'By Scope of Work' },
  { id: 'byProject', label: 'By Project', head: 'Project', sheet: 'By Project' },
  { id: 'byClient', label: 'By Client', head: 'Client', sheet: 'By Client' },
  { id: 'trend', label: 'Over Time', head: 'Period', sheet: 'Over Time' },
  { id: 'assets', label: 'Every Asset', head: 'Asset', sheet: 'Every Asset' },
];

const viewById = (id) => VIEWS.find((v) => v.id === id) || VIEWS[0];

/* The Idle Report is its own thing: a different question, a different
 * permission and a different period selector, so it is not one of the seven
 * efficiency views above and does not appear in that workbook. It reuses
 * everything below it — the same column definitions, the same branded PDF,
 * the same filename convention — because a studio should not have to learn two
 * shapes of export. */
const IDLE_VIEW = { id: 'idle', label: 'Idle Report', head: 'Person', sheet: 'Idle' };

function idleRows(report) {
  return (report.rows || []).map((r) => ({
    Person: r.name || '',
    Role: r.roleLabel || r.role || '',
    'Expected hours': r.expectedHours,
    'Tracked hours': r.trackedHours,
    'Idle hours': r.idleHours,
    'Idle hours per day': r.idlePerDay === null || r.idlePerDay === undefined ? '' : r.idlePerDay,
    'Idle %': r.idlePercent === null || r.idlePercent === undefined ? 'N/A' : r.idlePercent,
    'Overtime hours': r.overtimeHours || 0,
    'Assets worked on': r.assetsWorked || 0,
  }));
}

const idleHeaders = () => Object.keys(idleRows({ rows: [{}] })[0]);

/* A percentage that may legitimately not exist.
 *
 * An asset with no tracked time has no efficiency — not zero. Writing 0 into a
 * spreadsheet would be a lie that averages, so the cell says N/A and stays
 * text. The screen does the same thing for the same reason. */
const pct = (v) => (v === null || v === undefined ? 'N/A' : v);
const hrs = (v) => (v === null || v === undefined ? '' : Number(v));

/* The head column of a grouped view carries the outlier flag on screen (a red
   "over budget" chip). In a file there is nowhere to put a chip, so it becomes
   its own column — otherwise the one piece of judgement the report offers would
   be the one thing that does not survive the export. */
function groupRows(groups, { withShared = false } = {}) {
  return groups.map((g) => {
    const row = {
      Label: String(g.label),
      Assets: g.assets,
      'First-pass %': pct(g.firstPass),
      'Total %': pct(g.total),
      'Man Hours': hrs(g.manHours),
      'Tracked hours': hrs(g.trackedHours),
    };
    if (withShared) row['Shared with others'] = g.handedOver || 0;
    row['Over budget'] = g.outlier ? 'yes' : '';
    return row;
  });
}

function assetRows(assets) {
  return assets.map((a) => ({
    Code: a.code || '',
    'Assets Name': a.name || '',
    Assignee: a.assignee || '',
    Category: a.category || '',
    'Scope of Work': a.scope || '',
    Project: a.project || '',
    Client: a.client || '',
    'Man Hours': hrs(a.manHours),
    'First-pass hours': hrs(a.firstPassHours),
    'Total hours': hrs(a.totalHours),
    'First-pass %': pct(a.firstPass),
    'Total %': pct(a.total),
    Rounds: a.rounds,
    Contributors: a.contributors,
  }));
}

/* One view's rows, with its head column named as the screen names it. The head
   column is called "Label" while the rows are built and renamed here, so the
   six grouped views share one row builder instead of six near-copies. */
function rowsFor(report, viewId) {
  const view = viewById(viewId);
  if (view.id === 'assets') return assetRows(report.assets || []);
  const groups = view.id === 'trend' ? (report.trend || []) : ((report[view.id] || {}).groups || []);
  return groupRows(groups, { withShared: view.id === 'byUser' })
    .map(({ Label, ...rest }) => ({ [view.head]: Label, ...rest }));
}

const headersFor = (report, viewId) => {
  const rows = rowsFor(report, viewId);
  if (rows.length) return Object.keys(rows[0]);
  // An empty view still needs headers, or the sheet is a blank rectangle with
  // no clue what it was meant to hold.
  const view = viewById(viewId);
  if (view.id === 'assets') return Object.keys(assetRows([{}])[0]);
  return Object.keys(groupRows([{ label: '', assets: 0 }], { withShared: view.id === 'byUser' })[0])
    .map((h) => (h === 'Label' ? view.head : h));
};

/* What the reader has to know to trust the numbers: which slice of the studio
 * this is. Written out in words rather than as ids, because the file may be
 * read by someone who has never seen the app.
 *
 * `names` supplies the labels the ids stand for — the route has them from the
 * same payload that fills the filter dropdowns, so nothing extra is fetched. */
function describeFilters(filters = {}, names = {}) {
  const find = (list, id, key = 'id', label = 'name') => {
    const hit = (list || []).find((x) => String(x[key]) === String(id));
    return hit ? hit[label] : id;
  };
  const out = [];
  if (filters.from || filters.to) {
    out.push(['Date range', `${filters.from || 'the beginning'} to ${filters.to || 'today'}`]);
  }
  if (filters.clientId) out.push(['Client', find(names.clients, filters.clientId)]);
  if (filters.projectId) out.push(['Project/Game', find(names.projects, filters.projectId)]);
  if (filters.assigneeId) out.push(['User', find(names.users, filters.assigneeId)]);
  if (filters.category) out.push(['Category', find(names.categories, filters.category, 'key', 'label')]);
  if (filters.scope) out.push(['Scope of Work', find(names.scopes, filters.scope, 'key', 'label')]);
  if (!out.length) out.push(['Filters', 'None — every asset visible to you']);
  return out;
}

/* The headline numbers, the same six the screen shows above the table. Their
   own sheet in the spreadsheet, and the block under the title in the PDF. */
function summaryRows(report) {
  const s = report.summary || {};
  return [
    ['Assets reported', s.assets ?? 0],
    ['First-pass efficiency', s.firstPass === null || s.firstPass === undefined ? 'N/A' : `${s.firstPass}%`],
    ['Total efficiency', s.total === null || s.total === undefined ? 'N/A' : `${s.total}%`],
    ['Man Hours estimated', s.manHours ?? 0],
    ['Hours tracked', s.trackedHours ?? 0],
    ['Excluded', s.excluded ?? 0],
  ];
}

/* Why some assets are not in the numbers. On screen this is a row of chips
   under the table; leaving it out of the file would make the totals look wrong
   to anyone who counted the assets themselves. */
function exclusionRows(report) {
  const counts = new Map();
  for (const e of report.excluded || []) {
    counts.set(e.reason, (counts.get(e.reason) || 0) + 1);
  }
  return [...counts.entries()].map(([reason, n]) => [reason, n]);
}

const stamp = (at = new Date()) => at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// A filename someone can find again in their downloads folder.
function fileName(appName, viewId, ext, at = new Date()) {
  const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const parts = [slug(appName) || 'report', 'efficiency'];
  if (viewId) parts.push(slug(viewById(viewId).label));
  parts.push(at.toISOString().slice(0, 10));
  return `${parts.join('-')}.${ext}`;
}

/* The period and the working day, spelled out. An idle figure is meaningless
   without both, and a file that has been emailed on must carry them. */
function idleContext(report) {
  const s = report.schedule || {};
  return [
    ['Period', (report.period || {}).label || ''],
    ['Working days in period', report.workingDays],
    ['Standard working day', `${s.hoursPerDay} hours, ${(s.workingDayNames || []).join(', ')}`],
    ['Expected hours per person', report.expectedHours],
  ];
}

module.exports = {
  VIEWS, viewById, rowsFor, headersFor,
  IDLE_VIEW, idleRows, idleHeaders, idleContext,
  groupRows, assetRows, describeFilters, summaryRows, exclusionRows,
  stamp, fileName,
};
