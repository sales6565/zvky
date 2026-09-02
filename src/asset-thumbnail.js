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

async function save(db, assetId, { buffer, mime }, actor = {}) {
  const check = validate({ buffer, mime });
  if (!check.ok) return check;
  await db.query(
    `INSERT INTO asset_thumbnails (asset_id, image, mime, updated_by, updater_email)
     VALUES ($1,$2,$3,$4,$5)
     ON DUPLICATE KEY UPDATE image = VALUES(image), mime = VALUES(mime),
       updated_by = VALUES(updated_by), updater_email = VALUES(updater_email),
       updated_at = NOW()`,
    [assetId, buffer, check.mime, actor.id || null, actor.email || null]
  );
  return { ok: true, mime: check.mime };
}

async function clear(db, assetId) {
  await db.query('DELETE FROM asset_thumbnails WHERE asset_id = $1', [assetId]);
  return { ok: true };
}

async function read(db, assetId) {
  const { rows } = await db.query(
    'SELECT image, mime FROM asset_thumbnails WHERE asset_id = $1', [assetId]
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row || !row.image || !row.mime) return null;
  return { buffer: row.image, mime: row.mime };
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
  MAX_THUMBNAIL_BYTES, ALLOWED_TYPES, TYPE_LIST,
  validate, save, clear, read, mayChange,
};
