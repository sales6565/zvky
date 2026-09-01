const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects } = require('../permissions');
const { roleDef, activeRoles } = require('../roles');
const workSchedule = require('../work-schedule');
const workLog = require('../work-log');
const idle = require('../idle');
const exporter = require('../report-export');
const reportPdf = require('../report-pdf');
const branding = require('../branding');
const xlsx = require('xlsx');

router.use(authenticate);

/* Who this report is about.
 *
 * Only roles that can be assigned work. Producers, leads and Super Admins never
 * click Accept and Start on an asset, so every one of them would sit at 100%
 * idle every single day and bury the people the report exists to find. The
 * scope is stated on the screen and in the exports rather than left to be
 * discovered from a surprising absence.
 */
const trackingRoleKeys = () => activeRoles()
  .map((r) => r.key)
  .filter((key) => {
    const def = roleDef(key);
    return Boolean(def && def.assignable);
  });

/* The period, from either a kind + anchor date or an explicit range.
 *
 * The Day/Week/Month/Year buttons send a kind; the report still accepts a plain
 * from/to so an export URL can be kept and re-run. */
function resolvePeriod(query) {
  const kind = ['day', 'week', 'month', 'year'].includes(query.period) ? query.period : null;
  if (kind) {
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(query.on || '')
      ? query.on
      : new Date().toISOString().slice(0, 10);
    const range = idle.periodRange(kind, anchor);
    if (range) return { ...range, kind, on: anchor };
  }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : null;
  if (from && to) return { from, to, label: `${from} to ${to}`, kind: 'range', on: from };
  // Nothing asked for: this week, which is the question somebody opening the
  // tab is most often asking.
  const today = new Date().toISOString().slice(0, 10);
  return { ...idle.periodRange('week', today), kind: 'week', on: today };
}

/* GET /api/idle/report
 *
 * Idle = the working hours in the period during which somebody had nothing in
 * progress. The maths is in src/idle.js, which explains at length why this is
 * no longer "expected hours minus time spent"; this is the query that feeds it.
 *
 * It fetches SPANS rather than a SUM, and that is the whole difference. Summing
 * is what breaks under wall-clock timing: two assets held open through the same
 * afternoon each claim it, and a span left open over a weekend claims the
 * weekend. Only the union of the intervals can answer "was anything on this
 * person's desk at 3pm on Tuesday", and only that question has a right answer.
 *
 * The coverage is deliberately WHOLE-PERSON even when the report is filtered. A
 * project filter decides who is listed — the people who worked on that project
 * in the period — and never shrinks anybody's coverage, because somebody who
 * spent a full day on another project is not idle, and printing them at 100%
 * idle here would be a confident wrong answer.
 */
/* Built once, read three ways: the screen, the spreadsheet and the PDF. Same
   reason the efficiency report has a buildReport() — a download that filtered
   differently from the screen it was taken from would be worse than none. */
