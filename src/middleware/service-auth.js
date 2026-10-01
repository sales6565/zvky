/* Authenticating a MACHINE, which is not a small user.
 *
 * Everything else behind /api is a person: authenticate() reads a JWT, loads
 * their row, resolves their designation and hangs a permission Set off the
 * request, and every gate in the application reads that. None of it applies
 * here, and forcing it to would be worse than not having it:
 *
 *   NO req.user.        A credential is not an account. Putting one in req.user
 *                       would make every `hasFullAccess(req.user)`,
 *                       `ownsAsset`, `canViewAsset` and projectScope check in
 *                       the codebase start answering questions about a build
 *                       server, and the answers would be whatever the shape
 *                       happened to produce rather than anything anybody chose.
 *   NO req.permissions. The catalogue is a list of things a DESIGNATION may do,
 *                       granted per role in Settings by a Super Admin. An
 *                       integration's reach is its own allowed_actions list,
 *                       set when the credential is issued, and conflating the
 *                       two would let a change to a role silently widen what an
 *                       external tool can do.
 *   NO requirePermission / can / requireSuperAdmin. They read the two things
 *                       above. A middleware that populated them just enough to
 *                       satisfy those helpers would be a machine wearing a
 *                       person's clothes, and the first reviewer to read
 *                       `requireSuperAdmin` on an integration route would have
 *                       to work out which it was.
 *
 * What it produces instead is `req.integration`: the client row, its actions,
 * and the action this request is making. Integration routes read that and
 * nothing else.
 *
 * THREE CHECKS, IN THIS ORDER, and the order is deliberate — each is cheaper
 * than the one after it, and each refuses without revealing whether the next
 * would have passed:
 *
 *   1. the signature   proves the body arrived as sent, and recently. Costs no
 *                      database access, so an unsigned flood never reaches one.
 *   2. the credential  one indexed read on a hash.
 *   3. the action      what this key is allowed to do, from its own CSV.
 */

const crypto = require('node:crypto');
const db = require('../db');
const secrets = require('../integration-secrets');

/* The secret for THIS direction only: Dev & QA calling Forge.
 *
 * The outbox worker signing Forge's calls to Dev & QA uses a different one
 * (INTEGRATION_OUTBOUND_SECRET, reserved here so the two cannot be confused
 * later). One shared secret for both directions means a party that can verify
 * a message can also forge one, which removes the only thing a signature
 * proves. */
const INBOUND_SECRET_VAR = 'INTEGRATION_INBOUND_SECRET';

// How far a request's timestamp may be from ours. Long enough for a slow
// network and a little clock drift; short enough that a captured request is
// not replayable tomorrow.
const MAX_SKEW_SECONDS = 300;

const KEY_HEADER = 'x-integration-key';
const SIGNATURE_HEADER = 'x-integration-signature';

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

/* Equal-length comparison that does not leak where two values first differ.
 *
 * timingSafeEqual THROWS on a length mismatch, which would itself be a timing
 * signal and a 500 — so the length is checked first and answered as an ordinary
 * mismatch. Both sides here are hex digests of fixed width, so a wrong length
 * means a malformed header rather than a near miss. */
function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/* "t=1700000000, v1=abc…" -> { t, v1 }. Tolerant of spacing, and of extra
   versions arriving later: an unknown vN is ignored rather than refused, so
   adding v2 does not break a caller still sending v1. */
function parseSignature(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

const refuse = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

/* WHAT IS SIGNED: "t.METHOD.target.rawBody", joined by dots.
 *
 * `target` is the request line as sent, INCLUDING any query string — not the
 * path alone. Signing a path while leaving the query unsigned means an
 * attacker who cannot alter the body can still alter ?limit= or ?project= on a
 * captured request and have it verify. Integration calls are POSTs carrying
 * JSON, so in practice the two are the same string; where they differ, this is
 * the one that is safe.
 */
const signingPayload = (t, method, target, rawBody) =>
  `${t}.${String(method).toUpperCase()}.${target}.${rawBody}`;

/* THE TARGET THAT IS SIGNED, as this server can see it. Every form is an exact
 * function of the request that arrived, so accepting any of them never accepts a
 * signature made without the secret:
 *
 *   1. req.originalUrl, the request line as received: what every caller has signed
 *      until now, and still the first one tried.
 *   2. the mount path plus the router-relative URL (req.baseUrl + req.url): the
 *      application-level target, which a host's proxy cannot change by adding or
 *      removing a path prefix in front of the app.
 *   3. form 2 with its query parameters in a fixed order (sorted by name, values of a
 *      repeated name kept in their order) and in URLSearchParams' encoding: what Dev &
 *      QA signs and sends, so a proxy that reorders or re-encodes a query string does
 *      not break the signature.
 */
function canonicalTargets(req) {
  const out = [req.originalUrl];
  if (typeof req.url === 'string') {
    const mounted = `${req.baseUrl || ''}${req.url}`;
    out.push(mounted);
    const q = mounted.indexOf('?');
    if (q >= 0) {
      const pairs = [...new URLSearchParams(mounted.slice(q + 1))];
      const sorted = pairs.map((p, i) => [p, i]).sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1])).map((x) => x[0]);
      const qs = new URLSearchParams(sorted).toString();
      out.push(qs ? `${mounted.slice(0, q)}?${qs}` : mounted.slice(0, q));
    }
  }
  return [...new Set(out.filter((x) => typeof x === 'string'))];
}

