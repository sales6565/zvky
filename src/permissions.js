const db = require('./db');
const { roleDef, ASSIGNABLE_ROLES, LEAD_ROLES } = require('./roles');

// Access rules, expressed against the capabilities in src/roles.js rather than
// against particular job titles. A new designation gets the right access purely
// from its entry in the catalogue — nothing here needs to change.

// Every project this user is allowed to see, per their role's projectScope:
//  'all'      — the whole studio (super admin, art director)
//  'owned'    — projects they created (admin)
//  'assigned' — projects they're explicitly attached to (coordinator)
//  'team'     — projects they lead, plus any holding work by one of their reports
//  'own_work' — projects containing an asset assigned to them (contributors)
async function visibleProjects(user) {
  const def = roleDef(user.role);
  if (!def) return [];

  if (def.projectScope === 'all') {
    const { rows } = await db.query('SELECT * FROM projects ORDER BY created_at');
    return rows;
  }

  if (def.projectScope === 'owned') {
    const { rows } = await db.query(
      'SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at',
      [user.id]
    );
    return rows;
  }

  if (def.projectScope === 'assigned') {
    const { rows } = await db.query(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_coordinators pc ON pc.project_id = p.id AND pc.user_id = $1
       LEFT JOIN project_team_leads  ptl ON ptl.project_id = p.id AND ptl.user_id = $1
       WHERE pc.user_id IS NOT NULL OR ptl.user_id IS NOT NULL
       ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }

  if (def.projectScope === 'team') {
    // Either they're named as a lead on the project, or one of their reports
    // has an asset in it. Supervisors who run a discipline rather than a
    // project are only ever reachable through the second half.
    const { rows } = await db.query(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_team_leads ptl ON ptl.project_id = p.id AND ptl.user_id = $1
       LEFT JOIN assets a ON a.project_id = p.id
       LEFT JOIN users  r ON r.id = a.assignee_id AND r.team_lead_id = $1
       WHERE ptl.user_id IS NOT NULL OR r.id IS NOT NULL
       ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }

  // 'own_work'
  const { rows } = await db.query(
    `SELECT DISTINCT p.* FROM projects p
     JOIN assets a ON a.project_id = p.id
     WHERE a.assignee_id = $1 ORDER BY p.created_at`,
    [user.id]
  );
  return rows;
}

async function canAccessProject(user, projectId) {
  const projects = await visibleProjects(user);
  return projects.some((p) => p.id === projectId);
}

// Is the given user one of this user's direct reports?
async function isReport(user, userId) {
  if (!userId) return false;
  const { rows } = await db.query(
    'SELECT 1 AS ok FROM users WHERE id = $1 AND team_lead_id = $2',
    [userId, user.id]
  );
  return rows.length > 0;
}

// Can this user view a specific asset (read access)?
async function canViewAsset(user, asset) {
  const def = roleDef(user.role);
  if (!def) return false;
  if (def.projectScope === 'all') return true;
  if (def.assignable) return asset.assignee_id === user.id;
  if (def.leadsTeam) {
    if (await isReport(user, asset.assignee_id)) return true;
    return canAccessProject(user, asset.project_id);
  }
  // Admin and coordinator: must have access to the parent project.
  return canAccessProject(user, asset.project_id);
}

// Can this user edit status/priority/description/tasks on this asset?
// The art director is deliberately excluded: direction is given through the
// review action so that every decision is recorded as feedback on the asset.
async function canEditAsset(user, asset) {
  const def = roleDef(user.role);
  if (!def || !def.editAsset) return false;
  return canViewAsset(user, asset);
}

// Is this user a contributor the asset is actually assigned to?
function isAssignedArtist(user, asset) {
  const def = roleDef(user.role);
  return Boolean(def && def.assignable && asset.assignee_id === user.id);
}

// Is this user the lead or supervisor of the contributor this asset is assigned to?
async function isTeamLeadOfAsset(user, asset) {
  const def = roleDef(user.role);
  if (!def || !def.leadsTeam || !asset.assignee_id) return false;
  return isReport(user, asset.assignee_id);
}

// Holds the final review gate (art director, with super admin as an override).
function canReviewAsCD(user) {
  const def = roleDef(user.role);
  return Boolean(def && def.reviewStage === 'cd');
}

// May step into a review gate that isn't theirs, to unblock work when the
// assigned lead is unavailable. Deliberately narrow: a studio-wide role that
// also administers accounts, i.e. the super admin.
function canOverrideReview(user) {
  const def = roleDef(user.role);
  return Boolean(def && def.manageUsers && def.projectScope === 'all');
}

async function canMarkDelivered(user, asset) {
  const def = roleDef(user.role);
  if (!def || !def.deliver) return false;
  if (def.projectScope === 'all') return true;
  return canAccessProject(user, asset.project_id);
}

// Can this user delete the asset outright?
async function canDeleteAsset(user, asset) {
  const def = roleDef(user.role);
  if (!def || !def.deleteAsset) return false;
  if (def.deleteAsset === 'any') return true;
  const { rows } = await db.query('SELECT owner_id FROM projects WHERE id = $1', [asset.project_id]);
  return rows.length > 0 && rows[0].owner_id === user.id;
}

function canCreateAsset(user) {
  const def = roleDef(user.role);
  return Boolean(def && def.createAsset);
}
function canCreateProject(user) {
  const def = roleDef(user.role);
  return Boolean(def && def.createProject);
}
function canManageUsers(user) {
  const def = roleDef(user.role);
  return Boolean(def && def.manageUsers);
}

module.exports = {
  visibleProjects,
  canAccessProject,
  canViewAsset,
  canEditAsset,
  canDeleteAsset,
  canCreateAsset,
  canCreateProject,
  canManageUsers,
  isAssignedArtist,
  isTeamLeadOfAsset,
  canReviewAsCD,
  canOverrideReview,
  canMarkDelivered,
  isReport,
  ASSIGNABLE_ROLES,
  LEAD_ROLES,
};
