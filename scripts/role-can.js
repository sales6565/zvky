#!/usr/bin/env node
/* WHAT ONE ROLE MAY DO TO A PROJECT, AND WHY.
 *
 *   node scripts/role-can.js producer
 *   node scripts/role-can.js "Senior Producer"
 *   node scripts/role-can.js producer --json
 *   node scripts/role-can.js --roles            (just list the role keys)
 *
 * ===========================================================================
 * WHY IT EXISTS. An owner switched Project Edit on for a designation, the
 * Settings screen showed it held, and nothing happened — no pencil on the
 * project, 403 from the API. Answering "what does this role actually hold, and
 * what does each control do with it" meant reading four files and a database.
 * This prints it.
 *
 * It is the thing to run FIRST the next time somebody reports a granted
 * permission doing nothing, because it separates the two halves of every one of
 * these decisions and names which half said no.
 *
 * ===========================================================================
 * READ-ONLY, AND SAFE TO RUN ON PRODUCTION. Every statement goes through q()
 * below, which REFUSES anything matching INSERT / UPDATE / DELETE / ALTER /
 * DROP / CREATE / TRUNCATE / REPLACE / GRANT, so a query added here carelessly
 * throws instead of writing. The driver's multi-statement support is off
 * (src/db.js never turns it on), so a second statement cannot ride behind a
 * SELECT. tests/project-authority.test.js runs it against a populated database
 * through a recording handle and asserts every statement begins with SELECT and
 * that no row count changes.
 *
 * THAT IS WHY IT DOES NOT CALL rolePermissions.effectiveFor(), which is the
 * function the application judges requests by. effectiveFor WRITES: ownFor()
 * seeds a role that has no rows and topUpRole() back-fills catalogue keys added
 * since the role was last saved. Harmless in the application, not acceptable in
 * a diagnostic somebody runs on a live studio to find out why a permission is
 * not working. So the effective set is rebuilt here from reads alone — and
 * tests/project-authority.test.js asserts the two agree, role by role, on a
 * database where both can be asked.
 *
 * ===========================================================================
 * WHAT IT DOES NOT DO: decide anything about a PARTICULAR project.
 *
 * Every control below is two questions — does the role hold the key, and is the
 * project one the role can see. The first has one answer per role and is what
 * this prints. The second has one answer per (role, project) pair and is
 * decided by permissions.reachesProject(); reporting it would mean either
 * walking every project for a made-up user of the role, or writing a second
 * copy of the scope rule in here, and a second copy of that rule is the bug
 * this script was written to diagnose. So the scope half is printed as the rule
 * it is, per control, and the key half is printed as a verdict.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const catalog = require(path.join(ROOT, 'src', 'permission-catalog'));
const authority = require(path.join(ROOT, 'src', 'project-authority'));
const { roleDef, entries } = require(path.join(ROOT, 'src', 'roles'));

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|REPLACE|GRANT)\b/i;

/* WHAT EACH SCOPE REACHES, in the words the rule uses. Not a second copy of the
   rule — reachesProject() is still the only thing that decides it — but the
   reader needs to know what "the projects this role can see" comes to for the
   scope in front of them, and these are the five values roleDef can carry. */
const SCOPE_MEANS = {
  all: 'every project in the studio',
  owned: 'the projects this account created',
  assigned: 'the projects this account is named on (lead, acting lead, coordinator, '
    + 'supervision) and the ones it created',
  team: 'the projects this account is named on, the ones holding a report’s work, '
    + 'and the ones it created',
  own_work: 'the projects holding this account’s own assets, the ones it is a member '
    + 'of, and the ones it created',
};

