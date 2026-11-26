/* THE RULES THAT ARE ONLY VISIBLE IN THE SOURCE, pinned so they cannot be
 * undone quietly.
 *
 * ===========================================================================
 * WHY A SUITE OF GREPS.
 *
 * Most of this feature is covered by tests that run it. A few of its most
 * important properties are not testable that way, because they are statements
 * about what the code does NOT do, and a passing run proves nothing about an
 * absence:
 *
 *   - there is no route, anywhere, that restores a backup;
 *   - no secret value ever reaches a response, a log or the manifest;
 *   - the web layer never takes a file path from a request;
 *   - the engine has ONE implementation, used by both the page and the CLI.
 *
 * Each of those is one line away from being false — somebody adds a convenient
 * `POST /api/backups/:id/restore`, or logs the settings object while debugging
 * — and each would be invisible until the day it mattered. So they are pinned
 * here, in the only place an absence can be checked.
 *
 * A GREP GUARD EARNS ITS KEEP WHEN THE RULE IS ARCHITECTURAL AND THE VIOLATION
 * IS CHEAP. All four above are. This file is deliberately not a style checker.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Comments are stripped before every search: this file's own subject matter is
   discussed at length in the comments of the files it searches, and a guard
   that trips on its own explanation is a guard nobody keeps. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SERVER_FILES = [
  'src/backup.js', 'src/backup-crypto.js', 'src/backup-storage.js', 'src/backup-settings.js',
  'src/backup-scheduler.js', 'src/sql-dump.js', 'src/tar-stream.js', 'src/step-up.js',
  'src/routes/backups.js',
];

/* ========================================================================== */
/* 1. RESTORING IS NOT ON THE WEB                                             */
/* ========================================================================== */

test('no route restores a backup, under any spelling', () => {
  /* THE WHOLE ARGUMENT IS IN scripts/restore.js: a web page cannot ask for an
     irreversible act safely, and a deliberately crippled button is worse than
     no button because it still looks like a feature. One route would undo it. */
  const routes = code('src/routes/backups.js');
  for (const bad of [/restore/i, /import/i, /\bload\b/i, /overwrite/i]) {
    assert.ok(!bad.test(routes),
      `src/routes/backups.js mentions ${bad} — restoring must not be reachable from the web`);
  }
  /* AND NOT MOUNTED ANYWHERE ELSE EITHER. */
  const server = code('src/server.js');
  assert.ok(!/restore/i.test(server), 'src/server.js mounts something called restore');
});

