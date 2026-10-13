/* NO COLOUR LITERALS IN THE SERVED PAGE, except on a named allow-list.
 *
 * THIS IS THE TEST THAT KEEPS THE FEATURE TRUE. A theme is only as complete as
 * the last colour somebody converted: one `style="color:#e8402c"` added to a
 * template next month is a red that no Super Admin can change and that nobody
 * notices until they try. The page carried 263 of them before this change.
 *
 * SCANNED OUT OF THE SERVED SOURCE, not out of a build step: public/index.html
 * IS what the browser gets (plus a <style> block the server injects), so what
 * this file reads is what ships.
 *
 * EVERY ALLOW-LIST ENTRY CARRIES ITS REASON, and the reason has to be about why
 * a token cannot work there — not about it being inconvenient to change.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* The generated defaults block is where the literals are SUPPOSED to be: it is
   the one place in the application that states a colour, and it is generated
   from src/theme-tokens.js by scripts/build-theme-defaults.js. */
const DEFAULTS_OPEN = '<style id="themeDefaults">';
const DEFAULTS_CLOSE = '</style>';

function pageOutsideDefaults() {
  const at = PAGE.indexOf(DEFAULTS_OPEN);
  assert.ok(at !== -1, 'the page still has a generated defaults block');
  const end = PAGE.indexOf(DEFAULTS_CLOSE, at) + DEFAULTS_CLOSE.length;
  return PAGE.slice(0, at) + PAGE.slice(end);
}

/* ---------------------------------------------------------------------------
 * THE ALLOW-LIST. Each entry is a line of the page, matched exactly, with the
 * reason a token cannot serve there.
 */
const ALLOWED = [
  {
    match: 'value="#4DB8FF" style="width:48px;padding:2px;height:34px;"',
    why: '<input type="color"> takes a hex in its value attribute and nothing else — a '
      + 'custom property there is not a colour the control can show and the browser falls '
      + 'back to black. It is also not a theme colour: it is the starting point for a value '
      + 'a Super Admin picks for a REFERENCE row, stored per row.',
  },
];

/* THE THEME SECTION'S OWN CHROME, allowed as a BLOCK rather than line by line.
 *
 * A theme saved with the text the same colour as the page makes every screen
 * unreadable — including the screen you would use to put it back. So the Theme
 * section is drawn on a fixed palette that no token can reach, which means it
 * is literals by design. Bounded to the block that declares it, so a literal
 * cannot hide in it: the block is matched by its own opening and closing
 * comment markers and nothing outside them is excused.
 */
const SAFE_BLOCK_OPEN = '/* THEME-SAFE-BLOCK:START';
const SAFE_BLOCK_CLOSE = '/* THEME-SAFE-BLOCK:END */';

function withoutSafeBlock(text) {
  const at = text.indexOf(SAFE_BLOCK_OPEN);
  assert.ok(at !== -1, 'the Theme section\'s fixed palette block still opens with its marker');
  const closeAt = text.indexOf(SAFE_BLOCK_CLOSE, at);
  assert.ok(closeAt !== -1, 'and still closes with it');
  const end = closeAt + SAFE_BLOCK_CLOSE.length;
  /* ONE BLOCK, AND ONLY ONE. A second pair of markers would be a second
     exemption nobody argued for. */
  assert.strictEqual(text.indexOf(SAFE_BLOCK_OPEN, end), -1,
    'there is exactly one fixed-palette block');
  return { text: text.slice(0, at) + text.slice(end), block: text.slice(at, end) };
}

// ---------------------------------------------------------------------------

