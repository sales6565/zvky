/* THE ENVELOPE AROUND A BACKUP PACKAGE: AES-256-GCM over a scrypt-derived key.
 *
 * ===========================================================================
 * WHAT IS BEING PROTECTED, WHICH DECIDES EVERYTHING BELOW.
 *
 * A full backup is the most sensitive artefact this system can produce. It holds
 * every bcrypt hash, every encrypted setting, the whole of the studio's business
 * data, and — when the owner opts in — the .env values themselves. It is also
 * the one artefact whose entire purpose is to be COPIED somewhere else: onto a
 * laptop, into cloud storage, onto a USB stick in a drawer. Every place it ends
 * up is a place the studio does not control.
 *
 * So the package is encrypted by default, with a key that exists only in the
 * owner's head and in memory for the seconds it takes to write the file.
 *
 * ===========================================================================
 * THE SHAPE OF THE FILE, AND WHY THE HEADER IS IN THE CLEAR.
 *
 *   magic      9 bytes   "FORGEBAK" + format version digit
 *   hdrLen     4 bytes   big-endian length of the header JSON
 *   header     hdrLen    JSON: format, encrypted, kdf params, salt, iv
 *   payload    ...       gzip(tar(...)) — enciphered when encrypted is true
 *   tag        16 bytes  the GCM authentication tag, when encrypted is true
 *
 * THE HEADER IS PLAINTEXT ON PURPOSE. Something has to tell a reader what to do
 * with the rest, and "try scrypt with these parameters" cannot itself be
 * encrypted. It carries the salt and the IV, which are not secret — they are
 * random values whose job is to make two packages of the same data differ — and
 * the KDF cost, so a package written today still opens after the cost is raised
 * tomorrow. It carries NO filename, NO table names, NO version of the studio's
 * data, and above all no hint of the passphrase: a header that leaked a
 * password check would make guessing cheaper.
 *
 * THE TAG IS AT THE END because that is where GCM produces it: the payload is
 * enciphered as it streams and the tag is only known once the last byte has gone
 * through. Writing the header first and the tag last is what lets the whole
 * package be produced in one pass with bounded memory, which on shared hosting
 * is the difference between a backup and a killed process.
 *
 * TAMPERING IS DETECTED BY CONSTRUCTION. GCM verifies the tag over the whole
 * ciphertext, so one flipped byte anywhere makes decrypt() throw rather than
 * produce plausible rubbish. The additional authenticated data is the header
 * bytes themselves, so an attacker cannot lower the KDF cost or swap the salt
 * and have the result still verify.
 *
 * ===========================================================================
 * WHY scrypt, AND WITH WHAT PARAMETERS.
 *
 * scrypt is in Node's crypto and is already how this project stretches
 * EMAIL_ENCRYPTION_KEY (src/email-secret.js), so it is the strongest KDF
 * already in the dependencies — the brief's own instruction. It is memory-hard,
 * which is what matters against somebody who has stolen a package and can spend
 * a weekend on it.
 *
 * N = 2^15 (32768), r = 8, p = 1 needs about 32 MB and takes roughly a tenth of
 * a second here. That is chosen for SHARED HOSTING: Passenger on a GoDaddy plan
 * has a hard memory ceiling, and a KDF that needs 1 GB turns "take a backup"
 * into "the app restarts". maxmem is raised explicitly because Node's default
 * ceiling is 32 MB and 2^15 lands exactly on it.
 *
 * THE SALT IS PER PACKAGE, so two backups of the same database under the same
 * passphrase share no key, and a rainbow table against one is useless against
 * the other.
 */
const crypto = require('node:crypto');
const { Transform } = require('node:stream');

const MAGIC = Buffer.from('FORGEBAK1', 'ascii');      // 9 bytes, format 1
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;                                   // 96 bits, GCM's native size
const TAG_BYTES = 16;
const SALT_BYTES = 16;

/* The KDF cost, as data rather than as three numbers scattered through the
   code: it is written into every header, and a reader uses the header's copy
   rather than this one so that raising the cost cannot orphan old packages. */
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: KEY_BYTES };
const MAXMEM = 256 * 1024 * 1024;   // room for N=2^15 and for a later raise

