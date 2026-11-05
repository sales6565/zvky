/* THE ART / ANIMATION CLASSIFICATION — one rule, two readers, held equal here.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS.
 *
 * The Dashboard's Art and Animation sub-tabs and the folder a Submit Work
 * upload lands in are the same question asked twice. Before Prompt 52 they were
 * answered by different fields: the sub-tabs by `assets.type`, the folder by
 * `assets.category` — a list that ships EMPTY, so every lookup missed and every
 * upload in the studio went to the fallback folder "Work".
 *
 * They now both call assetDiscipline(). The browser cannot require() a module —
 * this application has no build step between src/ and public/index.html, and
 * the deploy ships `src public sql app.js` with nothing bundling them — so the
 * page carries a copy, and this file is what makes the copy safe:
 *
 *   1. the two function bodies are compared CHARACTER FOR CHARACTER,
 *   2. and both are run over one matrix of inputs,
 *   3. and the dashboard's sub-tabs and the upload folder are run over the same
 *      assets and compared with each other.
 *
 * Anything else — a behavioural matrix alone — passes while the two copies
 * diverge on an input nobody thought of.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'asset-discipline.js'), 'utf8');

const discipline = require('../src/asset-discipline');
const serverLink = require('../src/server-link');

/* One declaration out of the page, evaluated here — the mechanism
   tests/dashboard-lens.test.js and tests/asset-workflow.test.js use. */
