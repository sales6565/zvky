// The review pipeline as a state machine.
//
// Every move an asset can make is declared here as a transition: what it moves
// from, what it moves to, who is allowed to make it, and who the asset then
// sits with. The routes do not decide any of that — they ask this module and
// apply the answer. Keeping it in one table is what makes the pipeline
// checkable: the states below are the whole of it, and anything not listed
// cannot happen.
//
//   Not Assigned -> Assigned -> In Progress -> TL Review -> Approved for Client -> Delivered
//                       |            ^             |  \
//                  (accept starts    |             |   +-> TL Feedbacks -> (assignee reworks)
//                   the clock)       |             +-> CD Review -> CD Changes -> (TL relays)
//
// Assigned and In Progress are separated by the assignee's own act: assignment
// puts work on their desk, Accept and Start is them picking it up — and it is
// the moment the time tracking begins. Assignment used to move an asset
// straight to In Progress; that rule is gone.
//
// `status` says where in the pipeline the asset is. `routed_to_id` says whose
// desk it is on, which is not the same thing: CD Changes sits with the team
// lead until they relay it, and with the assignee afterwards, without the
// status changing. Deriving that from status alone was not possible, which is
// why it is stored.

const { roleDef } = require('./roles');

// The nine states, in pipeline order. Labels and colours match the dashboard.
const STATES = [
  { id: 'not_started', label: 'Not Assigned', color: 'var(--not)' },
  { id: 'assigned', label: 'Assigned', color: '#5b8def' },
  { id: 'in_progress', label: 'In Progress', color: 'var(--prog)' },
  { id: 'pending_tl_review', label: 'TL Review', color: 'var(--review)' },
  { id: 'tl_changes_requested', label: 'TL Feedbacks', color: '#e8402c' },
  { id: 'pending_cd_review', label: 'CD Review', color: '#9b7ef0' },
  { id: 'cd_changes_requested', label: 'CD Changes', color: '#e8402c' },
  { id: 'approved_for_client', label: 'Approved for Client', color: 'var(--approved)' },
  { id: 'delivered', label: 'Delivered', color: 'var(--final)' },
];

const STATE_IDS = STATES.map((s) => s.id);
const label = (id) => (STATES.find((s) => s.id === id) || {}).label || id;

// Where a re-submission lands after the Creative Director asked for changes.
//
// 'tl' — back to the team lead, who relayed the request and re-checks the work
//        before it reaches the CD again. The default, and the studio's stated
//        preference.
// 'cd' — straight back to the CD, skipping the lead.
//
// One environment variable because this is the kind of thing a studio changes
// its mind about; both values are real states of the same machine rather than
// one being a special case bolted on.
function cdChangesReentry() {
  return String(process.env.CD_CHANGES_REENTRY || 'tl').toLowerCase() === 'cd' ? 'cd' : 'tl';
}

// --- who may do what ---------------------------------------------------------
// Predicates take the same context every transition gets. They answer only the
// role question; whether the move is legal from the current status is the
// table's job.

// Statuses that belong to the assignee by definition. An unrouted asset in one
// of these is theirs; an unrouted asset anywhere else is sitting in a review
// queue and is not.
//
// This distinction is the whole of the CD Changes relay. That state is routed
// to nobody until the lead passes it on, and without the list below "routed to
// nobody" reads as "routed to anybody" — which let the assignee resubmit
// straight past the lead who was supposed to brief them.
const ASSIGNEE_STATUSES = ['not_started', 'assigned', 'in_progress', 'tl_changes_requested'];

// The statuses a status may be dragged between on the dashboard, in either
// direction, without going through a review action. Everything past In Progress
// is a review decision and has its own action.
//
// It lives here because two places have to agree on it — the PATCH route and
// the dashboard's drag handler — and when they drifted apart (the frontend list
// was not updated when 'assigned' was added) the Assigned column became a place
// no card could be dragged into. The frontend copy is checked against this one
// by a test.
const FREE_STATUSES = ['not_started', 'assigned', 'in_progress'];

