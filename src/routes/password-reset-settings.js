/* SETTINGS -> PASSWORD RESET. The default an admin reset gives out.
 *
 * ===========================================================================
 * ONE KEY, settings.default_password, ON EVERY ROUTE INCLUDING THE READ.
 *
 * The read is gated as tightly as the write, which is not the usual shape in
 * this application — most settings sections have a view key a studio can grant
 * separately. Not here, and the reason is what this screen says: it reports
 * whether a default is set and WHEN it was last changed. "A default was set
 * eleven minutes ago" is worth knowing to somebody trying accounts, and there
 * is nothing on this screen a person could usefully read without being trusted
 * to change it.
 *
 * ===========================================================================
 * THE VALUE IS NEVER IN A RESPONSE FROM HERE OR ANYWHERE.
 *
 * GET returns reset-password-settings' current(), which cannot carry it: the
 * sealed bytes are not in that module's cache at all. PUT /default takes a
 * value and returns the same shape, with defaultSet true and a date. There is
 * no GET that unseals, for anybody, at any permission level — see the note at
 * the top of src/reset-password-settings.js for why that is a decision rather
 * than a feature not yet built.
 *
 * tests/password-default.test.js walks every route in this file and asserts the
 * test run's own value appears in no response body.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const settings = require('../reset-password-settings');
const defaultPassword = require('../default-password');
const policy = require('../password-policy');

router.use(authenticate);
router.use(requirePermission('settings.default_password'));

/* WHAT THE SCREEN DRAWS. The two switches, the expiry, whether a default is
 * set and when — plus the policy rules, so the field can tick them off as
 * somebody types rather than after a round trip, and plus the sentence the
 * screen shows when there is no default to use. */
const shape = () => {
  const state = settings.current();
  const resolved = defaultPassword.resolve();
  return {
    ...state,
    /* WHICH SOURCE A RESET WOULD USE, as a word and never as a value.
       `environment` is a studio still on DEFAULT_USER_PASSWORD, which is worth
       saying out loud on this screen: it means resets work but the Super Admin
       cannot change the value from here. */
    source: resolved.source,
    willUseDefault: settings.useDefault() || resolved.source === 'environment',
    fallbackNote: resolved.value ? null : defaultPassword.refusal(),
    policy: policy.describe(),
    hours: { min: settings.HOURS_MIN, max: settings.HOURS_MAX },
  };
};

router.get('/', async (req, res) => {
  if (!settings.isLoaded()) await settings.load(db).catch(() => {});
  res.json({ settings: shape() });
});

/* PUT /api/admin/settings/password-reset — the two switches and the expiry.
 *
 * NOT the value: that is its own route below, so a request that changes a
 * switch cannot carry a password and a request that carries a password cannot
 * quietly change a switch. */
router.put('/', async (req, res) => {
  const verdict = settings.validateSwitches(req.body || {});
  if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: verdict.field });
  const sets = verdict.sets;
  if (!Object.keys(sets).length) return res.json({ ok: true, settings: shape(), unchanged: true });

  const before = settings.current();
  const columns = Object.keys(sets);
  const values = columns.map((c) => sets[c]);
  /* INSERT ... ON DUPLICATE KEY, because the migration seeds no row: the first
     save is what creates it, and every later one updates it. */
  await db.query(
    `INSERT INTO password_reset_settings (id, ${columns.join(', ')}, updated_by)
     VALUES (1, ${columns.map((_, i) => `$${i + 1}`).join(', ')}, $${columns.length + 1})
     ON DUPLICATE KEY UPDATE ${columns.map((c, i) => `${c} = $${i + 1}`).join(', ')},
       updated_by = $${columns.length + 1}`,
    [...values, req.user.id]
  );
  await settings.load(db);
  const after = settings.current();

  /* AUDITED WITH THE SWITCHES AND NOT WITH THE VALUE — there is no value in
     this request. The changes map names the fields that moved so the log reads
     as a change rather than as "settings saved". */
  const changes = {};
  for (const key of ['useDefault', 'forceChange', 'validHours']) {
    if (String(before[key]) !== String(after[key])) {
      changes[key] = { from: String(before[key]), to: String(after[key]) };
    }
  }
  if (Object.keys(changes).length) {
    req.activity({
      module: 'settings',
      action: 'settings.password_reset.update',
      entityType: 'settings',
      entityId: 'password-reset',
      entityLabel: 'Password reset',
      summary: 'Changed how an administrator reset sets a password',
      changes,
    });
  } else { req.activitySkip(); }
  res.json({ ok: true, settings: shape() });
});

