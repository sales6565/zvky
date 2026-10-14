/* SENDING THROUGH THE GMAIL API, with an OAuth refresh token.
 *
 * WHY NOT SMTP. This deployment is shared cPanel hosting whose plan blocks
 * outbound mail ports — src/mailer.js carries three paragraphs about it and
 * scripts/check-outbound.js exists to prove it. The Gmail API is HTTPS on 443,
 * which is the one thing such a host always allows.
 *
 * NO NEW DEPENDENCY. googleapis is ~50 MB of generated clients and google-auth-
 * library pulls gtoken, gaxios and jws; all this needs is two POSTs, and Node 22
 * has global fetch. So there is nothing to audit, nothing to keep up to date,
 * and nothing that can break on a Node upgrade — which matters on a host where
 * upgrading means a support ticket. The cost is that the two request shapes are
 * written out here rather than imported; they are eleven lines and they are in
 * Google's documentation.
 *
 * ---------------------------------------------------------------------------
 * THE ACCESS TOKEN IS CACHED, AND CONCURRENT SENDS SHARE ONE REFRESH.
 *
 * An access token lasts an hour. Fetching one per message would be two round
 * trips per email and would hit Google's token endpoint hard on a morning when
 * forty reminders go out at once. So it is held in memory with a 60-second
 * margin, and — this is the part that is easy to get wrong — the refresh is
 * SINGLE-FLIGHT: the in-flight promise is stored, and every caller that arrives
 * while it is pending awaits that same promise. Forty sends starting together
 * produce ONE token request, not forty. A test asserts the count.
 *
 * IN MEMORY AND NOT IN THE DATABASE, deliberately. An access token is valid for
 * an hour and is worth exactly as much as the refresh token that minted it; a
 * table would mean a second place for a credential to leak from and a migration
 * to write, to save one token request per worker per hour.
 *
 * ---------------------------------------------------------------------------
 * THE REFRESH TOKEN IS AN ENVIRONMENT VARIABLE, NOT A DATABASE ROW.
 *
 * The brief allowed either, on condition that a stored one is encrypted at rest.
 * The environment is chosen, and the reason is not convenience: this repository
 * already has one reversibly-stored secret (the SMTP password, encrypted by
 * src/email-secret.js) and that module falls back to JWT_SECRET when
 * EMAIL_ENCRYPTION_KEY is unset — which on this deployment it is, with
 * JWT_SECRET still the shipped placeholder. Storing a Gmail refresh token under
 * that arrangement would be storing a credential that grants send-as rights to
 * the studio's sales mailbox, encrypted with a key published in the repository's
 * own example file. The environment has no such problem, and a refresh token is
 * set once in the lifetime of a deployment.
 */
const emailMessage = require('./email-message');

/* READ AT CALL TIME, NOT AT REQUIRE TIME, and that is not a test convenience.
 *
 * A module-level `process.env` read makes the value depend on REQUIRE ORDER:
 * whichever file pulled this one in first decides what the URL is for the rest
 * of the process. Its own test suite caught it — the fake Google was ignored and
 * the sends went to the real endpoint, because an earlier line in the same file
 * had already required this module. In production the same shape means a
 * variable set after boot is silently ignored.
 *
 * So these are functions. The overhead is a property lookup per send. */
const tokenUrl = () => process.env.GMAIL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const sendUrl = () => process.env.GMAIL_SEND_URL
  || 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/* THE ONE SCOPE. gmail.send and nothing else: it cannot read a mailbox, cannot
   list messages a human sent, cannot delete anything. The consent screen says
   so, which is what makes this safe to ask a studio owner to approve.
   
   `alreadySent` below would want gmail.readonly to search by Message-ID, and
   that is exactly why it does not search: widening the scope to read the sales
   mailbox, to save a rare duplicate notification, is the wrong trade. See the
   note there. */
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/* How long before expiry a cached token is treated as spent. Sixty seconds, so
   a token is never used in the second it dies — the request would fail with a
   401 and burn an attempt for no reason. */
const EXPIRY_MARGIN_MS = 60 * 1000;

const httpTimeoutMs = () => Number(process.env.GMAIL_HTTP_TIMEOUT_MS || 20000);

function settings() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    from: (process.env.GMAIL_SENDER || '').trim(),
    fromName: process.env.GMAIL_SENDER_NAME || '',
    replyTo: (process.env.GMAIL_REPLY_TO || '').trim(),
  };
}

/* WHAT IS MISSING, said in names rather than values.
 *
 * Never the values: this function's output reaches the Settings screen and the
 * log. "GMAIL_CLIENT_SECRET is not set" is actionable; echoing a secret that IS
 * set, to prove it, is how a credential ends up in a screenshot. */
function missing() {
  const s = settings();
  const gaps = [];
  if (!s.clientId) gaps.push('GMAIL_CLIENT_ID');
  if (!s.clientSecret) gaps.push('GMAIL_CLIENT_SECRET');
  if (!s.refreshToken) gaps.push('GMAIL_REFRESH_TOKEN');
  if (!s.from) gaps.push('GMAIL_SENDER');
  else if (!emailMessage.isAddress(s.from)) gaps.push('GMAIL_SENDER (not a valid address)');
  if (s.replyTo && !emailMessage.isAddress(s.replyTo)) gaps.push('GMAIL_REPLY_TO (not a valid address)');
  return gaps;
}

