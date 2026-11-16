/* THE ICON IN THE BROWSER TAB, served to anybody who asks.
 *
 * ===========================================================================
 * WHY THIS IS NOT UNDER /api, which everything else in this application is.
 *
 * It is not an API call. It is an image URL that appears in the page's <head>,
 * which means the browser fetches it on its own initiative — before sign-in, on
 * the sign-in screen itself, from a bookmark, from a pinned tab, and sometimes
 * from the operating system rather than from the page. Everything under /api
 * carries the activity logger and the API's CORS rules, and neither has
 * anything to say about a 300-byte image being painted into a tab.
 *
 * The brief names this path, and it is the right one for what it is.
 *
 * ===========================================================================
 * IT IS DELIBERATELY UNAUTHENTICATED, for the same reason /api/branding and
 * /api/branding/logo already are: the sign-in screen wears the studio's
 * identity, and that screen by definition has no token yet. Nothing here is a
 * secret — it is the picture every visitor sees in their tab.
 *
 * ===========================================================================
 * IT READS NOTHING FROM THE REQUEST BUT ONE QUERY VALUE, AND THAT ONLY TO
 * DECIDE HOW LONG TO CACHE.
 *
 * There is one row to serve, found by a constant key. No path parameter, no
 * filename, no directory: there is nothing in the request that could name a
 * different thing to return, which is the property that makes a public asset
 * route safe to leave open. `?v=` is compared against the digest and then
 * forgotten; it never reaches the database, the filesystem or the response.
 *
 * ===========================================================================
 * CACHING, AND WHY TWO ANSWERS.
 *
 * The page asks for /branding/favicon?v=<first twelve of the sha256>. When the
 * version asked for is the version held, the bytes behind that URL can never
 * change — a different icon is a different digest and therefore a different URL
 * — so it is served `immutable` for a year. That is what makes a tab icon
 * appear instantly on the second page load forever after.
 *
 * A request with no version, or with a stale one, gets five minutes and a
 * revalidation instead. Those are the requests from a browser guessing at the
 * URL, from a cached page served before the icon changed, or from somebody
 * typing it — none of which should be told to hold the answer for a year.
 *
 * The ETag is the full digest either way, so a conditional request is answered
 * 304 without reading the blob out of the row a second time.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const favicon = require('../favicon');

const YEAR = 31536000;

router.get('/favicon', async (req, res) => {
  const icon = await favicon.read(db).catch(() => null);

  /* NO ROW MEANS NO ICON, and this application has never shipped a default one:
     public/ holds no favicon.ico, and the page's head carries no icon link
     today. So the honest answer is 404 and the page leaves its head alone,
     exactly as the brief says to when there is nothing to fall back to. */
  if (!icon) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No icon has been uploaded.' });
  }

  const etag = `"${icon.sha256}"`;
  res.setHeader('ETag', etag);
  /* NOSNIFF, because this is the one route in the application that hands a
     visitor bytes they uploaded. The type is one of four validated image types
     and the bytes were checked against their own header, so a browser has no
     reason to guess — and must not be allowed to, because a browser that
     decides for itself that something is HTML will run it. */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', icon.mime);

  const asked = String(req.query.v || '');
  res.setHeader('Cache-Control', asked && asked === icon.version
    ? `public, max-age=${YEAR}, immutable`
    : 'public, max-age=300, must-revalidate');

  /* A conditional request, answered without sending the image again. The header
     can carry several tags and a `*`, so it is split rather than compared whole
     — a browser sending `"abc", "def"` would otherwise be told nothing matched
     and handed the bytes it already has. */
  const inbound = String(req.headers['if-none-match'] || '');
  if (inbound) {
    const tags = inbound.split(',').map((t) => t.trim());
    if (tags.includes('*') || tags.includes(etag) || tags.includes(`W/${etag}`)) {
      return res.status(304).end();
    }
  }

  return res.send(icon.buffer);
});

module.exports = router;
