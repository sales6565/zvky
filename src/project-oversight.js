/* Attaching somebody to a project so they can SEE it, and nothing more.
 *
 * WHAT THE STUDIO ASKED FOR. The MIS team need to look into projects — the
 * board, the time, the reports — without being working members of them. "Only
 * view, no editing, no adding, nothing."
 *
 * WHY THERE IS NO NEW MEMBERSHIP TABLE HERE. The application already answers
 * "which projects may this person see" from four per-project lists, and
 * project_members is the one its narrowest scope reads. Putting an MIS analyst
 * in it makes the project visible to them immediately, with no new permission
 * layer and no second answer to a question the permission checks already ask. A
 * fifth table meaning "can see this project" would have been exactly that
 * second answer, and the first screen to read one and not the other would have
 * been a bug nobody could see coming.
 *
 * WHY THAT IS SAFE, AND WHERE IT IS NOT. The read/write split is not this
 * module's doing — it falls out of the designation. The people listed by
 * eligible() below cannot be handed work (assignable is false) and do not run a
 * team (leadsTeam is false), so being on a project gets them the board and the
 * reports and refuses them creating, editing, deleting, assigning, starting,
 * submitting, reviewing and reassigning. Every one of those was checked against
 * a running server rather than assumed; see tests/mis-project-access.test.js.
 *
 * The one place it did NOT fall out that way was asset notes, which asked only
 * "can you see this asset" and let anybody who could, write one. That is fixed
 * at the endpoint rather than worked around here — see the note on
 * writesToPipeline() below.
 */

const { roleDef, roleKeys } = require('./roles');

/* Designations for whom "attached to a project" means VIEW and nothing else.
 *
 * Read off the catalogue rather than named, so a designation a Super Admin adds
 * on the Staff tier appears here without a code change — and so this cannot
 * drift from the rule it is meant to express. The three conditions are the
 * whole of that rule:
 *
 *   !assignable        work cannot be given to them, so they can never be the
 *                      assignee that most write paths require
 *   !leadsTeam         they have no review queue and no team's work to act on
 *   own_work scope     their reach is what they are explicitly put on
 *
 * That is the Staff tier as the catalogue describes it — "in the studio
 * directory with the asset pipeline closed" — expressed as the properties that
 * make it true instead of as the tier's name.
 */
function viewOnlyRole(def) {
  return Boolean(def && !def.assignable && !def.leadsTeam && def.projectScope === 'own_work');
}

const viewOnlyRoleKeys = () => roleKeys().filter((key) => viewOnlyRole(roleDef(key)));

/* The inverse question, asked by the pipeline's one write that is gated on
 * visibility alone.
 *
 * A designation whose pipeline is closed does not write to the pipeline. That
 * is what the Staff tier already MEANT; it simply was not enforced anywhere,
 * because until a staff account could see an asset at all the question never
 * came up. Attaching them to projects is what makes it come up.
 */
const writesToPipeline = (role) => !viewOnlyRole(roleDef(role));

/* Everybody who may be attached this way, with the project ids they are on.
 *
 * One query for the people and one for the rows, rather than one per person:
 * this is a Settings screen listing the whole of the studio's staff side
 * against the whole of its project list. */
async function roster(db) {
  const keys = viewOnlyRoleKeys();
  if (!keys.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, u.role, u.is_active
       FROM users u
      WHERE u.role IN ($1) AND u.is_active = 1
      ORDER BY u.\`name\``,
    [keys]
  );
  if (!rows.length) return [];

  const { rows: links } = await db.query(
    `SELECT m.user_id, m.project_id, m.assigned_by, m.assigned_at, b.\`name\` AS assigned_by_name
       FROM project_members m
       LEFT JOIN users b ON b.id = m.assigned_by
      WHERE m.user_id IN ($1)`,
    [rows.map((r) => r.id)]
  );
  const byUser = new Map();
  for (const link of links) {
    if (!byUser.has(link.user_id)) byUser.set(link.user_id, []);
    byUser.get(link.user_id).push({
      projectId: link.project_id,
      assignedBy: link.assigned_by || null,
      assignedByName: link.assigned_by_name || null,
      assignedAt: link.assigned_at || null,
    });
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    roleLabel: (roleDef(r.role) || {}).label || r.role,
    projects: byUser.get(r.id) || [],
  }));
}

const isEligible = async (db, userId) => {
  const { rows } = await db.query('SELECT role FROM users WHERE id = $1 AND is_active = 1', [userId]);
  return rows.length ? viewOnlyRole(roleDef(rows[0].role)) : false;
};

/* Attach and detach, one pair at a time.
 *
 * INSERT IGNORE rather than a check-then-insert: the primary key is already
 * (project_id, user_id), so attaching somebody twice is the same state as
 * attaching them once and racing two clicks should not be an error. The return
 * says whether anything actually changed, so the caller can keep the audit log
 * free of entries recording that nothing happened.
 */
async function attach(db, projectId, userId, byUserId) {
  if (!(await isEligible(db, userId))) {
    return {
      ok: false,
      status: 400,
      error: 'Only a designation with the asset pipeline closed can be given view-only access this way. '
        + 'Somebody who works on projects is put on one from their profile instead.',
    };
  }
  const { result } = await db.query(
    `INSERT IGNORE INTO project_members (project_id, user_id, assigned_by, assigned_at)
     VALUES ($1, $2, $3, NOW())`,
    [projectId, userId, byUserId || null]
  );
  return { ok: true, changed: Boolean(result && result.affectedRows) };
}

async function detach(db, projectId, userId) {
  const { result } = await db.query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return { ok: true, changed: Boolean(result && result.affectedRows) };
}

/* The whole of one person's project list, set at once.
 *
 * What the screen's multi-select means: these projects and no others. Returns
 * what actually changed on each side so the audit entry can name the projects
 * rather than say "changed". */
async function setProjects(db, userId, projectIds, byUserId) {
  if (!(await isEligible(db, userId))) {
    return {
      ok: false,
      status: 400,
      error: 'Only a designation with the asset pipeline closed can be given view-only access this way.',
    };
  }
  const wanted = [...new Set((projectIds || []).map(String).filter(Boolean))];
  if (wanted.length) {
    const { rows } = await db.query('SELECT id FROM projects WHERE id IN ($1)', [wanted]);
    if (rows.length !== wanted.length) {
      return { ok: false, status: 400, error: 'Some of those projects no longer exist.' };
    }
  }
  const { rows: had } = await db.query(
    'SELECT project_id FROM project_members WHERE user_id = $1', [userId]
  );
  const before = new Set(had.map((r) => String(r.project_id)));
  const added = wanted.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !wanted.includes(id));

  for (const projectId of added) await attach(db, projectId, userId, byUserId);
  for (const projectId of removed) await detach(db, projectId, userId);
  return { ok: true, added, removed, projects: wanted };
}

module.exports = {
  viewOnlyRole, viewOnlyRoleKeys, writesToPipeline,
  roster, isEligible, attach, detach, setProjects,
};
