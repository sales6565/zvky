/* Internal distribution of the two mobile builds.
 *
 * WHAT THIS SOLVES, AND WHY IT IS NOT BEHIND A LOGIN.
 *
 * Neither app is going on the App Store or Google Play, so the builds have to
 * be handed out from this server. Android is the easy half: a phone downloads
 * an .apk over HTTPS and installs it. iOS is the half with a trap in it.
 *
 * iOS does not install an .ipa from a link. Tapping an `itms-services://` link
 * hands a manifest URL to the operating system, and then a SYSTEM DAEMON —
 * not Safari — fetches the manifest and the .ipa. That daemon has none of
 * Safari's cookies, none of its localStorage and none of its Authorization
 * headers. Put the manifest behind this application's sign-in and the install
 * fails with "Cannot connect to <host>", which names the host and nothing
 * useful, because the daemon was handed the sign-in page instead of a plist.
 *
 * So the payload paths CANNOT be authenticated. What replaces the login is an
 * unguessable path: 24 random bytes in the URL, over HTTPS, compared in
 * constant time. That is the same shape of secret as a password reset link,
 * and the trade-off is deliberate and worth stating plainly:
 *
 *   ANYBODY WHO HAS THE LINK CAN DOWNLOAD THE BUILDS. The link is the
 *   credential. It is not a sign-in, and it does not check who is asking.
 *
 * What that does and does not expose is worth being exact about. The builds
 * are SHELLS: they contain no studio data, no database, and no credentials —
 * they load this web application over the network, and everything inside them
 * is still behind the same sign-in as the website. A stranger with the link
 * gets an app that shows them the login screen. The reasons to keep the link
 * to the team anyway are that it is a build nobody outside the studio should
 * be running, and that rotating it is one environment variable away
 * (MOBILE_DIST_TOKEN) if it ever leaks.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Where the built files are dropped. Outside the repo tree by default would be
// tidier, but a studio on shared hosting uploads through a file manager and
// needs a directory it can find, so it sits beside the application.
const DIST_DIR = process.env.MOBILE_DIST_DIR
  ? path.resolve(process.env.MOBILE_DIST_DIR)
  : path.join(__dirname, '..', 'dist-mobile');

/* The files this serves, by the name they must have on disk.
 *
 * A FIXED LIST, not a directory listing. The token is in the URL and the
 * remainder of the path is whatever the caller typed, so serving "the file
 * they asked for" is how a distribution directory becomes a way to read
 * anything on the host. Nothing here is derived from user input: the URL
 * selects a key from this table, and the table holds the filename. */
const FILES = {
  'zvky.apk': { file: 'zvky.apk', mime: 'application/vnd.android.package-archive', platform: 'android', label: 'Android app' },
  'zvky.ipa': { file: 'zvky.ipa', mime: 'application/octet-stream', platform: 'ios', label: 'iOS app' },
  'manifest.plist': { file: 'manifest.plist', mime: 'application/xml', platform: 'ios', label: 'iOS install manifest' },
  'icon-57.png': { file: 'icon-57.png', mime: 'image/png', platform: 'ios', label: 'Manifest icon' },
  'icon-512.png': { file: 'icon-512.png', mime: 'image/png', platform: 'ios', label: 'Manifest icon (large)' },
};

let memoryToken = null;

/* The token in the URL.
 *
 * MOBILE_DIST_TOKEN if the deployment sets one — that is the way to rotate it,
 * and the way to keep it identical across two servers behind a load balancer.
 * Otherwise one is generated once and written beside the builds, so it
 * survives a restart: a token that changed on every boot would invalidate the
 * install link the team has in their inbox, and an iOS install started before
 * the restart would fail halfway with the daemon's unhelpful message.
 *
 * If the directory cannot be written — a read-only deployment — the token
 * lives in memory for this process, and status() says so rather than letting
 * somebody discover it when the link stops working. */
function token() {
  const fromEnv = (process.env.MOBILE_DIST_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (memoryToken) return memoryToken;

  const file = path.join(DIST_DIR, '.dist-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      memoryToken = existing;
      return memoryToken;
    }
  } catch { /* not written yet */ }

  memoryToken = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.writeFileSync(file, `${memoryToken}\n`, { mode: 0o600 });
  } catch { /* held in memory; status() reports persisted:false */ }
  return memoryToken;
}

