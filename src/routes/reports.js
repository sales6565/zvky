const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects } = require('../permissions');
const referenceData = require('../reference-data');
const reports = require('../reports');
const exporter = require('../report-export');
const reportPdf = require('../report-pdf');
const branding = require('../branding');
const xlsx = require('xlsx');
const { holds } = require('../permissions');
const idleRoutes = require('./idle');
const workLog = require('../work-log');

router.use(authenticate);

/* GET /api/reports/efficiency
 *
 * Estimated Man Hours against tracked Time Spent, per asset, rolled up every
 * way the Reports tab offers. The maths is in src/reports.js; this is the query
 * that feeds it and the filters that narrow it.
 *
 * Scoped, like everything else: a report never reaches a project the reader
 * cannot already open. Holding "View Reports" says what you may look at, never
 * how much of the studio you may look at — same rule the rest of the
 * permissions follow.
 */
/* One report, built once.
 *
 * The screen, the spreadsheet and the PDF all call this. That is the whole
 * reason it is a function: a download that says something different from the
 * screen it was taken from is worse than no download, and the only way to be
 * sure they agree is for there to be one query and one set of filters rather
 * than a copy per format.
 */
async function buildReport(req) {
  const projects = await visibleProjects(req.user);
  if (!projects.length) {
    return {
      ...reports.build([]),
      filters: { projects: [], clients: [], users: [], categories: [], scopes: [] },
      scope: { projects: 0 },
    };
  }
  const projectIds = projects.map((p) => p.id);

  const where = ['a.project_id IN ($1)'];
  const params = [projectIds];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (req.query.projectId) add('a.project_id = ?', req.query.projectId);
  if (req.query.clientId) add('p.client_id = ?', req.query.clientId);
  if (req.query.assigneeId) add('a.assignee_id = ?', req.query.assigneeId);
  if (req.query.category) add('a.category = ?', req.query.category);
  if (req.query.scope) add('a.`type` = ?', req.query.scope);

  /* The date range applies to when the work FINISHED, not when the asset was
     created — "how did we do in October" is a question about work that landed
     in October. An asset created in September and delivered in October belongs
     to October. */
  /* When the work landed. Delivery if it got there — assets carry no
     delivered_at column, so that date comes from the deliver event — otherwise
     the last submission, which is the bar for being in this report at all. */
  const finishedAt = `COALESCE(
      (SELECT MAX(e.created_at) FROM asset_events e WHERE e.asset_id = a.id AND e.action = 'deliver'),
      (SELECT MAX(v.created_at) FROM asset_versions v WHERE v.asset_id = a.id))`;
  if (req.query.from) add(`${finishedAt} >= ?`, `${req.query.from} 00:00:00`);
  if (req.query.to) add(`${finishedAt} <= ?`, `${req.query.to} 23:59:59`);

  /* One row per asset.
   *
   * The two time numbers come from work_sessions, which records one row per
   * stretch of work with the round it belonged to. `round` is set at start to
   * (submissions so far + 1), so round 1 is everything done before the first
   * submission — the first pass, without having to guess from timestamps.
   *
   * `contributors` counts the people who have held the asset, so a By User row
   * can say how much of its work was somebody else's. */
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.\`name\`, a.\`type\`, a.category, a.man_hours AS manHours,
            a.status, a.assignee_id AS assigneeId, u.\`name\` AS assigneeName,
            a.project_id AS projectId, p.\`name\` AS projectName,
            p.client_id AS clientId, c.\`name\` AS clientName,
            ${finishedAt} AS finishedAt,
            (a.status = 'delivered') AS delivered,
            (SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id) AS rounds,
            (SELECT COUNT(DISTINCT x.user_id) FROM asset_assignments x WHERE x.asset_id = a.id) AS contributors,
            /* Did a team lead take the Creative Director out of the loop?
             *
             * Read from the event rather than from the status, because status
             * cannot answer it: both routes to Approved for Client end in the
             * same state, which is exactly why the action was made distinct
             * when Send to Client was built. EXISTS rather than a count — a
             * skip can only happen once per asset, since it is only reachable
             * from TL Review and there is no way back into that queue. */
            EXISTS(SELECT 1 FROM asset_events e
                    WHERE e.asset_id = a.id AND e.action = 'tl_send_to_client') AS skippedCd,
            COALESCE((SELECT SUM(COALESCE(w.seconds, 0)) FROM work_sessions w
                       WHERE w.asset_id = a.id), 0) AS totalSeconds,
            COALESCE((SELECT SUM(COALESCE(w.seconds, 0)) FROM work_sessions w
                       WHERE w.asset_id = a.id AND w.round = 1), 0) AS firstPassSeconds
       FROM assets a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = a.assignee_id
      WHERE ${where.join(' AND ')}`,
    params
  );
  /* Deliberately NOT caught.
     
     This used to swallow a missing table into an empty report, on the reasoning
     that a deployment without the timer tables has no time data to show. It
     does not: a report that says "0 assets, no efficiency" when the truth is
     "this database is missing asset_assignments" is a wrong answer delivered
     confidently, which is worse than the error. A schema fault belongs in the
     error handler, which names the missing piece and points at /api/health. */

  /* Labels, so the report reads in the studio's own words rather than in keys.
   *
   * The reference lists are mirrored in memory and reloaded when THIS process
   * writes to them. A value added by another process — a second Node worker
   * under Passenger, or a script run on the host — is therefore invisible here
   * until a restart, and the report printed "table_game" where it should have
   * said "Table Game". So: if a key turns up that the mirror cannot name, ask
   * the database once and try again. Once, not per row.
   */
  const labelFrom = (collection) => {
    const list = referenceData.list(collection, { includeInactive: true });
    return new Map(list.map((e) => [e.key, e.label]));
  };
  let categories = labelFrom('categories');
  let scopes = labelFrom('asset_types');
  const unnamed = rows.some((r) => (r.category && !categories.has(r.category))
    || (r.type && !scopes.has(r.type)));
  if (unnamed) {
    await referenceData.refresh(db).catch(() => {});
    categories = labelFrom('categories');
    scopes = labelFrom('asset_types');
  }

  const prepared = rows.map((r) => ({
    ...r,
    // An asset is in the report once it has been submitted at least once —
    // before that there is nothing to have been efficient about.
    submitted: Number(r.rounds) > 0,
    categoryLabel: categories.get(r.category) || r.category,
    typeLabel: scopes.get(r.type) || r.type,
  }));

  const grain = req.query.grain === 'month' ? 'month' : 'week';
  const report = reports.build(prepared, { grain });

  /* What the filter dropdowns offer: drawn from the reader's own scope, so
     they cannot pick a project the report would then refuse to show. */
  const { rows: people } = await db.query(
    `SELECT DISTINCT u.id, u.\`name\` FROM users u
       JOIN assets a ON a.assignee_id = u.id
      WHERE a.project_id IN ($1) ORDER BY u.\`name\``,
    [projectIds]
  );
  const clients = [];
  const seenClient = new Set();
  for (const p of projects) {
    if (p.client_id && !seenClient.has(p.client_id)) seenClient.add(p.client_id);
  }
  if (seenClient.size) {
    const { rows: clientRows } = await db.query(
      'SELECT id, `name` FROM clients WHERE id IN ($1) ORDER BY `name`', [[...seenClient]]
    );
    clients.push(...clientRows);
  }

  return {
    ...report,
    /* Where the meaning of Time Spent changes, so the screen and the exports can
       say so. A period covering the switch mixes active worked time with
       elapsed time; without this the jump reads as a change in the studio. */
    cutover: await workLog.cutover(db).catch(() => ({ at: null, legacyRows: 0, mixed: false })),
    filters: {
      projects: projects.map((p) => ({ id: p.id, name: p.name, clientId: p.client_id })),
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      users: people.map((u) => ({ id: u.id, name: u.name })),
      categories: referenceData.list('categories').map((c) => ({ key: c.key, label: c.label })),
      scopes: referenceData.list('asset_types').map((t) => ({ key: t.key, label: t.label })),
    },
    scope: { projects: projects.length },
  };
}

