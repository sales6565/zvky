// WHERE CHAT ATTACHMENTS REALLY LIVE, and why it is not where they used to.
//
// ===========================================================================
// THE BUG THIS FILE EXISTS FOR. Files uploaded into chat were disappearing in
// under an hour, reported as "file is no longer available", while the retention
// said twelve hours and every retention test passed. The arithmetic was not
// wrong this time: the BYTES were being removed by something that has no idea
// what a retention is.
//
// They were stored at <app>/uploads/chat — inside the deployed application
// directory. On cPanel the application directory is what a deploy REPLACES: the
// documented step in DEPLOY-GODADDY.md is to upload the zip into the app folder
// and extract it, and the ways people actually do that — clearing the folder
// first, a fresh extract beside it and a rename, cPanel's own Git deployment
// into a clean checkout — all take the upload folder with them. Passenger then
// restarts the app, and on shared hosting it restarts the app anyway, several
// times a day, whenever the process has been idle. The rows survive, because
// they are in the database; the bytes do not, because they were in the folder
// that just got replaced.
//
// So the fix is not in the sweeper. The fix is that the upload root is OUTSIDE
// the application directory, is configured rather than derived, and is checked
// at startup — because a storage root that is silently wrong looks exactly like
// a retention that is silently wrong, and the studio spent two bug reports
// finding that out.
//
// WHAT IS REFUSED, AND WHY REFUSING IS THE KIND THING. A root inside the app
// directory, inside a temp directory, relative, missing or not writable makes
// chat REFUSE NEW UPLOADS, with a sentence naming the variable to set. That is
// a worse afternoon than accepting them — and a much better one than the
// alternative, which is accepting them, showing them, and losing them on the
// next restart. Reads are never refused: existing files go on being served,
// from the old location as well as the new one.
//
// NOTHING IS EVER MOVED OR DELETED. The one-time catch-up COPIES what is still
// in the old location for rows that have not expired. The originals stay where
// they are. A migration that deletes the only copy of somebody's file to tidy
// up is not a migration anybody should be asked to run in production.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/* The deployed application directory, and the place chat files used to go.
   __dirname rather than process.cwd(): Passenger starts the app with a working
   directory that is not reliably the app root, and a storage path that moves
   when the working directory moves is the same class of bug one layer down. */
const APP_DIR = path.resolve(__dirname, '..');
const LEGACY_DIR = path.join(APP_DIR, 'uploads', 'chat');

const ENV_NAME = 'CHAT_UPLOAD_DIR';

/* The exact line the owner pastes into cPanel. Held here so the startup log,
   the settings panel and the README cannot drift from each other. */
const CPANEL_HINT = `${ENV_NAME} = /home/<cpanel-account>/zvky-chat-uploads`;

/* EVERY DIRECTORY THE SYSTEM CONSIDERS SCRATCH. os.tmpdir() reads TMPDIR and
   falls back to /tmp, so both are listed: a host that sets TMPDIR to something
   else must not thereby make /tmp acceptable. /dev/shm is in the list because
   it is memory — a reboot empties it and nothing warns you. */
function tempRoots() {
  const list = [os.tmpdir(), '/tmp', '/var/tmp', '/usr/tmp', '/dev/shm',
    process.env.TMPDIR, process.env.TMP, process.env.TEMP];
  const out = [];
  for (const dir of list) {
    if (!dir) continue;
    try { out.push(path.resolve(dir)); } catch { /* unusable, so not a root */ }
  }
  return [...new Set(out)];
}

/* Is `child` the same directory as `parent`, or inside it? With the separator
   appended, so a sibling whose name merely starts with the parent's — /home/app
   against /home/apple — cannot pass. */
function insideOf(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

/* CAN THIS DIRECTORY BE WRITTEN TO? Asked by writing, not by reading a mode
   bit: the answer wanted is "will an upload land here", and on shared hosting
   the owner, the group and the mount all have opinions that st_mode does not
   settle. The probe file is removed again whatever happens. */
function writable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(probe); } catch { /* never existed, or already gone */ }
  }
}

/* WHERE THE ROOT IS SUPPOSED TO BE, before any of it is checked.
 *
 * Three sources, in this order, and each one is reported so the settings panel
 * can say WHY the root is what it is:
 *
 *   env     — CHAT_UPLOAD_DIR, which is what a correctly configured deployment
 *             uses and what the README tells the owner to set.
 *   home    — $HOME/zvky-chat-uploads, used when the variable is unset. On
 *             cPanel $HOME is /home/<account> and the app lives in a folder
 *             under it, so this is outside the app, outside temp, and survives
 *             a deploy. It is a FALLBACK and not the recommendation: it keeps a
 *             studio that upgrades without reading the notes working instead of
 *             refusing every upload on the morning of the deploy.
 *   legacy  — <app>/uploads/chat, reached only when there is no usable home
 *             either. It is reported as a problem and uploads are refused.
 */
