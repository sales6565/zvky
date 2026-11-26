/* A TAR WRITER AND READER, IN PURE JAVASCRIPT, BECAUSE THE PACKAGE HAS TO BE
 * ONE FILE AND THERE IS NO ARCHIVE LIBRARY IN THIS PROJECT'S DEPENDENCIES.
 *
 * ===========================================================================
 * WHY TAR AND NOT ZIP.
 *
 * The brief allows either and asks for no native dependencies. This project has
 * neither `archiver` nor `jszip`, and adding a native module to shared hosting
 * is how a deploy starts failing on a node-gyp error at two in the morning. So
 * the format is chosen by what Node already has: zlib gives gzip, and tar is
 * the one container format whose writer is a hundred lines of arithmetic rather
 * than a CRC table, a local header, a data descriptor and a central directory
 * that has to agree with all of them.
 *
 * It is also the right shape for the job. Tar is a STREAM of (header, payload)
 * pairs with no index at the end, so a package can be written while the data is
 * still being produced — the database dump is generated as it is archived — and
 * read back the same way. A zip's central directory has to be held until the
 * end, which means knowing every size in advance or seeking backwards in a file
 * that is being encrypted as it is written.
 *
 * ===========================================================================
 * WHAT IS IMPLEMENTED, AND WHAT IS DELIBERATELY NOT.
 *
 * USTAR, the 1988 POSIX format: 512-byte header, name and prefix fields, octal
 * numbers, a checksum, 512-byte-aligned payloads, two zero blocks at the end.
 * Every tar in existence reads it, including GNU tar, bsdtar and macOS, which
 * matters because the owner may want to open a package by hand.
 *
 * NOT implemented, on purpose:
 *   - long names via GNU @LongLink or PAX headers. USTAR allows 100 characters
 *     of name plus 155 of prefix; every path this writes is of the form
 *     "database/dump.sql" or "files/chat/<uuid>" and fits. A name that does not
 *     fit is REFUSED rather than silently truncated — a backup containing a
 *     file under the wrong name is worse than one that failed loudly.
 *   - symbolic links, devices, hard links. The app's own stored files are
 *     ordinary files; anything else is skipped by the engine before it gets
 *     here, and a link in a backup is a way to write outside the restore
 *     directory.
 *   - sparse files, ACLs, extended attributes. Not present on the data this
 *     backs up, and each is a way for two tar implementations to disagree.
 */
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/* A field of `size` bytes holding `value` as NUL-padded text. */
function text(value, size) {
  const buf = Buffer.alloc(size);
  const str = String(value === undefined || value === null ? '' : value);
  const bytes = Buffer.from(str, 'utf8');
  if (bytes.length > size) {
    const err = new Error(`tar: "${str}" does not fit in ${size} bytes`);
    err.code = 'TAR_FIELD_TOO_LONG';
    throw err;
  }
  bytes.copy(buf);
  return buf;
}

/* An octal number field: the digits, then a NUL. Tar's numeric fields are text,
   which is why a tar from 1988 still reads on a machine with a different word
   size. */
function octal(value, size) {
  const digits = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  if (digits.length > size - 1) {
    const err = new Error(`tar: ${value} does not fit in an ${size}-byte octal field`);
    err.code = 'TAR_FIELD_TOO_LONG';
    throw err;
  }
  const buf = Buffer.alloc(size);
  buf.write(digits.padStart(size - 1, '0'), 0, 'ascii');
  buf[size - 1] = 0;
  return buf;
}

/* USTAR splits a long path into prefix + name at a slash. Returns null when the
   path cannot be expressed, so the caller refuses rather than truncates. */
function splitName(pathname) {
  const clean = String(pathname).replace(/^\.?\//, '').replace(/\/+/g, '/');
  if (Buffer.byteLength(clean) <= NAME_MAX) return { name: clean, prefix: '' };
  const parts = clean.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(name) <= NAME_MAX && Buffer.byteLength(prefix) <= PREFIX_MAX) {
      return { name, prefix };
    }
  }
  return null;
}

