// Files sent in chat, and their twelve hours.
//
// These are not studio records. A screenshot pasted into a conversation to ask
// "is this the right blue" has done its job by the afternoon, and keeping it
// for ever would fill a shared-hosting disk with the least valuable bytes in
// the application. So a chat attachment expires twelve hours after it was
// uploaded and the bytes are deleted. The MESSAGE stays: see the note on
// chat_attachments in src/migrate.js for why the row outlives the file.
//
// WHERE THEY LIVE. On this server's own disk, in the folder src/chat-storage.js
// resolves — OUTSIDE the deployed application directory, because the second bug
// report about vanishing files was this: they were under <app>/uploads/chat,
// and a cPanel deploy replaces the application directory. See the long note at
// the top of src/chat-storage.js. Not through the office-server transfer
// pipeline either: sending a file on a round trip to another building to
// archive it, when the thing being archived is deleted before the end of the
// working day, buys latency and a second thing that can fail for nothing.
//
// EXPIRY IS DECIDED BY THE CLOCK, NOT BY THE SWEEP. `expires_at` is written at
// upload; every read compares it against now. The sweep only reclaims disk.
// That ordering matters: if the sweep is late, has crashed, or is running on
// another worker, an expired file is still refused rather than served — the
// promise is "gone after the retention", and a promise that depends on a timer
// having fired is not one worth making.
//
// AND THE CLOCK IS THE DATABASE'S, EVERYWHERE. This is the whole of the fix for
// a bug that deleted files in four hours instead of twelve.
//
// What went wrong: `expires_at` was written from Node as a JS Date, which the
// driver renders as a wall clock in the NODE process's timezone, while
// `created_at` is written by MariaDB's CURRENT_TIMESTAMP as a wall clock in the
// DATABASE SESSION's timezone. Two columns in the same row, in two different
// zones, neither of them saying which. A boot migration then overwrote
// expires_at with `created_at + INTERVAL 12 HOUR`, which replaced Node's
// rendering with the database's — and the sweep went on comparing it against a
// Node-rendered now. The lifetime became 12h + (dbOffset − nodeOffset): on a
// database session at -08:00 with a Node process on UTC, exactly four hours.
// Measured, not deduced; see tests/chat-attachment-expiry.test.js.
//
// So no instant is ever converted here. NOW() writes it, NOW() compares it, and
// what comes back to a caller is a number of SECONDS from the database's own
// now — the same shape src/work-log.js uses for every stamp it reads, and for
// the same reason. The only assumption left is that the database agrees with
// itself, which is not an assumption.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { v4: uuid } = require('uuid');
const multer = require('multer');

const storageRoot = require('./chat-storage');

/* THE OLD CONSTANT'S NAME, ANSWERING THE NEW QUESTION. Everything in this file
   used to read CHAT_DIR, a path fixed at require time; it is now a getter over
   src/chat-storage.js, which decides the folder from configuration and can be
   asked again after somebody fixes a permission. A function rather than a
   constant on purpose: a captured path is how a process comes to write into a
   folder that was replaced underneath it. */
function chatDir() {
  const s = storageRoot.status();
  /* The legacy folder when the configured one is unusable — not to WRITE into
     (uploads are refused; see acceptingUploads) but so every read, sweep and
     path check in this file still has a root to resolve against and goes on
     serving the files that are already there. */
  return s.ok ? s.path : s.legacyPath;
}

/* The six formats the studio asked for, plus .jpeg.
 *
 * .jpeg is the same format as .jpg under a different extension, and it is what
 * a phone and several export dialogs produce. Refusing it would be refusing a
 * JPEG for spelling, which reads as a bug to whoever hits it. Nothing else is
 * added — this list is short on purpose, and every entry is something a browser
 * can display or play inline. */
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.mov', '.mp4'];

// What the studio was told: the six, without the alias.
const ADVERTISED = '.png, .jpg, .svg, .webp, .mov, .mp4';

const MAX_BYTES = 30 * 1024 * 1024;

/* Twelve hours, which covers a working day and the evening after it — eight
   was cutting off a file sent in the morning before the person who needed it
   came back from a shoot.
   
   THE DEFAULT, NOT THE RULE, since Prompt 58. The studio's retention is a Super
   Admin setting (src/chat-settings.js); this is what a deployment that has
   never visited that screen gets, and what the setting falls back to while the
   mirror is still loading at boot.
   
   The environment override stays for the tests, which otherwise prove the
   expiry works by waiting twelve hours. */
const DEFAULT_HOURS = Number(process.env.CHAT_ATTACHMENT_HOURS || 12);
const SWEEP_MINUTES = Number(process.env.CHAT_SWEEP_MINUTES || 10);

/* How old a file with no row has to be before the disk pass takes it. An upload
   in flight has bytes on disk and no row yet; this is longer than that gap by a
   wide margin and shorter than anything anybody waits for. */
