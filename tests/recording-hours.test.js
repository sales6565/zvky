/* Settings → Recording Hours: the studio's clock as named windows.
 *
 * WHAT THIS REPLACED. Working Hours could say one window and three breaks, the
 * same on every working day. It could not say a Saturday half day, a shift
 * across midnight, a blackout that applies on weekdays only, or a fourth
 * break. Each of those was a column on a table and a field on a form.
 *
 * WHAT IS BEING GUARDED HERE is not the form but the consequence: these rows
 * ARE the schedule. src/working-time.js prefers schedule.entries over the four
 * legacy time pairs, and workSchedule.trackingWindow() — which the pause sweep,
 * the automatic resume and every second of Time Spent are measured against —
 * publishes them. So the tests that matter most are the ones at the bottom,
 * where a window is edited through the API and a timer's recorded seconds
 * change to match.
 *
 * THE SEED IS PART OF THE FEATURE. An upgrade that created the table empty
 * would stop every clock in the studio, because an empty enabled set honestly
 * means "records nothing". The first test is therefore that switching to named
 * windows changes nothing at all until somebody edits one.
 */
const test = require('node:test');
const assert = require('node:assert');

const wt = require('../src/working-time');
const rh = require('../src/recording-hours');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('rechours');

// --- the pure span maths, with no server ------------------------------------

test('named windows, as spans of one day', () => {
  const on = (day, entries) => wt.spansFromEntries(day, entries);
  const rec = (start, end, extra = {}) => ({ type: 'recording', start, end, enabled: true, ...extra });
  const off = (start, end, extra = {}) => ({ type: 'non_recording', start, end, enabled: true, ...extra });
  // Day 0 of the epoch was a Thursday, so day 4 is a Monday and day 9 a Saturday.
  const MON = 4;
  const SAT = 9;

  assert.deepStrictEqual(on(MON, [rec(570, 1140), off(780, 840)]), [[570, 780], [840, 1140]],
    'one window with one blackout cut out of it');

  assert.deepStrictEqual(on(MON, [rec(570, 720), rec(700, 1140)]), [[570, 1140]],
    'two overlapping recording windows are ONE stretch, not two');

  assert.deepStrictEqual(on(MON, [rec(570, 1140), off(540, 1200)]), [],
    'a blackout covering the whole window leaves nothing');

  assert.deepStrictEqual(on(SAT, [rec(570, 1140, { daysOfWeek: [1, 2, 3, 4, 5] })]), [],
    'a weekday window does not record on Saturday');
  assert.deepStrictEqual(on(SAT, [rec(600, 840, { daysOfWeek: [6] })]), [[600, 840]],
    'and a Saturday window does');

  assert.deepStrictEqual(on(MON, [rec(570, 1140), off(780, 840, { daysOfWeek: [5] })]), [[570, 1140]],
    'a Friday-only blackout does not bite on Monday');

  assert.strictEqual(wt.workableMinutesPerDay({
    entries: [rec(570, 1140, { daysOfWeek: [1, 2, 3, 4, 5] }), rec(600, 840, { daysOfWeek: [6] })],
  }), 570, 'the longest day of the week, not the shortest');

  assert.deepStrictEqual(on(MON, [rec(570, 1140, { enabled: false })]), [],
    'a window switched off records nothing, without being deleted');
});

test('a window that crosses midnight', () => {
  /* 22:00 to 06:00, Monday to Friday. The days are the days it STARTS on, so
     Saturday morning is recorded (Friday night ran into it) and Monday morning
     is not (Sunday night is not a shift). */
  const night = [{ type: 'recording', start: 22 * 60, end: 6 * 60, spansMidnight: true,
    daysOfWeek: [1, 2, 3, 4, 5], enabled: true }];
  const MON = 4; const SAT = 9; const SUN = 10;

  assert.deepStrictEqual(wt.spansFromEntries(MON, night), [[1320, 1440]],
    'Monday records its own evening but not a morning, because Sunday night is not a shift');
  assert.deepStrictEqual(wt.spansFromEntries(MON + 1, night), [[0, 360], [1320, 1440]],
    'Tuesday records the tail of Monday night and its own evening');
  assert.deepStrictEqual(wt.spansFromEntries(SAT, night), [[0, 360]],
    'Saturday records the tail of Friday night and nothing else');
  assert.deepStrictEqual(wt.spansFromEntries(SUN, night), [], 'Sunday records nothing');

  const ist = (t) => Date.parse(`${t}+05:30`);
  assert.strictEqual(
    wt.workingSecondsBetween(ist('2026-09-21T22:00:00'), ist('2026-09-22T06:00:00'),
      { entries: night }) / 3600,
    8, 'a whole night shift is eight hours');
});

