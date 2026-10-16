#!/usr/bin/env node
/* THE LARGE-FILE PROOF. Run by hand, never by the test suite: it writes
 * gigabytes and takes half a minute.
 *
 *   SIZE=$((2*1024*1024*1024)) node gateway/scripts/large-file-proof.js
 *
 * WHY IT EXISTS. Everything else about this gateway was tested on files
 * measured in kilobytes, and the studio's files are measured in gigabytes. The
 * question those tests cannot answer is whether memory grows with the file —
 * one buffered chunk is fine, one buffered FILE is a gateway that falls over on
 * the first render somebody uploads. So this uploads a sparse file through the
 * real gateway in its own process, samples that process's RSS from /proc, and
 * prints the peak. Run it at two sizes: if the peak doubles with the file, the
 * answer is no.
 *
 * Measured in the development container, 2026-10-16, Node 22.22.2, loopback:
 *
 *   1 GB  upload 16.3s   download 1.9s   finalise 8ms   peak RSS 200 MB
 *   2 GB  upload 21.8s   download 3.8s   finalise 11ms  peak RSS 201 MB
 *
 * One megabyte of difference for twice the file. Baseline was 55 MB, and the
 * ~145 MB above it is a handful of 32 MB chunk buffers waiting to be collected.
 *
 * Uploads a 2 GB file through the gateway in chunks read positionally from
 * disk, then downloads it, sampling the GATEWAY process's RSS throughout. The
 * number that matters is whether peak memory tracks the file size or stays
 * flat: a gateway that buffers a chunk is fine, one that buffers a file is not.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const minter = require('../../src/server-tokens');
const paths = require('../src/paths');

const GB = 1024 ** 3;
const SIZE = Number(process.env.SIZE || 2 * GB);
const CHUNK = 32 * 1024 * 1024;
/* The gigabytes go to a temporary directory, not into the repository beside
   this script — which is where the first version of it put them. */
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-largefile-'));
const HERE = path.dirname(__filename);

const rssOf = (pid) => {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
};

(async () => {
  const share = fs.mkdtempSync(path.join(SP, 'share-'));
  fs.mkdirSync(path.join(share, paths.INCOMING), { recursive: true });
  fs.mkdirSync(path.join(share, 'Alpha'), { recursive: true });
  const state = fs.mkdtempSync(path.join(SP, 'state-'));

  const keys = minter.generate();
  const pub = path.join(SP, 'pub.pem');
  fs.writeFileSync(pub, keys.publicKey);

  // The source: a sparse 2 GB file with recognisable bytes at both ends and in
  // the middle, so "the right bytes arrived" is checkable without reading 2 GB.
  const source = path.join(SP, 'source.bin');
  const fd = fs.openSync(source, 'w');
  fs.ftruncateSync(fd, SIZE);
  const mark = (at, byte) => fs.writeSync(fd, Buffer.alloc(4096, byte), 0, 4096, at);
  mark(0, 0xAA); mark(Math.floor(SIZE / 2), 0xBB); mark(SIZE - 4096, 0xCC);
  fs.closeSync(fd);
  console.log(`source: ${(SIZE / GB).toFixed(2)} GB at ${source}`);

  const child = fork(path.join(HERE, 'large-file-gateway.js'), [], {
    env: { ...process.env, SHARE: share, STATE: state, PUBKEY: pub, KID: keys.kid },
  });
  const { port, pid } = await new Promise((r) => child.once('message', r));
  const base = `http://127.0.0.1:${port}`;
  console.log(`gateway: pid ${pid} on ${base}`);

  let peak = 0;
  const sample = setInterval(() => { const r = rssOf(pid); if (r && r > peak) peak = r; }, 100);
  const baseline = rssOf(pid);

  const uploadId = crypto.randomUUID();
  const token = minter.mint({
    privateKey: keys.privateKey, kid: keys.kid, audience: 'GW-BIG', userId: 'u-big',
    op: 'upload', path: 'Alpha', uploadId, maxBytes: SIZE, name: 'huge.bin',
  }).token;

  const started = Date.now();
  const handle = fs.openSync(source, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let sent = 0;
  for (let offset = 0; offset < SIZE; offset += CHUNK) {
    const want = Math.min(CHUNK, SIZE - offset);
    fs.readSync(handle, buf, 0, want, offset);
    const res = await fetch(`${base}/v1/upload/${uploadId}/chunk?offset=${offset}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: buf.subarray(0, want),
    });
    if (!res.ok) { console.error('chunk failed', offset, res.status, await res.text()); process.exit(1); }
    await res.text();
    sent += want;
    if (offset % (CHUNK * 16) === 0) {
      process.stdout.write(`  ${(sent / GB).toFixed(2)} GB  gateway RSS ${(rssOf(pid) / 1e6).toFixed(0)} MB\r`);
    }
  }
  fs.closeSync(handle);
  const uploadMs = Date.now() - started;

  const doneRes = await fetch(`${base}/v1/upload/${uploadId}/complete`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  });
  const done = await doneRes.json();
  const completeMs = Date.now() - started - uploadMs;
  console.log(`\nupload:   ${(uploadMs / 1000).toFixed(1)}s for ${(SIZE / GB).toFixed(2)} GB `
    + `(${(SIZE / uploadMs * 1000 / 1e6).toFixed(0)} MB/s), finalise ${completeMs}ms by ${done.how}`);

  const landed = path.join(share, 'Alpha', 'huge.bin');
  const stat = fs.statSync(landed);
  console.log(`landed:   ${stat.size} bytes (${stat.size === SIZE ? 'exact' : 'WRONG'})`);
  const check = fs.openSync(landed, 'r');
  const probe = Buffer.allocUnsafe(1);
  const at = (pos) => { fs.readSync(check, probe, 0, 1, pos); return probe[0]; };
  console.log(`markers:  ${at(0).toString(16)} ${at(Math.floor(SIZE / 2)).toString(16)} ${at(SIZE - 1).toString(16)} `
    + `(expect aa bb cc)`);
  fs.closeSync(check);

  // Download, with a Range at the far end as well.
  const dlToken = minter.mint({
    privateKey: keys.privateKey, kid: keys.kid, audience: 'GW-BIG', userId: 'u-big',
    op: 'download', path: 'Alpha/huge.bin',
  }).token;
  const dlStart = Date.now();
  const dl = await fetch(`${base}/v1/download?path=Alpha/huge.bin&token=${encodeURIComponent(dlToken)}`);
  let got = 0;
  for await (const piece of dl.body) got += piece.length;
  const downloadMs = Date.now() - dlStart;
  console.log(`download: ${(downloadMs / 1000).toFixed(1)}s for ${got} bytes `
    + `(${(got / downloadMs * 1000 / 1e6).toFixed(0)} MB/s)`);

  clearInterval(sample);
  console.log(`\nRSS=${(peak / 1e6).toFixed(0)}MB BASE=${(baseline / 1e6).toFixed(0)}MB SIZE=${(SIZE / GB).toFixed(2)}GB `
    + `UPLOAD_MS=${uploadMs} DOWNLOAD_MS=${downloadMs} FINALISE_MS=${completeMs} HOW=${done.how}`);

  child.kill();
  fs.rmSync(share, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
  fs.rmSync(source, { force: true });
  fs.rmSync(SP, { recursive: true, force: true });
  process.exit(0);
})();
