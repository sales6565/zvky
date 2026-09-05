// Files sent in chat, and their eight hours.
//
// These are not studio records. A screenshot pasted into a conversation to ask
// "is this the right blue" has done its job by the afternoon, and keeping it
// for ever would fill a shared-hosting disk with the least valuable bytes in
// the application. So a chat attachment expires eight hours after it was
// uploaded and the bytes are deleted. The MESSAGE stays: see the note on
// chat_attachments in src/migrate.js for why the row outlives the file.
//
// WHERE THEY LIVE. On this server's own disk, under uploads/chat, and not
// through the office-server transfer pipeline that carries thumbnails and
// exports. Sending a file on a round trip to another building to archive it,
// when the thing being archived is deleted before the end of the working day,
// buys latency and a second thing that can fail in exchange for nothing.
//
// EXPIRY IS DECIDED BY THE CLOCK, NOT BY THE SWEEP. `expires_at` is written at
// upload; every read compares it against now. The sweep only reclaims disk.
// That ordering matters: if the sweep is late, has crashed, or is running on
// another worker, an expired file is still refused rather than served — the
// promise is "gone after eight hours", and a promise that depends on a timer
// having fired is not one worth making.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { v4: uuid } = require('uuid');
const multer = require('multer');

const CHAT_DIR = path.join(__dirname, '..', 'uploads', 'chat');

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

/* Eight hours. Overridable because the alternative — proving the expiry works
   by waiting eight hours — is not a test anybody runs twice. */
const HOURS = Number(process.env.CHAT_ATTACHMENT_HOURS || 8);
const SWEEP_MINUTES = Number(process.env.CHAT_SWEEP_MINUTES || 10);

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
  if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true });
}
ensureDir();

const storage = multer.diskStorage({
  destination: (req, file, cb) => { ensureDir(); cb(null, CHAT_DIR); },
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

const expiryFor = (from = new Date()) => new Date(from.getTime() + HOURS * 60 * 60 * 1000);

/* Has this attachment's time run out?
 *
 * deleted_at means the sweep has already been here. expires_at in the past
 * means it should have been and may not have run yet. Both are "expired" to
 * everything above this line, which is what keeps the guarantee independent of
 * the timer. */
function isExpired(row, now = new Date()) {
  if (!row) return true;
  if (row.deletedAt || row.deleted_at) return true;
  const at = row.expiresAt || row.expires_at;
  if (!at) return true;
  return new Date(at).getTime() <= now.getTime();
}

/* What the browser is told about one attachment.
 *
 * An expired one keeps its name and size and loses everything that could be
 * used to fetch it. The panel needs the name to say WHICH file expired — "a
 * file" is a worse placeholder than "brief-v2.png" — and there is nothing
 * sensitive in a filename that the person reading was not already shown. */
function shape(row, now = new Date()) {
  const expired = isExpired(row, now);
  return {
    id: row.id,
    fileName: row.fileName || row.file_name,
    byteSize: Number(row.byteSize || row.byte_size) || 0,
    mime: row.mime || null,
    expired,
    expiresAt: row.expiresAt || row.expires_at || null,
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
  await db.query(
    `INSERT INTO chat_attachments (id, message_id, file_name, mime, byte_size, stored_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, messageId, String(file.originalname).slice(0, 255), MIME[ext] || null,
      Number(file.size) || 0, file.filename, expiryFor()]
  );
  return id;
}

/* One attachment, for serving — but only to somebody in its conversation.
 *
 * The membership join is in this query rather than checked by the route,
 * because an attachment id is a bearer token otherwise: guessable or not, a
 * URL that serves the bytes to anybody who holds it is a URL that gets pasted
 * into another conversation. There is no way to call this without a userId. */
async function forDownload(db, attachmentId, userId) {
  const { rows } = await db.query(
    `SELECT a.id, a.file_name AS fileName, a.mime, a.byte_size AS byteSize,
            a.stored_name AS storedName, a.expires_at AS expiresAt, a.deleted_at AS deletedAt
       FROM chat_attachments a
       JOIN chat_messages msg ON msg.id = a.message_id
       JOIN chat_members me ON me.conversation_id = msg.conversation_id AND me.user_id = $2
      WHERE a.id = $1`,
    [attachmentId, userId]
  );
  if (!rows.length) return { ok: false, status: 404, error: 'No such file.' };
  const row = rows[0];
  if (isExpired(row)) {
    return { ok: false, status: 410, error: 'This file has expired. Chat files are deleted eight hours after they are sent.' };
  }
  if (!row.storedName) return { ok: false, status: 410, error: 'This file is no longer available.' };
  const full = path.join(CHAT_DIR, path.basename(row.storedName));
  if (!fs.existsSync(full)) {
    return { ok: false, status: 410, error: 'This file is no longer available.' };
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
 * By DISK: any file in the directory older than the window, whatever the
 * database says. This is the backstop, and it is not paranoia — an upload whose
 * message insert failed leaves a file with no row at all, and a group deleted
 * when its last member left takes its attachment rows with it through ON DELETE
 * CASCADE while leaving the files behind. Neither is reachable from the table,
 * so a row-only sweep would leak both, silently, for ever.
 *
 * Safe to run on several workers at once: a file another worker already removed
 * raises ENOENT, which is the outcome wanted rather than an error. */
async function sweep(db, { now = new Date() } = {}) {
  const removed = { rows: 0, files: 0, orphans: 0 };

  const { rows } = await db.query(
    `SELECT id, stored_name AS storedName FROM chat_attachments
      WHERE deleted_at IS NULL AND expires_at <= $1`,
    [now]
  ).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''))) return { rows: [] };
    throw err;
  });

  for (const row of rows) {
    if (row.storedName) {
      const gone = await unlinkQuietly(path.join(CHAT_DIR, path.basename(row.storedName)));
      if (gone) removed.files += 1;
    }
    await db.query(
      'UPDATE chat_attachments SET deleted_at = $1, stored_name = NULL WHERE id = $2',
      [now, row.id]
    );
    removed.rows += 1;
  }

  const cutoff = now.getTime() - HOURS * 60 * 60 * 1000;
  let names = [];
  try { names = await fsp.readdir(CHAT_DIR); } catch { names = []; }
  for (const name of names) {
    const full = path.join(CHAT_DIR, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      if (await unlinkQuietly(full)) removed.orphans += 1;
    } catch { /* vanished under us — the outcome wanted either way */ }
  }
  return removed;
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
  const run = () => sweep(db).then((r) => {
    if (r.rows || r.orphans) log(`[chat] expired ${r.rows} attachment(s), removed ${r.files + r.orphans} file(s).`);
  }).catch((err) => log(`[chat] sweep failed: ${err.message}`));

  run();
  const timer = setInterval(run, Math.max(1, SWEEP_MINUTES) * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  CHAT_DIR, EXTENSIONS, ADVERTISED, MAX_BYTES, HOURS, MIME,
  upload, record, forDownload, shape, kindOf, isExpired, isScriptable, expiryFor,
  sweep, schedule,
};
