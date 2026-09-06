#!/usr/bin/env node
/* The checks that can be made without a screen.
 *
 * An Electron app is awkward to test on a build machine: the parts worth
 * checking are the ones that only misbehave once a window exists. So this
 * covers what CAN be established from the source and the configuration, and it
 * concentrates on the mistakes that are SILENT at runtime — the ones where the
 * app starts, looks correct, and simply never notifies anybody.
 *
 * It is deliberately not a mock of Electron. Every assertion below is about a
 * fact of the files themselves, so it cannot pass because a stub agreed with
 * it.
 *
 * Run: npm run check
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let failures = 0;
let checks = 0;

function ok(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

const pkg = JSON.parse(read('package.json'));
const builder = yaml.load(read('electron-builder.yml'));
const main = read('src/main.js');
const preload = read('src/preload.js');
const config = read('src/config.js');
const updates = read('src/updates.js');
const build = read('scripts/build.js');

group('Files the main process references', () => {
  /* Every one of these is loaded by path at runtime. A missing one is a blank
     window or a dead preload, with nothing in a log to say why. */
  for (const file of ['src/main.js', 'src/preload.js', 'src/config.js', 'src/updates.js',
                      'renderer/setup.html', 'renderer/offline.html',
                      'build/icon.png', 'build/installer-sidebar.bmp']) {
    ok(file, exists(file), 'referenced by the main process but not on disk');
  }
  ok('package.json main points at a real file', exists(pkg.main));
});

group('Windows notifications', () => {
  /* THE SILENT FAILURE. Without setAppUserModelId, or with one that does not
     match the installed application's identity, Windows drops every toast
     without an error. Nothing else in this project catches that. */
  const m = main.match(/setAppUserModelId\(['"]([^'"]+)['"]\)/);
  ok('main.js sets an Application User Model ID', Boolean(m),
    'Windows silently discards notifications from a process without one');
  ok('it matches electron-builder\'s appId', m && m[1] === builder.appId,
    m ? `main.js has ${m[1]}, electron-builder.yml has ${builder.appId}` : undefined);
});

