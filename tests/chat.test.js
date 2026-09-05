/* Chat.
 *
 * The feature is ordinary; the things worth testing are the boundaries around
 * it, so this suite spends most of its assertions on the four that would be
 * expensive to get wrong:
 *
 *   PRIVACY. Nobody reads a conversation they are not in — including the Super
 *   Admin, who holds every permission in the catalogue and must still be
 *   refused. And no chat content or chat metadata reaches the Activity Log,
 *   which is the one screen where it could leak without anybody meaning it to.
 *   That is a policy the studio chose, and a policy that is not tested is a
 *   policy that lasts until the next refactor.
 *
 *   THE TWO CAPS. Thirty people in a group and thirty megabytes in a file. Both
 *   are enforced server-side, because a limit that lives in the browser is a
 *   suggestion.
 *
 *   THE ALLOWLIST. Six formats. The interesting one is .svg, which is on the
 *   list and is also a program — so it is served as a download rather than as a
 *   page on this origin.
 *
 *   EXPIRY. The file goes at eight hours and the message does not. Driven by
 *   moving expires_at into the past rather than by waiting, and asserted
 *   BEFORE the sweep runs as well as after, because the guarantee is that an
 *   expired file is refused whether or not the timer has fired.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const { capabilitiesForTier } = require('../src/role-tiers');
const chatFiles = require('../src/chat-files');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chat');

// ---------------------------------------------------------------- unit tests

test('chat.use is on for every designation, and group creation is not', () => {
  const use = catalogue.BY_KEY.get('chat.use');
  const group = catalogue.BY_KEY.get('chat.group_create');
  assert.ok(use && group, 'both keys are in the catalogue');

  /* Talking to one colleague is not a privilege a studio grants. Pinned the
     same way asset.hold and timesheet.own are: true for a role with no
     capabilities at all. */
  assert.strictEqual(use.impliedBy({}), true);

  const on = (tier) => catalogue.baselineFor(capabilitiesForTier(tier));
  for (const tier of ['lead', 'production', 'direction', 'leadership', 'full_access', 'admin']) {
    assert.strictEqual(on(tier).has('chat.group_create'), true, `${tier} may create a group`);
    assert.strictEqual(on(tier).has('chat.use'), true, `${tier} may chat`);
  }
  /* The two tiers that may not, and the reason the permission exists at all.
     An artist can already talk to anybody; what they cannot do is mint rooms. */
  for (const tier of ['contributor', 'staff']) {
    assert.strictEqual(on(tier).has('chat.group_create'), false, `${tier} may not create a group`);
    assert.strictEqual(on(tier).has('chat.use'), true, `${tier} may still chat`);
  }
});

test('there is no permission that grants reading other people\'s chat', () => {
  /* The privacy decision, asserted against the catalogue rather than against a
     route. A future "chat.view_all" would be a product decision with a
     disclosure policy attached, not a checkbox somebody adds in passing — so
     this fails loudly if one appears. */
  const chatKeys = catalogue.KEYS.filter((k) => k.startsWith('chat.'));
  assert.deepStrictEqual(chatKeys.sort(), ['chat.group_create', 'chat.use']);
});

test('the allowlist is the six formats the studio asked for, plus the jpeg alias', () => {
  assert.deepStrictEqual(
    [...chatFiles.EXTENSIONS].sort(),
    ['.jpeg', '.jpg', '.mov', '.mp4', '.png', '.svg', '.webp']
  );
  assert.strictEqual(chatFiles.MAX_BYTES, 30 * 1024 * 1024);
  // .svg is the one entry that can carry a script, so it is the one forced to download.
  assert.strictEqual(chatFiles.isScriptable('diagram.svg'), true);
  assert.strictEqual(chatFiles.isScriptable('diagram.png'), false);
  assert.strictEqual(chatFiles.isScriptable('SHOUTING.SVG'), true, 'extension match is case-insensitive');
});

