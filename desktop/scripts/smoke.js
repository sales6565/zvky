#!/usr/bin/env electron
/* The checks that need a real window.
 *
 * scripts/check.js reads the source. This one RUNS the application: it starts
 * the real main.js — not a copy of it, not a mock — waits for the window it
 * makes, and then asks that window questions from outside. So what it proves is
 * behaviour rather than the presence of a line of code.
 *
 * It answers the four things that are only true or false once something is on a
 * screen:
 *
 *   Does the studio's page actually load in this window?
 *   Does the page get its notification permission, and only that one?
 *   Is the wrapper invisible to the page — no window.zvky, no injected DOM?
 *   Do the first-run and offline screens work when there is nothing to load?
 *
 * It writes a PNG per screen so a person can see them rather than take this
 * script's word for it.
 *
 *   ZVKY_APP_URL=http://127.0.0.1:4415 npm run smoke
 *
 * With no ZVKY_APP_URL it runs the screens that do not need a studio, and says
 * which checks it skipped rather than reporting a smaller pass.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/* --no-sandbox is passed on the command line by the npm script, not here:
   Electron checks for it before any of this file runs. It disables the CHROMIUM
   PROCESS sandbox, which a container running as root cannot start — and which
   is a different thing from the webPreferences sandbox the app puts around the
   remote page. That one is untouched, and is asserted below. */

const OUT = process.env.SMOKE_OUT || path.join(__dirname, '..', 'dist-smoke');
const TARGET = process.env.ZVKY_APP_URL || '';

let failures = 0;
let skipped = 0;
const log = (s) => process.stdout.write(s + '\n');

function ok(label, condition, detail) {
  if (condition) log(`  ✓ ${label}`);
  else { failures += 1; log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const skip = (label, why) => { skipped += 1; log(`  – ${label} (${why})`); };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const image = await win.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}

// Wait for whatever the window is loading to settle, however it got there.
function settled(win, ms = 15000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, ms);
    if (!win.webContents.isLoading()) return done();
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', () => setTimeout(done, 400));
  });
}

