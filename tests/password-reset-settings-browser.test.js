/* SETTINGS -> PASSWORD RESET, IN A REAL BROWSER, AND WHY IT WASN'T THERE.
 *
 * ===========================================================================
 * THE BUG THIS SUITE IS THE FENCE AROUND, AND IT IS NOT AN INTERESTING ONE.
 *
 * Prompt 70 built the settings module, the four routes, the catalogue key, the
 * migration, the sealing and the reset path — and never built the Settings
 * section. The owner opened Settings as Super Admin and found nothing, because
 * there was nothing to find. Everything underneath was working the whole time,
 * which is what made it look like a permission or a cache problem.
 *
 * A section in this application needs THREE things, and the first version of
 * this feature had none of them:
 *
 *   1. an entry in SETTINGS_SECTIONS   — the index, and canOpenSettings()
 *   2. a container in renderSettings() — gated by can(key)
 *   3. a render function called from renderSettings()
 *
 * All three are asserted below as source, because a missing one is invisible at
 * runtime: the screen simply has one fewer section and nothing says so.
 *
 * ===========================================================================
 * AND A FOURTH THING, WHICH IS WHAT 70b'S "appears within the permission poll
 * interval" ASKS FOR. reapplyPermissionGates() re-applied the gate TABLE and
 * redrew the Projects tab, and that table has no entry for a settings section —
 * so granting somebody a settings key changed nothing on their open Settings
 * tab until they navigated. Fixed, and pinned here.
 *
 * NO NATIVE DIALOGS: the desktop web view has none, so alert/confirm/prompt
 * throw here and any case reaching one fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch { chromium = null; }
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean);
const EXECUTABLE = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const SKIP = !chromium ? 'playwright-core is not installed — run `npm install`.'
  : (!EXECUTABLE ? `No Chromium found. Looked in: ${CANDIDATES.join(', ')}.` : false);

/* This run's value, generated: a literal here would put a working default back
   in the repository, which is what Prompt 70 existed to undo. */
const SECRET = `Bz4-${crypto.randomBytes(9).toString('base64url')}-Qx!`;

const cut = (fromText, toText, what) => {
  const from = PAGE.indexOf(fromText);
  const to = PAGE.indexOf(toText, from + 1);
  assert.ok(from !== -1 && to > from, `found ${what} in the page`);
  return PAGE.slice(from, to);
};

/* ------------------------------- the three things a section needs, as source */

test('the section is registered, contained and rendered', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');

  /* 1. THE REGISTRY. canOpenSettings() is built from this list, so a section
        missing from it is also a key whose holder cannot reach the Settings tab
        at all — the bug two earlier entries carry a note about. */
  assert.match(code, /\{ permission:'settings\.default_password', label:'Password reset', heading:'Password reset'/,
    'settings.default_password is not in SETTINGS_SECTIONS');

  /* 2. THE CONTAINER, with the stable id 70b asks for, gated by the key. */
  assert.match(code, /can\('settings\.default_password'\) \? '<div id="settings-password-reset"><\/div>' : ''/,
    'the container is missing, or not gated by the key, or not called settings-password-reset');

  /* 3. THE CALL. A container with nothing rendered into it is an empty div. */
  assert.match(code, /if\(can\('settings\.default_password'\)\) await renderPasswordResetSettings\(\);/,
    'renderPasswordResetSettings is never called from renderSettings');
  assert.match(code, /async function renderPasswordResetSettings\(\)\{/,
    'renderPasswordResetSettings is not defined');

  /* AND THE HEADING THE ACCORDION KEYS OFF. applySettingsAccordion() reads the
     h3 text and matches it against SETTINGS_SECTIONS.heading; a mismatch gives
     a section that cannot be opened from the index. */
  const body = cut('async function renderPasswordResetSettings(){', '\nasync function renderChatSettings(){', 'the renderer');
  assert.match(body, /<h3>Password reset<\/h3>/, 'the h3 must match the registry heading exactly');
});

test('the poll redraws Settings, which is what makes a new grant appear', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /if\(state\.view==='settings'\)\{/,
    'reapplyPermissionGates does not redraw Settings');
  /* THE CACHE HAS TO GO WITH IT. Every section returns early when its payload
     is already fetched, so a redraw that kept the caches would repaint the
     sections already on screen and leave a newly granted one blank. */
  const fn = cut('function reapplyPermissionGates(', '\nasync function applyPermissionChange(', 'reapplyPermissionGates');
  assert.match(fn, /prSetState\.data = null;/, 'the section cache is not dropped on a permission change');
  assert.match(fn, /renderSettings\(\);/);
});

