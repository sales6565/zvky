/* THE SERVER TAB, from Forge's side.
 *
 * ===========================================================================
 * THE ONE SENTENCE EVERYTHING HERE DEFENDS:
 *
 *   NO FILE EVER TOUCHES THIS SERVER, AND NOTHING CAN DELETE ONE.
 *
 * Both halves are easy to believe and easy to lose. A well-meaning "just proxy
 * it for the off-network case" puts a studio's renders through shared hosting;
 * a "clean up orphaned files" cron turns a request for a deletion into an
 * actual one. So the structural tests below are not decoration — they are the
 * feature. They enumerate the routes, spy on the filesystem, read the schema
 * for BLOB columns and grep the catalogue for a key that could authorise a
 * delete, and they fail if any of it appears.
 *
 * SCOPED TO THE NEW SURFACE, deliberately. Three MEDIUMBLOBs already exist in
 * this schema — a profile photo, the studio logo, an asset thumbnail — and they
 * are application chrome, not work files. The no-blob test therefore names the
 * new tables rather than the database, the same way the Acting Team Leads
 * allowlist named one table rather than refactoring four.
 *
 * FIXED DATA THROUGHOUT. Nothing here reads a clock except where it asserts on
 * staleness, which is given an explicit age.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const catalog = require('../src/permission-catalog');
const serverSettings = require('../src/server-settings');
const serverPaths = require('../src/server-paths');
const serverFolders = require('../src/server-folders');
const serverTokens = require('../src/server-tokens');
const gatewayPaths = require('../gateway/src/paths');
const gatewayRouter = require('../gateway/src/router');
const serviceAuth = require('../src/middleware/service-auth');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8');

const cfg = config('servertab');

/* The commit before any of this feature existed. The production-safety test
   compares src/routes/assets.js against it line for line. */
const BEFORE_FEATURE = 'ff6c03f';

/* Comments mention things code must not do — "see require('../gateway/src/paths')"
   is an explanation, not a dependency — so the structural scans read code. */
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* The Server tab's own code, bounded at both ends. An unbounded slice to the end
   of the file would sweep in every other feature's handlers and assert nothing. */
function serverTabCode() {
  /* TWO PIECES, because the state object sits beside UI_GATES — which reads it
     — and the behaviour sits at the end of the script. A single slice between
     them would span the whole application and assert nothing about this
     feature, which is how the first version of this test passed while proving
     nothing. */
  const objFrom = PAGE.indexOf('const SRV = {');
  const objTo = PAGE.indexOf('\n};', objFrom);
  const codeFrom = PAGE.indexOf("const SRV_RESUME_KEY = 'zvkyServerUploads';");
  const codeTo = PAGE.indexOf('/* ---------- Settings → Server');
  assert.ok(objFrom > 0 && objTo > objFrom, 'found the SRV state object');
  assert.ok(codeFrom > 0 && codeTo > codeFrom, 'found the Server tab code');
  const out = PAGE.slice(objFrom, objTo) + '\n' + PAGE.slice(codeFrom, codeTo);
  // A sanity bound: this is one feature, not the page.
  assert.ok(out.length < 80000, `the Server tab slice is ${out.length} characters — too wide to be asserting on one feature`);
  return out;
}
const PASSWORD = 'Server-Tab-1!';
/* The share as a studio writes it. Backslashes doubled for JavaScript; what is
   stored and compared is \\\\SERVER\\Projects. */
const PREFIX = '\\\\\\\\SERVER\\\\Projects';
const NEW_TABLES = ['server_settings', 'server_events', 'gateway_state', 'deletion_requests'];

// ===========================================================================
// 1. STRUCTURE: no file bodies, no deletion, no file index.
// ===========================================================================

test('no Forge route for the Server tab accepts a file body', () => {
  const routes = SRC('routes/server.js');
  const settings = SRC('routes/server-settings.js');
  const gateway = SRC('routes/gateway.js');
  for (const [name, src] of [['routes/server.js', routes], ['routes/server-settings.js', settings], ['routes/gateway.js', gateway]]) {
    assert.ok(!/multer|upload\.(single|array|fields)|express\.raw\(|busboy|formidable/.test(src),
      `${name} must not mount a file parser`);
    // Nor read a stream itself, which is the other way a body becomes a file.
    assert.ok(!/createWriteStream|pipe\(|writeFileSync|writeFile\(|appendFile/.test(src),
      `${name} must not write to this server's disk`);
  }
});

test('nothing on the Forge side logs a token or a secret', () => {
  /* The gateway's own logger redacts, and tests/gateway-channel.test.js pins
     that. Forge's side has no redacting logger — it has ordinary console calls —
     so the rule here is that none of them is handed a value that could be a
     token or a key. A token in a hosting provider's log file is a link to
     somebody's work sitting in a place with a different audience to the share.
     Mutation [earlier 13] is a console.log of a minted token, and until this
     test existed it passed everything.
  */
  const files = ['routes/server.js', 'routes/server-settings.js', 'routes/gateway.js',
    'server-tokens.js', 'server-settings.js', 'server-folders.js', 'server-submissions.js',
    'server-link.js', 'email-secret.js'];
  /* STRING LITERALS ARE NOT VALUES. A line that says "the signature does not
     match" contains the word signature and leaks nothing; `${secret}` in the
     same line would leak everything. So quoted text is removed and a template
     literal is reduced to its interpolations before the test looks. */
  const values = (args) => args
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`((?:[^`\\]|\\.)*)`/g, (whole, inner) =>
      (inner.match(/\$\{[^}]*\}/g) || []).join(' '));
  const FORBIDDEN = /\b(minted|token|tokens|privateKey|signingPrivate|gatewaySecret|secrets?|plain)\b/;
  let checked = 0;
  for (const f of files) {
    const src = SRC(f);
    const re = /console\.(log|info|warn|error|debug|trace)\(([\s\S]*?)\);/g;
    let m;
    while ((m = re.exec(src))) {
      checked += 1;
      const args = values(m[2]);
      assert.ok(!FORBIDDEN.test(args),
        `src/${f} hands a possible token or secret to console.${m[1]}: ${m[0].slice(0, 160)}`);
    }
  }
  assert.ok(checked >= 3, `expected to have found some logging to check, found ${checked}`);
});

test('the Server secrets never fall back to JWT_SECRET', () => {
  /* ===========================================================================
   * WHY THIS IS A TEST AND NOT A COMMENT.
   *
   * Everywhere else in this application EMAIL_ENCRYPTION_KEY falls back to
   * JWT_SECRET, which is right for a mail password: a feature that is dead on a
   * deployment nobody has configured is worse than one keyed from the session
   * secret. It is wrong for the office file server's two secrets, for two
   * reasons that compound. JWT_SECRET ships as a PLACEHOLDER — so a deployment
   * that has not rotated it would be encrypting a studio's signing key under a
   * value that is in this repository — and rotating it, which whoever deploys is
   * told to do, would make both secrets undecryptable while leaving the feature
   * switched on. The failure would read as "nobody can upload" with nothing
   * pointing at the cause.
   *
   * So the Server settings read the key in STRICT mode. A mutation that drops
   * the `strict` flag, at the key source or at any one call site, has to fail
   * something.
   */
  const emailSecret = require('../src/email-secret');
  const before = { key: process.env.EMAIL_ENCRYPTION_KEY, jwt: process.env.JWT_SECRET };
  try {
    delete process.env.EMAIL_ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'the-placeholder-that-ships-and-is-meant-to-be-rotated';

    // The mail side still borrows it. That is deliberate and stays.
    assert.strictEqual(emailSecret.available(), true);
    assert.strictEqual(emailSecret.keySource().name, 'JWT_SECRET');

    // The Server side does not, and says which variable to set.
    assert.strictEqual(emailSecret.available({ strict: true }), false);
    assert.strictEqual(emailSecret.keySource({ strict: true }).name, null);
    assert.strictEqual(emailSecret.currentFingerprint({ strict: true }), null);
    const sealed = emailSecret.encrypt('a signing key', { strict: true });
    assert.strictEqual(sealed.ok, false);
    assert.match(sealed.error, /EMAIL_ENCRYPTION_KEY/);
    assert.match(sealed.error, /JWT_SECRET is deliberately NOT accepted/);
    // And nothing encrypted under JWT_SECRET can be read back in strict mode.
    const loose = emailSecret.encrypt('a signing key');
    assert.strictEqual(loose.ok, true, 'the mail path still works');
    assert.strictEqual(emailSecret.decrypt(loose.value, loose.keyId, { strict: true }).ok, false);

    // With the real key set, strict mode works and names it.
    process.env.EMAIL_ENCRYPTION_KEY = 'e'.repeat(64);
    assert.strictEqual(emailSecret.available({ strict: true }), true);
    assert.strictEqual(emailSecret.keySource({ strict: true }).name, 'EMAIL_ENCRYPTION_KEY');
    const strictly = emailSecret.encrypt('a signing key', { strict: true });
    assert.strictEqual(strictly.ok, true);
    assert.strictEqual(emailSecret.decrypt(strictly.value, strictly.keyId, { strict: true }).value,
      'a signing key');
  } finally {
    if (before.key === undefined) delete process.env.EMAIL_ENCRYPTION_KEY;
    else process.env.EMAIL_ENCRYPTION_KEY = before.key;
    if (before.jwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = before.jwt;
  }

  /* EVERY CALL SITE, structurally. The flag is an argument, so one call that
     forgets it is a silent fall-back on that path alone — and the three that
     matter most (available, encrypt, decrypt of the signing key and the gateway
     secret) are in one file. Read off the source because the alternative is
     reaching into the settings module's private state from a test process that
     may not have a database. */
  const settings = SRC('server-settings.js');
  const calls = settings.match(/emailSecret\.(available|encrypt|decrypt|currentFingerprint|keySource)\([^)]*\)/g) || [];
  assert.ok(calls.length >= 8, `expected the Server settings to read the key in several places: ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /STRICT/,
      `src/server-settings.js must pass STRICT to every email-secret call: ${call}`);
  }
});

