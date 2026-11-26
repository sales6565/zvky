/* THE NIGHTLY BACKUP, AND WHY IT CANNOT RUN TWICE.
 *
 * ===========================================================================
 * THE SHAPE OF EVERY SCHEDULE IN THIS APPLICATION, AND WHAT THIS ONE ADDS.
 *
 * The existing sweeps — the chat attachment sweep, the email outbox, the start
 * reminders, the working-hours tick — are all setInterval over a function that
 * decides whether there is anything to do. This is the same, with one extra
 * requirement that none of them has: running twice must be impossible, not
 * merely unlikely.
 *
 * A duplicate chat sweep deletes nothing twice. A duplicate backup writes a
 * second 20 MB package, holds the lock while it does it, and on a shared host
 * with a 1 GB quota that is the difference between a full disk and a working
 * studio. Passenger also runs MORE THAN ONE PROCESS, each with its own timer,
 * each waking a second apart — so "check whether the last run was today" is
 * answered yes by both of them.
 *
 * SO THE SLOT IS CLAIMED IN THE DATABASE, with a conditional UPDATE, before any
 * work starts. See claimSlot() in src/backup-settings.js: exactly one caller
 * changes a row, the other gets zero rows affected and stands down. The
 * database is the only arbiter the two processes share, and this is the one
 * question it can answer for both.
 *
 * THE LOCK IS SEPARATE AND ALSO APPLIES. claimSlot stops two SCHEDULED runs in
 * one slot; the engine's `running` row stops a scheduled run colliding with a
 * manual one. Both are needed: they answer different questions.
 *
 * ===========================================================================
 * WHAT HAPPENS WHEN IT FAILS, which is most of what a scheduler is for.
 *
 * A failed scheduled backup is the most dangerous kind of silence in this
 * feature: everybody believes there is a backup, and there is not. So a failure
 * raises the in-app notice to every holder of backup.manage — through the same
 * notification path everything else uses — and the row keeps the reason where
 * the Settings screen shows it.
 *
 * THE SLOT IS STILL CONSUMED BY A FAILED RUN, and that is deliberate. Retrying
 * every minute until midnight would turn one failure into a hundred, each
 * writing a partial package and each raising a notice. One attempt per slot,
 * one notice, and the owner decides.
 */
const backup = require('./backup');
const settings = require('./backup-settings');
const storage = require('./backup-storage');
const notifications = require('./notifications');
const rolePermissions = require('./role-permissions');

/* How often the tick asks. Five minutes: fine enough that "02:00" happens
   within five minutes of two, coarse enough to be invisible. */
const TICK_MINUTES = Number(process.env.BACKUP_TICK_MINUTES || 5);

/* Who is told when something goes wrong, or when no backup has been taken for a
 * week: every holder of backup.manage.
 *
 * ASKED OF THE PERMISSION, not of a tier or a role list, so a studio that has
 * granted the key to its systems person through a role group tells that person
 * too. rolePermissions.usersWithPermission is the existing way to ask.
 */
async function managers(db) {
  try {
    return await rolePermissions.usersWithPermission(db, 'backup.manage');
  } catch {
    return [];
  }
}

async function tell(db, { detail }) {
  const people = await managers(db);
  for (const person of people) {
    const id = person.id || person;
    await notifications.raise(db, {
      recipientId: id,
      actorId: null,
      kind: notifications.KINDS.backup,
      detail,
    }).catch(() => { /* a notice that cannot be raised must not fail the sweep */ });
  }
  return people.length;
}

/* ===========================================================================
 * ONE TICK.
 *
 * Exported and tested directly, because a scheduler that can only be observed
 * by waiting for a timer is a scheduler nobody tests. Returns what it decided,
 * so a test can assert "it stood down because the slot was taken" rather than
 * just "nothing happened".
 */
