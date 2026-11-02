#!/usr/bin/env node
/* docs/permissions-matrix.md — the inventory, generated from the tree.
 *
 * Joins three sources that are each the truth about their own half:
 *   src/permission-areas.js   the areas, their view and write keys, the audit
 *                             class, and the notes a reader needs;
 *   scripts/route-guards.js   every route and the guard it really declares;
 *   src/permission-catalog.js the keys, their labels and their defaults;
 *   public/index.html         UI_GATES and SETTINGS_SECTIONS, read not copied.
 *
 * A hand-written matrix would be wrong within a prompt or two. This one is
 * regenerated, and tests/permissions-matrix.test.js fails if it is stale.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'permissions-matrix.md');

const areas = require(path.join(ROOT, 'src', 'permission-areas'));
const catalog = require(path.join(ROOT, 'src', 'permission-catalog'));
const roles = require(path.join(ROOT, 'src', 'roles'));
const { collect } = require(path.join(__dirname, 'route-guards.js'));
const { uiGates, settingsSections } = require(path.join(__dirname, 'permission-snapshot.js'));

const ROUTES = collect();
const GATES = uiGates();
const SECTIONS = settingsSections();

const keyLabel = (key) => {
  const p = catalog.BY_KEY ? catalog.BY_KEY.get(key) : null;
  return p ? p.label : (catalog.isPermission(key) ? key : `${key} (new)`);
};
const holders = (key) => roles.roleKeys()
  .filter((r) => catalog.baselineFor(roles.capabilitiesFor(r)).has(key));

/* The routes that belong to an area, matched by the keys the area names. A
   route with no permission guard is matched by nothing and appears in the
   unguarded list at the end, which is the point of that list. */
function routesFor(area) {
  const keys = new Set([area.view, area.addView, ...(area.writes || [])].filter(Boolean));
  return ROUTES.filter((r) => r.guards.some((g) => g.startsWith('permission')
    && g.replace(/^permission(-any)?:/, '').split('|').some((k) => keys.has(k))));
}

function md() {
  const out = [];
  out.push('# Who can see what, and who can change it');
  out.push('');
  out.push('> GENERATED — `node scripts/permissions-matrix.js`. `tests/permissions-matrix.test.js`');
  out.push('> fails if this file is stale. Edit `src/permission-areas.js`, not this.');
  out.push('');
  out.push('Forge decides visibility with **permission keys**, never with a role tier: the page');
  out.push('asks `can(key)` and the server asks `requirePermission(key)`. Prompt 61 added a');
  out.push('**view key** to every area that had only a key for changing things, so a role can be');
  out.push('allowed to read a screen without being allowed to touch it.');
  out.push('');
  out.push('**Write implies view.** Every write key implies its area\'s view key, so no existing');
  out.push('role lost anything: the roles screen shows the view as on and locked while any write');
  out.push('key is on. A view key given **alone** is the view-only role.');
  out.push('');
  out.push('**A view key never widens scope.** It decides whether a screen opens, not which rows');
  out.push('it shows — `visibleProjects()` and the per-row checks are untouched.');
  out.push('');

  const byClass = { A: [], B: [], C: [], D: [] };
  for (const a of areas.AREAS) byClass[a.class].push(a);
  out.push('## The audit, by class');
  out.push('');
  out.push('| Class | What it means | Areas |');
  out.push('|---|---|---|');
  out.push(`| **A** | already had a proper view key, enforced on the server and used by the page — **left exactly as it was** | ${byClass.A.length} |`);
  out.push(`| **B** | had write keys and no view key: visibility came from the key that changes things — **view key added** | ${byClass.B.length} |`);
  out.push(`| **C** | visible by role tier, or by nothing at all — **view key added, defaults reproduce today exactly** | ${byClass.C.length} |`);
  out.push(`| **D** | self scope (my own week, my own inbox, a chat I am in) — **not governed by view-only roles** | ${byClass.D.length} |`);
  out.push('');

  out.push('## Every area');
  out.push('');
  out.push('| Area | Class | View key | Write keys | Settings section | Page gates | Routes |');
  out.push('|---|---|---|---|---|---|---|');
  for (const a of areas.AREAS) {
    const view = a.addView ? `**${a.addView}** *(new)*` : (a.view ? `\`${a.view}\`` : '—');
    const writes = (a.writes || []).map((k) => `\`${k}\``).join(' ') || '—';
    const sections = areas.sectionsOf(a).map((k) => `\`${k}\``).join(' ') || '—';
    const gates = (a.gates || []).join(' ') || '—';
    out.push(`| ${a.label} | ${a.class} | ${view} | ${writes} | ${sections} | ${gates} | ${routesFor(a).length} |`);
  }
  out.push('');

  out.push('## What each area is, and why it is in that class');
  out.push('');
  for (const a of areas.AREAS) {
    if (!a.note) continue;
    out.push(`### ${a.label} — class ${a.class}`);
    out.push('');
    out.push(a.note);
    out.push('');
  }

  out.push('## The view keys this prompt added');
  out.push('');
  out.push('| New view key | Area | Implied by | Default holders |');
  out.push('|---|---|---|---|');
  for (const a of areas.AREAS.filter((x) => x.addView)) {
    const who = holders(a.addView);
    out.push(`| \`${a.addView}\` | ${a.label} | ${(a.writes || []).map((k) => `\`${k}\``).join(' ') || '—'} `
      + `| ${who.length === roles.roleKeys().length ? 'every designation' : (who.length ? `${who.length}: ${who.slice(0, 6).join(', ')}${who.length > 6 ? ' …' : ''}` : 'none yet')} |`);
  }
  out.push('');

  out.push('## Routes whose guard the static reader cannot see');
  out.push('');
  out.push('Reported rather than hidden: these decide inside the handler — a membership check, a');
  out.push('workflow verdict, a row-level predicate, or a self scope. `src/route-manifest.js`');
  out.push('states what each one really leans on, and `tests/route-manifest.test.js` fails if a');
  out.push('route is missing from it.');
  out.push('');
  const guarded = (r) => r.guards.some((g) => g.startsWith('permission') || g.startsWith('middleware'))
    || r.guards.includes('super-admin') || r.guards.includes('service-credential');
  const loose = ROUTES.filter((r) => !guarded(r));
  out.push('| Route | Mutating | What was found in the handler |');
  out.push('|---|---|---|');
  for (const r of loose) {
    out.push(`| \`${r.id}\` | ${r.mutating ? '**yes**' : 'no'} | ${r.inline.join(', ') || '**nothing**'} |`);
  }
  out.push('');
  out.push(`${ROUTES.length} routes in all; ${ROUTES.filter((r) => r.mutating).length} mutating; `
    + `${loose.length} with no guard in a middleware position.`);
  out.push('');

  out.push('## The page\'s own tables');
  out.push('');
  out.push('`UI_GATES` — every element whose visibility is a permission question:');
  out.push('');
  out.push('| Element | Gate |');
  out.push('|---|---|');
  for (const g of GATES) out.push(`| ${g.element} | \`${g.expr.replace(/\s+/g, ' ')}\` |`);
  out.push('');
  out.push('`SETTINGS_SECTIONS` — every Settings section and the key that reveals it:');
  out.push('');
  out.push('| Section | Key |');
  out.push('|---|---|');
  for (const s of SECTIONS) out.push(`| ${s.label} | \`${s.key}\` |`);
  out.push('');
  return `${out.join('\n')}\n`;
}

const text = md();
if (process.argv.includes('--stdout')) process.stdout.write(text);
else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${text.split('\n').length} lines`);
}
module.exports = { md };
