/* THE SERVER TAB, from Forge's side. Permissions, scoping, tokens, audit.
 *
 * ===========================================================================
 * NO FILE EVER PASSES THROUGH HERE, and that is the point of every line below.
 *
 * There is no multipart parser on this router, no route that reads a body of
 * bytes, and nothing that writes to this server's disk. What these endpoints
 * hand out is PERMISSION: a short-lived signed token naming one user, one
 * operation and one path, which the browser then presents to the office
 * gateway. The bytes go from the person's browser to the machine in the office
 * and back, over the office network. GoDaddy never sees them — not as a body,
 * not as a proxy, not as a temporary file, not as a cached thumbnail.
 *
 * A test proves it rather than trusting this paragraph: it spies on fs writes
 * across every flow in this file and fails if one happens.
 *
 * ===========================================================================
 * EVERY TOKEN IS A DECISION MADE HERE. The gateway enforces what a token says;
 * it never decides what a token should say. So this is where
 * visibleProjects() is consulted, where server.* permissions are checked, and
 * where a client-supplied path is accepted or refused — before anything is
 * signed. The gateway then checks the path against the token AGAIN on its side,
 * which is belt and braces on purpose: the two checks fail independently.
 *
 * ===========================================================================
 * AND NOTHING DELETES. There is no delete, rename, move or overwrite endpoint
 * in this file, and there is no permission key that would authorise one. A
 * deletion request is a row with a reason and a status on it — a message to
 * whoever looks after the office server. Resolving one records that a person
 * removed a file on that machine; it does not remove anything here, and a test
 * pins that by resolving a request and then finding every file still in place.
 */
const crypto = require('node:crypto');
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const permissions = require('../permissions');
const rolePermissions = require('../role-permissions');
const activity = require('../activity');
const notifications = require('../notifications');
const serverSettings = require('../server-settings');
const serverFolders = require('../server-folders');
const serverPaths = require('../server-paths');
const serverLink = require('../server-link');
const serverTokens = require('../server-tokens');
const emailNotifications = require('../email-notifications');

router.use(authenticate);

/* THE SWITCH, read at the entrance to everything that needs the gateway.
 *
 * 409 with a machine-readable code, so the page can draw the disabled state
 * rather than an error toast. Deliberately NOT applied to the deletion-request
 * endpoints: a request is a message about a file that is still on the office
 * server, and switching a feature off is not an answer to it. */
function requireEnabled(req, res, next) {
  if (!serverSettings.serverEnabled()) {
    return res.status(409).json({
      error: 'The Server tab is switched off.',
      code: 'feature_disabled',
    });
  }
  next();
}

const HEARTBEAT_STALE_SECONDS = Number(process.env.GATEWAY_STALE_SECONDS || 120);

async function gatewayState() {
  const { rows } = await db.query('SELECT * FROM gateway_state WHERE id = 1').catch(() => ({ rows: [] }));
  const row = rows[0] || {};
  const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
  const ageSeconds = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 1000) : null;
  return {
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
    ageSeconds,
    online: Boolean(ageSeconds !== null && ageSeconds < HEARTBEAT_STALE_SECONDS),
    version: row.version || null,
    freeBytes: row.free_bytes === null || row.free_bytes === undefined ? null : Number(row.free_bytes),
    configVersion: row.config_version === null || row.config_version === undefined ? null : Number(row.config_version),
    queued: row.queued === null || row.queued === undefined ? null : Number(row.queued),
    clockSkewSeconds: row.clock_skew_seconds === null || row.clock_skew_seconds === undefined
      ? null : Number(row.clock_skew_seconds),
    /* WARNED ABOUT WELL BEFORE IT BREAKS ANYTHING. The leeway is 30 s and a
       token lives 60, so 15 s is halfway to a problem — which is where a
       warning belongs, rather than at the point where people start seeing
       "that link has expired". */
    clockSkewWarn: Math.abs(Number(row.clock_skew_seconds || 0)) > 15,
    staleAfterSeconds: HEARTBEAT_STALE_SECONDS,
  };
}

