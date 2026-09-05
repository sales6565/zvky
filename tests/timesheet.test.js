const test = require('node:test');
const assert = require('node:assert');
const sheets = require('../src/timesheets');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, pdfText, SKIP_REASON } = require('./helpers');

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

test('a line is a number of hours', () => {
  const line = (hours) => sheets.validateEntry({ date: '2026-03-02', hours, clientId: 'c', projectId: 'p' });

  assert.strictEqual(line('3.5').value.hours, 3.5, 'a string from a form');
  assert.strictEqual(line(3).value.hours, 3, 'and a number from a script');
  assert.strictEqual(line(' 7.25 ').value.hours, 7.25, 'trimmed');

  // Nothing typed is not nought hours, it is nothing — and says so.
  for (const empty of ['', '   ', null, undefined]) {
    const verdict = line(empty);
    assert.strictEqual(verdict.ok, false, `${JSON.stringify(empty)} is not an amount`);
    assert.strictEqual(verdict.field, 'hours');
    assert.match(verdict.error, /how many hours/i);
  }
  assert.strictEqual(line('half a day').ok, false, 'and neither is a word');

  // A line of nothing is a line saying nobody worked.
  assert.strictEqual(line(0).ok, false);
  assert.match(line(0).error, /more than nought/i);
  assert.strictEqual(line(-2).ok, false, 'and negative hours are not a correction');
  assert.strictEqual(line(0.1).ok, false, 'below the quarter-hour grain');
  assert.strictEqual(line(0.25).ok, true, 'which a quarter of an hour meets');
  assert.strictEqual(line(25).ok, false, 'and no single line is longer than a day');
  assert.strictEqual(line(24).ok, true);
});

