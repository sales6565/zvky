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
const { app, dialog } = require('electron');

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

module.exports = { wire, checkQuietly, checkManually, downloadAndInstall, state: () => ({ ...current }) };
