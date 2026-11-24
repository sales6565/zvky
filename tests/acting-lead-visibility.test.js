/* AN ACTING TEAM LEAD SEES THE PROJECT'S ASSETS — on every surface, like a Team Lead.
 *
 * ===========================================================================
 * THE BUG, AND WHY IT LOOKED LIKE DATA LOSS.
 *
 * An owner names an ordinary artist as Acting Team Lead in the project edit form. The
 * project appears in their picker — visibleProjects() has had a union for the acting list
 * since Prompt 50 — and then the board is EMPTY. Two hundred with nothing in it, and every
 * read of an individual asset a flat 403. A stand-in with no work of their own in the
 * project saw nothing at all.
 *
 * Three places decided asset visibility and all three asked the ROLE TIER:
 *
 *   permissions.canViewAsset()        if (isContributor(def)) return false
 *   permissions.assetOnDashboard()    if (isContributor(def)) return asset.assignee_id ===
 *   GET /assets/project/:projectId    if (isContributor(def)) sql += ' AND assignee_id = ?'
 *
 * An artist is `assignable` and not `leadsTeam`, so each narrowed them to their own
 * assignments however many of the project's team tables named them. They now all ask
 * permissions.seesWholeProject(), which asks isProjectLead() — PROJECT_TEAM_TABLES.
 *
 * ===========================================================================
 * HOW THIS SUITE IS WRITTEN, because it is the shape that makes it worth having.
 *
 * THE ASSERTION IS AN EQUALITY WITH THE TEAM LEAD, not a list of expected numbers. The
 * requirement is "an Acting TL is treated like a TL of that project", so for every surface
 * the Acting TL's status code and the exact set of asset codes they get back are compared
 * against a real Team Lead of the same project, asked the same question in the same state.
 * A surface left on the old check fails, and so does one that widens past a TL.
 *
 * THE OTHER DESIGNATIONS ARE A GOLDEN BEFORE/AFTER. Coordinator, Supervision, Creative
 * Direction, an assignee-only artist and a non-member are all asserted against written-out
 * expectations, so a change that fixed the Acting TL by widening somebody else fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const permissions = require('../src/permissions');
const { assetDiscipline } = require('../src/asset-discipline');

const cfg = config('actingvis');
const PASSWORD = 'ActingVis-Test-1!';

/* Assets in several statuses, because "cannot see the assets" is a claim about all of them
   and a rule that happened to work for one stage would be worth catching. */
const STATUSES = ['not_started', 'assigned', 'in_progress', 'pending_tl_review',
  'tl_changes_requested', 'delivered'];

