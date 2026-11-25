/* ADDING PEOPLE TO A GROUP, IN CHROME, AND THE CONTROL APPEARING IN SOMEBODY
 * ELSE'S OPEN SESSION.
 *
 * ===========================================================================
 * WHY THIS SUITE AND NOT MORE ROUTE TESTS.
 *
 * The server half is covered in tests/role-group-users.test.js, down to the
 * resolution table. Two things it cannot see:
 *
 *   THE EDITOR IS USABLE. A searchable multi-select is the first piece of this
 *   screen that is not a grid of checkboxes: a draft that survives typing, chips
 *   that come and go, a count, and a save that applies two lists in one press.
 *   Every one of those is a thing a response body cannot show.
 *
 *   THE PERMISSION ARRIVES WITHOUT A RELOAD. The brief's freshness requirement
 *   is about somebody else's browser: they are signed in, looking at the screen,
 *   and a control has to appear on the poll that was already running. This waits
 *   for the application's own interval rather than calling the poll by hand,
 *   because a test that poked applyPermissionChange() would pass with the
 *   interval deleted.
 *
 * TWO CONTEXTS, ONE BROWSER: the owner's session and the artist's, so "the owner
 * saves and the artist's open page changes" is literally what is acted out.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

let chromium;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('rgui');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'RgUi-Test-1!';

/* The page's own numbers are NOTIF_POLL_MS 30s and PERMISSION_REFRESH_MS 20s, so
   a change lands about half a minute after the save. Three intervals of slack,
   for the reason the Prompt 72 freshness suite carries it: a browser test that
   waits exactly one tick fails on a loaded machine for reasons that have nothing
   to do with the code, and a flaky guard gets deleted by the next person. The
   time it actually took is printed, and the request count is what pins the
   cadence. */
const WITHIN = 110000;

/* The key the group grants, and the control it draws. report.artist_report puts
   the Artist Report in the Reports tab and opens GET /api/reports/artist; an
   artist holds neither. */
const KEY = 'report.artist_report';

