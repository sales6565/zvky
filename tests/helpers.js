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
  /* Sixty seconds, not thirty.
   *
   * Every suite in this file's care starts its own server, and each one runs
   * the whole startup migration against its own database — twenty of those at
   * once, on four cores, against one MariaDB. A cold migration is under three
   * seconds on an idle machine and several times that under twenty-way
   * contention, which is why a run would fail with "server did not start" in a
   * DIFFERENT suite each time: the servers all start, and one of them loses the
   * race against the clock rather than against anything real.
   *
   * The loop polls every 250ms and returns the moment health answers, so a
   * longer deadline costs nothing when the machine is quiet.
   *
   * RAISED TWICE NOW, from sixty to a hundred and fifty to this, and the reason is always
   * the same: the count in the paragraph above is no longer twenty. Seventy-six files in
   * tests/ start a server, still on four cores and one MariaDB.
   *
   * At sixty it was tests/mis-project-access.test.js — ten subtests and their parent. At a
   * hundred and fifty it was tests/auto-resume.test.js, whose captured server log had
   * finished every migration step and printed its last startup line; it simply had not
   * answered /health yet. Both passed alone, immediately afterwards, which is the signature
   * this comment describes.
   *
   * THE NUMBER IS NOT THE REAL ANSWER and should not be raised a third time in silence. A
   * boot that needs more than two minutes means seventy-six servers are contending for four
   * cores, and the fix at that point is fewer of them at once (`--test-concurrency`) or a
   * larger machine — not a longer wait. This is set where it is so a full run on THIS
   * container completes, and the env override below is how a smaller box copes without
   * editing the file.
   *
   * Overridable, so a slower box can raise it without editing this file, and so the number
   * here is a default rather than a claim about every machine. */
  const deadline = Date.now() + Number(process.env.TEST_SERVER_BOOT_MS || 300000);
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
  throw new Error('Server did not start within '
    + `${Math.round(Number(process.env.TEST_SERVER_BOOT_MS || 300000) / 1000)}s. `
    + `Raise TEST_SERVER_BOOT_MS if this machine is slower than the default assumes.\n${output}`);
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

async function sql(cfg, statement, params) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, multipleStatements: true,
  });
  try {
    // Placeholders are optional, so the many callers that pass a plain
    // statement keep working; a test that needs to name an id passes params
    // rather than building the string, which is the same rule the app follows.
    const [rows] = params === undefined ? await conn.query(statement) : await conn.query(statement, params);
    return rows;
  } finally {
    await conn.end();
  }
}

/* The text a PDF actually shows a reader.
 *
 * Asserting on the byte length, or on the "%PDF" magic bytes, only proves a
 * file was produced — which is how the Time Sheet shipped an export with every
 * cell blank. pdfkit writes hex strings in WinAnsi, so this inflates each
 * content stream and reads them back, and that is the only way to claim a
 * document "says" something.
 *
 * Lifted here from report-export.test.js, which had it first. Two copies of a
 * reader is how two suites end up disagreeing about what a document contains —
 * the same divergence, one level up, as the bug this was written to catch.
 */
function pdfText(buffer) {
  const zlib = require('node:zlib');
  const WINANSI = { 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0xf7: '÷', 0x85: '…' };
  const s = buffer.toString('latin1');
  const pages = [];
  let i = 0;
  while ((i = s.indexOf('stream', i)) >= 0) {
    const start = s.indexOf('\n', i) + 1;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let body = null;
    try { body = zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'); } catch { /* not a stream we can read */ }
    i = end + 9;
    if (!body || !/\bTf\b/.test(body)) continue;
    let out = '';
    const rx = /<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = rx.exec(body))) {
      for (let k = 0; k + 1 < m[1].length; k += 2) {
        const b = parseInt(m[1].substr(k, 2), 16);
        out += WINANSI[b] || String.fromCharCode(b);
      }
    }
    pages.push(out);
  }
  return { pages: pages.length, text: pages.join('\n'), byPage: pages };
}

