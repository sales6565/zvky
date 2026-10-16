/* The office gateway talking to Forge. Three endpoints, all machine-to-machine.
 *
 * NO SESSION, NO COOKIE, NO USER. These are called by a process on an office
 * machine, so they are authenticated by an HMAC over the request — the same
 * scheme src/middleware/service-auth.js already runs for the Dev & QA
 * integration, with the same five-minute skew window and the same support for a
 * previous secret during a rotation. The primitives are imported from that
 * module rather than restated, so the two cannot drift.
 *
 * WHY THE GATEWAY CALLS US AND NEVER THE REVERSE. Forge is on shared hosting;
 * the gateway is on a LAN behind a firewall that will never be opened. Every
 * connection is therefore outbound from the office, which is what lets the
 * studio keep hard rule 3 — never port-forward the gateway — at no cost.
 *
 * AND NOTHING HERE ACCEPTS A FILE. The callbacks carry a path, a size and a
 * checksum: facts ABOUT bytes that are already on the office server. A body
 * larger than a few kilobytes is refused by the parser these mount behind.
 */
const crypto = require('node:crypto');
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const serviceAuth = require('../middleware/service-auth');
const serverSettings = require('../server-settings');

const ID_HEADER = 'x-gateway-id';
const SIGNATURE_HEADER = 'x-gateway-signature';

/* Verify, and say which of the four things is wrong in the server log without
   saying anything useful to the caller. A gateway whose secret is wrong and a
   gateway whose clock is wrong are different problems with different fixes, and
   IT will be reading this log. */
function verify(req) {
  if (!serverSettings.isLoaded()) return { ok: false, status: 503, error: 'The Server feature is not configured.' };
  const id = String(req.get(ID_HEADER) || '').trim();
  const settings = serverSettings.current();
  if (!settings.gatewayId) return { ok: false, status: 409, error: 'No gateway has been configured.', log: 'no gateway id is set in Settings' };
  if (!id || id !== settings.gatewayId) {
    return { ok: false, status: 403, error: 'Unknown gateway.', log: `gateway id "${id || '(none)'}" is not the configured one` };
  }
  const secrets = serverSettings.gatewaySecrets();
  if (!secrets.length) {
    return { ok: false, status: 409, error: 'No gateway secret has been generated.', log: 'no gateway secret is stored, or it cannot be decrypted' };
  }
  const header = req.get(SIGNATURE_HEADER);
  if (!header) return { ok: false, status: 401, error: 'Missing signature.', log: `${SIGNATURE_HEADER} was not sent` };
  const parts = serviceAuth.parseSignature(header);
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) {
    return { ok: false, status: 401, error: 'Malformed signature.', log: 'the signature header has no usable t= or v1=' };
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (skew > serviceAuth.MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, error: 'That request is out of date.',
      log: `the request is ${skew}s out of date (limit ${serviceAuth.MAX_SKEW_SECONDS}) — check the clock on the gateway machine` };
  }
  const raw = req.rawBody === undefined || req.rawBody === null ? '' : String(req.rawBody);
  /* The target is the path the gateway signed: its own API path, without the
     query. Signed and compared in one form only — the gateway is our own
     software on a machine we configured, so the several forms service-auth
     tolerates for a third party are not needed here, and fewer accepted forms
     is a smaller surface. */
  const target = String(req.originalUrl || '').split('?')[0];
  for (const secret of secrets) {
    const expected = crypto.createHmac('sha256', secret)
      .update(serviceAuth.signingPayload(t, req.method, target, raw)).digest('hex');
    if (serviceAuth.safeEqualHex(parts.v1, expected)) return { ok: true, t };
  }
  return { ok: false, status: 401, error: 'The request signature does not match.',
    log: `signature mismatch on ${req.method} ${target} (${raw.length} body bytes, ${secrets.length} secret(s) tried)` };
}

function gate(req, res, next) {
  const v = verify(req);
  if (v.ok) return next();
  if (v.log) console.warn(`[gateway] refused ${req.method} ${req.originalUrl}: ${v.log}`);
  return res.status(v.status).json({ error: v.error });
}

/* GET /api/gateway/config — the settings half the gateway pulls.
 *
 * Deliberately readable with the feature switched OFF. A gateway that is
 * running while an admin has the switch off should still be able to fetch
 * configuration, see an empty key list, and refuse every browser request
 * itself; making the config endpoint 409 as well would only mean the gateway
 * kept serving last week's keys from its cache. */
router.get('/config', gate, async (req, res) => {
  const config = serverSettings.gatewayConfig();
  res.json({
    ...config,
    // With the tab off, no key is published: the gateway then verifies nothing
    // and every browser request to it fails closed on its own side too.
    keys: serverSettings.serverEnabled() ? config.keys : [],
    enabled: serverSettings.serverEnabled(),
  });
});

