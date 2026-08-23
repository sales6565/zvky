const { ROLE_KEYS } = require('./roles');

// Small, idempotent schema repairs applied at startup.
//
// A database created from an earlier version of this app constrains users.role
// to the six roles that existed then. Those constraints are invisible until
// someone adds an Art Director, at which point the insert fails with
// ER_CHECK_CONSTRAINT_VIOLATED and the studio cannot staff itself. The database
// may well be on a managed host with no console to fix it by hand, so fix it
// here instead of documenting a manual step nobody can perform.
//
// Everything below checks the current state first and does nothing when the
// schema is already right, so it is safe on every boot.

// Constraints on `users` whose expression mentions the role column.
// MariaDB exposes TABLE_NAME on CHECK_CONSTRAINTS; MySQL 8 does not, so join
// through TABLE_CONSTRAINTS, which both provide.
async function roleCheckConstraints(db) {
  const { rows } = await db.query(
    `SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_NAME   = cc.CONSTRAINT_NAME
        AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_NAME = 'users'
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND tc.CONSTRAINT_SCHEMA = DATABASE()`
  );
  return rows.filter((r) => /\brole\b/i.test(r.clause || ''));
}

// A constraint is stale when it does not name every designation the app can
// currently assign — enumerating them is the only thing these constraints do.
function isStale(clause) {
  return ROLE_KEYS.some((key) => !clause.includes(`'${key}'`));
}

async function dropConstraint(db, name) {
  try {
    await db.query(`ALTER TABLE users DROP CHECK \`${name}\``); // MySQL 8
  } catch (err) {
    await db.query(`ALTER TABLE users DROP CONSTRAINT \`${name}\``); // MariaDB
  }
}

// The old column was TEXT; the designation keys are longer than some early
// VARCHAR sizings. Widen rather than assume.
async function widenRoleColumn(db, log) {
  const { rows } = await db.query(
    `SELECT DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`
  );
  if (!rows.length) return;
  const { type, len } = rows[0];
  const longest = Math.max(...ROLE_KEYS.map((k) => k.length));
  if (String(type).toLowerCase() === 'varchar' && Number(len) >= longest) return;
  await db.query('ALTER TABLE users MODIFY `role` VARCHAR(64) NOT NULL');
  log(`Schema: widened users.role to VARCHAR(64) (was ${type}${len ? `(${len})` : ''}).`);
}

// Databases created before password changes were possible have no column to
// record them in. Without it every token stays valid after a password change.
async function ensurePasswordChangedAt(db, log) {
  const { rows } = await db.query(
    `SELECT 1 AS present FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'password_changed_at'`
  );
  if (rows.length) return;
  await db.query('ALTER TABLE users ADD COLUMN password_changed_at BIGINT UNSIGNED NULL');
  log('Schema: added users.password_changed_at, so a password change can sign out other devices.');
}

async function run(db, log = console.log) {
  try {
    const stale = (await roleCheckConstraints(db)).filter((c) => isStale(c.clause));
    for (const c of stale) {
      await dropConstraint(db, c.name);
      log(
        `Schema: dropped CHECK constraint "${c.name}" on users.role — it predates the ` +
        'current designations and was rejecting them. Roles are validated by src/roles.js.'
      );
    }
    await widenRoleColumn(db, log);
    await ensurePasswordChangedAt(db, log);
  } catch (err) {
    // Never block startup on this: an unmigrated schema still serves everyone
    // whose role the old constraint allows, and the error handler now reports
    // the failure properly rather than taking the process down.
    log(`Schema check could not complete: ${err.sqlMessage || err.message}`);
  }
}

module.exports = { run };
