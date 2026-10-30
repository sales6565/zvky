/* TL ACTION: a lead's own time, typed.
 *
 * TWO KINDS OF LINE, a project meeting and a review, and after the simplifying
 * change they are the same shape: project work, a project the person leads, no
 * asset, and a number of hours they type. So this suite is about who may file
 * one, what the server refuses, and the one thing that is genuinely subtle —
 * that none of it reaches any figure about an asset, INCLUDING for the rows
 * left behind by the first build of this feature, which did name assets.
 *
 * WHAT THIS SUITE USED TO COVER AND NO LONGER DOES: review sessions, the
 * working-time arithmetic over them, the hours preview, the ready-to-log list,
 * and the locked Hours field. All of that machinery is gone, so its tests are
 * gone with it rather than skipped — a skipped test is a claim nobody is
 * checking. What replaces them is the regression case at the end: Copy this
 * path makes no request, and the two review decisions write no new records.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, openStudio,
  SKIP_REASON } = require('./helpers');
const tlReview = require('../src/tl-review');

const cfg = config('tlrev');
const SKIP = cfg ? false : SKIP_REASON;
const PASSWORD = 'Tl-Review-Typed-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// The two values and the one label function.
// ---------------------------------------------------------------------------

test('the two kinds, and the name that is gone', () => {
  assert.deepStrictEqual(tlReview.ACTION_KEYS, ['project_meeting', 'review']);
  assert.strictEqual(tlReview.labelFor('project_meeting'), 'TL · Project Meeting');
  assert.strictEqual(tlReview.labelFor('review'), 'TL · Review');
  assert.strictEqual(tlReview.labelFor(null), null, 'an ordinary line has no TL label');
  assert.strictEqual(tlReview.labelFor('something_else'), null);

  /* STRICT ON THE WAY IN, LENIENT ON THE WAY OUT, and the split is the point.
     'asset_review' is refused as an input — a client still sending the old name
     is told rather than quietly filed — but still READS as "TL · Review",
     because a row the migration could not reach must stay legible. Refusing to
     label it would leave a line on somebody's timesheet with no description. */
  assert.strictEqual(tlReview.isAction('asset_review'), false, 'the old name is not accepted');
  assert.strictEqual(tlReview.labelFor('asset_review'), 'TL · Review', 'but it is still readable');

  for (const bad of ['', null, undefined, 'REVIEW', 'Project Meeting']) {
    assert.strictEqual(tlReview.isAction(bad), false, `${bad} is not a kind of TL Action`);
  }
});

