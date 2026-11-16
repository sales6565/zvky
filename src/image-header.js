/* WHAT A FEW HUNDRED BYTES OF HEADER SAY AN IMAGE IS, without decoding it.
 *
 * ===========================================================================
 * WHY THIS IS HAND-WRITTEN AND NOT A LIBRARY.
 *
 * The obvious way to learn an image's size is to decode it — sharp, canvas,
 * image-size, jimp. The first two are native modules: they compile against
 * libvips or Cairo at install time, and this application is deployed by
 * uploading a folder to GoDaddy cPanel/Passenger, where `npm install` runs
 * against whatever toolchain that account happens to have. A native dependency
 * there is a deploy that fails on the customer's machine and cannot be debugged
 * from here. The brief forbids one, and it is right to.
 *
 * So: no decoding at all. Every format below states its dimensions in a fixed
 * header, in the first few dozen bytes, and reading them is arithmetic. A
 * favicon does not need to be resized, re-encoded or inspected pixel by pixel —
 * it needs to be recognised, measured, and stored exactly as it arrived.
 *
 * ===========================================================================
 * NOTHING HERE ALLOCATES FROM A NUMBER IN THE FILE.
 *
 * This is the property that makes a header parser safe to point at an upload. A
 * PNG can claim to be 100000 x 100000 in thirteen bytes; a RIFF header can
 * claim a four-gigabyte payload. Every length read below is used in a
 * comparison — against the buffer's real length, or against a limit — and never
 * as the size of something to create. The parser's memory and time are bounded
 * by the bytes it was handed, not by what they claim.
 *
 * Chunk walks are additionally bounded by a step count (CHUNK_LIMIT), because a
 * zero-length chunk in a malformed file would otherwise walk the same offset
 * forever.
 *
 * ===========================================================================
 * IT NAMES WHAT IT FINDS, INCLUDING THINGS THAT ARE NOT ALLOWED.
 *
 * sniff() recognises GIF, SVG, PDF and HTML as well as the four accepted
 * formats. That is deliberate: a caller that only learned "not an allowed
 * image" could only say so, and "that is an SVG, and SVG is not accepted
 * because it can carry script" is the message that tells somebody what to do
 * next. Recognising a format is not the same as accepting it — acceptance is
 * src/favicon.js's decision, and this module takes none.
 *
 * ===========================================================================
 * THERE IS A SECOND SNIFFER IN THIS REPOSITORY, in src/avatar.js, and it is
 * deliberately still there.
 *
 * Avatars accept JPEG, PNG and WebP, and avatar.validate() STORES what the
 * bytes turn out to be when the declared type disagrees — the comment there
 * explains why (a phone naming a HEIC-derived JPEG badly). This module
 * additionally recognises ICO, so pointing avatar.js at it would silently start
 * accepting .ico avatars, which is a behaviour change to a feature this change
 * was not asked to touch.
 *
 * Two copies of a rule is how rules drift, so the duplication is PINNED BY A
 * TEST rather than left to good intentions: for every format avatar.js knows,
 * its sniff and this one must return the same answer, and the test says in
 * words that ICO is the one case where they are allowed to differ. If somebody
 * later makes avatars filter on their own allow-list, the two become one.
 */

/* The eight-byte PNG signature, as bytes rather than a string: the last four
   are a DOS line ending and an EOF marker, which do not survive being compared
   as text in every encoding. */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/* A walk over a container's chunks stops after this many. No real icon has
   anything like this many, and it is the bound that makes a malformed file
   finish rather than spin. */
const CHUNK_LIMIT = 64;

const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  /* THE ONE THE IANA REGISTRY NAMES. Browsers and Windows have historically
     sent image/x-icon, and both are in the wild; this module answers with the
     registered name and src/favicon.js treats the older spelling as the same
     thing when a client declares it. */
  ico: 'image/vnd.microsoft.icon',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  html: 'text/html',
};

const at = (buf, offset, length) => (
  offset >= 0 && offset + length <= buf.length ? buf.toString('latin1', offset, offset + length) : '');

/* ---------------------------------------------------------------- recognising */

