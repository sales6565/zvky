/* SENDING MAIL THROUGH THE GMAIL API — against a fake Google, never the real one.
 *
 * NOTHING HERE TOUCHES THE NETWORK. A local HTTP server stands in for
 * oauth2.googleapis.com and gmail.googleapis.com; the transport reaches it
 * because both URLs are environment variables (GMAIL_TOKEN_URL, GMAIL_SEND_URL),
 * which exist for this and for nothing else. So the suite can say "Google
 * answered 429 with Retry-After: 30" and mean it, and it can run on a laptop
 * with no credential and no connection.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT, in the order the cases come:
 *
 *   THE TOKEN. One refresh reused until it is nearly spent; ONE refresh for
 *      forty concurrent sends, asserted by counting requests at the fake; a
 *      second refresh after expiry; and invalid_grant reported as a connection
 *      failure rather than a message failure.
 *   THE MESSAGE. Decoded back out of the base64url the transport sent and read
 *      header by header — because `raw` is the whole API surface, and a
 *      mistake in it is a garbled subject or an injected header rather than an
 *      error anybody sees.
 *   THE QUEUE. Each of Google's answers feeding the EXISTING six-retry counter
 *      the way it should: temporary counts an attempt, permanent fails at once,
 *      and invalid_grant consumes nothing and pauses everything.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const emailMessage = require('../src/email-message');
const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');

const cfg = config('gmailemail');

/* --- the fake Google -------------------------------------------------------- */

/* One server, two endpoints, and a script of answers.
 *
 * `plan` is read by the handlers: a function per endpoint, so a case can say
 * "the first send is a 429 and the second succeeds" without this growing a
 * language of its own. Everything is recorded, because most of the assertions
 * are about WHAT WAS SENT rather than about what came back. */
function fakeGoogle() {
  const seen = { tokenRequests: [], sendRequests: [] };
  let tokenHandler = () => ({ status: 200, body: { access_token: 'at-1', expires_in: 3600 } });
  let sendHandler = () => ({ status: 200, body: { id: 'gmail-1', threadId: 't-1' } });

  const read = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });

  const server = http.createServer(async (req, res) => {
    const body = await read(req);
    const answer = req.url.startsWith('/token')
      ? (seen.tokenRequests.push(body), await tokenHandler(body, seen.tokenRequests.length))
      : (seen.sendRequests.push({ body, auth: req.headers.authorization }),
        await sendHandler(body, seen.sendRequests.length));
    const headers = { 'Content-Type': 'application/json', ...(answer.headers || {}) };
    res.writeHead(answer.status, headers);
    res.end(JSON.stringify(answer.body === undefined ? {} : answer.body));
  });

  return {
    seen,
    onToken: (fn) => { tokenHandler = fn; },
    onSend: (fn) => { sendHandler = fn; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    })),
    close: () => new Promise((resolve) => server.close(resolve)),
    /* The raw message of the nth send, decoded — which is what most of the
       message assertions actually look at. */
    rawOf: (n = 0) => emailMessage.fromBase64Url(JSON.parse(seen.sendRequests[n].body).raw),
  };
}

/* The transport reads process.env on every call, so a case sets what it needs
   and this puts it all back. Nothing is cached across cases except by design —
   gmail._reset() clears the token the way a restart would. */
function withGmail(base, extra = {}) {
  const gmail = require('../src/gmail-transport');
  const before = { ...process.env };
  Object.assign(process.env, {
    EMAIL_TRANSPORT: 'gmail_api',
    GMAIL_TOKEN_URL: `${base}/token`,
    GMAIL_SEND_URL: `${base}/send`,
    GMAIL_CLIENT_ID: 'client-id-for-tests.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'client-secret-for-tests',
    GMAIL_REFRESH_TOKEN: 'refresh-token-for-tests',
    GMAIL_SENDER: 'sales@zvky.com',
    GMAIL_SENDER_NAME: 'ZVKY FORGE',
    GMAIL_REPLY_TO: '',
    ...extra,
  });
  gmail._reset();
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    Object.assign(process.env, before);
    gmail._reset();
  };
}

// ===========================================================================
// 1. THE ACCESS TOKEN.
// ===========================================================================

