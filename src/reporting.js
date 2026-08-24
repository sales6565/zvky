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

// Everyone this person could report to: not themselves, and nobody already
// beneath them. Used to build the dropdown, so the form does not offer a choice
// the API would then refuse.
async function eligibleManagers(db, user) {
  if (isTopOfHierarchy(user.role)) return [];

  const { rows } = await db.query(
    'SELECT id, `name`, email, `role`, reports_to_id FROM users ORDER BY `name`'
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

  return rows.filter((row) => !below.has(row.id));
}

module.exports = { isTopOfHierarchy, chainAbove, validateManager, eligibleManagers, TOP_TIER, MAX_DEPTH };
