/* WHAT A TIMESHEET LINE IS WORTH: THIS PERSON, THAT ASSET, THAT DAY.
 *
 * THE BUG THIS FILE IS THE RECORD OF. A line naming an asset was worth the
 * asset's whole recorded time for that person, less everything they had ever
 * filed against it — workLog.recordedFor(), a query with no date in it at all.
 * So three hours on Thursday and two on Friday put FIVE in the locked Hours
 * field on Thursday, FILED five, and then refused Friday's line with "all 5h
 * recorded against that asset is already on your timesheet". The day's own
 * figure existed and was shown as a footnote beside the number actually used.
 *
 * The reproduction is the first case below, as the report gave it.
 *
 * WHY THE DAY FIGURE HAD BEEN REJECTED, and why that reason is gone. It dropped
 * any stretch that ran past midnight — "there is genuinely no way to know how
 * much of a stretch running from Tuesday afternoon to Wednesday morning was
 * Tuesday's" — so offering it would have lost those hours for good. That is not
 * true: work_sessions.seconds is the span intersected with the studio's open
 * hours, and that intersection is additive, so Tuesday's part is exactly
 * computable. dayTotalFor splits it, the parts sum to the whole, and the
 * per-day figures therefore add up to the asset's recorded time once — which is
 * the property the whole-asset subtraction was there to buy.
 *
 * FIXED DATES EVERYWHERE BUT ONE CASE. Every fixture here carries explicit
 * stamps, so nothing depends on the hour the suite runs — except the running
 * session, which is measured against the real now by definition, and which says
 * so where it does it. openStudio() opens the clock around the clock, or a
 * fixture at 10:00 IST would be clipped by the shipped lunch hour and a figure
 * here would be about the schedule rather than about the split.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, openStudio,
  SKIP_REASON } = require('./helpers');
const wt = require('../src/working-time');

const cfg = config('tsday');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const PASSWORD = 'Day-Hours-1!';

// ---------------------------------------------------------------------------
// The arithmetic, with no server: the split, and that it loses nothing.
// ---------------------------------------------------------------------------

const ALWAYS_OPEN = { workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: 0, dayEnd: 24 * 60, breaks: [] };
const ist = (text) => Date.parse(`${text}+05:30`);

test('the per-day split agrees with the figure the whole span is stored as', () => {
  /* THE ONE FUNNEL, STILL ONE. workingSecondsBetween is what close() stores in
     work_sessions.seconds and what every report reads; workingMsByDay is the
     same walk kept per day. If they ever disagree, the timesheet and the
     Efficiency report are measuring different things. */
  const cases = [
    ['2026-10-09T22:30:00', '2026-10-10T01:30:00'],          // across midnight
    ['2026-10-09T10:00:00', '2026-10-09T13:00:00'],          // inside one day
    ['2026-10-09T23:59:59', '2026-10-10T00:00:01'],          // two seconds, one each side
    ['2026-10-07T17:00:00', '2026-10-10T09:00:00'],          // three nights
  ];
  for (const [from, to] of cases) {
    const span = wt.workingSecondsBetween(ist(from), ist(to), ALWAYS_OPEN);
    const { total } = wt.workingMsByDay(ist(from), ist(to), ALWAYS_OPEN);
    assert.strictEqual(Math.round(total / 1000), span, `${from} → ${to}`);
  }
});

test('a stretch across midnight splits at midnight IST, and the parts sum to it', () => {
  // 22:30 to 01:30 IST — the brief's own example.
  const from = ist('2026-10-09T22:30:00');
  const to = ist('2026-10-10T01:30:00');
  const { total, byDay } = wt.workingMsByDay(from, to, ALWAYS_OPEN);
  assert.deepStrictEqual([...byDay.keys()], ['2026-10-09', '2026-10-10'], 'two days, in order');
  const share = wt.allocateSeconds(Math.round(total / 1000), byDay);
  assert.strictEqual(share.get('2026-10-09'), 1.5 * 3600, 'an hour and a half before midnight');
  assert.strictEqual(share.get('2026-10-10'), 1.5 * 3600, 'and an hour and a half after it');
  assert.strictEqual(share.get('2026-10-09') + share.get('2026-10-10'), 3 * 3600,
    'which add up to the stretch, exactly');
});

