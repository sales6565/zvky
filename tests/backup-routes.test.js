/* WHO MAY BACK THIS STUDIO UP, WHO MAY CARRY IT HOME, AND WHAT IS WRITTEN DOWN.
 *
 * ===========================================================================
 * THE TWO PERMISSIONS, AND WHY THERE ARE TWO.
 *
 * `backup.manage`   take one, verify one, delete one, set the schedule
 * `backup.download` pull the package off the server
 *
 * They are separate because they are different risks. Taking a backup produces
 * a file on a server the studio already controls. Downloading one produces a
 * copy of every password hash, every API token and every encrypted setting in
 * the studio, on a laptop, permanently. Somebody can reasonably be trusted with
 * the first and not the second — an office manager who runs the Friday backup,
 * say — and a single permission would make that impossible to express.
 *
 * Both are Super Admin only out of the box, both are marked dangerous, and both
 * ask for the account's own password again at the moment of the action.
 *
 * ===========================================================================
 * WHAT THIS SUITE WATCHES FOR ABOVE EVERYTHING: A LEAK.
 *
 * The thing this feature could do worst is put a secret somewhere it does not
 * belong — in an API response, in the activity log, in the manifest, in a log
 * line. So a random value is planted in the environment before the server
 * starts, and every response this suite receives, plus the whole activity log,
 * is searched for it and for the passphrase. A secret-shaped assertion in a
 * test is only worth something if the secret is unique to the run, which is why
 * these are generated rather than written here.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, raw } = require('./helpers');

const cfg = config('backuproutes');
const SKIP = process.env.TEST_DB_NAME ? false
  : 'Set TEST_DB_NAME (and TEST_DB_USER / TEST_DB_PASSWORD) to run integration tests.';

const PASSWORD = 'Suite-Only-Pw-74!x';
const PASSPHRASE = `suite-${crypto.randomBytes(10).toString('base64url')}-several-words`;
/* PLANTED IN THE ENVIRONMENT the server starts with, so "did a secret leak"
   can be asked of every byte that came back rather than guessed at. */
const PLANTED = `canary-${crypto.randomBytes(16).toString('hex')}`;

