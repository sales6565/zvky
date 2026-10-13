/* The Hold button, and whether the screen and the server ask the same question.
 *
 * WHY THIS SUITE EXISTS. The gap closed in the Game Feedback work had a shape worth
 * hunting for elsewhere: a rule written twice, once on the server and once on the page,
 * where the page's copy consulted something staler than the server's. public/index.html
 * carries a note about exactly this failure appearing three times — Settings, the Users
 * tab, the Add Project button — "always the same way: a screen asked caps() (the role's
 * TIER) about something the API decides from the role's PERMISSIONS. Switching a permission
 * on does not move the tier, so the API allowed the action and the app never offered it."
 *
 * Hold is a candidate because it is gated in both places. What is pinned here is that the
 * two cannot come apart: the permission is switched off and on in Settings, and after each
 * change BOTH the server's answer and the list the page gates on are read. A page that had
 * been written against the tier would keep the button after a revoke, or withhold it after
 * a grant, and one of these assertions would say so.
 *
 * ON THE SCENARIO THIS WAS ASKED FOR — "granted to the user but not held by role default".
 * That cannot be built in this application, for two reasons found in the code rather than
 * assumed, and both are asserted below so the suite says so out loud rather than quietly
 * testing something else:
 *
 *   PER-USER GRANTS DO NOT EXIST. src/role-permissions.js opens with "Every user's
 *   permissions come from their role: one lookup by role key, no per-user rows", and
 *   src/migrate.js DROPS user_permissions and permission_audit on startup — "per-user
 *   permission grants were replaced by role permissions". There is nothing to override a
 *   role default with.
 *
 *   AND asset.hold IS HELD BY EVERY ROLE BY DEFAULT: its catalogue entry is
 *   `impliedBy: () => true`. So no designation lacks it until a Super Admin turns it off.
 *
 * The nearest thing that IS constructible is the same question in both directions, and it
 * is the one that matters: a designation whose configured permissions differ from the
 * default — revoked, then granted again — and whether the button follows the configuration.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../src/permission-catalog');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('holdperm');
const PASSWORD = 'HoldPerm-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the premises, read off the source ---------------------------------------

test('the two gates name the same permission, and the page reads the configured set', () => {
  /* THE PAIRING. The server route is behind requirePermission('asset.hold'), which reads
     req.permissions; src/middleware/auth.js fills that from rolePermissions.effectiveFor()
     and ships the same list to the browser as user.permissions. The page's perms() reads
     that list. So both sides resolve the same key against the same source, and this checks
     it by reading each of them rather than by trusting the chain. */
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  for (const verb of ['hold', 'resume']) {
    assert.match(route, new RegExp(`router\\.post\\('/:id/${verb}', requirePermission\\('asset\\.hold'\\)`),
      `POST /${verb} is gated on asset.hold`);
  }

  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
  assert.match(auth, /rolePermissions\.effectiveFor\(db, user\.role\)/,
    'the server resolves the configured set, not the tier');
  assert.match(auth, /user\.permissions = \[\.\.\.held\]/,
    'and hands the SAME set to the browser');

  /* The page's gate. can() over perms(), which is that list — NOT caps(), which is the
     tier and is what the three bugs the page's own comment describes all reached for. */
  /* WIDENED THREE TIMES SINCE THIS WAS WRITTEN, and the pin follows rather than being
     deleted. It was `mine && can('asset.hold')`; then `(mine || can_hold_others) &&
     can('asset.hold')` when designations on their own projects were added; then the server
     decided both controls and the page kept a mine-only FALLBACK for an undecorated row.

     THE FALLBACK IS NOW GONE TOO, which is the fourth report's doing: it was a fourth copy
     of the rule, right for the assignee and silently wrong for their lead. So the page asks
     asset.hold NOWHERE — which is the strongest form of this file's point rather than a
     weakening of it. The two gates cannot disagree about a permission only one of them
     consults, and the page cannot be the one that is wrong. */
  assert.match(PAGE, /const hs = a\.hold_state \|\| UNKNOWN_HOLD_STATE;/,
    'the page reads the server\'s answer, or says it has none');
  assert.match(PAGE, /const canHold = hs\.canHold;/, 'and never computes one');
  assert.match(PAGE, /function perms\(\)\{ return \(state\.currentUser && state\.currentUser\.permissions\) \|\| \[\]; \}/,
    'and perms() is still the server\'s own list, for every other gate on the page');

  /* NO GATE AT ALL, counted over code rather than over the whole file: the history above
     names the permission in prose, and a comment is not a gate. ZERO is the number that
     matters — it going UP is how a page-side copy of this rule gets back in. */
  const pageCode = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.strictEqual((pageCode.match(/asset\.hold/g) || []).length, 0,
    'the page asks about asset.hold nowhere — the server decides and sends the answer');
  assert.ok(!/asset\.hold_any/.test(pageCode),
    'and it does not ask about the lead-level key either');
  const at = PAGE.indexOf('const hs = a.hold_state || UNKNOWN_HOLD_STATE;');
  const holdArea = PAGE.slice(at, at + 900);
  assert.ok(!/caps\(/.test(holdArea), 'and the tier is not consulted anywhere near it');
});

