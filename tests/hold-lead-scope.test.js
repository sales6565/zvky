/* Holding a project-mate's task: the Supervision group, their own projects, nothing wider.
 *
 * WHAT THIS IS NOT. It is not a permission fix. asset.hold is impliedBy: () => true, so
 * every designation has always held it — a lead who could not pause a teammate's timer was
 * never missing a permission, and tests/hold-permission.test.js proved the two gates already
 * agreed about it. The gate was `mine`: the asset had to be assigned to you. That was
 * deliberate and the route said so. This is the studio widening it.
 *
 * THE SET WIDENED FROM FOUR NAMED KEYS TO THE GROUP, and that reverses an assertion this
 * file used to make in as many words. Worth reading before changing it back:
 *
 *   Prompt 20 named four designations — team_lead, associate_team_lead, art_supervisor,
 *   associate_animation_supervisor — because four were asked for, and this file pinned the
 *   exclusion of the other two in the Supervision group so that widening to the group could
 *   not happen by a quiet edit. It has now happened by a loud one: the third report of this
 *   button asked for "anyone in the Supervisor group", and the measured consequence of the
 *   narrower set was a Senior Team Lead on a project being refused a timer that a Team Lead
 *   on the same project could stop. That is not a defensible line, and a hardcoded list of
 *   designation keys is against this project's standing rule anyway.
 *
 *   So the rule reads the catalogue's Supervision GROUP, which means a designation a Super
 *   Admin moves into Supervision carries this authority without a deploy. Creative Direction
 *   is still excluded, which is the one judgement left in it — see HOLD_GROUP in
 *   src/asset-hold.js.
 *
 * There is no plain `animation_supervisor`; the animation side is
 * `associate_animation_supervisor`. Pinned below, so a catalogue change fails here.
 *
 * AND THE SCOPE HALF IS STILL THE POINT. Without it this would read "any lead may stop any
 * timer in the studio", which is a much larger authority than the one asked for. The
 * mutation that drops it is the one this file exists to catch.
 *
 * ---------------------------------------------------------------------------
 * THE FOURTH REPORT MOVED BOTH HALVES, and reverses two more assertions this file used to
 * make. Worth reading before changing either back:
 *
 *   THE SET IS NOW A PERMISSION, asset.hold_any, impliedBy has('leadsTeam'). The group
 *   test was still a string comparison against the catalogue — 'Supervision' — and a
 *   studio with a designation called "Team Lead - Art", or one that renames an existing
 *   one, falls straight out of it. A key is granted and revoked per designation in
 *   Settings, which is where this decision belongs. The practical difference on the
 *   shipped catalogue is one designation: associate_art_director, which carries the lead
 *   tier and runs a team, now holds it by default. The judgement that used to exclude it
 *   was "an art director is neither a team lead nor a supervisor" — true of the title, and
 *   beside the point now that the rule is about what somebody's own dashboard shows them.
 *
 *   THE SCOPE IS NOW THE DASHBOARD'S, not the two project membership tables. Measured on
 *   a Team Lead built the way production builds one — a designation of team_lead with two
 *   artists reporting to them: their dashboard showed three projects and one was
 *   holdable, because leadOrSupervisorProjects read project_team_leads and
 *   project_supervision while visibleProjects() also matches a coordinator row, project
 *   ownership, and a direct report with work in the project. The last of those is the
 *   ordinary way a Team Lead comes to see a project at all. tests/hold-visibility.test.js
 *   is the matrix and the parity property; what is left here is the set and the wiring.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const perms = require('../src/permissions');
const assetHold = require('../src/asset-hold');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('holdscope');
const PASSWORD = 'HoldScope-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the named set, against the catalogue -----------------------------------

test('the set is a permission on the designations that run a team', () => {
  const keys = ROLES.map((r) => r.key);
  const may = perms.holdOthersRoles();
  for (const key of may) assert.ok(keys.includes(key), `${key} is a real designation`);

  /* FOUND THROUGH `leadsTeam`, which is the capability src/role-tiers.js already uses to
     mean "runs a team" and the one src/role-permissions.js reads in fillsAProjectTeamList.
     On the shipped catalogue that is the seven lead-tier designations. */
  const leadTier = ROLES.filter((r) => r.tier === 'lead').map((r) => r.key);
  assert.deepStrictEqual([...may].sort(), [...leadTier].sort(),
    'every designation that runs a team starts with the key, and nobody else does');

  /* THE SIX IN SUPERVISION, named so that re-narrowing the rule is also a decision with an
     assertion to answer — in whichever direction it goes next. The two Prompt 20 left out
     are among them and stay in. */
  const supervision = ROLES.filter((r) => r.group === 'Supervision').map((r) => r.key);
  assert.strictEqual(supervision.length, 6, 'the Supervision group holds six');
  for (const key of supervision) {
    assert.ok(may.includes(key), `${key} is in Supervision and holds the key`);
  }
  for (const wasExcluded of ['senior_team_lead', 'technical_manager']) {
    assert.ok(may.includes(wasExcluded),
      `${wasExcluded} holds the same authority as a Team Lead`);
  }

  /* AND THE ONE THE GROUP TEST USED TO EXCLUDE. This assertion is the reverse of the one
     it replaces, deliberately: see the header. An Associate Art Director carries the lead
     tier, reviews at the TL stage, and has a `team` project scope — so their dashboard is
     a lead's dashboard, and the rule is now about what a dashboard shows. */
  assert.ok(may.includes('associate_art_director'),
    'a designation that runs a team holds it whatever department it is filed under');

  /* NOTHING THAT DOES NOT RUN A TEAM, which is what stops the widening creeping. Full
     access is the one worth stating: projectScope 'all' plus this key would be every timer
     in the studio, so it is an explicit grant in Settings rather than a side effect. */
  for (const outside of ['game_artist', 'coordinator', 'admin', 'art_director',
    'head_of_production', 'managing_director_ceo', 'producer']) {
    assert.ok(!may.includes(outside), `${outside} must not hold it by default`);
  }

  /* NO STRING COMPARISON LEFT. The group test is gone from the rule — a designation named
     "Team Lead - Art" matched nothing — and there is no designation key or group name
     anywhere in src/asset-hold.js for a mutation to mis-case. */
  const holdSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-hold.js'), 'utf8');
  const code = holdSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const leak of ['Supervision', 'team_lead', 'art_supervisor', 'leadsTeam',
    'project_team_leads']) {
    assert.ok(!code.includes(leak),
      `src/asset-hold.js must not name ${leak} — the rule is a permission, not a title`);
  }
  assert.match(code, /holdsAny/, 'it reads the key through a fact passed in');
  assert.match(code, /onDashboard/, 'and the dashboard answer, also passed in');

  // And the catalogue has no plain animation_supervisor, which is why the associate is named.
  assert.ok(!keys.includes('animation_supervisor'),
    'there is no animation_supervisor — associate_animation_supervisor is the animation seat');

  /* THE KEY IS GRANTABLE, which is the whole reason it is a key. A Super Admin switches it
     on for a designation nobody anticipated, and off for one that should not have it. */
  const catalog = require('../src/permission-catalog');
  assert.ok(catalog.isPermission('asset.hold_any'));
  assert.ok(catalog.grantableKeys().includes('asset.hold_any'),
    'and a studio can hand it out, or take it away, in Settings');
  assert.ok(catalog.ALL.find((pp) => pp.key === 'asset.hold').impliedBy({}),
    'asset.hold stays on for everybody — hold_any is additive, not a replacement');
});

