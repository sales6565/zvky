/* The two path rules Forge needs, stated on this side of the wall.
 *
 * WHY THIS IS NOT A require('../gateway/src/paths').
 *
 * The gateway is a separate package, installed by IT on an office machine, and
 * scripts/build-godaddy-zip.sh ships app.js, package.json, src, public and sql
 * — not gateway/. A require across that line would work in this repository, in
 * every test, and on nobody's production server: the first Server-tab request
 * on GoDaddy would be MODULE_NOT_FOUND. So Forge keeps the rules it needs here,
 * and the duplication is PINNED rather than hoped about — tests/server-tab.test.js
 * asserts these behave identically to gateway/src/paths for the same inputs,
 * including the cases that matter (case folding, segment boundaries, traversal).
 *
 * Only two rules are needed on this side, because Forge never touches a file:
 *
 *   within()   — is this path inside a prefix this person was granted? Used
 *                when minting a token, so a path the client sent is checked
 *                before it is signed. The gateway checks it again.
 *   cleanName() — is this a usable single folder name? Used by the mapping
 *                editor in Settings, so an impossible folder name is refused
 *                where somebody can see the message.
 */

/* Segment-wise and case-insensitive. Case matters: a share on NTFS treats
   "alpha" and "Alpha" as one folder, so a case-sensitive containment test would
   let "alpha/../Beta"-style reasoning — or simply a differently-cased prefix —
   slip past. Segment-wise matters too: "Alpha" must not contain
   "Alpha Reserves". */
function within(relative, prefix) {
  const a = String(relative === undefined || relative === null ? '' : relative).split('/').filter(Boolean);
  const b = String(prefix === undefined || prefix === null ? '' : prefix).split('/').filter(Boolean);
  if (b.length === 0) return true;                 // '' is the whole root
  if (a.length < b.length) return false;
  return b.every((seg, i) => seg.toLowerCase() === a[i].toLowerCase());
}

const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);
const ILLEGAL = /[\u0000-\u001f\u007f<>:"|?*\\/]/;
const MAX_SEGMENT = 180;

function cleanName(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  if (!text) return { ok: false, reason: 'A name is required.' };
  if (text === '.' || text === '..') return { ok: false, reason: `"${text}" is not a name.` };
  if (ILLEGAL.test(text)) return { ok: false, reason: `"${text}" contains a character that cannot be used in a file name.` };
  const trimmed = text.replace(/[. ]+$/g, '');
  if (!trimmed) return { ok: false, reason: `"${text}" is not a name.` };
  if (trimmed.length > MAX_SEGMENT) return { ok: false, reason: `That name is ${trimmed.length} characters; the limit is ${MAX_SEGMENT}.` };
  const base = trimmed.includes('.') ? trimmed.slice(0, trimmed.indexOf('.')) : trimmed;
  if (RESERVED.has(base.toLowerCase())) return { ok: false, reason: `"${trimmed}" is a name Windows reserves for a device.` };
  return { ok: true, value: trimmed };
}

/* A client-supplied relative path, cleaned into segments or refused. Forge uses
   this before signing a token, so a traversal never reaches the signature. */
function cleanRelative(relative) {
  const raw = String(relative === undefined || relative === null ? '' : relative);
  if (raw.length > 1000) return { ok: false, reason: `That path is ${raw.length} characters; the limit is 1000.` };
  let text = raw;
  if (text.includes('%')) {
    let decoded;
    try { decoded = decodeURIComponent(text); } catch { return { ok: false, reason: 'That path is not valid text.' }; }
    if (decoded.includes('%')) return { ok: false, reason: 'That path is encoded more than once.' };
    text = decoded;
  }
  if (/^[a-zA-Z]:/.test(text)) return { ok: false, reason: 'A drive letter is not a path inside the share.' };
  if (text.startsWith('/') || text.startsWith('\\')) return { ok: false, reason: 'An absolute path is not allowed.' };
  const parts = text.split(/[/\\]+/).filter((p) => p !== '' && p !== '.');
  const out = [];
  for (const p of parts) {
    if (p === '..') return { ok: false, reason: 'A path may not step outside the folder it is given.' };
    const seg = cleanName(p);
    if (!seg.ok) return seg;
    out.push(seg.value);
  }
  return { ok: true, value: out.join('/'), segments: out };
}

module.exports = { within, cleanName, cleanRelative, MAX_SEGMENT, RESERVED };
