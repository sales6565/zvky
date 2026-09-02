const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { userFields } = require('../user-fields');
const { authenticate } = require('../middleware/auth');
const { capabilitiesFor, catalogue } = require('../roles');
const rolePermissions = require('../role-permissions');
const bootstrapToken = require('../bootstrap-token');
const passwordPolicy = require('../password-policy');

// bcrypt cost used everywhere passwords are hashed in this codebase.
const BCRYPT_ROUNDS = 10;

// One place that mints tokens, so the login and change-password paths cannot
// drift apart on lifetime or payload shape.
//
// The `pwd` claim carries the value of users.password_changed_at that was
// current when the token was issued. authenticate() requires it to still match,
// which is what signs out other devices after a password change.
//
// This deliberately does not compare against the token's own `iat`: that claim
// counts whole seconds, so a token minted in the same second as the change
// cannot be told apart from one minted just before it. Matching the stored
// value exactly has no such boundary.
function signToken(userId, passwordChangedAt) {
  return jwt.sign(
    { sub: userId, pwd: Number(passwordChangedAt) || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    /* Named columns, not *: the row below is sent to the browser, and `users`
       now carries the profile photo as a MEDIUMBLOB. See src/user-fields.js. */
    const { rows } = await db.query(
      `SELECT ${userFields(true)} FROM users WHERE lower(email) = lower($1)`, [email]);
    const user = rows[0];
    // Deliberately vague error so we don't reveal which part was wrong.
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user.id, user.password_changed_at);
    delete user.password_hash;
    user.capabilities = capabilitiesFor(user.role);
    // The same permission set authenticate() attaches to every later request.
    //
    // Sending it here matters because the browser keeps whatever this response
    // carries as the signed-in user until the page is reloaded. Leaving it out
    // meant a screen asking "may I show this?" got `undefined` for the whole
    // session, so a permission switched on for the role was invisible until the
    // person happened to refresh and pick it up from /auth/me.
    user.permissions = [...await rolePermissions.effectiveFor(db, user.role).catch(() => new Set())];

    /* Sign-in is the one action whose actor the middleware cannot work out for
       itself: there is no req.user on the way in, because authenticating is
       what this request does. So the route hands over the account it just
       became. Point 1 of the brief asks for login events, and an audit trail
       that cannot say who signed in and when is missing the entry most often
       asked for after something goes wrong. */
    req.activity({
      actor: user,
      module: 'auth',
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} signed in`,
    });

    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong signing you in' });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

/* POST /api/auth/tour-seen — "I have been shown the Quick Tour."
 *
 * Under /api/auth for the same reason the password endpoint is: it acts only on
 * the caller's own account, so there is no id to authorise and no question of
 * who may do it to whom. Every signed-in account may call it, and it is the one
 * endpoint in the application with no permission check at all — the tour is an
 * orientation aid, and a help screen somebody can be denied is not one.
 *
 * Idempotent, and it keeps the FIRST time rather than the latest: this answers
 * "has this person been shown the tour", not "when did they last watch it", so
 * relaunching it by hand from the header does not move the date.
 */
router.post('/tour-seen', authenticate, async (req, res) => {
  await db.query(
    'UPDATE users SET tour_seen_at = COALESCE(tour_seen_at, NOW()) WHERE id = $1',
    [req.user.id]
  );
  const { rows } = await db.query(
    'SELECT tour_seen_at AS `tourSeenAt` FROM users WHERE id = $1', [req.user.id]);
  res.json({ tourSeenAt: rows[0] ? rows[0].tourSeenAt : null });
});

// The password rules, so the browser shows the same checklist the API enforces.
router.get('/password-policy', (req, res) => {
  res.json(passwordPolicy.describe());
});

// POST /api/auth/password — change your own password.
//
// Lives under /api/auth rather than /api/users/:id/password because everything
// in /api/users requires the manageUsers capability and acts on other people's
// accounts. This acts only on the caller's own account: there is no id to
// authorise, which removes the question of who may change whose password.
router.post('/password', authenticate, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: 'Enter your current password and a new one.',
      field: !currentPassword ? 'currentPassword' : 'newPassword',
    });
  }
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({
      error: 'The new passwords do not match.',
      field: 'confirmPassword',
    });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({
      error: 'Your new password must be different from your current one.',
      field: 'newPassword',
    });
  }

  const verdict = passwordPolicy.check(newPassword);
  if (!verdict.valid) {
    return res.status(400).json({ error: verdict.message, field: 'newPassword', failed: verdict.failed });
  }

  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) return res.status(401).json({ error: 'This account no longer exists' });

  const matches = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!matches) {
    // Logged without the value, so a failed attempt is visible to an
    // administrator reviewing logs but the password never reaches them.
    console.warn(`Rejected password change for ${req.user.email}: current password did not match.`);
    return res.status(403).json({ error: 'Your current password is not correct.', field: 'currentPassword' });
  }

  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  const changedAt = Date.now(); // milliseconds; only ever compared for equality
  await db.query(
    'UPDATE users SET password_hash = $1, password_changed_at = $2 WHERE id = $3',
    [hash, changedAt, req.user.id]
  );
  console.log(`Password changed for ${req.user.email}.`);

  // Every token still carrying the previous value is now refused, which signs
  // out the account's other devices. Hand this one a replacement so the person
  // who made the change is not signed out by their own action.
  res.json({
    ok: true,
    token: signToken(req.user.id, changedAt),
    message: 'Password changed. Any other devices signed in to this account have been signed out.',
  });
});

// The role catalogue, so the frontend builds its dropdowns and badges from the
// same definitions the API enforces instead of keeping a parallel copy.
router.get('/roles', authenticate, (req, res) => {
  res.json({ roles: catalogue() });
});

// POST /api/auth/bootstrap — create the very first super admin.
//
// `npm run seed` needs shell access on the host, which managed platforms often
// don't give you, and hand-writing the INSERT means pasting a bcrypt hash full
// of $ characters into a console that may mangle it — and into whichever
// database you happen to have open, which is not necessarily the one the app
// is configured to use. This route uses the app's own connection, so it cannot
// target the wrong database, and hashes the password server-side.
//
// Two conditions, both required, so this cannot become a back door:
//   - The request must carry the bootstrap token — either BOOTSTRAP_TOKEN from
//     the environment, or the one-time token printed to the startup log when
//     the database is empty (see src/bootstrap-token.js). With neither, the
//     route does not exist at all.
//   - The users table must be empty. Once any account exists it always 409s,
//     so it can never be used to add a second administrator.
router.post('/bootstrap', async (req, res) => {
  if (!bootstrapToken.isEnabled()) return res.status(404).json({ error: 'Not found' });

  const { token, email, name, password } = req.body || {};
  if (!bootstrapToken.matches(token)) {
    return res.status(403).json({ error: 'Invalid bootstrap token' });
  }
  if (!email || !name || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const verdict = passwordPolicy.check(password);
  if (!verdict.valid) {
    return res.status(400).json({ error: verdict.message, failed: verdict.failed });
  }

  try {
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
    if (Number(rows[0].n) > 0) {
      return res.status(409).json({
        error: 'This studio already has accounts. Bootstrap is only for an empty database.',
      });
    }

    const id = uuid();
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    await db.query(
      'INSERT INTO users (id, `name`, email, password_hash, `role`) VALUES ($1,$2,$3,$4,\'super_admin\')',
      [id, String(name).trim(), String(email).trim(), hash]
    );
    // The route is now closed either way, since an account exists. Only the
    // environment variable needs clearing by hand; a runtime token dies with
    // the process.
    const usedEnvToken = Boolean(process.env.BOOTSTRAP_TOKEN);
    console.log(`Bootstrapped super admin ${email}.${usedEnvToken ? ' Unset BOOTSTRAP_TOKEN now.' : ''}`);
    res.status(201).json({
      ok: true,
      user: { id, name: String(name).trim(), email: String(email).trim(), role: 'super_admin' },
      next: usedEnvToken
        ? 'Sign in with these details, then remove BOOTSTRAP_TOKEN from the environment.'
        : 'Sign in with these details. This route is now closed for good.',
    });
  } catch (err) {
    console.error('Bootstrap failed', err);
    res.status(503).json({
      error: 'Could not reach the database',
      code: err.code || null,
      detail: err.sqlMessage || err.message,
    });
  }
});

module.exports = router;