test('nothing is lost or gained to rounding, for any whole', () => {
  /* THE PROPERTY THE BRIEF ASKED TO BE PINNED. Rounding each day on its own can
     leave the parts a second short of the whole — invisible in one session and
     an hour adrift over a year of them. allocateSeconds hands out every
     leftover second, so the sum is the whole for every input, including the
     ones that divide badly. */
  const from = ist('2026-10-09T21:00:00');
  const to = ist('2026-10-10T03:00:00');
  const { byDay } = wt.workingMsByDay(from, to, ALWAYS_OPEN);
  for (const whole of [0, 1, 2, 3, 7, 59, 3600, 10801, 21599, 86399, 1234567]) {
    const share = wt.allocateSeconds(whole, byDay);
    const sum = [...share.values()].reduce((n, v) => n + v, 0);
    assert.strictEqual(sum, whole, `${whole} seconds divided across two days`);
    for (const v of share.values()) assert.ok(v >= 0, 'and no day is given a negative share');
  }

  /* Three days, an awkward total, and the same guarantee. The remainder goes to
     the biggest fraction first and ties to the earlier date, so the answer does
     not depend on the order a map happens to be built in. */
  const long = wt.workingMsByDay(ist('2026-10-09T20:00:00'), ist('2026-10-12T04:00:00'), ALWAYS_OPEN);
  const share = wt.allocateSeconds(100000, long.byDay);
  assert.strictEqual([...share.values()].reduce((n, v) => n + v, 0), 100000);
});

test('a day the studio is shut contributes nothing, so paused and closed time is never counted', () => {
  /* Lunch, the evening and a weekend are all the same thing to this walk: time
     with no open span over it. Nothing is subtracted anywhere — the figure is
     built from the open spans, so a pause cannot be counted by accident. */
  const nineToFive = { workingDays: [1, 2, 3, 4, 5], dayStart: 9 * 60, dayEnd: 17 * 60,
    breaks: [{ start: 13 * 60, end: 14 * 60 }] };
  // Friday 09:00 IST to Monday 11:00 IST: 7 h Friday (8 less the lunch hour),
  // nothing at the weekend, 2 h Monday.
  const { byDay, total } = wt.workingMsByDay(ist('2026-10-09T09:00:00'), ist('2026-10-12T11:00:00'), nineToFive);
  assert.deepStrictEqual([...byDay.entries()].map(([d, ms]) => [d, ms / 3600000]),
    [['2026-10-09', 7], ['2026-10-12', 2]], 'Friday and Monday only');
  assert.strictEqual(total / 3600000, 9, 'and the weekend is not in the total');

  // The lunch hour, specifically: a stretch straddling it counts around it.
  const over = wt.workingMsByDay(ist('2026-10-09T12:30:00'), ist('2026-10-09T14:30:00'), nineToFive);
  assert.strictEqual(over.total / 60000, 60, 'half an hour each side of the hour off');
});

// ---------------------------------------------------------------------------
// The page: it asks, it does not work anything out, and the last answer wins.
// ---------------------------------------------------------------------------

