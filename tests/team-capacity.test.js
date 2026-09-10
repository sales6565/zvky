/* Team Capacity: available, consumed and idle hours across the studio.
 *
 * EVERY HOUR IS CHECKED AGAINST ARITHMETIC DONE BY HAND. The fixture below
 * writes work_sessions rows at named times on named days and the assertions
 * quote the hours those add up to, worked out in the comments. A capacity panel
 * tested by asking it what it thinks is a panel that agrees with itself.
 *
 * Two of those hand-checks are the whole reason this feature could go wrong:
 *
 *   OVERLAP      One person holding two assets open across the same afternoon
 *                has spent one afternoon, not two. Summing wall-clock spans —
 *                the obvious implementation — credits them twice, and under
 *                this app's timing model that is not an edge case, it is what
 *                a busy week looks like.
 *
 *   WEEKENDS     A span left open Friday evening to Monday morning is 64 hours
 *                of wall clock and almost none of them working hours. It must
 *                contribute only the working time it actually covers.
 *
 * Both are already solved in src/idle.js, and this feature reuses the Idle
 * Report's own builder rather than reimplementing them — so these assertions
 * are checking that the reuse is wired up, which is exactly what could break.
 */
const test = require('node:test');
const assert = require('node:assert');
const { v4: uuid } = require('uuid');
const capacity = require('../src/team-capacity');
const idle = require('../src/idle');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('capacity');

// --- the ranges, without a database ------------------------------------------

test('every period runs to today, never past it', () => {
  /* PERIOD-TO-DATE is the decision this asserts. "Available hours this year"
     for a year three-quarters elapsed blends capacity already spent with
     capacity not yet reached — it reads as enormous idleness every January and
     none at all every December. */
  const on = '2026-09-08';
  assert.deepStrictEqual(capacity.rangeFor('day', on), { from: '2026-09-08', to: '2026-09-08' });
  assert.deepStrictEqual(capacity.rangeFor('month', on), { from: '2026-09-01', to: '2026-09-08' });
  assert.deepStrictEqual(capacity.rangeFor('year', on), { from: '2026-01-01', to: '2026-09-08' });

  // The first of January, where all three collapse onto one day.
  for (const id of ['day', 'month', 'year']) {
    assert.deepStrictEqual(capacity.rangeFor(id, '2026-01-01'),
      { from: '2026-01-01', to: '2026-01-01' }, `${id} on new year's day`);
  }

  // The start of each period is the Idle Report's own, not a second definition.
  assert.strictEqual(capacity.rangeFor('month', on).from, idle.periodRange('month', on).from);
  assert.strictEqual(capacity.rangeFor('year', on).from, idle.periodRange('year', on).from);
});

test('the three periods are the ones asked for, in order', () => {
  assert.deepStrictEqual(capacity.PERIODS.map((p) => p.id), ['day', 'month', 'year']);
  assert.deepStrictEqual(capacity.PERIODS.map((p) => p.label), ['Daily', 'Monthly', 'Annually']);
});

// --- against a live server ----------------------------------------------------

