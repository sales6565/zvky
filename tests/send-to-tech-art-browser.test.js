/* THE TWO BUTTONS, IN A REAL BROWSER, against the real server and the real page.
 *
 * ===========================================================================
 * WHAT ONLY A BROWSER CAN ANSWER HERE.
 *
 * tests/send-to-tech-art.test.js proves the server does the right thing when asked. This
 * suite is about the asking: that there are two buttons rather than one button and a
 * dropdown, that they look like equals, that the Tech Art one is not tucked inside the
 * other's menu, and that the tick box this change removes is no longer on the Edit screen
 * — not disabled, not hidden, not moved. Every one of those is a statement about what a
 * person sees, and a server test cannot make it.
 *
 * It walks the brief's twelve steps in order, in one browser, against one project.
 *
 * NO NATIVE DIALOGS: the desktop web view has none, so a native one appearing fails the
 * run. The page's own modal is what the send goes through.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

let chromium;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('techartui');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'TechArtUI-Test-1!';

/* ===========================================================================
 * THE PAGE'S SIDE AS SOURCE, and this block never skips.
 *
 * A machine with no Chromium still has to be told if the tick box came back or if one of
 * the buttons went missing, because both are invisible failures: the screen simply has one
 * fewer control and nothing says so. This is the lesson from Prompt 70b, where a feature's
 * whole server side worked and its Settings section had never been built.
 */
test('the page offers two sends and no Tech Art tick box', () => {
  const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // 1. Two bulk actions, each with its own key, in one list.
  assert.match(PAGE, /key:'sendToDev', label:'Send to Dev'/);
  assert.match(PAGE, /key:'sendToTechArt', label:'Send to Tech Art'/);
  assert.match(PAGE, /function mayBulkSendToTechArt\(\)\{ return can\('integration\.send_to_tech_art'\); \}/,
    'the second action asks its own permission');

  /* 2. NEITHER IS NESTED IN THE OTHER. Both are pushed into bulkActions(), which is the
     one list the bar draws from — so they are rendered by the same code at the same size,
     and one cannot become a menu item inside the other without this changing. */
  const actions = PAGE.slice(PAGE.indexOf('function bulkActions()'), PAGE.indexOf('function bulkSelectable'));
  assert.match(actions, /sendToDev[\s\S]*sendToTechArt/, 'both in bulkActions, Dev first');
  /* COMMENTS STRIPPED FIRST. The check is about the code, and the comment above these two
     lines explains what the removed dropdown used to do — so searching the raw slice for
     the word found my own explanation of its absence. */
  const actionCode = actions.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/<select|dropdown/i.test(actionCode), 'and neither is a dropdown');

  // 3. The dropdown that used to hide Tech Art is gone from the modal.
  assert.ok(!PAGE.includes('id="sd_kind"'), 'the kind dropdown is gone');
  assert.ok(!PAGE.includes('<option value="tech_art">'), 'and so is its option');
  assert.match(PAGE, /id="sd_destination"/, 'the modal names the destination instead');

  // 4. No editable Tech Art control anywhere.
  assert.ok(!PAGE.includes('id="d_techArt"'), 'the tick box is gone');
  assert.ok(!/<input type="checkbox"[^>]*techArt/i.test(PAGE), 'and no checkbox like it');
  assert.ok(!PAGE.includes("/tech-art'"), 'and nothing calls the route it used');
  assert.ok(!PAGE.includes('needsTechArt'), 'and nothing sends that field');
  /* The words may still appear in a comment explaining the removal and in the read-only
     legacy line, but not as a label on a control. */
  assert.ok(!/<span>Needs a Tech Art pass<\/span>/.test(PAGE), 'no label for a removed control');
});

