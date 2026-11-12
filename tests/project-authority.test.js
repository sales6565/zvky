/* WHO MAY CHANGE A PROJECT — one rule, two readers, held equal here.
 *
 * ===========================================================================
 * THE BUG THIS SUITE IS THE FENCE AROUND.
 *
 * An owner granted Project Edit to a designation. Settings said the role held
 * it, /auth/me returned it, and nothing happened: no pencil on the project,
 * 403 from PATCH /api/projects/:id. The page and the route were both applying
 *
 *     can('project.edit')  AND  (projectScope === 'all' OR owner_id === me)
 *
 * and the second half is a role TIER, which no checkbox in Settings can move.
 * Of the sixty built-in designations, exactly one holds project.edit by default
 * without studio-wide scope (admin, which owns what it creates) — so the gap
 * was invisible to the accounts that built the feature and total for every
 * designation an owner would actually grant it to.
 *
 * ===========================================================================
 * WHAT IS ASSERTED, AND WHY EACH IS NEEDED.
 *
 *   1. THE RULE IS ONE RULE. The block between the MIRROR markers in
 *      src/project-authority.js and the one in public/index.html are compared
 *      CHARACTER FOR CHARACTER. A behavioural matrix alone passes while two
 *      copies diverge on an input nobody thought of.
 *   2. NO TIER CHECK SURVIVES. The old two lines are searched for, as source
 *      text, in both the routes and the page.
 *   3. EVERY ROUTE IN THE CONTROL TABLE IS REALLY GUARDED BY THE KEY IT NAMES.
 *      Walked out of src/routes/projects.js, so a route added without its guard
 *      — or guarded with a different key — fails here rather than shipping.
 *   4. THE THING THE BUG REPORT DESCRIBED NOW WORKS, end to end, against a real
 *      server: a role holding only the project keys, and separately a role
 *      holding them only through a role group.
 *   5. NOBODY WHO COULD EDIT BEFORE HAS LOST ANYTHING. The old rule is applied
 *      to every built-in role and every project in the fixture, and every pair
 *      it allowed is asserted still allowed.
 *   6. SCOPE DOES NOT WIDEN. A role reaches what it could see and no more.
 *   7. THE MIGRATION IS IDEMPOTENT and only ever switches the read ON.
 *   8. THE DIAGNOSTIC SCRIPT WRITES NOTHING, proved against the statements it
 *      really issues, and agrees with effectiveFor on every role.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'project-authority.js'), 'utf8');
const ROUTES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'projects.js'), 'utf8');

const authority = require('../src/project-authority');
const catalog = require('../src/permission-catalog');
const { roleDef, entries } = require('../src/roles');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const MIRROR_START = '/* ===== MIRROR START';
const MIRROR_END = '/* ===== MIRROR END ===== */';

/* The shared block, out of either file, between the markers and including them
   — so a marker moved or renamed is itself a difference. */
function mirrorOf(text, what) {
  const from = text.indexOf(MIRROR_START);
  assert.ok(from !== -1, `no MIRROR START marker in ${what}`);
  const to = text.indexOf(MIRROR_END, from);
  assert.ok(to !== -1, `no MIRROR END marker in ${what}`);
  return text.slice(from, to + MIRROR_END.length);
}

/* ---------------------------------------------------------------- 1. the rule
 *
 * CHARACTER FOR CHARACTER. Not "both behave the same on these twelve inputs" —
 * that is assertion 1b below and it is the weaker claim. This is the one that
 * catches a rule changed on the server and not on the page. */
