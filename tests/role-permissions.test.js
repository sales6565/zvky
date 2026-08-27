const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { capabilitiesForTier } = require('../src/role-tiers');
const { roleDef } = require('../src/roles');
const defaults = require('../src/reference-defaults');

const cfg = config('roleperms');

// --- the catalogue and the seed ------------------------------------------------

test('no feature is gated on a role NAME anywhere', () => {
  // The report that keeps coming back: "this section is hidden for my role, it
  // must be checking for 'Team Lead' by name". It is not, and this fails if it
  // ever becomes true. Every gate asks the role's PERMISSIONS, so granting one
  // in Settings is the whole of what it takes to open a section.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = ['public/index.html', 'src/permissions.js', 'src/asset-workflow.js']
    .concat(fs.readdirSync(path.join(root, 'src', 'routes')).map((f) => `src/routes/${f}`));

  const offenders = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      // A role compared against a string literal. `tier === 'super_admin'` is a
      // tier, not a role name, and is allowed — it guards confirmation prompts,
      // never a feature.
      if (/\.role\s*(===?|!==?)\s*['"]/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `these gate on a role name instead of a permission:\n${offenders.join('\n')}`);

  // And the section this was reported about, specifically.
  const page = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(page, /const canTlReview = can\('review\.tl'\)/,
    'the TL review controls must be gated on the review.tl permission');
  assert.match(page, /const canCdReview = can\('review\.cd'\)/);
  assert.match(page, /function mayHandOverInReview\(a\)\{\s*\n\s*if\(!can\('asset\.assign'\)\) return false;/,
    'and so must the handover, so it cannot grow the same bug later');
});

test('the catalogue covers the groups that were asked for', () => {
  assert.deepStrictEqual(catalog.GROUPS.map((g) => g.label), [
    'User Management', 'Asset Management', 'Review Workflow',
    'Project Management', 'Client Management', 'Settings / Admin',
  ]);
  assert.strictEqual(new Set(catalog.KEYS).size, catalog.KEYS.length);
});

test('the Super Admin role starts with everything', () => {
  const sa = defaults.ROLES.find((r) => r.tier === 'super_admin')
    || { tier: 'super_admin' };
  const seeded = catalog.baselineFor(capabilitiesForTier(sa.tier));
  assert.strictEqual(seeded.size, catalog.KEYS.length, 'every permission enabled by default');
});

test('the review gates map onto the roles that already held them', () => {
  // The migration must not change anybody's access on the day it goes live, so
  // the seed comes from the same tiers the checks used to read.
  const lead = catalog.baselineFor(capabilitiesForTier('lead'));
  assert.ok(lead.has('review.tl'), 'a lead keeps the first review gate');
  assert.ok(!lead.has('review.cd'));

  const direction = catalog.baselineFor(capabilitiesForTier('direction'));
  assert.ok(direction.has('review.cd'), 'creative direction keeps the final gate');
  assert.ok(direction.has('review.approve_client'));
  assert.ok(!direction.has('review.tl'));

  const contributor = catalog.baselineFor(capabilitiesForTier('contributor'));
  assert.ok(!contributor.has('review.tl') && !contributor.has('review.cd'),
    'a contributor holds no review gate');

  const production = catalog.baselineFor(capabilitiesForTier('production'));
  assert.ok(production.has('review.deliver'));
});

test('nothing can be switched off for the Super Admin role', () => {
  // It used to be two keys — the pair that, switched off, removed the only way
  // to switch them back on. That left the role that grants everyone else's
  // access able to lose its own, and worse: a permission added to the catalogue
  // after super_admin was seeded got no row at all, so Super Admin silently
  // stopped holding it. Super Admin now means the whole catalogue, by
  // definition rather than by a row somebody has to maintain.
  assert.deepStrictEqual([...rolePermissions.SUPER_ADMIN_LOCKED].sort(), [...catalog.KEYS].sort());
  assert.deepStrictEqual(rolePermissions.lockedFor('super_admin').sort(), [...catalog.KEYS].sort());
  assert.deepStrictEqual(rolePermissions.lockedFor('producer'), [], 'and only for that role');
});

test('nothing per-user is left in the tree', () => {
  // The removal, asserted rather than assumed.
  assert.throws(() => require('../src/user-permissions'), /Cannot find module/);
});

test('the Settings screen asks permissions, not capabilities', () => {
  // The bug this guards against does not fail a request — it makes the app
  // quietly refuse to offer something the API would have allowed. So it is
  // caught by reading the screen rather than by calling anything.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // Comments explain why these reads were wrong, and naming one is not making
  // it. Scan the code, not the prose.
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Every capability that has a permission key. Reading one of these to decide
  // what to show is the bug: the tier does not move when a Super Admin switches
  // the permission on, so the API allows the action and the app never offers it.
  for (const cap of ['manageSettings', 'manageAccess', 'managePermissions', 'manageUsers',
    'createProject', 'createAsset', 'editAsset', 'deleteAsset', 'deliver',
    'leadsTeam', 'reviewStage']) {
    assert.ok(!code.includes(`caps().${cap}`),
      `The UI still reads the tier capability "${cap}" to decide what to show. ` +
      'Ask can("…") with the permission the API checks instead.');
  }

  // A gated button must not appear where the API would refuse it: the reach
  // rule belongs in the gate alongside the permission.
  assert.ok(html.includes('mayEditCurrentProject'),
    'the Edit Project button must weigh reach as well as the permission');

  // The two that legitimately stay on the tier, asserted so that staying there
  // is a decision rather than an oversight. Neither is a switch in Settings:
  // projectScope is how much of the studio somebody sees, and assignable is
  // whether the designation is one that does the work.
  for (const cap of ['projectScope', 'assignable']) {
    assert.ok(code.includes(`caps().${cap}`), `${cap} should still come from the tier`);
  }
  // And the studio-wide tier itself, which is the one exception to asset
  // ownership. Read through one helper so the exception has a single name
  // rather than being spelled out wherever it is needed.
  assert.match(code, /function fullAccess\(\)\{[^}]*caps\(\)/,
    'fullAccess() should be the one place the studio-wide tier is read');

  // And each gated thing names the key the API checks, so one does not reveal
  // another.
  for (const key of ['settings.asset_types', 'settings.priorities', 'settings.roles',
    'settings.ip_allowlist', 'settings.permissions', 'user.view_team', 'user.add',
    'user.edit', 'user.delete', 'user.bulk_upload', 'project.add', 'project.edit',
    'asset.add', 'asset.edit', 'asset.delete', 'asset.bulk_upload',
    'review.tl', 'review.cd', 'review.approve_client', 'review.deliver']) {
    assert.ok(html.includes(`'${key}'`), `no gate mentions ${key}`);
  }
});

test('every permission the catalogue lists is either checked or declared pending', () => {
  // The gap this closes: review.cd and review.approve_client were in the
  // catalogue, switchable in Settings, and read by nothing — the workflow asked
  // the tier instead. A key nobody checks is a switch that lies.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const sources = ['src', 'public'].flatMap(function walk(dir) {
    const full = path.join(root, dir);
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  }).filter((f) => /\.(js|html)$/.test(f) && !f.includes('permission-catalog'));
  const haystack = sources.map(read).join('\n');

  const unchecked = catalog.ALL
    .filter((p) => !p.pending)
    .filter((p) => !haystack.includes(`'${p.key}'`) && !haystack.includes(`"${p.key}"`));
  assert.deepStrictEqual(unchecked.map((p) => p.key), [],
    'these permissions can be switched on and off and nothing reads them');
});

// --- against a live server -----------------------------------------------------

test('configuring a role', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'RolePerms-Test-1!';
  let server;
  let projectId;
  let clientId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const roleState = async (key) => (await as('root', `/permissions/roles/${key}`)).body.role;
  const enabledFor = async (key) =>
    (await roleState(key)).permissions.filter((p) => p.enabled).map((p) => p.key).sort();

  async function setRole(key, keys, confirm = true) {
    return as('root', `/permissions/roles/${key}`, { method: 'PUT', body: { permissions: keys, confirm } });
  }
  async function addAsset(who) {
    return (await as(who, `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `A${Math.random()}`, type: 'prop' },
    })).status;
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'role-perm-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'role-perm-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, token.root);
    projectId = (await call('/projects', { token: token.root, method: 'POST', body: { clientId, name: 'Skyfall' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['quinn', 'producer'], ['lee', 'team_lead'],
      ['dana', 'art_director'], ['ana', 'game_artist'], ['pm', 'project_manager']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('the seed reproduces what the tiers already allowed', async () => {
    // Nothing changes on the day this goes live.
    for (const role of ['producer', 'team_lead', 'art_director', 'game_artist', 'super_admin']) {
      // defaultsFor, not baselineFor: the baseline is what a role's TIER gives
      // it, and the defaults add what its DEPARTMENT gives it on top — which is
      // how every role that runs the first review gate comes to hold review.tl
      // whether or not its tier happened to carry it.
      const expected = [...require('../src/role-permissions').defaultsFor(role)].sort();
      assert.deepStrictEqual(await enabledFor(role), expected, `${role} was seeded from its tier`);
    }
  });

  await t.test('turning a permission off removes it for everyone with that role', async () => {
    assert.strictEqual(await addAsset('pat'), 201);
    assert.strictEqual(await addAsset('quinn'), 201);
    assert.strictEqual(await addAsset('lee'), 201);

    const without = (await enabledFor('producer')).filter((k) => k !== 'asset.add');
    const saved = await setRole('producer', without);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.deepStrictEqual(saved.body.disabled, ['asset.add']);

    // Both Producers, no re-login.
    assert.strictEqual(await addAsset('pat'), 403);
    assert.strictEqual(await addAsset('quinn'), 403);
    // And nobody else.
    assert.strictEqual(await addAsset('lee'), 201, 'the Team Lead role is untouched');
  });

  await t.test('turning it back on restores it for all of them', async () => {
    const back = [...(await enabledFor('producer')), 'asset.add'];
    const saved = await setRole('producer', back);
    assert.deepStrictEqual(saved.body.enabled, ['asset.add']);
    assert.strictEqual(await addAsset('pat'), 201);
    assert.strictEqual(await addAsset('quinn'), 201);
  });

  await t.test('one role\'s settings never touch another\'s', async () => {
    const before = new Map();
    for (const role of ['team_lead', 'art_director', 'game_artist', 'super_admin']) {
      before.set(role, await enabledFor(role));
    }
    await setRole('producer', ['asset.edit']);
    for (const [role, was] of before) {
      assert.deepStrictEqual(await enabledFor(role), was, `${role} changed when producer was edited`);
    }
    // And the rows really are keyed by role.
    const rows = await sql(cfg,
      "SELECT DISTINCT role_key FROM role_permissions WHERE enabled = 1 AND permission_key = 'asset.add'");
    assert.ok(!rows.some((r) => r.role_key === 'producer'));
    assert.ok(rows.some((r) => r.role_key === 'team_lead'), 'other roles keep it');
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('the review workflow behaves exactly as before', async () => {
    const asset = (await call(`/assets/project/${projectId}`, {
      token: token.root, method: 'POST',
      body: { name: 'Flow', type: 'prop', assigneeId: people.ana },
    })).body.asset;
    // Ana reports to Lee so the TL gate is his.
    await as('root', `/users/${people.ana}`, { method: 'PATCH', body: { teamLeadId: people.lee } });

    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'http://nas/x' },
    })).status, 201);
    assert.strictEqual((await as('ana', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 403, 'an artist holds no gate');
    assert.strictEqual((await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 200, 'the TL gate still works');
    assert.strictEqual((await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 403, 'and does not reach the CD gate');
    assert.strictEqual((await as('root', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 200);
    assert.strictEqual((await as('root', `/assets/${asset.id}/deliver`, { method: 'POST' })).status, 200);
  });

  await t.test('taking a review gate away from a role closes it', async () => {
    // The gates are permissions now, so this is configurable rather than fixed.
    const without = (await enabledFor('team_lead')).filter((k) => k !== 'review.tl');
    await setRole('team_lead', without);

    const asset = (await call(`/assets/project/${projectId}`, {
      token: token.root, method: 'POST',
      body: { name: 'Gateless', type: 'prop', assigneeId: people.ana },
    })).body.asset;
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'http://nas/y' } });
    assert.strictEqual((await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 403, 'the lead no longer holds the gate');

    await as('root', '/permissions/roles/team_lead/reset', { method: 'POST', body: {} });
    assert.strictEqual((await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    })).status, 200, 'and gets it back on reset');
  });

  await t.test('changing the Super Admin role takes a confirmation', async () => {
    const res = await as('root', '/permissions/roles/super_admin', {
      method: 'PUT', body: { permissions: [] },
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.requiresConfirmation, true);
    assert.deepStrictEqual(res.body.lockedKeys.sort(), [...catalog.KEYS].sort(),
      'and everything is locked, so the confirmation is really only a warning');
  });

  await t.test('the Super Admin role keeps everything, whatever is sent', async () => {
    // Asking for nothing at all changes nothing at all.
    const res = await setRole('super_admin', []);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.refused.sort(), [...catalog.KEYS].sort());
    assert.deepStrictEqual(await enabledFor('super_admin'), [...catalog.KEYS].sort());

    // And the screen still answers, which is the whole point.
    assert.strictEqual((await as('root', '/permissions/roles')).status, 200);
    assert.strictEqual((await enabledFor('super_admin')).length, catalog.KEYS.length);
  });

  await t.test('a permission added after a role was seeded still reaches it', async () => {
    // The bug that took the Projects tab away from Super Admin, reproduced.
    // Roles were seeded once and never revisited, and a missing row reads as
    // "not allowed" — so every role quietly failed to hold every permission
    // introduced after it was seeded, the granting role included.
    const held = await enabledFor('producer');
    assert.ok(held.includes('client.view'), 'a Producer holds it to begin with');

    await sql(cfg, "DELETE FROM role_permissions WHERE permission_key LIKE 'client.%'");

    // Read through the API, which is what every request does.
    assert.deepStrictEqual(await enabledFor('producer'), held,
      'the gap is filled at its default rather than read as a refusal');
    const sa = (await as('root', '/auth/me')).body.user.permissions;
    assert.deepStrictEqual([...sa].sort(), [...catalog.KEYS].sort(),
      'and Super Admin holds the whole catalogue again');

    // And the rows are written back, not merely computed each time.
    const rows = await sql(cfg, "SELECT COUNT(*) AS n FROM role_permissions WHERE role_key = 'producer' AND permission_key LIKE 'client.%'");
    assert.strictEqual(Number(rows[0].n),
      catalog.KEYS.filter((k) => k.startsWith('client.')).length);
  });

  await t.test('managing permissions cannot be switched on for another role', async () => {
    // A role holding it could give itself every other permission.
    await setRole('producer', ['asset.add', 'settings.permissions']);
    assert.deepStrictEqual(await enabledFor('producer'), ['asset.add']);
    assert.strictEqual((await as('pat', '/permissions/roles')).status, 403);
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('only a role holding the permission reaches the screen', async () => {
    for (const who of ['pat', 'lee', 'ana']) {
      assert.strictEqual((await as(who, '/permissions/roles')).status, 403, `${who} reached it`);
      assert.strictEqual((await as(who, '/permissions/catalog')).status, 403);
    }
    assert.strictEqual((await as('root', '/permissions/catalog')).status, 200);
  });

  await t.test('nonsense keys are refused rather than stored', async () => {
    const res = await setRole('producer', ['asset.add', 'delete.everything']);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Not a permission/i);
  });

  await t.test('every change is on the record', async () => {
    await setRole('producer', (await enabledFor('producer')).filter((k) => k !== 'asset.edit'));
    const audit = await as('root', '/permissions/audit?role=producer');
    assert.strictEqual(audit.status, 200);
    const latest = audit.body.entries[0];
    assert.strictEqual(latest.role, 'producer');
    assert.strictEqual(latest.permission, 'asset.edit');
    assert.strictEqual(latest.action, 'disabled');
    assert.strictEqual(latest.actor, 'root@zvky.test');
    assert.ok(latest.at);
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  // --- what the browser is told --------------------------------------------
  //
  // The screens ask "may I show this?" against the permission list on the
  // signed-in user. Signing in used to answer with the role's capabilities and
  // nothing else, so a permission switched on for a role changed what the API
  // allowed and not one thing about what the app offered — Settings stayed
  // hidden until the person reloaded and picked the list up from /auth/me.

  await t.test('signing in returns the role\'s permissions, not only its tier', async () => {
    const res = await call('/auth/login', { method: 'POST', body: { email: 'pat@zvky.test', password: PASSWORD } });
    assert.strictEqual(res.status, 200);
    const user = res.body.user;
    assert.ok(Array.isArray(user.permissions), 'the login response carries a permission list');
    assert.deepStrictEqual(
      [...user.permissions].sort(),
      [...require('../src/role-permissions').defaultsFor('producer')].sort(),
      'and it is the same set every later request is judged by'
    );
    // The tier is still sent alongside it: projectScope and the review stage
    // are values no checkbox can carry, and the screens still need them.
    assert.ok(user.capabilities, 'the capabilities are still there');
  });

  await t.test('a settings permission reaches the next sign-in without a deploy', async () => {
    const before = await call('/auth/login', { method: 'POST', body: { email: 'pat@zvky.test', password: PASSWORD } });
    assert.ok(!before.body.user.permissions.includes('settings.asset_types'));
    assert.strictEqual(before.body.user.capabilities.manageSettings, false,
      'the tier says no, which is exactly why the tier cannot be what the screen asks');

    await setRole('producer', [...(await enabledFor('producer')), 'settings.asset_types']);

    const after = await call('/auth/login', { method: 'POST', body: { email: 'pat@zvky.test', password: PASSWORD } });
    assert.ok(after.body.user.permissions.includes('settings.asset_types'),
      'signing in now shows the permission the role was given');
    assert.strictEqual(after.body.user.capabilities.manageSettings, false,
      'and the tier has not moved — nothing else came with it');
  });

  await t.test('one list\'s permission does not open the others', async () => {
    // Producer holds settings.asset_types from the test above and nothing else
    // in Settings. Listing what has been retired is a management view, so it
    // belongs to whoever manages that list — not to whoever manages any list.
    assert.strictEqual((await as('pat', '/reference/asset-types?includeInactive=1')).status, 200);
    assert.strictEqual((await as('pat', '/reference/priorities?includeInactive=1')).status, 403);
    assert.strictEqual((await as('pat', '/reference/roles?includeInactive=1')).status, 403);
    // Writing, likewise.
    assert.strictEqual((await as('pat', '/reference/priorities', {
      method: 'POST', body: { label: 'Whenever' },
    })).status, 403);
    // And the two sections that are not value lists stay shut.
    assert.strictEqual((await as('pat', '/ip-allowlist')).status, 403);
    assert.strictEqual((await as('pat', '/permissions/roles')).status, 403);

    // The dropdown read is untouched: every Add Asset form needs it.
    assert.strictEqual((await as('pat', '/reference/priorities')).status, 200);
    assert.strictEqual((await as('ana', '/reference/asset-types')).status, 200);

    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('a role with no settings permission is offered no part of the screen', async () => {
    const res = await call('/auth/login', { method: 'POST', body: { email: 'ana@zvky.test', password: PASSWORD } });
    const held = res.body.user.permissions.filter((k) => k.startsWith('settings.'));
    assert.deepStrictEqual(held, [], 'a Game Artist holds none of them');
    for (const path of [
      '/reference/asset-types?includeInactive=1',
      '/reference/priorities?includeInactive=1',
      '/reference/roles?includeInactive=1',
      '/ip-allowlist',
      '/permissions/roles',
    ]) {
      assert.strictEqual((await as('ana', path)).status, 403, path);
    }
  });

  // --- the gates that were reading the tier ---------------------------------
  //
  // Three times now the same shape of bug: a screen asked the role's TIER about
  // something the API decides from the role's PERMISSIONS. The tier does not
  // move when a permission is switched on, so the API allowed the action and
  // the app never offered it. These pin the API half; the static check above
  // pins the screen half.

  await t.test('the team roster follows its permission, not the tier', async () => {
    // It used to be requireCapability('leadsTeam'), which no Super Admin could
    // switch on or off for anybody.
    assert.strictEqual((await as('lee', '/team')).status, 200, 'a lead sees their roster');
    assert.strictEqual((await as('ana', '/team')).status, 403);
    assert.strictEqual((await as('root', '/team')).status, 200, 'and so does the studio-wide role');

    await setRole('team_lead', (await enabledFor('team_lead')).filter((k) => k !== 'user.view_team'));
    assert.strictEqual((await as('lee', '/team')).status, 403, 'switched off, the roster closes');
    assert.strictEqual(roleDef('team_lead').leadsTeam, true,
      'and the tier is untouched — which is exactly why reading it was wrong');

    await setRole('producer', [...(await enabledFor('producer')), 'user.view_team']);
    assert.strictEqual((await as('pat', '/team')).status, 200, 'switched on, it opens');

    await as('root', '/permissions/roles/team_lead/reset', { method: 'POST', body: {} });
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('a grant reaches a session that is already signed in', async () => {
    // Why "I granted it and nothing happened" kept being reported. The page
    // read its permission list once, at sign-in, and never asked again — so an
    // open tab kept answering from before the grant, and the only cure nobody
    // knew about was signing out. The token is not the problem and never was:
    // it names the person, and the permissions are looked up per request.
    // review.cd, not review.tl: every Production role holds review.tl by
    // default now, so it is no longer a permission this role can be missing.
    const before = await enabledFor('project_manager');
    assert.ok(!before.includes('review.cd'), 'not held to begin with');

    // Somebody signs in now, before the grant.
    const session = (await call('/auth/login', {
      method: 'POST', body: { email: 'pm@zvky.test', password: PASSWORD },
    })).body;
    assert.ok(!(session.user.permissions || []).includes('review.cd'),
      'and their sign-in says so');

    await setRole('project_manager', [...before, 'review.cd']);
    try {
      assert.ok((await enabledFor('project_manager')).includes('review.cd'), 'the role has it now');

      // Same token, no second sign-in. This is what the page re-reads.
      const me = await call('/auth/me', { token: session.token });
      assert.strictEqual(me.status, 200);
      assert.ok((me.body.user.permissions || []).includes('review.cd'),
        'and the session it belongs to can see it without signing out again');
    } finally {
      await setRole('project_manager', before);
    }
  });

  await t.test('the Creative Director gate follows review.cd, not reviewStage', async () => {
    // The workflow read roleDef(user).reviewStage, so review.cd was a switch
    // that did nothing at all.
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Gate check', type: 'prop', assigneeId: people.ana },
    })).body.asset;
    const push = async (who, path, body) => (await as(who, `/assets/${asset.id}${path}`, { method: 'POST', body })).status;

    await push('ana', '/timer/start', {});
    assert.strictEqual(await push('ana', '/submit', { link: 'https://example.test/v1' }), 201);
    assert.strictEqual(await push('lee', '/review', { decision: 'approved' }), 200, 'through the TL gate');

    // The Art Director holds review.cd from their tier and can act.
    await setRole('art_director', (await enabledFor('art_director')).filter((k) => k !== 'review.cd'));
    const refused = await as('dana', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'no' },
    });
    assert.strictEqual(refused.status, 403, 'switching review.cd off closes the gate');
    assert.strictEqual(roleDef('art_director').reviewStage, 'cd', 'while the tier still says cd');

    await as('root', '/permissions/roles/art_director/reset', { method: 'POST', body: {} });
    assert.strictEqual(await push('dana', '/review', { decision: 'approved' }), 200, 'and back on, it opens');
  });

  await t.test('approving for the client is separable from reviewing', async () => {
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Sign-off check', type: 'prop', assigneeId: people.ana },
    })).body.asset;
    const push = async (who, path, body) => (await as(who, `/assets/${asset.id}${path}`, { method: 'POST', body })).status;
    await push('ana', '/timer/start', {});
    assert.strictEqual(await push('ana', '/submit', { link: 'https://example.test/v1' }), 201);
    assert.strictEqual(await push('lee', '/review', { decision: 'approved' }), 200);

    // review.cd on, review.approve_client off: they may send it back, not sign it off.
    await setRole('art_director', (await enabledFor('art_director')).filter((k) => k !== 'review.approve_client'));
    assert.strictEqual(await push('dana', '/review', { decision: 'approved' }), 403,
      'the half that cannot be taken back needs its own permission');
    assert.strictEqual(await push('dana', '/review', { decision: 'changes_requested', text: 'Softer light' }), 200,
      'the reversible half still works');

    await as('root', '/permissions/roles/art_director/reset', { method: 'POST', body: {} });
  });

  // --- the whole User Management group, end to end ---------------------------
  //
  // Granting the group used to leave every one of these inert. Not because a
  // permission check was missing — all nine were present and keyed correctly —
  // but because a tier-derived reach rule ran after them: unless the role's
  // projectScope was 'all', the list filtered to `manager_id = you` and every
  // edit was refused with "You can only change users you added". A role could
  // add people and then administer nobody but the people it had just added.

  await t.test('granting User Management makes all of it work', async () => {
    const group = catalog.GROUPS.find((g) => g.key === 'users').permissions.map((p) => p.key);
    await setRole('producer', [...new Set([...(await enabledFor('producer')), ...group])]);

    // 1. User View — the studio's people, not an empty list.
    const list = await as('pat', '/users?limit=50');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.total >= 4, `the roster came back with ${list.body.total} people`);
    assert.ok(list.body.users.some((x) => x.id === people.ana), 'including people they did not add');

    // 2. User Add.
    const made = await as('pat', '/users', {
      method: 'POST',
      body: { name: 'Newby', email: 'newby@zvky.test', role: 'game_artist', password: PASSWORD, projectId },
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const newby = made.body.user.id;

    // 3. User Edit — a name and an email, which is all user.edit means on its
    // own now that the other three fields each have their own key.
    const renamed = await as('pat', `/users/${newby}`, { method: 'PATCH', body: { name: 'Newby Renamed' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual(renamed.body.user.name, 'Newby Renamed');
    assert.strictEqual((await as('pat', `/users/${newby}`, {
      method: 'PATCH', body: { email: 'ana@zvky.test' },
    })).status, 409, 'and a duplicate email is refused, as on create');

    // 5. Change Role, validated against the roles that exist.
    assert.strictEqual((await as('pat', `/users/${newby}`, {
      method: 'PATCH', body: { role: 'team_lead' },
    })).status, 200);
    assert.strictEqual((await as('pat', `/users/${newby}`, {
      method: 'PATCH', body: { role: 'not_a_role' },
    })).status, 400, 'a role that does not exist is refused');
    assert.strictEqual((await as('pat', `/users/${newby}`, {
      method: 'PATCH', body: { role: 'super_admin' },
    })).status, 403, 'and one above their own reach is refused');

    // 6. Change Project.
    const other = (await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Second' } })).body.project.id;
    assert.strictEqual((await as('pat', `/users/${newby}`, {
      method: 'PATCH', body: { projectId: other },
    })).status, 200);

    // 7. Change Reporting To — and the validation still runs for this role.
    assert.strictEqual((await as('pat', `/users/${newby}`, { method: 'GET' })).status, 200);
    assert.strictEqual((await as('pat', `/users/${people.ana}/manager-options`)).status, 200);
    assert.strictEqual((await as('pat', `/users/${people.ana}`, {
      method: 'PATCH', body: { reportsToId: people.lee },
    })).status, 200);

    const self = await as('pat', `/users/${people.ana}`, { method: 'PATCH', body: { reportsToId: people.ana } });
    assert.strictEqual(self.status, 400, 'self-reporting is still refused');
    assert.match(self.body.error, /cannot report to themselves/i);

    const loop = await as('pat', `/users/${people.lee}`, { method: 'PATCH', body: { reportsToId: people.ana } });
    assert.strictEqual(loop.status, 400, 'and so is a loop');
    assert.match(loop.body.error, /reporting loop/i);

    // 4. User Delete.
    assert.strictEqual((await as('pat', `/users/${newby}`, { method: 'DELETE' })).status, 200);

    await as('root', `/projects/${other}`, { method: 'DELETE' });
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('a full-access account is protected from a role below it', async () => {
    // The one guard that replaces the old reach rule: user.edit is not a way to
    // rename, demote or remove the account that could undo the change.
    await setRole('producer', [...new Set([...(await enabledFor('producer')),
      'user.view', 'user.edit', 'user.change_role', 'user.delete'])]);
    const rootId = (await as('root', '/users?search=root@zvky.test')).body.users[0].id;

    for (const [method, body] of [['PATCH', { name: 'Hijacked' }], ['PATCH', { role: 'game_artist' }], ['DELETE', undefined]]) {
      const res = await as('pat', `/users/${rootId}`, { method, body });
      assert.strictEqual(res.status, 403, `${method} ${JSON.stringify(body)}`);
      assert.match(res.body.error, /full studio access|permission/i);
    }
    // Ordinary accounts are still theirs to administer.
    assert.strictEqual((await as('pat', `/users/${people.ana}`, {
      method: 'PATCH', body: { name: 'Ana' },
    })).status, 200);

    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('a role without User Management is refused at the API, not just in the UI', async () => {
    // Hiding a button is not a control. Every one of the seven, called directly.
    for (const [method, path, body] of [
      ['GET', '/users?limit=50'],
      ['GET', `/users/${people.lee}`],
      ['GET', `/users/${people.lee}/manager-options`],
      ['POST', '/users', { name: 'X', email: 'x@zvky.test', role: 'game_artist' }],
      ['PATCH', `/users/${people.lee}`, { name: 'X' }],
      ['PATCH', `/users/${people.lee}`, { role: 'game_artist' }],
      ['PATCH', `/users/${people.lee}`, { projectId: null }],
      ['PATCH', `/users/${people.lee}`, { reportsToId: null }],
      ['DELETE', `/users/${people.lee}`],
      ['GET', '/users/import-format'],
      ['POST', '/users/bulk'],
    ]) {
      const res = await as('ana', path, { method, body });
      assert.strictEqual(res.status, 403, `${method} ${path} ${JSON.stringify(body || {})}`);
    }
  });

  await t.test('each field of an edit needs its own permission', async () => {
    // user.edit alone changes a name, and nothing else — the form sends only
    // what the caller holds, and the API refuses the rest either way.
    await setRole('producer', [...new Set([...(await enabledFor('producer')), 'user.view', 'user.edit'])]);
    assert.strictEqual((await as('pat', `/users/${people.ana}`, {
      method: 'PATCH', body: { name: 'Ana Two' },
    })).status, 200);
    for (const body of [{ role: 'team_lead' }, { projectId: null }, { reportsToId: null }]) {
      const res = await as('pat', `/users/${people.ana}`, { method: 'PATCH', body });
      assert.strictEqual(res.status, 403, JSON.stringify(body));
      assert.match(res.body.error, /permission to change/i);
    }
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  // --- reading an admin-managed list, versus managing it ---------------------

  await t.test('the lists behind dropdowns are readable by anyone signed in', async () => {
    // The Add User form's Role dropdown, the Add Asset form's Type and Priority
    // dropdowns, and the project picker. Needing Manage Roles to populate a
    // dropdown would mean nobody could fill in a form without also being
    // trusted to edit the studio's role catalogue.
    for (const who of ['pat', 'lee', 'ana', 'dana', 'root']) {
      for (const path of ['/auth/roles', '/reference', '/reference/roles', '/reference/asset-types',
        '/reference/priorities', '/projects']) {
        assert.strictEqual((await as(who, path)).status, 200, `${who} could not read ${path}`);
      }
    }
    const ref = (await as('ana', '/reference')).body;
    assert.ok(ref.roles.length > 0 && ref.assetTypes.length > 0 && ref.priorities.length > 0,
      'and the lists actually have something in them');

    // Managing one is still separate, and still per collection.
    assert.strictEqual((await as('ana', '/reference/roles', {
      method: 'POST', body: { label: 'Nope' },
    })).status, 403);
    assert.strictEqual((await as('ana', '/reference/roles?includeInactive=1')).status, 403,
      'listing what has been retired is a management view, not a dropdown');
  });

  // --- editing a project -----------------------------------------------------

  await t.test('editing a project needs project.edit', async () => {
    const made = await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Tin Rain' } });
    const id = made.body.project.id;

    assert.strictEqual((await as('ana', `/projects/${id}`, {
      method: 'PATCH', body: { name: 'Nope' },
    })).status, 403, 'a Game Artist cannot');

    await setRole('producer', [...(await enabledFor('producer')), 'project.edit']);
    // A Producer holds the permission now, but the project is not theirs and
    // their scope does not reach the whole studio.
    assert.strictEqual((await as('pat', `/projects/${id}`, {
      method: 'PATCH', body: { name: 'Nope' },
    })).status, 403, 'the permission says whether, the scope says which');
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });

    await as('root', `/projects/${id}`, { method: 'DELETE' });
  });

  await t.test('a project you created is one you can see', async () => {
    // Granting project.add to a scoped role used to produce a project its
    // creator could not see: the scoped queries match coordinators, leads and
    // people with work in it, and creating one makes you none of those.
    await setRole('producer', [...(await enabledFor('producer')), 'project.add', 'project.edit']);
    const made = await as('pat', '/projects', { method: 'POST', body: { clientId, name: 'Pat\'s Own' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const id = made.body.project.id;

    const mine = (await as('pat', '/projects')).body.projects;
    assert.ok(mine.some((p) => p.id === id), 'the creator can see what they created');

    // And can therefore act on it, which is the point.
    const renamed = await as('pat', `/projects/${id}`, { method: 'PATCH', body: { name: 'Pat\'s Own II' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));

    // Without widening anything else: a project of Root's that pat is not
    // attached to stays invisible.
    const notMine = (await as('root', '/projects', {
      method: 'POST', body: { clientId, name: 'Root Only' },
    })).body.project.id;
    const seen = (await as('pat', '/projects')).body.projects;
    assert.ok(!seen.some((p) => p.id === notMine), 'and still cannot see a project they are not on');

    await as('root', `/projects/${notMine}`, { method: 'DELETE' });
    await as('root', `/projects/${id}`, { method: 'DELETE' });
    await as('root', '/permissions/roles/producer/reset', { method: 'POST', body: {} });
  });

  await t.test('editing a project rewrites only the project', async () => {
    const id = (await as('root', '/projects', {
      method: 'POST', body: { clientId, name: 'Tin Rain', teamLeadIds: [people.lee] },
    })).body.project.id;
    const asset = (await as('root', `/assets/project/${id}`, {
      method: 'POST', body: { name: 'Keeper', type: 'prop', assigneeId: people.ana },
    })).body.asset;

    const saved = await as('root', `/projects/${id}`, {
      method: 'PATCH', body: { name: 'Tin Rain Redux', teamLeadIds: [], coordinatorIds: [people.pat] },
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.project.name, 'Tin Rain Redux');
    assert.strictEqual(saved.body.project.code, 'TRR', 'the derived code follows the name');
    assert.deepStrictEqual(saved.body.project.teamLeadIds, [], 'the lead was unticked');
    assert.deepStrictEqual(saved.body.project.coordinatorIds, [people.pat]);

    // The asset is exactly where it was.
    const after = (await as('root', `/assets/project/${id}`)).body.assets.find((a) => a.id === asset.id);
    assert.ok(after, 'the asset is still in the project');
    assert.strictEqual(after.assignee_id, people.ana, 'and still assigned to the same person');
    assert.strictEqual(after.status, asset.status, 'and still at the same stage');

    // And the account itself is untouched by being unticked as a lead.
    assert.strictEqual((await as('root', `/users/${people.lee}`)).body.user.role, 'team_lead');

    await as('root', `/projects/${id}`, { method: 'DELETE' });
  });

  await t.test('an edit is validated the way a create is', async () => {
    const id = (await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Tin Rain' } })).body.project.id;
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(256) }]) {
      const res = await as('root', `/projects/${id}`, { method: 'PATCH', body });
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.strictEqual(res.body.field, 'name');
    }
    // Create refuses the same things, with the same message.
    const created = await as('root', '/projects', { method: 'POST', body: { clientId, name: '  ' } });
    assert.strictEqual(created.status, 400);
    assert.strictEqual(created.body.error, 'Project name is required');

    assert.strictEqual((await as('root', `/projects/${id}`, {
      method: 'PATCH', body: { teamLeadIds: 'nope' },
    })).status, 400, 'a membership list has to be a list');

    // Sending nothing changes nothing rather than blanking the record.
    const untouched = await as('root', `/projects/${id}`, { method: 'PATCH', body: {} });
    assert.strictEqual(untouched.status, 200);
    assert.strictEqual(untouched.body.project.name, 'Tin Rain');

    await as('root', `/projects/${id}`, { method: 'DELETE' });
  });

  await t.test('a role added in Settings arrives with its tier\'s permissions', async () => {
    const created = await as('root', '/reference/roles', {
      method: 'POST', body: { label: 'Senior Rigger', group: 'Engineering', tier: 'lead' },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    // Never seeded by the migration — seeded on first read instead.
    assert.deepStrictEqual(
      await enabledFor('senior_rigger'),
      [...catalog.baselineFor(capabilitiesForTier('lead'))].sort(),
      'a new role is not born with nothing'
    );
  });
});
