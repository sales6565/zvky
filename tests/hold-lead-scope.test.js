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

test('the set is the Supervision group, read off the catalogue', () => {
  const keys = ROLES.map((r) => r.key);
  const may = perms.holdOthersRoles();
  for (const key of may) assert.ok(keys.includes(key), `${key} is a real designation`);

  /* ALL SIX, which is the change. The two that used to be excluded are named here
     explicitly so that re-narrowing the rule is also a decision with an assertion to
     answer, in whichever direction it goes next. */
  const supervision = ROLES.filter((r) => r.group === 'Supervision').map((r) => r.key);
  assert.strictEqual(supervision.length, 6, 'the Supervision group holds six');
  assert.deepStrictEqual([...may].sort(), [...supervision].sort(),
    'and every one of them may hold a project-mate\'s task');
  for (const wasExcluded of ['senior_team_lead', 'technical_manager']) {
    assert.ok(may.includes(wasExcluded),
      `${wasExcluded} is in Supervision and now holds the same authority as a Team Lead`);
  }

  /* AND NOTHING OUTSIDE THE GROUP, which is what stops the widening creeping. The `lead`
     TIER would have brought associate_art_director with it — Creative Direction, not
     Supervision — and an art director is neither a team lead nor a supervisor. */
  assert.ok(!may.includes('associate_art_director'),
    'Creative Direction is not Supervision, even where the tier matches');
  for (const outside of ['game_artist', 'coordinator', 'admin', 'super_admin', 'art_director']) {
    assert.ok(!may.includes(outside), `${outside} must not hold it`);
  }

  /* READ FROM THE DEFINITION, so there is no key string to mis-case. The mutation that
     compares a lower-cased group name has nothing to compare against. */
  assert.strictEqual(assetHold.HOLD_GROUP, 'Supervision');
  assert.strictEqual(assetHold.groupMayHoldOthers({ group: 'Supervision' }), true);
  assert.strictEqual(assetHold.groupMayHoldOthers({ group: 'supervision' }), false,
    'the catalogue\'s own spelling, and the definitions carry it');
  assert.strictEqual(assetHold.groupMayHoldOthers(null), false);

  // And the catalogue has no plain animation_supervisor, which is why the associate is named.
  assert.ok(!keys.includes('animation_supervisor'),
    'there is no animation_supervisor — associate_animation_supervisor is the animation seat');

  /* The scope tables are the two that mean "leads or supervises", not the three the review
     gate unions: a lead on a project's COORDINATOR list does not lead it. */
  assert.deepStrictEqual(perms.HOLD_SCOPE_TABLES,
    ['project_team_leads', 'project_supervision']);
  assert.ok(!perms.HOLD_SCOPE_TABLES.includes('project_coordinators'),
    'the coordinator list is not "leads or supervises"');
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
  assert.match(route, /leadsProject: ledByViewer\.has\(a\.project_id\)/,
    'decorated from the project scope, not from the designation alone');

  /* NO SECOND COPY ANYWHERE. The old hand-written conditions are gone from both the route
     and the page; what is left on each side is a call and a render. */
  assert.ok(!/HOLD_OTHERS_ROLES/.test(route), 'the hardcoded designation list is gone');
  assert.ok(!/mayHoldOthers/.test(route), 'and so is the second copy it was used by');

  assert.match(PAGE, /const canHold = hs \? hs\.canHold : fallbackHold;/,
    'the page reads the server\'s answer');
  assert.match(PAGE, /const canResume = hs \? hs\.canResume : fallbackResume;/);
  /* No designation list and no project query on the page: if either appears, the browser has
     acquired a copy of a rule it cannot answer correctly. */
  const at = PAGE.indexOf('const hs = a.hold_state || null;');
  assert.ok(at !== -1);
  const around = PAGE.slice(at - 1400, at + 1200).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const leak of ['team_lead', 'art_supervisor', 'Supervision', 'project_team_leads']) {
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
    const from = PAGE.indexOf('const hs = a.hold_state || null;');
    const to = PAGE.indexOf('const resumeWhy =', from);
    const lines = PAGE.slice(from, PAGE.indexOf(';', to) + 1);
    // eslint-disable-next-line no-new-func
    return new Function('mine', 'a', 'can', 'held', `${lines} return canHold;`)(
      row.assignee_id === me.body.user.id, row,
      (k) => (me.body.user.permissions || []).includes(k), row.held || null);
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

  await t.test('and so does everybody else, including full access', async () => {
    /* Root holds every permission in the catalogue and is still refused — holding is not an
       oversight act, which is the distinction the route's note has always drawn. */
    const assetId = await running('Not Root\'s Either');
    assert.strictEqual(await buttonFor('root', assetId, id.project), false);
    const refused = await holdAs('root', assetId);
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual((await openSession(assetId)).ended_reason, null);
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