async function buildIdleReport(req) {
  const projects = await visibleProjects(req.user);
  const projectIds = projects.map((p) => p.id);
  const period = resolvePeriod(req.query);
  const schedule = workSchedule.current();
  const workingDays = idle.workingDaysBetween(period.from, period.to, schedule.workingDays);
  const cutover = await workLog.cutover(db).catch(() => ({ at: null, legacyRows: 0, mixed: false }));

  const roles = trackingRoleKeys();
  const empty = {
    period, schedule, workingDays,
    expectedHours: idle.round(workingDays * schedule.hoursPerDay),
    rows: [], totals: null,
    caveats: idle.caveats(schedule),
    cutover,
    scope: { roles: roles.length, projects: projects.length },
    filters: { projects: [], clients: [], categories: [], scopes: [], users: [] },
  };
  if (!projectIds.length || !roles.length) return empty;

  const from = `${period.from} 00:00:00`;
  const to = `${period.to} 23:59:59`;

  /* Which people the filters narrow the list to.
   *
   * Built as a set of user ids from the assets matching the filter, rather than
   * folded into the totals query — that separation is what keeps "who is
   * listed" and "how much did they work" from contaminating each other. */
  const narrow = [];
  const narrowParams = [];
  const addNarrow = (clause, value) => {
    narrowParams.push(value);
    narrow.push(clause.replace('?', `$${narrowParams.length}`));
  };
  if (req.query.projectId) addNarrow('a.project_id = ?', req.query.projectId);
  if (req.query.clientId) addNarrow('p.client_id = ?', req.query.clientId);
  if (req.query.category) addNarrow('a.category = ?', req.query.category);
  if (req.query.scope) addNarrow('a.`type` = ?', req.query.scope);

  /* A user filter is different in kind from the others and is applied directly.
     Narrowing by project asks "who worked on this", which is a question about
     assets; narrowing by person just picks a row, and needs no trip through
     work_sessions to answer. */
  const onlyUserId = /^[0-9a-fA-F-]{36}$/.test(req.query.assigneeId || '') ? req.query.assigneeId : null;

  let onlyUsers = null;
  if (narrow.length) {
    const { rows } = await db.query(
      `SELECT DISTINCT w.user_id AS id
         FROM work_sessions w
         JOIN assets a ON a.id = w.asset_id
         JOIN projects p ON p.id = a.project_id
        WHERE a.project_id IN ($${narrowParams.length + 1})
          AND w.started_at <= $${narrowParams.length + 2}
          AND COALESCE(w.ended_at, NOW()) >= $${narrowParams.length + 3}
          AND ${narrow.join(' AND ')}`,
      [...narrowParams, projectIds, to, from]
    );
    onlyUsers = rows.map((r) => r.id).filter(Boolean);
    if (!onlyUsers.length) return { ...empty, narrowed: true };
  }
  if (onlyUserId) {
    onlyUsers = onlyUsers ? onlyUsers.filter((x) => x === onlyUserId) : [onlyUserId];
    if (!onlyUsers.length) return { ...empty, narrowed: true };
  }

  /* Every stretch overlapping the window, per person — the rows themselves, not
   * a total. src/idle.js takes the union and clips it; doing that here in SQL
   * would need a window function this app cannot rely on across MySQL 8 and
   * MariaDB, and the result would be far harder to check by hand than the
   * arithmetic it replaced.
   *
   * The stamps come back as strings in UTC rather than as driver Dates, so the
   * day boundaries the maths draws are the same boundaries the period names.
   * Letting the driver hand back a local-time Date would put the whole report
   * an hour out of step with its own date range wherever the server is not on
   * UTC — a silent error that only shows up in the numbers.
   *
   * An open stretch is measured to now rather than treated as zero: work in
   * progress this morning is not idleness. */
  const params = [projectIds, to, from];
  let where = `a.project_id IN ($1)
      AND w.started_at <= $2
      AND COALESCE(w.ended_at, NOW()) >= $3`;
  if (onlyUsers) { params.push(onlyUsers); where += ` AND w.user_id IN ($${params.length})`; }

  const { rows: sessions } = await db.query(
    `SELECT w.user_id AS id, w.asset_id AS assetId,
            DATE_FORMAT(w.started_at, '%Y-%m-%dT%H:%i:%sZ') AS startedAt,
            DATE_FORMAT(COALESCE(w.ended_at, NOW()), '%Y-%m-%dT%H:%i:%sZ') AS endedAt
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE ${where}`,
    params
  );
  const spansBy = new Map();
  const assetsBy = new Map();
  for (const row of sessions) {
    if (!row.id) continue;
    if (!spansBy.has(row.id)) { spansBy.set(row.id, []); assetsBy.set(row.id, new Set()); }
    spansBy.get(row.id).push([Date.parse(row.startedAt), Date.parse(row.endedAt)]);
    assetsBy.get(row.id).add(row.assetId);
  }

  // Everyone in scope, whether or not they tracked anything — the person with
  // nothing assigned is exactly who a capacity report should surface.
  const peopleParams = [roles];
  let peopleWhere = 'u.`role` IN ($1)';
  if (onlyUsers) { peopleParams.push(onlyUsers); peopleWhere += ` AND u.id IN ($${peopleParams.length})`; }
  const { rows: people } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, u.\`role\`, u.avatar_updated_at AS \`photoUpdatedAt\`
       FROM users u WHERE ${peopleWhere} ORDER BY u.\`name\``,
    peopleParams
  );

  const rows = people.map((u) => {
    const numbers = idle.forUser({
      spans: spansBy.get(u.id) || [],
      from: period.from,
      to: period.to,
      workingDays: schedule.workingDays,
      hoursPerDay: schedule.hoursPerDay,
    });
    return {
      id: u.id, name: u.name, email: u.email,
      role: u.role, roleLabel: (roleDef(u.role) || {}).label || u.role,
      photoUpdatedAt: u.photoUpdatedAt,
      assetsWorked: (assetsBy.get(u.id) || new Set()).size,
      ...numbers,
    };
  }).sort((a, b) => b.idleHours - a.idleHours);

  const sum = (key) => idle.round(rows.reduce((t, r) => t + Number(r[key] || 0), 0));
  const totals = rows.length ? {
    people: rows.length,
    expectedHours: sum('expectedHours'),
    engagedHours: sum('engagedHours'),
    idleHours: sum('idleHours'),
    restDaysCovered: rows.reduce((t, r) => t + Number(r.restDaysCovered || 0), 0),
    idlePercent: sum('expectedHours') > 0
      ? idle.round((sum('idleHours') / sum('expectedHours')) * 100) : null,
  } : null;

  return {
    period, schedule, workingDays,
    expectedHours: idle.round(workingDays * schedule.hoursPerDay),
    rows, totals,
    caveats: idle.caveats(schedule),
    cutover,
    narrowed: Boolean(onlyUsers),
    scope: { roles: roles.length, projects: projects.length },
  };
}

