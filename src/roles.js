// The studio's role catalogue — the single source of truth for who can do what.
//
// A role is a real job title (Senior Game Artist, Art Supervisor, ...), and its
// capabilities are attached here rather than being spelled out as `role === 'x'`
// checks scattered through the routes. Adding a new designation to the studio is
// a matter of adding one entry below; nothing else needs to change.
//
// Capabilities
//   projectScope   which projects the role can see:
//                    'all'      — the whole studio
//                    'owned'    — projects they created
//                    'assigned' — projects they're explicitly attached to
//                    'team'     — projects their reports have work in
//                    'own_work' — projects containing an asset assigned to them
//   reviewStage    which review gate they sign off: 'tl', 'cd', or null
//   assignable     assets can be assigned to them (individual contributors)
//   leadsTeam      artists report to them via users.team_lead_id
//   manageUsers    can add and remove users
//   createProject  can create and delete projects
//   createAsset    can create assets in projects they can see
//   editAsset      can edit assets (status, priority, tasks, description)
//   deliver        can mark a client-approved asset as delivered
//   deleteAsset    'any' — any asset; 'owned' — assets in projects they own; null

const ADMINISTRATION = 'Administration';
const DIRECTION = 'Creative Direction';
const SUPERVISION = 'Supervision';
const ART = 'Art';
const ANIMATION = 'Animation';
const DESIGN = 'Design';

// Defaults every role starts from; each entry below only states its differences.
const BASE = {
  projectScope: 'own_work',
  reviewStage: null,
  assignable: false,
  leadsTeam: false,
  manageUsers: false,
  createProject: false,
  createAsset: false,
  editAsset: false,
  deliver: false,
  deleteAsset: null,
};

// An individual contributor: work is assigned to them, they submit it for review.
function contributor(label, group, rank, color) {
  return { label, group, rank, color, projectScope: 'own_work', assignable: true, editAsset: true };
}

// A lead or supervisor: runs a team of contributors and holds the first review gate.
function lead(label, group, rank, color) {
  return {
    label, group, rank, color,
    projectScope: 'team',
    reviewStage: 'tl',
    leadsTeam: true,
    createAsset: true,
    editAsset: true,
  };
}

const DEFINITIONS = {
  // ---- Administration -----------------------------------------------------
  super_admin: {
    label: 'Super Admin', group: ADMINISTRATION, rank: 100, color: '#ff3b5c',
    projectScope: 'all',
    reviewStage: 'cd', // override, so a stalled review can always be unblocked
    manageUsers: true,
    createProject: true,
    createAsset: true,
    editAsset: true,
    deliver: true,
    deleteAsset: 'any',
  },
  admin: {
    label: 'Admin', group: ADMINISTRATION, rank: 90, color: '#5b8cff',
    projectScope: 'owned',
    manageUsers: true,
    createProject: true,
    createAsset: true,
    editAsset: true,
    deliver: true,
    deleteAsset: 'owned',
  },
  coordinator: {
    label: 'Production Coordinator', group: ADMINISTRATION, rank: 60, color: '#39d98a',
    projectScope: 'assigned',
    createAsset: true,
    editAsset: true,
    deliver: true,
  },

  // ---- Creative direction -------------------------------------------------
  // Signs off the final gate for the whole studio. Deliberately cannot edit
  // assets directly — direction is given through the review action, so every
  // decision lands in the asset's feedback history.
  art_director: {
    label: 'Art Director', group: DIRECTION, rank: 85, color: '#d4ff3d',
    projectScope: 'all',
    reviewStage: 'cd',
    deliver: true,
  },

  // ---- Supervision and leads ---------------------------------------------
  art_supervisor: lead('Art Supervisor', SUPERVISION, 75, '#ffa63d'),
  associate_animation_supervisor: lead('Associate Animation Supervisor', SUPERVISION, 70, '#ffa63d'),
  senior_team_lead: lead('Senior Team Lead', SUPERVISION, 72, '#ff8a3d'),
  team_lead: lead('Team Lead', SUPERVISION, 68, '#ff8a3d'),
  associate_team_lead: lead('Associate Team Lead', SUPERVISION, 65, '#ff8a3d'),

  // ---- Art ----------------------------------------------------------------
  senior_game_artist: contributor('Senior Game Artist', ART, 50, '#4db8ff'),
  game_artist: contributor('Game Artist', ART, 40, '#4db8ff'),
  associate_game_artist: contributor('Associate Game Artist', ART, 30, '#4db8ff'),
  trainee_game_artist: contributor('Trainee Game Artist', ART, 10, '#4db8ff'),
  senior_motion_graphics_artist: contributor('Senior Motion Graphics Artist', ART, 50, '#4db8ff'),

  // ---- Animation ----------------------------------------------------------
  senior_game_animator: contributor('Senior Game Animator', ANIMATION, 50, '#b98cff'),
  game_animator: contributor('Game Animator', ANIMATION, 40, '#b98cff'),
  associate_game_animator: contributor('Associate Game Animator', ANIMATION, 30, '#b98cff'),
  trainee_game_animator: contributor('Trainee Game Animator', ANIMATION, 10, '#b98cff'),

  // ---- Design -------------------------------------------------------------
  game_designer: contributor('Game Designer', DESIGN, 45, '#ff7ac2'),
  senior_ui_ux_designer: contributor('Senior UI/UX Designer', DESIGN, 50, '#ff7ac2'),
  associate_ui_ux_designer: contributor('Associate - UI/UX Designer', DESIGN, 30, '#ff7ac2'),
};

