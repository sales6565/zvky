/* THE THREE FILE FORMATS THIS FEATURE INVENTED, each tested on its own.
 *
 * ===========================================================================
 * WHY SEPARATELY FROM THE ENGINE.
 *
 * A backup is a tar inside a gzip inside an AES-GCM envelope, holding a SQL
 * dump. When a restore fails, the question is which of those four is wrong, and
 * a suite that only takes a whole backup and reads it back cannot answer it —
 * it fails in one place and implicates all four.
 *
 * So each layer is exercised against its own adversary here, with no database
 * and no server: the tar against GNU tar, the envelope against a wrong key and
 * a flipped byte, and the SQL splitter against every chunk boundary there is.
 * The engine suite above this one then only has to prove the layers are wired
 * together in the right order.
 *
 * ===========================================================================
 * THE TWO BUGS THAT MADE THIS FILE WORTH ITS LENGTH, both found by probing and
 * both invisible to a test that used the obvious input:
 *
 *   The tar writer deadlocked past 16 KB, because `super({ read() {} })`
 *   assigns the no-op to this._read and shadows the class's own method, so the
 *   drain signal never arrived. A 14 KB smoke test passed; the first real
 *   31 MB package hung. There is a 4 MB case below.
 *
 *   The SQL splitter was not chunk-boundary independent: `-- ` split across a
 *   chunk became arithmetic, and `DELIMITER` near the end of one became a
 *   statement. Feeding one fixed dump at every chunk size from 1 byte upwards
 *   is the only shape of test that would have caught it, and that is what the
 *   sweep below is.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const tar = require('../src/tar-stream');
const crypt = require('../src/backup-crypto');
const sqlDump = require('../src/sql-dump');

/* A passphrase generated per run. A literal one in the repository is a literal
   one somebody copies into production, which is the mistake Prompt 70 existed
   to undo. */
const PASS = `probe-${crypto.randomBytes(12).toString('base64url')}-${crypto.randomBytes(6).toString('hex')}`;

let tmp;
test.before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-fmt-')); });
test.after(async () => { if (tmp) await fsp.rm(tmp, { recursive: true, force: true }); });

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/* ========================================================================== */
/* 1. THE TAR WRITER                                                          */
/* ========================================================================== */

test('the tar reads back through our own reader, byte for byte', async () => {
  const pack = new tar.Pack();
  const entries = [
    ['a.txt', Buffer.from('hello')],
    ['nested/deep/b.bin', crypto.randomBytes(1000)],
    ['empty.txt', Buffer.alloc(0)],
    ['exactly-512.bin', crypto.randomBytes(512)],
    ['one-over-512.bin', crypto.randomBytes(513)],
    ['unicode-🎬-ünïcödé.txt', Buffer.from('a name with characters outside ASCII')],
  ];
  const feed = (async () => {
    for (const [name, body] of entries) await pack.addBuffer(name, body);
    pack.finish();
  })();
  const out = collect(pack);
  const [, bytes] = await Promise.all([feed, out]);

  const seen = new Map();
  await tar.each(PassThrough.from([bytes]), async (entry, body) => {
    seen.set(entry.name, await collect(body));
  });
  assert.strictEqual(seen.size, entries.length, 'every entry came back');
  for (const [name, body] of entries) {
    assert.ok(seen.has(name), `${name} is in the archive`);
    assert.ok(seen.get(name).equals(body), `${name} came back byte for byte`);
  }
});

