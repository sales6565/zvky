#!/usr/bin/env node
/* Putting a finished build on the download page.
 *
 * The download page is a parentless branch holding installers and one README
 * that links them — somewhere a person can click once, rather than unpacking a
 * build artifact that expires in a week.
 *
 * This runs on the CI runner after a build, and does three things:
 *
 *   Copies each installer onto the page, SPLITTING any file GitHub will not
 *   hold. Its limit is 100 MiB and a Mac disk image lands near it; a download
 *   that needs one command to rejoin beats one that does not exist.
 *
 *   Records a checksum for each, so somebody can tell a truncated download
 *   from a whole one.
 *
 *   Rewrites ONE section of the README and leaves the rest alone. The Windows
 *   half was written by hand and must survive a Mac build, and the reverse.
 *
 * It is deliberately a script in the repository rather than lines inside the
 * workflow: this is the part with logic in it, and logic buried in YAML is
 * neither reviewable nor runnable anywhere else.
 *
 *   node desktop/ci/publish-page.js <incoming dir> <page dir> <platform>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [incoming, page, platform] = process.argv.slice(2);
if (!incoming || !page || !platform) {
  console.error('usage: publish-page.js <incoming dir> <page dir> <mac|windows>');
  process.exit(2);
}

/* GitHub refuses a file over 100 MiB outright and warns above 50. The margin
   below leaves room rather than sitting on the line. */
const LIMIT = 95 * 1024 * 1024;
const PART_SIZE = 90 * 1024 * 1024;

const SECTIONS = {
  mac: {
    heading: '## Mac',
    match: /\.dmg$/,
    intro: [
      'Built and **ad-hoc signed** on macOS, which is what lets the Apple Silicon',
      'version start at all — a Mac with an Apple chip refuses to launch a program',
      'carrying no signature whatsoever.',
      '',
      'It still has no certificate, so there is one thing to know:',
      '',
      '**Do not double-click the app the first time.** macOS refuses to open an',
      'unsigned application that way and offers only Cancel, which reads as a broken',
      'download. Instead: open the .dmg, drag ZVKY FORGE to Applications, then',
      '**right-click it in Applications → Open → Open**. That is Apple\'s supported',
      'way to run an unsigned app, not a trick, and it is needed once.',
      '',
      'Take the **arm64** file for any Mac bought since late 2020, and the other for',
      'an Intel Mac. Unsure which you have? Apple menu → About This Mac.',
    ].join('\n'),
  },
  windows: {
    heading: '## Windows',
    match: /\.exe$/,
    intro: [
      'Run the installer. You will see a blue screen: *"Windows protected your PC —',
      'unrecognised publisher."* That is expected — the installer is not code-signed,',
      'a certificate the studio has not bought rather than anything wrong with the',
      'file. Click **More info**, then **Run anyway**.',
      '',
      'It installs for **you**, not the whole machine, so it does not ask for an',
      'administrator password.',
    ].join('\n'),
  },
};

const section = SECTIONS[platform];
if (!section) {
  console.error(`unknown platform "${platform}" — expected one of: ${Object.keys(SECTIONS).join(', ')}`);
  process.exit(2);
}

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const mb = (bytes) => Math.round(bytes / 1000000);

/* A name that survives being a URL. Spaces work but read badly in a link and
   trip up anyone who pastes one into a terminal. */
const webName = (name) => name.replace(/ /g, '-');

function place(file) {
  const source = path.join(incoming, file);
  const name = webName(file);
  const size = fs.statSync(source).size;
  const sum = sha256(source);
  const lines = [`### ${name}`, ''];

  if (size < LIMIT) {
    fs.copyFileSync(source, path.join(page, name));
    lines.push(`**[${name}](${name})** — ${mb(size)} MB. Click it, then **Download**.`);
  } else {
    /* Too big for one file. Split, and say plainly how to put it back — with
       the command for the platform the file is for, since somebody collecting
       a Mac build is on a Mac. */
    for (const stale of fs.readdirSync(page)) {
      if (stale.startsWith(`${name}.part`)) fs.unlinkSync(path.join(page, stale));
    }
    execFileSync('split', ['-b', String(PART_SIZE), '-d', '-a', '1', source,
      path.join(page, `${name}.part`)]);
    const parts = fs.readdirSync(page).filter((f) => f.startsWith(`${name}.part`)).sort();
    lines.push(
      `${mb(size)} MB — too large for GitHub to hold in one piece, so it is in`,
      `${parts.length} parts. Download all of them into one folder:`,
      '',
      ...parts.map((p) => `- [${p}](${p})`),
      '',
      'Then rejoin them:',
      '',
      '```',
      platform === 'windows'
        ? `copy /b ${parts.join(' + ')} "${file}"`
        : `cat ${name}.part* > "${file}"`,
      '```',
    );
  }

  lines.push('', `sha256 \`${sum}\``, '');
  return lines.join('\n');
}

const files = fs.readdirSync(incoming).filter((f) => section.match.test(f)).sort();
if (!files.length) {
  console.error(`nothing matching ${section.match} in ${incoming}`);
  process.exit(1);
}
console.log(`placing ${files.length} file(s) for ${platform}:`);
for (const f of files) console.log(`  ${f} (${mb(fs.statSync(path.join(incoming, f)).size)} MB)`);

// Carried along so an installed copy can find out a newer one exists.
for (const extra of ['latest-mac.yml', 'latest.yml']) {
  const from = path.join(incoming, extra);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(page, extra));
}

const body = [section.heading, '', section.intro, '', ...files.map(place)].join('\n');

/* Replace this platform's section and nothing else. Splitting on the headings
   rather than rewriting the file means the other platform's instructions, and
   anything written by hand above them, come through untouched. */
const readme = path.join(page, 'README.md');
const existing = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '# ZVKY FORGE\n';
const headings = Object.values(SECTIONS).map((s) => s.heading);
const parts = existing.split(new RegExp(`\\n(?=${headings.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}\\n)`));
const kept = parts.filter((p) => !p.startsWith(section.heading));

fs.writeFileSync(readme, `${[...kept.map((p) => p.trimEnd()), body.trimEnd()].join('\n\n')}\n`);
console.log(`rewrote the ${platform} section of README.md`);
