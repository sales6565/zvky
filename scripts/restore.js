#!/usr/bin/env node
/* RESTORE FORGE FROM A BACKUP PACKAGE.
 *
 *   npm run restore -- <package> --dry-run          (always do this first)
 *   npm run restore -- <package>
 *   npm run restore -- <package> --passphrase-file ~/.forge-backup-pass
 *   npm run restore -- <package> --target-db zvky_restore_test
 *   npm run restore -- <package> --force            (overwrite a database with data in it)
 *   npm run restore -- <package> --code-to ~/forge-restored-code
 *   npm run restore -- <package> --secrets-to ~/forge-secrets
 *   npm run restore -- <package> --no-files
 *
 * ===========================================================================
 * WHY THERE IS NO BUTTON FOR THIS, which is the decision this file exists to
 * record.
 *
 * Taking a backup is safe: the worst outcome is a wasted twenty megabytes.
 * Restoring one DESTROYS the live studio — every asset, every timesheet, every
 * message written since the package was taken. There is no undo, and the person
 * who needs to do it is, by definition, having the worst day of the year.
 *
 * A web page cannot ask for that safely. It cannot prove who is at the keyboard
 * beyond a password that is in the database it is about to replace; it has no
 * way to be sure the request is not a tab somebody left open; and the one thing
 * it would need to do first — stop the application — is the thing that would
 * end the request. Any UI we built would have to be a wall of confirmations
 * whose only function is to make it hard, and a deliberately crippled button is
 * worse than no button, because it still looks like a feature.
 *
 * So restoring is an SSH command. It needs the server, the passphrase and the
 * file, which is a reasonable floor for an irreversible act, and it prints what
 * it is about to do and waits before doing any of it.
 *
 * ===========================================================================
 * WHAT IT DOES, IN ORDER, AND WHY THAT ORDER:
 *
 *   1. Verify the package — every part, against the manifest's hashes, with the
 *      passphrase. BEFORE anything is touched, because a half-restore from a
 *      damaged package is the worst of all outcomes: the old data is gone and
 *      the new data is incomplete.
 *   2. Print the plan: what is in the package, where it is going, what is about
 *      to be destroyed, and what the package does NOT contain.
 *   3. Stop, if --dry-run.
 *   4. Refuse a target database that is not empty, unless --force — and with
 *      --force, TAKE A BACKUP OF THAT DATABASE FIRST. The only honest way to
 *      offer an irreversible command is to make it reversible.
 *   5. Load the dump, statement by statement.
 *   6. Put the application's files back, each inside its own root, with any
 *      entry that tries to escape its root refused.
 *   7. Print the checklist of what a human still has to do.
 *
 * NOTHING IS WRAPPED IN A TRANSACTION, and that is not an oversight: MariaDB
 * commits DDL as it goes, so the DROP TABLE / CREATE TABLE pairs in the dump
 * cannot be rolled back. Step 4 is the real protection, which is why it is not
 * optional.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');

const backup = require('../src/backup');
const crypt = require('../src/backup-crypto');
const sqlDump = require('../src/sql-dump');

const USAGE = `Restore Forge from a backup package.

  npm run restore -- <package> [options]

  --dry-run                 verify the package and print the plan; change nothing
  --passphrase-file <path>  read the passphrase from a file (chmod 600)
  --target-db <name>        restore into this database instead of DB_NAME
  --force                   allow a target database that already has tables
                            (a backup of it is taken first, automatically)
  --code-to <dir>           also unpack the application's code into <dir>
  --secrets-to <dir>        also decrypt the environment bundle into <dir>
  --no-files                do not restore uploads, chat attachments or builds
  --yes                     do not ask for confirmation (for a scripted rebuild)
  --json                    machine-readable result

There is no --passphrase flag: a command line is visible to every account on the
server. Type it when asked, or put it in a file only your account can read.`;

function parse(argv) {
  const out = { files: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--no-files') out.files = false;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--passphrase-file') out.passphraseFile = argv[i += 1];
    else if (arg === '--target-db') out.targetDb = argv[i += 1];
    else if (arg === '--code-to') out.codeTo = argv[i += 1];
    else if (arg === '--secrets-to') out.secretsTo = argv[i += 1];
    else if (arg === '--passphrase') out.badFlag = arg;
    else if (arg.startsWith('-')) out.unknown = arg;
    else if (!out.file) out.file = arg;
    else out.unknown = arg;
  }
  return out;
}

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) { rl.question(question, (a) => { rl.close(); resolve(a); }); return; }
    process.stdout.write(question);
    const out = rl.output;
    rl._writeToOutput = () => {};
    rl.question('', (a) => { rl.close(); out.write('\n'); resolve(a); });
  });
}

async function passphraseFrom(opts, encrypted) {
  if (!encrypted) return null;
  if (opts.passphraseFile) {
    const file = path.resolve(opts.passphraseFile);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new Error(`There is no passphrase file at ${file}.`); }
    if (process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw new Error(`${file} can be read by other accounts on this server `
        + `(mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${file}`);
    }
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) {
    throw new Error('This package is encrypted and there is nothing attached to type a passphrase into. '
      + 'Pass --passphrase-file <path>.');
  }
  return ask('Passphrase for this package: ', { silent: true });
}

const MB = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;

/* ===========================================================================
 * THE TARGET, AND THE ONE SAFETY THAT MAKES THIS COMMAND OFFERABLE.
 */
