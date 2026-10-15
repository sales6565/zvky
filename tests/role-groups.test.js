/* ROLE GROUPS: an additive layer, held to "additive" by a snapshot.
 *
 * THE HARD CONSTRAINT IS THE FIRST TEST IN THIS FILE, and it is the reason the
 * fixture exists: effectiveFor() was recorded for all sixty designations BEFORE
 * any of this was written (tests/fixtures/role-permissions-before-groups.json,
 * taken through the real seeding path against a fresh schema). With no groups
 * defined — and for any role in no group — the answer must still be exactly
 * that, key for key.
 *
 * The one permitted difference is the new management key, and it is asserted
 * rather than excused: settings.role_groups reaches Super Admin and nobody else,
 * which is the studio's standing rule that Super Admin receives every new
 * permission.
 *
 * WHAT ELSE THIS FILE IS CAREFUL ABOUT:
 *
 *   THE UNION IS A UNION. One group, two groups, a role in none — and a role
 *      outside a group gains nothing from it existing.
 *   IT REACHES A LIVE TOKEN. Every change — adding a role, removing a
 *      permission, deleting the group — lands on the session that is already
 *      signed in, because authenticate() resolves permissions per request.
 *   ESCALATION IS REFUSED. The two bootstrap keys, and anything the editor does
 *      not hold themselves.
 *   NOTHING IS ORPHANED. Deleting a group takes its members and grants with it
 *      by foreign key; deleting a designation takes its memberships.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../src/permission-catalog');
const roleGroups = require('../src/role-groups');
const roles = require('../src/roles');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('rolegroups');
const PASSWORD = 'RoleGroups-1!';
const SNAPSHOT = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'role-permissions-before-groups.json'), 'utf8'));
const MANAGE = 'settings.role_groups';

// ===========================================================================
// 1. THE CONSTRAINT: nothing changed.
// ===========================================================================

/* EVERY KEY ADDED SINCE THE SNAPSHOT WAS TAKEN, named one by one.
 *
 * The fixture was recorded before role groups existed, and the catalogue has
 * grown five times since: settings.role_groups with that feature,
 * settings.email_delivery with the Gmail transport, report.remind with the
 * reminders a lead can send from the follow-up lists, settings.nudges with
 * the start-of-day banner and the top-bar timer — which split the nudge
 * SETTINGS screen away from the key that SENDS reminders — and now the four
 * Leave and Idle keys. The list is EXACT rather than a count, so a key added
 * later has to come past this line and be accounted for, which is the whole
 * point of pinning a snapshot.
 *
 * THE FOUR LEAVE KEYS ARE FOUR AND NOT ONE, and the split is the same kind this
 * file has pinned before: marking somebody's absence removes hours from totals,
 * marking them idle removes nothing, marking a PAST date changes a figure
 * somebody may already have reported on, and deciding the studio has the
 * feature at all moves every future half-day at once. Four powers, four keys.
 *
 * AND NOW THE EIGHT OFFICE FILE SERVER KEYS. Seven for the tab and one for the
 * screen that configures it, and they are eight rather than one for the reason
 * this file keeps pinning: reading a folder, taking a copy of a file out,
 * putting one in, asking for a deletion, answering those asks, browsing the
 * whole share, reading the audit trail, and holding the gateway's keys are
 * eight different powers over a file server in the studio's building. They all
 * start at Super Admin for a reason specific to this feature: on the day it
 * ships no gateway exists, so the tab is hidden and the keys are granted once
 * the office machine is actually there.
 *
 * Each one must reach Super Admin and nobody else, which is this studio's
 * standing rule for a new permission; the snapshot comparison below subtracts
 * exactly these. */
const SINCE_SNAPSHOT = [MANAGE, 'settings.email_delivery', 'report.remind', 'settings.nudges',
  'followup.mark_leave', 'followup.mark_idle', 'followup.mark_past_dates', 'settings.leave.manage',
  'server.view', 'server.download', 'server.upload', 'server.request_delete',
  'server.manage_requests', 'server.browse_all', 'server.view_audit', 'settings.server.manage'];

