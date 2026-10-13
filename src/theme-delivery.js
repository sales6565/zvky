/* SERVING THE PAGE WITH THE TWO THINGS IT CANNOT WORK OUT FOR ITSELF: the
 * studio's colours, and which build it is.
 *
 * It is one module rather than two because it is one read of a one-megabyte
 * file and one memo over it. A second middleware rewriting the same HTML would
 * double both, and the two caches would then have to be invalidated in step.
 *
 * ---------------------------------------------------------------------------
 * THE BUILD STAMP, added on the fourth report of the Hold button — on which the
 * first question, "is the fix even deployed?", could not be answered from
 * anything on the screen. src/build-info.js explains how the stamp is derived;
 * what matters here is that it goes INTO THE HTML, so the page knows which page
 * IT is rather than which page the server would send now. A browser holding
 * yesterday's HTML then reports a stamp that disagrees with /api/version, and
 * the footer says so, instead of somebody describing behaviour from a build
 * nobody is looking at.
 *
 * ---------------------------------------------------------------------------
 * GETTING THE THEME TO THE BROWSER BEFORE THE FIRST PAINT.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HTML AND NOT A FETCH. The obvious shape — load the page, ask
 * /api/theme for JSON, set the custom properties — paints the application in
 * the colours it shipped with and then repaints it in the studio's. On a cold
 * connection that flash is a quarter of a second of the wrong brand on every
 * page view, and it is worst exactly where it matters most: the sign-in screen,
 * which is the first thing anybody outside the studio sees.
 *
 * A blocking <link rel=stylesheet> would also avoid the flash, and was the other
 * candidate. It costs a second round trip on every load, and the page's HTML is
 * already revalidated on every load (express.static sends max-age=0 with an
 * ETag), so it would be two conditional requests where one will do. Injecting a
 * <style> block into the HTML the server is already sending costs nothing.
 *
 * WHAT IS INJECTED is the output of theme.currentCss() — one `:root{}` block
 * built from validated values, after the generated defaults block that
 * public/index.html carries. Custom properties resolve at use, so the later
 * block wins for the tokens it sets and the defaults stand for the rest.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT MAKE THE PAGE WORSE. Three things could go wrong and each ends with
 * the shipped palette rather than with a broken page:
 *
 *   the mirror never loaded     theme.currentCss() returns the defaults
 *   the file could not be read  the request falls through to express.static,
 *                               which serves the page exactly as it did before
 *   the marker is missing       the page is served unchanged, which still
 *                               carries its own defaults block
 *
 * CACHED IN MEMORY, keyed on the theme version and the file's own mtime, because
 * the page is nearly a megabyte and rebuilding the string per request would be
 * the one expensive thing on a cheap screen. One entry; a save invalidates it by
 * moving the version.
 */
const fs = require('node:fs');
const path = require('node:path');
const theme = require('./theme');
const buildInfo = require('./build-info');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const MARKER = '<!-- THEME:INJECT';
const MARKER_END = '-->';
/* The build stamp's own marker. OPTIONAL, unlike the theme's: a page without it
   is served with the theme and no stamp, rather than falling through and losing
   the theme as well. */
const STAMP_MARKER = '<!-- BUILD:STAMP -->';

let memo = null;   // { key, html, version, stamp }

/* package.json's version is ours, not a request's — but it ends up inside an
   attribute, and a value that reaches an attribute gets escaped whatever its
   provenance. Four characters, which is every one that can end an attribute or
   open a tag. */
const escapeAttr = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* The page with the saved theme in it, or null when it cannot be built — in
   which case the caller must fall through to the static file. */
function render({ file = PAGE, now = null } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${theme.version()}|${stat.mtimeMs}|${stat.size}`;
  if (memo && memo.key === key && !now) return memo;
  const stamp = buildInfo.pageStamp();

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const at = src.indexOf(MARKER);
  if (at === -1) return null;
  const end = src.indexOf(MARKER_END, at);
  if (end === -1) return null;

  /* THE ONE PLACE A VALUE BECOMES CSS, and it is theme.currentCss() that builds
     it — from the catalogue, token by token, after canonical() has rewritten
     each value from its matched hex digits. Nothing of a user's input reaches
     this string. */
  const block = `<style id="themeSaved">${theme.currentCss()}</style>`;
  let html = src.slice(0, at) + block + src.slice(end + MARKER_END.length);

  /* THE STAMP THE PAGE WILL REPORT AS ITS OWN. A <meta>, not a script: nothing
     has to run for it to be readable, so it survives a JavaScript error early in
     the page — which is one of the states somebody would be reporting. The value
     is a twelve-hex-digit hash and a version string from package.json, neither
     of which can carry anything from a request. */
  if (html.includes(STAMP_MARKER)) {
    html = html.replace(STAMP_MARKER,
      `<meta name="zvky-build" content="${stamp}">`
      + `<meta name="zvky-version" content="${escapeAttr(buildInfo.version())}">`);
  }

  memo = { key, html, version: theme.version(), stamp };
  return memo;
}

// A save moves the version, so the next render misses; this is belt to braces.
const forget = () => { memo = null; };

/* The express handler. Mounted ahead of the static directory and the SPA
   catch-all, for '/' and '/index.html' and for every path the catch-all would
   have answered with the page anyway. */
function middleware(req, res, next) {
  const rendered = render();
  if (!rendered) return next();
  /* REVALIDATED, NOT CACHED. The page carries the theme now, so a cached copy
     would hold yesterday's colours; the ETag makes that one cheap 304 rather
     than a download. Same posture express.static had for this file, with the
     theme version folded into the tag. */
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  /* THE PAGE'S OWN HASH IS IN THE TAG. Without it a deploy that changes the HTML
     but not the theme keeps the old ETag — same byte length is unlikely but the
     length is all the tag had — and a browser holding the previous page is told
     304 and goes on running it. That is the stale-page failure this change
     exists to make visible, so the tag must not be the thing that causes it. */
  res.setHeader('ETag',
    `W/"page-${Buffer.byteLength(rendered.html)}-${rendered.version}-${rendered.stamp}"`);
  if (req.headers['if-none-match'] === res.getHeader('ETag')) return res.status(304).end();
  return res.send(rendered.html);
}

module.exports = { render, forget, middleware, MARKER, STAMP_MARKER, PAGE };