const audit = (entry) => db.query(
  `INSERT INTO server_events (id, user_id, user_email, action, path, size, sha256, ip)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [crypto.randomUUID(), entry.userId || null, (entry.userEmail || '').slice(0, 191) || null,
    entry.action, entry.path === undefined || entry.path === null ? null : String(entry.path).slice(0, 1000),
    entry.size === undefined ? null : entry.size, entry.sha256 || null,
    (entry.ip || '').slice(0, 64) || null]
).catch((err) => {
  // Same bargain src/activity.js makes: a missing audit line is better than a
  // refused download.
  console.error('[server] could not write a server_events row:', err.message);
});

/* GET /api/server/state — everything the tab needs to draw itself once.
 *
 * One request rather than five, because the tab is drawn on every navigation
 * and five round trips to shared hosting is a visible pause. */
router.get('/state', requirePermission('server.view'), async (req, res) => {
  const settings = serverSettings.current();
  const state = await gatewayState();
  const roots = await serverFolders.roots(db, req.user);
  const { rows: mine } = await db.query(
    `SELECT id, path, \`type\`, status, created_at FROM deletion_requests
      WHERE status = 'open' ORDER BY created_at DESC LIMIT 500`
  ).catch(() => ({ rows: [] }));
  res.json({
    enabled: serverSettings.serverEnabled(),
    /* The second switch and the prefix, so the tab and the submit modal can
       both draw themselves from one request. Neither is a permission: the
       permission is checked on every endpoint regardless. */
    submitUploadEnabled: serverSettings.submitUploadEnabled(),
    linkPrefix: settings.linkPrefix,
    gatewayUrl: settings.gatewayUrl,
    gatewayId: settings.gatewayId,
    chunkBytes: settings.chunkBytes,
    parallelChunks: settings.parallelChunks,
    maxFileBytes: settings.maxFileBytes,
    deniedExtensions: settings.deniedExtensions,
    allowedExtensions: settings.allowedExtensions,
    gateway: state,
    roots,
    /* The open requests, as paths only, so a row can carry its "Deletion
       requested" tag without a second call per row. Not a file index: these are
       paths somebody has asked about, which is a fact about the requests. */
    openRequests: mine.map((r) => ({ id: r.id, path: r.path, type: r.type, at: r.created_at })),
    may: {
      download: permissions.holds(req.user, 'server.download'),
      upload: permissions.holds(req.user, 'server.upload'),
      requestDelete: permissions.holds(req.user, 'server.request_delete'),
      manageRequests: permissions.holds(req.user, 'server.manage_requests'),
      browseAll: permissions.holds(req.user, 'server.browse_all'),
      viewAudit: permissions.holds(req.user, 'server.view_audit'),
    },
  });
});

/* The scope check every mint goes through. Returns the cleaned path or a reason.
 *
 * NEVER TRUSTS req.body.path. The path is cleaned (no traversal, no absolute,
 * no reserved name), then tested against the prefixes this person actually
 * holds, which come from visibleProjects(). */
async function scopeFor(user, rawPath) {
  const cleaned = serverPaths.cleanRelative(rawPath);
  if (!cleaned.ok) return { ok: false, status: 400, error: cleaned.reason };
  const scope = await serverFolders.allowedPrefixes(db, user);
  if (!serverFolders.mayReach(scope.prefixes, cleaned.value)) {
    /* 403 and the same sentence whether the folder exists or not: telling
       somebody "that project exists but is not yours" is more than they are
       entitled to know. */
    return { ok: false, status: 403, error: 'That folder is not one you have access to.' };
  }
  return { ok: true, path: cleaned.value, scope };
}

const OP_PERMISSION = {
  list: 'server.view',
  download: 'server.download',
  mkdir: 'server.upload',
};

