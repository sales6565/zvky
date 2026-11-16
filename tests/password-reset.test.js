/* An administrator giving somebody a temporary password.
 *
 * The parts worth testing are the ones that are wrong quietly rather than
 * loudly:
 *
 *   THE FORCED CHANGE IS THE SERVER'S. A flag the browser honours and the API
 *   ignores would leave the temporary password working indefinitely for anyone
 *   who never opened the modal. So the assertions here are all against the API.
 *
 *   THE PERMISSION IS SUPER ADMIN ONLY, and was not always. The key has been in
 *   the catalogue for a while implied by manageUsers, so every such role has an
 *   enabled row already written. Narrowing the predicate does not rewrite those
 *   — a migration does, and only for rows nobody chose.
 *
 *   IT CANNOT BE A LADDER. Somebody granted this must not be able to reset the
 *   password of an account that could take the grant away again.
 *
 *   THE VALUE APPEARS ONCE. Not in the log, not in the notification, not in a
 *   second response.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/permission-catalog');
const policy = require('../src/password-policy');
const crypto = require('node:crypto');
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('passwordReset');

/* WHAT A RESET SETS A PASSWORD TO, GENERATED FRESH FOR THIS RUN.
 *
 * There was a literal here, read from the environment with a fallback to the
 * one in the source. Both are gone: the value is now configured per deployment
 * and sealed, and a test that knew a real one would put it back in the
 * repository. So this suite makes one up, hands it to the server through the
 * environment (the documented fallback source), and tests/password-default
 * scans the whole repository and this run's output for it.
 *
 * It MEETS the policy, deliberately. The old fixed value did not, and the suite
 * asserted that it did not — which was true and is no longer the shape of the
 * thing: a configured default is checked against the policy before it is
 * stored, because a default that could skip the rules would be a weak password
 * on every account anybody ever resets. */
const FIXED = `Rs-${crypto.randomBytes(9).toString('base64url')}-7a!`;

test('a reset sets ONE CONFIGURED VALUE, and the value is nowhere in the source', () => {
  /* THE HISTORY, because this assertion has now been inverted twice and a
     reader deserves the sequence:
     
       1. a GENERATED one-off per reset. The generator was policy.temporaryPassword.
       2. ONE FIXED VALUE, at the studio's request, so an administrator had one
          convention rather than two — hard-coded in src/routes/users.js with a
          note admitting that "a fixed value in the source is a value everybody
          with the repository knows".
       3. ONE CONFIGURED VALUE, sealed under EMAIL_ENCRYPTION_KEY, which is this.
     
     Step 2's honesty is what made step 3 obvious. */
  assert.strictEqual(policy.temporaryPassword, undefined,
    'the generator was removed when nothing called it any more');

  /* THE LITERAL IS GONE FROM THE SOURCE, which is the whole of step 3. Asserted
     against the file that held it rather than against a grep of everything —
     tests/password-default.test.js does the repository-wide scan. */
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'routes', 'users.js'), 'utf8');
  /* COMMENTS STRIPPED FIRST. The note that records what was removed quotes the
     declaration verbatim, because that quote is the history worth keeping — and
     a regex over the raw file matched it and reported the literal as back. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/DEFAULT_PASSWORD\s*=/.test(code),
    'src/routes/users.js declares a default password constant again');
  assert.ok(!/DEFAULT_USER_PASSWORD/.test(code),
    'src/routes/users.js reads the environment directly again instead of asking the resolver');
  assert.match(source, /require\('\.\.\/default-password'\)/,
    'and asks the one resolver for it instead');

  /* AND A CONFIGURED DEFAULT MUST MEET THE POLICY, which is the rule that
     replaced "the fixed value is deliberately below it". */
  const settings = require('../src/reset-password-settings');
  assert.strictEqual(settings.validateDefault('short').ok, false);
  assert.strictEqual(settings.validateDefault(FIXED).ok, true,
    'this run\'s generated value is policy-clean, as a configured one must be');
});

test('the permission is Super Admin only, and the action is no longer pending', () => {
  const entry = catalog.BY_KEY.get('user.reset_password');
  assert.ok(entry, 'the key is in the catalogue');
  assert.ok(!entry.pending, 'and no longer marked as unbuilt');
  assert.ok(entry.describe, 'and says what it does');

  /* By capability rather than by role name — the studio's standing rule. The
     Super Admin tier is the only one holding managePermissions. */
  const superAdmin = { manageUsers: true, managePermissions: true, projectScope: 'all' };
  const admin = { manageUsers: true, managePermissions: false, projectScope: 'all' };
  assert.strictEqual(entry.impliedBy(superAdmin), true);
  assert.strictEqual(entry.impliedBy(admin), false,
    'an account manager does not get it by being an account manager');
});

