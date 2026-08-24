const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const reporting = require('../src/reporting');
const userProject = require('../src/user-project');

const cfg = config('reporting');

const CEO = 'managing_director_ceo';
const VP = 'vice_president_global_operations_business_development';

// --- pure checks -------------------------------------------------------------

test('the top of the hierarchy is read from the tier, not a list of keys', () => {
  // Both designations named in the requirement sit in the Leadership tier, so
  // the rule follows the tier — renaming one in Settings cannot quietly give
  // the person running the studio a Reporting To field.
  assert.strictEqual(reporting.isTopOfHierarchy(CEO), true);
  assert.strictEqual(reporting.isTopOfHierarchy(VP), true);
  for (const role of ['team_lead', 'game_artist', 'coordinator', 'art_director', 'super_admin', 'admin']) {
    assert.strictEqual(reporting.isTopOfHierarchy(role), false, `${role} should report to someone`);
  }
  assert.strictEqual(reporting.isTopOfHierarchy('not_a_role'), false);
  assert.strictEqual(reporting.isTopOfHierarchy(undefined), false);
});

test('a project membership lands on the side the designation belongs to', () => {
  assert.strictEqual(userProject.tableForRole('coordinator'), 'project_coordinators');
  assert.strictEqual(userProject.tableForRole('team_lead'), 'project_team_leads');
  // The gap this feature closed: contributors had no project link at all.
  assert.strictEqual(userProject.tableForRole('game_artist'), 'project_members');
  assert.strictEqual(userProject.tableForRole(CEO), 'project_members');
  assert.strictEqual(userProject.tableForRole('nonsense'), 'project_members');
});

// --- against a live server ---------------------------------------------------

