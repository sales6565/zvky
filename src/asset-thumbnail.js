// The preview image on an asset.
//
// The same shape as src/avatar.js, and it borrows that module's format
// checking rather than repeating it: sniff() reads the first bytes, so a .exe
// renamed to .png and announced as image/png is refused whatever the header
// says. One implementation of "is this really an image" is the point — two
// would drift, and the one that drifted would be the one nobody was looking at.
//
// What differs is the cap and the storage. A thumbnail is a piece of artwork
// rather than a face, so it gets more room; and the bytes live in
// asset_thumbnails rather than on the assets row, because the board reads
// assets with SELECT a.* and a blob there would ship with every card.

const avatar = require('./avatar');

/* Five megabytes, as the brief asked, and enforced twice: multer stops the
   upload early so a large file is refused before it is all in memory, and this
   refuses it again for a request that reaches the module another way. */
const MAX_THUMBNAIL_BYTES = Number(process.env.ASSET_THUMBNAIL_MAX_BYTES || 5 * 1024 * 1024);

/* JPG and PNG, as asked. Deliberately narrower than the avatar's three: the
   studio asked for those two, and WebP would be an extra format to explain in
   an error message for no request. No SVG, for the reason avatar.js gives —
   it is a document that can carry script, rendered in <img> on every board. */
const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const TYPE_LIST = 'JPG or PNG';

function validate({ buffer, mime }) {
  if (!buffer || !buffer.length) {
    return { ok: false, status: 400, error: 'That file is empty.' };
  }
  if (buffer.length > MAX_THUMBNAIL_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `That image is ${Math.round(buffer.length / (1024 * 1024) * 10) / 10}MB; `
        + `the limit is ${Math.round(MAX_THUMBNAIL_BYTES / (1024 * 1024))}MB.`,
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
  /* The bytes, not the header. avatar.sniff also recognises WebP, so a WebP
     announcing itself as image/png would pass the check above and be caught
     here — the stored type has to be one this module actually allows. */
  const actual = avatar.sniff(buffer);
  if (!actual || !ALLOWED_TYPES[actual]) {
    return { ok: false, status: 400, error: `That file is not a ${TYPE_LIST} image.` };
  }
  return { ok: true, mime: actual };
}

/* A pasted link, checked for shape.
 *
 * Shape is all the server can check. Confirming the image actually loads would
 * mean fetching it, and the studio chose not to fetch or re-host — so the
 * browser tests that it renders before this is ever called, and the display
 * falls back to the placeholder if it stops rendering later. Two halves of one
 * answer, and neither is sufficient alone.
 *
 * http and https only. A `javascript:` URL does not execute from an <img src>
 * in any current browser, and `data:` is merely enormous rather than dangerous
 * — but neither is a link to somebody's artwork, and an allowlist of two
 * schemes is a smaller thing to be right about than a list of what to refuse.
 */
const MAX_URL_LENGTH = 2048;

function validateUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, status: 400, error: 'Paste a link to the image.' };
  if (text.length > MAX_URL_LENGTH) {
    return { ok: false, status: 400, error: `That link is longer than ${MAX_URL_LENGTH} characters.` };
  }
  let parsed;
  try { parsed = new URL(text); }
  catch { return { ok: false, status: 400, error: 'That is not a web address.' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      status: 400,
      error: `${parsed.protocol.replace(':', '')} links are not supported — paste an http or https address.`,
    };
  }
  if (!parsed.hostname) return { ok: false, status: 400, error: 'That link has no host.' };
  return { ok: true, url: parsed.toString() };
}

/* Saving either kind writes the SAME ROW, which is what makes the two
   alternatives rather than a pair. The columns not in use are set to NULL
   explicitly on every write, so switching from a file to a link drops the
   bytes rather than leaving megabytes behind an asset that no longer shows
   them. */
async function save(db, assetId, { buffer, mime }, actor = {}) {
  const check = validate({ buffer, mime });
  if (!check.ok) return check;
  await db.query(
    `INSERT INTO asset_thumbnails (asset_id, image, mime, source_url, updated_by, updater_email)
     VALUES ($1,$2,$3,NULL,$4,$5)
     ON DUPLICATE KEY UPDATE image = VALUES(image), mime = VALUES(mime),
       source_url = NULL,
       updated_by = VALUES(updated_by), updater_email = VALUES(updater_email),
       updated_at = NOW()`,
    [assetId, buffer, check.mime, actor.id || null, actor.email || null]
  );
  return { ok: true, mime: check.mime, source: 'file' };
}

async function saveUrl(db, assetId, rawUrl, actor = {}) {
  const check = validateUrl(rawUrl);
  if (!check.ok) return check;
  await db.query(
    `INSERT INTO asset_thumbnails (asset_id, image, mime, source_url, updated_by, updater_email)
     VALUES ($1,NULL,NULL,$2,$3,$4)
     ON DUPLICATE KEY UPDATE image = NULL, mime = NULL,
       source_url = VALUES(source_url),
       updated_by = VALUES(updated_by), updater_email = VALUES(updater_email),
       updated_at = NOW()`,
    [assetId, check.url, actor.id || null, actor.email || null]
  );
  return { ok: true, url: check.url, source: 'link' };
}

async function clear(db, assetId) {
  await db.query('DELETE FROM asset_thumbnails WHERE asset_id = $1', [assetId]);
  return { ok: true };
}

/* The bytes, for the route that serves them. Null for a link — there is
   nothing here to serve, because nothing was ever stored. */
async function read(db, assetId) {
  const { rows } = await db.query(
    'SELECT image, mime FROM asset_thumbnails WHERE asset_id = $1', [assetId]
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row || !row.image || !row.mime) return null;
  return { buffer: row.image, mime: row.mime };
}

/* Which of the two an asset currently has, without reading the bytes. Used by
   the routes to describe a change, and by nothing that draws — the page works
   from the board's own fields. */
async function describe(db, assetId) {
  const { rows } = await db.query(
    'SELECT source_url, mime, image IS NOT NULL AS hasFile FROM asset_thumbnails WHERE asset_id = $1',
    [assetId]
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row) return null;
  if (row.source_url) return { source: 'link', url: row.source_url };
  if (Number(row.hasFile)) return { source: 'file', mime: row.mime };
  return null;
}

/* Who may set one.
 *
 * Deliberately WIDER than canEditAsset, and this is the one place the brief's
 * two halves had to be reconciled. It asked for "the Assignee, the creator, and
 * anyone with asset-edit permission", and then for that to reuse the existing
 * edit rule — but the existing rule excludes the assignee on purpose:
 * ownsAsset() is the creator or a full-access role, and src/permissions.js says
 * in as many words that being assigned an asset is not owning it.
 *
 * The enumeration won, because the thumbnail is a picture of the work in
 * progress and the person making that progress is the assignee. Editing an
 * asset's description, priority and checklist stays exactly as restricted as
 * it was; this one action reaches one person further, and nothing else does.
 */
async function mayChange(permissions, user, asset) {
  if (!user || !asset) return false;
  if (asset.assignee_id && asset.assignee_id === user.id) return true;
  return permissions.canEditAsset(user, asset);
}

module.exports = {
  MAX_THUMBNAIL_BYTES, ALLOWED_TYPES, TYPE_LIST, MAX_URL_LENGTH,
  validate, validateUrl, save, saveUrl, clear, read, describe, mayChange,
};