async function openTarget(opts) {
  const config = backup.connectionConfig(process.env);
  if (!config.user || !(opts.targetDb || config.database)) {
    throw new Error('There is no database configuration to restore into. Run this from the '
      + 'application folder, where .env sets DB_HOST, DB_USER, DB_PASSWORD and DB_NAME — '
      + 'or pass --target-db.');
  }
  const database = opts.targetDb || config.database;
  let conn;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database,
      /* MULTIPLE STATEMENTS STAY OFF. The dump is sent one statement at a time
         by src/sql-dump.js's loader, which is what lets a failure name the
         statement that failed; turning this on would also mean a single
         malformed line could carry a second statement behind it. */
      multipleStatements: false,
      /* The dump's own session state (SET NAMES, FOREIGN_KEY_CHECKS) comes from
         the file, which is the point of the file carrying it. */
      charset: 'utf8mb4',
    });
  } catch (err) {
    if (err.code === 'ER_BAD_DB_ERROR') {
      throw new Error(`There is no database called "${database}" on ${config.host}. Create it first `
        + '(in cPanel: MySQL Databases), give the application\'s user ALL PRIVILEGES on it, '
        + 'and run this again.');
    }
    throw new Error(`Could not connect to the database: ${err.message}`);
  }
  return { conn, database, config };
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help || !opts.file) {
    process.stdout.write(`${USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  if (opts.badFlag) {
    process.stderr.write('There is no --passphrase flag, on purpose: a command line is visible to '
      + 'every account on this server through `ps`. Use --passphrase-file <path>, or type it when asked.\n');
    return 2;
  }
  if (opts.unknown) { process.stderr.write(`Unknown option "${opts.unknown}".\n\n${USAGE}\n`); return 2; }

  const say = (line = '') => { if (!opts.json) process.stdout.write(`${line}\n`); };

  /* ---- the file ------------------------------------------------------- */
  const file = path.resolve(opts.file);
  let stat;
  try { stat = await fsp.stat(file); } catch {
    process.stderr.write(`There is no file at ${file}.\n`);
    return 1;
  }
  if (!stat.isFile()) { process.stderr.write(`${file} is not a file.\n`); return 1; }

  /* THE HEADER IS READ FIRST, unencrypted, because it is what says whether a
     passphrase is needed at all — asking for one before knowing would be
     theatre, and refusing to say would be unhelpful. */
  let header;
  try {
    const fd = await fsp.open(file, 'r');
    const head = Buffer.alloc(Math.min(64 * 1024, stat.size));
    await fd.read(head, 0, head.length, 0);
    await fd.close();
    ({ header } = crypt.readHeader(head));
  } catch (err) {
    process.stderr.write(`${file} is not a Forge backup package: ${err.message}\n`);
    return 1;
  }

  const passphrase = await passphraseFrom(opts, header.encrypted);

  /* ---- 1. verify, before anything is touched -------------------------- */
  say(`Verifying ${path.basename(file)} (${MB(stat.size)})…`);
  let report;
  try {
    report = await backup.verifyFile(file, { passphrase });
  } catch (err) {
    process.stderr.write(`\n${err.message}\n`);
    return 1;
  }
  if (!report.ok) {
    process.stderr.write('\nThis package did not verify, so nothing has been restored:\n');
    for (const problem of String(report.error || '').split('; ')) {
      process.stderr.write(`  - ${problem}\n`);
    }
    process.stderr.write('\nDo not restore from it. Use an earlier package.\n');
    return 1;
  }
  const manifest = report.manifest;
  say(`  every part matches the manifest (${report.parts} parts).`);

  /* ---- 2. the plan ---------------------------------------------------- */
  const target = await openTarget(opts).catch((err) => { process.stderr.write(`${err.message}\n`); return null; });
  if (!target) return 1;
  const here = await sqlDump.occupancy(target.conn);
  const roots = backup.fileRoots({ env: process.env });

  say();
  say('  THE PACKAGE');
  say(`    taken          ${manifest.createdAt}`);
  say(`    by             ${manifest.createdByLabel || manifest.createdBy} (${manifest.trigger})`);
  say(`    Forge          ${manifest.versions.forge}${manifest.versions.commit ? ` at ${manifest.versions.commit}` : ''}`);
  say(`    node           ${manifest.versions.node}`);
  say(`    database       ${manifest.database.name} on ${manifest.versions.database}`);
  say(`    contents       ${manifest.database.tableCount} tables, ${manifest.database.rowCount.toLocaleString('en-GB')} rows, `
    + `${manifest.files.count} files (${MB(manifest.files.bytes)})`);
  say(`    encrypted      ${manifest.encrypted ? 'yes' : 'NO'}`);
  say(`    secrets        ${manifest.includesSecrets ? 'yes, in secrets.enc' : 'not included'}`);
  say();
  say('  WHAT THIS WILL DO');
  say(`    database       ${target.database} on ${target.config.host}`);
  if (here.empty) {
    say('                   it is empty, so the dump will simply be loaded into it.');
  } else {
    say(`                   IT ALREADY HAS ${here.tables.length} TABLE(S)${here.views.length ? ` AND ${here.views.length} VIEW(S)` : ''}.`);
    say('                   Every one of them will be DROPPED and replaced by the');
    say('                   package\'s. Everything in them that is not also in the');
    say('                   package is destroyed.');
  }
  if (opts.files) {
    for (const root of roots) say(`    files          ${root.dir}  (${root.key})`);
    say('                   files in the package are written over files of the same name;');
    say('                   anything else already there is left alone.');
  } else {
    say('    files          NOT restored (--no-files).');
  }
  if (opts.codeTo) say(`    code           unpacked into ${path.resolve(opts.codeTo)}`);
  if (opts.secretsTo) say(`    secrets        decrypted into ${path.resolve(opts.secretsTo)}`);
  say();
  say('  WHAT THE PACKAGE DOES NOT CONTAIN');
  for (const line of manifest.excluded || []) say(`    - ${line}`);
  say();

  if (opts.dryRun) {
    say('  --dry-run: nothing was changed. Run it again without --dry-run to restore.');
    await target.conn.end();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, verified: true,
        manifest: { createdAt: manifest.createdAt, tables: manifest.database.tableCount,
          rows: manifest.database.rowCount, files: manifest.files.count },
        target: { database: target.database, empty: here.empty, tables: here.tables.length } })}\n`);
    }
    return 0;
  }

  /* ---- 4. the refusal, and the pre-restore backup --------------------- */
  if (!here.empty && !opts.force) {
    await target.conn.end();
    process.stderr.write(`\n"${target.database}" already has ${here.tables.length} table(s) in it, and a `
      + 'restore would destroy everything in them.\n\n'
      + 'If that is what you want, run it again with --force: a full backup of this database is '
      + 'taken first, automatically, before anything is dropped.\n\n'
      + 'If it is not, pass --target-db <name> to restore into an empty database instead and '
      + 'compare the two.\n');
    return 1;
  }

  if (!opts.yes && process.stdin.isTTY) {
    const want = here.empty ? 'restore' : target.database;
    const answer = await ask(`  Type "${want}" to go ahead: `);
    if (String(answer).trim() !== want) {
      await target.conn.end();
      process.stderr.write('Stopped; nothing was changed.\n');
      return 1;
    }
    say();
  }

  if (!here.empty) {
    say('Taking a backup of the database that is about to be replaced…');
    if (!passphrase) {
      await target.conn.end();
      process.stderr.write('The pre-restore backup needs a passphrase to encrypt it, and this package '
        + 'is unencrypted so there is none to reuse. Take a backup yourself first — '
        + '`npm run backup` — and then run this again.\n');
      return 1;
    }
    const db = require('../src/db');
    try {
      const safety = await backup.create(db, {
        passphrase,
        encrypt: true,
        includeSecrets: false,
        trigger: 'pre-restore',
        userId: null,
        userLabel: `the restore command, before overwriting ${target.database}`,
        dbConfig: { ...target.config, database: target.database },
        onProgress: ({ stage, percent }) => say(`  ${String(percent).padStart(3)}%  ${stage}`),
      });
      say(`  ${safety.filename} (${MB(safety.size)}), verified.`);
      say('  IT IS ENCRYPTED WITH THE SAME PASSPHRASE AS THE PACKAGE YOU ARE RESTORING.');
      say();
    } catch (err) {
      await target.conn.end();
      await db.end().catch(() => {});
      process.stderr.write(`\nThe pre-restore backup failed, so nothing has been changed: ${err.message}\n\n`
        + 'Fix that first. A restore without a way back is not one this command will do.\n');
      return 1;
    }
    await db.end().catch(() => {});
  }

  /* ---- 5, 6. one pass over the package -------------------------------- */
  const written = { statements: 0, files: 0, bytes: 0, skipped: [] };
  const rootByKey = new Map(roots.map((r) => [r.key, r.dir]));
  let codeBytes = 0;

  say('Restoring…');
  try {
    await backup.openPackage(file, {
      passphrase,
      onEntry: async (entry, body) => {
        const drain = async () => { for await (const chunk of body) void chunk; };

        if (entry.type === '5') return drain();

        if (entry.name === 'database/dump.sql') {
          const result = await sqlDump.load({
            conn: target.conn,
            source: body,
            onProgress: ({ statements }) => process.stderr.write(`\r  database: ${statements} statements`),
          });
          process.stderr.write('\r  database: '
            + `${result.statements} statements, ${MB(result.bytes)} of SQL          \n`);
          written.statements = result.statements;
          return undefined;
        }

        if (entry.name === 'code/app.tar') {
          if (!opts.codeTo) return drain();
          const into = path.resolve(opts.codeTo);
          await fsp.mkdir(into, { recursive: true });
          const out = fs.createWriteStream(path.join(into, 'app.tar'), { mode: 0o600 });
          for await (const chunk of body) { codeBytes += chunk.length; out.write(chunk); }
          await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
          return undefined;
        }

        if (entry.name === 'secrets.enc') {
          if (!opts.secretsTo) return drain();
          const chunks = [];
          for await (const chunk of body) chunks.push(chunk);
          const into = path.resolve(opts.secretsTo);
          await fsp.mkdir(into, { recursive: true, mode: 0o700 });
          const bundle = backup.openSecretsBundle(Buffer.concat(chunks), passphrase);
          const dest = path.join(into, 'env-from-backup.json');
          await fsp.writeFile(dest, JSON.stringify(bundle, null, 2), { mode: 0o600 });
          written.secrets = dest;
          return undefined;
        }

        if (entry.name.startsWith('files/')) {
          if (!opts.files) return drain();
          const [, key, ...rest] = entry.name.split('/');
          const root = rootByKey.get(key);
          if (!root || !rest.length) { written.skipped.push(entry.name); return drain(); }

          /* AN ENTRY THAT TRIES TO LEAVE ITS ROOT IS REFUSED, not sanitised.
             A tar whose names contain `../` is the classic way to write over
             anything the process can reach, and this command runs as the
             account that owns the application. The package we wrote cannot
             contain one; a package somebody else handed over might. */
          const dest = path.resolve(root, rest.join('/'));
          const inside = dest === path.resolve(root)
            || dest.startsWith(path.resolve(root) + path.sep);
          if (!inside) { written.skipped.push(entry.name); return drain(); }

          await fsp.mkdir(path.dirname(dest), { recursive: true });
          const out = fs.createWriteStream(dest, { mode: 0o600 });
          let bytes = 0;
          for await (const chunk of body) { bytes += chunk.length; out.write(chunk); }
          await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
          written.files += 1;
          written.bytes += bytes;
          if (written.files % 50 === 0) process.stderr.write(`\r  files: ${written.files}`);
          return undefined;
        }

        return drain();                            // manifest.json, config, RESTORE.md
      },
    });
    if (written.files) process.stderr.write(`\r  files: ${written.files} written (${MB(written.bytes)})      \n`);
  } catch (err) {
    await target.conn.end().catch(() => {});
    process.stderr.write(`\nThe restore stopped part-way through: ${err.message}\n\n`);
    if (written.statements) {
      process.stderr.write('THE DATABASE IS NOW IN A HALF-RESTORED STATE. Do not start the '
        + 'application against it. Fix the cause and run this command again from the beginning — '
        + 'the dump drops and recreates every table, so a second run over a half-restored '
        + 'database is safe.\n');
    }
    return 1;
  }

  await target.conn.end();

  /* ---- 7. the checklist ----------------------------------------------- */
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, verified: true, database: target.database,
      statements: written.statements, files: written.files, bytes: written.bytes,
      skipped: written.skipped, secrets: written.secrets || null })}\n`);
    return 0;
  }

  say();
  say(`  ${target.database}: ${written.statements} statements applied.`);
  if (opts.files) say(`  files: ${written.files} restored (${MB(written.bytes)}).`);
  if (written.skipped.length) {
    say(`  ${written.skipped.length} entr${written.skipped.length === 1 ? 'y was' : 'ies were'} REFUSED `
      + 'because the name did not belong inside a known folder:');
    for (const name of written.skipped.slice(0, 10)) say(`    ${name}`);
  }
  if (opts.codeTo) say(`  code: ${path.join(path.resolve(opts.codeTo), 'app.tar')} (${MB(codeBytes)}) — `
    + `unpack it with: tar -xf app.tar -C <folder>`);
  if (written.secrets) {
    say(`  secrets: ${written.secrets} — set them in .env and then DELETE that file.`);
  }
  say();
  say('  WHAT IS STILL LEFT TO DO BY HAND');
  say('    1. The code. Unpack code/app.tar into the application folder (--code-to above),');
  say('       then `npm ci` — node_modules is deliberately not in the package, because the');
  say('       lockfile is, and reinstalling is both smaller and safer than copying binaries');
  say('       between machines.');
  say('    2. The environment. .env is not in the package unless it was taken with');
  say('       --secrets. Set DB_*, JWT_SECRET, CHAT_UPLOAD_DIR, BACKUP_DIR and the rest from');
  say('       the studio\'s own records. JWT_SECRET being different only logs everybody out;');
  say('       EMAIL_ENCRYPTION_KEY being different makes stored email and integration');
  say('       secrets unreadable, so that one matters.');
  say('    3. Start the application. src/migrate.js runs at every start and brings the');
  say('       restored schema up to whatever the code expects, so do this before judging');
  say('       anything missing.');
  say('    4. THE OFFICE FILE SERVER. Forge never held the project files — it holds links');
  say('       to a share your own server owns. Nothing in this package restores them, and');
  say('       nothing in this package was ever going to. Restore that share from its own');
  say('       backup, and the gateway\'s configuration from the machine\'s own backup.');
  say('    5. Log in and check: one project\'s assets, one timesheet week, one chat');
  say('       conversation with an attachment, and Settings → Backup.');
  say();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
