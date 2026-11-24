/* A GUARD THAT MAKES A WRITE IMPOSSIBLE, for `node --require` in a child process.
 *
 * ===========================================================================
 * WHY THIS EXISTS, which is a mutation this repository's own battery got past.
 *
 * scripts/user-sees.js must not write: it is meant to be run against production while
 * somebody is on the phone. That was tested two ways — a scan of the source for writing
 * verbs, and a checksum of every table before and after a real run — and a mutation that
 * added
 *
 *     UPDATE users SET name = name WHERE id = $1
 *
 * to the script was caught by the source scan and NOT by the checksums. Of course it was:
 * the statement changes no bytes, so a comparison of bytes cannot see it. A no-op write is
 * still a write — it takes locks, it goes in the binary log, it fires triggers, and it is
 * a statement a replica or a read-only user will refuse — so "the data came back identical"
 * is the wrong question.
 *
 * The right question is whether the process ISSUES one, and the honest way to ask it is to
 * give the script a database that will not accept one. A read-only MySQL user would be the
 * real thing; creating one needs privileges over the whole server, which a test suite
 * should not be handing itself. So the refusal is placed at the only other point every
 * statement passes through: src/db's query().
 *
 * Loaded with --require, this runs BEFORE the script does, replaces that one function, and
 * leaves the real one in place for reads. A statement that is not a read is printed and the
 * process exits 3 — a code of its own, so a caller can tell "it tried to write" apart from
 * the script's own exit 1 for "nobody matched" and from a crash.
 */
const path = require('node:path');

const db = require(path.join(__dirname, '..', 'src', 'db'));

/* WHAT COUNTS AS A READ. Deliberately a short list of openers rather than a search for
   writing verbs: a guard that looks for UPDATE lets through the next verb somebody uses,
   and this one has to be wrong in the safe direction. CHECKSUM and ANALYZE are reads of a
   sort and are still refused — nothing a diagnostic does should need them. */
const READS = /^(select|show|describe|desc|explain|with)\b/i;

const real = db.query.bind(db);
db.query = (sql, params) => {
  const text = String(sql == null ? '' : sql).trim().replace(/^\(+\s*/, '');
  if (!READS.test(text)) {
    process.stderr.write(
      `read-only-guard: this process may only read, and it issued: ${text.slice(0, 200)}\n`
    );
    /* Not an exception: the script catches those and would report this as its own failure
       to answer, which is a different thing from "it tried to write". */
    process.exit(3);
  }
  return real(sql, params);
};
