/* MAY THIS PERSON PUT THIS TASK DOWN, OR PICK IT UP AGAIN — decided once.
 *
 * THIS FILE EXISTS BECAUSE THE HOLD BUTTON HAS BEEN REPORTED FOUR TIMES, and
 * each report found a different half of the same shape.
 *
 *   Prompt 18  checked the permission key against the two gates and found them
 *              agreeing. They were — on the narrow case it tried.
 *   Prompt 20  widened the rule for leads and supervisors, on both routes and in
 *              the board payload.
 *   Prompt 34  found the rule written down three times in words that happened to
 *              agree, and every refusal reaching the person as a missing button.
 *              Collapsed the three into this function and made it answer with a
 *              reason.
 *   Prompt 37  found that the rule itself was built on the wrong premise. The
 *              lead-level widening was scoped to PROJECT MEMBERSHIP — the
 *              project_team_leads and project_supervision tables — while the
 *              dashboard a lead actually looks at is scoped to
 *              visibleProjects(), which for a lead's `team` scope ALSO matches
 *              being a production coordinator on the project, owning it, or
 *              simply having a direct report with an asset in it. Measured: a
 *              Team Lead with two reports saw three projects on their dashboard
 *              and could hold work in one of them. The other two answered 403
 *              HOLD_NOT_YOURS, and the button was not drawn.
 *
 * ---------------------------------------------------------------------------
 * SO THE RULE IS NOW: WHAT YOU CAN SEE, YOU CAN HOLD.
 *
 * `onDashboard` is not computed here and is not computed twice. The caller asks
 * the SAME function the board and the Assets List ask — permissions.
 * assetOnDashboard(), which is canAccessProject() plus the board's one
 * narrowing — and passes the answer in. A second statement of visibility inside
 * this file is the exact mistake Prompt 37 is a report of, one level down.
 *
 * ---------------------------------------------------------------------------
 * PURE ON PURPOSE. Nothing here queries anything. Every fact it needs is passed
 * in, because the two routes have those facts one asset at a time while the
 * board has them for forty at once in batched queries, and a function that went
 * to the database could not serve both. It also means the whole matrix can be
 * driven in a unit test with no server, which is how the tables in
 * tests/asset-hold-matrix.test.js and tests/hold-visibility.test.js are written.
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
 *   4. yours, or on your board  the assignee, OR somebody holding
 *                               asset.hold_any looking at a task their own
 *                               dashboard shows them. Two codes, because the
 *                               two refusals are different facts: a designation
 *                               without the key is told it is not their task,
 *                               and one with it looking outside its dashboard
 *                               is told the task is not theirs to see.
 *   5. is hold meaningful here  the status. See WORKING_STATUSES below, and the
 *                               override that matters: a clock that IS running
 *                               can always be stopped, whatever the status says.
 *   6. is there anything to do  hold needs an open stretch; resume needs a
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
 */
const workflow = require('./asset-workflow');

/* Every reason, as a code and a sentence.
 *
 * CODES, because this application's refusals carry a named field or a named code
 * beside the sentence (see CODE in src/timesheet-gate.js) and because the page
 * has to tell "no business here" apart from "nothing to put down" without
 * matching on English.
 */
const CODES = {
  NO_PERMISSION: 'HOLD_NO_PERMISSION',
  OUTSOURCED: 'HOLD_OUTSOURCED',
  UNASSIGNED: 'HOLD_UNASSIGNED',
  NOT_YOURS: 'HOLD_NOT_YOURS',
  NOT_VISIBLE: 'HOLD_NOT_VISIBLE',
  WRONG_STATUS: 'HOLD_WRONG_STATUS',
  NO_SESSION: 'HOLD_NO_SESSION',
  ALREADY_HELD: 'HOLD_ALREADY_HELD',
  NOT_HELD: 'HOLD_NOT_HELD',
  ALREADY_RUNNING: 'HOLD_ALREADY_RUNNING',
  STUDIO_PAUSED: 'HOLD_STUDIO_PAUSED',
  /* Not a rule, a failure: the board's decoration degrades rather than throwing
     (see attachTasksAndNotes), and when the visibility query is what failed the
     page must be told that the answer is unknown rather than be left with no
     answer at all — which is what sent it back to working the rule out locally. */
  UNKNOWN: 'HOLD_UNKNOWN',
};

