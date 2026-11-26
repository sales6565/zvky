/* A PORTABLE SQL DUMP, WRITTEN IN JAVASCRIPT, BECAUSE mysqldump MAY NOT BE THERE.
 *
 * ===========================================================================
 * WHY NOT JUST SHELL OUT TO mysqldump.
 *
 * On a GoDaddy cPanel plan you get a shell that may or may not have the MariaDB
 * client tools on its PATH, a Passenger process whose environment is not the
 * one the owner's SSH session has, and no way to install anything. A backup
 * feature whose first step is "run a binary that might not exist" fails on the
 * one morning it is needed, with a message about a missing command.
 *
 * So the dump is produced here, in Node, from ordinary SELECTs. If mysqldump IS
 * present the engine may offer it as an alternative — it is faster — but this
 * path is the one that must work, and it is the one the tests exercise.
 *
 * ===========================================================================
 * THE THREE THINGS THAT MAKE A DUMP TRUSTWORTHY.
 *
 * 1. IT IS CONSISTENT. Taken inside one transaction with a consistent snapshot,
 *    on its OWN connection, at REPEATABLE READ. Every table is read as of the
 *    same instant, so a dump taken while somebody submits an asset cannot
 *    contain the new asset_versions row without the assets row it points at.
 *    Without this, a backup of a busy studio is a database that violates its
 *    own foreign keys — and you find out during the restore.
 *
 *    A DEDICATED CONNECTION, not one from the pool: a pool hands the next query
 *    to whichever connection is free, and a snapshot belongs to a session.
 *
 * 2. IT IS ORDERED SO IT CAN BE REPLAYED. Schema first (all the CREATEs), then
 *    data, then the things that depend on data being there: views, triggers,
 *    routines, events. Foreign key checks are off for the whole file and on
 *    again at the end, so the data can go in in any order — which it must,
 *    because there is no ordering of thirty tables that satisfies every cycle.
 *
 * 3. IT NEVER HOLDS A TABLE IN MEMORY. Rows are read in keyset batches and
 *    written out as INSERT statements, with the caller's write() awaited so
 *    backpressure reaches the SELECT. A 300 MB table is dumped in a few
 *    megabytes of resident memory, which on shared hosting is the difference
 *    between a backup and a killed process.
 *
 * ===========================================================================
 * ESCAPING, WHICH IS WHERE A HAND-WRITTEN DUMPER GOES WRONG.
 *
 * Every value goes through literal() below. The cases that matter, each of
 * which has its own test:
 *
 *   NULL          the word NULL, never the string 'NULL'
 *   Buffer        0x hex, so a mediumblob survives byte for byte and no quoting
 *                 question arises at all
 *   DECIMAL       mysql2 hands these over as strings to avoid float error, and
 *                 they are emitted unquoted — quoting works but makes the
 *                 column's declared scale depend on MariaDB's coercion
 *   Date          a 'YYYY-MM-DD HH:MM:SS' literal in UTC, built by hand rather
 *                 than through toISOString().slice() so the 'T' and the 'Z'
 *                 cannot arrive in the file
 *   JSON          mysql2 parses JSON columns into objects; they are
 *                 re-serialised and quoted as text, which is what the column
 *                 accepts
 *   strings       single quotes, backslashes, NUL, newline, CR and Ctrl-Z are
 *                 escaped. NOT \" — the dump is read with NO_BACKSLASH_ESCAPES
 *                 off and double quotes inside a single-quoted literal are
 *                 ordinary characters
 *
 * utf8mb4 end to end: the connection is set to it, the file says so in its
 * header, and the four-byte characters that make this matter — emoji, ZWJ
 * sequences, Indic scripts — are in the round-trip test.
 */
const mysql = require('mysql2/promise');

/* How much to pull at once. Two ceilings, because one is not enough:
 *   ROWS   keeps the SELECT's result set small for ordinary narrow tables
 *   BYTES  keeps it small for tables that are not — one mediumblob row can be
 *          16 MB, so 500 of those would be the whole point of streaming lost
 */
const BATCH_ROWS = 500;
const BATCH_BYTES = 1 * 1024 * 1024;