/* POST /api/server/token — a short-lived token for one operation on one path. */
router.post('/token', requireEnabled, requirePermission('server.view'), async (req, res) => {
  const op = String((req.body && req.body.op) || '');
  const need = OP_PERMISSION[op];
  if (!need) return res.status(400).json({ error: `"${op}" is not an operation.` });
  if (!permissions.holds(req.user, need)) {
    return res.status(403).json({ error: 'You do not have permission to do that on the office server.' });
  }
  const settings = serverSettings.current();
  if (!settings.gatewayUrl || !settings.gatewayId) {
    return res.status(409).json({ error: 'The office file gateway has not been configured.', code: 'not_configured' });
  }
  const scoped = await scopeFor(req.user, (req.body && req.body.path) || '');
  if (!scoped.ok) return res.status(scoped.status).json({ error: scoped.error });

  /* A download names a FILE, so its token is exact — the gateway refuses any
     other path with it, and it is single-use and sixty seconds long because it
     travels in a URL (a top-level link is the only thing that survives a very
     large file and a browser's download manager). */
  const key = serverSettings.signingKey();
  if (!key.ok) return res.status(409).json({ error: key.reason, code: 'no_signing_key' });

  const minted = serverTokens.mint({
    privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId,
    userId: req.user.id, op, path: scoped.path,
  });

  await audit({
    userId: req.user.id, userEmail: req.user.email, ip: req.ip,
    action: op === 'download' ? 'download_issued' : (op === 'mkdir' ? 'folder_token' : 'list'),
    path: scoped.path,
  });

  res.json({
    token: minted.token,
    expiresAt: minted.expiresAt,
    gatewayUrl: settings.gatewayUrl,
    path: scoped.path,
  });
});

/* POST /api/server/upload-session — permission to put ONE file in ONE folder.
 *
 * The size and the extension are checked HERE, before anything is signed, so a
 * refusal is a sentence on the page rather than a failure forty gigabytes in.
 * The gateway checks both again against the configuration it pulled, because it
 * is the one with the disk.
 */
async function openUploadSession(req, res, { uploadId, renewal }) {
  const settings = serverSettings.current();
  if (!settings.gatewayUrl || !settings.gatewayId) {
    return res.status(409).json({ error: 'The office file gateway has not been configured.', code: 'not_configured' });
  }
  const body = req.body || {};
  const scoped = await scopeFor(req.user, body.path || '');
  if (!scoped.ok) return res.status(scoped.status).json({ error: scoped.error });

  const name = serverPaths.cleanName(body.name);
  if (!name.ok) return res.status(400).json({ error: name.reason });

  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) return res.status(400).json({ error: 'That upload has no size.' });
  if (size > settings.maxFileBytes) {
    const gb = (n) => `${(n / (1024 ** 3)).toFixed(n % (1024 ** 3) ? 1 : 0)} GB`;
    return res.status(413).json({ error: `${name.value} is ${gb(size)}; the limit is ${gb(settings.maxFileBytes)}.` });
  }
  const ext = (String(name.value).match(/\.[^.]*$/) || [''])[0].toLowerCase();
  if (settings.deniedExtensions.includes(ext)) {
    return res.status(415).json({ error: `${ext || 'That kind of file'} may not be uploaded to the office server.` });
  }
  if (settings.allowedExtensions.length && !settings.allowedExtensions.includes(ext)) {
    return res.status(415).json({ error: `Only ${settings.allowedExtensions.join(', ')} may be uploaded to the office server.` });
  }

  const key = serverSettings.signingKey();
  if (!key.ok) return res.status(409).json({ error: key.reason, code: 'no_signing_key' });

  const id = uploadId || crypto.randomUUID();
  const minted = serverTokens.mint({
    privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId,
    userId: req.user.id, op: 'upload', path: scoped.path,
    uploadId: id, maxBytes: size, name: name.value,
  });

  if (!renewal) {
    await audit({
      userId: req.user.id, userEmail: req.user.email, ip: req.ip,
      action: 'upload_started', path: `${scoped.path ? `${scoped.path}/` : ''}${name.value}`, size,
    });
  }

  res.json({
    uploadId: id,
    token: minted.token,
    expiresAt: minted.expiresAt,
    gatewayUrl: settings.gatewayUrl,
    path: scoped.path,
    name: name.value,
    chunkBytes: settings.chunkBytes,
    parallelChunks: settings.parallelChunks,
    renewed: Boolean(renewal),
  });
}

router.post('/upload-session', requireEnabled, requirePermission('server.upload'), async (req, res) =>
  openUploadSession(req, res, {}));

