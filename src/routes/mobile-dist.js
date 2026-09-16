/* Handing the two builds to the team.
 *
 * TWO ROUTERS, because two very different callers need two different gates.
 *
 *   api      — mounted at /api/mobile, authenticated, behind mobile.distribute.
 *              This is the admin's view: what is built, what the install link
 *              is, and what is wrong with the setup. It never serves a file.
 *
 *   publicRouter — mounted at /m/:token, NOT authenticated. The install page
 *              and the payloads. The reasoning for the missing sign-in is in
 *              src/mobile-dist.js and is not a shortcut: iOS fetches the
 *              manifest and the .ipa from a system daemon that has no session,
 *              so an authenticated path cannot work at all.
 */
const fs = require('node:fs');
const express = require('express');
const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const dist = require('../mobile-dist');
const branding = require('../branding');
const db = require('../db');

/* ------------------------------------------------------------------ admin */

const api = asyncRouter();
api.use(authenticate);

/* GET /api/mobile/builds — what exists, where it is, and what is misconfigured.
 *
 * Behind the permission because the response CONTAINS THE TOKEN. Everything
 * else here is harmless, but that one string is the link, and the link is the
 * credential. */
api.get('/builds', requirePermission('mobile.distribute'), (req, res) => {
  res.json(dist.status(req));
});

/* ----------------------------------------------------------------- public */

const publicRouter = express.Router({ mergeParams: true });

/* Every path below this line has already had its token checked.
 *
 * One middleware rather than a check per route, so a route added later cannot
 * be added without the gate. A wrong token gets a flat 404 and no hint that a
 * right one exists — telling a stranger "wrong token" tells them there is a
 * token to guess. */
publicRouter.use('/:token', (req, res, next) => {
  if (!dist.tokenMatches(req.params.token)) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  /* Never cached, never indexed. The URL is the secret, and a proxy that keeps
     a copy of the page keeps a copy of the secret in its path. */
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return next();
});

/* The files.
 *
 * `name` selects a KEY from a fixed table; it is never joined onto a path.
 * A name that is not in the table 404s before anything touches the disk. */
function sendBuild(name, res) {
  const spec = dist.FILES[name];
  if (!spec) return res.status(404).type('text/plain').send('Not found.');
  const info = dist.describeFile(name);
  if (!info) {
    return res.status(404).type('text/plain').send(`${spec.label} has not been uploaded to this server yet.`);
  }
  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Length', String(info.bytes));
  /* Android in particular needs a filename it can show in its installer, and
     an .ipa saved as "zvky.ipa" rather than as the route's last segment is
     what somebody expects to find in Downloads. The manifest is the one
     exception: iOS must READ it, not save it. */
  if (name !== 'manifest.plist') {
    res.setHeader('Content-Disposition', `attachment; filename="${spec.file}"`);
  }
  return fs.createReadStream(info.path).pipe(res);
}

/* TWO SPELLINGS OF THE SAME FILE, on purpose.
 *
 * The .plist names the .ipa by absolute URL and the install page names the
 * .plist the same way, and those URLs read far better — and are far easier to
 * pass to the manifest generator's --base — as `/m/TOKEN/zvky.ipa` than as
 * `/m/TOKEN/f/zvky.ipa`. Registering both means a manifest generated against
 * either spelling resolves, which matters because a manifest with a URL that
 * 404s fails at install time with a message that names neither. */
for (const name of Object.keys(dist.FILES)) {
  const handler = (req, res) => sendBuild(name, res);
  publicRouter.get(`/:token/${name}`, handler);
  publicRouter.get(`/:token/f/${name}`, handler);
}

/* GET /m/:token/ — the page a person opens on their phone. */
publicRouter.get('/:token/', async (req, res) => {
  if (!branding.isLoaded()) await branding.load(db).catch(() => {});
  res.type('text/html').send(installPage(dist.status(req), branding.current()));
});
/* `/m/<token>` with no trailing slash is served by the route above: Express
   routing is non-strict, so `/:token/` matches both spellings. Verified. */

/* NOTHING UNDER /m FALLS THROUGH. Last route in the router, matching every
 * method and every remaining path.
 *
 * Without this, an unmatched path here is answered by the SPA catch-all at the
 * bottom of server.js — which returns index.html with a 200 for any GET it
 * does not recognise. That is a wrong answer everywhere and a silently
 * destructive one here: iOS's installer daemon asking for a manifest it cannot
 * find would be handed a page of HTML and a success status, and would fail
 * with a message that names neither the file nor the reason. A 404 is the
 * answer, including for a mistyped filename under a CORRECT token.
 *
 * Tested for: /m/<valid token>/.dist-token used to return the application's
 * front page. */
publicRouter.use((req, res) => {
  res.status(404).type('text/plain').send('Not found.');
});

/* The page itself.
 *
 * Plain HTML in a template string, deliberately. It is opened by somebody who
 * is NOT signed in, on a phone, possibly on a slow connection, and it must
 * work when the application's own frontend does not — so it shares nothing
 * with it: no script, no fetch, no fonts, no dependency on the SPA booting.
 * Two links and the instructions around them.
 */