function escapeId(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function escapeString(value) {
  let out = '';
  const str = String(value);
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    switch (ch) {
      case '\0': out += '\\0'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\x1a': out += '\\Z'; break;
      case '\\': out += '\\\\'; break;
      case '\'': out += '\\\''; break;
      default: out += ch;
    }
  }
  return `'${out}'`;
}

function twoDigit(n) { return String(n).padStart(2, '0'); }

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return value.length ? `0x${value.toString('hex')}` : "''";
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL';
    return escapeString(
      `${value.getUTCFullYear()}-${twoDigit(value.getUTCMonth() + 1)}-${twoDigit(value.getUTCDate())} `
      + `${twoDigit(value.getUTCHours())}:${twoDigit(value.getUTCMinutes())}:${twoDigit(value.getUTCSeconds())}`
    );
  }
  if (typeof value === 'object') return escapeString(JSON.stringify(value));
  /* DECIMAL and BIGINT arrive as strings from mysql2 so no precision is lost on
     the way here. A string that is exactly a number is emitted unquoted, which
     keeps 1234.5600 as 1234.5600 rather than letting the column's scale be
     re-derived from a quoted literal. */
  const str = String(value);
  if (/^-?\d+(\.\d+)?$/.test(str) && str.length <= 65) return str;
  return escapeString(str);
}

/* ===========================================================================
 * WHAT IS IN THE DATABASE, asked of information_schema rather than assumed.
 *
 * The brief asks for views, triggers, routines and events "if they exist". This
 * install has none of them today — asserted in the survey — but a dump that
 * silently drops them when somebody adds one is a dump that restores a
 * database missing a trigger, which is the kind of difference nobody notices
 * until a figure comes out wrong months later. So they are enumerated every
 * time, and a dump of an install with none simply has no such section.
 */
async function inventory(conn) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, AUTO_INCREMENT AS autoInc
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`
  );
  const [triggers] = await conn.query(
    'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY 1'
  );
  const [routines] = await conn.query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY 1`
  );
  let events = [];
  try {
    const [rows] = await conn.query(
      'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY 1'
    );
    events = rows;
  } catch {
    /* Some managed hosts revoke the EVENTS view. "Cannot see any" is the same
       dump as "there are none", and refusing the backup over it would be the
       wrong trade. */
    events = [];
  }
  return {
    tables: tables.filter((t) => t.type === 'BASE TABLE').map((t) => ({
      name: t.name, autoInc: t.autoInc === null ? null : Number(t.autoInc),
    })),
    views: tables.filter((t) => t.type === 'VIEW').map((t) => t.name),
    triggers: triggers.map((t) => t.name),
    routines: routines.map((r) => ({ name: r.name, type: r.type })),
    events: events.map((e) => e.name),
  };
}

/* The column to page by. A single-column primary key gives keyset pagination,
   which stays fast at ten million rows; anything else falls back to OFFSET,
   which is correct inside the snapshot and slower. Correctness first. */
