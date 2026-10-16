/* Chunked, resumable uploads — and the one move at the end.
 *
 * A fortnight of animation renders is not a 200 MB web form. So:
 *
 *   The browser reads the file with File.slice and sends one chunk at a time.
 *   Nothing ever holds a whole file in memory, at either end.
 *
 *   Each chunk is written AT ITS OFFSET into a file preallocated to the
 *   declared size. That is why chunks may arrive out of order and in parallel,
 *   and why finishing is a move rather than a concatenation: there is no second
 *   copy to make, because the bytes were already in the right places.
 *
 *   The received ranges are recorded beside the blob, so a browser that was
 *   reloaded, slept, or lost the office wifi asks `status` and resumes from
 *   what is actually on disk instead of starting again.
 *
 * FINISHING, and why it is link-then-unlink rather than rename.
 *
 * The rule is: never overwrite, and never delete anything outside .incoming.
 * POSIX rename() silently replaces the destination, which breaks the first
 * half. So the final name is claimed with link(), which FAILS with EEXIST if
 * the name is taken — on NTFS as well as on ext4 — and the source link inside
 * .incoming is then removed, which is the one place deletion is allowed. The
 * file never exists in two places and no byte is copied.
 *
 * A share that cannot hard-link (an SMB mount with links disabled, FAT) falls
 * back to claiming the name with an exclusive create and renaming over that
 * zero-byte reservation — still never another file, still no delete outside
 * .incoming. gateway/README.md says which one a given share will use.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const deleter = require('./deleter');

const META = 'meta.json';
const RANGES = 'ranges.json';
const BLOB = 'blob';

const dirFor = (root, uploadId) => path.join(fs.realpathSync(root), paths.INCOMING, uploadId);

/* An upload id is a name on disk, so it goes through the same gate every other
   name does — and is additionally held to the shape Forge mints (a uuid), so
   nothing creative can be smuggled in even if cleanSegment one day softens. */
/* The errors a filesystem gives for "I do not do hard links". */
const NO_LINK_CODES = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL']);

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (id) => typeof id === 'string' && ID_SHAPE.test(id);

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    // Touching counts as overlapping: [0,16) and [16,32) are one range, which
    // is what makes "is it complete" a single comparison rather than a walk.
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

/* Written to a temporary name and renamed into place: a half-written ranges
   file read after a crash would claim bytes that are not there, which is worse
   than losing the record of the ones that are. Both files live inside .incoming. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/* Begin. Called on the first chunk rather than by a route of its own: the
   upload SESSION is created in Forge (which is where permission and size live),
   and this side materialises the files when bytes actually turn up, so an
   abandoned session costs nothing on the share. */
function ensure(root, uploadId, { size, name, dir, sub }) {
  if (!validId(uploadId)) return { ok: false, reason: 'That upload id is not one Forge issued.' };
  const home = dirFor(root, uploadId);
  const blob = path.join(home, BLOB);
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(path.join(home, META))) {
    writeJsonAtomic(path.join(home, META), {
      uploadId, size, name, dir, sub, startedAt: new Date().toISOString(),
    });
  }
  if (!fs.existsSync(blob)) {
    // Preallocate. ftruncate makes a sparse file of the full size, so the
    // positional writes below never have to extend it and a disk that cannot
    // hold the file fails here rather than at 90%.
    const fd = fs.openSync(blob, 'w');
    try { fs.ftruncateSync(fd, Number(size)); } finally { fs.closeSync(fd); }
  }
  return { ok: true, home, blob, meta: readJson(path.join(home, META), null) };
}