test('one refresh is reused, and forty concurrent sends share it', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    /* FORTY AT ONCE, which is a bulk assignment on a Monday morning. The
       assertion is the count at the fake: one token request, not forty. */
    const sends = [];
    for (let i = 0; i < 40; i += 1) {
      sends.push(gmail.send({ to: `artist${i}@zvky.com`, subject: 'Hello', text: 'body' }));
    }
    const results = await Promise.all(sends);
    assert.ok(results.every((r) => r.ok), 'all forty sent');
    assert.strictEqual(google.seen.tokenRequests.length, 1,
      `one refresh for forty sends, not ${google.seen.tokenRequests.length}`);
    assert.strictEqual(google.seen.sendRequests.length, 40);
    assert.strictEqual(gmail._stats().refreshCount, 1);

    /* And the token is REUSED afterwards, not re-fetched per message. */
    await gmail.send({ to: 'again@zvky.com', subject: 'Hello', text: 'body' });
    assert.strictEqual(google.seen.tokenRequests.length, 1, 'still one');

    /* The refresh request is the documented one: form-encoded, with the grant
       type and the credential. */
    const form = new URLSearchParams(google.seen.tokenRequests[0]);
    assert.strictEqual(form.get('grant_type'), 'refresh_token');
    assert.strictEqual(form.get('refresh_token'), 'refresh-token-for-tests');
    assert.strictEqual(form.get('client_id'), 'client-id-for-tests.apps.googleusercontent.com');
    /* And the send carries the access token as a bearer. */
    assert.strictEqual(google.seen.sendRequests[0].auth, 'Bearer at-1');
  } finally { restore(); await google.close(); }
});

test('a token near expiry is refreshed again, with the 60-second margin', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    /* expires_in 70 means the margin (60s) leaves ten seconds of life: the
       first send uses it, and a send after that window must refresh. Rather
       than waiting, the second case asks for a token that is ALREADY inside the
       margin — expires_in 30 — which is the same arithmetic without a sleep. */
    google.onToken((_, n) => ({ status: 200,
      body: { access_token: `at-${n}`, expires_in: 30 } }));

    await gmail.send({ to: 'a@zvky.com', subject: 'One', text: 'x' });
    assert.strictEqual(google.seen.tokenRequests.length, 1);
    await gmail.send({ to: 'b@zvky.com', subject: 'Two', text: 'x' });
    assert.strictEqual(google.seen.tokenRequests.length, 2,
      'a token inside the expiry margin is not reused');
    assert.strictEqual(google.seen.sendRequests[1].auth, 'Bearer at-2',
      'and the fresh one is what goes on the wire');
  } finally { restore(); await google.close(); }
});

test('invalid_grant is a connection failure, not a message failure', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    google.onToken(() => ({ status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    const result = await gmail.send({ to: 'a@zvky.com', subject: 'Hello', text: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'reauthorise',
      'the queue must not blame the message for this');
    assert.match(result.error, /needs to be re-authorised/);
    assert.match(result.error, /gmail-authorize/, 'and it says what to run');
    assert.strictEqual(google.seen.sendRequests.length, 0, 'nothing was sent');

    /* THE CREDENTIAL IS MASKED, not echoed. The error reaches a log and a
       Settings screen. */
    assert.ok(!result.error.includes('refresh-token-for-tests'),
      `the refresh token is in the error: ${result.error}`);
    assert.ok(!result.error.includes('client-secret-for-tests'));
    assert.match(result.error, /refr…\(23 chars\)/, 'it is masked rather than omitted');

    /* A FAILED REFRESH DOES NOT WEDGE THE NEXT ONE on a rejected promise. */
    google.onToken(() => ({ status: 200, body: { access_token: 'at-ok', expires_in: 3600 } }));
    const second = await gmail.send({ to: 'a@zvky.com', subject: 'Hello', text: 'x' });
    assert.strictEqual(second.ok, true, 'the next send refreshes again and works');
  } finally { restore(); await google.close(); }
});

test('a 401 on the send refreshes once, then reports a connection failure', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    /* The ordinary case first: a token that expired between the margin check
       and the request. One refresh, one retry, delivered. */
    google.onSend((_, n) => (n === 1
      ? { status: 401, body: { error: { message: 'Invalid Credentials' } } }
      : { status: 200, body: { id: 'gmail-2' } }));
    const ok = await gmail.send({ to: 'a@zvky.com', subject: 'Hello', text: 'x' });
    assert.strictEqual(ok.ok, true, 'a single 401 is recovered without the queue knowing');
    assert.strictEqual(google.seen.tokenRequests.length, 2, 'one refresh, after the 401');

    /* And the pathological case: 401 even after a successful refresh, which
       means the credential itself is rejected. */
    gmail._reset();
    google.onSend(() => ({ status: 401, body: { error: { message: 'Invalid Credentials' } } }));
    const bad = await gmail.send({ to: 'a@zvky.com', subject: 'Hello', text: 'x' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.kind, 'reauthorise');
    assert.match(bad.error, /twice, after a successful refresh/);
  } finally { restore(); await google.close(); }
});

// ===========================================================================
// 2. THE MESSAGE, decoded back out of what was sent.
// ===========================================================================

test('the raw message is a correct multipart/alternative with UTF-8 headers', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base, { GMAIL_SENDER_NAME: 'ZVKY FORGE', GMAIL_REPLY_TO: 'hello@zvky.com' });
  const gmail = require('../src/gmail-transport');
  try {
    const subject = 'Priyā Nair — ₹12,000 “approved”';
    const result = await gmail.send({
      to: 'priya@zvky.com',
      subject,
      text: 'Plain text for a client that wants it.',
      html: '<p>Rich text for one that does not.</p>',
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const raw = google.rawOf(0);

    assert.match(raw, /^From: "ZVKY FORGE" <sales@zvky\.com>\r\n/, 'From is the authenticated mailbox');
    assert.match(raw, /\r\nTo: priya@zvky\.com\r\n/);
    assert.match(raw, /\r\nReply-To: hello@zvky\.com\r\n/, 'the configured Reply-To is set');
    assert.match(raw, /\r\nMessage-ID: <[^>]+@zvky\.com>\r\n/, 'a Message-ID on our own domain');
    assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/);

    /* THE SUBJECT, RFC 2047 ENCODED AND DECODING BACK TO ITSELF. The assertion
       is the round trip rather than the exact encoding, because the chunking is
       an implementation detail and the meaning is not. */
    const header = raw.match(/\r\nSubject: (.+)\r\n/)[1];
    assert.ok(header.startsWith('=?UTF-8?B?'), `the subject is encoded: ${header}`);
    const decoded = header.split(/\s+/)
      .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64'))
      .reduce((all, buf) => Buffer.concat([all, buf]), Buffer.alloc(0)).toString('utf8');
    assert.strictEqual(decoded, subject, 'and it decodes back to exactly what was asked for');

    /* BOTH PARTS, PLAIN FIRST — a client shows the LAST part it understands, so
       the order is the difference between everybody reading the HTML and
       everybody reading the plain text. */
    const boundary = raw.match(/boundary="([^"]+)"/)[1];
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    assert.strictEqual(parts.length, 2);
    assert.match(parts[0], /Content-Type: text\/plain; charset="UTF-8"/);
    assert.match(parts[1], /Content-Type: text\/html; charset="UTF-8"/);
    const bodyOf = (part) => Buffer.from(part.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64')
      .toString('utf8');
    assert.strictEqual(bodyOf(parts[0]), 'Plain text for a client that wants it.');
    assert.strictEqual(bodyOf(parts[1]), '<p>Rich text for one that does not.</p>');
  } finally { restore(); await google.close(); }
});

