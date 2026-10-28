/* A ZIP writer, because an .xlsx is a zip and this application has no library
 * that can write one with cell styles in it.
 *
 * ===========================================================================
 * WHY THIS EXISTS, with the evidence.
 *
 * The project already depends on `xlsx` (SheetJS 0.18.5) and every other
 * spreadsheet in the application is written with it. It cannot write styles:
 * fills, fonts, borders and alignment are a Pro feature, and the community
 * build silently drops them. Measured, not assumed — a sheet written with
 * `cell.s = { fill: ..., font: { bold: true } }` and `cellStyles: true` comes
 * back out with `<fonts count="1">`, `<fills count="2">` (the two defaults) and
 * one `cellXf`. The Artist Report has to match an attached template: fills in
 * two colours, bold, borders on four sides, merged and centred title, freeze
 * panes, autofilter, number formats and real date cells.
 *
 * So the file is written as OOXML directly, and this is the container. Node
 * ships `zlib`, which is the only hard part; the rest of a zip is three fixed
 * record layouts. NO NEW DEPENDENCY — the brief asked for that to be reported
 * before it happened, and this is the alternative.
 *
 * WHAT THIS IS NOT. It is not a general zip library: no directories, no zip64,
 * no encryption, no append. It writes a fixed, small set of text parts once,
 * which is exactly what an .xlsx is.
 *
 * HOW IT IS VERIFIED, AND HOW THAT WAS NOT ENOUGH. The first version of this
 * file was checked three ways in tests/artist-report.test.js — the system
 * `unzip` read it, SheetJS parsed it as a workbook, and the parts were compared
 * against the attached template's XML — and it still produced a package Excel
 * refused to open. All three readers are lenient: `unzip` has no opinion about
 * XML and does not read relationships at all, SheetJS finds elements by regex
 * and parts by name, and the part comparison only looked at the parts it knew
 * to look at. A reader cannot stand in for a schema.
 *
 * So the package is now also CHECKED, by tests/xlsx-validator.js, against the
 * parts of ECMA-376 Excel enforces — element order, relationship completeness,
 * style indices, cell types and the rest. tests/xlsx-package.test.js runs it on
 * every shape of report, and tests/xlsx-transport.test.js proves the bytes the
 * studio receives in a browser and in the desktop app are these bytes.
 */
const zlib = require('zlib');

/* CRC-32, the one thing a zip needs that zlib does not expose. The table is
   built once; the polynomial is the standard reversed 0xEDB88320. */
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* DOS date and time, which is what a zip entry carries. Excel does not read it
   and neither does anything else here, so it is fixed rather than taken from
   the clock: a deterministic file is one a test can compare byte for byte, and
   two downloads of the same report should not differ. 1980-01-01 00:00 is the
   earliest the format can express. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;   // 1980-01-01

/* One entry's local header, and the central-directory record that repeats it.
 * Deflate unless it makes the part bigger, which happens on very short files. */
function entryOf(name, contents) {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const stored = deflated.length >= raw.length;
  return {
    nameBuf,
    method: stored ? 0 : 8,
    crc: crc32(raw),
    size: raw.length,
    body: stored ? raw : deflated,
  };
}

function localHeader(e) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);          // local file header signature
  h.writeUInt16LE(20, 4);                  // version needed
  h.writeUInt16LE(0x0800, 6);              // flags: UTF-8 names
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.body.length, 18);      // compressed size
  h.writeUInt32LE(e.size, 22);             // uncompressed size
  h.writeUInt16LE(e.nameBuf.length, 26);
  h.writeUInt16LE(0, 28);                  // no extra field
  return h;
}

function centralHeader(e, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);          // central directory signature
  h.writeUInt16LE(20, 4);                  // version made by
  h.writeUInt16LE(20, 6);                  // version needed
  h.writeUInt16LE(0x0800, 8);              // flags: UTF-8 names
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.body.length, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(0, 30);                  // extra
  h.writeUInt16LE(0, 32);                  // comment
  h.writeUInt16LE(0, 34);                  // disk number
  h.writeUInt16LE(0, 36);                  // internal attributes
  h.writeUInt32LE(0, 38);                  // external attributes
  h.writeUInt32LE(offset, 42);             // offset of the local header
  return h;
}

/* parts: [{ name, contents }] in the order they should appear.
 *
 * Built as a list of buffers and concatenated once. The whole file is a few
 * hundred kilobytes at the 50,000-row cap — the sheet XML dwarfs everything
 * else — and holding it once is what lets the caller send it with a
 * Content-Length rather than a chunked stream. */
function zip(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const part of parts) {
    const e = entryOf(part.name, part.contents);
    const header = localHeader(e);
    chunks.push(header, e.nameBuf, e.body);
    central.push(centralHeader(e, offset));
    offset += header.length + e.nameBuf.length + e.body.length;
    central[central.length - 1] = Buffer.concat([central[central.length - 1], e.nameBuf]);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);        // end of central directory
  end.writeUInt16LE(0, 4);                 // this disk
  end.writeUInt16LE(0, 6);                 // disk with the directory
  end.writeUInt16LE(parts.length, 8);      // entries on this disk
  end.writeUInt16LE(parts.length, 10);     // entries in total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);           // where the directory starts
  end.writeUInt16LE(0, 20);                // no comment
  return Buffer.concat([...chunks, directory, end]);
}

/* XML text escaping, and the control characters XML 1.0 cannot carry at all.
 *
 * A studio's asset names come from people typing, and a stray 0x0B in one must
 * not produce a file Excel refuses to open — Excel's own writer drops them, so
 * this does too rather than failing the download. Tab, newline and carriage
 * return are legal and kept. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function xmlText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { zip, crc32, xmlText };