test('validation, before anything is stored', () => {
  const bad = (input) => rh.validate(input).errors.map((e) => e.field);

  assert.deepStrictEqual(bad({ type: 'recording', startTime: '09:30', endTime: '09:30' }), ['endTime'],
    'start and end the same is an empty window');
  assert.match(rh.validate({ type: 'recording', startTime: '22:00', endTime: '06:00' }).errors[0].message,
    /crosses midnight/, 'an end before a start says which box makes it legal');
  assert.ok(rh.validate({ type: 'recording', startTime: '22:00', endTime: '06:00', spansMidnight: true }).ok,
    'and with the box ticked it is accepted');
  assert.deepStrictEqual(bad({ type: 'recording', startTime: '09:00', endTime: '17:00', spansMidnight: true }),
    ['spansMidnight'], 'a window inside one day does not cross midnight');
  assert.deepStrictEqual(bad({ startTime: '09:30', endTime: '18:00' }), ['type'], 'type is required');
  assert.deepStrictEqual(bad({ type: 'recording', endTime: '18:00' }), ['startTime'], 'and so is a start');
  assert.deepStrictEqual(bad({ type: 'recording', startTime: '09:30' }), ['endTime'], 'and an end');
  assert.deepStrictEqual(bad({ type: 'recording', startTime: '25:00', endTime: '18:00' }), ['startTime'],
    'and it has to be a clock time');

  // Both ends wrong at once come back together, which is what lets the screen
  // mark two fields rather than one, then the other.
  assert.deepStrictEqual(bad({ type: 'nonsense', startTime: '', endTime: '' }).sort(),
    ['endTime', 'startTime', 'type'], 'every problem with a row, not the first');

  const ok = rh.validate({ type: 'recording', startTime: '09:30', endTime: '19:00' });
  assert.ok(ok.ok);
  assert.deepStrictEqual(ok.value.daysOfWeek, [1, 2, 3, 4, 5, 6, 7], 'days default to all seven');
  assert.strictEqual(ok.value.label, '', 'and a label is optional');
});

test('overlaps warn, and are not refused', () => {
  const e = (id, type, start, end, label, days) =>
    ({ id, type, start, end, label, daysOfWeek: days || [1, 2, 3, 4, 5], enabled: true, spansMidnight: false });

  const clash = rh.warningsFor([
    e('a', 'recording', 570, 1140, 'Core hours'),
    e('b', 'recording', 1080, 1260, 'Late shift'),
  ]);
  assert.strictEqual(clash.length, 1);
  assert.match(clash[0].message, /Core hours/, 'the conflicting labels are named, so the admin can decide');
  assert.match(clash[0].message, /Late shift/);

  assert.deepStrictEqual(
    rh.warningsFor([e('a', 'recording', 570, 1140, 'Core'), e('b', 'non_recording', 780, 840, 'Lunch')]),
    [], 'a blackout inside a recording window is the point of the second list, not a clash');

  assert.deepStrictEqual(
    rh.warningsFor([e('a', 'recording', 570, 1140, 'Weekdays', [1, 2, 3, 4, 5]),
      e('b', 'recording', 600, 840, 'Saturday', [6])]),
    [], 'and windows on different days do not overlap');

  const silent = rh.warningsFor([e('a', 'non_recording', 0, 1439, 'Everything')]);
  assert.match(silent[0].message, /no time will be tracked/, 'a studio that would record nothing is told so');
});

// --- the endpoints, the permission and the audit trail ----------------------