function tokenIsPersisted() {
  if ((process.env.MOBILE_DIST_TOKEN || '').trim()) return true;
  try {
    return fs.readFileSync(path.join(DIST_DIR, '.dist-token'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/* Constant-time comparison.
 *
 * `===` on a secret leaks its prefix through how long the comparison takes,
 * and this one sits on an unauthenticated route that anybody may call as often
 * as they like. timingSafeEqual throws on a length mismatch, which is itself a
 * leak of the length — hash both sides first so the buffers are always 32
 * bytes and the only thing measurable is that a request happened. */
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(token()).digest();
  return crypto.timingSafeEqual(a, b);
}

// One file's state on disk. null when it has not been built and uploaded yet,
// which is the normal state of the iOS half until somebody with a Mac runs the
// Xcode export.
function describeFile(key) {
  const spec = FILES[key];
  if (!spec) return null;
  const full = path.join(DIST_DIR, spec.file);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    name: spec.file,
    label: spec.label,
    platform: spec.platform,
    bytes: stat.size,
    size: humanSize(stat.size),
    updatedAt: stat.mtime.toISOString(),
    path: full,
    mime: spec.mime,
  };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* The sha256 a person can check their download against.
 *
 * Android shows no publisher for a sideloaded build, so "is this the file the
 * studio built?" has no answer from the operating system. This is the answer:
 * the same digest the build script prints. Computed on demand and cached
 * against the file's size and mtime, because it reads the whole .apk. */
const digestCache = new Map();
function digest(key) {
  const info = describeFile(key);
  if (!info) return null;
  const stamp = `${info.bytes}:${info.updatedAt}`;
  const hit = digestCache.get(key);
  if (hit && hit.stamp === stamp) return hit.sha256;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(info.path)).digest('hex');
  digestCache.set(key, { stamp, sha256 });
  return sha256;
}

/* The public origin the install links are built from.
 *
 * This MATTERS more than it looks. The URL inside the iOS manifest is absolute
 * and is fetched by the installer daemon, so a guess taken from the incoming
 * request's Host header would bake whatever the phone typed into the link —
 * an internal hostname, or http — and the install would fail. MOBILE_DIST_BASE
 * (or PUBLIC_BASE_URL) is the deployment saying what its public https origin
 * actually is; the request is only a fallback for a deployment that has set
 * neither, and links() reports which was used. */
function baseUrl(req) {
  const configured = (process.env.MOBILE_DIST_BASE || process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return { url: configured.replace(/\/+$/, ''), source: 'configured' };
  if (!req) return { url: '', source: 'none' };
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return { url: host ? `${proto}://${host}` : '', source: 'request' };
}

// Everything the admin screen needs: what is built, where the links point, and
// what is wrong with the setup if anything is.
function status(req) {
  const base = baseUrl(req);
  const dir = `${base.url}/m/${token()}`;
  const android = describeFile('zvky.apk');
  const ios = describeFile('zvky.ipa');
  const manifest = describeFile('manifest.plist');

  const warnings = [];
  if (!base.url) {
    warnings.push('This deployment has not been told its public address. Set MOBILE_DIST_BASE to the https:// origin the team reaches, or the iOS install link will be wrong.');
  } else if (!base.url.startsWith('https://')) {
    warnings.push(`The install address is ${base.url}. iOS refuses to install over plain http — the manifest and the .ipa must both be served over https with a certificate the phone trusts.`);
  }
  if (!tokenIsPersisted()) {
    warnings.push('The distribution token is only held in this process\'s memory, because the distribution directory could not be written. It will change on the next restart and the link you have handed out will stop working. Set MOBILE_DIST_TOKEN in the environment.');
  }
  if (ios && !manifest) {
    warnings.push('An .ipa is present but manifest.plist is not. iOS installs from the manifest, not from the .ipa — run "npm run manifest:ios" in mobile/ with --base set to the install directory below.');
  }

  return {
    token: token(),
    tokenPersisted: tokenIsPersisted(),
    directory: DIST_DIR,
    base: base.url,
    baseSource: base.source,
    installPage: `${dir}/`,
    android: android ? { ...android, url: `${dir}/zvky.apk`, sha256: digest('zvky.apk'), path: undefined } : null,
    ios: ios ? { ...ios, url: `${dir}/zvky.ipa`, sha256: digest('zvky.ipa'), path: undefined } : null,
    manifest: manifest ? { ...manifest, url: `${dir}/manifest.plist`, path: undefined } : null,
    iosInstallLink: manifest ? `itms-services://?action=download-manifest&url=${dir}/manifest.plist` : null,
    warnings,
  };
}

module.exports = { DIST_DIR, FILES, token, tokenIsPersisted, tokenMatches, describeFile, digest, baseUrl, status, humanSize };
