// The master list of permissions.
//
// The app's authorization has always been capability-based: a role sits in a
// tier, the tier carries capabilities, and the checks read those. That works
// well for roles and badly for individuals — the capabilities are coarse
// (`manageUsers` covers adding, editing, deleting and bulk-importing people)
// because a tier is a job description, not a checklist.
//
// This is the finer grain. Every distinct action gets a key, and a key can be
// granted to one person without moving them to another tier.
//
// Two rules hold the two systems together:
//
//   1. A role's tier still produces a BASELINE set of these keys (`impliedBy`
//      below). Nobody loses anything they had.
//   2. Individual grants are ADDITIVE. Effective = baseline ∪ grants. A grant
//      can add a permission a role does not give; it cannot take away one the
//      role does give. To remove that, change the role.
//
// And one rule about reach, which is easy to miss: a permission says what
// somebody may *do*, never *how much of the studio they may do it to*. Granting
// `asset.edit` to a Game Artist lets them edit assets — the ones their role's
// projectScope already covers, not every asset in the studio. Scope stays with
// the role. Anything else would turn a single checkbox into studio-wide access.

// Capability shorthands, so the mapping below reads as intent rather than as
// property lookups.
const has = (name) => (caps) => Boolean(caps[name]);
const reviewsAt = (stage) => (caps) => caps.reviewStage === stage;
const anyOf = (...tests) => (caps) => tests.some((t) => t(caps));
// The studio-wide tier. Mirrors hasFullAccess() in src/permissions.js, which is
// what already lets these roles step into either review gate.
const fullAccess = (caps) => Boolean(caps.manageUsers && caps.projectScope === 'all');

// A permission that no code checks yet, because the action does not exist.
// Listed so the catalog is complete and the grant is recorded, and flagged so
// the screen can say so rather than implying a toggle does something.
const PENDING = 'This action has not been built yet. The permission can be granted now and will take effect when it is.';

