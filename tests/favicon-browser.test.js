/* THE TAB ICON IN A REAL BROWSER, against the real server and the real page.
 *
 * ===========================================================================
 * WHY THIS ONE IS NOT A LIFTED FIXTURE.
 *
 * Most browser suites here build a small page out of functions cut from
 * public/index.html, which is the right trade when what is under test is one
 * panel's behaviour. It is the wrong trade here, because what is under test is
 * THE DOCUMENT'S HEAD — whether a <link rel="icon"> ends up in it, pointing at
 * the right URL, in a page nobody has signed into. A hand-built fixture has
 * whatever head the fixture gave it, so it could only ever prove that a
 * function I wrote does what I wrote it to do.
 *
 * So Chromium is pointed at the actual server, the actual public/index.html is
 * served, sign-in happens through the sign-in form, and the assertions are on
 * the live document and on what the browser actually fetched.
 *
 * ===========================================================================
 * WHAT EACH CASE IS FOR, in the brief's order:
 *
 *   upload a valid PNG in Settings and see the preview and the new link
 *   reload, and sign out, and confirm the sign-in screen uses it
 *   upload an invalid file and see the error in the page
 *   remove it and confirm the default is back
 *
 * The third one is the reason this exists rather than being left to the HTTP
 * suite: "errors appear in-page" is a thing only a browser can be asked.
 *
 * NO NATIVE DIALOGS. The desktop web view has none, so every dialog in this
 * application is drawn in the page. A native one appearing here fails the run.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');
const fx = require('./image-fixtures');

let chromium;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

const cfg = config('faviconBrowser');
const SKIP = !cfg ? SKIP_REASON
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const PASSWORD = 'Branding-Owner-1!';

/* ===========================================================================
 * THE PAGE'S SIDE OF IT, AS SOURCE — and this block never skips.
 *
 * Prompt 70b was this exact failure: a feature whose server side worked
 * perfectly and whose Settings section had never been built, which looked for
 * all the world like a permission or a cache problem. The lesson was that a
 * missing piece of the page is INVISIBLE at runtime — the screen simply has one
 * less thing on it and nothing says so.
 *
 * So the four pieces this feature needs in public/index.html are asserted
 * directly, and deliberately without a browser: a machine with no Chromium
 * skips the cases above, and these still run. */
test('the page carries the four things the icon needs', () => {
  const PAGE = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // 1. The version arrives in the mirror the page already fetches.
  assert.match(PAGE, /hasFavicon:false, faviconVersion:null/,
    'the branding mirror has no place to put the icon');

  // 2. One function builds the URL, so the preview and the head agree.
  assert.match(PAGE, /function faviconUrl\(\)/);
  assert.match(PAGE, /\/branding\/favicon\$\{v \? `\?v=\$\{v\}` : ''\}/,
    'the URL is not built from the version');

  // 3. The head is painted, and from paintBranding so it happens on every load.
  assert.match(PAGE, /function paintFavicon\(\)/);
  const paint = PAGE.slice(PAGE.indexOf('function paintBranding()'), PAGE.indexOf('function faviconUrl()'));
  assert.match(paint, /paintFavicon\(\);/,
    'paintBranding does not paint the icon, so the sign-in screen will not have one');
  for (const rel of ['icon', 'apple-touch-icon']) {
    assert.ok(PAGE.includes(`'${rel}'`), `${rel} is never set`);
  }

  // 4. The section exists, with the controls and the hint the brief asks for.
  assert.match(PAGE, /id="settings-favicon"/);
  assert.match(PAGE, /id="br_iconPick"[^>]*>Upload icon|>Upload icon</);
  assert.match(PAGE, /Remove \(use default\)/);
  assert.match(PAGE, /512 × 512 recommended/);
  assert.match(PAGE, /minimum 64 × 64/);
  assert.match(PAGE, /Allowed: PNG, ICO, JPEG, WebP/);
  assert.match(PAGE, /Maximum 512 KB/);

  /* THE FILE PICKER MUST NOT OFFER SVG. The server refuses one, so offering it
     in the dialog is an invitation to a refusal — and the logo picker directly
     above it does accept SVG, which is exactly the kind of neighbouring line
     somebody copies. */
  const accept = PAGE.slice(PAGE.indexOf('id="br_iconFile"'), PAGE.indexOf('id="br_iconFile"') + 400);
  assert.ok(/accept="[^"]*image\/png[^"]*"/.test(accept), accept);
  assert.ok(!/svg/i.test(accept.split('accept="')[1].split('"')[0]),
    'the icon picker offers SVG, which the server will refuse');

  /* And the page asks with can(), never with a role tier. */
  const section = PAGE.slice(PAGE.indexOf('function renderBranding()'), PAGE.indexOf('async function renderRolePermissions'));
  assert.ok(!/caps\(\)|currentUser\.role\s*===/.test(section),
    'the Branding section decides something from the role rather than from a permission');
});

