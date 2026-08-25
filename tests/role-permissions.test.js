const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { capabilitiesForTier } = require('../src/role-tiers');
const defaults = require('../src/reference-defaults');

const cfg = config('roleperms');

// --- the catalogue and the seed ------------------------------------------------

test('the catalogue covers the groups that were asked for', () => {
  assert.deepStrictEqual(catalog.GROUPS.map((g) => g.label), [
    'User Management', 'Asset Management', 'Review Workflow',
    'Project Management', 'Settings / Admin',
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

test('two permissions cannot be switched off for the Super Admin role', () => {
  // They are the only way back if this screen is misconfigured.
  assert.deepStrictEqual(rolePermissions.SUPER_ADMIN_LOCKED.sort(),
    ['settings.permissions', 'settings.roles']);
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

  for (const cap of ['manageSettings', 'manageAccess', 'managePermissions']) {
    assert.ok(!html.includes(`caps().${cap}`),
      `Settings visibility still reads the tier capability "${cap}". ` +
      'A permission switched on for a role does not move the tier, so the ' +
      'section stays hidden. Ask holds("settings.…") instead.');
  }

  // And each section is gated on its own key, so one does not reveal another.
  for (const key of ['settings.asset_types', 'settings.priorities', 'settings.roles',
    'settings.ip_allowlist', 'settings.permissions']) {
    assert.ok(html.includes(`'${key}'`), `no gate mentions ${key}`);
  }
});

// --- against a live server -----------------------------------------------------

test('configuring a role', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'RolePerms-Test-1!';
  let server;
  let projectId;
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
    projectId = (await call('/projects', { token: token.root, method: 'POST', body: { name: 'Skyfall' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['quinn', 'producer'], ['lee', 'team_lead'], ['ana', 'game_artist']]) {
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
      const expected = [...catalog.baselineFor(capabilitiesForTier(
        require('../src/roles').roleDef(role).tier
      ))].sort();
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
    assert.deepStrictEqual(res.body.lockedKeys.sort(), ['settings.permissions', 'settings.roles']);
  });

  await t.test('the Super Admin role cannot lose its way back', async () => {
    // Even asking for nothing at all leaves the two that fix a mistake here.
    const res = await setRole('super_admin', []);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.refused.sort(), ['settings.permissions', 'settings.roles']);
    assert.deepStrictEqual(await enabledFor('super_admin'), ['settings.permissions', 'settings.roles']);

    // And the screen still answers, which is the whole point of the lock.
    assert.strictEqual((await as('root', '/permissions/roles')).status, 200);
    await as('root', '/permissions/roles/super_admin/reset', { method: 'POST', body: { confirm: true } });
    assert.strictEqual((await enabledFor('super_admin')).length, catalog.KEYS.length);
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
      [...catalog.baselineFor(capabilitiesForTier('production'))].sort(),
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