test('one function decides it, and the page draws the answer it is given', () => {
  /* THE SHAPE THIS THREAD KEEPS FINDING, and the third report is what it cost: the rule was
     written out THREE times — canHoldAsset on the routes, mayHoldOthers in the payload
     decoration, and `(mine || can_hold_others) && work_open && !held.byStudio` on the page.
     All three agreed. What none of them carried was the REASON, so every refusal reached a
     person as a button that was not there.
     
     src/asset-hold.js is now the only statement of it; the routes and the decoration call
     it, and the page renders hold_state. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  assert.match(route, /assetHold\.decide\(action, facts\)/,
    'the routes ask the shared rule, with the action they are performing');
  assert.match(route, /holdableAsset\(req, res, 'hold'\)/, 'hold passes its action');
  assert.match(route, /holdableAsset\(req, res, 'resume'\)/, 'and so does resume');
  assert.match(route, /assetHold\.state\(await holdFactsFor\(viewer, a, \{/,
    'and every asset row carries the same decision for the browser');
  assert.match(route, /hold_state: holdStates\.get\(a\.id\)/);
  /* DECORATED FROM THE DASHBOARD'S OWN VISIBILITY, which is the fourth report's fix. It
     used to read `leadsProject: ledByViewer.has(a.project_id)` — the two project
     membership tables — while the board that produced the row was scoped by
     visibleProjects(). One function answers both now. */
  assert.match(route, /dashboardProjects\(viewer\)/,
    'the board asks the same visibility it is itself scoped by');
  assert.match(route, /onDashboard: visibleToViewer === null/,
    'and each row is decorated from that one answer');
  /* Comments stripped: the note beside the new call explains what it replaced, and
     naming the old function there is the point of the note. */
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/leadOrSupervisorProjects/.test(routeCode),
    'the membership-table scope is gone from the board');

  /* NO SECOND COPY ANYWHERE. The old hand-written conditions are gone from both the route
     and the page; what is left on each side is a call and a render. */
  assert.ok(!/HOLD_OTHERS_ROLES/.test(route), 'the hardcoded designation list is gone');
  assert.ok(!/mayHoldOthers/.test(route), 'and so is the second copy it was used by');

  /* AND THE PAGE RECOMPUTES NOTHING AT ALL NOW. It used to fall back to
     `mine && can('asset.hold') && a.work_open` for an undecorated row, which was a fourth
     copy of the rule — right for the assignee and silently wrong for their lead. The server
     always sends an answer, including an explicit "unknown" when its own query failed, so
     the fallback has nothing left to be for. */
  assert.match(PAGE, /const hs = a\.hold_state \|\| UNKNOWN_HOLD_STATE;/,
    'the page reads the server\'s answer, or says it has none');
  assert.match(PAGE, /const canHold = hs\.canHold;/);
  assert.match(PAGE, /const canResume = hs\.canResume;/);
  assert.ok(!/fallbackHold/.test(PAGE), 'the local recomputation is gone');
  assert.ok(!/fallbackResume/.test(PAGE));
  /* No designation list and no project query on the page: if either appears, the browser has
     acquired a copy of a rule it cannot answer correctly. */
  const at = PAGE.indexOf('const hs = a.hold_state || UNKNOWN_HOLD_STATE;');
  assert.ok(at !== -1);
  const around = PAGE.slice(at - 1400, at + 1200).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const leak of ['team_lead', 'art_supervisor', 'Supervision', 'project_team_leads',
    'leadsTeam', 'visibleProjects']) {
    assert.ok(!around.includes(leak), `the page must not name ${leak}`);
  }
});

