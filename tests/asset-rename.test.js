/* RENAMING AN ASSET, END TO END.
 *
 * What this suite is really asserting, in one sentence: an asset's NAME is a
 * label and its ID is its identity, so changing the label must change what
 * every live screen says and must change nothing else at all — not a timer, not
 * an assignment, not a timesheet line, not a submission link, not a file, and
 * not a word of anything already written down.
 *
 * The static half of the feature (the one shared validator, the page's copy of
 * it, the transaction, the permission defaults) is in tests/asset-name.test.js.
 * This file is the live one: a real server, a real database, five designations
 * and the switch.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const { config, resetSchema, startServer, stopServer, api, sql, systemClientId,
  openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('assetrename');
const PASSWORD = 'Rename-Test-1!';

test('renaming an asset', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const people = {};
  let clientId;
  let projectA;
  let projectB;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const q = (statement, params) => sql(cfg, statement, params);

  const newAsset = async (who, projectId, name, assigneeId) => {
    const res = await as(who, `/assets/project/${projectId}`, {
      method: 'POST',
      body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  };
  const rename = (who, id, name, expected) => as(who, `/assets/${id}/name`, {
    method: 'PATCH',
    body: { name, ...(expected === undefined ? {} : { expected_name: expected }) },
  });
  const nameOf = async (id) => (await q('SELECT `name` FROM assets WHERE id = ?', [id]))[0].name;
  const historyOf = (id) => q(
    'SELECT * FROM asset_name_history WHERE asset_id = ? ORDER BY seq', [id]
  );
  const logFor = (id) => q(
    "SELECT * FROM activity_log WHERE entity_id = ? AND action = 'asset.rename' ORDER BY seq", [id]
  );
  /* The studio switch, moved the way a Super Admin moves it rather than by a
     hand-written UPDATE: the route is what the browser calls, and a test that
     wrote the row directly would not notice the route refusing. */
  const setSwitch = async (on) => {
    const res = await as('root', '/admin/settings/asset-names', {
      method: 'PUT', body: { renameEnabled: on },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  // A role's enabled keys, and a way to put one back or take one away.
  const keysOf = async (role) => (await as('root', `/permissions/roles/${role}`))
    .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  const setKeys = async (role, keys, extra = {}) => {
    const res = await as('root', `/permissions/roles/${role}`, {
      method: 'PUT', body: { permissions: keys, ...extra },
    });
    assert.ok(res.status < 400, JSON.stringify(res.body));
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'rename-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'rename-token', name: 'Root', email: 'root@rename.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@rename.test');
    people.root = (await as('root', '/auth/me')).body.user.id;
    await openStudio(server.base, token.root);

    clientId = await systemClientId(server.base, token.root);
    projectA = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;
    projectB = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Far Shore' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['lee', 'team_lead'],
      ['ana', 'game_artist'], ['dir', 'art_director']]) {
      const res = await call('/users', { token: token.root, method: 'POST',
        body: { name: who, email: `${who}@rename.test`, role, password: PASSWORD, projectId: projectA } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@rename.test`);
    }
    await as('root', `/users/${people.ana}`, { method: 'PATCH',
      body: { reportsToId: people.lee, teamLeadId: people.lee } });
  });

  t.after(() => stopServer(server));

  /* ---- the switch and the key ------------------------------------------ */

  await t.test('the switch ships on, and the Settings screen reads it', async () => {
    const res = await as('root', '/admin/settings/asset-names');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.settings.renameEnabled, true,
      'a fresh installation can edit a name without anybody switching anything on');
    assert.strictEqual(res.body.renames, 0, 'and nothing has been renamed yet');
    assert.strictEqual(res.body.lastRenameAt, null);

    // And /auth/me carries it, which is what the pencil is drawn from.
    for (const who of ['root', 'pat', 'ana', 'dir']) {
      assert.strictEqual((await as(who, '/auth/me')).body.assetRenameEnabled, true,
        `${who}'s page is told the switch is on`);
    }
  });

  await t.test('only a Super Admin may move the switch', async () => {
    for (const who of ['pat', 'lee', 'ana', 'dir']) {
      assert.strictEqual((await as(who, '/admin/settings/asset-names')).status, 403,
        `${who} cannot read the switch`);
      assert.strictEqual((await as(who, '/admin/settings/asset-names', {
        method: 'PUT', body: { renameEnabled: false },
      })).status, 403, `${who} cannot move it`);
    }
  });

  await t.test('the designations that may edit an asset may rename one; the others may not',
    async () => {
      const asset = await newAsset('root', projectA, 'Hero', people.ana);

      /* CREATIVE DIRECTION holds no asset-editing key by design — direction is
         recorded as feedback — and it sees every project in the studio. So it
         is the clean test of the KEY on its own: scope cannot be the reason. */
      const refused = await rename('dir', asset.id, 'Hero Redux');
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual(await nameOf(asset.id), 'Hero', 'and nothing moved');
      assert.strictEqual((await as('dir', `/assets/${asset.id}/name-history`)).status, 403,
        'nor may they read what it has been called');

      // A lead, a producer and the Super Admin all hold it.
      assert.strictEqual((await rename('lee', asset.id, 'Hero A')).status, 200);
      assert.strictEqual((await rename('pat', asset.id, 'Hero B')).status, 200);
      assert.strictEqual((await rename('root', asset.id, 'Hero C')).status, 200);
      /* AND SO DOES THE ARTIST IT IS ASSIGNED TO. A contributor's visibility is
         their own work — canViewAsset — so the key reaches the asset on their
         desk and no other. That is the narrowest useful grant and it is the
         default, because a typo is usually found by whoever is working on it. */
      assert.strictEqual((await rename('ana', asset.id, 'Hero D')).status, 200);
      assert.strictEqual(await nameOf(asset.id), 'Hero D');
    });

  await t.test('project scope still applies: an asset out of reach is 403', async () => {
    // projectB exists and pat is attached to projectA only.
    const far = await newAsset('root', projectB, 'Far Thing');
    const res = await rename('pat', far.id, 'Nearer Thing');
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'No access to this asset',
      'the same sentence every other asset route uses for out of reach');
    assert.strictEqual(await nameOf(far.id), 'Far Thing');
    assert.strictEqual((await as('pat', `/assets/${far.id}/name-history`)).status, 403);

    // An asset that does not exist at all is 404, not 403 — the two answers are
    // different questions and must not be confused.
    assert.strictEqual((await rename('root', crypto.randomUUID(), 'Nothing')).status, 404);

    /* AND A CONTRIBUTOR WHO IS NOT THE ASSIGNEE IS REFUSED, in reach or not:
       they cannot see it, so they cannot rename it. */
    const notHers = await newAsset('root', projectA, 'Someone Else\'s', people.lee);
    assert.strictEqual((await rename('ana', notHers.id, 'Mine Now')).status, 403);
  });

  await t.test('the Super Admin keeps the key even after the role has been written', async () => {
    /* The failure this guards against is the one Prompt 62 hit: a role whose
       row in role_permissions predates a new catalogue key. effectiveFor()
       returns the whole catalogue for the Super Admin tier before it reads a
       stored row, and topUpRole() seeds the key for everybody else. */
    await q('DELETE FROM role_permissions WHERE role_key = ?', ['super_admin']);
    await q(
      `INSERT INTO role_permissions (role_key, permission_key, enabled, updated_by_email)
       VALUES ('super_admin', 'asset.edit', 1, 'test')`
    );
    const asset = await newAsset('root', projectA, 'Still Mine', people.ana);
    assert.strictEqual((await rename('root', asset.id, 'Still Mine, Renamed')).status, 200,
      'a Super Admin can never be missing a catalogue key');
    assert.strictEqual((await as('root', '/admin/settings/asset-names')).status, 200);
  });

  await t.test('an Acting Team Lead follows the key, not the position', async () => {
    const asset = await newAsset('root', projectA, 'Acting Subject', people.ana);
    // Ana is named Acting Team Lead on the project she already works on.
    const patched = await as('root', `/projects/${projectA}`, {
      method: 'PATCH', body: { actingTeamLeadIds: [people.ana] },
    });
    assert.ok(patched.status < 400, JSON.stringify(patched.body));

    // With the key, she may rename the asset on her desk.
    assert.strictEqual((await rename('ana', asset.id, 'Acting One')).status, 200);

    // Take the key off her designation. Being Acting TL is not a substitute.
    const held = await keysOf('game_artist');
    assert.ok(held.includes('assets.rename'), 'an artist holds it by default');
    await setKeys('game_artist', held.filter((k) => k !== 'assets.rename'));
    try {
      const refused = await rename('ana', asset.id, 'Acting Two');
      assert.strictEqual(refused.status, 403,
        'standing in for a lead does not grant a permission the designation lacks');
      assert.strictEqual(await nameOf(asset.id), 'Acting One');
      assert.strictEqual((await as('ana', `/assets/${asset.id}/name-history`)).status, 403);
    } finally {
      await setKeys('game_artist', held);
    }
    assert.strictEqual((await rename('ana', asset.id, 'Acting Three')).status, 200,
      'and putting the key back puts the ability back');
    await as('root', `/projects/${projectA}`, { method: 'PATCH', body: { actingTeamLeadIds: [] } });
  });

  await t.test('with the switch off the server refuses, and the page is told', async () => {
    const asset = await newAsset('root', projectA, 'Switched', people.ana);
    const before = (await historyOf(asset.id)).length;
    await setSwitch(false);
    try {
      for (const who of ['root', 'pat', 'lee', 'ana']) {
        const res = await rename(who, asset.id, `Switched by ${who}`);
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rename_disabled');
      }
      assert.strictEqual(await nameOf(asset.id), 'Switched');
      assert.deepStrictEqual((await historyOf(asset.id)).length, before);
      // Every open page is told within its next poll.
      assert.strictEqual((await as('ana', '/auth/me')).body.assetRenameEnabled, false);

      /* THE HISTORY STAYS READABLE. Switching the feature off stops new
         renames; it does not hide the ones already made. */
      const earlier = (await as('root', `/assets/${asset.id}/name-history`));
      assert.strictEqual(earlier.status, 200, JSON.stringify(earlier.body));
    } finally {
      await setSwitch(true);
    }
    assert.strictEqual((await rename('root', asset.id, 'Switched Back')).status, 200);
    // And the switch's own move is in the studio's Activity Log, by name.
    const entries = await q(
      "SELECT * FROM activity_log WHERE action = 'settings.asset_rename' ORDER BY seq"
    );
    assert.ok(entries.length >= 2, 'both moves are recorded');
    assert.match(entries[entries.length - 1].summary, /Asset name editing is now on \(was off\)/);
    assert.strictEqual(entries[0].entity_label, 'Asset Name Editing');
  });

  /* ---- what a rename does, and what it writes -------------------------- */

  await t.test('a rename writes the name, one history row and one audit line', async () => {
    const asset = await newAsset('root', projectA, 'Waterfall', people.ana);
    const res = await rename('pat', asset.id, '  Waterfall   Spray FX  ', 'Waterfall');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    // NORMALISED, by the same function creation uses.
    assert.strictEqual(res.body.name, 'Waterfall Spray FX');
    assert.strictEqual(res.body.changed, true);
    assert.strictEqual(res.body.asset.name, 'Waterfall Spray FX', 'the response carries the asset');
    assert.strictEqual(await nameOf(asset.id), 'Waterfall Spray FX');

    const history = await historyOf(asset.id);
    assert.strictEqual(history.length, 1, 'exactly one row, not two and not none');
    assert.strictEqual(history[0].old_name, 'Waterfall');
    assert.strictEqual(history[0].new_name, 'Waterfall Spray FX');
    assert.strictEqual(history[0].changed_by_user_id, people.pat);
    assert.strictEqual(history[0].changed_by_email, 'pat@rename.test');
    assert.ok(history[0].changed_at, 'and it is stamped');

    const log = await logFor(asset.id);
    assert.strictEqual(log.length, 1, 'one audit line');
    assert.strictEqual(log[0].module, 'assets');
    assert.match(log[0].summary, /Renamed .* from "Waterfall" to "Waterfall Spray FX"/);
    assert.deepStrictEqual(JSON.parse(log[0].changes),
      { name: { from: 'Waterfall', to: 'Waterfall Spray FX' } });
    /* THE LABEL IS THE OLD NAME, on purpose: activity_log.entity_label is a
       snapshot, and an entry that renamed itself could never answer "what was
       it called then". */
    assert.strictEqual(log[0].entity_label, `${asset.code} Waterfall`);
    assert.strictEqual(log[0].actor_id, people.pat);
  });

  await t.test('a rename that changes nothing writes nothing at all', async () => {
    const asset = await newAsset('root', projectA, 'Unchanged', people.ana);
    const logsBefore = (await q('SELECT COUNT(*) AS n FROM activity_log'))[0].n;

    for (const attempt of ['Unchanged', '  Unchanged  ', 'Unchanged\t', 'Unchanged   ']) {
      const res = await rename('pat', asset.id, attempt, 'Unchanged');
      assert.strictEqual(res.status, 200, `${JSON.stringify(attempt)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.changed, false, `${JSON.stringify(attempt)} changed nothing`);
      assert.strictEqual(res.body.name, 'Unchanged');
    }
    assert.strictEqual((await historyOf(asset.id)).length, 0, 'no history row');
    assert.strictEqual((await logFor(asset.id)).length, 0, 'no rename audit line');
    assert.strictEqual(Number((await q('SELECT COUNT(*) AS n FROM activity_log'))[0].n),
      Number(logsBefore), 'and not even the middleware\'s own backstop entry');
    assert.strictEqual(await nameOf(asset.id), 'Unchanged');
  });

  await t.test('a change of case only is a real change', async () => {
    const asset = await newAsset('root', projectA, 'Hero Prop', people.ana);
    const res = await rename('pat', asset.id, 'HERO PROP', 'Hero Prop');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.changed, true, 'case matters: it is a different label');
    assert.strictEqual(await nameOf(asset.id), 'HERO PROP');
    assert.strictEqual((await historyOf(asset.id)).length, 1);
  });

  await t.test('an invalid name is refused with the shared sentence, and changes nothing', async () => {
    const assetName = require('../src/asset-name');
    const asset = await newAsset('root', projectA, 'Valid', people.ana);
    for (const [bad, message] of [
      ['', assetName.MESSAGES.required],
      ['   ', assetName.MESSAGES.required],
      ['\t\n ', assetName.MESSAGES.required],
      [null, assetName.MESSAGES.required],
      ['\u0001\u0002', assetName.MESSAGES.required],
      ['x'.repeat(256), assetName.MESSAGES.tooLong],
    ]) {
      const res = await rename('pat', asset.id, bad, 'Valid');
      assert.strictEqual(res.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.error, message, 'the module\'s own sentence');
      assert.strictEqual(res.body.field, 'name');
    }
    assert.strictEqual(await nameOf(asset.id), 'Valid');
    assert.strictEqual((await historyOf(asset.id)).length, 0);

    /* AND CREATION REFUSES THE SAME THINGS THE SAME WAY — which is the whole
       point of the shared module, asserted against the live route rather than
       against its source. */
    for (const [bad, message] of [['   ', assetName.MESSAGES.required],
      ['x'.repeat(256), assetName.MESSAGES.tooLong]]) {
      const res = await as('root', `/assets/project/${projectA}`, {
        method: 'POST', body: { name: bad, type: 'character' },
      });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error, message);
    }
  });

  await t.test('a duplicate name is accepted, exactly as creating one is', async () => {
    /* THERE IS NO UNIQUENESS RULE on an asset's name — no unique key, no check
       at creation, none in the bulk import. So the rename has none either: a
       studio with two assets already called the same thing must not find one of
       them unrenameable for ever. The CODE is the per-project reference, and it
       never changes. */
    const first = await newAsset('root', projectA, 'Twin', people.ana);
    const second = await newAsset('root', projectA, 'Other', people.ana);
    // Creation itself takes a duplicate, which is what makes this the rule.
    const third = await newAsset('root', projectA, 'Twin', people.ana);
    assert.strictEqual(third.name, 'Twin');
    assert.notStrictEqual(third.code, first.code, 'two assets, two codes');

    assert.strictEqual((await rename('pat', second.id, 'Twin', 'Other')).status, 200,
      'renaming to a name another asset in the project already has is allowed');
    assert.strictEqual(await nameOf(second.id), 'Twin');

    // Differing only in case, same project.
    const fourth = await newAsset('root', projectA, 'Fourth', people.ana);
    assert.strictEqual((await rename('pat', fourth.id, 'TWIN', 'Fourth')).status, 200);

    // And a name another PROJECT uses, which was never going to collide.
    const far = await newAsset('root', projectB, 'Twin', people.lee);
    assert.strictEqual((await rename('root', far.id, 'Twin Over Here', 'Twin')).status, 200);

    /* SELF-EXCLUDED, which is what a uniqueness check would have broken: an
       asset whose name is already shared with another one can still be renamed
       to something else, and can still be asked to keep its own name. */
    assert.strictEqual((await rename('pat', second.id, 'Twin', 'Twin')).body.changed, false);
    assert.strictEqual((await rename('pat', second.id, 'Not A Twin', 'Twin')).status, 200);
  });

  /* ---- two people, one asset ------------------------------------------- */

  await t.test('a stale form is refused with what the name says now, and by whom', async () => {
    const asset = await newAsset('root', projectA, 'Contested', people.ana);
    // Lee renames it while Pat's panel still says "Contested".
    assert.strictEqual((await rename('lee', asset.id, 'Lee Was Here', 'Contested')).status, 200);

    const stale = await rename('pat', asset.id, 'Pat Was Here', 'Contested');
    assert.strictEqual(stale.status, 409, JSON.stringify(stale.body));
    assert.strictEqual(stale.body.code, 'name_changed');
    assert.strictEqual(stale.body.currentName, 'Lee Was Here');
    assert.strictEqual(stale.body.changedByName, 'lee', 'and who changed it');
    assert.ok(stale.body.changedAt, 'and when');

    // NOTHING CHANGED. Not the name, not the history, not the log.
    assert.strictEqual(await nameOf(asset.id), 'Lee Was Here');
    assert.strictEqual((await historyOf(asset.id)).length, 1);
    assert.strictEqual((await logFor(asset.id)).length, 1);

    // With the current name in hand, the same request goes through.
    assert.strictEqual((await rename('pat', asset.id, 'Pat Was Here', 'Lee Was Here')).status, 200);
    assert.strictEqual((await historyOf(asset.id)).length, 2);

    // A caller that sends no expected_name is not checked — a script, or a
    // first write from a form that has nothing to compare.
    assert.strictEqual((await rename('pat', asset.id, 'No Expectation')).status, 200);
  });

  await t.test('two renames at once leave one consistent state', async () => {
    const asset = await newAsset('root', projectA, 'Race', people.ana);
    const results = await Promise.all([
      rename('pat', asset.id, 'Pat Won', 'Race'),
      rename('lee', asset.id, 'Lee Won', 'Race'),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const conflicted = results.filter((r) => r.status === 409);
    /* EITHER ONE WINS AND ONE IS TOLD, OR BOTH LAND IN ORDER — both are
       consistent outcomes, and which one happens depends on how the two
       requests interleave. What must never happen is a name that matches
       neither, or a history that does not account for the name. */
    assert.strictEqual(ok.length + conflicted.length, 2, JSON.stringify(results));
    const finalName = await nameOf(asset.id);
    const history = await historyOf(asset.id);
    assert.strictEqual(history.length, ok.length, 'one history row per rename that happened');
    assert.strictEqual(history[history.length - 1].new_name, finalName,
      'and the last row says what the asset is called');
    assert.ok(['Pat Won', 'Lee Won'].includes(finalName), finalName);
    assert.strictEqual(history[0].old_name, 'Race', 'the chain starts where the asset did');
    for (let i = 1; i < history.length; i++) {
      assert.strictEqual(history[i].old_name, history[i - 1].new_name,
        'and every row picks up where the one before it left off');
    }
  });

  /* ---- the history list ------------------------------------------------ */

  await t.test('the history reads newest first, with who and when', async () => {
    const asset = await newAsset('root', projectA, 'One', people.ana);
    const fresh = await as('root', `/assets/${asset.id}/name-history`);
    assert.strictEqual(fresh.status, 200);
    assert.deepStrictEqual(fresh.body.history, [], 'an asset nobody renamed has no history');
    assert.strictEqual(fresh.body.name, 'One');
    assert.strictEqual(fresh.body.code, asset.code);

    await rename('pat', asset.id, 'Two', 'One');
    await rename('lee', asset.id, 'Three', 'Two');
    const res = await as('lee', `/assets/${asset.id}/name-history`);
    assert.strictEqual(res.body.name, 'Three');
    assert.deepStrictEqual(res.body.history.map((h) => [h.oldName, h.newName, h.changedBy]),
      [['Two', 'Three', 'lee'], ['One', 'Two', 'pat']]);
    assert.ok(res.body.history.every((h) => h.changedAt), 'each row is stamped');
  });

  /* ---- the asset is the same asset ------------------------------------- */

  await t.test('nothing but the name moves: timer, assignment, status, lines, link, files',
    async () => {
      const asset = await newAsset('root', projectA, 'Before', people.ana);

      // A real round: start the clock, file an hour, submit with a link.
      assert.strictEqual((await as('ana', `/assets/${asset.id}/start`, { method: 'POST' })).status, 200);
      /* THE LINE IS WRITTEN DIRECTLY. Filing one through the form requires
         recorded work on that very day against that very asset — a rule this
         suite is not testing and would have to fake the clock to satisfy. What
         matters here is that the ROW survives a rename untouched. */
      await q(
        `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id, hours)
         VALUES (?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), people.ana, '2026-03-02', clientId, projectA, asset.id, 2]
      );
      const submitted = await as('ana', `/assets/${asset.id}/submit`, { method: 'POST',
        body: { link: 'https://example.test/before-v1', description: 'First pass' } });
      assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
      // A reference to a file on the office server, so there is a stored path
      // to compare before and after.
      await q(
        `INSERT INTO server_submission_files (id, asset_id, user_id, relative_path, \`name\`, size)
         VALUES (?,?,?,?,?,?)`,
        [crypto.randomUUID(), asset.id, people.ana,
          'Nightgarden/Art/Ana/before-v1.psd', 'before-v1.psd', 4096]
      );

      const snapshot = async () => {
        const row = (await q(
          `SELECT id, \`code\`, \`type\`, \`status\`, priority, project_id, assignee_id, routed_to_id,
                  created_by, man_hours, due_date, start_date, description, created_at
             FROM assets WHERE id = ?`, [asset.id]
        ))[0];
        return {
          asset: row,
          sessions: await q('SELECT id, asset_id, user_id, round, seconds FROM work_sessions WHERE asset_id = ? ORDER BY id', [asset.id]),
          assignments: await q('SELECT id, asset_id, user_id, status_at_assignment, ended_status FROM asset_assignments WHERE asset_id = ? ORDER BY id', [asset.id]),
          versions: await q('SELECT id, asset_id, link, version_number, file_path, file_name FROM asset_versions WHERE asset_id = ? ORDER BY id', [asset.id]),
          events: await q('SELECT id, action, from_status, to_status FROM asset_events WHERE asset_id = ? ORDER BY seq', [asset.id]),
          lines: await q('SELECT id, asset_id, hours, entry_date FROM timesheet_entries WHERE asset_id = ? ORDER BY id', [asset.id]),
          tasks: await q('SELECT id, `name`, done FROM tasks WHERE asset_id = ? ORDER BY `position`', [asset.id]),
          files: await q('SELECT id, relative_path, `name`, size FROM server_submission_files WHERE asset_id = ? ORDER BY id', [asset.id]),
        };
      };

      const before = await snapshot();
      assert.ok(before.sessions.length, 'the clock ran');
      assert.ok(before.versions.length, 'there is a submission');
      assert.ok(before.lines.length, 'there is a timesheet line');
      assert.ok(before.files.length, 'and a stored file reference');

      assert.strictEqual((await rename('pat', asset.id, 'After', 'Before')).status, 200);

      const after = await snapshot();
      /* THE ONE DIFFERENCE IS THE NAME, and the name is not in this snapshot —
         so these two objects must be identical, field for field, row for row. */
      assert.deepStrictEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)),
        'a rename changes the name and nothing else about the asset');
      assert.strictEqual(after.asset.code, before.asset.code, 'the code is the reference');
      assert.strictEqual(await nameOf(asset.id), 'After');

      /* THE STORED PATH IS BYTE-IDENTICAL, which is the promise the modal makes
         out loud: "Files already stored are not renamed or moved." */
      assert.strictEqual(after.files[0].relative_path, 'Nightgarden/Art/Ana/before-v1.psd');
      // And the submission link still points where the artist put it.
      assert.strictEqual(after.versions[0].link, 'https://example.test/before-v1');
    });

  await t.test('a delivered asset can still be renamed', async () => {
    const asset = await newAsset('root', projectA, 'Shipped', people.ana);
    await q("UPDATE assets SET `status` = 'delivered' WHERE id = ?", [asset.id]);
    const res = await rename('pat', asset.id, 'Shipped, Corrected', 'Shipped');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((await q('SELECT `status` FROM assets WHERE id = ?', [asset.id]))[0].status,
      'delivered', 'and it is still delivered');
    assert.strictEqual((await historyOf(asset.id)).length, 1);

    // Every other workflow status too — a correction is never out of season.
    for (const status of ['not_started', 'assigned', 'in_progress', 'pending_tl_review',
      'tl_changes_requested', 'tl_approved', 'pending_cd_review', 'cd_changes_requested',
      'approved_for_client', 'awaiting_client_feedback', 'game_feedback']) {
      await q('UPDATE assets SET `status` = ? WHERE id = ?', [status, asset.id]);
      const r = await rename('pat', asset.id, `Named in ${status}`);
      assert.strictEqual(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
    }
  });

  await t.test('a closed project finishes nothing, a rename included', async () => {
    const asset = await newAsset('root', projectB, 'In A Closed Project', people.lee);
    const closed = await as('root', `/projects/${projectB}/close`, { method: 'POST',
      body: { reason: 'Finished' } });
    if (closed.status >= 400) {
      // Some installs close through PATCH; either way the point is the refusal.
      await q('UPDATE projects SET closed_at = NOW() WHERE id = ?', [projectB]);
    }
    const res = await rename('root', asset.id, 'Too Late');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.projectClosed, true,
      'the same refusal every other write to an asset in a closed project gets');
    assert.strictEqual(await nameOf(asset.id), 'In A Closed Project');
  });

  /* ---- every live screen says the new name ----------------------------- */

  await t.test('every live screen reads the name by id, so all of them move at once',
    async () => {
      const asset = await newAsset('root', projectA, 'Old Label', people.ana);
      assert.strictEqual((await as('ana', `/assets/${asset.id}/start`, { method: 'POST' })).status, 200);
      await q(
        `INSERT INTO timesheet_entries (id, user_id, entry_date, client_id, project_id, asset_id, hours)
         VALUES (?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), people.ana, '2026-03-03', clientId, projectA, asset.id, 3]
      );
      /* THE DAY IS SUBMITTED, because the download joins timesheet_days and
         leaves an unsubmitted day out — see src/timesheet-export.js. Without
         this the spreadsheet has headers and nothing else, which is how this
         assertion failed on its first run. */
      await q(
        `INSERT INTO timesheet_days (id, user_id, work_date, \`status\`, submitted_at)
         VALUES (?,?,?,'submitted',NOW())`,
        [crypto.randomUUID(), people.ana, '2026-03-03']
      );
      assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, { method: 'POST',
        body: { link: 'https://example.test/old-label', description: 'A pass' } })).status, 201);
      // The Artist Report counts tracked seconds, so give it some.
      await q(
        `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
         VALUES (?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), asset.id, people.ana, 1, '2026-03-03 10:00:00', '2026-03-03 12:00:00', 7200]
      );

      const screens = async () => ({
        board: (await as('root', `/assets/project/${projectA}`)).body.assets
          .find((a) => a.id === asset.id).name,
        drawer: (await as('root', `/assets/project/${projectA}`)).body.assets
          .find((a) => a.id === asset.id).name,
        lines: (await as('root', `/timesheets/week?date=2026-03-03&userId=${people.ana}`))
          .body.days.flatMap((d) => d.entries || [])
          .filter((e) => e.assetId === asset.id).map((e) => e.assetName),
        /* A WIDE RANGE on purpose: the submission is stamped NOW, whenever this
           suite runs, and the Artist Report is one row per submission. */
        artistReport: (await as('root', '/reports/artist?from=2020-01-01&to=2099-12-31'))
          .body.rows.filter((r) => r.assetId === asset.id).map((r) => r.assetName),
        /* THE REVIEW QUEUE, as the lead who holds that gate sees it. The board
           and the queues are one query — ASSET_SELECT is `SELECT a.*` — so this
           is the same row the TL Review column draws from. */
        reviewQueue: (await as('lee', `/assets/project/${projectA}`)).body.assets
          .filter((a) => a.id === asset.id && a.status === 'pending_tl_review')
          .map((a) => a.name),
        /* THE TIMESHEET DOWNLOAD, as a real spreadsheet: fetched from the route
           and parsed, so what the file says is asserted rather than assumed. */
        download: await (async () => {
          const res = await fetch(`${server.base}/timesheet/export?from=2026-03-01&to=2026-03-31`, {
            headers: { Authorization: `Bearer ${token.root}` },
          });
          // The body can only be read once, so take the bytes first and only
          // then decide whether to complain about the status.
          const bytes = Buffer.from(await res.arrayBuffer());
          assert.strictEqual(res.status, 200, bytes.toString('utf8').slice(0, 300));
          const book = XLSX.read(bytes, { type: 'buffer' });
          const sheet = book.Sheets[book.SheetNames[0]];
          return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false })
            .flat().filter((cell) => typeof cell === 'string');
        })(),
      });

      const before = await screens();
      assert.strictEqual(before.board, 'Old Label');
      assert.deepStrictEqual(before.lines, ['Old Label'], 'the timesheet lines list');
      assert.deepStrictEqual(before.artistReport, ['Old Label'], 'the Artist Report');
      assert.deepStrictEqual(before.reviewQueue, ['Old Label'], 'the lead\'s review queue');
      assert.ok(before.download.includes('Old Label'), 'and the downloaded spreadsheet');

      assert.strictEqual((await rename('pat', asset.id, 'New Label', 'Old Label')).status, 200);

      const after = await screens();
      assert.strictEqual(after.board, 'New Label', 'the board and the Assets List');
      assert.deepStrictEqual(after.lines, ['New Label'], 'the timesheet lines list');
      assert.deepStrictEqual(after.artistReport, ['New Label'], 'the Artist Report');
      assert.deepStrictEqual(after.reviewQueue, ['New Label'], 'the lead\'s review queue');
      /* THE SPREADSHEET SAYS THE NEW NAME AND NO LONGER SAYS THE OLD ONE —
         which is what makes a download agree with the screen somebody used to
         decide to make it. */
      assert.ok(after.download.includes('New Label'), 'the downloaded spreadsheet');
      assert.ok(!after.download.includes('Old Label'),
        'and nothing in it still says what the asset used to be called');
    });

  await t.test('what was already written keeps the old name', async () => {
    // Created BY pat: PATCH /assets/:id is ownership-bound (asset.edit), which
    // the rename deliberately is not — see the catalogue entry.
    const asset = await newAsset('pat', projectA, 'As Written', people.ana);
    // An action BEFORE the rename, which snapshots the name into its label.
    assert.strictEqual((await as('pat', `/assets/${asset.id}`, { method: 'PATCH',
      body: { description: 'A brief' } })).status, 200);
    const labelsBefore = (await q(
      'SELECT entity_label, action FROM activity_log WHERE entity_id = ? ORDER BY seq', [asset.id]
    )).map((r) => r.entity_label);
    assert.ok(labelsBefore.some((l) => l && l.includes('As Written')),
      `expected a label naming the asset, got ${JSON.stringify(labelsBefore)}`);

    assert.strictEqual((await rename('pat', asset.id, 'As Renamed', 'As Written')).status, 200);

    const labelsAfter = (await q(
      'SELECT entity_label, action FROM activity_log WHERE entity_id = ? ORDER BY seq', [asset.id]
    )).map((r) => r.entity_label);
    /* NOT ONE OF THEM WAS REWRITTEN. The entries that existed before the rename
       still say what the asset was called when they were written, including the
       rename's own entry — see the route's note on entity_label. */
    assert.deepStrictEqual(labelsAfter.slice(0, labelsBefore.length), labelsBefore,
      'a rename rewrites no history');
    assert.ok(!labelsAfter.some((l) => l && l.includes('As Renamed')),
      'and writes no entry claiming the new name was there all along');
  });
});
