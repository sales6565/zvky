/* The path jail. Everything the gateway is allowed to touch comes through here.
 *
 * ONE ENTRY POINT, ON PURPOSE. Every route resolves its path with resolve()
 * below and gets back either an absolute path proven to be inside FILE_ROOT or
 * a refusal — never a string it then has to remember to check. A second way in
 * is the whole of this class of bug, so there isn't one: the routes do not join
 * paths themselves and a test enumerates the router to say so.
 *
 * WHY realpath AND a prefix test. A prefix test alone is beaten by a symlink:
 * <root>/shared/out -> /etc and "shared/out/passwd" is textually inside the
 * root while reading something that is not. realpath alone is beaten by a path
 * that does not exist yet — which is every upload — because realpath throws on
 * it. So: resolve textually, realpath the deepest part that EXISTS, test that
 * against the realpath'd root, and keep the non-existent tail as-is. A symlink
 * anywhere along the existing part is therefore followed and then judged.
 */
const path = require('node:path');
const fs = require('node:fs');

// Windows device names. Reserved with ANY extension, so "NUL.txt" is refused too.
const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

/* Characters no segment may contain.
 *
 * The control range and the five Windows-illegal punctuation marks, plus the
 * separators, which are handled by splitting rather than by sanitising: a
 * segment containing a separator is a caller trying to build a path out of
 * something that was supposed to be a name. */
const ILLEGAL = /[\u0000-\u001f\u007f<>:"|?*\\/]/;

const MAX_SEGMENT = 180;      // comfortably under Windows' 255, leaving room for " (2)"
const MAX_RELATIVE = 1000;    // and under the 32,767 of an extended path with margin

const INCOMING = '.incoming';

/* Names the gateway never lists and never serves. Lower-cased comparison,
   because a share written by Windows will have Thumbs.db in any casing. */
const HIDDEN = new Set(['thumbs.db', 'desktop.ini', '$recycle.bin',
  'system volume information', INCOMING]);

const isHidden = (name) => {
  const n = String(name || '').toLowerCase();
  return n.startsWith('.') || HIDDEN.has(n);
};

const fail = (reason) => ({ ok: false, reason });

/* Is this single name usable as a file or folder name here?
 *
 * Refuses rather than sanitises, with one exception: trailing dots and spaces
 * are STRIPPED, because Windows silently strips them when creating the file and
 * then cannot open it by the name it was given. Stripping here means the name
 * stored is the name that works; refusing would reject "Final render ." which
 * is a thing people type. Everything else is a refusal with a reason, because
 * quietly renaming somebody's file is worse than telling them. */
function cleanSegment(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  if (!text) return fail('A name is required.');
  if (text === '.' || text === '..') return fail(`"${text}" is not a name.`);
  if (ILLEGAL.test(text)) return fail(`"${text}" contains a character that cannot be used in a file name.`);
  const trimmed = text.replace(/[. ]+$/g, '');
  if (!trimmed) return fail(`"${text}" is not a name.`);
  if (trimmed.length > MAX_SEGMENT) return fail(`That name is ${trimmed.length} characters; the limit is ${MAX_SEGMENT}.`);
  const base = trimmed.includes('.') ? trimmed.slice(0, trimmed.indexOf('.')) : trimmed;
  if (RESERVED.has(base.toLowerCase())) return fail(`"${trimmed}" is a name Windows reserves for a device.`);
  return { ok: true, value: trimmed };
}

/* Split a client-supplied relative path into clean segments.
 *
 * Accepts both separators because the browser may send either, and refuses an
 * absolute path, a drive letter, a UNC path and any "..". Note the order: the
 * absolute and traversal checks run on the RAW text, before any normalising, so
 * there is no window in which a normalise step could turn something refused
 * into something accepted. */
function segments(relative) {
  const raw = String(relative === undefined || relative === null ? '' : relative);
  if (raw.length > MAX_RELATIVE) return fail(`That path is ${raw.length} characters; the limit is ${MAX_RELATIVE}.`);
  let text = raw;
  // %2e%2e%2f and friends: decode ONCE so an encoded traversal is seen, and
  // refuse a value that still contains a percent-escape afterwards rather than
  // decoding in a loop, which is how double-encoding bugs are built.
  if (text.includes('%')) {
    let decoded;
    try { decoded = decodeURIComponent(text); } catch { return fail('That path is not valid text.'); }
    if (decoded.includes('%')) return fail('That path is encoded more than once.');
    text = decoded;
  }
  if (/^[a-zA-Z]:/.test(text)) return fail('A drive letter is not a path inside the share.');
  if (text.startsWith('/') || text.startsWith('\\')) return fail('An absolute path is not allowed.');
  const parts = text.split(/[/\\]+/).filter((p) => p !== '' && p !== '.');
  const out = [];
  for (const p of parts) {
    if (p === '..') return fail('A path may not step outside the folder it is given.');
    const seg = cleanSegment(p);
    if (!seg.ok) return seg;
    out.push(seg.value);
  }
  return { ok: true, value: out };
}

/* The one way to turn a relative path into something on disk.
 *
 * Returns { ok, full, relative, segments }. `relative` is the CLEANED path —
 * callers record and return that rather than what they were sent, so what is
 * audited is what was used. */
function resolve(root, relative, { mustExist = false } = {}) {
  const parts = segments(relative);
  if (!parts.ok) return parts;
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return fail('The file share is not reachable.'); }
  const full = path.resolve(realRoot, ...parts.value);

  /* Realpath the deepest existing ancestor and judge THAT. A symlink in the
     existing part is resolved here and, if it points out of the share, the
     prefix test below fails — which is the symlink-escape case. */
  let probe = full;
  let existing = null;
  while (true) {
    try { existing = fs.realpathSync(probe); break; } catch { /* not there yet */ }
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (existing === null) return fail('The file share is not reachable.');
  if (existing !== realRoot && !existing.startsWith(realRoot + path.sep)) {
    return fail('That path is outside the file share.');
  }
  // The tail that does not exist yet cannot contain a symlink, because it does
  // not exist — but it can still contain a separator trick, and segments()
  // already refused those.
  const tail = path.relative(probe, full);
  const resolved = tail ? path.join(existing, tail) : existing;
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    return fail('That path is outside the file share.');
  }
  if (mustExist && !fs.existsSync(resolved)) return fail('That folder or file is not there.');
  return {
    ok: true,
    full: resolved,
    relative: parts.value.join('/'),
    segments: parts.value,
  };
}

/* Is `relative` inside `prefix` (or equal to it)? Prefix matching on SEGMENTS,
   not on the string: "Alpha" must not match "Alpha Reserves". */
function within(relative, prefix) {
  const a = String(relative || '').split('/').filter(Boolean);
  const b = String(prefix || '').split('/').filter(Boolean);
  if (b.length === 0) return true;             // the whole root
  if (a.length < b.length) return false;
  // Case-insensitively, because the share may be NTFS, where "alpha" and
  // "Alpha" are the same folder and a case-sensitive test would be a bypass.
  return b.every((seg, i) => seg.toLowerCase() === a[i].toLowerCase());
}

/* The name to store under when the name is taken: "render.psd" -> "render (2).psd".
   Never an overwrite, and never a silent one either — the caller returns the
   stored name so the page can say what it was saved as. */
function collisionName(name, n) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}

module.exports = {
  INCOMING, MAX_SEGMENT, MAX_RELATIVE, RESERVED, HIDDEN,
  cleanSegment, segments, resolve, within, isHidden, collisionName,
};