test('GNU tar reads it too, which is what makes the format real', async () => {
  let haveTar = true;
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { haveTar = false; }
  if (!haveTar) return;                 // a host without tar is not a failure

  const pack = new tar.Pack();
  const body = crypto.randomBytes(5000);
  const feed = (async () => {
    await pack.addBuffer('dir/one.bin', body);
    await pack.addBuffer('two.txt', Buffer.from('plain text\n'));
    pack.finish();
  })();
  const [, bytes] = await Promise.all([feed, collect(pack)]);

  const file = path.join(tmp, 'gnu.tar');
  await fsp.writeFile(file, bytes);
  const into = path.join(tmp, 'gnu-out');
  await fsp.mkdir(into, { recursive: true });
  /* `tar` REFUSES A BAD CHECKSUM AND A BAD HEADER, which is the point: this is
     not "did it produce a file", it is "did it produce a tar". */
  execFileSync('tar', ['-xf', file, '-C', into], { stdio: 'pipe' });
  assert.ok((await fsp.readFile(path.join(into, 'dir/one.bin'))).equals(body));
  assert.strictEqual(await fsp.readFile(path.join(into, 'two.txt'), 'utf8'), 'plain text\n');

  /* And the listing agrees about the sizes, so no padding leaked into a body. */
  const listing = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
  assert.match(listing, /\b5000\b.*dir\/one\.bin/);
});

test('a big entry streams rather than deadlocking', async () => {
  /* FOUR MEGABYTES, well past both the 16 KB default highWaterMark that
     deadlocked the first version and the 1 MB one it was raised to. A test that
     used 14 KB passed against the broken writer. */
  const big = crypto.randomBytes(4 * 1024 * 1024);
  const file = path.join(tmp, 'big.bin');
  await fsp.writeFile(file, big);

  const pack = new tar.Pack();
  const feed = (async () => { await pack.addFile('big.bin', file); pack.finish(); })();
  const done = (async () => {
    let total = 0;
    let digest = null;
    await tar.each(pack, async (entry, body) => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of body) { total += chunk.length; hash.update(chunk); }
      digest = hash.digest('hex');
    });
    return { total, digest };
  })();
  const [, got] = await Promise.all([feed, done]);
  assert.strictEqual(got.total, big.length);
  assert.strictEqual(got.digest, crypto.createHash('sha256').update(big).digest('hex'));
});

test('a corrupted header is refused rather than read as data', async () => {
  const pack = new tar.Pack();
  const feed = (async () => { await pack.addBuffer('x.txt', Buffer.from('abc')); pack.finish(); })();
  const [, bytes] = await Promise.all([feed, collect(pack)]);

  const broken = Buffer.from(bytes);
  broken[10] ^= 0xff;                   // inside the name/mode area, before the checksum
  await assert.rejects(
    () => tar.each(PassThrough.from([broken]), async (entry, body) => { await collect(body); }),
    (err) => err.code === 'TAR_BAD_CHECKSUM',
    'a tampered header must not be trusted'
  );
});

test('a name too long for the format is refused, not silently truncated', async () => {
  const pack = new tar.Pack();
  await assert.rejects(
    () => pack.addBuffer(`${'d/'.repeat(90)}${'n'.repeat(120)}.txt`, Buffer.from('x')),
    (err) => err.code === 'TAR_NAME_TOO_LONG',
    'a truncated name is a file that restores to the wrong place'
  );
});

/* ========================================================================== */
/* 2. THE ENCRYPTION ENVELOPE                                                 */
/* ========================================================================== */

async function sealed(plain, { passphrase = PASS, encrypt = true } = {}) {
  const side = crypt.writer({ passphrase, encrypt, extra: { createdAt: 'test', forge: '0' } });
  const parts = [side.head];
  const sink = new PassThrough();
  const gather = collect(sink);
  const run = pipeline(PassThrough.from([plain]), zlib.createGzip(), side.cipher, sink);
  const [, body] = await Promise.all([run, gather]);
  parts.push(body);
  const tag = side.finish();
  if (tag.length) parts.push(tag);
  return Buffer.concat(parts);
}

/* BOTH PROMISES AWAITED TOGETHER, and the reason is a real failure mode rather
   than style: when the pipeline rejects — which is what half the tests below
   are checking — the collector rejects too, and awaiting them in sequence
   leaves the second one unhandled. Node's test runner reports that as "activity
   after the test ended" and fails the file, which is exactly what it did the
   first time this was run. Promise.all attaches a handler to both. */
