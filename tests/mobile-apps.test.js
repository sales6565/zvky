/* The mobile apps: push, the manifest, and handing the builds out.
 *
 * FOUR THINGS HERE ARE WORTH BREAKING, and each is a failure that would
 * otherwise be discovered on somebody's phone rather than in this file.
 *
 *   The APNs token is raw r||s, not DER.    Node's default ECDSA encoding is
 *      DER, and Apple rejects it with a 403 saying only "InvalidProviderToken".
 *      It is one option in one call, and there is no way to notice it is wrong
 *      except by pushing to a real device.
 *
 *   Nothing under /m falls through.         The SPA catch-all answers any
 *      unmatched GET with index.html and a 200. iOS's installer daemon, handed
 *      HTML with a success status where it expected a plist, fails with a
 *      message naming neither the file nor the reason.
 *
 *   The opt-out is honoured before sending.  Somebody who switched their phone
 *      off in Profile must get nothing, and the check has to live in pushTo
 *      rather than in each caller — there are several callers.
 *
 *   The token gate is the whole gate.        The payload paths cannot be
 *      authenticated (the daemon has no session), so the unguessable path is
 *      the only thing between a stranger and the builds. A wrong one must 404
 *      without hinting that a right one exists.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, raw, SKIP_REASON } = require('./helpers');

const cfg = config('mobileapps');

/* Throwaway keys, generated per run. Nothing here reaches Apple or Google —
   what is checked is the SHAPE of what would be sent. */
const EC = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const RSA = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const PUSH_ENV = {
  APNS_KEY_ID: 'ABCD123456',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_BUNDLE_ID: 'com.zvky.forge',
  APNS_KEY_P8: EC.privateKey,
  FCM_PROJECT_ID: 'zvky-forge-test',
  FCM_CLIENT_EMAIL: 'push@zvky-forge-test.iam.gserviceaccount.com',
  FCM_PRIVATE_KEY: RSA.privateKey,
};