/* PUT /api/admin/settings/password-reset/default — set the value.
 *
 * THE POLICY IS CHECKED BEFORE ANYTHING ELSE AND IS NOT BENT. A default that
 * could skip the rules would be a hole shaped exactly like this feature: not
 * one weak password but a weak password on every account anybody resets. The
 * unmet rules come back by the policy's own labels so the field can name them.
 *
 * NO KEY, NO SAVE. Without EMAIL_ENCRYPTION_KEY there is nowhere to put this
 * that is not plain text, so it is refused with the variable named rather than
 * stored in the clear. JWT_SECRET is deliberately not accepted — see
 * src/email-secret.js's strict mode. */
router.put('/default', async (req, res) => {
  const verdict = settings.validateDefault((req.body || {}).defaultPassword);
  if (!verdict.ok) {
    return res.status(400).json({
      error: verdict.error, field: verdict.field, failed: verdict.failed || [],
    });
  }
  if (!settings.encryptionAvailable()) {
    return res.status(409).json({
      code: 'no_encryption_key',
      error: 'This server has no key to encrypt the default password with. Set EMAIL_ENCRYPTION_KEY in '
        + 'the environment and restart. JWT_SECRET is deliberately not accepted for a stored password.',
    });
  }
  const sealed = settings.seal(verdict.value);
  if (!sealed.ok) return res.status(409).json({ error: sealed.error });

  await db.query(
    `INSERT INTO password_reset_settings (id, default_sealed, default_key_fp, default_set_at, updated_by)
     VALUES (1, $1, $2, NOW(), $3)
     ON DUPLICATE KEY UPDATE default_sealed = $1, default_key_fp = $2,
       default_set_at = NOW(), updated_by = $3`,
    [sealed.value, sealed.keyId, req.user.id]
  );
  await settings.load(db);

  /* "changed", AND NOT WHAT TO. No value, no length, no first character, no
     hash — a log that records any of those is a log that narrows a guess. The
     entry exists so there is a record of WHO and WHEN, which is what an
     investigation after a misused reset actually needs. */
  req.activity({
    module: 'settings',
    action: 'settings.default_password.change',
    entityType: 'settings',
    entityId: 'password-reset',
    entityLabel: 'Default reset password',
    summary: 'Changed the default password an administrator reset gives out',
  });
  res.json({ ok: true, settings: shape() });
});

/* DELETE /api/admin/settings/password-reset/default — back to having none.
 *
 * NOT IN THE BRIEF, and added because the brief asks the screen to have a "not
 * set" state and describe what happens in it. A state a screen can show and a
 * Super Admin cannot reach is a state nobody can get out of after a value has
 * been set once — the only way back would be the database. Clearing it returns
 * resets to the behaviour they had before this existed. */
router.delete('/default', async (req, res) => {
  if (!settings.current().defaultSet) {
    return res.json({ ok: true, settings: shape(), unchanged: true });
  }
  await db.query(
    `UPDATE password_reset_settings
        SET default_sealed = NULL, default_key_fp = NULL, default_set_at = NULL, updated_by = $1
      WHERE id = 1`,
    [req.user.id]
  );
  await settings.load(db);
  req.activity({
    module: 'settings',
    action: 'settings.default_password.clear',
    entityType: 'settings',
    entityId: 'password-reset',
    entityLabel: 'Default reset password',
    summary: 'Cleared the default password an administrator reset gives out',
  });
  res.json({ ok: true, settings: shape() });
});

module.exports = router;
