const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const { TIERS, capabilitiesForTier, ASSIGNABLE_TIERS, FULL_ACCESS } = require('../src/role-tiers');
const defaults = require('../src/reference-defaults');

const cfg = config('fullaccess');

// The six designations that run the studio.
const FULL = [
  'head_of_production',
  'managing_director_ceo',
  'vice_president_global_operations_business_development',
  'cto',
  'general_manager',
  'account_manager_marketing',
];

// --- the catalogue ------------------------------------------------------------

test('all six roles exist in the catalogue', () => {
  for (const key of FULL) {
    const role = defaults.ROLES.find((r) => r.key === key);
    assert.ok(role, `${key} is missing from the role catalogue`);
  }
});

test('all six sit at a tier that grants full access', () => {
  for (const key of FULL) {
    const role = defaults.ROLES.find((r) => r.key === key);
    const caps = capabilitiesForTier(role.tier);
    assert.strictEqual(caps.projectScope, 'all', `${key} should see every project`);
    assert.strictEqual(caps.manageUsers, true);
    assert.strictEqual(caps.manageSettings, true);
    assert.strictEqual(caps.createProject, true);
    assert.strictEqual(caps.createAsset, true);
    assert.strictEqual(caps.editAsset, true);
    assert.strictEqual(caps.deliver, true);
    assert.strictEqual(caps.deleteAsset, 'any');
    assert.strictEqual(caps.reviewStage, 'cd');
  }
});

test('the IP allowlist stays with Super Admin alone', () => {
  // The one capability full access does not include. Asserted for every tier
  // rather than for the six, so a tier added later cannot pick it up quietly.
  const holders = Object.keys(TIERS).filter((t) => capabilitiesForTier(t).manageAccess);
  assert.deepStrictEqual(holders, ['super_admin']);
  for (const key of FULL) {
    const role = defaults.ROLES.find((r) => r.key === key);
    assert.strictEqual(capabilitiesForTier(role.tier).manageAccess, false, `${key} must not manage the allowlist`);
  }
});

test('leadership stays distinct from full_access, and only for the org chart', () => {
  // Both grant the same access. They are separate tiers because src/reporting.js
  // reads `leadership` to mean "top of the org chart" — merging them would give
  // the CEO a Reporting To field, or take it away from everyone else.
  assert.deepStrictEqual(
    capabilitiesForTier('leadership'),
    capabilitiesForTier('full_access'),
    'the two tiers must grant exactly the same thing'
  );
  const reporting = require('../src/reporting');
  assert.strictEqual(reporting.isTopOfHierarchy('managing_director_ceo'), true);
  assert.strictEqual(reporting.isTopOfHierarchy('cto'), false, 'a CTO reports to someone');
  assert.strictEqual(reporting.isTopOfHierarchy('head_of_production'), false);
});

test('full access is one definition, not six copies', () => {
  // Requirement: one shared tier rather than duplicated permission checks.
  for (const tier of ['super_admin', 'leadership', 'full_access']) {
    for (const [capability, value] of Object.entries(FULL_ACCESS)) {
      assert.strictEqual(capabilitiesForTier(tier)[capability], value,
        `${tier}.${capability} has drifted from the shared definition`);
    }
  }
});

test('a Super Admin can create new roles at the full-access tier', () => {
  assert.ok(ASSIGNABLE_TIERS.includes('full_access'));
  assert.ok(!ASSIGNABLE_TIERS.includes('super_admin'), 'but not mint another Super Admin from a form');
});

// --- against a live server -----------------------------------------------------

