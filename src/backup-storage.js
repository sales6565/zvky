/* WHERE BACKUP PACKAGES ARE KEPT, and why the answer is not "next to the app".
 *
 * ===========================================================================
 * THIS IS src/chat-storage.js's RULE, APPLIED TO A DIFFERENT KIND OF FILE.
 *
 * That module decides where chat attachments live and refuses the three places
 * that lose files: a relative path (read against whatever directory Passenger
 * started the process in), a path inside the application folder (replaced by the
 * next deploy), and a path inside a temporary directory (cleared by the host
 * without warning). Every one of those reasons applies at least as strongly to
 * a backup, so the shape of this file deliberately mirrors that one: the same
 * insideOf(), the same write probe, the same problems-as-a-list-with-codes, the
 * same cached-but-refreshable status.
 *
 * It is a separate module rather than a parameter to that one because the two
 * answer about different environment variables, have different fallbacks and
 * have one rule that is not shared: a backup folder must also not be inside the
 * CHAT UPLOAD folder, or a backup would contain a copy of the previous backup
 * through files/, growing by its own size every night.
 *
 * ===========================================================================
 * NO FALLBACK TO A PATH INSIDE THE APP, which is where this parts company with
 * chat-storage.
 *
 * Chat uploads fall back to <app>/uploads/chat as a last resort, because a
 * studio that upgrades without reading the notes should keep working rather
 * than have every upload refused. A backup is the opposite case: one written
 * inside the app folder is destroyed by the deploy that a restore would be
 * needed after, and a backup you believe in and cannot use is worse than no
 * backup at all. So the fallback is $HOME/zvky-backups and nothing further; if
 * that is not usable the feature refuses to run and says why.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* The deployed application directory. __dirname and not process.cwd(), for the
   reason chat-storage gives: Passenger's working directory is not reliably the
   app root, and a storage path that moves with it is the same bug one layer
   down. */
const APP_DIR = path.resolve(__dirname, '..');

const ENV_NAME = 'BACKUP_DIR';
const DEFAULT_LEAF = 'zvky-backups';

/* The exact line the owner pastes into cPanel → Setup Node.js App. Held here so
   the startup log, the Settings panel, the doctor and the README cannot drift. */
const CPANEL_HINT = `${ENV_NAME} = /home/<cpanel-account>/${DEFAULT_LEAF}`;

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
   appended, so a sibling whose name merely starts with the parent's —
   /home/app against /home/apple — cannot pass. */