function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  if (at(buffer, 0, 4) === 'RIFF' && at(buffer, 8, 4) === 'WEBP') return 'webp';
  if (at(buffer, 0, 6) === 'GIF87a' || at(buffer, 0, 6) === 'GIF89a') return 'gif';
  if (at(buffer, 0, 4) === '%PDF') return 'pdf';

  /* ICO AND CUR SHARE A HEADER and are told apart by one byte: reserved must be
     zero, then type 1 is an icon and type 2 is a cursor. A cursor is reported as
     what it is so the refusal can say so — storing one as a favicon would give
     browsers a file whose hotspot fields they ignore and whose images are often
     monochrome masks. */
  if (buffer.length >= 6 && buffer[0] === 0 && buffer[1] === 0 && buffer[3] === 0) {
    if (buffer[2] === 1) return 'ico';
    if (buffer[2] === 2) return 'cur';
  }

  /* TEXT FORMATS LAST, and only by looking at the start of the file. An SVG may
     open with an XML declaration, a comment, or a doctype before <svg appears,
     so the first few hundred bytes are searched rather than the first four —
     but only the first few hundred, so this cannot become a scan of a megabyte
     of binary that happens to contain the letters. */
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 512)).toLowerCase();
  const text = head.trimStart();
  if (text.startsWith('<?xml') || text.startsWith('<svg') || text.startsWith('<!doctype svg')) {
    if (head.includes('<svg')) return 'svg';
  }
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<head')) return 'html';

  return null;
}

/* ------------------------------------------------------------------ measuring */

const fail = (reason) => ({ ok: false, reason });

/* PNG: the IHDR chunk, which the format requires to come first.
 *
 * Width and height are big-endian 32-bit at a fixed offset, so measuring is two
 * reads. The walk afterwards exists for one question — whether this is an
 * ANIMATED png — which cannot be answered from IHDR. */
function readPng(buffer) {
  if (buffer.length < 8 + 4 + 4 + 13) return fail('truncated');
  if (at(buffer, 12, 4) !== 'IHDR') return fail('corrupt');
  if (buffer.readUInt32BE(8) !== 13) return fail('corrupt');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return fail('corrupt');

  /* acTL BEFORE THE FIRST IDAT is what makes a PNG an APNG — the animation
     control chunk. A browser shows an APNG favicon as a moving icon in the tab,
     which is the thing item 3 of the brief rules out; and an APNG's acTL after
     IDAT is ignored by decoders, so the position matters as much as the name. */
  let animated = false;
  let offset = 8;
  for (let step = 0; step < CHUNK_LIMIT; step++) {
    if (offset + 8 > buffer.length) break;
    const length = buffer.readUInt32BE(offset);
    const type = at(buffer, offset + 4, 4);
    if (type === 'acTL') { animated = true; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    /* The declared chunk length is compared, never allocated. A length that
       runs past the end means the file is truncated or lying, and either way
       there is nothing further to read. */
    if (length > buffer.length) break;
    offset += 12 + length;
  }

  return { ok: true, type: 'png', width, height, animated };
}

/* JPEG: the frame header, found by walking the marker segments.
 *
 * Every segment is 0xFF, a marker byte, then a big-endian length that includes
 * its own two bytes. A handful of markers stand alone with no length at all,
 * and a run of 0xFF bytes is legal padding between segments — both are why this
 * is a walk and not a fixed offset. */
const SOF_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

function readJpeg(buffer) {
  let offset = 2;
  for (let step = 0; step < CHUNK_LIMIT; step++) {
    while (offset < buffer.length && buffer[offset] === 0xFF) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset++;
    /* Stand-alone markers: restart markers, TEM, and SOI/EOI. No length
       follows, so reading one as a length would walk into the pixel data. */
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (marker === 0xD9) break;
    if (offset + 2 > buffer.length) return fail('truncated');
    const length = buffer.readUInt16BE(offset);
    if (length < 2) return fail('corrupt');
    if (SOF_MARKERS.has(marker)) {
      /* [length 2][precision 1][height 2][width 2][components 1] */
      if (offset + 7 > buffer.length) return fail('truncated');
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height) return fail('corrupt');
      return { ok: true, type: 'jpeg', width, height, animated: false };
    }
    /* SOS: the scan has begun and no frame header appeared before it. */
    if (marker === 0xDA) break;
    offset += length;
    if (offset > buffer.length) return fail('truncated');
  }
  return fail('corrupt');
}

/* WebP: three different headers behind one container.
 *
 * VP8  is lossy, and its size sits behind a three-byte frame tag and a sync
 *      code, in fourteen bits each.
 * VP8L is lossless, and packs width-1 and height-1 into a bit stream.
 * VP8X is the extended form — the one an animated or alpha-carrying file uses —
 *      and states the canvas size as two 24-bit values, each stored one less
 *      than it is. Its flags byte is the only place animation is declared.
 */
