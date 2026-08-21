const crypto = require('crypto');

// The token that authorises POST /api/auth/bootstrap.
//
// Normally it comes from BOOTSTRAP_TOKEN in the environment. On a managed host
// where setting an environment variable is awkward, that requirement is the one
// thing standing between the operator and their first login — so when the
// database is empty and no token is configured, generate one and print it to
// the startup log. Whoever can read the server's log is the operator.
//
// It lives only in this process's memory, is regenerated on every restart, and
// is refused the moment any account exists, so it grants nothing beyond
// claiming an empty studio.
let runtimeToken = null;

function configuredToken() {
  return process.env.BOOTSTRAP_TOKEN || null;
}

function currentToken() {
  return configuredToken() || runtimeToken;
}

// Constant-time compare so a wrong guess reveals nothing through timing.
function matches(candidate) {
  const expected = currentToken();
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isEnabled() {
  return Boolean(currentToken());
}

// Called once at startup, after the server is listening.
async function announce(db, log = console.log) {
  if (configuredToken()) {
    log('BOOTSTRAP_TOKEN is set — POST /api/auth/bootstrap is available until an account exists.');
    return;
  }
  let empty;
  try {
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
    empty = Number(rows[0].n) === 0;
  } catch (err) {
    log(`Could not check for existing accounts: ${err.sqlMessage || err.message}`);
    return;
  }
  if (!empty) return; // Studio is already in use; nothing to bootstrap.

  runtimeToken = crypto.randomBytes(24).toString('hex');
  const line = '='.repeat(72);
  log(`\n${line}
This database has no accounts yet, so nobody can sign in.

Create the first super admin by sending this request (the token below is
valid only until an account exists, and only for this run of the server):

  curl -X POST <your-site-url>/api/auth/bootstrap \\
    -H 'Content-Type: application/json' \\
    -d '{"token":"${runtimeToken}","name":"Your Name","email":"you@example.com","password":"a-strong-password"}'

Restarting the server issues a new token. Once you have signed in, this
message stops appearing.
${line}\n`);
}

module.exports = { matches, isEnabled, announce, currentToken };
