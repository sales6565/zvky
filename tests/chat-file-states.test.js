/* THE THREE THINGS THAT CAN GO WRONG WITH AN ATTACHMENT, TOLD APART.
 *
 * ===========================================================================
 * WHY THIS IS A SUITE OF ITS OWN. "This file is no longer available." was the
 * answer for a file that had expired, a file whose bytes were gone, and a file
 * belonging to a conversation you are not in. The studio read it as a retention
 * bug twice, and both times the first day went on reading the retention code —
 * which was right the second time and wrong only in that the message had sent
 * everybody to it.
 *
 * So: three states, three sentences, and the one that should never happen
 * writes itself down with enough detail that the next report arrives with
 * evidence instead of a screenshot.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatstate');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Chat-States-11!';
const ROOT = path.join(os.homedir(), '.zvky-test-chat-uploads', 'states');

test('expired, missing and no-access are three different answers', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const ids = {};

  t.before(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'states', CHAT_UPLOAD_DIR: ROOT,
      CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'states', name: 'Root', email: 'root@states.test', password: PASSWORD } });
    tok.root = await login('root@states.test');
    for (const [who, name] of [['ana', 'Ana'], ['bo', 'Bo'], ['cas', 'Cas']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@states.test`, password: PASSWORD, role: 'game_artist' } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      ids[who] = made.body.user.id;
      tok[who] = await login(`${who}@states.test`);
    }
    /* Ana and Bo share a conversation. Cas is not in it, which is the whole of
       the third case. */
    ids.conv = (await as('ana', '/chat/direct',
      { method: 'POST', body: { userId: ids.bo } })).body.conversationId;
  });
  t.after(() => { if (server) stopServer(server); });

  /* One real upload, through the real route, reused by the cases below. */
  const upload = async (who, name = 'brief.png') => {
    const form = new FormData();
    form.set('body', 'here it is');
    form.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), name);
    const res = await fetch(`${server.base}/chat/${ids.conv}/messages`,
      { method: 'POST', headers: { Authorization: `Bearer ${tok[who]}` }, body: form });
    /* READ ONCE. An assertion message is evaluated whether or not the assertion
       fails, so `assert(ok, await res.text())` consumes the body and the parse
       after it throws "Body has already been read" — which then hides whatever
       the case was really about. */
    const text = await res.text();
    assert.strictEqual(res.status, 201, text);
    return JSON.parse(text).message.attachments[0];
  };
  const fetchFile = async (who, id) => {
    const res = await fetch(`${server.base}/chat/attachments/${id}`,
      { headers: { Authorization: `Bearer ${tok[who]}` } });
    const said = res.status === 200 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, ...said };
  };

  await t.test('a live file is served, and the paperclip is on', async () => {
    const att = await upload('ana');
    const got = await fetchFile('bo', att.id);
    assert.strictEqual(got.status, 200, JSON.stringify(got));
    const panel = await as('ana', '/chat');
    assert.strictEqual(panel.body.attachments.storageOk, true);
  });

  await t.test('EXPIRED says expired, and names the retention', async () => {
    const att = await upload('ana');
    await sql(cfg, 'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [att.id]);
    const got = await fetchFile('bo', att.id);
    assert.strictEqual(got.status, 410);
    assert.strictEqual(got.state, 'expired');
    assert.match(got.error, /expired/i);
    assert.match(got.error, /12 hours/, 'and says what the retention is');
  });

  await t.test('MISSING says missing, says it is not expected, and writes the details down',
    async () => {
    const att = await upload('ana', 'wanted.png');
    const row = (await sql(cfg, 'SELECT stored_name AS s FROM chat_attachments WHERE id = ?',
      [att.id]))[0];
    /* THE BYTES REMOVED UNDERNEATH A LIVE ROW — which is exactly what a deploy
       that replaces the application folder does to every file in it. */
    fs.rmSync(path.join(ROOT, row.s), { force: true });

    const got = await fetchFile('bo', att.id);
    assert.strictEqual(got.status, 410);
    assert.strictEqual(got.state, 'missing_file');
    assert.match(got.error, /missing on the server/i);
    assert.match(got.error, /not expected/i);
    assert.match(got.error, /administrator/i, 'and says who to tell');
    assert.ok(!/expired/i.test(got.error), 'and never calls it an expiry');

    /* THE DIAGNOSTIC. Everything the next bug report will need. */
    const inc = await sql(cfg,
      `SELECT attachment_id AS att, kind, detail FROM chat_file_incidents
        WHERE kind = 'missing_before_expiry' ORDER BY created_at DESC LIMIT 1`);
    assert.strictEqual(inc.length, 1, 'an incident was recorded');
    assert.strictEqual(inc[0].att, att.id, 'against the attachment');
    assert.match(inc[0].detail, /wanted\.png/, 'with the file name');
    assert.match(inc[0].detail, /retention left/, 'how long it had left');
    assert.match(inc[0].detail, new RegExp(row.s.replace('.', '\\.')), 'what was looked for');
    assert.match(inc[0].detail, /roots tried/, 'and where it looked');
  });

  await t.test('NO ACCESS says so, and says nothing about the file', async () => {
    const att = await upload('ana', 'private.png');
    const got = await fetchFile('cas', att.id);
    /* 404, THE SAME STATUS A MADE-UP ID GETS. The status is what two older
       cases pin as a security property — an attachment id must not be a bearer
       token, and a 403 would confirm that a stolen id names something real.
       What changes is the sentence the person reads. */
    assert.strictEqual(got.status, 404);
    assert.strictEqual(got.state, 'no_access');
    assert.match(got.error, /do not have access/i);
    assert.ok(!/private\.png/.test(JSON.stringify(got)), 'and does not name the file');
    assert.ok(!/expired|missing/i.test(got.error), 'and is not dressed up as either of the others');
    /* AND NO INCIDENT: somebody asking for a file that is not theirs is not a
       fault of the server's, and a log that fills up with it is a log that
       hides the real one. */
    const inc = await sql(cfg,
      "SELECT COUNT(*) AS n FROM chat_file_incidents WHERE attachment_id = ?", [att.id]);
    assert.strictEqual(Number(inc[0].n), 0);
  });

  await t.test('an id that does not exist is still just "no such file"', async () => {
    const got = await fetchFile('ana', '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(got.status, 404);
    assert.strictEqual(got.state, 'not_found');
  });

  await t.test('the health panel reports the folder, the counts and the fault', async () => {
    const r = await as('root', '/admin/settings/chat-policy');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const h = r.body.storage;
    assert.ok(h, 'the panel has a storage block');
    assert.strictEqual(h.path, ROOT, 'the folder in use');
    assert.strictEqual(h.source, 'env');
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.insideApp, false);
    assert.strictEqual(h.inTemp, false);
    assert.strictEqual(h.writable, true);
    assert.strictEqual(h.acceptingUploads, true);
    assert.ok(h.liveAttachments >= 3, `live attachments counted: ${h.liveAttachments}`);
    assert.strictEqual(h.missingLast7Days, 1, 'the one missing file is counted');
    assert.ok(h.missingLatest, 'and the time of it is given');
    assert.match(h.envName, /CHAT_UPLOAD_DIR/);
  });

  await t.test('and only to somebody with the permission', async () => {
    const r = await as('ana', '/admin/settings/chat-policy');
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes(ROOT),
      'the folder is not named in the refusal either');
  });

  await t.test('the Chat Activity screen words it the same way', async () => {
    /* OVERSIGHT HAS ITS OWN PATH AND ITS OWN AUTHORISATION, and the thing worth
       pinning is that it does not word any of this differently — a Super Admin
       looking into a report must see what the person who reported it saw. */
    const att = await upload('ana', 'oversight.png');
    const live = await fetch(`${server.base}/chat-activity/attachments/${att.id}`,
      { headers: { Authorization: `Bearer ${tok.root}` } });
    assert.strictEqual(live.status, 200, 'the Super Admin can open a live one');

    const row = (await sql(cfg, 'SELECT stored_name AS s FROM chat_attachments WHERE id = ?',
      [att.id]))[0];
    fs.rmSync(path.join(ROOT, row.s), { force: true });
    const gone = await fetch(`${server.base}/chat-activity/attachments/${att.id}`,
      { headers: { Authorization: `Bearer ${tok.root}` } });
    assert.strictEqual(gone.status, 410);
    const said = await gone.json();
    assert.strictEqual(said.state, 'missing_file');
    assert.match(said.error, /missing on the server/i);

    /* AND EXPIRY IS STILL EXPIRY HERE. Oversight does not extend the life of a
       file, and it does not rename the reason either. */
    const other = await upload('ana', 'aged.png');
    await sql(cfg, 'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [other.id]);
    const old = await fetch(`${server.base}/chat-activity/attachments/${other.id}`,
      { headers: { Authorization: `Bearer ${tok.root}` } });
    assert.strictEqual(old.status, 410);
    assert.strictEqual((await old.json()).state, 'expired');
  });
});