test('the value is in none of the markup this section draws', () => {
  const body = cut('async function renderPasswordResetSettings(){', '\nasync function renderChatSettings(){', 'the renderer');
  /* THE WRITE-ONLY PROMISE, AS SOURCE. The panel may read defaultSet and
     defaultSetAt and nothing else about the value — not its length, which would
     narrow a guess, and obviously not the value, which the server does not
     send anyway. */
  for (const forbidden of [/\.defaultPassword\b(?!\s*:)/, /\.value\b.*innerHTML/, /\.length\b.*default/i]) {
    assert.ok(!forbidden.test(body), `the panel reads something it must not: ${forbidden}`);
  }
  assert.match(body, /s\.defaultSet/, 'it does report whether one is set');
  assert.match(body, /s\.defaultSetAt/, 'and when it last changed');
  /* AND IT CLEARS THE FIELD AFTER A SAVE, so a live credential is not left in
     the DOM for the rest of the session. */
  assert.match(body, /field\.value = '';/);
});

test('the reset modal no longer prints a password, nor the word undefined', () => {
  /* THE REGRESSION 70b FOUND. The result step rendered
     escapeHTML(res.temporaryPassword) in a big box; the server stopped sending
     that field in Prompt 70, so an administrator pressing Reset password got a
     panel displaying "undefined" where the credential used to be. */
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/temporaryPassword/.test(code),
    'the page still reads temporaryPassword somewhere in live code');
  assert.ok(!/class="temp-pw"/.test(code),
    'the box that displayed the password is still drawn');
  const step = cut("document.getElementById('rp_confirm').addEventListener('click'", '\n/* Is this session locked out', 'the reset handler');
  assert.match(step, /res\.message/, 'it shows the server\'s sentence');
  assert.match(step, /Settings &rarr; Password reset/, 'and says where the default is set');
});

/* --------------------------------------------------- the live half, in Chrome */

