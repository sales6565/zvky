// The review pipeline as a state machine.
//
// Every move an asset can make is declared here as a transition: what it moves
// from, what it moves to, who is allowed to make it, and who the asset then
// sits with. The routes do not decide any of that — they ask this module and
// apply the answer. Keeping it in one table is what makes the pipeline
// checkable: the states below are the whole of it, and anything not listed
// cannot happen.
//
//   Not Assigned -> Assigned -> In Progress -> TL Review -> TL Approved -> ...
//                       |            ^             |              |
//                  (accept starts    |             |              +-> CD Review -> CD Feedbacks
//                   the clock)       |             |              |                     |
//                                    |             |              |          (TL relays)|
//                                    |             +-> TL Feedbacks <--------------------+
//                                    |                      |
//                                    +----------------------+  (assignee reworks)
//
//                       TL Approved -+-> CD Review -> Approved for Client -> Delivered
//                                    |                        ^
//                                    +-> "Send to Client" ----+  (skips the CD gate;
//                                                                its own permission)
//
// TL REVIEW HAS EXACTLY TWO ANSWERS: request changes, or approve. Approving no
// longer reaches the Creative Director directly — it lands in TL APPROVED, a
// holding stage where the lead then chooses between the ordinary route through
// the CD and skipping that gate. The two decisions were previously made in one
// click at the same moment; separating them means the record says which was
// approving the work and which was deciding who else needed to see it.
//
// Approved for Client is still reachable two ways: the ordinary route through
// the Creative Director, and a team lead with review.tl_send_client skipping
// that gate. Same destination, two different actions in the history, so the two
// are told apart afterwards — what changed is only where the skip is offered
// from.
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