test('what the six can and cannot reach', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'FullAccess-Test-1!';
  let server;
  let root;          // the Super Admin
  let projectId;
  let clientId;
  const token = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'full-access-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'full-access-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    root = token.root = await login('root@zvky.test');
    clientId = await systemClientId(server.base, root);
    projectId = (await call('/projects', { token: root, method: 'POST', body: { clientId, name: 'Skyfall' } })).body.project.id;

    // One account per role under test, plus an ordinary contributor.
    for (const role of [...FULL, 'game_artist']) {
      const res = await call('/users', {
        token: root, method: 'POST',
        body: { name: role, email: `${role}@zvky.test`, role, password: PASSWORD },
      });
      assert.strictEqual(res.status, 201, `${role}: ${JSON.stringify(res.body)}`);
      token[role] = await login(`${role}@zvky.test`);
    }
  });

  t.after(() => stopServer(server));

  await t.test('every one of the six reaches every Super Admin screen', async () => {
    for (const role of FULL) {
      assert.strictEqual((await as(role, '/users?limit=5')).status, 200, `${role}: user list`);
      assert.strictEqual((await as(role, '/reference/roles?includeInactive=1')).status, 200, `${role}: settings`);
      assert.strictEqual((await as(role, '/users/import-format')).status, 200, `${role}: bulk users`);
      assert.strictEqual((await as(role, `/assets/project/${projectId}`)).status, 200, `${role}: assets`);
    }
  });

  await t.test('every one of the six can administer users', async () => {
    for (const role of FULL) {
      const made = await as(role, '/users', {
        method: 'POST',
        body: { name: `by ${role}`, email: `made-by-${role}@zvky.test`, role: 'game_artist', password: PASSWORD },
      });
      assert.strictEqual(made.status, 201, `${role} should be able to add a user`);
      const id = made.body.user.id;

      // Role, project and reporting line — the three things Edit User offers.
      assert.strictEqual((await as(role, `/users/${id}`, {
        method: 'PATCH', body: { role: 'team_lead', projectId, reportsToId: null },
      })).status, 200, `${role} should be able to edit a user`);

      assert.strictEqual((await as(role, `/users/${id}`, { method: 'DELETE' })).status, 200,
        `${role} should be able to remove a user`);
    }
  });

  await t.test('every one of the six can manage settings and projects', async () => {
    let n = 0;
    for (const role of FULL) {
      n++;
      assert.strictEqual((await as(role, '/reference/priorities', {
        method: 'POST', body: { label: `Priority ${n}` },
      })).status, 201, `${role} should be able to add a priority`);
      assert.strictEqual((await as(role, '/projects', {
        method: 'POST', body: { clientId, name: `Project ${n}` },
      })).status, 201, `${role} should be able to create a project`);
      assert.strictEqual((await as(role, `/assets/project/${projectId}`, {
        method: 'POST', body: { name: `Asset ${n}`, type: 'prop' },
      })).status, 201, `${role} should be able to create an asset`);
    }
  });

  await t.test('every one of the six can act at both review gates', async () => {
    // Not limited to their own place in the TL/CD flow — that is the point of
    // the override.
    const lead = await call('/users', {
      token: root, method: 'POST',
      body: { name: 'Lead', email: 'lead@zvky.test', role: 'team_lead', password: PASSWORD },
    });
    const artist = await call('/users', {
      token: root, method: 'POST',
      body: { name: 'Artist', email: 'artist@zvky.test', role: 'game_artist', password: PASSWORD, teamLeadId: lead.body.user.id },
    });
    token.artist = (await call('/auth/login', { method: 'POST', body: { email: 'artist@zvky.test', password: PASSWORD } })).body.token;

    for (const role of FULL) {
      const asset = (await call(`/assets/project/${projectId}`, {
        token: root, method: 'POST',
        body: { name: `Gate ${role}`, type: 'prop', assigneeId: artist.body.user.id },
      })).body.asset;
      await as('artist', `/assets/${asset.id}/start`, { method: 'POST' });
      await as('artist', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'http://nas/x' } });

      assert.strictEqual((await as(role, `/assets/${asset.id}/review`, {
        method: 'POST', body: { decision: 'approved' },
      })).status, 200, `${role} should be able to approve at the TL gate`);
      assert.strictEqual((await as(role, `/assets/${asset.id}/review`, {
        method: 'POST', body: { decision: 'approved' },
      })).status, 200, `${role} should be able to approve at the CD gate`);
      assert.strictEqual((await as(role, `/assets/${asset.id}/deliver`, { method: 'POST' })).status, 200,
        `${role} should be able to deliver`);
    }
  });

  await t.test('none of the six can touch the IP allowlist', async () => {
    // The one thing held back, by decision. Enforced by the API, not by hiding
    // a button.
    for (const role of FULL) {
      assert.strictEqual((await as(role, '/ip-allowlist')).status, 403, `${role} must not read the allowlist`);
      assert.strictEqual((await as(role, '/ip-allowlist', {
        method: 'POST', body: { address: '1.2.3.4' },
      })).status, 403, `${role} must not add to the allowlist`);
      assert.strictEqual((await as(role, '/ip-allowlist/observed')).status, 403);
      assert.strictEqual((await as(role, '/ip-allowlist/audit')).status, 403);
    }
    assert.strictEqual((await as('root', '/ip-allowlist')).status, 200, 'but the Super Admin still can');
  });

  await t.test('the six can promote others to Super Admin', async () => {
    // Decided deliberately: full access includes handing out full access.
    const res = await as('cto', '/users', {
      method: 'POST',
      body: { name: 'New Root', email: 'newroot@zvky.test', role: 'super_admin', password: PASSWORD },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.user.capabilities.manageAccess, true, 'and the new one holds the allowlist');
  });

  await t.test('an account with full access is not removed casually', async () => {
    const target = (await call('/users?search=general_manager', { token: root })).body.users[0];
    const refused = await as('cto', `/users/${target.id}`, { method: 'DELETE' });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /full studio access/i);

    // Demote first, then remove — deliberate rather than a row in a list.
    assert.strictEqual((await as('cto', `/users/${target.id}`, {
      method: 'PATCH', body: { role: 'game_artist' },
    })).status, 200);
    assert.strictEqual((await as('cto', `/users/${target.id}`, { method: 'DELETE' })).status, 200);
  });

  await t.test('a Game Artist still reaches none of it', async () => {
    for (const [path, options] of [
      ['/users?limit=5', {}],
      ['/users', { method: 'POST', body: { name: 'x', email: 'x@zvky.test', role: 'game_artist', password: PASSWORD } }],
      ['/reference/priorities', { method: 'POST', body: { label: 'Nope' } }],
      ['/reference/roles?includeInactive=1', {}],
      ['/users/import-format', {}],
      ['/projects', { method: 'POST', body: { name: 'Nope' } }],
      ['/ip-allowlist', {}],
    ]) {
      const res = await as('game_artist', path, options);
      assert.strictEqual(res.status, 403, `a Game Artist reached ${path}`);
    }
  });
});