async function run() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { log('No window was created.'); return 1; }
  await settled(win);
  await wait(600);

  log('\nThe window');
  ok('one window exists', BrowserWindow.getAllWindows().length === 1);
  ok('titled ZVKY FORGE', win.getTitle().includes('ZVKY FORGE') || win.webContents.getURL().startsWith('http'),
    `title was "${win.getTitle()}"`);
  const prefs = win.webContents.getLastWebPreferences() || {};
  ok('the page runs sandboxed', prefs.sandbox === true);
  ok('with context isolation', prefs.contextIsolation === true);
  ok('and no Node', prefs.nodeIntegration !== true);

  if (!TARGET) {
    log('\nFirst run, with no studio address set');
    const url = win.webContents.getURL();
    ok('the first-run screen is shown, not a blank window', /setup\.html$/.test(url), url);
    const seen = await win.webContents.executeJavaScript(`
      ({ heading: document.querySelector('h1').textContent,
         hasField: Boolean(document.getElementById('addr')),
         bridge: typeof window.zvky })
    `);
    ok('it asks for the studio address', seen.hasField && /studio/i.test(seen.heading), JSON.stringify(seen));
    ok('the bridge is available to it', seen.bridge === 'object');
    log(`  → ${await shoot(win, 'setup')}`);

    log('\nA bad address');
    const bad = await win.webContents.executeJavaScript(`window.zvky.setAppUrl('not a url')`);
    ok('is refused with a sentence, not a crash', bad.ok === false && typeof bad.error === 'string', JSON.stringify(bad));

    log('\nAn unreachable address');
    /* A port with nothing behind it: nothing listens there, so this is the offline path
       taken for real rather than by calling the handler directly. */
    await win.webContents.executeJavaScript(`window.zvky.setAppUrl('http://127.0.0.1:45999')`);
    await settled(win);
    await wait(800);
    const offline = win.webContents.getURL();
    ok('lands on the offline screen', /offline\.html/.test(offline), offline);
    const told = await win.webContents.executeJavaScript(`
      ({ heading: document.querySelector('h1').textContent,
         advice: document.getElementById('lede').textContent,
         detail: document.getElementById('detail').textContent })
    `);
    ok('which names a cause rather than a code alone', told.advice.length > 40, JSON.stringify(told));
    ok('and keeps the code for whoever is asked', /\d/.test(told.detail), told.detail);
    log(`  → ${await shoot(win, 'offline')}`);

    skip('the studio page loads', 'no ZVKY_APP_URL');
    skip('notifications are granted to it', 'no ZVKY_APP_URL');
    skip('the wrapper is invisible to it', 'no ZVKY_APP_URL');
    return failures ? 1 : 0;
  }

  log('\nThe studio page');
  const url = win.webContents.getURL();
  ok('loaded from the address given', url.startsWith(TARGET.replace(/\/$/, '')), url);
  const page = await win.webContents.executeJavaScript(`
    ({ title: document.title,
       body: document.body ? document.body.innerText.slice(0, 400) : '',
       bridge: typeof window.zvky,
       injected: document.querySelectorAll('[data-zvky-desktop]').length,
       ipc: typeof window.require + '/' + typeof window.process + '/' + typeof window.module })
  `);
  ok('the application rendered', page.body.length > 0, JSON.stringify(page).slice(0, 200));

  log('\nThe wrapper is invisible to the application');
  /* The standing boundary, checked from inside the page: the web application
     must work here without knowing it is here, and must not be able to depend
     on anything this wrapper provides. */
  ok('window.zvky is not defined on the studio page', page.bridge === 'undefined');
  ok('nothing is injected into its DOM while there is no update', page.injected === 0);
  ok('the page has no Node globals', page.ipc === 'undefined/undefined/undefined', page.ipc);

  log('\nNotifications');
  const notif = await win.webContents.executeJavaScript(`
    (async () => ({
      supported: typeof Notification,
      permission: Notification.permission,
      requested: await Notification.requestPermission(),
    }))()
  `);
  /* This is the check the whole feature rests on. In a browser this is where a
     person is asked; here it must already be granted, because the studio asked
     that the desktop app not put a prompt in front of anybody. */
  ok('the Notification API is present', notif.supported === 'function');
  ok('permission is granted without prompting', notif.permission === 'granted', JSON.stringify(notif));
  ok('and asking again still grants', notif.requested === 'granted', JSON.stringify(notif));

  /* Raise one for real. It reaches the OS notification centre, which does not
     exist under Xvfb — so what is proved here is that the call is permitted and
     does not throw, which is the part this wrapper is responsible for. */
  const raised = await win.webContents.executeJavaScript(`
    (() => { try { new Notification('ZVKY FORGE', { body: 'Smoke test' }); return 'ok'; }
             catch (e) { return String(e); } })()
  `);
  ok('a notification can be raised from the page', raised === 'ok', raised);

  log('\nEverything else is refused');
  const denied = await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      for (const name of ['geolocation', 'camera', 'microphone']) {
        try { out[name] = (await navigator.permissions.query({ name })).state; }
        catch (e) { out[name] = 'unqueryable'; }
      }
      return out;
    })()
  `);
  ok('the camera is not granted', denied.camera !== 'granted', JSON.stringify(denied));
  ok('the microphone is not granted', denied.microphone !== 'granted', JSON.stringify(denied));
  ok('location is not granted', denied.geolocation !== 'granted', JSON.stringify(denied));

  log(`  → ${await shoot(win, 'studio')}`);

  log('\nThe update bar');
  /* Pushed through the same channel the updater uses, so what is drawn is what
     a real update would draw. */
  win.webContents.send('zvky:update-state', { status: 'available', version: '1.1.0', percent: 0 });
  await wait(500);
  const bar = await win.webContents.executeJavaScript(`
    ({ hosts: document.querySelectorAll('[data-zvky-desktop]').length,
       reachable: (() => { const h = document.querySelector('[data-zvky-desktop]');
                           return h ? String(h.shadowRoot) : 'none'; })(),
       position: (() => { const h = document.querySelector('[data-zvky-desktop]');
                          return h ? getComputedStyle(h).position : 'none'; })() })
  `);
  ok('appears when an update is available', bar.hosts === 1, JSON.stringify(bar));
  ok('its contents are closed to the page', bar.reachable === 'null', bar.reachable);
  ok('it is out of the page\'s layout flow', bar.position === 'fixed', bar.position);
  log(`  → ${await shoot(win, 'update-bar')}`);

  win.webContents.send('zvky:update-state', { status: 'idle', version: null, percent: 0 });
  await wait(400);
  const gone = await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-zvky-desktop]').length`);
  ok('and removes itself when there is not', gone === 0, String(gone));

  return failures ? 1 : 0;
}

/* The real application, started exactly as the packaged app starts it. */
require('../src/main.js');

app.whenReady().then(async () => {
  await wait(1200);
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    log(`\nThe smoke test itself failed: ${err && err.stack ? err.stack : err}`);
    code = 1;
  }
  log(failures ? `\n${failures} FAILED.` : `\nAll checks passed.${skipped ? ` ${skipped} skipped.` : ''}`);
  app.exit(code);
});