function fixture() {
  /* The real registry, the real gate, the real renderer. /auth/me and the
     settings route are stubbed — what is under test is what the page does with
     the answers, not how they are fetched. */
  const sections = cut('const SETTINGS_SECTIONS = [', '\n/* Settings opens for anyone holding', 'SETTINGS_SECTIONS');
  const canFn = cut("/* can('asset.add') — and can('a','b') for \"either of these\". */", '\n}\n', 'can()') + '\n}';
  const renderer = cut('const prSetState = {', '\nasync function renderChatSettings(){', 'the renderer');
  const checkRule = cut('function checkRule(id, pw){', '\n}\n', 'checkRule') + '\n}';

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>.pw-rules li .tick{width:11px;display:inline-block;} .pw-rules li.met{color:green;}</style>
  </head><body>
  <div id="settingsView"></div>
  <div id="toast"></div>
  <script>
  for(const n of ['alert','confirm','prompt']){ window[n]=()=>{ throw new Error('native dialog: '+n); }; }
  const escapeHTML = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDate = (d) => String(d||'');
  const showToast = (m) => { document.getElementById('toast').textContent = m; };
  const askConfirm = async () => true;
  let passwordPolicy = null;
  let SETTINGS_PAYLOAD = null;      /* what the stubbed settings route answers */
  let PUTS = [];                    /* every write the panel sends */
  const state = { currentUser: null, view: 'settings' };
  function perms(){ return (state.currentUser && state.currentUser.permissions) || []; }
  function caps(){ return (state.currentUser && state.currentUser.capabilities) || {}; }
  ${canFn}
  ${checkRule}
  ${sections}
  function canOpenSettings(){ return SETTINGS_SECTIONS.some(s=>can(s.permission)); }

  /* The stub. Records writes so a test can prove the panel never sends the
     value anywhere it should not, and answers the shape the real route does. */
  async function api(path, opts){
    if(opts && opts.method && opts.method !== 'GET'){
      PUTS.push({ path, method: opts.method, body: opts.body || null });
      if(path.endsWith('/default') && opts.method === 'PUT'){
        SETTINGS_PAYLOAD.settings.defaultSet = true;
        SETTINGS_PAYLOAD.settings.defaultSetAt = '2026-11-16';
        SETTINGS_PAYLOAD.settings.source = 'configured';
        SETTINGS_PAYLOAD.settings.fallbackNote = null;
      }
      if(path.endsWith('/default') && opts.method === 'DELETE'){
        SETTINGS_PAYLOAD.settings.defaultSet = false;
        SETTINGS_PAYLOAD.settings.defaultSetAt = null;
      }
      if(!path.endsWith('/default')) Object.assign(SETTINGS_PAYLOAD.settings, opts.body);
      return JSON.parse(JSON.stringify(SETTINGS_PAYLOAD));
    }
    return JSON.parse(JSON.stringify(SETTINGS_PAYLOAD));
  }
  ${renderer}

  /* The settings view, cut down to the one line this suite is about plus the
     gate around it, so the container and the call are the page's own. */
  async function renderSettings(){
    const el = document.getElementById('settingsView');
    el.innerHTML = \`
      \${can('settings.default_password') ? '<div id="settings-password-reset"></div>' : ''}
      \${can('settings.ip_allowlist') ? '<div id="ipAllowlistSection"></div>' : ''}\`;
    if(can('settings.default_password')) await renderPasswordResetSettings();
  }
  </script></body></html>`;
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script);                 // parse it here, with the real message
  return html;
}

const payload = (over = {}) => ({
  settings: {
    useDefault: true, forceChange: true, validHours: 72,
    defaultSet: false, defaultSetAt: null,
    source: 'none', willUseDefault: false,
    fallbackNote: 'No default password has been set. A Super Admin sets one in Settings → Password reset.',
    encryptionAvailable: true,
    updatedBy: null, updatedByName: null, updatedAt: null,
    policy: { minLength: 10, maxLength: 200, rules: [
      { id: 'length', label: 'At least 10 characters' },
      { id: 'uppercase', label: 'One uppercase letter' },
      { id: 'lowercase', label: 'One lowercase letter' },
      { id: 'number', label: 'One number' },
      { id: 'symbol', label: 'One symbol (e.g. ! ? @ # $ %)' },
    ] },
    hours: { min: 0, max: 720 },
    ...over,
  },
});