const ORPHAN_GRACE_MS = 15 * 60 * 1000;

/* THE STUDIO'S RETENTION, read fresh on every use rather than captured.
 *
 * Required lazily: chat-settings does not require this module back, but the
 * settings mirror is loaded during the migration run and this file is required
 * by the migration, so a top-level require here would be a cycle that resolves
 * to an empty object on one of the two paths. */
function retentionHours() {
  try {
    const n = Number(require('./chat-settings').attachmentRetentionHours());
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* not migrated yet, or mid-boot — fall through */ }
  return DEFAULT_HOURS;
}


/* The type the file is SERVED as, derived from its extension rather than from
 * what the browser claimed when uploading. multer's file.mimetype is a client
 * assertion: it is whatever the sender's browser said, and a file named .png
 * arriving as text/html is not a case to hand back to the next person's
 * browser. The extension is already the gate; this makes it the answer too. */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
};

/* SVG is the one entry on the list that is a program.
 *
 * An .svg can carry <script>, and a browser runs it when the SVG is the top
 * level document — which is exactly what happens when somebody opens the file
 * in a new tab. On this application's own origin that is stored cross-site
 * scripting with the sender's choice of payload, reaching whoever clicks it.
 *
 * It is NOT a risk in an <img> tag, where scripts never run, and that is how
 * the panel displays it. The danger is only the direct link, so the direct
 * link is served as a download rather than as a page: Content-Disposition
 * attachment, nosniff, and a sandbox CSP as a third latch. The file is still
 * fully usable — it downloads and opens in a design tool — it just never
 * executes inside this app's origin.
 *
 * Kept as a predicate rather than an `if` at the route, so adding another
 * scriptable format to EXTENSIONS later lands here rather than being missed. */
const SCRIPTABLE = new Set(['.svg']);
const isScriptable = (fileName) => SCRIPTABLE.has(path.extname(String(fileName || '')).toLowerCase());

function ensureDir() {
  const dir = chatDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* MAY CHAT TAKE A NEW UPLOAD AT ALL? The storage module's verdict, asked here
   so the route and multer cannot disagree about it. */
const acceptingUploads = () => storageRoot.status().ok;

const storage = multer.diskStorage({
  /* REFUSES RATHER THAN WRITES SOMEWHERE DOOMED. The route checks this first
     and answers with the sentence and the variable name; this is the second
     latch, for any future caller that forgets to. */
  destination: (req, file, cb) => {
    if (!acceptingUploads()) {
      const s = storageRoot.status();
      const err = new Error('Chat attachments cannot be stored on this server right now: '
        + `${s.problems[0].message}`);
      err.status = 503;
      return cb(err);
    }
    cb(null, ensureDir());
  },
  /* Stored under a generated name, never the sender's. The original is kept in
     the database column and shown in the panel; using it on disk would let a
     file called ../../app.js decide where it lands. */
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (EXTENSIONS.includes(ext)) return cb(null, true);
    const err = new Error(
      `“${file.originalname}” is a ${ext || 'file with no extension'}, which chat does not carry. Allowed: ${ADVERTISED}.`
    );
    err.status = 400;
    cb(err);
  },
});

/* THE SELECT EVERY READER USES, so no caller ever parses a stored stamp.
 *
 * `expiresInSeconds` is how long this attachment has left according to the
 * DATABASE's clock — positive while it lives, zero or negative once it is
 * past. That is the figure the page counts down from and the figure isExpired()
 * reads, and it is a DIFFERENCE, so whatever zone the session is in cancels
 * out of it. The same shape src/work-log.js reads every stamp through.
 *
 * NULL expires_at reads as expired, which is the safe way round: a row with no
 * deadline is a row the backfill could not date, and refusing to serve it is
 * better than serving it for ever. */
/* AND A NULL expires_at IS NOT "ALREADY EXPIRED" ANY MORE.
 *
 * It used to be, and the note above said that was the safe way round. It is
 * not: a row with no deadline is a row the backfill has not reached, and
 * refusing to serve it means a column somebody forgot to fill deletes — from
 * the reader's point of view — every file in the studio at once. That is the
 * same failure as the one this prompt is about, reached through a different
 * door, and it reads as the same thing on screen.
 *
 * So a NULL deadline is taken to be `created_at + the retention`, which is what
 * the row WOULD have said had it been stamped. The migration backfills it
 * properly; this is what the application does in the meanwhile, and it errs
 * towards keeping somebody's file rather than towards hiding it. */
const expirySelect = (alias = 'a') =>
  `TIMESTAMPDIFF(SECOND, NOW(), COALESCE(${alias}.expires_at, `
  + `${alias}.created_at + INTERVAL ${Number(retentionHours())} HOUR)) AS expiresInSeconds`;

