// Who has held an asset, in order.
//
// The asset's own row answers "who has this now". This module answers "who has
// had this, and what did each of them do with it" — one row per stretch of time
// the asset sat with one person. An episode.
//
// The distinction the studio asked for lives here, and it lives in the data
// rather than in a branch:
//
//   work sent back to the SAME person   the assignee does not change, so the
//   (TL Changes, CD Changes)            episode does not end. Their clock keeps
//                                       accumulating across the round, which is
//                                       the rule already agreed.
//
//   reassigned to a DIFFERENT person    the assignee changes, so the episode
//                                       ends and a new one opens. The new
//                                       person's clock starts at nothing,
//                                       because it is a different episode with
//                                       no sessions in it yet. The outgoing
//                                       person's time is not discarded — it
//                                       stays on their closed episode, and in
//                                       the asset's lifetime total.
//
// So nothing has to decide "is this a reset or a continuation". The question is
// only ever "did the assignee change", and the totals follow.
//
// Invariant: at most one open episode per asset. open() enforces it by closing
// whatever was open first, in the caller's transaction.

const { v4: uuid } = require('uuid');

// The table arrives with a migration step, and a step can fail — on shared
// hosting, usually for want of CREATE. When it has not arrived, assignment
// history is unavailable but assigning, reviewing and delivering all still
// work. Same bargain work-timer makes for the clock.
function unavailable(err) {
  const code = err && err.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

async function available(db) {
  try {
    await db.query('SELECT 1 FROM asset_assignments LIMIT 1');
    return true;
  } catch (err) {
    if (unavailable(err)) return false;
    throw err;
  }
}

// The episode currently open on this asset, or null.
async function current(db, assetId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM asset_assignments WHERE asset_id = $1 AND ended_at IS NULL ORDER BY seq DESC LIMIT 1',
      [assetId]
    );
    return rows[0] || null;
  } catch (err) {
    if (unavailable(err)) return null;
    throw err;
  }
}

// Close whatever is open on this asset. Idempotent.
async function close(db, assetId, reason, status) {
  try {
    await db.query(
      `UPDATE asset_assignments SET ended_at = NOW(), ended_reason = $1,
              ended_status = COALESCE($2, (SELECT \`status\` FROM (SELECT \`status\` FROM assets WHERE id = $3) x))
        WHERE asset_id = $4 AND ended_at IS NULL`,
      [reason || null, status || null, assetId, assetId]
    );
  } catch (err) {
    if (!unavailable(err)) throw err;
  }
}

// Open a new episode, closing any that was open. Returns its id, or null when
// the table is not there.
//
// `status` is where the asset was when this person got it — not where it is
// about to be moved to. Reassigning out of TL Review records
// 'pending_tl_review' here while the asset moves to 'assigned' for the new
// person, which is what makes the trail read as what happened.
async function open(db, { assetId, userId, assignedById, status, reason }) {
  if (!userId) {
    await close(db, assetId, reason || 'unassigned', status);
    return null;
  }
  try {
    await close(db, assetId, reason || 'reassigned', status);
    const id = uuid();
    await db.query(
      `INSERT INTO asset_assignments (id, asset_id, user_id, assigned_by_id, status_at_assignment)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, assetId, userId, assignedById || null, status || 'not_started']
    );
    return id;
  } catch (err) {
    if (unavailable(err)) return null;
    throw err;
  }
}

// Every episode on a set of assets, oldest first, with the time spent in each
// and what was submitted during it.
//
// The time is per episode, which is the whole point: it is what lets the Assets
// List show the outgoing person's completed round next to the incoming person's
// fresh one. Sessions written before episodes existed have no assignment_id and
// are attributed to the episode that was open when they started, by time.
async function listFor(db, assetIds) {
  if (!assetIds.length) return new Map();
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT ass.*, u.\`name\` AS user_name, u.avatar_updated_at AS user_photo_at,
              b.\`name\` AS assigned_by_name,
              COALESCE(t.seconds, 0) AS seconds,
              COALESCE(t.running, 0) AS running
         FROM asset_assignments ass
         LEFT JOIN users u ON u.id = ass.user_id
         LEFT JOIN users b ON b.id = ass.assigned_by_id
         LEFT JOIN (
           SELECT assignment_id,
                  SUM(COALESCE(seconds, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS seconds,
                  SUM(ended_at IS NULL) AS running
             FROM work_sessions WHERE assignment_id IS NOT NULL GROUP BY assignment_id
         ) t ON t.assignment_id = ass.id
        WHERE ass.asset_id IN ($1)
        ORDER BY ass.seq`,
      [assetIds]
    ));
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] assignment history unavailable (${err.code}) — the Assets List falls back to one row per asset. See /api/health.`);
    return new Map();
  }

  // What each person submitted while they held it: the versions uploaded
  // between the episode opening and closing. Read separately rather than joined
  // so an episode with two submissions is not duplicated into two rows.
  let versions = [];
  try {
    ({ rows: versions } = await db.query(
      `SELECT asset_id, version_number, stage, link, description, uploaded_by, created_at
         FROM asset_versions WHERE asset_id IN ($1) ORDER BY version_number`,
      [assetIds]
    ));
  } catch (err) {
    if (!unavailable(err)) throw err;
  }

  const byAsset = new Map();
  for (const row of rows) {
    const started = new Date(row.assigned_at).getTime();
    const ended = row.ended_at ? new Date(row.ended_at).getTime() : Infinity;
    // Whose submission this was, decided by who uploaded it rather than by when.
    // Timestamps alone were not enough: DATETIME keeps seconds, and a handover
    // made in the same second as the submission put the outgoing person's work
    // on the incoming person's row. The window still separates two stretches by
    // the SAME person, which is the only case uploaded_by cannot settle.
    const mine = versions.filter((v) => {
      if (v.asset_id !== row.asset_id) return false;
      if (v.uploaded_by !== row.user_id) return false;
      const at = new Date(v.created_at).getTime();
      return at >= started - 1000 && at <= ended;
    });
    const episode = {
      id: row.id,
      assetId: row.asset_id,
      userId: row.user_id,
      userName: row.user_name || 'somebody who no longer has an account',
      userPhotoAt: row.user_photo_at || null,
      assignedById: row.assigned_by_id,
      assignedByName: row.assigned_by_name || null,
      assignedAt: row.assigned_at,
      statusAtAssignment: row.status_at_assignment,
      endedStatus: row.ended_status || null,
      endedAt: row.ended_at,
      endedReason: row.ended_reason,
      active: row.ended_at === null,
      seconds: Number(row.seconds) || 0,
      running: Number(row.running) > 0,
      submissions: mine.map((v) => ({
        versionNumber: v.version_number, stage: v.stage, link: v.link,
        description: v.description, at: v.created_at,
      })),
    };
    if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, []);
    byAsset.get(row.asset_id).push(episode);
  }
  return byAsset;
}

module.exports = { open, close, current, listFor, available };
