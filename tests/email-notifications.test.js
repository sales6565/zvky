/* Email notifications: the two events, the settings behind them, and the
 * per-person switch that turns them off.
 *
 * ASSERTED AGAINST DELIVERED MAIL. Every send in this file goes over a real
 * SMTP session to a server in tests/smtp-server.js, which stores what it was
 * given. So "the assigner was emailed" means an envelope actually carried that
 * address, not that a stubbed function was called with it — and a From header
 * assembled wrongly, a message with no body, or authentication in a shape no
 * server accepts all fail here rather than on the studio's first real send.
 *
 * The two things most worth breaking are the two hardest to notice:
 *
 *   the password must never come back      It is write-only by design. Several
 *                                          assertions below sweep whole
 *                                          responses and the whole Activity Log
 *                                          for the string, rather than checking
 *                                          the one field somebody remembered.
 *
 *   the bell must be untouched             The brief was an additive channel.
 *                                          The notification rows an assignment
 *                                          and a submission produce are counted
 *                                          with email off and again with it on,
 *                                          and must be identical.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const emailSecret = require('../src/email-secret');
const emailConfigModule = require('../src/email-config');
const mailer = require('../src/mailer');
const smtp = require('./smtp-server');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('email');

// --- the encryption, on its own ----------------------------------------------
// The one reversibly-stored secret in this database. Tested without a server,
// because every failure mode has a different remedy and the module has to be
// able to tell them apart.

test('the SMTP password is encrypted, and the ciphertext does not contain it', () => {
  const previous = process.env.EMAIL_ENCRYPTION_KEY;
  process.env.EMAIL_ENCRYPTION_KEY = 'a-key-long-enough-to-be-a-key';
  try {
    const sealed = emailSecret.encrypt('correct-horse-battery-staple');
    assert.strictEqual(sealed.ok, true);
    assert.ok(!sealed.value.includes('correct-horse'), 'the plaintext must not survive in the stored value');
    assert.ok(!Buffer.from(sealed.value).includes(Buffer.from('correct-horse')));
    const opened = emailSecret.decrypt(sealed.value, sealed.keyId);
    assert.strictEqual(opened.value, 'correct-horse-battery-staple');

    // Same password, twice: different bytes, or the IV is not doing its job.
    assert.notStrictEqual(emailSecret.encrypt('same').value, emailSecret.encrypt('same').value);
  } finally {
    if (previous === undefined) delete process.env.EMAIL_ENCRYPTION_KEY;
    else process.env.EMAIL_ENCRYPTION_KEY = previous;
  }
});

test('a rotated key gives a sentence to act on rather than a silence', () => {
  const previous = process.env.EMAIL_ENCRYPTION_KEY;
  try {
    process.env.EMAIL_ENCRYPTION_KEY = 'the-original-key-value-here';
    const sealed = emailSecret.encrypt('smtp-secret');

    /* THE FAILURE THIS EXISTS TO PREVENT. Rotating JWT_SECRET is a thing an
       administrator SHOULD do. Without the fingerprint the only symptom would
       be mail quietly not arriving; with it the screen can say which key
       changed and what to do about it. */
    process.env.EMAIL_ENCRYPTION_KEY = 'a-different-key-after-rotation';
    const opened = emailSecret.decrypt(sealed.value, sealed.keyId);
    assert.strictEqual(opened.ok, false);
    assert.strictEqual(opened.reason, 'key-changed');
    assert.match(opened.error, /Enter the password again/i);

    // Tampering is caught too — GCM authenticates, so a flipped bit is refused
    // rather than decrypted into rubbish and handed to a mail server.
    process.env.EMAIL_ENCRYPTION_KEY = 'the-original-key-value-here';
    const parts = sealed.value.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 1;
    parts[3] = body.toString('base64');
    assert.strictEqual(emailSecret.decrypt(parts.join(':'), sealed.keyId).ok, false);
  } finally {
    if (previous === undefined) delete process.env.EMAIL_ENCRYPTION_KEY;
    else process.env.EMAIL_ENCRYPTION_KEY = previous;
  }
});