test('every key added since the snapshot is Super Admin only', () => {
  const added = catalog.KEYS.filter((k) => !SNAPSHOT.roles.super_admin.includes(k));
  assert.deepStrictEqual(added.sort(), [...SINCE_SNAPSHOT].sort(),
    'a catalogue key was added without being accounted for here');
  assert.strictEqual(catalog.KEYS.length, SNAPSHOT.catalogueSize + SINCE_SNAPSHOT.length);

  for (const key of SINCE_SNAPSHOT) {
    const entry = catalog.BY_KEY.get(key);
    assert.ok(entry, `${key} is in the catalogue`);
    const holders = roles.roleKeys().filter((k) => {
      const def = roles.roleDef(k);
      return def && entry.impliedBy(def);
    });
    assert.deepStrictEqual(holders, ['super_admin'],
      `${key} must start with the Super Admin tier alone`);
  }
  assert.strictEqual(catalog.BY_KEY.get(MANAGE).label, 'Manage Role Groups');
});

test('THE SNAPSHOT: with no groups defined, every role is unchanged',
  { skip: cfg ? false : SKIP_REASON }, async () => {
  /* Against a fresh schema and the real module, exactly as the snapshot was
     taken — so this compares the seeding path with itself across the change
     rather than comparing two different ways of asking. */
  await resetSchema(cfg);
  const server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rgsnap' });
  try {
    const db = dbFor(cfg);
    const rolePermissions = require('../src/role-permissions');
    assert.ok(Object.keys(SNAPSHOT.roles).length >= 60, 'the snapshot covers the studio');

    for (const [roleKey, expected] of Object.entries(SNAPSHOT.roles)) {
      const held = await rolePermissions.effectiveFor(db, roleKey);
      const now = [...held].filter((k) => !SINCE_SNAPSHOT.includes(k)).sort();
      assert.deepStrictEqual(now, expected,
        `${roleKey} changed: +${now.filter((k) => !expected.includes(k))} `
        + `-${expected.filter((k) => !now.includes(k))}`);
    }

    /* AND THE TABLES ARE EMPTY. The migration seeds no groups, which is what
       makes the comparison above a statement about the feature rather than
       about this fixture. */
    for (const table of ['role_groups', 'role_group_members', 'role_group_permissions']) {
      const [{ n }] = await sql(cfg, `SELECT COUNT(*) AS n FROM ${table}`);
      assert.strictEqual(Number(n), 0, `${table} must start empty`);
    }
  } finally { stopServer(server); }
});

/* A db handle the real modules can use, over the suite's own sql() helper.
 *
 * NOT src/db.js: that builds a connection POOL at require time from the
 * environment, and a pool in the test process outlives the test — node --test
 * waits for the event loop to drain, so the first version of this hung for ten
 * minutes with every assertion already passed. This opens and closes a
 * connection per query, which is slower and finishes.
 *
 * It speaks the same $1 dialect src/db.js does, translated the same way: each
 * placeholder becomes a ? and the parameters are reordered by appearance, so a
 * statement written for the application runs here unchanged. */
