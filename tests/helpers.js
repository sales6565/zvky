// Shared setup for tests that need a live server and database.
//
// Integration tests need somewhere to write, so they are skipped unless a test
// database is configured. Point TEST_DB_NAME at a database you are happy to see
// dropped and recreated — never a real one:
//
//   TEST_DB_NAME=zvky_test TEST_DB_USER=root TEST_DB_PASSWORD=secret npm test
//
// Connection settings fall back to the ordinary DB_* variables, so a local .env
// is usually enough apart from TEST_DB_NAME.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Each suite gets its own database, derived from TEST_DB_NAME. The test runner
// runs files in parallel, and two suites dropping and recreating one database
// at the same time deadlock against each other.
function config(suffix) {
  const base = process.env.TEST_DB_NAME;
  if (!base) return null;
  const name = suffix ? `${base}_${suffix}` : base;
  return {
    host: process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.TEST_DB_USER || process.env.DB_USER,
    password: process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || '',
    database: name,
  };
}

const SKIP_REASON =
  'Set TEST_DB_NAME (and TEST_DB_USER / TEST_DB_PASSWORD if needed) to run integration tests. ' +
  'The database is dropped and recreated, so do not point it at real data.';

// Rebuild the schema from scratch so each run starts from a known state.
async function resetSchema(cfg) {
  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
  await admin.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${cfg.database}\``);
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await admin.end();
}

// Start the real server as a child process, exactly as production runs it,
// rather than importing the app and stubbing pieces of it.
async function startServer(cfg, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'app.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_HOST: cfg.host,
      DB_PORT: String(cfg.port),
      DB_NAME: cfg.database,
      DB_USER: cfg.user,
      DB_PASSWORD: cfg.password,
      DATABASE_URL: '', // discrete settings above win; don't inherit a stray URL
      JWT_SECRET: 'test-secret-not-used-outside-the-test-suite',
      PORT: String(port),
      CORS_ORIGIN: `http://localhost:${port}`,
      LOGIN_RATE_MAX: '100000',
      PASSWORD_CHANGE_RATE_MAX: '100000',
      // Start with no allowed addresses, which leaves the IP gate open — every
      // other suite connects from 127.0.0.1 and is not testing the gate. The
      // allowlist suite overrides this with the addresses it wants. Note this
      // is the real code path, not the feature switched off: an empty list is
      // meant to mean "not configured".
      IP_ALLOWLIST_SEED: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const base = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base, child, output: () => output, port };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`Server did not start within 30s. Output:\n${output}`);
}

function stopServer(server) {
  if (server && server.child && !server.child.killed) server.child.kill();
}

async function api(base, path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

// Some tests need the response as it came — the Access Denied page is HTML, and
// asserting on JSON that failed to parse would pass for the wrong reason.
async function raw(base, path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

// Run raw SQL against the test database. Tests that need to break something on
// purpose — dropping a table out from under a running server — need a way in
// that does not go through the app.
// Every project needs a client, so tests that only care about projects need
// somewhere to put them. The migration seeds exactly one system client; this is
// it, so a test can say "a project, anywhere" without inventing a client first.
async function systemClientId(base, token) {
  const res = await api(base, '/clients', { token });
  const found = (res.body.clients || []).find((c) => c.isSystem);
  if (!found) throw new Error('No system client — did the migration run?');
  return found.id;
}

async function sql(cfg, statement) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, multipleStatements: true,
  });
  try {
    const [rows] = await conn.query(statement);
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = { config, resetSchema, startServer, stopServer, api, raw, sql, systemClientId, SKIP_REASON };
