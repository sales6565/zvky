/* GROUP ADMINS, END TO END ON THE SERVER.
 *
 * ===========================================================================
 * THE AUTHORISATION MATRIX IS THE POINT OF THIS FILE. Five kinds of caller
 * against every group action, asserted as a table — including every action that
 * was allowed before this feature existed, because the one thing a delegated
 * role must not do is quietly take something away from the people who already
 * had it.
 *
 * WHAT IS DELIBERATELY NOT HERE. The decision function itself is covered by
 * tests/chat-group-roles.test.js, which also proves the page's copy of it is
 * the same text. This file is about the routes: that they ask it, that they ask
 * it with the right role and the right target, and that everything else about
 * the change — membership, the owner, idempotence, the transaction — holds.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatadmins');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Group-Admins-11!';

test('who may do what in a group', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'admins', CHAT_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'admins', name: 'Root', email: 'root@ga.test', password: PASSWORD } });
    tok.root = await login('root@ga.test');
    /* FIVE PEOPLE AND FIVE PARTS. Ana owns the group, Bo is the admin, Cas is
       an ordinary member, Dee is in the studio and not in the group, and Root
       is the Super Admin — who is a member of the group in the cases that need
       them to be, and is not here, because chat.group_manage_any deliberately
       does not reach past membership. */
    /* ANA IS A TEAM LEAD because creating a group needs chat.group_create, which
       an artist's designation does not carry — "chat.use is on for every
       designation, and group creation is not" is pinned by tests/chat.test.js.
       Her designation decides nothing else here: every rule under test is about
       her role IN THE GROUP, and tests/chat-group-roles.test.js proves the
       decision function never sees a Forge designation at all. */
    for (const [who, name, role] of [['ana', 'Ana', 'team_lead'], ['bo', 'Bo', 'game_artist'],
      ['cas', 'Cas', 'game_artist'], ['dee', 'Dee', 'game_artist']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@ga.test`, password: PASSWORD, role } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      id[who] = made.body.user.id;
      tok[who] = await login(`${who}@ga.test`);
    }
    id.root = (await as('root', '/auth/me')).body.user.id;
  });
  t.after(() => { if (server) stopServer(server); });

  /* A fresh group for each case that changes anything, so one case cannot leave
     the next one a group in a state it did not ask for. */
  const makeGroup = async (title, members = ['bo', 'cas']) => {
    const r = await as('ana', '/chat/groups', { method: 'POST',
      body: { title, memberIds: members.map((m) => id[m]) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.conversationId;
  };
  const promote = (who, group, target, role = 'admin') => as(who,
    `/chat/groups/${group}/members/${id[target]}`, { method: 'PATCH', body: { role } });
  const membersOf = async (who, group) =>
    (await as(who, `/chat/${group}/messages`)).body.conversation.members;
  const roleOf = async (who, group, target) =>
    ((await membersOf(who, group)).find((m) => m.id === id[target]) || {}).groupRole;

  await t.test('a new group has one owner and the rest are members', async () => {
    const group = await makeGroup('Roles at the start');
    const members = await membersOf('ana', group);
    assert.deepStrictEqual(members.map((m) => [m.name, m.groupRole]).sort(),
      [['Ana', 'owner'], ['Bo', 'member'], ['Cas', 'member']].sort());
    /* AND THE OWNER'S TWO COLUMNS AGREE. They say the same thing in two shapes
       for a documented reason; a pair that can drift is a bug waiting for its
       first week in production. */
    const rows = await sql(cfg,
      'SELECT user_id AS u, is_owner AS o, group_role AS r FROM chat_members WHERE conversation_id = ?',
      [group]);
    for (const row of rows) {
      assert.strictEqual(Number(row.o) === 1, row.r === 'owner',
        `is_owner and group_role agree for ${row.u}: ${row.o} / ${row.r}`);
    }
    /* The viewer is told their own role, resolved by the server. */
    assert.strictEqual((await as('ana', `/chat/${group}/messages`)).body.conversation.myRole, 'owner');
    assert.strictEqual((await as('cas', `/chat/${group}/messages`)).body.conversation.myRole, 'member');
  });

  await t.test('THE MATRIX: every caller against every action', async (tt) => {
    /* One group, set up once: Ana owns it, Bo is an admin, Cas is a member,
       Root is in it too so that the Super Admin's row is about permissions
       rather than about membership. Dee is outside it. */
    const group = await makeGroup('The matrix', ['bo', 'cas', 'root']);
    assert.strictEqual((await promote('ana', group, 'bo')).status, 200);

    /* Each row: who tries it, what they try, and what the server must answer.
       `ok` means the action succeeded; anything else is the status. Actions are
       run in an order that leaves the group as it started, so the table can be
       read as a matrix rather than as a sequence. */
    const attempts = [
      // --- promote / demote: the owner's alone -----------------------------
      /* THE PERMISSION IS CHECKED BEFORE THE TARGET, which is why an admin
         demoting THEMSELVES is 403 and not the 400 that "you cannot change your
         own role" would give: they were never allowed to change a role at all,
         and answering about the target first would tell a caller something
         about the group before establishing they may ask. */
      ['admin promoting',        'bo',   () => promote('bo', group, 'cas'),            403],
      ['member promoting',       'cas',  () => promote('cas', group, 'bo'),            403],
      ['non-member promoting',   'dee',  () => promote('dee', group, 'cas'),           404],
      ['admin demoting themselves', 'bo', () => promote('bo', group, 'bo', 'member'),  403],
      ['member demoting another','cas',  () => promote('cas', group, 'bo', 'member'),  403],
      // --- renaming: owner and admin, not a member -------------------------
      ['owner renaming',         'ana',  () => as('ana', `/chat/${group}`, { method: 'PATCH', body: { title: 'The matrix' } }), 200],
      ['admin renaming',         'bo',   () => as('bo', `/chat/${group}`, { method: 'PATCH', body: { title: 'The matrix' } }),  200],
      ['member renaming',        'cas',  () => as('cas', `/chat/${group}`, { method: 'PATCH', body: { title: 'Mine now' } }),   403],
      ['non-member renaming',    'dee',  () => as('dee', `/chat/${group}`, { method: 'PATCH', body: { title: 'Mine now' } }),   404],
      // --- adding: owner and admin, not a member ---------------------------
      ['member adding',          'cas',  () => as('cas', `/chat/${group}/members`, { method: 'POST', body: { userIds: [id.dee] } }), 403],
      ['non-member adding',      'dee',  () => as('dee', `/chat/${group}/members`, { method: 'POST', body: { userIds: [id.dee] } }), 404],
      // --- removing: depends on the target's role ---------------------------
      ['member removing anybody','cas',  () => as('cas', `/chat/${group}/members/${id.bo}`, { method: 'DELETE' }),   403],
      ['admin removing the owner','bo',  () => as('bo', `/chat/${group}/members/${id.ana}`, { method: 'DELETE' }),   403],
      /* UNCHANGED FROM BEFORE THIS PROMPT: the owner aiming Remove at
         themselves is told to use Leave group, which is what they want. The
         capability check is deliberately not consulted for a self-target — see
         the note on the route. */
      ['owner removing the owner','ana', () => as('ana', `/chat/${group}/members/${id.ana}`, { method: 'DELETE' }),  400],
      ['non-member removing',    'dee',  () => as('dee', `/chat/${group}/members/${id.cas}`, { method: 'DELETE' }),  404],
    ];
    for (const [what, , run, want] of attempts) {
      const r = await run();
      assert.strictEqual(r.status, want, `${what}: expected ${want}, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    /* AND THE GROUP IS EXACTLY AS IT WAS. Every refusal above refused. */
    const after = await membersOf('ana', group);
    assert.deepStrictEqual(after.map((m) => [m.name, m.groupRole]).sort(),
      [['Ana', 'owner'], ['Bo', 'admin'], ['Cas', 'member'], ['Root', 'member']].sort());

    await tt.test('an admin may remove an ordinary member, and does', async () => {
      const r = await as('bo', `/chat/${group}/members/${id.cas}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(!(await membersOf('ana', group)).some((m) => m.id === id.cas));
      /* And put back, as a MEMBER, by the admin who removed them. */
      const back = await as('bo', `/chat/${group}/members`, { method: 'POST', body: { userIds: [id.cas] } });
      assert.strictEqual(back.status, 200, JSON.stringify(back.body));
      assert.strictEqual(await roleOf('ana', group, 'cas'), 'member');
    });

    await tt.test('an admin may not remove another admin', async () => {
      assert.strictEqual((await promote('ana', group, 'cas')).status, 200);
      const r = await as('bo', `/chat/${group}/members/${id.cas}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
      assert.strictEqual(await roleOf('ana', group, 'cas'), 'admin', 'and they are still an admin');
      /* THE OWNER MAY. Which is the asymmetry the whole role exists for. */
      const owner = await as('ana', `/chat/${group}/members/${id.cas}`, { method: 'DELETE' });
      assert.strictEqual(owner.status, 200, JSON.stringify(owner.body));
    });

    await tt.test('anybody in the group may leave it, admin included', async () => {
      const own = await makeGroup('Leaving', ['bo', 'cas']);
      assert.strictEqual((await promote('ana', own, 'bo')).status, 200);
      const r = await as('bo', `/chat/${own}/leave`, { method: 'POST' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(!(await membersOf('ana', own)).some((m) => m.id === id.bo));
    });
  });

  await t.test('the endpoint refuses everything it should', async () => {
    const group = await makeGroup('Refusals');

    /* THE TARGET MUST BE A CURRENT MEMBER. */
    assert.strictEqual((await promote('ana', group, 'dee')).status, 404);

    /* NOT THE OWNER, by either route into it. */
    const asOwner = await promote('ana', group, 'ana');
    assert.strictEqual(asOwner.status, 400);
    assert.match(asOwner.body.error, /your own role/i, 'self is refused as self, not as owner');

    /* NOT A ROLE THIS FEATURE HANDS OUT. 'owner' is the one that matters: the
       studio must be able to rely on this never moving ownership. */
    for (const role of ['owner', 'Admin', '', 'super_admin', 'root', null]) {
      const r = await as('ana', `/chat/groups/${group}/members/${id.cas}`,
        { method: 'PATCH', body: { role } });
      assert.strictEqual(r.status, 400, `${JSON.stringify(role)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /admin or member|Ownership cannot/i);
    }

    /* A ONE-TO-ONE HAS NO ROLES AT ALL. */
    const direct = (await as('ana', '/chat/direct', { method: 'POST', body: { userId: id.bo } }))
      .body.conversationId;
    const onOne = await as('ana', `/chat/groups/${direct}/members/${id.bo}`,
      { method: 'PATCH', body: { role: 'admin' } });
    assert.strictEqual(onOne.status, 400);
    assert.match(onOne.body.error, /one-to-one/i);

    /* AN UNKNOWN GROUP IS A CLEAN REFUSAL, not a stack trace: mine() answers
       404 for a conversation the caller is not in, which includes one that does
       not exist. */
    const nowhere = await as('ana', `/chat/groups/00000000-0000-0000-0000-000000000000/members/${id.cas}`,
      { method: 'PATCH', body: { role: 'admin' } });
    assert.strictEqual(nowhere.status, 404);
    assert.ok(String(nowhere.body.error || '').length > 5, 'with a sentence');

    /* AN UNKNOWN PERSON IN A REAL GROUP: not a member, so not a target. */
    const ghost = await as('ana', `/chat/groups/${group}/members/00000000-0000-0000-0000-000000000000`,
      { method: 'PATCH', body: { role: 'admin' } });
    assert.strictEqual(ghost.status, 404);
  });

  await t.test('promoting twice is one promotion, one system line, one log entry', async () => {
    const group = await makeGroup('Idempotence');
    await sql(cfg, "DELETE FROM activity_log WHERE action = 'chat.group_admin_changed'");

    const first = await promote('ana', group, 'bo');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.changed, true);
    const second = await promote('ana', group, 'bo');
    assert.strictEqual(second.status, 200, 'a second press succeeds');
    assert.strictEqual(second.body.changed, false, 'and says nothing changed');
    assert.strictEqual(second.body.role, 'admin');

    const lines = await sql(cfg,
      "SELECT summary FROM activity_log WHERE action = 'chat.group_admin_changed'");
    assert.strictEqual(lines.length, 1, 'one log entry, not two');
    assert.match(lines[0].summary, /made Bo an admin/);

    const said = await sql(cfg,
      "SELECT body FROM chat_messages WHERE conversation_id = ? AND kind = 'system' AND body LIKE '%admin%'",
      [group]);
    assert.strictEqual(said.length, 1, 'one system message, not two');
    assert.match(said[0].body, /Ana made Bo an admin\./);

    /* DEMOTING A MEMBER IS THE SAME SHAPE, the other way round. */
    const down = await promote('ana', group, 'cas', 'member');
    assert.strictEqual(down.status, 200);
    assert.strictEqual(down.body.changed, false, 'demoting somebody who is not an admin changes nothing');
    assert.strictEqual((await sql(cfg,
      "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'chat.group_admin_changed'"))[0].n, 1,
    'and writes nothing down');
  });

  await t.test('two promotions at once leave one consistent state', async () => {
    const group = await makeGroup('The race');
    await sql(cfg, "DELETE FROM activity_log WHERE action = 'chat.group_admin_changed'");
    /* The ordinary way this gets raced: the owner on two tabs. One transaction
       with the membership row locked makes the second one the idempotent case
       rather than a second system line saying the same thing. */
    const [a, b] = await Promise.all([promote('ana', group, 'bo'), promote('ana', group, 'bo')]);
    assert.ok([a.status, b.status].every((s) => s === 200), `${a.status} / ${b.status}`);
    assert.deepStrictEqual([a.body.changed, b.body.changed].sort(), [false, true],
      'exactly one of the two changed something');
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'admin');
    const lines = await sql(cfg,
      "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'chat.group_admin_changed'");
    assert.strictEqual(Number(lines[0].n), 1, 'and one log entry came out of it');
  });

  await t.test('the role survives removal by going away, and comes back as member', async () => {
    const group = await makeGroup('Coming and going');
    assert.strictEqual((await promote('ana', group, 'bo')).status, 200);
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'admin');

    await as('ana', `/chat/${group}/members/${id.bo}`, { method: 'DELETE' });
    const gone = await sql(cfg,
      'SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = ? AND user_id = ?',
      [group, id.bo]);
    assert.strictEqual(Number(gone[0].n), 0, 'the row went, and the role with it');

    await as('ana', `/chat/${group}/members`, { method: 'POST', body: { userIds: [id.bo] } });
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'member',
      're-added as a member, not as the admin they were');
  });

  await t.test('a promotion survives a restart, because it is in the table', async () => {
    const group = await makeGroup('Across a restart');
    assert.strictEqual((await promote('ana', group, 'bo')).status, 200);
    stopServer(server);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'admins-2', CHAT_SWEEP_MINUTES: '0' });
    tok.ana = await login('ana@ga.test');
    tok.bo = await login('bo@ga.test');
    tok.cas = await login('cas@ga.test');
    tok.dee = await login('dee@ga.test');
    tok.root = await login('root@ga.test');
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'admin');
    assert.strictEqual((await as('bo', `/chat/${group}/messages`)).body.conversation.myRole, 'admin');
  });

  await t.test('the Super Admin keeps what they had, and gains only one thing', async () => {
    /* ROOT HOLDS chat.group_manage_any, which is the catalogue's override and
       is unchanged: within a group they are IN, they may rename, add and
       remove. They are not the owner and cannot hand out the admin role while
       the owner is there to do it. */
    const group = await makeGroup('Oversight', ['bo', 'cas', 'root']);
    const perms = (await as('root', '/auth/me')).body.user.permissions;
    assert.ok(perms.includes('chat.group_manage_any'), 'Root holds the override');

    assert.strictEqual((await as('root', `/chat/${group}`,
      { method: 'PATCH', body: { title: 'Oversight' } })).status, 200, 'renaming: unchanged');
    assert.strictEqual((await as('root', `/chat/${group}/members/${id.cas}`,
      { method: 'DELETE' })).status, 200, 'removing: unchanged');

    assert.strictEqual((await promote('ana', group, 'bo')).status, 200);
    const tryPromote = await promote('root', group, 'bo', 'member');
    assert.strictEqual(tryPromote.status, 403,
      'the owner is here and active, so even the Super Admin does not touch roles');

    /* AND THE ONE NEW THING: once the owner cannot act — they have left, or
       their account has been deactivated — the Super Admin may DEMOTE an
       admin. Nothing in this application takes a deactivated person's groups
       off them, so without this a group could keep an admin nobody can remove. */
    await sql(cfg, 'UPDATE users SET is_active = 0 WHERE id = ?', [id.ana]);
    const nowAllowed = await promote('root', group, 'bo', 'member');
    assert.strictEqual(nowAllowed.status, 200, JSON.stringify(nowAllowed.body));
    assert.strictEqual(await roleOf('root', group, 'bo'), 'member');

    /* STILL NOT PROMOTION, and still not ownership. */
    const stillNo = await promote('root', group, 'bo', 'admin');
    assert.strictEqual(stillNo.status, 403, 'demotion only, never promotion');
    await sql(cfg, 'UPDATE users SET is_active = 1 WHERE id = ?', [id.ana]);
    tok.ana = await login('ana@ga.test');
  });

  await t.test('with the switch off, nothing about admins works and nothing is lost', async () => {
    const group = await makeGroup('The switch', ['bo', 'cas']);
    assert.strictEqual((await promote('ana', group, 'bo')).status, 200);
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'admin');

    const policy = (await as('root', '/admin/settings/chat-policy')).body.settings;
    const save = (on) => as('root', '/admin/settings/chat-policy', { method: 'PUT',
      body: { attachmentHours: policy.attachmentHours, repliesEnabled: policy.repliesEnabled,
        emojiPickerEnabled: policy.emojiPickerEnabled, groupAdminsEnabled: on } });
    assert.strictEqual((await save(false)).status, 200);

    /* THE ROLE IS STILL IN THE TABLE. That is what makes the switch
       reversible: nobody has to remember who the admins were. */
    const stored = await sql(cfg,
      'SELECT group_role AS r FROM chat_members WHERE conversation_id = ? AND user_id = ?',
      [group, id.bo]);
    assert.strictEqual(stored[0].r, 'admin', 'the stored role is untouched');

    /* AND THE ADMIN ACTS AS AN ORDINARY MEMBER. */
    assert.strictEqual((await as('bo', `/chat/${group}/messages`)).body.conversation.myRole, 'member');
    assert.strictEqual((await as('bo', `/chat/${group}`,
      { method: 'PATCH', body: { title: 'Not mine' } })).status, 403, 'no renaming');
    assert.strictEqual((await as('bo', `/chat/${group}/members`,
      { method: 'POST', body: { userIds: [id.dee] } })).status, 403, 'no adding');
    assert.strictEqual((await as('bo', `/chat/${group}/members/${id.cas}`,
      { method: 'DELETE' })).status, 403, 'no removing');
    /* The page is told the feature is off, and no member is reported as an admin. */
    const panel = await as('ana', '/chat');
    assert.strictEqual(panel.body.features.groupAdmins, false);
    assert.ok(!(await membersOf('ana', group)).some((m) => m.groupRole === 'admin'),
      'and nobody is shown as an admin while it is off');

    /* THE OWNER IS NOT PART OF THE FEATURE, and still runs their group. */
    assert.strictEqual((await as('ana', `/chat/${group}`,
      { method: 'PATCH', body: { title: 'The switch' } })).status, 200);
    /* AND ROLE CHANGES ARE REFUSED, with the reason. */
    const refused = await promote('ana', group, 'cas');
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /switched off/i);
    assert.match(refused.body.error, /Settings/i, 'and says where to switch it on');

    /* BACK ON, AND THE ADMIN IS AN ADMIN AGAIN, with nobody having re-promoted. */
    assert.strictEqual((await save(true)).status, 200);
    assert.strictEqual(await roleOf('ana', group, 'bo'), 'admin');
    assert.strictEqual((await as('bo', `/chat/${group}`,
      { method: 'PATCH', body: { title: 'The switch' } })).status, 200, 'and can rename again');
  });

  await t.test('owner departure is exactly what it was, and an admin gets no advantage',
    async () => {
    /* UNCHANGED RULE, ASSERTED BECAUSE THIS PROMPT MUST NOT HAVE CHANGED IT:
       when the owner leaves, the group goes to whoever has been in it longest.
       Being an admin is not a claim on the group. */
    const group = await makeGroup('Succession', ['bo', 'cas']);
    /* Cas joined after Bo, so Bo inherits — and Cas is the admin, to make the
       point that the admin is NOT the one who inherits. */
    assert.strictEqual((await promote('ana', group, 'cas')).status, 200);
    const r = await as('ana', `/chat/${group}/leave`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const members = await membersOf('bo', group);
    const owner = members.find((m) => m.groupRole === 'owner');
    assert.strictEqual(owner.id, id.bo, 'the longest-standing member inherits, not the admin');
    assert.strictEqual((members.find((m) => m.id === id.cas) || {}).groupRole, 'admin',
      'and the admin stays an admin');
    const rows = await sql(cfg,
      'SELECT user_id AS u, is_owner AS o, group_role AS r FROM chat_members WHERE conversation_id = ?',
      [group]);
    for (const row of rows) {
      assert.strictEqual(Number(row.o) === 1, row.r === 'owner',
        'the two columns still agree after an inheritance');
    }
  });
});
