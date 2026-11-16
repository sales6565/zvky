/* THE ICON IN THE BROWSER TAB: what may become one, and where it is kept.
 *
 * ===========================================================================
 * WHY IT IS IN THE DATABASE AND NOT IN THE APP FOLDER.
 *
 * The same reason the logo is, and src/branding.js already says it: this
 * application is deployed by uploading a folder to cPanel, and a redeploy
 * replaces that folder. Anything written inside it is gone the next time the
 * studio updates — so an icon uploaded in Settings would vanish on a Tuesday
 * afternoon with nobody able to say why. One small row survives deploys,
 * backups and restores, which is the behaviour an owner expects from something
 * they set in Settings.
 *
 * It is in its own table rather than as four more columns on `branding`
 * because the icon needs things the logo never did — a digest, the dimensions,
 * who changed it — and because a keyed table is where the next one of these
 * goes without another migration.
 *
 * ===========================================================================
 * VALIDATION, WITH NO DECODER IN THE BUILDING.
 *
 * src/image-header.js reads each format's header and refuses to decode
 * anything, for the deploy reasons set out at the top of it. This module is the
 * policy over that: which formats, how big, how square, and what to say when
 * the answer is no.
 *
 * THE BYTES DECIDE WHAT THE FILE IS. Not the extension, which is a name
 * somebody typed, and not the Content-Type, which is whatever the client
 * chose to send. A PNG called holiday.jpg is a PNG and is accepted as one.
 *
 * A DECLARED TYPE THAT DISAGREES IS STILL REFUSED, which is not a contradiction
 * of the paragraph above. The extension is ignored; a Content-Type that names a
 * specific image format and is wrong is a signal in its own right — it means
 * the thing that produced this upload is confused about what it is sending, and
 * accepting it would mean storing bytes under a type nobody agrees on. An
 * absent or generic type (application/octet-stream) is not a disagreement and
 * is accepted on the header alone.
 *
 * Note that this is STRICTER THAN src/avatar.js, on purpose. An avatar with a
 * mismatched type is stored as what it really is, because that is usually a
 * phone naming a HEIC-derived JPEG badly and the cost of being wrong is one
 * person's photo. This icon is served to every visitor from a public route and
 * is the one image in the application a browser will fetch without being asked
 * to, so it is held to the stricter rule.
 *
 * ===========================================================================
 * NO SVG. The logo accepts one and this does not.
 *
 * An SVG is a document: it can carry <script>, external references and
 * foreignObject. The logo is rendered in an <img>, which neuters most of that,
 * and is uploaded by a Super Admin. A favicon is fetched by the browser for
 * every tab, is cached for a long time under a URL that outlives the session,
 * and on some platforms is handed to the OS rather than rendered by the page.
 * The brief rules it out and the reasoning holds; the refusal says why rather
 * than listing allowed formats, because somebody who uploaded an SVG chose it
 * deliberately and deserves to know what the objection is.
 */
const crypto = require('node:crypto');
const imageHeader = require('./image-header');

const KEY = 'favicon';

const MAX_BYTES = Number(process.env.FAVICON_MAX_BYTES || 512 * 1024);

/* THE SIZE RULES, from the brief, with the reasoning kept where the numbers are.
 *
 * 64 minimum: below that the icon is blurred on every display made in the last
 *   decade, and an owner who uploads a 16x16 is usually uploading the wrong file.
 * 1024 maximum: nothing renders a tab icon larger, and the cap bounds what is
 *   served and cached.
 * ROUGHLY SQUARE: a browser does not letterbox a favicon, it squashes it. A
 *   banner uploaded by mistake comes out as an unreadable smear, so a tenth
 *   either way is the tolerance -- enough for a 500x512 export, not enough for
 *   anything that is really a rectangle. */
const MIN_DIM = 64;
const MAX_DIM = 1024;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.1;

/* AN ICO IS JUDGED DIFFERENTLY, because it is a directory of images rather than
   an image. Every entry is square by construction and the format caps at 256,
   so the minimum and the squareness rules have nothing to do; what matters is
   that it carries something big enough to be worth serving. */
const ICO_MIN_DIM = 32;

const ACCEPTED = new Set(['png', 'ico', 'jpeg', 'webp']);

const TYPE_LIST = 'PNG, ICO, JPEG or WebP';

/* What a client's Content-Type means, including the types that are refused: a
   declared type this map does not know is treated as "no opinion" rather than
   as a disagreement, so an unfamiliar-but-honest client is not punished for it.
   image/x-icon is the spelling Windows and older browsers send. */
const DECLARED = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/vnd.microsoft.icon': 'ico',
  'image/x-icon': 'ico',
  'image/ico': 'ico',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/html': 'html',
};

const LABEL = {
  png: 'PNG', ico: 'ICO', jpeg: 'JPEG', webp: 'WebP',
  svg: 'SVG', gif: 'GIF', pdf: 'PDF', html: 'HTML', cur: 'cursor',
};

