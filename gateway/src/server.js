/* The listening process: TLS, CORS, rate limiting, logging, and the loops that
 * keep this gateway in touch with Forge.
 *
 * It binds the address IT gave it and nothing else. There is no 0.0.0.0 default
 * — config.js refuses to start without an explicit LAN address — because the
 * one failure that would turn this from an office appliance into an internet
 * file server is a gateway listening everywhere on a machine somebody has
 * port-forwarded.
 */
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const router = require('./router');
const config = require('./config');
const tokens = require('./tokens');
const uploads = require('./uploads');
const deleter = require('./deleter');
const forge = require('./forge');
const paths = require('./paths');

const redact = forge.redact;

/* Requests per minute per address. Generous, because a single upload of a large
   file is hundreds of chunk requests in a minute and the studio is one office
   behind one address — this is here to stop a loop, not to ration work. */
function rateLimiter(perMinute) {
  const seen = new Map();
  return function allow(ip, now = Date.now()) {
    const windowStart = Math.floor(now / 60000) * 60000;
    const rec = seen.get(ip);
    if (!rec || rec.window !== windowStart) { seen.set(ip, { window: windowStart, n: 1 }); return true; }
    rec.n += 1;
    if (seen.size > 5000) for (const [k, v] of seen) if (v.window !== windowStart) seen.delete(k);
    return rec.n <= perMinute;
  };
}

function auditLogger(stateDir, log) {
  const file = path.join(stateDir, 'audit.log');
  return function audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(file, `${redact(line)}\n`);
    } catch (err) { log(`gateway: could not write the audit log: ${err.code || err.message}`); }
  };
}

function readBytes(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const stop = (out) => { if (!settled) { settled = true; resolve(out); } };
    req.on('data', (c) => {
      total += c.length;
      if (total > max) {
        /* Destroyed rather than drained: a caller sending more than the chunk
           size has either a bug or an intention, and reading the rest to be
           polite is how a gateway runs out of memory. */
        req.destroy();
        stop({ ok: false, status: 413, reason: `That chunk is larger than the ${max} byte limit.` });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => stop({ ok: true, value: Buffer.concat(chunks) }));
    req.on('error', () => stop({ ok: false, status: 400, reason: 'That upload was interrupted.' }));
  });
}

async function readJson(req) {
  const raw = await readBytes(req, 256 * 1024);
  if (!raw.ok) return raw;
  if (!raw.value.length) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.value.toString('utf8')) }; }
  catch { return { ok: false, reason: 'That request body is not valid JSON.' }; }
}

/* Serving a file: as an attachment, with Range, and never as something a
 * browser will run.
 *
 * application/octet-stream plus nosniff plus an attachment disposition, for
 * every file regardless of extension. The share holds .psd and .aep and also
 * whatever somebody once put there, and a studio file server is not a place to
 * discover that an .html or .svg in a project folder can run script on the
 * gateway's origin. */
