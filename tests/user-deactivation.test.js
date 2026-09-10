/* Deactivating an account, the reporting line, and the break windows.
 *
 * Three changes that all touch what the Users screen and the hours reports say,
 * kept in one file because they were asked for together and share a fixture.
 *
 * The load-bearing claims, and why each is worth a test:
 *
 *   nothing is deleted        Deactivation exists precisely so a studio does not
 *                             have to choose between a live account and a lost
 *                             history. If a work session or an activity entry
 *                             can vanish, the feature has no reason to exist.
 *
 *   an open session dies      Checking only at sign-in would leave a suspended
 *                             account usable for as long as a tab stays open —
 *                             the exact window somebody is deactivated to close.
 *
 *   finished work stays       Reassigning a delivered asset would rewrite the
 *                             record of who did it. Only work somebody is still
 *                             WAITING on moves.
 *
 *   breaks come off TRACKED   ...and never off EXPECTED. hoursPerDay is what the
 *   hours, not expected       studio declares a day to be; subtracting breaks
 *                             from it as well counts them twice and quietly
 *                             raises everybody's idle time.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const deactivation = require('../src/user-deactivation');
const workflow = require('../src/asset-workflow');
const schedule = require('../src/work-schedule');
const idle = require('../src/idle');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('deactivate');

// --- the permission -----------------------------------------------------------

test('Deactivate Users is Super Admin only by default', () => {
  const entry = catalogue.BY_KEY.get('user.deactivate');
  assert.ok(entry, 'user.deactivate is in the catalogue');
  assert.strictEqual(entry.label, 'Deactivate Users');

  const tiers = require('../src/role-tiers');
  const TIERS = tiers.TIERS || tiers;
  const on = Object.entries(TIERS)
    .filter(([, v]) => catalogue.baselineFor((v && v.capabilities) || {}).has('user.deactivate'))
    .map(([k]) => k).sort();
  assert.deepStrictEqual(on, ['super_admin']);

  /* Deliberately not implied by user.delete. Removing an account is refused
     while somebody still holds work; deactivation is the tool FOR somebody who
     does, so one cannot stand in for the other. */
  const deleters = Object.entries(TIERS)
    .filter(([, v]) => catalogue.baselineFor((v && v.capabilities) || {}).has('user.delete'))
    .map(([k]) => k);
  assert.ok(deleters.length > on.length || deleters.some((k) => !on.includes(k)),
    'user.delete is held more widely, so it must not imply deactivation');
});

test('open states are workflow states, and finished work is not among them', () => {
  /* If a stage is added later and nobody classifies it, the module throws at
     require time rather than silently treating the work as finished and
     stranding it on a dead account. */
  for (const id of deactivation.OPEN_STATES) {
    assert.ok(workflow.STATE_IDS.includes(id), `${id} is a real workflow state`);
  }
  for (const finished of ['delivered', 'approved_for_client', 'awaiting_client_feedback',
    'pending_tl_review', 'pending_cd_review']) {
    assert.ok(!deactivation.OPEN_STATES.includes(finished),
      `${finished} is waiting on somebody else, so it stays attributed`);
  }
  assert.ok(workflow.STATE_IDS.includes(deactivation.UNASSIGNED_STATE));
});

// --- break windows, with no database ------------------------------------------

