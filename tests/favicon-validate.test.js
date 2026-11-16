/* WHAT MAY BECOME THE TAB ICON — the whole table, with no server and no
 * database in sight.
 *
 * src/favicon.js's validate() is pure on purpose, and this is what that buys:
 * thirty-odd cases, each a real file built to its format's rules, answered in a
 * few milliseconds. The same table against the HTTP route would be thirty
 * uploads against a booted server, and the thing actually under test — which
 * bytes are acceptable — would be the smallest part of what could break.
 *
 * The route's own suite covers what only the route can: multipart handling,
 * filenames, permissions, the audit entry, the served bytes and their headers.
 *
 * EVERY FIXTURE IS A REAL FILE. tests/image-fixtures.js explains what that
 * means and, for JPEG and WebP, exactly how far it goes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const favicon = require('../src/favicon');
const imageHeader = require('../src/image-header');
const avatar = require('../src/avatar');
const fx = require('./image-fixtures');

const ROOT = path.join(__dirname, '..');

/* ----------------------------------------------------------------- the table */

/* Each row: what the file is, the bytes, what the client said it was, and
   either `accept` with the dimensions that must be read back, or `reject` with
   a pattern the message must match.

   The patterns are matched against the message a person will read, which is why
   they are phrases rather than codes: a refusal that stops saying what it means
   should fail this suite. */