router.get('/report', requirePermission('report.idle'), async (req, res) => {
  res.json(await buildIdleReport(req));
});

/* GET /api/idle/now — who has nothing in progress, right now.
 *
 * "Currently idle" means no open work session: nothing accepted and not yet
 * submitted. That is the same definition the Idle Report measures over a
 * period, seen at one instant, which is what makes the two agree.
 *
 * It is not the same as "not working", and the screen says so. Somebody
 * counted as working may have gone home with an asset still open; somebody
 * counted as idle may be deep in something this app never sees. What this list
 * is good for is the actionable half — who has nothing open, and what is
 * sitting with them unstarted.
 *
 * There is no stale-session flag any more. It used to warn about a timer left
 * running overnight; with the running timer gone, a stretch open for three days
 * is what work left on a desk over a weekend looks like, and flagging the
 * ordinary case would only teach people to ignore the flag.
 */
router.get('/now', requirePermission('user.idle_view'), async (req, res) => {
  const projects = await visibleProjects(req.user);
  const projectIds = projects.map((p) => p.id);
  const roles = trackingRoleKeys();
  const now = new Date();

  if (!roles.length) {
    return res.json({ at: now.toISOString(), idle: [], working: [], scope: { projects: 0 } });
  }

  const { rows: people } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, u.\`role\`, u.avatar_updated_at AS \`photoUpdatedAt\`
       FROM users u WHERE u.\`role\` IN ($1) ORDER BY u.\`name\``,
    [roles]
  );
  if (!people.length || !projectIds.length) {
    return res.json({ at: now.toISOString(), idle: [], working: [], scope: { projects: projects.length } });
  }
  const ids = people.map((u) => u.id);

  // Open stretches: started and not yet handed in. The definition of "has
  // something in progress right now".
  const { rows: open } = await db.query(
    `SELECT w.user_id AS id, w.started_at, a.id AS assetId, a.\`code\`, a.\`name\`
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.ended_at IS NULL AND w.user_id IN ($1) AND a.project_id IN ($2)`,
    [ids, projectIds]
  );
  /* All of them, not one.
   *
   * This kept a single row per person, so somebody holding three assets open
   * had two of them silently dropped and the screen named whichever the
   * database happened to return last. That was a small inaccuracy while a
   * running timer made holding several at once unusual; with wall-clock
   * timestamps it is the ordinary case, and "what is Omar on" answered with one
   * arbitrary asset out of three is worse than not answering. */
  const openBy = new Map();
  for (const r of open) {
    if (!openBy.has(r.id)) openBy.set(r.id, []);
    openBy.get(r.id).push(r);
  }

  // When each person last had something in progress, so "idle" can carry a
  // length rather than being a bare yes.
  const { rows: last } = await db.query(
    `SELECT w.user_id AS id, MAX(COALESCE(w.ended_at, w.started_at)) AS at
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.user_id IN ($1) AND a.project_id IN ($2)
      GROUP BY w.user_id`,
    [ids, projectIds]
  );
  const lastBy = new Map(last.map((r) => [r.id, r.at]));

  /* What is sitting with them and has not been started. The actionable half:
     "idle" on its own tells a manager nothing about whether there is anything
     for that person to do. */
  const { rows: waiting } = await db.query(
    `SELECT a.assignee_id AS id, a.id AS assetId, a.\`code\`, a.\`name\`, a.\`status\`, a.man_hours AS manHours
       FROM assets a
      WHERE a.assignee_id IN ($1) AND a.project_id IN ($2)
        AND a.\`status\` NOT IN ('delivered', 'approved_for_client')
      ORDER BY a.\`code\``,
    [ids, projectIds]
  );
  const waitingBy = new Map();
  for (const w of waiting) {
    if (!waitingBy.has(w.id)) waitingBy.set(w.id, []);
    waitingBy.get(w.id).push({ assetId: w.assetId, code: w.code, name: w.name, status: w.status, manHours: w.manHours });
  }

  const idleList = [];
  const working = [];

  for (const u of people) {
    const open = openBy.get(u.id);
    const person = {
      id: u.id, name: u.name, email: u.email, role: u.role, photoUpdatedAt: u.photoUpdatedAt,
      waiting: waitingBy.get(u.id) || [],
    };
    if (open && open.length) {
      // Oldest first, and the headline figure is the oldest — "open for" should
      // be how long the longest-standing one has been sitting there.
      const sorted = [...open].sort((x, y) => new Date(x.started_at) - new Date(y.started_at));
      working.push({
        ...person,
        assets: sorted.map((r) => ({
          assetId: r.assetId, code: r.code, name: r.name, startedAt: r.started_at,
        })),
        startedAt: sorted[0].started_at,
        openForSeconds: idle.idleFor(sorted[0].started_at, now),
      });
      continue;
    }
    const lastAt = lastBy.get(u.id) || null;
    idleList.push({
      ...person,
      lastActiveAt: lastAt,
      idleForSeconds: idle.idleFor(lastAt, now),
      neverStarted: !lastAt,
    });
  }

  /* Longest idle first, and anyone who has never started anything at the very
     top — they are the least visible and the most likely to need a word. */
  idleList.sort((a, b) => {
    if (a.neverStarted !== b.neverStarted) return a.neverStarted ? -1 : 1;
    return (b.idleForSeconds || 0) - (a.idleForSeconds || 0);
  });

  res.json({
    at: now.toISOString(),
    idle: idleList,
    working,
    scope: { people: people.length, projects: projects.length },
  });
});

