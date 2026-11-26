/* THE BACKUP ENGINE: one module, used by the Settings screen and by the CLI.
 *
 * ===========================================================================
 * WHAT A PACKAGE IS.
 *
 *   backup-<UTC timestamp>-<commit or version>.tar.gz[.enc]
 *
 *     manifest.json   format, versions, per-part sha256 and size, table row
 *                     counts, which parts are encrypted. NO secret values.
 *     code/app.tar    the deployed commit: `git archive` when git is there,
 *                     otherwise a tar of the app folder with the exclusions
 *                     below. package.json and the lockfile are always in it.
 *     database/dump.sql   src/sql-dump.js's output, taken in one consistent
 *                     snapshot while people keep working.
 *     files/...       the app's own stored files, paths preserved.
 *     config/environment.json   variable NAMES with set/unset, versions,
 *                     deploy notes. No values, ever.
 *     RESTORE.md      the steps, for somebody who has only this file.
 *     secrets.enc     OPTIONAL and only when the owner opts in: the .env
 *                     values, encrypted again under the same passphrase.
 *
 * TAR.GZ AND NOT ZIP because there is no archive library in this project's
 * dependencies and a native one has no business on shared hosting — the long
 * note at the top of src/tar-stream.js has the rest.
 *
 * ===========================================================================
 * THE ORDER OF OPERATIONS, WHICH IS WHERE THE CARE IS.
 *
 * 1. Refuse early. Invalid BACKUP_DIR, another backup running, or less than
 *    twice the estimated size free — each refuses before a byte is written,
 *    because the failure mode of finding out late is a half package and a full
 *    disk.
 * 2. Claim the lock by inserting the `running` row. The row IS the lock: see
 *    claim() for why that beats a lock file here.
 * 3. Dump the database to a temporary file inside the backup folder, hashing as
 *    it goes. To a file and not straight into the tar because tar needs the
 *    size in the header before the payload, and because the hash belongs in the
 *    manifest, which is written first.
 * 4. Collect the file list and the code archive the same way.
 * 5. Write the package: header, then tar → gzip → cipher → disk, manifest
 *    first so a reader can see what to expect.
 * 6. VERIFY by reading the package back: decrypt it, walk every entry, hash
 *    each one and compare against the manifest. Only then is the row marked
 *    `verified`. A backup nobody has read back is a hope, not a backup.
 * 7. Prune, to the configured count, deleting only files this table names.
 *
 * ===========================================================================
 * WHAT IS NOT IN A PACKAGE, and the reasons are in RESTORE.md too.
 *
 *   node_modules   reinstalled from the lockfile; megabytes of other people's
 *                  code that the lockfile already pins exactly
 *   .env           the secrets live in the owner's records and, if they opt in,
 *                  in secrets.enc. A package that always contained them would
 *                  mean one stolen file is the whole studio
 *   the backup folder itself  or every package would contain the last one
 *   logs, temp     noise that is not needed to rebuild anything
 *   THE OFFICE SERVER'S PROJECT FILES  Forge never stores them. It stores
 *                  LINKS to a share the studio's own file server owns, and the
 *                  gateway reads them where they are. No backup Forge takes
 *                  has ever contained a project file, and this one does not
 *                  either. IT backs that share up; RESTORE.md says so plainly.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { PassThrough } = require('node:stream');
const { v4: uuid } = require('uuid');

const storage = require('./backup-storage');
const crypt = require('./backup-crypto');
const dumper = require('./sql-dump');
const tar = require('./tar-stream');
const chatStorage = require('./chat-storage');

const APP_DIR = storage.APP_DIR;
const PACKAGE_FORMAT = 1;

/* The name of every environment variable that is a secret, so config/ can say
   "set" or "unset" without ever holding a value, and so secrets.enc knows what
   it is for. NAMES ONLY — this list is in the repository and must stay
   readable by anybody. */
const SECRET_ENV = [
  'DB_PASSWORD', 'DATABASE_URL', 'JWT_SECRET', 'EMAIL_ENCRYPTION_KEY',
  'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'FCM_PRIVATE_KEY', 'APNS_KEY_P8',
  'IP_ALLOWLIST_BYPASS_TOKEN', 'MOBILE_DIST_TOKEN', 'BOOTSTRAP_TOKEN',
  'DEFAULT_USER_PASSWORD', 'SEED_PASSWORD', 'SAMPLE_PASSWORD',
];

/* Everything else the app reads, for the config snapshot. Names only. */
const CONFIG_ENV = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_POOL_SIZE', 'PORT', 'CORS_ORIGIN',
  'TRUST_PROXY', 'PUBLIC_BASE_URL', 'BUILD_COMMIT', 'CHAT_UPLOAD_DIR', 'BACKUP_DIR',
  'MOBILE_DIST_DIR', 'EMAIL_TRANSPORT', 'GMAIL_SENDER', 'INTEGRATION_ENABLED',
  'IP_ALLOWLIST_ENABLED', 'IP_ALLOWLIST_MODE', 'WORK_HOURS_SWEEP_MINUTES',
  'CHAT_ATTACHMENT_HOURS', 'CHAT_SWEEP_MINUTES',
];

/* Paths never archived from the app folder. Matched against the path relative
   to the app root, so "uploads" excludes "<app>/uploads" and everything under
   it and nothing called uploads elsewhere. */
const CODE_EXCLUDE = new Set([
  'node_modules', '.git', '.env', '.env.local', 'uploads', 'backups', 'logs',
  'tmp', 'temp', 'dist-mobile', '.DS_Store', 'coverage', '.nyc_output',
]);

const STAGES = ['prepare', 'database', 'files', 'code', 'package', 'verify', 'prune', 'done'];

/* ========================================================================== */
/* what the app itself stores                                                 */
/* ========================================================================== */