function grab(text, opener, closer = '\n}') {
  const at = text.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener}`);
  const rest = text.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

/* TWO FUNCTIONS ARE MIRRORED NOW, not one, and that is the price of the second
   field: a rule that reads a MAPPING needs the mapping built identically on
   both sides, or the page and the server disagree about a category whose
   discipline is blank, or stored in another letter case, or keyed by `id` on one
   side and `key` on the other. */
const SIGNATURES = [
  'function disciplineMap(categories) {',
  'function assetDiscipline(asset, categories) {',
];
const pageFn = grab(PAGE, SIGNATURES[1]);
const moduleFn = grab(MODULE_SRC, SIGNATURES[1]);

/* The page's copies, plus the two things that read them there. `categories` is
   whatever a test seeds: the list the page holds at runtime. */
const page = (categories = []) => new Function('CATEGORIES', `${grab(PAGE, 'const ASSET_DISCIPLINES = [', '\n];')}
  ${grab(PAGE, SIGNATURES[0])}
  ${grab(PAGE, 'let CATEGORY_DISCIPLINE = new Map();', ';')}
  ${pageFn}
  ${grab(PAGE, 'const BOARD_LENS = [', '\n];')}
  CATEGORY_DISCIPLINE = disciplineMap(CATEGORIES);
  return { assetDiscipline, disciplineMap, ASSET_DISCIPLINES, BOARD_LENS, CATEGORY_DISCIPLINE };`)(categories);

/* The category list a studio that has filled it in has. Deliberately includes a
   category whose discipline is MISSING and one whose discipline is a word
   neither side knows, because those are the two shapes a mapping built twice
   can disagree about. */
const CATEGORIES = [
  { id: 'animation', key: 'animation', label: 'Animation', discipline: 'animation' },
  { id: 'fx_animation', key: 'fx_animation', label: 'FX Animation', discipline: 'animation' },
  { id: 'characters', key: 'characters', label: 'Characters', discipline: 'art' },
  { id: 'props', key: 'props', label: 'Props' },
  { id: 'layout', key: 'layout', label: 'Layout', discipline: 'rigging' },
  { id: 'upper', key: 'upper', label: 'Upper', discipline: 'ANIMATION' },
];

/* Every seeded asset type, plus the shapes a field can really take. */
const TYPES = [
  ...require('../src/reference-defaults').ASSET_TYPES.map((t) => t.key),
  'rigging', 'layout', 'ANIMATION', 'Animation', ' animation ', 'animations', 'anim', '', null, undefined,
];

test('the page and the server hold the SAME rule, character for character', () => {
  for (const signature of SIGNATURES) {
    assert.strictEqual(grab(PAGE, signature), grab(MODULE_SRC, signature),
      `public/index.html and src/asset-discipline.js must hold the identical ${
        signature} — edit neither copy alone`);
  }

  /* AND IT READS EXACTLY TWO FIELDS OF THE ASSET: the type and the category.
   *
   * THIS ASSERTION USED TO SAY THE OPPOSITE — "the rule reads the type and
   * nothing else", with `category` in a list of forbidden words — and it was
   * the bug, written down and enforced. An asset whose category said Animation
   * could not appear under the Animation tab, and this test is what would have
   * refused the fix. It is inverted deliberately, and the forbidden list keeps
   * everything else out: the rule is about the piece of work, not about who
   * holds it or what state it is in. */
  assert.match(moduleFn, /asset && asset\.type/, 'it reads the asset type');
  assert.match(moduleFn, /asset && asset\.category/, 'and the asset category');
  assert.ok(!/project|assignee|status|\brole\b|designation/.test(moduleFn),
    `the rule reads the type and the category and nothing else: ${moduleFn}`);

  /* AND THE SUB-TABS CALL IT rather than holding a copy of the comparison.
     Asserted on the source, because a copy that happens to agree today passes
     every behavioural test there is: `a.type !== 'animation'` is the rule the
     lens used to carry, and it differs from the shared function only on inputs
     a matrix has to think to include. The point of the shared function is that
     there is one place to change. */
  for (const l of page().BOARD_LENS) {
    assert.match(String(l.match), /assetDiscipline\(/,
      `the ${l.id} sub-tab must ask assetDiscipline(), not compare types itself: ${l.match}`);
  }

  // And the list of disciplines is the same list, in the same order.
  assert.deepStrictEqual(page().ASSET_DISCIPLINES, discipline.DISCIPLINES);
  assert.deepStrictEqual(discipline.DISCIPLINE_IDS, ['art', 'animation'],
    'two disciplines, Art first — the order the sub-tabs show them in');
});

test('both copies answer identically for every type, and only ever art or animation', () => {
  const mine = page().assetDiscipline;
  for (const type of TYPES) {
    const asset = { id: 'a1', type, category: 'something-else', project_id: 'p1' };
    const server = discipline.assetDiscipline(asset);
    assert.strictEqual(mine(asset), server, `disagreed about type ${JSON.stringify(type)}`);
    assert.ok(discipline.DISCIPLINE_IDS.includes(server),
      `${JSON.stringify(type)} produced ${server}, which is not a discipline`);
  }

  /* AND OVER EVERY (TYPE, CATEGORY) PAIR, with the mapping seeded on both
     sides. One matrix, two copies, including the categories whose stored
     discipline is missing or unrecognised — which is where two hand-built maps
     drift apart. */
  const seeded = page(CATEGORIES);
  const serverMap = discipline.disciplineMap(CATEGORIES);
  const KEYS = [...CATEGORIES.map((c) => c.key), 'ANIMATION', ' animation ', 'nonesuch', '', null, undefined];
  for (const type of TYPES) {
    for (const category of KEYS) {
      const asset = { id: 'a1', type, category, project_id: 'p1' };
      const onServer = discipline.assetDiscipline(asset, serverMap);
      assert.strictEqual(seeded.assetDiscipline(asset, seeded.CATEGORY_DISCIPLINE), onServer,
        `disagreed about ${JSON.stringify({ type, category })}`);
      assert.ok(discipline.DISCIPLINE_IDS.includes(onServer),
        `${JSON.stringify({ type, category })} produced ${onServer}, not a discipline`);
      /* AND THE LIST IS AS GOOD AS THE MAP, because a caller with one asset
         passes the list and should not have to know. */
      assert.strictEqual(discipline.assetDiscipline(asset, CATEGORIES), onServer,
        'the list and the Map must classify identically');
    }
  }

  // The two mappings, built separately, are the same mapping.
  assert.deepStrictEqual([...seeded.CATEGORY_DISCIPLINE.entries()].sort(),
    [...serverMap.entries()].sort(),
    'the page and the server build the same category -> discipline mapping');
  // The named halves, explicitly.
  assert.strictEqual(discipline.assetDiscipline({ type: 'animation' }), 'animation');
  assert.strictEqual(discipline.assetDiscipline({ type: 'character' }), 'art');
  /* NO TYPE AT ALL IS ART, which is what the sub-tabs have always done —
     `a.type !== 'animation'` put it in Art — and changing that would move
     assets between tabs for a folder feature's convenience. */
  assert.strictEqual(discipline.assetDiscipline({}), 'art');
  assert.strictEqual(discipline.assetDiscipline(undefined), 'art');
  /* CASE AND PADDING are folded, which cannot change the Dashboard: a type is a
     reference KEY and toKey() in src/reference-data.js lowercases and strips
     everything else before it is ever stored. It matters for the page, which
     reads whatever the API sends it. */
  assert.strictEqual(discipline.assetDiscipline({ type: 'ANIMATION' }), 'animation');
  assert.strictEqual(discipline.assetDiscipline({ type: ' animation ' }), 'animation');
  // And a type that merely contains the word is not it.
  assert.strictEqual(discipline.assetDiscipline({ type: 'animations' }), 'art');
});

test('the sub-tabs and the upload folder can never diverge', () => {
  /* THE WHOLE POINT OF THE FEATURE, as one assertion: the same assets through
     the Dashboard's lens and through the path computation, compared. An asset
     the board shows under Animation lands in the Animation folder. */
  const { BOARD_LENS } = page();
  const folders = { art: 'Artist', animation: 'Animator' };
  const names = { art: 'Artist', animation: 'Animator' };

  for (const type of TYPES) {
    const asset = { type };
    // Which sub-tab would show it?
    const tabs = BOARD_LENS.filter((l) => l.match(asset));
    assert.strictEqual(tabs.length, 1,
      `${JSON.stringify(type)} must land in exactly one sub-tab, not ${tabs.length}`);
    const shownUnder = tabs[0].id;

    // Which folder would an upload for it go to?
    const computed = serverLink.uploadPathFor({
      project: { server_link: '\\\\SERVER\\Projects\\Hero Quest' },
      prefix: '\\\\SERVER\\Projects',
      disciplineId: discipline.assetDiscipline(asset),
      userFolder: 'Ana Artist',
      discipline: { folders, fallback: 'Work' },
    });
    assert.ok(computed.ok, JSON.stringify(computed));
    assert.strictEqual(computed.relative, `Hero Quest/${names[shownUnder]}/Ana Artist`,
      `an asset the board shows under ${shownUnder} must upload to ${names[shownUnder]}/`);
  }
});

test('the folder names are the studio\'s, and an empty one falls back', () => {
  const edited = { folders: { art: '2D', animation: 'Motion' }, fallback: 'Work' };
  assert.strictEqual(serverLink.disciplineFolder('art', edited), '2D');
  assert.strictEqual(serverLink.disciplineFolder('animation', edited), 'Motion');

  /* THE FALLBACK IS REACHED BY CLEARING A NAME, and that is the only way —
     the rule above is total over the two disciplines, so no asset can fall out
     of it. (The brief expected a third "anything else" case; there isn't one,
     because the Dashboard shows every asset in one of exactly two tabs.) */
  assert.strictEqual(serverLink.disciplineFolder('art', { folders: {}, fallback: 'Work' }), 'Work');
  assert.strictEqual(serverLink.disciplineFolder('animation', { folders: { art: 'Artist' }, fallback: 'Pool' }), 'Pool');
  // A name that is not a usable folder name never reaches the filesystem.
  assert.strictEqual(serverLink.disciplineFolder('art', { folders: { art: 'con' }, fallback: 'Work' }), 'Work');
  assert.strictEqual(serverLink.disciplineFolder('art', { folders: { art: 'a/b' }, fallback: 'Work' }), 'Work');

  // The shipped defaults, which are the two words the studio used.
  assert.deepStrictEqual(serverLink.DEFAULT_DISCIPLINES, { art: 'Artist', animation: 'Animator' });
  assert.strictEqual(serverLink.DEFAULT_FALLBACK, 'Work');
  /* And they name the disciplines that exist — a default folder for a
     discipline nobody can be in would be a name nothing ever reads. */
  assert.deepStrictEqual(Object.keys(serverLink.DEFAULT_DISCIPLINES).sort(),
    [...discipline.DISCIPLINE_IDS].sort());
});

test('the Settings screen offers one row per discipline, and previews the path', () => {
  /* THE ROWS. This grid used to be drawn from the asset CATEGORIES list — which
     ships empty, so there were no rows at all, and nobody editing Settings
     could see that every upload was going to the fallback folder. It is drawn
     from the disciplines the server sends with the settings now. */
  const block = PAGE.slice(PAGE.indexOf('<label>Discipline folder names</label>'),
    PAGE.indexOf('id="srvsPathPreview"'));
  assert.match(block, /\(s\.disciplines \|\| ASSET_DISCIPLINES\)\.map/,
    'the rows come from the disciplines, not from the asset categories');
  assert.ok(!/SRVSET\.categories|CATEGORIES/.test(block),
    `the discipline rows must not read the category list: ${block.slice(0, 200)}`);
  assert.match(block, /data-key="\$\{escapeHTML\(d\.id\)\}"/, 'keyed by the discipline id');
  // And the settings carry that list, so the page is not inventing it.
  const settings = require('../src/server-settings');
  assert.deepStrictEqual(settings.summarise().disciplines, discipline.DISCIPLINES);

  /* THE PREVIEW, as a string. Three fields decide where every upload in the
     studio lands and nobody sees the result until an artist uploads, so it is
     shown as they type. */
  const preview = new Function(`${grab(PAGE, 'function srvsPreviewPath(prefix, folder, who)')}
    return srvsPreviewPath;`)();
  assert.strictEqual(preview('\\\\SERVER\\Projects', 'Artist', 'Ana Artist'),
    '\\\\SERVER\\Projects\\<project>\\Artist\\Ana Artist\\');
  // A POSIX share keeps its own separator — the same rule linkFor() uses.
  assert.strictEqual(preview('/mnt/projects', 'Animator', 'Ana Artist'),
    '/mnt/projects/<project>/Animator/Ana Artist/');
  // A trailing separator on the prefix is not doubled.
  assert.strictEqual(preview('\\\\SERVER\\Projects\\', 'Artist', 'Ana'),
    '\\\\SERVER\\Projects\\<project>\\Artist\\Ana\\');
  // And with no prefix set yet it says so rather than drawing a broken path.
  assert.strictEqual(preview('', 'Artist', 'Ana'), '<prefix>/<project>/Artist/Ana/');

  /* AND SOMETHING DRAWS IT. A preview nothing calls is the easiest kind of
     feature to ship broken: the function is right, the test of the function
     passes, and the line is never on screen. So the wiring is asserted too —
     drawn once when the screen is wired, and redrawn as any of the three fields
     that decide the path is typed into. */
  const wiring = grab(PAGE, 'function wireServerSettings()');
  assert.match(wiring, /\n  srvsPathPreview\(\);/, 'the preview is drawn when the screen is wired');
  assert.match(wiring, /\['srvsPrefix', 'srvsFallback'\][\s\S]*?addEventListener\('input', srvsPathPreview\)/,
    'and redrawn as the prefix or the fallback is typed');
  assert.match(wiring, /\.srvs-disc[\s\S]*?addEventListener\('input', srvsPathPreview\)/,
    'and as a discipline folder name is typed');
  assert.match(PAGE, /<div class="ms-note" id="srvsPathPreview"><\/div>/, 'with somewhere to go');
});

test('nothing computes a discipline for itself', () => {
  /* The rule is one function, and a second copy of it anywhere is how the
     Dashboard and the folder drifted apart in the first place. Both halves of
     the application are searched for the shape of the old rule — a comparison
     against the string 'animation' — and only the two sanctioned copies may
     have it. */
  const files = ['server-link.js', 'server-settings.js', 'server-folders.js',
    'routes/server.js', 'routes/server-settings.js', 'server-submissions.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/['"]animation['"]/.test(code),
      `src/${f} must ask assetDiscipline() rather than comparing types itself`);
  }
  /* THE PAGE MAY NAME IT IN THREE PLACES AND NOWHERE ELSE: the list of
     disciplines, the rule itself, and the lens table that calls the rule. Not a
     count — a count passes when a mention moves somewhere it should not be —
     but the POSITION of every mention, which must fall inside one of those
     three blocks. A comparison against the literal anywhere else on the page is
     a second rule, and a second rule is how this drifted apart before. */
  const pageCode = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (opener, closer) => {
    const from = pageCode.indexOf(opener);
    assert.ok(from !== -1, `could not find ${opener} in the page`);
    const to = pageCode.indexOf(closer, from) + closer.length;
    return [from, to];
  };
  const allowed = [
    block('const ASSET_DISCIPLINES = [', '\n];'),
    block(SIGNATURES[1], '\n}'),
    block('const BOARD_LENS = [', '\n];'),
  ];
  const stray = [];
  for (let at = pageCode.indexOf("'animation'"); at !== -1; at = pageCode.indexOf("'animation'", at + 1)) {
    if (!allowed.some(([from, to]) => at >= from && at < to)) {
      stray.push(pageCode.slice(Math.max(0, at - 70), at + 30).replace(/\n/g, ' | '));
    }
  }
  assert.deepStrictEqual(stray, [],
    `the page names 'animation' outside the rule, the discipline list and the lens table:\n${stray.join('\n')}`);
});
