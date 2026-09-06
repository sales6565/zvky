const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const emailConfig = require('../email-config');
const emailSecret = require('../email-secret');
const emailNotifications = require('../email-notifications');
const mailer = require('../mailer');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Where the studio's email goes out from.
//
// Its own permission, and the narrowest kind — Super Admin only, the same front
// door as the two IP lists. See the note on settings.email_config in
// src/permission-catalog.js.
router.use(authenticate);
router.use(requirePermission('settings.email_config'));

/* THE PASSWORD NEVER LEAVES THIS SERVER.
 *
 * There is no route below that returns it, no query in this file that selects
 * it, and emailConfig.current() cannot carry it — it is dropped at the cache
 * boundary in src/email-config.js rather than deleted here. This constant is
 * what the screen shows in its place, and it is deliberately not the right
 * length: a mask that matched the real length would leak how long the password
 * is to anybody watching the screen. */
const MASK = '••••••••••••';

/* GET /api/email-config
 *
 * Everything the screen needs to tell the truth about the state of email —
 * which is more than "here are the values". A screen that shows a filled-in
 * form and says nothing else cannot distinguish "working", "saved but switched
 * off", "switched on but the last send failed" and "the encryption key changed
 * so the stored password is unreadable", and those need four different actions.
 */
router.get('/', async (req, res) => {
  const config = emailConfig.current();
  res.json({
    config: {
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      encryption: config.encryption,
      username: config.username,
      fromName: config.fromName,
      fromAddress: config.fromAddress,
      // Never the value. Only whether there is one, and the placeholder to show.
      hasPassword: config.hasPassword,
      passwordMask: config.hasPassword ? MASK : '',
    },
    encryptions: Object.entries(emailConfig.ENCRYPTIONS)
      .map(([key, v]) => ({ key, label: v.label, port: v.port })),
    state: await state(config),
    lastTestAt: config.lastTestAt,
    lastError: config.lastError,
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt,
  });
});

/* What is actually true about email right now, in one word and one sentence.
 *
 * The key check is the one worth having: a rotated JWT_SECRET leaves a screen
 * that looks perfectly configured and an application that cannot send anything,
 * and without this the only symptom is mail quietly not arriving. */
async function state(config) {
  if (!emailSecret.available()) {
    return { key: 'no-key', ok: false,
      message: 'This server has no key to encrypt the mail password with. Set EMAIL_ENCRYPTION_KEY '
        + 'in the environment (or JWT_SECRET) and restart before saving a password.' };
  }
  if (config.hasPassword && config.passwordKeyId
      && config.passwordKeyId !== emailSecret.currentFingerprint()) {
    return { key: 'key-changed', ok: false,
      message: 'The stored password was encrypted with a different key than this server now has — '
        + 'EMAIL_ENCRYPTION_KEY or JWT_SECRET has changed since it was saved. Enter the password '
        + 'again to store it under the current key.' };
  }
  if (!config.host || !config.fromAddress) {
    return { key: 'unconfigured', ok: false,
      message: 'Not set up yet. Fill in the mail server and the From address, then send a test.' };
  }
  if (!config.enabled) {
    return { key: 'off', ok: false,
      message: 'Saved, but the master switch is off — no task emails are being sent.' };
  }
  if (config.lastError) {
    return { key: 'failing', ok: false,
      message: 'On, but the last send failed. The reason is below.' };
  }
  return { key: 'on', ok: true,
    message: 'On. Assignment and submission emails are being sent to everyone who has not opted out.' };
}

/* PUT /api/email-config — save.
 *
 * `password` absent means "leave the stored one alone", which is what the form
 * sends whenever somebody edits the host without touching the password box.
 * See the note on save() in src/email-config.js for the three cases. */