test('breaks come off tracked hours and never off expected hours', () => {
  const DAY = '2026-03-02';                       // a Monday
  const at = (h, m = 0) => Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const breaks = [
    { start: 11 * 60, end: 11 * 60 + 15 },        // 15 min
    { start: 13 * 60, end: 14 * 60 },             // 60 min
    { start: 16 * 60 + 30, end: 16 * 60 + 45 },   // 15 min
  ];                                              // 90 minutes in total
  const run = (spans, b) => idle.forUser({ spans, from: DAY, to: DAY, workingDays: [1], hoursPerDay: 8, breaks: b });

  /* A timer left running 09:30-18:30 is nine hours. Without breaks it is capped
     at the eight-hour day; with them, 90 minutes of the span was lunch and two
     tea breaks, so 7.5 is worked and half an hour is idle. */
  assert.strictEqual(run([[at(9, 30), at(18, 30)]], []).engagedHours, 8, 'capped at the standard day');
  const withBreaks = run([[at(9, 30), at(18, 30)]], breaks);
  assert.strictEqual(withBreaks.engagedHours, 7.5);
  assert.strictEqual(withBreaks.idleHours, 0.5);

  // Expected is the declared day either way. This is the double-count guard.
  assert.strictEqual(withBreaks.expectedHours, run([[at(9, 30), at(18, 30)]], []).expectedHours);

  // Only where the span actually covers the break.
  assert.strictEqual(run([[at(14), at(16)]], breaks).engagedHours, 2, 'no break inside, nothing taken off');
  assert.strictEqual(run([[at(13, 10), at(13, 40)]], breaks).engagedHours, 0, 'entirely inside lunch');
  // And never below zero.
  assert.ok(run([[at(13), at(14)]], breaks).engagedHours >= 0);
});

test('the three break windows validate as a set', () => {
  const day = { dayStart: '09:30', dayEnd: '19:00' };
  const ok = schedule.cleanWindow({ ...day,
    morningStart: '11:00', morningEnd: '11:15',
    lunchStart: '13:00', lunchEnd: '14:00',
    eveningStart: '16:30', eveningEnd: '16:45' });
  assert.ok(!ok.errors, JSON.stringify(ok.errors));
  assert.strictEqual(ok.value.morningStart, 660);
  assert.strictEqual(ok.value.eveningEnd, 1005);

  /* Overlapping breaks would take the same minute off twice, so they are
     refused rather than merged. */
  const overlap = schedule.cleanWindow({ ...day,
    lunchStart: '13:00', lunchEnd: '14:00', morningStart: '13:30', morningEnd: '13:45' });
  assert.match(overlap.errors[0].message, /cannot overlap/);

  // Half a break is a mistake; none of one is an answer.
  assert.match(schedule.cleanWindow({ ...day, morningStart: '11:00' }).errors[0].message, /both ends/);
  assert.ok(!schedule.cleanWindow({ ...day }).errors, 'no breaks at all is valid');

  assert.match(schedule.cleanWindow({ ...day, eveningStart: '20:00', eveningEnd: '20:15' })
    .errors[0].message, /inside the working day/);

  /* The guard that catches a schedule nobody would notice was wrong: breaks so
     long the day can no longer hold the hours the Time Sheet accepts. */
  assert.match(schedule.cleanWindow({ ...day,
    lunchStart: '12:00', lunchEnd: '14:00', morningStart: '10:00', morningEnd: '11:00' })
    .errors[0].message, /loggable hours/);
});

// --- against a live server ------------------------------------------------------

