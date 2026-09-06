/* ZVKY FORGE, in a native window.
 *
 * WHAT THIS IS, and just as importantly what it is not. It opens the studio's
 * own hosted application in a window and adds the three things a browser tab
 * cannot give it: a real application icon in the dock and the task bar,
 * notifications the operating system delivers rather than the browser, and a
 * way to update itself.
 *
 * IT CHANGES NOTHING SERVER-SIDE. There is no copy of the web application in
 * here, no bundled assets, no API of its own. Every request goes to the same
 * host a browser would reach, over the same HTTPS, with the same cookies and
 * the same session — which is why the studio's IP allowlist applies to this
 * exactly as it applies to Chrome. A machine off the allowed network cannot use
 * this app either, and that is a property of it being a window rather than
 * something that had to be built.
 *
 * THE ONE THING WORTH KNOWING ABOUT NOTIFICATIONS. The web application already
 * calls the standard `new Notification(...)`. Inside Electron that API is
 * routed to the operating system's own notification centre — so the desktop
 * notifications this wrapper delivers are the SAME code path the browser
 * version uses, and no change to the web application was needed or made. What
 * this file adds is the two pieces of plumbing without which that silently
 * fails: granting the permission for the studio's origin, and setting the
 * Windows Application User Model ID.
 */
const { app, BrowserWindow, Menu, shell, session, dialog, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const config = require('./config');
const updates = require('./updates');

/* WITHOUT THIS, NOTIFICATIONS DO NOT APPEAR ON WINDOWS. Not "appear wrongly" —
 * they are silently dropped, with no error anywhere, because Windows will not
 * show a toast from a process it cannot attribute to an installed application.
 * It must match the appId in electron-builder.yml. This is the single most
 * commonly missed line in an Electron app that notifies. */
app.setAppUserModelId('com.zvky.forge');

/* One window, one instance. A second launch focuses the first rather than
   opening a duplicate signed-in copy — two windows on one session is a way to
   confuse somebody about which one is current. */
const single = app.requestSingleInstanceLock();
if (!single) app.quit();

let win = null;

const ICON = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    /* The studio's own dark ground, so the window does not flash white while
       the application loads. */
    backgroundColor: '#14100f',
    icon: ICON,
    show: false,
    title: 'ZVKY FORGE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      /* The defaults, spelled out because they are the security posture rather
         than an accident. The page being loaded is REMOTE, so it gets no Node:
         context isolation on, node integration off, sandbox on. The preload
         talks to it through a named channel and nothing else. */
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  // Shown once it has something to draw, rather than as an empty frame.
  win.once('ready-to-show', () => win.show());

  const url = config.appUrl();
  if (url) win.loadURL(url);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));

  /* A link to somewhere else belongs in the person's browser, not in this
     window. Two cases: a target=_blank (window.open) and an ordinary navigation
     that leaves the studio's origin — a Google Doc in a brief, say. Both open
     outside, so this window can never become a general-purpose browser with no
     address bar to tell somebody where they are. */
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    const origin = config.appOrigin();
    if (!origin) return;
    try {
      if (new URL(target).origin !== origin) {
        event.preventDefault();
        shell.openExternal(target).catch(() => {});
      }
    } catch { event.preventDefault(); }
  });

  /* When the studio is unreachable — off the allowlisted network, no internet,
     the host down — say which of those it looks like rather than showing
     Chromium's error page, which tells somebody nothing they can act on. */
  win.webContents.on('did-fail-load', (event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return;   // an aborted load, i.e. a navigation replaced it
    win.loadFile(path.join(__dirname, '..', 'renderer', 'offline.html'), {
      query: { code: String(code), description: description || '', url: failedUrl || '' },
    }).catch(() => {});
  });

  win.on('closed', () => { win = null; });
}

/* Notifications, and nothing else.
 *
 * Electron grants every permission a page asks for unless something decides
 * otherwise. That is too generous for a window pointed at the open web, so this
 * decides: the studio's own origin may notify, and every other permission from
 * every origin is refused. A pipeline tool has no business asking for a camera,
 * a microphone, or a location, and refusing by default means a compromised page
 * cannot ask for one either.
 *
 * This is also the "asked once" the studio wanted. The OPERATING SYSTEM still
 * has its own say — macOS prompts the person the first time a notification is
 * actually raised, and that prompt is Apple's, not this app's — but the
 * browser-level permission the web application checks is answered here, once,
 * without a dialog the person has to understand.
 */
