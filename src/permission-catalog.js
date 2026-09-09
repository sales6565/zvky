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
      {
        key: 'user.reset_password',
        label: 'Reset User Password',
        /* managePermissions, not manageUsers: the studio asked for this to
           arrive switched on for the Super Admin and nobody else, and to be
           handed out from Settings after that. Same predicate, and the same
           reasoning, as settings.permissions and chat.message_protected — see
           the note on the latter for why it is a capability rather than a
           `() => false` that would leave the seeded rows disagreeing with the
           effective set.

           It USED to be implied by manageUsers, with a `pending` note saying
           the action did not exist. Those rows are already written and enabled
           on any deployment that has run, so narrowing the predicate here is
           not enough on its own — see ensurePasswordReset in src/migrate.js,
           which switches off the ones nobody deliberately granted. */
        impliedBy: has('managePermissions'),
        describe: 'Reset somebody else\'s password to a temporary one. They are forced to choose a '
          + 'new password before they can do anything else, and their other sessions are signed '
          + 'out. Nobody ever sees the password the person chooses.',
      },
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
      {
        key: 'asset.bulk_upload',
        label: 'Bulk Upload Assets',
        impliedBy: has('createAsset'),
        describe: 'Upload a sheet of assets into a project. The sheet carries an assignee and a '
          + 'deadline per row, so this grants creating and assigning in bulk what the holder '
          + 'could already create and assign one at a time.',
      },
      {
        /* Lead/Supervisor Notes, which arrived with the nine-column import.
         *
         * Its own permission rather than a reuse of an existing one, and its
         * own field rather than a second use of Description, for a reason
         * worth stating: Description is the brief, and everybody working on an
         * asset — the assignee included — reads and edits it today. Making
         * Description restricted would have taken a field away from the people
         * who most need it, to gain a private one. So the private one is new,
         * and Description is untouched.
         *
         * Visibility AND editing, together. A note the assignee can read but
         * not change is not private, and one they can change but not read is
         * absurd — there is one meaningful state here, not two toggles.
         *
         * Default: the departments that run the first review gate, which is the
         * studio's own existing answer to "lead and above" (see TL_REVIEW_GROUPS
         * in role-permissions.js). Every other designation is granted it in
         * Settings, artists included if the studio decides these notes are for
         * them after all — which is the reading the column name leaves open. */
        key: 'asset.lead_notes',
        label: 'Lead / Supervisor Notes',
        impliedBy: has('manageAccess'),
        describe: 'See and edit the Lead / Supervisor Notes on an asset, and import them from a '
          + 'sheet. Separate from Description, which stays visible to everyone on the asset.',
      },
      {
        /* Putting your OWN task down, and picking it up again.
         *
         * On for every designation by default, like timesheet.own and for the
         * same reason: this is not a privilege somebody grants you over other
         * people's work, it is the ability to say honestly what happened to
         * your own. A studio that cannot record an interruption records it as
         * time worked instead, which is the outcome this exists to avoid.
         *
         * Still a toggle, so a studio that would rather nobody paused anything
         * can turn it off for a designation and keep the plain start-to-submit
         * span. Turning it off does not strand anybody: a held task is resumed
         * with the same button that starts one, and Time Spent goes back to
         * counting every hour between the stamps.
         *
         * WHAT THIS DOES NOT GRANT, deliberately and for now: holding somebody
         * ELSE'S task. A lead who thinks an artist's work should stop has the
         * existing ways to say so — reassign it, or move its stage — and each
         * of those leaves a record naming who did it. A cross-person hold would
         * need its own permission and its own audit line rather than quietly
         * riding on this one, so it is out of scope until the studio asks for
         * it. See docs/PERMISSIONS.md.
         */
        key: 'asset.hold',
        label: 'Hold / Resume Own Task',
        impliedBy: () => true,
        describe: 'Put your own in-progress task on hold and pick it up later. Held time is left '
          + 'out of its Time Spent, and holding frees you to start another task.',
      },
      {
        /* Assigning and scheduling several assets in one action.
         *
         * Its own key rather than a reuse of asset.assign, because it is a
         * different kind of trust: asset.assign is "may you put a person on
         * this asset", asked one asset at a time with a name in front of you.
         * This is "may you do that to forty assets from a tick list", where the
         * mistake is forty times the size and nobody reads forty confirmations.
         * A studio should be able to grant the first and withhold the second.
         *
         * WHAT IT DOES NOT REPLACE. The per-asset question is still asked, for
         * every asset in the batch: this permission opens the bulk action, and
         * mayAssign() then decides each asset exactly as it would singly. So
         * holding this does not widen anybody's reach by one asset — a role
         * that cannot assign a given asset one at a time cannot assign it in a
         * batch either, and is told so in that asset's row of the result.
         *
         * Super Admin alone by default, like the client-feedback four:
         * has('manageAccess') is held by no other tier, so nobody gains a bulk
         * action by being promoted, and a studio grants it in Settings to the
         * coordinators who actually plan work.
         */
        key: 'asset.bulk_assign',
        label: 'Bulk Assign & Schedule Assets',
        impliedBy: has('manageAccess'),
        describe: 'Select several Not Assigned assets in the Assets List and give them all one '
          + 'assignee, one Start Date and one End Date in a single action. Assets already on '
          + 'somebody\u2019s desk are left alone \u2014 those are handed over one at a time.',
      },
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
      {
        /* Setting the dates on a project's own stages — Art from here to here,
         * Animation from there to there — shown in the Milestones column.
         *
         * Its own key rather than folding into project.edit, so a coordinator
         * who maintains the plan can be trusted with it without also being able
         * to rename a project or change who is on it. Defaults with the rest of
         * this group, so nobody who could already edit a project loses anything.
         *
         * Distinct from Manage Milestone Types in Settings, which is what
         * decides the list itself. That one is the tighter of the two: adding
         * "Rigging" changes a dropdown for the whole studio; putting a date on
         * this project's Art milestone changes this project. */
        key: 'project.milestones',
        label: 'Set Project Milestones',
        impliedBy: has('createProject'),
        describe: 'Add, change and remove the dated milestones on a project — the Milestones column on the '
          + 'Projects list. Which types exist is a separate permission, under Settings.',
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
        describe: 'See the project review queue — what is waiting, and what has been answered. '
          + 'Held by Creative Art Director out of the box; grant it to Production so they can act '
          + 'on the Creative Director\'s answers.',
      },
      {
        /* The Pending Actions tab, as its own grant.
         *
         * It used to be inferred — hold either of the two other project-review
         * permissions and the tab appeared. The studio asked for it to be
         * separable instead, so somebody can be given the workflow without the
         * tab, or the tab without waiting for a workflow grant to imply it.
         *
         * It controls VISIBILITY, not reach: what the tab lists is still shaped
         * by the two permissions around it, so holding this alone shows an
         * empty tab rather than somebody else's queue. */
        /* The submitter's own record of what they sent.
         *
         * Reading your own submissions, and nothing else — it carries no
         * action and shows nobody else's rows, so it is the mildest thing in
         * this group. It exists as a toggle rather than as "obviously you can
         * see your own" because the studio asked for every feature to be one,
         * and because a studio that wants sending without a running list
         * should be able to have that.
         *
         * Travels with project.review_send by default (see role-permissions.js):
         * granting somebody the form and not the record of what they put
         * through it is a papercut nobody would choose on purpose. */
        key: 'project.review_mine',
        label: 'See My Project Review Submissions',
        impliedBy: has('manageAccess'),
        describe: 'See your own Send Project to CD Review submissions in Pending Actions, with '
          + 'what you sent and where it has got to. Read-only, and only ever your own.',
      },
      {
        key: 'pending.view',
        label: 'View Pending Actions',
        impliedBy: has('manageAccess'),
        describe: 'Open the Pending Actions tab. What it lists is still whatever this role may act '
          + 'on — the project review queue, or the answers waiting to be acted on.',
      },
      {
        /* Separate from review.cd on purpose, and worth saying why since the two
         * are one word apart. review.cd is standing at the ASSET review gate:
         * approving one piece of work onward or sending it back, inside the
         * state machine. This is answering a submission about a whole project,
         * which moves no asset at all. A role can hold either without the other,
         * and a studio that wants its Creative Director doing both grants both.
         *
         * Split from review_queue for the same reason viewing is split from
         * acting everywhere else here: Production needs to READ the answers to
         * act on them, and should not thereby be able to make them. */
        key: 'project.review_respond',
        label: 'Respond to Project CD Review',
        impliedBy: has('manageAccess'),
        describe: 'Answer a project review submission with Submit Feedback — one action, and the '
          + 'written feedback is required, since it is all Production gets to act on. Nothing to '
          + 'do with an asset\'s own CD Review gate, which is CD Review Actions. Held by Creative '
          + 'Art Director out of the box.',
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
        /* The Settings label follows the button it gates. The KEY is untouched:
           'client.close' is in every role's granted set and in every row of
           role_permissions already written. */
        label: 'Close / Reopen Client',
        impliedBy: has('createProject'),
        describe: 'Mark a client closed so no new projects go under it, and reopen it.',
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
      {
        key: 'report.admin_dashboard',
        label: 'View Admin Dashboard',
        /* The studio in one screen: how many projects are running, what is late,
           what is due this week, what is waiting on somebody.
           
           In the Reports group rather than under Settings, because it is the
           same kind of thing the other two are — reading the studio's numbers,
           not changing how it works. It carries no ability to act: every row is
           a link into the screen that already owns that work.
           
           ON BY DEFAULT for manageUsers, which is Super Admin, Admin, Leadership
           and Full Access. The brief said Admin and Super Admin; the other two
           are the tiers that already outrank Admin — full access to every
           project in the studio — and withholding an overview from them while
           granting it to Admin would be incoherent. Everyone else is off until
           a Super Admin says otherwise.
           
           NOT its own visibility model. What the screen counts is scoped by the
           role's existing projectScope, so an Admin (projectScope 'owned') sees
           their own projects and a Super Admin sees the studio. Holding this
           permission opens the tab; it does not widen anybody's reach. */
        impliedBy: has('manageUsers'),
        describe: 'The Admin Dashboard tab: active, on-track, at-risk and delivered projects, the '
          + 'production pipeline, what is due next, and what needs attention. Read-only, and scoped '
          + 'to the projects this role can already see.',
      },
    ],
  },
  {
    /* The manual timesheet: what somebody says they worked on, as opposed to
     * what the app watched them do. Four permissions, because four different
     * things happen to a timesheet and a studio will want them apart.
     *
     * Its own group rather than a corner of Reports: the Reports permissions
     * are about reading the studio's numbers, and three of these four are
     * about a person's own week. */
    key: 'timesheet',
    label: 'Time Sheet',
    permissions: [
      {
        /* Everybody, by default, and it is the one permission in this
           application that starts ON for every designation. Filling in your own
           hours is not a privilege somebody grants you — a studio that keeps
           timesheets keeps them for everyone, and an account that cannot record
           its own week cannot be paid from this system. Still a toggle, so a
           studio that runs timesheets for one department only can say so. */
        key: 'timesheet.own',
        label: 'View / Fill Own Timesheet',
        impliedBy: () => true,
        describe: 'Open the Time Sheet tab and record your own hours, day by day, against '
          + 'projects and assets or against non-project time.',
      },
      {
        /* Reading your team's weeks, which is not the same as deciding on
           them: a coordinator may need to see where the hours went without
           being the person who signs them off, and a studio should be able to
           give one without the other. */
        key: 'timesheet.team',
        label: 'View Team Timesheets',
        impliedBy: has('manageAccess'),
        describe: 'See the timesheets of the people who report to you. Reach stays with the '
          + 'role — this is your team, not the studio.',
      },
      /* timesheet.approve was here, and the studio removed the step it gated:
         a submitted timesheet is nobody else's to approve. Deleted rather than
         kept as a switch that does nothing, because a permission a Super Admin
         can grant and which then changes nothing is worse than an absence —
         somebody would grant it and wait for a queue that never fills.
         
         What is left is the pair above: seeing your team's hours, and seeing
         the studio's. Both are read-only. A day is unlocked by the person whose
         day it is; see the reopen route in src/routes/timesheets.js. */
      {
        /* The studio-wide read. Aligned with Reports by intent rather than by
           implication: holding report.view does not hand you this, because
           reading a project's efficiency and reading everybody's attendance are
           different things to be trusted with. Granted alongside it in Settings
           for the roles that should have both. */
        key: 'timesheet.all',
        label: 'View All Timesheets',
        impliedBy: fullAccess,
        describe: 'See everybody\'s timesheets, not only your team\'s. The reporting-level view, '
          + 'for the roles that already read across the studio.',
      },
    ],
  },
  {
    /* Chat.
     *
     * Two permissions, and the asymmetry between them is the whole design.
     *
     * Talking to one other person is not a privilege the studio grants: it is
     * what a colleague does, and gating it would mean an account that can be
     * assigned work but not asked about it. So chat.use starts ON for every
     * designation, like timesheet.own, and exists as a toggle only so a studio
     * that wants chat closed for a department can say so.
     *
     * Creating a GROUP is different. A group is a room with a name and a
     * membership that outlives any one conversation, and a studio that let
     * everybody make them ends up with forty of them and no idea which is
     * current. That one starts with the roles that already run people.
     *
     * READING SOMEBODY ELSE'S CONVERSATION is not in this group, and that is
     * not an omission — it is where it is on purpose. The studio asked for an
     * oversight screen after this feature shipped, and it is
     * settings.chat_activity, next to the Activity Log. It is not a chat
     * permission: nothing it grants makes chat work differently, and putting it
     * here would suggest a studio could hand it out along with "use chat".
     *
     * The membership rule on this router is untouched by it. Nobody reads a
     * conversation through /api/chat that they are not in, Super Admin
     * included; the oversight screen is a separate router with its own gate and
     * its own record of who used it. See the header of src/routes/chat.js.
     */
    key: 'chat',
    label: 'Chat',
    permissions: [
      {
        key: 'chat.use',
        label: 'Use Chat',
        impliedBy: () => true,
        describe: 'Open the chat panel, hold one-to-one conversations with anybody in the studio, '
          + 'and take part in any group you have been added to.',
      },
      {
        /* The one key here that describes a PROPERTY rather than an action, and
         * it is worth saying why it is a permission at all — and why it is
         * phrased the way round it is.
         *
         * The studio wanted two designations shielded from unsolicited chat.
         * Written as `if (role === 'managing_director_ceo' || ...)` that is a
         * hardcoded role check, which is the thing that has caused repeated
         * bugs in this application: a studio that renames a designation, adds a
         * second VP, or decides somebody else needs the same shield has to have
         * the code changed. As a permission it is a switch on the Role
         * Permissions screen, seeded off for the two designations that asked
         * for it and available for any other.
         *
         * PHRASED AS "OPEN", NOT "PROTECTED", and that is not a style choice.
         * A Super Admin holds every key in this catalogue by construction — see
         * effectiveFor() in src/role-permissions.js — so a key meaning "I am
         * shielded" would shield the Super Admin, and the one account the whole
         * studio needs to be able to reach would quietly become unreachable.
         * Held-by-default and switched OFF to protect somebody inverts cleanly
         * against that rule, and gives a designation added in Settings next year
         * the safe default: reachable, rather than accidentally silent. */
        key: 'chat.open_inbox',
        label: 'Open Inbox',
        impliedBy: () => true,
        describe: 'Anybody in the studio may start a conversation with this designation, and add it '
          + 'to a group. Switch this OFF to shield a designation: only somebody holding "Message a '
          + 'Shielded Designation" can then reach it, though it can still message anyone it likes '
          + 'and anyone it has written to can write back.',
      },
      {
        key: 'chat.message_protected',
        label: 'Message a Shielded Designation',
        /* managePermissions rather than `() => false`, which is the same set —
           the Super Admin tier is the only one holding it — but arrives by the
           front door.
           
           A Super Admin holds every key by construction, so a key nothing
           implies is one the SEEDED ROWS lack while the effective set has it:
           the startup repair switches it back on and the Settings screen shows
           a switch that disagrees with the behaviour until it does. Implying it
           from the capability the tier actually has means the stored rows are
           right the first time. Same reasoning, and the same predicate, as
           settings.permissions. */
        impliedBy: has('managePermissions'),
        describe: 'Start a conversation with a designation whose Open Inbox is switched off, and add '
          + 'one to a group.',
      },
      {
        key: 'chat.group_create',
        label: 'Create Chat Group',
        /* Runs a team, signs off delivery, or manages people — which is Lead,
           Production, Creative Direction and everything above them, and is not
           Contributor or Staff. Written as the three capabilities rather than
           as a list of tier names so a role added in Settings lands on the
           right side of it without anybody remembering to come back here. */
        impliedBy: anyOf(has('leadsTeam'), has('deliver'), has('manageUsers')),
        describe: 'Start a group conversation and manage its members, up to thirty. '
          + 'Everybody can already chat one-to-one without this.',
      },
    ],
  },
  {
    /* Money. Its own group rather than a corner of Reports, because these two
     * permissions answer a different question from the rest of the catalogue:
     * not "what may this person do to the work" but "may this person see what
     * the work costs and what it earns".
     *
     * SPLIT IN TWO, deliberately. Knowing a project is profitable is a
     * different disclosure from knowing what each level is paid, and a studio
     * will want a producer who can read a margin without being handed the rate
     * card. One permission would have forced those together. */
    key: 'pnl',
    label: 'Profit & Loss',
    permissions: [
      {
        key: 'pnl.view',
        label: 'View Profit & Loss Reports',
        /* Super Admin only by default — the same front door as the two IP
           lists, and the idiom this codebase uses for "nobody else until
           somebody says so". Grantable to a Finance or Producer designation in
           Settings without a code change, which is the point of it being a
           permission rather than a tier check. */
        impliedBy: has('managePermissions'),
        describe: 'The Profit & Loss report: revenue, labour and other costs, gross profit, margin, '
          + 'the breakdown by role and level, and the client rollup. Read-only.',
        danger: 'This discloses what the studio earns and what its people cost. Grant it to a '
          + 'designation only when everybody holding that designation should see both.',
      },
      {
        key: 'pnl.manage',
        label: 'Manage P&L Rate Cards & Billing',
        /* Editing, and deliberately NOT implied by pnl.view. Reading a margin
           and setting the rates that produce it are different authorities:
           somebody who can change a rate card can change every historical
           project's cost basis, and somebody who can change invoiced-to-date
           can change what the studio believes it has earned. */
        impliedBy: has('managePermissions'),
        describe: 'Edit the rate cards, the team assignments and hours on a project, the client '
          + 'billing figures, and the ad hoc cost line items.',
        danger: 'These figures are what the Profit & Loss report is computed from. A wrong rate or '
          + 'a wrong invoiced amount changes the studio\'s reported profit, and every change is '
          + 'recorded in the Activity Log for that reason.',
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
      { key: 'settings.categories',   label: 'Manage Asset Categories', impliedBy: has('manageSettings'),
        describe: 'The Category dropdown on an asset. Separate from project categories below \u2014 an asset is '
          + 'a character or an environment, which is a different question from what kind of job a project is.' },
      {
        /* The project category list, which is not the asset one.
         *
         * Its own key rather than a reuse of settings.categories, for the same
         * reason the tables are separate: they are two vocabularies, and a
         * studio may well want its production coordinator naming job types
         * without also editing the list its artists file work under.
         *
         * Same default as the rest of this group, so a role already trusted
         * with Settings picks it up rather than losing a list it would expect
         * to find beside the others. */
        key: 'settings.project_categories',
        label: 'Manage Project Categories',
        impliedBy: has('manageSettings'),
        describe: 'The Category dropdown on Add Project \u2014 what kind of job a project is. Independent of the '
          + 'asset category list, with no values shared between them.',
      },
      {
        /* The list of stages a project can be planned in: Art, Animation, and
         * whatever the studio adds. Separate from the asset type list even
         * though two of the words appear in both \u2014 an asset type says what a
         * thing is, a milestone type names a stretch of a project's calendar,
         * and a studio adding "Rigging" here would not want it in the dropdown
         * on Add Asset.
         *
         * Same default as the rest of this group, which also makes it the
         * tighter of the milestone pair: putting a date on one project's Art
         * milestone travels with project editing, changing which types exist at
         * all travels with Settings. */
        key: 'settings.milestone_types',
        label: 'Manage Milestone Types',
        impliedBy: has('manageSettings'),
        describe: 'The stages a project can be planned in \u2014 Art and Animation to begin with, plus anything '
          + 'the studio adds. Adding one changes a dropdown for every project; setting the dates on a '
          + 'particular project is a separate permission, under Project Management.',
      },
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
        key: 'settings.working_hours',
        label: 'Manage Working Hours',
        /* The studio's day: how long it is, which days it runs, when it starts
           and ends, and when lunch is. Split out from Manage Branding, which is
           where the screen used to sit, because these are two different kinds
           of change — one alters a logo, the other alters what the Time Sheet
           will accept and what the Idle Report measures against, on everyone's
           account at once.

           Implied by manageSettings, which is exactly the set that could already
           reach the section through settings.branding, so nobody loses the
           access they have today and Super Admin can now separate the two. */
        impliedBy: has('manageSettings'),
        describe: 'The length of the working day, which days the studio works, and the hours and '
          + 'lunch break the Time Sheet accepts entries within.',
      },
      {
        key: 'settings.ip_allowlist',
        label: 'Manage IP Allowlist',
        impliedBy: has('manageAccess'),
        // Surfaced to the UI so the warning lives with the permission rather
        // than being remembered by whoever wrote the screen.
        danger: 'A wrong entry here locks everyone out of the application, and the way back is an environment variable on the server.',
      },
      {
        /* Addresses refused whatever the allowlist says.
         *
         * SUPER ADMIN ONLY, unlike the allowlist beside it, which travels with
         * manageAccess. Two reasons. Blocking is instant and one-sided: an
         * allowlist mistake is noticed because somebody cannot get in and says
         * so, while a block is noticed by exactly one person, who is now unable
         * to say anything. And it is the tool somebody would reach for to cut
         * off a colleague — which is a decision for whoever runs the studio,
         * not for everyone trusted with the network list.
         *
         * impliedBy managePermissions is the front door: only the designation
         * that hands out permissions has it, and the Super Admin picks up new
         * permissions without anybody switching them on. */
        key: 'settings.ip_blocklist',
        label: 'Manage IP Blocklist',
        impliedBy: has('managePermissions'),
        describe: 'Bar specific addresses outright. A blocked address is refused even when the allowlist '
          + 'would admit it, and even while the allowlist is only monitoring.',
        danger: 'A block takes effect immediately and the person blocked cannot tell you. Blocking your own '
          + 'address is refused; blocking the range you sit in is not, and would lock out everyone on it.',
      },
      {
        key: 'settings.email_config',
        label: 'Manage Email Configuration',
        /* The mail server the studio sends from, and the credentials for it.
           Super Admin only by default, the same front door as the two IP lists
           and for the same kind of reason: this screen holds somebody else's
           live password, and a role that could edit it could point every
           notification the studio sends at a server of their choosing.
           
           Deliberately NOT implied by manageSettings, which would have handed it
           to the seven designations that manage priorities and categories. */
        impliedBy: has('managePermissions'),
        describe: 'The mail server task-notification emails are sent through, the account they '
          + 'authenticate with, and the address they come from.',
        danger: 'This screen holds a live password for another system. It is stored encrypted and is '
          + 'never shown again once saved, but whoever holds this permission can replace it, and can '
          + 'change where the studio\'s notifications appear to come from.',
      },
      { key: 'settings.audit_logs',   label: 'View Audit Logs',      impliedBy: has('manageSettings'), pending: PENDING },
      {
        key: 'settings.activity_log',
        label: 'View Activity Log',
        /* Every action every person has taken, in one page. Its own permission
           rather than part of general Settings access, because reading what
           everybody in the studio has been doing is a different kind of
           authority from changing a priority list — and one a Super Admin
           should be able to grant, or withhold, on its own.

           Defaults to the seven designations that already hold manageSettings,
           which is the same set the brief named as top-of-hierarchy. Off for
           the other fifty-three until somebody switches it on. */
        impliedBy: has('manageSettings'),
        describe: 'The consolidated record of every action taken in the application, by anybody — '
          + 'who did what, when, and what changed. Read-only, and it cannot be edited or cleared '
          + 'from inside the app.',
      },
      {
        key: 'settings.chat_activity',
        label: 'View Chat Activity',
        /* Reading what people said to each other. Its own key, in Settings
         * rather than in the Chat group, because it is not a chat feature: it
         * is an oversight screen that happens to be about chat, and it belongs
         * beside the Activity Log it sits next to.
         *
         * SUPER ADMIN ONLY BY DEFAULT, and deliberately narrower than
         * settings.activity_log beside it. That one defaults to the seven
         * designations holding manageSettings, on the reasoning that a record
         * of what people DID to the work is administrative. This is a record of
         * what people SAID, which is a different kind of access — so it starts
         * with one account and is extended, if at all, by somebody deciding to.
         *
         * managePermissions rather than `() => false`: same set, same reasoning
         * as user.reset_password and chat.message_protected. A key nothing
         * implies is one the seeded rows lack while the effective set has it.
         *
         * The danger line is shown on the Role Permissions screen beside the
         * switch, so whoever grants it is told what they are granting at the
         * moment they grant it. */
        impliedBy: has('managePermissions'),
        describe: 'Read every chat message in the studio — one-to-one and group — with its sender, '
          + 'its conversation, when it was sent and any file still inside its retention window. '
          + 'Every use of this screen is itself recorded in the Activity Log.',
        danger: 'This reads private conversations between colleagues. Staff should be told that '
          + 'chat is logged before it is granted, not after.',
      },
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
