const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');
const { TIERS, capabilitiesForTier, ASSIGNABLE_TIERS } = require('../src/role-tiers');
const defaults = require('../src/reference-defaults');
const referenceData = require('../src/reference-data');

const cfg = config('reference');

// --- pure checks -------------------------------------------------------------

test('every seeded role sits in a tier that exists', () => {
  for (const role of defaults.ROLES) {
    assert.ok(TIERS[role.tier], `${role.key} has tier "${role.tier}", which is not defined`);
  }
});

test('moving roles into tiers changed nobody\'s permissions', () => {
  // The catalogue that preceded these tables defined capabilities per role.
  // Each role now takes them from its tier, and this asserts the two agree —
  // if a tier is edited so that a seeded role would gain or lose a permission,
  // this fails rather than the change going out silently.
  const EXPECTED = {
    super_admin: { manageUsers: true, manageSettings: true, projectScope: 'all', deleteAsset: 'any' },
    admin: { manageUsers: true, manageSettings: false, projectScope: 'owned', deleteAsset: 'owned' },
    coordinator: { projectScope: 'assigned', createAsset: true, deliver: true, manageUsers: false },
    art_director: { projectScope: 'all', reviewStage: 'cd', editAsset: false, deliver: true },
    team_lead: { projectScope: 'team', reviewStage: 'tl', leadsTeam: true, assignable: false },
    game_artist: { projectScope: 'own_work', assignable: true, editAsset: true, manageUsers: false },
    junior_accountant: { projectScope: 'own_work', assignable: false, editAsset: false, manageUsers: false },
    managing_director_ceo: { projectScope: 'all', assignable: false, editAsset: false, manageSettings: false },
  };
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const role = defaults.ROLES.find((r) => r.key === key);
    assert.ok(role, `${key} is missing from the seed`);
    const actual = capabilitiesForTier(role.tier);
    for (const [capability, value] of Object.entries(expected)) {
      assert.strictEqual(actual[capability], value,
        `${key} (tier ${role.tier}): ${capability} is ${JSON.stringify(actual[capability])}, expected ${JSON.stringify(value)}`);
    }
  }
});

test('manageSettings belongs to the Super Admin tier and nothing else', () => {
  const holders = Object.keys(TIERS).filter((t) => capabilitiesForTier(t).manageSettings);
  assert.deepStrictEqual(holders, ['super_admin']);
});

test('a role cannot be created in a system tier', () => {
  assert.ok(!ASSIGNABLE_TIERS.includes('super_admin'));
  assert.ok(!ASSIGNABLE_TIERS.includes('admin'));
  assert.ok(ASSIGNABLE_TIERS.length > 0);
});

test('keys are derived from labels safely', () => {
  assert.strictEqual(referenceData.toKey('Vehicles & Rigs'), 'vehicles_rigs');
  assert.strictEqual(referenceData.toKey('  Senior  Rigger  '), 'senior_rigger');
  assert.strictEqual(referenceData.toKey('UI/UX'), 'ui_ux');
  assert.match(referenceData.toKey('Motion Graphics'), /^[a-z][a-z0-9_]*$/);
});

test('code prefixes are derived from labels', () => {
  assert.strictEqual(referenceData.toCodePrefix('Vehicle'), 'VEH');
  assert.strictEqual(referenceData.toCodePrefix('FX'), 'FX');
  assert.strictEqual(referenceData.toCodePrefix('123'), 'AST');
});

test('the seeded values cover what the app shipped with', () => {
  assert.deepStrictEqual(
    defaults.ASSET_TYPES.map((t) => t.key).sort(),
    ['animation', 'background', 'character', 'environment', 'fx', 'prop']
  );
  assert.deepStrictEqual(defaults.PRIORITIES.map((p) => p.key).sort(), ['high', 'low', 'med']);
  assert.ok(defaults.ROLES.length >= 57);
  // Every asset code prefix has to be unique or two types would produce the
  // same code.
  const prefixes = defaults.ASSET_TYPES.map((t) => t.codePrefix);
  assert.strictEqual(new Set(prefixes).size, prefixes.length);
});

// --- against a live server ---------------------------------------------------

