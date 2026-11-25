/* THE role_group_users MIGRATION — fresh, repeated, and over data that already exists.
 *
 * ===========================================================================
 * WHAT A MIGRATION TEST IS FOR HERE.
 *
 * The hard constraint on this feature is that nobody's access moves on the day it
 * deploys. Most of that is the resolution rule, tested elsewhere. This is the
 * other half: the step that adds the table must be safe to run on a studio that
 * already has groups, roles in them and permissions granted — and safe to run
 * twice, because that is what happens every time the application boots.
 *
 * SO THE SHAPE OF THIS SUITE IS: build an install with groups in it, snapshot
 * every row of every role-group table, run the migration again, and demand the
 * snapshot back byte for byte.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('rgumigrate');
const PASSWORD = 'RgMigrate-Test-1!';
const ROOT = path.join(__dirname, '..');

/* The migration in its own process, with the connection settings in the
   environment variables src/db reads — the same shape tests/chat.test.js uses.
   Its own process because this one must not open src/db. */
const migrate = () => execFileSync(process.execPath, ['-e',
  "const db=require('./src/db');require('./src/migrate').run(db)"
  + ".then(()=>db.end()).catch((e)=>{console.error(e);process.exit(1);});"], {
  cwd: ROOT,
  env: { ...process.env,
    DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
    DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
}).toString();

test('the role_group_users migration', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rgm-boot' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'rgm-boot', name: 'Root', email: 'root@rgm.test', password: PASSWORD } });
    token.root = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'root@rgm.test', password: PASSWORD } })).body.token;

    const artist = await as('root', '/users', { method: 'POST', body: {
      name: 'Artist', email: 'artist@rgm.test', role: 'game_artist', password: PASSWORD } });
    id.artist = artist.body.user.id;

    /* An install that is already using groups: one with a role in it, one with a
       person in it, and one with both. */
    const mk = async (name, perms, roles, users) => {
      const g = (await as('root', '/role-groups', { method: 'POST', body: { name, kind: 'custom' } }))
        .body.group.id;
      if (perms.length) await as('root', `/role-groups/${g}/permissions`,
        { method: 'PUT', body: { permissions: perms } });
      if (roles.length) await as('root', `/role-groups/${g}/roles`, { method: 'PUT', body: { roles } });
      if (users.length) await as('root', `/role-groups/${g}/users`, { method: 'PUT', body: { users } });
      return g;
    };
    id.byRole = await mk('By Role', ['pnl.actual'], ['game_artist'], []);
    id.byUser = await mk('By User', ['report.artist_report'], [], [id.artist]);
    id.byBoth = await mk('By Both', ['user.idle_view'], ['game_animator'], [id.artist]);
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* EVERY ROW OF EVERY ROLE-GROUP TABLE, ordered, as one comparable string.
     The added_at timestamps are included: a migration that rewrote a row would
     move them, and that is exactly the kind of damage this is watching for. */
  const snapshot = async () => {
    const out = {};
    for (const table of ['role_groups', 'role_group_members', 'role_group_permissions',
      'role_group_users']) {
      out[table] = await sql(cfg, `SELECT * FROM \`${table}\``);
      out[table] = JSON.stringify(out[table].map((r) => Object.entries(r).sort()).sort());
    }
    return out;
  };

  await t.test('the table is there, with the shape the resolution query needs', async () => {
    const cols = await sql(cfg, 'SHOW COLUMNS FROM role_group_users');
    const byName = new Map(cols.map((c) => [c.Field, c]));
    assert.deepStrictEqual([...byName.keys()].sort(),
      ['added_at', 'added_by_email', 'group_id', 'user_id']);
    assert.strictEqual(byName.get('group_id').Null, 'NO');
    assert.strictEqual(byName.get('user_id').Null, 'NO');

    /* THE UNIQUE PAIR IS THE PRIMARY KEY — which is what makes INSERT IGNORE an
       idempotent add rather than a silent duplicate. */
    const keys = await sql(cfg, 'SHOW KEYS FROM role_group_users');
    const primary = keys.filter((k) => k.Key_name === 'PRIMARY')
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map((k) => k.Column_name);
    assert.deepStrictEqual(primary, ['group_id', 'user_id']);
    /* And an index the other way, for "which groups is this person in". */
    assert.ok(keys.some((k) => k.Key_name !== 'PRIMARY' && k.Column_name === 'user_id'),
      'there is an index on user_id');

    /* THE TWO FOREIGN KEYS ARE THE CLEAN-UP, and both cascade: deleting a group
       takes its direct members, deleting an account takes its memberships. */
    const fks = await sql(cfg,
      `SELECT k.CONSTRAINT_NAME AS name, k.REFERENCED_TABLE_NAME AS parent, r.DELETE_RULE AS onDelete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'role_group_users'`);
    const parents = new Map(fks.map((f) => [f.parent, f.onDelete]));
    assert.strictEqual(parents.get('role_groups'), 'CASCADE');
    assert.strictEqual(parents.get('users'), 'CASCADE');
  });

  await t.test('running it again changes nothing', async () => {
    const before = await snapshot();
    assert.ok(JSON.parse(before.role_group_users).length === 2,
      'the fixture really has direct members to preserve');

    const out = migrate();
    assert.ok(out.length >= 0);

    assert.deepStrictEqual(await snapshot(), before,
      'the migration moved existing role-group data');
  });

  await t.test('and again, and the existing groups still grant what they granted', async () => {
    /* THE THING THE ROWS ARE FOR. Rows surviving is necessary; the permissions
       still arriving is the promise. Read through /auth/me, which is the
       resolution the application judges by. */
    const token2 = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'artist@rgm.test', password: PASSWORD } })).body.token;
    const before = new Set((await api(server.base, '/auth/me', { token: token2 })).body.user.permissions);
    assert.ok(before.has('pnl.actual'), 'from the group their role is in');
    assert.ok(before.has('report.artist_report'), 'from the group they are in by name');
    assert.ok(before.has('user.idle_view'), 'and from the group that has both');

    migrate();
    migrate();

    const after = new Set((await api(server.base, '/auth/me', { token: token2 })).body.user.permissions);
    assert.deepStrictEqual([...after].sort(), [...before].sort(),
      'two more migrations later, the same permissions');
  });

  await t.test('an install with no direct members is untouched by any of it', async () => {
    /* THE CASE EVERY STUDIO IS IN ON THE DAY THIS DEPLOYS: groups exist, nobody
       is a direct member, and the answer must be what it was before the table
       existed. Built by emptying the two user lists rather than by a second
       fixture, so what is compared is the same install with and without. */
    await as('root', `/role-groups/${id.byUser}/users`, { method: 'PUT', body: { users: [] } });
    await as('root', `/role-groups/${id.byBoth}/users`, { method: 'PUT', body: { users: [] } });
    assert.strictEqual(Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM role_group_users'))[0].n), 0);

    const token2 = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'artist@rgm.test', password: PASSWORD } })).body.token;
    const held = new Set((await api(server.base, '/auth/me', { token: token2 })).body.user.permissions);
    assert.ok(held.has('pnl.actual'), 'the role\'s group still grants');
    assert.ok(!held.has('report.artist_report'), 'and nothing else does');
    assert.ok(!held.has('user.idle_view'));

    const before = await snapshot();
    migrate();
    assert.deepStrictEqual(await snapshot(), before);
  });

  await t.test('dropping the table is survivable, and the migration puts it back', async () => {
    /* A DEPLOYMENT WHOSE MIGRATION HAS NOT RUN YET — the state between the code
       landing and the step running, which on a live studio is a real interval.
       The resolution reads it as "no direct groups" rather than failing, because
       authenticate() would otherwise refuse the whole studio. */
    await sql(cfg, 'DROP TABLE IF EXISTS role_group_users');

    const token2 = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'artist@rgm.test', password: PASSWORD } })).body.token;
    const me = await api(server.base, '/auth/me', { token: token2 });
    assert.strictEqual(me.status, 200, 'signing in still works with the table missing');
    assert.ok(new Set(me.body.user.permissions).has('pnl.actual'),
      'and the role\'s own groups still resolve');

    migrate();
    const cols = await sql(cfg, 'SHOW COLUMNS FROM role_group_users');
    assert.strictEqual(cols.length, 4, 'the migration recreated it');
  });
});
