/* The path jail and the delete helper: the two places where "the gateway can
   never touch anything outside the share, and can never delete a stored file"
   is actually enforced. Everything here is about refusals. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../gateway/src/paths');
const deleter = require('../gateway/src/deleter');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-jail-'));
  fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, paths.INCOMING), { recursive: true });
  fs.writeFileSync(path.join(root, 'Alpha', 'render.psd'), 'x');
  return root;
}

test('a path inside the share resolves, and what comes back is the CLEANED path', () => {
  const root = sandbox();
  const r = paths.resolve(root, 'Alpha/render.psd');
  assert.ok(r.ok);
  assert.strictEqual(r.relative, 'Alpha/render.psd');
  assert.strictEqual(r.full, path.join(fs.realpathSync(root), 'Alpha', 'render.psd'));
  // Backslashes, doubled separators and a "." segment all arrive from real
  // browsers; each is normalised rather than refused, and the ANSWER is the
  // cleaned form, so what gets audited is what was used.
  assert.strictEqual(paths.resolve(root, 'Alpha\\.\\render.psd').relative, 'Alpha/render.psd');
});

test('every shape of escape is refused', () => {
  const root = sandbox();
  const cases = [
    ['..', 'bare parent'],
    ['../etc/passwd', 'traversal'],
    ['Alpha/../../etc/passwd', 'traversal through a real folder'],
    ['/etc/passwd', 'absolute posix'],
    ['\\\\server\\share\\file', 'UNC'],
    ['C:\\Windows\\win.ini', 'drive letter'],
    ['%2e%2e%2fetc%2fpasswd', 'encoded traversal'],
    ['%252e%252e%252f', 'double-encoded'],
    ['Alpha/nul', 'reserved device name'],
    ['Alpha/NUL.txt', 'reserved device name with an extension'],
    [`Alpha/${'x'.repeat(paths.MAX_SEGMENT + 1)}`, 'over-length segment'],
    ['Alpha/a\u0000b', 'NUL byte'],
    ['Alpha/a:b', 'illegal character'],
  ];
  for (const [value, why] of cases) {
    const r = paths.resolve(root, value);
    assert.strictEqual(r.ok, false, `${why} (${JSON.stringify(value)}) must be refused`);
    assert.ok(r.reason, `${why} must come back with a reason`);
  }
});

test('a symlink out of the share is followed and then refused', (t) => {
  const root = sandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  try { fs.symlinkSync(outside, path.join(root, 'Alpha', 'escape')); }
  catch { return t.skip('this filesystem does not allow symlinks'); }

  /* The point: the TEXT is inside the share. A prefix test on the string says
     yes. Only resolving the link says no, which is why resolve() realpaths the
     deepest existing ancestor instead of comparing strings. */
  const r = paths.resolve(root, 'Alpha/escape/secret.txt');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /outside the file share/);
  // And the link itself, with nothing after it.
  assert.strictEqual(paths.resolve(root, 'Alpha/escape').ok, false);
});

test('trailing dots and spaces are stripped, because Windows strips them anyway', () => {
  assert.strictEqual(paths.cleanSegment('Final render .').value, 'Final render');
  assert.strictEqual(paths.cleanSegment('name...').value, 'name');
  assert.strictEqual(paths.cleanSegment('   ').ok, false);
});

test('a collision gets "(2)", keeping the extension where it belongs', () => {
  assert.strictEqual(paths.collisionName('render.psd', 2), 'render (2).psd');
  assert.strictEqual(paths.collisionName('render.psd', 7), 'render (7).psd');
  assert.strictEqual(paths.collisionName('README', 2), 'README (2)');
  assert.strictEqual(paths.collisionName('.hidden', 2), '.hidden (2)');
});

test('prefix containment compares segments and ignores case', () => {
  assert.ok(paths.within('Alpha/scenes/a.psd', 'Alpha'));
  assert.ok(paths.within('alpha/scenes', 'Alpha'));       // NTFS: same folder
  assert.ok(paths.within('Alpha', 'Alpha'));
  assert.ok(paths.within('anything', ''));                 // the whole root
  // The bug a string test has: "Alpha" must not match "Alpha Reserves".
  assert.strictEqual(paths.within('Alpha Reserves/a.psd', 'Alpha'), false);
  assert.strictEqual(paths.within('Beta', 'Alpha'), false);
});

test('system and dot names are hidden from listings', () => {
  for (const n of ['Thumbs.db', 'thumbs.db', 'desktop.ini', '$RECYCLE.BIN',
    'System Volume Information', '.incoming', '.DS_Store']) {
    assert.ok(paths.isHidden(n), `${n} should be hidden`);
  }
  assert.strictEqual(paths.isHidden('render.psd'), false);
});

test('the delete helper refuses everything outside .incoming', () => {
  const root = sandbox();
  const stored = path.join(root, 'Alpha', 'render.psd');
  for (const target of [stored, path.join(root, 'Alpha'), root,
    path.join(root, paths.INCOMING), path.join(root, '..'), os.tmpdir()]) {
    const r = deleter.remove(root, target);
    assert.strictEqual(r.ok, false, `${target} must not be removable`);
    assert.strictEqual(r.reason, 'outside-incoming');
  }
  assert.ok(fs.existsSync(stored), 'the stored file is still there');
  assert.ok(fs.existsSync(path.join(root, paths.INCOMING)), '.incoming itself survives');
});

test('and allows exactly what is inside .incoming', () => {
  const root = sandbox();
  const mine = path.join(root, paths.INCOMING, 'abc');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'blob'), 'bytes');
  assert.strictEqual(deleter.remove(root, path.join(mine, 'blob')).ok, true);
  assert.strictEqual(deleter.remove(root, mine).ok, true);
  assert.strictEqual(fs.existsSync(mine), false);
});

test('a symlink inside .incoming cannot be used to delete outside it', (t) => {
  const root = sandbox();
  const stored = path.join(root, 'Alpha', 'render.psd');
  const link = path.join(root, paths.INCOMING, 'escape');
  try { fs.symlinkSync(path.join(root, 'Alpha'), link); }
  catch { return t.skip('this filesystem does not allow symlinks'); }
  const r = deleter.remove(root, path.join(link, 'render.psd'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside-incoming');
  assert.ok(fs.existsSync(stored), 'the file the link pointed at is untouched');
});

test('the abandoned sweep only reaches .incoming, and spares the young', () => {
  const root = sandbox();
  const old = path.join(root, paths.INCOMING, 'old');
  const fresh = path.join(root, paths.INCOMING, 'fresh');
  for (const d of [old, fresh]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'blob'), 'x'); }
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  const out = deleter.sweepAbandoned(root, { olderThanMinutes: 24 * 60 });
  assert.strictEqual(out.removed, 1);
  assert.strictEqual(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh), 'an upload still in progress is left alone');
  assert.ok(fs.existsSync(path.join(root, 'Alpha', 'render.psd')), 'and the share is untouched');
});
