/* MAY THIS PERSON PUT THIS TASK DOWN, OR PICK IT UP AGAIN — decided once.
 *
 * THIS FILE EXISTS BECAUSE THE HOLD BUTTON HAS BEEN REPORTED THREE TIMES, and
 * each report found a different half of the same shape. Prompt 18 checked the
 * permission key and the two gates against each other and found them agreeing —
 * which they were, on the narrow case it tried. Prompt 20 widened the rule for
 * leads and supervisors, correctly, on both routes and in the board payload.
 * The third report is what is left: the rule was written down TWICE, by hand, in
 * two places that happened to agree; and every refusal reached the person as a
 * button that was not there.
 *
 * So the rule is here, once, and it returns a REASON rather than a boolean. The
 * hold route, the resume route and the per-asset flag the browser draws from all
 * call this function, and the browser draws the answer it is given rather than
 * working anything out for itself.
 *
 * ---------------------------------------------------------------------------
 * PURE ON PURPOSE. Nothing here queries anything. Every fact it needs is passed
 * in, because the two routes have those facts one asset at a time while the
 * board has them for forty at once in batched queries, and a function that went
 * to the database could not serve both. It also means the whole matrix can be
 * driven in a unit test with no server, which is how the table in
 * tests/asset-hold-matrix.test.js is written.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, in the order the checks run — and the order is part of the rule,
 * because it decides WHICH reason a person is given when more than one applies:
 *
 *   1. the studio's switch      asset.hold. On for every designation by default;
 *                               a Super Admin can take it away.
 *   2. out with a freelancer    FIRST among the reasons about the task, and that
 *                               placement is the fix for the worst of the old
 *                               messages. An outsourced task has no internal
 *                               assignee, so the assignee test below used to
 *                               catch it and answer "Only the person a task is
 *                               assigned to can put it on hold" — which names a
 *                               person who does not exist and hides the real
 *                               reason. A freelancer has no login and no timer;
 *                               there is nothing here to hold.
 *   3. nobody is on it          an unassigned task. No clock belongs to anyone.
 *   4. yours, or one you lead   the assignee, or a designation in the studio's
 *                               Supervision group ON A PROJECT THEY LEAD OR
 *                               SUPERVISE. Both halves required: without the
 *                               second this would be "any lead may stop any
 *                               timer in the studio".
 *   5. is there anything to do  hold needs an open stretch; resume needs a
 *                               deliberate pause. The two differ here and
 *                               nowhere else.
 *
 * WHAT IS DELIBERATELY NOT HERE: the holiday check, the previous-day timesheet
 * gate and the one-active-task rule. Those are about the CLOCK rather than about
 * authority — they refuse an act the person is perfectly entitled to perform —
 * and they live on the resume route beside each other where their own reasoning
 * is written out. Hold is subject to none of them, and must not be: putting work
 * down is always allowed to somebody entitled to it, on a holiday as much as any
 * other day.
 *
 * THERE IS NO STATUS LIST, on either side, and that is a finding rather than an
 * omission — see the note on STATUS_GATE below.
 */

/* Every reason, as a code and a sentence.
 *
 * CODES, because this application's refusals carry a named field or a named code
 * beside the sentence (see CODE in src/timesheet-gate.js) and because the page
 * has to tell "no business here" apart from "nothing to put down" without
 * matching on English.
 *
 * `offer` is the page's half of the answer: whether a refused control should be
 * drawn DISABLED WITH THE REASON, or not drawn at all. A disabled button is
 * better wherever somebody would otherwise wonder — they started this task this
 * morning and the button has gone — and worse where the task is simply none of
 * their business, which is most cards on a board. Decided here so the page
 * cannot decide it differently on one screen than on another.
 */
