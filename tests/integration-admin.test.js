/* Settings -> Dev & QA Integration: the screen that issues the credentials.
 *
 * THREE THINGS ARE ACTUALLY AT STAKE here and the rest is plumbing:
 *
 *   NOBODY BUT THE SUPER ADMIN. Enforced server-side on every route, not by the screen
 *   hiding a button, and settings.integrations is not grantable — so this is checked
 *   against a designation that has been given every OTHER permission there is.
 *
 *   THE ROTATION WINDOW. Both keys work for 24 hours and then the old one does not. The
 *   boundary is where an off-by-one lives, so it is tested from both sides of it rather
 *   than only from the comfortable side.
 *
 *   RESEND GOES THROUGH THE WORKER. It queues a row; it does not deliver. A second
 *   delivery path would be a second place for the signing, the timeout and the backoff to
 *   be got wrong — and the one that only ran when somebody clicked would be the one nobody
 *   noticed had rotted.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

// The worker runs in this process; the integration is off unless switched on.
process.env.INTEGRATION_ENABLED = 'true';
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const catalog = require('../src/permission-catalog');

const cfg = config('integrationadmin');
const PASSWORD = 'IntegrationAdmin-1!';
const IN_SECRET = 'inbound-secret-for-the-test-suite-only';
const OUT_SECRET = 'outbound-secret-for-the-test-suite';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('the permissions this screen needs', () => {
  for (const key of ['integration.send_to_dev', 'integration.flag_tech_art',
    'integration.view_ingame', 'settings.integrations']) {
    assert.ok(catalog.KEYS.includes(key), `${key} is in the catalogue`);
  }

  /* Three are declared pending — nothing reads them until their screens exist, which is a
     statement rather than an omission, and the guard in role-permissions.test.js fails for
     a key that is neither read nor declared. settings.integrations is NOT pending: this
     release's routes read it. */
  for (const key of ['integration.send_to_dev', 'integration.flag_tech_art', 'integration.view_ingame']) {
    assert.strictEqual(catalog.BY_KEY.get(key).pending, true, `${key} is declared pending`);
  }
  assert.ok(!catalog.BY_KEY.get('settings.integrations').pending,
    'settings.integrations is read by this release');

  // And it cannot be handed to anybody else — issuing a key reaches data no designation
  // limits, so it is the second not-grantable permission in the catalogue.
  assert.ok(!catalog.grantableKeys().includes('settings.integrations'));
  assert.match(catalog.BY_KEY.get('settings.integrations').danger, /every project and asset/);
});

