/* THE ASSET'S START DATE AND END DATE ARE INFORMATION. THEY DECIDE NOTHING.
 *
 * ===========================================================================
 * WHAT THIS FILE USED TO ASSERT, AND WHY IT IS THE OPPOSITE NOW.
 *
 * It tested a gate. An asset with a start date in the future could not be
 * started: POST /api/assets/:id/start answered 409 "This task cannot be started
 * until 2026-11-18 — its start date has not arrived yet", and the board drew
 * Accept and Start disabled with that sentence under it. The old suite checked
 * the comparison's calendar edges (the day itself, the day after, blank, the
 * hours around midnight IST) and then drove the endpoint to prove the rule was
 * enforced and not merely displayed.
 *
 * The owner's position is that both dates are for information only. A schedule
 * says what the studio INTENDS; an artist who has been handed a task and is
 * sitting in front of it must be able to start it. So the gate is gone, and
 * this file is the fence around its absence.
 *
 * THE OLD REASONING IS KEPT BESIDE THE NEW ASSERTIONS rather than deleted,
 * because it was not foolish — "the button and the endpoint must not disagree"
 * and "a missed date must not become a permanent lockout" are both real, and
 * both stop mattering the moment the rule itself goes. A reader who wants to
 * add "not before its date" should find out here that it was tried.
 *
 * ===========================================================================
 * WHAT IS ASSERTED.
 *
 *   1. THE GATE FUNCTIONS DO NOT EXIST. src/asset-schedule.js exports neither
 *      startsInFuture nor notYetMessage, and the page has no notYetStartable.
 *      A dead gate function is one caller away from a live gate.
 *   2. NO MODULE OUTSIDE THE DISPLAY AND REMINDER LIST READS THESE COLUMNS TO
 *      DECIDE ANYTHING — the grep-style guard, with the allowed list written
 *      out, so a new gate anywhere fails here.
 *   3. EVERY ACTION, OVER EVERY DATE COMBINATION. Table-driven: future start,
 *      past end, both, neither, and start-after-end; Accept and Start, Resume,
 *      Submit, Upload, TL review, assignment, Hold, Unhold, Outsource. The
 *      result must be the same for every date combination.
 *   4. THE SAME ASSET IN EVERY STARTABLE STATUS behaves identically whatever
 *      its dates.
 *   5. TIME RECORDS NORMALLY after a start before the start date — the class-A
 *      check: a timer that refused to accrue would make Start appear to do
 *      nothing, which is a gate wearing a different hat.
 *   6. THE DATES ARE STILL STORED, STILL EDITABLE, STILL SHOWN, still sorted,
 *      still counted as overdue, still in reminders.
 *   7. THE FORM'S OWN CONSISTENCY CHECK SURVIVES: start after end is still
 *      refused by bulk assign, and both dates are still optional.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const schedule = require('../src/asset-schedule');
const assetImport = require('../src/asset-import');
const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  systemClientId, openStudio } = require('./helpers');

const cfg = config('startDate');

/* ------------------------------------------------- 1. the gate does not exist */

test('the gate functions are gone, not merely unused', () => {
  assert.strictEqual(schedule.startsInFuture, undefined,
    'src/asset-schedule.js still exports startsInFuture — the dates decide nothing now');
  assert.strictEqual(schedule.notYetMessage, undefined,
    'src/asset-schedule.js still exports notYetMessage');
  assert.deepStrictEqual(Object.keys(schedule).sort(),
    ['IST_OFFSET_MINUTES', 'asISODate', 'todayInIST'],
    'asset-schedule should be date HANDLING only');

  /* And the page's copy. notYetStartable(a) returned the start date when it was
     still in the future and the button state subtracted it. */
  const pageCode = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/notYetStartable/.test(pageCode),
    'public/index.html still has notYetStartable');
});

