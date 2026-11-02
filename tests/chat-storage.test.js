/* WHERE CHAT FILES LIVE, AND THE SECOND REPORT OF THEM VANISHING.
 *
 * ===========================================================================
 * THE BUG. Attachments were disappearing in under an hour with the retention
 * set to twelve, reported on screen as "file is no longer available". The age
 * arithmetic was not at fault — Prompt 58 fixed that and nine timezone
 * combinations prove it still works. This is the other half: the BYTES were
 * stored at <app>/uploads/chat, inside the deployed application directory, and
 * on cPanel the application directory is what a deploy replaces. The rows
 * survive, the files do not, and the panel said "no longer available" for both.
 *
 * THE REPRODUCTION IS THE FIRST TWO CASES, and it is a simulated deploy: a file
 * written under the old root, the app directory replaced the way an extract or
 * a Git deployment replaces it, and then the same read the panel does. Nothing
 * in the retention is touched and the clock does not move.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('chatstore');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Chat-Storage-11!';

/* A ROOT THAT IS NEITHER INSIDE THE APP NOR IN TEMP, which is the whole point
   of the check being tested — so the tests cannot use the scratch directory
   they would normally reach for. Under the home directory, beside the app
   rather than inside it, which is the shape cPanel gives. */
const SAFE_BASE = path.join(os.homedir(), '.zvky-test-chat-uploads');
const rootFor = (name) => path.join(SAFE_BASE, name);

const MESSAGE_ID = '22222222-2222-2222-2222-222222222222';
async function prepare(extraEnv = {}) {
  await resetSchema(cfg);
  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'prep-store',
    CHAT_SWEEP_MINUTES: '0', ...extraEnv });
  stopServer(server);
  await sql(cfg, "INSERT IGNORE INTO chat_conversations (id, kind) VALUES ('conv-store', 'direct')");
  await sql(cfg,
    "INSERT IGNORE INTO chat_messages (id, conversation_id, body) VALUES (?, 'conv-store', 'x')",
    [MESSAGE_ID]);
}

/* A child process is the only honest way to ask "what does the app think the
   root is when started with THIS environment": the answer is computed from the
   environment of the process that asks. */
