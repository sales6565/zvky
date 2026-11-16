/* THE TAB ICON: STORED, SERVED, GUARDED, LOGGED.
 *
 * tests/favicon-validate.test.js owns the question of which bytes are
 * acceptable — thirty-odd files, no server, milliseconds. This suite owns
 * everything only a running server can answer: that an upload survives into a
 * row, that the bytes come back unchanged to somebody who is not signed in,
 * that the headers let a browser cache it and ask again cheaply, that the
 * permission holds, that the audit entry says what happened without saying
 * where the file came from, and that nothing was written into the folder a
 * deploy replaces.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const fx = require('./image-fixtures');
const favicon = require('../src/favicon');

const cfg = config('favicon');
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'Branding-Owner-1!';

/* Every file under the deployed application folder, which is what a cPanel
   redeploy replaces. node_modules and .git are skipped because they are
   enormous and are not what this is watching for; the test databases live
   outside the tree entirely.

   THE POINT OF THIS is the one storage rule the brief gives: the icon must not
   be written inside the app folder, because an upload that lands there is gone
   the next time the studio deploys and nobody will connect the two events. */
function treeUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) treeUnder(full, out);
    else out.push(path.relative(ROOT, full));
  }
  return out.sort();
}

test('the tab icon, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const call = (p, o) => api(server.base, p, o);
  const as = (who, p, o = {}) => call(p, { ...o, token: token[who] });

  /* The public asset URL, which is NOT under /api — see src/routes/branding-icon.js.
     server.base ends in /api, so it is trimmed rather than rebuilt, which keeps
     the port in one place. */
  const origin = () => server.base.replace(/\/api$/, '');
  const iconUrl = (query = '') => `${origin()}/branding/favicon${query}`;

  /* An upload, with the filename and the declared type as separate things —
     which is the distinction the validation rules turn on. A Blob's `type`
     becomes the part's Content-Type (what the server sees as req.file.mimetype);
     the third argument is the filename, and the server must ignore it. */
  const upload = async (buffer, filename, type, who = 'root') => {
    const form = new FormData();
    form.append('favicon', new Blob([buffer], type ? { type } : {}), filename);
    const res = await fetch(`${server.base}/branding/favicon`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token[who]}` },
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  /* THE TREE BEFORE ANY UPLOAD HAS HAPPENED. Taken here, not inside the case
     that uses it — see the comment there; a snapshot taken later cannot see a
     file an earlier upload already wrote. */
  let pristineTree = null;

  t.before(async () => {
    await resetSchema(cfg);
    pristineTree = treeUnder(ROOT);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'icon-token' });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'icon-token', name: 'Root', email: 'root@icon.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@icon.test', password: PASSWORD } })).body.token;

    const ana = await as('root', '/users', { method: 'POST', body: {
      name: 'ana', email: 'ana@icon.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(ana.status, 201, JSON.stringify(ana.body));
    token.ana = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@icon.test', password: PASSWORD } })).body.token;

    const sam = await as('root', '/users', { method: 'POST', body: {
      name: 'sam', email: 'sam@icon.test', role: 'coordinator', password: PASSWORD } });
    assert.strictEqual(sam.status, 201, JSON.stringify(sam.body));
    token.sam = (await call('/auth/login', { method: 'POST',
      body: { email: 'sam@icon.test', password: PASSWORD } })).body.token;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ------------------------------------------------------- the empty state */

  await t.test('with nothing uploaded, there is nothing to serve', async () => {
    const res = await fetch(iconUrl());
    assert.strictEqual(res.status, 404, 'no icon, no bytes');
    /* The page is told the same thing through the payload it already fetches,
       so it knows to leave the head alone without asking a second question. */
    const payload = (await call('/branding')).body.branding;
    assert.strictEqual(payload.hasFavicon, false);
    assert.strictEqual(payload.faviconVersion, null);
    /* And the rest of the branding payload is untouched by any of this. */
    assert.ok(payload.appName, 'the name is still served');
  });

  /* --------------------------------------------------- uploaded and served */

  let firstVersion = null;
  const ICON = fx.png(512, 512);

  await t.test('an icon is stored and served back byte for byte', async () => {
    const up = await upload(ICON, 'studio-icon.png', 'image/png');
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.branding.hasFavicon, true);
    assert.strictEqual(up.body.branding.faviconMime, 'image/png');
    assert.strictEqual(up.body.branding.faviconWidth, 512);
    assert.strictEqual(up.body.branding.faviconHeight, 512);
    firstVersion = up.body.branding.faviconVersion;
    assert.match(firstVersion, /^[0-9a-f]{12}$/);

    const res = await fetch(iconUrl(`?v=${firstVersion}`));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual(bytes, ICON, 'the same bytes, unmodified');

    /* The row holds what the header said, measured once on the way in. */
    const [row] = await sql(cfg, 'SELECT * FROM branding_assets WHERE asset_key = ?', ['favicon']);
    assert.strictEqual(row.mime, 'image/png');
    assert.strictEqual(row.width, 512);
    assert.strictEqual(row.height, 512);
    assert.strictEqual(Number(row.byte_size), ICON.length);
    assert.strictEqual(row.sha256, favicon.digest(ICON));
    assert.strictEqual(row.sha256.slice(0, 12), firstVersion);
  });

  await t.test('the headers are the ones a browser needs', async () => {
    const res = await fetch(iconUrl(`?v=${firstVersion}`));
    /* NOSNIFF: these are bytes somebody uploaded, and a browser that decides
       for itself that they are HTML will run them. */
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    /* A STRONG ETAG, which is the digest — so the 304 below costs one header
       comparison rather than a blob read. */
    assert.strictEqual(res.headers.get('etag'), `"${favicon.digest(ICON)}"`);
    assert.ok(!res.headers.get('etag').startsWith('W/'), 'strong, not weak');
    /* THE URL CARRIES THE VERSION, so the answer to this exact URL can never
       change and may be held for a year. */
    assert.match(res.headers.get('cache-control'), /max-age=31536000/);
    assert.match(res.headers.get('cache-control'), /immutable/);
  });

  await t.test('a request without the version is cached briefly instead', async () => {
    /* A browser guessing at the URL, or a page served before the icon changed,
       must not be told to keep the answer for a year. */
    for (const url of [iconUrl(), iconUrl('?v=nottheversion')]) {
      const res = await fetch(url);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('cache-control'), /max-age=300/);
      assert.match(res.headers.get('cache-control'), /must-revalidate/);
      assert.ok(!/immutable/.test(res.headers.get('cache-control')));
    }
  });

  await t.test('a conditional request is answered 304 with no body', async () => {
    const etag = `"${favicon.digest(ICON)}"`;
    const fresh = await fetch(iconUrl(`?v=${firstVersion}`), { headers: { 'If-None-Match': etag } });
    assert.strictEqual(fresh.status, 304);
    assert.strictEqual((await fresh.arrayBuffer()).byteLength, 0, 'nothing is sent again');

    /* Several tags in one header is legal and happens. */
    const many = await fetch(iconUrl(), { headers: { 'If-None-Match': `"something-else", ${etag}` } });
    assert.strictEqual(many.status, 304);

    const star = await fetch(iconUrl(), { headers: { 'If-None-Match': '*' } });
    assert.strictEqual(star.status, 304);

    const stale = await fetch(iconUrl(), { headers: { 'If-None-Match': '"an-old-digest"' } });
    assert.strictEqual(stale.status, 200, 'a tag that does not match gets the image');
  });

  await t.test('it is served to somebody who is not signed in', async () => {
    /* The sign-in screen wears it, and that screen has no token by definition.
       Asserted with a bare fetch carrying no Authorization header at all. */
    const res = await fetch(iconUrl(`?v=${firstVersion}`));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).length, ICON.length);

    /* And so is the payload that tells the page the version. */
    const payload = await fetch(`${server.base}/branding`);
    assert.strictEqual(payload.status, 200);
    assert.strictEqual((await payload.json()).branding.faviconVersion, firstVersion);
  });

  await t.test('the route reads nothing from the request but the version', async () => {
    /* THE RULE: there is one row, found by a constant key, and nothing a caller
       sends can name a different thing to return. Every one of these is the
       same request as far as the route is concerned. */
    const expected = Buffer.from(await (await fetch(iconUrl(`?v=${firstVersion}`))).arrayBuffer());
    const meddling = [
      '?path=../../../../etc/passwd',
      '?file=/etc/hosts',
      '?v=' + firstVersion + '&path=/etc/passwd',
      '?asset_key=branding&key=../logo',
      '?v[]=1&v=' + firstVersion,
    ];
    for (const query of meddling) {
      const res = await fetch(iconUrl(query));
      assert.strictEqual(res.status, 200, query);
      assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), expected, query);
    }
    /* A path below the route is not the route. Express answers this from the
       single-page fallback, which is the same thing an unknown URL has always
       done — what matters is that it is not the icon route reading a path. */
    const deeper = await fetch(`${origin()}/branding/favicon/../../package.json`);
    assert.ok(deeper.status === 200 || deeper.status === 404, String(deeper.status));
    const body = await deeper.text();
    assert.ok(!body.includes('"dependencies"'), 'package.json is not served');
  });

  /* ------------------------------------------------------------ versioning */

  await t.test('the version follows the image and nothing else', async () => {
    const again = await upload(ICON, 'studio-icon.png', 'image/png');
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.branding.faviconVersion, firstVersion,
      're-uploading the same image keeps the URL, so caches keep their copy');

    const other = fx.png(512, 512, [10, 120, 200]);
    const changed = await upload(other, 'studio-icon.png', 'image/png');
    assert.strictEqual(changed.status, 200);
    assert.notStrictEqual(changed.body.branding.faviconVersion, firstVersion,
      'a different image is a different URL, which is what makes the long cache safe');

    const res = await fetch(iconUrl(`?v=${changed.body.branding.faviconVersion}`));
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), other);

    // Back to the first, so the cases below start from a known icon.
    await upload(ICON, 'studio-icon.png', 'image/png');
  });

  /* ----------------------------------------------- the rules, through HTTP */

  await t.test('what the route refuses, and what it keeps', async () => {
    /* The full table is tests/favicon-validate.test.js. These are the rows that
       are only meaningful over HTTP: the filename, the declared type, and
       multer's own size refusal — plus the rule that a refused upload leaves
       the icon that was already there alone. */
    const cases = [
      { what: 'an SVG named icon.png and announced as a PNG',
        bytes: fx.svg(), name: 'icon.png', type: 'image/png', expect: /SVG/ },
      { what: 'a double extension hiding an SVG',
        bytes: fx.svg(), name: 'icon.png.svg', type: 'image/svg+xml', expect: /SVG/ },
      { what: 'an animated PNG',
        bytes: fx.apng(), name: 'spinner.png', type: 'image/png', expect: /animated/ },
      { what: 'a banner',
        bytes: fx.png(512, 256), name: 'banner.png', type: 'image/png', expect: /not square/ },
      { what: 'an icon file holding only a 16x16',
        bytes: fx.icoTiny(), name: 'tiny.ico', type: 'image/x-icon', expect: /at least 32x32/ },
      { what: 'a file past the cap, which multer stops',
        bytes: fx.pngPadded(700 * 1024), name: 'huge.png', type: 'image/png', expect: /512KB limit|the limit is 512KB/ },
      { what: 'an empty file',
        bytes: Buffer.alloc(0), name: 'nothing.png', type: 'image/png', expect: /empty/ },
      { what: 'PNG bytes announced as a JPEG',
        bytes: fx.png(64, 64), name: 'icon.jpg', type: 'image/jpeg',
        expect: /says it is JPEG but its contents are PNG/ },
    ];

    for (const c of cases) {
      const res = await upload(c.bytes, c.name, c.type);
      assert.strictEqual(res.status, 400, `${c.what}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, c.expect, c.what);
      /* THE FIELD, so the page can put the message beside the control. */
      assert.strictEqual(res.body.field, 'favicon', c.what);
    }

    /* A refused upload must not disturb the icon in use — this is the failure
       that would be noticed a week later by somebody else. */
    const still = (await call('/branding')).body.branding;
    assert.strictEqual(still.hasFavicon, true);
    assert.strictEqual(still.faviconVersion, firstVersion);
  });

  await t.test('the name on the file decides nothing; the bytes decide', async () => {
    /* A PNG called holiday.jpg is a PNG. The extension is never consulted —
       see the source-level guard in tests/favicon-validate.test.js. */
    const misnamed = await upload(fx.png(256, 256), 'holiday.jpg', 'image/png');
    assert.strictEqual(misnamed.status, 200, JSON.stringify(misnamed.body));
    assert.strictEqual(misnamed.body.branding.faviconMime, 'image/png');

    /* A double extension the other way round, with no declared type at all:
       accepted, because the header is what was read. */
    const doubled = await upload(fx.webpLossless(128, 128), 'logo.svg.webp', null);
    assert.strictEqual(doubled.status, 200, JSON.stringify(doubled.body));
    assert.strictEqual(doubled.body.branding.faviconMime, 'image/webp');

    /* An .ico, which is the format this application did not accept anywhere
       before this change. */
    const icon = await upload(fx.ico([16, 32, 64]), 'favicon.ico', 'image/x-icon');
    assert.strictEqual(icon.status, 200, JSON.stringify(icon.body));
    assert.strictEqual(icon.body.branding.faviconMime, 'image/vnd.microsoft.icon');
    assert.strictEqual(icon.body.branding.faviconWidth, 64, 'measured by its largest image');

    const served = await fetch(iconUrl(`?v=${icon.body.branding.faviconVersion}`));
    assert.strictEqual(served.headers.get('content-type'), 'image/vnd.microsoft.icon');

    await upload(ICON, 'studio-icon.png', 'image/png');
  });

  /* ------------------------------------------------------------ the folder */

  await t.test('nothing is written inside the application folder', async () => {
    /* The storage rule, checked rather than asserted from the code: the whole
       tree is listed and compared. multer is configured with memoryStorage, so
       there is not even a temporary file — and if somebody later changes that,
       this is what fails.
     *
     * AGAINST THE TREE AS IT WAS BEFORE THE SUITE'S FIRST UPLOAD, and that
     * detail is the whole test. The first version snapshotted here, uploaded
     * once, and compared — which a mutation walked straight through: it wrote
     * public/favicon.ico on EVERY upload, so the file was already there by the
     * time this case took its "before", and before matched after perfectly. A
     * permanent write into the folder a deploy replaces was invisible to the
     * test written to catch exactly that.
     *
     * So the pristine listing is taken in t.before, and the local
     * before/after is kept as well: one catches a file that persists, the
     * other catches a temporary file that is written and tidied up by a later
     * upload. */
    const before = treeUnder(ROOT);
    const up = await upload(fx.png(300, 300), 'another.png', 'image/png');
    assert.strictEqual(up.status, 200);
    const after = treeUnder(ROOT);
    assert.deepStrictEqual(after, before,
      `the upload wrote files into the deployed folder:\n${
        after.filter((f) => !before.includes(f)).join('\n')}`);
    assert.deepStrictEqual(after, pristineTree,
      `something in this suite wrote files into the deployed folder:\n${
        after.filter((f) => !pristineTree.includes(f)).join('\n')}`);

    /* And the bytes really did go somewhere: the row has them. */
    const [row] = await sql(cfg, 'SELECT byte_size FROM branding_assets WHERE asset_key = ?', ['favicon']);
    assert.ok(Number(row.byte_size) > 0);
    await upload(ICON, 'studio-icon.png', 'image/png');
  });

  /* --------------------------------------------------------- the permission */

  await t.test('changing it needs settings.branding; reading it needs nothing', async () => {
    /* The key already existed for the name, tagline and logo, and the icon is
       the same authority: everyone sees the result on every screen. No new key
       was added, so nothing about the permission defaults moved. */
    const artistUp = await upload(fx.png(128, 128), 'icon.png', 'image/png', 'ana');
    assert.strictEqual(artistUp.status, 403, JSON.stringify(artistUp.body));
    const artistDel = await as('ana', '/branding/favicon', { method: 'DELETE' });
    assert.strictEqual(artistDel.status, 403);

    /* But an artist's browser still gets the icon, because their tab needs it. */
    assert.strictEqual((await fetch(iconUrl())).status, 200);

    const me = (await as('ana', '/auth/me')).body.user;
    assert.ok(!me.permissions.includes('settings.branding'), 'the artist does not hold the key');
    const root = (await as('root', '/auth/me')).body.user;
    assert.ok(root.permissions.includes('settings.branding'), 'the Super Admin does');
  });

  await t.test('the key granted through a role group works the same', async () => {
    const before = await upload(fx.png(128, 128), 'icon.png', 'image/png', 'sam');
    assert.strictEqual(before.status, 403, 'a coordinator cannot, to begin with');

    const group = await as('root', '/role-groups', { method: 'POST',
      body: { name: 'Brand Keepers', kind: 'custom' } });
    assert.strictEqual(group.status, 201, JSON.stringify(group.body));
    assert.strictEqual((await as('root', `/role-groups/${group.body.group.id}/permissions`,
      { method: 'PUT', body: { permissions: ['settings.branding'] } })).status, 200);
    assert.strictEqual((await as('root', `/role-groups/${group.body.group.id}/roles`,
      { method: 'PUT', body: { roles: ['coordinator'] } })).status, 200);

    const me = (await as('sam', '/auth/me')).body.user;
    assert.ok(me.permissions.includes('settings.branding'),
      'a key held only through a role group is missing from /auth/me');

    const after = await upload(fx.png(128, 128), 'sams-icon.png', 'image/png', 'sam');
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));

    await upload(ICON, 'studio-icon.png', 'image/png');
  });

  /* ------------------------------------------------------------ the audit */

  await t.test('every change is logged, with the name and size and never the path', async () => {
    const sent = fx.png(640, 640);
    const up = await upload(sent, 'C:\\Users\\Akilesh\\Desktop\\brand\\tab-icon.png', 'image/png');
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));

    const rows = await sql(cfg,
      `SELECT * FROM activity_log WHERE action = ? ORDER BY seq DESC LIMIT 5`,
      ['settings.branding.favicon']);
    assert.ok(rows.length, 'an entry was written');
    const entry = rows[0];
    assert.match(entry.summary, /tab-icon\.png/, 'the file name is in the entry');
    assert.match(entry.summary, /640x640/, 'and the size it was measured at');
    assert.match(entry.summary, /KB/, 'and what it weighs');

    /* THE PATH IS NOT. A directory listing names people, clients and projects,
       and an audit log is the wrong place for any of it. */
    const whole = JSON.stringify(rows);
    assert.ok(!whole.includes('C:\\\\'), 'a Windows path reached the log');
    assert.ok(!whole.includes('Akilesh'), 'the uploader\'s directories reached the log');
    assert.ok(!whole.includes('Desktop'), 'the path reached the log');
    /* And neither did the image. */
    assert.ok(!whole.includes(sent.toString('base64').slice(0, 24)), 'the bytes reached the log');

    /* Who and when come from the logger itself, like every other entry. */
    assert.ok(entry.actor_id, 'the entry names an actor');
    assert.strictEqual(entry.actor_email, 'root@icon.test');
    assert.strictEqual(entry.module, 'settings');
    assert.ok(entry.created_at, 'and a time');

    const removal = await as('root', '/branding/favicon', { method: 'DELETE' });
    assert.strictEqual(removal.status, 200);
    const [latest] = await sql(cfg,
      `SELECT summary FROM activity_log WHERE action = ? ORDER BY seq DESC LIMIT 1`,
      ['settings.branding.favicon']);
    assert.match(latest.summary, /Removed/, 'the removal is on the record too');
  });

  /* ----------------------------------------------------------- the removal */

  await t.test('removing it deletes the row and the default comes back', async () => {
    await upload(ICON, 'studio-icon.png', 'image/png');
    assert.strictEqual((await fetch(iconUrl())).status, 200);

    const gone = await as('root', '/branding/favicon', { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.strictEqual(gone.body.removed, true);
    assert.strictEqual(gone.body.branding.hasFavicon, false);
    assert.strictEqual(gone.body.branding.faviconVersion, null);

    /* THE ROW IS GONE, not blanked: "no icon" is the absence of a row, which is
       the same state a studio that never uploaded one is in. */
    const rows = await sql(cfg, 'SELECT * FROM branding_assets WHERE asset_key = ?', ['favicon']);
    assert.strictEqual(rows.length, 0);

    assert.strictEqual((await fetch(iconUrl())).status, 404);
    assert.strictEqual((await call('/branding')).body.branding.hasFavicon, false);

    /* Pressing it again is not an error. */
    const twice = await as('root', '/branding/favicon', { method: 'DELETE' });
    assert.strictEqual(twice.status, 200);
    assert.strictEqual(twice.body.removed, false);
  });

  await t.test('the rest of the branding settings are untouched by all of this', async () => {
    /* The brief's last build item: colours, logo and name are not this change's
       business. The name and tagline are set, an icon is uploaded and removed,
       and they are still what they were. */
    assert.strictEqual((await as('root', '/branding', { method: 'PUT',
      body: { appName: 'Forge Studio', tagline: 'we make things' } })).status, 200);
    await upload(ICON, 'studio-icon.png', 'image/png');
    await as('root', '/branding/favicon', { method: 'DELETE' });

    const after = (await call('/branding')).body.branding;
    assert.strictEqual(after.appName, 'Forge Studio');
    assert.strictEqual(after.tagline, 'we make things');
    assert.strictEqual(after.hasLogo, false, 'and no logo appeared from anywhere');
  });
});

