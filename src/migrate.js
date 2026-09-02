const { v4: uuid } = require('uuid');
const { roleKeys, roleDef } = require('./roles');
const referenceData = require('./reference-data');
const ipAllowlist = require('./ip-allowlist');
const { applyTableOptions } = require('./db-collation');
const reporting = require('./reporting');
const catalog = require('./permission-catalog');
const rolePermissions = require('./role-permissions');
const defaults = require('./reference-defaults');
const branding = require('./branding');
const workSchedule = require('./work-schedule');
const { normalizeCheckClause } = require('./schema-check');

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
  return rows.filter((r) => /\brole\b/i.test(r.clause || ''))
    .map((r) => ({ ...r, clause: normalizeCheckClause(r.clause) }));
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
      const clause = normalizeCheckClause(constraint.clause);
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
  categories: `CREATE TABLE IF NOT EXISTS categories (
      id CHAR(36) NOT NULL PRIMARY KEY,
      \`key\` VARCHAR(64) NOT NULL,
      label VARCHAR(100) NOT NULL,
      color VARCHAR(16) NULL,
      position INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_categories_key (\`key\`)
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

// A whole project put in front of the Creative Director. Its own table, not a
// status on assets — see sql/schema.sql for why. The notifications table also
// gains a project_id, so a request can point at something that is not an asset.
async function ensureProjectReviews(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_review_requests'`
  );
  if (!table.length) {
    await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS project_review_requests (
        id           CHAR(36)      NOT NULL PRIMARY KEY,
        client_id    CHAR(36)      NOT NULL,
        project_id   CHAR(36)      NOT NULL,
        link         VARCHAR(2048) NOT NULL,
        description  TEXT          NULL,
        submitted_by CHAR(36)      NULL,
        submitter_email VARCHAR(191) NULL,
        status       VARCHAR(32)   NOT NULL DEFAULT 'pending',
        feedback     TEXT          NULL,
        reviewed_by  CHAR(36)      NULL,
        reviewer_email VARCHAR(191) NULL,
        reviewed_at  DATETIME      NULL,
        created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_prr_status (status, created_at),
        KEY idx_prr_project (project_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
    /* Tolerantly, like the notifications keys: a deployment whose user cannot
       create constraints must still get a working table. */
    const fk = async (sql) => { await db.query(sql).catch(() => {}); };
    await fk('ALTER TABLE project_review_requests ADD CONSTRAINT fk_prr_client '
      + 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE');
    await fk('ALTER TABLE project_review_requests ADD CONSTRAINT fk_prr_project '
      + 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
    await fk('ALTER TABLE project_review_requests ADD CONSTRAINT fk_prr_submitter '
      + 'FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL');
    await fk('ALTER TABLE project_review_requests ADD CONSTRAINT fk_prr_reviewer '
      + 'FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL');
    log('Schema: added project_review_requests.');
  }
  /* Everything below runs whether or not the table was just created, so a
     deployment that got the first version of it picks up the rest. */

  /* The Creative Director's written answer, added after the table shipped with
     only a pending/reviewed flag on it. The status column is widened at the
     same time: 'approved_for_client' does not fit VARCHAR(16). */
  const { rows: fb } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_review_requests'
        AND COLUMN_NAME = 'feedback'`
  );
  if (!fb.length) {
    await db.query('ALTER TABLE project_review_requests ADD COLUMN feedback TEXT NULL AFTER status')
      .catch(() => {});
    log('Schema: added project_review_requests.feedback.');
  }
  await db.query("ALTER TABLE project_review_requests MODIFY `status` VARCHAR(32) NOT NULL DEFAULT 'pending'")
    .catch(() => {});

  /* Production's "I have dealt with this". Added after the two decisions
     shipped, so a database that has them picks these up without intervention. */
  const { rows: closed } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_review_requests'
        AND COLUMN_NAME = 'closed_at'`
  );
  if (!closed.length) {
    for (const sql of [
      'ALTER TABLE project_review_requests ADD COLUMN closed_by CHAR(36) NULL AFTER reviewed_at',
      'ALTER TABLE project_review_requests ADD COLUMN closer_email VARCHAR(191) NULL AFTER closed_by',
      'ALTER TABLE project_review_requests ADD COLUMN closed_at DATETIME NULL AFTER closer_email',
    ]) await db.query(sql).catch(() => {});
    log('Schema: added project_review_requests.closed_at and who closed it.');
  }

  const { rows: column } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'project_id'`
  );
  if (!column.length) {
    await db.query('ALTER TABLE notifications ADD COLUMN project_id CHAR(36) NULL AFTER asset_id');
    await db.query('ALTER TABLE notifications ADD KEY idx_notifications_project (project_id)')
      .catch(() => {});
    log('Schema: added notifications.project_id.');
  }
}

// Bulk actions, added after the event log already existed: the batch record
// itself, and the column on each event pointing back at it.
async function ensureEventBatches(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_event_batches'`
  );
  if (!table.length) {
    await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS asset_event_batches (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        action      VARCHAR(32)  NOT NULL,
        actor_id    CHAR(36)     NULL,
        actor_email VARCHAR(191) NULL,
        requested   INT          NOT NULL DEFAULT 0,
        succeeded   INT          NOT NULL DEFAULT 0,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_batches_actor (actor_id, created_at),
        CONSTRAINT fk_batches_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
    log('Schema: added asset_event_batches for bulk actions.');
  }

  const { rows: column } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_events' AND COLUMN_NAME = 'batch_id'`
  );
  if (!column.length) {
    await db.query('ALTER TABLE asset_events ADD COLUMN batch_id CHAR(36) NULL AFTER routed_to_id');
    await db.query('ALTER TABLE asset_events ADD KEY idx_events_batch (batch_id)');
    log('Schema: added asset_events.batch_id.');
  }
}

// The people answerable for a project's look, added after the project form
// already had its two membership lists. Its own table, following the shape the
// other two set, rather than a column on projects: the field holds up to two
// user ids and a join table is what the rest of the app already reads.
async function ensureProjectSupervision(db, log) {
  const { rows } = await db.query(
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_supervision'`
  );
  if (rows.length) return;
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS project_supervision (
      project_id CHAR(36) NOT NULL,
      user_id    CHAR(36) NOT NULL,
      PRIMARY KEY (project_id, user_id),
      KEY idx_ps_user (user_id),
      CONSTRAINT fk_ps_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_ps_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
  log('Schema: added project_supervision for supervision and creative direction.');
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

  // Checked separately for the same reason as tasks.created_by above: two
  // columns behind one probe cannot recover from a half-applied run.
  if (!(await column('asset_versions', 'description'))) {
    await db.query('ALTER TABLE asset_versions ADD COLUMN description TEXT NULL');
  }
  if (!(await column('asset_versions', 'link'))) {
    await db.query('ALTER TABLE asset_versions ADD COLUMN link VARCHAR(2048) NULL AFTER stage');
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

  // CREATE TABLE IF NOT EXISTS does nothing to a table that is already there —
  // including one from a version of this app that had fewer columns. So a
  // database carrying an older asset_events kept it, and every write to the
  // history failed on the missing column. That failure landed *after* the asset
  // itself had been updated, so reassigning an asset changed the row and then
  // answered 500: the studio was told the change had failed, over a change that
  // had happened. Patch the columns individually, each behind its own probe.
  for (const [name, definition] of [
    ['from_status',  'VARCHAR(32) NULL'],
    ['to_status',    "VARCHAR(32) NOT NULL DEFAULT ''"],
    ['actor_id',     'CHAR(36) NULL'],
    ['actor_email',  'VARCHAR(191) NULL'],
    ['note',         'TEXT NULL'],
    ['version_id',   'CHAR(36) NULL'],
    ['routed_to_id', 'CHAR(36) NULL'],
    ['created_at',   'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ]) {
    if (await column('asset_events', name)) continue;
    await db.query(`ALTER TABLE asset_events ADD COLUMN \`${name}\` ${definition}`);
    log(`Schema: added asset_events.${name} — without it, recording a reassignment failed`);
    log('         after the asset had already been updated.');
  }
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

// Role permissions, and the removal of the per-user grants they replace.
async function ensurePermissionTables(db, log) {
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS role_permissions (
      role_key         VARCHAR(64)  NOT NULL,
      permission_key   VARCHAR(64)  NOT NULL,
      enabled          TINYINT(1)   NOT NULL DEFAULT 0,
      updated_by_id    CHAR(36)     NULL,
      updated_by_email VARCHAR(191) NULL,
      updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (role_key, permission_key),
      KEY idx_role_permissions_role (role_key, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS role_permission_audit (
      id             CHAR(36)     NOT NULL PRIMARY KEY,
      seq            BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
      role_key       VARCHAR(64)  NOT NULL,
      permission_key VARCHAR(64)  NOT NULL,
      action         VARCHAR(16)  NOT NULL,
      actor_id       CHAR(36)     NULL,
      actor_email    VARCHAR(191) NULL,
      created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_role_perm_audit (role_key, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  // Seed from what each role's tier already implies, so switching to this table
  // changes nobody's access on the day it goes live. Only roles with no rows
  // are touched: a studio that has since configured a role keeps its settings.
  const { rows: configured } = await db.query('SELECT DISTINCT role_key FROM role_permissions');
  const known = new Set(configured.map((r) => r.role_key));
  let seeded = 0;
  for (const role of referenceData.list('roles', { includeInactive: true })) {
    if (known.has(role.key)) continue;
    await rolePermissions.seedRole(db, role.key);
    seeded++;
  }
  if (seeded) log(`Schema: seeded permissions for ${seeded} role(s) from their tiers.`);

  // A permission the catalogue no longer has is dead weight on the screen.
  const { rows } = await db.query('SELECT DISTINCT permission_key FROM role_permissions');
  for (const key of rows.map((r) => r.permission_key).filter((k) => !catalog.isPermission(k))) {
    await db.query('DELETE FROM role_permissions WHERE permission_key = $1', [key]);
    log(`Schema: dropped role permissions for "${key}", which is not a permission any more.`);
  }

  // The per-user grants this replaces. Dropped rather than left behind, so
  // nothing reads a table the app no longer honours.
  for (const table of ['user_permissions', 'permission_audit']) {
    const { rows: present } = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1`, [table]
    );
    if (Number(present[0].n) > 0) {
      await db.query(`DROP TABLE ${table}`);
      log(`Schema: dropped ${table} — per-user permission grants were replaced by role permissions.`);
    }
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
// assets.created_by — who added an asset, which is what "Asset Edit" is scoped
// to for a role that holds the permission without full access.
//
// The backfill is deliberately conservative. Nothing recorded a creation event,
// so the only signal in the data is the FIRST row in asset_events: when that is
// an `assign`, it was written at creation (or at the first assignment) by the
// person doing the assigning, which is the closest thing to a creator this
// database has. Any other first event — or none at all — leaves created_by
// NULL rather than guessing, because guessing wrong here hands editing rights
// to the wrong person. An asset created with no assignee and never assigned has
// no trace of its creator at all.
//
// NULL is a real answer, not a gap: an unowned asset can be edited by a
// full-access role, or by whoever it is assigned to, and by nobody else.
async function ensureAssetOwnership(db, log) {
  const { rows: present } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND COLUMN_NAME = 'created_by'`
  );
  if (present.length) return;

  await db.query('ALTER TABLE assets ADD COLUMN created_by CHAR(36) NULL AFTER routed_to_id');
  await db.query('ALTER TABLE assets ADD KEY idx_assets_creator (created_by)');
  try {
    await db.query(
      'ALTER TABLE assets ADD CONSTRAINT fk_assets_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL'
    );
  } catch (err) {
    log(`Schema: assets.created_by added, but its foreign key was refused — ${err.sqlMessage || err.message}`);
  }

  await db.query(
    `UPDATE assets a
        SET a.created_by = (
          SELECT e.actor_id FROM asset_events e
           WHERE e.asset_id = a.id AND e.action = 'assign'
           ORDER BY e.seq ASC LIMIT 1
        )
      WHERE a.created_by IS NULL`
  );

  const { rows: counted } = await db.query(
    `SELECT COUNT(*) AS total, SUM(created_by IS NULL) AS unowned FROM assets`
  );
  const total = Number(counted[0].total);
  const unowned = Number(counted[0].unowned);
  log(`Schema: added assets.created_by — ${total - unowned} of ${total} asset(s) attributed from the history.`);
  if (unowned) {
    log(`         ${unowned} asset(s) could not be attributed and are unowned: editable by a`);
    log('         full-access role, or by whoever they are assigned to, and by nobody else.');
    log('         Reassign or re-add them if somebody below that tier needs to edit them.');
  }
}

// clients, and projects.client_id.
//
// Projects predate clients, so every existing one needs somewhere to belong
// before the column can be NOT NULL. They go to a seeded system client called
// "Unassigned" — flagged for review because it is a real editorial decision
// rather than a technical one: the alternative was a nullable client_id, which
// would have meant every screen and query carrying an "or no client" branch
// forever. A placeholder keeps the model honest — everything has a client — and
// leaves one obvious list of projects for somebody to sort into real clients.
// The row can be renamed but not deleted.
async function ensureClients(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clients'`
  );
  if (!table.length) {
    await db.query(await applyTableOptions(db, `CREATE TABLE clients (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      \`name\`        VARCHAR(255) NOT NULL,
      contact_name  VARCHAR(255) NULL,
      contact_email VARCHAR(191) NULL,
      notes         TEXT         NULL,
      is_system     TINYINT(1)   NOT NULL DEFAULT 0,
      created_by    CHAR(36)     NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_clients_name (\`name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
    log('Schema: added the clients table.');
  }

  /* The key above is added once, when the column is. A boot that could not
     create it — most often because clients and projects disagreed on collation,
     which a key will not span — never tried again, so the constraint stayed
     missing for the life of the database. Now the collations are aligned first,
     this puts back what that boot could not. */
  const { rows: hasFk } = await db.query(
    `SELECT CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_projects_client'`
  );
  if (!hasFk.length) {
    try {
      await db.query('ALTER TABLE projects ADD CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT');
      log('Schema: restored the projects -> clients foreign key, which an earlier boot could not create.');
    } catch (err) {
      log(`Schema: the projects -> clients foreign key is still missing — ${err.sqlMessage || err.message}`);
    }
  }

  // The placeholder, created before the column that needs it.
  const placeholder = await ensurePlaceholderClient(db);

  const { rows: column } = await db.query(
    `SELECT COLUMN_NAME AS n, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'client_id'`
  );
  if (!column.length) {
    // Added nullable, filled, then tightened — a NOT NULL column cannot be
    // added to a table that already has rows.
    await db.query('ALTER TABLE projects ADD COLUMN client_id CHAR(36) NULL AFTER `code`');
    await db.query('ALTER TABLE projects ADD KEY idx_projects_client (client_id)');
  }
  const { rows: moved } = await db.query(
    'UPDATE projects SET client_id = $1 WHERE client_id IS NULL', [placeholder]
  );
  const orphans = moved && moved.affectedRows !== undefined ? moved.affectedRows : 0;

  if (!column.length || column[0].nullable === 'YES') {
    await db.query('ALTER TABLE projects MODIFY client_id CHAR(36) NOT NULL');
    try {
      await db.query('ALTER TABLE projects ADD CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT');
    } catch (err) {
      log(`Schema: projects.client_id added, but its foreign key was refused — ${err.sqlMessage || err.message}`);
    }
    const { rows: counted } = await db.query('SELECT COUNT(*) AS n FROM projects');
    log(`Schema: every project now belongs to a client. ${Number(counted[0].n)} project(s) moved to "Unassigned".`);
    log('         Rename it or move those projects to real clients from the Projects tab.');
  } else if (orphans) {
    log(`Schema: ${orphans} project(s) had no client and were moved to "Unassigned".`);
  }
}

// The one client that always exists. Created by id lookup on name so running
// the migration twice cannot make a second one.
async function ensurePlaceholderClient(db) {
  const { v4: uuid } = require('uuid');
  const { rows } = await db.query('SELECT id FROM clients WHERE is_system = 1 LIMIT 1');
  if (rows.length) return rows[0].id;
  const { rows: named } = await db.query('SELECT id FROM clients WHERE `name` = $1', ['Unassigned']);
  if (named.length) {
    await db.query('UPDATE clients SET is_system = 1 WHERE id = $1', [named[0].id]);
    return named[0].id;
  }
  const id = uuid();
  await db.query(
    'INSERT INTO clients (id, `name`, notes, is_system) VALUES ($1,$2,$3,1)',
    [id, 'Unassigned', 'Projects that existed before clients did. Move them to a real client and this can be left empty.']
  );
  return id;
}

// Every role holds a row for every permission in the catalogue.
//
// Roles were seeded once, when they were first read, and never revisited. A
// permission added to the catalogue afterwards got no row for any existing
// role, and a missing row reads as "not allowed" — so every role quietly failed
// to hold every permission introduced after it was seeded. That is what took
// the Projects tab away from Super Admin: `client.view` arrived after
// super_admin had been seeded, so the row simply was not there.
//
// The checks now top a role up on read as well, so this is belt and braces —
// but doing it at startup means the table matches what the app enforces, and
// the Role Permissions screen shows the truth rather than a gap.
async function ensurePermissionCatalogueComplete(db, log) {
  const catalog = require('./permission-catalog');
  const rolePermissions = require('./role-permissions');
  const { catalogue } = require('./roles');

  const { rows: written } = await db.query('SELECT role_key, permission_key FROM role_permissions');
  if (!written.length) return; // nothing seeded yet; first read will do it properly

  const byRole = new Map();
  for (const row of written) {
    if (!byRole.has(row.role_key)) byRole.set(row.role_key, new Set());
    byRole.get(row.role_key).add(row.permission_key);
  }

  let added = 0;
  const touched = [];
  for (const [roleKey, keys] of byRole) {
    const missing = catalog.KEYS.filter((k) => !keys.has(k));
    if (!missing.length) continue;
    const defaults = rolePermissions.defaultsFor(roleKey);
    for (const key of missing) {
      await db.query(
        `INSERT IGNORE INTO role_permissions (role_key, permission_key, enabled, updated_by_email)
         VALUES ($1,$2,$3,'system')`,
        [roleKey, key, defaults.has(key) ? 1 : 0]
      );
      added += 1;
    }
    touched.push(`${roleKey} (+${missing.length})`);
  }

  // And the Super Admin role holds everything, whatever the table says.
  const superAdmin = catalogue().find((r) => r.tier === 'super_admin');
  if (superAdmin) {
    const { rows: off } = await db.query(
      'SELECT permission_key FROM role_permissions WHERE role_key = $1 AND enabled = 0',
      [superAdmin.key]
    );
    if (off.length) {
      await db.query('UPDATE role_permissions SET enabled = 1 WHERE role_key = $1', [superAdmin.key]);
      log(`Schema: switched ${off.length} permission(s) back on for the ${superAdmin.label} role — it holds the whole catalogue by definition.`);
    }
  }

  if (added) {
    log(`Schema: ${added} permission row(s) added for roles that predate them — ${touched.join(', ')}.`);
  }
}

// Archive and status columns on clients and projects.
//
// Named is_active/archived_at rather than is_deleted, because that is what this
// codebase already calls the idea: asset types, priorities, roles and allowlist
// entries all deactivate rather than delete when something depends on them.
// A second vocabulary for the same concept would be the harder thing to read.
async function ensureLifecycleColumns(db, log) {
  const has = async (table, column) => {
    const { rows } = await db.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND COLUMN_NAME = $2`,
      [table, column]
    );
    return rows.length > 0;
  };

  const added = [];
  const columns = [
    ['clients', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['clients', 'archived_at', 'DATETIME NULL'],
    ['clients', 'deal_closed_at', 'DATETIME NULL'],
    ['projects', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['projects', 'archived_at', 'DATETIME NULL'],
    ['projects', 'closed_at', 'DATETIME NULL'],
  ];
  for (const [table, column, type] of columns) {
    if (await has(table, column)) continue;
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    added.push(`${table}.${column}`);
  }
  if (added.includes('projects.is_active')) {
    await db.query('ALTER TABLE projects ADD KEY idx_projects_active (is_active)');
  }
  if (added.length) {
    // Everything that exists today is live and open — the defaults say so, and
    // this is stated rather than assumed.
    log(`Schema: added ${added.join(', ')}. Every existing client and project is active and open.`);
  }
}

// assets.reference_link, and authorship on the checklist.
//
// The checklist extends the tasks table that is already there rather than
// arriving as a second one. Existing rows keep working: created_by is NULL on
// the three tasks every asset has been seeded with since the beginning, which
// is exactly right — nobody typed those.
async function ensureAssetPanelColumns(db, log) {
  const has = async (table, column) => {
    const { rows } = await db.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND COLUMN_NAME = $2`,
      [table, column]
    );
    return rows.length > 0;
  };

  const added = [];
  if (!(await has('assets', 'reference_link'))) {
    await db.query('ALTER TABLE assets ADD COLUMN reference_link VARCHAR(2048) NULL AFTER description');
    added.push('assets.reference_link');
  }
  /* The lead's own notes, which arrived with the nine-column asset import.
     Checked on its own, like everything else here — see the note below about a
     step that can never complete. */
  if (!(await has('assets', 'lead_notes'))) {
    await db.query('ALTER TABLE assets ADD COLUMN lead_notes TEXT NULL AFTER reference_link');
    added.push('assets.lead_notes');
  }
  // Each column checked on its own.
  //
  // These two were gated on one probe: if created_by was absent but created_at
  // present — a half-applied run, or one column dropped by hand — the second
  // ALTER threw "duplicate column", the whole step failed, and it failed the
  // same way on every subsequent boot. A step that can never complete is how a
  // deployment ends up permanently serving code against a schema it lacks,
  // which is the outage this whole change exists to prevent.
  const hadCreatedBy = await has('tasks', 'created_by');
  if (!hadCreatedBy) {
    await db.query('ALTER TABLE tasks ADD COLUMN created_by CHAR(36) NULL');
    added.push('tasks.created_by');
  }
  if (!(await has('tasks', 'created_at'))) {
    await db.query('ALTER TABLE tasks ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
    added.push('tasks.created_at');
  }
  if (!hadCreatedBy) {
    try {
      await db.query('ALTER TABLE tasks ADD CONSTRAINT fk_tasks_author FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL');
    } catch (err) {
      log(`Schema: tasks.created_by added, but its foreign key was refused — ${err.sqlMessage || err.message}`);
    }
  }
  if (added.length) log(`Schema: added ${added.join(', ')}.`);
}

// The 'assigned' state, and the work_sessions table behind time recording.
//
// The status CHECK constraint has to be rebuilt to admit the new value —
// MySQL/MariaDB cannot widen one in place. Existing rows are untouched: an
// asset that was in_progress under the old rule stays in_progress, because its
// work genuinely had started; only assignments made from now on land in
// 'assigned' and wait for the assignee to accept.
// The work_sessions table: when work started and when it was handed in.
//
// Its own step, separate from the status constraint below it. They used to be
// one, with the table first — so on a database where creating the table failed,
// the step threw and the constraint repair underneath it never ran at all. That
// is not a hypothetical: a deployment reported both
// "work_sessions unavailable (ER_NO_SUCH_TABLE)" and a status constraint still
// rejecting 'assigned', from this single cause. Two jobs, two steps, each
// isolated by the runner.
async function ensureWorkSessions(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions'`
  );
  if (table.length) return;

  // Without the foreign keys, then with them. A referential constraint can be
  // refused for reasons that have nothing to do with this table — a collation
  // that does not match assets.id, an engine mismatch, a user without
  // REFERENCES — and losing the whole table to that would turn time recording off
  // for a reason nobody could see. The cascade is a nicety; the table is not.
  await db.query(await applyTableOptions(db, `CREATE TABLE work_sessions (
    id         CHAR(36)  NOT NULL PRIMARY KEY,
    asset_id   CHAR(36)  NOT NULL,
    user_id    CHAR(36)  NULL,
    round      INT       NOT NULL DEFAULT 1,
    started_at DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at   DATETIME  NULL,
    seconds    INT       NULL,
    ended_reason VARCHAR(24) NULL,
    KEY idx_ws_asset (asset_id),
    KEY idx_ws_open (asset_id, ended_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
  log('Schema: added work_sessions — the auditable log of when work started and was handed in.');

  for (const [name, sql] of [
    ['fk_ws_asset', 'ALTER TABLE work_sessions ADD CONSTRAINT fk_ws_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE'],
    ['fk_ws_user', 'ALTER TABLE work_sessions ADD CONSTRAINT fk_ws_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL'],
  ]) {
    try {
      await db.query(sql);
    } catch (err) {
      log(`Schema: work_sessions was created, but ${name} was refused — ${err.sqlMessage || err.message}`);
      log('         Time recording works; deleting an asset will not clear its sessions automatically.');
    }
  }
}

// Assignment episodes: who has held an asset, in order.
//
// Its own step for the same reason work_sessions is: a table that cannot be
// created must not take the repair below it down with it.
async function ensureAssignmentEpisodes(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_assignments'`
  );
  if (!table.length) {
    await db.query(await applyTableOptions(db, `CREATE TABLE asset_assignments (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      seq           BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
      asset_id      CHAR(36)     NOT NULL,
      user_id       CHAR(36)     NULL,
      assigned_by_id CHAR(36)    NULL,
      assigned_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status_at_assignment VARCHAR(32) NOT NULL,
      ended_at      DATETIME     NULL,
      ended_status  VARCHAR(32)  NULL,
      ended_reason  VARCHAR(32)  NULL,
      KEY idx_aa_asset (asset_id, seq),
      KEY idx_aa_open (asset_id, ended_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
    log('Schema: added asset_assignments — who has held each asset, in order.');

    for (const [name, statement] of [
      ['fk_aa_asset', 'ALTER TABLE asset_assignments ADD CONSTRAINT fk_aa_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE'],
      ['fk_aa_user', 'ALTER TABLE asset_assignments ADD CONSTRAINT fk_aa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL'],
    ]) {
      try {
        await db.query(statement);
      } catch (err) {
        log(`Schema: asset_assignments was created, but ${name} was refused — ${err.sqlMessage || err.message}`);
      }
    }
  }

  // Added after the table shipped, so an existing one needs it patched in.
  const { rows: endedStatus } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asset_assignments' AND COLUMN_NAME = 'ended_status'`
  );
  if (!endedStatus.length) {
    await db.query('ALTER TABLE asset_assignments ADD COLUMN ended_status VARCHAR(32) NULL AFTER ended_at');
  }

  // Which episode a stretch of work belongs to. Behind its own probe, so a
  // half-applied run repairs itself rather than failing here forever.
  const { rows: column } = await db.query(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions' AND COLUMN_NAME = 'assignment_id'`
  );
  if (!column.length) {
    const { rows: ws } = await db.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions'`
    );
    if (ws.length) {
      await db.query('ALTER TABLE work_sessions ADD COLUMN assignment_id CHAR(36) NULL');
      await db.query('ALTER TABLE work_sessions ADD KEY idx_ws_assignment (assignment_id)');
      log('Schema: work_sessions rows now say which assignment they belong to.');
    }
  }

  // Every asset that already has somebody on it gets an open episode, so the
  // Assets List and the work log have something to attribute to from the first
  // page load rather than only for work assigned after this deployment.
  const { rows: gap } = await db.query(
    `SELECT COUNT(*) AS n FROM assets a
      WHERE a.assignee_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM asset_assignments x WHERE x.asset_id = a.id AND x.ended_at IS NULL)`
  );
  if (Number(gap[0].n)) {
    await db.query(
      `INSERT INTO asset_assignments (id, asset_id, user_id, assigned_by_id, assigned_at, status_at_assignment)
       SELECT UUID(), a.id, a.assignee_id, a.created_by, a.created_at, a.\`status\`
         FROM assets a
        WHERE a.assignee_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM asset_assignments x WHERE x.asset_id = a.id AND x.ended_at IS NULL)`
    );
    log(`Schema: opened an assignment record for ${Number(gap[0].n)} asset(s) that already had somebody on them.`);

    // Their existing sessions belong to that episode. Without this the first
    // page load would show every historical hour as unattributed and the
    // current assignee's counter as nothing, which is the opposite of true.
    try {
      await db.query(
        `UPDATE work_sessions w
           JOIN asset_assignments ass ON ass.asset_id = w.asset_id AND ass.ended_at IS NULL
            SET w.assignment_id = ass.id
          WHERE w.assignment_id IS NULL`
      );
    } catch (err) {
      log(`Schema: existing work sessions could not be attributed to an assignment — ${err.sqlMessage || err.message}`);
    }
  }
}

// Widen the assets status constraint so it admits every state the app writes.
async function ensureStatusConstraint(db, log) {
  // Widen the status constraint so it admits every state the app can write.
  //
  // Three mistakes have lived in this one step.
  //
  // The first: it decided whether to act by reading the constraint's text from
  // information_schema.CHECK_CONSTRAINTS, and when that read returned nothing
  // (the view does not exist on MySQL 5.7, and is not always readable) it
  // concluded there was nothing to do. So on a database where the constraint
  // was real but unreadable, the rebuild never ran, and every write that lands
  // an asset in 'assigned' failed with a CHECK violation.
  //
  // The second, and worse because it reported success: it dropped and read
  // back BY NAME. A database whose status constraint is under a different name
  // — an older schema, or a table recreated by a hosting panel's import — kept
  // that constraint untouched, gained a second, wider one called
  // chk_assets_status, and then read the new one back and logged "the status
  // constraint now admits 'assigned'". MySQL and MariaDB enforce every CHECK on
  // a table, so the old narrow one still rejected the write. Creating an asset
  // with an assignee then failed *after* the asset row was already inserted,
  // leaving exactly the thing this was supposed to prevent: an asset with an
  // assignee, a status of not_started, and no checklist.
  //
  // The third, which is why the second fix did not take on MySQL 8: it searched
  // the clause for "'not_started'", and MySQL 8 renders string literals in
  // CHECK_CLAUSE with a charset introducer and escaped quotes —
  // _utf8mb4\'not_started\' — so the search matched nothing and an auto-named
  // constraint, assets_chk_2, kept rejecting every write of 'assigned'. Clauses
  // are normalized before they are read now; see normalizeCheckClause.
  //
  // So: find them by what they constrain, not by what they are called — the
  // same way the type and priority constraints are already handled — and act
  // unless every one of them is positively confirmed current.
  const stale = await staleStatusConstraints(db);
  if (stale === null || stale.length) {
    for (const name of (stale || []).map((c) => c.name)) {
      try {
        await db.query(`ALTER TABLE assets DROP CONSTRAINT \`${name}\``);
      } catch {
        try {
          await db.query(`ALTER TABLE assets DROP CHECK \`${name}\``);
        } catch {
          log(`Schema: could not drop the stale status constraint "${name}". Assigning an asset will`);
          log('         keep failing until it is dropped by hand or this user is granted ALTER.');
        }
      }
    }
    // When the constraints could not be read at all, the named one is still the
    // best guess at what is there — drop it blind before adding it back.
    if (stale === null) {
      try {
        await db.query('ALTER TABLE assets DROP CONSTRAINT chk_assets_status');
      } catch {
        try { await db.query('ALTER TABLE assets DROP CHECK chk_assets_status'); } catch { /* absent */ }
      }
    }
    try {
      await db.query(`ALTER TABLE assets ADD CONSTRAINT chk_assets_status CHECK (\`status\` IN (
        ${STATUS_VALUES.map((v) => `'${v}'`).join(',')}
      ))`);
    } catch (err) {
      // Adding it back is not the important half — nothing rejects a valid
      // status without it. Dropping the stale one was.
      if (!/duplicate|exists/i.test(err.sqlMessage || err.message || '')) throw err;
    }

    // Verify rather than assume, and verify ALL of them.
    const after = await staleStatusConstraints(db);
    if (after === null) {
      log("Schema: the status constraint was rebuilt to admit 'assigned', but this database will not");
      log('         report its constraints, so that cannot be confirmed from here. If assigning an');
      log('         asset fails with a constraint error, apply the CHECK from sql/schema.sql by hand.');
    } else if (after.length) {
      log(`Schema: *** ${after.length} status constraint(s) still reject a valid status: `
        + `${after.map((c) => c.name).join(', ')}. Assigning an asset and creating one with an`);
      log('         assignee will both fail until they are dropped. Apply the CHECK from');
      log('         sql/schema.sql by hand, or grant this database user ALTER on assets.');
    } else {
      log("Schema: the status constraint now admits every current status. Existing assets are untouched.");
    }
  }
}

// Every status the app can write. One list, used to build the constraint and to
// judge whether an existing one is current.
const STATUS_VALUES = [
  'not_started', 'assigned', 'in_progress', 'pending_tl_review', 'tl_changes_requested',
  'pending_cd_review', 'cd_changes_requested', 'approved_for_client',
  'awaiting_client_feedback', 'delivered',
];

// Every CHECK constraint on `assets` that constrains `status` and does not admit
// all of STATUS_VALUES — whatever it is called. Null means this database will
// not report its constraints, which is "unknown", never "none".
async function staleStatusConstraints(db) {
  const { rows } = await db.query(
    `SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_NAME   = cc.CONSTRAINT_NAME
        AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_NAME = 'assets'
        AND tc.CONSTRAINT_TYPE = 'CHECK'
        AND tc.CONSTRAINT_SCHEMA = DATABASE()`
  ).catch(() => ({ rows: null }));
  if (rows === null) return null;
  return rows.filter((r) => {
    const clause = normalizeCheckClause(r.clause);
    // Only the ones enumerating statuses. `not_started` appears in every
    // version of this constraint there has ever been, which is what identifies
    // it without relying on its name.
    if (!/\bstatus\b/i.test(clause) || !clause.includes("'not_started'")) return false;
    return STATUS_VALUES.some((v) => !clause.includes(`'${v}'`));
  });
}

// Assets that already had somebody on them when the 'assigned' state arrived.
//
// Under the old rule, assigning an asset moved it straight to in_progress, so
// "has an assignee" and "is Not Assigned" could not both be true. Under the new
// rule they can, and on any database that predates it they were: a projectful
// of assets showing an assignee's avatar in the Not Assigned column, because
// nothing re-ran the assign transition over rows that were already there.
//
// Rows that are further down the pipeline are left exactly as they are — only
// the contradiction is repaired, and only in the one direction that is not a
// judgement call. No asset_events row is written, because no one performed this
// assignment now; the original event, where there was one, is still the record.
async function backfillAssignedStatus(db, log) {
  const { rows: stuck } = await db.query(
    "SELECT COUNT(*) AS n FROM assets WHERE assignee_id IS NOT NULL AND `status` = 'not_started'"
  );
  const count = Number(stuck[0].n);
  if (!count) return;
  await db.query(
    "UPDATE assets SET `status` = 'assigned', routed_to_id = COALESCE(routed_to_id, assignee_id) "
    + "WHERE assignee_id IS NOT NULL AND `status` = 'not_started'"
  );
  log(`Schema: ${count} asset(s) had an assignee but still read as Not Assigned. Moved to Assigned.`);
}

// Roles that should run the first review gate but were never given it.
//
// review.tl used to come only from a role's TIER, so nine roles across
// Supervision, Creative Direction and Production never had it — Project Manager
// and Producer among them — and the review controls were missing for everyone
// holding them. The default is fixed in role-permissions.js; this brings
// databases that were seeded under the old one into line.
//
// Only rows still marked as seeded by the system are touched. If an
// administrator has turned this permission off for a role, that is a decision,
// and a migration must not quietly reverse it — updated_by_email is what tells
// the two apart.
async function ensureReviewGateDefaults(db, log) {
  const keys = roleKeys().filter((k) => {
    const def = roleDef(k);
    return def && rolePermissions.TL_REVIEW_GROUPS.includes(def.group);
  });
  if (!keys.length) return;

  const holes = keys.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT role_key FROM role_permissions
      WHERE permission_key = 'review.tl' AND enabled = 0
        AND (updated_by_email IS NULL OR updated_by_email = 'system')
        AND role_key IN (${holes})`,
    keys
  );
  if (!rows.length) return;

  await db.query(
    `UPDATE role_permissions SET enabled = 1, updated_by_email = 'system'
      WHERE permission_key = 'review.tl' AND enabled = 0
        AND (updated_by_email IS NULL OR updated_by_email = 'system')
        AND role_key IN (${holes})`,
    keys
  );
  log(`Schema: TL Review Actions granted to ${rows.length} role(s) that run the first review gate:`);
  log(`         ${rows.map((r) => r.role_key).join(', ')}.`);
}


// The category each asset belongs to. Deliberately no seed: the list starts
// empty and a Super Admin fills it in Settings, so nobody inherits a taxonomy
// guessed for them. Nullable, so every asset that already exists stays valid.
/* Profile photos, stored on the user's own row.
 *
 * MEDIUMBLOB rather than BLOB: BLOB tops out at 64KB, and while the browser
 * downscales before uploading, the server's cap is 3MB and the column has to
 * be able to hold what the server is willing to accept. Otherwise the limit
 * would really be enforced by a truncation error, which is not a limit — it is
 * a corrupted image and a 500.
 *
 * Added one at a time and each guarded, so a half-applied migration from an
 * interrupted deploy completes on the next start instead of failing on the
 * column it already added. */
/* What a standard working day is.
 *
 * One row, id 1, like branding — a studio-wide policy, not per anything. The
 * Idle Report needs it and nothing in this app recorded it before: there is no
 * shift model, no roster and no calendar, so the expected half of "expected
 * minus actual" had nowhere to come from.
 *
 * Seeded with the studio's answer, eight hours Monday to Friday, so the report
 * works on a database that has never visited the setting. */
/* Who has been told what.
 *
 * One row per person per event. Stored rather than pushed, because a
 * notification that only ever existed as a live pop-up is one that anybody away
 * from their desk never received.
 *
 * The message is NOT stored. The row keeps ids — who, what asset, which other
 * person — and the sentence is built when it is read, so a wording change
 * applies to the whole history and an asset renamed afterwards still reads
 * correctly.
 *
 * ON DELETE CASCADE on the recipient: a removed account's notifications go with
 * it. SET NULL on the asset, so deleting an asset leaves the history readable
 * rather than taking somebody's notification list with it. */
async function ensureNotifications(db, log) {
  /* `seq` is monotonic, and that is the point of it. created_at is a DATETIME
     with second precision and a reassignment raises two rows in the same
     second, which made "newest first" arbitrary between them and — worse —
     made a timestamp cursor unsafe: comparing created_at against the last one
     seen silently drops anything raised in the same second the browser last
     looked, permanently. A sequence cannot tie and cannot skip. Same column,
     same reason, as asset_assignments.seq. */
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS notifications (
      id            CHAR(36)    NOT NULL PRIMARY KEY,
      seq           BIGINT      NOT NULL AUTO_INCREMENT UNIQUE,
      recipient_id  CHAR(36)    NOT NULL,
      actor_id      CHAR(36)    NULL,
      kind          VARCHAR(32) NOT NULL,
      asset_id      CHAR(36)    NULL,
      other_user_id CHAR(36)    NULL,
      read_at       DATETIME    NULL,
      created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notifications_inbox (recipient_id, created_at),
      KEY idx_notifications_unread (recipient_id, read_at)
    )`));

  /* The keys are added separately and tolerantly: on a database where an older
     copy of the table already exists they may be there, and a deployment whose
     user cannot create constraints must still get a working table. */
  const fk = async (sql) => { await db.query(sql).catch(() => {}); };
  await fk('ALTER TABLE notifications ADD CONSTRAINT fk_notifications_recipient '
    + 'FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE');
  await fk('ALTER TABLE notifications ADD CONSTRAINT fk_notifications_asset '
    + 'FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL');
  log('Schema: notifications table ready.');
}

async function ensureWorkSchedule(db, log) {
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS work_schedule (
      id            TINYINT      NOT NULL PRIMARY KEY,
      hours_per_day DECIMAL(4,2) NOT NULL DEFAULT 8.00,
      working_days  VARCHAR(32)  NOT NULL DEFAULT '1,2,3,4,5',
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`));
  const { rows } = await db.query('SELECT id FROM work_schedule WHERE id = 1');
  if (rows.length) return;
  await db.query("INSERT INTO work_schedule (id, hours_per_day, working_days) VALUES (1, 8.00, '1,2,3,4,5')");
  log('Schema: work_schedule created (8 hours a day, Monday to Friday).');
}

async function ensureProfilePhotos(db, log) {
  const { rows } = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
        AND COLUMN_NAME IN ('avatar', 'avatar_mime', 'avatar_updated_at')`
  );
  const have = new Set(rows.map((r) => r.COLUMN_NAME));
  const add = [
    ['avatar', 'MEDIUMBLOB NULL'],
    ['avatar_mime', 'VARCHAR(64) NULL'],
    ['avatar_updated_at', 'DATETIME NULL'],
  ].filter(([name]) => !have.has(name));
  if (!add.length) return;
  for (const [name, type] of add) {
    await db.query(`ALTER TABLE users ADD COLUMN \`${name}\` ${type}`);
  }
  log(`Schema: added users.${add.map(([n]) => n).join(', users.')}.`);
}

async function ensureAssetCategory(db, log) {
  const { rows } = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND COLUMN_NAME = 'category'`
  );
  if (rows.length) return;
  await db.query('ALTER TABLE assets ADD COLUMN category VARCHAR(64) NULL AFTER `type`');
  await db.query('ALTER TABLE assets ADD KEY idx_assets_category (category)');
  log('Schema: added assets.category.');
}


/* Make every table's collation agree.
 *
 * `DEFAULT CHARSET=utf8mb4` with no COLLATE takes the SERVER's default, which
 * is utf8mb4_0900_ai_ci on MySQL 8 and utf8mb4_general_ci on MariaDB and MySQL
 * 5.7. src/db-collation.js exists to stop that, by anchoring new tables to
 * whatever `users` has — but the clients table was created without it. On a
 * MySQL 8 host that gave clients one collation and the rest of the schema
 * another, and any query comparing a string column across the two died:
 *
 *   Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT)
 *   and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
 *
 * which is what the Reports tab hit on `clients.id = projects.client_id`.
 * Creating it correctly fixes new databases; this fixes the ones already out
 * there, which is the half that matters to a studio running today.
 *
 * A table cannot be converted while a foreign key touches its columns — from
 * either side — so the keys come off, the table is converted, and they go back
 * exactly as they were.
 */
async function ensureCollationConsistency(db, log) {
  const { rows: target } = await db.query(
    `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const want = target.length ? target[0].c : null;
  // Nothing to anchor to, or an anchor not worth following: leave it alone
  // rather than convert the schema to a guess.
  if (!want || !/^utf8mb4_/i.test(want)) return;

  const { rows: wrong } = await db.query(
    `SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_COLLATION IS NOT NULL AND TABLE_COLLATION <> $1
      ORDER BY TABLE_NAME`,
    [want]
  );
  if (!wrong.length) return;

  for (const { t, c } of wrong) {
    // Every foreign key that would block the conversion: the ones this table
    // owns, and the ones pointing at it.
    const { rows: keys } = await db.query(
      `SELECT rc.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS col,
              k.REFERENCED_TABLE_NAME AS parent, k.REFERENCED_COLUMN_NAME AS parentCol,
              rc.DELETE_RULE AS onDelete, rc.UPDATE_RULE AS onUpdate, k.ORDINAL_POSITION AS pos
         FROM information_schema.REFERENTIAL_CONSTRAINTS rc
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
          AND k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
          AND (k.TABLE_NAME = $1 OR k.REFERENCED_TABLE_NAME = $1)
        ORDER BY rc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [t]
    );

    // Composite keys arrive as one row per column; rebuild them whole.
    const byName = new Map();
    for (const k of keys) {
      if (!byName.has(k.name)) {
        byName.set(k.name, { name: k.name, child: k.child, parent: k.parent,
          cols: [], parentCols: [], onDelete: k.onDelete, onUpdate: k.onUpdate });
      }
      const entry = byName.get(k.name);
      entry.cols.push(k.col);
      entry.parentCols.push(k.parentCol);
    }
    const constraints = [...byName.values()];

    try {
      for (const fk of constraints) {
        await db.query(`ALTER TABLE \`${fk.child}\` DROP FOREIGN KEY \`${fk.name}\``);
      }
      await db.query(`ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${want}`);
      log(`Schema: ${t} was ${c}; converted to ${want} so it can be joined to the rest.`);
    } catch (err) {
      log(`Schema: ${t} is ${c} rather than ${want} and could not be converted — ${err.sqlMessage || err.message}. `
        + 'Queries joining it to another table will fail with "Illegal mix of collations".');
    } finally {
      // Back exactly as they were, whether or not the conversion worked.
      for (const fk of constraints) {
        const cols = fk.cols.map((x) => `\`${x}\``).join(', ');
        const parentCols = fk.parentCols.map((x) => `\`${x}\``).join(', ');
        await db.query(
          `ALTER TABLE \`${fk.child}\` ADD CONSTRAINT \`${fk.name}\` FOREIGN KEY (${cols}) `
          + `REFERENCES \`${fk.parent}\` (${parentCols}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
        ).catch((err) => {
          log(`Schema: could not put ${fk.name} back on ${fk.child} — ${err.sqlMessage || err.message}`);
        });
      }
    }
  }
}


/* The studio's own name, tagline and logo.
 *
 * One row, id 1, so there is nothing to pick between. The logo lives in the
 * table rather than on disk because an uploads directory does not survive a
 * redeploy on the kind of shared hosting this runs on, and a logo that
 * disappears when the app is updated is worse than a MEDIUMBLOB.
 */
async function ensureBranding(db, log) {
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS branding (
      id              TINYINT      NOT NULL PRIMARY KEY,
      app_name        VARCHAR(60)  NOT NULL,
      tagline         VARCHAR(120) NULL,
      logo            MEDIUMBLOB   NULL,
      logo_mime       VARCHAR(64)  NULL,
      logo_updated_at DATETIME     NULL,
      updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  const { rows } = await db.query('SELECT COUNT(*) AS n FROM branding WHERE id = 1');
  if (Number(rows[0].n) === 0) {
    await db.query('INSERT INTO branding (id, app_name, tagline) VALUES (1, $1, $2)',
      [branding.DEFAULTS.appName, branding.DEFAULTS.tagline]);
    log(`Schema: branding seeded as "${branding.DEFAULTS.appName}".`);
  }
}

/* Why a work session ended.
 *
 * Added with the change from a running timer to plain start/submit timestamps.
 * Its second job is to mark where the meaning of work_sessions.seconds changes:
 * rows written under the old rule hold ACTIVE worked time, summed across
 * however many pause/resume stretches a round had, and every row written under
 * the new rule holds ELAPSED time between one start and one submit. Only the
 * new ones carry a reason, so the earliest row that has one is the cutover —
 * see cutover() in src/work-log.js. Backfilling the existing rows with a guess
 * would destroy exactly the distinction the column exists to make, so they are
 * deliberately left NULL.
 */
async function ensureSessionEndReason(db, log) {
  const { rows: table } = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions'`
  );
  if (!table.length) return;
  const { rows: col } = await db.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions' AND COLUMN_NAME = 'ended_reason'`
  );
  if (col.length) return;
  await db.query('ALTER TABLE work_sessions ADD COLUMN ended_reason VARCHAR(24) NULL');
  log('Schema: work_sessions rows now record why they ended, and where Time Spent changed meaning.');
}

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
  ['role permissions', ensurePermissionTables],
  ['asset ownership', ensureAssetOwnership],
  /* Before the client hierarchy, and before anything else adds a foreign key.
     A key cannot be created between two columns whose collations disagree, so
     a mismatch left here does not only break queries — it silently stops the
     schema getting the constraints it asks for. */
  ['collation alignment', ensureCollationConsistency],
  ['branding', ensureBranding],
  // Its mirror, after the table exists and is seeded.
  ['branding mirror', (db) => branding.load(db)],
  ['client hierarchy', ensureClients],
  // After the client step, so client.* exists in the catalogue by the time
  // roles are topped up against it.
  ['client and project lifecycle', ensureLifecycleColumns],
  ['asset brief and checklist', ensureAssetPanelColumns],
  ['work sessions table', ensureWorkSessions],
  // Deliberately after, and deliberately separate: this is the repair that
  // decides whether an asset can be assigned at all, and it must not be
  // skipped because the step above it could not create a table.
  ['assigned state and time tracking', ensureStatusConstraint],
  // After work_sessions, whose column it adds, and after the constraint, so a
  // backfill that writes statuses cannot be refused by a stale one.
  ['assignment history', ensureAssignmentEpisodes],
  // After the constraint above admits 'assigned', or the update below cannot
  // land. Separate from that step so a rerun repairs the data even when the
  // constraint was already current and the step above did nothing.
  ['assigned backfill', backfillAssignedStatus],
  ['permission catalogue top-up', ensurePermissionCatalogueComplete],
  // After the catalogue top-up, so every role has a row to correct.
  ['review gate departments', ensureReviewGateDefaults],
  ['IP allowlist', ensureIpAllowlist],
  ['asset category', ensureAssetCategory],
  ['profile photos', ensureProfilePhotos],
  ['working hours', ensureWorkSchedule],
  // Its mirror, once the table exists and holds its one row.
  ['working hours mirror', (db) => workSchedule.load(db)],
  // After users and assets, whose keys it points at.
  ['notifications', ensureNotifications],
  // After work_sessions, whose column it adds.
  ['work session end reason', ensureSessionEndReason],
  // After projects and users, whose keys it points at.
  ['project supervision', ensureProjectSupervision],
  // After the event log, whose column it adds.
  ['bulk action batches', ensureEventBatches],
  // After notifications, whose column it adds, and after clients and projects.
  ['project review requests', ensureProjectReviews],
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