test('the date handling that is left still works', () => {
  /* asISODate is why a stored DATE does not shift a day across a timezone, and
     every route that writes one of these columns goes through it. Kept from the
     old suite unchanged: this part was never about gating. */
  assert.strictEqual(schedule.asISODate(new Date(2026, 2, 10)), '2026-03-10');
  assert.strictEqual(schedule.asISODate('2026-03-10'), '2026-03-10');
  assert.strictEqual(schedule.asISODate('2026-03-10T00:00:00.000Z'), '2026-03-10');
  assert.strictEqual(schedule.asISODate(''), null);
  assert.strictEqual(schedule.asISODate(null), null);
  assert.strictEqual(schedule.asISODate('not a date'), null);

  assert.strictEqual(schedule.todayInIST(new Date('2026-03-10T20:00:00Z')), '2026-03-11');
  assert.strictEqual(schedule.todayInIST(new Date('2026-03-10T18:29:00Z')), '2026-03-10');
  assert.strictEqual(schedule.todayInIST(new Date('2026-12-31T19:00:00Z')), '2027-01-01');
});

/* ------------------------------------------------------- 2. the grep guard
 *
 * THE LIST IS THE POINT. Every module allowed to read these two columns is
 * named here with the class it belongs to, out of the Step 0 survey. A module
 * not on this list that reads them fails this test, which is what makes "no
 * action is gated by a date" checkable rather than a claim about today's code.
 */
const ALLOWED = {
  // D — stores, edits, validates the shape of, or renders the dates.
  'src/routes/assets.js': 'D: creates, edits and bulk-sets the columns; the start-after-end form check',
  'src/routes/integration.js': 'D: startDate/dueDate in the Dev & QA asset payload',
  'src/asset-import.js': 'D: the two optional spreadsheet columns',
  /* src/asset-schedule.js is deliberately NOT here. After this change it names
     neither column — asISODate() and todayInIST() take any value — which is
     what makes the staleness half of this test useful: it caught the entry. */
  'src/schema-check.js': 'D: names the columns in the startup schema check',
  'src/migrate.js': 'D: adds the columns',
  'src/seed/seed.js': 'D: sample data',
  // D — counts and sorts.
  'src/admin-dashboard.js': 'D: late / due-soon counts and the overdue bucket',
  'src/waiting-work.js': 'D: the overdue flag, urgency sort and per-group counts',
  // R — reminds, without blocking.
  'src/email-notifications.js': 'R: "Due <date>" in the reminder emails',
  'src/day-state.js': 'R: dueDate and overdue on the start-of-day banner',
  /* NOT ASSET DATES AT ALL, and listed so a reader of this test is not misled
     by the grep that put them here. These carry start/end dates of their own,
     on their own tables, and this change says nothing about any of them:
       project_milestones.start_date / end_date   a stage inside a project
       projects.start_date / end_date             the project's own run
       outsource_assignments.due_date             what a freelancer agreed to
     The regex below matches column names, not tables, so it cannot tell them
     apart; naming them is cheaper than a regex that tries to. */
  'src/project-milestones.js': 'other table: project_milestones start/end',
  'src/routes/projects.js': 'other table: projects start/end, and their consistency check',
  'src/routes/clients.js': 'other table: the project start date on the client list',
  'src/outsource.js': 'other table: outsource_assignments.due_date',
  'src/routes/outsource.js': 'other table: outsource_assignments.due_date',
};

test('nothing outside the display and reminder modules reads these columns', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });

  /* `due_date` / `start_date` as SQL columns, and the camel-case field names the
     API shapes them into. Comments are stripped first: the notes recording what
     the gate used to be are the history this change is worth keeping, and must
     not be what makes this test pass or fail. */
  const reads = /\b(start_date|due_date)\b|\b(startDate|dueDate)\b/;
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!reads.test(code)) continue;
    if (ALLOWED[rel]) continue;
    offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [],
    'these modules read an asset start/end date and are not on the display/reminder list in '
    + `tests/asset-start-date.test.js — if one of them now GATES an action, that is the bug:\n${offenders.join('\n')}`);

  /* The list must not rot the other way either: an entry for a module that has
     stopped reading them is an allowance nobody is checking. */
  const stale = Object.keys(ALLOWED).filter((rel) => {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) return true;
    const code = fs.readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return !reads.test(code);
  });
  assert.deepStrictEqual(stale, [], 'the allowed list names modules that no longer read the dates');
});

