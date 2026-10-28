/* THE ARTIST REPORT: every resource's submitted work, one row per asset and
 * person.
 *
 * ===========================================================================
 * WHERE EACH COLUMN COMES FROM, and the two places the brief guessed wrong.
 *
 *   Client Name    the project's client, blank when it has none.
 *   Project Name   the project.
 *   Department     THERE IS NO DEPARTMENT FIELD. `users` has no department and
 *                  no team that means one — role groups are bundles of
 *                  permissions, not org units, and `discipline` is free text on
 *                  FREELANCERS. So this is the ASSET's discipline, from the
 *                  shared assetDiscipline() the Dashboard's Art / Animation
 *                  sub-tabs use. It is therefore a property of the work, not of
 *                  the person: the same resource appears with "Art" on one row
 *                  and "Animation" on the next, which is the honest reading of
 *                  a studio where one artist does both.
 *   Assets Name    the asset.
 *   Resource Name  the submitter's display name, inactive accounts included —
 *                  somebody who left in March still submitted the work in
 *                  March, and a report that hid it would under-report the
 *                  month.
 *   Submit Date    asset_versions. One row per submission, carrying
 *                  `uploaded_by` and `created_at`, which is exactly "this
 *                  person submitted this asset then". asset_events also records
 *                  it (action='submit', actor_id) and the two are written in
 *                  the same transaction; the versions table is used because it
 *                  IS the submission rather than a trace of it, and because
 *                  it is what the asset drawer lists. A test holds the two
 *                  equal so a future divergence is caught rather than guessed
 *                  at.
 *   Bid Hours      assets.man_hours — the estimate the Efficiency report
 *                  already calls Man Hours.
 *   Spent Hours    work_sessions, through the expressions src/work-log.js
 *                  exports, which is the application's single definition of
 *                  recorded time. Leave-aware WITHOUT anything here doing the
 *                  excluding: close() stores working seconds already computed
 *                  by day-status.countedSeconds (leave windows removed), and
 *                  the live tail of a still-open session gets the same
 *                  treatment through liveSeconds(). There is no
 *                  countedIntervals() in this codebase; countedSeconds is the
 *                  helper the brief meant.
 *   Efficiency     Bid ÷ hours of EVERYONE on the asset × 100, one decimal,
 *                  through src/reports.js efficiencyOf() — the rule the
 *                  Efficiency report has always used, not a second one.
 *
 * ONE ROW PER ASSET × RESOURCE, selected by the resource's LATEST submission on
 * that asset. A rejected round and its resubmission are one row, dated the
 * resubmission; two people who both submitted the same asset are two rows,
 * dated separately.
 *
 * THE RANGE SELECTS ROWS; IT DOES NOT CLIP HOURS. Spent Hours is everything
 * that resource ever recorded on the asset, because Bid Hours is the whole
 * asset's estimate and halving one side of a comparison is worse than
 * reporting both whole. Said on screen, so nobody has to infer it.
 *
 * A FIXED NUMBER OF QUERIES. Four, whatever the row count: the visible
 * projects, the rows (paged in the database), the recorded time grouped by
 * asset and person over just those assets, and the live-leave index. The
 * outsourced count comes from the same rows query.
 */
const { visibleProjects } = require('./permissions');
const workLog = require('./work-log');
const reports = require('./reports');
const { assetDiscipline, disciplineLabel, disciplineWhere } = require('./asset-discipline');

const PAGE_SIZE = 100;
const DOWNLOAD_LIMIT = 50000;

/* EFFICIENCY, AND WHY IT IS THE ASSET'S RATHER THAN THE PERSON'S.
 *
 * Bid Hours belongs to the asset. If two people worked it, neither of them was
 * bid for separately, so dividing the whole bid by one person's hours would
 * flatter whoever did least. The asset-level figure — the bid against what the
 * asset actually cost in total — is the only one the data supports, and every
 * row of a multi-resource asset therefore shows the same number. The screen
 * says so.
 *
 * BLANK, NOT ZERO, when it cannot be given: no estimate, or no recorded time.
 * reports.efficiencyOf() already returns null for exactly those two cases and
 * has since the Efficiency report was built — this rounds its answer and
 * nothing more, so the two reports can never disagree about what 85.5 means.
 */
function assetEfficiency(asset) {
  const value = reports.efficiencyOf(asset && asset.bidHours, asset && asset.assetSeconds);
  if (value === null) return null;
  return Math.round(value * 10) / 10;
}

const HOUR = reports.HOUR;
const hours = (seconds) => Math.round(((Number(seconds) || 0) / HOUR) * 100) / 100;

/* The month we are in, as the default range. Local dates, because the database
   compares the range against local DATETIMEs. */
function defaultRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* What the caller asked for, cleaned. Anything unparseable falls back to the
   default rather than to an error: a report that refuses to draw because a
   query string was hand-edited is less useful than one that draws this month. */
