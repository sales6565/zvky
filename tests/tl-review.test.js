/* TL ACTION: the sessions, the hours they are worth, and who may file them.
 *
 * WHAT THIS SUITE IS ABOUT, in one line: the figure on a lead's line is the
 * time between the moment they opened a submission and the moment they decided
 * it, inside working hours — and nothing else in the studio moves because they
 * filed it.
 *
 * THE PURE CASES FIRST, with no server, because the arithmetic is the part most
 * worth being able to read: a table of spans against the hours they come to.
 * Then the live ones, which are about who is allowed to do what.
 *
 * FIXED STAMPS EVERYWHERE. Every session below is written with explicit times,
 * so nothing depends on the hour the suite runs; openStudio() opens the clock
 * around the clock so a fixture at 10:00 IST is not clipped by the shipped
 * lunch hour and the figures here are about the spans rather than the schedule.
 * The cases that are ABOUT the schedule set their own.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, openStudio,
  SKIP_REASON } = require('./helpers');
const tlReview = require('../src/tl-review');
const dayStatus = require('../src/day-status');

const cfg = config('tlrev');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Tl-Review-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// The arithmetic, with no server.
// ---------------------------------------------------------------------------

const OFFICE = { workingDays: [1, 2, 3, 4, 5], dayStart: 9 * 60, dayEnd: 18 * 60,
  breaks: [{ start: 13 * 60, end: 14 * 60 }] };
const ist = (text) => Date.parse(`${text}+05:30`);
const hours = (from, to, opts = {}) => Math.round(
  (dayStatus.countedMsByDay(ist(from), ist(to), { schedule: OFFICE, ...opts })
    .byDay.get(opts.day || from.slice(0, 10)) || 0) / 3600000 * 100) / 100;

test('what a review span is worth, day by day', () => {
  /* THE SAME FUNCTION THE MODULE USES, called the same way, so this table is
     the module's own arithmetic and not a second opinion about it — see the
     structural case at the end of this file, which fails if src/tl-review.js
     ever starts doing the sum itself. */
  const cases = [
    // [what it is, from, to, expected hours on the day named, options]
    ['inside one morning', '2026-03-05T10:00:00', '2026-03-05T11:30:00', 1.5],
    ['across the lunch hour', '2026-03-05T12:30:00', '2026-03-05T14:30:00', 1],
    ['the whole working day', '2026-03-05T09:00:00', '2026-03-05T18:00:00', 8],
    ['starting before the day opens', '2026-03-05T07:00:00', '2026-03-05T10:00:00', 1],
    ['ending after it closes', '2026-03-05T17:00:00', '2026-03-05T21:00:00', 1],
    ['entirely outside the hours', '2026-03-05T19:00:00', '2026-03-05T22:00:00', 0],
    ['entirely inside the lunch hour', '2026-03-05T13:10:00', '2026-03-05T13:50:00', 0],
  ];
  for (const [what, from, to, want] of cases) {
    assert.strictEqual(hours(from, to), want, `${what}: ${from} → ${to}`);
  }
});

test('a review that runs overnight is split, and the night is worth nothing', () => {
  /* Thursday 17:00 to Friday 10:00. The office shuts at 18:00 and opens at
     09:00, so this is one hour on Thursday and one on Friday — and NOT the
     seventeen hours the wall clock says. */
  const from = '2026-03-05T17:00:00';
  const to = '2026-03-06T10:00:00';
  assert.strictEqual(hours(from, to, { day: '2026-03-05' }), 1, 'Thursday evening');
  assert.strictEqual(hours(from, to, { day: '2026-03-06' }), 1, 'Friday morning');
});

test('a review left open over a weekend is worth only the working days it touches', () => {
  // Friday 17:00 to Monday 10:00. Saturday and Sunday are not working days.
  const from = '2026-03-06T17:00:00';
  const to = '2026-03-09T10:00:00';
  assert.strictEqual(hours(from, to, { day: '2026-03-06' }), 1, 'Friday evening');
  assert.strictEqual(hours(from, to, { day: '2026-03-07' }), 0, 'Saturday');
  assert.strictEqual(hours(from, to, { day: '2026-03-08' }), 0, 'Sunday');
  assert.strictEqual(hours(from, to, { day: '2026-03-09' }), 1, 'Monday morning');
});

test('a holiday is a day with no spans, so a review spanning one gains nothing from it', () => {
  const shut = { ...OFFICE, holidays: ['2026-03-06'] };
  const from = ist('2026-03-05T17:00:00');
  const to = ist('2026-03-09T10:00:00');
  const byDay = dayStatus.countedMsByDay(from, to, { schedule: shut }).byDay;
  assert.strictEqual(Math.round((byDay.get('2026-03-05') || 0) / 3600000), 1, 'Thursday evening');
  assert.strictEqual(byDay.get('2026-03-06') || 0, 0, 'the holiday is worth nothing');
});

