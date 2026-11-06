/* PROMPT 67 PART B: "PROJECT MEETING" FOR THE PEOPLE WHO ARE NOT THE LEAD.
 *
 * ===========================================================================
 * WHAT THE OWNER ASKED FOR: on Add a line, for everyone except Team Leads,
 * after the client and the project, a check box called Project Meeting. Ticked,
 * the Asset dropdown goes, the hours are typed, and it saves.
 *
 * WHAT MAKES IT MORE THAN A CHECK BOX, and what these tests are really about:
 *
 *   1. THE SPLIT IS PER PROJECT, NOT PER DESIGNATION. A lead logs the same
 *      meeting as TL Action (Prompt 57); everybody else logs it as this. So
 *      somebody who leads project A and is an artist on project B gets TL
 *      Action on A and Project Meeting on B, from one form on one day — and
 *      never both on either. permissions.isProjectLead() is the one function
 *      that decides, on the server, every time.
 *
 *   2. IT IS NOT TIME ON AN ASSET. A meeting line names none and must reach no
 *      figure that is about one: not an asset's spent hours, not efficiency,
 *      not bid-vs-spent, not the Artist Report. It counts in the person's own
 *      timesheet total and in the exact-hours rule, which is the whole point of
 *      filing it.
 *
 *   3. A LINE CANNOT BE BOTH. tl_action already holds a value called
 *      'project_meeting' — for a lead — so the two are deliberately different
 *      columns, and a request carrying both is refused in a sentence that says
 *      why rather than having one of them quietly dropped.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const catalog = require('../src/permission-catalog');
const tlReview = require('../src/tl-review');
const timesheetSettings = require('../src/timesheet-settings');

const cfg = config('projmeeting');
const PASSWORD = 'Meeting-Test-1!';

/* ---- the key and the switch, as values ---------------------------------- */

test('the permission reaches everyone who can fill a timesheet', () => {
  const entry = catalog.BY_KEY.get('timesheet.project_meeting');
  assert.ok(entry, 'timesheet.project_meeting is in the catalogue');
  assert.strictEqual(entry.label, 'Log Project Meeting time');

  /* THE DEFAULT THE BRIEF ASKS FOR: every role that can add a timesheet line
     today, plus the Super Admin. timesheet.own is implied for every
     designation, so this is too — and it is tied to that key's own holders in
     tests/role-groups.test.js rather than to a list written twice. */
  const roles = require('../src/roles');
  const holders = (key) => roles.roleKeys()
    .filter((k) => catalog.BY_KEY.get(key).impliedBy(roles.roleDef(k))).sort();
  assert.deepStrictEqual(holders('timesheet.project_meeting'), holders('timesheet.own'));
  assert.ok(holders('timesheet.project_meeting').includes('super_admin'));
  assert.ok(holders('timesheet.project_meeting').length > 1);

  /* AND IT IS GRANTABLE, which is what lets a studio narrow it through a role
     group if it would rather only some designations had it. */
  assert.notStrictEqual(entry.grantable, false);
});

test('the studio switch is on by default, and is its own setting', () => {
  assert.strictEqual(timesheetSettings.DEFAULTS.projectMeeting, true,
    'on, because it blocks nobody and adds nothing to anybody\'s day');
  /* SEPARATE FROM TL ACTION'S. The two halves are switchable apart: a studio
     can have leads logging TL Action and nobody else logging meetings, or the
     other way round. */
  assert.ok('tlAction' in timesheetSettings.DEFAULTS);
  const v = timesheetSettings.validate({ projectMeeting: false },
    { ...timesheetSettings.DEFAULTS });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.projectMeeting, false);
  assert.strictEqual(v.value.tlAction, true, 'and turning one off leaves the other alone');
});

test('the label comes from the one function, and says which kind it is', () => {
  /* ONE FUNCTION, TWO ARGUMENTS. A lead's meeting and everybody else's read
     differently on purpose: a manager reading a day can tell the lead's time
     from the team's. */
  assert.strictEqual(tlReview.labelFor(null, true), 'Project Meeting');
  assert.strictEqual(tlReview.labelFor(null, false), null, 'an ordinary line has no label');
  assert.strictEqual(tlReview.labelFor('project_meeting', false), 'TL · Project Meeting');
  assert.strictEqual(tlReview.labelFor('review', false), 'TL · Review');
  /* A ROW CARRYING BOTH cannot be filed, but a label is read by screens that
     can refuse nothing — so the stricter claim wins rather than the function
     returning something ambiguous. */
  assert.strictEqual(tlReview.labelFor('review', true), 'TL · Review');
  assert.strictEqual(tlReview.PROJECT_MEETING_LABEL, 'Project Meeting');
});

