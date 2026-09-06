/* Updating the wrapper.
 *
 * THE SHAPE THE STUDIO ASKED FOR, and each part of it is a decision:
 *
 *   CHECKED SILENTLY ON LAUNCH. autoDownload is off, so the check is a few
 *   kilobytes of manifest and nothing is fetched behind anybody's back.
 *
 *   SHOWN, NOT ACTED ON. A new version puts a bar at the top of the window
 *   saying so. Nothing downloads and nothing installs until somebody presses
 *   Update Now — an application that restarts itself mid-review is one people
 *   learn to distrust.
 *
 *   INSTALLED ONLY ON A CLICK, and the click is the same one whether it came
 *   from the bar or from the menu. One path, so the two cannot behave
 *   differently.
 *
 * WHERE IT LOOKS is baked into the package by electron-builder from the
 * `publish` block in electron-builder.yml — a plain folder on the studio's own
 * hosting. If that was never set, electron-updater has no feed and every check
 * fails; this treats that as "no update", quietly on launch and with an honest
 * sentence when somebody asked, because a studio that has not set up hosting
 * for updates yet should still be able to use the application.
 *
 * NOTHING HERE RUNS IN DEVELOPMENT. electron-updater refuses to work in an
 * unpackaged app, so the guard is explicit rather than a confusing error.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const config = require('./config');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  /* The dependency is missing — a broken install. The application still opens
     and still works; it just cannot update itself, which is the right way round
     for a wrapper whose job is to show a website. */
  autoUpdater = null;
}

/* What the window is told. `status` is the whole of it, so the bar and the menu
   are reading one fact rather than each keeping a guess. */
const current = {
  status: 'idle',        // idle | checking | available | downloading | ready | error | unsupported
  version: null,         // the version that is available, once one is
  percent: 0,
  message: null,
};

let getWindow = () => null;

const send = (channel, payload) => {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const publish = () => send('zvky:update-state', { ...current });

function set(patch) {
  Object.assign(current, patch);
  publish();
}

const usable = () => Boolean(autoUpdater) && app.isPackaged;

/* Does this package carry the file electron-updater reads its feed from?
 *
 * electron-builder writes app-update.yml into resources ONLY when a publish URL
 * was given at build time. Without it, the first call to checkForUpdates()
 * throws a bare
 *
 *   ENOENT: no such file or directory, open '...\resources\app-update.yml'
 *
 * which is what a studio actually saw on pressing the button. Asked in advance
 * rather than discovered by catching that error, so the app can say something
 * true before it tries, and so a runtime feed can be applied instead. */
function packagedFeedFile() {
  try {
    return path.join(process.resourcesPath || '', 'app-update.yml');
  } catch {
    return null;
  }
}
function hasPackagedFeed() {
  const file = packagedFeedFile();
  try {
    return Boolean(file) && fs.existsSync(file);
  } catch {
    return false;
  }
}

/* Point electron-updater at the feed held in settings, when there is one.
 *
 * TWO THINGS, AND BOTH ARE NEEDED. This is worth setting out, because doing
 * only the obvious half fixes the button and leaves the download broken —
 * which is a worse bug than the one being fixed, since it fails later, after
 * somebody has been told an update is waiting.
 *
 *   setFeedURL() replaces the provider, so CHECKING works without the packaged
 *   file: getUpdateInfoAndProvider() skips reading it when a client already
 *   exists (AppUpdater.js — `if (this.clientPromise == null)`).
 *
 *   DOWNLOADING does not take that path. getOrCreateDownloadHelper() reads
 *   `(await this.configOnDisk.value).updaterCacheDirName` unconditionally, and
 *   loadUpdateConfig() is a bare readFile that throws the same ENOENT. So a
 *   config file has to exist somewhere for the download to survive.
 *
 * So when the package has none, one is written into the app's own data folder
 * and electron-updater is pointed at it. That file is ours, not a forgery of
 * the build's: it holds exactly what electron-builder would have written.
 *
 * `_appUpdateConfigPath` is private to electron-updater, which is why the
 * version is pinned and why this is guarded: if a future version drops the
 * field, the guard reports it rather than the app failing at download time.
 * Checked against electron-updater 6.x.
 *
 * Returns whether there is any feed to check at all.
 */
function writeRuntimeConfig(feed) {
  const file = path.join(app.getPath('userData'), 'app-update.yml');
  const yaml = [
    '# Written by ZVKY FORGE, not by the build.',
    '#',
    '# This copy was built without an update address, so it has no app-update.yml',
    '# of its own. Rather than being unable to update for ever, it keeps the',
    '# address here. Change it under File -> Update Source; deleting this file',
    '# is harmless and it will be written again.',
    'provider: generic',
    `url: ${feed}`,
    'channel: latest',
    'updaterCacheDirName: zvky-forge-desktop-updater',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml);
  return file;
}

function applyFeed() {
  const feed = config.updateFeed();

  if (!feed) {
    // Nothing in settings. The packaged file is the only hope.
    if (hasPackagedFeed()) return { ok: true, source: 'packaged' };
    return { ok: false, missing: true };
  }

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed, channel: 'latest' });
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }

  /* Only when the package has none of its own. A build that WAS given a feed at
     build time keeps reading its own file for the cache directory, exactly as
     it always has — this changes nothing for the normal case. */
  if (!hasPackagedFeed()) {
    if (!('_appUpdateConfigPath' in autoUpdater)) {
      return { ok: false,
        error: 'This copy has no update address of its own, and this version of the updater '
          + 'cannot be pointed at one. Install a build made with an update address.' };
    }
    try {
      autoUpdater._appUpdateConfigPath = writeRuntimeConfig(feed);
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  }

  return { ok: true, source: 'settings', url: feed };
}