test('the permission is Super Admin only, the same way the IP lists are', () => {
  const entry = catalogue.BY_KEY.get('settings.email_config');
  assert.ok(entry, 'settings.email_config is in the catalogue');
  assert.strictEqual(entry.label, 'Manage Email Configuration');

  /* Compared against the shipped Super-Admin-only permission rather than
     against a hand-written list of capabilities: if the idiom for "Super Admin
     only" ever changes, this moves with it instead of quietly passing. */
  const blocklist = catalogue.BY_KEY.get('settings.ip_blocklist');
  for (const caps of [
    {}, { manageSettings: true }, { manageAccess: true },
    { manageSettings: true, manageAccess: true }, { managePermissions: true },
  ]) {
    assert.strictEqual(entry.impliedBy(caps), blocklist.impliedBy(caps),
      `settings.email_config should match settings.ip_blocklist for ${JSON.stringify(caps)}`);
  }
  assert.strictEqual(entry.impliedBy({ manageSettings: true }), false,
    'managing priorities must not carry the studio mail password with it');
});

test('a failure names the likely cause rather than the error code', () => {
  /* The whole reason mailer.explain exists. On this deployment's shared
     hosting the commonest cause by a distance is a blocked outbound port, and
     "ETIMEDOUT" sends somebody to look at the mail server instead. */
  const blocked = mailer.explain({ code: 'ETIMEDOUT', message: 'Connection timeout' },
    { host: 'smtp.example.com', port: 587 });
  assert.match(blocked, /blocked/i);
  assert.match(blocked, /check-outbound/, 'it should name the script that tells the two apart');

  const auth = mailer.explain({ code: 'EAUTH', message: 'Invalid login: 535' }, { host: 'h', port: 1 });
  assert.match(auth, /username and password/i);
  assert.match(auth, /app-specific/i, 'two-factor accounts are the usual cause and worth naming');

  const wrongTls = mailer.explain({ message: 'wrong version number' }, { host: 'h', port: 465 });
  assert.match(wrongTls, /465|STARTTLS/);
  // The original is always kept: a guess that hides the evidence is worse.
  assert.match(blocked, /Connection timeout/);
});

/* Batching, which needs a server of its own.
 *
 * The suite above runs with EMAIL_BATCH_MS=0 so its assertions follow a request
 * rather than a timer. Batching is the behaviour that only exists when that
 * window is OPEN, so it gets its own server, its own database and its own mail
 * server — and asserts the thing a studio would actually notice: assigning
 * forty tasks at once produces one email, not forty.
 */
const batchCfg = config('emailbatch');

