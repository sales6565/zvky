/* WHO MAY CHANGE A PROJECT. ONE RULE, ONE COPY, THREE CAPABILITIES.
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO CLOSE: A PERMISSION THAT DID NOTHING.
 *
 * An owner switched Project Edit on for a designation in Settings > Role
 * Permissions. The screen said the role held it. /auth/me returned it. The
 * Edit option never appeared, and the API answered 403 "You can only edit
 * projects you created".
 *
 * Both halves — the page and the route — were applying the same two conditions:
 *
 *     can('project.edit')  AND  (projectScope === 'all' OR owner_id === me)
 *
 * The first is the permission. The second is a ROLE TIER, which no checkbox in
 * Settings can move. So for every designation an owner would actually grant
 * this to — producer, project manager, coordinator, team lead, all of them
 * scoped narrower than the studio and none of them able to create a project, so
 * never the owner of one — the second condition was false for every project in
 * existence, and the grant was inert. See the long note on reachesProject() in
 * src/permissions.js for why that stayed invisible to the people who built it.
 *
 * This is the third time this exact shape has been found in this application:
 * the page asked caps() (the TIER) about something Settings decides with a
 * PERMISSION. UI_GATES in public/index.html was written for the first two. This
 * module is for the half UI_GATES cannot express — the ones that depend on
 * WHICH project, not just whether the person may edit projects at all.
 *
 * ===========================================================================
 * THE RULE.
 *
 *     may change this project  =  the role holds this capability's key
 *                             AND the project is one the role can see
 *
 * Both halves, every time, for every control and every route. "Can see" is
 * reachesProject() in src/permissions.js, which is visibleProjects() plus the
 * owner, and it is the SAME function on both sides of the wire: the server
 * guards with it, and the server also stamps its answer onto every project row
 * it sends the browser, as `inReach`. So the page is not re-deriving scope from
 * a tier — it is reading the server's own answer, from the server's own
 * function. The page and the route cannot disagree about scope, because there
 * is only one computation of it.
 *
 * NOTHING HERE WIDENS SCOPE. A role still reaches only what it could already
 * see. What changes is that holding the key now matters.
 *
 * ===========================================================================
 * WHY THE SIGNATURE IS (access, project) AND NOT (user, project).
 *
 * The decision has to be IDENTICAL in two places that cannot ask the same
 * questions. The server has a user row and a database; the browser has a
 * permission list and a project payload, and no way to run a query
 * synchronously. So the two facts are passed in and the rule is one function:
 *
 *     access.holds(key)       whether this account holds that permission
 *     access.reaches(project) whether that project is within reach
 *
 * On the server: holds reads req.permissions (the effective set, role plus
 * every role group); reaches is reachesProject(), awaited before the call so
 * the rule itself stays synchronous and therefore mirrorable.
 * On the page: holds is can(); reaches reads the `inReach` the server stamped.
 *
 * ===========================================================================
 * THE MIRROR IS NOT A CONVENTION, IT IS A TEST.
 *
 * Everything between the two MIRROR markers below is copied into
 * public/index.html verbatim, and tests/project-authority.test.js cuts both
 * copies out and compares them CHARACTER FOR CHARACTER. A change to the rule
 * that is not made in both places fails the suite. That is the only thing
 * standing between this and the next copy of the rule drifting.
 */
const { roleDef } = require('./roles');
const catalog = require('./permission-catalog');

/* ONE KEY PER CAPABILITY, NAMED ONCE. These are the strings the catalogue
   defines, the strings requirePermission() guards the routes with, and the
   strings can() asks about on the page. A key-name typo here is a permission
   that can never be held, so the names come from this object everywhere and
   tests/project-authority.test.js asserts every one of them is in the
   catalogue. */
const KEYS = {
  edit: 'project.edit',
  delete: 'project.delete',
  close: 'project.close',
};

/* ===== MIRROR START — copied verbatim into public/index.html ===== */
const PROJECT_DENIED_NO_PROJECT = 'there is no project to act on';
const PROJECT_DENIED_NO_KEY = 'the role does not hold ';
const PROJECT_DENIED_OUT_OF_SCOPE = 'the project is not one this role can see';
const PROJECT_ALLOWED = 'the role holds the permission and can see this project';

function projectVerdict(key, access, project) {
  if (!project) return { ok: false, code: 'no_project', reason: PROJECT_DENIED_NO_PROJECT };
  if (!access || !access.holds(key)) {
    return { ok: false, code: 'no_key', reason: PROJECT_DENIED_NO_KEY + key };
  }
  if (!access.reaches(project)) {
    return { ok: false, code: 'out_of_scope', reason: PROJECT_DENIED_OUT_OF_SCOPE };
  }
  return { ok: true, code: 'allowed', reason: PROJECT_ALLOWED };
}

