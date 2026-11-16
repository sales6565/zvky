/* THE ONE PLACE A DEFAULT PASSWORD COMES FROM, AND IT IS NOT THE SOURCE.
 *
 * ===========================================================================
 * WHAT THIS REPLACES.
 *
 *     // src/routes/users.js, before
 *     const DEFAULT_PASSWORD = process.env.DEFAULT_USER_PASSWORD || '<a literal>';
 *
 * That literal is gone, and its going is the point of this file. A shared
 * password written into the source is in every clone of the repository, every
 * fork, every CI log that prints a diff, and the code-search index of whatever
 * host it lives on. "Set the env var in production" does not undo any of that:
 * the string is still there, it still works on any deployment that did not set
 * the variable, and nobody who reads the file afterwards can tell whether a
 * given studio is using it.
 *
 * tests/default-password.test.js fails if a string literal of ten or more
 * characters is assigned to anything whose name looks like a password in src/,
 * which is the check that keeps it gone rather than this paragraph.
 *
 * ===========================================================================
 * WHERE IT COMES FROM INSTEAD, IN ORDER.
 *
 *   1. THE CONFIGURED VALUE. What the Super Admin typed into Settings, sealed
 *      with AES-256-GCM under EMAIL_ENCRYPTION_KEY — see
 *      src/reset-password-settings.js. This is the answer the studio chose and
 *      it wins.
 *
 *   2. DEFAULT_USER_PASSWORD from the environment. Kept, and deliberately: it
 *      is how this deployment works TODAY, so a studio that upgrades without
 *      opening Settings keeps the behaviour it has rather than finding resets
 *      refused on a Monday morning. It is also the only route by which the
 *      pre-existing behaviour can be reproduced exactly, which the brief for
 *      this change asks for when the switch is off.
 *
 *   3. NOTHING. No third fallback, which is the whole change. A caller that
 *      gets null must refuse and say what to set — see refusal() below — rather
 *      than reach for a value that ships with the application.
 *
 * ===========================================================================
 * WHAT THE CALLERS DO WITH NULL, AND THE ONE CONSEQUENCE WORTH NAMING.
 *
 * Three flows used the literal: the admin reset, creating a user with no
 * password, and the bulk import's password-less rows. All three now ask here.
 * On a deployment with neither a configured default nor the env var, all three
 * refuse instead of silently using a value from the repository — which is a
 * CHANGE to the two flows this change was otherwise told to leave alone, and is
 * reported as such. The alternative was keeping a hard-coded password in order
 * to avoid changing a flow that uses a hard-coded password, which is not a
 * trade worth making.
 *
 * NOTHING HERE IS LOGGED, EVER. The value passes from this function to
 * bcrypt.hash and to one string comparison, and to nothing else.
 */
const settings = require('./reset-password-settings');

/* THE ENV VAR, READ ON EVERY CALL rather than captured at require time.
   A module-level const would freeze whatever the environment held when the
   first require ran, which in a test process is before the test has set it. */
const fromEnvironment = () => {
  const raw = process.env.DEFAULT_USER_PASSWORD;
  return typeof raw === 'string' && raw.length ? raw : null;
};

/* WHICH SOURCE ANSWERED, as a word. Returned beside the value so the reset
   route can audit "the configured default" or "the environment default"
   WITHOUT auditing which string that was. */
function resolve() {
  /* THE SWITCH IS ASKED FIRST, AND IT HAD BEEN FORGOTTEN.
   *
   * This read settings.defaultPassword() straight away, so "Reset passwords to
   * the default password" was a switch that stored a value and changed nothing:
   * turning it off left every reset still using the configured default. The
   * end-to-end suite caught it on the case written for exactly that.
   *
   * OFF SKIPS THE CONFIGURED VALUE AND FALLS THROUGH, which is what "restores
   * the behaviour found before this change" means: that behaviour was
   * DEFAULT_USER_PASSWORD from the environment, and a studio that turns the
   * switch off gets it back if they have it — and a refusal if they do not,
   * which is the same behaviour said out loud instead of silently reaching for
   * a value in the source.
   *
   * settings.useDefault() is the switch AND the presence of a value: a switch
   * that is on with nothing stored has nothing to offer either. */
  if (settings.useDefault()) {
    const configured = settings.defaultPassword();
    if (configured) return { value: configured, source: 'configured' };
  }
  const env = fromEnvironment();
  if (env) return { value: env, source: 'environment' };
  return { value: null, source: 'none' };
}

/* Is there one at all? For the Settings screen and for gating, without
   unsealing anything more often than necessary. */
const available = () => resolve().value !== null;

/* THE SENTENCE A CALLER SHOWS WHEN THERE IS NONE. Held here so the three
 * flows that can hit it say the same thing, and so it names what to do rather
 * than what went wrong. It names the SETTING first and the environment variable
 * second, because the setting is the one a Super Admin can act on without a
 * deploy. */
function refusal() {
  /* keyName() is null when the key is missing — keySource returns
     { secret: null, name: null } in strict mode, by design — so the variable is
     named from the constant rather than from the absent source. */
  const reason = settings.encryptionAvailable()
    ? 'No default password has been set.'
    : 'No default password can be stored: this server has no EMAIL_ENCRYPTION_KEY to encrypt it with.';
  return `${reason} A Super Admin sets one in Settings → Password reset, or the server is `
    + 'started with DEFAULT_USER_PASSWORD. Nothing has been changed.';
}

module.exports = { resolve, available, refusal };
