// When work started and when it was handed in.
//
// One row in work_sessions per stretch of work: opened when somebody clicks
// Accept and Start, closed when they submit for review or the asset moves to
// somebody else. `seconds` on the closed row is the elapsed wall-clock time
// between those two stamps.
//
// WHAT THIS USED TO BE, AND WHY IT CHANGED. This was a running timer with Pause
// and Resume, and `seconds` meant active worked time — a round could hold
// several rows, one per unpaused stretch. The studio asked for that to go: a
// round now records two timestamps and nothing else, and Time Spent is the
// difference between them. That means Time Spent now includes lunch, meetings,
// overnight and weekends if the work was left open across them. That is the
// agreed definition, not an oversight.
//
// The invariant everything here protects is unchanged: AT MOST ONE OPEN SESSION
// PER ASSET. start() refuses while one is open, which is what makes a
// double-click, a second tab, or two people racing each other harmless —
// whoever is second gets a clear 409, not a second start stamp.
//
// Note it is per ASSET, not per person. Nothing stops one person holding
// several assets open at once, and under wall-clock each of them counts the
// same hours. src/idle.js takes the union of the intervals rather than their
// sum for exactly that reason.

const { v4: uuid } = require('uuid');

/* Why a session ended. Absent on every row written before this change, which is
 * what tells the reports where the meaning of `seconds` switches from active
 * time to elapsed time — see cutover() below. */
const REASONS = {
  submitted: 'submitted',     // handed in for review
  reassigned: 'reassigned',   // somebody else has it now
  unassigned: 'unassigned',   // taken off everybody
  moved: 'moved',             // the asset was put in a status nobody works in
};

/* The statuses in which somebody's stretch of work is legitimately still open.
 *
 * A session is opened by Accept and Start and closed by submitting, by a
 * handover, or by the asset being unassigned. Nothing else closed one, and
 * every OTHER way an asset's status can change — a lead moving a started asset
 * back to Assigned, a Super Admin forcing a stage — left the session open on an
 * asset that no longer looked like it was being worked on.
 *
 * That is not a cosmetic leak. The open session is what "one active task at a
 * time" reads, so the person is blocked on every other asset they hold; and
 * because the asset is back in Assigned they can neither submit it ("start the
 * work before submitting it") nor start it again ("work has already been
 * started on this asset"). Deadlocked, with nothing on screen to explain it.
 *
 * So the rule is stated once, here, and asked at every point that writes a
 * status: work stays open only while the asset is in a state its holder is
 * actually working in.
 */
const WORK_CONTINUES = ['in_progress', 'tl_changes_requested', 'cd_changes_requested'];
const worksIn = (status) => WORK_CONTINUES.includes(status);

/* Close whatever is open if this status change means the work is not.
 *
 * Deliberately a no-op when the status has not changed — the relay leaves an
 * asset in CD Feedbacks and hands the notes on, which is the middle of a round,
 * not the end of one — and when nothing was open, which is the ordinary case.
 */
async function closeIfWorkStopped(db, assetId, fromStatus, toStatus, reason = 'moved') {
  if (!toStatus || toStatus === fromStatus || worksIn(toStatus)) return { ok: true, wasOpen: false };
  return close(db, assetId, reason);
}

// Which spell of work this is: 1 until the first submission, 2 for the rework
// after the first change request, and so on. Derived from how many submissions
// exist at the moment the session opens, then stored on the row — so the
// breakdown survives later resubmissions.
async function currentRound(db, assetId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = $1',
    [assetId]
  );
  return Number(rows[0].n) + 1;
}

/* The one thing this person has started and not yet finished, anywhere.
 *
 * The studio's rule is one active task at a time, and this is what it is
 * checked against. Note what it is NOT checked against: the in_progress
 * status. A round returned through TL or CD Feedbacks is started with the same
 * Accept and Start button and worked on with the asset still sitting in
 * tl_changes_requested — the status never becomes in_progress for rework. A
 * rule written against the status would let somebody hold a rework round and a
 * fresh task at the same time, which is the case it most needs to catch.
 *
 * An open session is the honest signal: it opens on Accept and Start and closes
 * on submit, reassign or unassign, so it is exactly "started, not yet handed
 * on" whatever the asset's status happens to say.
 *
 * The asset's code and name come back with it so a refusal can name what to go
 * and finish. A block that cannot say what is blocking you is indistinguishable
 * from the application being broken.
 */
