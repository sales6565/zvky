// The clock on an asset.
//
// One row in work_sessions per stretch of actual work. The invariant everything
// here protects: AT MOST ONE OPEN SESSION PER ASSET. Start refuses while one is
// open — which is what makes a double-click, a second tab, or two people racing
// each other harmless: whoever is second gets a clear 409, not a duplicate
// clock.
//
// Deliberately no inactivity timeout. That was put to the studio and the answer
// was that the timer runs until somebody pauses it — closing the browser or
// signing out leaves it running, and the session log (start and end stamps on
// every row) is what makes an implausible stretch visible afterwards rather
// than silently truncated.

const { v4: uuid } = require('uuid');

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

// Whether the clock can run at all. Asked before start/pause, so a missing
// table produces "time tracking is not available on this deployment yet"
// rather than a database error the person cannot act on.
async function available(db) {
  try {
    await db.query('SELECT 1 FROM work_sessions LIMIT 1');
    return true;
  } catch (err) {
    if (unavailable(err)) return false;
    throw err;
  }
}

// Start the clock. Refuses if it is already running — the caller turns that
// into a 409, and the button that was clicked twice does nothing twice.
async function start(db, assetId, userId, assignmentId) {
  const running = await openSession(db, assetId);
  if (running) return { ok: false, alreadyRunning: true, since: running.started_at };
  const id = uuid();
  const round = await currentRound(db, assetId);
  // Which stretch-with-one-person this belongs to. It is what makes a new
  // assignee's counter start at nothing without anything having to "reset" it:
  // their episode simply has no sessions in it yet.
  try {
    await db.query(
      'INSERT INTO work_sessions (id, asset_id, user_id, round, assignment_id) VALUES ($1,$2,$3,$4,$5)',
      [id, assetId, userId, round, assignmentId || null]
    );
  } catch (err) {
    // A deployment whose work_sessions predates episodes still keeps time; it
    // just cannot attribute it to one.
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await db.query(
      'INSERT INTO work_sessions (id, asset_id, user_id, round) VALUES ($1,$2,$3,$4)',
      [id, assetId, userId, round]
    );
  }
  return { ok: true, sessionId: id, round };
}

// Stop the clock, stamping the row with how long it ran. Idempotent: pausing a
// paused timer is not an error, it is nothing.
// Stopping a clock that cannot exist is not a failure, it is nothing. Submitting
// pauses the timer first, and on a deployment whose work_sessions table could
// not be created that raw query used to throw — so the artist could not submit
// at all, with "a database error" as the only explanation.
async function pause(db, assetId) {
  const running = await openSession(db, assetId);
  if (!running) return { ok: true, wasRunning: false };
  await db.query(
    `UPDATE work_sessions
        SET ended_at = NOW(), seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
      WHERE id = $1 AND ended_at IS NULL`,
    [running.id]
  );
  return { ok: true, wasRunning: true, round: running.round };
}

// Everything below tolerates work_sessions not existing yet.
//
// The table arrives with a migration step, and a step can fail — on shared
// hosting, usually because the database user has no CREATE. When that happens
// the timer cannot work, but the board, the asset list and the whole review
// pipeline have nothing to do with the timer and must still draw. Reporting no
// time is right; taking the studio's main screen down for it is not.
function unavailable(err) {
  const code = err && err.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

// The summary a screen needs: total seconds (a running session counted up to
// now), the per-round breakdown, and whether the clock is running right now.
async function summary(db, assetId, assignmentId, assigneeId) {
  const { rows } = await db.query(
    `SELECT round,
            SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
            SUM(ended_at IS NULL) AS running
       FROM work_sessions WHERE asset_id = $1 GROUP BY round ORDER BY round`,
    [assetId]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    return { rows: [] };
  });
  const rounds = rows.map((r) => ({ round: Number(r.round), seconds: Number(r.seconds) || 0 }));

  // Two numbers, and the difference between them matters.
  //
  //   totalSeconds    every hour ever spent on this asset, by anyone. The
  //                   historical record, which a reassignment must never
  //                   shorten.
  //   currentSeconds  the hours spent by whoever holds it now, in the stretch
  //                   they have held it. This is the clock they see. Hand work
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
  // behind "the new assignee has no Accept and Start button": their counter
  // showed the previous person's hours, so the panel decided work was already
  // under way and offered Resume. Never fall back to somebody else's time.
  let currentSeconds = null;
  const scope = assignmentId
    ? { sql: 'assignment_id = $1', value: assignmentId }
    : (assigneeId ? { sql: 'user_id = $1', value: assigneeId } : null);
  if (scope) {
    const { rows: mine } = await db.query(
      `SELECT SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds
         FROM work_sessions WHERE asset_id = $2 AND ${scope.sql}`,
      [scope.value, assetId]
    ).catch((err) => {
      if (!unavailable(err)) throw err;
      return { rows: [{ seconds: null }] };
    });
    currentSeconds = Number(mine[0].seconds) || 0;
  }

  const totalSeconds = rounds.reduce((sum, r) => sum + r.seconds, 0);
  return {
    totalSeconds,
    currentSeconds: currentSeconds === null ? totalSeconds : currentSeconds,
    rounds,
    running: rows.some((r) => Number(r.running) > 0),
  };
}

// Totals for a set of assets in one query — what the Assets List shows.
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
            SUM(w.ended_at IS NULL) AS running,
            SUM(CASE WHEN w.user_id = a.assignee_id
                     THEN COALESCE(w.seconds, TIMESTAMPDIFF(SECOND, w.started_at, NOW()))
                     ELSE 0 END) AS current_seconds
       FROM work_sessions w
       JOIN assets a ON a.id = w.asset_id
      WHERE w.asset_id IN ($1) GROUP BY w.asset_id`,
    [assetIds]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] work_sessions unavailable (${err.code}) — time tracking is off until it exists. See /api/health.`);
    return { rows: [] };
  });
  return new Map(rows.map((r) => [r.asset_id, {
    seconds: Number(r.seconds) || 0,
    currentSeconds: Number(r.current_seconds) || 0,
    running: Number(r.running) > 0,
  }]));
}

module.exports = { start, pause, summary, totalsFor, openSession, currentRound, available };
