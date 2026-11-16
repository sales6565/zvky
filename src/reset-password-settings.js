/* THE DEFAULT PASSWORD AN ADMIN RESET SETS, AND NOTHING ELSE ABOUT IT.
 *
 * ===========================================================================
 * WHAT THE STUDIO ASKED FOR. When an administrator resets somebody's password,
 * the account gets ONE value the Super Admin has chosen — a known string the
 * admin can say out loud over a desk — and the person must replace it at their
 * next sign-in. That is a deliberate trade: a shared default is weaker than a
 * generated one-off, and it is paid for by the forced change, the expiry below,
 * and the fact that the value is never written anywhere readable.
 *
 * ===========================================================================
 * WHAT WAS THERE BEFORE, AND WHY IT HAD TO MOVE.
 *
 * src/routes/users.js carried
 *
 *     const DEFAULT_PASSWORD = process.env.DEFAULT_USER_PASSWORD || '<a literal>';
 *
 * and three flows used it: the admin reset, creating a user without a password,
 * and the bulk import. All three ALSO handed the value back in their response,
 * which the page printed on screen.
 *
 * Two things were wrong with that and only one of them is obvious. The obvious
 * one is the literal: a shared password in the source is a shared password in
 * every clone, every fork, every CI log and the GitHub search index, and no
 * amount of "set the env var in production" makes it not be there. The second
 * is the response: a value in a JSON body is in the browser's memory, in any
 * proxy log that records bodies, and in a screenshot.
 *
 * SO THE VALUE NOW LIVES IN ONE PLACE, ENCRYPTED, AND IS NEVER RETURNED.
 * current() below is what every reader gets, and it carries `defaultSet` and
 * `defaultSetAt` — whether there is one and when it was last changed — and not
 * the value. There is no accessor that returns it to a caller outside this
 * process: defaultPassword() exists for the reset path and for comparing a
 * proposed new password against, both of which happen on the server.
 *
 * NOBODY CAN READ IT BACK, INCLUDING THE PERSON WHO SET IT. That is not an
 * oversight to fix later. A field that can be read back is a field that leaks
 * through whoever holds the screen; the Super Admin who needs to know the value
 * sets it again.
 *
 * ===========================================================================
 * THE STRICT SECRET MECHANISM, AND WHY NO FALLBACK.
 *
 * src/email-secret.js in STRICT mode: AES-256-GCM under EMAIL_ENCRYPTION_KEY
 * ONLY, with no fall-back to JWT_SECRET. src/server-settings.js already holds
 * the office server's signing key and gateway secret the same way, and the
 * reasoning is its reasoning: JWT_SECRET is a signing key that a deployment may
 * rotate to sign everybody out, and a password encrypted under it would be
 * destroyed by that rotation. Worse, a fallback means a deployment that never
 * set EMAIL_ENCRYPTION_KEY silently stores this under a key chosen for a
 * different purpose and thinks it is protected.
 *
 * WITHOUT THE KEY THE FEATURE IS OFF, SAID OUT LOUD. encryptionAvailable is
 * false, setting a default is refused with the env var named, and a reset falls
 * back to the behaviour described under resolve() in
 * src/default-password.js — never to a value from the source.
 *
 * ===========================================================================
 * THE EXPIRY IS WHAT MAKES A SHARED DEFAULT TOLERABLE.
 *
 * `validHours` (0-720, default 72) is how long after the reset the default
 * still signs the account in. After that the account needs resetting again. 0
 * means no expiry, which a studio may choose and which this module will store
 * without arguing — but 72 is the shipped default because a credential three
 * people have heard is a credential that should stop working by Monday.
 *
 * THE LOGIN FORM IS NOT TOLD WHY. An expired default fails with the ordinary
 * "Invalid email or password", because "that password has expired" tells
 * somebody guessing that they had the right string.
 */
const emailSecret = require('./email-secret');
const policy = require('./password-policy');

const STRICT = { strict: true };

const HOURS_MIN = 0;
const HOURS_MAX = 720;            // thirty days; past that, reset it again

const DEFAULTS = {
  useDefault: true,
  forceChange: true,
  validHours: 72,
};

let cache = { ...DEFAULTS, defaultSet: false, defaultSetAt: null,
  updatedBy: null, updatedByName: null, updatedAt: null };
let loaded = false;
/* THE SEALED BYTES, HELD SEPARATELY FROM THE CACHE EVERY READER GETS.
   current() spreads `cache`, and a sealed value living in it would ride out
   through every caller that logs or returns its own settings object. */
let sealed = { value: null, fingerprint: null };