function askInChild(env, script) {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const statusWith = (env) => askInChild(env,
  "const s=require('./src/chat-storage');console.log(JSON.stringify(s.status({refresh:true})));");

test('THE REPRODUCTION: a deploy that replaces the app directory takes the files with it',
  { skip: SKIP }, async () => {
  /* The old layout, built from the module's own idea of where the app is, so
     this cannot drift from the code. */
  const appDir = require('../src/chat-storage').APP_DIR;
  const legacy = require('../src/chat-storage').LEGACY_DIR;
  assert.ok(legacy.startsWith(appDir + path.sep),
    `the old upload root was inside the application directory: ${legacy}`);

  /* A STAND-IN APP DIRECTORY, because the test is not going to delete the
     checkout it is running from. Same shape: an app folder with an uploads
     folder inside it. */
  const fake = path.join(SAFE_BASE, 'deploy-sim');
  const appOne = path.join(fake, 'app');
  fs.rmSync(fake, { recursive: true, force: true });
  fs.mkdirSync(path.join(appOne, 'uploads', 'chat'), { recursive: true });
  const file = path.join(appOne, 'uploads', 'chat', 'brief.png');
  fs.writeFileSync(file, 'the bytes somebody sent at nine in the morning');
  assert.ok(fs.existsSync(file), 'the file is there before the deploy');

  /* THE DEPLOY, the way cPanel does it: a fresh extract of the archive (which
     ships uploads/ empty) replacing the application folder. Whether the owner
     clears the folder first, extracts beside it and renames, or uses cPanel's
     Git deployment into a clean checkout, the result is this. */
  const appTwo = path.join(fake, 'app-new');
  fs.mkdirSync(path.join(appTwo, 'uploads', 'chat'), { recursive: true });   // the empty one from the zip
  fs.rmSync(appOne, { recursive: true, force: true });
  fs.renameSync(appTwo, appOne);

  assert.ok(!fs.existsSync(file),
    'and gone after it — which is the bug, and it has nothing to do with any retention');
  assert.ok(fs.existsSync(path.join(appOne, 'uploads', 'chat')),
    'the folder is back, empty, so nothing even looks broken');

  /* AND A ROOT OUTSIDE THE APP SURVIVES THE SAME DEPLOY. */
  const outside = path.join(fake, 'chat-uploads');
  fs.mkdirSync(outside, { recursive: true });
  const kept = path.join(outside, 'brief.png');
  fs.writeFileSync(kept, 'the same bytes, one folder up');
  fs.rmSync(appOne, { recursive: true, force: true });
  fs.mkdirSync(path.join(appOne, 'uploads', 'chat'), { recursive: true });
  assert.ok(fs.existsSync(kept), 'a file outside the application folder is still there');
  fs.rmSync(fake, { recursive: true, force: true });
});

test('a file under the configured root survives a restart of the application',
  { skip: SKIP }, async (t) => {
  const root = rootFor('restart');
  fs.rmSync(root, { recursive: true, force: true });
  await prepare({ CHAT_UPLOAD_DIR: root });

  let server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-1', CHAT_UPLOAD_DIR: root,
    CHAT_SWEEP_MINUTES: '0' });
  const base = server.base;
  await api(base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'store-1', name: 'Root', email: 'root@store.test', password: PASSWORD } });
  const token = (await api(base, '/auth/login',
    { method: 'POST', body: { email: 'root@store.test', password: PASSWORD } })).body.token;
  /* SOMEBODY TO SEND TO. A studio of one has nobody in /chat/people, and a
     direct conversation needs two. */
  const made = await api(base, '/users', { method: 'POST', token,
    body: { name: 'Ana', email: 'ana@store.test', password: PASSWORD, role: 'game_artist' } });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));

  /* A real upload through the real route, so the file lands wherever the
     application actually puts it. */
  const people = (await api(base, '/chat/people', { token })).body.people;
  assert.ok(people && people.length, 'somebody to talk to');
  const conv = await api(base, '/chat/direct',
    { method: 'POST', token, body: { userId: people[0].id } });
  const convId = conv.body.conversationId;
  assert.ok(convId, `a conversation to send into: ${JSON.stringify(conv.body)}`);

  const form = new FormData();
  form.set('body', 'the brief');
  form.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'brief.png');
  const sent = await fetch(`${base}/chat/${convId}/messages`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  /* READ ONCE: an assertion message is built whether or not it is needed, so a
     `await res.text()` in one consumes the body the parse below wants. */
  const sentText = await sent.text();
  assert.strictEqual(sent.status, 201, sentText);
  const attachment = JSON.parse(sentText).message.attachments[0];

  const onDisk = fs.readdirSync(root).filter((n) => !n.startsWith('.'));
  assert.strictEqual(onDisk.length, 1, `the file is in the configured root: ${root}`);
  stopServer(server);

  /* THE RESTART. A new process, the same environment, nothing else touched. */
  server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-2', CHAT_UPLOAD_DIR: root,
    CHAT_SWEEP_MINUTES: '0' });
  t.after(() => { if (server) stopServer(server); });
  const freshToken = (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: 'root@store.test', password: PASSWORD } })).body.token;
  const after = await fetch(`${server.base}/chat/attachments/${attachment.id}`,
    { headers: { Authorization: `Bearer ${freshToken}` } });
  const afterText = await after.text();
  assert.ok(fs.existsSync(path.join(root, onDisk[0])), 'the bytes are still there after the restart');
  assert.strictEqual(after.status, 200,
    `and the server still serves them: ${after.status} ${afterText}`);
});

test('a root that is not safe is refused, with the reason', { skip: SKIP }, async () => {
  const appDir = require('../src/chat-storage').APP_DIR;

  /* INSIDE THE APPLICATION DIRECTORY — the cause of this bug. */
  const insideApp = statusWith({ CHAT_UPLOAD_DIR: path.join(appDir, 'uploads', 'chat') });
  assert.strictEqual(insideApp.ok, false);
  assert.deepStrictEqual(insideApp.problems.map((p) => p.code), ['inside-app']);
  assert.match(insideApp.problems[0].message, /deploy replaces/i);

  /* A TEMPORARY DIRECTORY — the same fault with the host as its owner. */
  for (const dir of [path.join(os.tmpdir(), 'zvky-chat'), '/tmp/zvky-chat', '/var/tmp/zvky-chat']) {
    const temp = statusWith({ CHAT_UPLOAD_DIR: dir });
    assert.strictEqual(temp.ok, false, dir);
    assert.ok(temp.problems.some((p) => p.code === 'temp'), `${dir}: ${JSON.stringify(temp.problems)}`);
  }

  /* RELATIVE — which on this host is read against whatever directory Passenger
     started the process in, and that is not reliably the app folder. */
  const relative = statusWith({ CHAT_UPLOAD_DIR: 'uploads/chat' });
  assert.strictEqual(relative.ok, false);
  assert.deepStrictEqual(relative.problems.map((p) => p.code), ['relative']);

  /* NOT WRITABLE. Skipped when the tests run as root, for whom everything is
     writable and the case would prove the opposite of what it says. */
  if (process.getuid && process.getuid() !== 0) {
    const locked = rootFor('locked');
    fs.rmSync(locked, { recursive: true, force: true });
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500);
    const no = statusWith({ CHAT_UPLOAD_DIR: locked });
    fs.chmodSync(locked, 0o700);
    assert.strictEqual(no.ok, false);
    assert.ok(no.problems.some((p) => p.code === 'not-writable'));
  }

  /* AND A GOOD ONE IS ACCEPTED, and created if it is not there yet — a missing
     folder on a fresh deployment is the normal case, not a misconfiguration. */
  const fresh = rootFor('made-by-the-app');
  fs.rmSync(fresh, { recursive: true, force: true });
  const good = statusWith({ CHAT_UPLOAD_DIR: fresh });
  assert.strictEqual(good.ok, true, JSON.stringify(good.problems));
  assert.strictEqual(good.source, 'env');
  assert.ok(fs.existsSync(fresh), 'and the folder was created');
});

