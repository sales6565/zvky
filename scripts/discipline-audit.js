#!/usr/bin/env node
/* WHICH TAB EVERY ASSET LANDS IN, BEFORE AND AFTER THE CATEGORY RULE.
 *
 * ===========================================================================
 * READ-ONLY, AND SAFE TO RUN ON PRODUCTION. That is the point of it: the owner
 * reported that assets whose CATEGORY is Animation do not appear under the
 * Animation tab, and the first question is how many assets that is and which
 * ones move. Answering it by changing the rule and looking at the screen would
 * mean finding out on production.
 *
 * SO IT WRITES NOTHING, and that is checked rather than asserted in prose.
 * Every statement goes through one function, q() below, which REFUSES anything
 * matching INSERT / UPDATE / DELETE / ALTER / DROP / CREATE / TRUNCATE /
 * REPLACE / GRANT — so a query added here carelessly throws instead of writing.
 * The driver's multi-statement support is off (src/db.js never turns it on), so
 * a second statement cannot ride along behind a SELECT.
 *
 * AND tests/discipline-audit.test.js RUNS IT against a populated database
 * through a handle that records every statement, then asserts: that each one
 * begins with SELECT, that the refusal fires on a write, and that every table's
 * row count and every assets.type / assets.category / categories.discipline
 * value is exactly what it was before the run.
 *
 * ===========================================================================
 * THE TWO RULES IT COMPARES.
 *
 *   BEFORE   the asset's TYPE alone. `animation` is Animation, everything else
 *            is Art — which is what src/asset-discipline.js has always done and
 *            documents at length.
 *   AFTER    Animation when the type is `animation` OR the asset's CATEGORY maps
 *            to the Animation discipline. Animation wins a disagreement, which
 *            is the owner's stated expectation.
 *
 * WHERE THE CATEGORY MAPPING COMES FROM, in this order, so the script is useful
 * both before and after the migration:
 *
 *   1. categories.discipline, once the column exists — the real mapping.
 *   2. otherwise the name test the migration itself will apply: a category whose
 *      label or key contains "animation", case-insensitively. This is a PREVIEW
 *      of what the migration would decide, and the output says so.
 *
 * Run it:
 *   node scripts/discipline-audit.js                 (the connected database)
 *   node scripts/discipline-audit.js --json          (machine-readable)
 *   node scripts/discipline-audit.js --changes-only  (just the assets that move)
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { assetDiscipline, disciplineFromName } = require(path.join(ROOT, 'src', 'asset-discipline'));

/* THE "AFTER" RULE IS THE SHARED ONE, ASKED. A second copy of the
   classification in here is the bug this whole change is about, so the audit
   calls src/asset-discipline.js and tests/discipline-audit.test.js asserts the
   two agree on every row it reports. */
const afterDiscipline = (asset, categoryMap) => assetDiscipline(asset, categoryMap);

/* THE "BEFORE" RULE, WRITTEN OUT, because it does not exist anywhere else any
   more — it is the history this script's whole purpose is to compare against.
   The type alone: `animation` is Animation, everything else is Art. Four lines
   of a rule nothing reads are worth it to be able to say, on a production
   database and without touching it, exactly which assets move. */
function beforeDiscipline(asset) {
  const type = String((asset && asset.type) || '').trim().toLowerCase();
  return type === 'animation' ? 'animation' : 'art';
}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|REPLACE|GRANT)\b/i;

/* INJECTABLE, so the test can run the real thing rather than a paraphrase.
 *
 * `db`, `argv` and `write` default to the ones a command line gives it. The
 * test passes a handle bound to its own suite database (src/db's pool points at
 * TEST_DB_NAME, not at the suite's copy — see the note in
 * tests/vacation-stops-timers.test.js), a handle that RECORDS every statement,
 * and a writer it can read back. That is what lets the read-only claim be
 * proved against the queries this file really runs, instead of against a
 * regular expression over its source. */
