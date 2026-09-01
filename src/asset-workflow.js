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
//                       |            ^             |  \        ^
//                  (accept starts    |             |   +-> TL Feedbacks -> (assignee reworks)
//                   the clock)       |             +-> CD Review -> CD Feedbacks -> (TL relays)
//                                    |             |
//                                    |             +-> "Send to Client" ---+
//                                    |                  (skips the CD gate;
//                                    |                   its own permission)
//
// Approved for Client is reachable two ways: the ordinary route through the
// Creative Director, and a team lead with review.tl_send_client skipping that
// gate. Same destination, two different actions in the history, so the two are
// told apart afterwards.
//
// Assigned and In Progress are separated by the assignee's own act: assignment
// puts work on their desk, Accept and Start is them picking it up — and it is
// the moment the time tracking begins. Assignment used to move an asset
// straight to In Progress; that rule is gone.
//
// `status` says where in the pipeline the asset is. `routed_to_id` says whose
// desk it is on, which is not the same thing: CD Feedbacks sits with the team
// lead until they relay it, and with the assignee afterwards, without the
// status changing. Deriving that from status alone was not possible, which is
// why it is stored.

const { roleDef } = require('./roles');

// The ten states, in pipeline order. Labels and colours match the dashboard.
const STATES = [
  { id: 'not_started', label: 'Not Assigned', color: 'var(--not)' },
  { id: 'assigned', label: 'Assigned', color: '#5b8def' },
  { id: 'in_progress', label: 'In Progress', color: 'var(--prog)' },
  { id: 'pending_tl_review', label: 'TL Review', color: 'var(--review)' },
  { id: 'tl_changes_requested', label: 'TL Feedbacks', color: '#e8402c' },
  { id: 'pending_cd_review', label: 'CD Review', color: '#9b7ef0' },
  { id: 'cd_changes_requested', label: 'CD Feedbacks', color: '#e8402c' },
  { id: 'approved_for_client', label: 'Approved for Client', color: 'var(--approved)' },
  /* Sent out and waiting on the client's word. Its own colour, and deliberately
     not the brand red: a status colour says where work is, and reusing the
     brand for one of them would make that state look like the application
     rather than like a stage. Teal, so it reads as "waiting on somebody
     outside" beside the green of approved and the lime of delivered. */
  { id: 'awaiting_client_feedback', label: 'Awaiting Client Feedback', color: 'var(--client)' },
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
// This distinction is the whole of the CD Feedbacks relay. That state is routed
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
  /* The lead who may skip the Creative Director entirely.
   *
   * Both halves are required, and that is the whole point of the split: the
   * standing to act at the TL gate at all (isTeamLead, which already asks for
   * review.tl), AND the separate authority to walk around the CD gate rather
   * than pass work through it. A lead with review.tl and not this one reviews
   * exactly as before and never sees the button. */
  tlClientSender: (ctx) => Boolean(ctx.canSendToClient && (ctx.isTeamLead || ctx.canOverride)),
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
  /* The client's round, gated by three separate permissions rather than one.
     Split because they are three different decisions: putting work in front of
     a client, accepting their yes, and passing their no back into the studio.
     A studio may well want the same people doing all three — but that is for it
     to say in Settings, not for this to assume. */
  clientSender:    (ctx) => Boolean(ctx.canSendForClientFeedback),
  clientDeliverer: (ctx) => Boolean(ctx.canDeliverFromClient),
  clientReturner:  (ctx) => Boolean(ctx.canReturnFromClient),
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
    /* The Creative Director skipped.
     *
     * Deliberately its own action rather than a variant of tl_approve, because
     * the action id is what asset_events stores — so "how often does a lead go
     * straight to the client" is a question the history can answer for work
     * already done, rather than one that needs a new column added later. It
     * lands in the same Approved for Client state the CD route reaches, so the
     * dashboard, the stats bar and the Delivered flow need to know nothing
     * about it.
     *
     * There is no route back into CD Review from here. That is the point of the
     * action: the asset is past the gate, and a studio that wanted it reviewed
     * after all can send it back through the ordinary path by reassigning it. */
    action: 'tl_send_to_client',
    from: ['pending_tl_review'],
    to: 'approved_for_client',
    who: 'tlClientSender',
    routeTo: 'reviewQueue',
    describe: 'Team lead sent straight to the client, skipping Creative Director review',
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
  /* --- the client's own round ---------------------------------------------
   *
   * Approved for Client means the studio is happy with it. What follows is the
   * client looking at it, which is a wait rather than a review: nobody inside
   * the studio is holding it, and the answer comes back as either "fine" or
   * "change this".
   *
   * Three transitions, one for each of those and one to start the wait. They
   * are separate actions rather than variants of deliver because the action id
   * is what asset_events stores, so "how long do clients take" and "how often
   * does work come back from a client" are questions the history can answer for
   * work already done.
   *
   * The route in from Approved for Client is ADDITIONAL, not a replacement: the
   * direct deliver above still works exactly as it did, so a studio that has
   * not granted the new permissions is not stuck, and nothing that relied on
   * that path has been taken away.
   */
  {
    action: 'client_sent',
    from: ['approved_for_client'],
    to: 'awaiting_client_feedback',
    who: 'clientSender',
    routeTo: 'reviewQueue',
    describe: 'Sent to the client, waiting on their feedback',
  },
  {
    action: 'client_approved',
    from: ['awaiting_client_feedback'],
    to: 'delivered',
    who: 'clientDeliverer',
    routeTo: 'reviewQueue',
    describe: 'The client approved it — delivered',
  },
  {
    /* Back to TL Feedbacks, which is a state that already exists and already
       knows what to do: the lead reads the note, and hands the rework to
       whoever should make it, through the same reassign flow they already use.
       Nothing new is built for that half.
       
       requiresNote, like the studio's own two change requests. What the client
       asked for is the entire content of this transition — an artist receiving
       rework with no note has been told to change something and not what. */
    action: 'client_changes',
    from: ['awaiting_client_feedback'],
    to: 'tl_changes_requested',
    who: 'clientReturner',
    routeTo: 'assignee',
    requiresNote: true,
    describe: 'The client asked for changes — back to the team lead',
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
    /* One entry per action, and a test holds it to that.
     *
     * The fallback below reads the action id as English, which works for none
     * of them: a missing entry produced "An asset in \"In Progress\" cannot be
     * deliver." Four actions were falling through to it — deliver, assign,
     * accept and relay — which went unnoticed while the only way to see the
     * message was to try an illegal move on one asset. Delivering in bulk
     * reports a reason per asset, so they are all on screen at once. */
    const PHRASE = {
      assign: 'assigned to somebody',
      accept: 'accepted and started',
      submit: 'submitted',
      reassign_review: 'handed to somebody else — that is only possible while it is waiting on a reviewer or waiting on changes',
      tl_approve: 'approved by a team lead',
      cd_approve: 'approved by the director',
      tl_request_changes: 'sent back by a team lead',
      cd_request_changes: 'sent back by the director',
      tl_send_to_client: 'sent straight to the client — that is only possible while it is in TL Review',
      relay: 'passed on to the assignee — the director\'s notes are only relayed once, from CD Feedbacks',
      deliver: 'marked delivered — only work the client has approved can be delivered',
      client_sent: 'sent to the client — only work that has been approved for the client can go out',
      client_approved: 'closed off as approved by the client — that is only possible while it is waiting on the client',
      client_changes: 'sent back with the client\'s changes — that is only possible while it is waiting on the client',
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

/* Why someone was turned away, in terms of the pipeline rather than of code.
 *
 * EVERY actor in `actors` needs a case here. One that does not have one falls
 * to the default, and the person is told "You cannot do that to this asset." —
 * which is true, useless, and indistinguishable from a bug. That is not
 * hypothetical: adding the tl_send_to_client transition added an actor and not
 * a case, so a team lead clicking a button the page had offered them got
 * exactly that, with nothing to say whether it was their permissions or the
 * asset. A test now fails if an actor has no case. */
function refusal(transition, ctx) {
  switch (transition.who) {
    /* Two different refusals wearing one actor, and telling them apart is the
       whole point: one is fixed in Settings by a Super Admin, the other cannot
       be fixed at all because it is somebody else's artist. */
    case 'tlClientSender':
      if (!ctx.canSendToClient) {
        return 'You do not have permission to send work straight to the client. '
          + 'That is the "TL Send to Client" permission, granted per role in Settings.';
      }
      return 'Only this artist\'s own team lead can send their work straight to the client.';
    case 'planner':
      return 'You cannot assign this asset — that is for whoever added it, or a role with Asset Assign.';
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
    /* Each names its own permission, because all three sit on one status and
       "you cannot do that" would leave the reader unable to tell which of the
       three they are missing. */
    case 'clientSender':
      return 'You do not have permission to send work to the client. '
        + 'That is the "Send Asset to Client" permission, granted per role in Settings.';
    case 'clientDeliverer':
      return 'You do not have permission to close off a client\'s approval. '
        + 'That is the "Mark Delivered from Client Feedback" permission, granted per role in Settings.';
    case 'clientReturner':
      return 'You do not have permission to pass a client\'s changes back to the team lead. '
        + 'That is the "Send Back to TL Feedbacks from Client Feedback" permission, granted per role in Settings.';
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
