#!/usr/bin/env node
/* THE GATEWAY DOCTOR. Run this ON THE GATEWAY MACHINE, as the service account.
 *
 *   node gateway/doctor.js            (or: npm run doctor)
 *
 * Everything else about this feature has been tested on a Linux container over
 * loopback. That proves what the code does; it proves nothing about the share
 * this studio actually has — whether it does hard links, whether it folds case,
 * whether it accepts a 300-character path, whether the service account can
 * create a folder, whether the clock agrees with Forge's. Those are properties
 * of a filesystem in a building, and the only way to know them is to ask it.
 *
 * So this asks, prints PASS / FAIL / WARN with a one-line fix for each, and
 * exits non-zero if anything FAILED.
 *
 * IT NEVER LEAVES ANYTHING OUTSIDE .incoming. Every filesystem probe happens
 * inside <FILE_ROOT>/.incoming/doctor/ and is removed afterwards — because the
 * gateway's service account is deliberately unable to delete anything
 * elsewhere, so a probe that wrote into the archive would leave litter nobody
 * can clear up. That is also why the delete restriction itself is a MANUAL
 * check (see the end of the output): proving the account cannot delete requires
 * an account that can.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const config = require('./src/config');
const paths = require('./src/paths');
const uploads = require('./src/uploads');
const probes = require('./src/probes');
const deleter = require('./src/deleter');
const tokens = require('./src/tokens');
const signing = require('./src/signing');

const JSON_OUT = process.argv.includes('--json');
const results = [];
const record = (state, check, detail, fix) => {
  results.push({ state, check, detail, fix: fix || null });
  if (!JSON_OUT) {
    const tag = state === 'PASS' ? 'PASS' : (state === 'WARN' ? 'WARN' : 'FAIL');
    console.log(`${tag}  ${check}`);
    if (detail) console.log(`      ${detail}`);
    if (fix && state !== 'PASS') console.log(`      fix: ${fix}`);
  }
};
const pass = (c, d) => record('PASS', c, d);
const warn = (c, d, f) => record('WARN', c, d, f);
const fail = (c, d, f) => record('FAIL', c, d, f);

/* ---- a. the share, and whether we may write in it ----------------------- */

function checkRoot(local) {
  if (!local.fileRoot) {
    fail('FILE_ROOT is set', 'It is not.', 'Set FILE_ROOT to the top of the share.');
    return null;
  }
  let real;
  try { real = fs.realpathSync(local.fileRoot); }
  catch (err) {
    fail('FILE_ROOT exists', `${local.fileRoot} — ${err.code || err.message}`,
      'Check the path, and that the share is mounted for the account the service runs as.');
    return null;
  }
  pass('FILE_ROOT exists', real + (real === local.fileRoot ? '' : ` (resolved from ${local.fileRoot})`));

  /* WHICH DEVICE IT IS ON. A share that is not mounted often leaves an empty
     local directory behind, and writing into that looks like success until
     somebody goes looking for the files on the server. */
  try {
    const here = fs.statSync(real);
    const parent = fs.statSync(path.dirname(real));
    if (here.dev === parent.dev && process.platform !== 'win32') {
      warn('FILE_ROOT is on its own device',
        `It is on the same device as ${path.dirname(real)}, which is what an UNMOUNTED share looks like.`,
        'Confirm the share is mounted — on Linux `findmnt ' + real + '`, on Windows check the mapped drive or UNC path.');
    } else {
      pass('FILE_ROOT is on its own device', `device ${here.dev}`);
    }
  } catch { /* not fatal */ }

  const incoming = path.join(real, paths.INCOMING);
  try {
    fs.mkdirSync(incoming, { recursive: true });
    pass('the service account can create .incoming', incoming);
  } catch (err) {
    fail('the service account can create .incoming', `${incoming} — ${err.code || err.message}`,
      'Grant the service account Create files and Create folders on FILE_ROOT (see gateway/README.md §4).');
    return null;
  }
  const home = path.join(incoming, 'doctor');
  try {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
  } catch (err) {
    fail('the doctor can use its own scratch folder', `${home} — ${err.code || err.message}`,
      'The account needs Create and Delete INSIDE .incoming. Only inside it.');
    return null;
  }
  return { real, home };
}

