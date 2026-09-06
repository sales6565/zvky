/* config.js reached without Electron: require('electron') resolves to a path
   string outside it, and read() already swallows the resulting failure — so the
   feed precedence can be exercised for real rather than reasoned about. */
const assert = require('node:assert');
const Module = require('node:module');
const fsBoot = require('node:fs');
const osBoot = require('node:os');
const pathBoot = require('node:path');

/* Stand-in modules live in a real directory, resolved through realpathSync,
 * and each gets a name of its own.
 *
 * NOT /tmp with a fixed filename, which is what this did first and what passed
 * on Linux and failed on macOS: /tmp there is a symlink to /private/tmp, so
 * Node caches a module under the real path while a delete keyed on /tmp misses
 * it. Every scenario after the first then silently reused the first one's
 * Electron — which had no isPackaged, so all three reported "run from source"
 * while claiming to test something else. Unique paths cannot have that problem
 * on any platform. */
const STUBS = fsBoot.realpathSync(fsBoot.mkdtempSync(pathBoot.join(osBoot.tmpdir(), 'zvky-stubs-')));

/* ONE stub file per module, whose contents are read live from globals.
 *
 * Not a new file per scenario, which is what this tried first and what only
 * looked right: Node resolved and cached the boot stub, later ones were never
 * loaded, and every scenario silently ran against an Electron with no
 * isPackaged — reporting "run from source" while claiming to test a packaged
 * app. It passed on Linux by luck and failed on macOS, where /tmp is a symlink
 * and the cache keys stop lining up.
 *
 * Getters sidestep the whole problem. The module is loaded once and cached
 * forever, exactly as Node wants; what it hands back is decided per scenario.
 * updates.js destructures { app, dialog } at load, so the getter runs then and
 * returns whatever this scenario put in place.
 */
const ELECTRON_STUB = pathBoot.join(STUBS, 'electron.js');
const UPDATER_STUB = pathBoot.join(STUBS, 'electron-updater.js');
fsBoot.writeFileSync(ELECTRON_STUB, `module.exports = {
  get app() { return global.__zvkyApp; },
  get dialog() { return global.__zvkyDialog; },
  get BrowserWindow() { return global.__zvkyBrowserWindow; },
};`);
fsBoot.writeFileSync(UPDATER_STUB, 'module.exports = { get autoUpdater() { return global.__zvkyUpdater; } };');

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return ELECTRON_STUB;
  if (req === 'electron-updater') return UPDATER_STUB;
  return realResolve.call(this, req, ...rest);
};

// What the config tests below see: no userData, because they are not in
// Electron and read() is meant to cope with exactly that.
global.__zvkyApp = { getPath: () => { throw new Error('no userData outside electron'); } };

let pass = 0, fail = 0;
const t = (label, fn) => { try { fn(); console.log('  ✓ ' + label); pass++; }
  catch (e) { console.log('  ✗ ' + label + '\n      ' + e.message); fail++; } };

process.env.ZVKY_UPDATE_FEED = '';
delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
let config = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));

t('no feed anywhere reads as none', () => assert.strictEqual(config.updateFeed(), null));

process.env.ZVKY_UPDATE_FEED = 'https://updates.example.com/desktop';
delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
config = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));
t('an environment feed wins', () =>
  assert.strictEqual(config.updateFeed(), 'https://updates.example.com/desktop/'));
t('and gains the trailing slash electron-updater joins latest.yml onto', () =>
  assert.ok(config.updateFeed().endsWith('/')));

process.env.ZVKY_UPDATE_FEED = 'updates.example.com/desktop';
delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
config = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));
t('a bare host is read as https', () =>
  assert.strictEqual(config.updateFeed(), 'https://updates.example.com/desktop/'));

process.env.ZVKY_UPDATE_FEED = 'not a url';
delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
config = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));
t('nonsense is refused rather than becoming a feed', () =>
  assert.strictEqual(config.updateFeed(), null));

t('setUpdateFeed refuses nonsense with a sentence', () => {
  const r = config.setUpdateFeed('not a url');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /web address/i);
});

process.env.ZVKY_UPDATE_FEED = '';
process.env.ZVKY_UPDATE_FEED_DEFAULT = 'https://baked.example.com/desktop';
delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
config = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));
t('a build-time default is used when nothing else is set', () =>
  assert.strictEqual(config.updateFeed(), 'https://baked.example.com/desktop/'));

t('the studio address is a different setting entirely', () => {
  process.env.ZVKY_APP_URL = 'https://studio.example.com';
  delete require.cache[require.resolve(require('node:path').join(__dirname, '..', 'src', 'config.js'))];
  const c = require(require('node:path').join(__dirname, '..', 'src', 'config.js'));
  assert.strictEqual(c.appUrl(), 'https://studio.example.com');
  assert.notStrictEqual(c.appUrl(), c.updateFeed());
});


