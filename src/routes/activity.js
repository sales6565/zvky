// Reading the Activity Log.
//
// Read-only, by design. Nothing here writes to activity_log — the middleware
// and the routes do that — and nothing here can delete from it. An audit log
// with an API that can edit it is not an audit log, and the absence of those
// endpoints is the feature.
const express = require('express');
const xlsx = require('xlsx');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const activity = require('../activity');
const exporter = require('../report-export');
const reportPdf = require('../report-pdf');
const branding = require('../branding');

const router = express.Router();
router.use(authenticate);

/* Times are shown in India Standard Time, matching the Time Sheet's label.
 *
 * Worth being precise about what that means, because the two are not the same
 * kind of thing. A Time Sheet line is a WALL CLOCK time with no timezone in it.
 * These are real instants, stored by MySQL's NOW() in the server's own clock —
 * so this label is accurate exactly while the server runs on IST, which is the
 * assumption every other timestamp in this application already makes. It is
 * stated here rather than left implicit so that moving the deployment to a
 * server on UTC is a known change rather than a silent one. */
const TZ_LABEL = 'IST';

const shape = (row) => ({
  id: row.id,
  seq: Number(row.seq),
  at: row.created_at,
  actor: {
    id: row.actor_id,
    name: row.actor_name || 'Unknown',
    email: row.actor_email || '',
    role: row.actor_role || '',
    roleLabel: activity.labelForRole(row.actor_role),
  },
  module: row.module,
  action: row.action,
  entity: row.entity_id || row.entity_label
    ? { type: row.entity_type, id: row.entity_id, label: row.entity_label }
    : null,
  summary: row.summary,
  changes: parseChanges(row.changes),
  method: row.method,
  path: row.path,
});

function parseChanges(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* GET /api/activity — the page.
 *
 * Filters by person, module, action, date range and free text, and pages. The
 * total comes back with every page because "1–50 of 12,431" is the number that
 * tells somebody whether their filter did anything. */
router.get('/', requirePermission('settings.activity_log'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, activity.PAGE_MAX);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { clause, params } = activity.buildQuery(req.query);

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS n FROM activity_log a ${clause}`, params);
  const { rows } = await db.query(
    `SELECT a.* FROM activity_log a ${clause} ORDER BY a.seq DESC LIMIT ${limit} OFFSET ${offset}`,
    params);

  /* Who to offer in the "person" filter: everybody who has actually done
     something, read off the log itself rather than off the user list. A filter
     listing sixty accounts of whom four have ever acted is a filter that mostly
     returns nothing. */
  const { rows: actors } = await db.query(
    `SELECT actor_id AS id, MAX(actor_name) AS name, MAX(actor_email) AS email
       FROM activity_log WHERE actor_id IS NOT NULL
      GROUP BY actor_id ORDER BY name`);
  const { rows: actions } = await db.query(
    'SELECT DISTINCT action FROM activity_log ORDER BY action');

  res.json({
    entries: rows.map(shape),
    total: Number(countRows[0].n),
    limit,
    offset,
    timezone: TZ_LABEL,
    modules: activity.MODULES,
    actors,
    actions: actions.map((a) => a.action),
  });
});

/* The exports. Same rows, same filters, same permission — an export that could
   reach further than the screen would be a way around the screen's gate. */
const EXPORT_HEADERS = ['When', 'Person', 'Role', 'Module', 'Action', 'Entity', 'What happened', 'Changed'];

async function exportRows(req) {
  const { clause, params } = activity.buildQuery(req.query);
  const { rows } = await db.query(
    `SELECT a.* FROM activity_log a ${clause} ORDER BY a.seq DESC LIMIT ${activity.PAGE_MAX * 25}`,
    params);
  return rows.map(shape).map((e) => ({
    When: stampOf(e.at),
    Person: e.actor.name,
    Role: e.actor.roleLabel || e.actor.role,
    Module: e.module,
    Action: e.action,
    Entity: e.entity ? (e.entity.label || e.entity.id || '') : '',
    'What happened': e.summary,
    Changed: e.changes
      ? Object.entries(e.changes).map(([f, c]) => `${f}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')
      : '',
  }));
}

const pad = (n) => String(n).padStart(2, '0');
function stampOf(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const describeFilters = (q) => [
  ['Person', q.actorName || (q.actorId ? q.actorId : 'Everybody')],
  ['Module', q.module || 'All'],
  ['Action', q.action || 'All'],
  ['From', q.from || 'The beginning'],
  ['To', q.to || 'Now'],
  ['Search', q.q || '—'],
  ['Times shown in', TZ_LABEL],
];

router.get('/export.xlsx', requirePermission('settings.activity_log'), async (req, res) => {
  const rows = await exportRows(req);
  const book = xlsx.utils.book_new();
  const head = [
    [branding.current().appName],
    ['Activity log'],
    [],
    ...describeFilters(req.query),
    ['Entries', rows.length],
    [],
  ];
  const sheet = xlsx.utils.aoa_to_sheet(head);
  xlsx.utils.sheet_add_json(sheet, rows, { header: EXPORT_HEADERS, origin: -1 });
  xlsx.utils.book_append_sheet(book, sheet, 'Activity log');
  const buffer = xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'activity-log', 'xlsx')}"`);
  res.send(buffer);
});

router.get('/export.pdf', requirePermission('settings.activity_log'), async (req, res) => {
  const rows = await exportRows(req);
  const logo = await branding.readLogo(db).catch(() => null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${exporter.fileName(branding.current().appName, 'activity-log', 'pdf')}"`);
  reportPdf.write(res, {
    appName: branding.current().appName,
    tagline: branding.current().tagline,
    logo,
    view: { label: 'Activity log', sheet: 'Activity log' },
    title: 'Activity log',
    blurb: 'Every action taken in the period, newest first, with the person who took it. '
      + 'Times are IST. Nothing in this record can be edited or removed.',
    footer: 'activity log',
    emptyMessage: 'No activity was recorded in this range.',
    // Eight columns, two of them sentences. Portrait truncates the timestamps.
    landscape: true,
    headers: EXPORT_HEADERS,
    // The row objects themselves — see the note on rows in src/report-pdf.js.
    rows,
    filters: describeFilters(req.query),
    summary: [['Entries', String(rows.length)]],
    excluded: [],
  });
});

module.exports = router;