test('no hex or rgb() colour survives outside the defaults block', () => {
  const { text } = withoutSafeBlock(pageOutsideDefaults());
  let scanned = text;
  for (const entry of ALLOWED) {
    assert.ok(scanned.includes(entry.match),
      `the allow-list names something that is no longer in the page: ${entry.match}`);
    scanned = scanned.split(entry.match).join('');
  }

  /* HTML ENTITIES ARE NOT COLOURS. &#128206; is a paperclip, and the chat uses a
     dozen of them; the negative look-behind is what stops this test reporting
     emoji as a palette. */
  const hex = [...scanned.matchAll(/(?<!&)#([0-9a-fA-F]{3,8})\b/g)]
    .map((m) => m[0])
    .filter((v) => [3, 4, 6, 8].includes(v.length - 1));
  assert.deepStrictEqual(hex, [], 'hex colours outside the token defaults');

  const rgb = [...scanned.matchAll(/\brgba?\(\s*[\d.]+[^)]*\)/g)].map((m) => m[0]);
  assert.deepStrictEqual(rgb, [], 'rgb()/rgba() colours outside the token defaults');

  const hsl = [...scanned.matchAll(/\bhsla?\(\s*[\d.]+[^)]*\)/g)].map((m) => m[0]);
  assert.deepStrictEqual(hsl, [], 'hsl()/hsla() colours outside the token defaults');
});

