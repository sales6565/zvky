#!/usr/bin/env node
/* WHICH ALREADY-FILED TIMESHEET LINES WERE WORKED OUT THE OLD WAY.
 *
 * Existing lines are NOT rewritten. A filed timesheet is a record of what
 * somebody claimed and what may already have been paid, so a migration that
 * silently restated the figures would be editing history rather than fixing a
 * calculation. This answers the other question instead: how many look affected,
 * and which.
 *
 *     node scripts/check-timesheet-day-figures.js            # counts
 *     node scripts/check-timesheet-day-figures.js --lines     # one row each
 *
 * WHAT COUNTS AS AFFECTED. A line's figure could only have been wrong if the
 * apportionment it was computed by could have been wrong, and that needs one of
 * two things to be true of the sessions behind it:
 *
 *   A PRE-CUTOVER SESSION — ended_reason IS NULL. src/migrate.js says those rows
 *      hold a different meaning of `seconds` and were deliberately not
 *      backfilled. Apportioning one divides a wall clock by working weights.
 *   A SESSION SPANNING MORE THAN ONE IST DAY. A row inside one day took the
 *      whole of its own `seconds` and was right whatever that column held; only
 *      a crossing row was divided.
 *
 * A line with neither was right before this change and is right after it. That
 * is why the count is usually small.
 *
 * IT RECALCULATES RATHER THAN GUESSING. For each candidate the rule is run and
 * the answer compared with the stored hours, so the output is "this line says
 * 5.00 and the day is worth 1.50" rather than "this line is suspicious".
 *
 * READ ONLY. Nothing here writes.
 */
const db = require('../src/db');
const workLog = require('../src/work-log');
const workSchedule = require('../src/work-schedule');
const holidays = require('../src/holidays');
const referenceData = require('../src/reference-data');
const recordingHours = require('../src/recording-hours');

const LINES = process.argv.includes('--lines');
const IST = 330;

/* The candidate set, in one query. The day bounds are IST, the same +330 every
   other query in this application uses — see src/follow-up.js for why. */
const CANDIDATES = `
  SELECT e.id, e.user_id, e.asset_id, e.entry_date, e.hours,
         u.name AS person, a.code AS asset_code,
         SUM(w.ended_reason IS NULL) AS pre_cutover,
         SUM(DATE(DATE_ADD(w.started_at, INTERVAL ${IST} MINUTE))
             <> DATE(DATE_ADD(COALESCE(w.ended_at, NOW()), INTERVAL ${IST} MINUTE))) AS crossing
    FROM timesheet_entries e
    JOIN work_sessions w
      ON w.asset_id = e.asset_id AND w.user_id = e.user_id
   LEFT JOIN users u ON u.id = e.user_id
   LEFT JOIN assets a ON a.id = e.asset_id
   WHERE e.asset_id IS NOT NULL
     AND DATE(DATE_ADD(w.started_at, INTERVAL ${IST} MINUTE)) <= e.entry_date
     AND DATE(DATE_ADD(COALESCE(w.ended_at, NOW()), INTERVAL ${IST} MINUTE)) >= e.entry_date
   GROUP BY e.id, e.user_id, e.asset_id, e.entry_date, e.hours, u.name, a.code
  HAVING pre_cutover > 0 OR crossing > 0
   ORDER BY e.entry_date, person`;

const iso = (d) => (d instanceof Date
  ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  : String(d).slice(0, 10));

(async () => {
  // The mirrors the schedule reads, loaded the way the server loads them.
  await referenceData.load(db).catch(() => {});
  await recordingHours.load(db).catch(() => {});
  await holidays.load(db).catch(() => {});
  await workSchedule.load(db).catch(() => {});
  const sched = workSchedule.trackingWindow();
  const show = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const { rows: filed } = await db.query(
    'SELECT COUNT(*) AS n FROM timesheet_entries WHERE asset_id IS NOT NULL');
  const { rows } = await db.query(CANDIDATES);

  console.log('The schedule these figures are recalculated under:');
  console.log(`  day ${show(sched.dayStart)}-${show(sched.dayEnd)}  `
    + `working days ${sched.workingDays.join(',')}  `
    + `breaks ${(sched.breaks || []).map((b) => `${b.label} ${show(b.start)}-${show(b.end)}`).join(', ') || 'none'}  `
    + `holidays ${(sched.holidays || []).length}`);
  console.log('  (the schedule keeps no history, so this is TODAY\'s — see the README)\n');
  console.log(`Timesheet lines naming an asset: ${Number(filed[0].n)}`);
  console.log(`Of those, lines whose sessions could have been apportioned: ${rows.length}\n`);

  let differ = 0;
  const detail = [];
  for (const row of rows) {
    const day = iso(row.entry_date);
    const now = Date.now();
    const figure = await workLog.dayTotalFor(db, {
      assetId: row.asset_id, userId: row.user_id, day, now,
    });
    const nowHours = Math.round((figure.seconds / 3600) * 100) / 100;
    const was = Math.round(Number(row.hours) * 100) / 100;
    if (Math.abs(nowHours - was) >= 0.01) {
      differ += 1;
      detail.push({ day, person: row.person || row.user_id, asset: row.asset_code || row.asset_id,
        filed: was, now: nowHours,
        why: Number(row.pre_cutover) > 0 ? 'pre-cutover session' : 'session crossed a day' });
    }
  }

  console.log(`Lines whose stored hours differ from what the rule now says: ${differ}`);
  if (detail.length && LINES) {
    console.log('\n  date        person                asset       filed     now  why');
    for (const d of detail) {
      console.log(`  ${d.day}  ${String(d.person).padEnd(20).slice(0, 20)}  `
        + `${String(d.asset).padEnd(10).slice(0, 10)}  ${String(d.filed).padStart(5)}  `
        + `${String(d.now).padStart(6)}  ${d.why}`);
    }
  } else if (detail.length) {
    console.log('  Run again with --lines to see them.');
  }
  if (!differ) {
    console.log('  Nothing to review: every filed line already matches the rule.');
  } else {
    console.log('\nNOTHING HAS BEEN CHANGED. A filed line is a record of what somebody claimed.');
    console.log('Re-file a line by deleting it and adding it again on the day it belongs to,');
    console.log('which is what the Activity Log will then show.');
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
