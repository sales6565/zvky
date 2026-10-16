/* WINDOWS PATH SEMANTICS, TESTED FROM LINUX.
 *
 * The gateway will run on a Windows machine with an NTFS or SMB share, and
 * every test so far has run on Linux with a case-sensitive filesystem. The
 * rules that differ are the ones most likely to be a hole: backslashes,
 * drive letters, UNC prefixes, reserved device names, trailing dots and
 * spaces, alternate data streams, 8.3 short names, case-insensitive
 * collisions and over-long paths.
 *
 * MOST OF THEM ARE STRING RULES, which is why they are testable here: the
 * sanitiser in gateway/src/paths.js refuses or cleans names by inspecting them,
 * not by asking the filesystem. The two that genuinely need Windows — whether
 * the OS agrees about reserved names, and whether long paths are enabled — are
 * what gateway/doctor.js asks on the machine, and the doctor's manual section
 * covers the rest.
 *
 * WHAT A SHORT NAME IS AND IS NOT. "PROGRA~1" is a legal file name, so it is
 * accepted as one. The risk people reach for it over is a name that ALIASES
 * another path — and that risk is answered by containment rather than by name
 * rules: the jail realpaths what exists, so whatever a short name resolves to
 * has to be inside the share. That is asserted below rather than left implied.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../gateway/src/paths');
const serverPaths = require('../src/server-paths');
const serverLink = require('../src/server-link');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-win-'));
  fs.mkdirSync(path.join(root, paths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true });
  return root;
}

test('backslashes and mixed separators are one path, not a name', () => {
  const root = sandbox();
  for (const [given, want] of [
    ['Alpha\\scenes\\a.psd', 'Alpha/scenes/a.psd'],
    ['Alpha/scenes\\a.psd', 'Alpha/scenes/a.psd'],
    ['Alpha\\\\scenes//a.psd', 'Alpha/scenes/a.psd'],
    ['Alpha\\.\\scenes\\a.psd', 'Alpha/scenes/a.psd'],
  ]) {
    const out = paths.resolve(root, given);
    assert.ok(out.ok, `${given}: ${out.reason}`);
    assert.strictEqual(out.relative, want);
  }
});

test('drive letters, UNC prefixes and device paths are refused', () => {
  const root = sandbox();
  const refused = [
    'C:\\Windows\\win.ini',
    'c:/Windows/win.ini',
    'C:Projects',                      // drive-relative: meaningless off that machine
    '\\\\server\\share\\file',
    '//server/share/file',
    '\\\\?\\C:\\Windows',              // the extended-length prefix
    '\\\\.\\PhysicalDrive0',           // a device namespace
    '\\\\?\\UNC\\server\\share',
  ];
  for (const value of refused) {
    const out = paths.resolve(root, value);
    assert.strictEqual(out.ok, false, `${JSON.stringify(value)} must be refused`);
    assert.ok(out.reason, `${value} must come with a reason`);
  }
});

test('reserved device names are refused with and without an extension', () => {
  /* On Windows these are devices, not files: writing to NUL discards the bytes
     and CON reads the console. A file called NUL.txt cannot exist. */
  const names = ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9',
    'NUL.txt', 'con.psd', 'COM1.tar.gz', 'lpt3.jpg'];
  for (const name of names) {
    assert.strictEqual(paths.cleanSegment(name).ok, false, `${name} must be refused`);
    assert.strictEqual(serverPaths.cleanName(name).ok, false, `${name} must be refused by Forge too`);
  }
  // And the near-misses are NOT refused: these are ordinary names.
  for (const name of ['CONSOLE', 'COM0', 'COM10', 'NULL', 'LPT', 'AUXILIARY', 'con-notes.txt']) {
    assert.strictEqual(paths.cleanSegment(name).ok, true, `${name} is a legal name and must be allowed`);
  }
});

test('trailing dots and spaces are stripped, because Windows strips them', () => {
  /* CreateFile silently drops them, so a file created as "Final ." is opened as
     "Final" — and a name stored with the dot points at nothing. Stripped rather
     than refused: "Final render ." is a thing people type. */
  for (const [given, want] of [
    ['Final render .', 'Final render'],
    ['name...', 'name'],
    ['name . . ', 'name'],
    ['shot.psd ', 'shot.psd'],
  ]) {
    assert.strictEqual(paths.cleanSegment(given).value, want);
    assert.strictEqual(serverPaths.cleanName(given).value, want, 'and Forge agrees');
  }
  // Nothing left after stripping is not a name.
  for (const given of ['...', '   ', '. . .']) {
    assert.strictEqual(paths.cleanSegment(given).ok, false);
  }
});

