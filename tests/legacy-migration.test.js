/* MOVING THE FILES FORGE IS STILL HOLDING.
 *
 * The migration tool is the one piece of this feature that is both ends at
 * once: it pulls from the hosting over the internet and pushes to the office
 * server over the LAN, because neither of those two can reach the other. So it
 * is tested the way it runs — as a child process, against a real Forge and a
 * real gateway, with a real file on disk.
 *
 * THE ASSERTION THAT MATTERS MOST is the last one: after a successful move, the
 * file is still on the hosting. This tool must never delete a studio's archive,
 * and "it does not" is not something to take on trust from a comment.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const gwServer = require('../gateway/src/server');
const gwConfig = require('../gateway/src/config');
const gwPaths = require('../gateway/src/paths');

const ROOT = path.join(__dirname, '..');
const cfg = config('legacymig');
const PASSWORD = 'Legacy-Move-1!';
const PREFIX = '\\\\\\\\SERVER\\\\Projects';

const run = (env) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(ROOT, 'scripts', 'migrate-legacy-files.js'), ...(env.ARGS || [])],
    { env: { ...process.env, ...env, ARGS: undefined }, timeout: 120000 },
    (err, stdout, stderr) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr }));
});

test('the legacy migration tool', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let gatewayHttp;
  let share;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);
  const uploadsDir = path.join(ROOT, 'uploads');
  const legacyNames = [];

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'mig-token',
      WORK_HOURS_SWEEP_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      EMAIL_BATCH_MS: '0',
      EMAIL_ENCRYPTION_KEY: 'm'.repeat(64),
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'mig-token', name: 'Root', email: 'root@mig.test', password: PASSWORD } });
    token.root = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@mig.test', password: PASSWORD } })).body.token;
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    id.client = await systemClientId(server.base, token.root);
    const project = await as('root', '/projects', { method: 'POST', body: { name: 'Hero Quest', clientId: id.client } });
    id.project = project.body.project.id;

    // Two assets with a legacy submission each: a row with file_path, and the
    // bytes where the old upload path put them.
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-share-'));
    fs.mkdirSync(path.join(share, gwPaths.INCOMING), { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    id.bytes = {};
    for (const [key, name, size] of [['one', 'hero-walk.psd', 4096], ['two', 'hero-idle.psd', 2048]]) {
      const asset = await as('root', `/assets/project/${id.project}`, { method: 'POST',
        body: { name: `Hero ${key}`, type: 'character' } });
      const assetId = asset.body.asset.id;
      const stored = `legacy-${crypto.randomUUID()}.psd`;
      const body = crypto.randomBytes(size);
      fs.writeFileSync(path.join(uploadsDir, stored), body);
      legacyNames.push(stored);
      id.bytes[key] = body;
      const versionId = crypto.randomUUID();
      await q(
        'INSERT INTO asset_versions (id, asset_id, version_number, stage, link, file_name, file_path, file_size, uploaded_by) '
        + 'VALUES (?,?,?,?,?,?,?,?,?)',
        [versionId, assetId, 1, 'tl', 'https://example.test/old', name, stored, size, id.root]
      );
      id[`version_${key}`] = versionId;
    }

    // Turn the Server tab on, with a prefix and a link for the project — which
    // is where this tool now reads a project's folder from.
    const keys = await as('root', '/admin/settings/server/keys', { method: 'POST' });
    const secret = await as('root', '/admin/settings/server/secret', { method: 'POST' });
    id.publicKey = keys.body.publicKey;
    id.kid = keys.body.kid;
    id.secret = secret.body.secret;

    /* A real gateway, on http and on loopback. The settings column is written
       directly because validate() insists on https — which is right for the
       product and wrong for a test that would otherwise need a certificate
       authority. Everything else about the gateway here is the shipped code. */
    const gw = gwServer.create({
      local: {
        fileRoot: share,
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mig-state-')),
        gatewayId: 'GW-MIG', gatewaySecret: id.secret,
        forgeUrl: server.base.replace(/\/api$/, ''),
        listenAddress: '127.0.0.1', listenPort: 0,
        rateLimitPerMinute: 100000, heartbeatSeconds: 3600, configSeconds: 3600,
      },
      log: () => {},
    });
    Object.assign(gw.ctx, {
      config: () => gwConfig.shape({
        version: 1, maxFileBytes: 1024 * 1024 * 64, chunkBytes: 1024 * 1024,
        keys: [{ kid: id.kid, publicKey: id.publicKey }],
      }),
    });
    gatewayHttp = http.createServer((req, res) => gw.handler(req, res));
    await new Promise((r) => gatewayHttp.listen(0, '127.0.0.1', r));
    id.gatewayUrl = `http://127.0.0.1:${gatewayHttp.address().port}`;

    await q('UPDATE server_settings SET gateway_url = ?, gateway_id = ?, enabled = 1, link_prefix = ? WHERE id = 1',
      [id.gatewayUrl, 'GW-MIG', PREFIX]);
    // An empty save re-reads the row into the running server's mirror.
    await as('root', '/admin/settings/server', { method: 'PATCH', body: {} });

    /* The project's folder is its LINK now, and the folder has to be on the
       share already — the gateway creates nothing above the discipline level,
       so a migration into a folder nobody made would be refused. */
    const linked = await as('root', `/projects/${id.project}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Hero Quest` } });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.body));
    fs.mkdirSync(path.join(share, 'Hero Quest'), { recursive: true });
  });

  t.after(async () => {
    if (gatewayHttp) gatewayHttp.close();
    await stopServer(server);
    // The legacy bytes were written into the real uploads/ directory, because
    // that is where the route this tool pulls from reads. Taken away again.
    for (const name of legacyNames) fs.rmSync(path.join(uploadsDir, name), { force: true });
  });

  const env = () => ({
    FORGE_URL: server.base.replace(/\/api$/, ''),
    FORGE_EMAIL: 'root@mig.test',
    FORGE_PASSWORD: PASSWORD,
  });

  await t.test('the inventory lists what is still on the hosting, and nothing else', async () => {
    const out = await as('root', '/admin/settings/server/legacy-files');
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.total, 2);
    assert.strictEqual(out.body.totalBytes, 6144);
    const names = out.body.files.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['hero-idle.psd', 'hero-walk.psd']);
    /* The folder is where the project's LINK resolves — which the setup gave it,
       because a migration needs somewhere to put the files. A project with no
       link reads as null here and is skipped by the tool with a reason. */
    assert.strictEqual(out.body.files[0].folder, 'Hero Quest');
    assert.strictEqual(out.body.files[0].link, `${PREFIX}\\Hero Quest`);
    // It is readable only by whoever manages the Server settings.
    const asNobody = await api(server.base, '/admin/settings/server/legacy-files', { token: null });
    assert.ok(asNobody.status === 401 || asNobody.status === 403);
  });

  await t.test('a dry run reports what it would do and moves nothing', async () => {
    const before = fs.readdirSync(share).filter((n) => n !== gwPaths.INCOMING);
    const r = await run({ ...env(), ARGS: ['--dry-run'] });
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /would move: 2/);
    assert.match(r.stdout, /Hero Quest\/hero-walk\.psd/);
    assert.deepStrictEqual(fs.readdirSync(share).filter((n) => n !== gwPaths.INCOMING), before,
      'the share is untouched by a dry run');
  });

  await t.test('a real run moves both files, verifies them, and deletes nothing', async () => {
    const r = await run(env());
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /moved: 2/);
    assert.match(r.stdout, /failed: 0/);
    assert.match(r.stdout, /verified/, 'the checksum came back from the share');

    // The files are on the share, byte for byte, in the project's folder.
    const folder = path.join(share, 'Hero Quest');
    assert.ok(fs.existsSync(folder), `the project folder was created: ${fs.readdirSync(share).join(',')}`);
    assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['hero-idle.psd', 'hero-walk.psd']);
    assert.deepStrictEqual(fs.readFileSync(path.join(folder, 'hero-walk.psd')), id.bytes.one);
    assert.deepStrictEqual(fs.readFileSync(path.join(folder, 'hero-idle.psd')), id.bytes.two);

    /* AND STILL ON THE HOSTING. This is the assertion the tool's whole
       contract rests on: a migration that deleted the source and then turned
       out to have moved the wrong bytes would be unrecoverable. */
    for (const name of legacyNames) {
      assert.ok(fs.existsSync(path.join(uploadsDir, name)), `${name} is still on the hosting`);
    }
    const rows = await q("SELECT COUNT(*) AS n FROM asset_versions WHERE file_path IS NOT NULL AND file_path <> ''");
    assert.strictEqual(Number(rows[0].n), 2, 'and the rows still point at them');
    assert.match(r.stdout, /Nothing was deleted from the hosting/);
  });

  await t.test('running it again moves nothing, because it asks the share', async () => {
    const r = await run(env());
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already there: 2/);
    assert.match(r.stdout, /moved: 0/);
    // No duplicates, and no "(2)" copies.
    assert.deepStrictEqual(fs.readdirSync(path.join(share, 'Hero Quest')).sort(),
      ['hero-idle.psd', 'hero-walk.psd']);
  });

  await t.test('a file the hosting serves wrongly is reported and left alone', async () => {
    /* Truncate the stored bytes behind the record's back, which is what a
       half-finished old upload or a damaged disk looks like. The tool must
       refuse it on the size check — before anything is written to the share —
       and say so. */
    const third = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Hero three', type: 'character' } });
    const stored = `legacy-${crypto.randomUUID()}.psd`;
    fs.writeFileSync(path.join(uploadsDir, stored), Buffer.alloc(100, 7));
    legacyNames.push(stored);
    await q(
      'INSERT INTO asset_versions (id, asset_id, version_number, stage, link, file_name, file_path, file_size, uploaded_by) '
      + 'VALUES (?,?,?,?,?,?,?,?,?)',
      [crypto.randomUUID(), third.body.asset.id, 1, 'tl', 'https://example.test/old',
        'hero-run.psd', stored, 999999, id.root]
    );

    const r = await run(env());
    assert.strictEqual(r.code, 1, 'it exits non-zero when something needed a human');
    assert.match(r.stdout, /hero-run\.psd[^:]*: the hosting served 100 bytes, the record says 999999/);
    assert.match(r.stdout, /left alone/);
    assert.strictEqual(fs.existsSync(path.join(share, 'Hero Quest', 'hero-run.psd')), false,
      'nothing was written to the share for it');
    assert.ok(fs.existsSync(path.join(uploadsDir, stored)), 'and nothing was deleted on the hosting');
  });

  await t.test('it refuses to run at all when the Server tab is off', async () => {
    await as('root', '/admin/settings/server', { method: 'PATCH', body: { enabled: false } });
    const r = await run(env());
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /switched off/);
    await q('UPDATE server_settings SET enabled = 1 WHERE id = 1');
    await as('root', '/admin/settings/server', { method: 'PATCH', body: {} });
  });
});
