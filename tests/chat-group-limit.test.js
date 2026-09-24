/* How big a chat group may be, as a setting rather than a constant.
 *
 * WHAT IT WAS. `const MAX_GROUP_MEMBERS = 30` in src/chat.js, enforced in two
 * places, published to the browser in two more, quoted in a permission's
 * description and copied once into the page as a default. Thirty was a decision
 * somebody made when the studio was smaller, and changing it took a deploy.
 *
 * THE THREE THINGS WORTH GUARDING, in the order they are most likely to break:
 *
 *   the sweep       every enforcement point reads the setting, and the LAST
 *                   test in this file is the one that proves it — it drives a
 *                   group past the old thirty with the limit raised, which no
 *                   amount of reading the source can fake.
 *   unlimited       null is not "no answer", it is an answer, and a comparison
 *                   written as `size >= limit` reads null as false-y and caps
 *                   every group at nothing. It is checked explicitly.
 *   not retroactive lowering the cap must never turn anybody out of a group.
 *                   The studio asked for this to be confirmed rather than
 *                   assumed, so it is asserted against real rows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const chatSettings = require('../src/chat-settings');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatlimit');

// --- the pure predicate ------------------------------------------------------

test('the limit predicate, including unlimited', () => {
  assert.strictEqual(chatSettings.validate({ unlimited: true }).value, null,
    'unlimited is stored as null, not as a large number');
  assert.strictEqual(chatSettings.validate({ maxGroupMembers: 50 }).value, 50);
  assert.strictEqual(chatSettings.validate({ maxGroupMembers: '50' }).value, 50, 'a form sends strings');

  for (const bad of [0, -1, -30]) {
    const r = chatSettings.validate({ maxGroupMembers: bad });
    assert.strictEqual(r.ok, false, `${bad} is refused`);
    assert.strictEqual(r.errors[0].field, 'maxGroupMembers');
  }
  assert.match(chatSettings.validate({ maxGroupMembers: 0 }).errors[0].message, /Unlimited/,
    'zero is the plausible typo for unlimited, so the message says where that lives');
  assert.strictEqual(chatSettings.validate({ maxGroupMembers: 2.5 }).ok, false, 'and it is whole people');
  assert.strictEqual(chatSettings.validate({}).ok, false, 'a blank is not unlimited by accident');

  assert.strictEqual(chatSettings.describe(null), 'unlimited');
  assert.strictEqual(chatSettings.describe(1), '1 person');
  assert.strictEqual(chatSettings.describe(30), '30 people');
});

test('no enforcement point still holds the old number', () => {
  /* THE REGRESSION SWEEP the studio asked for by name.
   *
   * Reading the source rather than exercising it, deliberately: the integration
   * tests below prove the paths they walk, and this proves there is no path
   * they DO NOT walk still carrying a thirty. A stray check in a branch no test
   * happens to enter is exactly the failure this is for.
   *
   * The two files that legitimately still name thirty are named here with the
   * reason, so adding a third is a decision somebody makes on purpose. */
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  const chat = read('src/chat.js');
  /* The constant survives as an alias for the module's default, so anything
     still importing it gets a number rather than undefined. What must not
     survive is a comparison against it. */
  for (const line of chat.split('\n')) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;           // comments may discuss it
    assert.ok(!/[<>]=?\s*MAX_GROUP_MEMBERS|MAX_GROUP_MEMBERS\s*[<>]=?/.test(line),
      `src/chat.js still compares against the constant: ${line.trim()}`);
  }

  // And no bare 30 in a member/group context anywhere that decides anything.
  for (const file of ['src/chat.js', 'src/routes/chat.js', 'src/chat-settings.js']) {
    for (const line of read(file).split('\n')) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (/DEFAULT_MAX_GROUP_MEMBERS\s*=\s*30/.test(line)) continue;   // the seed default, named once
      assert.ok(!/\b30\b/.test(line) || !/member|group|limit|max/i.test(line),
        `${file} has a bare 30 in a group context: ${line.trim()}`);
    }
  }

  // The browser's copy: it must start from null (unknown / unlimited), not 30.
  const page = read('public/index.html');
  assert.ok(!/maxMembers\s*:\s*30/.test(page),
    'public/index.html still defaults the group cap to 30');
  assert.ok(/maxMembers\s*:\s*null/.test(page),
    'and it should start from null until the server says otherwise');

  /* The permission description quoted the number too. Comments may still
     discuss it — the one above the key explains why the number left — so this
     reads the describe strings rather than the file. */
  for (const line of read('src/permission-catalog.js').split('\n')) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    assert.ok(!/up to thirty/i.test(line),
      `the Create Chat Group permission still says "up to thirty": ${line.trim()}`);
  }
});

// --- the endpoints, and the limit actually biting ---------------------------