test('the restore CLI is the only thing that loads a dump', () => {
  const callers = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })) {
    const rel = path.join('src', String(file));
    if (!rel.endsWith('.js')) continue;
    if (/sqlDump\.load\(|require\(.*sql-dump.*\)\.load\(/.test(code(rel))) callers.push(rel);
  }
  assert.deepStrictEqual(callers, [],
    `sql-dump's loader must not be called from src/ — found in: ${callers.join(', ')}`);
  assert.match(read('scripts/restore.js'), /sqlDump\.load\(/,
    'and the restore script must be the one that does call it');
});

/* ========================================================================== */
/* 2. NO SECRET LEAVES THE SERVER                                             */
/* ========================================================================== */

/* THE WORD IN PROSE IS NOT THE VALUE IN A VARIABLE, which is the whole
 * difficulty of this guard. Every one of these files talks about passphrases
 * constantly — in log lines meant for a person, in refusal sentences, in error
 * messages — and a guard that trips on the word would be switched off within a
 * week.
 *
 * So the string LITERALS are removed from each line first, and what is left is
 * the code. `console.warn('the stored passphrase cannot be read')` becomes
 * `console.warn()` and passes; `console.warn('pass:', passphrase)` keeps the
 * identifier and fails. That is exactly the distinction that matters, and
 * nothing weaker expresses it.
 */
const withoutStrings = (text) => text
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/* THE WHOLE FILE IS STRIPPED FIRST, then the calls are found in what is left.
   Stripping a call extracted by regex does not work: `(` and `)` appear inside
   a template's ${...}, so the extracted "call" ends mid-string and the opening
   backtick has no partner left to strip against. Found by running it. */
const bareCode = (file) => withoutStrings(code(file));

test('the passphrase value is never logged', () => {
  for (const file of SERVER_FILES) {
    const calls = bareCode(file).match(/(?:console\.(?:log|warn|error|info)|say|log)\s*\([^;]*/g) || [];
    /* `passphraseSet` and `passphraseForScheduler` are about whether one
       EXISTS, which is what the screen and the doctor need; the bare
       identifier is the value. */
    const leaking = calls.filter((call) => /\bpassphrase\b(?!Set|For|Confirm|_)/.test(call));
    assert.deepStrictEqual(leaking, [], `${file} logs a passphrase value: ${leaking.join(' | ')}`);
  }
});

test('no audit entry is built from a credential', () => {
  /* The runtime half of this — that no credential is in the log after a real
     run — is in tests/backup-routes.test.js, which reads the whole Activity Log
     back and searches it for a value generated for that run. This is the static
     half: the code that BUILDS an entry never names one. */
  const bare = bareCode('src/routes/backups.js');
  for (const call of bare.match(/req\.activity\([^;]*/g) || []) {
    assert.ok(!/\bpassphrase\b|\bpassword\b/.test(call),
      `an activity entry is built from a credential: ${call.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
});

test('the manifest carries no secret value', () => {
  const body = code('src/backup.js');
  const manifest = body.slice(body.indexOf('const manifest = {'), body.indexOf('const manifestJson'));
  assert.ok(manifest.length > 200, 'found the manifest');
  for (const bad of [/passphrase/i, /password/i, /\bsecretValue\b/, /process\.env\[/]) {
    assert.ok(!bad.test(manifest), `the manifest mentions ${bad}`);
  }
  /* WHAT IT DOES SAY about secrets is whether a bundle was INCLUDED, which is
     a fact about the package rather than a secret. */
  assert.match(manifest, /includesSecrets/);
});

test('the config snapshot records which variables are set, not what they are', () => {
  const body = code('src/backup.js');
  /* SECRET_ENV is the list of variables whose VALUES must never be written
     into config/environment.json. CONFIG_ENV is the list whose values may be.
     The two must not overlap, or a secret is in the package in clear. */
  const backup = require('../src/backup');
  const secret = new Set(backup.SECRET_ENV);
  const shared = backup.CONFIG_ENV.filter((name) => secret.has(name));
  assert.deepStrictEqual(shared, [],
    `these variables are in both lists, so their values would be written in clear: ${shared.join(', ')}`);
  /* And the obvious ones are on the secret list, so the list has not drifted
     away from what the application actually holds. */
  /* THE ONES THAT MATTER MOST, checked by name so the list cannot quietly lose
     one. EMAIL_PASSWORD is deliberately NOT here: this application keeps the
     mail password in the database, encrypted, rather than in the environment —
     a guard naming a variable nothing reads would be reassuring and empty. */
  for (const name of ['JWT_SECRET', 'DB_PASSWORD', 'DATABASE_URL', 'EMAIL_ENCRYPTION_KEY',
    'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'BOOTSTRAP_TOKEN']) {
    assert.ok(secret.has(name), `${name} must be treated as a secret`);
  }
  /* AND EVERY VARIABLE WHOSE NAME LOOKS LIKE A SECRET IS ON THAT LIST. The
     check above names what is here today; this one catches the next one
     somebody adds to CONFIG_ENV without thinking. */
  const suspicious = backup.CONFIG_ENV.filter((n) => /SECRET|PASSWORD|TOKEN|_KEY$|PRIVATE/i.test(n));
  assert.deepStrictEqual(suspicious, [],
    `these look like secrets and their values would be written in clear: ${suspicious.join(', ')}`);
  assert.ok(body.includes('SECRET_ENV'), 'and the snapshot is built from that list');
});

test('the list payload carries no path and no manifest', () => {
  const body = code('src/backup.js');
  const shape = body.slice(body.indexOf('function shape(row)'), body.indexOf('async function get('));
  assert.ok(shape.length > 100, 'found shape()');
  assert.ok(!/\bpath\b/.test(shape), 'a row must not carry a path');
  assert.ok(!/manifest/.test(shape), 'nor the manifest, which is large and is not the list\'s job');
});

/* ========================================================================== */
/* 3. THE WEB LAYER NEVER TAKES A PATH                                        */
/* ========================================================================== */

test('no route reads a filename or a path out of a request', () => {
  const routes = code('src/routes/backups.js');
  /* THE FILE NAME LIVES ONLY IN THE ROW. Every route finds its file by looking
     the id up and asking storage.resolveName() for the name the table holds —
     so a request cannot name a file, and a tampered row still cannot point
     outside the folder. */
  for (const bad of [
    /req\.(?:body|query|params)[^;\n]*\b(?:path|file|filename|dir|folder)\b/i,
    /path\.join\([^)]*req\./,
    /path\.resolve\([^)]*req\./,
  ]) {
    const hit = routes.match(bad);
    assert.strictEqual(hit, null, `src/routes/backups.js takes a path from the request: ${hit}`);
  }
  assert.match(routes, /storage\.resolveName\(row\.filename\)/,
    'and it resolves the name from the row');
});

test('resolveName refuses anything that is not a plain file name', () => {
  const storage = require('../src/backup-storage');
  for (const bad of ['../x', 'a/b', '/etc/passwd', '.', '..', '', null, undefined,
    'x/../../y', './x']) {
    assert.throws(() => storage.resolveName(bad),
      (err) => err.code === 'BACKUP_BAD_NAME' || err.code === 'BACKUP_DIR_INVALID',
      `resolveName accepted ${JSON.stringify(bad)}`);
  }
});

test('the restore script refuses an entry that climbs out of its root', () => {
  const body = read('scripts/restore.js');
  assert.match(body, /const inside = dest === path\.resolve\(root\)/,
    'the containment check is there');
  assert.match(body, /written\.skipped\.push\(entry\.name\)/,
    'and a bad entry is refused rather than sanitised');
});

/* ========================================================================== */
/* 4. ONE ENGINE                                                              */
/* ========================================================================== */

test('the page and the CLI go through the same engine', () => {
  /* A SECOND IMPLEMENTATION IS THE FAILURE MODE THIS GUARDS. A cron script
     that wrote its own tar would drift from the page within a release, and the
     day it mattered somebody would find the cron package had no database in
     it. Both front doors call into src/backup.js. */
  assert.match(read('scripts/backup.js'), /require\('\.\.\/src\/backup'\)/);
  assert.match(read('src/routes/backups.js'), /require\('\.\.\/backup'\)/);

  /* AND NEITHER FRONT DOOR BUILDS A PACKAGE ITSELF. */
  for (const file of ['scripts/backup.js', 'src/routes/backups.js']) {
    const body = code(file);
    for (const bad of [/tar-stream/, /createGzip/, /createCipheriv/]) {
      assert.ok(!bad.test(body), `${file} builds part of a package itself (${bad})`);
    }
  }
});

test('verification is not optional: the engine reads every package back', () => {
  const body = code('src/backup.js');
  /* `ok` MEANS "we wrote a file"; `verified` means "we read it back, the
     passphrase opens it, and every part hashes to what the manifest says". A
     backup in the first state is a hope, so the engine always does the second
     before reporting success — there is no flag to skip it. */
  assert.match(body, /verifyFile\(/, 'the engine verifies');
  assert.ok(!/skipVerify|noVerify|verify\s*=\s*false/.test(body),
    'there must be no way to skip verification');
  assert.match(body, /status = 'verified'/, 'and the row records that it happened');
});

/* ========================================================================== */
/* 5. THE TWO PERMISSIONS                                                     */
/* ========================================================================== */

test('both keys are dangerous, grantable, and Super Admin only by default', () => {
  const catalog = require('../src/permission-catalog');
  for (const key of ['backup.manage', 'backup.download']) {
    const def = catalog.BY_KEY.get(key);
    assert.ok(def, `${key} is not in the catalogue`);
    assert.ok(def.danger, `${key} must be marked dangerous`);
    assert.notStrictEqual(def.grantable, false,
      `${key} must be grantable — a studio with a systems person has to be able to delegate it`);
    assert.ok(def.label && def.label.length > 3, `${key} needs a label a person can read`);
  }

  /* AND NOBODY BUT THE SUPER ADMIN HOLDS EITHER OUT OF THE BOX. Asked of the
     catalogue's own baseline, which is what a fresh install gets. */
  const roles = require('../src/roles');
  const holders = { 'backup.manage': [], 'backup.download': [] };
  const allKeys = roles.roleKeys();
  assert.ok(allKeys.length > 20, `expected the full role list, saw ${allKeys.length}`);
  for (const roleKey of allKeys) {
    const baseline = catalog.baselineFor(roles.roleDef(roleKey));
    for (const key of Object.keys(holders)) {
      if (baseline.has ? baseline.has(key) : baseline.includes(key)) holders[key].push(roleKey);
    }
  }
  for (const key of Object.keys(holders)) {
    assert.deepStrictEqual(holders[key], ['super_admin'],
      `${key} is held by ${holders[key].join(', ') || 'nobody'} out of the box, not super_admin alone`);
  }
});

test('every route is behind one of them, and the dangerous ones behind a step-up', () => {
  const routes = code('src/routes/backups.js');
  const declared = [...routes.matchAll(/router\.(get|post|put|delete)\('([^']*)'/g)]
    .map(([, method, p]) => `${method.toUpperCase()} ${p}`);
  assert.ok(declared.length >= 7, `expected at least seven routes, saw ${declared.length}`);

  /* NOT ONE WITHOUT A PERMISSION. requirePermission appears on each handler
     rather than as a blanket router.use, because the download route needs the
     OTHER key — a blanket guard would silently give it the weaker one. */
  const guarded = (routes.match(/requirePermission\('backup\.(manage|download)'\)/g) || []).length;
  assert.strictEqual(guarded, declared.length,
    `${declared.length} routes but ${guarded} permission guards`);

  /* AND THE THREE THAT CHANGE SOMETHING IRREVERSIBLE OR LEAVE THE SERVER ASK
     FOR THE PASSWORD AGAIN. */
  assert.strictEqual((routes.match(/stepUp\.verify\(/g) || []).length, 3,
    'create, download and storing a schedule passphrase each ask for the password');
});

/* ========================================================================== */
/* 6. THE MIGRATION IS ADDITIVE                                               */
/* ========================================================================== */

test('the migration only adds, and is registered', () => {
  const body = read('src/migrate.js');
  const step = body.slice(body.indexOf('async function ensureBackupTables'),
    body.indexOf('async function ensureBackupTables') + 5000);
  assert.ok(step.length > 500, 'found the step');
  for (const bad of [/DROP TABLE(?! IF EXISTS `?backups_)/i, /DROP COLUMN/i, /TRUNCATE/i,
    /DELETE FROM (?!.*status = 'running')/i]) {
    assert.ok(!bad.test(step), `the backup migration does something destructive: ${bad}`);
  }
  assert.match(step, /CREATE TABLE IF NOT EXISTS backups/);
  assert.match(step, /CREATE TABLE IF NOT EXISTS backup_settings/);
  assert.match(step, /INSERT IGNORE INTO backup_settings/,
    'the one settings row is seeded, not replaced');
  assert.match(step, /schedule_enabled\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/,
    'and it ships with the schedule OFF');
  assert.match(body, /\['backups', ensureBackupTables\]/, 'the step is in STEPS');
});

/* ========================================================================== */
/* 7. THE PAGE                                                                */
/* ========================================================================== */

test('the Settings section is registered, contained and rendered', () => {
  const page = read('public/index.html').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(page, /\{ permission:'backup\.manage', label:'Backup', heading:'Backup'/,
    'backup.manage is not in SETTINGS_SECTIONS, so its holder cannot reach Settings at all');
  assert.match(page, /can\('backup\.manage'\) \? '<div id="backupSection"><\/div>' : ''/,
    'the container is missing or not gated by the key');
  assert.match(page, /if\(can\('backup\.manage'\)\) await renderBackupSettings\(\);/,
    'renderBackupSettings is never called');
  assert.match(page, /async function renderBackupSettings\(\)\{/, 'and it is not defined');
  assert.match(page, /<h3>Backup<\/h3>/, 'the h3 must match the registry heading exactly');
});

test('the page drops this section\'s cache when permissions change', () => {
  const page = read('public/index.html');
  const fn = page.slice(page.indexOf('function reapplyPermissionGates('),
    page.indexOf('async function applyPermissionChange('));
  assert.ok(fn.length > 100, 'found reapplyPermissionGates');
  assert.match(fn, /bkState\.data = null;/,
    'a newly granted holder would see a blank section without this');
  assert.match(fn, /clearInterval\(bkState\.poll\)/,
    'and a poll belonging to the old payload must not keep running');
});

test('the page offers no restore, and says where restoring lives', () => {
  const page = read('public/index.html');
  const section = page.slice(page.indexOf('async function renderBackupSettings()'),
    page.indexOf('async function renderChatSettings()'));
  assert.ok(section.length > 1000, 'found the section');
  assert.ok(!/api\('\/backups\/[^']*\/restore/.test(section), 'the page calls a restore route');
  assert.ok(!/id="bk_restore"/.test(section), 'the page has a restore button');
  assert.match(section, /Restoring is not on this screen/,
    'and it must say so, rather than leaving somebody hunting for the button');
  assert.match(section, /npm run restore/, 'and name the command that does it');
});

test('the two sentences that must not be softened come from the server', () => {
  const page = read('public/index.html');
  const section = page.slice(page.indexOf('async function renderBackupSettings()'),
    page.indexOf('async function renderChatSettings()'));
  /* THE WARNINGS ARE RENDERED FROM THE PAYLOAD, not written into the page, so
     the modules that own them are the only place they can be reworded. */
  assert.match(section, /warnings \|\| \{\}\)\.offsite/);
  assert.match(section, /warnings \|\| \{\}\)\.scheduler/);
  assert.match(read('public/index.html'), /warnings \|\| \{\}\)\.passphrase/);
});

/* ========================================================================== */
/* 8. THE DIAGNOSTIC IS READ-ONLY                                             */
/* ========================================================================== */

test('check-backup.js opens no package and writes nothing', () => {
  const body = code('scripts/check-backup.js');
  /* IT MUST NOT BE A WAY INTO A PACKAGE. Anyone with a shell on the server can
     read the files anyway — but a diagnostic that decrypted one would be a
     diagnostic somebody runs with a passphrase on the command line, where
     every account on the box can see it in `ps`. So it never obtains one and
     never opens anything. */
  for (const bad of [/openPackage/, /collectEntry/, /verifyFile/, /openSecretsBundle/,
    /passphraseForScheduler/, /createDecipheriv/, /--passphrase/]) {
    assert.ok(!bad.test(body),
      `the check must not be a way to get at a package's contents (${bad})`);
  }
  /* It reports whether a passphrase is SET, which is the whole point of the
     schedule check, and that is the only form the word takes here. */
  const mentions = body.match(/\bpassphrase\w*/g) || [];
  for (const word of mentions) {
    assert.ok(word === 'passphraseSet' || word === 'passphrase',
      `unexpected passphrase use in the doctor: ${word}`);
  }
  /* STRINGS STRIPPED BEFORE LOOKING FOR A WRITE, because the advice this
     script prints says things like "Delete an old package" — prose, not SQL. */
  const bare = withoutStrings(body);
  for (const bad of [/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i, /writeFile|mkdirSync|\brm\(|unlink/]) {
    assert.ok(!bad.test(bare), `the check must not write anything (${bad})`);
  }
  /* AND EVERY QUERY IT DOES MAKE IS A READ, asked of the modules it calls:
     it only uses lastGood, running, estimate, settings.current and
     storage.status, all of which are reads. */
  assert.ok(!/db\.query\(/.test(bare), 'the check writes no SQL of its own at all');
});

test('the health endpoint says whether there is a backup, and nothing more', () => {
  const body = code('src/server.js');
  const fn = body.slice(body.indexOf('async function backupHealth('),
    body.indexOf("app.get('/api/health'"));
  assert.ok(fn.length > 100, 'found backupHealth');
  /* UNAUTHENTICATED, so it must not name the folder, the file or the schedule. */
  for (const bad of [/filename/, /\bdir\b/, /schedule/, /passphrase/i]) {
    assert.ok(!bad.test(fn), `/api/health must not expose ${bad} to an unauthenticated caller`);
  }
  assert.match(fn, /catch\s*\{/, 'and it must never throw: a missing table is not a 503');
});
