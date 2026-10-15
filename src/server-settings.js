/* SETTINGS -> SERVER. Everything the office file gateway is told, and the two
 * secrets it is told it with.
 *
 * ===========================================================================
 * WHY THE SWITCH SHIPS OFF. Same reason leave_settings.enabled does, and more
 * sharply: until a Super Admin has generated a key pair, generated a secret,
 * installed the gateway on an office machine and seen a heartbeat arrive, the
 * tab can do nothing but fail. A Server tab that lists nothing and errors on
 * every click is worse than no tab, so it is hidden until it can work and the
 * setup checklist in Settings says exactly what is still missing.
 *
 * OFF does not void what already happened: existing deletion requests stay
 * viewable and resolvable, because a request is a message to IT about a file
 * and switching a feature off is not an answer to it.
 *
 * ===========================================================================
 * THE TWO SECRETS, AND WHY THEY ARE TWO.
 *
 *   the SIGNING KEY (Ed25519) proves a token came from Forge. Forge holds the
 *     private half; the gateway holds public halves only, so the office machine
 *     can check a permission and can never mint one.
 *
 *   the GATEWAY SECRET (HMAC) proves a heartbeat, a config fetch or a callback
 *     came from the gateway. Symmetric, because both ends need it to verify.
 *
 * One key would have meant the gateway holding something that could mint
 * tokens. That is the whole reason there are two, and they rotate separately.
 *
 * Both are stored through src/email-secret.js — AES-256-GCM, random IV, keyed
 * from EMAIL_ENCRYPTION_KEY (falling back to JWT_SECRET) with the key's
 * fingerprint recorded beside the ciphertext. Nothing new was invented for
 * this: that module exists, has been in production for the mail password, and
 * already answers "the key was rotated, enter it again" with a sentence instead
 * of a silence. Without a key in the environment, the secret features refuse
 * with that sentence rather than storing anything in the clear.
 *
 * NEITHER IS EVER RETURNED. summarise() is what the page gets, and it carries
 * fingerprints and public keys. The generated secret is shown exactly once, at
 * the moment it is created, the way src/routes/integration-admin.js shows an
 * integration key — because it has to be pasted into the gateway's
 * GATEWAY_SECRET and there is nowhere else it can come from.
 */
const crypto = require('node:crypto');
const emailSecret = require('./email-secret');
const serverTokens = require('./server-tokens');

const GB = 1024 * 1024 * 1024;

const DEFAULTS = {
  enabled: false,
  gatewayUrl: null,
  gatewayId: null,
  maxFileBytes: 50 * GB,
  chunkBytes: 32 * 1024 * 1024,
  parallelChunks: 3,
  /* Executables and scripts, denied by default. The list is the one thing here
     that is a security rule rather than a studio preference, so it ships
     populated and a studio has to take something off it deliberately. */
  deniedExtensions: ['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1',
    '.vbs', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.dll', '.lnk',
    '.reg', '.jar', '.app', '.sh'],
  allowedExtensions: [],
  sharedFolders: [],
  incomingMaxAgeMinutes: 24 * 60,
  rotationOverlapMinutes: 60,
  emailOnDeleteRequests: true,
  serveLegacy: true,
  configVersion: 0,
};

let cache = null;

const bool = (v, fallback) => (v === undefined || v === null ? fallback : Boolean(Number(v)));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const listOf = (v) => String(v === undefined || v === null ? '' : v)
  .split(',').map((s) => s.trim()).filter(Boolean);
const extList = (v) => listOf(v).map((s) => {
  const t = s.toLowerCase();
  return t.startsWith('.') ? t : `.${t}`;
});