/* Has this attachment's time run out?
 *
 * deleted_at means the sweep has already been here. A non-positive
 * expiresInSeconds means it should have been and may not have run yet. Both are
 * "expired" to everything above this line, which is what keeps the guarantee
 * independent of the timer.
 *
 * NOTHING IS PARSED. The old version did `new Date(row.expires_at)` against
 * Date.now(), which is precisely the mixture that caused the four-hour bug: it
 * read a wall clock written in one zone as though it were in another. */
function isExpired(row) {
  if (!row) return true;
  if (row.deletedAt || row.deleted_at) return true;
  const left = row.expiresInSeconds;
  /* NULL ONLY REACHES HERE FROM A ROW THAT WAS NOT READ THROUGH expirySelect(),
     which COALESCEs a missing stamp into created_at + the retention. A caller
     that hands this function a row it built itself gets the cautious answer. */
  if (left === null || left === undefined) return true;
  return Number(left) <= 0;
}

/* What the browser is told about one attachment.
 *
 * An expired one keeps its name and size and loses everything that could be
 * used to fetch it. The panel needs the name to say WHICH file expired — "a
 * file" is a worse placeholder than "brief-v2.png" — and there is nothing
 * sensitive in a filename that the person reading was not already shown. */
function shape(row) {
  const expired = isExpired(row);
  const left = Number(row.expiresInSeconds);
  return {
    id: row.id,
    fileName: row.fileName || row.file_name,
    byteSize: Number(row.byteSize || row.byte_size) || 0,
    mime: row.mime || null,
    expired,
    /* HOW LONG IS LEFT, not WHEN it goes. A number of seconds from the
       database's own now is the one form of this that cannot be misread: an
       instant would have to be rendered in some zone, and the page would have
       to guess which. The page turns it into "Expires in 3h 20m" against its
       own clock, which is right to within the round trip. */
    expiresInSeconds: Number.isFinite(left) ? Math.max(0, left) : null,
    kind: kindOf(row.fileName || row.file_name),
    /* Only ever offered while the file is really there. A URL for an expired
       attachment would be a link that 404s, which is a worse way to say
       "expired" than saying it. */
    url: expired ? null : `/api/chat/attachments/${row.id}`,
    downloadOnly: isScriptable(row.fileName || row.file_name),
  };
}

// How the panel should show it: inline picture, inline video, or a plain row.
function kindOf(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.mov' || ext === '.mp4') return 'video';
  if (EXTENSIONS.includes(ext)) return 'image';
  return 'file';
}

// ------------------------------------------------------------------- storing

async function record(db, { messageId, file }) {
  const id = uuid();
  const ext = path.extname(file.originalname).toLowerCase();
  /* COMPUTED ONCE, BY THE DATABASE, at upload — `NOW() + INTERVAL n HOUR`.
   *
   * Not a JS Date. The driver would render one as a wall clock in the Node
   * process's zone, and created_at beside it is a wall clock in the database
   * session's zone; two columns in one row in two zones is the whole of the
   * four-hour bug. The retention is interpolated rather than bound because
   * MariaDB will not take a placeholder inside INTERVAL — it is an integer this
   * module has already validated, and String() on a checked integer is the
   * narrowest thing that works. */
  const hours = retentionHours();
  await db.query(
    `INSERT INTO chat_attachments (id, message_id, file_name, mime, byte_size, stored_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL ${Number(hours)} HOUR)`,
    [id, messageId, String(file.originalname).slice(0, 255), MIME[ext] || null,
      Number(file.size) || 0, file.filename]
  );
  return id;
}

/* One attachment, for serving — but only to somebody in its conversation.
 *
 * The membership join is in this query rather than checked by the route,
 * because an attachment id is a bearer token otherwise: guessable or not, a
 * URL that serves the bytes to anybody who holds it is a URL that gets pasted
 * into another conversation. There is no way to call this without a userId. */
/* ONE PLACE THAT TURNS A ROW INTO EITHER BYTES OR A REASON.
 *
 * ===========================================================================
 * THREE ANSWERS WHERE THERE USED TO BE ONE, which is half of what Prompt 59 is
 * about. "This file is no longer available." was returned for a swept file, for
 * a file missing from disk, and for a file whose folder had been replaced by a
 * deploy — three completely different situations, one of them normal and two of
 * them faults, all wearing the same sentence. The studio read that sentence and
 * reported a retention bug, twice, because the message said the file had aged
 * out when what had actually happened was that the bytes were gone.
 *
 * So each cause now says what it is, and the one that should never happen also
 * writes itself down (chat_file_incidents) with everything the next report will
 * need: which attachment, when it was uploaded, when it expires, what the time
 * is now, and the path that was looked for.
 */
const STATE = {
  expired: 'expired',
  missing: 'missing_file',
  noAccess: 'no_access',
  notFound: 'not_found',
  unavailable: 'storage_unavailable',
};

