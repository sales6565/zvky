/* Chat Activity — the oversight screen, and the promises made around it.
 *
 * This feature reverses a decision the chat feature shipped with. The studio
 * asked for it, confirmed it deliberately, and was told what it costs. What is
 * tested here is not that it works — a SELECT usually does — but the four
 * things that make it safe to have:
 *
 *   IT IS ONE PERMISSION AND NOT A CHAT ONE. settings.chat_activity, Super
 *   Admin only out of the box. Nothing in the chat.* group reads it, and
 *   holding every chat permission does not open it.
 *
 *   IT DID NOT WIDEN ORDINARY CHAT. Every membership rule on /api/chat still
 *   refuses, including for the account that holds the oversight key. That is
 *   what the separate router buys, and it is the assertion a refactor is most
 *   likely to lose.
 *
 *   IT PRESERVES NOTHING. A file is still gone twelve hours after it was sent.
 *   An oversight screen that could fetch what everybody else had lost would be
 *   a retention policy nobody wrote down.
 *
 *   IT IS ITSELF ON THE RECORD. Every read writes a line naming who looked and
 *   what they searched for — and the line does not contain what they read.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const oversight = require('../src/chat-oversight');
const chatFiles = require('../src/chat-files');
const rolePermissions = require('../src/role-permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatActivity');

test('the permission is a Settings one, Super Admin only, and says what it costs', () => {
  const entry = catalogue.BY_KEY.get('settings.chat_activity');
  assert.ok(entry, 'the key exists');
  assert.strictEqual(entry.group, 'settings');
  assert.strictEqual(entry.label, 'View Chat Activity');

  /* By capability, not by role name — the studio's standing rule. Super Admin
     is the only tier holding managePermissions, and the point of asking it this
     way is that a designation renamed next year still gets the right answer. */
  const superAdmin = { manageUsers: true, managePermissions: true, manageSettings: true, projectScope: 'all' };
  const headOfProduction = { manageUsers: true, managePermissions: false, manageSettings: true, projectScope: 'all' };
  assert.strictEqual(entry.impliedBy(superAdmin), true);
  assert.strictEqual(entry.impliedBy(headOfProduction), false,
    'narrower than the Activity Log beside it, which those seven designations do hold');
  assert.strictEqual(catalogue.BY_KEY.get('settings.activity_log').impliedBy(headOfProduction), true,
    'and that difference is deliberate, so it is asserted rather than assumed');

  assert.ok(/staff should be told/i.test(entry.danger || ''),
    'and whoever grants it is told to tell people first');
});

test('the filters are the Activity Log\'s, plus the two chat needs of its own', () => {
  /* Same shape, because somebody who has learned one screen should not have to
     learn the other. Whole days inclusive at both ends is the half of that
     which is easy to get wrong and impossible to see. */
  const { clause, params } = oversight.buildQuery({ from: '2026-03-01', to: '2026-03-03' });
  assert.match(clause, /m\.created_at >= \$1 AND m\.created_at <= \$2/);
  assert.deepStrictEqual(params, ['2026-03-01 00:00:00', '2026-03-03 23:59:59']);

  /* The person filter is BOTH SIDES: what they said, and what was said in a
     room they are in. A filter that returned only what they typed would hide
     the half of a conversation that was about them, which is the half somebody
     looking into one person usually wants. */
  const person = oversight.buildQuery({ personId: 'u1' });
  assert.match(person.clause, /m\.sender_id = \$1 OR EXISTS/);
  assert.match(person.clause, /chat_members/);

  // Free text reaches the words, the sender and the group's name.
  const q = oversight.buildQuery({ q: 'ridge' });
  assert.match(q.clause, /m\.body LIKE/);
  assert.match(q.clause, /u\.`name` LIKE/);
  assert.match(q.clause, /c\.title LIKE/);
  assert.deepStrictEqual(q.params, ['%ridge%', '%ridge%', '%ridge%']);

  // And nothing at all is a query with no WHERE, not a query that matches none.
  assert.strictEqual(oversight.buildQuery({}).clause, '');
});

test('a one-to-one conversation is named by both people in it', () => {
  /* Not "the other one": there is no other one from the point of view of
     somebody reading who is in neither. */
  const two = [{ name: 'Ana' }, { name: 'Bo' }];
  assert.strictEqual(oversight.describeConversation('direct', null, two), 'Ana and Bo');
  assert.strictEqual(oversight.describeConversation('group', 'Lighting', two), 'Lighting');
  assert.strictEqual(oversight.describeConversation('group', null, two), 'Untitled group');
  // A deleted account leaves a hole, and the hole is named rather than hidden.
  assert.strictEqual(oversight.describeConversation('direct', null, [{ name: 'Ana' }]),
    'Ana and a removed account');
});