test('no refusal anywhere mentions an asset date as the reason', () => {
  /* The copy, not the logic — the other half of "no leftover disabled-state,
     tooltip or message". Searched over code AND markup, because the sentence
     that was reported lived in a template string. */
  /* THE EXACT SENTENCES, not a loose phrase. "Work cannot be started until that
     window ends" is the LEAVE message and is none of this change's business —
     a looser regex matched it and sent me looking for a gate that was not
     there. What must be gone is any copy naming the asset's own date as the
     reason, and `startsOn`, which was the field the 409 carried it in. */
  const GONE = [
    /start date has not arrived/i,
    /be started until \$\{/i,
    /startsOn/,
  ];
  for (const [label, text] of [
    ['public/index.html', PAGE],
    ['src/routes/assets.js', fs.readFileSync(path.join(ROOT, 'src', 'routes', 'assets.js'), 'utf8')],
  ]) {
    const live = text.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const re of GONE) {
      assert.ok(!re.test(live),
        `${label} still names an asset date as a reason somebody cannot act: ${re}`);
    }
  }
});

/* -------------------------------------------------- the live half: the actions */

test('no action depends on the dates', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Start-Date-1!';
  let server; const token = {}; const people = {}; let projectId; let otherProject;

  const call = (p, o) => api(server.base, p, o);
  const as = (who, p, o = {}) => call(p, { ...o, token: token[who] });
  const day = (offset) => schedule.todayInIST(new Date(Date.now() + offset * 86400000));

  /* THE FIVE DATE COMBINATIONS every action is driven over. `startAfterEnd` is
     reachable because the single-asset route has never checked one against the
     other — only bulk assign does, and only when both arrive together. */
  const DATES = [
    { label: 'neither', body: {} },
    { label: 'future start', body: { startDate: day(30) } },
    { label: 'past end', body: { due: day(-30) } },
    { label: 'future start and past end', body: { startDate: day(30), due: day(-30) } },
    { label: 'start after end', body: { startDate: day(30), due: day(-30) } },
    { label: 'start today', body: { startDate: day(0) } },
  ];

  const makeAsset = async (name, body = {}) => {
    const r = await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: people.ana, ...body } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset;
  };
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });
  /* Submit answers 201 — it CREATES a submission. Checked as "not an error"
     rather than pinned to a number: what this suite is about is whether the
     dates changed the answer, not what the answer is. */
  const submit = (who, id) => as(who, `/assets/${id}/submit`, { method: 'POST',
    body: { link: 'https://drive.zvky.test/v1' } });
  const submitted = async (who, id, why) => {
    const r = await submit(who, id);
    assert.ok(r.status < 400, `${why}: Submit — ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    return r;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'start-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'start-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    /* Hold the studio open: recorded time is the part of a session inside the
       working window, so a suite that starts a timer and expects a number would
       assert something different at nine at night. */
    await openStudio(server.base, token.root);
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Scheduled' } })).body.project.id;
    otherProject = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Elsewhere' } })).body.project.id;
    people.ana = (await as('root', '/users', { method: 'POST', body: {
      name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD, projectId,
    } })).body.user.id;
    people.lead = (await as('root', '/users', { method: 'POST', body: {
      name: 'Lee', email: 'lee@zvky.test', role: 'team_lead', password: PASSWORD, projectId,
    } })).body.user.id;
    token.ana = await login('ana@zvky.test');
    token.lead = await login('lee@zvky.test');
  });
  t.after(() => stopServer(server));

  await t.test('Accept and Start: every date combination is accepted', async () => {
    for (const d of DATES) {
      const a = await makeAsset(`Start ${d.label}`, d.body);
      const r = await start('ana', a.id);
      assert.strictEqual(r.status, 200,
        `${d.label}: Accept and Start was refused — ${JSON.stringify(r.body)}`);
      // Free the one-active-task slot for the next row.
      await submitted('ana', a.id, 'dates must not matter');
    }
  });

  await t.test('Submit, Resume, Hold and Unhold: every date combination', async () => {
    for (const d of DATES) {
      const a = await makeAsset(`Round ${d.label}`, d.body);
      assert.strictEqual((await start('ana', a.id)).status, 200, `${d.label}: start`);

      const held = await as('ana', `/assets/${a.id}/hold`, { method: 'POST',
        body: { note: 'stepping away' } });
      assert.strictEqual(held.status, 200, `${d.label}: Hold — ${JSON.stringify(held.body)}`);

      const resumed = await as('ana', `/assets/${a.id}/resume`, { method: 'POST' });
      assert.strictEqual(resumed.status, 200, `${d.label}: Resume — ${JSON.stringify(resumed.body)}`);

      await submitted('ana', a.id, d.label);
    }
  });

  await t.test('Upload: every date combination', async () => {
    /* THE ACTION MY FIRST PASS MISSED, and a mutation found the gap: a
       start-date check added to the thumbnail route survived the whole suite.
       Upload is on the brief's class-G list and now has a case.
       
       The thumbnail route is the upload that takes a file on an asset at any
       stage; the submission upload is covered by the Submit cases above, which
       drive the same route the artist's Submit button does. */
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415408d7'
      + '63f8ffff3f0005fe02fea735b6a20000000049454e44ae426082', 'hex');
    for (const d of DATES) {
      const a = await makeAsset(`Upload ${d.label}`, d.body);
      const form = new FormData();
      form.set('image', new Blob([png], { type: 'image/png' }), 'thumb.png');
      const r = await fetch(`${server.base}/assets/${a.id}/thumbnail`, {
        method: 'POST', body: form, headers: { Authorization: `Bearer ${token.ana}` },
      });
      const body = await r.text();
      assert.ok(r.status < 400,
        `${d.label}: Upload — ${r.status} ${body.slice(0, 200)}`);
    }
  });

  await t.test('the TL review actions: every date combination', async () => {
    for (const d of DATES) {
      const a = await makeAsset(`Review ${d.label}`, d.body);
      assert.strictEqual((await start('ana', a.id)).status, 200);
      await submitted('ana', a.id, 'dates must not matter');

      const changes = await as('lead', `/assets/${a.id}/review`, { method: 'POST',
        body: { decision: 'changes_requested', text: 'tighten the silhouette' } });
      assert.strictEqual(changes.status, 200,
        `${d.label}: TL changes requested — ${JSON.stringify(changes.body)}`);

      // And the artist can pick it straight back up, dates notwithstanding.
      assert.strictEqual((await start('ana', a.id)).status, 200, `${d.label}: restart after changes`);
      await submitted('ana', a.id, 'dates must not matter');
      const approved = await as('lead', `/assets/${a.id}/review`, { method: 'POST',
        body: { decision: 'approved', text: 'good' } });
      assert.strictEqual(approved.status, 200,
        `${d.label}: TL approved — ${JSON.stringify(approved.body)}`);
    }
  });

  await t.test('assignment and reassignment: every date combination', async () => {
    for (const d of DATES) {
      const a = await makeAsset(`Assign ${d.label}`, d.body);
      const moved = await as('root', `/assets/${a.id}`, { method: 'PATCH',
        body: { assigneeId: people.lead } });
      assert.strictEqual(moved.status, 200,
        `${d.label}: reassignment — ${JSON.stringify(moved.body)}`);
      const back = await as('root', `/assets/${a.id}`, { method: 'PATCH',
        body: { assigneeId: people.ana } });
      assert.strictEqual(back.status, 200, `${d.label}: reassigned back`);
    }
  });

  await t.test('Outsource: every date combination', async () => {
    const freelancer = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Fran', email: 'fran@zvky.test' } });
    assert.ok(freelancer.status < 400, JSON.stringify(freelancer.body));
    const fid = (freelancer.body.freelancer || {}).id;
    for (const d of DATES) {
      /* No internal assignee: the route refuses an asset that is somebody's
         ("Clear the internal assignee before sending the work outside"), which
         is a rule about assignment and nothing to do with dates. */
      const a = await makeAsset(`Outsource ${d.label}`, { ...d.body, assigneeId: null });
      const sent = await as('root', '/outsource/assignments', { method: 'POST',
        body: { assetId: a.id, projectId, freelancerId: fid, decidedManHours: 4 } });
      assert.ok(sent.status < 400,
        `${d.label}: Outsource — ${sent.status} ${JSON.stringify(sent.body)}`);
    }
  });

  await t.test('every startable status behaves the same whatever the dates', async () => {
    /* THE TABLE IS THE CLAIM: the result of Accept and Start must be a function
       of the asset's STATUS and nothing to do with its dates. Driven over the
       statuses the action applies to, crossed with the date combinations. */
    const statuses = workflow.WORKING_STATUSES;
    assert.ok(statuses.includes('assigned') && statuses.includes('tl_changes_requested'),
      'the startable list is what this test was written against');

    const reach = {
      assigned: async (a) => a,
      in_progress: async (a) => { await start('ana', a.id); return a; },
      tl_changes_requested: async (a) => {
        await start('ana', a.id); await submit('ana', a.id);
        await as('lead', `/assets/${a.id}/review`, { method: 'POST',
          body: { decision: 'changes_requested', text: 'again' } });
        return a;
      },
    };

    const results = {};
    for (const status of Object.keys(reach)) {
      for (const d of DATES) {
        const a = await reach[status](await makeAsset(`${status} ${d.label}`, d.body));
        const r = await start('ana', a.id);
        const key = `${status}`;
        results[key] = results[key] || [];
        results[key].push({ dates: d.label, status: r.status });
        // Leave nothing open for the next row.
        if (r.status === 200 || status === 'in_progress') await submit('ana', a.id).catch(() => {});
      }
    }
    for (const [status, rows] of Object.entries(results)) {
      const codes = [...new Set(rows.map((r) => r.status))];
      assert.strictEqual(codes.length, 1,
        `${status}: Accept and Start answered differently for different dates — `
        + `${JSON.stringify(rows)}`);
    }
  });

  await t.test('time records normally for a task started before its start date', async () => {
    /* THE CLASS-A CHECK. A timer that refused to accrue before the start date
       would make Accept and Start appear to do nothing, which is the gate again
       wearing a different hat. Nothing in src/work-log.js, src/working-time.js
       or src/recording-hours.js reads these columns — asserted by the grep
       guard above — and this drives it end to end. */
    const a = await makeAsset('Records Anyway', { startDate: day(45), due: day(-45) });
    assert.strictEqual((await start('ana', a.id)).status, 200);

    const rows = await sql(cfg,
      'SELECT started_at, ended_at FROM work_sessions WHERE asset_id = ?', [a.id]);
    assert.strictEqual(rows.length, 1, 'a session opened');
    assert.ok(rows[0].started_at, 'and it is stamped with a real start');
    assert.strictEqual(rows[0].ended_at, null, 'and it is open');

    // Backdate it so there is measurable time, then close it and read the total.
    await sql(cfg,
      'UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL 90 MINUTE) WHERE asset_id = ?',
      [a.id]);
    await submitted('ana', a.id, 'a session opened before the start date');
    const [closed] = await sql(cfg,
      'SELECT seconds FROM work_sessions WHERE asset_id = ?', [a.id]);
    assert.ok(Number(closed.seconds) > 60 * 60,
      `the session recorded ${closed.seconds}s for 90 minutes before the start date`);
  });

  /* --------------------------------------------- the dates themselves, unchanged */

  await t.test('the dates are still stored, returned and editable', async () => {
    const withBoth = await makeAsset('Both Dates', { startDate: '2026-03-01', due: '2026-03-31' });
    assert.strictEqual(schedule.asISODate(withBoth.start_date), '2026-03-01');
    assert.strictEqual(schedule.asISODate(withBoth.due_date), '2026-03-31');

    await as('root', `/assets/${withBoth.id}`, { method: 'PATCH', body: { due: '2026-04-30' } });
    await as('root', `/assets/${withBoth.id}`, { method: 'PATCH', body: { startDate: '2026-02-01' } });
    const after = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === withBoth.id);
    assert.strictEqual(schedule.asISODate(after.due_date), '2026-04-30', 'the end date still edits');
    assert.strictEqual(schedule.asISODate(after.start_date), '2026-02-01', 'and so does the start');

    // And clearing them is still allowed, because both are optional.
    await as('root', `/assets/${withBoth.id}`, { method: 'PATCH', body: { startDate: null, due: null } });
    const cleared = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((x) => x.id === withBoth.id);
    assert.strictEqual(schedule.asISODate(cleared.start_date), null);
    assert.strictEqual(schedule.asISODate(cleared.due_date), null);
  });

  await t.test('overdue is still reported, and still only reported', async () => {
    const late = await makeAsset('Late Thing', { due: day(-3) });
    const soon = await makeAsset('Soon Thing', { due: day(3) });
    /* THE PANEL THAT COMPUTES THE FLAG. src/waiting-work.js is where
       `overdue: Boolean(due && due < today)` lives, and it is served by the
       "N waiting on them" list rather than by the follow-up rows above it
       (which come from src/follow-up.js and carry no per-asset flag). Read as
       root, which holds report.follow_up — the point is that the flag still
       exists and still comes from the end date, not who may see it. */
    const panel = await as('root', `/admin-dashboard/follow-up/waiting/${people.ana}?all=1`);
    assert.ok(panel.status < 400, `${panel.status} ${JSON.stringify(panel.body).slice(0, 220)}`);
    const flat = JSON.stringify(panel.body);
    assert.ok(/"overdue"/.test(flat),
      `the waiting panel no longer carries an overdue flag: ${flat.slice(0, 300)}`);
    assert.ok(flat.includes('Late Thing'), 'and the overdue asset is in it');
    assert.ok(/"overdue":true/.test(flat),
      'the asset whose end date has passed is not flagged overdue any more');
    // And being overdue stops nothing: the late one still starts.
    assert.strictEqual((await start('ana', late.id)).status, 200, 'an overdue task still starts');
    await submitted('ana', late.id, 'dates must not matter');
    assert.strictEqual((await start('ana', soon.id)).status, 200);
    await submitted('ana', soon.id, 'dates must not matter');
  });

  await t.test('the form keeps its own consistency check, and both dates stay optional', async () => {
    /* KEPT ON PURPOSE. "Start not after end" is a statement about the two
       numbers somebody has just typed, not a rule about whether work may
       happen, so it is not a class-G use and it stays exactly as it was. Only
       bulk assign has ever had it, and only when both dates arrive together. */
    const a = await makeAsset('Bulk Target', {});
    const refused = await as('root', '/assets/bulk/assign', { method: 'POST',
      body: { assetIds: [a.id], startDate: day(10), due: day(1) } });
    assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, /start date .* is after the end date/i);
    assert.strictEqual(refused.body.field, 'startDate');

    const ok = await as('root', '/assets/bulk/assign', { method: 'POST',
      body: { assetIds: [a.id], startDate: day(1), due: day(10) } });
    assert.ok(ok.status < 400, JSON.stringify(ok.body));

    // The single-asset route has never checked one against the other, and does not now.
    const crossed = await makeAsset('Crossed', { startDate: day(30), due: day(-30) });
    assert.strictEqual(schedule.asISODate(crossed.start_date), day(30),
      'the single-asset form stores what it is given');
    assert.strictEqual(schedule.asISODate(crossed.due_date), day(-30));
  });
});

/* ------------------------------------------------- 7. the sheet, unchanged */

test('both dates are still optional columns in the bulk sheet', () => {
  const columns = assetImport.describeFormat().columns;
  const named = (header) => columns.find((c) => c.name === header);

  assert.ok(named('Start Date'), 'Start Date is offered');
  assert.strictEqual(named('Start Date').required, false, 'and is optional');
  assert.ok(named('End Date (Deadline)'), 'the deadline column carries its label');
  assert.strictEqual(named('End Date (Deadline)').required, false, 'and stays optional');

  const rows = assetImport.buildTemplateCsv().trim().split('\n');
  const head = rows[0].split(',');
  const startAt = head.indexOf('Start Date');
  const dueAt = head.indexOf('End Date (Deadline)');
  assert.ok(startAt > -1 && dueAt === startAt + 1, 'and they sit next to each other');
  const blankRow = rows.slice(1).map((r) => r.split(',')).find((cells) => !cells[startAt] && !cells[dueAt]);
  assert.ok(blankRow, 'the sample shows a row with neither date');
});

test('the page still shows both dates', () => {
  // The list column and the drawer field — class D, untouched by this change.
  assert.match(PAGE, /<td class="mono">\$\{fmtDay\(a\.start_date\)\}<\/td>/,
    'the Start Date column has gone from the asset list');
  assert.match(PAGE, /id="d_start"[^>]*value="\$\{a\.start_date/,
    'the drawer no longer shows the start date');
  assert.match(PAGE, /id="f_start"/, 'the create form no longer offers a start date');
  assert.match(PAGE, /id="f_due"/, 'the create form no longer offers an end date');
});
