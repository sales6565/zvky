/* Settings -> Dev & QA Integration. The screen that issues the credentials.
 *
 * SUPER ADMIN ONLY, and enforced here rather than by the screen hiding a button. Every
 * route in this file sits behind requirePermission('settings.integrations'), which is not
 * grantable to any other designation — see the reasoning on that key in
 * src/permission-catalog.js: a credential is a machine with no projectScope, so it reads
 * every project and asset in the studio, and whoever can issue one can therefore reach
 * data their own designation does not give them.
 *
 * THE KEY IS SHOWN ONCE. Only its SHA-256 hash is stored, so there is nothing to show
 * later even to a Super Admin — which is the same shape as the mail password in
 * src/email-config.js, where the ciphertext is dropped at the boundary and the screen is
 * told only `hasPassword`. Here there is not even ciphertext: a hash cannot be reversed,
 * and that is the point.
 *
 * AND THE TWO HMAC SECRETS ARE NOT EDITABLE HERE, on purpose. They stay in the
 * environment. A web form would put them in the database, and this deployment's
 * database-stored secrets are encrypted by src/email-secret.js with a key that falls back
 * to JWT_SECRET — which on this deployment is still the shipped placeholder. So moving
 * them would add a layer that protects nothing while still depending on the environment.
 * What IS editable here is the Dev & QA address, which is not a secret: email_config
 * already keeps the mail server's host and port in the database for a screen to edit, and
 * this is the same kind of value.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const crypto = require('node:crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const activity = require('../activity');
const list = require('../integration-ip-allowlist');
const ipGate = require('../middleware/integration-ip-allowlist');
const outbox = require('../integration-outbox');
const ipMatch = require('../ip-match');

router.use(authenticate);
router.use(requirePermission('settings.integrations'));

/* How long both keys work after a rotation. The agreed 24 hours, named here because the
   screen quotes it and the check in src/middleware/service-auth.js measures against the
   column this writes — two readers, one number. */
const OVERLAP_HOURS = Number(process.env.INTEGRATION_KEY_OVERLAP_HOURS || 24);

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/* A key the caller will paste into another system's configuration. 32 random bytes as
   hex: long enough that guessing is not a strategy, and hex rather than base64 so it
   survives every config file, shell and environment variable it will be pasted into
   without anybody having to think about quoting. The prefix is stored so the screen can
   say WHICH key a client holds without holding it. */
function mintKey() {
  const secret = crypto.randomBytes(32).toString('hex');
  return { secret, hash: sha256(secret), prefix: secret.slice(0, 8) };
}

const parseActions = (value) => {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(items.map((s) => String(s).trim().toLowerCase()).filter(Boolean))].sort();
};

/* Never the hash, never the key. What the screen may know about a credential is its name,
   whether it works, what it may do, when it was last used, and which key it is on. */
const shapeClient = (row) => ({
  id: row.id,
  name: row.name,
  isActive: Boolean(Number(row.is_active)),
  allowedActions: parseActions(row.allowed_actions),
  keyPrefix: row.key_prefix || null,
  keyIssuedAt: row.key_issued_at || row.created_at,
  lastUsedAt: row.last_used_at || null,
  createdBy: row.created_by_email || null,
  createdAt: row.created_at,
  /* Whether a rotation is still in its overlap, and for how long. The screen shows this
     because an integration still on its previous key when the window closes will simply
     stop working, and that is worth knowing before it happens rather than after. */
  rotation: row.prev_key_hash && row.prev_key_expires_at && new Date(row.prev_key_expires_at) > new Date()
    ? { previousKeyValidUntil: row.prev_key_expires_at }
    : null,
});

const CLIENT_FIELDS = 'id, `name`, key_prefix, allowed_actions, is_active, last_used_at, '
  + 'prev_key_hash, prev_key_expires_at, key_issued_at, created_by_email, created_at';

const checkName = (value) => {
  const name = String(value || '').trim();
  if (!name) return { ok: false, error: 'Give the integration a name.', field: 'name' };
  if (name.length > 120) return { ok: false, error: 'That name is too long (120 characters).', field: 'name' };
  return { ok: true, name };
};

// --- the credentials ---------------------------------------------------------