/* Hold the studio open, so a suite about something else is not also a suite
 * about what time it is.
 *
 * Recorded time is now the part of a session that falls inside the studio's
 * working window (src/working-time.js), which makes every test that starts a
 * timer and expects a number depend on the clock it runs under. Run the suite
 * at eight in the evening, or on a Saturday, and twenty-three of them failed —
 * correctly, which is the problem: a red suite that means "it is late" teaches
 * people to ignore a red suite.
 *
 * So a suite that needs the clock to run says so, once, in its before hook.
 * This sets the real setting through the real endpoint rather than stubbing the
 * module, so the suite still exercises the path production uses; it just pins
 * the one input that would otherwise be the wall clock.
 *
 * Suites ABOUT the window do not call this. They set the window they mean to
 * test, which is the same endpoint doing the same thing.
 */
async function openStudio(base, token) {
  const r = await api(base, '/branding/schedule', {
    method: 'PUT',
    token,
    body: {
      hoursPerDay: 8,
      workingDays: [1, 2, 3, 4, 5, 6, 7],
      dayStart: 0,
      /* 1440, not '23:59'. A window ending a minute before midnight leaves a
         one-minute hole every night, and a session running across it loses
         that minute — which is a real hole, just a small one, and small holes
         in a clock are the ones that take longest to find. The setting accepts
         a plain minute count, and 1440 is midnight at the far end. */
      dayEnd: 24 * 60,
      // Every break cleared: a suite measuring a two-hour session must not lose
      // an hour of it to a lunch it never asked for.
      lunchStart: '', lunchEnd: '',
      morningStart: '', morningEnd: '',
      eveningStart: '', eveningEnd: '',
    },
  });
  if (r.status >= 400) {
    throw new Error(`could not open the studio for this suite: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.schedule;
}

/* THE STUDIO CLOCK, ANCHORED — and why three suites needed this.
 *
 * A suite that tests the pause sweep, the automatic resume or a recorded number
 * of seconds has to place a window relative to NOW: "the break started ten
 * minutes ago" is the only way to say it, because the session it measures is
 * backdated from the database's NOW() and the sweep runs on the real clock.
 * Neither can be moved, so the windows cannot be fixed dates either.
 *
 * What CAN be fixed is how that relative window is turned into two clock times,
 * and it went wrong in two distinct ways. Which of them bit depended on the
 * suite, so both are named:
 *
 *   THE CLOCK WAS READ MORE THAN ONCE per window. `clock(nowMin() - 10)` and
 *      `clock(nowMin() + 20)` are two reads. A minute ticking between them moves
 *      one end and not the other, so a suite that passes all day fails on
 *      whichever run straddles a minute boundary — a one-in-sixty flake with no
 *      pattern to it, which is the worst kind to be handed. recording-schedule
 *      and late-sweep-hours both did this. Every window in one case now comes
 *      from ONE read, passed in as `anchorMinute`.
 *
 *   AND THE RESULT WAS NOT ALWAYS A TIME. Ten minutes before 00:05 is not -5,
 *      and twenty minutes after 23:50 is not 24:10, but subtracting minutes past
 *      midnight says exactly that. Each suite failed differently on it.
 *      recording-schedule formatted the figures without wrapping at all and got
 *      "-1:-5", which the old Working Hours endpoint refused as a time.
 *      late-sweep-hours and recording-hours both DID wrap, and got a
 *      legal-looking 23:55 to 00:10 — two real times, and a window whose end is
 *      before its start, which the old endpoint cannot express at all and
 *      Recording Hours refuses unless it is told the window crosses midnight.
 *
 *      So wrapping is not the fix on its own, and that is why spansMidnight is
 *      derived here from the two ends rather than left to each caller to
 *      remember: forgetting it looks like a passing suite for eighteen hours a
 *      day.
 *
 * So a window is built once, from one anchor, and carries `spansMidnight` when
 * it wraps — the flag Recording Hours already has for exactly this, which is
 * why these suites now express their windows through that API rather than
 * through the four legacy time pairs, which cannot say it at all.
 *
 * THE OFFSETS THEMSELVES ARE NOT THE FIX. Each suite still exercises the same
 * boundary minutes it was written to catch; all that changed is that the two
 * ends are now computed from the same instant and are legal at every hour.
 */
const MINUTES_PER_DAY = 24 * 60;
// The same fixed offset src/working-time.js uses, and for the same reason: the
// studio's clock is IST wherever the server is.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

const wrapMinute = (m) => ((Math.round(m) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

const clockLabel = (m) => {
  const x = wrapMinute(m);
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/* Minutes past midnight IST at one instant. Called ONCE per set of windows and
   the number passed around, never called again inside the arithmetic. */
const studioMinute = (at = Date.now()) => {
  const d = new Date(at + IST_OFFSET_MINUTES * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/* "From `fromAgo` minutes ago to `toAgo` minutes ago", as a Recording Hours row.
 *
 * Both offsets count BACKWARDS, so a negative one is in the future: (660, -120)
 * is a window that opened eleven hours ago and closes in two. That reads oddly
 * once and then never again, and it keeps every window in a suite in the same
 * units as the sessions they are measured against, which are all "n minutes
 * ago" too.
 *
 * A span of a whole day or of nothing is thrown rather than stored: both ends
 * land on the same minute, which Recording Hours correctly refuses as an empty
 * window, and the error would otherwise arrive as a 422 from a POST several
 * lines later with nothing saying which offset was impossible. */
function windowAgo(anchorMinute, fromAgo, toAgo, extra = {}) {
  const span = fromAgo - toAgo;
  if (!Number.isFinite(span) || span < 1 || span > MINUTES_PER_DAY - 1) {
    throw new Error(`a window from ${fromAgo} to ${toAgo} minutes ago spans ${span} minutes, `
      + `which cannot be stored as one row: give between 1 and ${MINUTES_PER_DAY - 1}.`);
  }
  const start = wrapMinute(anchorMinute - fromAgo);
  const end = wrapMinute(anchorMinute - toAgo);
  return {
    startTime: clockLabel(start),
    endTime: clockLabel(end),
    // Not "did I mean it to wrap" but "does it": the flag is refused when it is
    // set on a window that stays inside one day, so it is derived, never passed.
    spansMidnight: end < start,
    ...extra,
  };
}

const RECORDING_HOURS_ROOT = '/admin/settings/recording-hours';

/* The studio's whole window list, replaced.
 *
 * Every existing row goes first, seeded ones included: a suite that adds a
 * blackout on top of the shipped 09:30–19:00 weekday window is measuring that
 * window as much as its own, and would answer differently at four in the
 * afternoon than at four in the morning. What is left is only what the caller
 * asked for, so the case decides the whole schedule.
 *
 * Days default to all seven for the same reason — a suite runs on whatever day
 * it runs on, and a weekday-only window makes Sunday a different test. */
async function setRecordingWindows(base, token, entries) {
  const existing = await api(base, RECORDING_HOURS_ROOT, { token });
  if (existing.status >= 400) {
    throw new Error(`could not read the studio's windows: ${existing.status} ${JSON.stringify(existing.body)}`);
  }
  for (const entry of [...existing.body.recording, ...existing.body.nonRecording]) {
    const gone = await api(base, `${RECORDING_HOURS_ROOT}/${entry.id}`, { method: 'DELETE', token });
    if (gone.status >= 400) {
      throw new Error(`could not clear window ${entry.id}: ${gone.status} ${JSON.stringify(gone.body)}`);
    }
  }
  const made = [];
  for (const entry of entries) {
    const r = await api(base, RECORDING_HOURS_ROOT, {
      method: 'POST', token, body: { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], ...entry },
    });
    if (r.status >= 400) {
      throw new Error(`could not store ${JSON.stringify(entry)}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    made.push(r.body.entry);
  }
  return made;
}

module.exports = {
  config, resetSchema, startServer, stopServer, api, raw, sql, systemClientId, pdfText,
  openStudio, SKIP_REASON,
  MINUTES_PER_DAY, IST_OFFSET_MINUTES, wrapMinute, clockLabel, studioMinute, windowAgo,
  RECORDING_HOURS_ROOT, setRecordingWindows,
};