async function load(db) {
  const { rows } = await db.query(
    `SELECT p.*, u.\`name\` AS updated_by_name
       FROM password_reset_settings p
       LEFT JOIN users u ON u.id = p.updated_by
      WHERE p.id = 1`
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  const bool = (value, fallback) => (value === undefined || value === null
    ? fallback : Boolean(Number(value)));
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  sealed = row
    ? { value: row.default_sealed || null, fingerprint: row.default_key_fp || null }
    : { value: null, fingerprint: null };

  cache = {
    useDefault: bool(row && row.use_default, DEFAULTS.useDefault),
    forceChange: bool(row && row.force_change, DEFAULTS.forceChange),
    validHours: Math.min(HOURS_MAX, Math.max(HOURS_MIN,
      num(row && row.valid_hours, DEFAULTS.validHours))),
    /* WHETHER, NOT WHAT. The only two facts about the value any reader gets. */
    defaultSet: Boolean(sealed.value),
    defaultSetAt: (row && row.default_set_at) || null,
    updatedBy: (row && row.updated_by) || null,
    updatedByName: (row && row.updated_by_name) || null,
    updatedAt: (row && row.updated_at) || null,
  };
  loaded = true;
  return cache;
}

const isLoaded = () => loaded;

/* WHAT EVERY READER GETS, AND IT CANNOT CARRY THE VALUE. The sealed bytes are
   not in `cache` at all (see above), so a caller that spreads this into a log
   line or a JSON body is spreading something safe by construction rather than
   by remembering to delete a field. */
const current = () => ({ ...cache, encryptionAvailable: emailSecret.available(STRICT) });

const useDefault = () => Boolean(cache.useDefault) && Boolean(sealed.value);
const forceChange = () => Boolean(cache.forceChange);
const validHours = () => Math.min(HOURS_MAX, Math.max(HOURS_MIN, Number(cache.validHours) || 0));

/* THE VALUE, IN THIS PROCESS ONLY.
 *
 * Two callers, both on the server: the reset route, which hashes it; and the
 * change-password route, which compares a proposed new password against it so
 * that "change your password" cannot mean "set it to the one everybody knows".
 *
 * Returns null when there is none, when the key is missing, or when the stored
 * bytes were sealed under a key this process does not have — which is a studio
 * that rotated EMAIL_ENCRYPTION_KEY, and the honest answer there is "there is
 * no default any more", not a crash on every reset. */
function defaultPassword() {
  if (!sealed.value) return null;
  if (!emailSecret.available(STRICT)) return null;
  try {
    return emailSecret.decrypt(sealed.value, sealed.fingerprint, STRICT) || null;
  } catch {
    return null;
  }
}

/* IS THIS THE DEFAULT? Asked by the change-password route. A separate function
   rather than exposing the value to the caller, so the comparison happens here
   and the string never reaches another module. */
function isDefaultPassword(candidate) {
  const value = defaultPassword();
  if (!value || typeof candidate !== 'string' || !candidate) return false;
  return candidate === value;
}

/* HAS THE RESET EXPIRED? `resetAt` is users.password_reset_at.
 *
 * 0 hours means no expiry. A null resetAt means this account's password was not
 * set by a reset — a fresh account, or somebody who changed their own — and a
 * value with no reset behind it cannot expire. */
function resetExpired(resetAt, now = Date.now()) {
  const hours = validHours();
  if (!hours) return false;
  if (!resetAt) return false;
  const at = Number(resetAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now > at + hours * 3600 * 1000;
}

/* ---------- writing ---------------------------------------------------------- */

function validateSwitches(input = {}) {
  const out = {};
  for (const [key, column] of [['useDefault', 'use_default'], ['forceChange', 'force_change']]) {
    if (input[key] !== undefined) out[column] = input[key] ? 1 : 0;
  }
  if (input.validHours !== undefined) {
    const n = Number(input.validHours);
    if (!Number.isInteger(n) || n < HOURS_MIN || n > HOURS_MAX) {
      return { ok: false, field: 'validHours',
        error: `The default password's life must be a whole number of hours between ${HOURS_MIN} and ${HOURS_MAX}.` };
    }
    out.valid_hours = n;
  }
  return { ok: true, sets: out };
}

/* THE VALUE IS CHECKED AGAINST THE CURRENT POLICY, AND THE POLICY IS NOT BENT.
 *
 * src/password-policy.js is the one definition of an acceptable password, and
 * this value is a password: it signs somebody in. A default that could skip the
 * rules would be a hole shaped exactly like the feature — "every reset sets a
 * weak password" is worse than one weak password, because it is every account
 * anybody has ever reset.
 *
 * The unmet rules are named back, by the policy's own labels, so the Settings
 * screen can say which one failed rather than "invalid". */
function validateDefault(value) {
  if (typeof value !== 'string' || !value) {
    return { ok: false, field: 'defaultPassword', error: 'Type the default password.' };
  }
  const verdict = policy.check(value);
  if (!verdict.valid) {
    return { ok: false, field: 'defaultPassword', error: verdict.message, failed: verdict.failed };
  }
  return { ok: true, value };
}

module.exports = {
  STRICT,
  HOURS_MIN,
  HOURS_MAX,
  DEFAULTS,
  load,
  isLoaded,
  current,
  useDefault,
  forceChange,
  validHours,
  defaultPassword,
  isDefaultPassword,
  resetExpired,
  validateSwitches,
  validateDefault,
  /* FOR THE WRITE PATH ONLY, and deliberately not a setter that takes plain
     text and keeps it: the route encrypts, writes the row and calls load()
     again, so this module never holds an unsealed value between requests. */
  seal: (value) => emailSecret.encrypt(value, STRICT),
  encryptionAvailable: () => emailSecret.available(STRICT),
  keyName: () => emailSecret.keySource(STRICT).name,
};