const TABLE = [
  // ---------------------------------------------------------------- accepted
  { what: 'a 64x64 PNG, correctly announced',
    bytes: () => fx.png(64, 64), declared: 'image/png', accept: { type: 'png', width: 64, height: 64 } },
  { what: 'a 512x512 PNG, the recommended size',
    bytes: () => fx.png(512, 512), declared: 'image/png', accept: { type: 'png', width: 512, height: 512 } },
  { what: 'a 1024x1024 PNG, exactly at the maximum',
    bytes: () => fx.png(1024, 1024), declared: 'image/png', accept: { type: 'png', width: 1024, height: 1024 } },
  { what: 'a 500x512 PNG, not quite square but within tolerance',
    bytes: () => fx.png(500, 512), declared: 'image/png', accept: { type: 'png', width: 500, height: 512 } },
  { what: 'a PNG with no declared type at all',
    bytes: () => fx.png(64, 64), declared: undefined, accept: { type: 'png' } },
  { what: 'a PNG declared as a generic binary, which is no opinion rather than a lie',
    bytes: () => fx.png(64, 64), declared: 'application/octet-stream', accept: { type: 'png' } },
  { what: 'a PNG whose declared type carries a charset parameter',
    bytes: () => fx.png(64, 64), declared: 'image/png; charset=binary', accept: { type: 'png' } },
  { what: 'an ICO holding one 64x64 image',
    bytes: () => fx.ico([64]), declared: 'image/x-icon', accept: { type: 'ico', width: 64, height: 64 } },
  { what: 'an ICO holding 16, 32 and 48 — judged by its largest',
    bytes: () => fx.ico([16, 32, 48]), declared: 'image/vnd.microsoft.icon',
    accept: { type: 'ico', width: 48, height: 48 } },
  { what: 'an ICO whose largest image is exactly 32x32',
    bytes: () => fx.ico([16, 32]), declared: 'image/x-icon', accept: { type: 'ico', width: 32, height: 32 } },
  { what: 'an ICO holding a 256x256, which the format stores as a zero',
    bytes: () => fx.ico([256]), declared: 'image/x-icon', accept: { type: 'ico', width: 256, height: 256 } },
  { what: 'a baseline JPEG',
    bytes: () => fx.jpeg(64, 64), declared: 'image/jpeg', accept: { type: 'jpeg', width: 64, height: 64 } },
  { what: 'a progressive JPEG, whose frame marker is SOF2',
    bytes: () => fx.jpegProgressive(128, 128), declared: 'image/jpeg',
    accept: { type: 'jpeg', width: 128, height: 128 } },
  { what: 'a JPEG announced as image/jpg, which is not a real type but is what some clients send',
    bytes: () => fx.jpeg(64, 64), declared: 'image/jpg', accept: { type: 'jpeg' } },
  { what: 'a lossy WebP',
    bytes: () => fx.webp(64, 64), declared: 'image/webp', accept: { type: 'webp', width: 64, height: 64 } },
  { what: 'a lossless WebP',
    bytes: () => fx.webpLossless(96, 96), declared: 'image/webp', accept: { type: 'webp', width: 96, height: 96 } },
  { what: 'an extended WebP carrying alpha but not animation',
    bytes: () => fx.webpExtended(128, 128), declared: 'image/webp',
    accept: { type: 'webp', width: 128, height: 128 } },

  // ------------------------------------------------- recognised and refused
  { what: 'an SVG with a script element in it',
    bytes: () => fx.svg(), declared: 'image/svg+xml', reject: /SVG.*script/s },
  { what: 'an SVG with no XML declaration',
    bytes: () => fx.svgBare(), declared: 'image/svg+xml', reject: /SVG/ },
  /* THE FOUR ROWS BELOW ANSWER WITH WHAT THE FILE IS, not with the
     disagreement, and that is the order src/favicon.js checks in.
     
     I expected the mismatch message here and was wrong to. A file renamed to
     .png and announced as one is the ORDINARY way an SVG or a PDF arrives at
     this control -- the browser derives the Content-Type from the extension, so
     declaring image/png is what it does with holiday.png whatever is inside.
     "That is an SVG. An SVG can contain script..." tells the owner what to do
     next; "it says PNG but is SVG" describes the mechanism of their mistake and
     leaves them to work out the rest.
     
     The disagreement message still has a job, three rows further down, for the
     files whose real format IS acceptable: there is nothing else to say about a
     PNG announced as a JPEG. */
  { what: 'an SVG renamed and announced as a PNG',
    bytes: () => fx.svg(), declared: 'image/png', reject: /SVG.*script/s },
  { what: 'a GIF',
    bytes: () => fx.gif(), declared: 'image/gif', reject: /GIF.*moving icon/s },
  { what: 'a GIF announced as a PNG',
    bytes: () => fx.gif(), declared: 'image/png', reject: /GIF.*moving icon/s },
  { what: 'a PDF announced as a PNG',
    bytes: () => fx.pdf(), declared: 'image/png', reject: /That is a PDF, not an image/ },
  { what: 'an HTML page announced as a PNG',
    bytes: () => fx.html(), declared: 'image/png', reject: /HTML page, not an image/ },
  { what: 'a Windows cursor',
    bytes: () => fx.cur([64]), declared: 'image/x-icon', reject: /cursor/ },
  { what: 'a sentence of plain text',
    bytes: () => fx.text(), declared: 'image/png', reject: /not an image this application recognises/ },
  { what: 'an executable renamed to .png',
    bytes: () => fx.executable(), declared: 'image/png', reject: /not an image this application recognises/ },

  // ----------------------------------------------------- header vs declared
  { what: 'PNG bytes announced as a JPEG',
    bytes: () => fx.png(64, 64), declared: 'image/jpeg', reject: /says it is JPEG but its contents are PNG/ },
  { what: 'WebP bytes announced as a PNG',
    bytes: () => fx.webp(64, 64), declared: 'image/png', reject: /says it is PNG but its contents are WebP/ },
  { what: 'ICO bytes announced as a PNG',
    bytes: () => fx.ico([64]), declared: 'image/png', reject: /says it is PNG but its contents are ICO/ },

  // -------------------------------------------------------- size and shape
  { what: 'a file over the 512KB cap',
    bytes: () => fx.pngPadded(600 * 1024), declared: 'image/png', reject: /600KB; the limit is 512KB/ },
  { what: 'a 63x63 PNG, one pixel under the minimum',
    bytes: () => fx.png(63, 63), declared: 'image/png', reject: /63x63; the minimum is 64x64/ },
  { what: 'a 32x32 PNG — fine inside an ICO, too small on its own',
    bytes: () => fx.png(32, 32), declared: 'image/png', reject: /the minimum is 64x64/ },
  { what: 'a 1025x1025 PNG, one pixel over the maximum',
    bytes: () => fx.png(1025, 1025), declared: 'image/png', reject: /1025x1025; the maximum is 1024x1024/ },
  { what: 'a 512x256 PNG, which is a banner and not an icon',
    bytes: () => fx.png(512, 256), declared: 'image/png', reject: /not square/ },
  { what: 'a 64x128 PNG, the same mistake the other way up',
    bytes: () => fx.png(64, 128), declared: 'image/png', reject: /not square/ },
  { what: 'an ICO whose only image is 16x16',
    bytes: () => fx.icoTiny(), declared: 'image/x-icon', reject: /largest image in that icon file is 16x16/ },

  // ------------------------------------------------------------- animation
  { what: 'an animated PNG',
    bytes: () => fx.apng(), declared: 'image/png', reject: /animated PNG/ },
  { what: 'an animated WebP',
    bytes: () => fx.webpAnimated(), declared: 'image/webp', reject: /animated WebP/ },

  // ------------------------------------------------------ damaged and empty
  { what: 'an empty file',
    bytes: () => Buffer.alloc(0), declared: 'image/png', reject: /empty/ },
  { what: 'a PNG cut off inside its header',
    bytes: () => fx.truncated(fx.png(64, 64), 20), declared: 'image/png', reject: /damaged or incomplete/ },
  { what: 'a PNG signature with nonsense behind it',
    bytes: () => fx.corruptPng(), declared: 'image/png', reject: /damaged or incomplete/ },
  { what: 'a WebP whose RIFF header claims ten megabytes',
    bytes: () => fx.webpClaiming(9999999), declared: 'image/webp', reject: /damaged or incomplete/ },
  { what: 'an ICO directory wrapped around bytes that are not an image',
    bytes: () => fx.icoJunk(), declared: 'image/x-icon', reject: /damaged or incomplete/ },
  { what: 'a JPEG cut off after its first marker',
    bytes: () => fx.truncated(fx.jpeg(64, 64), 6), declared: 'image/jpeg', reject: /damaged or incomplete/ },

  // --------------------------------------------- a claim, not an allocation
  { what: 'a few hundred bytes of PNG claiming to be 100000x100000',
    bytes: () => fx.pngClaiming(100000, 100000), declared: 'image/png',
    reject: /100000x100000; the maximum is 1024x1024/ },
  { what: 'a PNG claiming the largest size the format can express',
    bytes: () => fx.pngClaiming(0xFFFFFFFF, 0xFFFFFFFF), declared: 'image/png', reject: /the maximum is/ },
];