/* The same two downloads the efficiency report offers, on the same data the
 * Idle screen is showing, through the same writers — so a studio does not have
 * to learn two shapes of export.
 *
 * Its own endpoints rather than an extra sheet in the efficiency workbook:
 * this report has its own permission and its own period selector, and folding
 * a week-of-March idle sheet into a workbook filtered to a different date range
 * would produce one file whose sheets disagreed about what period they covered.
 */
function idleFileContext(report, req) {
  const context = exporter.idleContext(report);
  const applied = [];
  if (req.query.projectId) applied.push(['Project/Game', req.query.projectId]);
  if (req.query.clientId) applied.push(['Client', req.query.clientId]);
  if (req.query.category) applied.push(['Category', req.query.category]);
  if (req.query.scope) applied.push(['Scope of Work', req.query.scope]);
  if (applied.length) {
    applied.push(['Note', 'Filters choose who is listed. Hours are always whole-person.']);
  }
  /* Where the meaning of the underlying data changes. Rows recorded before the
     running timer was removed hold active worked time; rows after it hold the
     elapsed span from Accept and Start to Submit for Review. A report covering
     both is comparing hours to hours that are not the same hours, and it says
     so rather than letting somebody read a trend out of the switch. */
  if (report.cutover && report.cutover.mixed && report.cutover.date) {
    applied.push(['Note', 'Work recorded before '
      + `${report.cutover.date} was measured as active worked time, with pauses. `
      + 'Work after it is the elapsed span from Accept and Start to Submit for Review. '
      + 'Periods spanning that date mix the two.']);
  }
  return [...context, ...applied];
}