function verifySignature(req) {
  const inbound = secrets.read(INBOUND_SECRET_VAR);
  if (inbound.problem) {
    return { ok: false, status: 503, error: `The integration API is not configured: ${inbound.problem}` };
  }
  const secret = inbound.value;
  if (!secret) {
    /* Refused, never waved through. A missing secret is a deployment that has
       not been configured, and treating it as "no signature required" would
       turn a setup mistake into an open door — quietly, and only on the
       deployment where it matters. */
    return { ok: false, status: 503, error: `The integration API is not configured: ${INBOUND_SECRET_VAR} is not set on this server.` };
  }
  const header = req.get(SIGNATURE_HEADER);
  if (!header) return { ok: false, status: 401, error: `Missing ${SIGNATURE_HEADER}.` };

  const parts = parseSignature(header);
  const t = Number(parts.t);
  if (!Number.isFinite(t)) {
    return { ok: false, status: 401, error: `${SIGNATURE_HEADER} has no usable timestamp. Expected "t=<unix seconds>, v1=<hex>".` };
  }
  if (!parts.v1) {
    return { ok: false, status: 401, error: `${SIGNATURE_HEADER} carries no v1 signature.` };
  }

  // Checked BEFORE the HMAC: an expired signature is refused without spending
  // the comparison, and both directions matter — a timestamp far in the future
  // is as much a replay as one far in the past.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (skew > MAX_SKEW_SECONDS) {
    return {
      ok: false,
      status: 401,
      error: `That request is ${skew} seconds out of date (the limit is ${MAX_SKEW_SECONDS}). `
        + 'Check the clock on the calling machine.',
    };
  }

  const raw = req.rawBody === undefined || req.rawBody === null ? '' : String(req.rawBody);
  /* INTEGRATION_INBOUND_SECRET_PREVIOUS: the secret being rotated out. While it is set,
     a request signed with either verifies, so the two ends can switch at different
     moments without a window where every call fails. Remove it once the caller has
     moved to the new secret. */
  const prev = secrets.read(`${INBOUND_SECRET_VAR}_PREVIOUS`);
  const keys = [secret, prev.value && prev.value !== secret ? prev.value : null].filter(Boolean);
  const targets = canonicalTargets(req);
  for (const key of keys) {
    for (const target of targets) {
      const expected = crypto.createHmac('sha256', key).update(signingPayload(t, req.method, target, raw)).digest('hex');
      if (safeEqualHex(parts.v1, expected)) return { ok: true, t };
    }
  }
  return {
    ok: false,
    status: 401,
    error: 'The request signature does not match.',
    // For the server log only: nothing here is a secret or a signature.
    mismatch: {
      method: String(req.method).toUpperCase(),
      // As received, so it can be set beside the line Dev & QA logs for the same call.
      path: targets[0].split('?')[0],
      queryNames: [...new URLSearchParams((targets[0].split('?')[1]) || '').keys()],
      ageSeconds: Math.floor(Date.now() / 1000) - t,
      bodyBytes: Buffer.byteLength(raw, 'utf8'),
      receivedLength: String(parts.v1).length,
      expectedLength: 64,
      fingerprint: inbound.fingerprint,
      previousFingerprint: prev.fingerprint,
      targetsTried: targets.length,
    },
  };
}

/* One line in the log for a refused signature, with everything that helps and nothing
   that is secret: never the signature received or expected, the secret or the key.
   Whether the API key itself is recognised is looked up here too, so a bad key and a
   bad signature are never confused (the caller is told only "does not match"). */
async function logMismatch(req, m) {
  let keyState = 'not sent';
  const presented = req.get(KEY_HEADER);
  if (presented) {
    const { rows } = await db.query(
      `SELECT \`name\`, is_active, (key_hash = $1) AS isCurrent FROM integration_clients
        WHERE key_hash = $1 OR (prev_key_hash = $1 AND prev_key_expires_at > NOW()) ORDER BY isCurrent DESC LIMIT 1`,
      [sha256Hex(presented)]
    ).catch(() => ({ rows: null }));
    keyState = rows === null ? 'could not be checked'
      : !rows.length ? 'not recognised'
        : !Number(rows[0].is_active) ? `revoked (${rows[0].name})`
          : `recognised (${rows[0].name}${Number(rows[0].isCurrent) ? '' : ', previous key'})`;
  }
  console.warn(`[service-auth] signature mismatch: ${m.method} ${m.path} `
    + `(query: ${m.queryNames.length ? m.queryNames.join(', ') : 'none'}; body ${m.bodyBytes} bytes; signed ${m.ageSeconds}s ago; `
    + `received signature ${m.receivedLength} hex chars, expected ${m.expectedLength}; ${m.targetsTried} target form(s) tried). `
    + `Inbound signing key ${m.fingerprint}${m.previousFingerprint ? `, previous ${m.previousFingerprint}` : ''}; API key ${keyState}. `
    + 'If Dev & QA logs a different signing key fingerprint, the two secrets differ.');
}

