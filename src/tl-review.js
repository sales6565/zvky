/* TL ACTION: a lead's own time, typed.
 *
 * TWO KINDS OF LINE, both project work and neither of them work on an asset:
 * a **project meeting** and a **review**. The lead types the hours for both.
 *
 * WHAT THIS USED TO BE, AND WHY IT IS NOT. The first build of this feature
 * measured a review automatically: a session opened when the lead clicked
 * "Copy this path" on a submission and closed when the asset left TL Review,
 * and the hours were that span intersected with the studio's working day. The
 * studio asked for it to be typed instead, so all of that is gone — the
 * sessions, the endpoints, the hook in the transition function, and the extra
 * network call on the copy button, which is back to copying and nothing else.
 *
 * The sessions table the first build created is deliberately left in place
 * rather than dropped; the note on it in src/migrate.js says why, and names it
 * there so that a test scanning for readers of it finds only the migration that
 * creates it and the health check that reports on it.
 *
 * WHAT IS LEFT IS A LABEL AND A RULE, which is all this module needs to be:
 * the two values the column may hold, and the words they read as. Both are
 * here rather than spelt where they are used, so the screen, the audit trail
 * and both exports cannot come to disagree about what a line says.
 *
 * STRICT ON THE WAY IN, LENIENT ON THE WAY OUT. isAction() refuses anything
 * but the two current values — including 'asset_review', the name the first
 * build used, so a client still sending it is told rather than quietly filed.
 * labelFor() still reads 'asset_review' as "TL · Review", because a row that
 * the conversion did not reach must still be legible: refusing to label it
 * would leave a line on somebody's timesheet with no description at all.
 *
 * WHAT THIS TIME IS NOT. It is the lead's time, not the artist's. A TL Action
 * line reaches no figure about an asset — not Time Spent, not the Efficiency
 * report, not bid-vs-spent, not the Artist Report, not the P&L, all of which
 * read work_sessions and never the timesheet — and it is kept out of the one
 * timesheet figure that is about an asset, hoursLoggedOn() in
 * src/timesheets.js, where that exclusion is written and argued. That
 * exclusion is on tl_action alone and never on asset_id, because a line
 * converted from the first build may still carry one.
 */

/* The two kinds of line this feature files. Stored as these strings, which are
   what the API accepts and what the column holds. */
const ACTIONS = { projectMeeting: 'project_meeting', review: 'review' };
const ACTION_KEYS = [ACTIONS.projectMeeting, ACTIONS.review];

/* The name the first build used for the second kind. Kept as a constant rather
   than written out at its three use sites: the migration converts rows holding
   it, the API refuses it, and the label still reads it. */
const RETIRED_REVIEW = 'asset_review';

const isAction = (value) => ACTION_KEYS.includes(value);

/* WHAT A LINE SAYS IT IS, for every screen and both exports.
 *
 * TWO ARGUMENTS NOW, because there are two ways a line can be meeting time and
 * they are not the same line. `tlAction` is the lead's — gated on
 * timesheet.tl_action and on LEADING the project. `projectMeeting` is
 * everybody else's — gated on timesheet.project_meeting and on NOT leading it.
 * Same meeting, same hour, different person, and the labels say which so a
 * manager reading a day can tell a lead's time from the team's.
 *
 * ONE FUNCTION RATHER THAN TWO. Extended here rather than given a function of
 * its own for the reason this module exists at all: the screen, the audit trail
 * and both exports must not come to disagree about what a line says, and two
 * label functions is the first step to two answers.
 *
 * TL ACTION WINS IF SOMETHING EVER CARRIES BOTH. The API refuses that
 * combination on the way in, so it should not exist — but a label is read by
 * screens that cannot refuse anything, and "TL · Project Meeting" is the
 * stricter claim of the two. Lenient on the way out, as this module already is
 * for the retired 'asset_review'. */
function labelFor(tlAction, projectMeeting = false) {
  if (tlAction === ACTIONS.projectMeeting) return 'TL · Project Meeting';
  if (tlAction === ACTIONS.review || tlAction === RETIRED_REVIEW) return 'TL · Review';
  if (projectMeeting) return PROJECT_MEETING_LABEL;
  return null;
}

/* The words a non-lead's meeting line reads as, everywhere: the Timesheet list,
   the admin views, History and the Asset Name column of the export. */
const PROJECT_MEETING_LABEL = 'Project Meeting';

module.exports = {
  ACTIONS, ACTION_KEYS, RETIRED_REVIEW, PROJECT_MEETING_LABEL, isAction, labelFor,
};
