// Where the studio's email goes out from.
//
// One row, held in the database rather than in the environment, for the reason
// every other Settings screen exists: changing which mail server the studio
// uses should be something a Super Admin does at their desk, not a redeploy.
// Mirrored in memory like branding.js, because it is read on every send and
// changed a handful of times in the life of a deployment.
//
// THE PASSWORD IS THE ODD ONE OUT. Everything else here is ordinary
// configuration; that one field is a live credential belonging to somebody
// else's mail server, and it is the only reversibly-stored secret in this
// database. It is encrypted going in (src/email-secret.js), never selected into
// any response, and never written to the Activity Log. The rest of this module
// is written so that staying true is not a matter of remembering: read() does
// not return it, and the only way to get at it is transportPassword(), whose
// name says what it is for.

const emailSecret = require('./email-secret');

const TABLES = ['email_config'];

/* The three ways a mail server wants to be spoken to, in the words the form
   uses. Mapped to nodemailer's flags in mailer.js rather than here, so this
   module has no opinion about the library. */
const ENCRYPTIONS = {
  tls: { label: 'STARTTLS', port: 587 },   // plain connection upgraded — the common one
  ssl: { label: 'SSL/TLS', port: 465 },    // encrypted from the first byte
  none: { label: 'None', port: 25 },       // for a relay on the same machine
};

const DEFAULTS = {
  enabled: false,
  host: '',
  port: 587,
  encryption: 'tls',
  username: '',
  fromName: '',
  fromAddress: '',
};

let cache = { ...DEFAULTS, hasPassword: false, passwordKeyId: null };
let loaded = false;

