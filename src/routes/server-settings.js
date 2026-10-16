/* SETTINGS -> SERVER. The Super Admin's screen for the office file gateway.
 *
 * ONE KEY, settings.server.manage, and requirePermission rather than
 * requireSuperAdmin for the reason src/routes/nudges.js sets out: the tier
 * passes requireSuperAdmin while the browser's can() knows nothing about
 * tiers, and a page written against one with a route written against the other
 * is a divergence this application has already been bitten by. The Super Admin
 * still passes, because every permission is implied for that tier.
 *
 * NOTHING HERE EVER RETURNS A SECRET. The private signing key and the gateway
 * secret are write-only: generated here, stored encrypted, and afterwards
 * readable only as a fingerprint and a date. The one exception is the moment of
 * creation — a generated gateway secret is returned ONCE, because it has to be
 * pasted into the gateway machine's GATEWAY_SECRET and there is nowhere else it
 * could come from. That is the same bargain src/routes/integration-admin.js
 * already makes for an integration key, and the page says "copy it now" in as
 * many words. A test asserts no other response can carry either value.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const activity = require('../activity');
const serverSettings = require('../server-settings');
const serverFolders = require('../server-folders');
const serverTokens = require('../server-tokens');

router.use(authenticate);
router.use(requirePermission('settings.server.manage'));

async function state() {
  const { rows } = await db.query('SELECT * FROM gateway_state WHERE id = 1').catch(() => ({ rows: [] }));
  const row = rows[0] || {};
  const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
  return {
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
    ageSeconds: lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 1000) : null,
    version: row.version || null,
    freeBytes: row.free_bytes === null || row.free_bytes === undefined ? null : Number(row.free_bytes),
    configVersion: row.config_version === null || row.config_version === undefined ? null : Number(row.config_version),
    queued: row.queued === null || row.queued === undefined ? null : Number(row.queued),
    remoteIp: row.remote_ip || null,
    staleAfterSeconds: 120,
  };
}

router.get('/', async (req, res) => {
  const gateway = await state();
  res.json({
    settings: serverSettings.summarise({ state: gateway }),
    gateway,
    /* READ-ONLY. The link is edited on the project, beside the project's other
       fields, by whoever edits projects — not in a second place with a second
       permission. What this screen shows is the consequence: every project, its
       link, whether that link is usable and why not, and when it was last
       uploaded to. */
    projects: await serverFolders.overview(db),
  });
});

router.patch('/', async (req, res) => {
  const result = await serverSettings.save(db, req.body || {}, req.user);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.errors.join(' '), errors: result.errors });
  const lines = serverSettings.describeChange(result.before, result.settings);
  if (lines.length) {
    activity.record(db, {
      req, module: 'settings', action: 'server.settings.save',
      summary: `Changed the office file server settings: ${lines.join('; ')}`,
      // Secrets are not in either side of this: describeChange never names one.
      before: null, after: { changes: lines },
    }).catch(() => {});
    console.log(`${req.user.email} changed the office file server settings — ${lines.join('; ')}`);
  }
  const gateway = await state();
  res.json({
    settings: serverSettings.summarise({ state: gateway }),
    gateway, changes: lines,
    projects: await serverFolders.overview(db),
  });
});

/* Generate or rotate the token signing key pair. The public half and its id
   come back so IT can see which key a gateway should be verifying with; the
   private half is encrypted into the row and never leaves this process. */
router.post('/keys', async (req, res) => {
  const out = await serverSettings.generateKeyPair(db, req.user);
  if (!out.ok) return res.status(out.status || 409).json({ error: out.error });
  activity.record(db, {
    req, module: 'settings', action: out.rotated ? 'server.key.rotate' : 'server.key.generate',
    summary: out.rotated
      ? `Rotated the office file server signing key (new key ${out.kid}; ${out.previousKid} stays valid until ${out.previousUntil})`
      : `Generated the office file server signing key (${out.kid})`,
    after: { kid: out.kid, previousKid: out.previousKid },
  }).catch(() => {});
  const gateway = await state();
  res.json({ ...out, settings: serverSettings.summarise({ state: gateway }) });
});