test('with the root unusable, uploads are refused and everything else goes on working',
  { skip: SKIP }, async (t) => {
  await prepare();
  /* Pointed INSIDE the application directory, which is exactly the production
     misconfiguration this prompt is about. */
  const bad = path.join(require('../src/chat-storage').APP_DIR, 'uploads', 'chat');
  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-3', CHAT_UPLOAD_DIR: bad,
    CHAT_SWEEP_MINUTES: '0' });
  t.after(() => stopServer(server));
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'store-3', name: 'Root', email: 'root@store3.test', password: PASSWORD } });
  const token = (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: 'root@store3.test', password: PASSWORD } })).body.token;
  await api(server.base, '/users', { method: 'POST', token,
    body: { name: 'Ana', email: 'ana@store3.test', password: PASSWORD, role: 'game_artist' } });
  const people = (await api(server.base, '/chat/people', { token })).body.people;
  assert.ok(people && people.length, 'somebody to talk to');
  const convId = (await api(server.base, '/chat/direct',
    { method: 'POST', token, body: { userId: people[0].id } })).body.conversationId;

  /* THE PANEL IS TOLD, so the paperclip can be off rather than lying. */
  const panel = await api(server.base, '/chat', { token });
  assert.strictEqual(panel.body.attachments.storageOk, false);

  /* A MESSAGE WITH NO FILE STILL SENDS. Refusing all of chat over a storage
     misconfiguration would be a bigger outage than the one being prevented. */
  const words = await api(server.base, `/chat/${convId}/messages`,
    { method: 'POST', token, body: { body: 'this still works' } });
  assert.strictEqual(words.status, 201, JSON.stringify(words.body));

  /* A MESSAGE WITH A FILE IS REFUSED, with the variable named. The folder's
     contents are noted FIRST and compared after: asserting it is empty would
     conflate "multer wrote nothing" with "nothing was in there to begin with",
     and this folder is the legacy one, which other cases put files in. */
  const before = fs.existsSync(bad) ? fs.readdirSync(bad).sort() : [];
  const form = new FormData();
  form.set('body', 'here it is');
  form.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'brief.png');
  const res = await fetch(`${server.base}/chat/${convId}/messages`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const refusedText = await res.text();
  assert.strictEqual(res.status, 503, refusedText);
  const said = JSON.parse(refusedText);
  assert.match(said.error, /CHAT_UPLOAD_DIR/);
  assert.match(said.error, /not sent/i, 'and says the message did not go');

  /* NOTHING WAS WRITTEN. multer never ran, so there is no stray file. */
  assert.deepStrictEqual(fs.readdirSync(bad).sort(), before,
    'and not one byte was written into the folder that is about to be replaced');
});

