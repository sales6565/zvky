/* THE BACKUP SCREEN'S API.
 *
 * ===========================================================================
 * THE FOUR RULES EVERY ROUTE HERE OBEYS, AND WHY EACH IS NOT NEGOTIABLE.
 *
 * 1. TWO PERMISSIONS, NOT ONE. backup.manage creates, verifies, deletes and
 *    schedules; backup.download takes a copy off the server. Separate because
 *    the second is the act that moves every password hash in the studio onto a
 *    laptop, and a studio can reasonably allow the first without it.
 *
 * 2. THE PASSWORD AGAIN, SERVER-SIDE, for create and download. See
 *    src/step-up.js for exactly what that buys and what it does not.
 *
 * 3. NO PATH EVER COMES FROM A REQUEST. The URL carries a backup ID; the row
 *    carries the filename; src/backup-storage.js resolveName() turns that into
 *    a path and refuses anything with a directory part. Three independent
 *    reasons a traversal cannot happen, and the tests push ../ at all of them.
 *
 * 4. EVERYTHING IS AUDITED AND THE PASSPHRASE NEVER IS. Create, download,
 *    verify, delete and every schedule change write an Activity Log entry with
 *    who and what. The passphrase is read from the body, used, and dropped; it
 *    is not logged, not audited, not echoed and not stored.
 *
 * ===========================================================================
 * WHY CREATE RETURNS BEFORE THE BACKUP IS FINISHED.
 *
 * Passenger on shared hosting will time out a request that takes minutes, and a
 * backup of a real studio takes minutes. So POST /create claims the lock,
 * starts the work WITHOUT awaiting it, and answers with the backup's id. The
 * screen then polls GET /:id, which reads the stage and percent the engine
 * writes to the row as it goes.
 *
 * THAT IS ALSO WHAT MAKES IT SURVIVE A RESTART. The work is not tied to the
 * request, so nothing is cancelled when the browser goes away — and if
 * Passenger stops the process mid-backup, the row is left `running` with a cold
 * heartbeat and the migration's sweep marks it failed on the next start. The
 * lock releases itself; nothing has to be cleaned up by hand.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const backup = require('../backup');
const settings = require('../backup-settings');
const storage = require('../backup-storage');
const stepUp = require('../step-up');
const db = require('../db');

const router = asyncRouter();

router.use(authenticate);

/* ========================================================================== */
/* status and list — behind backup.manage                                      */
/* ========================================================================== */

/* GET /api/backups — the whole screen in one request.
 *
 * The list, the last good backup and its age, whether one is running, the
 * schedule, the folder's health and the warning threshold. One request because
 * the screen needs all of it to draw anything, and because a screen that
 * assembles itself from five endpoints shows four states that disagree.
 */
router.get('/', requirePermission('backup.manage'), async (req, res) => {
  const [rows, last, inProgress, schedule] = await Promise.all([
    backup.list(db, { limit: 50 }),
    backup.lastGood(db),
    backup.running(db),
    settings.current(db),
  ]);
  const here = storage.status({ refresh: true });
  const free = storage.freeBytes(here.dir);

  res.json({
    backups: rows,
    last: {
      exists: last.exists,
      at: last.at,
      size: last.size,
      ageDays: last.ageDays,
      /* THE RED WARNING'S ONE DEFINITION, computed here so the screen, the
         doctor and the daily notice cannot disagree about when to worry. */
      stale: !last.exists || last.ageDays >= STALE_DAYS,
      staleAfterDays: STALE_DAYS,
    },
    running: inProgress,
    schedule,
    storage: {
      dir: here.dir,
      source: here.source,
      ok: here.ok,
      problems: here.problems,
      envName: here.envName,
      hint: here.hint,
      freeBytes: free,
      freeMb: free === null ? null : Math.floor(free / 1048576),
    },
    can: {
      download: Boolean(req.permissions && req.permissions.has('backup.download')),
    },
    /* The two sentences the screen must show, from the modules that own them, so
       the page cannot soften either. */
    warnings: {
      passphrase: require('../backup-crypto').LOST_PASSPHRASE_WARNING,
      offsite: 'A backup kept only on this server is not a safe backup. Download it and store it '
        + 'somewhere else — the disk, the account and the host are the three things most likely '
        + 'to take the application and its backups together.',
      scheduler: settings.STORED_PASSPHRASE_WARNING,
    },
  });
});

