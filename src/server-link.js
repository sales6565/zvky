/* THE PROJECT'S SERVER LINK, AND EVERY PATH COMPUTED FROM IT.
 *
 * ===========================================================================
 * ONE RULE, IN ONE PLACE. A project's link is typed by a person, in the same
 * notation they already paste into the submit form — \\SERVER\Projects\Hero, or
 * /mnt/projects/Hero. Everything else in this feature is derived from it:
 *
 *   the prefix        set once in Settings; the share the gateway's FILE_ROOT
 *                     points at, written the way the studio writes it
 *   the project link  the prefix plus at least one segment
 *   the relative path what the gateway is told: the link minus the prefix
 *   the upload path   <project>/<discipline>/<person>/<files>
 *
 * The gateway never sees a link. It sees a relative path under FILE_ROOT, and
 * only ever one computed here — a path that arrives from a browser is ignored.
 *
 * ===========================================================================
 * WHY THE PAGE HAS A SECOND COPY OF validateLink, and why that is not two rules.
 *
 * The page has to say "that is not under the prefix" as somebody types, and it
 * cannot call this module: scripts/build-godaddy-zip.sh ships src/ to the host
 * and public/index.html to the browser, and there is no build step that could
 * put one into the other. So the page carries the same rule and
 * tests/server-link.test.js runs BOTH against one shared matrix of cases,
 * including every case that decides an acceptance. If either drifts, the test
 * fails naming the input they disagree about.
 *
 * The page's copy is a courtesy. This one decides: nothing is stored or
 * uploaded on the strength of what the browser thought.
 */
const paths = require('./server-paths');

/* Slash-normalised and case-folded, for comparison only.
 *
 * A studio writes \\SERVER\Projects and a person pastes //SERVER/projects/ or
 * \\server\Projects\ — the same place, four ways. Comparison folds the
 * separators and the case and drops trailing separators; the link itself is
 * STORED EXACTLY AS TYPED, because there is no normal form for a UNC path that
 * is still a path somebody can paste into Explorer. That is the same bargain
 * src/submission-link.js already makes, for the same reason. */
const fold = (text) => String(text === undefined || text === null ? '' : text)
  .trim()
  .replace(/[\\/]+/g, '/')
  .replace(/\/+$/, '')
  .toLowerCase();

/* The segments of a link after its prefix, or a refusal.
 *
 * Deliberately NOT a URL parse: a link may be a UNC path, a Windows path or a
 * POSIX path, and only one of the five shapes submission-link.js accepts is a
 * URL at all. What matters here is only "is it under the prefix, and what comes
 * after" — so this is string work on folded copies, and the stored value is
 * untouched. */
function relativeOf(link, prefix) {
  const foldedPrefix = fold(prefix);
  if (!foldedPrefix) return { ok: false, reason: 'no-prefix' };
  const foldedLink = fold(link);
  if (!foldedLink) return { ok: false, reason: 'empty' };
  if (foldedLink === foldedPrefix) return { ok: false, reason: 'prefix-only' };
  if (!foldedLink.startsWith(`${foldedPrefix}/`)) return { ok: false, reason: 'outside-prefix' };

  /* The tail is taken from the ORIGINAL text, not the folded copy, so the
     folder names keep the case they were typed in — which matters on a share
     that displays them and on one that distinguishes them. The slice length is
     computed on the folded strings, which are the same length as the originals
     only when the separators were already single; so the tail is recovered by
     counting separators rather than by index arithmetic. */
  const originalParts = String(link).trim().split(/[\\/]+/).filter((p) => p !== '');
  const prefixParts = String(prefix).trim().split(/[\\/]+/).filter((p) => p !== '');
  const tail = originalParts.slice(prefixParts.length);
  if (!tail.length) return { ok: false, reason: 'prefix-only' };
  return { ok: true, segments: tail };
}

const REASONS = {
  'no-prefix': 'No server link prefix has been set in Settings → Server, so a link cannot be checked yet.',
  empty: 'Paste the project\u2019s folder link from the file server.',
  'prefix-only': 'That is the prefix itself. Add the project\u2019s own folder after it.',
  'outside-prefix': null,     // composed, because it names the prefix
};

