/* The integration's secrets as this process actually holds them, read the same way
 * everywhere, and a fingerprint that says WHICH secret without saying WHAT it is.
 *
 * WHY THIS EXISTS. Forge and Dev & QA run on different hosting screens, and a value
 * pasted into an environment-variable form can arrive with a trailing newline or
 * space, or wrapped in quotes, on one side and not the other. Every signature then
 * fails with "does not match", and nothing says why. So:
 *
 *   surrounding whitespace (spaces, tabs, CR, LF) is removed, and the start-up log
 *     says so. It is never part of a real secret: our recommended format is 64 letters
 *     and digits, and both ends remove it the same way, so the two still agree.
 *   surrounding quotes, or whitespace INSIDE the value, are refused with a clear
 *     problem, never stripped: either could be part of somebody's real value, and
 *     guessing would make a mismatch silent instead of visible.
 *   anything outside letters and digits, or under 32 characters, is a warning only, so
 *     a deployment already running on such a value keeps working.
 *
 * THE FINGERPRINT is the first 12 hex characters of SHA-256 over the exact secret
 * (after the whitespace removal above), written "sha256:abcdef012345". Dev & QA
 * computes the same over its FORGE_SIGNING_SECRET; equal fingerprints mean both apps
 * loaded the same secret. It cannot be turned back into the secret, but it is still
 * kept to the server log and the Super Admin's integration screen.
 */
const crypto = require('node:crypto');

const fingerprint = (value) => `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)}`;

function inspect(name, raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null, problem: null, notes: [], fingerprint: null };
  const notes = [];
  const text = String(raw);
  const trimmed = text.replace(/^[\s﻿]+|[\s﻿]+$/g, '');
  if (!trimmed) return { value: null, problem: `${name} is set but empty (only spaces or line breaks).`, notes, fingerprint: null };
  if (trimmed !== text) notes.push(`${name} had spaces or line breaks around it; they were ignored.`);
  let problem = null;
  if (trimmed.length >= 2 && /^(["'`]).*\1$/s.test(trimmed)) problem = `${name} is wrapped in quotes. Enter the value without the quotes.`;
  else if (/\s/.test(trimmed)) problem = `${name} has a space or line break inside it. Paste it again as one line.`;
  if (!problem) {
    if (trimmed.length < 32) notes.push(`${name} is shorter than 32 characters; 64 random letters and digits are recommended.`);
    else if (!/^[A-Za-z0-9]+$/.test(trimmed)) notes.push(`${name} contains characters other than letters and digits, which some hosting screens alter; 64 random letters and digits are recommended.`);
  }
  return { value: problem ? null : trimmed, problem, notes, fingerprint: problem ? null : fingerprint(trimmed) };
}

// Read from the environment each time (tests and a restart set it), cached per raw value.
const cache = new Map();
function read(name) {
  const raw = process.env[name];
  const hit = cache.get(name);
  if (hit && hit.raw === raw) return hit.out;
  const out = inspect(name, raw);
  cache.set(name, { raw, out });
  return out;
}

/* At start-up: which secrets this process holds, by fingerprint, and anything wrong with
   how they were entered. Silent when the integration is off and nothing is set. */
function describeAtStartup(log = console.log) {
  const names = ['INTEGRATION_INBOUND_SECRET', 'INTEGRATION_INBOUND_SECRET_PREVIOUS', 'INTEGRATION_OUTBOUND_SECRET'];
  const on = /^(1|true|yes|on)$/i.test(String(process.env.INTEGRATION_ENABLED || ''));
  if (!on && !names.some((n) => process.env[n])) return;
  const inbound = read(names[0]);
  if (inbound.fingerprint) log(`[integration] Integration inbound signing key fingerprint: ${inbound.fingerprint} (Dev & QA's FORGE_SIGNING_SECRET must show the same).`);
  else if (!inbound.problem) log('[integration] INTEGRATION_INBOUND_SECRET is not set: every integration request is refused until it is.');
  const prev = read(names[1]);
  if (prev.fingerprint) log(`[integration] Previous inbound signing key (rotation) fingerprint: ${prev.fingerprint}.`);
  const out = read(names[2]);
  if (out.fingerprint) log(`[integration] Outbound (push) signing key fingerprint: ${out.fingerprint} (Dev & QA's FORGE_WEBHOOK_SECRET must show the same).`);
  for (const r of [inbound, prev, out]) {
    if (r.problem) log(`[integration] ${r.problem}`);
    for (const n of r.notes) log(`[integration] ${n}`);
  }
}

module.exports = { inspect, read, fingerprint, describeAtStartup };