/* Where the bytes for this stored_name really are, across every root.
 *
 * TWO ROOTS, NEWEST FIRST: the configured upload folder, then the old one
 * inside the application directory. A deployment that has just been configured
 * properly has months of files in the old place, and a reader does not care
 * which folder a file is in. */
function locate(storedName) {
  const raw = String(storedName || '');
  if (!raw) return null;
  if (raw !== path.basename(raw)) return null;         // never a path, only a name
  for (const root of storageRoot.readRoots()) {
    const full = path.join(path.resolve(root), raw);
    try { if (fs.statSync(full).isFile()) return full; } catch { /* try the next root */ }
  }
  return null;
}

/* THE FAULT NOBODY SHOULD SEE, WRITTEN DOWN WHERE SOMEBODY CAN.
 *
 * A row that says the file is live, and no file. Logged to the console for
 * whoever is watching, and recorded in a table so the Super Admin health panel
 * can say "nine of these in the last week, the most recent at 14:02" — which is
 * the difference between a bug report that says "files keep vanishing" and one
 * that can be acted on. Never throws: a diagnostic that can break the request
 * it is diagnosing is worse than no diagnostic. */
async function recordMissing(db, row, { where = 'download' } = {}) {
  const left = Number(row.expiresInSeconds);
  const detail = `attachment ${row.id} (${row.fileName || 'unnamed'}) is live but its file is not on `
    + `disk. ${Number.isFinite(left) ? `${Math.round(left / 60)} minute(s) of retention left` : 'no expiry recorded'}`
    + `, stored_name ${JSON.stringify(String(row.storedName || ''))}, roots tried: `
    + `${storageRoot.readRoots().join(', ')}, read from ${where}.`;
  try { console.warn(`[chat] MISSING FILE — ${detail}`); } catch { /* no console */ }
  try {
    await db.query(
      `INSERT INTO chat_file_incidents (id, attachment_id, kind, detail) VALUES ($1,$2,$3,$4)`,
      [uuid(), row.id, 'missing_before_expiry', detail.slice(0, 500)]
    );
  } catch { /* not migrated yet, or the table is gone — the console line stands */ }
}

async function forDownload(db, attachmentId, userId) {
  /* THE MEMBERSHIP IS ITS OWN COLUMN, NOT A JOIN THAT HIDES THE ROW.
   *
     It used to be an inner join, so "there is no such attachment" and "you are
     not in that conversation" came back as the same 404 — deliberately, so a
     caller could not learn that an id exists. Prompt 59 asks for the three
     states to be told apart, and they are: an attachment id is a version-4
     UUID, so anybody in a position to ask about one was given it by somebody
     who could see it. What is NOT disclosed is anything about the file or the
     conversation — only that this person may not have it. */
  const { rows } = await db.query(
    `SELECT a.id, a.file_name AS fileName, a.mime, a.byte_size AS byteSize,
            a.stored_name AS storedName, ${expirySelect('a')}, a.deleted_at AS deletedAt,
            (SELECT COUNT(*) FROM chat_members me
              WHERE me.conversation_id = msg.conversation_id AND me.user_id = $2) AS mine
       FROM chat_attachments a
       JOIN chat_messages msg ON msg.id = a.message_id
      WHERE a.id = $1`,
    [attachmentId, userId]
  );
  if (!rows.length) return { ok: false, status: 404, state: STATE.notFound, error: 'No such file.' };
  const row = rows[0];
  if (!Number(row.mine)) {
    return { ok: false, status: 403, state: STATE.noAccess,
      error: 'You do not have access to this file.' };
  }
  if (isExpired(row)) {
    return { ok: false, status: 410, state: STATE.expired,
      error: `This file has expired. Chat files are deleted ${retentionHours()} hours after they are sent.` };
  }
  const full = row.storedName ? locate(row.storedName) : null;
  if (!full) {
    await recordMissing(db, row, { where: 'download' });
    return { ok: false, status: 410, state: STATE.missing,
      error: 'This file is missing on the server, which is not expected. Please tell your '
        + 'administrator — the details have been recorded.' };
  }
  const ext = path.extname(row.fileName || '').toLowerCase();
  return {
    ok: true,
    path: full,
    fileName: row.fileName,
    contentType: MIME[ext] || 'application/octet-stream',
    scriptable: isScriptable(row.fileName),
  };
}

/* The same file, for the Chat Activity screen, WITHOUT the membership join.
 *
 * Written as its own function rather than as a flag on forDownload(), and named
 * so the call site cannot be misread: a reader glancing at
 * `forDownload(db, id, userId)` sees an authorisation argument, and a reader
 * glancing at `forOversight(db, id)` sees that there is none. A boolean
 * parameter would have made the safe call and the unsafe one look alike.
 *
 * The authorisation for this one is the route's — settings.chat_activity — and
 * nothing else. It is deliberately not exported to anything the chat router
 * imports.
 *
 * EXPIRY IS UNCHANGED. Oversight does not extend the life of a file: this asks
 * the same isExpired() the panel asks, and returns the same 410 once the twelve
 * hours are up. A screen that could still fetch what everybody else had lost
 * would be a retention policy nobody wrote down. */