test('reference data', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Reference-Test-1!';
  let server;
  let superToken;
  let projectId;

  const call = (path, options) => api(server.base, path, options);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Ref Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    superToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    })).body.token;
    const project = await call('/projects', { method: 'POST', token: superToken, body: { name: 'Reference Target' } });
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  await t.test('the hardcoded values were migrated into the tables', async () => {
    const res = await call('/reference', { token: superToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.assetTypes.length, defaults.ASSET_TYPES.length);
    assert.strictEqual(res.body.priorities.length, defaults.PRIORITIES.length);
    assert.strictEqual(res.body.roles.length, defaults.ROLES.length);
    assert.ok(res.body.assetTypes.some((t2) => t2.key === 'character' && t2.codePrefix === 'CHR'));
  });

  await t.test('a Super Admin adds a type and it is usable at once', async () => {
    const created = await call('/reference/asset-types', {
      token: superToken, method: 'POST', body: { label: 'Vehicle', codePrefix: 'VEH', color: '#ff9f1c' },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.entry.key, 'vehicle');

    const asset = await call(`/assets/project/${projectId}`, {
      token: superToken, method: 'POST', body: { name: 'Delivery Van', type: 'vehicle' },
    });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    assert.ok(asset.body.asset.code.startsWith('VEH-'), asset.body.asset.code);
  });

  await t.test('a Super Admin adds a role and it is assignable at once', async () => {
    const created = await call('/reference/roles', {
      token: superToken, method: 'POST',
      body: { label: 'Senior Rigger', group: 'Engineering', tier: 'contributor' },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.entry.assignable, true);
    assert.strictEqual(created.body.entry.manageSettings, false);

    const catalogue = await call('/auth/roles', { token: superToken });
    assert.ok(catalogue.body.roles.some((r) => r.key === 'senior_rigger'));

    const user = await call('/users', {
      token: superToken, method: 'POST',
      body: { name: 'Rig Person', email: 'rig@zvky.test', role: 'senior_rigger', password: 'Rigger-Pass-1!' },
    });
    assert.strictEqual(user.status, 201, JSON.stringify(user.body));

    const login = await call('/auth/login', { method: 'POST', body: { email: 'rig@zvky.test', password: 'Rigger-Pass-1!' } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.user.capabilities.assignable, true);
    assert.strictEqual(login.body.user.capabilities.manageSettings, false);
  });

  await t.test('duplicate and empty names are refused', async () => {
    for (const body of [{ label: '  VEHICLE ' }, { label: '   ' }, { label: 'X', color: 'reddish' }]) {
      const res = await call('/reference/asset-types', { token: superToken, method: 'POST', body });
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} should have been refused`);
      assert.ok(res.body.error);
    }
    const prefix = await call('/reference/asset-types', {
      token: superToken, method: 'POST', body: { label: 'Vehicle Two', codePrefix: 'VEH' },
    });
    assert.strictEqual(prefix.status, 400);
  });

  await t.test('renaming does not disturb records already using the value', async () => {
    const renamed = await call('/reference/asset-types/vehicle', {
      token: superToken, method: 'PATCH', body: { label: 'Vehicles & Rigs' },
    });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual(renamed.body.entry.label, 'Vehicles & Rigs');
    assert.strictEqual(renamed.body.entry.key, 'vehicle', 'the stored key must not change');

    const assets = await call(`/assets/project/${projectId}`, { token: superToken });
    assert.ok(assets.body.assets.some((a) => a.type === 'vehicle'), 'the asset should still resolve');
  });

  await t.test('a value in use cannot be deleted', async () => {
    const usage = await call('/reference/asset-types/vehicle/usage', { token: superToken });
    assert.strictEqual(usage.body.inUse, 1);
    assert.strictEqual(usage.body.canDelete, false);

    const attempt = await call('/reference/asset-types/vehicle', { token: superToken, method: 'DELETE' });
    assert.strictEqual(attempt.status, 409);
    assert.strictEqual(attempt.body.inUse, 1);
    assert.strictEqual(attempt.body.alternative, 'deactivate');
  });

  await t.test('deactivating hides a value without breaking its records', async () => {
    const off = await call('/reference/asset-types/vehicle', {
      token: superToken, method: 'PATCH', body: { isActive: false },
    });
    assert.strictEqual(off.status, 200);

    const dropdown = await call('/reference/asset-types', { token: superToken });
    assert.ok(!dropdown.body.entries.some((e) => e.key === 'vehicle'), 'should be gone from the dropdown');

    const settings = await call('/reference/asset-types?includeInactive=1', { token: superToken });
    assert.ok(settings.body.entries.some((e) => e.key === 'vehicle' && !e.isActive), 'should still show in Settings');

    const assets = await call(`/assets/project/${projectId}`, { token: superToken });
    assert.ok(assets.body.assets.some((a) => a.type === 'vehicle'), 'the existing asset must still load');

    const blocked = await call(`/assets/project/${projectId}`, {
      token: superToken, method: 'POST', body: { name: 'Another Van', type: 'vehicle' },
    });
    assert.strictEqual(blocked.status, 400, 'no new asset should take a deactivated type');
  });

  await t.test('an unused value can be deleted outright', async () => {
    const created = await call('/reference/priorities', { token: superToken, method: 'POST', body: { label: 'Critical' } });
    assert.strictEqual(created.status, 201);
    const deleted = await call('/reference/priorities/critical', { token: superToken, method: 'DELETE' });
    assert.strictEqual(deleted.status, 200);
    const after = await call('/reference/priorities?includeInactive=1', { token: superToken });
    assert.ok(!after.body.entries.some((e) => e.key === 'critical'));
  });

  await t.test('built-in values are protected', async () => {
    const del = await call('/reference/roles/super_admin', { token: superToken, method: 'DELETE' });
    assert.strictEqual(del.status, 400);
    const retier = await call('/reference/roles/super_admin', { token: superToken, method: 'PATCH', body: { tier: 'staff' } });
    assert.strictEqual(retier.status, 400);
    const off = await call('/reference/roles/super_admin', { token: superToken, method: 'PATCH', body: { isActive: false } });
    assert.strictEqual(off.status, 400, 'the Super Admin role must not be deactivatable');
    const sneak = await call('/reference/roles', {
      token: superToken, method: 'POST', body: { label: 'Sneaky', group: 'Administration', tier: 'super_admin' },
    });
    assert.strictEqual(sneak.status, 400, 'no new role may be minted in a system tier');
  });

  await t.test('only a Super Admin may write', async () => {
    // One account per non-super tier, each created by the Super Admin.
    const subjects = [];
    for (const tier of ['admin', 'lead', 'production', 'contributor', 'staff', 'direction', 'leadership']) {
      const roleKey = tier === 'admin' ? 'admin' : `probe_${tier}`;
      if (tier !== 'admin') {
        await call('/reference/roles', {
          token: superToken, method: 'POST', body: { label: `Probe ${tier}`, group: 'Administration', tier },
        });
      }
      const email = `probe.${tier}@zvky.test`;
      const created = await call('/users', {
        token: superToken, method: 'POST',
        body: { name: `Probe ${tier}`, email, role: roleKey, password: 'Probe-Pass-1!' },
      });
      assert.strictEqual(created.status, 201, `${tier}: ${JSON.stringify(created.body)}`);
      const login = await call('/auth/login', { method: 'POST', body: { email, password: 'Probe-Pass-1!' } });
      subjects.push({ tier, token: login.body.token, caps: login.body.user.capabilities });
    }

    for (const subject of subjects) {
      assert.strictEqual(subject.caps.manageSettings, false, `${subject.tier} should not have manageSettings`);

      const read = await call('/reference', { token: subject.token });
      assert.strictEqual(read.status, 200, `${subject.tier} must still be able to read the lists`);

      for (const [method, path, body] of [
        ['POST', '/reference/asset-types', { label: `Sneaky ${subject.tier}` }],
        ['PATCH', '/reference/asset-types/prop', { label: 'Hijacked' }],
        ['DELETE', '/reference/asset-types/prop', undefined],
        ['POST', '/reference/roles', { label: 'Sneaky Role', group: 'X', tier: 'contributor' }],
      ]) {
        const res = await call(path, { token: subject.token, method, body });
        assert.strictEqual(res.status, 403, `${subject.tier} ${method} ${path} returned ${res.status}`);
      }

      const inactive = await call('/reference/asset-types?includeInactive=1', { token: subject.token });
      assert.strictEqual(inactive.status, 403, `${subject.tier} should not see deactivated values`);
    }

    // And nothing at all without a token.
    const anon = await call('/reference/asset-types', { method: 'POST', body: { label: 'Anon' } });
    assert.strictEqual(anon.status, 401);
  });

  await t.test('the bulk importer accepts a type added in Settings', async () => {
    await call('/reference/asset-types', {
      token: superToken, method: 'POST', body: { label: 'Storyboard', codePrefix: 'STB' },
    });
    const form = new FormData();
    form.append('file', new Blob(['name,type\nOpening Sequence,storyboard\n'], { type: 'text/csv' }), 'sb.csv');
    const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
      method: 'POST', headers: { Authorization: `Bearer ${superToken}` }, body: form,
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(body));
    assert.strictEqual(body.created, 1);
  });

  await t.test('the import template describes the current types, not the old ones', async () => {
    const format = await call('/assets/import-format', { token: superToken });
    assert.ok(format.body.assetTypes.includes('storyboard'), JSON.stringify(format.body.assetTypes));
  });
});