async function main(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const write = opts.write || ((text) => process.stdout.write(text));
  const asJson = argv.includes('--json');
  const wanted = argv.filter((a) => !a.startsWith('--'))[0] || null;

  const db = opts.db || require(path.join(ROOT, 'src', 'db'));
  const q = async (sql, params = []) => {
    if (FORBIDDEN.test(sql)) throw new Error(`role-can is read-only; refused: ${sql}`);
    const { rows } = await db.query(sql, params);
    return rows;
  };

  /* THE ROLE. Named by key ("senior_producer") or by label ("Senior Producer"),
     because the person running this has just read one off the Settings screen
     and should not have to know which of the two it was. */
  const all = entries();
  const match = (r) => r.key === wanted
    || String(r.key).toLowerCase() === String(wanted).toLowerCase()
    || String(r.label || '').toLowerCase() === String(wanted).toLowerCase();

  if (!wanted || argv.includes('--roles')) {
    const out = all.map((r) => `  ${String(r.key).padEnd(44)} ${r.label || ''}`);
    write(`${wanted ? '' : 'Name a role. '}Roles in this install:\n${out.join('\n')}\n`);
    return { roles: all.map((r) => r.key) };
  }
  const role = all.find(match);
  if (!role) {
    write(`No role called "${wanted}". Run with --roles to list them.\n`);
    return { error: 'unknown role', role: wanted };
  }
  const def = roleDef(role.key);

  /* THE EFFECTIVE SET, REBUILT FROM READS. Three sources, in the order
     effectiveFor applies them, and each key is reported with the one it came
     from — because "the role holds it" and "a group grants it" are different
     facts to the person deciding what to change. */
  const superAdmin = authority.isSuperAdmin(role.key);

  const stored = new Map();
  for (const row of await q(
    'SELECT permission_key, enabled FROM role_permissions WHERE role_key = $1', [role.key]
  )) stored.set(row.permission_key, Boolean(Number(row.enabled)));

  const groups = new Map();
  try {
    for (const row of await q(
      `SELECT DISTINCT g.\`name\`, gp.permission_key
         FROM role_group_members gm
         JOIN role_groups g ON g.id = gm.group_id
         JOIN role_group_permissions gp ON gp.group_id = gm.group_id
        WHERE gm.role_key = $1`, [role.key]
    )) {
      if (!groups.has(row.permission_key)) groups.set(row.permission_key, []);
      groups.get(row.permission_key).push(row.name);
    }
  } catch (err) {
    /* An install whose role-group migration has not run. The application reads
       this as "no groups" too, so the diagnostic must not differ from it. */
    if (!/doesn't exist|Unknown column|ER_NO_SUCH_TABLE/i.test(err.sqlMessage || err.message || '')) throw err;
  }

  const sourceOf = (key) => {
    if (superAdmin) return 'super admin (the whole catalogue, always)';
    if (stored.get(key) === true) return 'the role';
    if (groups.has(key)) return `group: ${groups.get(key).join(', ')}`;
    /* NO STORED ROW AT ALL means the key was added to the catalogue after this
       role was last written. The application fills that gap with the key's
       DEFAULT the next time it is asked (topUpRole), so that is what it
       effectively holds, and saying otherwise here would be a diagnostic that
       disagrees with the thing it is diagnosing. */
    if (!stored.has(key) && catalog.baselineFor(def).has(key)) return 'catalogue default (no stored row yet)';
    return null;
  };
  const held = new Set(catalog.KEYS.filter((k) => sourceOf(k) !== null));

  /* THE VERDICTS. The key half through the shared rule itself — not a
     paraphrase of it — with reaches() held true, so the answer reads "for a
     project this role can see". */
  const access = { holds: (key) => held.has(key), reaches: () => true };
  const controls = authority.CONTROLS.map((c) => {
    const verdict = c.decide(access, { id: '(any project)' });
    return {
      id: c.id,
      control: c.control,
      key: c.key,
      pageGate: c.pageGate,
      routes: c.routes,
      allowed: verdict.ok,
      code: verdict.code,
      reason: verdict.ok
        ? `holds ${c.key} (${sourceOf(c.key)}) — for ${SCOPE_MEANS[def.projectScope] || 'the projects it can see'}`
        : verdict.reason,
    };
  });

  const report = {
    role: role.key,
    label: role.label || null,
    tier: def.tier || null,
    projectScope: def.projectScope,
    scopeMeans: SCOPE_MEANS[def.projectScope] || null,
    superAdmin,
    effective: [...held].map((k) => ({ key: k, source: sourceOf(k) })),
    controls,
  };

  if (asJson) { write(`${JSON.stringify(report, null, 2)}\n`); return report; }

  const out = [];
  out.push(`role           ${role.key}${role.label ? `  (${role.label})` : ''}`);
  out.push(`tier           ${def.tier || '(none)'}`);
  out.push(`project scope  ${def.projectScope}  — ${report.scopeMeans}`);
  out.push(`creates projects: ${def.createProject ? 'yes' : 'no'}`
    + `${def.createProject ? '' : '  (so it is never a project’s owner — see src/project-authority.js)'}`);
  out.push('');
  out.push('project controls');
  for (const c of controls) {
    out.push(`  ${c.allowed ? 'ALLOWED' : 'DENIED '}  ${c.control}`);
    out.push(`           key ${c.key}   page ${c.pageGate}   ${c.routes.join(', ')}`);
    out.push(`           ${c.reason}`);
  }
  out.push('');
  out.push(`effective permissions (${held.size} of ${catalog.KEYS.length})`);
  for (const e of report.effective) out.push(`  ${e.key.padEnd(34)} ${e.source}`);
  write(`${out.join('\n')}\n`);
  return report;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, FORBIDDEN, SCOPE_MEANS };