function intended(env = process.env) {
  const configured = String(env[ENV_NAME] || '').trim();
  if (configured) return { source: 'env', raw: configured };
  const home = String(env.HOME || '').trim();
  if (home && path.isAbsolute(home)) {
    const candidate = path.join(path.resolve(home), 'zvky-chat-uploads');
    /* A home directory that CONTAINS the app is the normal cPanel shape and is
       fine — the deploy replaces the app folder, not its parent. A home that is
       itself inside the app, or inside temp, is not. */
    if (!insideOf(candidate, APP_DIR) && !tempRoots().some((t) => insideOf(candidate, t))) {
      return { source: 'home', raw: candidate };
    }
  }
  return { source: 'legacy', raw: LEGACY_DIR };
}

/* THE PROBLEMS, as a list rather than a boolean, because the settings panel
   prints them and "the upload root is wrong" is not something anybody can act
   on. Each entry has a code for the tests to assert on and a sentence for the
   person reading the screen. */
function problemsFor(raw, { create = true } = {}) {
  const out = [];
  /* THE RAW VALUE IS WHAT IS TESTED FOR ABSOLUTENESS, not a resolved copy of
     it. The first version of this resolved the path before checking, so a
     relative 'uploads/chat' arrived here already absolute — resolved against
     the working directory, which is the app folder — and was reported as
     "inside the application folder". A true answer about the wrong thing: the
     fault is that the value is relative, and where it happens to land today
     depends on which directory Passenger started the process in. */
  if (!path.isAbsolute(String(raw))) {
    out.push({ code: 'relative',
      message: `The chat upload folder must be an absolute path; ${JSON.stringify(String(raw))} is `
        + 'relative, and a relative path is read against whatever directory the application '
        + 'happened to start in, which on this host is not reliably the application folder. '
        + CPANEL_HINT });
    return out;                                    // nothing else is answerable
  }
  const resolved = path.resolve(String(raw));
  if (insideOf(resolved, APP_DIR)) {
    out.push({ code: 'inside-app',
      message: 'The chat upload folder is inside the application folder, which a deploy replaces. '
        + 'Files stored there are lost on the next deploy or restart. Move it outside the '
        + `application folder: ${CPANEL_HINT}` });
  }
  for (const temp of tempRoots()) {
    if (insideOf(resolved, temp)) {
      out.push({ code: 'temp',
        message: `The chat upload folder is inside a temporary directory (${temp}), which the host `
          + 'clears without warning. Move it outside: ' + CPANEL_HINT });
      break;
    }
  }
  let exists = fs.existsSync(resolved);
  if (!exists && create) {
    /* CREATED RATHER THAN REFUSED, when the parent allows it. A missing folder
       on a fresh deployment is the normal case, not a misconfiguration, and
       mkdir is exactly what the owner would do by hand. If it cannot be made,
       THAT is the problem worth reporting. */
    try { fs.mkdirSync(resolved, { recursive: true }); exists = true; } catch { exists = false; }
  }
  if (!exists) {
    out.push({ code: 'missing',
      message: `The chat upload folder ${resolved} does not exist and could not be created. `
        + 'Create it in cPanel → File Manager and make it writable by the application.' });
    return out;
  }
  if (!writable(resolved)) {
    out.push({ code: 'not-writable',
      message: `The chat upload folder ${resolved} is not writable by the application. `
        + 'Check its permissions in cPanel → File Manager.' });
  }
  return out;
}

/* THE ANSWER, COMPUTED ONCE PER PROCESS and refreshable.
 *
 * Once, because every upload and every read asks for it and a write probe on
 * each would be a filesystem round trip per request. Refreshable, because the
 * settings panel is the screen somebody looks at WHILE fixing the permissions,
 * and a panel that cannot notice the fix is a panel that sends them to the
 * wrong conclusion. */
let cached = null;

function status({ refresh = false, env = process.env } = {}) {
  /* A SYNTHETIC ENVIRONMENT IS NEVER CACHED. config-check asks this with a
     made-up env to report on a configuration it has been handed, and a test
     asks it with several; letting one of those answers become the process-wide
     answer would mean a check about a hypothetical folder deciding where real
     uploads go. */
  const live = env === process.env;
  if (cached && !refresh && live) return cached;
  const want = intended(env);
  /* AND A HYPOTHETICAL ROOT IS NEVER CREATED, for the same reason: reporting on
     a folder must not make one. */
  const problems = problemsFor(want.raw, { create: live });
  const resolved = path.resolve(want.raw);
  const answer = {
    source: want.source,
    configured: want.source === 'env' ? want.raw : null,
    path: resolved,
    legacyPath: LEGACY_DIR,
    appDir: APP_DIR,
    problems,
    ok: problems.length === 0,
    /* THE LEGACY FOLDER IS ALWAYS READ FROM, whether or not it is the write
       root, and whether or not the write root is healthy. Files that are still
       there belong to messages people are reading today. */
    legacyExists: fs.existsSync(LEGACY_DIR),
    envName: ENV_NAME,
    hint: CPANEL_HINT,
  };
  if (live) cached = answer;
  return answer;
}

