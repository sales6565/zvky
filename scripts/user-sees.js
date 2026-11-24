#!/usr/bin/env node
/* WHY THIS PERSON DOES OR DOES NOT SEE A PROJECT'S ASSETS — read out of the real rules.
 *
 * ===========================================================================
 * WHAT THIS IS FOR.
 *
 * The bug it was written for looked like data loss. An owner names somebody Acting Team
 * Lead; that person opens the project and the board is empty. Nothing is refused, nothing
 * is logged, and every explanation is plausible: the wrong project, a filter, the assets
 * belonging to somebody else, a permission. Answering it meant reading three functions in
 * two files and knowing which of them the board actually calls.
 *
 * So this asks the application's own functions — permissions.seesWholeProject(),
 * permissions.visibleProjects() and permissions.leadTablesFor() — and prints the answer
 * with the reason beside it. It is not a second copy of the rules: if it disagreed with
 * the board, the board would be right and this would be the bug.
 *
 * ===========================================================================
 * IT WRITES NOTHING. No INSERT, no UPDATE, no DELETE, no route. It opens the database the
 * application opens, runs SELECTs, prints, and exits — safe to run against production
 * while somebody is on the phone. tests/user-sees-script.test.js asserts the absence of
 * every writing verb in this file, so the next person to edit it cannot quietly add one.
 *
 * Usage:
 *   node scripts/user-sees.js <name, email or id> [project name, code or id]
 *
 * Exit codes: 0 answered, 1 nobody matched, 2 ambiguous.
 */
const db = require('../src/db');
const permissions = require('../src/permissions');
const { roleDef } = require('../src/roles');

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('usage: node scripts/user-sees.js <name, email or id> [project]');
  process.exit(1);
}
const who = argv[0];
const whichProject = argv[1] || null;

/* One person, found the way a human would name them: an id, an email, or a name they go
   by. Ambiguity is reported rather than guessed at — picking one of two people called
   Sam is how a diagnostic tells somebody the wrong thing with confidence. */
async function findUser(term) {
  const { rows } = await db.query(
    `SELECT id, name, email, role, is_active FROM users
      WHERE id = $1 OR email = $1 OR name = $1
         OR LOWER(name) LIKE CONCAT('%', LOWER($1), '%')
      ORDER BY (id = $1) DESC, (email = $1) DESC, (name = $1) DESC, name
      LIMIT 10`,
    [term]
  );
  return rows;
}

async function findProjects(term) {
  if (!term) {
    const { rows } = await db.query(
      'SELECT id, name, code, is_active, owner_id FROM projects ORDER BY created_at'
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT id, name, code, is_active, owner_id FROM projects
      WHERE id = $1 OR code = $1 OR name = $1 OR LOWER(name) LIKE CONCAT('%', LOWER($1), '%')
      ORDER BY created_at`,
    [term]
  );
  return rows;
}

/* The counts, from the asset table directly: how many assets the project has, and how many
   of them are this person's own assignments. Everything else on the line is derived from
   the application's functions, never from a second copy of a visibility query. */
async function assetCounts(projectId, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN assignee_id = $2 THEN 1 ELSE 0 END) AS mine
       FROM assets WHERE project_id = $1`,
    [projectId, userId]
  );
  return { total: Number(rows[0].total) || 0, mine: Number(rows[0].mine) || 0 };
}

(async () => {
  const candidates = await findUser(who);
  if (!candidates.length) {
    console.error(`No user matches ${JSON.stringify(who)}.`);
    process.exit(1);
  }
  if (candidates.length > 1 && !candidates.some((u) => u.id === who || u.email === who || u.name === who)) {
    console.error(`${candidates.length} users match ${JSON.stringify(who)}:`);
    for (const u of candidates) console.error(`  ${u.name} <${u.email}> ${u.id}`);
    console.error('Name one exactly, or pass the id.');
    process.exit(2);
  }
  const user = candidates[0];
  const def = roleDef(user.role) || {};

  /* The user as the application sees it. permissions.visibleProjects() reads `role` and
     `id`, which is what this object carries — the same shape authenticate() builds. */
  const subject = { id: user.id, role: user.role };

  console.log(`USER      ${user.name} <${user.email}>`);
  console.log(`          id ${user.id}`);
  console.log(`          designation ${user.role}${user.is_active ? '' : ' (DEACTIVATED)'}`);
  console.log(`          projectScope ${def.projectScope || '?'}`
    + `   leadsTeam ${Boolean(def.leadsTeam)}   assignable ${Boolean(def.assignable)}`);
  console.log();

  const visible = await permissions.visibleProjects(subject);
  const visibleIds = new Set(visible.map((p) => p.id));
  const teams = await permissions.projectTeamIdsFor(user.id);
  console.log(`VISIBLE PROJECTS  ${visible.length} (permissions.visibleProjects)`);
  console.log(`ON THE TEAM OF    ${teams.length} project(s) (PROJECT_TEAM_TABLES)`);
  console.log();

  const projects = await findProjects(whichProject);
  if (!projects.length) {
    console.error(`No project matches ${JSON.stringify(whichProject)}.`);
    process.exit(1);
  }

  console.log('PER PROJECT');
  for (const p of projects) {
    const counts = await assetCounts(p.id, user.id);
    const reachable = visibleIds.has(p.id);
    const whole = await permissions.seesWholeProject(subject, p.id);
    const tables = await permissions.leadTablesFor(user.id, p.id);

    /* WHICH RULE APPLIED, in the order the functions ask it — so the line reads as the
       reason and not only as the verdict. */
    let why;
    if (!p.is_active) why = 'project is ARCHIVED — out of every scope, for everybody';
    else if (!reachable) why = `not reachable: scope '${def.projectScope}' does not include it`
      + `${p.owner_id === user.id ? ' (but they own it?)' : ''}`;
    else if (def.projectScope === 'all') why = "designation scope 'all'";
    else if (def.leadsTeam) why = 'designation leadsTeam, and the project is in scope';
    else if (tables.length) why = `named on ${tables.join(' + ')}`;
    else if (whole) why = 'designation is not a contributor, and the project is in scope';
    else why = 'contributor, and not named on any of this project\'s team lists';

    const seen = whole ? counts.total : counts.mine;
    const hidden = counts.total - seen;
    console.log(`  ${(p.code || '?').padEnd(6)} ${p.name}`);
    console.log(`         sees ${whole ? 'EVERY asset' : 'only their own assignments'}`
      + `   visible ${seen}/${counts.total}   hidden ${hidden}`);
    console.log(`         why: ${why}`);
    if (tables.length) console.log(`         team lists: ${tables.join(', ')}`);
  }

  /* A line nobody has to work out from the above. */
  const leadOf = [];
  for (const p of projects) {
    if (visibleIds.has(p.id) && (await permissions.leadTablesFor(user.id, p.id)).length) leadOf.push(p.name);
  }
  console.log();
  console.log(`LEAD-LEVEL VISIBILITY ON: ${leadOf.length ? leadOf.join(', ') : '(none)'}`);
  process.exit(0);
})().catch((err) => {
  console.error(`user-sees: ${err.message}`);
  process.exit(1);
});