async function opened(buffer, passphrase) {
  const { header, raw, payloadAt } = crypt.readHeader(buffer);
  const side = crypt.reader({ header, raw, passphrase });
  const out = new PassThrough();
  const gather = collect(out);
  const run = pipeline(PassThrough.from([buffer.subarray(payloadAt)]), ...side.transforms,
    zlib.createGunzip(), out);
  const [, body] = await Promise.all([run, gather]);
  return body;
}

test('an encrypted payload comes back exactly, and is not in the file in clear', async () => {
  const secret = Buffer.from(`the quick brown fox ${crypto.randomBytes(8).toString('hex')} jumps`);
  const file = await sealed(secret);
  assert.strictEqual(file.includes(secret), false, 'the plaintext must not be in the package');
  assert.strictEqual(file.includes(Buffer.from(PASS)), false, 'the passphrase must not be in the package');
  const back = await opened(file, PASS);
  assert.ok(back.equals(secret));
});

test('the header says what it is, without saying anything it should not', async () => {
  const file = await sealed(Buffer.from('x'));
  const { header } = crypt.readHeader(file);
  assert.strictEqual(header.encrypted, true);
  assert.strictEqual(header.cipher, crypt.ALGORITHM);
  /* THE SALT AND IV ARE IN THE HEADER AND MUST BE — they are not secret, and a
     package without them cannot be opened by anybody including its owner. What
     must NOT be there is anything derived from the passphrase. */
  const text = JSON.stringify(header);
  assert.strictEqual(text.includes(PASS), false);
  for (const field of ['passphrase', 'password', 'key']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(header, field), `the header has no ${field}`);
  }
});

test('a wrong passphrase fails, and fails the same way a damaged file does', async () => {
  const file = await sealed(Buffer.from('something worth protecting'));
  await assert.rejects(() => opened(file, `${PASS}x`), 'a wrong passphrase cannot open it');

  const damaged = Buffer.from(file);
  /* A BYTE IN THE CIPHERTEXT, past the header. GCM authenticates the whole
     payload, so one flipped bit anywhere in it must fail the tag. */
  damaged[damaged.length - 40] ^= 0x01;
  await assert.rejects(() => opened(damaged, PASS), 'a flipped byte cannot open it');
});

test('a truncated package fails rather than returning what it managed to read', async () => {
  const file = await sealed(crypto.randomBytes(200000));
  await assert.rejects(() => opened(file.subarray(0, file.length - 200), PASS),
    'losing the tag must lose the file, not half of it');
});

test('the header is authenticated too: editing it fails the tag', async () => {
  const file = await sealed(Buffer.from('x'));
  const { raw } = crypt.readHeader(file);
  /* The header is the AAD, so changing one character of it must break
     decryption even though the ciphertext is untouched. Find a digit in the
     JSON and move it. */
  const at = file.indexOf(raw);
  const copy = Buffer.from(file);
  const pos = at + raw.indexOf('"format"');
  assert.ok(pos > at, 'found a field to tamper with');
  copy[pos + 2] = copy[pos + 2] === 0x6f ? 0x70 : 0x6f;   // o <-> p in "format"
  await assert.rejects(() => opened(copy, PASS), 'an edited header must not open');
});

test('an unencrypted package is readable with no passphrase and says so', async () => {
  const body = Buffer.from('not a secret');
  const file = await sealed(body, { passphrase: null, encrypt: false });
  const { header } = crypt.readHeader(file);
  assert.strictEqual(header.encrypted, false);
  assert.ok((await opened(file, null)).equals(body));
});

