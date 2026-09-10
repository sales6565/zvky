// Validating the link on a review submission.
//
// Deliberately permissive about *where* the link points and strict about
// whether it is a pointer at all. The studio submits work from wherever it
// lives: a review tool on the public internet, a render farm on the office LAN,
// a NAS reachable only by hostname, a share mapped on somebody's desktop.
// Refusing http://nas/shots/ep01 because "nas" has no dot in it would reject
// the most common case in the building — and refusing \\fileserver\assets\ep01
// would reject the second most common.
//
// FIVE SHAPES ARE ACCEPTED, and the one that matters to the rest of the app is
// which of them it turned out to be:
//
//   web       http:// and https://          the browser can open it
//   scheme    ftp/ftps/sftp/smb/file://     a real URL, but not one a browser
//                                           will usefully follow from a page
//   unc       \\server\share\folder         a Windows network path
//             //server/share/folder         the same thing written with slashes
//   windows   C:\Projects\ProjectX          a path on somebody's machine
//   posix     /mnt/shared/assets            likewise
//
// WHY THE KIND IS RETURNED AND NOT JUST A BOOLEAN. Only `web` can be rendered
// as a hyperlink. A UNC path or a local folder is a REFERENCE that a colleague
// with access to that machine acts on by hand; this application is served over
// the web and cannot read, fetch, preview or thumbnail any of them. Drawing
// them as <a href> would give every viewer a link that silently does nothing —
// worse than plain text, because it looks like it should work. So the caller is
// told which kind it has and the screen decides how to draw it. See `clickable`.
//
// STORED EXACTLY AS TYPED. An earlier version returned `new URL(text).toString()`,
// which is fine for a URL and meaningless for a path — there is no normal form
// for \\fileserver\assets that is still a path somebody can paste into Explorer.
// Rather than normalise one kind and not the other, nothing is normalised: what
// was typed is what is stored and what is shown.

/* Schemes a link may use, when it has one at all. Anything else is far more
   likely to be a mistake — or a javascript: payload aimed at whoever clicks it
   in the review screen — than a genuine submission. */
const SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'sftp:', 'smb:', 'file:']);

/* The two that a browser will actually open from a page. Everything else is a
   reference for a human, and the UI is told so. */
const WEB_SCHEMES = new Set(['http:', 'https:']);

const MAX_LENGTH = 2048; // the column width, checked here so the error is readable

/* Control characters have no business in a path or a URL, and a newline in the
   middle of one usually means a spreadsheet cell brought its neighbour along.
   Checked before anything else so the error names the real problem. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/* A machine name in a UNC path: a hostname or an IPv4 address, no separators.
   Deliberately not a strict hostname grammar — studios name servers things a
   grammar would reject — but it does have to be one segment of ordinary
   characters rather than, say, a sentence. */
const UNC_HOST = /^[A-Za-z0-9._$~-]+$/;

/* Windows drive path: a letter, a colon, and a separator. The separator is
   required, because "C:Projects" is a path relative to the current directory on
   drive C — meaningless to anybody but the machine that typed it. */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

const EXAMPLE = 'https://drive.example.com/shot-01, \\\\fileserver\\assets\\ep01 or /mnt/shared/assets';

/* What shape is this, if any?
 *
 * Ordered most specific first: a UNC path starts with two separators, which a
 * POSIX path must not be mistaken for, and a drive letter would otherwise parse
 * as a one-character URL scheme ("c:"). Returns null when it is none of them. */
function classify(text) {
  // \\server\share and //server/share — the same path in two notations.
  if (/^[\\/]{2}[^\\/]/.test(text)) {
    const host = text.slice(2).split(/[\\/]/)[0];
    return UNC_HOST.test(host) ? 'unc' : null;
  }
  if (WINDOWS_PATH.test(text)) return 'windows';
  // An absolute POSIX path, with at least one segment: "/" alone points nowhere.
  if (/^\/[^\\/]/.test(text)) return 'posix';
  return null;
}

/* `optional` is for the reference link on an asset — the brief rather than the
 * submission. Everything about what counts as a valid link is identical; the
 * only difference is that leaving it out is allowed, and clearing it is how you
 * remove it. Two validators would have drifted the moment one gained a scheme.
 *
 * Returns { ok, link, kind, clickable } on success. `link` is the text exactly
 * as typed, trimmed of surrounding whitespace and nothing else.
 */
function validate(raw, { optional = false } = {}) {
  const text = String(raw ?? '').trim();

  if (!text) {
    if (optional) return { ok: true, link: null, kind: null, clickable: false };
    return { ok: false, error: 'A link to the work is required.' };
  }
  if (text.length > MAX_LENGTH) {
    return { ok: false, error: `That link is longer than ${MAX_LENGTH} characters.` };
  }
  if (CONTROL.test(text)) {
    return { ok: false, error: 'That link contains a line break or a control character.' };
  }

  /* A path is checked BEFORE the URL parser is given a chance at it, because
     the parser has opinions about both: "C:\Projects" parses happily as a URL
     with the scheme "c:", and "\\fileserver\assets" does not parse at all. */
  const pathKind = classify(text);
  if (pathKind) return { ok: true, link: text, kind: pathKind, clickable: false };

  let url;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      error: `That is not a valid link or path. Use a web address, a network path or a folder path — for example ${EXAMPLE}.`,
    };
  }

  if (!SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      error: `"${url.protocol.replace(':', '')}" is not an accepted kind of link. `
        + `Use http, https, ftp, smb or file — or a network or folder path such as \\\\fileserver\\assets\\ep01.`,
    };
  }

  // file: URLs have no host by design; everything else needs one, or the link
  // points nowhere.
  if (url.protocol !== 'file:' && !url.hostname) {
    return { ok: false, error: 'That link has no server in it.' };
  }
  if (url.protocol === 'file:' && (!url.pathname || url.pathname === '/')) {
    return { ok: false, error: 'That file link has no path in it.' };
  }

  const web = WEB_SCHEMES.has(url.protocol);
  /* `text`, not `url.toString()`. See the note at the top: what was typed is
     what is stored, so a link never comes back subtly different from the one
     somebody pasted in. */
  return { ok: true, link: text, kind: web ? 'web' : 'scheme', clickable: web };
}

/* Whether a stored link may be drawn as a hyperlink.
 *
 * The read side needs this on links that were validated on some earlier day,
 * and re-running validate() to ask one question would couple every rendering
 * path to the whole rule set. It answers conservatively: anything this cannot
 * confirm is http or https is drawn as text, which fails in the harmless
 * direction. */
function isWebLink(raw) {
  const text = String(raw ?? '').trim();
  if (!text || CONTROL.test(text)) return false;
  if (classify(text)) return false;      // a path is never a hyperlink
  try {
    return WEB_SCHEMES.has(new URL(text).protocol);
  } catch {
    return false;
  }
}

module.exports = { validate, isWebLink, classify, SCHEMES, WEB_SCHEMES, MAX_LENGTH };
