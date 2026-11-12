/* THE EDIT PENCIL APPEARING WITHOUT A RELOAD, IN A REAL BROWSER.
 *
 * ===========================================================================
 * THE HALF THE OTHER SUITE CANNOT REACH. tests/project-authority covers what
 * the rule decides and what the server answers. This covers the thing the bug
 * report was actually about: somebody is looking at a project, an owner grants
 * Project Edit in Settings, and the pencil has to appear on the screen they are
 * already looking at.
 *
 * TWO FAILURES WERE HIDING IN THAT ONE SENTENCE, and both are pinned here:
 *
 *   1. editProjectBtn was not in the list render() re-applies when the polled
 *      permission set changes. So even once the grant reached the page, the
 *      control stayed hidden until the person navigated or re-picked a project.
 *   2. refreshPermissions() was only ever CALLED from render(), and render()
 *      runs on navigation and on actions — not on a clock. On a page left open,
 *      the twenty-second throttle inside refreshPermissions was the only part
 *      of "within the normal refresh cycle" that existed; nothing asked. The
 *      page now asks from the interval that was already running for
 *      notifications, which is why there is no second polling loop to find.
 *
 * THE REAL FUNCTIONS, LIFTED — the mirrored rule block, applyGate, UI_GATES'
 * entry for the pencil, and applyPermissionChange itself — so this drives what
 * ships rather than a retyped copy. /auth/me is stubbed, because what is under
 * test is what the page does with the answer, not how it is fetched.
 *
 * NO NATIVE DIALOGS: the desktop web view has none, so alert/confirm/prompt
 * throw here and any case reaching one fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const SKIP = !chromium ? 'playwright-core is not installed — run `npm install`.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

const cut = (fromText, toText, what) => {
  const from = PAGE.indexOf(fromText);
  const to = PAGE.indexOf(toText, from + 1);
  assert.ok(from !== -1 && to > from, `found ${what} in the page`);
  return PAGE.slice(from, to);
};

function fixture() {
  /* THE SHARED RULE, between its markers — the same block
     tests/project-authority compares character for character against
     src/project-authority.js. */
  const rule = cut('/* ===== MIRROR START', '/* ===== MIRROR END ===== */', 'the mirrored rule')
    + '/* ===== MIRROR END ===== */';
  const access = cut('const projectAccess = {', '\n\n', 'projectAccess');
  /* Anchored at the start of a line: the note above this function quotes its
     old body verbatim, and an indexOf would lift the quote. */
  const declared = PAGE.match(/^function mayEditCurrentProject\(\)\{\n(?:.*\n)*?\}/m);
  assert.ok(declared, 'found mayEditCurrentProject in the page');
  const mayEdit = declared[0];
  const applyGate = cut('function applyGate(id, also){', '\n}\n', 'applyGate') + '\n}';
  const applyChange = cut('async function applyPermissionChange(){', '\n}\n', 'applyPermissionChange') + '\n}';

  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <button id="editProjectBtn" style="display:none;">&#9998;</button>
    <button id="projectsTabBtn" style="display:none;">Projects</button>
    <script>
    for(const name of ['alert','confirm','prompt']){
      window[name] = () => { throw new Error('native dialog: ' + name); };
    }
    const state = { token:'t', currentUser:null, projects:[], currentProjectId:null, view:'board' };
    let POLLS = 0;               /* how many times /auth/me was asked */
    let RENDERS = 0;             /* how many times the Projects tab redrew */
    let SERVER = null;           /* what the next /auth/me will answer */

    function perms(){ return (state.currentUser && state.currentUser.permissions) || []; }
    function caps(){ return (state.currentUser && state.currentUser.capabilities) || {}; }
    ${cut('/* can(\'asset.add\') — and can(\'a\',\'b\') for "either of these". */', '\n}\n', 'can()')}\n}
    function currentProject(){
      return (state.projects||[]).find(p=>p.id===state.currentProjectId) || null;
    }
    ${rule}
    ${access}
    ${mayEdit}

    /* UI_GATES, with only the entries this fixture needs. applyGate below is
       the page's own, so the lookup and the show/hide are the real ones. */
    const UI_GATES = {
      editProjectBtn: () => mayEditCurrentProject(),
      projectsTabBtn: () => can('client.view'),
    };
    const TAB_GATE_IDS = Object.keys(UI_GATES).filter(id=>id.endsWith('TabBtn'));
    ${applyGate}

    /* THE POLL, STUBBED AT THE FETCH AND NOWHERE ELSE. The throttle, the
       change detection and the redraw below it are the page's own. */
    const PERMISSION_REFRESH_MS = 20000;
    let permissionsCheckedAt = 0;
    async function refreshPermissions(){
      if(!state.token || !state.currentUser) return false;
      if(Date.now() - permissionsCheckedAt < PERMISSION_REFRESH_MS) return false;
      permissionsCheckedAt = Date.now();
      POLLS += 1;
      const before = perms().join(',');
      state.currentUser = SERVER;
      return perms().join(',') !== before;
    }
    function renderProjects(){ RENDERS += 1; }
    function openDrawer(){ }
    ${applyChange}
    </script></body></html>`;
}

test('the Edit pencil appears on the open project when the grant is polled',
  { skip: SKIP, concurrency: false }, async (t) => {
    const browser = await chromium.launch({ executablePath: EXECUTABLE });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.setContent(fixture());
    t.after(async () => { await browser.close(); });

    const shown = () => page.evaluate(() =>
      document.getElementById('editProjectBtn').style.display !== 'none');

    const signIn = (permissions, scope = 'assigned') => page.evaluate(([p, s]) => {
      const user = { id: 'u1', permissions: p, capabilities: { projectScope: s } };
      state.currentUser = user; SERVER = user;
      /* The project is one the server says this role reaches — inReach is the
         server's own answer from permissions.reachesProject(). */
      state.projects = [{ id: 'p1', name: 'Hero Quest', owner_id: 'someone-else', inReach: true }];
      state.currentProjectId = 'p1';
      state.view = 'projects';
      permissionsCheckedAt = 0; POLLS = 0; RENDERS = 0;
      applyGate('editProjectBtn');
    }, [permissions, scope]);

    await t.test('no permission, no pencil — the starting point', async () => {
      await signIn(['project.view']);
      assert.strictEqual(await shown(), false);
    });

    await t.test('the grant arrives on the poll and the pencil appears, with no reload',
      async () => {
        const marker = await page.evaluate(() => {
          window.__id = Math.random();
          return window.__id;
        });
        // The owner switches it on. The next /auth/me says so.
        await page.evaluate(() => {
          SERVER = { id: 'u1', permissions: ['project.view', 'project.edit'],
            capabilities: { projectScope: 'assigned' } };
        });
        assert.strictEqual(await shown(), false, 'the pencil appeared before anything polled');

        await page.evaluate(() => applyPermissionChange());
        assert.strictEqual(await shown(), true,
          'the grant was polled and the pencil did not appear');

        // Nothing reloaded: the same page object is still here.
        assert.strictEqual(await page.evaluate(() => window.__id), marker,
          'the page reloaded instead of re-rendering');
        assert.strictEqual(await page.evaluate(() => RENDERS), 1,
          'the Projects tab was not redrawn (or was redrawn more than once)');
      });

    await t.test('an unchanged answer costs no redraw', async () => {
      await page.evaluate(() => { permissionsCheckedAt = 0; RENDERS = 0; });
      await page.evaluate(() => applyPermissionChange());
      assert.strictEqual(await page.evaluate(() => RENDERS), 0,
        'the page redrew for a permission set that had not changed');
      assert.strictEqual(await shown(), true, 'the pencil was taken away by a no-op poll');
    });

    await t.test('revoking it takes the pencil away on the same poll', async () => {
      await page.evaluate(() => {
        permissionsCheckedAt = 0;
        SERVER = { id: 'u1', permissions: ['project.view'], capabilities: { projectScope: 'assigned' } };
      });
      await page.evaluate(() => applyPermissionChange());
      assert.strictEqual(await shown(), false, 'the pencil survived the permission being revoked');
    });

    await t.test('the key alone is not enough: a project out of reach stays unoffered',
      async () => {
        await signIn(['project.view', 'project.edit']);
        assert.strictEqual(await shown(), true, 'the in-reach project is not offered');
        await page.evaluate(() => {
          state.projects = [{ id: 'p1', name: 'Far Away', owner_id: 'someone-else', inReach: false }];
          applyGate('editProjectBtn');
        });
        assert.strictEqual(await shown(), false,
          'the pencil is offered for a project the role cannot see');
      });

    await t.test('a row from a server that predates inReach is treated as out of reach',
      async () => {
        await signIn(['project.view', 'project.edit']);
        await page.evaluate(() => {
          state.projects = [{ id: 'p1', name: 'Old Server', owner_id: 'someone-else' }];
          applyGate('editProjectBtn');
        });
        assert.strictEqual(await shown(), false,
          'a row with no inReach field was treated as reachable');
      });

    await t.test('the throttle still holds — one read per twenty seconds', async () => {
      await signIn(['project.view']);
      await page.evaluate(async () => {
        POLLS = 0; permissionsCheckedAt = 0;
        await applyPermissionChange();
        await applyPermissionChange();
        await applyPermissionChange();
      });
      assert.strictEqual(await page.evaluate(() => POLLS), 1,
        'the poll is not throttled any more');
    });

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
  });

/* ------------------------------------------------- and no second polling loop */
test('the permission poll rides the interval that was already there', () => {
  /* The brief for this fix was explicit: no new polling loop. Pinned as source,
     because a setInterval added next to this one would pass every behavioural
     test in this file. */
  const intervals = PAGE.match(/setInterval\(/g) || [];
  assert.ok(intervals.length <= 4,
    `public/index.html has ${intervals.length} intervals; a new polling loop has been added`);
  assert.ok(/pollNotifications\(\); refreshPendingCount\(\); applyPermissionChange\(\);/.test(PAGE),
    'applyPermissionChange is not called from the notification interval');
  assert.ok(!/setInterval\([^)]*applyPermissionChange/.test(PAGE),
    'applyPermissionChange has been given an interval of its own');
  assert.ok(!/setInterval\([^)]*refreshPermissions/.test(PAGE),
    'refreshPermissions has been given an interval of its own');
});
