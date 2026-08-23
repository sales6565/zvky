#!/usr/bin/env node
// Compares a list of candidate designations against the catalogue in
// src/roles.js and reports what is new, what already exists, and what looks
// like a near-duplicate that a person should look at before it goes in.
//
//   npm run roles:check                    # uses scripts/roles-to-add.txt
//   npm run roles:check -- path/to/list.txt
//
// It only ever reads. Roles live in code, not a table, so there is nothing to
// insert: adding one means adding an entry to src/roles.js, and the catalogue
// holding each key exactly once is what makes that idempotent. This script is
// how you check that before and after.

const fs = require('node:fs');
const path = require('node:path');
const { ROLES, ROLE_KEYS } = require('../src/roles');

// --- normalising ------------------------------------------------------------
// Titles arrive from spreadsheets and HR systems, so they carry en dashes,
// non-breaking spaces and doubled spaces. Compare on a normalised form.
function normalise(label) {
  return String(label)
    .replace(/[‐-―]/g, '-')  // dash variants -> hyphen
    .replace(/ /g, ' ')           // non-breaking space
    .replace(/\s+/g, ' ')
    .trim();
}

// Case-insensitive, trimmed comparison, as asked for.
function compareKey(label) {
  return normalise(label).toLowerCase();
}

// Letters and digits only: two titles differing solely in punctuation or
// spacing collapse to the same value here.
function reduce(label) {
  return compareKey(label).replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

// Is `long` the same title as `short` with a trailing qualifier bolted on?
function isQualifiedForm(long, short) {
  const l = compareKey(long);
  const s = compareKey(short);
  return l.length > s.length && /^[-–—:(]/.test(l.slice(s.length).trim()) && l.startsWith(s);
}

// The key a label would get in src/roles.js.
function keyFor(label) {
  return compareKey(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// --- comparison -------------------------------------------------------------
function classify(candidates) {
  const existing = ROLE_KEYS.map((key) => ({ key, label: ROLES[key].label }));
  const byCompare = new Map(existing.map((e) => [compareKey(e.label), e]));
  const byReduced = new Map(existing.map((e) => [reduce(e.label), e]));

  const added = [];
  const skipped = [];
  const flagged = [];
  const seen = new Map(); // within the candidate list itself

  for (const raw of candidates) {
    const label = normalise(raw);
    const cmp = compareKey(label);
    const red = reduce(label);

    const exact = byCompare.get(cmp);
    if (exact) {
      skipped.push({ label, reason: `already in the catalogue as "${exact.label}" (${exact.key})` });
      continue;
    }

    const notes = [];

    // Same letters, different punctuation — against the catalogue...
    const punctTwin = byReduced.get(red);
    if (punctTwin) notes.push(`differs from existing "${punctTwin.label}" only in punctuation or spacing`);
    // ...and against the rest of this list.
    const listTwin = seen.get(red);
    if (listTwin) notes.push(`differs from "${listTwin}" elsewhere in this list only in punctuation or spacing`);

    // One or two characters apart: typos such as Associate / Associator.
    for (const e of existing) {
      const d = levenshtein(red, reduce(e.label));
      if (d > 0 && d <= 2 && red.length > 8) {
        notes.push(`is ${d} character${d > 1 ? 's' : ''} away from existing "${e.label}" — possible typo`);
      }
    }
    for (const [otherRed, otherLabel] of seen) {
      const d = levenshtein(red, otherRed);
      if (d > 0 && d <= 2 && red.length > 8) {
        notes.push(`is ${d} character${d > 1 ? 's' : ''} away from "${otherLabel}" elsewhere in this list`);
      }
    }

    // A title plus a trailing "- MIS" / "- Marketing" style qualifier.
    for (const e of existing) {
      if (isQualifiedForm(label, e.label)) {
        notes.push(`is existing "${e.label}" with a trailing qualifier`);
      }
    }
    for (const otherLabel of seen.values()) {
      if (isQualifiedForm(label, otherLabel)) {
        notes.push(`is "${otherLabel}" from this list with a trailing qualifier`);
      }
    }

    const key = keyFor(label);
    if (key.length > 64) notes.push(`generated key is ${key.length} characters; users.role holds 64`);

    if (notes.length) flagged.push({ label, key, notes: [...new Set(notes)] });
    else added.push({ label, key });

    seen.set(red, label);
  }

  // When two candidates collide with each other, the first was classified
  // before the second existed to compare against, so it sits in `added` while
  // only its partner is flagged. Pull it across: a colliding pair is a decision
  // about which spelling to keep, and neither half should go in unreviewed.
  const flaggedLabels = new Set(flagged.map((f) => f.label));
  for (let i = added.length - 1; i >= 0; i--) {
    const candidate = added[i];
    if (flaggedLabels.has(candidate.label)) continue;
    const partner = flagged.find((f) => f.notes.some((n) => n.includes(`"${candidate.label}"`)));
    if (!partner) continue;
    flagged.push({
      label: candidate.label,
      key: candidate.key,
      notes: [`collides with "${partner.label}" elsewhere in this list — pick one spelling`],
    });
    flaggedLabels.add(candidate.label);
    added.splice(i, 1);
  }

  return { added, skipped, flagged };
}

// --- reporting --------------------------------------------------------------
function main() {
  const file = process.argv[2] || path.join(__dirname, 'roles-to-add.txt');
  const candidates = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const { added, skipped, flagged } = classify(candidates);

  console.log(`\nChecked ${candidates.length} candidate designations against ${ROLE_KEYS.length} in the catalogue.\n`);

  console.log(`NEW — not in the catalogue (${added.length})`);
  if (!added.length) console.log('  none');
  added.forEach((r) => console.log(`  + ${r.label.padEnd(52)} ${r.key}`));

  console.log(`\nSKIPPED — already present, left untouched (${skipped.length})`);
  if (!skipped.length) console.log('  none');
  skipped.forEach((r) => console.log(`  = ${r.label.padEnd(52)} ${r.reason}`));

  console.log(`\nFLAGGED — look at these before they go in (${flagged.length})`);
  if (!flagged.length) console.log('  none');
  flagged.forEach((r) => {
    console.log(`  ! ${r.label}`);
    r.notes.forEach((n) => console.log(`      ${n}`));
  });

  console.log(
    `\n${added.length} to add, ${skipped.length} already there, ${flagged.length} awaiting review.\n`
  );
  return flagged.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { classify, normalise, compareKey, reduce, keyFor, isQualifiedForm, levenshtein };
