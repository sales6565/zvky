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
      {
        key: 'user.idle_view',
        label: 'View Idle Users',
        /* Independent of User View, both ways. Seeing the staff list is an
           administrative need; seeing who is not working right now is a
           supervisory one, and a studio may hand out either without the other.
           A lead who should notice a stalled queue does not thereby need to
           read everyone's email address and reporting line. */
        impliedBy: fullAccess,
        describe: 'The "Idle Now" list: who has no timer running, and what is waiting on them.',
      },
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
      {
        key: 'asset.assign_any',
        label: 'Assign Work to Anyone',
        /* Independent of the one above, not a stronger version of it.
           
           asset.assign is ownership-bound: it lets somebody put a person on an
           asset THEY added. This one drops that condition — any asset, whoever
           created it, in any status where assignment makes sense. A role can
           hold either, both or neither, and the two are checked separately.
           
           What it does NOT drop is project scope. A permission says what
           somebody may do, never how much of the studio they may do it to, so
           this still reaches only the projects the role already reaches.
           
           Only the studio-wide tier by default: deciding who works on anything
           is a coordinator's job, not something an ordinary job description
           should imply. Granted in Settings to the roles that do it. */
        impliedBy: fullAccess,
        describe: 'Assign or reassign any asset in reach to anyone on its project, without having created it.',
      },
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
      {
        key: 'review.tl_send_client',
        label: 'TL Send to Client',
        /* Skipping a gate, not passing one — which is why it is its own key
           rather than part of TL Review Actions.
         *
         * A lead with review.tl can approve work onward and send it back. This
         * permission lets them take the Creative Director out of the loop
         * entirely, and that is a different kind of decision: the CD never sees
         * the work, and Approved for Client is one step from Delivered. So it
         * defaults to the full-access tier only, and a studio that wants its
         * senior leads to have it grants it to them deliberately.
         *
         * Distinct from review.approve_client, which is the sign-off at the CD
         * gate for somebody standing in it. This one is the authority to walk
         * around that gate. A role can hold either without the other. */
        impliedBy: fullAccess,
        describe: 'Send work in TL Review straight to Approved for Client, skipping CD Review. '
          + 'Requires TL Review Actions as well.',
      },
      { key: 'review.deliver',        label: 'Mark as Delivered',    impliedBy: has('deliver') },

      /* --- the client's own round -----------------------------------------
       *
       * Four permissions rather than one, because the studio asked for them
       * separately and they really are four decisions: who may see work that is
       * out with a client, who may put it there, who may accept the client's
       * yes, and who may pass their no back in.
       *
       * All four default to the Super Admin tier alone — has('manageAccess') is
       * held by no other tier — so nobody gains an action by upgrading. The
       * studio grants them per role in Settings, which is how it asked to
       * decide who counts as its production department rather than having a
       * role list guessed here and baked in.
       *
       * Note what that means on the day this ships: until they are granted, the
       * only route out of Approved for Client is the existing Mark as Delivered,
       * which is untouched. Nothing is stuck and nothing changes by surprise. */
      {
        key: 'review.client_view',
        label: 'View Awaiting Client Feedback',
        impliedBy: has('manageAccess'),
        describe: 'See assets that are out with the client. Without it they are hidden from the '
          + 'board and the Assets List, the way work in a review stage already is.',
      },
      {
        key: 'review.client_send',
        label: 'Send Asset to Client',
        impliedBy: has('manageAccess'),
        describe: 'Move an asset from Approved for Client to Awaiting Client Feedback — the act of '
          + 'putting it in front of the client.',
      },
      {
        key: 'review.client_deliver',
        label: 'Mark Delivered from Client Feedback',
        impliedBy: has('manageAccess'),
        describe: 'The client approved it: close it off as Delivered. Separate from Mark as '
          + 'Delivered, which is the direct route from Approved for Client.',
      },
      {
        key: 'review.client_return',
        label: 'Send Back to TL Feedbacks from Client Feedback',
        impliedBy: has('manageAccess'),
        describe: 'The client asked for changes: pass them to the team lead, who hands the rework '
          + 'on as they already do from TL Feedbacks.',
      },
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

      /* --- a whole project put in front of the Creative Director -----------
       *
       * Separate from everything in the Review Workflow group above, which is
       * about one asset moving through the pipeline. This is a link concerning
       * the project — a deck, a milestone build, a cut — with no asset, no
       * assignee and no place in the state machine.
       *
       * Two permissions, because asking and answering are different jobs.
       * Sending defaults to the Super Admin tier alone, which is where the
       * studio has asked new permissions to start; reviewing additionally
       * starts on Creative Art Director, because that is the queue's whole
       * purpose and a queue nobody can open is not a feature. Both are granted
       * per role in Settings like everything else here. */
      {
        key: 'project.review_send',
        label: 'Send Project to CD Review',
        impliedBy: has('manageAccess'),
        describe: 'Submit a link for a whole project — a deck, a build, a cut — to the Creative '
          + 'Director. Nothing to do with an asset\'s own CD Review stage.',
      },
      {
        key: 'project.review_queue',
        label: 'Review Project Submissions',
        impliedBy: has('manageAccess'),
        describe: 'See the projects submitted for review and mark them reviewed. Held by Creative '
          + 'Art Director out of the box; grant it to anybody else who should watch that queue.',
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
    key: 'reports',
    label: 'Reports',
    permissions: [
      {
        key: 'report.view',
        label: 'View Reports',
        /* The studio-wide tier by default, and grantable to anyone else in
           Settings. Reports read across every project a person can see, and
           they compare a person's tracked hours against an estimate — which is
           the kind of thing a role should be given deliberately rather than
           inherit from being able to edit an asset. */
        impliedBy: fullAccess,
        describe: 'Work-efficiency reports: estimated Man Hours against tracked Time Spent.',
      },
      {
        key: 'report.idle',
        label: 'View Idle Report',
        /* Deliberately NOT implied by report.view, and report.view is not
           implied by this.
           
           They answer different questions about different people. Efficiency
           asks whether the work took as long as it was estimated to; idle asks
           how much of somebody's week is unaccounted for. The second is a
           question about a person rather than about a job, so a studio may well
           want a producer who can read efficiency without being handed a list
           of who looks underworked — or a department head who should see
           capacity and has no business reading estimates. Holding both is a
           choice made in Settings, not a consequence of holding one. */
        impliedBy: fullAccess,
        describe: 'Idle Report: standard working hours against hours actually tracked, per person.',
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
        key: 'settings.branding',
        label: 'Manage Branding',
        // The application's own name, tagline and logo. Everyone sees the
        // result on every screen, so it is a Settings permission rather than
        // something any role that can edit an asset picks up.
        impliedBy: has('manageSettings'),
        describe: 'The name, tagline and logo shown in the header and on the sign-in screen.',
      },
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