function insideOf(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

/* CAN THIS DIRECTORY BE WRITTEN TO? Asked by writing, not by reading a mode bit:
   the question is "will a package land here", and on shared hosting the owner,
   the group and the mount all have opinions that st_mode does not settle. */
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

/* WHERE THE FOLDER IS SUPPOSED TO BE, before any of it is checked. Two sources,
   each reported so the panel can say WHY the folder is what it is. */
function intended(env = process.env) {
  const configured = String(env[ENV_NAME] || '').trim();
  if (configured) return { source: 'env', raw: configured };
  const home = String(env.HOME || '').trim();
  if (home && path.isAbsolute(home)) {
    const candidate = path.join(path.resolve(home), DEFAULT_LEAF);
    /* A home directory that CONTAINS the app is the normal cPanel shape and is
       fine — the deploy replaces the app folder, not its parent. A home that is
       itself inside the app, or inside temp, is not. */
    if (!insideOf(candidate, APP_DIR) && !tempRoots().some((t) => insideOf(candidate, t))) {
      return { source: 'home', raw: candidate };
    }
  }
  /* NO THIRD SOURCE. See the note at the top: there is no acceptable place
     inside the application folder, so an unusable home is a refusal. */
  return { source: 'none', raw: '' };
}

/* The problems, as a list with codes for the tests and sentences for the screen. */
function problemsFor(raw, { create = true, env = process.env } = {}) {
  const out = [];
  const value = String(raw === undefined || raw === null ? '' : raw);

  if (!value.trim()) {
    out.push({ code: 'unset',
      message: `No backup folder is configured and no usable home directory was found. Set ${ENV_NAME} `
        + `to an absolute path outside the application folder: ${CPANEL_HINT}` });
    return out;
  }

  /* THE RAW VALUE IS WHAT IS TESTED FOR ABSOLUTENESS, not a resolved copy —
     chat-storage learned this the hard way. Resolving first turns a relative
     'backups' into an absolute path under the working directory and reports it
     as "inside the application folder": a true answer about the wrong thing.
     The fault is that the value is relative. */
  if (!path.isAbsolute(value)) {
    out.push({ code: 'relative',
      message: `The backup folder must be an absolute path; ${JSON.stringify(value)} is relative, and a `
        + 'relative path is read against whatever directory the application happened to start in, '
        + `which on this host is not reliably the application folder. ${CPANEL_HINT}` });
    return out;                                      // nothing else is answerable
  }

  const resolved = path.resolve(value);

  if (insideOf(resolved, APP_DIR)) {
    out.push({ code: 'inside-app',
      message: 'The backup folder is inside the application folder, which a deploy replaces. The '
        + 'backups would be destroyed by exactly the event that makes you need them. Move it '
        + `outside the application folder: ${CPANEL_HINT}` });
  }

  for (const temp of tempRoots()) {
    if (insideOf(resolved, temp)) {
      out.push({ code: 'temp',
        message: `The backup folder is inside a temporary directory (${temp}), which the host clears `
          + `without warning. Move it outside: ${CPANEL_HINT}` });
      break;
    }
  }

  /* NOT INSIDE THE CHAT UPLOADS, AND NOT THE OTHER WAY ROUND. The backup copies
     the app's own stored files, chat attachments among them; if the two folders
     nest either way the package ends up containing the previous package and
     grows by its own size every night. Checked both directions because either
     nesting produces it. */
  const chatRoot = String(env.CHAT_UPLOAD_DIR || '').trim();
  if (chatRoot && path.isAbsolute(chatRoot)) {
    const chat = path.resolve(chatRoot);
    if (insideOf(resolved, chat) || insideOf(chat, resolved)) {
      out.push({ code: 'nests-uploads',
        message: `The backup folder and the chat upload folder (${chat}) are inside one another. Each `
          + 'backup would contain the previous one and grow by its own size every night. Give them '
          + 'separate folders.' });
    }
  }

  let exists = fs.existsSync(resolved);
  if (!exists && create) {
    /* Created rather than refused when the parent allows it: a missing folder on
       a fresh deployment is the normal case, and mkdir is what the owner would
       do by hand. If it cannot be made, THAT is worth reporting. */
    try { fs.mkdirSync(resolved, { recursive: true }); exists = true; } catch { exists = false; }
  }
  if (!exists) {
    out.push({ code: 'missing',
      message: `The backup folder ${resolved} does not exist and could not be created. Create it in `
        + 'cPanel → File Manager and make it writable by the application.' });
    return out;
  }
  if (!writable(resolved)) {
    out.push({ code: 'not-writable',
      message: `The backup folder ${resolved} is not writable by the application. Check its `
        + 'permissions in cPanel → File Manager.' });
  }
  return out;
}

/* THE ANSWER, COMPUTED ONCE PER PROCESS AND REFRESHABLE — chat-storage's
   reasoning exactly: every list and every download asks, so a write probe per
   request would be a filesystem round trip each time; and the Settings panel is
   the screen somebody is looking at WHILE fixing the permissions, so it has to
   be able to notice the fix. */
let cached = null;

function status({ refresh = false, env = process.env } = {}) {
  /* A SYNTHETIC ENVIRONMENT IS NEVER CACHED. config-check and the tests ask
     about configurations they have been handed; letting one of those answers
     become the process-wide one would be a bug that only shows up later. */
  const synthetic = env !== process.env;
  if (cached && !refresh && !synthetic) return cached;

  const want = intended(env);
  const problems = problemsFor(want.raw, { create: true, env });
  const answer = {
    dir: want.raw ? path.resolve(String(want.raw)) : null,
    raw: want.raw,
    source: want.source,
    envName: ENV_NAME,
    hint: CPANEL_HINT,
    ok: problems.length === 0,
    problems,
  };
  if (!synthetic) cached = answer;
  return answer;
}

/* THE ONE PLACE THAT TURNS A STORED FILENAME INTO A PATH ON DISK.
 *
 * ===========================================================================
 * NO CALLER EVER BUILDS A BACKUP PATH, and that is the whole point of this
 * function existing rather than being three path.join() calls.
 *
 * The web layer is handed a backup ID from the URL, looks the row up, and gets
 * the FILENAME from the database — never from the request. This then refuses
 * anything that is not a plain filename, so even a stored row that somehow held
 * "../../etc/passwd" cannot escape the folder. Two independent reasons a
 * traversal cannot happen, because one of them is a code-review promise and the
 * other is a function.
 */
function resolveName(filename) {
  const name = String(filename === undefined || filename === null ? '' : filename);
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    const err = new Error('A backup file name must be a plain file name with no directory part.');
    err.code = 'BACKUP_BAD_NAME';
    throw err;
  }
  const here = status();
  if (!here.ok || !here.dir) {
    const err = new Error(here.problems.map((p) => p.message).join(' '));
    err.code = 'BACKUP_DIR_INVALID';
    throw err;
  }
  return path.join(here.dir, name);
}

/* Free space where the packages go, in bytes. statfs is in Node 18.15+ and
   19.6+; a host without it reports null and the caller treats "unknown" as
   "cannot check" rather than as "plenty". */
function freeBytes(dir) {
  const target = dir || (status().dir);
  if (!target) return null;
  try {
    const st = fs.statfsSync(target);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return null;
  }
}

/* What the startup log says, in one line, the way chat-storage does it. */
function describeAtStartup(log = console.log) {
  const here = status();
  if (here.ok) {
    log(`[backup] packages go to ${here.dir} (${here.source === 'env' ? ENV_NAME : 'home directory default'}).`);
    return here;
  }
  log(`[backup] NOT CONFIGURED — backups will be refused. ${here.problems.map((p) => p.message).join(' ')}`);
  return here;
}

module.exports = {
  APP_DIR, ENV_NAME, CPANEL_HINT, DEFAULT_LEAF,
  status, problemsFor, intended, resolveName, freeBytes, describeAtStartup,
  insideOf, tempRoots, writable,
};
