/* THE TIME A TEAM LEAD SPENDS REVIEWING, measured rather than typed.
 *
 * WHAT IS BEING MEASURED, and why it is not time-in-stage. An asset sits in
 * TL Review from the moment it is submitted until somebody acts on it, and
 * most of that is the asset waiting on a desk. What the studio asked to put on
 * a timesheet is the REVIEW: from the moment this lead opened the submission —
 * which is the click on "Copy this path", the one act that reliably means "I
 * am looking at it now" — to the moment they decided. An asset submitted on
 * Friday evening and approved on Monday morning is worth the twenty minutes on
 * Monday, not the weekend.
 *
 * SO THE SPAN IS PER LEAD, not per asset. Two leads can have the asset open at
 * once and each gets their own session; a lead who never clicked Copy has
 * nothing to log, which is the honest answer rather than a figure invented for
 * them. The session is credited to whoever clicked, even when another lead
 * pressed the decision button: the clicker did the reading.
 *
 * AND THE HOURS ARE WORKING HOURS. The span is handed to the same
 * countedMsByDay() that decides what a work_sessions row is worth — breaks,
 * evenings, weekly offs, holidays and the lead's own leave all removed, by the
 * one piece of code in this application that decides what "inside working
 * hours" means. There is no second definition of a working minute here, and
 * tests/tl-review.test.js pins that this module never does the arithmetic
 * itself.
 *
 * WHAT THIS TIME IS NOT. It is the lead's time, not the artist's. A TL Action
 * line never reaches Time Spent, the Efficiency report, bid-vs-spent, the
 * Artist Report or the P&L — all of which read work_sessions and not the
 * timesheet at all — and it is kept out of the one timesheet figure that does
 * read timesheet_entries.asset_id, hoursLoggedOn(), so a lead who also WORKED
 * on the asset is still offered their own recorded hours in full.
 */

const dayStatus = require('./day-status');
const workSchedule = require('./work-schedule');
const workLog = require('./work-log');

const REVIEW_STATUS = 'pending_tl_review';

/* The three ways a review ends, which are the three ways an asset leaves
   pending_tl_review: the lead accepted it, the lead sent it back, or something
   else moved it — a reassignment, an administrator's correction, a recall. The
   third is not an error and is not discarded: the reading happened, and the
   time it took is still the lead's. */
const OUTCOMES = { approved: 'approved', changesRequested: 'changes_requested', other: 'other' };

/* Which action means which outcome. Read from the action id the state machine
   carries, so a transition added later lands in 'other' rather than silently
   taking the meaning of whichever branch an if-else happened to end on. */
const OUTCOME_BY_ACTION = {
  tl_approve: OUTCOMES.approved,
  tl_request_changes: OUTCOMES.changesRequested,
};

const outcomeFor = (action) => OUTCOME_BY_ACTION[action] || OUTCOMES.other;

/* The two kinds of line this feature files. Stored as these strings, which are
   also what the column's CHECK allows and what the API accepts. */
const ACTIONS = { projectMeeting: 'project_meeting', assetReview: 'asset_review' };
const ACTION_KEYS = [ACTIONS.projectMeeting, ACTIONS.assetReview];
const isAction = (value) => ACTION_KEYS.includes(value);

/* ONE LABEL FUNCTION, for the timesheet list, the admin views and both exports.
   A second copy of "TL · Project Meeting" somewhere else is how the exports
   came to disagree with the screen about what a line said. */
function labelFor(tlAction) {
  if (tlAction === ACTIONS.projectMeeting) return 'TL · Project Meeting';
  if (tlAction === ACTIONS.assetReview) return 'TL · Asset Review';
  return null;
}

const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

/* ---------------------------------------------------------------------------
 * STARTING A SESSION
 *
 * IDEMPOTENT PER LEAD PER ASSET while a session is open. A lead who clicks Copy
 * three times while reading has one session, starting at the first click — the
 * later clicks are them going back to the path, not starting again. Enforced by
 * looking for an open row rather than by a unique index, because a lead
 * reviewing the same asset in a later round SHOULD get a second row.
 *
 * THE STAMP IS THE DATABASE'S. NOW() in the INSERT, never a time the browser
 * sent and never this process's clock: a client that is an hour fast would
 * otherwise be able to claim an hour of review time.
 */