function putChunk(root, uploadId, offset, buffer, { size, name, dir, sub } = {}) {
  const started = ensure(root, uploadId, { size, name, dir, sub });
  if (!started.ok) return started;
  const meta = started.meta || {};
  const total = Number(meta.size !== undefined ? meta.size : size);
  const start = Number(offset);
  if (!Number.isInteger(start) || start < 0) return { ok: false, reason: 'That chunk has no offset.' };
  if (!Number.isFinite(total)) return { ok: false, reason: 'That upload has no declared size.' };
  const end = start + buffer.length;
  if (end > total) {
    // The declared size is the contract. More bytes than that is either a bug
    // or somebody trying to write past a preallocated file; either way it stops
    // here rather than growing the file.
    return { ok: false, reason: `That chunk ends at ${end}, past the declared size of ${total}.` };
  }
  const fd = fs.openSync(started.blob, 'r+');
  try { fs.writeSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  const file = path.join(started.home, RANGES);
  const ranges = mergeRanges([...(readJson(file, []) || []), [start, end]]);
  writeJsonAtomic(file, ranges);
  return { ok: true, received: ranges, size: total, complete: ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === total };
}

function status(root, uploadId) {
  if (!validId(uploadId)) return { ok: false, reason: 'That upload id is not one Forge issued.' };
  let home;
  try { home = dirFor(root, uploadId); } catch { return { ok: false, reason: 'The file share is not reachable.' }; }
  if (!fs.existsSync(home)) return { ok: true, received: [], size: null, complete: false, started: false };
  const meta = readJson(path.join(home, META), {}) || {};
  const ranges = mergeRanges(readJson(path.join(home, RANGES), []) || []);
  const total = Number(meta.size);
  return {
    ok: true,
    started: true,
    received: ranges,
    size: Number.isFinite(total) ? total : null,
    complete: Number.isFinite(total) && ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === total,
    name: meta.name || null,
    dir: meta.dir === undefined ? null : meta.dir,
  };
}

/* Claim a final name without ever replacing a file. See the header. */
function claim(blob, dirAbs, name) {
  for (let n = 1; n <= 500; n += 1) {
    const candidate = path.join(dirAbs, n === 1 ? name : paths.collisionName(name, n));
    try {
      fs.linkSync(blob, candidate);
      return { ok: true, full: candidate, stored: path.basename(candidate), how: 'link' };
    } catch (err) {
      if (err.code === 'EEXIST') continue;             // taken — try "name (2).ext"
      if (NO_LINK_CODES.has(err.code)) {
        /* NO HARD LINKS ON THIS SHARE. Common on SMB/CIFS mounts with links
         * disabled, and on anything FAT-shaped.
         *
         * The fallback must keep the two promises the link path keeps: never
         * replace an existing file, and never delete one. So the name is
         * claimed with an EXCLUSIVE create — which fails if it is taken, and
         * that is the no-overwrite guarantee — and the bytes are then COPIED
         * into that reservation and the source removed from .incoming.
         *
         * A copy, not a rename. rename() onto an existing path replaces it on
         * POSIX, and the reservation we just made is an existing path: the
         * earlier version of this did exactly that, which worked only because
         * the file it replaced was its own. That is one refactor away from
         * replacing somebody's render, so the fallback copies and verifies the
         * size instead. It costs a second pass over the bytes on precisely the
         * filesystems that cannot do better, and gateway/doctor.js tells IT
         * which path their share will take before anybody uploads.
         */
        let fd;
        try {
          fd = fs.openSync(candidate, 'wx');
        } catch (e2) {
          if (e2.code === 'EEXIST') continue;
          return { ok: false, reason: `Could not create the file (${e2.code || e2.message}).` };
        }
        try {
          const source = fs.openSync(blob, 'r');
          try {
            const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
            let at = 0;
            for (;;) {
              const read = fs.readSync(source, buf, 0, buf.length, at);
              if (!read) break;
              fs.writeSync(fd, buf, 0, read, at);
              at += read;
            }
          } finally { fs.closeSync(source); }
          fs.closeSync(fd);
          const wrote = fs.statSync(candidate).size;
          const was = fs.statSync(blob).size;
          if (wrote !== was) {
            return { ok: false, reason: `The copy is ${wrote} bytes and the upload was ${was}.` };
          }
          return { ok: true, full: candidate, stored: path.basename(candidate), how: 'reserve+copy' };
        } catch (e3) {
          try { fs.closeSync(fd); } catch { /* already closed */ }
          return { ok: false, reason: `Could not finish the file (${e3.code || e3.message}).` };
        }
      }
      return { ok: false, reason: `Could not create the file (${err.code || err.message}).` };
    }
  }
  return { ok: false, reason: 'Too many files with that name in this folder.' };
}

/* Finish: check the declared size is actually all there, move it out of
   .incoming under a name that was free, and make it read-only.
 *
 * The checksum is NOT computed here. A 40 GB read would hold the request open
 * for minutes after the bytes are safe; the page would show a spinner for a
 * file that is already on the share. It is computed after the move and
 * reported by callback — see sha256() — which is why the UI says "verifying…"
 * and then the short checksum.
 */
function complete(root, uploadId, { dir, name, existingPrefix }) {
  const st = status(root, uploadId);
  if (!st.ok) return st;
  if (!st.started) return { ok: false, reason: 'That upload has not started.' };
  if (!st.complete) {
    const have = st.received.reduce((n, [s, e]) => n + (e - s), 0);
    return { ok: false, reason: `That upload is not finished: ${have} of ${st.size} bytes received.`, received: st.received, size: st.size };
  }
  const home = dirFor(root, uploadId);
  const blob = path.join(home, BLOB);
  const onDisk = fs.statSync(blob).size;
  if (onDisk !== st.size) {
    return { ok: false, reason: `The file on disk is ${onDisk} bytes; ${st.size} were declared.` };
  }
  const target = paths.resolve(root, dir === undefined || dir === null ? st.dir : dir);
  if (!target.ok) return target;

  /* THE PROJECT FOLDER IS A PRECONDITION, NOT SOMETHING THIS CREATES.
   *
   * The token names it (claims.pre). If it is not on the share, the upload is
   * refused and NOTHING is created — because the alternative is a mistyped link
   * silently producing a second project folder that nobody is looking in, with
   * the artist and the project manager both told it worked.
   *
   * Only the folders BELOW it are made, lazily: the discipline and the person.
   * A token with no `pre` is the Server tab's own upload, where the person
   * chose a folder they can already see, and the old behaviour stands. */
  if (existingPrefix !== undefined && existingPrefix !== null && existingPrefix !== '') {
    const base = paths.resolve(root, existingPrefix);
    if (!base.ok) return base;
    let there = false;
    try { there = fs.statSync(base.full).isDirectory(); } catch { there = false; }
    if (!there) {
      return {
        ok: false,
        reason: 'Project folder not found on the server. Ask your project manager or IT to check '
          + "the project's server link.",
        code: 'project_folder_missing',
        missing: base.relative,
      };
    }
  }
  if (!fs.existsSync(target.full)) fs.mkdirSync(target.full, { recursive: true });
  const clean = paths.cleanSegment(name || st.name);
  if (!clean.ok) return clean;
  const claimed = claim(blob, target.full, clean.value);
  if (!claimed.ok) return claimed;
  /* The source copy inside .incoming goes either way: it is our own link in
     the link case, and our own original in the copy case. Both are inside
     .incoming, which is the only place this may delete. */
  deleter.remove(root, blob);
  try { fs.chmodSync(claimed.full, 0o444); } catch { /* a share may refuse; the README covers it */ }
  deleter.remove(root, home);                                 // meta and ranges, inside .incoming
  return {
    ok: true,
    stored: claimed.stored,
    relative: [target.relative, claimed.stored].filter(Boolean).join('/'),
    size: st.size,
    renamed: claimed.stored !== clean.value,
    how: claimed.how,
  };
}

/* Read it back once, afterwards, without holding anything in memory. */
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

module.exports = { ensure, putChunk, status, complete, sha256, mergeRanges, validId, dirFor, claim,
  BLOB, META, RANGES, NO_LINK_CODES };