/* Is this a link this studio will accept for a project?
 *
 * Refuses: anything not under the prefix, the prefix alone, "..", an empty
 * segment, and a segment ending in a dot or a space — the last because Windows
 * silently strips those when creating the folder and then cannot open it by the
 * name it was given, so a link containing one points at a folder that cannot
 * exist. Everything else about a name is the share's business, not ours. */
function validateLink(link, prefix) {
  const text = String(link === undefined || link === null ? '' : link).trim();
  if (text.length > 2048) return { ok: false, error: 'That link is longer than 2048 characters.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, error: 'That link contains a line break or a control character.' };
  }
  const rel = relativeOf(text, prefix);
  if (!rel.ok) {
    return {
      ok: false,
      reason: rel.reason,
      error: rel.reason === 'outside-prefix'
        ? `A project link has to start with ${String(prefix).trim()} — that is the share the office file server serves.`
        : REASONS[rel.reason],
    };
  }
  for (const segment of rel.segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: 'dots', error: 'A project link cannot contain ".." or ".".' };
    }
    if (/[. ]$/.test(segment)) {
      return {
        ok: false,
        reason: 'trailing',
        error: `"${segment}" ends in a dot or a space, which Windows cannot keep. Rename the folder or correct the link.`,
      };
    }
    const clean = paths.cleanName(segment);
    if (!clean.ok) return { ok: false, reason: 'segment', error: clean.reason };
  }
  return { ok: true, link: text, relative: rel.segments.join('/'), segments: rel.segments };
}

/* THE ONE FUNCTION THAT ANSWERS "where is this project on the share".
 *
 * Everything that needs a project's folder calls this and nothing recomputes
 * it: the Server tab's listing, the token mint, the upload path, the folder
 * check in the project form. It returns null for a project with no link, which
 * is every project in production and the state in which this feature is simply
 * not available for it. */
function projectFolderRel(project, prefix) {
  if (!project || !project.server_link) return null;
  const out = validateLink(project.server_link, prefix);
  return out.ok ? out.relative : null;
}

/* A person's own folder name: their display name, made safe, and then FIXED.
 *
 * Assigned on the first upload and stored on the account, because the point of
 * it is that a person's work is in one place — renaming the account must not
 * start a second folder. The collision suffix is a piece of the account id
 * rather than a counter, so two people called Alex Kim get stable, different
 * folders without a sequence to keep. */
/* The Latin letters NFKD cannot help with.
 *
 * Decomposition turns "ü" into "u" plus a mark, which the line below drops —
 * but "ø" is not a composed character, so it survives decomposition and then
 * falls foul of the \w filter. "Søren Ødegård" became "S ren degard", which is
 * nobody's name and would be that person's folder for ever. Small, explicit,
 * and only the letters that actually need it. */
const TRANSLITERATE = {
  ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss',
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th',
  ħ: 'h', Ħ: 'H', ı: 'i', İ: 'I', ŋ: 'n', Ŋ: 'N',
};

function userFolderName(name, id) {
  const base = String(name === undefined || name === null ? '' : name)
    .replace(/[øØæÆœŒßłŁđĐðÐþÞħĦıİŋŊ]/g, (c) => TRANSLITERATE[c] || c)
    /* NFKD, and then the combining marks REMOVED rather than replaced.
       Decomposing "Müller" gives "Mu" + a combining diaeresis, and turning that
       mark into a space produced "Mu ller" — a folder with a space in the
       middle of somebody's name. Accents are dropped so the name survives a
       share that cannot keep them; the letters stay where they were. */
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  const clean = paths.cleanName(base);
  if (clean.ok) return clean.value;
  return `user-${String(id || '').slice(0, 8)}`;
}

const withSuffix = (folder, id) => `${folder} (${String(id || '').slice(0, 4)})`;

/* The discipline folder for an asset, from its CATEGORY.
 *
 * The category list is the studio's and ships EMPTY, so there is no fixed set
 * to map: the mapping is category key → folder name, edited in Settings, with
 * one fallback for every category that has no entry and for an asset with no
 * category at all. Art → Artist and Animation → Animator are seeded because
 * those are the two words the studio used, and both are editable.
 *
 * NOT ROLE-BASED, deliberately: a 3D artist animating a rig this fortnight is
 * doing animation, and the folder should say what the work is rather than what
 * the person's designation says they usually do. */