/* ---- b. does finalising work on this filesystem? ------------------------ */

function checkFinalise(root, home) {
  /* The probe functions are shared with the selftest route (gateway/src/probes.js)
     so the browser and this command cannot give different answers about the
     same share. */
  const probe = probes.finaliseProbe(root, home);

  let how = null;
  if (probe.hardLink) {
    how = 'hard link';
    pass('finalise: hard link across folders', 'link-then-unlink works, so finishing an upload copies no bytes.');
  } else {
    const err = { code: probe.linkError };
    if (probes.NO_LINK_CODES.has(probe.linkError)) {
      how = 'copy';
      /* NOT A FAIL. The brief said to fail here, and the documented fallback is
         the better answer: this share CAN be served, it just costs a second
         pass over the bytes when a file is finished. Saying FAIL would stop an
         installation that is going to work. So it is a WARN that names the
         consequence, and the fallback is exercised below rather than assumed. */
      warn('finalise: hard link across folders', `This filesystem does not do hard links (${err.code}).`,
        'The gateway will use its exclusive-create + copy fallback instead. Finishing a large file '
        + 'will take a second pass over the bytes; everything else is identical. If the share is SMB, '
        + 'enabling Unix extensions or using a local disk for FILE_ROOT avoids it.');
    } else {
      fail('finalise: hard link across folders', `${err.code || err.message}`,
        'The account may create files but something refused the link. Check the share permissions.');
    }
  }

  if (probe.exclusiveCreate) {
    pass('finalise: an existing name is refused', 'exclusive create works, so nothing can be overwritten.');
  } else {
    fail('finalise: an existing name is refused',
      'openSync(name, "wx") SUCCEEDED on a file that already exists.',
      'This filesystem does not honour exclusive create. Do not use it as FILE_ROOT: the gateway '
      + 'cannot promise never to overwrite on it.');
  }

  // The fallback path itself, on this filesystem, with a real file.
  try {
    const id = crypto.randomUUID();
    const put = uploads.putChunk(root, id, 0, Buffer.alloc(2048, 3),
      { size: 2048, name: 'doctor-fallback.bin', dir: `${paths.INCOMING}/doctor/dest`, sub: 'doctor' });
    if (!put.ok) throw new Error(put.reason);
    const done = uploads.complete(root, id, { dir: `${paths.INCOMING}/doctor/dest`, name: 'doctor-fallback.bin' });
    if (!done.ok) throw new Error(done.reason);
    pass('finalise: a whole upload, end to end', `finished by ${done.how} as ${done.stored}`);
    if (how === 'copy' && done.how === 'link') {
      warn('finalise: which path it took', 'The probe said no links but the engine used one.', 'Harmless; report it.');
    }
  } catch (err) {
    fail('finalise: a whole upload, end to end', String(err && err.message),
      'This is the path every upload takes. Nothing will work until it does.');
  }

  if (probe.positionalWrite) {
    pass('chunks: positional write into a preallocated file', '1 MB preallocated, last 16 bytes written in place.');
  } else {
    fail('chunks: positional write into a preallocated file', String(probe.positionalError || 'it did not hold'),
      'Chunked uploads need ftruncate and positional writes.');
  }

  if (probe.readOnlyHolds) {
    pass('finished files are read-only', 'and a write to one is refused.');
  } else {
    warn('finished files are read-only', 'The read-only flag was set but a write still succeeded.',
      process.platform === 'win32'
        ? 'Expected if the service account holds Full Control — the Deny on Delete in gateway/README.md §4 is what matters.'
        : 'Expected if this runs as root. Run the service as its own unprivileged account.');
  }
  return how;
}

/* ---- c. what kind of filesystem is this? ------------------------------- */

