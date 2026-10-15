/* The only code in this package that deletes anything, and the only place the
 * word unlink appears outside it.
 *
 * WHY IT IS A MODULE AND NOT TWO LINES AT THE CALL SITE. The studio's rule is
 * that Forge can never delete a stored file — not by route, not by accident,
 * not by a well-meaning cleanup that walks one directory too far up. A rule
 * like that is only as good as the number of places it has to hold in, so
 * there is exactly one, it takes the root as an argument so it cannot be
 * tricked by a relative path, and it refuses anything that is not inside
 * <root>/.incoming after both ends are realpath'd.
 *
 * .incoming is the gateway's own scratch area: half-finished chunk files and
 * the self-test's kilobyte. Nothing a person uploaded has ever lived there
 * after `complete` — finishing MOVES the file out — so everything this is
 * allowed to touch is something this process wrote for itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const { INCOMING } = require('./paths');

function incomingRoot(root) {
  const real = fs.realpathSync(root);
  return path.join(real, INCOMING);
}

/* Is this absolute path inside <root>/.incoming?
 *
 * Both sides realpath'd where they exist, so a symlink pointing from inside
 * .incoming to somewhere real is judged by where it LANDS. The deepest
 * existing ancestor is used for a path that is already gone, so deleting
 * something twice is a no-op rather than a refusal with a confusing reason. */
function isInsideIncoming(root, target) {
  let inc;
  try { inc = incomingRoot(root); } catch { return false; }
  const abs = path.resolve(target);
  let probe = abs;
  let real = null;
  while (true) {
    try { real = fs.realpathSync(probe); break; } catch { /* keep walking up */ }
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (real === null) return false;
  const tail = path.relative(probe, abs);
  const landed = tail ? path.join(real, tail) : real;
  // Strictly INSIDE: .incoming itself is not a thing this may remove, because
  // removing it would take the directory the next upload needs with it.
  return landed.startsWith(inc + path.sep);
}

/* Remove a file or a whole directory, if and only if it is inside .incoming.
   Returns { ok } or { ok: false, reason } — never throws for a refusal, so a
   caller cannot mistake "not allowed" for "already gone". */
function remove(root, target) {
  if (!isInsideIncoming(root, target)) {
    return { ok: false, reason: 'outside-incoming' };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err.code || String(err.message) };
  }
}

/* Abandoned uploads. Age in minutes, from the directory's own mtime, and only
   directories directly under .incoming — so a deep tree cannot make this walk
   into the share. */
function sweepAbandoned(root, { olderThanMinutes = 24 * 60, now = Date.now(), keep = [] } = {}) {
  let inc;
  try { inc = incomingRoot(root); } catch { return { removed: 0, kept: 0 }; }
  let entries = [];
  try { entries = fs.readdirSync(inc, { withFileTypes: true }); } catch { return { removed: 0, kept: 0 }; }
  const cutoff = now - olderThanMinutes * 60 * 1000;
  let removed = 0; let kept = 0;
  for (const e of entries) {
    const full = path.join(inc, e.name);
    if (keep.includes(e.name)) { kept += 1; continue; }
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs > cutoff) { kept += 1; continue; }
    if (remove(root, full).ok) removed += 1;
  }
  return { removed, kept };
}

module.exports = { remove, isInsideIncoming, sweepAbandoned, incomingRoot };