const GROUPS = [
  {
    key: 'users',
    label: 'User Management',
    permissions: [
      { key: 'user.view',             label: 'User View',            impliedBy: has('manageUsers') },
      { key: 'user.add',              label: 'User Add',             impliedBy: has('manageUsers') },
      { key: 'user.edit',             label: 'User Edit',            impliedBy: has('manageUsers') },
      { key: 'user.delete',           label: 'User Delete',          impliedBy: has('manageUsers') },
      { key: 'user.change_role',      label: 'Change Role',          impliedBy: has('manageUsers') },
      { key: 'user.change_project',   label: 'Change Project',       impliedBy: has('manageUsers') },
      { key: 'user.change_reporting', label: 'Change Reporting To',  impliedBy: has('manageUsers') },
      { key: 'user.reset_password',   label: 'Reset User Password',  impliedBy: has('manageUsers'), pending: PENDING },
      { key: 'user.bulk_upload',      label: 'Bulk Upload Users',    impliedBy: has('manageUsers') },
      {
        key: 'user.view_team',
        label: 'View Team Roster',
        // The My Team tab. Seeded from the capability that used to decide it,
        // plus the studio-wide tier — which already holds review.tl on the same
        // reasoning, and which "everything a Super Admin has" would otherwise
        // not include. From now on it is a switch like everything else, rather
        // than something only a change of tier can move.
        impliedBy: anyOf(has('leadsTeam'), fullAccess),
        describe: 'See the people reporting to you and how their work is going.',
      },
    ],
  },
  {
    key: 'assets',
    label: 'Asset Management',
    permissions: [
      { key: 'asset.add',             label: 'Asset Add',            impliedBy: has('createAsset') },
      { key: 'asset.edit',            label: 'Asset Edit',           impliedBy: has('editAsset') },
      { key: 'asset.delete',          label: 'Asset Delete',         impliedBy: has('deleteAsset') },
      { key: 'asset.assign',          label: 'Asset Assign/Reassign', impliedBy: has('editAsset') },
      { key: 'asset.bulk_upload',     label: 'Bulk Upload Assets',   impliedBy: has('createAsset') },
      {
        key: 'asset.override_stage',
        label: 'Override Review Stage',
        // Only the studio-wide tier holds this from a role. Moving an asset
        // outside the pipeline is not something an ordinary job description
        // should imply — below that tier it is granted to a named person or to
        // nobody.
        impliedBy: fullAccess,
        describe: 'Force a status change outside the normal review flow.',
      },
    ],
  },
  {
    key: 'review',
    label: 'Review Workflow',
    permissions: [
      { key: 'review.tl',             label: 'TL Review Actions',    impliedBy: anyOf(reviewsAt('tl'), has('leadsTeam'), fullAccess) },
      { key: 'review.cd',             label: 'CD Review Actions',    impliedBy: reviewsAt('cd') },
      {
        key: 'review.approve_client',
        label: 'Approve for Client',
        // Narrower than review.cd on purpose: sending work back is the
        // reversible half of the gate, signing it off for the client is not.
        // A role can hold the review and not the sign-off.
        impliedBy: reviewsAt('cd'),
        describe: 'Sign work off as ready for the client. Requires CD Review Actions as well.',
      },
      { key: 'review.deliver',        label: 'Mark as Delivered',    impliedBy: has('deliver') },
    ],
  },
  {
    key: 'projects',
    label: 'Project Management',
    permissions: [
      { key: 'project.add',           label: 'Project Add',          impliedBy: has('createProject') },
      { key: 'project.edit',          label: 'Project Edit',         impliedBy: has('createProject') },
      {
        key: 'project.delete',
        label: 'Project Delete',
        impliedBy: has('createProject'),
        describe: 'Archive a project, or delete one outright once it holds nothing.',
      },
      {
        key: 'project.close',
        label: 'Close / Reopen Project',
        impliedBy: has('createProject'),
        describe: 'Close a project so it takes no new assets and its existing ones are read-only, and reopen it.',
      },
    ],
  },
  {
    key: 'clients',
    label: 'Client Management',
    permissions: [
      {
        key: 'client.view',
        label: 'Client View',
        // Open by default. The Projects tab is how everybody navigates to their
        // work, and it lists clients — a role that could not see clients could
        // not reach its own projects. The list is still scoped: you see the
        // clients whose projects your role's projectScope reaches.
        impliedBy: () => true,
        describe: 'See the client list and the projects under each one.',
      },
      { key: 'client.add',    label: 'Client Add',    impliedBy: has('createProject') },
      { key: 'client.edit',   label: 'Client Edit',   impliedBy: has('createProject') },
      {
        key: 'client.delete',
        label: 'Client Delete',
        impliedBy: has('createProject'),
        describe: 'Archive a client, or delete one outright once it holds no projects.',
        danger: 'Archiving hides a client and its projects; nothing is destroyed. Only an empty client can be deleted outright.',
      },
      {
        key: 'client.close',
        label: 'Close / Reopen Deal',
        impliedBy: has('createProject'),
        describe: 'Mark a client\'s deal closed so no new projects go under it, and reopen it.',
      },
    ],
  },
  {
    key: 'settings',
    label: 'Settings / Admin',
    permissions: [
      { key: 'settings.roles',        label: 'Manage Roles',         impliedBy: has('manageSettings') },
      { key: 'settings.asset_types',  label: 'Manage Scope of Work', impliedBy: has('manageSettings') },
      { key: 'settings.priorities',   label: 'Manage Priorities',    impliedBy: has('manageSettings') },
      { key: 'settings.categories',   label: 'Manage Categories',    impliedBy: has('manageSettings') },
      {
        key: 'settings.ip_allowlist',
        label: 'Manage IP Allowlist',
        impliedBy: has('manageAccess'),
        // Surfaced to the UI so the warning lives with the permission rather
        // than being remembered by whoever wrote the screen.
        danger: 'A wrong entry here locks everyone out of the application, and the way back is an environment variable on the server.',
      },
      { key: 'settings.audit_logs',   label: 'View Audit Logs',      impliedBy: has('manageSettings'), pending: PENDING },
      {
        key: 'settings.permissions',
        label: 'Manage Role Permissions',
        // This screen itself. Held by the Super Admin role and not switchable
        // on for any other role: whoever holds it can give their own role every
        // other permission, so enabling it anywhere else is a one-way door.
        impliedBy: has('managePermissions'),
        grantable: false,
        danger: 'Whoever holds this can give any role every other permission, including their own.',
      },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.permissions.map((p) => ({ ...p, group: g.key, groupLabel: g.label })));
const BY_KEY = new Map(ALL.map((p) => [p.key, p]));
const KEYS = ALL.map((p) => p.key);

function isPermission(key) {
  return BY_KEY.has(key);
}

// Permissions that may be switched on for a role through the screen. Excludes
// the one that controls the screen itself.
function grantableKeys() {
  return ALL.filter((p) => p.grantable !== false).map((p) => p.key);
}

// What a role's capabilities imply, before any individual grant.
function baselineFor(capabilities) {
  if (!capabilities) return new Set();
  return new Set(ALL.filter((p) => p.impliedBy(capabilities)).map((p) => p.key));
}

// Baseline plus grants. The whole of the additive rule, in one place.
function effectiveFor(capabilities, grantedKeys = []) {
  const set = baselineFor(capabilities);
  for (const key of grantedKeys) {
    if (BY_KEY.has(key)) set.add(key);
  }
  return set;
}

// The catalogue as the browser needs it: no functions, groups intact.
function describe() {
  return GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    permissions: g.permissions.map((p) => ({
      key: p.key,
      label: p.label,
      describe: p.describe || null,
      pending: p.pending || null,
      danger: p.danger || null,
      grantable: p.grantable !== false,
    })),
  }));
}

module.exports = { GROUPS, ALL, KEYS, BY_KEY, isPermission, grantableKeys, baselineFor, effectiveFor, describe };
