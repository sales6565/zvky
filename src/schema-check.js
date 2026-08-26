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
  { table: 'role_permissions',      column: null,      step: 'role permissions' },
  { table: 'role_permission_audit', column: null,      step: 'role permissions' },
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
      const clause = String(row.c || '');
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
async function gaps(db) {
  const [columns, constraints] = await Promise.all([missing(db), staleConstraints(db)]);
  return [...columns, ...constraints];
}

module.exports = { REQUIRED, CONSTRAINTS, missing, staleConstraints, gaps };
