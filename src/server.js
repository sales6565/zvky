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
const referenceRoutes = require('./routes/reference');
const referenceData = require('./reference-data');
const ipAllowlistRoutes = require('./routes/ip-allowlist');
const ipGate = require('./middleware/ip-allowlist');

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

// Everything below this line is only reachable from an allowed address. It sits
// ahead of authentication deliberately: checking afterwards would leave the
// login endpoint open to addresses that should not reach the app at all. The
// ways back in when the list is wrong live in the environment — see
// src/middleware/ip-allowlist.js.
app.use(ipGate.middleware);
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
app.use('/api/reference', referenceRoutes);
app.use('/api/ip-allowlist', ipAllowlistRoutes);

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

// Keep this process's copy of the value lists from drifting.
//
// Reads refresh it, so a browser looking at Settings always sees the table. But
// the same mirror answers the synchronous permission checks on every request,
// and those cannot wait on a query — so a worker that nobody happens to ask for
// reference data would carry a stale catalogue indefinitely, and refuse anyone
// holding a role added since it started. This bounds that to one interval.
//
// Set REFERENCE_REFRESH_SECONDS=0 to switch it off on a single-process
// deployment where nothing else writes to the database.
function startReferenceRefresh(db) {
  const seconds = Number(process.env.REFERENCE_REFRESH_SECONDS ?? 30);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const timer = setInterval(() => {
    referenceData.refreshIfChanged(db)
      .then((changed) => {
        if (changed) console.log('[reference] value lists changed elsewhere; reloaded.');
      })
      .catch((err) => console.error(`[reference] refresh failed: ${err.sqlMessage || err.message}`));
  }, seconds * 1000);
  // Never hold the process open for this.
  timer.unref();
  return timer;
}

const PORT = process.env.PORT || 4000;

// Migrate and load the reference data BEFORE accepting requests.
//
// These used to run from inside the listen callback, which meant the server
// answered requests — health checks included — while the asset types, priorities
// and roles were still being seeded. A request landing in that window saw empty
// dropdowns, and the permission checks read the built-in defaults rather than
// what the database actually held.
async function start() {
  const db = require('./db');
  try {
    // Repairs a schema left over from an earlier version, seeds the reference
    // tables, and loads the mirror the permission checks read from.
    await require('./migrate').run(db);
    // Then say so if nobody can sign in yet — otherwise every attempt just
    // fails as "Invalid email or password" with no explanation.
    await require('./bootstrap-token').announce(db);
    ipGate.describeAtStartup();
    startReferenceRefresh(db);
  } catch (err) {
    // Start anyway: a server that is up can report through /api/health why the
    // database is unreachable, where one that exited says nothing at all.
    console.error('Startup checks failed; starting anyway so /api/health can report why.', err);
  }

  app.listen(PORT, () => {
    console.log(`Zvky backend listening on http://localhost:${PORT}`);
  });
}

start();

module.exports = app;