/* Renewal. A thirty-minute upload token on a two-hour file needs replacing, and
   the replacement is a FRESH DECISION rather than an extension: every check
   above runs again, so a person whose access was removed mid-upload stops being
   able to continue. The upload id is kept, which is what lets the gateway carry
   on with the chunks it already has. */
router.post('/upload-session/:id/renew', requireEnabled, requirePermission('server.upload'), async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'That is not an upload id.' });
  }
  return openUploadSession(req, res, { uploadId: id, renewal: true });
});

/* POST /api/server/check-folder — "does this folder exist on the server?"
 *
 * For the project form: somebody pastes a link and presses Check folder. Forge
 * cannot look — it cannot reach the LAN — so it mints a list token for that
 * path and the browser does the looking through whichever transport it has.
 *
 * THE PERMISSION IS project.edit, NOT server.view. The person doing this is
 * setting up a project, which is what project.edit is for, and requiring a
 * Server-tab permission as well would mean a project manager could not check
 * the link they are being asked to type. It is a read of one folder's existence
 * and nothing else: the token is a list token, for that path, for sixty
 * seconds, and it is audited like every other mint.
 */
/* GET /api/server/page-context — what the two screens OUTSIDE the tab need.
 *
 * WHY A ROUTE OF ITS OWN, rather than one more field somewhere.
 *
 * The project form's link field and the submit-work upload box are both drawn
 * outside the Server tab, by people who need not hold a Server-tab permission at
 * all — a project manager with `project.edit`, an artist with
 * `server.submit_upload`. Neither can call /state, which is the TAB's single
 * request and needs `server.view`; and until this route existed both screens
 * asked for it anyway, got a 403, and drew themselves as if nothing had been
 * configured: a link field disabled with "an admin needs to set the server link
 * prefix" on a studio that had set one, and no upload box at all. Nothing on
 * screen said why, because from the page's side nothing had gone wrong.
 *
 * Not on /auth/me: that endpoint is re-polled by every signed-in browser every
 * twenty seconds, and the note there about keeping the settings out of it is
 * right.
 *
 * NOTHING HERE IS A SECRET. The prefix is the first half of every project link,
 * the address is on screen in Settings and is already handed to the same person
 * by /check-folder, and the limits are the ones the upload endpoints enforce
 * anyway. The permission is checked again on every endpoint regardless: this
 * route decides what a screen can DRAW, never what anybody may do. */
