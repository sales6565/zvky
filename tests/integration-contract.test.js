/* The Dev & QA contract, version 1: the envelope, the events, the feedback lifecycle,
 * the paged reads, and the switch.
 *
 * What Dev & QA builds against, asserted end to end against a running server:
 *
 *   ENVELOPE     every event has eventId, sequence, type, occurredAt, source,
 *                schemaVersion, projectId, entity {type, id, version}, payload; an
 *                entity's version only goes up
 *   EVENTS       client and project changes, hand-off created/updated/cancelled, and a
 *                game bug's whole life: received, accepted, assigned, fix submitted,
 *                changes requested, fix approved, ready for reintegration, declined,
 *                withdrawn
 *   NO BUILD     an approved fix is announced as ready; nothing puts it in a build
 *   RESULTS      created / note_only / duplicate / refused / rejected, and a replay
 *                that says it is one
 *   PAGING       a cursor that neither repeats nor skips, over more than 200 assets that
 *                all share one change marker (the case that used to loop for ever)
 *   SWITCH       INTEGRATION_ENABLED off answers 503 and writes no events; the test probe
 *                is absent unless the suite mounts it
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('contract');
const SECRET = 'contract-inbound-secret-for-tests-only';
const OLD_SECRET = 'contract-previous-secret-for-tests-only';
const PASSWORD = 'Contract-Test-1!';
const KEY = 'contract-key-0123456789abcdef';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('the Dev & QA contract, version 1', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tokens = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });

  const call = async (p, { method = 'GET', body = null, idem = crypto.randomUUID(), secret = SECRET, base = null } = {}) => {
    const raw = body === null ? '' : JSON.stringify(body);
    const stamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${stamp}.${method}./api${p}.${raw}`).digest('hex');
    const headers = { 'X-Integration-Key': KEY, 'X-Integration-Signature': `t=${stamp}, v1=${v1}` };
    if (raw) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = idem;
    const res = await fetch(`${base || server.base}${p}`, { method, headers, body: raw || undefined });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
  };
  const v1 = (p, opts) => call(`/integration/v1${p}`, opts);

  const outbox = async (type) => (await sql(cfg,
    `SELECT seq, payload FROM integration_outbox ${type ? 'WHERE event_type = ?' : ''} ORDER BY seq`, type ? [type] : []))
    .map((r) => ({ ...JSON.parse(r.payload), sequence: Number(r.seq) }));
  const eventsFor = async (entityType, entityId) => (await sql(cfg,
    'SELECT payload FROM integration_outbox WHERE entity_type = ? AND entity_id = ? ORDER BY seq', [entityType, entityId]))
    .map((r) => JSON.parse(r.payload));
  const assetRow = async (id) => (await sql(cfg, 'SELECT `status`, routed_to_id AS routed FROM assets WHERE id = ?', [id]))[0];

  const newAsset = async (name, status = 'delivered', project = ids.project) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id) VALUES (?,?,?,?,?,?,?)',
      [id, project, `CT-${id.slice(0, 6)}`, name, 'character', status, ids.artist]);
    return id;
  };
  const raise = (assetId, body = {}, opts = {}) => v1(`/assets/${assetId}/feedback`, {
    method: 'POST',
    body: { source: 'qa', description: 'the hat clips through the wall', ...body },
    ...opts,
  });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'contract-bootstrap',
      INTEGRATION_INBOUND_SECRET: SECRET,
      INTEGRATION_INBOUND_SECRET_PREVIOUS: OLD_SECRET,
      // Deployment shape: the test probe is NOT mounted on this server.
      INTEGRATION_TEST_ENDPOINTS: '',
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'health,clients,projects,assets,handoffs,feedback,events,counter']);
    await api(server.base, '/auth/bootstrap', {
      method: 'POST', body: { token: 'contract-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
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

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Contract Client' } });
    assert.strictEqual(client.status, 201, JSON.stringify(client.body));
    ids.client = client.body.client.id;
    const project = await as('root', '/projects', {
      method: 'POST', body: { name: 'Contract Game', clientId: ids.client, teamLeadIds: [ids.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('client and project changes are events, in the envelope', async () => {
    const [created] = await outbox('client.created');
    assert.ok(created, 'client.created written');
    for (const k of ['eventId', 'sequence', 'type', 'occurredAt', 'source', 'schemaVersion', 'entity', 'payload']) {
      assert.ok(k in created, `envelope has ${k}`);
    }
    assert.strictEqual(created.source, 'forge');
    assert.strictEqual(created.schemaVersion, 1);
    assert.deepStrictEqual(created.entity, { type: 'client', id: ids.client, version: 1 });
    assert.strictEqual(created.payload.name, 'Contract Client');

    const projectEvents = await eventsFor('project', ids.project);
    assert.strictEqual(projectEvents[0].type, 'project.created');
    assert.strictEqual(projectEvents[0].projectId, ids.project);

    const renamed = await as('root', `/projects/${ids.project}`, { method: 'PATCH', body: { name: 'Contract Game Renamed' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    const after = await eventsFor('project', ids.project);
    const last = after[after.length - 1];
    assert.strictEqual(last.type, 'project.updated');
    assert.strictEqual(last.payload.name, 'Contract Game Renamed');
    assert.ok(last.entity.version > projectEvents[projectEvents.length - 1].entity.version, 'the version only goes up');

    // A write that changes nothing Dev & QA can see says nothing.
    const again = await as('root', `/projects/${ids.project}`, { method: 'PATCH', body: { name: 'Contract Game Renamed' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await eventsFor('project', ids.project)).length, after.length, 'no event for no visible change');
  });

  await t.test('archiving a client tells Dev & QA about the client and every project under it', async () => {
    const c = await as('root', '/clients', { method: 'POST', body: { name: 'Short-lived Client' } });
    const p = await as('root', '/projects', { method: 'POST', body: { name: 'Short-lived Game', clientId: c.body.client.id } });
    const archived = await as('root', `/clients/${c.body.client.id}?confirm=1`, { method: 'DELETE' });
    assert.strictEqual(archived.status, 200, JSON.stringify(archived.body));
    const client = await eventsFor('client', c.body.client.id);
    assert.strictEqual(client[client.length - 1].payload.isActive, false);
    const project = await eventsFor('project', p.body.project.id);
    assert.strictEqual(project[project.length - 1].payload.isActive, false);
    assert.strictEqual(project[project.length - 1].type, 'project.updated');
  });

  await t.test('health, and the paged client and project reads with versions', async () => {
    const h = await v1('/health');
    assert.strictEqual(h.status, 200, JSON.stringify(h.body));
    assert.strictEqual(h.body.ok, true);
    assert.strictEqual(h.body.schemaVersion, 1);
    assert.ok(!JSON.stringify(h.body).includes(SECRET), 'no secret in the answer');

    const seen = [];
    let cursor = null;
    do {
      const page = await v1(`/clients?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      assert.strictEqual(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.clients.map((c) => c.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.strictEqual(new Set(seen).size, seen.length, 'no client twice');
    assert.ok(seen.includes(ids.client));

    const one = await v1(`/projects/${ids.project}`);
    assert.strictEqual(one.status, 200);
    const events = await eventsFor('project', ids.project);
    assert.strictEqual(one.body.project.version, events[events.length - 1].entity.version, 'the read carries the event version');
    assert.strictEqual(one.body.project.clientId, ids.client);

    const paged = await v1(`/projects?limit=200&client_id=${ids.client}`);
    assert.ok(paged.body.projects.map((p) => p.id).includes(ids.project));
    assert.ok(paged.body.projects.every((p) => p.clientId === ids.client), JSON.stringify(paged.body));
    const legacy = await v1('/projects');
    assert.ok(Array.isArray(legacy.body.projects) && !('nextCursor' in legacy.body), 'the unpaged form is unchanged');

    assert.strictEqual((await v1('/clients?cursor=not-a-cursor')).status, 400);
  });

  await t.test('assets page without repeating or skipping, past 200 on one marker', async () => {
    const project = await as('root', '/projects', { method: 'POST', body: { name: 'Many Assets', clientId: ids.client } });
    const pid = project.body.project.id;
    const values = [];
    const params = [];
    for (let i = 0; i < 250; i += 1) {
      values.push('(?,?,?,?,?,?)');
      params.push(crypto.randomUUID(), pid, `MA-${String(i).padStart(3, '0')}`, `Asset ${i}`, 'prop', 'in_progress');
    }
    await sql(cfg, `INSERT INTO assets (id, project_id, \`code\`, name, type, status) VALUES ${values.join(',')}`, params);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await v1(`/projects/${pid}/assets?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      assert.strictEqual(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.assets.map((a) => a.id));
      cursor = page.body.nextCursor;
      pages += 1;
      assert.ok(pages < 10, 'the walk ends');
    } while (cursor);
    assert.strictEqual(seen.length, 250, 'every asset');
    assert.strictEqual(new Set(seen).size, 250, 'none twice');
    assert.strictEqual(pages, 3);

    // The older start form still starts a walk, and hands over the cursor to continue it.
    const first = await v1(`/projects/${pid}/assets?updated_since=0&limit=200`);
    assert.strictEqual(first.body.assets.length, 200);
    assert.strictEqual(first.body.hasMore, true);
    const rest = await v1(`/projects/${pid}/assets?limit=200&cursor=${first.body.nextCursor}`);
    assert.strictEqual(rest.body.assets.length, 50);
    assert.strictEqual(rest.body.hasMore, false);
    assert.strictEqual(rest.body.nextCursor, null);
  });

  await t.test('feedback: validation is structured, and nothing is dropped', async () => {
    const id = await newAsset('Validated');
    const bad = await raise(id, { mystery: 1, severity: 7, attachments: [{ name: 'x', url: 'ftp://nope' }] });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.result, 'rejected');
    assert.strictEqual(bad.body.code, 'validation_failed');
    const fields = bad.body.errors.map((e) => `${e.field}:${e.code}`);
    assert.ok(fields.includes('mystery:unknown_field'), fields.join());
    assert.ok(fields.includes('severity:not_a_string'), fields.join());
    assert.ok(fields.includes('attachments[0].url:invalid_url'), fields.join());
    assert.strictEqual((await assetRow(id)).status, 'delivered', 'nothing moved');
  });

  await t.test('feedback: created, stored in full, replayed and duplicated honestly', async () => {
    const id = await newAsset('Full Bug');
    const idem = crypto.randomUUID();
    const body = {
      title: 'Hat clips', bug_ref: 'NG-B-7', client_bug_id: 'bug-uuid-7', source_app: 'devqa', severity: 'S2',
      checkpoint: 'CP2', build: 'Build #12', test_ref: 'NG-TC-3', sender_name: 'Quinn', sender_role: 'QA Tester',
      sender_team: 'QA', reported_at: '2026-09-01T10:00:00Z', attachments: [{ name: 'shot', url: 'https://example.com/s.png' }],
    };
    const first = await raise(id, body, { idem });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.result, 'created');
    assert.strictEqual(first.body.state, 'with_lead');
    assert.strictEqual((await assetRow(id)).status, 'game_feedback');
    const [row] = await sql(cfg, 'SELECT * FROM external_feedback WHERE id = ?', [first.body.feedbackId]);
    assert.strictEqual(row.title, 'Hat clips');
    assert.strictEqual(row.checkpoint, 'CP2');
    assert.strictEqual(row.test_ref, 'NG-TC-3');
    assert.strictEqual(row.sender_team, 'QA');
    assert.strictEqual(row.client_bug_id, 'bug-uuid-7');
    assert.deepStrictEqual(JSON.parse(row.attachments), [{ name: 'shot', url: 'https://example.com/s.png' }]);

    const replay = await raise(id, body, { idem });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers.get('idempotent-replay'), 'true');
    assert.strictEqual(replay.body.replayed, true, 'the body says it is a replay');
    assert.strictEqual(replay.body.feedbackId, first.body.feedbackId);

    const dupe = await raise(id, body);   // fresh key, same bug
    assert.strictEqual(dupe.body.result, 'duplicate');
    assert.strictEqual(dupe.body.feedbackId, first.body.feedbackId);
    assert.strictEqual((await sql(cfg, 'SELECT COUNT(*) AS n FROM external_feedback WHERE asset_id = ?', [id]))[0].n, 1);

    const types = (await eventsFor('feedback', first.body.feedbackId)).map((e) => e.type);
    assert.deepStrictEqual(types, ['feedback.received', 'feedback.accepted']);

    const byId = await v1(`/feedback/${first.body.feedbackId}`);
    assert.strictEqual(byId.body.feedback.state, 'with_lead');
    const byBug = await v1('/feedback?source_app=devqa&client_bug_id=bug-uuid-7');
    assert.deepStrictEqual(byBug.body.feedback.map((f) => f.id), [first.body.feedbackId]);
  });

  await t.test('feedback on busy work is a note, and says so', async () => {
    const id = await newAsset('Busy', 'in_progress');
    const r = await raise(id, { client_bug_id: 'bug-busy' });
    assert.strictEqual(r.body.result, 'note_only');
    assert.strictEqual(r.body.state, 'noted');
    assert.match(r.body.reason, /in_progress/);
    assert.strictEqual((await assetRow(id)).status, 'in_progress');
  });

  await t.test('a closed project refuses, as a refusal', async () => {
    const p = await as('root', '/projects', { method: 'POST', body: { name: 'Closed Game', clientId: ids.client } });
    const id = await newAsset('Closed', 'delivered', p.body.project.id);
    await as('root', `/projects/${p.body.project.id}/close?confirm=1`, { method: 'POST' });
    await sql(cfg, 'UPDATE projects SET closed_at = NOW() WHERE id = ?', [p.body.project.id]);
    const r = await raise(id);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.result, 'refused');
    assert.strictEqual(r.body.code, 'project_closed');
  });

  await t.test('the whole return flow, ending at ready for reintegration and not in a build', async () => {
    const id = await newAsset('Round Trip');
    const r = await raise(id, { client_bug_id: 'bug-round-trip', source_app: 'devqa' });
    const fid = r.body.feedbackId;

    const pass = await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(pass.status, 200, JSON.stringify(pass.body));
    assert.strictEqual((await v1(`/feedback/${fid}`)).body.feedback.state, 'with_artist');

    // Withdrawing now would pull it from under the artist.
    const late = await v1(`/assets/${id}/feedback/${fid}/withdraw`, { method: 'POST', body: {} });
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.body.code, 'feedback_in_progress');

    const submit = async (link) => {
      const s = await as('artist', `/assets/${id}/start`, { method: 'POST' });
      assert.strictEqual(s.status, 200, JSON.stringify(s.body));
      const sub = await as('artist', `/assets/${id}/submit`, { method: 'POST', body: { link } });
      assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));
    };
    await submit('https://example.com/fix-1');
    assert.strictEqual((await v1(`/feedback/${fid}`)).body.feedback.state, 'in_review');

    const back = await as('lead', `/assets/${id}/review`, { method: 'POST', body: { decision: 'changes_requested', text: 'still clips' } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    assert.strictEqual((await v1(`/feedback/${fid}`)).body.feedback.state, 'with_artist');

    await submit('https://example.com/fix-2');
    const ok = await as('lead', `/assets/${id}/review`, { method: 'POST', body: { decision: 'approved', text: 'fixed' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await v1(`/feedback/${fid}`)).body.feedback.state, 'fix_approved');

    const lifecycle = await eventsFor('feedback', fid);
    assert.deepStrictEqual(lifecycle.map((e) => e.type), [
      'feedback.received', 'feedback.accepted', 'feedback.assigned', 'feedback.fix_submitted',
      'feedback.changes_requested', 'feedback.fix_submitted', 'feedback.fix_approved',
    ]);
    const versions = lifecycle.map((e) => e.entity.version);
    assert.deepStrictEqual(versions, [...versions].sort((a, b) => a - b), 'versions rise');
    assert.strictEqual(new Set(versions).size, versions.length);
    assert.strictEqual(lifecycle[6].payload.clientBugId, 'bug-round-trip');
    assert.strictEqual(lifecycle[6].payload.approvedVersion.link, 'https://example.com/fix-2');

    const [ready] = await eventsFor('asset', id);
    assert.strictEqual(ready.type, 'asset.ready_for_reintegration');
    assert.deepStrictEqual(ready.payload.feedback.map((f) => f.clientBugId), ['bug-round-trip']);

    // Ready is where Forge stops: nothing reported the asset into any build.
    assert.strictEqual((await sql(cfg, 'SELECT COUNT(*) AS n FROM asset_ingame WHERE asset_id = ?', [id]))[0].n, 0);
    assert.strictEqual((await assetRow(id)).status, 'tl_approved');
  });

  await t.test('declined, and withdrawn, each close the bug and say so', async () => {
    const a = await newAsset('Declined');
    const ra = await raise(a);
    const d = await as('lead', `/assets/${a}/game-feedback`, { method: 'POST', body: { decision: 'decline', reason: 'working as designed' } });
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const declined = await eventsFor('feedback', ra.body.feedbackId);
    assert.strictEqual(declined[declined.length - 1].type, 'feedback.declined');
    assert.strictEqual(declined[declined.length - 1].payload.state, 'declined');
    assert.strictEqual(declined[declined.length - 1].payload.reason, 'working as designed');

    const b = await newAsset('Withdrawn');
    const rb = await raise(b);
    const w = await v1(`/assets/${b}/feedback/${rb.body.feedbackId}/withdraw`, { method: 'POST', body: { reason: 'duplicate of another' } });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.result, 'withdrawn');
    assert.strictEqual(w.body.restoredTo, 'delivered');
    assert.strictEqual((await assetRow(b)).status, 'delivered', 'back where it was');
    const again = await v1(`/assets/${b}/feedback/${rb.body.feedbackId}/withdraw`, { method: 'POST', body: {} });
    assert.strictEqual(again.body.alreadyWithdrawn, true);
    const closed = await v1(`/assets/${a}/feedback/${ra.body.feedbackId}/withdraw`, { method: 'POST', body: {} });
    assert.strictEqual(closed.status, 409);
    assert.strictEqual(closed.body.code, 'feedback_closed');
  });

  await t.test('hand-offs: created, acknowledged, cancelled', async () => {
    const a1 = await newAsset('Drop One', 'approved_for_client');
    const sent = await as('lead', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [a1], kind: 'partial_drop' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    const hid = sent.body.handoffId;
    const [created] = await eventsFor('handoff', hid);
    assert.strictEqual(created.type, 'handoff.created');
    assert.strictEqual(created.payload.assets[0].name, 'Drop One');

    const read = await v1(`/handoffs/${hid}`);
    assert.strictEqual(read.body.handoff.assets.length, 1);
    const list = await v1(`/handoffs?project_id=${ids.project}`);
    assert.ok(list.body.handoffs.some((h) => h.id === hid));

    const ack = await v1(`/handoffs/${hid}/ack`, { method: 'POST', body: { build: 'Build #12' } });
    assert.strictEqual(ack.status, 200, JSON.stringify(ack.body));
    const events = await eventsFor('handoff', hid);
    assert.strictEqual(events[events.length - 1].type, 'handoff.updated');
    const refused = await as('lead', `/assets/handoffs/${hid}/cancel`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, 'an acknowledged drop cannot be cancelled');

    const a2 = await newAsset('Drop Two', 'approved_for_client');
    const second = await as('lead', '/assets/bulk/send-to-dev', { method: 'POST', body: { assetIds: [a2] } });
    const cancel = await as('lead', `/assets/handoffs/${second.body.handoffId}/cancel`, { method: 'POST', body: { reason: 'wrong asset' } });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
    const c = await eventsFor('handoff', second.body.handoffId);
    assert.strictEqual(c[c.length - 1].type, 'handoff.cancelled');
    const lateAck = await v1(`/handoffs/${second.body.handoffId}/ack`, { method: 'POST', body: { build: 'x' } });
    assert.strictEqual(lateAck.status, 409);
    assert.strictEqual(lateAck.body.code, 'handoff_cancelled');
  });

  await t.test('the pull side returns envelopes in sequence order', async () => {
    const page = await v1('/events?since=0&limit=200');
    assert.strictEqual(page.status, 200);
    const seqs = page.body.envelopes.map((e) => e.sequence);
    assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(page.body.envelopes.every((e) => e.schemaVersion === 1 && e.eventId && e.type));
  });

  await t.test('the previous inbound secret still verifies during a rotation', async () => {
    const r = await v1('/health', { secret: OLD_SECRET });
    assert.strictEqual(r.status, 200);
    const wrong = await v1('/health', { secret: 'not-either-secret' });
    assert.strictEqual(wrong.status, 401);
  });

  await t.test('the test probe is not mounted on a deployment', async () => {
    const r = await v1('/counter', { method: 'POST', body: { counter: 'x' } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await sql(cfg, "SELECT COUNT(*) AS n FROM integration_outbox WHERE payload LIKE '%probe%'"))[0].n, 0);
  });
});

test('switched off: 503, and no events written', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const offCfg = config('contractoff');
  let server;
  t.before(async () => {
    await resetSchema(offCfg);
    server = await startServer(offCfg, {
      INTEGRATION_ENABLED: 'false', INTEGRATION_INBOUND_SECRET: SECRET, BOOTSTRAP_TOKEN: 'off-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0',
    });
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the API says it is off', async () => {
    const res = await fetch(`${server.base}/integration/v1/health`);
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).code, 'integration_disabled');
  });

  await t.test('and a client created meanwhile writes nothing to the outbox', async () => {
    await api(server.base, '/auth/bootstrap', {
      method: 'POST', body: { token: 'off-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const token = (await api(server.base, '/auth/login', { method: 'POST', body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const c = await api(server.base, '/clients', { method: 'POST', token, body: { name: 'Quiet Client' } });
    assert.strictEqual(c.status, 201);
    assert.strictEqual((await sql(offCfg, 'SELECT COUNT(*) AS n FROM integration_outbox'))[0].n, 0);
  });
});