/* EVERY PLACE FORGE PUTS A FILE, asked of the modules that own those places
 * rather than listed here from memory.
 *
 * Three today, and the third is the one somebody would forget:
 *   uploads/     src/upload.js — review files and spreadsheet imports, inside
 *                the app folder, which is why they are backed up at all: a
 *                deploy would otherwise take them
 *   chat         src/chat-storage.js — attachments, outside the app folder
 *   dist-mobile  src/mobile-dist.js — the mobile builds the studio hands out
 *
 * Branding and the favicon are in the DATABASE, so the dump already has them.
 * NOTHING HERE IS THE OFFICE SERVER: that share is not Forge's and is not
 * reachable from this process.
 */
function fileRoots({ env = process.env } = {}) {
  const roots = [];

  roots.push({ key: 'uploads', dir: path.join(APP_DIR, 'uploads'),
    note: 'Review files and spreadsheet imports (src/upload.js).' });

  const chat = chatStorage.status();
  if (chat && chat.dir) {
    roots.push({ key: 'chat', dir: chat.dir,
      note: `Chat attachments (${chatStorage.ENV_NAME || 'CHAT_UPLOAD_DIR'}).` });
  }

  const mobile = String(env.MOBILE_DIST_DIR || '').trim();
  roots.push({ key: 'mobile', dir: mobile ? path.resolve(mobile) : path.join(APP_DIR, 'dist-mobile'),
    note: 'Mobile application builds (src/mobile-dist.js).' });

  return roots;
}

/* Walk a root, answering { rel, abs, size }. Only ordinary files: a symbolic
   link in a backup is a way to write outside the restore directory, and the
   app never creates one. */
async function walkFiles(root, into = [], base = root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return into;                                  // not there: nothing to back up
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(abs, into, base);
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(abs);
        into.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs, size: st.size });
      } catch { /* vanished between readdir and stat: it is not in the backup */ }
    }
  }
  return into;
}

async function collectFiles({ env = process.env } = {}) {
  const here = storage.status();
  const out = [];
  for (const root of fileRoots({ env })) {
    /* A ROOT INSIDE THE BACKUP FOLDER IS SKIPPED ENTIRELY. backup-storage
       refuses that configuration, but refusing to archive it as well means two
       independent reasons a package cannot contain a package. */
    if (here.dir && (storage.insideOf(root.dir, here.dir) || storage.insideOf(here.dir, root.dir))) {
      continue;
    }
    const found = await walkFiles(root.dir);
    for (const f of found) {
      out.push({ ...f, entry: `files/${root.key}/${f.rel}`, root: root.key, rootDir: root.dir });
    }
  }
  return out;
}

/* ========================================================================== */
/* the code archive                                                           */
/* ========================================================================== */

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { cwd: APP_DIR, stdio: 'ignore', timeout: 5000 });
    return fs.existsSync(path.join(APP_DIR, '.git'));
  } catch {
    return false;
  }
}

function describeCommit() {
  if (process.env.BUILD_COMMIT) return { commit: String(process.env.BUILD_COMMIT).slice(0, 40), from: 'BUILD_COMMIT' };
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8', timeout: 5000 });
    return { commit: out.trim().slice(0, 40), from: 'git' };
  } catch {
    return { commit: null, from: null };
  }
}

/* The deployed code, as a tar written to `target`.
 *
 * GIT ARCHIVE WHEN GIT IS THERE because it is exactly the deployed commit with
 * nothing untracked and no .git; a tar of the folder otherwise, because the
 * production deploy for this app is "upload a zip and extract it" (see
 * DEPLOY-GODADDY.md) and such a host very often has no git at all. Both paths
 * are exercised by the tests; neither is assumed. */
async function writeCodeArchive(target) {
  if (gitAvailable()) {
    try {
      const out = fs.createWriteStream(target);
      const child = require('node:child_process').spawn(
        'git', ['archive', '--format=tar', 'HEAD'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      await pipeline(child.stdout, out);
      const code = await new Promise((resolve) => child.on('close', resolve));
      if (code === 0) {
        const st = await fsp.stat(target);
        if (st.size > 0) return { method: 'git-archive' };
      }
    } catch { /* fall through to the folder tar */ }
  }

  /* The folder, minus CODE_EXCLUDE. */
  const pack = new tar.Pack();
  const out = fs.createWriteStream(target);
  const done = pipeline(pack, out);
  (async () => {
    try {
      const walk = async (dir, rel) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (CODE_EXCLUDE.has(entry.name) || CODE_EXCLUDE.has(childRel)) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(abs, childRel);
          else if (entry.isFile()) await pack.addFile(childRel, abs);
        }
      };
      await walk(APP_DIR, '');
      pack.finish();
    } catch (err) {
      pack.destroy(err);
    }
  })();
  await done;
  return { method: 'folder-tar' };
}

/* ========================================================================== */
/* hashing a file without holding it                                          */
/* ========================================================================== */

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/* ========================================================================== */
/* the lock                                                                   */
/* ========================================================================== */

/* ONLY ONE BACKUP AT A TIME, AND THE DATABASE IS THE LOCK.
 *
 * Not a lock file: Passenger runs more than one process, can start a second one
 * on another request, and can kill either mid-write. A file lock then needs its
 * own staleness rule, its own cleanup and its own race on creation. A row has
 * all of that already — the status column, a heartbeat, and the migration's
 * sweep — and both processes are looking at the same database by definition.
 *
 * THE RACE IS CLOSED BY THE INSERT, not by the SELECT before it: two processes
 * can both see no running row. So the claim is a conditional INSERT ... SELECT
 * that writes a row only when none is running, and the one whose insert
 * affected a row holds the lock. */
