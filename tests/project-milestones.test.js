/* The dated stages inside a project.
 *
 * What is worth testing here is not "can a milestone be saved" — it is the four
 * places this feature could quietly do the wrong thing:
 *
 *   THE THREE LISTS STAY APART. "Animation" is an asset type AND a milestone
 *   type, and the words are the same. A validator or a dropdown reading the
 *   wrong collection would appear to work perfectly, and by the time anybody
 *   noticed, an asset type would be selectable as a milestone.
 *
 *   THE SOFT RULE IS SOFT AND THE HARD RULE IS HARD. A milestone outside the
 *   project's own window WARNS and saves; a milestone that ends before it
 *   begins is REFUSED. Getting either backwards is invisible until somebody
 *   loses a save they meant to make, or keeps one they did not.
 *
 *   THE WINDOW IS THE ONE THE PROJECT WILL HAVE. An edit that moves the project
 *   and its milestones in the same request must be judged against the new
 *   dates, or moving a project forward warns about every milestone under it.
 *
 *   THE PERMISSION CANNOT SILENTLY DELETE. project.milestones is what lets
 *   somebody set them; the failure mode to test for is a role WITHOUT it saving
 *   the project and wiping the milestones by omission.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const referenceData = require('../src/reference-data');
const milestones = require('../src/project-milestones');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('milestones');

test('milestone types are their own collection', () => {
  const c = referenceData.COLLECTIONS.milestone_types;
  assert.ok(c, 'the collection exists');
  assert.strictEqual(c.table, 'milestone_types', 'in a table of its own');
  /* Retiring a type asks whether any PROJECT MILESTONE holds it. Pointed at
     assets it would refuse to retire "Animation" because some asset is one,
     which is the shape of the merge the separate tables exist to prevent. */
  assert.strictEqual(c.usedBy.table, 'project_milestones');
  assert.strictEqual(c.usedBy.column, 'milestone_type');
  assert.notStrictEqual(referenceData.COLLECTIONS.asset_types.table, c.table,
    'and it is not the asset type list wearing another name');
});

test('the two milestone permissions are separate, and neither is on for everyone', () => {
  const list = catalogue.BY_KEY.get('settings.milestone_types');
  const set = catalogue.BY_KEY.get('project.milestones');
  assert.ok(list && set, 'both are in the catalogue');

  // Managing the list travels with Settings; setting them travels with project
  // editing. That ordering is the point: the list is the tighter of the two.
  assert.strictEqual(list.impliedBy({ manageSettings: true }), true);
  assert.strictEqual(list.impliedBy({ createProject: true }), false,
    'somebody who can make projects does not thereby manage the studio-wide list');
  assert.strictEqual(set.impliedBy({ createProject: true }), true);
  assert.strictEqual(list.impliedBy({}), false);
  assert.strictEqual(set.impliedBy({}), false);
});

/* The rules, checked against the module directly. Every one of these is also
   exercised through the API below; these are here because a rule asserted at
   the level it is written at says which rule broke, and the API test says only
   that something did. */
