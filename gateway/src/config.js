/* Two kinds of configuration, and the line between them is the point.
 *
 * LOCAL, set by IT on this machine, in the environment or an .env beside the
 * package: where the share is, which interface to listen on, the TLS files,
 * which Forge to talk to, and this gateway's id and secret. None of it is
 * guessable from Forge and none of it changes without somebody being at the
 * machine.
 *
 * PULLED, set by the Super Admin in Forge: size and chunk limits, extension
 * rules, the shared folder names, and the public keys that verify tokens. These
 * are settings a studio changes on a Tuesday afternoon, so they live where the
 * Settings page is and arrive here over the signed channel.
 *
 * AND THE CACHE. The pulled half is written to disk after every successful
 * fetch and read back at start-up, so a gateway that boots while the hosting is
 * down, or loses Forge at 2pm, keeps serving the studio on the last good
 * answer instead of refusing everybody. The alternative — refuse until Forge
 * returns — makes a GoDaddy outage into a "nobody can open a file" outage,
 * which is exactly the dependency this architecture exists to avoid.
 */
const fs = require('node:fs');
const path = require('node:path');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* What a gateway falls back to with no cache and no Forge: the documented
   defaults, and an EMPTY key list — so it serves nothing until Forge has been
   reached once. Limits can have sensible defaults; "who may do this" cannot. */
const DEFAULTS = {
  version: 0,
  maxFileBytes: 50 * 1024 * 1024 * 1024,
  chunkBytes: 32 * 1024 * 1024,
  parallelChunks: 3,
  deniedExtensions: ['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1',
    '.vbs', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.dll', '.lnk',
    '.reg', '.jar', '.app', '.sh'],
  allowedExtensions: [],      // empty = everything not denied
  sharedFolders: [],
  incomingMaxAgeMinutes: 24 * 60,
  keys: [],
};

function local(env = process.env) {
  const missing = [];
  const need = (name) => {
    const v = env[name] === undefined || env[name] === null ? '' : String(env[name]).trim();
    if (!v) missing.push(name);
    return v;
  };
  const cfg = {
    fileRoot: need('FILE_ROOT'),
    listenAddress: (env.LISTEN_ADDRESS || '').trim(),
    listenPort: num(env.LISTEN_PORT, 8443),
    tlsCert: need('TLS_CERT'),
    tlsKey: need('TLS_KEY'),
    forgeUrl: need('FORGE_URL'),
    gatewayId: need('GATEWAY_ID'),
    gatewaySecret: need('GATEWAY_SECRET'),
    stateDir: (env.STATE_DIR || '').trim() || path.join(__dirname, '..', 'state'),
    heartbeatSeconds: num(env.HEARTBEAT_SECONDS, 30),
    configSeconds: num(env.CONFIG_SECONDS, 300),
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 600),
    /* Clock-skew leeway on a token's expiry, hard-capped in
       gateway/src/tokens.js. The cap is why this is read here and clamped
       there rather than trusted. */
    clockLeewaySeconds: num(env.CLOCK_LEEWAY_SECONDS, 30),
  };
  /* LISTEN_ADDRESS is required in spirit but not in form: binding to the LAN
     interface is the rule, and a gateway with no address given would bind every
     interface — including, on a machine someone has port-forwarded, the public
     one. So an empty value is a hard stop with the reason spelled out rather
     than a default of 0.0.0.0. */
  if (!cfg.listenAddress) missing.push('LISTEN_ADDRESS (the LAN address to bind — never 0.0.0.0)');
  if (/^0\.0\.0\.0$|^::$/.test(cfg.listenAddress)) {
    missing.push('LISTEN_ADDRESS must be the machine\'s LAN address, not 0.0.0.0 — see gateway/README.md');
  }
  return { ...cfg, missing };
}

const cacheFile = (stateDir) => path.join(stateDir, 'config.json');

function readCache(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(stateDir), 'utf8'));
    return { ...DEFAULTS, ...raw, cached: true };
  } catch { return null; }
}

function writeCache(stateDir, pulled) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${cacheFile(stateDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pulled, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile(stateDir));
    return true;
  } catch { return false; }
}

/* Shape whatever Forge sent into the fields this package reads, so a new field
   on the Forge side cannot change behaviour here until this function is taught
   about it — and a MISSING field falls back to the documented default rather
   than to undefined. */
function shape(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (v, fallback) => (Array.isArray(v) ? v.map((s) => String(s)) : fallback);
  const exts = (v, fallback) => list(v, fallback).map((s) => {
    const t = String(s).trim().toLowerCase();
    return t && !t.startsWith('.') ? `.${t}` : t;
  }).filter(Boolean);
  return {
    version: num(r.version, 0),
    maxFileBytes: num(r.maxFileBytes, DEFAULTS.maxFileBytes),
    chunkBytes: num(r.chunkBytes, DEFAULTS.chunkBytes),
    parallelChunks: num(r.parallelChunks, DEFAULTS.parallelChunks),
    deniedExtensions: exts(r.deniedExtensions, DEFAULTS.deniedExtensions),
    allowedExtensions: exts(r.allowedExtensions, DEFAULTS.allowedExtensions),
    sharedFolders: list(r.sharedFolders, DEFAULTS.sharedFolders),
    incomingMaxAgeMinutes: num(r.incomingMaxAgeMinutes, DEFAULTS.incomingMaxAgeMinutes),
    keys: (Array.isArray(r.keys) ? r.keys : [])
      .filter((k) => k && k.publicKey)
      .map((k) => ({ kid: k.kid ? String(k.kid) : null, publicKey: String(k.publicKey) })),
    fetchedAt: new Date().toISOString(),
  };
}

/* Does this file name pass the studio's extension rules?
 *
 * Deny first, then allow: a studio that lists allowed extensions still does not
 * get to allow .exe by typing it in both boxes. The denied list is the security
 * rule and the allowed list is a studio preference, so they are not symmetric. */
function extensionAllowed(name, cfg) {
  const ext = (String(name || '').match(/\.[^.\\/]*$/) || [''])[0].toLowerCase();
  const denied = cfg.deniedExtensions || [];
  const allowed = cfg.allowedExtensions || [];
  if (denied.includes(ext)) return { ok: false, reason: `${ext || 'That kind of file'} is not allowed on the file server.` };
  if (allowed.length && !allowed.includes(ext)) {
    return { ok: false, reason: `Only ${allowed.join(', ')} may be uploaded to the file server.` };
  }
  return { ok: true, ext };
}

module.exports = { local, DEFAULTS, shape, readCache, writeCache, cacheFile, extensionAllowed };
