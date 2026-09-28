/* The integration gate: which addresses may reach /api/integration at all.
 *
 * IT SHIPS IN MONITOR MODE, and that is the single most important line in this
 * file. An address list that enforces on the deploy that introduces it locks
 * out the integration on the very release meant to enable it — and the address
 * this app sees for a caller is frequently not the address anyone expected,
 * because a proxy rewrote it. So the default logs what it WOULD have refused
 * and refuses nothing. Somebody reads those lines, confirms the real Dev & QA
 * address, and sets INTEGRATION_IP_ALLOWLIST_MODE=enforce deliberately, later.
 *
 * THE ESCAPE HATCHES READ THE ENVIRONMENT, never the table this gate consults —
 * the same separation src/middleware/ip-allowlist.js keeps, for the same
 * reason: a safeguard that can be edited through the thing it safeguards is not
 * a safeguard.
 *
 *   INTEGRATION_IP_ALLOWLIST_ENABLED=false     turn the gate off entirely
 *   INTEGRATION_IP_ALLOWLIST_MODE=enforce      refuse, rather than log
 *   INTEGRATION_IP_ALLOWLIST_EMERGENCY=<list>  addresses allowed regardless
 *   INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK    default true
 *   INTEGRATION_IP_ALLOWLIST_ALLOW_PRIVATE     default false
 *   (an empty list)                            "not configured", so open
 *
 * THERE IS NO FAIL-CLOSED OPTION HERE, unlike the studio's list, and that is a
 * decision rather than an omission. Fail-closed exists there so a studio may
 * choose to be unreachable rather than unrestricted. Integration traffic has a
 * second, stronger lock in front of it — a signed request and a hashed
 * credential, neither of which an address can forge — so an unreadable address
 * table is not the last thing standing between a stranger and the API.
 */

const ipMatch = require('../ip-match');
const list = require('../integration-ip-allowlist');

const LOOPBACK = ['127.0.0.0/8', '::1'];
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

function config() {
  return {
    enabled: String(process.env.INTEGRATION_IP_ALLOWLIST_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Enforcing takes the exact word. Anything else, including a typo, is
    // monitor — which is the failure direction that does not cause an outage.
    mode: String(process.env.INTEGRATION_IP_ALLOWLIST_MODE || 'monitor').toLowerCase() === 'enforce'
      ? 'enforce' : 'monitor',
    emergency: String(process.env.INTEGRATION_IP_ALLOWLIST_EMERGENCY || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowLoopback: String(process.env.INTEGRATION_IP_ALLOWLIST_ALLOW_LOOPBACK ?? 'true').toLowerCase() !== 'false',
    allowPrivate: String(process.env.INTEGRATION_IP_ALLOWLIST_ALLOW_PRIVATE || 'false').toLowerCase() === 'true',
  };
}

const clientIP = (req) => ipMatch.normalise(req.ip) || req.ip || null;

/* Denials, rate-limited in the log. A scanner finding this path would otherwise
   bury the one line that matters — which in monitor mode is the whole point of
   the mode. Copied from the studio gate's noteDenial for the same reason. */
const seen = new Map();
const LOG_WINDOW_MS = 10 * 60 * 1000;
const LOG_LIMIT = 3;

function noteDenial(ip, what, verb) {
  const now = Date.now();
  const record = seen.get(ip);
  if (!record || now - record.since > LOG_WINDOW_MS) {
    seen.set(ip, { since: now, count: 1 });
    console.warn(`[integration-ip] ${verb} ${ip} -> ${what}`);
    return;
  }
  record.count += 1;
  if (record.count <= LOG_LIMIT) console.warn(`[integration-ip] ${verb} ${ip} -> ${what}`);
  else if (record.count === LOG_LIMIT + 1) {
    console.warn(`[integration-ip] ${verb} ${ip} repeatedly; further from it will be counted, not logged`);
  }
  if (seen.size > 5000) seen.clear();
}

const deny = (res, ip) => res.status(403).json({
  error: 'This address is not allowed to reach the integration API.',
  address: ip,
});

function middleware(req, res, next) {
  const settings = config();
  const ip = clientIP(req);
  req.integrationIp = { address: ip };

  if (settings.allowLoopback && ipMatch.findMatch(ip, LOOPBACK)) {
    req.integrationIp.decision = 'loopback';
    return next();
  }
  if (settings.allowPrivate && ipMatch.findMatch(ip, PRIVATE)) {
    req.integrationIp.decision = 'private-network';
    return next();
  }
  if (!settings.enabled) {
    req.integrationIp.decision = 'disabled';
    return next();
  }

  const emergency = settings.emergency.length ? ipMatch.findMatch(ip, settings.emergency) : null;
  if (emergency) {
    console.warn(`[integration-ip] EMERGENCY ADDRESS USED: ${ip} matched ${emergency}`);
    req.integrationIp.decision = 'emergency';
    req.integrationIp.rule = emergency;
    return next();
  }

  /* The list cannot be read. Not the same as an empty list, and not treated as
     one — but it opens rather than closes, because the signature and the
     credential behind this gate are the locks that matter. */
  if (!list.isLoaded()) {
    req.integrationIp.decision = 'storage-unavailable';
    req.integrationIp.storage = list.storageStatus();
    return next();
  }

  // Nothing in it: unconfigured, and an unconfigured gate stands open.
  if (list.isEmpty()) {
    req.integrationIp.decision = 'unconfigured';
    return next();
  }

  const match = list.findMatch(ip);
  if (match) {
    req.integrationIp.decision = 'allowed';
    req.integrationIp.rule = match.address;
    return next();
  }

  if (settings.mode === 'monitor') {
    noteDenial(ip, `${req.method} ${req.originalUrl.split('?')[0]}`, 'MONITOR: would have denied');
    req.integrationIp.decision = 'would-deny';
    return next();
  }

  noteDenial(ip, `${req.method} ${req.originalUrl.split('?')[0]}`, 'denied');
  req.integrationIp.decision = 'denied';
  return deny(res, ip);
}

function describeAtStartup(log = console.log) {
  const settings = config();
  if (!settings.enabled) {
    log('[integration-ip] disabled (INTEGRATION_IP_ALLOWLIST_ENABLED=false).');
    return;
  }
  if (!list.isLoaded()) {
    const status = list.storageStatus();
    log(`[integration-ip] storage unavailable (${status.code || 'error'}: ${status.detail}). `
      + 'Integration traffic is not restricted by address.');
    return;
  }
  const n = list.entries().length;
  if (!n) {
    log('[integration-ip] no addresses configured, so the integration API is open to any address '
      + '(its signature and credential checks still apply).');
    return;
  }
  log(settings.mode === 'enforce'
    ? `[integration-ip] ENFORCING against ${n} address(es).`
    : `[integration-ip] MONITOR mode against ${n} address(es) — would-have-denied is logged, nothing is blocked. `
      + 'Set INTEGRATION_IP_ALLOWLIST_MODE=enforce once the real address is confirmed.');
}

module.exports = { middleware, describeAtStartup, config };
