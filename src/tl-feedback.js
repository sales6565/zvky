/* MAY THIS PERSON SEND APPROVED WORK BACK WITH CHANGES — decided once.
 *
 * THE SHAPE IS src/asset-hold.js's, deliberately and for the reason that file
 * records: the Hold button was reported four times, and each report found the
 * rule written down somewhere else in words that happened to agree. The answer
 * was one pure function that returns a REASON rather than a boolean, called by
 * the route and by the board's per-asset decoration, with the page drawing what
 * it is given and deciding nothing. This is the third button on TL Approved
 * built that way from the start rather than after four reports.
 *
 * PURE. Nothing here queries anything. Every fact arrives in `facts`, because
 * the route has them one asset at a time while the board has them for forty at
 * once in batched queries — the same constraint that shaped asset-hold.js, and
 * the reason the whole matrix can be driven in a test with no server.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, in the order the checks run — and the order is part of the rule,
 * because it decides WHICH reason somebody is given when more than one applies:
 *
 *   1. we could not find out       the board's decoration degrades rather than
 *                                  throwing, and "unknown" has to be sayable or
 *                                  the page goes back to guessing. See UNKNOWN.
 *   2. the studio's switch         review.tl_feedback. On by default for every
 *                                  designation that holds review.tl; a Super
 *                                  Admin can take it away per designation.
 *   3. standing at this gate       canActAtTlGate — the project's review team,
 *                                  or full access. NOT a second copy of it: the
 *                                  caller asks that function and passes the
 *                                  answer in, exactly as asset-hold.js takes
 *                                  `onDashboard` from the board's own query.
 *   4. the stage                   TL Approved and nowhere else. This is the
 *                                  conflict a second lead meets when somebody
 *                                  has already acted.
 *   5. out with a freelancer       BEFORE the unassigned check, and that order
 *                                  is a lesson borrowed whole from
 *                                  asset-hold.js: an outsourced task has no
 *                                  internal assignee, so the assignee test
 *                                  would catch it and answer "nobody is
 *                                  assigned" — naming a person who does not
 *                                  exist and hiding the real reason.
 *   6. nobody is on it             an unassigned task. TL Feedbacks is a stage
 *                                  that sits on somebody's DESK; routing it to
 *                                  nobody is how work disappears.
 *
 * ---------------------------------------------------------------------------
 * WHY AN OUTSOURCED TASK IS REFUSED RATHER THAN ROUTED.
 *
 * A freelancer has no login. They cannot see TL Feedbacks, cannot read the
 * note, cannot start the clock and cannot submit — and the exclusivity rule in
 * src/outsource.js means a task that is theirs has no internal assignee to send
 * it to instead. The studio already has the right action for this: the Outsource
 * tab's reopen, which sends the work back out with the reason recorded where the
 * freelancer's own round lives. So this refuses, and the sentence says that
 * rather than "nobody is assigned".
 */
const workflow = require('./asset-workflow');

/* HOW LONG FEEDBACK HAS TO BE, and the numbers are a judgement rather than a
 * limit of the column:
 *
 *   MIN 12   "fix it" and "no" are not changes required, and a rework round
 *            costs an artist a day. Twelve characters is about three words — low
 *            enough never to block somebody writing "Rim light too flat" and
 *            high enough to stop a stage being moved by a keystroke. evaluate()
 *            in the workflow table already refuses blank and whitespace; this is
 *            the studio's rule about what counts as having said something.
 *   MAX 2000 The column is TEXT, so this is not the storage talking. It is what
 *            stays readable in the drawer's feedback box and in the history
 *            panel without either becoming a document viewer. About four
 *            hundred words.
 *
 * Both are exported, because the page shows the count and the limit and must not
 * hold its own copy of either — a test pins the page's numbers to these.
 */
const MIN_LENGTH = 12;
const MAX_LENGTH = 2000;