test('the label is spelt in one place, and everything else calls for it', () => {
  const root = path.join(__dirname, '..');
  const spellings = ['src', 'public'].flatMap(function walk(dir) {
    const full = path.join(root, dir);
    return fs.readdirSync(full, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  }).filter((f) => /\.(js|html)$/.test(f))
    .filter((f) => f !== 'src/tl-review.js')
    /* COMMENTS COUNT, deliberately — a scan that skipped them would miss the
       copy somebody pastes into a comment and then uncomments. */
    .filter((f) => /TL · (Project Meeting|Review)/.test(
      fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(spellings, [],
    'the label belongs to src/tl-review.js — everything else calls labelFor()');
});

test('the automatic-time machinery is gone, not merely unused', () => {
  /* STRUCTURAL, because "we removed it" is exactly the claim that rots. Each of
     these is a piece of the first build; any one of them left behind is either
     dead code or, worse, something still running. */
  const root = path.join(__dirname, '..');
  const files = ['src', 'public'].flatMap(function walk(dir) {
    const full = path.join(root, dir);
    return fs.readdirSync(full, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  }).filter((f) => /\.(js|html)$/.test(f));

  const gone = [
    ['tl-review/start', 'the session-start endpoint'],
    ['closeIfReviewEnded', 'the hook in the status-transition function'],
    ['tl-review/assets', 'the ready-to-log list endpoint'],
    ['data-review-asset', 'the attribute the copy button carried'],
    ['tlLoadReviewAssets', 'the page\'s list loader'],
    ['tlFillReviewHours', 'the page\'s hours filler'],
    ['hoursByAsset', 'the review-hours calculation'],
  ];
  for (const [needle, what] of gone) {
    const found = files.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes(needle));
    assert.deepStrictEqual(found, [], `${what} is still referenced (${needle})`);
  }

  /* AND NOTHING WRITES TO THE SESSIONS TABLE. The table itself stays — it may
     hold rows on a deployment that ran the earlier migration, and dropping it
     would destroy them — but the only file allowed to name it is the migration
     that creates it and the health check that reports on it. */
  const writers = files.filter((f) => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    return /\b(INSERT INTO|UPDATE)\s+tl_review_sessions/i.test(text);
  });
  assert.deepStrictEqual(writers, [], 'nothing writes review sessions any more');
  const readers = files.filter((f) => f !== 'src/migrate.js' && f !== 'src/schema-check.js'
    && fs.readFileSync(path.join(root, f), 'utf8').includes('tl_review_sessions'));
  assert.deepStrictEqual(readers, [], 'and nothing reads them');
});

test('Copy this path is back to copying, and nothing else', () => {
  /* The handler is one delegated listener. It must contain no request of any
     kind — asserted over the handler's own text rather than over the whole page,
     so an api() call anywhere else does not mask or trip it. */
  const from = PAGE.indexOf("closest('.link-copy')");
  assert.ok(from > 0, 'the copy handler is in the page');
  const handler = PAGE.slice(from, PAGE.indexOf('\n});', from));
  assert.ok(!/\bapi\(|fetch\(|XMLHttpRequest|sendBeacon/.test(handler),
    `the copy handler makes no network call: ${handler.slice(0, 400)}`);
  assert.match(handler, /clipboard|execCommand/, 'it still copies');
});

test('the listener the browser fixture copies is still wired this way', () => {
  /* tests/tl-review-browser lifts the TL Action functions out of the page and
     has to attach the project picker's change handler itself, because in the
     page it sits at the top level of the script rather than inside the lifted
     block. A fixture that copies the functions and not the wiring has
     everything working and nothing connected — which cost a run once, with a
     failure that read like a product bug. So the shape the fixture copies is
     pinned HERE, where moving or deleting it in the page fails loudly instead
     of quietly making that suite a copy of something that no longer exists. */
  const projectHandler = PAGE.slice(
    PAGE.indexOf("document.getElementById('tl_project').addEventListener('change'"));
  assert.match(projectHandler.slice(0, 600), /tlClearAction\(\)/,
    'changing the project clears the box');
  assert.match(projectHandler.slice(0, 600), /tlSyncAction\(\)/,
    'and re-asks whether it belongs on the new one');
  /* THE ORDER: cleared before re-asked. A tick left over from the old project
     while the new one is being checked is a tick about a project this person
     may not even lead. */
  assert.ok(projectHandler.indexOf('tlClearAction()') < projectHandler.indexOf('tlSyncAction()'),
    'in that order');

  /* AND THE ASSET PICKER'S HANDLER HAS NO TL BRANCH ANY MORE. It had one while
     a review's hours were calculated; the field is hidden for a TL line now, so
     a branch about what to do when one is chosen would be unreachable code
     about a control that is not on the form. */
  const assetHandler = PAGE.slice(
    PAGE.indexOf("document.getElementById('tl_asset').addEventListener('change'"));
  assert.ok(!/tlAction|tlFillReviewHours/.test(assetHandler.slice(0, 600)),
    'the asset picker knows nothing about TL Action');
});

test('the box is gated on the switch, the key and the project, and never a tier', () => {
  assert.match(PAGE, /const tlActionAllowed = \(\) => Boolean\(\s*\n?\s*\(\(tsState\.week\|\|\{\}\)\.workingDay\|\|\{\}\)\.tlAction && can\('timesheet\.tl_action'\)/,
    'the switch and the key, on the page');
  assert.match(PAGE, /tlActionAllowed\(\) && tlLeadsProject\(projectId\)/,
    'and whether they lead the project');
  /* WHICH IS THE SERVER'S ANSWER, read from the week payload rather than worked
     out — "lead of this project" includes Acting Team Leads and is not a thing
     a page could derive from a role. */
  assert.match(PAGE, /\(\(tsState\.week\|\|\{\}\)\.tlActionProjects\|\|\[\]\)\.includes\(projectId\)/,
    'from the list the server sends with the week');
  const block = PAGE.slice(PAGE.indexOf('function tlSyncAction'), PAGE.indexOf('function tlClearAction'));
  assert.ok(!/role|tier|isSuperAdmin/i.test(block), 'and never a role tier');
});

test('the asset field is hidden for a TL line, not merely disabled', () => {
  /* THE BRIEF'S WORD IS "HIDDEN", and the difference is real: a disabled select
     is still a labelled control asking to be filled in for a kind of line that
     has no asset. Asserted on the WRAPPER, because hiding the field and leaving
     its heading behind reads as a field that failed to load. */
  const block = PAGE.slice(PAGE.indexOf('function tlSyncActionType'),
    PAGE.indexOf('function tlActionProblem'));
  assert.match(block, /getElementById\('tl_assetWrap'\)\.style\.display = 'none'/,
    'the asset field and its label are hidden');
  assert.ok(!/asset\.disabled = true/.test(block),
    'and not merely disabled, which would leave a greyed control on the form');
  assert.match(block, /tlHelpText\(true\)/, 'and the clock sentence is swapped for the typed one');
  assert.match(PAGE, /id="tl_helpTyped"[\s\S]{0,200}?Type the hours you spent\./,
    'which says what to do instead');
});

// ---------------------------------------------------------------------------
// Live.
// ---------------------------------------------------------------------------

test('TL Action, end to end', { skip: SKIP }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;
  const file = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const week = async (who, date = '2026-03-09') => (await as(who, `/timesheets/week?date=${date}`)).body;

  const submitted = async (name) => {
    const made = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: id.ana, manHours: 20 } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const assetId = made.body.asset.id;
    await as('ana', `/assets/${assetId}/start`, { method: 'POST', body: {} });
    const sent = await as('ana', `/assets/${assetId}/submit`, { method: 'POST',
      body: { link: `/mnt/shared/submissions/${name}` } });
    assert.ok(sent.status < 400, JSON.stringify(sent.body));
    return assetId;
  };

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
    assert.ok(!holders.includes('admin'), 'an Admin, who leads no team, does not');
    for (const key of holders) {
      const caps = roles.capabilitiesFor(key);
      assert.ok(caps.leadsTeam || caps.managePermissions,
        `${key} holds it, so it either leads a team or is the Super Admin tier`);
    }
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.match(readme, /`timesheet\.tl_action`/, 'the README lists the key');
    assert.ok(!/Asset Review/.test(readme), 'and no longer says "Asset Review" anywhere');
  });

  await t.test('the week says which projects this person leads, and only for a holder', async () => {
    const lead = await week('lead');
    assert.deepStrictEqual(lead.tlActionProjects, [id.alpha],
      'the lead of Alpha gets Alpha, and not Beta');
    assert.strictEqual(lead.workingDay.tlAction, true, 'and the switch is published with it');

    const acting = await week('acting');
    assert.deepStrictEqual(acting.tlActionProjects, [id.alpha],
      'an Acting Team Lead leads it too');

    /* ANA HOLDS THE KEY and leads nothing, so the list is empty — which is what
       makes the box absent for her rather than present and then refused. */
    assert.deepStrictEqual((await week('ana')).tlActionProjects, []);
    assert.deepStrictEqual((await week('other')).tlActionProjects, [id.beta],
      'and the lead of Beta gets Beta');
  });

  await t.test('both kinds file with typed hours and no asset', async () => {
    for (const [kind, label] of [['project_meeting', 'TL · Project Meeting'],
      ['review', 'TL · Review']]) {
      const r = await file('lead', { date: '2026-03-09', hours: 1.5, clientId: id.client,
        projectId: id.alpha, tlAction: kind, notes: `a ${kind}` });
      assert.strictEqual(r.status, 201, `${kind}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(Number(r.body.entry.hours), 1.5, `${kind}: the typed figure is kept`);
      assert.strictEqual(r.body.entry.tlAction, kind);
      assert.strictEqual(r.body.entry.tlActionLabel, label);
      assert.strictEqual(r.body.entry.assetId, null, `${kind}: and it names no asset`);
    }
  });

  await t.test('neither kind may name an asset', async () => {
    const assetId = await submitted('Not Mine');
    for (const kind of ['project_meeting', 'review']) {
      const r = await file('lead', { date: '2026-03-10', hours: 1, clientId: id.client,
        projectId: id.alpha, assetId, tlAction: kind });
      assert.strictEqual(r.status, 400, `${kind}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /not logged against an asset/);
      assert.strictEqual(r.body.field, 'assetId');
    }
  });

  await t.test('the old name is refused outright', async () => {
    /* A client still sending 'asset_review' is told, rather than having it
       filed as a value nothing says any more. */
    const r = await file('lead', { date: '2026-03-10', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'asset_review' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /not a kind of TL Action/);
  });

  await t.test('the hours get the same rules every typed line gets', async () => {
    /* REFUSED AS A 400 WITH A SENTENCE, not merely "refused".
     
       That distinction is the whole of this case and it was learnt the hard
       way: timesheet_entries carries a database CHECK constraint on hours, so a
       figure that gets past validation comes back as a 500 reading "this
       deployment's database rejected the value". A test that accepted any
       status over 399 passed on that — which is to say it passed while the
       person filling in the form was shown a database error instead of being
       told what was wrong. The status is pinned at 400 so validation has to
       catch these BEFORE the database does. */
    const bad = [
      ['zero', 0], ['negative', -2], ['not a number', 'half an hour'], ['empty', ''],
      /* ABOVE ZERO AND BELOW THE STUDIO'S MINIMUM, which is the only one of
         these the minimum itself refuses — the others are caught by being
         unparseable or by not being a positive number at all. Without it,
         removing the minimum check changes nothing any test can see. */
      ['smaller than the smallest line', 0.1],
      ['longer than a day', 99],
    ];
    for (const [what, hours] of bad) {
      const r = await file('lead', { date: '2026-03-11', hours, clientId: id.client,
        projectId: id.alpha, tlAction: 'review' });
      assert.strictEqual(r.status, 400,
        `${what} (${JSON.stringify(hours)}) is refused with a message: ${JSON.stringify(r.body)}`);
      assert.ok(String(r.body.error || '').length > 10,
        `${what}: and the message is a sentence — ${JSON.stringify(r.body)}`);
    }
    /* AND A GOOD ONE GOES THROUGH, so the list above is about the figures and
       not about the endpoint being broken. */
    const ok = await file('lead', { date: '2026-03-11', hours: 0.25, clientId: id.client,
      projectId: id.alpha, tlAction: 'review' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  });

  await t.test('an Acting Team Lead may file; an artist with the key may not', async () => {
    const acting = await file('acting', { date: '2026-03-12', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'review' });
    assert.strictEqual(acting.status, 201, JSON.stringify(acting.body));

    /* ANA: same designation, same key, no membership. */
    const artist = await file('ana', { date: '2026-03-12', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'review' });
    assert.strictEqual(artist.status, 403, JSON.stringify(artist.body));
    assert.match(artist.body.error, /do not lead that project/);
  });

  await t.test('a lead of project A cannot use project B', async () => {
    const r = await file('other', { date: '2026-03-12', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /do not lead that project/);
  });

  await t.test('without the key it is the key', async () => {
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: held.filter((k) => k !== 'timesheet.tl_action') } });
    const r = await file('acting', { date: '2026-03-12', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'review' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /permission/, 'the key, not the membership — Ash leads Alpha');
    /* AND THE WEEK STOPS OFFERING IT, so the box goes with the key. */
    assert.deepStrictEqual((await week('acting')).tlActionProjects, []);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('TL Action is project work: a non-project category cannot carry one', async () => {
    const r = await file('lead', { date: '2026-03-13', hours: 1, nonProject: 'leave',
      tlAction: 'project_meeting' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /project work/);
  });

  await t.test('an edit keeps the kind, and the hours stay editable', async () => {
    const made = await file('lead', { date: '2026-03-16', hours: 2, clientId: id.client,
      projectId: id.alpha, tlAction: 'review' });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const lineId = made.body.entry.id;

    const hours = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { hours: 3 } });
    assert.strictEqual(hours.status, 200, JSON.stringify(hours.body));
    assert.strictEqual(Number(hours.body.entry.hours), 3,
      'a TL line is typed, so its hours are editable like any other typed line');

    const kind = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { tlAction: 'project_meeting' } });
    assert.strictEqual(kind.status, 400, JSON.stringify(kind.body));
    assert.match(kind.body.error, /keeps the kind/);

    const asset = await submitted('Edit Target');
    const moved = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { assetId: asset } });
    assert.strictEqual(moved.status, 400, JSON.stringify(moved.body));
  });

  await t.test('switched off: no list, no new lines, old lines intact', async () => {
    const before = (await as('root', '/admin/settings/timesheet')).body.settings;
    const off = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...before, tlAction: false } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    const w = await week('lead');
    assert.strictEqual(w.workingDay.tlAction, false, 'the page is told');
    assert.deepStrictEqual(w.tlActionProjects, [], 'and offered no project, so the box cannot draw');

    const refused = await file('lead', { date: '2026-03-17', hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /switched off/);

    /* LINES ALREADY FILED ARE UNTOUCHED, and still count towards that person's
       own day. The switch is about what may be recorded next, never about
       rewriting what was. */
    const sheet = await week('lead');
    const day = (sheet.days || []).find((d) => d.date === '2026-03-09');
    const kept = (day.entries || []).filter((e) => e.tlAction);
    assert.strictEqual(kept.length, 2, 'both lines from the first case are still there');
    assert.ok(kept.some((e) => e.tlActionLabel === 'TL · Review'), 'and still say what they are');
    assert.ok(Number(day.hours) >= 3, 'and still count towards the day');

    const back = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...before, tlAction: true } });
    assert.strictEqual(back.status, 200);
  });

  await t.test('ISOLATION: a TL line is kept out of the asset figures, asset_id or not', async () => {
    const assetId = await submitted('Isolated');
    /* The artist's own recorded work on it, which is what every "time on this
       asset" figure in the studio is made of. */
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-18 04:30:00', '2026-03-18 08:30:00', ?, 'submitted')`,
      [assetId, id.ana, 4 * 3600]);

    const spentOf = async () => {
      const list = (await as('root', `/assets/project/${id.alpha}`)).body.assets || [];
      const row = list.find((a) => a.id === assetId);
      assert.ok(row, 'the asset is on the project list');
      return Number(row.time_spent_seconds || 0);
    };
    const before = await spentOf();
    /* ABOUT four hours, not exactly. The figure is recomputed from the stored
       stamps rather than read back as the `seconds` this fixture wrote, so
       under load the two ends can fall either side of a second — a frozen run
       turned up 14401 against 14400. A minute of slack keeps everything this
       case is for: what it has to see is a TL line of 1.5 hours either landing
       in this total or not, and the identity below is where that is actually
       asserted. */
    assert.ok(Math.abs(before - 4 * 3600) <= 60,
      `about four hours recorded on it, by the artist — got ${before}s`);

    /* A TL LINE WITH AN ASSET_ID, written as the first build of this feature
       would have left one — the API refuses to create one now, so the only way
       to have the row this case is about is to write it. That is the point: it
       is the shape a converted row has, and it must be excluded all the same. */
    const legacy = require('node:crypto').randomUUID();
    await sql(cfg,
      `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id,
         hours, tl_action)
       VALUES (?, ?, '2026-03-18', ?, ?, ?, 1.5, 'review')`,
      [legacy, id.lead, id.client, id.alpha, assetId]);

    /* THE CLAIM ITSELF, and it is an identity rather than a measurement: adding
       a 1.5-hour TL line moved this figure by nothing at all. */
    assert.strictEqual(await spentOf(), before,
      'the asset\'s spent time is what the clock recorded, and no timesheet line is in it');

    /* AND THE ARTIST IS STILL OFFERED HER OWN FOUR HOURS. This is the case the
       exclusion in hoursLoggedOn is for — it is keyed on tl_action and never on
       asset_id, precisely so a converted row with one is still excluded. */
    const hers = await as('ana', `/timesheets/suggest?assetId=${assetId}&date=2026-03-18`);
    assert.strictEqual(hers.body.onThisDay, 4, 'her recorded hours are untouched');
    assert.strictEqual(hers.body.logged, 0, 'and the lead\'s TL line is not counted as hers');

    /* AND NEITHER IS IT COUNTED AGAINST THE LEAD'S OWN RECORDED TIME on that
       asset, which is the same rule seen from the other side. */
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-18 04:30:00', '2026-03-18 07:30:00', ?, 'submitted')`,
      [assetId, id.lead, 3 * 3600]);
    const his = await as('lead', `/timesheets/suggest?assetId=${assetId}&date=2026-03-18`);
    assert.strictEqual(his.body.onThisDay, 3, 'three hours recorded');
    assert.strictEqual(his.body.logged, 0, 'and his own TL line does not eat them');
    assert.strictEqual(his.body.hours, 3, 'so all three are offered');
  });

  await t.test('a converted row with an asset is still readable and still editable', async () => {
    /* The row the migration produces: 'review', with the asset it was filed
       against still on it. Both halves matter — the timesheet must show the
       asset beside the label so nothing is hidden, and the line must stay
       editable or its owner can never correct it. */
    const assetId = await submitted('Converted');
    const lineId = require('node:crypto').randomUUID();
    await sql(cfg,
      `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id,
         hours, tl_action, notes)
       VALUES (?, ?, '2026-03-19', ?, ?, ?, 2, 'review', 'filed under the old build')`,
      [lineId, id.lead, id.client, id.alpha, assetId]);

    const sheet = await week('lead', '2026-03-16');
    const day = (sheet.days || []).find((d) => d.date === '2026-03-19');
    const row = (day.entries || []).find((e) => e.id === lineId);
    assert.ok(row, 'the line is on the sheet');
    assert.strictEqual(row.tlActionLabel, 'TL · Review', 'it reads as a Review');
    assert.ok(row.assetCode, 'and the asset it was filed against is still named beside it');

    const edited = await as('lead', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { notes: 'corrected' } });
    assert.strictEqual(edited.status, 200,
      `a converted row stays editable: ${JSON.stringify(edited.body)}`);
    assert.strictEqual(edited.body.entry.notes, 'corrected');
    assert.strictEqual(edited.body.entry.assetId, assetId, 'and keeps its asset');
  });

  await t.test('REGRESSION: the review decisions write no new records', async () => {
    const countAll = async () => ({
      sessions: Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM tl_review_sessions'))[0].n),
      events: Number((await sql(cfg, 'SELECT COUNT(*) AS n FROM asset_events'))[0].n),
    });

    const approved = await submitted('Approve Me');
    const before = await countAll();
    const ok = await as('lead', `/assets/${approved}/review`, { method: 'POST',
      body: { decision: 'approved', text: 'Good' } });
    assert.ok(ok.status < 400, JSON.stringify(ok.body));
    let after = await countAll();
    assert.strictEqual(after.sessions, before.sessions, 'TL Approved writes no review session');
    assert.strictEqual(after.events, before.events + 1,
      'and exactly the one asset_event it always wrote');
    assert.strictEqual(
      (await sql(cfg, 'SELECT `status` FROM assets WHERE id = ?', [approved]))[0].status,
      'tl_approved', 'and the transition is what it always was');

    const sentBack = await submitted('Send Me Back');
    const before2 = await countAll();
    const changes = await as('lead', `/assets/${sentBack}/review`, { method: 'POST',
      body: { decision: 'changes_requested', text: 'The rig is wrong' } });
    assert.ok(changes.status < 400, JSON.stringify(changes.body));
    after = await countAll();
    assert.strictEqual(after.sessions, before2.sessions, 'Request Changes writes none either');
    assert.strictEqual(after.events, before2.events + 1);

    /* AND THE TABLE HAS NEVER HELD A ROW in this whole suite, which is the
       strongest form of "nothing writes to it". */
    assert.strictEqual(after.sessions, 0, 'nothing has written a review session at all');
  });

  await t.test('REGRESSION: the ordinary flows are untouched', async () => {
    const kinds = [
      ['project work with no asset', { date: '2026-03-20', hours: 2, clientId: id.client,
        projectId: id.alpha, notes: 'blocking out' }],
      ['leave', { date: '2026-03-20', hours: 4, nonProject: 'leave' }],
      ['training', { date: '2026-03-23', hours: 2, nonProject: 'training',
        nonProjectSub: 'training_training_2d_art' }],
    ];
    for (const [what, body] of kinds) {
      const r = await file('ana', body);
      assert.strictEqual(r.status, 201, `${what}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.entry.tlAction, null, `${what} is not a TL Action line`);
      assert.strictEqual(r.body.entry.tlActionLabel, null, `${what} carries no TL label`);
    }

    /* And an ordinary asset line still gets the clock's figure, locked. */
    const assetId = await submitted('Ordinary');
    await sql(cfg,
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds, ended_reason)
       VALUES (UUID(), ?, ?, 1, '2026-03-24 04:30:00', '2026-03-24 06:30:00', ?, 'submitted')`,
      [assetId, id.ana, 2 * 3600]);
    const line = await file('ana', { date: '2026-03-24', hours: 9, clientId: id.client,
      projectId: id.alpha, assetId });
    assert.strictEqual(line.status, 201, JSON.stringify(line.body));
    assert.strictEqual(Number(line.body.entry.hours), 2, 'calculated from the clock, as always');
    assert.strictEqual(line.body.entry.tlAction, null);
  });

  await t.test('the export carries the kind in its own column', async () => {
    /* AN ORDINARY LINE OF THE LEAD'S OWN, so the "blank for everything else"
       half of this case has something to be true about. The export is scoped to
       one person, and every other line this lead has filed is a TL one. */
    const plain = await file('lead', { date: '2026-03-24', hours: 1, clientId: id.client,
      projectId: id.alpha, notes: 'ordinary project time' });
    assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));

    const res = await fetch(`${server.base}/timesheets/export.xlsx?from=2026-03-09&to=2026-03-24`,
      { headers: { Authorization: `Bearer ${tok.lead}` } });
    assert.strictEqual(res.status, 200);
    const book = require('xlsx').read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    const header = text.split('\n').find((l) => l.startsWith('Date,'));
    const cols = header.trim().split(',');
    const at = cols.indexOf('TL Action');
    assert.ok(at > 0, `the column is there: ${cols.join('|')}`);
    const rows = text.split('\n').map((l) => l.split(','));
    assert.ok(rows.some((r) => r[at] === 'TL · Review'), 'a review line says so');
    assert.ok(rows.some((r) => r[at] === 'TL · Project Meeting'), 'and a meeting says so');
    assert.ok(!text.includes('Asset Review'), 'and the old name is nowhere in the sheet');
    assert.ok(rows.some((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[at] === ''),
      'an ordinary line leaves it blank');
  });
});