test('the page carries the shared rule character for character', () => {
  const fromModule = mirrorOf(MODULE_SRC, 'src/project-authority.js');
  const fromPage = mirrorOf(PAGE, 'public/index.html');
  assert.strictEqual(fromPage, fromModule,
    'public/index.html\'s copy of the project-change rule has drifted from '
    + 'src/project-authority.js. Copy the block between the MIRROR markers across '
    + 'verbatim — do not reformat it.');
  // And it is not vacuous: the block really contains the decision.
  assert.ok(/function projectVerdict\(key, access, project\) \{/.test(fromModule));
  assert.ok(/function canEditProject\(/.test(fromModule));
  assert.ok(/function canDeleteProject\(/.test(fromModule));
  assert.ok(/function canCloseProject\(/.test(fromModule));
});

test('the page copy, evaluated, decides the same as the module', () => {
  /* The block as it stands, markers included — they are already valid comments,
     so nothing is rewritten before it is evaluated. */
  const block = mirrorOf(PAGE, 'public/index.html');
  // eslint-disable-next-line no-new-func
  const pageCopy = new Function(`${block}
    return { canEditProject, canDeleteProject, canCloseProject };`)();

  const cases = [];
  for (const holds of [true, false]) {
    for (const reaches of [true, false]) {
      for (const project of [{ id: 'p1' }, null]) {
        cases.push({ access: { holds: () => holds, reaches: () => reaches }, project });
      }
    }
  }
  for (const fn of ['canEditProject', 'canDeleteProject', 'canCloseProject']) {
    for (const c of cases) {
      assert.deepStrictEqual(pageCopy[fn](c.access, c.project), authority[fn](c.access, c.project),
        `${fn} disagrees for holds/reaches/project ${JSON.stringify(c.project)}`);
    }
  }
});

/* -------------------------------------------------------- 2. no tier survives
 *
 * The exact text of the old rule, hunted in both readers. A regular expression
 * over source is a blunt instrument and that is why it is pinned to the two
 * strings that made the bug — projectScope compared to 'all' beside an
 * owner_id, in a file that decides a project control. */
test('no role-tier check decides a project control any more', () => {
  const tierShape = /projectScope\s*===\s*['"]all['"]/;
  const isComment = (l) => /^\s*(\*|\/\*|\/\/|\*\/)/.test(l);

  /* THE ROUTES. Nothing in this file may decide anything from the tier: the
     five project-changing routes were its only reader, and the only mention
     that survives is the note recording what the old rule was. */
  const routeLines = ROUTES_SRC.split('\n').filter((l) => tierShape.test(l) && !isComment(l));
  assert.deepStrictEqual(routeLines, [],
    `src/routes/projects.js still decides something from the role's tier:\n${routeLines.join('\n')}`);
  assert.ok(tierShape.test(ROUTES_SRC),
    'the explanatory note naming the old rule has gone \u2014 keep the history');

  /* THE PAGE reads the tier in several places that genuinely are tier
     questions — which roles a person may assign, whether they administer
     somebody who runs the studio. Narrowed to the lines where a tier is read
     ALONGSIDE a project, which is the shape that was the bug. */
  const pageLines = PAGE.split('\n').filter((l) => !isComment(l)
    && /projectScope/.test(l)
    && /(project\.(edit|delete|close)|owner_id|currentProject|projectAccess|inReach|projArchiveBtn|projCloseBtn|projRestoreBtn|projPurgeBtn|projReopenBtn|editProjectBtn)/.test(l));
  assert.deepStrictEqual(pageLines, [],
    `public/index.html still decides a project control from the role's tier:\n${pageLines.join('\n')}`);

  /* And the two exact lines that were the bug are gone, by their own text. */
  const ownerLines = PAGE.split('\n').filter((l) => !isComment(l)
    && /owner_id\s*===\s*\(state\.currentUser/.test(l));
  assert.deepStrictEqual(ownerLines, [],
    `the page still compares owner_id to the signed-in user to decide a project control:\n${ownerLines.join('\n')}`);
  assert.ok(!/You can only edit projects you created/.test(ROUTES_SRC),
    'the old refusal is still there, which means the old rule is too');
  assert.ok(!/function mayChange\(user, project\) \{\n\s*return roleDef/.test(ROUTES_SRC),
    'the old synchronous mayChange is still there');

  /* mayEditCurrentProject does nothing but call the shared rule. Pinned as a
     whole body, because "it also checks one more thing" is how the next copy
     of the rule starts. */
  /* Anchored at the start of a line, because the note above it quotes the old
     body verbatim and that quote is the history this change is worth keeping. */
  const declared = PAGE.match(/^function mayEditCurrentProject\(\)\{\n(?:.*\n)*?\}/m);
  assert.ok(declared, 'mayEditCurrentProject is not declared at the start of a line any more');
  assert.strictEqual(declared[0],
    'function mayEditCurrentProject(){\n  return canEditProject(projectAccess, currentProject()).ok;\n}');
});

/* ------------------------------------------------- 3. the routes are guarded */
test('every route in the control table is guarded by the key it names', () => {
  for (const control of authority.CONTROLS) {
    for (const route of control.routes) {
      const [method, urlPath] = route.split(' ');
      const express = urlPath.replace('/api/projects', '') || '/';
      const needle = `router.${method.toLowerCase()}('${express}', requirePermission('${control.key}')`;
      assert.ok(ROUTES_SRC.includes(needle),
        `${route} is not guarded by requirePermission('${control.key}').\n`
        + `Looked for: ${needle}`);
    }
  }
});

test('every key in the table is a real permission, described with its scope limit', () => {
  for (const [name, key] of Object.entries(authority.KEYS)) {
    assert.ok(catalog.isPermission(key), `KEYS.${name} = "${key}" is not in the catalogue`);
    const entry = catalog.BY_KEY.get(key);
    assert.ok(entry.describe, `${key} has no description on the roles screen`);
    assert.ok(entry.describe.includes(authority.SCOPE_NOTE),
      `${key}'s description does not say it applies only to projects the role can see`);
  }
  assert.strictEqual(authority.SCOPE_NOTE, catalog.PROJECT_SCOPE_NOTE,
    'the scope sentence has been written out twice');
});

test('every control in the table has a page gate that exists in the page', () => {
  for (const control of authority.CONTROLS) {
    const gate = control.pageGate.replace(/^\./, '');
    assert.ok(PAGE.includes(gate), `${control.id}: no "${gate}" in public/index.html`);
  }
  // And the page decides each of them through the shared rule, not through can() alone.
  for (const [cls, fn] of [
    ['projCloseBtn', 'canCloseProject'], ['projReopenBtn', 'canCloseProject'],
    ['projArchiveBtn', 'canDeleteProject'], ['projRestoreBtn', 'canDeleteProject'],
    ['projPurgeBtn', 'canDeleteProject'],
  ]) {
    const at = PAGE.indexOf(cls);
    const window = PAGE.slice(Math.max(0, at - 400), at);
    assert.ok(window.includes(`${fn}(projectAccess`),
      `the ${cls} button is not decided by ${fn}(projectAccess, …)`);
  }
  assert.ok(/editProjectBtn:\s+\(\) => mayEditCurrentProject\(\)/.test(PAGE));
  assert.ok(/return canEditProject\(projectAccess, currentProject\(\)\)\.ok;/.test(PAGE));
});

/* ------------------------------------------------ 5/6. nothing was taken away
 *
 * The OLD rule, written out here because it exists nowhere else any more, run
 * against every built-in role. Anything it allowed must still be allowed. */
const oldRule = (role, ownerIsMe) => roleDef(role).projectScope === 'all' || ownerIsMe;

test('every (role, project) pair the old rule allowed is still allowed', () => {
  for (const role of entries()) {
    const def = roleDef(role.key);
    const heldByDefault = catalog.baselineFor(def);
    for (const ownerIsMe of [true, false]) {
      if (!oldRule(role.key, ownerIsMe)) continue;
      // The old rule's scope half said yes. reachesProject says yes for the
      // same two reasons — scope 'all', or being the owner — which is the
      // claim: the new rule's first two lines ARE the old rule.
      const reach = def.projectScope === 'all' || ownerIsMe;
      assert.strictEqual(reach, true,
        `${role.key} (ownerIsMe=${ownerIsMe}) could reach a project before and cannot now`);
      // And the permission half is untouched: the default set is unchanged.
      for (const key of Object.values(authority.KEYS)) {
        if (!heldByDefault.has(key)) continue;
        const verdict = authority.projectVerdict(key,
          { holds: (k) => heldByDefault.has(k), reaches: () => reach }, { id: 'p' });
        assert.ok(verdict.ok,
          `${role.key} held ${key} by default and could act on a project it owned; now ${verdict.reason}`);
      }
    }
  }
});

/* ------------------------------------------------------------- 4. impliedBy
 *
 * TWO CLAIMS, AND THE BUG IS WHAT HAPPENS WHEN EITHER IS DROPPED.
 *
 *   THE DEFAULTS DID NOT MOVE. Every role that held a project write key before
 *   this change holds it still, and no role gained one. Fixing a rule and
 *   changing who holds a permission are different decisions, and this change is
 *   only the first.
 *
 *   A ROLE THAT MAY CHANGE A PROJECT CAN READ IT. project.view is implied for
 *   every designation, which is the only reason granting edit is enough on its
 *   own; drop that and this change reproduces the bug from the other end — a
 *   role allowed to edit a project whose name it cannot fetch. The stored-row
 *   half, for a role whose view was switched off by hand, is the migration,
 *   which the live suite below exercises.
 */
test('the default holders of each project key are exactly the createProject roles', () => {
  for (const role of entries()) {
    const def = roleDef(role.key);
    const held = catalog.baselineFor(def);
    for (const key of Object.values(authority.KEYS)) {
      assert.strictEqual(held.has(key), Boolean(def.createProject),
        `${role.key} holds ${key} by default = ${held.has(key)}, `
        + `but createProject = ${Boolean(def.createProject)} — a default has moved`);
    }
  }
});

test('every role that may change a project may read one', () => {
  for (const role of entries()) {
    const def = roleDef(role.key);
    const held = catalog.baselineFor(def);
    const writes = Object.values(authority.KEYS).filter((k) => held.has(k));
    if (!writes.length) continue;
    assert.ok(held.has('project.view'),
      `${role.key} holds ${writes.join(', ')} by default but not project.view — `
      + 'granting a write key would allow changing a project it cannot read');
  }
  // And it is implied for everybody, which is what makes that true without a
  // per-role decision.
  assert.ok(catalog.BY_KEY.get('project.view').impliedBy({}),
    'project.view is no longer implied for every designation');
});

test('the rule refuses without the key, and refuses out of scope, and says which', () => {
  const yes = { holds: () => true, reaches: () => true };
  const noKey = { holds: () => false, reaches: () => true };
  const outOfScope = { holds: () => true, reaches: () => false };
  const p = { id: 'p1' };

  assert.strictEqual(authority.canEditProject(yes, p).ok, true);
  assert.strictEqual(authority.canEditProject(noKey, p).code, 'no_key');
  assert.strictEqual(authority.canEditProject(outOfScope, p).code, 'out_of_scope');
  assert.strictEqual(authority.canEditProject(yes, null).code, 'no_project');

  assert.strictEqual(authority.refusal({ code: 'no_key' }, 'edit'),
    'You do not have permission to edit a project.');
  assert.strictEqual(authority.refusal({ code: 'out_of_scope' }, 'close'),
    'You can only close projects you can see.');
});

test('holding one project key does not grant the others', () => {
  const onlyEdit = { holds: (k) => k === 'project.edit', reaches: () => true };
  const p = { id: 'p1' };
  assert.strictEqual(authority.canEditProject(onlyEdit, p).ok, true);
  assert.strictEqual(authority.canDeleteProject(onlyEdit, p).ok, false);
  assert.strictEqual(authority.canCloseProject(onlyEdit, p).ok, false);
});

test('Super Admin holds every project key and reaches every project', () => {
  const superRoles = entries().filter((r) => authority.isSuperAdmin(r.key));
  assert.ok(superRoles.length >= 1, 'no super-admin role in the catalogue');
  for (const role of superRoles) {
    assert.strictEqual(roleDef(role.key).projectScope, 'all',
      `${role.key} is a super admin whose project scope is not the studio`);
    // effectiveFor short-circuits this tier to the whole catalogue; the holds
    // half is therefore every key, and the reaches half is every project.
    const access = { holds: () => true, reaches: () => true };
    for (const control of authority.CONTROLS) {
      assert.ok(control.decide(access, { id: 'p' }).ok, `${role.key} denied ${control.id}`);
    }
  }
});

/* ---------------------------------------------- the live half: a real server */
const cfg = config('projauth');
const PASSWORD = 'Authority-1!';

test('granting the keys makes the controls work', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server; const token = {}; const id = {}; const who = {};
  const call = (p, o = {}) => api(server.base, p, o);
  const as = (name, p, o = {}) => api(server.base, p, { ...o, token: token[name] });
  const login = async (e) => (await call('/auth/login', { method: 'POST',
    body: { email: e, password: PASSWORD } })).body.token;

  const handle = {
    async query(text, params = []) {
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
        values.push(params[Number(n) - 1]); return '?';
      });
      const rows = await sql(cfg, translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'a-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0' });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'a-token', name: 'Root', email: 'root@a.test', password: PASSWORD } });
    token.root = await login('root@a.test');
    await openStudio(server.base, token.root);
    id.client = await systemClientId(server.base, token.root);
    id.hers = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Hero Quest', clientId: id.client } })).body.project.id;
    id.other = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Far Away', clientId: id.client } })).body.project.id;

    /* Pat is a producer — scope `assigned`, cannot create projects, so never an
       owner_id: exactly the designation the bug report was about. Attached to
       Hero Quest and not to Far Away, so the scope half has something to say. */
    for (const [name, role, projectId] of [
      ['pat', 'producer', id.hers],
      ['sam', 'coordinator', id.hers],
    ]) {
      const made = await call('/users', { token: token.root, method: 'POST',
        body: { name, email: `${name}@a.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      who[name] = made.body.user.id;
      token[name] = await login(`${name}@a.test`);
    }
  });
  t.after(async () => { if (server) await stopServer(server); });

  const grantToRole = async (role, keys) => {
    const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    const put = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
      body: { permissions: [...new Set([...held, ...keys])] } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  };

  await t.test('before the grant, the producer is refused and offered nothing', async () => {
    const me = (await as('pat', '/auth/me')).body.user;
    assert.ok(!me.permissions.includes('project.edit'));
    const patch = await as('pat', `/projects/${id.hers}`, { method: 'PATCH', body: { name: 'No' } });
    assert.strictEqual(patch.status, 403);
    /* requirePermission('project.edit') refuses this before the shared rule is
       reached, so the refusal is the middleware's and carries no `reason`. That
       is the right order — the key half is a route-level guard and the scope
       half is the only thing the handler has left to decide — and asserting it
       here is what pins the guard as being present at all. */
    assert.match(patch.body.error, /do not have permission/);
    assert.strictEqual(patch.body.reason, undefined);
  });

  await t.test('granting project.edit to the role makes the edit work — the bug', async () => {
    await grantToRole('producer', ['project.edit']);

    const me = (await as('pat', '/auth/me')).body.user;
    assert.ok(me.permissions.includes('project.edit'), '/auth/me does not return the granted key');

    const patch = await as('pat', `/projects/${id.hers}`, { method: 'PATCH',
      body: { name: 'Hero Quest II' } });
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));

    const list = (await as('pat', '/projects')).body.projects;
    const row = list.find((p) => p.id === id.hers);
    assert.ok(row, 'the project the producer may now edit is not in their list');
    assert.strictEqual(row.inReach, true, 'the server did not stamp inReach on the row');
    assert.strictEqual(row.name, 'Hero Quest II');
  });

  await t.test('the scope half still holds: a project out of reach is refused', async () => {
    const list = (await as('pat', '/projects')).body.projects;
    assert.ok(!list.some((p) => p.id === id.other),
      'Far Away is visible to the producer, so it is not a scope test');
    const patch = await as('pat', `/projects/${id.other}`, { method: 'PATCH',
      body: { name: 'Mine now' } });
    assert.strictEqual(patch.status, 403, JSON.stringify(patch.body));
    assert.strictEqual(patch.body.reason, 'out_of_scope');
    assert.match(patch.body.error, /projects you can see/);
    const { rows } = await handle.query('SELECT `name` FROM projects WHERE id = $1', [id.other]);
    assert.strictEqual(rows[0].name, 'Far Away', 'the refused request changed the project anyway');
  });

  await t.test('close, reopen, archive and restore follow the same rule', async () => {
    await grantToRole('producer', ['project.close', 'project.delete']);

    for (const [path_, body, label] of [
      [`/projects/${id.other}/close`, { confirm: true }, 'close'],
      [`/projects/${id.other}/reopen`, {}, 'reopen'],
      [`/projects/${id.other}/restore`, {}, 'restore'],
    ]) {
      const r = await as('pat', path_, { method: 'POST', body });
      assert.strictEqual(r.status, 403, `${label} on an unreachable project: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.reason, 'out_of_scope');
    }
    const del = await as('pat', `/projects/${id.other}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 403);

    const close = await as('pat', `/projects/${id.hers}/close`, { method: 'POST', body: { confirm: true } });
    assert.strictEqual(close.status, 200, JSON.stringify(close.body));
    const reopen = await as('pat', `/projects/${id.hers}/reopen`, { method: 'POST', body: {} });
    assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.body));
  });

  await t.test('the same keys, held only through a role group, work the same', async () => {
    const before = await as('sam', `/projects/${id.hers}`, { method: 'PATCH', body: { name: 'No' } });
    assert.strictEqual(before.status, 403);
    assert.match(before.body.error, /do not have permission/);

    const g = await as('root', '/role-groups', { method: 'POST',
      body: { name: 'Project Editors', kind: 'custom' } });
    assert.strictEqual(g.status, 201, JSON.stringify(g.body));
    const perms = await as('root', `/role-groups/${g.body.group.id}/permissions`, { method: 'PUT',
      body: { permissions: ['project.edit'] } });
    assert.strictEqual(perms.status, 200, JSON.stringify(perms.body));
    const roles = await as('root', `/role-groups/${g.body.group.id}/roles`, { method: 'PUT',
      body: { roles: ['coordinator'] } });
    assert.strictEqual(roles.status, 200, JSON.stringify(roles.body));

    const me = (await as('sam', '/auth/me')).body.user;
    assert.ok(me.permissions.includes('project.edit'),
      'a key granted through a role group is not in /auth/me');

    const patch = await as('sam', `/projects/${id.hers}`, { method: 'PATCH',
      body: { name: 'Hero Quest III' } });
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));

    // Still only what the role can see.
    const out = await as('sam', `/projects/${id.other}`, { method: 'PATCH', body: { name: 'No' } });
    assert.strictEqual(out.status, 403);
    assert.strictEqual(out.body.reason, 'out_of_scope');
  });

  await t.test('the owner of an archived project can still restore it', async () => {
    /* THE ONE THING "can you see it" WOULD HAVE TAKEN AWAY if reachesProject
       did not keep the owner test as its own line: visibleProjects excludes
       archived projects from every scope, and restoring one is by definition
       done to an archived project. Root owns both of these. */
    const archive = await as('root', `/projects/${id.other}`, { method: 'DELETE' });
    assert.strictEqual(archive.status, 200, JSON.stringify(archive.body));
    const restore = await as('root', `/projects/${id.other}/restore`, { method: 'POST', body: {} });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.body));
  });

  await t.test('the Projects tab rows carry the server\'s own scope answer', async () => {
    const clients = (await as('pat', '/clients')).body.clients || [];
    const rows = clients.flatMap((c) => c.projects || []);
    assert.ok(rows.length, 'the producer sees no project rows at all');
    for (const row of rows) {
      assert.strictEqual(row.inReach, true, `${row.name} is listed without inReach`);
    }
    const seenIds = rows.map((r) => r.id);
    assert.ok(!seenIds.includes(id.other), 'an out-of-reach project is on the producer\'s tab');
  });

  await t.test('the view-key migration is idempotent and only ever adds', async () => {
    const migrate = require('../src/migrate');
    const snapshot = async () => {
      const { rows } = await handle.query(
        'SELECT role_key, permission_key, enabled FROM role_permissions ORDER BY role_key, permission_key'
      );
      return JSON.stringify(rows);
    };
    // Switch the read OFF for a role that holds a write key — the state the
    // migration exists for.
    await handle.query(
      `UPDATE role_permissions SET enabled = 0
        WHERE role_key = 'producer' AND permission_key = 'project.view'`
    );
    const before = await snapshot();
    await migrate.run(handle);
    const once = await snapshot();
    assert.notStrictEqual(once, before, 'the migration did not switch the read back on');
    const { rows: view } = await handle.query(
      `SELECT enabled FROM role_permissions
        WHERE role_key = 'producer' AND permission_key = 'project.view'`
    );
    assert.strictEqual(Number(view[0].enabled), 1);

    await migrate.run(handle);
    assert.strictEqual(await snapshot(), once, 'running the migration twice changed something');
  });

  await t.test('the diagnostic script writes nothing and agrees with the application', async () => {
    const statements = [];
    const recorder = {
      async query(text, params = []) { statements.push(String(text)); return handle.query(text, params); },
    };
    const roleCan = require('../scripts/role-can');
    const rolePermissions = require('../src/role-permissions');

    let out = '';
    const report = await roleCan.main({ db: recorder, argv: ['producer'],
      write: (t_) => { out += t_; } });

    assert.ok(statements.length, 'the script issued no queries at all');
    for (const sqlText of statements) {
      assert.match(sqlText.trim(), /^SELECT/i, `the script issued a non-SELECT: ${sqlText}`);
    }
    assert.throws(() => { if (roleCan.FORBIDDEN.test('UPDATE role_permissions SET enabled = 1')) throw new Error('refused'); },
      /refused/, 'the read-only guard does not catch an UPDATE');

    // It agrees with the function the application judges requests by.
    for (const role of entries()) {
      const mine = await roleCan.main({ db: recorder, argv: [role.key, '--json'], write: () => {} });
      const theirs = await rolePermissions.effectiveFor(handle, role.key);
      assert.deepStrictEqual(
        mine.effective.map((e) => e.key).sort(),
        [...theirs].sort(),
        `role-can.js disagrees with effectiveFor for ${role.key}`
      );
    }

    // And it says the useful thing about the role in the bug report.
    assert.match(out, /ALLOWED.*pencil/s);
    assert.match(out, /project scope\s+assigned/);
    assert.ok(report.controls.length === authority.CONTROLS.length);
  });
});