test('a bulk assign is one email, not one per task', { skip: batchCfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Email-Batch-1!';
  let server;
  let inbox;
  let projectId;
  const token = {};
  const people = {};
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  t.before(async () => {
    await resetSchema(batchCfg);
    inbox = await smtp.start();
    server = await startServer(batchCfg, {
      BOOTSTRAP_TOKEN: 'batch-token',
      EMAIL_ENCRYPTION_KEY: 'a-test-key-for-the-email-suite',
      // Open, and long enough that a loop of assignments lands inside it.
      EMAIL_BATCH_MS: '400',
    });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'batch-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Bulk' } })).body.project.id;
    people.ana = (await as('root', '/users', { method: 'POST', body: {
      name: 'Ana Roy', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD, projectId,
    } })).body.user.id;
    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
  });

  t.after(async () => {
    await stopServer(server);
    if (inbox) await inbox.stop();
  });

  await t.test('five tasks assigned at once arrive as one digest', async () => {
    // Made unassigned, so creating them raises nothing.
    const ids = [];
    for (const name of ['Reel A', 'Reel B', 'Reel C', 'Reel D', 'Reel E']) {
      const asset = (await as('root', `/assets/project/${projectId}`, {
        method: 'POST', body: { name, type: 'prop' },
      })).body.asset;
      ids.push(asset.id);
    }
    inbox.reset();

    const res = await as('root', '/assets/bulk/assign', {
      method: 'POST', body: { assetIds: ids, assigneeId: people.ana },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    // Wait past the window, then look.
    await new Promise((r) => setTimeout(r, 1400));

    assert.strictEqual(inbox.messages.length, 1,
      `five assignments should be one email, got ${inbox.messages.length}`);
    const m = inbox.messages[0];
    assert.deepStrictEqual(m.envelope.to, ['ana@zvky.test']);
    assert.match(m.subject, /5 tasks assigned to you/);
    // Every one of them named, or the digest has lost work.
    for (const name of ['Reel A', 'Reel B', 'Reel C', 'Reel D', 'Reel E']) {
      assert.ok(m.body.includes(name), `the digest should list ${name}`);
    }
  });

  await t.test('a single assignment is still a single-task email, not a digest of one', async () => {
    inbox.reset();
    await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Just one', type: 'prop', assigneeId: people.ana },
    });
    await new Promise((r) => setTimeout(r, 1400));
    assert.strictEqual(inbox.messages.length, 1);
    assert.match(inbox.messages[0].subject, /^Assigned to you:/);
    assert.ok(!/tasks assigned/.test(inbox.messages[0].subject));
  });
});

// --- against a live server, with a live mail server beside it ------------------