function filtersFrom(query = {}, now = new Date()) {
  const range = defaultRange(now);
  const from = DATE.test(String(query.from || '')) ? String(query.from) : range.from;
  const to = DATE.test(String(query.to || '')) ? String(query.to) : range.to;
  /* A multi-select arrives as a repeated parameter or a comma-separated one,
     depending on how the page builds it; both are accepted and de-duplicated. */
  const list = (value) => {
    const raw = Array.isArray(value) ? value : String(value === undefined || value === null ? '' : value).split(',');
    return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  };
  return {
    from, to,
    resourceIds: list(query.resourceId || query.resourceIds),
    projectId: String(query.projectId || '').trim() || null,
    clientId: String(query.clientId || '').trim() || null,
    department: disciplineWhere(query.department) ? String(query.department).trim().toLowerCase() : null,
  };
}

/* The selection, as a derived table.
 *
 * GROUPED FIRST, JOINED AFTER. The grouping is by (asset, submitter) and
 * everything else is a lookup on a primary key, so the display columns are
 * joined to the result rather than carried through a GROUP BY — which is what
 * keeps this working under ONLY_FULL_GROUP_BY. A studio's MySQL may have it on;
 * MariaDB's default does not, and a query that depends on which would be a
 * report that works in testing and fails on the hosting.
 */
function selectionSql(filters, projectIds) {
  const params = [projectIds];
  const where = ['a.project_id IN ($1)'];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (filters.projectId) add('a.project_id = ?', filters.projectId);
  if (filters.clientId) add('p.client_id = ?', filters.clientId);
  if (filters.resourceIds.length) add('s.user_id IN (?)', filters.resourceIds);
  /* THE DEPARTMENT PREDICATE IS NOT WRITTEN HERE. src/asset-discipline.js owns
     the rule and hands over the SQL for it, so there is no second copy of
     "animation is Animation" to drift. */
  const dept = disciplineWhere(filters.department);
  if (dept) {
    params.push(...dept.params);
    where.push(dept.sql.replace('?', `$${params.length}`));
  }
  add('s.submitted_at >= ?', `${filters.from} 00:00:00`);
  add('s.submitted_at <= ?', `${filters.to} 23:59:59`);

  const from = `FROM (
        SELECT v.asset_id, v.uploaded_by AS user_id, MAX(v.created_at) AS submitted_at
          FROM asset_versions v
          JOIN assets a2 ON a2.id = v.asset_id
         WHERE a2.project_id IN ($1) AND v.uploaded_by IS NOT NULL
         GROUP BY v.asset_id, v.uploaded_by
      ) s
      JOIN assets a ON a.id = s.asset_id
      JOIN projects p ON p.id = a.project_id
      LEFT JOIN clients c ON c.id = p.client_id
      JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')}`;
  return { from, params };
}

/* OUTSOURCED WORK IS NOT IN THIS REPORT, and is counted so the screen can say
   so. A freelancer has no login and no work session, so every row of theirs
   would read 0.00 spent and a blank efficiency — a page of rows that say
   nothing, which is worse than a sentence saying how many there are. Cancelled
   assignments do not count: taking the work back makes it the studio's again.
   The same predicate the Efficiency report uses. */
const OUTSOURCED = `EXISTS (SELECT 1 FROM outsource_assignments oa
                             WHERE oa.asset_id = a.id AND oa.status <> 'cancelled')`;