test('the validator', async (t) => {
  /* Seeded in memory rather than read from a database. The rules below are
     arithmetic on dates and a lookup in a list — none of them needs a server,
     and requiring one would mean these never run on a machine without a test
     database, which is exactly when a rule quietly changes. The seed matches
     what src/reference-defaults.js ships. */
  referenceData.seedCache('milestone_types', [
    { id: '1', key: 'art', label: 'Art', color: '#ff5a36', position: 20, isActive: true, isSystem: false },
    { id: '2', key: 'animation', label: 'Animation', color: '#4fb3ff', position: 10, isActive: true, isSystem: false },
    { id: '3', key: 'retired', label: 'Retired', color: null, position: 5, isActive: false, isSystem: false },
  ]);

  await t.test('refuses a milestone that ends before it begins', () => {
    const v = milestones.validate([{ type: 'art', startDate: '2026-05-10', endDate: '2026-05-01' }], {});
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /cannot end before it begins/i);
  });

  await t.test('refuses two milestones of the same type', () => {
    const v = milestones.validate([
      { type: 'art', startDate: '2026-01-01', endDate: '2026-02-01' },
      { type: 'art', startDate: '2026-03-01', endDate: '2026-04-01' },
    ], {});
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /already has a Art milestone|One of each/i);
  });

  await t.test('refuses a type nobody put on the list', () => {
    const v = milestones.validate([{ type: 'rigging', startDate: '2026-01-01', endDate: '2026-02-01' }], {});
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /not a milestone type/i);
  });

  await t.test('WARNS, and does not refuse, outside the project window', () => {
    const v = milestones.validate([{ type: 'art', startDate: '2026-01-01', endDate: '2026-02-01' }],
      { startDate: '2026-03-01', endDate: '2026-12-01' });
    assert.strictEqual(v.ok, true, 'the save is allowed');
    assert.strictEqual(v.milestones.length, 1, 'and the milestone is kept');
    assert.strictEqual(v.warnings.length, 1);
    assert.match(v.warnings[0].message, /before the project's own start date/i);
  });

  await t.test('says nothing when the project has no dates of its own', () => {
    const v = milestones.validate([{ type: 'art', startDate: '2026-01-01', endDate: '2026-02-01' }], {});
    assert.strictEqual(v.ok, true);
    assert.deepStrictEqual(v.warnings, [], 'there is nothing to be outside of');
  });

  await t.test('refuses a type that has been retired', () => {
    const v = milestones.validate([{ type: 'retired', startDate: '2026-01-01', endDate: '2026-02-01' }], {});
    assert.strictEqual(v.ok, false, 'a deactivated type is not offered and is not accepted');
  });

  await t.test('orders by the list, not by the order they were sent', () => {
    const v = milestones.validate([
      { type: 'animation', startDate: '2026-06-01', endDate: '2026-09-01' },
      { type: 'art', startDate: '2026-02-01', endDate: '2026-05-01' },
    ], {});
    assert.strictEqual(v.ok, true);
    assert.deepStrictEqual(v.milestones.map((m) => m.label), ['Art', 'Animation'],
      'so two projects with the same milestones read the same way down the column');
  });

  await t.test('an absent list means "leave them alone", an empty one means "none"', () => {
    assert.strictEqual(milestones.validate(undefined, {}).milestones, null);
    assert.deepStrictEqual(milestones.validate([], {}).milestones, []);
  });
});

