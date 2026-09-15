const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
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

    const clientId = await systemClientId(server.base, token);
    project = (await call('/projects', { token, method: 'POST', body: { clientId, name: 'Skyfall' } })).body.project;
    other = (await call('/projects', { token, method: 'POST', body: { clientId, name: 'Nightfall' } })).body.project;

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

  await t.test('the dropdown offers everybody but the person themselves', async () => {
    /* THIS TEST USED TO ASSERT THE OPPOSITE, and the change is deliberate.
     *
     * It read "the dropdown never offers a choice the API would refuse", and
     * the list was narrowed to candidates a save would accept. The studio's
     * decision is that Reporting To is an informational field, so the list is
     * now every other account — not filtered by role, designation, or who
     * reports to whom.
     *
     * What replaces the old guarantee is a FLAG rather than an omission: a row
     * that would close a reporting loop still comes back, carrying wouldLoop so
     * the form can say so before somebody picks it. The API still refuses the
     * save, which is what keeps the hierarchy from eating its own tail.
     */
    const res = await call(`/users/${people.lead}/manager-options`, { token });
    const ids = res.body.options.map((o) => o.id);
    assert.ok(!ids.includes(people.lead), 'not themselves — the one real exclusion');
    assert.ok(ids.includes(people.ceo), 'the CEO is a perfectly good manager');
    assert.ok(ids.includes(people.artist),
      'and so is somebody who reports to them — offered, and flagged as circular');

    const circular = res.body.options.find((o) => o.id === people.artist);
    assert.strictEqual(circular.wouldLoop, true);

    // The flag has to be true: the save is still refused.
    const refused = await patch(people.lead, { reportsToId: people.artist });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /loop/i);

    // And everything NOT flagged really is acceptable.
    for (const o of res.body.options.filter((x) => !x.wouldLoop)) {
      const attempt = await patch(people.lead, { reportsToId: o.id });
      assert.strictEqual(attempt.status, 200, `option ${o.id} was offered unflagged but refused`);
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

  /* ---- Level 2 Reporting -------------------------------------------------
   *
   * Reporting To was split into two INDEPENDENT fields. Level 1 IS the old
   * reports_to_id column, relabelled — so every value a studio had recorded is
   * already where Level 1 expects it, and the four places that read that column
   * go on reading it unchanged. Level 2 is a new column nothing reads.
   */

  await t.test('Level 1 is the old column, so existing data is already there', async () => {
    /* The brief's testing step 2, stated as the thing that makes it true: the
       value set through the old single field IS the Level 1 value, because it
       is the same column. Nothing was copied, so nothing could be half-copied. */
    await patch(people.artist, { reportsToId: people.lead });
    const [row] = await sql(cfg, `SELECT reports_to_id, reports_to_l2_id FROM users WHERE id = '${people.artist}'`);
    assert.strictEqual(row.reports_to_id, people.lead, 'Level 1 reads the original column');
    assert.strictEqual(row.reports_to_l2_id, null, 'and Level 2 starts blank');

    const shown = await detail(people.artist);
    assert.strictEqual(shown.reportsToId, people.lead);
    assert.strictEqual(shown.reportsToL2Id, null);
  });

  await t.test('both lines save independently and can point at different people', async () => {
    // Testing step 3.
    const res = await patch(people.artist, { reportsToId: people.lead, reportsToL2Id: people.artist2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const user = await detail(people.artist);
    assert.strictEqual(user.reportsToId, people.lead);
    assert.strictEqual(user.reportsToL2Id, people.artist2);
    assert.strictEqual(user.reportsTo.id, people.lead, 'and both resolve to a person');
    assert.strictEqual(user.reportsToL2.id, people.artist2);

    /* Changing one leaves the other exactly where it was — the property the
       word "independent" is doing all the work for. */
    await patch(people.artist, { reportsToL2Id: people.lead });
    let after = await detail(people.artist);
    assert.strictEqual(after.reportsToId, people.lead, 'Level 1 untouched');
    assert.strictEqual(after.reportsToL2Id, people.lead, 'Level 2 moved');

    await patch(people.artist, { reportsToId: people.artist2 });
    after = await detail(people.artist);
    assert.strictEqual(after.reportsToId, people.artist2, 'Level 1 moved');
    assert.strictEqual(after.reportsToL2Id, people.lead, 'Level 2 untouched');

    // Either can be cleared on its own.
    await patch(people.artist, { reportsToL2Id: null });
    after = await detail(people.artist);
    assert.strictEqual(after.reportsToL2Id, null);
    assert.strictEqual(after.reportsToId, people.artist2, 'clearing one did not clear the other');
  });

  await t.test('nobody can be their own Level 2 either', async () => {
    // Testing step 4, for the second field.
    const res = await patch(people.artist, { reportsToL2Id: people.artist });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.field, 'reportsToL2Id');
    assert.match(res.body.error, /cannot report to themselves/i);

    const missing = await patch(people.artist, { reportsToL2Id: '00000000-0000-0000-0000-000000000000' });
    assert.strictEqual(missing.status, 400);
    assert.match(missing.body.error, /does not exist/i);
  });

  await t.test('Level 2 takes a shape Level 1 refuses, because nothing walks it', async () => {
    /* A and B pointing at each other on the second line is not a loop, because
       no code path follows the column. Level 1 still refuses the same shape —
       asserted here so the two rules cannot quietly converge. */
    await patch(people.artist, { reportsToId: people.lead });

    const l1 = await patch(people.lead, { reportsToId: people.artist });
    assert.strictEqual(l1.status, 400, 'Level 1 still refuses a loop');
    assert.match(l1.body.error, /loop/i);

    const l2a = await patch(people.artist, { reportsToL2Id: people.lead });
    const l2b = await patch(people.lead, { reportsToL2Id: people.artist });
    assert.strictEqual(l2a.status, 200);
    assert.strictEqual(l2b.status, 200, 'Level 2 accepts it — no traversal, no loop');
  });

  await t.test('the top of the hierarchy has no Level 1 but may have a Level 2', async () => {
    const ceo = (await call('/users', { token, method: 'POST',
      body: { name: 'Top Person', email: 'top-l2@zvky.test', password: PASSWORD,
        role: 'managing_director_ceo' } })).body.user.id;

    const refused = await patch(ceo, { reportsToId: people.lead });
    assert.strictEqual(refused.status, 400, 'no first line for the top of the chain');

    const ok = await patch(ceo, { reportsToL2Id: people.lead });
    assert.strictEqual(ok.status, 200, 'but a second line is an independent note');
    const user = await detail(ceo);
    assert.strictEqual(user.reportsToId, null);
    assert.strictEqual(user.reportsToL2Id, people.lead);
  });

  await t.test('promoting somebody to the top clears Level 1 and leaves Level 2 alone', async () => {
    const who = (await call('/users', { token, method: 'POST',
      body: { name: 'Promote Me', email: 'promote-l2@zvky.test', password: PASSWORD,
        role: 'game_artist' } })).body.user.id;
    await patch(who, { reportsToId: people.lead, reportsToL2Id: people.artist2 });

    const res = await patch(who, { role: 'managing_director_ceo' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const [row] = await sql(cfg, `SELECT reports_to_id, reports_to_l2_id FROM users WHERE id = '${who}'`);
    assert.strictEqual(row.reports_to_id, null, 'the real chain was cleared by the promotion');
    assert.strictEqual(row.reports_to_l2_id, people.artist2,
      'the second line is a separate note and was not deleted as a side effect');
  });

  await t.test('the list carries both lines, still without a query per row', async () => {
    // Testing step 6, and the performance property the single-line version had.
    await patch(people.artist, { reportsToId: people.lead, reportsToL2Id: people.artist2 });
    const list = (await call('/users?limit=100', { token })).body.users;
    const row = list.find((u) => u.id === people.artist);
    assert.strictEqual(row.reportsToName, 'Priya Menon');
    assert.strictEqual(row.reportsToL2Name, 'Dev Kumar');
    // Somebody with neither reads as neither, not as an empty string.
    const bare = list.find((u) => u.reportsToId === null && u.reportsToL2Id === null);
    assert.ok(bare, 'somebody has neither line');
    assert.strictEqual(bare.reportsToL2Name, null);
  });

  await t.test('setting either line needs user.change_reporting', async () => {
    /* A plain contributor account, signing in as itself. */
    const plainToken = (await call('/auth/login', { method: 'POST',
      body: { email: 'art@zvky.test', password: PASSWORD } })).body.token;
    for (const body of [{ reportsToId: people.lead }, { reportsToL2Id: people.lead }]) {
      const res = await call(`/users/${people.artist2}`, { token: plainToken, method: 'PATCH', body });
      assert.ok(res.status === 403 || res.status === 404,
        `${JSON.stringify(body)} should be refused, got ${res.status}`);
    }
  });

  await t.test('a valueless SET does not shift the columns after it', async () => {
    /* THE BUG THIS EXISTS FOR, found by driving the real screen.
     *
     * The UPDATE is built as two parallel arrays, and two branches push a field
     * with NO value: `team_lead_id = NULL` when a designation stops being
     * assignable, and `reports_to_id = NULL` on promotion to the top. The
     * placeholders were numbered from fields.length, so one valueless field
     * shifted every later placeholder by one and each following column was
     * written with the NEXT column's value.
     *
     * The Edit User form sends role, both reporting lines and the rest together,
     * so this is an ordinary save, not a corner. Setting a NON-ASSIGNABLE
     * designation is what triggers the valueless push. */
    const who = (await call('/users', { token, method: 'POST',
      body: { name: 'Shift Probe', email: 'shift@zvky.test', password: PASSWORD,
        role: 'game_artist' } })).body.user.id;

    const res = await patch(who, {
      name: 'Shift Probe',
      email: 'shift@zvky.test',
      role: 'art_director',            // not assignable -> team_lead_id = NULL
      reportsToId: people.lead,
      reportsToL2Id: people.artist2,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const [row] = await sql(cfg,
      `SELECT \`name\`, email, \`role\`, team_lead_id, reports_to_id, reports_to_l2_id
         FROM users WHERE id = '${who}'`);
    assert.strictEqual(row.name, 'Shift Probe', 'the name is the name');
    assert.strictEqual(row.email, 'shift@zvky.test', 'the email is the email');
    assert.strictEqual(row.role, 'art_director');
    assert.strictEqual(row.team_lead_id, null, 'cleared, as the branch intends');
    assert.strictEqual(row.reports_to_id, people.lead,
      'Level 1 holds the Level 1 value — not the one meant for Level 2');
    assert.strictEqual(row.reports_to_l2_id, people.artist2,
      'and Level 2 holds its own');
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