async function openForUser(db, userId, exceptAssetId = null) {
  const params = [userId];
  let sql = `SELECT s.id, s.asset_id AS assetId, s.started_at AS since,
                    a.\`code\`, a.\`name\`, a.status
               FROM work_sessions s
               JOIN assets a ON a.id = s.asset_id
              WHERE s.user_id = $1 AND s.ended_at IS NULL`;
  if (exceptAssetId) {
    params.push(exceptAssetId);
    sql += ' AND s.asset_id <> $2';
  }
  sql += ' ORDER BY s.started_at LIMIT 1';
  const { rows } = await db.query(sql, params).catch((err) => {
    if (!unavailable(err)) throw err;
    /* No table means no sessions to find, which means nobody is blocked. The
       right failure for a deployment that cannot record time is that this rule
       does not apply, rather than that nobody can start anything. */
    return { rows: [] };
  });
  return rows[0] || null;
}

async function openSession(db, assetId) {
  const { rows } = await db.query(
    'SELECT * FROM work_sessions WHERE asset_id = $1 AND ended_at IS NULL LIMIT 1',
    [assetId]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  return rows[0] || null;
}

// Whether anything can be recorded at all. Asked before start/close, so a
// missing table produces "time recording is not available on this deployment
// yet" rather than a database error the person cannot act on.
async function available(db) {
  try {
    await db.query('SELECT 1 FROM work_sessions LIMIT 1');
    return true;
  } catch (err) {
    if (unavailable(err)) return false;
    throw err;
  }
}

// Stamp the start. Refuses if one is already open — the caller turns that into
// a 409, and the button that was clicked twice does nothing twice.
async function start(db, assetId, userId, assignmentId) {
  const running = await openSession(db, assetId);
  if (running) return { ok: false, alreadyOpen: true, since: running.started_at };
  const id = uuid();
  const round = await currentRound(db, assetId);
  // Which stretch-with-one-person this belongs to. It is what makes a new
  // assignee's Time Spent start at nothing without anything having to "reset":
  // their episode simply has no sessions in it yet.
  try {
    await db.query(
      'INSERT INTO work_sessions (id, asset_id, user_id, round, assignment_id) VALUES ($1,$2,$3,$4,$5)',
      [id, assetId, userId, round, assignmentId || null]
    );
  } catch (err) {
    // A deployment whose work_sessions predates episodes still records the
    // stamps; it just cannot attribute them to one.
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await db.query(
      'INSERT INTO work_sessions (id, asset_id, user_id, round) VALUES ($1,$2,$3,$4)',
      [id, assetId, userId, round]
    );
  }
  return { ok: true, sessionId: id, round };
}

/* Stamp the end, and record what ended it.
 *
 * Idempotent: closing a closed session is not an error, it is nothing. Closing
 * one that cannot exist is likewise nothing — submitting closes the session
 * first, and on a deployment whose work_sessions table could not be created
 * that raw query used to throw, so the artist could not submit at all with
 * "a database error" as the only explanation.
 *
 * `seconds` is the elapsed wall-clock span. It is stored rather than derived on
 * read so a later edit to either stamp cannot silently rewrite history, and so
 * the reports can sum one column instead of subtracting dates in SQL. */
async function close(db, assetId, reason) {
  const running = await openSession(db, assetId);
  if (!running) return { ok: true, wasOpen: false };
  const why = REASONS[reason] || null;
  try {
    await db.query(
      `UPDATE work_sessions
          SET ended_at = NOW(), seconds = TIMESTAMPDIFF(SECOND, started_at, NOW()), ended_reason = $1
        WHERE id = $2 AND ended_at IS NULL`,
      [why, running.id]
    );
  } catch (err) {
    // A deployment that has not run the ended_reason migration still closes the
    // session; it just cannot say why. Losing the stamp for want of a column
    // would be far worse than losing the reason.
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await db.query(
      `UPDATE work_sessions
          SET ended_at = NOW(), seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
        WHERE id = $1 AND ended_at IS NULL`,
      [running.id]
    );
  }
  return { ok: true, wasOpen: true, round: running.round, reason: why };
}

// Everything below tolerates work_sessions not existing yet.
//
// The table arrives with a migration step, and a step can fail — on shared
// hosting, usually because the database user has no CREATE. When that happens
// nothing can be recorded, but the board, the asset list and the whole review
// pipeline have nothing to do with it and must still draw. Reporting no time is
// right; taking the studio's main screen down for it is not.
function unavailable(err) {
  const code = err && err.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

/* Where the meaning of `seconds` changes.
 *
 * Rows written before this change hold ACTIVE worked time, summed across
 * however many pause/resume stretches a round had. Rows written after it hold
 * ELAPSED time between one start and one submit. The same column, two meanings,
 * and a report that silently mixes them would be comparing hours to hours that
 * are not the same hours.
 *
 * The discriminator is the data itself rather than a date stamped at deploy
 * time: every session closed under the new rule carries an ended_reason and no
 * old one does. So the earliest such row IS the cutover, it cannot drift out of
 * step with what actually happened, and a deployment with no history at all
 * reports no cutover — which is right, because there is nothing to warn about.
 */
async function cutover(db) {
  const { rows } = await db.query(
    `SELECT MIN(CASE WHEN ended_reason IS NOT NULL THEN started_at END) AS at,
            SUM(ended_reason IS NULL AND ended_at IS NOT NULL) AS legacy
       FROM work_sessions`
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [{ at: null, legacy: 0 }] };
  });
  const legacyRows = Number(rows[0].legacy) || 0;
  const at = rows[0].at || null;
  /* Two shapes because two readers need different things, and neither should
     have to guess. The driver hands back a Date for a DATETIME, and String()ing
     one gives "Fri Aug 28 2026 15:00:00 GMT+0000 (…)" — a spreadsheet that
     slices the front off that prints "Fri Aug 28", with no year, which is worse
     than useless in a file somebody opens next year. */
  const date = at ? new Date(at).toISOString().slice(0, 10) : null;
  return { at: at ? new Date(at).toISOString() : null, date, legacyRows, mixed: legacyRows > 0 };
}