/* WHICH GATE SAID NO, as a short name.
 *
 * ADDED FOR THE FOURTH REPORT, which asked for every refusal to be logged with
 * the gate that produced it so the next one can be read out of the server log
 * instead of guessed at. The code already identifies the reason; the gate
 * identifies the CHECK, which is what somebody reading a log is looking for —
 * "visibility" and "authority" are two different investigations even though
 * both end in a refusal about whose task it is.
 */
const GATES = {
  [CODES.NO_PERMISSION]: 'permission',
  [CODES.OUTSOURCED]: 'outsourced',
  [CODES.UNASSIGNED]: 'assignee',
  [CODES.NOT_YOURS]: 'authority',
  [CODES.NOT_VISIBLE]: 'visibility',
  [CODES.WRONG_STATUS]: 'status',
  [CODES.NO_SESSION]: 'session',
  [CODES.ALREADY_HELD]: 'session',
  [CODES.NOT_HELD]: 'session',
  [CODES.ALREADY_RUNNING]: 'session',
  [CODES.STUDIO_PAUSED]: 'schedule',
  [CODES.UNKNOWN]: 'unavailable',
};

/* Which refusals are worth a disabled control with a tooltip, and which are not.
 *
 * A disabled button is better wherever somebody would otherwise wonder — they
 * started this task this morning and the button has gone — and worse where the
 * task is simply none of their business. Decided here so the page cannot decide
 * it differently on one screen than on another.
 */
const OFFER = {
  [CODES.NO_PERMISSION]: false,
  [CODES.OUTSOURCED]: true,
  [CODES.UNASSIGNED]: false,
  [CODES.NOT_YOURS]: false,
  [CODES.NOT_VISIBLE]: false,
  // Shown, because the person CAN see this task — they opened its panel. Being
  // told why the control is inert beats a panel that quietly has no control.
  [CODES.WRONG_STATUS]: true,
  [CODES.NO_SESSION]: true,
  [CODES.ALREADY_HELD]: true,
  [CODES.NOT_HELD]: true,
  [CODES.ALREADY_RUNNING]: true,
  [CODES.STUDIO_PAUSED]: true,
  [CODES.UNKNOWN]: true,
};

/* THE STATUSES WHERE HOLDING MEANS ANYTHING, and why the list is not written
 * here.
 *
 * THE FOURTH REPORT ASKED FOR A PER-STATUS DECISION and for the server's list
 * and the page's to be held equal by a test, because a status list stated twice
 * is a shape this codebase has been bitten by twice already (the dashboard's
 * drag range against FREE_STATUSES, and REWORK_STATUSES). The answer to that is
 * not a careful second list — it is to have ONE, in the module that owns the
 * status vocabulary. src/asset-workflow.js holds it as WORKING_STATUSES, beside
 * FREE_STATUSES and for the same reason, and it is the same array the /start
 * route uses to decide whether work can be STARTED. That is not a coincidence
 * worth hiding: "a status where the clock can run" is one idea, and a task whose
 * clock can run is exactly a task whose clock can be stopped.
 *
 * AND A RUNNING CLOCK IS ALWAYS STOPPABLE. The list governs whether the control
 * is OFFERED; it never refuses a session that is actually open or actually held.
 * A stretch opened legitimately whose asset has since moved on would otherwise
 * be a clock nobody could stop — which is a worse bug than the one a status list
 * prevents, and is why the previous version of this file had no list at all.
 */
const WORKING_STATUSES = workflow.WORKING_STATUSES;
const isWorkingStatus = (status) => WORKING_STATUSES.includes(status);

const refuse = (code, message) => ({
  ok: false, code, gate: GATES[code] || 'unknown', message, offer: Boolean(OFFER[code]),
});
const allow = () => ({ ok: true, code: null, gate: null, message: null, offer: true });

