// The gate: no request reaches the application unless its address is allowed.
//
// It runs ahead of authentication on purpose. Checking after authentication
// would mean a blocked address could still reach the login endpoint and try
// passwords, which is most of what the restriction is for.
//
// Running first also means a wrong allowlist locks out everyone, Super Admin
// included — the entry needed to fix it sits behind the gate it broke. So the
// ways back in deliberately do NOT live in the database:
//
//   IP_ALLOWLIST_ENABLED=false     turn the gate off entirely
//   IP_ALLOWLIST_MODE=monitor      log what would be blocked, block nothing
//   IP_ALLOWLIST_EMERGENCY=<list>  addresses allowed regardless of the database
//   IP_ALLOWLIST_BYPASS_TOKEN=<s>  a request carrying this passes regardless
//   (an empty allowlist)           treated as "not configured", so open
//
// Each of those is a server-level change by whoever can reach the environment,
// which is the person who would be fixing a lockout. Every use is logged.
//
// If the allowlist tables cannot be read at all, the gate opens rather than
// closes — closing would lock out the one person who could fix it. That is the
// safe failure, but it is not a quiet one: it is announced at startup, repeated
// in the log while it lasts, and stated on the management screen. A studio that
// believes it is restricted when it is not is worse off than one that knows it
// is open. IP_ALLOWLIST_FAIL_CLOSED=true reverses the choice for a deployment
// that would rather be unreachable than unrestricted, and is refused unless an
// emergency address or bypass token exists to get back in with.

const ipMatch = require('../ip-match');
const allowlist = require('../ip-allowlist');

// Paths the gate never blocks.
//
// The platform health check. If the host cannot reach it the deployment is
// marked unhealthy and restarted, which turns a misconfigured allowlist into an
// outage loop. It exposes no studio data — whether the database is reachable
// and whether any account exists — and the alternative is worse.
const ALWAYS_ALLOWED = ['/api/health'];

// Addresses the gate never blocks either, which matters more than the path list
// above: this deployment's health probe is a plain `GET /` from inside the
// container, not a request to a health path. Blocking it failed the deploy and
// production was rolled back.
//
// A request whose client address is loopback came from inside the container —
// the platform itself. It cannot be a remote visitor: with a proxy in front,
// the address judged here is the one that proxy wrote, so nobody outside can
// arrange to look like 127.0.0.1. Turn it off with
// IP_ALLOWLIST_ALLOW_LOOPBACK=false if this app is reachable directly.
const LOOPBACK = ['127.0.0.0/8', '::1'];

// Some platforms probe from the container network rather than loopback. Off by
// default because a private range is a much larger surface than loopback; set
// IP_ALLOWLIST_ALLOW_PRIVATE=true if health checks arrive from one of these.
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

