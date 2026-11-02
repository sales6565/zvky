/* THE SCHEMA PROMPT 58 ADDS, and what it does to data that is already there.
 *
 * FOUR ADDITIONS. chat_settings gains three columns (the retention and the two
 * switches); chat_messages gains reply_to_message_id; chat_attachments.expires_at
 * becomes nullable; and the step that used to restamp every live attachment on
 * every boot is replaced by a one-time repair.
 *
 * THE REPAIR IS THE PART WITH SOMEBODY'S FILES IN IT. It only ever moves a
 * deadline LATER — a repair that could bring one closer would be the original
 * bug from the other side — and it leaves alone anything already further out
 * than it would set.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatmig');
const SKIP = cfg ? false : SKIP_REASON;

const boot = async (token) => {
  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: token, CHAT_SWEEP_MINUTES: '0' });
  stopServer(server);
};
/* THREE PEOPLE WITH REAL ROWS. chat_members has a foreign key on user_id, so a
   fixture membership needs a user to point at — which is worth knowing: a test
   that invents an id gets ER_NO_REFERENCED_ROW_2 rather than a wrong answer. */
const people = async () => {
  for (const [id, name] of [['u-ana', 'Ana'], ['u-bo', 'Bo'], ['u-cas', 'Cas']]) {
    await sql(cfg,
      'INSERT IGNORE INTO users (id, `name`, email, password_hash, role) VALUES (?,?,?,?,?)',
      [id, name, `${id}@mig.test`, 'x', 'game_artist']);
  }
};

const columnsOf = async (table) =>
  (await sql(cfg, `SHOW COLUMNS FROM \`${table}\``)).map((r) => r.Field);

