/* Ad-hoc signing, on macOS, when there is no certificate.
 *
 * WITHOUT THIS, THE APPLE SILICON BUILD DOES NOT START. Not "shows a warning" —
 * macOS on arm64 refuses to execute a binary carrying no signature at all, so
 * the app is killed at launch and the person sees "damaged and can't be
 * opened". An Intel build survives unsigned; an Apple Silicon one does not, and
 * that is most Macs bought since 2020.
 *
 * An AD-HOC signature is the answer, and it is free: it identifies nobody and
 * satisfies nothing about trust, but it makes the binary loadable. Gatekeeper
 * still shows its first-open prompt, which the README already explains.
 *
 * electron-builder does not do this itself. `mac.identity: null` — which is
 * what "unsigned, as agreed" means in that file — takes an early return in its
 * signing step and applies nothing. So this runs afterwards, from the hook it
 * provides.
 *
 * IT SIGNS ONLY WHEN THERE IS NOTHING BETTER. Given a real Developer ID
 * certificate in the environment, it stands aside and lets electron-builder do
 * the proper job; an ad-hoc signature applied over a real one would be a
 * downgrade nobody asked for.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (process.platform !== 'darwin') {
    /* Said loudly, because the artifact is the problem rather than the build:
       it will finish, produce a .app, and that .app will not run on half the
       Macs it reaches. */
    console.log('');
    console.log('  !! NOT SIGNED — codesign exists only on macOS.');
    console.log(`  !! ${appName} will not launch on Apple Silicon.`);
    console.log('  !! Build this on a Mac or a macOS runner.');
    console.log('');
    return;
  }

  // A real certificate beats an ad-hoc one; leave it alone.
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD) {
    console.log('  • a signing certificate is configured; skipping ad-hoc signing');
    return;
  }

  console.log(`  • ad-hoc signing ${appName} (${context.arch === 1 ? 'x64' : 'arm64'})`);
  const signed = run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  if (signed.status !== 0) {
    throw new Error(`codesign failed:\n${signed.stderr || signed.stdout}`);
  }

  /* Verified rather than assumed. A signature that did not take produces an app
     that fails at launch on somebody else's machine, which is the worst place
     to find out. */
  const checked = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (checked.status !== 0) {
    throw new Error(`the ad-hoc signature did not verify:\n${checked.stderr || checked.stdout}`);
  }
  console.log('  • signature verified');
};
