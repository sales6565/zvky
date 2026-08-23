const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

const cfg = config();

test('change password', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const ORIGINAL = 'Original-Pass-1!';
  const BOOTSTRAP_TOKEN = 'test-bootstrap-token';
  let server;

  // A fresh database and server for the suite; each test re-establishes the
  // password it needs, so one failure cannot cascade into the next.
  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN });
    const created = await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: BOOTSTRAP_TOKEN, name: 'Test Admin', email: 'admin@zvky.test', password: ORIGINAL },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  });

  t.after(() => stopServer(server));

  const signIn = async (password) => {
    const res = await api(server.base, '/auth/login', {
      method: 'POST',
      body: { email: 'admin@zvky.test', password },
    });
    assert.strictEqual(res.status, 200, `could not sign in with ${password}: ${JSON.stringify(res.body)}`);
    return res.body.token;
  };

  // Put the password back so each test starts from the same place.
  const restore = async (from) => {
    const token = await signIn(from);
    const res = await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: from, newPassword: ORIGINAL, confirmPassword: ORIGINAL },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  };

  await t.test('changes the password when everything is valid', async () => {
    const token = await signIn(ORIGINAL);
    const res = await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: ORIGINAL, newPassword: 'Brand-New-Pass-9!', confirmPassword: 'Brand-New-Pass-9!' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.token, 'a replacement token should be returned');

    await signIn('Brand-New-Pass-9!');
    const old = await api(server.base, '/auth/login', {
      method: 'POST', body: { email: 'admin@zvky.test', password: ORIGINAL },
    });
    assert.strictEqual(old.status, 401, 'the old password must stop working');

    await restore('Brand-New-Pass-9!');
  });

  await t.test('refuses a wrong current password', async () => {
    const token = await signIn(ORIGINAL);
    const res = await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: 'Not-My-Password-1!', newPassword: 'Brand-New-Pass-9!', confirmPassword: 'Brand-New-Pass-9!' },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.field, 'currentPassword');
    // The password must still be the original.
    await signIn(ORIGINAL);
  });

  await t.test('refuses a mismatched confirmation', async () => {
    const token = await signIn(ORIGINAL);
    const res = await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: ORIGINAL, newPassword: 'Brand-New-Pass-9!', confirmPassword: 'Something-Else-9!' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.field, 'confirmPassword');
    assert.match(res.body.error, /do not match/i);
    await signIn(ORIGINAL);
  });

  await t.test('refuses a password that fails the policy', async () => {
    const token = await signIn(ORIGINAL);
    for (const weak of ['short', 'all-lower-case-1!', 'NoSymbolsAtAll12', 'NoNumbers!!!Abc']) {
      const res = await api(server.base, '/auth/password', {
        method: 'POST', token,
        body: { currentPassword: ORIGINAL, newPassword: weak, confirmPassword: weak },
      });
      assert.strictEqual(res.status, 400, `"${weak}" should have been refused`);
      assert.strictEqual(res.body.field, 'newPassword');
      assert.ok(Array.isArray(res.body.failed) && res.body.failed.length > 0);
    }
    await signIn(ORIGINAL);
  });

  await t.test('refuses reusing the current password', async () => {
    const token = await signIn(ORIGINAL);
    const res = await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: ORIGINAL, newPassword: ORIGINAL, confirmPassword: ORIGINAL },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /different/i);
  });

  await t.test('requires authentication', async () => {
    const res = await api(server.base, '/auth/password', {
      method: 'POST',
      body: { currentPassword: ORIGINAL, newPassword: 'Brand-New-Pass-9!', confirmPassword: 'Brand-New-Pass-9!' },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('signs out other devices but not the one making the change', async () => {
    const laptop = await signIn(ORIGINAL);
    const phone = await signIn(ORIGINAL);

    assert.strictEqual((await api(server.base, '/auth/me', { token: phone })).status, 200);

    const res = await api(server.base, '/auth/password', {
      method: 'POST', token: laptop,
      body: { currentPassword: ORIGINAL, newPassword: 'Brand-New-Pass-9!', confirmPassword: 'Brand-New-Pass-9!' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual((await api(server.base, '/auth/me', { token: phone })).status, 401, 'the other device should be signed out');
    assert.strictEqual((await api(server.base, '/auth/me', { token: laptop })).status, 401, 'the token used to make the change is superseded');
    assert.strictEqual((await api(server.base, '/auth/me', { token: res.body.token })).status, 200, 'the replacement token should work');

    await restore('Brand-New-Pass-9!');
  });

  await t.test('never writes a password into the logs', async () => {
    const token = await signIn(ORIGINAL);
    await api(server.base, '/auth/password', {
      method: 'POST', token,
      body: { currentPassword: 'Wrong-Password-1!', newPassword: 'Leaky-Password-9!', confirmPassword: 'Leaky-Password-9!' },
    });
    const logs = server.output();
    assert.ok(!logs.includes('Leaky-Password-9!'), 'the new password appeared in the server output');
    assert.ok(!logs.includes('Wrong-Password-1!'), 'the attempted password appeared in the server output');
    assert.ok(!logs.includes(ORIGINAL), 'the current password appeared in the server output');
  });

  await t.test('publishes the same rules the browser checks against', async () => {
    const res = await api(server.base, '/auth/password-policy');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.minLength, require('../src/password-policy').MIN_LENGTH);
    assert.deepStrictEqual(
      res.body.rules.map((r) => r.id).sort(),
      ['length', 'lowercase', 'number', 'symbol', 'uppercase']
    );
  });
});
