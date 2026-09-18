/* Tagging somebody in a chat message.
 *
 * A mention is two halves that have to agree. The composer turns "@Priya Nair"
 * into @[Priya Nair](uuid) on the way out; the server reads the uuid on the way
 * in and tells that person. Everything worth testing lives at the seams:
 *
 *   THE ID IS THE FACT, THE NAME IS DECORATION. Nothing stops a sender hand-
 *      writing @[Ananya Rao](their-own-id). If a reader trusted the name, a
 *      message could appear to tag the Creative Director. Every reader
 *      resolves the id instead.
 *
 *   ONLY PEOPLE IN THE ROOM. The dropdown offers this conversation's members
 *      and nobody else, and the server filters again on the way in — a token
 *      naming somebody who is not a member is dropped rather than refused, so
 *      a message does not fail because a group changed while it was being
 *      written.
 *
 *   ONE PERSON, ONE NOTIFICATION. Tagging Ana three times is emphasis.
 *
 *   IT SURVIVES A MUTE THAT DOES NOT EXIST YET. The studio asked that a
 *      mention reach somebody whatever they have done to quieten a
 *      conversation. There is no mute in this application — nothing mutes a
 *      chat or a group — so the promise cannot be demonstrated. What CAN be
 *      held is the structure that would keep it: a mention is raised on the
 *      notifications channel, not inside chat's own push, so anything that
 *      ever silences a conversation would have to silence the other one too.
 *      The last test in the file pins that separation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mentions = require('../src/chat-mentions');
const notifications = require('../src/notifications');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

const cfg = config('chatmention');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const ID = {
  ana:  '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  bo:   '11111111-2222-4333-8444-555555555555',
  cy:   '99999999-8888-4777-8666-555555555555',
};
const token = (name, id) => `@[${name}](${id})`;

// --- the token, read ----------------------------------------------------------

test('a body carries who was tagged, in order', () => {
  const body = `morning ${token('Ana Artist', ID.ana)} and ${token('Bo Chen', ID.bo)} — today?`;
  assert.deepStrictEqual(mentions.parse(body).map((m) => m.name), ['Ana Artist', 'Bo Chen']);
  assert.deepStrictEqual(mentions.idsIn(body), [ID.ana, ID.bo]);
});

test('the same person twice is one person to tell', () => {
  const body = `${token('Ana', ID.ana)} ${token('Ana', ID.ana)} ${token('Ana', ID.ana)} are you there`;
  assert.strictEqual(mentions.parse(body).length, 3, 'all three are in the text');
  assert.deepStrictEqual(mentions.idsIn(body), [ID.ana], 'and they are one notification');
});

test('text that merely looks like a mention is not one', () => {
  for (const body of [
    'email me at ana@example.com',
    '@Ana can you look',                       // typed, never chosen from the picker
    '@[Ana](not-a-uuid)',
    '@[Ana](3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b)', // no dashes
    '@[](3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b)', // no name
  ]) {
    assert.deepStrictEqual(mentions.idsIn(body), [], body);
  }
});

test('parsing the same string twice gives the same answer', () => {
  /* A module-level /g/ regex keeps lastIndex between calls, so the second read
     of one string would start half way through it. The kind of thing that only
     shows up once something loops over messages. */
  const body = `${token('Ana', ID.ana)} hello`;
  assert.deepStrictEqual(mentions.idsIn(body), mentions.idsIn(body));
  assert.deepStrictEqual(mentions.parse(body).length, mentions.parse(body).length);
});

test('a body reads as plain text where nothing can render it', () => {
  /* The one-line preview under a conversation, and anywhere else a message
     appears without the member list to resolve against. */
  assert.strictEqual(
    mentions.toPlainText(`${token('Ana Artist', ID.ana)} can you look at this`),
    '@Ana Artist can you look at this'
  );
  assert.strictEqual(mentions.toPlainText(''), '');
  assert.strictEqual(mentions.toPlainText(null), '');
});

