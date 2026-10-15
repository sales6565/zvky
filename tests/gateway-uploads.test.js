/* Chunked uploads: out of order, resumed, finished exactly once, and never on
   top of somebody else's file. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const uploads = require('../gateway/src/uploads');
const paths = require('../gateway/src/paths');

const ID = () => crypto.randomUUID();

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-up-'));
  fs.mkdirSync(path.join(root, paths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true });
  return root;
}

test('chunks written out of order land at their offsets and the file is byte-exact', async () => {
  const root = sandbox();
  const id = ID();
  const body = crypto.randomBytes(100 * 1024);
  const chunkSize = 32 * 1024;
  const order = [2, 0, 3, 1];                 // deliberately not sequential
  for (const i of order) {
    const slice = body.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, body.length));
    const r = uploads.putChunk(root, id, i * chunkSize, slice,
      { size: body.length, name: 'render.psd', dir: 'Alpha', sub: 'u1' });
    assert.ok(r.ok, r.reason);
  }
  const st = uploads.status(root, id);
  assert.ok(st.complete, 'all four chunks together cover the file');
  const done = uploads.complete(root, id, { dir: 'Alpha', name: 'render.psd' });
  assert.ok(done.ok, done.reason);
  const final = path.join(root, 'Alpha', 'render.psd');
  assert.deepStrictEqual(fs.readFileSync(final), body, 'the bytes are exactly what was sent');
  assert.strictEqual(await uploads.sha256(final), crypto.createHash('sha256').update(body).digest('hex'));
});

test('status reports the received ranges so a reloaded page resumes', () => {
  const root = sandbox();
  const id = ID();
  const size = 90;
  uploads.putChunk(root, id, 0, Buffer.alloc(30, 1), { size, name: 'a.bin', dir: '', sub: 'u1' });
  uploads.putChunk(root, id, 60, Buffer.alloc(30, 3), { size });
  const st = uploads.status(root, id);
  // Two ranges with the hole in the middle — which is the whole point: the
  // browser asks for this and sends only [30,60).
  assert.deepStrictEqual(st.received, [[0, 30], [60, 90]]);
  assert.strictEqual(st.complete, false);
  assert.strictEqual(st.size, 90);
  // Finishing early is refused, and says what is missing rather than storing a
  // file with a hole in it.
  const early = uploads.complete(root, id, { dir: '', name: 'a.bin' });
  assert.strictEqual(early.ok, false);
  assert.match(early.reason, /60 of 90 bytes/);
  // Resume.
  uploads.putChunk(root, id, 30, Buffer.alloc(30, 2), { size });
  assert.deepStrictEqual(uploads.status(root, id).received, [[0, 90]], 'the ranges merge into one');
  assert.ok(uploads.complete(root, id, { dir: '', name: 'a.bin' }).ok);
});

test('a re-sent chunk is idempotent, and overlapping ranges merge', () => {
  const root = sandbox();
  const id = ID();
  const size = 40;
  uploads.putChunk(root, id, 0, Buffer.alloc(20, 9), { size, name: 'b.bin', dir: '', sub: 'u1' });
  uploads.putChunk(root, id, 0, Buffer.alloc(20, 9), { size });     // retry after a timeout
  uploads.putChunk(root, id, 10, Buffer.alloc(30, 9), { size });    // overlapping
  assert.deepStrictEqual(uploads.status(root, id).received, [[0, 40]]);
});

test('a chunk past the declared size is refused rather than growing the file', () => {
  const root = sandbox();
  const id = ID();
  uploads.putChunk(root, id, 0, Buffer.alloc(10), { size: 10, name: 'c.bin', dir: '', sub: 'u1' });
  const over = uploads.putChunk(root, id, 8, Buffer.alloc(10), { size: 10 });
  assert.strictEqual(over.ok, false);
  assert.match(over.reason, /past the declared size/);
  const blob = path.join(uploads.dirFor(root, id), uploads.BLOB);
  assert.strictEqual(fs.statSync(blob).size, 10, 'the preallocated file did not grow');
});

test('an upload id that Forge did not mint is refused', () => {
  const root = sandbox();
  for (const bad of ['../../etc/passwd', 'abc', '', 'not-a-uuid', 'a/b']) {
    assert.strictEqual(uploads.putChunk(root, bad, 0, Buffer.alloc(1), { size: 1 }).ok, false);
    assert.strictEqual(uploads.status(root, bad).ok, false);
  }
});

test('an existing name is never overwritten — the new file becomes "name (2).ext"', () => {
  const root = sandbox();
  const existing = path.join(root, 'Alpha', 'render.psd');
  fs.writeFileSync(existing, 'THE ORIGINAL');

  const id = ID();
  const body = Buffer.from('THE NEW ONE');
  uploads.putChunk(root, id, 0, body, { size: body.length, name: 'render.psd', dir: 'Alpha', sub: 'u1' });
  const done = uploads.complete(root, id, { dir: 'Alpha', name: 'render.psd' });

  assert.ok(done.ok, done.reason);
  assert.strictEqual(done.stored, 'render (2).psd');
  assert.ok(done.renamed, 'the caller is told, so the page can say what it was saved as');
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'THE ORIGINAL', 'the first file is untouched');
  assert.strictEqual(fs.readFileSync(path.join(root, 'Alpha', 'render (2).psd'), 'utf8'), 'THE NEW ONE');

  // And again: the third goes to (3), not back over (2).
  const id3 = ID();
  uploads.putChunk(root, id3, 0, Buffer.from('THIRD'), { size: 5, name: 'render.psd', dir: 'Alpha', sub: 'u1' });
  assert.strictEqual(uploads.complete(root, id3, { dir: 'Alpha', name: 'render.psd' }).stored, 'render (3).psd');
  assert.strictEqual(fs.readFileSync(path.join(root, 'Alpha', 'render (2).psd'), 'utf8'), 'THE NEW ONE');
});

test('finishing leaves the file read-only and .incoming empty', () => {
  const root = sandbox();
  const id = ID();
  uploads.putChunk(root, id, 0, Buffer.from('bytes'), { size: 5, name: 'd.bin', dir: 'Alpha', sub: 'u1' });
  const done = uploads.complete(root, id, { dir: 'Alpha', name: 'd.bin' });
  assert.ok(done.ok, done.reason);

  const final = path.join(root, 'Alpha', 'd.bin');
  const mode = fs.statSync(final).mode & 0o777;
  assert.strictEqual(mode & 0o222, 0, `the stored file must not be writable (mode ${mode.toString(8)})`);

  // No working copy left behind: the move is a move, not a copy, so there is
  // nothing in .incoming afterwards and nothing to clean up later.
  assert.deepStrictEqual(fs.readdirSync(path.join(root, paths.INCOMING)), []);
});

test('the declared size is checked against what is actually on disk', () => {
  const root = sandbox();
  const id = ID();
  uploads.putChunk(root, id, 0, Buffer.alloc(10, 1), { size: 10, name: 'e.bin', dir: '', sub: 'u1' });
  // Truncate the blob behind the engine's back: the ranges file still claims
  // ten bytes. complete() must not believe the record over the disk.
  const blob = path.join(uploads.dirFor(root, id), uploads.BLOB);
  fs.truncateSync(blob, 4);
  const done = uploads.complete(root, id, { dir: '', name: 'e.bin' });
  assert.strictEqual(done.ok, false);
  assert.match(done.reason, /4 bytes; 10 were declared/);
});

test('the destination is resolved through the jail, not joined by hand', () => {
  const root = sandbox();
  const id = ID();
  uploads.putChunk(root, id, 0, Buffer.from('x'), { size: 1, name: 'f.bin', dir: 'Alpha', sub: 'u1' });
  const out = uploads.complete(root, id, { dir: '../..', name: 'f.bin' });
  assert.strictEqual(out.ok, false);
  assert.ok(/outside|step outside/.test(out.reason), out.reason);
  const bad = uploads.complete(root, id, { dir: 'Alpha', name: '../../escaped.bin' });
  assert.strictEqual(bad.ok, false);
});

test('intermediate folders are created lazily by the first upload into them', () => {
  const root = sandbox();
  const id = ID();
  assert.strictEqual(fs.existsSync(path.join(root, 'Alpha', 'scenes', 'act1')), false);
  uploads.putChunk(root, id, 0, Buffer.from('x'), { size: 1, name: 'g.bin', dir: 'Alpha/scenes/act1', sub: 'u1' });
  const done = uploads.complete(root, id, { dir: 'Alpha/scenes/act1', name: 'g.bin' });
  assert.ok(done.ok, done.reason);
  assert.strictEqual(done.relative, 'Alpha/scenes/act1/g.bin');
  assert.ok(fs.existsSync(path.join(root, 'Alpha', 'scenes', 'act1', 'g.bin')));
});

test('ranges merge touching intervals, which is what makes "complete" one comparison', () => {
  assert.deepStrictEqual(uploads.mergeRanges([[0, 10], [10, 20]]), [[0, 20]]);
  assert.deepStrictEqual(uploads.mergeRanges([[10, 20], [0, 10]]), [[0, 20]]);
  assert.deepStrictEqual(uploads.mergeRanges([[0, 5], [10, 15]]), [[0, 5], [10, 15]]);
  assert.deepStrictEqual(uploads.mergeRanges([[0, 30], [5, 10]]), [[0, 30]]);
});