test('canHoldAsset asks for the permission FIRST, before it asks the database', () => {
  /* DEFENCE IN DEPTH, and the assertion that keeps it. Both of today's callers check
     asset.hold themselves — the route through requirePermission, the decoration in
     mayHoldOthers — so deleting the check inside the helper changes nothing observable
     through either, and a mutation that removed it survived every behavioural test here.
     It is worth keeping anyway: the helper is exported, and the next caller may not have a
     requirePermission in front of it.
   *
   * Pinned by the short-circuit rather than by reading the source. This test process has no
   * database connection, so if the permission check were removed the call would fall through
   * to leadOrSupervisorProjects and reject; resolving to plain `false` proves it answered
   * without asking. */
  const asset = { assignee_id: 'someone-else', project_id: 'p1' };
  const withoutHold = { id: 'u1', role: 'team_lead', permissions: ['asset.edit'] };
  return perms.canHoldAsset(withoutHold, asset).then((answer) => {
    assert.strictEqual(answer, false,
      'a designation without asset.hold is refused by the helper itself');
  }, (err) => {
    assert.fail('canHoldAsset reached the database before checking the permission: '
      + (err && err.message));
  });
});

test('canHoldAsset short-circuits on the things it can answer without a query', () => {
  /* The other cheap refusals, for the same reason: each must answer before any query. An
     unassigned asset has nobody to hold it FOR, and a designation outside the named set is
     refused on the strength of its role alone. */
  const held = { id: 'u1', role: 'team_lead', permissions: ['asset.hold'] };
  const cases = [
    ['no asset', held, null],
    ['unassigned asset', held, { assignee_id: null, project_id: 'p1' }],
    /* Outside the group now means outside it: a Game Artist, not a Senior Team Lead, who
       is in Supervision and is allowed. */
    ['designation outside the group', { id: 'u2', role: 'game_artist', permissions: ['asset.hold'] },
      { assignee_id: 'x', project_id: 'p1' }],
  ];
  return Promise.all(cases.map(([label, user, asset]) =>
    perms.canHoldAsset(user, asset).then((answer) => {
      assert.strictEqual(answer, false, `${label} is refused`);
    }, (err) => {
      assert.fail(`${label} reached the database: ${err && err.message}`);
    })));
});

