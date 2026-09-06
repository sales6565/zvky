/* The bridge, and the update bar.
 *
 * This file is the ONLY thing that runs inside the page, and it does two
 * separate jobs that happen to share a file because Electron gives a window one
 * preload:
 *
 *   1. It exposes a small, named API to the two local screens this wrapper owns
 *      (the first-run address screen and the offline screen). Those are our own
 *      HTML, and they need to talk to the main process.
 *
 *   2. It draws the "Update available" bar over the studio's hosted
 *      application.
 *
 * JOB 2 IS THE DELICATE ONE, because that page is the live web application and
 * the standing instruction is that this wrapper must not change it. So the bar
 * is built to be incapable of affecting it:
 *
 *   - It lives in a CLOSED SHADOW ROOT on an element appended to <html>, not
 *     <body>. Nothing in the application's stylesheet can reach inside a shadow
 *     root, and nothing inside it leaks out. `all: initial` on the host means it
 *     does not even inherit a font.
 *   - It is `position: fixed` and inserted last, so it never moves the
 *     application's own layout by a pixel.
 *   - It appears only when there is an update, and removes itself when there is
 *     not. Most days it does not exist in the DOM at all.
 *   - It never touches the page's globals. The API below is exposed only on
 *     pages this wrapper owns; the studio's application is given nothing.
 *
 * That last point is worth being explicit about. `window.zvky` is NOT defined on
 * the remote page. The web application cannot detect this wrapper through it,
 * cannot call it, and — the reason it matters — does not need any change to work
 * inside it.
 */
const { contextBridge, ipcRenderer } = require('electron');

const isLocalScreen = location.protocol === 'file:';

/* ---- Job 1: the API, for our own screens only ---------------------------- */
if (isLocalScreen) {
  contextBridge.exposeInMainWorld('zvky', {
    getState: () => ipcRenderer.invoke('zvky:get-state'),
    setAppUrl: (url) => ipcRenderer.invoke('zvky:set-app-url', url),
    retry: () => ipcRenderer.invoke('zvky:retry'),
    checkUpdates: () => ipcRenderer.invoke('zvky:check-updates'),
    installUpdate: () => ipcRenderer.invoke('zvky:install-update'),
    // Where updates are fetched from — a setting, so a build with no baked-in
    // address is not stuck without one for ever.
    getFeed: () => ipcRenderer.invoke('zvky:get-feed'),
    setFeed: (url) => ipcRenderer.invoke('zvky:set-feed', url),
    closeWindow: () => ipcRenderer.invoke('zvky:close-window'),
  });
}

/* ---- Job 2: the update bar, over the hosted application ------------------ */

const BRAND = '#7f1416';
let host = null;
let root = null;
let parts = null;

function build() {
  if (host) return;
  host = document.createElement('div');
  host.setAttribute('data-zvky-desktop', 'update');
  /* `all: initial` resets every inherited property, so the application's own
     styles — however aggressive — cannot reach this. The rest positions it. */
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'top: 0', 'left: 0', 'right: 0',
    'z-index: 2147483647',
    'display: block',
  ].join(';');

  /* Closed, so the page cannot reach in and read or change it either. */
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        font: 500 13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
        color: #fff;
        background: ${BRAND};
        box-shadow: 0 1px 6px rgba(0,0,0,.35);
        padding: 9px 14px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .msg { flex: 1; }
      .msg b { font-weight: 700; }
      button {
        font: 600 12px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
        color: ${BRAND};
        background: #fff;
        border: 0;
        border-radius: 4px;
        padding: 7px 12px;
        cursor: pointer;
      }
      button:hover { background: #f2e9e9; }
      button[disabled] { opacity: .55; cursor: default; }
      button.ghost {
        background: transparent; color: #fff;
        border: 1px solid rgba(255,255,255,.55);
      }
      button.ghost:hover { background: rgba(255,255,255,.12); }
      .track {
        width: 120px; height: 5px; border-radius: 3px;
        background: rgba(255,255,255,.28); overflow: hidden;
      }
      .fill { height: 100%; width: 0; background: #fff; transition: width .2s; }
      [hidden] { display: none !important; }
    </style>
    <div class="bar">
      <span class="msg"></span>
      <div class="track" hidden><div class="fill"></div></div>
      <button class="go"></button>
      <button class="ghost dismiss" title="Hide this until the next launch">Later</button>
    </div>
  `;
  parts = {
    msg: root.querySelector('.msg'),
    track: root.querySelector('.track'),
    fill: root.querySelector('.fill'),
    go: root.querySelector('.go'),
    dismiss: root.querySelector('.dismiss'),
  };
  parts.go.addEventListener('click', () => {
    parts.go.disabled = true;
    ipcRenderer.invoke('zvky:install-update');
  });
  /* Hiding the bar is safe: the update is already downloading and will apply
     on the next close whether this is on screen or not. */
  parts.dismiss.addEventListener('click', () => remove());

  /* documentElement, not body: the application owns <body>, and appending to
     something it re-renders would mean the bar disappearing at random. */
  (document.documentElement || document.body).appendChild(host);
}

function remove() {
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null; root = null; parts = null;
}

/* Which states are worth interrupting somebody for. "checking" and "idle" are
   not — a bar that says "checking for updates" on every launch is noise, and
   the studio asked for a visible indicator of an update, not of the search for
   one. An error is only shown if somebody asked for the check, which is the
   dialog in updates.js, not this. */
function paint(state) {
  const s = (state && state.status) || 'idle';
  if (s !== 'available' && s !== 'downloading' && s !== 'ready') {
    remove();
    return;
  }
  build();
  const version = state.version ? `Version ${state.version}` : 'A new version';

  /* A NOTICE, not a prompt. Updates download and install by themselves now, so
     none of these states is waiting on the person reading them — the wording
     says what will happen rather than asking whether it should. The button is
     an accelerator for somebody who wants it sooner; dismissing it, or ignoring
     it entirely, changes nothing about the outcome. */
  if (s === 'available') {
    parts.msg.innerHTML = `<b>${version}</b> of ZVKY FORGE is downloading.`;
    parts.track.hidden = true;
    parts.go.textContent = 'Restart Now';
    parts.go.disabled = false;
    parts.dismiss.hidden = false;
  } else if (s === 'downloading') {
    parts.msg.innerHTML = `Downloading <b>${version}</b>… it installs when you close the app.`;
    parts.track.hidden = false;
    parts.fill.style.width = `${Math.max(2, state.percent || 0)}%`;
    parts.go.textContent = 'Restart Now';
    parts.go.disabled = false;
    parts.dismiss.hidden = false;
  } else {
    parts.msg.innerHTML = `<b>${version}</b> is ready — it installs when you close ZVKY FORGE.`;
    parts.track.hidden = true;
    parts.go.textContent = 'Restart Now';
    parts.go.disabled = false;
    parts.dismiss.hidden = false;
  }
}

if (!isLocalScreen) {
  ipcRenderer.on('zvky:update-state', (_event, state) => {
    /* The page may still be parsing when the launch check finishes. */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => paint(state), { once: true });
    } else {
      paint(state);
    }
  });

  /* A reload throws the bar away with the rest of the DOM, so ask for the
     current state again rather than losing it until the next check. */
  window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.invoke('zvky:get-state')
      .then((s) => paint(s && s.update))
      .catch(() => {});
  });
}
