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

module.exports = { check, describe, MIN_LENGTH, MAX_LENGTH };