// --- against a live server ---------------------------------------------------

test('a lead holds a project-mate\'s task; everybody else is unchanged',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* WHAT THE PAGE WOULD DRAW, from the page's own lines and the server's own answer.
     Lifted rather than restated: the point of the change is that the browser has no rule
     of its own, so this reads the three lines that turn hold_state into a control. */
  const buttonFor = async (who, assetId, projectId) => {
    const board = await as(who, `/assets/project/${projectId}`);
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));
    const row = (board.body.assets || []).find((x) => x.id === assetId);
    assert.ok(row, `${who} can see the asset at all`);
    const me = await as(who, '/auth/me');
    const from = PAGE.indexOf('const hs = a.hold_state || UNKNOWN_HOLD_STATE;');
    const to = PAGE.indexOf('const resumeWhy =', from);
    const lines = PAGE.slice(from, PAGE.indexOf(';', to) + 1);
    // eslint-disable-next-line no-new-func
    return new Function('mine', 'a', 'can', 'held', 'UNKNOWN_HOLD_STATE',
      `${lines} return canHold;`)(
      row.assignee_id === me.body.user.id, row,
      (k) => (me.body.user.permissions || []).includes(k), row.held || null,
      /* The page's own constant, so the lifted lines behave as they do in the browser.
         Reaching it means the payload carried no answer, which is a bug in the server
         rather than a decision — it draws a disabled control saying so. */
      { canHold: false, canResume: false, hold: { offer: true }, resume: { offer: true } });
  };
  const holdAs = (who, assetId) => as(who, `/assets/${assetId}/hold`, { method: 'POST' });
  const openSession = async (assetId) => (await sql(cfg,
    'SELECT ended_reason FROM work_sessions WHERE asset_id = ? ORDER BY started_at DESC LIMIT 1',
    [assetId]))[0];

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'hs-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'hs-boot', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* Hold reads the held state from the SCHEDULE, not the sweep — see the note in
       tests/hold-permission.test.js. Without this the shipped lunch blackout puts the
       session down and every assertion here fails for the wrong reason. */
    await openStudio(server.base, tok.root);

    const mk = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tok[who] = await login(email);
      return r.body.user.id;
    };
    id.artist = await mk('artist', 'artist@zvky.test', 'game_artist');
    id.lead = await mk('lead', 'lead@zvky.test', 'team_lead');
    id.assocLead = await mk('assocLead', 'assoc@zvky.test', 'associate_team_lead');
    id.artSup = await mk('artSup', 'artsup@zvky.test', 'art_supervisor');
    id.animSup = await mk('animSup', 'animsup@zvky.test', 'associate_animation_supervisor');
    /* NOT asked for, and in the same group — the pair that must stay mine-only. */
    id.seniorLead = await mk('seniorLead', 'senior@zvky.test', 'senior_team_lead');
    id.techMgr = await mk('techMgr', 'tech@zvky.test', 'technical_manager');
    /* A lead on a DIFFERENT project, to prove the scope half. */
    id.otherLead = await mk('otherLead', 'other@zvky.test', 'team_lead');

    const clients = await as('root', '/clients');
    const mine = await as('root', '/projects', { method: 'POST',
      body: { name: 'Theirs To Lead', clientId: clients.body.clients[0].id,
        teamLeadIds: [id.lead, id.assocLead, id.seniorLead, id.techMgr],
        supervisionIds: [id.artSup, id.animSup] } });
    assert.strictEqual(mine.status, 201, JSON.stringify(mine.body));
    id.project = mine.body.project.id;

    const elsewhere = await as('root', '/projects', { method: 'POST',
      body: { name: 'Somebody Else\'s', clientId: clients.body.clients[0].id,
        teamLeadIds: [id.otherLead] } });
    id.otherProject = elsewhere.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* Leave nothing of the artist's open for the next case to trip over.
   *
   * One active task at a time is an ordinary rule of this app, and each case here leaves the
   * artist mid-stretch on purpose — held or running. Settled through the database rather than
   * the API so tidying up is never itself the thing under test. */
  const settle = () => sql(cfg,
    "UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()), seconds = COALESCE(seconds, 0), "
    + "ended_reason = 'submitted' WHERE user_id = ? AND (ended_at IS NULL OR ended_reason = 'held')",
    [id.artist]);

  /* A fresh asset assigned to the artist, with the clock running. */
  const running = async (name) => {
    await settle();
    const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: id.artist } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    const started = await as('artist', `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    return assetId;
  };

  await t.test('the assignee still holds their own, exactly as before', async () => {
    const assetId = await running('Own Work');
    assert.strictEqual(await buttonFor('artist', assetId, id.project), true);
    const put = await holdAs('artist', assetId);
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual((await openSession(assetId)).ended_reason, 'held');
    assert.strictEqual((await as('artist', `/assets/${assetId}/resume`, { method: 'POST' })).status, 200);
  });

  await t.test('every Supervision designation holds a project-mate\'s task — button and server', async () => {
    /* ALL SIX, including the two that used to be refused here. seniorLead and techMgr are
       the regression: measured at 403 with no button before this change. */
    for (const who of ['lead', 'assocLead', 'artSup', 'animSup', 'seniorLead', 'techMgr']) {
      const assetId = await running(`For ${who}`);
      assert.strictEqual(await buttonFor(who, assetId, id.project), true,
        `${who} is offered the button on a task they lead`);
      const put = await holdAs(who, assetId);
      assert.strictEqual(put.status, 200, `${who}: ${JSON.stringify(put.body)}`);
      assert.strictEqual(put.body.held, true);
      assert.strictEqual((await openSession(assetId)).ended_reason, 'held',
        `${who} actually stopped the clock`);
      // And can put it back.
      assert.strictEqual((await as(who, `/assets/${assetId}/resume`, { method: 'POST' })).status, 200);
    }
  });

  await t.test('a lead on ANOTHER project cannot touch this one — the scope half', async () => {
    /* THE MUTATION TARGET. Drop the project condition and this lead, who holds exactly the
       same designation, gets somebody else's timer in a project they have nothing to do
       with. Both the button and the endpoint are checked, because a flag that said yes
       while the route said no would be the drift this codebase keeps finding. */
    const assetId = await running('Not Their Project');
    const board = await as('otherLead', `/assets/project/${id.project}`);
    if (board.status === 200 && (board.body.assets || []).some((x) => x.id === assetId)) {
      assert.strictEqual(await buttonFor('otherLead', assetId, id.project), false,
        'no button for a lead who does not lead this project');
    }
    const refused = await holdAs('otherLead', assetId);
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    /* THE REASON MOVED, AND IT IS A BETTER ONE. It used to be HOLD_NOT_YOURS, which is
       what a designation without the key is told; this lead HAS the key and is looking
       outside their own dashboard, which is a different fact and now has its own code and
       its own gate. Pinned, because the two refusals point at two different fixes: one is
       "grant the permission", the other is "put them on the project". */
    assert.strictEqual(refused.body.code, 'HOLD_NOT_VISIBLE');
    assert.strictEqual(refused.body.gate, 'visibility');
    assert.strictEqual((await openSession(assetId)).ended_reason, null,
      'and the clock is still running');
  });

  await t.test('the two designations Prompt 20 left out are no longer refused', async () => {
    /* THE REGRESSION TEST FOR THE THIRD REPORT, in the exact shape it was measured: same
       group, same project, same team-lead list, and 403 with no button before this change.
       Kept as its own case rather than folded into the loop above so that the two names
       appear in the suite's output. */
    for (const who of ['seniorLead', 'techMgr']) {
      const assetId = await running(`Allowed To ${who}`);
      assert.strictEqual(await buttonFor(who, assetId, id.project), true,
        `${who} is offered the button on a project they are on`);
      const put = await holdAs(who, assetId);
      assert.strictEqual(put.status, 200, `${who}: ${JSON.stringify(put.body)}`);
      assert.strictEqual((await openSession(assetId)).ended_reason, 'held',
        `${who} actually stopped the clock`);
    }
  });

  await t.test('a full-access designation still cannot, and the Super Admin now can', async () => {
    /* TWO ANSWERS THAT USED TO BE ONE, and the change is worth stating because it is a
       widening nobody asked for in those words.
     *
     * A FULL-ACCESS DESIGNATION IS STILL REFUSED. Head of Production sees every project in
     * the studio — projectScope 'all' — so "what you can see, you can hold" would be every
     * timer in the building. The tier does not carry leadsTeam, so it does not get the key
     * by default; a studio that wants it switches it on in Settings. This is the assertion
     * that keeps the default honest.
     *
     * THE SUPER ADMIN CAN, and that follows from a rule this project already had: the Super
     * Admin role holds the whole catalogue unconditionally (rolePermissions.effectiveFor
     * short-circuits for it), and every new permission reaches them automatically. So
     * granting hold_any grants it to them. Withholding it would mean special-casing a
     * designation out of a permission it holds, which is the thing this codebase does not
     * do. The old note here said "holding is not an oversight act" — that was a consequence
     * of the rule being `mine`, not a decision about Super Admins, and a Super Admin being
     * able to stop a runaway timer is defensible on its own. */
    const hop = await as('root', '/users', { method: 'POST',
      body: { name: 'hop', email: 'hop@zvky.test', role: 'head_of_production',
        password: PASSWORD } });
    assert.strictEqual(hop.status, 201, JSON.stringify(hop.body));
    tok.hop = await login('hop@zvky.test');

    const assetId = await running('Who May Stop This');
    assert.strictEqual(await buttonFor('hop', assetId, id.project), false,
      'no button for full access, which holds no hold_any by default');
    const refused = await holdAs('hop', assetId);
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'HOLD_NOT_YOURS',
      'and the reason names the permission, which is the fix');
    assert.strictEqual((await openSession(assetId)).ended_reason, null);

    assert.strictEqual(await buttonFor('root', assetId, id.project), true,
      'the Super Admin, who holds every key, is offered it');
    assert.strictEqual((await holdAs('root', assetId)).status, 200);
    assert.strictEqual((await openSession(assetId)).ended_reason, 'held');
  });

  await t.test('revoking asset.hold closes it for a lead too', async () => {
    /* The widening rides ON the permission, it does not bypass it: canHoldAsset asks for
       asset.hold before it asks anything else, so the studio's switch still governs. */
    const assetId = await running('Switch Still Governs');
    const held = await as('root', '/permissions/roles/team_lead');
    const current = held.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: current.filter((k) => k !== 'asset.hold') } });
    try {
      assert.strictEqual(await buttonFor('lead', assetId, id.project), false,
        'no button once the studio turns the permission off');
      assert.strictEqual((await holdAs('lead', assetId)).status, 403);
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: current } });
    }
    assert.strictEqual(await buttonFor('lead', assetId, id.project), true, 'and back when it returns');
  });
});
