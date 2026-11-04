/* PART C OF PROMPT 65: THE MY HISTORY TAB.
 *
 * ===========================================================================
 * WHAT THESE TESTS ARE REALLY GUARDING.
 *
 * History is a read-only screen built entirely from data other screens already
 * own, and that makes two failure modes much more likely than an outright bug:
 *
 *   1. IT QUIETLY DISAGREES. If a card computed its own counted time, its own
 *      required hours or its own lock state, it would be right today and wrong
 *      the first time a setting moved — and because nothing would error, the
 *      disagreement would be discovered by somebody reconciling a month. So
 *      several tests here assert the card's numbers against the SAME modules the
 *      Timesheet tab and the Artist Report read, rather than against constants.
 *
 *   2. IT SHOWS SOMEBODY ELSE'S DAY. A history card is a fuller picture of a
 *      person's working day than a timesheet is, so the scope tests are not
 *      ceremony: without the key, with the key but out of scope, and the
 *      deliberate sameness of those two refusals.
 *
 * THE ATTRIBUTION RULE gets its own tests because it is the one place this
 * feature had to choose, and the choice is invisible in the output: an event
 * attributed by current assignment would look identical on screen and be wrong
 * about last month.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const HISTORY = fs.readFileSync(path.join(ROOT, 'src', 'history.js'), 'utf8');

const historySettings = require('../src/history-settings');
const dayStatus = require('../src/day-status');

const cfg = config('history');
const PASSWORD = 'History-Test-1!';

/* ---- the settings, as pure values -------------------------------------- */

test('the three history settings: defaults and ranges', () => {
  /* THE TAB SHIPS ON. The rule this codebase has settled on: anything that
     STOPS somebody doing what they could do yesterday ships off (the
     exact-hours rule, the entry window, requirePreviousDay); anything that only
     SHOWS somebody something ships on. History shows, refuses nothing, and
     changes no figure. */
  assert.strictEqual(historySettings.DEFAULTS.enabled, true);
  assert.strictEqual(historySettings.DEFAULTS.defaultDays, 30);
  assert.strictEqual(historySettings.DEFAULTS.submitFromHistory, true);
  assert.strictEqual(historySettings.MIN_DAYS, 7);
  assert.strictEqual(historySettings.MAX_DAYS, 366);

  const base = { ...historySettings.DEFAULTS };
  for (const [value, ok] of [[7, true], [30, true], [366, true],
    [6, false], [367, false], [0, false], [-1, false], [30.5, false]]) {
    const v = historySettings.validate({ defaultDays: value }, { existing: base });
    assert.strictEqual(v.ok, ok, `defaultDays ${value} should be ${ok ? 'taken' : 'refused'}`);
    if (!ok) assert.match(v.errors[0].message, /between 7 and 366|whole number/);
  }
  /* AN ABSENT FIELD KEEPS ITS VALUE rather than reverting to the default, which
     is what makes a form that sends two of three fields safe. */
  const partial = historySettings.validate({ enabled: false },
    { existing: { ...base, defaultDays: 90 } });
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.value.defaultDays, 90);
  assert.strictEqual(partial.value.enabled, false);

  const line = historySettings.summarise({ ...base, enabled: false });
  assert.match(line, /History tab OFF/);
});

test('the range is clamped, never inverted, and never wider than the ceiling', () => {
  const history = require('../src/history');
  const now = Date.parse('2026-11-04T06:00:00+05:30');
  const today = '2026-11-04';

  const plain = history.rangeFor({ now });
  assert.strictEqual(plain.to, today);
  assert.strictEqual(plain.from, '2026-10-06', '30 days back, inclusive of today');

  /* A `from` AFTER A `to` IS A TYPO, not a request for nothing. */
  const inverted = history.rangeFor({ from: '2026-11-01', to: '2026-10-01', now });
  assert.ok(inverted.from <= inverted.to, `${inverted.from} .. ${inverted.to}`);

  /* AND NOTHING WIDER THAN THE CEILING, however the dates arrive — not for
     secrecy but because the query would be the slowest thing in the
     application and nobody reads card nine hundred. */
  const huge = history.rangeFor({ from: '1990-01-01', now });
  const span = (Date.parse(`${huge.to}T00:00:00Z`) - Date.parse(`${huge.from}T00:00:00Z`))
    / 86400000;
  assert.ok(span <= historySettings.MAX_DAYS, `clamped to ${span} days`);

  /* A FUTURE `to` IS TODAY. There is no history of tomorrow. */
  const ahead = history.rangeFor({ to: '2099-01-01', now });
  assert.strictEqual(ahead.to, today);
});

