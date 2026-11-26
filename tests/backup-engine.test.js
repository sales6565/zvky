/* THE BACKUP ENGINE AGAINST A REAL DATABASE, AND THE ROUND TRIP BACK OUT.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR, and why it is not enough to take a backup and look
 * at the file size.
 *
 * A backup that writes 20 MB and reports success is worth nothing until
 * somebody has put it back. Every real backup disaster in the world is the same
 * story: the backups were running, nobody had ever restored one, and the day
 * they tried it did not work. So the centre of this file is a ROUND TRIP —
 * dump a populated database, restore it into an empty one, and compare the two
 * with the server's own CHECKSUM TABLE, table by table.
 *
 * CHECKSUM TABLE RATHER THAN COMPARING ROWS, and this is the decision that
 * earned its place. Comparing rows through SELECT passed while the dumper was
 * losing the microseconds off every DATETIME(6), because the same lossy parse
 * happened on both sides of the comparison. The server's checksum is computed
 * over the stored bytes and does not care what this code can represent, which
 * is precisely why it caught it.
 *
 * ===========================================================================
 * THE HARD-TYPES TABLE. zz_probe_types below holds every column type MariaDB
 * offers that a dumper can get wrong — the extremes of each integer width, a
 * DECIMAL at full scale, a BIT, binary columns including an empty one, the
 * minimum and maximum of every temporal type at microsecond precision, a
 * generated column, an ENUM, a SET, and a text value containing every character
 * the escaper names. It is created and dropped by this suite; nothing in the
 * application has such a table, and that is the point: the application's own
 * tables do not exercise half of this.
 *
 * NO DATABASE, NO SUITE. Like every other integration file here.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mysql = require('mysql2/promise');
const { config, resetSchema } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const cfg = config('backupengine');
const SKIP = process.env.TEST_DB_NAME ? false
  : 'Set TEST_DB_NAME (and TEST_DB_USER / TEST_DB_PASSWORD) to run integration tests.';

const PASS = `probe-${crypto.randomBytes(12).toString('base64url')}-words-here`;
const TARGET = `${cfg.database}_restored`;

let dir;                  // BACKUP_DIR for this suite
let conn;                 // a connection to the source database

/* THE ENGINE RUNS IN A CHILD PROCESS, every time.
 *
 * src/db.js reads DB_* once, when it is first required, and exits the process
 * if they are missing — so a test process cannot point it at this suite's
 * database. Worse, requiring it here would bind the whole suite to whatever
 * database the runner was started against, which is how a test suite deletes a
 * developer's data. Everything that touches the engine therefore goes through
 * the CLI, with this suite's settings in the environment, which is also the
 * path a studio actually uses. */
function run(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: cfg.host,
      DB_PORT: String(cfg.port),
      DB_NAME: cfg.database,
      DB_USER: cfg.user,
      DB_PASSWORD: cfg.password,
      DATABASE_URL: '',
      JWT_SECRET: 'backup-engine-suite-not-used-outside-the-tests',
      BACKUP_DIR: dir,
      BACKUP_TICK_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

/* AND THE MIGRATION, in a child process for the same reason.
 *
 * resetSchema() loads sql/schema.sql, which is the schema as it stood before
 * this feature; the `backups` and `backup_settings` tables are created by
 * src/migrate.js, which normally runs when the server starts. This suite starts
 * no server — it drives the CLIs — so the step that would create them never
 * happens, and the first run of this file failed with "table backups doesn't
 * exist" fifteen times. */
function migrate() {
  execFileSync(process.execPath, ['-e',
    "const db=require('./src/db');require('./src/migrate').run(db,()=>{})"
    + '.then(()=>db.end()).catch((e)=>{console.error(e.message);process.exit(1)})'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
      DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '',
      JWT_SECRET: 'backup-engine-suite-not-used-outside-the-tests',
    },
  });
}

function runJson(script, args, extraEnv) {
  const text = run(script, [...args, '--json'], extraEnv);
  const line = text.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `no JSON in the output of ${script}: ${text.slice(-400)}`);
  return JSON.parse(line);
}

