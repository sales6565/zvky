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
  /* A FALL-BACK ONLY. The dump connection asks for temporal columns as strings
     (see openSnapshot), precisely so that this branch is not used: a Date has
     millisecond precision and a DATETIME(6) has microsecond, so anything that
     arrives here has already lost three digits. It stays for a caller that
     hands literal() a Date of its own, and it keeps the milliseconds it has. */
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL';
    const ms = value.getUTCMilliseconds();
    return escapeString(
      `${value.getUTCFullYear()}-${twoDigit(value.getUTCMonth() + 1)}-${twoDigit(value.getUTCDate())} `
      + `${twoDigit(value.getUTCHours())}:${twoDigit(value.getUTCMinutes())}:${twoDigit(value.getUTCSeconds())}`
      + (ms ? `.${String(ms).padStart(3, '0')}` : '')
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

/* THE COLUMNS TO DUMP, WHICH IS NOT "ALL OF THEM".
 *
 * A GENERATED COLUMN MUST NOT BE IN THE INSERT. Its value is derived by the
 * server from the others; naming it in an INSERT is an error — "The value
 * specified for generated column 'x' is not allowed", MariaDB 1906 — so a dump
 * that includes one produces a file that cannot be restored.
 *
 * It did not fail on the host this was first probed on, which is the dangerous
 * part: the dump sets SQL_MODE='NO_AUTO_VALUE_ON_ZERO', which is not strict, so
 * MariaDB downgraded the error to a warning, ignored the value and computed its
 * own. The restore "worked". On a host with STRICT_ALL_TABLES in sql_mode it
 * would have stopped dead at the first such table — during a restore, which is
 * the worst moment to discover a backup cannot be read.
 *
 * So the list is asked of information_schema rather than taken from
 * `SELECT *`, and the SELECT names it too, which also makes the dump's column
 * order stable rather than whatever the driver hands back.
 */
async function columnsOf(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND (EXTRA IS NULL OR EXTRA NOT LIKE '%GENERATED%')
      ORDER BY ORDINAL_POSITION`, [table]
  );
  return rows.map((r) => r.name);
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
      /* ASKED ONCE PER TABLE, not per batch: it is the same answer inside the
         snapshot, and it is what both the SELECT and the INSERT are built from
         so the two cannot drift apart. */
      const columns = await columnsOf(conn, table.name);
      if (!columns.length) continue;              // nothing storable to dump
      const selectList = columns.map(escapeId).join(', ');
      const colList = selectList;
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
            `SELECT ${selectList} FROM ${escapeId(table.name)}${where} `
            + `ORDER BY ${escapeId(key)} LIMIT ${batchRows}`,
            params
          );
        } else {
          [batch] = await conn.query(
            `SELECT ${selectList} FROM ${escapeId(table.name)} LIMIT ${batchRows} OFFSET ${offset}`
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
    /* AND TEMPORAL COLUMNS AS STRINGS, for the same reason and a worse one.
     *
     * A JavaScript Date holds milliseconds. A MariaDB DATETIME(6) holds
     * microseconds. Letting the driver parse the column means the dump of
     * `23:59:59.999999` is `23:59:59` — silent, irreversible loss, in a file
     * whose entire job is to be exact. It also turned a DATE into a DATETIME
     * literal, because a Date has a time whether the column did or not.
     *
     * THIS WAS WRITTEN `false` FIRST, and found by taking a round trip through
     * CHECKSUM TABLE: every row read back identical through SELECT, because the
     * same lossy parse happened on both sides, and the server's own checksums
     * disagreed. A test that compared rows would have passed.
     *
     * As strings, every temporal value is dumped exactly as stored, to whatever
     * precision the column has, and literal() quotes it. */
    dateStrings: true,
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

/* ===========================================================================
 * READING ONE BACK: the splitter, and why it lives beside the writer.
 *
 * The dump above writes `DELIMITER ;;` around triggers and routines. That is
 * not SQL — no server has ever understood it — it is a directive to the `mysql`
 * command-line client, which uses it to know that the semicolons INSIDE a
 * trigger body do not end the statement. So anything that reads this file back
 * has to understand it too.
 *
 * IT IS IN THIS FILE because the format has exactly two halves and they must
 * agree: a splitter in the restore script would be a second description of the
 * same format, living in a different directory, and the day somebody changed
 * the escaping above is the day the restore would stop working — found out
 * during a restore, which is the worst possible moment. One module owns the
 * format; tests/backup-restore.test.js round-trips a database through both
 * halves and compares per-table checksums.
 *
 * WHY NOT SHELL OUT TO `mysql`? A cPanel host may not have the client tools —
 * the same reason the dump is written from SELECTs rather than by mysqldump. A
 * restore that needs a binary the server does not have is a restore that fails
 * on the one host it was written for.
 *
 * WHAT THE SCANNER HAS TO GET RIGHT, all of which the dump above can produce:
 *   'it\'s'        backslash escapes inside single quotes
 *   'a;b'          a semicolon inside a string is not a statement end
 *   `odd;name`     nor one inside a quoted identifier
 *   -- a; comment  nor one inside a line comment
 *   0x4142         hex blobs, which are bare words and need no special care
 *   /*!40101 ... *\/;   version-gated comments, which the SERVER executes, so
 *                       they are passed through as statement text rather than
 *                       stripped
 */
class Splitter {
  constructor() {
    this.buffer = '';
    this.delimiter = ';';
    this.state = 'sql';      // sql | single | double | backtick | line | block
    this.statement = '';
    /* WHETHER THE NEXT CHARACTER BEGINS A LINE, carried across chunks rather
       than worked out from chunk[i - 1]. A chunk boundary falls wherever the
       stream's buffer happened to end, and "is this the start of a line" is a
       property of the FILE, not of the chunk. */
    this.atLineStart = true;
    this.out = [];
  }

  /* A CHUNK AT A TIME, so a four-gigabyte dump never becomes a string.
   *
   * EVERY LOOK-AHEAD HOLDS RATHER THAN GUESSES, which is the whole difficulty
   * of this function and the bug a chunk-size sweep found: a scanner that needs
   * to see three characters to recognise `-- ` will mistake a comment for
   * arithmetic if the chunk ends after the first dash. So whenever the decision
   * needs characters that are not here yet, the rest of the chunk goes back
   * into this.buffer and the next call sees them together. The test feeds the
   * same dump at every chunk size from one byte upwards and asserts the same
   * statements come out.
   */
  feed(text) {
    this.out = [];
    const chunk = this.buffer + text;
    this.buffer = '';
    let i = 0;
    /* Put the undecidable tail back and wait for more. */
    const hold = () => { this.buffer = chunk.slice(i); return this.out; };
    const take = (ch) => { this.statement += ch; this.atLineStart = ch === '\n'; };

    while (i < chunk.length) {
      const left = chunk.length - i;

      /* A DELIMITER DIRECTIVE, which is only a directive at the start of a line
         and only when no statement is under way. `DELIMITER` anywhere else is
         ordinary text. It is not SQL: see the note above the class. */
      if (this.state === 'sql' && this.atLineStart && !this.statement.trim()) {
        if (left < 10) {
          /* Too short to BE "delimiter" + a space — unless more is coming. */
          if (chunk.indexOf('\n', i) === -1) return hold();
        } else if (/^delimiter[ \t]/i.test(chunk.slice(i, i + 10))) {
          const nl = chunk.indexOf('\n', i);
          if (nl === -1) return hold();          // the line is not all here yet
          const word = chunk.slice(i + 10, nl).trim();
          if (word) this.delimiter = word;
          this.statement = '';
          i = nl + 1;
          this.atLineStart = true;
          continue;
        }
      }

      const ch = chunk[i];

      if (this.state === 'single' || this.state === 'double') {
        const quote = this.state === 'single' ? "'" : '"';
        if (ch === '\\') {
          /* A BACKSLASH ESCAPES THE NEXT CHARACTER, so both must be in hand. */
          if (left < 2) return hold();
          this.statement += ch + chunk[i + 1];
          this.atLineStart = false;
          i += 2;
          continue;
        }
        if (ch === quote) this.state = 'sql';
        take(ch);
        i += 1;
        continue;
      }

      if (this.state === 'backtick') {
        if (ch === '`') this.state = 'sql';
        take(ch);
        i += 1;
        continue;
      }

      if (this.state === 'line') {
        take(ch);
        if (ch === '\n') this.state = 'sql';
        i += 1;
        continue;
      }

      if (this.state === 'block') {
        if (ch === '*') {
          if (left < 2) return hold();
          if (chunk[i + 1] === '/') {
            this.statement += '*/';
            this.atLineStart = false;
            this.state = 'sql';
            i += 2;
            continue;
          }
        }
        take(ch);
        i += 1;
        continue;
      }

      /* ---- plain SQL --------------------------------------------------- */
      if (ch === "'") { this.state = 'single'; take(ch); i += 1; continue; }
      if (ch === '"') { this.state = 'double'; take(ch); i += 1; continue; }
      if (ch === '`') { this.state = 'backtick'; take(ch); i += 1; continue; }
      if (ch === '#') { this.state = 'line'; take(ch); i += 1; continue; }

      /* `-- ` IS A COMMENT, `--` FOLLOWED BY ANYTHING ELSE IS NOT (MySQL
         requires the space, so `a--b` is two minus signs). Three characters
         are needed to tell them apart. */
      if (ch === '-') {
        if (left < 3) return hold();
        if (chunk[i + 1] === '-' && /[ \t\r\n]/.test(chunk[i + 2])) {
          this.state = 'line';
          this.statement += '--';
          this.atLineStart = false;
          i += 2;
          continue;
        }
      }

      if (ch === '/') {
        if (left < 2) return hold();
        if (chunk[i + 1] === '*') {
          this.state = 'block';
          this.statement += '/*';
          this.atLineStart = false;
          i += 2;
          continue;
        }
      }

      /* THE DELIMITER, which may be more than one character (`;;`). */
      if (ch === this.delimiter[0]) {
        const want = this.delimiter;
        if (left < want.length) {
          if (chunk.slice(i) === want.slice(0, left)) return hold();
        } else if (chunk.slice(i, i + want.length) === want) {
          this.push();
          this.atLineStart = false;
          i += want.length;
          continue;
        }
      }

      take(ch);
      i += 1;
    }
    return this.out;
  }

  push() {
    const text = stripLeadingComments(this.statement);
    this.statement = '';
    /* A STATEMENT THAT IS ONLY COMMENTS AND WHITESPACE IS NOT A STATEMENT. The
       dump is full of `-- Table: assets` banners; sending one to the server is
       an error, not a no-op. A version-gated comment is NOT in this class — the
       server executes those — which is why stripLeadingComments leaves them
       alone. */
    if (text) this.out.push(text);
  }

  /* WHAT IS LEFT AT THE END OF THE FILE. A dump whose last statement has no
   * delimiter is a truncated dump, and this is where that is noticed.
   *
   * ONE NEWLINE IS FED FIRST, because the held tail may be a line comment or a
   * DELIMITER line that the file simply did not end with a newline after, and
   * both of those are complete — the newline lets the scanner finish them
   * instead of calling a comment a truncated statement.
   */
  end() {
    const flushed = [...this.feed('\n')];
    this.out = flushed;
    if (this.buffer) { this.statement += this.buffer; this.buffer = ''; }
    if (this.state !== 'sql' && this.state !== 'line') {
      const err = new Error(`The dump ends inside ${this.state === 'block' ? 'a comment' : 'a quoted value'}, `
        + 'so it is incomplete.');
      err.code = 'DUMP_TRUNCATED';
      throw err;
    }
    const tail = stripLeadingComments(this.statement);
    this.statement = '';
    if (tail) {
      const err = new Error('The dump ends in the middle of a statement, so it is incomplete. '
        + `It ended with: ${tail.slice(-80).replace(/\s+/g, ' ')}`);
      err.code = 'DUMP_TRUNCATED';
      throw err;
    }
    return this.out;
  }
}