function readWebp(buffer) {
  if (buffer.length < 16) return fail('truncated');
  /* The RIFF size counts everything after those first eight bytes. A file that
     claims more than it has is truncated — this is a comparison, not an
     allocation, so a claim of four gigabytes costs nothing. */
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize + 8 > buffer.length) return fail('truncated');

  const fourcc = at(buffer, 12, 4);
  const payload = 20;

  if (fourcc === 'VP8X') {
    if (payload + 10 > buffer.length) return fail('truncated');
    const flags = buffer[payload];
    const animated = Boolean(flags & 0x02);
    const width = buffer.readUIntLE(payload + 4, 3) + 1;
    const height = buffer.readUIntLE(payload + 7, 3) + 1;
    return { ok: true, type: 'webp', width, height, animated };
  }

  if (fourcc === 'VP8 ') {
    if (payload + 10 > buffer.length) return fail('truncated');
    /* The sync code, which is what separates a key frame from noise. */
    if (buffer[payload + 3] !== 0x9D || buffer[payload + 4] !== 0x01 || buffer[payload + 5] !== 0x2A) {
      return fail('corrupt');
    }
    const width = buffer.readUInt16LE(payload + 6) & 0x3FFF;
    const height = buffer.readUInt16LE(payload + 8) & 0x3FFF;
    if (!width || !height) return fail('corrupt');
    return { ok: true, type: 'webp', width, height, animated: false };
  }

  if (fourcc === 'VP8L') {
    if (payload + 5 > buffer.length) return fail('truncated');
    if (buffer[payload] !== 0x2F) return fail('corrupt');
    const bits = buffer.readUInt32LE(payload + 1);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >>> 14) & 0x3FFF) + 1;
    return { ok: true, type: 'webp', width, height, animated: false };
  }

  return fail('corrupt');
}

/* ICO: a directory, not an image.
 *
 * One file holds several sizes, each described by a sixteen-byte entry: the
 * width and height are single bytes, and zero means 256 because 256 does not
 * fit in a byte. What a browser picks is its own business, so what matters here
 * is that the directory is coherent, that every entry's bytes are actually in
 * the file, and how big the largest image is.
 *
 * EACH ENTRY'S PAYLOAD IS CHECKED to be a PNG or a Windows bitmap header,
 * because an ICO wrapper around arbitrary bytes is trivial to produce and would
 * otherwise pass every structural test here. */
const BITMAP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

function readIco(buffer) {
  if (buffer.length < 6) return fail('truncated');
  const count = buffer.readUInt16LE(4);
  if (!count) return fail('corrupt');
  if (count > CHUNK_LIMIT) return fail('corrupt');
  if (6 + count * 16 > buffer.length) return fail('truncated');

  const entries = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const width = buffer[entry] === 0 ? 256 : buffer[entry];
    const height = buffer[entry + 1] === 0 ? 256 : buffer[entry + 1];
    const bytes = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    /* Compared against the real length. An entry claiming a gigabyte at
       offset zero is a corrupt file, not a gigabyte of work. */
    if (!bytes || offset < 6 + count * 16) return fail('corrupt');
    if (offset + bytes > buffer.length) return fail('truncated');

    const embedded = buffer.subarray(offset, offset + Math.min(bytes, 8));
    const isPng = embedded.length >= 8 && embedded.equals(PNG_SIG);
    const isBitmap = bytes >= 4 && BITMAP_HEADER_SIZES.has(buffer.readUInt32LE(offset));
    if (!isPng && !isBitmap) return fail('corrupt');

    entries.push({ width, height });
  }

  /* The largest by area, which is the one the rules are applied to: an icon
     file carrying 16, 32 and 48 is a perfectly good favicon, and judging it by
     its smallest image would refuse it for containing a 16x16. */
  const largest = entries.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  return {
    ok: true, type: 'ico', width: largest.width, height: largest.height, animated: false, entries,
  };
}

/* ------------------------------------------------------------------- the door */

/* What these bytes are, how big, and whether they move.
 *
 * Returns { ok: true, type, mime, width, height, animated } for the four
 * formats it can measure; { ok: false, reason: 'truncated' | 'corrupt' } when it
 * recognised the format and the file does not hold up; and
 * { ok: false, reason: 'unsupported', type } when it recognised something that
 * is not a measurable raster image, with the type named so the caller can say
 * which. 'unknown' means it recognised nothing at all. */
function read(buffer) {
  const type = sniff(buffer);
  if (!type) return { ok: false, reason: 'unknown' };

  let out;
  if (type === 'png') out = readPng(buffer);
  else if (type === 'jpeg') out = readJpeg(buffer);
  else if (type === 'webp') out = readWebp(buffer);
  else if (type === 'ico') out = readIco(buffer);
  else return { ok: false, reason: 'unsupported', type, mime: MIME[type] || null };

  if (!out.ok) return { ...out, type, mime: MIME[type] };
  return { ...out, mime: MIME[type] };
}

module.exports = { sniff, read, MIME, PNG_SIG };