// Run something with a given environment, without poisoning the process for
// whatever runs after it.
function withEnv(env, fn) {
  const before = {};
  for (const [k, v] of Object.entries(env)) { before[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// Re-require a module with the current environment. src/mobile-dist.js reads
// its directory at load time, which is right in a server and inconvenient here.
function freshDist() {
  delete require.cache[require.resolve('../src/mobile-dist')];
  return require('../src/mobile-dist');
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zvky-dist-'));

// ---------------------------------------------------------------- push module

const push = require('../src/push-notifications');

test('push is off, and silently so, when nothing is configured', () => {
  withEnv({
    APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_BUNDLE_ID: '', APNS_KEY_P8: '',
    FCM_PROJECT_ID: '', FCM_CLIENT_EMAIL: '', FCM_PRIVATE_KEY: '',
  }, () => {
    const s = push.status();
    assert.strictEqual(s.configured, false);
    assert.strictEqual(s.apns, false);
    assert.strictEqual(s.fcm, false);
  });
});

test('one platform configured leaves the other off rather than breaking both', () => {
  withEnv({ ...PUSH_ENV, FCM_PROJECT_ID: '', FCM_CLIENT_EMAIL: '', FCM_PRIVATE_KEY: '' }, () => {
    const s = push.status();
    assert.strictEqual(s.apns, true, 'iOS is configured');
    assert.strictEqual(s.fcm, false, 'Android is not');
    assert.strictEqual(s.configured, true, 'and the app is still told push works');
  });
});

test('a half-configured platform counts as unconfigured, not as broken', () => {
  // Three of the four APNs values — the shape of a half-finished .env.
  withEnv({ ...PUSH_ENV, APNS_BUNDLE_ID: '' }, () => {
    assert.strictEqual(push.status().apns, false);
  });
});

test('the APNs provider token is an ES256 JWT signed as raw r||s, not DER', () => {
  /* THE ONE THAT CANNOT BE NOTICED ANY OTHER WAY.
   *
   * Node signs ECDSA as DER by default — a variable-length structure of about
   * 70 bytes. A JOSE signature is the raw pair, fixed at 64 for P-256. Apple's
   * answer to the wrong one is a 403 saying "InvalidProviderToken", which names
   * neither the encoding nor the key. */
  const token = withEnv(PUSH_ENV, () => push.apnsJwt(push.config()));
  const parts = token.split('.');
  assert.strictEqual(parts.length, 3, 'three segments');
  const [h, p, s] = parts;

  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.strictEqual(header.alg, 'ES256');
  assert.strictEqual(header.kid, PUSH_ENV.APNS_KEY_ID, 'Apple looks the key up by kid');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.strictEqual(claims.iss, PUSH_ENV.APNS_TEAM_ID);
  assert.ok(Number.isInteger(claims.iat), 'iat is seconds, not a Date');
  assert.ok(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 120);

  const sig = Buffer.from(s, 'base64url');
  assert.strictEqual(sig.length, 64, 'raw r||s for P-256 — DER would be about 70 and variable');

  const ok = crypto.createVerify('SHA256')
    .update(`${h}.${p}`)
    .verify({ key: EC.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  assert.strictEqual(ok, true, 'and it verifies as JOSE, which is what Apple checks');
});

test('the APNs token is reused rather than re-signed on every notification', () => {
  // Apple treats a provider minting a token per push as abuse. The cache is the
  // whole of the mitigation.
  withEnv(PUSH_ENV, () => {
    assert.strictEqual(push.apnsJwt(push.config()), push.apnsJwt(push.config()));
  });
});

test('but a changed key re-signs, rather than presenting the old token for an hour', () => {
  const first = withEnv(PUSH_ENV, () => push.apnsJwt(push.config()));
  const second = withEnv({ ...PUSH_ENV, APNS_KEY_ID: 'ROTATED999' }, () => push.apnsJwt(push.config()));
  assert.notStrictEqual(first, second);
  const header = JSON.parse(Buffer.from(second.split('.')[0], 'base64url').toString());
  assert.strictEqual(header.kid, 'ROTATED999');
});

test('the FCM assertion is an RS256 service-account JWT for the token endpoint', () => {
  const jwt = withEnv(PUSH_ENV, () => push.fcmAssertion(push.config()));
  const [h, p, s] = jwt.split('.');

  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.strictEqual(header.alg, 'RS256', 'signed with the service account key');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.strictEqual(claims.iss, PUSH_ENV.FCM_CLIENT_EMAIL);
  assert.strictEqual(claims.aud, 'https://oauth2.googleapis.com/token',
    'the assertion is exchanged for an access token, not sent to the messaging API');
  assert.ok(claims.scope.includes('firebase.messaging'));
  assert.ok(claims.exp > claims.iat);

  const ok = crypto.createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(RSA.publicKey, Buffer.from(s, 'base64url'));
  assert.strictEqual(ok, true);
});

test('escaped newlines in an env-var key are accepted, because .env mangles real ones', () => {
  const escaped = EC.privateKey.replace(/\n/g, '\\n');
  withEnv({ ...PUSH_ENV, APNS_KEY_ID: 'ESCAPED123', APNS_KEY_P8: escaped }, () => {
    assert.strictEqual(push.status().apns, true);
    const token = push.apnsJwt(push.config());
    const sig = Buffer.from(token.split('.')[2], 'base64url');
    assert.strictEqual(sig.length, 64, 'and it still signs correctly');
  });
});

// -------------------------------------------------------------- iOS manifest

const MANIFEST_SCRIPT = path.join(__dirname, '..', 'mobile', 'scripts', 'make-ios-manifest.js');

test('the manifest generator refuses a non-https base, which iOS would reject', () => {
  const out = path.join(os.tmpdir(), `zvky-manifest-bad-${process.pid}.plist`);
  assert.throws(
    () => execFileSync(process.execPath, [MANIFEST_SCRIPT, '--base', 'http://example.com/m/T', '--out', out],
      { stdio: 'pipe' }),
    /./,
    'plain http must fail loudly here rather than silently at install time',
  );
  assert.strictEqual(fs.existsSync(out), false, 'and it writes nothing');
});

test('the manifest names the .ipa by absolute URL, with the bundle id and version', () => {
  const out = path.join(os.tmpdir(), `zvky-manifest-ok-${process.pid}.plist`);
  const printed = execFileSync(process.execPath,
    [MANIFEST_SCRIPT, '--base', 'https://example.com/m/TOKEN/', '--version', '2.4.0', '--out', out],
    { encoding: 'utf8' });

  const plist = fs.readFileSync(out, 'utf8');
  assert.ok(plist.includes('<string>https://example.com/m/TOKEN/zvky.ipa</string>'),
    'absolute, because a system daemon fetches it and has no base to resolve against');
  assert.ok(plist.includes('<key>bundle-identifier</key><string>com.zvky.forge</string>'));
  assert.ok(plist.includes('<key>bundle-version</key><string>2.4.0</string>'));
  assert.ok(plist.includes('software-package'));
  assert.ok(!plist.includes('//zvky.ipa'), 'a trailing slash on --base must not double up');

  assert.ok(printed.includes(
    'itms-services://?action=download-manifest&url=https://example.com/m/TOKEN/manifest.plist'),
  'and it prints the install link, which is the thing that goes on the page');
  fs.unlinkSync(out);
});

// ------------------------------------------------------ distribution module

test('a wrong token never matches, and comparison does not depend on length', () => {
  const dir = tmpdir();
  withEnv({ MOBILE_DIST_DIR: dir, MOBILE_DIST_TOKEN: 'the-real-token-abcdefgh' }, () => {
    const dist = freshDist();
    assert.strictEqual(dist.tokenMatches('the-real-token-abcdefgh'), true);
    assert.strictEqual(dist.tokenMatches('the-real-token-abcdefgi'), false);
    assert.strictEqual(dist.tokenMatches('short'), false, 'a shorter candidate must not throw');
    assert.strictEqual(dist.tokenMatches('the-real-token-abcdefghIJKLMNOP'), false, 'nor a longer one');
    assert.strictEqual(dist.tokenMatches(''), false);
    assert.strictEqual(dist.tokenMatches(null), false);
    assert.strictEqual(dist.tokenMatches(undefined), false);
    assert.strictEqual(dist.tokenMatches(123), false);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a generated token is written down, so the link survives a restart', () => {
  const dir = tmpdir();
  const [first, second] = withEnv({ MOBILE_DIST_DIR: dir, MOBILE_DIST_TOKEN: '' },
    () => [freshDist().token(), freshDist().token()]);
  assert.strictEqual(first, second, 'a fresh process must find the same token');
  assert.ok(first.length >= 32, 'unguessable, not a short id');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.dist-token'), 'utf8').trim(), first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the status warns about exactly the things that fail silently on a phone', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'zvky.ipa'), 'not really an ipa');
  const statusWith = (env) => withEnv(
    { MOBILE_DIST_DIR: dir, MOBILE_DIST_TOKEN: 'tok', PUBLIC_BASE_URL: '', ...env },
    () => freshDist().status(null));
  const said = (s, fragment) => s.warnings.some((w) => w.includes(fragment));

  assert.ok(said(statusWith({ MOBILE_DIST_BASE: '' }), 'public address'),
    'an unset origin bakes the wrong URL into the manifest');
  assert.ok(said(statusWith({ MOBILE_DIST_BASE: 'http://box.local' }), 'plain http'),
    'iOS refuses http and says nothing useful about why');
  assert.ok(said(statusWith({ MOBILE_DIST_BASE: 'https://example.com' }), 'manifest.plist is not'),
    'an .ipa with no manifest cannot be installed at all');

  fs.writeFileSync(path.join(dir, 'manifest.plist'), '<plist/>');
  const fine = statusWith({ MOBILE_DIST_BASE: 'https://example.com' });
  assert.deepStrictEqual(fine.warnings, [], 'and it says nothing when nothing is wrong');
  assert.strictEqual(fine.iosInstallLink,
    'itms-services://?action=download-manifest&url=https://example.com/m/tok/manifest.plist');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a configured origin beats the one the request claims', () => {
  /* The manifest URL is fetched by a system daemon, so whatever hostname the
     phone happened to type must not end up inside it. */
  const dir = tmpdir();
  const req = { headers: { host: 'phone-typed-this.local', 'x-forwarded-proto': 'http' }, protocol: 'http' };
  withEnv({ MOBILE_DIST_DIR: dir, MOBILE_DIST_TOKEN: 'tok', MOBILE_DIST_BASE: 'https://real.example' }, () => {
    const s = freshDist().status(req);
    assert.strictEqual(s.base, 'https://real.example');
    assert.strictEqual(s.baseSource, 'configured');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ the permission

const catalog = require('../src/permission-catalog');

test('the distribution permission exists and is not granted by an ordinary tier', () => {
  assert.ok(catalog.isPermission('mobile.distribute'));
  const artist = catalog.baselineFor({ projectScope: 'own' });
  assert.strictEqual(artist.has('mobile.distribute'), false);
  // And a grant is enough on its own — no tier move, no code change.
  assert.strictEqual(catalog.effectiveFor({ projectScope: 'own' }, ['mobile.distribute']).has('mobile.distribute'), true);
});

// ------------------------------------------------------------ against a server

test('the mobile apps, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Mobile-Test-1!';
  const TOKEN = 'test-distribution-token-0123456789';
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zvky-dist-server-'));

  let server;
  let superToken;
  let staffToken;
  const call = (p, options) => api(server.base, p, options);
  const origin = () => server.base.replace(/\/api$/, '');
  const site = (p, options) => raw(origin() + p, '', options);
  // raw() drops the headers, and three of the assertions below are about
  // headers, so those go through fetch directly.
  const head = async (p) => {
    const res = await fetch(origin() + p);
    return { status: res.status, headers: res.headers };
  };

  t.before(async () => {
    fs.writeFileSync(path.join(distDir, 'zvky.apk'), 'pretend android package');
    fs.writeFileSync(path.join(distDir, 'manifest.plist'), '<?xml version="1.0"?><plist/>');
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token',
      MOBILE_DIST_DIR: distDir,
      MOBILE_DIST_TOKEN: TOKEN,
      MOBILE_DIST_BASE: 'https://mobile.example',
      ...PUSH_ENV,
    });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Mobile Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    superToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    })).body.token;
    await call('/users', {
      token: superToken, method: 'POST',
      body: { name: 'Ordinary Person', email: 'staff@zvky.test', role: 'game_artist', password: PASSWORD },
    });
    staffToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'staff@zvky.test', password: PASSWORD },
    })).body.token;
  });

  t.after(() => {
    stopServer(server);
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  // --- who may see the install link ----------------------------------------

  await t.test('the builds screen is Super Admin only, because it holds the token', async () => {
    const mine = await call('/mobile/builds', { token: superToken });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
    assert.strictEqual(mine.body.token, TOKEN);

    const theirs = await call('/mobile/builds', { token: staffToken });
    assert.strictEqual(theirs.status, 403);
    assert.ok(!JSON.stringify(theirs.body).includes(TOKEN), 'and the refusal does not leak it');

    const anon = await call('/mobile/builds');
    assert.strictEqual(anon.status, 401);
  });

  await t.test('granting it to a designation is enough — no code change, no tier move', async () => {
    const before = await call('/permissions/roles/game_artist', { token: superToken });
    const keys = before.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!keys.includes('mobile.distribute'), 'not held by default');

    await call('/permissions/roles/game_artist', {
      token: superToken, method: 'PUT', body: { permissions: [...keys, 'mobile.distribute'] },
    });
    assert.strictEqual((await call('/mobile/builds', { token: staffToken })).status, 200,
      'the grant alone opens it');

    await call('/permissions/roles/game_artist', {
      token: superToken, method: 'PUT', body: { permissions: keys },
    });
    assert.strictEqual((await call('/mobile/builds', { token: staffToken })).status, 403,
      'and taking it away closes it again');
  });

  // --- the unauthenticated payload paths ------------------------------------

  await t.test('the install page and the builds are served without a session', async () => {
    /* NOT A GAP. iOS fetches the manifest and the .ipa from a system daemon
       with none of the browser's session, so an authenticated path cannot work
       at all. What replaces it is the unguessable token, tested below. */
    const page = await site(`/m/${TOKEN}/`);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('itms-services://'), 'the iOS install link is on it');
    assert.ok(page.text.includes(`/m/${TOKEN}/zvky.apk`), 'and the Android download');
    assert.ok(/install unknown apps/i.test(page.text), 'with the step Android users get stuck on');
    assert.ok(/Safari/.test(page.text), 'and the one iPhone users get stuck on');

    const apk = await head(`/m/${TOKEN}/zvky.apk`);
    assert.strictEqual(apk.status, 200);
    assert.strictEqual(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(apk.headers.get('content-disposition') || '', /filename="zvky\.apk"/);

    const manifest = await head(`/m/${TOKEN}/manifest.plist`);
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual(manifest.headers.get('content-disposition'), null,
      'the manifest must be READ by iOS, not saved — an attachment header breaks the install');
  });

  await t.test('a wrong token gets a flat 404, and no hint that a right one exists', async () => {
    for (const bad of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`, 'x'.repeat(40)]) {
      for (const p of ['/', '/zvky.apk', '/manifest.plist']) {
        const res = await site(`/m/${bad}${p}`);
        assert.strictEqual(res.status, 404, `/m/${bad}${p}`);
        assert.ok(!res.text.includes(TOKEN));
        assert.ok(!/token/i.test(res.text), 'the refusal must not mention tokens at all');
      }
    }
  });

  await t.test('nothing under /m falls through to the single-page app', async () => {
    /* THE REGRESSION THIS LOCKS IN. The catch-all at the bottom of server.js
       answers any unmatched GET with index.html and a 200 — so before the
       terminal 404, /m/<valid token>/.dist-token returned the application's
       front page, and a mistyped manifest name would have handed iOS HTML with
       a success status. */
    for (const p of ['.dist-token', 'f/..%2f..%2f.env', 'nope.apk', 'zvky.aab', 'index.html', 'sub/dir/file']) {
      const res = await site(`/m/${TOKEN}/${p}`);
      assert.strictEqual(res.status, 404, `/m/${TOKEN}/${p} must not fall through`);
      assert.ok(!/<!DOCTYPE html>/i.test(res.text), `/m/${TOKEN}/${p} returned the SPA`);
    }
  });

  await t.test('a build that is not on the server says so, rather than 500ing', async () => {
    const ipa = await site(`/m/${TOKEN}/zvky.ipa`);   // never written in t.before
    assert.strictEqual(ipa.status, 404);
    assert.ok(/not been uploaded/i.test(ipa.text));

    const builds = await call('/mobile/builds', { token: superToken });
    assert.strictEqual(builds.body.ios, null, 'and the admin screen reports it as missing');
    assert.ok(builds.body.android, 'while the one that is there is described');
    assert.strictEqual(builds.body.android.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(distDir, 'zvky.apk'))).digest('hex'),
      'the digest is of the real file, so somebody can check their download');
    assert.strictEqual(builds.body.android.path, undefined,
      'and the server\'s own filesystem path is not in the payload');
  });

  await t.test('the payload paths are never cached or indexed — the URL is the secret', async () => {
    const res = await head(`/m/${TOKEN}/zvky.apk`);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  });

  // --- registering a phone, and the opt-out --------------------------------

  await t.test('registering a phone needs authentication and nothing else', async () => {
    const anon = await call('/push/devices', { method: 'POST', body: { token: 'a'.repeat(64), platform: 'ios' } });
    assert.strictEqual(anon.status, 401);

    /* No permission of its own, deliberately: registering a device is something
       you do to your own account from a phone you are already signed in on. An
       ordinary artist must be able to. */
    const theirs = await call('/push/devices', {
      token: staffToken, method: 'POST', body: { token: 'b'.repeat(64), platform: 'android' },
    });
    assert.strictEqual(theirs.status, 201, JSON.stringify(theirs.body));
  });

  await t.test('a nonsense device token is refused rather than stored', async () => {
    for (const bad of [{ token: '', platform: 'ios' }, { token: 'c'.repeat(64), platform: 'windows' }, {}]) {
      const res = await call('/push/devices', { token: staffToken, method: 'POST', body: bad });
      assert.strictEqual(res.status, 400, JSON.stringify(bad));
    }
  });

  await t.test('the phone switch is per person, independent of the email one, and needs no permission', async () => {
    const start = await call('/auth/push-preference', { token: staffToken });
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.body.pushNotifications, true,
      'opted IN by default — installing the app and allowing notifications were already two consents');
    assert.strictEqual(start.body.configured, true);
    assert.strictEqual(start.body.devices, 1, 'and it says whether there is anywhere to send to');

    const emailBefore = (await call('/auth/email-preference', { token: staffToken })).body.emailNotifications;

    await call('/auth/push-preference', { token: staffToken, method: 'POST', body: { pushNotifications: false } });
    assert.strictEqual((await call('/auth/push-preference', { token: staffToken })).body.pushNotifications, false);
    assert.strictEqual((await call('/auth/email-preference', { token: staffToken })).body.emailNotifications,
      emailBefore, 'and the email switch did not move');

    // It is their own switch: the super admin's is untouched.
    assert.strictEqual((await call('/auth/push-preference', { token: superToken })).body.pushNotifications, true);
  });

  await t.test('somebody opted out is skipped before anything is sent', async () => {
    /* The check lives in pushTo rather than in each caller, so this is the
       assertion that it is in the one place covering all of them. */
    const res = await call('/push/test', { token: staffToken, method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.skipped, 'opted out');
    assert.strictEqual(res.body.sent, 0);
    assert.match(res.body.message, /turned push notifications off/i);
  });

  await t.test('somebody with no phone registered is told that, not told it failed', async () => {
    await call('/auth/push-preference', { token: staffToken, method: 'POST', body: { pushNotifications: true } });
    await call(`/push/devices/${'b'.repeat(64)}`, { token: staffToken, method: 'DELETE' });

    const res = await call('/push/test', { token: staffToken, method: 'POST' });
    assert.strictEqual(res.body.skipped, 'no devices');
    assert.match(res.body.message, /no phone is registered/i);
  });

  await t.test('unregistering is idempotent, because the app does it while signing out', async () => {
    const again = await call(`/push/devices/${'b'.repeat(64)}`, { token: staffToken, method: 'DELETE' });
    assert.strictEqual(again.status, 200);
  });

  await t.test('a failed delivery never fails the action that raised it', async () => {
    /* The keys here are real keys that Apple and Google have never heard of, so
       every send fails. Assigning work must still work — a notification is a
       side effect, and src/push-notifications.js swallows its own errors for
       the same reason src/mailer.js does. */
    await call('/push/devices', {
      token: staffToken, method: 'POST', body: { token: 'd'.repeat(64), platform: 'ios' },
    });

    const clients = await call('/clients', { token: superToken });
    const clientId = (clients.body.clients || [])[0].id;
    const project = await call('/projects', {
      token: superToken, method: 'POST', body: { name: 'Push Test Project', clientId },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));

    const asset = await call(`/assets/project/${project.body.project.id}`, {
      token: superToken, method: 'POST', body: { name: 'Push Test Asset', type: 'prop' },
    });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));

    const me = (await call('/users', { token: superToken })).body.users.find((u) => u.email === 'staff@zvky.test');
    const assigned = await call(`/assets/${asset.body.asset.id}`, {
      token: superToken, method: 'PATCH', body: { assigneeId: me.id },
    });
    assert.strictEqual(assigned.status, 200,
      `the assignment must succeed despite the push failing: ${JSON.stringify(assigned.body)}`);

    const bell = await call('/notifications', { token: staffToken });
    assert.ok(/Push Test Asset/.test(JSON.stringify(bell.body.notifications || [])),
      'and the bell notification was still raised, which is what push hangs off');
  });
});
