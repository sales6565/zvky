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

test('the working day is 09:30 to 19:00 IST, and outside it is refused', () => {
  const line = (start, end) => sheets.validateEntry({
    date: '2026-03-02', startTime: start, endTime: end, clientId: 'c', projectId: 'p' });

  assert.strictEqual(line('10:00', '12:00').value.hours, 2, 'an ordinary two hours');
  assert.strictEqual(line('09:30', '19:00').value.hours, 8.5,
    'the whole window, less the lunch hour — which is over the eight-hour day, and flagged rather than refused');

  for (const [s, e] of [['09:00', '11:00'], ['08:00', '09:00'], ['17:00', '20:00'], ['19:00', '19:30']]) {
    const out = line(s, e);
    assert.strictEqual(out.ok, false, `${s}-${e} is outside the working day`);
    assert.match(out.error, /09:30 to 19:00 IST/);
  }
  assert.strictEqual(line('12:00', '11:00').ok, false, 'and end before start is not a stretch of time');
  assert.strictEqual(line('11:00', '11:00').ok, false, 'nor is no time at all');
});

test('lunch is taken out of whatever overlaps it', () => {
  /* Auto-subtracted rather than blocked, as the studio chose: somebody who
     worked 12:30 to 14:30 worked ninety minutes, and making them file that as
     two rows is bookkeeping for the form's benefit. */
  const line = (start, end) => sheets.validateEntry({
    date: '2026-03-02', startTime: start, endTime: end, clientId: 'c', projectId: 'p' });

  const across = line('12:30', '14:30');
  assert.strictEqual(across.value.hours, 1, 'two hours across lunch is one hour worked');
  assert.strictEqual(across.lunchSubtracted, 60, 'and the caller is told, so the screen can say so');

  assert.strictEqual(line('12:00', '13:00').value.hours, 1, 'right up to lunch is untouched');
  assert.strictEqual(line('14:00', '15:00').value.hours, 1, 'and straight after it');
  assert.strictEqual(line('13:30', '15:00').value.hours, 1, 'a late start inside lunch loses the overlap');

  /* Entirely inside lunch subtracts to nothing. Storing a nought-hour line
     would be storing a line saying nobody worked, so it is refused with the
     reason rather than accepted and silently emptied. */
  const inside = line('13:15', '13:45');
  assert.strictEqual(inside.ok, false);
  assert.match(inside.error, /entirely within the lunch break/);
});

test('eight hours is a warning, and under eight is silent', () => {
  /* Soft, as the studio chose. A genuinely long day exists, and a form that
     refuses one teaches somebody to log eight and go home late. */
  assert.deepStrictEqual(sheets.dayTotal([{ hours: 5 }, { hours: 4 }]),
    { hours: 9, lines: 2, overLong: true, maxHours: 8 });
  assert.strictEqual(sheets.dayTotal([{ hours: 8 }]).overLong, false, 'exactly eight is not over');
  // A half day is an ordinary thing and worth no words at all.
  assert.strictEqual(sheets.dayTotal([{ hours: 4 }]).overLong, false);
  assert.strictEqual(sheets.dayTotal([]).overLong, false);
});

test('a weekend is flagged, not blocked', () => {
  assert.strictEqual(sheets.isWeekend('2026-03-07'), true, 'Saturday');
  assert.strictEqual(sheets.isWeekend('2026-03-08'), true, 'Sunday');
  assert.strictEqual(sheets.isWeekend('2026-03-06'), false, 'Friday');
  // And the form takes it: occasional weekend work is real.
  assert.strictEqual(sheets.validateEntry({ date: '2026-03-07', startTime: '10:00',
    endTime: '13:00', clientId: 'c', projectId: 'p' }).ok, true);
});

test('a clock time is minutes past midnight IST, and never an instant', () => {
  /* The decision the whole timezone requirement rests on. Stored as minutes,
     09:30 is 09:30 to a server in UTC and to somebody logging in from
     California, with no conversion anywhere and no daylight saving to get
     wrong. */
  assert.strictEqual(sheets.parseClock('09:30'), 570);
  assert.strictEqual(sheets.parseClock('9:30'), 570, 'a single-digit hour is the same time');
  assert.strictEqual(sheets.clockLabel(570), '09:30');
  assert.strictEqual(sheets.clockLabel(1140), '19:00');
  for (const bad of ['25:00', '10:70', 'noon', '', null, '10']) {
    assert.strictEqual(sheets.parseClock(bad), null, `${bad} is not a clock time`);
  }
  // Round trip, at every quarter of the working day.
  for (let m = sheets.DAY_START; m <= sheets.DAY_END; m += 15) {
    assert.strictEqual(sheets.parseClock(sheets.clockLabel(m)), m);
  }
});

