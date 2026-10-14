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

test('the catalogue grew by exactly one key, and only Super Admin holds it', () => {
  /* THE ONE PERMITTED DIFFERENCE from the snapshot, named here so the test
     below can subtract it honestly rather than loosening its comparison. */
  const added = catalog.KEYS.filter((k) => !SNAPSHOT.roles.super_admin.includes(k));
  assert.deepStrictEqual(added, [MANAGE],
    'role groups must add one catalogue key and no others');
  assert.strictEqual(catalog.KEYS.length, SNAPSHOT.catalogueSize + 1);

  const entry = catalog.BY_KEY.get(MANAGE);
  assert.strictEqual(entry.label, 'Manage Role Groups');
  const holders = roles.roleKeys().filter((k) => {
    const def = roles.roleDef(k);
    return def && entry.impliedBy(def);
  });
  assert.deepStrictEqual(holders, ['super_admin'],
    'Manage Role Groups starts with the Super Admin tier alone');
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
      const now = [...held].filter((k) => k !== MANAGE).sort();
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