router.get('/efficiency', requirePermission('report.view'), async (req, res) => {
  res.json(await buildReport(req));
});

/* The filters as the caller sent them, so the file can print them back. Read
   from the query string rather than passed around, so a filter added to the
   report later cannot be silently missing from the export's header. */
const filtersFrom = (req) => ({
  from: req.query.from || '', to: req.query.to || '',
  clientId: req.query.clientId || '', projectId: req.query.projectId || '',
  assigneeId: req.query.assigneeId || '', category: req.query.category || '',
  scope: req.query.scope || '',
});

/* GET /api/reports/efficiency.xlsx — every view, one sheet each.
 *
 * All seven breakdowns come out of a single query already, so a workbook
 * holding all of them costs nothing more than one holding the open tab, and
 * one download is then the whole filtered report. The Summary sheet leads with
 * the filters, so a file that has been emailed on still says what it is a
 * report OF. */
router.get('/efficiency.xlsx', requirePermission('report.view'), async (req, res) => {
  const report = await buildReport(req);
  const book = xlsx.utils.book_new();

  const filters = [
    ...exporter.describeFilters(filtersFrom(req), report.filters),
    ...exporter.timeBasis(report.cutover),
    ...exporter.skipBasis(report.summary),
  ];
  const summary = [
    [branding.current().appName],
    ['Work efficiency report'],
    [],
    ...filters,
    [],
    ['Generated', exporter.stamp()],
    [],
    ...exporter.summaryRows(report),
  ];
  const excluded = exporter.exclusionRows(report);
  if (excluded.length) summary.push([], ['Left out of the numbers'], ...excluded);
  const summarySheet = xlsx.utils.aoa_to_sheet(summary);
  summarySheet['!cols'] = [{ wch: 26 }, { wch: 42 }];
  xlsx.utils.book_append_sheet(book, summarySheet, 'Summary');

  for (const view of exporter.VIEWS) {
    const rows = exporter.rowsFor(report, view.id);
    const headers = exporter.headersFor(report, view.id);
    const sheet = xlsx.utils.json_to_sheet(rows, { header: headers });
    sheet['!cols'] = headers.map((h, i) => ({ wch: i === 0 ? 30 : Math.max(12, h.length + 2) }));
    /* Sheet names are capped at 31 characters by the format and cannot contain
       []:*?/\ — every name here is already safe, but the cap is enforced so a
       renamed view can never produce a file Excel refuses to open. */
    xlsx.utils.book_append_sheet(book, sheet, view.sheet.slice(0, 31));
  }

  /* The Idle Report, in the same workbook — but only for a reader who holds
   * View Idle Report. The two permissions are independent, so somebody trusted
   * with efficiency and not with idle must not receive an idle sheet as a side
   * effect of pressing the same button.
   *
   * The period is the honest problem here. The efficiency sheets filter on a
   * free from/to and default to every asset ever; idle has to measure against
   * a defined stretch of time or there is nothing to be idle relative to. When
   * a date range is set they agree exactly, because the idle builder reads the
   * same from/to. When one is NOT set they cannot agree, so the Summary says
   * which period the Idle sheet covers and that it differs — a workbook whose
   * sheets quietly measured different spans would be worse than no sheet. */
  if (holds(req.user, 'report.idle')) {
    const idleReport = await idleRoutes.buildIdleReport(req);
    const dated = Boolean(req.query.from && req.query.to);
    const notes = [
      [],
      ['Idle sheet'],
      ['Period covered', idleReport.period.label],
      ['Working days in period', idleReport.workingDays],
      ['Standard working day',
        `${idleReport.schedule.hoursPerDay} hours, ${idleReport.schedule.workingDayNames.join(', ')}`],
    ];
    if (!dated) {
      notes.push(['Note', 'The efficiency sheets above cover every asset matching the filters, with no '
        + `date limit. Idle has to be measured against a period, so that sheet covers ${idleReport.period.label}. `
        + 'Set a date range to make them cover the same span.']);
    }
    notes.push(...idleReport.caveats.map((c) => ['', c]));
    xlsx.utils.sheet_add_aoa(summarySheet, notes, { origin: -1 });

    const idleSheetRows = exporter.idleRows(idleReport);
    const idleHeaders = exporter.idleHeaders();
    const idleSheet = xlsx.utils.json_to_sheet(idleSheetRows, { header: idleHeaders });
    idleSheet['!cols'] = idleHeaders.map((h, i) => ({ wch: i === 0 ? 26 : Math.max(12, h.length + 2) }));
    xlsx.utils.book_append_sheet(book, idleSheet, exporter.IDLE_VIEW.sheet);
  }

  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, null, 'xlsx')}"`);
  console.log(`${req.user.email} downloaded the efficiency report as a spreadsheet`
    + `${holds(req.user, 'report.idle') ? ', with the idle sheet' : ''}.`);
  res.send(buffer);
});