async function load(db) {
  const { rows } = await db.query(
    `SELECT s.*, u.\`name\` AS updated_by_name
       FROM server_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = row ? {
    enabled: bool(row.enabled, DEFAULTS.enabled),
    gatewayUrl: row.gateway_url || null,
    gatewayId: row.gateway_id || null,
    signingPrivate: row.signing_private || null,
    signingPublic: row.signing_public || null,
    signingKid: row.signing_kid || null,
    signingKeyFp: row.signing_key_fp || null,
    signingMadeAt: row.signing_made_at || null,
    prevPublic: row.prev_public || null,
    prevKid: row.prev_kid || null,
    prevUntil: row.prev_until || null,
    gatewaySecret: row.gateway_secret || null,
    gatewaySecretFp: row.gateway_secret_fp || null,
    gatewaySecretAt: row.gateway_secret_at || null,
    gatewaySecretPrev: row.gateway_secret_prev || null,
    gatewaySecretPrevUntil: row.gateway_secret_prev_until || null,
    rotationOverlapMinutes: num(row.rotation_overlap_minutes, DEFAULTS.rotationOverlapMinutes),
    maxFileBytes: num(row.max_file_bytes, DEFAULTS.maxFileBytes),
    chunkBytes: num(row.chunk_bytes, DEFAULTS.chunkBytes),
    parallelChunks: num(row.parallel_chunks, DEFAULTS.parallelChunks),
    deniedExtensions: row.denied_extensions === null || row.denied_extensions === undefined
      ? DEFAULTS.deniedExtensions : extList(row.denied_extensions),
    allowedExtensions: extList(row.allowed_extensions),
    sharedFolders: listOf(row.shared_folders),
    incomingMaxAgeMinutes: num(row.incoming_max_age_minutes, DEFAULTS.incomingMaxAgeMinutes),
    emailOnDeleteRequests: bool(row.email_on_delete_requests, DEFAULTS.emailOnDeleteRequests),
    serveLegacy: bool(row.serve_legacy, DEFAULTS.serveLegacy),
    configVersion: Number(row.config_version || 0),
    updatedBy: row.updated_by || null,
    updatedByName: row.updated_by_name || null,
    updatedAt: row.updated_at || null,
  } : { ...DEFAULTS };
  return cache;
}

const isLoaded = () => cache !== null;
const current = () => (cache === null ? { ...DEFAULTS } : cache);

/* THE ONE QUESTION THE REST OF THE APP ASKS.
 *
 * Read wherever the tab is drawn or an endpoint is entered, and nowhere else —
 * exactly as leaveIdleEnabled() is. Everything that follows from "the feature
 * is on" (a token, a listing, an upload) goes through it, so turning the switch
 * off takes effect on the next request with no restart. */
const serverEnabled = () => Boolean(current().enabled);

/* Configured enough to work? The checklist on the Settings page is this
   function's answer, item by item, so the page and the server cannot disagree
   about whether setup is finished. */
function readiness(state = {}) {
  const c = current();
  const lastSeen = state.lastSeen ? new Date(state.lastSeen).getTime() : null;
  const freshFor = Number(state.staleAfterSeconds || 120) * 1000;
  return {
    keyGenerated: Boolean(c.signingPublic && c.signingKid),
    secretGenerated: Boolean(c.gatewaySecret),
    gatewayUrl: Boolean(c.gatewayUrl),
    gatewayId: Boolean(c.gatewayId),
    heartbeatReceived: Boolean(lastSeen),
    heartbeatFresh: Boolean(lastSeen && Date.now() - lastSeen < freshFor),
    configApplied: Boolean(state.configVersion !== null && state.configVersion !== undefined
      && Number(state.configVersion) === Number(c.configVersion)),
    encryptionAvailable: emailSecret.available(),
  };
}

/* ---- the secrets, in and out --------------------------------------------- */

const fingerprint = (value) => crypto.createHash('sha256').update(`gw:${value}`).digest('hex').slice(0, 16);

function withinOverlap(until) {
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

/* The public keys a gateway should verify with: the current one, plus the
   previous one while its overlap lasts. This is the list the config endpoint
   publishes, and it is the only place the overlap window is interpreted. */
function publicKeys() {
  const c = current();
  const out = [];
  if (c.signingPublic) out.push({ kid: c.signingKid, publicKey: c.signingPublic });
  if (c.prevPublic && withinOverlap(c.prevUntil)) out.push({ kid: c.prevKid, publicKey: c.prevPublic });
  return out;
}

/* The private key, for minting. Returns a reason rather than throwing, because
   every caller wants to answer the request with a sentence. */
function signingKey() {
  const c = current();
  if (!c.signingPrivate) {
    return { ok: false, reason: 'No token signing key has been generated yet. Settings → Server → Generate key pair.' };
  }
  const out = emailSecret.decrypt(c.signingPrivate, c.signingKeyFp);
  if (!out.ok) {
    return { ok: false, reason: out.error || 'The token signing key could not be read. Generate a new key pair in Settings → Server.' };
  }
  return { ok: true, privateKey: out.value, kid: c.signingKid };
}

/* The gateway secrets this server will accept a signature from: the current
   one, and the previous one while its overlap lasts. Both are needed at once
   precisely so a regeneration does not have to be simultaneous on two machines. */
function gatewaySecrets() {
  const c = current();
  const out = [];
  const add = (stored, fp) => {
    if (!stored) return;
    const d = emailSecret.decrypt(stored, fp);
    if (d.ok) out.push(d.value);
  };
  add(c.gatewaySecret, c.gatewaySecretFp);
  if (c.gatewaySecretPrev && withinOverlap(c.gatewaySecretPrevUntil)) add(c.gatewaySecretPrev, c.gatewaySecretFp);
  return out;
}

async function generateKeyPair(db, actor) {
  if (!emailSecret.available()) {
    return { ok: false, status: 409, error: 'This server has no key to encrypt the signing key with. '
      + 'Set EMAIL_ENCRYPTION_KEY (or JWT_SECRET) in the environment and restart.' };
  }
  const c = current();
  const made = serverTokens.generate();
  const sealed = emailSecret.encrypt(made.privateKey);
  if (!sealed.ok) return { ok: false, status: 409, error: sealed.error };
  const overlapUntil = c.signingPublic
    ? new Date(Date.now() + c.rotationOverlapMinutes * 60 * 1000)
    : null;
  await db.query(
    `UPDATE server_settings SET
       signing_private = $1, signing_public = $2, signing_kid = $3, signing_key_fp = $4,
       signing_made_at = NOW(),
       prev_public = $5, prev_kid = $6, prev_until = $7,
       config_version = config_version + 1, updated_by = $8
     WHERE id = 1`,
    [sealed.value, made.publicKey, made.kid, sealed.keyId,
      c.signingPublic || null, c.signingKid || null, overlapUntil,
      (actor && actor.id) || null]
  );
  await load(db);
  return {
    ok: true,
    rotated: Boolean(c.signingPublic),
    kid: made.kid,
    publicKey: made.publicKey,
    previousKid: c.signingKid || null,
    previousUntil: overlapUntil ? overlapUntil.toISOString() : null,
  };
}

async function generateSecret(db, actor) {
  if (!emailSecret.available()) {
    return { ok: false, status: 409, error: 'This server has no key to encrypt the gateway secret with. '
      + 'Set EMAIL_ENCRYPTION_KEY (or JWT_SECRET) in the environment and restart.' };
  }
  const c = current();
  /* 64 characters of letters and digits, which is what
     src/integration-secrets.js recommends and warns about when it is not —
     generated here rather than typed, so the warning never fires. */
  let secret = '';
  while (secret.length < 64) {
    secret += crypto.randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  }
  secret = secret.slice(0, 64);
  const sealed = emailSecret.encrypt(secret);
  if (!sealed.ok) return { ok: false, status: 409, error: sealed.error };
  const overlapUntil = c.gatewaySecret ? new Date(Date.now() + c.rotationOverlapMinutes * 60 * 1000) : null;
  await db.query(
    `UPDATE server_settings SET
       gateway_secret = $1, gateway_secret_fp = $2, gateway_secret_at = NOW(),
       gateway_secret_prev = $3, gateway_secret_prev_until = $4,
       config_version = config_version + 1, updated_by = $5
     WHERE id = 1`,
    [sealed.value, sealed.keyId, c.gatewaySecret || null, overlapUntil, (actor && actor.id) || null]
  );
  await load(db);
  return {
    ok: true,
    regenerated: Boolean(c.gatewaySecret),
    // ONCE. The caller returns this and the page says so; it is never readable again.
    secret,
    fingerprint: fingerprint(secret),
    previousUntil: overlapUntil ? overlapUntil.toISOString() : null,
  };
}

/* ---- the rest of the settings -------------------------------------------- */

const MIN_CHUNK = 1024 * 1024;
const MAX_CHUNK = 256 * 1024 * 1024;
const MAX_FILE_CEILING = 2 * 1024 * GB;      // 2 TB: past this, chunk bookkeeping is the problem

function validate(patch = {}, { settings = current() } = {}) {
  const errors = [];
  const out = {};

  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);

  if (patch.gatewayUrl !== undefined) {
    const raw = String(patch.gatewayUrl || '').trim();
    if (!raw) out.gatewayUrl = null;
    else {
      let url = null;
      try { url = new URL(raw); } catch { url = null; }
      if (!url) errors.push('The gateway address must be a full URL, like https://files.office.example.');
      else if (url.protocol !== 'https:') {
        /* http would be mixed content on a page served over https, which no
           browser will load — and it would put a studio's files on the office
           wifi in the clear. The README explains the DNS-01 certificate. */
        errors.push('The gateway address must be https. See gateway/README.md for the certificate setup.');
      } else out.gatewayUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}` || url.origin;
    }
  }

  if (patch.gatewayId !== undefined) {
    const raw = String(patch.gatewayId || '').trim();
    if (raw && !/^[A-Za-z0-9._-]{3,64}$/.test(raw)) {
      errors.push('The gateway id may use letters, digits, dots, dashes and underscores, 3 to 64 characters.');
    } else out.gatewayId = raw || null;
  }

  if (patch.maxFileBytes !== undefined) {
    const n = Number(patch.maxFileBytes);
    if (!Number.isFinite(n) || n < MIN_CHUNK) errors.push('The maximum file size must be at least 1 MB.');
    else if (n > MAX_FILE_CEILING) errors.push('The maximum file size cannot be more than 2 TB.');
    else out.maxFileBytes = Math.floor(n);
  }
  if (patch.chunkBytes !== undefined) {
    const n = Number(patch.chunkBytes);
    if (!Number.isFinite(n) || n < MIN_CHUNK || n > MAX_CHUNK) {
      errors.push(`The chunk size must be between ${MIN_CHUNK / (1024 * 1024)} MB and ${MAX_CHUNK / (1024 * 1024)} MB.`);
    } else out.chunkBytes = Math.floor(n);
  }
  if (patch.parallelChunks !== undefined) {
    const n = Number(patch.parallelChunks);
    if (!Number.isInteger(n) || n < 1 || n > 8) errors.push('Parallel chunks must be between 1 and 8.');
    else out.parallelChunks = n;
  }
  if (patch.incomingMaxAgeMinutes !== undefined) {
    const n = Number(patch.incomingMaxAgeMinutes);
    if (!Number.isFinite(n) || n < 60) errors.push('Abandoned uploads must be kept for at least an hour.');
    else out.incomingMaxAgeMinutes = Math.floor(n);
  }
  if (patch.rotationOverlapMinutes !== undefined) {
    const n = Number(patch.rotationOverlapMinutes);
    if (!Number.isFinite(n) || n < 5 || n > 7 * 24 * 60) errors.push('The rotation overlap must be between 5 minutes and 7 days.');
    else out.rotationOverlapMinutes = Math.floor(n);
  }
  for (const [field, key] of [['deniedExtensions', 'denied'], ['allowedExtensions', 'allowed']]) {
    if (patch[field] === undefined) continue;
    const list = Array.isArray(patch[field]) ? patch[field].map((s) => String(s)) : listOf(patch[field]);
    const cleaned = [...new Set(list.map((s) => {
      const t = s.trim().toLowerCase();
      return t.startsWith('.') ? t : `.${t}`;
    }).filter((s) => s !== '.'))];
    if (cleaned.some((s) => !/^\.[a-z0-9][a-z0-9+_-]{0,15}$/.test(s))) {
      errors.push(`Each ${key} extension should look like ".psd".`);
    } else out[field] = cleaned;
  }
  if (patch.sharedFolders !== undefined) {
    const list = Array.isArray(patch.sharedFolders) ? patch.sharedFolders.map((s) => String(s)) : listOf(patch.sharedFolders);
    const cleaned = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
    const bad = cleaned.find((s) => /[\\/]/.test(s) || s === '.' || s === '..');
    if (bad) errors.push(`"${bad}" is not a folder name — shared folders are single names at the top of the share.`);
    else out.sharedFolders = cleaned;
  }
  if (patch.emailOnDeleteRequests !== undefined) out.emailOnDeleteRequests = Boolean(patch.emailOnDeleteRequests);
  if (patch.serveLegacy !== undefined) out.serveLegacy = Boolean(patch.serveLegacy);

  /* Turning the switch ON is the one change with a precondition, and it is
     checked here rather than left to fail later: a tab that is on without a
     key, a secret or an address can only show errors. */
  const after = { ...settings, ...out };
  if (out.enabled === true) {
    if (!after.gatewayUrl) errors.push('Set the gateway address before turning the Server tab on.');
    if (!after.gatewayId) errors.push('Set the gateway id before turning the Server tab on.');
    if (!after.signingPublic) errors.push('Generate a token signing key before turning the Server tab on.');
    if (!after.gatewaySecret) errors.push('Generate a gateway secret before turning the Server tab on.');
  }
  return { ok: errors.length === 0, errors, value: out };
}

