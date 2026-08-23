const { v4: uuid } = require('uuid');
const { roleKeys } = require('./roles');
const referenceData = require('./reference-data');
const defaults = require('./reference-defaults');

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
  return roleKeys().some((key) => !clause.includes(`'${key}'`));
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
  const longest = Math.max(...roleKeys().map((k) => k.length));
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


// Asset types and priorities are managed in Settings now, so the CHECK
// constraints enumerating the old fixed values would reject anything added.
// Same reasoning as the role constraint above, and the same treatment.
async function dropValueConstraints(db, log) {
  for (const column of ['type', 'priority']) {
    const { rows } = await db.query(
      `SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
         FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc
           ON tc.CONSTRAINT_NAME   = cc.CONSTRAINT_NAME
          AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        WHERE tc.TABLE_NAME = 'assets'
          AND tc.CONSTRAINT_TYPE = 'CHECK'
          AND tc.CONSTRAINT_SCHEMA = DATABASE()`
    );
    for (const constraint of rows) {
      // Only the one enumerating this column's values; `status` keeps its own.
      const clause = String(constraint.clause || '');
      if (!new RegExp(`\\b${column}\\b`, 'i').test(clause)) continue;
      if (/status/i.test(clause)) continue;
      try {
        await db.query(`ALTER TABLE assets DROP CHECK \`${constraint.name}\``);
      } catch {
        await db.query(`ALTER TABLE assets DROP CONSTRAINT \`${constraint.name}\``);
      }
      log(
        `Schema: dropped CHECK constraint "${constraint.name}" on assets.${column} — ` +
        `those values are managed in Settings now and validated against the reference tables.`
      );
    }
  }
}

// The reference tables, for databases created before they existed.
const REFERENCE_TABLES = {
  asset_types: `CREATE TABLE IF NOT EXISTS asset_types (
      id CHAR(36) NOT NULL PRIMARY KEY,
      \`key\` VARCHAR(64) NOT NULL,
      label VARCHAR(100) NOT NULL,
      code_prefix VARCHAR(8) NOT NULL,
      color VARCHAR(16) NULL,
      position INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_types_key (\`key\`),
      UNIQUE KEY uq_asset_types_prefix (code_prefix)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  priorities: `CREATE TABLE IF NOT EXISTS priorities (
      id CHAR(36) NOT NULL PRIMARY KEY,
      \`key\` VARCHAR(64) NOT NULL,
      label VARCHAR(100) NOT NULL,
      color VARCHAR(16) NULL,
      position INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_priorities_key (\`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  roles: `CREATE TABLE IF NOT EXISTS roles (
      id CHAR(36) NOT NULL PRIMARY KEY,
      \`key\` VARCHAR(64) NOT NULL,
      label VARCHAR(150) NOT NULL,
      group_name VARCHAR(100) NOT NULL,
      tier VARCHAR(32) NOT NULL,
      color VARCHAR(16) NULL,
      position INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_roles_key (\`key\`),
      KEY idx_roles_tier (tier)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

// Fill a reference table from the values the app used to hold in code. Only
// ever inserts what is missing, so it is safe on every start and never
// overwrites something edited in Settings.
async function seedReferenceTable(db, table, rows, toValues, log) {
  const { rows: existing } = await db.query(`SELECT \`key\` FROM ${table}`);
  const present = new Set(existing.map((r) => r.key));
  const missing = rows.filter((r) => !present.has(r.key));
  if (!missing.length) return;

  for (const row of missing) {
    const { columns, values } = toValues(row);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,
      values
    );
  }
  log(`Schema: seeded ${missing.length} ${table.replace('_', ' ')} into the new reference table.`);
}

async function ensureReferenceData(db, log) {
  for (const sql of Object.values(REFERENCE_TABLES)) await db.query(sql);

  await seedReferenceTable(db, 'asset_types', defaults.ASSET_TYPES, (r) => ({
    columns: ['id', '`key`', 'label', 'code_prefix', 'color', 'position', 'is_active', 'is_system'],
    values: [uuid(), r.key, r.label, r.codePrefix, r.color, r.position, 1, r.isSystem ? 1 : 0],
  }), log);

  await seedReferenceTable(db, 'priorities', defaults.PRIORITIES, (r) => ({
    columns: ['id', '`key`', 'label', 'color', 'position', 'is_active', 'is_system'],
    values: [uuid(), r.key, r.label, r.color, r.position, 1, r.isSystem ? 1 : 0],
  }), log);

  await seedReferenceTable(db, 'roles', defaults.ROLES, (r) => ({
    columns: ['id', '`key`', 'label', 'group_name', 'tier', 'color', 'position', 'is_active', 'is_system'],
    values: [uuid(), r.key, r.label, r.group, r.tier, r.color, r.position, 1, r.isSystem ? 1 : 0],
  }), log);

  // Any role a person already holds that the table does not know about — from
  // a database that predates this, or a role deleted by hand. Carry it across
  // rather than leaving those accounts unable to sign in.
  const { rows: orphans } = await db.query(
    'SELECT DISTINCT u.`role` AS role FROM users u LEFT JOIN roles r ON r.`key` = u.`role` WHERE r.`key` IS NULL'
  );
  for (const orphan of orphans) {
    if (!orphan.role) continue;
    const label = String(orphan.role).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    await db.query(
      'INSERT INTO roles (id, `key`, label, group_name, tier, color, position, is_active, is_system) VALUES ($1,$2,$3,$4,$5,$6,$7,1,0)',
      [uuid(), orphan.role, label, 'Unsorted', 'staff', null, 0]
    );
    log(
      `Schema: "${orphan.role}" is held by an account but was not in the catalogue. ` +
      `Added it under Unsorted with no pipeline access — set its group and tier in Settings.`
    );
  }
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
    await dropValueConstraints(db, log);
    await ensureReferenceData(db, log);
    // Load the mirror the permission checks read from. Everything above must
    // have run first: it is reading the tables this just created and filled.
    await referenceData.load(db);
  } catch (err) {
    // Never block startup on this: an unmigrated schema still serves everyone
    // whose role the old constraint allows, and the error handler now reports
    // the failure properly rather than taking the process down.
    log(`Schema check could not complete: ${err.sqlMessage || err.message}`);
  }
}

module.exports = { run };
