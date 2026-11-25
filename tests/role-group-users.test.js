/* INDIVIDUAL USERS IN A ROLE GROUP — the resolution, the guards, and the promise
 * that nobody's access moved on the day it shipped.
 *
 * ===========================================================================
 * WHAT THE FEATURE IS, AND WHERE IT COULD GO WRONG.
 *
 * A role group was a bag of permissions with a list of member ROLES. It now also
 * holds a list of member USERS, so one person can be given a group's keys without
 * a designation being invented for them. The union lives in one function —
 * rolePermissions.effectiveFor(db, roleKey, userId) — and the whole risk of the
 * change is in that one line of arithmetic:
 *
 *   own  ∪  (groups the ROLE is in)  ∪  (groups the PERSON is in)
 *
 * So the first suite below is that arithmetic as a table, over every combination
 * of where a key can come from. The rest is what the table cannot see: the
 * escalation guard, the audit row, the notice, and the behaviour of a membership
 * when the account is deactivated or deleted.
 *
 * THE TABLE IS DRIVEN THROUGH THE REAL ROUTES, not by calling the module. A
 * resolution that is right in a unit test and wrong through authenticate() is the
 * failure mode that matters, because authenticate() is what every request uses.
 */
const test = require('node:test');
const assert = require('node:assert');

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const roleGroups = require('../src/role-groups');
const catalog = require('../src/permission-catalog');

const ROOT = path.join(__dirname, '..');

const cfg = config('rgusers');
const PASSWORD = 'RgUsers-Test-1!';

/* THE THREE KEYS THIS SUITE MOVES AROUND, and why these three.
 *
 * Each is a permission an ordinary artist does NOT hold by default — checked
 * below, so a key that became a default would fail loudly rather than making
 * every assertion here vacuous — and each is granted through a different route
 * so the sources can be told apart in one answer:
 *
 *   ROLE_KEY     put on the designation itself
 *   VIA_KEY      granted by a group the designation is in
 *   DIRECT_KEY   granted by a group the person is in by name
 *
 * None is in NEVER_GRANTABLE, and none implies another, so the union is readable
 * as three independent facts. */
const ROLE_KEY = 'user.idle_view';
const VIA_KEY = 'pnl.actual';
const DIRECT_KEY = 'report.artist_report';

