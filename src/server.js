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
// Browsers send an Origin header with no path and no trailing slash
// ("https://example.com"), so a configured value written as
// "https://example.com/" would never match. Normalise rather than make the
// deployer notice, since the failure is a silent cross-origin block.
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : '*' }));
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

// Changing a password requires the current one, so the endpoint is a place to
// guess passwords. Limit it harder than sign-in: it is used once in a while by
// one person, never in bursts by a whole office.
const passwordChangeLimiter = rateLimit({
  windowMs: Number(process.env.PASSWORD_CHANGE_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.PASSWORD_CHANGE_RATE_MAX || 10),
  standardHeaders: true,
  message: { error: 'Too many password change attempts. Try again in a few minutes.' },
});
app.use('/api/auth/password', passwordChangeLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/users', userRoutes);
app.use('/api/team', teamRoutes);

// Health check. Deliberately reports the database too: a deployment whose
// process is up but whose credentials are wrong looks identical from outside
// otherwise, and the symptom that reaches the user is a failed sign-in.
// Reports whether any account exists, never how many or whose.
app.get('/api/health', async (req, res) => {
  const db = require('./db');
  try {
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
    const seeded = Number(rows[0].n) > 0;
    res.json({
      ok: true,
      database: 'connected',
      accounts: seeded ? 'present' : 'none',
      ...(seeded ? {} : {
        hint: 'No accounts exist yet. Run "npm run seed", or — if you have no shell on this host — '
          + 'set BOOTSTRAP_TOKEN in the environment and POST it to /api/auth/bootstrap.',
      }),
    });
  } catch (err) {
    // err.code distinguishes bad credentials from a missing schema; the message
    // is the driver's own and says which, without exposing the credentials.
    res.status(503).json({
      ok: false,
      database: 'unreachable',
      code: err.code || null,
      error: err.sqlMessage || err.message,
    });
  }
});

// Serve the bundled frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Fallback error handler — surfaces the actual message (e.g. multer's file-type
// or size-limit errors) rather than a generic 500, since those are meant for the user.
// Database errors are the exception: their messages name tables and columns, so
// log those in full and hand the caller the error code alone.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);

  // Multer reports an oversized or unexpected upload through its own error
  // class. These are all the caller's doing, so answer 400 with the reason.
  if (err.name === 'MulterError') {
    const explain = {
      LIMIT_FILE_SIZE: 'That file is larger than this endpoint accepts.',
      LIMIT_FILE_COUNT: 'Too many files were uploaded at once.',
      LIMIT_UNEXPECTED_FILE: `Unexpected file field "${err.field}".`,
    };
    return res.status(400).json({ error: explain[err.code] || `Upload rejected: ${err.message}`, code: err.code });
  }

  const isDatabaseError = typeof err.code === 'string' && /^(ER_|PROTOCOL_|ECONN)/.test(err.code);
  if (isDatabaseError) {
    return res.status(500).json({
      error: 'The server could not complete that request because of a database error.',
      code: err.code,
    });
  }
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
});

// Last line of defence. Routes are wrapped (src/async-router.js) so their
// failures reach the handler above, but anything that escapes — a rejection
// from a timer or an event emitter — would otherwise terminate the process and
// turn every subsequent request into a 502. Log it and keep serving; a stack
// trace in the log is far easier to act on than a dead container.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Zvky backend listening on http://localhost:${PORT}`);
  const db = require('./db');
  // Repair a schema left over from an earlier version before anything uses it,
  // then say so if nobody can sign in yet — otherwise every attempt just fails
  // as "Invalid email or password" with no explanation.
  require('./migrate')
    .run(db)
    .then(() => require('./bootstrap-token').announce(db))
    .catch((err) => console.error('Startup checks failed', err));
});

module.exports = app;
