#!/usr/bin/env node
// Does every ROW land in exactly one Assets List tab?
//
//   npm run tabs:check
//
// Reads only. Point it at a studio's database with the ordinary DB_* variables
// (a .env is enough) and it reports, per asset, which tab the rule puts it in —
// and names any asset that lands in none or in more than one.
//
// The rule itself is NOT reimplemented here. listTabOf() and its ordered
// TAB_RULES are lifted out of public/index.html and run as they are, because a
// checker carrying its own copy of the rule agrees with itself while the screen
// does something else — which is the drift this whole exercise is about. If the
// page changes, this changes with it or it stops working outright.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// The pieces the rule is built from, in dependency order.
const PARTS = [
  /const ASSET_LIST_GROUPS = \[[\s\S]*?\n\];/,
  /function listGroupOf\(statusId\)\{[\s\S]*?\n\}/,
  /function episodesOf\(a\)\{[^\n]*\}/,
  /const TAB_RULES = \[[\s\S]*?\n\];/,
  /function rowTabOf\(row\)\{[\s\S]*?\n\}/,
  /function listRows\(assets\)\{[\s\S]*?\n\}/,
  /function tabAudit\(assets\)\{[\s\S]*?\n\}/,
];

function loadRule() {
  const source = PARTS.map((re) => {
    const found = PAGE.match(re);
    if (!found) {
      throw new Error(
        `Could not find ${re} in public/index.html. The tab rule has been renamed or `
        + 'restructured; update scripts/check-tabs.js to match rather than copying the rule here.'
      );
    }
    return found[0];
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return { rowTabOf, listRows, tabAudit, TAB_RULES };`)();
}

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const { rowTabOf, listRows, tabAudit, TAB_RULES } = loadRule();
  const db = require('../src/db');

  // Assets, and the assignment episodes that decide their Round. Shaped exactly
  // as the API sends them to the page, so the rule sees what the screen sees.
  const { rows: assets } = await db.query(
    'SELECT id, `code`, `name`, `status` FROM assets ORDER BY `code`'
  );
  if (!assets.length) {
    console.log('No assets in this database — nothing to check.');
    return 0;
  }
  let episodes = [];
  try {
    ({ rows: episodes } = await db.query(
      'SELECT id, asset_id, ended_at FROM asset_assignments ORDER BY asset_id, seq'
    ));
  } catch (err) {
    console.warn(`asset_assignments could not be read (${err.code || err.message}); `
      + 'every asset will read as Current.');
  }
  const byAsset = new Map();
  for (const e of episodes) {
    if (!byAsset.has(e.asset_id)) byAsset.set(e.asset_id, []);
    byAsset.get(e.asset_id).push({ id: e.id, active: e.ended_at === null, endedAt: e.ended_at });
  }
  for (const a of assets) a.assignments = byAsset.get(a.id) || [];

  const report = tabAudit(assets);
  console.log(`${report.assets} asset(s), ${report.total} round(s), in this database.\n`);
  for (const rule of TAB_RULES) {
    console.log(`  ${rule.id.padEnd(9)} ${String(report.counts[rule.id]).padStart(5)}   (${rule.describe})`);
  }
  console.log(`  ${'total'.padEnd(9)} ${String(report.sums ? report.total : '??').padStart(5)}`);

  // The combinations actually present, so a status/round pair nobody thought
  // about is visible even when it is landing somewhere reasonable.
  const seen = new Map();
  for (const row of listRows(assets)) {
    const round = (row.ep && !row.ep.active) ? 'Handed On' : 'Current';
    const key = `${row.a.status} / ${round}`;
    if (!seen.has(key)) seen.set(key, { n: 0, tab: rowTabOf(row) });
    seen.get(key).n += 1;
  }
  console.log('\nStatus / Round combinations present:');
  for (const [key, v] of [...seen].sort()) {
    console.log(`  ${key.padEnd(38)} ${String(v.n).padStart(5)}  -> ${v.tab}`);
  }

  if (!report.sums) {
    console.error('\nThe tab counts do not add up to the number of rounds.');
  }
  if (report.problems.length) {
    console.error(`\n${report.problems.length} round(s) land in the wrong number of tabs:`);
    for (const p of report.problems) {
      console.error(`  ${p.code}  status=${p.status}  round=${p.round}  tabs=[${p.tabs.join(', ')}]`);
    }
    return 1;
  }
  console.log('\nEvery round lands in exactly one tab.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err.stack || err.message); process.exit(2); });