router.get('/report.xlsx', requirePermission('report.idle'), async (req, res) => {
  const report = await buildIdleReport(req);
  const book = xlsx.utils.book_new();

  const summary = [
    [branding.current().appName],
    ['Idle report'],
    [],
    ...idleFileContext(report, req),
    [],
    ['Generated', exporter.stamp()],
    [],
    ['Totals'],
    ...(report.totals ? [
      ['People', report.totals.people],
      ['Expected hours', report.totals.expectedHours],
      ['Hours with work in progress', report.totals.engagedHours],
      ['Idle hours', report.totals.idleHours],
      ['Idle %', report.totals.idlePercent === null ? 'N/A' : `${report.totals.idlePercent}%`],
      ['Rest days with work open', report.totals.restDaysCovered],
    ] : [['(nobody in scope)', '']]),
    [],
    ['What this does not account for'],
    ...report.caveats.map((c) => [c]),
  ];
  const summarySheet = xlsx.utils.aoa_to_sheet(summary);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 60 }];
  xlsx.utils.book_append_sheet(book, summarySheet, 'Summary');

  const rows = exporter.idleRows(report);
  const headers = exporter.idleHeaders();
  const sheet = xlsx.utils.json_to_sheet(rows, { header: headers });
  sheet['!cols'] = headers.map((h, i) => ({ wch: i === 0 ? 26 : Math.max(12, h.length + 2) }));
  xlsx.utils.book_append_sheet(book, sheet, exporter.IDLE_VIEW.sheet);

  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${idleFileName(branding.current().appName, 'xlsx')}"`);
  console.log(`${req.user.email} downloaded the idle report as a spreadsheet.`);
  res.send(buffer);
});

/* One writer, two doors: /api/idle/report.pdf and the Reports tab's own PDF
   button at /api/reports/efficiency.pdf?view=idle. Sharing it is the point —
   two renderers would drift into producing two different documents. */
async function writeIdlePdf(req, res) {
  const report = await buildIdleReport(req);
  const logo = await branding.readLogo(db).catch(() => null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${idleFileName(branding.current().appName, 'pdf')}"`);
  console.log(`${req.user.email} downloaded the idle report as a PDF.`);
  reportPdf.write(res, {
    appName: branding.current().appName,
    tagline: branding.current().tagline,
    logo,
    view: exporter.IDLE_VIEW,
    title: 'Idle report',
    footer: 'idle report',
    headers: exporter.idleHeaders(),
    rows: exporter.idleRows(report),
    filters: idleFileContext(report, req),
    summary: report.totals ? [
      ['People', report.totals.people],
      ['Expected', `${report.totals.expectedHours}h`],
      ['In progress', `${report.totals.engagedHours}h`],
      ['Idle', `${report.totals.idleHours}h`],
      ['Idle %', report.totals.idlePercent === null ? 'N/A' : `${report.totals.idlePercent}%`],
      ['Rest days open', report.totals.restDaysCovered],
    ] : [['People', 0]],
    excluded: report.caveats.map((c) => [c, '']),
    excludedTitle: 'What this does not account for',
    blurb: 'The working hours in the period during which somebody had nothing in progress — '
      + 'nothing accepted and not yet submitted. Work open across two assets at once counts '
      + 'once, and a day counts at most one standard day however long work was left open.',
  });
}

router.get('/report.pdf', requirePermission('report.idle'), (req, res) => writeIdlePdf(req, res));

const idleFileName = (appName, ext) => exporter.fileName(appName, null, ext).replace('-efficiency-', '-idle-');

/* Exported so the Reports exports can put an Idle sheet in the same workbook.
   The same builder, so the sheet cannot disagree with the Idle screen. */
module.exports = router;
module.exports.buildIdleReport = buildIdleReport;
module.exports.idleFileContext = idleFileContext;
module.exports.writeIdlePdf = writeIdlePdf;
