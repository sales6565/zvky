/* Everything the gateway says to Forge. All of it outbound.
 *
 * Forge is on shared hosting on the public internet and this process is on the
 * office LAN behind a firewall nobody is going to open. So the direction of
 * every connection here is one way: the gateway dials out for configuration,
 * says it is alive, and reports what happened. Forge never calls in, which is
 * why hard rule 3 — "never port-forward this" — costs the feature nothing.
 *
 * THE QUEUE IS ON DISK, and that is the whole reliability story. A finished
 * upload is a fact about the share: the bytes are there, read-only, under a
 * name that was free. Telling Forge about it is a separate, fallible act over
 * somebody else's network. If that fails the file must not be lost and the
 * person must not be told it failed, so the callback is written to disk first
 * and retried with backoff until it lands — across a restart, across a GoDaddy
 * outage, across the office internet being out for an afternoon.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const signing = require('./signing');

const OUTBOX = 'outbox';
/* 15 s, 1 m, 5 m, 15 m, then every half hour. Front-loaded because the common
   failure is a few seconds of network, and flat afterwards because an outage
   measured in hours should not push the next try into next week. */
const BACKOFF_SECONDS = [15, 60, 300, 900, 1800];

const redact = (text) => String(text === undefined || text === null ? '' : text)
  .replace(/(v1=)[0-9a-f]{6,}/gi, '$1<redacted>')
  .replace(/([?&](?:token|t)=)[^&\s]+/gi, '$1<redacted>')
  .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
  // A compact token is three base64url runs; redacted wherever it turns up so a
  // thrown error or a URL in a log line can never carry one.
  .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '<token redacted>');

function client({ local, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console.log } = {}) {
  const outboxDir = path.join(local.stateDir, OUTBOX);
  const base = String(local.forgeUrl || '').replace(/\/+$/, '');

  async function call(method, apiPath, bodyObject) {
    const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
    const target = apiPath;                         // exactly what is signed
    const { header } = signing.sign(local.gatewaySecret, { method, target, body, t: Math.floor(now() / 1000) });
    const res = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [signing.ID_HEADER]: local.gatewayId,
        [signing.SIGNATURE_HEADER]: header,
      },
      body: body === '' ? undefined : body,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json, text };
  }

  async function pullConfig() {
    const r = await call('GET', '/api/gateway/config');
    if (!r.ok) return { ok: false, status: r.status, error: redact((r.json && r.json.error) || r.text || `HTTP ${r.status}`) };
    return { ok: true, config: r.json };
  }

  async function heartbeat(state) {
    const r = await call('POST', '/api/gateway/heartbeat', state);
    if (!r.ok) return { ok: false, status: r.status, error: redact((r.json && r.json.error) || `HTTP ${r.status}`) };
    return { ok: true, answer: r.json };
  }

  /* Write first, send after. The id is the gateway's, so a retry after a
     response that was sent but never arrived is the same id twice — which Forge
     treats as the same event. Nothing here is "at most once"; everything is
     "at least once, idempotent by id". */
  function enqueue(kind, data) {
    fs.mkdirSync(outboxDir, { recursive: true });
    const id = data && data.id ? String(data.id) : crypto.randomUUID();
    const file = path.join(outboxDir, `${String(now()).padStart(14, '0')}-${id}.json`);
    const record = { id, kind, data: { ...data, id }, attempts: 0, nextAt: 0, queuedAt: new Date(now()).toISOString() };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
    return { id, file };
  }

  function pending() {
    try {
      return fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort()
        .map((f) => path.join(outboxDir, f));
    } catch { return []; }
  }

  async function flush({ limit = 25 } = {}) {
    const files = pending().slice(0, limit);
    const out = { sent: 0, held: 0, dropped: 0 };
    for (const file of files) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out.dropped += 1; fs.rmSync(file, { force: true }); continue; }
      if (rec.nextAt && rec.nextAt > now()) { out.held += 1; continue; }
      let r;
      try { r = await call('POST', '/api/gateway/callback', { kind: rec.kind, ...rec.data }); }
      catch (err) { r = { ok: false, status: 0, text: redact(err && err.message) }; }
      if (r.ok) { fs.rmSync(file, { force: true }); out.sent += 1; continue; }
      /* 4xx that is not a timing problem means Forge will never accept this
         record — a callback for an upload it has no session for, say. Retrying
         for ever would fill the queue behind it, so it is dropped with a line
         in the log. 408/429 and everything 5xx are retried. */
      const permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
      if (permanent) {
        log(`gateway: Forge refused the ${rec.kind} callback permanently (HTTP ${r.status}); dropping it. ${redact(r.text).slice(0, 200)}`);
        fs.rmSync(file, { force: true });
        out.dropped += 1;
        continue;
      }
      rec.attempts = Number(rec.attempts || 0) + 1;
      const wait = BACKOFF_SECONDS[Math.min(rec.attempts - 1, BACKOFF_SECONDS.length - 1)];
      rec.nextAt = now() + wait * 1000;
      rec.lastError = redact(r.text || `HTTP ${r.status}`).slice(0, 300);
      fs.writeFileSync(file, JSON.stringify(rec));
      out.held += 1;
    }
    return { ...out, queued: pending().length };
  }

  return { call, pullConfig, heartbeat, enqueue, flush, pending, outboxDir, redact };
}

module.exports = { client, redact, BACKOFF_SECONDS, OUTBOX };
