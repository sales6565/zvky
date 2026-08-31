const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const avatar = require('../src/avatar');
const { USER_COLUMNS } = require('../src/user-fields');

const cfg = config('photo');

/* Real files, not Buffer.from('pretend png').
 *
 * The server sniffs magic bytes, so a fixture that only *claims* to be a PNG
 * would be refused for the right reason by accident, and a test that passes by
 * accident is not a test. These are actual, decodable images. */
function png(width = 8, height = 8) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 200; raw[o + 1] = 40; raw[o + 2] = 60;
    }
  }
  const table = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7), Buffer.from([0xFF, 0xD9])]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 3)]);

// --- what may become an avatar -------------------------------------------------

test('the image is judged by its bytes, not by what it claims to be', () => {
  // The three formats, correctly announced.
  assert.strictEqual(avatar.validate({ buffer: png(), mime: 'image/png' }).mime, 'image/png');
  assert.strictEqual(avatar.validate({ buffer: jpeg(), mime: 'image/jpeg' }).mime, 'image/jpeg');
  assert.strictEqual(avatar.validate({ buffer: webp(), mime: 'image/webp' }).mime, 'image/webp');

  // A text file wearing a .png Content-Type. The header is the client's word;
  // the first bytes are not, and this is the check that matters.
  const lie = avatar.validate({ buffer: Buffer.from('MZ\x90\x00 this is an executable'), mime: 'image/png' });
  assert.ok(!lie.ok, 'a non-image announced as a PNG must be refused');
  assert.match(lie.error, /not a readable image/);

  // A real image in a format that is not offered.
  const gif = avatar.validate({ buffer: png(), mime: 'image/gif' });
  assert.ok(!gif.ok);
  assert.match(gif.error, /JPG, PNG or WebP/);

  // SVG is deliberately absent, unlike the studio logo: it can carry script and
  // these render in <img> on every screen.
  assert.ok(!avatar.validate({ buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' }).ok);

  assert.ok(!avatar.validate({ buffer: Buffer.alloc(0), mime: 'image/png' }).ok, 'empty');
  const big = avatar.validate({ buffer: Buffer.concat([png(), Buffer.alloc(avatar.MAX_PHOTO_BYTES)]), mime: 'image/png' });
  assert.ok(!big.ok);
  assert.match(big.error, /limit/);
});

test('a real image mislabelled by the browser is stored as what it is', () => {
  // Phones do this: a JPEG derived from a HEIC, announced as image/png. It is a
  // genuine image in an allowed format, so it is kept — under its true type, or
  // the browser would be told to decode it wrongly.
  const out = avatar.validate({ buffer: jpeg(), mime: 'image/png' });
  assert.ok(out.ok);
  assert.strictEqual(out.mime, 'image/jpeg');
});

// --- the blob must not ride along in ordinary payloads -------------------------

test('the photo bytes are never in a user payload by default', () => {
  /* This is the regression that matters most. `users` now holds a MEDIUMBLOB,
     and three queries in this codebase used to say SELECT * — including the one
     behind sign-in, whose row goes straight to the browser. That would have
     turned every login response into the photo re-encoded as a JSON array. */
  const listed = USER_COLUMNS.join(' ');
  assert.ok(!/\bavatar\b(?!_)/.test(listed), `USER_COLUMNS must not select the blob: ${listed}`);
  assert.ok(listed.includes('avatar_updated_at'), 'but it should carry the timestamp');
  assert.ok(!listed.includes('avatar_mime'), 'the mime is only needed by the route that serves bytes');
});

// --- against a live server -----------------------------------------------------

test('profile photos', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Photo-Test-1!';
  let server;
  const token = {};
  const id = {};

  const as = (who, path, options = {}) => api(server.base, path, { ...options, token: token[who] });

  // multipart by hand: the helper only speaks JSON, and this is one field.
  async function upload(who, target, { buffer, type = 'image/png', field = 'photo', filename = 'p.png' }) {
    const form = new FormData();
    form.append(field, new Blob([buffer], { type }), filename);
    const res = await fetch(`${server.base}/users/${target}/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token[who]}` },
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'photo-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'photo-token', name: 'Root', email: 'root@photo.test', password: PASSWORD },
    });
    const sign = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;

    // A super admin, an editor who holds user.edit, and two plain contributors.
    token.root = await sign('root@photo.test');
    id.root = (await as('root', '/auth/me')).body.user.id;

    const make = async (name, email, role) => {
      const res = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(res.status, 201, `could not create ${email}: ${JSON.stringify(res.body)}`);
      return res.body.user.id;
    };
    id.editor = await make('Edna Editor', 'edna@photo.test', 'admin');
    id.artist = await make('Artie Artist', 'artie@photo.test', 'game_artist');
    id.other = await make('Olly Other', 'olly@photo.test', 'game_artist');
    token.editor = await sign('edna@photo.test');
    token.artist = await sign('artie@photo.test');

    // The editor must actually hold user.edit for the test below to mean what
    // it says; assert it rather than assuming the role's defaults.
    assert.ok((await as('editor', '/auth/me')).body.user.permissions.includes('user.edit'),
      'the "admin" role should hold User Edit — this test is about that permission');
  });

  t.after(async () => { await stopServer(server); });

  await t.test('a fresh account has no photo, and says so plainly', async () => {
    const me = await as('artist', '/auth/me');
    assert.strictEqual(me.body.user.photoUpdatedAt, null);
    // 404 rather than an empty 200: the page draws initials on a 404, and an
    // empty 200 would be an image the browser could not decode.
    const res = await fetch(`${server.base}/users/${id.artist}/photo`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('anyone may set their own', async () => {
    const bytes = png(16, 16);
    const up = await upload('artist', 'me', { buffer: bytes });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.hasPhoto, true);

    const me = await as('artist', '/auth/me');
    assert.ok(me.body.user.photoUpdatedAt, 'the timestamp comes back so the page can bust its cache');

    const res = await fetch(`${server.base}/users/${id.artist}/photo`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), bytes, 'the bytes come back unchanged');
  });

  await t.test('the login response carries the timestamp and not the image', async () => {
    const res = await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'artie@photo.test', password: PASSWORD } });
    const user = res.body.user;
    assert.ok(user.photoUpdatedAt, 'the page needs to know a photo exists');
    assert.strictEqual(user.avatar, undefined, 'and must not be sent the bytes');
    assert.strictEqual(user.password_hash, undefined);
    // A 16x16 PNG is small, but the shape of the bug is what matters: no
    // property of the response may be an encoded buffer.
    const encoded = JSON.stringify(res.body);
    assert.ok(encoded.length < 4000, `the login payload should stay small, was ${encoded.length} bytes`);
  });

  await t.test('the server refuses what the browser should have', async () => {
    const bad = await upload('artist', 'me', { buffer: Buffer.from('not an image at all'), type: 'image/png' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /not a readable image/);

    const wrongType = await upload('artist', 'me', { buffer: png(), type: 'image/gif' });
    assert.strictEqual(wrongType.status, 400);
    assert.match(wrongType.body.error, /JPG, PNG or WebP/);

    const oversize = await upload('artist', 'me', {
      buffer: Buffer.concat([png(), Buffer.alloc(avatar.MAX_PHOTO_BYTES + 1024)]), type: 'image/png',
    });
    assert.strictEqual(oversize.status, 400);
    assert.match(oversize.body.error, /limit/i, 'and the message should name the limit');

    const missing = await upload('artist', 'me', { buffer: png(), field: 'wrongfield' });
    assert.strictEqual(missing.status, 400);

    // None of that disturbed the photo that was already there.
    assert.strictEqual((await fetch(`${server.base}/users/${id.artist}/photo`)).status, 200);
  });

  await t.test('a contributor cannot touch anybody else', async () => {
    const post = await upload('artist', id.other, { buffer: png() });
    assert.strictEqual(post.status, 403);
    assert.match(post.body.error, /your own/i);

    const del = await as('artist', `/users/${id.other}/photo`, { method: 'DELETE' });
    assert.strictEqual(del.status, 403);

    // And the refusal is real, not just a message.
    assert.strictEqual((await fetch(`${server.base}/users/${id.other}/photo`)).status, 404);
  });

  await t.test('holding User Edit is what allows setting somebody else\'s', async () => {
    /* Deliberately the same gate as changing their name, email and role, rather
       than a new permission: whoever may change what an account IS may change
       its picture. */
    const up = await upload('editor', id.other, { buffer: png(12, 12) });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual((await fetch(`${server.base}/users/${id.other}/photo`)).status, 200);
  });

  await t.test('but not on an account above them', async () => {
    /* mayAdministerUser: an account with full studio access can only be
       administered by another one. The editor holds user.edit and still cannot
       reach the super admin — the same answer the rest of /api/users gives. */
    const up = await upload('editor', id.root, { buffer: png() });
    assert.strictEqual(up.status, 403);
    assert.match(up.body.error, /full-access/i);
  });

  await t.test('a super admin may set anyone\'s', async () => {
    const up = await upload('root', id.artist, { buffer: jpeg(), type: 'image/jpeg', filename: 'p.jpg' });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    const res = await fetch(`${server.base}/users/${id.artist}/photo`);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg', 'replacing also replaces the type');
  });

  await t.test('removing one goes back to no photo at all', async () => {
    const del = await as('artist', '/users/me/photo', { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.body.hasPhoto, false);
    assert.strictEqual(del.body.photoUpdatedAt, null);

    assert.strictEqual((await fetch(`${server.base}/users/${id.artist}/photo`)).status, 404,
      'the image is gone, so the page falls back to initials');
    assert.strictEqual((await as('artist', '/auth/me')).body.user.photoUpdatedAt, null);

    // The row survives; only the picture went.
    const rows = await sql(cfg,
      `SELECT \`name\`, avatar, avatar_mime FROM users WHERE id = '${id.artist}'`);
    assert.strictEqual(rows[0].name, 'Artie Artist');
    assert.strictEqual(rows[0].avatar, null);
    assert.strictEqual(rows[0].avatar_mime, null);
  });

  await t.test('the lists the app draws people from carry the timestamp', async () => {
    await upload('root', 'me', { buffer: png() });
    const list = await as('root', '/users?limit=50');
    const rootRow = list.body.users.find((u) => u.id === id.root);
    assert.ok(rootRow.photoUpdatedAt, 'the Users tab needs it to draw a face');
    const artistRow = list.body.users.find((u) => u.id === id.artist);
    assert.strictEqual(artistRow.photoUpdatedAt, null, 'and null where there is none, for the initials');
    assert.strictEqual(rootRow.avatar, undefined, 'never the bytes');
  });
});