test('editing a user\'s project and reporting line', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Reporting-Test-1!';
  let server;
  let token;
  let project;
  let other;
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const patch = (id, body) => call(`/users/${id}`, { token, method: 'PATCH', body });
  const detail = async (id) => (await call(`/users/${id}`, { token })).body.user;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'reporting-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'reporting-token', name: 'Org Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    token = (await call('/auth/login', {
      method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    })).body.token;

    project = (await call('/projects', { token, method: 'POST', body: { name: 'Skyfall' } })).body.project;
    other = (await call('/projects', { token, method: 'POST', body: { name: 'Nightfall' } })).body.project;

    for (const [key, name, email, role] of [
      ['ceo', 'Asha Rao', 'ceo@zvky.test', CEO],
      ['vp', 'Rohit Nair', 'vp@zvky.test', VP],
      ['lead', 'Priya Menon', 'lead@zvky.test', 'team_lead'],
      ['artist', 'Sam Iyer', 'art@zvky.test', 'game_artist'],
      ['artist2', 'Dev Kumar', 'art2@zvky.test', 'game_artist'],
      ['coordinator', 'Meera Das', 'coord@zvky.test', 'coordinator'],
    ]) {
      const res = await call('/users', { token, method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[key] = res.body.user.id;
    }
  });

  t.after(() => stopServer(server));

  await t.test('a regular role can be given a project and a manager', async () => {
    const res = await patch(people.artist, { projectId: project.id, reportsToId: people.lead });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.user.project.name, 'Skyfall');
    assert.strictEqual(res.body.user.reportsTo.name, 'Priya Menon');
    assert.strictEqual(res.body.user.topOfHierarchy, false);

    // And it is stored where the permission checks already look.
    const rows = await sql(cfg, `SELECT user_id FROM project_members WHERE project_id = '${project.id}'`);
    assert.ok(rows.some((r) => r.user_id === people.artist), 'a contributor belongs in project_members');
  });

  await t.test('the project can be changed, and moves rather than accumulating', async () => {
    await patch(people.artist, { projectId: other.id });
    assert.strictEqual((await detail(people.artist)).project.name, 'Nightfall');

    const rows = await sql(cfg, `SELECT project_id FROM project_members WHERE user_id = '${people.artist}'`);
    assert.strictEqual(rows.length, 1, 'one project, not two');
    assert.strictEqual(rows[0].project_id, other.id);

    // And can be removed entirely.
    await patch(people.artist, { projectId: null });
    assert.strictEqual((await detail(people.artist)).project, null);
    await patch(people.artist, { projectId: project.id });
  });

  await t.test('a designation change moves the membership to the right table', async () => {
    await patch(people.coordinator, { projectId: project.id });
    let rows = await sql(cfg, `SELECT user_id FROM project_coordinators WHERE user_id = '${people.coordinator}'`);
    assert.strictEqual(rows.length, 1, 'a coordinator sits in project_coordinators');

    // Promoted to a lead: the row has to move, or the permission checks would
    // still read them as a coordinator on that project.
    await patch(people.coordinator, { role: 'team_lead' });
    rows = await sql(cfg, `SELECT user_id FROM project_coordinators WHERE user_id = '${people.coordinator}'`);
    assert.strictEqual(rows.length, 0, 'the old row must not be left behind');
    rows = await sql(cfg, `SELECT user_id FROM project_team_leads WHERE user_id = '${people.coordinator}'`);
    assert.strictEqual(rows.length, 1, 'and the new one must exist');
    assert.strictEqual((await detail(people.coordinator)).project.name, 'Skyfall', 'still on the same project');
  });

  await t.test('CEO and VP have no reporting line at all', async () => {
    for (const key of ['ceo', 'vp']) {
      const user = await detail(people[key]);
      assert.strictEqual(user.topOfHierarchy, true);
      assert.strictEqual(user.reportsTo, null, 'not an empty value — absent');
      assert.strictEqual(user.reportsToId, null);

      // The dropdown is not merely empty; it says why.
      const options = await call(`/users/${people[key]}/manager-options`, { token });
      assert.strictEqual(options.body.topOfHierarchy, true);
      assert.strictEqual(options.body.options.length, 0);
      assert.match(options.body.reason, /top of the hierarchy/i);

      // And the API refuses one even if something bypasses the form.
      const attempt = await patch(people[key], { reportsToId: people.lead });
      assert.strictEqual(attempt.status, 400, 'the rule is enforced server-side, not only hidden in the UI');
      assert.match(attempt.body.error, /top of the hierarchy/i);
      assert.strictEqual(attempt.body.field, 'reportsToId');
    }
  });

  await t.test('they can still be somebody else\'s manager', async () => {
    // Top of the hierarchy means they report to no one, not that no one reports
    // to them.
    const res = await patch(people.lead, { reportsToId: people.vp });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.user.reportsTo.name, 'Rohit Nair');
  });

  await t.test('nobody can report to themselves', async () => {
    const res = await patch(people.artist, { reportsToId: people.artist });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot report to themselves/i);
    // The rejected edit changed nothing.
    assert.strictEqual((await detail(people.artist)).reportsTo.name, 'Priya Menon');
  });

  await t.test('a direct loop is refused', async () => {
    // Sam reports to Priya, so Priya cannot report to Sam.
    const res = await patch(people.lead, { reportsToId: people.artist });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /reporting loop/i);
    assert.match(res.body.error, /Sam Iyer already reports to Priya Menon/);
  });

  await t.test('a longer loop is refused, and the chain is named', async () => {
    // Chain: Sam -> Priya -> Rohit. Rohit must not be able to report to Sam.
    await patch(people.vp, { role: 'senior_producer' }); // so the VP can have a manager at all
    await patch(people.vp, { reportsToId: null });
    await patch(people.lead, { reportsToId: people.vp });
    await patch(people.artist, { reportsToId: people.lead });

    const res = await patch(people.vp, { reportsToId: people.artist });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /reporting loop/i);
    // Names the path rather than just refusing, so the reason is actionable.
    assert.match(res.body.error, /through Priya Menon/);
    assert.deepStrictEqual(res.body.chain, ['Sam Iyer', 'Priya Menon', 'Rohit Nair']);
  });

  await t.test('the dropdown never offers a choice the API would refuse', async () => {
    const res = await call(`/users/${people.lead}/manager-options`, { token });
    const ids = res.body.options.map((o) => o.id);
    assert.ok(!ids.includes(people.lead), 'not themselves');
    assert.ok(!ids.includes(people.artist), 'not somebody who reports to them');
    assert.ok(ids.includes(people.ceo), 'but the CEO is a perfectly good manager');

    // Every remaining option really is acceptable.
    for (const id of ids) {
      const attempt = await patch(people.lead, { reportsToId: id });
      assert.strictEqual(attempt.status, 200, `option ${id} was offered but refused`);
    }
    await patch(people.lead, { reportsToId: people.vp });
  });

  await t.test('promoting someone to the top clears their reporting line', async () => {
    await patch(people.artist2, { reportsToId: people.lead });
    assert.strictEqual((await detail(people.artist2)).reportsTo.name, 'Priya Menon');

    // Requirement: changing the role mid-edit clears it, without the form
    // having to remember to send anything.
    const res = await patch(people.artist2, { role: CEO });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.user.topOfHierarchy, true);
    assert.strictEqual(res.body.user.reportsTo, null);

    const rows = await sql(cfg, `SELECT reports_to_id FROM users WHERE id = '${people.artist2}'`);
    assert.strictEqual(rows[0].reports_to_id, null, 'cleared in the database, not just in the response');
  });

  await t.test('a reporting line is optional and can be left unset', async () => {
    // The decision on this feature: optional, so an edit is never blocked
    // because the right manager does not exist yet.
    const res = await patch(people.artist, { reportsToId: null });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.reportsTo, null);
    assert.strictEqual(res.body.user.topOfHierarchy, false, 'unset is not the same as top of hierarchy');
  });

  await t.test('a manager that does not exist is refused', async () => {
    const res = await patch(people.artist, { reportsToId: '00000000-0000-0000-0000-000000000000' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /does not exist/i);
  });

  await t.test('a project that does not exist is refused', async () => {
    const res = await patch(people.artist, { projectId: '00000000-0000-0000-0000-000000000000' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.field, 'projectId');
  });

  await t.test('the list shows the manager and project without a query per row', async () => {
    const res = await call('/users?limit=100', { token });
    assert.strictEqual(res.status, 200);
    const lead = res.body.users.find((u) => u.email === 'lead@zvky.test');
    assert.strictEqual(lead.reportsToName, 'Rohit Nair');
    assert.strictEqual(lead.projectName, null);

    const ceo = res.body.users.find((u) => u.email === 'ceo@zvky.test');
    assert.strictEqual(ceo.topOfHierarchy, true);
    assert.strictEqual(ceo.reportsToName, null, 'shown as top of hierarchy, not as an empty manager');
  });

  await t.test('a user id in the path never shadows the import routes', async () => {
    // '/:id' is registered after the literal paths for exactly this reason.
    const template = await call('/users/import-template.csv', { token });
    assert.notStrictEqual(template.status, 404);
    const format = await call('/users/import-format', { token });
    assert.strictEqual(format.status, 200);
    assert.ok(format.body.columns, 'this is the import format, not a user');
  });
});