test('the setting, its gate and what it changes', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'ChatLimit-Probe-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const ROOT = '/admin/settings/chat-group-limit';

  const setLimit = async (body) => {
    const r = await as('root', ROOT, { method: 'PUT', body });
    assert.ok(r.status < 400, `setting the limit: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  let made = 0;
  const people = [];

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* Root is bootstrapped, not created through /users, so its id has to be
       read back rather than captured from a create response. */
    id.root = (await as('root', '/auth/me')).body.user.id;

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
      return r.body.user.id;
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('artist', 'Ravi Artist', 'ravi@zvky.test', 'game_artist');
    /* The designation that holds every OTHER Settings section. If the gate were
       written against Settings access rather than the Super Admin tier, this is
       who would walk through it. */
    await make('cto', 'Tara CTO', 'cto@zvky.test', 'cto');

    /* Forty people to fill groups with — more than the old thirty, which is the
       point: no test here can pass by accident under the old constant. */
    for (let i = 0; i < 40; i += 1) {
      const r = await as('root', '/users', {
        method: 'POST',
        body: { name: `Person ${i}`, email: `p${i}@zvky.test`, role: 'game_artist', password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      people.push(r.body.user.id);
    }
  });
  t.after(() => stopServer(server));

  await t.test('the upgrade changes nothing', async () => {
    const got = await as('root', ROOT);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.settings.maxGroupMembers, 30, 'still thirty, as the constant was');
    assert.strictEqual(got.body.settings.unlimited, false);
    const [row] = await sql(cfg, 'SELECT max_group_members AS n FROM chat_settings WHERE id = 1');
    assert.strictEqual(Number(row.n), 30, 'and it is a row now, not a constant');
  });

  await t.test('a non-super-admin gets 403 from both', async () => {
    for (const who of ['cto', 'lead', 'artist']) {
      assert.strictEqual((await as(who, ROOT)).status, 403, `GET as ${who}`);
      assert.strictEqual((await as(who, ROOT, {
        method: 'PUT', body: { maxGroupMembers: 500 } })).status, 403, `PUT as ${who}`);
    }
    const [row] = await sql(cfg, 'SELECT max_group_members AS n FROM chat_settings WHERE id = 1');
    assert.strictEqual(Number(row.n), 30, 'and none of them changed it');
  });

  await t.test('zero and negatives are refused', async () => {
    for (const bad of [0, -1]) {
      const r = await as('root', ROOT, { method: 'PUT', body: { maxGroupMembers: bad } });
      assert.strictEqual(r.status, 422, `${bad}`);
      assert.strictEqual(r.body.errors[0].field, 'maxGroupMembers');
    }
    assert.strictEqual((await as('root', ROOT)).body.settings.maxGroupMembers, 30, 'nothing was stored');
  });

  /* --- the limit biting, at both enforcement points ----------------------- */

  const groupOf = (who, memberIds, title) => as(who, '/chat/groups', {
    method: 'POST', body: { title: title || `Group ${made += 1}`, memberIds } });

  await t.test('creating a group respects the configured limit', async () => {
    await setLimit({ maxGroupMembers: 5 });
    // Five counting the owner: four others is the most that fits.
    const tooMany = await groupOf('root', people.slice(0, 5));
    assert.strictEqual(tooMany.status, 400, JSON.stringify(tooMany.body));
    assert.match(tooMany.body.error, /at most 5 people/);

    const fits = await groupOf('root', people.slice(0, 4));
    assert.strictEqual(fits.status, 201, JSON.stringify(fits.body));
  });

  await t.test('adding members respects it too, and both read the live value', async () => {
    await setLimit({ maxGroupMembers: 5 });
    const g = await groupOf('root', people.slice(0, 2));
    assert.strictEqual(g.status, 201, JSON.stringify(g.body));
    const gid = g.body.id || g.body.conversationId || g.body.conversation?.id;
    assert.ok(gid, `the group's id: ${JSON.stringify(g.body)}`);

    // Three in it; room for two more.
    const over = await as('root', `/chat/${gid}/members`, {
      method: 'POST', body: { userIds: people.slice(2, 5) } });
    assert.strictEqual(over.status, 400, JSON.stringify(over.body));
    assert.strictEqual(over.body.room, 2, 'and it says how much room there is');

    // Raise it between two requests: the second must see the new value, which
    // is the whole claim of "re-check at request time".
    await setLimit({ maxGroupMembers: 10 });
    const now = await as('root', `/chat/${gid}/members`, {
      method: 'POST', body: { userIds: people.slice(2, 5) } });
    assert.strictEqual(now.status, 200, JSON.stringify(now.body));
    assert.strictEqual(now.body.added.length, 3);
  });

  await t.test('unlimited means unlimited, well past the old thirty', async () => {
    /* THE TEST NO READING OF THE SOURCE CAN FAKE. Forty people in one group,
       which the old constant refused and which a `>=` written against a null
       limit would also refuse. */
    await setLimit({ unlimited: true });
    const got = await as('root', ROOT);
    assert.strictEqual(got.body.settings.maxGroupMembers, null);
    assert.strictEqual(got.body.settings.unlimited, true);

    const big = await groupOf('root', people, 'Everybody');
    assert.strictEqual(big.status, 201, JSON.stringify(big.body));
    const gid = big.body.id || big.body.conversationId || big.body.conversation?.id;
    const [row] = await sql(cfg,
      `SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = '${gid}'`);
    assert.strictEqual(Number(row.n), 41, 'forty people and the owner, well past thirty');
  });

  await t.test('lowering the limit does not turn anybody out', async () => {
    /* THE BEHAVIOUR THE STUDIO ASKED TO HAVE CONFIRMED RATHER THAN DECIDED.
       A group of forty-one, and the cap comes down to five. Everybody stays;
       the group simply takes no more. */
    await setLimit({ unlimited: true });
    const big = await groupOf('root', people, 'Still everybody');
    assert.strictEqual(big.status, 201, JSON.stringify(big.body));
    const gid = big.body.id || big.body.conversationId || big.body.conversation?.id;

    const before = await sql(cfg,
      `SELECT user_id FROM chat_members WHERE conversation_id = '${gid}' ORDER BY user_id`);
    assert.strictEqual(before.length, 41);

    const lowered = await setLimit({ maxGroupMembers: 5 });
    assert.ok(lowered.overCap >= 1, 'the screen is told how many groups are now over the cap');

    const after = await sql(cfg,
      `SELECT user_id FROM chat_members WHERE conversation_id = '${gid}' ORDER BY user_id`);
    assert.deepStrictEqual(after.map((r) => String(r.user_id)), before.map((r) => String(r.user_id)),
      'every single member is still in the group');

    // And the conversation still works for them.
    const seat = await as('root', `/chat/${gid}/messages`);
    assert.strictEqual(seat.status, 200, 'the group is still readable');
    assert.strictEqual(seat.body.conversation.memberCount, 41,
      'and it still names all forty-one of them');

    // What it will not do is take another.
    const refused = await as('root', `/chat/${gid}/members`, {
      method: 'POST', body: { userIds: [id.artist] } });
    assert.strictEqual(refused.status, 400, 'no more may be added while it is over the cap');
    assert.strictEqual(refused.body.room, 0, 'and room is zero, never a negative number');
  });

  /* --- the override permission ------------------------------------------- */

  await t.test('managing a group you did not create takes the override', async () => {
    await setLimit({ maxGroupMembers: 30 });
    // The lead makes a group and puts the artist and root in it.
    const g = await as('lead', '/chat/groups', {
      method: 'POST', body: { title: 'Lena\'s group', memberIds: [id.artist, id.root] } });
    assert.strictEqual(g.status, 201, JSON.stringify(g.body));
    const gid = g.body.id || g.body.conversationId || g.body.conversation?.id;

    // The artist is in it but did not create it.
    const refused = await as('artist', `/chat/${gid}`, { method: 'PATCH', body: { title: 'Mine now' } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    /* Root holds chat.group_manage_any by being Super Admin, and is a member,
       so the override lets them act on somebody else's group. */
    const allowed = await as('root', `/chat/${gid}`, { method: 'PATCH', body: { title: 'Renamed by admin' } });
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    assert.strictEqual(allowed.body.title, 'Renamed by admin');
  });

  await t.test('the override does not open groups you are not in', async () => {
    /* The boundary the override deliberately does not cross. Seeing a private
       conversation at all is a larger disclosure than managing one you are
       already sitting in, and the catalogue has its own permission for that. */
    const g = await as('lead', '/chat/groups', {
      method: 'POST', body: { title: 'Without root', memberIds: [id.artist] } });
    assert.strictEqual(g.status, 201, JSON.stringify(g.body));
    const gid = g.body.id || g.body.conversationId || g.body.conversation?.id;

    const seen = await as('root', `/chat/${gid}/messages`);
    assert.strictEqual(seen.status, 404, 'a group root is not in is not root\'s to read');
    const touched = await as('root', `/chat/${gid}`, { method: 'PATCH', body: { title: 'No' } });
    assert.strictEqual(touched.status, 404, 'nor to rename, override or no override');
  });

  await t.test('the change is in the audit trail', async () => {
    await setLimit({ maxGroupMembers: 42 });
    const log = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'settings.chat_group_limit');
    assert.ok(log.length, 'the change is logged');
    assert.match(log[0].summary, /42 people/);
    assert.ok(log[0].changes && log[0].changes.maxGroupMembers, 'with what it was before');
    assert.strictEqual(log[0].actor.email, 'root@zvky.test');
  });
});