router.put('/', async (req, res) => {
  const body = req.body || {};

  /* The mask, sent back. The browser puts it in the field as a placeholder, and
     a form that posts its own placeholder would otherwise save the bullets as
     the password. Treated as "unchanged" rather than rejected, because it is
     the form doing something reasonable rather than a person doing something
     wrong. */
  const input = { ...body };
  if (input.password === MASK) delete input.password;

  const result = await emailConfig.save(db, input, { actorEmail: req.user.email });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  }

  /* Recorded, without the one field that must never be recorded.
   *
   * changes carries "password: set/cleared" and NEVER the value — not the new
   * one, not the old one, not its length. The Activity Log is read back by the
   * API and rendered in a page; a credential in it would be a credential
   * sitting in a second table in plain text and on somebody's screen. The same
   * rule the password_reset notification follows, for the same reason. */
  const before = result.before;
  const after = result.config;
  const changes = {};
  for (const [field, from, to] of [
    ['enabled', before.enabled, after.enabled],
    ['host', before.host, after.host],
    ['port', before.port, after.port],
    ['encryption', before.encryption, after.encryption],
    ['username', before.username, after.username],
    ['fromName', before.fromName, after.fromName],
    ['fromAddress', before.fromAddress, after.fromAddress],
  ]) {
    if (String(from ?? '') !== String(to ?? '')) changes[field] = { from: from ?? null, to: to ?? null };
  }
  if (result.changedPassword) {
    changes.password = { from: before.hasPassword ? 'set' : null, to: after.hasPassword ? 'set' : null };
  }

  req.activity({
    module: 'settings', action: 'email.config_updated', entityType: 'email', entityId: 'email-config',
    entityLabel: after.host || '(no server)',
    summary: Object.keys(changes).length
      ? `Changed the email configuration (${Object.keys(changes).join(', ')})`
      : 'Saved the email configuration with no changes',
    changes: Object.keys(changes).length ? changes : null,
  });

  const config = emailConfig.current();
  return res.json({
    config: {
      enabled: config.enabled, host: config.host, port: config.port, encryption: config.encryption,
      username: config.username, fromName: config.fromName, fromAddress: config.fromAddress,
      hasPassword: config.hasPassword, passwordMask: config.hasPassword ? MASK : '',
    },
    state: await state(config),
  });
});

/* POST /api/email-config/test — send a real message, now.
 *
 * Takes the values ON THE FORM rather than the ones in the database, which is
 * the whole point of the button: somebody typing a server name in for the first
 * time needs to know it works BEFORE they commit it, and a test that could only
 * check saved settings would mean saving a broken configuration to find out it
 * was broken.
 *
 * The password is the exception, and has to be: the form does not hold it after
 * the first save. A blank or masked password box means "use the stored one",
 * so the common case — testing a saved setup — works without retyping it.
 */
router.post('/test', async (req, res) => {
  const body = req.body || {};
  const to = String(body.to || req.user.email || '').trim();
  if (!to) return res.status(400).json({ error: 'No address to send the test to.' });

  const saved = emailConfig.current();
  const useForm = body.host !== undefined;
  const config = useForm ? {
    host: String(body.host || '').trim(),
    port: Number(body.port) || 587,
    encryption: emailConfig.ENCRYPTIONS[body.encryption] ? body.encryption : 'tls',
    username: String(body.username || '').trim(),
    fromName: String(body.fromName ?? saved.fromName ?? '').trim(),
    fromAddress: String(body.fromAddress ?? saved.fromAddress ?? '').trim(),
  } : { ...saved };

  if (!config.host) return res.status(400).json({ error: 'Enter a mail server first.', field: 'host' });
  if (!config.fromAddress) return res.status(400).json({ error: 'Enter a From address first.', field: 'fromAddress' });

  // Typed now, or the stored one — never both, and never echoed back.
  let password = body.password === undefined || body.password === '' || body.password === MASK
    ? null : String(body.password);
  if (password === null && config.username) {
    const stored = await emailConfig.transportPassword(db);
    if (!stored.ok) return res.status(400).json({ error: stored.error, field: 'password' });
    password = stored.value;
  }

  const message = emailNotifications.testMessage({ to, byName: req.user.name || req.user.email });
  const result = await mailer.send({ ...config, password }, message);

  /* Recorded either way. A failed test is the more interesting of the two to
     find in the log later — it is the thing somebody was doing just before they
     said "email does not work". */
  req.activity({
    module: 'settings', action: 'email.test_sent', entityType: 'email', entityId: 'email-config',
    entityLabel: config.host,
    summary: result.ok
      ? `Sent a test email to ${to} via ${config.host}`
      : `Test email to ${to} via ${config.host} failed`,
    changes: result.ok ? null : { error: { from: null, to: String(result.error).slice(0, 180) } },
  });

  /* Only recorded against the saved configuration when that is what was tested.
     A failed test of some values somebody was trying out should not leave the
     screen claiming the SAVED setup is broken. */
  if (!useForm) await emailConfig.noteResult(db, result);

  if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
  return res.json({ ok: true, sentTo: to });
});

module.exports = router;
