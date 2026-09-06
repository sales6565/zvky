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
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('passwordReset');

/* What a reset sets a password to. One value, shared with account creation —
   see DEFAULT_PASSWORD in src/routes/users.js, including what it costs. */
const FIXED = process.env.DEFAULT_USER_PASSWORD || 'zvky2026';

test('a reset sets ONE FIXED VALUE, which is the studio\'s decision and its cost', () => {
  /* This used to assert a generated one-off. The studio asked for a single
     fixed password instead — the same one a new account is created with — so
     what is asserted now is that decision and the two things that follow from
     it, both of which somebody reading this later needs to see stated rather
     than discover.

     ONE: the generator is gone rather than left exported and unused, because a
     function nothing calls is one the next reader assumes is live. */
  assert.strictEqual(policy.temporaryPassword, undefined,
    'the generator was removed when nothing called it any more');

  /* TWO: the fixed value does NOT meet the studio's own password policy, and is
     not supposed to. It is a credential with one use, which the policy is then
     enforced on — the change endpoint checks the NEW password, never the
     current one. Pinned so that a later change to either the value or the rules
     is a deliberate act rather than a surprise. */
  assert.strictEqual(policy.check(FIXED).valid, false,
    'it is below the policy, which is why the account is locked until it is replaced');

  /* And it is settable per deployment, which is the only thing that stops the
     value being whatever is printed in a public repository. */
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'routes', 'users.js'), 'utf8');
  assert.match(source, /process\.env\.DEFAULT_USER_PASSWORD \|\| 'zvky2026'/);
  assert.match(source, /take over a just-reset account/i,
    'and the risk it carries is written down beside it');
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
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'reset-token' });
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
    const temporary = res.body.temporaryPassword;
    assert.strictEqual(temporary, FIXED,
      'the studio\'s standing password, not a generated one');
    /* Deliberately NOT policy-valid — see the note at the top of this file. It
       is accepted as the CURRENT password on the way out of the lock, and the
       policy is enforced on whatever replaces it. */
    assert.strictEqual(policy.check(temporary).valid, false);

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
    assert.strictEqual(first.body.temporaryPassword, FIXED);
    assert.strictEqual(second.body.temporaryPassword, FIXED, 'the same account twice');
    assert.strictEqual(other.body.temporaryPassword, FIXED, 'and a different account');

    /* It is the same string a NEW account is created with, which is the other
       half of what was asked for: one convention, not two. */
    const made = await as('root', '/users', { method: 'POST',
      body: { name: 'fresh', email: 'fresh@zvky.test', role: 'game_artist' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.temporaryPassword, FIXED,
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
    assert.ok(allowed.body.temporaryPassword);

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