test('CR and LF are refused in every header position, permanently', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    const attempts = [
      ['subject', { subject: 'Approved\r\nBcc: outsider@example.com', to: 'p@zvky.com' }],
      ['subject, LF alone', { subject: 'Approved\nBcc: outsider@example.com', to: 'p@zvky.com' }],
      ['recipient', { subject: 'Hello', to: 'p@zvky.com\r\nBcc: outsider@example.com' }],
      ['reply-to', { subject: 'Hello', to: 'p@zvky.com', replyTo: 'x@y.com\r\nBcc: o@e.com' }],
    ];
    for (const [where, message] of attempts) {
      const result = await gmail.send({ text: 'x', ...message });
      assert.strictEqual(result.ok, false, `${where} was accepted`);
      assert.strictEqual(result.kind, 'permanent',
        `${where}: an injected header is the message's fault and must not be retried`);
    }
    assert.strictEqual(google.seen.sendRequests.length, 0,
      'and nothing reached Google — the message is never built');

    /* A DISPLAY NAME IS A HEADER POSITION TOO, and it is the one that would be
       hidden inside an encoded word. */
    const named = withGmail(base, { GMAIL_SENDER_NAME: 'ZVKY\r\nBcc: outsider@example.com' });
    const sneaky = await gmail.send({ to: 'p@zvky.com', subject: 'Hello', text: 'x' });
    named();
    assert.strictEqual(sneaky.ok, false);
    assert.strictEqual(sneaky.kind, 'permanent');
  } finally { restore(); await google.close(); }
});

test('a bad recipient and an oversized body fail permanently, before any request', async () => {
  const google = fakeGoogle();
  const base = await google.listen();
  const restore = withGmail(base);
  const gmail = require('../src/gmail-transport');
  try {
    for (const to of ['', 'not-an-address', 'two@addresses.com, three@four.com', 'a@b']) {
      const result = await gmail.send({ to, subject: 'Hello', text: 'x' });
      assert.strictEqual(result.ok, false, `${JSON.stringify(to)} was accepted`);
      assert.strictEqual(result.kind, 'permanent');
    }
    /* THE CONFIGURED LIMIT, honoured — read at call time, so setting it here
       really does change what the next send accepts. */
    const small = withGmail(base, { EMAIL_MAX_BYTES: '2000' });
    const overSmall = await gmail.send({ to: 'p@zvky.com', subject: 'Hello', text: 'x'.repeat(3000) });
    small();
    assert.strictEqual(overSmall.ok, false, 'a 3KB body is over a 2KB limit');
    assert.strictEqual(overSmall.kind, 'permanent');
    assert.match(overSmall.error, /the limit is 2000/);

    const huge = await gmail.send({ to: 'p@zvky.com', subject: 'Hello', text: 'x'.repeat(2_000_000) });
    assert.strictEqual(huge.ok, false);
    assert.strictEqual(huge.kind, 'permanent');
    assert.match(huge.error, /the limit is/);
    assert.strictEqual(google.seen.sendRequests.length, 0);
  } finally { restore(); await google.close(); }
});

