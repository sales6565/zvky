#!/usr/bin/env node
/* The .plist that makes an itms-services:// link work.
 *
 * WHAT THIS FILE IS FOR. iOS will not install an .ipa from a link. It installs
 * from a MANIFEST — a plist naming the .ipa's URL, the bundle id, the version
 * and a couple of images — and the install link points at the manifest, not the
 * app:
 *
 *   itms-services://?action=download-manifest&url=https://host/path/manifest.plist
 *
 * THREE THINGS THAT MAKE THIS FAIL, all of them silently:
 *   1. The manifest and the .ipa must BOTH be served over HTTPS with a
 *      certificate iOS trusts. A self-signed certificate fails with no message.
 *   2. The URL inside the manifest must be absolute and public. iOS fetches the
 *      .ipa from its own installer daemon, NOT from Safari — so a URL that only
 *      works with a logged-in session will fail. See the note in the README.
 *   3. The bundle id and version must match what is actually inside the .ipa,
 *      or the install dies at "Unable to Install".
 *
 * Usage:
 *   node scripts/make-ios-manifest.js --base https://zvkydesign.com/m/TOKEN \
 *     [--version 1.0.0] [--out ../dist-mobile/manifest.plist]
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const base = arg('base', '');
if (!base) {
  console.error('Give --base, the public HTTPS directory the .ipa and this manifest are served from.');
  console.error('  node scripts/make-ios-manifest.js --base https://zvkydesign.com/m/TOKEN');
  process.exit(1);
}
if (!base.startsWith('https://')) {
  console.error(`--base must be https:// — iOS refuses anything else. Got: ${base}`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf8'));
const trimmed = base.replace(/\/+$/, '');
const version = arg('version', '1.0.0');
const out = arg('out', path.join(__dirname, '..', '..', 'dist-mobile', 'manifest.plist'));

/* The images are REQUIRED by the format even though nothing shows them for an
   Ad Hoc install. Pointed at the icons the install page already serves rather
   than invented, so a missing file is visible on that page too. */
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${trimmed}/zvky.ipa</string>
        </dict>
        <dict>
          <key>kind</key><string>display-image</string>
          <key>url</key><string>${trimmed}/icon-57.png</string>
        </dict>
        <dict>
          <key>kind</key><string>full-size-image</string>
          <key>url</key><string>${trimmed}/icon-512.png</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${cfg.appId}</string>
        <key>bundle-version</key><string>${version}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${cfg.appName}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, plist);

console.log(`Wrote ${out}`);
console.log(`  bundle id : ${cfg.appId}`);
console.log(`  version   : ${version}`);
console.log(`  ipa URL   : ${trimmed}/zvky.ipa`);
console.log('');
console.log('The install link, which is what goes on the install page:');
console.log(`  itms-services://?action=download-manifest&url=${trimmed}/manifest.plist`);