/* ---- the attribution rule, read off the source ------------------------- */

test('an event is attributed by actor, routing or a session — never by current assignment',
  () => {
    /* THE CHOICE THIS FEATURE HAD TO MAKE, and the one that is invisible in the
       output: asset_events records an ACTOR and there is no assignment history,
       so "who was assigned at the time" cannot be reconstructed. Attributing by
       CURRENT assignment would put last month's feedback on the wrong person's
       history, silently and retrospectively, and would look identical on screen.

       So the three limbs are asserted against the source, and the thing that
       must NOT be there is asserted too. */
    const code = HISTORY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /e\.actor_id = \$3/, 'the actor');
    assert.match(code, /e\.routed_to_id = \$3/, 'the person it was routed to');
    assert.match(code, /FROM work_sessions w WHERE w\.user_id = \$3/,
      'and somebody who recorded time on that asset');
    for (const forbidden of ['assignee_id', 'a.assignee', 'current_assignee']) {
      assert.ok(!code.includes(forbidden),
        `attribution never reads ${forbidden}: current assignment is not evidence about the past`);
    }
    /* AND THE THIRD LIMB IS NARROWED TO THE DAY. The SQL widens to any asset
       this person ever touched — one subquery beats one query per day — and the
       rule is "that asset on THAT day", so the narrowing has to happen. */
    assert.match(code, /workedAssetsByDay\.get\(row\.day\)/,
      'the session limb is checked per day, not per asset');
  });

test('the page draws the payload and computes nothing', () => {
  /* ANCHORED ON THE CODE, NOT ON THE HEADING. The same "---------- My History
     ----------" heading appears in the stylesheet, and indexOf found THAT
     first — so the slice ran from the CSS through the whole page markup and
     picked up the Add line form, failing on `tl_save` for a reason that had
     nothing to do with History. `const HIST = {` occurs once. */
  const block = PAGE.slice(PAGE.indexOf('const HIST = {'),
    PAGE.indexOf('/* ---------- the exact-hours rule ---'));
  assert.ok(block.length > 2000, 'found the History block');
  assert.ok(block.length < 40000, 'and only the History block');

  /* NOT ONE OF THE FOUR THINGS THE SERVER DECIDES. A card that worked out
     counted time, required hours, the window or the lock would be right today
     and wrong the first time a setting moved — and nothing would error. */
  for (const forbidden of ['maxDayHours', 'backdateDays', 'futureDays', 'loggableDays',
    'RECORDED_SECONDS', 'countedSeconds', 'isLocked(', 'istDate(',
    'timesheet.min_hours_exempt', 'hoursRuleEnabled']) {
    assert.ok(!block.includes(forbidden), `the History block does not consult ${forbidden}`);
  }
  /* IT READS THE SERVER'S OWN DECISIONS instead. */
  assert.match(block, /t\.maySubmit/, 'whether the button may be drawn is the server\'s');
  assert.match(block, /w\.label/, 'and the recorded figure is the server\'s label');
  assert.match(block, /card\.entryWindow/, 'and the window is the server\'s');

  /* NO LINE EDITING. A history is a record, and a record you can type into is a
     draft; the card sends somebody to the Timesheet tab instead. */
  for (const forbidden of ["method:'PATCH'", "method:'DELETE'", 'tl_save', 'openTimesheetLine(']) {
    assert.ok(!block.includes(forbidden), `History never edits a line (${forbidden})`);
  }
  assert.match(block, /setTab\('timesheet'\)/, 'it opens the day in the Timesheet tab');

  /* AND SUBMITTING GOES THROUGH THE SAME ROUTE, with no arguments of its own —
     a second door, never a second rule. */
  assert.match(block, /api\('\/timesheets\/submit', \{ method:'POST', body:\{ date: b\.dataset\.day \} \}\)/,
    'the same submit route the Timesheet tab calls');

  /* NO NATIVE DIALOGS. */
  for (const native of ['alert(', 'confirm(', 'prompt(']) {
    assert.ok(!block.includes(native), `no ${native} in the History block`);
  }
});

