#!/usr/bin/env node
/* TAKE A FULL BACKUP OF FORGE FROM THE COMMAND LINE.
 *
 *   npm run backup                              (asks for a passphrase, twice)
 *   npm run backup -- --passphrase-file ~/.forge-backup-pass
 *   npm run backup -- --no-encrypt              (refuses unless you mean it)
 *   npm run backup -- --keep 14                 (and prune to the newest 14)
 *   npm run backup -- --no-prune
 *   npm run backup -- --secrets                 (include the encrypted .env bundle)
 *   npm run backup -- --json
 *
 * ===========================================================================
 * THE SAME ENGINE AS THE BUTTON, and that is the whole point of this file being
 * sixty lines of argument handling and nothing else. src/backup.js decides what
 * a backup IS — what goes in, what is excluded, how it is encrypted, how it is
 * verified afterwards. A cron line that wrote its own tar would drift away from
 * the page within a release, and the day it mattered would be the day somebody
 * discovered the cron package had no database in it.
 *
 * So: one engine, two front doors. This one exists because the web page cannot
 * be a cron job, and because a studio locked out of its own application still
 * needs to be able to take a backup over SSH.
 *
 * ===========================================================================
 * THE CRON LINE, for cPanel's Cron Jobs screen (one line, no wrapping):
 *
 *   cd /home/<cpanel-account>/forge && /usr/bin/node scripts/backup.js \
 *     --passphrase-file /home/<cpanel-account>/.forge-backup-pass >> \
 *     /home/<cpanel-account>/logs/forge-backup.log 2>&1
 *
 * ...at whatever time the studio wants, usually "0 2 * * *". The passphrase file
 * must be chmod 600 and OUTSIDE the application folder, so a deploy cannot
 * replace it and the web server cannot serve it. Everything this prints goes to
 * the log named above; the exit status is 0 for a verified package and non-zero
 * for anything else, which is what makes it usable by a monitor.
 *
 * ONE OR THE OTHER, NOT BOTH. If the in-app schedule is switched on, do not add
 * this cron line as well: they would both run and you would have two packages a
 * night. The cron line is the better choice on a host that suspends an idle
 * application, because a suspended application runs no timers.
 *
 * ===========================================================================
 * THE PASSPHRASE IS NEVER STORED BY THIS SCRIPT, never printed, and never put
 * in a process argument — --passphrase-file takes a PATH, not a value, because
 * anything on the command line is visible to every account on the box through
 * `ps`. There is deliberately no --passphrase flag.
 *
 * IF THE PASSPHRASE IS LOST, THE PACKAGE CANNOT BE OPENED. Not by us, not by
 * anybody. Keep it in the studio's password manager, not on this server.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const db = require('../src/db');
const backup = require('../src/backup');
const crypt = require('../src/backup-crypto');
const storage = require('../src/backup-storage');

function parse(argv) {
  const out = { encrypt: true, secrets: false, keep: null, prune: true, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-encrypt') out.encrypt = false;
    else if (arg === '--secrets') out.secrets = true;
    else if (arg === '--no-prune') out.prune = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--passphrase-file') out.passphraseFile = argv[i += 1];
    else if (arg === '--keep') out.keep = Number(argv[i += 1]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--passphrase') out.badFlag = arg;
    else out.unknown = arg;
  }
  return out;
}

const USAGE = `Take a full backup of Forge: code, database, uploaded files and configuration.

  npm run backup
  npm run backup -- --passphrase-file <path>   read the passphrase from a file (chmod 600)
  npm run backup -- --no-encrypt               write the package unencrypted (see below)
  npm run backup -- --secrets                  include the encrypted environment bundle
  npm run backup -- --keep <n> | --no-prune    retention after this backup
  npm run backup -- --json                     machine-readable result
  npm run backup -- --quiet                    only errors

There is no --passphrase flag: a command line is visible to every account on the
server. Type it when asked, or put it in a file only your account can read.

--no-encrypt writes every password hash, token and encrypted setting in this
studio to a file anybody who can read the folder can open. It is there for one
honest case — moving a studio onto a new server down a private channel — and the
manifest records that the package is unencrypted.`;

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) { rl.question(question, (a) => { rl.close(); resolve(a); }); return; }
    /* NOT ECHOED. readline has no password mode, so the prompt is written by
       hand and the keystrokes are swallowed by muting the output stream. */
    process.stdout.write(question);
    const out = rl.output;
    rl._writeToOutput = () => {};
    rl.question('', (a) => {
      rl.close();
      out.write('\n');
      resolve(a);
    });
  });
}

