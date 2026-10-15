/* How the gateway proves to Forge that it is the gateway.
 *
 * Deliberately the SAME scheme Forge already runs for its Dev & QA integration
 * (src/middleware/service-auth.js): a header of "t=<unix seconds>, v1=<hex>"
 * over "<t>.<METHOD>.<target>.<raw body>" with HMAC-SHA256, a five-minute skew
 * window, and support for a previous secret while one is being rotated.
 *
 * It is RE-STATED here rather than imported because this package is installed
 * on an office machine on its own — there is no src/ next to it. That is a
 * duplicated rule, which is normally the thing to avoid, so it is pinned: a
 * test signs with this module and verifies with Forge's own signingPayload, and
 * fails if either side ever changes the shape. One of the two is the definition
 * and the other is checked against it, rather than both being hopeful.
 */
const crypto = require('node:crypto');

const SIGNATURE_HEADER = 'x-gateway-signature';
const ID_HEADER = 'x-gateway-id';
const MAX_SKEW_SECONDS = 300;

const payload = (t, method, target, rawBody) =>
  `${t}.${String(method).toUpperCase()}.${target}.${rawBody === undefined || rawBody === null ? '' : String(rawBody)}`;

function sign(secret, { method, target, body, t = Math.floor(Date.now() / 1000) }) {
  const v1 = crypto.createHmac('sha256', String(secret)).update(payload(t, method, target, body)).digest('hex');
  return { header: `t=${t}, v1=${v1}`, t, v1 };
}

module.exports = { sign, payload, SIGNATURE_HEADER, ID_HEADER, MAX_SKEW_SECONDS };