group('Permissions granted to the page', () => {
  ok('a permission REQUEST handler is installed', /setPermissionRequestHandler/.test(main));
  /* Both must exist. With only the request handler, a page that CHECKS its
     permission is told no and never asks — notifications then fail quietly. */
  ok('a permission CHECK handler is installed', /setPermissionCheckHandler/.test(main),
    'without it, a page that checks before asking is refused and never prompts');
  ok('notifications are granted', /'notifications'/.test(main));
  ok('nothing else is', !/(['"])(media|geolocation|midi|camera|microphone)\1/.test(main),
    'this app needs the network and nothing else');
  ok('the grant is scoped to the studio origin', /appOrigin\(\)/.test(main));
});

group('The remote page is not trusted with Node', () => {
  ok('context isolation on', /contextIsolation:\s*true/.test(main));
  ok('node integration off', /nodeIntegration:\s*false/.test(main));
  ok('sandbox on', /sandbox:\s*true/.test(main));
  ok('webview tags refused', /webviewTag:\s*false/.test(main));
  /* The wrapper must be invisible to the application it shows. If the bridge
     were exposed on the remote page, the web app could start depending on it,
     and then it would need this wrapper to work. */
  ok('the bridge is exposed only on this wrapper\'s own screens',
    /isLocalScreen\s*=\s*location\.protocol === 'file:'/.test(preload)
    && /if \(isLocalScreen\) \{\s*\n\s*contextBridge/.test(preload),
    'window.zvky must not exist on the studio\'s own page');
});

group('No address is baked in', () => {
  /* A wrapper shipped pointing at a guessed domain is worse than one that asks.
     This is the check that would fail if somebody hard-coded a URL to save a
     step during testing and forgot to take it out. */
  const urls = [main, config, preload].join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n')
    .match(/https?:\/\/[a-z0-9.-]+/gi) || [];
  const foreign = urls.filter((u) => !/localhost|127\.0\.0\.1|example\.com|w3\.org/i.test(u));
  ok('no hard-coded studio address in the source', foreign.length === 0, foreign.join(', '));
  ok('the built-in default is empty unless set at build time',
    /ZVKY_APP_URL_DEFAULT \|\| ''/.test(config));
  ok('the address is validated before it becomes an origin', /function normalise/.test(config));
});

group('Updates: automatic, and installed only on a close', () => {
  /* THE POLICY CHANGED. It was: check quietly, download and install only on a
     click. It is now fully automatic at the studio's request, and these
     assertions moved with it — a check that still demanded autoDownload be off
     would have failed honestly, but one that merely mentioned the old wording
     would have passed while describing something untrue. */
  ok('updates download by themselves', /autoDownload = true/.test(updates));
  ok('and install as the app closes', /autoInstallOnAppQuit = true/.test(updates));
  ok('the launch check is quiet', /setTimeout\(\(\) => \{ checkQuietly\(\); \}/.test(updates));
  /* The half that is easy to leave out. Without it, an app left open for a
     fortnight — which is how this one is used — never looks again, and
     "automatic" holds only for people who restart anyway. */
  ok('a running copy keeps looking', /setInterval\(\(\) => \{ checkQuietly\(\); \}, RECHECK_MS\)/.test(updates),
    'otherwise it is automatic only for whoever restarts');
  ok('and that timer cannot hold the process open at quit', /timer\.unref/.test(updates),
    'quit is exactly when the install wants to run');

  /* THE ONE THING THAT MUST STILL NEVER HAPPEN BY ITSELF. Automatic means
     installed on a close the person chose — never a restart in the middle of
     their work. quitAndInstall is what would do that, so it stays reachable
     only from the explicit Restart Now. */
  ok('nothing restarts the app without being asked',
    (updates.match(/quitAndInstall/g) || []).length === 1
    && /async function installNow/.test(updates),
    'the automatic path installs on quit; quitAndInstall is the accelerator only');
  ok('and the bar never triggers it on paint',
    /parts\.go\.addEventListener\('click'/.test(preload)
    && !/paint[\s\S]{0,200}install-update/.test(preload));
  ok('the bar reads as a notice, not a prompt',
    /installs when you close/.test(preload),
    'nothing there is waiting on the person reading it');
  ok('a manual check answers every outcome',
    (updates.match(/showMessageBox/g) || []).length >= 4);

  /* THE BUG THIS SECTION EXISTS FOR, from here down.
   *
   * A build made without an update address has no app-update.yml in its
   * resources, and electron-updater's first call then throws a bare
   * "ENOENT ... app-update.yml". A studio pressed Check for Updates and got
   * that. Three things had to change, and each is asserted rather than trusted:
   * the file's absence is detected BEFORE the call that would throw; a feed
   * held in settings is applied at runtime so such a build is not stuck for
   * ever; and the raw error, if it ever surfaces, is translated. */
  ok('the missing feed file is detected before it can throw',
    /function hasPackagedFeed/.test(updates) && /app-update\.yml/.test(updates),
    'without this the button reports a raw ENOENT');
  ok('every path that talks to the updater applies a feed first',
    (updates.match(/applyFeed\(\)/g) || []).length >= 3,
    'the launch check, the manual check and the download');
  ok('a feed can be set at runtime, not only baked in at build time',
    /setFeedURL\(/.test(updates) && /config\.updateFeed\(\)/.test(updates),
    'a build with no baked feed could otherwise never update its way out');
  /* setFeedURL alone fixes the CHECK and leaves the DOWNLOAD broken:
     getOrCreateDownloadHelper reads updaterCacheDirName off the config file
     unconditionally, and loadUpdateConfig is a bare readFile. A config file has
     to exist for the download to survive, so one is written. */
  ok('and a config file is written, so the DOWNLOAD survives too',
    /writeRuntimeConfig/.test(updates) && /updaterCacheDirName/.test(updates),
    'setFeedURL alone would fix the button and still throw on Update Now');
  ok('the private field it needs is guarded, not assumed',
    /'_appUpdateConfigPath' in autoUpdater/.test(updates));
  ok('and the packaged case is left exactly as it was',
    /if \(!hasPackagedFeed\(\)\) \{/.test(updates));
  ok('and the raw ENOENT is translated if it ever surfaces',
    /ENOENT/.test(updates) && /NO_FEED/.test(updates));
  ok('the update address is a separate setting from the studio address',
    /updateFeed/.test(config) && /setUpdateFeed/.test(config)
    && !/appUrl:\s*normaliseFeed/.test(config));
  ok('a feed address carries the trailing slash electron-updater joins onto',
    /\$\{base\}\//.test(config),
    'without it latest.yml resolves against the parent folder and 404s');
  ok('there is a way to set it from the menu',
    /promptForFeed/.test(read('src/main.js')) && exists('renderer/feed.html'));
  /* The feed is passed at build time and is OPTIONAL. Written into
     electron-builder.yml as a ${env.X} macro instead, an unset variable stops
     the build entirely — so an installer could not be produced until update
     hosting existed, which is backwards. */
  ok('no update feed is baked into the build config', builder.publish === null,
    JSON.stringify(builder.publish));
  ok('the build passes one from the environment when it is set',
    /ZVKY_UPDATE_FEED/.test(build) && /-c\.publish\.provider=generic/.test(build));
  ok('and builds anyway when it is not',
    /Update feed: NOT SET/.test(build));
});

group('The update bar cannot disturb the web application', () => {
  ok('it lives in a shadow root', /attachShadow\(\{ mode: 'closed' \}\)/.test(preload));
  ok('the host resets inherited style', /'all: initial'/.test(preload));
  ok('it is positioned out of flow', /'position: fixed'/.test(preload));
  ok('it attaches to documentElement, not body',
    /documentElement \|\| document\.body\)\.appendChild/.test(preload),
    'appending to a body the app re-renders would make the bar vanish at random');
  ok('it is absent unless there is an update', /remove\(\);\s*\n\s*return;/.test(preload));
});

group('Links leave the window', () => {
  ok('window.open goes to the browser', /setWindowOpenHandler/.test(main));
  ok('off-origin navigation goes to the browser', /will-navigate/.test(main));
  ok('both use the shell', (main.match(/shell\.openExternal/g) || []).length >= 2);
});

group('Installers', () => {
  ok('Windows target is nsis', builder.win.target.some((t) => t.target === 'nsis'));
  ok('per-user install, no administrator needed', builder.nsis.perMachine === false);
  ok('the installer is not one-click', builder.nsis.oneClick === false);
  ok('settings survive an uninstall', builder.nsis.deleteAppDataOnUninstall === false);
  ok('macOS target is dmg', builder.mac.target.some((t) => t.target === 'dmg'));
  /* AND a zip, which is not a duplicate of the dmg — it is the only thing
     electron-updater will install a macOS update from. MacUpdater.js calls
     findFile(files, 'zip', ['pkg', 'dmg']) and throws
     ERR_UPDATER_ZIP_FILE_NOT_FOUND when there is none, so a dmg-only build
     installs perfectly and can never update itself. That failure surfaces
     months later, on the first release, on somebody else's Mac — exactly the
     silent kind this file exists to catch. */
  ok('macOS also builds the zip that updates require',
    builder.mac.target.some((t) => t.target === 'zip'),
    `targets are ${JSON.stringify(builder.mac.target.map((t) => t.target))} — `
    + 'updates would fail with ERR_UPDATER_ZIP_FILE_NOT_FOUND');
  /* Both architectures, or an Apple Silicon Mac finds only an Intel update and
     refuses it. The dmg list above and this one have to agree. */
  ok('the zip covers both architectures',
    (builder.mac.target.find((t) => t.target === 'zip') || {}).arch
      ?.join(',') === 'x64,arm64');
  /* The two architectures are built AT THE SAME TIME and each mounts a volume
     named after this. Without the ${arch} they collide on /Volumes, one
     detaches the volume the other is still using, and the build dies — but
     only sometimes, depending on which finishes first. */
  ok('each disk image mounts under its own name', /\$\{arch\}/.test(builder.dmg.title || ''),
    `title is "${builder.dmg.title}" — concurrent builds would share a volume`);
  ok('macOS uses no certificate, as agreed', builder.mac.identity === null);
  ok('hardened runtime off (it requires signing)', builder.mac.hardenedRuntime === false);
  /* identity: null makes electron-builder skip signing ENTIRELY. On Apple
     Silicon that is not "unsigned", it is unlaunchable — so the ad-hoc hook
     has to be there, and the two settings have to stay together. */
  ok('an ad-hoc signature is applied anyway', builder.afterPack === 'scripts/adhoc-sign.js',
    'without it the arm64 build will not start at all');
  ok('the hook exists', exists('scripts/adhoc-sign.js'));
  ok('it stands aside for a real certificate',
    /CSC_LINK \|\| process\.env\.CSC_NAME/.test(read('scripts/adhoc-sign.js')));
  ok('and it verifies what it signed',
    /'--verify'/.test(read('scripts/adhoc-sign.js')));
  /* This wrapper ships no web assets. If a build ever started including some,
     it would mean a copy of the application had been vendored in here — which
     is exactly what must not happen. */
  ok('nothing from the web application is packaged',
    builder.files.every((f) => /^(src|renderer|package\.json)/.test(f)),
    builder.files.join(', '));
});

group('It stays out of the web application', () => {
  /* The standing boundary: this project may not reach up out of its own
     directory. A require or a path that climbs past desktop/ would couple the
     two, and the studio asked for the opposite. */
  const sources = ['src/main.js', 'src/preload.js', 'src/config.js', 'src/updates.js', 'scripts/check.js']
    .map((f) => ({ f, text: read(f) }));
  for (const { f, text } of sources) {
    const climbs = (text.match(/require\(['"]\.\.\/\.\.[^'"]*['"]\)/g) || []);
    ok(`${f} requires nothing outside desktop/`, climbs.length === 0, climbs.join(', '));
  }
  const outside = sources.filter(({ text }) => /['"]\.\.\/\.\.\//.test(text.replace(/__dirname, '\.\.'/g, '')));
  ok('no path reaches above this directory', outside.length === 0,
    outside.map((o) => o.f).join(', '));
});

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.log(`${failures} FAILED.`);
  process.exit(1);
}