test('the oversight download is a function of its own, with no membership in it', () => {
  /* Written as forOversight rather than as a flag on forDownload so the call
     site cannot be misread. This pins the shape: a reader glancing at either
     one can see from the arguments whether authorisation is being asked for. */
  assert.strictEqual(typeof chatFiles.forOversight, 'function');
  assert.strictEqual(chatFiles.forOversight.length, 2, 'db and an attachment id — no user');
  assert.strictEqual(chatFiles.forDownload.length, 3, 'db, an attachment id, and the user');
});

// --------------------------------------------------------- integration tests

test('chat activity', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Oversee-This-1!';
  let server;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  async function post(who, conversationId, { body, file } = {}) {
    const form = new FormData();
    if (body !== undefined) form.set('body', body);
    if (file) form.set('files', new Blob([file.bytes], { type: file.type || '' }), file.name);
    const res = await fetch(`${server.base}/chat/${conversationId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token[who]}` }, body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const openDirect = async (who, userId) =>
    (await as(who, '/chat/direct', { method: 'POST', body: { userId } }));
  const read = async (who, query = '') => as(who, `/chat-activity${query ? `?${query}` : ''}`);

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ca-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'ca-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    /* dee holds Managing Director & CEO — one of the two designations nobody
       but a Super Admin may open a conversation with. It is here so the
       studio's fifth testing step has something real to check. */
    for (const [who, role] of [
      ['ana', 'game_artist'], ['bo', 'game_artist'], ['lee', 'team_lead'],
      ['hop', 'head_of_production'], ['dee', 'managing_director_ceo'],
    ]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });
  t.after(() => stopServer(server));

  await t.test('everything said in the studio is there, one-to-one and group alike', async () => {
    const direct = (await openDirect('ana', people.bo)).body.conversationId;
    await post('ana', direct, { body: 'Did the ridge pass land?' });
    await post('bo', direct, { body: 'Sent it an hour ago.' });

    const group = (await as('lee', '/chat/groups', { method: 'POST',
      body: { title: 'Lighting pass', memberIds: [people.ana, people.bo] } })).body.conversationId;
    await post('lee', group, { body: 'Rushes at four, please.' });
    await post('ana', group, { body: 'Here is the frame.', file: { name: 'frame.png', bytes: PNG, type: 'image/png' } });

    const res = await read('root');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const said = res.body.messages.map((m) => m.body);
    for (const line of ['Did the ridge pass land?', 'Sent it an hour ago.',
      'Rushes at four, please.', 'Here is the frame.']) {
      assert.ok(said.includes(line), `"${line}" is in the record — got ${JSON.stringify(said)}`);
    }

    // Full content, as the studio asked for — not metadata.
    const one = res.body.messages.find((m) => m.body === 'Did the ridge pass land?');
    assert.strictEqual(one.sender.name, 'ana');
    assert.strictEqual(one.conversation.kind, 'direct');
    assert.strictEqual(one.conversation.label, 'ana and bo', 'a 1:1 is named by both people');
    assert.ok(one.at, 'and stamped');

    const inGroup = res.body.messages.find((m) => m.body === 'Rushes at four, please.');
    assert.strictEqual(inGroup.conversation.kind, 'group');
    assert.strictEqual(inGroup.conversation.label, 'Lighting pass');
    assert.deepStrictEqual(inGroup.conversation.members.map((x) => x.name).sort(), ['ana', 'bo', 'lee']);

    // The file is there and readable, with a URL pointing at THIS screen.
    const withFile = res.body.messages.find((m) => m.body === 'Here is the frame.');
    assert.strictEqual(withFile.attachments.length, 1);
    assert.strictEqual(withFile.attachments[0].fileName, 'frame.png');
    assert.strictEqual(withFile.attachments[0].expired, false);
    assert.match(withFile.attachments[0].url, /^\/api\/chat-activity\/attachments\//,
      'and not at the panel\'s route, which checks a membership this reader has not got');

    // A group message is returned ONCE, not once per member.
    const copies = res.body.messages.filter((m) => m.body === 'Rushes at four, please.');
    assert.strictEqual(copies.length, 1);
  });

  await t.test('the file opens here, and stops opening at the same moment it does everywhere', async () => {
    const direct = (await openDirect('ana', people.lee)).body.conversationId;
    const sent = await post('ana', direct, {
      body: 'the brief', file: { name: 'brief.png', bytes: PNG, type: 'image/png' } });
    const attachmentId = sent.body.message.attachments[0].id;

    const got = await fetch(`${server.base}/chat-activity/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(got.status, 200, 'inside its window it opens');
    assert.strictEqual(got.headers.get('x-content-type-options'), 'nosniff');

    /* Past the window. Aged by the clock rather than by running the sweep,
       because expiry is decided by the clock — a file the sweep has not reached
       yet is already expired, and this screen must agree. */
    await sql(cfg, 'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [attachmentId]);

    const gone = await fetch(`${server.base}/chat-activity/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(gone.status, 410, 'and afterwards it does not');
    const why = await gone.json();
    assert.match(why.error, new RegExp(`${chatFiles.HOURS} hours`));

    // And the listing shows the placeholder, exactly as the panel does.
    const res = await read('root', 'q=the%20brief');
    const row = res.body.messages.find((m) => m.body === 'the brief');
    assert.strictEqual(row.attachments[0].expired, true);
    assert.strictEqual(row.attachments[0].url, null,
      'no link, because a link that 404s is a worse way to say expired than saying it');
    assert.strictEqual(row.attachments[0].fileName, 'brief.png', 'though it still says what it was');
  });

  await t.test('an SVG is still forced to download, oversight or not', async () => {
    /* The one allowed format that can carry a script. Reading a conversation is
       not a reason to relax the rule that stops it becoming a page on this
       origin. */
    const direct = (await openDirect('bo', people.lee)).body.conversationId;
    const sent = await post('bo', direct, {
      body: 'diagram', file: { name: 'flow.svg', bytes: Buffer.from('<svg/>'), type: 'image/svg+xml' } });
    const id = sent.body.message.attachments[0].id;
    const got = await fetch(`${server.base}/chat-activity/attachments/${id}`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(got.status, 200);
    assert.match(got.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(got.headers.get('content-security-policy') || '', /sandbox/);
  });

  await t.test('the filters narrow it, and the person filter reaches both sides', async () => {
    const all = (await read('root')).body.total;

    const searched = await read('root', 'q=ridge');
    assert.ok(searched.body.total >= 1 && searched.body.total < all, 'free text narrows it');
    assert.ok(searched.body.messages.every((m) => /ridge/i.test(m.body || '')
      || /ridge/i.test(m.sender ? m.sender.name : '') || /ridge/i.test(m.conversation.title || '')));

    const groupsOnly = await read('root', 'kind=group');
    assert.ok(groupsOnly.body.messages.every((m) => m.conversation.kind === 'group'));
    assert.ok(groupsOnly.body.total < all);

    /* bo never used the word "Rushes" — lee did, in a group bo is in. Both come
       back, which is the whole reason the person filter is not a sender
       filter. */
    const aboutBo = await read('root', `personId=${people.bo}`);
    const bodies = aboutBo.body.messages.map((m) => m.body);
    assert.ok(bodies.includes('Sent it an hour ago.'), 'what bo said');
    assert.ok(bodies.includes('Rushes at four, please.'), 'and what was said to bo');

    const withFiles = await read('root', 'withFiles=1');
    assert.ok(withFiles.body.messages.length >= 2);
    assert.ok(withFiles.body.messages.every((m) => m.attachments.length > 0));

    // Tomorrow onwards is empty, and empty is a page rather than an error.
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const none = await read('root', `from=${tomorrow}`);
    assert.strictEqual(none.status, 200);
    assert.strictEqual(none.body.total, 0);
    assert.deepStrictEqual(none.body.messages, []);
  });

  await t.test('a conversation only a Super Admin could start is in it like any other', async () => {
    /* The studio's fifth testing step. dee holds a shielded designation: nobody
       but a Super Admin may open a conversation with them. A record with a hole
       where those conversations should be is worse than no record, so there is
       no exception. */
    const shielded = await as('ana', '/chat/direct', { method: 'POST', body: { userId: people.dee } });
    assert.strictEqual(shielded.status, 403, 'the restriction is untouched');

    const opened = (await as('root', '/chat/direct', { method: 'POST', body: { userId: people.dee } }))
      .body.conversationId;
    await post('root', opened, { body: 'A word about the quarter.' });
    await post('dee', opened, { body: 'Tomorrow suits.' });

    const res = await read('root', 'q=quarter');
    const row = res.body.messages.find((m) => m.body === 'A word about the quarter.');
    assert.ok(row, 'it is in the record');
    assert.strictEqual(row.conversation.label, 'Root and dee');
    assert.ok((await read('root', 'q=Tomorrow%20suits')).body.messages.length === 1,
      'and so is their reply');
  });

  await t.test('reading it is itself recorded, without recording what was read', async () => {
    await sql(cfg, 'DELETE FROM activity_log WHERE action LIKE ?', ['chat.activity%']);
    await read('root', 'q=ridge&from=2026-01-01');

    const rows = await sql(cfg,
      'SELECT * FROM activity_log WHERE action = ? ORDER BY seq DESC', ['chat.activity_viewed']);
    assert.strictEqual(rows.length, 1, 'one line per read');
    assert.strictEqual(rows[0].actor_email, 'root@zvky.test', 'naming who looked');
    assert.strictEqual(rows[0].module, 'settings');
    assert.match(rows[0].summary, /Read Chat Activity/);
    assert.match(rows[0].summary, /searching "ridge"/, 'and what they went looking for');
    assert.match(rows[0].summary, /2026-01-01 to today/);

    /* THE LINE MUST NOT CARRY THE CONTENT. Copying results into the log would
       put chat text into a second table with a different permission on it,
       which is the one thing this feature must not quietly do. */
    const everything = JSON.stringify(rows[0]);
    for (const said of ['Did the ridge pass land?', 'Sent it an hour ago.', 'Tomorrow suits.']) {
      assert.ok(!everything.includes(said), `the log does not quote "${said}"`);
    }

    // Opening a file is its own line, naming the file.
    const withFile = (await read('root', 'withFiles=1')).body.messages
      .find((m) => m.attachments.some((a) => a.url));
    if (withFile) {
      const url = withFile.attachments.find((a) => a.url).url;
      await fetch(server.base + url.replace(/^\/api/, ''),
        { headers: { Authorization: `Bearer ${token.root}` } });
      const opened = await sql(cfg, 'SELECT * FROM activity_log WHERE action = ?',
        ['chat.activity_file_opened']);
      assert.ok(opened.length >= 1, 'opening a file is on the record too');
      assert.match(opened[0].summary, /Opened a chat file/);
    }
  });

  await t.test('the permission is the only way in, and it is not a chat permission', async () => {
    /* The studio's third testing step, asked of the API rather than of the
       screen: an account without the key gets nothing, whatever its own chat
       permissions say. hop holds manageSettings, so they hold the Activity Log
       — and still not this. */
    const hopPerms = (await as('hop', '/auth/me')).body.user.permissions;
    assert.ok(hopPerms.includes('settings.activity_log'), 'hop reads the Activity Log');
    assert.ok(hopPerms.includes('chat.use'), 'and uses chat');
    assert.ok(!hopPerms.includes('settings.chat_activity'), 'but not this');

    for (const path of ['/chat-activity', '/chat-activity/summary']) {
      assert.strictEqual((await as('hop', path)).status, 403, path);
      assert.strictEqual((await as('ana', path)).status, 403, `${path} for an artist`);
    }
    // Nor the files, holding a real id.
    const anyFile = await sql(cfg, 'SELECT id FROM chat_attachments LIMIT 1');
    const refused = await fetch(`${server.base}/chat-activity/attachments/${anyFile[0].id}`,
      { headers: { Authorization: `Bearer ${token.hop}` } });
    assert.strictEqual(refused.status, 403);
  });

  await t.test('granting it to another designation is what opens it', async () => {
    /* The studio's fourth testing step.
     *
     * The role's CURRENT set has to be read properly and sent back with the new
     * key added, because PUT replaces rather than merges. Reading it wrongly —
     * as `body.permissions`, which does not exist at the top level — yields an
     * empty list, and the PUT then strips every other permission the role had
     * while still passing every assertion below. Asserting the count is what
     * turns that into a failure instead of a false pass. */
    const before = (await as('root', '/permissions/roles/head_of_production')).body.role;
    const held = before.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(held.length > 5, `the role really does hold things already — got ${held.length}`);
    assert.ok(!held.includes('settings.chat_activity'), 'and not this one yet');

    const wanted = [...held, 'settings.chat_activity'];
    const saved = await as('root', '/permissions/roles/head_of_production',
      { method: 'PUT', body: { permissions: wanted } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    const after = (await as('root', '/permissions/roles/head_of_production')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.strictEqual(after.length, held.length + 1,
      'exactly one key was added, and nothing was taken away');

    const now = await read('hop');
    assert.strictEqual(now.status, 200, JSON.stringify(now.body));
    assert.ok(now.body.messages.length > 0, 'and they can read it');

    // And their read is recorded under their own name, like anybody else's.
    const mine = await sql(cfg,
      'SELECT actor_email FROM activity_log WHERE action = ? ORDER BY seq DESC LIMIT 1',
      ['chat.activity_viewed']);
    assert.strictEqual(mine[0].actor_email, 'hop@zvky.test');

    // Take it back, and the door shuts again — leaving the rest as it was.
    await as('root', '/permissions/roles/head_of_production', {
      method: 'PUT', body: { permissions: held } });
    assert.strictEqual((await read('hop')).status, 403);
    const restored = (await as('root', '/permissions/roles/head_of_production')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.deepStrictEqual(restored.sort(), [...held].sort(),
      'and the role is exactly where it started');
  });

  await t.test('it changed nothing about chat itself', async () => {
    /* The studio's seventh testing step, and the one worth the most. Root holds
       settings.chat_activity and every other key; none of that opens a
       conversation they are not in through /api/chat. */
    const private_ = (await openDirect('ana', people.bo)).body.conversationId;
    await post('ana', private_, { body: 'still private' });

    assert.strictEqual((await as('root', `/chat/${private_}/messages`)).status, 404,
      'the membership rule is untouched');
    assert.strictEqual((await as('root', `/chat/${private_}`,
      { method: 'PATCH', body: { title: 'x' } })).status, 404);
    assert.ok(!(await as('root', '/chat')).body.conversations.some((c) => c.id === private_),
      'and it is not in their list');

    // The panel's own download still refuses them, id in hand.
    const sent = await post('ana', private_, {
      body: 'and this', file: { name: 'private.png', bytes: PNG, type: 'image/png' } });
    const id = sent.body.message.attachments[0].id;
    const stolen = await fetch(`${server.base}/chat/attachments/${id}`,
      { headers: { Authorization: `Bearer ${token.root}` } });
    assert.strictEqual(stolen.status, 404, 'the panel route still checks membership');

    // Sending a message still writes nothing to the Activity Log.
    const traffic = await sql(cfg,
      "SELECT path FROM activity_log WHERE path LIKE '/api/chat/%messages%'");
    assert.deepStrictEqual(traffic, []);

    // Ordinary chat still works for the people in it.
    const theirs = (await as('ana', `/chat/${private_}/messages`)).body.messages.map((m) => m.body);
    assert.ok(theirs.includes('still private'));
  });

  await t.test('the summary counts without reading, and without logging', async () => {
    /* The header's figures come from their own endpoint on purpose: the section
       can say how much there is before anybody has read anything, which is what
       lets the listing stay behind a button. */
    await sql(cfg, 'DELETE FROM activity_log WHERE action LIKE ?', ['chat.activity%']);
    const res = await as('root', '/chat-activity/summary');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.messages > 0);
    assert.ok(res.body.conversations > 0);
    assert.ok(res.body.groups >= 1);
    assert.strictEqual(res.body.retentionHours, chatFiles.HOURS);
    assert.ok(res.body.filesExpired >= 1, 'and it knows how many have gone');

    const logged = await sql(cfg, 'SELECT * FROM activity_log WHERE action LIKE ?', ['chat.activity%']);
    assert.deepStrictEqual(logged, [],
      'counting is not reading, so it does not write a line somebody would have to explain');
  });

  await t.test('a notice is not an anonymous person', async () => {
    /* "X created this group" is written by the app and has no sender. A text
       message with no sender is one whose author was deleted. The two are
       different facts and the screen used to call both "a removed account",
       which invents a person for the first. What is pinned here is the shape
       the screen reads: kind tells them apart. */
    const res = await read('root', 'kind=group');
    const notice = res.body.messages.find((m) => m.kind !== 'text');
    assert.ok(notice, 'group administration leaves a notice in the record');
    assert.strictEqual(notice.sender, null, 'with no sender');
    assert.ok(notice.body, 'but with something to read');

    const typed = res.body.messages.find((m) => m.kind === 'text');
    assert.ok(typed.sender, 'while a message somebody typed has one');
  });

  await t.test('the response carries the disclosure the screen prints', async () => {
    /* The sentence lives on the server so the screen cannot show one thing
       while the API does another. */
    const res = await read('root');
    assert.match(res.body.notice, /recorded in the Activity Log/);
    assert.match(res.body.notice, new RegExp(`${chatFiles.HOURS} hours`));
  });
});