function requireAny(...keys) {
  return (req, res, next) => {
    if (!req.permissions || !keys.some((k) => req.permissions.has(k))) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

router.get('/page-context', requireEnabled, requireAny('project.edit', 'server.submit_upload'),
  (req, res) => {
    const settings = serverSettings.current();
    res.json({
      enabled: true,                 // requireEnabled got us here
      submitUploadEnabled: serverSettings.submitUploadEnabled(),
      linkPrefix: settings.linkPrefix || null,
      gatewayUrl: settings.gatewayUrl || null,
      gatewayId: settings.gatewayId || null,
      chunkBytes: settings.chunkBytes,
      parallelChunks: settings.parallelChunks,
      maxFileBytes: settings.maxFileBytes,
      deniedExtensions: settings.deniedExtensions || [],
      allowedExtensions: settings.allowedExtensions || [],
    });
  });

router.post('/check-folder', requireEnabled, requirePermission('project.edit'), async (req, res) => {
  const settings = serverSettings.current();
  if (!settings.gatewayUrl || !settings.gatewayId) {
    return res.status(409).json({ error: 'The office file gateway has not been configured.', code: 'not_configured' });
  }
  if (!settings.linkPrefix) {
    return res.status(409).json({ error: 'No server link prefix has been set in Settings → Server.', code: 'no_prefix' });
  }
  const checked = serverLink.validateLink((req.body || {}).link, settings.linkPrefix);
  if (!checked.ok) return res.status(400).json({ error: checked.error, reason: checked.reason });

  const key = serverSettings.signingKey();
  if (!key.ok) return res.status(409).json({ error: key.reason, code: 'no_signing_key' });
  const minted = serverTokens.mint({
    privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId,
    userId: req.user.id, op: 'list', path: checked.relative,
  });
  await audit({ userId: req.user.id, userEmail: req.user.email, ip: req.ip, action: 'list', path: checked.relative });
  res.json({
    token: minted.token, expiresAt: minted.expiresAt, gatewayUrl: settings.gatewayUrl,
    path: checked.relative, link: checked.link,
  });
});

/* ---- Part C: the Submit Work upload --------------------------------------
 *
 * THE PATH IS COMPUTED HERE. The browser says which asset, which file name, how
 * big, and — for a dragged folder — the subpath inside it. It does NOT say
 * where the file goes: that is
 *
 *     <the project's folder> / <discipline> / <the person's own folder>
 *
 * read off the asset's project and category and the uploader's account. A
 * client that sends a path has it ignored. This is the difference between the
 * Server tab's upload (anywhere the person may reach, needing server.upload)
 * and this one (their own folder on this asset's project, and nowhere else).
 */
async function submitUploadContext(req) {
  const assetId = String((req.body || {}).assetId || '');
  if (!assetId) return { ok: false, status: 400, error: 'Which asset is this for?' };
  const { rows } = await db.query(
    `SELECT a.id, a.project_id, a.\`category\`, a.assignee_id, p.\`name\` AS project_name,
            p.server_link, p.server_submit_enabled
       FROM assets a JOIN projects p ON p.id = a.project_id
      WHERE a.id = $1`, [assetId]
  );
  const asset = rows[0];
  if (!asset) return { ok: false, status: 404, error: 'Asset not found' };
  if (!(await permissions.canViewAsset(req.user, asset))) {
    return { ok: false, status: 403, error: 'No access to this asset' };
  }
  const project = { id: asset.project_id, server_link: asset.server_link, server_submit_enabled: asset.server_submit_enabled };
  if (!serverSettings.submitUploadEnabledFor(project)) {
    /* One answer for all of: the switch is off, the prefix is unset, this
       project has no link, its link is not under the prefix, or it is not in
       the allowlist. The page is told the code so it can draw the right
       tooltip; the sentence is the one a person can act on. */
    return {
      ok: false, status: 409, code: 'project_not_enabled',
      error: serverSettings.submitUploadEnabled()
        ? 'Uploading to the office server is not switched on for this project. Paste a link instead, '
          + 'or ask an admin to enable it.'
        : 'Uploading to the office server is not switched on. Paste a link instead.',
    };
  }
  const folder = await serverFolders.userFolderFor(db, req.user);
  if (!folder.ok) return { ok: false, status: 409, error: folder.error };
  const computed = serverLink.uploadPathFor({
    project, prefix: serverSettings.linkPrefix(), categoryKey: asset.category,
    userFolder: folder.folder, subPath: (req.body || {}).subPath || '',
    discipline: serverSettings.disciplines(),
  });
  if (!computed.ok) return { ok: false, status: 409, error: computed.error, code: computed.reason };
  return { ok: true, asset, computed, userFolder: folder.folder };
}

router.post('/submit-upload-session', requireEnabled, requirePermission('server.submit_upload'), async (req, res) => {
  const ctx = await submitUploadContext(req);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error, code: ctx.code });

  const settings = serverSettings.current();
  const body = req.body || {};
  const name = serverPaths.cleanName(body.name);
  if (!name.ok) return res.status(400).json({ error: name.reason });
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) return res.status(400).json({ error: 'That upload has no size.' });
  if (size > settings.maxFileBytes) {
    const gb = (n) => `${(n / (1024 ** 3)).toFixed(n % (1024 ** 3) ? 1 : 0)} GB`;
    return res.status(413).json({ error: `${name.value} is ${gb(size)}; the limit is ${gb(settings.maxFileBytes)}.` });
  }
  const ext = (String(name.value).match(/\.[^.]*$/) || [''])[0].toLowerCase();
  if (settings.deniedExtensions.includes(ext)) {
    return res.status(415).json({ error: `${ext || 'That kind of file'} may not be uploaded to the office server.` });
  }
  if (settings.allowedExtensions.length && !settings.allowedExtensions.includes(ext)) {
    return res.status(415).json({ error: `Only ${settings.allowedExtensions.join(', ')} may be uploaded.` });
  }

  const key = serverSettings.signingKey();
  if (!key.ok) return res.status(409).json({ error: key.reason, code: 'no_signing_key' });
  const uploadId = String(body.uploadId || '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    ? String(body.uploadId) : crypto.randomUUID();
  const minted = serverTokens.mint({
    privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId,
    userId: req.user.id, op: 'upload', path: ctx.computed.relative,
    uploadId, maxBytes: size, name: name.value,
    /* The project's own folder, which must already be on the share. The gateway
       refuses the upload if it is not there and creates only the discipline and
       person folders below it. */
    existingPrefix: ctx.computed.existingPrefix,
  });
  await audit({
    userId: req.user.id, userEmail: req.user.email, ip: req.ip, action: 'upload_started',
    path: `${ctx.computed.relative}/${name.value}`, size,
  });
  res.json({
    uploadId, token: minted.token, expiresAt: minted.expiresAt,
    gatewayUrl: settings.gatewayUrl,
    // The computed path, so the page can show where it is going — it is told,
    // it does not choose.
    path: ctx.computed.relative,
    name: name.value,
    existingPrefix: ctx.computed.existingPrefix,
    chunkBytes: settings.chunkBytes,
    parallelChunks: settings.parallelChunks,
  });
});

