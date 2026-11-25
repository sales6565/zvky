/* THE OTHER HALF OF THE BUG: THE PAGE THAT IS ALREADY OPEN.
 *
 * ===========================================================================
 * WHY A BROWSER, AND WHY IT WAITS FOR A REAL POLL.
 *
 * The server fix makes the right answer available. It does not deliver it. The complaint
 * was reported while the stand-in was sitting in front of the board: the owner saved the
 * project, said "try now", and nothing happened — because a stand-in gains no permission by
 * design, so the payload the page already polls looked unchanged and it concluded nothing
 * had. The person reloaded, and it worked, and that is the sort of fix that gets reported
 * again a month later.
 *
 * So this test does the thing a test on a response body cannot do: it logs in, waits, and
 * asserts the board FILLS BY ITSELF — no reload, no navigation, no click. It waits for the
 * application's own interval rather than calling the poll by hand, because "within the
 * normal refresh cycle" is the claim, and a test that pokes applyPermissionChange() would
 * pass with the interval removed.
 *
 * THAT MAKES IT SLOW: the notification poll is 30 seconds and the permission read inside it
 * is throttled to 20, so the worst case is a little over half a minute each way. It is one
 * suite, it is the only thing that proves the claim, and the two waits below are the price.
 *
 * AND IT COUNTS THE REQUESTS, because the cheap way to pass this test is a second polling
 * loop, which the brief forbids and which is how a page ends up making four requests a
 * second. Every request the page makes is recorded and the /auth/me reads are counted
 * against the interval that was already running.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

let chromium;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('actingfresh');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'Fresh-Test-1!';
/* HOW LONG THIS IS WILLING TO WAIT. The page's own numbers are NOTIF_POLL_MS 30s and
   PERMISSION_REFRESH_MS 20s, so the change is normally on screen about half a minute after
   the save — three runs in a row measured 30s.
   
   The bound is three of those intervals rather than one, and that is deliberate after this
   suite failed once on a loaded machine while a git worktree was being checked out beside
   it. A browser test that waits exactly one tick is a test that fails for reasons that have
   nothing to do with the code, and a flaky guard gets deleted by the next person. What the
   claim needs is that the board fills WITHOUT ANYBODY TOUCHING THE PAGE and on the interval
   that was already running; the assertion below reports the time it actually took, and the
   request count in the subtest after it is what pins the cadence. */
const WITHIN = 110000;
const STATUSES = ['not_started', 'assigned', 'in_progress', 'pending_tl_review',
  'tl_changes_requested', 'delivered'];

