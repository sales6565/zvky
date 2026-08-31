const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');
const notifications = require('../src/notifications');

const cfg = config('notif');

// --- the wording ---------------------------------------------------------------

test('the two sides of a hand-over are told different things', () => {
  /* One shared sentence would produce "FX-001 was reassigned" in both inboxes,
     which reads as a task in one and an accusation in the other. */
  const incoming = notifications.describe({
    kind: 'assigned', asset_code: 'FX-001', asset_name: 'Big Win Burst', other_name: 'Test Admin',
  });
  assert.match(incoming, /Test Admin assigned you FX-001/);

  const outgoing = notifications.describe({
    kind: 'unassigned', asset_code: 'FX-001', asset_name: 'Big Win Burst', other_name: 'Omar Haddad',
  });
  assert.match(outgoing, /FX-001 .* has moved to Omar Haddad/);
  assert.ok(!/assigned you/.test(outgoing), 'the outgoing person is not being given a job');

  // Unassigned entirely: there is nobody to name, and it still has to read.
  assert.match(notifications.describe({ kind: 'unassigned', asset_code: 'FX-001' }),
    /no longer assigned to you/);
  // Assigned by nobody in particular (a system move) still reads.
  assert.match(notifications.describe({ kind: 'assigned', asset_code: 'FX-001' }),
    /You have been assigned FX-001/);
});

test('the message is built on read, not stored', () => {
  /* The row keeps ids. That is what lets a wording change apply to the whole
     history, and an asset renamed after the fact still read correctly. */
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifications.js'), 'utf8');
  const insert = source.match(/INSERT INTO notifications \(([^)]*)\)/);
  assert.ok(insert, 'there should be one insert');
  assert.ok(!/message|body|text/i.test(insert[1]),
    `no rendered text should be stored, columns were: ${insert[1]}`);
});

// --- against a live server -----------------------------------------------------

