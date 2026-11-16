/* REAL FILES FOR THE UPLOAD TESTS, built here rather than checked in.
 *
 * tests/profile-photo.js says why, and it is worth repeating: "the server
 * sniffs magic bytes, so a fixture that only *claims* to be a PNG would be
 * refused for the right reason by accident, and a test that passes by accident
 * is not a test."
 *
 * So these are built to the formats' own rules — real CRCs, real zlib streams,
 * real chunk lengths — at whatever size the caller asks for. Checked-in binary
 * fixtures could not do the size table at all: the dimension rules need 63, 64,
 * 512, 1024, 1025 and a 512x256, which is six more opaque files in the
 * repository that nobody can read in a diff.
 *
 * WHAT IS AND IS NOT FAITHFUL HERE. png(), apng() and ico() produce files a
 * browser will actually display — the PNG path is a complete encoder, and the
 * real-browser test leans on that. jpeg() and the webp() family are
 * HEADER-FAITHFUL ONLY: correct signatures, correct frame headers, correct
 * declared dimensions, with no meaningful entropy-coded payload behind them.
 *
 * That is honest for what they are used for, and the reason is worth stating.
 * The server validates by header and stores the bytes exactly as they arrived —
 * it owns no decoder, which is the whole point of src/image-header.js — so a
 * fully entropy-coded JPEG would exercise no line of code that these do not.
 * Writing a baseline JPEG encoder by hand to prove a parser reads two bytes at
 * offset five would be a much bigger thing to get wrong than the thing it
 * tests. Where a test needs an image a browser renders, it uses png().
 */
const zlib = require('node:zlib');

/* ------------------------------------------------------------------- PNG */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const CRC_TABLE = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, sum]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;  // bit depth
  data[9] = 2;  // truecolour
  return data;
}

/* Raw RGB scanlines, each prefixed with a filter byte of 0, deflated — which is
   exactly what a PNG's IDAT holds. The colour is fixed and uninteresting; what
   matters is that a decoder can read it. */
function pixels(width, height, rgb = [200, 40, 60]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  return zlib.deflateSync(raw);
}

