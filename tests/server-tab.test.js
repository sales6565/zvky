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

test('the work-file parser is gone from the application, not merely unused', () => {
  const upload = SRC('upload.js');
  /* The 200 MB submission parser is deleted. uploadImport stays — a spreadsheet
     of asset names is a few kilobytes of DATA this server parses and unlinks,
     which is a different thing from a work file. */
  const exported = upload.slice(upload.indexOf('module.exports'));
  assert.ok(!/\bupload\b(?!Import)/.test(exported),
    `src/upload.js must not export a work-file parser any more: ${exported.trim()}`);
  assert.match(upload, /module\.exports = \{ uploadImport, UPLOAD_DIR, REVIEW_EXTENSIONS, IMPORT_EXTENSIONS \};/);
  assert.ok(!/const upload = multer\(/.test(upload), 'and must not construct one');
  const assets = SRC('routes/assets.js');
  assert.ok(!/upload\.single\('file'\)/.test(assets), 'the submit route has no file parser');
  assert.match(assets, /router\.post\('\/:id\/submit', refuseFileBody,/,
    'and it refuses a multipart body instead');
  // Exactly one route in the application still parses a file, and it is the
  // spreadsheet import. Anything else would be a second storage path.
  const parsers = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'routes'))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', file), 'utf8');
    for (const m of src.matchAll(/(\w+(?:\.\w+)?)\.(single|array|fields)\(/g)) parsers.push(`${file}:${m[0]}`);
  }
  /* The four that remain are all application-internal and were classified as
     such before this feature was built: the spreadsheet import (twice — assets
     and users), chat attachments, the studio logo, and an avatar. None of them
     is a work file and none of them goes to the office server. */
  assert.deepStrictEqual(parsers.sort(), [
    "assets.js:uploadImport.single(",     // a spreadsheet of asset names
    "assets.js:uploadThumbnail.single(",  // an asset's preview image, in memory, stored as a blob on its row
    "branding.js:upload.single(",         // the studio logo, likewise
    "chat.js:files.upload.array(",        // a chat attachment, deleted after twelve hours
    "users.js:uploadImport.single(",      // a spreadsheet of people
    "users.js:uploadPhoto.single(",       // a profile photo, in memory, stored on the user's row
  ], 'a new file parser appeared; classify it before adding it here');
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

test('a project folder is derived once and then fixed', () => {
  /* THE NAME, NOT THE CODE. projects.code is generated initials in this schema
     — codeFor() in src/routes/projects.js, re-derived on rename — so "Alpha"
     has the code "A" and a code-derived share would be full of single letters.
     src/server-folders.js says so at length. */
  assert.strictEqual(serverFolders.derive({ code: 'A', name: 'Alpha' }), 'Alpha');
  assert.strictEqual(serverFolders.derive({ code: 'ALPHA-24', name: '' }), 'ALPHA-24', 'the code is the fallback');
  assert.strictEqual(serverFolders.derive({ code: '', name: 'Project: Beta/Gamma' }), 'Project Beta Gamma');
  assert.match(serverFolders.derive({ id: 'abcdef12-0000', name: '', code: null }), /^project-abcdef12$/);
  // The snapshot, in the schema: unique, so two projects cannot share a folder.
  const migrate = SRC('migrate.js');
  assert.match(migrate, /ADD UNIQUE KEY uq_projects_server_folder \(server_folder\)/);
  assert.match(migrate, /THE FOLDER A PROJECT OWNS, snapshotted at first use and then fixed/);
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
    await mkProject('alpha', 'Alpha', { code: 'ALPHA', teamLeadIds: [id.lead] });
    await mkProject('beta', 'Beta', { code: 'BETA' });
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
    }
    // And the lead, who holds no server keys either, cannot resolve a request.
    const resolve = await as('lead', '/server/deletion-requests/none/resolve', { method: 'POST', body: { status: 'done' } });
    assert.strictEqual(resolve.status, 403);
  });

  await t.test('a token is scoped to the folders visibleProjects() gives, and no further', async () => {
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

    const state = await as('lead', '/server/state');
    assert.strictEqual(state.status, 200, JSON.stringify(state.body));
    const names = (state.body.roots.entries || []).map((e) => e.name);
    assert.ok(names.includes('Alpha'), `the lead's own project folder is offered: ${names.join(',')}`);
    assert.ok(!names.includes('Beta'), 'and a project they are not on is not');

    // A path outside the prefix is refused even though the folder is real.
    const outside = await as('lead', '/server/token', { method: 'POST', body: { op: 'list', path: 'Beta' } });
    assert.strictEqual(outside.status, 403, JSON.stringify(outside.body));
    assert.match(outside.body.error, /not one you have access to/);

    // And so is every way of writing a traversal.
    for (const p of ['Alpha/../Beta', '../Beta', '/etc', 'C:\\x', 'Alpha%2f..%2fBeta', 'Alpha/../../etc']) {
      const r = await as('lead', '/server/token', { method: 'POST', body: { op: 'list', path: p } });
      assert.ok(r.status === 400 || r.status === 403, `${p} gave ${r.status}`);
    }
    // A subfolder of what they hold is fine — that is how browsing works.
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

    // RESOLVING DELETES NOTHING. There is nothing on this server to delete and
    // no code to do it; what changes is a status and a notification.
    const before = await q('SELECT COUNT(*) AS n FROM asset_versions');
    const done = await as('root', `/server/deletion-requests/${id.request}/resolve`, { method: 'POST',
      body: { status: 'done', note: 'Removed on the file server' } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const after = await q('SELECT COUNT(*) AS n FROM asset_versions');
    assert.strictEqual(Number(after[0].n), Number(before[0].n), 'nothing was deleted');
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
      { version: '1.0.0', configVersion: 99, freeBytes: 500 * 1024 * 1024 * 1024, queued: 0 });
    assert.strictEqual(beat.status, 200, JSON.stringify(beat.body));
    assert.ok(Number.isFinite(beat.body.configVersion), 'and the gateway is told which version to run');

    const got = await settings();
    assert.strictEqual(got.body.gateway.version, '1.0.0');
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

  await t.test('the project folder mapping is snapshotted, editable and unique', async () => {
    const got = await settings();
    const alpha = got.body.mapping.find((m) => m.name === 'Alpha');
    assert.strictEqual(alpha.folder, 'Alpha', 'claimed on first use, from the name');

    // Renaming the project does not move the folder.
    await as('root', `/projects/${id.alpha}`, { method: 'PATCH', body: { name: 'Alpha Rebranded' } });
    const after = await settings();
    assert.strictEqual(after.body.mapping.find((m) => m.id === alpha.id || m.projectId === alpha.projectId).folder, 'Alpha');

    // Pointing it at an existing folder on the share.
    const moved = await as('root', `/admin/settings/server/mapping/${id.alpha}`, { method: 'PATCH', body: { folder: 'ALPHA 2024' } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.folder, 'ALPHA 2024');

    // Two projects cannot share one.
    const clash = await as('root', `/admin/settings/server/mapping/${id.beta}`, { method: 'PATCH', body: { folder: 'ALPHA 2024' } });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error, /Another project already uses/);

    // An impossible folder name is refused where somebody can see it.
    const bad = await as('root', `/admin/settings/server/mapping/${id.beta}`, { method: 'PATCH', body: { folder: '../escape' } });
    assert.strictEqual(bad.status, 400);
  });

  await t.test('the self-test reports step by step and mints only self-test tokens', async () => {
    const out = await as('root', '/admin/settings/server/self-test', { method: 'POST' });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    const keys = out.body.steps.map((s) => s.key);
    assert.deepStrictEqual(keys, ['configured', 'encryption', 'signing_key', 'gateway_secret',
      'heartbeat', 'config_applied', 'disk']);
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

  await t.test('the submit route refuses a file body with 410 and keeps working for a link', async () => {
    const asset = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name: 'Hero', type: 'character' } });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    id.asset = asset.body.asset.id;
    await as('root', `/assets/${id.asset}`, { method: 'PATCH', body: { assigneeId: id.ana } });

    const multipart = await api(server.base, `/assets/${id.asset}/submit`, {
      method: 'POST',
      token: token.ana,
      raw: '--X\r\nContent-Disposition: form-data; name="file"; filename="a.psd"\r\n\r\nbytes\r\n--X--\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=X' },
    });
    assert.strictEqual(multipart.status, 410, JSON.stringify(multipart.body));
    assert.strictEqual(multipart.body.code, 'files_moved');
    assert.match(multipart.body.error, /Server tab/);
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
