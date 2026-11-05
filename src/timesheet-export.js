// EVERYBODY'S TIMESHEET LINES, FOR A PERIOD, AS ROWS FOR THE SPREADSHEET.
//
// ===========================================================================
// WHAT THIS DECIDES AND WHAT IT DOES NOT. This module chooses the rows: which
// lines, in which order, mapped into the ten columns the template has. It does
// not decide what the file looks like (src/timesheet-export-xlsx.js) and it
// does not decide who may ask (the route, with timesheet.export and the
// studio's switch) — except for the one part of authorisation that belongs with
// the data: the set of people whose lines may appear, which comes from
// src/timesheet-visibility.js, the same function the Timesheet tab uses.
//
// "SUBMITTED" MEANS timesheet_days.status IN ('submitted','approved').
//
// One row per person per day in timesheet_days, created on demand: a day
// nobody has touched has no row at all, which is why this is an INNER JOIN
// rather than a filter on a column. Reopening a day sets its status back to
// 'draft' AND clears submitted_at, so a reopened day drops out of the report
// until it is filed again — which is correct: it is a draft, and its lines are
// being changed. 'approved' is in the list because the status column has always
// allowed it; nothing in the daily flow sets it today.
//
// THE KINDS OF TIME, AND WHERE EACH LANDS. A line's kind is decided by
// timesheet_entries.non_project, exactly as src/timesheets.js decides it:
//
//   null          project work. Task Hours. This also covers a lead's TL
//                 Action line, which carries a project and a tl_action and no
//                 asset.
//   'idle'        Idle Hours, with its sub-option and note in the remarks
//                 column. The one category src/timesheets.js treats specially,
//                 and the one this report does too.
//   'leave'       NO ROW. The template has no leave column, and a leave line
//                 written into Task Hours would inflate everybody's worked
//                 hours.
//   anything else Task Hours. Training, On Site, Internal Meeting, Admin and
//                 Holiday are ordinary categories in this application — see
//                 the note on IDLE_LIKE below, which is where that decision
//                 lives if the studio wants it changed.
const db = require('./db');
const { readableUserIds } = require('./timesheet-visibility');
const { assetDiscipline, disciplineLabel } = require('./asset-discipline');
/* The category -> discipline mapping the Art / Animation rule reads beside the
   type. Read once per export and passed into mapRow(), which stays pure — see
   the note there, and src/asset-discipline.js for the rule. */
const referenceData = require('./reference-data');
const tlReview = require('./tl-review');
const writer = require('./timesheet-export-xlsx');

const MAX_SPAN_DAYS = 366;
/* THE ROW CAP, and what it means in practice. A hundred thousand lines is
   about four months for a studio of two hundred people filing ten lines a day,
   so a year-wide download for a studio that size is refused and has to be
   asked for in halves. That is the brief's number and it is the right
   direction to be wrong in: the alternative to refusing is a request that
   builds a sixty-megabyte file and times out, which looks like a broken
   feature rather than a limit. */
const MAX_ROWS = 100000;

const SUBMITTED_STATUSES = ['submitted', 'approved'];

/* THE CATEGORIES THAT COUNT AS IDLE, in one place.
 *
 * ONLY 'idle', and this is a decision the brief and the data disagreed about.
 * Prompt 62 describes "Idle Hours … including its Training / On Site
 * sub-categories" — but in this application Training and On Site are not
 * sub-categories of Idle: they are sibling categories in timesheet_categories,
 * each with sub-options of their own (see src/reference-defaults.js). Only
 * 'idle' is is_system, and only 'idle' is what src/timesheets.js splits out of
 * a week's totals.
 *
 * So Training and On Site hours go to Task Hours, with the brief's other
 * sentence — "any other non-idle kind you find in Step 0" — and this set is
 * where a studio that wants them counted as idle changes its mind: add the key
 * here and both the column and the remarks follow. */
const IDLE_LIKE = new Set(['idle']);

/* Leave produces no rows at all. Its own set for the same reason: so the
   decision is a value somebody can find rather than a condition in a loop. */
const NO_ROW = new Set(['leave']);

/* ---- validation --------------------------------------------------------- */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/* A real calendar date, and the same date back. `new Date('2026-02-31')` is
   2026-03-03, which would silently widen a February range by three days, so the
   parse is checked by re-rendering it. */