/* POST /api/server/submit-uploads — the references, and the link to put in the
 * form.
 *
 * REFERENCES ONLY: a relative path, a name, a size and a time. No content, no
 * checksum of content this server never saw, no copy. And the LINK IS COMPUTED
 * HERE as well, from the prefix and the relative path, so what lands in the
 * form is a link this studio's own validator accepts — rather than something
 * the page assembled and the submit endpoint then refuses.
 *
 * ONE FILE: the file's own link, which is what a reviewer wants to open.
 * SEVERAL: the person's folder for this asset, because a link can only point at
 * one thing and the folder is the one place all of them are.
 */
router.post('/submit-uploads', requireEnabled, requirePermission('server.submit_upload'), async (req, res) => {
  const ctx = await submitUploadContext(req);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error, code: ctx.code });
  const files = Array.isArray((req.body || {}).files) ? (req.body || {}).files : [];
  if (!files.length) return res.status(400).json({ error: 'No files were named.' });

  const stored = [];
  for (const file of files.slice(0, 200)) {
    const name = serverPaths.cleanName(file && file.name);
    if (!name.ok) continue;
    /* The path is RECOMPUTED from the asset, the person and the subpath — never
       taken from the browser. A client naming somebody else's folder gets its
       own folder, which is the only place this endpoint can write a reference
       to. */
    const computed = serverLink.uploadPathFor({
      project: { id: ctx.asset.project_id, server_link: ctx.asset.server_link, server_submit_enabled: ctx.asset.server_submit_enabled },
      prefix: serverSettings.linkPrefix(), categoryKey: ctx.asset.category,
      userFolder: ctx.userFolder, subPath: file && file.subPath ? file.subPath : '',
      discipline: serverSettings.disciplines(),
    });
    if (!computed.ok) continue;
    const relative = `${computed.relative}/${name.value}`;
    const size = Number.isFinite(Number(file.size)) ? Math.floor(Number(file.size)) : null;
    await db.query(
      `INSERT INTO server_submission_files (id, asset_id, user_id, relative_path, \`name\`, size)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), ctx.asset.id, req.user.id, relative, name.value, size]
    ).catch((err) => { if (!(err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062))) throw err; });
    stored.push({ relative, name: name.value, size });
  }
  if (!stored.length) return res.status(400).json({ error: 'None of those files could be recorded.' });

  const single = stored.length === 1;
  const relative = single ? stored[0].relative : ctx.computed.relative;
  const link = serverLink.linkFor(serverSettings.linkPrefix(), relative);
  res.json({
    files: stored,
    link,
    /* Said out loud, because the artist is about to see one or the other in the
       field and should know why. */
    linkIs: single ? 'file' : 'folder',
    relative,
  });
});

/* ---- deletion requests ---------------------------------------------------
 * Not gated by requireEnabled: see the note on requireEnabled. */

router.get('/deletion-requests', async (req, res) => {
  const mayManage = permissions.holds(req.user, 'server.manage_requests');
  const mayAsk = permissions.holds(req.user, 'server.request_delete');
  if (!mayManage && !mayAsk) return res.status(403).json({ error: 'You do not have permission to see deletion requests.' });
  const status = ['open', 'done', 'declined'].includes(String(req.query.status || '')) ? String(req.query.status) : null;
  const params = [];
  const where = [];
  if (!mayManage) {
    /* Somebody who may ASK but not RESOLVE sees their own requests and nobody
       else's: the list is a record of what they asked for, not a view of the
       studio's. */
    params.push(req.user.id);
    where.push(`d.requested_by = $${params.length}`);
  }
  if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  const { rows } = await db.query(
    `SELECT d.*, r.\`name\` AS requester_name, v.\`name\` AS resolver_name
       FROM deletion_requests d
       LEFT JOIN users r ON r.id = d.requested_by
       LEFT JOIN users v ON v.id = d.resolved_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.status = 'open' DESC, d.created_at DESC
      LIMIT 500`,
    params
  );
  res.json({
    requests: rows.map((r) => ({
      id: r.id, path: r.path, type: r.type, reason: r.reason, status: r.status,
      requestedBy: r.requested_by, requesterName: r.requester_name || r.requester_email || null,
      resolvedBy: r.resolved_by, resolverName: r.resolver_name || r.resolver_email || null,
      resolvedAt: r.resolved_at, adminNote: r.admin_note, createdAt: r.created_at,
    })),
    mayManage,
  });
});