/* The action this request is making: the first path segment under
   /api/integration. POST /api/integration/assets/123 is the action "assets".
   Predictable from the URL, so whoever issues a credential can write its
   allowed_actions without reading this file. A route wanting something finer
   declares it with requireAction() below. */
function actionOf(req) {
  const path = (req.path || '/').replace(/^\/+/, '');
  const first = path.split('/')[0] || '';
  return first.toLowerCase();
}

const parseActions = (csv) => String(csv || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

async function serviceAuth(req, res, next) {
  try {
    const signature = verifySignature(req);
    if (!signature.ok) {
      if (signature.mismatch) await logMismatch(req, signature.mismatch).catch(() => {});
      return refuse(res, signature.status, signature.error);
    }

    const presented = req.get(KEY_HEADER);
    if (!presented) return refuse(res, 401, `Missing ${KEY_HEADER}.`);

    /* One indexed read on the hash of what was presented, against EITHER the current key
       or a previous one still inside its rotation window. The key itself is never stored,
       so a hash lookup is the only way to find the row.
       
       THE OVERLAP EXISTS SO A ROTATION IS NOT AN OUTAGE. A caller cannot be handed a new
       key and start using it in the same instant the old one dies, so for 24 hours after a
       rotation both work. The window closes on `prev_key_expires_at > NOW()` — strictly in
       the future, so at the instant it expires the old key is already dead. Generous in
       the other direction would keep a withdrawn credential alive a second longer on a
       boundary nobody can observe.
       
       NOW() is the database's clock, deliberately: the expiry was written by the same
       clock when the key was rotated, so comparing them there cannot disagree with itself
       the way a comparison against this process's clock could. */
    const { rows } = await db.query(
      `SELECT id, \`name\`, allowed_actions, is_active,
              (key_hash = $1) AS isCurrentKey
         FROM integration_clients
        WHERE key_hash = $1
           OR (prev_key_hash = $1 AND prev_key_expires_at > NOW())
        ORDER BY isCurrentKey DESC
        LIMIT 1`,
      [sha256Hex(presented)]
    );

    /* An unknown key and a deactivated one answer the SAME sentence. Telling
       them apart would let anybody enumerate which credentials this studio has
       issued by watching which of two messages comes back. */
    const client = rows[0];
    if (!client || !Number(client.is_active)) {
      return refuse(res, 401, 'That integration key is not recognised.');
    }

    const allowed = parseActions(client.allowed_actions);
    const action = actionOf(req);
    if (!allowed.includes(action)) {
      return refuse(res, 403,
        `This integration key is not allowed to "${action}".`,
        { action, allowed });
    }

    req.integration = {
      id: client.id,
      name: client.name,
      action,
      allowedActions: allowed,
      signedAt: signature.t,
      /* Which key got them in. Carried so a caller can be told it is on a key that is
         about to stop working, and so the log can show a rotation nobody finished — an
         integration still presenting its previous key on hour 23 is about to break. */
      usedPreviousKey: !Number(client.isCurrentKey),
    };

    /* THE ACTIVITY LOG'S ACTOR, and it has to be an OBJECT.
     *
     * src/activity.js reads actor.name, actor.id, actor.email and actor.role
     * off whatever it is given. A bare string there is not an error — it simply
     * has no .name, so the entry records a NULL actor, which is exactly the
     * blank line this call exists to prevent. The name is what a person reads
     * in the log; the id ties the entry back to the credential that made it,
     * which is what makes a revoked key's history findable. */
    if (typeof req.activity === 'function') {
      req.activity({ actor: { id: client.id, name: `integration:${client.name}`, role: 'integration' } });
    }

    /* Last used, recorded but never awaited. Whether this request worked is not
       contingent on a bookkeeping write, and holding the handler open for one
       would make every integration call slower for nothing. */
    db.query('UPDATE integration_clients SET last_used_at = NOW() WHERE id = $1', [client.id])
      .catch((err) => console.warn(`[service-auth] could not stamp last_used_at: ${err.sqlMessage || err.message}`));

    return next();
  } catch (err) {
    return next(err);
  }
}

/* For a route that means something narrower than its first path segment. Used
   AFTER serviceAuth, which has already established the credential. */
function requireAction(key) {
  const wanted = String(key).toLowerCase();
  return (req, res, next) => {
    if (!req.integration) return refuse(res, 401, 'Not an authenticated integration request.');
    if (!req.integration.allowedActions.includes(wanted)) {
      return refuse(res, 403, `This integration key is not allowed to "${wanted}".`,
        { action: wanted, allowed: req.integration.allowedActions });
    }
    req.integration.action = wanted;
    return next();
  };
}

module.exports = {
  serviceAuth, requireAction,
  MAX_SKEW_SECONDS, INBOUND_SECRET_VAR, KEY_HEADER, SIGNATURE_HEADER,
  sha256Hex, signingPayload, parseSignature, safeEqualHex, canonicalTargets, verifySignature,
};
