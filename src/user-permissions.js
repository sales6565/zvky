// Reading and writing the per-user grants.
//
// The effective set is computed rather than stored: baseline from the role's
// tier, plus whatever rows exist here. Storing the effective set would mean a
// role change silently failing to reach the people holding it, which is exactly
// the bug this module exists to avoid.

const { v4: uuid } = require('uuid');
const catalog = require('./permission-catalog');

async function grantedFor(db, userId) {
  const { rows } = await db.query(
    'SELECT permission_key FROM user_permissions WHERE user_id = $1',
    [userId]
  );
  return rows.map((r) => r.permission_key);
}

// Grants for several people at once, for the screen that lists them.
async function grantedForMany(db, userIds) {
  const byUser = new Map();
  if (!userIds.length) return byUser;
  const { rows } = await db.query(
    'SELECT user_id, permission_key FROM user_permissions WHERE user_id IN (?)',
    [userIds]
  );
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.permission_key);
  }
  return byUser;
}

// Replace somebody's grants with exactly this set, recording each change.
//
// Written as a diff rather than delete-then-insert so the audit trail says what
// actually changed. "Saved 27 permissions" is not an audit trail.
async function setGrants(db, subject, wantedKeys, actor) {
  const grantable = new Set(catalog.grantableKeys());
  const wanted = new Set(
    (wantedKeys || []).filter((k) => catalog.isPermission(k) && grantable.has(k))
  );
  const current = new Set(await grantedFor(db, subject.id));

  const added = [...wanted].filter((k) => !current.has(k));
  const removed = [...current].filter((k) => !wanted.has(k));

  for (const key of added) {
    await db.query(
      `INSERT IGNORE INTO user_permissions (user_id, permission_key, granted_by_id, granted_by_email)
       VALUES ($1,$2,$3,$4)`,
      [subject.id, key, actor.id, actor.email]
    );
  }
  for (const key of removed) {
    await db.query(
      'DELETE FROM user_permissions WHERE user_id = $1 AND permission_key = $2',
      [subject.id, key]
    );
  }
  for (const [keys, action] of [[added, 'granted'], [removed, 'revoked']]) {
    for (const key of keys) {
      await db.query(
        `INSERT INTO permission_audit (id, subject_id, subject_email, permission_key, action, actor_id, actor_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), subject.id, subject.email, key, action, actor.id, actor.email]
      );
      console.log(`[permissions] ${actor.email} ${action} "${key}" ${action === 'granted' ? 'to' : 'from'} ${subject.email}`);
    }
  }

  return { added, removed, granted: [...wanted] };
}

async function auditFor(db, subjectId, limit = 100) {
  const capped = Math.min(Number(limit) || 100, 500);
  const { rows } = subjectId
    ? await db.query(
        'SELECT * FROM permission_audit WHERE subject_id = $1 ORDER BY seq DESC LIMIT $2',
        [subjectId, capped]
      )
    : await db.query('SELECT * FROM permission_audit ORDER BY seq DESC LIMIT $1', [capped]);
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject_email,
    permission: r.permission_key,
    permissionLabel: (catalog.BY_KEY.get(r.permission_key) || {}).label || r.permission_key,
    action: r.action,
    actor: r.actor_email || 'system',
    at: r.created_at,
  }));
}

module.exports = { grantedFor, grantedForMany, setGrants, auditFor };