/* ===========================================================================
 * AGAINST A REAL DATABASE AND A REAL SERVER.
 */
test('Project Meeting, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const people = {};
  const id = {};
  const call = (p, opts = {}) => api(server.base, p, opts);
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);
  const today = () => require('../src/timesheet-gate').istDate();

  /* A working day, walked backwards from today — the studio logs Monday to
     Friday, so a fixed offset is a weekend two days in seven and the route
     refuses it before any of this is consulted. */
  const workingDay = () => {
    const gate = require('../src/timesheet-gate');
    for (let back = 0; back < 7; back += 1) {
      const date = gate.shiftDays(today(), -back);
      if ([1, 2, 3, 4, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return date;
    }
    throw new Error('no working day in a week');
  };

  const line = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const meeting = (who, projectId, over = {}) => line(who, {
    date: workingDay(), hours: 1.5, clientId: id.client, projectId,
    projectMeeting: true, ...over,
  });
  const setPolicy = async (over) => {
    const res = await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { maxDayHours: 8, minLineHours: 0.25, maxLineHours: 24,
        loggableDays: [1, 2, 3, 4, 5], ...over } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'pm-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'pm-token', name: 'Root', email: 'root@pm.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@pm.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    id.client = await systemClientId(server.base, token.root);

    for (const [who, role] of [['ana', 'game_artist'], ['lee', 'team_lead'],
      /* KIM IS THE BRIEF'S OWN EXAMPLE: an ARTIST who leads one project and
         works on another. Made a game_artist rather than a team_lead because a
         Team Lead's project scope is read off the leads, coordinators and
         supervision lists and never off project_members — so a team_lead can
         not be an ordinary member of a second project at all, and the scenario
         the brief names is an artist standing in as an Acting Team Lead. Which
         is exactly what permissions.isProjectLead() counts, and the reason it
         is the one function that answers this. */
      ['kim', 'game_artist']]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@pm.test`, role, password: PASSWORD } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@pm.test`);
    }

    /* TWO PROJECTS, AND LEE LEADS EXACTLY ONE OF THEM. That is the fixture the
       whole feature turns on: the same person, the same day, two answers. */
    const mkProject = async (key, name, leadIds) => {
      const r = await as('root', '/projects', { method: 'POST',
        body: { name, clientId: id.client, teamLeadIds: leadIds } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('alpha', 'Alpha', [people.lee]);
    await mkProject('beta', 'Beta', []);
    /* Kim stands in as a lead on Alpha and nowhere else. */
    await q('INSERT IGNORE INTO project_acting_team_leads (project_id, user_id) VALUES (?,?)',
      [id.alpha, people.kim]);

    /* MEMBERSHIP IS WRITTEN DIRECTLY, and that is a fixture decision worth
       stating. POST /projects takes the LEADS, the coordinators and the
       supervision; an ordinary member is attached the other way round, by
       naming a project when the USER is created — which gives each person one
       project. This feature's whole point is somebody who is on two of them
       with a different standing on each, so the rows go in here. */
    for (const [project, user] of [
      [id.alpha, people.ana], [id.beta, people.ana],
      [id.alpha, people.kim], [id.beta, people.kim],
    ]) {
      await q('INSERT IGNORE INTO project_members (project_id, user_id) VALUES (?,?)',
        [project, user]);
    }

    await setPolicy({});
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the column is there, nullable, and the migration is idempotent', async () => {
    const col = await q(
      `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timesheet_entries'
          AND COLUMN_NAME = 'project_meeting'`);
    assert.strictEqual(col.length, 1, 'the migration added timesheet_entries.project_meeting');
    /* NULLABLE, so every line filed before this reads as not-a-meeting with no
       backfill — which is what "additive" means for a column. */
    assert.strictEqual(col[0].n, 'YES');

    const handle = {
      async query(text, params = []) {
        const values = [];
        const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
          values.push(params[Number(n) - 1]); return '?';
        });
        const rows = await sql(cfg, translated, values.length ? values : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      },
    };
    const step = require('../src/migrate').STEPS
      .find(([name]) => name === 'timesheet project meeting');
    assert.ok(step, 'and it is a registered migration step');
    const said = [];
    await step[1](handle, (m) => said.push(m));
    assert.deepStrictEqual(said, [], 'running it again does nothing and says nothing');
  });

  await t.test('a non-lead on the project can file one', async () => {
    const res = await meeting('ana', id.alpha);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    id.anaLine = res.body.entry.id;

    const row = (await q('SELECT * FROM timesheet_entries WHERE id = ?', [id.anaLine]))[0];
    assert.strictEqual(Number(row.project_meeting), 1);
    assert.strictEqual(row.asset_id, null, 'no asset, ever');
    assert.strictEqual(row.tl_action, null, 'and it is not a TL Action line');
    assert.strictEqual(Number(row.hours), 1.5, 'the hours are the ones that were typed');
  });

  await t.test('the lead of that project is refused, and told where to put it', async () => {
    const res = await meeting('lee', id.alpha);
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.error, /you lead that project/i);
    assert.match(res.body.error, /TL Action/, 'and it names the field that is theirs');
    assert.strictEqual(res.body.field, 'projectMeeting');

    const none = await q(
      'SELECT COUNT(*) AS n FROM timesheet_entries WHERE user_id = ? AND project_meeting = 1',
      [people.lee]);
    assert.strictEqual(Number(none[0].n), 0, 'and nothing was filed');

    /* AND TL ACTION STILL WORKS FOR THEM, unchanged by any of this. */
    const tl = await line('lee', { date: workingDay(), hours: 1, clientId: id.client,
      projectId: id.alpha, tlAction: 'project_meeting' });
    assert.strictEqual(tl.status, 201, JSON.stringify(tl.body));
    assert.strictEqual((await q('SELECT tl_action FROM timesheet_entries WHERE id = ?',
      [tl.body.entry.id]))[0].tl_action, 'project_meeting');
  });

  await t.test('leading one project and working on another gives each its own', async () => {
    /* THE CASE THE BRIEF NAMES, in one person: Kim stands in as a lead on
       Alpha and is an ordinary member of Beta. Same form, same day, two
       answers — decided per PROJECT, not per designation. */
    const onBeta = await meeting('kim', id.beta);
    assert.strictEqual(onBeta.status, 201, JSON.stringify(onBeta.body),
      'a meeting on the project they do NOT lead');

    const onAlpha = await meeting('kim', id.alpha);
    assert.strictEqual(onAlpha.status, 422, JSON.stringify(onAlpha.body),
      'and not on the one they do — that time is TL Action');

    /* The two lists the week payload carries are complements, which is what
       makes the form able to draw one box or the other without asking. */
    const week = await as('kim', `/timesheets/week?date=${workingDay()}`);
    const notLed = week.body.projectMeetingProjects || [];
    assert.ok(notLed.includes(id.beta), 'Beta is offered the meeting box');
    assert.ok(!notLed.includes(id.alpha), 'and Alpha is not — Kim leads it');

    /* THE TWO LISTS ARE COMPLEMENTS, which is what lets the form draw one box
       or the other without asking. Kim's TL list is empty until the studio
       grants the key: standing in as a lead makes them a lead for this rule,
       and holding timesheet.tl_action is a separate decision their designation
       has not been given. Granted, Alpha appears there and nowhere else. */
    assert.deepStrictEqual(week.body.tlActionProjects, [],
      'a game_artist holds no TL Action key, so no project is in that list');

    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'timesheet.tl_action'])] } });
    try {
      const again = await as('kim', `/timesheets/week?date=${workingDay()}`);
      const led = again.body.tlActionProjects || [];
      const stillNotLed = again.body.projectMeetingProjects || [];
      assert.ok(led.includes(id.alpha), 'Alpha is in the leads list now');
      assert.ok(stillNotLed.includes(id.beta));
      assert.deepStrictEqual(led.filter((p) => stillNotLed.includes(p)), [],
        'and no project is ever in both');
    } finally {
      await as('root', '/permissions/roles/game_artist', { method: 'PUT',
        body: { permissions: held } });
    }
  });

  await t.test('an asset, a non-project kind, and the TL flag are each refused', async () => {
    const assetRes = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name: 'A thing', type: 'character', manHours: 4 } });
    assert.strictEqual(assetRes.status, 201, JSON.stringify(assetRes.body));

    const withAsset = await meeting('ana', id.alpha, { assetId: assetRes.body.asset.id });
    assert.strictEqual(withAsset.status, 400, JSON.stringify(withAsset.body));
    assert.strictEqual(withAsset.body.field, 'assetId');
    assert.match(withAsset.body.error, /not logged against an asset/i);

    const nonProject = await line('ana', { date: workingDay(), hours: 1,
      nonProject: 'leave', projectMeeting: true });
    assert.strictEqual(nonProject.status, 400, JSON.stringify(nonProject.body));
    assert.strictEqual(nonProject.body.field, 'projectId');

    /* BOTH FLAGS ON ONE LINE. tl_action already has a value spelled
       'project_meeting', so this is the combination somebody would reach for. */
    /* SENT BY SOMEBODY WHOSE TL ACTION WOULD OTHERWISE BE ACCEPTED — Lee holds
       the key and leads Alpha — so what refuses this line is the conflict
       itself and not a permission the sender happened to lack. */
    const both = await line('lee', { date: workingDay(), hours: 1, clientId: id.client,
      projectId: id.alpha, projectMeeting: true, tlAction: 'review' });
    assert.strictEqual(both.status, 400, JSON.stringify(both.body));
    assert.match(both.body.error, /either TL Action or Project Meeting, not both/i);

    // A project this person cannot see at all.
    /* A PROJECT THIS PERSON IS NOT ON AT ALL. Lee is a Team Lead whose scope
       is the projects they lead, so Beta is out of reach entirely. */
    const hidden = await meeting('lee', id.beta);
    assert.strictEqual(hidden.status, 403, JSON.stringify(hidden.body));
    assert.match(hidden.body.error, /not one of yours/i);
  });

  await t.test('the permission is required, and so is the switch', async () => {
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

    await revoke('game_artist', ['timesheet.project_meeting']);
    try {
      const refused = await meeting('ana', id.alpha);
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.match(refused.body.error, /permission to log Project Meeting/i);
    } finally {
      await grant('game_artist', ['timesheet.project_meeting']);
    }
    assert.strictEqual((await meeting('ana', id.alpha)).status, 201, 'and it works again');

    /* THE SWITCH OFF: new lines refused, lines already filed untouched. */
    const before = Number((await q(
      'SELECT COUNT(*) AS n FROM timesheet_entries WHERE project_meeting = 1'))[0].n);
    await setPolicy({ projectMeeting: false });
    try {
      const off = await meeting('ana', id.alpha);
      assert.strictEqual(off.status, 409, JSON.stringify(off.body));
      assert.match(off.body.error, /switched off/i);
      assert.match(off.body.error, /already filed are unaffected/i);
      assert.strictEqual(Number((await q(
        'SELECT COUNT(*) AS n FROM timesheet_entries WHERE project_meeting = 1'))[0].n),
      before, 'and the lines that exist still exist');
      /* AND THE LIST THE FORM DRAWS FROM IS EMPTY, so the box is not offered. */
      const week = await as('ana', `/timesheets/week?date=${workingDay()}`);
      assert.deepStrictEqual(week.body.projectMeetingProjects, []);
      assert.strictEqual(week.body.workingDay.projectMeeting, false);
    } finally {
      await setPolicy({ projectMeeting: true });
    }
  });

  await t.test('the hours obey the line rules and the exact-hours cap', async () => {
    const tooSmall = await meeting('ana', id.alpha, { hours: 0.1 });
    assert.strictEqual(tooSmall.status, 400, JSON.stringify(tooSmall.body));
    const tooBig = await meeting('ana', id.alpha, { hours: 30 });
    assert.strictEqual(tooBig.status, 400, JSON.stringify(tooBig.body));
    const none = await meeting('ana', id.alpha, { hours: 0 });
    assert.strictEqual(none.status, 400, JSON.stringify(none.body));

    /* THE EXACT-HOURS CAP FROM PROMPT 64B applies to a meeting line like any
       other: the day may not be filled past what is required. */
    const day = require('../src/timesheet-gate').shiftDays(workingDay(), 0);
    await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?',
      [people.ana, day]);
    await setPolicy({ hoursRuleEnabled: true, hoursRuleFrom: '2026-01-01' });
    try {
      const fits = await meeting('ana', id.alpha, { hours: 8 });
      assert.strictEqual(fits.status, 201, JSON.stringify(fits.body));
      const over = await meeting('ana', id.alpha, { hours: 1 });
      assert.strictEqual(over.status, 422, JSON.stringify(over.body),
        'the day is full; a meeting cannot push it over');
      await q('DELETE FROM timesheet_entries WHERE user_id = ? AND entry_date = ?',
        [people.ana, day]);
    } finally {
      await setPolicy({ hoursRuleEnabled: false });
    }
  });

  await t.test('an edit may fix the hours but not what kind of line it is', async () => {
    const made = await meeting('ana', id.alpha, { hours: 2, notes: 'kickoff' });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const lineId = made.body.entry.id;

    const hours = await as('ana', `/timesheets/entries/${lineId}`,
      { method: 'PATCH', body: { hours: 3 } });
    assert.strictEqual(hours.status, 200, JSON.stringify(hours.body));
    assert.strictEqual(Number((await q('SELECT hours FROM timesheet_entries WHERE id = ?',
      [lineId]))[0].hours), 3);

    const unflag = await as('ana', `/timesheets/entries/${lineId}`,
      { method: 'PATCH', body: { projectMeeting: false } });
    assert.strictEqual(unflag.status, 400, JSON.stringify(unflag.body));
    assert.match(unflag.body.error, /keeps the kind it was filed as/i);
    assert.strictEqual(Number((await q(
      'SELECT project_meeting FROM timesheet_entries WHERE id = ?', [lineId]))[0].project_meeting), 1);

    /* AND AN ORDINARY LINE CANNOT BECOME ONE, which is the other direction and
       the one that would skip every gate on the way in. */
    const plain = await line('ana', { date: workingDay(), hours: 1,
      clientId: id.client, projectId: id.alpha });
    assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
    const promote = await as('ana', `/timesheets/entries/${plain.body.entry.id}`,
      { method: 'PATCH', body: { projectMeeting: true } });
    assert.strictEqual(promote.status, 400, JSON.stringify(promote.body));
    assert.match(promote.body.error, /cannot become a Project Meeting line/i);
  });

  await t.test('it is labelled everywhere, and reaches no figure about an asset', async () => {
    const day = workingDay();
    /* ITS OWN LINE, filed here rather than found among the ones earlier
       subtests left behind — several of them delete Ana's day to test the
       hours cap, so "whatever is on the day by now" is not something this case
       should depend on. */
    const filed = await meeting('ana', id.alpha, { hours: 1.25, notes: 'standup' });
    assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));

    const week = await as('ana', `/timesheets/week?date=${day}`);
    const entries = (week.body.days.find((d) => d.date === day) || {}).entries || [];
    const mine = entries.find((e) => e.id === filed.body.entry.id);
    assert.ok(mine, `the line is in the week: ${JSON.stringify(entries.map((e) => e.id))}`);
    assert.strictEqual(mine.projectMeeting, true, 'and carries the flag');
    assert.strictEqual(mine.tlActionLabel, 'Project Meeting',
      'labelled by the shared function, not by the page');

    /* AND IT COUNTS IN THE PERSON'S OWN DAY, which is the point of filing it. */
    const dayHours = (week.body.days.find((d) => d.date === day) || {}).hours;
    assert.ok(Number(dayHours) > 0, 'the hours are in the day total');

    /* BUT NOT IN AN ASSET'S. hoursLoggedOn() is the one query that reads
       timesheet_entries.asset_id, and a meeting line is excluded from it by its
       flag — not by having no asset, which is a thing a form can stop being
       true. Proved by giving a row an asset_id directly, the way a converted
       row from an older build would carry one. */
    const asset = await as('root', `/assets/project/${id.alpha}`, { method: 'POST',
      body: { name: 'Measured', type: 'character', manHours: 4 } });
    const assetId = asset.body.asset.id;
    const made = await meeting('ana', id.alpha, { hours: 2 });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    await q('UPDATE timesheet_entries SET asset_id = ? WHERE id = ?', [assetId, made.body.entry.id]);

    const sheets = require('../src/timesheets');
    const handle = {
      async query(text, params = []) {
        const values = [];
        const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
          values.push(params[Number(n) - 1]); return '?';
        });
        const rows = await sql(cfg, translated, values.length ? values : params);
        return { rows: Array.isArray(rows) ? rows : [], result: rows };
      },
    };
    /* THE SIGNATURE IS (db, { assetId, userId, day }) — ONE options object.
       This was written as (db, userId, { assetId, date }), which destructures a
       string: every field came out undefined, `if (!assetId || !userId) return
       0` fired, and the assertion below passed for a reason that had nothing to
       do with meeting lines. A mutation that removed the exclusion entirely
       survived against it, which is how it was found. */
    const logged = await sheets.hoursLoggedOn(handle,
      { assetId, userId: people.ana, day });
    assert.strictEqual(logged, 0,
      'a meeting line carrying an asset_id is still not time on that asset');

    /* AND THE SUM IS REAL, not nought because the query found nothing to look
       at. An ORDINARY line on the same asset and day is counted — so the nought
       above is the exclusion working and not the call failing. */
    const ordinary = await line('ana', { date: day, hours: 1.5,
      clientId: id.client, projectId: id.alpha });
    assert.strictEqual(ordinary.status, 201, JSON.stringify(ordinary.body));
    await q('UPDATE timesheet_entries SET asset_id = ? WHERE id = ?',
      [assetId, ordinary.body.entry.id]);
    assert.strictEqual(
      await sheets.hoursLoggedOn(handle, { assetId, userId: people.ana, day }), 1.5,
      'an ordinary line on that asset IS counted, so the query is really looking');
  });
});