test('resetting a password', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Reset-Suite-1!';
  let server;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const login = async (email, password) => {
    const res = await call('/auth/login', { method: 'POST', body: { email, password } });
    return res;
  };

  t.before(async () => {
    await resetSchema(cfg);
    /* THIS RUN'S VALUE REACHES THE SERVER THROUGH THE ENVIRONMENT, which is the
       documented second source (src/default-password.js). Using it rather than
       the Settings route keeps this suite about the RESET; the configured path,
       the sealing and the leak scan are tests/password-default.test.js. */
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'reset-token', DEFAULT_USER_PASSWORD: FIXED,
    });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'reset-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token.root = (await login('root@zvky.test', PASSWORD)).body.token;

    /* hop holds head_of_production: manageUsers with studio-wide scope but NOT
       managePermissions. That combination is what makes the escalation guard
       reachable — mayAdministerUser lets them through, so the only thing left
       between them and the Super Admin's account is the guard itself. */
    for (const [who, role] of [['ana', 'game_artist'], ['mel', 'admin'],
      ['lee', 'team_lead'], ['hop', 'head_of_production']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = (await login(`${who}@zvky.test`, PASSWORD)).body.token;
    }
  });
  /* Put an account back to the suite's password after a reset. Every reset
     locks the account to the change, so a subtest that resets somebody and
     walks away leaves them unusable for every subtest after it. */
  const restore = async (who) => {
    const reset = await as('root', `/users/${people[who]}/reset-password`, { method: 'POST' });
    const temporary = reset.body.temporaryPassword;
    const signedIn = await login(`${who}@zvky.test`, temporary);
    await api(server.base, '/auth/password', { method: 'POST', token: signedIn.body.token,
      body: { currentPassword: temporary, newPassword: PASSWORD, confirmPassword: PASSWORD } });
    token[who] = (await login(`${who}@zvky.test`, PASSWORD)).body.token;
  };

  t.after(async () => {
    // The borrowed connection keeps the process alive if it is left open.
    if (pool.conn) await pool.conn.end().catch(() => {});
    stopServer(server);
  });

  await t.test('nobody but the Super Admin is given it to begin with', async () => {
    /* The migration's job. 'user.reset_password' was implied by manageUsers
       when it was a placeholder, so an Admin's row for it was written enabled.
       What arrives with the action built is that row switched off — and only
       because nobody had chosen it. */
    const rows = await sql(cfg,
      'SELECT role_key, enabled, updated_by_email FROM role_permissions WHERE permission_key = ?',
      ['user.reset_password']);
    for (const row of rows) {
      if (row.role_key === 'super_admin') continue;
      assert.strictEqual(Number(row.enabled), 0,
        `${row.role_key} should not start with it: ${JSON.stringify(row)}`);
    }
    const held = await rolePermissions.effectiveFor(await pool(), 'admin');
    assert.ok(!held.has('user.reset_password'), 'and the effective set agrees with the rows');

    const refused = await as('mel', `/users/${people.ana}/reset-password`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
  });

  await t.test('the Super Admin resets it, and the account is locked to the change', async () => {
    const res = await as('root', `/users/${people.ana}/reset-password`, { method: 'POST' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    /* THE BODY CARRIES NO PASSWORD. It used to return `temporaryPassword` for
       the page to print; the admin is now told the reset used the default and
       nothing that could be screenshotted or logged by a proxy. */
    assert.strictEqual(res.body.temporaryPassword, undefined,
      'the reset response is still handing the password back');
    assert.ok(!JSON.stringify(res.body).includes(FIXED),
      'the password is somewhere in the reset response');
    assert.match(res.body.message, /default password/i);
    assert.match(res.body.message, /sign in and change it/i);
    assert.strictEqual(res.body.usedDefault, true);

    /* The test knows the value because it generated it and handed it to the
       server; nothing it received told it. */
    const temporary = FIXED;

    // The old one is dead, and the old session with it.
    assert.strictEqual((await login('ana@zvky.test', PASSWORD)).status, 401);
    const stale = await as('ana', '/auth/me');
    assert.strictEqual(stale.status, 401, 'the session open at the time is signed out');

    const signedIn = await login('ana@zvky.test', temporary);
    assert.strictEqual(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.strictEqual(Number(signedIn.body.user.mustChangePassword), 1,
      'and the account says it must change');
    token.ana = signedIn.body.token;

    /* THE LOCK, and it is the API's. Everything is refused with the reason,
       so a browser that ignores the flag still cannot use the account. */
    for (const path of ['/projects', '/users', '/notifications', '/timesheets/week']) {
      const blocked = await as('ana', path);
      assert.strictEqual(blocked.status, 403, `${path} should be refused: ${blocked.status}`);
      assert.strictEqual(blocked.body.mustChangePassword, true, path);
      assert.match(blocked.body.error, /reset by an administrator/i);
    }
    // And the way out is open.
    assert.strictEqual((await as('ana', '/auth/me')).status, 200);
    assert.strictEqual((await as('ana', '/auth/password-policy')).status, 200);

    // Changing it clears the lock and lets the account work again.
    const changed = await as('ana', '/auth/password', { method: 'POST',
      body: { currentPassword: temporary, newPassword: 'Ana-Chose-This-1!', confirmPassword: 'Ana-Chose-This-1!' } });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    token.ana = changed.body.token;
    assert.strictEqual((await as('ana', '/projects')).status, 200, 'and the app answers again');
    const back = await login('ana@zvky.test', 'Ana-Chose-This-1!');
    assert.strictEqual(Number(back.body.user.mustChangePassword), 0);
    token.ana = back.body.token;
  });

  await t.test('every reset gives the same password, which is the point of it', async () => {
    /* The studio asked for one value an administrator can say from memory
       rather than a different one each time. Two resets of two accounts, and a
       second reset of the same account, all hand back the same string. */
    const first = await as('root', `/users/${people.ana}/reset-password`, { method: 'POST' });
    const second = await as('root', `/users/${people.ana}/reset-password`, { method: 'POST' });
    const other = await as('root', `/users/${people.lee}/reset-password`, { method: 'POST' });
    for (const [label, r] of [['first', first], ['second', second], ['other account', other]]) {
      assert.strictEqual(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
      assert.ok(!JSON.stringify(r.body).includes(FIXED), `${label} leaked the password`);
    }
    /* THE SAME VALUE EVERY TIME, proved by using it rather than by reading it
       back: each of the three accounts signs in with it. */
    assert.strictEqual((await login('ana@zvky.test', FIXED)).status, 200, 'the same account twice');
    assert.strictEqual((await login('lee@zvky.test', FIXED)).status, 200, 'and a different account');

    /* It is the same string a NEW account is created with, which is the other
       half of what was asked for: one convention, not two — and that response
       carries no password either. */
    const made = await as('root', '/users', { method: 'POST',
      body: { name: 'fresh', email: 'fresh@zvky.test', role: 'game_artist' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.temporaryPassword, undefined,
      'creating an account is still handing the password back');
    assert.strictEqual(made.body.usedDefault, true);
    assert.strictEqual((await login('fresh@zvky.test', FIXED)).status, 200,
      'creating an account and resetting one hand over the same thing');

    await restore('ana');
    await restore('lee');
  });

  await t.test('the value is still kept out of the log and the notification', async () => {
    /* It is a known string now, so this is no longer about secrecy. It stays
       out for two reasons that outlive the change: the value is settable per
       deployment, so a log quoting it would leak whatever it was set to; and a
       record that names passwords is a habit rather than a one-off. */
    const res = await as('root', `/users/${people.lee}/reset-password`, { method: 'POST' });
    const temporary = res.body.temporaryPassword;

    const stored = await sql(cfg, 'SELECT password_hash FROM users WHERE id = ?', [people.lee]);
    assert.ok(!stored[0].password_hash.includes(temporary), 'hashed, not stored as itself');

    const log = await sql(cfg,
      'SELECT summary, changes FROM activity_log WHERE action = ? AND entity_id = ?',
      ['user.reset_password', people.lee]);
    assert.ok(log.length, 'the action is on the record');
    assert.match(log[0].summary, /Reset the password for lee/);
    /* Against EVERY row, not just this one: an earlier reset writing a value
       into the log would be just as bad, and the suite has already made
       several. */
    const everything = await sql(cfg, 'SELECT * FROM activity_log');
    for (const row of everything) {
      assert.ok(!JSON.stringify(row).includes(temporary), 'and no value is in any of it');
    }

    const notes = await sql(cfg, 'SELECT * FROM notifications WHERE recipient_id = ?', [people.lee]);
    assert.ok(notes.length, 'the account holder is told');
    assert.strictEqual(notes[0].kind, 'password_reset');
    for (const row of notes) {
      assert.ok(!JSON.stringify(row).includes(temporary), 'without the value in it');
    }
    // Put lee back so later subtests can sign in as them.
    const signedIn = await login('lee@zvky.test', temporary);
    await api(server.base, '/auth/password', { method: 'POST', token: signedIn.body.token,
      body: { currentPassword: temporary, newPassword: PASSWORD, confirmPassword: PASSWORD } });
    token.lee = (await login('lee@zvky.test', PASSWORD)).body.token;
  });

  await t.test('granting the permission is what makes it work elsewhere', async () => {
    const held = [...await rolePermissions.effectiveFor(await pool(), 'admin')];
    await as('root', '/permissions/roles/admin', { method: 'PUT',
      body: { permissions: [...held, 'user.reset_password'] } });

    const allowed = await as('mel', `/users/${people.ana}/reset-password`, { method: 'POST' });
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    /* NO PASSWORD IN THE BODY any more; what proves the reset happened is that
       the account now says it must change, which only a reset sets. */
    assert.strictEqual(allowed.body.usedDefault, true);

    // Put ana back.
    const t2 = (await login('ana@zvky.test', allowed.body.temporaryPassword)).body.token;
    await api(server.base, '/auth/password', { method: 'POST', token: t2,
      body: { currentPassword: allowed.body.temporaryPassword,
        newPassword: PASSWORD, confirmPassword: PASSWORD } });
    token.ana = (await login('ana@zvky.test', PASSWORD)).body.token;
  });

  await t.test('it cannot be used to climb', async () => {
    /* Somebody granted this may not reset the account that could take the grant
       back. Judged on the TARGET'S PERMISSIONS, not on a role name — the
       studio's standing rule, and the thing that keeps working when a
       designation is renamed or a new one is added.

       Asked of head_of_production rather than of the Admin above, because an
       Admin is stopped one step earlier by mayAdministerUser (their scope is
       their own projects) and would prove nothing about this guard. */
    const held = [...await rolePermissions.effectiveFor(await pool(), 'head_of_production')];
    await as('root', '/permissions/roles/head_of_production', { method: 'PUT',
      body: { permissions: [...held, 'user.reset_password'] } });
    assert.strictEqual((await as('hop', `/users/${people.lee}/reset-password`, { method: 'POST' })).status,
      200, 'they can reset an ordinary account');
    // Put lee back, since the reset above locks them out.
    await restore('lee');

    const rootRow = await sql(cfg, 'SELECT id FROM users WHERE email = ?', ['root@zvky.test']);
    const tryRoot = await as('hop', `/users/${rootRow[0].id}/reset-password`, { method: 'POST' });
    assert.strictEqual(tryRoot.status, 403, JSON.stringify(tryRoot.body));
    assert.match(tryRoot.body.error, /who may do what/i);
    // And the Super Admin's password still works, which is the point of it.
    assert.strictEqual((await login('root@zvky.test', PASSWORD)).status, 200);

    /* The Super Admin may reset theirs, both ways round: holding
       settings.permissions is what lets you reset somebody who holds it. */
    assert.strictEqual((await as('root', `/users/${people.hop}/reset-password`, { method: 'POST' })).status, 200);
    await restore('hop');
  });

  await t.test('your own password is not reset from here', async () => {
    const rootRow = await sql(cfg, 'SELECT id FROM users WHERE email = ?', ['root@zvky.test']);
    const res = await as('root', `/users/${rootRow[0].id}/reset-password`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /from Profile/i);
  });

  await t.test('and an account that does not exist is a 404, not a reset', async () => {
    const res = await as('root', '/users/00000000-0000-0000-0000-000000000000/reset-password',
      { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });

  /* effectiveFor wants a db handle; the suite talks to the same schema the
     server does, so borrow one rather than reaching into the server. */
  async function pool() {
    const mysql = require('mysql2/promise');
    if (!pool.conn) {
      pool.conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      });
    }
    return {
      query: async (text, params) => {
        const sqlText = text.replace(/\$(\d+)/g, '?');
        const [rows] = await pool.conn.query(sqlText, params || []);
        return { rows: Array.isArray(rows) ? rows : [] };
      },
    };
  }
});
