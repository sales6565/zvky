/* EVERY HOLD AND RESUME REFUSAL, IN THE SERVER LOG, AS ONE LINE.
 *
 * THE FOURTH REPORT OF THE HOLD BUTTON ASKED FOR THIS, and the reason is the
 * three reports before it: each one arrived as "the Hold button does not work
 * for Team Leads", and each was then diagnosed by building a fixture and
 * guessing at which gate had fired. Nothing in the log said. The decision has
 * carried a reason code since the third report and a gate name since this one,
 * so the only thing missing was writing them down.
 *
 * ONE LINE, AND THE FIELDS THE NEXT REPORT WILL NEED:
 *
 *   [hold] refused hold gate=visibility code=HOLD_NOT_VISIBLE user=<id>
 *          role=team_lead asset=<id> code=CH-004 project=<id> status=in_progress
 *          session=open mine=false
 *
 * `console.warn`, which is where everything else in this application that wants
 * to be seen on a shared host goes (see the [schema] lines in
 * attachTasksAndNotes). A refusal is not an error — most are entirely correct —
 * so it is warn rather than error, and it is unconditional: a level somebody has
 * to switch on is a level that will be off on the day it is needed.
 *
 * NO NAMES AND NO EMAIL. Ids and the designation key, which is everything
 * needed to reproduce, and nothing that makes the log itself a disclosure. The
 * designation IS logged, because "which designation" is the question every one
 * of these reports has turned out to be about.
 */

// Space-free, so the line stays greppable by field.
const field = (v) => {
  if (v === null || v === undefined || v === '') return '-';
  return String(v).replace(/[\s=]+/g, '_').slice(0, 64);
};

/* What the session looked like, as one word. The three states a reader cares
   about, told apart: a refusal on an open stretch and a refusal on nothing at
   all are different investigations. */
function sessionWord(facts) {
  if (facts.openSession) return 'open';
  if (facts.held) return facts.held.byStudio ? 'paused-by-schedule' : 'held';
  return 'none';
}

function refusal({ action, verdict, facts, user, asset }) {
  if (!verdict || verdict.ok) return;
  const parts = [
    `[hold] refused ${field(action)}`,
    `gate=${field(verdict.gate)}`,
    `reason=${field(verdict.code)}`,
    `user=${field(user && user.id)}`,
    `role=${field(user && user.role)}`,
    `asset=${field(asset && asset.id)}`,
    `task=${field(asset && asset.code)}`,
    `project=${field(asset && asset.project_id)}`,
    `status=${field(asset && asset.status)}`,
    `session=${field(sessionWord(facts || {}))}`,
    `mine=${field(Boolean(user && asset && asset.assignee_id === user.id))}`,
    `visible=${field(Boolean((facts || {}).onDashboard))}`,
    `hold_any=${field(Boolean((facts || {}).holdsAny))}`,
  ];
  console.warn(parts.join(' '));
}

module.exports = { refusal, sessionWord, field };