// GET /api/admin/integration/clients
router.get('/clients', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${CLIENT_FIELDS} FROM integration_clients ORDER BY created_at DESC`
  ).catch((err) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return { rows: null };
    throw err;
  });
  if (rows === null) {
    return res.json({ clients: [], unavailable: 'The integration tables are not on this database yet.' });
  }
  res.json({ clients: rows.map(shapeClient), overlapHours: OVERLAP_HOURS });
});

/* POST /api/admin/integration/clients — issue one.
 *
 * THE ONLY RESPONSE THAT EVER CARRIES THE KEY. Everything after this can say which key a
 * client is on (the prefix) and never what it is. */
router.post('/clients', async (req, res) => {
  const named = checkName(req.body && req.body.name);
  if (!named.ok) return res.status(400).json({ error: named.error, field: named.field });

  const actions = parseActions(req.body && req.body.allowedActions);
  if (!actions.length) {
    return res.status(400).json({
      error: 'Say what this integration may do — at least one action.',
      field: 'allowedActions',
    });
  }

  const key = mintKey();
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO integration_clients
         (id, \`name\`, key_hash, key_prefix, allowed_actions, is_active, key_issued_at,
          created_by_id, created_by_email)
       VALUES ($1,$2,$3,$4,$5,1,NOW(),$6,$7)`,
      [id, named.name, key.hash, key.prefix, actions.join(','), req.user.id, req.user.email]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An integration with that name already exists.', field: 'name' });
    }
    throw err;
  }

  const { rows } = await db.query(`SELECT ${CLIENT_FIELDS} FROM integration_clients WHERE id = $1`, [id]);
  activity.record(db, {
    req, module: 'settings', action: 'integration.client.create', entityId: id,
    summary: `Issued an integration key for ${named.name}`,
    after: { name: named.name, allowedActions: actions },
  }).catch(() => {});

  res.status(201).json({
    client: shapeClient(rows[0]),
    // Once. There is no second chance and the screen says so.
    key: key.secret,
    keyShownOnce: true,
  });
});

/* POST /api/admin/integration/clients/:id/rotate — a new key, with the old one still
 * working for the overlap.
 *
 * The previous HASH moves across, not the key: there is no key here to move. */
router.post('/clients/:id/rotate', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, `name`, key_hash FROM integration_clients WHERE id = $1', [req.params.id]
  );
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'No such integration.' });

  const key = mintKey();
  await db.query(
    `UPDATE integration_clients
        SET prev_key_hash = key_hash,
            prev_key_expires_at = (NOW() + INTERVAL ${Number(OVERLAP_HOURS)} HOUR),
            key_hash = $1, key_prefix = $2, key_issued_at = NOW(), updated_at = NOW()
      WHERE id = $3`,
    [key.hash, key.prefix, client.id]
  );

  const after = await db.query(`SELECT ${CLIENT_FIELDS} FROM integration_clients WHERE id = $1`, [client.id]);
  activity.record(db, {
    req, module: 'settings', action: 'integration.client.rotate', entityId: client.id,
    summary: `Rotated the integration key for ${client.name} — the previous key works for `
      + `${OVERLAP_HOURS} more hours`,
  }).catch(() => {});

  res.json({
    client: shapeClient(after.rows[0]),
    key: key.secret,
    keyShownOnce: true,
    overlapHours: OVERLAP_HOURS,
  });
});

/* POST /api/admin/integration/clients/:id/revoke — stop it, and stop it NOW.
 *
 * Deactivates AND clears the rotation window, because a revocation that left a previous
 * key alive for another 23 hours would be the opposite of what the word means. The row
 * stays, so the activity log and the outbox history still name a credential that can be
 * looked up. */
router.post('/clients/:id/revoke', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, `name`, is_active FROM integration_clients WHERE id = $1', [req.params.id]
  );
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'No such integration.' });

  await db.query(
    'UPDATE integration_clients SET is_active = 0, prev_key_hash = NULL, '
    + 'prev_key_expires_at = NULL, updated_at = NOW() WHERE id = $1',
    [client.id]
  );
  const after = await db.query(`SELECT ${CLIENT_FIELDS} FROM integration_clients WHERE id = $1`, [client.id]);
  activity.record(db, {
    req, module: 'settings', action: 'integration.client.revoke', entityId: client.id,
    summary: `Revoked the integration key for ${client.name}`,
    before: { isActive: Boolean(Number(client.is_active)) }, after: { isActive: false },
  }).catch(() => {});

  res.json({ client: shapeClient(after.rows[0]) });
});

// Switching one back on, which is not the same as issuing a key: the key it had still
// works, because revoking never changed it.
router.post('/clients/:id/restore', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, `name` FROM integration_clients WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such integration.' });
  await db.query('UPDATE integration_clients SET is_active = 1, updated_at = NOW() WHERE id = $1',
    [req.params.id]);
  const after = await db.query(`SELECT ${CLIENT_FIELDS} FROM integration_clients WHERE id = $1`,
    [req.params.id]);
  activity.record(db, {
    req, module: 'settings', action: 'integration.client.restore', entityId: req.params.id,
    summary: `Restored the integration key for ${rows[0].name}`,
  }).catch(() => {});
  res.json({ client: shapeClient(after.rows[0]) });
});