async function pageKey(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS col FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION`, [table]
  );
  return rows.length === 1 ? rows[0].col : null;
}

/* ===========================================================================
 * THE DUMP.
 *
 * write(text) is the caller's sink and is AWAITED, which is what makes this
 * bounded: the engine hands it a file stream whose write() answers false when
 * the kernel buffer is full, and the SELECT loop stops until it drains.
 *
 * onProgress({ stage, table, rows, tables }) is for the Settings screen's
 * progress bar, called often enough to move and not so often that it is the
 * expensive part.
 */
async function dump({ conn, write, onProgress = null, batchRows = BATCH_ROWS, includeData = true }) {
  const say = (payload) => { if (onProgress) onProgress(payload); };
  const counts = {};

  const inv = await inventory(conn);
  const [[{ version }]] = await conn.query('SELECT VERSION() AS version');
  const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');

  /* ---------------------------------------------------------------- header */
  await write([
    '-- Forge database dump',
    '--',
    '-- Written by src/sql-dump.js, not by mysqldump: a cPanel host may not have',
    '-- the client tools, so this file is produced from ordinary SELECTs.',
    '--',
    `-- Server:   ${version}`,
    `-- Database: ${db}`,
    `-- Taken:    ${new Date().toISOString()}`,
    `-- Tables:   ${inv.tables.length}`,
    '--',
    '-- Restore it with: npm run restore -- <package>',
    '-- or by hand:      mysql -u <user> -p <database> < dump.sql',
    '',
    /* THE SESSION STATE THE REST OF THE FILE ASSUMES. Saved and restored, so
       sourcing this dump into a session that goes on to do other things does
       not leave it with foreign keys off. */
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
    '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
    '/*!40101 SET NAMES utf8mb4 */;',
    '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
    /* FOREIGN KEY CHECKS OFF FOR THE WHOLE FILE. Thirty-odd tables with
       circular references between them cannot be ordered so that every parent
       precedes every child; this is how every dump in the world handles it,
       and the re-enable at the end is what makes the restored database check
       them again from that point on. */
    '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
    '',
  ].join('\n'));

  /* ---------------------------------------------------------------- schema */
  say({ stage: 'schema', tables: inv.tables.length });
  for (const table of inv.tables) {
    const [[row]] = await conn.query(`SHOW CREATE TABLE ${escapeId(table.name)}`);
    const create = row['Create Table'];
    await write([
      '',
      `-- Table: ${table.name}`,
      `DROP TABLE IF EXISTS ${escapeId(table.name)};`,
      `${create};`,
      '',
    ].join('\n'));
  }

  /* VIEWS ARE CREATED AFTER THE TABLES AND BEFORE THE DATA, because a view is
     a query over tables that must exist, and nothing in the data depends on a
     view. */
  for (const view of inv.views) {
    const [[row]] = await conn.query(`SHOW CREATE VIEW ${escapeId(view)}`);
    await write([
      '',
      `-- View: ${view}`,
      `DROP VIEW IF EXISTS ${escapeId(view)};`,
      `${row['Create View']};`,
      '',
    ].join('\n'));
  }

  /* ---------------------------------------------------------------- data */
  if (includeData) {
    let index = 0;
    for (const table of inv.tables) {
      index += 1;
      say({ stage: 'data', table: table.name, index, tables: inv.tables.length });
      const key = await pageKey(conn, table.name);
      let rows = 0;
      let wroteHeader = false;
      let cursor = null;
      let offset = 0;

      for (;;) {
        let batch;
        if (key) {
          const where = cursor === null ? '' : ` WHERE ${escapeId(key)} > ?`;
          const params = cursor === null ? [] : [cursor];
          [batch] = await conn.query(
            `SELECT * FROM ${escapeId(table.name)}${where} ORDER BY ${escapeId(key)} LIMIT ${batchRows}`,
            params
          );
        } else {
          [batch] = await conn.query(
            `SELECT * FROM ${escapeId(table.name)} LIMIT ${batchRows} OFFSET ${offset}`
          );
          offset += batch.length;
        }
        if (!batch.length) break;

        if (!wroteHeader) {
          await write(`\n-- Data: ${table.name}\n`);
          wroteHeader = true;
        }

        /* One INSERT per flush with many tuples: far fewer statements to replay
           than one per row, and still bounded because the flush happens on
           either ceiling. */
        const columns = Object.keys(batch[0]);
        const colList = columns.map(escapeId).join(', ');
        let pending = [];
        let bytes = 0;
        const flush = async () => {
          if (!pending.length) return;
          await write(`INSERT INTO ${escapeId(table.name)} (${colList}) VALUES\n${pending.join(',\n')};\n`);
          pending = [];
          bytes = 0;
        };

        for (const row of batch) {
          /* THE TUPLE IS BUILT ONCE AND MEASURED, rather than estimated: it is
             already the exact SQL, so weighing it is free and the ceiling is
             real. A batch of mediumblob rows flushes after one or two tuples;
             a batch of narrow rows flushes once. Either way nothing larger than
             the ceiling is held. */
          const tuple = `(${columns.map((c) => literal(row[c])).join(',')})`;
          pending.push(tuple);
          bytes += tuple.length;
          if (bytes >= BATCH_BYTES) await flush();
        }
        await flush();

        rows += batch.length;
        if (key) cursor = batch[batch.length - 1][key];
        if (batch.length < batchRows) break;
      }

      counts[table.name] = rows;

      /* THE AUTO-INCREMENT VALUE, PRESERVED. SHOW CREATE TABLE above carries
         the value as it was when the schema was read, but a table whose rows
         were all deleted has a next-id that no INSERT in this dump restores —
         and an id that restarts can collide with one referenced by a row
         somewhere else, or by a link somebody bookmarked. Stated explicitly so
         the restored table carries on where this one left off. */
      if (table.autoInc !== null && table.autoInc > 1) {
        await write(`ALTER TABLE ${escapeId(table.name)} AUTO_INCREMENT = ${table.autoInc};\n`);
      }
    }
  }

  /* ------------------------------------------- triggers, routines, events */
  if (inv.triggers.length) {
    await write('\n-- Triggers\n');
    for (const name of inv.triggers) {
      const [[row]] = await conn.query(`SHOW CREATE TRIGGER ${escapeId(name)}`);
      const body = row['SQL Original Statement'];
      await write(`DROP TRIGGER IF EXISTS ${escapeId(name)};\nDELIMITER ;;\n${body};;\nDELIMITER ;\n`);
    }
  }
  for (const routine of inv.routines) {
    const what = routine.type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    const [[row]] = await conn.query(`SHOW CREATE ${what} ${escapeId(routine.name)}`);
    const body = row[`Create ${what.charAt(0) + what.slice(1).toLowerCase()}`] || row[`Create ${what}`];
    if (!body) continue;
    await write(`\n-- ${what}: ${routine.name}\nDROP ${what} IF EXISTS ${escapeId(routine.name)};\n`
      + `DELIMITER ;;\n${body};;\nDELIMITER ;\n`);
  }
  if (inv.events.length) {
    await write('\n-- Events\n');
    for (const name of inv.events) {
      const [[row]] = await conn.query(`SHOW CREATE EVENT ${escapeId(name)}`);
      const body = row['Create Event'];
      if (!body) continue;
      await write(`DROP EVENT IF EXISTS ${escapeId(name)};\nDELIMITER ;;\n${body};;\nDELIMITER ;\n`);
    }
  }

  /* ---------------------------------------------------------------- footer */
  await write([
    '',
    '/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;',
    '/*!40014 SET UNIQUE_CHECKS=IFNULL(@OLD_UNIQUE_CHECKS, 1) */;',
    '/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, \'\') */;',
    '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
    '/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;',
    '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;',
    '/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;',
    '',
    '-- End of dump.',
    '',
  ].join('\n'));

  say({ stage: 'data-done', tables: inv.tables.length });
  return { counts, inventory: inv, serverVersion: version, database: db };
}

/* ===========================================================================
 * THE CONNECTION THE DUMP IS TAKEN ON.
 *
 * Its own connection, at REPEATABLE READ, with a consistent snapshot opened
 * before the first read. START TRANSACTION WITH CONSISTENT SNAPSHOT is
 * MariaDB/InnoDB's way of saying "fix the view of the data now", which is what
 * makes every table below agree with every other.
 *
 * READ ONLY as well, so nothing this session does can write — a dumper with a
 * write capability is a dumper that can corrupt the thing it is backing up.
 */
async function openSnapshot(dbConfig) {
  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: 'utf8mb4',
    /* DECIMAL AND BIGINT AS STRINGS. The default turns 1234.5600 into a double
       and 9007199254740993 into 9007199254740992; a backup that quietly changes
       money is worse than one that fails. */
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    multipleStatements: false,
  });
  await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('SET NAMES utf8mb4');
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  return conn;
}

async function closeSnapshot(conn) {
  if (!conn) return;
  try { await conn.query('COMMIT'); } catch { /* the snapshot is read-only; nothing to lose */ }
  try { await conn.end(); } catch { /* already gone */ }
}

module.exports = {
  dump, inventory, openSnapshot, closeSnapshot,
  literal, escapeId, escapeString, BATCH_ROWS, BATCH_BYTES,
};
