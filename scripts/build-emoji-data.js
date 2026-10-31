#!/usr/bin/env node
/* Builds public/emoji-data.json, the picker's entire vocabulary.
 *
 * WHY THERE IS A BUILD STEP AND NOT A DEPENDENCY. The picker has to work on the
 * studio's office network with no CDN and no font download, and the page's CSP
 * must not need a new host — so the data is a static file this server serves.
 * It is also 1,914 emoji, which is not something to hand-maintain and not
 * something to ship in index.html: it loads lazily, the first time somebody
 * opens the picker, and page load does not grow by a byte.
 *
 * THE SOURCE is the npm package `unicode-emoji-json`, which is Unicode's own
 * emoji-test.txt turned into JSON. MIT licensed, © 2019 Mu-An Chiou. It is NOT
 * a dependency of this application: it is fetched once, here, by somebody
 * regenerating the file, and nothing in src/ or public/ requires it at runtime.
 *
 *   npm pack unicode-emoji-json && tar xzf unicode-emoji-json-*.tgz
 *   node scripts/build-emoji-data.js ./package
 *
 * THE SHAPE IS ARRAYS, NOT OBJECTS, and that is the difference between a file
 * worth loading lazily and one worth worrying about: {"name":…,"group":…} per
 * emoji costs more in keys than in data. Each entry is [char, name, skin] and
 * the group is the array it is in.
 */
const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-emoji-data.js <path to the unpacked unicode-emoji-json package>');
  process.exit(1);
}

const byEmoji = JSON.parse(fs.readFileSync(path.join(src, 'data-by-emoji.json'), 'utf8'));
const components = JSON.parse(fs.readFileSync(path.join(src, 'data-emoji-components.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));

/* THE EIGHT TABS THE STUDIO ASKED FOR, over the nine groups Unicode uses.
   Smileys & Emotion and People & Body are one tab: a person looking for a
   waving hand does not know which of those Unicode puts it in, and 559 entries
   is a perfectly ordinary tab. */
const TABS = [
  ['smileys', 'Smileys & People', ['Smileys & Emotion', 'People & Body']],
  ['nature', 'Animals & Nature', ['Animals & Nature']],
  ['food', 'Food & Drink', ['Food & Drink']],
  ['activities', 'Activities', ['Activities']],
  ['travel', 'Travel & Places', ['Travel & Places']],
  ['objects', 'Objects', ['Objects']],
  ['symbols', 'Symbols', ['Symbols']],
  ['flags', 'Flags', ['Flags']],
];

const groups = TABS.map(([key, label, unicodeGroups]) => {
  const emoji = [];
  for (const [char, meta] of Object.entries(byEmoji)) {
    if (!unicodeGroups.includes(meta.group)) continue;
    /* THE SKIN-TONE FLAG AS 1 OR ABSENT, because 330 of 1,914 carry it and
       `0` on the other 1,584 is 1.5KB of zeroes. */
    emoji.push(meta.skin_tone_support ? [char, meta.name, 1] : [char, meta.name]);
  }
  return { key, label, emoji };
});

const total = groups.reduce((n, g) => n + g.emoji.length, 0);
const highest = Object.values(byEmoji)
  .reduce((max, e) => (parseFloat(e.emoji_version) > parseFloat(max) ? e.emoji_version : max), '0');

const out = {
  /* WHAT THIS IS AND WHERE IT CAME FROM, in the file itself — so somebody
     reading it in a year does not have to find this script to know. */
  source: 'unicode-emoji-json (npm), built from unicode.org emoji-test.txt',
  sourceVersion: pkg.version,
  licence: 'MIT, © 2019 Mu-An Chiou. Emoji names and groupings are Unicode® data.',
  emojiVersion: highest,
  built: new Date().toISOString().slice(0, 10),
  count: total,
  /* The five modifiers, in the order a picker shows them. Keyed, because the
     page stores the CHOICE and not the character. */
  skinTones: [
    ['default', ''],
    ['light', components.light_skin_tone],
    ['medium-light', components.medium_light_skin_tone],
    ['medium', components.medium_skin_tone],
    ['medium-dark', components.medium_dark_skin_tone],
    ['dark', components.dark_skin_tone],
  ],
  groups,
};

const dest = path.join(__dirname, '..', 'public', 'emoji-data.json');
fs.writeFileSync(dest, JSON.stringify(out));
const bytes = fs.statSync(dest).size;
console.log(`public/emoji-data.json: ${total} emoji, Unicode Emoji ${highest}, `
  + `${(bytes / 1024).toFixed(1)} KB (${groups.map((g) => `${g.key} ${g.emoji.length}`).join(', ')})`);
