/* SEEDING THE LEAD-LEVEL HOLD KEY ON A DATABASE THAT ALREADY EXISTS.
 *
 * asset.hold_any arrived with the FOURTH report of the Hold button. Its default
 * — impliedBy has('leadsTeam') — is what a NEW studio gets from the catalogue.
 * A studio that already has role_permissions rows has one row per key per
 * designation, written when that designation was first seeded, so a key added to
 * the catalogue afterwards is filled in at its default by topUpRole.
 *
 * WHAT THE MIGRATION IS FOR is the install where that row exists and is OFF —
 * and the whole difficulty is the one thing it must not do:
 *
 *   AN ADMIN WHO TURNED IT OFF MUST STAY OFF, after this deploy and after every
 *   one after it. A migration that re-enables a decision somebody made is worse
 *   than one that never ran: the admin has no way to make it stick, and will
 *   conclude the Settings screen does not work. updated_by_email is what tells a
 *   seeded row from a decision — the same mechanism ensureReviewGateDefaults
 *   next door uses for review.tl, which is this step's precedent.
 *
 * AND ONLY DESIGNATIONS THE CATALOGUE ITSELF WOULD GIVE IT TO. Not "lead-like",
 * not a name match: baselineFor(capabilitiesForTier(tier)), the same function
 * the seed uses. A studio's own designation that nobody marked as running a team
 * is not granted, because nothing has decided that it should be.
 */
const test = require('node:test');
const assert = require('node:assert');

const catalogue = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const { capabilitiesForTier } = require('../src/role-tiers');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, sql, SKIP_REASON } = require('./helpers');

const cfg = config('holdmig');
const KEY = 'asset.hold_any';

test('the key is in the catalogue, and its default is a decision about leading a team', () => {
  assert.ok(catalogue.isPermission(KEY));
  const entry = catalogue.ALL.find((p) => p.key === KEY);
  assert.ok(entry, 'the key exists');
  assert.strictEqual(entry.label, 'Hold / Resume Any Visible Task');

  /* IMPLIED BY THE CAPABILITY, not by a group or a key list. The three
     assertions below are the whole of the default, stated as the catalogue
     states it. */
  assert.strictEqual(entry.impliedBy({ leadsTeam: true }), true);
  assert.strictEqual(entry.impliedBy({ leadsTeam: false }), false);
  assert.strictEqual(entry.impliedBy({ projectScope: 'all', manageSettings: true }), false,
    'full access does not carry it: studio-wide reach plus this key is every timer');
  /* AND THE SUPER ADMIN, named in the implication rather than arriving through
     the request-time short-circuit, so that baselineFor(super_admin) stays the
     complete catalogue — which tests/role-permissions.test.js asserts and which a
     key reaching them only through the short-circuit would quietly break. */
  assert.strictEqual(entry.impliedBy({ managePermissions: true }), true);

  /* AND THE EIGHT IT LANDS ON, named so that a catalogue change has an assertion
     to answer. Six in Supervision, the Associate Art Director — who carries the
     lead tier and runs a team — and the Super Admin. */
  const granted = ROLES
    .filter((r) => catalogue.baselineFor(capabilitiesForTier(r.tier) || {}).has(KEY))
    .map((r) => r.key).sort();
  assert.deepStrictEqual(granted, [
    'art_supervisor', 'associate_animation_supervisor', 'associate_art_director',
    'associate_team_lead', 'senior_team_lead', 'super_admin', 'team_lead',
    'technical_manager',
  ]);
  for (const key of granted) {
    assert.ok(rolePermissions.defaultsFor(key).has(KEY),
      `${key}'s seeded defaults include it`);
  }
  for (const key of ['game_artist', 'coordinator', 'head_of_production', 'art_director']) {
    assert.ok(!rolePermissions.defaultsFor(key).has(KEY),
      `${key}'s seeded defaults do not`);
  }
});