async function start(db, { assetId, projectId, leadUserId }) {
  if (!assetId || !leadUserId) return { ok: false, reason: 'incomplete' };
  const open = await openFor(db, { assetId, leadUserId });
  if (open) return { ok: true, started: false, id: open.id };
  const id = require('node:crypto').randomUUID();
  try {
    await db.query(
      `INSERT INTO tl_review_sessions (id, asset_id, project_id, lead_user_id, started_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, assetId, projectId || null, leadUserId]
    );
  } catch (err) {
    if (unavailable(err)) return { ok: false, reason: 'unavailable' };
    throw err;
  }
  return { ok: true, started: true, id };
}

async function openFor(db, { assetId, leadUserId }) {
  const { rows } = await db.query(
    `SELECT id FROM tl_review_sessions
      WHERE asset_id = $1 AND lead_user_id = $2 AND ended_at IS NULL
      ORDER BY started_at ASC LIMIT 1`,
    [assetId, leadUserId]
  ).catch((err) => {
    if (unavailable(err)) return { rows: [] };
    throw err;
  });
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
 * ENDING THEM
 *
 * CALLED WHEREVER A STATUS IS WRITTEN, which is two places — applyTransition()
 * and the one route that writes a status itself — and called with the caller's
 * transaction so a review that is closed by a transition that then fails is
 * rolled back with it. That is the same shape, and the same two call sites, as
 * workLog.closeIfWorkStopped(); it sits beside it on purpose.
 *
 * EVERY OPEN SESSION ON THE ASSET, not only the decider's: two leads reading
 * the same submission are both finished the moment it is decided.
 *
 * A NO-OP WHEN THE ASSET IS NOT LEAVING REVIEW, so the ordinary transitions —
 * assign, start, deliver — cost one comparison and no query.
 */
async function closeIfReviewEnded(db, assetId, fromStatus, toStatus, { action, actorId } = {}) {
  if (fromStatus !== REVIEW_STATUS) return { closed: 0 };
  if (!toStatus || toStatus === fromStatus) return { closed: 0 };
  return closeOpen(db, assetId, { outcome: outcomeFor(action), actorId });
}

async function closeOpen(db, assetId, { outcome = OUTCOMES.other, actorId = null } = {}) {
  if (!assetId) return { closed: 0 };
  try {
    const { result } = await db.query(
      `UPDATE tl_review_sessions
          SET ended_at = NOW(), ended_by_user_id = $1, outcome = $2
        WHERE asset_id = $3 AND ended_at IS NULL`,
      [actorId, outcome, assetId]
    );
    return { closed: Number((result && result.affectedRows) || 0) };
  } catch (err) {
    if (unavailable(err)) return { closed: 0 };
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * WHAT A DAY'S REVIEWING IS WORTH
 *
 * THE ONE FUNCTION, read by the list, by the preview the form fills from and by
 * the save — the same rule the timesheet already follows for recorded hours,
 * and for the same reason: a form showing three and a save filing five is a bug
 * this application has had once already.
 *
 * CLOSED SESSIONS ONLY. An open one is a review still in progress; it has no
 * end, so it has no span, and offering "so far" would let a lead file hours for
 * a decision they have not made. The form says so rather than hiding the asset.
 *
 * THE DAY'S SHARE. countedMsByDay buckets a span by IST day, so a review that
 * ran from Friday evening into Monday morning puts Friday's working minutes on
 * Friday and Monday's on Monday, and the weekend contributes nothing at all.
 */
async function hoursFor(db, { leadUserId, assetId, day, now = Date.now() }) {
  const byAsset = await hoursByAsset(db, { leadUserId, assetIds: assetId ? [assetId] : [], day, now });
  return byAsset.get(assetId) || 0;
}

/* The same answer for many assets at once, which is what the picker needs: one
   query and one leave fetch for the lead's whole day, not one per asset. */
async function hoursByAsset(db, { leadUserId, assetIds = [], day, now = Date.now() }) {
  const out = new Map();
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!leadUserId || !ids.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return out;

  const dayStart = dayStatus.startOfDay(day);
  if (!Number.isFinite(dayStart)) return out;
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  if (dayStart > now) return out;

  const { rows } = await db.query(
    `SELECT asset_id,
            TIMESTAMPDIFF(SECOND, started_at, NOW()) AS start_age,
            TIMESTAMPDIFF(SECOND, ended_at,   NOW()) AS end_age
       FROM tl_review_sessions
      WHERE lead_user_id = $1 AND asset_id IN ($2) AND ended_at IS NOT NULL`,
    [leadUserId, ids]
  ).catch((err) => {
    if (unavailable(err)) return { rows: [] };
    throw err;
  });
  if (!rows.length) return out;

  /* THE LEAD'S OWN LEAVE FOR THE DAY, fetched once for every session — the same
     fetch-once shape work-log's dayTotalFor uses, and the reason the hours are
     leave-aware without this module knowing what leave is. */
  const windows = await dayStatus.windowsForSpan(db, leadUserId, dayStart, dayEnd).catch(() => []);
  const schedule = workSchedule.trackingWindow();

  const ms = new Map();
  for (const row of rows) {
    const from = workLog.instantFromAge(row.start_age, now);
    const to = workLog.instantFromAge(row.end_age, now);
    if (!(to > from)) continue;
    if (from >= dayEnd || to <= dayStart) continue;
    const mine = dayStatus
      .countedMsByDay(Math.max(from, dayStart), Math.min(to, dayEnd), { schedule, windows })
      .byDay.get(day) || 0;
    if (mine <= 0) continue;
    ms.set(row.asset_id, (ms.get(row.asset_id) || 0) + mine);
  }
  /* ROUNDED ONCE, to the two places the column stores and the field steps in —
     the same rounding the recorded-hours figure gets, in the same place. */
  for (const [assetId, total] of ms) out.set(assetId, Math.round((total / 3600000) * 100) / 100);
  return out;
}

module.exports = {
  REVIEW_STATUS,
  OUTCOMES,
  OUTCOME_BY_ACTION,
  outcomeFor,
  ACTIONS,
  ACTION_KEYS,
  isAction,
  labelFor,
  start,
  openFor,
  closeIfReviewEnded,
  closeOpen,
  hoursFor,
  hoursByAsset,
};
