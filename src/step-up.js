/* RE-TYPING YOUR OWN PASSWORD BEFORE A DANGEROUS ACTION.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHAT IT IS AND IS NOT WORTH.
 *
 * A session token in this application lives for a long time, because signing
 * the studio out every few hours would be its own kind of harm. That is the
 * right trade for almost everything — and the wrong one for two actions:
 * producing a file that contains every password hash in the studio, and taking
 * a copy of that file off the server.
 *
 * So those two ask for the account's own password again, server-side, at the
 * moment of the action. What that buys is narrow and worth stating plainly:
 *
 *   IT BUYS   an unattended laptop, a borrowed phone or a stolen token is not
 *             enough on its own to walk out with the studio's data. Somebody
 *             has to know the password as well.
 *   IT DOES NOT BUY  protection from somebody who knows the password, or from
 *             malware in the browser that can read it as it is typed. Nothing
 *             a web application can do buys those.
 *
 * ===========================================================================
 * WHY IT IS NOT A "VERIFIED FOR THE NEXT FIFTEEN MINUTES" TICKET.
 *
 * That is the usual shape, and it was considered. It would mean a second kind
 * of credential with its own lifetime, its own storage and its own revocation —
 * and the window is exactly the thing being closed. Two actions in a session is
 * two passwords typed; the owner taking a backup and then downloading it types
 * it twice, which is three seconds and is the point.
 *
 * ===========================================================================
 * WHAT IT NEVER DOES: log, audit, echo or store the password. The parameter is
 * read, compared and dropped. The audit entry the CALLER writes records that a
 * step-up happened, never what was typed.
 */
const bcrypt = require('bcryptjs');

const FIELD = 'password';

/* The refusal, as one sentence, so three routes cannot word it three ways. */
const PROMPT = 'Type your own password again to confirm this.';

/* Verify the password of the account making the request.
 *
 * Returns { ok: true } or { ok: false, status, error, field } shaped like every
 * other validator in this codebase, so a route can hand it straight back.
 *
 * THE HASH IS READ FRESH, not taken from req.user: a password changed in
 * another tab a moment ago must be the one that counts, and authenticate()
 * does not carry the hash.
 */
async function verify(db, user, password) {
  const typed = String(password === undefined || password === null ? '' : password);
  if (!typed) {
    return { ok: false, status: 400, field: FIELD, error: PROMPT };
  }
  if (!user || !user.id) {
    return { ok: false, status: 401, error: 'Sign in again.' };
  }

  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!rows.length || !rows[0].password_hash) {
    /* No hash on the row is not "anything matches": it is an account that
       cannot confirm anything, and the action is refused. */
    return { ok: false, status: 403, field: FIELD,
      error: 'This account has no password set, so it cannot confirm this action.' };
  }

  const matches = await bcrypt.compare(typed, rows[0].password_hash);
  if (!matches) {
    /* THE SAME SENTENCE WHATEVER WENT WRONG, and no hint about how close it
       was. This endpoint is reachable by anybody already signed in, so a
       message that distinguished "wrong password" from "no password set" would
       be a way to learn about an account. */
    return { ok: false, status: 403, field: FIELD,
      error: 'That password is not right. Type the password for this account.' };
  }
  return { ok: true };
}

module.exports = { verify, FIELD, PROMPT };