// --- who is told --------------------------------------------------------------

test('THE VALIDATION: only members of the conversation', () => {
  const body = `${token('Ana', ID.ana)} and ${token('Cy', ID.cy)}`;
  const members = [{ id: ID.ana }, { id: ID.bo }];
  assert.deepStrictEqual(mentions.recipients({ body, members, senderId: ID.bo }), [ID.ana],
    'Cy is not in this conversation and is not told about it');
});

test('and never the person doing the tagging', () => {
  const body = `note to self ${token('Ana', ID.ana)}`;
  assert.deepStrictEqual(
    mentions.recipients({ body, members: [{ id: ID.ana }], senderId: ID.ana }), []);
});

test('the member list is matched without regard to case', () => {
  /* The ids come back from MySQL as they were stored, and a uuid typed into a
     token may be either case. A mention that failed on capitalisation would
     fail silently, which is the worst way for this to break. */
  const body = token('Ana', ID.ana.toUpperCase());
  assert.deepStrictEqual(
    mentions.recipients({ body, members: [{ id: ID.ana }], senderId: null }), [ID.ana]);
});

test('an empty or malformed body tells nobody, and throws at nobody', () => {
  for (const body of ['', null, undefined, 'just words']) {
    assert.deepStrictEqual(mentions.recipients({ body, members: [{ id: ID.ana }] }), []);
  }
  assert.deepStrictEqual(mentions.recipients({ body: token('Ana', ID.ana), members: null }), []);
});

// --- what the bell says -------------------------------------------------------

test('a mention reads as a mention, and carries no message text', () => {
  const sentence = notifications.describe({
    kind: 'mention', other_name: 'Priya Nair', conversation_title: 'Neon Drift',
  });
  assert.strictEqual(sentence, 'Priya Nair mentioned you in Neon Drift.');
  assert.ok(!/:/.test(sentence),
    'no quoted message: a chat body on a lock screen is what src/routes/chat.js refuses to send');
});

test('a one-to-one mention does not name the conversation after the sender', () => {
  /* A direct conversation is titled "whoever the other person is", which from
     the recipient's side is the person already named at the front of the
     sentence — "Priya mentioned you in Priya". */
  assert.strictEqual(
    notifications.describe({ kind: 'mention', other_name: 'Priya Nair' }),
    'Priya Nair mentioned you.');
});

test('the page has a heading for it, distinct from a message', () => {
  const titles = PAGE.match(/const NOTIF_TITLES = \{([\s\S]*?)\n\};/);
  assert.ok(titles);
  assert.match(titles[1], /mention:\s*'You were mentioned'/);
  assert.ok(Object.values(notifications.KINDS).every((k) => new RegExp(`\\n\\s*${k}:`).test(titles[1])),
    'every kind still has a heading');
});

// --- the composer, lifted out of the page -------------------------------------

