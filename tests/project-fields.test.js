/* A project's category, its dates, and the two figures read off its assets.
 *
 * Three things are worth testing here, and they are not the form fields:
 *
 *   THE TWO LISTS STAY APART. Asset categories and project categories are
 *   separate tables with separate permissions, and the single failure that
 *   would undo that is one validator or one dropdown reading the other list.
 *   Nothing else in the app would notice, and by the time a studio did, both
 *   vocabularies would be in both places.
 *
 *   THE TOTALS ARE COMPUTED, NOT STORED. Which means the test that matters is
 *   not "does it add up" but "does it change when the assets change, with
 *   nobody having saved the project".
 *
 *   SPENT TIME MEANS WHAT IT MEANS EVERYWHERE ELSE. Every round, every person
 *   who has held an asset, held stretches excluded — the same figure the
 *   Efficiency report calls totalSeconds, asserted against it rather than
 *   against a number written down here.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const referenceData = require('../src/reference-data');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('projFields');
const wait = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

test('project categories are their own collection', () => {
  const c = referenceData.COLLECTIONS.project_categories;
  assert.ok(c, 'the collection exists');
  assert.strictEqual(c.table, 'project_categories', 'in a table of its own');
  /* The important half: retiring a project category asks about PROJECTS. If
     this pointed at assets, deleting a project category would be refused
     because some asset held a same-named value, which is the shape of the
     merge these two lists exist to avoid. */
  assert.strictEqual(c.usedBy.table, 'projects');
  assert.strictEqual(c.usedBy.column, 'category');
  assert.notStrictEqual(referenceData.COLLECTIONS.categories.table, c.table,
    'and it is not the asset list wearing another name');
});

test('managing the two category lists is two permissions', () => {
  for (const key of ['settings.categories', 'settings.project_categories']) {
    const perm = catalogue.BY_KEY.get(key);
    assert.ok(perm, `${key} is in the catalogue`);
    assert.strictEqual(perm.impliedBy({ manageSettings: true }), true, `${key} comes with Settings`);
    assert.strictEqual(perm.impliedBy({}), false, `${key} is not on for everyone`);
  }
  assert.ok(catalogue.KEYS.includes('settings.project_categories'));
});

