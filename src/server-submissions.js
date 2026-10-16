/* WHAT AN UPLOAD LEAVES BEHIND IN FORGE: a reference, and never a byte.
 *
 * The artist uploads to the office server from the Submit Work form, then
 * submits. The rows this module writes are the link between those two acts:
 * which files went up, under which relative path, how big and when — so the
 * submission and its history can show them beside the link, and so "Open in
 * Server tab" has a path to open.
 *
 * CLAIMED AT SUBMIT TIME, NOT AT UPLOAD TIME. The upload happens first and the
 * artist may still edit the link, upload again, or close the tab. So the rows
 * are written unclaimed (version_id NULL) and the submission takes the ones for
 * that asset and that person when it happens. An upload nobody submitted stays
 * unclaimed rather than being attached to the next round, which would be the
 * wrong answer with a straight face.
 *
 * INERT WHILE THE FEATURE IS OFF. claim() is called from the submit route
 * inside a check on the switch, and with no rows it is a no-op anyway — the one
 * flow every artist in the studio uses today must behave exactly as it did.
 */
const db = require('./db');

/* Attach this asset's unclaimed uploads by this person to the version just
   created. Never throws: a missing reference is worth less than a refused
   submission, which is the same bargain src/activity.js makes. */
async function claim(database, { assetId, userId, versionId }) {
  if (!assetId || !versionId) return 0;
  try {
    const { result } = await (database || db).query(
      `UPDATE server_submission_files SET version_id = $1
        WHERE asset_id = $2 AND version_id IS NULL AND ($3 IS NULL OR user_id = $3)`,
      [versionId, assetId, userId || null]
    );
    return result ? Number(result.affectedRows || 0) : 0;
  } catch (err) {
    console.error('[server] could not attach uploaded references to the submission:', err.message);
    return 0;
  }
}

/* The references for one asset, by version. Shaped for the drawer: the newest
   round first, each with its files. */
async function forAsset(database, assetId) {
  try {
    const { rows } = await (database || db).query(
      `SELECT id, version_id, relative_path, \`name\`, size, at
         FROM server_submission_files WHERE asset_id = $1 ORDER BY at DESC LIMIT 500`,
      [assetId]
    );
    return rows.map((r) => ({
      id: r.id,
      versionId: r.version_id || null,
      relative: r.relative_path,
      name: r.name,
      size: r.size === null || r.size === undefined ? null : Number(r.size),
      at: r.at,
    }));
  } catch { return []; }
}

module.exports = { claim, forAsset };
