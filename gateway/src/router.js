/* The entire surface of this server, in one table.
 *
 * WHY A TABLE AND NOT A FRAMEWORK. The studio's rule is that no way to delete,
 * rename, move or overwrite a stored file exists anywhere — not in Forge and
 * not here. A rule like that is provable only if the set of things this process
 * answers is enumerable, so ROUTES below IS the set: dispatch reads it, the
 * self-documentation reads it, and a test reads it and fails if anything is
 * added. With Express the routes would be spread across registration calls and
 * a test could only hope it had found them all.
 *
 * Every verb that is not in the table is a 405 on a path that is, and a 404
 * otherwise. DELETE is therefore not "blocked" by a check someone could remove;
 * there is simply nothing to call.
 *
 * GET /v1/app is the one entry that is not an API call, and it is here because
 * of what the browser spike found: current Chromium refuses a fetch from a
 * public-origin page to a private-address gateway until the user answers a
 * Local Network Access prompt, and refuses it by HANGING. A page served BY the
 * gateway is same-origin with it, so it is not gated at all. /v1/app is that
 * page: a few hundred bytes of HTML that talks to its own origin and relays to
 * the Forge tab over postMessage. It serves no file content and reads nothing
 * from the share. See gateway/README.md and the spike notes in the Server
 * section of the top-level README.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const tokens = require('./tokens');
const uploads = require('./uploads');
const listing = require('./listing');
const deleter = require('./deleter');
const config = require('./config');
const appPage = require('./app-page');
const probe = require('./probes');

/* method, path, the token operation it needs (null = no token), and whether the
   body is bytes rather than JSON. */
const ROUTES = [
  { method: 'GET',  path: '/health',                    op: null },
  { method: 'GET',  path: '/v1/app',                    op: null },
  { method: 'GET',  path: '/v1/list',                   op: 'list' },
  { method: 'POST', path: '/v1/folder',                 op: 'mkdir' },
  { method: 'PUT',  path: '/v1/upload/:id/chunk',       op: 'upload', bytes: true },
  { method: 'GET',  path: '/v1/upload/:id/status',      op: 'upload' },
  { method: 'POST', path: '/v1/upload/:id/complete',    op: 'upload' },
  { method: 'GET',  path: '/v1/download',               op: 'download' },
  { method: 'PUT',  path: '/v1/selftest',               op: 'selftest', bytes: true },
  { method: 'GET',  path: '/v1/selftest',               op: 'selftest' },
];

const describe = () => ROUTES.map((r) => `${r.method} ${r.path}`).join('\n');

/* Match a request path against the table. Returns the route and its params, or
   the set of verbs that path would accept (for the 405) — never a partial
   match that a handler then has to re-check. */
function match(method, pathname) {
  const want = String(pathname || '').replace(/\/+$/, '') || '/';
  const verbs = new Set();
  for (const route of ROUTES) {
    const parts = route.path.split('/');
    const got = want.split('/');
    if (parts.length !== got.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(':')) {
        if (!got[i]) { ok = false; break; }
        params[parts[i].slice(1)] = decodeURIComponent(got[i]);
      } else if (parts[i] !== got[i]) { ok = false; break; }
    }
    if (!ok) continue;
    verbs.add(route.method);
    if (route.method === method) return { route, params };
  }
  if (verbs.size) return { allow: [...verbs].sort() };
  return {};
}

const json = (res, status, body, extra = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(text);
};

/* The token, from the header or the query.
 *
 * The query form exists for exactly one reason: a download is a TOP-LEVEL link,
 * because that is the only thing that survives a 40 GB file and a browser's
 * download manager — and a top-level link cannot carry a header. Those tokens
 * are therefore single-use and live sixty seconds, and every log line that
 * could contain one is redacted. */
function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return url.searchParams.get('token') || '';
}

/* The relative path a request is asking about, and the check that the token
 * covers it.
 *
 * NEVER TRUST THE CLIENT PATH is the rule, and this is where it is kept: the
 * path the caller sent is only ever used after it has been proven to sit inside
 * the path the token names. Forge decides what the token names, from the user's
 * permissions and visibleProjects(); this side only enforces it. A caller may
 * therefore ask for a subfolder of what they were granted (which is how
 * browsing works) and nothing else.
 */