test('there is no per-user grant to override a role default with', () => {
  /* Asserted rather than stated, because the whole shape of this task assumed one. */
  const rp = fs.readFileSync(path.join(__dirname, '..', 'src', 'role-permissions.js'), 'utf8');
  assert.match(rp, /no\s*\n?\/\/ per-user rows|one lookup by role key, no/,
    'role permissions are per role, by design');
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  assert.match(migrate, /for \(const table of \['user_permissions', 'permission_audit'\]\)/,
    'and the per-user tables are dropped on startup rather than left unread');

  // And Hold is on for everybody until a Super Admin says otherwise.
  const entry = catalog.PERMISSIONS ? catalog.PERMISSIONS.find((p) => p.key === 'asset.hold') : null;
  if (entry) {
    assert.strictEqual(entry.impliedBy(), true,
      'asset.hold is implied for every role, so no designation lacks it by default');
  }
});

// --- against a live server ---------------------------------------------------

test('Hold follows the configured permission, on the page and on the server',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tokens = {};
  const ids = {};
  let assetId;
  let projectId;

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* WHAT THE PAGE WOULD SEE. perms() reads state.currentUser.permissions, which the page
     fills from /auth/me and re-reads every twenty seconds. So asking /auth/me is asking
     the page's own question — and mayHold is then evaluated with the page's own source,
     lifted out of public/index.html, rather than re-implemented here. */
  const mayHoldOnPage = async (who, asset) => {
    const me = await as(who, '/auth/me');
    assert.strictEqual(me.status, 200, JSON.stringify(me.body));
    const can = (...keys) => keys.some((k) => (me.body.user.permissions || []).includes(k));
    /* THE PAGE'S OWN LINES, lifted rather than re-implemented. There are two of them now:
       the page reads the server's hold_state and has no rule of its own at all, which is
       why `can` below goes unused by them — kept in the signature because the point of
       this file is that the page reads the configured set, and an unused parameter proving
       it is never consulted here is a stronger statement than removing it. */
    const from = PAGE.indexOf('const hs = a.hold_state || UNKNOWN_HOLD_STATE;');
    assert.ok(from !== -1, 'the page still has the hold state this test reads');
    const to = PAGE.indexOf('const canResume = hs.canResume;', from);
    const lines = PAGE.slice(from, PAGE.indexOf(';', to) + 1);
    /* `a` is the asset row as the panel has it — decorated by the board, because that is
       where hold_state comes from. Passed through rather than stubbed. */
    // eslint-disable-next-line no-new-func
    return new Function('mine', 'a', 'can', 'held', 'UNKNOWN_HOLD_STATE',
      `${lines} return canHold;`)(
      asset.assignee_id === me.body.user.id, asset, can, asset.held || null,
      { canHold: false, canResume: false, hold: { offer: true }, resume: { offer: true } });
  };

  const setPerms = async (roleKey, keys) => {
    const r = await as('root', `/permissions/roles/${roleKey}`, {
      method: 'PUT', body: { permissions: keys } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const heldBy = async (roleKey) => {
    const r = await as('root', `/permissions/roles/${roleKey}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  };
  /* THE DECORATED ROW, as the board serves it — not a raw SELECT. The gate reads
     can_hold_others, which only the API adds, and a hand-built row would answer a question
     the page never asks. */
  const assetRow = async (who = 'artist') => {
    const board = await as(who, `/assets/project/${projectId}`);
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));
    const row = (board.body.assets || []).find((x) => x.id === assetId);
    assert.ok(row, 'the asset is on the board');
    return row;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'hold-bootstrap', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'hold-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tokens.root = await login('root@zvky.test');

    /* THE STUDIO CLOCK, OPENED WIDE, and this suite needs it for a reason worth naming:
       Hold reads the held state from the schedule, not from the sweep. The shipped default
       carries a 13:00-14:00 lunch blackout, so a run between those hours found the session
       already down — "This task is already on hold", reason off_hours, pausedFor break —
       and every assertion about the PERMISSION failed for a reason that had nothing to do
       with one. Disabling the sweep is not enough; the window itself has to be open. */
    await openStudio(server.base, tokens.root);

    const r = await as('root', '/users', { method: 'POST',
      body: { name: 'Ana Artist', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    ids.artist = r.body.user.id;
    tokens.artist = await login('ana@zvky.test');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', { method: 'POST',
      body: { name: 'Held Work', clientId: clients.body.clients[0].id } });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    const asset = await as('root', `/assets/project/${project.body.project.id}`, {
      method: 'POST', body: { name: 'Pausable', type: 'prop', assigneeId: ids.artist } });
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    assetId = asset.body.asset.id;
    projectId = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* --- the default, which must keep working -------------------------------- */

  await t.test('by default the designation holds it, and both sides agree', async () => {
    const held = await heldBy('game_artist');
    assert.ok(held.includes('asset.hold'),
      'asset.hold is implied for every role — this is the baseline the rest of this test moves');

    const started = await as('artist', `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));

    assert.strictEqual(await mayHoldOnPage('artist', await assetRow()), true,
      'the page would draw the button');
    const put = await as('artist', `/assets/${assetId}/hold`, { method: 'POST', body: { note: 'lunch' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.held, true, 'and the server puts the clock down');

    const resumed = await as('artist', `/assets/${assetId}/resume`, { method: 'POST' });
    assert.strictEqual(resumed.status, 200, JSON.stringify(resumed.body));
  });

  /* --- revoked: the button goes, and so does the action -------------------- */

  await t.test('revoked in Settings, the button goes and the server refuses', async () => {
    const held = await heldBy('game_artist');
    await setPerms('game_artist', held.filter((k) => k !== 'asset.hold'));
    try {
      assert.ok(!(await heldBy('game_artist')).includes('asset.hold'), 'the grant is off');

      /* THE PAGE. A gate written against the tier would still be true here — the tier has
         not moved, and cannot be moved from Settings — so this is the assertion that tells
         the two apart. */
      assert.strictEqual(await mayHoldOnPage('artist', await assetRow()), false,
        'the page withholds the button once the permission is off');

      /* AND THE REFUSAL CHANGED NOTHING. Asserted through the work log the panel reads,
         before and after, rather than against a column: the property that matters is that
         a refused hold leaves the task exactly as it was, and reading it the way the screen
         does cannot be satisfied by a row that happens to look right. */
      const before = (await as('artist', `/assets/${assetId}/worklog`)).body.work;
      const refused = await as('artist', `/assets/${assetId}/hold`, { method: 'POST' });
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      const after = (await as('artist', `/assets/${assetId}/worklog`)).body.work;
      assert.strictEqual(after.held, before.held, 'the held state is untouched');
      assert.deepStrictEqual(
        { open: Boolean(after.openedAt), held: after.held },
        { open: Boolean(before.openedAt), held: before.held },
        'a refused hold is a no-op');

      // Resume is the same permission, so it goes the same way.
      assert.strictEqual((await as('artist', `/assets/${assetId}/resume`, { method: 'POST' })).status, 403);
    } finally {
      await setPerms('game_artist', held);
    }
  });

  /* --- granted to a designation that does not currently have it ------------ */

  await t.test('granted again, the button comes back and the hold succeeds', async () => {
    /* THE CASE THIS SUITE WAS ASKED TO PIN, as near as this application can express it:
       a designation whose configured permissions do NOT include asset.hold, which is then
       granted it. Reached by revoking first, because the catalogue implies it for every
       role — so "does not have it" is a studio's decision here, never a default. */
    const held = await heldBy('game_artist');
    await setPerms('game_artist', held.filter((k) => k !== 'asset.hold'));
    assert.strictEqual(await mayHoldOnPage('artist', await assetRow()), false, 'off to begin with');

    await setPerms('game_artist', [...held.filter((k) => k !== 'asset.hold'), 'asset.hold']);
    assert.ok((await heldBy('game_artist')).includes('asset.hold'), 'granted');

    assert.strictEqual(await mayHoldOnPage('artist', await assetRow()), true,
      'the page offers it again without the artist signing out');
    const put = await as('artist', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.held, true);
    await as('artist', `/assets/${assetId}/resume`, { method: 'POST' });

    /* AND IT TOOK EFFECT WITHOUT A NEW TOKEN, which is the other half of the page reading
       the server's list rather than a cached one: the artist's token predates both changes,
       and authenticate() resolves the configured set on every request. */
    assert.ok((await as('artist', '/auth/me')).body.user.permissions.includes('asset.hold'),
      'the same session sees the grant');
  });

  /* --- and the rule the permission does NOT carry -------------------------- */

  await t.test('the key alone is not a cross-person hold — a second key is', async () => {
    /* THE CLAIM HAS SURVIVED FOUR WIDENINGS AND IS NOW SHARPER THAN EVER: asset.hold, which
       every designation holds, does not admit anybody to somebody else's timer. What used
       to carry that was the designation and its project; what carries it now is a SECOND
       permission, asset.hold_any, plus the task being on the holder's own dashboard.

       SO THE SUBJECT OF THIS CASE HAD TO CHANGE. It used to be root, who held every key in
       the catalogue and was still refused — and root now holds asset.hold_any too, with a
       studio-wide project scope, so root can hold anything. That is a real change and
       tests/hold-lead-scope.test.js argues it out in full.

       A FULL-ACCESS DESIGNATION IS THE CASE THAT STILL MAKES THE POINT, and makes it
       better: Head of Production holds asset.hold and sees every project in the studio, and
       is refused — because the tier does not carry leadsTeam, so it does not get the
       lead-level key by default. Reach is not authority, which is exactly what this file
       has always been about. */
    const hop = await as('root', '/users', { method: 'POST',
      body: { name: 'hop', email: 'hop@holdperm.test', role: 'head_of_production',
        password: PASSWORD } });
    assert.strictEqual(hop.status, 201, JSON.stringify(hop.body));
    tokens.hop = await login('hop@holdperm.test');

    const held = await heldBy('head_of_production');
    assert.ok(held.includes('asset.hold'), 'full access holds the base key');
    assert.ok(!held.includes('asset.hold_any'),
      'and not the lead-level one, which follows leadsTeam');

    const refused = await as('hop', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'HOLD_NOT_YOURS');
    assert.strictEqual(refused.body.gate, 'authority');
    assert.match(refused.body.error, /Only the person this task is assigned to/);
    assert.match(refused.body.error, /Hold \/ Resume Any Visible Task/,
      'and names the permission that would grant it, which is the fix');
    // The button agrees, which is the pairing this whole suite is about.
    assert.strictEqual(await mayHoldOnPage('hop', await assetRow('hop')), false);

    /* AND GRANTING IT IS ALL IT TAKES — no sign-out, because authenticate() resolves the
       set on every request and the page re-reads it on its twenty-second poll. */
    await setPerms('head_of_production', [...held, 'asset.hold_any']);
    try {
      const allowed = await as('hop', `/assets/${assetId}/hold`, { method: 'POST' });
      assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
      await as('hop', `/assets/${assetId}/resume`, { method: 'POST' });
      assert.strictEqual(await mayHoldOnPage('hop', await assetRow('hop')), true,
        'and the button is there on the same token');
    } finally {
      await setPerms('head_of_production', held);
    }
  });
});
