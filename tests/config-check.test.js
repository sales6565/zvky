/* Start-up configuration: Forge runs from the host's environment variables, refuses to
 * start without the database settings or a real JWT_SECRET, never prints a value, and
 * keeps no .env in the repository.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { problems, warnings } = require('../src/config-check');

const ROOT = path.join(__dirname, '..');

/* A FOLDER FOR CHAT ATTACHMENTS THAT REALLY EXISTS, outside the application
   folder and outside any temp directory — which is what the check demands, so a
   fixture cannot use the scratch directory it would otherwise reach for. Made
   here because "a complete environment" now includes where chat files go: since
   Prompt 59 an unset CHAT_UPLOAD_DIR is a warning, and a deployment that has
   not decided where attachments live is not completely configured. */
const CHAT_DIR_FIXTURE = path.join(require('node:os').homedir(), '.zvky-config-check-uploads');
fs.mkdirSync(CHAT_DIR_FIXTURE, { recursive: true });

const GOOD = {
  DB_HOST: 'localhost', DB_NAME: 'acct_forge', DB_USER: 'acct_forge_app', DB_PASSWORD: 'S3cret-db-Pass-unique-41',
  JWT_SECRET: 'b7f0c2d9e4a1f6b3c8d5e2a7f4b1c6d3e8a5f2b9c4d1e6a3', CORS_ORIGIN: 'https://pipeline.example.org',
  CHAT_UPLOAD_DIR: CHAT_DIR_FIXTURE,
};
const placeholderOf = (name) => {
  const line = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line.slice(name.length + 1);
};

test('configuration validation', async (t) => {
  await t.test('a complete environment passes, with no warnings', () => {
    assert.deepStrictEqual(problems(GOOD), []);
    assert.deepStrictEqual(warnings(GOOD), []);
  });

  await t.test('DATABASE_URL stands in for the separate database settings', () => {
    const { DB_NAME, DB_USER, DB_PASSWORD, ...rest } = GOOD;
    assert.deepStrictEqual(problems({ ...rest, DATABASE_URL: 'mysql://u:p@localhost/db' }), []);
  });

  await t.test('missing database settings are named', () => {
    const { DB_NAME, DB_USER, ...rest } = GOOD;
    const p = problems(rest);
    assert.ok(p.some((x) => x.startsWith('DB_NAME is not set')));
    assert.ok(p.some((x) => x.startsWith('DB_USER is not set')));
  });

  await t.test('JWT_SECRET: missing, the .env.example placeholder, or short, each refused', () => {
    assert.ok(problems({ ...GOOD, JWT_SECRET: '' }).some((x) => x.startsWith('JWT_SECRET is not set')));
    assert.ok(problems({ ...GOOD, JWT_SECRET: placeholderOf('JWT_SECRET') }).some((x) => /public placeholder/.test(x)));
    assert.ok(problems({ ...GOOD, JWT_SECRET: 'a1b2c3d4e5f6' }).some((x) => /shorter than 32/.test(x)));
  });

  await t.test('the .env.example database placeholders are refused', () => {
    for (const k of ['DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      assert.ok(problems({ ...GOOD, [k]: placeholderOf(k) }).some((x) => x.startsWith(`${k} is still the placeholder`)), k);
    }
  });

  await t.test('warnings for an empty DB_PASSWORD and an open CORS_ORIGIN', () => {
    const w = warnings({ ...GOOD, DB_PASSWORD: '', CORS_ORIGIN: '' });
    assert.ok(w.some((x) => x.startsWith('DB_PASSWORD is not set')));
    assert.ok(w.some((x) => x.startsWith('CORS_ORIGIN is not set')));
  });

  await t.test('the chat upload folder is part of the configuration it checks', () => {
    /* WHY THIS IS A STARTUP WARNING AND NOT A STARTUP FAILURE: a folder that
       cannot be used stops chat ATTACHMENTS, and refusing to start the whole
       application over that would be a bigger outage than the one being
       prevented. But it is said, and it names the variable — the two bug
       reports about vanishing files both cost days to the fact that nothing
       anywhere said where the files were meant to be. */
    const os = require('node:os');
    const inside = path.join(ROOT, 'uploads', 'chat');
    const bad = warnings({ ...GOOD, HOME: '', CHAT_UPLOAD_DIR: inside });
    assert.ok(bad.some((w) => /chat attachments cannot be stored/i.test(w)
      && /application folder/i.test(w)), `${JSON.stringify(bad)}`);
    assert.ok(bad.some((w) => /refused/i.test(w) && /still served/i.test(w)),
      'and says what that does and does not break');

    /* A TEMPORARY DIRECTORY IS THE SAME ANSWER, with the host as its owner. */
    assert.ok(warnings({ ...GOOD, CHAT_UPLOAD_DIR: path.join(os.tmpdir(), 'zvky') })
      .some((w) => /temporary directory/i.test(w)));

    /* AND A GOOD FOLDER THAT IS ONLY A FALLBACK still gets a nudge, because a
       default is not a decision and a future change of host could move it. */
    const nudge = warnings({ ...GOOD, HOME: os.homedir(), CHAT_UPLOAD_DIR: '' });
    assert.ok(nudge.some((w) => /CHAT_UPLOAD_DIR is not set/.test(w)
      && /survives a deploy/.test(w)), `${JSON.stringify(nudge)}`);
    assert.ok(!nudge.some((w) => /cannot be stored/i.test(w)),
      'and is not reported as broken, because it is not');

    /* A CONFIGURED, USABLE FOLDER SAYS NOTHING AT ALL — which is what GOOD
       carries, and why the first case in this file still expects silence. */
    assert.deepStrictEqual(warnings(GOOD).filter((w) => /chat/i.test(w)), [],
      'a folder that is set and usable is not worth a line');
  });

  await t.test('no message ever contains a value', () => {
    const bad = { ...GOOD, JWT_SECRET: 'short-but-secret', DB_PASSWORD: '' };
    const text = [...problems(bad), ...warnings(bad)].join('\n');
    for (const v of Object.values(bad).filter(Boolean)) assert.ok(!text.includes(v), 'value not echoed');
  });

  await t.test('the app itself stops at once, naming what is missing, before touching the database', () => {
    const env = { PATH: process.env.PATH, DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'acct_forge', DB_USER: 'acct_forge_app',
      DB_PASSWORD: 'Never-Printed-Db-Pass-77', JWT_SECRET: placeholderOf('JWT_SECRET') };
    const r = spawnSync(process.execPath, ['app.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Forge cannot start: its configuration is incomplete/);
    assert.match(r.stderr, /JWT_SECRET is the public placeholder/);
    assert.ok(!r.stderr.includes('Never-Printed-Db-Pass-77') && !r.stdout.includes('Never-Printed-Db-Pass-77'));
    assert.ok(!r.stderr.includes(placeholderOf('JWT_SECRET')), 'not even the placeholder is echoed');
  });

  await t.test('no .env in the repository, and every variant is ignored', { skip: !fs.existsSync(path.join(ROOT, '.git')) && 'not a git checkout' }, () => {
    const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
    assert.deepStrictEqual(tracked.filter((f) => /(^|\/)(\.env(\..+)?|.+\.env)$/.test(f) && !f.endsWith('.env.example')), []);
    for (const f of ['.env', '.env.local', '.env.production', 'prod.env']) {
      assert.strictEqual(spawnSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT }).status, 0, `${f} is ignored`);
    }
    assert.notStrictEqual(spawnSync('git', ['check-ignore', '-q', '--no-index', '.env.example'], { cwd: ROOT }).status, 0, '.env.example is kept');
  });
});
