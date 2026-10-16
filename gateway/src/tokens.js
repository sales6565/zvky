/* Verifying the tokens Forge mints. The gateway holds PUBLIC keys only.
 *
 * That asymmetry is the point of the whole scheme: this process runs on an
 * office machine with the file share mounted, which is the least defensible
 * box in the system. It can verify a permission Forge granted and it cannot
 * grant one — there is no private key here to steal, so a compromised gateway
 * cannot mint itself a token for somebody else's folder.
 *
 * FORMAT, written out because two codebases have to agree on it:
 *
 *   base64url(header) "." base64url(payload) "." base64url(signature)
 *   header   { "alg": "EdDSA", "kid": "<key id>" }
 *   payload  { iss, aud, sub, op, path, exp, jti, uid?, max? }
 *   signature  Ed25519 over the ASCII bytes of "<header>.<payload>"
 *
 * It is JWS-compact shaped deliberately — anybody who has seen a JWT can read
 * it — but it is parsed by the twenty lines below rather than by a library,
 * because the one thing this must never do is accept `"alg": "none"` or an
 * HMAC token verified with a public key as the secret. Those are library
 * footguns; here the algorithm is not negotiable and `alg` is checked against
 * the single value this understands rather than used to select a verifier.
 *
 * Ed25519 rather than RS256: 64-byte signatures, no parameter choices to get
 * wrong, and node verifies it from core with no dependency — which matters for
 * a package IT installs by hand on a Windows box.
 */
const crypto = require('node:crypto');

const ALG = 'EdDSA';
const ISSUER = 'forge';

/* The operations, and the longest a token for each may live.
 *
 * Enforced HERE as well as at the mint. Forge decides the expiry; this refuses
 * one that is longer than the operation is allowed to be, so a bug (or a
 * compromised control plane) that mints a week-long download token still gets
 * a minute out of it. */
const OPS = {
  list:     { maxSeconds: 60,       single: false },
  mkdir:    { maxSeconds: 60,       single: true  },
  download: { maxSeconds: 60,       single: true  },
  upload:   { maxSeconds: 30 * 60,  single: false },
  selftest: { maxSeconds: 60,       single: false },
};