/* Generate or regenerate the gateway secret. SHOWN ONCE. */
router.post('/secret', async (req, res) => {
  const out = await serverSettings.generateSecret(db, req.user);
  if (!out.ok) return res.status(out.status || 409).json({ error: out.error });
  activity.record(db, {
    req, module: 'settings', action: out.regenerated ? 'server.secret.rotate' : 'server.secret.generate',
    summary: out.regenerated
      ? `Regenerated the office file gateway secret (the previous one stays valid until ${out.previousUntil})`
      : 'Generated the office file gateway secret',
    // The fingerprint, never the secret.
    after: { fingerprint: out.fingerprint },
  }).catch(() => {});
  const gateway = await state();
  res.json({
    ok: true,
    secret: out.secret,
    shownOnce: true,
    regenerated: out.regenerated,
    previousUntil: out.previousUntil,
    settings: serverSettings.summarise({ state: gateway }),
  });
});

/* WHICH PROJECTS MAY USE THE SUBMIT-WORK UPLOAD.
 *
 * The allowlist behind "Enable for: Selected projects". A flag per project,
 * set here rather than on the project form, because deciding which projects are
 * in a pilot is an administrator's decision about the rollout — not a property
 * of the project that whoever edits projects should be changing.
 *
 * There is deliberately no folder mapping to edit here any more: a project's
 * folder is its LINK, typed on the project beside its other fields. One place.
 */
router.patch('/projects/:projectId/submit', async (req, res) => {
  const on = Boolean((req.body || {}).enabled);
  const { rows } = await db.query('SELECT id, `name`, server_link FROM projects WHERE id = $1', [req.params.projectId]);
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });
  if (on && !rows[0].server_link) {
    return res.status(409).json({
      error: `${rows[0].name} has no server folder link yet. Add one on the project first.`,
      code: 'no_link',
    });
  }
  await db.query('UPDATE projects SET server_submit_enabled = $1 WHERE id = $2', [on ? 1 : 0, req.params.projectId]);
  activity.record(db, {
    req, module: 'settings', action: on ? 'server.submit.enable' : 'server.submit.disable',
    entityId: req.params.projectId, entityLabel: rows[0].name,
    summary: `${on ? 'Enabled' : 'Disabled'} the Submit Work upload for ${rows[0].name}`,
    after: { submitEnabled: on },
  }).catch(() => {});
  res.json({ ok: true, enabled: on, projects: await serverFolders.overview(db) });
});

/* GET /api/admin/settings/server/legacy-files — what is still on this host.
 *
 * The inventory the migration tool walks. Rows in asset_versions that still
 * carry a file_path: submissions made before the office file server existed.
 * Nothing writes into those columns any more, so this list only ever shrinks.
 *
 * It is NOT a file index of the share — it is a list of what is on THIS server
 * and should not be. The distinction is the whole point: this endpoint exists so
 * the list can be emptied.
 */
router.get('/legacy-files', (req, res, next) => {
  /* BEHIND THE SWITCH as well as behind the permission. This endpoint lists
     what is still on the hosting, which is only a question worth answering once
     the office file server exists; with the feature off it does not exist, and
     an endpoint that enumerates a studio's submissions should not be reachable
     for a feature nobody has turned on. */
  if (!serverSettings.serverEnabled()) {
    return res.status(409).json({ error: 'The Server tab is switched off.', code: 'feature_disabled' });
  }
  return next();
}, async (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
  const { rows } = await db.query(
    `SELECT v.id, v.asset_id, v.file_name, v.file_size, v.version_number, v.created_at,
            a.\`code\` AS asset_code, a.project_id, p.\`name\` AS project_name, p.server_folder
       FROM asset_versions v
       JOIN assets a ON a.id = v.asset_id
       JOIN projects p ON p.id = a.project_id
      WHERE v.file_path IS NOT NULL AND v.file_path <> ''
      ORDER BY p.\`name\`, a.\`code\`, v.version_number
      LIMIT ${limit}`
  );
  const { rows: counted } = await db.query(
    "SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS bytes FROM asset_versions WHERE file_path IS NOT NULL AND file_path <> ''"
  );
  res.json({
    files: rows.map((r) => ({
      versionId: r.id,
      assetId: r.asset_id,
      assetCode: r.asset_code,
      projectId: r.project_id,
      projectName: r.project_name,
      // Where it should land. Null when the project has never claimed a folder;
      // the tool asks Forge to claim one by reading the mapping first.
      folder: r.server_folder || null,
      name: r.file_name,
      size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      version: r.version_number,
      // The download this host still serves, which is what the tool pulls from.
      download: `/api/assets/versions/${r.id}/download`,
    })),
    total: Number(counted[0].n),
    totalBytes: Number(counted[0].bytes),
    serveLegacy: serverSettings.current().serveLegacy,
  });
});