async function main(opts = {}) {
  const argv = opts.argv || process.argv;
  const write = opts.write || ((text) => process.stdout.write(text));
  const asJson = argv.includes('--json');
  const changesOnly = argv.includes('--changes-only');

  const db = opts.db || require(path.join(ROOT, 'src', 'db'));
  const q = async (sql, params = []) => {
    /* THE GUARD, AT THE ONE PLACE EVERY QUERY GOES THROUGH. Belt and braces
       beside the static check in the test: a script that is safe because
       somebody read it is less safe than one that refuses. */
    if (FORBIDDEN.test(sql)) throw new Error(`discipline-audit is read-only; refused: ${sql}`);
    const { rows } = await db.query(sql, params);
    return rows;
  };

  /* THE CATEGORY MAP. Tolerant of the column not existing, because the whole
     point is to run this BEFORE the migration as well as after. */
  let categories = [];
  let haveColumn = false;
  try {
    categories = await q(
      'SELECT `key`, label, discipline, is_active FROM categories ORDER BY position DESC, label'
    );
    haveColumn = true;
  } catch (err) {
    if (!/Unknown column/i.test(err.sqlMessage || err.message || '')) throw err;
    categories = await q(
      'SELECT `key`, label, is_active FROM categories ORDER BY position DESC, label'
    );
  }

  /* THE PREVIEW USES THE MIGRATION'S OWN GUESS, from the shared module, so a
     report produced before the upgrade says what the upgrade will actually do.
     The guess looks at the key as well as the label, as the migration's SQL
     does: a category renamed since it was created keeps its original key. */
  const nameSaysAnimation = (c) => disciplineFromName(c.label) === 'animation'
    || disciplineFromName(c.key) === 'animation';
  const categoryMap = new Map();
  for (const c of categories) {
    const id = haveColumn && c.discipline
      ? String(c.discipline).trim().toLowerCase()
      : (nameSaysAnimation(c) ? 'animation' : 'art');
    categoryMap.set(String(c.key || '').trim().toLowerCase(), id);
  }

  const assets = await q(
    'SELECT a.id, a.`code`, a.`name`, a.`type`, a.category, p.`name` AS project '
    + 'FROM assets a LEFT JOIN projects p ON p.id = a.project_id '
    + 'ORDER BY a.`type`, a.category, a.`code`'
  );

  /* GROUPED BY (type, category), which is the shape that makes the cause
     legible: every row where before and after differ has a category that maps
     to Animation and a type that is not `animation`. */
  const groups = new Map();
  const moved = [];
  for (const a of assets) {
    const before = beforeDiscipline({ type: a.type });
    const after = afterDiscipline({ type: a.type, category: a.category }, categoryMap);
    const key = `${a.type || '(none)'}\u0000${a.category || '(none)'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        type: a.type || null, category: a.category || null, count: 0, before, after,
      });
    }
    groups.get(key).count += 1;
    if (before !== after) {
      moved.push({ id: a.id, code: a.code, name: a.name, project: a.project,
        type: a.type, category: a.category, before, after });
    }
  }

  const report = {
    database: opts.databaseName || process.env.DB_NAME || null,
    categoriesHaveDisciplineColumn: haveColumn,
    categories: categories.map((c) => ({
      key: c.key,
      label: c.label,
      active: Boolean(Number(c.is_active)),
      discipline: categoryMap.get(String(c.key || '').trim().toLowerCase()),
      source: haveColumn && c.discipline ? 'column' : 'name-preview',
    })),
    assets: assets.length,
    groups: [...groups.values()].sort((x, y) => y.count - x.count),
    moves: moved,
  };

  if (asJson) {
    write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const out = [];
  out.push(`assets: ${report.assets}   database: ${report.database || '(unnamed)'}`);
  out.push(`categories.discipline column: ${haveColumn ? 'present' : 'NOT YET — names previewed'}`);
  out.push('');
  if (!changesOnly) {
    out.push('categories');
    if (!report.categories.length) out.push('  (none — the list ships empty)');
    for (const c of report.categories) {
      out.push(`  ${String(c.label).padEnd(24)} key=${String(c.key).padEnd(18)} `
        + `-> ${c.discipline}${c.active ? '' : '  (retired)'}  [${c.source}]`);
    }
    out.push('');
    out.push('assets by (type, category)            count  before      after');
    for (const g of report.groups) {
      const label = `${g.type || '(none)'} / ${g.category || '(none)'}`;
      out.push(`  ${label.padEnd(36)} ${String(g.count).padStart(5)}  `
        + `${g.before.padEnd(10)}  ${g.after}${g.before === g.after ? '' : '   <-- MOVES'}`);
    }
    out.push('');
  }
  out.push(`assets whose tab changes: ${report.moves.length}`);
  for (const m of report.moves) {
    out.push(`  ${String(m.code || m.id).padEnd(12)} ${String(m.name || '').slice(0, 28).padEnd(30)}`
      + ` ${String(m.project || '').slice(0, 20).padEnd(22)} ${m.before} -> ${m.after}`);
  }
  write(`${out.join('\n')}\n`);
  return report;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, afterDiscipline, beforeDiscipline, FORBIDDEN };
