#!/usr/bin/env node
/* IS THIS INSTALLATION ACTUALLY BACKED UP? Run it and find out in ten seconds.
 *
 *   npm run backup:check
 *   npm run backup:check -- --json      (for a monitor or a cron line)
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT JUST THE SETTINGS SCREEN.
 *
 * The Settings screen answers this for somebody who is already logged in,
 * already holds backup.manage, and has thought to go and look. The two
 * situations where the answer matters most are neither:
 *
 *   - setting the thing up, where the question is "did BACKUP_DIR take?" and
 *     the person is in an SSH session with no browser;
 *   - a monitor, where nobody is looking at all and the answer has to arrive
 *     as an exit status.
 *
 * So: exit 0 when the installation is backed up, 1 when it is not, 2 when the
 * check itself could not run. Everything it prints is also in --json.
 *
 * ===========================================================================
 * READ-ONLY AND SAFE TO RUN ON PRODUCTION. It reads four things — the folder,
 * the free space, the backups table and the schedule row — and writes nothing.
 * It does not open a package, so it needs no passphrase and cannot be used to
 * get at the contents of one.
 */
const db = require('../src/db');
const backup = require('../src/backup');
const storage = require('../src/backup-storage');
const settings = require('../src/backup-settings');

/* The same seven days the Settings screen goes red at and the daily notice
   fires on. Imported rather than repeated, so the three cannot disagree about
   when to worry. */
const { STALE_DAYS } = require('../src/backup-scheduler');

const json = process.argv.includes('--json');
const MB = (n) => (n === null || n === undefined ? null : Math.floor(Number(n) / 1048576));

const checks = [];
function check(name, ok, detail, fix) {
  checks.push({ name, ok, detail, fix: fix || null });
}

(async () => {
  /* ---- 1. the folder ---------------------------------------------------- */
  const here = storage.status({ refresh: true });
  check('backup folder', here.ok,
    here.ok
      ? `${here.dir} (${here.source === 'env' ? `${here.envName} is set` : `${here.envName} is NOT set — this is a fall-back`})`
      : here.problems.map((p) => p.message).join(' '),
    here.ok && here.source !== 'env'
      ? `Set ${here.envName} explicitly in .env, so a deploy cannot move it: ${here.hint || ''}`
      : (here.ok ? null : 'Fix the folder before anything else — nothing can be written until it is usable.'));

  /* ---- 2. room to write one --------------------------------------------- */
  if (here.ok) {
    const free = storage.freeBytes(here.dir);
    let want = null;
    try {
      const sized = await backup.estimate(db);
      want = sized.bytes * 2;                 // the dump is written out before it is packed
    } catch { /* the estimate needs the database; section 4 reports that */ }
    const enough = free === null || want === null ? null : free >= want;
    check('disk space',
      enough === null ? true : enough,
      free === null ? 'this filesystem does not report free space'
        : `${MB(free)} MB free${want === null ? '' : `, a backup needs about ${MB(want)} MB`}`,
      enough === false ? 'Delete an old package, lower "keep the newest" in Settings → Backup, or move them off this server.' : null);
  }

  /* ---- 3. is there a recent one ----------------------------------------- */
  let last = null;
  try {
    last = await backup.lastGood(db);
    check('a recent backup', last.exists && last.ageDays < STALE_DAYS,
      last.exists
        ? `the last verified package is ${last.ageDays === 0 ? 'from today' : `${last.ageDays} day(s) old`}`
          + ` — ${last.filename}, ${MB(last.size)} MB`
        : 'there has never been one',
      last.exists && last.ageDays >= STALE_DAYS
        ? `More than ${STALE_DAYS} days. Take one: npm run backup`
        : (last.exists ? null : 'Take one now: npm run backup'));
  } catch (err) {
    check('a recent backup', false, `the backups table could not be read: ${err.message}`,
      'Start the application once — src/migrate.js creates the table at boot.');
  }

  /* ---- 4. the schedule --------------------------------------------------- */
  try {
    const sch = await settings.current(db);
    const running = sch.scheduleEnabled && sch.passphraseSet;
    check('the schedule',
      /* NOT A FAILURE WHEN IT IS OFF, and that is deliberate. A studio running
         `npm run backup` from cron is correctly backed up and has the schedule
         off on purpose — the README recommends exactly that on a host that
         suspends an idle application. What IS a failure is a schedule switched
         on that cannot run, because that one looks like it is working. */
      sch.scheduleEnabled ? running : true,
      sch.scheduleEnabled
        ? (running
            ? `on, ${sch.frequency}, at ${String(sch.hour).padStart(2, '0')}:${String(sch.minute).padStart(2, '0')}, keeping ${sch.keepLast}`
              + (sch.lastRunAt ? ` — last ran ${new Date(sch.lastRunAt).toISOString()}` : ' — has not run yet')
            : 'ON, BUT NO PASSPHRASE IS STORED, so every nightly run refuses')
        : 'off — take them from cron, or switch it on in Settings → Backup',
      sch.scheduleEnabled && !running
        ? 'Set the passphrase in Settings → Backup, or switch the schedule off and use cron.'
        : null);
  } catch (err) {
    check('the schedule', false, `the settings row could not be read: ${err.message}`, null);
  }

  /* ---- 5. anything stuck ------------------------------------------------- */
  try {
    const inFlight = await backup.running(db);
    if (inFlight) {
      check('nothing stuck', true, `one is running now — ${inFlight.stage} ${inFlight.percent}%`, null);
    }
  } catch { /* already reported above */ }

  const ok = checks.every((c) => c.ok);

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok,
      staleAfterDays: STALE_DAYS,
      last: last ? { exists: last.exists, at: last.at, ageDays: last.ageDays, sizeMb: MB(last.size) } : null,
      checks,
    })}\n`);
  } else {
    process.stdout.write('\n');
    for (const c of checks) {
      process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(16)}  ${c.detail}\n`);
      if (c.fix) process.stdout.write(`                          -> ${c.fix}\n`);
    }
    process.stdout.write(ok
      ? '\n  This installation is backed up.\n\n'
      : '\n  THIS INSTALLATION IS NOT RELIABLY BACKED UP. See the lines marked FAIL.\n\n');
    if (ok && last && last.exists) {
      process.stdout.write('  A backup kept only on this server is not a safe backup: this script cannot\n'
        + '  tell whether a copy exists anywhere else, and that is the half that matters.\n\n');
    }
  }

  await db.end().catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch(async (err) => {
  process.stderr.write(`The backup check could not run: ${err.message}\n`);
  await db.end().catch(() => {});
  process.exit(2);
});
