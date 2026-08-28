require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const clientRoutes = require('./routes/clients');
const assetRoutes = require('./routes/assets');
const userRoutes = require('./routes/users');
const teamRoutes = require('./routes/team');
const referenceRoutes = require('./routes/reference');
const referenceData = require('./reference-data');
const ipAllowlistRoutes = require('./routes/ip-allowlist');
const permissionRoutes = require('./routes/permissions');
const reportRoutes = require('./routes/reports');
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
app.use('/api/clients', clientRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/users', userRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/reference', referenceRoutes);
app.use('/api/ip-allowlist', ipAllowlistRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/reports', reportRoutes);

// Health check. Deliberately reports the database too: a deployment whose
// process is up but whose credentials are wrong looks identical from outside
// otherwise, and the symptom that reaches the user is a failed sign-in.
// Reports whether any account exists, never how many or whose.
// What the startup schema repair reported, held so /api/health can answer
// "did every migration actually apply?" from a URL. Reading server logs was
// the only way to know before, and a step that fails silently is exactly how
// a deployment ends up serving code against a schema it does not have.
let lastMigration = null;

app.get('/api/health', async (req, res) => {
  const db = require('./db');
  try {
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
    const seeded = Number(rows[0].n) > 0;
    const repairsFailed = (lastMigration && lastMigration.failed) || [];
    // What the schema is actually missing, whatever the migration reported. A
    // step can report success on one boot and the column still be absent —
    // asking the database directly is the answer that cannot be stale.
    const gaps = await require('./schema-check').gaps(db).catch(() => null);
    res.json({
      ok: repairsFailed.length === 0 && (gaps ? gaps.length === 0 : true),
      database: 'connected',
      accounts: seeded ? 'present' : 'none',
      schemaRepairs: repairsFailed.length
        ? { applied: false, failed: repairsFailed,
            hint: 'These startup schema repairs did not apply. The server log from startup has each one\'s database error; parts of the app will fail until they are fixed.' }
        : { applied: true },
      schema: gaps === null
        ? { checked: false, hint: 'information_schema could not be read on this database user.' }
        : (gaps.length
            ? {
              complete: false,
              missing: gaps.map((g) => `${g.name} (${g.kind})${g.detail ? ` — ${g.detail}` : ''}`),
              steps: [...new Set(gaps.map((g) => g.step))],
              hint: 'The app is running against a schema it does not have, which is why some requests fail with a database error. '
                + 'Most often the database user lacks ALTER or CREATE — grant those and restart, or apply the matching statements from sql/schema.sql by hand.',
            }
            : { complete: true }),
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

/* GET /api/health/errors — the last few database faults this process has seen.
   
   Authenticated and behind full studio access: the messages name tables and
   columns, which is the point, and that is not for everybody. */
app.get('/api/health/errors', require('./middleware/auth').authenticate, (req, res) => {
  const { hasFullAccess } = require('./permissions');
  if (!hasFullAccess(req.user)) return res.status(403).json({ error: 'Not for this role.' });
  res.json({
    count: RECENT_DB_ERRORS.length,
    errors: RECENT_DB_ERRORS,
    hint: RECENT_DB_ERRORS.length
      ? 'Each entry names the request and what the database said. A missing column or table means a startup schema change did not apply — /api/health names which.'
      : 'No database faults since this process started.',
  });
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
/* The last few database faults, in memory.
   
   Shared hosting frequently gives a studio no way to read the server log, so
   an error that says "look in the log" is an error that ends the
   investigation. This keeps enough to diagnose one and no more: when, which
   request, the driver's code and message. No row values and no credentials,
   and it is behind full access. */
const RECENT_DB_ERRORS = [];
const RECENT_LIMIT = 25;

app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (err && (err.code || '').startsWith('ER_')) {
    RECENT_DB_ERRORS.unshift({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      code: err.code,
      message: err.sqlMessage || err.message,
    });
    RECENT_DB_ERRORS.length = Math.min(RECENT_DB_ERRORS.length, RECENT_LIMIT);
  }

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
    // A CHECK constraint refusing a value is not an opaque database fault: it
    // means this build is writing something the schema was never widened to
    // accept, which is a deployment problem with a known remedy. Say so, and
    // name the constraint.
    //
    // The driver's own `code` is worse than useless here — MariaDB reuses error
    // number 4025 for a CHECK failure, and mysql2's table maps it to the
    // unrelated ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE. The message is the
    // truth, so it is the message that gets read.
    // Both engines' wordings, because they do not agree:
    //   MariaDB   CONSTRAINT `chk_assets_status` failed: db.assets
    //   MySQL 8   Check constraint 'assets_chk_2' is violated.
    // Only the first was matched, so on MySQL 8 the studio got the generic
    // "database error" for the one fault this message exists to name.
    const message = err.sqlMessage || err.message || '';
    const constraint = /CONSTRAINT [`'\"]?([A-Za-z0-9_]+)[`'\"]? failed/i.exec(message)
      || /check constraint [`'\"]?([A-Za-z0-9_]+)[`'\"]? is violated/i.exec(message);
    if (constraint) {
      return res.status(500).json({
        error: `This deployment's database rejected the value: the "${constraint[1]}" constraint has not been updated for this version. `
          + 'Open /api/health — it names the schema changes that have not been applied.',
        constraint: constraint[1],
        detail: message,
      });
    }
    /* A column or table this build needs that the database does not have.
       
       The generic message below is what somebody saw when creating an asset
       against a deployment whose newest migration had not applied: true, and
       useless. These two errors have one cause and one remedy, so they say so
       and name the piece — the same treatment the CHECK constraint above gets.
       
       MySQL and MariaDB word these the same way:
         Unknown column 'a.category' in 'field list'
         Table 'db.asset_assignments' doesn't exist  */
    const schemaFault = err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE';
    if (schemaFault) {
      const named = /Unknown column '([^']+)'/i.exec(message)
        || /Table '(?:[^.']*\.)?([^']+)' doesn't exist/i.exec(message);
      return res.status(500).json({
        error: `This deployment's database is missing ${named ? `"${named[1]}"` : 'something this version needs'}, `
          + 'which a startup schema change should have added. '
          + 'Open /api/health — it names every schema change that has not been applied, and the step to re-run.',
        missing: named ? named[1] : undefined,
        code: err.code,
        detail: message,
      });
    }
    /* Every other database fault.
       
       This used to hand back the code alone, on the reasoning that driver
       messages name tables and columns and belong in the log. On shared
       hosting there is often no log anyone can reach, so "a database error"
       was the whole of what a studio could find out — twice now. The message
       names schema, not data: no row values, no credentials. It is worth more
       in the reply than it is withheld. */
    return res.status(500).json({
      error: `The database refused that request: ${message || 'no detail given'}`,
      code: err.code,
      detail: message,
      hint: 'Open /api/health — if a schema change has not applied it is named there. '
        + 'GET /api/health/errors has the last few of these in full, for a host with no reachable log.',
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
    lastMigration = await require('./migrate').run(db);
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
