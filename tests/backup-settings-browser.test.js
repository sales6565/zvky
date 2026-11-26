/* SETTINGS -> BACKUP IN A REAL BROWSER.
 *
 * ===========================================================================
 * WHY THIS IS NOT COVERED BY THE ROUTE SUITE.
 *
 * tests/backup-routes.test.js proves the API refuses the right things. It
 * cannot prove that a person can reach any of it: a section missing from
 * SETTINGS_SECTIONS, a container whose id does not match, a render function
 * that is never called, a modal that opens behind the tour veil — every one of
 * those leaves an API that works perfectly and a screen with nothing on it.
 * That is precisely what happened to the password-reset feature one prompt
 * earlier, and the fence around it is a suite like this one.
 *
 * So this drives the actual screen: open Settings, take a backup through the
 * modal, watch the progress poll turn into a verified row, verify it, and try
 * the things that must be refused.
 *
 * ===========================================================================
 * NO NATIVE DIALOGS. The desktop web view has none, so alert/confirm/prompt
 * are replaced with throws and any path reaching one fails here.
 *
 * AND NOTHING IS ASSERTED ABOUT COLOUR OR LAYOUT except the one thing that
 * carries meaning: whether the status line is in its alarmed state. That is a
 * class, and it is the difference between "you are backed up" and "you are
 * not", which is the only thing on this screen somebody has to see from across
 * a room.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api } = require('./helpers');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const SKIP = !process.env.TEST_DB_NAME ? 'Set TEST_DB_NAME to run integration tests.'
  : (!chromium ? 'playwright-core is not installed — run `npm install`.'
    : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false));

const cfg = config('backupbrowser');
const PASSWORD = 'Browser-Only-Pw-74!x';
const PASSPHRASE = `browser-${crypto.randomBytes(8).toString('base64url')}-several-words`;

test('Settings → Backup, in a browser', { skip: SKIP }, async (t) => {
  let server; let browser; let page; let dir; let origin;
  const token = {};
  const natives = [];
  const errors = [];

  t.before(async () => {
    await resetSchema(cfg);
    dir = path.join(os.homedir(), `zvky-browser-backups-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'browser74', BACKUP_DIR: dir });
    origin = server.base.replace(/\/api$/, '');
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'browser74', name: 'Owner', email: 'owner@bb.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@bb.test');

    const artist = await api(server.base, '/users', { method: 'POST', token: token.owner, body: {
      name: 'An Artist', email: 'artist@bb.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(artist.status, 201, JSON.stringify(artist.body));
    token.artist = await login('artist@bb.test');

    browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  });

  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) stopServer(server);
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  const openAs = async (who) => {
    const fresh = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    fresh.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await fresh.addInitScript(() => {
      for (const name of ['alert', 'confirm', 'prompt']) {
        window[name] = () => { throw new Error(`native ${name}()`); };
      }
    });
    fresh.on('dialog', async (d) => { natives.push(d.type()); await d.dismiss(); });
    await fresh.goto(origin);
    await fresh.evaluate(([t2]) => { localStorage.setItem('zvky_token', t2); }, [token[who]]);
    await fresh.goto(origin);
    await fresh.waitForSelector('#app', { timeout: 30000 });
    /* The Quick Tour's veil covers the screen and swallows clicks; dismissed
       the way the app does it, then kept gone with a rule that survives a
       re-render. */
    await fresh.evaluate(() => fetch('/api/auth/tour-seen', {
      method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('zvky_token')}` },
    })).catch(() => {});
    await fresh.addStyleTag({ content: '.tour-veil{display:none !important;pointer-events:none !important;}' });
    return fresh;
  };

  /* ------------------------------------------------------------- the gate */
  await t.test('an artist has no Backup section at all', async () => {
    const theirs = await openAs('artist');
    try {
      const reachable = await theirs.evaluate(() => (typeof canOpenSettings === 'function'
        ? canOpenSettings() : null));
      if (reachable) {
        await theirs.evaluate(() => setTab('settings'));
        await theirs.waitForTimeout(500);
      }
      assert.strictEqual(await theirs.$('#backupSection'), null,
        'the container must not exist for somebody without the key');
      /* AND THE SECTION INDEX DOES NOT OFFER IT EITHER. */
      const listed = await theirs.evaluate(() => document.body.innerText.includes('Take a backup'));
      assert.strictEqual(listed, false);
    } finally { await theirs.close(); }
  });

  /* --------------------------------------------------------- the owner's */
  await t.test('the owner opens it and is told there is no backup', async () => {
    page = await openAs('owner');
    await page.evaluate(() => setTab('settings'));
    await page.waitForSelector('#backupSection', { timeout: 20000 });
    await page.evaluate(() => openSettingsSection('Backup'));
    await page.waitForSelector('#bkSection .bk-status', { state: 'visible', timeout: 10000 });

    const text = (await page.textContent('#bkSection .bk-status')).replace(/\s+/g, ' ');
    assert.match(text, /No backup of Forge has ever been taken/);
    assert.strictEqual(
      await page.evaluate(() => document.querySelector('#bkSection .bk-status').classList.contains('stale')),
      true, 'and it is in the alarmed state');
    /* THE SENTENCE THAT MUST NOT BE SOFTENED is on the screen. */
    assert.match(await page.textContent('#bkSection'), /not a safe backup/);
  });

  await t.test('the modal refuses a short passphrase before the server is asked', async () => {
    await page.click('#bk_create');
    await page.waitForSelector('#bkCreateWrap.show', { timeout: 5000 });
    await page.fill('#bk_pass1', 'short');
    const hint = await page.textContent('#bk_strength');
    assert.match(hint, /more characters?/i, 'the hint counts down rather than scolding afterwards');
    /* AND IT DOES NOT CLAIM TO JUDGE STRENGTH IT CANNOT JUDGE. */
    await page.fill('#bk_pass1', 'a passphrase of several words');
    assert.match(await page.textContent('#bk_strength'), /\d+ characters/);
    assert.doesNotMatch(await page.textContent('#bk_strength'), /strong!/i);
    /* The lost-passphrase warning is in front of them before they commit. */
    assert.match(await page.textContent('#bk_lostwarn'), /cannot be opened/i);
  });

  await t.test('mismatched passphrases and a wrong password are each refused by name', async () => {
    await page.fill('#bk_pass1', PASSPHRASE);
    await page.fill('#bk_pass2', `${PASSPHRASE}x`);
    await page.fill('#bk_password', PASSWORD);
    await page.click('#bk_create_go');
    await page.waitForFunction(() => document.getElementById('bk_create_err').textContent.length > 0,
      { timeout: 15000 });
    assert.match(await page.textContent('#bk_create_err'), /do not match/i);

    await page.fill('#bk_pass2', PASSPHRASE);
    await page.fill('#bk_password', 'not-the-right-password');
    await page.click('#bk_create_go');
    await page.waitForFunction(() => /password/i.test(document.getElementById('bk_create_err').textContent)
      && !/do not match/i.test(document.getElementById('bk_create_err').textContent), { timeout: 15000 });
    assert.match(await page.textContent('#bk_create_err'), /password/i);

    /* AND THE MODAL IS STILL OPEN, with what was typed still there: a refusal
       that threw the form away would mean typing a passphrase twice again. */
    assert.ok(await page.isVisible('#bkCreateWrap.show'));
    assert.strictEqual(await page.inputValue('#bk_pass1'), PASSPHRASE);
  });

  await t.test('a real backup runs, the progress is live, and it lands verified', async () => {
    await page.fill('#bk_password', PASSWORD);
    await page.click('#bk_create_go');
    await page.waitForSelector('#bkCreateWrap.show', { state: 'hidden', timeout: 30000 });

    /* THE THREE PASSWORD FIELDS ARE EMPTY. They held live credentials, and a
       value left in a hidden input is readable from the DOM for as long as the
       tab stays open. */
    assert.strictEqual(await page.evaluate(() =>
      ['bk_pass1', 'bk_pass2', 'bk_password'].every((id) => document.getElementById(id).value === '')),
    true, 'the modal cleared every credential on the way out');

    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#bkSection .bk-list tbody tr');
      return rows.length === 1 && /verified/.test(rows[0].textContent);
    }, { timeout: 240000 });

    const row = (await page.textContent('#bkSection .bk-list tbody')).replace(/\s+/g, ' ');
    assert.match(row, /verified/);
    assert.match(row, /MB/);
    assert.match(row, /Owner/, 'and it says who took it');

    const status = (await page.textContent('#bkSection .bk-status')).replace(/\s+/g, ' ');
    assert.match(status, /Last verified backup/);
    assert.strictEqual(
      await page.evaluate(() => document.querySelector('#bkSection .bk-status').classList.contains('stale')),
      false, 'and the alarm is off');

    /* THE POLL STOPS. A page left open on this section must not keep asking
       the server about a backup that finished. */
    assert.strictEqual(await page.evaluate(() => bkState.poll === null), true);
  });

  await t.test('verifying asks for the passphrase in a password field, and checks it', async () => {
    await page.click('[data-bk-verify]');
    await page.waitForSelector('#askWrap.show', { timeout: 5000 });
    assert.strictEqual(await page.getAttribute('#ask_input', 'type'), 'password',
      'a passphrase typed in clear on a studio screen defeats the step-up');

    await page.fill('#ask_input', 'not-the-passphrase-at-all');
    await page.click('#ask_confirm');
    await page.waitForFunction(() => document.getElementById('ask_err').textContent.length > 0,
      { timeout: 120000 });
    assert.match(await page.textContent('#ask_err'), /passphrase is wrong or the file has been damaged/i);

    await page.fill('#ask_input', PASSPHRASE);
    await page.click('#ask_confirm');
    await page.waitForSelector('#askWrap.show', { state: 'hidden', timeout: 120000 });

    /* THE FIELD IS CLEARED AND PUT BACK TO TEXT on the way out, for the next
       question that is not a password. */
    assert.strictEqual(await page.evaluate(() =>
      document.getElementById('ask_input').value === '' && document.getElementById('ask_input').type === 'text'),
    true);
  });

  await t.test('the schedule refuses to be switched on with nothing to encrypt with', async () => {
    assert.strictEqual(await page.isChecked('#bk_sch_on'), false, 'it ships off');
    assert.strictEqual(await page.inputValue('#bk_sch_time'), '02:00');
    assert.strictEqual(await page.inputValue('#bk_sch_keep'), '7');

    await page.check('#bk_sch_on');
    await page.click('#bk_sch_save');
    await page.waitForFunction(() => [...document.querySelectorAll('#bkSection .ref-err')]
      .some((n) => n.textContent.trim().length > 0), { timeout: 15000 });
    const shown = (await page.evaluate(() => [...document.querySelectorAll('#bkSection .ref-err')]
      .map((n) => n.textContent.trim()).join(' | ')));
    assert.match(shown, /passphrase/i);
  });

  await t.test('the warning about storing a passphrase is on the screen before it is stored', async () => {
    const text = await page.textContent('#bkSection');
    assert.match(text, /stored — encrypted with EMAIL_ENCRYPTION_KEY/i);
    assert.match(text, /weaker than a passphrase only you know/i);
  });

  await t.test('deleting asks first, and says it is the only one', async () => {
    await page.click('[data-bk-delete]');
    await page.waitForSelector('#askWrap.show', { timeout: 5000 });
    const message = await page.textContent('#ask_message');
    assert.match(message, /NEWEST VERIFIED BACKUP/,
      'deleting the only backup must say what that leaves them with');
    await page.click('#ask_cancel');
    await page.waitForSelector('#askWrap.show', { state: 'hidden', timeout: 5000 });
    assert.strictEqual(await page.evaluate(() =>
      document.querySelectorAll('#bkSection .bk-list tbody tr').length), 1,
    'cancelling leaves it alone');
  });

  await t.test('no native dialog was used, and the page logged no errors', async () => {
    assert.deepStrictEqual(natives, [], 'the desktop web view has no native dialogs');
    assert.deepStrictEqual(errors, []);
    await page.close();
  });
});