const isConfigured = () => missing().length === 0;

/* --- the access token ------------------------------------------------------- */

let cached = null;        // { token, expiresAt }
let inFlight = null;      // the shared refresh promise
let refreshCount = 0;     // for the tests, and for nothing else

/* MASKED, for a log line that proves which credential was used without being
   the credential. First four characters and a length: enough to tell a stale
   refresh token from a mistyped one, useless to anybody who reads it. */
function mask(value) {
  const text = String(value || '');
  if (!text) return '(unset)';
  return `${text.slice(0, 4)}…(${text.length} chars)`;
}

async function post(url, body, { headers = {}, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs());
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: signal || controller.signal,
    });
  } finally { clearTimeout(timer); }
}

/* Exchange the refresh token for an access token.
 *
 * Form-encoded, which is what the token endpoint wants — it is the one Google
 * endpoint that does not take JSON. */
async function fetchToken() {
  const s = settings();
  const form = new URLSearchParams({
    client_id: s.clientId,
    client_secret: s.clientSecret,
    refresh_token: s.refreshToken,
    grant_type: 'refresh_token',
  });
  refreshCount += 1;
  let res;
  try {
    res = await post(tokenUrl(), form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (err) {
    /* A network failure is temporary and says nothing about the credential. */
    const wrapped = new Error(`The Google token endpoint could not be reached: ${err.message}`);
    wrapped.temporary = true;
    throw wrapped;
  }

  let payload = {};
  try { payload = await res.json(); } catch { payload = {}; }

  if (!res.ok) {
    const code = String(payload.error || `http_${res.status}`);
    /* invalid_grant IS THE ONE THAT MATTERS. A revoked token, a withdrawn
       consent, a password change, or — on a free Gmail account — an External app
       still in Testing, whose refresh tokens expire after seven days. None of
       them is a message's fault and none is fixed by retrying, so this is a
       CONNECTION failure: it must not consume the queue's attempts. */
    const broken = code === 'invalid_grant' || code === 'unauthorized_client'
      || code === 'invalid_client' || res.status === 400 || res.status === 401;
    const err = new Error(`Google refused the refresh token (${code}). `
      + `The Gmail connection needs to be re-authorised — run node scripts/gmail-authorize.js. `
      + `[client_id ${mask(s.clientId)}, refresh_token ${mask(s.refreshToken)}]`);
    err.reauthorise = broken;
    err.temporary = !broken;
    err.code = code;
    err.status = res.status;
    throw err;
  }

  const ttl = Number(payload.expires_in || 3600) * 1000;
  return { token: payload.access_token, expiresAt: Date.now() + ttl };
}

/* The cached token, or one refresh shared by everybody who asks while it runs. */
async function accessToken() {
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      cached = await fetchToken();
      return cached.token;
    } finally {
      /* Cleared in a finally so a FAILED refresh does not wedge every later
         caller on a rejected promise — the next send tries again. */
      inFlight = null;
    }
  })();
  return inFlight;
}

/* Thrown away on a 401 after a successful refresh, which means the token we hold
   is no longer accepted whatever its expiry says. */
function forgetToken() { cached = null; }

/* --- classifying what Google said ------------------------------------------ */

/* THE THREE OUTCOMES THE QUEUE UNDERSTANDS, and the whole point of this
 * function is that each one feeds the retry counter differently:
 *
 *   temporary     network, 5xx, 429 — retry on the existing backoff
 *   permanent     this message is wrong (bad address, malformed) — fail it now
 *                 rather than spending six attempts an hour apart on it
 *   reauthorise   the CONNECTION is broken — do not blame the message, do not
 *                 consume an attempt, pause the queue and tell a Super Admin
 */
function classify(status, payload, headers) {
  const reason = ((payload && payload.error && payload.error.errors
    && payload.error.errors[0] && payload.error.errors[0].reason) || '').toLowerCase();
  const message = (payload && payload.error && payload.error.message) || `HTTP ${status}`;
  const retryAfter = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;

  if (status === 401) return { kind: 'reauthorise', message, retryAfter: null };
  if (status === 403 && /^(ratelimitexceeded|userratelimitexceeded|quotaexceeded|dailylimitexceeded)$/.test(reason)) {
    return { kind: 'temporary', message, retryAfter };
  }
  /* 403 for any OTHER reason is the API or the scope being wrong, which retrying
     cannot fix and which is not this message's fault either — it is the
     connection's. forbidden/insufficientPermissions is what a missing
     gmail.send scope looks like. */
  if (status === 403) return { kind: 'reauthorise', message, retryAfter: null };
  if (status === 429) return { kind: 'temporary', message, retryAfter };
  if (status >= 500) return { kind: 'temporary', message, retryAfter };
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { kind: 'permanent', message, retryAfter: null };
  }
  return { kind: 'temporary', message, retryAfter };
}