async function forOversight(db, attachmentId) {
  const { rows } = await db.query(
    `SELECT a.id, a.file_name AS fileName, a.mime, a.byte_size AS byteSize,
            a.stored_name AS storedName, ${expirySelect('a')}, a.deleted_at AS deletedAt
       FROM chat_attachments a
      WHERE a.id = $1`,
    [attachmentId]
  );
  if (!rows.length) return { ok: false, status: 404, state: STATE.notFound, error: 'No such file.' };
  const row = rows[0];
  if (isExpired(row)) {
    return { ok: false, status: 410, state: STATE.expired,
      error: `This file has expired. Chat files are deleted ${retentionHours()} hours after they are sent.` };
  }
  const full = row.storedName ? locate(row.storedName) : null;
  if (!full) {
    await recordMissing(db, row, { where: 'oversight' });
    return { ok: false, status: 410, state: STATE.missing,
      error: 'This file is missing on the server, which is not expected. Please tell your '
        + 'administrator — the details have been recorded.' };
  }
  const ext = path.extname(row.fileName || '').toLowerCase();
  return {
    ok: true,
    path: full,
    fileName: row.fileName,
    contentType: MIME[ext] || 'application/octet-stream',
    scriptable: isScriptable(row.fileName),
  };
}

// ------------------------------------------------------------------ sweeping

/* Reclaim the disk. Two passes, because they catch different things.
 *
 * By ROW: every attachment past its expiry that still has bytes. This is the
 * ordinary case and the one that updates the message to show a placeholder.
 *
 * By DISK: files in the directory that NO LIVE ROW CLAIMS. This is the
 * backstop, and it is not paranoia — an upload whose message insert failed
 * leaves a file with no row at all, and a group deleted when its last member
 * left takes its attachment rows with it through ON DELETE CASCADE while
 * leaving the files behind. Neither is reachable from the table.
 *
 * WHAT THE DISK PASS USED TO DO, AND WHY IT HAD TO CHANGE. It deleted every
 * file older than the retention by mtime, whatever the database said. While the
 * retention was a constant that matched, this was invisible. The moment it
 * became a setting it was a second, hidden policy: raise retention to 48 hours
 * and the rows would say 48 while this pass went on deleting the bytes at 12,
 * leaving a live attachment whose file was gone. So it now asks which files are
 * claimed and removes only the rest — the orphans it was always for.
 *
 * ONE CLOCK, THE DATABASE'S. `expires_at <= NOW()` and `deleted_at = NOW()`,
 * both evaluated by the server that stored the column. Nothing is rendered from
 * a JS Date and nothing is parsed back into one; see the note at the top of
 * this file for the bug that comes of mixing them.
 *
 * IDEMPOTENT AND SAFE ON SEVERAL WORKERS. The row pass selects only rows with
 * deleted_at IS NULL and the UPDATE narrows on the same condition, so two
 * workers racing the same row produce one write and one no-op. A file another
 * worker already removed raises ENOENT, which is the outcome wanted rather than
 * an error.
 */
/* THE CIRCUIT BREAKERS, and the reasoning for having any.
 *
 * ===========================================================================
 * A SWEEPER IS THE MOST DANGEROUS LOOP IN THIS APPLICATION. Everything else
 * here either writes a row or refuses; this deletes people's files, and it does
 * so unattended, every ten minutes, in a process nobody is watching. Two bug
 * reports about vanishing attachments have already arrived. Neither turned out
 * to be this loop — but "we read the code and it looked right" is what was said
 * the first time, so it now has limits that do not depend on anybody's reading.
 *
 * MORE THAN HALF IN ONE RUN, AND ANY OF THEM YOUNGER THAN THE RETENTION, AND IT
 * DOES NOTHING. Both halves are needed, and the second one took a test failure
 * to find.
 *
 *   The share alone was the brief, and the share alone is wrong. A studio that
 *   sent four screenshots on Tuesday and nothing on Wednesday has four expired
 *   attachments and no live ones; "more than half" is then every ordinary
 *   overnight sweep in a small studio, and a guard that refuses those refuses
 *   for ever — the same files are still there on the next pass, so nothing is
 *   ever reclaimed and the Super Admin is told about it every ten minutes.
 *   Found by two existing sweeper cases going red.
 *
 *   What a MISCONFIGURATION looks like, and an expiry never does, is a file
 *   being deleted before it has lived as long as the retention. Twelve read as
 *   twelve minutes does that. A clock jumped forward does that. A column
 *   restamped by a bad migration does that. An honest twelve-hour expiry cannot:
 *   the row was stamped twelve hours ago.
 *
 * So the test is "a large share of everything, AND at least one of them is
 * younger than the retention it was supposedly kept for". The one false
 * positive left is the morning after somebody RAISES the retention, when rows
 * stamped under the old shorter one expire while being younger than the new
 * longer one; that delays their deletion by at most the retention and keeps the
 * bytes, which is the safe direction to be wrong in.
 *
 * AN IMPLAUSIBLE RETENTION AND IT DOES NOTHING. Under an hour cannot be set
 * through the screen (the minimum is 1), so a retention under an hour means
 * something is reading the number wrong — which is the exact shape of "12 was
 * read as 12 minutes". It is also the one case where the sweeper would be
 * deleting files that, as far as the people who sent them are concerned, have
 * only just arrived.
 *
 * BOTH TELL THE SUPER ADMIN, in the application, through the notification
 * channel every other administrative event already uses. A guard that trips
 * silently has converted a visible disaster into an invisible one. */