test('project milestones', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Milestone-1!';
  let server;
  const token = {};
  let clientId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const makeProject = (body) => as('root', '/projects', { method: 'POST', body: { clientId, ...body } });
  // The project row exactly as the Projects list under a client receives it.
  const onTab = async (id) => {
    const { clients } = (await as('root', '/clients?includeArchived=1')).body;
    for (const c of clients) {
      const found = [...c.projects, ...(c.archivedProjects || [])].find((p) => p.id === id);
      if (found) return found;
    }
    return null;
  };
  const grant = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const next = [...new Set([...held, ...keys])];
    await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: next } });
    return held;
  };
  const revoke = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const next = held.filter((k) => !keys.includes(k));
    await as('root', `/permissions/roles/${role}`, { method: 'PUT', body: { permissions: next } });
    return next;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ms-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'ms-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);
  });

  t.after(() => stopServer(server));

  await t.test('Art and Animation are there to begin with', async () => {
    const entries = (await as('root', '/reference/milestone-types')).body.entries;
    const keys = entries.map((e) => e.key);
    assert.ok(keys.includes('art') && keys.includes('animation'),
      `the studio's two stages ship with it — got ${keys.join(', ')}`);
  });

  await t.test('a new type is added in Settings and becomes selectable', async () => {
    // Testing step 1, end to end: add "Rigging", then use it on a project.
    const made = await as('root', '/reference/milestone-types', { method: 'POST', body: { label: 'Rigging' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.entry.key, 'rigging', 'the key comes from the label');

    const project = (await makeProject({ name: 'Rigged',
      milestones: [{ type: 'rigging', startDate: '2026-04-01', endDate: '2026-05-01' }] })).body.project;
    assert.strictEqual(project.milestones.length, 1);
    assert.strictEqual(project.milestones[0].type, 'rigging');
    assert.strictEqual(project.milestones[0].label, 'Rigging', 'labelled for whoever reads it');
  });

  await t.test('two milestones stack on the Projects list, in list order', async () => {
    // Testing step 2. Deliberately submitted Animation-first, to prove the
    // order in the cell comes from the list rather than from the request.
    const project = (await makeProject({
      name: 'Nightgarden', startDate: '2026-01-01', endDate: '2026-12-31',
      milestones: [
        { type: 'animation', startDate: '2026-06-01', endDate: '2026-09-30' },
        { type: 'art', startDate: '2026-02-01', endDate: '2026-05-31' },
      ],
    })).body.project;

    const row = await onTab(project.id);
    assert.strictEqual(row.milestones.length, 2, 'both reach the Projects list');
    assert.deepStrictEqual(row.milestones.map((m) => m.label), ['Art', 'Animation'],
      'Art before Animation, from the order the list is in');
    assert.strictEqual(String(row.milestones[0].startDate).slice(0, 10), '2026-02-01');
    assert.strictEqual(String(row.milestones[0].endDate).slice(0, 10), '2026-05-31');
  });

  await t.test('a project with no milestones comes back as an empty list, not an error', async () => {
    // Testing step 4: what the column draws its dash from.
    const project = (await makeProject({ name: 'Unplanned' })).body.project;
    const row = await onTab(project.id);
    assert.ok(Array.isArray(row.milestones), 'the field is there');
    assert.strictEqual(row.milestones.length, 0, 'and it is empty');
  });

  await t.test('outside the project window saves, and says so', async () => {
    // Testing step 3. The whole point: status 201, and a warning with it.
    const res = await makeProject({
      name: 'Early Art', startDate: '2026-03-01', endDate: '2026-10-01',
      milestones: [{ type: 'art', startDate: '2026-01-15', endDate: '2026-02-15' }],
    });
    assert.strictEqual(res.status, 201, 'not refused');
    assert.strictEqual(res.body.warnings.length, 1, 'but not silent either');
    assert.match(res.body.warnings[0].message, /before the project's own start date of 2026-03-01/);

    const row = await onTab(res.body.project.id);
    assert.strictEqual(row.milestones.length, 1, 'and it really was stored');
  });

  await t.test('a milestone that ends before it begins is refused', async () => {
    const res = await makeProject({
      name: 'Backwards',
      milestones: [{ type: 'art', startDate: '2026-05-10', endDate: '2026-05-01' }],
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /cannot end before it begins/i);
    assert.strictEqual(res.body.field, 'milestones.0.startDate');
  });

  await t.test('half a milestone is refused rather than half-saved', async () => {
    const res = await makeProject({
      name: 'Half', milestones: [{ type: 'art', startDate: '2026-05-01' }],
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /needs an end date/i);
  });

  await t.test('an asset type is not a milestone type', async () => {
    /* The mirror of the category test: "animation" exists in BOTH lists, so
       this one is checked with a type that is only an asset type. Reading the
       wrong collection would accept it. */
    const res = await makeProject({
      name: 'Wrong List', milestones: [{ type: 'character', startDate: '2026-01-01', endDate: '2026-02-01' }],
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /not a milestone type/i);

    // And the reverse: a milestone type is not selectable as an asset type.
    const project = (await makeProject({ name: 'For Assets' })).body.project;
    const asset = await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Thing', type: 'rigging' } });
    assert.strictEqual(asset.status, 400, JSON.stringify(asset.body));
  });

  await t.test('editing replaces the whole set, and omitting the field leaves it alone', async () => {
    const project = (await makeProject({
      name: 'Editable',
      milestones: [
        { type: 'art', startDate: '2026-02-01', endDate: '2026-05-31' },
        { type: 'animation', startDate: '2026-06-01', endDate: '2026-09-30' },
      ],
    })).body.project;

    // A save that does not mention milestones must not wipe them — this is the
    // shape of the bug that would take a studio's plan out with a rename.
    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { name: 'Renamed' } });
    assert.strictEqual((await onTab(project.id)).milestones.length, 2, 'a rename leaves them alone');

    // One sent means one kept: the form submits the set it is showing.
    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: {
      milestones: [{ type: 'art', startDate: '2026-03-01', endDate: '2026-04-30' }],
    } });
    const row = await onTab(project.id);
    assert.strictEqual(row.milestones.length, 1, 'the one dropped from the form is gone');
    assert.strictEqual(row.milestones[0].type, 'art');
    assert.strictEqual(String(row.milestones[0].startDate).slice(0, 10), '2026-03-01', 'and the kept one was updated');

    // And an empty list is an instruction, not an omission.
    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { milestones: [] } });
    assert.strictEqual((await onTab(project.id)).milestones.length, 0);
  });

  await t.test('moving the project and its milestones together does not warn', async () => {
    /* The subtle one. The window checked against has to be the window the
       project will HAVE after this save — judged against the stored dates, an
       edit that moves both would warn about every milestone, against dates
       that are about to stop being true. */
    const project = (await makeProject({
      name: 'Slipped', startDate: '2026-01-01', endDate: '2026-06-30',
      milestones: [{ type: 'art', startDate: '2026-02-01', endDate: '2026-03-01' }],
    })).body.project;

    const moved = await as('root', `/projects/${project.id}`, { method: 'PATCH', body: {
      startDate: '2026-09-01', endDate: '2026-12-31',
      milestones: [{ type: 'art', startDate: '2026-10-01', endDate: '2026-11-01' }],
    } });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.deepStrictEqual(moved.body.warnings, [],
      'the new milestone sits inside the new window, so there is nothing to say');
  });

  await t.test('a role without project.milestones cannot set them, and cannot wipe them', async () => {
    // Testing step 5, and the failure mode that matters most.
    const project = (await makeProject({
      name: 'Guarded', milestones: [{ type: 'art', startDate: '2026-02-01', endDate: '2026-03-01' }],
    })).body.project;

    /* An ART DIRECTOR, chosen for two reasons rather than one.
       
       Reach: mayChange() lets somebody edit a project they did not create only
       when their designation sees the whole studio. A scoped role is refused
       before the milestone check is ever reached, which would make this test
       pass for the wrong reason — "Admin" is scoped to projects it owns, and
       that is what it did on the first attempt at this test.
       
       Permissions: this designation holds neither milestone permission by
       default — both travel with capabilities it does not have — so what is
       being checked is the shipped state rather than one this test arranged. */
    await grant('art_director', ['project.edit']);
    const held = (await as('root', '/permissions/roles/art_director')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!held.includes('project.milestones'), 'and it starts without the milestone permission');
    assert.ok(!held.includes('settings.milestone_types'), 'or the one for the list');

    const made = await as('root', '/users', { method: 'POST', body: {
      name: 'Cora', email: 'cora@zvky.test', role: 'art_director', password: PASSWORD,
    } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    token.cora = (await call('/auth/login', { method: 'POST',
      body: { email: 'cora@zvky.test', password: PASSWORD } })).body.token;

    const refused = await as('cora', `/projects/${project.id}`, { method: 'PATCH', body: {
      milestones: [{ type: 'animation', startDate: '2026-04-01', endDate: '2026-05-01' }],
    } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error, /permission/i);

    // The wipe-by-omission case: an ordinary edit from the same person must
    // leave the milestones exactly where they were.
    const renamed = await as('cora', `/projects/${project.id}`, { method: 'PATCH', body: { name: 'Guarded II' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual((await onTab(project.id)).milestones.length, 1,
      'the milestone survived an edit by somebody who may not set milestones');
  });

  await t.test('a role without settings.milestone_types cannot manage the list', async () => {
    const refused = await as('cora', '/reference/milestone-types', { method: 'POST', body: { label: 'Lighting' } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    // And the management read — the one that includes retired values — is shut
    // too, for the same reason the other lists shut it.
    const list = await as('cora', '/reference/milestone-types?includeInactive=1');
    assert.notStrictEqual(list.status, 200, 'the management view is not open to them');
  });

  await t.test('a retired type keeps reading as itself on the projects using it', async () => {
    const project = (await makeProject({
      name: 'Retired Type', milestones: [{ type: 'rigging', startDate: '2026-02-01', endDate: '2026-03-01' }],
    })).body.project;

    const off = await as('root', '/reference/milestone-types/rigging', {
      method: 'PATCH', body: { isActive: false } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    const row = await onTab(project.id);
    assert.strictEqual(row.milestones.length, 1, 'the milestone is still there');
    assert.strictEqual(row.milestones[0].label, 'Rigging', 'and still says what it is');
    assert.strictEqual(row.milestones[0].retired, true, 'marked, so the column can say so');
  });

  await t.test('deleting a project takes its milestones with it', async () => {
    const project = (await makeProject({
      name: 'Doomed', milestones: [{ type: 'art', startDate: '2026-02-01', endDate: '2026-03-01' }],
    })).body.project;
    await as('root', `/projects/${project.id}`, { method: 'DELETE' });
    await as('root', `/projects/${project.id}?purge=1`, { method: 'DELETE' });
    const left = await sql(cfg, 'SELECT COUNT(*) AS n FROM project_milestones WHERE project_id = ?', [project.id]);
    assert.strictEqual(Number(left[0].n), 0, 'nothing is left pointing at a project that is gone');
  });

  await t.test('nothing else about a project changed', async () => {
    // Testing step 7, asserted rather than eyeballed: the fields that were
    // there before this feature are still there, and still mean the same.
    const project = (await makeProject({
      name: 'Unchanged', startDate: '2026-01-01', endDate: '2026-06-30',
      milestones: [{ type: 'art', startDate: '2026-02-01', endDate: '2026-03-01' }],
    })).body.project;
    const row = await onTab(project.id);
    for (const field of ['id', 'name', 'code', 'category', 'startDate', 'endDate',
      'bidHours', 'spentSeconds', 'assetCount', 'status', 'isActive']) {
      assert.ok(field in row, `${field} is still on the Projects list row`);
    }
    assert.strictEqual(String(row.startDate).slice(0, 10), '2026-01-01', 'the project\'s own dates are untouched');
    assert.strictEqual(row.assetCount, 0);
  });
});
