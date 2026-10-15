/* One folder at a time, and never a recursive walk.
 *
 * A studio share has folders with tens of thousands of files in them and a
 * "size of this folder" that takes a minute to compute. So this reads exactly
 * one directory, sorts folders before files, and pages. No recursion means a
 * listing cannot become a tree walk over the whole share because somebody
 * clicked the wrong thing — and it means the token can name one folder and have
 * that be the whole of what the call can see.
 *
 * WHAT IS HIDDEN. .incoming (the gateway's own scratch), dot-files, and the
 * four names Windows leaves lying around. They are not secrets; they are noise
 * that would make the page look broken. Hiding them also means .incoming is not
 * browsable, so a half-finished upload is never something to click on.
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const MAX_PAGE = 500;

function list(root, relative, { offset = 0, limit = 200 } = {}) {
  const target = paths.resolve(root, relative, { mustExist: true });
  if (!target.ok) return target;
  let stat;
  try { stat = fs.statSync(target.full); } catch { return { ok: false, reason: 'That folder is not there.' }; }
  if (!stat.isDirectory()) return { ok: false, reason: 'That is a file, not a folder.' };

  let entries;
  try { entries = fs.readdirSync(target.full, { withFileTypes: true }); } catch (err) {
    return { ok: false, reason: err.code === 'EACCES' ? 'The gateway may not read that folder.' : 'That folder could not be read.' };
  }

  const rows = [];
  for (const e of entries) {
    if (paths.isHidden(e.name)) continue;
    /* A symlink is reported as what it points at only if that is still inside
       the share — otherwise it is skipped entirely rather than shown as a
       broken row, because a row the page offers and the download route then
       refuses is worse than no row. */
    let kind = e.isDirectory() ? 'folder' : (e.isFile() ? 'file' : null);
    let size = null;
    let modified = null;
    const full = path.join(target.full, e.name);
    if (e.isSymbolicLink()) {
      const inside = paths.resolve(root, [target.relative, e.name].filter(Boolean).join('/'), { mustExist: true });
      if (!inside.ok) continue;
      try {
        const s = fs.statSync(inside.full);
        kind = s.isDirectory() ? 'folder' : 'file';
      } catch { continue; }
    }
    if (!kind) continue;
    try {
      const s = fs.statSync(full);
      modified = s.mtime.toISOString();
      if (kind === 'file') size = s.size;
    } catch { continue; }
    rows.push({ name: e.name, type: kind, size, modified });
  }

  rows.sort((a, b) => (a.type === b.type
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : (a.type === 'folder' ? -1 : 1)));

  const from = Math.max(0, Number(offset) || 0);
  const take = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 200));
  const page = rows.slice(from, from + take);
  return {
    ok: true,
    path: target.relative,
    entries: page,
    total: rows.length,
    offset: from,
    limit: take,
    // So the page knows whether to ask again rather than guessing from lengths.
    more: from + page.length < rows.length,
  };
}

module.exports = { list, MAX_PAGE };