async function ensureTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS email_config (
    id              TINYINT      NOT NULL PRIMARY KEY,
    enabled         TINYINT(1)   NOT NULL DEFAULT 0,
    host            VARCHAR(255) NULL,
    port            SMALLINT UNSIGNED NULL,
    encryption      VARCHAR(8)   NOT NULL DEFAULT 'tls',
    username        VARCHAR(255) NULL,
    -- Ciphertext, never the password. See src/email-secret.js.
    password_enc    TEXT         NULL,
    -- Which key encrypted it, so a rotated secret is diagnosable.
    password_key_id VARCHAR(16)  NULL,
    from_name       VARCHAR(120) NULL,
    from_address    VARCHAR(255) NULL,
    last_test_at    DATETIME     NULL,
    last_error      VARCHAR(500) NULL,
    updated_by      VARCHAR(191) NULL,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

async function load(db) {
  let row = null;
  try {
    const { rows } = await db.query('SELECT * FROM email_config WHERE id = 1');
    row = rows[0] || null;
  } catch {
    /* No table yet. Treated as "not configured", which is the same thing as far
       as everything above this line is concerned: nothing is sent either way,
       and the Settings screen is what says which of the two it is. */
    row = null;
  }
  cache = row ? shape(row) : { ...DEFAULTS, hasPassword: false, passwordKeyId: null };
  loaded = true;
  return cache;
}

/* The row, minus the one field nobody upstream may have.
 *
 * password_enc is dropped HERE, at the boundary, rather than being deleted by
 * each caller. A field that never enters the cache cannot leak from it. */
function shape(row) {
  return {
    enabled: Boolean(row.enabled),
    host: row.host || '',
    port: row.port ? Number(row.port) : DEFAULTS.port,
    encryption: ENCRYPTIONS[row.encryption] ? row.encryption : 'tls',
    username: row.username || '',
    fromName: row.from_name || '',
    fromAddress: row.from_address || '',
    hasPassword: Boolean(row.password_enc),
    passwordKeyId: row.password_key_id || null,
    lastTestAt: row.last_test_at || null,
    lastError: row.last_error || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

function current() { return { ...cache }; }
function isLoaded() { return loaded; }

/* Is there enough here to send anything at all? Separate from `enabled`, which
   is the administrator's switch: this is whether the switch would do anything.*/
function isUsable(c = cache) {
  return Boolean(c.enabled && c.host && c.port && c.fromAddress);
}

// --- validation --------------------------------------------------------------

/* Deliberately permissive about the address, and deliberately not a full RFC
   5322 parser: the mail server is the authority on what it will accept, and a
   regex that refuses a valid address is worse than one that lets a typo through
   to a bounce. This catches the mistakes people actually make — no @, spaces,
   a name pasted into the address box. */
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function validate(input = {}, { existing = cache } = {}) {
  const errors = [];
  const enabled = Boolean(input.enabled);
  const host = String(input.host ?? '').trim();
  const username = String(input.username ?? '').trim();
  const fromName = String(input.fromName ?? '').trim();
  const fromAddress = String(input.fromAddress ?? '').trim();
  const encryption = String(input.encryption ?? 'tls').trim().toLowerCase();

  const portRaw = input.port === '' || input.port === undefined || input.port === null
    ? (ENCRYPTIONS[encryption] || ENCRYPTIONS.tls).port
    : Number(input.port);

  if (!ENCRYPTIONS[encryption]) {
    errors.push({ field: 'encryption', message: 'Choose STARTTLS, SSL/TLS or None.' });
  }
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    errors.push({ field: 'port', message: 'The port must be a whole number between 1 and 65535.' });
  }
  if (host.length > 255) errors.push({ field: 'host', message: 'The server name is too long.' });
  if (username.length > 255) errors.push({ field: 'username', message: 'The username is too long.' });
  if (fromName.length > 120) errors.push({ field: 'fromName', message: 'The From name must be 120 characters or fewer.' });
  if (fromAddress && !ADDRESS.test(fromAddress)) {
    errors.push({ field: 'fromAddress', message: `"${fromAddress}" is not an email address.` });
  }

  /* Only demanded when the switch is ON. A half-filled form saved with email
     switched off is somebody coming back to it later, not an error — and
     refusing to save it would mean they could not park the work. */
  if (enabled) {
    if (!host) errors.push({ field: 'host', message: 'A mail server is required to switch email on.' });
    if (!fromAddress) errors.push({ field: 'fromAddress', message: 'A From address is required to switch email on.' });
    /* A password is required only if a username is given AND none is stored:
       plenty of relays authenticate by IP and want neither. */
    const password = input.password === undefined ? null : String(input.password);
    const willHavePassword = (password !== null && password !== '') || existing.hasPassword;
    if (username && !willHavePassword) {
      errors.push({ field: 'password', message: 'A username was given, so a password is needed too.' });
    }
  }

  return {
    errors,
    values: { enabled, host, port: portRaw, encryption, username, fromName, fromAddress },
  };
}

// --- writing -----------------------------------------------------------------

/* Save.
 *
 * `password` is three-valued and the distinction is the whole reason the field
 * can be write-only:
 *
 *   undefined / absent   leave whatever is stored alone. This is what the form
 *                        sends every time somebody edits the host and does not
 *                        touch the password box.
 *   '' (empty string)    clear it — the relay no longer wants one.
 *   anything else        replace it.
 *
 * Without the first case, a screen that never redisplays the password could
 * only ever blank it, and every unrelated edit would silently break sending.
 */
async function save(db, input = {}, { actorEmail = null } = {}) {
  const { errors, values } = validate(input);
  if (errors.length) return { ok: false, status: 400, errors };

  let passwordEnc;      // undefined = leave alone
  let passwordKeyId;
  if (input.password !== undefined) {
    const text = String(input.password);
    if (text === '') {
      passwordEnc = null;
      passwordKeyId = null;
    } else {
      const sealed = emailSecret.encrypt(text);
      if (!sealed.ok) return { ok: false, status: 500, errors: [{ field: 'password', message: sealed.error }] };
      passwordEnc = sealed.value;
      passwordKeyId = sealed.keyId;
    }
  }

  const before = { ...cache };
  const sets = ['enabled', 'host', 'port', 'encryption', 'username', 'from_name', 'from_address', 'updated_by'];
  const params = [
    values.enabled ? 1 : 0, values.host || null, values.port, values.encryption,
    values.username || null, values.fromName || null, values.fromAddress || null, actorEmail,
  ];
  if (passwordEnc !== undefined) {
    sets.push('password_enc', 'password_key_id');
    params.push(passwordEnc, passwordKeyId);
  }

  const cols = ['id', ...sets].join(', ');
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const updates = sets.map((c) => `${c} = VALUES(${c})`).join(', ');
  await db.query(
    `INSERT INTO email_config (${cols}) VALUES (1, ${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    params
  );
  await load(db);
  return { ok: true, config: current(), before, changedPassword: passwordEnc !== undefined };
}

/* Record how the last send went, for the screen to show.
 *
 * Worth storing rather than only logging: on shared hosting the application log
 * is frequently unreadable, and "it stopped working three weeks ago" is a much
 * harder question than "the last attempt failed, and here is what the server
 * said". Never throws — a failure to record a failure must not become one. */
async function noteResult(db, { ok, error }) {
  try {
    await db.query(
      `UPDATE email_config SET last_test_at = NOW(), last_error = $1 WHERE id = 1`,
      [ok ? null : String(error || 'Unknown error').slice(0, 500)]
    );
    cache.lastTestAt = new Date();
    cache.lastError = ok ? null : String(error || '').slice(0, 500);
  } catch { /* the send is what mattered */ }
}

/* The password, in the clear, for one purpose.
 *
 * Read from the row every time rather than kept in the cache: the cache is
 * handed out by current() and read by the API, and a plaintext credential
 * sitting in a shared object is a leak waiting for one careless spread. */
async function transportPassword(db) {
  try {
    const { rows } = await db.query('SELECT password_enc, password_key_id FROM email_config WHERE id = 1');
    const row = rows[0];
    if (!row || !row.password_enc) return { ok: true, value: null };
    const opened = emailSecret.decrypt(row.password_enc, row.password_key_id);
    if (!opened.ok) return { ok: false, error: opened.error, reason: opened.reason };
    return { ok: true, value: opened.value };
  } catch (err) {
    return { ok: false, error: err.message, reason: 'storage' };
  }
}

module.exports = {
  TABLES, ENCRYPTIONS, DEFAULTS,
  ensureTables, load, current, isLoaded, isUsable,
  validate, save, noteResult, transportPassword, shape,
};
