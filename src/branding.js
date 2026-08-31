// The studio's own name, tagline and logo.
//
// Held in a table rather than in the source, so renaming the application is
// something a Super Admin does in Settings rather than something that needs a
// deploy. Mirrored in memory the same way the reference lists are: read on
// every page load, changed a few times in the life of a deployment.
//
// The logo is stored as bytes in the database rather than as a file on disk.
// That is deliberate on shared hosting: an uploads directory does not survive a
// redeploy on cPanel/Passenger, and a logo that vanishes when the app is
// updated is worse than one extra small row. It is one image, capped well under
// a megabyte.

const DEFAULTS = {
  appName: 'ZVKY FORGE',
  tagline: 'art asset & animation pipeline',
};

// PNG, SVG, JPEG and WebP. No GIF — an animated logo in the header is not a
// thing anybody asked for, and the first frame of one looks like a bug.
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const MAX_LOGO_BYTES = Number(process.env.BRANDING_LOGO_MAX_BYTES || 512 * 1024);

let cache = { ...DEFAULTS, logoType: null, logoUpdatedAt: null };
let loaded = false;

async function load(db) {
  const { rows } = await db.query(
    'SELECT app_name, tagline, logo_mime, logo_updated_at FROM branding WHERE id = 1'
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = {
    appName: (row && row.app_name) || DEFAULTS.appName,
    tagline: row && row.tagline !== null && row.tagline !== undefined ? row.tagline : DEFAULTS.tagline,
    logoType: (row && row.logo_mime) || null,
    logoUpdatedAt: (row && row.logo_updated_at) || null,
  };
  loaded = true;
  return cache;
}

function current() {
  return { ...cache, hasLogo: Boolean(cache.logoType), defaults: { ...DEFAULTS } };
}

function isLoaded() { return loaded; }

/* What a name or tagline may be.
 *
 * A blank name would leave the header with nothing in it, so it falls back to
 * the default rather than being rejected — somebody clearing the field means
 * "put it back", not "show me an empty header". A blank TAGLINE is a real
 * choice, though: it hides the line, so it is kept as an empty string. */
function cleanName(value) {
  const text = String(value ?? '').trim();
  if (!text) return { value: DEFAULTS.appName };
  if (text.length > 60) return { error: `The name is ${text.length} characters; the limit is 60.` };
  return { value: text };
}

function cleanTagline(value) {
  if (value === undefined || value === null) return { value: null };
  const text = String(value).trim();
  if (text.length > 120) return { error: `The tagline is ${text.length} characters; the limit is 120.` };
  return { value: text };
}

async function save(db, { appName, tagline }) {
  const errors = [];
  const name = cleanName(appName);
  if (name.error) errors.push({ field: 'appName', message: name.error });
  const line = cleanTagline(tagline);
  if (line.error) errors.push({ field: 'tagline', message: line.error });
  if (errors.length) return { ok: false, status: 400, errors };

  await db.query(
    `INSERT INTO branding (id, app_name, tagline) VALUES (1, $1, $2)
     ON DUPLICATE KEY UPDATE app_name = VALUES(app_name), tagline = VALUES(tagline)`,
    [name.value, line.value]
  );
  await load(db);
  return { ok: true, branding: current() };
}

async function saveLogo(db, { buffer, mime }) {
  const kind = ALLOWED_TYPES[mime];
  if (!kind) {
    return { ok: false, status: 400, errors: [{ field: 'logo',
      message: `That is a ${mime || 'unknown'} file. Use PNG, SVG, JPEG or WebP.` }] };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, status: 400, errors: [{ field: 'logo', message: 'That file is empty.' }] };
  }
  if (buffer.length > MAX_LOGO_BYTES) {
    return { ok: false, status: 400, errors: [{ field: 'logo',
      message: `That file is ${Math.round(buffer.length / 1024)}KB; the limit is ${Math.round(MAX_LOGO_BYTES / 1024)}KB.` }] };
  }

  await db.query(
    `INSERT INTO branding (id, app_name, tagline, logo, logo_mime, logo_updated_at)
     VALUES (1, $1, $2, $3, $4, NOW())
     ON DUPLICATE KEY UPDATE logo = VALUES(logo), logo_mime = VALUES(logo_mime),
                             logo_updated_at = VALUES(logo_updated_at)`,
    [cache.appName, cache.tagline, buffer, mime]
  );
  await load(db);
  return { ok: true, branding: current() };
}

async function clearLogo(db) {
  await db.query('UPDATE branding SET logo = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = 1');
  await load(db);
  return { ok: true, branding: current() };
}

async function readLogo(db) {
  const { rows } = await db.query('SELECT logo, logo_mime FROM branding WHERE id = 1');
  const row = rows[0];
  if (!row || !row.logo || !row.logo_mime) return null;
  return { buffer: row.logo, mime: row.logo_mime };
}

module.exports = {
  DEFAULTS, ALLOWED_TYPES, MAX_LOGO_BYTES,
  load, current, isLoaded, save, saveLogo, clearLogo, readLogo,
  cleanName, cleanTagline,
};