test('the validation table', async (t) => {
  for (const row of TABLE) {
    await t.test(row.what, () => {
      const buffer = row.bytes();
      const verdict = favicon.validate({ buffer, declaredMime: row.declared });
      if (row.accept) {
        assert.strictEqual(verdict.ok, true,
          `expected this to be accepted, got: ${verdict.message}`);
        assert.strictEqual(verdict.type, row.accept.type);
        if (row.accept.width) assert.strictEqual(verdict.width, row.accept.width);
        if (row.accept.height) assert.strictEqual(verdict.height, row.accept.height);
        assert.match(verdict.sha256, /^[0-9a-f]{64}$/);
        assert.strictEqual(verdict.version, verdict.sha256.slice(0, 12));
        assert.strictEqual(verdict.bytes, buffer.length);
        assert.ok(verdict.mime.startsWith('image/'), verdict.mime);
      } else {
        assert.strictEqual(verdict.ok, false,
          'expected this to be refused, and it was accepted');
        assert.strictEqual(verdict.status, 400);
        assert.match(verdict.message, row.reject);
        /* A refusal names a field, so the page can put the message next to the
           control rather than in a corner. */
        assert.strictEqual(verdict.field, 'favicon');
      }
    });
  }
});

/* The table is the test, so it is worth asserting that it has not quietly
   emptied itself — a loop over nothing passes. */
test('the table covers both answers and every accepted format', () => {
  assert.ok(TABLE.filter((r) => r.accept).length >= 15, 'accepted cases');
  assert.ok(TABLE.filter((r) => r.reject).length >= 20, 'refused cases');
  const types = new Set(TABLE.filter((r) => r.accept).map((r) => r.accept.type));
  assert.deepStrictEqual([...types].sort(), ['ico', 'jpeg', 'png', 'webp'],
    'every accepted format appears among the accepted rows');
});

/* --------------------------------------------------- the claim costs nothing */

test('an enormous declared size is a comparison, not an allocation', () => {
  /* The point of a header parser. The fixture is a few hundred bytes that
     claims four billion pixels square; a decoder would try to make room for it.
     Measured rather than asserted by reading the code: the call is timed, and
     the file's own length is checked so the fixture cannot quietly become a
     real 100000x100000 image and make this pass for the wrong reason. */
  const buffer = fx.pngClaiming(100000, 100000);
  assert.ok(buffer.length < 2048, `the fixture is ${buffer.length} bytes`);
  const before = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const verdict = favicon.validate({ buffer, declaredMime: 'image/png' });
  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  const grew = process.memoryUsage().heapUsed - before;
  assert.strictEqual(verdict.ok, false);
  assert.ok(tookMs < 100, `it took ${tookMs.toFixed(1)}ms`);
  /* Ten megabytes of slack: this is a smoke alarm for "it tried to allocate the
     image", not a measurement of the parser's working set. */
  assert.ok(grew < 10 * 1024 * 1024, `the heap grew by ${Math.round(grew / 1024)}KB`);
});