test('alternate data streams are refused', () => {
  /* "report.psd:hidden" writes a SECOND stream on the same file — invisible in
     Explorer, invisible in a listing, and a way to put bytes somewhere nobody
     looks. The colon is in the illegal set, so every shape of it is refused. */
  for (const name of ['report.psd:hidden', 'a:b', ':stream', 'name:$DATA', 'x:y:z']) {
    assert.strictEqual(paths.cleanSegment(name).ok, false, `${name} must be refused`);
    assert.strictEqual(serverPaths.cleanName(name).ok, false, `${name} must be refused by Forge too`);
  }
  const root = sandbox();
  assert.strictEqual(paths.resolve(root, 'Alpha/report.psd:hidden').ok, false);
});

test('an 8.3 short name is a legal name, and is still contained', () => {
  const root = sandbox();
  // Accepted as a name: it is one.
  assert.strictEqual(paths.cleanSegment('PROGRA~1').ok, true);
  assert.strictEqual(paths.cleanSegment('MYRECE~2.PSD').ok, true);
  /* AND CONTAINED. The risk with a short name is that it aliases something
     else; the answer is the jail rather than the name rules, so what matters is
     that it resolves inside the share like any other name. */
  const inside = paths.resolve(root, 'Alpha/PROGRA~1');
  assert.ok(inside.ok);
  assert.ok(inside.full.startsWith(fs.realpathSync(root) + path.sep));
  // A short name cannot be used to climb out either.
  assert.strictEqual(paths.resolve(root, 'PROGRA~1/../../etc').ok, false);
});

test('collisions are case-insensitive, because the share may be', () => {
  /* On NTFS "Report.PSD" and "report.psd" are ONE file. The containment test
     folds case for the same reason — a case-sensitive comparison would let a
     differently-cased prefix past. */
  assert.ok(paths.within('alpha/scenes/a.psd', 'Alpha'));
  assert.ok(paths.within('ALPHA/SCENES', 'alpha/scenes'));
  assert.strictEqual(paths.within('Alpha Reserves', 'Alpha'), false);
  // Forge's copy agrees, which is what makes a token and the gateway one rule.
  for (const [p, prefix] of [['alpha/x', 'Alpha'], ['ALPHA/x', 'alpha'], ['Alpha Reserves', 'Alpha']]) {
    assert.strictEqual(serverPaths.within(p, prefix), paths.within(p, prefix));
  }
  // And the collision suffix keeps the extension where Windows expects it.
  assert.strictEqual(paths.collisionName('Report.PSD', 2), 'Report (2).PSD');
});

test('over-long names and paths are refused before the filesystem sees them', () => {
  const root = sandbox();
  assert.strictEqual(paths.cleanSegment('x'.repeat(paths.MAX_SEGMENT + 1)).ok, false);
  assert.strictEqual(paths.cleanSegment('x'.repeat(paths.MAX_SEGMENT)).ok, true);
  const deep = Array.from({ length: 12 }, () => 'y'.repeat(90)).join('/');
  assert.ok(deep.length > paths.MAX_RELATIVE);
  assert.strictEqual(paths.resolve(root, deep).ok, false,
    'a path past the limit is refused here rather than failing at 260 characters on Windows');
});

test('oddly encoded traversal is refused', () => {
  const root = sandbox();
  for (const value of [
    '%2e%2e%2fetc', '%2E%2E/etc', '..%2fetc', 'Alpha%5c..%5cBeta',
    '%252e%252e%252f', '..%c0%afetc',
  ]) {
    const out = paths.resolve(root, value);
    assert.strictEqual(out.ok, false, `${value} must be refused`);
  }
});

test("a project link in Windows notation resolves to the share's relative path", () => {
  const prefix = '\\\\SERVER\\Projects';
  for (const [link, want] of [
    ['\\\\SERVER\\Projects\\Hero Quest', 'Hero Quest'],
    ['\\\\server\\projects\\Hero Quest\\', 'Hero Quest'],
    ['//SERVER/Projects/Hero Quest/Art', 'Hero Quest/Art'],
    ['\\\\SERVER\\Projects\\Hero Quest\\Art\\', 'Hero Quest/Art'],
  ]) {
    const out = serverLink.validateLink(link, prefix);
    assert.ok(out.ok, `${link}: ${out.error}`);
    assert.strictEqual(out.relative, want);
  }
  // A different server, a different share, or the prefix alone: refused.
  for (const link of ['\\\\OTHER\\Projects\\Hero', '\\\\SERVER\\Other\\Hero', '\\\\SERVER\\Projects',
    '\\\\SERVER\\Projects\\..\\Elsewhere', '\\\\SERVER\\Projects\\Hero.', '\\\\SERVER\\Projects\\NUL']) {
    assert.strictEqual(serverLink.validateLink(link, prefix).ok, false, `${link} must be refused`);
  }
  // And the link it composes back keeps the prefix's own separator.
  assert.strictEqual(serverLink.linkFor(prefix, 'Hero Quest/Art/Ana/walk.psd'),
    '\\\\SERVER\\Projects\\Hero Quest\\Art\\Ana\\walk.psd');
  assert.strictEqual(serverLink.linkFor('/mnt/projects', 'Hero/Art'), '/mnt/projects/Hero/Art');
});
