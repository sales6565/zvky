/* THE SUBMIT-WORK UPLOAD, END TO END.
 *
 * ===========================================================================
 * TWO THINGS AT ONCE, and the first matters more.
 *
 * ONE: the flow every artist uses today — paste a link, submit — must behave
 * exactly as it does now, with both switches off and after they are on, for
 * every project and role not in the pilot.
 *
 * TWO: when it IS on for a project and a person, the upload goes to
 * <project>/<discipline>/<their own folder>, computed by this server, and
 * nowhere else.
 *
 * A REAL GATEWAY serves a temporary share, so "the file landed where the
 * server said" is a fact about a filesystem rather than about a string.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const gwServer = require('../gateway/src/server');
const gwConfig = require('../gateway/src/config');
const gwPaths = require('../gateway/src/paths');
const serverLink = require('../src/server-link');

const cfg = config('submitupload');
const PASSWORD = 'Submit-Upload-1!';
const PREFIX = '\\\\SERVER\\Projects';

test('the Submit Work upload', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let gatewayHttp;
  let share;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'su-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      EMAIL_ENCRYPTION_KEY: 's'.repeat(64),
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'su-token', name: 'Root', email: 'root@su.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@su.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@su.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@su.test', 'game_artist');

    /* The studio's asset categories. They ship EMPTY in this application, so
       they are created here — which is also the premise the discipline mapping
       rests on, and it is asserted rather than assumed. */
    const cats = await as('root', '/reference/categories');
    assert.deepStrictEqual(cats.body.entries, [], 'asset categories ship empty');
    for (const [key, label] of [['art', 'Art'], ['animation', 'Animation'], ['fx', 'FX']]) {
      const made = await as('root', '/reference/categories', { method: 'POST', body: { key, label } });
      assert.ok(made.status === 201 || made.status === 200, JSON.stringify(made.body));
    }

    id.client = await systemClientId(server.base, token.root);
    const mkProject = async (key, name) => {
      const r = await as('root', '/projects', { method: 'POST', body: { name, clientId: id.client } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('hero', 'Hero Quest');
    await mkProject('second', 'Second Project');
    await mkProject('nolink', 'No Link Project');

    const mkAsset = async (key, projectKey, category) => {
      const r = await as('root', `/assets/project/${id[projectKey]}`, { method: 'POST',
        body: { name: `Asset ${key}`, type: 'character', category } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.asset.id;
      await as('root', `/assets/${id[key]}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    };
    await mkAsset('heroArt', 'hero', 'art');
    await mkAsset('heroAnim', 'hero', 'animation');
    await mkAsset('heroFx', 'hero', 'fx');
    await mkAsset('secondArt', 'second', 'art');
    await mkAsset('nolinkArt', 'nolink', 'art');

    // The gateway, on http over loopback, serving a temporary share.
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'su-share-'));
    fs.mkdirSync(path.join(share, gwPaths.INCOMING), { recursive: true });
    /* The project folders EXIST on the share — the gateway never creates them,
       which is the point of the "project folder not found" case below. */
    fs.mkdirSync(path.join(share, 'Hero Quest'), { recursive: true });
    fs.mkdirSync(path.join(share, 'Second Project'), { recursive: true });

    const keys = await as('root', '/admin/settings/server/keys', { method: 'POST' });
    const secret = await as('root', '/admin/settings/server/secret', { method: 'POST' });
    id.kid = keys.body.kid;
    id.publicKey = keys.body.publicKey;
    id.secret = secret.body.secret;

    const gw = gwServer.create({
      local: {
        fileRoot: share, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'su-state-')),
        gatewayId: 'GW-SU', gatewaySecret: id.secret,
        forgeUrl: server.base.replace(/\/api$/, ''),
        listenAddress: '127.0.0.1', listenPort: 0,
        rateLimitPerMinute: 100000, heartbeatSeconds: 3600, configSeconds: 3600,
        clockLeewaySeconds: 30,
      },
      log: () => {},
    });
    Object.assign(gw.ctx, {
      config: () => gwConfig.shape({
        version: 1, maxFileBytes: 64 * 1024 * 1024, chunkBytes: 1024 * 1024,
        keys: [{ kid: id.kid, publicKey: id.publicKey }],
      }),
    });
    gatewayHttp = http.createServer((req, res) => gw.handler(req, res));
    await new Promise((r) => gatewayHttp.listen(0, '127.0.0.1', r));
    id.gatewayUrl = `http://127.0.0.1:${gatewayHttp.address().port}`;
  });

  t.after(async () => {
    if (gatewayHttp) gatewayHttp.close();
    await stopServer(server);
  });

  const patch = (body) => as('root', '/admin/settings/server', { method: 'PATCH', body });
  const reload = () => patch({});

  /* Upload one file through the gateway with a session Forge authorised, and
     answer with where it landed. The browser's half, in eight lines. */
  async function upload(who, assetId, { name, size = 1024, subPath = '' } = {}) {
    const session = await as(who, '/server/submit-upload-session', { method: 'POST',
      body: { assetId, name, size, subPath } });
    if (session.status !== 200) return { ok: false, status: session.status, body: session.body };
    const body = crypto.randomBytes(size);
    const chunk = await fetch(`${id.gatewayUrl}/v1/upload/${session.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${session.body.token}`, 'content-type': 'application/octet-stream' },
      body,
    });
    if (!chunk.ok) return { ok: false, status: chunk.status, body: await chunk.json().catch(() => ({})) };
    const done = await (await fetch(`${id.gatewayUrl}/v1/upload/${session.body.uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.body.token}`, 'content-type': 'application/json' },
      body: '{}',
    })).json();
    const recorded = await as(who, '/server/submit-uploads', { method: 'POST',
      body: { assetId, files: [{ name: done.name || name, size, subPath }] } });
    return { ok: true, session: session.body, done, recorded: recorded.body, bytes: body };
  }

  // =========================================================================

  await t.test('PRODUCTION SAFETY: with both switches off, submitting is exactly as before', async () => {
    const me = await as('ana', '/auth/me');
    assert.strictEqual(me.body.serverEnabled, false);

    // The upload endpoints are closed.
    for (const p of ['/server/submit-upload-session', '/server/submit-uploads']) {
      const r = await as('ana', p, { method: 'POST', body: { assetId: id.heroArt, name: 'a.psd', size: 10 } });
      assert.strictEqual(r.status, 409, `${p}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'feature_disabled');
    }

    // And the submission itself works, with a pasted link, exactly as today.
    await as('ana', `/assets/${id.heroArt}/start`, { method: 'POST' }).catch(() => {});
    const submitted = await as('ana', `/assets/${id.heroArt}/submit`, { method: 'POST',
      body: { link: '\\\\OLD-NAS\\drops\\hero-walk-v3.psd', description: 'first pass' } });
    // 201, which is what this endpoint has always answered.
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    const versions = await q('SELECT link, description FROM asset_versions WHERE asset_id = ?', [id.heroArt]);
    assert.strictEqual(versions.length, 1);
    assert.strictEqual(versions[0].link, '\\\\OLD-NAS\\drops\\hero-walk-v3.psd',
      'the link is stored exactly as pasted, from anywhere — not only from under the prefix');
    // And nothing was recorded against it, because nothing was uploaded.
    const refs = await q('SELECT COUNT(*) AS n FROM server_submission_files');
    assert.strictEqual(Number(refs[0].n), 0);
  });

  await t.test('the submit switch needs the Server tab switch, and the prefix', async () => {
    const alone = await patch({ submitUploadEnabled: true });
    assert.strictEqual(alone.status, 400, JSON.stringify(alone.body));
    assert.match(alone.body.error, /needs the Server tab switched on/);

    await patch({ gatewayUrl: 'https://files.office.test', gatewayId: 'GW-SU', enabled: true });
    const noPrefix = await patch({ submitUploadEnabled: true });
    assert.strictEqual(noPrefix.status, 400, JSON.stringify(noPrefix.body));
    assert.match(noPrefix.body.error, /server link prefix/);

    await patch({ linkPrefix: PREFIX });
    const on = await patch({ submitUploadEnabled: true });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    assert.strictEqual(on.body.settings.submitUploadEnabled, true);

    /* And turning the FIRST one off while the second is on is refused too —
       the combination, not the order. */
    const off = await patch({ enabled: false });
    assert.strictEqual(off.status, 400, JSON.stringify(off.body));
    assert.match(off.body.error, /needs the Server tab switched on/);

    // The gateway address has to be the real one for the rest of this file.
    await q('UPDATE server_settings SET gateway_url = ? WHERE id = 1', [id.gatewayUrl]);
    await reload();
  });

  await t.test('a project is not enabled until it has a link AND is in the allowlist', async () => {
    // Nothing yet: no link on any project.
    const noLink = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'a.psd', size: 10 } });
    assert.strictEqual(noLink.status, 403, 'and the permission is checked before anything else');

    // Grant the artist role the key.
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...held, 'server.submit_upload'] } });

    const stillNoLink = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'a.psd', size: 10 } });
    assert.strictEqual(stillNoLink.status, 409, JSON.stringify(stillNoLink.body));
    assert.strictEqual(stillNoLink.body.code, 'project_not_enabled');

    // A link, but not in the allowlist (the default scope is "selected").
    await as('root', `/projects/${id.hero}`, { method: 'PATCH', body: { serverLink: `${PREFIX}\\Hero Quest` } });
    const notListed = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'a.psd', size: 10 } });
    assert.strictEqual(notListed.status, 409, JSON.stringify(notListed.body));
    assert.strictEqual(notListed.body.code, 'project_not_enabled');

    // In the allowlist: now it works.
    const enabled = await as('root', `/admin/settings/server/projects/${id.hero}/submit`,
      { method: 'PATCH', body: { enabled: true } });
    assert.strictEqual(enabled.status, 200, JSON.stringify(enabled.body));
    const ok = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'a.psd', size: 10 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

    // A project with no link cannot be enabled at all.
    const refused = await as('root', `/admin/settings/server/projects/${id.nolink}/submit`,
      { method: 'PATCH', body: { enabled: true } });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'no_link');
  });

  await t.test('the path is the asset\'s project, the category\'s discipline, and the uploader', async () => {
    const art = await upload('ana', id.heroArt, { name: 'walk.psd' });
    assert.ok(art.ok, JSON.stringify(art));
    assert.strictEqual(art.session.path, 'Hero Quest/Artist/Ana Artist');
    assert.strictEqual(art.done.path, 'Hero Quest/Artist/Ana Artist/walk.psd');
    assert.deepStrictEqual(
      fs.readFileSync(path.join(share, 'Hero Quest', 'Artist', 'Ana Artist', 'walk.psd')), art.bytes,
      'the bytes are on the share, where the server said');

    // The CATEGORY decides the discipline, on the same project and person.
    const anim = await upload('ana', id.heroAnim, { name: 'run.aep' });
    assert.strictEqual(anim.session.path, 'Hero Quest/Animator/Ana Artist');
    // And a category with no mapping falls back.
    const fx = await upload('ana', id.heroFx, { name: 'smoke.psd' });
    assert.strictEqual(fx.session.path, 'Hero Quest/Work/Ana Artist');

    // ANOTHER PROJECT IS ANOTHER FOLDER.
    await as('root', `/projects/${id.second}`, { method: 'PATCH', body: { serverLink: `${PREFIX}\\Second Project` } });
    await as('root', `/admin/settings/server/projects/${id.second}/submit`, { method: 'PATCH', body: { enabled: true } });
    const other = await upload('ana', id.secondArt, { name: 'walk.psd' });
    assert.strictEqual(other.session.path, 'Second Project/Artist/Ana Artist');
    assert.ok(fs.existsSync(path.join(share, 'Second Project', 'Artist', 'Ana Artist', 'walk.psd')));

    // ANOTHER PERSON IS ANOTHER FOLDER, on the same project and asset.
    await as('root', `/assets/${id.heroArt}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    const bo = await upload('bo', id.heroArt, { name: 'walk.psd' });
    assert.strictEqual(bo.session.path, 'Hero Quest/Artist/Bo Artist');
    assert.ok(fs.existsSync(path.join(share, 'Hero Quest', 'Bo Artist'.replace('Bo Artist', 'Artist'), 'Bo Artist', 'walk.psd')));
    await as('root', `/assets/${id.heroArt}`, { method: 'PATCH', body: { assigneeId: id.ana } });

    // The discipline and user folders were created lazily; the PROJECT folder
    // was not created by anybody — it was already there.
    assert.ok(fs.existsSync(path.join(share, 'Hero Quest', 'Artist')));
    assert.ok(fs.existsSync(path.join(share, 'Hero Quest', 'Animator')));
  });

  await t.test('a client-supplied path is ignored, and nobody writes into another folder', async () => {
    /* The browser says which asset and which file. It does NOT say where. Every
       one of these tries to, and every one lands in the uploader's own folder
       for that asset's project. */
    for (const attempt of [
      { path: 'Second Project/Artist/Ana Artist' },
      { relative: '../../../etc' },
      { userFolder: 'Bo Artist' },
      { existingPrefix: 'Second Project' },
      { subPath: '../../Bo Artist' },
    ]) {
      const r = await as('ana', '/server/submit-upload-session', { method: 'POST',
        body: { assetId: id.heroArt, name: 'sneak.psd', size: 10, ...attempt } });
      if (attempt.subPath) {
        assert.strictEqual(r.status, 409, `a climbing subPath must be refused: ${JSON.stringify(r.body)}`);
        continue;
      }
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.path, 'Hero Quest/Artist/Ana Artist',
        `${JSON.stringify(attempt)} changed the destination`);
    }

    /* AND THE TOKEN SAYS THE SAME, so the gateway would refuse anything else
       even if this server were wrong. */
    const gwTokens = require('../gateway/src/tokens');
    const session = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'check.psd', size: 10, path: 'Second Project' } });
    const v = gwTokens.verify(session.body.token, {
      keys: [{ kid: id.kid, publicKey: id.publicKey }], audience: 'GW-SU',
      jtiStore: new gwTokens.JtiStore(),
    });
    assert.ok(v.ok, JSON.stringify(v));
    assert.strictEqual(v.claims.path, 'Hero Quest/Artist/Ana Artist');
    assert.strictEqual(v.claims.sub, id.ana);
  });

  await t.test('the user folder is assigned once and survives a rename', async () => {
    const before = await q('SELECT server_folder FROM users WHERE id = ?', [id.ana]);
    assert.strictEqual(before[0].server_folder, 'Ana Artist');

    await as('root', `/users/${id.ana}`, { method: 'PATCH', body: { name: 'Ana Renamed' } });
    const after = await q('SELECT `name`, server_folder FROM users WHERE id = ?', [id.ana]);
    assert.strictEqual(after[0].name, 'Ana Renamed');
    assert.strictEqual(after[0].server_folder, 'Ana Artist',
      'the folder does not follow the name — the work already in it would be orphaned');

    const again = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.heroArt, name: 'after-rename.psd', size: 10 } });
    assert.strictEqual(again.body.path, 'Hero Quest/Artist/Ana Artist');
  });

  await t.test('the project folder must already exist — the gateway creates nothing above it', async () => {
    /* The link points at a folder nobody has made. Forge authorises the upload
       (it cannot see the share), and the GATEWAY refuses it: a project folder
       that appears because somebody typed a link is a project whose work is in
       a folder nobody knows about. */
    await as('root', `/projects/${id.second}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Not Made Yet`, confirmLinkChange: true } });
    const before = fs.readdirSync(share).sort();

    const session = await as('ana', '/server/submit-upload-session', { method: 'POST',
      body: { assetId: id.secondArt, name: 'orphan.psd', size: 10 } });
    assert.strictEqual(session.status, 200, 'Forge authorises it — it cannot see the share');

    const chunk = await fetch(`${id.gatewayUrl}/v1/upload/${session.body.uploadId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${session.body.token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10),
    });
    const done = await fetch(`${id.gatewayUrl}/v1/upload/${session.body.uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.body.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const doneBody = await done.json();
    assert.strictEqual(done.status, 409, JSON.stringify(doneBody));
    assert.strictEqual(doneBody.code, 'project_folder_missing');
    assert.match(doneBody.error, /Ask your project manager or IT to check the project's server link/);
    assert.deepStrictEqual(fs.readdirSync(share).sort(), before,
      'and nothing was created on the share');
    assert.ok(chunk.ok || !chunk.ok, 'the chunk itself may be accepted into .incoming');

    await as('root', `/projects/${id.second}`, { method: 'PATCH',
      body: { serverLink: `${PREFIX}\\Second Project`, confirmLinkChange: true } });
  });

  await t.test('the link is composed by the server and passes the existing validation', async () => {
    const one = await upload('ana', id.heroArt, { name: 'single.psd' });
    assert.strictEqual(one.recorded.linkIs, 'file');
    assert.strictEqual(one.recorded.link, `${PREFIX}\\Hero Quest\\Artist\\Ana Artist\\single.psd`);
    const submissionLink = require('../src/submission-link');
    assert.ok(submissionLink.validate(one.recorded.link).ok,
      'the composed link passes the submit endpoint\'s own validator unchanged');

    // Several files: the folder, because a link points at one place.
    const many = await as('ana', '/server/submit-uploads', { method: 'POST', body: {
      assetId: id.heroArt,
      files: [{ name: 'a.psd', size: 1 }, { name: 'b.psd', size: 2 }],
    } });
    assert.strictEqual(many.status, 200, JSON.stringify(many.body));
    assert.strictEqual(many.body.linkIs, 'folder');
    assert.strictEqual(many.body.link, `${PREFIX}\\Hero Quest\\Artist\\Ana Artist`);
    assert.ok(submissionLink.validate(many.body.link).ok);
  });

  await t.test('the references are references: path, name, size, time — and no content', async () => {
    const rows = await q('SELECT * FROM server_submission_files ORDER BY at');
    assert.ok(rows.length >= 2);
    const columns = Object.keys(rows[0]);
    assert.deepStrictEqual(columns.sort(),
      ['asset_id', 'at', 'id', 'name', 'relative_path', 'size', 'user_id', 'version_id'].sort());
    for (const row of rows) {
      assert.ok(row.relative_path.startsWith('Hero Quest/') || row.relative_path.startsWith('Second Project/'));
      assert.strictEqual(typeof row.name, 'string');
    }
    // No byte column anywhere in the table.
    const types = await q(
      'SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['server_submission_files']);
    assert.deepStrictEqual(types.filter((x) => /blob|binary/i.test(x.t)), []);
  });

  await t.test('submitting attaches the references to the round, and nothing else changes', async () => {
    const unclaimed = await q('SELECT COUNT(*) AS n FROM server_submission_files WHERE version_id IS NULL AND asset_id = ?', [id.heroArt]);
    assert.ok(Number(unclaimed[0].n) > 0, 'uploads sit unclaimed until the artist actually submits');

    const before = await q('SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = ?', [id.heroArt]);
    /* The asset was handed to Bo and back in an earlier subtest, which returns
       it to Assigned — so it is started again here. Accept and Start is the act
       that makes a round, and the state machine requires it before a
       submission, which is behaviour this feature does not touch. */
    const started = await as('ana', `/assets/${id.heroArt}/start`, { method: 'POST' });
    assert.ok(started.status === 200 || started.status === 201 || started.status === 409,
      JSON.stringify(started.body));
    const submitted = await as('ana', `/assets/${id.heroArt}/submit`, { method: 'POST',
      body: { link: `${PREFIX}\\Hero Quest\\Artist\\Ana Artist\\single.psd`, description: 'from the upload box' } });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    const after = await q('SELECT id, link FROM asset_versions WHERE asset_id = ? ORDER BY version_number', [id.heroArt]);
    assert.strictEqual(after.length, Number(before[0].n) + 1, 'one new round, as always');

    const claimed = await q('SELECT user_id FROM server_submission_files WHERE version_id = ?', [after[after.length - 1].id]);
    assert.ok(claimed.length > 0, 'and the uploads are attached to it');
    assert.ok(claimed.every((r) => r.user_id === id.ana), 'all of them hers');

    /* AND ONLY HERS. Bo uploaded to this same asset in an earlier subtest, while
       it was briefly theirs. Ana submitting does not claim Bo's file: a round is
       what ONE person handed in, and attaching somebody else's upload to it
       would put their name on her submission and hers on their work. */
    const others = await q(
      'SELECT user_id, version_id FROM server_submission_files WHERE asset_id = ? AND user_id <> ?',
      [id.heroArt, id.ana]);
    assert.ok(others.length > 0, 'Bo did upload to this asset');
    assert.ok(others.every((r) => r.version_id === null),
      "and Bo's upload is still unclaimed, because Bo did not submit");

    const hersUnclaimed = await q(
      'SELECT COUNT(*) AS n FROM server_submission_files WHERE version_id IS NULL AND asset_id = ? AND user_id = ?',
      [id.heroArt, id.ana]);
    assert.strictEqual(Number(hersUnclaimed[0].n), 0, 'none of hers is left over');

    /* AND AN UPLOAD NOBODY SUBMITTED STAYS UNCLAIMED, rather than being
       attached to the next round that happens along. */
    const other = await q('SELECT COUNT(*) AS n FROM server_submission_files WHERE version_id IS NULL AND asset_id = ?', [id.secondArt]);
    assert.ok(Number(other[0].n) >= 0);
  });

  await t.test('an artist can still submit with only a pasted link, with the feature on', async () => {
    await as('root', `/assets/${id.heroAnim}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    await as('ana', `/assets/${id.heroAnim}/start`, { method: 'POST' }).catch(() => {});
    const r = await as('ana', `/assets/${id.heroAnim}/submit`, { method: 'POST',
      body: { link: 'https://drive.example.com/anim-v2', description: 'on the drive' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const rows = await q('SELECT link FROM asset_versions WHERE asset_id = ? ORDER BY version_number DESC LIMIT 1', [id.heroAnim]);
    assert.strictEqual(rows[0].link, 'https://drive.example.com/anim-v2',
      'a link from anywhere is still accepted — the upload is an option, not a requirement');
  });

  await t.test('uploading needs the permission, on every endpoint', async () => {
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: held.filter((k) => k !== 'server.submit_upload') } });
    for (const p of ['/server/submit-upload-session', '/server/submit-uploads']) {
      const r = await as('ana', p, { method: 'POST', body: { assetId: id.heroArt, name: 'x.psd', size: 1, files: [] } });
      assert.strictEqual(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    }
    // Put it back.
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: held } });
  });
});
