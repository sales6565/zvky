/* THE SCREEN THAT SAID "REFUSED" — the five stages, in a real browser.
 *
 * ===========================================================================
 * WHY THIS SUITE IS THE ONE THAT MATTERS FOR THIS FIX.
 *
 * The defect was invisible to the server: every send worked. The hand-off was created, the
 * event emitted, the outbox row written, the history updated — and the modal printed
 *
 *     REFUSED  COLORE-030
 *
 * in the danger colour, because the shared results renderer reads r.ok and the send route
 * answered with r.outcome. A test on the response body could not see it. A browser can:
 * it reads the words a person actually gets.
 *
 * So this walks the brief's steps in one browser — each of the five stages to Development,
 * then two of them to Tech Art — and for each one asserts three things that the bug broke
 * or threatened: the word on the row is a success, the row is not red, and the asset's
 * stage on the board is exactly what it was before the send.
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

const cfg = config('stageui');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'StageUI-Test-1!';

/* The five, by canonical id, with the code each asset will carry on screen — chosen to
   look like the ones in the report so a failure reads the way the complaint did. */
const STAGES = [
  { id: 'tl_approved', label: 'TL Approved', code: 'COLORE-030' },
  { id: 'approved_for_client', label: 'Approved for Client', code: 'COLORE-031' },
  { id: 'awaiting_client_feedback', label: 'Awaiting Client Feedback', code: 'COLORE-032' },
  { id: 'delivered', label: 'Delivered', code: 'COLORE-033' },
  { id: 'game_feedback', label: 'Game Feedback', code: 'COLORE-034' },
];