/* --- sending --------------------------------------------------------------- */

/* DID A SEND WHOSE RESPONSE WE LOST ACTUALLY ARRIVE?
 *
 * The honest answer is that this transport cannot know, and the README says so:
 * delivery is AT LEAST ONCE. A send that succeeds at Google and whose response
 * is lost on the way back will be retried, and the recipient gets two copies of
 * a notification.
 *
 * WHAT WOULD FIX IT, AND WHY IT IS NOT DONE: searching the mailbox for our own
 * Message-ID before retrying. That needs gmail.readonly — read access to a live
 * sales mailbox — added to the consent screen, for the sole purpose of
 * suppressing a duplicate "you have been assigned FX-014". The studio would be
 * granting this application the right to read its customer correspondence to
 * save a rare double notification. That is the wrong trade, and it is recorded
 * here rather than quietly skipped.
 *
 * WHAT IS DONE INSTEAD, because it is free: the id Gmail returns is stored on
 * the outbox row, so a duplicate is identifiable after the fact, and the queue
 * treats a TIMEOUT differently from a refusal — see the note on `timedOut` in
 * src/email-outbox.js.
 */
async function send(message) {
  const gaps = missing();
  if (gaps.length) {
    return { ok: false, kind: 'unconfigured',
      error: `Gmail sending is not configured: ${gaps.join(', ')} not set.` };
  }
  const s = settings();

  let built;
  try {
    built = emailMessage.build({
      from: s.from,
      fromName: s.fromName,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      /* The message's own Reply-To wins over the configured one, so a future
         caller can answer a thread; neither is required. */
      replyTo: message.replyTo || s.replyTo || null,
      inReplyTo: message.messageId || null,
    });
  } catch (err) {
    /* A message this transport cannot build is permanently wrong. This is where
       header injection and a bad recipient land. */
    return { ok: false, kind: 'permanent', error: err.message, field: err.field };
  }

  let token;
  try {
    token = await accessToken();
  } catch (err) {
    return {
      ok: false,
      kind: err.reauthorise ? 'reauthorise' : 'temporary',
      error: err.message,
      code: err.code,
    };
  }

  const attempt = async (bearer) => {
    let res;
    try {
      res = await post(sendUrl(), { raw: emailMessage.toBase64Url(built.raw) },
        { headers: { Authorization: `Bearer ${bearer}` } });
    } catch (err) {
      /* ABORTED OR DROPPED. Temporary, and flagged as a timeout so the queue
         knows this is the case where a duplicate is possible. */
      return { ok: false, kind: 'temporary', timedOut: true,
        error: `The Gmail API did not answer: ${err.message}` };
    }
    let payload = {};
    try { payload = await res.json(); } catch { payload = {}; }
    if (res.ok) {
      return { ok: true, id: payload.id || null, threadId: payload.threadId || null,
        messageId: built.messageId, bytes: built.bytes };
    }
    const verdict = classify(res.status, payload, res.headers);
    return { ok: false, status: res.status, ...verdict, error: verdict.message };
  };

  let result = await attempt(token);

  /* ONE RETRY AFTER A 401, and exactly one. A token can expire between the
     margin check and the request; refreshing once and trying again is the
     ordinary case and must not cost the message an attempt. If the second one is
     also 401 then the credential itself is rejected, which is a connection
     failure and is reported as one. */
  if (!result.ok && result.kind === 'reauthorise' && result.status === 401) {
    forgetToken();
    try {
      const fresh = await accessToken();
      result = await attempt(fresh);
      if (!result.ok && result.status === 401) {
        result.kind = 'reauthorise';
        result.error = 'Google rejected the access token twice, after a successful refresh. '
          + 'The Gmail connection needs to be re-authorised.';
      }
    } catch (err) {
      return { ok: false, kind: err.reauthorise ? 'reauthorise' : 'temporary', error: err.message };
    }
  }

  return result;
}

/* Is the connection usable at all? Asked by the Settings screen, which wants to
   say "connected" or "needs re-authorisation" without sending anything. A token
   request is the cheapest honest answer: it proves the credential, and it does
   not touch the mailbox. */
async function checkConnection() {
  const gaps = missing();
  if (gaps.length) return { ok: false, state: 'not_configured', missing: gaps };
  try {
    await accessToken();
    return { ok: true, state: 'connected' };
  } catch (err) {
    return {
      ok: false,
      state: err.reauthorise ? 'needs_reauthorisation' : 'unreachable',
      error: err.message,
    };
  }
}

/* For the tests only: the number of token requests made, and a way to start
   from nothing. Exported rather than reached into, so the test does not depend
   on the shape of the cache. */
const _stats = () => ({ refreshCount, cached: Boolean(cached), inFlight: Boolean(inFlight) });
function _reset() { cached = null; inFlight = null; refreshCount = 0; }

module.exports = {
  send, checkConnection, accessToken, forgetToken, classify, missing, isConfigured,
  settings, mask, SCOPE, tokenUrl, sendUrl, EXPIRY_MARGIN_MS, _stats, _reset,
};