function sendFile(req, res, full, stat, filename) {
  const headers = {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"; `
      + `filename*=UTF-8''${encodeURIComponent(filename)}`,
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const range = String(req.headers.range || '');
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end !== null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
    if (start === null) start = 0;
    if (end === null || end > stat.size - 1) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      return res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  return fs.createReadStream(full).pipe(res);
}

function create({ local, log = console.log, fetchImpl, now = () => Date.now() } = {}) {
  const forgeOrigin = (() => {
    try { return new URL(local.forgeUrl).origin; } catch { return ''; }
  })();
  const client = forge.client({ local, fetchImpl, now, log });
  const audit = auditLogger(local.stateDir, log);
  const allow = rateLimiter(local.rateLimitPerMinute);
  const jtiStore = new tokens.JtiStore();

  let current = config.readCache(local.stateDir) || { ...config.DEFAULTS, cached: false };
  let lastPull = null;

  const ctx = {
    gatewayId: local.gatewayId,
    fileRoot: local.fileRoot,
    forgeOrigin,
    jtiStore,
    config: () => current,
    audit,
    log,
    redact,
    readBytes,
    readJson,
    sendFile,
    ipOf: (req) => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
    callback: (kind, data) => {
      try { client.enqueue(kind, data); } catch (err) { log(`gateway: could not queue a ${kind} callback: ${err.code || err.message}`); }
    },
    /* The checksum, after the fact. Deliberately not awaited by the request. */
    verifyLater: (uploadId, full, relative, userId) => {
      setTimeout(() => {
        uploads.sha256(full)
          .then((sha) => ctx.callback('checksum_ready', { id: uploadId, path: relative, sha256: sha, userId, at: new Date().toISOString() }))
          .catch((err) => log(`gateway: could not checksum ${relative}: ${err.code || err.message}`));
      }, 10).unref?.();
    },
  };

  /* CORS. One origin — Forge's — and it is derived from FORGE_URL, which is
     local configuration, so it cannot be widened from the network. A request
     from anywhere else gets no CORS headers at all and the browser stops it. */
  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && forgeOrigin && origin === forgeOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Access-Control-Expose-Headers', 'content-range, content-length');
      return true;
    }
    return false;
  }

  const handler = async (req, res) => {
    const started = now();
    const ip = ctx.ipOf(req);
    cors(req, res);
    if (req.method === 'OPTIONS') {
      // A preflight for a route that exists; nothing is done and nothing is read.
      return res.writeHead(204).end();
    }
    if (!allow(ip, started)) {
      log(`gateway: ${ip} is over the rate limit`);
      return res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' })
        .end('{"error":"Too many requests. Try again in a minute."}');
    }
    try {
      await router.handle(req, res, ctx);
    } catch (err) {
      log(`gateway: unhandled: ${redact(err && err.stack ? err.stack.split('\n')[0] : err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"The gateway failed."}');
    } finally {
      // The request line, with the token taken out of it by redact().
      log(`gateway: ${ip} ${req.method} ${redact(req.url)} -> ${res.statusCode} ${now() - started}ms`);
    }
  };

  async function pull() {
    try {
      const r = await client.pullConfig();
      if (!r.ok) { log(`gateway: could not fetch configuration from Forge (${r.status}): ${r.error}`); return { ok: false }; }
      const shaped = config.shape(r.config);
      current = shaped;
      config.writeCache(local.stateDir, shaped);
      lastPull = new Date().toISOString();
      log(`gateway: configuration version ${shaped.version} applied (${shaped.keys.length} token key${shaped.keys.length === 1 ? '' : 's'}).`);
      return { ok: true, config: shaped };
    } catch (err) { log(`gateway: configuration fetch failed: ${redact(err && err.message)}`); return { ok: false }; }
  }

  async function beat() {
    let free = null;
    try { free = Number(fs.statfsSync(local.fileRoot).bavail) * Number(fs.statfsSync(local.fileRoot).bsize); }
    catch { free = null; }
    try {
      await client.heartbeat({
        version: require('../package.json').version,
        configVersion: current.version,
        freeBytes: free,
        queued: client.pending().length,
        at: new Date().toISOString(),
      });
    } catch (err) { log(`gateway: heartbeat failed: ${redact(err && err.message)}`); }
    try { await client.flush(); } catch { /* the queue is on disk; the next beat tries again */ }
  }

  function start() {
    const server = https.createServer({
      key: fs.readFileSync(local.tlsKey),
      cert: fs.readFileSync(local.tlsCert),
      minVersion: 'TLSv1.2',
    }, handler);
    server.listen(local.listenPort, local.listenAddress, () => {
      log(`gateway: listening on https://${local.listenAddress}:${local.listenPort} (share: ${local.fileRoot})`);
      log(`gateway: Forge is ${local.forgeUrl}; browser requests are accepted from ${forgeOrigin} only.`);
    });
    const timers = [
      setInterval(() => { pull().catch(() => {}); }, local.configSeconds * 1000),
      setInterval(() => { beat().catch(() => {}); }, local.heartbeatSeconds * 1000),
      setInterval(() => {
        const swept = deleter.sweepAbandoned(local.fileRoot, { olderThanMinutes: current.incomingMaxAgeMinutes });
        if (swept.removed) log(`gateway: cleaned ${swept.removed} abandoned upload${swept.removed === 1 ? '' : 's'} from .incoming`);
      }, 60 * 60 * 1000),
    ];
    for (const t of timers) t.unref?.();
    pull().then(() => beat()).catch(() => {});
    return { server, timers, stop: () => { for (const t of timers) clearInterval(t); server.close(); } };
  }

  return { start, handler, ctx, pull, beat, client, get config() { return current; }, lastPull: () => lastPull, forgeOrigin };
}

module.exports = { create, rateLimiter, readBytes, readJson, sendFile, auditLogger };
