/* THE NIGHTLY SCHEDULE, AND THE PROMISE THAT IT CANNOT RUN TWICE.
 *
 * ===========================================================================
 * WHAT IS ACTUALLY BEING TESTED HERE, and why a timer is not involved.
 *
 * The scheduler is a five-minute tick over a function that decides whether
 * tonight's backup has already been taken. Testing it by waiting for a timer
 * would mean a suite that takes five minutes to prove one thing and cannot
 * prove the interesting one at all — so tick() is exported and called
 * directly, with the clock passed in. Every case below is one call with a
 * stated time.
 *
 * THE INTERESTING ONE IS TWO PROCESSES. cPanel's Passenger runs more than one
 * worker, each with its own timer, each waking within a second of the others.
 * "Has tonight's backup been taken?" is answered NO by both of them at 02:00,
 * and the result is two packages a night, two locks fought over, and on a
 * shared host with a 1 GB quota, a full disk. The guard is a conditional UPDATE
 * in the database, which is the only arbiter the workers share — so the test
 * that matters fires several ticks at the same slot and asserts exactly one of
 * them claimed it.
 *
 * ===========================================================================
 * AND THE FAILURE PATH, which is most of what a scheduler is for. A scheduled
 * backup that silently stops happening is the worst outcome this whole feature
 * has: the screen says "daily at 02:00", everybody believes it, and there has
 * been nothing for a fortnight. Every way it can fail raises a notice to the
 * people who hold the key, and each of those is a case below.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mysql = require('mysql2/promise');
const { config, resetSchema } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const cfg = config('backupschedule');
const SKIP = process.env.TEST_DB_NAME ? false
  : 'Set TEST_DB_NAME (and TEST_DB_USER / TEST_DB_PASSWORD) to run integration tests.';

const PASSPHRASE = `sched-${crypto.randomBytes(10).toString('base64url')}-several-words`;
const ENC_KEY = `key-${crypto.randomBytes(24).toString('hex')}`;

let dir; let conn;

/* THE SCHEDULER RUNS IN A CHILD PROCESS, like the engine suite and for the same
   reason: src/db.js binds to DB_* the first time it is required, so a test
   process cannot point it at this suite's database. The child prints one JSON
   line, which is what the assertions read. */
function inApp(code, extraEnv = {}) {
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
      DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '',
      JWT_SECRET: 'schedule-suite-not-used-outside-the-tests',
      EMAIL_ENCRYPTION_KEY: ENC_KEY,
      BACKUP_DIR: dir,
      BACKUP_TICK_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `no JSON came back: ${out.slice(-500)}`);
  return JSON.parse(line);
}

/* One tick at a stated time. */
function tick(when, extraEnv) {
  return inApp(
    "const db=require('./src/db');"
    + `require('./src/backup-scheduler').tick(db,{now:new Date(${JSON.stringify(when)})})`
    + '.then(async(r)=>{console.log(JSON.stringify(r));await db.end();})'
    + '.catch(async(e)=>{console.log(JSON.stringify({error:e.message}));await db.end();process.exit(1);})',
    extraEnv
  );
}

function remind(when, extraEnv) {
  return inApp(
    "const db=require('./src/db');"
    + `require('./src/backup-scheduler').remind(db,{now:new Date(${JSON.stringify(when)})})`
    + '.then(async(r)=>{console.log(JSON.stringify(r));await db.end();})'
    + '.catch(async(e)=>{console.log(JSON.stringify({error:e.message}));await db.end();process.exit(1);})',
    extraEnv
  );
}

function saveSchedule(patch) {
  return inApp(
    "const db=require('./src/db');"
    + `require('./src/backup-settings').save(db,${JSON.stringify(patch)},{email:'suite@test',name:'Suite'})`
    + '.then(async(r)=>{console.log(JSON.stringify(r));await db.end();})'
    + '.catch(async(e)=>{console.log(JSON.stringify({error:e.message}));await db.end();process.exit(1);})'
  );
}

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
      JWT_SECRET: 'schedule-suite-not-used-outside-the-tests',
    },
  });
}

/* 02:00 local on three consecutive days, as the scheduler sees them. */
const AT = (day, hour = 2, minute = 30) => {
  const d = new Date(2026, 4, day, hour, minute, 0);
  return d.toISOString();
};