async function claim(db, { trigger, userId, label, encrypted }) {
  const id = uuid();
  const { result } = await db.query(
    `INSERT INTO backups (id, status, trigger_kind, created_by, created_by_label, encrypted,
                          stage, percent, heartbeat_at, app_version, commit_ref, node_version)
     SELECT $1, 'running', $2, $3, $4, $5, 'prepare', 0, NOW(), $6, $7, $8
       FROM (SELECT 1) AS one
      WHERE NOT EXISTS (
        SELECT 1 FROM backups
         WHERE status = 'running'
           AND (heartbeat_at IS NULL OR heartbeat_at > (NOW() - INTERVAL 10 MINUTE)))`,
    [id, trigger, userId || null, label || null, encrypted ? 1 : 0,
      appVersion(), describeCommit().commit, process.version]
  );
  if (!result || !result.affectedRows) {
    const err = new Error('A backup is already running. Wait for it to finish, or look at the list — '
      + 'a backup left behind by a restart is marked failed within ten minutes.');
    err.code = 'BACKUP_BUSY';
    throw err;
  }
  return id;
}

async function beat(db, id, stage, percent) {
  await db.query(
    'UPDATE backups SET stage = $1, percent = $2, heartbeat_at = NOW() WHERE id = $3',
    [stage, Math.max(0, Math.min(100, Math.round(percent))), id]
  ).catch(() => {});
}