test('the tab is drawn from the key AND the switch', () => {
  assert.match(PAGE, /historyTabBtn:\s+\(\) => can\('history\.view'\) && state\.historyEnabled !== false/);
  /* NEVER A ROLE TIER. The tab is a permission question and nothing else. */
  const gate = PAGE.slice(PAGE.indexOf('historyTabBtn:'), PAGE.indexOf('historyTabBtn:') + 200);
  for (const forbidden of ['caps(', 'role ===', 'super_admin']) {
    assert.ok(!gate.includes(forbidden), `the tab gate does not read ${forbidden}`);
  }
  /* THE LABEL IS EXACTLY "My History", which the brief asked for by name. */
  assert.match(PAGE, /id="historyTabBtn"[^>]*>My History</);
});

/* ---- end to end --------------------------------------------------------- */

test('My History, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const people = {};
  let projectId;
  let clientId;
  const asset = {};

  const call = (p, options) => api(server.base, p, options);
  const as = (who, p, options = {}) => call(p, { ...options, token: token[who] });
  const q = (statement, params) => sql(cfg, statement, params);
  const today = () => require('../src/timesheet-gate').istDate();
  const shift = (n) => require('../src/timesheet-gate').shiftDays(today(), n);

  const setHistory = async (body) => {
    const res = await as('root', '/admin/settings/history', { method: 'PUT', body });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };
  const histBody = (over = {}) => ({
    enabled: true, defaultDays: 30, submitFromHistory: true, ...over });
  const setTimesheet = async (body) => {
    const res = await as('root', '/admin/settings/timesheet', { method: 'PUT', body });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.settings;
  };
  const tsBody = (over = {}) => ({
    loggableDays: [1, 2, 3, 4, 5, 6, 7], minLineHours: 0.25, maxLineHours: 24,
    backdateDays: null, futureDays: null, requirePreviousDay: false,
    hoursRuleEnabled: false, hoursRuleFrom: null, ...over });
  const historyOf = async (who, query = '') => {
    const res = await as(who, `/history${query}`);
    return res;
  };
  const cardFor = (body, date) => (body.days || []).find((d) => d.date === date);
  const mark = (who, date, kind, portion = null, extra = {}) =>
    as('root', '/admin-dashboard/follow-up/day-status',
      { method: 'POST', body: { userId: people[who], date, kind, portion, ...extra } });
  const unmark = (who, date) => as('root', '/admin-dashboard/follow-up/day-status/clear',
    { method: 'POST', body: { userId: people[who], date, reason: 'history test' } });
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
      BOOTSTRAP_TOKEN: 'history-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'history-token', name: 'Root', email: 'root@hist.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@hist.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'History Project' } })).body.project.id;

    for (const [who, role] of [['ana', 'game_artist'], ['bo', 'game_artist'],
      ['lee', 'team_lead']]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@hist.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@hist.test`);
    }
    /* THE PEOPLE EXISTED BEFORE TODAY, and without this the suite cannot test
       a past day at all.
     *
     * src/history.js suppresses days before somebody's account was made — which
     * is right, because a card saying "nothing recorded" for a Tuesday before
     * they were hired is noise that hides the real empty days. In a fresh test
     * database every account is made THIS SECOND, so every past day was being
     * skipped and three tests below were quietly asserting against an empty
     * list. Backdating the accounts is the fixture telling the truth about a
     * studio: the people were there last month. */
    await q('UPDATE users SET created_at = DATE_SUB(NOW(), INTERVAL 400 DAY) WHERE id IN (?, ?, ?)',
      [people.ana, people.bo, people.lee]);

    /* EVERY DAY LOGGABLE, so the suite's fixed dates are never a weekly off —
       a history test that passed or failed by the day of the week it ran on
       would be useless. */
    await setTimesheet(tsBody());
    await setHistory(histBody());

    const made = await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name: 'History Asset', type: 'character', assigneeId: people.ana } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    asset.id = made.body.asset.id;
    asset.code = made.body.asset.code;
  });

  t.after(() => stopServer(server));

  await t.test('a worked day: the asset, its client, project, discipline and time',
    async () => {
      assert.strictEqual((await as('ana', `/assets/${asset.id}/start`,
        { method: 'POST', body: {} })).status, 200);
      /* BACKDATED AND CLOSED IN SQL, because there is no route that records an
         hour of the past, and the alternative is a test that waits an hour. */
      await q(
        `UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL 90 MINUTE),
            ended_at = NOW(), seconds = 5400, ended_reason = 'submit'
          WHERE user_id = ? AND ended_at IS NULL`, [people.ana]);

      const res = await historyOf('ana');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const card = cardFor(res.body, today());
      assert.ok(card, 'today has a card');
      assert.strictEqual(card.chip.kind, 'worked');
      const worked = card.workedOn.find((w) => w.assetId === asset.id);
      assert.ok(worked, 'the asset is on the card');
      assert.strictEqual(worked.code, asset.code);
      assert.strictEqual(worked.projectName, 'History Project');
      assert.ok(worked.clientName, 'with its client');
      assert.strictEqual(worked.discipline, 'character');
      /* THE FIGURE AND ITS LABEL ARE THE SERVER'S, and the label is the same
         formatter every other duration in the application uses. */
      assert.strictEqual(worked.seconds, 5400);
      assert.strictEqual(worked.label, dayStatus.durationLabel(5400));
      assert.strictEqual(worked.label, '1 h 30 m');
    });

  await t.test('the recorded figure equals what the shared helper says', async () => {
    /* THE DISAGREEMENT THIS PREVENTS. If History summed sessions its own way it
       would be right today and wrong the first time the counted-time expression
       changed — so the card's figure is asserted against work-log's own answer
       for the same asset and person. */
    const workLog = require('../src/work-log');
    const handle = {
      async query(text, params = []) {
        const values = [];
        const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
          values.push(params[Number(n) - 1]);
          return '?';
        });
        const rows = await sql(cfg, translated, values.length ? values : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      },
    };
    const theirs = await workLog.recordedFor(handle, { assetId: asset.id, userId: people.ana });
    const res = await historyOf('ana');
    const card = cardFor(res.body, today());
    const worked = card.workedOn.find((w) => w.assetId === asset.id);
    assert.strictEqual(worked.seconds, theirs.seconds,
      'the card and work-log agree about the same work');
  });

  await t.test('the timesheet block: lines, total against required, and the state',
    async () => {
      const made = await as('ana', '/timesheets/entries', { method: 'POST',
        body: { date: today(), hours: 3, nonProject: 'leave', notes: 'a note' } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));

      const res = await historyOf('ana');
      const card = cardFor(res.body, today());
      assert.strictEqual(card.timesheet.lines.length, 1);
      assert.strictEqual(card.timesheet.lines[0].hours, 3);
      assert.strictEqual(card.timesheet.lines[0].notes, 'a note');
      assert.strictEqual(card.timesheet.status, 'draft');
      assert.strictEqual(card.timesheet.locked, false);
      assert.strictEqual(card.timesheet.logged, 300, 'in centihours, from the rule module');

      /* AND THE CATEGORY LABELS TRAVEL WITH IT, so a renamed category relabels
         every historical line rather than the page keeping its own words. */
      assert.ok(Array.isArray(res.body.nonProjectTypes) && res.body.nonProjectTypes.length,
        'the reference list is sent');
    });

  await t.test('submitting from History uses the same route and the same rules',
    async () => {
      /* WITH THE EXACT-HOURS RULE ON, a 3h day is short — and History must
         refuse it with the same sentence the Timesheet tab shows, because it is
         the same route. */
      await setTimesheet(tsBody({ maxDayHours: 8, hoursRuleEnabled: true,
        hoursRuleFrom: shift(-30) }));
      try {
        let res = await historyOf('ana');
        let card = cardFor(res.body, today());
        assert.strictEqual(card.timesheet.ruleApplies, true);
        assert.strictEqual(card.timesheet.canSubmit, false, '3h of 8h');
        assert.strictEqual(card.timesheet.maySubmit, false,
          'so the button may not be drawn');
        assert.match(card.timesheet.reason, /Log 5h more/);

        const refused = await as('ana', '/timesheets/submit',
          { method: 'POST', body: { date: today() } });
        assert.strictEqual(refused.status, 422, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.code, 'HOURS_BELOW_MINIMUM');

        /* FILL IT AND THE BUTTON BECOMES AVAILABLE — the same arithmetic, in
           the same module, reported on the card. */
        assert.strictEqual((await as('ana', '/timesheets/entries', { method: 'POST',
          body: { date: today(), hours: 5, nonProject: 'leave' } })).status, 201);
        res = await historyOf('ana');
        card = cardFor(res.body, today());
        assert.strictEqual(card.timesheet.canSubmit, true);
        assert.strictEqual(card.timesheet.maySubmit, true);

        assert.strictEqual((await as('ana', '/timesheets/submit',
          { method: 'POST', body: { date: today() } })).status, 200);
        res = await historyOf('ana');
        card = cardFor(res.body, today());
        assert.strictEqual(card.timesheet.status, 'submitted');
        assert.strictEqual(card.timesheet.locked, true);
        assert.ok(card.timesheet.submittedAt, 'with the time it was filed');
        assert.strictEqual(card.timesheet.maySubmit, false, 'and no button on a filed day');
      } finally {
        await setTimesheet(tsBody());
      }
    });

  await t.test('the submit-from-History switch removes the button and nothing else',
    async () => {
      await setHistory(histBody({ submitFromHistory: false }));
      try {
        const res = await historyOf('bo');
        /* bo has no lines today, so take any card and assert the FIELD rather
           than hunting for a submittable day: with the switch off, maySubmit is
           false everywhere by construction. */
        for (const card of res.body.days) {
          assert.strictEqual(card.timesheet.maySubmit, false);
        }
        assert.strictEqual(res.body.settings.submitFromHistory, false);
        /* AND THE ROUTE STILL WORKS, because the switch is about a button and
           not about submitting: taking the door away must not take the room. */
        assert.strictEqual((await as('bo', '/timesheets/entries', { method: 'POST',
          body: { date: today(), hours: 2, nonProject: 'leave' } })).status, 201);
        assert.strictEqual((await as('bo', '/timesheets/submit',
          { method: 'POST', body: { date: today() } })).status, 200);
      } finally {
        await setHistory(histBody());
      }
    });

  await t.test('every kind of day gets the right chip', async () => {
    /* IDLE IS TODAY-ONLY, which the route enforces ("Idle can only be marked
       for today") and which is right: Idle is a statement about a desk that is
       empty NOW. So it is tested on today while the others take past days —
       and lee has nothing else today, so nothing collides. */
    const cases = [
      [shift(-3), 'leave', 'full', 'leave'],
      [shift(-4), 'leave', 'first_half', 'leave_half'],
      [today(), 'idle', null, 'idle'],
      [shift(-6), 'onsight', null, 'onsight'],
    ];
    for (const [date, kind, portion, expected] of cases) {
      const marked = await mark('lee', date, kind, portion,
        kind === 'onsight' ? { clientId } : {});
      assert.strictEqual(marked.status, 200, `${kind}: ${JSON.stringify(marked.body)}`);
    }
    try {
      const res = await historyOf('lee');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      for (const [date, kind, , expected] of cases) {
        const card = cardFor(res.body, date);
        assert.ok(card, `${date} (${kind}) has a card, because the status is the fact`);
        assert.strictEqual(card.chip.kind, expected, `${date} is ${expected}`);
      }
      /* A HALF DAY'S LEAVE SAYS WHICH HALF, which is the fact somebody is
         looking for when they open their own history. */
      assert.match(cardFor(res.body, shift(-4)).chip.label, /1st half/);
    } finally {
      for (const [date] of cases) await unmark('lee', date);
    }
  });

  await t.test('a vacation day is named a vacation, not just leave', async () => {
    /* IT IS A LEAVE ROW WITH source 'planned' — that is the whole design of
       src/vacation.js — and to the person reading their own history those are
       different facts about their week. */
    const from = shift(2);
    const booked = await as('lee', '/leave/mine',
      { method: 'POST', body: { from, to: from } });
    assert.strictEqual(booked.status, 201, JSON.stringify(booked.body));
    try {
      const res = await historyOf('lee', `?from=${from}&to=${from}`);
      const card = cardFor(res.body, from);
      /* A FUTURE DAY IS NOT HISTORY, so the range is clamped to today and the
         card is absent — which is itself the assertion. */
      assert.ok(!card, 'tomorrow is not history');

      /* SO MARK A PAST DAY AS PLANNED LEAVE INSTEAD, which is what a vacation
         looks like once it has happened. */
      const past = shift(-7);
      await q(
        `INSERT INTO user_day_status (id, user_id, \`date\`, kind, \`portion\`, source, set_by)
         VALUES (UUID(), ?, ?, 'leave', 'full', 'planned', ?)`,
        [people.lee, past, people.root]);
      const res2 = await historyOf('lee');
      const card2 = cardFor(res2.body, past);
      assert.ok(card2, 'the past vacation day has a card');
      assert.strictEqual(card2.chip.kind, 'vacation');
      assert.strictEqual(card2.chip.label, 'Vacation');
      await q('DELETE FROM user_day_status WHERE user_id = ? AND `date` = ?',
        [people.lee, past]);
    } finally {
      await as('lee', `/leave/${booked.body.request.id}/cancel`, { method: 'POST', body: {} })
        .catch(() => {});
    }
  });

  await t.test('days with nothing at all are not drawn', async () => {
    /* THE BRIEF'S RULE: no empty days, except the statuses that matter. bo's
       history should hold only the days bo actually did something on. */
    const res = await historyOf('bo');
    assert.strictEqual(res.status, 200);
    for (const card of res.body.days) {
      const something = card.workedOn.length || card.otherEvents.length
        || card.timesheet.lines.length || card.timesheet.status !== 'none'
        || ['leave', 'leave_half', 'vacation', 'holiday', 'weekly_off', 'idle', 'onsight']
          .includes(card.chip.kind);
      assert.ok(something, `${card.date} is drawn because something is on it`);
    }
  });

  await t.test('the empty state is said out loud', async () => {
    /* A RANGE BEFORE ANYBODY EXISTED. The payload says `empty` rather than
       leaving the page to infer it from a zero length, so the screen can draw
       an honest sentence. */
    const res = await historyOf('bo', '?from=2020-01-01&to=2020-01-31');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.empty, true);
    assert.deepStrictEqual(res.body.days, []);
  });

  await t.test('days before somebody existed are never drawn', async () => {
    const res = await historyOf('bo', '?days=366');
    const earliest = res.body.days.map((d) => d.date).sort()[0];
    const made = await q('SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL 330 MINUTE), '
      + "'%Y-%m-%d') AS d FROM users WHERE id = ?", [people.bo]);
    if (earliest) {
      assert.ok(earliest >= made[0].d,
        `nothing before ${made[0].d}, the day the account was made; got ${earliest}`);
    }
  });

  /* ---- authorisation --------------------------------------------------- */

  await t.test('your own history needs only the key every role has', async () => {
    const res = await historyOf('ana');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.mine, true);
    /* AND THE SELECTOR OFFERS ONLY YOURSELF without the second key — the honest
       answer, not a filtered version of a longer list. */
    const people1 = await as('ana', '/history/people');
    assert.strictEqual(people1.status, 200);
    assert.strictEqual(people1.body.users.length, 1);
    assert.strictEqual(people1.body.users[0].id, people.ana);
  });

  await t.test('somebody else\'s history needs the key, and then the scope', async () => {
    /* NO KEY: refused. */
    const noKey = await historyOf('ana', `?userId=${people.bo}`);
    assert.strictEqual(noKey.status, 403, JSON.stringify(noKey.body));
    assert.strictEqual(noKey.body.code, 'not_yours');

    /* THE KEY WITHOUT THE SCOPE: also refused, and the two refusals are
       deliberately the same shape — a narrow holder must not be able to tell
       "that person exists but is not yours" from "you may not do this at all",
       because the difference is itself a disclosure. */
    await grant('game_artist', ['history.view_others']);
    try {
      const scoped = await historyOf('ana', `?userId=${people.bo}`);
      assert.strictEqual(scoped.status, 403, JSON.stringify(scoped.body));
      assert.strictEqual(scoped.body.code, 'out_of_scope');
      /* AND THE SELECTOR STILL OFFERS ONLY THE PEOPLE THEY MAY SEE — which for
         an artist is themselves, so the key adds a selector and not people. */
      const list = await as('ana', '/history/people');
      assert.deepStrictEqual(list.body.users.map((u) => u.id), [people.ana]);
    } finally {
      await revoke('game_artist', ['history.view_others']);
    }
  });

  await t.test('with the key and the scope, somebody else\'s history reads', async () => {
    /* A SUPER ADMIN HOLDS BOTH BY DEFAULT and sees the studio, which is the
       scope timesheet.all already grants — the key did not widen it. */
    const res = await historyOf('root', `?userId=${people.ana}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.user.id, people.ana);
    assert.strictEqual(res.body.user.mine, false);
    /* AND maySubmit IS FALSE ON SOMEBODY ELSE'S DAY, always: a day is its
       owner's statement, and nothing here lets anybody file it for them. */
    for (const card of res.body.days) {
      assert.strictEqual(card.timesheet.maySubmit, false,
        `${card.date}: nobody submits somebody else's day`);
    }

    /* ON A DAY THAT WOULD OTHERWISE BE SUBMITTABLE, which is the whole point
       and which this test did not do until a mutation proved it.
     *
     * maySubmit also needs the day open, unsubmitted, satisfying the rule and
     * carrying lines — and in this fixture the viewed person's days happened to
     * be either already submitted or empty, so maySubmit was false INCIDENTALLY
     * and the ownership check was never the thing making it false. Removing
     * that check escaped every assertion above.
     *
     * So: build the day that ticks every other box. lee has a fresh day with
     * lines, nothing submitted, the hours rule off — their own history offers
     * the button, and the same day on somebody else's screen does not. The pair
     * is what pins ownership rather than one of its neighbours. */
    const day = shift(-11);
    assert.strictEqual((await as('lee', '/timesheets/entries', { method: 'POST',
      body: { date: day, hours: 2, nonProject: 'leave' } })).status, 201);

    const theirs = await historyOf('lee');
    const own = cardFor(theirs.body, day);
    assert.ok(own, 'the day has a card on its owner\'s history');
    assert.strictEqual(own.timesheet.maySubmit, true,
      'and its owner is offered the button, so every other condition is met');

    const watched = await historyOf('root', `?userId=${people.lee}`);
    const seen = cardFor(watched.body, day);
    assert.ok(seen, 'the same day is on the admin\'s view of it');
    assert.strictEqual(seen.timesheet.canSubmit, true,
      'the rule is satisfied, so nothing but ownership is in the way');
    assert.strictEqual(seen.timesheet.maySubmit, false,
      'and ownership is what stops it: a day is its owner\'s statement');
  });

  await t.test('the switch hides the tab and refuses the endpoint', async () => {
    await setHistory(histBody({ enabled: false }));
    try {
      const res = await historyOf('ana');
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'feature_disabled');
      const list = await as('ana', '/history/people');
      assert.strictEqual(list.status, 409);
      /* AND /auth/me SAYS SO, which is what takes the tab off the strip. */
      const me = await as('ana', '/auth/me');
      assert.strictEqual(me.body.historyEnabled, false);
    } finally {
      await setHistory(histBody());
      assert.strictEqual((await as('ana', '/auth/me')).body.historyEnabled, true);
    }
  });

  await t.test('the two keys and their defaults', async () => {
    /* history.view REACHES EVERY ROLE, mirroring timesheet.own — which is what
       "every role that can use the Timesheet today" means in this catalogue, and
       anything narrower would hide somebody's own week from them. */
    for (const role of ['game_artist', 'team_lead', 'art_director', 'super_admin']) {
      const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      assert.ok(held.includes('history.view'), `${role} can read its own history`);
      if (role !== 'super_admin') {
        assert.ok(!held.includes('history.view_others'),
          `${role} cannot read anybody else's by default`);
      }
    }
    const su = (await as('root', '/permissions/roles/super_admin')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(su.includes('history.view_others'));
  });

  await t.test('the settings change is audit-logged', async () => {
    await setHistory(histBody({ defaultDays: 60 }));
    try {
      /* MATCHED, NOT ORDERED. activity_log.created_at is accurate to the second
         and this suite writes several settings changes inside one second, so
         "the latest row" is a coin toss between them — the first version of
         this test read a neighbouring test's row and failed on it. Asking
         whether the row EXISTS is both stabler and the actual assertion. */
      const rows = await q(
        `SELECT summary FROM activity_log WHERE action = 'history_updated'`);
      assert.ok(rows.length >= 1, 'the change is logged');
      assert.ok(rows.some((r) => /60 day/.test(r.summary)),
        `one of them names the new figure: ${JSON.stringify(rows.map((r) => r.summary))}`);
    } finally {
      await setHistory(histBody());
    }
  });

  await t.test('a closed day shows its window state, and an unlock shows on the card',
    async () => {
      const old = shift(-9);
      assert.strictEqual((await as('ana', '/timesheets/entries', { method: 'POST',
        body: { date: old, hours: 1, nonProject: 'leave' } })).status, 201);
      await setTimesheet(tsBody({ backdateDays: 1, futureDays: 0 }));
      try {
        let res = await historyOf('ana');
        let card = cardFor(res.body, old);
        assert.ok(card, 'the day is still readable');
        assert.strictEqual(card.entryWindow.open, false);
        assert.ok(card.entryWindow.closedMessage, 'and says why, in the server\'s words');
        assert.strictEqual(card.timesheet.maySubmit, false, 'and offers no button');

        /* OPENED, AND THE CARD SAYS SO. */
        assert.strictEqual((await as('root', '/timesheets/unlock-day', { method: 'POST',
          body: { userId: people.ana, date: old } })).status, 200);
        res = await historyOf('ana');
        card = cardFor(res.body, old);
        assert.strictEqual(card.entryWindow.open, true);
        assert.strictEqual(card.entryWindow.unlocked, true);
        assert.strictEqual(card.entryWindow.reason, 'unlocked');
      } finally {
        await setTimesheet(tsBody());
      }
    });
});
