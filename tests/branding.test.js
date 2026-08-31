const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');
const branding = require('../src/branding');
const catalog = require('../src/permission-catalog');

const cfg = config('branding');

test('a blank name falls back; a blank tagline is a choice', () => {
  /* Clearing the NAME leaves the header with nothing in it, which nobody
     means — so it goes back to the default. Clearing the TAGLINE hides one
     line, which is a perfectly ordinary thing to want, so it is kept. */
  assert.strictEqual(branding.cleanName('  ').value, branding.DEFAULTS.appName);
  assert.strictEqual(branding.cleanName('  Forge  ').value, 'Forge');
  assert.ok(branding.cleanName('x'.repeat(61)).error);

  assert.strictEqual(branding.cleanTagline('').value, '');
  assert.strictEqual(branding.cleanTagline(undefined).value, null);
  assert.ok(branding.cleanTagline('y'.repeat(121)).error);
});

test('Manage Branding is a Settings permission', () => {
  assert.ok(catalog.isPermission('settings.branding'));
  const entry = catalog.ALL.find((p) => p.key === 'settings.branding');
  assert.strictEqual(entry.group, 'settings');
  const { capabilitiesForTier } = require('../src/role-tiers');
  assert.ok(catalog.baselineFor(capabilitiesForTier('super_admin')).has('settings.branding'));
  assert.ok(!catalog.baselineFor(capabilitiesForTier('lead')).has('settings.branding'));
});

test('branding end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Branding-Test-1!';
  let server; const token = {};
  const call = (p, o) => api(server.base, p, o);

  // A one-pixel PNG, so the upload path is exercised with a real image.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tok' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const artist = await call('/users', { method: 'POST', token: token.root,
      body: { name: 'ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(artist.status, 201, JSON.stringify(artist.body));
    token.ana = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@zvky.test', password: PASSWORD } })).body.token;
  });
  t.after(() => stopServer(server));

  await t.test('it ships with the default name and is readable without signing in', async () => {
    const res = await call('/branding');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.branding.appName, 'ZVKY FORGE');
    assert.strictEqual(res.body.branding.hasLogo, false);
    // The sign-in screen wears these and has no token, so this must not 401.
    assert.ok(!res.body.error);
  });

  await t.test('a Super Admin changes the name and tagline', async () => {
    const saved = await call('/branding', { method: 'PUT', token: token.root,
      body: { appName: 'Nightgarden Forge', tagline: 'pipeline for games' } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.branding.appName, 'Nightgarden Forge');
    assert.strictEqual((await call('/branding')).body.branding.tagline, 'pipeline for games');

    // Emptying the tagline hides it; emptying the name puts the default back.
    await call('/branding', { method: 'PUT', token: token.root,
      body: { appName: 'Nightgarden Forge', tagline: '' } });
    assert.strictEqual((await call('/branding')).body.branding.tagline, '');
    await call('/branding', { method: 'PUT', token: token.root, body: { appName: '  ' } });
    assert.strictEqual((await call('/branding')).body.branding.appName, 'ZVKY FORGE');
  });

  await t.test('a role without the permission cannot change it', async () => {
    const refused = await call('/branding', { method: 'PUT', token: token.ana,
      body: { appName: 'Anas App' } });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual((await call('/branding')).body.branding.appName, 'ZVKY FORGE',
      'and nothing moved');
  });

  const upload = async (buffer, filename, type, who = 'root') => {
    const form = new FormData();
    form.append('logo', new Blob([buffer], { type }), filename);
    const res = await fetch(`${server.base}/branding/logo`, {
      method: 'POST', headers: { Authorization: `Bearer ${token[who]}` }, body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await t.test('a logo is uploaded, served back, and replaces the letter', async () => {
    assert.strictEqual((await fetch(`${server.base}/branding/logo`)).status, 404,
      'no logo yet');

    const up = await upload(PNG, 'logo.png', 'image/png');
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.branding.hasLogo, true);

    const served = await fetch(`${server.base}/branding/logo`);
    assert.strictEqual(served.status, 200);
    assert.match(served.headers.get('content-type'), /image\/png/);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.deepStrictEqual(bytes, PNG, 'the same image comes back');

    // Served without a token, like the name: the sign-in screen shows it.
    assert.strictEqual((await fetch(`${server.base}/branding/logo`)).status, 200);
  });

  await t.test('the format and size rules are enforced', async () => {
    const pdf = await upload(Buffer.from('%PDF-1.4 not an image'), 'logo.pdf', 'application/pdf');
    assert.strictEqual(pdf.status, 400);
    assert.match(JSON.stringify(pdf.body), /PNG, SVG, JPEG or WebP/);

    const huge = await upload(Buffer.alloc(branding.MAX_LOGO_BYTES + 1024, 1), 'big.png', 'image/png');
    assert.ok(huge.status >= 400, 'an oversized file is refused');

    // The good one is still there — a refused upload must not clear it.
    assert.strictEqual((await call('/branding')).body.branding.hasLogo, true);
  });

  await t.test('an artist cannot upload or remove a logo', async () => {
    assert.strictEqual((await upload(PNG, 'logo.png', 'image/png', 'ana')).status, 403);
    const del = await call('/branding/logo', { method: 'DELETE', token: token.ana });
    assert.strictEqual(del.status, 403);
    assert.strictEqual((await call('/branding')).body.branding.hasLogo, true);
  });

  await t.test('removing the logo goes back to the letter', async () => {
    const gone = await call('/branding/logo', { method: 'DELETE', token: token.root });
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.body.branding.hasLogo, false);
    assert.strictEqual((await fetch(`${server.base}/branding/logo`)).status, 404);
  });
});