function validDate(text) {
  const m = DATE.exec(String(text || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const daysBetween = (from, to) => Math.round(
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
) + 1;

/* What the route may ask for. Returns { ok: false, status, error, field } in the
   shape every other route in this application refuses with. */
function validate({ from, to, users }) {
  const start = validDate(from);
  const end = validDate(to);
  if (!start) {
    return { ok: false, status: 400, field: 'from',
      error: 'Give a start date as YYYY-MM-DD.' };
  }
  if (!end) {
    return { ok: false, status: 400, field: 'to',
      error: 'Give an end date as YYYY-MM-DD.' };
  }
  if (start > end) {
    return { ok: false, status: 400, field: 'to',
      error: 'The start date must be on or before the end date.' };
  }
  const span = daysBetween(start, end);
  if (span > MAX_SPAN_DAYS) {
    return { ok: false, status: 400, field: 'to',
      error: `That period is ${span} days. A download covers at most ${MAX_SPAN_DAYS} days — `
        + 'ask for a year or less at a time.' };
  }
  const wanted = String(users || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { ok: true, from: start, to: end, users: [...new Set(wanted)], span };
}

/* ---- the rows ----------------------------------------------------------- */

/* THE ONE QUERY. Joined to timesheet_days so an unsubmitted day cannot appear,
 * and LEFT joined to everything else because a line need not have a project, a
 * client or an asset.
 *
 * SORTED IN SQL, not in JavaScript: date, then the artist's name, then client,
 * project and asset, which is the order the brief asks for and the order
 * somebody reads a printed sheet in. Collated by the column's own collation, so
 * "ana" and "Ana" sort together as they do everywhere else in this schema.
 */
const ROW_SQL = `
  SELECT DATE_FORMAT(e.entry_date, '%Y-%m-%d') AS day,
         u.\`name\`            AS artist,
         c.\`name\`            AS clientName,
         p.\`name\`            AS projectName,
         a.\`name\`            AS assetName,
         a.type               AS assetType,
         /* Beside the type because the Department column is the Art /
            Animation rule, and that rule reads both fields. */
         a.category           AS assetCategory,
         a.man_hours          AS bidHours,
         e.hours              AS hours,
         e.non_project        AS category,
         e.non_project_sub    AS subKey,
         e.tl_action          AS tlAction,
         e.notes              AS notes
    FROM timesheet_entries e
    JOIN timesheet_days d ON d.user_id = e.user_id AND d.work_date = e.entry_date
    JOIN users u ON u.id = e.user_id
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN clients  c ON c.id = COALESCE(e.client_id, p.client_id)
    LEFT JOIN assets   a ON a.id = e.asset_id
   WHERE e.entry_date BETWEEN $1 AND $2
     AND e.user_id IN ($3)
     AND d.status IN ($4)
   ORDER BY e.entry_date ASC, u.\`name\` ASC, c.\`name\` ASC, p.\`name\` ASC, a.\`name\` ASC, e.id ASC`;

/* The sub-option labels, resolved in one query rather than one per line. A key
   with no row — an option a Super Admin retired — falls back to the key itself
   rather than to nothing: the hours were filed against something, and an empty
   remark would lose the only record of what. */
async function subLabels(keys) {
  const wanted = [...new Set(keys.filter(Boolean))];
  if (!wanted.length) return new Map();
  const { rows } = await db.query(
    'SELECT `key`, label FROM timesheet_sub_options WHERE `key` IN ($1)', [wanted]
  ).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [r.key, r.label]));
}

/* One database row as one spreadsheet row. Pure, so the mapping can be tested
   without a database — which is what tests/timesheet-export.test.js does for
   every kind of line.
   
   `disciplines` IS PASSED IN RATHER THAN LOOKED UP, and that is what keeps this
   function pure now that the Art / Animation rule reads the asset's category
   through a mapping. Asking src/reference-data.js for it in here would make
   every call read module state, and would rebuild the Map once per
   spreadsheet row. Empty by default, which is a studio that has classified no
   category: the rule then reads the type alone, exactly as it did before. */
function mapRow(row, labels = new Map(), disciplines = new Map()) {
  const category = row.category || null;
  if (NO_ROW.has(category)) return null;
  const idle = IDLE_LIKE.has(category);
  const hours = writer.round2(row.hours);

  /* THE TL ACTION'S LABEL, FROM THE MODULE THAT OWNS THE SPELLING.
     This file used to carry its own copy of the two strings, which
     tests/tl-review.test.js exists to prevent and duly caught — that scan
     reads comments too, so the words themselves are not repeated here either.
     It is not only tidiness: labelFor() also reads the retired review value as
     a review, so a row the migration could not reach gets a description here
     instead of an empty Asset Name cell. */
  const tl = row.tlAction ? tlReview.labelFor(row.tlAction) : null;
  const subLabel = row.subKey ? (labels.get(row.subKey) || row.subKey) : null;
  const note = row.notes === null || row.notes === undefined ? '' : String(row.notes).trim();

  /* THE REMARKS COLUMN IS FOR IDLE AND NOTHING ELSE, which is what its header
     says: "If idle,Please mention the remarks." A note on a project line is
     the person's own working note and belongs in the Timesheet tab, not in a
     column a manager reads as a reason for slack. */
  let remarks = null;
  if (idle) {
    if (subLabel && note) remarks = `${subLabel}: ${note}`;
    else if (subLabel) remarks = subLabel;
    else if (note) remarks = note;
  }

  return {
    date: row.day,
    artist: row.artist || null,
    clientName: row.clientName || null,
    projectName: row.projectName || null,
    /* THE ASSET'S NAME, or the TL Action label in its place. A TL line has no
       asset by design (Prompt 57 cleared the field for both options), so the
       column would otherwise be empty on the one kind of line whose purpose is
       not obvious from the rest of the row. */
    assetName: tl || row.assetName || null,
    /* THE ASSET'S DISCIPLINE, through the same function the Artist Report uses,
       so the two reports cannot disagree about the same asset. A line with no
       asset has no department: users carry no discipline in this schema — only
       freelancers do, and a freelancer is not a user. */
    department: row.assetName ? disciplineLabel(assetDiscipline(
      { type: row.assetType, category: row.assetCategory }, disciplines)) : null,
    /* BID HOURS REPEAT ON EVERY ROW OF THE SAME ASSET, which is safe precisely
       because this file has no totals row: nothing adds the column up, so
       nothing double counts. */
    bidHours: row.assetName ? writer.round2(row.bidHours) : null,
    taskHours: idle ? null : hours,
    idleHours: idle ? hours : null,
    remarks,
  };
}

/* Everything the route needs: the rows, and the people they came from. */
async function rowsFor(viewer, { from, to, users = [] }) {
  const allowed = await readableUserIds(viewer);
  const allowedSet = new Set(allowed.map(String));
  /* THE INTERSECTION, AND IT IS SILENT ABOUT WHAT IT DROPPED. Asking for
     somebody the requester cannot see is ignored rather than refused: the page
     only ever offers people from the same list, so a stranger's id in the
     query is either a stale tab or somebody probing — and a 403 that names the
     id confirms the id exists. The report simply contains who it should. */
  const ids = users.length ? users.filter((id) => allowedSet.has(String(id))) : allowed;
  if (!ids.length) return { rows: [], people: 0, asked: users.length, allowed: allowed.length };

  const { rows } = await db.query(ROW_SQL, [from, to, ids, SUBMITTED_STATUSES]);
  const labels = await subLabels(rows.map((r) => r.subKey));
  /* Built once for the whole export, not once per row. */
  const disciplines = referenceData.categoryDisciplines();
  const mapped = [];
  const people = new Set();
  for (const row of rows) {
    const out = mapRow(row, labels, disciplines);
    if (!out) continue;
    mapped.push(out);
    people.add(row.artist);
  }
  return { rows: mapped, people: people.size, asked: users.length, allowed: allowed.length };
}

/* The count line under the modal's controls. The same filters and the same
   joins as the download, so a period that says "412 lines from 9 people"
   produces a file with 412 rows. Counted in SQL rather than by building the
   rows and measuring them: the point of this endpoint is that it is cheap. */
async function countFor(viewer, { from, to, users = [] }) {
  const allowed = await readableUserIds(viewer);
  const allowedSet = new Set(allowed.map(String));
  const ids = users.length ? users.filter((id) => allowedSet.has(String(id))) : allowed;
  if (!ids.length) return { lines: 0, people: 0 };
  const { rows } = await db.query(
    /* `lines` IS A RESERVED WORD IN MARIADB (it is the LINES clause of LOAD
       DATA / SELECT INTO), so the alias has to be quoted or the whole statement
       is a parse error — which is what this endpoint did until it was first
       pressed: a 500 with ER_PARSE_ERROR on every count. Quoted rather than
       renamed, because the field name is part of the response the page reads. */
    `SELECT COUNT(*) AS \`lines\`, COUNT(DISTINCT e.user_id) AS people
       FROM timesheet_entries e
       JOIN timesheet_days d ON d.user_id = e.user_id AND d.work_date = e.entry_date
      WHERE e.entry_date BETWEEN $1 AND $2
        AND e.user_id IN ($3)
        AND d.status IN ($4)
        AND (e.non_project IS NULL OR e.non_project NOT IN ($5))`,
    [from, to, ids, SUBMITTED_STATUSES, [...NO_ROW]]
  );
  return { lines: Number(rows[0].lines) || 0, people: Number(rows[0].people) || 0 };
}

/* ---- the file name ------------------------------------------------------ */

const firstOfMonth = (d) => /^\d{4}-\d{2}-01$/.test(d);
const lastOfMonth = (d) => {
  const [y, m] = d.split('-').map(Number);
  return Number(d.slice(8)) === new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/* Timesheet_<from>_to_<to>.xlsx, with three shorter forms for the three periods
   somebody actually asks for. Sanitised to the characters a filename may carry
   on every platform this application is opened on — the parts are dates, so
   nothing should ever be stripped, and the strip is there because a filename is
   built from input and that is how a header injection starts. */
function fileNameFor(from, to) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '');
  if (from === to) return `Timesheet_${clean(from)}.xlsx`;
  if (from.slice(0, 4) === to.slice(0, 4)) {
    if (from.slice(5, 7) === to.slice(5, 7) && firstOfMonth(from) && lastOfMonth(to)) {
      return `Timesheet_${clean(from.slice(0, 7))}.xlsx`;
    }
    if (from.endsWith('-01-01') && to.endsWith('-12-31')) {
      return `Timesheet_${clean(from.slice(0, 4))}.xlsx`;
    }
  }
  return `Timesheet_${clean(from)}_to_${clean(to)}.xlsx`;
}

module.exports = {
  validate, rowsFor, countFor, mapRow, fileNameFor, subLabels,
  MAX_SPAN_DAYS, MAX_ROWS, SUBMITTED_STATUSES, IDLE_LIKE, NO_ROW,
  validDate, daysBetween,
};
