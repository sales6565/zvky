/* THE DEFAULT RESET PASSWORD: CONFIGURED, SEALED, AND NOWHERE IN THE OPEN.
 *
 * ===========================================================================
 * THE VALUE THIS SUITE USES IS MADE UP, EVERY RUN, AND THAT IS THE POINT.
 *
 * A test that knew a real default would put one back in the repository, which
 * is the thing this whole change exists to undo. So the suite generates one,
 * configures it through the API, and then goes looking for it: in every tracked
 * file, in its own output, and in a dump of the database. The only place it is
 * allowed to appear is the encrypted column.
 *
 * It is generated from crypto.randomBytes rather than written as a constant so
 * that a copy-paste of this file into a commit cannot carry a working password,
 * and so the scan below cannot pass by coincidence.
 *
 * ===========================================================================
 * WHAT IS ASSERTED, AND WHY EACH IS NEEDED.
 *
 *   1. NO LITERAL IN THE SOURCE. A repository-wide scan for anything that looks
 *      like a password assigned to a constant, because the previous shape of
 *      this feature was exactly that and the note above it admitted so.
 *   2. THE VALUE IS IN NO RESPONSE. Every route of the settings section, the
 *      reset, user creation, the import, /auth/me and the login answer are each
 *      searched for it.
 *   3. IT IS ENCRYPTED AT REST. The stored column is not the value, a dump of
 *      the whole database does not contain the value, and the column cannot be
 *      read without EMAIL_ENCRYPTION_KEY.
 *   4. STRICT MODE. With EMAIL_ENCRYPTION_KEY absent and JWT_SECRET present,
 *      saving is refused rather than sealed under the signing key.
 *   5. THE POLICY IS NOT BENT, and the unmet rule is named.
 *   6. NOT IN THE AUDIT LOG, which records who and when and nothing else.
 *   7. THE RESET uses it, stamps it, forces the change, ends the sessions.
 *   8. THE FORCED CHANGE refuses the default and the previous password.
 *   9. THE EXPIRY works, with the clock controlled, and 0 means never.
 *  10. PERMISSION GATING on every route of the section.
 *  11. NOT IN WHAT THE SERVER LOGS. The server's own stdout and stderr, for the
 *      whole life of the suite, are searched for the value too.
 *
 *      This one was added because a mutation went uncaught. Making
 *      src/routes/users.js print the resolved default to the console broke
 *      nothing: the scans above read responses, tracked files and the database,
 *      and a console line is in none of the three. A shared password in the
 *      process log is a real leak -- on this deployment it goes to the cPanel
 *      Node log, which is readable by anyone with the hosting account and is
 *      kept after the password has been changed -- so the gap was in the suite,
 *      not in the mutation. tests/helpers.js already captured the output; it
 *      simply had nobody reading it.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('pwDefault');

/* THIS RUN'S VALUE. Policy-clean, because a configured default has to be: it is
   checked against src/password-policy.js before it is stored. The shape is
   deliberately distinctive so the scans below cannot match something else. */
const SECRET = `Zq7-${crypto.randomBytes(12).toString('base64url')}-Xy!`;
/* A second one, for "changing it" and for proving the first stops working. */
const SECRET_TWO = `Pw9-${crypto.randomBytes(12).toString('base64url')}-Zb!`;
/* The encryption key this run seals under. Also generated: a fixed one would be
   a key in the repository, which is the same mistake one level up. */
const ENC_KEY = crypto.randomBytes(32).toString('hex');

const PASSWORD = 'Suite-Owner-1!';

/* ---------------------------------------------------- 1. no literal in source */

test('no password literal is assigned anywhere in src/', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });

  /* ANYTHING PASSWORD-SHAPED ASSIGNED A STRING OF TEN OR MORE CHARACTERS.
   *
   * Ten because the policy's minimum is ten, so a shorter literal could not be
   * a usable default anyway, and because a tighter bound catches more of the
   * innocent constants in this codebase than it is worth.
   *
   * Comments stripped first: several files now carry a note recording the
   * declaration that was removed, quoting it, and that quote is the history
   * worth keeping rather than the bug coming back. */
  const shapes = [
    /\b(DEFAULT_PASSWORD|DEFAULT_USER_PASSWORD|SEED_PASSWORD|defaultPassword|tempPassword|temporaryPassword)\s*=\s*['"][^'"]{10,}['"]/,
    /\bpassword\s*[:=]\s*['"][^'"]{10,}['"]/i,
  ];
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of shapes) {
      const m = code.match(re);
      if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `a password literal is back in the source:\n${offenders.join('\n')}`);
});

