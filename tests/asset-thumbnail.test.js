/* The preview image on an asset.
 *
 * Two of these tests are for things the brief could not know to ask for, and
 * they are the ones worth writing:
 *
 *   the bytes never reach a board response — the board reads assets with
 *   SELECT a.*, so a blob on that row would be re-encoded as a JSON array of
 *   byte values into every card. That is the bug src/user-fields.js exists to
 *   fix, and nothing about the feature working would reveal it.
 *
 *   a file is what its bytes say — a .exe renamed to .png and announced as
 *   image/png is refused, because the header is whatever the client typed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const thumbnail = require('../src/asset-thumbnail');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('thumb');

/* Real files, small enough to be literals. A PNG header and a JPEG header are
   all the sniffing looks at, and building them here means the tests do not
   depend on a fixture file somebody could delete. */
const PNG = Buffer.concat([
  Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(256, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 3)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(256),
]);
const NOT_AN_IMAGE = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(256)]);

test('a file is judged by its bytes, not by what it claims', () => {
  assert.strictEqual(thumbnail.validate({ buffer: PNG, mime: 'image/png' }).mime, 'image/png');
  assert.strictEqual(thumbnail.validate({ buffer: JPEG, mime: 'image/jpeg' }).mime, 'image/jpeg');

  // An executable renamed and announced as an image.
  const lying = thumbnail.validate({ buffer: NOT_AN_IMAGE, mime: 'image/png' });
  assert.strictEqual(lying.ok, false);
  assert.match(lying.error, /not a JPG or PNG image/);

  /* A real image, but not one of the two this feature takes. It passes the
     declared-type check by lying about itself, so only the sniff can catch it —
     which is why the stored type has to be one this module allows rather than
     merely something avatar.sniff recognised. */
  const webp = thumbnail.validate({ buffer: WEBP, mime: 'image/png' });
  assert.strictEqual(webp.ok, false, 'a WebP calling itself a PNG is still refused');

  const gif = thumbnail.validate({ buffer: PNG, mime: 'image/gif' });
  assert.strictEqual(gif.ok, false);
  assert.match(gif.error, /image\/gif files are not supported/);
});

test('the size and the empty cases are refused with the numbers in them', () => {
  const big = thumbnail.validate({ buffer: Buffer.alloc(thumbnail.MAX_THUMBNAIL_BYTES + 1), mime: 'image/png' });
  assert.strictEqual(big.ok, false);
  assert.match(big.error, /the limit is 5MB/, 'and says what the limit is');
  assert.strictEqual(thumbnail.validate({ buffer: Buffer.alloc(0), mime: 'image/png' }).ok, false);
  assert.strictEqual(thumbnail.validate({ buffer: PNG, mime: '' }).ok, false);
});

test('the bytes cannot reach the board query', () => {
  /* The check that matters most and that no amount of using the feature would
     surface. The board reads `SELECT a.*`; the image lives in its own table so
     that star cannot reach it, and only the timestamp is joined. */
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  const select = /const ASSET_SELECT = `([\s\S]*?)`;/.exec(routes);
  assert.ok(select, 'ASSET_SELECT should be findable');
  assert.match(select[1], /t\.updated_at AS thumbnail_at/, 'the stamp is joined');
  assert.ok(!/t\.image|asset_thumbnails\.image/.test(select[1]),
    'and the image is not — a blob here would ship with every card on every board');

  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const assets = /CREATE TABLE IF NOT EXISTS assets \(([\s\S]*?)\n\) ENGINE/.exec(schema);
  assert.ok(assets, 'the assets table should be findable');
  assert.ok(!/MEDIUMBLOB|LONGBLOB/.test(assets[1]),
    'the assets row must carry no image bytes at all');
});

test('the two places that draw it share one function', () => {
  /* The card and the panel had a scope-of-work icon in a fixed-size slot long
     before this feature. Both now call thumbInner(), so an asset cannot look
     like one thing on its card and another in its panel. */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const card = /<div class="thumb" style="background:[^"]*">\$\{([^}]*)\}<\/div>/.exec(html);
  assert.ok(card, 'the card slot should be findable');
  assert.match(card[1], /thumbInner\(a, 36\)/);

  const panel = /<div class="thumb-big"[^>]*>\$\{([^}]*)\}<\/div>/.exec(html);
  assert.ok(panel, 'the panel slot should be findable');
  assert.match(panel[1], /thumbInner\(a, 64\)/);

  // And the fallback is the icon that was already there, not a new empty state.
  const fn = /function thumbInner\([\s\S]*?\n\}/.exec(html);
  assert.ok(fn, 'thumbInner should be findable');
  assert.match(fn[0], /typeIconSVG/, 'no image means the scope-of-work icon, as before');
});