const CODES = {
  NO_PERMISSION: 'HOLD_NO_PERMISSION',
  OUTSOURCED: 'HOLD_OUTSOURCED',
  UNASSIGNED: 'HOLD_UNASSIGNED',
  NOT_YOURS: 'HOLD_NOT_YOURS',
  NO_SESSION: 'HOLD_NO_SESSION',
  ALREADY_HELD: 'HOLD_ALREADY_HELD',
  NOT_HELD: 'HOLD_NOT_HELD',
  ALREADY_RUNNING: 'HOLD_ALREADY_RUNNING',
  STUDIO_PAUSED: 'HOLD_STUDIO_PAUSED',
};

// Which refusals are worth a disabled control with a tooltip, and which are not.
const OFFER = {
  [CODES.NO_PERMISSION]: false,
  [CODES.OUTSOURCED]: true,
  [CODES.UNASSIGNED]: false,
  [CODES.NOT_YOURS]: false,
  [CODES.NO_SESSION]: true,
  [CODES.ALREADY_HELD]: true,
  [CODES.NOT_HELD]: true,
  [CODES.ALREADY_RUNNING]: true,
  [CODES.STUDIO_PAUSED]: true,
};

/* WHY THERE IS NO LIST OF ELIGIBLE STATUSES, stated so the next reader does not
 * add one on one side only — which is the shape of the REWORK_STATUSES and
 * canHandOverInReview gaps this codebase has already been bitten by twice.
 *
 * Measured, not assumed: a lead was offered and granted a hold on an open
 * session in every one of the nine statuses an asset can be in, including
 * delivered. There is no status condition on the route, none on the page, and
 * so nothing that can diverge.
 *
 * AND THAT IS RIGHT, because the condition that matters is already exact: hold
 * needs an OPEN STRETCH OF WORK, and a stretch is only ever opened from a status
 * where work runs (src/asset-workflow.js decides that, on /start). A status list
 * here would be a second, weaker statement of a condition already enforced — and
 * the one case where the two could differ is a session that was opened
 * legitimately and whose asset has since moved, where refusing the hold would
 * strand a running clock nobody could stop. tests/asset-hold-matrix.test.js
 * asserts that neither side has acquired a list, so a future one has to be added
 * to both or to neither.
 */
const STATUS_GATE = null;

/* THE DESIGNATIONS THAT MAY HOLD SOMEBODY ELSE'S WORK: the studio's Supervision
 * group, read off the role catalogue.
 *
 * A GROUP, NOT A LIST OF KEYS, and this is the change the third report turned
 * out to be about. Prompt 20 named four keys — team_lead, associate_team_lead,
 * art_supervisor, associate_animation_supervisor — because four were asked for,
 * and said so in a comment. The Supervision group holds SIX: senior_team_lead
 * and technical_manager were left out, so a Senior Team Lead on a project could
 * not stop a timer a Team Lead on the same project could. Measured, in the
 * matrix: 403 and no button, every cell.
 *
 * Reading the group also retires a hardcoded designation-key comparison, which
 * this project's standing rule is against, and means a designation a Super Admin
 * moves into Supervision in Settings carries this authority without a deploy —
 * which is the point of the group being editable.
 *
 * CREATIVE DIRECTION IS NOT INCLUDED, deliberately. associate_art_director sits
 * in that group and carries the `lead` tier, so a capability-based rule
 * (`leadsTeam`) would have picked it up; the studio asked for team leads and
 * supervisors, and an art director is neither. Narrower than the tier on
 * purpose, and the one judgement in this file that is worth confirming.
 */
const HOLD_GROUP = 'Supervision';

/* Does a role definition carry this authority? Takes the DEFINITION rather than
   the key, so there is no string to compare and no case to get wrong. */
const groupMayHoldOthers = (def) => Boolean(def) && def.group === HOLD_GROUP;

const refuse = (code, message) => ({
  ok: false, code, message, offer: Boolean(OFFER[code]),
});
const allow = () => ({ ok: true, code: null, message: null, offer: true });