test('user-written text is escaped in the HTML part', () => {
  /* THE REMINDERS AND NOTICES ARE BUILT FROM TYPED TEXT — an asset name,
     somebody's own name, a feedback note. The escaping belongs to whoever builds
     the body; this asserts the helper both builders use, and that the existing
     one in email-notifications.js is the same shape. */
  const outbox = require('../src/email-outbox');
  const nasty = '<script>alert(1)</script> & "Priyā" \'quoted\'';
  const escaped = outbox.escapeHtml(nasty);
  assert.ok(!escaped.includes('<script>'), escaped);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(escaped, /&amp;/);
  assert.match(escaped, /&quot;/);
  assert.match(escaped, /&#39;/);
  assert.ok(escaped.includes('Priyā'), 'and the accent survives — this is escaping, not stripping');

  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'email-notifications.js'), 'utf8');
  assert.match(src, /const escapeHtml = \(v\) => String\(v \?\? ''\)\.replace\(\/\[&<>"'\]\/g/,
    'the notification builder escapes the same five characters');
});

// ===========================================================================
// 3. THE QUEUE: each answer feeding the existing counter correctly.
// ===========================================================================

/* The real modules against the real schema, with the fake Google on the wire.
 *
 * A db handle over the suite's own sql() helper rather than src/db.js, for the
 * reason tests/role-groups.test.js records: that module builds a connection POOL
 * at require time and the pool outlives the test, so node --test waits for an
 * event loop that never drains. */
function dbFor(c) {
  return {
    query: async (statement, params = []) => {
      const order = [];
      const text = statement.replace(/\$(\d+)/g, (m, n) => { order.push(Number(n)); return '?'; });
      const rows = await sql(c, text, order.map((n) => params[n - 1]));
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };
}

test('the queue, against a fake Google', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  let google;
  let base;
  let restore = () => {};
  const db = dbFor(cfg);
  const outbox = require('../src/email-outbox');

  const queue = () => sql(cfg,
    'SELECT id, kind, recipient, subject, `status`, attempts, last_error, next_attempt_at, sent_id '
    + 'FROM email_outbox ORDER BY seq');
  const one = async () => (await queue())[0];
  const clear = () => sql(cfg, 'DELETE FROM email_outbox');
  const reset = () => sql(cfg,
    'UPDATE email_transport_state SET healthy = 1, reason = NULL, unhealthy_since = NULL, '
    + 'alerted_at = NULL, cap_alerted_on = NULL WHERE id = 1');
  /* due NOW, so a backoff does not have to be waited out to drive the next
     attempt. The attempt COUNT is what the policy turns on, and that is never
     touched here — only the clock. */
  const makeDue = () => sql(cfg, 'UPDATE email_outbox SET next_attempt_at = NOW() - INTERVAL 1 SECOND');

  t.before(async () => {
    await resetSchema(cfg);
    /* A real server once, to run the migration and make the Super Admin whose
       in-app notices the alert path writes. Then everything is driven in
       process, so a case can assert on one pass of the queue. */
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'gm', EMAIL_SWEEP_MS: '0' });
    await require('./helpers').api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'gm', name: 'Root', email: 'root@gm.test', password: 'GmailQueue-1!' } });
    google = fakeGoogle();
    base = await google.listen();
    restore = withGmail(base);
  });
  t.after(async () => { restore(); if (google) await google.close(); stopServer(server); });

  await t.test('a send goes out and the row records it', async () => {
    await clear(); await reset();
    await outbox.enqueue(db, { to: 'priya@zvky.com', subject: 'Assigned', text: 'x', html: '<p>x</p>' });
    const out = await outbox.drain(db);
    assert.strictEqual(out.sent, 1, JSON.stringify(out));
    const row = await one();
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.attempts, 1);
    assert.strictEqual(row.sent_id, 'gmail-1', 'Gmail\'s own id is kept');
    const stats = await outbox.stats(db);
    assert.strictEqual(stats.sentToday, 1);
    assert.strictEqual(stats.pending, 0);
    assert.ok(stats.lastSuccessAt, 'and the last success is recorded');
  });

  await t.test('a temporary error retries six times, then fails', async () => {
    await clear(); await reset();
    google.onSend(() => ({ status: 503, body: { error: { message: 'Backend Error' } } }));
    await outbox.enqueue(db, { to: 'priya@zvky.com', subject: 'Flaky', text: 'x' });

    /* SEVEN ATTEMPTS IN ALL — the first plus the six the schedule allows, which
       is the policy src/integration-outbox.js has always used and which this
       queue imports rather than restates. */
    for (let attempt = 1; attempt <= outbox.MAX_ATTEMPTS; attempt += 1) {
      await makeDue();
      const out = await outbox.drain(db);
      const row = await one();
      assert.strictEqual(row.attempts, attempt, `attempt ${attempt} was not counted`);
      if (attempt < outbox.MAX_ATTEMPTS) {
        assert.strictEqual(row.status, 'pending', `still pending after ${attempt}`);
        assert.strictEqual(out.temporary, 1);
        assert.ok(row.next_attempt_at, 'and a backoff is set');
      } else {
        assert.strictEqual(row.status, 'failed', 'out of attempts on the seventh');
        assert.match(row.last_error, /Out of attempts after 7/);
      }
    }
    assert.strictEqual(outbox.BACKOFF_SECONDS.length, 6, 'six retries, as the studio has always had');
  });

  await t.test('a 429 honours Retry-After when it is longer than the backoff', async () => {
    await clear(); await reset();
    google.onSend(() => ({ status: 429, headers: { 'Retry-After': '600' },
      body: { error: { message: 'Too many requests' } } }));
    await outbox.enqueue(db, { to: 'priya@zvky.com', subject: 'Slow down', text: 'x' });
    await outbox.drain(db);
    const [{ wait }] = await sql(cfg,
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), next_attempt_at) AS wait FROM email_outbox LIMIT 1');
    /* The first backoff is 60 seconds and Google asked for 600; the longer of
       the two wins, because overruling a rate limit is how the next answer
       becomes a block. */
    assert.ok(Number(wait) > 500, `Retry-After was ignored: ${wait}s`);
  });

  await t.test('a bad recipient fails at once, without burning six attempts', async () => {
    await clear(); await reset();
    google.onSend(() => ({ status: 200, body: { id: 'should-not-happen' } }));
    await outbox.enqueue(db, { to: 'not-an-address', subject: 'Nowhere', text: 'x' });
    const out = await outbox.drain(db);
    assert.strictEqual(out.permanent, 1, JSON.stringify(out));
    const row = await one();
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.attempts, 1, 'one attempt, not seven');

    /* AND A SUPER ADMIN WAS TOLD — in-app, and queued as mail. */
    const [{ n }] = await sql(cfg,
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'email_trouble'");
    assert.ok(Number(n) >= 1, 'the Super Admin has an in-app notice');
    const alerts = (await queue()).filter((r) => r.kind === 'alert');
    assert.strictEqual(alerts.length, 1, 'and the email alert is queued');
  });

  await t.test('invalid_grant pauses the queue and consumes no attempts', async () => {
    await clear(); await reset();
    google.onSend(() => ({ status: 200, body: { id: 'never' } }));
    google.onToken(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    require('../src/gmail-transport')._reset();

    for (let i = 0; i < 3; i += 1) {
      await outbox.enqueue(db, { to: `artist${i}@zvky.com`, subject: 'Held', text: 'x' });
    }
    const out = await outbox.drain(db);
    assert.strictEqual(out.paused, true, JSON.stringify(out));
    assert.strictEqual(out.sent, 0);

    const rows = await queue();
    for (const row of rows.filter((r) => r.kind === 'notification')) {
      assert.strictEqual(row.status, 'pending', 'still queued');
      assert.strictEqual(row.attempts, 0,
        'AND NO ATTEMPT CONSUMED — the connection is not the message\'s fault');
      assert.strictEqual(row.last_error, null, 'and no error written against it');
    }
    const st = await outbox.state(db);
    assert.strictEqual(Number(st.healthy), 0, 'the transport is marked unhealthy');
    assert.match(st.reason, /re-authorised/);

    /* ONE ALERT PER OUTAGE, not one per pass. */
    const before = Number((await sql(cfg,
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'email_trouble'"))[0].n);
    await outbox.drain(db);
    await outbox.drain(db);
    const after = Number((await sql(cfg,
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'email_trouble'"))[0].n);
    assert.strictEqual(after, before, 'three passes, one notice');

    /* THE ALERT DID NOT GO THROUGH THE DEAD TRANSPORT. Had it been queued as
       mail while the transport was down, it would sit there as an `alert` row —
       and worse, a failed alert would alert about itself. */
    assert.strictEqual((await queue()).filter((r) => r.kind === 'alert').length, 0,
      'the connection alert is in-app only while the transport is down');

    /* AND IT RESUMES BY ITSELF when Google answers again — no button pressed. */
    google.onToken(() => ({ status: 200, body: { access_token: 'at-ok', expires_in: 3600 } }));
    google.onSend(() => ({ status: 200, body: { id: 'gmail-after' } }));
    const back = await outbox.drain(db);
    /* COUNTED BY KIND, because the resume itself queues a notice and that
       notice becomes due in the same pass — so the total is four and the three
       that matter are the held notifications. */
    const sentNotifications = (await queue())
      .filter((r) => r.kind === 'notification' && r.status === 'sent').length;
    assert.strictEqual(sentNotifications, 3, `the held messages went out: ${JSON.stringify(back)}`);
    assert.ok(back.sent >= 3);
    assert.strictEqual(Number((await outbox.state(db)).healthy), 1);
    const resumed = (await queue()).filter((r) => r.kind === 'alert');
    assert.ok(resumed.length >= 1, 'and the recovery notice is queued as mail now there is a transport');
  });

  await t.test('the permanent-failure alert falls back to in-app, and is sent later', async () => {
    await clear(); await reset();
    /* A transport that is down AND a message that is permanently wrong. The
       alert must not be queued into a dead transport and must not loop. */
    google.onToken(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    require('../src/gmail-transport')._reset();
    await outbox.enqueue(db, { to: 'priya@zvky.com', subject: 'Queued while down', text: 'x' });
    await outbox.drain(db);
    assert.strictEqual(Number((await outbox.state(db)).healthy), 0);
    const noticesWhileDown = Number((await sql(cfg,
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'email_trouble'"))[0].n);
    assert.ok(noticesWhileDown >= 1, 'the in-app notice is the whole alert while the transport is down');

    google.onToken(() => ({ status: 200, body: { access_token: 'at-ok', expires_in: 3600 } }));
    google.onSend(() => ({ status: 200, body: { id: 'gmail-later' } }));
    const back = await outbox.drain(db);
    assert.ok(back.sent >= 1, 'and the held message goes when the connection returns');
  });

  await t.test('throttling: a pass sends at most the per-minute allowance', async () => {
    await clear(); await reset();
    google.onToken(() => ({ status: 200, body: { access_token: 'at-ok', expires_in: 3600 } }));
    google.onSend(() => ({ status: 200, body: { id: 'gmail-throttle' } }));
    require('../src/gmail-transport')._reset();

    const burst = withGmail(base, { EMAIL_MAX_PER_MINUTE: '3' });
    try {
      for (let i = 0; i < 10; i += 1) {
        await outbox.enqueue(db, { to: `artist${i}@zvky.com`, subject: 'Morning', text: 'x' });
      }
      const first = await outbox.drain(db);
      assert.strictEqual(first.sent, 3, `three in a pass, not ten: ${JSON.stringify(first)}`);
      const second = await outbox.drain(db);
      assert.strictEqual(second.sent, 3, 'and three more in the next');
      const left = (await queue()).filter((r) => r.status === 'pending').length;
      assert.strictEqual(left, 4, 'the rest are still waiting, spread rather than burst');
    } finally { burst(); }
  });

  await t.test('the daily cap stops sending, and 80% of it alerts once', async () => {
    await clear(); await reset();
    const capped = withGmail(base, { EMAIL_DAILY_CAP: '5', EMAIL_MAX_PER_MINUTE: '10' });
    try {
      for (let i = 0; i < 8; i += 1) {
        await outbox.enqueue(db, { to: `artist${i}@zvky.com`, subject: 'Capped', text: 'x' });
      }
      const out = await outbox.drain(db);
      assert.strictEqual(out.sent, 5, `the cap held at five: ${JSON.stringify(out)}`);
      const again = await outbox.drain(db);
      assert.strictEqual(again.sent, 0);
      assert.strictEqual(again.capped, true, 'and it says it is capped rather than failing them');
      assert.strictEqual((await queue()).filter((r) => r.status === 'pending' && r.kind === 'notification').length,
        3, 'the rest are held, not failed');

      /* THE 80% NOTICE. Four of five is the line; it fires once a day, so a
         second pass over the same day adds nothing. */
      const alerts = (await queue()).filter((r) => /of today's 5 sends used/.test(r.subject || ''));
      assert.strictEqual(alerts.length, 1, `one cap warning: ${alerts.map((a) => a.subject)}`);
      const [{ stamped }] = await sql(cfg,
        'SELECT cap_alerted_on AS stamped FROM email_transport_state WHERE id = 1');
      assert.ok(stamped, 'and the day it was sent is recorded, so tomorrow gets its own');
    } finally { capped(); }
  });
});

// ===========================================================================
// 4. THE CALLERS, THE SCREEN, AND THE SECRETS — against a live server.
// ===========================================================================

test('the features that send mail, and the screen that watches it',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const { api } = require('./helpers');
  const PASSWORD = 'GmailLive-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const queued = () => sql(cfg,
    'SELECT kind, recipient, subject, `status` FROM email_outbox ORDER BY seq');

  t.before(async () => {
    await resetSchema(cfg);
    /* EMAIL_TRANSPORT=log, which is what the whole suite runs on: no network,
       no credential, and the queue still exercised end to end. EMAIL_BATCH_MS=0
       so the assignment batching window does not have to be waited out. */
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'gl', EMAIL_TRANSPORT: 'log', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'gl', name: 'Root', email: 'root@gl.test', password: PASSWORD } });
    tok.root = await login('root@gl.test');
    /* The master switch, because every notification path checks it. */
    const saved = await as('root', '/email-config', { method: 'PUT',
      body: { enabled: true, host: 'smtp.example.com', port: 587, encryption: 'tls',
        username: 'sales@zvky.com', password: 'not-a-real-password',
        fromName: 'ZVKY FORGE', fromAddress: 'sales@zvky.com' } });
    assert.ok(saved.status < 400, JSON.stringify(saved.body));

    const mk = async (who, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@gl.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[who] = r.body.user.id;
      tok[who] = await login(`${who}@gl.test`);
    };
    await mk('lead', 'team_lead');
    await mk('ana', 'game_artist');
    const clients = await as('root', '/clients');
    const pr = await as('root', '/projects', { method: 'POST',
      body: { name: 'Mailed', clientId: clients.body.clients[0].id } });
    id.project = pr.body.project.id;
  });
  t.after(() => stopServer(server));

  await t.test('CALLERS UNCHANGED: an assignment queues the same email it always built', async () => {
    await sql(cfg, 'DELETE FROM email_outbox');
    const asset = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Hero Prop', type: 'prop', assigneeId: id.ana } });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    /* The batching window is 0 in this server, but the flush is still a tick
       away — the route answers before the email is built, which is the promise
       src/email-notifications.js has always made. */
    await new Promise((r) => setTimeout(r, 400));

    const rows = await queued();
    assert.strictEqual(rows.length, 1, `one queued email: ${JSON.stringify(rows)}`);
    assert.strictEqual(rows[0].recipient, 'ana@gl.test', 'to the assignee');
    assert.strictEqual(rows[0].kind, 'notification');
    /* THE SUBJECT IS THE ONE THAT MODULE ALWAYS BUILT. This is the "callers
       unchanged" assertion: the message content and the opt-out logic were not
       touched, only where the message goes next. */
    assert.match(rows[0].subject, /assigned/i, rows[0].subject);
    assert.strictEqual(rows[0].status, 'pending', 'queued rather than sent inside the request');
    id.asset = asset.body.asset.id;
  });

  await t.test('and the queue delivers it through the chosen transport', async () => {
    const outbox = require('../src/email-outbox');
    const db = dbFor(cfg);
    /* THE TRANSPORT IS PER PROCESS, which is correct — each worker reads its own
       environment — and this drain runs in the TEST process, not the server's.
       So the choice has to be made here too; without it the pass picks the
       default (smtp), finds no saved config in this process and pauses. */
    const before = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = 'log';
    const out = await outbox.drain(db).finally(() => {
      if (before === undefined) delete process.env.EMAIL_TRANSPORT;
      else process.env.EMAIL_TRANSPORT = before;
    });
    assert.ok(out.sent >= 1, JSON.stringify(out));
    const rows = await queued();
    assert.ok(rows.every((r) => r.status === 'sent'), JSON.stringify(rows));
  });

  await t.test('a submission queues its notice too, unchanged', async () => {
    await sql(cfg, 'DELETE FROM email_outbox');
    await as('ana', `/assets/${id.asset}/start`, { method: 'POST' });
    const submitted = await as('ana', `/assets/${id.asset}/submit`, { method: 'POST',
      body: { link: 'https://example.test/v1' } });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    await new Promise((r) => setTimeout(r, 400));
    const rows = await queued();
    assert.ok(rows.length >= 1, 'the submission notice is queued');
    assert.ok(rows.some((r) => /submitted|review/i.test(r.subject || '')),
      JSON.stringify(rows.map((r) => r.subject)));
  });

  await t.test('the status endpoint returns no secret of any kind', async () => {
    const res = await as('root', '/email-delivery');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const body = JSON.stringify(res.body);

    /* EVERY SECRET THIS SERVER HOLDS, checked against the response by value.
       The SMTP password was saved in t.before, so it is a real one. */
    for (const secret of ['not-a-real-password', process.env.JWT_SECRET,
      'client-secret-for-tests', 'refresh-token-for-tests']) {
      if (!secret) continue;
      assert.ok(!body.includes(secret), `the response contains a secret: ${secret.slice(0, 6)}…`);
    }
    /* AND NO FIELD THAT LOOKS LIKE ONE. A future addition called
       `refreshToken: null` would pass the check above and fail this one. */
    for (const key of ['secret', 'refresh', 'password', 'token', 'bearer']) {
      const found = Object.keys(res.body).filter((k) => k.toLowerCase().includes(key));
      assert.deepStrictEqual(found, [], `the status payload has a ${key} field: ${found}`);
    }
    /* What it DOES say is useful: the transport, the queue, the cap. */
    assert.strictEqual(res.body.transport, 'log');
    assert.strictEqual(typeof res.body.queue.pending, 'number');
    assert.strictEqual(res.body.queue.dailyCap, 300, 'the conservative default');
    assert.strictEqual(res.body.queue.perMinute, 10);
    assert.strictEqual(res.body.queue.warnAt, 240, '80% of the cap');
    assert.match(res.body.scope, /gmail\.send$/, 'and the one scope it asked Google for');
  });

  await t.test('the test button sends to the caller and reports the real result', async () => {
    const res = await as('root', '/email-delivery/test', { method: 'POST' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.to, 'root@gl.test', 'to themselves, never to a chosen address');
    assert.match(res.body.summary, /Sent to root@gl\.test/);

    /* AND THE REAL ERROR WHEN IT FAILS. Pointed at a fake Google that refuses
       the credential, through a server started with the Gmail transport. */
    const broken = fakeGoogle();
    const base = await broken.listen();
    broken.onToken(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const gmailServer = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'gl2', EMAIL_SWEEP_MS: '0', EMAIL_TRANSPORT: 'gmail_api',
      GMAIL_TOKEN_URL: `${base}/token`, GMAIL_SEND_URL: `${base}/send`,
      GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csecret',
      GMAIL_REFRESH_TOKEN: 'rtoken', GMAIL_SENDER: 'sales@zvky.com',
    });
    try {
      const token = (await api(gmailServer.base, '/auth/login', { method: 'POST',
        body: { email: 'root@gl.test', password: PASSWORD } })).body.token;
      const failed = await api(gmailServer.base, '/email-delivery/test', { method: 'POST', token });
      assert.strictEqual(failed.status, 502, JSON.stringify(failed.body));
      assert.strictEqual(failed.body.kind, 'reauthorise');
      assert.match(failed.body.error, /re-authorised/, 'the real reason, not "check your settings"');
      assert.ok(!failed.body.error.includes('rtoken'), 'with the credential masked');

      /* AND THE SCREEN NOW SAYS SO. */
      const status = await api(gmailServer.base, '/email-delivery', { token });
      assert.strictEqual(status.body.connection.state, 'needs_reauthorisation');
      assert.strictEqual(status.body.queue.healthy, false);
      assert.strictEqual(status.body.sender.address, 'sales@zvky.com', 'the sender is read-only');
    } finally { stopServer(gmailServer); await broken.close(); }
  });

  await t.test('403 without the key, and success on the same token after a grant', async () => {
    for (const path of ['/email-delivery', '/email-delivery/test']) {
      const method = path.endsWith('test') ? 'POST' : 'GET';
      assert.strictEqual((await as('lead', path, { method })).status, 403, `${path} is gated`);
    }
    const held = (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    const grant = await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: [...held, 'settings.email_delivery'] } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));

    /* THE SAME TOKEN — no sign-out. authenticate() resolves permissions per
       request, which is what every other permission in this application does. */
    const now = await as('lead', '/email-delivery');
    assert.strictEqual(now.status, 200, 'the grant reaches the session already signed in');
    assert.strictEqual(now.body.transport, 'log');

    await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
    assert.strictEqual((await as('lead', '/email-delivery')).status, 403, 'and it is taken back');
  });

  await t.test('no secret is written to the log', async () => {
    /* THE SERVER'S OWN OUTPUT, read back. The log transport prints a recipient
       and a subject deliberately and a body never; nothing anywhere prints a
       credential. */
    const output = server.output();
    for (const secret of ['not-a-real-password', 'refresh-token-for-tests', 'client-secret-for-tests']) {
      assert.ok(!output.includes(secret), `a secret reached the log: ${secret.slice(0, 6)}…`);
    }
    assert.ok(!/Bearer [A-Za-z0-9._-]{10,}/.test(output), 'no bearer token in the log');
  });
});

// ===========================================================================
// 5. SECRETS STAY OUT OF GIT.
// ===========================================================================

test('.env is not tracked, and .env.example carries no value', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => /(^|\/)\.env($|\.)/.test(f));
  assert.deepStrictEqual(tracked, ['.env.example'],
    `only the template may be tracked, found: ${tracked.join(', ')}`);

  /* AND IT IS IGNORED, so the next person to create one locally cannot commit
     it by accident — which is how the one in this repository's history got
     there. */
  const ignored = execFileSync('git', ['check-ignore', '.env'],
    { cwd: root, encoding: 'utf8' }).trim();
  assert.strictEqual(ignored, '.env');

  /* THE TEMPLATE HAS NAMES AND NO VALUES for everything that is a credential.
     JWT_SECRET's placeholder is deliberately a sentence that the application
     refuses to start with — see src/config-check.js — so it is excluded by
     name rather than by accident. */
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const name of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) {
    assert.match(example, new RegExp(`^# ${name}=$`, 'm'),
      `${name} must be present, commented, and empty in .env.example`);
  }
  /* AND NONE OF THE THREE CREDENTIALS CARRIES A VALUE anywhere in the file,
     commented or not. Named explicitly rather than matched by a GMAIL_ prefix:
     GMAIL_SENDER_NAME legitimately has a default, and the instructions above
     show `export GMAIL_CLIENT_ID=...` as prose. A blanket pattern flagged both
     and said nothing about the three that matter. */
  for (const name of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) {
    const carrying = example.split('\n')
      .filter((line) => new RegExp(`^#?\\s*${name}=.`).test(line.trim()));
    assert.deepStrictEqual(carrying, [],
      `${name} has a value in .env.example: ${carrying.join(' | ')}`);
  }
});
