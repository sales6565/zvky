// Which project a person is on.
//
// The app stores this membership per role rather than in one column, because
// the three sides of a project mean different things to the permission checks:
//
//   project_coordinators  roles with projectScope 'assigned' — they run it
//   project_team_leads    roles with leadsTeam — they review its work
//   project_members       everyone else
//
// The first two already existed. The third is new: contributors — most of the
// studio — had no link to a project at all, so an artist could not be assigned
// to one. Adding a fourth source of truth on `users` would have been simpler to
// query and would have left the permission checks reading the old tables, so
// this follows the existing shape instead.
//
// One project per person, which is what the Edit User form offers. The tables
// can hold more, and anything already there is preserved for roles this form
// does not touch.

const { roleDef } = require('./roles');

const TABLES = ['project_coordinators', 'project_team_leads', 'project_members'];

// The side of a project this designation sits on.
function tableForRole(role) {
  const def = roleDef(role);
  if (!def) return 'project_members';
  if (def.projectScope === 'assigned') return 'project_coordinators';
  if (def.leadsTeam) return 'project_team_leads';
  return 'project_members';
}

// The project this person is on, whichever table holds them. Returns null when
// they are on none.
async function currentProject(db, userId) {
  for (const table of TABLES) {
    const { rows } = await db.query(
      `SELECT p.id, p.\`name\`, p.\`code\`
         FROM ${table} m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1
        ORDER BY p.\`name\` LIMIT 1`,
      [userId]
    );
    if (rows.length) return { ...rows[0], via: table };
  }
  return null;
}

// Same, for a page of users at once — the list view would otherwise issue three
// queries per row.
async function projectsForUsers(db, userIds) {
  const byUser = new Map();
  if (!userIds.length) return byUser;

  for (const table of TABLES) {
    const { rows } = await db.query(
      `SELECT m.user_id, p.id, p.\`name\`
         FROM ${table} m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id IN (?)`,
      [userIds]
    );
    for (const row of rows) {
      // First table wins, matching currentProject's order.
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, { id: row.id, name: row.name });
    }
  }
  return byUser;
}

// Put this person on one project, on the side their designation belongs to.
//
// Clears the other two tables as well, so a designation change moves the
// membership rather than leaving a stale row behind that the permission checks
// would still honour.
async function setProject(db, userId, projectId, role) {
  for (const table of TABLES) {
    await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
  if (!projectId) return null;

  const table = tableForRole(role);
  await db.query(
    `INSERT IGNORE INTO ${table} (project_id, user_id) VALUES ($1,$2)`,
    [projectId, userId]
  );
  return table;
}

// A designation change moves someone between sides of the project they are
// already on, without asking the caller to re-state which project that is.
async function moveForRole(db, userId, role) {
  const current = await currentProject(db, userId);
  if (!current) return null;
  const wanted = tableForRole(role);
  if (current.via === wanted) return current;
  await setProject(db, userId, current.id, role);
  return { ...current, via: wanted };
}

async function exists(db, projectId) {
  const { rows } = await db.query('SELECT id FROM projects WHERE id = $1', [projectId]);
  return rows.length > 0;
}

module.exports = { TABLES, tableForRole, currentProject, projectsForUsers, setProject, moveForRole, exists };