function appVersion() {
  try {
    return String(require(path.join(APP_DIR, 'package.json')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/* ========================================================================== */
/* the estimate and the disk guard                                            */
/* ========================================================================== */

/* HOW BIG IS THIS GOING TO BE, asked before anything is written.
 *
 * The database's own byte count from information_schema, plus the app's files,
 * plus the code. Gzip will shrink the first two a great deal — a SQL dump
 * compresses five to one or better — so the estimate is deliberately the
 * UNCOMPRESSED figure: the guard wants to be wrong in the safe direction, and
 * the temporary dump file really is that big while it exists. */
async function estimate(db, { env = process.env } = {}) {
  let dataBytes = 0;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
    );
    dataBytes = Number(rows[0].bytes) || 0;
  } catch { dataBytes = 0; }

  const files = await collectFiles({ env });
  const fileBytes = files.reduce((n, f) => n + f.size, 0);

  /* The code is small and bounded; measuring it exactly would mean archiving it
     twice. A generous fixed allowance is the honest shape of an estimate. */
  const codeBytes = 32 * 1024 * 1024;
  return {
    bytes: dataBytes + fileBytes + codeBytes,
    dataBytes, fileBytes, codeBytes, fileCount: files.length,
  };
}

/* ========================================================================== */
/* the manifest                                                               */
/* ========================================================================== */

function configSnapshot({ env = process.env, dbVersion, tables }) {
  const here = storage.status();
  const chat = chatStorage.status();
  return {
    takenAt: new Date().toISOString(),
    note: 'Names and whether each is set. NO VALUES — not even a truncated one. The values live in '
      + 'the owner\'s records and, when the owner opted in at backup time, in secrets.enc.',
    versions: {
      forge: appVersion(),
      commit: describeCommit().commit,
      node: process.version,
      database: dbVersion || null,
      platform: `${os.type()} ${os.release()}`,
    },
    environment: {
      configuration: Object.fromEntries(CONFIG_ENV.map((name) => [name,
        Object.prototype.hasOwnProperty.call(env, name) && String(env[name] || '') !== ''
          ? 'set' : 'unset'])),
      secrets: Object.fromEntries(SECRET_ENV.map((name) => [name,
        Object.prototype.hasOwnProperty.call(env, name) && String(env[name] || '') !== ''
          ? 'set' : 'unset'])),
    },
    storage: {
      appDir: APP_DIR,
      backupDir: here.dir,
      chatUploadDir: chat ? chat.dir : null,
      note: 'Paths as this installation had them. A restore onto another account will have other '
        + 'paths; set the environment variables to match and the application follows.',
    },
    tables: tables || null,
    deployNotes: [
      'This application is deployed on cPanel through Setup Node.js App (Passenger).',
      'The application folder lives OUTSIDE public_html so nothing in it is served as a plain file.',
      'Dependencies are installed from the lockfile with npm ci, never committed to the package.',
      'Migrations run at startup; a restored database is brought up to date by starting the app.',
    ],
  };
}

/* ========================================================================== */
/* creating a package                                                         */
/* ========================================================================== */

/* Create a backup. The ONE entry point both the screen and the CLI use.
 *
 * `onProgress` is called with { stage, percent, detail } so the screen's bar can
 * move; the same values are written to the row, which is what the status
 * endpoint reads — the job runs detached from any request, so a Passenger
 * timeout cannot stop it half way and the browser polls rather than waits.
 */
async function create(db, {
  passphrase,
  encrypt = true,
  includeSecrets = false,
  trigger = 'manual',
  userId = null,
  userLabel = null,
  dbConfig = null,
  env = process.env,
  onProgress = null,
  keepLast = null,
} = {}) {
  const started = Date.now();
  const say = (stage, percent, detail) => {
    if (onProgress) onProgress({ stage, percent, detail });
  };

  /* ---- 1. refuse early -------------------------------------------------- */
  const here = storage.status({ refresh: true });
  if (!here.ok) {
    const err = new Error(here.problems.map((p) => p.message).join(' '));
    err.code = 'BACKUP_DIR_INVALID';
    throw err;
  }
  if (encrypt) {
    const strong = crypt.strength(passphrase);
    if (!strong.ok) {
      const err = new Error(strong.message);
      err.code = 'BACKUP_WEAK_PASSPHRASE';
      throw err;
    }
  } else if (passphrase) {
    const err = new Error('An unencrypted package takes no passphrase.');
    err.code = 'BACKUP_BAD_ARGS';
    throw err;
  }

  const sized = await estimate(db, { env });
  const free = storage.freeBytes(here.dir);
  if (free !== null && free < sized.bytes * 2) {
    const err = new Error(`Not enough disk space: this backup needs about `
      + `${Math.ceil(sized.bytes * 2 / 1048576)} MB free (twice the estimated size, because the `
      + `database is written out before it is packed) and ${Math.floor(free / 1048576)} MB is free. `
      + 'Delete an old backup, or move them off this server.');
    err.code = 'BACKUP_NO_SPACE';
    throw err;
  }

  /* ---- 2. claim --------------------------------------------------------- */
  const id = await claim(db, { trigger, userId, label: userLabel, encrypted: encrypt });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const commit = describeCommit().commit;
  const tag = commit ? commit.slice(0, 12) : `v${appVersion()}`;
  const filename = `backup-${stamp}-${tag}.tar.gz${encrypt ? '.enc' : ''}`;
  const finalPath = storage.resolveName(filename);

  /* Working files live in the backup folder, not in temp: the folder is
     validated and on the right volume, and os.tmpdir() on shared hosting is
     both small and swept. The prefix is what the cleanup below looks for. */
  const work = path.join(here.dir, `.work-${id}`);
  await fsp.mkdir(work, { recursive: true });

  const cleanup = async () => {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  };

  try {
    /* ---- 3. the database ----------------------------------------------- */
    say('database', 5, 'Taking a consistent snapshot');
    await beat(db, id, 'database', 5);

    const dumpPath = path.join(work, 'dump.sql');
    const config = dbConfig || connectionConfig(env);
    const conn = await dumper.openSnapshot(config);
    let dumpResult;
    try {
      const out = fs.createWriteStream(dumpPath);
      const write = (text) => new Promise((resolve, reject) => {
        if (out.write(text)) return resolve();
        out.once('drain', resolve);
        out.once('error', reject);
      });
      let lastBeat = 0;
      dumpResult = await dumper.dump({
        conn,
        write,
        onProgress: (p) => {
          if (p.stage === 'data' && p.tables) {
            const pct = 5 + Math.round((p.index / p.tables) * 45);
            say('database', pct, `${p.table} (${p.index} of ${p.tables})`);
            if (Date.now() - lastBeat > 2000) {
              lastBeat = Date.now();
              beat(db, id, 'database', pct);
            }
          }
        },
      });
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } finally {
      await dumper.closeSnapshot(conn);
    }
    const dumpHash = await hashFile(dumpPath);
    const dumpSize = (await fsp.stat(dumpPath)).size;

    /* ---- 4. the files and the code ------------------------------------- */
    say('files', 55, 'Listing the application\'s own files');
    await beat(db, id, 'files', 55);
    const files = await collectFiles({ env });

    say('code', 60, 'Archiving the deployed code');
    await beat(db, id, 'code', 60);
    const codePath = path.join(work, 'app.tar');
    const codeMethod = await writeCodeArchive(codePath);
    const codeHash = await hashFile(codePath);
    const codeSize = (await fsp.stat(codePath)).size;

    /* ---- 5. the manifest and the package ------------------------------- */
    const configJson = Buffer.from(JSON.stringify(configSnapshot({
      env, dbVersion: dumpResult.serverVersion, tables: dumpResult.counts,
    }), null, 2), 'utf8');

    const restoreMd = Buffer.from(restoreDoc({
      filename, encrypted: encrypt, includeSecrets, tables: dumpResult.counts,
    }), 'utf8');

    let secretsPart = null;
    if (includeSecrets) {
      if (!encrypt) {
        const err = new Error('A secrets bundle is only written into an encrypted package.');
        err.code = 'BACKUP_BAD_ARGS';
        throw err;
      }
      secretsPart = secretsBundle({ env, passphrase });
    }

    const parts = [
      { name: 'manifest.json', kind: 'manifest' },
      { name: 'database/dump.sql', sha256: dumpHash, bytes: dumpSize, from: dumpPath },
      { name: 'code/app.tar', sha256: codeHash, bytes: codeSize, from: codePath,
        method: codeMethod.method },
      { name: 'config/environment.json', sha256: sha(configJson), bytes: configJson.length,
        buffer: configJson },
      { name: 'RESTORE.md', sha256: sha(restoreMd), bytes: restoreMd.length, buffer: restoreMd },
      ...files.map((f) => ({ name: f.entry, bytes: f.size, from: f.abs, file: true })),
      ...(secretsPart ? [{ name: 'secrets.enc', sha256: sha(secretsPart), bytes: secretsPart.length,
        buffer: secretsPart, encrypted: true }] : []),
    ];

    /* THE FILES ARE HASHED BEFORE THEY ARE PACKED, so the manifest — which goes
       in first — can carry every hash. The cost is reading them twice; the gain
       is a manifest that is a complete index rather than one with holes where
       the large parts are. */
    say('package', 65, 'Hashing the application\'s files');
    for (const part of parts) {
      if (part.file && !part.sha256) part.sha256 = await hashFile(part.from);
    }

    const manifest = {
      format: PACKAGE_FORMAT,
      kind: 'forge-backup',
      id,
      createdAt: new Date().toISOString(),
      createdBy: userId || 'cli',
      createdByLabel: userLabel || null,
      trigger,
      encrypted: encrypt,
      includesSecrets: Boolean(secretsPart),
      versions: {
        forge: appVersion(),
        commit,
        node: process.version,
        database: dumpResult.serverVersion,
        packageFormat: PACKAGE_FORMAT,
      },
      database: {
        name: dumpResult.database,
        tables: dumpResult.counts,
        tableCount: Object.keys(dumpResult.counts).length,
        rowCount: Object.values(dumpResult.counts).reduce((a, b) => a + b, 0),
        views: dumpResult.inventory.views,
        triggers: dumpResult.inventory.triggers,
        routines: dumpResult.inventory.routines.map((r) => r.name),
        events: dumpResult.inventory.events,
        /* THE MIGRATION VERSION, so a restore knows whether the code in code/
           is newer than the schema in database/. This application has no
           numbered migrations — src/migrate.js is a list of idempotent steps
           run at every start — so the honest answer is the step count and the
           commit, and the restore checklist says "start the app, which
           migrates". */
        migrationSteps: migrationStepCount(),
      },
      files: {
        count: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        roots: fileRoots({ env }).map((r) => ({ key: r.key, note: r.note })),
      },
      excluded: [
        'node_modules — reinstall with npm ci from the lockfile in code/',
        '.env — the secrets are in the owner\'s records'
          + (secretsPart ? ', and in secrets.enc in this package' : ''),
        'the backup folder itself',
        'logs and temporary files',
        'THE OFFICE FILE SERVER\'S PROJECT FILES — Forge never stores them; it stores links to a '
          + 'share the studio\'s own server owns. Back that share up separately.',
        'the gateway\'s own configuration on the office server — IT backs that up with the machine',
      ],
      parts: parts.map((p) => ({
        name: p.name,
        sha256: p.sha256 || null,
        bytes: p.bytes === undefined ? null : p.bytes,
        ...(p.method ? { method: p.method } : {}),
        ...(p.encrypted ? { encrypted: true } : {}),
      })),
    };
    const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

    say('package', 70, 'Writing the package');
    await beat(db, id, 'package', 70);

    const writerSide = crypt.writer({
      passphrase,
      encrypt,
      extra: { createdAt: manifest.createdAt, forge: manifest.versions.forge },
    });

    const out = fs.createWriteStream(finalPath, { mode: 0o600 });
    const outer = crypto.createHash('sha256');
    outer.update(writerSide.head);
    out.write(writerSide.head);

    const counter = new tar.Counter();
    const tally = new PassThrough();
    tally.on('data', (chunk) => outer.update(chunk));

    const pack = new tar.Pack();
    const done = pipeline(pack, counter, zlib.createGzip({ level: 6 }), writerSide.cipher, tally, out,
      { end: false });

    const feed = (async () => {
      await pack.addBuffer('manifest.json', manifestJson, { mode: 0o600 });
      for (const part of parts) {
        if (part.kind === 'manifest') continue;
        if (part.buffer) await pack.addBuffer(part.name, part.buffer, { mode: 0o600 });
        else await pack.addFile(part.name, part.from, { mode: 0o600 });
      }
      pack.finish();
    })();

    await Promise.all([done, feed]);
    const tag2 = writerSide.finish();
    if (tag2.length) { outer.update(tag2); out.write(tag2); }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

    const size = (await fsp.stat(finalPath)).size;
    const packageHash = outer.digest('hex');

    await db.query(
      `UPDATE backups SET filename = $1, size_bytes = $2, sha256 = $3, status = 'ok',
              manifest = $4, stage = 'verify', percent = 85, heartbeat_at = NOW(),
              db_version = $5, finished_at = NULL
        WHERE id = $6`,
      [filename, size, packageHash, JSON.stringify(manifest), dumpResult.serverVersion, id]
    );

    /* ---- 6. verify ----------------------------------------------------- */
    say('verify', 85, 'Reading the package back');
    const verdict = await verifyFile(finalPath, { passphrase });
    if (!verdict.ok) {
      await db.query(
        `UPDATE backups SET status = 'failed', error = $1, finished_at = NOW() WHERE id = $2`,
        [String(verdict.error).slice(0, 500), id]
      );
      const err = new Error(`The package was written but failed verification: ${verdict.error}`);
      err.code = 'BACKUP_VERIFY_FAILED';
      err.backupId = id;
      throw err;
    }

    await db.query(
      `UPDATE backups SET status = 'verified', stage = 'done', percent = 100,
              finished_at = NOW(), heartbeat_at = NOW() WHERE id = $1`,
      [id]
    );

    /* ---- 7. prune ------------------------------------------------------ */
    say('prune', 95, 'Removing old packages');
    const pruned = await prune(db, { keepLast });

    say('done', 100, 'Finished');
    await cleanup();
    return {
      ok: true, id, filename, path: finalPath, size, sha256: packageHash,
      encrypted: encrypt, includesSecrets: Boolean(secretsPart),
      manifest, pruned, tookMs: Date.now() - started, verified: true,
    };
  } catch (err) {
    await cleanup();
    /* THE ROW IS MARKED failed WITH THE REASON, which is what releases the lock
       and what the screen shows. A crash that left `running` behind is swept by
       the migration on the next start; a thrown error is recorded here. */
    await db.query(
      `UPDATE backups SET status = 'failed', error = $1, finished_at = NOW()
        WHERE id = $2 AND status = 'running'`,
      [String(err.message || err).slice(0, 500), id]
    ).catch(() => {});
    /* AND THE HALF-WRITTEN FILE GOES, so nothing in the folder looks like a
       package that could be restored. */
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    throw err;
  }
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function migrationStepCount() {
  try {
    return require('./migrate').STEPS.length;
  } catch {
    return null;
  }
}

/* The database connection settings, from the same environment the app uses.
   Its own reader rather than src/db's pool: the dump needs a dedicated
   connection and the CLI has no pool at all. */
function connectionConfig(env = process.env) {
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
    };
  }
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME,
  };
}