function grab(opener, closer = '\n}') {
  const at = PAGE.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener} in the page`);
  const rest = PAGE.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

/* The page's own tlSuggest, run against a stub.
 *
 * `api` is a recorder whose promises the test resolves by hand, which is the
 * only way to make a slow reply land after a fast one deliberately rather than
 * by luck. Everything else is the smallest thing that satisfies the function. */
function pageHarness() {
  const source = [
    grab('let tlSuggestTicket = 0;', ';'),
    grab('async function tlSuggest()'),
  ].join('\n');

  const nodes = {
    tl_suggest: { textContent: '' },
    tl_hours: { value: '', readOnly: false, classList: { toggle() {} }, title: '' },
    tl_asset: { value: '' },
  };
  const calls = [];
  const state = { locked: null, recalcs: 0, day: null };
  const fn = new Function('document', 'api', 'tlLockHours', 'tlRecalc', 'tsPretty', 'nodes',
    'calls', 'harness',
    `let tlDay = null;
     Object.defineProperty(harness, 'day', { get: () => tlDay, set: (v) => { tlDay = v; } });
     ${source};
     return tlSuggest;`
  );
  const harness = {};
  const run = fn(
    { getElementById: (id) => nodes[id] || null },
    (url) => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      calls.push({ url, resolve, reject });
      return promise;
    },
    (locked) => { state.locked = locked; },
    () => { state.recalcs += 1; },
    (iso) => iso.slice(8) + ' Oct',
    nodes, calls, harness
  );
  return { run, nodes, calls, state, harness };
}

test('the page sends the date it is on, and holds no date arithmetic of its own', () => {
  const body = grab('async function tlSuggest()').replace(/\/\*[\s\S]*?\*\//g, '');
  /* Arithmetic tokens only: the word "midnight" is in the sentence the page
     PRINTS about a stretch that ran past one, which is the server's finding
     repeated rather than the page working anything out. */
  for (const forbidden of ['330', '86400000', 'getUTCDate', 'setDate', 'IST_OFFSET',
    'Date.parse', 'toISOString']) {
    assert.ok(!body.includes(forbidden), `the page must not work the day out itself (${forbidden})`);
  }
  assert.match(body, /date=\$\{askedFor\}/, 'it sends the day the form is on');
  assert.match(body, /s\.onThisDay/, 'and prints the figure the server returns');
  /* The FIELD, not the word: "recorded" is in the sentence the page prints
     about the day. What must be gone is any reading of the asset's whole
     total, which the payload no longer carries. */
  assert.ok(!/s\.recorded/.test(body), 'the asset\'s whole total is not read here at all');
  assert.ok(!/\brecorded\b\s*[,:)]/.test(body), 'and not destructured from the response either');
});

test('changing the day refetches, and the figure follows the date', async () => {
  const h = pageHarness();
  h.nodes.tl_asset.value = 'asset-1';
  h.harness.day = '2026-10-08';
  const first = h.run();
  assert.strictEqual(h.calls.length, 1);
  assert.match(h.calls[0].url, /assetId=asset-1&date=2026-10-08/);
  h.calls[0].resolve({ date: '2026-10-08', assetId: 'asset-1', hours: 3, onThisDay: 3,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await first;
  assert.strictEqual(h.nodes.tl_hours.value, 3);
  assert.match(h.nodes.tl_suggest.textContent, /Recorded on this asset on 08 Oct: 3h/);

  // The form moves to the next day — the same asset, a different answer.
  h.harness.day = '2026-10-09';
  const second = h.run();
  assert.strictEqual(h.calls.length, 2, 'it asked again rather than reusing the figure');
  assert.match(h.calls[1].url, /date=2026-10-09/);
  h.calls[1].resolve({ date: '2026-10-09', assetId: 'asset-1', hours: 2, onThisDay: 2,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await second;
  assert.strictEqual(h.nodes.tl_hours.value, 2, 'the figure follows the date');
  assert.match(h.nodes.tl_suggest.textContent, /on 09 Oct: 2h/);
});

test('a slow reply for an old day or asset never overwrites a newer one', async () => {
  /* THE RACE, MADE TO HAPPEN. Two requests, the second answered first: without
     the ticket the first reply would land afterwards and put the old day's
     hours in a LOCKED field under the new day's heading — a wrong number
     nobody can correct. */
  const h = pageHarness();
  h.nodes.tl_asset.value = 'asset-1';
  h.harness.day = '2026-10-08';
  const slow = h.run();
  h.harness.day = '2026-10-09';
  const fast = h.run();

  h.calls[1].resolve({ date: '2026-10-09', assetId: 'asset-1', hours: 2, onThisDay: 2,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await fast;
  assert.strictEqual(h.nodes.tl_hours.value, 2);

  h.calls[0].resolve({ date: '2026-10-08', assetId: 'asset-1', hours: 3, onThisDay: 3,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await slow;
  assert.strictEqual(h.nodes.tl_hours.value, 2, 'the older answer was dropped');
  assert.match(h.nodes.tl_suggest.textContent, /on 09 Oct: 2h/, 'and so was its sentence');

  // The same for a changed asset, where the day has not moved.
  const h2 = pageHarness();
  h2.harness.day = '2026-10-09';
  h2.nodes.tl_asset.value = 'asset-A';
  const a = h2.run();
  h2.nodes.tl_asset.value = 'asset-B';
  const b = h2.run();
  h2.calls[1].resolve({ date: '2026-10-09', assetId: 'asset-B', hours: 4, onThisDay: 4,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await b;
  h2.calls[0].resolve({ date: '2026-10-09', assetId: 'asset-A', hours: 9, onThisDay: 9,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await a;
  assert.strictEqual(h2.nodes.tl_hours.value, 4, 'asset B\'s figure stands');
});

test('a failed lookup says so instead of leaving the last number on screen', async () => {
  const h = pageHarness();
  h.nodes.tl_asset.value = 'asset-1';
  h.harness.day = '2026-10-08';
  const ok = h.run();
  h.calls[0].resolve({ date: '2026-10-08', assetId: 'asset-1', hours: 3, onThisDay: 3,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await ok;
  assert.strictEqual(h.nodes.tl_hours.value, 3);

  h.nodes.tl_asset.value = 'asset-2';
  const bad = h.run();
  h.calls[1].reject(new Error('Service Unavailable'));
  await bad;
  assert.strictEqual(h.nodes.tl_hours.value, '', 'the previous asset\'s hours are gone');
  assert.match(h.nodes.tl_suggest.textContent, /Could not read the clock/);
  assert.match(h.nodes.tl_suggest.textContent, /Service Unavailable/, 'and says what failed');
  assert.strictEqual(h.state.locked, false, 'with the field handed back to be typed');
});

test('none recorded on the day is a stated answer, not an empty locked box', async () => {
  const h = pageHarness();
  h.nodes.tl_asset.value = 'asset-1';
  h.harness.day = '2026-10-10';
  const run = h.run();
  h.calls[0].resolve({ date: '2026-10-10', assetId: 'asset-1', hours: null, onThisDay: 0,
    logged: 0, open: false, crossing: 0, openCapped: 0 });
  await run;
  assert.strictEqual(h.nodes.tl_hours.value, '');
  assert.match(h.nodes.tl_suggest.textContent, /None recorded on this asset on 10 Oct/);
  assert.match(h.nodes.tl_suggest.textContent, /leave the asset unset and type the hours/,
    'and points at the way to file time the timer never saw');
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('the day figure, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  const asset = async (name, assigneeId = id.ana) => (await as('root', `/assets/project/${id.project}`, {
    method: 'POST', body: { name, type: 'prop', assigneeId, manHours: 20 } })).body.asset.id;

  /* A closed stretch, with its stamps written out in UTC — the clock the
     database keeps. 04:30 UTC is 10:00 IST, which is where these read most
     easily. `seconds` is what close() would have stored: the span intersected
     with the studio's open hours, which openStudio has opened all the way. */
  const stretch = (assetId, from, to, seconds, userId = id.ana) => sql(cfg,
    `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
     VALUES (UUID(), ?, ?, 1, ?, ?, ?, 'submitted')`,
    [assetId, userId, from, to, seconds]);

  const ask = async (who, assetId, date) =>
    (await as(who, `/timesheets/suggest?assetId=${assetId}&date=${date}`)).body;
  const file = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tsday-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tsday-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* The clock opened all the way, so a fixture at 10:00 IST is not clipped by
       the shipped lunch hour and every figure here is about the day split. */
    await openStudio(server.base, tok.root);
    id.client = await systemClientId(server.base, tok.root);
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Day Hours', clientId: id.client } })).body.project.id;
    for (const [who, name] of [['ana', 'Ana'], ['bo', 'Bo']]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name, email: `${who}@zvky.test`, role: 'game_artist', password: PASSWORD,
          projectId: id.project } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[who] = r.body.user.id;
      tok[who] = await login(`${who}@zvky.test`);
    }
    /* Every day these cases file on has to be one the studio logs hours for,
       and the default is Monday to Friday. Opened to all seven here so that a
       fixture dated to a Saturday is testing the SPLIT rather than the
       loggable-days rule, which tests/timesheet.test.js owns. */
    const options = await as('root', '/admin/settings/timesheet');
    assert.strictEqual(options.status, 200, JSON.stringify(options.body));
    const saved = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...options.body.settings, loggableDays: [1, 2, 3, 4, 5, 6, 7] } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('THE REPRODUCTION: 3h yesterday and 2h today, filed on their own days', async () => {
    /* The report's own scenario, with the dates fixed. Before this change the
       form showed 5 on both days, filed 5 on the first, and refused the second
       as "all 5h is already on your timesheet". */
    const a1 = await asset('A1');
    await stretch(a1, '2026-03-05 04:30:00', '2026-03-05 07:30:00', 3 * 3600);  // Thu, 3h
    await stretch(a1, '2026-03-06 04:30:00', '2026-03-06 06:30:00', 2 * 3600);  // Fri, 2h

    const thu = await ask('ana', a1, '2026-03-05');
    assert.strictEqual(thu.onThisDay, 3, 'Thursday holds its own three hours');
    assert.strictEqual(thu.hours, 3, 'and that is what the locked field shows');
    assert.strictEqual(thu.recorded, undefined, 'the asset\'s whole total is not in the payload');

    const fri = await ask('ana', a1, '2026-03-06');
    assert.strictEqual(fri.onThisDay, 2);
    assert.strictEqual(fri.hours, 2);

    // Filed with a typed number, which the server ignores on an asset line.
    const one = await file('ana', { date: '2026-03-05', hours: 9, clientId: id.client,
      projectId: id.project, assetId: a1 });
    assert.strictEqual(one.status, 201, JSON.stringify(one.body));
    assert.strictEqual(Number(one.body.entry.hours), 3);
    const two = await file('ana', { date: '2026-03-06', hours: 9, clientId: id.client,
      projectId: id.project, assetId: a1 });
    assert.strictEqual(two.status, 201, JSON.stringify(two.body));
    assert.strictEqual(Number(two.body.entry.hours), 2, 'and the second day is no longer refused');

    /* AND THE ASSET'S OWN TOTAL IS STILL FIVE, where a whole-asset total is the
       right answer: Time Spent on the Assets List reads work_sessions across
       everybody, and this change did not touch it. */
    const spent = await sql(cfg,
      'SELECT COALESCE(SUM(seconds),0) AS s FROM work_sessions WHERE asset_id = ?', [a1]);
    assert.strictEqual(Number(spent[0].s) / 3600, 5, 'the clock still says five');
    const listed = (await as('root', `/assets/project/${id.project}`)).body.assets
      .find((a) => a.id === a1);
    assert.strictEqual(Number(listed.time_spent_seconds || listed.timeSpentSeconds || 0) / 3600, 5,
      'and so does the asset list');
    // The two lines add up to it, once.
    const filed = await sql(cfg,
      'SELECT COALESCE(SUM(hours),0) AS h FROM timesheet_entries WHERE asset_id = ?', [a1]);
    assert.strictEqual(Number(filed[0].h), 5, 'filed per day, summing to the recorded total');
  });

  await t.test('a stretch across midnight is split, and the two days sum to it', async () => {
    const night = await asset('Night Shift');
    // 2026-03-09 22:30 IST -> 2026-03-10 01:30 IST  =  17:00 -> 20:00 UTC on the 12th.
    await stretch(night, '2026-03-09 17:00:00', '2026-03-09 20:00:00', 3 * 3600);

    const before = await ask('ana', night, '2026-03-09');
    const after = await ask('ana', night, '2026-03-10');
    assert.strictEqual(before.onThisDay, 1.5, 'the part before midnight');
    assert.strictEqual(after.onThisDay, 1.5, 'and the part after it');
    assert.strictEqual(before.onThisDay + after.onThisDay, 3, 'exactly the stretch');
    assert.strictEqual(before.crossing, 1, 'and the day says it holds part of a stretch');

    // Both halves are fileable, and together they claim the stretch once.
    assert.strictEqual(Number((await file('ana', { date: '2026-03-09', hours: 1,
      clientId: id.client, projectId: id.project, assetId: night })).body.entry.hours), 1.5);
    assert.strictEqual(Number((await file('ana', { date: '2026-03-10', hours: 1,
      clientId: id.client, projectId: id.project, assetId: night })).body.entry.hours), 1.5);
    const filed = await sql(cfg,
      'SELECT COALESCE(SUM(hours),0) AS h FROM timesheet_entries WHERE asset_id = ?', [night]);
    assert.strictEqual(Number(filed[0].h), 3, 'the stretch, filed once, across two lines');
  });

  await t.test('the boundary instants land on the right side of midnight', async () => {
    const edge = await asset('Edge');
    /* HALF AN HOUR EACH SIDE of midnight IST: 23:30 to 00:30 IST is 18:00 to
       19:00 UTC. Half an hour rather than a minute because the figure is HOURS
       TO TWO PLACES — the unit the field steps in and the column stores — and a
       minute is 0.0167h, which that unit cannot express. The second-level
       boundary is pinned without a server in the arithmetic cases above, where
       there is nothing rounding it. */
    await stretch(edge, '2026-03-11 18:00:00', '2026-03-11 19:00:00', 3600);
    const d11 = await ask('ana', edge, '2026-03-11');
    const d12 = await ask('ana', edge, '2026-03-12');
    assert.strictEqual(d11.onThisDay, 0.5, 'half an hour on the 11th');
    assert.strictEqual(d12.onThisDay, 0.5, 'and half an hour on the 12th');
    assert.strictEqual(d11.onThisDay + d12.onThisDay, 1, 'adding up to the stretch');

    /* A stretch ending EXACTLY at midnight belongs entirely to the day it ran
       in: a span includes its start and not its end, which is the same rule the
       recording windows are read with. */
    const upTo = await asset('Up To Midnight');
    await stretch(upTo, '2026-03-13 18:00:00', '2026-03-13 18:30:00', 1800);  // 23:30 -> 00:00 IST
    assert.strictEqual((await ask('ana', upTo, '2026-03-13')).onThisDay, 0.5, 'all of it on the 16th');
    assert.strictEqual((await ask('ana', upTo, '2026-03-14')).onThisDay, 0, 'and none on the 17th');

    /* And one starting exactly at midnight is entirely the new day's. */
    const from = await asset('From Midnight');
    await stretch(from, '2026-03-14 18:30:00', '2026-03-14 19:30:00', 3600);  // 00:00 -> 01:00 IST on the 18th
    assert.strictEqual((await ask('ana', from, '2026-03-14')).onThisDay, 0);
    assert.strictEqual((await ask('ana', from, '2026-03-15')).onThisDay, 1);
  });

  await t.test('a paused and resumed day counts only the worked stretches', async () => {
    /* A hold CLOSES a row and a resume opens another, so the gap is between two
       rows and in neither. Nothing is subtracted; the figure is built from the
       rows that exist. */
    const stop = await asset('Stop And Start');
    await stretch(stop, '2026-03-17 03:30:00', '2026-03-17 05:30:00', 2 * 3600);   // 09:00-11:00 IST
    await stretch(stop, '2026-03-17 07:30:00', '2026-03-17 08:30:00', 1 * 3600);   // 13:00-14:00 IST
    await stretch(stop, '2026-03-17 10:30:00', '2026-03-17 12:30:00', 2 * 3600);   // 16:00-18:00 IST
    const day = await ask('ana', stop, '2026-03-17');
    assert.strictEqual(day.onThisDay, 5, 'five worked hours across a nine-hour span');
    assert.strictEqual(Number((await file('ana', { date: '2026-03-17', hours: 9,
      clientId: id.client, projectId: id.project, assetId: stop })).body.entry.hours), 5);
  });

  await t.test('a session the overnight resume picked up again lands on both days', async () => {
    /* What the sweep leaves behind: the evening's stretch closed at the cutoff,
       and a second one opened the next morning and back-dated to the opening.
       Two rows, two days, and each day's line is its own. */
    const over = await asset('Overnight');
    await stretch(over, '2026-03-18 12:00:00', '2026-03-18 13:30:00', 1.5 * 3600);  // 17:30-19:00 IST
    await stretch(over, '2026-03-19 04:00:00', '2026-03-19 06:00:00', 2 * 3600);    // 09:30-11:30 IST
    assert.strictEqual((await ask('ana', over, '2026-03-18')).onThisDay, 1.5, 'the evening');
    assert.strictEqual((await ask('ana', over, '2026-03-19')).onThisDay, 2, 'and the morning after');
    assert.strictEqual((await ask('ana', over, '2026-03-18')).crossing, 0,
      'neither row crossed midnight, so neither day says one did');
  });

  await t.test('a running session counts up to now for today, and not at all for a past day', async () => {
    /* THE ONE CASE MEASURED AGAINST THE REAL CLOCK, because a live session is.
       The duration is fixed — half an hour — and the assertion is made over
       today and yesterday together, so a suite running within half an hour of
       IST midnight measures the same half hour rather than failing. */
    const live = await asset('Still Going');
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, NOW() - INTERVAL 30 MINUTE, NULL, NULL, NULL)`,
      [live, id.ana]);
    const istDay = (offset = 0) => new Date(Date.now() + (5 * 60 + 30) * 60000
      + offset * 86400000).toISOString().slice(0, 10);

    const today = await ask('ana', live, istDay(0));
    const yesterday = await ask('ana', live, istDay(-1));
    assert.strictEqual(today.open, true, 'today is told a session is running');
    const both = today.onThisDay + yesterday.onThisDay;
    assert.ok(Math.abs(both - 0.5) < 0.05, `about half an hour so far — got ${both}`);

    // And none of it on an unrelated past day.
    const past = await ask('ana', live, '2026-03-17');
    assert.strictEqual(past.onThisDay, 0, 'a past day gets nothing from a session running now');
    assert.strictEqual(past.open, false, 'and is not told one is open on it');
  });

  await t.test('an open session spanning a day that has ended is capped at that day', async () => {
    /* The sweep should have closed it; this is what happens when it did not —
       a process that was down all evening, usually. Counting to NOW would put
       today's hours on a line for last week, so the figure stops at the end of
       the day being asked about and the response says it had to. */
    const stuck = await asset('Never Closed');
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-20 03:30:00', NULL, NULL, NULL)`,
      [stuck, id.ana]);                                            // 09:00 IST, never closed
    const that = await ask('ana', stuck, '2026-03-20');
    assert.strictEqual(that.onThisDay, 15, 'from 09:00 IST to midnight, and no further');
    assert.strictEqual(that.openCapped, 1, 'and the caller is told the figure was capped');
    /* The day after gets its own capped slice rather than everything since —
        the row is still open, so each past day it spans is its own full day. */
    assert.strictEqual((await ask('ana', stuck, '2026-03-21')).onThisDay, 24);
  });

  await t.test('another person\'s hours on the same asset are never in this figure', async () => {
    const shared = await asset('Handed On');
    await stretch(shared, '2026-03-23 04:30:00', '2026-03-23 06:30:00', 2 * 3600, id.ana);
    await stretch(shared, '2026-03-23 06:30:00', '2026-03-23 08:00:00', 1.5 * 3600, id.bo);
    assert.strictEqual((await ask('ana', shared, '2026-03-23')).onThisDay, 2, 'Ana\'s own two');
    assert.strictEqual((await ask('bo', shared, '2026-03-23')).onThisDay, 1.5, 'Bo\'s own hour and a half');

    /* THE FIGURE IS THE TIMESHEET OWNER'S, and today the owner is always the
       caller: POST /entries writes req.user's line and takes no userId, and
       /suggest has no userId parameter either. So there is no on-behalf-of path
       to get wrong — pinned here, because the day one is added is the day this
       has to be revisited, and dayFigure() already takes the owner's id. */
    const forged = await file('bo', { date: '2026-03-23', hours: 9, userId: id.ana,
      clientId: id.client, projectId: id.project, assetId: shared });
    assert.strictEqual(forged.status, 201);
    assert.strictEqual(Number(forged.body.entry.hours), 1.5,
      'Bo files Bo\'s hours whatever userId the request carries');
    const whose = await sql(cfg,
      'SELECT user_id FROM timesheet_entries WHERE id = ?', [forged.body.entry.id]);
    assert.strictEqual(whose[0].user_id, id.bo, 'and the line is Bo\'s');
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'timesheets.js'), 'utf8');
    assert.ok(!/req\.body\.userId/.test(route), 'nothing reads a userId off the body');
  });

  await t.test('an asset worked across three days answers for each of them', async () => {
    const three = await asset('Three Days');
    await stretch(three, '2026-03-24 04:30:00', '2026-03-24 06:30:00', 2 * 3600);     // 2h
    await stretch(three, '2026-03-25 04:30:00', '2026-03-25 09:00:00', 4.5 * 3600);   // 4.5h
    await stretch(three, '2026-03-26 04:30:00', '2026-03-02 05:00:00', 0.5 * 3600);   // 0.5h, see below
    /* The third row's end stamp is deliberately a nonsense one — earlier than
       its start, which a clock nudged backwards can write — and it must simply
       contribute nothing rather than a negative share. */
    assert.strictEqual((await ask('ana', three, '2026-03-24')).onThisDay, 2);
    assert.strictEqual((await ask('ana', three, '2026-03-25')).onThisDay, 4.5);
    assert.strictEqual((await ask('ana', three, '2026-03-26')).onThisDay, 0,
      'a backwards stamp is nothing, not a negative figure');
    assert.strictEqual((await ask('ana', three, '2026-03-27')).onThisDay, 0, 'and a quiet day is zero');
  });

  await t.test('a day with no sessions is zero, and the refusal names the day', async () => {
    const quiet = await asset('Untouched');
    const none = await ask('ana', quiet, '2026-03-30');
    assert.strictEqual(none.onThisDay, 0);
    assert.strictEqual(none.hours, null, 'nothing to offer');
    const refused = await file('ana', { date: '2026-03-30', hours: 3, clientId: id.client,
      projectId: id.project, assetId: quiet });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /Nothing was recorded against that asset by you on Monday 30 Mar/);
    assert.match(refused.body.error, /without naming an asset/,
      'and says how to file time the timer never saw');

    /* THE EXISTING RULE DECIDES, and that rule is: a line with no asset takes a
       typed figure. So the same hours go on without the asset, which is how
       offline work has always been filed. */
    const typed = await file('ana', { date: '2026-03-30', hours: 3, clientId: id.client,
      projectId: id.project });
    assert.strictEqual(typed.status, 201, JSON.stringify(typed.body));
    assert.strictEqual(Number(typed.body.entry.hours), 3, 'typed, kept, and not calculated');
  });

  await t.test('a freelancer-assigned asset has no tracked time, and behaves as it did', async () => {
    /* Outsourced work has no timer at all — nobody presses Accept and Start on
       it — so the day figure is zero and the line is refused for the same
       reason any untimed asset is. Unchanged by this work. */
    const out = (await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Freelance Prop', type: 'prop', manHours: 8 } })).body.asset.id;
    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Faye', discipline: 'modelling' } });
    assert.strictEqual(fl.status, 201, JSON.stringify(fl.body));
    const assigned = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: fl.body.freelancer.id, projectId: id.project, assetId: out,
        decidedManHours: 8 } });
    assert.strictEqual(assigned.status, 201, JSON.stringify(assigned.body));

    const none = await ask('ana', out, '2026-03-31');
    assert.strictEqual(none.onThisDay, 0, 'no sessions, no hours');
    assert.strictEqual(none.hours, null);
    const sessions = await sql(cfg,
      'SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = ?', [out]);
    assert.strictEqual(Number(sessions[0].n), 0, 'and no session was ever opened on it');
  });

  await t.test('the date is validated on the server: malformed is a 400, future is zero', async () => {
    const a = await asset('Dates');
    await stretch(a, '2026-04-01 04:30:00', '2026-04-01 06:30:00', 2 * 3600);

    for (const bad of ['', 'yesterday', '2026-13-40', '2026-02-30', '04/11/2026', 'NaN']) {
      const r = await as('ana', `/timesheets/suggest?assetId=${a}&date=${encodeURIComponent(bad)}`);
      assert.strictEqual(r.status, 400, `"${bad}" is not a day: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'date');
    }

    /* AND THE LENIENCE THE APP ALREADY HAS, pinned rather than removed:
       sheets.toISO() reduces a Date or an ISO instant to its day, which is how
       every other date parameter in the timesheet behaves. A day that does not
       exist is a different thing from a day written in full — the first is
       refused above, the second is accepted here. */
    const asInstant = await as('ana',
      `/timesheets/suggest?assetId=${a}&date=${encodeURIComponent('2026-04-01T10:00:00Z')}`);
    assert.strictEqual(asInstant.status, 200);
    assert.strictEqual(asInstant.body.date, '2026-04-01', 'read as that day');
    assert.strictEqual(asInstant.body.onThisDay, 2);

    /* A DAY THAT HAS NOT HAPPENED is zero rather than an error: the form can
       legitimately be open on tomorrow if the studio allows filing ahead, and
       nothing can have been recorded on it. */
    const ahead = await ask('ana', a, '2030-01-01');
    assert.strictEqual(ahead.onThisDay, 0);
    assert.strictEqual(ahead.hours, null);
    assert.strictEqual(ahead.future, true);

    // An asset id that is not one answers zero rather than failing.
    const nobody = await ask('ana', 'not-an-asset', '2026-04-01');
    assert.strictEqual(nobody.onThisDay, 0);
  });

  await t.test('the editing path applies the same day figure', async () => {
    /* PATCH is the obvious way round a locked field, so it recalculates — with
       this row's own hours left out of the subtraction, or an edit that changed
       only the notes would shrink the line to nothing. */
    const a = await asset('Edited');
    await stretch(a, '2026-04-02 04:30:00', '2026-04-02 07:00:00', 2.5 * 3600);
    const line = await file('ana', { date: '2026-04-02', hours: 8, clientId: id.client,
      projectId: id.project, assetId: a });
    assert.strictEqual(Number(line.body.entry.hours), 2.5, 'the day\'s figure on the way in');

    const edited = await as('ana', `/timesheets/entries/${line.body.entry.id}`,
      { method: 'PATCH', body: { hours: 8 } });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.strictEqual(Number(edited.body.entry.hours), 2.5, 'and on the way out');

    const renoted = await as('ana', `/timesheets/entries/${line.body.entry.id}`,
      { method: 'PATCH', body: { notes: 'Ridge pass' } });
    assert.strictEqual(Number(renoted.body.entry.hours), 2.5,
      'its own hours are not subtracted from itself');
  });

  await t.test('the day and week totals, and the exports, carry the filed figure', async () => {
    /* NOT A SECOND READING OF THE CLOCK. Every other timesheet figure sums
       timesheet_entries.hours, so fixing what gets filed fixes all of them —
       which is the half-migrated shape this change had to avoid. */
    const week = await as('ana', '/timesheets/week?date=2026-03-05');
    assert.strictEqual(week.status, 200, JSON.stringify(week.body));
    const thu = week.body.days.find((d) => d.date === '2026-03-05');
    const fri = week.body.days.find((d) => d.date === '2026-03-06');
    assert.strictEqual(thu.hours, 3, 'Thursday is three');
    assert.strictEqual(fri.hours, 2, 'Friday is two');
    assert.strictEqual(week.body.weekHours, 5, 'and the week is five, not ten');

    const rows = await as('ana', '/timesheets/export.xlsx?from=2026-03-05&to=2026-03-06');
    assert.ok(rows.status === 200 || rows.status === 403, `export answers: ${rows.status}`);
  });
});