const CODES = {
  NO_PERMISSION: 'TLFB_NO_PERMISSION',
  NOT_ON_GATE: 'TLFB_NOT_ON_GATE',
  WRONG_STATUS: 'TLFB_WRONG_STATUS',
  OUTSOURCED: 'TLFB_OUTSOURCED',
  UNASSIGNED: 'TLFB_UNASSIGNED',
  TOO_SHORT: 'TLFB_TOO_SHORT',
  TOO_LONG: 'TLFB_TOO_LONG',
  /* Not a rule, a failure. See the same code in src/asset-hold.js: the board's
     decoration degrades rather than throwing, and the page must be told the
     answer is unknown rather than be left with no answer at all — which is what
     sent it back to working the rule out locally. */
  UNKNOWN: 'TLFB_UNKNOWN',
};

/* WHICH GATE SAID NO, as a short name, for the server log. The code identifies
   the reason; the gate identifies the CHECK, and "permission" and "stage" are
   two different investigations even though both end in a refusal. */
const GATES = {
  [CODES.NO_PERMISSION]: 'permission',
  [CODES.NOT_ON_GATE]: 'authority',
  [CODES.WRONG_STATUS]: 'status',
  [CODES.OUTSOURCED]: 'outsourced',
  [CODES.UNASSIGNED]: 'assignee',
  [CODES.TOO_SHORT]: 'text',
  [CODES.TOO_LONG]: 'text',
  [CODES.UNKNOWN]: 'unavailable',
};

/* Which refusals are worth a disabled button with its reason, and which should
   show nothing at all. A disabled control is better wherever somebody would
   otherwise wonder — they are looking at TL Approved work of their own team's
   and the button is missing — and worse where the task is none of their
   business. Decided here so the page cannot decide it differently on one
   screen from another. */
const OFFER = {
  [CODES.NO_PERMISSION]: false,
  [CODES.NOT_ON_GATE]: false,
  // Not drawn elsewhere in the pipeline: every other stage has its own controls,
  // and a greyed Submit Feedback on a Delivered asset is clutter, not an answer.
  [CODES.WRONG_STATUS]: false,
  // Shown. The lead is looking at their own project's work and the reason is
  // actionable: take it back from the freelancer, or reopen the round.
  [CODES.OUTSOURCED]: true,
  [CODES.UNASSIGNED]: true,
  [CODES.UNKNOWN]: true,
};

/* THE ONE STAGE THIS IS OFFERED FROM, read off the transition table rather than
 * typed here.
 *
 * The same arrangement WORKING_STATUSES has with src/asset-hold.js: the module
 * that owns the status vocabulary states the list, and everything else asks it.
 * A `from` widened in the table widens this with it, and the page's copy is
 * pinned to this by a test — which is the divergence that has bitten this
 * codebase three times (the dashboard's drag range against FREE_STATUSES, the
 * page's REWORK_STATUSES, and the page's hold list). */
const FROM_STATUSES = workflow.transitionFor('tl_submit_feedback').from;
const TO_STATUS = workflow.transitionFor('tl_submit_feedback').to;

const refuse = (code, message) => ({
  ok: false, code, gate: GATES[code] || 'unknown', message, offer: Boolean(OFFER[code]),
});
const allow = () => ({ ok: true, code: null, gate: null, message: null, offer: true });

/* THE DECISION. Everything arrives in `facts`:
 *
 *   asset          { status, code, assignee_id }, the task
 *   holdsPermission whether they hold review.tl_feedback (the caller asks its own
 *                   permission layer; this module knows nothing about catalogues)
 *   onGate         whether they may act at the first review gate on THIS asset.
 *                  Answered by permissions.canActAtTlGate(), or by the board's
 *                  batched form of it — never recomputed here.
 *   outsourcedTo   the live outsource assignment, or null
 *   unavailable    a fact we needed could not be fetched (see CODES.UNKNOWN)
 */
