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

// Start the clock. Refuses if it is already running — the caller turns that
// into a 409, and the button that was clicked twice does nothing twice.
async function start(db, assetId, userId) {
  const running = await openSession(db, assetId);
  if (running) return { ok: false, alreadyRunning: true, since: running.started_at };
  const id = uuid();
  const round = await currentRound(db, assetId);
  await db.query(
    'INSERT INTO work_sessions (id, asset_id, user_id, round) VALUES ($1,$2,$3,$4)',
    [id, assetId, userId, round]
  );
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

// The summary a screen needs: total seconds (a running session counted up to
// now), the per-round breakdown, and whether the clock is running right now.
async function summary(db, assetId) {
  const { rows } = await db.query(
    `SELECT round,
            SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
            SUM(ended_at IS NULL) AS running
       FROM work_sessions WHERE asset_id = $1 GROUP BY round ORDER BY round`,
    [assetId]
  );
  const rounds = rows.map((r) => ({ round: Number(r.round), seconds: Number(r.seconds) || 0 }));
  return {
    totalSeconds: rounds.reduce((sum, r) => sum + r.seconds, 0),
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
  );
  return new Map(rows.map((r) => [r.asset_id, {
    seconds: Number(r.seconds) || 0,
    running: Number(r.running) > 0,
  }]));
}

module.exports = { start, pause, summary, totalsFor, openSession, currentRound };
