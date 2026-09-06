/* Which ZVKY FORGE this window opens.
 *
 * NOT BAKED IN, and that is the important decision here. A wrapper with a
 * hard-coded address is one that needs rebuilding and redistributing the day a
 * studio changes domain, moves to a subdomain, or wants a second copy pointed
 * at a staging instance. So the address is a setting, stored beside the app's
 * own data, and asked for once on first run.
 *
 * The order below is deliberate: an environment variable wins so that a test
 * machine can be pointed anywhere without touching a person's saved setting;
 * then what the person chose; then a build-time default for a studio that would
 * rather ship it pre-filled.
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/* A studio that wants the address pre-filled sets this before building. Left
   empty, the app asks on first run — which is better than shipping a guess:
   a wrapper pointed at somebody else's domain is worse than one that asks. */
const BUILT_IN = process.env.ZVKY_APP_URL_DEFAULT || '';

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    /* Missing is the ordinary first-run case; unreadable is a corrupted file,
       and treating both as "no settings yet" means a bad file is recovered from
       by asking again rather than by refusing to start. */
    return {};
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/* Anything the window is pointed at has to be a real https (or http, for a
 * studio testing on a local machine) address. Checked here rather than trusted,
 * because this string becomes the origin that notifications are granted to and
 * that external-link handling is judged against — a malformed one would make
 * both of those decisions on nonsense.
 */
function normalise(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Keep the path — a studio may host this under /forge rather than at the root.
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

const appUrl = () => normalise(process.env.ZVKY_APP_URL) || normalise(read().appUrl) || normalise(BUILT_IN);

/* The origin, for the two decisions that are about WHERE a request came from
   rather than what it asked for: whether to grant notifications, and whether a
   link should open in this window or in the person's browser. */
const appOrigin = () => {
  const url = appUrl();
  try { return url ? new URL(url).origin : null; } catch { return null; }
};

module.exports = {
  appUrl,
  appOrigin,
  normalise,
  read,
  write,
  setAppUrl: (raw) => {
    const url = normalise(raw);
    if (!url) return null;
    write({ appUrl: url });
    return url;
  },
};