// --- the integration's own address list --------------------------------------

/* GET /api/admin/integration/addresses — the list, and WHAT MODE IT IS IN.
 *
 * The mode matters more than the list on this screen. It ships in monitor, and shipping
 * this screen must not change that — so somebody adding addresses here needs to be told,
 * plainly, that nothing is being refused yet and that switching it on is an environment
 * change rather than a button. A screen that let this be enabled from inside the thing it
 * protects would be a safeguard you could lock yourself out with. */
router.get('/addresses', async (req, res) => {
  const settings = ipGate.config();
  const entries = await list.listAll(db).catch(() => null);
  const status = list.storageStatus();
  res.json({
    entries: entries || [],
    unavailable: entries ? null : (status.detail || 'The integration address list is unavailable.'),
    enforcement: {
      enabled: settings.enabled,
      mode: settings.mode,
      allowLoopback: settings.allowLoopback,
      allowPrivate: settings.allowPrivate,
      emergency: settings.emergency,
      // Said in words, because "monitor" alone has been read as "on" before.
      explain: settings.mode === 'enforce'
        ? 'Addresses not on this list are refused.'
        : 'MONITOR MODE: nothing is refused. What would have been refused is written to the '
          + 'log. Set INTEGRATION_IP_ALLOWLIST_MODE=enforce on the server to switch it on.',
    },
  });
});

router.post('/addresses', async (req, res) => {
  const address = String((req.body && req.body.address) || '').trim();
  const label = String((req.body && req.body.label) || '').trim() || null;
  if (!ipMatch.isValidEntry(address)) {
    return res.status(400).json({
      error: 'That is not an address or range this can match. Use 203.0.113.4 or 203.0.113.0/24.',
      field: 'address',
    });
  }
  /* The module's own contract: one options object, and it answers { ok, id } rather than
     the row. Read rather than assumed — a first version of this guessed { entry } and the
     test found it. */
  const added = await list.add(db, { address, label, actor: req.user });
  if (!added.ok) return res.status(400).json({ error: added.error, field: 'address' });
  activity.record(db, {
    req, module: 'settings', action: 'integration.address.add', entityId: added.id,
    summary: `Allowed ${address} to reach the integration API`, after: { address, label },
  }).catch(() => {});
  // Read back, so the screen gets the row as the list holds it rather than as this echoed it.
  const entries = await list.listAll(db).catch(() => []);
  res.status(201).json({ entry: entries.find((e) => e.id === added.id) || { id: added.id, address, label } });
});

router.delete('/addresses/:id', async (req, res) => {
  /* Read it BEFORE removing it, because remove() answers { ok } and the address is gone by
     the time it returns — and the log entry is worth more with the address in it than
     without. */
  const before = (await list.listAll(db).catch(() => [])).find((e) => e.id === req.params.id) || null;
  const removed = await list.remove(db, req.params.id, { actor: req.user });
  if (!removed.ok) return res.status(404).json({ error: removed.error });
  activity.record(db, {
    req, module: 'settings', action: 'integration.address.remove', entityId: req.params.id,
    summary: `Stopped ${before ? before.address : 'an address'} reaching the integration API`,
    before,
  }).catch(() => {});
  res.json({ removed: before || { id: req.params.id } });
});

// --- the message log ---------------------------------------------------------

/* GET /api/admin/integration/messages — the outbox, newest first.
 *
 * The same page bounds as everything else that pages in this application: 50 by default,
 * 200 at most. */
router.get('/messages', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || outbox.PAGE_DEFAULT, 1), outbox.PAGE_MAX);
  const status = String(req.query.status || '').trim().toLowerCase();
  const where = Object.values(outbox.STATUS).includes(status) ? 'WHERE `status` = $1' : '';
  const params = where ? [status] : [];

  const { rows } = await db.query(
    `SELECT id, seq, payload, \`status\`, attempts, next_attempt_at, last_error, created_at, updated_at
       FROM integration_outbox ${where} ORDER BY seq DESC LIMIT ${limit}`,
    params
  ).catch((err) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return { rows: null };
    throw err;
  });
  if (rows === null) return res.json({ messages: [], unavailable: 'The outbox table is not on this database yet.' });

  const counts = await db.query(
    'SELECT `status`, COUNT(*) AS n FROM integration_outbox GROUP BY `status`'
  ).catch(() => ({ rows: [] }));

  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      status: r.status,
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      payload: (() => { try { return JSON.parse(r.payload); } catch { return { unparsed: String(r.payload) }; } })(),
    })),
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
    limit,
    schedule: outbox.BACKOFF_SECONDS,
  });
});