function disciplineFolder(categoryKey, { folders = {}, fallback = 'Work' } = {}) {
  const key = String(categoryKey === undefined || categoryKey === null ? '' : categoryKey).trim().toLowerCase();
  const named = key && folders[key];
  const chosen = String(named || fallback || 'Work').trim();
  const clean = paths.cleanName(chosen);
  return clean.ok ? clean.value : 'Work';
}

/* THE UPLOAD PATH, COMPUTED HERE AND NOWHERE ELSE.
 *
 * <project folder>/<discipline>/<person>[/<subfolder the browser dragged>]
 *
 * The caller passes the project, the asset's category, the person's stored
 * folder and — for a dragged folder — the relative subpath of the file within
 * it. A path from the browser is NEVER used as the destination: only the
 * subfolder part is taken from it, and every segment of that goes through the
 * same name rules as everything else. */
function uploadPathFor({ project, prefix, categoryKey, userFolder, subPath = '', discipline = {} }) {
  const base = projectFolderRel(project, prefix);
  if (!base) return { ok: false, reason: 'no-link', error: 'That project has no server link yet.' };
  if (!userFolder) return { ok: false, reason: 'no-user-folder', error: 'That account has no server folder yet.' };
  const segments = [base, disciplineFolder(categoryKey, discipline), userFolder];
  if (subPath) {
    const sub = paths.cleanRelative(subPath);
    if (!sub.ok) return { ok: false, reason: 'bad-subpath', error: sub.reason };
    if (sub.value) segments.push(sub.value);
  }
  const joined = segments.filter(Boolean).join('/');
  const checked = paths.cleanRelative(joined);
  if (!checked.ok) return { ok: false, reason: 'bad-path', error: checked.reason };
  return {
    ok: true,
    relative: checked.value,
    // What the gateway may create, and no higher: the project folder must
    // already exist, and the two below it are made lazily on first upload.
    existingPrefix: base,
    createBelow: [disciplineFolder(categoryKey, discipline), userFolder].join('/'),
  };
}

/* The link to put in the submit form once an upload has finished. The prefix as
   the studio wrote it, plus the relative path — so it reads exactly like a link
   somebody pasted by hand, and passes src/submission-link.js unchanged. */
function linkFor(prefix, relative) {
  const raw = String(prefix === undefined || prefix === null ? '' : prefix).trim().replace(/[\\/]+$/, '');
  if (!raw) return null;
  // The separator the prefix itself uses, so a UNC link stays a UNC link and a
  // POSIX path stays a POSIX path. A link half in backslashes is nobody's path.
  const sep = raw.includes('\\') ? '\\' : '/';
  const tail = String(relative || '').split('/').filter(Boolean).join(sep);
  return tail ? `${raw}${sep}${tail}` : raw;
}

/* Warnings a project manager may accept: another project on the same link, or
   one whose folder contains or sits inside this one. Never a refusal — two
   projects sharing a parent is a real arrangement, and the manager can see what
   they are agreeing to. */
function overlapWarnings(relative, others) {
  const out = [];
  const mine = String(relative || '').toLowerCase();
  if (!mine) return out;
  for (const other of others || []) {
    const theirs = String(other.relative || '').toLowerCase();
    if (!theirs) continue;
    if (theirs === mine) { out.push({ kind: 'duplicate', project: other.name }); continue; }
    if (mine.startsWith(`${theirs}/`)) out.push({ kind: 'inside', project: other.name });
    else if (theirs.startsWith(`${mine}/`)) out.push({ kind: 'contains', project: other.name });
  }
  return out;
}

module.exports = {
  fold, relativeOf, validateLink, projectFolderRel,
  userFolderName, withSuffix, disciplineFolder, uploadPathFor, linkFor, overlapWarnings,
  DEFAULT_DISCIPLINES: { art: 'Artist', animation: 'Animator' },
  DEFAULT_FALLBACK: 'Work',
};