/* GET /api/reports/efficiency.pdf — the view that is open, as a document.
 *
 * Deliberately one view, where the spreadsheet is all seven: a PDF is
 * something a person reads and forwards, and seven tables stapled together is
 * a worse document than the one table they meant to send. The spreadsheet is
 * where the whole dataset lives. */
router.get('/efficiency.pdf', requirePermission('report.view'), async (req, res) => {
  /* The Idle Report is one of the views this endpoint can render, so the
     Reports tab's PDF button covers it too. Its own permission still applies —
     holding View Reports does not hand somebody the idle numbers. A reader who
     has idle and NOT efficiency uses /api/idle/report.pdf, which this route
     cannot serve them because it is gated on report.view. */
  if (req.query.view === 'idle') {
    if (!holds(req.user, 'report.idle')) {
      return res.status(403).json({ error: 'You do not have permission to view the Idle Report.' });
    }
    return idleRoutes.writeIdlePdf(req, res);
  }
  const report = await buildReport(req);
  const view = exporter.viewById(req.query.view);
  const rows = exporter.rowsFor(report, view.id);
  const headers = exporter.headersFor(report, view.id);
  const filters = [
    ...exporter.describeFilters(filtersFrom(req), report.filters),
    ...exporter.timeBasis(report.cutover),
    ...exporter.skipBasis(report.summary),
  ];
  const logo = await branding.readLogo(db).catch(() => null);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, view.id, 'pdf')}"`);
  console.log(`${req.user.email} downloaded the "${view.label}" efficiency report as a PDF.`);
  reportPdf.write(res, {
    appName: branding.current().appName,
    tagline: branding.current().tagline,
    logo,
    view, headers, rows, filters,
    summary: exporter.summaryRows(report),
    excluded: exporter.exclusionRows(report),
  });
});

module.exports = router;
