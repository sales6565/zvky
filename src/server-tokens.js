/* Minting the tokens the office gateway verifies.
 *
 * The private key lives HERE and only here. The gateway is given public keys,
 * so the machine with the file share mounted — the one physically in an office,
 * the one most likely to be compromised — can check a permission and cannot
 * invent one. See gateway/src/tokens.js for the other half and for the exact
 * wire format; this module is the definition of it.
 *
 * Ed25519 rather than RS256 or an HMAC. An HMAC would mean the gateway holds
 * the same secret it verifies with, which is the property we are specifically
 * refusing. RS256 would work and is three times the signature for no benefit.
 * jsonwebtoken is already a dependency but does not sign EdDSA, and reaching
 * for RS256 to stay inside a library we already have would be choosing the
 * weaker shape for the weaker reason — so the twenty lines are written out.
 *
 * WHAT A TOKEN SAYS, and what it deliberately does not. It names one user, one
 * operation, one path, one expiry and one id. It does NOT carry the user's
 * permissions, their role, or a list of folders: every grant is decided here,
 * at mint time, from permissions and visibleProjects(), and the token is the
 * answer rather than the question. A gateway cannot re-interpret it.
 */
const crypto = require('node:crypto');

const ALG = 'EdDSA';
const ISSUER = 'forge';

/* The longest each operation's token may live. The gateway enforces the same
   numbers independently (gateway/src/tokens.js OPS) — a test pins the two
   tables against each other, because a mint that quietly exceeded what the
   gateway accepts would be an outage, and one that quietly fell short of what
   the studio was told would be a security claim that is not true. */
const LIFETIMES = {
  list: 60,
  mkdir: 60,
  download: 60,
  upload: 30 * 60,
  selftest: 60,
};

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* A key id that is a function of the key itself: eight hex characters of a
   SHA-256 over the public key's DER. Two consequences, both wanted — the same
   key always has the same id (so a cache cannot go stale), and the id says
   nothing secret (so it can be shown in Settings and copied into a ticket). */
function keyId(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKey: publicPem, privateKey: privatePem, kid: keyId(publicPem) };
}

/* Mint. `seconds` may shorten a token but never lengthen it past the operation's
   limit — a caller that asks for an hour of download gets sixty seconds, which
   is the stricter of what was asked and what is allowed. */
function mint({ privateKey, kid, audience, userId, op, path: relative, uploadId, maxBytes, name,
  existingPrefix, seconds, now = Date.now() }) {
  const limit = LIFETIMES[op];
  if (!limit) throw new Error(`There is no "${op}" operation to mint a token for.`);
  if (!audience) throw new Error('A token must name the gateway it is for.');
  if (!userId) throw new Error('A token must name a user.');
  const iat = Math.floor(now / 1000);
  const live = Math.min(Number(seconds) > 0 ? Number(seconds) : limit, limit);
  const payload = {
    iss: ISSUER,
    aud: String(audience),
    sub: String(userId),
    op,
    // '' is the root and is meaningful, so it is normalised rather than dropped.
    path: relative === undefined || relative === null ? '' : String(relative),
    iat,
    exp: iat + live,
    jti: crypto.randomUUID(),
  };
  if (uploadId) payload.uid = String(uploadId);
  /* THE FOLDER THAT MUST ALREADY EXIST, and the line below which the gateway
     may create.
     
     A project's folder is a place a studio made, with months of work in it. If
     the gateway created it when it was missing, a mistyped link would quietly
     produce a second folder and the work would go somewhere nobody is looking —
     and the project manager would see "uploaded" and believe it. So the token
     names the project folder as a precondition: the gateway refuses the upload
     if it is not there, and creates only the discipline and person folders
     under it. */
  if (existingPrefix !== undefined && existingPrefix !== null) payload.pre = String(existingPrefix);
  if (Number.isFinite(Number(maxBytes))) payload.max = Number(maxBytes);
  if (name) payload.name = String(name);

  const header = b64u(Buffer.from(JSON.stringify({ alg: ALG, kid: kid || null })));
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(`${header}.${body}`, 'ascii'), crypto.createPrivateKey(privateKey));
  return { token: `${header}.${body}.${b64u(sig)}`, claims: payload, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

module.exports = { generate, mint, keyId, LIFETIMES, ALG, ISSUER };
