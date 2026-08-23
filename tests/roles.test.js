const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROLES, ROLE_KEYS, GROUP_ORDER, ASSIGNABLE_ROLES, LEAD_ROLES, catalogue } = require('../src/roles');

// The catalogue is the only definition of what a designation is, so these
// guard the invariants the rest of the app relies on.

test('every key is unique', () => {
  assert.strictEqual(new Set(ROLE_KEYS).size, ROLE_KEYS.length);
});

test('no two designations share a label, compared case-insensitively and trimmed', () => {
  const seen = new Map();
  for (const key of ROLE_KEYS) {
    const norm = ROLES[key].label.trim().toLowerCase().replace(/\s+/g, ' ');
    assert.ok(!seen.has(norm), `"${ROLES[key].label}" (${key}) duplicates "${seen.get(norm)}"`);
    seen.set(norm, key);
  }
});

test('no two labels differ only in punctuation or spacing', () => {
  // "Trainee Game Artist" and "Trainee - Game Artist" would be two rows meaning
  // one job. Catch that here rather than after they are assigned to people.
  const seen = new Map();
  for (const key of ROLE_KEYS) {
    const reduced = ROLES[key].label.toLowerCase().replace(/[^a-z0-9]/g, '');
    assert.ok(!seen.has(reduced), `"${ROLES[key].label}" collides with "${seen.get(reduced)}"`);
    seen.set(reduced, ROLES[key].label);
  }
});

test('every key fits the users.role column', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const match = schema.match(/`role`\s+VARCHAR\((\d+)\)/i);
  assert.ok(match, 'could not find the role column in schema.sql');
  const limit = Number(match[1]);
  for (const key of ROLE_KEYS) {
    assert.ok(key.length <= limit, `"${key}" is ${key.length} characters; the column holds ${limit}`);
  }
});

test('every key is a safe identifier', () => {
  for (const key of ROLE_KEYS) {
    assert.match(key, /^[a-z][a-z0-9_]*$/, `"${key}" is not a plain lowercase identifier`);
  }
});

test('every designation carries the fields the UI renders', () => {
  for (const key of ROLE_KEYS) {
    const def = ROLES[key];
    assert.strictEqual(typeof def.label, 'string');
    assert.ok(def.label.trim().length > 0, `${key} has an empty label`);
    assert.strictEqual(typeof def.rank, 'number', `${key} has no rank`);
    assert.match(def.color, /^#[0-9a-f]{3,8}$/i, `${key} has no usable colour`);
  }
});

test('every group appears in GROUP_ORDER, so nothing sorts to the top by accident', () => {
  for (const key of ROLE_KEYS) {
    assert.ok(
      GROUP_ORDER.includes(ROLES[key].group),
      `group "${ROLES[key].group}" (from ${key}) is missing from GROUP_ORDER`
    );
  }
});

test('capabilities stay internally consistent', () => {
  for (const key of ROLE_KEYS) {
    const def = ROLES[key];
    assert.ok(['all', 'owned', 'assigned', 'team', 'own_work'].includes(def.projectScope), `${key}: bad projectScope`);
    assert.ok([null, 'tl', 'cd'].includes(def.reviewStage), `${key}: bad reviewStage`);
    assert.ok([null, 'any', 'owned'].includes(def.deleteAsset), `${key}: bad deleteAsset`);
    // Work is assigned to contributors; leads review it. Being both would put
    // someone on both sides of their own review.
    assert.ok(!(def.assignable && def.leadsTeam), `${key} is both assignable and a lead`);
    // A lead reviews the work of reports, so it needs a team to hold the gate.
    if (def.reviewStage === 'tl') assert.ok(def.leadsTeam, `${key} holds the TL gate but leads nobody`);
  }
});

test('catalogue() returns every designation, grouped and ranked', () => {
  const list = catalogue();
  assert.strictEqual(list.length, ROLE_KEYS.length);
  const positions = list.map((r) => GROUP_ORDER.indexOf(r.group));
  assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b), 'groups are not in GROUP_ORDER order');
  for (const entry of list) {
    assert.ok(entry.key && entry.label && entry.group);
  }
});

test('the derived role lists agree with the catalogue', () => {
  assert.deepStrictEqual(ASSIGNABLE_ROLES, ROLE_KEYS.filter((k) => ROLES[k].assignable));
  assert.deepStrictEqual(LEAD_ROLES, ROLE_KEYS.filter((k) => ROLES[k].leadsTeam));
  assert.ok(ASSIGNABLE_ROLES.length > 0 && LEAD_ROLES.length > 0);
});

test('the candidate list in scripts/ contains nothing unreviewed and unadded', () => {
  // Anything neither present nor flagged would have been silently dropped.
  const { classify } = require('../scripts/check-roles');
  const file = path.join(__dirname, '..', 'scripts', 'roles-to-add.txt');
  const candidates = fs.readFileSync(file, 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const { added, skipped, flagged } = classify(candidates);
  assert.strictEqual(added.length, 0, `still to add: ${added.map((a) => a.label).join(', ')}`);
  assert.strictEqual(skipped.length + flagged.length, candidates.length);
});
