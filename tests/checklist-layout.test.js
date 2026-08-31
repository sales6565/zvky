const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* The team-lead and coordinator pickers, and why this file exists.
 *
 * `.modal input, .modal select, .modal textarea` dresses every field in a modal
 * as a text box: width:100%, padding, a border, a background. That is right for
 * the things you type into and wrong for a tick box — and inside `.checklist
 * label`, which is a flex row, a checkbox at width:100% becomes a flex item
 * that shrinks around whatever name sits next to it. Every row then got a
 * different box width, so every name started at a different x and the New
 * Project pickers rendered as a diagonal staircase.
 *
 * Asserting the fix by searching for a string would only prove somebody typed
 * that string. What actually matters is which declaration WINS, so this
 * resolves the cascade for the checkbox in one of those rows the way a browser
 * would: collect every rule whose selector matches, order by specificity then
 * source position, and read off the winner. Re-broadening `.modal input` — or
 * deleting the exemption — fails this regardless of how the CSS is written.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function stylesheet() {
  const blocks = HTML.match(/<style>[\s\S]*?<\/style>/g) || [];
  assert.ok(blocks.length, 'public/index.html should carry a <style> block');
  return blocks.join('\n').replace(/<\/?style>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/* Rules, in source order. At-rules are unwrapped one level so anything inside a
   media query is still seen; this stylesheet nests no deeper than that. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].trim();
    if (!selectors || selectors.startsWith('@')) continue;
    out.push({ selectors: selectors.split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

// A compound like `input[type=checkbox]` or `.checklist` or `label`.
function parseCompound(text) {
  const part = { tag: null, classes: [], attrs: [], ids: [], pseudo: 0 };
  const re = /(^[a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([^\]]+)\]|::?([\w-]+)(\([^)]*\))?/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) part.tag = m[1].toLowerCase();
    else if (m[2]) part.classes.push(m[2]);
    else if (m[3]) part.ids.push(m[3]);
    else if (m[4]) part.attrs.push(m[4].replace(/["']/g, ''));
    else if (m[5]) part.pseudo += 1;
  }
  return part;
}

function compoundMatches(part, node) {
  if (part.ids.length) return false;                       // none of these nodes carry an id
  if (part.pseudo) return false;                           // :hover etc. is not the resting state
  if (part.tag && part.tag !== node.tag) return false;
  if (!part.classes.every((c) => node.classes.includes(c))) return false;
  return part.attrs.every((a) => node.attrs.includes(a));
}

/* Descendant match: every compound must appear, in order, along the ancestor
   path, with the last one matching the element itself. Only descendant
   combinators are used by the rules that reach these nodes; a selector with
   >, + or ~ is treated as not matching rather than guessed at. */
function selectorMatches(selector, pathNodes) {
  if (/[>+~]/.test(selector)) return false;
  const parts = selector.split(/\s+/).filter(Boolean).map(parseCompound);
  if (!compoundMatches(parts[parts.length - 1], pathNodes[pathNodes.length - 1])) return false;
  let i = pathNodes.length - 2;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (i >= 0 && !compoundMatches(parts[p], pathNodes[i])) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const tags = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + tags;
}

function declarations(body) {
  const out = new Map();
  for (const chunk of body.split(';')) {
    const at = chunk.indexOf(':');
    if (at < 0) continue;
    out.set(chunk.slice(0, at).trim().toLowerCase(), chunk.slice(at + 1).trim());
  }
  return out;
}

// What the browser ends up with for `property` on the element at the end of `pathNodes`.
function resolve(property, pathNodes) {
  const css = stylesheet();
  const winners = [];
  rules(css).forEach((rule, order) => {
    const decls = declarations(rule.body);
    if (!decls.has(property)) return;
    for (const sel of rule.selectors) {
      if (!selectorMatches(sel, pathNodes)) continue;
      winners.push({ sel, order, spec: specificity(sel), value: decls.get(property) });
    }
  });
  winners.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
  return winners.length ? winners[winners.length - 1] : null;
}

// <div class="modal"> … <div class="checklist"> <label> <input type="checkbox">
const ROW_CHECKBOX = [
  { tag: 'div', classes: ['modal'], attrs: [] },
  { tag: 'fieldset', classes: [], attrs: [] },
  { tag: 'div', classes: ['checklist'], attrs: [] },
  { tag: 'label', classes: [], attrs: [] },
  { tag: 'input', classes: [], attrs: ['type=checkbox'] },
];
const ROW_LABEL = ROW_CHECKBOX.slice(0, 4);
const TEXT_FIELD = [
  { tag: 'div', classes: ['modal'], attrs: [] },
  { tag: 'input', classes: [], attrs: ['type=text'] },
];

test('the resolver agrees with the browser about the bug it is guarding', () => {
  // A sanity check on the machinery above: the broad rule must be one of the
  // candidates, and specificity must be ordered the way CSS orders it.
  const width = resolve('width', ROW_CHECKBOX);
  assert.ok(width, 'some rule should set a width on a checklist checkbox');
  assert.ok(specificity('.modal input[type=checkbox]') > specificity('.modal input'),
    'an attribute selector must out-rank the bare tag');
});

test('a checkbox in a modal is not dressed as a text field', () => {
  const width = resolve('width', ROW_CHECKBOX);
  assert.notStrictEqual(width.value, '100%',
    `"${width.sel}" gives the tick box width:100%. Inside .checklist label — a flex row — it then `
    + 'shrinks around the name beside it, so every row gets a different box width and the list '
    + 'renders as a diagonal staircase. Exempt checkboxes from the .modal field styling.');
  assert.match(width.value, /^(auto|[\d.]+(px|em|rem))$/,
    'the tick box should keep its own size, not one derived from the row');

  // Percentage width was the visible half; shrinking is the other half. Even at
  // width:auto a flex item may still shrink, so the row has to pin it.
  const flex = resolve('flex', ROW_CHECKBOX) || resolve('flex-shrink', ROW_CHECKBOX);
  assert.ok(flex, 'the tick box should be pinned against flex shrinking');
  assert.match(flex.value, /^(none|0( |$))/,
    `"${flex.sel}" lets the tick box shrink; a long name would then squeeze it and shift the text`);
});

test('text fields in modals keep their full-width styling', () => {
  // The fix must not have been made by gutting the rule everything else relies on.
  const width = resolve('width', TEXT_FIELD);
  assert.ok(width, 'text inputs in a modal should still get a width');
  assert.strictEqual(width.value, '100%', 'text inputs in a modal should still fill the row');
});

test('every checklist row is a flex row aligned to a single left edge', () => {
  const display = resolve('display', ROW_LABEL);
  assert.ok(display && display.value === 'flex',
    'a checklist row should lay the tick box and the name out as one horizontal row');

  // Aligned to the top, so a name long enough to wrap keeps its box on the
  // first line instead of drifting down beside the middle of two lines.
  const align = resolve('align-items', ROW_LABEL);
  assert.ok(align && /^(flex-)?start$/.test(align.value),
    'rows should align to the top so a wrapped name does not move its tick box');

  // Nothing may indent a row: the staircase was rows starting at different
  // places, so no rule reaching a row may give it a left offset.
  for (const prop of ['margin-left', 'padding-left', 'text-indent', 'left']) {
    const found = resolve(prop, ROW_LABEL);
    assert.strictEqual(found, null,
      `"${found && found.sel}" sets ${prop} on a checklist row; every row must start at the same edge`);
  }
});

test('the checklist stays a fixed-height scroller', () => {
  // The rows were the bug; the container was not. Assert it is untouched, so a
  // later "tidy-up" cannot quietly turn the picker into an endless list.
  const container = [
    { tag: 'div', classes: ['modal'], attrs: [] },
    { tag: 'div', classes: ['checklist'], attrs: [] },
  ];
  const maxHeight = resolve('max-height', container);
  const overflow = resolve('overflow-y', container);
  assert.ok(maxHeight && /^\d+px$/.test(maxHeight.value), 'the picker should stay a fixed height');
  assert.ok(overflow && /(auto|scroll)/.test(overflow.value), 'and should scroll rather than grow');
});

test('both project forms render their pickers the same way', () => {
  // Four lists — leads and coordinators, on New Project and Edit Project. They
  // share one class precisely so a fix cannot land on some of them.
  const containers = HTML.match(/<div class="checklist" id="(\w+)">/g) || [];
  assert.deepStrictEqual(
    containers.map((c) => c.match(/id="(\w+)"/)[1]).sort(),
    ['ep_coords', 'ep_leads', 'p_coords', 'p_leads'],
    'all four pickers should use the .checklist class'
  );
  // And each is filled with bare <label><input type=checkbox>Name</label> rows,
  // with no per-row wrapper or inline style to drift apart from the CSS.
  const rowTemplates = HTML.match(/<label><input type="checkbox"[^>]*>\$\{escapeHTML\(u\.name\)\}<\/label>/g) || [];
  assert.strictEqual(rowTemplates.length, 3,
    'the three render sites should emit the same row markup (New Project x2, Edit Project x1)');
});
