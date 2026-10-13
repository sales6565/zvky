/* WHAT IS THIS SERVER ACTUALLY RUNNING, AND IS THE PAGE IN FRONT OF SOMEBODY
 * THE ONE IT SENT?
 *
 * THIS FILE EXISTS BECAUSE THE HOLD BUTTON HAS NOW BEEN REPORTED FOUR TIMES,
 * and on the fourth the first question — "is the fix even deployed?" — could
 * not be answered. There was no version anywhere: not in the page, not in
 * /api/health, not in a header. package.json has said 1.0.0 since the first
 * commit. So every report carried an unknown: a user describing the old
 * behaviour might be describing a bug, or an un-deployed fix, or a browser
 * holding yesterday's HTML, and nothing on the screen could tell those apart.
 *
 * THE STAMP IS COMPUTED, NOT WRITTEN DOWN. This project has no build step on
 * purpose — package.json says so in as many words — so anything a human or a
 * script has to remember to bump is a stamp that will be wrong exactly when it
 * matters. Instead:
 *
 *   page    the first twelve hex digits of a SHA-256 over public/index.html's
 *           own bytes. It cannot be stale: if the file changes the stamp
 *           changes, and if it does not, it does not.
 *   commit  BUILD_COMMIT if the host sets it, else read out of .git when there
 *           is one. Absent on a cPanel deployment made from a zip, which is
 *           this project's documented path — hence the hash above, which works
 *           there.
 *   version package.json, for the humans.
 *
 * AND THE PAGE CARRIES ITS OWN. src/page-stamp.js injects the stamp into the
 * HTML as it is served, so the page in a browser knows which page it is rather
 * than which page the server would send now. Those two differing is precisely
 * the stale-cache case, and the page can then say so instead of leaving somebody
 * to describe behaviour from a build nobody is looking at.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const STARTED_AT = new Date().toISOString();

let appVersion = null;
function version() {
  if (appVersion === null) {
    try {
      appVersion = String(require('../package.json').version || '') || 'unknown';
    } catch { appVersion = 'unknown'; }
  }
  return appVersion;
}

/* The commit, when the host can tell us.
 *
 * Read ONCE: a running process does not change commit under itself, and reading
 * .git on every request would be a file system call on the hot path for a string
 * that cannot move. */
let commitValue;
function commit() {
  if (commitValue !== undefined) return commitValue;
  const fromEnv = String(process.env.BUILD_COMMIT || '').trim();
  if (fromEnv) { commitValue = fromEnv.slice(0, 40); return commitValue; }
  try {
    const head = fs.readFileSync(path.join(__dirname, '..', '.git', 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) { commitValue = head.slice(0, 40) || null; return commitValue; }
    const file = path.join(__dirname, '..', '.git', ref[1]);
    commitValue = fs.readFileSync(file, 'utf8').trim().slice(0, 40) || null;
  } catch {
    /* No .git — a zip deployment, which is this project's documented path. The
       page hash below is the stamp that still works there. */
    commitValue = null;
  }
  return commitValue;
}

/* The page's own fingerprint, memoised on the thing that would change it.
 *
 * mtime AND size, the same pair src/theme-delivery.js keys its cache on: mtime
 * alone is not enough on a host whose clock or copy tool flattens timestamps,
 * and size alone misses an edit that happens to keep the length. */
let pageCache = null;
function pageStamp() {
  let stat;
  try { stat = fs.statSync(PAGE); } catch { return 'nopage'; }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (pageCache && pageCache.key === key) return pageCache.stamp;
  let stamp = 'unreadable';
  try {
    stamp = crypto.createHash('sha256').update(fs.readFileSync(PAGE)).digest('hex').slice(0, 12);
  } catch { /* leave it as unreadable rather than throwing from a status field */ }
  pageCache = { key, stamp };
  return stamp;
}

// Everything a report needs in order to say what was running.
function current() {
  return {
    version: version(),
    commit: commit(),
    page: pageStamp(),
    startedAt: STARTED_AT,
    node: process.version,
  };
}

// For the tests, and for a host that replaces the page while running.
function forget() { pageCache = null; commitValue = undefined; appVersion = null; }

module.exports = { current, pageStamp, commit, version, forget, STARTED_AT, PAGE };
