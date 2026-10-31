/* REPLIES, THE EMOJI STORAGE, AND THE TWO SWITCHES.
 *
 * THE QUOTE IS THE PART WORTH BEING CAREFUL ABOUT. It is rendered live from
 * the message it points at, every time anybody reads the thread — not copied
 * when the reply is sent. That is what makes a deleted original show as deleted
 * rather than going on quoting itself, and it is the reason the conversation
 * check at send time matters: without it, a reply would be a way to pull a line
 * of somebody else's conversation into one you are in.
 *
 * AND THE EMOJI HALF IS A ROUND TRIP, not an inspection. What matters is not
 * what information_schema says about the column but whether a family emoji
 * comes back out as the same family emoji — which is the one question a
 * charset test can answer that reading the DDL cannot.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const chat = require('../src/chat');

const cfg = config('chatreply');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Chat-Replies-11!';

/* The six shapes the brief names, plus a mixed multi-line one. Each is a
   different way for a charset or a length count to go wrong:
     plain        one code point outside the BMP — a surrogate pair
     ZWJ family   seven code points joined into one picture
     skin tone    a base plus a modifier
     flag         two regional indicators
     keycap       a digit, a variation selector and a combining keycap
     multi-line   all of it, with newlines, around ordinary words */
const SAMPLES = {
  plain: '\u{1F600}',
  family: '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
  skinTone: '\u{1F44B}\u{1F3FD}',
  flag: '\u{1F1EE}\u{1F1F3}',
  keycap: '1️⃣',
  mixed: 'morning \u{1F600}\nthe family \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} says hello\n'
    + 'flag \u{1F1EE}\u{1F1F3} keycap 1️⃣ wave \u{1F44B}\u{1F3FD}',
};

test('the length limit counts code points, and refuses rather than truncating', () => {
  /* .length COUNTS UTF-16 UNITS, which is what the old rule used: every emoji
     outside the basic plane is two of them and a family emoji is eleven. A
     limit counted that way cuts a surrogate pair in half, and a lone surrogate
     is not valid UTF-8 at all. */
  assert.strictEqual(chat.codePoints(SAMPLES.plain), 1, 'a plain emoji is one character');
  assert.strictEqual(SAMPLES.plain.length, 2, 'but two UTF-16 units — which is the trap');
  assert.strictEqual(chat.codePoints(SAMPLES.family), 7);
  assert.strictEqual(SAMPLES.family.length, 11);
  assert.strictEqual(chat.codePoints(SAMPLES.flag), 2);
  assert.strictEqual(chat.codePoints('plain words'), 11);
});

