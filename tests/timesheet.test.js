const test = require('node:test');
const assert = require('node:assert');
const sheets = require('../src/timesheets');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('timesheet');

// --- the week arithmetic, with no database in sight -------------------------

test('a week runs Monday to Sunday, and one function says so', () => {
  /* Every lock, total, queue and export turns on "which week is this date in".
     Two implementations of that disagree about Sundays first and everything
     afterwards, so there is one. */
  assert.strictEqual(sheets.weekStart('2026-03-02'), '2026-03-02', 'a Monday is its own week');
  assert.strictEqual(sheets.weekStart('2026-03-05'), '2026-03-02', 'a Thursday looks back');
  assert.strictEqual(sheets.weekStart('2026-03-08'), '2026-03-02',
    'and a Sunday belongs to the week it ends, not the one it precedes');
  assert.strictEqual(sheets.weekStart('2026-03-09'), '2026-03-09', 'Monday starts the next');

  const days = sheets.weekDays('2026-03-05');
  assert.strictEqual(days.length, 7);
  assert.deepStrictEqual(days, ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
    '2026-03-06', '2026-03-07', '2026-03-08']);

  // Across a month and a year boundary, which is where naive date maths breaks.
  assert.strictEqual(sheets.weekStart('2026-01-01'), '2025-12-29');
  assert.strictEqual(sheets.weekDays('2026-01-01')[6], '2026-01-04');
});

test('totals add up, and round once at the end', () => {
  /* Quarter hours in floating point otherwise show 7.999999999999999 on an
     ordinary week, which is the kind of number that makes somebody distrust
     the whole screen. */
  const t = sheets.totals([
    { date: '2026-03-02', hours: '3.25' },
    { date: '2026-03-02', hours: '2.25' },
    { date: '2026-03-02', hours: '2.50' },
    { date: '2026-03-04', hours: 8 },
  ], '2026-03-05');
  assert.strictEqual(t.perDay['2026-03-02'], 8);
  assert.strictEqual(t.perDay['2026-03-04'], 8);
  assert.strictEqual(t.perDay['2026-03-03'], 0, 'an untouched day is nought, not absent');
  assert.strictEqual(t.week, 16);
  assert.deepStrictEqual(t.overLong, [], 'and nothing here is unusual');
});

test('a long day is flagged, never refused', () => {
  /* The studio asked for a soft ceiling, and it is the right shape: a night
     shift crossing midnight is legitimately a long day, and refusing it would
     make somebody lie about their hours to get past the form. */
  const t = sheets.totals([
    { date: '2026-03-05', hours: 20 }, { date: '2026-03-05', hours: 6 },
  ], '2026-03-05');
  assert.strictEqual(t.perDay['2026-03-05'], 26, 'the hours stand');
  assert.deepStrictEqual(t.overLong, ['2026-03-05'], 'and the day is flagged');
});