test('the passphrase minimum is a refusal with a reason, not a boolean', () => {
  const short = crypt.strength('short');
  assert.strictEqual(short.ok, false);
  assert.match(short.message, /\d/, 'the refusal says how many characters are needed');
  assert.strictEqual(crypt.strength('a passphrase of several words').ok, true);
  assert.strictEqual(crypt.strength('').ok, false);
  assert.strictEqual(crypt.strength(null).ok, false);
});

test('the lost-passphrase warning exists and is unambiguous', () => {
  assert.match(crypt.LOST_PASSPHRASE_WARNING, /cannot be opened/i);
  assert.match(crypt.LOST_PASSPHRASE_WARNING, /no (recovery|way)/i);
});

/* ========================================================================== */
/* 3. THE SQL SPLITTER                                                        */
/* ========================================================================== */

/* A dump holding every construct the writer can emit, in miniature. The
   escaping here is exactly what src/sql-dump.js's escapeString() produces. */
const HARD_DUMP = [
  '-- Forge database dump',
  '-- a; semicolon inside a comment',
  '#  and a hash comment; too',
  '/*!40101 SET NAMES utf8mb4 */;',
  'DROP TABLE IF EXISTS `odd;name`;',
  'CREATE TABLE `t` (`a` INT, `b` VARCHAR(10));',
  '',
  '-- Data: t',
  "INSERT INTO `t` (`a`,`b`) VALUES",
  "(1,'it\\'s; here'),",
  "(2,'a--b'),",
  "(3,'trailing backslash \\\\'),",
  "(4,'a \"double\" quote'),",
  '(5,0x4142),',
  '(6,NULL);',
  'ALTER TABLE `t` AUTO_INCREMENT = 7;',
  '',
  '-- Triggers',
  'DROP TRIGGER IF EXISTS `t_ins`;',
  'DELIMITER ;;',
  'CREATE TRIGGER `t_ins` BEFORE INSERT ON `t` FOR EACH ROW BEGIN',
  "  SET NEW.b = 'x;y';",
  '  SET NEW.a = 1;',
  'END;;',
  'DELIMITER ;',
  '',
  '/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;',
  '-- End of dump.',
  '',
].join('\n');

function split(text, chunkSize) {
  const splitter = new sqlDump.Splitter();
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(...splitter.feed(text.slice(i, i + chunkSize)));
  out.push(...splitter.end());
  return out;
}

test('the splitter finds exactly the statements, and no comment banners', () => {
  const got = split(HARD_DUMP, HARD_DUMP.length);
  assert.deepStrictEqual(got, [
    '/*!40101 SET NAMES utf8mb4 */',
    'DROP TABLE IF EXISTS `odd;name`',
    'CREATE TABLE `t` (`a` INT, `b` VARCHAR(10))',
    "INSERT INTO `t` (`a`,`b`) VALUES\n(1,'it\\'s; here'),\n(2,'a--b'),\n"
      + "(3,'trailing backslash \\\\'),\n(4,'a \"double\" quote'),\n(5,0x4142),\n(6,NULL)",
    'ALTER TABLE `t` AUTO_INCREMENT = 7',
    'DROP TRIGGER IF EXISTS `t_ins`',
    "CREATE TRIGGER `t_ins` BEFORE INSERT ON `t` FOR EACH ROW BEGIN\n  SET NEW.b = 'x;y';\n  SET NEW.a = 1;\nEND",
    '/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */',
  ]);
});

test('and the same statements at EVERY chunk size, which is the bug this is for', () => {
  const want = JSON.stringify(split(HARD_DUMP, HARD_DUMP.length));
  const wrong = [];
  for (let n = 1; n <= HARD_DUMP.length; n += 1) {
    if (JSON.stringify(split(HARD_DUMP, n)) !== want) wrong.push(n);
  }
  assert.deepStrictEqual(wrong, [],
    `the splitter gave different statements at these chunk sizes: ${wrong.slice(0, 10).join(', ')}`);
});

