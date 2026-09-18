/* One tick, two grey, two blue.
 *
 * WHAT EACH ONE IS EVIDENCE OF, because the words are looser than the marks:
 *
 *   sent       the row exists. Nothing is stored for it.
 *   delivered  a request of THEIRS returned the message. There is no socket
 *              here — chat is a poll — so "it reached their client" is exactly
 *              "they asked and were given it", which is the poll and the
 *              conversation fetch.
 *   read       they had the thread open and in front of them. The page refuses
 *              to claim this from a hidden tab, which is the whole difference
 *              between it and delivered.
 *
 * FOUR THINGS THIS FILE EXISTS TO STOP:
 *
 *   A group going blue early. The aggregate is an AND across members, and an
 *      off-by-one in the comparison would turn "one of six has read it" into
 *      "everybody has".
 *
 *   Somebody who LEFT holding the tick grey for ever. The counts are joined to
 *      current membership, so a person who is gone stops being waited on.
 *
 *   A reader learning who else has read what. The breakdown is the sender's,
 *      and nobody else's.
 *
 *   Any of this costing somebody a message. Every write is after the response
 *      and swallows its own failure — a status table that is missing or slow
 *      must cost a tick, never a message.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

const cfg = config('chatstatus');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chat.js'), 'utf8');
const MODULE = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-status.js'), 'utf8');

// --- the marks, and what they are counted from --------------------------------

test('the page draws one tick, two grey and two blue, and nothing else', () => {
  const fn = PAGE.match(/function chatTickHTML\(message\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'public/index.html has no chatTickHTML');
  assert.match(fn[1], /mark\.status === 'sent' \? '&#10003;' : '&#10003;&#10003;'/,
    'one check for sent, two for anything past it');
  assert.match(PAGE, /\.chat-tick\.read\{color:#3aa3ff;\}/, 'and read is blue');
  assert.match(PAGE, /\.chat-tick\.delivered\{color:var\(--ink-muted\);\}/, 'delivered is grey');
});

test('a tick is only ever drawn on your own message', () => {
  const fn = PAGE.match(/function chatTickHTML\(message\)\{([\s\S]*?)\n\}/);
  assert.match(fn[1], /const mine = message\.senderId === \(state\.currentUser\|\|\{\}\)\.id;\s*\n\s*if\(!mine/,
    'a tick on somebody else\'s message would be telling you about your own reading');
});

test('the aggregate is an AND across the audience, counted from current members', () => {
  assert.match(MODULE, /JOIN chat_members cm ON cm\.conversation_id = \$1 AND cm\.user_id = s\.user_id/,
    'the join to current membership is what stops a departed member holding it grey');
  assert.match(MODULE, /if \(audience > 0 && read >= audience\) status = 'read';/);
  assert.match(MODULE, /else if \(audience > 0 && delivered >= audience\) status = 'delivered';/);
  assert.match(MODULE, /const audience = Math\.max\(0, members - 1\);/,
    'everybody but the sender');
});

test('read is claimed only from a thread somebody is actually looking at', () => {
  const fn = PAGE.match(/async function markChatRead\(\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /if\(document\.hidden\) return;/,
    'a tab behind another window is delivered to, and reads nothing');
  assert.match(fn[1], /chatState\.view !== 'thread'/, 'and the thread has to be the one on screen');
});

test('nothing about the status can fail a send or a poll', () => {
  /* Every call site is after the response has been decided, and catches. A
     status write in front of res.json() would put a tick on the critical path
     of a message, which is the one thing the brief said not to do. */
  for (const call of ROUTE.match(/status\.mark\w+\(db, \{[\s\S]*?\}\)[\s\S]*?;/g) || []) {
    assert.match(call, /\.catch\(/, `an unguarded status write: ${call.slice(0, 120)}`);
  }
  const poll = ROUTE.match(/router\.get\('\/poll'[\s\S]*?\n\}\);/);
  assert.ok(poll);
  assert.ok(poll[0].indexOf('res.json(') < poll[0].indexOf('status.markDelivered'),
    'the poll must answer before it records anything');
  assert.match(MODULE, /console\.warn\(`\[chat status\]/, 'and a failure says so rather than throwing');
});

test('the per-message rows are bounded by a watermark', () => {
  /* Without one, every poll would rewrite a row for every message anybody had
     ever been sent. The gap between the watermark and where they have now got
     to is what is written, which is one row for the ordinary case. */
  assert.match(MODULE, /m\.seq > \$3 AND m\.seq <= \$4/, 'only the gap');
  assert.match(MODULE, /UPDATE chat_members SET last_delivered_seq/, 'and the watermark moves after it');
  assert.match(MODULE, /COALESCE\(chat_message_status\.delivered_at, VALUES\(delivered_at\)\)/,
    'the FIRST stamp is the true one — polling again must not move a delivery forward');
});

// --- against a live server -----------------------------------------------------

test('ticks, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Ticks-Test-1!';
  let server;
  const tok = {};
  const id = {};
  const cursor = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  const say = async (who, conv, body) => {
    const r = await as(who, `/chat/${conv}/messages`, { method: 'POST', body: { body } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.message;
  };
  /* A client holds a cursor and polls from it. Asking since=0 would return the
     OLDEST fifty messages, which is not what a browser does and would mark the
     wrong things delivered. */
  const signOn = async (who) => { cursor[who] = (await as(who, '/chat/poll')).body.cursor; };
  const comeOnline = async (who) => {
    const r = await as(who, `/chat/poll?since=${cursor[who] || 0}`);
    cursor[who] = r.body.cursor;
    await settle();
  };
  const openThread = async (who, conv) => {
    const r = await as(who, `/chat/${conv}/messages`);
    const last = (r.body.messages || []).slice(-1)[0];
    if (last) await as(who, `/chat/${conv}/read`, { method: 'POST', body: { seq: last.seq } });
    await settle();
  };
  /* The poll and the read both answer BEFORE recording, on purpose. In use the
     sender's next poll is many seconds later; a test asking immediately has to
     wait for the write it just triggered. */
  const settle = () => new Promise((r) => setTimeout(r, 250));
  const statusOf = async (who, conv, messageId) => {
    const r = await as(who, `/chat/${conv}/status?since=0`);
    return (r.body.statuses || {})[messageId];
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    id.root = (await as('root', '/auth/me')).body.user.id;

    for (const [key, name, email] of [
      ['ana', 'Ana Artist', 'ana@zvky.test'],
      ['bo', 'Bo Chen', 'bo@zvky.test'],
      ['cy', 'Cy Dean', 'cy@zvky.test'],
    ]) {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role: 'game_artist', password: PASSWORD },
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      tok[key] = await login(email);
      await signOn(key);
    }
  });

  t.after(() => stopServer(server));

  await t.test('ONE-TO-ONE: sent, then delivered, then read', async () => {
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.ana } });
    const conv = d.body.conversationId;
    const m = await say('root', conv, 'are you free this afternoon?');

    let st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.status, 'sent', 'nothing has fetched it yet');
    assert.strictEqual(st.audience, 1, 'one person to reach');

    await comeOnline('ana');
    st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.status, 'delivered', 'their client polled and was handed it');

    await openThread('ana', conv);
    st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.status, 'read', 'and they opened the thread');
  });

  await t.test('somebody offline stays on one tick until their own next poll', async () => {
    /* The second edge case in the brief: nothing is asked of the sender. */
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.bo } });
    const conv = d.body.conversationId;
    const m = await say('root', conv, 'sent while you were away');

    assert.strictEqual((await statusOf('root', conv, m.id)).status, 'sent');
    assert.strictEqual((await statusOf('root', conv, m.id)).status, 'sent',
      'and asking twice does not move it — only their client can');

    await comeOnline('bo');
    assert.strictEqual((await statusOf('root', conv, m.id)).status, 'delivered');
  });

  await t.test('GROUP: grey on the last delivery, blue on the last read', async () => {
    const g = await as('root', '/chat/groups', {
      method: 'POST', body: { title: 'Neon Drift', memberIds: [id.ana, id.bo, id.cy] },
    });
    const conv = g.body.conversationId;
    const m = await say('root', conv, 'status by four please');

    let st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.audience, 3);
    assert.strictEqual(st.status, 'sent');

    await comeOnline('ana');
    st = await statusOf('root', conv, m.id);
    assert.deepStrictEqual([st.status, st.delivered], ['sent', 1], 'one of three is not delivered');

    await comeOnline('bo');
    st = await statusOf('root', conv, m.id);
    assert.deepStrictEqual([st.status, st.delivered], ['sent', 2], 'nor is two of three');

    await comeOnline('cy');
    st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.status, 'delivered', 'the third is what turns it grey');

    await openThread('ana', conv);
    await openThread('bo', conv);
    st = await statusOf('root', conv, m.id);
    assert.deepStrictEqual([st.status, st.read], ['delivered', 2], 'two of three read is still grey');

    await openThread('cy', conv);
    st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.status, 'read', 'blue only on the last one');
  });

  await t.test('the breakdown names each member and when', async () => {
    const g = await as('root', '/chat/groups', {
      method: 'POST', body: { title: 'Breakdown', memberIds: [id.ana, id.bo] },
    });
    const conv = g.body.conversationId;
    const m = await say('root', conv, 'who has seen this');
    await comeOnline('ana');
    await comeOnline('bo');
    await openThread('ana', conv);

    const info = await as('root', `/chat/${conv}/messages/${m.id}/info`);
    assert.strictEqual(info.status, 200, JSON.stringify(info.body));
    assert.strictEqual(info.body.people.length, 2);
    const byName = new Map(info.body.people.map((p) => [p.name, p]));
    assert.ok(byName.get('Ana Artist').readAt, 'Ana read it');
    assert.ok(byName.get('Bo Chen').deliveredAt, 'Bo was delivered it');
    assert.strictEqual(byName.get('Bo Chen').readAt, null, 'and has not read it — which is the question this answers');
    assert.strictEqual(info.body.status.status, 'delivered');
  });

  await t.test('and it is the sender\'s to see, nobody else\'s', async () => {
    const g = await as('root', '/chat/groups', {
      method: 'POST', body: { title: 'Private', memberIds: [id.ana, id.bo] },
    });
    const conv = g.body.conversationId;
    const m = await say('root', conv, 'mine');
    const nosy = await as('ana', `/chat/${conv}/messages/${m.id}/info`);
    assert.strictEqual(nosy.status, 403,
      'who else has read a message is not a thing a reader gets to ask');
  });

  await t.test('THE EDGE CASE: somebody who leaves stops being waited on', async () => {
    const g = await as('root', '/chat/groups', {
      method: 'POST', body: { title: 'Departures', memberIds: [id.ana, id.bo, id.cy] },
    });
    const conv = g.body.conversationId;
    const m = await say('root', conv, 'before anybody goes');

    for (const who of ['ana', 'bo', 'cy']) await comeOnline(who);
    await openThread('ana', conv);
    await openThread('bo', conv);
    let st = await statusOf('root', conv, m.id);
    assert.deepStrictEqual([st.status, st.read, st.audience], ['delivered', 2, 3], 'waiting on Cy');

    const gone = await as('root', `/chat/${conv}/members/${id.cy}`, { method: 'DELETE' });
    assert.ok(gone.status < 400, JSON.stringify(gone.body));

    st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.audience, 2, 'the audience is recalculated from who is there now');
    assert.strictEqual(st.status, 'read',
      'and the message goes blue rather than waiting for ever on somebody who left');

    const info = await as('root', `/chat/${conv}/messages/${m.id}/info`);
    assert.deepStrictEqual(info.body.people.map((p) => p.name).sort(), ['Ana Artist', 'Bo Chen'],
      'the breakdown lists current members only');
  });

  await t.test('a message carries its tick when the thread is fetched', async () => {
    /* So the first frame of an opened conversation is right, rather than
       showing one tick on everything and correcting itself a poll later. */
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.ana } });
    const conv = d.body.conversationId;
    await say('root', conv, 'and this one');
    await comeOnline('ana');

    const page = await as('root', `/chat/${conv}/messages`);
    const mine = page.body.messages.filter((m) => m.senderId === id.root);
    assert.ok(mine.length && mine.every((m) => m.status), 'my own messages arrive with a status');
    const theirs = await as('ana', `/chat/${conv}/messages`);
    const notMine = theirs.body.messages.filter((m) => m.senderId !== id.ana);
    assert.ok(notMine.every((m) => !m.status),
      'and a reader gets no status on somebody else\'s message');
  });

  await t.test('your own message is never delivered to you', async () => {
    /* Counting the sender would make a one-to-one need two deliveries to go
       grey, and a group of two need three. */
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.ana } });
    const conv = d.body.conversationId;
    const m = await say('root', conv, 'to myself as much as anybody');
    await openThread('root', conv);          // the sender opens their own thread
    const st = await statusOf('root', conv, m.id);
    assert.strictEqual(st.delivered, 0, 'the sender does not count towards delivery');
    assert.strictEqual(st.status, 'sent');
  });

  await t.test('sending is unchanged', async () => {
    /* Pure UI: the same 201 with the same shape, and the mention and
       attachment paths built before it still answer the same way. */
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.bo } });
    const conv = d.body.conversationId;
    const before = Date.now();
    const r = await as('root', `/chat/${conv}/messages`, {
      method: 'POST', body: { body: `hello @[Bo Chen](${id.bo})` },
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.message.id && r.body.message.seq, 'the message shape is unchanged');
    assert.ok(Array.isArray(r.body.message.attachments), 'attachments still come back');
    assert.ok(Date.now() - before < 3000, 'and the status writes do not sit in front of it');

    const bell = await as('bo', '/notifications?limit=3');
    assert.ok(bell.body.notifications.some((n) => n.kind === 'mention'),
      'the mention notification built before this still fires');
  });
});
