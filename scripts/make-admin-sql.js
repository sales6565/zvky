#!/usr/bin/env node
// Prints SQL that creates one super admin account.
//
//   node scripts/make-admin-sql.js "Your Name" you@zvky.com
//
// For platforms with no shell access to the app — paste the output into
// phpMyAdmin, Adminer, or whatever database console the host provides.
// `npm run seed` is the fuller option when you can run commands: it also
// creates sample staff and projects. This creates exactly one login.
//
// A password is generated unless you pass one as the third argument. It is
// printed once, to the terminal only, and never written to a file.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const [name, email, given] = process.argv.slice(2);
if (!name || !email) {
  console.error('Usage: node scripts/make-admin-sql.js "Your Name" you@example.com [password]');
  process.exit(1);
}

// Ambiguous characters left out so the password survives being read aloud
// or retyped from a screen.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generate(len = 20) {
  return Array.from(crypto.randomFillSync(new Uint32Array(len)))
    .map((n) => ALPHABET[n % ALPHABET.length])
    .join('');
}

const password = given || generate();
const hash = bcrypt.hashSync(password, 10);
const sqlEmail = email.replace(/'/g, "''");
const sqlName = name.replace(/'/g, "''");

console.log(`
-- Creates one super admin. Safe to re-run: it updates the password if the
-- email already exists rather than failing on the unique index.
INSERT INTO users (id, \`name\`, email, password_hash, \`role\`)
VALUES (UUID(), '${sqlName}', '${sqlEmail}', '${hash}', 'super_admin')
ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), \`role\` = 'super_admin';
`);
console.error(`Sign in with:  ${email}`);
console.error(`Password:      ${password}`);
console.error(given ? '' : '\n(Generated. Copy it now — it is not stored anywhere.)');