test('team capacity', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Capacity-Test-1!';
  let server;
  let clientId;
  let projectId;
  const token = {};
  const people = {};
  const asset = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  /* THE FIXTURE'S WEEK. Everything below is placed against a fixed Monday so
     the arithmetic in the comments is stable — a fixture anchored on "today"
     would land on a weekend one run in three and the expected hours would move
     underneath the assertions. */
  const MONDAY = '2026-03-02';      // a Monday
  const TUESDAY = '2026-03-03';
  const FRIDAY = '2026-03-06';
  const NEXT_MONDAY = '2026-03-09';

  const session = (userId, assetId, from, to) => sql(cfg,
    'INSERT INTO work_sessions (id, asset_id, user_id, `round`, started_at, ended_at) VALUES (?,?,?,1,?,?)',
    [uuid(), assetId, userId, from, to]);

  /* The capacity figures for an explicit range, straight from the endpoint the
     panel reads. Asked through the API rather than the module so the permission
     and the wiring are exercised too. */
  const capacityFor = async (who) => (await as(who, '/admin-dashboard')).body.capacity;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'cap-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'cap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Capacity' } })).body.project.id;

    /* Two artists — game_artist is an `assignable` designation, which is the
       capability the Idle Report selects on. Root is NOT assignable and must
       not appear in the headcount, which is asserted below. */
    const person = async (name, email, role) => (await as('root', '/users', { method: 'POST', body: {
      name, email, role, password: PASSWORD, projectId,
    } })).body.user.id;
    people.ana = await person('Ana Roy', 'ana@zvky.test', 'game_artist');
    people.bo = await person('Bo Sen', 'bo@zvky.test', 'game_artist');

    const makeAsset = async (name) => (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'prop' },
    })).body.asset;
    asset.one = await makeAsset('Asset One');
    asset.two = await makeAsset('Asset Two');
    asset.three = await makeAsset('Asset Three');
  });

  t.after(() => stopServer(server));

  await t.test('two assets open across one afternoon count once, not twice', async () => {
    /* THE OVERLAP CHECK.
     *
     * Ana holds Asset One from 13:00 to 17:00 and Asset Two from 14:00 to 18:00
     * on the same Monday. Wall clock across the two spans is 4 + 4 = 8 hours.
     * The union is 13:00 to 18:00 — five hours — because at no point was she in
     * two places. That is what this test is here to prove, and 8 would mean it
     * had stopped being true.
     *
     * From that five, the studio's configured lunch break (13:00-14:00, the
     * default) comes off: an hour with a timer running through lunch is not an
     * hour worked. So FOUR is the answer.
     *
     * Bo does nothing at all, so his 8 available hours are 8 idle.
     *
     *   available  2 people x 1 working day x 8h = 16.0
     *   consumed   Ana (5.0 union - 1.0 lunch) + Bo 0 = 4.0
     *   idle       16.0 - 4.0 = 12.0
     */
    await sql(cfg, 'DELETE FROM work_sessions');
    await session(people.ana, asset.one.id, `${MONDAY} 13:00:00`, `${MONDAY} 17:00:00`);
    await session(people.ana, asset.two.id, `${MONDAY} 14:00:00`, `${MONDAY} 18:00:00`);

    const report = (await as('root', `/idle/report?from=${MONDAY}&to=${MONDAY}`)).body;
    assert.strictEqual(report.totals.people, 2, 'the two artists, and not Root');
    assert.strictEqual(report.totals.expectedHours, 16, '2 people x 1 day x 8h');
    assert.strictEqual(report.totals.engagedHours, 4,
      'the UNION of 13-17 and 14-18 (5h), less the 13:00-14:00 lunch — never their 8h sum');
    assert.strictEqual(report.totals.idleHours, 12);

    const ana = report.rows.find((r) => r.email === 'ana@zvky.test');
    assert.strictEqual(ana.engagedHours, 4, 'and per person too');
  });

  await t.test('a span across a weekend contributes only its working hours', async () => {
    /* THE WEEKEND CHECK.
     *
     * Bo starts on Friday at 16:00 and hands in on the following Monday at
     * 10:00. That is 66 hours of wall clock. Of it:
     *
     *   Friday    16:00-24:00 = 8h, capped at the 8h standard day  -> 8.0
     *   Sat, Sun  not working days                                 -> 0
     *   Monday    00:00-10:00 = 10h, capped at 8                   -> 8.0
     *
     * so 16 hours across the two working days it touches, not 66.
     *
     * Measured over Friday alone to keep the arithmetic to one day:
     *   available  2 people x 1 day x 8h = 16.0
     *   consumed   Bo 8.0 (capped) + Ana 0 = 8.0
     *   idle       8.0
     */
    await sql(cfg, 'DELETE FROM work_sessions');
    await session(people.bo, asset.three.id, `${FRIDAY} 16:00:00`, `${NEXT_MONDAY} 10:00:00`);

    const friday = (await as('root', `/idle/report?from=${FRIDAY}&to=${FRIDAY}`)).body;
    assert.strictEqual(friday.totals.expectedHours, 16);
    assert.strictEqual(friday.totals.engagedHours, 8,
      'a day counts at most one standard day however long the span ran');
    assert.strictEqual(friday.totals.idleHours, 8);

    /* And across the whole stretch: three days of the range are working days
       (Fri, Mon — Sat and Sun are not), so available is 2 people x 2 days x 8h
       = 32, and Bo contributed 8 + 8 = 16. */
    const across = (await as('root', `/idle/report?from=${FRIDAY}&to=${NEXT_MONDAY}`)).body;
    assert.strictEqual(across.workingDays, 2, 'Friday and Monday; the weekend is not counted');
    assert.strictEqual(across.totals.expectedHours, 32);
    assert.strictEqual(across.totals.engagedHours, 16, 'not the 66 hours of wall clock');
  });

  await t.test('the panel shows all three periods, and each adds up', async () => {
    /* Placed TODAY, because the panel is always period-to-date and cannot be
       pointed at a fixed week. The arithmetic is therefore expressed against
       the working days the app itself reports rather than a hardcoded count —
       the identity being checked is the one that must always hold. */
    await sql(cfg, 'DELETE FROM work_sessions');
    const today = new Date().toISOString().slice(0, 10);
    await session(people.ana, asset.one.id, `${today} 09:00:00`, `${today} 12:00:00`);

    const cap = await capacityFor('root');
    assert.ok(cap, 'the block is present for somebody holding View Idle Report');
    assert.deepStrictEqual(cap.periods.map((p) => p.id), ['day', 'month', 'year']);

    for (const period of cap.periods) {
      assert.strictEqual(period.headcount, 2, `${period.label}: the two assignable people`);

      /* AVAILABLE = headcount x working days x standard day. */
      assert.strictEqual(period.availableHours,
        idle.round(period.headcount * period.workingDays * cap.schedule.hoursPerDay),
        `${period.label}: available is headcount x working days x standard day`);

      /* CONSUMED + IDLE = AVAILABLE, exactly. This holds because coverage is
         capped at one standard day per working day, so nobody can be engaged
         for more than they were available — see coverage() in src/idle.js. */
      assert.strictEqual(idle.round(period.consumedHours + period.idleHours), period.availableHours,
        `${period.label}: consumed plus idle must equal available`);

      assert.ok(period.consumedHours >= 0 && period.idleHours >= 0);
      assert.strictEqual(period.to, today, `${period.label} runs to today, not past it`);
    }

    // Today's three hours are in all three periods, since all three include today.
    for (const period of cap.periods) {
      assert.ok(period.consumedHours >= 3, `${period.label} includes today's 3 hours`);
    }

    /* And the periods nest: a day is inside the month is inside the year, so
       neither available nor consumed can shrink as the window widens. */
    const [day, month, year] = cap.periods;
    assert.ok(month.availableHours >= day.availableHours, 'the month is at least the day');
    assert.ok(year.availableHours >= month.availableHours, 'the year is at least the month');
    assert.ok(month.consumedHours >= day.consumedHours);
    assert.ok(year.consumedHours >= month.consumedHours);
  });

  await t.test('the figures match the Idle Report exactly, not approximately', async () => {
    /* The requirement that makes reuse worth it. Both screens are drawn from
       buildIdleReport, so this is checking the wiring rather than the maths —
       which is precisely the thing that could be wrong. */
    const cap = await capacityFor('root');
    const day = cap.periods.find((p) => p.id === 'day');

    const report = (await as('root', `/idle/report?from=${day.from}&to=${day.to}`)).body;
    assert.strictEqual(day.availableHours, report.totals.expectedHours);
    assert.strictEqual(day.consumedHours, report.totals.engagedHours);
    assert.strictEqual(day.idleHours, report.totals.idleHours);
    assert.strictEqual(day.headcount, report.totals.people);
    assert.strictEqual(day.workingDays, report.workingDays);

    // The month too, so this is not one lucky range.
    const month = cap.periods.find((p) => p.id === 'month');
    const monthReport = (await as('root', `/idle/report?from=${month.from}&to=${month.to}`)).body;
    assert.strictEqual(month.availableHours, monthReport.totals.expectedHours);
    assert.strictEqual(month.consumedHours, monthReport.totals.engagedHours);
    assert.strictEqual(month.idleHours, monthReport.totals.idleHours);
  });

  await t.test('utilisation is consumed over available, and null when nothing is expected', async () => {
    const cap = await capacityFor('root');
    for (const period of cap.periods) {
      if (period.availableHours > 0) {
        assert.strictEqual(period.utilisationPercent,
          idle.round((period.consumedHours / period.availableHours) * 100),
          `${period.label}: utilisation is consumed over available`);
      } else {
        assert.strictEqual(period.utilisationPercent, null,
          'a period expecting nothing has no utilisation — 0% would read as a wasted week');
      }
    }
  });

  await t.test('the caveats travel with the numbers', async () => {
    /* An annual available-hours figure silently assumes nobody took a day off
       all year. These sentences are the app saying so. */
    const cap = await capacityFor('root');
    assert.ok(cap.caveats.length, 'the caveats are carried');
    assert.ok(cap.caveats.some((c) => /leave|holiday|sick/i.test(c)),
      'including that leave and holidays are recorded nowhere in this app');
    // Same text the Idle Report prints, not a second wording of it.
    const report = (await as('root', '/idle/report')).body;
    assert.deepStrictEqual(cap.caveats, report.caveats);
  });

  // --- the permission ---------------------------------------------------------

  await t.test('without View Idle Report the block is absent, not empty', async () => {
    /* THE GATE THAT MATTERS. This block shows exactly what report.idle gates,
       so granting the dashboard alone must not hand it over by another door.
       Absent rather than zeroed: an empty capacity block asserts the studio has
       no capacity, and a zeroed one still discloses the headcount. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('report.idle'), 'an artist starts without it');

    // Give them the dashboard and NOT the idle report.
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'report.admin_dashboard'] },
    });
    token.ana = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@zvky.test', password: PASSWORD } })).body.token;

    const dash = await as('ana', '/admin-dashboard');
    assert.strictEqual(dash.status, 200, 'the dashboard itself opens');
    assert.strictEqual(dash.body.capacity, undefined,
      'the capacity key must be absent from the payload entirely');
    assert.ok(!JSON.stringify(dash.body).includes('availableHours'),
      'and no capacity figure reaches them under any other name');

    // Add the idle report, and it appears.
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'report.admin_dashboard', 'report.idle'] },
    });
    const withIdle = await as('ana', '/admin-dashboard');
    assert.ok(withIdle.body.capacity, 'granting View Idle Report reveals it');
    assert.strictEqual(withIdle.body.capacity.periods.length, 3);

    // And taking it away hides it again — so this is the permission, not a role.
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'report.admin_dashboard'] },
    });
    assert.strictEqual((await as('ana', '/admin-dashboard')).body.capacity, undefined);

    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: held },
    });
  });

  await t.test('only designations the studio gives work to are counted', async () => {
    /* Root is a Super Admin: full access, and not `assignable`. Their hours are
       not studio capacity, and counting them would inflate available by a whole
       person per administrator. Selected on the capability rather than a list
       of role names, so a designation added in Settings is included without
       anybody editing code. */
    const cap = await capacityFor('root');
    assert.strictEqual(cap.periods[0].headcount, 2, 'the two artists, not the three accounts');

    const { rows } = { rows: await sql(cfg, 'SELECT COUNT(*) AS n FROM users') };
    assert.strictEqual(Number(rows[0].n), 3, 'there are three accounts in total');
  });

  await t.test('nothing about the Idle Report or the rest of the dashboard moved', async () => {
    /* Additive, asserted. The Idle Report answers as it always did, and the
       dashboard's own panels are untouched by the block beside them. */
    const report = await as('root', '/idle/report');
    assert.strictEqual(report.status, 200);
    assert.ok(report.body.rows.length, 'it still lists people');
    assert.ok(report.body.totals, 'and still totals them');

    const dash = (await as('root', '/admin-dashboard')).body;
    for (const key of ['counts', 'pipeline', 'calendar', 'attention', 'scope', 'thresholds']) {
      assert.ok(dash[key] !== undefined, `the dashboard still carries ${key}`);
    }
    assert.strictEqual(dash.counts.active + dash.counts.delivered >= 1, true);

    // Still read-only: opening it writes nothing.
    const before = (await as('root', '/activity?limit=200')).body.total;
    await as('root', '/admin-dashboard');
    assert.strictEqual((await as('root', '/activity?limit=200')).body.total, before);
  });
});
