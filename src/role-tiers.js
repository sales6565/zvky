// What a role can do, expressed as a small set of tiers.
//
// A role is not just a label here: the permission checks read a capability set
// off it. That set has to come from somewhere when a Super Admin adds a role
// through the Settings screen, and asking them to reason about ten independent
// toggles invites an accidental studio-wide administrator.
//
// So a role picks a tier, and the tier carries the capabilities. These are the
// same shapes the contributor() / lead() / productionRole() / staffRole() /
// observer() helpers produced when the catalogue lived in code, so every
// existing role maps onto exactly one of them without changing what it can do.

const CAPABILITY_DEFAULTS = {
  projectScope: 'own_work',
  reviewStage: null,
  assignable: false,
  leadsTeam: false,
  manageUsers: false,
  manageSettings: false,
  createProject: false,
  createAsset: false,
  editAsset: false,
  deliver: false,
  deleteAsset: null,
};

const TIERS = {
  // --- system tiers: one role each, not creatable or deletable -------------
  super_admin: {
    label: 'Super Admin',
    describe: 'Runs the studio. Every permission, including these settings.',
    system: true,
    capabilities: {
      projectScope: 'all',
      reviewStage: 'cd',
      manageUsers: true,
      manageSettings: true,
      createProject: true,
      createAsset: true,
      editAsset: true,
      deliver: true,
      deleteAsset: 'any',
    },
  },
  admin: {
    label: 'Admin',
    describe: 'Creates projects and staffs them. Sees only their own projects and the users they added.',
    system: true,
    capabilities: {
      projectScope: 'owned',
      manageUsers: true,
      createProject: true,
      createAsset: true,
      editAsset: true,
      deliver: true,
      deleteAsset: 'owned',
    },
  },

  // --- tiers a new role may be created in -----------------------------------
  leadership: {
    label: 'Leadership',
    describe: 'Sees every project. Takes no action in the pipeline.',
    capabilities: { projectScope: 'all' },
  },
  direction: {
    label: 'Creative Direction',
    describe: 'Sees every project and holds the final review gate. Cannot edit assets directly, so direction is recorded as feedback.',
    capabilities: { projectScope: 'all', reviewStage: 'cd', deliver: true },
  },
  lead: {
    label: 'Lead / Supervisor',
    describe: 'Runs a team, holds the first review gate, creates and edits assets.',
    capabilities: {
      projectScope: 'team',
      reviewStage: 'tl',
      leadsTeam: true,
      createAsset: true,
      editAsset: true,
    },
  },
  production: {
    label: 'Production',
    describe: 'Works across the projects they are attached to; creates and edits assets and signs off delivery.',
    capabilities: {
      projectScope: 'assigned',
      createAsset: true,
      editAsset: true,
      deliver: true,
    },
  },
  contributor: {
    label: 'Contributor',
    describe: 'Assigned work and submits it for review. Artists, animators, designers, engineers.',
    capabilities: { projectScope: 'own_work', assignable: true, editAsset: true },
  },
  staff: {
    label: 'Staff (no pipeline access)',
    describe: 'In the studio directory with the asset pipeline closed. Finance, HR, business.',
    capabilities: { projectScope: 'own_work' },
  },
};

const TIER_KEYS = Object.keys(TIERS);
// Tiers a Super Admin may choose when adding a role. The system tiers are
// excluded: there is one Super Admin role and one Admin role, and minting more
// of either from a settings screen is not something to make easy.
const ASSIGNABLE_TIERS = TIER_KEYS.filter((key) => !TIERS[key].system);

function isTier(tier) {
  return Object.prototype.hasOwnProperty.call(TIERS, tier);
}

// The full capability set for a tier, defaults filled in.
function capabilitiesForTier(tier) {
  const def = TIERS[tier];
  if (!def) return null;
  return { ...CAPABILITY_DEFAULTS, ...def.capabilities };
}

// For the Settings screen: what each tier is, without the internals.
function describeTiers({ includeSystem = false } = {}) {
  return TIER_KEYS
    .filter((key) => includeSystem || !TIERS[key].system)
    .map((key) => ({
      key,
      label: TIERS[key].label,
      describe: TIERS[key].describe,
      system: Boolean(TIERS[key].system),
      capabilities: capabilitiesForTier(key),
    }));
}

module.exports = {
  TIERS,
  TIER_KEYS,
  ASSIGNABLE_TIERS,
  CAPABILITY_DEFAULTS,
  isTier,
  capabilitiesForTier,
  describeTiers,
};
