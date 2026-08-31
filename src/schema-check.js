// What this build needs the database to have, and what is actually there.
//
// The startup migration adds all of this, but a step can fail — most often
// because the database user lacks ALTER or CREATE on shared hosting, sometimes
// because a lock or a constraint got in the way. When that happens the code
// runs against a schema it does not have, and the symptom is a 500 from
// whichever endpoint touches the missing piece: "the server could not complete
// that request because of a database error", with no clue which piece.
//
// This turns that into a named answer, reachable from /api/health without a
// shell or a log file.

// Every table and column added since this list started being kept, paired with
// the migration step that adds it — so the answer names the step to re-run
// rather than only the column that is missing.
const REQUIRED = [
  { table: 'clients',        column: null,             step: 'client hierarchy' },
  { table: 'projects',       column: 'client_id',      step: 'client hierarchy' },
  { table: 'projects',       column: 'is_active',      step: 'client and project lifecycle' },
  { table: 'projects',       column: 'archived_at',    step: 'client and project lifecycle' },
  { table: 'projects',       column: 'closed_at',      step: 'client and project lifecycle' },
  { table: 'clients',        column: 'is_active',      step: 'client and project lifecycle' },
  { table: 'clients',        column: 'archived_at',    step: 'client and project lifecycle' },
  { table: 'clients',        column: 'deal_closed_at', step: 'client and project lifecycle' },
  { table: 'assets',         column: 'created_by',     step: 'asset ownership' },
  { table: 'assets',         column: 'reference_link', step: 'asset brief and checklist' },
  { table: 'tasks',          column: 'created_by',     step: 'asset brief and checklist' },
  { table: 'tasks',          column: 'created_at',     step: 'asset brief and checklist' },
  { table: 'work_sessions',  column: null,             step: 'assigned state and time tracking' },
  // The history. Absent from this list until a reassignment failed on it — and
  // failed *after* updating the asset, so the change happened and the request
  // still reported a database error. asset_events is created with CREATE TABLE
  // IF NOT EXISTS, so an older copy of it keeps whatever columns it had.
  { table: 'asset_events',   column: null,             step: 'review pipeline' },
  { table: 'asset_events',   column: 'routed_to_id',   step: 'review pipeline' },
  { table: 'asset_events',   column: 'version_id',     step: 'review pipeline' },
  { table: 'asset_events',   column: 'note',           step: 'review pipeline' },
  { table: 'asset_versions', column: null,             step: 'review pipeline' },
  { table: 'asset_versions', column: 'link',           step: 'review pipeline' },
  { table: 'feedback',       column: null,             step: 'review pipeline' },
  { table: 'notes',          column: 'author_id',      step: 'review pipeline' },
  { table: 'role_permissions',      column: null,      step: 'role permissions' },
  { table: 'role_permission_audit', column: null,      step: 'role permissions' },

  /* Everything below was added after this list was last kept up. It went
     unnoticed because the check reported "complete" the whole time: a schema
     the app needs but this list does not know about is a gap the one endpoint
     built to name gaps cannot see. Adding a column to the app now means adding
     it here, and a test checks the two agree. */
  { table: 'work_sessions',    column: 'round',         step: 'assigned state and time tracking' },
  { table: 'work_sessions',    column: 'assignment_id', step: 'assignment history' },
  { table: 'asset_assignments', column: null,           step: 'assignment history' },
  { table: 'asset_assignments', column: 'ended_status', step: 'assignment history' },
  { table: 'ip_allowlist',     column: null,            step: 'IP allowlist' },
  { table: 'categories',       column: null,            step: 'reference tables' },
  { table: 'assets',           column: 'category',      step: 'asset category' },
  { table: 'branding',         column: null,            step: 'branding' },
  { table: 'branding',         column: 'logo',          step: 'branding' },
];

// Two queries for the whole check, rather than one per column.
async function missing(db) {
  const { rows: tables } = await db.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
  );
  const have = new Set(tables.map((r) => String(r.t).toLowerCase()));

  const { rows: columns } = await db.query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const haveColumn = new Set(columns.map((r) => `${String(r.t).toLowerCase()}.${String(r.c).toLowerCase()}`));

  const gaps = [];
  for (const need of REQUIRED) {
    if (!have.has(need.table)) {
      // Report the table once, not once per column it is missing.
      if (!gaps.some((g) => g.name === need.table)) {
        gaps.push({ name: need.table, kind: 'table', step: need.step });
      }
      continue;
    }
    if (need.column && !haveColumn.has(`${need.table}.${need.column}`)) {
      gaps.push({ name: `${need.table}.${need.column}`, kind: 'column', step: need.step });
    }
  }
  return gaps;
}