const COLUMNS = {
  enabled: 'enabled',
  gatewayUrl: 'gateway_url',
  gatewayId: 'gateway_id',
  maxFileBytes: 'max_file_bytes',
  chunkBytes: 'chunk_bytes',
  parallelChunks: 'parallel_chunks',
  deniedExtensions: 'denied_extensions',
  allowedExtensions: 'allowed_extensions',
  sharedFolders: 'shared_folders',
  incomingMaxAgeMinutes: 'incoming_max_age_minutes',
  rotationOverlapMinutes: 'rotation_overlap_minutes',
  emailOnDeleteRequests: 'email_on_delete_requests',
  serveLegacy: 'serve_legacy',
};

async function save(db, patch, actor) {
  const before = { ...current() };
  const checked = validate(patch, { settings: before });
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors };
  const sets = [];
  const params = [];
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (checked.value[field] === undefined) continue;
    const v = checked.value[field];
    params.push(Array.isArray(v) ? v.join(',') : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    sets.push(`${column} = $${params.length}`);
  }
  /* A save with no field in it still RE-READS the row. It costs one query and it
     makes the mirror self-healing: anything that changed the row by another
     route — a migration, a repair, a test ageing a rotation window — is picked
     up rather than being invisible until the next restart. */
  if (!sets.length) return { ok: true, settings: await load(db), before, changed: false };
  params.push((actor && actor.id) || null);
  /* config_version is bumped on every save, which is what lets the gateway —
     and the status panel — tell "the gateway has my settings" from "the gateway
     is still running last week's". */
  await db.query(
    `UPDATE server_settings SET ${sets.join(', ')}, config_version = config_version + 1, updated_by = $${params.length} WHERE id = 1`,
    params
  );
  const after = await load(db);
  return { ok: true, settings: after, before, changed: true };
}

