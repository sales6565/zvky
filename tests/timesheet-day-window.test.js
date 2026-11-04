/* PART B OF PROMPT 65: WHICH TIMESHEET DAYS ARE OPEN FOR ENTRY.
 *
 * ===========================================================================
 * THERE IS NO NEW WINDOW, AND THE FIRST BLOCK OF TESTS IS ABOUT THAT.
 *
 * backdateDays and futureDays have existed since Prompt 51. NULL on both is "no
 * limit"; 1 and 0 is "today and the previous day". So the switch somebody would
 * otherwise have added is the pair being set or not, and a second setting beside
 * them could only ever disagree with them.
 *
 * WHAT WAS MISSING WAS ENFORCEMENT, and that is the real subject here: the
 * windows were checked in sheets.validateEntry(), which POST and PATCH call —
 * and nothing else. DELETE and submit never looked at the date at all. A day
 * outside the window could be emptied and filed. Four tests below would have
 * passed before this prompt on create and edit and failed on delete and submit.
 *
 * THE THREE WAYS A CLOSED DAY OPENS, each with its own test, because each exists
 * for a different reason and a single "is it open" assertion would not say which
 * one answered:
 *
 *   the previous-day carve-out   the window declining to contradict the gate.
 *                                Not a privilege: it applies to somebody holding
 *                                nothing, which is why it is checked first.
 *   timesheet.backdate           somebody whose job is to fix last month.
 *   an unlock row                one person, one day, closed by submission.
 *
 * THE STUDIO'S TIMEZONE IS TESTED AT THE BOUNDARY, with the process in a
 * different one, because that is the bug this feature would otherwise ship: a
 * window computed from the server's own calendar closes the studio's current day
 * for five and a half hours every evening.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'timesheets.js'), 'utf8');
const SHEETS = fs.readFileSync(path.join(ROOT, 'src', 'timesheets.js'), 'utf8');

const dayWindow = require('../src/timesheet-day-window');

const cfg = config('tsdaywindow');
const PASSWORD = 'DayWindow-Test-1!';

/* FIXED DATES, never "today". 2026-10-07 is a Wednesday. */
const WED = '2026-10-07';
const TUE = '2026-10-06';
const MON = '2026-10-05';
const THU = '2026-10-08';
/* Six in the morning, studio time, on that Wednesday — comfortably inside the
   day whichever way the process's own clock is set. */
const AT_WED = Date.parse('2026-10-07T06:00:00+05:30');

const policy = (over = {}) => ({
  backdateDays: null, futureDays: null, loggableDays: [1, 2, 3, 4, 5],
  requirePreviousDay: false, ...over,
});

/* ---- the table the brief asks for -------------------------------------- */

test('isTimesheetDayOpen, over the whole table', () => {
  const rows = [
    // [label, policy, date, expected open, expected reason]
    ['no limits, a day in 2020', policy(), '2020-01-01', true, 'in_window'],
    ['no limits, a day in 2099', policy(), '2099-01-01', true, 'in_window'],
    ['N=1, today', policy({ backdateDays: 1, futureDays: 0 }), WED, true, 'in_window'],
    ['N=1, the previous day', policy({ backdateDays: 1, futureDays: 0 }), TUE, true, 'in_window'],
    ['N=1, two days back', policy({ backdateDays: 1, futureDays: 0 }), MON, false, 'too_old'],
    ['N=1, tomorrow', policy({ backdateDays: 1, futureDays: 0 }), THU, false, 'too_far_ahead'],
    ['N=0, today', policy({ backdateDays: 0, futureDays: 0 }), WED, true, 'in_window'],
    ['N=0, the previous day', policy({ backdateDays: 0, futureDays: 0 }), TUE, false, 'too_old'],
    ['N=14, two days back', policy({ backdateDays: 14, futureDays: 0 }), MON, true, 'in_window'],
    ['N=14, fifteen days back', policy({ backdateDays: 14 }), '2026-09-22', false, 'too_old'],
    ['N=14, exactly fourteen back', policy({ backdateDays: 14 }), '2026-09-23', true, 'in_window'],
    ['futureDays=1, tomorrow', policy({ futureDays: 1 }), THU, true, 'in_window'],
    ['futureDays=1, two ahead', policy({ futureDays: 1 }), '2026-10-09', false, 'too_far_ahead'],
    ['future allowed with a back window', policy({ backdateDays: 1 }), '2099-01-01', true, 'in_window'],
  ];
  for (const [label, p, date, open, reason] of rows) {
    const v = dayWindow.isTimesheetDayOpen({ policy: p, date, now: AT_WED });
    assert.strictEqual(v.open, open, `${label}: expected open=${open}, got ${v.open} (${v.reason})`);
    assert.strictEqual(v.reason, reason, `${label}: reason`);
  }

  /* A DATE THAT IS NOT A DATE IS NOT OPEN, and says so distinctly rather than
     being lumped in with a day that is merely too old. */
  const bad = dayWindow.isTimesheetDayOpen({ policy: policy(), date: 'yesterday', now: AT_WED });
  assert.strictEqual(bad.open, false);
  assert.strictEqual(bad.reason, 'bad_date');
});