const actors = {
  // The person the asset is assigned to, and only while it is on their desk.
  assignee: (ctx) => {
    const def = roleDef(ctx.user.role);
    if (!def || !def.assignable) return false;
    if (ctx.asset.assignee_id !== ctx.user.id) return false;
    if (ctx.asset.routed_to_id === ctx.user.id) return true;
    // Unrouted: theirs only if the status is one of their own. Rows written
    // before routing existed have no routing, so this keeps them working.
    return ctx.asset.routed_to_id == null && ASSIGNEE_STATUSES.includes(ctx.asset.status);
  },
  // The lead or supervisor of whoever the asset is assigned to.
  teamLead: (ctx) => ctx.isTeamLead || ctx.canOverride,
  // The Creative Director gate.
  //
  // Reads the role's permission, not its tier. Reading the tier was the same
  // mistake the screens were making: switching review.cd off for a role left
  // the tier's reviewStage untouched, so the permission did nothing.
  creativeDirector: (ctx) => Boolean(ctx.canReviewCd || ctx.canOverride),
  // Signing work off for the client — the half of that gate that cannot be
  // taken back. Held separately, so a role can review without signing off.
  clientApprover: (ctx) => Boolean((ctx.canReviewCd && ctx.canApproveForClient) || ctx.canOverride),
  // Anyone who may set up work on the asset: assign it, or edit it.
  //
  // Both halves, and the second one used to be missing. Assigning is its own
  // permission — a role can hold asset.assign without asset.edit, which is a
  // perfectly ordinary split — but this read canEdit alone. So for such a role
  // the assign transition was refused while the assignee was written anyway,
  // and the asset sat in Not Assigned wearing the avatar of the person it had
  // just been given to. The comment above was already right; the code was not.
  planner: (ctx) => Boolean(ctx.canAssign || ctx.canEdit),
  // Handing SUBMITTED work to somebody else. A wider reach than planner, on
  // purpose: the asset is in a reviewer's queue, so the reviewer holding it may
  // hand it on as well as the person who added it. The route works this out
  // (canHandOverInReview) and hands the answer in, the same way canAssign and
  // canEdit arrive.
  handOver: (ctx) => Boolean(ctx.canHandOver),
  // Whoever signs off that the client has it.
  deliverer: (ctx) => ctx.canDeliver,
};

// Where the asset sits after a transition. Returning a function rather than an
// id because most of these are "the assignee", which the asset itself knows.
const routes = {
  assignee: (ctx) => ctx.asset.assignee_id || null,
  // Nobody in particular: a review queue, picked up by whoever holds that gate.
  reviewQueue: () => null,
  actor: (ctx) => ctx.user.id,
};

// --- the transition table ----------------------------------------------------
// The whole pipeline. Anything absent from this list is not a legal move.