test('two lines cannot claim the same minutes', () => {
  /* The one arithmetic error a timesheet cannot catch by adding up: the total
     looks perfectly reasonable. */
  const at = (startMin, endMin) => ({ startMin, endMin });
  const existing = [at(600, 720), at(840, 900)];   // 10:00-12:00 and 14:00-15:00
  assert.ok(sheets.overlaps(at(660, 780), existing), '11:00-13:00 runs into the first');
  assert.ok(sheets.overlaps(at(570, 900), existing), 'and a line swallowing both');
  assert.strictEqual(sheets.overlaps(at(720, 780), existing), null, '12:00-13:00 butts up against it');
  assert.strictEqual(sheets.overlaps(at(900, 960), existing), null, 'and 15:00-16:00 follows on');
});

test('a line is project work or non-project time, never both and never neither', () => {
  const at = (extra) => ({ date: '2026-03-02', startTime: '10:00', endTime: '12:00', ...extra });

  const ok = sheets.validateEntry(at({ clientId: 'c', projectId: 'p' }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.value.hours, 2, 'and the duration comes from the clock, not from a typed number');

  const category = sheets.validateEntry(at({ nonProject: 'leave' }));
  assert.strictEqual(category.ok, true);
  assert.strictEqual(category.value.clientId, null);

  /* Both is the one that matters: a row carrying a client and "Leave" would be
     counted twice or thrown away depending on which report ran. */
  const both = sheets.validateEntry(at({ clientId: 'c', projectId: 'p', nonProject: 'leave' }));
  assert.strictEqual(both.ok, false);
  assert.match(both.error, /either project work or non-project time/);

  const neither = sheets.validateEntry(at({}));
  assert.strictEqual(neither.ok, false);
  assert.strictEqual(neither.field, 'clientId');

  // A client on its own is half an answer; the project is what the hours hang off.
  const noProject = sheets.validateEntry(at({ clientId: 'c' }));
  assert.strictEqual(noProject.ok, false);
  assert.strictEqual(noProject.field, 'projectId');

  const madeUp = sheets.validateEntry(at({ nonProject: 'sabbatical' }));
  assert.strictEqual(madeUp.ok, false);
  assert.strictEqual(madeUp.field, 'nonProject');
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
  const MON = '2026-03-02';        // a Monday
  const SAT = '2026-03-07';
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
  const dayOf = async (who, date, userId) =>
    (await week(who, userId)).days.find((d) => d.date === date);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ts-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'ts-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');

    clientId = (await as('root', '/clients')).body.clients[0].id;
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

  await t.test('a day takes several lines, and the clock adds up', async () => {
    const lines = [
      { date: MON, startTime: '10:00', endTime: '12:00', clientId, projectId, assetId, notes: 'Rough pass' },
      { date: MON, startTime: '12:00', endTime: '13:00', clientId, projectId },
      { date: '2026-03-03', startTime: '09:30', endTime: '12:30', nonProject: 'training' },
    ];
    for (const line of lines) {
      const made = await add('ana', line);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    }
    const mine = await week('ana');
    const monday = mine.days.find((d) => d.date === MON);
    assert.strictEqual(monday.hours, 3, '10:00-12:00 plus 12:00-13:00');
    assert.strictEqual(monday.overLong, false);
    assert.strictEqual(mine.days.find((d) => d.date === '2026-03-03').hours, 3);
    assert.strictEqual(mine.weekHours, 6);

    // The clock comes back rendered, so the page never turns minutes into a time.
    const first = monday.entries.find((e) => e.notes === 'Rough pass');
    assert.strictEqual(first.startLabel, '10:00');
    assert.strictEqual(first.endLabel, '12:00');
    assert.strictEqual(first.projectName, 'Nightgarden');
    assert.ok(first.assetCode);
    // And the studio's rules travel with the week rather than being repeated.
    assert.deepStrictEqual(mine.workingDay,
      { timezone: 'IST', dayStart: '09:30', dayEnd: '19:00',
        lunchStart: '13:00', lunchEnd: '14:00', maxHours: 8 });
  });

  await t.test('lunch comes off, the window is enforced, and overlaps are refused', async () => {
    const across = await add('ana', { date: MON, startTime: '13:30', endTime: '15:30', clientId, projectId });
    assert.strictEqual(across.status, 201, JSON.stringify(across.body));
    assert.strictEqual(Number(across.body.entry.hours), 1.5, 'the half hour of lunch is taken off');
    assert.strictEqual(across.body.lunchSubtracted, 30, 'and the caller is told');

    const early = await add('ana', { date: MON, startTime: '08:00', endTime: '09:00', clientId, projectId });
    assert.strictEqual(early.status, 400);
    assert.match(early.body.error, /09:30 to 19:00 IST/);

    const late = await add('ana', { date: MON, startTime: '18:30', endTime: '20:00', clientId, projectId });
    assert.strictEqual(late.status, 400);

    // The same hour twice is the error adding up cannot catch.
    const clash = await add('ana', { date: MON, startTime: '11:00', endTime: '11:30', clientId, projectId });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error, /overlaps 10:00–12:00/);
  });

  await t.test('over eight hours is flagged, and a half day is silent', async () => {
    // Monday so far: 10:00-13:00 and 13:30-15:30 = 4.5h. Take it past eight.
    await add('ana', { date: MON, startTime: '15:30', endTime: '19:00', clientId, projectId });
    const monday = await dayOf('ana', MON);
    assert.strictEqual(monday.hours, 8, 'exactly eight');
    assert.strictEqual(monday.overLong, false, 'which is not over');

    await add('ana', { date: MON, startTime: '09:30', endTime: '10:00', clientId, projectId });
    const longer = await dayOf('ana', MON);
    assert.strictEqual(longer.hours, 8.5);
    assert.strictEqual(longer.overLong, true, 'flagged');

    // And it is a flag, not a wall: the day still submits.
    const sent = await as('ana', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.overLong, true, 'with the flag carried into the submission');

    // A half day is an ordinary thing, and says nothing.
    const half = await dayOf('ana', '2026-03-03');
    assert.strictEqual(half.hours, 3);
    assert.strictEqual(half.overLong, false);
  });

  await t.test('weekend work is taken, and marked', async () => {
    const made = await add('ana', { date: SAT, startTime: '10:00', endTime: '13:00', clientId, projectId });
    assert.strictEqual(made.status, 201, 'occasional weekend work is real');
    const saturday = await dayOf('ana', SAT);
    assert.strictEqual(saturday.hours, 3);
    assert.strictEqual(saturday.weekend, true, 'and distinctly flagged');
    assert.strictEqual((await dayOf('ana', MON)).weekend, false);
  });

  await t.test('one DAY is submitted and locks, leaving the rest of the week alone', async () => {
    // Monday was submitted above. Tuesday is untouched by that.
    const monday = await dayOf('ana', MON);
    assert.strictEqual(monday.status, 'submitted');
    assert.strictEqual(monday.locked, true);
    const tuesday = await dayOf('ana', '2026-03-03');
    assert.strictEqual(tuesday.status, 'draft', 'the daily cycle: one day at a time');
    assert.strictEqual(tuesday.locked, false);

    // Every way of changing the locked day is shut, not just the button.
    assert.strictEqual((await add('ana', { date: MON, startTime: '09:30', endTime: '09:45',
      clientId, projectId })).status, 409);
    const line = monday.entries[0];
    assert.strictEqual((await as('ana', `/timesheets/entries/${line.id}`,
      { method: 'PATCH', body: { endTime: '12:30' } })).status, 409, 'nor edited');
    assert.strictEqual((await as('ana', `/timesheets/entries/${line.id}`,
      { method: 'DELETE' })).status, 409, 'nor deleted');
    // But Tuesday still takes work.
    assert.strictEqual((await add('ana', { date: '2026-03-03', startTime: '14:00', endTime: '15:00',
      clientId, projectId })).status, 201);

    const queue = (await as('lee', '/timesheets/pending')).body;
    assert.strictEqual(queue.count, 1, 'one DAY in the queue, not one week');
    assert.strictEqual(queue.days[0].date, MON);
    assert.strictEqual(queue.days[0].userName, 'ana');
    assert.strictEqual(queue.days[0].overLong, true, 'with the flags an approver needs up front');
    assert.strictEqual(queue.days[0].weekend, false);
    assert.strictEqual(queue.maxHours, 8);
  });

  await t.test('an empty day is not a submission', async () => {
    const nothing = await as('bo', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    assert.strictEqual(nothing.status, 400, JSON.stringify(nothing.body));
    assert.match(nothing.body.error, /nothing on that day/);
    assert.strictEqual((await as('lee', '/timesheets/pending')).body.count, 1);
  });

  await t.test('rejecting sends the day back with a reason; approving locks it', async () => {
    const noReason = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject' } });
    assert.strictEqual(noReason.status, 400);
    assert.match(noReason.body.error, /what needs correcting/);

    const back = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject', reason: 'The 09:30 half hour was the standup.' } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));

    const returned = await dayOf('ana', MON);
    assert.strictEqual(returned.status, 'rejected');
    assert.strictEqual(returned.locked, false, 'the whole point of sending it back');
    assert.strictEqual(returned.rejectionReason, 'The 09:30 half hour was the standup.');
    assert.strictEqual(returned.decidedBy, 'lee@zvky.test');

    // Corrected and sent again.
    const standup = returned.entries.find((e) => e.startLabel === '09:30');
    assert.strictEqual((await as('ana', `/timesheets/entries/${standup.id}`,
      { method: 'DELETE' })).status, 200);
    await as('ana', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    const resent = await dayOf('ana', MON);
    assert.strictEqual(resent.status, 'submitted');
    assert.strictEqual(resent.rejectionReason, null, 'and the old reason is cleared, not left to confuse');
    assert.strictEqual(resent.hours, 8, 'back to eight');

    assert.strictEqual((await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'approve' } })).status, 200);
    const done = await dayOf('ana', MON);
    assert.strictEqual(done.status, 'approved');
    assert.strictEqual(done.locked, true);
    assert.strictEqual((await add('ana', { date: MON, startTime: '09:30', endTime: '10:00',
      clientId, projectId })).status, 409, 'approved and editable would approve nothing');
  });

  await t.test('a decided day cannot be decided again', async () => {
    const again = await as('lee', `/timesheets/${people.ana}/${MON}/decision`,
      { method: 'POST', body: { decision: 'reject', reason: 'changed my mind' } });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual((await dayOf('ana', MON)).status, 'approved', 'the first decision stands');
  });

  await t.test('nobody approves their own hours', async () => {
    await add('lee', { date: MON, startTime: '10:00', endTime: '14:00', clientId, projectId });
    await as('lee', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    const own = await as('lee', `/timesheets/${people.lee}/${MON}/decision`,
      { method: 'POST', body: { decision: 'approve' } });
    assert.strictEqual(own.status, 403, JSON.stringify(own.body));
    assert.match(own.body.error, /your own timesheet/);
    assert.strictEqual((await dayOf('lee', MON)).status, 'submitted');
  });

  await t.test('everybody sees their own and nobody else\'s', async () => {
    assert.strictEqual((await as('bo', `/timesheets/week?date=${MON}`)).status, 200);
    assert.strictEqual((await as('bo', `/timesheets/week?date=${MON}&userId=${people.ana}`)).status, 403);
    assert.deepStrictEqual((await as('bo', '/timesheets/people')).body.users.map((u) => u.name), ['bo']);

    const theirs = (await dayOf('root', MON, people.ana)).entries[0];
    assert.strictEqual((await as('bo', `/timesheets/entries/${theirs.id}`,
      { method: 'PATCH', body: { endTime: '11:00' } })).status, 403);
    assert.strictEqual((await as('bo', `/timesheets/entries/${theirs.id}`, { method: 'DELETE' })).status, 403);
  });

  await t.test('a lead sees their own team, and only their own team', async () => {
    assert.strictEqual((await as('lee', `/timesheets/week?date=${MON}&userId=${people.ana}`)).status, 200);
    assert.strictEqual((await as('lee', `/timesheets/week?date=${MON}&userId=${people.bo}`)).status, 403);
    const visible = (await as('lee', '/timesheets/people')).body;
    assert.deepStrictEqual(visible.users.map((u) => u.name).sort(), ['ana', 'lee']);
    assert.strictEqual(visible.scope, 'team');
    assert.strictEqual((await as('root', `/timesheets/week?date=${MON}&userId=${people.bo}`)).status, 200);
    assert.strictEqual((await as('root', '/timesheets/people')).body.scope, 'all');
  });

  await t.test('every change is on the record, including a person\'s own', async () => {
    const { events } = (await as('lee', `/timesheets/history?userId=${people.ana}&date=${MON}`)).body;
    const actions = events.map((e) => e.action);
    for (const expected of ['entry_added', 'entry_removed', 'submitted', 'rejected', 'approved']) {
      assert.ok(actions.includes(expected), `${expected} is missing: ${actions.join(', ')}`);
    }
    const rejection = events.find((e) => e.action === 'rejected');
    assert.strictEqual(rejection.actorEmail, 'lee@zvky.test');
    assert.match(rejection.detail, /standup/, 'the reason is kept, not just the verdict');
    // And a line's own entry names its clock and what it was against.
    assert.match(events.find((e) => e.action === 'entry_added').detail, /10:00–12:00/);
    assert.match(events.find((e) => e.action === 'entry_added').detail, /Nightgarden/);
  });

  await t.test('the exports carry the clock, in IST, whatever the reader\'s zone', async () => {
    const xlsx = await fetch(`${server.base}/timesheets/export.xlsx?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(xlsx.status, 200);
    const book = require('xlsx').read(Buffer.from(await xlsx.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    assert.match(text, /Times shown in,IST/, 'the sheet says which clock it is on');
    assert.match(text, /10:00,12:00/, 'and carries the start and end');
    assert.match(text, /Nightgarden/);
    assert.match(text, /approved/, 'with the day\'s own status, not a week\'s');

    /* A day reads in clock order, not in the order somebody happened to type
       the rows. A timesheet that lists the afternoon before the morning cannot
       be checked against by the person approving it. */
    const byDay = new Map();
    for (const line of text.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2}),(\d{2}:\d{2})/.exec(line);
      if (m) byDay.set(m[1], [...(byDay.get(m[1]) || []), m[2]]);
    }
    const busiest = [...byDay.values()].sort((a, b) => b.length - a.length)[0] || [];
    assert.ok(busiest.length > 1, 'a day with more than one line to order');
    assert.deepStrictEqual(busiest, [...busiest].sort(), 'a day comes out in clock order');

    const pdf = await fetch(`${server.base}/timesheets/export.pdf?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.strictEqual(bytes.subarray(0, 4).toString(), '%PDF');

    assert.strictEqual((await fetch(
      `${server.base}/timesheets/export.xlsx?userId=${people.ana}&from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.bo}` } })).status, 403);
  });

  await t.test('the clock is stored as minutes, not as an instant', async () => {
    /* The thing that makes point 5 true rather than approximately true: there
       is no timezone in the column, so there is nothing to convert and nothing
       to get wrong. 10:00 is 600 for everybody. */
    const rows = await sql(cfg,
      `SELECT start_min, end_min FROM timesheet_entries WHERE user_id = '${people.ana}' AND entry_date = '${MON}' ORDER BY start_min LIMIT 1`);
    assert.strictEqual(Number(rows[0].start_min), 600, '10:00');
    assert.strictEqual(Number(rows[0].end_min), 720, '12:00');
  });

  await t.test('the weekly shape is gone, everywhere', async () => {
    /* The studio asked for the daily cycle to REPLACE the weekly one rather
       than sit beside it. Two cycles would be two answers to "is this
       approved". */
    const tables = await sql(cfg,
      "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_weeks'");
    assert.strictEqual(tables.length, 0, 'timesheet_weeks must not exist');
    const columns = await sql(cfg,
      "SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_entries'");
    assert.ok(!columns.some((c) => c.n === 'week_start'), 'nor week_start on a line');
    assert.ok(columns.some((c) => c.n === 'start_min'), 'and the clock is there instead');
  });

  await t.test('the asset pipeline and its measured time are untouched', async () => {
    const sessions = await sql(cfg, 'SELECT COUNT(*) AS n FROM work_sessions');
    assert.strictEqual(Number(sessions[0].n), 0,
      'logging hours must not have written a measured session');
    const asset = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === assetId);
    assert.strictEqual(asset.status, 'assigned');
    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%timesheet%'");
    assert.strictEqual(Number(events[0].n), 0, 'a timesheet line is not an asset event');
  });
});
