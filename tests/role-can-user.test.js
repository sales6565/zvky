/* scripts/role-can.js --user — WHAT ONE PERSON HOLDS, AND WHICH SOURCE GAVE IT.
 *
 * ===========================================================================
 * WHY THE SCRIPT HAD TO GROW A --user FLAG.
 *
 * Until role groups could name individuals, "what does this person hold" and
 * "what does their designation hold" were the same question, and the script
 * answered it by role. They are now different: two artists can hold different
 * permissions, and the first thing somebody debugging that needs is which of the
 * three sources a key came from.
 *
 * THE TWO THINGS ASSERTED HERE are the two that would make it worthless:
 *
 *   IT MUST AGREE WITH THE APPLICATION. The script deliberately does NOT call
 *   effectiveFor() — that function writes, seeding roles and topping up
 *   catalogue keys, which is not acceptable in a diagnostic run against a live
 *   studio. So it rebuilds the set from reads, and a rebuild that drifts from
 *   the real rule is a diagnostic that sends somebody hunting a bug that is not
 *   there. Every case below compares it against what /auth/me says.
 *
 *   IT MUST NOT WRITE. Asserted two ways: the module's own FORBIDDEN guard
 *   refuses a non-read statement, and the whole database is checksummed around
 *   a real run.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('rolecanuser');
const PASSWORD = 'RoleCan-Test-1!';
const ROOT = path.join(__dirname, '..');

test('role-can --user', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });

  const run = (...args) => {
    try {
      return execFileSync(process.execPath, [path.join('scripts', 'role-can.js'), ...args], {
        cwd: ROOT,
        env: { ...process.env,
          DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
          DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
      }).toString();
    } catch (err) {
      const e = new Error(`exit ${err.status}: ${(err.stderr || '').toString()}`);
      e.status = err.status;
      e.stdout = (err.stdout || '').toString();
      e.stderr = (err.stderr || '').toString();
      throw e;
    }
  };
  const json = (...args) => JSON.parse(run(...args, '--json'));

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rc-boot' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'rc-boot', name: 'Root', email: 'root@rc.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@rc.test');

    const make = async (key, name, role) => {
      const r = await as('root', '/users', { method: 'POST', body: {
        name, email: `${key}@rc.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
      token[key] = await login(`${key}@rc.test`);
      return r.body.user.id;
    };
    /* Two artists: one in a group by name, one not. Same designation, so every
       difference the script reports is the direct membership. */
    id.ana = await make('ana', 'Ana Ruiz', 'game_artist');
    id.ben = await make('ben', 'Ben Olsen', 'game_artist');
    id.dupe = await make('dupe', 'Ana Other', 'game_artist');   // for the ambiguity case

    const mk = async (name, perms) => {
      const g = (await as('root', '/role-groups', { method: 'POST', body: { name, kind: 'custom' } }))
        .body.group.id;
      await as('root', `/role-groups/${g}/permissions`, { method: 'PUT', body: { permissions: perms } });
      return g;
    };
    id.direct = await mk('Release Managers', ['report.artist_report']);
    id.viaRole = await mk('All Artists', ['pnl.actual']);
    await as('root', `/role-groups/${id.direct}/users`, { method: 'PUT', body: { users: [id.ana] } });
    await as('root', `/role-groups/${id.viaRole}/roles`, { method: 'PUT', body: { roles: ['game_artist'] } });
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('each key is printed with the source that gave it', async () => {
    const out = run('--user', 'ana@rc.test');
    assert.match(out, /account        Ana Ruiz <ana@rc\.test>/);
    assert.match(out, /in groups      Release Managers/);

    const report = json('--user', 'ana@rc.test');
    const sourceOf = new Map(report.effective.map((e) => [e.key, e.source]));

    /* THE THREE SOURCES, each on a key that can only have come from it. */
    assert.strictEqual(sourceOf.get('report.artist_report'), 'group (direct): Release Managers');
    assert.strictEqual(sourceOf.get('pnl.actual'), 'group via role: All Artists');
    /* And an ordinary key of the designation's own, so the three sources are all
       represented. project.view is in game_artist's baseline — asserted from the
       catalogue in the suite above, and a key that is not in it (asset.view is
       not a permission in this catalogue) would read here as `undefined`. */
    assert.ok(/^the role$|^catalogue default/.test(sourceOf.get('project.view') || ''),
      `an ordinary key comes from the role: ${sourceOf.get('project.view')}`);

    assert.deepStrictEqual(report.directGroups, ['Release Managers']);
    assert.strictEqual(report.user.name, 'Ana Ruiz');
    assert.strictEqual(report.user.isActive, true);
  });

  await t.test('and it agrees with what the server resolves for that account', async () => {
    /* THE ASSERTION THAT KEEPS IT HONEST. The script rebuilds the set from reads
       because effectiveFor() writes; this is where a rebuild that drifted would
       show. Compared for BOTH artists, so the difference the direct membership
       makes is covered as well as the agreement. */
    for (const who of ['ana', 'ben']) {
      const fromServer = (await as(who, '/auth/me')).body.user.permissions;
      const fromScript = json('--user', `${who}@rc.test`).effective.map((e) => e.key);
      assert.deepStrictEqual([...fromScript].sort(), [...fromServer].sort(),
        `${who}: the diagnostic and the application must agree`);
    }

    /* And they really do differ from each other, or the agreement above would be
       a comparison of two identical answers. */
    const ana = new Set(json('--user', 'ana@rc.test').effective.map((e) => e.key));
    const ben = new Set(json('--user', 'ben@rc.test').effective.map((e) => e.key));
    assert.ok(ana.has('report.artist_report') && !ben.has('report.artist_report'),
      'the direct membership is the difference');
    assert.deepStrictEqual(json('--user', 'ben@rc.test').directGroups, []);
  });

  await t.test('a deactivated account is reported as holding nothing from its groups', async () => {
    await as('root', `/users/${id.ana}/deactivate`, { method: 'POST', body: { reason: 'leave' } });
    try {
      const report = json('--user', 'ana@rc.test');
      assert.strictEqual(report.user.isActive, false);
      /* THE SAME ANSWER THE APPLICATION WOULD GIVE: grantsForUser() joins on
         is_active, so the group grants nothing — and the script's own query
         mirrors that join rather than reporting a permission the account does
         not have. */
      assert.ok(!report.effective.some((e) => e.key === 'report.artist_report'),
        'no key from the direct group');
      assert.deepStrictEqual(report.directGroups, [],
        'and the group is not listed as granting');
      assert.match(run('--user', 'ana@rc.test'), /DEACTIVATED/,
        'and the text report says why in one word');
    } finally {
      await as('root', `/users/${id.ana}/reactivate`, { method: 'POST' });
    }
  });

  await t.test('asked about a ROLE it answers exactly as it did before', async () => {
    /* THE COMPATIBILITY HALF. Without --user the report is about a designation,
       and its JSON shape is what it was: the two new fields are present and
       empty rather than absent, so a caller reading `effective` is unaffected. */
    const report = json('game_artist');
    assert.strictEqual(report.role, 'game_artist');
    assert.strictEqual(report.user, null, 'no account: the report is about the designation');
    assert.deepStrictEqual(report.directGroups, []);
    const sourceOf = new Map(report.effective.map((e) => [e.key, e.source]));
    assert.strictEqual(sourceOf.get('pnl.actual'), 'group via role: All Artists');
    assert.ok(!sourceOf.has('report.artist_report'),
      'and one person\'s membership is not attributed to their designation');

    assert.match(run('--roles'), /game_artist/, 'the role listing still works');
  });

  await t.test('it refuses to guess which person was meant', async () => {
    /* THE SCRIPT REPORTS RATHER THAN THROWS — it prints the sentence and exits
       0, which is the convention the role path already used for "no such role".
       So these read stdout rather than expecting a non-zero exit; what matters
       is that an ambiguous term is never answered with one of the matches. */
    const ambiguous = run('--user', 'Ana');
    assert.match(ambiguous, /accounts match/);
    assert.match(ambiguous, /Ana Ruiz/);
    assert.match(ambiguous, /Ana Other/);
    assert.ok(!/effective permissions/.test(ambiguous),
      'and no report is printed for either of them');

    assert.match(run('--user', 'nobody@nowhere.test'), /No account matches/);
    assert.match(run('--user'), /Name the account/);

    /* An exact email is never ambiguous, whatever else shares its letters. */
    assert.match(run('--user', 'ana@rc.test'), /Ana Ruiz/);
  });

  await t.test('it writes nothing — the guard, and the database around a real run', async () => {
    const { FORBIDDEN } = require('../scripts/role-can.js');
    for (const statement of ['UPDATE users SET name = name', 'DELETE FROM role_group_users',
      'INSERT INTO role_groups VALUES (1)', 'DROP TABLE users', 'CREATE TABLE x (a INT)']) {
      assert.ok(FORBIDDEN.test(statement), `the guard refuses: ${statement}`);
    }
    /* And lets the script's own reads through, including the two new ones. */
    for (const statement of [
      'SELECT permission_key, enabled FROM role_permissions WHERE role_key = $1',
      'SELECT DISTINCT g.`name`, gp.permission_key FROM role_group_users gu JOIN users u ON u.id = gu.user_id',
    ]) assert.ok(!FORBIDDEN.test(statement), `and allows: ${statement}`);

    /* EVERY TABLE, counted and checksummed around a real run — because a guard
       can only refuse what goes through it, and this proves nothing went round. */
    const snapshot = async () => {
      const tables = (await sql(cfg, 'SHOW TABLES')).map((r) => Object.values(r)[0]);
      const out = {};
      for (const table of tables) {
        const [{ n }] = await sql(cfg, `SELECT COUNT(*) AS n FROM \`${table}\``);
        const sum = await sql(cfg, `CHECKSUM TABLE \`${table}\``);
        out[table] = `${n}/${sum[0].Checksum}`;
      }
      return out;
    };
    const before = await snapshot();
    assert.ok(Object.keys(before).length > 20, 'the schema is really there');
    run('--user', 'ana@rc.test');
    run('--user', 'ben@rc.test', '--json');
    run('game_artist');
    assert.deepStrictEqual(await snapshot(), before, 'the diagnostic changed the database');
  });

  await t.test('and the source file contains no writing verb', () => {
    const code = fs.readFileSync(path.join(ROOT, 'scripts', 'role-can.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* THE WORDS, NOT THE STATEMENTS — the guard above covers statements that are
       built at run time; this covers one written in by hand. FORBIDDEN's own
       definition is exempt: it is the line that names them in order to refuse
       them, and a scan that tripped over its own guard would be reporting the
       fence as the hole. */
    const withoutGuard = code.replace(/const FORBIDDEN[^;]+;/, '');
    for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ', 'TRUNCATE']) {
      assert.ok(!new RegExp(verb, 'i').test(withoutGuard), `role-can.js must not contain ${verb}`);
    }
  });
});
