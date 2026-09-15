// The Level on a user: a two-rung ladder, recorded and nothing more.
//
// WHAT THIS IS. A studio's org chart has more shape than one designation can
// carry. Two people can both be "Team Lead" in the catalogue while one of them
// sits a rung above the other, and Level is where that is written down.
//
// WHAT THIS IS NOT, and the whole point of the file saying so. Level drives
// NOTHING. It does not route an approval, escalate anything, widen anybody's
// access, or feed a permission check. It is recorded and displayed, exactly
// like the Reporting To field beside it, and for the same reason: an
// informational field that quietly acquires behaviour is how a studio ends up
// unable to correct somebody's org chart without changing what they can do.
//
// If a later feature wants to route by Level, that is a new decision to take
// deliberately — and tests/users.test.js is where it will fail first, because a
// guard there asserts nothing outside this module reads the column.
//
// TWO OPTIONS, AND THEY ARE FIXED. Not a reference table: the studio asked for
// exactly these two rungs, and a managed list would invite a third that nothing
// downstream knows how to read. Adding one is a code change, on purpose.
//
// UNSET IS A REAL STATE. Every account that predates this field has no level,
// and so does anybody the ladder does not apply to. NULL says that; it is not
// the same as being on the bottom rung, and the screen offers "Not set" as a
// choice you can go back to.

const LEVELS = [
  { key: 'level_1', label: 'Level 1 - Team Lead' },
  { key: 'level_2', label: 'Level 2 - Manager' },
];

const BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

/* The label for a stored key, for a screen that has only the key.
   An unrecognised key comes back as itself rather than as blank: a value that
   somehow reached the column is better shown than silently hidden. */
function label(key) {
  if (!key) return null;
  const found = BY_KEY.get(key);
  return found ? found.label : key;
}

/* What the API accepts.
 *
 * Returns { ok, value } or { ok:false, error }. Null and empty string both mean
 * "not set" — clearing a level is an ordinary thing to want, and there is no
 * destructive reading of a blank here the way there was for a rate: a level
 * carries no arithmetic, so an empty box means the obvious thing. */
function validate(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const key = String(raw).trim();
  if (!key) return { ok: true, value: null };
  if (!BY_KEY.has(key)) {
    return {
      ok: false,
      error: `"${key}" is not a level. Choose ${LEVELS.map((l) => l.label).join(' or ')}.`,
    };
  }
  return { ok: true, value: key };
}

module.exports = { LEVELS, BY_KEY, label, validate };