/* ---------------------------------------------------------- the rate limit */

test('the upload route is rate limited', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  /* Its own server, because a limiter is per process and a low limit here would
     otherwise be spent by the suite above.

     THERE WAS NO PRECEDENT TO COPY. The brief says to limit this "like other
     upload routes", and src/server.js says in its own words that nothing in
     this application was limited except sign-in and password changes — the
     logo, avatars, thumbnails and chat attachments have no limiter to this day.
     So this is shaped like the three limiters that do exist, and the existing
     uploads were deliberately left alone. */
  const rateCfg = config('faviconRate');
  let server;
  const token = {};
  const call = (p, o) => api(server.base, p, o);

  t.before(async () => {
    await resetSchema(rateCfg);
    server = await startServer(rateCfg, {
      BOOTSTRAP_TOKEN: 'rate-token',
      FAVICON_UPLOAD_RATE_MAX: '3',
      FAVICON_UPLOAD_RATE_WINDOW_MINUTES: '60',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'rate-token', name: 'Root', email: 'root@rate.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@rate.test', password: PASSWORD } })).body.token;
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('a loop of uploads is stopped, and told why', async () => {
    const send = async () => {
      const form = new FormData();
      form.append('favicon', new Blob([fx.png(64, 64)], { type: 'image/png' }), 'i.png');
      const res = await fetch(`${server.base}/branding/favicon`, {
        method: 'POST', headers: { Authorization: `Bearer ${token.root}` }, body: form,
      });
      return res.status;
    };

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await send());
    assert.ok(statuses.includes(429), `no request was limited: ${statuses.join(',')}`);
    assert.strictEqual(statuses[0], 200, 'the first one went through');

    const limited = await fetch(`${server.base}/branding/favicon`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.root}` }, body: new FormData(),
    });
    assert.strictEqual(limited.status, 429);
    assert.match((await limited.json()).error, /Too many/);
  });

  await t.test('the public route is not limited, because every tab asks for it', async () => {
    /* A limiter on the serving route would turn one office behind one address
       into a studio whose tabs stop showing the icon at eleven in the morning.
       It is a cached GET of one small row. */
    const origin = server.base.replace(/\/api$/, '');
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${origin}/branding/favicon`);
      assert.ok(res.status === 200 || res.status === 404, `request ${i} answered ${res.status}`);
    }
  });
});

