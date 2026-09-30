/* Where a game bug from Dev & QA is now, and telling Dev & QA each time it moves.
 *
 * external_feedback.state is the bug's own position, separate from the asset's status
 * (an asset in Game Feedback says a bug is open; this says WHICH bug and how far it
 * has got):
 *
 *   with_lead     arrived and pulled the idle asset into Game Feedback; the Team Lead
 *                 queue has it
 *   noted         arrived while somebody was working on the asset; recorded against
 *                 the round in progress, nothing moved
 *   with_artist   the Team Lead passed it on, or asked for changes to a fix
 *   in_review     the artist submitted the fix; it is at the Team Lead gate
 *   fix_approved  the fix was approved at a review gate. Terminal. Forge then says the
 *                 asset is ready for reintegration. Forge never puts it in a build:
 *                 that is Dev & QA's explicit action.
 *   declined      the Team Lead declined it. Terminal.
 *   withdrawn     Dev & QA withdrew it. Terminal.
 *
 * Every function takes the transaction the workflow change was written on, so the
 * state change and its event commit with it or not at all.
 */
const events = require('./integration-events');

const OPEN = ['with_lead', 'noted', 'with_artist', 'in_review'];
const TERMINAL = ['fix_approved', 'declined', 'withdrawn'];

// Approvals at a review gate. Any of them approves the fix it is looking at.
const APPROVALS = ['tl_approve', 'tl_send_to_client', 'cd_approve'];

function payloadOf(row, asset, extra = {}) {
  let attachments = [];
  try { attachments = row.attachments ? JSON.parse(row.attachments) : []; } catch { attachments = []; }
  return {
    feedbackId: row.id,
    assetId: asset.id,
    assetCode: asset.code || null,
    assetName: asset.name || null,
    state: row.state,
    round: Number(row.round) || null,
    source: row.source,
    sourceApp: row.source_app || null,
    clientBugId: row.client_bug_id || null,
    bugRef: row.bug_ref || null,
    title: row.title || null,
    severity: row.severity || null,
    handoffId: row.handoff_id || null,
    attachments,
    ...extra,
  };
}

async function openRows(runner, assetId, states) {
  const { rows } = await runner.query(
    `SELECT * FROM external_feedback WHERE asset_id = $1 AND \`state\` IN ($2) ORDER BY created_at, id`,
    [assetId, states]
  );
  return rows;
}

async function setState(runner, row, state, { resolved = false, note = null } = {}) {
  await runner.query(
    `UPDATE external_feedback SET \`state\` = $1,
            resolved_at = ${resolved ? 'NOW()' : 'resolved_at'},
            resolution_note = COALESCE($2, resolution_note)
      WHERE id = $3`,
    [state, note ? String(note).slice(0, 500) : null, row.id]
  );
  return { ...row, state };
}

async function assetOf(runner, assetId) {
  const { rows } = await runner.query(
    'SELECT id, `code`, `name`, project_id, `status`, routed_to_id FROM assets WHERE id = $1', [assetId]
  );
  return rows[0] || null;
}

async function emitFor(runner, type, row, asset, extra) {
  return events.emit(runner, {
    type,
    projectId: asset.project_id,
    entityType: 'feedback',
    entityId: row.id,
    payload: payloadOf(row, asset, extra),
  });
}

/* The latest submission, which is what an approved fix IS. */
async function latestVersion(runner, assetId) {
  const { rows } = await runner.query(
    `SELECT id, version_number, stage, link, file_name, created_at
       FROM asset_versions WHERE asset_id = $1 ORDER BY version_number DESC LIMIT 1`, [assetId]
  ).catch(() => ({ rows: [] }));
  const v = rows[0];
  return v ? {
    versionId: v.id, versionNumber: Number(v.version_number), fileName: v.file_name || null,
    link: v.link || null, submittedAt: v.created_at instanceof Date ? v.created_at.toISOString() : v.created_at,
  } : null;
}

/* After any workflow transition on an asset (src/routes/assets.js applyTransition). */
async function onTransition(runner, assetBefore, action, toStatus) {
  const from = assetBefore.status;
  /* A submission while a bug is with the artist is its fix — the first one (from Game
     Feedback) or one after the Team Lead asked for changes (from the rework stage). */
  if (action === 'submit') {
    const asset = await assetOf(runner, assetBefore.id);
    const states = from === 'game_feedback' ? ['with_artist', 'with_lead'] : ['with_artist'];
    for (const row of await openRows(runner, asset.id, states)) {
      const next = await setState(runner, row, 'in_review');
      await emitFor(runner, 'feedback.fix_submitted', next, asset);
    }
    return;
  }

  if (action === 'tl_request_changes' && from === 'pending_tl_review') {
    const asset = await assetOf(runner, assetBefore.id);
    for (const row of await openRows(runner, asset.id, ['in_review'])) {
      const next = await setState(runner, row, 'with_artist');
      await emitFor(runner, 'feedback.changes_requested', next, asset);
    }
    return;
  }

  if (APPROVALS.includes(action)) {
    const asset = await assetOf(runner, assetBefore.id);
    // A fix that was in review, and any bug noted against the round now approved.
    const rows = await openRows(runner, asset.id, ['in_review', 'noted']);
    if (!rows.length) return;
    const version = await latestVersion(runner, asset.id);
    const approved = [];
    for (const row of rows) {
      const next = await setState(runner, row, 'fix_approved', { resolved: true });
      await emitFor(runner, 'feedback.fix_approved', next, asset, { approvedVersion: version, approvedAt: new Date().toISOString() });
      approved.push(next);
    }
    /* One "ready" per asset, listing every bug it answers. Forge's part ends here: the
       asset is NOT placed in any build. */
    await events.emit(runner, {
      type: 'asset.ready_for_reintegration',
      projectId: asset.project_id,
      entityType: 'asset',
      entityId: asset.id,
      payload: {
        assetId: asset.id,
        assetCode: asset.code || null,
        assetName: asset.name || null,
        approvedVersion: version,
        assetStatus: toStatus,
        feedback: approved.map((r) => ({
          feedbackId: r.id, clientBugId: r.client_bug_id || null, sourceApp: r.source_app || null,
          bugRef: r.bug_ref || null, handoffId: r.handoff_id || null,
        })),
      },
    });
  }
}

/* The Team Lead passed the bug to the artist. */
async function onPass(runner, assetId) {
  const asset = await assetOf(runner, assetId);
  for (const row of await openRows(runner, assetId, ['with_lead'])) {
    const next = await setState(runner, row, 'with_artist');
    await emitFor(runner, 'feedback.assigned', next, asset);
  }
}

/* The Team Lead declined it. Returns the envelope of the declined row, if any. */
async function onDecline(runner, assetId, feedbackId, { reason, decidedBy, actedVia, restoredTo }) {
  const asset = await assetOf(runner, assetId);
  const { rows } = await runner.query('SELECT * FROM external_feedback WHERE id = $1', [feedbackId]);
  if (!rows[0]) return null;
  const next = await setState(runner, rows[0], 'declined', { resolved: true, note: reason });
  /* The fields feedback.declined always carried, kept for any reader built against
     them, inside the enveloped payload. */
  return emitFor(runner, 'feedback.declined', next, asset, {
    reason: reason || null, restoredTo: restoredTo || null, decidedBy: decidedBy || null, actedVia: actedVia || null,
  });
}

module.exports = { OPEN, TERMINAL, APPROVALS, onTransition, onPass, onDecline, payloadOf, emitFor, setState, assetOf };