// Fill in the defaults so every consumer can read every capability without
// worrying about which ones a given entry happened to spell out.
const ROLES = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([key, def]) => [key, { key, ...BASE, ...def }])
);

const ROLE_KEYS = Object.keys(ROLES);

// Roles that can be assigned work — used wherever the code used to say `role = 'artist'`.
const ASSIGNABLE_ROLES = ROLE_KEYS.filter((r) => ROLES[r].assignable);

// Roles that run a team — used wherever the code used to say `role = 'team_lead'`.
const LEAD_ROLES = ROLE_KEYS.filter((r) => ROLES[r].leadsTeam);

const GROUP_ORDER = [ADMINISTRATION, DIRECTION, SUPERVISION, ART, ANIMATION, DESIGN];

function isRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

function roleDef(role) {
  return ROLES[role] || null;
}

function can(user, capability) {
  const def = user && roleDef(user.role);
  return def ? Boolean(def[capability]) : false;
}

// The capability bundle sent to the browser, so the frontend shows exactly the
// controls the API would actually allow rather than keeping its own rule list.
function capabilitiesFor(role) {
  const def = roleDef(role);
  if (!def) return null;
  return {
    label: def.label,
    group: def.group,
    color: def.color,
    projectScope: def.projectScope,
    reviewStage: def.reviewStage,
    assignable: def.assignable,
    leadsTeam: def.leadsTeam,
    manageUsers: def.manageUsers,
    createProject: def.createProject,
    createAsset: def.createAsset,
    editAsset: def.editAsset,
    deliver: def.deliver,
    deleteAsset: def.deleteAsset,
  };
}

// The catalogue the browser uses to build role dropdowns and badges.
function catalogue() {
  return ROLE_KEYS
    .map((key) => ({ key, ...capabilitiesFor(key), rank: ROLES[key].rank }))
    .sort((a, b) => {
      const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
      if (g !== 0) return g;
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.label.localeCompare(b.label);
    });
}

module.exports = {
  ROLES,
  ROLE_KEYS,
  ASSIGNABLE_ROLES,
  LEAD_ROLES,
  GROUP_ORDER,
  isRole,
  roleDef,
  can,
  capabilitiesFor,
  catalogue,
};