/* The refusals for formats this module recognises and will not take. Each says
   what the file is and why the answer is no, because "unsupported file type" to
   somebody who just chose a file deliberately is not an answer. */
const REFUSALS = {
  svg: 'That is an SVG. An SVG can contain script and is fetched by the browser for every tab, '
    + 'so it cannot be used as the icon. Export it as a PNG and upload that.',
  gif: `That is a GIF. A moving icon is not supported — use a still ${TYPE_LIST} file.`,
  cur: 'That is a Windows cursor file, not an icon. Save it as an .ico and upload that.',
  pdf: 'That is a PDF, not an image.',
  html: 'That is an HTML page, not an image. Check which file was chosen.',
};

const normaliseDeclared = (mime) => String(mime || '').toLowerCase().split(';')[0].trim();

const kb = (bytes) => Math.max(1, Math.round(bytes / 1024));

const refuse = (message, field = 'favicon') => ({ ok: false, status: 400, message, field });

/* THE VERSION IN THE URL. Twelve hex characters of the digest: enough that two
   icons will not collide in the life of a studio, short enough to read in a
   URL when somebody is working out why a tab is showing yesterday's icon.
   Derived from the bytes, so an icon re-uploaded unchanged keeps its URL and
   every cache keeps its copy. */
const versionOf = (sha256) => String(sha256 || '').slice(0, 12);

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/* ------------------------------------------------------------------ the rules */

/* May these bytes become the icon?
 *
 * Returns { ok: true, mime, type, width, height, sha256, version } — everything
 * the caller needs to store it, so nothing has to be re-derived — or
 * { ok: false, status, message, field } with one sentence a person can act on.
 *
 * Pure: no database, no clock, no request. The route calls it, and so does the
 * validation table in the tests, which is the only way that table can cover
 * thirty cases without starting thirty servers. */
function validate({ buffer, declaredMime } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return refuse('That file is empty.');
  }
  /* SIZE FIRST, before the header is touched. multer has usually stopped an
     oversized upload long before this, but when it has not, refusing on the
     length is cheaper than parsing and gives the clearer message. */
  if (buffer.length > MAX_BYTES) {
    return refuse(`That file is ${kb(buffer.length)}KB; the limit is ${kb(MAX_BYTES)}KB.`);
  }

  const found = imageHeader.read(buffer);

  if (!found.ok) {
    if (found.reason === 'unknown') {
      return refuse(`That file is not an image this application recognises. Use ${TYPE_LIST}.`);
    }
    if (found.reason === 'unsupported') {
      return refuse(REFUSALS[found.type] || `${LABEL[found.type] || found.type} files cannot be used as the icon. Use ${TYPE_LIST}.`);
    }
    /* truncated or corrupt: the format was recognised and the file does not
       hold up. Said as one thing, because "truncated" and "corrupt" are the
       same problem to whoever has to fix it — the file did not arrive whole. */
    return refuse(`That ${LABEL[found.type] || 'image'} file is damaged or incomplete, so it cannot be read.`);
  }

  if (!ACCEPTED.has(found.type)) {
    return refuse(`${LABEL[found.type] || found.type} files cannot be used as the icon. Use ${TYPE_LIST}.`);
  }

  /* THE DECLARED TYPE, if it named a format at all. See the note at the top:
     the extension is never consulted, and an absent or generic type is not a
     disagreement. */
  const declared = DECLARED[normaliseDeclared(declaredMime)] || null;
  if (declared && declared !== found.type) {
    return refuse(`That file says it is ${LABEL[declared]} but its contents are ${LABEL[found.type]}. `
      + 'Upload the file in the format it actually is.');
  }

  if (found.animated) {
    return refuse(`That is an animated ${LABEL[found.type]}. A moving icon is not supported — `
      + 'upload a still image.');
  }

  const { width, height } = found;

  if (found.type === 'ico') {
    /* The largest image in the directory, which is what image-header reports. */
    if (width < ICO_MIN_DIM || height < ICO_MIN_DIM) {
      return refuse(`The largest image in that icon file is ${width}x${height}. `
        + `An .ico needs to contain an image of at least ${ICO_MIN_DIM}x${ICO_MIN_DIM}.`);
    }
  } else {
    if (width < MIN_DIM || height < MIN_DIM) {
      return refuse(`That image is ${width}x${height}; the minimum is ${MIN_DIM}x${MIN_DIM}.`);
    }
    if (width > MAX_DIM || height > MAX_DIM) {
      return refuse(`That image is ${width}x${height}; the maximum is ${MAX_DIM}x${MAX_DIM}.`);
    }
    const ratio = width / height;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
      return refuse(`That image is ${width}x${height}, which is not square. `
        + 'A tab icon is squashed rather than cropped, so use a square image.');
    }
  }

  const sha256 = digest(buffer);
  return {
    ok: true,
    mime: found.mime,
    type: found.type,
    width,
    height,
    sha256,
    version: versionOf(sha256),
    bytes: buffer.length,
  };
}

