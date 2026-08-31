// Profile photos.
//
// Stored as bytes on the user's row, the same way the studio's logo is stored
// on the branding row, and for the same reason: the other upload path in this
// app writes to ./uploads on local disk, and that directory ships EMPTY in the
// deploy zip and is gitignored. Asset submissions can live there because they
// are re-uploaded as work moves; a profile photo that disappeared on every
// redeploy would be a bug somebody reported once a month forever.
//
// They are small on purpose. The browser centre-crops and downscales to a
// square before uploading, so what arrives is tens of kilobytes, not the
// multi-megabyte original off someone's phone. The server does not trust that
// — the cap below is enforced here regardless of what the page did.

const MAX_PHOTO_BYTES = Number(process.env.PROFILE_PHOTO_MAX_BYTES || 3 * 1024 * 1024);

/* JPEG, PNG and WebP, as asked. No SVG, which the studio logo does allow: a
 * logo is uploaded by a Super Admin in Settings, an avatar by anybody with an
 * account. SVG is a document — it can carry script — and these are rendered in
 * <img> on every screen in the app. The risk is not worth a vector avatar. */
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const TYPE_LIST = 'JPG, PNG or WebP';

/* Magic numbers, because a Content-Type header is whatever the client typed.
 * Checking the first bytes means a .exe renamed to .png and announced as
 * image/png is still refused. Only the three formats above are recognised. */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/* One answer to "may this file become an avatar", used by the route and by the
 * tests. Returns the mime to store, so the caller never has to re-derive it
 * from the header it was told. */
function validate({ buffer, mime }) {
  if (!buffer || !buffer.length) {
    return { ok: false, status: 400, error: 'That file is empty.' };
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `That image is ${Math.round(buffer.length / 1024)}KB; the limit is `
        + `${Math.round(MAX_PHOTO_BYTES / 1024)}KB.`,
    };
  }
  const declared = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_TYPES[declared]) {
    return {
      ok: false,
      status: 400,
      error: declared
        ? `${declared} files are not supported. Use ${TYPE_LIST}.`
        : `That file did not say what kind of image it is. Use ${TYPE_LIST}.`,
    };
  }
  const actual = sniff(buffer);
  if (!actual) {
    return { ok: false, status: 400, error: `That file is not a readable image. Use ${TYPE_LIST}.` };
  }
  /* A real image, but not the one it claimed to be. Store what it actually is
     rather than refusing — the browser will render it correctly, and the
     mismatch is usually a phone naming a HEIC-derived JPEG badly. */
  return { ok: true, mime: actual };
}

async function save(db, userId, { buffer, mime }) {
  const check = validate({ buffer, mime });
  if (!check.ok) return check;
  await db.query(
    'UPDATE users SET avatar = $1, avatar_mime = $2, avatar_updated_at = NOW() WHERE id = $3',
    [buffer, check.mime, userId]
  );
  return { ok: true, mime: check.mime };
}

async function clear(db, userId) {
  await db.query(
    'UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_updated_at = NULL WHERE id = $1',
    [userId]
  );
  return { ok: true };
}

async function read(db, userId) {
  const { rows } = await db.query(
    'SELECT avatar, avatar_mime FROM users WHERE id = $1', [userId]
  );
  const row = rows[0];
  if (!row || !row.avatar || !row.avatar_mime) return null;
  return { buffer: row.avatar, mime: row.avatar_mime };
}

module.exports = {
  MAX_PHOTO_BYTES, ALLOWED_TYPES, TYPE_LIST,
  sniff, validate, save, clear, read,
};