function png(width = 64, height = 64, rgb) {
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', pixels(width, height, rgb)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* A VALID PNG OF A CHOSEN SIZE, padded with an ancillary private chunk of
   random bytes.
 *
 * The size table needs a file over the 512KB cap, and a solid-colour 1024x1024
 * deflates to about three kilobytes, so the obvious fixture cannot reach it.
 * Random bytes in a private chunk are the honest way: decoders are required to
 * skip ancillary chunks they do not know, so the result is a real PNG of
 * whatever size is asked for -- not a PNG with rubbish stapled past IEND, which
 * is a different thing and would be testing a different rule. */
function pngPadded(targetBytes, width = 64, height = 64) {
  const base = png(width, height);
  const padding = Math.max(0, targetBytes - base.length - 12);
  /* 'prVt': lower-case first letter marks it ancillary, lower-case third marks
     it private, which is exactly what this is. */
  const pad = chunk('prVt', require('node:crypto').randomBytes(padding));
  return Buffer.concat([base.subarray(0, base.length - 12), pad, base.subarray(base.length - 12)]);
}

/* An ANIMATED png: the same file with an acTL chunk ahead of the image data,
   which is the one thing that makes a browser treat it as a sequence. Two
   frames declared, because one would be a still image with extra steps. */
function apng(width = 64, height = 64) {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0); // frames
  actl.writeUInt32BE(0, 4); // loop forever
  const fctl = Buffer.alloc(26);
  fctl.writeUInt32BE(0, 0);       // sequence number
  fctl.writeUInt32BE(width, 4);
  fctl.writeUInt32BE(height, 8);
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr(width, height)),
    chunk('acTL', actl),
    chunk('fcTL', fctl),
    chunk('IDAT', pixels(width, height)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- ICO */

/* A real icon directory wrapped around PNG payloads, which is how every icon
   made this decade stores anything above 48x48.
 *
 * `sizes` is a list of square sizes, or of [w, h] pairs. Zero in the directory
 * means 256, so a 256 entry is written as a zero byte — the one piece of this
 * format that catches people out. */
function ico(sizes = [64]) {
  const images = sizes.map((s) => {
    const [w, h] = Array.isArray(s) ? s : [s, s];
    return { w, h, bytes: png(w, h) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);               // reserved
  header.writeUInt16LE(1, 2);               // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  images.forEach((img, i) => {
    const e = i * 16;
    directory[e] = img.w >= 256 ? 0 : img.w;
    directory[e + 1] = img.h >= 256 ? 0 : img.h;
    directory[e + 2] = 0;                   // palette size
    directory[e + 3] = 0;                   // reserved
    directory.writeUInt16LE(1, e + 4);      // colour planes
    directory.writeUInt16LE(32, e + 6);     // bits per pixel
    directory.writeUInt32LE(img.bytes.length, e + 8);
    directory.writeUInt32LE(offset, e + 12);
    offset += img.bytes.length;
  });
  return Buffer.concat([header, directory, ...images.map((i) => i.bytes)]);
}

/* A cursor: byte 2 is a 2 rather than a 1, and everything else is identical.
   Its own fixture because the refusal message for it is its own. */
function cur(sizes = [64]) {
  const buf = ico(sizes);
  buf.writeUInt16LE(2, 2);
  return buf;
}

/* An icon file whose only image is tiny — the case the brief calls out: valid
   in every structural respect, and useless as the app's icon. */
const icoTiny = () => ico([16]);

/* An icon directory wrapped around bytes that are not an image at all. The
   structure holds up; the payload is not a PNG and not a bitmap header. */
function icoJunk() {
  const payload = Buffer.alloc(64, 0x7A);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir[0] = 64; dir[1] = 64;
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(payload.length, 8);
  dir.writeUInt32LE(22, 12);
  return Buffer.concat([header, dir, payload]);
}

/* ------------------------------------------------------------------ JPEG */

/* SOI, a JFIF APP0, a baseline frame header carrying the dimensions, then a
   scan marker and EOI. Header-faithful; see the note at the top of this file. */
function jpeg(width = 64, height = 64) {
  const seg = (marker, body) => {
    const head = Buffer.alloc(4);
    head[0] = 0xFF; head[1] = marker;
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  const app0 = Buffer.concat([
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const sof0 = Buffer.alloc(15);
  sof0[0] = 8;                      // sample precision
  sof0.writeUInt16BE(height, 1);
  sof0.writeUInt16BE(width, 3);
  sof0[5] = 3;                      // three components
  for (let c = 0; c < 3; c++) {
    sof0[6 + c * 3] = c + 1;        // component id
    sof0[7 + c * 3] = 0x11;         // sampling factors
    sof0[8 + c * 3] = 0;            // quantisation table
  }
  const sos = Buffer.concat([Buffer.from([3]), Buffer.from([1, 0, 2, 17, 3, 17]), Buffer.from([0, 63, 0])]);
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    seg(0xE0, app0),
    seg(0xC0, sof0),
    seg(0xDA, sos),
    Buffer.alloc(32, 0x5A),         // stand-in for the entropy-coded scan
    Buffer.from([0xFF, 0xD9]),
  ]);
}

/* A progressive JPEG, whose frame marker is SOF2 rather than SOF0. Included
   because a parser that hard-codes 0xC0 reads a progressive file as corrupt,
   and the studio's screenshots are as likely to be one as not. */
function jpegProgressive(width = 64, height = 64) {
  const buf = jpeg(width, height);
  const i = buf.indexOf(Buffer.from([0xFF, 0xC0]));
  buf[i + 1] = 0xC2;
  return buf;
}

/* ------------------------------------------------------------------ WebP */

function riff(fourcc, payload) {
  const chunkHead = Buffer.alloc(8);
  chunkHead.write(fourcc, 0, 'latin1');
  chunkHead.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunkHead, payload]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/* Lossy: a three-byte frame tag, the sync code, then fourteen bits each of
   width and height. */
function webp(width = 64, height = 64) {
  const payload = Buffer.alloc(32, 0);
  payload[0] = 0x9D; // frame tag, key frame
  payload[3] = 0x9D; payload[4] = 0x01; payload[5] = 0x2A; // sync code
  payload.writeUInt16LE(width & 0x3FFF, 6);
  payload.writeUInt16LE(height & 0x3FFF, 8);
  return riff('VP8 ', payload);
}

/* Lossless: a 0x2F signature byte, then width-1 and height-1 packed into the
   low twenty-eight bits. */
function webpLossless(width = 64, height = 64) {
  const payload = Buffer.alloc(16, 0);
  payload[0] = 0x2F;
  payload.writeUInt32LE(((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14), 1);
  return riff('VP8L', payload);
}

/* Extended, which is what an alpha or animated file uses. The flags byte is
   where animation is declared, and the canvas size is stored one less than it
   is, in twenty-four bits each. */
function webpExtended(width = 64, height = 64, { animated = false } = {}) {
  const payload = Buffer.alloc(16, 0);
  payload[0] = animated ? 0x02 : 0x10; // ANIMATION : ALPHA
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', payload);
}

const webpAnimated = (width = 64, height = 64) => webpExtended(width, height, { animated: true });

/* ----------------------------------------------- things that are not icons */

const gif = (width = 64, height = 64) => {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return Buffer.concat([head, Buffer.alloc(16, 0)]);
};

const svg = () => Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
  + '<script>fetch("/api/users")</script><rect width="64" height="64"/></svg>', 'utf8');

const svgBare = () => Buffer.from('<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);

const html = () => Buffer.from('<!DOCTYPE html>\n<html><body>not an icon</body></html>', 'utf8');

const text = () => Buffer.from('this is just a sentence, with no header at all', 'utf8');

/* An actual Windows executable's first bytes, which is what "renamed to .png"
   usually means when it is not an accident. */
const executable = () => Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(128, 0)]);

/* ------------------------------------------------------------- damaged files */

/* Cut off partway through. Defaults to a cut inside the header, which is the
   case a parser gets wrong by reading past the end. */
const truncated = (buffer, keep = 20) => buffer.subarray(0, keep);

/* A valid signature with nonsense behind it. */
const corruptPng = () => Buffer.concat([PNG_SIG, Buffer.alloc(40, 0xFF)]);

/* A PNG whose IHDR claims a size no image has, in a file of a few hundred
   bytes. The parser must answer from the header and allocate nothing. */
function pngClaiming(width, height) {
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', pixels(2, 2)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* A RIFF header that says the file is far larger than it is. */
function webpClaiming(bytes) {
  const buf = webp(64, 64);
  buf.writeUInt32LE(bytes, 4);
  return buf;
}

module.exports = {
  PNG_SIG, crc32,
  png, apng, pngPadded, pngClaiming, corruptPng,
  ico, cur, icoTiny, icoJunk,
  jpeg, jpegProgressive,
  webp, webpLossless, webpExtended, webpAnimated, webpClaiming,
  gif, svg, svgBare, pdf, html, text, executable, truncated,
};