test('project fields', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Proj-Fields-1!';
  let server;
  const token = {};
  const people = {};
  let clientId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const makeProject = (body) => as('root', '/projects', { method: 'POST', body: { clientId, ...body } });
  const addCategory = (label) => as('root', '/reference/project-categories', { method: 'POST', body: { label } });
  // The project as the Projects tab receives it.
  const onTab = async (id) => {
    const { clients } = (await as('root', '/clients?includeArchived=1')).body;
    for (const c of clients) {
      const found = [...c.projects, ...(c.archivedProjects || [])].find((p) => p.id === id);
      if (found) return found;
    }
    return null;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'proj-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'proj-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);
    const seed = (await makeProject({ name: 'Seed' })).body.project.id;
    people.ana = (await as('root', '/users', { method: 'POST', body: {
      name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD, projectId: seed,
    } })).body.user.id;
    token.ana = await login('ana@zvky.test');
  });

  t.after(() => stopServer(server));

  await t.test('a category is created, chosen and shown', async () => {
    const made = await addCategory('Slot Game');
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const key = made.body.entry.key;
    assert.strictEqual(key, 'slot_game', 'the key comes from the label');

    const project = (await makeProject({ name: 'Reels', category: key })).body.project;
    assert.strictEqual(project.category, key, 'stored as the key, not the label');

    const row = await onTab(project.id);
    assert.strictEqual(row.category, key, 'and carried to the Projects tab');
  });

  await t.test('the two category lists never see each other', async () => {
    /* The test this file exists for. An asset category must not be selectable
       on a project, and a project category must not be selectable on an asset —
       in both directions, because one validator reading the wrong list is all
       it would take. */
    const assetCat = (await as('root', '/reference/categories', {
      method: 'POST', body: { label: 'Character' } })).body.entry;
    const projectCat = (await as('root', '/reference/project-categories', {
      method: 'POST', body: { label: 'Co-Development' } })).body.entry;

    const wrongOnProject = await makeProject({ name: 'Mixed Up', category: assetCat.key });
    assert.strictEqual(wrongOnProject.status, 400, JSON.stringify(wrongOnProject.body));
    assert.strictEqual(wrongOnProject.body.field, 'category');
    assert.match(wrongOnProject.body.error, /not a project category/i);

    const project = (await makeProject({ name: 'For Assets' })).body.project;
    const asset = (await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Thing', type: 'prop', category: projectCat.key } }));
    assert.strictEqual(asset.status, 400, JSON.stringify(asset.body));
    assert.strictEqual(asset.body.field, 'category');

    // And each list only ever lists its own.
    const assetList = (await as('root', '/reference/categories')).body.entries.map((e) => e.key);
    const projectList = (await as('root', '/reference/project-categories')).body.entries.map((e) => e.key);
    assert.ok(assetList.includes(assetCat.key) && !assetList.includes(projectCat.key));
    assert.ok(projectList.includes(projectCat.key) && !projectList.includes(assetCat.key));
  });

  await t.test('dates are stored, edited and cleared', async () => {
    const project = (await makeProject({
      name: 'Scheduled', startDate: '2026-10-01', endDate: '2026-12-20',
    })).body.project;
    let row = await onTab(project.id);
    assert.strictEqual(String(row.startDate).slice(0, 10), '2026-10-01');
    assert.strictEqual(String(row.endDate).slice(0, 10), '2026-12-20');

    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { endDate: '2027-01-15' } });
    row = await onTab(project.id);
    assert.strictEqual(String(row.endDate).slice(0, 10), '2027-01-15');
    assert.strictEqual(String(row.startDate).slice(0, 10), '2026-10-01', 'the other date is untouched');

    // null clears; leaving a field out leaves it alone. The Edit form relies on
    // the difference, so it is pinned rather than assumed.
    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { startDate: null } });
    row = await onTab(project.id);
    assert.strictEqual(row.startDate, null);
    assert.strictEqual(String(row.endDate).slice(0, 10), '2027-01-15');

    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { name: 'Scheduled II' } });
    row = await onTab(project.id);
    assert.strictEqual(String(row.endDate).slice(0, 10), '2027-01-15',
      'an edit that does not mention the dates does not blank them');
  });

  await t.test('a project cannot end before it begins', async () => {
    const backwards = await makeProject({ name: 'Backwards', startDate: '2026-12-01', endDate: '2026-11-01' });
    assert.strictEqual(backwards.status, 400);
    assert.strictEqual(backwards.body.field, 'startDate');
    assert.match(backwards.body.error, /cannot end before it begins/i);
    assert.match(backwards.body.error, /2026-12-01/);
    assert.match(backwards.body.error, /2026-11-01/);

    // Equal is a one-day project, not an error.
    assert.strictEqual((await makeProject({
      name: 'One Day', startDate: '2026-11-01', endDate: '2026-11-01' })).status, 201);

    // And the same rule on edit, checked only when both are in the request.
    const project = (await makeProject({ name: 'Movable', startDate: '2026-03-01', endDate: '2026-04-01' })).body.project;
    const bad = await as('root', `/projects/${project.id}`, {
      method: 'PATCH', body: { startDate: '2026-05-01', endDate: '2026-04-15' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(String((await onTab(project.id)).startDate).slice(0, 10), '2026-03-01',
      'and nothing was written');
  });

  await t.test('the dates gate nothing', async () => {
    /* Stated as a test because "no rule" is indistinguishable from "a rule
       somebody forgot" when you are reading the code a year later. A project
       whose end date passed long ago still takes assets, still starts work, and
       still submits it. */
    const project = (await makeProject({
      name: 'Overdue', startDate: '2020-01-01', endDate: '2020-02-01' })).body.project;
    await as('root', `/projects/${project.id}/members`, { method: 'POST', body: { userId: people.ana } })
      .catch(() => null);

    const asset = (await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Late Work', type: 'prop', assigneeId: people.ana, manHours: 2 } }));
    assert.strictEqual(asset.status, 201, 'an asset can still be added');
    assert.strictEqual((await as('ana', `/assets/${asset.body.asset.id}/start`, { method: 'POST' })).status, 200,
      'and work can still be started on it');
    await as('ana', `/assets/${asset.body.asset.id}/submit`, { method: 'POST',
      body: { link: 'https://drive.zvky.test/late' } });
  });

  await t.test('Total Bid Hours adds up every asset, whatever state it is in', async () => {
    const project = (await makeProject({ name: 'Estimated' })).body.project;
    const add = (name, manHours) => as('root', `/assets/project/${project.id}`, {
      method: 'POST', body: { name, type: 'prop', manHours, assigneeId: people.ana } });

    assert.strictEqual((await onTab(project.id)).bidHours, 0, 'a project with no assets bids nothing');

    const a = (await add('One', 4)).body.asset;
    const b = (await add('Two', 6)).body.asset;
    await add('No Estimate', null);
    assert.strictEqual((await onTab(project.id)).bidHours, 10,
      'an asset with no estimate contributes nothing rather than breaking the sum');

    /* The condition worth pinning, and the reason this is asserted state by
       state rather than once: an asset that has been delivered was still
       estimated, so it stays in the bid. Filtering by status would make the
       number shrink as the project finished, which is the opposite of what a
       bid is for — and it is the kind of filter somebody adds later meaning
       well. Driven straight to each status so the assertion cannot pass by
       never reaching the state it is about.
       
       Every status the pipeline has, including the two that put an asset on the
       Archived tab, so no tab can be quietly excluded. */
    for (const status of ['in_progress', 'pending_tl_review', 'cd_changes_requested',
      'approved_for_client', 'awaiting_client_feedback', 'delivered']) {
      await sql(cfg, 'UPDATE assets SET `status` = ? WHERE id = ?', [status, a.id]);
      assert.strictEqual((await onTab(project.id)).bidHours, 10,
        `an asset in ${status} is still part of the bid`);
    }

    // And an asset with no assignee at all, which is where the Inactive tab
    // draws from.
    await sql(cfg, 'UPDATE assets SET `status` = ?, assignee_id = NULL WHERE id = ?', ['not_started', b.id]);
    assert.strictEqual((await onTab(project.id)).bidHours, 10, 'so is one nobody has picked up');

    // Archive the project itself; the figure follows it.
    await as('root', `/projects/${project.id}`, { method: 'DELETE' }).catch(() => null);
    const archived = await onTab(project.id);
    if (archived) assert.strictEqual(archived.bidHours, 10, 'and an archived project keeps its bid');
  });

  await t.test('Spent Time is the same number the Efficiency report uses', async () => {
    /* Asserted against the report rather than against a figure written here, so
       the two cannot drift: if one of them ever starts counting held time or
       stops counting a round, this fails. */
    const project = (await makeProject({ name: 'Worked On' })).body.project;
    const asset = (await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Round Trip', type: 'prop', assigneeId: people.ana, manHours: 4 } })).body.asset;

    assert.strictEqual((await onTab(project.id)).spentSeconds, 0, 'nothing worked, nothing spent');

    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await wait(2);
    // A hold in the middle, whose gap must be missing from both figures.
    await as('ana', `/assets/${asset.id}/hold`, { method: 'POST', body: { note: 'lunch' } });
    await wait(2);
    await as('ana', `/assets/${asset.id}/resume`, { method: 'POST' });
    await wait(1);
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://drive.zvky.test/r1' } });

    const spent = (await onTab(project.id)).spentSeconds;
    const worklog = (await as('root', `/assets/${asset.id}/worklog`)).body.work;
    assert.strictEqual(spent, worklog.totalSeconds, 'the project total is the asset totals added up');
    assert.ok(spent >= 2 && spent <= 5, `the held gap is excluded — got ${spent}s across ~5s elapsed`);

    /* A SECOND ROUND, driven through the real review flow rather than assumed.
       This is the assertion that stops the sum being scoped to round 1 — a
       plausible-looking narrowing that would silently drop every hour of rework
       a studio has ever done, and which an earlier version of this test failed
       to catch because the round it was about was never created. */
    const sentBack = await as('root', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'again please' } });
    assert.strictEqual(sentBack.status, 200, JSON.stringify(sentBack.body));

    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await wait(2);
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://drive.zvky.test/r2' } });

    const rounds = await sql(cfg,
      'SELECT DISTINCT round FROM work_sessions WHERE asset_id = ? ORDER BY round', [asset.id]);
    assert.deepStrictEqual(rounds.map((r) => Number(r.round)), [1, 2],
      'the rework really is a second round');

    const again = (await onTab(project.id)).spentSeconds;
    assert.ok(again > spent, `the second round is added, not replaced — ${spent}s became ${again}s`);
    const after = (await as('root', `/assets/${asset.id}/worklog`)).body.work;
    assert.strictEqual(again, after.totalSeconds, 'and it still agrees with the asset\'s own total');
  });

  await t.test('both figures follow the assets, with nobody saving the project', async () => {
    /* The point of computing rather than storing. Nothing here touches the
       project row at all — only the assets under it — and the Projects tab
       must show the change on its very next read. */
    const project = (await makeProject({ name: 'Live' })).body.project;
    const asset = (await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Moving', type: 'prop', assigneeId: people.ana, manHours: 3 } })).body.asset;
    assert.strictEqual((await onTab(project.id)).bidHours, 3);

    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { manHours: 9 } });
    assert.strictEqual((await onTab(project.id)).bidHours, 9, 'an edited estimate shows at once');

    await as('root', `/assets/project/${project.id}`, { method: 'POST',
      body: { name: 'Another', type: 'prop', manHours: 1 } });
    assert.strictEqual((await onTab(project.id)).bidHours, 10, 'and so does a new asset');

    const before = (await onTab(project.id)).spentSeconds;
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await wait(2);
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://drive.zvky.test/live' } });
    assert.ok((await onTab(project.id)).spentSeconds > before, 'a finished round shows at once too');

    // Nothing was written to the project itself. If either figure were stored,
    // this column would exist.
    const columns = await sql(cfg,
      "SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"
      + " AND TABLE_NAME = 'projects'");
    const names = columns.map((c) => c.n);
    for (const stored of ['bid_hours', 'spent_seconds', 'total_bid_hours', 'spent_time']) {
      assert.ok(!names.includes(stored), `${stored} must not be a stored column — these are computed`);
    }
  });

  await t.test('a category still in use cannot be deleted out from under a project', async () => {
    const cat = (await addCategory('Pitch Work')).body.entry;
    const project = (await makeProject({ name: 'Pitched', category: cat.key })).body.project;

    const usage = (await as('root', `/reference/project-categories/${cat.key}/usage`)).body;
    assert.strictEqual(usage.inUse, 1, 'usage counts projects, not assets');
    assert.strictEqual(usage.canDelete, false, 'so Settings can say so before offering the delete');

    /* And it really is counting projects. An ASSET category of the same name
       being in use must not make this one look busy, which is the crossover
       usedBy is pointed at projects to prevent. */
    await as('root', '/reference/categories', { method: 'POST', body: { label: 'Pitch Work' } });
    assert.strictEqual((await as('root', `/reference/project-categories/${cat.key}/usage`)).body.inUse, 1,
      'an asset list entry of the same name changes nothing here');

    // Clearing it frees the category.
    await as('root', `/projects/${project.id}`, { method: 'PATCH', body: { category: null } });
    assert.strictEqual((await onTab(project.id)).category, null);
    const freed = (await as('root', `/reference/project-categories/${cat.key}/usage`)).body;
    assert.strictEqual(freed.inUse, 0);
    assert.strictEqual(freed.canDelete, true, 'and it can now be deleted');
  });

  await t.test('managing the list needs the project-category permission', async () => {
    const refused = await as('ana', '/reference/project-categories', {
      method: 'POST', body: { label: 'Sneaky' } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    // But reading it is open, because every dropdown needs it.
    const read = await as('ana', '/reference/project-categories');
    assert.strictEqual(read.status, 200);
    assert.ok(Array.isArray(read.body.entries));

    /* Holding the ASSET category permission is not enough. Granting one list
       and not the other is the whole reason they are two keys. */
    const current = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...current, 'settings.categories'] } });
    const stillRefused = await as('ana', '/reference/project-categories', {
      method: 'POST', body: { label: 'Still Sneaky' } });
    assert.strictEqual(stillRefused.status, 403,
      'the asset category permission does not carry the project one');
    assert.strictEqual((await as('ana', '/reference/categories', {
      method: 'POST', body: { label: 'Allowed Now' } })).status, 201,
    'while the one it does grant works');
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: current } });
  });

  await t.test('the bundled reference payload carries both lists', async () => {
    // What the page loads at startup, and what the inline "+ Add Category"
    // re-reads. Both lists in one call, neither standing in for the other.
    const { body } = await as('root', '/reference');
    assert.ok(Array.isArray(body.categories), 'asset categories');
    assert.ok(Array.isArray(body.projectCategories), 'project categories');
    const assetKeys = body.categories.map((e) => e.key);
    const projectKeys = body.projectCategories.map((e) => e.key);
    assert.ok(projectKeys.includes('slot_game'));
    assert.ok(!assetKeys.includes('slot_game'), 'and the asset list does not hold it');
  });
});
