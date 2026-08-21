const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { capabilitiesFor, catalogue } = require('../roles');
const bootstrapToken = require('../bootstrap-token');

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const user = rows[0];
    // Deliberately vague error so we don't reveal which part was wrong.
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '12h' });
    delete user.password_hash;
    user.capabilities = capabilitiesFor(user.role);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong signing you in' });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
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
  if (String(password).length < 10) {
    return res.status(400).json({ error: 'Choose a password of at least 10 characters' });
  }

  try {
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
    if (Number(rows[0].n) > 0) {
      return res.status(409).json({
        error: 'This studio already has accounts. Bootstrap is only for an empty database.',
      });
    }

    const id = uuid();
    const hash = await bcrypt.hash(String(password), 10);
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