/* WHAT THE AUDIT ENTRY MAY CALL THE FILE.
 *
 * The brief asks the log to record the file's name and size, and in the same
 * breath that it must never store the original PATH. Both matter: "icon.png" is
 * what makes a log entry answer "which file did they upload", while the path it
 * came from is a detail of somebody's laptop that the studio has no business
 * keeping -- it names people, projects and clients in its directories, and it
 * is the kind of thing that turns an audit log into a thing that leaks.
 *
 * Browsers send a bare filename, so in practice there is no path to strip. In
 * practice is not a rule: some do send one (an old Internet Explorer sent the
 * full Windows path, and a scripted client sends whatever it likes), so the
 * last segment is taken explicitly, after BOTH separators. Control characters
 * go too -- a newline in a log line is how one entry is made to look like two.
 */
function displayName(original) {
  const text = String(original || '').replace(/[\u0000-\u001f\u007f]/g, '');
  const name = text.split(/[/\\]/).pop().trim();
  if (!name) return 'an unnamed file';
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

/* --------------------------------------------------------------- the one row */

/* The metadata, mirrored in memory the way branding and the reference lists
   are: read on every page load by every visitor, written a handful of times in
   the life of a deployment. THE BYTES ARE NOT IN THE MIRROR — they are read
   from the row when the public route serves them, because holding half a
   megabyte per process to save one indexed primary-key lookup is the wrong
   trade on shared hosting. */
let cache = null;
let loaded = false;

const meta = () => (cache ? { ...cache } : null);
const isLoaded = () => loaded;

/* What the public branding payload carries. Shaped as a flat set of fields so
   it merges into the existing { branding: ... } object without the page having
   to learn a nested shape, and so a payload served by an older build simply
   lacks them and the page shows no icon. */
function payload() {
  if (!cache) return { hasFavicon: false, faviconVersion: null, faviconMime: null };
  return {
    hasFavicon: true,
    faviconVersion: cache.version,
    faviconMime: cache.mime,
    faviconWidth: cache.width,
    faviconHeight: cache.height,
    faviconUpdatedAt: cache.updatedAt,
  };
}

async function load(db) {
  /* The bytes are deliberately not selected here. */
  const { rows } = await db.query(
    `SELECT mime, sha256, width, height, byte_size, updated_at
       FROM branding_assets WHERE asset_key = $1`, [KEY]
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = row ? {
    mime: row.mime,
    sha256: row.sha256,
    version: versionOf(row.sha256),
    width: row.width,
    height: row.height,
    bytes: row.byte_size,
    updatedAt: row.updated_at,
  } : null;
  loaded = true;
  return meta();
}

async function save(db, { buffer, mime, sha256, width, height, userId }) {
  await db.query(
    `INSERT INTO branding_assets (asset_key, mime, bytes, sha256, width, height, byte_size, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON DUPLICATE KEY UPDATE mime = VALUES(mime), bytes = VALUES(bytes), sha256 = VALUES(sha256),
                             width = VALUES(width), height = VALUES(height),
                             byte_size = VALUES(byte_size), updated_by = VALUES(updated_by),
                             updated_at = VALUES(updated_at)`,
    [KEY, mime, buffer, sha256, width, height, buffer.length, userId || null]
  );
  await load(db);
  return meta();
}

/* REMOVING IT DELETES THE ROW rather than blanking the columns, so "no icon
   configured" is the absence of a row — the same state a studio that never
   uploaded one is in. There is then only one empty state to serve, and no way
   for a half-cleared row to serve zero bytes with a content type. */
async function clear(db) {
  const { result } = await db.query('DELETE FROM branding_assets WHERE asset_key = $1', [KEY]);
  await load(db);
  return { removed: Boolean(result && result.affectedRows) };
}

/* The bytes, for the public route only. */
async function read(db) {
  const { rows } = await db.query(
    `SELECT mime, bytes, sha256, width, height FROM branding_assets WHERE asset_key = $1`, [KEY]
  );
  const row = rows[0];
  if (!row || !row.bytes || !row.mime) return null;
  return {
    mime: row.mime,
    buffer: row.bytes,
    sha256: row.sha256,
    version: versionOf(row.sha256),
    width: row.width,
    height: row.height,
  };
}

module.exports = {
  KEY, MAX_BYTES, MIN_DIM, MAX_DIM, ICO_MIN_DIM, RATIO_MIN, RATIO_MAX, ACCEPTED, TYPE_LIST, DECLARED,
  validate, versionOf, digest, displayName,
  load, isLoaded, meta, payload, save, clear, read,
};