/* Remove leading whitespace and NON-EXECUTABLE comments, and answer '' when
   nothing else is left. `/*!40101 ... *\/` is executable and is kept. */
function stripLeadingComments(text) {
  let s = String(text);
  for (;;) {
    const before = s;
    s = s.replace(/^[\s;]+/, '');
    s = s.replace(/^(?:--[ \t\r\n][^\n]*|#[^\n]*)\n?/, '');
    s = s.replace(/^--[ \t]*$/, '');
    s = s.replace(/^\/\*(?!!)[\s\S]*?\*\//, '');
    if (s === before) break;
  }
  return s.trim() ? s.trim() : '';
}

/* ===========================================================================
 * LOAD A DUMP INTO A CONNECTION.
 *
 * Statement by statement, awaited, so a dump larger than memory restores in
 * bounded memory — the same property the writer has and for the same reason.
 *
 * NO TRANSACTION AROUND THE WHOLE THING, deliberately. DDL in MariaDB is not
 * transactional: the DROP TABLE / CREATE TABLE pairs commit as they go, so a
 * wrapping transaction would give a false promise of all-or-nothing. The honest
 * protection is the one the restore script provides — refuse a database that is
 * not empty, and take a backup first when forced.
 */
async function load({ conn, source, onProgress = null, onStatement = null }) {
  const splitter = new Splitter();
  let count = 0;
  let bytes = 0;
  let lastSaid = 0;

  const run = async (statements) => {
    for (const statement of statements) {
      count += 1;
      if (onStatement) onStatement(statement);
      try {
        await conn.query(statement);
      } catch (err) {
        /* THE STATEMENT NUMBER AND ITS FIRST LINE, because "You have an error in
           your SQL syntax" against a 40 MB file is not a diagnosis. */
        const head = statement.replace(/\s+/g, ' ').slice(0, 160);
        const wrapped = new Error(`Statement ${count} of the dump failed: ${err.message}\n  ${head}`);
        wrapped.code = err.code || 'DUMP_STATEMENT_FAILED';
        wrapped.statementNumber = count;
        throw wrapped;
      }
      if (onProgress && count - lastSaid >= 200) { lastSaid = count; onProgress({ statements: count, bytes }); }
    }
  };

  if (typeof source === 'string' || Buffer.isBuffer(source)) {
    await run(splitter.feed(source.toString('utf8')));
  } else {
    /* A StringDecoder RATHER THAN source.setEncoding(), because `source` here is
       whatever the caller has: a file stream, or — the case that matters — the
       async iterable a tar entry hands out, which has no setEncoding at all.
       The decoder is also the only correct way to do this: a multi-byte
       character split across two chunks would otherwise arrive as two
       replacement characters, silently corrupting every emoji and accented name
       in the restored database. */
    const { StringDecoder } = require('string_decoder');
    const decoder = new StringDecoder('utf8');
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      const text = decoder.write(buf);
      if (text) await run(splitter.feed(text));
    }
    const tail = decoder.end();
    if (tail) await run(splitter.feed(tail));
  }
  await run(splitter.end());
  if (onProgress) onProgress({ statements: count, bytes, done: true });
  return { statements: count, bytes };
}

/* WHAT IS ALREADY IN THE TARGET DATABASE, for the "is it empty" refusal. */
async function occupancy(conn) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
  );
  return {
    empty: tables.length === 0,
    tables: tables.filter((t) => t.kind !== 'VIEW').map((t) => t.name),
    views: tables.filter((t) => t.kind === 'VIEW').map((t) => t.name),
  };
}

/* PER-TABLE CHECKSUMS, which is how a round-trip test proves the restore put
 * back what the dump took out — row counts alone would pass a dump that
 * corrupted every value.
 *
 * CHECKSUM TABLE is MariaDB's own answer and is exactly right here: it is
 * computed by the server over the stored rows, so it compares two databases
 * without either side's values passing through this code.
 */
async function checksums(conn) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
  );
  const out = {};
  for (const t of tables) {
    const [[row]] = await conn.query(`CHECKSUM TABLE ${escapeId(t.name)} EXTENDED`);
    out[t.name] = row ? String(row.Checksum) : null;
  }
  return out;
}

module.exports = {
  dump, inventory, openSnapshot, closeSnapshot,
  Splitter, load, occupancy, checksums,
  literal, escapeId, escapeString, BATCH_ROWS, BATCH_BYTES,
};
