/* What must be set before Forge starts, checked in one place.
 *
 * Settings come from the environment: on a host (GoDaddy's cPanel Node.js app) they are
 * the application's environment variables. A local .env file is still read for
 * development (dotenv, in server.js and db.js), but nothing requires one, and a
 * variable set in the environment always wins over the file.
 *
 * Problems stop the start, with the variable's NAME and what is wrong with it; a value
 * is never printed. Warnings are logged and the start continues.
 */

// Text that marks a value copied from .env.example rather than generated.
const PLACEHOLDER = /replace-this|your[_-]|change-?me|placeholder|example|<.*>/i;

function problems(env = process.env) {
  const out = [];
  if (!env.DATABASE_URL) {
    for (const k of ['DB_NAME', 'DB_USER']) if (!env[k]) out.push(`${k} is not set.`);
    for (const k of ['DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (env[k] && PLACEHOLDER.test(env[k])) out.push(`${k} is still the placeholder from .env.example.`);
    }
  }
  const jwt = env.JWT_SECRET || '';
  if (!jwt) out.push('JWT_SECRET is not set. It signs every sign-in session.');
  else if (PLACEHOLDER.test(jwt)) out.push('JWT_SECRET is the public placeholder from .env.example, so anyone could forge a session. Set a long random value.');
  else if (jwt.length < 32) out.push('JWT_SECRET is shorter than 32 characters. Set a long random value.');
  return out;
}

function warnings(env = process.env) {
  const out = [];
  if (!env.DATABASE_URL && env.DB_NAME && !env.DB_PASSWORD) out.push('DB_PASSWORD is not set; connecting to the database without a password.');
  if (!String(env.CORS_ORIGIN || '').trim()) out.push('CORS_ORIGIN is not set, so any origin may call the API. Set it to this site\'s address.');
  return out;
}

/* Run at start-up: log warnings, and on any problem say what to set and exit. */
function enforce(env = process.env, log = console) {
  for (const w of warnings(env)) log.warn(`Configuration: ${w}`);
  const bad = problems(env);
  if (!bad.length) return;
  log.error('Forge cannot start: its configuration is incomplete.');
  for (const p of bad) log.error(`  - ${p}`);
  log.error('Set these as the application\'s environment variables on the host (or, for local development, in a .env file), then restart.');
  log.error('A random JWT_SECRET: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

module.exports = { problems, warnings, enforce };