/* The sentence somebody gets when there is nowhere to check.
 *
 * Names the cause and the two ways out, because the alternative — the raw
 * ENOENT — reads like the application is broken rather than unconfigured. */
const NO_FEED =
  'This copy was built without an update address, so there is nowhere to check.\n\n'
  + 'Set one under File \u2192 Update Source, or install a build that has one baked in. '
  + 'Once an address is set here, updates work from this copy onwards \u2014 no reinstall needed.';

function wire(windowGetter) {
  getWindow = windowGetter || (() => null);
  if (!usable()) {
    set({ status: 'unsupported', message: app.isPackaged
      ? 'Updates are unavailable in this build.'
      : 'Updates only work in an installed copy, not when run from source.' });
    return;
  }

  // Nothing is fetched until somebody asks for it. This is the whole policy.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', message: null }));
  autoUpdater.on('update-available', (info) => set({
    status: 'available', version: info && info.version, message: null,
  }));
  autoUpdater.on('update-not-available', () => set({
    status: 'idle', version: null, message: null,
  }));
  autoUpdater.on('download-progress', (p) => set({
    status: 'downloading', percent: Math.round((p && p.percent) || 0),
  }));
  autoUpdater.on('update-downloaded', (info) => set({
    status: 'ready', version: info && info.version, percent: 100,
  }));
  autoUpdater.on('error', (err) => set({
    status: 'error',
    message: friendly(err),
  }));

  /* The silent check on launch. Delayed a few seconds so it competes with
     neither the window appearing nor the application's own first load — an
     update check is never the most urgent thing happening at startup. */
  setTimeout(() => { checkQuietly(); }, 4000);
}

/* An error somebody can act on. electron-updater's own messages are accurate
   and unreadable ("HttpError: 404 Not Found ... latest.yml"), and the two that
   actually happen have plain causes worth naming. */
function friendly(err) {
  const text = String((err && err.message) || err || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(text)) {
    return 'Could not reach the update server. This needs the same network access as the application itself.';
  }
  /* The error this whole fix exists for. It should now be unreachable — the
     feed is checked before any call that could raise it — but a translation
     costs nothing and the raw form tells a studio nothing they can act on. */
  if (/ENOENT/.test(text) && /app-update\.yml/i.test(text)) {
    return NO_FEED;
  }
  if (/404/.test(text)) {
    return 'No update information was published at the update address yet.';
  }
  if (/ERR_UPDATER_INVALID_RELEASE_FEED|Unable to find latest version/i.test(text)) {
    return 'The update address is reachable but does not hold a valid release.';
  }
  return text || 'The update check failed.';
}

async function checkQuietly() {
  if (!usable()) return current;
  const feed = applyFeed();
  if (!feed.ok) {
    /* Recorded, not shown. On launch this is not worth a dialog — but the menu
       reports it when somebody asks, and the state says why. */
    set({ status: 'unsupported', message: feed.missing ? NO_FEED : feed.error });
    return current;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    /* On launch this is deliberately quiet: somebody opening the application to
       do their work should not be met with a dialog because a server was slow.
       The state is recorded, so the menu can still report it if asked. */
    set({ status: 'error', message: friendly(err) });
  }
  return current;
}

/* The menu item. The same check, but somebody asked — so silence would read as
   a broken button, and every outcome gets an answer. */