router.post('/heartbeat', gate, async (req, res) => {
  const b = req.body || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  await db.query(
    `UPDATE gateway_state SET last_seen = NOW(), version = $1, free_bytes = $2,
            config_version = $3, queued = $4, remote_ip = $5, clock_skew_seconds = $6,
            file_root = $7
      WHERE id = 1`,
    [String(b.version || '').slice(0, 32) || null, num(b.freeBytes), num(b.configVersion), num(b.queued),
      String(req.ip || '').slice(0, 64) || null, num(b.clockSkewSeconds),
      String(b.fileRoot || '').slice(0, 500) || null]
  ).catch(async (err) => {
    /* An install part-way through its migration has the row without the
       column. The heartbeat is the one call that must never fail for a schema
       detail: a gateway that cannot say it is alive looks dead. */
    if (err && err.code === 'ER_BAD_FIELD_ERROR') {
      await db.query(
        `UPDATE gateway_state SET last_seen = NOW(), version = $1, free_bytes = $2,
                config_version = $3, queued = $4, remote_ip = $5 WHERE id = 1`,
        [String(b.version || '').slice(0, 32) || null, num(b.freeBytes), num(b.configVersion), num(b.queued),
          String(req.ip || '').slice(0, 64) || null]
      );
      return;
    }
    throw err;
  });
  res.json({
    ok: true,
    // So a gateway can notice it is behind without waiting for the next pull.
    configVersion: serverSettings.current().configVersion,
    enabled: serverSettings.serverEnabled(),
    /* FORGE'S OWN CLOCK, which is the only one that matters: it is what signed
       the token the gateway is about to verify. The gateway computes the
       difference and reports it on the next beat. */
    now: new Date().toISOString(),
  });
});

/* POST /api/gateway/callback — something happened on the office server.
 *
 * IDEMPOTENT BY THE GATEWAY'S OWN ID. The gateway's queue is at-least-once by
 * design (it would rather send a callback twice than lose one), so the same id
 * arriving again must be the same row. That is enforced by the unique key on
 * server_events.external_id rather than by a read-then-write, so two deliveries
 * racing cannot both insert.
 */
const KINDS = new Set(['upload_completed', 'checksum_ready', 'folder_created']);

router.post('/callback', gate, async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!KINDS.has(kind)) {
    // 400, which the gateway treats as permanent and drops: a callback we do
    // not understand will not become understandable by being retried.
    return res.status(400).json({ error: `"${kind}" is not a callback this server takes.` });
  }
  const id = String(b.id || '').slice(0, 64);
  if (!id) return res.status(400).json({ error: 'That callback has no id.' });

  const path = b.path === undefined || b.path === null ? null : String(b.path).slice(0, 1000);
  const size = Number.isFinite(Number(b.size)) ? Math.floor(Number(b.size)) : null;
  const sha = /^[0-9a-f]{64}$/i.test(String(b.sha256 || '')) ? String(b.sha256).toLowerCase() : null;
  const userId = b.userId ? String(b.userId).slice(0, 36) : null;

  /* A callback naming a user this studio does not have is refused permanently
     rather than stored with a dangling id: it means the gateway is talking to
     the wrong Forge, which is worth a line in the log. */
  if (userId) {
    const { rows } = await db.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (!rows.length) {
      console.warn(`[gateway] callback ${kind} named user ${userId}, who is not in this database`);
      return res.status(400).json({ error: 'That callback names a user this server does not have.' });
    }
    b.userEmail = rows[0].email;
  }

  const action = kind === 'upload_completed' ? 'upload_completed'
    : (kind === 'checksum_ready' ? 'checksum' : 'folder_created');

  try {
    await db.query(
      `INSERT INTO server_events (id, user_id, user_email, action, path, size, sha256, ip, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [crypto.randomUUID(), userId, b.userEmail || null, action, path, size, sha,
        String(req.ip || '').slice(0, 64) || null, `${kind}:${id}`]
    );
  } catch (err) {
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      // Already recorded. 200, because the gateway did its job and should stop
      // retrying — the point of an idempotent endpoint is that a duplicate is
      // a success, not an error to queue behind.
      return res.json({ ok: true, duplicate: true });
    }
    throw err;
  }
  res.json({ ok: true });
});

module.exports = router;
module.exports.verify = verify;
module.exports.ID_HEADER = ID_HEADER;
module.exports.SIGNATURE_HEADER = SIGNATURE_HEADER;
module.exports.KINDS = KINDS;
