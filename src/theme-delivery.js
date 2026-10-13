/* GETTING THE THEME TO THE BROWSER BEFORE THE FIRST PAINT.
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

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const MARKER = '<!-- THEME:INJECT';
const MARKER_END = '-->';

let memo = null;   // { key, html }

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
  const html = src.slice(0, at) + block + src.slice(end + MARKER_END.length);
  memo = { key, html, version: theme.version() };
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
  res.setHeader('ETag', `W/"page-${Buffer.byteLength(rendered.html)}-${rendered.version}"`);
  if (req.headers['if-none-match'] === res.getHeader('ETag')) return res.status(304).end();
  return res.send(rendered.html);
}

module.exports = { render, forget, middleware, MARKER, PAGE };