async function checkManually(win) {
  if (!usable()) {
    await dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: 'Check for Updates',
      message: current.message || 'Updates are not available in this build.',
      detail: app.isPackaged ? undefined
        : 'Run an installed copy to test the updater; a copy started from source has no version to compare against.',
      buttons: ['OK'],
    });
    return { ...current };
  }

  const feed = applyFeed();
  if (!feed.ok) {
    set({ status: 'unsupported', message: feed.missing ? NO_FEED : feed.error });
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: 'Check for Updates',
      message: feed.missing ? 'No update address is set.' : 'The update address could not be used.',
      detail: current.message,
      buttons: feed.missing ? ['Set Update Address\u2026', 'OK'] : ['OK'],
      defaultId: 0,
      cancelId: feed.missing ? 1 : 0,
    });
    // Straight to the thing that fixes it, rather than an instruction to go
    // and find it.
    if (feed.missing && response === 0) await promptForFeed(win);
    return { ...current };
  }

  set({ status: 'checking', message: null });
  let result = null;
  try {
    result = await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ status: 'error', message: friendly(err) });
    await dialog.showMessageBox(win || undefined, {
      type: 'warning', title: 'Check for Updates',
      message: 'Could not check for updates.',
      detail: current.message, buttons: ['OK'],
    });
    return { ...current };
  }

  const version = result && result.updateInfo && result.updateInfo.version;
  if (!version || version === app.getVersion()) {
    set({ status: 'idle', version: null });
    await dialog.showMessageBox(win || undefined, {
      type: 'info', title: 'Check for Updates',
      message: `ZVKY FORGE ${app.getVersion()} is the latest version.`,
      buttons: ['OK'],
    });
    return { ...current };
  }

  /* There is one. Ask, rather than starting: this is the click the studio
     asked to be the only thing that begins an install. */
  set({ status: 'available', version });
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'Update available',
    message: `ZVKY FORGE ${version} is available.`,
    detail: `You are running ${app.getVersion()}. The update downloads first, and installs when you choose to restart.`,
    buttons: ['Update Now', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) downloadAndInstall(win);
  return { ...current };
}

/* Download, then install on a second confirmation.
 *
 * Two steps rather than one, because they interrupt differently: a download
 * costs bandwidth and can happen while somebody keeps working, and an install
 * closes the application. Collapsing them would mean pressing "Update Now"
 * quits the app at an unpredictable moment later, which is the behaviour people
 * complain about in every application that does it. */
async function downloadAndInstall(win) {
  if (!usable()) return { ...current };
  // The check that found this update may have been a while ago, and the address
  // could have been changed since.
  const feed = applyFeed();
  if (!feed.ok) {
    set({ status: 'unsupported', message: feed.missing ? NO_FEED : feed.error });
    return { ...current };
  }
  try {
    set({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    set({ status: 'error', message: friendly(err) });
    await dialog.showMessageBox(win || undefined, {
      type: 'warning', title: 'Update', message: 'The update could not be downloaded.',
      detail: current.message, buttons: ['OK'],
    });
    return { ...current };
  }

  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'Update ready',
    message: `ZVKY FORGE ${current.version || ''} is ready to install.`,
    detail: 'The application will close and reopen. Anything unsaved in a form should be saved first.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    /* isSilent false so a person sees the installer do its work rather than
       wondering whether anything happened; isForceRunAfter true so they land
       back where they were. */
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }
  return { ...current };
}

/* Asking for the update address.
 *
 * A prompt window rather than a field on the first-run screen: the studio
 * address is something every person must answer to use the app at all, and this
 * is something most people will never touch. It lives beside Check for Updates,
 * which is where somebody is standing when they discover they need it.
 *
 * Electron has no text-input dialog, so this is a small window of our own. It
 * shows what is currently in force and where that came from, because "no
 * address" and "an address that is not answering" need different actions.
 */
async function promptForFeed(win) {
  const { BrowserWindow } = require('electron');
  const currentFeed = config.updateFeed() || '';
  const source = config.read().updateFeed ? 'set on this computer'
    : (currentFeed ? 'built into this copy' : 'not set');

  const prompt = new BrowserWindow({
    parent: win || undefined,
    modal: Boolean(win),
    width: 520,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Update Source',
    backgroundColor: '#14100f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  prompt.setMenuBarVisibility(false);
  await prompt.loadFile(path.join(__dirname, '..', 'renderer', 'feed.html'), {
    query: { current: currentFeed, source },
  });

  return new Promise((resolve) => {
    prompt.on('closed', () => resolve(config.updateFeed()));
  });
}

module.exports = {
  wire,
  checkQuietly,
  checkManually,
  downloadAndInstall,
  promptForFeed,
  hasPackagedFeed,
  state: () => ({ ...current }),
};