/* POST /api/admin/integration/messages/:id/resend — try a failed row again.
 *
 * IT DOES NOT DELIVER ANYTHING ITSELF. It puts the row back to pending and due now, and
 * the worker in src/integration-outbox.js picks it up on its next pass — the same worker,
 * the same claim, the same retry schedule. A second delivery path here would be a second
 * place for the signing, the timeout and the backoff to be got wrong, and the one that
 * only ran when somebody clicked a button would be the one nobody noticed had rotted.
 *
 * attempts is reset, because a person deciding to try again is saying the reason it failed
 * has been dealt with — otherwise a row that had used its seven attempts would go straight
 * back to failed on the next pass and the button would appear to do nothing. */
router.post('/messages/:id/resend', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, `status` FROM integration_outbox WHERE id = $1', [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'No such message.' });
  if (row.status === outbox.STATUS.sending) {
    return res.status(409).json({
      error: 'That message is being delivered right now. Wait for it to finish.',
      code: 'message_in_flight',
    });
  }

  await db.query(
    'UPDATE integration_outbox SET `status` = $1, attempts = 0, next_attempt_at = NULL, '
    + 'last_error = NULL, updated_at = NOW() WHERE id = $2',
    [outbox.STATUS.pending, row.id]
  );
  activity.record(db, {
    req, module: 'settings', action: 'integration.message.resend', entityId: row.id,
    summary: 'Queued an integration message to be sent again',
    before: { status: row.status }, after: { status: outbox.STATUS.pending },
  }).catch(() => {});

  const after = await db.query(
    'SELECT `status`, attempts FROM integration_outbox WHERE id = $1', [row.id]
  );
  res.json({
    message: { id: row.id, status: after.rows[0].status, attempts: Number(after.rows[0].attempts) },
    // Said plainly, because "resend" reads as "sent" and it is not.
    queued: true,
    note: 'Queued. The delivery worker sends it on its next pass.',
  });
});

// --- health ------------------------------------------------------------------

/* GET /api/admin/integration/health — is this thing working?
 *
 * Two facts and a configuration summary. The two facts are the ones somebody actually
 * wants: has anything reached us, and has anything left. Both are read from the rows that
 * record them rather than from a self-test, so they say what HAS happened rather than what
 * would happen if it were tried now. */
router.get('/health', async (req, res) => {
  const inbound = await db.query(
    'SELECT `name`, last_used_at FROM integration_clients '
    + 'WHERE last_used_at IS NOT NULL ORDER BY last_used_at DESC LIMIT 1'
  ).catch(() => ({ rows: [] }));

  const outbound = await db.query(
    'SELECT id, seq, updated_at FROM integration_outbox WHERE `status` = $1 '
    + 'ORDER BY updated_at DESC LIMIT 1', [outbox.STATUS.sent]
  ).catch(() => ({ rows: [] }));

  const waiting = await db.query(
    'SELECT `status`, COUNT(*) AS n FROM integration_outbox '
    + 'WHERE `status` IN ($1, $2) GROUP BY `status`', [outbox.STATUS.pending, outbox.STATUS.failed]
  ).catch(() => ({ rows: [] }));

  const settings = outbox.config();
  res.json({
    inbound: inbound.rows[0]
      ? { at: inbound.rows[0].last_used_at, client: inbound.rows[0].name }
      : null,
    outbound: outbound.rows[0]
      ? { at: outbound.rows[0].updated_at, seq: Number(outbound.rows[0].seq) }
      : null,
    queue: Object.fromEntries(waiting.rows.map((r) => [r.status, Number(r.n)])),
    /* The configuration, WITHOUT the secrets. Whether each is set, never what it is —
       there is no reason for a browser to carry them and every reason not to. */
    configured: {
      outboundUrl: settings.url || null,
      outboundSecret: Boolean(settings.secret),
      inboundSecret: Boolean(process.env.INTEGRATION_INBOUND_SECRET),
      /* And the one misconfiguration worth shouting about: one secret for both directions
         means whoever can verify a message can also forge one. */
      secretsCollide: outbox.secretsCollide(),
      deliveryEvery: `${settings.sweepSeconds}s`,
    },
  });
});

module.exports = router;
