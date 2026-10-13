/* THE SAVED THEME: storage, validation, the generated stylesheet, and contrast.
 *
 * src/theme-tokens.js is the catalogue — what a token IS. This is everything
 * done with one: the single saved theme and its version, the history that makes
 * a bad save undoable, the named presets, and the `:root{}` block the browser
 * actually receives.
 *
 * ---------------------------------------------------------------------------
 * NOTHING A USER TYPED EVER REACHES THE STYLESHEET. That is the whole security
 * posture of this file and it is worth being explicit about, because a theme
 * editor is a CSS injection route by construction: a value goes from a text box
 * into a `:root{}` block that every page in the application loads.
 *
 * The defence is not escaping. It is that a value is only ever stored and only
 * ever emitted after `canonical()` has rewritten it into `#RRGGBB` or
 * `#RRGGBBAA` from scratch — the output is built from the matched hex digits,
 * not from the input string — so there is no path by which `red; } body {
 * display:none`, `url(javascript:…)`, `expression(…)` or a unicode lookalike can
 * survive. They are not sanitised; they are refused, by name, with a 400.
 *
 * ONE SAVED THEME, with a version that increases on every change. Not one per
 * user: the studio has one set of colours, and a per-user theme would mean the
 * sign-in screen could not have one at all.
 */

const tokens = require('./theme-tokens');
const workflow = require('./asset-workflow');

const TABLE = 'studio_theme';
const HISTORY_TABLE = 'studio_theme_history';
const PRESET_TABLE = 'studio_theme_presets';

/* ---------------------------------------------------------------------------
 * THE CATALOGUE, RESOLVED.
 *
 * The palette plus one token per workflow status, built from the pipeline's own
 * list — see statusTokens(). Computed on demand rather than captured at import
 * time: src/asset-workflow.js's STATES is a constant today, and if a status ever
 * becomes reference data this keeps working.
 */
function all() {
  return [...tokens.TOKENS, ...tokens.statusTokens(workflow.STATES)];
}

let byKeyCache = null;
let byKeyFor = null;
function byKey() {
  const list = all();
  if (!byKeyCache || byKeyFor !== list.length) {
    byKeyCache = new Map(list.map((tok) => [tok.key, tok]));
    byKeyFor = list.length;
  }
  return byKeyCache;
}

const isToken = (key) => byKey().has(key);
const defaults = () => Object.fromEntries(all().map((tok) => [tok.key, tok.default]));

/* ---------------------------------------------------------------------------
 * THE STYLESHEET.
 *
 * `:root{ --name:#VALUE; … }` and nothing else — no selectors, no nesting, no
 * at-rules. Built token by token from validated values, so the only characters
 * that can appear are the ones this function writes.
 *
 * DERIVED ALPHA VARIANTS. A token may declare `alphas`, and each entry emits a
 * second property holding the same colour at that alpha. Two forms, because the
 * shipped stylesheet used both and each has to come back byte-exact:
 *
 *   0.12   a fraction, emitted as rgba(r,g,b,.12) — what the CSS had
 *   '22'   an alpha byte, emitted as #RRGGBB22  — what the JS string-concatenated
 *
 * A token that allows alpha in its own value has no derived variants: stacking
 * an alpha on an alpha is not a thing the stylesheet ever did and the arithmetic
 * would be a second place to be wrong.
 */
function rgbaOf(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // `.12`, not `0.12` — the form the stylesheet used, and shorter.
  const a = String(alpha).replace(/^0\./, '.');
  return `rgba(${r},${g},${b},${a})`;
}

function declarationsFor(tok, value) {
  const out = [`--${tok.css}:${value};`];
  for (const [suffix, alpha] of Object.entries(tok.alphas || {})) {
    if (value.length === 9) continue;            // already translucent; see above
    out.push(typeof alpha === 'string'
      ? `--${tok.css}-${suffix}:${value}${alpha.toUpperCase()};`
      : `--${tok.css}-${suffix}:${rgbaOf(value, alpha)};`);
  }
  return out;
}

/* THE BLOCK. Saved values win; anything unsaved falls back to its default, so a
   theme that predates a token added later is still complete. */
