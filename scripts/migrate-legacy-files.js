#!/usr/bin/env node
/* Move the files Forge is still holding onto the office file server.
 *
 *   node scripts/migrate-legacy-files.js --dry-run
 *   node scripts/migrate-legacy-files.js
 *
 * RUN THIS FROM AN OFFICE MACHINE. It is the only place that can be both ends
 * of the move at once: it pulls each file from Forge over the internet and
 * pushes it to the gateway over the LAN. Forge cannot reach the gateway and the
 * gateway cannot reach into Forge's disk, which is the whole architecture — so
 * the migration is a third party rather than a feature of either.
 *
 * IT NEVER DELETES ANYTHING. Not on the hosting, not on the share. When it has
 * finished, every legacy file is in BOTH places, and removing the ones on the
 * hosting is a deliberate manual act by whoever owns that account. Until then
 * they stay downloadable (Settings → Server → Serve legacy files).
 *
 * IT IS IDEMPOTENT, AND NOT BY REMEMBERING. Before uploading, it lists the
 * destination folder on the office server and skips a file that is already
 * there with the same size. So a re-run after an interruption resumes, and the
 * state it trusts is the share itself rather than a column that could disagree
 * with it. That is the same reason there is no table of files anywhere in this
 * feature.
 *
 * ENVIRONMENT
 *   FORGE_URL         https://pipeline.zvky.com
 *   FORGE_EMAIL       a Super Admin's sign-in
 *   FORGE_PASSWORD
 *
 * If the gateway's certificate comes from an internal CA this machine does not
 * already trust, start node with NODE_EXTRA_CA_CERTS=/path/to/ca.pem. That is
 * node's own documented way in; there is deliberately no flag here for turning
 * verification off, because it is the flag nobody turns back on.
 */
const crypto = require('node:crypto');

const DRY = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const at = process.argv.indexOf('--limit');
  return at > 0 ? Number(process.argv[at + 1]) || 0 : 0;
})();

const need = (name) => {
  const v = (process.env[name] || '').trim();
  if (!v) {
    console.error(`${name} is not set. See the header of this file.`);
    process.exit(2);
  }
  return v;
};

const FORGE = need('FORGE_URL').replace(/\/+$/, '');
const EMAIL = need('FORGE_EMAIL');
const PASSWORD = need('FORGE_PASSWORD');

let token = null;

