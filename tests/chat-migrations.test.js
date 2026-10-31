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