function installPage(s, brand) {
  const name = esc(brand && brand.name ? brand.name : 'Zvky');
  const dir = `/m/${s.token}`;
  const android = s.android;
  const ios = s.ios;
  const iosLink = s.iosInstallLink;

  const androidCard = android
    ? `<a class="btn" href="${dir}/zvky.apk">Download the Android app</a>
       <p class="meta">${esc(android.size)} &middot; built ${esc(shortDate(android.updatedAt))}</p>
       <p class="hash">SHA-256 &middot; <code>${esc(android.sha256 || '')}</code></p>
       <details>
         <summary>Android blocked the install &mdash; "Install unknown apps"</summary>
         <p>Android refuses apps that did not come from the Play Store until you allow the app you
            are installing <em>from</em>. It only has to be done once.</p>
         <ol>
           <li>Tap the download above. When the browser warns you the file may be harmful, choose
               <strong>Download anyway</strong>.</li>
           <li>Open the downloaded <code>zvky.apk</code> &mdash; from the notification, or from
               <strong>Files &rarr; Downloads</strong>.</li>
           <li>Android will say your browser is not allowed to install apps. Tap
               <strong>Settings</strong> on that message.</li>
           <li>Turn on <strong>Allow from this source</strong> (older phones call it
               <strong>Install unknown apps</strong>), then press Back.</li>
           <li>Tap <strong>Install</strong>. If Play Protect asks, choose
               <strong>Install anyway</strong> &mdash; it says that about every app that did not come
               from the Play Store, including this one.</li>
         </ol>
         <p class="meta">If you would rather reach the setting yourself: <strong>Settings &rarr; Apps
            &rarr; Special app access &rarr; Install unknown apps</strong>, then pick your browser.</p>
       </details>
`
    : `<p class="pending">The Android build has not been uploaded to this server yet.</p>`;

  const iosCard = iosLink
    ? `<a class="btn" href="${esc(iosLink)}">Install the iOS app</a>
       <p class="meta">${ios ? `${esc(ios.size)} &middot; built ${esc(shortDate(ios.updatedAt))}` : 'Manifest present'}</p>
       <details>
         <summary>What to expect, and what can go wrong</summary>
         <ol>
           <li>Open this page in <strong>Safari</strong>. Chrome and in-app browsers on iOS cannot
               start an install.</li>
           <li>Tap Install. iOS asks &ldquo;<em>${name} would like to install…</em>&rdquo; &mdash; tap
               <strong>Install</strong>. The icon appears on your home screen, greyed out while it
               downloads.</li>
           <li>The first time you open it, iOS says the developer is not trusted. Go to
               <strong>Settings &rarr; General &rarr; VPN &amp; Device Management</strong>, tap the
               studio's profile and tap <strong>Trust</strong>.</li>
         </ol>
         <p><strong>&ldquo;Unable to install&rdquo;</strong> almost always means your device has not been
            added to the build. Send your UDID to whoever manages the apps and they will include you in
            the next one &mdash; iOS builds outside the App Store only run on devices named in the build
            itself.</p>
       </details>`
    : `<p class="pending">The iOS build has not been uploaded to this server yet.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Install ${name}</title>
<style>
  :root { color-scheme: dark; --brand: #7f1416; --bg: #12121a; --card: #1c1c26; --line: #2e2e3c; --ink: #f2f2f7; --dim: #9a9aae; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 56px; background: var(--bg); color: var(--ink);
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--dim); margin: 0 0 28px; font-size: 14px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  .card h2 { font-size: 16px; margin: 0 0 14px; letter-spacing: .02em; text-transform: uppercase; color: var(--dim); }
  .btn { display: block; text-align: center; background: var(--brand); color: #fff; text-decoration: none;
         padding: 14px 18px; border-radius: 10px; font-weight: 600; }
  .btn:active { filter: brightness(1.15); }
  .meta { color: var(--dim); font-size: 13px; margin: 10px 0 0; text-align: center; }
  .pending { color: var(--dim); margin: 0; font-size: 14px; }
  details { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 14px; }
  summary { cursor: pointer; font-size: 14px; color: var(--ink); }
  details ol { padding-left: 20px; font-size: 14px; }
  details li { margin-bottom: 8px; }
  details p { font-size: 14px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .hash { color: var(--dim); font-size: 11px; margin: 8px 0 0; text-align: center; }
  .note { font-size: 13px; color: var(--dim); border-left: 2px solid var(--line); padding-left: 12px; margin-top: 28px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Install ${name}</h1>
  <p class="sub">Internal builds for the studio. Not on the App Store or Google Play.</p>

  <div class="card"><h2>Android</h2>${androidCard}</div>
  <div class="card"><h2>iPhone &amp; iPad</h2>${iosCard}</div>

  <p class="note">Both apps open the same ${name} you use in a browser, so you sign in with your
     usual account and everything is already there. Keep this link inside the studio &mdash; it is
     what lets a phone download the builds.</p>
</div>
</body>
</html>`;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

module.exports = { api, publicRouter, installPage };