/* ------------------------------------------------------------- the migration */

test('the migration is additive and runs twice without complaint',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    const migCfg = config('faviconMigrate');
    let server;
    const token = {};
    const call = (p, o) => api(server.base, p, o);

    t.before(async () => {
      await resetSchema(migCfg);
      server = await startServer(migCfg, { BOOTSTRAP_TOKEN: 'mig-token' });
      await call('/auth/bootstrap', { method: 'POST', body: {
        token: 'mig-token', name: 'Root', email: 'root@mig.test', password: PASSWORD } });
      token.root = (await call('/auth/login', { method: 'POST',
        body: { email: 'root@mig.test', password: PASSWORD } })).body.token;
    });
    t.after(async () => { if (server) await stopServer(server); });

    await t.test('a fresh database gets the table, shaped as the module expects', async () => {
      const columns = await sql(migCfg,
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branding_assets'`);
      const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
      assert.deepStrictEqual(Object.keys(byName).sort(),
        ['asset_key', 'byte_size', 'bytes', 'height', 'mime', 'sha256', 'updated_at', 'updated_by', 'width']);
      /* MEDIUMBLOB, not BLOB: a BLOB holds 64KB and the cap on an icon is 512KB,
         so a BLOB would truncate most of what this feature accepts. */
      assert.strictEqual(byName.bytes.type, 'mediumblob');
      assert.strictEqual(byName.updated_by.nullable, 'YES');

      /* THE SCHEMA'S OWN COLLATION. Every CREATE TABLE in this application goes
         through applyTableOptions for one reason: MySQL refuses a join between
         columns whose collations disagree, and a table created with the server's
         default instead of the schema's is a foreign key that silently never
         gets created. There is a suite that checks this for every table; this
         asserts it here too, because this is the table the change added. */
      const [table] = await sql(migCfg,
        `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branding_assets'`);
      const [schema] = await sql(migCfg,
        `SELECT DEFAULT_COLLATION_NAME AS c FROM information_schema.SCHEMATA
          WHERE SCHEMA_NAME = DATABASE()`);
      assert.strictEqual(table.c, schema.c);
    });

    await t.test('a second run changes nothing and keeps what is there', async () => {
      /* Set the studio's name, upload an icon, then migrate again by restarting
         the server against the same database — which is exactly what a redeploy
         on cPanel does. */
      assert.strictEqual((await call('/branding', { method: 'PUT', token: token.root,
        body: { appName: 'Before The Migration', tagline: 'still here' } })).status, 200);

      const form = new FormData();
      form.append('favicon', new Blob([fx.png(256, 256)], { type: 'image/png' }), 'keep-me.png');
      const up = await fetch(`${server.base}/branding/favicon`, {
        method: 'POST', headers: { Authorization: `Bearer ${token.root}` }, body: form,
      });
      assert.strictEqual(up.status, 200);
      const kept = (await up.json()).branding.faviconVersion;

      await stopServer(server);
      server = await startServer(migCfg, { BOOTSTRAP_TOKEN: 'mig-token' });

      const after = (await call('/branding')).body.branding;
      assert.strictEqual(after.appName, 'Before The Migration', 'the branding row survived');
      assert.strictEqual(after.tagline, 'still here');
      assert.strictEqual(after.hasFavicon, true, 'and so did the icon');
      assert.strictEqual(after.faviconVersion, kept, 'with the same version, so caches hold');

      const rows = await sql(migCfg, 'SELECT COUNT(*) AS n FROM branding_assets');
      assert.strictEqual(Number(rows[0].n), 1, 'one row, not two');
    });

    await t.test('the health check knows about the table', async () => {
      /* src/schema-check.js turns a migration step that did not run into a named
         answer instead of a 500 from whichever endpoint touches the missing
         piece. A new table that is not in that list is a gap in the answer. */
      const health = await call('/health');
      assert.strictEqual(health.status, 200, JSON.stringify(health.body));
      const schemaCheck = require('../src/schema-check');
      const required = (schemaCheck.REQUIRED || []).map((r) => `${r.table}.${r.column || '*'}`);
      assert.ok(required.includes('branding_assets.*'),
        'branding_assets is missing from the schema check');
    });
  });
