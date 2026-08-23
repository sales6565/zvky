// The studio's role catalogue.
//
// Roles used to be defined here as a literal object. They now live in the
// `roles` table so a Super Admin can add and rename them in Settings without a
// deploy, and this module is the read side of that: the same lookups the
// permission checks have always used, answered from the in-memory mirror in
// src/reference-data.js.
//
// The permission checks run inside functions that are not async and are called
// on every request, so they cannot wait on a query. The mirror is loaded at
// startup and reloaded whenever a value is written.
//
// A role carries a tier, and the tier carries its capabilities — see
// src/role-tiers.js. That is what makes a role addable through a form: naming
// it and choosing what it can do is the whole decision.

const referenceData = require('./reference-data');
const { TIERS, capabilitiesForTier, describeTiers, isTier } = require('./role-tiers');
const defaults = require('./reference-defaults');

// Before the mirror is loaded — during a migration, or in a unit test with no
// database — fall back to the values a new studio starts with, so nothing has
// to guard against an empty catalogue.
function entries({ includeInactive = true } = {}) {
  if (referenceData.isLoaded()) return referenceData.list('roles', { includeInactive });
  return defaults.ROLES.map((role) => ({
    ...role,
    isActive: true,
    isSystem: Boolean(role.isSystem),
    rank: role.position,
    tierLabel: (TIERS[role.tier] || {}).label || role.tier,
    ...capabilitiesForTier(role.tier),
  }));
}

function roleDef(role) {
  return entries().find((r) => r.key === role) || null;
}

function isRole(role) {
  return Boolean(roleDef(role));
}

// Roles a person may be given. A deactivated role stays resolvable — everyone
// already holding it keeps working — but is not offered for new assignments.
function activeRoles() {
  return entries({ includeInactive: false });
}

function roleKeys(options) {
  return entries(options).map((r) => r.key);
}

// Roles that can be assigned work: wherever the code used to say role = 'artist'.
function assignableRoles() {
  return entries().filter((r) => r.assignable).map((r) => r.key);
}

// Roles that run a team: wherever the code used to say role = 'team_lead'.
function leadRoles() {
  return entries().filter((r) => r.leadsTeam).map((r) => r.key);
}

function can(user, capability) {
  const def = user && roleDef(user.role);
  return def ? Boolean(def[capability]) : false;
}

// The capability bundle sent to the browser, so the frontend shows exactly the
// controls the API would allow rather than keeping its own rule list.
function capabilitiesFor(role) {
  const def = roleDef(role);
  if (!def) return null;
  return {
    label: def.label,
    group: def.group,
    color: def.color,
    tier: def.tier,
    projectScope: def.projectScope,
    reviewStage: def.reviewStage,
    assignable: def.assignable,
    leadsTeam: def.leadsTeam,
    manageUsers: def.manageUsers,
    manageSettings: def.manageSettings,
    createProject: def.createProject,
    createAsset: def.createAsset,
    editAsset: def.editAsset,
    deliver: def.deliver,
    deleteAsset: def.deleteAsset,
  };
}

// Groups, in the order the picker shows them. Known groups lead so the
// headings stay familiar; anything a Super Admin invents follows, alphabetically.
const KNOWN_GROUP_ORDER = [
  'Administration', 'Leadership', 'Creative Direction', 'Supervision', 'Production',
  'Art', 'Animation', 'Design', 'Engineering', 'Game Math', 'Business & Operations', 'People & Culture',
];

function groupOrder() {
  const present = [...new Set(entries().map((r) => r.group))];
  const known = KNOWN_GROUP_ORDER.filter((g) => present.includes(g));
  const extra = present.filter((g) => !KNOWN_GROUP_ORDER.includes(g)).sort();
  return [...known, ...extra];
}

// The catalogue the browser uses to build role pickers and badges.
function catalogue({ includeInactive = false } = {}) {
  const order = groupOrder();
  return entries({ includeInactive })
    .map((role) => ({ ...capabilitiesFor(role.key), key: role.key, rank: role.rank, isActive: role.isActive, isSystem: role.isSystem }))
    .sort((a, b) => {
      const g = order.indexOf(a.group) - order.indexOf(b.group);
      if (g !== 0) return g;
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.label.localeCompare(b.label);
    });
}

module.exports = {
  roleDef,
  isRole,
  can,
  capabilitiesFor,
  catalogue,
  entries,
  activeRoles,
  roleKeys,
  assignableRoles,
  leadRoles,
  groupOrder,
  describeTiers,
  isTier,
  TIERS,
  KNOWN_GROUP_ORDER,
};