test('Settings → Branding → Favicon, in Chrome', { skip: SKIP }, async (t) => {
  let server; let browser;
  let origin;
  const token = {};
  const call = (p, o) => api(server.base, p, o);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'icon-browser' });
    origin = server.base.replace(/\/api$/, '');
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'icon-browser', name: 'Root', email: 'root@iconui.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@iconui.test', password: PASSWORD } })).body.token;
    /* THE QUICK TOUR IS DISMISSED FIRST, through the endpoint the application
       itself uses for it.
     *
     * A brand new account gets the guided tour on its first sign-in, and the
     * tour lays four .tour-veil overlays across the page. They intercept
     * pointer events, so every click in this suite retried until it timed out —
     * against a page that was working exactly as designed. Marking the account
     * as having seen it is what a second sign-in would do anyway, and it is a
     * real request rather than a reach into the page's state. */
    assert.strictEqual((await call('/auth/tour-seen',
      { method: 'POST', token: token.root })).status, 200);
    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  });

  /* A fresh browser context each time, so nothing — not a token, not a cached
     icon — leaks between cases. */
  async function visit() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const natives = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    /* Playwright dismisses dialogs by default, so one would pass unnoticed
       without this. */
    page.on('dialog', async (d) => { natives.push(d.type()); await d.dismiss(); });
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('#loginEmail');
    /* NOTHING WENT WRONG IN THE PAGE — with the noise named rather than
       filtered by a vague pattern.
     *
     * The first version of this allowed anything matching /favicon|404/, which
     * would have hidden exactly the errors this suite exists to catch. Two
     * things are genuinely not errors:
     *
     *   the browser's own unasked-for request for /favicon.ico, which this
     *     application answers from its single-page fallback;
     *   and, where a case says so, the console line Chrome writes by itself
     *     when a fetch comes back 4xx — a refused upload is the POINT of the
     *     case that allows it, and the page's own handling of the refusal is
     *     asserted separately before this runs. */
    const clean = (allow = []) => {
      assert.deepStrictEqual(natives, [], 'a native dialog was opened');
      const noise = [/favicon\.ico/, ...allow];
      const left = errors.filter((e) => !noise.some((rx) => rx.test(e)));
      assert.deepStrictEqual(left, [], `the page logged errors:\n${left.join('\n')}`);
    };
    return { page, context, errors, natives, clean, close: () => context.close() };
  }

  /* FORTY-FIVE SECONDS, NOT FIFTEEN.
   *
   * One combined run of the three favicon suites failed here and passed on
   * either side of it. Nothing was wrong with the page: a run that starts four
   * servers and a Chromium on four cores is slow, and this file's waits were
   * the tightest thing in it. The project's own test harness says the same
   * about server boots -- a timeout under contention is a capacity problem, not
   * a code failure -- so the deadlines are generous. A real failure still fails
   * here, it just takes longer to say so. */
  async function signIn(page) {
    await page.fill('#loginEmail', 'root@iconui.test');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginBtn');
    /* `state` IS NOT ON `window`, and that is not a quirk of this page.
     *
     * public/index.html declares it as a top-level `const` in a classic script,
     * which creates a binding in the global LEXICAL environment rather than a
     * property of the global object. A bare `state` resolves; `window.state` is
     * undefined forever. My first version waited on window.state and timed out
     * in every case here while sign-in was working perfectly, which is worth a
     * comment because the next person will reach for window.x too. */
    await page.waitForFunction('typeof state !== "undefined" && !!state.token',
      null, { timeout: 45000 });
  }

  /* Settings, with the Branding section expanded through the page's own
     accordion function rather than by reaching into the DOM. */
  /* Settings, reached by clicking the tab the way anybody would, then the
     Branding section opened through the page's own accordion function. */
  async function openBranding(page) {
    await page.click('#settingsTabBtn');
    await page.waitForSelector('#brandingSection');
    await page.evaluate(() => toggleSettingsSection('Branding', true));
    await page.waitForSelector('#settings-favicon', { state: 'visible' });
  }

  /* What is actually in the document's head right now. */
  const headIcons = (page) => page.$$eval('link[rel="icon"], link[rel="apple-touch-icon"]',
    (links) => links.map((l) => ({ rel: l.getAttribute('rel'), href: l.getAttribute('href'), type: l.getAttribute('type') })));

  /* ------------------------------------------------------- the empty state */

  await t.test('with no icon set, the section says so and the head has no icon', async () => {
    const h = await visit();
    try {
      await signIn(h.page);
      await openBranding(h.page);
      assert.match(await h.page.$eval('#settings-favicon', (e) => e.textContent),
        /Default icon in use/);
      /* THE HINT, which is the only place the rules are stated to the person
         who has to follow them. */
      const hint = await h.page.$eval('#settings-favicon', (e) => e.textContent);
      assert.match(hint, /512 × 512 recommended/);
      assert.match(hint, /minimum 64 × 64/);
      assert.match(hint, /PNG, ICO, JPEG, WebP/);
      assert.match(hint, /512 KB/);
      assert.deepStrictEqual(await headIcons(h.page), [],
        'the page ships with no icon link and must keep it that way');
      h.clean();
    } finally { await h.close(); }
  });

  /* ------------------------------------------------- choose, look, then save */

  let savedVersion = null;

  await t.test('a PNG is previewed with its size before Save, then appears in the tab', async () => {
    const h = await visit();
    try {
      await signIn(h.page);
      await openBranding(h.page);

      /* The real input, through the real file picker plumbing. */
      await h.page.setInputFiles('#br_iconFile', {
        name: 'studio-icon.png', mimeType: 'image/png', buffer: fx.png(512, 512),
      });

      /* THE PREVIEW AND THE FACTS, BEFORE ANYTHING IS UPLOADED. This is the
         brief's "show a preview and the file's size and dimensions before the
         owner presses Save" — and at this point the server has not been
         touched. */
      await h.page.waitForSelector('#br_iconSave');
      assert.match(await h.page.$eval('#br_iconName', (e) => e.textContent), /studio-icon\.png/);
      const facts = await h.page.$eval('#br_iconFacts', (e) => e.textContent);
      assert.match(facts, /512 × 512/, facts);
      assert.match(facts, /KB/, facts);
      assert.ok(await h.page.$('#br_iconStaged img'), 'the chosen file is previewed');
      assert.strictEqual((await call('/branding')).body.branding.hasFavicon, false,
        'nothing has been uploaded yet — this is still a choice, not a change');

      await h.page.click('#br_iconSave');

      /* THE OPEN TAB UPDATES WITHOUT A RELOAD, which is the requirement. */
      await h.page.waitForFunction('document.querySelectorAll(\'link[rel="icon"]\').length === 1',
        null, { timeout: 45000 });
      const icons = await headIcons(h.page);
      assert.deepStrictEqual(icons.map((i) => i.rel).sort(), ['apple-touch-icon', 'icon']);
      savedVersion = (await call('/branding')).body.branding.faviconVersion;
      for (const link of icons) {
        assert.strictEqual(link.href, `/branding/favicon?v=${savedVersion}`, JSON.stringify(link));
        assert.strictEqual(link.type, 'image/png');
      }

      /* AND THE BROWSER CAN ACTUALLY FETCH IT. The link being right is not the
         same as the icon working, so the page asks for it the way a browser
         would and the bytes are compared with what was uploaded. */
      const fetched = await h.page.evaluate(async (href) => {
        const res = await fetch(href);
        const buf = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, type: res.headers.get('content-type'),
          nosniff: res.headers.get('x-content-type-options'), length: buf.length };
      }, icons[0].href);
      assert.strictEqual(fetched.status, 200);
      assert.strictEqual(fetched.type, 'image/png');
      assert.strictEqual(fetched.nosniff, 'nosniff');
      assert.strictEqual(fetched.length, fx.png(512, 512).length);

      /* The section now shows the icon rather than the words. */
      assert.ok(await h.page.$('#settings-favicon .brand-logo-preview img'));
      assert.ok(await h.page.$('#br_iconRemove'), 'and offers to remove it');
      h.clean();
    } finally { await h.close(); }
  });

  await t.test('it survives a reload', async () => {
    const h = await visit();
    try {
      await signIn(h.page);
      await h.page.reload({ waitUntil: 'load' });
      await h.page.waitForFunction('document.querySelectorAll(\'link[rel="icon"]\').length === 1',
        null, { timeout: 45000 });
      const icons = await headIcons(h.page);
      assert.strictEqual(icons[0].href, `/branding/favicon?v=${savedVersion}`);
      h.clean();
    } finally { await h.close(); }
  });

  /* ------------------------------------------------------ the sign-in screen */

  await t.test('the sign-in screen wears it, with nobody signed in', async () => {
    /* THE CASE THE PUBLIC ROUTE EXISTS FOR. A brand new context: no token, no
       cache, nothing in storage. The page is the sign-in screen and the icon
       still has to be there, because that is the first thing anybody outside
       the studio sees. */
    const h = await visit();
    try {
      await h.page.waitForFunction('document.querySelectorAll(\'link[rel="icon"]\').length === 1',
        null, { timeout: 45000 });
      assert.ok(await h.page.$('#loginEmail'), 'this really is the sign-in screen');
      assert.strictEqual(
        await h.page.evaluate('typeof state !== "undefined" && !!state.token'), false,
        'and nobody is signed in');

      const icons = await headIcons(h.page);
      assert.strictEqual(icons.length, 2);
      assert.strictEqual(icons[0].href, `/branding/favicon?v=${savedVersion}`);

      const fetched = await h.page.evaluate(async (href) => {
        const res = await fetch(href);
        return { status: res.status, cache: res.headers.get('cache-control') };
      }, icons[0].href);
      assert.strictEqual(fetched.status, 200, 'served without a token');
      assert.match(fetched.cache, /immutable/, 'and cached hard, because the URL carries the version');
      h.clean();
    } finally { await h.close(); }
  });

  /* ------------------------------------------------------- a refused upload */

  await t.test('an invalid file is refused in the page, and changes nothing', async () => {
    const h = await visit();
    try {
      await signIn(h.page);
      await openBranding(h.page);

      /* An SVG, which is the one the brief singles out: it is a plausible thing
         for somebody to try and it is refused for a reason worth explaining. */
      await h.page.setInputFiles('#br_iconFile', {
        name: 'logo.svg', mimeType: 'image/svg+xml', buffer: fx.svg(),
      });
      await h.page.waitForSelector('#br_iconSave');
      await h.page.click('#br_iconSave');

      await h.page.waitForFunction(
        'document.getElementById("br_iconErr") && /SVG/.test(document.getElementById("br_iconErr").textContent)',
        null, { timeout: 45000 });
      const message = await h.page.$eval('#br_iconErr', (e) => e.textContent);
      assert.match(message, /SVG/);
      assert.match(message, /script/, 'and it says why, rather than listing formats');

      /* IN THE PAGE, not in a dialog, and the icon in use is untouched. */
      assert.deepStrictEqual(h.natives, []);
      const icons = await headIcons(h.page);
      assert.strictEqual(icons[0].href, `/branding/favicon?v=${savedVersion}`,
        'the refused upload left the icon alone');
      assert.strictEqual((await call('/branding')).body.branding.faviconVersion, savedVersion);

      /* A file the browser itself can measure is called out before Save is even
         pressed — the courtesy check, which saves a round trip for the two
         mistakes that are obvious from the file. */
      await h.page.setInputFiles('#br_iconFile', {
        name: 'banner.png', mimeType: 'image/png', buffer: fx.png(512, 256),
      });
      await h.page.waitForFunction(
        'document.getElementById("br_iconErr") && /not square/.test(document.getElementById("br_iconErr").textContent)',
        null, { timeout: 45000 });
      assert.match(await h.page.$eval('#br_iconFacts', (e) => e.textContent), /512 × 256/);
      /* The 400 is what this case asked for; see clean()'s note. */
      h.clean([/responded with a status of 400/]);
    } finally { await h.close(); }
  });

  /* ------------------------------------------------------------- the removal */

  await t.test('removing it puts the default back, in the open tab', async () => {
    const h = await visit();
    try {
      await signIn(h.page);
      await openBranding(h.page);
      assert.strictEqual((await headIcons(h.page)).length, 2, 'it starts set');

      await h.page.click('#br_iconRemove');
      /* THE IN-PAGE CONFIRMATION, which is this application's own dialog —
         there is no native confirm() to answer. */
      await h.page.waitForSelector('#askWrap.open, #askWrap[style*="display: flex"], #ask_confirm', { timeout: 45000 });
      assert.match(await h.page.$eval('#ask_message', (e) => e.textContent), /default icon/i);
      await h.page.click('#ask_confirm');

      await h.page.waitForFunction('document.querySelectorAll(\'link[rel="icon"]\').length === 0',
        null, { timeout: 45000 });
      assert.deepStrictEqual(await headIcons(h.page), [],
        'the head goes back to what the page ships with');
      await h.page.waitForFunction(
        '/Default icon in use/.test(document.getElementById("settings-favicon").textContent)',
        null, { timeout: 45000 });

      const gone = await h.page.evaluate(async () => (await fetch('/branding/favicon')).status);
      assert.strictEqual(gone, 404, 'and there is nothing left to serve');
      assert.strictEqual((await call('/branding')).body.branding.hasFavicon, false);
      assert.deepStrictEqual(h.natives, []);
      /* The 404 two lines up is this case's whole point, and Chrome writes its
         own console line for it; see clean()'s note. */
      h.clean([/responded with a status of 404/]);
    } finally { await h.close(); }
  });
});