function canEditProject(access, project) { return projectVerdict('project.edit', access, project); }
function canDeleteProject(access, project) { return projectVerdict('project.delete', access, project); }
function canCloseProject(access, project) { return projectVerdict('project.close', access, project); }
/* ===== MIRROR END ===== */

/* EVERY CONTROL THIS RULE DECIDES, IN ONE TABLE.
 *
 * The inventory the bug report needed and nobody had: for each control, the
 * capability it needs, the function that decides it, the page gate or button
 * that offers it, and the route that performs it. scripts/role-can.js prints a
 * verdict per row for a named role, and tests/project-authority.test.js walks
 * it to assert that every route listed really is guarded by the key named here
 * — so a route added without its guard, or guarded with a different key, fails
 * the suite rather than shipping as a second rule. */
const CONTROLS = [
  {
    id: 'edit',
    control: 'The pencil beside the project name (Edit project)',
    key: KEYS.edit,
    decide: canEditProject,
    pageGate: 'editProjectBtn',
    routes: ['PATCH /api/projects/:id'],
  },
  {
    id: 'archive',
    control: 'Archive, on a project row in the Projects tab',
    key: KEYS.delete,
    decide: canDeleteProject,
    pageGate: '.projArchiveBtn',
    routes: ['DELETE /api/projects/:id'],
  },
  {
    id: 'purge',
    control: 'Delete permanently, on an archived project holding nothing',
    key: KEYS.delete,
    decide: canDeleteProject,
    pageGate: '.projPurgeBtn',
    routes: ['DELETE /api/projects/:id'],
  },
  {
    id: 'restore',
    control: 'Restore, on an archived project row',
    key: KEYS.delete,
    decide: canDeleteProject,
    pageGate: '.projRestoreBtn',
    routes: ['POST /api/projects/:id/restore'],
  },
  {
    id: 'close',
    control: 'Close, on a project row in the Projects tab',
    key: KEYS.close,
    decide: canCloseProject,
    pageGate: '.projCloseBtn',
    routes: ['POST /api/projects/:id/close'],
  },
  {
    id: 'reopen',
    control: 'Reopen, on a closed project row',
    key: KEYS.close,
    decide: canCloseProject,
    pageGate: '.projReopenBtn',
    routes: ['POST /api/projects/:id/reopen'],
  },
];

/* THE REFUSAL THE CALLER READS, and it says which of the two halves failed.
 *
 * The old message was "You can only edit projects you created", which was a
 * true description of the broken rule and is a lie about this one. Telling the
 * two causes apart matters: "you do not hold this permission" is something an
 * owner fixes in Settings, and "this project is not yours to change" is not.
 *
 * `verb` is the one word the sentence needs — edit, archive, close — so one
 * function covers all six controls without six copies of a sentence. */
function refusal(verdict, verb) {
  if (verdict.code === 'no_key') {
    return `You do not have permission to ${verb} a project.`;
  }
  return `You can only ${verb} projects you can see.`;
}

/* WHAT THE SETTINGS SCREEN SAYS ABOUT THE SCOPE HALF.
 *
 * Re-exported from the catalogue rather than written out again here: one
 * sentence, appended to all three of these keys' descriptions, so the roles
 * screen cannot promise more reach than the rule gives — which is the other
 * direction this bug gets reported from.
 * tests/project-authority.test.js asserts every key in KEYS carries it. */
const SCOPE_NOTE = catalog.PROJECT_SCOPE_NOTE;

/* THE SERVER'S HALF OF `access`, built once per request.
 *
 * `reach` is awaited by the caller and closed over, which is what keeps
 * projectVerdict() synchronous and therefore identical to the page's copy.
 * `holds` reads the EFFECTIVE set — the role's own permissions plus every role
 * group's, unioned by rolePermissions.effectiveFor and attached by
 * authenticate() — so a key granted only through a group counts, which is one
 * of the two ways the bug was reported. */
function accessFor(req, reach) {
  const held = req.permissions || new Set();
  return {
    holds: (key) => held.has(key),
    reaches: () => reach,
  };
}

/* SUPER ADMIN ALWAYS MAY, and it falls out rather than being bolted on:
 * effectiveFor() short-circuits that tier to the whole catalogue, so holds() is
 * true for every key, and its projectScope is 'all', so reaches() is true for
 * every project. This function exists so the claim is testable in one call
 * rather than inferred. */
function isSuperAdmin(roleKey) {
  const def = roleDef(roleKey);
  return Boolean(def && def.tier === 'super_admin');
}

module.exports = {
  KEYS,
  CONTROLS,
  SCOPE_NOTE,
  projectVerdict,
  canEditProject,
  canDeleteProject,
  canCloseProject,
  refusal,
  accessFor,
  isSuperAdmin,
};