/* ---- applyFeed, the part this bug was about ------------------------------
 *
 * Static checks can say the code mentions setFeedURL. They cannot say that a
 * package with no app-update.yml ends up with something the DOWNLOAD path can
 * read — which is the half that would still have thrown. So updates.js is run
 * against a stand-in updater and a stand-in resources folder, and what it
 * actually did is inspected.
 */
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

function scenario({ packagedFeed, settingsFeed }) {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zvky-feed-'));
  const resources = pathMod.join(dir, 'resources');
  const userData = pathMod.join(dir, 'userData');
  fs.mkdirSync(resources); fs.mkdirSync(userData);
  if (packagedFeed) {
    fs.writeFileSync(pathMod.join(resources, 'app-update.yml'),
      `provider: generic\nurl: ${packagedFeed}\nchannel: latest\nupdaterCacheDirName: zvky-forge-desktop-updater\n`);
  }

  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: {},
    _appUpdateConfigPath: null,       // the field electron-updater really has
    feedSetTo: null,
    on() {},
    setFeedURL(opts) { this.feedSetTo = opts; },
  };

  // What this scenario's Electron is. Read through the getters above.
  global.__zvkyApp = {
    isPackaged: true,
    getPath: () => userData,
    getVersion: () => '1.0.2',
    whenReady: () => Promise.resolve(),
  };
  global.__zvkyDialog = { showMessageBox: async () => ({ response: 1 }) };
  global.__zvkyBrowserWindow = function () {};
  global.__zvkyUpdater = updater;

  /* Left in place for the lifetime of the scenario, NOT restored after the
     require: hasPackagedFeed() reads it when the check runs, not when the
     module loads. Restoring it early made scenario one assert against the
     working directory instead of the fake package. */
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  process.env.ZVKY_UPDATE_FEED = settingsFeed || '';
  // The config block above sets a build-time default; it must not leak in here.
  delete process.env.ZVKY_UPDATE_FEED_DEFAULT;
  delete process.env.ZVKY_APP_URL;

  // Only these two need clearing now: the stubs are at new paths each time.
  for (const m of ['src/updates.js', 'src/config.js']) {
    delete require.cache[require.resolve(pathMod.join(__dirname, '..', m))];
  }
  const updates = require(pathMod.join(__dirname, '..', 'src', 'updates.js'));

  /* Asserted rather than assumed, because the failure mode this replaced was
     silent: a stale stub makes every scenario below pass or fail for a reason
     that has nothing to do with what it says it is testing. */
  if (!updates.state) throw new Error('updates.js did not load');
  /* The check that would have caught the whole mess above: if the stub is not
     the one in force, nothing below is testing what it says it is. */
  if (updates.state().status !== 'idle') {
    throw new Error(`stale updates.js — state was ${updates.state().status} before wire()`);
  }

  return { updates, updater, userData, resources };
}

/* Each scenario drives checkQuietly(), because THAT is what applies the feed —
   wire() only registers handlers and schedules it. Asserting after wire() alone
   reads the state before anything has happened, which is what the first draft
   of this file did. */
async function ta(label, fn) {
  try { await fn(); console.log('  ✓ ' + label); pass++; }
  catch (e) { console.log('  ✗ ' + label + '\n      ' + e.message); fail++; }
}

(async () => {
  await ta('a package WITH its own config is left alone', async () => {
    const s = scenario({ packagedFeed: 'https://baked.example.com/desktop/', settingsFeed: 'https://typed.example.com/desktop' });
    s.updates.wire(() => null);
    await s.updates.checkQuietly();
    assert.ok(s.updater.feedSetTo, 'the typed address still overrides the provider');
    assert.strictEqual(s.updater._appUpdateConfigPath, null,
      'but its own file is not replaced — the packaged path is untouched');
  });

  await ta('a package WITHOUT one is given a config the download path can read', async () => {
    const s = scenario({ packagedFeed: null, settingsFeed: 'https://typed.example.com/desktop' });
    s.updates.wire(() => null);
    await s.updates.checkQuietly();
    assert.ok(s.updater.feedSetTo, 'the provider is set');
    assert.ok(s.updater._appUpdateConfigPath, 'AND a config file path is supplied');
    const written = fs.readFileSync(s.updater._appUpdateConfigPath, 'utf8');
    // updaterCacheDirName is the exact field getOrCreateDownloadHelper reads.
    assert.match(written, /updaterCacheDirName:/, 'holding what the download path needs');
    assert.match(written, /url: https:\/\/typed\.example\.com\/desktop\//);
  });

  await ta('a package with neither says so instead of throwing', async () => {
    const s = scenario({ packagedFeed: null, settingsFeed: '' });
    s.updates.wire(() => null);
    await s.updates.checkQuietly();
    const state = s.updates.state();
    assert.strictEqual(state.status, 'unsupported', JSON.stringify(state));
    assert.match(state.message, /no update address|nowhere to check/i);
    assert.doesNotMatch(state.message, /ENOENT/, 'and never shows the raw error');
  });

  console.log(`\n${pass}/${pass + fail} passed.`);
  process.exit(fail ? 1 : 0);
})();