/* ---- what the page and the gateway are each allowed to see ---------------- */

/* The gateway's configuration. Limits, rules, folder names, public keys. No
   private key, no secret, no user, no path — a gateway that is compromised
   learns the studio's chunk size. */
function gatewayConfig() {
  const c = current();
  return {
    version: c.configVersion,
    maxFileBytes: c.maxFileBytes,
    chunkBytes: c.chunkBytes,
    parallelChunks: c.parallelChunks,
    deniedExtensions: c.deniedExtensions,
    allowedExtensions: c.allowedExtensions,
    sharedFolders: c.sharedFolders,
    incomingMaxAgeMinutes: c.incomingMaxAgeMinutes,
    keys: publicKeys(),
  };
}

/* The Settings page's view. Secrets appear as a fingerprint and a date, which
   is everything somebody debugging needs and nothing they could paste. */
function summarise({ state = {} } = {}) {
  const c = current();
  return {
    enabled: c.enabled,
    gatewayUrl: c.gatewayUrl,
    gatewayId: c.gatewayId,
    signing: {
      kid: c.signingKid,
      publicKey: c.signingPublic,          // public by definition; copyable on purpose
      madeAt: c.signingMadeAt,
      previousKid: c.prevKid,
      previousUntil: c.prevUntil,
      previousActive: withinOverlap(c.prevUntil),
    },
    secret: {
      // Never the secret. Set-or-not, which key encrypted it, and when.
      set: Boolean(c.gatewaySecret),
      fingerprint: c.gatewaySecretFp ? `key:${c.gatewaySecretFp}` : null,
      setAt: c.gatewaySecretAt,
      previousActive: Boolean(c.gatewaySecretPrev) && withinOverlap(c.gatewaySecretPrevUntil),
      previousUntil: c.gatewaySecretPrevUntil,
    },
    limits: {
      maxFileBytes: c.maxFileBytes,
      chunkBytes: c.chunkBytes,
      parallelChunks: c.parallelChunks,
      deniedExtensions: c.deniedExtensions,
      allowedExtensions: c.allowedExtensions,
      incomingMaxAgeMinutes: c.incomingMaxAgeMinutes,
      rotationOverlapMinutes: c.rotationOverlapMinutes,
    },
    sharedFolders: c.sharedFolders,
    emailOnDeleteRequests: c.emailOnDeleteRequests,
    serveLegacy: c.serveLegacy,
    configVersion: c.configVersion,
    updatedBy: c.updatedByName,
    updatedAt: c.updatedAt,
    readiness: readiness(state),
    encryption: { available: emailSecret.available(), keyName: emailSecret.keySource().name },
  };
}