function dbFor(c) {
  return {
    query: async (statement, params = []) => {
      const order = [];
      const sqlText = statement.replace(/\$(\d+)/g, (m, n) => { order.push(Number(n)); return '?'; });
      const args = order.map((n) => params[n - 1]);
      const rows = await sql(c, sqlText, args);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };
}

// ===========================================================================
// 2. THE MODULE: validation, with no server.
// ===========================================================================

test('a group is one of three kinds, and nothing else', () => {
  assert.deepStrictEqual(roleGroups.KINDS, ['department', 'level', 'custom']);
  for (const kind of roleGroups.KINDS) assert.strictEqual(roleGroups.validateKind(kind).ok, true);
  for (const bad of ['', null, 'team', 'DEPARTMENT ', 'squad']) {
    const v = roleGroups.validateKind(bad);
    if (bad === 'DEPARTMENT ') {
      assert.strictEqual(v.ok, true, 'case and spaces are tolerated');
      continue;
    }
    assert.strictEqual(v.ok, false, `${JSON.stringify(bad)} is not a kind`);
    assert.strictEqual(v.field, 'kind');
  }
});

test('a name is required, trimmed and bounded', () => {
  assert.strictEqual(roleGroups.validateName('  Supervision  ').name, 'Supervision');
  for (const bad of ['', '   ', null, undefined]) {
    assert.strictEqual(roleGroups.validateName(bad).ok, false);
  }
  const long = roleGroups.validateName('x'.repeat(roleGroups.NAME_MAX + 1));
  assert.strictEqual(long.ok, false);
  assert.strictEqual(roleGroups.validateName('x'.repeat(roleGroups.NAME_MAX)).ok, true);
});

test('unknown keys and duplicates: refused by name, collapsed quietly', () => {
  const holds = new Set(catalog.KEYS);
  const unknown = roleGroups.validatePermissions(['review.tl', 'not.a.key'], holds);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.status, 400);
  assert.match(unknown.error, /not\.a\.key/, 'the typo is named rather than dropped');

  /* A DUPLICATE IS NOT AN ERROR: sending a key twice is asking for it to be
     granted, which it is. Collapsed rather than refused. */
  const dupes = roleGroups.validatePermissions(['review.tl', 'review.tl', 'asset.add'], holds);
  assert.strictEqual(dupes.ok, true);
  assert.deepStrictEqual(dupes.permissions.sort(), ['asset.add', 'review.tl']);

  const badRoles = roleGroups.validateRoles(['team_lead', 'wizard']);
  assert.strictEqual(badRoles.ok, false);
  assert.match(badRoles.error, /wizard/);
  const dupeRoles = roleGroups.validateRoles(['team_lead', 'team_lead']);
  assert.deepStrictEqual(dupeRoles.roles, ['team_lead']);
});

test('the two bootstrap keys can never be granted through a group', () => {
  /* THE ESCALATION RULE, at its root: a group that could grant the group screen
     or the role screen could add its own members to a group granting
     everything. Refused even for an editor who holds both. */
  assert.deepStrictEqual(roleGroups.NEVER_GRANTABLE,
    ['settings.permissions', 'settings.role_groups']);
  const everything = new Set(catalog.KEYS);
  for (const key of roleGroups.NEVER_GRANTABLE) {
    const v = roleGroups.validatePermissions([key], everything);
    assert.strictEqual(v.ok, false, `${key} must be refused`);
    assert.strictEqual(v.status, 400);
    assert.ok(!roleGroups.grantable(key), `grantable(${key}) must be false`);
  }
});

test('nobody grants through a group what they do not hold themselves', () => {
  const modest = new Set(['asset.add']);
  const v = roleGroups.validatePermissions(['asset.add', 'asset.delete'], modest);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 403, 'that is a refusal about the person, not the request');
  assert.match(v.error, /do not hold it yourself/);
  assert.strictEqual(roleGroups.validatePermissions(['asset.add'], modest).ok, true);
});

test('every catalogue key except the two bootstrap keys is grantable by a group', () => {
  /* THE BRIEF ASKS THAT EVERY KEY BE GRANTABLE THROUGH A GROUP. Asserted over
     the whole catalogue rather than a sample, so a key added later with a shape
     this layer cannot carry fails here. */
  const everything = new Set(catalog.KEYS);
  const refused = catalog.KEYS.filter((k) => !roleGroups.validatePermissions([k], everything).ok);
  /* Sorted on both sides: `refused` comes back in CATALOGUE order and
     NEVER_GRANTABLE is written in the order the two keys are explained in, and
     this test is about the set rather than the order. */
  assert.deepStrictEqual(refused.sort(), [...roleGroups.NEVER_GRANTABLE].sort(),
    'exactly the two bootstrap keys are refused, and every other key can be granted');
  const batch = roleGroups.validatePermissions(
    catalog.KEYS.filter((k) => roleGroups.grantable(k)), everything);
  assert.strictEqual(batch.ok, true, 'and all of them at once');
  assert.strictEqual(batch.permissions.length, catalog.KEYS.length - 2);
});

// ===========================================================================
// 3. AGAINST A LIVE SERVER: the union, and every way it changes.
// ===========================================================================

