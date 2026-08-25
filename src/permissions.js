const db = require('./db');
const { roleDef, assignableRoles, leadRoles } = require('./roles');

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

  // The three narrower scopes below each add "…or you created it".
  //
  // Without that, granting project.add to a role whose scope is narrower than
  // the whole studio produced a project its creator could not see: these
  // queries match on being a coordinator, a lead, or having work in it, and
  // creating a project makes you none of those — it makes you its owner. The
  // reach rule for editing and deleting one is already "yours, or anyone's if
  // your scope is studio-wide", so this makes seeing agree with doing.
  if (def.projectScope === 'assigned') {
    const { rows } = await db.query(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_coordinators pc ON pc.project_id = p.id AND pc.user_id = $1
       LEFT JOIN project_team_leads  ptl ON ptl.project_id = p.id AND ptl.user_id = $1
       WHERE pc.user_id IS NOT NULL OR ptl.user_id IS NOT NULL OR p.owner_id = $1
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
       WHERE ptl.user_id IS NOT NULL OR r.id IS NOT NULL OR p.owner_id = $1
       ORDER BY p.created_at`,
      [user.id]
    );
    return rows;
  }

  // 'own_work': the projects they have work in, and the one they are attached
  // to.
  //
  // The second half was missing. Contributor membership (project_members)
  // arrived with the Edit User screen's Project field, and this query still
  // only looked at assets — so assigning somebody to a project did nothing for
  // them until work landed in it. That made a granted permission behave
  // unpredictably: `asset.add` worked or did not depending on whether they
  // happened to hold an asset there already.
  const { rows } = await db.query(
    `SELECT DISTINCT p.* FROM projects p
     LEFT JOIN assets a ON a.project_id = p.id AND a.assignee_id = $1
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
     WHERE a.id IS NOT NULL OR pm.user_id IS NOT NULL OR p.owner_id = $1
     ORDER BY p.created_at`,
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

// Does this person hold a catalogue permission — from their role's tier, or
// granted to them individually?
//
// The set is computed once per request in authenticate() and hung off the user,
// so these predicates stay synchronous where they already were.
//
// The division of labour matters and is easy to get wrong: a permission says
// what somebody may DO. It never says how much of the studio they may do it to.
// Reach stays with the role's projectScope, which is why every check below is
// "holds the permission AND the role's scope reaches this row" rather than one
// or the other.
function holds(user, key) {
  return Boolean(user && Array.isArray(user.permissions) && user.permissions.includes(key));
}

// Whose asset is this?
//
// "Asset Edit" granted to a role means "edit the assets you added", not "edit
// every asset in the studio" — so holding the permission is necessary and not
// sufficient. Three ways to be the right person, and only three:
//
//   1. A full-access role. Studio-wide reach is what that tier is, and somebody
//      has to be able to fix an asset whose creator has left. This is the one
//      exception to the ownership rule.
//   2. You added it. The rule proper.
//   3. It is assigned to you. Not an ownership claim — it is the artist's own
//      work sitting on their own desk, and it is how a contributor ticks a task
//      or updates a description on the thing they are being asked to make.
//      Contributors never add assets, so without this clause the ownership rule
//      would take the checklist away from every artist in the studio. It grants
//      nothing wider: an assignee reaches exactly the one asset they hold.
//
// created_by is NULL for assets that predate the column and could not be
// attributed (see ensureAssetOwnership in src/migrate.js). Those are unowned:
// clause 2 can never match, so they fall to a full-access role or the assignee.
function ownsAsset(user, asset) {
  if (!user || !asset) return false;
  if (hasFullAccess(user)) return true;
  if (asset.created_by && asset.created_by === user.id) return true;
  return Boolean(asset.assignee_id) && asset.assignee_id === user.id;
}

// Can this user edit status/priority/description/tasks on this asset?
// The art director is deliberately excluded: direction is given through the
// review action so that every decision is recorded as feedback on the asset.
async function canEditAsset(user, asset) {
  if (!holds(user, 'asset.edit')) return false;
  if (!ownsAsset(user, asset)) return false;
  return canViewAsset(user, asset);
}

// Can this user change who an asset is assigned to?
//
// Its own permission, and the same ownership question — with one clause of
// ownsAsset removed. Being the assignee is not a licence to hand your work to
// somebody else; that is the creator's call, or a full-access role's.
function canAssignAsset(user, asset) {
  if (!holds(user, 'asset.assign')) return false;
  if (hasFullAccess(user)) return true;
  return Boolean(asset && asset.created_by) && asset.created_by === user.id;
}

// The two states where an asset is waiting for rework. The creator may hand
// that rework to somebody else rather than let it go back to whoever submitted
// it — which is the whole point of the Reassign action.
const REWORK_STATUSES = ['tl_changes_requested', 'cd_changes_requested'];

function isAwaitingRework(asset) {
  return Boolean(asset) && REWORK_STATUSES.includes(asset.status);
}

// Is this user a contributor the asset is actually assigned to?
function isAssignedArtist(user, asset) {
  const def = roleDef(user.role);
  return Boolean(def && def.assignable && asset.assignee_id === user.id);
}

// Is this user the lead or supervisor of the contributor this asset is assigned to?
async function isTeamLeadOfAsset(user, asset) {
  if (!holds(user, 'review.tl') || !asset.assignee_id) return false;
  const def = roleDef(user.role);
  // Someone granted TL review actions without leading a team reviews the work
  // they can already see, rather than nobody's.
  if (!def || !def.leadsTeam) return canViewAsset(user, asset);
  return isReport(user, asset.assignee_id);
}

// Full access: the studio-wide tier.
//
// The codebase spelled this out as `manageUsers && projectScope === 'all'` in
// three places, which meant "Super Admin" by coincidence rather than by
// statement — and adding roles at that level would have quietly changed what
// each of those lines meant. Named once here instead.
//
// It deliberately does not include manageAccess: the IP allowlist is Super
// Admin's alone, and a role can have every other permission without it.
function hasFullAccess(user) {
  const def = roleDef(user && user.role);
  return Boolean(def && def.manageUsers && def.projectScope === 'all');
}

// May `actor` administer `target`'s account — view it in the roster, edit it,
// remove it?
//
// This replaces `projectScope !== 'all' && target.manager_id !== actor.id`,
// which was three copies of the same mistake in src/routes/users.js. Two things
// were wrong with it. It answered a question about PEOPLE with projectScope, a
// value about PROJECTS — a role trusted to run the studio's staff list has no
// particular relationship to how many projects it sees. And its fallback,
// "only accounts you personally created", is not a scope at all: it is an
// accident of who happened to click Add User. Between them they made the whole
// User Management group inert — a role granted every permission in it could add
// people and then administer nobody but the people it had just added, and its
// user list came back empty.
//
// What replaces it is the permission plus one guard: an account with full
// studio access can only be administered by another one. Otherwise a role
// granted user.edit could rename, reassign or demote a Super Admin, and the way
// back would be through the account it had just changed. Handing out roles is
// separately limited by assignableRolesFor(), so this cannot be used to climb.
function mayAdministerUser(actor, target) {
  if (!actor || !target) return false;
  if (hasFullAccess(actor)) return true;
  return !hasFullAccess(target);
}

// Holds the final review gate (art director, with super admin as an override).
function canReviewAsCD(user) {
  return holds(user, 'review.cd');
}

// May step into a review gate that isn't theirs, to unblock work when the
// assigned lead is unavailable. Deliberately narrow: a studio-wide role that
// also administers accounts, i.e. the super admin.
function canOverrideReview(user) {
  return hasFullAccess(user);
}

async function canMarkDelivered(user, asset) {
  if (!holds(user, 'review.deliver')) return false;
  const def = roleDef(user.role);
  if (def && def.projectScope === 'all') return true;
  return canAccessProject(user, asset.project_id);
}

// Can this user delete the asset outright?
async function canDeleteAsset(user, asset) {
  if (!holds(user, 'asset.delete')) return false;
  const def = roleDef(user.role);
  // Reach is still the role's: 'any' deletes studio-wide, 'owned' only in
  // projects they own. A grant unlocks the action, not the range.
  if (!def) return false;
  if (def.deleteAsset === 'any') return true;
  if (!def.deleteAsset) return canAccessProject(user, asset.project_id);
  const { rows } = await db.query('SELECT owner_id FROM projects WHERE id = $1', [asset.project_id]);
  return rows.length > 0 && rows[0].owner_id === user.id;
}

function canCreateAsset(user) {
  return holds(user, 'asset.add');
}

// May this person move an asset outside the normal review flow?
function canOverrideStage(user) {
  return holds(user, 'asset.override_stage');
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
  holds,
  canOverrideStage,
  hasFullAccess,
  mayAdministerUser,
  ownsAsset,
  canAssignAsset,
  isAwaitingRework,
  REWORK_STATUSES,
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
  // Re-exported as functions rather than arrays: roles are managed in Settings
  // now, so a value captured at import time would go stale the moment one
  // is added.
  assignableRoles,
  leadRoles,
};