function cssFor(saved = {}) {
  const lines = [];
  for (const tok of all()) {
    const raw = Object.prototype.hasOwnProperty.call(saved, tok.key) ? saved[tok.key] : tok.default;
    /* RE-VALIDATED HERE TOO, not trusted because it came out of the database. A
       row edited by hand, or restored from a backup taken before the validation
       existed, must not be able to put anything into a stylesheet. */
    const checked = tokens.canonical(raw);
    const value = checked.error || (checked.alpha && !tok.alpha)
      ? tokens.canonical(tok.default).value
      : checked.value;
    lines.push(...declarationsFor(tok, value));
  }
  return `:root{${lines.join('')}}`;
}

/* ---------------------------------------------------------------------------
 * VALIDATION.
 *
 * Returns every error rather than the first: an imported theme file with four
 * bad values should say so once, not four times over.
 */
function validate(input) {
  const errors = [];
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, errors: [{ message: 'Send the theme as an object of token keys and colours.' }] };
  }
  const keys = Object.keys(input);
  const values = {};
  for (const key of keys) {
    const tok = byKey().get(key);
    if (!tok) {
      errors.push({ token: key, message: `"${key}" is not a colour this application has.` });
      continue;
    }
    const checked = tokens.canonical(input[key]);
    if (checked.error) {
      errors.push({
        token: key,
        /* The example is the token's OWN DEFAULT — always valid for that field,
           always the right number of digits, and it cannot go stale. */
        message: `${tok.label} must be a colour like ${tok.default}.`
          + (tok.alpha ? ' Eight digits are allowed here for transparency.' : ''),
      });
      continue;
    }
    if (checked.alpha && !tok.alpha) {
      errors.push({
        token: key,
        message: `${tok.label} cannot be transparent — give it six digits, like #1D2027. `
          + 'Transparency is allowed only on overlays and shadows.',
      });
      continue;
    }
    values[key] = checked.value;
  }
  if (errors.length) return { ok: false, status: 400, errors };
  return { ok: true, values };
}

/* ---------------------------------------------------------------------------
 * CONTRAST, to WCAG 2.1.
 *
 * ALPHA IS COMPOSITED OVER THE PAGE BACKGROUND BEFORE MEASURING, because a
 * ratio against a translucent colour is a ratio against something nobody sees.
 * That is an approximation — the real backdrop is whatever the element happens
 * to sit on — and it is the honest one available here: the page background is
 * what every surface in this application ultimately sits on.
 */