/* ========================================================================== */
/* the optional secrets bundle                                                */
/* ========================================================================== */

/* THE .env VALUES, ENCRYPTED AGAIN INSIDE AN ALREADY-ENCRYPTED PACKAGE.
 *
 * Belt and braces on purpose. The package is encrypted, so this is a second
 * layer under the same passphrase — which buys one real thing: an unencrypted
 * package can never contain it (refused above), and a package that is decrypted
 * onto a laptop for inspection does not spill the secrets as a side effect of
 * someone reading RESTORE.md.
 *
 * ITS OWN SALT AND IV, so the bundle is not the package's key applied twice.
 */
function secretsBundle({ env = process.env, passphrase }) {
  const values = {};
  for (const name of SECRET_ENV) {
    if (Object.prototype.hasOwnProperty.call(env, name) && String(env[name] || '') !== '') {
      values[name] = String(env[name]);
    }
  }
  const body = Buffer.from(JSON.stringify({
    note: 'The environment secrets as this installation had them. Set them again on the restored '
      + 'host and delete this file from wherever you decrypted it.',
    takenAt: new Date().toISOString(),
    values,
  }), 'utf8');

  const salt = crypto.randomBytes(crypt.SALT_BYTES);
  const iv = crypto.randomBytes(crypt.IV_BYTES);
  const key = crypt.deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(crypt.ALGORITHM, key, iv, { authTagLength: crypt.TAG_BYTES });
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  key.fill(0);
  body.fill(0);
  return Buffer.from(JSON.stringify({
    format: 1,
    cipher: crypt.ALGORITHM,
    kdf: { name: crypt.KDF.name, N: crypt.KDF.N, r: crypt.KDF.r, p: crypt.KDF.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    body: enc.toString('base64'),
  }, null, 2), 'utf8');
}

function openSecretsBundle(buffer, passphrase) {
  const outer = JSON.parse(buffer.toString('utf8'));
  const salt = Buffer.from(outer.salt, 'base64');
  const iv = Buffer.from(outer.iv, 'base64');
  const key = crypt.deriveKey(passphrase, salt, { ...crypt.KDF, ...(outer.kdf || {}) });
  const decipher = crypto.createDecipheriv(outer.cipher, key, iv, { authTagLength: crypt.TAG_BYTES });
  decipher.setAuthTag(Buffer.from(outer.tag, 'base64'));
  const body = Buffer.concat([decipher.update(Buffer.from(outer.body, 'base64')), decipher.final()]);
  key.fill(0);
  return JSON.parse(body.toString('utf8'));
}

/* ========================================================================== */
/* opening and verifying                                                      */
/* ========================================================================== */

/* THE ONE READER. Walks a package, handing every entry to `onEntry`.
 *
 * A WRONG PASSPHRASE AND A DAMAGED PACKAGE ARE THE SAME ANSWER, and that is not
 * a shortcoming: with authenticated encryption they are genuinely
 * indistinguishable from outside. What matters is that the message says so
 * rather than leaking a zlib error code — the first version of this reported
 * "Z_DATA_ERROR", which sent somebody looking for a corrupt file when they had
 * mistyped a word.
 */
async function openPackage(file, { passphrase, onEntry }) {
  const fd = await fsp.open(file, 'r');
  let head;
  try {
    head = Buffer.alloc(Math.min(64 * 1024, (await fd.stat()).size));
    await fd.read(head, 0, head.length, 0);
  } finally {
    await fd.close();
  }
  const { header, raw, payloadAt } = crypt.readHeader(head);
  if (header.encrypted && !passphrase) {
    const err = new Error('This package is encrypted. The passphrase is needed to open it.');
    err.code = 'BACKUP_NEEDS_PASSPHRASE';
    throw err;
  }
  const side = crypt.reader({ header, raw, passphrase });
  const out = new PassThrough();
  const read = pipeline(
    fs.createReadStream(file, { start: payloadAt }),
    ...side.transforms,
    zlib.createGunzip(),
    out
  );
  try {
    await Promise.all([read, tar.each(out, onEntry)]);
  } catch (err) {
    const bad = ['Z_DATA_ERROR', 'ERR_OSSL_EVP_BAD_DECRYPT', 'ERR_CRYPTO_AUTH_TAG_MISMATCH',
      'TAR_BAD_CHECKSUM', 'TAR_TRUNCATED'].includes(err.code)
      || /unable to authenticate|bad decrypt|incorrect header check/i.test(String(err.message));
    if (header.encrypted && bad) {
      const wrapped = new Error('The package could not be opened: either the passphrase is wrong or '
        + 'the file has been damaged or tampered with. With authenticated encryption those two are '
        + 'the same answer — there is no way to tell them apart from outside.');
      wrapped.code = 'BACKUP_CANNOT_OPEN';
      throw wrapped;
    }
    throw err;
  }
  return { header };
}

/* VERIFY: read the package back and check every part against the manifest.
 *
 * This is what turns `ok` into `verified`, and the difference is the whole
 * point. `ok` means "we wrote a file". `verified` means "we read it back, the
 * passphrase opens it, the tar is intact, and every part hashes to what the
 * manifest says". A backup in the first state is a hope.
 */
async function verifyFile(file, { passphrase } = {}) {
  let manifest = null;
  const seen = new Map();
  const problems = [];

  try {
    await openPackage(file, {
      passphrase,
      onEntry: async (entry, body) => {
        if (entry.type === '5') return;
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of body) { bytes += chunk.length; hash.update(chunk); }
        const digest = hash.digest('hex');
        if (entry.name === 'manifest.json') {
          /* The manifest has to be re-read to compare against, so it is the one
             entry held in memory — a few kilobytes. */
          const fd2 = await collectEntry(file, passphrase, 'manifest.json');
          manifest = JSON.parse(fd2.toString('utf8'));
          seen.set(entry.name, { sha256: digest, bytes });
          return;
        }
        seen.set(entry.name, { sha256: digest, bytes });
      },
    });
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || null };
  }

  if (!manifest) return { ok: false, error: 'The package has no manifest.', code: 'BACKUP_NO_MANIFEST' };
  if (Number(manifest.format) !== PACKAGE_FORMAT) {
    return { ok: false, code: 'BACKUP_BAD_FORMAT',
      error: `The package says format ${manifest.format}; this Forge reads format ${PACKAGE_FORMAT}.` };
  }

  for (const part of manifest.parts || []) {
    if (part.name === 'manifest.json') continue;
    const got = seen.get(part.name);
    if (!got) { problems.push(`${part.name} is named in the manifest and missing from the package`); continue; }
    if (part.sha256 && got.sha256 !== part.sha256) {
      problems.push(`${part.name} does not match its hash in the manifest`);
    }
    if (part.bytes !== null && part.bytes !== undefined && Number(part.bytes) !== got.bytes) {
      problems.push(`${part.name} is ${got.bytes} bytes and the manifest says ${part.bytes}`);
    }
  }
  /* AND NOTHING IN THE PACKAGE THAT THE MANIFEST DOES NOT NAME, which is the
     other direction and the one that catches an entry slipped in later. */
  for (const name of seen.keys()) {
    if (name === 'manifest.json') continue;
    if (!(manifest.parts || []).some((p) => p.name === name)) {
      problems.push(`${name} is in the package and not in the manifest`);
    }
  }

  if (problems.length) {
    return { ok: false, code: 'BACKUP_PART_MISMATCH', error: problems.join('; '), manifest };
  }
  return { ok: true, manifest, parts: seen.size };
}