router.post('/deletion-requests', requirePermission('server.request_delete'), async (req, res) => {
  const body = req.body || {};
  const scoped = await scopeFor(req.user, body.path || '');
  if (!scoped.ok) return res.status(scoped.status).json({ error: scoped.error });
  if (!scoped.path) return res.status(400).json({ error: 'Choose a file or folder first.' });
  const type = body.type === 'folder' ? 'folder' : 'file';
  const reason = String(body.reason === undefined || body.reason === null ? '' : body.reason).trim();
  if (!reason) return res.status(400).json({ error: 'Say why it should be deleted.' });
  if (reason.length > 1000) return res.status(400).json({ error: 'That reason is too long; 1000 characters is the limit.' });

  const id = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO deletion_requests (id, path, \`type\`, requested_by, requester_email, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, scoped.path, type, req.user.id, req.user.email, reason]
    );
  } catch (err) {
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      /* The unique key on the open-path hash, surfacing as a sentence. A second
         request while one is open is not a mistake worth two rows — whoever
         answers it would have to answer both with the same action. */
      const { rows } = await db.query(
        `SELECT d.id, d.created_at, u.\`name\` AS requester_name FROM deletion_requests d
           LEFT JOIN users u ON u.id = d.requested_by
          WHERE d.status = 'open' AND LOWER(d.path) = LOWER($1) LIMIT 1`, [scoped.path]
      );
      const open = rows[0];
      return res.status(409).json({
        error: open && open.requester_name
          ? `${open.requester_name} has already asked for this to be deleted, and that request is still open.`
          : 'There is already an open deletion request for this.',
        code: 'already_requested',
        requestId: open ? open.id : null,
      });
    }
    throw err;
  }

  /* WHO HEARS ABOUT IT: everybody holding server.manage_requests, which is the
     default the brief asked for. Computed from role permissions rather than
     from a stored recipient list, so granting the key is the whole of adding
     somebody to the rota. */
  const recipients = await rolePermissions.usersWithPermission(db, 'server.manage_requests');
  const sentence = `${req.user.name || 'Somebody'} asked for ${scoped.path} to be deleted: ${reason}`;
  for (const person of recipients) {
    if (person.id === req.user.id) continue;
    await notifications.raise(db, {
      recipientId: person.id, actorId: req.user.id,
      kind: notifications.KINDS.server_delete_request, detail: sentence,
    });
  }
  if (serverSettings.current().emailOnDeleteRequests) {
    /* Through the existing outbox, so a mail server that is down delays a
       notice rather than failing the request. In-app is always on; this is the
       half an admin can switch off. */
    emailNotifications.deletionRequested(db, {
      recipients, actor: req.user, path: scoped.path, type, reason, requestId: id,
    }).catch((err) => console.error('[server] could not queue the deletion-request email:', err.message));
  }

  await audit({ userId: req.user.id, userEmail: req.user.email, ip: req.ip, action: 'delete_requested', path: scoped.path });
  activity.record(db, {
    req, module: 'settings', action: 'server.deletion.request', entityId: id,
    summary: `Asked for ${scoped.path} to be deleted from the office server`,
    after: { path: scoped.path, type, reason },
  }).catch(() => {});

  res.status(201).json({ id, path: scoped.path, type, status: 'open', notified: recipients.length });
});

