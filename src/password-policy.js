// The one definition of what makes an acceptable password.
//
// Both the API and the browser check against this: the API because it is the
// only side that can be trusted, the browser so someone sees which rule they
// have not met yet while typing rather than after a round trip. The rules are
// returned as data rather than a single message so the form can tick them off
// individually, and so the two sides can never drift apart.
//
// The minimum is 10 rather than the more common 8 because the bootstrap route
// already asked for 10, and loosening an existing rule to add a feature would
// be a strange trade.

const MIN_LENGTH = 10;
const MAX_LENGTH = 200; // bcrypt only reads the first 72 bytes; reject absurd input early

const RULES = [
  {
    id: 'length',
    label: `At least ${MIN_LENGTH} characters`,
    test: (pw) => pw.length >= MIN_LENGTH,
  },
  {
    id: 'uppercase',
    label: 'One uppercase letter',
    test: (pw) => /[A-Z]/.test(pw),
  },
  {
    id: 'lowercase',
    label: 'One lowercase letter',
    test: (pw) => /[a-z]/.test(pw),
  },
  {
    id: 'number',
    label: 'One number',
    test: (pw) => /[0-9]/.test(pw),
  },
  {
    id: 'symbol',
    label: 'One symbol (e.g. ! ? @ # $ %)',
    test: (pw) => /[^A-Za-z0-9]/.test(pw),
  },
];

// Returns { valid, failed: [{id, label}], message }.
// `message` is a single sentence suitable for an API error body.
function check(password) {
  const pw = typeof password === 'string' ? password : '';

  if (pw.length > MAX_LENGTH) {
    return {
      valid: false,
      failed: [{ id: 'length', label: `At most ${MAX_LENGTH} characters` }],
      message: `Password must be at most ${MAX_LENGTH} characters.`,
    };
  }

  const failed = RULES.filter((r) => !r.test(pw)).map(({ id, label }) => ({ id, label }));
  return {
    valid: failed.length === 0,
    failed,
    message: failed.length
      ? `Password needs: ${failed.map((f) => f.label.toLowerCase()).join(', ')}.`
      : '',
  };
}

// The rule list, for the browser to render as a checklist. No functions, so it
// serialises straight to JSON.
function describe() {
  return { minLength: MIN_LENGTH, maxLength: MAX_LENGTH, rules: RULES.map(({ id, label }) => ({ id, label })) };
}

/* A temporary password, for an administrator to hand over.
 *
 * Generated here rather than in the route so it is the same module that decides
 * what is acceptable — a generator living somewhere else is a generator that
 * drifts out of the rules and starts producing passwords its own API rejects.
 * The result is checked against check() before it is returned, so that cannot
 * happen silently.
 *
 * Readable on purpose. This gets read aloud, or typed off a screen, so it
 * avoids the characters people mistake for each other: no 0/O, no 1/l/I, no
 * 5/S (all six are gone, on both sides of each pair). That costs a little entropy and buys a password that arrives intact —
 * and it is a password with one job, which the account is forced to replace
 * before it can do anything else.
 *
 * crypto.randomInt, not Math.random: this is a credential, and Math.random is
 * not a source of those.
 */
const { randomInt } = require('crypto');

const LETTERS_UPPER = 'ABCDEFGHJKMNPQRTUVWXY';   // no I, L, O, S
const LETTERS_LOWER = 'abcdefghjkmnpqrtuvwxy';
const DIGITS = '2346789';                         // no 0, 1 or 5
const SYMBOLS = '!@#$%?';

const pick = (from, n) => Array.from({ length: n }, () => from[randomInt(from.length)]).join('');

function temporaryPassword() {
  /* Shaped so every rule is met by construction — Aaaa-nnnn-!x is 12
     characters with an upper, a lower, a digit and a symbol in it — rather
     than by generating and retrying until one happens to pass. */
  const word = LETTERS_UPPER[randomInt(LETTERS_UPPER.length)] + pick(LETTERS_LOWER, 4);
  const password = `${word}-${pick(DIGITS, 4)}-${SYMBOLS[randomInt(SYMBOLS.length)]}${pick(LETTERS_LOWER, 2)}`;
  const verdict = check(password);
  if (!verdict.valid) {
    // Unreachable while the rules and the shape agree. If somebody tightens the
    // rules without revisiting the shape, this says so instead of handing
    // somebody a password the API will refuse.
    throw new Error(`Generated temporary password does not meet the policy: ${verdict.message}`);
  }
  return password;
}

module.exports = { check, describe, temporaryPassword, MIN_LENGTH, MAX_LENGTH };