/* THE SELF-TEST. Forge cannot reach the gateway — that is the whole shape of
 * this feature — so this endpoint does the half it CAN do and hands the browser
 * everything it needs to do the rest from the office network.
 *
 * Forge's half: is the feature configured, is a key and a secret stored, is the
 * heartbeat fresh, how much disk is left, does the gateway's applied
 * configuration match the saved one. The browser's half: reach the gateway's
 * /health over TLS, then write a kilobyte into .incoming/selftest and read it
 * back with the two self-test tokens minted below. Each step is reported on its
 * own so a failure says WHICH thing is wrong.
 */
router.post('/self-test', async (req, res) => {
  const settings = serverSettings.current();
  const gateway = await state();
  const ready = serverSettings.readiness(gateway);
  const steps = [
    { key: 'configured', ok: ready.gatewayUrl && ready.gatewayId,
      detail: ready.gatewayUrl && ready.gatewayId ? settings.gatewayUrl : 'Set the gateway address and id.' },
    /* THE TWO NAMES FOR ONE PLACE, SHOWN TOGETHER. The prefix is the share as
       the studio writes it; FILE_ROOT is the same share as the gateway machine
       sees it. Nothing can check that they match — one is a string here and the
       other is a mount point in another building — so they are put side by side
       and a person confirms it. That is the single most common way to configure
       this wrongly. */
    { key: 'link_prefix', ok: Boolean(settings.linkPrefix),
      detail: settings.linkPrefix
        ? `Project links must start with ${settings.linkPrefix} — the gateway serves FILE_ROOT, `
          + 'which must be the same share. Check the two against each other.'
        : 'Set the server link prefix: the share as the studio writes it, e.g. \\\\SERVER\\Projects.' },
    { key: 'encryption', ok: ready.encryptionAvailable,
      detail: ready.encryptionAvailable ? 'Secrets can be encrypted at rest.' : 'Set EMAIL_ENCRYPTION_KEY (or JWT_SECRET) and restart.' },
    { key: 'signing_key', ok: ready.keyGenerated, detail: ready.keyGenerated ? `Key ${settings.signingKid}` : 'Generate a key pair.' },
    { key: 'gateway_secret', ok: ready.secretGenerated, detail: ready.secretGenerated ? 'Stored.' : 'Generate a secret and put it in the gateway\'s GATEWAY_SECRET.' },
    { key: 'heartbeat', ok: ready.heartbeatFresh,
      detail: gateway.lastSeen
        ? `Last heard ${gateway.ageSeconds}s ago${gateway.version ? ` (version ${gateway.version})` : ''}`
        : 'No heartbeat has ever arrived. Is the gateway running, and is FORGE_URL right?' },
    { key: 'config_applied', ok: ready.configApplied,
      detail: ready.configApplied
        ? `The gateway is running configuration version ${gateway.configVersion}.`
        : `Saved version ${settings.configVersion}; the gateway reports ${gateway.configVersion === null ? 'nothing yet' : gateway.configVersion}.` },
    { key: 'disk', ok: gateway.freeBytes === null ? false : gateway.freeBytes > 1024 ** 3,
      detail: gateway.freeBytes === null ? 'Not reported yet.' : `${(gateway.freeBytes / (1024 ** 3)).toFixed(1)} GB free on the share.` },
  ];

  /* The browser's half needs tokens. Minted only if there is a key — and for
     the selftest operation only, which the gateway will let nowhere near the
     studio's folders. */
  let probe = null;
  if (ready.keyGenerated && ready.gatewayId) {
    const key = serverSettings.signingKey();
    if (key.ok) {
      const put = serverTokens.mint({ privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId, userId: req.user.id, op: 'selftest', path: '' });
      const get = serverTokens.mint({ privateKey: key.privateKey, kid: key.kid, audience: settings.gatewayId, userId: req.user.id, op: 'selftest', path: '' });
      probe = { gatewayUrl: settings.gatewayUrl, putToken: put.token, getToken: get.token, bytes: 1024 };
    }
  }
  res.json({ steps, gateway, readiness: ready, probe, checklist: ready });
});

module.exports = router;
