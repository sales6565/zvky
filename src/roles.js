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
const LEADERSHIP = 'Leadership';
const DIRECTION = 'Creative Direction';
const SUPERVISION = 'Supervision';
const PRODUCTION = 'Production';
const ART = 'Art';
const ANIMATION = 'Animation';
const DESIGN = 'Design';
const ENGINEERING = 'Engineering';
const GAME_MATH = 'Game Math';
const BUSINESS = 'Business & Operations';
const PEOPLE = 'People & Culture';

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

// Studio-wide visibility with no hand in the pipeline: leadership who need to
// see everything and change nothing. Deliberately the narrowest thing that is
// still useful — widen an individual entry if someone needs more.
function observer(label, group, rank, color) {
  return { label, group, rank, color, projectScope: 'all' };
}

// Production management: works across the projects they are attached to, creates
// and edits assets, and signs off delivery. The same shape as the existing
// Production Coordinator, which is what these roles are senior variants of.
function productionRole(label, group, rank, color) {
  return {
    label, group, rank, color,
    projectScope: 'assigned',
    createAsset: true,
    editAsset: true,
    deliver: true,
  };
}

// Recorded in the studio directory but not working on assets: finance, HR,
// business development. They can sign in and see their own profile; the asset
// pipeline stays closed, which is the correct default for a role that has no
// reason to read client work.
function staffRole(label, group, rank, color) {
  return { label, group, rank, color, projectScope: 'own_work' };
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
  // Same authority as the Art Director: the final review gate, studio-wide.
  creative_art_director: {
    label: 'Creative Art Director', group: DIRECTION, rank: 86, color: '#d4ff3d',
    projectScope: 'all',
    reviewStage: 'cd',
    deliver: true,
  },
  // Deliberately one tier below: runs a team and holds the first review gate
  // rather than the final one, which stays with the directors above.
  associate_art_director: lead('Associate Art Director', DIRECTION, 78, '#d4ff3d'),

  // ---- Supervision and leads ---------------------------------------------
  art_supervisor: lead('Art Supervisor', SUPERVISION, 75, '#ffa63d'),
  associate_animation_supervisor: lead('Associate Animation Supervisor', SUPERVISION, 70, '#ffa63d'),
  senior_team_lead: lead('Senior Team Lead', SUPERVISION, 72, '#ff8a3d'),
  team_lead: lead('Team Lead', SUPERVISION, 68, '#ff8a3d'),
  associate_team_lead: lead('Associate Team Lead', SUPERVISION, 65, '#ff8a3d'),
  technical_manager: lead('Technical Manager', SUPERVISION, 74, '#ffa63d'),

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
  associate_game_designer: contributor('Associate Game Designer', DESIGN, 30, '#ff7ac2'),
  // "Lead" here is a level of design seniority, not a reporting line: modelled
  // as a contributor because a consultant has no direct reports. Change to
  // lead() if they do.
  consultant_lead_game_designer: contributor('Consultant - Lead Game Designer', DESIGN, 55, '#ff7ac2'),

  // ---- Leadership ---------------------------------------------------------
  // Studio-wide read access only. Raise an entry here if one of these people
  // needs to review, deliver or administer accounts.
  managing_director_ceo: observer('Managing Director & CEO', LEADERSHIP, 99, '#ffd23d'),
  vice_president_global_operations_business_development:
    observer('Vice President - Global Operations & Business Development', LEADERSHIP, 95, '#ffd23d'),

  // ---- Production ---------------------------------------------------------
  senior_producer: productionRole('Senior Producer', PRODUCTION, 72, '#39d98a'),
  producer: productionRole('Producer', PRODUCTION, 68, '#39d98a'),
  creative_producer: productionRole('Creative Producer', PRODUCTION, 68, '#39d98a'),
  senior_project_manager: productionRole('Senior Project Manager', PRODUCTION, 70, '#39d98a'),
  project_manager: productionRole('Project Manager', PRODUCTION, 64, '#39d98a'),
  associate_project_manager: productionRole('Associate Project Manager', PRODUCTION, 55, '#39d98a'),
  senior_production_coordinator: productionRole('Senior Production Coordinator', PRODUCTION, 62, '#39d98a'),

  // ---- Engineering --------------------------------------------------------
  senior_technical_artist: contributor('Senior Technical Artist', ENGINEERING, 50, '#4dd8d8'),
  technical_artist: contributor('Technical Artist', ENGINEERING, 40, '#4dd8d8'),
  associate_technical_artist: contributor('Associate Technical Artist', ENGINEERING, 30, '#4dd8d8'),
  senior_unity_developer: contributor('Senior Unity Developer', ENGINEERING, 50, '#4dd8d8'),
  unity_developer: contributor('Unity Developer', ENGINEERING, 40, '#4dd8d8'),
  associate_unity_developer: contributor('Associate Unity Developer', ENGINEERING, 30, '#4dd8d8'),
  game_developer: contributor('Game Developer', ENGINEERING, 40, '#4dd8d8'),
  associate_game_developer: contributor('Associate Game Developer', ENGINEERING, 30, '#4dd8d8'),
  test_engineer: contributor('Test Engineer', ENGINEERING, 40, '#4dd8d8'),
  associate_test_engineer: contributor('Associate Test Engineer', ENGINEERING, 30, '#4dd8d8'),
  trainee_test_engineer: contributor('Trainee - Test Engineer', ENGINEERING, 10, '#4dd8d8'),

  // ---- Game math ----------------------------------------------------------
  game_mathematician: contributor('Game Mathematician', GAME_MATH, 45, '#9be34f'),
  associate_game_mathematician: contributor('Associate Game Mathematician', GAME_MATH, 30, '#9be34f'),
  associate_math_analyst: contributor('Associate Math Analyst', GAME_MATH, 30, '#9be34f'),

  // ---- Business and operations -------------------------------------------
  senior_business_development_executive:
    staffRole('Senior Business Development Executive', BUSINESS, 60, '#8fa3c7'),
  senior_operations_financial_analyst:
    staffRole('Senior Operations Financial Analyst', BUSINESS, 55, '#8fa3c7'),
  account_manager_marketing: staffRole('Account Manager - Marketing', BUSINESS, 50, '#8fa3c7'),
  mis_analyst: staffRole('MIS Analyst', BUSINESS, 45, '#8fa3c7'),
  junior_accountant: staffRole('Junior Accountant', BUSINESS, 25, '#8fa3c7'),

  // ---- People and culture -------------------------------------------------
  people_culture_partner: staffRole('People & Culture Partner', PEOPLE, 60, '#d49fb8'),
  assistant_manager_hr_generalist: staffRole('Assistant Manager - HR Generalist', PEOPLE, 55, '#d49fb8'),
  talent_acquisition_specialist: staffRole('Talent Acquisition Specialist', PEOPLE, 45, '#d49fb8'),
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

const GROUP_ORDER = [
  ADMINISTRATION, LEADERSHIP, DIRECTION, SUPERVISION, PRODUCTION,
  ART, ANIMATION, DESIGN, ENGINEERING, GAME_MATH, BUSINESS, PEOPLE,
];

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