/* THE DECISION.
 *
 * `action` is 'hold' or 'resume'. Everything else arrives in `facts`:
 *
 *   user            { id }, the person acting
 *   asset           { assignee_id, code }, the task
 *   holdsPermission whether they hold asset.hold (the caller asks its own
 *                   permission layer; this module knows nothing about catalogues)
 *   roleDef         their role's definition, for the group test
 *   leadsProject    whether this project is one they lead or supervise
 *   outsourcedTo    the live outsource assignment, or null
 *   openSession     whether a stretch is open on this task
 *   held            the deliberate-or-scheduled pause, or null
 */
function decide(action, facts = {}) {
  const {
    user, asset, holdsPermission, roleDef = null, leadsProject = false,
    outsourcedTo = null, openSession = false, held = null,
  } = facts;

  if (!user || !asset) return refuse(CODES.NOT_YOURS, 'There is no task here to put down.');

  if (!holdsPermission) {
    return refuse(CODES.NO_PERMISSION,
      'Your designation cannot put tasks on hold. A Super Admin can switch this on in '
      + 'Settings → Role Permissions.');
  }

  /* BEFORE THE ASSIGNEE TEST. See the note at the top of the file: an outsourced
     task has no internal assignee, so putting this second is what used to make
     the app answer "only the person it is assigned to" about a task assigned to
     nobody. */
  if (outsourcedTo) {
    const who = outsourcedTo.freelancerName || 'a freelancer';
    return refuse(CODES.OUTSOURCED,
      `${asset.code || 'This task'} is out with ${who}, so there is no timer here to stop or `
      + 'start. Record the stage on the Outsource tab, or take the work back from them first.');
  }

  if (!asset.assignee_id) {
    return refuse(CODES.UNASSIGNED,
      'Nobody in the studio is on this task, so there is no clock to hold. Assign it first.');
  }

  const mine = asset.assignee_id === user.id;
  if (!mine && !(groupMayHoldOthers(roleDef) && leadsProject)) {
    return refuse(CODES.NOT_YOURS,
      'Only the person this task is assigned to, or a team lead or supervisor on its project, '
      + 'can put it on hold or resume it.');
  }

  if (action === 'hold') {
    if (!openSession) {
      return held
        ? refuse(CODES.ALREADY_HELD, 'This task is already on hold. Resume it to carry on working.')
        : refuse(CODES.NO_SESSION, 'There is no running session to hold. Start the work first.');
    }
    return allow();
  }

  if (action === 'resume') {
    if (!held) {
      return openSession
        ? refuse(CODES.ALREADY_RUNNING, 'This task is already under way.')
        : refuse(CODES.NOT_HELD,
          'This task is not on hold — use Accept and Start to begin work on it.');
    }
    /* THE SCHEDULE'S OWN PAUSE IS NOT RESUMED BY HAND. It stops the clock at
       each break and at the end of the day and starts it again by itself, so a
       button offering to do it is a lie about who is in charge — and somebody
       who does NOT press it would believe the time is not being counted when it
       is. A DELIBERATE hold still resumes here, and must: the schedule does not
       undo it, so the button is the only way back. */
    if (held.byStudio) {
      return refuse(CODES.STUDIO_PAUSED,
        'The studio’s own schedule stopped this clock, and starts it again by itself — '
        + 'at the end of each break, and on the next working morning. There is nothing to '
        + 'resume by hand.');
    }
    return allow();
  }

  return refuse(CODES.NOT_YOURS, `${action} is not something that can be done to a task.`);
}

/* Both answers at once, which is what the browser needs per asset: it draws two
   controls and has to know about each of them separately. */
function state(facts) {
  const hold = decide('hold', facts);
  const resume = decide('resume', facts);
  return {
    canHold: hold.ok,
    canResume: resume.ok,
    hold: { code: hold.code, message: hold.message, offer: hold.offer },
    resume: { code: resume.code, message: resume.message, offer: resume.offer },
  };
}

module.exports = {
  CODES, OFFER, HOLD_GROUP, STATUS_GATE,
  groupMayHoldOthers, decide, state,
};
