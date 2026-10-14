/* WHICH WAY MAIL LEAVES THE BUILDING — one switch, three answers.
 *
 * EMAIL_TRANSPORT:
 *
 *   gmail_api   the Gmail API over HTTPS. What the studio uses: its host blocks
 *               outbound SMTP ports, and 443 is the one thing that always works.
 *   smtp        nodemailer against the saved mail-server settings. KEPT, not
 *               deprecated — a studio that later moves to a host without the
 *               port restriction, or to its own relay, changes one variable.
 *   log         writes a line and claims success. For development and for the
 *               test suite, so that neither needs a network or a credential.
 *
 * THE DEFAULT IS smtp, which is what this application did before the Gmail
 * transport existed. An upgrade that silently re-routed a studio's mail through
 * an unconfigured Gmail account would be a studio whose email stopped, so the
 * new path is opt-in by setting the variable.
 *
 * WHAT A TRANSPORT IS: one function, `send(message) -> result`, where result is
 * `{ ok: true, ... }` or `{ ok: false, kind, error }` and `kind` is one of
 * `temporary`, `permanent`, `reauthorise` or `unconfigured`. The queue in
 * src/email-outbox.js reads that word and nothing else, which is what lets a
 * transport be swapped without touching the retry policy.
 */
const gmail = require('./gmail-transport');

const NAMES = ['gmail_api', 'smtp', 'log'];

function chosen() {
  const raw = String(process.env.EMAIL_TRANSPORT || 'smtp').trim().toLowerCase();
  return NAMES.includes(raw) ? raw : 'smtp';
}

/* The log transport. Deliberately prints the recipient and the subject and
 * NEVER the body: a development log is a file somebody pastes into a chat, and
 * a notification body carries a person's name, an asset code and whatever was
 * typed into a feedback box. The subject is enough to know which email fired. */
async function logSend(message) {
  console.log(`[email:log] to=${message.to} subject=${JSON.stringify(String(message.subject || ''))}`
    + ` bytes=${Buffer.byteLength(String(message.text || '') + String(message.html || ''), 'utf8')}`);
  return { ok: true, id: `log-${Date.now()}`, messageId: message.messageId || null };
}

/* The SMTP transport, through the module that already existed.
 *
 * ITS ERRORS ARE CLASSIFIED HERE, because src/mailer.js predates the idea of a
 * classification and returns `{ok:false, error}` with a sentence. Mapped rather
 * than rewritten: that module's three paragraphs about blocked ports are the
 * most useful thing in it and it is still the right answer for a studio that
 * uses SMTP.
 *
 * An authentication failure is `reauthorise`, which is the same shape as a dead
 * Gmail credential and wants the same treatment: it is the connection that is
 * broken, not the message, so it must not spend six attempts per queued email. */
async function smtpSend(db, message) {
  const mailer = require('./mailer');
  const result = await mailer.sendWithSavedConfig(db, message);
  if (result.ok) return { ok: true, id: result.messageId || null };
  if (result.skipped) return { ok: false, kind: 'unconfigured', error: result.error };
  const text = String(result.error || '');
  if (/refused the username and password|EAUTH|authentication/i.test(text)) {
    return { ok: false, kind: 'reauthorise', error: result.error };
  }
  if (/No recipient|not a valid email/i.test(text)) {
    return { ok: false, kind: 'permanent', error: result.error };
  }
  return { ok: false, kind: 'temporary', error: result.error };
}

/* Send one message through whichever transport is configured.
 *
 * `db` is passed through for SMTP alone, which reads its settings from a table.
 * The Gmail transport takes everything from the environment and ignores it. */
async function send(db, message) {
  const name = chosen();
  if (name === 'log') return { ...(await logSend(message)), transport: name };
  if (name === 'gmail_api') return { ...(await gmail.send(message)), transport: name };
  return { ...(await smtpSend(db, message)), transport: name };
}

/* Can this transport send at all, without sending anything?
 *
 * Only the Gmail transport can really answer — a token request proves the
 * credential. SMTP cannot be checked without connecting, and `log` is always
 * fine. Those two answer "assumed", which the Settings screen renders as what it
 * is rather than as a green tick. */
async function checkConnection() {
  const name = chosen();
  if (name === 'log') return { ok: true, state: 'connected', transport: name, assumed: true };
  if (name === 'gmail_api') return { ...(await gmail.checkConnection()), transport: name };
  const emailConfig = require('./email-config');
  const usable = emailConfig.isUsable(emailConfig.current());
  return {
    ok: usable,
    state: usable ? 'connected' : 'not_configured',
    transport: name,
    assumed: true,
  };
}

module.exports = { NAMES, chosen, send, checkConnection };