test('leave is subtracted from a review, half a day and a whole one', () => {
  const day = '2026-03-05';
  const from = '2026-03-05T09:00:00';
  const to = '2026-03-05T18:00:00';
  assert.strictEqual(hours(from, to), 8, 'the whole day, with no leave');

  /* HALF A DAY, as a window — the shape windowsFromRow() produces for a
     half-day leave row, which is what the live path hands in. */
  const morningOff = [{ from: ist('2026-03-05T00:00:00'), to: ist('2026-03-05T13:00:00') }];
  assert.strictEqual(hours(from, to, { windows: morningOff }), 4, 'the morning off');

  const allDay = [{ from: ist('2026-03-05T00:00:00'), to: ist('2026-03-06T00:00:00') }];
  assert.strictEqual(hours(from, to, { windows: allDay }), 0, 'the whole day off');
});

test('the module does its arithmetic nowhere but the shared helper', () => {
  /* STRUCTURAL, and it is the point of the pure cases above. The table is only
     evidence about src/tl-review.js if the module actually goes through
     countedMsByDay — a second walk of its own could pass every case here while
     disagreeing with the Time Sheet over every lunch hour. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tl-review.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  assert.match(code, /dayStatus[\s\n]*\.countedMsByDay\(/,
    'the hours go through the one function that decides what a working minute is');
  assert.match(code, /dayStatus[\s\n]*\.windowsForSpan\(/, 'and the leave windows are fetched for it');

  /* NO SECOND DEFINITION OF A WORKING DAY, asserted as what the code DOES
     rather than as words it must not contain — dayStart and dayEnd are
     midnight boundaries here, the same two locals work-log's dayTotalFor has,
     and banning the words would ban the right code along with the wrong.
     
     What a hand-rolled intersection actually needs is the schedule's own
     fields and the lower-level walk, so those are what this forbids. */
  assert.ok(!/require\(['"]\.\/working-time['"]\)/.test(code),
    'the low-level walk is day-status\'s to call, not this module\'s');
  const reads = [...code.matchAll(/\bschedule\.(\w+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(reads)], [],
    'the schedule is passed through untouched — reading a field off it starts a second opinion');
  for (const smell of ['workingDays', 'isWeekend', 'isWorkingDay', 'lunch', 'spansOn']) {
    assert.ok(!code.includes(smell),
      `${smell} is a working-time concept — src/tl-review.js must not have its own opinion of one`);
  }
});

test('which action means which outcome, and what an unknown one means', () => {
  assert.strictEqual(tlReview.outcomeFor('tl_approve'), 'approved');
  assert.strictEqual(tlReview.outcomeFor('tl_request_changes'), 'changes_requested');
  /* EVERY OTHER EXIT IS 'other' RATHER THAN A GUESS. A reassignment, an
     administrator's correction, a transition added next year: the review
     happened and the time is still the lead's, but it was not a decision. */
  for (const action of ['reassign_review', 'override', 'recall', 'something_new', undefined, null]) {
    assert.strictEqual(tlReview.outcomeFor(action), 'other', `${action} is not a decision`);
  }
});

test('the two line kinds, and the one label function', () => {
  assert.deepStrictEqual(tlReview.ACTION_KEYS, ['project_meeting', 'asset_review']);
  assert.strictEqual(tlReview.labelFor('project_meeting'), 'TL · Project Meeting');
  assert.strictEqual(tlReview.labelFor('asset_review'), 'TL · Asset Review');
  assert.strictEqual(tlReview.labelFor(null), null, 'an ordinary line has no TL label');
  assert.strictEqual(tlReview.labelFor('something_else'), null);
  for (const bad of ['', null, undefined, 'review', 'PROJECT_MEETING']) {
    assert.strictEqual(tlReview.isAction(bad), false, `${bad} is not a kind of TL Action`);
  }
});

test('the label is spelt in one place, and the page and the exports read it', () => {
  /* The screen, the audit trail and both exports all print this phrase. Spelt
     twice, they drift — which is how the export came to disagree with the
     screen about the second dropdown once already. */
  const root = path.join(__dirname, '..');
  const spellings = ['src', 'public'].flatMap(function walk(dir) {
    const full = path.join(root, dir);
    return fs.readdirSync(full, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  }).filter((f) => /\.(js|html)$/.test(f))
    .filter((f) => f !== 'src/tl-review.js')
    .filter((f) => /TL · (Project Meeting|Asset Review)/.test(
      fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(spellings, [],
    'the label belongs to src/tl-review.js — everything else calls labelFor()');
});

// ---------------------------------------------------------------------------
// Live: the sessions, the list, the save, and the isolation.
// ---------------------------------------------------------------------------

test('TL Action, end to end', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;

  /* A submitted asset: created, assigned, started and submitted, so it is in
     pending_tl_review the way a real one gets there rather than by an UPDATE. */
  const submitted = async (name, projectKey = 'alpha') => {
    const made = await as('root', `/assets/project/${id[projectKey]}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: id.ana, manHours: 20 } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const assetId = made.body.asset.id;
    const started = await as('ana', `/assets/${assetId}/start`, { method: 'POST', body: {} });
    assert.ok(started.status < 400, JSON.stringify(started.body));
    const sent = await as('ana', `/assets/${assetId}/submit`, { method: 'POST',
      body: { link: `/mnt/shared/submissions/${name}` } });
    assert.ok(sent.status < 400, JSON.stringify(sent.body));
    const row = (await sql(cfg, 'SELECT `status` FROM assets WHERE id = ?', [assetId]))[0];
    assert.strictEqual(row.status, 'pending_tl_review', `${name} is in TL review`);
    return assetId;
  };

  const copy = (who, assetId) => as(who, `/assets/${assetId}/tl-review/start`, { method: 'POST', body: {} });
  const sessionsOn = (assetId) => sql(cfg,
    'SELECT * FROM tl_review_sessions WHERE asset_id = ? ORDER BY started_at', [assetId]);
  /* A session written with explicit stamps, for the cases about hours. In the
     database's own clock, like every other fixture in this project: 04:30 UTC
     is 10:00 IST. */
  const session = (assetId, leadId, from, to, outcome = 'approved') => sql(cfg,
    `INSERT INTO tl_review_sessions (id, asset_id, project_id, lead_user_id, started_at, ended_at,
       ended_by_user_id, outcome)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
    [assetId, id.alpha, leadId, from, to, leadId, outcome]);
  const list = async (who, projectKey, date) => as(who,
    `/timesheets/tl-review/assets?projectId=${id[projectKey]}&date=${date}`);
  const file = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlrev-token', WORK_HOURS_SWEEP_MINUTES: '0',
      EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tlrev-token', name: 'Root', email: 'root@tlrev.test', password: PASSWORD } });
    tok.root = await login('root@tlrev.test');
    id.root = (await api(server.base, '/auth/me', { token: tok.root })).body.user.id;
    await openStudio(server.base, tok.root);

    const make = async (key, name, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name, email: `${key}@tlrev.test`, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      tok[key] = await login(`${key}@tlrev.test`);
    };
    await make('lead', 'Lee Lead', 'team_lead');
    await make('other', 'Ola Other', 'team_lead');     // a lead, of another project
    await make('acting', 'Ash Acting', 'game_artist'); // an ACTING lead of alpha
    await make('ana', 'Ana Artist', 'game_artist');

    id.client = await systemClientId(server.base, tok.root);
    const mkProject = async (key, name, body) => {
      const r = await as('root', '/projects', { method: 'POST',
        body: { name, clientId: id.client, ...body } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('alpha', 'Alpha', { teamLeadIds: [id.lead], actingTeamLeadIds: [id.acting] });
    await mkProject('beta', 'Beta', { teamLeadIds: [id.other] });
    for (const who of ['ana', 'acting']) {
      await as('root', `/users/${id[who]}`, { method: 'PATCH', body: { projectId: id.alpha } });
    }
    /* Every day a case files on has to be one the studio logs hours for; opened
       to all seven so a fixture on a Saturday is about the feature rather than
       about the loggable-days rule. */
    const options = (await as('root', '/admin/settings/timesheet')).body.settings;
    const saved = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...options, loggableDays: [1, 2, 3, 4, 5, 6, 7] } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    /* THE KEY GRANTED TO game_artist, which is Ash's designation AND Ana's.
     
       This is the fixture that makes the membership check testable at all. Ash
       is an Acting Team Lead of Alpha and Ana is on it as an artist; they hold
       the same key and the same role, and the only thing that differs is the
       membership. Every case below that says "the acting lead counts and the
       artist does not" is therefore about isProjectLead() and nothing else —
       if the check read a role tier, the two would behave identically. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const granted = await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'timesheet.tl_action'])] } });
    assert.ok(granted.status < 400, JSON.stringify(granted.body));
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the permission defaults to the roles that lead a team, and nobody else', async () => {
    const catalog = require('../src/permission-catalog');
    const roles = require('../src/roles');
    assert.ok(catalog.isPermission('timesheet.tl_action'), 'it is in the catalogue');
    assert.ok(catalog.grantableKeys().includes('timesheet.tl_action'), 'and can be granted');

    const holders = roles.roleKeys()
      .filter((k) => catalog.baselineFor(roles.capabilitiesFor(k)).has('timesheet.tl_action'));
    assert.ok(holders.includes('super_admin'), 'the Super Admin holds it');
    assert.ok(holders.includes('team_lead'), 'and so does a Team Lead');
    assert.ok(!holders.includes('game_artist'), 'an artist does not');
    assert.ok(!holders.includes('admin'), 'and neither does an Admin, who leads no team');
    /* EVERY HOLDER LEADS A TEAM, which is the rule rather than a list — a role
       added later with leadsTeam gets it, and one without does not. */
    for (const key of holders) {
      const caps = roles.capabilitiesFor(key);
      assert.ok(caps.leadsTeam || caps.managePermissions,
        `${key} holds it, so it either leads a team or is the Super Admin tier`);
    }
    // And the README says so, where a Super Admin looks before granting it.
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.match(readme, /`timesheet\.tl_action`/, 'the README lists the key');
  });

  await t.test('Copy by a lead opens one session, and a second Copy does not reset it', async () => {
    const assetId = await submitted('Copy Once');
    const first = await copy('lead', assetId);
    assert.strictEqual(first.status, 204, 'the copy endpoint never answers with a body');
    let rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 1, 'one session');
    assert.strictEqual(rows[0].lead_user_id, id.lead, 'and it is the clicker\'s');
    assert.strictEqual(rows[0].ended_at, null, 'still open');
    const startedAt = String(rows[0].started_at);

    /* A LEAD WHO GOES BACK TO THE PATH IS NOT STARTING AGAIN. Two more clicks,
       and the start stays where the first one put it. */
    await copy('lead', assetId);
    await copy('lead', assetId);
    rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 1, 'still one session');
    assert.strictEqual(String(rows[0].started_at), startedAt, 'and it still starts where it did');
  });

  await t.test('the stamp is the database\'s, whatever the caller says', async () => {
    const assetId = await submitted('Server Clock');
    /* A client claiming an hour ago. The body is ignored entirely — the INSERT
       uses NOW() — so the session starts now, not when the browser says. */
    await as('lead', `/assets/${assetId}/tl-review/start`, { method: 'POST',
      body: { startedAt: '2020-01-01 00:00:00', started_at: '2020-01-01 00:00:00' } });
    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 1);
    const age = (await sql(cfg,
      'SELECT TIMESTAMPDIFF(SECOND, started_at, NOW()) AS age FROM tl_review_sessions WHERE id = ?',
      [rows[0].id]))[0].age;
    assert.ok(Number(age) < 120,
      `the session started just now, not in 2020 — age ${age}s`);
  });

  await t.test('two leads reading the same submission get a session each', async () => {
    const assetId = await submitted('Two Readers');
    await copy('lead', assetId);
    await copy('acting', assetId);
    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 2, 'one each');
    assert.deepStrictEqual(rows.map((r) => r.lead_user_id).sort(), [id.lead, id.acting].sort());
  });

  await t.test('an Acting Team Lead counts as a lead; an artist and another project\'s lead do not', async () => {
    const assetId = await submitted('Who Counts');
    /* ASH AND ANA SHARE A DESIGNATION AND A KEY (see the fixture). The only
       difference between them is that Ash is an Acting Team Lead of Alpha, so
       anything that tells them apart is the membership check and not the role
       — which is the whole reason it asks permissions.isProjectLead(). */
    const acting = await copy('acting', assetId);
    assert.strictEqual(acting.status, 204);
    assert.strictEqual((await sessionsOn(assetId)).length, 1, 'the acting lead gets a session');

    /* Ana holds the same key by the same designation, and leads nothing. */
    const artist = await copy('ana', assetId);
    assert.strictEqual(artist.status, 204, 'and her copy still works');
    assert.strictEqual((await sessionsOn(assetId)).length, 1, 'but records nothing');

    // A lead of Beta is a lead of nothing here.
    const elsewhere = await copy('other', assetId);
    assert.strictEqual(elsewhere.status, 204);
    assert.strictEqual((await sessionsOn(assetId)).length, 1, 'another project\'s lead records nothing');
  });

  await t.test('a path copied off an asset that is not in review records nothing', async () => {
    const made = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name: 'Not In Review', type: 'prop', assigneeId: id.ana, manHours: 5 } });
    const assetId = made.body.asset.id;
    const r = await copy('lead', assetId);
    assert.strictEqual(r.status, 204, 'the copy works');
    assert.strictEqual((await sessionsOn(assetId)).length, 0,
      'but fetching a file is not a review');
  });

  await t.test('TL Approved closes every open session, with the outcome and the clicker kept', async () => {
    const assetId = await submitted('Approve Me');
    await copy('lead', assetId);
    await copy('acting', assetId);

    /* DECIDED BY THE ACTING LEAD. Both sessions close, and each stays credited
       to whoever clicked Copy — the clicker did the reading. */
    const decided = await as('acting', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'Good' } });
    assert.ok(decided.status < 400, JSON.stringify(decided.body));

    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.ended_at, 'closed');
      assert.strictEqual(row.outcome, 'approved');
      assert.strictEqual(row.ended_by_user_id, id.acting, 'the decider is recorded as the ender');
    }
    assert.deepStrictEqual(rows.map((r) => r.lead_user_id).sort(), [id.lead, id.acting].sort(),
      'and the sessions are still the clickers\'');
  });

  await t.test('Request Changes closes them too, with its own outcome', async () => {
    const assetId = await submitted('Send It Back');
    await copy('lead', assetId);
    const sent = await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'changes_requested', text: 'The rig is wrong' } });
    assert.ok(sent.status < 400, JSON.stringify(sent.body));
    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].ended_at);
    assert.strictEqual(rows[0].outcome, 'changes_requested');
  });

  await t.test('any other way out of TL Review closes them, as "other"', async () => {
    const assetId = await submitted('Taken Away');
    await copy('lead', assetId);
    /* AN ADMINISTRATOR MOVING IT BY HAND, which is the path that does NOT go
       through applyTransition — the one route that writes a status itself. If
       only the transition were wired, this session would stay open for ever. */
    const moved = await as('root', `/assets/${assetId}`, { method: 'PATCH',
      body: { status: 'in_progress' } });
    assert.ok(moved.status < 400, JSON.stringify(moved.body));
    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].ended_at, 'closed even though nobody decided anything');
    assert.strictEqual(rows[0].outcome, 'other');
  });

  await t.test('a resubmitted round needs a fresh Copy, and leaves the old session alone', async () => {
    const assetId = await submitted('Round Two');
    await copy('lead', assetId);
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'changes_requested', text: 'again' } });
    const firstRound = await sessionsOn(assetId);
    assert.strictEqual(firstRound.length, 1);
    const firstId = firstRound[0].id;
    const closedAt = String(firstRound[0].ended_at);

    // Back to the artist, reworked, resubmitted.
    await as('ana', `/assets/${assetId}/start`, { method: 'POST', body: {} }).catch(() => {});
    const again = await as('ana', `/assets/${assetId}/submit`, { method: 'POST',
      body: { link: '/mnt/shared/submissions/round-two-v2' } });
    assert.ok(again.status < 400, JSON.stringify(again.body));

    /* NO CLICK, NO SESSION. The asset is back in TL Review, and the lead has
       nothing open until they go and look at it. */
    assert.strictEqual((await sessionsOn(assetId)).length, 1, 'still just the first round\'s');

    await copy('lead', assetId);
    const rows = await sessionsOn(assetId);
    assert.strictEqual(rows.length, 2, 'the second round opens its own');
    /* BY ID, not by position. Both stamps are DATETIMEs, which have one-second
       resolution, so two sessions opened in the same second sort either way —
       a positional assertion here would be a flake waiting for a fast machine. */
    const was = rows.find((r) => r.id === firstId);
    const now = rows.find((r) => r.id !== firstId);
    assert.strictEqual(String(was.ended_at), closedAt, 'and the first is untouched');
    assert.strictEqual(now.ended_at, null, 'while the new one is open');
  });

  await t.test('the two groups: ready to log, and still in review', async () => {
    const day = '2026-03-05';
    const ready = await submitted('Ready One');
    await as('lead', `/assets/${ready}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(ready, id.lead, '2026-03-05 04:30:00', '2026-03-05 06:00:00');

    const open = await submitted('Open One');
    await copy('lead', open);

    const r = await list('lead', 'alpha', day);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const readyNames = r.body.ready.map((x) => x.name);
    assert.ok(readyNames.includes('Ready One'), `ready: ${readyNames.join(', ')}`);
    assert.strictEqual(r.body.ready.find((x) => x.name === 'Ready One').hours, 1.5,
      'with the hours the sessions come to on that day');

    const waiting = r.body.inReview.map((x) => x.name);
    assert.ok(waiting.includes('Open One'), `in review: ${waiting.join(', ')}`);
    assert.strictEqual(r.body.inReview.find((x) => x.name === 'Open One').hours, null,
      'an unfinished review offers no figure');
    assert.match(r.body.inReview.find((x) => x.name === 'Open One').reason,
      /Request Changes or TL Approved/);
    assert.ok(!readyNames.includes('Open One'), 'and it is not in the ready group');
  });

  await t.test('an open session is worth nothing, even on an asset that has left review', async () => {
    /* The asset moved on, but this lead never decided — somebody else did, and
       their own session was opened and closed. An open row contributes zero,
       which is the module's rule, so this asset gives the lead no hours. */
    const assetId = await submitted('Never Finished');
    await sql(cfg,
      `INSERT INTO tl_review_sessions (id, asset_id, project_id, lead_user_id, started_at)
       VALUES (UUID(), ?, ?, ?, '2026-03-05 04:30:00')`,
      [assetId, id.alpha, id.lead]);
    await as('root', `/assets/${assetId}`, { method: 'PATCH', body: { status: 'in_progress' } });
    /* Reopened by hand so the row is open again, which is the state being
       tested: the close above would otherwise have ended it. */
    await sql(cfg, 'UPDATE tl_review_sessions SET ended_at = NULL, outcome = NULL WHERE asset_id = ?',
      [assetId]);
    const hoursNow = await require('../src/tl-review').hoursFor(
      { query: (text, params) => sql(cfg, text.replace(/\$(\d+)/g, '?'), params)
        .then((rows) => ({ rows: Array.isArray(rows) ? rows : [], result: rows })) },
      { leadUserId: id.lead, assetId, day: '2026-03-05' });
    assert.strictEqual(hoursNow, 0, 'an open review is worth nothing');
  });

  await t.test('several sessions on one day are summed; another day is its own', async () => {
    const assetId = await submitted('Two Sittings');
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(assetId, id.lead, '2026-03-10 04:30:00', '2026-03-10 05:30:00');  // 1h
    await session(assetId, id.lead, '2026-03-10 07:00:00', '2026-03-10 07:30:00');  // 0.5h
    await session(assetId, id.lead, '2026-03-11 04:30:00', '2026-03-11 05:00:00');  // another day

    const tenth = await list('lead', 'alpha', '2026-03-10');
    assert.strictEqual(tenth.body.ready.find((x) => x.name === 'Two Sittings').hours, 1.5,
      'both sittings on the tenth');
    const eleventh = await list('lead', 'alpha', '2026-03-11');
    assert.strictEqual(eleventh.body.ready.find((x) => x.name === 'Two Sittings').hours, 0.5,
      'and the eleventh is its own day');
  });

  await t.test('a lead of another project is refused the list, and an artist has no key', async () => {
    const mine = await list('other', 'alpha', '2026-03-05');
    assert.strictEqual(mine.status, 403, JSON.stringify(mine.body));
    const artist = await list('ana', 'alpha', '2026-03-05');
    assert.strictEqual(artist.status, 403, 'without the permission there is no list at all');
  });

  await t.test('filing a project meeting: typed hours, no asset', async () => {
    const r = await file('lead', { date: '2026-03-12', hours: 1.5, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting', notes: 'Sprint planning' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.entry.hours), 1.5, 'the typed figure is kept');
    assert.strictEqual(r.body.entry.tlAction, 'project_meeting');
    assert.strictEqual(r.body.entry.tlActionLabel, 'TL · Project Meeting');

    const withAsset = await file('lead', { date: '2026-03-12', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId: (await sessionsOn((await submitted('Meeting Asset'))))
        && (await sql(cfg, 'SELECT id FROM assets WHERE `name` = ?', ['Meeting Asset']))[0].id,
      tlAction: 'project_meeting' });
    assert.strictEqual(withAsset.status, 400, JSON.stringify(withAsset.body));
    assert.match(withAsset.body.error, /not logged against an asset/);
  });

  await t.test('filing an asset review: the hours are the server\'s and the client\'s are ignored', async () => {
    const assetId = await submitted('Filed Review');
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(assetId, id.lead, '2026-03-13 04:30:00', '2026-03-13 06:00:00');   // 1.5h

    const r = await file('lead', { date: '2026-03-13', hours: 99, clientId: id.client,
      projectId: id.alpha, assetId, tlAction: 'asset_review' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.entry.hours), 1.5,
      'the sessions decide, not the request — 99 was ignored');
    assert.strictEqual(r.body.entry.tlActionLabel, 'TL · Asset Review');

    /* ONE PER LEAD PER ASSET PER DAY. The hours are the whole of that day's
       reviewing, so a second line would file the same minutes twice. */
    const again = await file('lead', { date: '2026-03-13', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId, tlAction: 'asset_review' });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.match(again.body.error, /already logged/);

    // And it leaves the ready list, because it is filed.
    const after = await list('lead', 'alpha', '2026-03-13');
    assert.ok(!after.body.ready.some((x) => x.assetId === assetId),
      'a filed review is not offered again');
  });

  await t.test('an unfinished review, a foreign asset and a zero day are each refused', async () => {
    const open = await submitted('Still Open');
    await copy('lead', open);
    const unfinished = await file('lead', { date: '2026-03-14', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId: open, tlAction: 'asset_review' });
    assert.strictEqual(unfinished.status, 409, JSON.stringify(unfinished.body));
    assert.match(unfinished.body.error, /not finished/);

    /* An asset on Beta, filed against Alpha. Refused on the project before the
       lead check even matters. */
    const beta = (await as('root', `/assets/project/${id.beta}`, { method: 'POST',
      body: { name: 'Beta Thing', type: 'prop', manHours: 2 } })).body.asset.id;
    const wrong = await file('lead', { date: '2026-03-14', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId: beta, tlAction: 'asset_review' });
    assert.strictEqual(wrong.status, 400, JSON.stringify(wrong.body));
    assert.match(wrong.body.error, /not on the project you chose/);

    // A finished review with no working minutes on the day asked for.
    const nothing = await submitted('Nothing That Day');
    await as('lead', `/assets/${nothing}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(nothing, id.lead, '2026-03-15 04:30:00', '2026-03-15 05:00:00');
    const zero = await file('lead', { date: '2026-03-16', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId: nothing, tlAction: 'asset_review' });
    assert.strictEqual(zero.status, 400, JSON.stringify(zero.body));
    assert.match(zero.body.error, /nothing to log/);
  });

  await t.test('a non-lead is refused the save, key or no key', async () => {
    /* ANA HOLDS THE KEY and leads nothing, which is the case the brief names:
       "permission without lead membership is refused". */
    const r = await file('ana', { date: '2026-03-17', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /do not lead that project/, 'the key is not the membership');

    /* AND WITHOUT THE KEY IT IS THE KEY. Taken away for this one check and put
       straight back, so the rest of the suite keeps the fixture it was built
       on. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: held.filter((k) => k !== 'timesheet.tl_action') } });
    const keyless = await file('ana', { date: '2026-03-17', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(keyless.status, 403, JSON.stringify(keyless.body));
    assert.match(keyless.body.error, /permission/, 'without the key it is the key');
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: held } });

    /* WITH THE KEY AND WITHOUT THE MEMBERSHIP. The lead of Beta holds
       timesheet.tl_action by designation and leads nothing on Alpha. */
    const elsewhere = await file('other', { date: '2026-03-17', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(elsewhere.status, 403, JSON.stringify(elsewhere.body));
    assert.match(elsewhere.body.error, /do not lead that project/);
  });

  await t.test('TL Action is project work: a non-project category cannot carry one', async () => {
    const r = await file('lead', { date: '2026-03-18', hours: 1, nonProject: 'leave',
      tlAction: 'project_meeting' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /project work/);
    const bogus = await file('lead', { date: '2026-03-18', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'something_else' });
    assert.strictEqual(bogus.status, 400, JSON.stringify(bogus.body));
  });

  await t.test('ISOLATION: a TL Action line changes no figure about the asset', async () => {
    const assetId = await submitted('Isolated');
    /* The artist's own recorded work on it, which is what every "time on this
       asset" figure in the studio is made of. */
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-19 04:30:00', '2026-03-19 08:30:00', ?, 'submitted')`,
      [assetId, id.ana, 4 * 3600]);
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(assetId, id.lead, '2026-03-19 04:30:00', '2026-03-19 06:00:00');

    /* TIME SPENT, as the board and the reports read it: the sum over
       work_sessions, which is what src/routes/assets.js fills
       time_spent_seconds from. Read off the project's asset list because that
       is the shape that carries it. */
    const spentOf = async () => {
      const list = (await as('root', `/assets/project/${id.alpha}`)).body.assets || [];
      const row = list.find((a) => a.id === assetId);
      assert.ok(row, 'the asset is on the project list');
      return Number(row.time_spent_seconds || 0);
    };
    const beforeSpent = await spentOf();
    assert.strictEqual(beforeSpent, 4 * 3600, 'four hours recorded on it, by the artist');

    const filed = await file('lead', { date: '2026-03-19', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId, tlAction: 'asset_review' });
    assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));

    assert.strictEqual(await spentOf(), beforeSpent,
      'the asset\'s spent time is what the clock recorded, and the lead\'s line is not in it');

    /* AND THE ARTIST IS STILL OFFERED HER OWN FOUR HOURS. This is the case the
       exclusion in hoursLoggedOn is actually for — a lead's review line naming
       the asset must not eat anybody's recorded time, including their own. */
    const hers = await as('ana', `/timesheets/suggest?assetId=${assetId}&date=2026-03-19`);
    assert.strictEqual(hers.body.onThisDay, 4, 'her recorded hours are untouched');
    assert.strictEqual(hers.body.logged, 0, 'and the lead\'s TL line is not counted as hers');
  });

  await t.test('a lead who also worked on the asset is offered their own hours in full', async () => {
    const assetId = await submitted('Both Hats');
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-20 04:30:00', '2026-03-20 07:30:00', ?, 'submitted')`,
      [assetId, id.lead, 3 * 3600]);
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(assetId, id.lead, '2026-03-20 08:00:00', '2026-03-20 09:00:00');   // 1h review

    const review = await file('lead', { date: '2026-03-20', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId, tlAction: 'asset_review' });
    assert.strictEqual(review.status, 201, JSON.stringify(review.body));
    assert.strictEqual(Number(review.body.entry.hours), 1);

    /* THE POINT: the three hours they recorded WORKING on it are still all
       there. Without the tl_action exclusion the review line would have been
       subtracted and they would be offered two. */
    const suggest = await as('lead', `/timesheets/suggest?assetId=${assetId}&date=2026-03-20`);
    assert.strictEqual(suggest.body.onThisDay, 3, 'three hours recorded');
    assert.strictEqual(suggest.body.logged, 0, 'and nothing of it filed yet');
    assert.strictEqual(suggest.body.hours, 3, 'so all three are offered');

    const ordinary = await file('lead', { date: '2026-03-20', hours: 3, clientId: id.client,
      projectId: id.alpha, assetId });
    assert.strictEqual(ordinary.status, 201, JSON.stringify(ordinary.body));
    assert.strictEqual(ordinary.body.entry.tlAction, null, 'and it is an ordinary line');
  });

  await t.test('an edit may not change the kind or the asset, and the hours stay derived', async () => {
    const assetId = await submitted('Edit Me');
    await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'ok' } });
    await session(assetId, id.lead, '2026-03-21 04:30:00', '2026-03-21 06:00:00');
    const made = await file('lead', { date: '2026-03-21', hours: 1, clientId: id.client,
      projectId: id.alpha, assetId, tlAction: 'asset_review' });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const lineId = made.body.entry.id;

    const notes = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { notes: 'Checked the rig as well' } });
    assert.strictEqual(notes.status, 200, JSON.stringify(notes.body));
    assert.strictEqual(Number(notes.body.entry.hours), 1.5,
      'editing the notes recomputes the same figure rather than refusing itself as a duplicate');

    const kind = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { tlAction: 'project_meeting' } });
    assert.strictEqual(kind.status, 400, JSON.stringify(kind.body));
    assert.match(kind.body.error, /keeps the kind/);

    const other = await submitted('Elsewhere');
    const moved = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { assetId: other } });
    assert.strictEqual(moved.status, 400, JSON.stringify(moved.body));
    assert.match(moved.body.error, /keeps the asset/);

    const hours = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { hours: 7 } });
    assert.strictEqual(hours.status, 200, JSON.stringify(hours.body));
    assert.strictEqual(Number(hours.body.entry.hours), 1.5, 'a typed figure is still ignored');
  });

  await t.test('switched off: no box, no new lines, no new sessions, old lines intact', async () => {
    const before = (await as('root', '/admin/settings/timesheet')).body.settings;
    const off = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...before, tlAction: false } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    // The page is told, so the box can go.
    const week = await as('lead', '/timesheets/week?date=2026-03-12');
    assert.strictEqual(week.body.workingDay.tlAction, false);

    const assetId = await submitted('While Off');
    const copied = await copy('lead', assetId);
    assert.strictEqual(copied.status, 204, 'the copy still works');
    assert.strictEqual((await sessionsOn(assetId)).length, 0, 'but records nothing');

    const refused = await file('lead', { date: '2026-03-22', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /switched off/);

    const listed = await list('lead', 'alpha', '2026-03-13');
    assert.strictEqual(listed.body.enabled, false);
    assert.deepStrictEqual(listed.body.ready, [], 'and nothing is offered');

    /* LINES ALREADY FILED ARE UNTOUCHED, and still count towards that person's
       own day. The switch is about what may be recorded next, never about
       rewriting what was. */
    const sheet = await as('lead', '/timesheets/week?date=2026-03-09');
    const day = (sheet.body.days || []).find((d) => d.date === '2026-03-13');
    const kept = (day.entries || []).find((e) => e.tlAction === 'asset_review');
    assert.ok(kept, 'the filed review is still on the sheet');
    assert.strictEqual(kept.tlActionLabel, 'TL · Asset Review', 'and still says what it is');
    assert.ok(Number(day.hours) >= 1.5, 'and still counts towards the day');

    const back = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...before, tlAction: true } });
    assert.strictEqual(back.status, 200);
  });

  await t.test('and nothing about the ordinary flows changed', async () => {
    /* THE REGRESSION CASE THE BRIEF ASKS FOR, as one list: every kind of line
       that existed before this feature still files exactly as it did, with
       tlAction null on all of them. */
    const kinds = [
      ['project work with no asset', { date: '2026-03-23', hours: 2, clientId: id.client,
        projectId: id.alpha, notes: 'blocking out' }],
      ['leave', { date: '2026-03-23', hours: 4, nonProject: 'leave' }],
      ['training', { date: '2026-03-24', hours: 2, nonProject: 'training',
        nonProjectSub: 'training_training_2d_art' }],
    ];
    for (const [what, body] of kinds) {
      const r = await file('ana', body);
      assert.strictEqual(r.status, 201, `${what}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.entry.tlAction, null, `${what} is not a TL Action line`);
      assert.strictEqual(r.body.entry.tlActionLabel, null, `${what} carries no TL label`);
    }

    /* And an ordinary asset line still gets the clock's figure. */
    const assetId = await submitted('Ordinary');
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-25 04:30:00', '2026-03-25 06:30:00', ?, 'submitted')`,
      [assetId, id.ana, 2 * 3600]);
    const line = await file('ana', { date: '2026-03-25', hours: 9, clientId: id.client,
      projectId: id.alpha, assetId });
    assert.strictEqual(line.status, 201, JSON.stringify(line.body));
    assert.strictEqual(Number(line.body.entry.hours), 2, 'calculated from the clock, as always');
    assert.strictEqual(line.body.entry.tlAction, null);
  });

  await t.test('the export carries the kind in its own column', async () => {
    const res = await fetch(`${server.base}/timesheets/export.xlsx?from=2026-03-09&to=2026-03-25`,
      { headers: { Authorization: `Bearer ${tok.lead}` } });
    assert.strictEqual(res.status, 200);
    const book = require('xlsx').read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    const header = text.split('\n').find((l) => l.startsWith('Date,'));
    const cols = header.trim().split(',');
    assert.ok(cols.includes('TL Action'), `the column is there: ${cols.join('|')}`);
    const at = cols.indexOf('TL Action');
    const rows = text.split('\n').map((l) => l.split(','));
    assert.ok(rows.some((r) => r[at] === 'TL · Asset Review'), 'a review line says so');
    assert.ok(rows.some((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[at] === ''),
      'and an ordinary line leaves it blank');
  });
});