function pathWithin(claims, asked, { exact = false } = {}) {
  const granted = String(claims.path === undefined || claims.path === null ? '' : claims.path);
  const want = asked === undefined || asked === null ? granted : String(asked);
  const cleaned = paths.segments(want);
  if (!cleaned.ok) return cleaned;
  const relative = cleaned.value.join('/');
  if (exact && relative.toLowerCase() !== granted.toLowerCase()) {
    return { ok: false, reason: 'That token is for a different folder.' };
  }
  if (!paths.within(relative, granted)) {
    return { ok: false, reason: 'That token does not reach that folder.' };
  }
  return { ok: true, relative };
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, `https://${req.headers.host || 'gateway'}`);
  const found = match(req.method, url.pathname);

  if (!found.route) {
    if (found.allow) {
      // Every DELETE, every PATCH, every rename-shaped verb lands here.
      return json(res, 405, { error: 'That is not something this gateway does.' }, { allow: found.allow.join(', ') });
    }
    return json(res, 404, { error: 'No such endpoint.' });
  }
  const { route, params } = found;

  if (route.path === '/health') {
    /* Minimal on purpose: enough for a load balancer or a person with curl to
       see the process is up, and nothing about the share, the studio or the
       configuration. No version either — that goes to Forge over the signed
       channel, where it is not readable by anybody who can reach the port. */
    return json(res, 200, { ok: true });
  }

  if (route.path === '/v1/app') {
    const body = appPage.html({ forgeOrigin: ctx.forgeOrigin });
    return res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      // It talks to its own origin and to the opener. Nothing else, and no
      // framing: the spike showed an iframe is gated anyway, and refusing to be
      // framed keeps this page out of somebody else's.
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        + `connect-src 'self'; frame-ancestors 'none'; form-action 'none'`,
      'x-frame-options': 'DENY',
    }).end(body);
  }

  const cfg = ctx.config();
  const token = tokenFrom(req, url);
  const verdict = tokens.verify(token, {
    keys: cfg.keys,
    audience: ctx.gatewayId,
    jtiStore: ctx.jtiStore,
    leewaySeconds: ctx.clockLeewaySeconds,
    expect: { op: route.op, uid: route.path.includes(':id') ? params.id : undefined },
  });
  if (!verdict.ok) {
    ctx.audit({ op: route.op, outcome: 'refused', reason: verdict.reason, path: null, user: null, ip: ctx.ipOf(req) });
    const status = verdict.reason === 'expired' || verdict.reason === 'replay' ? 401 : 403;
    return json(res, status, { error: verdict.detail, reason: verdict.reason });
  }
  const claims = verdict.claims;

  try {
    if (route.path === '/v1/list') {
      const asked = pathWithin(claims, url.searchParams.get('path'));
      if (!asked.ok) return json(res, 403, { error: asked.reason });
      const out = listing.list(ctx.fileRoot, asked.relative, {
        offset: Number(url.searchParams.get('offset') || 0),
        limit: Number(url.searchParams.get('limit') || 200),
      });
      if (!out.ok) return json(res, 404, { error: out.reason });
      ctx.audit({ op: 'list', outcome: 'ok', path: out.path, user: claims.sub, ip: ctx.ipOf(req), count: out.entries.length });
      return json(res, 200, out);
    }

    if (route.path === '/v1/folder') {
      const body = await ctx.readJson(req);
      if (!body.ok) return json(res, 400, { error: body.reason });
      const asked = pathWithin(claims, body.value.path);
      if (!asked.ok) return json(res, 403, { error: asked.reason });
      const name = paths.cleanSegment(body.value.name);
      if (!name.ok) return json(res, 400, { error: name.reason });
      const parent = paths.resolve(ctx.fileRoot, asked.relative);
      if (!parent.ok) return json(res, 400, { error: parent.reason });
      const full = path.join(parent.full, name.value);
      try {
        // Exclusive: mkdir without recursive fails with EEXIST rather than
        // quietly adopting a folder somebody else made, so "created" is true.
        fs.mkdirSync(parent.full, { recursive: true });
        fs.mkdirSync(full);
      } catch (err) {
        if (err.code === 'EEXIST') return json(res, 409, { error: `"${name.value}" is already there.` });
        return json(res, 500, { error: 'That folder could not be created.' });
      }
      const relative = [asked.relative, name.value].filter(Boolean).join('/');
      ctx.audit({ op: 'mkdir', outcome: 'ok', path: relative, user: claims.sub, ip: ctx.ipOf(req) });
      ctx.callback('folder_created', { id: crypto.randomUUID(), path: relative, userId: claims.sub, at: new Date().toISOString() });
      return json(res, 201, { ok: true, path: relative, name: name.value });
    }

    if (route.path === '/v1/upload/:id/chunk') {
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isInteger(offset) || offset < 0) return json(res, 400, { error: 'That chunk has no offset.' });
      const declared = Number(claims.max);
      if (!Number.isFinite(declared) || declared <= 0) return json(res, 403, { error: 'That upload token carries no size.' });
      if (declared > cfg.maxFileBytes) {
        /* The PULLED limit, enforced here. Forge checks it when it mints the
           session; this checks it again because the gateway is the thing that
           would be filling the share, and a stale or tampered token must not
           be able to raise a limit the studio set. */
        return json(res, 413, { error: `That file is larger than the ${Math.round(cfg.maxFileBytes / (1024 ** 3))} GB limit.` });
      }
      const nameCheck = config.extensionAllowed(claims.name || '', cfg);
      if (!nameCheck.ok) return json(res, 415, { error: nameCheck.reason });
      const body = await ctx.readBytes(req, cfg.chunkBytes * 2);
      if (!body.ok) return json(res, body.status || 400, { error: body.reason });
      const out = uploads.putChunk(ctx.fileRoot, params.id, offset, body.value, {
        size: declared, name: claims.name, dir: claims.path, sub: claims.sub,
      });
      if (!out.ok) return json(res, 400, { error: out.reason });
      ctx.audit({ op: 'chunk', outcome: 'ok', path: `${claims.path || ''}/${claims.name || ''}`, user: claims.sub, ip: ctx.ipOf(req), size: body.value.length, offset });
      return json(res, 200, { ok: true, received: out.received, size: out.size, complete: out.complete });
    }

    if (route.path === '/v1/upload/:id/status') {
      const out = uploads.status(ctx.fileRoot, params.id);
      if (!out.ok) return json(res, 400, { error: out.reason });
      return json(res, 200, out);
    }

    if (route.path === '/v1/upload/:id/complete') {
      const out = uploads.complete(ctx.fileRoot, params.id, { dir: claims.path, name: claims.name });
      if (!out.ok) return json(res, 409, { error: out.reason, received: out.received, size: out.size });
      ctx.audit({ op: 'upload', outcome: 'ok', path: out.relative, user: claims.sub, ip: ctx.ipOf(req), size: out.size });
      ctx.callback('upload_completed', {
        id: params.id, path: out.relative, name: out.stored, size: out.size,
        userId: claims.sub, renamed: out.renamed, at: new Date().toISOString(),
      });
      /* The checksum is read back AFTER the answer, so the page is told the
         file is safe the moment it is, and the verification arrives as a second
         callback a minute later for a big file. */
      ctx.verifyLater(params.id, path.join(ctx.fileRoot, ...out.relative.split('/')), out.relative, claims.sub);
      return json(res, 200, {
        ok: true, path: out.relative, name: out.stored, size: out.size, renamed: out.renamed,
        /* WHICH FINALISE PATH THIS SHARE TOOK — 'link' or 'reserve+copy'. Not
           decoration: on a share without hard links finishing a large file
           costs a second pass over the bytes, and this is how anybody
           diagnosing "why did the last 10% take a minute" finds out. The
           doctor reports the same value before anybody uploads. */
        how: out.how,
      });
    }

    if (route.path === '/v1/download') {
      const asked = pathWithin(claims, url.searchParams.get('path'), { exact: true });
      if (!asked.ok) return json(res, 403, { error: asked.reason });
      const file = paths.resolve(ctx.fileRoot, asked.relative, { mustExist: true });
      if (!file.ok) return json(res, 404, { error: file.reason });
      let stat;
      try { stat = fs.statSync(file.full); } catch { return json(res, 404, { error: 'That file is not there.' }); }
      if (!stat.isFile()) return json(res, 400, { error: 'That is a folder.' });
      ctx.audit({ op: 'download', outcome: 'ok', path: file.relative, user: claims.sub, ip: ctx.ipOf(req), size: stat.size });
      return ctx.sendFile(req, res, file.full, stat, path.basename(file.full));
    }

    if (route.path === '/v1/selftest') {
      /* The self-test writes and reads a kilobyte INSIDE .incoming/selftest and
         nowhere else, so pressing the button in Settings can never create or
         touch anything in the studio's folders. */
      const home = path.join(fs.realpathSync(ctx.fileRoot), paths.INCOMING, 'selftest');
      fs.mkdirSync(home, { recursive: true });
      const blob = path.join(home, `${claims.sub || 'anon'}.bin`);
      if (req.method === 'PUT') {
        const body = await ctx.readBytes(req, 64 * 1024);
        if (!body.ok) return json(res, body.status || 400, { error: body.reason });
        fs.writeFileSync(blob, body.value);
        ctx.audit({ op: 'selftest', outcome: 'ok', path: '.incoming/selftest', user: claims.sub, ip: ctx.ipOf(req), size: body.value.length });
        return json(res, 200, { ok: true, bytes: body.value.length });
      }
      if (!fs.existsSync(blob)) return json(res, 404, { error: 'Nothing was written to read back.' });
      const bytes = fs.readFileSync(blob);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      deleter.remove(ctx.fileRoot, blob);                 // cleaned up immediately
      /* AND WHAT KIND OF SHARE THIS IS, in the same answer.
       *
       * The same functions gateway/doctor.js runs on the machine — hard links,
       * exclusive create, positional writes, case folding, long paths, free
       * space. Reported here so somebody who cannot get onto that machine still
       * sees them from Settings → Run self-test. Everything they write is
       * inside .incoming and removed before this returns. */
      const probes = probe.run(ctx.fileRoot, { name: 'selftest-probe' });
      return json(res, 200, {
        ok: true, bytes: bytes.length, sha256: sha, cleaned: !fs.existsSync(blob),
        probes,
      });
    }
  } catch (err) {
    ctx.log(`gateway: ${route.method} ${route.path} failed: ${ctx.redact(err && err.message)}`);
    return json(res, 500, { error: 'The gateway could not complete that.' });
  }
  return json(res, 404, { error: 'No such endpoint.' });
}

module.exports = { ROUTES, describe, match, handle, pathWithin, tokenFrom };