test('the four endpoints, and who may reach them', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'RecHours-Probe-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const ROOT = '/admin/settings/recording-hours';

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('admin', 'Ana Admin', 'ana@zvky.test', 'admin');
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('artist', 'Ravi Artist', 'ravi@zvky.test', 'game_artist');
    /* THE ONE THAT MATTERS for "not org admins unless explicitly scoped that
       way". The CTO holds manageSettings — every other Settings section is open
       to them, including Working Hours, which this replaces. If the gate were
       written against Settings access rather than against the Super Admin tier
       it would let them straight in, and nothing else in this suite would
       notice. */
    await make('cto', 'Tara CTO', 'cto@zvky.test', 'cto');
  });
  t.after(() => stopServer(server));

  await t.test('the upgrade itself changes nothing', async () => {
    /* The seed, which is the whole reason this can be shipped to a running
       studio. The windows are born holding exactly what Working Hours held, so
       the day is the same day until somebody edits a row. */
    const rows = await sql(cfg,
      'SELECT type, label, start_min, end_min, days_of_week, enabled FROM recording_hour_configs ORDER BY sort_order');
    assert.deepStrictEqual(rows.map((r) => `${r.type} ${r.label} ${r.start_min}-${r.end_min}`), [
      'recording Core hours 570-1140',
      'non_recording Morning break 660-675',
      'non_recording Lunch 780-840',
      'non_recording Evening break 960-975',
    ]);
    assert.strictEqual(String(rows[0].days_of_week), '1,2,3,4,5', 'on the studio\'s working days');

    const sched = (await as('root', '/branding/schedule')).body.schedule;
    assert.strictEqual(sched.dayStartLabel, '09:30');
    assert.strictEqual(sched.dayEndLabel, '19:00');
    assert.strictEqual(sched.breakMinutes, 90, 'the same ninety minutes of break as before');
    assert.deepStrictEqual(sched.workingDays, [1, 2, 3, 4, 5]);
    assert.ok(Array.isArray(sched.entries), 'and the windows are what the timer now reads');
  });

  await t.test('a non-super-admin gets 403 from all four', async () => {
    for (const who of ['cto', 'admin', 'lead', 'artist']) {
      assert.strictEqual((await as(who, ROOT)).status, 403, `GET as ${who}`);
      assert.strictEqual((await as(who, ROOT, {
        method: 'POST', body: { type: 'recording', startTime: '09:00', endTime: '18:00' } })).status, 403,
      `POST as ${who}`);
      assert.strictEqual((await as(who, `${ROOT}/whatever`, {
        method: 'PUT', body: { startTime: '09:00' } })).status, 403, `PUT as ${who}`);
      assert.strictEqual((await as(who, `${ROOT}/whatever`, { method: 'DELETE' })).status, 403,
        `DELETE as ${who}`);
    }
    // And the check is the server's, not the page's: nothing was written.
    const { rows } = { rows: await sql(cfg, 'SELECT COUNT(*) AS n FROM recording_hour_configs') };
    assert.strictEqual(Number(rows[0].n), 4, 'no row reached the table');
  });

  await t.test('an explicit grant opens it, and nothing less does', async () => {
    /* The catalogue entry is implied by managePermissions, which only the Super
       Admin tier holds — so no designation picks this up by holding Settings,
       and a Super Admin CAN hand it to one that should have it. That is the
       spec's "unless explicitly scoped that way", and in this application the
       scoping is per designation: per-user grants were removed deliberately
       (see the user_permissions drop in src/migrate.js), so Settings →
       Permissions is the only way in. */
    const held = await as('root', '/permissions/roles/admin');
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    const current = (held.body.permissions || []).filter((p) => p.held).map((p) => p.key);
    assert.ok(!current.includes('settings.recording_hours'),
      'an admin does not hold it by being an admin');

    const grant = await as('root', '/permissions/roles/admin', {
      method: 'PUT', body: { permissions: [...current, 'settings.recording_hours'] } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    tok.admin = await login('ana@zvky.test');
    assert.strictEqual((await as('admin', ROOT)).status, 200, 'the grant is enough on its own');
    assert.strictEqual((await as('lead', ROOT)).status, 403, 'and it did not leak to anybody else');
    assert.strictEqual((await as('cto', ROOT)).status, 403,
      'not even to a designation that holds every other Settings section');

    const revoke = await as('root', '/permissions/roles/admin', {
      method: 'PUT', body: { permissions: current } });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
    tok.admin = await login('ana@zvky.test');
    assert.strictEqual((await as('admin', ROOT)).status, 403, 'and taking it back closes it again');
  });

  await t.test('add, edit and delete, without limit', async () => {
    const before = (await as('root', ROOT)).body;
    assert.strictEqual(before.recording.length, 1);
    assert.strictEqual(before.nonRecording.length, 3);

    // "the admin should be able to keep clicking + Add indefinitely"
    const made = [];
    for (let i = 0; i < 12; i += 1) {
      const r = await as('root', ROOT, { method: 'POST',
        body: { type: 'non_recording', label: `Blackout ${i}`, startTime: '03:00', endTime: '03:15',
          daysOfWeek: [((i % 7) + 1)] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      made.push(r.body.entry.id);
    }
    const many = (await as('root', ROOT)).body;
    assert.strictEqual(many.nonRecording.length, 15, 'twelve more on top of the three seeded');

    const one = made[0];
    const edited = await as('root', `${ROOT}/${one}`, { method: 'PUT',
      body: { type: 'non_recording', label: 'Renamed', startTime: '04:00', endTime: '04:30',
        daysOfWeek: [2, 3], spansMidnight: false, enabled: false } });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.strictEqual(edited.body.entry.label, 'Renamed');
    assert.strictEqual(edited.body.entry.startLabel, '04:00');
    assert.deepStrictEqual(edited.body.entry.daysOfWeek, [2, 3]);
    assert.strictEqual(edited.body.entry.enabled, false, 'switched off rather than deleted');

    for (const gone of made) {
      assert.strictEqual((await as('root', `${ROOT}/${gone}`, { method: 'DELETE' })).status, 200);
    }
    const after = (await as('root', ROOT)).body;
    assert.strictEqual(after.nonRecording.length, 3, 'back to the three seeded windows');
    assert.strictEqual((await as('root', `${ROOT}/${one}`, { method: 'DELETE' })).status, 404,
      'and deleting one twice says so rather than pretending');
  });

  await t.test('a bad row is refused per field, with the row named', async () => {
    const r = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', startTime: '22:00', endTime: '06:00' } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.errors.length, 1);
    assert.strictEqual(r.body.errors[0].field, 'endTime', 'against the field it belongs to');
    assert.match(r.body.errors[0].message, /crosses midnight/);

    const ok = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Night shift', startTime: '22:00', endTime: '06:00',
        spansMidnight: true, daysOfWeek: [1, 2, 3, 4, 5] } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.entry.spansMidnight, true);
    assert.ok(ok.body.warnings.length >= 0);
    await as('root', `${ROOT}/${ok.body.entry.id}`, { method: 'DELETE' });
  });

  await t.test('a window edited here changes what a timer records', async () => {
    /* THE POINT OF THE WHOLE FEATURE, and the reason it was not built as a
       config table nobody reads. These rows are the schedule: the studio asked
       for them to drive live tracking rather than describe it, so this drives a
       real session through a real window and reads the seconds back off the
       column every report is built on.

       The day is opened wide first — all seven days, midnight to midnight, no
       blackouts — so the only thing deciding the answer is the one blackout
       this test adds in the middle of the session. */
    const wipe = async () => {
      const now = (await as('root', ROOT)).body;
      for (const e of [...now.recording, ...now.nonRecording]) {
        assert.strictEqual((await as('root', `${ROOT}/${e.id}`, { method: 'DELETE' })).status, 200);
      }
    };
    const add = async (type, startTime, endTime, label) => {
      const r = await as('root', ROOT, { method: 'POST',
        body: { type, label, startTime, endTime, daysOfWeek: [1, 2, 3, 4, 5, 6, 7] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.entry.id;
    };
    // Minutes past midnight IST, right now — so the windows below can be
    // expressed against a clock that is actually running.
    const nowMin = () => {
      const d = new Date(Date.now() + 330 * 60 * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };
    const clock = (m) => {
      const x = ((m % 1440) + 1440) % 1440;
      return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    };

    await wipe();
    await add('recording', '00:00', '23:59', 'Around the clock');

    const project = await (async () => {
      const clients = await as('root', '/clients');
      const r = await as('root', '/projects', { method: 'POST',
        body: { name: 'Window Test', clientId: clients.body.clients[0].id } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.project.id;
    })();
    const asset = await as('root', `/assets/project/${project}`, { method: 'POST',
      body: { name: 'Clocked', type: 'prop', assigneeId: id.artist } });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    const assetId = asset.body.asset.id;

    assert.strictEqual((await as('artist', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    // Ninety minutes of work, wound into the past rather than waited for.
    await sql(cfg, `UPDATE work_sessions SET started_at = started_at - INTERVAL 90 MINUTE
                     WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

    /* A blackout over the middle half hour of that ninety minutes. Added AFTER
       the session started, which is the case that matters: the schedule is
       consulted when the seconds are worked out, not when the timer began. */
    const N = nowMin();
    await add('non_recording', clock(N - 60), clock(N - 30), 'Studio blackout');

    assert.strictEqual((await as('artist', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);

    const [row] = await sql(cfg,
      `SELECT seconds FROM work_sessions WHERE asset_id = '${assetId}' ORDER BY started_at DESC LIMIT 1`);
    assert.ok(Math.abs(Number(row.seconds) - 60 * 60) < 120,
      `ninety minutes less a thirty-minute blackout is an hour; got ${Math.round(row.seconds / 60)} minutes`);

    // And the figure the studio reads is the same number.
    const board = await as('root', `/assets/project/${project}`);
    const shown = board.body.assets.find((a) => a.id === assetId);
    assert.ok(Math.abs(shown.time_spent_seconds - 60 * 60) < 120,
      `and the Assets List agrees; got ${Math.round(shown.time_spent_seconds / 60)} minutes`);

    /* Switching every recording window off stops the clock, which is honoured
       rather than second-guessed — and warned about, loudly, on the way. */
    /* Open the LEGACY row all the way first — every day, midnight to midnight —
       while the windows are still a shape the old endpoint can write through.
       That makes the next assertion sharp instead of accidental: after the
       windows are deleted, anything that fell back to the stored pairs would
       record the whole two hours, at any hour of any day this suite happens to
       run. Nothing may. */
    assert.strictEqual((await as('root', '/branding/schedule', { method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: 0, dayEnd: 24 * 60,
        lunchStart: '', lunchEnd: '', morningStart: '', morningEnd: '',
        eveningStart: '', eveningEnd: '' } })).status, 200);

    await wipe();
    const silent = await as('root', ROOT);
    assert.match(silent.body.warnings[0].message, /no time will be tracked/);
    assert.deepStrictEqual((await as('root', '/branding/schedule')).body.schedule.workingDays, [],
      'and the Working Hours summary says the studio records on no day at all');

    /* AND THE CLOCK ACTUALLY STOPS, which is a different claim from the summary
       saying it has. An empty window list that quietly fell back to the old
       day_start/day_end pair would print "no day" on this screen and go on
       recording nine to seven underneath it — the summary and the clock
       disagreeing, which is the whole failure mode named at the top of this
       file. So the seconds are read off a real session, not off the label. */
    const second = await as('root', `/assets/project/${project}`, { method: 'POST',
      body: { name: 'Clocked twice', type: 'prop', assigneeId: id.artist } });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const quietId = second.body.asset.id;
    assert.strictEqual((await as('artist', `/assets/${quietId}/start`, { method: 'POST' })).status, 200);
    await sql(cfg, `UPDATE work_sessions SET started_at = started_at - INTERVAL 120 MINUTE
                     WHERE asset_id = '${quietId}' AND ended_at IS NULL`);
    assert.strictEqual((await as('artist', `/assets/${quietId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);
    const [quiet] = await sql(cfg,
      `SELECT seconds FROM work_sessions WHERE asset_id = '${quietId}' ORDER BY started_at DESC LIMIT 1`);
    assert.strictEqual(Number(quiet.seconds), 0,
      'two hours of wall clock, and none of it recorded, because no window was open');
  });

  await t.test('the old Working Hours endpoint writes through, until it cannot', async () => {
    /* PUT /api/branding/schedule is what everything used before this section
       existed — the old screen, the test suite, anything a studio wired up
       itself. It keeps working, and keeps ONE source of truth, by writing
       through to these windows rather than to a second table nothing reads.
       
       It stops the moment the windows say something it cannot: a second
       recording window, a night shift, a blackout on some days only. Accepting
       it then would throw all of that away without a word, which is worse than
       ignoring it. */
    const wipe = async () => {
      const now = (await as('root', ROOT)).body;
      for (const e of [...now.recording, ...now.nonRecording]) {
        await as('root', `${ROOT}/${e.id}`, { method: 'DELETE' });
      }
    };
    await wipe();
    const core = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Core hours', startTime: '09:30', endTime: '19:00',
        daysOfWeek: [1, 2, 3, 4, 5] } });
    assert.strictEqual(core.status, 201, JSON.stringify(core.body));

    // Simple shape: the old endpoint still speaks for the schedule.
    const moved = await as('root', '/branding/schedule', { method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
        dayStart: '10:00', dayEnd: '19:00',
        lunchStart: '13:00', lunchEnd: '14:00',
        morningStart: '', morningEnd: '', eveningStart: '', eveningEnd: '' } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    const after = (await as('root', ROOT)).body;
    assert.strictEqual(after.recording.length, 1);
    assert.strictEqual(after.recording[0].startLabel, '10:00',
      'the old endpoint moved the window it can describe');
    assert.deepStrictEqual(after.nonRecording.map((e) => e.startLabel), ['13:00'],
      'and replaced the blackouts with the one it was given');

    /* Now make it something the old form cannot say. A night shift is not
       expressible as dayStart/dayEnd at all. */
    const night = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Night shift', startTime: '22:00', endTime: '06:00',
        spansMidnight: true, daysOfWeek: [1, 2, 3, 4, 5] } });
    assert.strictEqual(night.status, 201, JSON.stringify(night.body));

    const refused = await as('root', '/branding/schedule', { method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
        dayStart: '08:00', dayEnd: '17:00',
        lunchStart: '', lunchEnd: '', morningStart: '', morningEnd: '',
        eveningStart: '', eveningEnd: '' } });
    assert.strictEqual(refused.status, 200, 'the call still succeeds — hoursPerDay is legitimate');

    const kept = (await as('root', ROOT)).body;
    assert.strictEqual(kept.recording.length, 2, 'both windows are still there');
    assert.ok(kept.recording.some((e) => e.label === 'Night shift'),
      'the night shift was not thrown away by a form that cannot express it');
    assert.ok(kept.recording.some((e) => e.startLabel === '10:00'),
      'and neither was the window it would have overwritten');

    /* And a studio whose ONLY window crosses midnight is the same refusal for a
       different reason — there is one window, so the count says nothing, and it
       is the shape of that window that the old form cannot hold. */
    await wipe();
    const only = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Nights only', startTime: '21:00', endTime: '05:00',
        spansMidnight: true, daysOfWeek: [1, 2, 3, 4, 5] } });
    assert.strictEqual(only.status, 201, JSON.stringify(only.body));
    assert.strictEqual((await as('root', '/branding/schedule', { method: 'PUT',
      body: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '18:00',
        lunchStart: '', lunchEnd: '', morningStart: '', morningEnd: '',
        eveningStart: '', eveningEnd: '' } })).status, 200);
    const still = (await as('root', ROOT)).body;
    assert.strictEqual(still.recording.length, 1);
    assert.strictEqual(still.recording[0].label, 'Nights only',
      'the one window is still the night shift, not a nine-to-six written over it');
    assert.strictEqual(still.recording[0].spansMidnight, true);

    await wipe();
    await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Core hours', startTime: '09:30', endTime: '19:00',
        daysOfWeek: [1, 2, 3, 4, 5] } });
  });

  await t.test('every mutation is written to the audit trail', async () => {
    const since = async () => (await as('root', '/activity?limit=50')).body;
    const mine = (body) => (body.entries || [])
      .filter((e) => String(e.action || '').startsWith('settings.recording_hours'));

    const created = await as('root', ROOT, { method: 'POST',
      body: { type: 'recording', label: 'Audited', startTime: '07:00', endTime: '08:00' } });
    assert.strictEqual(created.status, 201);
    const entryId = created.body.entry.id;

    await as('root', `${ROOT}/${entryId}`, { method: 'PUT',
      body: { type: 'recording', label: 'Audited', startTime: '07:00', endTime: '09:00' } });
    await as('root', `${ROOT}/${entryId}`, { method: 'DELETE' });

    const log = mine(await since());
    const actions = log.map((e) => e.action);
    for (const want of ['settings.recording_hours.create', 'settings.recording_hours.update',
      'settings.recording_hours.delete']) {
      assert.ok(actions.includes(want), `${want} is in the log; got ${actions.join(', ')}`);
    }

    const updated = log.find((e) => e.action === 'settings.recording_hours.update');
    assert.match(updated.summary, /07:00–08:00/, 'the old window is in the entry');
    assert.match(updated.summary, /07:00–09:00/, 'and the new one');
    assert.strictEqual(updated.actor.email, 'root@zvky.test', 'and who did it');
    /* The before/after map the Activity Log renders as two columns — the thing
       that makes a change to the studio's clock answerable months later. */
    assert.ok(updated.changes && updated.changes.window, 'with the old value beside the new one');
    assert.match(updated.changes.window.from, /07:00–08:00/);
    assert.match(updated.changes.window.to, /07:00–09:00/);

    const removed = log.find((e) => e.action === 'settings.recording_hours.delete');
    assert.match(removed.summary, /Removed a Recording Hours window/);
    assert.strictEqual(removed.changes.window.to, null, 'a delete has an empty side, and says so');
  });
});