async function passphraseFrom(opts) {
  if (!opts.encrypt) return null;

  if (opts.passphraseFile) {
    const file = path.resolve(opts.passphraseFile);
    let stat;
    try { stat = fs.statSync(file); } catch {
      throw new Error(`There is no passphrase file at ${file}.`);
    }
    /* A WORLD-READABLE PASSPHRASE FILE IS A REFUSAL, not a warning. The whole
       value of the file over a command-line flag is that other accounts on a
       shared host cannot read it, and a shrug here would quietly remove that. */
    if (process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw new Error(`${file} can be read by other accounts on this server `
        + `(mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${file}`);
    }
    const value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    const strong = crypt.strength(value);
    if (!strong.ok) throw new Error(`The passphrase in ${file} is not usable: ${strong.message}`);
    return value;
  }

  if (!process.stdin.isTTY) {
    throw new Error('No passphrase, and nothing is attached to type one into. '
      + 'Pass --passphrase-file <path> (chmod 600), which is what a cron job uses.');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await ask('Passphrase for this backup: ', { silent: true });
    const strong = crypt.strength(first);
    if (!strong.ok) { process.stdout.write(`  ${strong.message}\n`); continue; }
    const again = await ask('Again: ', { silent: true });
    if (first !== again) { process.stdout.write('  Those do not match.\n'); continue; }
    process.stdout.write(`\n  ${crypt.LOST_PASSPHRASE_WARNING}\n\n`);
    return first;
  }
  throw new Error('No usable passphrase after three attempts.');
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (opts.badFlag) {
    process.stderr.write('There is no --passphrase flag, on purpose: a command line is visible to '
      + 'every account on this server through `ps`. Use --passphrase-file <path>, or type it when asked.\n');
    return 2;
  }
  if (opts.unknown) {
    process.stderr.write(`Unknown option "${opts.unknown}".\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.keep !== null && (!Number.isFinite(opts.keep) || opts.keep < 1)) {
    process.stderr.write('--keep takes a whole number of backups to keep, at least 1.\n');
    return 2;
  }

  const say = (line) => { if (!opts.quiet && !opts.json) process.stdout.write(`${line}\n`); };

  if (!opts.encrypt) {
    say('');
    say('  An UNENCRYPTED package contains every password hash, API token and');
    say('  encrypted setting in this studio, readable by anybody who can read the');
    say('  file. The manifest will record that it is unencrypted.');
    say('');
    if (process.stdin.isTTY) {
      const answer = await ask('  Type "unencrypted" to continue: ');
      if (String(answer).trim() !== 'unencrypted') {
        process.stderr.write('Stopped; nothing was written.\n');
        return 1;
      }
    }
  }

  const where = storage.status({ refresh: true });
  if (!where.ok) {
    process.stderr.write(`${where.problems.map((p) => p.message).join('\n')}\n`);
    return 1;
  }
  say(`Backup folder: ${where.dir}`);

  const passphrase = await passphraseFrom(opts);

  /* The engine's progress, as lines rather than a percentage bar: this output
     goes to a cron log as often as to a terminal, and a redrawn bar in a log
     file is unreadable. One line per stage, deduplicated. */
  let lastStage = null;
  const onProgress = ({ stage, percent, detail }) => {
    if (stage === lastStage) return;
    lastStage = stage;
    say(`  ${String(percent).padStart(3)}%  ${stage}${detail ? ` — ${detail}` : ''}`);
  };

  const started = Date.now();
  let made;
  try {
    made = await backup.create(db, {
      passphrase,
      encrypt: opts.encrypt,
      includeSecrets: opts.secrets,
      trigger: 'cli',
      userId: null,
      userLabel: `the command line (${process.env.USER || process.env.LOGNAME || 'unknown account'})`,
      keepLast: opts.prune ? opts.keep : false,
      onProgress,
    });
  } catch (err) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: err.code || null, error: err.message })}\n`);
    else process.stderr.write(`\nThe backup failed: ${err.message}\n`);
    return 1;
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      id: made.id,
      filename: made.filename,
      size: made.size,
      sha256: made.sha256,
      encrypted: made.encrypted,
      verified: made.verified,
      seconds,
    })}\n`);
    return 0;
  }

  say('');
  say(`  ${made.filename}`);
  say(`  ${(made.size / 1048576).toFixed(1)} MB, ${made.encrypted ? 'encrypted' : 'NOT ENCRYPTED'}, verified after writing, in ${seconds}s`);
  say(`  sha256 ${made.sha256}`);
  say('');
  say('  A backup kept only on this server is not a safe backup: the thing most');
  say('  likely to destroy the database is the thing holding the backup. Copy it');
  say('  somewhere else, and keep the passphrase somewhere other than beside it.');
  say('');
  return 0;
}

main()
  .then(async (code) => { await db.end().catch(() => {}); process.exit(code); })
  .catch(async (err) => {
    process.stderr.write(`${err.message}\n`);
    await db.end().catch(() => {});
    process.exit(1);
  });