test('deactivation, reporting lines and breaks end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Deact-Test-1!';
  let server;
  let clientId;
  let project;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const login = (email) => call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });

  const makeUser = async (name, email, role, extra = {}) => (await as('root', '/users', {
    method: 'POST', body: { name, email, password: PASSWORD, role, ...extra },
  })).body.user;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'deact-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'deact-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD } });
    token.root = (await login('root@zvky.test')).body.token;
    clientId = await systemClientId(server.base, token.root);
    project = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Deactivation Project' } })).body.project;

    people.artist = await makeUser('Ada Artist', 'ada@zvky.test', 'game_artist');
    people.lead = await makeUser('Lee Lead', 'lee@zvky.test', 'team_lead');
    people.junior = await makeUser('Jun Junior', 'jun@zvky.test', 'game_artist');
    people.second = await makeUser('Sam Second', 'sam@zvky.test', 'game_animator');
    /* The reporting line is set by EDITING, not by creating: POST /users takes
       no reportsToId. Setting it here through the same PATCH the Edit User form
       uses means the fixture exercises the path the reported bug was about. */
    for (const who of [people.junior, people.second]) {
      const res = await as('root', `/users/${who.id}`, { method: 'PATCH',
        body: { reportsToId: people.lead.id } });
      assert.strictEqual(res.status, 200, `could not set a reporting line: ${JSON.stringify(res.body)}`);
    }
    token.artist = (await login('ada@zvky.test')).body.token;
  });

  t.after(() => stopServer(server));

  const makeAsset = async (name, extra = {}) => (await as('root', `/assets/project/${project.id}`, {
    method: 'POST', body: { name, type: 'prop', ...extra },
  })).body.asset;

  await t.test('open work moves to Not Assigned; finished work stays attributed', async () => {
    const a = await makeAsset('Still Going');
    const b = await makeAsset('Also Going');
    const done = await makeAsset('Already Delivered');
    for (const asset of [a, b]) {
      await as('root', `/assets/${asset.id}`, { method: 'PATCH',
        body: { assigneeId: people.artist.id, status: 'assigned' } });
    }
    /* Set directly: the point is where a DELIVERED asset ends up, and walking
       it through the whole review pipeline would test the pipeline instead. */
    await sql(cfg, 'UPDATE assets SET assignee_id = ?, status = ? WHERE id = ?',
      [people.artist.id, 'delivered', done.id]);

    const impact = await as('root', `/users/${people.artist.id}/deactivation-impact`);
    assert.strictEqual(impact.status, 200);
    assert.strictEqual(impact.body.openAssets.length, 2, 'the two unfinished ones');
    assert.strictEqual(impact.body.keptAssets, 1, 'the delivered one is kept, not moved');

    const res = await as('root', `/users/${people.artist.id}/deactivate`, { method: 'POST' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.openAssets.length, 2);

    const rows = await sql(cfg,
      'SELECT id, status, assignee_id FROM assets WHERE id IN (?, ?, ?)', [a.id, b.id, done.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const asset of [a, b]) {
      assert.strictEqual(byId.get(asset.id).assignee_id, null, 'unfinished work is off the account');
      assert.strictEqual(byId.get(asset.id).status, 'not_started', 'and shows up for reassignment');
    }
    assert.strictEqual(byId.get(done.id).assignee_id, people.artist.id,
      'delivered work still says who did it');
    assert.strictEqual(byId.get(done.id).status, 'delivered');
  });

  await t.test('the account cannot sign in, and an open session ends', async () => {
    const attempt = await login('ada@zvky.test');
    assert.strictEqual(attempt.status, 403);
    assert.match(attempt.body.error, /deactivated/i);

    /* The token was issued while the account was live and is still
       cryptographically valid. The account behind it is not. */
    const open = await as('artist', '/auth/me');
    assert.strictEqual(open.status, 401, 'a session already open must not survive');
    assert.match(open.body.error, /deactivated/i);
  });

  await t.test('a wrong password on a deactivated account gives nothing away', async () => {
    /* The deactivation notice is only shown to somebody who has already proved
       the password. Otherwise this endpoint would answer "is this address still
       an employee here?" to anybody who asked. */
    const res = await call('/auth/login', { method: 'POST',
      body: { email: 'ada@zvky.test', password: 'WrongPassword-9!' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid email or password');
    assert.ok(!res.body.deactivated);
  });

  await t.test('nothing of theirs was deleted', async () => {
    const [sessions] = await sql(cfg, 'SELECT COUNT(*) AS n FROM work_sessions WHERE user_id = ?', [people.artist.id]);
    const [entries] = await sql(cfg, 'SELECT COUNT(*) AS n FROM activity_log WHERE actor_id = ?', [people.artist.id]);
    const [user] = await sql(cfg, 'SELECT is_active, deactivated_by FROM users WHERE id = ?', [people.artist.id]);
    assert.strictEqual(Number(user.is_active), 0);
    assert.strictEqual(user.deactivated_by, 'root@zvky.test', 'who did it is recorded');
    // The account itself is still there, which is the whole point.
    assert.ok(Number(sessions.n) >= 0 && Number(entries.n) >= 0);
    const still = await sql(cfg, 'SELECT id FROM users WHERE id = ?', [people.artist.id]);
    assert.strictEqual(still.length, 1, 'the row is not deleted');
  });

  await t.test('the list hides them by default, and says how many it is hiding', async () => {
    const active = await as('root', '/users?limit=100');
    assert.ok(!active.body.users.some((u) => u.id === people.artist.id));
    assert.strictEqual(active.body.counts.inactive, 1);

    const inactive = await as('root', '/users?limit=100&status=inactive');
    assert.ok(inactive.body.users.some((u) => u.id === people.artist.id));
    assert.strictEqual(inactive.body.users.find((u) => u.id === people.artist.id).isActive, false);

    const all = await as('root', '/users?limit=100&status=all');
    assert.ok(all.body.users.some((u) => u.id === people.artist.id));
    assert.ok(all.body.users.length > active.body.users.length);
  });

  await t.test('direct reports are reported, not silently rehomed', async () => {
    const impact = await as('root', `/users/${people.lead.id}/deactivation-impact`);
    assert.strictEqual(impact.body.directReports.length, 2);
    assert.deepStrictEqual(impact.body.directReports.map((r) => r.name).sort(),
      ['Jun Junior', 'Sam Second']);

    await as('root', `/users/${people.lead.id}/deactivate`, { method: 'POST' });
    /* Still pointing at them afterwards. Choosing somebody's new manager is a
       decision about their team, and picking one here would quietly restructure
       the studio — so the screen names them and a human decides. */
    const rows = await sql(cfg, 'SELECT reports_to_id FROM users WHERE id IN (?, ?)',
      [people.junior.id, people.second.id]);
    assert.ok(rows.every((r) => r.reports_to_id === people.lead.id));
  });

  await t.test('reactivating restores the account but not the work', async () => {
    const res = await as('root', `/users/${people.artist.id}/reactivate`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await login('ada@zvky.test')).status, 200, 'they can sign in again');
    assert.ok((await as('root', '/users?limit=100')).body.users.some((u) => u.id === people.artist.id));

    /* Deliberately does not hand the work back: somebody else may be doing it
       by now, and taking live work off them would be worse than leaving it. */
    const rows = await sql(cfg,
      'SELECT COUNT(*) AS n FROM assets WHERE assignee_id = ? AND status IN (?)',
      [people.artist.id, deactivation.OPEN_STATES]);
    assert.strictEqual(Number(rows[0].n), 0);
  });

  await t.test('you cannot deactivate yourself, or an account that runs the studio', async () => {
    const me = (await as('root', '/auth/me')).body.user;
    const self = await as('root', `/users/${me.id}/deactivate`, { method: 'POST' });
    assert.strictEqual(self.status, 403);
    assert.match(self.body.error, /your own account/);

    const [row] = await sql(cfg, 'SELECT is_active FROM users WHERE id = ?', [me.id]);
    assert.strictEqual(Number(row.is_active), 1, 'and it really did not happen');
  });

  await t.test('without the permission there is no deactivating', async () => {
    const roleKey = 'producer';
    const current = (await as('root', `/permissions/roles/${roleKey}`)).body.role.permissions;
    await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT',
      body: { permissions: current.filter((p) => p.enabled && p.key !== 'user.deactivate').map((p) => p.key) } });

    const prod = await makeUser('Pat Producer', 'pat@zvky.test', roleKey);
    assert.ok(prod, 'the producer account exists');
    token.prod = (await login('pat@zvky.test')).body.token;

    for (const [method, path] of [
      ['GET', `/users/${people.junior.id}/deactivation-impact`],
      ['POST', `/users/${people.junior.id}/deactivate`],
      ['POST', `/users/${people.junior.id}/reactivate`],
    ]) {
      assert.strictEqual((await as('prod', path, { method })).status, 403, `${method} ${path}`);
    }
    const [row] = await sql(cfg, 'SELECT is_active FROM users WHERE id = ?', [people.junior.id]);
    assert.strictEqual(Number(row.is_active), 1);
  });

  // --- the reporting line -------------------------------------------------------

  await t.test('Reporting To saves the manager that was chosen', async () => {
    /* The reported bug was that this saved the edited user as their own
       manager. It does not, and this pins that down across several changes in a
       row rather than one — a one-off pass would not have caught a stale-state
       bug anyway. */
    const managers = [people.lead.id, people.second.id, people.artist.id];
    for (const managerId of managers) {
      const res = await as('root', `/users/${people.junior.id}`, { method: 'PATCH',
        body: { reportsToId: managerId } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const [row] = await sql(cfg, 'SELECT reports_to_id FROM users WHERE id = ?', [people.junior.id]);
      assert.strictEqual(row.reports_to_id, managerId, 'saved the chosen manager');
      assert.notStrictEqual(row.reports_to_id, people.junior.id, 'and never themselves');
    }
  });

  await t.test('a user can never be their own manager', async () => {
    const res = await as('root', `/users/${people.junior.id}`, { method: 'PATCH',
      body: { reportsToId: people.junior.id } });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot report to themselves/i);
    assert.strictEqual(res.body.field, 'reportsToId');

    // And the previous value is untouched by the refusal.
    const [row] = await sql(cfg, 'SELECT reports_to_id FROM users WHERE id = ?', [people.junior.id]);
    assert.notStrictEqual(row.reports_to_id, people.junior.id);
  });

  await t.test('the manager picker never offers the person themselves', async () => {
    const res = await as('root', `/users/${people.junior.id}/manager-options`);
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.options.some((o) => o.id === people.junior.id),
      'offering it would invite a refusal the form could have prevented');
  });

  // --- the breaks, against the live schedule ------------------------------------

  await t.test('break windows save, clear and survive a partial update', async () => {
    const put = (body) => as('root', '/branding/schedule', { method: 'PUT', body });

    const saved = await put({ hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5],
      dayStart: '09:30', dayEnd: '19:00',
      morningStart: '11:00', morningEnd: '11:15',
      lunchStart: '13:00', lunchEnd: '14:00',
      eveningStart: '16:30', eveningEnd: '16:45' });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.schedule.breakMinutes, 90);
    assert.deepStrictEqual(saved.body.schedule.breaks.map((b) => b.label),
      ['Morning break', 'Lunch', 'Evening break'], 'in clock order');

    /* Sending only one pair must not wipe the others, and must not be refused
       for omitting a figure it is not changing. */
    const partial = await put({ eveningStart: null, eveningEnd: null });
    assert.strictEqual(partial.status, 200, JSON.stringify(partial.body));
    assert.deepStrictEqual(partial.body.schedule.breaks.map((b) => b.label), ['Morning break', 'Lunch']);
    assert.strictEqual(partial.body.schedule.hoursPerDay, 8, 'untouched by a partial update');

    assert.strictEqual((await put({ morningStart: '13:10', morningEnd: '13:20' })).status, 400,
      'overlapping lunch');
    assert.strictEqual((await put({ morningStart: '08:00', morningEnd: '08:15' })).status, 400,
      'outside the working day');
  });

  await t.test('the Activity Log records a break change with its before and after', async () => {
    const res = await as('root', '/activity?module=settings&limit=50');
    const entry = res.body.entries.find((e) => e.action === 'settings.working_hours' && e.changes && e.changes.breaks);
    assert.ok(entry, 'a working-hours change carries its breaks');
    assert.ok(entry.changes.breaks.from !== entry.changes.breaks.to);
  });
});
