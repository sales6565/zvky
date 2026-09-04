/* Start Date, and the rule that an asset cannot be started before it.
 *
 * The comparison itself is pure and is tested without a database, because the
 * edge cases are all calendar arithmetic: the day itself, the day after, the
 * blank, and the hours around midnight IST when the server's own date is still
 * yesterday. The gate is then tested through the endpoint, because a rule the
 * button shows and the server does not enforce is not a rule.
 */
const test = require('node:test');
const assert = require('node:assert');
const schedule = require('../src/asset-schedule');
const assetImport = require('../src/asset-import');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('startDate');

// --- the comparison, with no database in sight ------------------------------

test('today is the studio\'s day, not the server\'s', () => {
  /* The case that makes IST worth stating. At 20:00 UTC the studio is already
     on tomorrow, and a rule using the server's date would hold a task closed
     for another five and a half hours after the team arrived to do it. */
  assert.strictEqual(schedule.todayInIST(new Date('2026-03-10T20:00:00Z')), '2026-03-11');
  assert.strictEqual(schedule.todayInIST(new Date('2026-03-10T18:29:00Z')), '2026-03-10',
    'a minute before the boundary is still today');
  assert.strictEqual(schedule.todayInIST(new Date('2026-03-10T18:31:00Z')), '2026-03-11',
    'and a minute after it is tomorrow');
  // Across a month and a year end, where naive date maths breaks.
  assert.strictEqual(schedule.todayInIST(new Date('2026-12-31T19:00:00Z')), '2027-01-01');
});

test('on or after, never only on', () => {
  const now = new Date('2026-03-10T06:00:00Z');          // 11:30 IST on the 10th
  const at = (start) => schedule.startsInFuture({ start_date: start }, now);

  assert.strictEqual(at('2026-03-11'), true, 'tomorrow is not yet');
  assert.strictEqual(at('2026-03-10'), false, 'the day itself opens it');
  /* The trap this rule exists to avoid: a task nobody started on the day is
     late, not forbidden. Strictly-that-day would lock it out for good, with
     editing the date as the only way back. */
  assert.strictEqual(at('2026-03-09'), false, 'and a date already passed stays startable');
  assert.strictEqual(at('2020-01-01'), false, 'however long ago it was');
});

test('no start date means no waiting', () => {
  const now = new Date('2026-03-10T06:00:00Z');
  for (const blank of [null, undefined, '']) {
    assert.strictEqual(schedule.startsInFuture({ start_date: blank }, now), false,
      `${JSON.stringify(blank)} must behave exactly as it did before the field existed`);
    assert.strictEqual(schedule.notYetMessage({ start_date: blank }, now), null);
  }
  assert.strictEqual(schedule.startsInFuture({}, now), false, 'and so must an asset with no such key');
  assert.strictEqual(schedule.startsInFuture(null, now), false);
});

test('a stored DATE is read as the day it is, whatever the reader\'s zone', () => {
  /* The driver hands a DATE back as a Date at local midnight. Rendering that
     through toISOString() prints the day before for anybody east of Greenwich,
     which would open a task a day early. */
  assert.strictEqual(schedule.asISODate(new Date(2026, 2, 10)), '2026-03-10');
  assert.strictEqual(schedule.asISODate('2026-03-10'), '2026-03-10');
  assert.strictEqual(schedule.asISODate('2026-03-10T00:00:00.000Z'), '2026-03-10');
  assert.strictEqual(schedule.asISODate(''), null);
  assert.strictEqual(schedule.asISODate(null), null);
  assert.strictEqual(schedule.asISODate('not a date'), null);
});

test('both dates are optional columns in the bulk sheet', () => {
  const columns = assetImport.describeFormat().columns;
  const named = (header) => columns.find((c) => c.name === header);

  assert.ok(named('Start Date'), 'Start Date is offered');
  assert.strictEqual(named('Start Date').required, false, 'and is optional');
  assert.ok(named('End Date (Deadline)'), 'the deadline column carries its new label');
  assert.strictEqual(named('End Date (Deadline)').required, false, 'and stays optional');

  // The sample file has a row with both blank, which is what "optional" means
  // to somebody reading it rather than reading this test.
  const rows = assetImport.buildTemplateCsv().trim().split('\n');
  const head = rows[0].split(',');
  const startAt = head.indexOf('Start Date');
  const dueAt = head.indexOf('End Date (Deadline)');
  assert.ok(startAt > -1 && dueAt === startAt + 1, 'and they sit next to each other');
  const blankRow = rows.slice(1).map((r) => r.split(',')).find((cells) => !cells[startAt] && !cells[dueAt]);
  assert.ok(blankRow, 'the sample shows a row with neither date');
});

