const { v4: uuid } = require('uuid');
const { roleKeys } = require('./roles');
const referenceData = require('./reference-data');
const ipAllowlist = require('./ip-allowlist');
const { applyTableOptions } = require('./db-collation');
const reporting = require('./reporting');
const catalog = require('./permission-catalog');
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

// The org-chart column and the contributor project link, for databases created
// before they existed.
async function ensureReportingAndMembership(db, log) {
  const { rows } = await db.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'reports_to_id'`
  );
  if (!rows.length) {
    await db.query('ALTER TABLE users ADD COLUMN reports_to_id CHAR(36) NULL AFTER team_lead_id');
    await db.query('ALTER TABLE users ADD KEY idx_users_reports_to (reports_to_id)');
    try {
      await db.query(
        'ALTER TABLE users ADD CONSTRAINT fk_users_reports_to FOREIGN KEY (reports_to_id) REFERENCES users(id) ON DELETE SET NULL'
      );
    } catch (err) {
      // The column is what matters; a database that refuses the constraint
      // still works, and saying so beats failing the whole migration.
      log(`Schema: reports_to_id added, but its foreign key was refused — ${err.sqlMessage || err.message}`);
    }
    log('Schema: added users.reports_to_id for the reporting hierarchy.');
  }

  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS project_members (
      project_id CHAR(36) NOT NULL,
      user_id    CHAR(36) NOT NULL,
      PRIMARY KEY (project_id, user_id),
      KEY idx_pm_user (user_id),
      CONSTRAINT fk_pm_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_pm_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  // Nobody at the top of the hierarchy reports to anyone. Clear anything a
  // database already holds for them, so the rule is true of the data and not
  // only of the form.
  const { rows: cleared } = await db.query(
    'SELECT id, `role` FROM users WHERE reports_to_id IS NOT NULL'
  );
  const top = cleared.filter((u) => reporting.isTopOfHierarchy(u.role));
  for (const user of top) {
    await db.query('UPDATE users SET reports_to_id = NULL WHERE id = $1', [user.id]);
  }
  if (top.length) log(`Schema: cleared the reporting line on ${top.length} account(s) at the top of the hierarchy.`);
}

// The review pipeline's columns, for databases created before it was a state
// machine: where an asset is routed, what a submission links to, and the event
// log behind the asset detail view.
async function ensureReviewWorkflow(db, log) {
  const column = async (table, name) => {
    const { rows } = await db.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND COLUMN_NAME = $2`,
      [table, name]
    );
    return rows.length > 0;
  };

  if (!(await column('assets', 'routed_to_id'))) {
    await db.query('ALTER TABLE assets ADD COLUMN routed_to_id CHAR(36) NULL AFTER assignee_id');
    await db.query('ALTER TABLE assets ADD KEY idx_assets_routed (routed_to_id)');
    try {
      await db.query('ALTER TABLE assets ADD CONSTRAINT fk_assets_routed FOREIGN KEY (routed_to_id) REFERENCES users(id) ON DELETE SET NULL');
    } catch (err) {
      log(`Schema: assets.routed_to_id added, but its foreign key was refused — ${err.sqlMessage || err.message}`);
    }
    // Everything mid-flight sits where the pipeline says it should.
    await db.query(
      `UPDATE assets SET routed_to_id = assignee_id
        WHERE routed_to_id IS NULL
          AND status IN ('in_progress','tl_changes_requested')`
    );
    log('Schema: added assets.routed_to_id so the pipeline can say whose desk an asset is on.');
  }

  if (!(await column('asset_versions', 'link'))) {
    await db.query('ALTER TABLE asset_versions ADD COLUMN link VARCHAR(2048) NULL AFTER stage');
    await db.query('ALTER TABLE asset_versions ADD COLUMN description TEXT NULL AFTER link');
    log('Schema: submissions now carry a link and a description.');
  }
  // A submission is a link now, so the file columns have to allow their absence.
  // Rows already holding a file keep it.
  for (const col of [['file_name', 'VARCHAR(255)'], ['file_path', 'VARCHAR(255)']]) {
    const { rows } = await db.query(
      `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_versions' AND COLUMN_NAME = $1`,
      [col[0]]
    );
    if (rows.length && rows[0].nullable === 'NO') {
      await db.query(`ALTER TABLE asset_versions MODIFY \`${col[0]}\` ${col[1]} NULL`);
    }
  }

  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS asset_events (
      id           CHAR(36)     NOT NULL PRIMARY KEY,
      seq          BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
      asset_id     CHAR(36)     NOT NULL,
      action       VARCHAR(32)  NOT NULL,
      from_status  VARCHAR(32)  NULL,
      to_status    VARCHAR(32)  NOT NULL,
      actor_id     CHAR(36)     NULL,
      actor_email  VARCHAR(191) NULL,
      note         TEXT         NULL,
      version_id   CHAR(36)     NULL,
      routed_to_id CHAR(36)     NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_events_asset (asset_id, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
}

// Roles whose access level changed after they were already seeded.
//
// seedReferenceTable only inserts what is missing, so a role that already
// exists keeps whatever tier it was created with — which is right for anything
// a Super Admin has edited, and wrong for a deliberate change like this one.
// Applied only where the tier is still the value it was seeded with, so a
// studio that has since moved a role somewhere else is left alone.
const RETIERED_ROLES = [
  { key: 'account_manager_marketing', from: 'staff', to: 'full_access' },
];

async function ensureRoleTiers(db, log) {
  for (const { key, from, to } of RETIERED_ROLES) {
    const { rows } = await db.query('SELECT tier FROM roles WHERE `key` = $1', [key]);
    if (!rows.length || rows[0].tier !== from) continue;
    await db.query('UPDATE roles SET tier = $1 WHERE `key` = $2 AND tier = $3', [to, key, from]);
    log(`Schema: "${key}" moved from the ${from} tier to ${to}.`);
  }
}

// Per-user permission grants and their audit trail.
async function ensurePermissionTables(db, log) {
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS user_permissions (
      user_id          CHAR(36)     NOT NULL,
      permission_key   VARCHAR(64)  NOT NULL,
      granted_by_id    CHAR(36)     NULL,
      granted_by_email VARCHAR(191) NULL,
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, permission_key),
      KEY idx_user_permissions_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS permission_audit (
      id             CHAR(36)     NOT NULL PRIMARY KEY,
      seq            BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
      subject_id     CHAR(36)     NULL,
      subject_email  VARCHAR(191) NULL,
      permission_key VARCHAR(64)  NOT NULL,
      action         VARCHAR(16)  NOT NULL,
      actor_id       CHAR(36)     NULL,
      actor_email    VARCHAR(191) NULL,
      created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_perm_audit_subject (subject_id, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  // A grant naming a permission the catalogue no longer has is dead weight and
  // would show as an unexplained row on the screen.
  const { rows } = await db.query('SELECT DISTINCT permission_key FROM user_permissions');
  const stale = rows.map((r) => r.permission_key).filter((k) => !catalog.isPermission(k));
  for (const key of stale) {
    await db.query('DELETE FROM user_permissions WHERE permission_key = $1', [key]);
    log(`Schema: dropped grants for "${key}", which is not a permission any more.`);
  }
}

async function ensureReferenceData(db, log) {
  // Created with the collation the rest of the schema already uses, so a later
  // query can compare these columns against the older tables.
  for (const sql of Object.values(REFERENCE_TABLES)) await db.query(await applyTableOptions(db, sql));

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
  //
  // Deliberately two queries and a comparison here rather than a LEFT JOIN.
  // Joining users.role to roles.key compares two string columns, and if those
  // tables carry different collations — which happens when one was created by
  // an older server than the other — MySQL refuses the whole statement with
  // "Illegal mix of collations" and takes this migration down with it. That is
  // how a production deploy lost its reference tables. A set difference in
  // JavaScript cannot have that problem, and both lists are small.
  const { rows: held } = await db.query('SELECT DISTINCT `role` AS role FROM users');
  const { rows: known } = await db.query('SELECT `key` AS `key` FROM roles');
  const knownKeys = new Set(known.map((r) => r.key));
  const orphans = held.filter((r) => r.role && !knownKeys.has(r.role));
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


// The address the studio starts with. Seeded only into an empty table, so a
// Super Admin who removes it does not find it back after the next restart.
// Override for a different first address with IP_ALLOWLIST_SEED.
// Set IP_ALLOWLIST_SEED to an empty string to seed nothing at all — checked
// against undefined rather than truthiness so that "" means "none" instead of
// quietly falling back to the default.
const SEED_ADDRESSES = String(
  process.env.IP_ALLOWLIST_SEED === undefined ? '106.51.81.61' : process.env.IP_ALLOWLIST_SEED
)
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((address) => ({ address, label: 'Seeded on first run' }));

// Create the allowlist tables, seed a first address into an empty list, and
// load the mirror the gate reads. Reports loudly on failure: this is
// access-control storage, and a studio that believes it is restricted when it
// is not is worse off than one that knows it is open.
async function ensureIpAllowlist(db, log) {
  const result = await ipAllowlist.install(db, SEED_ADDRESSES);
  if (result.seeded) log(`Schema: seeded ${result.seeded} address(es) into the IP allowlist.`);
  if (!result.ok) {
    log('');
    log('*** IP ALLOWLIST STORAGE IS UNAVAILABLE ***');
    log(`    ${result.state === 'missing-tables'
      ? 'The ip_allowlist tables do not exist and could not be created.'
      : 'The ip_allowlist tables could not be read.'}`);
    log(`    ${result.code || 'error'}: ${result.detail}`);
    log('    Access is NOT being restricted by IP address. Every address can reach this app.');
    log('    Fix: give the database user CREATE privileges and restart, or apply the two');
    log('    CREATE TABLE statements in sql/schema.sql by hand, then use the Repair button');
    log('    on Settings -> Allowed IP Addresses.');
    log('');
  }
  return result;
}

async function dropStaleRoleConstraints(db, log) {
  const stale = (await roleCheckConstraints(db)).filter((c) => isStale(c.clause));
  for (const c of stale) {
    await dropConstraint(db, c.name);
    log(
      `Schema: dropped CHECK constraint "${c.name}" on users.role — it predates the ` +
      'current designations and was rejecting them. Roles are validated by src/roles.js.'
    );
  }
}

// Each repair is independent, and is applied independently.
//
// These used to share one try/catch, which meant the first failure skipped
// every step after it and said so in a single line nobody reads. That is how
// the IP allowlist tables came to be missing on a running deployment: an
// unrelated step above them failed, they were never created, and the only
// symptom was a generic database error on one screen. A step that cannot be
// applied is now reported on its own and the rest still run.
//
// Order still matters where one step feeds another, which is why this is a list
// rather than a set of parallel calls.
const STEPS = [
  ['stale role constraints', dropStaleRoleConstraints],
  ['users.role column width', widenRoleColumn],
  ['users.password_changed_at', ensurePasswordChangedAt],
  ['type and priority constraints', dropValueConstraints],
  ['reference tables', ensureReferenceData],
  // Reads the tables the step above creates and fills.
  // Before the mirror loads, so the change is in what everything else reads.
  ['role access tiers', ensureRoleTiers],
  ['reference data mirror', (db) => referenceData.load(db)],
  // After the mirror: isTopOfHierarchy reads a role's tier from it.
  ['reporting hierarchy', ensureReportingAndMembership],
  ['review pipeline', ensureReviewWorkflow],
  ['user permissions', ensurePermissionTables],
  ['IP allowlist', ensureIpAllowlist],
];

async function run(db, log = console.log) {
  const failed = [];
  for (const [name, step] of STEPS) {
    try {
      await step(db, log);
    } catch (err) {
      // Never block startup on a schema repair: an unmigrated schema still
      // serves most of the app, and the request-level error handler reports
      // what breaks rather than taking the process down.
      failed.push(name);
      log(`Schema: "${name}" could not be applied — ${err.sqlMessage || err.message}`);
    }
  }
  if (failed.length) {
    log(
      `Schema: ${failed.length} of ${STEPS.length} startup repairs did not apply ` +
      `(${failed.join(', ')}). The app is running; parts of it may not work until these are fixed.`
    );
  }
  return { failed };
}

module.exports = { run };
