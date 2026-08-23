const test = require('node:test');
const assert = require('node:assert');
const policy = require('../src/password-policy');

// The policy is pure, so these run anywhere — no database, no server.

test('accepts a password meeting every rule', () => {
  const result = policy.check('Brand-New-Pass-9!');
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.message, '');
});

test('rejects a password that is too short', () => {
  const result = policy.check('Ab1!x');
  assert.strictEqual(result.valid, false);
  assert.ok(result.failed.some((f) => f.id === 'length'));
});

test('requires an uppercase letter', () => {
  const result = policy.check('all-lower-123!');
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.failed.map((f) => f.id), ['uppercase']);
});

test('requires a lowercase letter', () => {
  const result = policy.check('ALL-UPPER-123!');
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.failed.map((f) => f.id), ['lowercase']);
});

test('requires a number', () => {
  const result = policy.check('NoDigitsHere!!');
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.failed.map((f) => f.id), ['number']);
});

test('requires a symbol', () => {
  const result = policy.check('NoSymbols1234');
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.failed.map((f) => f.id), ['symbol']);
});

test('reports every unmet rule at once, so the form can list them', () => {
  const result = policy.check('abc');
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(
    result.failed.map((f) => f.id).sort(),
    ['length', 'number', 'symbol', 'uppercase']
  );
});

test('rejects an absurdly long password rather than hashing it', () => {
  const result = policy.check('Aa1!'.repeat(200));
  assert.strictEqual(result.valid, false);
  assert.match(result.message, /at most/i);
});

test('treats a missing or non-string password as failing everything', () => {
  for (const value of [undefined, null, 12345, {}]) {
    assert.strictEqual(policy.check(value).valid, false);
  }
});

test('describe() gives the browser the rules without any functions', () => {
  const described = policy.describe();
  assert.strictEqual(typeof described.minLength, 'number');
  assert.ok(Array.isArray(described.rules));
  assert.deepStrictEqual(
    described.rules.map((r) => r.id).sort(),
    ['length', 'lowercase', 'number', 'symbol', 'uppercase']
  );
  for (const rule of described.rules) {
    assert.strictEqual(typeof rule.label, 'string');
    assert.ok(rule.label.length > 0);
    assert.strictEqual(JSON.parse(JSON.stringify(rule)).id, rule.id);
  }
});

test('the rules the browser renders match the ones the API enforces', () => {
  // Guards against src/password-policy.js and the checkRule() mirror in
  // public/index.html drifting apart.
  const fs = require('node:fs');
  const page = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const rule of policy.describe().rules) {
    assert.ok(page.includes(`case '${rule.id}':`), `public/index.html has no branch for the "${rule.id}" rule`);
  }
});
