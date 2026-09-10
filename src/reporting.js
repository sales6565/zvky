// The org chart: who reports to whom.
//
// Deliberately separate from the two user columns that already existed and look
// like they mean this:
//
//   manager_id    who created the account. Gates who may edit or remove them.
//   team_lead_id  who reviews a contributor's assets. Drives team permissions.
//
// Both carry permission meaning, and an org chart must not. Moving somebody in
// the hierarchy should never change what anyone can see or do, so reporting
// lives in its own column and this module is the only thing that writes it.

const { roleDef } = require('./roles');

// Roles at the top of the hierarchy report to nobody.
//
// Read from the role's tier rather than a hardcoded pair of keys. The Leadership
// tier holds exactly the two designations this rule was written for — Managing
// Director & CEO and Vice President, Global Operations & Business Development —
// and taking it from the tier means renaming one in Settings does not quietly
// re-introduce a Reporting To field for the person running the studio. A new
// designation added to that tier is top of the hierarchy too, which is what the
// tier already means: "sees every project, takes no action in the pipeline".
const TOP_TIER = 'leadership';

function isTopOfHierarchy(role) {
  const def = roleDef(role);
  return Boolean(def && def.tier === TOP_TIER);
}

// A chain longer than this is a corrupted hierarchy, not a deep one. Bounded so
// that data which is already circular — written before these checks existed, or
// by hand — makes the walk stop rather than hang.
const MAX_DEPTH = 50;

// Everyone above this person, nearest first. Also the cycle detector: it stops
// on a repeat rather than looping.
async function chainAbove(db, userId) {
  const chain = [];
  const seen = new Set([userId]);
  let currentId = userId;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const { rows } = await db.query(
      'SELECT id, `name`, email, `role`, reports_to_id FROM users WHERE id = $1',
      [currentId]
    );
    if (!rows.length || !rows[0].reports_to_id) break;

    const nextId = rows[0].reports_to_id;
    if (seen.has(nextId)) {
      // Pre-existing loop. Report it rather than pretending the chain ended.
      return { chain, cycle: true };
    }
    seen.add(nextId);

    const { rows: manager } = await db.query(
      'SELECT id, `name`, email, `role`, reports_to_id FROM users WHERE id = $1',
      [nextId]
    );
    if (!manager.length) break;
    chain.push(manager[0]);
    currentId = nextId;
  }
  return { chain, cycle: false };
}

// Can `candidateId` be the manager of `user`?
//
// The rule that matters is one rule wearing three hats: a person cannot report
// to themselves, cannot report to someone who reports to them, and cannot close
// a longer loop. All three are "walking up from the candidate reaches the
// user", so all three are answered by the same walk rather than by three
// separate checks that could disagree.
async function validateManager(db, user, candidateId) {
  if (candidateId === null || candidateId === undefined || candidateId === '') {
    return { ok: true, managerId: null };
  }

  if (isTopOfHierarchy(user.role)) {
    return {
      ok: false,
      status: 400,
      field: 'reportsToId',
      error: `${roleDef(user.role).label} sits at the top of the hierarchy and does not report to anyone.`,
    };
  }

  if (candidateId === user.id) {
    return { ok: false, status: 400, field: 'reportsToId', error: 'Someone cannot report to themselves.' };
  }

  const { rows } = await db.query('SELECT id, `name`, `role` FROM users WHERE id = $1', [candidateId]);
  if (!rows.length) {
    return { ok: false, status: 400, field: 'reportsToId', error: 'That manager does not exist.' };
  }
  const candidate = rows[0];

  // Walk up from the proposed manager. Reaching this user means the edit would
  // make the hierarchy eat its own tail.
  const seen = new Set([candidateId]);
  let currentId = candidateId;
  const path = [candidate.name];

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const { rows: step } = await db.query('SELECT reports_to_id FROM users WHERE id = $1', [currentId]);
    const nextId = step.length ? step[0].reports_to_id : null;
    if (!nextId) break;

    if (nextId === user.id) {
      return {
        ok: false,
        status: 400,
        field: 'reportsToId',
        error:
          `That would create a reporting loop: ${candidate.name} already reports to ${user.name}` +
          (path.length > 1 ? ` through ${path.slice(1).join(' → ')}` : '') + '.',
        chain: [...path, user.name],
      };
    }
    if (seen.has(nextId)) break; // a loop that already existed, above this edit
    seen.add(nextId);

    const { rows: next } = await db.query('SELECT id, `name` FROM users WHERE id = $1', [nextId]);
    if (!next.length) break;
    path.push(next[0].name);
    currentId = nextId;
  }

  return { ok: true, managerId: candidateId, manager: candidate };
}

/* Everyone this person could be recorded as reporting to.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A FILTER ANY MORE. This used to return only
 * the people a save would accept — everybody except the user and everybody
 * already beneath them. The studio's decision is that Reporting To is an
 * informational field, so the list is now EVERY OTHER ACCOUNT: no filtering by
 * role, by designation, by tier or by who leads whom.
 *
 * Two facts travel with each row instead of being used to remove it:
 *
 *   isActive    A deactivated account is still offered, marked. Dropping them
 *               would be worse than it sounds: editing somebody whose recorded
 *               manager has since been deactivated would find no matching
 *               option, the select would fall back to "not set", and saving any
 *               other field would silently CLEAR a reporting line nobody
 *               touched. Keeping them is what makes the form non-destructive.
 *
 *   wouldLoop   Picking them would make the hierarchy eat its own tail, and
 *               validateManager still refuses it. The row is returned so the
 *               form can say so up front rather than letting somebody choose an
 *               option that can only be rejected.
 *
 * The self row is the one genuine exclusion, and it is the one the studio asked
 * for: nobody reports to themselves.
 */
async function eligibleManagers(db, user) {
  if (isTopOfHierarchy(user.role)) return [];

  const { rows } = await db.query(
    'SELECT id, `name`, email, `role`, reports_to_id, is_active FROM users ORDER BY `name`'
  );

  // Everyone below this user, found by walking down rather than up: repeatedly
  // collect whoever reports to anyone already known to be beneath them.
  const below = new Set([user.id]);
  let grew = true;
  let passes = 0;
  while (grew && passes < MAX_DEPTH) {
    grew = false;
    passes++;
    for (const row of rows) {
      if (!below.has(row.id) && row.reports_to_id && below.has(row.reports_to_id)) {
        below.add(row.id);
        grew = true;
      }
    }
  }

  /* Everybody but the person themselves, each carrying whether they are still
     active and whether choosing them would close a loop. Nothing is removed
     for being the wrong role, the wrong tier, or somebody's junior. */
  return rows
    .filter((row) => row.id !== user.id)
    .map((row) => ({
      ...row,
      isActive: row.is_active !== 0,
      wouldLoop: below.has(row.id),
    }));
}

module.exports = { isTopOfHierarchy, chainAbove, validateManager, eligibleManagers, TOP_TIER, MAX_DEPTH };
