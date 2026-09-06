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

group('Updates: checked quietly, installed on a click', () => {
  ok('nothing downloads by itself', /autoDownload = false/.test(updates));
  ok('nothing installs on quit', /autoInstallOnAppQuit = false/.test(updates));
  ok('the launch check is quiet', /setTimeout\(\(\) => \{ checkQuietly\(\); \}/.test(updates));
  ok('quitAndInstall runs only from downloadAndInstall',
    (updates.match(/quitAndInstall/g) || []).length === 1);
  /* The click has to be a click. If the bar called quitAndInstall on paint, an
     update would restart somebody's machine mid-review. */
  ok('the bar installs only from a click handler',
    /parts\.go\.addEventListener\('click'/.test(preload)
    && !/paint[\s\S]{0,200}install-update/.test(preload));
  ok('a manual check answers every outcome',
    (updates.match(/showMessageBox/g) || []).length >= 4);
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
  ok('macOS builds unsigned, as agreed', builder.mac.identity === null);
  ok('hardened runtime off (it requires signing)', builder.mac.hardenedRuntime === false);
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