test('PRODUCTION SAFETY: the submit route is exactly what it was', () => {
  /* ===========================================================================
   * THE ONE FLOW EVERY ARTIST IN THE STUDIO USES TODAY.
   *
   * An artist pastes a link into Submit Work and submits. Some of them attach a
   * file alongside it. Both must keep working, untouched, while the office file
   * server is switched off — and after it is switched on, for every project and
   * every role not in the pilot.
   *
   * An earlier version of this feature took the file attachment away and
   * answered 410. That was a change to the one endpoint that must not change,
   * so it was put back, and this is the test that keeps it back: the route is
   * compared with what it was BEFORE any of this existed, with comments
   * stripped, and the parser and the three file columns are named explicitly.
   */
  const assets = SRC('routes/assets.js');
  assert.match(assets, /router\.post\('\/:id\/submit', upload\.single\('file'\), async/,
    'the submit route still takes an optional file, with the same parser');
  assert.match(assets, /req\.file \? req\.file\.originalname : null, req\.file \? req\.file\.filename : null/,
    'and still writes file_name, file_path and file_size from it');
  assert.match(SRC('upload.js'), /module\.exports = \{ upload, uploadImport,/,
    'src/upload.js still exports the work-file parser');
  assert.match(SRC('upload.js'), /limits: \{ fileSize: 200 \* 1024 \* 1024 \}/,
    'with the same 200 MB limit');

  // The legacy download is unchanged too: no new gate, no new status, no header.
  assert.match(assets, /router\.get\('\/versions\/:versionId\/download', async \(req, res\) => \{/);
  const download = assets.slice(assets.indexOf("router.get('/versions/:versionId/download'"));
  const body = download.slice(0, download.indexOf('\n});'));
  assert.ok(!/serveLegacy|legacy_off|X-Legacy-File|code: 'no_file'/.test(body),
    'the legacy download gained no switch and no new refusal');

  /* AND THE WHOLE ROUTE FILE, compared with the commit before this feature
     began. Comments differ — two paragraphs were added saying why this must not
     change — and not one line of code does. */
  const before = execFileSync('git', ['show', `${BEFORE_FEATURE}:src/routes/assets.js`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  /* Block comments FIRST, across lines: a continuation line of one does not
     start with a comment marker, and filtering line by line left those in —
     which made this fail on a paragraph rather than on a change. */
  const code = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
  const mine = code(assets);
  const theirs = code(before);
  if (mine !== theirs) {
    /* Named, so a failure says WHICH line moved rather than "they differ".
       Two lines are expected to differ and both are additive: the two requires
       and the one claim() call, all inert while the feature is off. */
    const a = theirs.split('\n');
    const b = mine.split('\n');
    const added = b.filter((line) => line.trim() && !a.includes(line));
    const removed = a.filter((line) => line.trim() && !b.includes(line));
    assert.deepStrictEqual(removed, [], `the submit route lost code: ${removed.join(' | ')}`);
    for (const line of added) {
      assert.ok(
        /server-settings|server-submissions|submitUploadEnabled\(\)|serverSubmissions\.claim|^\s*\}$/.test(line),
        `src/routes/assets.js gained a line that is not the office file server's additive hook: ${line}`
      );
    }
  }
});

test('with both switches off, nothing in the submission payload changes', () => {
  /* The page's half of the same promise, read off the one function that builds
     the request. With SRV.enabled false the project forms send no serverLink
     key at all — not an empty one — so the request is byte-identical to the one
     the production page sends today. */
  const page = PAGE.slice(PAGE.indexOf("const { project, warnings, serverLinkWarnings } = await api('/projects'") - 1200,
    PAGE.indexOf("const { project, warnings, serverLinkWarnings } = await api('/projects'"));
  assert.match(page, /if\(SRV\.enabled\)\{[\s\S]*?body\.serverLink/,
    'New Project only sends the link while the Server tab is on');
  assert.match(PAGE, /\.\.\.\(SRV\.enabled \? \{ serverLink:/,
    'and so does Edit Project');
  // And the submit box draws nothing at all unless everything says yes.
  assert.match(PAGE, /if\(!SRV\.enabled \|\| !SRV\.submitUploadEnabled \|\| !can\('server\.submit_upload'\)\) return;/);
});

test('there is no delete, rename, move or overwrite anywhere in the feature', () => {
  // On the Forge side: no route, and no permission key that could authorise one.
  const routes = SRC('routes/server.js') + SRC('routes/server-settings.js') + SRC('routes/gateway.js');
  for (const verb of ['router.delete(', 'router.put(']) {
    assert.ok(!routes.includes(verb), `${verb} must not exist in the Server routers`);
  }
  for (const key of catalog.KEYS.filter((k) => k.startsWith('server.'))) {
    assert.ok(!/delete|remove|rename|move|overwrite/.test(key.replace('request_delete', '').replace('manage_requests', '')),
      `${key} must not authorise a deletion`);
  }
  /* The two keys with "delete" in the name are the request and its answer, and
     neither deletes: asserted on what they are DESCRIBED as, so a future
     rewording cannot quietly turn one into a delete. */
  const req = catalog.BY_KEY.get('server.request_delete');
  const man = catalog.BY_KEY.get('server.manage_requests');
  assert.match(req.describe, /Nothing is deleted by Forge/);
  assert.match(man.describe, /deletes nothing here/);

  // On the gateway side: the router table is the whole surface.
  const verbs = new Set(gatewayRouter.ROUTES.map((r) => r.method));
  assert.ok(!verbs.has('DELETE') && !verbs.has('PATCH'),
    'the gateway has no verb that could remove or alter a stored file');

  // And on the page: no button, no handler, no fetch that would ask for one.
  const srv = serverTabCode();
  assert.ok(!/method:\s*'DELETE'/.test(srv), 'the Server tab issues no DELETE');
  assert.ok(!/\brename\b|\bmoveTo\b/i.test(srv.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')),
    'and offers no rename or move');
});

test('the new tables hold no file content and no file index', () => {
  const migrate = SRC('migrate.js');
  const block = migrate.slice(migrate.indexOf('/* The Server tab: settings, the audit trail'),
    migrate.indexOf('async function ensureReminderTables'));
  assert.ok(block.length > 500, 'found the migration step');
  assert.ok(!/BLOB|BINARY|LONGTEXT/i.test(block),
    'no column in the Server tables may hold bytes');
  /* AND NO FILE TABLE. A listing comes from the office server every time; a
     table of names and sizes here would be a second, stale copy of the share
     and the first thing to disagree with it. server_events is an audit of
     actions on paths, which is why it is allowed and why its own comment says
     so. */
  for (const word of ['CREATE TABLE IF NOT EXISTS server_files', 'server_tree', 'file_index']) {
    assert.ok(!block.includes(word), `${word} must not exist`);
  }
  assert.ok(block.includes('WHAT IS DELIBERATELY NOT HERE'), 'and the reason is written down');
});

test('Forge never requires the gateway package at runtime', () => {
  /* It would work here and fail on the host: scripts/build-godaddy-zip.sh ships
     src, public, sql and app.js — not gateway/. src/server-paths.js exists for
     exactly this reason. */
  for (const dir of ['', 'routes', 'middleware']) {
    const base = path.join(ROOT, 'src', dir);
    for (const file of fs.readdirSync(base)) {
      if (!file.endsWith('.js')) continue;
      const src = withoutComments(fs.readFileSync(path.join(base, file), 'utf8'));
      assert.ok(!/require\(['"][^'"]*gateway\/src/.test(src),
        `src/${dir ? `${dir}/` : ''}${file} requires the gateway package, which is not deployed with Forge`);
    }
  }
  const zip = fs.readFileSync(path.join(ROOT, 'scripts', 'build-godaddy-zip.sh'), 'utf8');
  assert.ok(!/\bgateway\b/.test(zip), 'and the deploy zip does not carry it either');
});

test("Forge's path rules behave exactly like the gateway's", () => {
  /* The duplication src/server-paths.js explains, pinned. If either side ever
     changes what "inside" means, a token Forge signs and a path the gateway
     accepts stop being the same set. */
  const cases = [
    ['Alpha/scenes/a.psd', 'Alpha'], ['alpha/scenes', 'Alpha'], ['Alpha', 'Alpha'],
    ['anything', ''], ['Alpha Reserves/a.psd', 'Alpha'], ['Beta', 'Alpha'],
    ['Alpha', 'Alpha/scenes'], ['ALPHA/x', 'alpha'], ['', ''], ['', 'Alpha'],
  ];
  for (const [p, prefix] of cases) {
    assert.strictEqual(serverPaths.within(p, prefix), gatewayPaths.within(p, prefix),
      `within(${JSON.stringify(p)}, ${JSON.stringify(prefix)}) must agree`);
  }
  const names = ['render.psd', 'nul', 'NUL.txt', 'a:b', '..', '.', 'Final render .',
    'x'.repeat(200), '', 'a/b', 'con.psd', 'ok name-1_2.psd'];
  for (const n of names) {
    const mine = serverPaths.cleanName(n);
    const theirs = gatewayPaths.cleanSegment(n);
    assert.strictEqual(mine.ok, theirs.ok, `cleanName(${JSON.stringify(n)}) must agree on ok`);
    if (mine.ok) assert.strictEqual(mine.value, theirs.value, `and on the value for ${JSON.stringify(n)}`);
  }
  for (const p of ['../x', '/etc', 'C:\\x', '%2e%2e%2f', 'a/../b', 'Alpha/ok']) {
    const mine = serverPaths.cleanRelative(p);
    const theirs = gatewayPaths.segments(p);
    assert.strictEqual(mine.ok, theirs.ok, `cleanRelative(${JSON.stringify(p)}) must agree`);
  }
});

test('the mint and the gateway agree on every token lifetime', () => {
  const gwTokens = require('../gateway/src/tokens');
  assert.deepStrictEqual(serverTokens.LIFETIMES,
    Object.fromEntries(Object.entries(gwTokens.OPS).map(([op, d]) => [op, d.maxSeconds])));
});

test('the eight permission keys exist, default to Super Admin, and are all read', () => {
  const keys = ['server.view', 'server.download', 'server.upload', 'server.request_delete',
    'server.manage_requests', 'server.browse_all', 'server.view_audit', 'settings.server.manage'];
  const src = ['routes/server.js', 'routes/server-settings.js', 'server-folders.js'].map(SRC).join('\n');
  for (const key of keys) {
    assert.ok(catalog.BY_KEY.has(key), `${key} is in the catalogue`);
    const read = src.includes(`'${key}'`) || PAGE.includes(`'${key}'`);
    assert.ok(read, `${key} must actually be checked somewhere`);
  }
  // The page gates the tab on the permission AND the switch, never on a role.
  assert.match(PAGE, /serverTabBtn:\s+\(\) => can\('server\.view'\) && SRV\.enabled/);
  const srv = PAGE.slice(PAGE.indexOf('const SRV = {'));
  assert.ok(!/\.role\s*(===?|!==?)\s*['"]/.test(srv), 'and never on a role name');
});

test('the master switch defaults off', () => {
  assert.strictEqual(serverSettings.DEFAULTS.enabled, false);
  const migrate = SRC('migrate.js');
  const block = migrate.slice(migrate.indexOf('CREATE TABLE IF NOT EXISTS server_settings'));
  assert.match(block.slice(0, 1200), /enabled\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/);
});

test('turning the switch on is refused until the gateway is configured', () => {
  const out = serverSettings.validate({ enabled: true }, { settings: { ...serverSettings.DEFAULTS } });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.errors.length, 4, out.errors.join(' | '));
  const ready = serverSettings.validate({ enabled: true }, {
    settings: { ...serverSettings.DEFAULTS, gatewayUrl: 'https://f.example', gatewayId: 'GW', signingPublic: 'k', gatewaySecret: 'c' },
  });
  assert.strictEqual(ready.ok, true, ready.errors.join(' | '));
});

test('an http gateway address is refused, because the page is https', () => {
  const out = serverSettings.validate({ gatewayUrl: 'http://files.office.example' });
  assert.strictEqual(out.ok, false);
  assert.match(out.errors.join(' '), /must be https/);
  assert.strictEqual(serverSettings.validate({ gatewayUrl: 'https://files.office.example/' }).value.gatewayUrl,
    'https://files.office.example');
});

test('summarise() can never carry a secret', () => {
  /* The shape of the answer, not the current value: this is the function the
     Settings screen renders, so anything secret appearing in it would be on
     screen. */
  const text = JSON.stringify(serverSettings.summarise({ state: {} }));
  for (const word of ['signingPrivate', 'signing_private', 'gatewaySecret', 'gateway_secret', 'privateKey', 'BEGIN PRIVATE KEY']) {
    assert.ok(!text.includes(word), `${word} must not appear in what the page is sent`);
  }
  /* And the SHAPE of the secret half: a boolean and a fingerprint, never a
     value. Asserted on the answer rather than on the source, because what
     matters is what reaches the page. */
  const out = serverSettings.summarise({ state: {} });
  assert.deepStrictEqual(Object.keys(out.secret).sort(),
    ['fingerprint', 'previousActive', 'previousUntil', 'set', 'setAt']);
  assert.strictEqual(typeof out.secret.set, 'boolean');
  assert.ok(!('privateKey' in out.signing) && !('value' in out.secret));
});

test('describeChange names a secret rotation without printing it', () => {
  const lines = serverSettings.describeChange(
    { ...serverSettings.DEFAULTS, gatewaySecret: 'OLD-SECRET-VALUE' },
    { ...serverSettings.DEFAULTS, gatewaySecret: 'NEW-SECRET-VALUE' });
  assert.deepStrictEqual(lines, [], 'a secret change is not an audited FIELD change');
  const text = JSON.stringify(serverSettings.describeChange(
    { ...serverSettings.DEFAULTS, enabled: false }, { ...serverSettings.DEFAULTS, enabled: true }));
  assert.match(text, /Server tab: off → on/);
});

// ===========================================================================
// 2. LIVE: permissions, scoping, audit, deletion requests, the gateway channel.
// ===========================================================================

test('the Server tab, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'srv-token',
      WORK_HOURS_SWEEP_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      EMAIL_BATCH_MS: '0',
      // A known key, so the encrypted-at-rest path is exercised rather than skipped.
      EMAIL_ENCRYPTION_KEY: 'k'.repeat(64),
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'srv-token', name: 'Root', email: 'root@srv.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@srv.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('lead', 'Lee Lead', 'lee@srv.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@srv.test', 'game_artist');

    id.client = await systemClientId(server.base, token.root);
    const mkProject = async (key, name, body = {}) => {
      const r = await as('root', '/projects', { method: 'POST', body: { name, clientId: id.client, ...body } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('alpha', 'Alpha', { teamLeadIds: [id.lead] });
    await mkProject('beta', 'Beta');
  });

  t.after(() => stopServer(server));

  const settings = () => as('root', '/admin/settings/server');
  const patch = (body) => as('root', '/admin/settings/server', { method: 'PATCH', body });

  await t.test('with the switch off the tab is invisible and every endpoint is 409', async () => {
    const me = await as('root', '/auth/me');
    assert.strictEqual(me.body.serverEnabled, false, 'the page is told the switch is off');

    const state = await as('root', '/server/state');
    assert.strictEqual(state.status, 200, 'state is readable, so the tab can draw its disabled text');
    assert.strictEqual(state.body.enabled, false);

    for (const [method, p, body] of [
      ['POST', '/server/token', { op: 'list', path: '' }],
      ['POST', '/server/upload-session', { path: '', name: 'a.psd', size: 10 }],
    ]) {
      const r = await as('root', p, { method, body });
      assert.strictEqual(r.status, 409, `${p}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'feature_disabled');
    }
  });

  await t.test('turning it on needs the key and the secret, in that order', async () => {
    const refused = await patch({ enabled: true });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /gateway address/);

    await patch({ gatewayUrl: 'https://files.office.test', gatewayId: 'GW-OFFICE' });
    const stillRefused = await patch({ enabled: true });
    assert.strictEqual(stillRefused.status, 400);
    assert.match(stillRefused.body.error, /signing key/);

    const keys = await as('root', '/admin/settings/server/keys', { method: 'POST' });
    assert.strictEqual(keys.status, 200, JSON.stringify(keys.body));
    assert.match(keys.body.publicKey, /BEGIN PUBLIC KEY/);
    assert.ok(keys.body.kid);
    assert.strictEqual(keys.body.rotated, false);
    assert.ok(!JSON.stringify(keys.body).includes('PRIVATE KEY'), 'the private half never leaves the server');

    const secret = await as('root', '/admin/settings/server/secret', { method: 'POST' });
    assert.strictEqual(secret.status, 200, JSON.stringify(secret.body));
    assert.ok(/^[A-Za-z0-9]{64}$/.test(secret.body.secret), 'shown once, as 64 letters and digits');
    assert.strictEqual(secret.body.shownOnce, true);
    id.secret = secret.body.secret;

    const on = await patch({ enabled: true });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    assert.strictEqual(on.body.settings.enabled, true);
    assert.ok(on.body.changes.some((c) => /Server tab: off → on/.test(c)), on.body.changes.join('|'));
  });

  await t.test('the prefix is what a project link is checked against', async () => {
    /* Nothing about projects works until it is set, and that is the point of
       it: without a prefix there is nothing to validate a link against. */
    const before = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha` } });
    assert.strictEqual(before.status, 400, JSON.stringify(before.body));
    assert.match(before.body.error, /prefix/);

    const bad = await patch({ linkPrefix: 'Projects' });
    assert.strictEqual(bad.status, 400, 'a prefix with no separator is not a share');

    const set = await patch({ linkPrefix: PREFIX });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.strictEqual(set.body.settings.linkPrefix, PREFIX);

    // And now the project takes one.
    const linked = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha` } });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.body));
    assert.strictEqual(linked.body.project.serverLink, `${PREFIX}\\Alpha`);
    assert.strictEqual(linked.body.project.serverFolderRelative, 'Alpha');

    const beta = await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Beta` } });
    assert.strictEqual(beta.status, 200, JSON.stringify(beta.body));
  });

  await t.test('and after saving, neither secret can be read back by anybody', async () => {
    const got = await settings();
    const text = JSON.stringify(got.body);
    assert.ok(!text.includes(id.secret), 'the gateway secret is never returned again');
    assert.ok(!text.includes('PRIVATE KEY'), 'nor the private signing key');
    assert.strictEqual(got.body.settings.secret.set, true);
    assert.match(got.body.settings.secret.fingerprint, /^key:[0-9a-f]+$/);

    // Not in the activity log either.
    const log = await as('root', '/activity?limit=50');
    assert.ok(!JSON.stringify(log.body).includes(id.secret), 'and not in the audit trail');

    // And the row holds ciphertext, not the secret.
    const rows = await q('SELECT gateway_secret, signing_private FROM server_settings WHERE id = 1');
    assert.ok(rows[0].gateway_secret.startsWith('v1:'), 'stored as AES-256-GCM ciphertext');
    assert.ok(!rows[0].gateway_secret.includes(id.secret));
    assert.ok(rows[0].signing_private.startsWith('v1:'));
  });

  await t.test('every endpoint checks its own permission', async () => {
    /* Ana is a game artist: she holds none of the server.* keys, because they
       all default to Super Admin. Each endpoint must say so itself rather than
       relying on the tab being hidden. */
    const calls = [
      ['GET', '/server/state'],
      ['POST', '/server/token', { op: 'list', path: '' }],
      ['POST', '/server/upload-session', { path: 'ALPHA', name: 'a.psd', size: 10 }],
      ['GET', '/server/audit'],
      ['GET', '/admin/settings/server'],
      ['POST', '/admin/settings/server/keys'],
      ['POST', '/admin/settings/server/secret'],
      ['POST', '/admin/settings/server/self-test'],
      ['POST', '/server/deletion-requests', { path: 'ALPHA/a.psd', reason: 'x' }],
    ];
    for (const [method, p, body] of calls) {
      const r = await as('ana', p, { method, body });
      assert.strictEqual(r.status, 403, `${method} ${p} gave ${r.status}: ${JSON.stringify(r.body)}`);
      /* AND REFUSED BY THE ROUTE'S OWN GATE, which is the half a status code
         cannot tell you. Several of these have a SECOND check inside them —
         /server/token re-asks per operation, because `list`, `download` and
         `mkdir` are different keys — and those inner checks answer 403 too, with
         a different sentence. So a dropped requirePermission would leave the
         status unchanged and only the wording would move, which is exactly the
         mutation this has to notice. The middleware's sentence is the pin. */
      assert.strictEqual(r.body && r.body.error, 'You do not have permission to do that',
        `${method} ${p} must be refused by requirePermission itself, not by a later check: `
        + JSON.stringify(r.body));
    }
    // And the lead, who holds no server keys either, cannot resolve a request.
    const resolve = await as('lead', '/server/deletion-requests/none/resolve', { method: 'POST', body: { status: 'done' } });
    assert.strictEqual(resolve.status, 403);
  });

  await t.test('a token is scoped to the projects visibleProjects() gives, and no further', async () => {
    // Root holds server.browse_all by default, so the root itself is reachable.
    const rootTok = await as('root', '/server/token', { method: 'POST', body: { op: 'list', path: '' } });
    assert.strictEqual(rootTok.status, 200, JSON.stringify(rootTok.body));

    /* Grant the lead the tab, a download, an upload and the right to ask for a
       deletion — and nothing else. The endpoint replaces the role's whole set,
       so the current one is read first: this is a grant, not a reset. */
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((pp) => pp.enabled).map((pp) => pp.key);
    assert.ok(!held.some((k) => k.startsWith('server.')),
      'a team lead starts with none of the server keys, which is the documented default');
    const put = await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...held, 'server.view', 'server.download', 'server.upload', 'server.request_delete'] } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    /* THE TOP LEVEL IS A LIST OF PROJECTS, not a listing of the share. The lead
       is on Alpha and not on Beta, so that is what they get — by project NAME,
       with the link as a subtitle, answered from Forge's own database because a
       non-admin may not read the share's root at all. */
    const state = await as('lead', '/server/state');
    assert.strictEqual(state.status, 200, JSON.stringify(state.body));
    assert.strictEqual(state.body.roots.all, false);
    const names = (state.body.roots.entries || []).map((e) => e.label);
    assert.deepStrictEqual(names, ['Alpha'], `the lead's own project: ${names.join(',')}`);
    assert.strictEqual(state.body.roots.entries[0].path, 'Alpha');
    assert.strictEqual(state.body.roots.entries[0].subtitle, `${PREFIX}\\Alpha`,
      'the link is shown as the subtitle, so somebody can see which folder it is');

    // A path outside the prefix is refused even though the folder is real.
    const outside = await as('lead', '/server/token', { method: 'POST', body: { op: 'list', path: 'Beta' } });
    assert.strictEqual(outside.status, 403, JSON.stringify(outside.body));
    assert.match(outside.body.error, /not one you have access to/);

    // And so is every way of writing a traversal.
    for (const p of ['Alpha/../Beta', '../Beta', '/etc', 'C:\\x', 'Alpha%2f..%2fBeta', 'Alpha/../../etc']) {
      const r = await as('lead', '/server/token', { method: 'POST', body: { op: 'list', path: p } });
      assert.ok(r.status === 400 || r.status === 403, `${p} gave ${r.status}`);
    }
    // A subfolder of their project is fine — that is how browsing works.
    const deeper = await as('lead', '/server/token', { method: 'POST', body: { op: 'list', path: 'Alpha/scenes' } });
    assert.strictEqual(deeper.status, 200, JSON.stringify(deeper.body));
  });

  await t.test('the minted token says exactly what Forge decided', async () => {
    const gwTokens = require('../gateway/src/tokens');
    const got = await settings();
    const pub = got.body.settings.signing.publicKey;
    const minted = await as('lead', '/server/token', { method: 'POST', body: { op: 'download', path: 'Alpha/render.psd' } });
    assert.strictEqual(minted.status, 200, JSON.stringify(minted.body));
    const v = gwTokens.verify(minted.body.token, {
      keys: [{ kid: got.body.settings.signing.kid, publicKey: pub }],
      audience: 'GW-OFFICE', jtiStore: new gwTokens.JtiStore(), expect: { op: 'download' },
    });
    assert.ok(v.ok, JSON.stringify(v));
    assert.strictEqual(v.claims.sub, id.lead, 'it names the person');
    assert.strictEqual(v.claims.path, 'Alpha/render.psd', 'and one path');
    assert.ok(v.claims.exp - v.claims.iat <= 60, 'and lives a minute at most');
    // It carries no permission list: the grant was decided at mint time.
    assert.ok(!('permissions' in v.claims) && !('role' in v.claims));
  });

  await t.test('an upload session validates the size and the extension before signing', async () => {
    const big = await as('lead', '/server/upload-session', { method: 'POST',
      body: { path: 'Alpha', name: 'huge.psd', size: 60 * 1024 * 1024 * 1024 } });
    assert.strictEqual(big.status, 413, JSON.stringify(big.body));

    const exe = await as('lead', '/server/upload-session', { method: 'POST',
      body: { path: 'Alpha', name: 'payload.exe', size: 10 } });
    assert.strictEqual(exe.status, 415, JSON.stringify(exe.body));

    const ok = await as('lead', '/server/upload-session', { method: 'POST',
      body: { path: 'Alpha', name: 'render.psd', size: 1024 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.uploadId && ok.body.token);
    assert.strictEqual(ok.body.chunkBytes, 32 * 1024 * 1024);
    id.upload = ok.body.uploadId;

    // Renewal keeps the id and re-decides everything else.
    const renewed = await as('lead', `/server/upload-session/${id.upload}/renew`, { method: 'POST',
      body: { path: 'Alpha', name: 'render.psd', size: 1024 } });
    assert.strictEqual(renewed.status, 200, JSON.stringify(renewed.body));
    assert.strictEqual(renewed.body.uploadId, id.upload);
    assert.strictEqual(renewed.body.renewed, true);
    assert.notStrictEqual(renewed.body.token, ok.body.token, 'a fresh token, not the same one again');

    // A renewal for a path they have lost access to is refused.
    const elsewhere = await as('lead', `/server/upload-session/${id.upload}/renew`, { method: 'POST',
      body: { path: 'Beta', name: 'render.psd', size: 1024 } });
    assert.strictEqual(elsewhere.status, 403);
  });

  await t.test('every mint writes an audit row, and the trail is readable with its own key', async () => {
    const rows = await q("SELECT action, path, user_id FROM server_events ORDER BY at");
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes('list'), `list is audited: ${actions.join(',')}`);
    assert.ok(actions.includes('download_issued'), 'and so is a download token');
    assert.ok(actions.includes('upload_started'), 'and the start of an upload');
    assert.ok(rows.some((r) => r.user_id === id.lead), 'with the person on it');

    const audit = await as('root', '/server/audit?limit=10');
    assert.strictEqual(audit.status, 200);
    assert.ok(audit.body.events.length);
    assert.ok(audit.body.total >= audit.body.events.length);
    // The lead holds no server.view_audit, so the trail is not theirs to read.
    assert.strictEqual((await as('lead', '/server/audit')).status, 403);
  });

  await t.test('a deletion request notifies, refuses a duplicate, and deletes nothing', async () => {
    const made = await as('lead', '/server/deletion-requests', { method: 'POST',
      body: { path: 'Alpha/render.psd', type: 'file', reason: 'Superseded by the new render' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    id.request = made.body.id;
    assert.ok(made.body.notified >= 1, 'somebody was told');

    const again = await as('lead', '/server/deletion-requests', { method: 'POST',
      body: { path: 'Alpha/render.psd', type: 'file', reason: 'Asking twice' } });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body.code, 'already_requested');
    // Case does not create a second one either: the share does not distinguish it.
    const cased = await as('lead', '/server/deletion-requests', { method: 'POST',
      body: { path: 'alpha/RENDER.psd', type: 'file', reason: 'Different case' } });
    assert.strictEqual(cased.status, 409, JSON.stringify(cased.body));

    const notes = await q('SELECT kind, detail, recipient_id FROM notifications WHERE kind = ?', ['server_delete_request']);
    assert.ok(notes.length >= 1, 'an in-app notification was raised');
    assert.match(notes[0].detail, /Superseded by the new render/);
    assert.strictEqual(notes[0].recipient_id, id.root, 'to whoever holds server.manage_requests');

    // A reason is required.
    const empty = await as('lead', '/server/deletion-requests', { method: 'POST', body: { path: 'Alpha/other.psd', reason: '  ' } });
    assert.strictEqual(empty.status, 400);

    /* RESOLVING DELETES NOTHING. There is nothing on this server to delete and
       no code to do it; what changes is a status and a notification.
       
       A SENTINEL FIRST, because a count of an empty table proves nothing — and
       the first version of this assertion did exactly that, which is how a
       mutation that added a DELETE to the resolve handler passed it. There is
       now a row to lose. */
    const sentinelAsset = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name: 'Sentinel', type: 'character' } });
    assert.strictEqual(sentinelAsset.status, 201, JSON.stringify(sentinelAsset.body));
    id.sentinelVersion = crypto.randomUUID();
    await q('INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by) '
      + 'VALUES (?,?,?,?,?,?)',
      [id.sentinelVersion, sentinelAsset.body.asset.id, 1, 'tl', 'https://example.test/sentinel', id.root]);

    const counts = async () => {
      const out = {};
      for (const table of ['asset_versions', 'assets', 'projects', 'users', 'server_events', 'notifications']) {
        const rows = await q(`SELECT COUNT(*) AS n FROM ${table}`);
        out[table] = Number(rows[0].n);
      }
      return out;
    };
    const before = await counts();
    assert.ok(before.asset_versions >= 1, 'there is a submission row for a resolve to fail to delete');

    const done = await as('root', `/server/deletion-requests/${id.request}/resolve`, { method: 'POST',
      body: { status: 'done', note: 'Removed on the file server' } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));

    const after = await counts();
    assert.strictEqual(after.asset_versions, before.asset_versions, 'no submission was deleted');
    assert.strictEqual(after.assets, before.assets, 'no asset was deleted');
    assert.strictEqual(after.projects, before.projects, 'no project was deleted');
    assert.strictEqual(after.users, before.users, 'no account was deleted');
    assert.strictEqual(after.server_events, before.server_events, 'resolving is not an action on a file');
    assert.ok(after.notifications > before.notifications, 'the only thing added is the notice to the requester');
    const sentinel = await q('SELECT id FROM asset_versions WHERE id = ?', [id.sentinelVersion]);
    assert.strictEqual(sentinel.length, 1, 'and the row that was there before is still there');
    const stillThere = await q('SELECT status, admin_note FROM deletion_requests WHERE id = ?', [id.request]);
    assert.strictEqual(stillThere[0].status, 'done');
    assert.strictEqual(stillThere[0].admin_note, 'Removed on the file server');

    const told = await q('SELECT detail FROM notifications WHERE kind = ?', ['server_delete_resolved']);
    assert.ok(told.length === 1, 'the requester is told');
    assert.match(told[0].detail, /Removed on the file server/);

    // Resolving twice is refused rather than silently re-resolved.
    const twice = await as('root', `/server/deletion-requests/${id.request}/resolve`, { method: 'POST', body: { status: 'declined' } });
    assert.strictEqual(twice.status, 409);

    // And once resolved, the same path may be asked about again.
    const fresh = await as('lead', '/server/deletion-requests', { method: 'POST',
      body: { path: 'Alpha/render.psd', type: 'file', reason: 'It came back' } });
    assert.strictEqual(fresh.status, 201, JSON.stringify(fresh.body));
  });

  await t.test('deletion requests stay usable with the feature switched off', async () => {
    await patch({ enabled: false });
    const list = await as('root', '/server/deletion-requests');
    assert.strictEqual(list.status, 200, 'still readable');
    const open = list.body.requests.find((r) => r.status === 'open');
    assert.ok(open, 'and the open one is there');
    const resolved = await as('root', `/server/deletion-requests/${open.id}/resolve`, { method: 'POST', body: { status: 'declined' } });
    assert.strictEqual(resolved.status, 200, 'and resolvable');
    // While the gateway endpoints are closed again.
    const tok = await as('root', '/server/token', { method: 'POST', body: { op: 'list', path: '' } });
    assert.strictEqual(tok.status, 409);
    assert.strictEqual(tok.body.code, 'feature_disabled');
    await patch({ enabled: true });
  });

  // --- the gateway's own channel ------------------------------------------
  const signed = (method, p, bodyObject, { secret, gwId, t } = {}) => {
    const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
    const when = t === undefined ? Math.floor(Date.now() / 1000) : t;
    const v1 = crypto.createHmac('sha256', secret === undefined ? id.secret : secret)
      .update(serviceAuth.signingPayload(when, method, p, body)).digest('hex');
    return api(server.base, p.replace('/api', ''), {
      method,
      body: bodyObject,
      headers: {
        'x-gateway-id': gwId === undefined ? 'GW-OFFICE' : gwId,
        'x-gateway-signature': `t=${when}, v1=${v1}`,
      },
    });
  };

  await t.test('the gateway channel accepts a correct signature and refuses every wrong one', async () => {
    const ok = await signed('GET', '/api/gateway/config', undefined);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Array.isArray(ok.body.keys) && ok.body.keys.length === 1, 'the public key is published');
    assert.ok(!JSON.stringify(ok.body).includes('PRIVATE KEY'), 'and nothing private is');
    assert.ok(!JSON.stringify(ok.body).includes(id.secret), 'nor the secret');
    assert.strictEqual(ok.body.maxFileBytes, 50 * 1024 * 1024 * 1024);

    const wrongSecret = await signed('GET', '/api/gateway/config', undefined, { secret: 'x'.repeat(64) });
    assert.strictEqual(wrongSecret.status, 401, JSON.stringify(wrongSecret.body));

    const wrongId = await signed('GET', '/api/gateway/config', undefined, { gwId: 'GW-SOMEWHERE-ELSE' });
    assert.strictEqual(wrongId.status, 403, JSON.stringify(wrongId.body).slice(0, 200));

    const old = await signed('GET', '/api/gateway/config', undefined, { t: Math.floor(Date.now() / 1000) - 3600 });
    assert.strictEqual(old.status, 401, 'a replayed timestamp is refused');

    const unsigned = await api(server.base, '/gateway/config', { headers: { 'x-gateway-id': 'GW-OFFICE' } });
    assert.strictEqual(unsigned.status, 401);
  });

  await t.test('a heartbeat is recorded and read back as online, then stale', async () => {
    const beat = await signed('POST', '/api/gateway/heartbeat',
      { version: '1.0.0', configVersion: 99, freeBytes: 500 * 1024 * 1024 * 1024, queued: 0,
        clockSkewSeconds: 2, fileRoot: 'D:\\Projects' });
    assert.strictEqual(beat.status, 200, JSON.stringify(beat.body));
    assert.ok(Number.isFinite(beat.body.configVersion), 'and the gateway is told which version to run');
    /* FORGE'S OWN CLOCK comes back, because it is the clock that signed the
       token the gateway is about to verify. */
    assert.ok(Date.parse(beat.body.now) > 0, `the answer carries Forge's time: ${beat.body.now}`);

    const got = await settings();
    assert.strictEqual(got.body.gateway.version, '1.0.0');
    /* THE SHARE THE GATEWAY SAYS IT IS SERVING, and the measured skew. Neither
       can be known from this side, and the first is half of the one check
       nobody can automate: the link prefix and FILE_ROOT must be the same
       place. The self-test prints them together, so it is pinned there too. */
    assert.strictEqual(got.body.gateway.fileRoot, 'D:\\Projects');
    assert.strictEqual(got.body.gateway.clockSkewSeconds, 2);
    assert.strictEqual(got.body.gateway.clockSkewWarn, false);
    assert.ok(got.body.gateway.ageSeconds !== null && got.body.gateway.ageSeconds < 60);
    assert.strictEqual(got.body.settings.readiness.heartbeatReceived, true);
    assert.strictEqual(got.body.settings.readiness.heartbeatFresh, true);
    /* The configuration the gateway SAYS it is running does not match what was
       saved, which is exactly the state the panel exists to show. */
    assert.strictEqual(got.body.settings.readiness.configApplied, false);

    // Age it, and the same answer turns to offline — without changing any code.
    await q("UPDATE gateway_state SET last_seen = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = 1");
    const later = await as('root', '/server/state');
    assert.strictEqual(later.body.gateway.online, false);
    assert.ok(later.body.gateway.ageSeconds >= 540);
  });

  await t.test('a callback is recorded once, however many times it arrives', async () => {
    const callbackId = crypto.randomUUID();
    const body = { kind: 'upload_completed', id: callbackId, path: 'Alpha/new.psd', size: 2048, userId: id.lead };
    const first = await signed('POST', '/api/gateway/callback', body);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await signed('POST', '/api/gateway/callback', body);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.duplicate, true, 'the same id again is a success, not a second row');
    const rows = await q('SELECT COUNT(*) AS n FROM server_events WHERE external_id = ?', [`upload_completed:${callbackId}`]);
    assert.strictEqual(Number(rows[0].n), 1);

    // A bad HMAC is refused and records nothing.
    const forged = await signed('POST', '/api/gateway/callback',
      { kind: 'upload_completed', id: crypto.randomUUID(), path: 'Alpha/x.psd' }, { secret: 'y'.repeat(64) });
    assert.strictEqual(forged.status, 401);

    // An unknown kind is a permanent 400, so the gateway drops it.
    const unknown = await signed('POST', '/api/gateway/callback', { kind: 'file_deleted', id: crypto.randomUUID() });
    assert.strictEqual(unknown.status, 400, JSON.stringify(unknown.body));

    // A callback naming a user this studio does not have is refused.
    const stranger = await signed('POST', '/api/gateway/callback',
      { kind: 'upload_completed', id: crypto.randomUUID(), path: 'a', userId: crypto.randomUUID() });
    assert.strictEqual(stranger.status, 400);

    // The checksum arrives separately and lands on its own row.
    const sha = await signed('POST', '/api/gateway/callback',
      { kind: 'checksum_ready', id: crypto.randomUUID(), path: 'Alpha/new.psd', sha256: 'a'.repeat(64), userId: id.lead });
    assert.strictEqual(sha.status, 200);
    const stored = await q("SELECT sha256 FROM server_events WHERE action = 'checksum' LIMIT 1");
    assert.strictEqual(stored[0].sha256, 'a'.repeat(64));
  });

  await t.test('rotating the signing key keeps the old one valid for the overlap', async () => {
    const before = await settings();
    const oldKid = before.body.settings.signing.kid;
    const rotated = await as('root', '/admin/settings/server/keys', { method: 'POST' });
    assert.strictEqual(rotated.status, 200, JSON.stringify(rotated.body));
    assert.strictEqual(rotated.body.rotated, true);
    assert.strictEqual(rotated.body.previousKid, oldKid);

    const config = await signed('GET', '/api/gateway/config', undefined);
    const kids = config.body.keys.map((k) => k.kid);
    assert.strictEqual(kids.length, 2, `both keys are published during the overlap: ${kids.join(',')}`);
    assert.ok(kids.includes(oldKid) && kids.includes(rotated.body.kid));

    /* Past the overlap, only the new one. The row is aged directly rather than
       by waiting out the window, so the in-memory mirror is re-read afterwards
       — an empty PATCH does that and changes nothing else. */
    await q('UPDATE server_settings SET prev_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = 1');
    await patch({});
    const later = await signed('GET', '/api/gateway/config', undefined);
    assert.deepStrictEqual(later.body.keys.map((k) => k.kid), [rotated.body.kid]);
  });

  await t.test('regenerating the secret accepts both for the overlap', async () => {
    const out = await as('root', '/admin/settings/server/secret', { method: 'POST' });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.regenerated, true);
    const fresh = out.body.secret;

    const withNew = await signed('GET', '/api/gateway/config', undefined, { secret: fresh });
    assert.strictEqual(withNew.status, 200, 'the new secret works');
    const withOld = await signed('GET', '/api/gateway/config', undefined, { secret: id.secret });
    assert.strictEqual(withOld.status, 200, 'and the old one still does, during the overlap');

    await q('UPDATE server_settings SET gateway_secret_prev_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = 1');
    await patch({});
    const expired = await signed('GET', '/api/gateway/config', undefined, { secret: id.secret });
    assert.strictEqual(expired.status, 401, 'past the overlap the old one stops');
    id.secret = fresh;
  });

  await t.test('the project link is edited on the project, and the overview is read-only', async () => {
    /* THERE IS NO MAPPING TABLE TO EDIT ANY MORE. A project's folder is its
       link, typed on the project beside its other fields, by whoever edits
       projects. Settings shows what those links resolve to and cannot change
       them — one place, one permission. */
    const got = await settings();
    const alpha = got.body.projects.find((m) => m.name === 'Alpha');
    assert.ok(alpha, 'the overview lists every project');
    assert.strictEqual(alpha.link, `${PREFIX}\\Alpha`);
    assert.strictEqual(alpha.relative, 'Alpha');
    assert.strictEqual(alpha.valid, true);
    assert.ok(!('wouldBe' in alpha), 'and nothing is derived from a name any more');

    // The old editing endpoint is gone, not merely unused.
    const gone = await as('root', `/admin/settings/server/mapping/${id.alpha}`, { method: 'PATCH', body: { folder: 'X' } });
    assert.strictEqual(gone.status, 404, JSON.stringify(gone.body));

    /* RENAMING THE PROJECT MOVES NOTHING, because the link is what the folder
       is — not a name derived from the project. */
    await as('root', `/projects/${id.alpha}`, { method: 'PATCH', body: { name: 'Alpha Rebranded' } });
    const after = await settings();
    const same = after.body.projects.find((m) => m.projectId === id.alpha);
    assert.strictEqual(same.link, `${PREFIX}\\Alpha`, 'the link is untouched by a rename');
    assert.strictEqual(same.relative, 'Alpha');

    /* CHANGING THE LINK IS ASKED ABOUT FIRST, and the answer moves nothing. */
    const unconfirmed = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha 2026` } });
    assert.strictEqual(unconfirmed.status, 409, JSON.stringify(unconfirmed.body));
    assert.strictEqual(unconfirmed.body.requiresConfirmation, true);
    assert.strictEqual(unconfirmed.body.field, 'serverLink');
    assert.match(unconfirmed.body.error, /Existing files stay in the old folder/);
    assert.match(unconfirmed.body.error, /Nothing is moved or deleted/);
    const still = await q('SELECT server_link FROM projects WHERE id = ?', [id.alpha]);
    assert.strictEqual(still[0].server_link, `${PREFIX}\\Alpha`, 'and nothing was written');

    const confirmed = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha 2026`, confirmLinkChange: true } });
    assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.strictEqual(confirmed.body.project.serverFolderRelative, 'Alpha 2026');

    // And it is in the studio's record, with both sides of the change.
    const log = await as('root', '/activity?module=projects&limit=20');
    const entry = (log.body.entries || []).find((e) => e.action === 'project.server_link.set');
    assert.ok(entry, 'the repoint is audited');
    assert.match(entry.summary, /Repointed/);

    // Put it back for the tests that follow.
    await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha`, confirmLinkChange: true } });
  });

  await t.test('overlapping links warn and do not refuse', async () => {
    const inside = await as('root', `/projects/${id.beta}`, { method: 'POST' }).catch(() => null);
    const made = await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Alpha\\Shared`, confirmLinkChange: true } });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    const warnings = made.body.serverLinkWarnings || [];
    assert.ok(warnings.some((w) => w.kind === 'inside'), JSON.stringify(warnings));
    assert.match(warnings[0].message, /can see this project's work|inside/);
    // Saved anyway: two projects sharing a parent is a real arrangement.
    const check = await q('SELECT server_link FROM projects WHERE id = ?', [id.beta]);
    assert.strictEqual(check[0].server_link, `${PREFIX}\\Alpha\\Shared`);
    await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Beta`, confirmLinkChange: true } });
    assert.ok(inside === null || inside, 'the probe above is incidental');
  });

  await t.test('Check folder mints a list token for a link being typed', async () => {
    const out = await as('root', '/server/check-folder', { method: 'POST', body: { link: `${PREFIX}\\Alpha\\scenes` } });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.path, 'Alpha/scenes');
    assert.ok(out.body.token);
    // Not for a link outside the prefix, and not for somebody who cannot edit projects.
    const no = await as('root', '/server/check-folder', { method: 'POST', body: { link: '\\\\OTHER\\x\\y' } });
    assert.strictEqual(no.status, 400, JSON.stringify(no.body));
    assert.strictEqual((await as('ana', '/server/check-folder', { method: 'POST', body: { link: `${PREFIX}\\Alpha` } })).status, 403);
  });

  await t.test('the self-test reports step by step and mints only self-test tokens', async () => {
    const out = await as('root', '/admin/settings/server/self-test', { method: 'POST' });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    const keys = out.body.steps.map((s) => s.key);
    /* link_prefix is second, straight after the address: the prefix and the
       gateway's FILE_ROOT are the same place in two notations, nothing can
       check that they match, and putting them side by side is the whole point
       of the step. */
    assert.deepStrictEqual(keys, ['configured', 'link_prefix', 'encryption', 'signing_key',
      'gateway_secret', 'heartbeat', 'config_applied', 'clock', 'disk']);
    const prefixStep = out.body.steps.find((st) => st.key === 'link_prefix');
    assert.strictEqual(prefixStep.ok, true);
    assert.match(prefixStep.detail, /FILE_ROOT/, 'and it names the other half by name');
    /* AND PRINTS BOTH VALUES. The prefix is Forge's; FILE_ROOT arrives on the
       heartbeat, because only the office machine knows it. A step that named
       the idea without showing the two strings would leave the one thing
       nobody can automate still unanswerable. */
    assert.match(prefixStep.detail, new RegExp(PREFIX.replace(/[\\]/g, '\\\\')),
      `the prefix itself: ${prefixStep.detail}`);
    assert.match(prefixStep.detail, /D:\\Projects/, `and the gateway's share: ${prefixStep.detail}`);
    assert.ok(out.body.probe && out.body.probe.putToken && out.body.probe.getToken);

    const gwTokens = require('../gateway/src/tokens');
    const got = await settings();
    const v = gwTokens.verify(out.body.probe.putToken, {
      keys: [{ kid: got.body.settings.signing.kid, publicKey: got.body.settings.signing.publicKey }],
      audience: 'GW-OFFICE', jtiStore: new gwTokens.JtiStore(),
    });
    assert.ok(v.ok, JSON.stringify(v));
    assert.strictEqual(v.claims.op, 'selftest', 'a self-test token and nothing else');
    assert.strictEqual(v.claims.path, '', 'the gateway puts it in .incoming/selftest itself');
  });

  await t.test('NOTHING in any of this wrote a file to the Forge disk', async () => {
    /* The claim the whole feature rests on, measured rather than argued. The
       uploads directory is where work files used to land; after a run that
       minted tokens, opened upload sessions, created and resolved deletion
       requests, took callbacks and refused a multipart submit, it must hold
       nothing new. */
    const uploads = path.join(ROOT, 'uploads');
    const listing = fs.existsSync(uploads)
      ? fs.readdirSync(uploads).filter((n) => n !== 'chat' && n !== '.gitkeep')
      : [];
    assert.deepStrictEqual(listing, [], `uploads/ gained ${listing.join(', ')}`);
    // And no column in the new tables holds bytes.
    for (const table of NEW_TABLES) {
      const cols = await q(
        'SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS '
        + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
      const blobs = cols.filter((c) => /blob|binary/i.test(c.t)).map((c) => c.c);
      assert.deepStrictEqual(blobs, [], `${table} has byte columns: ${blobs.join(', ')}`);
    }
  });
});