test('the slots are still the sizes they were', () => {
  /* "Do not alter the existing card layout." The image fills the slot rather
     than being added above it, so these two heights must not have moved. */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /\.card \.thumb\{height:64px/);
  assert.match(html, /\.drawer \.thumb-big\{height:140px/);
  assert.match(html, /\.thumb-img\{width:100%;height:100%;object-fit:cover/,
    'and the image is cropped to the slot rather than stretching it');
});

test('the asset thumbnail', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Thumb-Test-1!';
  let server;
  const token = {};
  const people = {};
  let projectId;
  let asset;
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  // A multipart upload, built by hand — the helper speaks JSON.
  const put = async (who, id, buffer, filename = 'preview.png', type = 'image/png') => {
    const boundary = '----zvkythumb' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n`
      + `Content-Type: ${type}\r\n\r\n`, 'latin1');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
    const res = await fetch(`${server.base}/assets/${id}/thumbnail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token[who]}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, buffer, tail]),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  const board = async (who) => (await as(who, `/assets/project/${projectId}`)).body.assets;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'thumb-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'thumb-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = (await as('root', '/clients')).body.clients[0].id;
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;
    for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist'], ['lee', 'team_lead']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    asset = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'River Spirit', type: 'character', assigneeId: people.ana } })).body.asset;
  });
  t.after(() => stopServer(server));

  await t.test('an asset starts with none, and says so', async () => {
    const [card] = (await board('root')).filter((a) => a.id === asset.id);
    assert.strictEqual(card.thumbnail_at, null, 'nothing set, so the page draws the icon');
    const img = await fetch(`${server.base}/assets/${asset.id}/thumbnail`);
    assert.strictEqual(img.status, 404, 'and the image route says there is none');
  });

  await t.test('the assignee can set one, and it comes back', async () => {
    const up = await put('ana', asset.id, PNG);
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.ok(up.body.asset.thumbnail_at, 'the response carries the new stamp');

    const img = await fetch(`${server.base}/assets/${asset.id}/thumbnail`);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.deepStrictEqual(bytes, PNG, 'byte for byte what was uploaded');
    assert.match(img.headers.get('cache-control') || '', /must-revalidate/,
      'so a removed image cannot linger in a browser for days');
  });

  await t.test('the bytes are nowhere near the board', async () => {
    /* Asserted against the wire, not only against the source: every asset on
       the board, serialised, must be nothing like the size of its image. */
    const assets = await board('root');
    const card = assets.find((a) => a.id === asset.id);
    assert.ok(card.thumbnail_at, 'the card knows there is one');
    for (const key of Object.keys(card)) {
      const value = card[key];
      assert.ok(!Buffer.isBuffer(value), `${key} is a buffer on a board response`);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        assert.ok(!('type' in value && value.type === 'Buffer'),
          `${key} is a serialised buffer on a board response`);
      }
    }
    /* The property, rather than a byte count somebody has to keep tuning: a
       card with an image weighs what a card without one weighs. An absolute
       threshold would drift the moment an unrelated field grew — and would
       have said nothing about whether the image was the reason. */
    const bare = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'No Picture', type: 'prop', assigneeId: people.ana } })).body.asset;
    const both = await board('root');
    const withImage = both.find((a) => a.id === asset.id);
    const without = both.find((a) => a.id === bare.id);
    assert.ok(withImage.thumbnail_at && !without.thumbnail_at, 'one has one, one does not');

    const grew = JSON.stringify(withImage).length - JSON.stringify(without).length;
    assert.ok(Math.abs(grew) < 400,
      `a card carrying an image is ${grew} bytes bigger than one without — the image is riding along`);
    assert.ok(PNG.length > 260, 'and the image is big enough that it would have shown');
  });

  await t.test('replacing it changes the stamp, so the URL changes with it', async () => {
    const before = (await board('root')).find((a) => a.id === asset.id).thumbnail_at;
    await new Promise((r) => setTimeout(r, 1100));
    const up = await put('ana', asset.id, JPEG, 'newer.jpg', 'image/jpeg');
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));

    const after = (await board('root')).find((a) => a.id === asset.id).thumbnail_at;
    assert.notStrictEqual(new Date(after).getTime(), new Date(before).getTime(),
      'a new upload is a new stamp — which is what makes it a new URL and defeats the cache');

    const img = await fetch(`${server.base}/assets/${asset.id}/thumbnail`);
    assert.strictEqual(img.headers.get('content-type'), 'image/jpeg', 'and the new image is served');
    assert.deepStrictEqual(Buffer.from(await img.arrayBuffer()), JPEG);

    // One row per asset, not a pile of old ones.
    const rows = await sql(cfg, `SELECT COUNT(*) AS n FROM asset_thumbnails WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(rows[0].n), 1, 'replaced, not accumulated');
  });

  await t.test('the wrong sort of file is refused, with the reason', async () => {
    const exe = await put('ana', asset.id, NOT_AN_IMAGE, 'virus.png', 'image/png');
    assert.strictEqual(exe.status, 400);
    assert.match(exe.body.error, /not a JPG or PNG image/);

    const gif = await put('ana', asset.id, PNG, 'anim.gif', 'image/gif');
    assert.strictEqual(gif.status, 400);
    assert.match(gif.body.error, /not supported/);

    const big = await put('ana', asset.id, Buffer.concat(
      [PNG, Buffer.alloc(thumbnail.MAX_THUMBNAIL_BYTES)]), 'huge.png', 'image/png');
    assert.strictEqual(big.status, 400, JSON.stringify(big.body));
    assert.match(big.body.error, /5MB/, 'and the limit is in the sentence');

    // None of that replaced what was there.
    const img = await fetch(`${server.base}/assets/${asset.id}/thumbnail`);
    assert.strictEqual(img.headers.get('content-type'), 'image/jpeg', 'the good one still stands');
  });

  await t.test('who may change it, and who may not', async () => {
    /* Wider than editing on purpose, and narrower than everybody. Bo is another
       artist on the same project: they can see the asset and cannot touch its
       preview. */
    const stranger = await put('bo', asset.id, PNG);
    assert.strictEqual(stranger.status, 403, JSON.stringify(stranger.body));
    assert.match(stranger.body.error, /assigned to, or somebody who can edit/);
    assert.strictEqual((await as('bo', `/assets/${asset.id}/thumbnail`,
      { method: 'DELETE' })).status, 403, 'and cannot remove one either');

    // The creator can, through the ordinary edit rule.
    assert.strictEqual((await put('root', asset.id, PNG)).status, 200, 'the creator can');
    // And the assignee can, which the edit rule alone would not have allowed.
    assert.strictEqual((await put('ana', asset.id, PNG)).status, 200, 'the assignee can');
  });

  await t.test('every change is on the record', async () => {
    const log = (await as('root', '/activity?module=assets&limit=50')).body.entries;
    const added = log.filter((e) => e.action === 'asset.thumbnail');
    assert.ok(added.length >= 2, `expected the uploads, found ${added.length}`);
    const mine = added.find((e) => e.actor.name === 'ana');
    assert.ok(mine, 'attributed to whoever uploaded it');
    assert.match(mine.summary, /preview image/);
    assert.ok(mine.changes && mine.changes.thumbnail, 'with what it changed from and to');
    // Replacing says so rather than reading as a first upload.
    assert.ok(added.some((e) => /Replaced/.test(e.summary)), 'a replacement reads as one');
  });

  await t.test('removing it puts the placeholder back', async () => {
    const gone = await as('ana', `/assets/${asset.id}/thumbnail`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.strictEqual(gone.body.asset.thumbnail_at, null, 'the card falls back to the icon');
    assert.strictEqual((await fetch(`${server.base}/assets/${asset.id}/thumbnail`)).status, 404);

    const rows = await sql(cfg, `SELECT COUNT(*) AS n FROM asset_thumbnails WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(rows[0].n), 0, 'and the row is gone, not blanked');

    // Removing what is not there is not an action, so it adds no log entry.
    const before = (await as('root', '/activity?action=asset.thumbnail_removed')).body.total;
    await as('ana', `/assets/${asset.id}/thumbnail`, { method: 'DELETE' });
    assert.strictEqual((await as('root', '/activity?action=asset.thumbnail_removed')).body.total,
      before, 'a second removal records nothing');
  });

  await t.test('deleting the asset takes its image with it', async () => {
    /* Not in the brief. Without the cascade, every deleted asset would leave
       its megabytes behind for ever, and nothing would ever look for them. */
    const spare = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'Temporary', type: 'prop', assigneeId: people.ana } })).body.asset;
    assert.strictEqual((await put('ana', spare.id, PNG)).status, 200);
    assert.strictEqual(Number((await sql(cfg,
      `SELECT COUNT(*) AS n FROM asset_thumbnails WHERE asset_id = '${spare.id}'`))[0].n), 1);

    assert.ok([200, 204].includes((await as('root', `/assets/${spare.id}`, { method: 'DELETE' })).status));
    assert.strictEqual(Number((await sql(cfg,
      `SELECT COUNT(*) AS n FROM asset_thumbnails WHERE asset_id = '${spare.id}'`))[0].n), 0,
    'the image went with the asset');
  });
});