function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function flatten(hex, overHex) {
  if (hex.length !== 9) return rgbOf(hex);
  const a = parseInt(hex.slice(7, 9), 16) / 255;
  const fg = rgbOf(hex.slice(0, 7));
  const bg = rgbOf(overHex.length === 9 ? overHex.slice(0, 7) : overHex);
  return fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* The ratio, to two decimals. Rounded DOWN, so a pair that computes to 4.4999
   is never reported as 4.5 — the figure is a floor on what the viewer gets. */
function contrast(foreground, background, over = null) {
  /* The backdrop a translucent colour is flattened against. Defaults to the page
     background FROM THE CATALOGUE rather than to a literal: there is one place in
     this application that states a colour and it is not this function. */
  const backdrop = over || tokens.canonical(byKey().get('surface.page').default).value;
  const a = luminance(flatten(foreground, backdrop));
  const b = luminance(flatten(background, backdrop));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/* THE PAIRS WORTH CHECKING. Each is a place where one token is read ON another,
 * and each is a pair somebody can actually break from the editor.
 *
 * `label` is what the warning names, so it has to read as a place rather than as
 * two token keys. `large` marks a pair that is large or bold text, where 3:1 is
 * the standard rather than 4.5:1 — the tab labels are 12px semibold, which is
 * not large text, so none of them is marked.
 */
const PAIRS = [
  ['nav.tab.text', 'nav.bar.background', 'Inactive tab label on the tab bar'],
  ['nav.tab.active.text', 'nav.tab.active.background', 'Active tab label'],
  ['nav.tab.hover.text', 'nav.tab.hover.background', 'Tab label under the pointer'],
  ['nav.tab.badge.dot', 'nav.tab.badge.background', 'Waiting marker on a tab', { large: true }],
  ['subtab.text', 'surface.page', 'Inactive sub-tab label'],
  ['subtab.active.text', 'subtab.active.background', 'Active sub-tab label'],
  ['subtab.hover.text', 'subtab.hover.background', 'Sub-tab label under the pointer'],
  ['subtab.count.text', 'subtab.count.background', 'Sub-tab counter'],
  ['text.on.brand', 'button.primary.background', 'Primary button label'],
  ['button.secondary.text', 'button.secondary.background', 'Secondary button label'],
  ['button.danger.text', 'button.secondary.background', 'Destructive action label'],
  ['text.on.accent', 'text.link', 'Label inside an accent badge'],
  ['text.primary', 'surface.page', 'Body text on the page'],
  ['text.primary', 'surface.panel', 'Body text on a panel'],
  ['text.secondary', 'surface.panel', 'Secondary text on a panel'],
  ['text.muted', 'surface.panel', 'Muted text on a panel'],
  ['text.link', 'surface.page', 'A link on the page'],
  ['text.link.hover', 'surface.page', 'A link under the pointer'],
  ['form.placeholder', 'form.input.background', 'Placeholder inside a field'],
  ['table.header.text', 'surface.panel', 'Column heading'],
  ['meaning.success.text', 'surface.panel', 'Success message'],
  ['meaning.warning.text', 'surface.panel', 'Warning message'],
  ['meaning.error.text', 'surface.panel', 'Error message'],
  ['meaning.info.text', 'surface.panel', 'Information message'],
  ['login.error.text', 'login.card.background', 'Sign-in refusal'],
];

/* A status badge is its own colour as text on its own colour at 13% — see
   .status-pill. One pair per status, generated like the tokens themselves. */
function statusPairs() {
  return tokens.statusTokens(workflow.STATES).map((tok) =>
    [tok.key, tok.key, `${tok.label} badge`, { tint: '22' }]);
}

/* Every ratio, for a complete set of values. `over` is the page background,
   which is what a translucent colour is flattened against. */
function ratios(values = {}) {
  const v = { ...defaults(), ...values };
  const page = v['surface.page'] || tokens.canonical(byKey().get('surface.page').default).value;
  const rows = [];
  for (const [fgKey, bgKey, label, opts = {}] of [...PAIRS, ...statusPairs()]) {
    const fg = v[fgKey];
    let bg = v[bgKey];
    if (!fg || !bg) continue;
    // A status badge's background is its own colour at the pill's own alpha.
    if (opts.tint) bg = `${bg.slice(0, 7)}${opts.tint}`;
    const min = opts.large ? AA_LARGE : AA_NORMAL;
    const ratio = contrast(fg, bg, page);
    rows.push({
      label, foreground: fgKey, background: bgKey, ratio,
      required: min,
      passes: ratio >= min,
      /* BELOW 3:1 IS THE LINE AT WHICH THE EDITOR ASKS TWICE. Between 3 and the
         requirement it warns; under 3 nothing is readable by anybody and the save
         takes an explicit confirmation. */
      severe: ratio < AA_LARGE,
    });
  }
  return rows;
}

/* THE FOCUS RING MUST NOT VANISH. Not a contrast pair in the WCAG sense — it is
 * a ring drawn ON a background rather than text read against one — but it is the
 * one token whose failure mode is that keyboard users lose the application
 * entirely, so it gets its own check against each surface it is drawn over.
 */
function focusRingWarnings(values = {}) {
  const v = { ...defaults(), ...values };
  const ring = v['nav.focus.ring'];
  const out = [];
  for (const key of ['surface.page', 'surface.panel', 'surface.raised', 'nav.tab.active.background']) {
    const ratio = contrast(ring, v[key], v['surface.page']);
    if (ratio < AA_LARGE) {
      out.push({
        label: `Focus ring on ${byKey().get(key).label.toLowerCase()}`,
        foreground: 'nav.focus.ring', background: key, ratio, required: AA_LARGE,
        passes: false, severe: true,
      });
    }
  }
  return out;
}

const warningsFor = (values) => [
  ...ratios(values).filter((r) => !r.passes),
  ...focusRingWarnings(values),
];

module.exports = {
  TABLE, HISTORY_TABLE, PRESET_TABLE,
  all, byKey, isToken, defaults,
  cssFor, declarationsFor, rgbaOf,
  validate,
  contrast, ratios, focusRingWarnings, warningsFor, PAIRS, statusPairs,
  AA_NORMAL, AA_LARGE,
};

/* ===========================================================================
 * STORAGE: one saved theme, its version, the last twenty saves, and the presets.
 *
 * MIRRORED IN MEMORY like branding and the reference lists, and for the same
 * reason: every page load needs the theme and it changes a handful of times in
 * the life of a deployment. The mirror is loaded at startup and reloaded on
 * every write, so a save is visible on the next request rather than on the next
 * restart.
 */
const ONE = 1;

let cache = { values: {}, version: 0, updatedAt: null, updatedBy: null };
let loaded = false;

const parse = (json) => {
  try {
    const raw = JSON.parse(json || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /* RE-VALIDATED ON THE WAY OUT OF THE DATABASE. A row restored from a backup
       taken before this validation existed, or edited by hand, must not be able
       to put anything into a stylesheet — so what comes back is filtered to
       known tokens with canonical values and nothing else. */
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const tok = byKey().get(key);
      if (!tok) continue;
      const checked = tokens.canonical(value);
      if (checked.error) continue;
      if (checked.alpha && !tok.alpha) continue;
      out[key] = checked.value;
    }
    return out;
  } catch {
    return {};
  }
};

async function load(db) {
  const { rows } = await db.query(
    `SELECT version, values_json, updated_at, updated_by FROM ${TABLE} WHERE id = ${ONE}`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  cache = {
    values: parse(row && row.values_json),
    version: Number(row && row.version) || 0,
    updatedAt: (row && row.updated_at) || null,
    updatedBy: (row && row.updated_by) || null,
  };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;
const current = () => ({ ...cache, values: { ...cache.values } });

/* THE VERSION IS WHAT MAKES A CHANGE TRAVEL. It rides on /auth/me — already
   polled every twenty seconds — and keys the ETag on the public endpoint, so a
   logged-in screen repaints itself and a cached stylesheet is revalidated
   without anybody being told to reload. */
const version = () => cache.version;

/* THE CSS FOR WHAT IS SAVED, from the mirror. Falls all the way back to the
   defaults when the mirror could not load, which is the one behaviour this must
   never get wrong: a database that is down has to produce the palette the
   application shipped with, not an unstyled page. */
const currentCss = () => cssFor(loaded ? cache.values : {});

async function save(db, input, actor) {
  const checked = validate(input);
  if (!checked.ok) return checked;

  const before = { ...cache.values };
  const next = checked.values;
  const nextVersion = cache.version + 1;
  const json = JSON.stringify(next);

  await db.query(
    `INSERT INTO ${TABLE} (id, version, values_json, updated_at, updated_by)
     VALUES (${ONE}, $1, $2, NOW(), $3)
     ON DUPLICATE KEY UPDATE version = VALUES(version), values_json = VALUES(values_json),
       updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [nextVersion, json, (actor && actor.id) || null]
  );

  /* THE LAST TWENTY, so a bad save can be undone in one click. Written before
     the mirror is refreshed, because the thing worth keeping is the state that
     is being replaced as well as the one replacing it. */
  await db.query(
    `INSERT INTO ${HISTORY_TABLE} (id, version, values_json, saved_at, saved_by, saved_by_email)
     VALUES (UUID(), $1, $2, NOW(), $3, $4)`,
    [nextVersion, json, (actor && actor.id) || null, (actor && actor.email) || null]
  ).catch(() => {});
  await db.query(
    `DELETE FROM ${HISTORY_TABLE} WHERE seq <= (
       SELECT MIN(seq) FROM (
         SELECT seq FROM ${HISTORY_TABLE} ORDER BY seq DESC LIMIT ${tokens.HISTORY_LIMIT}
       ) AS keep
     ) - 1`
  ).catch(() => {});

  await load(db);
  return {
    ok: true,
    version: cache.version,
    values: { ...cache.values },
    changed: changedBetween(before, next),
    contrast: ratios(cache.values),
    warnings: warningsFor(cache.values),
  };
}

/* WHAT MOVED, for the audit line. Old and new for every token that is different,
   with the DEFAULT standing in for "not set" on either side — because "unset to
   #FF0000" is what happened, and recording it as "(none) to #FF0000" would make
   the log unreadable for the common case of a first save. */
function changedBetween(before, after) {
  const base = defaults();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of [...keys].sort()) {
    const from = before[key] || base[key];
    const to = after[key] || base[key];
    if (from === to) continue;
    const tok = byKey().get(key);
    out.push({ token: key, label: tok ? tok.label : key, from, to });
  }
  return out;
}

async function history(db) {
  const { rows } = await db.query(
    `SELECT h.version, h.values_json, h.saved_at, h.saved_by_email, u.\`name\` AS saved_by_name
       FROM ${HISTORY_TABLE} h
       LEFT JOIN users u ON u.id = h.saved_by
      ORDER BY h.seq DESC LIMIT ${tokens.HISTORY_LIMIT}`
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => ({
    version: Number(r.version),
    savedAt: r.saved_at,
    savedBy: r.saved_by_name || r.saved_by_email || null,
    /* The token COUNT rather than the values: the list is for choosing which
       save to go back to, and a hundred hex strings per row would make it
       unreadable. The revert reads the row itself. */
    tokens: Object.keys(parse(r.values_json)).length,
  }));
}

async function revert(db, toVersion, actor) {
  const { rows } = await db.query(
    `SELECT values_json FROM ${HISTORY_TABLE} WHERE version = $1 ORDER BY seq DESC LIMIT 1`,
    [Number(toVersion) || 0]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) {
    return { ok: false, status: 404, errors: [{ message: `There is no saved theme at version ${toVersion}.` }] };
  }
  /* SAVED AS A NEW VERSION rather than rewound. The version only ever goes up,
     which is what lets every cache and every open browser notice; a version that
     went backwards would leave a stale ETag looking current. */
  return save(db, parse(rows[0].values_json), actor);
}

/* --- presets ---------------------------------------------------------------
 *
 * BOUNDED, because this is a settings table and not a document store: twelve is
 * more named themes than a studio will keep and few enough that the list is a
 * list rather than a search.
 */
const cleanPresetName = (raw) => {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!text) return { error: 'Give the preset a name.' };
  if (text.length > 60) return { error: `That name is ${text.length} characters; the limit is 60.` };
  return { value: text };
};

async function presets(db) {
  const { rows } = await db.query(
    `SELECT p.id, p.\`name\`, p.values_json, p.created_at, u.\`name\` AS created_by_name
       FROM ${PRESET_TABLE} p LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.\`name\``
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => ({
    id: r.id, name: r.name, createdAt: r.created_at,
    createdBy: r.created_by_name || null,
    values: parse(r.values_json),
  }));
}

async function savePreset(db, { name, values }, actor) {
  const clean = cleanPresetName(name);
  if (clean.error) return { ok: false, status: 400, errors: [{ field: 'name', message: clean.error }] };
  // THE SAME VALIDATION AS A SAVE. A preset is a theme; there is no second rule.
  const checked = validate(values);
  if (!checked.ok) return checked;

  const existing = await presets(db);
  const already = existing.find((p) => p.name.toLowerCase() === clean.value.toLowerCase());
  if (!already && existing.length >= tokens.MAX_PRESETS) {
    return {
      ok: false,
      status: 400,
      errors: [{
        field: 'name',
        message: `There are already ${tokens.MAX_PRESETS} presets, which is the limit. `
          + 'Delete one first.',
      }],
    };
  }
  const json = JSON.stringify(checked.values);
  if (already) {
    await db.query(`UPDATE ${PRESET_TABLE} SET values_json = $1 WHERE id = $2`, [json, already.id]);
  } else {
    await db.query(
      `INSERT INTO ${PRESET_TABLE} (id, \`name\`, values_json, created_at, created_by)
       VALUES (UUID(), $1, $2, NOW(), $3)`,
      [clean.value, json, (actor && actor.id) || null]
    );
  }
  return { ok: true, replaced: Boolean(already), name: clean.value, presets: await presets(db) };
}

async function deletePreset(db, id) {
  const { result } = await db.query(`DELETE FROM ${PRESET_TABLE} WHERE id = $1`, [id]);
  if (!result || !result.affectedRows) {
    return { ok: false, status: 404, errors: [{ message: 'That preset no longer exists.' }] };
  }
  return { ok: true, presets: await presets(db) };
}

module.exports.load = load;
module.exports.isLoaded = isLoaded;
module.exports.current = current;
module.exports.currentCss = currentCss;
module.exports.version = version;
module.exports.save = save;
module.exports.revert = revert;
module.exports.history = history;
module.exports.presets = presets;
module.exports.savePreset = savePreset;
module.exports.deletePreset = deletePreset;
module.exports.changedBetween = changedBetween;
module.exports.parse = parse;