const RUNAWAY_SHARE = 0.5;
const MIN_PLAUSIBLE_HOURS = 1;

async function liveAttachmentCount(db) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM chat_attachments WHERE deleted_at IS NULL'
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(rows[0].n) || 0;
}

/* THE ALARM. Written to the incident table and raised in-app to everybody who
   holds the retention permission — which is the Super Admin by default and
   whoever they have given it to. Required lazily: notifications requires its
   way down to the database and this module is required by the migration. */
async function alarm(db, { kind, detail, log }) {
  (log || console.error)(`[chat] ${detail}`);
  try {
    await db.query(
      'INSERT INTO chat_file_incidents (id, attachment_id, kind, detail) VALUES ($1,$2,$3,$4)',
      [uuid(), null, kind, String(detail).slice(0, 500)]
    );
  } catch { /* not migrated — the log line and the notification stand */ }
  try {
    const rolePermissions = require('./role-permissions');
    const notifications = require('./notifications');
    const admins = await rolePermissions.usersWithPermission(db, 'settings.chat_retention')
      .catch(() => []);
    for (const admin of admins) {
      await notifications.raise(db, {
        recipientId: admin.id || admin.user_id || admin,
        actorId: null,
        kind: notifications.KINDS.chat_storage,
        detail,
      }).catch(() => null);
    }
  } catch { /* a notification that cannot be raised must not stop the guard */ }
}

/* `hours` IS A SEAM, NOT A SETTING. It defaults to the studio's retention and
   nothing in the application passes it; the guard test passes a quarter of an
   hour, because the retention CANNOT currently be below one through any
   configuration — chat-settings replaces an invalid stored value with twelve
   before this code ever sees it. The guard is therefore a backstop against a
   future reader of that number getting it wrong, which is exactly the bug that
   has now been reported twice in two different forms, and a backstop that
   cannot be exercised is a backstop nobody should trust. */