const TRANSITIONS = [
  {
    action: 'assign',
    from: ['not_started'],
    to: 'assigned',
    who: 'planner',
    routeTo: 'assignee',
    // Assignment puts the work on somebody's desk. It no longer starts it —
    // that is the assignee's own act (accept, below), because the clock starts
    // with it and a clock should not be started by somebody else's click.
    describe: 'Assigned',
  },
  {
    // Handing submitted work to somebody else.
    //
    // Distinct from the rework reassignment below it, and deliberately so. That
    // one moves an asset that is already back with the artist and leaves its
    // status alone. This one takes work that has been SUBMITTED and is sitting
    // in a reviewer's queue, and gives it to a different person — who has not
    // done any of it. So it goes back to Assigned rather than staying in
    // review: the new person has to pick it up and do the work before anybody
    // reviews anything.
    //
    // What the outgoing person did is not touched. Their submission stays in
    // asset_versions, their hours stay on their assignment record, and both
    // stay in the asset's history.
    action: 'reassign_review',
    /* All four stages where an asset is in somebody's hands and can be put in
       somebody else's: the two review queues, and the two rework stages.

       The rework stages used to reassign through a branch of their own that
       left the status where it was, so the incoming person inherited a stage
       mid-flight with no way to start their own round. They land here now, on
       the one path that was already built and debugged for review handover:
       back to Assigned, a new episode, their own clock from nothing. */
    from: ['pending_tl_review', 'pending_cd_review',
           'tl_changes_requested', 'cd_changes_requested'],
    to: 'assigned',
    who: 'handOver',
    routeTo: 'assignee',
    describe: 'Reassigned while in review',
  },
  {
    // The assignee picks the work up. This is what moves it to In Progress,
    // and it is the moment the time tracking starts a session.
    action: 'accept',
    from: ['assigned'],
    to: 'in_progress',
    who: 'assignee',
    routeTo: 'assignee',
    describe: 'Accepted — work started',
  },
  {
    action: 'submit',
    // 'assigned' is deliberately NOT in this list. Work has to be started
    // before it can be handed in: an asset sitting in Assigned is one nobody
    // has picked up, and a submission from there records a round that nobody
    // ever worked. Accept and Start is the act that moves it to In Progress,
    // and it is one click.
    //
    // This reverses the earlier shortcut, which allowed it on the reasoning
    // that refusing would block work done before the timer existed. Those
    // assets are long since through the pipeline; the shortcut was only being
    // used to skip the clock.
    //
    // The rework states stay: after a change request the work is already
    // underway, there is no accept step to take, and requiring one would strand
    // every round after the first.
    from: ['not_started', 'in_progress', 'tl_changes_requested'],
    to: 'pending_tl_review',
    who: 'assignee',
    routeTo: 'reviewQueue',
    describe: 'Submitted for team lead review',
  },
  {
    // The same submission, after the CD asked for changes. Where it lands is
    // configurable; both destinations are ordinary states of this machine.
    action: 'submit',
    from: ['cd_changes_requested'],
    to: () => (cdChangesReentry() === 'cd' ? 'pending_cd_review' : 'pending_tl_review'),
    who: 'assignee',
    routeTo: 'reviewQueue',
    describe: () =>
      cdChangesReentry() === 'cd'
        ? 'Resubmitted straight to the Creative Director'
        : 'Resubmitted for team lead review',
  },
  {
    action: 'tl_approve',
    from: ['pending_tl_review'],
    to: 'pending_cd_review',
    who: 'teamLead',
    routeTo: 'reviewQueue',
    describe: 'Team lead approved, sent to the Creative Director',
  },
  {
    action: 'tl_request_changes',
    from: ['pending_tl_review'],
    to: 'tl_changes_requested',
    who: 'teamLead',
    routeTo: 'assignee',
    requiresNote: true,
    describe: 'Team lead requested changes',
  },
  {
    action: 'cd_approve',
    from: ['pending_cd_review'],
    to: 'approved_for_client',
    who: 'clientApprover',
    routeTo: 'reviewQueue',
    describe: 'Creative Director approved for client',
  },
  {
    // Goes to the lead, not to the assignee: the lead relays it, so the person
    // who signed the work off is the one who explains what changed.
    action: 'cd_request_changes',
    from: ['pending_cd_review'],
    to: 'cd_changes_requested',
    who: 'creativeDirector',
    routeTo: 'reviewQueue',
    requiresNote: true,
    describe: 'Creative Director requested changes, sent to the team lead',
  },
  {
    // The relay. Status does not move — only whose desk it is on.
    action: 'relay',
    from: ['cd_changes_requested'],
    to: 'cd_changes_requested',
    who: 'teamLead',
    routeTo: 'assignee',
    describe: 'Team lead passed the Creative Director\'s notes to the assignee',
  },
  {
    action: 'deliver',
    from: ['approved_for_client'],
    to: 'delivered',
    who: 'deliverer',
    routeTo: 'reviewQueue',
    describe: 'Delivered to the client',
  },
];

function resolve(value, ctx) {
  return typeof value === 'function' ? value(ctx) : value;
}

// Find the transition for this action from this status, if there is one.
function find(action, status) {
  return TRANSITIONS.find((t) => t.action === action && t.from.includes(status)) || null;
}

