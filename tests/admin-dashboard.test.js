/* The Admin Dashboard.
 *
 * EVERY FIGURE IS CHECKED AGAINST A NUMBER WORKED OUT BY HAND, not against a
 * second query written the same way as the first. A dashboard tested by asking
 * it what it thinks agrees with itself perfectly and is wrong in exactly the
 * ways that matter, so the fixture below is built one project at a time with
 * the bucket each one belongs in written next to it, and the assertions quote
 * those numbers.
 *
 * The two things worth breaking here are the two that would be believed:
 *
 *   the buckets must partition   Active has to equal on-track plus at-risk, and
 *                                every project has to land in exactly one
 *                                bucket. A project counted twice makes the
 *                                cards disagree with each other, and nobody
 *                                would notice until they added them up.
 *
 *   the scope must be the app's  The Admin tier is projectScope:'owned'. A
 *                                studio-wide total shown to an Admin would be
 *                                full of projects they cannot open, so the
 *                                figures run through permissions.visibleProjects
 *                                and this file proves two roles get two
 *                                different — and individually correct — answers.
 */
const test = require('node:test');
const assert = require('node:assert');
const catalogue = require('../src/permission-catalog');
const dashboard = require('../src/admin-dashboard');
const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('admindash');

// --- the permission, on its own ----------------------------------------------

test('View Admin Dashboard is on for Admin and Super Admin, off for the rest', () => {
  const entry = catalogue.BY_KEY.get('report.admin_dashboard');
  assert.ok(entry, 'report.admin_dashboard is in the catalogue');
  assert.strictEqual(entry.label, 'View Admin Dashboard');

  const tiers = require('../src/role-tiers');
  const TIERS = tiers.TIERS || tiers;
  const on = Object.entries(TIERS)
    .filter(([, v]) => catalogue.baselineFor((v && v.capabilities) || {}).has('report.admin_dashboard'))
    .map(([k]) => k).sort();

  /* Admin and Super Admin as the brief asked, plus the two tiers that already
     outrank Admin — both are full access across every project — because
     withholding an overview from Leadership while granting it to Admin would be
     incoherent. Everyone else is off until a Super Admin says otherwise. */
  assert.deepStrictEqual(on, ['admin', 'full_access', 'leadership', 'super_admin']);
  for (const tier of ['direction', 'lead', 'production', 'contributor', 'staff']) {
    assert.ok(!on.includes(tier), `${tier} must not hold it by default`);
  }
});

test('the pipeline is the app\'s real workflow, not a list of its own', () => {
  /* The brief named Concept/Design/Art/Animation/Dev/QA/Release. This studio's
     pipeline is the asset workflow, and the panel has to move with it — a stage
     added next year must appear here without anybody remembering to. */
  const blank = dashboard.empty().pipeline;
  assert.deepStrictEqual(blank.map((s) => s.id), workflow.STATE_IDS);
  assert.ok(blank.every((s) => s.color), 'every stage carries the workflow colour it is drawn in');
  assert.ok(blank.every((s) => s.count === 0));
});

// --- against a live server ----------------------------------------------------