test('an existing database has the retiered role moved up', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  // Seeding only inserts what is missing, so a role that already exists keeps
  // the tier it was created with. Account Manager - Marketing was seeded as
  // staff before this change, and needs moving explicitly.
  await resetSchema(cfg);
  await sql(cfg, `
    DROP TABLE IF EXISTS roles;
    CREATE TABLE roles (
      id CHAR(36) NOT NULL PRIMARY KEY, \`key\` VARCHAR(64) NOT NULL UNIQUE,
      label VARCHAR(120) NOT NULL, group_name VARCHAR(64) NULL, tier VARCHAR(32) NOT NULL,
      color VARCHAR(16) NULL, position INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1, is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT INTO roles (id, \`key\`, label, group_name, tier, position)
      VALUES (UUID(), 'account_manager_marketing', 'Account Manager - Marketing', 'Business & Operations', 'staff', 10);
  `);

  const server = await startServer(cfg, {});
  try {
    const [row] = await sql(cfg, "SELECT tier FROM roles WHERE `key` = 'account_manager_marketing'");
    assert.strictEqual(row.tier, 'full_access', 'the migration should have moved it');
    assert.match(server.output(), /moved from the staff tier to full_access/);

    // A tier a studio has since changed itself is left alone.
    await sql(cfg, "UPDATE roles SET tier = 'lead' WHERE `key` = 'account_manager_marketing'");
    const second = await startServer(cfg, {});
    try {
      const [after] = await sql(cfg, "SELECT tier FROM roles WHERE `key` = 'account_manager_marketing'");
      assert.strictEqual(after.tier, 'lead', 'a deliberate local change must not be overwritten');
    } finally {
      stopServer(second);
    }
  } finally {
    stopServer(server);
  }
});
