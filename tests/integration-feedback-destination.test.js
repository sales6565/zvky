/* The optional `destination` on POST /assets/:id/feedback: `art` | `animation`.
 *
 *   STORED       on external_feedback.destination, never only in the description
 *   VALIDATED    exactly art or animation (case folded); anything else is a 400
 *   MATCHED      against the asset's own discipline (src/asset-discipline.js: the type,
 *                or the category's discipline); a mismatch is a 400, never re-routed
 *   OPTIONAL     omitted, everything is exactly as before and destination is null
 *   CARRIED      in every feedback event, the ready-for-reintegration list, GET /feedback,
 *                the asset's Game feedback panel and the Team Lead's queue
 *   IDEMPOTENT   a replay is a replay; the same bug again is a duplicate; the same bug
 *                for the other department is a 409, not a second record
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('fbdest');
const SECRET = 'destination-inbound-secret-for-tests-only';
const PASSWORD = 'Destination-Test-1!';
const KEY = 'destination-key-0123456789abcdef';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('feedback destination: art | animation', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tokens = {};
  const ids = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });
  const call = async (p, { method = 'GET', body = null, idem = crypto.randomUUID() } = {}) => {
    const raw = body === null ? '' : JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', SECRET).update(`${stamp}.${method}./api${p}.${raw}`).digest('hex');
    const headers = { 'X-Integration-Key': KEY, 'X-Integration-Signature': `t=${stamp}, v1=${v1}` };
    if (raw) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = idem;
    const res = await fetch(`${server.base}${p}`, { method, headers, body: raw || undefined });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
  };
  const v1 = (p, opts) => call(`/integration/v1${p}`, opts);
  const eventsFor = async (entityType, entityId) => (await sql(cfg,
    'SELECT payload FROM integration_outbox WHERE entity_type = ? AND entity_id = ? ORDER BY seq', [entityType, entityId]))
    .map((r) => JSON.parse(r.payload));
  const row = async (fid) => (await sql(cfg, 'SELECT * FROM external_feedback WHERE id = ?', [fid]))[0];
  const status = async (id) => (await sql(cfg, 'SELECT `status` FROM assets WHERE id = ?', [id]))[0].status;
  const count = async (id) => Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM external_feedback WHERE asset_id = ?', [id]))[0].n);
  const newAsset = async (name, { type = 'character', category = null, status: st = 'delivered' } = {}) => {
    const id = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO assets (id, project_id, `code`, name, type, category, status, assignee_id) VALUES (?,?,?,?,?,?,?,?)',
      [id, ids.project, `FD-${id.slice(0, 6)}`, name, type, category, st, ids.artist]);
    return id;
  };
  const raise = (assetId, body = {}, opts = {}) => v1(`/assets/${assetId}/feedback`, {
    method: 'POST', body: { source: 'dev', description: 'the texture is stretched', source_app: 'devqa', ...body }, ...opts,
  });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'fbdest-bootstrap', INTEGRATION_INBOUND_SECRET: SECRET, INTEGRATION_TEST_ENDPOINTS: '', WORK_HOURS_SWEEP_MINUTES: '0' });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'health,clients,projects,assets,handoffs,feedback,events']);
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: { token: 'fbdest-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    tokens.root = await login('root@zvky.test');
    const make = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      tokens[who] = await login(email);
      return r.body.user.id;
    };
    ids.artist = await make('artist', 'artist@zvky.test', 'game_artist');
    ids.lead = await make('lead', 'lead@zvky.test', 'team_lead');
    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Destination Client' } });
    const project = await as('root', '/projects', { method: 'POST', body: { name: 'Destination Game', clientId: client.body.client.id, teamLeadIds: [ids.lead] } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    ids.project = project.body.project.id;
    // A category the studio files animation work under (its name makes it Animation).
    const cat = await as('root', '/reference/categories', { method: 'POST', body: { label: 'Animation Props' } });
    assert.strictEqual(cat.status, 201, JSON.stringify(cat.body));
    assert.strictEqual(cat.body.entry.discipline, 'animation');
    ids.animCategory = cat.body.entry.key;
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('explicit art, on an Art asset: created, stored, answered and announced', async () => {
    const id = await newAsset('Coin texture');
    const r = await raise(id, { destination: 'art', client_bug_id: 'bug-art-1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.result, 'created');
    assert.strictEqual(r.body.destination, 'art');
    assert.strictEqual(r.body.assetDiscipline, 'art');
    assert.strictEqual((await row(r.body.feedbackId)).destination, 'art');
    const ev = await eventsFor('feedback', r.body.feedbackId);
    assert.deepStrictEqual(ev.map((e) => [e.type, e.payload.destination]), [['feedback.received', 'art'], ['feedback.accepted', 'art']]);
    assert.strictEqual((await v1(`/feedback/${r.body.feedbackId}`)).body.feedback.destination, 'art');
  });

  await t.test('explicit animation, on an Animation asset (by type, and by category)', async () => {
    const byType = await newAsset('Big win loop', { type: 'animation' });
    const a = await raise(byType, { destination: 'animation', client_bug_id: 'bug-anim-1' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.deepStrictEqual([a.body.result, a.body.destination, a.body.assetDiscipline], ['created', 'animation', 'animation']);
    assert.strictEqual((await row(a.body.feedbackId)).destination, 'animation');
    const byCategory = await newAsset('Rigged coin', { type: 'character', category: ids.animCategory });
    const b = await raise(byCategory, { destination: 'animation', client_bug_id: 'bug-anim-2' });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    assert.strictEqual(b.body.assetDiscipline, 'animation', 'the category makes it Animation work');
  });

  await t.test('destination and asset must agree: a mismatch is a 400 and nothing is recorded or moved', async () => {
    const art = await newAsset('Background');
    const anim = await newAsset('Idle loop', { type: 'animation' });
    const cat = await newAsset('Rigged reel', { category: ids.animCategory });
    for (const [asset, dest, discipline] of [[art, 'animation', 'art'], [anim, 'art', 'animation'], [cat, 'art', 'animation']]) {
      const r = await raise(asset, { destination: dest, client_bug_id: `bug-mismatch-${dest}-${asset.slice(0, 4)}` });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.result, 'rejected');
      assert.strictEqual(r.body.code, 'destination_mismatch');
      assert.strictEqual(r.body.field, 'destination');
      assert.strictEqual(r.body.assetDiscipline, discipline);
      assert.match(r.body.error, new RegExp(`This asset is ${discipline === 'art' ? 'Art' : 'Animation'} work`));
      assert.strictEqual(await count(asset), 0);
      assert.strictEqual(await status(asset), 'delivered');
    }
  });

  await t.test('only art or animation: anything else is a structured 400', async () => {
    const id = await newAsset('Validated destination');
    for (const bad of ['development', 'qa', 'artist', 'anim', 'Art & Animation', 'tech_art', '']) {
      const r = await raise(id, { destination: bad });
      if (bad === '') { assert.strictEqual(r.status, 200, 'an empty string is the same as not sending it'); continue; }
      assert.strictEqual(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'validation_failed');
      assert.deepStrictEqual(r.body.errors.map((e) => `${e.field}:${e.code}`), ['destination:invalid']);
      assert.match(r.body.errors[0].message, /art, animation/);
    }
    const num = await raise(await newAsset('Numeric'), { destination: 7 });
    assert.deepStrictEqual(num.body.errors.map((e) => `${e.field}:${e.code}`), ['destination:not_a_string']);
    const upper = await raise(await newAsset('Upper case'), { destination: 'ART' });
    assert.strictEqual(upper.status, 200);
    assert.strictEqual(upper.body.destination, 'art', 'letter case is folded, as for source');
  });

  await t.test('omitted: an old client works exactly as before, and destination is null', async () => {
    const id = await newAsset('Old client asset');
    const r = await raise(id, { client_bug_id: 'bug-old-1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.result, 'created');
    assert.strictEqual(r.body.state, 'with_lead');
    assert.strictEqual(r.body.movedAsset, true);
    assert.strictEqual(r.body.destination, null);
    assert.strictEqual((await row(r.body.feedbackId)).destination, null);
    // Any asset still takes a request with no destination, Animation ones included.
    const anim = await raise(await newAsset('Old client animation', { type: 'animation' }), { client_bug_id: 'bug-old-2' });
    assert.strictEqual(anim.body.result, 'created');
    const ev = await eventsFor('feedback', r.body.feedbackId);
    assert.deepStrictEqual(ev.map((e) => e.type), ['feedback.received', 'feedback.accepted']);
    assert.strictEqual(ev[0].payload.destination, null, 'the field is there, and empty');
    for (const k of ['feedbackId', 'assetId', 'state', 'round', 'source', 'sourceApp', 'clientBugId', 'bugRef', 'title', 'severity', 'handoffId', 'attachments']) {
      assert.ok(k in ev[0].payload, `existing field ${k} kept`);
    }
  });

  await t.test('busy work takes the request as a note, with its destination', async () => {
    const id = await newAsset('Busy animation', { type: 'animation', status: 'in_progress' });
    const r = await raise(id, { destination: 'animation', client_bug_id: 'bug-note-1' });
    assert.strictEqual(r.body.result, 'note_only');
    assert.strictEqual(r.body.destination, 'animation');
    assert.strictEqual((await row(r.body.feedbackId)).destination, 'animation');
  });

  await t.test('idempotency: replay, duplicate, a changed body, and the other department', async () => {
    const id = await newAsset('Idempotent');
    const idem = crypto.randomUUID();
    const body = { destination: 'art', client_bug_id: 'bug-idem-1', bug_ref: 'NG-BUG-9' };
    const first = await raise(id, body, { idem });
    assert.strictEqual(first.body.result, 'created');
    const replay = await raise(id, body, { idem });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.replayed, true);
    assert.strictEqual(replay.body.feedbackId, first.body.feedbackId);
    const changed = await raise(id, { ...body, destination: 'animation' }, { idem });
    assert.strictEqual(changed.status, 422, 'the same key with a different body is refused, as for any field');
    const dupe = await raise(id, body);
    assert.strictEqual(dupe.body.result, 'duplicate');
    assert.strictEqual(dupe.body.feedbackId, first.body.feedbackId);
    assert.strictEqual(dupe.body.destination, 'art');
    const old = await raise(id, { client_bug_id: 'bug-idem-1', bug_ref: 'NG-BUG-9' });
    assert.strictEqual(old.body.result, 'duplicate', 'a caller that does not send destination still finds its bug');
    // Asking for the other department on a bug that is open: refused, not a second record.
    // (On this Art asset an Animation request is a mismatch first; use a legacy row to reach the check.)
    await sql(cfg, "UPDATE external_feedback SET destination = 'animation' WHERE id = ?", [first.body.feedbackId]);
    const other = await raise(id, body);
    assert.strictEqual(other.status, 409, JSON.stringify(other.body));
    assert.strictEqual(other.body.code, 'destination_conflict');
    assert.strictEqual(other.body.destination, 'animation');
    await sql(cfg, "UPDATE external_feedback SET destination = 'art' WHERE id = ?", [first.body.feedbackId]);
    assert.strictEqual(await count(id), 1, 'still one record');
  });

  await t.test('the whole lifecycle keeps the destination: Team Lead → Artist → review → approved', async () => {
    const id = await newAsset('Walk cycle', { type: 'animation' });
    const r = await raise(id, { destination: 'animation', client_bug_id: 'bug-life-1', bug_ref: 'NG-BUG-21' });
    const fid = r.body.feedbackId;

    // The Team Lead's queue says which department it is for, and the asset is Animation work.
    // Read as the Super Admin (the fixture's team_lead role does not hold pending.view,
    // the tab's own switch); the same queue builder, and the lead acts on it below.
    const pending = await as('root', '/project-reviews/pending-actions');
    assert.strictEqual(pending.status, 200, JSON.stringify(pending.body));
    const group = pending.body.groups.find((g) => g.key === 'game_feedback_lead');
    assert.ok(group, 'game feedback waits on the lead');
    const item = group.items.find((x) => x.id === id);
    assert.ok(item, 'this asset is in the Team Lead queue');
    assert.strictEqual(item.destination, 'animation');
    assert.strictEqual(item.type, 'animation');
    const panel = await as('lead', `/assets/${id}/game-feedback`);
    assert.strictEqual(panel.status, 200, JSON.stringify(panel.body));
    assert.strictEqual(panel.body.rounds.find((x) => x.id === fid).destination, 'animation');

    assert.strictEqual((await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } })).status, 200);
    const submit = async (link) => {
      assert.strictEqual((await as('artist', `/assets/${id}/start`, { method: 'POST' })).status, 200);
      const s = await as('artist', `/assets/${id}/submit`, { method: 'POST', body: { link } });
      assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    };
    await submit('https://example.com/walk-1');
    assert.strictEqual((await as('lead', `/assets/${id}/review`, { method: 'POST', body: { decision: 'changes_requested', text: 'foot slides' } })).status, 200);
    await submit('https://example.com/walk-2');
    assert.strictEqual((await as('lead', `/assets/${id}/review`, { method: 'POST', body: { decision: 'approved', text: 'good' } })).status, 200);

    const ev = await eventsFor('feedback', fid);
    assert.deepStrictEqual(ev.map((e) => e.type), ['feedback.received', 'feedback.accepted', 'feedback.assigned', 'feedback.fix_submitted',
      'feedback.changes_requested', 'feedback.fix_submitted', 'feedback.fix_approved']);
    assert.ok(ev.every((e) => e.payload.destination === 'animation'), 'every event carries it');
    const [ready] = await eventsFor('asset', id);
    assert.strictEqual(ready.type, 'asset.ready_for_reintegration');
    assert.deepStrictEqual(ready.payload.feedback.map((f) => [f.clientBugId, f.destination]), [['bug-life-1', 'animation']]);
    const after = await row(fid);
    assert.deepStrictEqual([after.state, after.destination], ['fix_approved', 'animation'], 'kept through reload and every step');
    assert.strictEqual((await v1(`/feedback?source_app=devqa&client_bug_id=bug-life-1`)).body.feedback[0].destination, 'animation');
  });

  await t.test('declined and withdrawn keep the destination too', async () => {
    const a = await newAsset('Declined art');
    const ra = await raise(a, { destination: 'art', client_bug_id: 'bug-decl-1' });
    assert.strictEqual((await as('lead', `/assets/${a}/game-feedback`, { method: 'POST', body: { decision: 'decline', reason: 'as designed' } })).status, 200);
    const d = await eventsFor('feedback', ra.body.feedbackId);
    assert.deepStrictEqual([d[d.length - 1].type, d[d.length - 1].payload.destination], ['feedback.declined', 'art']);
    const b = await newAsset('Withdrawn animation', { type: 'animation' });
    const rb = await raise(b, { destination: 'animation', client_bug_id: 'bug-wd-1' });
    const w = await v1(`/assets/${b}/feedback/${rb.body.feedbackId}/withdraw`, { method: 'POST', body: {} });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    const e = await eventsFor('feedback', rb.body.feedbackId);
    assert.deepStrictEqual([e[e.length - 1].type, e[e.length - 1].payload.destination], ['feedback.withdrawn', 'animation']);
    assert.strictEqual((await row(rb.body.feedbackId)).destination, 'animation');
  });
});