test('notifications', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Notify-Test-1!';
  let server;
  let projectId;
  const token = {};
  const id = {};

  const as = (who, path, options = {}) => api(server.base, path, { ...options, token: token[who] });
  const inbox = async (who) => (await as(who, '/notifications')).body;
  const newAsset = async (name, assigneeId) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', priority: 'med', assigneeId, manHours: 4 },
  })).body.asset;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'notif-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST', body: { token: 'notif-token', name: 'Root', email: 'root@notif.test', password: PASSWORD },
    });
    const sign = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await sign('root@notif.test');

    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Nightgarden' } })).body.project.id;
    for (const [name, email] of [['Ana Lee', 'ana@notif.test'], ['Bo Chen', 'bo@notif.test'], ['Cy Dean', 'cy@notif.test']]) {
      const res = await as('root', '/users', {
        method: 'POST', body: { name, email, role: 'game_artist', password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const key = email.split('@')[0];
      id[key] = res.body.user.id;
      token[key] = await sign(email);
    }
  });

  t.after(async () => { await stopServer(server); });

  await t.test('a first assignment tells the new holder', async () => {
    // Not Assigned -> Assigned, the very first one.
    const asset = await newAsset('First One', id.ana);
    const ana = await inbox('ana');
    assert.strictEqual(ana.unread, 1);
    assert.strictEqual(ana.notifications[0].kind, 'assigned');
    assert.strictEqual(ana.notifications[0].assetId, asset.id);
    assert.match(ana.notifications[0].message, /assigned you/);
    // It carries what the page needs to navigate.
    assert.strictEqual(ana.notifications[0].projectId, projectId);
    assert.strictEqual(ana.notifications[0].assetCode, asset.code);

    // Nobody held it before, so there is no second person to tell.
    assert.strictEqual((await inbox('bo')).unread, 0);
    assert.strictEqual((await inbox('cy')).unread, 0);
  });

  await t.test('a reassignment tells both people, differently', async () => {
    const asset = await newAsset('Second One', id.ana);
    const before = (await inbox('ana')).unread;

    const moved = await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));

    const bo = await inbox('bo');
    assert.strictEqual(bo.notifications[0].kind, 'assigned');
    assert.match(bo.notifications[0].message, /assigned you/);

    const ana = await inbox('ana');
    assert.strictEqual(ana.unread, before + 1, 'she gained exactly one');
    assert.strictEqual(ana.notifications[0].kind, 'unassigned');
    assert.match(ana.notifications[0].message, /has moved to Bo Chen/);
    assert.ok(!/assigned you/.test(ana.notifications[0].message));

    assert.strictEqual((await inbox('cy')).unread, 0, 'and nobody uninvolved hears anything');
  });

  await t.test('a hand-over out of review tells both people too', async () => {
    /* The third route that changes who holds an asset, and the one most likely
       to be missed: it does not go through PATCH. All three come through
       assignments.open(), which is why the notification is raised there. */
    const asset = await newAsset('Third One', id.ana);
    await sql(cfg, `UPDATE assets SET status = 'pending_tl_review' WHERE id = '${asset.id}'`);
    const anaBefore = (await inbox('ana')).unread;

    const handed = await as('root', `/assets/${asset.id}/reassign`,
      { method: 'POST', body: { assigneeId: id.cy, note: 'over to Cy' } });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));

    const cy = await inbox('cy');
    assert.strictEqual(cy.notifications[0].kind, 'assigned');
    assert.strictEqual(cy.notifications[0].assetId, asset.id);

    const ana = await inbox('ana');
    assert.strictEqual(ana.unread, anaBefore + 1);
    assert.strictEqual(ana.notifications[0].kind, 'unassigned');
    assert.match(ana.notifications[0].message, /has moved to Cy Dean/);
  });

  await t.test('unassigning entirely still tells the person who had it', async () => {
    const asset = await newAsset('Fourth One', id.bo);
    const before = (await inbox('bo')).unread;
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: null } });
    const bo = await inbox('bo');
    assert.strictEqual(bo.unread, before + 1);
    assert.match(bo.notifications[0].message, /no longer assigned to you/);
  });

  await t.test('assigning something to yourself is not worth a notification', async () => {
    // The common case when a lead picks up their own work; telling them is noise.
    const before = (await inbox('root')).unread;
    const asset = await newAsset('Mine', id.ana);
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: null } });
    const rootId = (await as('root', '/auth/me')).body.user.id;
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: rootId } });
    assert.strictEqual((await inbox('root')).unread, before,
      'the person doing the assigning is not told about their own action');
  });

  await t.test('a notification belongs to exactly one person', async () => {
    const ana = await inbox('ana');
    const hers = ana.notifications[0].id;
    assert.ok(hers);

    // Bo cannot see it in his list.
    const bo = await inbox('bo');
    assert.ok(!bo.notifications.some((n) => n.id === hers), 'it is not in anybody else\'s list');

    // Nor mark it read. Not refused with a 403 — it simply is not his to touch,
    // and the scoping is in the WHERE clause rather than a check that could be
    // skipped.
    const before = (await inbox('ana')).unread;
    const attempt = await as('bo', '/notifications/read', { method: 'POST', body: { ids: [hers] } });
    assert.strictEqual(attempt.status, 200);
    assert.strictEqual(attempt.body.marked, 0, 'nothing of his matched');
    assert.strictEqual((await inbox('ana')).unread, before, 'and hers is untouched');
  });

  await t.test('reading clears the count, one at a time and all at once', async () => {
    const start = await inbox('ana');
    assert.ok(start.unread >= 2, `needs a couple to work with, had ${start.unread}`);

    const one = start.notifications.find((n) => !n.read);
    const marked = await as('ana', '/notifications/read', { method: 'POST', body: { ids: [one.id] } });
    assert.strictEqual(marked.status, 200);
    assert.strictEqual(marked.body.marked, 1);
    assert.strictEqual(marked.body.unread, start.unread - 1);

    // Marking the same one again changes nothing — no double-decrement.
    const again = await as('ana', '/notifications/read', { method: 'POST', body: { ids: [one.id] } });
    assert.strictEqual(again.body.marked, 0);
    assert.strictEqual(again.body.unread, start.unread - 1);

    const all = await as('ana', '/notifications/read-all', { method: 'POST' });
    assert.strictEqual(all.body.unread, 0);

    // Read is not deleted: the list is still there to look back at.
    const after = await inbox('ana');
    assert.strictEqual(after.unread, 0);
    assert.strictEqual(after.notifications.length, start.notifications.length);
    assert.ok(after.notifications.every((n) => n.read));
  });

  await t.test('the poll returns only what is new since the last look', async () => {
    /* The cursor is a timestamp rather than an offset: rows are only appended,
       and an offset would skip one if two arrived between polls. */
    const first = await as('ana', '/notifications/poll');
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.fresh, [], 'nothing without a cursor');
    const cursor = first.body.cursor;
    assert.ok(Number.isFinite(cursor), 'and it hands back a cursor to use next time');

    const quiet = await as('ana', `/notifications/poll?since=${cursor}`);
    assert.deepStrictEqual(quiet.body.fresh, [], 'still nothing');

    const asset = await newAsset('Polled One', id.ana);
    const after = await as('ana', `/notifications/poll?since=${cursor}`);
    assert.strictEqual(after.body.fresh.length, 1, 'the one raised since');
    assert.strictEqual(after.body.fresh[0].assetId, asset.id);
    assert.strictEqual(after.body.unread, 1);

    // And the cursor moves on, so the same one is not delivered twice.
    const next = await as('ana', `/notifications/poll?since=${after.body.cursor}`);
    assert.deepStrictEqual(next.body.fresh, [], 'not repeated on the next poll');

    /* The reason the cursor is a sequence and not a timestamp: two rows raised
       in the same second. A time-based cursor drops the second one for good. */
    const before = (await as('ana', '/notifications/poll')).body.cursor;
    const a1 = await newAsset('Same Second A', id.ana);
    const a2 = await newAsset('Same Second B', id.ana);
    const both = await as('ana', `/notifications/poll?since=${before}`);
    assert.strictEqual(both.body.fresh.length, 2,
      'both notifications from the same second come through');
    assert.deepStrictEqual(both.body.fresh.map((n) => n.assetId), [a1.id, a2.id],
      'and in the order they happened');
  });

  await t.test('two notifications in the same second still order correctly', async () => {
    // DATETIME has second precision, so this was arbitrary before `seq`.
    const before = (await inbox('cy')).notifications.length;
    const first = await newAsset('Order A', id.cy);
    const second = await newAsset('Order B', id.cy);
    const list = (await inbox('cy')).notifications;
    assert.strictEqual(list.length, before + 2);
    assert.strictEqual(list[0].assetId, second.id, 'the newer one is first');
    assert.strictEqual(list[1].assetId, first.id);
    assert.ok(list[0].seq > list[1].seq, 'and the sequence says so unambiguously');
  });

  await t.test('signing out and back in, the list is still there', async () => {
    // The whole reason these are stored rather than only pushed.
    const before = await inbox('ana');
    assert.ok(before.notifications.length, 'she has some');
    token.ana = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'ana@notif.test', password: PASSWORD } })).body.token;
    const after = await inbox('ana');
    assert.strictEqual(after.notifications.length, before.notifications.length);
  });

  await t.test('a failure to notify never costs somebody their reassignment', async () => {
    /* Somebody being moved and not told is a much smaller problem than a move
       that refuses to happen. Drop the table and check the assignment still
       works — a deployment that has not run the migration must not be broken by
       this feature. */
    await sql(cfg, 'DROP TABLE notifications');
    const asset = await newAsset('Resilient One', id.ana);
    assert.ok(asset && asset.id, 'creating an assigned asset still works');
    const moved = await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    assert.strictEqual(moved.status, 200, 'and so does reassigning');

    // The endpoints degrade rather than erroring.
    const list = await as('ana', '/notifications');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.notifications, []);
    assert.strictEqual(list.body.unread, 0);
  });
});
