// What CHARACTER SET and COLLATE to create new tables with.
//
// Tables created later must match the ones created earlier, or any query
// comparing a string column across the two fails outright:
//
//   Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT)
//   and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
//
// That is a real production failure, not a hypothetical. `DEFAULT CHARSET=utf8mb4`
// with no COLLATE takes the *server's* default collation for that charset, which
// is utf8mb4_0900_ai_ci on MySQL 8 and utf8mb4_general_ci on MySQL 5.7 and
// MariaDB. A database created under one server and migrated under another ends
// up with tables that cannot be joined to each other.
//
// So new tables are anchored to the collation `users` already has — the oldest
// table, and the one the rest of the schema refers to.

let cached = null;

const DEFAULT_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

// The trailing table options for a CREATE TABLE, matching the existing schema.
// Falls back to a plain utf8mb4 table when there is nothing to match yet, which
// is the right answer for an empty database.
async function tableOptions(db) {
  if (cached) return cached;
  try {
    const { rows } = await db.query(
      `SELECT TABLE_COLLATION AS collation_name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    const collation = rows.length ? rows[0].collation_name : null;
    // Only follow a utf8mb4 collation. An older table on latin1 is not
    // something to copy — that would lose characters rather than gain
    // compatibility.
    cached = collation && /^utf8mb4_/i.test(collation)
      ? `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`
      : DEFAULT_OPTIONS;
  } catch {
    cached = DEFAULT_OPTIONS;
  }
  return cached;
}

// Rewrite a CREATE TABLE written with the default options to use the ones above.
async function applyTableOptions(db, sql) {
  const options = await tableOptions(db);
  if (options === DEFAULT_OPTIONS) return sql;
  return sql.replace(/ENGINE=InnoDB\s+DEFAULT\s+CHARSET=utf8mb4(?!\s+COLLATE)/i, options);
}

// Tests reach in to clear this between databases.
function reset() {
  cached = null;
}

module.exports = { tableOptions, applyTableOptions, reset, DEFAULT_OPTIONS };
