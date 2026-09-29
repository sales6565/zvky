/* Holding a project-mate's task: four designations, their own projects, and nothing wider.
 *
 * WHAT THIS IS NOT. It is not a permission fix. asset.hold is impliedBy: () => true, so
 * every designation has always held it — a lead who could not pause a teammate's timer was
 * never missing a permission, and tests/hold-permission.test.js proved the two gates already
 * agreed about it. The gate was `mine`: the asset had to be assigned to you. That was
 * deliberate and the route said so. This is the studio widening it.
 *
 * WHICH DESIGNATIONS, read off the catalogue rather than assumed. "All Supervisors" is not a
 * role and not a group: the Supervision group holds six designations, and only four were
 * asked for — senior_team_lead and technical_manager were not. There is also no plain
 * `animation_supervisor`; the animation side is `associate_animation_supervisor`. Both facts
 * are pinned below, so a catalogue change that invalidates them fails here.
 *
 * AND THE SCOPE HALF IS THE POINT. Without it this would read "any lead may stop any timer
 * in the studio", which is a much larger authority than the one asked for. The mutation that
 * drops it is the one this file exists to catch.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const perms = require('../src/permissions');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('holdscope');
const PASSWORD = 'HoldScope-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the named set, against the catalogue -----------------------------------

test('the four designations exist, and are named rather than inferred from a group', () => {
  const keys = ROLES.map((r) => r.key);
  for (const key of perms.HOLD_OTHERS_ROLES) {
    assert.ok(keys.includes(key), `${key} is a real designation`);
  }
  assert.deepStrictEqual([...perms.HOLD_OTHERS_ROLES].sort(),
    ['art_supervisor', 'associate_animation_supervisor', 'associate_team_lead', 'team_lead'],
    'the four the studio named');

  /* WHY NOT THE GROUP, pinned: Supervision is six designations, and widening to the group
     would hand this to two nobody asked about. If that ever becomes the intention it should
     be a decision with this assertion to answer, not a quiet edit. */
  const supervision = ROLES.filter((r) => r.group === 'Supervision').map((r) => r.key);
  assert.strictEqual(supervision.length, 6, 'the Supervision group holds six');
  for (const left of ['senior_team_lead', 'technical_manager']) {
    assert.ok(supervision.includes(left), `${left} is in Supervision`);
    assert.ok(!perms.HOLD_OTHERS_ROLES.includes(left),
      `${left} was NOT asked for and must stay on mine-only`);
  }

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

test('both gates read one helper, and the page reads the decorated answer', () => {
  /* The shape this thread keeps finding: a rule in two places where one copy drifts. The
     route asks canHoldAsset; the assets list decorates can_hold_others from the same two
     conditions; the page reads the flag. Nothing works the scope out twice. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  assert.match(route, /if \(!\(await canHoldAsset\(req\.user, asset\)\)\) \{/,
    'the hold route asks the helper');
  assert.match(route, /can_hold_others: mayHoldOthers\(a\)/,
    'and every asset row carries the flag');
  assert.match(route, /HOLD_OTHERS_ROLES\.includes\(viewer\.role\)/,
    'decorated from the same named set');
  assert.match(route, /ledByViewer\.has\(a\.project_id\)/,
    'and from the project scope, not from the role alone');

  assert.match(PAGE, /const mayHold = \(mine \|\| a\.can_hold_others === true\) && can\('asset\.hold'\);/,
    'the page reads the flag and the studio\'s switch, and nothing else');
  /* No role list and no project query on the page: if either appears, the browser has
     acquired a second copy of a rule it cannot answer correctly. */
  const at = PAGE.indexOf('const mayHold = (mine');
  const around = PAGE.slice(at - 900, at + 300).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const leak of ['team_lead', 'art_supervisor', 'project_team_leads', 'HOLD_OTHERS']) {
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
    ['designation outside the set', { id: 'u2', role: 'senior_team_lead', permissions: ['asset.hold'] },
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

  /* WHAT THE PAGE WOULD DRAW, from the page's own line and the server's own flag. */
  const buttonFor = async (who, assetId, projectId) => {
    const board = await as(who, `/assets/project/${projectId}`);
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));
    const row = (board.body.assets || []).find((x) => x.id === assetId);
    assert.ok(row, `${who} can see the asset at all`);
    const me = await as(who, '/auth/me');
    const at = PAGE.indexOf('const mayHold = (mine');
    const line = PAGE.slice(at, PAGE.indexOf(';', at) + 1);
    // eslint-disable-next-line no-new-func
    return new Function('mine', 'a', 'can', `${line} return mayHold;`)(
      row.assignee_id === me.body.user.id, row,
      (k) => (me.body.user.permissions || []).includes(k));
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

  await t.test('each of the four holds a project-mate\'s task — button and server', async () => {
    for (const who of ['lead', 'assocLead', 'artSup', 'animSup']) {
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

  await t.test('the two designations nobody asked for stay mine-only', async () => {
    /* Same group, same project, same team-lead list — and still refused, because the set is
       named rather than inferred from Supervision. This is what stops the widening creeping. */
    for (const who of ['seniorLead', 'techMgr']) {
      const assetId = await running(`Denied To ${who}`);
      assert.strictEqual(await buttonFor(who, assetId, id.project), false,
        `${who} is not offered the button`);
      const refused = await holdAs(who, assetId);
      assert.strictEqual(refused.status, 403, `${who}: ${JSON.stringify(refused.body)}`);
      assert.match(refused.body.error, /somebody else's/);
      assert.strictEqual((await openSession(assetId)).ended_reason, null);
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
