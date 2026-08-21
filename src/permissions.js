const pool = require('./db');

// Returns every project this user is allowed to see, per the studio's access rules:
//  - super_admin: everything
//  - admin: only projects they personally created
//  - team_lead: projects they're listed as a lead on
//  - coordinator: projects they're assigned to
//  - artist: projects that contain an asset assigned to them
async function visibleProjects(user) {
  if (user.role === 'super_admin') {
    const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at');
    return rows;
  }
  if (user.role === 'admin') {
    const { rows } = await pool.query(
      'SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at',
      [user.id]
    );
    return rows;
  }
  if (user.role === 'coordinator') {
    const { rows } = await pool.query(
      `SELECT p.* FROM projects p
       JOIN project_coordinators pc ON pc.project_id = p.id
       WHERE pc.user_id = $1 ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }
  if (user.role === 'team_lead') {
    const { rows } = await pool.query(
      `SELECT p.* FROM projects p
       JOIN project_team_leads ptl ON ptl.project_id = p.id
       WHERE ptl.user_id = $1 ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }
  if (user.role === 'artist') {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.* FROM projects p
       JOIN assets a ON a.project_id = p.id
       WHERE a.assignee_id = $1 ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }
  if (user.role === 'creative_director') {
    // Creative direction spans the whole studio, not one project.
    const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at');
    return rows;
  }
  return [];
}

async function canAccessProject(user, projectId) {
  const projects = await visibleProjects(user);
  return projects.some((p) => p.id === projectId);
}

// Can this user view a specific asset (read access)?
async function canViewAsset(user, asset) {
  if (user.role === 'super_admin') return true;
  if (user.role === 'creative_director') return true; // reviews across the whole studio
  if (user.role === 'artist') return asset.assignee_id === user.id;
  if (user.role === 'team_lead') {
    if (!asset.assignee_id) return false;
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE id = $1 AND team_lead_id = $2',
      [asset.assignee_id, user.id]
    );
    return rows.length > 0;
  }
  // admin and coordinator: must have access to the parent project
  return canAccessProject(user, asset.project_id);
}

// Can this user edit status/priority/description/tasks on this asset?
async function canEditAsset(user, asset) {
  if (user.role === 'creative_director') return false; // CD only acts through the review endpoint
  return canViewAsset(user, asset); // same rule set otherwise for this studio
}

// Is this user the artist this asset is assigned to?
function isAssignedArtist(user, asset) {
  return user.role === 'artist' && asset.assignee_id === user.id;
}

// Is this user the team lead of the artist this asset is assigned to?
async function isTeamLeadOfAsset(user, asset) {
  if (user.role !== 'team_lead' || !asset.assignee_id) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND team_lead_id = $2',
    [asset.assignee_id, user.id]
  );
  return rows.length > 0;
}

function canReviewAsCD(user) {
  return user.role === 'creative_director' || user.role === 'super_admin';
}

async function canMarkDelivered(user, asset) {
  if (['super_admin', 'creative_director'].includes(user.role)) return true;
  if (user.role === 'admin' || user.role === 'coordinator') return canAccessProject(user, asset.project_id);
  return false;
}

// Can this user delete the asset outright?
async function canDeleteAsset(user, asset) {
  if (user.role === 'super_admin') return true;
  if (user.role === 'admin') {
    const { rows } = await pool.query('SELECT owner_id FROM projects WHERE id = $1', [asset.project_id]);
    return rows.length > 0 && rows[0].owner_id === user.id;
  }
  return false;
}

function canCreateAsset(user) {
  return ['super_admin', 'admin', 'team_lead', 'coordinator'].includes(user.role);
}
function canCreateProject(user) {
  return ['super_admin', 'admin'].includes(user.role);
}
function canManageUsers(user) {
  return ['super_admin', 'admin'].includes(user.role);
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
  canMarkDelivered,
};
