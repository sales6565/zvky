#!/usr/bin/env node
/* Building the installers.
 *
 * A thin wrapper around electron-builder that exists for one reason: the update
 * address must be OPTIONAL. Written into electron-builder.yml as a
 * ${env.ZVKY_UPDATE_FEED} macro it is not — electron-builder refuses to build
 * when the variable is unset, which makes "where updates come from" a
 * prerequisite for producing an installer at all.
 *
 * So it is passed on the command line when it is there, left out when it is
 * not, and either way the build says which of those happened. A studio that has
 * not set up update hosting yet still gets a working application; it just
 * cannot update itself, and is told so here rather than discovering it later.
 *
 *   npm run build:win
 *   ZVKY_UPDATE_FEED=https://your-domain.com/desktop/ npm run build:win
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('Usage: node scripts/build.js --win | --mac | --win --mac');
  process.exit(2);
}

const feed = (process.env.ZVKY_UPDATE_FEED || '').trim();
const args = [...targets, '--publish', 'never'];

if (feed) {
  /* Generic provider: a directory served over HTTPS. The trailing slash matters
     to electron-updater, so it is added here rather than left to whoever typed
     the variable. */
  const url = feed.endsWith('/') ? feed : `${feed}/`;
  args.push('-c.publish.provider=generic', `-c.publish.url=${url}`, '-c.publish.channel=latest');
  console.log(`Update feed: ${url}`);
} else {
  console.log('Update feed: NOT SET.');
  console.log('  The installers will work, and "Check for Updates" will report that');
  console.log('  no update information was published. Set ZVKY_UPDATE_FEED to the');
  console.log('  folder on your hosting where latest.yml and the installers live,');
  console.log('  then build again — the address is baked into the package.');
}

if (targets.includes('--mac') && process.platform !== 'darwin') {
  /* Said before the build rather than after it fails: a .dmg is made with
     Apple's own tooling (hdiutil), which exists only on macOS. There is no flag
     for this and no cross-compiler. */
  console.log('');
  console.log('macOS: a .dmg cannot be built on ' + process.platform + '.');
  console.log('  hdiutil is part of macOS and has no equivalent elsewhere. Build it on');
  console.log('  a Mac, or on a macOS CI runner — see desktop/README.md.');
  console.log('');
}

const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder');
const run = spawnSync(bin, args, { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