// ---------------------------------------------------------------------------
// The page, read as text — what is wired, without a browser.
// ---------------------------------------------------------------------------

test('the form asks the server for everything it shows', () => {
  /* THE PAGE NEVER CALCULATES AN HOUR, which is the rule the whole feature
     rests on: the list and the figure both come from the endpoint, and the
     field is filled from what it says. */
  assert.match(PAGE, /timesheets\/tl-review\/assets\?projectId=/,
    'the picker reads the server');
  assert.match(PAGE, /tl-review\/start/, 'and the copy button starts a session');
  assert.ok(!/tlReviewReady\.set\(/.test(PAGE),
    'the page never computes an entry for the ready map — it is built from the response');

  /* THE COPY HAPPENS FIRST. The session POST is not awaited and catches
     everything: the clipboard write is what the button is for. */
  const handler = PAGE.slice(PAGE.indexOf("closest('.link-copy')"));
  const post = handler.indexOf('tl-review/start');
  const copied = handler.indexOf('showToast(done');
  assert.ok(copied >= 0 && post > copied,
    'the path is copied and the person told before anything is logged');
  assert.ok(/api\(`\/assets\/\$\{encodeURIComponent\(assetId\)\}\/tl-review\/start`[\s\S]{0,200}?\.catch\(/
    .test(PAGE), 'and a logging failure cannot break the copy');
  assert.ok(!/await api\(`\/assets\/\$\{encodeURIComponent\(assetId\)\}\/tl-review\/start`/.test(PAGE),
    'nor make it wait');
});

test('the box is gated on the switch, the key and the project', () => {
  assert.match(PAGE, /const tlActionAllowed = \(\) => Boolean\(\s*\n?\s*\(\(tsState\.week\|\|\{\}\)\.workingDay\|\|\{\}\)\.tlAction && can\('timesheet\.tl_action'\)/,
    'the switch and the key, on the page');
  assert.match(PAGE, /tlActionAllowed\(\) && await tlLeadsProject\(projectId\)/,
    'and whether they lead the project, from the server');
  /* NEVER A ROLE TIER. The one mistake this application has already paid for
     once — see the note at the top of src/routes/timesheet-options.js. */
  const block = PAGE.slice(PAGE.indexOf('function tlSyncAction'), PAGE.indexOf('function tlClearAction'));
  assert.ok(!/role|tier|isSuperAdmin/i.test(block), 'and never a role tier');
});