test('the clock rules went with the clock, and nothing pretends otherwise', () => {
  /* Three rules were removed with the Start/End fields, and this pins their
     absence rather than leaving it to be rediscovered as a bug:

       the 09:30-19:00 window   there is no time to be outside it
       the lunch subtraction    there is no span to overlap it
       the overlap check        two hours figures cannot be compared

     The third is a real loss and is written down as one — it caught the single
     arithmetic error a timesheet cannot catch by adding up. */
  const line = (extra) => sheets.validateEntry(
    { date: '2026-03-02', hours: 3, clientId: 'c', projectId: 'p', ...extra });

  // Anything the old form would have refused for being outside the day is now
  // simply not a question the line can be asked.
  assert.strictEqual(line({ startTime: '06:00', endTime: '09:00' }).ok, true,
    'clock fields are ignored, not honoured and not refused');
  const value = line({}).value;
  assert.strictEqual(value.startMin, null, 'and nothing is invented to store');
  assert.strictEqual(value.endMin, null);

  // The functions that implemented the removed rules are gone from the module,
  // so nothing can quietly start calling them again.
  assert.strictEqual(sheets.workedMinutes, undefined, 'the lunch subtraction is gone');
  assert.strictEqual(sheets.overlaps, undefined, 'and so is the overlap check');
  // These two survive: rows filed before the change still hold a span, and the
  // week view still prints one.
  assert.strictEqual(typeof sheets.clockLabel, 'function');
  assert.strictEqual(typeof sheets.parseClock, 'function');
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
  assert.strictEqual(sheets.validateEntry({ date: '2026-03-07', hours: 3,
    clientId: 'c', projectId: 'p' }).ok, true);
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

test('a line is project work or non-project time, never both and never neither', () => {
  const at = (extra) => ({ date: '2026-03-02', hours: 3, ...extra });

  const ok = sheets.validateEntry(at({ clientId: 'c', projectId: 'p' }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.value.hours, 3, 'and the duration is the number that was typed');

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
    assert.ok(!held.has('timesheet.all'), `${artist.label} should not read the studio's by default`);
  }

  // Super Admin holds the whole catalogue, these four included, without anybody
  // toggling anything.
  const superAdmin = rolePermissions.defaultsFor('super_admin');
  /* Three, not four. timesheet.approve went with the step it gated — see the
     note where it used to sit in src/permission-catalog.js. */
  assert.ok(!catalog.KEYS.includes('timesheet.approve'),
    'a permission that gates nothing must not be grantable');
  for (const key of ['timesheet.own', 'timesheet.team', 'timesheet.all']) {
    assert.ok(catalog.KEYS.includes(key), `${key} must be in the catalogue`);
    assert.ok(superAdmin.has(key), `Super Admin must hold ${key}`);
  }

  // Team Lead gets team + approve, which is the studio's "lead and above".
  const lead = rolePermissions.defaultsFor('team_lead');
  assert.ok(lead.has('timesheet.team'), 'a lead reads their team\'s hours');
  assert.ok(!lead.has('timesheet.approve'), 'and has nothing to approve');
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

    /* hop holds a designation that has settings.working_hours by default and
       is not Super Admin, so the permission can actually be switched off for
       it — which is the only way to prove the endpoint reads that key and
       not the branding one beside it. */
    for (const [who, role] of [['lee', 'team_lead'], ['ana', 'game_artist'],
      ['bo', 'game_artist'], ['hop', 'head_of_production']]) {
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

  await t.test('a day takes several lines, and the hours add up', async () => {
    const lines = [
      { date: MON, hours: 2, clientId, projectId, assetId, notes: 'Rough pass' },
      { date: MON, hours: 1, clientId, projectId },
      { date: '2026-03-03', hours: 3, nonProject: 'training' },
    ];
    for (const line of lines) {
      const made = await add('ana', line);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    }
    const mine = await week('ana');
    const monday = mine.days.find((d) => d.date === MON);
    assert.strictEqual(monday.hours, 3, '2 plus 1');
    assert.strictEqual(monday.overLong, false);
    assert.strictEqual(mine.days.find((d) => d.date === '2026-03-03').hours, 3);
    assert.strictEqual(mine.weekHours, 6);

    const first = monday.entries.find((e) => e.notes === 'Rough pass');
    assert.strictEqual(Number(first.hours), 2);
    assert.strictEqual(first.projectName, 'Nightgarden');
    assert.ok(first.assetCode);
    /* No clock labels on a line filed as hours. Empty rather than "00:00",
       which is what rendering a null minute would print and which reads as
       midnight rather than as absent. */
    assert.strictEqual(first.startLabel, '');
    assert.strictEqual(first.endLabel, '');

    /* One rule travels with the week now, where four used to. The window and
       the lunch hour went with the clock fields, so a payload still carrying
       them would mean a form still drawing them. */
    assert.deepStrictEqual(mine.workingDay, { timezone: 'IST', maxHours: 8 });
  });

  await t.test('a line filed before the change keeps its clock', async () => {
    /* The reason start_min and end_min were relaxed rather than dropped. Hours
       are paid from this table, and the span is the record of what somebody
       claimed — a schema tidy-up that deletes it is destroying evidence. */
    const before = await add('ana', { date: '2026-03-04', hours: 2, clientId, projectId });
    await sql(cfg, 'UPDATE timesheet_entries SET start_min = 600, end_min = 720 WHERE id = ?',
      [before.body.entry.id]);

    const day = await dayOf('ana', '2026-03-04');
    const old = day.entries.find((e) => e.id === before.body.entry.id);
    assert.strictEqual(old.startLabel, '10:00', 'the older row still reads as it was written');
    assert.strictEqual(old.endLabel, '12:00');
    assert.strictEqual(Number(old.hours), 2, 'and its hours are unchanged');

    // New rows leave the columns empty rather than inventing a span.
    const fresh = await sql(cfg, 'SELECT start_min, end_min FROM timesheet_entries WHERE id = ?',
      [(await add('ana', { date: '2026-03-04', hours: 1, clientId, projectId })).body.entry.id]);
    assert.strictEqual(fresh[0].start_min, null);
    assert.strictEqual(fresh[0].end_min, null);
  });

  await t.test('nothing checks a clock any more', async () => {
    /* Every rule that needed two times, gone — asserted through the endpoint,
       because a rule can survive in a route after it has left the module.
       
       The overlap is the one that stings: two lines claiming the same three
       hours are now both accepted, and nothing in the application can tell.
       Written down as a fact of the design rather than left to be found. */
    const early = await add('ana', { date: '2026-03-05', hours: 3, clientId, projectId, notes: 'Before nine' });
    assert.strictEqual(early.status, 201, 'work outside the old 09:30-19:00 window is taken');

    const twice = await add('ana', { date: '2026-03-05', hours: 3, clientId, projectId, notes: 'Same hours again' });
    assert.strictEqual(twice.status, 201, 'and so is a second line that would once have overlapped');
    assert.strictEqual((await dayOf('ana', '2026-03-05')).hours, 6,
      'both count, which is the whole cost of losing the clock');

    // Clock fields sent by an old client are ignored, not honoured.
    const stale = await add('ana', {
      date: '2026-03-05', hours: 1, clientId, projectId, startTime: '03:00', endTime: '04:00' });
    assert.strictEqual(stale.status, 201);
    const row = await sql(cfg, 'SELECT start_min FROM timesheet_entries WHERE id = ?',
      [stale.body.entry.id]);
    assert.strictEqual(row[0].start_min, null, 'and leave nothing behind');
  });

  await t.test('the hours are suggested from that day\'s own recorded work', async () => {
    /* The pre-fill, and the reason it can be offered per DAY at all: a session
       is a stretch with its own start and end, so a round spanning Monday to
       Wednesday still has a Monday stretch whose hours are exactly known. */
    const day = '2026-03-09';
    const other = '2026-03-10';
    const mk = async (startedAt, endedAt, seconds, userId = people.ana) => sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, ?, ?, ?, 'submitted')`,
      [assetId, userId, startedAt, endedAt, seconds]);

    // Two stretches on one day — a hold in the middle — and one the day after.
    await mk(`${day} 10:00:00`, `${day} 12:00:00`, 7200);
    await mk(`${day} 14:00:00`, `${day} 15:30:00`, 5400);
    await mk(`${other} 09:00:00`, `${other} 10:00:00`, 3600);

    const suggested = await as('ana', `/timesheets/suggest?assetId=${assetId}&date=${day}`);
    assert.strictEqual(suggested.status, 200, JSON.stringify(suggested.body));
    assert.strictEqual(suggested.body.hours, 3.5, 'both of that day\'s stretches, and only that day\'s');
    assert.strictEqual(suggested.body.sessions, 2);
    assert.strictEqual(suggested.body.spanning, 0);

    // The next day answers for itself.
    assert.strictEqual((await as('ana', `/timesheets/suggest?assetId=${assetId}&date=${other}`)).body.hours, 1);

    /* A stretch running past midnight cannot be split, so it is left out and
       counted — the screen says so rather than offering a smaller number with
       no explanation. */
    /* Straddling IST midnight, which is what the rule is about — the stamps are
       instants and the day is the studio's, so these are chosen to land either
       side of 00:00 IST rather than either side of 00:00 on the server. */
    const across = '2026-03-11';
    await mk(`${across} 17:00:00`, `${across} 20:00:00`, 10800);  // 22:30 to 01:30 IST
    const crossed = await as('ana', `/timesheets/suggest?assetId=${assetId}&date=${across}`);
    assert.strictEqual(crossed.body.hours, null, 'nothing is invented for it');
    assert.strictEqual(crossed.body.spanning, 1, 'and the caller is told why');

    // Somebody else's hours on the same asset are not yours to file.
    await mk(`${day} 16:00:00`, `${day} 18:00:00`, 7200, people.bo);
    assert.strictEqual((await as('ana', `/timesheets/suggest?assetId=${assetId}&date=${day}`)).body.hours, 3.5,
      'still only Ana\'s own stretches');
    assert.strictEqual((await as('bo', `/timesheets/suggest?assetId=${assetId}&date=${day}`)).body.hours, 2);

    // An asset with nothing recorded offers nothing, which is not an error.
    const idle = (await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'Untouched', type: 'prop' } })).body.asset.id;
    assert.strictEqual((await as('ana', `/timesheets/suggest?assetId=${idle}&date=${day}`)).body.hours, null);

    /* And it is a SUGGESTION. Nothing refuses a different number, which is what
       keeps this a manual timesheet with a helpful default rather than an
       automatic one somebody has to argue with. */
    const typed = await add('ana', { date: day, hours: 6, clientId, projectId, assetId });
    assert.strictEqual(typed.status, 201, 'six hours against three and a half recorded');
    assert.strictEqual(Number(typed.body.entry.hours), 6);
  });

  await t.test('over eight hours is flagged, and a half day is silent', async () => {
    /* Inside the week the suite reads, or the day would not be in it to check
       — and one no other subtest writes to, so nine is nine. */
    const day = '2026-03-08';
    assert.strictEqual((await dayOf('ana', day)).hours, 0, 'starting from an empty day');
    await add('ana', { date: day, hours: 5, clientId, projectId });
    const long = await add('ana', { date: day, hours: 4, clientId, projectId });
    assert.strictEqual(long.status, 201, 'nine hours is allowed');
    assert.strictEqual(long.body.overLong, true, 'and flagged');

    const shown = await dayOf('ana', day);
    assert.strictEqual(shown.hours, 9);
    assert.strictEqual(shown.overLong, true, 'the day says so without any clock times');

    const easy = '2026-03-04';
    assert.strictEqual((await dayOf('ana', easy)).overLong, false, 'a shorter day says nothing');
  });

  await t.test('weekend work is taken, and marked', async () => {
    const made = await add('ana', { date: SAT, hours: 2, clientId, projectId });
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await dayOf('ana', SAT)).weekend, true);
  });

  await t.test('one DAY is submitted and locks, leaving the rest of the week alone', async () => {
    const sent = await as('ana', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.day.status, 'submitted');
    assert.strictEqual(sent.body.day.locked, true);

    const blocked = await add('ana', { date: MON, hours: 1, clientId, projectId });
    assert.strictEqual(blocked.status, 409, 'a submitted day takes no more lines');

    const tuesday = await add('ana', { date: '2026-03-03', hours: 1, nonProject: 'admin' });
    assert.strictEqual(tuesday.status, 201, 'and the rest of the week carries on');

    assert.strictEqual((await as('ana', '/timesheets/submit', { method: 'POST',
      body: { date: MON } })).status, 409, 'submitting twice is refused');
  });

  await t.test('a submitted day is reopened by the person whose day it is', async () => {
    /* What replaced approval. Submitting still locks — the studio kept that —
       but with nobody to ask for it back, a locked day would be locked for
       ever and a mistyped figure would be permanent. */
    const reopened = await as('ana', '/timesheets/reopen', { method: 'POST', body: { date: MON } });
    assert.strictEqual(reopened.status, 200, JSON.stringify(reopened.body));
    assert.strictEqual(reopened.body.day.status, 'draft');
    assert.strictEqual(reopened.body.day.locked, false);

    const fixed = await add('ana', { date: MON, hours: 1, clientId, projectId, notes: 'The correction' });
    assert.strictEqual(fixed.status, 201, 'and it takes lines again');

    // Nobody else can reopen it, because it is not their day.
    await as('ana', '/timesheets/submit', { method: 'POST', body: { date: MON } });
    const byLead = await as('lee', '/timesheets/reopen', { method: 'POST', body: { date: MON } });
    assert.notStrictEqual(byLead.status, 200, 'a lead reopens their own days, not Ana\'s');
    assert.strictEqual((await dayOf('ana', MON)).status, 'submitted');

    // A day that is not locked has nothing to reopen.
    assert.strictEqual((await as('ana', '/timesheets/reopen', { method: 'POST',
      body: { date: '2026-03-03' } })).status, 409);
    await as('ana', '/timesheets/reopen', { method: 'POST', body: { date: MON } });
  });

  await t.test('there is nothing left to approve, anywhere', async () => {
    /* Removed, not hidden. A route that still answers is a route somebody can
       still call — the buttons being gone from the page would prove nothing. */
    await as('ana', '/timesheets/submit', { method: 'POST', body: { date: SAT } });
    for (const [who, path, body] of [
      ['lee', `/timesheets/${people.ana}/${SAT}/decision`, { decision: 'approve' }],
      ['root', `/timesheets/${people.ana}/${SAT}/decision`, { decision: 'reject', reason: 'no' }],
    ]) {
      const gone = await as(who, path, { method: 'POST', body });
      assert.strictEqual(gone.status, 404, `${path} should not exist — got ${gone.status}`);
    }
    /* The queue is a GET, and an unmatched GET falls through to the single-page
       app rather than 404ing — so what is asserted is that no queue comes back,
       which is the thing that matters, plus that the route is not in the source
       at all. Asserting a status here would have been asserting Express's
       fallback, not this feature. */
    const queue = await as('lee', '/timesheets/pending');
    assert.ok(!queue.body || queue.body.days === undefined,
      `no queue should come back — got ${JSON.stringify(queue.body).slice(0, 80)}`);
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'routes', 'timesheets.js'), 'utf8');
    for (const gone of ["'/pending'", "'/:userId/:date/decision'"]) {
      assert.ok(!source.includes(gone), `${gone} is still declared in the route file`);
    }

    // The day stays exactly as its owner left it.
    assert.strictEqual((await dayOf('lee', SAT, people.ana)).status, 'submitted');
  });

  await t.test('an empty day is not a submission', async () => {
    const nothing = await as('ana', '/timesheets/submit', { method: 'POST', body: { date: '2026-03-06' } });
    assert.strictEqual(nothing.status, 400);
    assert.match(nothing.body.error, /nothing on that day/i);
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
    // A line added and taken away again, so the record has both to show.
    const spare = await add('ana', { date: MON, hours: 1, clientId, projectId, notes: 'Mistake' });
    assert.strictEqual(spare.status, 201, JSON.stringify(spare.body));
    await as('ana', `/timesheets/entries/${spare.body.entry.id}`, { method: 'DELETE' });

    const { events } = (await as('lee', `/timesheets/history?userId=${people.ana}&date=${MON}`)).body;
    const actions = events.map((e) => e.action);
    /* The four that exist now. `rejected` and `approved` are gone with the step
       that wrote them; `reopened` is what took their place, and it is here
       because a day taken back and refiled has to say so. */
    for (const expected of ['entry_added', 'entry_removed', 'submitted', 'reopened']) {
      assert.ok(actions.includes(expected), `${expected} is missing: ${actions.join(', ')}`);
    }
    assert.ok(!actions.includes('approved') && !actions.includes('rejected'),
      'and nothing approves or rejects any more');

    const reopen = events.find((e) => e.action === 'reopened');
    assert.strictEqual(reopen.actorEmail, 'ana@zvky.test', 'a day is reopened by its own owner');

    // A line's own entry names its hours and what they were against.
    const added = events.find((e) => e.action === 'entry_added');
    assert.match(added.detail, /\dh/, 'the hours are in the record');
    assert.match(added.detail, /Nightgarden/);
    assert.match(events.find((e) => e.action === 'entry_removed').detail, /\dh removed/);
  });

  await t.test('the exports carry the hours, and no longer a clock', async () => {
    const xlsx = await fetch(`${server.base}/timesheets/export.xlsx?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(xlsx.status, 200);
    const book = require('xlsx').read(Buffer.from(await xlsx.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    assert.match(text, /Times shown in,IST/, 'the sheet still says which studio clock the days are on');
    assert.match(text, /Nightgarden/);
    assert.match(text, /submitted/, 'with the day\'s own status');

    /* The two clock columns are gone, header and all. Kept as a check on the
       HEADER rather than on the absence of "10:00" anywhere, because a note or
       a project name could contain a time and the point is the shape of the
       sheet. */
    const header = text.split('\n').find((l) => l.startsWith('Date,'));
    assert.ok(header, `there is a header row — got ${text.split('\n').slice(0, 6).join(' | ')}`);
    assert.deepStrictEqual(header.trim().split(','),
      ['Date', 'Client', 'Project', 'Asset', 'Category', 'Hours', 'Notes', 'Status'],
      'and it is the hours-based shape, with no Start and no End');

    // The hours themselves are on the rows.
    const dataRows = text.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l));
    assert.ok(dataRows.length > 1, 'there is more than one line to read');
    assert.ok(dataRows.some((l) => /,\d+(\.\d+)?,/.test(l)), 'each carries a number of hours');

    /* The PDF has to carry the same lines, not merely be a PDF.
     *
     * This assertion used to stop at the "%PDF" magic bytes, and that is
     * exactly how the export shipped empty: the route handed report-pdf an
     * array of positional arrays where it reads each cell by header name, so
     * every row drew blank. The bytes were a valid PDF the whole time. What
     * follows compares the document's text against the spreadsheet's. */
    const pdf = await fetch(`${server.base}/timesheets/export.pdf?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.strictEqual(bytes.subarray(0, 4).toString(), '%PDF');

    const printed = pdfText(bytes).text;
    assert.match(printed, /Time sheet/, 'and says what it is, not "Work efficiency"');
    assert.match(printed, /Hours/, 'the Hours column is on the page');
    assert.ok(!/\bStart\b/.test(printed), 'and the Start column is not');
    assert.match(printed, /Nightgarden/, 'and the project');
    assert.match(printed, /submitted/, 'and the day\'s status');
    // Every value in the spreadsheet's data rows appears in the document too.
    for (const line of text.split('\n')) {
      if (!/^\d{4}-\d{2}-\d{2},/.test(line)) continue;
      for (const cell of line.split(',')) {
        const value = cell.trim();
        if (!value) continue;
        assert.ok(printed.includes(value),
          `the PDF is missing ${JSON.stringify(value)}, which the spreadsheet has`);
      }
    }

    // A range with nothing in it says so, rather than looking like a failure.
    const quiet = await fetch(`${server.base}/timesheets/export.pdf?from=2019-01-07&to=2019-01-13`,
      { headers: { Authorization: `Bearer ${token.ana}` } });
    assert.strictEqual(quiet.status, 200);
    assert.match(pdfText(Buffer.from(await quiet.arrayBuffer())).text, /No time was logged in this range/);

    assert.strictEqual((await fetch(
      `${server.base}/timesheets/export.xlsx?userId=${people.ana}&from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${token.bo}` } })).status, 403);
  });

  await t.test('an hours figure is stored as hours, with no clock beside it', async () => {
    /* What replaced "the clock is stored as minutes". A line is one number now,
       and the two columns that held its span stay empty rather than holding a
       span nobody typed. */
    const rows = await sql(cfg,
      'SELECT start_min, end_min, hours FROM timesheet_entries WHERE user_id = ? AND entry_date = ?',
      [people.ana, MON]);
    assert.ok(rows.length, 'there are lines on that day');
    for (const row of rows) {
      assert.strictEqual(row.start_min, null, 'nothing invents a start');
      assert.strictEqual(row.end_min, null);
      assert.ok(Number(row.hours) > 0, 'and the hours are what was typed');
    }
  });

  await t.test('the soft cap is its own number, not the standard day', async () => {
    /* Found while rewriting this suite, and worth pinning rather than
       assuming: the eight hours a Time Sheet flags at is NOT the hours-per-day
       in Settings. hoursPerDay is what a full day is EXPECTED to be and is what
       the Idle report divides by; the cap is the point past which a day is
       worth a second look. A studio could expect eight and only want flagging
       above ten, which is why they were never merged.
       
       The old version of this subtest proved a settings change moved what the
       form ACCEPTED. Nothing is refused now, so what is proved instead is that
       the two numbers stay independent — and that the stored clock window
       survives a save from a form that no longer carries it. */
    const WED = '2026-03-04';
    const before = (await week('ana')).workingDay.maxHours;
    assert.strictEqual(before, 8);

    const short = await as('root', '/branding/schedule', {
      method: 'PUT', body: { hoursPerDay: 4, workingDays: [1, 2, 3, 4, 5] } });
    assert.strictEqual(short.status, 200, JSON.stringify(short.body));
    assert.strictEqual(short.body.schedule.hoursPerDay, 4, 'the expected day moved');
    assert.strictEqual((await week('ana')).workingDay.maxHours, 8,
      'and the flag did not follow it');
    assert.strictEqual((await dayOf('ana', WED)).overLong, false,
      'so a day under eight is still unremarkable');

    /* The clock half of the setting is left alone by a request that does not
       mention it. The four inputs have gone from the form, and the stored
       window has to survive that rather than being blanked by every save —
       a studio that goes back to clock times should get its own back. */
    const stored = await sql(cfg, 'SELECT day_start_min, lunch_start_min FROM work_schedule LIMIT 1');
    assert.strictEqual(Number(stored[0].day_start_min), 570, '09:30 is still on the row');
    assert.strictEqual(Number(stored[0].lunch_start_min), 780);

    // Put it back for the rest of the suite.
    assert.strictEqual((await as('root', '/branding/schedule', {
      method: 'PUT', body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] } })).status, 200);
  });

  await t.test('changing the studio\'s hours is its own permission', async () => {
    /* Not branding's. Whoever can change the logo should not automatically be
       able to change what every account may record — and the artist whose hours
       these are certainly should not. */
    const asArtist = await as('ana', '/branding/schedule', {
      method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] },
    });
    assert.strictEqual(asArtist.status, 403, JSON.stringify(asArtist.body));

    // Reading it is open to anyone signed in: the form has to draw the window
    // it will be judged against.
    assert.strictEqual((await as('ana', '/branding/schedule')).status, 200);

    /* And the gate is settings.working_hours specifically, not the branding
       permission that used to sit beside it. The two are held by exactly the
       same designations by default, so the only way to tell them apart is to
       switch one off and watch the answer change. */
    const permsOf = async (role) => (await as('root', `/permissions/roles/${role}`))
      .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    const setPerms = async (role, keys) => {
      const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: keys } });
      assert.ok(r.status < 400, JSON.stringify(r.body));
    };
    const held = await permsOf('head_of_production');
    assert.ok(held.includes('settings.working_hours') && held.includes('settings.branding'),
      'the fixture role starts with both');

    const move = (who) => as(who, '/branding/schedule', {
      method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
        dayStart: '09:00', dayEnd: '19:00', lunchStart: '13:00', lunchEnd: '14:00' },
    });
    assert.strictEqual((await move('hop')).status, 200, 'with the permission, it works');

    try {
      await setPerms('head_of_production', held.filter((k) => k !== 'settings.working_hours'));
      const denied = await move('hop');
      assert.strictEqual(denied.status, 403,
        'without it, it does not — even though the role still has settings.branding');
    } finally {
      await setPerms('head_of_production', held);
    }
    assert.strictEqual((await move('hop')).status, 200, 'and switching it back restores it');

    // And a window that cannot hold a day's work is refused even from an
    // account that may set it.
    const silly = await as('root', '/branding/schedule', {
      method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
        dayStart: '09:30', dayEnd: '15:00', lunchStart: '13:00', lunchEnd: '14:00' },
    });
    assert.strictEqual(silly.status, 400, JSON.stringify(silly.body));
    assert.match(silly.body.error, /loggable hours/);
    /* Read from the stored row, not from the Time Sheet's window: the form no
       longer carries the clock and the week payload no longer reports it, so
       the only place left that can say whether anything was written is the
       table. The endpoint still validates the window because a studio can set
       it through the API, and a refusal that half-applies would be worse than
       no validation at all. */
    const untouched = await sql(cfg, 'SELECT day_end_min FROM work_schedule LIMIT 1');
    assert.strictEqual(Number(untouched[0].day_end_min), 1140, 'and nothing was written');
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
    /* Filing hours must not write a measured session. Counted against what the
       suggestion test put there deliberately, rather than against nought —
       nought stopped being the right answer when this suite started seeding
       sessions to have something to suggest from. */
    const seeded = await sql(cfg, "SELECT COUNT(*) AS n FROM work_sessions WHERE ended_reason = 'submitted'");
    const all = await sql(cfg, 'SELECT COUNT(*) AS n FROM work_sessions');
    assert.strictEqual(Number(all[0].n), Number(seeded[0].n),
      'logging hours must not have written a measured session of its own');
    const asset = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.id === assetId);
    assert.strictEqual(asset.status, 'assigned');
    const events = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action LIKE '%timesheet%'");
    assert.strictEqual(Number(events[0].n), 0, 'a timesheet line is not an asset event');
  });
});