/* How old a backup has to be before the screen goes red. Seven days, which is
   the brief's figure and also the shipped default retention. */
const STALE_DAYS = 7;

/* GET /api/backups/:id — one backup, for the progress poll. */
router.get('/:id', requirePermission('backup.manage'), async (req, res) => {
  const row = await backup.get(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'That backup is not in the list.' });
  res.json({ backup: row });
});

/* ========================================================================== */
/* create                                                                      */
/* ========================================================================== */

router.post('/', requirePermission('backup.manage'), async (req, res) => {
  const body = req.body || {};

  /* THE STEP-UP FIRST, before anything is checked or claimed: a wrong password
     must not be able to tell you whether the disk is full. */
  const confirmed = await stepUp.verify(db, req.user, body.password);
  if (!confirmed.ok) {
    req.activitySkip();
    return res.status(confirmed.status).json({ error: confirmed.error, field: confirmed.field });
  }

  const passphrase = String(body.passphrase || '');
  const confirm = String(body.passphraseConfirm === undefined ? passphrase : body.passphraseConfirm);
  if (passphrase !== confirm) {
    req.activitySkip();
    return res.status(400).json({
      error: 'The two passphrases do not match. Type it again — a package encrypted with a '
        + 'passphrase you mistyped cannot be opened by the one you meant.',
      field: 'passphraseConfirm',
    });
  }

  /* NO UNENCRYPTED PACKAGE FROM THE WEB AT ALL. The brief allows one only
     through the CLI with an explicit flag, and that asymmetry is deliberate: a
     tick box on a screen is a thing somebody clicks without reading, and the
     result is every password hash in the studio in a file anybody can open. */
  const strong = require('../backup-crypto').strength(passphrase);
  if (!strong.ok) {
    req.activitySkip();
    return res.status(400).json({ error: strong.message, field: 'passphrase' });
  }

  let id;
  try {
    /* THE LOCK IS CLAIMED SYNCHRONOUSLY, inside the request, so two people
       pressing the button at once get one backup and one clear refusal rather
       than two backups and a race. */
    id = await backup.claim(db, {
      trigger: 'manual', userId: req.user.id, label: req.user.name, encrypted: true,
    });
  } catch (err) {
    req.activitySkip();
    const status = err.code === 'BACKUP_BUSY' ? 409 : 500;
    return res.status(status).json({ error: err.message, code: err.code || null });
  }

  req.activity({
    module: 'settings',
    action: 'backup.create',
    entityType: 'backup',
    entityId: id,
    entityLabel: 'Backup',
    summary: `${req.user.name} started a backup${body.includeSecrets ? ' with the secrets bundle' : ''}`,
    /* NO PASSPHRASE, NOT EVEN ITS LENGTH. What is recorded is that an encrypted
       backup was started and whether it includes the secrets bundle. */
    changes: {
      encrypted: { from: null, to: 'yes' },
      secretsBundle: { from: null, to: body.includeSecrets ? 'included' : 'not included' },
    },
  });

  /* THE WORK, DETACHED. Not awaited, so the response goes now and Passenger
     cannot time the request out; the engine writes its progress to the row and
     the screen polls for it. runWith() takes the id the lock already claimed. */
  runDetached(id, {
    passphrase,
    includeSecrets: Boolean(body.includeSecrets),
    userId: req.user.id,
    userLabel: req.user.name,
  });

  res.status(202).json({
    ok: true,
    id,
    summary: 'The backup has started. It keeps going if you close this page; come back to this '
      + 'screen to see how it got on.',
  });
});