function config() {
  return {
    enabled: String(process.env.IP_ALLOWLIST_ENABLED ?? 'true').toLowerCase() !== 'false',
    // 'enforce' blocks; 'monitor' logs what it would have blocked and lets it
    // through.
    //
    // Monitor is the default, and enforcing takes the exact word "enforce".
    // The address this app sees for you is not always the address you think you
    // have, and a seeded list that turns out to hold the wrong one locks
    // everybody out of production the moment it is switched on. Confirm the
    // address on Settings -> Allowed IP Addresses first, then set
    // IP_ALLOWLIST_MODE=enforce.
    mode: String(process.env.IP_ALLOWLIST_MODE || 'monitor').toLowerCase() === 'enforce' ? 'enforce' : 'monitor',
    emergency: String(process.env.IP_ALLOWLIST_EMERGENCY || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    bypassToken: process.env.IP_ALLOWLIST_BYPASS_TOKEN || null,
    allowLoopback: String(process.env.IP_ALLOWLIST_ALLOW_LOOPBACK ?? 'true').toLowerCase() !== 'false',
    allowPrivate: String(process.env.IP_ALLOWLIST_ALLOW_PRIVATE || 'false').toLowerCase() === 'true',
    // Refuse traffic if the allowlist storage is unreadable, rather than
    // passing it. Off by default: the default has to be the one that cannot
    // strand a Super Admin behind a gate they cannot open.
    failClosed: String(process.env.IP_ALLOWLIST_FAIL_CLOSED || 'false').toLowerCase() === 'true',
  };
}

// Fail-closed is only honoured when there is a way back in that does not go
// through the database — otherwise it turns a storage fault into a total
// outage with no remedy, which is the exact thing the escape hatches exist to
// prevent.
function failClosedIsSafe(settings) {
  return settings.failClosed && (settings.emergency.length > 0 || Boolean(settings.bypassToken));
}

// The address to judge. Express resolves this from X-Forwarded-For according to
// the `trust proxy` hop count set in server.js, which is what stops a client
// inventing a header: with one proxy in front, Express takes the entry that
// proxy wrote, and anything the client prepended sits further left and is
// ignored. Get the hop count wrong and that protection goes with it, which is
// why it is a setting rather than a guess.
function clientIP(req) {
  return ipMatch.normalise(req.ip) || req.ip || null;
}

// Deny politely: a page for a browser, JSON for anything else. It names the
// address, because the person reading it needs to know what to allowlist, and
// nothing else about the system.
function deny(req, res, ip, reason = 'not-allowed') {
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  const unavailable = reason === 'unavailable';
  const headline = unavailable ? 'Access temporarily unavailable' : 'Access denied';
  const explain = unavailable
    ? 'This application cannot currently check whether your address is permitted, and is configured to refuse rather than allow while that is true. An administrator has been shown the reason in the server log.'
    : 'This application only accepts connections from approved networks, and this one is not on the list.';
  res.status(403);
  if (!wantsHtml) {
    return res.json({
      error: unavailable
        ? 'Access denied: the address allowlist cannot be read, and this server is configured to refuse traffic while that is true.'
        : 'Access denied: this address is not permitted to reach this application.',
      yourAddress: ip,
      reason,
    });
  }
  return res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${headline}</title>
<style>
  :root{color-scheme:dark;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0d0e12;color:#e8eaed;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;}
  .card{max-width:460px;background:#15171d;border:1px solid #262a33;border-radius:14px;padding:30px;}
  h1{margin:0 0 10px;font-size:19px;}
  p{margin:0 0 14px;font-size:14px;line-height:1.55;color:#9aa1ad;}
  .ip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;color:#e8eaed;
      background:#0d0e12;border:1px solid #262a33;border-radius:8px;padding:9px 12px;display:inline-block;}
  .mark{width:34px;height:34px;border-radius:9px;background:#ff5a36;display:flex;align-items:center;
        justify-content:center;font-weight:700;margin-bottom:16px;}
</style></head>
<body><div class="card">
  <div class="mark">Z</div>
  <h1>${headline}</h1>
  <p>${explain}</p>
  <p>Your address:</p>
  <p><span class="ip">${String(ip || 'unknown').replace(/[<>&"]/g, '')}</span></p>
  <p>If you should have access, pass that address to an administrator to add it.</p>
</div></body></html>`);
}

// Denials are noisy by nature — a scanner can generate thousands. Log the first
// few per address per window in full and count the rest, so the log stays
// readable without losing the fact that it happened.
const seen = new Map();
const LOG_WINDOW_MS = 10 * 60 * 1000;
const LOG_LIMIT = 3;

function noteDenial(ip, path) {
  const now = Date.now();
  const record = seen.get(ip);
  if (!record || now - record.since > LOG_WINDOW_MS) {
    seen.set(ip, { since: now, count: 1 });
    console.warn(`[ip-allowlist] denied ${ip} -> ${path}`);
    return;
  }
  record.count++;
  if (record.count <= LOG_LIMIT) {
    console.warn(`[ip-allowlist] denied ${ip} -> ${path}`);
  } else if (record.count === LOG_LIMIT + 1) {
    console.warn(`[ip-allowlist] denied ${ip} repeatedly; further denials from it will be counted, not logged`);
  }
  // Keep the map from growing without bound under a scan.
  if (seen.size > 5000) seen.clear();
}

// A storage fault is a standing condition, not an event: it will be true for
// every request until someone fixes it. Say so on the first request and then
// every ten minutes, which is often enough to be noticed in a log and rare
// enough not to bury it.
let lastStorageWarning = 0;
const STORAGE_WARNING_INTERVAL_MS = 10 * 60 * 1000;

function noteStorageFault(status) {
  const now = Date.now();
  if (now - lastStorageWarning < STORAGE_WARNING_INTERVAL_MS) return;
  lastStorageWarning = now;
  const what = status.state === 'missing-tables'
    ? 'the ip_allowlist tables do not exist'
    : 'the ip_allowlist tables could not be read';
  console.error(
    `[ip-allowlist] NOT ENFORCING: ${what} (${status.code || 'error'}: ${status.detail}). ` +
    'Every address can currently reach this app. Open Settings -> Allowed IP Addresses to repair, ' +
    'or see the startup log for the fix.'
  );
}

function middleware(req, res, next) {
  const settings = config();
  const ip = clientIP(req);
  req.clientIp = ip; // the rest of the app reports this back to the caller

  if (ALWAYS_ALLOWED.includes(req.path)) return next();

  // Before anything else, including fail-closed: the deployment's own health
  // probe has to succeed or the platform kills the release. See LOOPBACK above.
  if (settings.allowLoopback && ipMatch.findMatch(ip, LOOPBACK)) {
    req.ipAllowlist = { decision: 'loopback' };
    return next();
  }
  if (settings.allowPrivate && ipMatch.findMatch(ip, PRIVATE)) {
    req.ipAllowlist = { decision: 'private-network' };
    return next();
  }

  if (!settings.enabled) {
    req.ipAllowlist = { decision: 'disabled' };
    return next();
  }

  // A token in the environment, presented on the request. For getting back in
  // when the list is wrong and nobody's address is on it.
  if (settings.bypassToken) {
    const presented = req.get('x-allowlist-bypass') || req.query.bypass;
    if (typeof presented === 'string' && presented.length === settings.bypassToken.length) {
      const a = Buffer.from(presented);
      const b = Buffer.from(settings.bypassToken);
      if (require('node:crypto').timingSafeEqual(a, b)) {
        console.warn(`[ip-allowlist] BYPASS TOKEN USED by ${ip} -> ${req.method} ${req.path}`);
        req.ipAllowlist = { decision: 'bypass-token' };
        return next();
      }
    }
  }

  // Addresses allowed by the environment, never by the database. If the table
  // is wrong, these still work.
  const emergency = settings.emergency.length ? ipMatch.findMatch(ip, settings.emergency) : null;
  if (emergency) {
    console.warn(`[ip-allowlist] EMERGENCY ADDRESS USED: ${ip} matched ${emergency} -> ${req.method} ${req.path}`);
    req.ipAllowlist = { decision: 'emergency', rule: emergency };
    return next();
  }

  // The list cannot be read: the tables are missing, or the database is not
  // answering. This is not the same as an empty list, and must not be treated
  // as one — an empty list is a decision, this is a fault.
  if (!allowlist.isLoaded()) {
    const status = allowlist.storageStatus();
    noteStorageFault(status);
    if (failClosedIsSafe(settings)) {
      req.ipAllowlist = { decision: 'storage-unavailable-closed', storage: status };
      if (ALWAYS_ALLOWED.includes(req.path)) return next();
      return deny(req, res, ip, 'unavailable');
    }
    req.ipAllowlist = { decision: 'storage-unavailable', storage: status };
    return next();
  }

  // Nothing in it. The gate is not configured, and an unconfigured gate stands
  // open rather than shut.
  if (allowlist.isEmpty()) {
    req.ipAllowlist = { decision: 'unconfigured' };
    return next();
  }

  const match = allowlist.findMatch(ip);
  if (match) {
    req.ipAllowlist = { decision: 'allowed', rule: match.address };
    return next();
  }

  if (settings.mode === 'monitor') {
    console.warn(`[ip-allowlist] MONITOR: would have denied ${ip} -> ${req.method} ${req.path}`);
    req.ipAllowlist = { decision: 'would-deny' };
    return next();
  }

  noteDenial(ip, `${req.method} ${req.path}`);
  req.ipAllowlist = { decision: 'denied' };
  return deny(req, res, ip);
}

// Printed once at startup so the address this app actually sees, and the way it
// is configured, are visible before anyone is locked out by a surprise.
function describeAtStartup(log = console.log) {
  const settings = config();
  if (!settings.enabled) {
    log('[ip-allowlist] disabled (IP_ALLOWLIST_ENABLED=false). Every address may reach this app.');
    return;
  }
  if (!allowlist.isLoaded()) {
    const status = allowlist.storageStatus();
    log('[ip-allowlist] NOT ENFORCING — its storage is unavailable ' +
        `(${status.code || 'error'}: ${status.detail}).`);
    log(failClosedIsSafe(settings)
      ? '[ip-allowlist] IP_ALLOWLIST_FAIL_CLOSED is set, so traffic is being refused until this is fixed. Use the emergency address or bypass token to get in.'
      : '[ip-allowlist] Every address can currently reach this app. Repair it on Settings -> Allowed IP Addresses.');
    if (settings.failClosed && !failClosedIsSafe(settings)) {
      log('[ip-allowlist] IP_ALLOWLIST_FAIL_CLOSED was ignored: with no emergency address or bypass token it would leave nobody able to fix this.');
    }
    return;
  }
  if (allowlist.isEmpty()) {
    log('[ip-allowlist] no entries, so the gate is open. Add one in Settings to restrict access.');
  } else {
    log(`[ip-allowlist] ${settings.mode} mode, ${allowlist.entries().length} entr${allowlist.entries().length === 1 ? 'y' : 'ies'}.`);
  }
  if (settings.mode === 'monitor') {
    log('[ip-allowlist] MONITOR mode: nothing is blocked, denials are only logged.');
    log('[ip-allowlist] To start restricting access: open Settings -> Allowed IP Addresses, check the');
    log('[ip-allowlist] "You are connecting from" line matches an entry, then set IP_ALLOWLIST_MODE=enforce.');
  }
  if (!settings.allowLoopback) {
    log('[ip-allowlist] Loopback is NOT exempt (IP_ALLOWLIST_ALLOW_LOOPBACK=false). If this host health-checks the app over localhost, that probe will be refused.');
  }
  if (settings.emergency.length) log(`[ip-allowlist] ${settings.emergency.length} emergency address(es) configured in the environment.`);
  if (settings.bypassToken) log('[ip-allowlist] a bypass token is configured.');
  if (settings.mode === 'enforce' && !settings.emergency.length && !settings.bypassToken) {
    log('[ip-allowlist] no emergency address or bypass token is set. If the list is ever wrong, the only way back is the environment — consider setting one.');
  }
}

module.exports = {
  middleware, clientIP, config, failClosedIsSafe, describeAtStartup,
  ALWAYS_ALLOWED, LOOPBACK, PRIVATE,
};