async function forge(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`${FORGE}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new Error((json && json.error) || `${method} ${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function gateway(url, { method = 'GET', token: tok, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json };
}

const bytes = (n) => {
  if (n === null || n === undefined) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
};

async function main() {
  console.log(`Forge: ${FORGE}`);
  token = (await forge('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).token;
  const me = await forge('/auth/me');
  console.log(`Signed in as ${me.user.name} (${me.user.role}).`);

  const settings = await forge('/admin/settings/server');
  const gatewayUrl = settings.settings.gatewayUrl;
  if (!gatewayUrl) {
    console.error('Settings → Server has no gateway address. Configure the Server tab first.');
    process.exit(2);
  }
  if (!settings.settings.enabled) {
    console.error('The Server tab is switched off. Turn it on before migrating into it.');
    process.exit(2);
  }
  const origin = new URL(gatewayUrl).origin;
  const health = await gateway(`${origin}/health`);
  if (!health.ok) {
    console.error(`The gateway at ${origin} did not answer /health. Run this from the office network.`);
    process.exit(2);
  }
  console.log(`Gateway: ${origin} — reachable.`);

  const inventory = await forge('/admin/settings/server/legacy-files?limit=1000');
  const all = LIMIT ? inventory.files.slice(0, LIMIT) : inventory.files;
  console.log(`${inventory.total} legacy file(s) on the hosting, ${bytes(inventory.totalBytes)} in total.`);
  if (!all.length) { console.log('Nothing to move.'); return 0; }
  if (DRY) console.log('\n--- DRY RUN: nothing will be uploaded ---');

  /* Which folder each project owns. Read through the mapping, which CLAIMS one
     for a project that has never used the tab — so a migration is also the
     thing that names the folders. */
  const mapping = new Map((settings.mapping || []).map((m) => [m.projectId, m.folder || m.wouldBe]));

  const report = { moved: 0, skipped: 0, failed: 0, unverified: 0, bytes: 0, problems: [] };
  const listingCache = new Map();

  for (const file of all) {
    const folder = file.folder || mapping.get(file.projectId);
    const label = `${file.projectName}/${file.name} (${bytes(file.size)})`;
    if (!folder) {
      report.failed += 1;
      report.problems.push(`${label}: its project has no folder, and none could be derived`);
      continue;
    }

    // Already there? Ask the share, not a record of what this tool did before.
    if (!listingCache.has(folder)) {
      const tok = await forge('/server/token', { method: 'POST', body: { op: 'list', path: folder } })
        .catch((err) => { report.problems.push(`${folder}: ${err.message}`); return null; });
      if (!tok) { report.failed += 1; continue; }
      const listed = await gateway(`${origin}/v1/list?path=${encodeURIComponent(folder)}&limit=500`, { token: tok.token });
      listingCache.set(folder, listed.ok && listed.json ? (listed.json.entries || []) : []);
    }
    const there = listingCache.get(folder)
      .find((e) => e.type === 'file' && e.name === file.name && Number(e.size) === Number(file.size));
    if (there) {
      report.skipped += 1;
      console.log(`  = ${label} — already on the office server`);
      continue;
    }

    if (DRY) { console.log(`  + ${label} → ${folder}/`); report.moved += 1; continue; }

    /* PULL. Streamed into memory in one piece here and not on the server: this
       is a one-off tool on an office machine with a disk and no other job, and
       a legacy submission is capped at the old 200 MB limit. The live upload
       path slices the file instead and never buffers it. */
    const res = await forge(`/assets/versions/${file.versionId}/download`, { raw: true });
    if (!res.ok) {
      report.failed += 1;
      report.problems.push(`${label}: the hosting would not serve it (${res.status})`);
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    if (file.size !== null && buffer.length !== Number(file.size)) {
      report.failed += 1;
      report.problems.push(`${label}: the hosting served ${buffer.length} bytes, the record says ${file.size} — left alone`);
      continue;
    }

    // PUSH, through a session Forge authorises like any other upload.
    let session;
    try {
      session = await forge('/server/upload-session', { method: 'POST',
        body: { path: folder, name: file.name, size: buffer.length } });
    } catch (err) {
      report.failed += 1;
      report.problems.push(`${label}: Forge refused the upload — ${err.message}`);
      continue;
    }
    const chunk = Number(session.chunkBytes) || 32 * 1024 * 1024;
    let failed = null;
    for (let offset = 0; offset < buffer.length; offset += chunk) {
      const slice = buffer.subarray(offset, Math.min(offset + chunk, buffer.length));
      const put = await gateway(`${origin}/v1/upload/${session.uploadId}/chunk?offset=${offset}`, {
        method: 'PUT', token: session.token, body: slice,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!put.ok) { failed = (put.json && put.json.error) || `chunk at ${offset} → ${put.status}`; break; }
    }
    if (failed) {
      report.failed += 1;
      report.problems.push(`${label}: ${failed}`);
      continue;
    }
    const done = await gateway(`${origin}/v1/upload/${session.uploadId}/complete`, {
      method: 'POST', token: session.token, body: '{}', headers: { 'Content-Type': 'application/json' },
    });
    if (!done.ok) {
      report.failed += 1;
      report.problems.push(`${label}: the gateway would not finish it — ${(done.json && done.json.error) || done.status}`);
      continue;
    }

    /* VERIFY. The gateway reads the file back after the move and reports its
       SHA-256 to Forge as a callback; this waits for that row and compares it
       with what was pulled. A mismatch is reported and NOTHING is deleted
       anywhere — the file is on the share under its own name and a person
       decides what to do. */
    const expectPath = `${folder}/${done.json.name}`;
    let verified = null;
    for (let wait = 0; wait < 20; wait += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const audit = await forge('/server/audit?action=checksum&limit=50').catch(() => null);
      const row = audit && audit.events.find((e) => e.path === expectPath && e.sha256);
      if (row) { verified = row.sha256; break; }
    }
    report.moved += 1;
    report.bytes += buffer.length;
    if (verified === null) {
      report.unverified += 1;
      console.log(`  + ${label} → ${expectPath} (checksum not reported yet)`);
    } else if (verified !== sha) {
      report.problems.push(`${label}: CHECKSUM MISMATCH — pulled ${sha.slice(0, 12)}…, the share has ${verified.slice(0, 12)}… `
        + '(nothing was deleted; the file is on the share and needs a look)');
      console.log(`  ! ${label} → ${expectPath} — CHECKSUM MISMATCH`);
    } else {
      console.log(`  + ${label} → ${expectPath} — ${sha.slice(0, 12)}… verified`);
    }
  }

  console.log('\n--- report ---');
  console.log(`${DRY ? 'would move' : 'moved'}: ${report.moved}   already there: ${report.skipped}   failed: ${report.failed}`);
  if (!DRY) console.log(`bytes moved: ${bytes(report.bytes)}   unverified checksums: ${report.unverified}`);
  for (const line of report.problems) console.log(`  ! ${line}`);
  console.log('\nNothing was deleted from the hosting. Every file moved is now in both places.');
  console.log('When you are satisfied, switch off Settings → Server → "Serve legacy files",');
  console.log('and remove the old files from the hosting account yourself.');
  return report.failed || report.problems.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`The migration stopped: ${err && err.message}`);
  console.error('Nothing was deleted. Re-run it — files already on the office server are skipped.');
  process.exit(1);
});