/* The detached half of create.
 *
 * The lock row already exists, so this calls the engine's internals rather than
 * create() — which would claim a second lock and refuse itself. The engine
 * exposes runClaimed() for exactly this.
 */
function runDetached(id, opts) {
  backup.runClaimed(db, id, opts).catch((err) => {
    /* ALREADY RECORDED ON THE ROW by the engine; this is only so a crash is not
       an unhandled rejection that takes the process with it. */
    console.warn(`[backup] ${id} failed: ${err.message}`);
  });
}

/* ========================================================================== */
/* verify                                                                      */
/* ========================================================================== */

/* POST /api/backups/:id/verify — read the package back and check every hash.
 *
 * NEEDS THE PASSPHRASE, and that is not an oversight: verifying an encrypted
 * package means decrypting it, and nothing on this server knows the passphrase
 * of a manual backup. A screen that offered "verify" without asking would be
 * offering to check the one thing it cannot check.
 */
router.post('/:id/verify', requirePermission('backup.manage'), async (req, res) => {
  const row = await backup.get(db, req.params.id);
  if (!row) { req.activitySkip(); return res.status(404).json({ error: 'That backup is not in the list.' }); }
  if (!row.filename) {
    req.activitySkip();
    return res.status(409).json({ error: 'That backup has no file — it failed before one was written.' });
  }
  if (row.encrypted && !String((req.body || {}).passphrase || '')) {
    req.activitySkip();
    return res.status(400).json({
      error: 'That package is encrypted. Type its passphrase to check it.',
      field: 'passphrase',
    });
  }

  let file;
  try {
    file = storage.resolveName(row.filename);
  } catch (err) {
    req.activitySkip();
    return res.status(409).json({ error: err.message, code: err.code });
  }
  if (!fs.existsSync(file)) {
    await db.query(
      `UPDATE backups SET status = 'failed', error = $1 WHERE id = $2`,
      ['The package file is no longer in the backup folder.', row.id]
    );
    req.activity({
      module: 'settings', action: 'backup.verify', entityType: 'backup', entityId: row.id,
      entityLabel: row.filename, summary: `${req.user.name} checked a backup: the file is missing`,
    });
    return res.status(404).json({ error: 'The package file is no longer in the backup folder.' });
  }

  const verdict = await backup.verifyFile(file, { passphrase: (req.body || {}).passphrase });
  await db.query(
    `UPDATE backups SET status = $1, error = $2 WHERE id = $3`,
    [verdict.ok ? 'verified' : 'failed', verdict.ok ? null : String(verdict.error).slice(0, 500), row.id]
  );

  req.activity({
    module: 'settings', action: 'backup.verify', entityType: 'backup', entityId: row.id,
    entityLabel: row.filename,
    summary: `${req.user.name} checked ${row.filename}: ${verdict.ok ? 'every part matched' : 'FAILED'}`,
    changes: { status: { from: row.status, to: verdict.ok ? 'verified' : 'failed' } },
  });

  if (!verdict.ok) {
    return res.status(422).json({ ok: false, error: verdict.error, code: verdict.code || null });
  }
  res.json({
    ok: true,
    parts: verdict.parts,
    summary: `Read the package back and checked all ${verdict.parts} parts against the manifest. `
      + 'It opens and it is intact.',
  });
});

/* ========================================================================== */
/* download                                                                    */
/* ========================================================================== */

/* GET is not used for this, and that is a decision rather than an inconvenience.
 *
 * The step-up password has to reach the server, and a password in a query string
 * lands in the access log, the browser's history and any proxy in between. So
 * the download is a POST whose body carries the password and whose response is
 * the file. The page builds it with fetch() and a blob rather than a link.
 */