async function tick(db, { now = new Date(), env = process.env } = {}) {
  const current = await settings.current(db);
  const verdict = settings.due(current, now);
  if (!verdict.due) return { ran: false, reason: verdict.reason, slot: verdict.slot || null };

  /* THE FOLDER, CHECKED BEFORE THE SLOT IS SPENT. A misconfigured folder is
     not this slot's fault and will still be wrong tomorrow, so it raises the
     notice without consuming the slot — otherwise the owner fixes the folder
     at nine and gets no backup until the following night. */
  const here = storage.status({ refresh: true });
  if (!here.ok) {
    await tell(db, {
      detail: 'A scheduled backup could not start: the backup folder is not usable. '
        + here.problems.map((p) => p.message).join(' '),
    });
    return { ran: false, reason: 'the backup folder is not usable', slot: verdict.slot };
  }

  /* THE SLOT, CLAIMED BEFORE ANY WORK. Exactly one process gets true. */
  const mine = await settings.claimSlot(db, verdict.slot);
  if (!mine) return { ran: false, reason: 'another process took this slot', slot: verdict.slot };

  const passphrase = await settings.passphraseForScheduler(db);
  if (!passphrase) {
    await tell(db, {
      detail: 'A scheduled backup could not start: the stored passphrase could not be read. '
        + 'If EMAIL_ENCRYPTION_KEY has changed, set the passphrase again in Settings → Backup.',
    });
    return { ran: false, reason: 'the stored passphrase could not be read', slot: verdict.slot };
  }

  try {
    const made = await backup.create(db, {
      passphrase,
      encrypt: true,
      includeSecrets: current.includeSecrets,
      trigger: 'scheduled',
      userId: null,
      userLabel: 'the schedule',
      keepLast: current.keepLast,
      env,
    });
    return { ran: true, slot: verdict.slot, id: made.id, filename: made.filename, size: made.size };
  } catch (err) {
    /* THE ONE FAILURE NOBODY WOULD OTHERWISE SEE. The row carries the reason
       already; this is what puts it in front of a person. */
    await tell(db, {
      detail: `The scheduled backup failed: ${String(err.message || err).slice(0, 300)}`,
    });
    return { ran: false, reason: String(err.message || err), slot: verdict.slot, failed: true };
  } finally {
    /* THE PASSPHRASE GOES OUT OF SCOPE HERE and is not logged, audited or
       returned anywhere above. */
  }
}

/* ===========================================================================
 * THE DAILY "no recent backup" NOTICE.
 *
 * Separate from the schedule, because it matters MOST to a studio that has not
 * switched the schedule on: the whole point is to tell somebody that nothing is
 * backing this up. Once a day, to the same audience.
 *
 * ONCE A DAY IS ENFORCED BY THE SLOT MECHANISM AGAIN, reusing last_run_slot's
 * sibling rather than inventing a second one: the notice's own slot is written
 * into the same row under a different prefix.
 */
const STALE_DAYS = 7;

async function remind(db, { now = new Date() } = {}) {
  const last = await backup.lastGood(db);
  if (last.exists && last.ageDays < STALE_DAYS) return { told: 0, reason: 'a recent backup exists' };

  const pad = (n) => String(n).padStart(2, '0');
  const slot = `remind-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const { result } = await db.query(
    `UPDATE backup_settings SET last_reminder_slot = $1
      WHERE id = 1 AND (last_reminder_slot IS NULL OR last_reminder_slot <> $1)`,
    [slot]
  ).catch(() => ({ result: null }));
  if (!result || !result.affectedRows) return { told: 0, reason: 'already told today' };

  const told = await tell(db, {
    detail: last.exists
      ? `The last verified backup is ${last.ageDays} days old. Take one in Settings → Backup, and `
        + 'download it — a backup kept only on this server is not a safe backup.'
      : 'No backup of Forge has ever been taken. Settings → Backup takes one; download it and keep '
        + 'it somewhere other than this server.',
  });
  return { told, slot };
}

/* The timer, started by the server the way every other sweep is. */
function start(db, { log = console.log } = {}) {
  if (TICK_MINUTES <= 0) {
    log('[backup] the scheduler tick is switched off (BACKUP_TICK_MINUTES=0).');
    return null;
  }
  const run = async () => {
    try {
      const result = await tick(db);
      if (result.ran) log(`[backup] scheduled backup ${result.filename} written (${result.slot}).`);
      else if (result.failed) log(`[backup] scheduled backup failed: ${result.reason}`);
      await remind(db);
    } catch (err) {
      log(`[backup] the scheduler tick failed: ${err.message}`);
    }
  };
  const timer = setInterval(run, Math.max(1, TICK_MINUTES) * 60 * 1000);
  if (timer.unref) timer.unref();
  /* NOT RUN IMMEDIATELY AT BOOT. A restart loop would otherwise take a backup
     on every start, and the first tick is five minutes away at most. */
  return timer;
}

module.exports = { tick, remind, start, managers, TICK_MINUTES, STALE_DAYS };