test('the backup schedule', { skip: SKIP }, async (t) => {
  t.before(async () => {
    await resetSchema(cfg);
    migrate();
    dir = path.join(os.homedir(), `zvky-sched-backups-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });
    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    /* Somebody to be told. The notice goes to holders of backup.manage, which
       by default is super_admin alone. */
    await conn.query(
      `INSERT INTO users (id, name, email, password_hash, role, is_active)
       VALUES (UUID(), 'The Owner', 'owner@sched.test', '$2b$10$notarealhashnotarealhashnotarealhashnotarealhashnotar', 'super_admin', 1)`
    );
  });

  t.after(async () => {
    if (conn) await conn.end().catch(() => {});
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  const notices = async () => {
    const [rows] = await conn.query(
      "SELECT detail FROM notifications WHERE kind = 'backup' ORDER BY created_at");
    return rows.map((r) => r.detail);
  };
  const clearNotices = () => conn.query("DELETE FROM notifications WHERE kind = 'backup'");

  /* ---------------------------------------------------------- it is off */
  await t.test('off out of the box: a tick does nothing and says why', async () => {
    const r = tick(AT(4));
    assert.strictEqual(r.ran, false);
    assert.match(r.reason, /schedule is off/i);
    assert.deepStrictEqual(await notices(), [], 'and nobody is bothered about it');
  });

  await t.test('on but with no passphrase: it does not run, and it cannot be saved that way', async () => {
    /* THE SAVE IS THE REFUSAL. settings.save() will not switch the schedule on
       without a stored passphrase, which is the honest place to stop it — a
       schedule that is on and silently never runs is the exact failure this
       feature is about. */
    const refused = saveSchedule({ scheduleEnabled: true });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /passphrase/i);
  });

  /* ----------------------------------------------------------- it is on */
  await t.test('switched on with a passphrase, it runs once at the configured time', async () => {
    const saved = saveSchedule({
      scheduleEnabled: true, frequency: 'daily', hour: 2, minute: 0, keepLast: 3,
      passphrase: PASSPHRASE,
    });
    assert.strictEqual(saved.ok, true, JSON.stringify(saved));

    /* BEFORE THE HOUR: not yet. */
    const early = tick(AT(4, 1, 30));
    assert.strictEqual(early.ran, false);
    assert.match(early.reason, /not yet/i);

    /* AFTER IT: once. */
    const ran = tick(AT(4, 2, 30));
    assert.strictEqual(ran.ran, true, JSON.stringify(ran));
    assert.match(ran.slot, /^daily-2026-05-04$/);
    assert.ok(ran.filename);

    /* AND NOT AGAIN THE SAME NIGHT, however many times the tick fires. */
    for (const minute of [31, 45, 59]) {
      const again = tick(AT(4, 2, minute));
      assert.strictEqual(again.ran, false, `it ran twice at 02:${minute}`);
      assert.match(again.reason, /already run for this slot/i);
    }
    const later = tick(AT(4, 23, 0));
    assert.strictEqual(later.ran, false, 'nor at the end of the same day');
  });

  await t.test('the package it wrote is a real, verified, encrypted one', async () => {
    const [rows] = await conn.query(
      "SELECT * FROM backups WHERE trigger_kind = 'scheduled' ORDER BY created_at DESC LIMIT 1");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'verified', rows[0].error || '');
    assert.strictEqual(rows[0].encrypted, 1);
    assert.strictEqual(rows[0].created_by, null, 'nobody took it; the schedule did');
    assert.match(String(rows[0].created_by_label), /schedule/i);
    const listing = await fsp.readdir(dir);
    assert.ok(listing.includes(rows[0].filename), 'and the file is on disk');
  });

  await t.test('the next night is a new slot', async () => {
    const ran = tick(AT(5, 2, 30));
    assert.strictEqual(ran.ran, true, JSON.stringify(ran));
    assert.strictEqual(ran.slot, 'daily-2026-05-05');
  });

  /* ------------------------------------------- the two-process guarantee */
  await t.test('FOUR PROCESSES AT ONCE AND EXACTLY ONE BACKUP', async () => {
    /* The real shape of the bug: four workers, same minute, same slot. They
       are started together and left to race, which is the only way to test
       this — a sequential loop would pass against a broken guard, because the
       first one would finish before the second looked. */
    const before = (await conn.query("SELECT COUNT(*) c FROM backups WHERE trigger_kind='scheduled'"))[0][0].c;
    const code = "const db=require('./src/db');"
      + `require('./src/backup-scheduler').tick(db,{now:new Date(${JSON.stringify(AT(6))})})`
      + '.then(async(r)=>{console.log(JSON.stringify(r));await db.end();})'
      + '.catch(async(e)=>{console.log(JSON.stringify({error:e.message}));await db.end();})';
    const { execFile } = require('node:child_process');
    const one = () => new Promise((resolve) => {
      execFile(process.execPath, ['-e', code], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
          DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '',
          JWT_SECRET: 'schedule-suite-not-used-outside-the-tests',
          EMAIL_ENCRYPTION_KEY: ENC_KEY, BACKUP_DIR: dir,
          BACKUP_TICK_MINUTES: '0', EMAIL_SWEEP_MS: '0',
        },
        maxBuffer: 32 * 1024 * 1024,
      }, (err, stdout) => {
        const line = String(stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop();
        resolve(line ? JSON.parse(line) : { error: 'no output' });
      });
    });
    const results = await Promise.all([one(), one(), one(), one()]);
    const ran = results.filter((r) => r.ran);
    assert.strictEqual(ran.length, 1,
      `exactly one process may take tonight's backup; ${ran.length} did: ${JSON.stringify(results)}`);
    /* AND THE OTHER THREE SAID WHY, rather than failing. */
    for (const other of results.filter((r) => !r.ran)) {
      assert.ok(/another process|already run|busy|in progress/i.test(other.reason || other.error || ''),
        `a process that stood down should say why: ${JSON.stringify(other)}`);
    }
    const after = (await conn.query("SELECT COUNT(*) c FROM backups WHERE trigger_kind='scheduled'"))[0][0].c;
    assert.strictEqual(Number(after) - Number(before), 1, 'exactly one row was written');
  });

  /* ------------------------------------------------------- the failures */
  await t.test('an unusable folder raises a notice and does NOT spend the slot', async () => {
    await clearNotices();
    const r = tick(AT(7), { BACKUP_DIR: path.join(ROOT, 'inside-the-app-folder') });
    assert.strictEqual(r.ran, false);
    assert.match(r.reason, /folder is not usable/i);
    const told = await notices();
    assert.strictEqual(told.length, 1, 'the one person who can fix it is told');
    assert.match(told[0], /could not start/i);
    assert.match(told[0], /inside the application folder/i);

    /* THE SLOT IS STILL AVAILABLE, which is the point: the owner fixes the
       folder at nine in the morning and gets a backup that night, rather than
       waiting another day because a misconfiguration consumed the slot. */
    await clearNotices();
    const fixed = tick(AT(7));
    assert.strictEqual(fixed.ran, true, JSON.stringify(fixed));
  });

  await t.test('a passphrase that can no longer be read raises a notice naming the cause', async () => {
    await clearNotices();
    /* EMAIL_ENCRYPTION_KEY ROTATED. The stored value is still there and is no
       longer readable, which is a different failure from "no passphrase" and
       needs a different sentence. */
    const r = tick(AT(8), { EMAIL_ENCRYPTION_KEY: `different-${crypto.randomBytes(16).toString('hex')}` });
    assert.strictEqual(r.ran, false);
    assert.match(r.reason, /passphrase could not be read/i);
    const told = await notices();
    assert.strictEqual(told.length, 1);
    assert.match(told[0], /EMAIL_ENCRYPTION_KEY/,
      'the notice names the variable, because that is the whole diagnosis');
    assert.match(told[0], /Settings/, 'and where to fix it');
  });

  await t.test('no notice ever contains the passphrase', async () => {
    const [rows] = await conn.query("SELECT detail FROM notifications WHERE kind = 'backup'");
    const text = JSON.stringify(rows);
    assert.strictEqual(text.includes(PASSPHRASE), false);
    assert.strictEqual(text.includes(ENC_KEY), false);
  });

  /* -------------------------------------------------------- weekly, and */
  await t.test('a weekly schedule runs on its day and no other', async () => {
    /* 2026-05-11 is a Monday. */
    const saved = saveSchedule({ frequency: 'weekly', weekday: 1, hour: 2, minute: 0 });
    assert.strictEqual(saved.ok, true, JSON.stringify(saved));
    const sunday = tick(AT(10, 3, 0));
    assert.strictEqual(sunday.ran, false);
    assert.match(sunday.reason, /not the configured day/i);
    const monday = tick(AT(11, 3, 0));
    assert.strictEqual(monday.ran, true, JSON.stringify(monday));
    assert.match(monday.slot, /^weekly-2026-W/);
    const tuesday = tick(AT(12, 3, 0));
    assert.strictEqual(tuesday.ran, false, 'not again the next day');
  });

  /* ---------------------------------------------------- the daily notice */
  await t.test('the "nothing has been backed up" notice fires once a day, at most', async () => {
    await clearNotices();
    await conn.query('DELETE FROM backups');            // nothing has ever been taken
    const first = remind(AT(20, 9, 0));
    assert.strictEqual(first.told, 1);
    const same = remind(AT(20, 17, 0));
    assert.strictEqual(same.told, 0, 'twice in one day is nagging, not telling');
    assert.match(same.reason, /already told today/i);
    const next = remind(AT(21, 9, 0));
    assert.strictEqual(next.told, 1, 'but the next day it says it again');

    const told = await notices();
    assert.strictEqual(told.length, 2);
    assert.match(told[0], /has ever been taken/i);
    assert.match(told[0], /somewhere other than this server/i,
      'and it says the thing that actually matters');
  });

  await t.test('and goes quiet once there is a recent backup', async () => {
    await clearNotices();
    await conn.query(
      `INSERT INTO backups (id, filename, size_bytes, sha256, status, trigger_kind, created_at)
       VALUES (UUID(), 'pretend.tar.gz.enc', 100, REPEAT('a',64), 'verified', 'manual', NOW())`
    );
    const r = remind(AT(22, 9, 0));
    assert.strictEqual(r.told, 0);
    assert.match(r.reason, /recent backup exists/i);
    assert.deepStrictEqual(await notices(), []);
  });

  await t.test('and speaks up again once it is a week old', async () => {
    await clearNotices();
    await conn.query('UPDATE backups SET created_at = NOW() - INTERVAL 8 DAY');
    const r = remind(AT(23, 9, 0));
    assert.strictEqual(r.told, 1);
    const told = await notices();
    assert.match(told[0], /8 days old/);
  });
});
