#!/usr/bin/env node
// Print an asset's raw database row, and everything that decides which column
// it is drawn in.
//
//   npm run asset:check -- FX-001
//   npm run asset:check -- FX-001 --repair
//
// This reads the same .env the app does, so run it on the machine the app runs
// on. Without --repair it changes nothing.
//
// Why this exists: "the assigned asset is in the wrong column" has three
// possible causes, and only the raw row can tell them apart — the assignee
// never saved, the assignee saved but the status transition did not, or both
// are right and the page is drawing it wrong. Guessing between them cost three
// rounds of fixes.

require('dotenv').config();
const db = require('../src/db');
const schemaCheck = require('../src/schema-check');
const workflow = require('../src/asset-workflow');

const args = process.argv.slice(2);
const repair = args.includes('--repair');
const code = args.find((a) => !a.startsWith('--'));

if (!code) {
  console.error('Usage: npm run asset:check -- FX-001 [--repair]');
  process.exit(1);
}

const pad = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);

(async () => {
  const { rows } = await db.query(
    `SELECT a.*, u.\`name\` AS assignee_name, r.\`name\` AS routed_name, p.\`name\` AS project_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.asset_id = a.id) AS task_count,
            (SELECT COUNT(*) FROM asset_events e WHERE e.asset_id = a.id) AS event_count
       FROM assets a
       LEFT JOIN users u ON u.id = a.assignee_id
       LEFT JOIN users r ON r.id = a.routed_to_id
       LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.\`code\` = $1`,
    [code]
  );

  if (!rows.length) {
    console.log(`No asset with code ${code}.`);
    await db.end();
    return;
  }

  for (const a of rows) {
    console.log(`\n=== ${a.code} — ${a.name}   (project: ${a.project_name})`);
    pad('id', a.id);
    pad('status', `${JSON.stringify(a.status)}   → column "${workflow.label(a.status)}"`);
    pad('assignee_id', a.assignee_id === null ? 'NULL' : `${a.assignee_id}  (${a.assignee_name || 'no such user'})`);
    pad('routed_to_id', a.routed_to_id === null ? 'NULL' : `${a.routed_to_id}  (${a.routed_name || 'no such user'})`);
    pad('created_by', a.created_by === null ? 'NULL' : a.created_by);
    pad('tasks', a.task_count);
    pad('history events', a.event_count);

    // The verdict, in the terms the last three rounds of debugging were about.
    const assigned = a.assignee_id !== null;
    if (assigned && a.status === 'not_started') {
      console.log('\n  >>> ASSIGNED BUT NOT TRANSITIONED.');
      console.log('      The assignee saved and the status did not. This is a backend fault, not a');
      console.log('      rendering one — the dashboard is drawing exactly what it was given.');
      if (Number(a.task_count) === 0) {
        console.log('      Zero tasks as well: this asset was created by a request that failed');
        console.log('      part-way through, before the default checklist was written.');
      }
    } else if (assigned) {
      console.log(`\n  >>> Consistent: assigned, and status is ${JSON.stringify(a.status)}.`);
      console.log('      If the dashboard still shows it elsewhere, the fault is in the page.');
    } else {
      console.log('\n  >>> No assignee. "Not Assigned" is correct for this row.');
    }

    if (repair && assigned && a.status === 'not_started') {
      await db.query(
        "UPDATE assets SET `status` = 'assigned', routed_to_id = COALESCE(routed_to_id, assignee_id) WHERE id = $1",
        [a.id]
      );
      const { rows: after } = await db.query('SELECT `status`, routed_to_id FROM assets WHERE id = $1', [a.id]);
      console.log(`\n  repaired → status=${JSON.stringify(after[0].status)} routed_to_id=${after[0].routed_to_id || 'NULL'}`);
    }
  }

  // The schema, because a stale status constraint is what breaks the write.
  const gaps = await schemaCheck.gaps(db);
  console.log('\n=== schema');
  if (!gaps.length) {
    console.log('  Nothing missing. Every table, column and constraint this build needs is present.');
  } else {
    console.log('  *** These are missing or stale, and are the most likely cause: ***');
    for (const g of gaps) console.log(`    ${g.kind} ${g.name} — ${g.detail}  (step: ${g.step})`);
  }

  // Every status constraint on the table, whatever it is called — the check
  // that reads only chk_assets_status is what let a broken database look fine.
  const cons = await db.query(
    `SELECT cc.CONSTRAINT_NAME AS n, cc.CHECK_CLAUSE AS c
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_NAME = 'assets' AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND tc.CONSTRAINT_SCHEMA = DATABASE()`
  ).catch(() => ({ rows: null }));
  console.log('\n=== every CHECK constraint on assets');
  if (!cons.rows) {
    console.log('  This database will not report its constraints.');
  } else if (!cons.rows.length) {
    console.log('  None.');
  } else {
    for (const c of cons.rows) {
      const clause = String(c.c || '');
      const relevant = /\bstatus\b/i.test(clause) && clause.includes("'not_started'");
      const verdict = !relevant ? '' : clause.includes("'assigned'")
        ? "   OK — admits 'assigned'"
        : "   *** REJECTS 'assigned' — this is what breaks assignment ***";
      console.log(`  ${c.n}${verdict}`);
      if (relevant) console.log(`      ${clause}`);
    }
  }

  // And the damage that kind of failure leaves behind, across the whole table.
  const { rows: stuck } = await db.query(
    "SELECT COUNT(*) AS n FROM assets WHERE assignee_id IS NOT NULL AND `status` = 'not_started'"
  );
  console.log('\n=== across every project');
  console.log(`  ${stuck[0].n} asset(s) have an assignee and still read Not Assigned.`);
  if (Number(stuck[0].n)) {
    console.log('  Restarting the app repairs these — the "assigned backfill" migration step moves');
    console.log('  them, once the status constraint admits \'assigned\'. Fix the constraint first.');
  }

  await db.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