test('the named colours that are left are English, not CSS', () => {
  /* `transparent` and `currentColor` ARE allowed everywhere, and are not on the
   * list above because they are not colours a studio could set: one is the
   * absence of a colour and the other is whatever the text already is. Both are
   * how this stylesheet says "no fill here" and "match the text", and replacing
   * either with a token would change what the rule means.
   *
   * THE REST — red, green, blue, white, grey — appear sixty times in this page
   * and every one of them is a word in a comment ("Amber, not red:", "two ticks,
   * blue"). This test proves that rather than assuming it: each hit has to be
   * inside a comment, which is what makes the claim checkable after somebody
   * edits the prose. */
  const { text } = withoutSafeBlock(pageOutsideDefaults());
  const NAMED = /(?<![-\w#'"])(white|black|red|green|blue|orange|gold|silver|gray|grey|yellow|purple|pink|cyan|magenta|navy|teal|lime|maroon|olive|aqua|fuchsia)(?![-\w])/g;

  /* Every /* … *\/ and <!-- … --> span in the file, as ranges. A hit inside one
     is prose; a hit outside one is a colour value. */
  const comments = [];
  for (const re of [/\/\*[\s\S]*?\*\//g, /<!--[\s\S]*?-->/g, /\/\/[^\n]*/g]) {
    for (const m of text.matchAll(re)) comments.push([m.index, m.index + m[0].length]);
  }
  const inComment = (at) => comments.some(([a, b]) => at >= a && at < b);

  const loose = [...text.matchAll(NAMED)]
    .filter((m) => !inComment(m.index))
    .map((m) => {
      const line = text.slice(0, m.index).split('\n').length;
      return `${m[1]} at line ${line}: ${text.slice(Math.max(0, m.index - 60), m.index + 30).split('\n').pop()}`;
    });
  assert.deepStrictEqual(loose, [], 'a named colour is being used as a value');
});

test('the Theme section\'s fixed palette is the only block of literals, and is bounded', () => {
  /* IT IS LITERALS ON PURPOSE — see the note on ALLOWED above. What this asserts
     is that the exemption is bounded: the block says why in its own comment, and
     every literal inside it belongs to a .theme- rule, so nothing unrelated can
     shelter there. */
  const { block } = withoutSafeBlock(pageOutsideDefaults());
  assert.match(block, /THEME-SAFE-BLOCK:START/, 'the block is marked');
  assert.match(block, /ignores the theme|no token can reach/, 'the block states why it is exempt');
  assert.match(block, /unreadable/, 'and what goes wrong without it');

  const declarations = [...block.matchAll(/([^{}]*)\{([^}]*)\}/g)];
  assert.ok(declarations.length > 5, 'the block is a set of rules');
  for (const [, selector, body] of declarations) {
    if (!/#[0-9a-fA-F]{3,8}|rgba?\(/.test(body)) continue;
    assert.match(selector.trim(), /\.theme-/,
      `a literal inside the fixed block belongs to "${selector.trim()}", which is not a Theme control`);
  }
});

test('no other served file carries a colour', () => {
  /* public/ holds two files. native-bridge.js is the mobile shell's glue and
     should have no colour in it at all; asserted rather than assumed, because
     "the page" is not the whole of what is served. */
  const dir = path.join(__dirname, '..', 'public');
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.html') continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const hex = [...text.matchAll(/(?<!&)#([0-9a-fA-F]{3,8})\b/g)]
      .map((m) => m[0]).filter((v) => [3, 4, 6, 8].includes(v.length - 1));
    assert.deepStrictEqual(hex, [], `${name} carries a colour literal`);
    assert.deepStrictEqual([...text.matchAll(/\brgba?\(\s*[\d.]+[^)]*\)/g)].map((m) => m[0]), [],
      `${name} carries an rgb() colour`);
  }
});

/* THE TWO FILES IN src/ THAT STATE COLOURS AND ARE NOT THE CATALOGUE, each with
 * the reason a token cannot serve there. Both are real answers rather than
 * unconverted work:
 */
const SRC_ALLOWED = {
  'theme-tokens.js': 'the catalogue itself — the one place in the application that states a colour',
  'reference-defaults.js':
    'these are REFERENCE-DATA colours, not theme colours: the colour of an asset type, a '
    + 'priority, a designation. Each is stored on its own row and edited per row in Settings '
    + '(the swatch beside the name), so they are the SEED for data a studio owns rather than '
    + 'part of the palette. Putting them in the theme would mean a studio could not give two '
    + 'asset types two colours.',
  'report-pdf.js':
    'a PDF has no CSS and no custom properties, and it is printed on white paper. Feeding it '
    + 'the UI theme would make a dark palette unreadable on a page — which is the opposite of '
    + 'what a themed export should do. Its palette is built for print and stays that way.',
};

test('the source outside the page states a colour only where a token cannot serve', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  }(root)).filter((f) => f.endsWith('.js'));

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (SRC_ALLOWED[rel]) continue;
    const text = fs.readFileSync(file, 'utf8');
    /* Comments are prose here too — src/theme.js explains #1D2027 in a refusal
       message and src/asset-workflow.js discusses the brand red. Strip them
       first, then look only at quoted values, which is what a colour in code is. */
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const hex = [...code.matchAll(/'#([0-9a-fA-F]{3,8})'|"#([0-9a-fA-F]{3,8})"/g)].map((m) => m[0]);
    if (hex.length) offenders.push(`${rel}: ${hex.slice(0, 6).join(', ')}`);
  }
  assert.deepStrictEqual(offenders, [],
    'a colour literal outside src/theme-tokens.js — put it in the catalogue, or add it to '
    + 'SRC_ALLOWED with the reason a token cannot serve there');

  // And the allow-list names nothing that has gone away.
  for (const rel of Object.keys(SRC_ALLOWED)) {
    assert.ok(fs.existsSync(path.join(root, rel)), `SRC_ALLOWED names a file that is gone: ${rel}`);
  }
});

test('the pipeline no longer states a colour of its own', () => {
  /* THE ONE THAT MATTERS MOST, because it was the only list outside the
     stylesheet that a studio could see the result of: the board's column
     headings and every status badge. src/asset-workflow.js now carries
     var(--status-<id>) for every state, and src/theme-tokens.js carries the
     colours. */
  const wf = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  const states = wf.slice(wf.indexOf('const STATES'), wf.indexOf('];', wf.indexOf('const STATES')));
  const colours = [...states.matchAll(/color: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(colours.length >= 12, 'the state list still carries a colour per state');
  for (const c of colours) {
    assert.match(c, /^var\(--status-[a-z-]+\)$/,
      `the pipeline states a colour directly: ${c}`);
  }
});