/* Resolve. THE ONE THING THIS DOES NOT DO IS DELETE ANYTHING.
 *
 * "Done" means a person removed the file on the office server, which is an
 * IT-admin action taken on that machine — see gateway/README.md. Forge holds no
 * route, no credential and no code that could remove a stored file, so this
 * endpoint writes a status and tells the requester. */
router.post('/deletion-requests/:id/resolve', requirePermission('server.manage_requests'), async (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (!['done', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'A request is either done or declined.' });
  }
  const note = String((req.body && req.body.note) || '').trim().slice(0, 1000) || null;
  const { rows } = await db.query('SELECT * FROM deletion_requests WHERE id = $1', [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).json({ error: 'No such request.' });
  if (request.status !== 'open') {
    return res.status(409).json({ error: `That request was already ${request.status}.`, code: 'already_resolved' });
  }
  await db.query(
    `UPDATE deletion_requests SET status = $1, resolved_by = $2, resolver_email = $3,
            resolved_at = NOW(), admin_note = $4
      WHERE id = $5 AND status = 'open'`,
    [status, req.user.id, req.user.email, note, request.id]
  );

  if (request.requested_by && request.requested_by !== req.user.id) {
    const words = status === 'done'
      ? `${req.user.name || 'An admin'} removed ${request.path} from the office server.`
      : `${req.user.name || 'An admin'} declined to delete ${request.path}.`;
    await notifications.raise(db, {
      recipientId: request.requested_by, actorId: req.user.id,
      kind: notifications.KINDS.server_delete_resolved,
      detail: note ? `${words} ${note}` : words,
    });
    emailNotifications.deletionResolved(db, {
      requesterId: request.requested_by, actor: req.user, path: request.path, status, note,
    }).catch((err) => console.error('[server] could not queue the deletion-resolved email:', err.message));
  }

  activity.record(db, {
    req, module: 'settings', action: `server.deletion.${status}`, entityId: request.id,
    summary: `Marked the deletion request for ${request.path} ${status}`,
    before: { status: 'open' }, after: { status, note },
  }).catch(() => {});

  res.json({ ok: true, id: request.id, status });
});

/* GET /api/server/audit — who did what, and to which path. */
router.get('/audit', requirePermission('server.view_audit'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const params = [];
  const where = [];
  if (req.query.action) { params.push(String(req.query.action).slice(0, 24)); where.push(`e.action = $${params.length}`); }
  if (req.query.userId) { params.push(String(req.query.userId).slice(0, 36)); where.push(`e.user_id = $${params.length}`); }
  const { rows } = await db.query(
    `SELECT e.*, u.\`name\` AS user_name FROM server_events e
       LEFT JOIN users u ON u.id = e.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const { rows: counted } = await db.query(
    `SELECT COUNT(*) AS n FROM server_events e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params
  );
  res.json({
    events: rows.map((r) => ({
      id: r.id, at: r.at, action: r.action, path: r.path, size: r.size === null ? null : Number(r.size),
      sha256: r.sha256, ip: r.ip, userId: r.user_id, userName: r.user_name || r.user_email || null,
    })),
    total: Number(counted[0].n),
    limit,
    offset,
  });
});

module.exports = router;
module.exports.HEARTBEAT_STALE_SECONDS = HEARTBEAT_STALE_SECONDS;