test('files in the old folder are copied forward, never moved, and the copy is idempotent',
  { skip: SKIP }, async () => {
  const root = rootFor('copy-forward');
  fs.rmSync(root, { recursive: true, force: true });
  await prepare({ CHAT_UPLOAD_DIR: root });

  const legacy = require('../src/chat-storage').LEGACY_DIR;
  fs.mkdirSync(legacy, { recursive: true });
  const live = path.join(legacy, 'still-live.png');
  const expired = path.join(legacy, 'long-gone.png');
  const unclaimed = path.join(legacy, 'nobody-claims-this.png');
  fs.writeFileSync(live, 'live bytes');
  fs.writeFileSync(expired, 'expired bytes');
  fs.writeFileSync(unclaimed, 'orphan bytes');

  await sql(cfg, 'DELETE FROM chat_attachments');
  await sql(cfg,
    `INSERT INTO chat_attachments (id, message_id, file_name, byte_size, stored_name, created_at, expires_at)
     VALUES ('live', '${MESSAGE_ID}', 'still-live.png', 10, 'still-live.png', NOW(), NOW() + INTERVAL 6 HOUR),
            ('old', '${MESSAGE_ID}', 'long-gone.png', 10, 'long-gone.png', NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 1 DAY)`);

  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-4', CHAT_UPLOAD_DIR: root,
    CHAT_SWEEP_MINUTES: '0' });
  stopServer(server);

  /* THE LIVE ONE IS THERE NOW, in the new root. */
  assert.ok(fs.existsSync(path.join(root, 'still-live.png')), 'the live file was copied forward');
  /* AND THE ORIGINAL IS STILL THERE. The one hard rule about the old folder. */
  assert.ok(fs.existsSync(live), 'and the original was not moved');
  /* AN EXPIRED ROW IS NOT CARRIED OVER — it is about to be swept anyway. */
  assert.ok(!fs.existsSync(path.join(root, 'long-gone.png')), 'an expired file is not copied');
  /* NOR IS A FILE NO ROW CLAIMS. */
  assert.ok(!fs.existsSync(path.join(root, 'nobody-claims-this.png')), 'nor an unclaimed one');
  assert.ok(fs.existsSync(unclaimed), 'and that one is still where it was, untouched');

  /* IDEMPOTENT: a second boot copies nothing again. Asserted on the mtime,
     because "it ran again and overwrote it with the same bytes" and "it left it
     alone" look identical from the content. */
  const was = fs.statSync(path.join(root, 'still-live.png')).mtimeMs;
  await new Promise((r) => setTimeout(r, 1100));
  const again = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-5', CHAT_UPLOAD_DIR: root,
    CHAT_SWEEP_MINUTES: '0' });
  stopServer(again);
  assert.strictEqual(fs.statSync(path.join(root, 'still-live.png')).mtimeMs, was,
    'the second run left the copy exactly as it was');

  fs.rmSync(live, { force: true });
  fs.rmSync(expired, { force: true });
  fs.rmSync(unclaimed, { force: true });
});

test('a file still only in the old folder is served from there', { skip: SKIP }, async (t) => {
  const root = rootFor('fallback');
  fs.rmSync(root, { recursive: true, force: true });
  await prepare({ CHAT_UPLOAD_DIR: root });
  const legacy = require('../src/chat-storage').LEGACY_DIR;
  fs.mkdirSync(legacy, { recursive: true });

  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'store-6', CHAT_UPLOAD_DIR: root,
    CHAT_SWEEP_MINUTES: '0' });
  t.after(() => stopServer(server));
  await api(server.base, '/auth/bootstrap', { method: 'POST',
    body: { token: 'store-6', name: 'Root', email: 'root@store6.test', password: PASSWORD } });
  const token = (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: 'root@store6.test', password: PASSWORD } })).body.token;
  await api(server.base, '/users', { method: 'POST', token,
    body: { name: 'Ana', email: 'ana@store6.test', password: PASSWORD, role: 'game_artist' } });
  const people = (await api(server.base, '/chat/people', { token })).body.people;
  assert.ok(people && people.length, 'somebody to talk to');
  const convId = (await api(server.base, '/chat/direct',
    { method: 'POST', token, body: { userId: people[0].id } })).body.conversationId;
  const message = (await api(server.base, `/chat/${convId}/messages`,
    { method: 'POST', token, body: { body: 'see attached' } })).body.message;

  /* A ROW WHOSE BYTES ARE ONLY IN THE OLD PLACE — which is every file a
     deployment sent before the folder was configured and the catch-up ran. */
  const name = 'from-before.png';
  fs.writeFileSync(path.join(legacy, name), 'bytes from the old folder');
  await sql(cfg,
    `INSERT INTO chat_attachments (id, message_id, file_name, mime, byte_size, stored_name, created_at, expires_at)
     VALUES ('older', ?, 'from-before.png', 'image/png', 24, ?, NOW(), NOW() + INTERVAL 6 HOUR)`,
    [message.id, name]);

  const res = await fetch(`${server.base}/chat/attachments/older`,
    { headers: { Authorization: `Bearer ${token}` } });
  const servedText = await res.text();
  assert.strictEqual(res.status, 200, servedText);
  assert.strictEqual(servedText, 'bytes from the old folder',
    'served out of the old folder, because a reader does not care which one it is in');
  fs.rmSync(path.join(legacy, name), { force: true });
});