/* One entry's bytes, for the few that are small enough to want in memory. */
async function collectEntry(file, passphrase, wanted) {
  let found = null;
  await openPackage(file, {
    passphrase,
    onEntry: async (entry, body) => {
      if (entry.name !== wanted || found) {
        for await (const chunk of body) void chunk;
        return;
      }
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      found = Buffer.concat(chunks);
    },
  });
  if (!found) {
    const err = new Error(`The package has no ${wanted}.`);
    err.code = 'BACKUP_NO_PART';
    throw err;
  }
  return found;
}

/* ========================================================================== */
/* retention                                                                  */
/* ========================================================================== */

/* KEEP THE NEWEST N, AND DELETE ONLY WHAT THIS TABLE NAMES.
 *
 * The folder is the owner's. They may keep their own copies in it, a note to
 * themselves, last year's package pulled back from cloud storage. A retention
 * sweep that listed the directory and deleted the oldest would eventually
 * delete one of those, and the owner would have no way to know why.
 *
 * So pruning walks the TABLE, takes the rows past the keep count, and deletes
 * the file each row names — through resolveName(), so even a tampered row
 * cannot point outside the folder. A file in the folder that no row names is
 * never touched.
 */
async function prune(db, { keepLast = null } = {}) {
  let keep = Number(keepLast);
  if (!Number.isFinite(keep) || keep < 1) {
    const { rows } = await db.query('SELECT keep_last FROM backup_settings WHERE id = 1');
    keep = rows.length ? Number(rows[0].keep_last) : 7;
  }
  keep = Math.max(1, Math.min(365, keep));

  /* Only finished, usable packages count towards the keep: a failed row has no
     file, and counting it would silently shorten the history. */
  const { rows } = await db.query(
    `SELECT id, filename FROM backups
      WHERE status IN ('ok','verified') AND filename IS NOT NULL
      ORDER BY created_at DESC, id DESC`
  );
  const doomed = rows.slice(keep);
  const removed = [];
  for (const row of doomed) {
    try {
      const file = storage.resolveName(row.filename);
      await fsp.rm(file, { force: true });
      removed.push(row.filename);
    } catch { /* a name we cannot resolve is a name we do not delete */ }
    await db.query('DELETE FROM backups WHERE id = $1', [row.id]).catch(() => {});
  }
  return { kept: Math.min(keep, rows.length), removed };
}

