const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
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

test('every seeded role holds exactly the permissions its tier grants', () => {
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
    // Leadership was widened to full access; it is pinned here at its new
    // shape so a later edit cannot move it again unnoticed.
    managing_director_ceo: { projectScope: 'all', assignable: false, editAsset: true, manageSettings: true, manageAccess: false },
    cto: { projectScope: 'all', manageUsers: true, manageSettings: true, manageAccess: false },
    head_of_production: { projectScope: 'all', manageUsers: true, deleteAsset: 'any', manageAccess: false },
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

test('managing Settings belongs to the full-access tiers, and nothing below them', () => {
  // Widened deliberately: the studio's leadership and the full-access
  // designations administer Settings alongside the Super Admin. Everything
  // below them still cannot.
  const holders = Object.keys(TIERS).filter((t) => capabilitiesForTier(t).manageSettings);
  assert.deepStrictEqual(holders.sort(), ['full_access', 'leadership', 'super_admin']);
});

test('managing who may reach the app belongs to the Super Admin tier alone', () => {
  // The capability that was split out of manageSettings when those tiers were
  // widened. A wrong entry in the allowlist locks everyone out, so it did not
  // travel with the rest of Settings.
  const holders = Object.keys(TIERS).filter((t) => capabilitiesForTier(t).manageAccess);
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
    const clientId = await systemClientId(server.base, superToken);
    const project = await call('/projects', { method: 'POST', token: superToken, body: { clientId, name: 'Reference Target' } });
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

  await t.test('only the full-access tiers may write', async () => {
    // One account per non-super tier, each created by the Super Admin.
    const subjects = [];
    for (const tier of ['admin', 'lead', 'production', 'contributor', 'staff', 'direction']) {
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

// --- the lists must match the table, not a snapshot of it ---------------------
//
// These exist because of a real failure: Settings showed fewer asset types,
// priorities and roles than the database held. The lists were served from a
// per-process in-memory mirror refreshed only at startup and after a write made
// through that same process. Anything else that touched the tables — a SQL
// script, `npm run seed`, a migration, or a sibling worker on a host that runs
// more than one — was invisible until a restart.

test('a refresh collapses concurrent callers onto one query', async () => {
  // The Settings page asks for every list at once and each wants fresh data.
  // Without sharing the in-flight load that is one identical round trip per
  // list, and a burst of role-lookup misses would be a burst of queries.
  let queries = 0;
  const db = {
    async query() {
      queries++;
      await new Promise((r) => setTimeout(r, 10));
      return { rows: [] };
    },
  };
  const referenceData2 = require('../src/reference-data');
  // Read from the module rather than hardcoded, so adding a collection does
  // not fail a test that is about collapsing concurrent loads.
  const COLLECTIONS = referenceData2.COLLECTION_NAMES.length;
  await Promise.all([
    referenceData2.refresh(db), referenceData2.refresh(db),
    referenceData2.refresh(db), referenceData2.refresh(db),
  ]);
  assert.strictEqual(queries, COLLECTIONS, `four concurrent refreshes should be one load of ${COLLECTIONS} tables`);

  // A later refresh is a fresh load, not a cached one.
  await referenceData2.refresh(db);
  assert.strictEqual(queries, COLLECTIONS * 2);
});

test('the settings lists match the database', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Freshness-Test-1!';
  let server;
  let sibling;   // a second worker on the same database, as Passenger runs it
  let superToken;

  const call = (path, options) => api(server.base, path, options);
  const count = async (base, path) =>
    (await api(base, `/reference/${path}?includeInactive=1`, { token: superToken })).body.entries.length;
  const inTable = async (table) =>
    Number((await sql(cfg, `SELECT COUNT(*) AS n FROM ${table}`))[0].n);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'fresh-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'fresh-token', name: 'Fresh Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    superToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD },
    })).body.token;
    sibling = await startServer(cfg, {});
  });

  t.after(() => { stopServer(server); stopServer(sibling); });

  await t.test('a row added outside the app shows up without a restart', async () => {
    // Exactly what a SQL script or `npm run seed` against a running app does.
    await sql(cfg, `
      INSERT INTO roles (id,\`key\`,label,group_name,tier,color,position,is_active,is_system)
        VALUES (UUID(),'matte_painter','Matte Painter','Art','contributor','#4db8ff',0,1,0);
      INSERT INTO asset_types (id,\`key\`,label,code_prefix,color,position,is_active,is_system)
        VALUES (UUID(),'weapon','Weapon','WPN','#ff9f1c',0,1,0);
      INSERT INTO priorities (id,\`key\`,label,color,position,is_active,is_system)
        VALUES (UUID(),'blocker','Blocker','#ff3b30',0,1,0);
    `);

    for (const [table, path] of [['roles', 'roles'], ['asset_types', 'asset-types'], ['priorities', 'priorities']]) {
      assert.strictEqual(await count(server.base, path), await inTable(table),
        `${table}: the list must match the table`);
    }
    const roles = await call('/reference/roles?includeInactive=1', { token: superToken });
    assert.ok(roles.body.entries.some((e) => e.key === 'matte_painter'));
  });

  await t.test('two workers on one database do not disagree', async () => {
    // A write handled by one worker used to leave the other serving a shorter
    // list indefinitely, so the page changed depending on who answered.
    const created = await api(sibling.base, '/reference/roles', {
      token: superToken, method: 'POST', body: { label: 'Crowd Artist', group: 'Art', tier: 'contributor' },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));

    const here = await count(server.base, 'roles');
    const there = await count(sibling.base, 'roles');
    assert.strictEqual(here, there, 'both workers must serve the same list');
    assert.strictEqual(here, await inTable('roles'), 'and it must be what the table holds');
  });

  await t.test('a role added elsewhere does not lock its holder out', async () => {
    // The worst of it was not the missing row. A worker that had not heard of a
    // role refused every request from anyone holding it — signed in, then 403
    // on everything, according to which worker took the request.
    const user = await api(sibling.base, '/users', {
      token: superToken, method: 'POST',
      body: { name: 'Crowd Person', email: 'crowd@zvky.test', role: 'crowd_artist', password: PASSWORD },
    });
    assert.strictEqual(user.status, 201, JSON.stringify(user.body));

    for (const base of [server.base, sibling.base]) {
      const login = await api(base, '/auth/login', {
        method: 'POST', body: { email: 'crowd@zvky.test', password: PASSWORD },
      });
      assert.strictEqual(login.status, 200);
      assert.ok(login.body.user.capabilities, 'capabilities must never come back null');
      assert.strictEqual(login.body.user.capabilities.label, 'Crowd Artist');

      const request = await api(base, '/projects', { token: login.body.token });
      assert.strictEqual(request.status, 200, 'every worker must accept a role the table knows about');
    }
  });

  await t.test('deactivating hides a value from the forms but not from Settings', async () => {
    // The intended split, asserted so it cannot drift: Settings is a management
    // view and shows everything, including what has been retired, so it can be
    // reactivated. The dropdowns offer only what is live.
    await call('/reference/asset-types/weapon', {
      token: superToken, method: 'PATCH', body: { isActive: false },
    });

    const settings = await call('/reference/asset-types?includeInactive=1', { token: superToken });
    const dropdown = await call('/reference/asset-types', { token: superToken });

    assert.strictEqual(settings.body.entries.length, await inTable('asset_types'),
      'Settings shows every row in the table');
    assert.ok(settings.body.entries.some((e) => e.key === 'weapon' && !e.isActive),
      'including the deactivated one, flagged as inactive');
    assert.ok(!dropdown.body.entries.some((e) => e.key === 'weapon'),
      'the dropdown does not offer it');
    assert.strictEqual(dropdown.body.entries.length, settings.body.entries.length - 1);
  });

  await t.test('the full list is served, however long it is', async () => {
    // Guards against a LIMIT or a page size creeping in: the seeded catalogue
    // is already larger than any default page size would be.
    const roles = await call('/reference/roles?includeInactive=1', { token: superToken });
    assert.strictEqual(roles.body.entries.length, await inTable('roles'));
    assert.ok(roles.body.entries.length > 50, 'the catalogue should be large enough for this to mean something');
    assert.strictEqual(new Set(roles.body.entries.map((e) => e.key)).size, roles.body.entries.length,
      'and every entry distinct');
  });
});

test('categories are a managed list like the others, starting empty', async () => {
  /* Category was added as a reference collection rather than a free-text
     column so the values stay consistent and renaming one does not orphan the
     assets holding it. It ships with no values on purpose: the studio's own
     taxonomy is not something to guess at, and an asset with no category is a
     normal asset. */
  const referenceData2 = require('../src/reference-data');
  assert.ok(referenceData2.COLLECTION_NAMES.includes('categories'));
  assert.ok(!Object.keys(defaults).some((k) => /categor/i.test(k)),
    'reference-defaults should not seed a category list');

  const catalog = require('../src/permission-catalog');
  const keys = catalog.GROUPS.flatMap((g) => g.permissions).map((p) => p.key);
  assert.ok(keys.includes('settings.categories'), 'managing the list needs its own permission');
});