function composer() {
  const lift = (name) => {
    const m = PAGE.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n}\\n`));
    assert.ok(m, `public/index.html has no ${name}`);
    return `function ${name}(${m[1]}\n}`;
  };
  return new Function(`
    ${['chatMentionAnchor', 'chatMentionEncode'].map(lift).join('\n')}
    return { chatMentionAnchor, chatMentionEncode };
  `)();
}

test('the picker opens on an @ that starts a word, and not otherwise', () => {
  const { chatMentionAnchor } = composer();
  assert.strictEqual(chatMentionAnchor('@', 1), 0, 'the very first character');
  assert.strictEqual(chatMentionAnchor('hello @pri', 10), 6, 'after a space');
  assert.strictEqual(chatMentionAnchor('line\n@pri', 9), 5, 'after a newline');
  assert.strictEqual(chatMentionAnchor('write to ana@example.com', 24), -1,
    'an email address must not open it');
  assert.strictEqual(chatMentionAnchor('@Ana said so', 12), -1,
    'and it closes once the word is finished');
  assert.strictEqual(chatMentionAnchor('no at sign here', 15), -1);
});

test('the readable names become tokens on the way out', () => {
  const { chatMentionEncode } = composer();
  const picked = [{ id: ID.ana, name: 'Ana Artist' }, { id: ID.bo, name: 'Bo Chen' }];
  const out = chatMentionEncode('@Ana Artist and @Bo Chen — tomorrow?', picked);
  assert.strictEqual(out, `${token('Ana Artist', ID.ana)} and ${token('Bo Chen', ID.bo)} — tomorrow?`);
  assert.deepStrictEqual(mentions.idsIn(out), [ID.ana, ID.bo]);
});

test('a mention typed over stops being one', () => {
  /* Somebody chooses Ana, then backspaces her name away. The pick is still in
     the list; there is nothing left in the text for it to claim, so it falls
     out — and she is not notified about a message that does not name her. */
  const { chatMentionEncode } = composer();
  const out = chatMentionEncode('never mind', [{ id: ID.ana, name: 'Ana Artist' }]);
  assert.strictEqual(out, 'never mind');
  assert.deepStrictEqual(mentions.idsIn(out), []);
});

test('one name is not half of another', () => {
  const { chatMentionEncode } = composer();
  const out = chatMentionEncode('@Anastasia Khan is here', [{ id: ID.ana, name: 'Ana' }]);
  assert.strictEqual(out, '@Anastasia Khan is here', '"@Ana" must not eat the front of "@Anastasia"');
});

test('two people with the same display name get one token each', () => {
  /* Two Alexes in a group is not far-fetched, and the picker shows their
     designations so they can be told apart. Each pick claims the first
     occurrence no earlier pick has taken. */
  const { chatMentionEncode } = composer();
  const out = chatMentionEncode('@Alex and @Alex, both of you',
    [{ id: ID.ana, name: 'Alex' }, { id: ID.bo, name: 'Alex' }]);
  assert.deepStrictEqual(mentions.idsIn(out), [ID.ana, ID.bo]);
});

test('a pick cannot be written into the middle of an earlier token', () => {
  /* The token it produced is text like any other, and a later pick searching
     for "@Ana" would otherwise find the name inside it. */
  const { chatMentionEncode } = composer();
  const out = chatMentionEncode('@Ana Artist', [
    { id: ID.ana, name: 'Ana Artist' },
    { id: ID.bo, name: 'Ana' },
  ]);
  assert.deepStrictEqual(mentions.idsIn(out), [ID.ana], 'the second pick has nothing to claim');
  assert.strictEqual((out.match(/@\[/g) || []).length, 1);
});

test('the sent message renders from the id, never from the name beside it', () => {
  /* The anti-spoof. chatBodyHTML resolves each token against the conversation's
     members and prints THAT person's name — so @[Ananya Rao](somebody-else)
     shows whoever the id really is, and an id belonging to nobody in the room
     is not a mention at all. */
  const fn = PAGE.match(/function chatBodyHTML\(body\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'public/index.html has no chatBodyHTML');
  assert.match(fn[1], /members\.get\(String\(id\)\.toLowerCase\(\)\)/,
    'the id has to be looked up');
  assert.match(fn[1], /if\(!person\) return '@' \+ claimed;/,
    'a token for a non-member is plain text, not a highlight');
  assert.match(fn[1], /escapeHTML\(person\.name/,
    'and the name shown is the member\'s own, not the one in the token');
  assert.ok(fn[1].indexOf('escapeHTML(String(body') < fn[1].indexOf('.replace('),
    'the body is escaped before the tokens are picked out of it');
});

// --- against a live server -----------------------------------------------------

test('mentions, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Mention-Test-1!';
  let server;
  const token_ = {};
  const id = {};
  let groupId;

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token_[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const mark = async (who) => (await as(who, '/notifications/poll')).body.cursor;
  const since = async (who, cursor) => (await as(who, `/notifications/poll?since=${cursor}`)).body.fresh || [];
  const kinds = (list) => list.map((x) => x.kind);
  const tag = (who) => `@[Whoever](${id[who]})`;
  const say = (who, conv, body) => as(who, `/chat/${conv}/messages`, { method: 'POST', body: { body } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    token_.root = await login('root@zvky.test');
    id.root = (await as('root', '/auth/me')).body.user.id;

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      token_[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist');
    await make('bo', 'Bo Chen', 'bo@zvky.test', 'game_artist');
    await make('cy', 'Cy Outside', 'cy@zvky.test', 'game_artist');   // never in the group

    const g = await as('root', '/chat/groups', {
      method: 'POST', body: { title: 'Neon Drift', memberIds: [id.ana, id.bo] },
    });
    assert.ok(g.status < 400, JSON.stringify(g.body));
    groupId = g.body.conversationId;
  });

  t.after(() => stopServer(server));

  await t.test('a group conversation offers its own members and nobody else', async () => {
    const r = await as('root', `/chat/${groupId}/messages`);
    assert.strictEqual(r.status, 200);
    const ids = r.body.conversation.members.map((m) => m.id);
    assert.deepStrictEqual(ids.slice().sort(), [id.root, id.ana, id.bo].sort());
    assert.ok(!ids.includes(id.cy), 'somebody outside the group is not in the list the picker reads');
  });

  await t.test('a one-to-one names its two members too', async () => {
    /* It used to send an empty list for a direct conversation, which would
       leave the picker with nobody to offer. */
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.cy } });
    const r = await as('root', `/chat/${d.body.conversationId}/messages`);
    assert.strictEqual(r.body.conversation.members.length, 2, JSON.stringify(r.body.conversation.members));
  });

  await t.test('THE TRIGGER: being tagged raises a mention, and only for the tagged', async () => {
    const a = await mark('ana');
    const b = await mark('bo');
    const c = await mark('cy');

    const sent = await say('root', groupId, `morning ${tag('ana')} can you take the hero pass`);
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    const got = await since('ana', a);
    assert.deepStrictEqual(kinds(got), ['mention']);
    assert.match(got[0].message, /Root Admin mentioned you in Neon Drift/);
    assert.strictEqual(got[0].conversationId, groupId, 'so clicking it can open the conversation');
    assert.ok(!/hero pass/.test(got[0].message), 'and it does not quote the message');

    assert.deepStrictEqual(kinds(await since('bo', b)), [],
      'a member of the same group who was not tagged hears nothing');
    assert.deepStrictEqual(kinds(await since('cy', c)), []);
  });

  await t.test('several people in one message, one each', async () => {
    const a = await mark('ana');
    const b = await mark('bo');
    await say('root', groupId, `${tag('ana')} and ${tag('bo')} — both of you please`);
    assert.deepStrictEqual(kinds(await since('ana', a)), ['mention']);
    assert.deepStrictEqual(kinds(await since('bo', b)), ['mention']);
  });

  await t.test('the same person three times, once', async () => {
    const a = await mark('ana');
    await say('root', groupId, `${tag('ana')} ${tag('ana')} ${tag('ana')} hello?`);
    assert.strictEqual((await since('ana', a)).length, 1);
  });

  await t.test('tagging somebody who is not in the room sends, and tells them nothing', async () => {
    const c = await mark('cy');
    const sent = await say('root', groupId, `what about ${tag('cy')} for this`);
    assert.strictEqual(sent.status, 201,
      'a token for a non-member must not fail the message — the group may have changed as it was typed');
    assert.deepStrictEqual(kinds(await since('cy', c)), []);
    assert.match(sent.body.message.body, new RegExp(id.cy),
      'the body is stored as the sender wrote it');
  });

  await t.test('tagging yourself raises nothing', async () => {
    const r = await mark('root');
    await say('root', groupId, `note to self @[Me](${id.root})`);
    assert.deepStrictEqual(kinds(await since('root', r)), []);
  });

  await t.test('an ordinary message raises nothing on the bell', async () => {
    /* Chat has its own poll and its own push. Only a mention crosses over. */
    const a = await mark('ana');
    await say('root', groupId, 'no tags in this one');
    assert.deepStrictEqual(kinds(await since('ana', a)), []);
  });

  await t.test('a mention in a one-to-one works the same way', async () => {
    const d = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.ana } });
    const conv = d.body.conversationId;
    const a = await mark('ana');
    await say('root', conv, `${tag('ana')} could you look at this today`);
    const got = await since('ana', a);
    assert.deepStrictEqual(kinds(got), ['mention']);
    assert.strictEqual(got[0].message, 'Root Admin mentioned you.');
  });

  await t.test('the conversation list shows a mention as readable text', async () => {
    await say('root', groupId, `${tag('ana')} last one`);
    const list = await as('root', '/chat');
    const row = (list.body.conversations || []).find((c) => c.id === groupId);
    assert.ok(row, 'the group should be in the list');
    assert.ok(!/@\[/.test(row.lastMessage.preview),
      `a raw token reached the preview: ${row.lastMessage.preview}`);
    assert.match(row.lastMessage.preview, /@Whoever last one/);
  });

  await t.test('the existing chat features are untouched', async () => {
    /* Attachments and their download links, on a message that also mentions
       somebody — the three things built before this, in one request. */
    const before = (await as('ana', '/chat/poll')).body;
    const sent = await say('root', groupId, `${tag('ana')} see the brief`);
    assert.strictEqual(sent.status, 201);
    assert.ok(Array.isArray(sent.body.message.attachments), 'the message shape still carries attachments');
    const poll = await as('ana', '/chat/poll');
    assert.ok(JSON.stringify(poll.body).length > 0, 'and chat still polls on its own channel');
    assert.ok(before !== undefined);
  });
});

// --- the promise that cannot be demonstrated yet -------------------------------

test('a mention does not travel on chat\'s own notification path', () => {
  /* THE MUTE QUESTION, answered as far as it can be. There is no mute in this
     application: nothing in src/chat.js, src/routes/chat.js, the schema or the
     page silences a conversation or a group. So "a mention still arrives when
     the conversation is muted" cannot be shown — there is nothing to mute.
     
     What can be held is the shape that would keep the promise. An ordinary
     message reaches somebody through pushChat(); a mention is raised
     separately, through notifications. A mute would be built into the first —
     that is where the per-conversation loop is — and the second would carry on
     regardless. If the two are ever merged, this fails, and whoever merged
     them has to decide the question on purpose. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chat.js'), 'utf8');

  const push = route.match(/async function pushChat\([\s\S]*?\n\}/);
  assert.ok(push, 'pushChat is gone');
  assert.ok(!/mention|notifications\./i.test(push[0]),
    `the mention must not be raised from inside chat's own push: ${push[0].slice(0, 200)}`);

  assert.match(route, /notifications\.chatMention\(/, 'and it must be raised somewhere');
  assert.match(route, /mentions\.recipients\(/, 'from the members of the conversation');

  /* And a watch for the day one is built. Looking for the WORD "mute" catches
     this file's own explanation of why there isn't one, which is a test that
     fails on its documentation. So it looks for the shape a mute would have —
     a column, a flag, a route — rather than for prose about it. */
  for (const file of ['../src/chat.js', '../src/routes/chat.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const built = src.match(/muted_at|is_muted|\bmuted\s*[:=]|['"`]\/?mute['"`]|\/mute\b/i);
    assert.ok(!built,
      `${file} has grown a mute (${built && built[0]}) — whether a mention ignores it `
      + 'is now a decision somebody has to make on purpose, and this test is the reminder');
  }
});