test('the five production stages send without a REFUSED, in Chrome', { skip: SKIP }, async (t) => {
  let server; let browser; let context; let page;
  let origin;
  const token = {};
  const ids = {};
  const assets = {};
  const errors = [];
  const natives = [];

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });

  const stageOf = async (id) => (await sql(cfg, 'SELECT `status` FROM assets WHERE id = ?', [id]))[0].status;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'stage-ui', WORK_HOURS_SWEEP_MINUTES: '0' });
    origin = server.base.replace(/\/api$/, '');
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'stage-ui', name: 'Akilesh', email: 'akilesh@stageui.test', password: PASSWORD } });
    token.root = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'akilesh@stageui.test', password: PASSWORD } })).body.token;
    // The Quick Tour's overlays intercept every click; dismissed the way the app does it.
    await as('root', '/auth/tour-seen', { method: 'POST' });

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Colore Co' } });
    const project = await as('root', '/projects',
      { method: 'POST', body: { name: 'Colore', clientId: client.body.client.id } });
    ids.project = project.body.project.id;

    /* One asset per stage, plus an animation in Delivered and one in Game Feedback for the
       Tech Art half — so the discipline is exercised on screen as well as in the payload. */
    for (const stage of STAGES) {
      const id = crypto.randomUUID();
      await sql(cfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
        [id, ids.project, stage.code, `Colore ${stage.label}`, 'character', stage.id]);
      assets[stage.id] = id;
    }
    for (const [key, status, code] of [['animDelivered', 'delivered', 'COLORE-040'],
      ['animGameFeedback', 'game_feedback', 'COLORE-041']]) {
      const id = crypto.randomUUID();
      await sql(cfg,
        'INSERT INTO assets (id, project_id, `code`, name, type, status) VALUES (?,?,?,?,?,?)',
        [id, ids.project, code, `Colore ${key}`, 'animation', status]);
      assets[key] = id;
    }

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
    await page.fill('#loginEmail', 'akilesh@stageui.test');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForFunction('typeof state !== "undefined" && !!state.token',
      null, { timeout: 45000 });
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  });

  /* Step 1 and 2: the Assets List, on the tab the asset actually lives on, with it ticked.
   *
   * THE TAB MATTERS, and finding that out cost a detour worth recording. The Assets List is
   * grouped — Active, Inactive, Archived, History — and ASSET_LIST_GROUPS puts `delivered`
   * under Archived on its own: "Archived is Delivered, and only Delivered." So a Delivered
   * asset has no row on the Active tab, which looked for a while like a missing tick box
   * and then like a filter dropping it. It is neither: the row is on another tab, where it
   * is perfectly selectable.
   *
   * The tab is asked of the page's own listTabOf() rather than mapped here, so this cannot
   * disagree with where the row really went. */
  async function select(assetId) {
    await page.click('[data-tab="list"]');
    const group = await page.evaluate((id) => {
      const a = (state.assets || []).find((x) => x.id === id);
      return a ? listTabOf(a) : 'active';
    }, assetId);
    await page.click(`[data-group="${group}"]`);
    await page.waitForSelector(`[data-pick="${assetId}"]`, { timeout: 45000 });
    await page.evaluate(() => { selectedAssets.clear(); return render(); });
    await page.waitForSelector(`[data-pick="${assetId}"]`, { timeout: 45000 });
    await page.click(`[data-pick="${assetId}"]`);
    await page.waitForSelector('.bulk-bar', { timeout: 45000 });
    return group;
  }

  /* Steps 3 to 5: press the button, read what the modal says, and check the board. */
  async function send(assetId, { button, expectDestination, expectDiscipline }) {
    const stageBefore = await stageOf(assetId);
    await select(assetId);
    await page.click(button);
    await page.waitForSelector('#sendToDevWrap.show', { timeout: 45000 });
    assert.match(await page.$eval('#sd_destination', (e) => e.textContent),
      expectDestination === 'tech_art' ? /Tech Art/ : /Development/);
    if (expectDiscipline) {
      assert.match(await page.$eval('#sd_list', (e) => e.textContent),
        expectDiscipline === 'animation' ? /Animation/ : /Art/);
    }

    await page.click('#sd_confirm');
    await page.waitForFunction(
      'document.getElementById("sd_results") && document.getElementById("sd_results").textContent.trim().length > 0',
      null, { timeout: 45000 });

    const results = await page.$eval('#sd_results', (e) => e.textContent);
    /* THE ASSERTION THE WHOLE TASK IS ABOUT. */
    assert.ok(!/refused/i.test(results),
      `the modal said REFUSED for a successful send: ${results.replace(/\s+/g, ' ').trim()}`);
    assert.match(results, /\bok\b/, `and it should say so: ${results.replace(/\s+/g, ' ').trim()}`);
    assert.match(results,
      expectDestination === 'tech_art' ? /Sent to Tech Art/ : /Sent to Development/);

    /* AND NOT RED. The renderer colours a refusal with the danger token, so the colour is
       checked rather than only the word — the two came from the same ternary. */
    const tones = await page.$$eval('#sd_results .mono', (els) => els.map((e) => e.style.color));
    assert.ok(!tones.some((c) => /danger/.test(c)),
      `a successful row is not drawn in the danger colour: ${tones.join(', ')}`);

    await page.click('#sd_cancel');

    /* Step 5: the asset is still in the stage it was in — read from the database, and then
       from the board the person is looking at. */
    assert.strictEqual(await stageOf(assetId), stageBefore,
      'sending moved the asset, which it must never do');
    return stageBefore;
  }

  /* --------------------------------- steps 2-9: all five stages to Development */

  for (const stage of STAGES) {
    await t.test(`${stage.label} → Send to Dev: success, and still ${stage.label}`, async () => {
      await send(assets[stage.id], { button: '#bulk_sendToDev', expectDestination: 'development' });

      /* THE STAGE ON SCREEN, not only in the row: the board is what the studio reads, and
         a send that moved an asset would show up here. */
      const onScreen = await page.evaluate((id) => {
        const a = (state.assets || []).find((x) => x.id === id);
        return a ? a.status : null;
      }, assets[stage.id]);
      assert.strictEqual(onScreen, stage.id,
        'the list the person is looking at still shows the same stage');

      // And the hand-off really exists, with the right destination.
      const drops = await sql(cfg,
        'SELECT h.kind FROM handoffs h JOIN handoff_assets ha ON ha.handoff_id = h.id '
        + 'WHERE ha.asset_id = ?', [assets[stage.id]]);
      assert.deepStrictEqual(drops.map((d) => d.kind), ['partial_drop']);
    });
  }

  /* ------------------------------ steps 10-11: two stages to Tech Art, in animation */

  await t.test('Delivered → Send to Tech Art: success, stage unchanged, still Animation', async () => {
    await send(assets.animDelivered, {
      button: '#bulk_sendToTechArt', expectDestination: 'tech_art', expectDiscipline: 'animation',
    });
    const drops = await sql(cfg,
      'SELECT h.id, h.kind FROM handoffs h JOIN handoff_assets ha ON ha.handoff_id = h.id '
      + 'WHERE ha.asset_id = ?', [assets.animDelivered]);
    assert.deepStrictEqual(drops.map((d) => d.kind), ['tech_art']);

    const envelope = (await sql(cfg,
      "SELECT payload FROM integration_outbox WHERE event_type = 'handoff.created' ORDER BY seq"))
      .map((r) => JSON.parse(r.payload))
      .find((e) => e.payload.handoffId === drops[0].id);
    assert.strictEqual(envelope.payload.destination, 'tech_art');
    assert.strictEqual(envelope.payload.assets[0].discipline, 'animation');
    assert.strictEqual(await stageOf(assets.animDelivered), 'delivered');
  });

  await t.test('Game Feedback → Send to Tech Art: success, stage unchanged', async () => {
    await send(assets.animGameFeedback, {
      button: '#bulk_sendToTechArt', expectDestination: 'tech_art', expectDiscipline: 'animation',
    });
    assert.strictEqual(await stageOf(assets.animGameFeedback), 'game_feedback');
  });

  /* ----------------------------------------------------------- step 12: no errors */

  await t.test('no REFUSED anywhere, no native dialogs, no page errors', () => {
    assert.deepStrictEqual(natives, [], 'a native dialog was opened');
    const real = errors.filter((e) => !/favicon\.ico/.test(e));
    assert.deepStrictEqual(real, [], `the page logged errors:\n${real.join('\n')}`);
  });
});
