#!/usr/bin/env node
/* WHAT EVERY BUILT-IN ROLE CAN SEE AND CALL, as a file that can be compared.
 *
 * ===========================================================================
 * WHY THIS EXISTS. Prompt 61 adds a view key to every area that lacked one, and
 * the promise attached to it is that NOTHING changes for any existing role on
 * the day it deploys. That promise is not checkable by reading: it is sixty
 * roles against a hundred-odd screens and three hundred routes.
 *
 * So this is generated from the UNTOUCHED tree, committed, and generated again
 * afterwards. tests/permission-snapshot.test.js fails if the two differ by one
 * character. A deliberate change to anybody's visibility has to be made by
 * regenerating the file, which puts it in the diff where somebody will see it.
 *
 * WHAT IT READS, AND WHY STATICALLY. The page's two declarative tables —
 * UI_GATES (every element whose visibility is a permission question) and
 * SETTINGS_SECTIONS (every Settings section and its key) — plus the route list
 * from scripts/route-guards.js, evaluated against each role's baseline
 * permissions from the catalogue. No server, no database, no browser: a
 * snapshot that needed a running deployment would not be run.
 *
 * Run it:  node scripts/permission-snapshot.js            (writes the file)
 *          node scripts/permission-snapshot.js --stdout   (prints it)
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'permission-snapshot.txt');

const roles = require(path.join(ROOT, 'src', 'roles'));
const catalog = require(path.join(ROOT, 'src', 'permission-catalog'));
const { collect } = require(path.join(__dirname, 'route-guards.js'));

const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/* ---------------------------------------------------------------- the page */

/* UI_GATES, as {element: predicate-source}. Read out of the page rather than
   duplicated here: a copy would be the thing that drifts. */
function uiGates() {
  const from = PAGE.indexOf('const UI_GATES = {');
  const to = PAGE.indexOf('\n};', from);
  if (from === -1 || to === -1) throw new Error('UI_GATES not found in public/index.html');
  const body = PAGE.slice(from + 'const UI_GATES = {'.length, to);
  const out = [];
  /* One entry per `name: () => expression,` — comments between entries are
     skipped by matching the shape rather than splitting on commas. */
  const re = /^\s{2}([A-Za-z_$][\w$]*):\s*\(\)\s*=>\s*([\s\S]*?),?\s*$/gm;
  let m;
  while ((m = re.exec(body))) {
    const expr = m[2].trim().replace(/,$/, '');
    if (!expr || expr.startsWith('/*')) continue;
    out.push({ element: m[1], expr });
  }
  return out;
}

/* SETTINGS_SECTIONS, as {key, label}. */
function settingsSections() {
  const from = PAGE.indexOf('const SETTINGS_SECTIONS = [');
  const to = PAGE.indexOf('\n];', from);
  const body = PAGE.slice(from, to);
  const out = [];
  const re = /\{\s*permission:\s*'([^']+)'\s*,\s*label:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body))) out.push({ key: m[1], label: m[2].replace(/\\'/g, "'") });
  return out;
}

/* A gate's source evaluated for one role's permission set.
 *
 * The expressions are can()/canAnyIn() calls and a handful of page predicates.
 * The page predicates are answered by the most permissive plausible stand-in —
 * `true` — and NAMED in the output, so a row that depends on one is visibly a
 * row this snapshot cannot decide on its own rather than a silent guess. */
function evaluateGate(expr, held) {
  const can = (...keys) => keys.some((k) => held.has(k));
  const canAnyIn = (group) => [...held].some((k) => k.startsWith(`${group}.`));
  const unknowns = [];
  const stub = (name) => { unknowns.push(name); return true; };
  const scope = {
    can,
    canAnyIn,
    SRV: { enabled: stub('SRV.enabled') },
    canOpenSettings: () => settingsSections().some((s) => held.has(s.key)),
    mayEditCurrentProject: () => stub('mayEditCurrentProject'),
    state: { currentUser: {}, project: null },
  };
  let value;
  try {
    // eslint-disable-next-line no-new-func
    value = new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope));
  } catch (err) {
    return { value: null, note: `UNEVALUATED (${err.message})` };
  }
  return { value: Boolean(value), note: unknowns.length ? `assumes ${[...new Set(unknowns)].join(', ')}` : '' };
}