test('backup routes: permissions, step-up, audit, and nothing leaked', { skip: SKIP }, async (t) => {
  let server; let dir;
  const token = {};
  const seen = [];            // every response body this suite received

  /* Every call goes through here so the leak scan at the end sees all of it. */
  const as = async (who, p, o = {}) => {
    const r = await api(server.base, p, { ...o, token: token[who] });
    seen.push(JSON.stringify(r.body));
    return r;
  };

  t.before(async () => {
    await resetSchema(cfg);
    dir = path.join(os.homedir(), `zvky-routes-backups-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'routes74',
      BACKUP_DIR: dir,
      /* The canary goes in a variable the engine is told to collect, so a
         secrets bundle or a careless manifest would carry it. */
      EMAIL_PASSWORD: PLANTED,
      EMAIL_ENCRYPTION_KEY: `key-${crypto.randomBytes(16).toString('hex')}`,
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'routes74', name: 'Owner', email: 'owner@bk.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@bk.test');

    for (const [key, role] of [['admin', 'admin'], ['artist', 'game_artist']]) {
      const made = await api(server.base, '/users', { method: 'POST', token: token.owner, body: {
        name: key === 'admin' ? 'An Admin' : 'An Artist',
        email: `${key}@bk.test`, role, password: PASSWORD } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      token[key] = await login(`${key}@bk.test`);
    }
  });

  t.after(async () => {
    if (server) stopServer(server);
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------ the gate */
  await t.test('only a holder reaches any of the seven routes', async () => {
    const routes = [
      ['GET', '/backups'],
      ['GET', '/backups/00000000-0000-4000-8000-000000000000'],
      ['POST', '/backups'],
      ['POST', '/backups/00000000-0000-4000-8000-000000000000/verify'],
      ['POST', '/backups/00000000-0000-4000-8000-000000000000/download'],
      ['DELETE', '/backups/00000000-0000-4000-8000-000000000000'],
      ['PUT', '/backups/schedule'],
    ];
    for (const who of ['admin', 'artist']) {
      for (const [method, p] of routes) {
        const r = await as(who, p, { method, body: method === 'GET' ? undefined : {} });
        assert.strictEqual(r.status, 403, `${who} must not reach ${method} ${p} (got ${r.status})`);
      }
    }
    /* AND THE OWNER DOES, which is the half that proves the 403s above are the
       permission and not a typo in the path. */
    const ok = await as('owner', '/backups');
    assert.strictEqual(ok.status, 200);
  });

  await t.test('signed out is 401, not 403 — the route exists', async () => {
    const r = await api(server.base, '/backups');
    assert.strictEqual(r.status, 401);
  });

  /* --------------------------------------------------------- the payload */
  await t.test('the list says what the screen needs and no more', async () => {
    const r = await as('owner', '/backups');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.backups, []);
    assert.strictEqual(r.body.last.exists, false);
    assert.strictEqual(r.body.last.stale, true, 'never backed up reads as stale');
    assert.strictEqual(r.body.running, null);
    assert.strictEqual(r.body.schedule.scheduleEnabled, false, 'the schedule ships off');
    assert.strictEqual(r.body.schedule.passphraseSet, false);
    /* THE PASSPHRASE IS NOT IN THE SCHEDULE PAYLOAD UNDER ANY NAME. */
    for (const key of Object.keys(r.body.schedule)) {
      assert.ok(!/^passphrase$|passphrase_enc|passphraseValue/.test(key),
        `the schedule payload must not carry ${key}`);
    }
    assert.match(r.body.warnings.passphrase, /cannot be opened/i);
    assert.match(r.body.warnings.offsite, /not a safe backup/i);
    assert.strictEqual(r.body.can.download, true, 'the owner holds the second key');
  });

  /* --------------------------------------------------------- the step-up */
  await t.test('no password, a wrong password: refused, and nothing is claimed', async () => {
    const none = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE } });
    assert.strictEqual(none.status, 400);
    assert.strictEqual(none.body.field, 'password');

    const wrong = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE, password: 'not-it' } });
    assert.ok(wrong.status === 400 || wrong.status === 401, `got ${wrong.status}`);

    const list = await as('owner', '/backups');
    assert.deepStrictEqual(list.body.backups, [], 'a refused request claims no row');
  });

  await t.test('the step-up comes FIRST: a wrong password hides everything else', async () => {
    /* A WEAK PASSPHRASE AND A WRONG PASSWORD TOGETHER. The answer must be about
       the password, because a wrong password must not be able to probe what
       the server thinks of the rest of the request. */
    const r = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: 'x', passphraseConfirm: 'y', password: 'not-it' } });
    assert.strictEqual(r.body.field, 'password');
    assert.ok(!/passphrase/i.test(r.body.error), 'it must not mention the passphrase at all');
  });

  await t.test('mismatched passphrases and a weak one are each refused by name', async () => {
    const mismatch = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: `${PASSPHRASE}x`, password: PASSWORD } });
    assert.strictEqual(mismatch.status, 400);
    assert.strictEqual(mismatch.body.field, 'passphraseConfirm');

    const weak = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: 'short', passphraseConfirm: 'short', password: PASSWORD } });
    assert.strictEqual(weak.status, 400);
    assert.strictEqual(weak.body.field, 'passphrase');
  });

  await t.test('there is NO way to ask the web layer for an unencrypted package', async () => {
    /* The brief allows one only through the CLI with an explicit flag. Every
       spelling somebody might reach for is tried; all of them must still
       produce an encrypted package, not an unencrypted one. */
    for (const body of [
      { encrypt: false }, { encrypted: false }, { noEncrypt: true }, { plain: true },
    ]) {
      const r = await as('owner', '/backups', { method: 'POST',
        body: { ...body, passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE, password: PASSWORD } });
      if (r.status === 202) {
        await waitForQuiet();
        const list = await as('owner', '/backups');
        assert.strictEqual(list.body.backups[0].encrypted, true,
          `"${JSON.stringify(body)}" produced an unencrypted package from the web`);
        await as('owner', `/backups/${list.body.backups[0].id}`, { method: 'DELETE' });
      }
    }
  });

  /* The engine runs detached, so the suite waits for the row to settle. */
  async function waitForQuiet(limitMs = 180000) {
    const until = Date.now() + limitMs;
    for (;;) {
      const r = await api(server.base, '/backups', { token: token.owner });
      if (!r.body.running) return r.body;
      if (Date.now() > until) throw new Error('a backup never finished');
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  /* ------------------------------------------------------------ the real one */
  let made = null;
  await t.test('a real backup runs detached and lands verified', async () => {
    const start = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE, password: PASSWORD } });
    assert.strictEqual(start.status, 202, JSON.stringify(start.body));
    assert.ok(start.body.id, 'the response names the row so the screen can poll it');
    assert.match(start.body.summary, /keeps going if you close/i);

    const settled = await waitForQuiet();
    made = settled.backups.find((b) => b.id === start.body.id);
    assert.ok(made, 'the row is in the list');
    assert.strictEqual(made.status, 'verified');
    assert.strictEqual(made.encrypted, true);
    assert.ok(made.size > 1000);
    assert.strictEqual(settled.last.stale, false, 'and the screen stops being red');
  });

  await t.test('a second backup while one runs is refused with a reason', async () => {
    /* Started and immediately re-requested: the lock is claimed inside the
       first request, so the second must lose even though neither has finished. */
    const first = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE, password: PASSWORD } });
    assert.strictEqual(first.status, 202);
    const second = await as('owner', '/backups', { method: 'POST',
      body: { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE, password: PASSWORD } });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /already|running|in progress/i);
    await waitForQuiet();
  });

  await t.test('no path to the package is anywhere in any answer', async () => {
    const list = await as('owner', '/backups');
    const one = await as('owner', `/backups/${made.id}`);
    for (const body of [list.body, one.body]) {
      const text = JSON.stringify(body);
      assert.strictEqual(text.includes(dir), false, 'the folder path is the server\'s business');
      assert.ok(!/"path"\s*:/.test(text), 'no row carries a path');
    }
    /* THE STORAGE BLOCK IS THE ONE PLACE THE FOLDER IS NAMED, deliberately —
       the screen has to tell an administrator where packages go, and that
       answer is behind backup.manage. It is not on an individual row. */
    assert.strictEqual(list.body.storage.dir, dir);
  });

  /* ------------------------------------------------------------- verify */
  await t.test('verify needs the passphrase, and says so rather than guessing', async () => {
    const bare = await as('owner', `/backups/${made.id}/verify`, { method: 'POST', body: {} });
    assert.strictEqual(bare.status, 400);
    assert.strictEqual(bare.body.field, 'passphrase');

    const wrong = await as('owner', `/backups/${made.id}/verify`, { method: 'POST',
      body: { passphrase: 'not-the-passphrase-at-all' } });
    assert.strictEqual(wrong.status, 422);
    assert.match(wrong.body.error, /passphrase is wrong or the file has been damaged/i);

    const right = await as('owner', `/backups/${made.id}/verify`, { method: 'POST',
      body: { passphrase: PASSPHRASE } });
    assert.strictEqual(right.status, 200, JSON.stringify(right.body));
    assert.ok(right.body.parts > 3, 'it names how many parts it checked');
  });

  await t.test('a tampered package fails verification through the API too', async () => {
    const file = path.join(dir, made.filename);
    const bytes = await fsp.readFile(file);
    const original = Buffer.from(bytes);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await fsp.writeFile(file, bytes);
    try {
      const r = await as('owner', `/backups/${made.id}/verify`, { method: 'POST',
        body: { passphrase: PASSPHRASE } });
      assert.strictEqual(r.status, 422);
    } finally {
      await fsp.writeFile(file, original);
    }
  });

  /* ----------------------------------------------------------- download */
  await t.test('download needs the password, and it is a POST so it can take one', async () => {
    /* A GET MUST NOT WORK. The whole reason this route is a POST is that the
       step-up password has to travel in a body: in a query string it would
       land in the access log, the browser history and every proxy between. A
       GET that quietly worked would put it back there. */
    const asGet = await raw(server.base, `/backups/${made.id}/download?password=${encodeURIComponent(PASSWORD)}`,
      { token: token.owner });
    assert.notStrictEqual(asGet.status, 200, 'there must be no GET download');

    const noPassword = await raw(server.base, `/backups/${made.id}/download`,
      { method: 'POST', token: token.owner, body: {} });
    assert.strictEqual(noPassword.status, 400);

    const wrong = await raw(server.base, `/backups/${made.id}/download`,
      { method: 'POST', token: token.owner, body: { password: 'not-it' } });
    assert.ok(wrong.status === 400 || wrong.status === 401, `got ${wrong.status}`);
  });

  await t.test('the file comes back whole, with the headers that keep it out of caches', async () => {
    const res = await fetch(`${server.base}/backups/${made.id}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.owner}` },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="backup-/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length, made.size, 'the whole package, not a truncated stream');
    assert.strictEqual(crypto.createHash('sha256').update(body).digest('hex'), made.sha256,
      'and byte for byte the file the manifest describes');
  });

  /* ------------------------------------------------------------ schedule */
  await t.test('the schedule refuses to be switched on without a passphrase', async () => {
    const r = await as('owner', '/backups/schedule', { method: 'PUT',
      body: { scheduleEnabled: true } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /passphrase/i);
    const after = await as('owner', '/backups');
    assert.strictEqual(after.body.schedule.scheduleEnabled, false);
  });

  await t.test('storing a passphrase is a step-up, and it is never readable again', async () => {
    const noPassword = await as('owner', '/backups/schedule', { method: 'PUT',
      body: { scheduleEnabled: true, passphrase: PASSPHRASE } });
    assert.strictEqual(noPassword.body.field, 'password', JSON.stringify(noPassword.body));

    const ok = await as('owner', '/backups/schedule', { method: 'PUT',
      body: { scheduleEnabled: true, passphrase: PASSPHRASE, password: PASSWORD,
        frequency: 'daily', hour: 3, minute: 15, keepLast: 5 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.schedule.scheduleEnabled, true);
    assert.strictEqual(ok.body.schedule.passphraseSet, true);
    assert.strictEqual(ok.body.schedule.hour, 3);
    assert.strictEqual(ok.body.schedule.keepLast, 5);
    assert.strictEqual(ok.body.schedule.passphrase, undefined, 'never returned');

    /* AND IT IS NOT IN THE DATABASE IN CLEAR, which is the half a response
       cannot show. */
    const { sql } = require('./helpers');
    const rows = await sql(cfg, 'SELECT passphrase_enc, passphrase_fp FROM backup_settings WHERE id = 1');
    assert.ok(rows[0].passphrase_enc, 'something is stored');
    assert.strictEqual(String(rows[0].passphrase_enc).includes(PASSPHRASE), false,
      'and it is not the passphrase');
    assert.ok(rows[0].passphrase_fp, 'the key fingerprint is stored beside it');
  });

  await t.test('an empty passphrase on a later save keeps the stored one', async () => {
    const r = await as('owner', '/backups/schedule', { method: 'PUT',
      body: { keepLast: 9 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.schedule.keepLast, 9);
    assert.strictEqual(r.body.schedule.passphraseSet, true, 'it was not cleared by a save that omitted it');
  });

  await t.test('nonsense values are refused with a field, not clamped silently', async () => {
    for (const [body, field] of [
      [{ frequency: 'hourly' }, 'frequency'],
      [{ hour: 99 }, 'hour'],
      [{ keepLast: 0 }, 'keepLast'],
      [{ keepLast: 100000 }, 'keepLast'],
    ]) {
      const r = await as('owner', '/backups/schedule', { method: 'PUT', body });
      assert.strictEqual(r.status, 400, `${JSON.stringify(body)} should be refused`);
      assert.strictEqual(r.body.field, field);
    }
  });

  /* -------------------------------------------------------------- delete */
  await t.test('deleting removes the row and the file, and nothing else', async () => {
    const before = (await as('owner', '/backups')).body.backups;
    const victim = before[0];
    const others = before.slice(1).map((b) => b.filename);
    const r = await as('owner', `/backups/${victim.id}`, { method: 'DELETE' });
    assert.strictEqual(r.status, 200);

    const listing = await fsp.readdir(dir);
    assert.strictEqual(listing.includes(victim.filename), false, 'the file is gone');
    for (const name of others) assert.ok(listing.includes(name), `${name} is untouched`);
    const after = (await as('owner', '/backups')).body.backups;
    assert.strictEqual(after.find((b) => b.id === victim.id), undefined);
  });

  await t.test('an id that is not in the table is 404, never a path', async () => {
    for (const bad of ['../../etc/passwd', 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const r = await as('owner', `/backups/${encodeURIComponent(bad)}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 404, `${bad} -> ${r.status}`);
    }
  });

  /* --------------------------------------------------------- the record */
  await t.test('every action is in the Activity Log, and the passphrase is not', async () => {
    const log = await as('owner', '/activity?limit=200');
    assert.strictEqual(log.status, 200);
    const rows = log.body.entries || log.body.rows || log.body.activity || [];
    const actions = rows.map((r) => r.action);
    for (const want of ['backup.create', 'backup.download', 'backup.delete', 'backup.schedule']) {
      assert.ok(actions.includes(want), `${want} is not in the log (saw: ${[...new Set(actions)].join(', ')})`);
    }
    const text = JSON.stringify(rows);
    assert.strictEqual(text.includes(PASSPHRASE), false, 'the passphrase is not in the log');
    assert.strictEqual(text.includes(PASSWORD), false, 'nor is anybody\'s password');
    assert.strictEqual(text.includes(PLANTED), false, 'nor is the environment secret');
    /* NOR ITS LENGTH, which is the detail somebody would add meaning to be
       helpful. The create entry records that it was encrypted and whether the
       secrets bundle went in, and that is all. */
    assert.ok(!/passphrase.{0,20}\d+ characters/i.test(text));
  });

  await t.test('nothing this suite received contained a secret', async () => {
    /* THE WHOLE RUN, in one assertion. Every response body above went into
       `seen`; the planted environment value and the passphrase must be in none
       of them. */
    const all = seen.join('\n');
    assert.strictEqual(all.includes(PLANTED), false, 'the planted environment secret leaked into a response');
    assert.strictEqual(all.includes(PASSPHRASE), false, 'the passphrase leaked into a response');
    assert.strictEqual(all.includes(PASSWORD), false, 'an account password leaked into a response');
  });

  await t.test('and neither did the server log', async () => {
    const log = String(typeof server.output === 'function' ? server.output() : (server.output || ''));
    assert.strictEqual(log.includes(PASSPHRASE), false, 'the passphrase is in the server log');
    assert.strictEqual(log.includes(PASSWORD), false, 'a password is in the server log');
    assert.strictEqual(log.includes(PLANTED), false, 'the planted secret is in the server log');
  });
});
