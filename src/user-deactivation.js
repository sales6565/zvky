// Turning an account off without losing what the person did.
//
// THE DISTINCTION THIS MODULE EXISTS TO HOLD. Deleting a user destroys history;
// leaving a departed user active leaves their work sitting on a desk nobody is
// at. Deactivation is the third thing: the account stops working, and every
// record of what it did stays exactly where it was.
//
// So nothing here deletes. Not a work session, not an activity log entry, not a
// submission, not a delivered asset. The only rows this touches are the ones
// that represent WORK STILL WAITING ON THAT PERSON, because those are the only
// ones whose meaning changes when they stop coming in.
//
// WHAT MOVES AND WHAT DOES NOT, and the line between them is "is anybody still
// waiting on this":
//
//   moves to unassigned   Work that is theirs and unfinished — assigned, in
//                         progress, or handed back to them for changes. Left
//                         alone it would sit in a queue behind somebody who
//                         will never pick it up, and no board would show it as
//                         needing anybody.
//
//   stays with them       Everything finished or out of their hands: delivered,
//                         approved, with a reviewer, or with the client. Those
//                         are a record of who did the work. Reassigning them
//                         would rewrite that record to say somebody else did
//                         it, which is a lie told to make a query tidier.
//
// The reporting line of anybody beneath them is REPORTED, NOT CHANGED. Picking
// a new manager for somebody is a decision about that person's team, and this
// module has no basis on which to make it — so it hands back the list and lets
// a human decide. Silently reassigning them to the deactivated person's own
// manager would look like a tidy answer and would quietly restructure the
// studio.

const workflow = require('./asset-workflow');

/* The states whose work is still waiting on the person it is assigned to.
 *
 * Derived from the workflow rather than typed out, so a stage added later has
 * to be classified here on purpose instead of silently defaulting into
 * "finished" — which would leave real work stranded on a dead account.
 *
 * A state is OPEN when the assignee is who the studio is waiting for:
 *   not_started            nobody has it yet (it may still carry an assignee)
 *   assigned               theirs, not begun
 *   in_progress            theirs, begun
 *   tl_changes_requested   handed back to them
 *   cd_changes_requested   handed back to them
 *
 * Everything else is waiting on somebody ELSE — a reviewer, the client — or is
 * finished, and stays attributed. */
const OPEN_STATES = [
  'not_started', 'assigned', 'in_progress',
  'tl_changes_requested', 'cd_changes_requested',
];

/* Stated as an assertion rather than a comment: if a workflow state is added
   and nobody classifies it, this throws at require time rather than quietly
   treating it as finished work. */
const UNKNOWN = OPEN_STATES.filter((id) => !workflow.STATE_IDS.includes(id));
if (UNKNOWN.length) {
  throw new Error(`user-deactivation: unknown workflow state(s) ${UNKNOWN.join(', ')}`);
}

/* Where an unassigned asset lands. Not a new state — the workflow already has
   the one that means "nobody has this": not_started, labelled "Not Assigned".
   Inventing a second would split every board's first column in two. */
const UNASSIGNED_STATE = 'not_started';

/* What deactivating this person would do, worked out before anything is done.
 *
 * The confirmation needs to say it, and the deactivation itself needs the same
 * numbers, so both call this. Read-only — it changes nothing, which is what
 * lets the browser ask "what would happen?" without committing to it. */
async function impact(db, userId) {
  const [{ rows: open }, { rows: reports }, { rows: done }] = await Promise.all([
    db.query(
      `SELECT a.id, a.code, a.\`name\`, a.status, p.\`name\` AS project_name
         FROM assets a
         LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.assignee_id = $1 AND a.status IN ($2)
        ORDER BY a.created_at`,
      [userId, OPEN_STATES]
    ),
    db.query(
      'SELECT id, `name`, email, `role` FROM users WHERE reports_to_id = $1 ORDER BY `name`',
      [userId]
    ),
    db.query(
      `SELECT COUNT(*) AS n FROM assets WHERE assignee_id = $1 AND status NOT IN ($2)`,
      [userId, OPEN_STATES]
    ),
  ]);

  return {
    /* The work that will move, itemised rather than counted. Somebody
       confirming this is entitled to see which pieces of work are about to
       change hands, not just how many. */
    openAssets: open.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      status: a.status,
      statusLabel: workflow.label(a.status),
      projectName: a.project_name || null,
    })),
    /* Reported so a human can act on it. Deliberately NOT changed — see the
       note at the top of this file. */
    directReports: reports.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
    })),
    /* Named so the confirmation can say what is being KEPT as well as what is
       moving. "3 tasks will be unassigned" alone reads as though the rest were
       being destroyed. */
    keptAssets: Number(done[0].n) || 0,
  };
}

/* Turn the account off.
 *
 * Returns what it actually did, from the same shape impact() reports, so the
 * caller can log and display the real outcome rather than the prediction. The
 * two can differ: somebody may pick up a task between the confirmation being
 * drawn and the button being pressed, and reporting the prediction as though it
 * were the result is how an audit trail ends up describing something that did
 * not happen.
 */
async function deactivate(db, userId, actorEmail) {
  const before = await impact(db, userId);

  /* The assets move first. If this half fails the account is still active,
     which is recoverable; the other order would leave somebody locked out with
     their work still stuck to them. */
  if (before.openAssets.length) {
    await db.query(
      `UPDATE assets SET assignee_id = NULL, status = $1
        WHERE assignee_id = $2 AND status IN ($3)`,
      [UNASSIGNED_STATE, userId, OPEN_STATES]
    );
  }

  /* A Date, never a formatted string: mysql2 serialises a Date through the
     connection's timezone and reads a DATETIME back the same way, so it round
     trips. A hand-built UTC string comes back shifted on a server with an
     offset. Same reason as src/chat-files.js. */
  await db.query(
    'UPDATE users SET is_active = 0, deactivated_at = $1, deactivated_by = $2 WHERE id = $3',
    [new Date(), actorEmail || null, userId]
  );

  return before;
}

/* Turn it back on.
 *
 * Deliberately does NOT give the work back. Those assets were unassigned and
 * may well have been picked up by somebody else in the meantime; handing them
 * back would take live work off whoever is now doing it. Reactivation restores
 * the account, and the studio reassigns what it wants to reassign.
 */
async function reactivate(db, userId) {
  await db.query(
    'UPDATE users SET is_active = 1, deactivated_at = NULL, deactivated_by = NULL WHERE id = $1',
    [userId]
  );
}

module.exports = { impact, deactivate, reactivate, OPEN_STATES, UNASSIGNED_STATE };