test('what an Acting Team Lead sees', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const assetsA = {};   // status -> id
  const codes = {};     // id -> code
  const onA = [];       // every asset made, so the goldens are never hand-counted

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });

  const newAsset = async (project, code, status, assignee = null, type = 'character') => {
    const assetId = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id) VALUES (?,?,?,?,?,?,?)',
      [assetId, project, code, `Asset ${code}`, type, status, assignee]);
    codes[assetId] = code;
    onA.push({ project, code, status, type });
    return assetId;
  };

  /* Every surface a person could look for an asset on, as one list — so a new surface is
     added here once and every designation below is asked about it.

     `shape` turns a response into something comparable: a status code plus, where the
     surface returns assets, the sorted set of codes. Comparing codes rather than ids makes
     a failure readable. */
  /* THE CODE AND THE STAGE OF EVERY ROW, sorted — not a count. A count passes while two
     people are shown different assets, and the stage is there because "cannot see the
     assets" is a claim about all of them: a rule that happened to work for one stage and
     not another would otherwise read as equal. */
  const board = (r) => `${r.status} ${(r.body.assets || [])
    .map((a) => `${a.code}:${a.status}`).sort().join(' ')}`.trim();

  /* THE DASHBOARD'S COUNTERS AND ITS ART / ANIMATION TABS. There is no dashboard endpoint:
     the page derives both from the asset payload it already has, grouping by the shared
     discipline rule and by status. So the counters are derived here the same way, from the
     same payload, with src/asset-discipline.js — the module the page mirrors — rather than
     by a second rule written in this file.

     This is the surface the complaint was actually about. "The Acting TL's dashboard is
     empty" was these numbers, all zero, because the payload they are computed from was
     empty. */
  const counters = (r) => {
    if (r.status !== 200) return String(r.status);
    const tally = new Map();
    for (const a of r.body.assets || []) {
      const key = `${assetDiscipline(a, {}) || 'unknown'}/${a.status}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    return `${r.status} ${[...tally].sort().map(([k, n]) => `${k}=${n}`).join(' ')}`;
  };

  /* How many assets project A has, read off the fixture rather than counted by hand — a
     golden that needs editing every time a row is added stops being a golden. */
  const countOnA = () => onA.filter((a) => a.project === id.A).length;

  const SURFACES = [
    { name: 'project list',
      call: (who) => as(who, '/projects'),
      shape: (r) => `${r.status} ${(r.body.projects || []).map((p) => p.code).sort().join(' ')}`.trim() },
    { name: 'asset list / board (A)',
      call: (who) => as(who, `/assets/project/${id.A}`),
      shape: board },
    { name: 'dashboard counters, Art / Animation',
      call: (who) => as(who, `/assets/project/${id.A}`),
      shape: counters },
    { name: 'asset detail: history',
      call: (who) => as(who, `/assets/${assetsA.pending_tl_review}/history`),
      shape: (r) => String(r.status) },
    { name: 'asset detail: tasks',
      call: (who) => as(who, `/assets/${assetsA.pending_tl_review}/tasks`),
      shape: (r) => String(r.status) },
    { name: 'asset detail: worklog',
      call: (who) => as(who, `/assets/${assetsA.delivered}/worklog`),
      shape: (r) => String(r.status) },
    { name: 'asset detail: game feedback',
      call: (who) => as(who, `/assets/${assetsA.in_progress}/game-feedback`),
      shape: (r) => String(r.status) },
    { name: 'dashboard counters',
      call: (who) => as(who, '/admin-dashboard'),
      shape: (r) => `${r.status} ${r.status === 200 ? (r.body.totals ? 'totals' : 'ok') : ''}`.trim() },
    { name: 'people to follow up',
      call: (who) => as(who, '/admin-dashboard/follow-up'),
      shape: (r) => String(r.status) },
    { name: 'asset list / board (B)',
      call: (who) => as(who, `/assets/project/${id.B}`),
      shape: board },
  ];

  const sweep = async (who) => {
    const out = {};
    for (const s of SURFACES) out[s.name] = s.shape(await s.call(who));
    return out;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'av-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'av-boot', name: 'Owner', email: 'owner@av.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@av.test');

    const make = async (who, role) => {
      const r = await as('owner', '/users', { method: 'POST', body: {
        name: who, email: `${who}@av.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${who}: ${JSON.stringify(r.body)}`);
      token[who] = await login(`${who}@av.test`);
      return r.body.user.id;
    };

    id.tl = await make('tl', 'team_lead');                  // the control
    id.acting = await make('acting', 'game_artist');         // the bug's subject
    id.acting2 = await make('acting2', 'game_animator');     // a second stand-in
    id.coord = await make('coord', 'coordinator');
    id.super = await make('super', 'art_supervisor');
    id.creative = await make('creative', 'creative_art_director');
    id.assignee = await make('assignee', 'game_artist');     // an artist with work on A
    id.outsider = await make('outsider', 'game_artist');     // on nothing

    const client = await as('owner', '/clients', { method: 'POST', body: { name: 'AV Co' } });
    const projA = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Alpha', clientId: client.body.client.id } });
    const projB = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Beta', clientId: client.body.client.id } });
    id.A = projA.body.project.id;
    id.B = projB.body.project.id;

    for (const status of STATUSES) {
      assetsA[status] = await newAsset(id.A, `A-${status.slice(0, 5).toUpperCase()}`, status);
    }
    // One asset on A assigned to the assignee-only artist, and one on B.
    assetsA.mine = await newAsset(id.A, 'A-MINE', 'in_progress', id.assignee);
    /* TWO ANIMATION ROWS, so the Dashboard's Art / Animation split below counts something
       on both sides. src/asset-discipline.js decides which side a row falls on from its
       type, and a counter surface over one discipline would compare equal while the other
       was empty for everybody. */
    assetsA.anim = await newAsset(id.A, 'A-ANIM', 'in_progress', null, 'animation');
    assetsA.animDone = await newAsset(id.A, 'A-ANIMD', 'delivered', null, 'animation');
    id.onB = await newAsset(id.B, 'B-ONE', 'in_progress', id.assignee);

    /* The owner fills in the project's team sections, exactly as the edit form does. */
    const edit = await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      name: 'Alpha',
      teamLeadIds: [id.tl],
      actingTeamLeadIds: [id.acting],
      coordinatorIds: [id.coord],
      supervisionIds: [id.super],
    } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ------------------------------------- the equality that is the requirement */

  await t.test('on every surface, the Acting TL gets what the Team Lead gets', async () => {
    const lead = await sweep('tl');
    const acting = await sweep('acting');
    for (const s of SURFACES) {
      assert.strictEqual(acting[s.name], lead[s.name],
        `${s.name}: Acting TL got "${acting[s.name]}", Team Lead got "${lead[s.name]}"`);
    }
    /* AND IT IS NOT AN EQUALITY OF TWO EMPTY ANSWERS. The board has to actually carry the
       project's assets, in every status, or this passes while both see nothing. */
    const board = acting['asset list / board (A)'];
    assert.match(board, /^200 /, board);
    for (const status of STATUSES) {
      assert.ok(board.includes(codes[assetsA[status]]), `${status} is on the board: ${board}`);
    }
    assert.ok(board.includes('A-MINE'), 'including work assigned to somebody else');

    /* AND THE COUNTERS COUNT BOTH DISCIPLINES, so the equality above is not two identical
       readings of one empty tab. */
    const tally = acting['dashboard counters, Art / Animation'];
    assert.match(tally, /\bart\//, `the Art tab has rows: ${tally}`);
    assert.match(tally, /\banimation\//, `and so does Animation: ${tally}`);
  });

  await t.test('a second Acting TL of a different designation gets the same', async () => {
    /* The stand-in need not be an artist — the acting list offers every active user, which
       is the point of a stand-in. A game animator named on it gets the Team Lead's answers
       too, and adding them does not disturb the first one. */
    const edit = await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [id.acting, id.acting2] } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));

    const lead = await sweep('tl');
    for (const who of ['acting', 'acting2']) {
      const got = await sweep(who);
      for (const s of SURFACES) {
        assert.strictEqual(got[s.name], lead[s.name], `${who} / ${s.name}`);
      }
    }
  });

  /* ------------------------------------------------- the golden other designations */

  await t.test('every other designation sees exactly what it saw before', async () => {
    /* WRITTEN OUT, not compared against each other: this is the half of the change that
       must not have moved, so the expectations are stated rather than derived. */
    const everyA = onA.filter((a) => a.project === id.A)
      .map((a) => `${a.code}:${a.status}`).sort().join(' ');

    const coord = await sweep('coord');
    assert.strictEqual(coord['asset list / board (A)'], `200 ${everyA}`,
      'a coordinator named on the project sees all of it, as before');

    const supervisor = await sweep('super');
    assert.strictEqual(supervisor['asset list / board (A)'], `200 ${everyA}`,
      'supervision sees all of it, as before');

    const creative = await sweep('creative');
    assert.strictEqual(creative['asset list / board (A)'], `200 ${everyA}`,
      "creative direction's scope is 'all', as before");

    /* THE ASSIGNEE-ONLY ARTIST IS THE ONE THAT MATTERS MOST: an ordinary artist with work
       on the project, named on none of its team lists, must still see only their own. If
       the fix had widened contributors in general rather than named leads, this is what
       would fail. */
    const assignee = await sweep('assignee');
    assert.strictEqual(assignee['asset list / board (A)'], '200 A-MINE:in_progress',
      'an artist with work on A sees their own and nothing else');
    assert.strictEqual(assignee['asset detail: history'], '403',
      'and cannot read an asset that is not theirs');

    const outsider = await sweep('outsider');
    assert.strictEqual(outsider['asset list / board (A)'], '403',
      'somebody on nothing is refused the project');
    assert.strictEqual(outsider['asset detail: history'], '403');
  });

  /* ----------------------------------------------------------------- the scope */

  await t.test('a designation that is not a contributor still cannot reach a project it is not on', async () => {
    /* THE REACHABILITY CHECK INSIDE THE SHARED FUNCTION, asked where it is the only thing
       standing in the way. A coordinator is not a contributor, so the last line of
       seesWholeProject() answers TRUE for them — and the only reason that is not "every
       project in the studio" is the canAccessProject() call above it.

       The asset list route refuses project B for them on its own, so the list cannot show
       this. The detail read can: canViewAsset() asks the shared function with no
       project check of its own. */
    const onB = await as('coord', `/assets/${id.onB}/history`);
    assert.strictEqual(onB.status, 403, `a coordinator is not on B: ${JSON.stringify(onB.body)}`);
    const onA = await as('coord', `/assets/${assetsA.pending_tl_review}/history`);
    assert.strictEqual(onA.status, 200, 'while A, which they are named on, reads as before');
  });

  await t.test('an Acting TL of A sees nothing extra of B', async () => {
    const acting = await sweep('acting');
    assert.strictEqual(acting['asset list / board (B)'], '403',
      'B is not theirs: being a stand-in on A reaches A and nothing else');
    const detail = await as('acting', `/assets/${id.onB}/history`);
    assert.strictEqual(detail.status, 403, JSON.stringify(detail.body));
  });

  await t.test('Acting TL on A and an ordinary artist on B: all of A, only their own on B', async () => {
    /* The brief's case, and the one that tells "named a lead" apart from "widened". */
    const onB = await newAsset(id.B, 'B-THEIRS', 'in_progress', id.acting);
    const other = await newAsset(id.B, 'B-NOT-THEIRS', 'in_progress', id.assignee);

    const board = await as('acting', `/assets/project/${id.B}`);
    assert.strictEqual(board.status, 200, 'an assignment makes B reachable');
    const seen = (board.body.assets || []).map((a) => a.code).sort();
    assert.deepStrictEqual(seen, ['B-THEIRS'], 'their own work on B, and only that');

    const refused = await as('acting', `/assets/${other}/history`);
    assert.strictEqual(refused.status, 403, 'and not somebody else\'s work on B');

    // A is still whole.
    const a = await as('acting', `/assets/project/${id.A}`);
    assert.strictEqual((a.body.assets || []).length, countOnA());
  });

  await t.test('an archived project follows today\'s rule, for a named lead too', async () => {
    /* visibleProjects() excludes archived projects for everybody, and seesWholeProject()
       asks it first — so being named on a team list does not reach into one. */
    const client = await as('owner', '/clients');
    const old = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Gamma', clientId: client.body.clients[0].id } });
    const gamma = old.body.project.id;
    await newAsset(gamma, 'G-ONE', 'in_progress');
    assert.strictEqual((await as('owner', `/projects/${gamma}`, { method: 'PATCH',
      body: { actingTeamLeadIds: [id.acting] } })).status, 200);
    // Visible while active.
    assert.strictEqual((await as('acting', `/assets/project/${gamma}`)).status, 200);

    const archived = await as('owner', `/projects/${gamma}/archive`, { method: 'POST' });
    if (archived.status === 200) {
      const after = await as('acting', `/assets/project/${gamma}`);
      assert.strictEqual(after.status, 403, 'archived is out of scope for everybody');
      const lead = await as('tl', `/assets/project/${gamma}`);
      assert.strictEqual(lead.status, 403, 'including for a Team Lead — today\'s rule');
    }
  });

  /* -------------------------------------------------------- adding and removing */

  await t.test('taking the Acting TL off the project takes the assets away again', async () => {
    const before = await as('acting', `/assets/project/${id.A}`);
    assert.strictEqual((before.body.assets || []).length, countOnA());

    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH',
      body: { actingTeamLeadIds: [id.acting2] } })).status, 200);

    const after = await as('acting', `/assets/project/${id.A}`);
    /* THE PROJECT ITSELF GOES TOO, because nothing else put it in their scope: an artist's
       own scope does not reach A, and they hold no assignment there. So the honest answer
       is the refusal somebody on nothing gets. */
    assert.strictEqual(after.status, 403, JSON.stringify(after.body));
    assert.strictEqual((await as('acting', `/assets/${assetsA.delivered}/history`)).status, 403);

    // And the one still named is unaffected.
    const still = await as('acting2', `/assets/project/${id.A}`);
    assert.strictEqual((still.body.assets || []).length, countOnA());

    // Put the first one back for the tests below.
    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH',
      body: { actingTeamLeadIds: [id.acting, id.acting2] } })).status, 200);
  });

  await t.test('the same person on two team lists is one person, not two', async () => {
    /* The two lists are separate tables, so one person can be on both — a Team Lead of a
       project who is also named on its acting list, which is how a studio records "they are
       the lead AND standing in while the other lead is away". The answer that person gets
       must not double.

       THE ROW IS WRITTEN DIRECTLY, and that is the point of this subtest rather than a
       shortcut. Asked through the project edit form, this exact pairing may be refused — a
       Team Lead standing in for themselves is standing in for nobody — and a version of
       this test that went through the form passed by never creating the duplicate at all. A
       real database can hold the pair whatever the form thinks of it: a project saved before
       the form had an opinion, a hand-run SQL fix, a future form that allows it. So the
       state is made, and then the answers are read. */
    await sql(cfg, 'INSERT IGNORE INTO project_acting_team_leads (project_id, user_id) VALUES (?,?)',
      [id.A, id.tl]);
    const rows = await sql(cfg,
      'SELECT user_id FROM project_team_leads WHERE project_id = ? AND user_id = ?'
      + ' UNION ALL SELECT user_id FROM project_acting_team_leads WHERE project_id = ? AND user_id = ?',
      [id.A, id.tl, id.A, id.tl]);
    assert.strictEqual(rows.length, 2, 'the person really is on both lists now');

    const board = await as('tl', `/assets/project/${id.A}`);
    const seen = (board.body.assets || []).map((a) => a.code);
    assert.strictEqual(new Set(seen).size, seen.length,
      `the board repeated an asset: ${seen.sort().join(' ')}`);
    assert.strictEqual(seen.length, countOnA(), 'and shows each of them exactly once');

    const me = await as('tl', '/auth/me');
    const teams = me.body.projectTeams || [];
    assert.strictEqual(new Set(teams).size, teams.length,
      `the membership list repeated a project: ${teams.join(' ')}`);
    assert.deepStrictEqual(teams, [...teams].sort(),
      'and it is still sorted, so two reads of one state cannot look like a change');

    const projects = (await as('tl', '/projects')).body.projects.map((p) => p.id);
    assert.strictEqual(new Set(projects).size, projects.length,
      'nor did the project list name A twice');

    /* Their visibility is unchanged by being on the list twice — still exactly a lead's. */
    const lead = await as('tl', `/assets/${assetsA.delivered}/history`);
    assert.strictEqual(lead.status, 200);

    await sql(cfg, 'DELETE FROM project_acting_team_leads WHERE project_id = ? AND user_id = ?',
      [id.A, id.tl]);
  });

  /* ----------------------------------------------- the actions are NOT widened */

  await t.test('visibility is all they gained: the actions are Prompt 50\'s, unchanged', async () => {
    /* An Acting TL may act at the TL gate on their project — that is what Prompt 50 gave
       them — and nothing else. Seeing the board must not have added an action. */
    const me = (await as('acting', '/auth/me')).body.user;
    const control = (await as('outsider', '/auth/me')).body.user;
    assert.deepStrictEqual([...me.permissions].sort(), [...control.permissions].sort(),
      'the same permission set as any other artist: no key was granted');

    const target = assetsA.pending_tl_review;
    /* Editing somebody else's asset: still refused. Seeing it is not editing it. */
    const edit = await as('acting', `/assets/${target}`, { method: 'PATCH', body: { priority: 'high' } });
    assert.strictEqual(edit.status, 403, `editing stays refused: ${JSON.stringify(edit.body)}`);
    /* Deleting: still refused. */
    const del = await as('acting', `/assets/${target}`, { method: 'DELETE' });
    assert.ok(del.status === 403 || del.status === 404, `deleting stays refused: ${del.status}`);
    /* Assigning somebody: still refused. */
    const assign = await as('acting', `/assets/${target}/assign`, { method: 'POST', body: { assigneeId: id.assignee } });
    assert.ok(assign.status >= 400, `assigning stays refused: ${assign.status}`);
  });

  /* ------------------------------------------- the third site, asked directly */

  await t.test('the board behind the hold rule says the project is on their dashboard', async () => {
    /* THE THIRD PLACE THE ROLE TIER LIVED was permissions.assetOnDashboard(), and it is the
       hardest of the three to observe: the asset list hands its own answer in — it has the
       project list batched already — so the function itself is only consulted by the hold
       routes. Which means a mutation that leaves this one site on the old check changes no
       response in the suites above, and only the "decided in one place" guard catches it.
       A guard over the source is worth having; it is not worth having INSTEAD of asking the
       application.

       GET /:id/hold-explain?userId= is the way to ask. It exists so that an answer that
       looks wrong can be argued with, it reports `facts.onDashboard` verbatim, and with the
       permission that manages permissions it can be asked about somebody else — so the
       owner can ask it about each of these people in turn, on an asset that is none of
       theirs. No new route, no new permission, and the one function under test. */
    const ask = async (userId) => {
      const r = await as('owner', `/assets/${assetsA.pending_tl_review}/hold-explain?userId=${userId}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      return r.body.facts;
    };

    assert.strictEqual((await ask(id.tl)).onDashboard, true,
      'a Team Lead of the project: on their dashboard, as before');
    assert.strictEqual((await ask(id.acting)).onDashboard, true,
      'the Acting TL: on their dashboard — this is the fix, in the third place');
    assert.strictEqual((await ask(id.acting2)).onDashboard, true,
      'and for a stand-in of a different designation');
    assert.strictEqual((await ask(id.coord)).onDashboard, true,
      'a coordinator named on it: unchanged');
    assert.strictEqual((await ask(id.assignee)).onDashboard, false,
      'an artist with work on the project but named on nothing: still false, '
      + 'which is the half that must not have moved');
    assert.strictEqual((await ask(id.outsider)).onDashboard, false,
      'and somebody on nothing at all');
  });

  /* ------------------------------------------- every team section, one at a time */

  await t.test('every table in PROJECT_TEAM_TABLES grants lead-level asset visibility', async () => {
    /* THE BRIEF'S REQUIREMENT, AS BEHAVIOUR RATHER THAN AS AN IDENTITY. The source-level
       test below pins that seesWholeProject() reaches the tables only through
       isProjectLead(), which reads the constant. This one proves what that buys: an
       ordinary artist named on each section in turn — one section at a time, nothing else
       changed about them — opens the whole project.

       Driven off permissions.PROJECT_TEAM_TABLES, so a fifth team section added to that
       constant is tested here the moment it is added, and a section that does NOT grant
       lead-level visibility fails with its own name in the message.

       The rows are written straight to the tables rather than through the project edit
       form: the form takes four named id lists and this has to iterate the constant, which
       is the whole point — a table the form has not learned to write yet must still be
       honoured by the visibility rule. */
    const artist = await as('owner', '/users', { method: 'POST', body: {
      name: 'one at a time', email: 'oneatatime@av.test', role: 'game_artist',
      password: PASSWORD } });
    assert.strictEqual(artist.status, 201, JSON.stringify(artist.body));
    const who = artist.body.user.id;
    token.one = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'oneatatime@av.test', password: PASSWORD } })).body.token;

    const clear = async () => {
      for (const table of permissions.PROJECT_TEAM_TABLES) {
        await sql(cfg, `DELETE FROM ${table} WHERE project_id = ? AND user_id = ?`, [id.A, who]);
      }
    };

    await clear();
    assert.strictEqual((await as('one', `/assets/project/${id.A}`)).status, 403,
      'named on nothing, they cannot reach the project at all');

    const expected = countOnA();
    for (const table of permissions.PROJECT_TEAM_TABLES) {
      await clear();
      await sql(cfg, `INSERT INTO ${table} (project_id, user_id) VALUES (?,?)`, [id.A, who]);

      const board = await as('one', `/assets/project/${id.A}`);
      assert.strictEqual(board.status, 200, `${table}: ${JSON.stringify(board.body)}`);
      assert.strictEqual((board.body.assets || []).length, expected,
        `${table} must grant lead-level visibility — it gave ${(board.body.assets || []).length}`
        + ` of ${expected} assets`);

      /* And a single asset reads, which is canViewAsset rather than the list query — the
         two came apart once and that is the whole reason this task exists. */
      assert.strictEqual((await as('one', `/assets/${assetsA.delivered}/history`)).status, 200,
        `${table}: the detail read must agree with the board`);
    }

    await clear();
    assert.strictEqual((await as('one', `/assets/project/${id.A}`)).status, 403,
      'and taking the last row away closes it again');
  });

  /* --------------------------------------------- the one surface that is NOT equal */

  await t.test('Outsource stays behind its own permission, which a stand-in does not gain', async () => {
    /* THE ONE SURFACE WHERE THE ACTING TL DOES NOT GET THE TEAM LEAD'S ANSWER, and it is
       meant to be: /api/outsource is mounted behind requirePermission('outsource.view'),
       and that key is implied by a DESIGNATION capability — leadsTeam, deliver or
       manageUsers — not by membership of a project. An artist has none of the three, so the
       module is closed to them whoever names them a stand-in. Opening it would be granting
       an action, which this task must not do.

       Asserted rather than left out of the sweep silently, because "the Acting TL gets a
       403 from Outsource" is exactly the shape of the bug that was just fixed, and the next
       person to read that line deserves to find out here why this one is correct. */
    const keys = async (who) => new Set((await as(who, '/auth/me')).body.user.permissions);
    assert.ok((await keys('tl')).has('outsource.view'), 'a Team Lead may use the module');
    assert.ok(!(await keys('acting')).has('outsource.view'),
      'an artist may not, named as a stand-in or not');
    assert.strictEqual((await as('tl', `/outsource/projects/${id.A}/assets`)).status, 200);
    assert.strictEqual((await as('acting', `/outsource/projects/${id.A}/assets`)).status, 403);

    /* THE SAME SHAPE ELSEWHERE, so this is read as a pattern and not as one exception: the
       Artist Report is behind report.artist_report and the Admin Dashboard behind
       report.admin_dashboard, both designation keys. Neither opens for a stand-in, and
       neither is open to the Team Lead this suite compares against either. */
    for (const route of ['/reports/artist', '/admin-dashboard']) {
      assert.strictEqual((await as('acting', route)).status, 403, route);
      assert.strictEqual((await as('tl', route)).status, 403,
        `${route} is closed to the Team Lead too — the gate is the designation, not the project`);
    }

    /* AND THE SCOPE INSIDE THE MODULE DOES FOLLOW THE ACTING LIST, for somebody who may
       open it at all. A second Team Lead, named on nothing and with no reports, cannot
       reach project A; named as its Acting TL, they can — because Outsource narrows on
       visibleProjects(), the same union everything else now asks. */
    const second = await as('owner', '/users', { method: 'POST', body: {
      name: 'tl2', email: 'tl2@av.test', role: 'team_lead', password: PASSWORD } });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    token.tl2 = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'tl2@av.test', password: PASSWORD } })).body.token;

    assert.ok((await keys('tl2')).has('outsource.view'));
    const before = await as('tl2', `/outsource/projects/${id.A}/assets`);
    assert.strictEqual(before.status, 403, 'A is not theirs yet');

    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [id.acting, id.acting2, second.body.user.id] } })).status, 200);

    const after = await as('tl2', `/outsource/projects/${id.A}/assets`);
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    assert.strictEqual((after.body.assets || []).length, countOnA(),
      'and the project\'s assets are all there');

    // Back to the two stand-ins the rest of the suite set up.
    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [id.acting, id.acting2] } })).status, 200);
  });

  /* ------------------------------------------------------------- the payload */

  await t.test('/auth/me carries the memberships, so an open page can notice a change', async () => {
    const me = await as('acting', '/auth/me');
    assert.strictEqual(me.status, 200);
    assert.ok(Array.isArray(me.body.projectTeams), 'the field is there');
    assert.ok(me.body.projectTeams.includes(id.A), 'and names the project they act on');
    /* Sorted, so two reads that found the same memberships cannot look like a change to
       the page comparing them. */
    assert.deepStrictEqual(me.body.projectTeams, [...me.body.projectTeams].sort());

    const none = await as('outsider', '/auth/me');
    assert.deepStrictEqual(none.body.projectTeams, [], 'and is empty for somebody on nothing');
  });
});

