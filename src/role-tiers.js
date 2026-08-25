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
  // Managing who may reach the application at all — the IP allowlist, and the
  // switch between monitor and enforce. Split out from manageSettings so that
  // "full access to the studio" does not automatically mean "can lock the
  // studio out of its own app". Held by the Super Admin tier alone.
  manageAccess: false,
};

// The capabilities that make up full access. Named once and shared, so the
// tiers below cannot drift apart from each other by a line nobody noticed.
const FULL_ACCESS = {
  projectScope: 'all',
  reviewStage: 'cd',
  manageUsers: true,
  manageSettings: true,
  createProject: true,
  createAsset: true,
  editAsset: true,
  deliver: true,
  deleteAsset: 'any',
};

const TIERS = {
  // --- system tiers: one role each, not creatable or deletable -------------
  super_admin: {
    label: 'Super Admin',
    describe: 'Runs the studio. Every permission, including who may reach the app at all.',
    system: true,
    // The only tier holding manageAccess: the IP allowlist stays here even
    // though other tiers below have everything else.
    capabilities: { ...FULL_ACCESS, manageAccess: true },
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
    label: 'Leadership (full access, top of hierarchy)',
    describe: 'Every permission except managing the IP allowlist. Reports to nobody, so no Reporting To field.',
    // Deliberately still its own tier rather than folded into full_access
    // below: src/reporting.js reads this tier to mean "top of the org chart",
    // which is a fact about the position rather than about its access level.
    // Merging the two would hand a Reporting To field to the person running
    // the studio, or take it away from everyone with full access.
    capabilities: { ...FULL_ACCESS },
  },
  full_access: {
    label: 'Full Access',
    describe: 'Every permission except managing the IP allowlist. Reports to someone, unlike Leadership.',
    capabilities: { ...FULL_ACCESS },
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
  FULL_ACCESS,
  TIERS,
  TIER_KEYS,
  ASSIGNABLE_TIERS,
  CAPABILITY_DEFAULTS,
  isTier,
  capabilitiesForTier,
  describeTiers,
};