test('Send to Dev and Send to Tech Art, in Chrome', { skip: SKIP }, async (t) => {
  let server; let browser; let page; let context;
  let origin;
  const token = {};
  const ids = {};
  const errors = [];
  const natives = [];

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

  const newAsset = async (name, type) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
      [id, ids.project, `UI-${name.slice(0, 3).toUpperCase()}`, name, type, 'in_progress']);
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'ta-ui', WORK_HOURS_SWEEP_MINUTES: '0' });
    origin = server.base.replace(/\/api$/, '');
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'ta-ui', name: 'Akilesh', email: 'akilesh@zvky.test', password: PASSWORD } });
    token.root = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'akilesh@zvky.test', password: PASSWORD } })).body.token;
    /* The Quick Tour lays overlays across the page that intercept every click; dismissed
       through the endpoint the application itself uses for it. */
    await as('root', '/auth/tour-seen', { method: 'POST' });

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects',
      { method: 'POST', body: { name: 'Dragon Game', clientId: client.body.client.id } });
    ids.project = project.body.project.id;
    ids.art = await newAsset('Dragon_Win_01', 'character');
    ids.animation = await newAsset('Dragon_Fly_Loop', 'animation');

    browser = await chromium.launch({
      executablePath: EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('dialog', async (d) => { natives.push(d.type()); await d.dismiss(); });

    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#loginEmail');
    await page.fill('#loginEmail', 'akilesh@zvky.test');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginBtn');
    /* `state` is a top-level const in a classic script: a global LEXICAL binding, not a
       property of window. A bare name resolves; window.state never will. */
    await page.waitForFunction('typeof state !== "undefined" && !!state.token',
      null, { timeout: 45000 });
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  });

  /* The Assets List, which is where the bulk actions live, with one asset ticked. */
  async function pick(assetId) {
    await page.click('[data-tab="list"]');
    await page.waitForSelector(`[data-pick="${assetId}"]`, { timeout: 45000 });
    const already = await page.$eval(`[data-pick="${assetId}"]`, (el) => el.checked);
    if (!already) await page.click(`[data-pick="${assetId}"]`);
    await page.waitForSelector('.bulk-bar', { timeout: 45000 });
  }

  async function unpickAll() {
    await page.evaluate(() => { selectedAssets.clear(); return render(); });
  }

  const buttonLabels = () => page.$$eval('.bulk-bar [data-bulk]',
    (bs) => bs.map((b) => ({ key: b.dataset.bulk, label: b.textContent.trim(), cls: b.className })));

  /* ------------------------------------------------- steps 1-3: both buttons */

  await t.test('an Art asset offers Send to Dev and Send to Tech Art, as equals', async () => {
    await pick(ids.art);
    const buttons = await buttonLabels();
    const byKey = new Map(buttons.map((b) => [b.key, b]));
    assert.ok(byKey.has('sendToDev'), `Send to Dev is offered: ${JSON.stringify(buttons)}`);
    assert.ok(byKey.has('sendToTechArt'), `Send to Tech Art is offered: ${JSON.stringify(buttons)}`);
    /* The bar appends how many rows the action reaches — "Send to Dev (1)" — so the label
       is matched from the start rather than whole. */
    assert.match(byKey.get('sendToDev').label, /^Send to Dev\b/);
    assert.match(byKey.get('sendToTechArt').label, /^Send to Tech Art\b/);

    /* EQUAL VISUAL IMPORTANCE, asserted rather than eyeballed: the same classes, so the
       same size and the same weight. The brief's "[Send to Dev] [Send to Tech Art]" is a
       statement about rank, and sharing the button class is what makes it true. */
    assert.strictEqual(byKey.get('sendToTechArt').cls, byKey.get('sendToDev').cls,
      'the two buttons are styled identically');

    // Both are visible, side by side, not behind a menu.
    assert.ok(await page.isVisible('#bulk_sendToDev'));
    assert.ok(await page.isVisible('#bulk_sendToTechArt'));
  });

  /* ------------------------------------------------- steps 4-5: the Edit screen */

  await t.test('Edit Asset has no Needs a Tech Art pass control', async () => {
    await page.evaluate((id) => openDrawer(id), ids.art);
    await page.waitForSelector('#d_priority', { timeout: 45000 });

    /* THE CONTROL IS ABSENT, not disabled and not hidden — all three would look the same
       to a screenshot and only one is what the brief asks for. */
    assert.strictEqual(await page.$('#d_techArt'), null, 'the tick box is gone');
    const drawerText = await page.$eval('#drawer', (el) => el.textContent);
    assert.ok(!/Needs a Tech Art pass/.test(drawerText),
      'and its label is nowhere on the Edit screen');

    /* AND NO OTHER CHECKBOX QUIETLY TOOK ITS PLACE. Every checkbox left in the drawer is
       listed, so a Tech Art control reappearing under another id fails here. */
    const boxes = await page.$$eval('#drawer input[type="checkbox"]',
      (els) => els.map((e) => `${e.id}|${(e.closest('label') || {}).textContent || ''}`.trim()));
    assert.ok(!boxes.some((b) => /tech ?art/i.test(b)), `no Tech Art checkbox: ${boxes.join(' , ')}`);

    await page.evaluate(() => closeDrawer());
  });

  /* ------------------------------------------------- steps 6-7: send Art to Tech Art */

  await t.test('the Art asset goes to Tech Art, and the screen says so', async () => {
    await unpickAll();
    await pick(ids.art);
    await page.click('#bulk_sendToTechArt');
    await page.waitForSelector('#sendToDevWrap.show', { timeout: 45000 });

    /* THE MODAL SAYS WHERE IT IS GOING, before the send. This is what replaced the
       dropdown: the destination is stated, not chosen again. */
    assert.match(await page.$eval('#sd_title', (e) => e.textContent), /Send to Tech Art/);
    assert.match(await page.$eval('#sd_destination', (e) => e.textContent), /Tech Art/);
    assert.strictEqual(await page.$('#sd_kind'), null, 'and there is no dropdown to get it wrong');
    /* The asset's own discipline is shown beside it, so the two concepts are visibly
       separate on the one screen where they could be confused. */
    assert.match(await page.$eval('#sd_list', (e) => e.textContent), /Art/);
    assert.match(await page.$eval('#sd_confirm', (e) => e.textContent), /Send to Tech Art/);

    await page.click('#sd_confirm');
    await page.waitForFunction(
      'document.getElementById("sd_results") && /Sent to Tech Art/.test(document.getElementById("sd_results").textContent)',
      null, { timeout: 45000 });

    /* AND THE RECORD AGREES WITH THE SCREEN — found by the ASSET, not by "the latest row".
     *
     * handoffs.created_at is second-granular and the primary key is a random UUID, so two
     * sends in the same second have no reliable order: "ORDER BY created_at DESC LIMIT 1"
     * returned the wrong one of the two sends in this suite, which is how this comment
     * came to be written. The asset is what the assertion is actually about. */
    const forArt = await sql(cfg,
      'SELECT h.id, h.kind FROM handoffs h JOIN handoff_assets ha ON ha.handoff_id = h.id '
      + 'WHERE ha.asset_id = ?', [ids.art]);
    assert.strictEqual(forArt.length, 1, 'exactly one hand-off carries it');
    assert.strictEqual(forArt[0].kind, 'tech_art');

    await page.click('#sd_cancel');
  });

  await t.test('the history names the destination and the sender', async () => {
    await page.evaluate((id) => openDrawer(id), ids.art);
    await page.waitForFunction(
      'document.getElementById("d_history") && !/Loading/.test(document.getElementById("d_history").textContent)',
      null, { timeout: 45000 });
    const history = await page.$eval('#d_history', (e) => e.textContent);
    assert.match(history, /Sent out/, 'the row is labelled, not shown as a bare action id');
    assert.match(history, /Sent to Tech Art/, 'and says which destination');
    assert.match(history, /Akilesh/, 'and who sent it');
    await page.evaluate(() => closeDrawer());
  });

  /* --------------------------------- steps 8-11: the Animation asset to Development */

  await t.test('an Animation asset offers both buttons too', async () => {
    await unpickAll();
    await pick(ids.animation);
    const keys = (await buttonLabels()).map((b) => b.key);
    assert.ok(keys.includes('sendToDev'), JSON.stringify(keys));
    assert.ok(keys.includes('sendToTechArt'), JSON.stringify(keys));
  });

  await t.test('it goes to Development and stays an Animation', async () => {
    /* THE PAIR THE BRIEF ASKS FOR, through the interface: an animation sent to
       Development. Destination and discipline disagree in the sense that one is not the
       other, which is exactly what has to survive the trip. */
    await page.click('#bulk_sendToDev');
    await page.waitForSelector('#sendToDevWrap.show', { timeout: 45000 });
    assert.match(await page.$eval('#sd_title', (e) => e.textContent), /Send to Dev/);
    assert.match(await page.$eval('#sd_destination', (e) => e.textContent), /Development/);
    /* The list says Animation while the destination says Development — the two concepts,
       on screen, at the same time, not agreeing with each other. */
    assert.match(await page.$eval('#sd_list', (e) => e.textContent), /Animation/);

    await page.click('#sd_confirm');
    await page.waitForFunction(
      'document.getElementById("sd_results") && /Sent to Development/.test(document.getElementById("sd_results").textContent)',
      null, { timeout: 45000 });
    await page.click('#sd_cancel');

    const forAnim = await sql(cfg,
      'SELECT h.id, h.kind FROM handoffs h JOIN handoff_assets ha ON ha.handoff_id = h.id '
      + 'WHERE ha.asset_id = ?', [ids.animation]);
    assert.strictEqual(forAnim.length, 1, 'exactly one hand-off carries it');
    assert.strictEqual(forAnim[0].kind, 'partial_drop', 'stored as a partial drop: Development');

    /* THE DELIVERED CONTRACT, read from the outbox: destination development, discipline
       animation. The browser cannot see this, which is why it is checked here rather than
       assumed from the screen. Matched on the hand-off id for the same reason as above. */
    const rows = (await sql(cfg,
      "SELECT payload FROM integration_outbox WHERE event_type = 'handoff.created' ORDER BY seq"))
      .map((r) => JSON.parse(r.payload))
      .filter((e) => e.payload.handoffId === forAnim[0].id);
    assert.strictEqual(rows.length, 1, 'one event for it');
    const payload = rows[0].payload;
    assert.strictEqual(payload.destination, 'development');
    assert.strictEqual(payload.assets[0].discipline, 'animation',
      'the animation is still an animation');
    assert.strictEqual(payload.assets[0].id, ids.animation);
  });

  /* ------------------------------------------------------- step 12: no errors */

  await t.test('no native dialogs and no page errors throughout', () => {
    assert.deepStrictEqual(natives, [], 'a native dialog was opened');
    /* The browser's own unasked-for request for /favicon.ico is not an error of this
       application's making; everything else is. */
    const real = errors.filter((e) => !/favicon\.ico/.test(e));
    assert.deepStrictEqual(real, [], `the page logged errors:\n${real.join('\n')}`);
  });
});