/* ===========================================================================
 * THE RULE IS ONE FUNCTION, AND NOTHING MAY ASK IT ANOTHER WAY.
 *
 * Source-level, no server: the defect was one decision written out three times and then
 * drifting, so what is pinned here is that there is one of it.
 */
test('asset visibility is decided in one place', () => {
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  /* Comments are stripped before every check below. This is not tidiness: a history note in
     src/permissions.js quotes all three of the old `if (isContributor(def))` lines verbatim,
     and src/asset-hold.js names two of the team tables in a paragraph about Prompt 37. A
     scanner that reads comments would fail on the explanations of the very bug it guards. */
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const sources = [...walk('src'), 'public/index.html'].filter((f) => /\.(js|html)$/.test(f));

  /* ---------------------------------------------------------------- the table list */

  /* EVERY TABLE IN PROJECT_TEAM_TABLES GRANTS LEAD-LEVEL VISIBILITY. seesWholeProject()
     asks isProjectLead(), which reads that constant — so a section added to the list is
     carried without anybody editing the visibility rule. Asserted as the identity it rests
     on rather than by re-listing the tables, which would only restate the constant. */
  assert.strictEqual(permissions.PROJECT_LEAD_TABLES, permissions.PROJECT_TEAM_TABLES,
    'the lead list and the team list must be the same list, not two lists that agree today');
  assert.ok(permissions.PROJECT_TEAM_TABLES.includes('project_acting_team_leads'),
    'and the acting table is in it');

  const owner = strip(read('src/permissions.js'));
  const lead = owner.slice(owner.indexOf('function projectLeadIds'), owner.indexOf('function projectLeadIds') + 900);
  assert.ok(lead.includes('PROJECT_LEAD_TABLES') || lead.includes('PROJECT_TEAM_TABLES'),
    'projectLeadIds() reads the constant rather than naming tables itself');
  const whole = owner.slice(owner.indexOf('async function seesWholeProject'),
    owner.indexOf('async function seesWholeProject') + 900);
  assert.match(whole, /isProjectLead/,
    'and seesWholeProject() reaches the tables only through isProjectLead()');

  /* ------------------------------------------------------------- not the role tier */

  /* NO SURFACE NARROWS ON THE ROLE TIER. isContributor() is a fact about a DESIGNATION and
     was the wrong question in all three places that asked it: an artist named as a
     project's lead is a contributor and still sees the project.

     It is a fair question elsewhere — who gets a team-lead field, who appears in a report
     list — so this checks the places that decide asset visibility rather than banning the
     word. The one surviving use is seesWholeProject()'s own last line, which is the
     designation-level default the three sites used to apply by themselves. */
  const siteMarkers = {
    'src/permissions.js': ['async function canViewAsset', 'async function assetOnDashboard'],
    'src/routes/assets.js': ["router.get('/project/:projectId'"],
  };
  for (const [rel, markers] of Object.entries(siteMarkers)) {
    const code = strip(read(rel));
    for (const marker of markers) {
      const from = code.indexOf(marker);
      assert.ok(from !== -1, `${rel} no longer contains ${marker} — this guard needs rewriting`);
      const body = code.slice(from, from + 1600);
      assert.ok(!/isContributor\s*\(/.test(body),
        `${rel}: ${marker} decides asset visibility from the role tier; ask seesWholeProject()`);
      assert.match(body, /seesWholeProject/,
        `${rel}: ${marker} does not ask the shared function`);
    }
  }

  /* -------------------------------------------------- not a second hard-coded list */

  /* AND NO SECOND TABLE LIST INSIDE AN ASSET QUERY. The bug's cousin, and the one most
     likely to be written next: a surface that joins project_team_leads,
     project_coordinators and project_supervision and forgets the acting one.
     
     Every string literal in the tree that reads from or joins `assets` is examined — 112 of
     them at the time of writing, which is what makes this worth running — and none may name
     a team table. The exceptions are named here with their reason rather than skipped by
     directory, so a new one has to be argued for in this file. */
  const ALLOWED = {
    'src/permissions.js': 'owns the union: visibleProjects() and projectLeadIds() ARE the rule',
    'src/assignments.js': 'a notification audience, not a visibility narrowing — it adds the '
      + "acting leads to the people told about a submission, and widens nobody's view",
  };
  const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  let scanned = 0;
  const offenders = [];
  for (const rel of sources) {
    for (const lit of strip(read(rel)).match(LITERAL) || []) {
      if (!/\b(FROM|JOIN)\s+assets\b/i.test(lit)) continue;
      scanned += 1;
      const named = permissions.PROJECT_TEAM_TABLES.filter((tbl) => lit.includes(tbl));
      if (named.length && !ALLOWED[rel]) {
        offenders.push(`${rel}: an asset query names ${named.join(', ')} — `
          + `ask permissions.seesWholeProject()/isProjectLead() instead\n    ${lit.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
  assert.ok(scanned > 60, `only ${scanned} asset queries were scanned — the scan is broken`);
});

/* The diagnostic script is read-only. */
test('scripts/user-sees.js writes nothing', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'user-sees.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'REPLACE INTO']) {
    assert.ok(!new RegExp(verb, 'i').test(code), `user-sees.js must not contain ${verb}`);
  }
  assert.ok(!/db\.query\(\s*`?\s*(INSERT|UPDATE|DELETE)/i.test(code));
  /* It reads the application's own functions rather than reimplementing the rule — which
     is what makes its answer worth trusting. */
  assert.match(code, /permissions\.seesWholeProject/);
  assert.match(code, /permissions\.visibleProjects/);
});