test('role groups, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  /* WHAT THIS SESSION MAY DO, asked of the server on the token it already has.
     /auth/me is what the page polls, so this is the same answer a signed-in
     browser gets without re-authenticating — which is how every "takes effect
     on the existing token" claim below is measured. */
  const permsOf = async (who) => new Set((await as(who, '/auth/me')).body.user.permissions);
  const makeGroup = async (body) => {
    const r = await as('root', '/role-groups', { method: 'POST', body });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.group;
  };
  const setPerms = (groupId, permissions) => as('root',
    `/role-groups/${groupId}/permissions`, { method: 'PUT', body: { permissions } });
  const setRoles = (groupId, roles) => as('root',
    `/role-groups/${groupId}/roles`, { method: 'PUT', body: { roles } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rgroups' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'rgroups', name: 'Root', email: 'root@rg.test', password: PASSWORD } });
    tok.root = await login('root@rg.test');
    const mk = async (who, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@rg.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[who] = r.body.user.id;
      tok[who] = await login(`${who}@rg.test`);
    };
    await mk('lead', 'team_lead');
    await mk('artist', 'game_artist');
    await mk('producer', 'producer');
  });
  t.after(() => stopServer(server));

  await t.test('a role outside every group is untouched by one existing', async () => {
    const before = await permsOf('artist');
    const group = await makeGroup({ name: 'Leads', kind: 'level', description: 'Lead level' });
    await setPerms(group.id, ['pnl.actual']);
    await setRoles(group.id, ['team_lead']);

    const after = await permsOf('artist');
    assert.deepStrictEqual([...after].sort(), [...before].sort(),
      'the artist is in no group and nothing about them moved');
    assert.ok(!after.has('pnl.actual'));
    id.leads = group.id;
  });

  await t.test('THE UNION: the role\'s own, plus the group\'s', async () => {
    const own = new Set((await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key));
    assert.ok(!own.has('pnl.actual'), 'the role does not hold it in its own right');

    const held = await permsOf('lead');
    assert.ok(held.has('pnl.actual'), 'but it is held through the group');
    for (const key of own) {
      assert.ok(held.has(key), `${key}: the role's own permissions all survive the union`);
    }
    assert.strictEqual(held.size, own.size + 1, 'and the group added exactly the one key');
  });

  await t.test('two groups combine, and removing one leaves the other', async () => {
    const second = await makeGroup({ name: 'Art Department', kind: 'department' });
    await setPerms(second.id, ['report.view', 'pnl.actual']);
    await setRoles(second.id, ['team_lead', 'game_artist']);
    id.art = second.id;

    const lead = await permsOf('lead');
    assert.ok(lead.has('pnl.actual') && lead.has('report.view'),
      'the lead is in both groups and holds the union of them');
    const artist = await permsOf('artist');
    assert.ok(artist.has('report.view') && artist.has('pnl.actual'),
      'the artist is in one of them');

    /* pnl.view is granted by BOTH. Taking it out of one must not take it away,
       which is the property that makes a union a union rather than a last-write. */
    await setPerms(second.id, ['report.view']);
    const still = await permsOf('lead');
    assert.ok(still.has('pnl.actual'), 'still granted by the other group');
    const artistNow = await permsOf('artist');
    assert.ok(!artistNow.has('pnl.actual'), 'but the artist, in only that group, loses it');
    assert.ok(artistNow.has('report.view'));
  });

  await t.test('a permission granted by a group arrives through the real gate', async () => {
    /* NOT JUST IN THE SET — through requirePermission. report.view is what the
       Efficiency endpoint asks for, so this is the permission doing its job
       rather than appearing in a list.
       
       Asserted as "not 403" rather than as 200: the endpoint may answer 400 for
       a missing filter, and what is under test is the GATE. */
    const granted = await as('artist', '/reports/efficiency');
    assert.notStrictEqual(granted.status, 403,
      `the artist is past the gate through the group: ${JSON.stringify(granted.body)}`);
    const refused = await as('producer', '/reports/efficiency');
    assert.strictEqual(refused.status, 403, 'and a role in no group is not');
  });

  await t.test('removing a role from a group takes effect on the token it holds', async () => {
    assert.ok((await permsOf('artist')).has('report.view'));
    const r = await setRoles(id.art, ['team_lead']);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.removed, ['game_artist']);
    assert.ok(!(await permsOf('artist')).has('report.view'),
      'no sign-out: authenticate() resolves permissions per request');
    assert.strictEqual((await as('artist', '/reports/efficiency')).status, 403,
      'and the route refuses it again');
  });

  await t.test('withdrawing a permission from a group takes effect at once', async () => {
    assert.ok((await permsOf('lead')).has('report.view'));
    await setPerms(id.art, []);
    assert.ok(!(await permsOf('lead')).has('report.view'));
    assert.ok((await permsOf('lead')).has('pnl.actual'), 'the other group is unaffected');
  });

  await t.test('deleting a group says what will be lost, then takes it away', async () => {
    const impact = await as('root', `/role-groups/${id.leads}/impact`);
    assert.strictEqual(impact.status, 200, JSON.stringify(impact.body));
    const forLead = impact.body.losses.find((l) => l.role === 'team_lead');
    assert.ok(forLead, `the member role is listed: ${JSON.stringify(impact.body.losses)}`);
    assert.deepStrictEqual(forLead.lost, ['pnl.actual']);
    assert.ok(forLead.lostLabels[0], 'and in words, not only in keys');

    const gone = await as('root', `/role-groups/${id.leads}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.ok(!(await permsOf('lead')).has('pnl.actual'),
      'the grant is gone on the existing token');

    /* NO ORPHANS. The members and the grants cascade with the group row. */
    for (const table of ['role_group_members', 'role_group_permissions']) {
      const [{ n }] = await sql(cfg,
        `SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`, [id.leads]);
      assert.strictEqual(Number(n), 0, `${table} kept a row for a deleted group`);
    }
  });

  await t.test('a permission the role holds in its own right is not reported as a loss', async () => {
    /* The impact view is per role and only counts what would ACTUALLY go. A
       warning that over-reported would be noise. */
    const group = await makeGroup({ name: 'Overlap', kind: 'custom' });
    await setPerms(group.id, ['review.tl']);           // team_lead holds this already
    await setRoles(group.id, ['team_lead']);
    const impact = await as('root', `/role-groups/${group.id}/impact`);
    assert.deepStrictEqual(impact.body.losses, [],
      'nothing is lost, because the role holds it anyway');
    await as('root', `/role-groups/${group.id}`, { method: 'DELETE' });
    assert.ok((await permsOf('lead')).has('review.tl'), 'and it really does keep it');
  });

  await t.test('the role view shows which group each inherited permission came from', async () => {
    const group = await makeGroup({ name: 'Supervision', kind: 'department' });
    await setPerms(group.id, ['pnl.actual']);
    await setRoles(group.id, ['team_lead']);

    const view = (await as('root', '/permissions/roles/team_lead')).body.role;
    /* CONTAINS, not equals: team_lead is still in Art Department from the case
       above — which is the ordinary state of a studio, a role in more than one
       group, and the thing this view has to render. What IS exact is where the
       inherited key comes from, because only one group grants it. */
    assert.ok(view.groups.map((g) => g.name).includes('Supervision'),
      `the view names the groups: ${view.groups.map((g) => g.name).join(', ')}`);
    assert.ok(view.groups.every((g) => typeof g.grants === 'number'),
      'with how much each one grants');
    const row = view.permissions.find((p) => p.key === 'pnl.actual');
    assert.deepStrictEqual(row.inheritedFrom.map((g) => g.name), ['Supervision']);
    assert.strictEqual(row.enabled, false,
      'the CHECKBOX is the role\'s own answer — inherited is not stored against the role');

    /* AND THE EDITOR DOES NOT BAKE IT IN. Saving the role exactly as the screen
       shows it must leave the role's own set alone, or a group grant would
       become the role's permanently the first time anybody pressed Save. */
    const ticked = view.permissions.filter((p) => p.enabled).map((p) => p.key);
    const saved = await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: ticked } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.deepStrictEqual(saved.body.enabled, []);
    assert.deepStrictEqual(saved.body.disabled, []);
    const after = (await as('root', '/permissions/roles/team_lead')).body.role;
    assert.strictEqual(after.permissions.find((p) => p.key === 'pnl.actual').enabled, false,
      'still inherited rather than owned');
    assert.ok((await permsOf('lead')).has('pnl.actual'), 'and still held');
    id.supervision = group.id;
  });

  await t.test('a group grant survives the role switching the same key off', async () => {
    /* THE DOCUMENTED CONFLICT, pinned so it is a decision rather than a
       surprise: an explicit role-level "off" does not block a group grant,
       because the storage cannot tell a deliberate revoke from a key nobody
       ticked. See the note at the top of src/role-groups.js. */
    const own = (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(own.includes('review.tl'));
    await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: own.filter((k) => k !== 'review.tl') } });
    assert.ok(!(await permsOf('lead')).has('review.tl'), 'off, with no group granting it');

    await setPerms(id.supervision, ['pnl.actual', 'review.tl']);
    assert.ok((await permsOf('lead')).has('review.tl'),
      'the group re-grants it — additive, and visible on the role view');
    const row = (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.find((p) => p.key === 'review.tl');
    assert.strictEqual(row.enabled, false, 'the role still does not hold it');
    assert.deepStrictEqual(row.inheritedFrom.map((g) => g.name), ['Supervision'],
      'and the view says where it comes from');

    // Put it back, so the cases after this one see an ordinary team lead.
    await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: own } });
    await setPerms(id.supervision, ['pnl.actual']);
  });

  await t.test('escalation is refused on the route, not only in the module', async () => {
    for (const key of roleGroups.NEVER_GRANTABLE) {
      const r = await setPerms(id.supervision, ['pnl.actual', key]);
      assert.strictEqual(r.status, 400, `${key}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'permissions');
    }
    const unknown = await setPerms(id.supervision, ['not.a.key']);
    assert.strictEqual(unknown.status, 400);
    const badRole = await setRoles(id.supervision, ['wizard']);
    assert.strictEqual(badRole.status, 400);
    const dupe = await as('root', '/role-groups', { method: 'POST',
      body: { name: 'Supervision', kind: 'custom' } });
    assert.strictEqual(dupe.status, 409, 'and a name is unique');

    /* Nothing of that landed: the group still grants what it granted. */
    const group = (await as('root', '/role-groups')).body.groups
      .find((g) => g.id === id.supervision);
    assert.deepStrictEqual(group.permissions, ['pnl.actual']);
    assert.deepStrictEqual(group.roles.map((r) => r.key), ['team_lead']);
  });

  await t.test('403 without the key, and success on the same token after a grant', async () => {
    /* THE GATE, both ways, on ONE token — so what is being tested is the
       server resolving permissions per request rather than a fresh sign-in. */
    for (const path of ['/role-groups', '/role-groups/audit']) {
      assert.strictEqual((await as('lead', path)).status, 403, `${path} is gated`);
    }
    assert.strictEqual((await as('lead', '/role-groups', { method: 'POST',
      body: { name: 'Mine', kind: 'custom' } })).status, 403, 'and so is creating one');

    const held = (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    const grant = await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: [...held, roleGroups.MANAGE_KEY] } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));

    const now = await as('lead', '/role-groups');
    assert.strictEqual(now.status, 200, 'the same token now reaches it');
    /* AND THEIR OWN CEILING APPLIES: a lead cannot grant through a group a
       permission they do not hold. */
    assert.ok(!now.body.grantable.includes('asset.delete'),
      'the picker does not offer what they cannot grant');
    const beyond = await as('lead', `/role-groups/${id.supervision}/permissions`,
      { method: 'PUT', body: { permissions: ['asset.delete'] } });
    assert.strictEqual(beyond.status, 403, JSON.stringify(beyond.body));
    assert.match(beyond.body.error, /do not hold it yourself/);

    await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
    assert.strictEqual((await as('lead', '/role-groups')).status, 403, 'and it is taken back');
  });

  await t.test('every change is audited', async () => {
    const { entries } = (await as('root', '/role-groups/audit')).body;
    const actions = entries.map((e) => e.action);
    for (const action of ['created', 'members', 'permissions', 'deleted']) {
      assert.ok(actions.includes(action), `${action} is in the audit: ${actions.join(',')}`);
    }
    assert.ok(entries.every((e) => e.actor), 'and every entry names who did it');
    const created = entries.filter((e) => e.action === 'created');
    assert.ok(created.some((e) => e.group === 'Supervision'));
  });

  await t.test('deleting a designation forgets its group membership', async () => {
    const role = await as('root', '/reference/roles', { method: 'POST',
      body: { label: 'Temporary Designation', tier: 'contributor', group: 'Art' } });
    assert.strictEqual(role.status, 201, JSON.stringify(role.body));
    const key = role.body.entry.key;
    await setRoles(id.supervision, ['team_lead', key]);
    const [{ n: before }] = await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_members WHERE role_key = ?', [key]);
    assert.strictEqual(Number(before), 1);

    const gone = await as('root', `/reference/roles/${encodeURIComponent(key)}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    const [{ n: after }] = await sql(cfg,
      'SELECT COUNT(*) AS n FROM role_group_members WHERE role_key = ?', [key]);
    assert.strictEqual(Number(after), 0, 'no orphan membership for a deleted designation');
  });

  await t.test('renaming a group keeps its members and its grants', async () => {
    const r = await as('root', `/role-groups/${id.supervision}`, { method: 'PATCH',
      body: { name: 'Supervision & Direction', kind: 'level', description: 'Renamed' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.group.name, 'Supervision & Direction');
    assert.strictEqual(r.body.group.kind, 'level');
    assert.deepStrictEqual(r.body.group.permissions, ['pnl.actual']);
    assert.ok((await permsOf('lead')).has('pnl.actual'), 'and the grant still reaches the role');
  });

  await t.test('the migration is idempotent, and seeds no groups', async () => {
    /* Run again against a database that already has everything. The counts
       either side are what makes "idempotent" a measurement rather than a
       claim. */
    const counts = async () => {
      const out = {};
      for (const table of ['role_groups', 'role_group_members', 'role_group_permissions',
        'role_permissions']) {
        const [{ n }] = await sql(cfg, `SELECT COUNT(*) AS n FROM ${table}`);
        out[table] = Number(n);
      }
      return out;
    };
    const before = await counts();
    const second = await startServer(cfg, { BOOTSTRAP_TOKEN: 'again' });
    try {
      const after = await counts();
      assert.deepStrictEqual(after, before, 'a second migration changed rows');
    } finally { stopServer(second); }
  });
});

// ===========================================================================
// 4. THE PAGE: gated by the key, and honest about inheritance.
// ===========================================================================

test('the page gates the section on the key, never on a tier', () => {
  const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  /* BOTH HALVES, as everywhere else in this application: the section is drawn
     behind can('settings.role_groups') and every route behind
     requirePermission. The hidden section is a courtesy; the route is the lock. */
  assert.match(PAGE, /\$\{can\('settings\.role_groups'\) \? '<div id="roleGroupsSection"><\/div>' : ''\}/,
    'the section is drawn behind the key');
  assert.match(PAGE, /if\(can\('settings\.role_groups'\)\) await renderRoleGroups\(\);/,
    'and loaded behind it too');

  /* AND NOT ON A TIER. The screen must not ask what designation somebody holds;
     the server resolved their permissions and the page reads that answer. */
  const from = PAGE.indexOf('async function renderRoleGroups(){');
  const to = PAGE.indexOf("/* ---------- profile / change password ---------- */", from);
  assert.ok(from !== -1 && to > from, 'the section is in the page');
  const code = PAGE.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const leak of ['super_admin', 'tier', 'fullAccess(']) {
    assert.ok(!code.includes(leak), `the group screen must not decide on ${leak}`);
  }
  /* The picker's options come from the server's `grantable`, not from the
     catalogue the page happens to hold — so it cannot offer a key the write
     would refuse. */
  assert.match(code, /\(rgState\.grantable\|\|\[\]\)\.includes\(p\.key\)/);
  /* And deleting asks the server what will be lost rather than working it out. */
  assert.match(code, /\/impact/, 'the confirmation is built from the server\'s own answer');
  assert.match(code, /askConfirm\(\{/, 'and asked in the page\'s own modal');
  for (const native of ['prompt(', 'confirm(', 'alert(']) {
    assert.ok(!code.includes(native), `no native ${native} — it throws in the desktop app`);
  }
});

test('the role view marks an inherited permission without untickable boxes', () => {
  const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const from = PAGE.indexOf('async function showRolePermissions(roleKey){');
  const to = PAGE.indexOf("/* ---------- role groups: the additive layer ---------- */", from);
  assert.ok(from !== -1 && to > from);
  const code = PAGE.slice(from, to);

  /* THE TAG NAMES THE GROUP, and the checkbox stays bound to the role's own
     answer — `state.enabled`, which the server fills from ownFor(). A box
     ticked by inheritance would be written back as the role's own on the next
     Save. */
  assert.match(code, /state\.inheritedFrom \|\| \[\]/);
  assert.match(code, /from a group: \$\{escapeHTML\(from\.map\(x=>x\.name\)\.join\(', '\)\)\}/);
  assert.match(code, /\$\{state\.enabled\?'checked':''\}/,
    'the checkbox follows the role\'s own set, not the effective one');
  assert.match(code, /held by inheritance only/,
    'and a key held ONLY through a group says so');

  /* NOT FADED. .pm-row.inherited dims to 62% and dot-underlines the label — it
     belongs to the per-user grant screen that was removed, and it reads as
     "disabled". An inherited permission is held. */
  assert.ok(!/\$\{from\.length\?' inherited'/.test(code),
    'the dimmed legacy class must not be reused for a permission that IS held');
  assert.match(code, /from-group/);
  assert.match(PAGE, /\.pm-row\.from-group\{background:var\(--info-t10\)/,
    'and its style is tokens, like every other colour in the page');
});

// ===========================================================================
// 5. THE COST: one query, and it does not grow.
// ===========================================================================

test('the group layer adds exactly one query per request, whatever the group count', () => {
  /* MEASURED, not asserted in prose. A counting db stands in for the pool and
   * reports how many statements effectiveFor() issues — which is what runs on
   * every authenticated request.
   *
   * THE STEADY STATE is what is being measured: role_permissions already holds
   * a row for every catalogue key, so topUpRole() finds nothing missing and
   * writes nothing. A role seeded before the catalogue grew costs its INSERTs
   * once and never again, which is the existing behaviour and not this layer's.
   */
  const fakeDb = (groups) => {
    const log = [];
    return {
      log,
      query: async (statement) => {
        log.push(statement.replace(/\s+/g, ' ').trim());
        if (/FROM role_permissions WHERE role_key = \$1 AND enabled = 1/.test(statement)) {
          return { rows: [{ permission_key: 'asset.add' }] };
        }
        if (/SELECT permission_key FROM role_permissions WHERE role_key/.test(statement)) {
          return { rows: catalog.KEYS.map((k) => ({ permission_key: k })) };
        }
        if (/FROM role_group_members gm/.test(statement)) {
          const rows = [];
          for (let g = 0; g < groups; g += 1) {
            for (let i = 0; i < 3; i += 1) {
              rows.push({ permission_key: catalog.KEYS[(g + i) % catalog.KEYS.length] });
            }
          }
          return { rows };
        }
        return { rows: [] };
      },
    };
  };
  const rolePermissions = require('../src/role-permissions');

  const counts = [];
  for (const groups of [0, 1, 2, 40]) {
    const db = fakeDb(groups);
    counts.push(rolePermissions.effectiveFor(db, 'team_lead')
      .then((held) => ({ log: db.log, held })));
  }
  return Promise.all(counts).then((runs) => {
    const logs = runs.map((r) => r.log);
    const sizes = logs.map((l) => l.length);
    assert.deepStrictEqual(sizes, [3, 3, 3, 3],
      `the query count moved with the number of groups: ${sizes.join(', ')}`);
    /* And exactly one of the three is this layer's: the other two are
       forRole() and topUpRole()'s read, both of which predate it. */
    const groupQueries = logs[3].filter((q) => /role_group_members/.test(q));
    assert.strictEqual(groupQueries.length, 1, 'one group query, not one per group');
    assert.match(groupQueries[0], /SELECT DISTINCT gp\.permission_key/,
      'and it is the single join, not a per-group lookup');
    assert.ok(runs[3].held.size > runs[0].held.size,
      'and the forty groups really did grant something through that one query');
    /* NOT A QUERY PER PERMISSION EITHER, which is the other way this could have
       grown: forty groups granting three keys each is still the one statement
       counted above, and the held set proves the answer really came back. */
  });
});