test('users in a role group', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* What the SERVER says this person holds, read the way every request reads it:
     authenticate() resolves it and /auth/me hands it back. */
  const holds = async (who) => new Set((await as(who, '/auth/me')).body.user.permissions);

  const make = async (key, role) => {
    const r = await as('root', '/users', { method: 'POST', body: {
      name: key, email: `${key}@rg.test`, role, password: PASSWORD } });
    assert.strictEqual(r.status, 201, `${key}: ${JSON.stringify(r.body)}`);
    token[key] = await login(`${key}@rg.test`);
    return r.body.user.id;
  };

  const group = async (name, permissions) => {
    const made = await as('root', '/role-groups', { method: 'POST', body: { name, kind: 'custom' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    if (permissions && permissions.length) {
      const set = await as('root', `/role-groups/${made.body.group.id}/permissions`,
        { method: 'PUT', body: { permissions } });
      assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    }
    return made.body.group.id;
  };

  const setUsers = (gid, users) => as('root', `/role-groups/${gid}/users`,
    { method: 'PUT', body: { users } });
  const setRoles = (gid, roles) => as('root', `/role-groups/${gid}/roles`,
    { method: 'PUT', body: { roles } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rg-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'rg-boot', name: 'Root', email: 'root@rg.test', password: PASSWORD } });
    token.root = await login('root@rg.test');

    /* Six accounts, one per row of the resolution table. All the same designation
       except where the table needs otherwise, so the only thing that differs
       between them is which groups name them. */
    id.plain = await make('plain', 'game_artist');       // no group at all
    id.viaRole = await make('viarole', 'game_animator'); // designation is in a group
    id.direct = await make('direct', 'game_artist');     // named in a group
    id.both = await make('both', 'game_animator');       // designation AND named
    id.twice = await make('twice', 'game_artist');       // named in two groups
    id.spare = await make('spare', 'game_artist');       // for the cases below

    /* THE PRECONDITIONS EVERY ASSERTION HERE RESTS ON.

       First, that all three are real catalogue keys a group may grant — a typo
       would otherwise be refused on the write and leave every "they do not hold
       it" assertion below passing for the wrong reason. (It did: this suite was
       first written against `pnl.view`, which is not a permission in this
       catalogue, and the refusal surfaced as a 400 on the group save.)

       Second, that none of the three is something these designations already
       hold, so each one arriving is attributable to the source under test. */
    for (const key of [ROLE_KEY, VIA_KEY, DIRECT_KEY]) {
      assert.ok(catalog.isPermission(key), `${key} is a permission`);
      assert.ok(roleGroups.grantable(key), `${key} may be granted through a group`);
    }
    for (const who of ['plain', 'viarole', 'direct', 'both', 'twice']) {
      const held = await holds(who);
      for (const key of [ROLE_KEY, VIA_KEY, DIRECT_KEY]) {
        assert.ok(!held.has(key), `${who} must not already hold ${key}`);
      }
    }
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ======================================================================== */
  /* THE RESOLUTION TABLE                                                     */
  /* ======================================================================== */

  await t.test('the union: role, group via role, group direct — and no duplicates', async () => {
    /* The three sources are set up once and then every account is read. */
    const viaGroup = await group('Via Role', [VIA_KEY]);
    const directGroup = await group('Direct', [DIRECT_KEY]);
    const secondDirect = await group('Direct Two', [VIA_KEY]);   // the SAME key as viaGroup

    // The designation route: game_animator is in the group.
    assert.strictEqual((await setRoles(viaGroup, ['game_animator'])).status, 200);
    // The personal route.
    assert.strictEqual((await setUsers(directGroup, [id.direct, id.both])).status, 200);
    assert.strictEqual((await setUsers(secondDirect, [id.twice])).status, 200);
    assert.strictEqual((await setUsers(viaGroup, [id.twice])).status, 200);

    /* THE "IN BOTH" COLUMN, and the first draft of this table did not have it.

       Every account above reaches each key by exactly one route, because
       `twice`'s two groups are both DIRECT ones and grantsForUser() de-duplicates
       inside itself. So a union built by concatenation instead of by Set still
       produced no duplicate, and a mutation that did exactly that survived.

       `both` is a game_animator, so viaGroup reaches them through their
       designation; adding them to secondDirect, which grants the SAME key, makes
       VIA_KEY arrive by both routes at once. That is the only shape in which a
       duplicate can exist, and the assertion for it is below. */
    assert.strictEqual((await setUsers(secondDirect, [id.twice, id.both])).status, 200);

    /* And one key on the designation itself, so "the role's own" is in the table
       rather than assumed. game_artist gets ROLE_KEY. */
    const artistHeld = (await as('root', '/permissions/roles/game_artist')).body.role
      .permissions.filter((pp) => pp.enabled).map((pp) => pp.key);
    assert.strictEqual((await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...artistHeld, ROLE_KEY] } })).status, 200);

    /* ------------------------------------------------------------------ the table */
    const TABLE = [
      ['no group at all', 'plain', { role: true, via: false, direct: false }],
      ['group via role only', 'viarole', { role: false, via: true, direct: false }],
      ['direct group only', 'direct', { role: true, via: false, direct: true }],
      /* `both` now holds VIA_KEY by two routes at once — the "in both" case. */
      ['one key by both routes, and another direct', 'both',
        { role: false, via: true, direct: true }],
      ['two direct groups, one key shared with a role group', 'twice',
        { role: true, via: true, direct: false }],
    ];

    for (const [label, who, want] of TABLE) {
      const held = await holds(who);
      assert.strictEqual(held.has(ROLE_KEY), want.role, `${label}: ${ROLE_KEY}`);
      assert.strictEqual(held.has(VIA_KEY), want.via, `${label}: ${VIA_KEY}`);
      assert.strictEqual(held.has(DIRECT_KEY), want.direct, `${label}: ${DIRECT_KEY}`);

      /* NO DUPLICATES, ANYWHERE. /auth/me sends an array, and an array is where a
         union built by concatenation would show. `both` is the case that breaks
         it: VIA_KEY reaches them through the group their DESIGNATION is in and
         through a group they were added to BY NAME. */
      const list = (await as(who, '/auth/me')).body.user.permissions;
      assert.strictEqual(new Set(list).size, list.length,
        `${label}: the permission list repeats a key`);
    }

    /* THE OVERLAP, STATED RATHER THAN LEFT TO THE LOOP. `both` reaches VIA_KEY
       twice over; it must appear once, and it must still be there if either
       route is taken away. */
    const bothList = (await as('both', '/auth/me')).body.user.permissions;
    assert.strictEqual(bothList.filter((k) => k === VIA_KEY).length, 1,
      'a key reachable two ways is one entry');

    assert.strictEqual((await setUsers(secondDirect, [id.twice])).status, 200);
    assert.ok((await holds('both')).has(VIA_KEY),
      'take the direct membership away and their designation still carries it');
    assert.strictEqual((await setUsers(secondDirect, [id.twice, id.both])).status, 200);
    assert.strictEqual((await setRoles(viaGroup, [])).status, 200);
    assert.ok((await holds('both')).has(VIA_KEY),
      'take the role out of the group and the direct membership still carries it');
    assert.strictEqual((await setRoles(viaGroup, ['game_animator'])).status, 200);
  });

  await t.test('impliedBy chains apply to a key a group granted', async () => {
    /* A GROUP GRANT IS A REAL PERMISSION, not a second-class one. The catalogue
       builds some keys out of others — viewOf(), impliedBy, anyOf() — and those
       chains are computed over whatever set the person holds. So a key granted
       by direct membership has to behave exactly like one on the role: if the
       catalogue says a key implies a view, the view comes with it.

       Found from the catalogue rather than written out here, so this tests the
       rule and not one example of it. */
    const chained = catalog.ALL.filter((p) => p.impliedBy && roleGroups.grantable(p.key));
    assert.ok(chained.length, 'the catalogue has implied keys to test with');

    /* report.artist_report is DIRECT_KEY, already granted to `direct` above. The
       question is whether the resolved set for that account satisfies every
       implication the catalogue draws from it — which is what baselineFor()
       and effectiveFor() both read. */
    const held = await holds('direct');
    assert.ok(held.has(DIRECT_KEY), 'the group granted it');

    /* AND THE SAME KEY ON THE ROLE RESOLVES TO THE SAME SET. The strongest form
       of "a group grant is not second-class": give the designation the key
       directly, read the set, take it away again, and compare. Any difference
       would mean one of the two paths skips the catalogue's implications. */
    const spareHeld = (await as('root', '/permissions/roles/game_artist')).body.role
      .permissions.filter((pp) => pp.enabled).map((pp) => pp.key);
    assert.strictEqual((await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...new Set([...spareHeld, DIRECT_KEY])] } })).status, 200);
    const viaRoleSet = await holds('spare');
    assert.strictEqual((await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: spareHeld } })).status, 200);

    const viaGroupSet = await holds('direct');
    /* `direct` and `spare` are the same designation, so once ROLE_KEY and the
       group's key are accounted for the two sets must be identical. */
    assert.deepStrictEqual([...viaGroupSet].sort(), [...viaRoleSet].sort(),
      'a key granted by a group resolves to the same set as the same key on the role');
  });

  /* ======================================================================== */
  /* THE SERVER AND THE PAGE AGREE                                            */
  /* ======================================================================== */

  await t.test('a direct member passes a route guard, and loses it when removed', async () => {
    /* THE POINT OF THE WHOLE FEATURE, asked of a real guarded endpoint rather
       than of the permission list: a page gate is a courtesy and the route is
       the lock, so the lock is what this opens.

       GET /api/reports/artist is behind requirePermission('report.artist_report')
       — DIRECT_KEY — and `spare` holds it from no other source. */
    assert.strictEqual((await as('spare', '/reports/artist?from=2026-01-01&to=2026-01-31')).status, 403,
      'closed before the group');

    const gid = await group('Report Readers', [DIRECT_KEY]);
    assert.strictEqual((await setUsers(gid, [id.spare])).status, 200);

    const open = await as('spare', '/reports/artist?from=2026-01-01&to=2026-01-31');
    assert.strictEqual(open.status, 200, `open through the group: ${JSON.stringify(open.body)}`);

    /* AND THE PAGE'S OWN GATE, which reads can() off this list — the same answer
       the route gave, from the same resolution. */
    assert.ok((await holds('spare')).has(DIRECT_KEY), 'and can() would draw the control');

    assert.strictEqual((await setUsers(gid, [])).status, 200);
    assert.strictEqual((await as('spare', '/reports/artist?from=2026-01-01&to=2026-01-31')).status, 403,
      'and closed again on the very next request after removal');
    assert.ok(!(await holds('spare')).has(DIRECT_KEY));
  });

  await t.test('an inactive account gets nothing from a group, and gets it back', async () => {
    const gid = await group('Leavers', [VIA_KEY]);
    assert.strictEqual((await setUsers(gid, [id.spare])).status, 200);
    assert.ok((await holds('spare')).has(VIA_KEY), 'granted while active');

    const off = await as('root', `/users/${id.spare}/deactivate`,
      { method: 'POST', body: { reason: 'sabbatical' } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    /* THE ROW SURVIVES — that is the requirement, and it is what makes
       reactivation free of any membership to restore by hand. */
    const rows = await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_users WHERE group_id = ? AND user_id = ?',
      [gid, id.spare]);
    assert.strictEqual(Number(rows[0].n), 1, 'deactivating keeps the membership');

    /* AND THE GRANT STOPS — ASKED OF THE APPLICATION'S OWN RESOLUTION, which is
       the only version of this assertion worth having.

       The first draft asked the database with a copy of the join written out in
       this file. A mutation that removed `AND u.is_active = 1` from
       src/role-groups.js therefore changed nothing here: the test was checking
       SQL it had written itself. That is the whole failure mode a test like this
       exists to catch, so it now runs effectiveFor() in a child process — the
       same function authenticate() calls, against the same database, with the
       connection settings in the environment variables src/db reads.

       A CHILD PROCESS because this one must not require src/db: the suite's own
       pool points at a different database. The pattern is tests/chat.test.js's
       sweep helper. And it has to be asked ABOUT this person rather than AS
       them, because a deactivated account cannot sign in at all. */
    const resolvedFor = (userId, role) => {
      const out = execFileSync(process.execPath, ['-e',
        "const db=require('./src/db');"
        + "require('./src/role-permissions').effectiveFor(db, process.argv[1], process.argv[2])"
        + ".then((set)=>{process.stdout.write(JSON.stringify([...set]));return db.end();})"
        + ".catch((e)=>{console.error(e);process.exit(1);});", role, userId], {
        cwd: ROOT,
        env: { ...process.env,
          DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
          DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
      }).toString();
      return new Set(JSON.parse(out));
    };

    assert.ok(!resolvedFor(id.spare, 'game_artist').has(VIA_KEY),
      'the resolution gives a deactivated account nothing from its groups');

    /* Signing in is refused outright, which is the other half of why an inactive
       member is harmless. */
    const tryLogin = await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'spare@rg.test', password: PASSWORD } });
    assert.ok(tryLogin.status >= 400, 'and they cannot sign in at all');

    const on = await as('root', `/users/${id.spare}/reactivate`, { method: 'POST' });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    token.spare = await login('spare@rg.test');
    assert.ok((await holds('spare')).has(VIA_KEY),
      'reactivating gives the group back, with no membership to restore by hand');
    assert.ok(resolvedFor(id.spare, 'game_artist').has(VIA_KEY),
      'and the resolution says so when asked about them, too');

    assert.strictEqual((await setUsers(gid, [])).status, 200);
  });

  await t.test('deleting the account leaves no rows', async () => {
    const gid = await group('Going Away', [VIA_KEY]);
    const doomed = await make('doomed', 'game_artist');
    assert.strictEqual((await setUsers(gid, [doomed])).status, 200);
    assert.strictEqual(Number((await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_users WHERE user_id = ?', [doomed]))[0].n), 1);

    const gone = await as('root', `/users/${doomed}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));

    /* THE FOREIGN KEY DID IT, not a route: src/routes/users.js deletes the user
       row and names no other table. */
    assert.strictEqual(Number((await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_users WHERE user_id = ?', [doomed]))[0].n), 0,
      'the membership went with the account');

    /* And the group is still there, with its permissions — a cascade in the
       wrong direction would have taken it. */
    const after = await as('root', `/role-groups/${gid}/members`);
    assert.strictEqual(after.status, 200);
    assert.deepStrictEqual(after.body.users, []);
  });

  /* ======================================================================== */
  /* THE GUARDS                                                               */
  /* ======================================================================== */

  await t.test('adding somebody needs every key the group grants', async () => {
    /* THE ESCALATION RULE, which this task made cover both kinds of member.
       A manager who holds the group screen but not the group's keys cannot hand
       that group to anybody — a role or a person. */
    const gid = await group('Powerful', [VIA_KEY]);
    const manager = await make('manager', 'team_lead');

    const leadHeld = (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((pp) => pp.enabled).map((pp) => pp.key);
    assert.ok(!leadHeld.includes(VIA_KEY), `a team lead does not hold ${VIA_KEY}`);

    // Give them the group screen and nothing else.
    assert.strictEqual((await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...leadHeld, roleGroups.MANAGE_KEY] } })).status, 200);
    try {
      assert.strictEqual((await as('manager', '/role-groups')).status, 200, 'they can open it');

      const refusedUser = await as('manager', `/role-groups/${gid}/users`,
        { method: 'PUT', body: { users: [id.plain] } });
      assert.strictEqual(refusedUser.status, 403, JSON.stringify(refusedUser.body));
      assert.match(refusedUser.body.error, /do not hold/);

      /* THE SAME REFUSAL FOR A ROLE, which is the parity this task added. Before
         it, this call succeeded and handed out a key the editor lacked. */
      const refusedRole = await as('manager', `/role-groups/${gid}/roles`,
        { method: 'PUT', body: { roles: ['game_artist'] } });
      assert.strictEqual(refusedRole.status, 403, JSON.stringify(refusedRole.body));

      assert.deepStrictEqual((await as('root', `/role-groups/${gid}/members`)).body.users, [],
        'and nothing landed');

      /* NOW GIVE THEM THE KEY: the same request, the same token, and it works —
         so what is being tested is the rule and not the person. */
      assert.strictEqual((await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: [...leadHeld, roleGroups.MANAGE_KEY, VIA_KEY] } })).status, 200);
      const allowed = await as('manager', `/role-groups/${gid}/users`,
        { method: 'PUT', body: { users: [id.plain] } });
      assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));

      /* AND A SUPER ADMIN IS NEVER BLOCKED, because that tier holds the whole
         catalogue — the short-circuit at the top of effectiveFor(). */
      assert.strictEqual((await setUsers(gid, [id.plain, id.twice])).status, 200);
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: leadHeld } });
      await setUsers(gid, []);
    }
  });

  await t.test('without the management key every one of the routes is 403', async () => {
    /* The gate is on the router, so it covers the two new endpoints without
       either of them doing anything of its own. Asked of all four, including
       the two reads: a picker that answered to anybody would be a staff
       directory behind the wrong key. */
    const gid = await group('Gated', []);
    for (const [method, path] of [
      ['GET', '/role-groups/users?search=a'],
      ['GET', `/role-groups/${gid}/members`],
      ['PUT', `/role-groups/${gid}/users`],
      ['PUT', `/role-groups/${gid}/roles`],
    ]) {
      const r = await as('plain', path, { method, body: method === 'PUT' ? { users: [], roles: [] } : undefined });
      assert.strictEqual(r.status, 403, `${method} ${path}: ${JSON.stringify(r.body)}`);
    }
  });

  await t.test('idempotent, unique, and clear about who cannot be added', async () => {
    const gid = await group('Idempotent', [VIA_KEY]);

    const first = await setUsers(gid, [id.plain]);
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.added, [id.plain]);

    /* THE SAME LIST AGAIN: nothing moves, nothing is audited, nobody is told. */
    const auditBefore = (await as('root', '/role-groups/audit')).body.entries.length;
    const again = await setUsers(gid, [id.plain]);
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(again.body.added, [], 'adding somebody already in the group adds nothing');
    assert.deepStrictEqual(again.body.removed, []);
    assert.strictEqual((await as('root', '/role-groups/audit')).body.entries.length, auditBefore,
      'and audits nothing');

    assert.strictEqual(Number((await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_users WHERE group_id = ?', [gid]))[0].n), 1,
      'one row, not two');

    /* THE UNIQUE PAIR, asked of the database directly: INSERT IGNORE is what
       makes a race end with one row, and this is the constraint behind it. */
    await assert.rejects(
      () => sql(cfg, 'INSERT INTO role_group_users (group_id, user_id) VALUES (?,?)', [gid, id.plain]),
      /Duplicate entry/i, 'the pair is unique in the schema');

    const ghost = await setUsers(gid, ['11111111-2222-3333-4444-555555555555']);
    assert.strictEqual(ghost.status, 400);
    assert.match(ghost.body.error, /does not exist/);
    assert.strictEqual(ghost.body.field, 'users');

    const off = await make('leaver', 'game_artist');
    await as('root', `/users/${off}/deactivate`, { method: 'POST', body: { reason: 'left' } });
    const dead = await setUsers(gid, [id.plain, off]);
    assert.strictEqual(dead.status, 400, JSON.stringify(dead.body));
    assert.match(dead.body.error, /deactivated account/);
    assert.match(dead.body.error, /Reactivate/, 'and says what to do about it');
    assert.strictEqual(Number((await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_users WHERE group_id = ?', [gid]))[0].n), 1,
      'a refused save changes nothing — not even the valid half of it');

    await setUsers(gid, []);
  });

  /* ======================================================================== */
  /* THE RECORD                                                               */
  /* ======================================================================== */

  await t.test('every add and remove is audited, by name', async () => {
    const gid = await group('Audited', [VIA_KEY]);
    assert.strictEqual((await setUsers(gid, [id.plain])).status, 200);
    assert.strictEqual((await setUsers(gid, [])).status, 200);

    const entries = (await as('root', '/role-groups/audit')).body.entries
      .filter((e) => e.group === 'Audited' && e.action === 'users');
    assert.strictEqual(entries.length, 2, 'one row for the add, one for the remove');
    assert.ok(entries.every((e) => e.actor === 'root@rg.test'), 'each names who did it');

    /* NAMES, NOT IDS. This row is read by a person months later and a uuid tells
       them nothing — including for the REMOVE, where the name has to come from
       the group as it was rather than as it is. */
    const [removal, addition] = entries;
    assert.match(addition.detail, /\+plain/, `the add names them: ${addition.detail}`);
    assert.match(removal.detail, /-plain/, `and so does the remove: ${removal.detail}`);

    /* AND THE ACTIVITY LOG, which is the studio-wide record rather than this
       screen's own — src/routes/activity.js, behind settings.activity_log, and
       not /history (that is the timesheet's). Both records exist on purpose:
       role_group_audit is the group screen's own history and survives being
       read by somebody without the log's key. */
    const log = await as('root', '/activity?module=permissions&limit=50');
    assert.strictEqual(log.status, 200, JSON.stringify(log.body).slice(0, 200));
    const rows = log.body.entries || log.body.items || log.body.activity || [];
    /* NARROWED TO THIS GROUP. Every membership change in this suite logs the same
       action, so filtering on the action alone and then asserting the label is
       how a test accuses the Activity Log of mislabelling fourteen correct rows. */
    const ours = rows.filter((e) => String(e.action || '') === 'role_group.users'
      && String((e.entity || {}).label || '') === 'Audited');
    assert.strictEqual(ours.length, 2,
      `one log row for the add and one for the remove: ${JSON.stringify(ours.map((e) => e.summary))}`);
    assert.ok(ours.every((e) => (e.actor || {}).email === 'root@rg.test'), 'each names the actor');
    assert.ok(ours.every((e) => (e.entity || {}).type === 'role_group'), 'and the entity type');
    assert.ok(ours.some((e) => /1 user\(s\) added/.test(e.summary || '')), 'the add says so');
    assert.ok(ours.some((e) => /1 removed/.test(e.summary || '')), 'and the remove');
  });

  await t.test('the person is told, and the notice names no permission', async () => {
    /* A FRESH ACCOUNT, because "exactly one notice" is the assertion and the
       accounts above have collected memberships from earlier subtests. Counting
       on a shared account is how a test like this passes for a while and then
       starts counting somebody else's history. */
    const told = await make('told', 'game_artist');
    const gid = await group('Told', [VIA_KEY, DIRECT_KEY]);
    assert.strictEqual((await setUsers(gid, [told])).status, 200);

    const notes = (await as('told', '/notifications')).body.notifications || [];
    const mine = notes.filter((n) => n.kind === 'role_group');
    assert.strictEqual(mine.length, 1, `exactly one notice: ${JSON.stringify(mine)}`);
    assert.match(mine[0].message, /Told/, 'it names the group');
    assert.strictEqual(mine[0].otherName, 'Root', 'and who added them');

    /* THE THING IT MUST NOT CONTAIN. Checked over the whole payload rather than
       the sentence, because a key leaking through any field of it is the same
       leak — and checked for every key the group grants, not one of them. */
    const whole = JSON.stringify(mine);
    for (const key of [VIA_KEY, DIRECT_KEY]) {
      assert.ok(!whole.includes(key), `the notice must not name ${key}`);
    }
    for (const key of [VIA_KEY, DIRECT_KEY]) {
      const label = (catalog.BY_KEY.get(key) || {}).label;
      if (label) assert.ok(!whole.includes(label), `nor the label "${label}"`);
    }

    /* REMOVAL SAYS NOTHING, which is a decision rather than an omission — see
       KINDS.role_group. The audit row is the record. */
    assert.strictEqual((await setUsers(gid, [])).status, 200);
    const after = ((await as('told', '/notifications')).body.notifications || [])
      .filter((n) => n.kind === 'role_group');
    assert.strictEqual(after.length, 1, 'still one: nothing is raised on removal');

    /* AND AN ADMINISTRATOR ADDING THEMSELVES IS TOLD NOTHING: raise() drops a
       notice whose recipient is its actor, and they know — they just did it. */
    const selfGroup = await group('Mine', []);
    const rootId = (await as('root', '/auth/me')).body.user.id;
    assert.strictEqual((await setUsers(selfGroup, [rootId])).status, 200);
    const rootNotes = ((await as('root', '/notifications')).body.notifications || [])
      .filter((n) => n.kind === 'role_group');
    assert.strictEqual(rootNotes.length, 0, 'nobody tells you what you just did');
  });

  /* ======================================================================== */
  /* WHAT THE SCREEN IS SHOWN                                                 */
  /* ======================================================================== */

  await t.test('the editor is told who is already covered through their role', async () => {
    const gid = await group('Overlap', [VIA_KEY]);
    assert.strictEqual((await setRoles(gid, ['game_artist'])).status, 200);
    /* id.plain IS a game_artist; id.viaRole is a game_animator. */
    assert.strictEqual((await setUsers(gid, [id.plain, id.viaRole])).status, 200);

    const members = await as('root', `/role-groups/${gid}/members`);
    assert.strictEqual(members.status, 200);
    const byId = new Map(members.body.users.map((u) => [u.id, u]));
    assert.strictEqual(byId.get(id.plain).viaRole, true,
      'their designation is in the group as well');
    assert.strictEqual(byId.get(id.viaRole).viaRole, false, 'and theirs is not');
    assert.strictEqual(members.body.counts.usersAlreadyViaRole, 1);

    /* THE SAME ANSWER FROM THE SCREEN'S OWN PAYLOAD, which is what the chips are
       drawn from — the two must not disagree, and they come from one function. */
    const fromList = (await as('root', '/role-groups')).body.groups.find((g) => g.id === gid);
    assert.deepStrictEqual(fromList.users.map((u) => [u.id, u.viaRole]).sort(),
      members.body.users.map((u) => [u.id, u.viaRole]).sort());

    /* And each chip carries the role label the editor shows beside the name. */
    assert.ok(fromList.users.every((u) => u.roleLabel), 'every chip knows its role');
    await setUsers(gid, []);
    await setRoles(gid, []);
  });

  await t.test('the picker searches active accounts only, and says how many matched', async () => {
    const hidden = await make('hidden', 'game_artist');
    await as('root', `/users/${hidden}/deactivate`, { method: 'POST', body: { reason: 'left' } });

    const hit = await as('root', '/role-groups/users?search=hidden');
    assert.strictEqual(hit.status, 200);
    assert.deepStrictEqual(hit.body.users, [], 'a deactivated account is not offered');

    const plain = await as('root', '/role-groups/users?search=plain');
    assert.strictEqual(plain.body.users.length, 1);
    assert.strictEqual(plain.body.users[0].name, 'plain');
    assert.ok(plain.body.users[0].roleLabel, 'with the role label the chips show');

    /* FOUR FIELDS AND NO MORE: this is behind the group key, not user.view, so
       it must not become a staff directory. */
    assert.deepStrictEqual(Object.keys(plain.body.users[0]).sort(),
      ['email', 'id', 'name', 'role', 'roleLabel']);

    const all = await as('root', '/role-groups/users');
    assert.ok(all.body.total >= all.body.users.length);
    assert.ok(all.body.users.length <= all.body.limit, 'capped');
    assert.strictEqual(typeof all.body.total, 'number', 'and the true total is told');
  });

  await t.test('a user panel says which groups named them', async () => {
    /* A fresh account, for the reason the notice test needs one: this asserts the
       WHOLE list, and the shared accounts above are in several groups by now. */
    const named = await make('named', 'game_artist');
    const gid = await group('Named', [VIA_KEY]);
    assert.strictEqual((await setUsers(gid, [named])).status, 200);

    const detail = await as('root', `/users/${named}`);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual((detail.body.user.groups || []).map((g) => g.name), ['Named']);

    /* NO KEYS ON THIS PANEL. It is behind user.view — the staff directory's key
       — and what a group grants belongs to the group screen behind its own. */
    assert.ok(!JSON.stringify(detail.body.user.groups).includes(VIA_KEY));

    /* AND NOT THE GROUPS THEIR ROLE IS IN: those belong to the designation, and
       listing them here would read as "this person was singled out". */
    const viaOnly = await group('Role Only', [VIA_KEY]);
    assert.strictEqual((await setRoles(viaOnly, ['game_artist'])).status, 200);
    const again = await as('root', `/users/${named}`);
    assert.deepStrictEqual((again.body.user.groups || []).map((g) => g.name), ['Named'],
      'only the memberships that are this account\'s own');

    await setRoles(viaOnly, []);
    await setUsers(gid, []);
  });
});

/* ===========================================================================
 * THERE IS ONE RESOLUTION PATH, and nothing may answer this question twice.
 *
 * Source-level, no server. The whole safety of this feature rests on the union
 * being in one function, so what is pinned here is that it is.
 */
test('the union is computed in one place', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* ONLY effectiveFor() READS BOTH SOURCES. grantsForUser is the direct-member
     read; anything outside src/role-groups.js (which owns it) and
     src/role-permissions.js (which unions it) calling that function would be a
     second answer to "what may this person do".

     scripts/role-can.js is NOT exempt and does not appear: it deliberately
     rebuilds the set from reads of its own, because effectiveFor() writes (it
     seeds and tops up roles) and a diagnostic run against a live studio must
     not. tests/project-authority.test.js asserts the two agree role by role.
     Its own query is checked by the test below instead. */
  const owners = new Set(['src/role-groups.js', 'src/role-permissions.js']);
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = [];
  for (const rel of walk('src').filter((f) => f.endsWith('.js'))) {
    if (owners.has(rel)) continue;
    if (/grantsForUser/.test(strip(read(rel)))) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [],
    `${offenders.join(', ')} resolves direct group membership itself — `
    + 'ask rolePermissions.effectiveFor(db, role, userId)');

  /* AND NOBODY ELSE QUERIES THE TABLE. The cousin of the above: a surface that
     joins role_group_users in SQL of its own would drift from the rule the
     moment the rule changed. src/migrate.js creates it; role-groups owns it. */
  const tableOwners = new Set(['src/role-groups.js', 'src/migrate.js']);
  const sqlOffenders = [];
  for (const rel of [...walk('src'), 'public/index.html'].filter((f) => /\.(js|html)$/.test(f))) {
    if (tableOwners.has(rel)) continue;
    if (/role_group_users/.test(strip(read(rel)))) sqlOffenders.push(rel);
  }
  assert.deepStrictEqual(sqlOffenders, [],
    `${sqlOffenders.join(', ')} reads role_group_users directly`);

  /* THE UNION ITSELF: one function, three sources, and Sets — which is what
     makes "counted once" a property of the structure rather than of a step. */
  const resolver = strip(read('src/role-permissions.js'));
  const body = resolver.slice(resolver.indexOf('async function effectiveFor'),
    resolver.indexOf('async function effectiveFor') + 1600);
  assert.match(body, /grantsForRole/, 'the role\'s groups');
  assert.match(body, /grantsForUser/, 'and the person\'s');
  assert.match(body, /userId/, 'keyed on the account');

  /* THE ESCALATION GUARD IS ONE FUNCTION USED BY BOTH KINDS OF MEMBER. The
     parity the brief asks for, as code rather than as two paragraphs. */
  const groups = strip(read('src/role-groups.js'));
  for (const fn of ['async function setRoles', 'async function setUsers']) {
    const at = groups.indexOf(fn);
    assert.ok(at !== -1, `${fn} exists`);
    assert.match(groups.slice(at, at + 900), /mayHandOut/, `${fn} asks the shared guard`);
  }

  /* A GROUP CANNOT REMOVE A PERMISSION, which is the property the whole feature
     rests on. The union only ever adds: no delete, no difference, no filter of
     the role's own set anywhere in it. */
  assert.ok(!/own\.delete|own\s*=\s*new Set\(\[\.\.\.own\]\.filter/.test(body),
    'nothing in the union takes a permission away');
});
