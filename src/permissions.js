const db = require('./db');
const { roleDef, assignableRoles, leadRoles, isContributor, entries } = require('./roles');
const assetHold = require('./asset-hold');

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

  // Archived projects are out of every scope, for everybody. Nothing about
  // them is destroyed — an archived project's assets, submissions and review
  // history are all still there, and restoring it brings the lot back. It is
  // simply not somewhere work happens any more, so it does not clutter a
  // picker or a board. The Projects tab is where archived ones are listed and
  // restored, which is the one place that asks for them on purpose.

  if (def.projectScope === 'all') {
    const { rows } = await db.query('SELECT * FROM projects WHERE is_active = 1 ORDER BY created_at');
    return rows;
  }

  /* ---------------------------------------------------------------------
   * ACTING TEAM LEADS SEE THE PROJECT THEY ARE ACTING ON, WHATEVER THEIR SCOPE.
   *
   * Added as a UNION around the four scope queries rather than as a fifth JOIN
   * inside two of them, and that is the whole point of it: "being named Acting
   * TL on this project makes this project visible" is ONE rule, and writing it
   * into the 'assigned' and 'team' queries would have left the two narrower
   * scopes — 'owned' and 'own_work' — unable to see a project they had been
   * put in charge of. Those are exactly the designations a studio reaches for
   * when it wants somebody to stand in without promoting them, so they are the
   * case that matters most.
   *
   * IT WIDENS NOTHING ELSE. The union adds the projects this person is acting
   * on and no others, so a narrow-scope user named on one project sees that
   * project and whatever their own scope already gave them — never the studio.
   * A test pins exactly that with the narrowest scope there is.
   *
   * One extra indexed read per call, on a table that is empty on every install
   * until somebody uses the feature. */
  const withActing = async (rows) => {
    const { rows: acting } = await db.query(
      `SELECT p.* FROM projects p
         JOIN project_acting_team_leads patl ON patl.project_id = p.id
        WHERE patl.user_id = $1 AND p.is_active = 1
        ORDER BY p.created_at`,
      [user.id]
    ).catch(() => ({ rows: [] }));
    if (!acting.length) return rows;
    const seen = new Set(rows.map((p) => p.id));
    return rows.concat(acting.filter((p) => !seen.has(p.id)));
  };

  if (def.projectScope === 'owned') {
    const { rows } = await db.query(
      'SELECT * FROM projects WHERE owner_id = $1 AND is_active = 1 ORDER BY created_at',
      [user.id]
    );
    return withActing(rows);
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
       LEFT JOIN project_supervision  ps ON ps.project_id = p.id AND ps.user_id = $1
       WHERE p.is_active = 1
         AND (pc.user_id IS NOT NULL OR ptl.user_id IS NOT NULL OR ps.user_id IS NOT NULL OR p.owner_id = $1)
       ORDER BY p.created_at`,
      [user.id]
    );
    return withActing(rows);
  }

  if (def.projectScope === 'team') {
    // Either they're named on the project in one of its three membership lists
    // — leads, production coordinators, supervision and creative direction — or
    // one of their reports has an asset in it. Supervisors who run a discipline
    // rather than a project used to be reachable only through the last of
    // those; being named on the project now counts on its own, so putting
    // somebody in that section is not a change that leaves them unable to see
    // what they were put on.
    //
    // The coordinators list is joined here for the same reason it is joined in
    // the 'assigned' scope above: the three lists are one idea — who is on this
    // project's team — and a scope that reads two of them makes membership mean
    // different things depending on the reader's tier.
    const { rows } = await db.query(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_team_leads ptl ON ptl.project_id = p.id AND ptl.user_id = $1
       LEFT JOIN project_coordinators pc ON pc.project_id = p.id AND pc.user_id = $1
       LEFT JOIN project_supervision ps ON ps.project_id = p.id AND ps.user_id = $1
       LEFT JOIN assets a ON a.project_id = p.id
       LEFT JOIN users  r ON r.id = a.assignee_id AND r.team_lead_id = $1
       WHERE p.is_active = 1
         AND (ptl.user_id IS NOT NULL OR pc.user_id IS NOT NULL OR ps.user_id IS NOT NULL
              OR r.id IS NOT NULL OR p.owner_id = $1)
       ORDER BY p.created_at`,
      [user.id]
    );
    return withActing(rows);
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
     WHERE p.is_active = 1 AND (a.id IS NOT NULL OR pm.user_id IS NOT NULL OR p.owner_id = $1)
     ORDER BY p.created_at`,
    [user.id]
  );
  return withActing(rows);
}

async function canAccessProject(user, projectId) {
  const projects = await visibleProjects(user);
  return projects.some((p) => p.id === projectId);
}

/* IS THIS PROJECT WITHIN THIS ROLE'S REACH — the scope half of every
 * project-changing permission, and the fix for a granted permission that did
 * nothing.
 *
 * ===========================================================================
 * WHAT WAS THERE BEFORE, AND WHY IT MADE THE PERMISSION INERT.
 *
 * src/routes/projects.js had this, and the page had a copy of it:
 *
 *     roleDef(user.role).projectScope === 'all' || project.owner_id === user.id
 *
 * Read it with a real role in mind. An owner grants Project Edit to Producer
 * because producers should be able to correct a project's details. Producer's
 * scope is `assigned`, not `all`, so the first half is false. Producer has
 * createProject: false, so it can never be the owner_id of anything, so the
 * second half is false too. The permission was switched on, /auth/me returned
 * it, the Settings screen showed it held — and every route answered 403 and the
 * pencil never drew. The same was true of every designation an owner would
 * plausibly grant it to: of the sixty built-in roles, exactly one (admin) holds
 * project.edit by default without studio-wide scope, and it owns what it
 * creates, so the gap never showed up for the accounts that built the feature.
 *
 * THE RULE THAT REPLACES IT IS THE ONE THE SCREENS ALREADY PROMISE: a role
 * changes the projects it can SEE. Not the projects it created — being able to
 * see a project is already the studio's statement that this is your work.
 *
 * ===========================================================================
 * IT WIDENS NOTHING FOR ANYBODY WHO COULD EDIT BEFORE, and that is checkable
 * rather than hopeful, because the two old branches are still the first two
 * lines of it:
 *
 *   scope 'all'      -> true here, and visibleProjects returns everything, so
 *                       the answer is the same answer.
 *   the owner        -> true here. It is also the reason the owner test stays
 *                       as its own line rather than being left to
 *                       canAccessProject: every scope's query already includes
 *                       `p.owner_id = $1`, so an ACTIVE project of one's own is
 *                       visible anyway — but visibleProjects excludes ARCHIVED
 *                       projects from every scope, for everybody, and restoring
 *                       one is exactly the operation performed on an archived
 *                       project. Without this line, granting an owner the right
 *                       to restore their own archived project would have been
 *                       taken away by this change.
 *
 * Everything after those two lines is new reach, and only ever more.
 *
 * ARCHIVED PROJECTS ARE NOT REACHABLE BY A SCOPED ROLE, which is the deliberate
 * consequence of answering this with "can you see it". It matches what the
 * Projects tab does: archived projects are listed only to a caller whose scope
 * is the whole studio (see archivedProjectsByClient in src/routes/clients.js),
 * so a scoped role is never shown one to act on in the first place.
 *
 * THE PERMISSION IS A SEPARATE QUESTION and is not asked here. This answers
 * WHICH projects; src/project-authority.js puts that together with WHETHER the
 * role holds the key, and is the only place the two are combined.
 */
async function reachesProject(user, project, visible = null) {
  if (!user || !project) return false;
  const def = roleDef(user.role);
  if (!def) return false;
  if (def.projectScope === 'all') return true;
  if (project.owner_id && project.owner_id === user.id) return true;
  /* `visible` IS AN ANSWER ALREADY PAID FOR, NOT A SECOND RULE. A caller
     deciding this for a whole list has usually just run visibleProjects() to
     build it; handing the ids in turns N calls of that query into nought.
     Asked only after the two short-circuits above, so it answers exactly the
     question canAccessProject would have asked. */
  if (visible) return visible.has(project.id);
  return canAccessProject(user, project.id);
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
/* DOES THIS PERSON SEE EVERY ASSET OF THIS PROJECT — the one project-level answer.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO END, which was the same bug in three places.
 *
 * An owner names an ordinary artist as Acting Team Lead of a project. The project appears
 * in their picker — visibleProjects() has had a union for the acting list since Prompt 50 —
 * and then the board is EMPTY. Not refused: two hundred with nothing in it, and every
 * read of an individual asset (history, tasks, worklog, game feedback, submissions) a
 * flat 403. A stand-in lead with no work of their own in the project saw nothing at all,
 * on a project they had just been put in charge of.
 *
 * Three places decided it, and all three asked the same wrong question — the ROLE TIER:
 *
 *   canViewAsset()                 if (isContributor(def)) return false
 *   assetOnDashboard()             if (isContributor(def)) return asset.assignee_id === ...
 *   GET /assets/project/:id        if (isContributor(def)) sql += ' AND a.assignee_id = ?'
 *
 * An artist or animator is `assignable` and not `leadsTeam`, so each of those narrowed
 * them to their own assignments however many project team tables named them. None of them
 * asked the question the feature turns on: is this person a lead OF THIS PROJECT?
 *
 * ===========================================================================
 * SO THE QUESTION IS ASKED ONCE, HERE, AND FROM THE SHARED LIST.
 *
 * isProjectLead() is PROJECT_TEAM_TABLES — team leads, ACTING team leads, coordinators and
 * supervision — so every team section a project form offers is covered by one list, and a
 * section added to that list is covered by this the moment it is added. No second
 * hard-coded table list, and no role tier: that is the whole point.
 *
 * ===========================================================================
 * WHAT IT DOES NOT CHANGE, read one designation at a time with the project reachable:
 *
 *   scope 'all'                         true, as before
 *   leadsTeam                           true, as before (canAccessProject was the answer)
 *   contributor, not a project lead     false, as before
 *   coordinator/admin tier, not a lead  true, as before (canAccessProject was the answer)
 *   contributor who IS a project lead   TRUE — and this is the fix, the only new answer
 *
 * ARCHIVED PROJECTS ARE STILL OUT, for everyone including a named lead, because the first
 * thing this asks is canAccessProject() and visibleProjects() excludes them. The rule for
 * an archived project is today's rule, untouched.
 *
 * IT WIDENS NOTHING BEYOND THE PROJECT NAMED. An Acting TL of A is a lead of A and of
 * nothing else; on project B they are whatever their designation makes them. */
async function seesWholeProject(user, projectId) {
  const def = roleDef(user && user.role);
  if (!def || !projectId) return false;
  if (def.projectScope === 'all') return true;
  /* The project has to be reachable at all first — which is where archived projects and
     projects outside the designation's scope drop out, exactly as they did before. */
  if (!(await canAccessProject(user, projectId))) return false;
  if (def.leadsTeam) return true;
  /* THE FIX, and the only line that answers differently from this morning: a designation
     that is not a lead by tier, but has been named a lead of THIS project. */
  if (await isProjectLead(user, projectId)) return true;
  return !isContributor(def);
}

async function canViewAsset(user, asset) {
  const def = roleDef(user.role);
  if (!def) return false;
  if (def.projectScope === 'all') return true;
  /* ASSIGNED TO YOU: visible, whatever else the designation does.
   *
   * Checked before the team branch, and it has to be. A lead is now both
   * `assignable` and `leadsTeam`, and the old order returned out of the
   * assignable branch first — so the moment leads became assignable a lead
   * would have seen only their own assignments and lost their team's work and
   * their review queue entirely. Taking the two in this order gives a
   * designation that is both the UNION of the two rules rather than whichever
   * test happens to run first. */
  if (def.assignable && asset.assignee_id === user.id) return true;
  /* A LEAD'S REPORTS, which is not a project-level question and stays here: a lead sees
     work their report is holding wherever it is, including in a project their own scope
     does not reach. seesWholeProject() cannot answer that and must not try. */
  if (def.leadsTeam && await isReport(user, asset.assignee_id)) return true;
  /* AND THE PROJECT-LEVEL ANSWER, from the one function that gives it. This replaces the
     three branches that used to be here — leadsTeam, the contributor refusal, and the
     coordinator fall-through — because all three were asking "does this person see the
     whole of this project?" in three different ways. */
  return seesWholeProject(user, asset.project_id);
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
// sufficient. Two ways to be the right person, and only two:
//
//   1. A full-access role. Studio-wide reach is what that tier is, and somebody
//      has to be able to fix an asset whose creator has left. This is the one
//      exception to the ownership rule.
//   2. You added it. The rule proper.
//
// Being the assignee is deliberately NOT a third way. It was, briefly, on the
// reasoning that a contributor needs to tick a checklist item on their own
// work — and that consequence is real: contributors never add assets, so under
// this rule the checklist and the description are read-only to the artist
// carrying the asset. That was raised and decided the other way. Submitting for
// review is a separate permission and is unaffected, so the pipeline still
// runs; what an artist can no longer do is change the record of the work.
//
// created_by is NULL for assets that predate the column and could not be
// attributed (see ensureAssetOwnership in src/migrate.js). Those are unowned:
// clause 2 can never match, so only a full-access role can edit them.
function ownsAsset(user, asset) {
  if (!user || !asset) return false;
  if (hasFullAccess(user)) return true;
  return Boolean(asset.created_by) && asset.created_by === user.id;
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
// Its own permission, over the same ownership question.
function canAssignAsset(user, asset) {
  return holds(user, 'asset.assign') && ownsAsset(user, asset);
}

/* The other way in: assigning work you did not create.
 *
 * Deliberately a separate function and a separate permission, checked
 * independently of the one above. asset.assign asks "is this yours"; this asks
 * nothing about who created it. A role may hold either, both or neither, and
 * granting one neither implies nor disables the other.
 *
 * It does keep project scope. Ownership was quietly doing that job for
 * asset.assign — you can only have created assets on projects you can reach —
 * so dropping ownership without putting the project check back would have
 * turned one checkbox into studio-wide reach, which no other permission grants.
 */
async function canAssignAnyAsset(user, asset) {
  if (!holds(user, 'asset.assign_any')) return false;
  if (!asset || !asset.project_id) return false;
  return canAccessProject(user, asset.project_id);
}

// Either route in. What every assignment gate should ask.
async function mayAssign(user, asset) {
  return canAssignAsset(user, asset) || await canAssignAnyAsset(user, asset);
}

// Who may hand a SUBMITTED asset to somebody else.
//
// Deliberately a wider reach than the rework handover below it, and the axis is
// whose desk the asset is sitting on.
//
//   rework      the asset is back with the artist. Whether somebody else picks
//               it up is the creator's call, and only theirs. Unchanged.
//
//   in review   the asset is in a reviewer's queue. It is on THEIR desk, and
//               they are the person who can see it is not going to be finished
//               by whoever submitted it — so the reviewer holding it may hand
//               it on, as well as the creator.
//
// The permission is still asset.assign: this widens who it reaches, not what
// key is asked for. A reviewer whose role does not hold asset.assign — an Art
// Director, by default — still cannot, and granting it in Settings is the way
// to change that.
async function canHandOverInReview(user, asset) {
  /* The broad permission is a route in here too — handing work to somebody
     else IS assigning it, and a coordinator trusted to assign anything should
     not be stopped at the one stage where the work has already started. Asked
     first because it does not depend on the stage at all. */
  if (await canAssignAnyAsset(user, asset)) return true;
  if (!holds(user, 'asset.assign')) return false;
  if (ownsAsset(user, asset)) return true;                       // creator, or full access

  /* Beyond the creator, the reach follows the stage — whoever is holding the
     asset at that moment may pass it on:
     
       TL Review     the lead it is waiting on
       CD Feedbacks    the director who sent it back, and the lead who relays
                     their notes — either may put somebody else on the rework
       TL Feedbacks  the lead who sent it back
       CD Review     the director it is waiting on
       Game Feedback the lead standing at the first gate on it — the one who
                     passed the bug to the artist, or whoever else holds that
                     gate on this asset
     
     The rework stages reached only the creator before, so a lead who had just
     sent work back could not then hand that rework to somebody else — the one
     person with the clearest reason to.
     
     GAME FEEDBACK WAS MISSING FROM THIS SWITCH while being listed on
     reassign_review's from-list in src/asset-workflow.js, which is the worst of
     the two ways round: the transition existed, the screen offered the stage,
     and the gate refused everybody the default case caught. So the control was
     reachable only through asset.assign_any, the asset's creator, or full
     access — and the lead who had just passed a bug to an artist, the one
     person who would need to reroute it if that artist went on leave, was not
     any of those. */
  const asCD = async () => canReviewAsCD(user) && await canViewAsset(user, asset);
  switch (asset.status) {
    case 'pending_tl_review':
    case 'tl_changes_requested':
    /* The same gate, for the same reason it decides who may pass or decline the
       bug: whoever may stand at the first review gate on THIS asset owns the
       round, and rerouting it is part of owning it. */
    case 'game_feedback':
      return canActAtTlGate(user, asset);
    case 'pending_cd_review':
      return asCD();
    case 'cd_changes_requested':
      return (await asCD()) || await canActAtTlGate(user, asset);
    default:
      return false;
  }
}

// Who may work the checklist on an asset.
//
// The checklist is what the asset is measured against, so it is set by the
// people who define and check the work rather than by the person doing it:
//
//   the creator (or a full-access role) — it is their asset
//   the reviewer holding it             — TL or CD, who tick things off as they check
//
// The assignee is deliberately NOT on that list. They read the checklist and
// work to it; they do not decide what is on it, and they do not declare an item
// finished — that is the reviewer's call. This reverses an earlier default
// where the assignee could manage the list on the reasoning that it was their
// working notes. The studio's answer is that it is not: it is the specification
// they are working to.
//
// Reading is unaffected — canViewAsset governs that — and so is everything the
// assignee does to carry the work: accepting it, the clock, and submitting.
async function canManageTasks(user, asset) {
  if (!user || !asset) return false;
  if (ownsAsset(user, asset)) return true;                       // creator or full access
  if (await canActAtTlGate(user, asset)) return true;         // the first review gate
  if (holds(user, 'review.cd') && await canViewAsset(user, asset)) return true;
  return false;
}

// The two states where an asset is waiting for rework. The creator may hand
// that rework to somebody else rather than let it go back to whoever submitted
// it — which is the whole point of the Reassign action.
/* Three now, not two. game_feedback joins them because it IS a rework state: the
   asset is back with the studio because the build says it is broken, and the artist
   works on it and submits again exactly as they would after a lead's notes. Anything
   reading this list to mean "waiting for rework" was already right about
   game_feedback before it existed. */
const REWORK_STATUSES = ['tl_changes_requested', 'cd_changes_requested', 'game_feedback'];

function isAwaitingRework(asset) {
  return Boolean(asset) && REWORK_STATUSES.includes(asset.status);
}

/* WHO MAY ACT AT THE FIRST REVIEW GATE — the project's team, not the artist's.
 *
 * The three tables below are the project's membership lists, and between them
 * they carry the four categories the studio names:
 *
 *   project_team_leads     Team Lead
 *   project_acting_team_leads  Acting Team Lead — somebody standing in as a
 *                          lead on THIS project and nowhere else. Their
 *                          designation is untouched: being on this list is what
 *                          qualifies them, exactly as it is for the three
 *                          beside it, and being on it for one project says
 *                          nothing about any other.
 *   project_coordinators   Production Coordinator
 *   project_supervision    Supervision AND Creative Direction (one list, because
 *                          that is the section the project form already has)
 *
 * Being on any of them, in any of those categories, is what qualifies somebody
 * to act on work sitting at TL Review, TL Feedbacks or TL Approved — every
 * asset in the project, whoever happens to be holding it.
 *
 * This REPLACES the old question, which was about the artist rather than the
 * project: "is this person the assignee's own team lead", read off
 * users.team_lead_id. That made the gate a property of the reporting line, so
 * an asset's reviewer changed depending on which artist picked the work up, and
 * a lead staffed on a project could not approve work by somebody who reported
 * elsewhere. Nothing here reads team_lead_id any more.
 *
 * Deliberately NOT keyed on the qualifying person's role, only on which list
 * they are in. The lists are already role-filtered where they are written — the
 * project form offers leads, coordinators and supervision separately, and
 * checkSupervision() in src/routes/projects.js refuses anyone outside those
 * designations — so asking again here would be a second copy of that rule, free
 * to drift from the first.
 */
const PROJECT_TEAM_TABLES = ['project_team_leads', 'project_acting_team_leads',
  'project_coordinators', 'project_supervision'];

/* THE TABLES THAT MAKE SOMEBODY A LEAD OF A PROJECT, which is the same list.
 *
 * Named separately from PROJECT_TEAM_TABLES so the two ideas can be read apart
 * even though they are the same set today: "who may act at the TL gate" and
 * "who is a lead of this project" have always been one question in this
 * application, and writing them as one constant twice would be the first step
 * to them answering differently. */
const PROJECT_LEAD_TABLES = PROJECT_TEAM_TABLES;

/* The one list whose membership stands in for the review.tl permission, for the
   project it names and for nothing else — see canActAtTlGate. */
const ACTING_TABLE = 'project_acting_team_leads';

/* WHO THE LEADS OF A PROJECT ARE, as ids. One query over the four lists.
 *
 * The shared function Prompt 50 asks for. Every caller that needs "the people
 * who can act as a lead here" comes through this or through
 * reviewTeamProjects() below — nothing reads the membership tables itself, and
 * tests/acting-team-leads.test.js fails if anything outside a named allowlist
 * reads the acting table at all. */
async function projectLeadIds(projectId) {
  if (!projectId) return [];
  const sql = PROJECT_LEAD_TABLES
    .map((t) => `SELECT user_id FROM ${t} WHERE project_id = $1`)
    .join(' UNION ');
  const { rows } = await db.query(sql, [projectId]).catch(() => ({ rows: [] }));
  return [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
}

/* Is this person a lead of this project? The single-question form, and it is
   onProjectReviewTeam under another name — kept as its own export because that
   is the name the rest of the codebase will reach for, and an alias is cheaper
   than two implementations. */
async function isProjectLead(user, project) {
  const projectId = project && typeof project === 'object' ? project.id : project;
  return onProjectReviewTeam(user, projectId);
}

/* WHICH of the lists matched, for one person on one project. Used by
   tlGateAuthority to tell an Acting TL apart from a Team Lead — and ONLY for
   that: the decision about whether they may act is the union above, and this
   never narrows it. */
async function leadTablesFor(userId, projectId) {
  if (!userId || !projectId) return [];
  const sql = PROJECT_LEAD_TABLES
    .map((t) => `SELECT '${t}' AS src FROM ${t} WHERE user_id = $1 AND project_id = $2`)
    .join(' UNION ');
  const { rows } = await db.query(sql, [userId, projectId]).catch(() => ({ rows: [] }));
  return rows.map((r) => r.src);
}

// Which of these projects this user is on the team of. One query for the lot,
// because the board asks this for every asset on screen.
async function reviewTeamProjects(userId, projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!userId || !ids.length) return new Set();
  const sql = PROJECT_TEAM_TABLES
    .map((t) => `SELECT project_id FROM ${t} WHERE user_id = $1 AND project_id IN ($2)`)
    .join(' UNION ');
  const { rows } = await db.query(sql, [userId, ids]);
  return new Set(rows.map((r) => r.project_id));
}

/* EVERY PROJECT THIS PERSON IS ON THE TEAM OF, as ids — the whole list, not a test
 * against ids the caller already has.
 *
 * reviewTeamProjects() above answers "which of THESE projects" and needs the candidates;
 * this answers "which projects at all", which is what /auth/me carries so an open page can
 * notice its own memberships changing. Same four tables, same constant: a team section
 * added to PROJECT_TEAM_TABLES is carried by this without being mentioned here.
 *
 * Sorted, so the value is comparable as a string on the other side and two reads that
 * found the same memberships cannot look like a change. */
async function projectTeamIdsFor(userId) {
  if (!userId) return [];
  const sql = PROJECT_TEAM_TABLES
    .map((t) => `SELECT project_id FROM ${t} WHERE user_id = $1`)
    .join(' UNION ');
  const { rows } = await db.query(sql, [userId]).catch(() => ({ rows: [] }));
  return [...new Set(rows.map((r) => r.project_id).filter(Boolean))].sort();
}

async function onProjectReviewTeam(user, projectId) {
  if (!user || !projectId) return false;
  return (await reviewTeamProjects(user.id, [projectId])).has(projectId);
}

/* ---------- holding somebody ELSE's task ----------
 *
 * THE RULE ITSELF LIVES IN src/asset-hold.js, once, and returns a reason rather
 * than a boolean. What is left here is the half that needs the database:
 * IS THIS TASK ON THIS PERSON'S OWN DASHBOARD?
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FOURTH REPORT CHANGED, AND WHY THE OLD ANSWER WAS WRONG.
 *
 * Prompt 20 widened the lead rule to four named designation keys inside their
 * own projects. Prompt 34 replaced the four keys with the Supervision group.
 * Both scoped the project half to leadOrSupervisorProjects() — the
 * project_team_leads and project_supervision membership tables.
 *
 * THAT IS NOT WHAT A LEAD SEES. The dashboard and the Assets List are scoped by
 * visibleProjects(), and for a lead's `team` scope that query matches FIVE
 * things, not two:
 *
 *     project_team_leads            both agreed
 *     project_supervision           both agreed
 *     project_coordinators          visible, out of hold scope
 *     a direct report has an asset  visible, out of hold scope
 *     they own the project          visible, out of hold scope
 *
 * MEASURED, against a Team Lead built the way production builds one — a
 * designation of team_lead with two artists reporting to them. Their dashboard
 * showed three projects; one was holdable. The other two answered 403
 * HOLD_NOT_YOURS and the button was not drawn, which is the fourth report.
 *
 * The last of the three gaps is the big one: having a direct report with work in
 * a project is the ordinary way a Team Lead comes to see it. Being NAMED on the
 * project's Team Leads field is a separate administrative act, with a cap on how
 * many people it takes — so in a real studio the two sets routinely differ.
 *
 * ---------------------------------------------------------------------------
 * SO THE SCOPE IS NOW THE BOARD'S OWN, ASKED OF THE BOARD'S OWN FUNCTION.
 * assetOnDashboard() calls canAccessProject(), which is visibleProjects(). There
 * is deliberately no SQL below that reimplements visibility: a second query that
 * means to say the same thing is exactly the defect this is a fix for, one level
 * down, and it would drift the same way.
 */

/* IS THIS TASK ON THIS PERSON'S DASHBOARD — the board's rule, not a copy of it.
 *
 * WHAT THE BOARD ACTUALLY DOES, in GET /assets/project/:projectId:
 *
 *   1. canAccessProject(user, projectId), else 403 for the whole project
 *   2. isContributor(def) ? only rows assigned to them : every row
 *
 * That is all of it, and this is those two lines. Written here rather than
 * imported from the route because the route is an express handler and this is
 * the predicate inside it; tests/hold-visibility.test.js holds the two equal by
 * fetching the board and comparing, which is the only check that cannot drift.
 *
 * `projects` may be passed in by a caller that already has the list — the board
 * does, for the whole page in one query — so a forty-card board costs one
 * visibleProjects() call rather than forty.
 */
async function assetOnDashboard(user, asset, projects = null) {
  if (!user || !asset || !asset.project_id) return false;
  const def = roleDef(user.role);
  if (!def) return false;
  const reachable = projects
    ? projects.some((p) => (p.id || p) === asset.project_id)
    : await canAccessProject(user, asset.project_id);
  if (!reachable) return false;
  /* The board's one narrowing, now asked of the shared function rather than of the role
     tier. A contributor's dashboard is still their own work — seesWholeProject() returns
     false for them, so this reads exactly as it did — EXCEPT for a contributor who has
     been named a lead of this project, who now sees the project's board like any other
     lead of it. That was the bug: the acting lead's board was empty.

     The assignee half stays, because an assignment is visible whatever the project says. */
  if (await seesWholeProject(user, asset.project_id)) return true;
  return asset.assignee_id === user.id;
}

/* The same question for a whole board, batched. One visibleProjects() for the
   page, which is the call the board itself already makes through
   canAccessProject — see the note above about forty queries. */
async function dashboardProjects(user) {
  if (!user) return [];
  return visibleProjects(user);
}

/* Which designations may hold somebody else's work, as keys — for the Settings
   screens and the tests that want to enumerate them.
 *
 * BY PERMISSION, NOT BY DESIGNATION. The fourth report asked for this
 * explicitly: a studio with a designation called "Team Lead - Art", or one that
 * renames an existing one, must not fall out of the rule because a string stopped
 * matching. asset.hold_any is impliedBy has('leadsTeam') — the capability the
 * app already uses to mark a designation as running a team — so the answer
 * follows the catalogue, and a Super Admin granting or revoking the key in
 * Settings moves it without a deploy.
 *
 * Derived from defaultsFor() rather than from the tier alone so that it reports
 * the DEFAULTS a new install gets, which is what the Settings screens and the
 * migration test are asking about. What a given role holds right now is
 * rolePermissions.effectiveFor(db, role), which is what the request path uses.
 */
const holdOthersRoles = () => entries()
  .filter((r) => require('./permission-catalog').baselineFor(
    require('./role-tiers').capabilitiesForTier(r.tier) || {}).has('asset.hold_any'))
  .map((r) => r.key);

/* Every fact src/asset-hold.js needs about one person and one task, gathered.
 *
 * ONE GATHERER, so the two routes and the board's per-asset flag cannot gather
 * different facts and then reach different conclusions from the same rule —
 * which is the failure mode that survived three previous reports of this button.
 * The board passes `onDashboard` and `outsourcedTo` in, because it has them
 * batched for the whole page; a route passes neither and they are fetched here.
 */
async function holdFactsFor(user, asset, extra = {}) {
  const holdsPermission = holds(user, 'asset.hold');
  const holdsAny = holds(user, 'asset.hold_any');
  const outsourcedTo = extra.outsourcedTo !== undefined ? extra.outsourcedTo : null;
  const mine = Boolean(user && asset && asset.assignee_id && asset.assignee_id === user.id);

  /* THE VISIBILITY QUESTION IS THE ONLY ONE THAT COSTS A QUERY, so it is asked last and
   * only when it could change the answer.
   *
   * DEFENCE IN DEPTH, and tests/hold-lead-scope.test.js pins it by pointing this process at
   * a database that does not exist: a cheap refusal — no permission, no assignee, your own
   * task, out with a freelancer, or a designation without the lead key — has to come back
   * without the query, or the assertion fails with a connection error instead of `false`.
   *
   * The board passes `onDashboard` in and reaches none of this: it has the answer for the
   * whole page in one query. */
  const needsScope = holdsPermission && holdsAny && !mine && !outsourcedTo
    && Boolean(asset && asset.assignee_id && asset.project_id);

  let onDashboard = extra.onDashboard;
  let unavailable = Boolean(extra.unavailable);
  if (onDashboard === undefined) {
    if (!needsScope) {
      onDashboard = false;
    } else {
      /* A FAILED QUERY IS NOT A REFUSAL. "Your dashboard does not show this" and
         "we could not find out whether it does" are different things to tell
         somebody, and reporting the first when the second is true is how a
         schema gap gets reported as a permissions bug. */
      try {
        onDashboard = await assetOnDashboard(user, asset, extra.projects || null);
      } catch (err) {
        console.warn(`[hold] visibility unavailable (${err.code || err.message}) — see /api/health.`);
        onDashboard = false;
        unavailable = true;
      }
    }
  }

  return {
    user,
    asset,
    holdsPermission,
    holdsAny,
    onDashboard: Boolean(onDashboard),
    outsourcedTo,
    openSession: Boolean(extra.openSession),
    held: extra.held || null,
    unavailable,
  };
}

/* May this person hold a task that is not theirs? Kept as a predicate because
   two older callers read it that way; it is the shared rule underneath. */
async function canHoldOthersWork(user, asset) {
  if (!user || !asset || !asset.project_id) return false;
  if (!holds(user, 'asset.hold_any')) return false;
  return assetOnDashboard(user, asset);
}

/* The authority half of the question, for callers that only want yes or no.
 *
 * SESSION STATE AND STATUS ARE NOT ASKED HERE, deliberately: this answers "is
 * this task any of your business", which is what the old canHoldAsset meant, and
 * the routes now go through src/asset-hold.js for the whole decision including
 * the reason. Asking with openSession true and a working status makes the shared
 * rule skip the there-is-nothing-to-hold and wrong-stage branches and answer
 * only the part this function is about.
 */
async function canHoldAsset(user, asset) {
  if (!user || !asset) return false;
  const facts = await holdFactsFor(user, asset, { openSession: true });
  return assetHold.decide('hold', { ...facts, asset: { ...asset, status: 'in_progress' } }).ok;
}

/* Whether a project has been staffed at all.
 *
 * The rule above is "the project's team decides" — which says nothing about a
 * project that has no team. Applying it there would leave every asset in such a
 * project stuck at TL Review with nobody able to move it, which is a worse
 * answer than the one it replaces and would hit every project created before
 * this existed.
 *
 * So the lists govern once there is somebody on them, and a project with none
 * keeps the behaviour it had. Same shape as GET /projects/:id/artists, which
 * narrows its picker to the project's leads only when the project has leads.
 */
async function projectsWithReviewTeam(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!ids.length) return new Set();
  const sql = PROJECT_TEAM_TABLES
    .map((t) => `SELECT project_id FROM ${t} WHERE project_id IN ($1)`)
    .join(' UNION ');
  const { rows } = await db.query(sql, [ids]);
  return new Set(rows.map((r) => r.project_id));
}

async function projectHasReviewTeam(projectId) {
  if (!projectId) return false;
  return (await projectsWithReviewTeam([projectId])).has(projectId);
}

// Did this person hand in the work that is now waiting to be reviewed?
//
// The self-review guard's second half. Submitting is assignee-only — the state
// machine says so in as many words — so on today's rules this can only be true
// when the assignee check above is true as well, and it costs nothing. It is
// here because the broadened gate makes the case reachable the moment those two
// come apart: submit, be handed the asset to somebody else, then approve the
// version you uploaded yourself. Whoever loosens submitting will not think to
// come back and add this.
async function submittedCurrentVersion(user, asset) {
  if (!user || !asset) return false;
  const { rows } = await db.query(
    `SELECT uploaded_by FROM asset_versions
      WHERE asset_id = $1 ORDER BY version_number DESC LIMIT 1`,
    [asset.id]
  );
  return Boolean(rows.length && rows[0].uploaded_by && rows[0].uploaded_by === user.id);
}

// Is this user a contributor the asset is actually assigned to?
function isAssignedArtist(user, asset) {
  const def = roleDef(user.role);
  return Boolean(def && def.assignable && asset.assignee_id === user.id);
}

/* May this user act at the first review gate on this asset?
 *
 * Three questions, in this order, and the order is the whole rule:
 *
 *   1. do they hold review.tl                  the Settings switch
 *   2. is it their own work                    the self-review guard
 *   3. are they on this project's team         who the gate belongs to
 *
 * (1) stays where it was. Broadening WHO reaches the gate is not a reason to
 * stop asking whether a Super Admin has turned the gate off for their
 * designation, and every qualifying designation gets review.tl by default —
 * src/role-permissions.js grants it to exactly the roles the project form
 * offers for these three lists.
 *
 * (2) is unconditional and comes before anything that could grant access, so
 * no route below can talk its way past it. It matters more now than it did:
 * a lead can be handed work, and a lead is also the sort of person who is on
 * the project's team, so the two halves meet in one account far more often
 * under this rule than under the old one.
 *
 * (3) is the change. See PROJECT_TEAM_TABLES above.
 */
async function canActAtTlGate(user, asset) {
  if (!asset) return false;

  /* ---------------------------------------------------------------------
   * review.tl, OR BEING THE ACTING LEAD OF THIS PROJECT.
   *
   * THE ONE PLACE THIS FEATURE HAD TO CHANGE SOMETHING REAL, so it is written
   * out rather than folded into the union below.
   *
   * review.tl is a ROLE-LEVEL key. Until now, failing it ended the question
   * before any project was consulted — which is right, because every list that
   * could put somebody at this gate was already filtered to designations that
   * hold it. The acting list is not: it offers every active user, because the
   * point of a stand-in is that it can be whoever can do the job this
   * fortnight. A senior artist named Acting Team Lead who was then refused here
   * would be a section that records a decision and does not act on it.
   *
   * SO THE GRANT IS PROJECT-SCOPED AND NOTHING ELSE. It is not a permission:
   * it does not appear in the person's effective list, /auth/me is byte-for-byte
   * what it was, their designation is untouched, and it reaches exactly the one
   * project they were named on. On every other project — and on every other
   * gate — they are the artist they were this morning. A test compares their
   * whole permission set against another artist's and asserts they are equal.
   *
   * ASKED OF THE ACTING TABLE ALONE, not of the four-table union: the other
   * three lists are already role-filtered where they are written, so letting
   * membership of one of them stand in for review.tl would widen a gate nobody
   * asked to widen. */
  if (!holds(user, 'review.tl')) {
    const via = await leadTablesFor(user.id, asset.project_id);
    if (!via.includes(ACTING_TABLE)) return false;
  }

  /* NOBODY REVIEWS THEIR OWN WORK, whatever their designation and whoever they
   * are on the project.
   *
   * A no-op until leads became assignable — a lead could not be an assignee, so
   * this was never true — and load-bearing the moment they did. It is what
   * makes `assignable` and `leadsTeam` safe to hold at once; tests/roles.test.js
   * used to forbid the combination outright and now points here instead. */
  if (asset.assignee_id && asset.assignee_id === user.id) return false;
  if (await submittedCurrentVersion(user, asset)) return false;

  /* Full access reaches every gate in the studio, staffed or not. Without this
     a Super Admin could be locked out of a project nobody put them on — and
     unblocking work that has stalled is most of what the tier is for. */
  if (hasFullAccess(user)) return true;

  /* The project has a team: that team is the gate, and nobody else is. A lead
     who is this artist's personal lead but is NOT on this project gets nothing
     from that fact — which is the point of the change. */
  if (await projectHasReviewTeam(asset.project_id)) {
    return onProjectReviewTeam(user, asset.project_id);
  }

  /* No team named on the project. Falls back to what this did before, so
     projects staffed the old way — every project that predates this — carry on
     working rather than jamming at the first gate.
     
     Two steps, as before: the assignee's own lead, and failing that any lead
     who can see the work. The second exists because an assignee who reports to
     nobody left the gate with no one behind it, and the review flow simply
     stopped with nothing on screen saying why. */
  const def = roleDef(user.role);
  if (!def || !def.leadsTeam) return canViewAsset(user, asset);
  if (asset.assignee_id && await isReport(user, asset.assignee_id)) return true;
  const { rows } = await db.query(
    'SELECT reports_to_id, team_lead_id FROM users WHERE id = $1', [asset.assignee_id]
  );
  const lead = rows[0] && (rows[0].reports_to_id || rows[0].team_lead_id);
  if (lead) return false;
  return canViewAsset(user, asset);
}

/* WHICH authority got somebody through the first gate — for the history, not for the
 * decision. canActAtTlGate above answers whether they may act; this answers what on.
 *
 * Deliberately next to it and deriving from the same predicates, rather than the caller
 * re-deciding: two copies of "was this the team or an override" would drift, and the one
 * in the history would be the one nobody noticed had gone wrong.
 *
 * Returns null when they may not act at all, so a caller cannot mistake a refusal for a
 * route. 'full_access_override' only when full access is the ONLY thing that let them in:
 * a Super Admin who is also on the project's review team acted as a member of it, and
 * tagging that as an override would overstate what happened.
 */
async function tlGateAuthority(user, asset) {
  if (!(await canActAtTlGate(user, asset))) return null;

  /* ACTING TEAM LEAD, AND ONLY WHEN NOTHING ELSE PUT THEM THERE.
   *
   * The record says in what capacity somebody acted, so the label has to be the
   * capacity that actually applied. Somebody who is on the acting list AND is a
   * Team Lead, a coordinator or supervision on the same project did not act as
   * a stand-in — they would have passed this gate without the acting row — so
   * they keep the label they had. Only the person whose sole qualification is
   * the acting list is recorded as one.
   *
   * ASKED BEFORE THE FULL-ACCESS BRANCH, because a Super Admin who was also
   * named Acting TL on the project acted as a member of its team, and the
   * existing code already makes exactly that distinction one line further
   * down. */
  const via = await leadTablesFor(user.id, asset.project_id);
  if (via.length === 1 && via[0] === ACTING_TABLE) return 'acting_team_lead';

  if (!hasFullAccess(user)) return 'team_lead';
  if (await projectHasReviewTeam(asset.project_id)) {
    // AWAITED. Without it this is a Promise, which is always truthy, so every
    // full-access action was recorded as the team's — the exact confusion the column
    // exists to prevent, and invisible except to a test that checks the value.
    return (await onProjectReviewTeam(user, asset.project_id)) ? 'team_lead' : 'full_access_override';
  }
  /* No team named on the project. Full access is then indistinguishable from the
     fallback path any lead who can see the work would have taken, so it is reported as
     the override — which is the honest reading: nothing about this project put them
     there. */
  return 'full_access_override';
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

/* Who may hand a freelancer's finished work back into the studio.
 *
 * THE SAME SHAPE AS canMarkDelivered ABOVE, and that is the point: a permission
 * says what somebody may do, their designation says how much of the studio they
 * may do it to. outsource.deliver opens the action; projectScope decides the
 * range, so a lead granted it delivers the outsourced work on their own
 * projects and not the studio's.
 *
 * A DIFFERENT KEY from review.deliver, because it is a different act. That one
 * says the client has the work; this one says a freelancer has handed it back
 * and the studio must now review it. Reusing the key would have meant granting
 * one to grant the other.
 */
async function canDeliverOutsourced(user, asset) {
  if (!holds(user, 'outsource.deliver')) return false;
  const def = roleDef(user.role);
  if (def && def.projectScope === 'all') return true;
  return canAccessProject(user, asset.project_id);
}

/* Who may undo a recorded stage on outsourced work.
 *
 * SAME SHAPE AS canDeliverOutsourced, DIFFERENT KEY — the permission opens the
 * action, the designation's projectScope decides the range. The key is narrower
 * by default (see the catalogue): recording that a freelancer finished is
 * bookkeeping, taking a delivery back out of a team lead's review queue is not.
 */
async function canReopenOutsourced(user, asset) {
  if (!holds(user, 'outsource.reopen')) return false;
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
  canAssignAnyAsset,
  mayAssign,
  canHandOverInReview,
  canManageTasks,
  isAwaitingRework,
  REWORK_STATUSES,
  visibleProjects,
  reachesProject,
  canAccessProject,
  canViewAsset,
  canEditAsset,
  canDeleteAsset,
  canCreateAsset,
  canCreateProject,
  canManageUsers,
  isAssignedArtist,
  canActAtTlGate,
  canHoldAsset,
  canHoldOthersWork,
  holdFactsFor,
  holdOthersRoles,
  assetOnDashboard,
  dashboardProjects,
  tlGateAuthority,
  onProjectReviewTeam,
  PROJECT_TEAM_TABLES, PROJECT_LEAD_TABLES, ACTING_TABLE,
  seesWholeProject,
  projectTeamIdsFor,
  projectLeadIds, isProjectLead, leadTablesFor,
  reviewTeamProjects,
  projectHasReviewTeam,
  projectsWithReviewTeam,
  canReviewAsCD,
  canOverrideReview,
  canMarkDelivered,
  canDeliverOutsourced,
  canReopenOutsourced,
  isReport,
  // Re-exported as functions rather than arrays: roles are managed in Settings
  // now, so a value captured at import time would go stale the moment one
  // is added.
  assignableRoles,
  leadRoles,
};
