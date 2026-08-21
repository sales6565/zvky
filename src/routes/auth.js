const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { capabilitiesFor, catalogue } = require('../roles');

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

module.exports = router;