/* Where a NEW upload goes, or null when chat must refuse uploads. */
function writeRoot(opts) {
  const s = status(opts);
  return s.ok ? s.path : null;
}

/* Everywhere a file might be, newest location first. The legacy folder is
   second so a file copied forward is served from the new root and the old copy
   is only ever a fallback. */
function readRoots(opts) {
  const s = status(opts);
  const out = [s.path];
  if (s.legacyPath !== s.path) out.push(s.legacyPath);
  return out;
}

/* THE ONE-TIME CATCH-UP: copy, never move.
 *
 * What it is for: the deployment that has been running with files in
 * <app>/uploads/chat and is now configured properly. Whatever is still there
 * and still belongs to a live row is copied into the new root, so the switch
 * does not read as "every file sent before lunch has gone".
 *
 * IDEMPOTENT. A destination that already exists with the same size is left
 * alone — this runs on every startup, and a copy that redid itself every boot
 * would be a disk-filling job dressed as a repair.
 *
 * NEVER DELETES THE SOURCE, and the old folder goes on being read. If the copy
 * is wrong in some way nobody has thought of yet, the original is still there
 * to go back to.
 */
async function copyForward(db, { log = null } = {}) {
  const say = log || (() => {});
  const s = status();
  const out = { considered: 0, copied: 0, skipped: 0, failed: 0 };
  if (!s.ok || s.path === s.legacyPath || !s.legacyExists) return out;

  let names = [];
  try { names = await fsp.readdir(s.legacyPath); } catch { return out; }
  if (!names.length) return out;

  /* ONLY WHAT A LIVE ROW CLAIMS. A file in the old folder with no row is an
     orphan of some earlier accident; copying it forward would be carrying
     somebody's rubbish between houses. */
  const { rows } = await db.query(
    `SELECT stored_name AS storedName FROM chat_attachments
      WHERE deleted_at IS NULL AND stored_name IS NOT NULL
        AND (expires_at IS NULL OR expires_at > NOW())`
  ).catch(() => ({ rows: [] }));
  const live = new Set(rows.map((r) => path.basename(String(r.storedName))));
  if (!live.size) return out;

  for (const name of names) {
    if (name !== path.basename(name)) continue;          // never a path, only a name
    if (!live.has(name)) continue;
    out.considered += 1;
    const from = path.join(s.legacyPath, name);
    const to = path.join(s.path, name);
    try {
      const src = await fsp.stat(from);
      if (!src.isFile()) { out.considered -= 1; continue; }
      let already = null;
      try { already = await fsp.stat(to); } catch { already = null; }
      if (already && already.size === src.size) { out.skipped += 1; continue; }
      /* COPYFILE_EXCL is not used: a destination of the WRONG size is a half
         copy from a run that was interrupted, and finishing it is the point. */
      await fsp.copyFile(from, to);
      out.copied += 1;
    } catch (err) {
      out.failed += 1;
      say(`[chat] could not copy ${name} forward from the old upload folder: ${err.message}`);
    }
  }
  if (out.copied || out.failed) {
    say(`[chat] upload folder catch-up — ${out.copied} file(s) copied from ${s.legacyPath} to `
      + `${s.path}, ${out.skipped} already there, ${out.failed} failed. Nothing was deleted.`);
  }
  return out;
}

/* WHAT THE STARTUP LOG SAYS. Loud when it is wrong, one line when it is right:
   the owner reads this file's output exactly once, on the morning of a deploy,
   and that is the morning it has to be unmissable. */
function describeAtStartup(log = console.log) {
  const s = status({ refresh: true });
  if (s.ok) {
    log(`[chat] attachment uploads → ${s.path} (from ${s.source === 'env' ? s.envName
      : s.source === 'home' ? '$HOME, because ' + s.envName + ' is not set' : 'the application folder'}).`);
    return s;
  }
  log('[chat] ================================================================');
  log('[chat] CHAT UPLOADS ARE REFUSED: the upload folder is not usable.');
  for (const p of s.problems) log(`[chat]   - ${p.message}`);
  log(`[chat]   Set this in cPanel → Setup Node.js App → Environment variables:`);
  log(`[chat]       ${s.hint}`);
  log('[chat]   Existing files are still served; only new uploads are refused.');
  log('[chat] ================================================================');
  return s;
}

module.exports = {
  APP_DIR, LEGACY_DIR, ENV_NAME, CPANEL_HINT,
  status, writeRoot, readRoots, copyForward, describeAtStartup,
  // exported for the tests and for the health panel's own checks
  insideOf, tempRoots, problemsFor, intended,
  reset: () => { cached = null; },
};