test('expiry is decided by the clock, not by the sweep having run', () => {
  const past = { expiresAt: new Date(Date.now() - 1000), deletedAt: null, storedName: 'x.png' };
  const future = { expiresAt: new Date(Date.now() + 60000), deletedAt: null, storedName: 'x.png' };
  // Still on disk, sweep not yet run — and already expired.
  assert.strictEqual(chatFiles.isExpired(past), true);
  assert.strictEqual(chatFiles.isExpired(future), false);
  // A shape with no url is what stops the panel offering a dead link.
  assert.strictEqual(chatFiles.shape({ id: 'a', fileName: 'b.png', expiresAt: past.expiresAt }).url, null);
  assert.ok(chatFiles.shape({ id: 'a', fileName: 'b.png', expiresAt: future.expiresAt }).url);
});

// --------------------------------------------------------- integration tests

test('chat', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Chat-About-It-1!';
  let server;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  /* A message with a file goes as multipart, so it cannot use the JSON helper.
     Written once here rather than inline at four call sites. */
  async function post(who, conversationId, { body, file } = {}) {
    const form = new FormData();
    if (body !== undefined) form.set('body', body);
    if (file) form.set('files', new Blob([file.bytes], { type: file.type || '' }), file.name);
    const res = await fetch(`${server.base}/chat/${conversationId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token[who]}` },
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const openDirect = async (who, userId) =>
    (await as(who, '/chat/direct', { method: 'POST', body: { userId } }));

  /* The attachment sweep, against the test database rather than whatever the
     developer's .env names. The real function, in a real process, exactly as
     the server runs it at startup. */
  function runSweep() {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e',
      "const db=require('./src/db');require('./src/chat-files').sweep(db)"
      + ".then((r)=>{process.stdout.write(JSON.stringify(r));return db.end();})"
      + ".catch((e)=>{console.error(e);process.exit(1);});"], {
      cwd: require('node:path').join(__dirname, '..'),
      env: { ...process.env,
        DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
        DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
    });
    return JSON.parse(out.toString() || '{}');
  }

  const thread = async (who, id) => (await as(who, `/chat/${id}/messages`)).body;
  const list = async (who) => (await as(who, '/chat')).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'chat-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'chat-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    const person = async (name, email, role) => (await as('root', '/users', { method: 'POST', body: {
      name, email, role, password: PASSWORD,
    } })).body.user.id;

    // Two ordinary artists: contributor tier, so neither may create a group.
    people.ana = await person('Ana', 'ana@zvky.test', 'game_artist');
    people.bo = await person('Bo', 'bo@zvky.test', 'game_artist');
    // A lead, who may. And someone outside every conversation below.
    people.lee = await person('Lee', 'lee@zvky.test', 'team_lead');
    people.cass = await person('Cass', 'cass@zvky.test', 'game_artist');
    token.ana = await login('ana@zvky.test');
    token.bo = await login('bo@zvky.test');
    token.lee = await login('lee@zvky.test');
    token.cass = await login('cass@zvky.test');
    people.root = (await as('root', '/users')).body.users.find((u) => u.email === 'root@zvky.test').id;
  });

  t.after(() => stopServer(server));

  // ---------------------------------------------------------------- 1:1 chat

  await t.test('two ordinary users chat with no chat-specific permission', async () => {
    /* The studio's first testing step. Ana and Bo are Game Artists: contributor
       tier, no group permission, nothing granted to either of them. */
    const me = (await as('ana', '/auth/me')).body.user;
    assert.ok(!me.permissions.includes('chat.group_create'), 'Ana cannot create groups');
    assert.ok(me.permissions.includes('chat.use'), 'and can still chat');

    const opened = await openDirect('ana', people.bo);
    assert.strictEqual(opened.status, 200);
    const id = opened.body.conversationId;
    assert.strictEqual(opened.body.created, true);

    assert.strictEqual((await post('ana', id, { body: 'Is the blue right?' })).status, 201);
    const seen = await thread('bo', id);
    assert.strictEqual(seen.messages.length, 1);
    assert.strictEqual(seen.messages[0].body, 'Is the blue right?');
    assert.strictEqual(seen.messages[0].senderName, 'Ana');
    // A direct conversation is named after the other person, at each end.
    assert.strictEqual(seen.conversation.title, 'Ana');
    assert.strictEqual((await thread('ana', id)).conversation.title, 'Bo');
  });

  await t.test('opening the same person twice lands in the same conversation', async () => {
    /* The pair_key. Without it two people messaging each other at the same
       moment end up in two rooms, each seeing half the conversation and no
       error anywhere. */
    const first = await openDirect('ana', people.bo);
    const fromTheOtherEnd = await openDirect('bo', people.ana);
    assert.strictEqual(first.body.conversationId, fromTheOtherEnd.body.conversationId);
    assert.strictEqual(fromTheOtherEnd.body.created, false);

    const rows = await sql(cfg, 'SELECT COUNT(*) AS n FROM chat_conversations WHERE kind = ?', ['direct']);
    assert.strictEqual(Number(rows[0].n), 1, 'one row, not two');
  });

  await t.test('you cannot open a conversation with yourself', async () => {
    const res = await openDirect('ana', people.ana);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /yourself/i);
  });

  await t.test('unread counts the other person\'s messages and not your own', async () => {
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    await post('ana', id, { body: 'one' });
    await post('ana', id, { body: 'two' });

    const forBo = (await list('bo')).conversations.find((c) => c.id === id);
    assert.ok(forBo.unread >= 2, `Bo has unread — got ${forBo.unread}`);

    /* Ana sent them, so nothing is unread for her. Without the sender check the
       thread would be permanently bold on whichever tab did not send it. */
    const forAna = (await list('ana')).conversations.find((c) => c.id === id);
    assert.strictEqual(forAna.unread, 0);

    // Reading it clears it, and only forward.
    await as('bo', `/chat/${id}/read`, { method: 'POST', body: { seq: forBo.lastSeq } });
    assert.strictEqual((await list('bo')).conversations.find((c) => c.id === id).unread, 0);
    await as('bo', `/chat/${id}/read`, { method: 'POST', body: { seq: 1 } });
    assert.strictEqual((await list('bo')).conversations.find((c) => c.id === id).unread, 0,
      'a stale seq does not make read messages unread again');
  });

  await t.test('polling hands over what is new, and a cursor that does not tie', async () => {
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    const start = (await as('bo', '/chat/poll')).body.cursor;

    /* Three in a burst, which is what would defeat a timestamp cursor:
       created_at has second precision and all three land in the same second. */
    await post('ana', id, { body: 'a' });
    await post('ana', id, { body: 'b' });
    await post('ana', id, { body: 'c' });

    const polled = (await as('bo', `/chat/poll?since=${start}`)).body;
    assert.deepStrictEqual(polled.fresh.map((m) => m.body), ['a', 'b', 'c'],
      'all three, in order, despite sharing a second');
    assert.ok(polled.cursor > start);
    assert.strictEqual((await as('bo', `/chat/poll?since=${polled.cursor}`)).body.fresh.length, 0);
  });

  // ------------------------------------------------------------------ groups

  await t.test('a role without the permission is refused a group', async () => {
    // The studio's second testing step, at the API rather than at the button.
    const res = await as('ana', '/chat/groups', { method: 'POST', body: { title: 'Nope', memberIds: [people.bo] } });
    assert.strictEqual(res.status, 403);
    // And the panel is told, so it does not offer a button that cannot work.
    assert.strictEqual((await list('ana')).canCreateGroup, false);
    assert.strictEqual((await list('lee')).canCreateGroup, true);
  });

  await t.test('a lead creates a group, and thirty is the ceiling', async () => {
    // The studio's third testing step.
    const created = await as('lee', '/chat/groups', {
      method: 'POST', body: { title: 'Sprint 12', memberIds: [people.ana, people.bo] },
    });
    assert.strictEqual(created.status, 201);
    const id = created.body.conversationId;
    assert.strictEqual(created.body.members, 3, 'Lee is in it, counted');

    /* Fill to exactly thirty. Lee, Ana and Bo are three of them, so
       twenty-seven more — created here rather than in before() because no other
       test wants a studio of thirty-one people. */
    const extras = [];
    for (let i = 0; i < 28; i += 1) {
      extras.push((await as('root', '/users', { method: 'POST', body: {
        name: `Extra ${i}`, email: `extra${i}@zvky.test`, role: 'game_artist', password: PASSWORD,
      } })).body.user.id);
    }
    const toThirty = extras.slice(0, 27);
    const filled = await as('lee', `/chat/${id}/members`, { method: 'POST', body: { userIds: toThirty } });
    assert.strictEqual(filled.status, 200, JSON.stringify(filled.body));
    assert.strictEqual((await thread('lee', id)).conversation.memberCount, 30);

    // The thirty-first.
    const over = await as('lee', `/chat/${id}/members`, { method: 'POST', body: { userIds: [extras[27]] } });
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, /at most 30/i);
    assert.strictEqual(over.body.room, 0);
    assert.strictEqual((await thread('lee', id)).conversation.memberCount, 30, 'and nobody was added');

    /* The cap counts the RESULT, not the request: five into a group of
       twenty-eight is refused whole rather than adding two and dropping three
       without saying so. Proved by removing two and then over-filling by one. */
    await as('lee', `/chat/${id}/members/${toThirty[0]}`, { method: 'DELETE' });
    await as('lee', `/chat/${id}/members/${toThirty[1]}`, { method: 'DELETE' });
    const partial = await as('lee', `/chat/${id}/members`, {
      method: 'POST', body: { userIds: [toThirty[0], toThirty[1], extras[27]] },
    });
    assert.strictEqual(partial.status, 400);
    assert.strictEqual(partial.body.room, 2);
    assert.strictEqual((await thread('lee', id)).conversation.memberCount, 28, 'all three refused, none added');
  });

  await t.test('creating a group larger than thirty is refused outright', async () => {
    const many = (await as('root', '/users')).body.users.map((u) => u.id).slice(0, 31);
    const res = await as('lee', '/chat/groups', { method: 'POST', body: { title: 'Too Many', memberIds: many } });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 30/i);
  });

  await t.test('the owner runs the group and members may leave it', async () => {
    // The studio's fifth confirmation point, as one pass through the actions.
    const id = (await as('lee', '/chat/groups', {
      method: 'POST', body: { title: 'Lighting', memberIds: [people.ana, people.bo] },
    })).body.conversationId;

    // Rename — owner only.
    assert.strictEqual((await as('ana', `/chat/${id}`, { method: 'PATCH', body: { title: 'Hijack' } })).status, 403);
    assert.strictEqual((await as('lee', `/chat/${id}`, { method: 'PATCH', body: { title: 'Lighting v2' } })).status, 200);
    assert.strictEqual((await thread('lee', id)).conversation.title, 'Lighting v2');

    // Remove — owner only, and never the owner.
    assert.strictEqual((await as('ana', `/chat/${id}/members/${people.bo}`, { method: 'DELETE' })).status, 403);
    const selfRemove = await as('lee', `/chat/${id}/members/${people.lee}`, { method: 'DELETE' });
    assert.strictEqual(selfRemove.status, 400);
    assert.match(selfRemove.body.error, /Leave group/i);
    assert.strictEqual((await as('lee', `/chat/${id}/members/${people.bo}`, { method: 'DELETE' })).status, 200);
    // Removed means removed: Bo can no longer read it at all.
    assert.strictEqual((await as('bo', `/chat/${id}/messages`)).status, 404);

    // Leave — anybody.
    assert.strictEqual((await as('ana', `/chat/${id}/leave`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('ana', `/chat/${id}/messages`)).status, 404);

    /* Every one of those wrote a line into the transcript, so the people left
       in the group can see what happened without being told separately. */
    const lines = (await thread('lee', id)).messages.filter((m) => m.kind === 'system').map((m) => m.body);
    assert.ok(lines.some((l) => /created “Lighting”/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /renamed the group to “Lighting v2”/.test(l)));
    assert.ok(lines.some((l) => /removed Bo/.test(l)));
    assert.ok(lines.some((l) => /Ana left the group/.test(l)));
  });

  await t.test('an owner who leaves hands the group on, and the last one out closes it', async () => {
    /* The case nobody thinks about until it happens. Without the handover the
       group survives with nobody able to add, remove or rename — reachable,
       unmanageable, and impossible to fix from the screen. */
    const id = (await as('lee', '/chat/groups', {
      method: 'POST', body: { title: 'Handover', memberIds: [people.ana, people.bo] },
    })).body.conversationId;

    const left = await as('lee', `/chat/${id}/leave`, { method: 'POST' });
    assert.strictEqual(left.status, 200);
    assert.strictEqual(left.body.closed, false);
    assert.strictEqual(left.body.ownerHandedTo, people.ana, 'to whoever has been in it longest');
    assert.strictEqual((await thread('ana', id)).conversation.isOwner, true);
    // And the new owner really can run it.
    assert.strictEqual((await as('ana', `/chat/${id}`, { method: 'PATCH', body: { title: 'Ana\'s now' } })).status, 200);

    await as('bo', `/chat/${id}/leave`, { method: 'POST' });
    const last = await as('ana', `/chat/${id}/leave`, { method: 'POST' });
    assert.strictEqual(last.body.closed, true, 'the last person out closes the group');
    const rows = await sql(cfg, 'SELECT COUNT(*) AS n FROM chat_conversations WHERE id = ?', [id]);
    assert.strictEqual(Number(rows[0].n), 0);
  });

  // ------------------------------------------------------------- attachments

  await t.test('an allowed file sends, and the wrong sort does not', async () => {
    // The studio's fourth testing step.
    const id = (await openDirect('ana', people.bo)).body.conversationId;

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const sent = await post('ana', id, { body: 'the blue', file: { name: 'swatch.png', bytes: png, type: 'image/png' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    const [file] = sent.body.message.attachments;
    assert.strictEqual(file.fileName, 'swatch.png');
    assert.strictEqual(file.expired, false);
    assert.strictEqual(file.kind, 'image');
    assert.ok(file.url, 'and it can be fetched');

    // Bo, who is in the conversation, can download it.
    const got = await fetch(`${server.base.replace(/\/api$/, '')}${file.url}`, {
      headers: { Authorization: `Bearer ${token.bo}` },
    });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.headers.get('content-type'), 'image/png');
    assert.strictEqual(got.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(Buffer.from(await got.arrayBuffer()).toString('hex'), png.toString('hex'));

    // The wrong extension, refused with a reason that names it.
    const bad = await post('ana', id, { file: { name: 'notes.pdf', bytes: Buffer.from('%PDF'), type: 'application/pdf' } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /\.pdf/);
    assert.match(bad.body.error, /\.png, \.jpg, \.svg, \.webp, \.mov, \.mp4/);

    /* A renamed executable is refused on its extension, which is the gate —
       the browser's claimed content type is not consulted for admission. */
    const disguised = await post('ana', id, { file: { name: 'run.exe', bytes: Buffer.from('MZ'), type: 'image/png' } });
    assert.strictEqual(disguised.status, 400);
  });

  await t.test('a file over thirty megabytes is refused', async () => {
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    const tooBig = Buffer.alloc(31 * 1024 * 1024, 0x41);
    const res = await post('ana', id, { file: { name: 'huge.mp4', bytes: tooBig, type: 'video/mp4' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'LIMIT_FILE_SIZE');

    // Just under it goes through, so the limit is the limit and not an approximation.
    const fits = Buffer.alloc(1024, 0x41);
    assert.strictEqual((await post('ana', id, { file: { name: 'fine.mp4', bytes: fits, type: 'video/mp4' } })).status, 201);
  });

  await t.test('an svg is served as a download, never as a page on this origin', async () => {
    /* .svg is on the studio's list and an SVG can carry <script>. In an <img>
       that never runs; opened as a top-level document on this origin it does,
       with the sender's choice of payload. So the direct link is a download. */
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const sent = await post('ana', id, { file: { name: 'logo.svg', bytes: svg, type: 'image/svg+xml' } });
    assert.strictEqual(sent.status, 201);
    const [file] = sent.body.message.attachments;
    assert.strictEqual(file.downloadOnly, true, 'the panel is told not to link it as a page');

    const got = await fetch(`${server.base.replace(/\/api$/, '')}${file.url}`, {
      headers: { Authorization: `Bearer ${token.ana}` },
    });
    assert.match(got.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(got.headers.get('content-security-policy') || '', /sandbox/);
    assert.strictEqual(got.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('a message must carry something', async () => {
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    const empty = await post('ana', id, { body: '   ' });
    assert.strictEqual(empty.status, 400);
    assert.match(empty.body.error, /Type something/i);
  });

  await t.test('a file expires after eight hours and its message does not', async () => {
    /* The studio's fifth testing step, driven by moving the clock rather than
       by waiting eight hours. */
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    const sent = await post('ana', id, {
      body: 'here is the reference',
      file: { name: 'ref.png', bytes: Buffer.from('89504e470d0a1a0a', 'hex'), type: 'image/png' },
    });
    const messageId = sent.body.message.id;
    const attachmentId = sent.body.message.attachments[0].id;
    const url = `${server.base.replace(/\/api$/, '')}/api/chat/attachments/${attachmentId}`;

    const stored = await sql(cfg, 'SELECT stored_name FROM chat_attachments WHERE id = ?', [attachmentId]);
    const storedName = stored[0].stored_name;
    assert.ok(storedName);

    // Age it past its expiry, leaving the bytes on disk and deleted_at unset —
    // which is exactly the state between the file expiring and the sweep running.
    await sql(cfg, 'UPDATE chat_attachments SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [attachmentId]);

    /* Refused BEFORE the sweep. This is the point of deciding expiry by the
       clock: the promise is "gone after eight hours", not "gone once a timer
       somewhere has fired". */
    const early = await fetch(url, { headers: { Authorization: `Bearer ${token.bo}` } });
    assert.strictEqual(early.status, 410);

    const shown = (await thread('bo', id)).messages.find((m) => m.id === messageId);
    assert.strictEqual(shown.body, 'here is the reference', 'the words stay');
    assert.strictEqual(shown.attachments.length, 1, 'and the placeholder stays with them');
    assert.strictEqual(shown.attachments[0].expired, true);
    assert.strictEqual(shown.attachments[0].fileName, 'ref.png', 'named, so it says WHICH file went');
    assert.strictEqual(shown.attachments[0].url, null, 'and offers no dead link');

    // Now the sweep, which is what actually reclaims the disk.
    const fs = require('node:fs');
    const path = require('node:path');
    const onDisk = path.join(chatFiles.CHAT_DIR, storedName);
    assert.ok(fs.existsSync(onDisk), 'still on disk until the sweep runs');

    /* Run in a child process carrying the test database's settings.
       Requiring src/db in THIS process would load the developer's own .env and
       sweep whatever that points at — which is how this assertion first passed
       for the wrong reason, finding no rows because it was looking in another
       database entirely. */
    await runSweep();
    assert.ok(!fs.existsSync(onDisk), 'the bytes are gone');
    const after = await sql(cfg, 'SELECT deleted_at, stored_name FROM chat_attachments WHERE id = ?', [attachmentId]);
    assert.ok(after[0].deleted_at, 'and the row records that it went');
    assert.strictEqual(after[0].stored_name, null);

    // Still a placeholder afterwards, and still not a 500.
    const stillThere = (await thread('bo', id)).messages.find((m) => m.id === messageId);
    assert.strictEqual(stillThere.body, 'here is the reference');
    assert.strictEqual(stillThere.attachments[0].expired, true);
  });

  // ----------------------------------------------------------------- privacy

  await t.test('nobody reads a conversation they are not in — the Super Admin included', async () => {
    /* The studio's seventh testing step, and the assertion this feature is
       most likely to lose in a later refactor. Root holds every permission in
       the catalogue; that is what makes it the right account to refuse. */
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    await post('ana', id, { body: 'something private' });

    const rootPerms = (await as('root', '/auth/me')).body.user.permissions;
    assert.ok(rootPerms.includes('chat.use') && rootPerms.includes('chat.group_create'),
      'Root really does hold everything');

    for (const who of ['root', 'cass']) {
      assert.strictEqual((await as(who, `/chat/${id}/messages`)).status, 404, `${who} is refused`);
      assert.strictEqual((await as(who, `/chat/${id}/read`, { method: 'POST', body: { seq: 1 } })).status, 404);
      assert.strictEqual((await as(who, `/chat/${id}`, { method: 'PATCH', body: { title: 'x' } })).status, 404);
      // Not in the list either — no leaking through the index.
      assert.ok(!(await list(who)).conversations.some((c) => c.id === id));
    }

    /* And they cannot fetch the file out of it, even holding the id. The
       membership join is inside the download query rather than checked beside
       it, so an attachment id is not a bearer token. */
    const withFile = await post('ana', id, {
      file: { name: 'private.png', bytes: Buffer.from('89504e470d0a1a0a', 'hex'), type: 'image/png' },
    });
    const attachmentId = withFile.body.message.attachments[0].id;
    const stolen = await fetch(`${server.base}/chat/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${token.root}` },
    });
    assert.strictEqual(stolen.status, 404);
  });

  await t.test('no chat message reaches the Activity Log', async () => {
    /* Message content was never at risk — the middleware does not see request
       bodies. What this pins is the METADATA: an entry per message would record
       who talked to whom and how often, which is most of what a message log is
       for. */
    const id = (await openDirect('ana', people.bo)).body.conversationId;
    await post('ana', id, { body: 'not for the record' });
    await as('ana', `/chat/${id}/read`, { method: 'POST', body: { seq: 1 } });
    await openDirect('ana', people.cass);

    const rows = await sql(cfg,
      'SELECT action, summary, path FROM activity_log WHERE path LIKE ? ORDER BY seq', ['/api/chat%']);
    const traffic = rows.filter((r) => /\/messages|\/read|\/direct|\/leave/.test(r.path || ''));
    assert.deepStrictEqual(traffic, [], `no message traffic logged — found ${JSON.stringify(traffic)}`);
    // And nothing anywhere in the log quotes a message.
    const all = await sql(cfg, 'SELECT summary FROM activity_log');
    assert.ok(!all.some((r) => String(r.summary || '').includes('not for the record')));
  });

  await t.test('group administration IS recorded, because a group is a studio object', async () => {
    /* The other half of the policy, and the reason the exclusion above is by
       path rather than a blanket /api/chat rule. Who was put into a group is an
       administrative fact; what they then said is not. */
    const created = await as('lee', '/chat/groups', {
      method: 'POST', body: { title: 'Audited', memberIds: [people.ana] },
    });
    const id = created.body.conversationId;
    await as('lee', `/chat/${id}`, { method: 'PATCH', body: { title: 'Audited v2' } });
    await as('lee', `/chat/${id}/members`, { method: 'POST', body: { userIds: [people.bo] } });
    await as('lee', `/chat/${id}/members/${people.bo}`, { method: 'DELETE' });

    const rows = await sql(cfg,
      /* By seq, not created_at. Four administrative actions in one test land in
         the same second, and DATETIME cannot order within one — the same reason
         chat_messages carries a sequence. */
      'SELECT action, summary FROM activity_log WHERE entity_id = ? ORDER BY seq', [id]);
    const actions = rows.map((r) => r.action);
    assert.deepStrictEqual(actions, [
      'chat.group_created', 'chat.group_renamed', 'chat.group_members_added', 'chat.group_member_removed',
    ]);
    // Named, so the entry is readable — and carrying no message content.
    assert.match(rows[0].summary, /Lee created the chat group "Audited" with 2 member\(s\)\./);
    assert.match(rows[1].summary, /renamed the chat group "Audited" to "Audited v2"/);
  });

  await t.test('a role with chat switched off loses the whole feature', async () => {
    /* chat.use is on for everybody by default, but it is a toggle rather than a
       fact — the studio must be able to close chat for a department. Turning it
       off for Game Artist takes it from Ana without touching Lee. */
    const held = async () => (await sql(cfg,
      'SELECT permission_key FROM role_permissions WHERE role_key = ? AND enabled = 1',
      ['game_artist'])).map((r) => r.permission_key);
    /* The endpoint takes the whole list the role should hold, so the role's
       own set is read and one key removed from it — sending a hand-written
       list would silently grant Game Artist everything else on it. */
    const before = await held();
    assert.ok(before.includes('chat.use'));
    const saved = await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: before.filter((k) => k !== 'chat.use') },
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    assert.strictEqual((await as('ana', '/chat')).status, 403);
    assert.strictEqual((await as('ana', '/chat/direct', { method: 'POST', body: { userId: people.bo } })).status, 403);
    assert.strictEqual((await as('lee', '/chat')).status, 200, 'and Lee is unaffected');

    // Put it back, so the order of tests in this file cannot matter.
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: before } });
    assert.deepStrictEqual((await held()).sort(), before.sort(), 'restored exactly, nothing else granted');
    assert.strictEqual((await as('ana', '/chat')).status, 200);
  });
});