// The summary a screen needs: the stamps, the elapsed total, and the per-round
// breakdown. A round still open counts up to now — that is elapsed-so-far, not
// a clock, and nothing on screen ticks it.
async function summary(db, assetId, assignmentId, assigneeId) {
  const { rows } = await db.query(
    `SELECT round,
            SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
            MIN(started_at) AS started_at,
            MAX(ended_at) AS ended_at,
            SUM(ended_at IS NULL) AS still_open
       FROM work_sessions WHERE asset_id = $1 GROUP BY round ORDER BY round`,
    [assetId]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  const rounds = rows.map((r) => ({
    round: Number(r.round),
    seconds: Number(r.seconds) || 0,
    startedAt: r.started_at || null,
    // An open round has no submit stamp yet. Reporting MAX(ended_at) there
    // would hand back the end of some earlier closed row in the same round,
    // which reads as "submitted" on a panel where nothing has been.
    submittedAt: Number(r.still_open) > 0 ? null : (r.ended_at || null),
    open: Number(r.still_open) > 0,
  }));

  // Two numbers, and the difference between them matters.
  //
  //   totalSeconds    every hour ever spent on this asset, by anyone. The
  //                   historical record, which a reassignment must never
  //                   shorten.
  //   currentSeconds  the hours spent by whoever holds it now, in the stretch
  //                   they have held it. This is the figure they see. Hand work
  //                   to somebody new and theirs reads nothing, because it is
  //                   a different stretch — nothing was reset, and the last
  //                   person's hours are still in the total above.
  //
  // Send work back to the SAME person and no new stretch begins, so their
  // number keeps climbing across the round. That is the older rule, unchanged.
  // Scoped to the assignment episode when there is one. When there is not —
  // a deployment where asset_assignments could not be created — fall back to
  // the sessions belonging to whoever holds the asset now, which answers the
  // same question from a table that is definitely there.
  //
  // Falling back to the lifetime total, which is what this did, was the bug
  // behind "the new assignee has no Accept and Start button": their figure
  // showed the previous person's hours, so the panel decided work was already
  // under way. Never fall back to somebody else's time.
  let currentSeconds = null;
  let currentStamps = null;
  const scope = assignmentId
    ? { sql: 'assignment_id = $1', value: assignmentId }
    : (assigneeId ? { sql: 'user_id = $1', value: assigneeId } : null);
  if (scope) {
    const { rows: mine } = await db.query(
      `SELECT SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
              MIN(started_at) AS started_at,
              MAX(ended_at) AS ended_at,
              SUM(ended_at IS NULL) AS still_open
         FROM work_sessions WHERE asset_id = $2 AND ${scope.sql}`,
      [scope.value, assetId]
    ).catch((err) => {
      if (!unavailable(err)) throw err;
      return { rows: [{ seconds: null, started_at: null, ended_at: null, still_open: 0 }] };
    });
    currentSeconds = Number(mine[0].seconds) || 0;
    currentStamps = {
      startedAt: mine[0].started_at || null,
      submittedAt: Number(mine[0].still_open) > 0 ? null : (mine[0].ended_at || null),
      open: Number(mine[0].still_open) > 0,
    };
  }

  const totalSeconds = rounds.reduce((sum, r) => sum + r.seconds, 0);
  const latest = rounds.length ? rounds[rounds.length - 1] : null;
  const stamps = currentStamps || (latest
    ? { startedAt: latest.startedAt, submittedAt: latest.submittedAt, open: latest.open }
    : { startedAt: null, submittedAt: null, open: false });
  return {
    totalSeconds,
    currentSeconds: currentSeconds === null ? totalSeconds : currentSeconds,
    rounds,
    ...stamps,
  };
}

// Totals for a set of assets in one query — what the Assets List shows.
//
// Two figures per asset, for the same reason summary reports two: `seconds` is
// the lifetime, and `currentSeconds` is what the person holding it now has put
// in. A screen that shows the lifetime to a new assignee is telling them
// somebody else's hours are theirs.
async function totalsFor(db, assetIds) {
  if (!assetIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT w.asset_id,
            SUM(COALESCE(w.seconds, TIMESTAMPDIFF(SECOND, w.started_at, NOW()))) AS seconds,
            SUM(w.ended_at IS NULL) AS still_open,
            MIN(CASE WHEN w.user_id = a.assignee_id THEN w.started_at END) AS started_at,
            MAX(CASE WHEN w.user_id = a.assignee_id THEN w.ended_at END) AS ended_at,
            COUNT(DISTINCT CASE WHEN w.user_id = a.assignee_id THEN w.round END) AS rounds,
            SUM(CASE WHEN w.user_id = a.assignee_id
                     THEN COALESCE(w.seconds, TIMESTAMPDIFF(SECOND, w.started_at, NOW()))
                     ELSE 0 END) AS current_seconds
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.asset_id IN ($1) GROUP BY w.asset_id`,
    [assetIds]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] work_sessions unavailable (${err.code}) — time recording is off until it exists. See /api/health.`);
    return { rows: [] };
  });
  return new Map(rows.map((r) => [r.asset_id, {
    seconds: Number(r.seconds) || 0,
    currentSeconds: Number(r.current_seconds) || 0,
    open: Number(r.still_open) > 0,
    startedAt: r.started_at || null,
    submittedAt: Number(r.still_open) > 0 ? null : (r.ended_at || null),
    rounds: Number(r.rounds) || 0,
  }]));
}

module.exports = {
  REASONS, WORK_CONTINUES, start, close, closeIfWorkStopped, summary, totalsFor,
  openSession, openForUser, currentRound, available, cutover,
};
