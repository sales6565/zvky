// Encrypting the one credential this application stores on somebody's behalf.
//
// Every other secret here is a hash: passwords go through bcrypt and are never
// recovered, only compared. The SMTP password cannot work that way — the mail
// server wants the actual characters on every send — so it is the single value
// in this database that has to be stored reversibly. That makes it worth more
// care than a hash, not less.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
// than silently producing rubbish that gets sent to a mail server as a
// password. Random IV per encryption, so saving the same password twice does
// not produce the same bytes.
//
// WHAT THIS DOES NOT PROTECT AGAINST. The key lives in the environment on the
// same host as the database, so anybody who can read both can read the
// password. This defends against the realistic case — a database dump, a stray
// backup, a support person given read access to a table — and not against root
// on the server. Storing it in plain text would lose even that, and would put
// the studio's mail password into every mysqldump anybody ever takes.

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;    // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

/* Where the key comes from, in order of preference.
 *
 * EMAIL_ENCRYPTION_KEY is its own variable rather than a reuse of JWT_SECRET,
 * and the difference matters more than it looks. JWT_SECRET SHOULD be rotated —
 * rotating it signs everybody out, which is an inconvenience. If it were also
 * the mail key, rotating it would silently turn every stored SMTP password into
 * undecryptable bytes, and the failure would not appear until the next email
 * did not arrive. Two jobs, two keys.
 *
 * Falling back to JWT_SECRET anyway, because the alternative is a deployment
 * where this feature cannot be used at all until somebody edits .env — and the
 * fingerprint below means a later rotation produces a clear "re-enter the
 * password" rather than a mystery.
 */
function keySource() {
  if (process.env.EMAIL_ENCRYPTION_KEY) return { secret: process.env.EMAIL_ENCRYPTION_KEY, name: 'EMAIL_ENCRYPTION_KEY' };
  if (process.env.JWT_SECRET) return { secret: process.env.JWT_SECRET, name: 'JWT_SECRET' };
  return { secret: null, name: null };
}

function available() {
  return Boolean(keySource().secret);
}

/* A 32-byte key from whatever length of secret the environment holds.
 *
 * scrypt with a fixed salt rather than a random one: the key has to be
 * reproducible across restarts from the environment alone, and there is nowhere
 * to keep a per-deployment salt that is not itself the thing being protected.
 * The secret is the entropy; this is only stretching it to the right size. */
function derive(secret) {
  return crypto.scryptSync(String(secret), 'zvky-email-config-v1', 32);
}

/* Which key encrypted a given value, recorded alongside it.
 *
 * Eight hex characters of a hash of the key — enough to tell "the same key" from
 * "a different key", and far too little to help anybody recover it. This is the
 * whole reason a rotated JWT_SECRET produces a sentence instead of a silence. */
function fingerprint(secret) {
  return crypto.createHash('sha256').update(`fp:${secret}`).digest('hex').slice(0, 8);
}

function currentFingerprint() {
  const { secret } = keySource();
  return secret ? fingerprint(secret) : null;
}

/* Encrypt. Returns the string that goes in the column, and the fingerprint that
   goes beside it, or an explanation of why it cannot. */
function encrypt(plain) {
  const { secret, name } = keySource();
  if (!secret) {
    return {
      ok: false,
      error: 'This server has no key to encrypt the mail password with. Set EMAIL_ENCRYPTION_KEY '
        + '(or JWT_SECRET) in the environment and restart, then save the password again.',
    };
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, derive(secret), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // v1:<iv>:<tag>:<ciphertext> — versioned so a later algorithm change can read
  // what this one wrote instead of throwing on it.
  return {
    ok: true,
    value: `v1:${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`,
    keyId: fingerprint(secret),
    keyName: name,
  };
}

/* Decrypt, and say WHY when it fails.
 *
 * The three failures are different problems with different fixes, and a caller
 * that cannot tell them apart can only say "email is broken":
 *
 *   no-key        the environment lost its secret entirely
 *   key-changed   the secret was rotated; the password must be re-entered
 *   corrupt       the column holds something this cannot read at all
 */
function decrypt(stored, storedKeyId) {
  const { secret } = keySource();
  if (!stored) return { ok: false, reason: 'empty' };
  if (!secret) {
    return { ok: false, reason: 'no-key',
      error: 'This server has no key to decrypt the mail password with. Set EMAIL_ENCRYPTION_KEY '
        + '(or restore JWT_SECRET) and restart.' };
  }
  if (storedKeyId && storedKeyId !== fingerprint(secret)) {
    return { ok: false, reason: 'key-changed',
      error: 'The mail password was encrypted with a different key than this server now has — '
        + 'JWT_SECRET or EMAIL_ENCRYPTION_KEY has changed since it was saved. Enter the password '
        + 'again in Settings to store it under the current key.' };
  }
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { ok: false, reason: 'corrupt', error: 'The stored mail password could not be read. Enter it again.' };
  }
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const body = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      return { ok: false, reason: 'corrupt', error: 'The stored mail password could not be read. Enter it again.' };
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, derive(secret), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return { ok: true, value: plain };
  } catch {
    /* Authentication failed. Almost always the key, occasionally a truncated
       column; either way the remedy is the same and the message says it without
       guessing which. */
    return { ok: false, reason: 'key-changed',
      error: 'The stored mail password could not be decrypted with this server\'s key. Enter it '
        + 'again in Settings.' };
  }
}

module.exports = { encrypt, decrypt, available, currentFingerprint, keySource };