test('the Password reset section in Settings', { skip: SKIP, concurrency: false }, async (t) => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setContent(fixture());
  t.after(async () => { await browser.close(); });

  /* THE PAYLOAD DEFAULTS TO A REAL ONE. It defaulted to {}, which was harmless
     in the case where the section does not render and a TypeError the moment a
     grant made it render — the panel reads settings.policy. */
  const signIn = (permissions, over = payload()) => page.evaluate(([p, pay]) => {
    state.currentUser = { id: 'u1', permissions: p, capabilities: { managePermissions: p.includes('settings.permissions') } };
    SETTINGS_PAYLOAD = pay;
    PUTS = [];
    passwordPolicy = null;
    prSetState.data = null;
    prSetState.errors = [];
    return renderSettings();
  }, [permissions, over]);

  const shape = () => page.evaluate(() => {
    const box = document.getElementById('settings-password-reset');
    const q = (sel) => box && box.querySelector(sel);
    return {
      present: Boolean(box),
      heading: q('.ref-head h3') ? q('.ref-head h3').textContent.trim() : null,
      useChecked: q('#pr_use') ? q('#pr_use').checked : null,
      forceChecked: q('#pr_force') ? q('#pr_force').checked : null,
      hours: q('#pr_hours') ? q('#pr_hours').value : null,
      hoursMin: q('#pr_hours') ? q('#pr_hours').getAttribute('min') : null,
      hoursMax: q('#pr_hours') ? q('#pr_hours').getAttribute('max') : null,
      fieldType: q('#pr_value') ? q('#pr_value').getAttribute('type') : null,
      fieldValue: q('#pr_value') ? q('#pr_value').value : null,
      setBtn: Boolean(q('#pr_set')),
      saveBtn: Boolean(q('#pr_save')),
      clearBtn: Boolean(q('#pr_clear')),
      rules: [...(box ? box.querySelectorAll('#pr_rules li') : [])].map((li) => li.textContent.trim()),
      text: box ? box.innerText : null,
      html: box ? box.innerHTML : null,
    };
  });

  const SUPER = ['settings.default_password', 'settings.permissions', 'settings.ip_allowlist'];

  await t.test('a Super Admin sees it, with every control', async () => {
    await signIn(SUPER, payload());
    const r = await shape();
    assert.strictEqual(r.present, true, 'the section is not on the screen');
    assert.strictEqual(r.heading, 'Password reset');
    /* THE FOUR CONTROLS 70b NAMES. */
    assert.strictEqual(r.useChecked, true, 'the "reset to the default" switch');
    assert.strictEqual(r.forceChecked, true, 'the "require a new password" switch');
    assert.strictEqual(r.hours, '72', 'the expiry');
    assert.strictEqual(r.hoursMin, '0');
    assert.strictEqual(r.hoursMax, '720');
    assert.strictEqual(r.fieldType, 'password', 'the default-password field, masked');
    assert.ok(r.setBtn && r.saveBtn, 'both buttons');
    assert.strictEqual(r.clearBtn, false, 'and no Clear button while nothing is set');
    assert.deepStrictEqual(r.rules.length, 5, 'the policy checklist');
    assert.match(r.text, /No default password is set/);
    assert.match(r.text, /never shown again/);
  });

  await t.test('a role without the key does not see it at all', async () => {
    await signIn(['settings.ip_allowlist']);
    const r = await shape();
    assert.strictEqual(r.present, false,
      'the section is on screen for somebody who does not hold the key');
    assert.strictEqual(await page.evaluate(() =>
      Boolean(document.getElementById('ipAllowlistSection'))), true,
    'and the rest of Settings still draws');
  });

  await t.test('granting the key makes it appear on the permission poll', async () => {
    await signIn(['settings.ip_allowlist']);
    assert.strictEqual((await shape()).present, false);
    /* The poll's own path: the permission set moves, and the page re-decides.
       This is the fourth thing a section needs and the one 70b asks for by
       name — "appears within the permission poll interval". */
    await page.evaluate(async () => {
      state.currentUser.permissions = ['settings.ip_allowlist', 'settings.default_password'];
      prSetState.data = null;            // as reapplyPermissionGates does
      await renderSettings();
    });
    const r = await shape();
    assert.strictEqual(r.present, true, 'it did not appear after the grant');
    assert.strictEqual(r.heading, 'Password reset');
    assert.strictEqual(r.rules.length, 5, 'and it is fully drawn, not a blank container');
  });

  await t.test('the checklist ticks as you type, and the field stays masked', async () => {
    await signIn(SUPER, payload());
    const ticked = async (value) => page.evaluate((v) => {
      const f = document.getElementById('pr_value');
      f.value = v;
      f.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('#pr_rules li')]
        .filter((li) => li.classList.contains('met')).map((li) => li.dataset.rule);
    }, value);

    assert.deepStrictEqual(await ticked(''), [], 'nothing ticks for an empty field');
    assert.deepStrictEqual((await ticked('short')).sort(), ['lowercase']);
    assert.deepStrictEqual((await ticked(SECRET)).sort(),
      ['length', 'lowercase', 'number', 'symbol', 'uppercase'],
      'a policy-clean value ticks every rule');
    assert.strictEqual((await shape()).fieldType, 'password', 'and it is still masked');
  });

  await t.test('setting it sends the value once and never shows it again', async () => {
    await signIn(SUPER, payload());
    await page.evaluate(async (v) => {
      const f = document.getElementById('pr_value');
      f.value = v;
      f.dispatchEvent(new Event('input'));
      await document.getElementById('pr_set').onclick();
    }, SECRET);

    const writes = await page.evaluate(() => PUTS);
    const setCall = writes.find((w) => w.path.endsWith('/default') && w.method === 'PUT');
    assert.ok(setCall, 'the value was not sent');
    assert.strictEqual(setCall.body.defaultPassword, SECRET, 'and it is sent as typed');

    const r = await shape();
    /* THE VALUE IS GONE FROM THE SCREEN AND FROM THE DOM. */
    assert.strictEqual(r.fieldValue, '', 'the field still holds the value');
    assert.ok(!r.html.includes(SECRET), 'the value is in the section markup');
    assert.ok(!r.text.includes(SECRET), 'the value is on screen');
    assert.match(r.text, /is set/, 'it reports that one is set');
    assert.match(r.text, /last changed/, 'and when');
    assert.strictEqual(r.clearBtn, true, 'and now offers Clear');
    assert.strictEqual(await page.evaluate(() => document.getElementById('toast').textContent),
      'Default password set. It is not shown again.');
  });

  await t.test('the switches and the expiry save, and nothing else rides along', async () => {
    await signIn(SUPER, payload());
    await page.evaluate(async () => {
      document.getElementById('pr_use').checked = false;
      document.getElementById('pr_force').checked = false;
      document.getElementById('pr_hours').value = '0';
      await document.getElementById('pr_save').onclick();
    });
    const writes = await page.evaluate(() => PUTS);
    const put = writes.find((w) => w.method === 'PUT' && !w.path.endsWith('/default'));
    assert.ok(put, 'the switches were not saved');
    assert.deepStrictEqual(put.body, { useDefault: false, forceChange: false, validHours: 0 });
    /* NO PASSWORD ON THE SWITCH REQUEST, which is why the two are separate
       routes: a request that changes a switch cannot carry a credential. */
    assert.strictEqual(put.body.defaultPassword, undefined);
    const r = await shape();
    assert.strictEqual(r.useChecked, false);
    assert.strictEqual(r.hours, '0');
  });

  await t.test('the "no encryption key" state says so instead of pretending', async () => {
    await signIn(SUPER, payload({ encryptionAvailable: false,
      fallbackNote: 'No default password can be stored: this server has no EMAIL_ENCRYPTION_KEY to encrypt it with.' }));
    const r = await shape();
    assert.strictEqual(r.present, true, 'the section still draws');
    assert.match(r.text, /EMAIL_ENCRYPTION_KEY/);
    assert.match(r.text, /JWT_SECRET is deliberately not accepted/);
  });

  await t.test('the "using the environment" state is called out', async () => {
    await signIn(SUPER, payload({ source: 'environment', willUseDefault: true, fallbackNote: null }));
    const r = await shape();
    assert.match(r.text, /DEFAULT_USER_PASSWORD/);
    assert.match(r.text, /only way to change it without a deploy/);
  });

  assert.deepStrictEqual(errors, [], `browser errors: ${errors.join('; ')}`);
});
