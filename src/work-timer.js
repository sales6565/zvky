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
  );
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
async function summary(db, assetId, assignmentId) {
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
  let currentSeconds = null;
  if (assignmentId) {
    const { rows: mine } = await db.query(
      `SELECT SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds
         FROM work_sessions WHERE assignment_id = $1`,
      [assignmentId]
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
async function totalsFor(db, assetIds) {
  if (!assetIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT asset_id,
            SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
            SUM(ended_at IS NULL) AS running
       FROM work_sessions WHERE asset_id IN ($1) GROUP BY asset_id`,
    [assetIds]
  ).catch((err) => {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] work_sessions unavailable (${err.code}) — time tracking is off until it exists. See /api/health.`);
    return { rows: [] };
  });
  return new Map(rows.map((r) => [r.asset_id, {
    seconds: Number(r.seconds) || 0,
    running: Number(r.running) > 0,
  }]));
}

module.exports = { start, pause, summary, totalsFor, openSession, currentRound, available };