function header({ name, size = 0, mode = 0o644, mtime = Date.now(), type = '0' }) {
  const split = splitName(name);
  if (!split) {
    const err = new Error(`tar: the path "${name}" is too long for this archive format`);
    err.code = 'TAR_NAME_TOO_LONG';
    throw err;
  }
  const buf = Buffer.alloc(BLOCK);
  text(split.name, 100).copy(buf, 0);
  octal(mode & 0o7777, 8).copy(buf, 100);
  octal(0, 8).copy(buf, 108);                 // uid: 0, so a restore owns them
  octal(0, 8).copy(buf, 116);                 // gid
  octal(size, 12).copy(buf, 124);
  octal(Math.floor(mtime / 1000), 12).copy(buf, 136);
  buf.write('        ', 148, 8, 'ascii');     // checksum field: spaces while summing
  buf.write(String(type), 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  text(split.prefix, 155).copy(buf, 345);

  /* The checksum is the unsigned sum of every byte with the field itself read as
     spaces — which is why it was written as spaces above. */
  let sum = 0;
  for (const b of buf) sum += b;
  octal(sum, 8).copy(buf, 148);
  return buf;
}

function padding(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/* ===========================================================================
 * THE WRITER.
 *
 * A Readable that the caller feeds entries into, so the whole thing can be
 * piped straight at gzip and the cipher without a temporary file:
 *
 *   const pack = new Pack();
 *   pipeline(pack, gzip, cipher, out);
 *   await pack.addBuffer('manifest.json', json);
 *   await pack.addFile('files/chat/x', '/path/on/disk');
 *   await pack.addStream('database/dump.sql', size, readable);   // size known
 *   pack.finish();
 *
 * EVERY add* RETURNS A PROMISE THAT RESOLVES WHEN THE ENTRY HAS BEEN ACCEPTED
 * DOWNSTREAM, which is what keeps memory bounded: push() answers false when the
 * reader is behind, and these wait for 'drain' rather than queueing. A writer
 * that ignored that would hold the whole archive in the Readable's buffer,
 * which on a half-gigabyte database is the process dying.
 *
 * SIZE MUST BE KNOWN BEFORE THE PAYLOAD, which is tar's one real constraint —
 * the header carries the length. For files it is stat(); for the SQL dump the
 * engine writes the dump to disk first and then archives it, which also gives
 * it a hash to put in the manifest.
 */
class Pack extends Readable {
  constructor(options = {}) {
    super({ ...options, read() {} });
    this._waiting = null;
    this._finished = false;
  }

  _read() {
    const w = this._waiting;
    this._waiting = null;
    if (w) w();
  }

  /* Push, and wait if the consumer is behind. */
  _write(chunk) {
    if (this._finished) return Promise.reject(new Error('tar: the archive is already finished'));
    const ok = this.push(chunk);
    if (ok) return Promise.resolve();
    return new Promise((resolve) => { this._waiting = resolve; });
  }

  async addBuffer(name, body, opts = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    await this._write(header({ name, size: buf.length, ...opts }));
    await this._write(buf);
    const pad = padding(buf.length);
    if (pad.length) await this._write(pad);
  }

  async addStream(name, size, source, opts = {}) {
    await this._write(header({ name, size, ...opts }));
    let written = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buf.length;
      if (written > size) {
        const err = new Error(`tar: "${name}" produced more bytes than its header declared `
          + `(${written} > ${size})`);
        err.code = 'TAR_SIZE_MISMATCH';
        throw err;
      }
      await this._write(buf);
    }
    /* A SHORT STREAM IS AN ERROR, NOT A PADDED ENTRY. Tar has no way to say
       "actually it was smaller": the header is already out. Padding the
       difference would produce an archive that unpacks to a file with NULs
       glued on the end, which for a SQL dump is a restore that fails somewhere
       in the middle with a syntax error. */
    if (written !== size) {
      const err = new Error(`tar: "${name}" declared ${size} bytes and produced ${written}`);
      err.code = 'TAR_SIZE_MISMATCH';
      throw err;
    }
    const pad = padding(size);
    if (pad.length) await this._write(pad);
  }

  async addFile(name, onDisk, opts = {}) {
    const st = fs.statSync(onDisk);
    await this.addStream(name, st.size, fs.createReadStream(onDisk),
      { mode: st.mode & 0o7777, mtime: st.mtimeMs, ...opts });
  }

  async addDirectory(name, opts = {}) {
    await this._write(header({
      name: name.endsWith('/') ? name : `${name}/`, size: 0, type: '5', mode: 0o755, ...opts,
    }));
  }

  /* Two zero blocks, which is how a tar says it is over. */
  finish() {
    if (this._finished) return;
    this._finished = true;
    this.push(Buffer.alloc(BLOCK * 2));
    this.push(null);
  }
}

/* ===========================================================================
 * THE READER.
 *
 * A Transform that emits { name, size, type, mode, mtime, body } for each entry,
 * where `body` is a Buffer. Reading entries into memory is fine for everything
 * this is used for — verification reads the manifest and hashes the parts, and
 * the restore script reads the dump a statement at a time from the extracted
 * file — EXCEPT the parts that can be large, which is why extract() below takes
 * a per-entry sink and can write straight to disk.
 */
function parseHeader(block) {
  if (block.every((b) => b === 0)) return null;      // end-of-archive block

  /* THE CHECKSUM IS VERIFIED, and that is not ceremony: this reader is pointed
     at a decrypted stream, and a package whose GCM tag passed but whose tar
     blocks are rubbish means something is wrong with the writer rather than the
     storage. Better to say so than to produce entries with absurd sizes. */
  const stated = parseInt(block.slice(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : block[i];
  if (!Number.isFinite(stated) || sum !== stated) {
    const err = new Error('tar: a header block failed its checksum — the archive is damaged');
    err.code = 'TAR_BAD_CHECKSUM';
    throw err;
  }

  const str = (start, len) => block.slice(start, start + len).toString('utf8').replace(/\0.*$/, '');
  const num = (start, len) => {
    const raw = block.slice(start, start + len).toString('ascii').replace(/\0.*$/, '').trim();
    return raw ? parseInt(raw, 8) : 0;
  };
  const name = str(0, 100);
  const prefix = str(345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: num(100, 8),
    size: num(124, 12),
    mtime: num(136, 12) * 1000,
    type: block.slice(156, 157).toString('ascii') || '0',
  };
}

/* Walk a readable tar stream, handing each entry to `onEntry(entry, chunkIter)`.
 *
 * The entry's payload is offered as an async iterator of Buffers so a caller can
 * hash it or write it to disk without holding it; a caller that wants it in
 * memory concatenates. Bounded memory is the default rather than the option.
 */
async function each(source, onEntry) {
  let buffered = Buffer.alloc(0);
  const chunks = source[Symbol.asyncIterator]();
  let done = false;

  const pull = async (need) => {
    while (buffered.length < need && !done) {
      const next = await chunks.next();
      if (next.done) { done = true; break; }
      const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      buffered = buffered.length ? Buffer.concat([buffered, buf]) : buf;
    }
    if (buffered.length < need) return null;
    const out = buffered.slice(0, need);
    buffered = buffered.slice(need);
    return out;
  };

  for (;;) {
    const block = await pull(BLOCK);
    if (!block) return;                                 // ran out: end of stream
    const entry = parseHeader(block);
    if (!entry) return;                                 // the zero block
    const padded = entry.size + (entry.size % BLOCK ? BLOCK - (entry.size % BLOCK) : 0);

    if (entry.type === '5' || entry.size === 0) {
      if (padded) await pull(padded);
      await onEntry(entry, (async function* empty() {})());
      continue;
    }

    /* The payload, handed over a chunk at a time and never all at once. */
    let left = entry.size;
    let consumed = false;
    const body = (async function* read() {
      while (left > 0) {
        const want = Math.min(left, 64 * 1024);
        const part = await pull(want);
        if (!part) throw Object.assign(new Error('tar: the archive ends inside an entry'),
          { code: 'TAR_TRUNCATED' });
        left -= part.length;
        yield part;
      }
      consumed = true;
    })();

    await onEntry(entry, body);

    /* A CALLER THAT DID NOT READ THE WHOLE ENTRY must not leave the stream
       pointing into the middle of it: everything after would be read as
       headers. So whatever is left of this entry, and its padding, is drained
       here. */
    while (left > 0) {
      const skip = await pull(Math.min(left, 64 * 1024));
      if (!skip) return;
      left -= skip.length;
    }
    void consumed;
    const pad = entry.size % BLOCK ? BLOCK - (entry.size % BLOCK) : 0;
    if (pad) await pull(pad);
  }
}

/* A Transform that counts bytes going through it — used by the engine to size
   the package as it is written, without stat()ing a file that is still open. */
class Counter extends Transform {
  constructor() { super(); this.bytes = 0; }
  _transform(chunk, _enc, cb) { this.bytes += chunk.length; cb(null, chunk); }
}

module.exports = { Pack, each, Counter, header, splitName, BLOCK };