test('a dump without a trailing newline is complete, not truncated', () => {
  const want = JSON.stringify(split(HARD_DUMP, HARD_DUMP.length));
  assert.strictEqual(JSON.stringify(split(HARD_DUMP.replace(/\n+$/, ''), 1)), want);
});

test('a dump cut in the middle of a statement is refused', () => {
  const cut = "INSERT INTO `t` (`a`) VALUES (1),(2),(3)";    // no delimiter
  assert.throws(() => split(cut, 7), (err) => err.code === 'DUMP_TRUNCATED');
});

test('a dump cut inside a quoted value is refused', () => {
  assert.throws(() => split("INSERT INTO `t` VALUES ('half a stri", 5),
    (err) => err.code === 'DUMP_TRUNCATED');
});

test('`a--b` is a column expression, not a comment', () => {
  /* MySQL requires a space after `--`. Getting this wrong eats the rest of the
     line, which inside a multi-row INSERT is most of a table. */
  assert.deepStrictEqual(split('SELECT 5--3;', 1), ['SELECT 5--3']);
  assert.deepStrictEqual(split('SELECT 1; -- note\nSELECT 2;', 1), ['SELECT 1', 'SELECT 2']);
});

/* ========================================================================== */
/* 4. THE LITERALS                                                            */
/* ========================================================================== */

test('every value type is written as a literal that means the same thing', () => {
  const { literal } = sqlDump;
  assert.strictEqual(literal(null), 'NULL');
  assert.strictEqual(literal(undefined), 'NULL');
  assert.strictEqual(literal(0), '0');
  assert.strictEqual(literal(-1.5), '-1.5');
  assert.strictEqual(literal(true), '1');
  assert.strictEqual(literal(false), '0');
  assert.strictEqual(literal(Buffer.from([0x41, 0x42])), '0x4142');
  assert.strictEqual(literal(Buffer.alloc(0)), "''", 'an empty blob is an empty string, not 0x');
  /* DECIMAL AND BIGINT ARRIVE AS STRINGS and must stay unquoted, or the scale
     is re-derived from a quoted literal and money changes. */
  assert.strictEqual(literal('1234.5600'), '1234.5600');
  assert.strictEqual(literal('9223372036854775807'), '9223372036854775807');
  /* A TEMPORAL VALUE ARRIVES AS A STRING TOO (dateStrings), and is quoted. */
  assert.strictEqual(literal('2026-11-26 17:29:24.123456'), "'2026-11-26 17:29:24.123456'");
  assert.strictEqual(literal('1000-01-01'), "'1000-01-01'");
  /* AND NOT AS A NUMBER: a NaN or an Infinity has no SQL spelling. */
  assert.strictEqual(literal(NaN), 'NULL');
  assert.strictEqual(literal(Infinity), 'NULL');
});

test('escaping survives everything the escaper names', () => {
  const { escapeString } = sqlDump;
  assert.strictEqual(escapeString("it's"), "'it\\'s'");
  assert.strictEqual(escapeString('a\\b'), "'a\\\\b'");
  assert.strictEqual(escapeString('a\nb'), "'a\\nb'");
  assert.strictEqual(escapeString('a\0b'), "'a\\0b'");
  assert.strictEqual(escapeString('a\x1ab'), "'a\\Zb'");
  /* AND THE RESULT SPLITS AS ONE STATEMENT, which is the property that matters
     — the escaper and the splitter are the two halves of one agreement. */
  const sql = `INSERT INTO t VALUES (${escapeString("a;b';c\\")});`;
  assert.deepStrictEqual(split(sql, 1), [sql.slice(0, -1)]);
});

test('an identifier with a backtick in it cannot break out', () => {
  const { escapeId } = sqlDump;
  assert.strictEqual(escapeId('a`b'), '`a``b`');
  assert.deepStrictEqual(split(`DROP TABLE ${escapeId('a;b')};`, 1), ['DROP TABLE `a;b`']);
});