test('email notifications', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Email-Test-1!';
  const SMTP_USER = 'studio';
  const SMTP_PASS = 'the-smtp-password-nobody-should-see';
  let server;
  let inbox;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const makeAsset = async (name, assigneeId, extra = {}) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', assigneeId, ...extra },
  })).body.asset;
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });
  const submit = (who, id) => as(who, `/assets/${id}/submit`, {
    method: 'POST', body: { link: 'https://drive.zvky.test/work' },
  });
  const sentTo = (address) => inbox.messages.filter((m) => m.envelope.to.includes(address));

  /* Wait for the mail to land.
   *
   * NOT a workaround for a flaky test — it is the feature working as designed.
   * Sending is deliberately fire-and-forget so that a dead mail server cannot
   * fail an assignment, which means the message leaves AFTER the response does.
   * Asserting synchronously would be asserting that email is synchronous, which
   * is the behaviour this codebase specifically does not want.
   *
   * Polls rather than sleeping a fixed time: it returns the moment the message
   * is there, so the suite is not paced by its slowest guess. */
  const settle = async (predicate, what, ms = 4000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) {
        const log = server.output().split('\n').filter((l) => /email|mail/i.test(l)).slice(-14).join('\n');
        assert.fail(`${what} — waited ${ms}ms; the inbox holds `
          + `${JSON.stringify(inbox.messages.map((m) => m.envelope.to))}\nserver said:\n${log}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /* The other direction: prove nothing arrives. There is no event to wait for,
     so this waits out the window a message would have arrived in. */
  const quiet = async (ms = 600) => { await new Promise((r) => setTimeout(r, ms)); };

  t.before(async () => {
    await resetSchema(cfg);
    inbox = await smtp.start({ user: SMTP_USER, pass: SMTP_PASS });
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'email-token',
      EMAIL_ENCRYPTION_KEY: 'a-test-key-for-the-email-suite',
      /* No batching window. Assignment emails are normally queued for a moment
         so that a bulk assign becomes one message; here they go immediately so
         an assertion follows the request rather than a timer. The batching
         itself is tested separately, with the window switched back on. */
      EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'email-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Slots III' } })).body.project.id;

    const person = async (name, email, role, extra = {}) => (await as('root', '/users', { method: 'POST', body: {
      name, email, role, password: PASSWORD, projectId, ...extra,
    } })).body.user.id;
    people.lead = await person('Priya Menon', 'priya@zvky.test', 'team_lead');
    people.ana = await person('Ana Roy', 'ana@zvky.test', 'game_artist', { teamLeadId: people.lead });
    people.bo = await person('Bo Sen', 'bo@zvky.test', 'game_artist');
    token.priya = await login('priya@zvky.test');
    token.ana = await login('ana@zvky.test');
    token.bo = await login('bo@zvky.test');

    /* The fixture, checked rather than assumed. Half the assertions below turn
       on Priya being Ana's team lead, and a setup that silently failed to link
       them would make those tests pass for the wrong reason — or fail while
       pointing at the feature instead of at this block. */
    const [row] = await sql(cfg, 'SELECT team_lead_id AS lead FROM users WHERE email = ?', ['ana@zvky.test']);
    assert.strictEqual(row.lead, people.lead, 'Ana should report to Priya for the submission tests');
    people.root = (await as('root', '/auth/me')).body.user.id;
  });

  t.after(async () => {
    await stopServer(server);
    if (inbox) await inbox.stop();
  });

  // --- step 5, first: who may even see this screen ---------------------------

  await t.test('only a holder of the permission can read or change the settings', async () => {
    assert.strictEqual((await as('root', '/email-config')).status, 200);
    for (const [method, path] of [['GET', '/email-config'], ['PUT', '/email-config'], ['POST', '/email-config/test']]) {
      const res = await as('ana', path, { method, body: method === 'GET' ? undefined : { host: 'x' } });
      assert.strictEqual(res.status, 403, `${method} ${path} must be refused to an ordinary account`);
    }
    assert.strictEqual((await call('/email-config')).status, 401, 'and signed out entirely');
  });

  // --- step 1: configure a real SMTP account and send a test -----------------

  await t.test('a test email is sent using the values on the form, before they are saved', async () => {
    inbox.reset();
    /* The point of the button. Nothing has been saved at this stage — the
       configuration is still empty — and the test must still go out, or
       somebody would have to commit a setting to find out whether it works. */
    const before = await as('root', '/email-config');
    assert.strictEqual(before.body.config.host, '', 'nothing saved yet');
    assert.strictEqual(before.body.state.key, 'unconfigured');

    const res = await as('root', '/email-config/test', { method: 'POST', body: {
      host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, password: SMTP_PASS,
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
      to: 'root@zvky.test',
    } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual(inbox.messages.length, 1, 'a real message should have arrived');
    const message = inbox.messages[0];
    assert.strictEqual(message.envelope.from, 'noreply@zvkydesign.com');
    assert.deepStrictEqual(message.envelope.to, ['root@zvky.test']);
    assert.strictEqual(message.from, 'ZVKY FORGE <noreply@zvkydesign.com>');
    assert.match(message.subject, /test email/i);
    assert.match(message.body, /Email is working/);

    // Authentication genuinely happened, with the credentials from the form.
    const used = inbox.authAttempts.find((a) => a.value === SMTP_USER);
    assert.ok(used, 'the username on the form should have been presented');

    // And still nothing is saved: a test is not a save.
    assert.strictEqual((await as('root', '/email-config')).body.config.host, '');
  });

  await t.test('a test against a server that refuses says what to do about it', async () => {
    const res = await as('root', '/email-config/test', { method: 'POST', body: {
      host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, password: 'the-wrong-password',
      fromAddress: 'noreply@zvkydesign.com', to: 'root@zvky.test',
    } });
    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.match(res.body.error, /refused the username and password/i);
    assert.ok(!res.body.error.includes('the-wrong-password'),
      'the attempted password must not be echoed back');
  });

  await t.test('saving stores the password encrypted, and never returns it again', async () => {
    const saved = await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, password: SMTP_PASS,
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    /* THE WHOLE RESPONSE, not the one field somebody remembered to check. */
    assert.ok(!JSON.stringify(saved.body).includes(SMTP_PASS),
      'the save response must not contain the password anywhere');
    const read = await as('root', '/email-config');
    assert.ok(!JSON.stringify(read.body).includes(SMTP_PASS),
      'nor must reading it back');
    assert.strictEqual(read.body.config.hasPassword, true, 'but the screen knows there IS one');
    assert.ok(read.body.config.passwordMask.length > 0, 'and has a placeholder to show');
    assert.ok(!read.body.config.passwordMask.includes(SMTP_PASS));
    assert.strictEqual(read.body.state.key, 'on');

    /* At rest, in the column itself. A response that hides the password while
       the database holds it in plain text would pass every assertion above. */
    const rows = await sql(cfg, 'SELECT password_enc FROM email_config WHERE id = 1');
    assert.ok(rows[0].password_enc, 'something was stored');
    assert.ok(!String(rows[0].password_enc).includes(SMTP_PASS),
      'the stored column must not contain the password in the clear');
    assert.match(String(rows[0].password_enc), /^v1:/, 'and should be the versioned ciphertext');
  });

  await t.test('an unrelated edit does not wipe the stored password', async () => {
    /* The bug a write-only field invites: the form cannot send back what it was
       never given, so an absent password has to mean "leave it alone". If it
       meant "clear it", changing the From name would silently stop all mail. */
    const res = await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, fromName: 'ZVKY FORGE Studio', fromAddress: 'noreply@zvkydesign.com',
    } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.config.hasPassword, true, 'the password must survive an unrelated edit');
    assert.strictEqual(res.body.config.fromName, 'ZVKY FORGE Studio');

    // And it still works, which is the assertion that matters.
    inbox.reset();
    const test2 = await as('root', '/email-config/test', { method: 'POST', body: { to: 'root@zvky.test' } });
    assert.strictEqual(test2.status, 200, JSON.stringify(test2.body));
    assert.strictEqual(inbox.messages.length, 1);
  });

  // --- step 2: assignment ----------------------------------------------------

  await t.test('assigning a task emails the person it was assigned to', async () => {
    inbox.reset();
    const asset = await makeAsset('Dragon idle loop', people.ana, { due: '2026-10-02' });

    await settle(() => sentTo('ana@zvky.test').length === 1, 'expected one email to Ana');
    const m = sentTo('ana@zvky.test')[0];
    assert.match(m.subject, /^Assigned to you:/);
    assert.ok(m.subject.includes(asset.code), 'the subject should name the task');
    assert.match(m.body, /Root Admin assigned you/, 'and the body should say who did it');
    assert.ok(m.body.includes('Dragon idle loop'), 'and name the task');
    assert.match(m.body, /2 Oct 2026/, 'and carry the due date, since there is one');
    assert.match(m.body, /Slots III/, 'and the project');
    assert.match(m.body, /switch off email notifications/i, 'and say how to stop them');

    // Nobody else was written to. An email about somebody else's task is worse
    // than no email.
    assert.strictEqual(inbox.messages.length, 1, 'exactly one message left the building');
  });

  await t.test('assigning to yourself sends nothing', async () => {
    inbox.reset();
    /* Root assigns Root. The bell already drops this case; the email follows
       the same rule, because being told what you just did is noise. */
    await makeAsset('Self assigned', null);
    const asset = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.name === 'Self assigned');
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.root || null } });
    await quiet();
    assert.strictEqual(sentTo('root@zvky.test').length, 0);
  });

  await t.test('a reassignment emails the new holder and not the old one', async () => {
    inbox.reset();
    const asset = await makeAsset('Coin burst', people.ana);
    inbox.reset();

    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    await settle(() => sentTo('bo@zvky.test').length === 1, 'the new holder should be emailed');
    /* And the person it LEFT is not. They still get the bell entry — that is
       untouched — but an email they cannot act on is how a studio learns to
       ignore email it can. */
    assert.strictEqual(sentTo('ana@zvky.test').length, 0,
      'losing a task is a bell entry, not an email');
  });

  // --- step 3: submission ----------------------------------------------------

  await t.test('submitting emails whoever assigned it, and the team lead', async () => {
    /* Cleared before the action, not after: a settle() satisfied by an earlier
       subtest's message would return early and the reset below would then throw
       away the message this test is about. */
    inbox.reset();
    const asset = await makeAsset('Reel spin', people.ana);
    await settle(() => sentTo('ana@zvky.test').length === 1, 'the assignment email should arrive first');
    assert.strictEqual((await start('ana', asset.id)).status, 200);
    inbox.reset();

    const done = await submit('ana', asset.id);
    assert.strictEqual(done.status, 201, JSON.stringify(done.body));

    // Root assigned it; Priya is Ana's team lead. Both, once each.
    await settle(() => inbox.messages.length === 2, 'expected two submission emails');
    assert.strictEqual(sentTo('root@zvky.test').length, 1, 'the assigner is told');
    assert.strictEqual(sentTo('priya@zvky.test').length, 1, 'and the team lead');
    assert.strictEqual(sentTo('ana@zvky.test').length, 0, 'the submitter is not told they submitted');
    assert.strictEqual(inbox.messages.length, 2, 'and nobody else at all');

    const m = sentTo('root@zvky.test')[0];
    assert.match(m.subject, /^Submitted:/);
    assert.ok(m.subject.includes(asset.code));
    assert.match(m.body, /Ana Roy has submitted/, 'who completed it');
    assert.match(m.body, /Reel spin/);
    assert.match(m.body, /Submitted: \d/, 'and when');
  });

  await t.test('the submitter is dropped from their own recipient list', async () => {
    /* The de-duplication rule: recipients are the assigner and the team lead,
       minus whoever just submitted. Being told what you did a second ago is
       noise, and it is the mail people cite when they turn the channel off.
       
       The state is built directly in the row rather than through a route,
       because no designation in this studio can both assign work and be given
       it — an assigner is a lead or above, and start/submit belong to the
       person the task is assigned to. The rule is about the DATA, so the data
       is what this arranges: an episode whose assigned_by_id is the same person
       it is assigned to. */
    inbox.reset();
    const asset = await makeAsset('Assigned by Ana to Ana', people.ana);
    await settle(() => sentTo('ana@zvky.test').length === 1, 'the assignment email should arrive first');

    await sql(cfg,
      'UPDATE asset_assignments SET assigned_by_id = ? WHERE asset_id = ? AND ended_at IS NULL',
      [people.ana, asset.id]);

    assert.strictEqual((await start('ana', asset.id)).status, 200);
    inbox.reset();
    const done = await submit('ana', asset.id);
    assert.strictEqual(done.status, 201, JSON.stringify(done.body));

    // Priya is still told — she is the team lead, and she did not submit it.
    await settle(() => sentTo('priya@zvky.test').length === 1, 'the team lead still hears');
    await quiet();
    assert.strictEqual(sentTo('ana@zvky.test').length, 0,
      'Ana assigned it and Ana submitted it, so Ana hears nothing');
    assert.strictEqual(inbox.messages.length, 1, 'and nobody else at all');
  });

  // --- step 4: the personal opt-out -----------------------------------------

  await t.test('a person who opts out receives neither email', async () => {
    // On to begin with, which is the migration's default and the point of it.
    const before = await as('ana', '/auth/email-preference');
    assert.strictEqual(before.body.emailNotifications, true);

    const off = await as('ana', '/auth/email-preference', {
      method: 'POST', body: { emailNotifications: false } });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.emailNotifications, false);

    // 1. no assignment email
    inbox.reset();
    const asset = await makeAsset('Silent assignment', people.ana);
    await quiet();
    assert.strictEqual(sentTo('ana@zvky.test').length, 0, 'no assignment email after opting out');

    // 2. no completion email either — checked from the other direction, with
    //    Ana as a RECIPIENT of somebody else's submission rather than as the
    //    person assigned. Both paths go through the same lookup, and this is
    //    what proves it.
    const theirs = await makeAsset('Bo does this', people.bo);
    await as('root', `/assets/${theirs.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    await start('bo', theirs.id);
    inbox.reset();
    await submit('bo', theirs.id);
    await quiet();
    assert.strictEqual(sentTo('ana@zvky.test').length, 0);

    // 3. and the bell is NOT affected — opting out of email is not opting out
    //    of the application.
    const bell = await as('ana', '/notifications');
    assert.ok((bell.body.notifications || []).some((n) => n.assetId === asset.id),
      'the notification for the silent assignment should still be in the bell');

    // Back on, and mail resumes — an opt-out that could not be undone would be
    // a worse bug than one that never worked.
    await as('ana', '/auth/email-preference', { method: 'POST', body: { emailNotifications: true } });
    inbox.reset();
    await makeAsset('Audible again', people.ana);
    await settle(() => sentTo('ana@zvky.test').length === 1, 'mail should resume after opting back in');
  });

  await t.test('the opt-out is the person\'s own, and needs no permission', async () => {
    /* Every signed-in account can reach it, including one with no Settings
       access at all. A switch somebody can be denied is not an opt-out. */
    for (const who of ['ana', 'bo', 'priya', 'root']) {
      assert.strictEqual((await as(who, '/auth/email-preference')).status, 200);
    }
    assert.strictEqual((await call('/auth/email-preference')).status, 401, 'but not signed out');
    // And it changes only your own row.
    await as('bo', '/auth/email-preference', { method: 'POST', body: { emailNotifications: false } });
    assert.strictEqual((await as('ana', '/auth/email-preference')).body.emailNotifications, true,
      'Bo opting out must not touch Ana');
    await as('bo', '/auth/email-preference', { method: 'POST', body: { emailNotifications: true } });
  });

  // --- the master switch -----------------------------------------------------

  await t.test('the master switch stops both emails without unsaving anything', async () => {
    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: false, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
    inbox.reset();
    const asset = await makeAsset('Nothing sent', people.ana);
    await start('ana', asset.id);
    await submit('ana', asset.id);
    await quiet();
    assert.strictEqual(inbox.messages.length, 0, 'nothing at all goes out with the switch off');

    const read = await as('root', '/email-config');
    assert.strictEqual(read.body.state.key, 'off');
    assert.strictEqual(read.body.config.hasPassword, true, 'and the settings are still there');

    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });
  });

  // --- step 6: nothing else moved --------------------------------------------

  await t.test('the notification bell produces exactly what it did before', async () => {
    /* THE "DO NOT TOUCH" REQUIREMENT, as an assertion rather than an intention.
       The same two actions are performed with email off and again with it on,
       and the rows they leave in the bell are counted both times. Email adding
       a notification kind, or dropping one, shows up here. */
    const countFor = async (who) => (await as(who, '/notifications')).body.notifications.length;

    const setEnabled = (enabled) => as('root', '/email-config', { method: 'PUT', body: {
      enabled, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });

    const run = async () => {
      const anaBefore = await countFor('ana');
      const rootBefore = await countFor('root');
      const asset = await makeAsset('Bell probe', people.ana);
      await start('ana', asset.id);
      await submit('ana', asset.id);
      await quiet();
      return {
        ana: (await countFor('ana')) - anaBefore,
        root: (await countFor('root')) - rootBefore,
      };
    };

    await setEnabled(false);
    const withoutEmail = await run();
    await setEnabled(true);
    inbox.reset();
    const withEmail = await run();

    assert.deepStrictEqual(withEmail, withoutEmail,
      'switching email on must not change how many notifications an action raises');
    assert.strictEqual(withoutEmail.ana, 1, 'an assignment is still one bell entry for the assignee');
    assert.strictEqual(withoutEmail.root, 0,
      'and a submission still raises NO bell entry — email did not add a kind');
    assert.ok(inbox.messages.length > 0, 'while the email half did happen');
  });

  // --- accountability, and the one thing that must never be in it ------------

  await t.test('configuration changes are logged, and the password never is', async () => {
    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true, host: '127.0.0.1', port: inbox.port, encryption: 'none',
      username: SMTP_USER, password: SMTP_PASS,
      fromName: 'ZVKY FORGE', fromAddress: 'changed@zvkydesign.com',
    } });

    const log = await as('root', '/activity?limit=200');
    assert.strictEqual(log.status, 200, JSON.stringify(log.body));
    const entries = log.body.entries.filter((e) => e.module === 'settings' && /^email\./.test(e.action));
    assert.ok(entries.length, 'the change should be recorded');

    const saved = entries.find((e) => e.action === 'email.config_updated');
    assert.ok(saved, 'a configuration change is its own action');
    assert.strictEqual(saved.actor.email, 'root@zvky.test');
    assert.match(saved.summary, /email configuration/i);
    assert.ok(saved.changes && saved.changes.fromAddress, 'and says which fields moved');
    assert.strictEqual(saved.changes.fromAddress.to, 'changed@zvkydesign.com');

    /* Recorded as "set", never as a value — not the new one, not the old one,
       not its length. */
    if (saved.changes.password) {
      assert.strictEqual(saved.changes.password.to, 'set');
      assert.ok(!String(saved.changes.password.to).includes(SMTP_PASS));
    }

    // The whole log, swept. This is the assertion worth having: it does not
    // depend on remembering which field might carry it.
    assert.ok(!JSON.stringify(log.body).includes(SMTP_PASS),
      'the password must appear nowhere in the Activity Log');

    const test = entries.find((e) => e.action === 'email.test_sent');
    assert.ok(test, 'sending a test is recorded too');
    assert.match(test.summary, /test email/i);

    // And nowhere in the table behind it either.
    const rows = await sql(cfg,
      'SELECT summary, changes FROM activity_log WHERE action LIKE ?', ['email.%']);
    for (const row of rows) {
      assert.ok(!String(row.summary || '').includes(SMTP_PASS));
      assert.ok(!String(row.changes || '').includes(SMTP_PASS));
    }
  });

  await t.test('a mail server that is unreachable does not fail the assignment', async () => {
    /* The rule the whole feature hangs off. An artist whose task could not be
       assigned because a mail server was down would be a far worse bug than an
       email that did not arrive. */
    await as('root', '/email-config', { method: 'PUT', body: {
      enabled: true,
      // A port with nothing on it. Refused immediately rather than hanging.
      host: '127.0.0.1', port: 1, encryption: 'none',
      fromName: 'ZVKY FORGE', fromAddress: 'noreply@zvkydesign.com',
    } });

    const asset = await makeAsset('Assigned anyway', people.ana);
    assert.ok(asset && asset.id, 'the asset was still created');
    assert.strictEqual(asset.assigneeId || asset.assignee_id, people.ana, 'and still assigned');

    await start('ana', asset.id);
    const done = await submit('ana', asset.id);
    assert.strictEqual(done.status, 201, 'and the submission still succeeded');

    /* The screen can say why nothing is arriving, which is the other half.
       Polled rather than read once: the failure is recorded when the send
       finally gives up, which is after the response that triggered it. */
    let read = await as('root', '/email-config');
    const deadline = Date.now() + 8000;
    while (read.body.state.key !== 'failing' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      read = await as('root', '/email-config');
    }
    assert.strictEqual(read.body.state.key, 'failing',
      `expected the screen to report the failure, got ${JSON.stringify(read.body.state)}`);
    assert.ok(read.body.lastError, 'and carries the reason');
  });
});