/* A passphrase good enough to be worth typing twice.
 *
 * NOT A PASSWORD POLICY — there is no account here to lock out, and the only
 * thing a rule can do is tell the owner that "correct horse battery staple" is
 * refused while "P@ssw0rd!" is accepted, which is the wrong lesson. So: a floor
 * on length, because scrypt cannot save a six-character passphrase, and a
 * strength HINT the screen shows, because the honest advice is "longer".
 */
const MIN_LENGTH = 12;

function strength(passphrase) {
  const value = String(passphrase || '');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (value.length < MIN_LENGTH) {
    return { ok: false, level: 'too-short',
      message: `A backup passphrase must be at least ${MIN_LENGTH} characters. Longer matters far `
        + 'more than punctuation: four or five unrelated words are both stronger and easier to '
        + 'type correctly at three in the morning.' };
  }
  if (value.length >= 24 || (value.length >= 16 && classes >= 3)) {
    return { ok: true, level: 'strong', message: 'Strong.' };
  }
  if (value.length >= 16 || classes >= 3) {
    return { ok: true, level: 'fair',
      message: 'Fair. A few more words would make this much harder to guess.' };
  }
  return { ok: true, level: 'weak',
    message: 'Weak but accepted. This is the only thing standing between a stolen package and '
      + 'every password hash in the studio — consider a longer one.' };
}

function deriveKey(passphrase, salt, params = KDF) {
  const value = String(passphrase === undefined || passphrase === null ? '' : passphrase);
  if (!value) {
    const err = new Error('A passphrase is required to encrypt or open a backup package.');
    err.code = 'BACKUP_NO_PASSPHRASE';
    throw err;
  }
  return crypto.scryptSync(value, salt, params.keyLength || KEY_BYTES, {
    N: params.N, r: params.r, p: params.p, maxmem: MAXMEM,
  });
}

/* ===========================================================================
 * WRITING.
 *
 * Returns { head, cipher, finish }, where `head` is the bytes to write first,
 * `cipher` is a Transform to pipe the gzipped tar through, and `finish()`
 * answers the trailing tag once the stream has ended. The caller owns the file
 * handle, because the engine also wants to hash what it writes as it goes.
 *
 * An UNENCRYPTED package (CLI --no-encrypt only) takes the same shape with a
 * pass-through and no tag, so there is one reader for both and the header is
 * what says which it is. Two code paths for "open a package" is how one of them
 * ends up not checking something.
 */
function writer({ passphrase, encrypt = true, extra = {} } = {}) {
  if (!encrypt) {
    const header = Buffer.from(JSON.stringify({
      format: 1, encrypted: false, ...extra,
    }), 'utf8');
    return {
      encrypted: false,
      head: Buffer.concat([MAGIC, lengthOf(header), header]),
      cipher: new Transform({ transform(c, _e, cb) { cb(null, c); } }),
      finish: () => Buffer.alloc(0),
    };
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.from(JSON.stringify({
    format: 1,
    encrypted: true,
    cipher: ALGORITHM,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ...extra,
  }), 'utf8');

  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  /* THE HEADER IS AUTHENTICATED, NOT JUST CARRIED. Without this an attacker
     could rewrite the KDF cost to N=2 and the package would still decrypt for
     them far faster; with it, any edit to the header makes the tag fail. */
  cipher.setAAD(header);
  key.fill(0);

  return {
    encrypted: true,
    head: Buffer.concat([MAGIC, lengthOf(header), header]),
    cipher,
    finish: () => cipher.getAuthTag(),
  };
}

function lengthOf(header) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return len;
}

/* ===========================================================================
 * READING.
 *
 * readHeader(fd) answers the clear header and the offset the payload starts at,
 * without touching the passphrase — which is what lets the Settings list say
 * "encrypted: yes" about a package nobody can currently open, and what lets the
 * restore script refuse a package of the wrong format before asking for a
 * passphrase.
 */
function readHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MAGIC.length + 4) {
    const err = new Error('This file is too short to be a Forge backup package.');
    err.code = 'BACKUP_NOT_A_PACKAGE';
    throw err;
  }
  if (!buffer.slice(0, MAGIC.length - 1).equals(MAGIC.slice(0, MAGIC.length - 1))) {
    const err = new Error('This file is not a Forge backup package.');
    err.code = 'BACKUP_NOT_A_PACKAGE';
    throw err;
  }
  const version = buffer.slice(MAGIC.length - 1, MAGIC.length).toString('ascii');
  if (version !== '1') {
    const err = new Error(`This package is format ${version}; this version of Forge writes and reads `
      + 'format 1. Restore it with the Forge version that wrote it.');
    err.code = 'BACKUP_BAD_FORMAT';
    throw err;
  }
  const hdrLen = buffer.readUInt32BE(MAGIC.length);
  if (hdrLen > 64 * 1024 || buffer.length < MAGIC.length + 4 + hdrLen) {
    const err = new Error('This package\'s header is damaged.');
    err.code = 'BACKUP_BAD_HEADER';
    throw err;
  }
  const raw = buffer.slice(MAGIC.length + 4, MAGIC.length + 4 + hdrLen);
  let header;
  try {
    header = JSON.parse(raw.toString('utf8'));
  } catch {
    const err = new Error('This package\'s header is not readable.');
    err.code = 'BACKUP_BAD_HEADER';
    throw err;
  }
  return { header, raw, payloadAt: MAGIC.length + 4 + hdrLen };
}

/* A Transform that holds back the last TAG_BYTES of a stream and hands them to
 * the decipher at the end.
 *
 * WHY THIS IS NEEDED AT ALL: the tag is the file's last sixteen bytes, and the
 * decipher must be told the tag BEFORE final() — so the payload cannot simply
 * be piped at it. This buffers a sixteen-byte sliding window, which is the whole
 * of the memory cost of streaming decryption.
 */
class SplitTag extends Transform {
  constructor(tagBytes = TAG_BYTES) {
    super();
    this.tagBytes = tagBytes;
    this.held = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    const all = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    if (all.length <= this.tagBytes) {
      this.held = all;
      return cb();
    }
    const keep = all.length - this.tagBytes;
    this.held = all.slice(keep);
    return cb(null, all.slice(0, keep));
  }

  _flush(cb) {
    if (this.held.length < this.tagBytes) {
      return cb(Object.assign(
        new Error('This package ends before its authentication tag — it is truncated.'),
        { code: 'BACKUP_TRUNCATED' }
      ));
    }
    this.tag = this.held;
    this.emit('tag', this.tag);
    return cb();
  }
}

/* The reading half: given the header and a passphrase, answer the Transform
 * chain that turns payload bytes into the gzipped tar.
 *
 * ONE FUNCTION FOR BOTH KINDS OF PACKAGE. An unencrypted one gets a
 * pass-through; nothing above here has to know which, and there is no second
 * path that could forget to check the tag.
 */
function reader({ header, raw, passphrase }) {
  if (!header.encrypted) {
    return {
      encrypted: false,
      transforms: [new Transform({ transform(c, _e, cb) { cb(null, c); } })],
      verify: async () => true,
    };
  }
  const salt = Buffer.from(String(header.salt || ''), 'base64');
  const iv = Buffer.from(String(header.iv || ''), 'base64');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    const err = new Error('This package\'s header is damaged.');
    err.code = 'BACKUP_BAD_HEADER';
    throw err;
  }
  const params = {
    N: Number((header.kdf || {}).N) || KDF.N,
    r: Number((header.kdf || {}).r) || KDF.r,
    p: Number((header.kdf || {}).p) || KDF.p,
    keyLength: KEY_BYTES,
  };
  const key = deriveKey(passphrase, salt, params);
  const decipher = crypto.createDecipheriv(String(header.cipher || ALGORITHM), key, iv,
    { authTagLength: TAG_BYTES });
  decipher.setAAD(raw);
  key.fill(0);

  const split = new SplitTag();
  split.on('tag', (tag) => { decipher.setAuthTag(tag); });

  return { encrypted: true, transforms: [split, decipher], split, decipher };
}

/* The one sentence everything that touches this must say the same way. */
const LOST_PASSPHRASE_WARNING =
  'If the passphrase is lost the backup cannot be opened. There is no recovery, no reset and no '
  + 'master key: that is what makes the package safe to store somewhere Forge does not control. '
  + 'Keep it somewhere separate from the backup itself.';

module.exports = {
  MAGIC, ALGORITHM, KDF, MIN_LENGTH, TAG_BYTES, SALT_BYTES, IV_BYTES,
  strength, deriveKey, writer, reader, readHeader, SplitTag,
  LOST_PASSPHRASE_WARNING,
};
