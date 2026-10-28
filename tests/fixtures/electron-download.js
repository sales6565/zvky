#!/usr/bin/env electron
/* THE DESKTOP APP'S DOWNLOAD PATH, in a real Electron window.
 *
 * ===========================================================================
 * WHAT THIS IS FOR. Prompt 54 asked whether the Artist Report arrives intact
 * through the desktop app as well as through a browser. The honest answer
 * needed a measurement rather than an argument, so this script downloads the
 * file the way the shipped app does and writes it to disk for the test to hash.
 *
 * WHAT THE SHIPPED APP ACTUALLY DOES, which is why this script is so short:
 *
 *   - desktop/src/main.js opens ONE window on the studio's own URL with
 *     win.loadURL() and contextIsolation on, nodeIntegration off, sandbox on.
 *   - desktop/src/preload.js exposes window.zvky ONLY on the wrapper's own
 *     file: screens. The hosted page is given nothing, so there is NO native
 *     bridge for a download to travel over and no base64 hop to corrupt.
 *   - Nothing registers a will-download handler, so a download is Electron's
 *     default: Chromium fetches it and Electron offers a save dialog.
 *
 * So the download is Chromium's, and this script's only addition is a
 * will-download handler that sets a save path — a dialog cannot be answered in
 * a test. That is the one difference from production and it changes where the
 * bytes land, not what they are.
 *
 *   electron --no-sandbox tests/fixtures/electron-download.js <url> <outfile>
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

/* Electron puts its own switches and this script's path in argv before the two
   arguments that matter, and where exactly depends on how it was launched, so
   the url and the destination are taken as the last two non-flag arguments
   rather than by position. */
const [url, outFile] = process.argv.filter((a) => !a.startsWith('-')).slice(-2);
const fail = (why) => { process.stdout.write(`FAILED ${why}\n`); app.exit(1); };

if (!url || !outFile) fail('usage: electron-download.js <url> <outfile>');

app.whenReady().then(async () => {
  let settled = false;
  const done = (line, code) => {
    if (settled) return;
    settled = true;
    process.stdout.write(`${line}\n`);
    setTimeout(() => app.exit(code), 50);
  };

  session.defaultSession.on('will-download', (event, item) => {
    item.setSavePath(path.resolve(outFile));
    item.once('done', (e, state) => {
      if (state === 'completed') done(`SAVED ${item.getReceivedBytes()} ${item.getMimeType()} ${item.getFilename()}`, 0);
      else done(`FAILED download ${state}`, 1);
    });
  });

  /* The window the app makes, with the app's own webPreferences and the app's
     own preload — so the page runs in the same shape of renderer it does in
     production, bridge and all (which is to say: none). */
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', '..', 'desktop', 'src', 'preload.js'),
    },
  });

  /* EVERYTHING THE RENDERER SAYS COMES OUT HERE. When this script fails it has
     to say why: a test that reports "Electron timed out" and nothing else costs
     more time than it saves. */
  const noise = [];
  win.webContents.on('console-message', (e, level, message) => {
    noise.push(`console[${level}] ${message}`);
    if (noise.length > 40) noise.shift();
  });
  win.webContents.on('render-process-gone', (e, details) => fail(`render process gone: ${JSON.stringify(details)}`));
  win.webContents.on('did-fail-load', (e, code, description) => fail(`did-fail-load ${code} ${description}`));
  setTimeout(async () => {
    let state = 'unknown';
    try {
      state = await win.webContents.executeJavaScript(
        'JSON.stringify({ ready: window.__ready === true, rows: window.__rows, toast: window.__toast,'
        + ' url: location.href, body: document.body.innerHTML.slice(0, 300) })');
    } catch (err) { state = `could not ask the page: ${err.message}`; }
    fail(`timed out — page said ${state} — ${noise.join(' | ')}`);
  }, 120000);
  try {
    await win.loadURL(url);
    const ready = await win.webContents.executeJavaScript(
      'new Promise((res) => { const t = setInterval(() => { if (window.__ready) { clearInterval(t); res(true); } }, 25);'
      + ' setTimeout(() => res(false), 30000); })');
    if (!ready) return fail(`the page never became ready — ${noise.join(' | ')}`);
    const clicked = await win.webContents.executeJavaScript(
      "(() => { const b = document.getElementById('art_xlsx'); if (!b) return false; b.click(); return true; })()");
    if (!clicked) return fail(`no Download Excel button on the page — ${noise.join(' | ')}`);
  } catch (err) {
    return fail(String(err && err.message ? err.message : err));
  }
  return undefined;
});

app.on('window-all-closed', () => {});