/* THE DECISION.
 *
 * `action` is 'hold' or 'resume'. Everything else arrives in `facts`:
 *
 *   user            { id }, the person acting
 *   asset           { assignee_id, code, status }, the task
 *   holdsPermission whether they hold asset.hold (the caller asks its own
 *                   permission layer; this module knows nothing about catalogues)
 *   holdsAny        whether they hold asset.hold_any — the lead-level key
 *   onDashboard     whether their OWN dashboard shows this task. Answered by
 *                   permissions.assetOnDashboard(), which is the board's own
 *                   visibility and not a second copy of it.
 *   outsourcedTo    the live outsource assignment, or null
 *   openSession     whether a stretch is open on this task
 *   held            the deliberate-or-scheduled pause, or null
 *   unavailable     the visibility answer could not be fetched (see CODES.UNKNOWN)
 */
function decide(action, facts = {}) {
  const {
    user, asset, holdsPermission, holdsAny = false, onDashboard = false,
    outsourcedTo = null, openSession = false, held = null, unavailable = false,
  } = facts;

  /* ASKED FIRST, because it is not a refusal about the person — it is us saying
     we could not find out. Anything below it would be a confident answer built
     on a fact we do not have. */
  if (unavailable) {
    return refuse(CODES.UNKNOWN,
      'Whether you may hold this task could not be checked just now. Reload the page; if it '
      + 'keeps happening, /api/health says what the database is missing.');
  }

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
  if (!mine) {
    if (!holdsAny) {
      return refuse(CODES.NOT_YOURS,
        'Only the person this task is assigned to can put it on hold or resume it. Holding '
        + 'somebody else\'s task needs "Hold / Resume Any Visible Task", which a Super Admin '
        + 'grants per designation in Settings → Role Permissions.');
    }
    if (!onDashboard) {
      return refuse(CODES.NOT_VISIBLE,
        `${asset.code || 'This task'} is not on your dashboard, so it is not yours to stop or `
        + 'start. You can hold any task your own dashboard shows you.');
    }
  }

  /* IS HOLDING MEANINGFUL AT THIS STAGE AT ALL — asked AFTER authority, so a
     task that is none of your business is not explained to you in terms of its
     status, and asked only where no clock is running. */
  if (!isWorkingStatus(asset.status) && !openSession && !held) {
    return refuse(CODES.WRONG_STATUS,
      `${asset.code || 'This task'} is in ${workflow.label(asset.status)}, which is not a stage `
      + 'where anybody is working on it, so there is no clock to hold. Work is held while a '
      + `task is ${describeWorkingStatuses()}.`);
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

// "Assigned, In Progress, TL Feedbacks, CD Feedbacks or Game Feedback" — built
// from the list rather than typed beside it, so a status added to it says so.
function describeWorkingStatuses() {
  const names = WORKING_STATUSES.map((id) => workflow.label(id));
  if (names.length < 2) return names[0] || 'being worked on';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/* Both answers at once, which is what the browser needs per asset: it draws two
   controls and has to know about each of them separately. */
function state(facts) {
  const hold = decide('hold', facts);
  const resume = decide('resume', facts);
  return {
    canHold: hold.ok,
    canResume: resume.ok,
    hold: { code: hold.code, gate: hold.gate, message: hold.message, offer: hold.offer },
    resume: { code: resume.code, gate: resume.gate, message: resume.message, offer: resume.offer },
  };
}

/* THE ANSWER THE BOARD SENDS WHEN IT COULD NOT WORK ONE OUT.
 *
 * Not an absence. The page used to fall back to deciding the rule itself for an
 * undecorated row, which was a fourth copy of it; the fix is that there is no
 * such thing as an undecorated row — a failure produces this, which says so. */
const unavailableState = () => state({ unavailable: true });

module.exports = {
  CODES, OFFER, GATES, WORKING_STATUSES,
  isWorkingStatus, describeWorkingStatuses,
  decide, state, unavailableState,
};