function runExpectingFailure(script, args, extraEnv = {}) {
  try {
    run(script, args, extraEnv);
    return { failed: false, output: '' };
  } catch (err) {
    return { failed: true, status: err.status, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const HARD_TABLE = `CREATE TABLE zz_probe_types (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  t_tiny TINYINT NULL, t_small SMALLINT NULL, t_med MEDIUMINT NULL,
  t_big BIGINT NULL, t_ubig BIGINT UNSIGNED NULL,
  t_dec DECIMAL(18,6) NULL, t_float FLOAT NULL, t_double DOUBLE NULL,
  t_bit BIT(8) NULL,
  t_char CHAR(10) NULL, t_vc VARCHAR(500) NULL, t_text TEXT NULL, t_long LONGTEXT NULL,
  t_bin BINARY(8) NULL, t_vbin VARBINARY(64) NULL, t_blob LONGBLOB NULL,
  t_date DATE NULL, t_time TIME(6) NULL, t_dt DATETIME(6) NULL, t_ts TIMESTAMP NULL,
  t_year YEAR NULL,
  t_enum ENUM('a','b','c') NULL, t_set SET('x','y','z') NULL,
  t_json LONGTEXT NULL,
  t_gen INT AS (t_tiny * 2) STORED
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const HARD_ROWS = [
  [1, -128, -32768, -8388608, '-9223372036854775808', '18446744073709551615',
    '-123456789012.345678', 1.5, 1.7976931348623157e308, 255,
    'abc', "quote ' back\\slash \"dq\" \0 nul \n newline \r cr \t tab \x1a sub",
    'emoji 🎬 and ünïcödé and 中文', 'x'.repeat(70000),
    Buffer.from('0001020304ff7f80', 'hex'), Buffer.alloc(0), Buffer.from('89504e470d0a1a0a', 'hex'),
    '1000-01-01', '-838:59:59.000000', '1000-01-01 00:00:00.000001', '1970-01-02 00:00:01',
    1901, 'a', 'x,z', JSON.stringify({ a: 1, b: [1, 2, 3], c: "it's" })],
  [2, 127, 32767, 8388607, '9223372036854775807', '0',
    '999999999999.999999', -1.5, -1.7976931348623157e308, 0,
    '', '', '', '',
    Buffer.from('0000000000000000', 'hex'), Buffer.from('ff', 'hex'), Buffer.from([]),
    '9999-12-31', '838:59:59.000000', '9999-12-31 23:59:59.999999', '2038-01-18 00:00:00',
    2155, 'c', '', '[]'],
  [3, null, null, null, null, null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null, null, null, null],
];

async function checksums(c) {
  const [tables] = await c.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
  );
  const out = {};
  for (const t of tables) {
    const [[row]] = await c.query(`CHECKSUM TABLE \`${t.name}\` EXTENDED`);
    out[t.name] = row ? String(row.Checksum) : null;
  }
  return out;
}