/* ========================================================================== */
/* listing                                                                    */
/* ========================================================================== */

async function list(db, { limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const { rows } = await db.query(
    `SELECT id, filename, size_bytes, sha256, encrypted, status, error, trigger_kind,
            created_by, created_by_label, app_version, commit_ref, node_version, db_version,
            stage, percent, created_at, finished_at
       FROM backups ORDER BY created_at DESC, id DESC LIMIT $1`, [capped]
  );
  return rows.map(shape);
}

function shape(row) {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    encrypted: row.encrypted !== 0,
    status: row.status,
    verified: row.status === 'verified',
    error: row.error,
    trigger: row.trigger_kind,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    versions: {
      forge: row.app_version, commit: row.commit_ref,
      node: row.node_version, database: row.db_version,
    },
    stage: row.stage,
    percent: row.percent === null ? null : Number(row.percent),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    /* NO MANIFEST AND NO PATH IN THE LIST. The manifest is large and the path is
       the server's business; the download route resolves it from the row. */
  };
}

async function get(db, id) {
  const { rows } = await db.query('SELECT * FROM backups WHERE id = $1', [String(id || '')]);
  if (!rows.length) return null;
  return { ...shape(rows[0]), manifest: rows[0].manifest ? safeJson(rows[0].manifest) : null };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* The newest verified package, and how old it is — the status line, the doctor
   and the daily notice all ask this one question. */
async function lastGood(db) {
  const { rows } = await db.query(
    `SELECT id, filename, size_bytes, created_at, status FROM backups
      WHERE status = 'verified' ORDER BY created_at DESC LIMIT 1`
  );
  if (!rows.length) return { exists: false, ageDays: null, at: null, size: null };
  const at = new Date(rows[0].created_at);
  return {
    exists: true,
    id: rows[0].id,
    filename: rows[0].filename,
    at,
    size: Number(rows[0].size_bytes),
    ageDays: Math.floor((Date.now() - at.getTime()) / 86400000),
  };
}

async function running(db) {
  const { rows } = await db.query(
    `SELECT id, stage, percent, created_at FROM backups
      WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at > (NOW() - INTERVAL 10 MINUTE))
      ORDER BY created_at DESC LIMIT 1`
  );
  return rows.length ? { id: rows[0].id, stage: rows[0].stage, percent: Number(rows[0].percent) } : null;
}

async function remove(db, id) {
  const row = await get(db, id);
  if (!row) return { ok: false, status: 404, error: 'That backup is not in the list.' };
  if (row.status === 'running') {
    return { ok: false, status: 409,
      error: 'That backup is still being written. Wait for it to finish or fail.' };
  }
  if (row.filename) {
    try {
      await fsp.rm(storage.resolveName(row.filename), { force: true });
    } catch { /* already gone, or a name that will not resolve: the row still goes */ }
  }
  await db.query('DELETE FROM backups WHERE id = $1', [row.id]);
  return { ok: true, deleted: row };
}

module.exports = {
  PACKAGE_FORMAT, SECRET_ENV, CONFIG_ENV, CODE_EXCLUDE, STAGES,
  create, verifyFile, openPackage, collectEntry, prune, list, get, lastGood, running, remove,
  estimate, collectFiles, fileRoots, connectionConfig, configSnapshot,
  secretsBundle, openSecretsBundle, writeCodeArchive, gitAvailable, describeCommit, appVersion,
  hashFile, claim, beat,
  restoreDoc,
};

/* ========================================================================== */
/* RESTORE.md                                                                 */
/* ========================================================================== */

/* THE DOCUMENT THAT GOES IN THE PACKAGE.
 *
 * Written for somebody who has this one file and nothing else: no repository,
 * no notes, possibly not the person who took it. So it says what the package
 * is, what it is not, and the exact order of operations — and it says the thing
 * about the passphrase twice, because that is the mistake that cannot be
 * recovered from.
 */
function restoreDoc({ filename, encrypted, includeSecrets, tables }) {
  const count = tables ? Object.keys(tables).length : 0;
  const rows = tables ? Object.values(tables).reduce((a, b) => a + b, 0) : 0;
  return `# Restoring Forge from this package

This package is \`${filename}\`. It was produced by Forge's own backup engine and
contains everything needed to rebuild the application from nothing **except** the
things listed under "What is not here".

${encrypted ? `## The passphrase

This package is encrypted with AES-256-GCM under a key derived from a passphrase
somebody typed when it was taken.

**${crypt.LOST_PASSPHRASE_WARNING}**

` : `## This package is NOT encrypted

It was written with \`--no-encrypt\` from the command line. It contains every
password hash and every encrypted setting in the studio. Treat the file itself as
the secret: keep it somewhere only you can read, and prefer an encrypted package
for anything you intend to store or move.

`}## What is in here

| Part | What it is |
| --- | --- |
| \`manifest.json\` | Format, versions, a sha256 and a size for every part, and the row count of each of the ${count} tables (${rows} rows in all). |
| \`code/app.tar\` | The deployed application code. |
| \`database/dump.sql\` | The whole database: schema, then data, then views, triggers, routines and events if the installation had any. utf8mb4, foreign key checks disabled for the file and restored at the end. |
| \`files/uploads/…\` | Review files and spreadsheet imports. |
| \`files/chat/…\` | Chat attachments. |
| \`files/mobile/…\` | Mobile application builds. |
| \`config/environment.json\` | The NAMES of the environment variables and whether each was set. No values. |
${includeSecrets ? '| `secrets.enc` | The environment secrets, encrypted again under the same passphrase. |\n' : ''}
## What is not here

- **\`node_modules\`** — reinstall it with \`npm ci\`, which reads the lockfile in \`code/\`.
- **\`.env\`** — ${includeSecrets
    ? 'the values are in `secrets.enc` in this package, under the same passphrase.'
    : 'the values are in your own records. This package does not contain them.'}
- **The backup folder itself**, so a package never contains the previous one.
- **Logs and temporary files.**
- **THE PROJECT FILES ON THE OFFICE SERVER.** Forge never stores them. It stores
  *links* to a share your own file server owns, and the gateway on that machine
  reads the files where they are. Nothing in this package is a project file, and
  restoring it does not restore one. **Your office server's own backup is what
  protects those**, and it is a separate job from this one.
- **The gateway's own configuration on the office server** (\`GATEWAY_SECRET\`, its
  \`FILE_ROOT\`, its service definition). That machine is backed up by whoever
  backs that machine up; ask IT to include the gateway's folder.

## Restoring, in order

Everything below is run from a shell on the target host.

1. **Unpack.** \`npm run restore -- /path/to/${filename}${encrypted ? ' --passphrase-file ./pass.txt' : ''} --dry-run\`
   first: it verifies the manifest and every hash, prints exactly what it would
   do, and changes nothing. Then run it again without \`--dry-run\`.

   The restore script refuses a database that is not empty unless you pass
   \`--force\`, and with \`--force\` it takes a **pre-restore backup of the existing
   database first**.

2. **Put the code back.** \`tar -xf code/app.tar -C /home/<account>/zvky-backend\`
   (the restore script does this for you unless you pass \`--db-only\`).

3. **Install dependencies.** In the application folder: \`npm ci --omit=dev\`.
   Never copy \`node_modules\` between hosts.

4. **Set the environment variables** in cPanel → Setup Node.js App. The names are
   in \`config/environment.json\`. Two of them decide whether the restored
   database is readable at all:

   - \`EMAIL_ENCRYPTION_KEY\` — without the **same value** this installation had,
     the encrypted settings in the database cannot be decrypted: the SMTP
     password, the Gmail tokens, the office server's signing key and secret, and
     the configured default reset password. The data is there and unreadable.
   - \`JWT_SECRET\` — a new value is fine and signs everybody out, which is the
     right thing after a restore.

   ${includeSecrets
    ? 'Both are in `secrets.enc`; the restore script prints them to the screen on request and never writes them to a file.'
    : 'Both come from your own records. This package does not contain them.'}

5. **Run the migrations** by starting the application: \`src/migrate.js\` runs at
   every start and is idempotent.

6. **Restart the application** in cPanel → Setup Node.js App → Restart.

7. **Run the doctor**: Settings → Server → Self-test, and Settings → Backup,
   which checks the backup folder, the free space and the age of the last
   package.

8. **Sign in** and check: a project's board draws, a chat attachment opens, the
   Activity Log has history.

## Where to keep this file

Not on the server it came from. A backup that lives only beside the thing it
backs up is not a backup — the disk, the account and the host are the three
things most likely to take both.

${encrypted ? `Keep the **package** and the **passphrase** in different places. The package is
safe to put in cloud storage; the passphrase is not, and neither of them is any
use to an attacker without the other.

**${crypt.LOST_PASSPHRASE_WARNING}**
` : ''}`;
}