// A CHECK constraint's text, in a form the same string test works on
// everywhere.
//
// MySQL 8 renders string literals in CHECK_CLAUSE with a charset introducer and
// backslash-escaped quotes:
//
//   (`status` in (_utf8mb4\'not_started\',_utf8mb4\'assigned\'))
//
// MariaDB renders the identical constraint as:
//
//   `status` in ('not_started','assigned')
//
// So a test for "'not_started'" matches on MariaDB and finds nothing on
// MySQL 8 — the closing quote is preceded by a backslash. That is how an
// auto-named constraint, assets_chk_2, survived a repair that searched by
// clause precisely so that its name would not matter, and went on rejecting
// every write that set a status of 'assigned'. Verified against MariaDB here
// and against the MySQL 8 rendering in the tests.
function normalizeCheckClause(clause) {
  return String(clause || '')
    .replace(/\\(['"])/g, '$1')
    .replace(/_(?:utf8mb4|utf8mb3|utf8|latin1|binary|ascii)(?=')/gi, '');
}

// Constraints, which columns and tables do not cover.
//
// The gap that let a broken deployment report itself healthy: every table and
// column was present, so this said "complete", while the status CHECK
// constraint still refused 'assigned' and both of the studio's commonest
// writes — create an asset with an assignee, assign an existing one — failed.
// A constraint is part of the schema this build needs, so it is checked here.
const CONSTRAINTS = [
  {
    // Matched by what it constrains, not by what it is called. A database whose
    // status CHECK lives under a different name — an older schema, a table
    // recreated by a hosting panel's import — kept a narrow constraint that
    // still rejected 'assigned' while a second, correct chk_assets_status sat
    // beside it. Both are enforced. Keying this check on the name meant health
    // read the good one and reported ok, on a deployment where creating an
    // asset with an assignee failed every time.
    identifies: (clause) => /\bstatus\b/i.test(clause) && clause.includes("'not_started'"),
    describe: 'the assets status constraint',
    mustAllow: 'assigned',
    step: 'assigned state and time tracking',
    breaks: 'assigning an asset, and creating one with an assignee',
  },
];

async function staleConstraints(db) {
  // Destructured after the catch, not in it: `const { rows } = null` throws
  // before any guard can run.
  const result = await db.query(
    `SELECT CONSTRAINT_NAME AS n, CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()`
  ).catch(() => null);
  // Unreadable is not the same as wrong: report nothing rather than a false
  // alarm on a database that does not expose its constraints.
  if (!result || !result.rows) return [];
  const { rows } = result;

  const found = [];
  for (const need of CONSTRAINTS) {
    for (const row of rows) {
      const clause = normalizeCheckClause(row.c);
      if (!need.identifies(clause)) continue;
      if (clause.includes(`'${need.mustAllow}'`)) continue;
      found.push({
        name: String(row.n),
        kind: 'constraint',
        step: need.step,
        detail: `${need.describe} does not allow "${need.mustAllow}" — breaks ${need.breaks}`,
      });
    }
  }
  return found;
}

// Everything this build needs and does not have: tables, columns, constraints.
/* Tables whose collation disagrees with the rest of the schema.
 *
 * Not a missing piece, but it fails the same way and for the same reason — a
 * deployment whose schema is not what this build assumes. Any query comparing
 * a string column across two such tables dies with
 *
 *   Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT)
 *   and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
 *
 * and, less visibly, a foreign key cannot be created across the boundary at
 * all — so the schema quietly does not get constraints it asked for. The
 * startup migration converts these; this is what says so when it could not.
 */
async function mixedCollations(db) {
  const { rows: anchor } = await db.query(
    `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const want = anchor.length ? anchor[0].c : null;
  if (!want || !/^utf8mb4_/i.test(want)) return [];

  const { rows } = await db.query(
    `SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_COLLATION IS NOT NULL AND TABLE_COLLATION <> $1
      ORDER BY TABLE_NAME`,
    [want]
  );
  return rows.map((r) => ({
    name: r.t,
    kind: 'collation',
    step: 'collation alignment',
    detail: `is ${r.c}, the rest of the schema is ${want}; joins against it fail`,
  }));
}

async function gaps(db) {
  const [columns, constraints, collations] = await Promise.all([
    missing(db), staleConstraints(db), mixedCollations(db).catch(() => []),
  ]);
  return [...columns, ...constraints, ...collations];
}

module.exports = { REQUIRED, CONSTRAINTS, missing, staleConstraints, mixedCollations, gaps, normalizeCheckClause };
