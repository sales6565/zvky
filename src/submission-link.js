// Validating the link on a review submission.
//
// Deliberately permissive about *where* the link points and strict about
// whether it is a link at all. The studio submits work from wherever it lives:
// a review tool on the public internet, a render farm on the office LAN, a NAS
// reachable only by hostname. Refusing http://nas/shots/ep01 because "nas" has
// no dot in it would reject the most common case in the building.
//
// So: it must parse as a URL and carry a host or a path. It does not have to be
// public, resolvable, or reachable from here.

// Schemes a link may use. Anything else is far more likely to be a mistake — or
// a javascript: payload aimed at whoever clicks it in the review screen — than
// a genuine submission.
const SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'sftp:', 'smb:', 'file:']);

const MAX_LENGTH = 2048; // the column width, checked here so the error is readable

// `optional` is for the reference link on an asset — the brief rather than the
// submission. Everything about what counts as a valid link is identical; the
// only difference is that leaving it out is allowed, and clearing it is how you
// remove it. Two validators would have drifted the moment one gained a scheme.
function validate(raw, { optional = false } = {}) {
  const text = String(raw ?? '').trim();

  if (!text) {
    if (optional) return { ok: true, link: null };
    return { ok: false, error: 'A link to the work is required.' };
  }
  if (text.length > MAX_LENGTH) {
    return { ok: false, error: `That link is longer than ${MAX_LENGTH} characters.` };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      error: 'That is not a valid link. Include the protocol, for example https://drive.example.com/shot-01 or http://nas/shots/ep01.',
    };
  }

  if (!SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      error: `Links must start with ${[...SCHEMES].map((p) => p.replace(':', '')).slice(0, 3).join(', ')} or a similar protocol — "${url.protocol.replace(':', '')}" is not accepted.`,
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

  return { ok: true, link: url.toString() };
}

module.exports = { validate, SCHEMES, MAX_LENGTH };
