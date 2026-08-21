require('dotenv').config();
const mysql = require('mysql2/promise');

// MySQL connection. cPanel hosts (GoDaddy included) give you a database name,
// a user and a password rather than a URL, so those are the primary settings;
// DATABASE_URL is still honoured if you'd rather use one.
function buildConfig() {
  const base = {
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0,
    // DATE columns come back as 'YYYY-MM-DD' strings instead of Date objects.
    // A due date has no time or timezone, and converting it to a Date would
    // shift it a day either side of UTC depending on the server's clock.
    dateStrings: ['DATE'],
    // DECIMAL as a JS number rather than a string, so man_hours arithmetic works.
    decimalNumbers: true,
    charset: 'utf8mb4_general_ci',
  };

  if (process.env.DATABASE_URL) {
    return { uri: process.env.DATABASE_URL, ...base };
  }

  const missing = ['DB_NAME', 'DB_USER'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `Database is not configured: ${missing.join(' and ')} not set.\n` +
      'Copy .env.example to .env and fill in DB_HOST, DB_NAME, DB_USER and DB_PASSWORD.'
    );
    process.exit(1);
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    ...base,
  };
}

const pool = mysql.createPool(buildConfig());

// The queries in this codebase are written with Postgres-style $1, $2 numbered
// placeholders, which say explicitly which parameter goes where and can repeat
// the same one (the user search matches $1 against both name and email).
// MySQL only has positional '?', so translate: rewrite each $n as '?' and emit
// the parameter list in the order the placeholders actually appear, repeating a
// parameter that is referenced more than once.
function translate(sql, params = []) {
  const ordered = [];
  const text = sql.replace(/\$(\d+)/g, (_, n) => {
    ordered.push(params[Number(n) - 1]);
    return '?';
  });
  // No numbered placeholders at all — the query either takes no parameters or
  // already uses '?' directly, so pass whatever was given through untouched.
  return ordered.length ? { text, values: ordered } : { text, values: params };
}

// mysql2 returns [rows, fields]; the routes expect pg's { rows } shape.
// Using query() rather than execute() so that a '?' fed an array expands into
// an IN list, which is how the bulk lookups are written.
async function runQuery(runner, sql, params) {
  const { text, values } = translate(sql, params);
  const [rows] = await runner.query(text, values);
  return { rows: Array.isArray(rows) ? rows : [], result: rows };
}

// A pooled connection with the same interface, for multi-statement transactions.
async function connect() {
  const conn = await pool.getConnection();
  return {
    query: (sql, params) => runQuery(conn, sql, params),
    release: () => conn.release(),
  };
}

module.exports = {
  query: (sql, params) => runQuery(pool, sql, params),
  connect,
  end: () => pool.end(),
  pool,
};