async function sweep(db, { log = null, hours: hoursOverride = null } = {}) {
  /* ids IS ON THE OBJECT FROM THE START, so a halted run has the same shape as
     a completed one. A caller reading `out.ids.length` should not have to know
     which of the early returns it got. */
  const removed = { rows: 0, files: 0, orphans: 0, refused: 0, halted: null, ids: [] };
  const deleted = removed.ids;

  /* THE RETENTION GUARD FIRST, because it decides whether this run should
     happen at all rather than how much of it should. */
  const hours = hoursOverride === null ? retentionHours() : Number(hoursOverride);
  if (!(Number(hours) >= MIN_PLAUSIBLE_HOURS)) {
    removed.halted = 'retention';
    await alarm(db, { kind: 'sweep_halted_retention', log,
      detail: `Chat attachment sweep refused to run: the retention reads ${hours} hour(s), which is `
        + 'below the one-hour minimum the settings screen allows. Nothing was deleted. This usually '
        + 'means the retention is being read in the wrong unit or the setting did not load.' });
    return removed;
  }

  const { rows } = await db.query(
    /* THE SAME DEADLINE THE READERS USE, COALESCE and all: a row with no stamp
       is treated as created_at + the retention here too. The old predicate
       skipped NULL rows entirely, which paired with a read path that called
       them expired — so their bytes stayed on disk for ever while the panel
       told everybody the file had gone. One expression, one answer.
       
       `tooYoung` comes back with each row for the runaway guard: it is 1 when
       the row is being deleted before it has lived as long as the retention,
       which a correctly stamped expiry cannot be. */
    `SELECT id, stored_name AS storedName,
            created_at > NOW() - INTERVAL ${Number(hours)} HOUR AS tooYoung
       FROM chat_attachments
      WHERE deleted_at IS NULL
        AND COALESCE(expires_at, created_at + INTERVAL ${Number(hours)} HOUR) <= NOW()`
  ).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''))) return { rows: [] };
    throw err;
  });

  /* AND THE RUNAWAY GUARD, against the live total as it is NOW — before
     anything in this run has been deleted. */
  if (rows.length) {
    const young = rows.filter((r) => Number(r.tooYoung) === 1);
    if (young.length) {
      const live = await liveAttachmentCount(db);
      if (live > 1 && rows.length > live * RUNAWAY_SHARE) {
        removed.halted = 'runaway';
        await alarm(db, { kind: 'sweep_halted_runaway', log,
          detail: `Chat attachment sweep refused to run: it would have deleted ${rows.length} of `
            + `${live} live attachments (over ${Math.round(RUNAWAY_SHARE * 100)}%) in one pass, and `
            + `${young.length} of them ${young.length === 1 ? 'is' : 'are'} younger than the `
            + `${hours}-hour retention, which should not be possible. Nothing was deleted. Check `
            + 'the retention setting and the server clock.' });
        return removed;
      }
    }
  }

  for (const row of rows) {
    if (row.storedName) {
      const targets = targetsFor(row.storedName);
      if (!targets) {
        /* A stored_name that resolves outside the chat upload root is never
           followed. There is no legitimate way for one to exist, so this is
           reported rather than quietly skipped — and the row is left alone,
           because marking it deleted would hide the thing that needs looking
           at. */
        removed.refused += 1;
        (log || console.warn)(`[chat] refused to delete ${row.id}: stored path resolves outside the chat `
          + `upload root (${JSON.stringify(String(row.storedName).slice(0, 120))}).`);
        continue;
      }
      for (const full of targets) {
        if (await unlinkQuietly(full)) removed.files += 1;
      }
    }
    /* NARROWED ON deleted_at AGAIN, so the second worker's UPDATE matches
       nothing instead of restamping a row the first already finished. */
    const { result } = await db.query(
      'UPDATE chat_attachments SET deleted_at = NOW(), stored_name = NULL WHERE id = $1 AND deleted_at IS NULL',
      [row.id]
    );
    if (Number((result && result.affectedRows) || 0)) {
      removed.rows += 1;
      deleted.push(row.id);
    }
  }

  /* THE ORPHANS: on disk, claimed by no live row. Asked as one query rather
     than one per file, and only when there is something in the directory. */
  /* THE WRITE ROOT ONLY, NEVER THE OLD FOLDER. Files still in
     <app>/uploads/chat are the originals of whatever was copied forward, and
     this prompt's one hard rule about them is that nothing deletes them. */
  let names = [];
  const orphanRoot = storageRoot.status().ok ? storageRoot.status().path : null;
  if (orphanRoot) {
    try { names = await fsp.readdir(orphanRoot); } catch { names = []; }
  }
  if (names.length) {
    const claimed = new Set();
    /* IF THIS QUERY FAILS, THE PASS DOES NOT RUN.
     
       It used to be `.catch(() => ({ rows: [] }))`, which means: on any
       database error, treat every file on disk as claimed by nobody and delete
       the lot. One failed query — a dropped connection, a pool still warming up
       on the startup pass — and every chat file older than the fifteen-minute
       grace is gone, whatever the rows say. It never needed to be the cause of
       the reported bug to be worth removing; it only needed to be reachable.
       An empty answer and a failed answer are different things, and this is the
       loop where the difference is somebody's files. */
    let live;
    try {
      ({ rows: live } = await db.query(
        'SELECT stored_name AS storedName FROM chat_attachments WHERE stored_name IS NOT NULL'));
    } catch (err) {
      (log || console.warn)('[chat] skipped the orphan pass: could not read which files are still '
        + `claimed (${err.message}). Nothing on disk was touched.`);
      return removed;
    }
    for (const row of live) claimed.add(path.basename(String(row.storedName)));

    for (const name of names) {
      if (claimed.has(name)) continue;
      const full = insideChatDir(name);
      if (!full) { removed.refused += 1; continue; }
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile()) continue;
        /* A GRACE PERIOD, because an upload in flight has a file on disk and no
           row yet. A few minutes is longer than any write takes and shorter
           than anything anybody waits for. */
        if (Date.now() - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
        if (await unlinkQuietly(full)) removed.orphans += 1;
      } catch { /* vanished under us — the outcome wanted either way */ }
    }
  }
  return removed;
}

/* Where a stored_name really points, or null if that is not inside CHAT_DIR.
 *
 * basename() alone was the old guard and it is not enough on its own to be
 * worth relying on: it is one call away from somebody "improving" it into
 * join(CHAT_DIR, storedName), which a name like '../../etc/passwd' walks
 * straight out of. So the resolved path is checked against the resolved root,
 * with the separator on the end so that a sibling directory whose name merely
 * starts with the root's cannot pass. */
