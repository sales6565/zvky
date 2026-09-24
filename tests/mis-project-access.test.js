/* Attaching the studio's staff side to a project so they can SEE it.
 *
 * WHAT THE STUDIO ASKED FOR, in their words: "add one from that team to the
 * selected projects, so that they can view all the projects. Only view but no
 * editing, no adding, nothing."
 *
 * THE CLAIM THIS FILE EXISTS TO CHECK is the second half of that sentence, and
 * it is checked by DOING rather than by reading a permission list. An MIS
 * analyst is attached to a project and then tries, against a running server,
 * every way there is to change something in it. A feature that grants "view
 * only" is only as good as the narrowest thing it forgot to close.
 *
 * WHY THERE IS NO NEW MEMBERSHIP TABLE. project_members is what the narrowest
 * project scope already reads, so a row in it makes the project visible with no
 * new permission layer. The read/write split is not this feature's doing: it
 * falls out of the designation, which cannot be handed work and does not run a
 * team. See src/project-oversight.js.
 *
 * THE ONE THING THAT DID NOT FALL OUT THAT WAY was asset notes, which asked
 * only "can you see this asset" and let anybody who could write one. That was
 * already reachable before this feature — an admin could set a staff account's
 * Project field from their profile — and this makes it a great deal easier to
 * hit, so it is closed here and pinned below.
 */
const test = require('node:test');
const assert = require('node:assert');

const oversight = require('../src/project-oversight');
const { roleDef } = require('../src/roles');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('misaccess');

// --- who this can be used on, read off the catalogue -------------------------

test('the eligible designations are derived, not named', () => {
  /* The rule is "cannot be handed work, does not run a team, reach is what they
     are put on" — which is the Staff tier expressed as the properties that make
     it true. Naming roles here would go stale the first time a Super Admin adds
     one in Settings. */
  const keys = oversight.viewOnlyRoleKeys();
  assert.ok(keys.includes('mis_analyst'), 'the MIS analyst the studio asked about');
  assert.ok(keys.includes('junior_accountant'), 'and the rest of the staff side');

  for (const key of keys) {
    const def = roleDef(key);
    assert.strictEqual(def.assignable, false, `${key} must not be assignable`);
    assert.strictEqual(def.leadsTeam, false, `${key} must not lead a team`);
    assert.strictEqual(def.projectScope, 'own_work', `${key} must not already reach further`);
  }

  // And nobody who works the pipeline is on the list.
  for (const key of ['game_artist', 'team_lead', 'coordinator', 'super_admin', 'admin']) {
    assert.ok(!keys.includes(key), `${key} should not be offered view-only access this way`);
  }

  assert.strictEqual(oversight.writesToPipeline('mis_analyst'), false);
  assert.strictEqual(oversight.writesToPipeline('game_artist'), true);
  assert.strictEqual(oversight.writesToPipeline('team_lead'), true);
});

// --- the whole thing, against a running server ------------------------------