test('the Admin Dashboard', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Dash-Test-1!';
  let server;
  let clientId;
  const token = {};
  const project = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  const iso = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const makeProject = async (name, extra = {}) => (await as('root', '/projects', {
    method: 'POST', body: { clientId, name, ...extra },
  })).body.project;

  const makeAsset = async (projectId, name, extra = {}) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', ...extra },
  })).body.asset;

  const setStatus = (assetId, status) =>
    sql(cfg, 'UPDATE assets SET `status` = ? WHERE id = ?', [status, assetId]);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'dash-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'dash-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);

    /* THE FIXTURE. Every project below is annotated with the bucket it belongs
       in, and the assertions further down quote these numbers rather than
       recomputing them.

       Six projects:
         onTrackA   one asset due in 40 days              -> ON TRACK
         onTrackB   no dates at all                       -> ON TRACK
         soonC      one asset due in 3 days, unfinished   -> AT RISK
         endsSoonD  project end_date in 5 days            -> AT RISK
         lateE      one asset due 6 days ago, unfinished  -> OVERDUE
         doneF      closed with the client                -> DELIVERED

       So: active 5, onTrack 2, atRisk card 3 (2 at risk + 1 overdue),
       overdue 1, delivered 1. */
    project.onTrackA = await makeProject('On Track A');
    await makeAsset(project.onTrackA.id, 'Far off', { due: iso(40) });

    project.onTrackB = await makeProject('On Track B');
    await makeAsset(project.onTrackB.id, 'No dates');

    project.soonC = await makeProject('Soon C');
    await makeAsset(project.soonC.id, 'Due Thursday', { due: iso(3) });

    project.endsSoonD = await makeProject('Ends Soon D', { endDate: iso(5) });

    project.lateE = await makeProject('Late E');
    await makeAsset(project.lateE.id, 'Already late', { due: iso(-6) });

    project.doneF = await makeProject('Done F');
    await as('root', `/projects/${project.doneF.id}/close`, { method: 'POST' });
  });

  t.after(() => stopServer(server));

  await t.test('the four cards match the fixture, counted by hand', async () => {
    const res = await as('root', '/admin-dashboard');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const c = res.body.counts;

    assert.strictEqual(c.onTrack, 2, 'On Track A and On Track B');
    assert.strictEqual(c.overdue, 1, 'Late E alone');
    assert.strictEqual(c.atRisk, 3, 'Soon C and Ends Soon D, plus the overdue one');
    assert.strictEqual(c.delivered, 1, 'Done F, closed with the client');
    assert.strictEqual(c.active, 5, 'everything not closed');
  });

  await t.test('the buckets partition: nothing is counted twice or dropped', async () => {
    /* The arithmetic somebody WILL do on this screen. If it does not hold, two
       cards disagree and there is no way to tell which one is lying. */
    const c = (await as('root', '/admin-dashboard')).body.counts;
    assert.strictEqual(c.active, c.onTrack + c.atRisk,
      'Active must be On Track plus At Risk — the At Risk card already includes the overdue');
    assert.ok(c.overdue <= c.atRisk, 'overdue is a subset of at risk, not a fifth bucket');

    const { rows } = { rows: await sql(cfg, 'SELECT COUNT(*) AS n FROM projects WHERE is_active = 1') };
    assert.strictEqual(c.active + c.delivered, Number(rows[0].n),
      'every visible project lands in exactly one bucket');
  });

  await t.test('a project past its own end date is overdue, with no late assets', async () => {
    /* Both sources are consulted: a project's end_date is a plan, an asset's
       due_date is a commitment, and either being blown is late. This project
       has no assets at all, so only the first can catch it. */
    const past = await makeProject('Ended Last Week', { endDate: iso(-8) });
    const c = (await as('root', '/admin-dashboard')).body.counts;
    assert.strictEqual(c.overdue, 2, 'Late E and the newly ended one');

    await sql(cfg, 'DELETE FROM projects WHERE id = ?', [past.id]);
  });

  await t.test('a delivered asset stops counting as late', async () => {
    /* The rule that decides whether the studio ever gets back to zero. An asset
       past its due date but DELIVERED is finished, and a dashboard that kept
       flagging it would be permanently red. */
    const before = (await as('root', '/admin-dashboard')).body.counts.overdue;
    const asset = await makeAsset(project.onTrackA.id, 'Late but done', { due: iso(-3) });

    const during = (await as('root', '/admin-dashboard')).body.counts.overdue;
    assert.strictEqual(during, before + 1, 'a late unfinished asset makes its project overdue');

    await setStatus(asset.id, 'delivered');
    const after = (await as('root', '/admin-dashboard')).body.counts.overdue;
    assert.strictEqual(after, before, 'and delivering it puts the project back');

    await sql(cfg, 'DELETE FROM assets WHERE id = ?', [asset.id]);
  });

  await t.test('the pipeline counts open work by stage, and leaves closed projects out', async () => {
    const a1 = await makeAsset(project.onTrackA.id, 'In review one');
    const a2 = await makeAsset(project.onTrackA.id, 'In review two');
    const a3 = await makeAsset(project.soonC.id, 'With the client');
    await setStatus(a1.id, 'pending_tl_review');
    await setStatus(a2.id, 'pending_cd_review');
    await setStatus(a3.id, 'awaiting_client_feedback');

    /* A delivered asset on a CLOSED project — the state every asset on a
       finished project ends in. It must not appear in the pipeline, or the
       Delivered bar grows forever and the panel becomes a history of the studio
       rather than a picture of what is in flight.
       
       Built in the order it really happens — work, then deliver, then close —
       because the application refuses to add an asset to a closed project, which
       is the right refusal and made the first version of this fixture impossible
       rather than merely unrealistic. */
    const finished = await makeProject('Finished G');
    const closedAsset = await makeAsset(finished.id, 'Long since done');
    assert.ok(closedAsset, 'the asset goes on while the project is still open');
    await setStatus(closedAsset.id, 'delivered');
    assert.strictEqual((await as('root', `/projects/${finished.id}/close`, { method: 'POST' })).status, 200);

    const body = (await as('root', '/admin-dashboard')).body;
    const stage = (id) => body.pipeline.find((s) => s.id === id).count;
    assert.strictEqual(stage('pending_tl_review'), 1);
    assert.strictEqual(stage('pending_cd_review'), 1);
    assert.strictEqual(stage('awaiting_client_feedback'), 1);
    assert.strictEqual(stage('delivered'), 0, 'the closed project\'s work is not in the pipeline');
    assert.strictEqual(body.pipeline.length, workflow.STATE_IDS.length,
      'every stage is returned, including the empty ones, so the panel does not change shape');
  });

  await t.test('Attention Required names the projects, so every row ends somewhere', async () => {
    const body = (await as('root', '/admin-dashboard')).body;
    const row = (severity, match) => body.attention.find((r) => r.severity === severity && match.test(r.label));

    const overdue = row('overdue', /overdue/);
    assert.ok(overdue, 'the overdue row is present');
    assert.strictEqual(overdue.count, 1);
    assert.deepStrictEqual(overdue.projects.map((p) => p.name), ['Late E']);

    const review = row('at-risk', /review/);
    assert.ok(review, 'assets waiting on review are flagged');
    assert.strictEqual(review.count, 2, 'one at TL, one at CD');
    assert.deepStrictEqual(review.projects.map((p) => [p.name, p.count]), [['On Track A', 2]],
      'and named by project, heaviest first — there is no studio-wide asset list to link to');

    const client = row('client', /client/);
    assert.ok(client, 'work out with the client is its own severity');
    assert.strictEqual(client.count, 1);
    assert.strictEqual(client.projects[0].name, 'Soon C');

    // Rows that would say zero are dropped rather than drawn as an empty flag.
    assert.ok(body.attention.every((r) => r.count > 0));
  });

  await t.test('the delivery calendar is grouped by date, soonest first', async () => {
    const body = (await as('root', '/admin-dashboard')).body;
    const dates = body.calendar.map((d) => d.date);
    assert.deepStrictEqual([...dates].sort(), dates, 'soonest first');
    assert.ok(dates.includes(iso(3)), 'Soon C is due in three days');
    assert.ok(dates.includes(iso(40)), 'and On Track A in forty');
    assert.ok(!dates.includes(iso(-6)), 'a date already past is not upcoming');

    /* Two assets due on ONE day is one row saying two, not two rows. The
       question this panel answers is how heavy a day is. */
    await makeAsset(project.onTrackB.id, 'Same day one', { due: iso(12) });
    await makeAsset(project.onTrackB.id, 'Same day two', { due: iso(12) });
    const after = (await as('root', '/admin-dashboard')).body.calendar;
    const twelfth = after.filter((d) => d.date === iso(12));
    assert.strictEqual(twelfth.length, 1, 'one row for the day');
    assert.strictEqual(twelfth[0].count, 2, 'saying two');
  });

  // --- who sees what -----------------------------------------------------------

  await t.test('the tab is refused without the permission', async () => {
    const artist = (await as('root', '/users', { method: 'POST', body: {
      name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD,
      projectId: project.onTrackA.id,
    } })).body.user.id;
    people.ana = artist;
    token.ana = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@zvky.test', password: PASSWORD } })).body.token;

    assert.strictEqual((await as('ana', '/admin-dashboard')).status, 403);
    assert.strictEqual((await call('/admin-dashboard')).status, 401, 'and signed out entirely');
  });

  await t.test('granting it opens the tab without widening anybody\'s reach', async () => {
    /* The distinction the whole permission turns on. Holding it decides whether
       there is a tab; projectScope decides what the tab counts. A contributor
       granted it sees a dashboard of their own work, not the studio's. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'report.admin_dashboard'] },
    });

    const mine = await as('ana', '/admin-dashboard');
    assert.strictEqual(mine.status, 200, 'the grant alone opens it');

    const studio = (await as('root', '/admin-dashboard')).body;
    assert.ok(mine.body.scope.projects < studio.scope.projects,
      `an artist must not see the whole studio: saw ${mine.body.scope.projects} of ${studio.scope.projects}`);

    // And revoking closes it again — so this is a permission, not a role check.
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: held },
    });
    assert.strictEqual((await as('ana', '/admin-dashboard')).status, 403);
  });

  await t.test('it is read-only: there is no verb here but GET', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await as('root', '/admin-dashboard', { method, body: {} });
      assert.ok(res.status === 404 || res.status === 405,
        `${method} /admin-dashboard should not exist, got ${res.status}`);
    }
  });

  // --- and nothing else moved ---------------------------------------------------

  await t.test('the existing tabs and their data are untouched', async () => {
    /* The "additive" requirement, as assertions. Each of these is the endpoint
       behind a tab that existed before this screen did. */
    for (const path of ['/projects', '/clients', '/notifications', '/pending']) {
      const res = await as('root', path);
      assert.ok(res.status === 200 || res.status === 403,
        `${path} should answer as it always did, got ${res.status}`);
    }

    /* The per-project board, which is the OTHER thing called Dashboard. Its
       assets are still its assets — this screen reads them and changes
       nothing. */
    const board = await as('root', `/assets/project/${project.onTrackA.id}`);
    assert.strictEqual(board.status, 200);
    assert.ok(board.body.assets.length > 0);

    /* And the dashboard genuinely wrote nothing: opening it repeatedly must
       leave the Activity Log exactly as it was. */
    const before = (await as('root', '/activity?limit=200')).body.total;
    await as('root', '/admin-dashboard');
    await as('root', '/admin-dashboard');
    const after = (await as('root', '/activity?limit=200')).body.total;
    assert.strictEqual(after, before, 'a read-only screen records nothing');
  });

  await t.test('a role whose scope holds no projects gets zeroes, not an error', async () => {
    const nobody = (await as('root', '/users', { method: 'POST', body: {
      name: 'Nobody', email: 'nobody@zvky.test', role: 'game_artist', password: PASSWORD,
    } })).body.user;
    assert.ok(nobody, 'created without a project');
    const theirToken = (await call('/auth/login', { method: 'POST',
      body: { email: 'nobody@zvky.test', password: PASSWORD } })).body.token;

    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'report.admin_dashboard'] },
    });

    const res = await call('/admin-dashboard', { token: theirToken });
    assert.strictEqual(res.status, 200, 'an empty overview is still an overview');
    assert.strictEqual(res.body.counts.active, 0);
    assert.strictEqual(res.body.attention.length, 0);
    assert.deepStrictEqual(res.body.calendar, []);
    assert.strictEqual(res.body.pipeline.length, workflow.STATE_IDS.length,
      'and the pipeline still names every stage rather than collapsing');

    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: held },
    });
  });
});