test('a fresh install has everything, and a second boot changes nothing',
  { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('mig-1');

  const settings = await columnsOf('chat_settings');
  for (const c of ['attachment_hours', 'replies_enabled', 'emoji_picker_enabled']) {
    assert.ok(settings.includes(c), `chat_settings.${c}`);
  }
  assert.ok((await columnsOf('chat_messages')).includes('reply_to_message_id'));

  const row = (await sql(cfg,
    'SELECT attachment_hours AS h, replies_enabled AS r, emoji_picker_enabled AS e FROM chat_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(row.h), 12, 'twelve hours, which is what the code always meant');
  assert.strictEqual(Number(row.r), 1, 'replies on');
  assert.strictEqual(Number(row.e), 1, 'the picker on');

  /* NULLABLE, which is what lets a row that cannot be dated exist rather than
     forcing an expiry to be invented for it. */
  const expires = (await sql(cfg,
    `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_attachments'
        AND COLUMN_NAME = 'expires_at'`))[0];
  assert.strictEqual(String(expires.n).toUpperCase(), 'YES');

  /* AND NO FOREIGN KEY ON THE REPLY COLUMN. ON DELETE SET NULL would erase the
     fact that a message was a reply, and a reply with no pointer has no quote
     to say "this message was deleted" in. */
  const fks = await sql(cfg,
    `SELECT CONSTRAINT_NAME AS n FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages'
        AND COLUMN_NAME = 'reply_to_message_id' AND REFERENCED_TABLE_NAME IS NOT NULL`);
  assert.deepStrictEqual(fks, [], 'the reply column carries no foreign key');

  await boot('mig-1b');
  assert.strictEqual(Number((await sql(cfg,
    'SELECT attachment_hours AS h FROM chat_settings WHERE id = 1'))[0].h), 12,
  'a second boot leaves the setting alone');
});

test('an existing database gains all of it without losing anything', { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('mig-2a');

  /* THE SHAPE BEFORE THIS PROMPT, by taking the additions back out — which
     keeps this test about the four things that are new rather than about a
     reconstructed old schema that could be wrong in its own ways. */
  await sql(cfg, 'ALTER TABLE chat_settings DROP COLUMN attachment_hours');
  await sql(cfg, 'ALTER TABLE chat_settings DROP COLUMN replies_enabled');
  await sql(cfg, 'ALTER TABLE chat_settings DROP COLUMN emoji_picker_enabled');
  await sql(cfg, 'ALTER TABLE chat_messages DROP COLUMN reply_to_message_id');
  await sql(cfg, 'ALTER TABLE chat_attachments MODIFY COLUMN expires_at DATETIME NOT NULL');
  await sql(cfg, "UPDATE chat_settings SET max_group_members = 42 WHERE id = 1");

  await sql(cfg, "INSERT INTO chat_conversations (id, kind) VALUES ('c-old', 'direct')");
  await sql(cfg, "INSERT INTO chat_messages (id, conversation_id, body) VALUES ('m-old', 'c-old', 'said before')");

  for (const pass of [1, 2]) {
    await boot(`mig-2-${pass}`);
    const settings = await columnsOf('chat_settings');
    for (const c of ['attachment_hours', 'replies_enabled', 'emoji_picker_enabled']) {
      assert.ok(settings.includes(c), `pass ${pass}: chat_settings.${c}`);
    }
    assert.ok((await columnsOf('chat_messages')).includes('reply_to_message_id'), `pass ${pass}: the reply column`);

    const row = (await sql(cfg,
      'SELECT max_group_members AS m, attachment_hours AS h FROM chat_settings WHERE id = 1'))[0];
    assert.strictEqual(Number(row.m), 42, `pass ${pass}: the studio's own group size is untouched`);
    assert.strictEqual(Number(row.h), 12, `pass ${pass}: and the new column takes its default`);

    const msg = (await sql(cfg, "SELECT body, reply_to_message_id AS r FROM chat_messages WHERE id = 'm-old'"))[0];
    assert.strictEqual(msg.body, 'said before', `pass ${pass}: the message is as it was`);
    assert.strictEqual(msg.r, null, `pass ${pass}: and is not a reply`);
  }
});

test('the incident table arrives, survives a second run, and keeps what is in it',
  { skip: SKIP }, async () => {
  /* PROMPT 59'S ONLY NEW TABLE. Three things worth pinning: it exists, a second
     boot leaves its rows alone, and it has NO foreign key on attachment_id —
     an incident about an attachment that is later deleted is exactly the
     incident worth keeping, and a cascade would delete the record of the
     problem along with its subject. */
  await resetSchema(cfg);
  await boot('inc-1');

  const cols = await columnsOf('chat_file_incidents');
  for (const c of ['id', 'attachment_id', 'kind', 'detail', 'created_at']) {
    assert.ok(cols.includes(c), `chat_file_incidents.${c}`);
  }
  const nullable = (await sql(cfg,
    `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_file_incidents'
        AND COLUMN_NAME = 'attachment_id'`))[0];
  assert.strictEqual(String(nullable.n).toUpperCase(), 'YES',
    'a sweep that refused to run is about no single attachment');
  const fks = await sql(cfg,
    `SELECT CONSTRAINT_NAME AS n FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_file_incidents'
        AND REFERENCED_TABLE_NAME IS NOT NULL`);
  assert.deepStrictEqual(fks, [], 'and no foreign key to cascade the evidence away');

  await sql(cfg,
    `INSERT INTO chat_file_incidents (id, attachment_id, kind, detail)
     VALUES ('i1', 'some-attachment', 'missing_before_expiry', 'written by hand for this test')`);
  await boot('inc-2');
  const kept = await sql(cfg, "SELECT detail FROM chat_file_incidents WHERE id = 'i1'");
  assert.strictEqual(kept.length, 1, 'a second boot keeps the row');
  assert.strictEqual(kept[0].detail, 'written by hand for this test');
});

test('an existing database gains the incident table without losing anything',
  { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('inc-3');
  await sql(cfg, "INSERT INTO chat_conversations (id, kind) VALUES ('c-inc', 'direct')");
  await sql(cfg, "INSERT INTO chat_messages (id, conversation_id, body) VALUES ('m-inc', 'c-inc', 'said')");
  await sql(cfg, 'DROP TABLE chat_file_incidents');

  for (const pass of [1, 2]) {
    await boot(`inc-4-${pass}`);
    assert.ok((await columnsOf('chat_file_incidents')).includes('kind'),
      `pass ${pass}: the table is there`);
    const msg = await sql(cfg, "SELECT body FROM chat_messages WHERE id = 'm-inc'");
    assert.strictEqual(msg[0].body, 'said', `pass ${pass}: and the conversation is untouched`);
  }
});

test('the group role column arrives, backfills from is_owner, and a second boot is a no-op',
  { skip: SKIP }, async () => {
  /* PROMPT 60'S MIGRATION. Ownership has lived in chat_members.is_owner since
     chat was built; group_role is added beside it and backfilled from it. The
     two then say the same thing in two shapes, in lockstep, which is a decision
     recorded on the schema and asserted here: a pair of columns that can drift
     is a bug waiting for its first week in production. */
  await resetSchema(cfg);
  await boot('role-1');

  const cols = await columnsOf('chat_members');
  assert.ok(cols.includes('group_role'), 'chat_members.group_role');
  assert.ok(cols.includes('is_owner'), 'and is_owner is still there — nothing was dropped');
  const col = (await sql(cfg,
    `SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_members'
        AND COLUMN_NAME = 'group_role'`))[0];
  assert.match(String(col.t), /varchar\(16\)/i);
  assert.strictEqual(String(col.n).toUpperCase(), 'NO', 'never NULL: an absent role is a member');
  /* MariaDB quotes a string default in information_schema; MySQL does not. */
  assert.strictEqual(String(col.d).replace(/^'|'$/g, ''), 'member',
    'and the default is the role with no powers');

  await boot('role-1b');
  assert.ok((await columnsOf('chat_members')).includes('group_role'), 'a second boot is a no-op');
});

test('an existing database with groups keeps every member and gains the roles',
  { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('role-2');

  /* THE SHAPE BEFORE THIS PROMPT: the column taken back out, so what is tested
     is the migration and not a reconstructed schema that could be wrong in its
     own ways. */
  await sql(cfg, 'ALTER TABLE chat_members DROP COLUMN group_role');
  await people();
  await sql(cfg, "INSERT INTO chat_conversations (id, kind, title, created_by) "
    + "VALUES ('g-owned', 'group', 'Has an owner', 'u-ana'), "
    + "('g-ownerless', 'group', 'Lost its owner', 'u-ana'), "
    + "('d-pair', 'direct', NULL, 'u-ana')");
  /* A group with an owner, a group whose owner has gone (which this
     application can produce: see the README on owner departure), and a
     one-to-one, which has no roles at all. */
  await sql(cfg, `INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES
    ('g-owned', 'u-ana', 1), ('g-owned', 'u-bo', 0), ('g-owned', 'u-cas', 0),
    ('g-ownerless', 'u-bo', 0), ('g-ownerless', 'u-cas', 0),
    ('d-pair', 'u-ana', 0), ('d-pair', 'u-bo', 0)`);
  const before = Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM chat_members'))[0].n);

  for (const pass of [1, 2]) {
    await boot(`role-3-${pass}`);
    const rows = await sql(cfg,
      'SELECT conversation_id AS c, user_id AS u, is_owner AS o, group_role AS r '
      + 'FROM chat_members ORDER BY conversation_id, user_id');
    assert.strictEqual(rows.length, before, `pass ${pass}: not one membership was lost`);
    const role = (c, u) => (rows.find((x) => x.c === c && x.u === u) || {}).r;
    assert.strictEqual(role('g-owned', 'u-ana'), 'owner', `pass ${pass}: is_owner became 'owner'`);
    assert.strictEqual(role('g-owned', 'u-bo'), 'member', `pass ${pass}: everybody else is a member`);
    assert.strictEqual(role('g-ownerless', 'u-bo'), 'member',
      `pass ${pass}: a group with no owner gains no owner from this`);
    assert.strictEqual(role('d-pair', 'u-ana'), 'member',
      `pass ${pass}: a one-to-one has no roles — the rows carry the default and nothing reads it`);
    for (const row of rows) {
      assert.strictEqual(Number(row.o) === 1, row.r === 'owner',
        `pass ${pass}: is_owner and group_role agree for ${row.u} in ${row.c}`);
    }
  }
});

test('an admin already in the table is not demoted by the backfill', { skip: SKIP }, async () => {
  /* THE SECOND-RUN CASE WITH SOMETHING TO LOSE. Once a studio has admins, a
     backfill that read "not the owner, therefore member" would wipe them on the
     next deploy. It is written to leave 'admin' alone, and this is the case
     that would catch it — found by asking what the second boot does rather than
     whether it errors. */
  await resetSchema(cfg);
  await boot('role-4');
  await people();
  await sql(cfg, "INSERT INTO chat_conversations (id, kind, title) VALUES ('g-adm', 'group', 'Admins')");
  await sql(cfg, `INSERT INTO chat_members (conversation_id, user_id, is_owner, group_role) VALUES
    ('g-adm', 'u-ana', 1, 'owner'), ('g-adm', 'u-bo', 0, 'admin'), ('g-adm', 'u-cas', 0, 'member')`);

  await boot('role-5');
  const rows = await sql(cfg,
    "SELECT user_id AS u, group_role AS r FROM chat_members WHERE conversation_id = 'g-adm' ORDER BY user_id");
  assert.deepStrictEqual(rows.map((x) => [x.u, x.r]),
    [['u-ana', 'owner'], ['u-bo', 'admin'], ['u-cas', 'member']],
    'the admin is still an admin after another migration run');
});

test('the group admins switch arrives on, and keeps whatever it was told',
  { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('role-6');
  const fresh = (await sql(cfg, 'SELECT group_admins_enabled AS g FROM chat_settings WHERE id = 1'))[0];
  assert.strictEqual(Number(fresh.g), 1, 'on by default');

  /* Switched off by hand, then migrated again: a boot must not switch a
     studio's choice back on. */
  await sql(cfg, 'UPDATE chat_settings SET group_admins_enabled = 0 WHERE id = 1');
  await boot('role-7');
  assert.strictEqual(Number((await sql(cfg,
    'SELECT group_admins_enabled AS g FROM chat_settings WHERE id = 1'))[0].g), 0,
  'and a migration does not change it back');

  /* AND ON A DATABASE THAT PREDATES THE COLUMN. */
  await sql(cfg, 'ALTER TABLE chat_settings DROP COLUMN group_admins_enabled');
  await boot('role-8');
  assert.strictEqual(Number((await sql(cfg,
    'SELECT group_admins_enabled AS g FROM chat_settings WHERE id = 1'))[0].g), 1,
  'the column is added with the default');
});

test('the repair moves a mangled expiry later, and never earlier', { skip: SKIP }, async () => {
  await resetSchema(cfg);
  await boot('mig-3a');
  await sql(cfg, "INSERT INTO chat_conversations (id, kind) VALUES ('c-rep', 'direct')");
  await sql(cfg, "INSERT INTO chat_messages (id, conversation_id, body) VALUES ('m-rep', 'c-rep', 'x')");

  const add = (id, minutes) => sql(cfg,
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, created_at, expires_at)
     VALUES (?, 'm-rep', 'f.png', 1, 'f.png', NOW(), NOW() + INTERVAL ? MINUTE)`, [id, minutes]);

  /* MANGLED: created_at to expires_at is not a whole number of hours, which is
     what a timezone offset in the gap looks like. -08:00 against UTC gives
     four hours; the half-hour zones (+05:30, +05:45) are why the test is in
     minutes rather than hours. */
  await add('mangled', 4 * 60 + 30);
  /* HEALTHY: a clean twelve hours, left exactly alone. */
  await add('healthy', 12 * 60);
  /* LONGER THAN THE REPAIR WOULD GIVE IT: a studio that chose 48 hours and
     uploaded under it. Never shortened. */
  await add('generous', 48 * 60);
  /* NO EXPIRY AT ALL — the backfill case. */
  await sql(cfg, 'ALTER TABLE chat_attachments MODIFY COLUMN expires_at DATETIME NULL');
  await sql(cfg,
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, created_at, expires_at)
     VALUES ('undated', 'm-rep', 'f.png', 1, 'f.png', NOW(), NULL)`);

  const gaps = async () => {
    const rows = await sql(cfg,
      'SELECT id, TIMESTAMPDIFF(MINUTE, created_at, expires_at) AS gap FROM chat_attachments ORDER BY id');
    return new Map(rows.map((r) => [r.id, r.gap === null ? null : Number(r.gap)]));
  };
  const before = await gaps();

  await boot('mig-3b');
  const after = await gaps();

  assert.strictEqual(after.get('mangled'), 720,
    'the shifted one is repaired to twelve hours from upload');
  assert.strictEqual(after.get('healthy'), 720, 'a clean one is left as it is');
  assert.strictEqual(after.get('generous'), before.get('generous'),
    'and one already further out is NEVER shortened — that would be the bug again');
  assert.strictEqual(after.get('undated'), 720, 'an undated row is given one');

  /* IDEMPOTENT: a second boot finds nothing to move. */
  await boot('mig-3c');
  const twice = await gaps();
  assert.deepStrictEqual([...twice.entries()].sort(), [...after.entries()].sort(),
    'running it again changes nothing');

  /* AND A SWEPT ROW IS NEVER TOUCHED, whatever its stamps say — its file is
     already gone and moving its deadline would say otherwise. */
  await sql(cfg,
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, created_at,
       expires_at, deleted_at)
     VALUES ('swept', 'm-rep', 'f.png', 1, NULL, NOW(), NOW() + INTERVAL 270 MINUTE, NOW())`);
  await boot('mig-3d');
  const swept = (await sql(cfg,
    "SELECT TIMESTAMPDIFF(MINUTE, created_at, expires_at) AS gap FROM chat_attachments WHERE id = 'swept'"))[0];
  assert.strictEqual(Number(swept.gap), 270, 'a row the sweep has finished with is left alone');
});