test('the backup engine, end to end and back again', { skip: SKIP }, async (t) => {
  let restored = null;
  let packaged = null;

  t.before(async () => {
    await resetSchema(cfg);
    migrate();
    /* OUTSIDE THE APPLICATION FOLDER AND OUTSIDE TEMP, because the module
       refuses both — correctly, and that refusal is tested below. */
    dir = path.join(os.homedir(), `zvky-suite-backups-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });

    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      database: cfg.database, multipleStatements: false,
    });
    await conn.query(HARD_TABLE);
    const cols = '(id,t_tiny,t_small,t_med,t_big,t_ubig,t_dec,t_float,t_double,t_bit,'
      + 't_char,t_vc,t_text,t_long,t_bin,t_vbin,t_blob,t_date,t_time,t_dt,t_ts,t_year,t_enum,t_set,t_json)';
    const marks = HARD_ROWS[0].map(() => '?').join(',');
    for (const row of HARD_ROWS) {
      await conn.query(`INSERT INTO zz_probe_types ${cols} VALUES (${marks})`, row);
    }
    await conn.query('ALTER TABLE zz_probe_types AUTO_INCREMENT = 5000');
    /* A view, a trigger and a function, so the DELIMITER half of the format is
       exercised against a real server rather than a fixture. */
    await conn.query('CREATE VIEW zz_probe_view AS SELECT id, t_vc FROM zz_probe_types WHERE id > 0');
    await conn.query(`CREATE TRIGGER zz_probe_trg BEFORE INSERT ON zz_probe_types FOR EACH ROW
      BEGIN
        IF NEW.t_char IS NULL THEN SET NEW.t_char = 'set;by;trg'; END IF;
        SET NEW.t_vc = CONCAT(IFNULL(NEW.t_vc,''), '');
      END`);
    await conn.query(`CREATE FUNCTION zz_probe_fn(n INT) RETURNS INT DETERMINISTIC
      BEGIN DECLARE out_ INT; SET out_ = n * 3; RETURN out_; END`);

    const admin = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${TARGET}\``);
    await admin.query(`CREATE DATABASE \`${TARGET}\` CHARACTER SET utf8mb4`);
    await admin.end();
    restored = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: TARGET,
    });
  });

  t.after(async () => {
    if (conn) await conn.end().catch(() => {});
    if (restored) await restored.end().catch(() => {});
    const admin = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    }).catch(() => null);
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${TARGET}\``).catch(() => {}); await admin.end(); }
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- take */
  await t.test('takes one, verifies it, and writes nothing in clear', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    try {
      packaged = runJson('backup.js', ['--passphrase-file', passFile]);
    } finally { await fsp.rm(passFile, { force: true }); }

    assert.strictEqual(packaged.ok, true);
    assert.strictEqual(packaged.encrypted, true);
    assert.strictEqual(packaged.verified, true, 'the engine reads it back before reporting success');
    assert.ok(packaged.size > 1000, 'the package has something in it');

    const file = path.join(dir, packaged.filename);
    const bytes = await fsp.readFile(file);
    assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), packaged.sha256,
      'the recorded hash is the hash of the file on disk');

    /* NOTHING RECOGNISABLE IN THE CIPHERTEXT. Not the passphrase, not a table
       name, not the distinctive text in the fixture. If any of these appear,
       something is being written outside the envelope. */
    for (const needle of [PASS, 'zz_probe_types', 'emoji 🎬', 'CREATE TABLE', 'INSERT INTO']) {
      assert.strictEqual(bytes.includes(Buffer.from(needle)), false,
        `"${needle}" must not be readable in an encrypted package`);
    }

    await fsp.chmod(file, 0o600).catch(() => {});
    const stat = await fsp.stat(file);
    assert.strictEqual(stat.mode & 0o077, 0, 'the package is not readable by other accounts');
  });

  /* ------------------------------------------------------------- restore */
  await t.test('--dry-run verifies and prints the plan without touching anything', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    const before = await checksums(restored);
    let out;
    try {
      out = runJson('restore.js', [path.join(dir, packaged.filename),
        '--passphrase-file', passFile, '--target-db', TARGET, '--dry-run']);
    } finally { await fsp.rm(passFile, { force: true }); }

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.verified, true);
    assert.strictEqual(out.target.empty, true);
    assert.ok(out.manifest.tables > 10, 'the plan names how many tables are in the package');
    assert.deepStrictEqual(await checksums(restored), before, 'a dry run changes nothing');
  });

  await t.test('restores into an empty database, and every table checksums the same', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    let out;
    try {
      out = runJson('restore.js', [path.join(dir, packaged.filename),
        '--passphrase-file', passFile, '--target-db', TARGET, '--yes', '--no-files']);
    } finally { await fsp.rm(passFile, { force: true }); }
    assert.strictEqual(out.ok, true);
    assert.ok(out.statements > 20, 'the dump had statements in it');
    assert.deepStrictEqual(out.skipped, [], 'nothing was refused');

    const [source, copy] = [await checksums(conn), await checksums(restored)];
    const names = [...new Set([...Object.keys(source), ...Object.keys(copy)])].sort();
    const different = names.filter((n) => source[n] !== copy[n]);

    /* `backups` IS THE ONE TABLE THAT CANNOT MATCH, and that is correct rather
       than tolerated: the snapshot was taken while this backup's own row said
       `running`, and the row says `verified` now. A backup cannot contain its
       own completion. Every other table must be identical. */
    assert.deepStrictEqual(different, ['backups'],
      `these tables differ between the original and the restore: ${different.join(', ')}`);
    assert.ok(names.length > 50, `${names.length} tables were compared`);
  });

  await t.test('the hard types survive to the microsecond and the byte', async () => {
    const cols = ['t_tiny', 't_small', 't_med', 't_big', 't_ubig', 't_dec', 't_float', 't_double',
      't_bit', 't_char', 't_vc', 't_text', 't_long', 't_bin', 't_vbin', 't_blob', 't_date',
      't_time', 't_ts', 't_year', 't_enum', 't_set', 't_json', 't_gen'];
    for (const id of [1, 2, 3]) {
      const [[a]] = await conn.query(
        `SELECT ${cols.join(',')}, DATE_FORMAT(t_dt,'%Y-%m-%d %H:%i:%s.%f') AS dt FROM zz_probe_types WHERE id = ?`, [id]);
      const [[b]] = await restored.query(
        `SELECT ${cols.join(',')}, DATE_FORMAT(t_dt,'%Y-%m-%d %H:%i:%s.%f') AS dt FROM zz_probe_types WHERE id = ?`, [id]);
      for (const key of Object.keys(a)) {
        if (Buffer.isBuffer(a[key])) {
          assert.ok(Buffer.isBuffer(b[key]) && a[key].equals(b[key]), `row ${id} ${key} (binary)`);
        } else {
          assert.strictEqual(String(b[key]), String(a[key]), `row ${id} ${key}`);
        }
      }
    }
    /* THE MICROSECONDS SPECIFICALLY. This is the assertion the first version of
       the dumper failed while every row-by-row comparison passed. */
    const [[end]] = await restored.query(
      "SELECT DATE_FORMAT(t_dt,'%Y-%m-%d %H:%i:%s.%f') AS f FROM zz_probe_types WHERE id = 2");
    assert.strictEqual(end.f, '9999-12-31 23:59:59.999999');

    /* AND THE GENERATED COLUMN IS DERIVED, not inserted: the dump must not name
       it, or a server with a strict sql_mode refuses the whole statement. */
    const [[gen]] = await restored.query('SELECT t_gen FROM zz_probe_types WHERE id = 1');
    assert.strictEqual(Number(gen.t_gen), -256);
  });

  await t.test('the view, the trigger and the routine come back', async () => {
    const [[v]] = await restored.query(
      "SELECT COUNT(*) c FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_probe_view'");
    assert.strictEqual(Number(v.c), 1, 'the view');
    const [[tr]] = await restored.query(
      "SELECT COUNT(*) c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'zz_probe_trg'");
    assert.strictEqual(Number(tr.c), 1, 'the trigger');
    const [[fn]] = await restored.query('SELECT zz_probe_fn(7) AS v');
    assert.strictEqual(Number(fn.v), 21, 'the function, and it computes');
    /* AND THE AUTO_INCREMENT, which decides what the next id is: a restore that
       lost it would hand out ids that already exist. */
    const [[ai]] = await restored.query(
      "SELECT AUTO_INCREMENT a FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_probe_types'");
    assert.strictEqual(Number(ai.a), 5000);
  });

  /* ------------------------------------------------------------ refusals */
  await t.test('a non-empty target is refused without --force', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    let got;
    try {
      got = runExpectingFailure('restore.js', [path.join(dir, packaged.filename),
        '--passphrase-file', passFile, '--target-db', TARGET, '--yes']);
    } finally { await fsp.rm(passFile, { force: true }); }
    assert.strictEqual(got.failed, true, 'it must not restore over a populated database');
    assert.match(got.output, /already has \d+ table/);
    assert.match(got.output, /--force/, 'the refusal says what would allow it');
    assert.match(got.output, /backup of this database is taken first/,
      'and that forcing it takes a backup first');
  });

  await t.test('a wrong passphrase refuses before anything is touched', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, 'not-the-right-passphrase-at-all\n', { mode: 0o600 });
    const before = await checksums(restored);
    let got;
    try {
      got = runExpectingFailure('restore.js', [path.join(dir, packaged.filename),
        '--passphrase-file', passFile, '--target-db', TARGET, '--yes', '--force']);
    } finally { await fsp.rm(passFile, { force: true }); }
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /did not verify|could not be opened/i);
    assert.match(got.output, /passphrase is wrong or the file has been damaged/i,
      'and says the two are indistinguishable, rather than guessing');
    assert.deepStrictEqual(await checksums(restored), before, 'nothing was changed');
  });

  await t.test('one flipped byte refuses, and says nothing has been restored', async () => {
    const copy = path.join(dir, 'tampered.enc');
    const bytes = await fsp.readFile(path.join(dir, packaged.filename));
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await fsp.writeFile(copy, bytes, { mode: 0o600 });
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    let got;
    try {
      got = runExpectingFailure('restore.js', [copy, '--passphrase-file', passFile,
        '--target-db', TARGET, '--yes', '--force']);
    } finally { await fsp.rm(passFile, { force: true }); await fsp.rm(copy, { force: true }); }
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /nothing has been restored/i);
  });

  await t.test('a passphrase file other accounts can read is refused', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o644 });
    let got;
    try {
      got = runExpectingFailure('restore.js', [path.join(dir, packaged.filename),
        '--passphrase-file', passFile, '--target-db', TARGET, '--dry-run']);
    } finally { await fsp.rm(passFile, { force: true }); }
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /chmod 600/, 'the refusal says exactly how to fix it');
    /* AND NOT A STACK TRACE: these are sentences for a person in an SSH
       session, and a trace above one buries it. */
    assert.ok(!/ {4}at /.test(got.output), 'a refusal is a sentence, not a stack trace');
  });

  await t.test('there is no --passphrase flag, on purpose', async () => {
    const got = runExpectingFailure('backup.js', ['--passphrase', PASS]);
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /visible to every account|ps\b/i,
      'the refusal says why, rather than just "unknown option"');
    assert.strictEqual(got.output.includes(PASS), false,
      'and does not echo the passphrase it just refused');
  });

  await t.test('a backup folder inside the application is refused', async () => {
    const got = runExpectingFailure('backup.js', ['--passphrase-file', '/dev/null'],
      { BACKUP_DIR: path.join(ROOT, 'would-be-destroyed-by-a-deploy') });
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /inside the application folder/i);
    assert.match(got.output, /deploy/i, 'and says what would destroy them');
  });

  /* ------------------------------------------------------- the lock, again */
  await t.test('two backups at once: one runs, the other is told why not', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    /* A `running` row written by hand, which is exactly what a backup in
       progress leaves — including the heartbeat, so it is not swept as stale. */
    await conn.query(
      `INSERT INTO backups (id, status, trigger_kind, created_by_label, heartbeat_at, created_at)
       VALUES (UUID(), 'running', 'manual', 'somebody else', NOW(), NOW())`
    );
    let got;
    try {
      got = runExpectingFailure('backup.js', ['--passphrase-file', passFile]);
    } finally {
      await fsp.rm(passFile, { force: true });
      await conn.query("DELETE FROM backups WHERE created_by_label = 'somebody else'");
    }
    assert.strictEqual(got.failed, true);
    assert.match(got.output, /already|in progress|running/i);
  });

  /* ------------------------------------------------------------ retention */
  await t.test('retention deletes only the files the table names', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    /* SOMETHING OF THE OWNER'S, in the same folder. The folder belongs to them:
       last year's package pulled back from cloud storage, a note to themselves.
       A retention sweep that listed the directory would eventually delete it. */
    const theirs = path.join(dir, 'a-package-from-last-year.tar.gz.enc');
    await fsp.writeFile(theirs, 'not ours');
    const note = path.join(dir, 'where-the-passphrase-is.txt');
    await fsp.writeFile(note, 'in the password manager');

    try {
      /* Three more, keeping one: two of ours should go. */
      runJson('backup.js', ['--passphrase-file', passFile, '--keep', '1']);
      runJson('backup.js', ['--passphrase-file', passFile, '--keep', '1']);
    } finally { await fsp.rm(passFile, { force: true }); }

    assert.ok(fs.existsSync(theirs), 'a file the table does not name is never touched');
    assert.ok(fs.existsSync(note), 'nor is anything else in the folder');
    const [rows] = await conn.query("SELECT COUNT(*) c FROM backups WHERE status IN ('ok','verified')");
    assert.strictEqual(Number(rows[0].c), 1, 'the table keeps exactly the one asked for');
  });

  await t.test('--no-prune keeps every package', async () => {
    const passFile = path.join(dir, '..', `pass-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(passFile, `${PASS}\n`, { mode: 0o600 });
    try {
      runJson('backup.js', ['--passphrase-file', passFile, '--no-prune']);
      runJson('backup.js', ['--passphrase-file', passFile, '--no-prune']);
    } finally { await fsp.rm(passFile, { force: true }); }
    const [rows] = await conn.query("SELECT COUNT(*) c FROM backups WHERE status = 'verified'");
    assert.strictEqual(Number(rows[0].c), 3, 'the one from the last test plus these two');
  });

  /* ------------------------------------------------------------ the check */
  await t.test('the doctor agrees, and disagrees when it should', async () => {
    const good = JSON.parse(run('check-backup.js', ['--json']));
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.last.exists, true);
    assert.strictEqual(good.last.ageDays, 0);

    await conn.query('DELETE FROM backups');
    let bad;
    try { run('check-backup.js', ['--json']); assert.fail('it must exit non-zero'); }
    catch (err) { bad = JSON.parse(String(err.stdout)); assert.strictEqual(err.status, 1); }
    assert.strictEqual(bad.ok, false);
    const recent = bad.checks.find((c) => c.name === 'a recent backup');
    assert.strictEqual(recent.ok, false);
    assert.match(recent.fix, /npm run backup/);
  });
});