/* --------------------------------------------------------------- the routes */

const ROUTES = collect();

/* Which routes a role can call, decided from the guard the route declares.
 *
 *   permission:k      callable when the role holds k
 *   permission-any:…  callable when the role holds any of them
 *   super-admin       callable only by a Super Admin
 *   anything else     NOT DECIDED HERE — a membership check, a workflow verdict,
 *                     a row-level predicate. Listed as `conditional`, because
 *                     the honest answer for "can a Production Manager call
 *                     POST /assets/:id/review" is "it depends on the asset".
 */
function routeVerdict(route, held, roleKey) {
  const keys = route.guards.filter((g) => g.startsWith('permission:')).map((g) => g.slice('permission:'.length));
  const anyOf = route.guards.filter((g) => g.startsWith('permission-any:'))
    .flatMap((g) => g.slice('permission-any:'.length).split('|'));
  if (route.guards.includes('super-admin')) return roleKey === 'super_admin' ? 'yes' : 'no';
  if (route.guards.includes('service-credential')) return 'service';
  if (keys.length) return keys.every((k) => held.has(k)) ? 'yes' : 'no';
  if (anyOf.length) return anyOf.some((k) => held.has(k)) ? 'yes' : 'no';
  return 'conditional';
}

/* ------------------------------------------------------------------ the file */

function build() {
  const lines = [];
  lines.push('# WHAT EACH BUILT-IN ROLE CAN SEE AND CALL');
  lines.push('#');
  lines.push('# GENERATED — do not edit. node scripts/permission-snapshot.js');
  lines.push('# tests/permission-snapshot.test.js fails if the tree and this file disagree.');
  lines.push('#');
  lines.push('# A deliberate change to anybody\'s visibility is made by regenerating this');
  lines.push('# file, so it lands in the diff where a reviewer will see it.');
  lines.push('#');
  lines.push(`# roles: ${roles.roleKeys().length}   routes: ${ROUTES.length}`);
  lines.push('');

  const gates = uiGates();
  const sections = settingsSections();

  lines.push('## PAGE ELEMENTS  (UI_GATES, read from public/index.html)');
  lines.push('');
  for (const { element, expr } of gates) lines.push(`gate ${element} := ${expr.replace(/\s+/g, ' ')}`);
  lines.push('');
  lines.push('## SETTINGS SECTIONS  (SETTINGS_SECTIONS, read from public/index.html)');
  lines.push('');
  for (const s of sections) lines.push(`section ${s.key} := ${s.label}`);
  lines.push('');

  for (const roleKey of roles.roleKeys()) {
    const held = catalog.baselineFor(roles.capabilitiesFor(roleKey));
    lines.push(`## ROLE ${roleKey}`);
    lines.push(`keys(${held.size}): ${[...held].sort().join(' ')}`);

    const visible = [];
    for (const { element, expr } of gates) {
      const { value, note } = evaluateGate(expr, held);
      visible.push(`  ${element}=${value === null ? '?' : (value ? 'yes' : 'no')}${note ? ` (${note})` : ''}`);
    }
    lines.push('sees:');
    lines.push(...visible);

    lines.push('settings sections:');
    for (const s of sections) lines.push(`  ${s.key}=${held.has(s.key) ? 'yes' : 'no'}`);

    const calls = ROUTES.filter((r) => r.mutating)
      .map((r) => `  ${r.id} = ${routeVerdict(r, held, roleKey)}`);
    lines.push('write routes:');
    lines.push(...calls);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const text = build();
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${text.split('\n').length} lines, ${text.length} bytes`);
}
module.exports = { build, uiGates, settingsSections, routeVerdict, ROUTES };