test('the integration settings screen', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let receiver;
  let received = [];
  const token = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });
  const admin = (p, options) => as('root', `/admin/integration${p}`, options);

  // A signed call with a given key, to find out whether that key still works.
  const knock = async (key) => {
    const stamp = Math.floor(Date.now() / 1000);
    const target = '/api/integration/v1/ping';
    const v1 = crypto.createHmac('sha256', IN_SECRET)
      .update(`${stamp}.POST.${target}.{}`).digest('hex');
    const res = await fetch(`${server.base}/integration/v1/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': key,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: '{}',
    });
    return res.status;
  };

  t.before(async () => {
    await resetSchema(cfg);
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(body); res.writeHead(200); res.end('{"ok":true}'); });
    });
    await new Promise((done) => receiver.listen(0, '127.0.0.1', done));

    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'ia-bootstrap',
      INTEGRATION_INBOUND_SECRET: IN_SECRET,
      INTEGRATION_OUTBOUND_SECRET: OUT_SECRET,
      INTEGRATION_OUTBOUND_URL: `http://127.0.0.1:${receiver.address().port}/hooks/forge`,
      // Long enough that the worker's own timer never races these tests; the startup pass
      // is the only one, and resend is asserted against a sweep this test drives.
      INTEGRATION_OUTBOX_SWEEP_SECONDS: '3600',
      WORK_HOURS_SWEEP_MINUTES: '0',
    });

    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'ia-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    /* A designation given EVERY GRANTABLE PERMISSION and still refused. That is what makes
       the rejection tests mean something: they fail for lack of THIS permission, not for
       lack of administrative access in general. */
    const other = await as('root', '/users', {
      method: 'POST',
      body: { name: 'Almost Admin', email: 'almost@zvky.test', role: 'producer', password: PASSWORD },
    });
    assert.strictEqual(other.status, 201, JSON.stringify(other.body));
    ids.other = other.body.user.id;
    const grantAll = await as('root', '/permissions/roles/producer', {
      method: 'PUT', body: { permissions: catalog.grantableKeys() },
    });
    assert.ok(grantAll.status < 400, JSON.stringify(grantAll.body));
    token.almost = await login('almost@zvky.test');
  });

  t.after(async () => {
    if (server) await stopServer(server);
    if (receiver) await new Promise((done) => receiver.close(done));
  });

  // --- Super Admin only, on every route ------------------------------------

  await t.test('every action is refused for anybody but the Super Admin', async () => {
    const calls = [
      ['GET', '/clients'],
      ['POST', '/clients', { name: 'Sneaky', allowedActions: ['ping'] }],
      ['POST', '/clients/any-id/rotate'],
      ['POST', '/clients/any-id/revoke'],
      ['POST', '/clients/any-id/restore'],
      ['GET', '/addresses'],
      ['POST', '/addresses', { address: '203.0.113.9' }],
      ['DELETE', '/addresses/any-id'],
      ['GET', '/messages'],
      ['POST', '/messages/any-id/resend'],
      ['GET', '/health'],
    ];
    for (const [method, p, body] of calls) {
      const r = await as('almost', `/admin/integration${p}`, { method, body });
      assert.strictEqual(r.status, 403,
        `${method} ${p} must be refused: ${r.status} ${JSON.stringify(r.body)}`);
    }

    /* And it is THIS permission they lack, not administrative access generally: the same
       designation holds every grantable permission there is. */
    const held = await as('root', '/permissions/roles/producer');
    const enabled = held.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(enabled.length > 40, `the designation really does hold nearly everything: ${enabled.length}`);
    assert.ok(!enabled.includes('settings.integrations'));
  });

  // --- issuing, and the key shown once -------------------------------------

  await t.test('a new credential shows its key exactly once', async () => {
    const r = await admin('/clients', {
      method: 'POST', body: { name: 'Dev and QA', allowedActions: ['ping', 'assets', 'projects'] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.keyShownOnce, true);
    assert.match(r.body.key, /^[0-9a-f]{64}$/, '32 random bytes as hex, safe to paste anywhere');
    ids.client = r.body.client.id;
    ids.key = r.body.key;

    // The key works.
    assert.strictEqual(await knock(ids.key), 200);

    /* AND IS NEVER SHOWN AGAIN — not withheld from the screen, but genuinely not there:
       only its hash is stored, and a hash cannot be reversed even for a Super Admin. */
    const listed = await admin('/clients');
    const mine = listed.body.clients.find((c) => c.id === ids.client);
    assert.ok(mine, 'it is listed');
    assert.strictEqual(mine.keyPrefix, ids.key.slice(0, 8), 'which key it is on, not what it is');
    assert.ok(!('key' in mine) && !('keyHash' in mine), 'no key and no hash reaches the browser');
    assert.ok(!JSON.stringify(listed.body).includes(ids.key), 'the key appears nowhere in the listing');

    const stored = await sql(cfg, 'SELECT key_hash FROM integration_clients WHERE id = ?', [ids.client]);
    assert.strictEqual(stored[0].key_hash, sha256(ids.key), 'the hash is what is kept');
    assert.notStrictEqual(stored[0].key_hash, ids.key);
  });

  await t.test('the listing says what a credential may do, and when it was last used', async () => {
    const r = await admin('/clients');
    const mine = r.body.clients.find((c) => c.id === ids.client);
    assert.deepStrictEqual(mine.allowedActions, ['assets', 'ping', 'projects']);
    assert.strictEqual(mine.isActive, true);
    assert.ok(mine.lastUsedAt, 'the call above is recorded');
    assert.strictEqual(r.body.overlapHours, 24);
  });

  await t.test('a credential needs a name and at least one action', async () => {
    const noName = await admin('/clients', { method: 'POST', body: { allowedActions: ['ping'] } });
    assert.strictEqual(noName.status, 400);
    assert.strictEqual(noName.body.field, 'name');

    const noActions = await admin('/clients', { method: 'POST', body: { name: 'Idle Hands' } });
    assert.strictEqual(noActions.status, 400);
    assert.strictEqual(noActions.body.field, 'allowedActions');
  });

  // --- THE ROTATION WINDOW -------------------------------------------------

  await t.test('rotation: both keys work during the overlap', async () => {
    const before = ids.key;
    const r = await admin(`/clients/${ids.client}/rotate`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.keyShownOnce, true);
    assert.notStrictEqual(r.body.key, before, 'a genuinely new key');
    ids.key = r.body.key;

    assert.strictEqual(await knock(ids.key), 200, 'the new key works');
    assert.strictEqual(await knock(before), 200,
      'AND SO DOES THE OLD ONE — otherwise every rotation is an outage for whatever is mid-flight');
    ids.previous = before;

    assert.ok(r.body.client.rotation, 'the screen is told there is an overlap running');
    assert.ok(new Date(r.body.client.rotation.previousKeyValidUntil) > new Date());
  });

  await t.test('rotation: the old key stops at the boundary, not around it', async () => {
    /* THE OFF-BY-ONE LIVES HERE. The window is measured by the DATABASE clock against the
       expiry the rotation wrote, so the boundary is moved by moving that expiry rather
       than by waiting 24 hours or by mocking a clock this process does not own. */
    const setExpiry = (sqlExpr) => sql(cfg,
      `UPDATE integration_clients SET prev_key_expires_at = ${sqlExpr} WHERE id = ?`, [ids.client]);

    await setExpiry('NOW() + INTERVAL 1 SECOND');
    assert.strictEqual(await knock(ids.previous), 200, 'one second before it expires, it works');

    await setExpiry('NOW()');
    assert.strictEqual(await knock(ids.previous), 401,
      'AT the expiry it is already dead — the window is "expires in the future", not "has not passed"');

    await setExpiry('NOW() - INTERVAL 1 SECOND');
    assert.strictEqual(await knock(ids.previous), 401, 'and after it, plainly');

    // The current key is untouched by any of that.
    assert.strictEqual(await knock(ids.key), 200);

    // And the screen stops claiming an overlap once it has passed.
    const listed = await admin('/clients');
    assert.strictEqual(listed.body.clients.find((c) => c.id === ids.client).rotation, null);
  });

  await t.test('rotation twice over leaves only the most recent previous key alive', async () => {
    const first = ids.key;
    const second = (await admin(`/clients/${ids.client}/rotate`, { method: 'POST' })).body.key;
    const third = (await admin(`/clients/${ids.client}/rotate`, { method: 'POST' })).body.key;

    assert.strictEqual(await knock(third), 200, 'the current one');
    assert.strictEqual(await knock(second), 200, 'and the one it replaced');
    assert.strictEqual(await knock(first), 401,
      'but not the one before that — the overlap is one key deep, not a history');
    ids.key = third;
  });

  // --- revoking ------------------------------------------------------------

  await t.test('revoking stops it at once, overlap included', async () => {
    const r = await admin(`/clients/${ids.client}/rotate`, { method: 'POST' });
    const previous = ids.key;
    ids.key = r.body.key;
    assert.strictEqual(await knock(previous), 200, 'an overlap is running');

    const revoked = await admin(`/clients/${ids.client}/revoke`, { method: 'POST' });
    assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));
    assert.strictEqual(revoked.body.client.isActive, false);

    assert.strictEqual(await knock(ids.key), 401, 'the current key stops');
    assert.strictEqual(await knock(previous), 401,
      'and so does the overlap — a revocation that left a key alive for 23 more hours '
      + 'would be the opposite of the word');

    // Restoring brings back the key it had; revoking never changed it.
    const back = await admin(`/clients/${ids.client}/restore`, { method: 'POST' });
    assert.strictEqual(back.body.client.isActive, true);
    assert.strictEqual(await knock(ids.key), 200);

    /* AND NOT THE ONE THAT WAS IN ITS OVERLAP. This is what the clearing on revoke is
       actually for: refusing the previous key while revoked needs no clearing, because the
       is_active check turns it away anyway — a mutation that dropped the clearing survived
       until this assertion existed. It matters HERE: without it, restoring would resurrect
       a key the studio had deliberately withdrawn, still inside a window that had kept
       running while the credential was off. */
    assert.strictEqual(await knock(previous), 401,
      'restoring must not bring back a key the revocation withdrew');
  });

  // --- the address list ----------------------------------------------------

  await t.test('the address list says, in words, that it is only watching', async () => {
    const r = await admin('/addresses');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.enforcement.mode, 'monitor',
      'shipping this screen must not change the default');
    assert.match(r.body.enforcement.explain, /MONITOR MODE: nothing is refused/);
    assert.match(r.body.enforcement.explain, /INTEGRATION_IP_ALLOWLIST_MODE=enforce on the server/,
      'and that switching it on is a server change, not a button here');
  });

  await t.test('addresses can be added and removed, and nonsense is refused', async () => {
    const added = await admin('/addresses', {
      method: 'POST', body: { address: '203.0.113.0/24', label: 'the build farm' },
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));

    const listed = await admin('/addresses');
    assert.ok(listed.body.entries.some((e) => e.address === '203.0.113.0/24'));

    const bad = await admin('/addresses', { method: 'POST', body: { address: '010.1.1.1' } });
    assert.strictEqual(bad.status, 400, 'a leading-zero octet is octal to some parsers and decimal to others');
    assert.strictEqual(bad.body.field, 'address');

    const gone = await admin(`/addresses/${added.body.entry.id}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    const after = await admin('/addresses');
    assert.ok(!after.body.entries.some((e) => e.address === '203.0.113.0/24'));
  });

  // --- the message log, and resend -----------------------------------------

  await t.test('the message log shows the outbox with its failures', async () => {
    await sql(cfg,
      'INSERT INTO integration_outbox (id, payload, `status`, attempts, last_error) VALUES (?,?,?,?,?)',
      [crypto.randomUUID(), JSON.stringify({ event: 'sent.one' }), 'sent', 1, null]);
    ids.failed = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO integration_outbox (id, payload, `status`, attempts, last_error) VALUES (?,?,?,?,?)',
      [ids.failed, JSON.stringify({ event: 'gave.up' }), 'failed', 7, 'the receiver answered 500']);

    const r = await admin('/messages');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const failed = r.body.messages.find((m) => m.id === ids.failed);
    assert.ok(failed, 'the failed row is there');
    assert.strictEqual(failed.attempts, 7);
    assert.match(failed.lastError, /answered 500/);
    assert.deepStrictEqual(failed.payload, { event: 'gave.up' });
    assert.ok(r.body.counts.failed >= 1 && r.body.counts.sent >= 1, JSON.stringify(r.body.counts));
    assert.deepStrictEqual(r.body.schedule, [60, 300, 1800, 7200, 21600, 86400],
      'and the schedule, so the screen can say when the next try is');

    const only = await admin('/messages?status=failed');
    assert.ok(only.body.messages.every((m) => m.status === 'failed'));
  });

  await t.test('RESEND queues the row and the EXISTING worker delivers it', async () => {
    /* It must not deliver anything itself. A second delivery path would be a second place
       for the signing, the timeout and the backoff to be got wrong. */
    received = [];
    const r = await admin(`/messages/${ids.failed}/resend`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.queued, true);
    assert.match(r.body.note, /delivery worker sends it/, 'and says so, because "resend" reads as "sent"');
    assert.strictEqual(received.length, 0, 'nothing was delivered by the click itself');

    const row = await sql(cfg,
      'SELECT `status`, attempts, next_attempt_at AS due, last_error FROM integration_outbox WHERE id = ?',
      [ids.failed]);
    assert.strictEqual(row[0].status, 'pending', 'back in the queue');
    assert.strictEqual(Number(row[0].attempts), 0,
      'and its attempts reset, or a row that had used all seven would fail again at once '
      + 'and the button would appear to do nothing');
    assert.strictEqual(row[0].due, null, 'due now');
    assert.strictEqual(row[0].last_error, null);

    /* And now the REAL worker, the one src/integration-outbox.js exports, with this
       process's own environment pointed at the test receiver. Nothing in this test
       reimplements delivery. */
    const outbox = require('../src/integration-outbox');
    const keep = {
      url: process.env.INTEGRATION_OUTBOUND_URL, sec: process.env.INTEGRATION_OUTBOUND_SECRET,
    };
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db = { query: async (text, params) => {
      const values = [];
      const t = text.replace(/\$(\d+)/g, (_, n) => { values.push((params || [])[Number(n) - 1]); return '?'; });
      const [rows] = await conn.query(t, values.length ? values : (params || []));
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };
    try {
      process.env.INTEGRATION_OUTBOUND_URL = `http://127.0.0.1:${receiver.address().port}/hooks/forge`;
      process.env.INTEGRATION_OUTBOUND_SECRET = OUT_SECRET;
      const tally = await outbox.sweep(db, { log: () => {} });
      assert.ok(tally.sent >= 1, `the worker picked it up: ${JSON.stringify(tally)}`);
      assert.ok(received.some((b) => JSON.parse(b).event === 'gave.up'),
        'and the receiver got the message that had previously been given up on');
      const done = await sql(cfg, 'SELECT `status` FROM integration_outbox WHERE id = ?', [ids.failed]);
      assert.strictEqual(done[0].status, 'sent');
    } finally {
      if (keep.url === undefined) delete process.env.INTEGRATION_OUTBOUND_URL;
      else process.env.INTEGRATION_OUTBOUND_URL = keep.url;
      if (keep.sec === undefined) delete process.env.INTEGRATION_OUTBOUND_SECRET;
      else process.env.INTEGRATION_OUTBOUND_SECRET = keep.sec;
      await conn.end();
    }
  });

  await t.test('a message being delivered right now cannot be queued again', async () => {
    const inFlight = crypto.randomUUID();
    await sql(cfg, 'INSERT INTO integration_outbox (id, payload, `status`) VALUES (?,?,?)',
      [inFlight, '{}', 'sending']);
    const r = await admin(`/messages/${inFlight}/resend`, { method: 'POST' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'message_in_flight');

    const nope = await admin(`/messages/${crypto.randomUUID()}/resend`, { method: 'POST' });
    assert.strictEqual(nope.status, 404);
  });

  // --- health --------------------------------------------------------------

  await t.test('health reports what HAS happened, and never the secrets', async () => {
    const r = await admin('/health');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.inbound && r.body.inbound.at, 'something has reached us');
    assert.strictEqual(r.body.inbound.client, 'Dev and QA');
    assert.ok(r.body.outbound && r.body.outbound.at, 'and something has left');

    assert.strictEqual(r.body.configured.inboundSecret, true, 'whether it is set');
    assert.strictEqual(r.body.configured.outboundSecret, true);
    assert.strictEqual(r.body.configured.secretsCollide, false);
    const body = JSON.stringify(r.body);
    assert.ok(!body.includes(IN_SECRET) && !body.includes(OUT_SECRET),
      'and never what they are — there is no reason for a browser to carry them');
  });

  await t.test('the activity log records every one of these', async () => {
    const rows = await sql(cfg,
      "SELECT action FROM activity_log WHERE action LIKE 'integration.%' ORDER BY seq");
    const actions = new Set(rows.map((r) => r.action));
    for (const action of ['integration.client.create', 'integration.client.rotate',
      'integration.client.revoke', 'integration.address.add', 'integration.message.resend']) {
      assert.ok(actions.has(action), `${action} is in the log: ${[...actions].join(', ')}`);
    }
  });
});