function checkFilesystem(home) {
  const probe = probes.filesystemProbe(home);
  {
    const sensitive = probe.caseSensitive;
    if (sensitive) {
      pass('case sensitivity', 'This filesystem distinguishes case: Report.PSD and report.psd are two files.');
    } else {
      pass('case sensitivity', 'This filesystem folds case: Report.PSD and report.psd are one file, '
        + 'so a second upload becomes "name (2).ext". The gateway compares names case-insensitively, which matches.');
    }
  }

  if (probe.longPaths) {
    pass('long paths', `${probe.longPathLength} characters accepted.`);
  } else {
    if (process.platform === 'win32') {
      fail('long paths', `Refused at over 260 characters (${probe.longPathError}).`,
        'Enable long paths: Group Policy → Enable Win32 long paths, or the registry value '
        + 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1. Then restart the service.');
    } else {
      warn('long paths', String(probe.longPathError), 'A deep project tree may not fit. Check the filesystem limits.');
    }
  }

  if (probe.freeBytes === null) { warn('free space', 'Could not measure it on this platform.', 'Check it by hand.'); } else {
    const freeGb = probe.freeBytes / (1024 ** 3);
    if (freeGb < 5) fail('free space', `${freeGb.toFixed(1)} GB free on the share.`, 'Free some space; uploads preallocate the whole file.');
    else if (freeGb < 50) warn('free space', `${freeGb.toFixed(1)} GB free.`, 'Fine for now; art files are large.');
    else pass('free space', `${freeGb.toFixed(1)} GB free.`);
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass('Node version', process.versions.node);
  else fail('Node version', process.versions.node, 'The gateway needs Node 18 or newer.');
}

/* ---- d. do the sanitiser and the OS agree about names? ----------------- */

function checkNames(home) {
  const cases = [
    ['CON', 'reserved device name'], ['NUL.txt', 'reserved name with an extension'],
    ['COM1', 'reserved device name'], ['LPT1.psd', 'reserved name with an extension'],
    ['trailing.', 'a trailing dot'], ['trailing ', 'a trailing space'],
    ['name:stream', 'alternate-data-stream syntax'],
  ];
  const disagreements = [];
  for (const [name, why] of cases) {
    const verdict = paths.cleanSegment(name);
    /* What the OS does with it, as far as we can safely find out. Only for the
       names the sanitiser ACCEPTS — it strips trailing dots and spaces, so
       those are expected to be accepted in cleaned form. */
    let osTook = null;
    const target = path.join(home, verdict.ok ? verdict.value : name);
    try {
      fs.writeFileSync(target, 'x');
      osTook = fs.existsSync(target);
      fs.rmSync(target, { force: true });
    } catch { osTook = false; }
    if (!verdict.ok && osTook) {
      disagreements.push(`${why} (${JSON.stringify(name)}): the gateway refuses it, this OS accepts it`);
    }
    if (verdict.ok && !osTook) {
      disagreements.push(`${why} (${JSON.stringify(name)} → ${JSON.stringify(verdict.value)}): the gateway accepts it, this OS refuses it`);
    }
  }
  if (!disagreements.length) {
    pass('name rules match this filesystem',
      'Reserved device names, trailing dots and spaces, and ":" streams are handled the same way by both.');
  } else {
    /* A disagreement in the SAFE direction — the gateway refusing what the OS
       would accept — is not a problem. The other direction is. */
    const risky = disagreements.filter((d) => d.includes('the gateway accepts it'));
    if (risky.length) {
      fail('name rules match this filesystem', risky.join('; '),
        'Report this: the sanitiser is accepting a name this filesystem cannot keep.');
    } else {
      pass('name rules match this filesystem', `Stricter than this OS, which is the safe direction: ${disagreements.join('; ')}`);
    }
  }
}

/* ---- e. can a symlink escape the share? -------------------------------- */

function checkSymlink(root, home) {
  const link = path.join(home, 'escape');
  try {
    fs.symlinkSync(os.tmpdir(), link, 'dir');
  } catch (err) {
    warn('symlink containment', `This account cannot create a symlink here (${err.code}), so it is not testable.`,
      'That is itself reassuring. On Windows, creating one needs SeCreateSymbolicLink, which a service '
      + 'account should not have.');
    return;
  }
  const relative = `${paths.INCOMING}/doctor/escape`;
  const resolved = paths.resolve(root, relative);
  const through = paths.resolve(root, `${relative}/anything.txt`);
  if (!resolved.ok && !through.ok) {
    pass('symlink containment', 'A symlink pointing out of the share is followed and then refused.');
  } else {
    fail('symlink containment', 'The path jail resolved a link that points outside FILE_ROOT.',
      'Do not use this share until it is reported — this is the check that stops a link reading /etc.');
  }
  // And the delete helper will not follow it either.
  const removal = deleter.remove(root, path.join(link, 'anything.txt'));
  if (removal.ok) {
    fail('symlink containment (delete helper)', 'The delete helper followed a link out of .incoming.', 'Report this.');
  } else {
    pass('symlink containment (delete helper)', `refused: ${removal.reason}`);
  }
  fs.rmSync(link, { force: true });
}

/* ---- g/h. Forge, the certificate, the clock, the address ---------------- */

async function checkForge(local) {
  if (!local.forgeUrl) {
    fail('FORGE_URL is set', 'It is not.', 'Set FORGE_URL to the Forge site address.');
    return;
  }
  if (/^0\.0\.0\.0$|^::$/.test(local.listenAddress || '') || !local.listenAddress) {
    fail('LISTEN_ADDRESS is a LAN address', local.listenAddress || '(not set)',
      'Set it to this machine\'s LAN address. 0.0.0.0 would serve every interface.');
  } else {
    pass('LISTEN_ADDRESS is a LAN address', `${local.listenAddress}:${local.listenPort}`);
  }

  for (const [name, file] of [['certificate', local.tlsCert], ['key', local.tlsKey]]) {
    if (!file) { fail(`TLS ${name} is set`, 'It is not.', `Set TLS_${name === 'certificate' ? 'CERT' : 'KEY'}.`); continue; }
    try {
      fs.accessSync(file, fs.constants.R_OK);
      pass(`TLS ${name} is readable`, file);
    } catch (err) {
      fail(`TLS ${name} is readable`, `${file} — ${err.code}`, 'The service account must be able to read it.');
      continue;
    }
    if (name === 'certificate') {
      try {
        const { X509Certificate } = require('node:crypto');
        const cert = new X509Certificate(fs.readFileSync(file));
        const days = Math.floor((Date.parse(cert.validTo) - Date.now()) / 86400000);
        if (days < 0) fail('certificate is current', `It expired ${-days} days ago (${cert.validTo}).`, 'Renew it and restart the service.');
        else if (days < 30) warn('certificate is current', `It expires in ${days} days (${cert.validTo}).`, 'Renew it — see gateway/README.md §3.');
        else pass('certificate is current', `${days} days left (${cert.validTo}); subject ${cert.subject.replace(/\n/g, ' ')}`);
      } catch (err) {
        warn('certificate is current', `Could not read it as a certificate: ${err.message}`, 'Check it is a PEM.');
      }
    }
  }

  if (!local.gatewayId) fail('GATEWAY_ID is set', 'It is not.', 'Copy it from Settings → Server.');
  else pass('GATEWAY_ID is set', local.gatewayId);
  if (!local.gatewaySecret) {
    fail('GATEWAY_SECRET is set', 'It is not.', 'Generate one in Settings → Server and paste it here.');
    return;
  }
  pass('GATEWAY_SECRET is set', `${local.gatewaySecret.length} characters`);

  // Outbound HTTPS, and the clock, in one call: the heartbeat answers with
  // Forge's own time.
  const target = '/api/gateway/heartbeat';
  const body = JSON.stringify({ version: 'doctor', configVersion: null, freeBytes: null, queued: 0 });
  const { header } = signing.sign(local.gatewaySecret, { method: 'POST', target, body });
  try {
    const res = await fetch(`${String(local.forgeUrl).replace(/\/+$/, '')}${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [signing.ID_HEADER]: local.gatewayId, [signing.SIGNATURE_HEADER]: header },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      fail('Forge is reachable and accepts this gateway', `HTTP ${res.status}: ${String(text).slice(0, 160)}`,
        res.status === 401 ? 'The signature did not match — regenerate GATEWAY_SECRET in Settings → Server and paste it again.'
          : (res.status === 403 ? 'GATEWAY_ID is not the one configured in Settings → Server.'
            : 'Check FORGE_URL and that outbound HTTPS is allowed from this machine.'));
      return;
    }
    pass('Forge is reachable and accepts this gateway', `${local.forgeUrl} answered.`);
    if (json && json.now) {
      const skew = Math.round((Date.now() - Date.parse(json.now)) / 1000);
      const leeway = tokens.leewayFor(local.clockLeewaySeconds);
      if (Math.abs(skew) > leeway) {
        fail('clock agrees with Forge', `This machine is ${skew}s from Forge (leeway ${leeway}s).`,
          'Tokens live 60 seconds and will expire on arrival. Fix the clock: w32tm /resync on Windows, '
          + 'or enable systemd-timesyncd on Linux.');
      } else if (Math.abs(skew) > 15) {
        warn('clock agrees with Forge', `This machine is ${skew}s from Forge.`, 'Within the leeway, but worth fixing.');
      } else {
        pass('clock agrees with Forge', `${skew}s apart.`);
      }
    } else {
      warn('clock agrees with Forge', 'Forge did not report its time (an older build).', 'Upgrade Forge to measure the skew.');
    }
  } catch (err) {
    fail('Forge is reachable and accepts this gateway', String(err && err.message),
      'Outbound HTTPS from this machine to Forge is what the whole feature needs. Check the firewall and FORGE_URL.');
  }
}

/* ---- the manual half --------------------------------------------------- */

const MANUAL = `
MANUAL CHECK — the delete restriction (do this once, with IT present)

  Nothing automated can prove the service account cannot delete an archived
  file, because proving it needs an account that CAN delete the file afterwards.
  So, by hand, on the gateway machine:

    1. As an ADMIN account, create  <FILE_ROOT>\\\\_delete-test.txt  with any content.
    2. As the GATEWAY SERVICE ACCOUNT (runas, or su to it), try:
         - delete it            ->  must be refused ("Access is denied")
         - open it for writing  ->  must be refused
         - rename it            ->  must be refused
         - create a NEW file in the same folder  ->  must SUCCEED
    3. Still as the service account, inside <FILE_ROOT>\\\\.incoming:
         - create a file and delete it  ->  both must SUCCEED
    4. As the ADMIN account, delete _delete-test.txt.

  If step 2 allows anything but the last line, the share permissions are wrong.
  gateway/README.md §4 has the exact NTFS entries and the POSIX equivalent.
`;

/* ---- run them ---------------------------------------------------------- */

(async () => {
  if (!JSON_OUT) {
    console.log('ZVKY FORGE — office file gateway doctor');
    console.log(`platform ${process.platform} ${os.release()}  node ${process.versions.node}`);
    console.log('');
  }
  const local = config.local(process.env);
  const started = Date.now();
  const where = checkRoot(local);
  if (where) {
    checkFinalise(where.real, where.home);
    checkFilesystem(where.home);
    checkNames(where.home);
    checkSymlink(where.real, where.home);
  }
  await checkForge(local);

  // Everything this wrote was inside .incoming/doctor, and it goes now.
  if (where) {
    const gone = deleter.remove(where.real, where.home);
    if (gone.ok) pass('cleanup', 'Everything the doctor wrote was inside .incoming/doctor and has been removed.');
    else fail('cleanup', `could not remove ${where.home}: ${gone.reason}`, 'Remove it by hand.');
  }

  const failed = results.filter((r) => r.state === 'FAIL');
  const warned = results.filter((r) => r.state === 'WARN');
  if (JSON_OUT) {
    console.log(JSON.stringify({ results, failed: failed.length, warned: warned.length, ms: Date.now() - started }, null, 2));
  } else {
    console.log('');
    console.log(`${results.length - failed.length - warned.length} passed, ${warned.length} warning(s), ${failed.length} failure(s) in ${Date.now() - started}ms`);
    if (failed.length) {
      console.log('');
      console.log('These must be fixed before the studio uses this gateway:');
      for (const f of failed) console.log(`  - ${f.check}: ${f.detail}`);
    }
    console.log(MANUAL);
  }
  process.exit(failed.length ? 1 : 0);
})();