test('MIS project access, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'MisAccess-Probe-1!';
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const ROOT = '/admin/mis-assignments';
  let projectA;
  let projectB;
  let assetId;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    id.root = (await as('root', '/auth/me')).body.user.id;

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('mis', 'Meera MIS', 'mis@zvky.test', 'mis_analyst');
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('artist', 'Ravi Artist', 'ravi@zvky.test', 'game_artist', id.lead);
    /* Holds every other Settings section. If the gate were written against
       Settings access rather than the Super Admin tier, this is who would walk
       through it. */
    await make('cto', 'Tara CTO', 'cto@zvky.test', 'cto');

    const clients = await as('root', '/clients');
    const clientId = clients.body.clients[0].id;
    const mk = async (name) => {
      const r = await as('root', '/projects', {
        method: 'POST', body: { name, clientId, teamLeadIds: [id.lead] } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      return r.body.project.id;
    };
    projectA = await mk('Cherry Crush');
    projectB = await mk('Quick Hits');
    const a = await as('root', `/assets/project/${projectA}`, {
      method: 'POST', body: { name: 'Reel A', type: 'prop', assigneeId: id.artist } });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    assetId = a.body.asset.id;
  });
  t.after(() => stopServer(server));

  await t.test('only a Super Admin can reach the screen', async () => {
    for (const who of ['cto', 'lead', 'artist', 'mis']) {
      assert.strictEqual((await as(who, ROOT)).status, 403, `GET as ${who}`);
      assert.strictEqual((await as(who, `${ROOT}/${id.mis}`, {
        method: 'PUT', body: { projectIds: [projectA] } })).status, 403, `PUT as ${who}`);
      assert.strictEqual((await as(who, `/admin/projects/${projectA}/mis-assignments`, {
        method: 'POST', body: { userId: id.mis } })).status, 403, `POST as ${who}`);
      assert.strictEqual((await as(who, `/admin/projects/${projectA}/mis-assignments/${id.mis}`, {
        method: 'DELETE' })).status, 403, `DELETE as ${who}`);
    }
    const rows = await sql(cfg, `SELECT * FROM project_members WHERE user_id = '${id.mis}'`);
    assert.strictEqual(rows.length, 0, 'and none of them attached anybody');
  });

  await t.test('the roster is the staff side, and only them', async () => {
    const got = await as('root', ROOT);
    assert.strictEqual(got.status, 200);
    const listed = got.body.people.map((p) => p.id);
    assert.ok(listed.includes(id.mis), 'the MIS analyst is offered');
    for (const who of ['artist', 'lead', 'cto']) {
      assert.ok(!listed.includes(id[who]), `${who} is not offered view-only access this way`);
    }
    assert.strictEqual(got.body.grants, 'view', 'and the API says what it hands over');
    assert.ok(got.body.projects.length >= 2, 'with the projects to pick from');
  });

  await t.test('before attaching, the MIS analyst sees nothing', async () => {
    assert.deepStrictEqual((await as('mis', '/projects')).body.projects, []);
    assert.strictEqual((await as('mis', `/assets/project/${projectA}`)).status, 403);
  });

  await t.test('attaching gives sight of exactly the projects picked', async () => {
    const put = await as('root', `${ROOT}/${id.mis}`, { method: 'PUT', body: { projectIds: [projectA] } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    const seen = await as('mis', '/projects');
    assert.deepStrictEqual(seen.body.projects.map((p) => p.id), [projectA], 'that one, and not the other');
    const board = await as('mis', `/assets/project/${projectA}`);
    assert.strictEqual(board.status, 200);
    assert.strictEqual(board.body.assets.length, 1, 'with the project\'s work on it');
    assert.strictEqual((await as('mis', `/assets/project/${projectB}`)).status, 403,
      'and the project they were not put on stays shut');

    // Multi-select: more than one, which is the whole point of the screen.
    assert.strictEqual((await as('root', `${ROOT}/${id.mis}`, {
      method: 'PUT', body: { projectIds: [projectA, projectB] } })).status, 200);
    const both = await as('mis', '/projects');
    assert.deepStrictEqual(both.body.projects.map((p) => p.id).sort(), [projectA, projectB].sort());
  });

  await t.test('VIEW ONLY: every way to change something is refused', async () => {
    /* THE CLAIM THE FEATURE RESTS ON, checked by trying rather than by reading
       a permission list. The asset is driven into the state each action needs
       first, so a refusal here is authority and not "wrong stage" — a 409 would
       mean the request got past the gate and failed on state, which is not the
       same as being refused and would come back to bite the first time the
       state was right. */
    assert.strictEqual((await as('artist', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);

    const refusals = [
      ['create an asset', () => as('mis', `/assets/project/${projectA}`, {
        method: 'POST', body: { name: 'Sneaky', type: 'prop' } })],
      ['edit an asset', () => as('mis', `/assets/${assetId}`, {
        method: 'PATCH', body: { name: 'Renamed by MIS' } })],
      ['delete an asset', () => as('mis', `/assets/${assetId}`, { method: 'DELETE' })],
      ['assign it to themselves', () => as('mis', `/assets/${assetId}/assign`, {
        method: 'POST', body: { assigneeId: id.mis } })],
      ['start the timer', () => as('mis', `/assets/${assetId}/start`, { method: 'POST' })],
      ['hold it', () => as('mis', `/assets/${assetId}/hold`, { method: 'POST', body: { note: 'stop' } })],
      ['submit somebody else\'s started work', () => as('mis', `/assets/${assetId}/submit`, {
        method: 'POST', body: { link: 'https://example.com/v1' } })],
      /* The one that was open. Notes asked only "can you see this asset", so
         attaching somebody for a look also let them write on the work. */
      ['leave a note on the work', () => as('mis', `/assets/${assetId}/notes`, {
        method: 'POST', body: { text: 'a note from MIS' } })],
      ['reassign it', () => as('mis', `/assets/${assetId}/reassign`, {
        method: 'POST', body: { assigneeId: id.artist } })],
      ['edit the project', () => as('mis', `/projects/${projectA}`, {
        method: 'PATCH', body: { name: 'MIS project' } })],
      ['delete the project', () => as('mis', `/projects/${projectA}`, { method: 'DELETE' })],
      ['create a project', () => as('mis', '/projects', {
        method: 'POST', body: { name: 'Mine', clientId: 'x' } })],
      ['add a user', () => as('mis', '/users', {
        method: 'POST', body: { name: 'X', email: 'x@zvky.test', role: 'game_artist', password: PASSWORD } })],
    ];
    for (const [label, go] of refusals) {
      const r = await go();
      assert.ok([401, 403, 404].includes(r.status),
        `MIS could ${label} — got ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }

    // Driven to TL Review, the review endpoints refuse on authority too.
    assert.strictEqual((await as('artist', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } })).status, 201);
    for (const decision of ['approved', 'changes_requested']) {
      const r = await as('mis', `/assets/${assetId}/review`, {
        method: 'POST', body: { decision, text: 'no' } });
      assert.strictEqual(r.status, 403, `MIS could review (${decision}): ${JSON.stringify(r.body)}`);
    }

    // And reading still works throughout — the point of the feature.
    assert.strictEqual((await as('mis', `/assets/project/${projectA}`)).status, 200);
  });

  await t.test('somebody who works the pipeline cannot be attached this way', async () => {
    /* BOTH DOORS, because they are two code paths and only one of them was
       checked the first time. An artist put on a project through this screen
       would be a silent second way of doing what the Edit User form does with
       its own permission and its own audit entry — and for a designation whose
       pipeline is open, "attached" does not mean view-only at all. */
    const put = await as('root', `${ROOT}/${id.artist}`, { method: 'PUT', body: { projectIds: [projectA] } });
    assert.strictEqual(put.status, 400, `person-first: ${JSON.stringify(put.body)}`);

    const post = await as('root', `/admin/projects/${projectA}/mis-assignments`, {
      method: 'POST', body: { userId: id.artist } });
    assert.strictEqual(post.status, 400, `project-first: ${JSON.stringify(post.body)}`);

    // And a lead, who is assignable AND leads a team.
    assert.strictEqual((await as('root', `/admin/projects/${projectA}/mis-assignments`, {
      method: 'POST', body: { userId: id.lead } })).status, 400);

    const rows = await sql(cfg,
      `SELECT * FROM project_members WHERE user_id IN ('${id.artist}','${id.lead}')
         AND project_id = '${projectA}'`);
    assert.strictEqual(rows.length, 0, 'and nothing was written by either door');
  });

  await t.test('a note from somebody who DOES work the pipeline still goes through', async () => {
    /* The fix above must close one door without closing the one beside it: the
       lead's notes are how a review conversation happens, and breaking those to
       protect against MIS would be a worse bug than the one being fixed. */
    const r = await as('lead', `/assets/${assetId}/notes`, { method: 'POST', body: { text: 'looks good' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  });

  await t.test('taking access away takes effect on the next request', async () => {
    assert.strictEqual((await as('root', `${ROOT}/${id.mis}`, {
      method: 'PUT', body: { projectIds: [] } })).status, 200);
    /* No new sign-in: the project list and the permission set are both worked
       out per request, so there is no cached session to wait out. Asked with the
       SAME token that could see the board a moment ago. */
    assert.deepStrictEqual((await as('mis', '/projects')).body.projects, []);
    assert.strictEqual((await as('mis', `/assets/project/${projectA}`)).status, 403);
  });

  await t.test('the project-first endpoints write the same rows', async () => {
    const add = await as('root', `/admin/projects/${projectA}/mis-assignments`, {
      method: 'POST', body: { userId: id.mis } });
    assert.strictEqual(add.status, 201, JSON.stringify(add.body));
    assert.strictEqual((await as('mis', `/assets/project/${projectA}`)).status, 200);

    // Idempotent: attaching twice is the same state, not an error.
    assert.strictEqual((await as('root', `/admin/projects/${projectA}/mis-assignments`, {
      method: 'POST', body: { userId: id.mis } })).status, 200);

    const gone = await as('root', `/admin/projects/${projectA}/mis-assignments/${id.mis}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200);
    assert.strictEqual((await as('mis', `/assets/project/${projectA}`)).status, 403);
  });

  await t.test('who attached whom is recorded, on the row and in the log', async () => {
    assert.strictEqual((await as('root', `${ROOT}/${id.mis}`, {
      method: 'PUT', body: { projectIds: [projectA] } })).status, 200);

    const [row] = await sql(cfg,
      `SELECT assigned_by, assigned_at FROM project_members
        WHERE user_id = '${id.mis}' AND project_id = '${projectA}'`);
    assert.strictEqual(String(row.assigned_by), String(id.root), 'the row says who');
    assert.ok(row.assigned_at, 'and when');

    const log = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'settings.mis_access');
    assert.ok(log.length, 'and the Activity Log has it');
    assert.match(log[0].summary, /Meera MIS/);
    assert.match(log[0].summary, /Cherry Crush/);
    assert.strictEqual(log[0].actor.email, 'root@zvky.test');

    // Removals too, named.
    assert.strictEqual((await as('root', `${ROOT}/${id.mis}`, {
      method: 'PUT', body: { projectIds: [] } })).status, 200);
    const after = (await as('root', '/activity?limit=50')).body.entries
      .filter((e) => e.action === 'settings.mis_access');
    assert.match(after[0].summary, /took away/);
  });
});