function decide(facts = {}) {
  const {
    asset, holdsPermission = false, onGate = false, outsourcedTo = null, unavailable = false,
  } = facts;

  /* ASKED FIRST, because it is not a refusal about the person — it is us saying
     we could not find out. Anything below would be a confident answer built on a
     fact we do not have. */
  if (unavailable) {
    return refuse(CODES.UNKNOWN, 'Whether this can be sent back could not be checked just now. '
      + 'Reload the page; if it keeps happening the server log says which query failed.');
  }

  if (!holdsPermission) {
    return refuse(CODES.NO_PERMISSION, 'You do not have permission to send approved work back '
      + 'with feedback. That is the "TL Submit Feedback" permission, granted per role in Settings.');
  }

  if (!onGate) {
    return refuse(CODES.NOT_ON_GATE, 'Only somebody on this project\'s review team can send its '
      + 'approved work back with feedback.');
  }

  const status = asset && asset.status;
  if (!FROM_STATUSES.includes(status)) {
    /* THE CONFLICT SENTENCE, and it is worded for the case that actually
       happens: two leads with the panel open, one of them clicks first. The
       stage is named rather than described, because the person is looking at a
       card that says TL Approved on it. */
    return refuse(CODES.WRONG_STATUS, `${(asset && asset.code) || 'This asset'} is no longer in `
      + `${workflow.label('tl_approved')}${status ? ` — it is in ${workflow.label(status)}` : ''}. `
      + 'Feedback is submitted from TL Approved.');
  }

  if (outsourcedTo) {
    return refuse(CODES.OUTSOURCED, `${(asset && asset.code) || 'This task'} is out with `
      + `${outsourcedTo.freelancerName || 'a freelancer'}, who has no login here and cannot pick `
      + 'up a rework round. Reopen the round on the Outsource tab to send it back to them, or '
      + 'take the work back into the studio first.');
  }

  if (!asset || !asset.assignee_id) {
    return refuse(CODES.UNASSIGNED, `${(asset && asset.code) || 'This asset'} has nobody assigned, `
      + `so there is no one to send the feedback to. ${workflow.label(TO_STATUS)} sits on an `
      + 'artist\'s desk — assign it first, and the feedback goes to them.');
  }

  return allow();
}

/* THE FEEDBACK ITSELF. Separate from decide() because they fail differently: a
 * refusal above is about the person or the task and is settled before anybody
 * types, while this is about what they typed and is answered as they type.
 *
 * Trims first and measures the trimmed text, so twenty spaces is not feedback —
 * and hands the trimmed text back, so the caller stores what was measured
 * rather than measuring one string and storing another. */
function validate(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim();
  if (!trimmed) {
    return { ok: false, status: 400, field: 'text', code: CODES.TOO_SHORT,
      error: 'Say what needs to change.' };
  }
  if (trimmed.length < MIN_LENGTH) {
    return { ok: false, status: 400, field: 'text', code: CODES.TOO_SHORT,
      error: `Say a little more about what needs to change — ${MIN_LENGTH} characters at least, `
        + `and that is ${trimmed.length}.` };
  }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, status: 400, field: 'text', code: CODES.TOO_LONG,
      error: `That is ${trimmed.length} characters; the limit is ${MAX_LENGTH}. Put the detail in `
        + 'a note or the chat and keep the feedback to what has to change.' };
  }
  return { ok: true, text: trimmed };
}

/* The answer the board sends per asset: what the control should do, and why if
   it should not. One key, not two — unlike hold_state, which decorates two
   controls — but the same shape, so the page reads them the same way. */
function state(facts) {
  const submit = decide(facts);
  return {
    canSubmit: submit.ok,
    submit: { code: submit.code, gate: submit.gate, message: submit.message, offer: submit.offer },
    // The limits, sent with the answer so the page's counter and the server's
    // validator cannot disagree about what is too short.
    minLength: MIN_LENGTH,
    maxLength: MAX_LENGTH,
  };
}

/* THE ANSWER WHEN ONE COULD NOT BE WORKED OUT. Not an absence: the page used to
   fall back to deciding the hold rule itself for an undecorated row, which was a
   fourth copy of it, and the fix was that there is no such thing as an
   undecorated row. Same here, from the start. */
const unavailableState = () => state({ unavailable: true });

module.exports = {
  CODES, GATES, OFFER, FROM_STATUSES, TO_STATUS, MIN_LENGTH, MAX_LENGTH,
  decide, validate, state, unavailableState,
};