test('role group members, in Chrome', { skip: SKIP }, async (t) => {
  let server; let browser; let origin;
  let ownerPage; let anaPage;
  const token = {};
  const id = {};
  const errors = [];
  const natives = [];
  const anaRequests = [];

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });

  const signIn = async (page, email) => {
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#loginEmail');
    await page.fill('#loginEmail', email);
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForFunction('typeof state !== "undefined" && !!state.token', null, { timeout: 45000 });
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'rgui', WORK_HOURS_SWEEP_MINUTES: '0' });
    origin = server.base.replace(/\/api$/, '');
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'rgui', name: 'Owner', email: 'owner@rgui.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@rgui.test');
    await as('owner', '/auth/tour-seen', { method: 'POST' });

    const make = async (key, name, role) => {
      const r = await as('owner', '/users', { method: 'POST', body: {
        name, email: `${key}@rgui.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
      token[key] = await login(`${key}@rgui.test`);
      // The Quick Tour's overlays intercept every click; dismissed the way the app does.
      await as(key, '/auth/tour-seen', { method: 'POST' });
      return r.body.user.id;
    };
    id.ana = await make('ana', 'Ana Ruiz', 'game_artist');
    id.ben = await make('ben', 'Ben Olsen', 'game_animator');

    /* A group that grants the key, with game_animator already in it — so Ben is
       the "already included via role" case and Ana is not. */
    const made = await as('owner', '/role-groups', { method: 'POST',
      body: { name: 'Release Managers', kind: 'custom' } });
    id.group = made.body.group.id;
    assert.strictEqual((await as('owner', `/role-groups/${id.group}/permissions`,
      { method: 'PUT', body: { permissions: [KEY] } })).status, 200);
    assert.strictEqual((await as('owner', `/role-groups/${id.group}/roles`,
      { method: 'PUT', body: { roles: ['game_animator'] } })).status, 200);

    browser = await chromium.launch({
      executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const watch = (page, label) => {
      page.on('pageerror', (e) => errors.push(`${label}: ${e && e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
      page.on('dialog', async (d) => { natives.push(`${label}: ${d.type()}`); await d.dismiss(); });
    };

    ownerPage = await (await browser.newContext()).newPage();
    watch(ownerPage, 'owner');
    anaPage = await (await browser.newContext()).newPage();
    watch(anaPage, 'ana');
    anaPage.on('request', (r) => anaRequests.push({ at: Date.now(), url: r.url() }));

    await signIn(ownerPage, 'owner@rgui.test');
    await signIn(anaPage, 'ana@rgui.test');
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  });

  /* The group editor, open, with the card expanded.
   *
   * THE SETTINGS SECTIONS ARE AN ACCORDION, and finding that out cost this suite
   * its first run: every section's markup is in the DOM from the moment Settings
   * renders, but a collapsed one is hidden — so `[data-rg-open]` was present,
   * matched by a query, and never clickable. Playwright waited thirty seconds for
   * it to become visible and reported it as a locator that never resolved.
   *
   * Expanded through the page's own openSettingsSection(), which is what the
   * Settings index buttons call, rather than by clicking the heading: the
   * accordion keys off the heading's text and the state lives in a Set, so a test
   * that reached in and toggled classes would be a second copy of that. */
  const openEditor = async () => {
    await ownerPage.click('[data-tab="settings"]');
    await ownerPage.waitForSelector('[data-section="role-groups"]', { timeout: 45000 });
    await ownerPage.evaluate(() => openSettingsSection('Role Groups'));
    await ownerPage.waitForSelector(`[data-rg-open="${id.group}"]`, { state: 'visible', timeout: 45000 });

    const open = await ownerPage.$(`[data-group="${id.group}"] #rg_user_search`);
    if (!open) {
      await ownerPage.click(`[data-rg-open="${id.group}"]`);
      await ownerPage.waitForSelector('#rg_user_search', { timeout: 45000 });
    }
  };

  const chips = () => ownerPage.$$eval('.rg-chip', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));

  await t.test('the artist has no Artist Report before anything happens', async () => {
    const held = await anaPage.evaluate(() => (state.currentUser.permissions || []));
    assert.ok(!held.includes(KEY.replace('report.artist_report', 'report.artist_report')),
      'not held at sign-in');
    assert.strictEqual(await anaPage.evaluate((k) => can(k), KEY), false,
      'and can() says so, which is what draws the control');
    /* A VALUE A RELOAD WOULD DESTROY, so "the control appeared" cannot later be
       satisfied by the page having quietly started again. */
    await anaPage.evaluate(() => { window.__sameDocument = 'yes'; });
  });

  await t.test('the editor searches, chips what it finds, and counts it', async () => {
    await openEditor();
    assert.deepStrictEqual(await chips(), [], 'no users in the group yet');

    await ownerPage.fill('#rg_user_search', 'Ana');
    await ownerPage.waitForSelector('[data-rg-add]', { timeout: 45000 });
    const hits = await ownerPage.$$eval('[data-rg-add]',
      (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(hits.length, 1, `one match: ${hits.join(' | ')}`);
    assert.match(hits[0], /Ana Ruiz/);
    assert.match(hits[0], /Artist/, 'and the result says their role');

    await ownerPage.click('[data-rg-add]');
    assert.deepStrictEqual((await chips()).length, 1, 'clicking a result makes a chip');
    assert.match((await chips())[0], /Ana Ruiz/);

    /* THE DRAFT SURVIVES TYPING, which is the whole reason it exists: Ana's chip
       has no checkbox to be found in once the search term no longer matches her. */
    await ownerPage.fill('#rg_user_search', 'Ben');
    await ownerPage.waitForSelector('[data-rg-add]', { timeout: 45000 });
    assert.strictEqual((await chips()).length, 1, 'Ana is still selected');
    await ownerPage.click('[data-rg-add]');
    const two = await chips();
    assert.strictEqual(two.length, 2, 'and now there are two');

    /* BEN IS MARKED, because game_animator is in this group already — the server
       decides that and the chip shows it. */
    const ben = two.find((c) => /Ben Olsen/.test(c));
    assert.match(ben, /already included via role/, `Ben is marked: ${ben}`);
    const ana = two.find((c) => /Ana Ruiz/.test(c));
    assert.ok(!/already included via role/.test(ana), `and Ana is not: ${ana}`);

    const count = await ownerPage.$eval('#rg_users_block',
      (e) => e.textContent.replace(/\s+/g, ' '));
    assert.match(count, /2 users selected/);
    assert.match(count, /1 of them already covered by a role/);

    /* AND NOTHING IS SAVED YET: the server still has no direct members. */
    const members = await as('owner', `/role-groups/${id.group}/members`);
    assert.deepStrictEqual(members.body.users, [], 'the draft is a draft');
  });

  await t.test('the note is on the screen, in the words the brief asks for', async () => {
    const text = await ownerPage.$eval(`[data-group="${id.group}"]`,
      (e) => e.textContent.replace(/\s+/g, ' '));
    assert.match(text, /Users get this group's permissions in addition to their role's permissions/);
    assert.match(text, /Members/);
  });

  await t.test('saving applies both lists, in the page, with no native dialog', async () => {
    const markAt = Date.now();
    await ownerPage.click('#rg_save_members');
    /* THE TOAST, not the line under the button: renderRoleGroups() replaces the
       whole section after a save, which erases that line. Waiting for it is what
       found that — the summary was being written and then redrawn over, so the
       owner never read it. */
    await ownerPage.waitForFunction(
      'document.getElementById("toast") && /user\\(s\\) added/.test(document.getElementById("toast").textContent)',
      null, { timeout: 45000 });
    const said = await ownerPage.$eval('#toast', (e) => e.textContent);
    assert.match(said, /2 user\(s\) added/, `the page says what happened: ${said}`);
    /* AND THAT THE ROLES HALF RAN IN THE SAME PRESS. Nought of them moved, which
       is the right answer — game_animator was already ticked because it is
       already in the group — and the figure being reported at all is what shows
       both lists were sent. */
    assert.match(said, /0 role change\(s\)/,
      `the roles half ran and found nothing to do: ${said}`);

    /* IN-PAGE ONLY — asserted for the whole suite at the end as well, but this is
       the press that would have raised one. */
    assert.deepStrictEqual(natives, []);

    const members = await as('owner', `/role-groups/${id.group}/members`);
    assert.strictEqual(members.body.users.length, 2);
    assert.strictEqual(members.body.counts.usersAlreadyViaRole, 1);
    assert.ok(Date.now() - markAt < 45000);
  });

  await t.test('the artist\'s open page grows the control on its own', async () => {
    const markAt = Date.now();
    try {
      await anaPage.waitForFunction((k) => can(k), KEY, { timeout: WITHIN });
    } catch (err) {
      const diag = await anaPage.evaluate(() => ({
        perms: (state.currentUser.permissions || []).length, view: state.view }));
      const me = anaRequests.filter((r) => /\/api\/auth\/me/.test(r.url)).length;
      throw new Error(`${err.message}\n  page: ${JSON.stringify(diag)}\n  /auth/me reads: ${me}`);
    }
    const took = Date.now() - markAt;
    console.log(`    the key arrived by itself after ${Math.round(took / 1000)}s`);

    assert.ok((await anaPage.evaluate(() => state.currentUser.permissions)).includes(KEY),
      'the permission is in the page\'s own copy of the session');
    assert.strictEqual(await anaPage.evaluate(() => window.__sameDocument), 'yes',
      'and the page did not reload — which is the thing this test exists to rule out');

    /* AND THE SERVER AGREES FOR THAT SESSION'S TOKEN, so what arrived is a real
       permission and not a page-side guess. */
    const route = await as('ana', '/reports/artist?from=2026-01-01&to=2026-01-31');
    assert.strictEqual(route.status, 200, `the route opened too: ${JSON.stringify(route.body)}`);
  });

  await t.test('and it was the poll that carried it, not a new loop', async () => {
    const seen = anaRequests.map((r) => r.url.replace(origin, ''));
    const novel = seen.filter((u) => /role-?group|membership/i.test(u));
    assert.deepStrictEqual(novel, [],
      `the artist's page polls a group endpoint: ${novel.join(', ')}`);

    const me = anaRequests.filter((r) => /\/api\/auth\/me/.test(r.url));
    assert.ok(me.length >= 2, 'the permission poll ran');
    const span = (me[me.length - 1].at - me[0].at) / 1000;
    /* The read is throttled to 20s inside a 30s interval, so one per 20 seconds
       is the ceiling; +3 for the sign-in read and a cycle of slack. */
    const ceiling = Math.ceil(span / 20) + 3;
    assert.ok(me.length <= ceiling,
      `${me.length} reads of /auth/me in ${Math.round(span)}s — the ceiling is ${ceiling}`);
  });

  await t.test('removing one takes the control away again, on its own', async () => {
    await openEditor();
    assert.strictEqual((await chips()).length, 2, 'both chips are there after the card redrew');

    /* HER OWN CHIP'S REMOVE BUTTON, BY THE ID IT CARRIES. The first version of
       this walked the chips in page context looking for her name and then
       reached into the handle it got back for the button; the id on the button
       is both simpler and immune to how the name happens to be rendered. */
    await ownerPage.click(`[data-rg-drop="${id.ana}"]`);
    const left = await chips();
    assert.deepStrictEqual(left.filter((t) => /Ana Ruiz/.test(t)), [], 'her chip is gone');
    assert.strictEqual(left.length, 1, "and Ben's is not");

    await ownerPage.click('#rg_save_members');
    await ownerPage.waitForFunction(
      'document.getElementById("rg_roles_msg") && /removed/.test(document.getElementById("rg_roles_msg").textContent)',
      null, { timeout: 45000 });

    const markAt = Date.now();
    await anaPage.waitForFunction((k) => !can(k), KEY, { timeout: WITHIN });
    console.log(`    and went away again after ${Math.round((Date.now() - markAt) / 1000)}s`);
    assert.strictEqual(await anaPage.evaluate(() => window.__sameDocument), 'yes',
      'still the same document');
    assert.strictEqual((await as('ana', '/reports/artist?from=2026-01-01&to=2026-01-31')).status, 403,
      'and the route is closed again');
  });

  await t.test('the Users screen says who is also in a group', async () => {
    /* Ben is still a direct member — the save above removed only Ana. */
    await ownerPage.click('[data-tab="users"]');
    await ownerPage.waitForSelector('.userDetailBtn', { timeout: 45000 });
    await ownerPage.click(`.userDetailBtn[data-id="${id.ben}"]`);
    await ownerPage.waitForSelector('#ud_body', { timeout: 45000 });
    const panel = await ownerPage.$eval('#ud_body', (e) => e.textContent.replace(/\s+/g, ' '));
    assert.match(panel, /Also in groups/, `the panel says so: ${panel.slice(0, 300)}`);
    assert.match(panel, /Release Managers/);
    /* NO KEY NAMES: this panel is behind user.view, not the group screen's key. */
    assert.ok(!panel.includes(KEY), 'and names no permission');

    /* And Ana, who is no longer a direct member, has no such row. */
    await ownerPage.click('#closeUserDetail');
    await ownerPage.click(`.userDetailBtn[data-id="${id.ana}"]`);
    await ownerPage.waitForFunction(
      `document.getElementById('ud_body').textContent.includes('Ana Ruiz')`, null, { timeout: 45000 });
    const hers = await ownerPage.$eval('#ud_body', (e) => e.textContent);
    assert.ok(!/Also in groups/.test(hers), 'no row when there is nothing to say');
  });

  await t.test('no native dialogs, no page errors, in either session', () => {
    assert.deepStrictEqual(natives, [], 'a native dialog was opened');
    /* Chrome asks for /favicon.ico itself and logs its own 404; that line is the
       browser's, not the application's. The 403s this suite deliberately causes
       are logged by the page's fetch wrapper as console errors on the artist's
       side, so a refusal of the artist report is allowed by name. */
    const real = errors.filter((e) => !/favicon\.ico/.test(e))
      .filter((e) => !/reports\/artist/.test(e));
    assert.deepStrictEqual(real, [], `the pages logged errors:\n${real.join('\n')}`);
  });
});