// --- through the endpoint ---------------------------------------------------

test('the start date gate', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Start-Date-1!';
  let server;
  const token = {};
  const people = {};
  let projectId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const day = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return schedule.todayInIST(d);
  };
  const makeAsset = async (name, startDate) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', assigneeId: people.ana, startDate },
  })).body.asset;
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'start-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'start-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Scheduled' } })).body.project.id;
    people.ana = (await as('root', '/users', { method: 'POST', body: {
      name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD, projectId,
    } })).body.user.id;
    token.ana = await login('ana@zvky.test');
  });

  t.after(() => stopServer(server));

  await t.test('a start date in the future holds the button closed', async () => {
    const later = await makeAsset('Ridge Gate', day(3));
    assert.strictEqual(schedule.asISODate(later.start_date), day(3), 'the date is stored and returned');

    const refused = await start('ana', later.id);
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /cannot be started until/i);
    assert.strictEqual(refused.body.startsOn, day(3), 'and the answer names the day');
  });

  await t.test('today and any day already past are startable', async () => {
    const todays = await makeAsset('Today Gate', day(0));
    assert.strictEqual((await start('ana', todays.id)).status, 200, 'the day itself opens it');
    await as('ana', `/assets/${todays.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/today' } });

    const passed = await makeAsset('Late Gate', day(-5));
    assert.strictEqual((await start('ana', passed.id)).status, 200,
      'a date that slipped past is late, not forbidden');
    await as('ana', `/assets/${passed.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/late' } });
  });

  await t.test('no start date behaves exactly as before', async () => {
    const open = await makeAsset('No Gate', null);
    assert.strictEqual(schedule.asISODate(open.start_date), null);
    assert.strictEqual((await start('ana', open.id)).status, 200);
    await as('ana', `/assets/${open.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/open' } });
  });

  await t.test('either rule alone is enough to refuse', async () => {
    /* The combined logic, stated as the two independent reasons it is: a task
       whose day HAS arrived is still refused while another is open, and a task
       with nothing else open is still refused before its day. */
    const held = await makeAsset('Holds The Slot', null);
    assert.strictEqual((await start('ana', held.id)).status, 200);

    const readyToday = await makeAsset('Ready Today', day(0));
    const blockedByWork = await start('ana', readyToday.id);
    assert.strictEqual(blockedByWork.status, 409);
    assert.match(blockedByWork.body.error, /Finish your current task/i,
      'the date has arrived, so the other rule is what refuses it');

    // Free the slot; now only the date can refuse.
    await as('ana', `/assets/${held.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/held' } });
    assert.strictEqual((await start('ana', readyToday.id)).status, 200, 'and then it opens');
    await as('ana', `/assets/${readyToday.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/ready' } });

    const future = await makeAsset('Not Yet', day(2));
    const blockedByDate = await start('ana', future.id);
    assert.strictEqual(blockedByDate.status, 409);
    assert.match(blockedByDate.body.error, /cannot be started until/i,
      'nothing else is open, so the date is what refuses it');
  });

  await t.test('editing the date opens or closes the gate', async () => {
    const asset = await makeAsset('Movable', day(4));
    assert.strictEqual((await start('ana', asset.id)).status, 409);

    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { startDate: day(0) } });
    assert.strictEqual((await start('ana', asset.id)).status, 200, 'brought forward, it opens');
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/movable' } });

    // And clearing it removes the restriction entirely.
    const another = await makeAsset('Clearable', day(6));
    assert.strictEqual((await start('ana', another.id)).status, 409);
    await as('root', `/assets/${another.id}`, { method: 'PATCH', body: { startDate: null } });
    assert.strictEqual((await start('ana', another.id)).status, 200, 'cleared, it opens');
  });

  await t.test('the deadline is untouched by any of this', async () => {
    /* The relabel is a label. The column, the value and everything that reads
       it are the same, which is what stops "End Date (Deadline)" becoming a
       second deadline field holding different data. */
    const withBoth = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST',
      body: { name: 'Both Dates', type: 'prop', startDate: '2026-03-01', due: '2026-03-31' },
    })).body.asset;
    assert.strictEqual(schedule.asISODate(withBoth.start_date), '2026-03-01');
    assert.strictEqual(schedule.asISODate(withBoth.due_date), '2026-03-31');

    await as('root', `/assets/${withBoth.id}`, { method: 'PATCH', body: { due: '2026-04-30' } });
    const after = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === withBoth.id);
    assert.strictEqual(schedule.asISODate(after.due_date), '2026-04-30', 'the deadline still edits');
    assert.strictEqual(schedule.asISODate(after.start_date), '2026-03-01', 'without disturbing the start');
  });
});