// Everything this user could do to this asset right now. The UI renders from
// this rather than keeping its own copy of the rules.
function availableActions(ctx) {
  return TRANSITIONS
    .filter((t) => t.from.includes(ctx.asset.status) && actors[t.who](ctx))
    .map((t) => ({
      action: t.action,
      to: resolve(t.to, ctx),
      toLabel: label(resolve(t.to, ctx)),
      requiresNote: Boolean(t.requiresNote),
    }));
}

// May this move be made, and what does it produce?
//
// Returns { ok, to, routedTo, describe } or { ok: false, status, error }. The
// status codes distinguish "not allowed" from "not legal from here", because
// they mean different things to whoever is looking at the screen.
function evaluate(action, ctx, { note } = {}) {
  const current = ctx.asset.status;

  const transition = find(action, current);
  if (!transition) {
    // Is the action real but the status wrong, or is the action nonsense?
    const knownAction = TRANSITIONS.some((t) => t.action === action);
    if (!knownAction) return { ok: false, status: 400, error: `Unknown action "${action}".` };
    // Read as a sentence. Most action names work verbatim; the ones that do not
    // say so here rather than producing "cannot be reassign review".
    // The one refusal a person meets in normal use, so it says what to do
    // rather than what went wrong. Only from Assigned: from anywhere else,
    // "cannot be submitted" is already the whole story.
    if (action === 'submit' && current === 'assigned') {
      return {
        ok: false,
        status: 409,
        field: 'status',
        error: 'Start the work before submitting it — click Accept and Start.',
      };
    }
    const PHRASE = {
      submit: 'submitted',
      reassign_review: 'handed to somebody else — that is only possible while it is waiting on a reviewer or waiting on changes',
      tl_approve: 'approved by a team lead',
      cd_approve: 'approved by the director',
      tl_request_changes: 'sent back by a team lead',
      cd_request_changes: 'sent back by the director',
    };
    return {
      ok: false,
      status: 409,
      error: `An asset in "${label(current)}" cannot be ${PHRASE[action] || action.replace(/_/g, ' ')}.`,
    };
  }

  if (!actors[transition.who](ctx)) {
    return { ok: false, status: 403, error: refusal(transition, ctx) };
  }

  if (transition.requiresNote && !String(note || '').trim()) {
    return { ok: false, status: 400, field: 'note', error: 'Say what needs to change.' };
  }

  return {
    ok: true,
    to: resolve(transition.to, ctx),
    routedTo: routes[transition.routeTo](ctx),
    describe: resolve(transition.describe, ctx),
    action,
  };
}

// Why someone was turned away, in terms of the pipeline rather than of code.
function refusal(transition, ctx) {
  switch (transition.who) {
    case 'assignee':
      if (ctx.asset.assignee_id !== ctx.user.id) return 'Only the person this asset is assigned to can submit it.';
      if (ctx.asset.status === 'cd_changes_requested') {
        return 'The team lead has not passed the Creative Director\'s notes on yet.';
      }
      if (ctx.asset.routed_to_id && ctx.asset.routed_to_id !== ctx.user.id) {
        return 'This asset is with somebody else right now.';
      }
      return 'Only the assigned artist can submit this asset.';
    case 'teamLead':
      return 'Only this artist\'s team lead can act on it at this stage.';
    case 'clientApprover':
    case 'creativeDirector':
      return 'Only the Creative Director can act on it at this stage.';
    case 'deliverer':
      return 'You cannot mark this asset as delivered.';
    case 'handOver':
      return 'Handing submitted work on is for the person who added the asset or the reviewer holding it.';
    default:
      return 'You cannot do that to this asset.';
  }
}

// One transition by name. So a route can ask "which statuses does this move
// accept" rather than keeping its own copy of the answer, which is how the two
// drift apart.
function transitionFor(action) {
  const found = TRANSITIONS.find((t) => t.action === action);
  if (!found) throw new Error(`No such transition: ${action}`);
  return found;
}

module.exports = {
  STATES,
  transitionFor,
  ASSIGNEE_STATUSES,
  FREE_STATUSES,
  STATE_IDS,
  TRANSITIONS,
  label,
  evaluate,
  availableActions,
  cdChangesReentry,
};