test('the boundary is the studio\'s midnight, not the process\'s', () => {
  /* THE BUG THIS PREVENTS. The server runs in UTC and the studio is in India,
     so from 18:30 UTC "today" in the office is already tomorrow. A window
     computed from the process's calendar would close the studio's current day
     for five and a half hours every evening.

     18:29 UTC is 23:59 in the studio on the 7th; 18:31 UTC is 00:01 on the 8th.
     With a window of "today only", the SAME instant pair must give opposite
     answers for the 7th. */
  const justBefore = Date.parse('2026-10-07T18:29:00Z');
  const justAfter = Date.parse('2026-10-07T18:31:00Z');
  const p = policy({ backdateDays: 0, futureDays: 0 });

  const before = dayWindow.isTimesheetDayOpen({ policy: p, date: WED, now: justBefore });
  assert.strictEqual(before.open, true, 'at 23:59 in the studio, the 7th is still today');
  assert.strictEqual(before.window.today, WED);

  const after = dayWindow.isTimesheetDayOpen({ policy: p, date: WED, now: justAfter });
  assert.strictEqual(after.open, false, 'at 00:01 the 7th is yesterday, and the window is 0');
  assert.strictEqual(after.window.today, THU, 'and the studio\'s today has moved on');

  /* AND THE NEW DAY IS OPEN AT THAT SAME INSTANT, which is the half that makes
     it a boundary rather than just a refusal. */
  const nextDay = dayWindow.isTimesheetDayOpen({ policy: p, date: THU, now: justAfter });
  assert.strictEqual(nextDay.open, true);

  /* NO Date OBJECT AND NO LOCAL METHOD anywhere in the module: the date source
     is timesheet-gate, which every other dated feature already uses. */
  const src = fs.readFileSync(path.join(ROOT, 'src', 'timesheet-day-window.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['new Date(', 'getFullYear', 'getMonth', 'getDate', 'toLocale']) {
    assert.ok(!src.includes(forbidden), `the window never calls ${forbidden}`);
  }
  assert.match(src, /timesheetGate\.istDate\(now\)/, 'it asks the studio\'s own date source');
});

test('the three ways a closed day opens, and which one answered', () => {
  const tight = policy({ backdateDays: 0, futureDays: 0 });
  const shut = dayWindow.isTimesheetDayOpen({ policy: tight, date: TUE, now: AT_WED });
  assert.strictEqual(shut.open, false);

  /* THE KEY. */
  const keyed = dayWindow.isTimesheetDayOpen({
    policy: tight, date: TUE, now: AT_WED, backdateKey: true });
  assert.strictEqual(keyed.open, true);
  assert.strictEqual(keyed.reason, 'backdate_key');

  /* THE UNLOCK. */
  const unlocked = dayWindow.isTimesheetDayOpen({
    policy: tight, date: TUE, now: AT_WED, unlocked: true });
  assert.strictEqual(unlocked.open, true);
  assert.strictEqual(unlocked.reason, 'unlocked');

  /* THE CARVE-OUT, AND IT IS CHECKED FIRST. With the previous-day rule on, the
     gate's own owed day is always fillable — and for somebody holding nothing,
     which is what makes it not a privilege. The reason reported must be
     owed_day rather than one of the keys, because that is what an admin needs
     to read when a figure from a closed period looks wrong. */
  const gated = policy({ backdateDays: 0, futureDays: 0, requirePreviousDay: true });
  const owed = dayWindow.owedDay(gated, WED);
  assert.strictEqual(owed, TUE, 'Tuesday is the working day before that Wednesday');
  const carve = dayWindow.isTimesheetDayOpen({ policy: gated, date: owed, now: AT_WED });
  assert.strictEqual(carve.open, true, 'the owed day is fillable with no key at all');
  assert.strictEqual(carve.reason, 'owed_day');

  /* AND IT IS EXACTLY ONE DAY WIDE. The exemption is not a hole in the policy:
     the day before the owed day is still closed. */
  const older = dayWindow.isTimesheetDayOpen({ policy: gated, date: MON, now: AT_WED });
  assert.strictEqual(older.open, false);
  assert.strictEqual(older.reason, 'too_old');

  /* THE CARVE-OUT IS OFF WHEN THE RULE IS OFF, which is the other direction and
     the one a mutation would get wrong by always granting it. */
  assert.strictEqual(dayWindow.owedDay(policy({ backdateDays: 0 }), WED), null);
});

test('the refusal names the window, and keeps the sentences validateEntry had', () => {
  const tooOld = dayWindow.isTimesheetDayOpen({
    policy: policy({ backdateDays: 7 }), date: '2026-09-01', now: AT_WED });
  const body = dayWindow.refusal(tooOld, '2026-09-01');
  assert.strictEqual(body.code, 'TIMESHEET_DAY_LOCKED');
  /* THE WORDING IS THE OLD WORDING, verbatim. These sentences are on screens
     and in tests already; rewording a refusal while moving it between files
     would make the change impossible to review. */
  assert.match(body.error, /is 36 days ago, and the studio allows lines to be filed up to 7 days back/);
  assert.match(body.error, /Lines filed before this rule was set are unaffected/);
  /* AND THE WINDOW TRAVELS WITH IT, so a stale page can redraw from the answer
     rather than making another request to find out what it may do. */
  assert.strictEqual(body.today, WED);
  assert.strictEqual(body.openFrom, '2026-09-30');
  assert.strictEqual(body.openTo, null, 'no future limit set, so no upper bound');

  const ahead = dayWindow.refusal(dayWindow.isTimesheetDayOpen({
    policy: policy({ futureDays: 0 }), date: THU, now: AT_WED }), THU);
  assert.match(ahead.error, /is in the future, and the studio does not allow hours to be logged ahead of today/);
  const ahead2 = dayWindow.refusal(dayWindow.isTimesheetDayOpen({
    policy: policy({ futureDays: 2 }), date: '2026-10-12', now: AT_WED }), '2026-10-12');
  assert.match(ahead2.error, /is 5 days ahead, and the studio allows lines up to 2 days ahead/);
});

/* ---- one implementation, four routes, asserted against the source ------ */

test('there is one window check and all four routes ask it', () => {
  /* THE GAP THIS PROMPT CLOSED, pinned so it cannot reopen: every one of the
     four paths that changes a day must reach the window. Counted rather than
     merely present, because "the module is imported" is not the same as "the
     delete route uses it". */
  const calls = (ROUTE.match(/dayWindow\.openFor\(/g) || []).length;
  assert.ok(calls >= 4, `every route resolves the window: found ${calls} call sites`);
  for (const route of ['/entries', '/submit', '/unlock-day']) {
    assert.ok(ROUTE.includes(route), `the ${route} route is here`);
  }

  /* AND validateEntry NO LONGER OWNS A SECOND COPY. It delegates, so a rule the
     studio sets cannot be enforced on filing and skipped on deleting. */
  assert.match(SHEETS, /dayWindow\.isTimesheetDayOpen\(/,
    'validateEntry asks the shared function');
  const code = SHEETS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/policy\.backdateDays !== null/.test(code),
    'and holds no window arithmetic of its own');
  assert.ok(!/policy\.futureDays !== null/.test(code));
});

test('the page draws the server\'s answer and computes no window', () => {
  const block = PAGE.slice(PAGE.indexOf('const closed = Boolean(day.entryWindow'),
    PAGE.indexOf('return `<div class="ts-day${day.overLong'));
  assert.match(block, /day\.entryWindow\.open === false/, 'it reads `open`');
  /* NO COPY OF ANY OF THE FOUR INPUTS. A page that worked any of these out
     would be wrong the moment a key was granted or a day unlocked while the tab
     was open. */
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const tab = code.slice(code.indexOf('function renderTimesheet'),
    code.indexOf('function wireTimesheet'));
  for (const forbidden of ['backdateDays', 'futureDays', 'previousWorkingDay',
    'timesheet.backdate', 'istDate(']) {
    assert.ok(!tab.includes(forbidden), `the week does not consult ${forbidden}`);
  }
  /* AND THE 422 IS HANDLED IN THE PAGE, by the handler that already existed for
     the hours rule — the response is identical in every respect that matters:
     this tab is out of date, so say the server's sentence and refetch. */
  assert.match(PAGE, /body\.code === 'TIMESHEET_DAY_LOCKED'/);
});

/* ---- end to end --------------------------------------------------------- */

test('the entry window, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const people = {};
  let projectId;

  const call = (p, options) => api(server.base, p, options);
  const as = (who, p, options = {}) => call(p, { ...options, token: token[who] });
  const q = (statement, params) => sql(cfg, statement, params);

  const setPolicy = async (body) => {
    const res = await as('root', '/admin/settings/timesheet', { method: 'PUT', body });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };
  /* THE WHOLE POLICY EVERY TIME: the PUT replaces the row. */
  const base = (over = {}) => ({
    loggableDays: [1, 2, 3, 4, 5], minLineHours: 0.25, maxLineHours: 24,
    backdateDays: null, futureDays: null, requirePreviousDay: false,
    hoursRuleEnabled: false, hoursRuleFrom: null, ...over,
  });
  const line = (who, date, hours = 2) => as(who, '/timesheets/entries',
    { method: 'POST', body: { date, hours, nonProject: 'leave' } });
  const submit = (who, date) => as(who, '/timesheets/submit', { method: 'POST', body: { date } });
  const del = (who, id) => as(who, `/timesheets/entries/${id}`, { method: 'DELETE' });
  const patch = (who, id, body) => as(who, `/timesheets/entries/${id}`, { method: 'PATCH', body });
  const dayOf = async (who, date) => {
    const res = await as(who, `/timesheets/week?date=${date}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.days.find((d) => d.date === date);
  };
  const today = () => require('../src/timesheet-gate').istDate();
  const shift = (n) => require('../src/timesheet-gate').shiftDays(today(), n);
  const grant = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: [...new Set([...held, ...keys])] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const revoke = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: held.filter((k) => !keys.includes(k)) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'window-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'window-token', name: 'Root', email: 'root@dw.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@dw.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Day Window' } })).body.project.id;

    for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist'],
      ['lee', 'team_lead']]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@dw.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@dw.test`);
    }
    await setPolicy(base());
  });

  t.after(() => stopServer(server));

  await t.test('with no window everything is open, exactly as before', async () => {
    const old = await line('ana', '2026-01-07');
    assert.strictEqual(old.status, 201, JSON.stringify(old.body));
    const day = await dayOf('ana', '2026-01-07');
    assert.strictEqual(day.entryWindow.open, true);
    assert.strictEqual(day.entryWindow.reason, 'in_window');
    await del('ana', old.body.entry.id);
  });

  await t.test('all four routes refuse a closed day, with the code', async () => {
    /* THE WHOLE POINT OF PART B. Before this prompt the first two refused and
       the last two did not look at the date at all. */
    const twoBack = shift(-2);
    const made = await line('ana', twoBack);
    assert.strictEqual(made.status, 201, 'filed while the window is open');
    const entryId = made.body.entry.id;

    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      const create = await line('ana', twoBack);
      assert.strictEqual(create.status, 422, JSON.stringify(create.body));
      assert.strictEqual(create.body.code, 'TIMESHEET_DAY_LOCKED');

      const edit = await patch('ana', entryId, { hours: 3 });
      assert.strictEqual(edit.status, 422, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.code, 'TIMESHEET_DAY_LOCKED');

      /* DELETE: new enforcement. A closed period must not be able to lose hours
         any more than it can gain them — a reconciled month whose lines can
         still be deleted is not reconciled. */
      const removed = await del('ana', entryId);
      assert.strictEqual(removed.status, 422, JSON.stringify(removed.body));
      assert.strictEqual(removed.body.code, 'TIMESHEET_DAY_LOCKED');
      const still = await q('SELECT id FROM timesheet_entries WHERE id = ?', [entryId]);
      assert.strictEqual(still.length, 1, 'and the line is still there');

      /* SUBMIT: new enforcement too. */
      const filed = await submit('ana', twoBack);
      assert.strictEqual(filed.status, 422, JSON.stringify(filed.body));
      assert.strictEqual(filed.body.code, 'TIMESHEET_DAY_LOCKED');
      assert.strictEqual((await dayOf('ana', twoBack)).status, 'draft', 'not submitted');

      /* THE FUTURE IS CLOSED THE SAME WAY. */
      const ahead = await line('ana', shift(1));
      assert.strictEqual(ahead.status, 422, JSON.stringify(ahead.body));
      assert.strictEqual(ahead.body.code, 'TIMESHEET_DAY_LOCKED');

      /* AND TODAY AND YESTERDAY STILL WORK, which is the other half: a window
         that closed everything would pass every assertion above. */
      const now = await line('ana', today());
      assert.strictEqual(now.status, 201, JSON.stringify(now.body));
      const yday = await line('ana', shift(-1));
      assert.strictEqual(yday.status, 201, JSON.stringify(yday.body));
      await del('ana', now.body.entry.id);
      await del('ana', yday.body.entry.id);
    } finally {
      await setPolicy(base());
      await q('DELETE FROM timesheet_entries WHERE id = ?', [entryId]).catch(() => {});
    }
  });

  await t.test('an edit may not move a line OFF a closed day either', async () => {
    /* THE HOLE A NAIVE CHECK LEAVES: validate only the destination and somebody
       empties a closed Tuesday by moving its lines to today. */
    const twoBack = shift(-2);
    const made = await line('ana', twoBack);
    assert.strictEqual(made.status, 201);
    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      const moved = await patch('ana', made.body.entry.id, { date: today() });
      assert.strictEqual(moved.status, 422, JSON.stringify(moved.body));
      assert.strictEqual(moved.body.code, 'TIMESHEET_DAY_LOCKED');
      const where = await q('SELECT entry_date FROM timesheet_entries WHERE id = ?',
        [made.body.entry.id]);
      assert.strictEqual(require('../src/timesheets').toISO(where[0].entry_date), twoBack,
        'the line did not move');
    } finally {
      await setPolicy(base());
      await q('DELETE FROM timesheet_entries WHERE id = ?', [made.body.entry.id]).catch(() => {});
    }
  });

  await t.test('timesheet.backdate ignores the window on all four routes', async () => {
    const twoBack = shift(-2);
    await grant('game_artist', ['timesheet.backdate']);
    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      const made = await line('bo', twoBack);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      const edited = await patch('bo', made.body.entry.id, { hours: 3 });
      assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
      const filed = await submit('bo', twoBack);
      assert.strictEqual(filed.status, 200, JSON.stringify(filed.body));
      /* AND THE WEEK SAYS SO, so the page draws a day the holder may type into. */
      assert.strictEqual((await dayOf('bo', twoBack)).entryWindow.reason, 'backdate_key');

      /* THE KEY MOVES THE DATE AND NOTHING ELSE: a Saturday is still refused,
         because that is a different setting with a different answer. */
      const sat = await line('bo', '2026-10-10');
      assert.strictEqual(sat.status, 400, JSON.stringify(sat.body));
      assert.match(sat.body.error, /nothing can be logged on a Saturday/);
    } finally {
      await setPolicy(base());
      await revoke('game_artist', ['timesheet.backdate']);
      await q('DELETE FROM timesheet_days WHERE user_id = ? AND work_date = ?',
        [people.bo, twoBack]).catch(() => {});
      await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?',
        [people.bo, twoBack]).catch(() => {});
    }
  });

  await t.test('an unlock opens one day, and submitting closes it', async () => {
    const twoBack = shift(-2);
    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      assert.strictEqual((await line('lee', twoBack)).status, 422, 'closed to start with');

      const opened = await as('root', '/timesheets/unlock-day',
        { method: 'POST', body: { userId: people.lee, date: twoBack } });
      assert.strictEqual(opened.status, 200, JSON.stringify(opened.body));
      assert.strictEqual(opened.body.opened, true);

      /* AND THE DAY IS NOW FILLABLE BY ITS OWNER, who holds no key. */
      const made = await line('lee', twoBack);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.strictEqual((await dayOf('lee', twoBack)).entryWindow.reason, 'unlocked');

      /* PRESSING IT TWICE IS A 200 AND NOT A CONFLICT. */
      const again = await as('root', '/timesheets/unlock-day',
        { method: 'POST', body: { userId: people.lee, date: twoBack } });
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      assert.strictEqual(again.body.already, true);

      /* SUBMITTING CLOSES IT, which is the whole of its lifetime. */
      assert.strictEqual((await submit('lee', twoBack)).status, 200);
      const live = await q(
        'SELECT closed_at FROM timesheet_day_unlocks WHERE user_id = ? AND `date` = ?',
        [people.lee, twoBack]);
      assert.ok(live.length >= 1, 'the rows are kept as a record');
      assert.ok(live.every((r) => r.closed_at), 'and every one of them is closed');

      /* SO THE DAY IS SHUT AGAIN. Reopening it is the owner's business and the
         day is locked anyway, but the WINDOW must no longer be the thing
         allowing it. */
      assert.strictEqual((await dayOf('lee', twoBack)).entryWindow.open, false);
    } finally {
      await setPolicy(base());
    }
  });

  await t.test('unlocking needs the key and the visibility', async () => {
    const twoBack = shift(-3);
    /* NO KEY: 403 from requirePermission. */
    const refused = await as('ana', '/timesheets/unlock-day',
      { method: 'POST', body: { userId: people.bo, date: twoBack } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    /* THE KEY WITHOUT THE VISIBILITY: still refused, and with its own code, so
       holding the key does not widen whose timesheet anybody may reach. An
       artist can see only their own, so bo is out of scope for ana. */
    await grant('game_artist', ['timesheet.unlock_day']);
    try {
      const scoped = await as('ana', '/timesheets/unlock-day',
        { method: 'POST', body: { userId: people.bo, date: twoBack } });
      assert.strictEqual(scoped.status, 403, JSON.stringify(scoped.body));
      assert.strictEqual(scoped.body.code, 'out_of_scope');
      const none = await q(
        'SELECT id FROM timesheet_day_unlocks WHERE user_id = ? AND `date` = ?',
        [people.bo, twoBack]);
      assert.strictEqual(none.length, 0, 'and nothing was written');
    } finally {
      await revoke('game_artist', ['timesheet.unlock_day']);
    }
  });

  await t.test('a day already inside the window needs no unlock, and says so', async () => {
    const res = await as('root', '/timesheets/unlock-day',
      { method: 'POST', body: { userId: people.ana, date: today() } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.opened, false);
    assert.strictEqual(res.body.reason, 'in_window');
    const none = await q(
      'SELECT id FROM timesheet_day_unlocks WHERE user_id = ? AND `date` = ?',
      [people.ana, today()]);
    assert.strictEqual(none.length, 0, 'no row for a day that was never shut');
  });

  await t.test('the carve-out still holds, and only for its one day', async () => {
    /* THE PRE-EXISTING RULE, unchanged: with the previous-day gate on, the day
       it is asking for is fillable however tight the window is — for somebody
       holding nothing. */
    const gate = require('../src/timesheet-gate');
    const owed = gate.previousWorkingDay(today(), { loggableDays: [1, 2, 3, 4, 5] });
    await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?',
      [people.ana, owed]).catch(() => {});
    await setPolicy(base({ backdateDays: 0, futureDays: 0, requirePreviousDay: true }));
    try {
      const made = await line('ana', owed);
      assert.strictEqual(made.status, 201,
        `the owed day is fillable despite a window of 0: ${JSON.stringify(made.body)}`);
      assert.strictEqual((await dayOf('ana', owed)).entryWindow.reason, 'owed_day');

      /* AND THE DAY BEFORE IT IS NOT. One day wide, not a hole in the policy. */
      const older = gate.previousWorkingDay(owed, { loggableDays: [1, 2, 3, 4, 5] });
      const refused = await line('ana', older);
      assert.strictEqual(refused.status, 422, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.code, 'TIMESHEET_DAY_LOCKED');

      /* THE CARVE-OUT ALSO COVERS SUBMITTING IT, which it has to: a rule that
         let somebody fill the owed day but not file it would still be demanding
         the impossible. */
      assert.strictEqual((await submit('ana', owed)).status, 200);
    } finally {
      await setPolicy(base());
    }
  });

  await t.test('the week payload carries the window, per day', async () => {
    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      const res = await as('ana', `/timesheets/week?date=${today()}`);
      assert.strictEqual(res.status, 200);
      for (const day of res.body.days) {
        assert.ok(day.entryWindow, `${day.date} carries a window verdict`);
        assert.strictEqual(typeof day.entryWindow.open, 'boolean');
        if (!day.entryWindow.open) {
          assert.ok(day.entryWindow.closedMessage,
            `${day.date} says why it is closed, in the server's words`);
        }
      }
      const open = res.body.days.filter((d) => d.entryWindow.open).map((d) => d.date);
      assert.deepStrictEqual(open.sort(), [shift(-1), today()].sort(),
        'exactly today and the previous day are open');
    } finally {
      await setPolicy(base());
    }
  });

  await t.test('somebody else\'s week is not told it is open', async () => {
    /* A LEAD READING AN ARTIST'S WEEK. The week is read-only for everybody but
       its owner, so the window verdict there is information rather than
       permission — and it must not claim to be open, which would draw write
       controls on a sheet nobody may type into. */
    await grant('team_lead', ['timesheet.team']);
    try {
      const res = await as('lee', `/timesheets/week?date=${today()}&userId=${people.ana}`);
      if (res.status === 200 && res.body.days) {
        assert.strictEqual(res.body.mayEdit, false, 'read-only, as it has always been');
        for (const day of res.body.days) {
          assert.strictEqual(day.entryWindow.open, false);
          assert.strictEqual(day.entryWindow.reason, 'not_yours');
        }
      }
    } finally {
      await revoke('team_lead', ['timesheet.team']);
    }
  });

  await t.test('the two keys are Super Admin only by default', async () => {
    for (const key of ['timesheet.backdate', 'timesheet.unlock_day']) {
      for (const role of ['game_artist', 'team_lead', 'art_director']) {
        const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
          .filter((p) => p.enabled).map((p) => p.key);
        assert.ok(!held.includes(key), `${role} does not hold ${key} by default`);
      }
      const su = (await as('root', '/permissions/roles/super_admin')).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      assert.ok(su.includes(key), `the Super Admin holds ${key}`);
    }
  });

  await t.test('opening a day is in the Activity Log', async () => {
    const twoBack = shift(-4);
    await setPolicy(base({ backdateDays: 1, futureDays: 0 }));
    try {
      const opened = await as('root', '/timesheets/unlock-day',
        { method: 'POST', body: { userId: people.ana, date: twoBack } });
      assert.strictEqual(opened.status, 200, JSON.stringify(opened.body));
      const rows = await q(
        `SELECT action, summary FROM activity_log
          WHERE action = 'day_unlocked' ORDER BY created_at DESC LIMIT 1`);
      assert.strictEqual(rows.length, 1, 'the unlock is logged');
      assert.match(rows[0].summary, new RegExp(twoBack), 'naming the day');
      assert.match(rows[0].summary, /ana/, 'and whose it is');
    } finally {
      await setPolicy(base());
    }
  });
});