const b64u = {
  decode: (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  encode: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

const fail = (reason, detail) => ({ ok: false, reason, detail: detail || reason });

/* Replayed tokens.
 *
 * In memory, swept, and deliberately NOT persisted: the window is at most
 * thirty minutes, and a gateway restart inside that window re-opens at most the
 * handful of tokens issued in it. Persisting would mean a file to corrupt and a
 * second thing to clean up, for a replay window that a restart already shortens.
 *
 * A single-use token is consumed on first SUCCESSFUL verification. A multi-use
 * one is recorded so it cannot outlive its expiry by being presented to a
 * restarted process with a clock skew — the expiry check does that — and so the
 * sweep has something to count.
 */
class JtiStore {
  constructor() { this.seen = new Map(); }
  sweep(now = Date.now()) {
    for (const [jti, exp] of this.seen) if (exp * 1000 <= now) this.seen.delete(jti);
    return this.seen.size;
  }
  /* Returns false when this jti may not be used again. */
  use(jti, exp, single, now = Date.now()) {
    this.sweep(now);
    const had = this.seen.has(jti);
    if (had && single) return false;
    this.seen.set(jti, exp);
    return true;
  }
  size() { return this.seen.size; }
}

/* The verification itself.
 *
 * `keys` is the list Forge publishes — the current key and, during a rotation,
 * the previous one. Both are tried, selected by `kid` when the header names one
 * this gateway knows, so a token minted seconds before a rotation still works
 * and one minted with a key that was retired long ago does not.
 */
/* CLOCK SKEW LEEWAY.
 *
 * A download token lives sixty seconds. Two machines whose clocks differ by
 * forty of those have a feature that works in the morning and not after lunch,
 * and the failure says "that link has expired" to somebody who clicked it
 * immediately — which is the least diagnosable error message in the system.
 *
 * So the expiry is checked with a small leeway, ±30 s by default, configurable
 * for a studio with a worse NTP story, and HARD-CAPPED at 120 s. The cap is the
 * point: leeway is a tolerance for ordinary drift, and a gateway that accepted
 * an hour of it would have turned a sixty-second token into an hour-long one.
 * Anything past the cap is clamped rather than refused, because a gateway that
 * would not start over a mis-typed number is worse than one that runs with the
 * documented maximum and says so.
 *
 * The real fix is the clock, and the system says so in three places: the
 * heartbeat reports the measured skew, Settings warns above 15 s, and the
 * doctor FAILS above the leeway. */
const SKEW_DEFAULT_SECONDS = 30;
const SKEW_CAP_SECONDS = 120;

function leewayFor(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return SKEW_DEFAULT_SECONDS;
  return Math.min(Math.floor(n), SKEW_CAP_SECONDS);
}

function verify(token, { keys, audience, now = Date.now(), jtiStore, expect = {}, leewaySeconds } = {}) {
  const leeway = leewayFor(leewaySeconds === undefined ? SKEW_DEFAULT_SECONDS : leewaySeconds);
  if (!token || typeof token !== 'string') return fail('missing', 'No token.');
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed', 'That token is not in the expected form.');
  let header; let payload;
  try { header = JSON.parse(b64u.decode(parts[0]).toString('utf8')); } catch { return fail('malformed', 'Unreadable token header.'); }
  try { payload = JSON.parse(b64u.decode(parts[1]).toString('utf8')); } catch { return fail('malformed', 'Unreadable token body.'); }
  if (!header || header.alg !== ALG) return fail('alg', 'That token is not signed the way this gateway accepts.');

  const candidates = (keys || []).filter((k) => k && k.publicKey && (!header.kid || !k.kid || k.kid === header.kid));
  if (!candidates.length) return fail('kid', 'That token was signed with a key this gateway does not have.');

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  const sig = b64u.decode(parts[2]);
  let usedKid = null;
  for (const k of candidates) {
    let ok = false;
    try {
      ok = crypto.verify(null, signed, typeof k.publicKey === 'string'
        ? crypto.createPublicKey(k.publicKey) : k.publicKey, sig);
    } catch { ok = false; }
    if (ok) { usedKid = k.kid || null; break; }
  }
  if (usedKid === null) return fail('signature', 'That token has been altered.');

  // Claims. Order matters only for the message the caller shows; each is checked.
  if (payload.iss !== ISSUER) return fail('issuer', 'That token was not issued by Forge.');
  if (!audience || payload.aud !== audience) return fail('audience', 'That token was issued for a different gateway.');
  const op = OPS[payload.op];
  if (!op) return fail('operation', 'That token names an operation this gateway does not have.');
  if (expect.op && payload.op !== expect.op) return fail('operation', 'That token is not for this operation.');
  if (!payload.sub) return fail('subject', 'That token names nobody.');
  if (!payload.jti) return fail('jti', 'That token has no identifier.');
  if (!Number.isFinite(payload.exp)) return fail('expiry', 'That token has no expiry.');
  const seconds = Math.floor(now / 1000);
  if (payload.exp + leeway <= seconds) return fail('expired', 'That link has expired. Try again.');
  /* nbf, when a token carries one: a clock AHEAD of Forge's would otherwise
     refuse a token minted a moment ago as "not yet valid", which is the same
     outage in the other direction. */
  if (Number.isFinite(payload.nbf) && payload.nbf - leeway > seconds) {
    return fail('too-early', 'That link is not valid yet. Check the clock on this machine.');
  }
  if (Number.isFinite(payload.iat) && payload.exp - payload.iat > op.maxSeconds) {
    return fail('lifetime', `A ${payload.op} token may not live longer than ${op.maxSeconds} seconds.`);
  }
  if (payload.exp - seconds > op.maxSeconds + leeway + 5) {
    return fail('lifetime', `A ${payload.op} token may not live longer than ${op.maxSeconds} seconds.`);
  }
  if (typeof payload.path !== 'string') return fail('path', 'That token does not say which folder it is for.');
  if (payload.op === 'upload' && !payload.uid) return fail('uid', 'That upload token names no upload.');
  if (expect.uid && payload.uid !== expect.uid) return fail('uid', 'That token is for a different upload.');

  if (jtiStore && !jtiStore.use(payload.jti, payload.exp, op.single, now)) {
    return fail('replay', 'That link has already been used. Ask for a new one.');
  }
  return { ok: true, claims: payload, kid: usedKid, single: op.single };
}

module.exports = { verify, JtiStore, OPS, ALG, ISSUER, b64u, leewayFor, SKEW_DEFAULT_SECONDS, SKEW_CAP_SECONDS };