test('replies and emoji, end to end', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  const send = (who, conversationId, body) => as(who, `/chat/${conversationId}/messages`,
    { method: 'POST', body });
  const thread = async (who, conversationId) =>
    (await as(who, `/chat/${conversationId}/messages`)).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'chatreply', CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'chatreply', name: 'Root', email: 'root@cr.test', password: PASSWORD } });
    tok.root = await login('root@cr.test');
    for (const [key, name] of [['ana', 'Ana'], ['bo', 'Bo'], ['cas', 'Cas']]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name, email: `${key}@cr.test`, password: PASSWORD, role: 'game_artist' } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      tok[key] = await login(`${key}@cr.test`);
    }
    /* Two conversations: one Ana and Bo are both in, one Ana shares with Cas.
       The second is what makes "a reply cannot reach into another
       conversation" a thing that can be tested rather than asserted. */
    id.ab = (await as('ana', '/chat/direct', { method: 'POST', body: { userId: id.bo } })).body.conversationId;
    id.ac = (await as('ana', '/chat/direct', { method: 'POST', body: { userId: id.cas } })).body.conversationId;
  });
  t.after(() => { if (server) stopServer(server); });

  await t.test('a reply carries the quote, built from the original', async () => {
    const first = await send('ana', id.ab, { body: 'is the blue right?' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const reply = await send('bo', id.ab, { body: 'yes, ship it', replyToId: first.body.message.id });
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.body));
    assert.strictEqual(reply.body.message.replyToId, first.body.message.id);
    assert.ok(reply.body.message.quote, 'the quote comes back with it');
    assert.strictEqual(reply.body.message.quote.available, true);
    assert.strictEqual(reply.body.message.quote.senderName, 'Ana');
    assert.strictEqual(reply.body.message.quote.snippet, 'is the blue right?');

    /* AND IN THE THREAD, for the other person, read the same way. */
    const seen = (await thread('ana', id.ab)).messages.find((m) => m.id === reply.body.message.id);
    assert.strictEqual(seen.quote.snippet, 'is the blue right?');
  });

  await t.test('the quote is LIVE: editing the original changes what the reply shows', async () => {
    const original = await send('ana', id.ab, { body: 'the first wording' });
    const reply = await send('bo', id.ab, { body: 'noted', replyToId: original.body.message.id });

    /* CHANGED UNDERNEATH IT. There is no edit feature in chat, so this is done
       directly — which is the point: it proves the quote is READ and not a
       copy taken when the reply was sent. A snapshot would still say "the
       first wording". */
    await sql(cfg, 'UPDATE chat_messages SET body = ? WHERE id = ?',
      ['the second wording', original.body.message.id]);

    const seen = (await thread('ana', id.ab)).messages.find((m) => m.id === reply.body.message.id);
    assert.strictEqual(seen.quote.snippet, 'the second wording',
      'the quote is rendered from the original as it is now');
  });

  await t.test('a deleted original leaves no trace in the quote', async () => {
    const original = await send('ana', id.ab, { body: 'something private' });
    const reply = await send('bo', id.ab, { body: 'ok', replyToId: original.body.message.id });

    await sql(cfg, 'DELETE FROM chat_messages WHERE id = ?', [original.body.message.id]);

    const seen = (await thread('ana', id.ab)).messages.find((m) => m.id === reply.body.message.id);
    assert.ok(seen, 'the reply itself survives the original being deleted');
    assert.strictEqual(seen.quote.available, false, 'and its quote says the original is gone');
    assert.strictEqual(seen.quote.snippet, null, 'with no snippet');
    assert.strictEqual(seen.quote.senderName, null, 'and no name');

    /* NOTHING ABOUT IT ANYWHERE IN THE PAYLOAD, which is the claim worth making
       as a whole-body search rather than field by field: a leak would most
       likely be through a field nobody thought to check. */
    const whole = JSON.stringify(await thread('ana', id.ab));
    assert.ok(!whole.includes('something private'),
      'the deleted message\'s text appears nowhere in the thread');
  });

  await t.test('an attachment original quotes the file, and says when it has expired', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const form = new FormData();
    form.set('body', '');
    form.append('files', new Blob([png], { type: 'image/png' }), 'swatch.png');
    const withFile = await fetch(`${server.base}/chat/${id.ab}/messages`,
      { method: 'POST', headers: { Authorization: `Bearer ${tok.ana}` }, body: form });
    assert.strictEqual(withFile.status, 201);
    const originalId = (await withFile.json()).message.id;

    const reply = await send('bo', id.ab, { body: 'got it', replyToId: originalId });
    assert.strictEqual(reply.body.message.quote.snippet, 'swatch.png',
      'a quote of an attachment names the file');

    /* EXPIRED, and the quote stops naming a file that is not there to open. */
    await sql(cfg, 'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE message_id = ?',
      [originalId]);
    const seen = (await thread('ana', id.ab)).messages.find((m) => m.id === reply.body.message.id);
    assert.strictEqual(seen.quote.snippet, 'Attachment expired');
  });

  await t.test('the server refuses every bad target', async () => {
    const mine = await send('ana', id.ab, { body: 'in this room' });
    const elsewhere = await send('ana', id.ac, { body: 'in the other room' });

    /* ANOTHER CONVERSATION. The one that matters: the quote is rendered live,
       so allowing this would show Cas's words to Bo. */
    const crossed = await send('ana', id.ab,
      { body: 'reaching', replyToId: elsewhere.body.message.id });
    assert.strictEqual(crossed.status, 404, JSON.stringify(crossed.body));
    assert.match(crossed.body.error, /not in this conversation/);

    /* AND IT READS THE SAME AS "NOT THERE AT ALL", because telling them apart
       confirms that a message with that id exists somewhere. */
    const nonexistent = await send('ana', id.ab,
      { body: 'reaching', replyToId: '00000000-0000-0000-0000-000000000000' });
    assert.strictEqual(nonexistent.status, 404);
    assert.strictEqual(nonexistent.body.error, crossed.body.error,
      'the two refusals are word for word the same');

    /* A MESSAGE CANNOT ANSWER ITSELF. Checked through the module, because the
       id is not known to the caller until after the row exists. */
    const selfCheck = await chat.checkReplyTarget(
      { query: async () => ({ rows: [{ id: 'same' }] }) },
      { conversationId: id.ab, replyToId: 'same', messageId: 'same' });
    assert.strictEqual(selfCheck.ok, false);
    assert.match(selfCheck.error, /cannot reply to itself/);
  });

  await t.test('a reply to a reply is allowed, and quotes only one level', async () => {
    const one = await send('ana', id.ab, { body: 'level one' });
    const two = await send('bo', id.ab, { body: 'level two', replyToId: one.body.message.id });
    const three = await send('ana', id.ab, { body: 'level three', replyToId: two.body.message.id });
    assert.strictEqual(three.status, 201, JSON.stringify(three.body));
    assert.strictEqual(three.body.message.quote.snippet, 'level two');
    /* ONE LEVEL. The quote of a reply does not carry the reply's own quote —
       a chat window that nests them ends up rendering a conversation inside a
       message. */
    assert.strictEqual(three.body.message.quote.quote, undefined);
  });

  await t.test('replying changes nothing about who can see the message', async () => {
    const mine = await send('ana', id.ab, { body: 'between us' });
    await send('bo', id.ab, { body: 'quite', replyToId: mine.body.message.id });
    /* Cas is in neither of those messages' conversation and stays out of it. */
    const casSees = await as('cas', `/chat/${id.ab}/messages`);
    assert.strictEqual(casSees.status, 404, JSON.stringify(casSees.body));
  });

  await t.test('with replies switched off, new ones are refused and old quotes stay', async () => {
    const original = await send('ana', id.ab, { body: 'before the switch' });
    const reply = await send('bo', id.ab, { body: 'answered', replyToId: original.body.message.id });
    assert.strictEqual(reply.status, 201);

    const before = (await as('root', '/admin/settings/chat-policy')).body.settings;
    const off = await as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: before.attachmentHours, repliesEnabled: false,
        emojiPickerEnabled: before.emojiPickerEnabled } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    const refused = await send('ana', id.ab, { body: 'late', replyToId: original.body.message.id });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /switched off/);

    /* AN ORDINARY MESSAGE STILL SENDS. The switch is about replies, not chat. */
    const plain = await send('ana', id.ab, { body: 'but this is fine' });
    assert.strictEqual(plain.status, 201);

    /* AND THE QUOTES ALREADY SENT GO ON SHOWING, which is the promise. */
    const seen = (await thread('ana', id.ab)).messages.find((m) => m.id === reply.body.message.id);
    assert.strictEqual(seen.quote.available, true);
    assert.strictEqual(seen.quote.snippet, 'before the switch');

    /* And the panel is told, so the page can hide the action. */
    const panel = (await as('ana', '/chat')).body;
    assert.strictEqual(panel.features.replies, false);

    await as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: before.attachmentHours, repliesEnabled: true,
        emojiPickerEnabled: before.emojiPickerEnabled } });
  });

  await t.test('the emoji picker switch hides the button and nothing else', async () => {
    const before = (await as('root', '/admin/settings/chat-policy')).body.settings;
    await as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: before.attachmentHours, repliesEnabled: true,
        emojiPickerEnabled: false } });

    const panel = (await as('ana', '/chat')).body;
    assert.strictEqual(panel.features.emojiPicker, false, 'the page is told to hide the button');

    /* TYPED AND PASTED EMOJI GO ON WORKING, which is the whole distinction:
       the switch is about the picker, not about emoji. */
    const sent = await send('ana', id.ab, { body: `still fine ${SAMPLES.family}` });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    assert.ok(sent.body.message.body.includes(SAMPLES.family));

    await as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: before.attachmentHours, repliesEnabled: true,
        emojiPickerEnabled: true } });
  });

  await t.test('every shape of emoji survives the round trip, byte for byte', async () => {
    for (const [what, text] of Object.entries(SAMPLES)) {
      const sent = await send('ana', id.ab, { body: text });
      assert.strictEqual(sent.status, 201, `${what}: ${JSON.stringify(sent.body)}`);
      assert.strictEqual(sent.body.message.body, text, `${what}: back from the send`);

      /* AND FROM THE DATABASE, read fresh — the send's answer could in
         principle be echoing what it was given rather than what it stored. */
      const row = await sql(cfg, 'SELECT body FROM chat_messages WHERE id = ?', [sent.body.message.id]);
      assert.strictEqual(row[0].body, text, `${what}: back from the table`);

      /* AND THE CODE POINTS ARE INTACT, which is the thing a charset problem
         actually breaks: a mangled emoji usually survives as the right NUMBER
         of characters and the wrong ones, or as a replacement character. */
      assert.deepStrictEqual([...row[0].body], [...text], `${what}: code point for code point`);
      assert.ok(!row[0].body.includes('�'), `${what}: no replacement characters`);
    }
  });

  await t.test('a message at the limit sends and one over it is refused, not cut', async () => {
    const max = chat.MAX_BODY;
    const exact = 'a'.repeat(max);
    const ok = await send('ana', id.ab, { body: exact });
    assert.strictEqual(ok.status, 201, 'exactly the limit is allowed');
    assert.strictEqual(chat.codePoints(ok.body.message.body), max, 'and arrives whole');

    const over = await send('ana', id.ab, { body: 'a'.repeat(max + 1) });
    assert.strictEqual(over.status, 400, JSON.stringify(over.body));
    assert.match(over.body.error, new RegExp(String(max)), 'and the refusal says what the limit is');

    /* THE CASE THE OLD slice() GOT WRONG: a message of emoji that is under the
       limit in code points but over it in UTF-16 units. Truncating by .length
       would have cut this one in half, mid-surrogate. */
    /* Just over the limit in UTF-16 units and comfortably under it in code
       points, which is the only arithmetic that makes this case mean anything:
       each of these is one code point and two units. */
    const manyEmoji = SAMPLES.plain.repeat(Math.floor(max / 2) + 50);
    assert.ok(manyEmoji.length > max, 'it is over the limit counted the wrong way');
    assert.ok(chat.codePoints(manyEmoji) <= max, 'and under it counted the right way');
    const emojiSend = await send('ana', id.ab, { body: manyEmoji });
    assert.strictEqual(emojiSend.status, 201, 'so it is allowed');
    assert.strictEqual(emojiSend.body.message.body, manyEmoji, 'and nothing is cut');
  });

  await t.test('the chat text column and the connection are utf8mb4', async () => {
    /* THE ROUND TRIPS ABOVE ARE THE REAL TEST — this is the explanation beside
       them, so a failure says WHICH of the three places went wrong rather than
       just that an emoji came back mangled. */
    const col = await sql(cfg,
      `SELECT CHARACTER_SET_NAME AS cs, COLLATION_NAME AS co FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'body'`);
    assert.strictEqual(col[0].cs, 'utf8mb4', 'the column holds four-byte characters');

    const table = await sql(cfg,
      `SELECT TABLE_COLLATION AS co FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages'`);
    assert.match(table[0].co, /^utf8mb4_/, 'and so does the table');

    /* THE CONNECTION IS THE THIRD PLACE, and the one most often missed: a
       utf8mb4 column reached over a utf8 connection stores question marks. */
    const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
    assert.match(dbSrc, /charset:\s*'utf8mb4/, 'and the driver connects as utf8mb4');

    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(page.slice(0, 400), /<meta charset="UTF-8">/i, 'and the page is UTF-8');
  });
});