function insideChatDir(storedName, rootDir = null) {
  const raw = String(storedName || '');
  if (!raw) return null;
  /* THE RAW VALUE IS WHAT IS CHECKED, not a cleaned-up version of it.
   
     The first version of this called basename() and THEN checked the result
     was inside the root — which it always is, because basename() is what makes
     it so. A guard that sanitises its input before testing it can never fail,
     and the test written for it duly reported that nothing was refused. What a
     guard is for is noticing that a value is wrong, not quietly making it
     right: a row whose stored_name is '../something' is a row somebody needs
     to look at, and turning it into 'something' and deleting THAT file would
     be worse than either refusing or ignoring it. */
  const root = path.resolve(rootDir || chatDir());
  const full = path.resolve(root, raw);
  if (full === root) return null;
  if (!full.startsWith(root + path.sep)) return null;
  /* AND NOTHING NESTED EITHER. Every file this module writes goes straight
     into the root with a generated name, so a stored_name with a separator in
     it did not come from here. */
  if (raw !== path.basename(raw)) return null;
  return full;
}

/* EVERY PLACE THIS FILE COULD BE, for the row pass to delete from.
 *
 * BOTH ROOTS, and that is not the same decision as the orphan pass's. An
 * attachment that has EXPIRED must lose its bytes wherever they are, or the
 * retention is a promise about one folder; a file that is merely OLD must never
 * be deleted from the legacy folder, because it is the original of a copy and
 * this prompt's one hard rule about those is that nothing removes them. Expired
 * is the difference, and it is the row pass that knows it.
 *
 * Returns null — refused — for a stored_name that is not a bare filename, which
 * is the same guard as before, applied once rather than per root: the shape of
 * the name is what is wrong with it, not the folder it was resolved against. */
function targetsFor(storedName) {
  const roots = storageRoot.readRoots();
  const out = [];
  for (const root of roots) {
    const full = insideChatDir(storedName, root);
    if (!full) return null;
    out.push(full);
  }
  return out;
}

async function unlinkQuietly(full) {
  try { await fsp.unlink(full); return true; } catch { return false; }
}

/* Run it on a timer, and once at startup.
 *
 * The startup pass matters more than the timer: a process that was restarted —
 * a deploy, a crash, shared hosting recycling the app — comes back with files
 * that expired while it was down and no timer that ever fired for them.
 *
 * unref() so a stopped server is not held open by this. Tests start and stop
 * the app constantly, and an interval that keeps the event loop alive turns
 * every one of them into a timeout. */
function schedule(db, log = console.log) {
  const run = () => sweep(db, { log }).then((r) => {
    /* ONE LINE PER RUN THAT DID SOMETHING, with the count, the ids and why.
       A sweep that deleted nothing says nothing — this runs every ten minutes
       for the life of the process, and a log nobody can skim is a log nobody
       reads when it matters. */
    if (r.rows || r.orphans || r.refused) {
      const bits = [];
      if (r.rows) bits.push(`${r.rows} attachment(s) past their expiry: ${r.ids.join(', ')}`);
      if (r.orphans) bits.push(`${r.orphans} file(s) on disk claimed by no row`);
      if (r.refused) bits.push(`${r.refused} refused for resolving outside the upload root`);
      log(`[chat] swept — ${bits.join('; ')}. ${r.files + r.orphans} file(s) removed.`);
    }
  }).catch((err) => log(`[chat] sweep failed: ${err.message}`));

  run();
  const timer = setInterval(run, Math.max(1, SWEEP_MINUTES) * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  /* A GETTER FOR THE SAME REASON HOURS IS ONE: the folder is configuration now,
     and a module-level copy of it taken at require time is how a process comes
     to serve from a directory that no longer exists. */
  get CHAT_DIR() { return chatDir(); },
  EXTENSIONS, ADVERTISED, MAX_BYTES, MIME,
  DEFAULT_HOURS,
  retentionHours,
  /* A GETTER, not a captured number. Every caller that prints "deleted after N
     hours" already says `chatFiles.HOURS`, and the studio's retention is now a
     setting that can change while the process is running — so the name stays
     and what it answers follows the setting. A constant here is how a screen
     comes to say twelve while the server enforces forty-eight. */
  get HOURS() { return retentionHours(); },
  upload, record, forDownload, forOversight, shape, kindOf, isExpired, isScriptable,
  /* The shared expression, as a getter so every caller gets one built with the
     retention in force now rather than the one at require time. */
  get EXPIRY_SELECT() { return expirySelect('a'); },
  expirySelect,
  sweep, schedule,
  /* Prompt 59's additions: where the bytes are, whether chat may take any more,
     and the names the three refusal states go out under. */
  STATE, locate, targetsFor, acceptingUploads, liveAttachmentCount,
  RUNAWAY_SHARE, MIN_PLAUSIBLE_HOURS,
  storage: storageRoot,
};
