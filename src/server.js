require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const assetRoutes = require('./routes/assets');
const userRoutes = require('./routes/users');
const teamRoutes = require('./routes/team');

const app = express();

// On cPanel/Passenger (and behind any reverse proxy) the client address arrives
// in X-Forwarded-For. Without this the rate limiter keys every request to the
// proxy's own address and throttles the whole studio as if it were one user.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.use(helmet({ contentSecurityPolicy: false })); // CSP left off for the bundled demo frontend; tighten if you serve it elsewhere
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*' }));
app.use(express.json());

// Slow down brute-force login attempts. The limit is per client address and
// counts the whole studio when everyone shares one office IP, so it is set high
// enough for a full team's morning sign-in and tunable per deployment.
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX || 100),
  standardHeaders: true,
  message: { error: 'Too many sign-in attempts from this network. Try again in a few minutes.' },
});
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/users', userRoutes);
app.use('/api/team', teamRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the bundled frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Fallback error handler — surfaces the actual message (e.g. multer's file-type
// or size-limit errors) rather than a generic 500, since those are meant for the user.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Zvky backend listening on http://localhost:${PORT}`);
});

module.exports = app;
