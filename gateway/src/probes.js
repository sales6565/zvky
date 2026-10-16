/* THE FILESYSTEM QUESTIONS, ASKED IN ONE PLACE.
 *
 * Does this share do hard links? Does it fold case? Will it take a 300-character
 * path? Is a preallocated file written in place? These are properties of a
 * filesystem in a building, and the answers decide how the gateway finishes an
 * upload and what a collision becomes.
 *
 * SHARED BY TWO CALLERS ON PURPOSE. gateway/doctor.js runs them on the machine,
 * as the service account, with IT watching; the self-test button in Settings
 * runs the same functions through the selftest route so somebody who cannot get
 * onto that machine still sees the answers. Two implementations would have
 * drifted, and the one that drifted would be the one nobody ran.
 *
 * EVERYTHING HAPPENS INSIDE .incoming. That is the only place this package may
 * delete, so it is the only place a probe may write: a probe that left a file
 * in the archive would leave litter the service account cannot clear up.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');
const deleter = require('./deleter');

const NO_LINK_CODES = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL']);

function scratch(root, name) {
  const real = fs.realpathSync(root);
  const home = path.join(real, paths.INCOMING, name);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return { real, home };
}

/* b. How an upload will be finished on this filesystem, and whether the
   no-overwrite guarantee holds. */
function finaliseProbe(root, home) {
  const out = {};
  const src = path.join(home, 'src.bin');
  const dest = path.join(home, 'dest');
  fs.mkdirSync(dest, { recursive: true });
  const target = path.join(dest, 'final.bin');
  fs.writeFileSync(src, Buffer.alloc(2048, 5));
  try {
    fs.linkSync(src, target);
    out.hardLink = true;
    out.how = 'link';
  } catch (err) {
    out.hardLink = false;
    out.how = NO_LINK_CODES.has(err.code) ? 'copy' : null;
    out.linkError = err.code || String(err.message);
  }
  // The exclusive create: the whole no-overwrite promise, on both paths.
  if (fs.existsSync(target)) {
    try {
      fs.closeSync(fs.openSync(target, 'wx'));
      out.exclusiveCreate = false;        // it should have refused
    } catch (err) { out.exclusiveCreate = err.code === 'EEXIST'; }
  } else {
    // No link, so make one by hand to test against.
    fs.writeFileSync(target, 'x');
    try {
      fs.closeSync(fs.openSync(target, 'wx'));
      out.exclusiveCreate = false;
    } catch (err) { out.exclusiveCreate = err.code === 'EEXIST'; }
  }
  // Positional write into a preallocated file: how every chunk arrives.
  try {
    const f = path.join(home, 'sparse.bin');
    const fd = fs.openSync(f, 'w');
    fs.ftruncateSync(fd, 1024 * 1024);
    fs.writeSync(fd, Buffer.alloc(16, 9), 0, 16, 1024 * 1024 - 16);
    fs.closeSync(fd);
    out.positionalWrite = fs.statSync(f).size === 1024 * 1024;
  } catch (err) { out.positionalWrite = false; out.positionalError = err.code || String(err.message); }
  // Read-only, and whether a write to one is refused.
  try {
    const f = path.join(home, 'ro.bin');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o444);
    let refused = false;
    try { fs.writeFileSync(f, 'y'); } catch { refused = true; }
    try { fs.chmodSync(f, 0o644); } catch { /* so cleanup works */ }
    out.readOnlyHolds = refused;
  } catch (err) { out.readOnlyHolds = null; out.readOnlyError = err.code || String(err.message); }
  return out;
}

/* c. What kind of filesystem this is. */
function filesystemProbe(home) {
  const out = {};
  try {
    const lower = path.join(home, 'case-a.txt');
    const upper = path.join(home, 'CASE-A.TXT');
    fs.writeFileSync(lower, 'lower');
    try {
      fs.closeSync(fs.openSync(upper, 'wx'));
      out.caseSensitive = true;
    } catch (err) { out.caseSensitive = err.code !== 'EEXIST'; }
  } catch (err) { out.caseSensitive = null; out.caseError = err.code || String(err.message); }

  try {
    const deep = path.join(home, 'x'.repeat(120), 'y'.repeat(120));
    fs.mkdirSync(deep, { recursive: true });
    const file = path.join(deep, `${'z'.repeat(40)}.bin`);
    fs.writeFileSync(file, 'x');
    out.longPaths = true;
    out.longPathLength = file.length;
  } catch (err) { out.longPaths = false; out.longPathError = err.code || String(err.message); }

  try {
    const st = fs.statfsSync(home);
    out.freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch { out.freeBytes = null; }
  out.platform = process.platform;
  out.node = process.versions.node;
  return out;
}

/* Both, with the scratch area made and removed around them. The one entry point
   the doctor and the selftest route both call. */
function run(root, { name = `probe-${crypto.randomUUID().slice(0, 8)}` } = {}) {
  let where;
  try { where = scratch(root, name); }
  catch (err) { return { ok: false, error: err.code || String(err.message) }; }
  let finalise = null;
  let filesystem = null;
  try {
    finalise = finaliseProbe(where.real, where.home);
    filesystem = filesystemProbe(where.home);
  } catch (err) {
    return { ok: false, error: err.code || String(err.message) };
  } finally {
    deleter.remove(where.real, where.home);
  }
  return {
    ok: true,
    finalise,
    filesystem,
    // Nothing is left behind: asserted rather than assumed, because the one
    // place a probe must not litter is a studio's archive.
    cleaned: !fs.existsSync(where.home),
  };
}


/* THE CLOCK VERDICT, as a function, because three places have an opinion about
 * one number and only one of them should decide.
 *
 * Above the leeway is a FAILURE and not a warning: a token lives sixty seconds,
 * so a clock that far out means every link expires on arrival and the tab goes
 * quiet with nothing explaining it. Above fifteen seconds is a warning — it
 * works today and it is drifting. The leeway is passed in rather than read
 * here, so the doctor and the Settings screen cannot disagree about it, and
 * tokens.leewayFor() is what caps it. */
const CLOCK_WARN_SECONDS = 15;

function clockVerdict(skewSeconds, leewaySeconds) {
  const skew = Math.abs(Number(skewSeconds));
  if (!Number.isFinite(skew)) return 'unknown';
  if (skew > Number(leewaySeconds)) return 'fail';
  if (skew > CLOCK_WARN_SECONDS) return 'warn';
  return 'pass';
}

module.exports = { run, finaliseProbe, filesystemProbe, scratch, NO_LINK_CODES,
  clockVerdict, CLOCK_WARN_SECONDS };