test('the migration seeds it, is idempotent, and never overrides a revoke',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let conn;
  let db;

  const step = (name) => {
    const found = require('../src/migrate').STEPS.find(([n]) => n === name);
    assert.ok(found, `there should be a "${name}" step, or startup would never run it`);
    return found[1];
  };

  /* ONLY THIS STEP, never migrate.run(). Running the whole list to reach one
     means dozens of DDL statements taking metadata locks on a server shared with
     every other suite, which measurably caused failures in unrelated ones. */
  const runStep = async () => {
    const said = [];
    await step('lead hold key')(db, (m) => said.push(m));
    return said;
  };

  const rowsFor = async (key) => new Map((await sql(cfg,
    'SELECT role_key AS r, enabled AS e, updated_by_email AS who '
    + 'FROM role_permissions WHERE permission_key = ? ORDER BY role_key', [key]))
    .map((r) => [r.r, { enabled: Number(r.e), who: r.who }]));

  t.before(async () => {
    await resetSchema(cfg);
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      database: cfg.database, multipleStatements: false,
    });
    db = { query: async (text, params) => {
      /* Ordered by APPEARANCE, the way src/db.js's translate() does it, and with
         array expansion for the IN list this step builds. */
      const values = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => {
        const v = (params || [])[Number(n) - 1];
        if (Array.isArray(v)) { values.push(...v); return v.map(() => '?').join(','); }
        values.push(v); return '?';
      });
      const [rows] = await conn.query(sqlText, values);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    } };

    /* A POPULATED DATABASE, built the way a real one is: every designation seeded
       at its defaults — which is what seedRole does on first use — but with the
       new key written OFF for everybody, which is the state this step exists for.
       Done by hand rather than by seeding and then switching off, so the fixture
       cannot accidentally be testing the seeder. */
    await conn.query(
      `CREATE TABLE IF NOT EXISTS role_permissions (
         role_key VARCHAR(64) NOT NULL,
         permission_key VARCHAR(64) NOT NULL,
         enabled TINYINT(1) NOT NULL DEFAULT 0,
         updated_by_email VARCHAR(190) NULL,
         updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
           ON UPDATE CURRENT_TIMESTAMP,
         PRIMARY KEY (role_key, permission_key))`
    );
    await conn.query('DELETE FROM role_permissions');
    for (const role of ROLES) {
      await conn.query(
        'INSERT INTO role_permissions (role_key, permission_key, enabled, updated_by_email) '
        + "VALUES (?, ?, 0, 'system')", [role.key, KEY]
      );
    }
  });

  t.after(async () => { if (conn) await conn.end(); });

  await t.test('before it runs, nobody has it — otherwise this proves nothing', async () => {
    const rows = await rowsFor(KEY);
    assert.strictEqual(rows.size, ROLES.length, 'a row per designation');
    assert.deepStrictEqual([...rows.values()].filter((v) => v.enabled).map((v) => v), []);
  });

  await t.test('it grants exactly the designations that run a team', async () => {
    const said = await runStep();
    const rows = await rowsFor(KEY);
    const on = [...rows.entries()].filter(([, v]) => v.enabled).map(([k]) => k).sort();
    assert.deepStrictEqual(on, [
      'art_supervisor', 'associate_animation_supervisor', 'associate_art_director',
      'associate_team_lead', 'senior_team_lead', 'super_admin', 'team_lead',
      'technical_manager',
    ]);
    assert.match(said.join('\n'), /Hold \/ Resume Any Visible Task granted to 8 designation/,
      'and says so in the startup log, naming them');
    assert.match(said.join('\n'), /team_lead/);

    /* AND NOBODY ELSE MOVED. A contributor, a coordinator and a full-access
       designation are all still off, which is the half of the default that keeps
       "what you can see you can hold" from meaning "the whole studio". */
    for (const key of ['game_artist', 'coordinator', 'head_of_production',
      'art_director', 'managing_director_ceo', 'producer', 'admin']) {
      assert.strictEqual(rows.get(key).enabled, 0, `${key} was not granted`);
    }
  });

  await t.test('running it again changes nothing, and says nothing', async () => {
    const before = await rowsFor(KEY);
    const said = await runStep();
    assert.deepStrictEqual(said, [],
      'a second run finds nothing to do, so it is silent — not "granted to 0"');
    const after = await rowsFor(KEY);
    assert.deepStrictEqual([...after.entries()].map(([k, v]) => [k, v.enabled]),
      [...before.entries()].map(([k, v]) => [k, v.enabled]));
  });

  await t.test('AN ADMIN\'S REVOKE SURVIVES EVERY RE-RUN', async () => {
    /* THE ASSERTION THIS FILE IS FOR. A Super Admin decides a Technical Manager
       should not be able to stop other people's timers and switches it off in
       Settings → Role Permissions, which stamps their email on the row. The next
       deploy must not quietly put it back.
     *
     * Two runs, because once is not the claim: the step has to be a no-op for
       this row for as long as the row says a person set it. */
    await conn.query(
      'UPDATE role_permissions SET enabled = 0, updated_by_email = ? '
      + 'WHERE permission_key = ? AND role_key = ?',
      ['boss@studio.test', KEY, 'technical_manager']
    );
    for (const pass of [1, 2]) {
      const said = await runStep();
      const rows = await rowsFor(KEY);
      assert.strictEqual(rows.get('technical_manager').enabled, 0,
        `pass ${pass}: the decision stands`);
      assert.strictEqual(rows.get('technical_manager').who, 'boss@studio.test',
        `pass ${pass}: and is still attributed to whoever made it`);
      assert.deepStrictEqual(said, [], `pass ${pass}: and the step is silent about it`);
      // The designations nobody touched are untouched too.
      assert.strictEqual(rows.get('team_lead').enabled, 1);
    }

    /* AND A ROW THE SYSTEM WROTE IS STILL FAIR GAME, which is what makes the
       distinction a distinction rather than "the step never does anything". */
    await conn.query(
      'UPDATE role_permissions SET enabled = 0, updated_by_email = ? '
      + 'WHERE permission_key = ? AND role_key = ?', ['system', KEY, 'senior_team_lead']
    );
    const said = await runStep();
    assert.match(said.join('\n'), /senior_team_lead/, 'a seeded row is topped up');
    assert.strictEqual((await rowsFor(KEY)).get('senior_team_lead').enabled, 1);
    /* A NULL updated_by_email counts as seeded too — rows written before the
       column existed have one, and treating them as decisions would make the
       step useless on exactly the oldest installs. */
    await conn.query(
      'UPDATE role_permissions SET enabled = 0, updated_by_email = NULL '
      + 'WHERE permission_key = ? AND role_key = ?', [KEY, 'art_supervisor']
    );
    await runStep();
    assert.strictEqual((await rowsFor(KEY)).get('art_supervisor').enabled, 1);
  });

  await t.test('a lead-like designation nobody marked is not granted', async () => {
    /* A STUDIO'S OWN DESIGNATION, added in Settings. "Art Team Lead — Outsource"
       reads like a lead and is filed under Supervision, and the step must still
       leave it alone: what decides is the capability its TIER carries, and a
       designation in the contributor tier runs no team however it is named. This
       is the assertion that the rule is not a name match — the thing the fourth
       report asked for in as many words. */
    await conn.query(
      'INSERT INTO role_permissions (role_key, permission_key, enabled, updated_by_email) '
      + "VALUES (?, ?, 0, 'system')", ['art_team_lead_outsource', KEY]
    );
    const said = await runStep();
    assert.ok(!said.join('\n').includes('art_team_lead_outsource'),
      'a designation the catalogue does not know is not granted anything');
    assert.strictEqual((await rowsFor(KEY)).get('art_team_lead_outsource').enabled, 0);
  });
});