test('a line is project work or non-project time, never both and never neither', () => {
  const ok = sheets.validateEntry({ date: '2026-03-02', hours: 3, clientId: 'c', projectId: 'p' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.value.weekStart, '2026-03-02', 'and it knows its own week');

  const category = sheets.validateEntry({ date: '2026-03-02', hours: 3, nonProject: 'leave' });
  assert.strictEqual(category.ok, true);
  assert.strictEqual(category.value.clientId, null);

  /* Both is the one that matters: a row carrying a client and "Leave" would be
     counted twice or thrown away depending on which report ran. */
  const both = sheets.validateEntry({ date: '2026-03-02', hours: 3, clientId: 'c', projectId: 'p', nonProject: 'leave' });
  assert.strictEqual(both.ok, false);
  assert.match(both.error, /either project work or non-project time/);

  const neither = sheets.validateEntry({ date: '2026-03-02', hours: 3 });
  assert.strictEqual(neither.ok, false);
  assert.strictEqual(neither.field, 'clientId');

  for (const bad of [0, -2, 'abc', 25]) {
    assert.strictEqual(sheets.validateEntry({ date: '2026-03-02', hours: bad, nonProject: 'admin' }).ok,
      false, `${bad} hours should be refused on a single line`);
  }
  // Typed hours are rounded to the quarter the column can hold.
  assert.strictEqual(sheets.validateEntry({ date: '2026-03-02', hours: 2.1, nonProject: 'admin' }).value.hours, 2);
  assert.strictEqual(sheets.validateEntry({ date: '2026-03-02', hours: 2.4, nonProject: 'admin' }).value.hours, 2.5);
});

test('every designation can fill in its own timesheet', () => {
  /* The one permission in this application that starts ON for everybody. A
     studio that keeps timesheets keeps them for everyone, and an account that
     cannot record its own week cannot be paid from this system. */
  const without = ROLES.filter((r) => !rolePermissions.defaultsFor(r.key).has('timesheet.own'));
  assert.deepStrictEqual(without.map((r) => r.label), [],
    'these designations cannot record their own hours');

  // And the other three are grants, not defaults, for everybody below a lead.
  const artists = ROLES.filter((r) => /Game Artist/.test(r.label));
  assert.ok(artists.length);
  for (const artist of artists) {
    const held = rolePermissions.defaultsFor(artist.key);
    assert.ok(!held.has('timesheet.team'), `${artist.label} should not read the team's by default`);
    assert.ok(!held.has('timesheet.approve'), `${artist.label} should not approve by default`);
    assert.ok(!held.has('timesheet.all'), `${artist.label} should not read the studio's by default`);
  }

  // Super Admin holds the whole catalogue, these four included, without anybody
  // toggling anything.
  const superAdmin = rolePermissions.defaultsFor('super_admin');
  for (const key of ['timesheet.own', 'timesheet.team', 'timesheet.approve', 'timesheet.all']) {
    assert.ok(catalog.KEYS.includes(key), `${key} must be in the catalogue`);
    assert.ok(superAdmin.has(key), `Super Admin must hold ${key}`);
  }

  // Team Lead gets team + approve, which is the studio's "lead and above".
  const lead = rolePermissions.defaultsFor('team_lead');
  assert.ok(lead.has('timesheet.team') && lead.has('timesheet.approve'));
  assert.ok(!lead.has('timesheet.all'), 'but not the whole studio');
});

// --- against a live server ---------------------------------------------------

test('the timesheet', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Timesheet-Test-1!';
  const MON = '2026-03-02';
  let server;
  const token = {};
  const people = {};
  let clientId;
  let projectId;
  let assetId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const add = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const week = async (who, userId) => (await as(who,
    `/timesheets/week?date=${MON}${userId ? `&userId=${userId}` : ''}`)).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ts-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'ts-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    const clients = (await as('root', '/clients')).body.clients;
    clientId = clients[0].id;
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;

    for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    // Ana reports to Lee; Bo reports to nobody, which is what makes the team
    // scope testable rather than assumed.
    await as('root', `/users/${people.ana}`, { method: 'PATCH',
      body: { reportsToId: people.lee, teamLeadId: people.lee } });
    assetId = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'River Spirit', type: 'character', assigneeId: people.ana } })).body.asset.id;
  });
  t.after(() => stopServer(server));

  await t.test('a day takes several lines, and the totals follow', async () => {
    const lines = [
      { date: MON, hours: 3, clientId, projectId, assetId, notes: 'Rough pass' },
      { date: MON, hours: 2.5, clientId, projectId },
      { date: '2026-03-03', hours: 8, clientId, projectId, assetId },
      { date: '2026-03-04', hours: 7.5, nonProject: 'training', notes: 'Rigging workshop' },
    ];
    for (const line of lines) {
      const made = await add('ana', line);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    }
    const mine = await week('ana');
    assert.strictEqual(mine.totals.perDay[MON], 5.5, 'two lines on one day add up');
    assert.strictEqual(mine.totals.perDay['2026-03-03'], 8);
    assert.strictEqual(mine.totals.week, 21);
    assert.strictEqual(mine.status, 'draft');
    assert.strictEqual(mine.locked, false);

    // The line carries what it was against, resolved, so the grid needs no
    // second lookup to say "Nightgarden".
    const withAsset = mine.entries.find((e) => e.notes === 'Rough pass');
    assert.strictEqual(withAsset.projectName, 'Nightgarden');
    assert.ok(withAsset.assetCode, 'and the asset code');
    assert.strictEqual(mine.entries.find((e) => e.nonProject === 'training').projectName, null);
  });

  await t.test('a week is submitted whole, and locks', async () => {
    const before = await week('ana');
    assert.strictEqual(before.locked, false);

    const sent = await as('ana', '/timesheets/submit', { method: 'POST', body: { weekStart: MON } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.week.status, 'submitted');

    const after = await week('ana');
    assert.strictEqual(after.locked, true);
    // Every way of changing it is shut, not just the button.
    const blocked = await add('ana', { date: MON, hours: 1, clientId, projectId });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    const line = after.entries[0];
    assert.strictEqual((await as('ana', `/timesheets/entries/${line.id}`,
      { method: 'PATCH', body: { hours: 9 } })).status, 409, 'nor edited');
    assert.strictEqual((await as('ana', `/timesheets/entries/${line.id}`,
      { method: 'DELETE' })).status, 409, 'nor deleted');

    // And it is in the approver's queue.
    const queue = (await as('lee', '/timesheets/pending')).body;
    assert.strictEqual(queue.count, 1);
    assert.strictEqual(queue.weeks[0].userName, 'ana');
    assert.strictEqual(queue.weeks[0].hours, 21, 'with the hours, so it can be judged from the queue');
  });

  await t.test('an empty week is not a submission', async () => {
    const nothing = await as('bo', '/timesheets/submit', { method: 'POST', body: { weekStart: MON } });
    assert.strictEqual(nothing.status, 400, JSON.stringify(nothing.body));
    assert.match(nothing.body.error, /nothing on that week/);
    assert.strictEqual((await as('lee', '/timesheets/pending')).body.count, 1,
      'and a queue of empty weeks is a queue nobody reads');
  });

  await t.test('rejecting sends it back with a reason; approving locks it for good', async () => {
    const noReason = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject' } });
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.match(noReason.body.error, /what needs correcting/);

    const sentBack = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject', reason: 'Thursday should be Leave, not Training.' } });
    assert.strictEqual(sentBack.status, 200, JSON.stringify(sentBack.body));

    const returned = await week('ana');
    assert.strictEqual(returned.status, 'rejected');
    assert.strictEqual(returned.locked, false, 'the whole point of sending it back');
    assert.strictEqual(returned.rejectionReason, 'Thursday should be Leave, not Training.');
    assert.strictEqual(returned.decidedBy, 'lee@zvky.test');

    // Corrected and sent again.
    const fix = returned.entries.find((e) => e.nonProject === 'training');
    assert.strictEqual((await as('ana', `/timesheets/entries/${fix.id}`,
      { method: 'PATCH', body: { nonProject: 'leave' } })).status, 200);
    await as('ana', '/timesheets/submit', { method: 'POST', body: { weekStart: MON } });
    const resent = await week('ana');
    assert.strictEqual(resent.status, 'submitted');
    assert.strictEqual(resent.rejectionReason, null, 'and the old reason is cleared, not left to confuse');

    const approved = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'approve' } });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));

    const done = await week('ana');
    assert.strictEqual(done.status, 'approved');
    assert.strictEqual(done.locked, true);
    /* Approved and editable would approve nothing, which is why this is the one
       state a rejection cannot be confused with. */
    assert.strictEqual((await add('ana', { date: MON, hours: 1, clientId, projectId })).status, 409);
    assert.strictEqual((await as('lee', '/timesheets/pending')).body.count, 0, 'and out of the queue');
  });

  await t.test('a decided week cannot be decided again', async () => {
    const again = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject', reason: 'changed my mind' } });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual((await week('ana')).status, 'approved', 'the first decision stands');
  });

  await t.test('nobody approves their own hours', async () => {
    /* The same rule the project review queue had to learn. Lee holds approve
       and can reach their own sheet; that is not a decision. */
    await add('lee', { date: MON, hours: 4, clientId, projectId });
    await as('lee', '/timesheets/submit', { method: 'POST', body: { weekStart: MON } });
    const own = await as('lee', `/timesheets/${people.lee}/${MON}/decision`,
      { method: 'POST', body: { decision: 'approve' } });
    assert.strictEqual(own.status, 403, JSON.stringify(own.body));
    assert.match(own.body.error, /your own timesheet/);
    assert.strictEqual((await week('lee')).status, 'submitted', 'still waiting on somebody else');
  });

  await t.test('everybody sees their own and nobody else\'s', async () => {
    assert.strictEqual((await as('bo', `/timesheets/week?date=${MON}`)).status, 200, 'their own opens');
    const nosey = await as('bo', `/timesheets/week?date=${MON}&userId=${people.ana}`);
    assert.strictEqual(nosey.status, 403, 'a colleague\'s does not');
    assert.deepStrictEqual((await as('bo', '/timesheets/people')).body.users.map((u) => u.name), ['bo']);

    // And there is no path to writing onto somebody else's sheet at all.
    const theirs = (await week('root', people.ana)).entries[0];
    assert.strictEqual((await as('bo', `/timesheets/entries/${theirs.id}`,
      { method: 'PATCH', body: { hours: 1 } })).status, 403);
    assert.strictEqual((await as('bo', `/timesheets/entries/${theirs.id}`, { method: 'DELETE' })).status, 403);
  });

  await t.test('a lead sees their own team, and only their own team', async () => {
    assert.strictEqual((await as('lee', `/timesheets/week?date=${MON}&userId=${people.ana}`)).status, 200,
      'Ana reports to Lee');
    assert.strictEqual((await as('lee', `/timesheets/week?date=${MON}&userId=${people.bo}`)).status, 403,
      'Bo does not');
    const visible = (await as('lee', '/timesheets/people')).body;
    assert.deepStrictEqual(visible.users.map((u) => u.name).sort(), ['ana', 'lee']);
    assert.strictEqual(visible.scope, 'team');

    // Super Admin holds timesheet.all and reaches everybody.
    assert.strictEqual((await as('root', `/timesheets/week?date=${MON}&userId=${people.bo}`)).status, 200);
    assert.strictEqual((await as('root', '/timesheets/people')).body.scope, 'all');
  });

  await t.test('every change is on the record, including a person\'s own', async () => {
    /* Hours are the input to somebody's pay, so the self-edits matter as much
       as the decisions — they are exactly what a dispute turns on. */
    const { events } = (await as('lee', `/timesheets/history?userId=${people.ana}&weekStart=${MON}`)).body;
    const actions = events.map((e) => e.action);
    for (const expected of ['entry_added', 'entry_edited', 'submitted', 'rejected', 'approved']) {
      assert.ok(actions.includes(expected), `${expected} is missing from the trail: ${actions.join(', ')}`);
    }
    const rejection = events.find((e) => e.action === 'rejected');
    assert.strictEqual(rejection.actorEmail, 'lee@zvky.test');
    assert.match(rejection.detail, /Thursday should be Leave/, 'the reason is kept, not just the verdict');
    // And it names what a line was against rather than a row id.
    assert.match(events.find((e) => e.action === 'entry_added').detail, /Nightgarden/);
  });

  await t.test('the exports carry what the screen showed', async () => {
    const xlsx = await fetch(`${server.base}/timesheets/export.xlsx?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
    const book = require('xlsx').read(Buffer.from(await xlsx.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    assert.match(text, /Nightgarden/, 'the project is in the spreadsheet');
    assert.match(text, /Rough pass/, 'and the notes');
    assert.match(text, /approved/, 'and where the week got to');

    const pdf = await fetch(`${server.base}/timesheets/export.pdf?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.strictEqual(bytes.subarray(0, 4).toString(), '%PDF', 'and it really is one');
    assert.ok(bytes.length > 1000);

    // An export reaches exactly as far as the tab does, and no further.
    assert.strictEqual((await fetch(
      `${server.base}/timesheets/export.xlsx?userId=${people.ana}&from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.bo}` } })).status, 403);
  });

  await t.test('the asset pipeline and its measured time are untouched', async () => {
    /* The studio asked for this to be additive: Efficiency and Idle read
       work_sessions, which is the clock the app kept, and nothing here writes
       to it. Checked against the tables rather than asserted in a comment. */
    const sessions = await sql(cfg, 'SELECT COUNT(*) AS n FROM work_sessions');
    assert.strictEqual(Number(sessions[0].n), 0,
      'logging hours must not have written a measured session');

    const asset = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === assetId);
    assert.strictEqual(asset.status, 'assigned', 'and the asset has not moved');

    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%timesheet%'");
    assert.strictEqual(Number(events[0].n), 0, 'a timesheet line is not an asset event');
  });
});