async function build(db, user, query = {}, { page = 1, pageSize = PAGE_SIZE, all = false, now = new Date() } = {}) {
  const filters = filtersFrom(query, now);
  const projects = await visibleProjects(user);
  const empty = {
    filters, rows: [], total: 0, page: 1, pageSize, pages: 0,
    outsourcedExcluded: 0, scope: { projects: projects.length }, truncated: false,
  };
  if (!projects.length) return empty;
  const projectIds = projects.map((p) => p.id);
  const { from, params } = selectionSql(filters, projectIds);

  /* Counted and fetched in one query rather than two: the count of rows and the
     count of outsourced assets come back with the page, so the screen's "N
     outsourced not included" is from the same read as the rows it is about.
     SQL_CALC_FOUND_ROWS is MySQL-only and deprecated, so the totals are their
     own aggregate over the same FROM. */
  const { rows: totals } = await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${OUTSOURCED} THEN 1 ELSE 0 END), 0) AS outsourced_rows,
            COUNT(DISTINCT CASE WHEN ${OUTSOURCED} THEN a.id END) AS outsourced_assets
       ${from}`, params);
  const outsourcedAssets = Number(totals[0] ? totals[0].outsourced_assets : 0) || 0;
  const total = (Number(totals[0] ? totals[0].total : 0) || 0) - (Number(totals[0] ? totals[0].outsourced_rows : 0) || 0);
  if (!total) return { ...empty, total: 0, outsourcedExcluded: outsourcedAssets };

  const limit = all ? Math.min(total, DOWNLOAD_LIMIT) : pageSize;
  const safePage = all ? 1 : Math.max(1, Math.min(page, Math.ceil(total / pageSize)));
  const offset = all ? 0 : (safePage - 1) * pageSize;

  /* ORDERED IN THE DATABASE, in the order the brief asks for: client, project,
     resource, submit date. The asset name breaks the remaining tie so the order
     is total — two assets submitted by one person on one day would otherwise
     come back in whatever order the engine felt like, and a report whose rows
     move between two downloads of the same data looks broken. */
  const order = 'ORDER BY COALESCE(c.`name`, \'\'), p.`name`, u.`name`, s.submitted_at, a.`name`, a.id';
  const { rows } = await db.query(
    `SELECT a.id AS assetId, a.\`name\` AS assetName, a.\`type\` AS assetType,
            a.man_hours AS bidHours,
            p.id AS projectId, p.\`name\` AS projectName,
            c.id AS clientId, c.\`name\` AS clientName,
            u.id AS resourceId, u.\`name\` AS resourceName,
            DATE_FORMAT(s.submitted_at, '%Y-%m-%d') AS submitDate
       ${from} AND NOT ${OUTSOURCED}
      ${order}
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);

  /* RECORDED TIME, GROUPED, FOR THE ASSETS ON THIS PAGE ONLY.
   *
   * Built from the expressions src/work-log.js exports, so this is the same
   * definition recordedFor() gives one row at a time — asserted equal by a
   * test rather than left to the comment. Two figures come out of it: what each
   * person recorded on the asset (Spent Hours) and what the asset cost in total
   * across everybody (the denominator of Efficiency, which includes people who
   * never submitted and so have no row here). */
  const assetIds = [...new Set(rows.map((r) => r.assetId))];
  const recorded = assetIds.length ? await db.query(
    `SELECT w.asset_id, w.user_id,
            ${workLog.RECORDED_SECONDS_SQL()} AS seconds,
            ${workLog.RECORDED_OPEN_AGE_SQL()} AS open_age
       FROM work_sessions w
      WHERE w.asset_id IN ($1)
      GROUP BY w.asset_id, w.user_id`, [assetIds]) : { rows: [] };
  const live = await workLog.liveLeaveIndex(db);
  const atMs = now.getTime();

  const byPair = new Map();
  const byAsset = new Map();
  for (const r of recorded.rows) {
    const seconds = (Number(r.seconds) || 0)
      + workLog.liveSeconds(r.open_age, atMs, live.get(r.user_id) || []);
    byPair.set(`${r.asset_id}|${r.user_id}`, seconds);
    byAsset.set(r.asset_id, (byAsset.get(r.asset_id) || 0) + seconds);
  }

  const shaped = rows.map((r) => {
    const own = byPair.get(`${r.assetId}|${r.resourceId}`) || 0;
    const assetSeconds = byAsset.get(r.assetId) || 0;
    const bid = r.bidHours === null || r.bidHours === undefined ? null : Number(r.bidHours);
    return {
      assetId: r.assetId,
      projectId: r.projectId,
      clientId: r.clientId,
      resourceId: r.resourceId,
      clientName: r.clientName || '',
      projectName: r.projectName || '',
      // The shared rule, called — never re-derived from the type here.
      department: disciplineLabel(assetDiscipline({ type: r.assetType })),
      assetName: r.assetName || '',
      resourceName: r.resourceName || '',
      submitDate: r.submitDate,
      bidHours: bid,
      spentHours: hours(own),
      // Everybody's hours on the asset, which is what the bid was for.
      assetSpentHours: hours(assetSeconds),
      efficiency: assetEfficiency({ bidHours: bid, assetSeconds }),
      // Shown on screen so a repeated Bid Hours is explained rather than odd.
      sharedAsset: false,
    };
  });

  /* Which rows share an asset, so the screen can mark them. Counted over the
     page, which is where the explanation is needed. */
  const perAsset = new Map();
  for (const row of shaped) perAsset.set(row.assetId, (perAsset.get(row.assetId) || 0) + 1);
  for (const row of shaped) row.sharedAsset = (perAsset.get(row.assetId) || 0) > 1;

  return {
    filters,
    rows: shaped,
    total,
    page: safePage,
    pageSize: all ? limit : pageSize,
    pages: all ? 1 : Math.ceil(total / pageSize),
    outsourcedExcluded: outsourcedAssets,
    scope: { projects: projects.length },
    truncated: all && total > DOWNLOAD_LIMIT,
  };
}

/* The title in the file, and the file's name. Both carry the range, because a
   spreadsheet in somebody's downloads folder has to say what it covers. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!m) return String(text || '');
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

const titleFor = (filters) =>
  `ARTIST REPORT · ${prettyDate(filters.from)} to ${prettyDate(filters.to)}`;

const fileNameFor = (filters) => `Artist_Report_${filters.from}_to_${filters.to}.xlsx`;

module.exports = {
  build, assetEfficiency, filtersFrom, defaultRange, titleFor, fileNameFor, prettyDate,
  selectionSql, PAGE_SIZE, DOWNLOAD_LIMIT, hours,
};