router.post('/:id/download', requirePermission('backup.download'), async (req, res) => {
  const confirmed = await stepUp.verify(db, req.user, (req.body || {}).password);
  if (!confirmed.ok) {
    req.activitySkip();
    return res.status(confirmed.status).json({ error: confirmed.error, field: confirmed.field });
  }

  const row = await backup.get(db, req.params.id);
  if (!row || !row.filename) {
    req.activitySkip();
    return res.status(404).json({ error: 'That backup is not in the list.' });
  }

  let file;
  try {
    file = storage.resolveName(row.filename);
  } catch (err) {
    req.activitySkip();
    return res.status(409).json({ error: err.message, code: err.code });
  }

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    req.activitySkip();
    return res.status(404).json({ error: 'The package file is no longer in the backup folder.' });
  }

  req.activity({
    module: 'settings', action: 'backup.download', entityType: 'backup', entityId: row.id,
    entityLabel: row.filename,
    summary: `${req.user.name} downloaded ${row.filename} (${Math.round(stat.size / 1048576)} MB)`,
    changes: { downloaded: { from: null, to: row.filename } },
  });

  /* THE HEADERS, EACH FOR A REASON.
   *
   * attachment      so a browser saves it rather than trying to render a
   *                 20 MB binary
   * nosniff         so nothing downstream guesses a type from the bytes
   * no-store        a package must not sit in a proxy cache or the browser's
   *                 disk cache, which is somewhere nobody thinks to clear
   * Content-Length  so the browser can show real progress on a long download
   */
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Length', String(stat.size));

  /* STREAMED, NEVER BUFFERED. A 20 MB read into memory on shared hosting is a
     restart; a 2 GB one is a restart on any hosting. */
  const stream = fs.createReadStream(file);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
});

/* ========================================================================== */
/* delete                                                                      */
/* ========================================================================== */

router.delete('/:id', requirePermission('backup.manage'), async (req, res) => {
  const row = await backup.get(db, req.params.id);
  if (!row) { req.activitySkip(); return res.status(404).json({ error: 'That backup is not in the list.' }); }

  const result = await backup.remove(db, req.params.id);
  if (!result.ok) {
    req.activitySkip();
    return res.status(result.status).json({ error: result.error });
  }

  req.activity({
    module: 'settings', action: 'backup.delete', entityType: 'backup', entityId: row.id,
    entityLabel: row.filename || row.id,
    summary: `${req.user.name} deleted the backup ${row.filename || '(no file)'}`,
    changes: { backup: { from: row.filename || row.id, to: null } },
  });

  res.json({ ok: true, summary: `Deleted ${row.filename || 'that record'}.` });
});

/* ========================================================================== */
/* the schedule                                                                */
/* ========================================================================== */

router.put('/schedule', requirePermission('backup.manage'), async (req, res) => {
  const body = req.body || {};

  /* A SCHEDULE CHANGE IS A STEP-UP TOO when it touches the passphrase, because
     storing one is handing the server the key to every nightly package. The
     other fields — the hour, the keep count — are not worth a password. */
  if (body.passphrase !== undefined && String(body.passphrase || '') !== '') {
    const confirmed = await stepUp.verify(db, req.user, body.password);
    if (!confirmed.ok) {
      req.activitySkip();
      return res.status(confirmed.status).json({ error: confirmed.error, field: confirmed.field });
    }
  }

  const result = await settings.save(db, body, req.user);
  if (!result.ok) {
    req.activitySkip();
    return res.status(result.status).json({ error: result.error, field: result.field });
  }

  if (result.changes && Object.keys(result.changes).length) {
    req.activity({
      module: 'settings', action: 'backup.schedule', entityType: 'backup_schedule',
      entityId: 'schedule', entityLabel: 'Backup schedule',
      summary: `${req.user.name} changed the backup schedule`,
      /* The passphrase appears here as "set", never as a value or a length —
         result.changes is built that way in src/backup-settings.js. */
      changes: result.changes,
    });
  } else {
    req.activitySkip();
  }

  res.json({ ok: true, schedule: result.settings, summary: 'Saved.' });
});

module.exports = router;