/* One line per clause that actually moved, for the activity log. Secrets are
   named, never shown — "the gateway secret was regenerated" is the record. */
function describeChange(before = {}, after = {}) {
  const lines = [];
  const say = (field, label, format = (v) => v) => {
    const a = before[field];
    const b = after[field];
    const same = Array.isArray(a) && Array.isArray(b) ? a.join(',') === b.join(',') : String(a) === String(b);
    if (!same) lines.push(`${label}: ${format(a)} → ${format(b)}`);
  };
  const mb = (v) => `${Math.round(Number(v) / (1024 * 1024))} MB`;
  const gb = (v) => `${(Number(v) / GB).toFixed(Number(v) % GB ? 1 : 0)} GB`;
  say('enabled', 'Server tab', (v) => (v ? 'on' : 'off'));
  say('gatewayUrl', 'Gateway address', (v) => v || 'not set');
  say('gatewayId', 'Gateway id', (v) => v || 'not set');
  say('maxFileBytes', 'Maximum file size', gb);
  say('chunkBytes', 'Chunk size', mb);
  say('parallelChunks', 'Parallel chunks');
  say('deniedExtensions', 'Denied extensions', (v) => (v || []).join(' ') || 'none');
  say('allowedExtensions', 'Allowed extensions', (v) => (v || []).join(' ') || 'everything not denied');
  say('sharedFolders', 'Shared folders', (v) => (v || []).join(' ') || 'none');
  say('incomingMaxAgeMinutes', 'Abandoned uploads kept for', (v) => `${v} min`);
  say('rotationOverlapMinutes', 'Rotation overlap', (v) => `${v} min`);
  say('emailOnDeleteRequests', 'Email on deletion requests', (v) => (v ? 'on' : 'off'));
  say('serveLegacy', 'Serve legacy files', (v) => (v ? 'on' : 'off'));
  return lines;
}

module.exports = {
  DEFAULTS, MIN_CHUNK, MAX_CHUNK, MAX_FILE_CEILING,
  load, isLoaded, current, serverEnabled, readiness,
  publicKeys, signingKey, gatewaySecrets, fingerprint,
  generateKeyPair, generateSecret,
  validate, save, gatewayConfig, summarise, describeChange,
};