test('a malformed chunk walk ends', () => {
  /* A PNG whose second chunk declares a length of zero would walk the same
     offset forever without the step bound in image-header.js. Timed, because
     the failure mode of the bug this guards is a hang rather than a wrong
     answer. */
  const base = fx.png(64, 64);
  const zeroed = Buffer.concat([base]);
  zeroed.writeUInt32BE(0, 8 + 12 + 13 - 13 + 12);
  const started = process.hrtime.bigint();
  imageHeader.read(zeroed);
  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(tookMs < 100, `it took ${tookMs.toFixed(1)}ms`);
});

/* ------------------------------------------------------------ the digest */

test('the version comes from the bytes, so an unchanged file keeps its URL', () => {
  const one = favicon.validate({ buffer: fx.png(64, 64), declaredMime: 'image/png' });
  const same = favicon.validate({ buffer: fx.png(64, 64), declaredMime: 'image/png' });
  const other = favicon.validate({ buffer: fx.png(64, 64, [10, 20, 30]), declaredMime: 'image/png' });
  assert.strictEqual(one.version, same.version, 'the same image, the same version');
  assert.notStrictEqual(one.version, other.version, 'a different image, a different version');
  assert.strictEqual(one.version.length, 12);
});

/* -------------------------------------------------- the name in the audit log */

test('the audit entry gets a file name and never a path', () => {
  assert.strictEqual(favicon.displayName('icon.png'), 'icon.png');
  /* The two separators, because a client sending a Windows path is a thing that
     happens and a path is what must not be stored. */
  assert.strictEqual(favicon.displayName('C:\\Users\\Akilesh\\Desktop\\icon.png'), 'icon.png');
  assert.strictEqual(favicon.displayName('/home/me/projects/secret-client/logo.ico'), 'logo.ico');
  assert.strictEqual(favicon.displayName('../../../etc/passwd'), 'passwd');
  assert.strictEqual(favicon.displayName(''), 'an unnamed file');
  assert.strictEqual(favicon.displayName(undefined), 'an unnamed file');
  /* A newline would let one upload write what looks like two log entries. */
  assert.strictEqual(favicon.displayName('two\nlines.png'), 'twolines.png');
  assert.ok(favicon.displayName('x'.repeat(300)).length <= 80);
});

test('the validator is never shown a filename', () => {
  /* THE RULE THE BRIEF ASKS FOR, kept honest at the source level: the decision
     about what a file is must not be able to consult what it is called. The two
     modules that make that decision do not mention the field the name arrives
     in, so no future edit can start trusting it without this failing. */
  for (const rel of ['src/favicon.js', 'src/image-header.js']) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/originalname/i.test(code), `${rel} reads the uploaded filename`);
    assert.ok(!/\.(?:extname|basename)\b/.test(code), `${rel} looks at a file extension`);
  }
  /* And the extension is not a parameter it could be handed by accident. */
  assert.deepStrictEqual(Object.keys(favicon.validate({ buffer: fx.png(), declaredMime: 'image/png' })).sort(),
    ['bytes', 'height', 'mime', 'ok', 'sha256', 'type', 'version', 'width']);
});

/* ------------------------------------------- the other sniffer in this repo */

test('the two sniffers in this repository agree, except where they are meant not to', () => {
  /* src/avatar.js has its own copy of this logic and keeps it, for the reasons
     at the top of src/image-header.js. Two copies of a rule drift, so the
     agreement is pinned here rather than assumed.

     If somebody later points avatar.js at image-header.js, the ICO line below
     is the one that will fail, and the comment is the answer: avatars do not
     accept .ico, so whichever module decides must filter on avatar's own
     allow-list. */
  for (const [label, buffer, expected] of [
    ['png', fx.png(64, 64), 'image/png'],
    ['jpeg', fx.jpeg(64, 64), 'image/jpeg'],
    ['webp', fx.webp(64, 64), 'image/webp'],
    ['nonsense', fx.text(), null],
  ]) {
    assert.strictEqual(avatar.sniff(buffer), expected, `avatar.sniff: ${label}`);
    const mine = imageHeader.sniff(buffer);
    assert.strictEqual(mine ? imageHeader.MIME[mine] : null, expected, `image-header.sniff: ${label}`);
  }

  // The one deliberate difference.
  assert.strictEqual(avatar.sniff(fx.ico([64])), null, 'avatars do not take an .ico');
  assert.strictEqual(imageHeader.sniff(fx.ico([64])), 'ico', 'and the favicon does');
});