test('the one resolver is what the three flows ask, and it has no third fallback', () => {
  const resolver = fs.readFileSync(path.join(ROOT, 'src', 'default-password.js'), 'utf8');
  const code = resolver.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* TWO SOURCES AND NO MORE. A `||` with a string on the right is the shape
     that was removed; its absence here is what makes "no third fallback" a
     property of the file rather than a claim in its header. */
  assert.ok(!/\|\|\s*['"][^'"]{6,}['"]/.test(code),
    'src/default-password.js has grown a literal fallback');
  assert.match(code, /settings\.defaultPassword\(\)/, 'it asks the sealed setting first');
  assert.match(code, /process\.env\.DEFAULT_USER_PASSWORD/, 'and the environment second');

  const users = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'users.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual((users.match(/defaultPassword\.resolve\(\)/g) || []).length, 3,
    'the reset, user creation and the import should each ask the resolver');
});

/* ----------------------------------------------------- the live half */

test('the configured default, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server; const token = {}; const people = {};
  const call = (p, o) => api(server.base, p, o);
  const as = (who, p, o = {}) => call(p, { ...o, token: token[who] });
  const login = (email, password) => call('/auth/login', { method: 'POST', body: { email, password } });
  /* EVERY BODY THIS SUITE SEES, kept so the leak scan at the end can search the
     lot rather than only what each case thought to check. */
  const seen = [];
  const watch = async (label, promise) => {
    const r = await promise;
    seen.push(`${label} ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };

  t.before(async () => {
    await resetSchema(cfg);
    /* THE KEY IS SET AND DEFAULT_USER_PASSWORD IS NOT, so the only default this
       server can have is one configured through the API — which is what makes
       the "no default configured" case below real rather than simulated. */
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'pw-token',
      EMAIL_ENCRYPTION_KEY: ENC_KEY,
      DEFAULT_USER_PASSWORD: '',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'pw-token', name: 'Root', email: 'root@pw.test', password: PASSWORD } });
    token.root = (await login('root@pw.test', PASSWORD)).body.token;
    /* `gate` is an admin this suite never resets, which `mel` cannot be: the
       cases below reset mel twice, and a reset ends their session — so asking
       the permission question with mel's token answered 401 "your password was
       changed" instead of the 403 the case is about. */
    for (const [who, role] of [['ana', 'game_artist'], ['mel', 'admin'], ['gate', 'admin']]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@pw.test`, role, password: PASSWORD } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = (await login(`${who}@pw.test`, PASSWORD)).body.token;
    }
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('with nothing configured, a reset refuses and says what to set', async () => {
    const state = await watch('GET settings', as('root', '/admin/settings/password-reset'));
    assert.strictEqual(state.status, 200, JSON.stringify(state.body));
    assert.strictEqual(state.body.settings.defaultSet, false, 'nothing is set yet');
    assert.strictEqual(state.body.settings.defaultSetAt, null);
    assert.strictEqual(state.body.settings.source, 'none');
    assert.match(state.body.settings.fallbackNote, /Settings .* Password reset/,
      'and the screen says so');

    const refused = await watch('reset with no default',
      as('root', `/users/${people.ana}/reset-password`, { method: 'POST' }));
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'no_default_password');
    assert.match(refused.body.error, /DEFAULT_USER_PASSWORD/);
    assert.match(refused.body.error, /Nothing has been changed/);
    // And it really changed nothing.
    assert.strictEqual((await login('ana@pw.test', PASSWORD)).status, 200,
      'the account still has its own password');
  });

  await t.test('the policy is checked, and the unmet rule is named', async () => {
    for (const [bad, rule] of [['short', 'at least 10 characters'], ['alllowercase!1', 'one uppercase letter'],
      ['ALLUPPERCASE!1', 'one lowercase letter'], ['NoDigitsHere!', 'one number'],
      ['NoSymbolsHere1', 'one symbol']]) {
      const r = await watch(`bad default ${bad}`, as('root', '/admin/settings/password-reset/default',
        { method: 'PUT', body: { defaultPassword: bad } }));
      assert.strictEqual(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'defaultPassword');
      assert.match(r.body.error.toLowerCase(), new RegExp(rule.replace(/[()$]/g, '\\$&')),
        `${bad} should name "${rule}": ${r.body.error}`);
      assert.ok(Array.isArray(r.body.failed) && r.body.failed.length,
        'and hand back the rules as data for the form to tick off');
    }
    assert.strictEqual((await as('root', '/admin/settings/password-reset')).body.settings.defaultSet,
      false, 'and none of that stored anything');
  });

  await t.test('setting it stores ciphertext, and never returns the value', async () => {
    const saved = await watch('PUT default', as('root', '/admin/settings/password-reset/default',
      { method: 'PUT', body: { defaultPassword: SECRET } }));
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.settings.defaultSet, true);
    assert.ok(saved.body.settings.defaultSetAt, 'and says when');
    assert.strictEqual(saved.body.settings.source, 'configured');
    assert.strictEqual(saved.body.settings.fallbackNote, null);

    /* THE COLUMN IS NOT THE VALUE. */
    const [row] = await sql(cfg, 'SELECT default_sealed, default_key_fp FROM password_reset_settings WHERE id = 1');
    assert.ok(row.default_sealed, 'something is stored');
    assert.ok(!row.default_sealed.includes(SECRET), 'the column holds the value in the clear');
    /* v1:<iv>:<tag>:<ciphertext>, all base64 — the versioned shape
       src/email-secret.js writes, so a later algorithm change can read what
       this one wrote instead of throwing on it. */
    assert.match(row.default_sealed, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      'it is v1:iv:tag:ciphertext from src/email-secret.js');
    assert.ok(row.default_key_fp, 'and records which key sealed it');

    /* AND NO READ ROUTE UNSEALS IT, for anybody. */
    const read = await watch('GET after set', as('root', '/admin/settings/password-reset'));
    assert.ok(!JSON.stringify(read.body).includes(SECRET), 'the read route returned the value');
    for (const field of ['defaultPassword', 'default', 'value', 'sealed', 'default_sealed']) {
      assert.strictEqual(read.body.settings[field], undefined,
        `the read route carries a "${field}" field`);
    }
  });

  await t.test('the audit entry records who and when, and not what', async () => {
    const entries = await sql(cfg,
      "SELECT action, summary, changes FROM activity_log WHERE action LIKE 'settings.default_password%'");
    assert.ok(entries.length, 'the change is audited');
    for (const e of entries) {
      const flat = `${e.action} ${e.summary} ${e.changes || ''}`;
      assert.ok(!flat.includes(SECRET), `the audit entry carries the value: ${flat}`);
      assert.match(e.summary, /default password/i, 'and says what happened');
    }
  });

  await t.test('a reset now uses it: hash, flag, stamp, sessions, no value anywhere', async () => {
    const before = await sql(cfg, 'SELECT password_hash FROM users WHERE id = ?', [people.ana]);
    const reset = await watch('reset', as('root', `/users/${people.ana}/reset-password`, { method: 'POST' }));
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));

    /* THE ADMIN'S RESULT, word for word from the brief, and no password. */
    assert.strictEqual(reset.body.message,
      'Password reset to the default password. Tell the user to sign in and change it.');
    assert.ok(!JSON.stringify(reset.body).includes(SECRET), 'the reset response carries the value');
    assert.strictEqual(reset.body.temporaryPassword, undefined);

    const [after] = await sql(cfg,
      'SELECT password_hash, must_change_password, password_reset_at FROM users WHERE id = ?', [people.ana]);
    assert.notStrictEqual(after.password_hash, before[0].password_hash, 'the hash moved');
    assert.ok(!after.password_hash.includes(SECRET), 'and it is a hash, not the value');
    assert.strictEqual(Number(after.must_change_password), 1, 'the flag is set');
    assert.ok(Number(after.password_reset_at) > 0, 'and the clock started');

    /* THE SESSION OPEN AT THE TIME IS GONE. */
    assert.strictEqual((await as('ana', '/auth/me')).status, 401);
    assert.strictEqual((await login('ana@pw.test', PASSWORD)).status, 401, 'and the old password is dead');

    /* AND THE HASH VERIFIES AGAINST THE CONFIGURED VALUE. */
    const signedIn = await watch('login with default', login('ana@pw.test', SECRET));
    assert.strictEqual(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.ok(!JSON.stringify(signedIn.body).includes(SECRET), 'the login answer echoes the password');
    assert.strictEqual(signedIn.body.user.password_reset_at, undefined,
      'and does not hand the browser the reset stamp');
    token.ana = signedIn.body.token;
  });

  await t.test('the in-app notice carries no password', async () => {
    const notes = await sql(cfg,
      'SELECT * FROM notifications WHERE recipient_id = ?', [people.ana]);
    assert.ok(notes.length, 'they were told');
    assert.ok(!JSON.stringify(notes).includes(SECRET), 'the notification carries the value');
    const shown = await watch('notifications', as('ana', '/notifications'));
    assert.ok(!JSON.stringify(shown.body).includes(SECRET));
  });

  await t.test('locked out of everything but the change, with a code', async () => {
    for (const p of ['/projects', '/users', '/notifications', '/timesheets/week']) {
      const blocked = await as('ana', p);
      assert.strictEqual(blocked.status, 403, `${p}: ${blocked.status}`);
      assert.strictEqual(blocked.body.code, 'MUST_CHANGE_PASSWORD', p);
      assert.strictEqual(blocked.body.mustChangePassword, true, p);
    }
    /* THE THREE WAYS OUT. There is no logout ROUTE in this application — signing
       out is dropping the token in the browser — so the allowlist is the change,
       the policy the form draws, and /auth/me. */
    assert.strictEqual((await as('ana', '/auth/me')).status, 200);
    assert.strictEqual((await as('ana', '/auth/password-policy')).status, 200);
  });

  await t.test('the new password may not be the default, nor the previous one', async () => {
    const asDefault = await watch('change to default', as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: SECRET, newPassword: SECRET, confirmPassword: SECRET } }));
    assert.strictEqual(asDefault.status, 400, JSON.stringify(asDefault.body));
    /* Caught by the "different from your current one" rule first, because on
       this path the default IS the current password. Either refusal is correct;
       what matters is that it is refused and that the body does not quote it. */
    assert.ok(['IS_DEFAULT_PASSWORD', 'IS_PREVIOUS_PASSWORD'].includes(asDefault.body.code)
      || /different from your current/.test(asDefault.body.error),
      JSON.stringify(asDefault.body));
    assert.ok(!JSON.stringify(asDefault.body).includes(SECRET), 'the refusal quotes the value');

    const weak = await watch('weak new', as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: SECRET, newPassword: 'short', confirmPassword: 'short' } }));
    assert.strictEqual(weak.status, 400);
    assert.ok(Array.isArray(weak.body.failed) && weak.body.failed.length);

    const chosen = 'Ana-Picked-This-9!';
    const ok = await watch('change', as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: SECRET, newPassword: chosen, confirmPassword: chosen } }));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    token.ana = ok.body.token;

    const [row] = await sql(cfg,
      'SELECT must_change_password, password_reset_at FROM users WHERE id = ?', [people.ana]);
    assert.strictEqual(Number(row.must_change_password), 0, 'the flag is cleared');
    assert.strictEqual(row.password_reset_at, null,
      'and the clock is cleared, so the expiry cannot fire on a password they chose');
    assert.strictEqual((await as('ana', '/projects')).status, 200, 'and the app answers again');

    /* NOW THAT THEY ARE SIGNED IN NORMALLY, the default is refused on its own
       terms rather than as "the same as your current one". */
    const reuse = await watch('change to default again', as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: chosen, newPassword: SECRET, confirmPassword: SECRET } }));
    assert.strictEqual(reuse.status, 400, JSON.stringify(reuse.body));
    assert.strictEqual(reuse.body.code, 'IS_DEFAULT_PASSWORD');
    assert.ok(!JSON.stringify(reuse.body).includes(SECRET));

    const same = await watch('change to same', as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: chosen, newPassword: chosen, confirmPassword: chosen } }));
    assert.strictEqual(same.status, 400);
    assert.match(same.body.error, /different from your current/i);
  });

  await t.test('the force-change switch off: reset, no lock', async () => {
    const off = await watch('switch off', as('root', '/admin/settings/password-reset',
      { method: 'PUT', body: { forceChange: false } }));
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.strictEqual(off.body.settings.forceChange, false);

    const reset = await as('root', `/users/${people.mel}/reset-password`, { method: 'POST' });
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
    assert.strictEqual(reset.body.mustChange, false);
    const [row] = await sql(cfg, 'SELECT must_change_password FROM users WHERE id = ?', [people.mel]);
    assert.strictEqual(Number(row.must_change_password), 0, 'no lock');

    const signedIn = await login('mel@pw.test', SECRET);
    assert.strictEqual(signedIn.status, 200, 'and they can simply work');
    token.mel = signedIn.body.token;
    assert.strictEqual((await as('mel', '/auth/me')).status, 200);

    // Put it back for the cases below.
    await as('root', '/admin/settings/password-reset', { method: 'PUT', body: { forceChange: true } });
  });

  await t.test('the expiry: the default stops working, with the clock moved', async () => {
    const hours = await watch('set hours', as('root', '/admin/settings/password-reset',
      { method: 'PUT', body: { validHours: 72 } }));
    assert.strictEqual(hours.body.settings.validHours, 72);

    await as('root', `/users/${people.ana}/reset-password`, { method: 'POST' });
    assert.strictEqual((await login('ana@pw.test', SECRET)).status, 200, 'it works now');

    /* THE CLOCK IS MOVED BY MOVING THE STAMP, not by waiting: password_reset_at
       is "when the default was installed", so pushing it 73 hours into the past
       is exactly a studio whose reset has gone stale. */
    const stale = Date.now() - 73 * 3600 * 1000;
    await sql(cfg, 'UPDATE users SET password_reset_at = ? WHERE id = ?', [stale, people.ana]);

    const expired = await watch('expired login', login('ana@pw.test', SECRET));
    assert.strictEqual(expired.status, 401, JSON.stringify(expired.body));
    /* THE ORDINARY MESSAGE, which is the point: "that password has expired"
       would tell somebody guessing that they had the right string. */
    assert.strictEqual(expired.body.error, 'Invalid email or password');
    assert.ok(!/expir/i.test(JSON.stringify(expired.body)), 'the form must not learn why');

    /* 0 MEANS NEVER, and the same account signs straight in again. */
    await as('root', '/admin/settings/password-reset', { method: 'PUT', body: { validHours: 0 } });
    assert.strictEqual((await login('ana@pw.test', SECRET)).status, 200,
      'with no expiry configured the same stale default works');

    /* AND AN ADMIN RESET IS THE WAY BACK when there is an expiry. */
    await as('root', '/admin/settings/password-reset', { method: 'PUT', body: { validHours: 72 } });
    await sql(cfg, 'UPDATE users SET password_reset_at = ? WHERE id = ?', [stale, people.ana]);
    assert.strictEqual((await login('ana@pw.test', SECRET)).status, 401);
    await as('root', `/users/${people.ana}/reset-password`, { method: 'POST' });
    assert.strictEqual((await login('ana@pw.test', SECRET)).status, 200, 'a fresh reset restarts the clock');
  });

  await t.test('changing the default makes the old one stop working', async () => {
    const changed = await watch('PUT default again', as('root', '/admin/settings/password-reset/default',
      { method: 'PUT', body: { defaultPassword: SECRET_TWO } }));
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.ok(!JSON.stringify(changed.body).includes(SECRET_TWO));

    await as('root', `/users/${people.mel}/reset-password`, { method: 'POST' });
    assert.strictEqual((await login('mel@pw.test', SECRET)).status, 401, 'the old default is dead');
    assert.strictEqual((await login('mel@pw.test', SECRET_TWO)).status, 200, 'and the new one works');
  });

  await t.test('the switch off restores the behaviour found before this change', async () => {
    /* OFF means "do not use the configured default". With no
       DEFAULT_USER_PASSWORD on this server there is then nothing to use, so a
       reset refuses — which IS the pre-change behaviour on a deployment that
       never set the variable, now said out loud instead of silently reaching
       for a value in the source. */
    const off = await as('root', '/admin/settings/password-reset',
      { method: 'PUT', body: { useDefault: false } });
    assert.strictEqual(off.body.settings.useDefault, false);
    assert.strictEqual(off.body.settings.willUseDefault, false);

    const refused = await as('root', `/users/${people.mel}/reset-password`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'no_default_password');

    await as('root', '/admin/settings/password-reset', { method: 'PUT', body: { useDefault: true } });
  });

  await t.test('every route of the section needs the permission', async () => {
    /* mel is an admin: manageUsers, and NOT managePermissions, so they do not
       hold settings.default_password by default. */
    for (const [method, p, body] of [
      ['GET', '/admin/settings/password-reset', undefined],
      ['PUT', '/admin/settings/password-reset', { validHours: 1 }],
      ['PUT', '/admin/settings/password-reset/default', { defaultPassword: SECRET_TWO }],
      ['DELETE', '/admin/settings/password-reset/default', undefined],
    ]) {
      const r = await watch(`${method} as admin`, as('gate', p, { method, body }));
      assert.strictEqual(r.status, 403, `${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(!JSON.stringify(r.body).includes(SECRET_TWO));
    }
  });

  await t.test('the hours are validated', async () => {
    for (const bad of [-1, 721, 1.5, 'many']) {
      const r = await as('root', '/admin/settings/password-reset',
        { method: 'PUT', body: { validHours: bad } });
      assert.strictEqual(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'validHours');
    }
    for (const good of [0, 1, 72, 720]) {
      const r = await as('root', '/admin/settings/password-reset',
        { method: 'PUT', body: { validHours: good } });
      assert.strictEqual(r.status, 200, `${good}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.settings.validHours, good);
    }
  });

  await t.test('clearing it returns to "not set"', async () => {
    const cleared = await watch('DELETE default',
      as('root', '/admin/settings/password-reset/default', { method: 'DELETE' }));
    assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
    assert.strictEqual(cleared.body.settings.defaultSet, false);
    assert.strictEqual(cleared.body.settings.defaultSetAt, null);
    const [row] = await sql(cfg, 'SELECT default_sealed FROM password_reset_settings WHERE id = 1');
    assert.strictEqual(row.default_sealed, null);
    // Repeat is a no-op rather than an error.
    const again = await as('root', '/admin/settings/password-reset/default', { method: 'DELETE' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.unchanged, true);
    // Restore, for the scan below.
    await as('root', '/admin/settings/password-reset/default',
      { method: 'PUT', body: { defaultPassword: SECRET_TWO } });
  });

  /* ------------------------------------------------- the scans, last of all */

  await t.test('the value is in no response this suite has seen', () => {
    assert.ok(seen.length > 15, `only ${seen.length} responses were watched`);
    for (const line of seen) {
      for (const [label, value] of [['the first value', SECRET], ['the second', SECRET_TWO]]) {
        assert.ok(!line.includes(value),
          `${label} appeared in a response: ${line.slice(0, 200)}`);
      }
    }
  });

  await t.test('the value is in nothing the server logged', () => {
    /* THE PROCESS LOG. startServer pipes the child's stdout and stderr into one
       buffer and hands it over as output(); everything the server has printed
       since it booted is in here, which includes every request this suite made.

       The length guard is the same idea as the one above: an empty buffer would
       satisfy a search for anything, so the scan has to be shown to be reading
       something first. A booted server has printed its migration steps, so this
       is comfortably met -- it fails only if the capture itself breaks. */
    const log = server.output();
    assert.ok(log.length > 200, `only ${log.length} bytes of server log were captured`);
    for (const [label, value] of [['the first value', SECRET], ['the second', SECRET_TWO],
      ['the encryption key', ENC_KEY]]) {
      const at = log.indexOf(value);
      assert.strictEqual(at, -1,
        `${label} was logged by the server, near: ${JSON.stringify(log.slice(Math.max(0, at - 120), at + 80))}`);
    }
  });

  await t.test('the value is in no tracked file, and in no database dump', async () => {
    /* THE REPOSITORY. git ls-files rather than a walk, so generated and ignored
       files are out of scope and a value written into one of them would be
       caught by the dump scan below instead. */
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean);
    const offenders = [];
    for (const rel of tracked) {
      let text;
      try { text = fs.readFileSync(path.join(ROOT, rel)); } catch { continue; }
      const body = text.toString('latin1');
      for (const value of [SECRET, SECRET_TWO, ENC_KEY]) {
        if (body.includes(value)) offenders.push(`${rel} (${value === ENC_KEY ? 'the key' : 'a value'})`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      `this run's generated secrets are in tracked files:\n${offenders.join('\n')}`);

    /* THE DATABASE, every table, as text. The sealed column is ciphertext, so
       the value must not appear anywhere in a dump — which is the property an
       operator with a backup actually relies on. */
    const tables = (await sql(cfg,
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'))
      .map((r) => r.t);
    assert.ok(tables.includes('password_reset_settings'), 'the settings table is there');
    const found = [];
    for (const table of tables) {
      const rows = await sql(cfg, `SELECT * FROM \`${table}\``).catch(() => []);
      const dump = JSON.stringify(rows);
      for (const value of [SECRET, SECRET_TWO]) {
        if (dump.includes(value)) found.push(table);
      }
    }
    assert.deepStrictEqual([...new Set(found)], [],
      `the value is readable in: ${[...new Set(found)].join(', ')}`);
  });
});

/* ------------------------------------------------- 4. strict mode, no fallback */

test('without the key, saving is refused rather than sealed under JWT_SECRET',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let server; let root;
    const call = (p, o) => api(server.base, p, o);

    t.before(async () => {
      await resetSchema(config('pwStrict'));
      /* JWT_SECRET PRESENT, EMAIL_ENCRYPTION_KEY ABSENT. This is the case
         src/email-secret.js's strict mode exists for: the non-strict path would
         borrow the signing key, which would mean a value encrypted under a key
         the deployment is told to rotate — and rotating it would destroy the
         stored default while signing everybody out. */
      server = await startServer(config('pwStrict'), {
        BOOTSTRAP_TOKEN: 'strict-token',
        JWT_SECRET: crypto.randomBytes(32).toString('hex'),
        EMAIL_ENCRYPTION_KEY: '',
        DEFAULT_USER_PASSWORD: '',
      });
      await call('/auth/bootstrap', { method: 'POST', body: {
        token: 'strict-token', name: 'Root', email: 'root@strict.test', password: PASSWORD } });
      root = (await call('/auth/login', { method: 'POST',
        body: { email: 'root@strict.test', password: PASSWORD } })).body.token;
    });
    t.after(async () => { if (server) await stopServer(server); });

    await t.test('the screen says the feature cannot be used', async () => {
      const state = await call('/admin/settings/password-reset', { token: root });
      assert.strictEqual(state.status, 200, JSON.stringify(state.body));
      assert.strictEqual(state.body.settings.encryptionAvailable, false);
      assert.match(state.body.settings.fallbackNote, /EMAIL_ENCRYPTION_KEY/);
    });

    await t.test('and a save is refused with the variable named', async () => {
      const r = await call('/admin/settings/password-reset/default', {
        token: root, method: 'PUT', body: { defaultPassword: SECRET },
      });
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'no_encryption_key');
      assert.match(r.body.error, /EMAIL_ENCRYPTION_KEY/);
      assert.match(r.body.error, /JWT_SECRET is deliberately not accepted/);
      const [row] = await sql(config('pwStrict'),
        'SELECT COUNT(*) AS n FROM password_reset_settings');
      assert.strictEqual(Number(row.n), 0, 'and nothing was stored');
    });
  });
