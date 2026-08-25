const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const catalog = require('../src/permission-catalog');
const { capabilitiesForTier } = require('../src/role-tiers');

const cfg = config('userperms');

// --- the catalogue and the additive rule --------------------------------------

test('the catalogue covers every group that was asked for', () => {
  assert.deepStrictEqual(catalog.GROUPS.map((g) => g.label), [
    'User Management', 'Asset Management', 'Review Workflow',
    'Project Management', 'Settings / Admin',
  ]);
  // Every key is unique and every permission belongs to a group.
  assert.strictEqual(new Set(catalog.KEYS).size, catalog.KEYS.length);
  for (const p of catalog.ALL) assert.ok(p.group && p.label, `${p.key} is missing group or label`);
});

test('grants add to a role and never take away from it', () => {
  // The whole of the additive rule, which is the thing most likely to be
  // quietly broken by a later edit.
  const artist = capabilitiesForTier('contributor');
  const baseline = catalog.baselineFor(artist);
  assert.ok(baseline.has('asset.edit'), 'a contributor edits their assets');
  assert.ok(!baseline.has('asset.add'));

  const effective = catalog.effectiveFor(artist, ['asset.add']);
  assert.ok(effective.has('asset.add'), 'the grant adds');
  for (const key of baseline) {
    assert.ok(effective.has(key), `${key} came from the role and must survive`);
  }

  // There is no grant that removes something the role gives.
  const stillThere = catalog.effectiveFor(artist, []);
  assert.ok(stillThere.has('asset.edit'), 'an empty grant list leaves the baseline intact');
});

test('a grant naming something that is not a permission is ignored', () => {
  const caps = capabilitiesForTier('contributor');
  const effective = catalog.effectiveFor(caps, ['asset.add', 'not.a.permission', '']);
  assert.ok(effective.has('asset.add'));
  assert.ok(!effective.has('not.a.permission'));
});

test('the permission that grants permissions cannot itself be granted', () => {
  assert.ok(catalog.KEYS.includes('settings.permissions'));
  assert.ok(!catalog.grantableKeys().includes('settings.permissions'),
    'or one grant would be enough to grant everything else');
  const holders = ['super_admin', 'full_access', 'leadership', 'admin', 'lead', 'contributor', 'staff']
    .filter((t) => catalog.baselineFor(capabilitiesForTier(t)).has('settings.permissions'));
  assert.deepStrictEqual(holders, ['super_admin']);
});

test('permissions with no action behind them are flagged, not hidden', () => {
  // Asked for in the catalogue, but nothing checks them yet. Listed so the
  // screen can say so rather than implying a toggle does something.
  const pending = catalog.ALL.filter((p) => p.pending).map((p) => p.key).sort();
  assert.deepStrictEqual(pending, [
    'project.edit', 'settings.audit_logs', 'user.reset_password',
  ]);
  for (const p of catalog.ALL.filter((x) => x.pending)) {
    assert.match(p.pending, /not been built/i, 'and each says why');
  }
});

// --- against a live server -----------------------------------------------------

