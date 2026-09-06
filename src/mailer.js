// Actually putting a message on the wire.
//
// A thin layer over nodemailer that exists for three reasons, none of them
// about SMTP:
//
//   1. SENDING MUST NEVER FAIL THE THING THAT CAUSED IT. An assignment that is
//      refused because a mail server is down is a far worse bug than an email
//      that does not arrive. Every path out of this module either resolves with
//      {ok:false} or is called from a place that ignores it; nothing here
//      throws into a request.
//
//   2. A FAILURE HAS TO MEAN SOMETHING TO WHOEVER READS IT. nodemailer reports
//      "ECONNREFUSED" or "ETIMEDOUT" and an administrator on shared hosting has
//      no way to turn that into an action. The likeliest cause by a distance is
//      that the host blocks outbound SMTP ports entirely — see
//      scripts/check-outbound.js, which exists because this deployment's plan
//      has that restriction — so the message says so.
//
//   3. THE TEST BUTTON HAS TO WORK ON UNSAVED VALUES. Somebody typing settings
//      in for the first time needs to know they are right BEFORE committing
//      them, so a transport can be built from a form as easily as from the row.

const nodemailer = require('nodemailer');
const emailConfig = require('./email-config');

/* How each of the three choices is spoken to a server.
 *
 * `secure` is nodemailer's word for "TLS from the first byte" — port 465. The
 * commoner setup is a plain connection upgraded by STARTTLS, which is
 * secure:false with requireTLS:true. Those two being both "TLS" in ordinary
 * speech is exactly why the form asks in words rather than in booleans.
 *
 * requireTLS matters: without it nodemailer will happily continue unencrypted
 * if the server does not offer STARTTLS, which would put the studio's mail
 * password on the wire in the clear having been asked for TLS. */
function transportOptions({ host, port, encryption, username, password }) {
  const base = {
    host,
    port: Number(port),
    // Nothing here is worth hanging a request on. Ten seconds is already
    // generous for a mail server that is going to answer at all.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
  if (encryption === 'ssl') base.secure = true;
  else if (encryption === 'tls') { base.secure = false; base.requireTLS = true; }
  else { base.secure = false; base.ignoreTLS = true; }

  if (username) base.auth = { user: username, pass: password || '' };
  return base;
}

/* The From header. A name is optional; an address is not.
 *
 * Quoted so a name containing a comma — "Studio, ZVKY" — does not read as two
 * recipients to a strict parser. */
function fromHeader({ fromName, fromAddress }) {
  if (!fromAddress) return null;
  return fromName ? `"${String(fromName).replace(/"/g, '')}" <${fromAddress}>` : fromAddress;
}

/* nodemailer's error, in a sentence somebody can act on.
 *
 * Each of these maps a failure to the thing that is actually wrong, because the
 * raw code sends people to the wrong place: ECONNREFUSED reads as "the mail
 * server is down" when on shared hosting it nearly always means the port is
 * blocked at this end. The original message is kept on the end regardless —
 * a guess that hides the evidence is worse than no guess. */
function explain(err, { host, port } = {}) {
  const code = err && (err.code || err.errno);
  const raw = (err && err.message) || String(err);
  const where = host ? `${host}:${port}` : 'the mail server';

  if (code === 'EAUTH' || /invalid login|authentication fail|535/i.test(raw)) {
    return `${where} refused the username and password. Check both — and if the account has `
      + `two-factor authentication, it will need an app-specific password rather than the normal one. (${raw})`;
  }
  if (code === 'ECONNREFUSED') {
    return `Nothing accepted a connection on ${where}. Either the port is wrong, or this host blocks `
      + `outbound mail on it — shared hosting commonly allows only 80 and 443. Run `
      + `\`node scripts/check-outbound.js ${host || 'smtp.example.com'} ${port || 587}\` on the server to tell those apart. (${raw})`;
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timeout/i.test(raw)) {
    return `${where} did not answer in time. On shared hosting that usually means outbound SMTP is `
      + `blocked rather than that the server is slow — a blocked port hangs rather than refusing. Run `
      + `\`node scripts/check-outbound.js ${host || 'smtp.example.com'} ${port || 587}\` on the server to confirm. (${raw})`;
  }
  if (code === 'EDNS' || code === 'ENOTFOUND') {
    return `The name ${host || '(blank)'} could not be looked up. Check it for a typo. (${raw})`;
  }
  if (/wrong version number|SSL routines|EPROTO/i.test(raw)) {
    return `${where} answered, but not in the encryption this is set to. A server on 465 usually wants `
      + `SSL/TLS and one on 587 usually wants STARTTLS — try the other one. (${raw})`;
  }
  if (/self.signed|unable to verify|certificate/i.test(raw)) {
    return `${where} presented a certificate this server would not accept. (${raw})`;
  }
  return raw;
}

/* Send one message.
 *
 * `config` may be a saved row or a half-typed form; this does not care which,
 * which is what lets the Test button check values before they are committed.
 * Resolves — never rejects. */
async function send(config, message) {
  const from = fromHeader(config);
  if (!config.host) return { ok: false, error: 'No mail server is configured.' };
  if (!from) return { ok: false, error: 'No From address is configured.' };
  if (!message || !message.to) return { ok: false, error: 'No recipient.' };

  let transport;
  try {
    transport = nodemailer.createTransport(transportOptions(config));
  } catch (err) {
    return { ok: false, error: explain(err, config) };
  }

  try {
    const info = await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { ok: true, messageId: info && info.messageId, accepted: (info && info.accepted) || [] };
  } catch (err) {
    return { ok: false, error: explain(err, config), code: err && err.code };
  } finally {
    // Pooling is off, so this only frees the socket — but leaving sockets to
    // the garbage collector on a long-lived server is how a process runs out of
    // file descriptors three months in.
    try { transport.close(); } catch { /* already gone */ }
  }
}

/* Send using whatever is saved, decrypting the password on the way.
 *
 * The single entry point for everything that is not the Test button, and the
 * only place the stored credential is ever in memory. */
async function sendWithSavedConfig(db, message) {
  const config = emailConfig.current();
  if (!emailConfig.isUsable(config)) {
    return { ok: false, error: 'Email is not switched on, or is not fully configured.', skipped: true };
  }
  const password = await emailConfig.transportPassword(db);
  if (!password.ok) return { ok: false, error: password.error };

  const result = await send({ ...config, password: password.value }, message);
  await emailConfig.noteResult(db, result);
  return result;
}

module.exports = { send, sendWithSavedConfig, transportOptions, fromHeader, explain };