test('a stand-in named on an open page sees the board fill', { skip: SKIP }, async (t) => {
  let server; let browser; let context; let page;
  let origin;
  const token = {};
  const id = {};
  const errors = [];
  const natives = [];
  const requests = [];

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });
  const shown = () => page.evaluate(() => (typeof state === 'undefined' ? -1 : (state.assets || []).length));

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'fresh', WORK_HOURS_SWEEP_MINUTES: '0' });
    origin = server.base.replace(/\/api$/, '');
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'fresh', name: 'Owner', email: 'owner@fresh.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@fresh.test');

    const artist = await as('owner', '/users', { method: 'POST', body: {
      name: 'Stand In', email: 'standin@fresh.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(artist.status, 201, JSON.stringify(artist.body));
    id.artist = artist.body.user.id;
    token.artist = await login('standin@fresh.test');
    // The Quick Tour's overlays sit over the whole screen; dismissed the way the app does it.
    await as('artist', '/auth/tour-seen', { method: 'POST' });

    const client = await as('owner', '/clients', { method: 'POST', body: { name: 'Fresh Co' } });
    const project = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Alpha', clientId: client.body.client.id } });
    id.A = project.body.project.id;

    /* ONE ASSET OF THEIR OWN, so the project is in their picker and the board has a row
       before the change. This is the exact state the bug was reported from: an artist who
       can see the project because they have work in it, and who then stands in for its lead
       and still sees only their own work. */
    const newAsset = async (code, status, assignee = null) => {
      const assetId = crypto.randomUUID();
      await sql(cfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id) VALUES (?,?,?,?,?,?,?)',
        [assetId, id.A, code, `Asset ${code}`, 'character', status, assignee]);
      return assetId;
    };
    await newAsset('A-MINE', 'in_progress', id.artist);
    for (const status of STATUSES) await newAsset(`A-${status.slice(0, 5).toUpperCase()}`, status);

    browser = await chromium.launch({
      executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('dialog', async (d) => { natives.push(d.type()); await d.dismiss(); });
    page.on('request', (r) => requests.push({ at: Date.now(), url: r.url() }));

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#loginEmail');
    await page.fill('#loginEmail', 'standin@fresh.test');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForFunction('typeof state !== "undefined" && !!state.token',
      null, { timeout: 45000 });
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  });

  await t.test('before: the Assets List shows their own work and nothing else', async () => {
    await page.click('[data-tab="list"]');
    await page.waitForFunction('typeof state !== "undefined" && state.currentProjectId',
      null, { timeout: 45000 });
    await page.waitForFunction('(state.assets || []).length === 1', null, { timeout: 45000 });
    const codes = await page.evaluate(() => (state.assets || []).map((a) => a.code));
    assert.deepStrictEqual(codes, ['A-MINE'], 'the project is theirs to open, the work is not');

    /* A VALUE THAT A RELOAD WOULD DESTROY. Asserted at the end, so "the board filled" cannot
       be satisfied by the page having quietly started again. */
    await page.evaluate(() => { window.__sameDocument = 'yes'; });
  });

  await t.test('the owner names them Acting TL, and the board fills on its own', async () => {
    const markAt = Date.now();
    const edit = await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [id.artist] } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));

    /* NOT A CLICK, NOT A RELOAD, NOT A NAVIGATION between the save above and the assertion
       below: the only thing that happens in this window is the application's own interval. */
    try {
      await page.waitForFunction('(state.assets || []).length === 7', null, { timeout: WITHIN });
    } catch (err) {
      /* A timeout here is the bug coming back, so the report says enough to tell that
         apart from a slow machine: what the page thinks its memberships are, how many
         assets it is holding, and how many times it has read /auth/me. */
      const diag = await page.evaluate(() => ({
        teams: state.projectTeams, assets: (state.assets || []).length,
        project: state.currentProjectId, view: state.view }));
      const me = requests.filter((r) => /\/api\/auth\/me/.test(r.url)).length;
      throw new Error(`${err.message}\n  page: ${JSON.stringify(diag)}\n  /auth/me reads: ${me}`);
    }
    const took = Date.now() - markAt;
    console.log(`    the board filled by itself after ${Math.round(took / 1000)}s`);

    const codes = await page.evaluate(() => (state.assets || []).map((a) => a.code).sort());
    assert.strictEqual(codes.length, STATUSES.length + 1);
    assert.ok(codes.includes('A-DELIV') && codes.includes('A-PENDI'),
      `every stage, not just the open ones: ${codes.join(' ')}`);

    assert.strictEqual(await page.evaluate(() => window.__sameDocument), 'yes',
      'the page reloaded — which is the thing this test exists to rule out');
    assert.ok(took < WITHIN, `it took ${Math.round(took / 1000)}s`);

    /* AND IT WAS A POLL THAT DID IT. At least one read of /auth/me landed inside the
       window, which is the mechanism this fix uses — not a page event, not a click. */
    const during = requests.filter((r) => r.at >= markAt && /\/api\/auth\/me/.test(r.url));
    assert.ok(during.length >= 1, 'the membership read that carried this was the poll');

    /* AND THE ROWS ARE REALLY DRAWN, not only in state: a membership change that updates the
       data and leaves the screen alone is the same complaint in a different place. Read from
       the rendered text of the view, because the tick boxes an asset row can carry are a
       separate permission and an artist does not get them — asserting on [data-pick] would
       be asserting that the stand-in gained an action, which they must not have. */
    const onScreen = await page.evaluate(() => document.getElementById('listView').textContent);
    /* WHICH CODES BELONG ON THE TAB BEING LOOKED AT, asked of the page's own listTabOf()
       rather than mapped here. The Assets List is grouped — Active, Inactive, Archived,
       History — and Delivered work lives on Archived, so a test that expected every row on
       one tab would fail for a reason that has nothing to do with this fix. */
    const expected = await page.evaluate(() => (state.assets || [])
      .filter((a) => listTabOf(a) === state.listGroup).map((a) => a.code));
    assert.ok(expected.length > 1, `the tab has more than the one row it had: ${expected}`);
    for (const code of expected) {
      assert.ok(onScreen.includes(code),
        `${code} is on the screen, not only in state: ${onScreen.slice(0, 240)}`);
    }
    assert.ok(expected.some((c) => c !== 'A-MINE'),
      'and at least one of them is somebody else\'s work');

    /* The Delivered row too, on the tab it really lives on — one click, after the board had
       already filled by itself. */
    await page.click('[data-group="archived"]');
    await page.waitForFunction('state.listGroup === "archived"', null, { timeout: 45000 });
    assert.match(await page.evaluate(() => document.getElementById('listView').textContent),
      /A-DELIV/, 'the Delivered asset is on the Archived tab');
    await page.click('[data-group="active"]');
  });

  await t.test('and it is the interval that was already running, not a new one', async () => {
    /* NO SECOND POLLING LOOP. The membership read rides on /auth/me, which the notification
       interval was already asking for. So: no new endpoint, and no more /auth/me reads than
       that interval can account for over the window this test has been open. */
    const seen = requests.map((r) => r.url.replace(origin, ''));
    const novel = seen.filter((u) => /project-?teams|memberships|acting/i.test(u));
    assert.deepStrictEqual(novel, [],
      `the page polls a new endpoint for memberships: ${novel.join(', ')}`);

    const me = requests.filter((r) => /\/api\/auth\/me/.test(r.url));
    const span = (me[me.length - 1].at - me[0].at) / 1000;
    /* The permission read is throttled to 20s inside a 30s interval, so one per 20 seconds
       is the ceiling; the +3 is the sign-in read and the slack of a single cycle. */
    const ceiling = Math.ceil(span / 20) + 3;
    assert.ok(me.length <= ceiling,
      `${me.length} reads of /auth/me in ${Math.round(span)}s — the ceiling is ${ceiling}`);
  });

  await t.test('taking them off it empties the board again, on its own', async () => {
    const edit = await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [] } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));

    await page.waitForFunction('(state.assets || []).length === 1', null, { timeout: WITHIN });
    const codes = await page.evaluate(() => (state.assets || []).map((a) => a.code));
    assert.deepStrictEqual(codes, ['A-MINE'],
      'a stand-in who has been stood down sees their own work again');
    assert.strictEqual(await page.evaluate(() => window.__sameDocument), 'yes',
      'still the same document');
  });

  await t.test('a refetch that half fails draws nothing, and the next poll finishes it', async () => {
    /* ===========================================================================
     * THE FAILURE A FROZEN FULL-SUITE RUN FOUND, now its own test.
     *
     * applyPermissionChange() refetches two things when the memberships move: the
     * project list, then the board. refreshProjects() swallows its error and
     * answers false, and that answer used to be ignored — so a transient failure
     * left state.projects empty while loadAssets() happily filled state.assets,
     * and the screen read "No projects assigned to you yet" over a board that had
     * every row of the project. Told to somebody who had just been given it.
     *
     * Reproduced here by failing the request itself, once: Playwright aborts the
     * next GET /api/projects and lets everything after it through. What must
     * happen is that the page draws NOTHING rather than half of it, and picks the
     * membership up on the following poll — which only works because the flag
     * goes back up when the refetch fails.
     */
    const owner = await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [id.artist] } });
    assert.strictEqual(owner.status, 200, JSON.stringify(owner.body));

    let aborted = 0;
    const once = async (route) => {
      if (aborted === 0 && /\/api\/projects(\?|$)/.test(route.request().url())) {
        aborted += 1;
        return route.abort('failed');
      }
      return route.continue();
    };
    await page.route('**/api/projects*', once);

    try {
      /* Wait for the failure to have happened, which is the poll arriving. */
      await page.waitForFunction('typeof state !== "undefined"', null, { timeout: 5000 });
      const start = Date.now();
      while (aborted === 0 && Date.now() - start < WITHIN) {
        await page.waitForTimeout(500);
      }
      assert.strictEqual(aborted, 1, 'the project fetch was failed once');

      /* THE SCREEN MUST NOT BE HALF-DRAWN. Checked immediately after the failed
         tick: the board still shows their own work, and nowhere does it claim
         they have no projects. */
      const text = await page.evaluate(() => document.getElementById('listView').textContent);
      assert.ok(!/No projects assigned to you yet/.test(text),
        `a failed refetch must not tell them they have no projects: ${text.slice(0, 160)}`);
      assert.ok(await page.evaluate(() => (state.projects || []).length > 0),
        'and the project list it already had is still there');
    } finally {
      await page.unroute('**/api/projects*', once);
    }

    /* AND THE FOLLOWING POLL FINISHES THE JOB. The flag went back up, so the next
       tick refetches both and the board fills — late, but correct, and without
       anybody touching the page. */
    await page.waitForFunction('(state.assets || []).length === 7', null, { timeout: WITHIN });
    assert.strictEqual(await page.evaluate(() => window.__sameDocument), 'yes',
      'still the same document');

    // Back to where the suite found things.
    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      actingTeamLeadIds: [] } })).status, 200);
    await page.waitForFunction('(state.assets || []).length === 1', null, { timeout: WITHIN });
  });

  await t.test('no page errors, no native dialogs', () => {
    assert.deepStrictEqual(natives, [], 'a native dialog was opened');
    /* TWO LINES ARE THE TEST'S OWN DOING, allowed by name rather than by a vague
       pattern that would also hide a real one.
       
       favicon.ico: Chrome asks for it itself on a bare origin and logs its own 404.
       
       ERR_FAILED: the subtest above aborts one GET /api/projects on purpose, to
       prove a half-failed refetch draws nothing. Chrome logs every aborted
       request, so the line is the proof that the test did what it said. */
    const real = errors.filter((e) => !/favicon\.ico/.test(e))
      .filter((e) => !/net::ERR_FAILED/.test(e));
    assert.deepStrictEqual(real, [], `the page logged errors:\n${real.join('\n')}`);
  });
});