test('granting permissions to individuals', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'UserPerms-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const setGrants = (who, keys) =>
    as('root', `/permissions/users/${people[who]}`, { method: 'PUT', body: { permissions: keys } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'perm-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'perm-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    projectId = (await call('/projects', { token: token.root, method: 'POST', body: { name: 'Skyfall' } })).body.project.id;

    for (const [who, role] of [['artist', 'game_artist'], ['other', 'game_artist'], ['cto', 'cto']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    people.root = (await call('/permissions/users', { token: token.root })).body.users
      .find((u) => u.email === 'root@zvky.test').id;
  });

  t.after(() => stopServer(server));

  await t.test('a single grant unlocks exactly one action', async () => {
    assert.strictEqual((await as('artist', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Before', type: 'prop' },
    })).status, 403, 'a Game Artist cannot create assets');

    const saved = await setGrants('artist', ['asset.add']);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.deepStrictEqual(saved.body.added, ['asset.add']);

    assert.strictEqual((await as('artist', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'After', type: 'prop' },
    })).status, 201, 'and now they can');

    // Nothing else moved.
    for (const [path, options] of [
      ['/users?limit=5', {}],
      ['/projects', { method: 'POST', body: { name: 'Nope' } }],
      ['/reference/priorities', { method: 'POST', body: { label: 'Nope' } }],
      ['/ip-allowlist', {}],
      ['/permissions/catalog', {}],
      ['/users/import-format', {}],
    ]) {
      assert.strictEqual((await as('artist', path, options)).status, 403, `${path} should still be refused`);
    }
  });

  await t.test('revoking takes effect on the next request', async () => {
    // No re-login: the effective set is computed per request.
    const saved = await setGrants('artist', []);
    assert.deepStrictEqual(saved.body.removed, ['asset.add']);
    assert.strictEqual((await as('artist', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Revoked', type: 'prop' },
    })).status, 403);
  });

  await t.test('the role baseline is untouched by any of it', async () => {
    // Their own work still behaves exactly as their role says, with no grants.
    const asset = (await call(`/assets/project/${projectId}`, {
      token: token.root, method: 'POST',
      body: { name: 'Theirs', type: 'prop', assigneeId: people.artist },
    })).body.asset;

    assert.strictEqual((await as('artist', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'working' },
    })).status, 200, 'asset.edit comes from the role');
    assert.strictEqual((await as('artist', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'http://nas/x' },
    })).status, 201, 'and so does submitting it');

    const described = await as('root', `/permissions/users/${people.artist}`);
    const fromRole = described.body.user.permissions.filter((p) => p.fromRole).map((p) => p.key);
    assert.deepStrictEqual(fromRole.sort(), ['asset.assign', 'asset.edit']);
    assert.deepStrictEqual(described.body.user.permissions.filter((p) => p.granted), []);
  });

  await t.test('a grant unlocks the action, not the reach', async () => {
    // The rule that keeps one checkbox from becoming studio-wide access: the
    // role's projectScope still decides which rows.
    await setGrants('artist', ['asset.delete']);
    const mine = (await call(`/assets/project/${projectId}`, {
      token: token.root, method: 'POST',
      body: { name: 'In reach', type: 'prop', assigneeId: people.artist },
    })).body.asset;

    const elsewhere = (await call('/projects', {
      token: token.root, method: 'POST', body: { name: 'Somewhere else' },
    })).body.project;
    const far = (await call(`/assets/project/${elsewhere.id}`, {
      token: token.root, method: 'POST', body: { name: 'Out of reach', type: 'prop' },
    })).body.asset;

    assert.strictEqual((await as('artist', `/assets/${mine.id}`, { method: 'DELETE' })).status, 200,
      'inside their scope the grant works');
    assert.strictEqual((await as('artist', `/assets/${far.id}`, { method: 'DELETE' })).status, 403,
      'outside it the grant changes nothing');
    await setGrants('artist', []);
  });

  await t.test('reach applies to people too, not only to assets', async () => {
    // The same rule as assets, and easy to be surprised by: a contributor's
    // reach over users is "the ones they added". Granting user.edit does not
    // make somebody else's account editable.
    await setGrants('artist', ['user.view', 'user.edit', 'user.change_role']);
    const someoneElse = await as('artist', `/users/${people.other}`, {
      method: 'PATCH', body: { role: 'team_lead' },
    });
    assert.strictEqual(someoneElse.status, 403);
    assert.match(someoneElse.body.error, /users you added/i);
    await setGrants('artist', []);
  });

  await t.test('field-level permissions inside Edit User are separate', async () => {
    // Tested on somebody within reach, so the field rule is what is being
    // measured rather than the scope rule above.
    await setGrants('artist', ['user.view', 'user.add', 'user.edit']);
    const made = await as('artist', '/users', {
      method: 'POST',
      body: { name: 'Theirs', email: 'theirs@zvky.test', role: 'game_artist', password: PASSWORD },
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const id = made.body.user.id;

    // Editing is allowed; changing the role is a permission they do not hold.
    assert.strictEqual((await as('artist', `/users/${id}`, {
      method: 'PATCH', body: { teamLeadId: null },
    })).status, 200, 'an ordinary edit works');
    const roleChange = await as('artist', `/users/${id}`, { method: 'PATCH', body: { role: 'team_lead' } });
    assert.strictEqual(roleChange.status, 403, 'changing a role is its own permission');
    assert.strictEqual(roleChange.body.field, 'role');

    await setGrants('artist', ['user.view', 'user.add', 'user.edit', 'user.change_role']);
    assert.strictEqual((await as('artist', `/users/${id}`, {
      method: 'PATCH', body: { role: 'team_lead' },
    })).status, 200, 'and now it is allowed');

    // Still not the reporting line, which is a third permission.
    const reporting = await as('artist', `/users/${id}`, { method: 'PATCH', body: { reportsToId: people.root } });
    assert.strictEqual(reporting.status, 403);
    assert.strictEqual(reporting.body.field, 'reportsToId');

    await setGrants('artist', []);
  });

  await t.test('only the Super Admin reaches this screen', async () => {
    // A CTO holds every other permission in the studio and still cannot grant
    // permissions — the same reasoning that keeps the IP allowlist separate.
    for (const path of ['/permissions/catalog', '/permissions/users', '/permissions/audit']) {
      assert.strictEqual((await as('cto', path)).status, 403, `a CTO reached ${path}`);
    }
    assert.strictEqual((await as('artist', '/permissions/catalog')).status, 403);
    assert.strictEqual((await as('root', '/permissions/catalog')).status, 200);
  });

  await t.test('nobody edits their own permissions', async () => {
    const res = await as('root', `/permissions/users/${people.root}`, {
      method: 'PUT', body: { permissions: [] },
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.body.error, /your own permissions/i);
    assert.strictEqual((await as('root', `/permissions/users/${people.root}`)).body.isYou, true,
      'and the screen is told so it can say why');
  });

  await t.test('the permission that grants permissions cannot be handed out', async () => {
    const res = await setGrants('artist', ['settings.permissions']);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /belongs to the Super Admin role/i);
    assert.strictEqual((await as('artist', '/permissions/catalog')).status, 403, 'and it did not take');
  });

  await t.test('nonsense keys are refused rather than stored', async () => {
    await setGrants('artist', []); // a known starting point, not the last test's
    const res = await setGrants('artist', ['asset.add', 'delete.everything']);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Not a permission/i);
    const rows = await sql(cfg, `SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = '${people.artist}'`);
    assert.strictEqual(Number(rows[0].n), 0, 'the whole save is refused, not partly applied');
  });

  await t.test('every change is on the record', async () => {
    await setGrants('artist', ['asset.add']);
    await setGrants('artist', []);

    const audit = await as('root', `/permissions/audit?userId=${people.artist}`);
    assert.strictEqual(audit.status, 200);
    const recent = audit.body.entries.slice(0, 2);
    assert.deepStrictEqual(recent.map((e) => e.action), ['revoked', 'granted'], 'newest first');
    for (const entry of recent) {
      assert.strictEqual(entry.permission, 'asset.add');
      assert.strictEqual(entry.subject, 'artist@zvky.test');
      assert.strictEqual(entry.actor, 'root@zvky.test');
      assert.ok(entry.at);
    }
  });

  await t.test('a grant to one person leaves every other account alone', async () => {
    // The regression test for a reported leak. Nothing leaked — but "nothing
    // leaked" is exactly the kind of claim that needs pinning down, so this
    // measures every account before and after rather than only the two
    // involved.
    const everyone = (await as('root', '/permissions/users')).body.users;
    assert.ok(everyone.length >= 4, 'needs a few accounts to be worth measuring');

    const snapshot = async () => {
      const out = new Map();
      for (const u of everyone) {
        const res = await as('root', `/permissions/users/${u.id}`);
        out.set(u.email, {
          granted: res.body.user.permissions.filter((p) => p.granted).map((p) => p.key).sort(),
          effective: res.body.user.permissions.filter((p) => p.effective).map((p) => p.key).sort(),
        });
      }
      return out;
    };

    const before = await snapshot();
    const target = everyone.find((u) => u.email === 'artist@zvky.test');

    const saved = await setGrants('artist', ['asset.add', 'project.add']);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    const after = await snapshot();
    for (const u of everyone) {
      const was = before.get(u.email);
      const now = after.get(u.email);
      if (u.id === target.id) {
        assert.deepStrictEqual(now.granted, ['asset.add', 'project.add'], 'the target gets exactly what was granted');
        continue;
      }
      assert.deepStrictEqual(now.granted, was.granted, `${u.email}'s grants changed`);
      assert.deepStrictEqual(now.effective, was.effective, `${u.email}'s effective permissions changed`);
    }

    // And in the table itself: one row per granted key, for one user id.
    const rows = await sql(cfg, 'SELECT user_id, permission_key FROM user_permissions ORDER BY permission_key');
    assert.deepStrictEqual(
      rows.map((r) => r.permission_key).sort(), ['asset.add', 'project.add'],
      'no rows were written for anybody else'
    );
    for (const row of rows) assert.strictEqual(row.user_id, target.id);

    // The Super Admin doing the granting is untouched.
    const rootRows = await sql(cfg, `SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = '${people.root}'`);
    assert.strictEqual(Number(rootRows[0].n), 0, 'granting must not write anything against the grantor');

    // Revoking is just as contained.
    await setGrants('artist', []);
    const restored = await snapshot();
    for (const u of everyone) {
      assert.deepStrictEqual(restored.get(u.email), before.get(u.email), `${u.email} did not return to its starting state`);
    }
  });

  await t.test('two people can be granted at the same time without crossing over', async () => {
    // Concurrent saves for different accounts: the rows are keyed by user, so
    // these cannot contend, and this is what proves it rather than assuming.
    const [a, b] = await Promise.all([
      setGrants('artist', ['asset.add']),
      setGrants('other', ['project.add']),
    ]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);

    const artist = await as('root', `/permissions/users/${people.artist}`);
    const other = await as('root', `/permissions/users/${people.other}`);
    assert.deepStrictEqual(artist.body.user.permissions.filter((p) => p.granted).map((p) => p.key), ['asset.add']);
    assert.deepStrictEqual(other.body.user.permissions.filter((p) => p.granted).map((p) => p.key), ['project.add']);

    await setGrants('artist', []);
    await setGrants('other', []);
  });

  await t.test('two accounts on the same role are not each other', async () => {
    // The likeliest way to *think* a grant leaked: two people share a role, so
    // they share a baseline, and both screens show the same ticks. Only one of
    // them has anything granted individually.
    await setGrants('artist', ['asset.add']);
    const artist = (await as('root', `/permissions/users/${people.artist}`)).body.user;
    const other = (await as('root', `/permissions/users/${people.other}`)).body.user;

    assert.strictEqual(artist.role, other.role, 'same role');
    assert.deepStrictEqual(
      artist.permissions.filter((p) => p.fromRole).map((p) => p.key),
      other.permissions.filter((p) => p.fromRole).map((p) => p.key),
      'so the same baseline — this is not a leak'
    );
    assert.deepStrictEqual(artist.permissions.filter((p) => p.granted).map((p) => p.key), ['asset.add']);
    assert.deepStrictEqual(other.permissions.filter((p) => p.granted).map((p) => p.key), []);

    // And it shows in what they can actually do.
    assert.strictEqual((await as('artist', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Mine', type: 'prop' },
    })).status, 201);
    assert.strictEqual((await as('other', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Not mine', type: 'prop' },
    })).status, 403);
    await setGrants('artist', []);
  });

  await t.test('the screen is told what comes from where', async () => {
    await setGrants('artist', ['asset.add']);
    const res = await as('root', `/permissions/users/${people.artist}`);
    const byKey = new Map(res.body.user.permissions.map((p) => [p.key, p]));

    assert.deepStrictEqual(byKey.get('asset.edit'), { key: 'asset.edit', fromRole: true, granted: false, effective: true });
    assert.deepStrictEqual(byKey.get('asset.add'), { key: 'asset.add', fromRole: false, granted: true, effective: true });
    assert.deepStrictEqual(byKey.get('user.delete'), { key: 'user.delete', fromRole: false, granted: false, effective: false });
    await setGrants('artist', []);
  });
});