// The eleven states, in pipeline order. Labels and colours match the dashboard.
const STATES = [
  { id: 'not_started', label: 'Not Assigned', color: 'var(--not)' },
  { id: 'assigned', label: 'Assigned', color: '#5b8def' },
  { id: 'in_progress', label: 'In Progress', color: 'var(--prog)' },
  { id: 'pending_tl_review', label: 'TL Review', color: 'var(--review)' },
  { id: 'tl_changes_requested', label: 'TL Feedbacks', color: '#e8402c' },
  /* Past the first gate, waiting on the lead to say where it goes next.
   *
   * A MUTED GREEN, and the shade is the point. Approved for Client is the
   * bright mint --approved; this is the same family a few steps back, so it
   * reads as "approved, but not the approval that matters to the client" at a
   * glance on a board. Distinct from the brand red, as every status colour
   * must be: a stage colour that matched the application's own would make one
   * stage look like the product rather than like a place work sits. */
  { id: 'tl_approved', label: 'TL Approved', color: '#4c9a75' },
  { id: 'pending_cd_review', label: 'CD Review', color: '#9b7ef0' },
  { id: 'cd_changes_requested', label: 'CD Feedbacks', color: '#e8402c' },
  /* A bug raised against the asset from the build — QA, Dev, Tech Art or the client
   * playing it. Work coming back, like the two feedback states above it, which is why
   * it sits with them rather than after Delivered: the list is grouped by WHAT a
   * state is, not by when it tends to happen.
   *
   * AMBER, and its own shade. The two internal feedback states share #e8402c; this
   * one is deliberately not that, because "the lead wants changes" and "it is broken
   * in the game" are different problems for the artist and a board should not make
   * them look alike. Distinct from the brand red #7f1416, as every status colour must
   * be — a stage wearing the application's own colour would read as the product
   * rather than as a place work sits. */
  { id: 'game_feedback', label: 'Game Feedback', color: '#d9822b' },
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

/* WHERE A FREELANCER'S WORK CAN BE RECORDED FROM, as one list.
 *
 * It used to be ['not_started'] alone, on the reasoning that outsourced work
 * always sits in Not Assigned. That reasoning was wrong, and a studio hit it:
 * a lead dragged an outsourced card to In Progress on the board — a free move
 * among FREE_STATUSES that asks nothing about outsourcing — and both Mark
 * completed and Mark delivered then refused the row for ever. The work was out
 * with a freelancer, really came back, and there was no way to say so.
 *
 * SO THE LIST IS WHEREVER OUTSOURCED WORK CAN HONESTLY BE, and each entry is a
 * decision:
 *
 *   not_started           Where it belongs, and where a fresh assignment leaves
 *                         it. The ordinary case.
 *   assigned, in_progress Meaningless for an asset with no internal assignee —
 *                         assigned to nobody, in progress by nobody — but
 *                         reachable by a board drag, and normalise() below now
 *                         pulls a new assignment out of them. They are here for
 *                         the rows that drifted before it existed: the work is
 *                         genuinely with a freelancer, so recording its stage
 *                         must be possible.
 *   tl_changes_requested, A rework sent outside. A lead or the director asks for
 *   cd_changes_requested  changes, the assignee is cleared and the round goes to
 *                         a freelancer — a legitimate thing to do, confirmed
 *                         reachable, and NOT normalised away, because
 *                         "a lead asked for changes" is information that
 *                         not_started would destroy.
 *
 * AND WHAT IS DELIBERATELY NOT HERE:
 *
 *   pending_tl_review     Already handed in; a lead has it. Recording a delivery
 *                         again would re-queue work already in the queue. This
 *                         is where outsource_reopen operates, which is the
 *                         correct action there, and the two must not overlap.
 *   tl_approved           A lead has accepted the work. A hand-back afterwards
 *                         would unsay a decision somebody inside the studio made.
 *   pending_cd_review     The director has it. TL Review's reason, one gate up.
 *   game_feedback         A Dev & QA round with its own lifecycle and its own
 *                         actor gate. Not a freelancer hand-back.
 *   approved_for_client   Approved and queued to go out; this would push it
 *                         backwards into review.
 *   awaiting_client_      The client has it. Moving it would contradict what the
 *   feedback              client was told.
 *   delivered             Closed. The client has the work. Never.
 *
 * DELIVERING TWICE is not on this list because it is not a question about the
 * asset's status: isDeliverable() and isCompletable() in src/outsource.js refuse
 * an assignment already completed, already delivered or cancelled, whatever the
 * task says. Both halves have to pass.
 */
const OUTSOURCE_STAGE_FROM = ['not_started', 'assigned', 'in_progress',
  'tl_changes_requested', 'cd_changes_requested'];

/* The statuses a drifted assignment is pulled OUT of when work is sent outside.
   The free stages minus the one that is already right — see normalise() in
   src/outsource.js, which is the only caller. */
const OUTSOURCE_NORMALISE_FROM = ['assigned', 'in_progress'];

/* WHERE Mark delivered LANDS A FREELANCER'S TASK: the pipeline's own terminal
   state. Named once because three things have to agree about it — the
   transition's `to`, the reversal's `from`, and the check that tells an
   outsourced delivery apart from the client's — and the first re-pointing of
   this feature broke the second by leaving it on the old destination. */
const OUTSOURCE_DELIVERED_TO = 'delivered';

/* SUPERSEDED, AND KEPT ONLY SO THE DECISION IS READABLE.
 *
 * Mark delivered now targets the 'delivered' status directly, so NOTHING can
 * reach this column any more: it claimed assets in pending_tl_review whose
 * assignment was delivered, and that combination is no longer produced. It is
 * listed in no extras array, drawn on no screen and counted in no panel.
 *
 * WHY IT IS STILL HERE rather than deleted: it names, in one place, the
 * destination this feature had for two commits, and `from` records which status
 * the old delivery landed in — which is what the audit query in
 * docs/outsourced-delivery-audit.sql looks for when counting rows that predate
 * the change. A CANDIDATE FOR LATER CLEAN-UP: once that query returns nothing on
 * the studio's own database, this constant and the empty BOARD_EXTRA_COLUMNS
 * machinery around it can go together.
 *
 * It was never a STATUS — id 'outsource_delivered' is deliberately absent from
 * STATE_IDS — so there is no state to retire and no row to rewrite.
 */
/* A BOARD COLUMN THAT IS NOT A STATUS, declared here so there is one of it.
 *
 * Work a freelancer has handed back sits in pending_tl_review — the status is
 * right and nothing about it changes — but on a board it reads as an artist's
 * submission, because that is what every other card in that column is. So the
 * Dashboard draws it as its own column, and the Admin Dashboard splits the same
 * figure the same way, and both take the id, the label and the colour from here
 * rather than keeping two copies that drift.
 *
 * NOT CALLED "Delivered". `delivered` is already a status and it means the
 * CLIENT has the work — the opposite end of the pipeline. Two columns under one
 * word, meaning near opposites, is the confusion the README's "Two permissions
 * called Mark as Delivered" exists to prevent.
 *
 * `after` is where it sits: straight after the queue it is waiting in, not last.
 * This work needs a lead TODAY; filing it past three approval stages, beside the
 * client's finished work, is where it would stop being noticed.
 *
 * THE PREDICATE IS NOT HERE, and cannot be: it reads an asset row joined to its
 * assignment, which the page has as a.outsourced_to and the server has as a
 * SQL EXISTS. Both ask the same two questions — the assignment's stage is
 * delivered AND the task still holds `from` — and tests/board-delivered.test.js
 * holds them to the same answer.
 */
const OUTSOURCE_DELIVERED_COLUMN = {
  id: 'outsource_delivered',
  label: 'Back from Freelancer',
  color: '#2e7d5b',
  after: 'pending_tl_review',
  // The status the delivery leaves the task in, which is also the status this
  // column takes its cards out of. One place, so the two cannot disagree.
  from: 'pending_tl_review',
};

/* The allow-list as a reader sees it: "Not Assigned, Assigned, In Progress, TL
   Feedbacks or CD Feedbacks". Built from the list so a refusal cannot name a
   different set of statuses from the one the table enforces. */
function allowedStatuses(ids = OUTSOURCE_STAGE_FROM) {
  const names = ids.map((id) => label(id));
  if (names.length < 2) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

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

/* IS THIS TASK STILL THE FREELANCER'S TO ACT ON?
 *
 * THE HALF THE STATUS CANNOT ANSWER, and the reason this exists: widening the
 * stage transitions to an allow-list of statuses let through a case the old
 * ['not_started'] had been blocking by accident. Unassign the freelancer, let an
 * artist pick the work up — the task is now in Assigned, which the allow-list
 * contains — and a stale assignment row could hand back work somebody inside
 * the studio was doing. An existing test caught it.
 *
 * So the real invariant is written down rather than implied by a status: the
 * exclusivity rule in src/outsource.js says a task is somebody's inside the
 * studio or somebody's outside it and never both, and an internal assignee is
 * the half of that which says the work came back in. A task that has one is not
 * a freelancer's to complete, deliver or reopen, whatever status it sits in.
 *
 * Checked on the ASSET, in the actor, so it is part of the one gate rather than
 * a check a route has to remember — and refusal() below gives it its own
 * sentence, because "you cannot do that" would send somebody to Settings to fix
 * a permission that is not the problem. */
const freelancersToAct = (ctx) => !ctx.asset || !ctx.asset.assignee_id;

/* IS THE DELIVERY THIS REVERSAL OWNS THE ONE THAT PUT THE TASK HERE?
 *
 * Only asked about a task sitting in the terminal state, because that is the one
 * state two different routes reach: Mark delivered now lands here, and so does
 * the CLIENT delivery from approved_for_client after submissions and approvals.
 *
 * AN OUTSOURCED DELIVERY WRITES NO asset_versions ROW, and the studio's own
 * pipeline cannot reach approved_for_client without one — so no versions means
 * the outsourced route brought it here, and a version means somebody inside
 * handed it in and a reviewer approved it. Undoing THAT is a pipeline decision
 * for whoever holds the override, not an outsourcing one, and a stale assignment
 * row must not be a back door to it. */
function outsourcedDeliveryOnly(ctx) {
  if (!ctx.asset || ctx.asset.status !== OUTSOURCE_DELIVERED_TO) return true;
  return Number(ctx.submittedVersions || 0) === 0;
}

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
  /* The gate on a game bug: whoever may act at the FIRST review gate for this asset.
   *
   * The same standing as teamLead, and deliberately the same predicate behind it —
   * canActAtTlGate, handed in as ctx.isTeamLead by the route. A game bug goes to the
   * project's team because they are who decides whether a reported defect is this
   * asset's to fix, and that is the same question the first gate already answers.
   *
   * ctx.canOverride carries the full-access reach that canActAtTlGate grants in its own
   * right; which of the two actually applied is recorded on the event as acted_via, so
   * the history can tell a round the team turned round from one an administrator pushed
   * through. */
  gameFeedbackLead: (ctx) => Boolean(ctx.isTeamLead || ctx.canOverride),
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
  /* Whoever may hand a freelancer's finished work back into the studio.
     Its own predicate and its own permission — NOT deliverer above, which is a
     different act with a different meaning. See the transition. */
  outsourceDeliverer: (ctx) => Boolean(ctx.canDeliverOutsourced) && freelancersToAct(ctx),
  /* Undoing a recorded stage, which is its own permission because it is a
     heavier act than recording one: a delivery already in the team lead's queue
     is work somebody may have started looking at. See outsource_reopen. */
  outsourceReopener: (ctx) => Boolean(ctx.canReopenOutsourced) && freelancersToAct(ctx)
    && outsourcedDeliveryOnly(ctx),
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
/* "Marked delivered by Priya on behalf of Ravi K."
 *
 * ONE BUILDER FOR THE THREE OUTSOURCE SENTENCES, because the shape is the whole
 * point and three copies of it is three chances to lose half. A freelancer has
 * no login, so each of these records a member of staff acting for somebody who
 * cannot click anything — and a history line that named only one of them would
 * be missing whichever one the reader came back for.
 *
 * Degrades rather than breaks. An assignment can be cancelled and a user
 * deactivated long after the row was written, and a history panel still has to
 * render: with neither name it reads as the bare action, which is what the
 * static describes on every other transition read like anyway. */
function onBehalfOf(ctx, action) {
  const staff = ctx && ctx.user && ctx.user.name ? String(ctx.user.name).trim() : '';
  const freelancer = ctx && ctx.outsourcedTo && ctx.outsourcedTo.freelancerName
    ? String(ctx.outsourcedTo.freelancerName).trim() : '';
  if (staff && freelancer) return `${action} by ${staff} on behalf of ${freelancer}`;
  if (staff) return `${action} by ${staff}`;
  if (freelancer) return `${action} on behalf of ${freelancer}`;
  return action;
}

const routes = {
  assignee: (ctx) => ctx.asset.assignee_id || null,
  // Nobody in particular: a review queue, picked up by whoever holds that gate.
  reviewQueue: () => null,
  actor: (ctx) => ctx.user.id,
  /* Back to whoever held it before a game bug pulled it out. Null is a legitimate
     answer — an asset in Delivered sits in no queue — so this reads the context rather
     than falling back to the assignee, which would put work on somebody's desk that
     was never on it. */
  restore: (ctx) => (ctx.restoreRoutedTo === undefined ? null : ctx.restoreRoutedTo),
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
           'tl_changes_requested', 'cd_changes_requested',
           /* And an open game bug, for the same reason as the two rework stages beside
              it: the asset is in somebody's hands and may need to be put in somebody
              else's. A game bug sitting with an artist who is on leave would otherwise
              be the one kind of rework nobody could hand on, which is precisely the
              problem this transition exists for. Lands in Assigned like the rest, so the
              new person starts their own round from nothing. */
           'game_feedback'],
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
    /* THE FIX FOR A GAME BUG, handed in.
     *
     * The note on game_feedback_pass below has always said "the artist's next submit is
     * the new round", and this is what makes that true rather than intended: without it
     * an artist holding a passed-along bug had no move of their own at all, and the only
     * ways out of Game Feedback were the lead declining it or a hand-over.
     *
     * A SEPARATE ENTRY rather than game_feedback joining the first submit's from-list,
     * because the sentence in the history is different — "resubmitted for team lead
     * review" is what happens after a lead's notes, and this is a fix for something the
     * build reported. The destination is the same and deliberately so: the gate that
     * answered the bug is the first review gate, so that is where its fix goes back to.
     *
     * NOTHING CREATES A ROUND HERE, and nothing should: a round in this application is a
     * submission, so writing the version row IS the new round, counted by the Efficiency
     * report with no change to the report. See the note at the top of the game feedback
     * step in src/migrate.js.
     *
     * NO ACCEPT STEP, like the two rework stages: src/routes/assets.js evaluates 'accept'
     * only from 'assigned' and opens a session without a transition from anywhere else.
     * The clock was NOT already available here though — STARTABLE in that file gates which
     * statuses a session may open in, and game_feedback had to be added to it alongside
     * this transition. The two are one change: a round is a submission, so a fix that could
     * be handed in but not clocked would be a round the Efficiency report counts with no
     * hours in it.
     *
     * game_feedback is deliberately NOT in ASSIGNEE_STATUSES, and that is what makes
     * this safe to offer: actors.assignee admits the assignee here only while the asset
     * is ROUTED to them, which happens when the lead passes the bug on. A bug still
     * sitting in the queue with nobody on it cannot be answered by the artist
     * submitting over the top of the decision. */
    action: 'submit',
    from: ['game_feedback'],
    to: 'pending_tl_review',
    who: 'assignee',
    routeTo: 'reviewQueue',
    describe: 'Fix for the game bug submitted for team lead review',
  },
  {
    /* THE FIRST GATE, AND NOW ONLY THE GATE.
     *
     * This used to land in CD Review, which made approving the work and
     * deciding the Creative Director should see it one click. They are two
     * judgements — "is this good" and "who else needs to look at it" — and a
     * lead who wanted the first without the second had to reach for a
     * different button entirely. It now lands in TL Approved, where the second
     * question is asked on its own. */
    action: 'tl_approve',
    from: ['pending_tl_review'],
    to: 'tl_approved',
    who: 'teamLead',
    routeTo: 'reviewQueue',
    describe: 'Team lead approved the work',
  },
  {
    /* The ordinary way on from TL Approved.
     *
     * Its own action rather than a second `tl_approve`, because the action id
     * is what asset_events stores and the two answer different questions: one
     * says the work passed, the other says the Creative Director is being
     * asked. A history that recorded both as "approved" could not tell them
     * apart afterwards.
     *
     * Same `who` as the approval itself: a lead who may pass work at this gate
     * may send it on through the ordinary pipeline. Sending it to the CLIENT
     * is the decision that needs more than that — see below. */
    action: 'tl_to_cd',
    from: ['tl_approved'],
    to: 'pending_cd_review',
    who: 'teamLead',
    routeTo: 'reviewQueue',
    describe: 'Team lead sent the approved work to the Creative Director',
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
     * OFFERED FROM TL APPROVED, not from TL Review. It used to sit beside the
     * two review buttons, which made the review pop-up a three-way choice
     * where two of the options were about the work and one was about the
     * client. Now the lead approves first and chooses the route second, and
     * this is one of the two ways out of that stage.
     *
     * ITS PERMISSION IS UNCHANGED AND IS NOT THE REVIEW ONE.
     * review.tl_send_client already exists for exactly this: it is the
     * authority to walk around the CD gate rather than to pass it, it defaults
     * to the full-access tier alone, and a studio grants it to senior leads
     * deliberately. Moving the button did not move the authority.
     *
     * There is no route back into CD Review from here. That is the point of the
     * action: the asset is past the gate, and a studio that wanted it reviewed
     * after all can send it back through the ordinary path by reassigning it. */
    action: 'tl_send_to_client',
    from: ['tl_approved'],
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
  /* --- a bug from the build ------------------------------------------------
   *
   * ARRIVING IS NOT A TRANSITION HERE, and that is not an omission. A game bug is
   * raised by Dev & QA through the integration API, where there is no user at all — so
   * there is nobody for an actor to be, and evaluate() could not be asked. The route
   * applies that status change itself, under the rules written in src/routes/integration.js.
   * What IS in this table is what a PERSON then does about it.
   *
   * Both moves stay in game_feedback and differ only in where the asset is routed,
   * exactly as relay does for the Creative Director's notes: the status says a game bug
   * is open, routed_to_id says whose move it is. A second status for "the artist is
   * fixing it" would be a state the board would have to explain. */
  {
    /* Pass to artist. NO ROUND-CREATION LOGIC, and none is needed: a round in this
       application is a submission, so the artist's next submit is the new round through
       asset_versions, and the Efficiency report counts it with no change to the report.
       See the note at the top of the game feedback step in src/migrate.js. */
    action: 'game_feedback_pass',
    from: ['game_feedback'],
    to: 'game_feedback',
    who: 'gameFeedbackLead',
    routeTo: 'assignee',
    describe: 'Game bug passed to the assignee',
  },
  {
    /* Decline with reason. The asset goes back to where it was before the bug pulled it
       out, which is why external_feedback records prev_status and prev_routed_to_id at
       the moment it arrives: neither is recoverable afterwards. Resolved from the
       context rather than fixed here, because the answer is stored per round. */
    action: 'game_feedback_decline',
    from: ['game_feedback'],
    to: (ctx) => ctx.restoreStatus,
    who: 'gameFeedbackLead',
    routeTo: 'restore',
    requiresNote: true,
    describe: 'Game bug declined',
  },
  {
    action: 'deliver',
    from: ['approved_for_client'],
    to: 'delivered',
    who: 'deliverer',
    routeTo: 'reviewQueue',
    describe: 'Delivered to the client',
  },
  {
    /* --- A FREELANCER'S WORK, DELIVERED --------------------------------------
     *
     * IT LANDS IN 'delivered', THE SAME END STATE THE CLIENT ROUTE REACHES, and
     * that is a studio decision reversing the one this transition shipped with.
     *
     * WHAT IT USED TO DO, and why: it targeted pending_tl_review, on the
     * reasoning that a freelancer's hand-back is a SUBMISSION — nobody inside
     * the studio had looked at it, so recording it as Delivered would tell every
     * board and every "open work" query that the client had something nobody
     * here had seen. That reasoning was sound and the studio has overruled it:
     * marking delivered is now STAFF ATTESTING that the work was handed to the
     * client or accepted internally, which is a statement about the outside
     * world that no internal review step can make for them.
     *
     * SO IT SKIPS STAGES, DELIBERATELY. A task marked delivered from In Progress
     * jumps TL Review, TL Approved, CD Review, Approved for Client and Awaiting
     * Client Feedback in one move. Nothing downstream assumes an asset arriving
     * at 'delivered' passed through any of them — checked, not hoped:
     *
     *   feedback rounds        `feedback` rows are written by the review routes;
     *                          none exists and none is required. feedbackLifecycle
     *                          .onTransition() is a no-op without an open bug.
     *   review counts          COUNT(asset_versions), which is 0 and reads as
     *                          "never submitted" — true of outsourced work.
     *   the Efficiency report  excludes outsourced tasks BY NAME before any of
     *                          this ("outsourced — no tracked time"), so no
     *                          average, hour total or turnaround figure moves.
     *   turnaround timestamps  finishedAt in src/routes/reports.js COALESCEs the
     *                          last 'deliver' EVENT then the last version — and
     *                          this action is 'outsource_delivered', so neither
     *                          exists and finishedAt is null. That excludes the
     *                          row from a date-filtered report, which is the
     *                          same answer the exclusion above already gives.
     *   P&L recordedHours      sums work_sessions on delivered assets; an
     *                          outsourced task has none, so it adds nought
     *                          hours. The agreed hours and their cost come from
     *                          outsource.costFor() instead, which is where an
     *                          outsourced figure belongs.
     *
     * NOTHING WAS BACK-FILLED. No fake review round, no invented
     * awaiting_client_feedback step, no synthetic 'deliver' event. Where a
     * consumer would have wanted one it tolerates the absence, which is the
     * honest shape.
     *
     * A SEPARATE TRANSITION, NOT A LOOSENED ONE. 'deliver' above still reads
     * from: ['approved_for_client'] and still belongs to review.deliver — so an
     * ordinary asset cannot reach Delivered any way it could not reach it
     * before, and this one is unreachable for an ordinary asset because the
     * endpoint takes ASSIGNMENT ids. Two transitions into one state, each with
     * its own source list, actor and permission.
     *
     * 'from' is OUTSOURCE_STAGE_FROM, unchanged from Prompt 26 — see that list
     * for why each status is on it. 'delivered' is NOT on it, so delivering
     * twice is refused by this table as well as by isDeliverable().
     */
    action: 'outsource_delivered',
    from: OUTSOURCE_STAGE_FROM,
    to: OUTSOURCE_DELIVERED_TO,
    who: 'outsourceDeliverer',
    routeTo: 'reviewQueue',
    /* NAMED FOR BOTH PEOPLE, and that is the point of a function here.
     *
     * A freelancer has no login. Every one of these is a member of staff
     * recording something on somebody else's behalf, and a history line reading
     * only "Delivered by the freelancer" loses the half somebody will come back
     * for: which of ours wrote it down. So the sentence carries both — and it
     * reads for the destination now: "Delivered by Priya on behalf of Ravi K."
     * rather than "Marked delivered…", because the task really is delivered
     * rather than merely recorded as handed back. Falls back gracefully when
     * either name is missing, because an assignment can be cancelled and a user
     * deactivated after the fact and a history row must still read. */
    describe: (ctx) => onBehalfOf(ctx, 'Delivered'),
  },
  {
    /* THE FREELANCER SAYS IT IS FINISHED; WE HAVE NOT RECEIVED IT YET.
     *
     * `to` IS ITS OWN `from`, deliberately, and this is the only self-transition
     * in the table. Completed is a fact about the ASSIGNMENT, not about the
     * asset: the task is still Not Assigned, because nobody here has it and no
     * review can begin until the files arrive. Moving the asset would be a lie
     * on every board in the studio.
     *
     * So why a transition at all, rather than a column write? Because the
     * alternative is a direct status write with its own permission check, its
     * own project-closed check and its own audit path — three things this table
     * already does, and three things that drift. Going through evaluate() and
     * applyTransition() gets the actor gate, the closed-project refusal and an
     * asset_events row with the history sentence, for the price of a `to` that
     * equals its `from`. closeIfWorkStopped() is a no-op when the two are
     * equal, so nothing is closed that should not be.
     *
     * NOT A TOLL GATE ON DELIVERY. outsource_delivered above is legal straight
     * from not_started, so a studio that hears and receives in one breath marks
     * Delivered without passing through here. */
    action: 'outsource_completed',
    from: OUTSOURCE_STAGE_FROM,
    /* STAY EXACTLY WHERE YOU ARE — a function now, and it has to be.
     *
     * This was the literal 'not_started', which was the same thing as its only
     * `from` and so moved nothing. Widening `from` turned that constant into a
     * bug waiting to happen: recording Completed on a task sitting in In
     * Progress would have MOVED it to Not Assigned, which is a status change
     * nobody asked for and the opposite of what Completed means. Reading the
     * current status back keeps the promise at every entry in the list, and
     * keeps movedAsset false and closeIfWorkStopped a no-op with it. */
    to: (ctx) => ctx.asset.status,
    who: 'outsourceDeliverer',
    /* Nobody's desk, which is what it already was. The asset has no internal
       assignee and no review has begun — routing it anywhere would put it in a
       queue for work that has not arrived. */
    routeTo: 'reviewQueue',
    /* "Marked completed by Priya on behalf of Ravi K." — parallel to the
       delivery's sentence, and no longer "by the freelancer, recorded", which
       read as though the freelancer had clicked something. They have no login;
       the staff member is the actor and the freelancer is who it concerns, which
       is exactly what onBehalfOf says. */
    describe: (ctx) => onBehalfOf(ctx, 'Marked completed'),
  },
  {
    /* UNDOING A MIS-CLICK, and the one action in this pair that can move an
     * asset backwards.
     *
     * TWO SHAPES, ONE ACTION. Undoing a Completed is a self-transition — the
     * asset never moved — and undoing a Delivered brings it back from
     * pending_tl_review to not_started. Both land on not_started, which is where
     * outsourced work sits, so one `to` covers both and the `from` list says
     * which two states it can be reached from.
     *
     * ONLY WHILE NOBODY HAS ACTED. pending_tl_review is in the `from` list and
     * nothing further along is: once a lead has approved the work it is in the
     * studio's own pipeline, and dragging it back to Not Assigned would strand a
     * review somebody has already done. A delivery that has gone that far is
     * corrected by the pipeline's own actions, not by this.
     *
     * ITS OWN PERMISSION, outsource.reopen, held by fewer designations than the
     * one that records a stage — see the catalogue entry. Recording that a
     * freelancer finished is bookkeeping; taking a delivery back out of
     * somebody's review queue is not. */
    action: 'outsource_reopen',
    /* EVERYWHERE A STAGE COULD HAVE BEEN RECORDED FROM, plus the two places a
       delivery can be found.
       
       A Completed recorded on a task sitting in In Progress leaves it in In
       Progress, so a reversal unreachable from there would be a stage you could
       record and not undo. OUTSOURCE_DELIVERED is where Mark delivered lands
       now, and it is read from the transition rather than typed so the two
       cannot drift — re-pointing the delivery once already left this list
       pointing at the old destination, which is a reversal that silently stopped
       working. pending_tl_review stays for the rows the old behaviour produced:
       they are still out there and still reversible. */
    from: [...OUTSOURCE_STAGE_FROM, 'pending_tl_review', OUTSOURCE_DELIVERED_TO],
    /* AND IT NORMALISES. not_started is where outsourced work belongs, so a
       reversal from a drifted status both undoes the stage and puts the task
       where it should have been — the one place in this feature a status change
       is the point rather than a side effect. */
    to: 'not_started',
    who: 'outsourceReopener',
    routeTo: 'reviewQueue',
    describe: (ctx) => onBehalfOf(ctx, 'Reopened and sent back to the freelancer'),
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
      tl_to_cd: 'sent to the Creative Director — that is only possible once a team lead has approved it',
      tl_send_to_client: 'sent straight to the client — that is only possible once a team lead has approved it',
      relay: 'passed on to the assignee — the director\'s notes are only relayed once, from CD Feedbacks',
      deliver: 'marked delivered — only work the client has approved can be delivered',
      /* THE THREE OUTSOURCED STAGES SAY WHICH STATUSES THEY ALLOW, and the list
       * is GENERATED from OUTSOURCE_STAGE_FROM rather than typed — a status
       * added to the allow-list appears in the message, and a message cannot
       * promise a status the table refuses.
       *
       * NONE OF THEM SAYS "by the freelancer" ANY MORE. They did, and it was
       * actively misleading: a freelancer has no login and never performs any of
       * these, so a member of staff who had just clicked Mark completed was told
       * the freelancer could not do it. The sentence now names what the action
       * needs and what the task actually is, which is what somebody looking at
       * the refusal can act on. */
      outsource_completed: `recorded as completed — the task has to be in ${allowedStatuses()}`,
      outsource_delivered: `delivered — the task has to be in ${allowedStatuses()}`,
      /* The reversal keeps "sent back to the freelancer", which is about the
         DESTINATION of the work and not about who clicks: the work really does
         go back to them. */
      outsource_reopen: `reopened and sent back to the freelancer — that is only possible from `
        + `${allowedStatuses()}, or while a delivery is still waiting on a team lead`,
      client_sent: 'sent to the client — only work that has been approved for the client can go out',
      client_approved: 'closed off as approved by the client — that is only possible while it is waiting on the client',
      client_changes: 'sent back with the client\'s changes — that is only possible while it is waiting on the client',
      game_feedback_pass: 'passed to the assignee as a game bug — that is only possible while a game bug is open on it',
      game_feedback_decline: 'declined as a game bug — that is only possible while a game bug is open on it',
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
/* The sentence for a task that has come back inside the studio, or null when it
   has not. One place, so the deliverer and the reopener cannot explain the same
   fact two different ways. */
/* The sentence for a task that reached Delivered through the studio's own
   pipeline, or null when it did not. Asked before the permission sentence,
   because somebody holding the key and shown "you cannot" would go and check
   Settings for a refusal that is about the task's history, not their role. */
function wentThroughReview(ctx) {
  if (!ctx.asset || ctx.asset.status !== OUTSOURCE_DELIVERED_TO) return null;
  if (Number(ctx.submittedVersions || 0) === 0) return null;
  return `${ctx.asset.code || 'This task'} was submitted and reviewed inside the studio before it `
    + 'was delivered, so this is not the outsourced delivery to undo. Moving work back out of '
    + 'Delivered after a review is a pipeline override, not an outsourcing action.';
}

function takenBack(ctx) {
  if (!ctx.asset || !ctx.asset.assignee_id) return null;
  return `${ctx.asset.code || 'This task'} is assigned to somebody in the studio now, so it is no `
    + 'longer the freelancer\'s to hand back. Clear the internal assignee first if the work really '
    + 'is still with them.';
}

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
    /* Its own case rather than sharing teamLead's, because the reader is in a different
       situation: the asset was pulled out of Delivered by somebody outside the studio,
       and "this artist's team lead" does not explain why they are being turned away from
       an asset they may well have delivered themselves. */
    case 'gameFeedbackLead':
      return 'Only this project\'s review team can decide what happens to a game bug — '
        + 'pass it to the artist, or decline it with a reason.';
    case 'clientApprover':
    case 'creativeDirector':
      return 'Only the Creative Director can act on it at this stage.';
    case 'deliverer':
      return 'You cannot mark this asset as delivered.';
    /* Named separately from the one above, because the two are different acts
       and a person refused one needs to know which. "You cannot mark this as
       delivered" on the Outsource tab would send somebody to ask for
       review.deliver, which would not help them. */
    /* TWO REFUSALS WEARING ONE ACTOR, like tlClientSender above, and telling them
       apart matters for the same reason: one is a permission a Super Admin can
       grant, the other is a fact about the task that no permission changes.
       takenBack() is asked first because it is the more specific of the two —
       somebody holding the key and seeing the permission sentence would go and
       check Settings for nothing. */
    case 'outsourceDeliverer':
      return takenBack(ctx)
        || 'You cannot record a stage on outsourced work on this project.';
    case 'outsourceReopener':
      return takenBack(ctx)
        || wentThroughReview(ctx)
        || 'You cannot reopen outsourced work on this project. Undoing a delivery is a '
          + 'separate permission from recording one.';
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
  OUTSOURCE_STAGE_FROM,
  OUTSOURCE_DELIVERED_COLUMN,
  OUTSOURCE_DELIVERED_TO,
  OUTSOURCE_NORMALISE_FROM,
  FREE_STATUSES,
  STATE_IDS,
  TRANSITIONS,
  label,
  evaluate,
  availableActions,
  cdChangesReentry,
};