const ALLOWED_PERMISSIONS = new Set(['notifications']);

/* Is this the studio's own page asking?
 *
 * COMPARED AS URLS, NOT AS STRINGS, and that is not fussiness. Electron hands
 * the check handler an origin with a trailing slash ("https://studio/") while
 * URL.origin — which is what config produces — has none ("https://studio").
 * Comparing those two with === is false for the same site, and the failure it
 * causes is invisible: Notification.permission reads "denied", so a web
 * application that checks before asking decides notifications are blocked and
 * never asks. Nothing is logged. Nothing looks broken. The notifications simply
 * never arrive.
 *
 * This was found by the smoke test raising a notification from the real page,
 * not by reading the code, which is why that test raises one.
 */
function fromStudio(candidate) {
  const origin = config.appOrigin();
  if (!origin || !candidate) return false;
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

function governPermissions() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = (details && details.requestingUrl) || (contents && contents.getURL());
    callback(ALLOWED_PERMISSIONS.has(permission) && fromStudio(from));
  });
  /* The synchronous twin, used for permissions checked rather than requested.
     Both have to agree, or a page is told it may notify and then silently
     cannot — see fromStudio above for what that looks like. */
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const from = requestingOrigin || (details && details.requestingUrl);
    return ALLOWED_PERMISSIONS.has(permission) && fromStudio(from);
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => updates.checkManually(win) },
        { label: 'Update Source…', click: () => updates.promptForFeed(win) },
        { label: 'Studio Address…', click: () => promptForAddress() },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: isMac ? [{ role: 'close' }] : [
        { label: 'Check for Updates…', click: () => updates.checkManually(win) },
        { label: 'Update Source…', click: () => updates.promptForFeed(win) },
        { label: 'Studio Address…', click: () => promptForAddress() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        /* Kept, deliberately. This window has no address bar, so when something
           does not work the developer tools are the only way anybody can say
           what happened — and this is an internal tool, not a kiosk. */
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: () => updates.checkManually(win) },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* Changing which studio this window points at. Reachable from the menu as well
   as from the first-run screen, because the first-run screen is gone once it
   has been answered and a typo has to be fixable without a reinstall. */
async function promptForAddress() {
  if (!win) return;
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

// The first-run screen and the offline screen both hand their answer back here.
ipcMain.handle('zvky:set-app-url', (_event, raw) => {
  const url = config.setAppUrl(raw);
  if (!url) return { ok: false, error: 'That does not look like a web address.' };
  if (win) win.loadURL(url);
  return { ok: true, url };
});
ipcMain.handle('zvky:get-state', () => ({
  appUrl: config.appUrl(),
  version: app.getVersion(),
  platform: process.platform,
  update: updates.state(),
}));
ipcMain.handle('zvky:retry', () => {
  const url = config.appUrl();
  if (win && url) win.loadURL(url);
  return { ok: Boolean(url) };
});
ipcMain.handle('zvky:get-feed', () => ({
  feed: config.updateFeed(),
  saved: config.read().updateFeed || null,
  packaged: updates.hasPackagedFeed(),
}));
ipcMain.handle('zvky:set-feed', (_event, raw) => config.setUpdateFeed(raw));
ipcMain.handle('zvky:close-window', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  // Only ever the window that asked, never the main one.
  if (w && w !== win) w.close();
});
ipcMain.handle('zvky:check-updates', () => updates.checkManually(win));
ipcMain.handle('zvky:install-update', () => updates.downloadAndInstall(win));

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  governPermissions();
  buildMenu();
  createWindow();
  updates.wire(() => win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* Windows and Linux quit with the last window; macOS keeps the application
   running, which is what people there expect. */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* A remote page cannot be given more privilege than it came with. Belt and
   braces alongside the webPreferences above: if a future change ever loosened
   one of those by accident, this still refuses. */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

module.exports = { promptForAddress };
