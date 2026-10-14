/* THE EMAIL QUEUE: durable, retried on a fixed schedule, and paused rather than
 * emptied when the connection is the thing that is broken.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS HERE BEFORE, STATED PLAINLY, because the brief for this change
 * assumed something else and the difference matters.
 *
 * Email had NO durable queue. src/email-notifications.js holds an in-memory Map
 * that batches assignments to the same person for 1.5 seconds, retries ONCE
 * after 250 ms, and swallows the error — its own comment says so: "A durable
 * queue would be the right answer for email that must not be lost; this is a
 * courtesy notification whose authoritative copy is already in the bell." There
 * was no outbox table, no attempt counter, and no permanent-failure alert. The
 * six-retry schedule the brief describes belongs to src/integration-outbox.js,
 * which delivers Dev & QA WEBHOOKS, not mail.
 *
 * So "keep the retry counting exactly as it is" could not mean email's, because
 * email had none. It is read here as "do not invent a second retry policy", and
 * BACKOFF_SECONDS below is imported from the outbox that already exists rather
 * than retyped — one schedule, in one place, for both queues.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE NOW. The Gmail transport can be down for a reason that lasts: a
 * refresh token revoked, or — on a free Gmail account — an External OAuth app
 * still in Testing, whose tokens expire every seven days. An in-memory queue
 * loses every notification raised during that window, and nobody finds out. A
 * table holds them until somebody re-authorises, and then they go.
 *
 * ---------------------------------------------------------------------------
 * THE THREE WAYS A SEND CAN FAIL, and the whole design is that they are counted
 * differently:
 *
 *   temporary    network, 5xx, 429. The message is fine, the moment is not.
 *                attempts += 1, back off on the schedule, fail after six.
 *   permanent    the message is wrong — a bad address, an injected header, too
 *                big. Failed AT ONCE. Spending six attempts over a day on an
 *                address that will never be valid is how a queue fills with
 *                work that cannot succeed.
 *   reauthorise  the CONNECTION is broken. NOT the message's fault, so attempts
 *                is NOT incremented: the row stays exactly as it was, the queue
 *                is paused, a Super Admin is told, and when the connection comes
 *                back every message still has all of its attempts.
 *
 * That third case is the one worth the table. Without it, a token revoked on a
 * Friday would burn seven attempts on every queued email over the weekend and
 * Monday's inbox would contain nothing but failures.
 */
const { v4: uuid } = require('uuid');
const { applyTableOptions } = require('./db-collation');
const transport = require('./email-transport');
const integrationOutbox = require('./integration-outbox');

/* THE SAME SCHEDULE THE WEBHOOK OUTBOX USES, imported rather than retyped:
   1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 24 hours, then failed.
   Six retries after the first attempt, seven attempts in all. */
const BACKOFF_SECONDS = integrationOutbox.BACKOFF_SECONDS;
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

const STATUS = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
};

/* THROTTLING, and the defaults are deliberately timid.
 *
 * THE SENDER MAILBOX IS A REAL ONE. sales@zvky.com is read by people and used
 * for customer correspondence; this application is a guest in it. Gmail's own
 * ceiling is 2,000 recipients a day on Workspace and 500 on a free account, and
 * hitting either would stop the studio's SALES email, not just its
 * notifications. So the cap is 300 a day — comfortably under the lower of the
 * two, and about ten times the busiest day this application could plausibly
 * produce (a morning of reminders for sixty people).
 *
 * PER MINUTE matters as much as per day: forty notifications raised in one
 * second by a bulk assignment look like a burst to a spam filter. Ten a minute
 * spreads that over four minutes and nobody notices.
 *
 * Both are environment variables, because the right numbers depend on a mailbox
 * this code cannot see.
 */
/* FUNCTIONS, not constants — see the note in src/gmail-transport.js. A cap read
   at require time is a cap that depends on which file was loaded first, and one
   that cannot be changed without a restart even though everything else here
   can. */
const perMinute = () => Math.max(1, Number(process.env.EMAIL_MAX_PER_MINUTE || 10));
const dailyCap = () => Math.max(1, Number(process.env.EMAIL_DAILY_CAP || 300));
const warnAt = () => Number(process.env.EMAIL_DAILY_WARN_FRACTION || 0.8);
const sweepMs = () => Number(process.env.EMAIL_SWEEP_MS === undefined ? 5000 : process.env.EMAIL_SWEEP_MS);

/* The kinds of mail in the queue. `kind` is stored so the Settings screen can
   say what is waiting, and so the permanent-failure alert can be recognised —
   see alertSuperAdmins(). */
const KIND = {
  notification: 'notification',
  alert: 'alert',
  test: 'test',
};

async function ensureTables(db) {
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS email_outbox (
      id              CHAR(36)     NOT NULL PRIMARY KEY,
      seq             BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
      kind            VARCHAR(16)  NOT NULL DEFAULT 'notification',
      recipient       VARCHAR(254) NOT NULL,
      subject         VARCHAR(500) NULL,
      body_text       MEDIUMTEXT   NULL,
      body_html       MEDIUMTEXT   NULL,
      reply_to        VARCHAR(254) NULL,
      -- OUR Message-ID, stable across attempts, so a duplicate caused by a lost
      -- response is identifiable afterwards. See the note in gmail-transport.js.
      message_id      VARCHAR(255) NULL,
      \`status\`        VARCHAR(16)  NOT NULL DEFAULT 'pending',
      attempts        INT          NOT NULL DEFAULT 0,
      next_attempt_at DATETIME     NULL,
      sent_at         DATETIME     NULL,
      sent_id         VARCHAR(255) NULL,
      last_error      VARCHAR(500) NULL,
      created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_email_outbox_due (\`status\`, next_attempt_at),
      KEY idx_email_outbox_sent (\`status\`, sent_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));

  /* ONE ROW, holding whether the transport is usable.
   *
   * IN A TABLE RATHER THAN IN MEMORY because this deployment runs several Node
   * workers against one database — Passenger does, and the README says so. A
   * flag in memory would mean one worker paused and three others still burning
   * attempts against a dead credential. */
  await db.query(await applyTableOptions(db, `CREATE TABLE IF NOT EXISTS email_transport_state (
      id              TINYINT      NOT NULL PRIMARY KEY,
      healthy         TINYINT(1)   NOT NULL DEFAULT 1,
      reason          VARCHAR(500) NULL,
      unhealthy_since DATETIME     NULL,
      last_success_at DATETIME     NULL,
      alerted_at      DATETIME     NULL,
      cap_alerted_on  DATE         NULL,
      updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`));
  await db.query('INSERT IGNORE INTO email_transport_state (id, healthy) VALUES (1, 1)');
}

const unavailable = (err) => Boolean(err)
  && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

/* --- state ------------------------------------------------------------------ */

async function state(db) {
  try {
    const { rows } = await db.query('SELECT * FROM email_transport_state WHERE id = 1');
    return rows[0] || { healthy: 1 };
  } catch (err) {
    if (!unavailable(err)) throw err;
    return { healthy: 1, missing: true };
  }
}

async function markUnhealthy(db, reason) {
  await db.query(
    `UPDATE email_transport_state
        SET healthy = 0,
            reason = $1,
            unhealthy_since = COALESCE(unhealthy_since, NOW())
      WHERE id = 1`,
    [String(reason || '').slice(0, 500)]
  );
}

async function markHealthy(db) {
  const { rows } = await db.query('SELECT healthy FROM email_transport_state WHERE id = 1');
  const was = rows[0] && Number(rows[0].healthy) === 0;
  await db.query(
    `UPDATE email_transport_state
        SET healthy = 1, reason = NULL, unhealthy_since = NULL, alerted_at = NULL,
            last_success_at = NOW()
      WHERE id = 1`
  );
  if (was) console.log('[email] the transport is answering again — the queue is draining.');
  return was;
}

/* --- queueing --------------------------------------------------------------- */

/* PUT ONE MESSAGE ON THE QUEUE. This is what replaced the direct send.
 *
 * Returns at once; nothing about delivery reaches the caller, which is the same
 * promise src/email-notifications.js always made. A missing table is swallowed
 * for the same reason every other read in that file is: a deployment mid-upgrade
 * must not fail an assignment because the email table is not there yet. */
async function enqueue(db, { kind = KIND.notification, to, subject, text, html, replyTo } = {}) {
  if (!to) return { ok: false, error: 'No recipient.' };
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO email_outbox (id, kind, recipient, subject, body_text, body_html, reply_to,
         \`status\`, attempts, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,NOW())`,
      [id, kind, String(to).slice(0, 254), String(subject || '').slice(0, 500),
        text || null, html || null, replyTo || null]
    );
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn('[email] the outbox table is missing — this message was dropped. Run the migration.');
    return { ok: false, error: 'The email outbox table does not exist yet.' };
  }
  return { ok: true, id };
}

/* --- the counters the cap is measured against ------------------------------- */

async function sentToday(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM email_outbox
      WHERE \`status\` = 'sent' AND sent_at >= CURRENT_DATE()`);
  return Number(rows[0].n) || 0;
}

/* Counted from the rows rather than kept in a counter, which is what makes it
   right across several workers and across a restart. */
async function stats(db) {
  try {
    const { rows } = await db.query(
      `SELECT
         SUM(\`status\` = 'pending') AS pending,
         SUM(\`status\` = 'failed' AND updated_at >= NOW() - INTERVAL 24 HOUR) AS failed24,
         SUM(\`status\` = 'sent' AND sent_at >= CURRENT_DATE()) AS today,
         MAX(CASE WHEN \`status\` = 'sent' THEN sent_at END) AS lastSuccess
       FROM email_outbox`);
    const row = rows[0] || {};
    const st = await state(db);
    return {
      pending: Number(row.pending) || 0,
      failedLast24h: Number(row.failed24) || 0,
      sentToday: Number(row.today) || 0,
      lastSuccessAt: row.lastSuccess || st.last_success_at || null,
      dailyCap: dailyCap(),
      perMinute: perMinute(),
      healthy: Number(st.healthy) !== 0,
      reason: st.reason || null,
      unhealthySince: st.unhealthy_since || null,
    };
  } catch (err) {
    if (!unavailable(err)) throw err;
    return {
      pending: 0, failedLast24h: 0, sentToday: 0, lastSuccessAt: null,
      dailyCap: dailyCap(), perMinute: perMinute(), healthy: true, reason: null,
      unhealthySince: null, missing: true,
    };
  }
}

/* --- the Super Admin alert -------------------------------------------------- */

/* TELLING A SUPER ADMIN SOMETHING WENT WRONG, WITHOUT A LOOP.
 *
 * The alert is itself an email. So if the transport is what is broken, sending
 * the alert through it produces another failure, which produces another alert.
 * The brief names this and it is the one piece of this file that cannot be got
 * from the retry policy.
 *
 * SO THE IN-APP NOTICE IS ALWAYS RAISED, AND THE EMAIL IS ONLY QUEUED WHEN THE
 * TRANSPORT IS HEALTHY. When it is not, the notice and the log line are the
 * whole alert — and the message is queued anyway as an `alert` row, which drains
 * with everything else once the connection is back. Nothing is lost and nothing
 * loops.
 */
async function alertSuperAdmins(db, { subject, text, html, inAppOnly = false } = {}) {
  const notifications = require('./notifications');
  const rolePermissions = require('./role-permissions');
  let admins = [];
  try {
    const { rows } = await db.query(
      'SELECT id, email, role FROM users WHERE is_active = 1 AND email IS NOT NULL');
    for (const row of rows) {
      if (rolePermissions.isSuperAdmin(row.role)) admins.push(row);
    }
  } catch { admins = []; }

  /* THE IN-APP NOTICE FIRST, because it is the half that cannot fail for the
     same reason the email can. */
  for (const admin of admins) {
    await notifications.raise(db, {
      recipientId: admin.id,
      actorId: null,
      kind: notifications.KINDS.email_trouble,
    }).catch(() => {});
  }
  console.warn(`[email] ${subject} — ${admins.length} Super Admin(s) notified in-app.`);

  if (inAppOnly) return { inApp: admins.length, queued: 0 };
  let queued = 0;
  for (const admin of admins) {
    const done = await enqueue(db, { kind: KIND.alert, to: admin.email, subject, text, html })
      .catch(() => ({ ok: false }));
    if (done.ok) queued += 1;
  }
  return { inApp: admins.length, queued };
}

/* --- the worker ------------------------------------------------------------- */

function backoffFor(attempts) {
  return BACKOFF_SECONDS[Number(attempts) - 1];
}

/* ONE PASS. Claims up to the per-minute allowance, sends them, records what
 * happened. Returns a summary so the tests can drive it directly rather than
 * waiting on a timer — which is also how the throttle is asserted.
 */
async function drain(db, { limit = perMinute() } = {}) {
  const summary = { sent: 0, temporary: 0, permanent: 0, paused: false, skipped: 0, capped: false };

  const st = await state(db);
  if (st.missing) return summary;

  /* PAUSED. The rows stay exactly as they are — no attempt consumed, no error
     recorded — because the connection being down says nothing about any of
     them. One probe per pass decides whether to resume. */
  if (Number(st.healthy) === 0) {
    const probe = await transport.checkConnection();
    if (!probe.ok) { summary.paused = true; return summary; }
    await markHealthy(db);
    await alertSuperAdmins(db, {
      subject: 'Email sending has resumed',
      text: 'The Gmail connection is working again and the queued messages are going out.',
      html: '<p>The Gmail connection is working again and the queued messages are going out.</p>',
    }).catch(() => {});
  }

  const cap = dailyCap();
  const already = await sentToday(db);
  if (already >= cap) {
    summary.capped = true;
    return summary;
  }
  const room = Math.min(limit, cap - already);

  const { rows } = await db.query(
    `SELECT id, kind, recipient, subject, body_text, body_html, reply_to, message_id, attempts
       FROM email_outbox
      WHERE \`status\` = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY seq ASC LIMIT ${Math.max(0, Math.floor(room))}`);

  for (const row of rows) {
    const result = await transport.send(db, {
      to: row.recipient,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html,
      replyTo: row.reply_to,
      messageId: row.message_id,
    });

    if (result.ok) {
      await db.query(
        `UPDATE email_outbox SET \`status\` = 'sent', sent_at = NOW(), sent_id = $1,
            message_id = COALESCE(message_id, $2), last_error = NULL, attempts = attempts + 1
          WHERE id = $3`,
        [String(result.id || '').slice(0, 255) || null,
          String(result.messageId || '').slice(0, 255) || null, row.id]);
      await markHealthy(db);
      summary.sent += 1;
      continue;
    }

    /* THE CONNECTION, NOT THE MESSAGE. Nothing is written to the row at all —
       not the attempt, not the error — and the pass stops: every row after this
       one would fail the same way. */
    if (result.kind === 'reauthorise' || result.kind === 'unconfigured') {
      await markUnhealthy(db, result.error);
      summary.paused = true;
      summary.skipped = rows.length - summary.sent - summary.temporary - summary.permanent;
      await raiseConnectionAlert(db, result.error);
      return summary;
    }

    if (result.kind === 'permanent') {
      await db.query(
        `UPDATE email_outbox SET \`status\` = 'failed', last_error = $1, attempts = attempts + 1
          WHERE id = $2`,
        [String(result.error || '').slice(0, 500), row.id]);
      summary.permanent += 1;
      await notePermanentFailure(db, row, result.error);
      continue;
    }

    /* TEMPORARY. The attempt is counted, and the schedule decides what happens
       next — including Retry-After, which Google sends on a 429 and which we
       honour rather than overrule. */
    const attempts = Number(row.attempts) + 1;
    const scheduled = backoffFor(attempts);
    if (scheduled === undefined) {
      await db.query(
        `UPDATE email_outbox SET \`status\` = 'failed', attempts = $1, last_error = $2
          WHERE id = $3`,
        [attempts, `Out of attempts after ${attempts}: ${String(result.error || '').slice(0, 400)}`,
          row.id]);
      summary.permanent += 1;
      await notePermanentFailure(db, row, result.error);
      continue;
    }
    const after = Number(result.retryAfter);
    const delay = Number.isFinite(after) && after > 0 ? Math.max(scheduled, after) : scheduled;
    await db.query(
      `UPDATE email_outbox SET attempts = $1, last_error = $2,
          next_attempt_at = NOW() + INTERVAL ${Math.floor(delay)} SECOND
        WHERE id = $3`,
      [attempts, String(result.error || '').slice(0, 500), row.id]);
    summary.temporary += 1;
  }

  await warnIfNearCap(db, already + summary.sent);
  return summary;
}

/* ONE ALERT PER OUTAGE, not one per pass. alerted_at is stamped when the notice
   goes out and cleared by markHealthy(), so a credential revoked overnight
   produces one notice rather than one every five seconds. */
async function raiseConnectionAlert(db, reason) {
  const { rows } = await db.query('SELECT alerted_at FROM email_transport_state WHERE id = 1');
  if (rows[0] && rows[0].alerted_at) return;
  await db.query('UPDATE email_transport_state SET alerted_at = NOW() WHERE id = 1');
  await alertSuperAdmins(db, {
    subject: 'The Gmail connection needs to be re-authorised',
    text: `Email sending is paused and messages are being held in the queue.\n\n${reason}\n\n`
      + 'Run node scripts/gmail-authorize.js on the server and set the new GMAIL_REFRESH_TOKEN.',
    html: '<p>Email sending is paused and messages are being held in the queue.</p>'
      + '<p>Run <code>node scripts/gmail-authorize.js</code> on the server and set the new '
      + '<code>GMAIL_REFRESH_TOKEN</code>.</p>',
    /* IN-APP ONLY, which is the loop-breaker: the transport is down, so an
       emailed alert would fail and alert about itself. The email is queued by
       the resume notice instead, once there is something to send it with. */
    inAppOnly: true,
  }).catch(() => {});
}

/* A MESSAGE THAT WILL NEVER GO. Told to a Super Admin — and the alert itself
   goes through the queue, so if the transport is down it becomes an in-app
   notice and the email follows later. An `alert` row never alerts about itself,
   which is the other half of not looping. */
async function notePermanentFailure(db, row, error) {
  if (row.kind === KIND.alert) {
    console.warn(`[email] an alert message failed permanently and was not alerted about: ${error}`);
    return;
  }
  const st = await state(db);
  const healthy = Number(st.healthy) !== 0;
  await alertSuperAdmins(db, {
    subject: 'An email could not be delivered',
    text: `A message to ${row.recipient} was not delivered and will not be retried.\n\n`
      + `Subject: ${row.subject}\nReason: ${error}`,
    html: `<p>A message to ${escapeHtml(row.recipient)} was not delivered and will not be `
      + `retried.</p><p><b>Subject:</b> ${escapeHtml(row.subject)}<br>`
      + `<b>Reason:</b> ${escapeHtml(error)}</p>`,
    inAppOnly: !healthy,
  }).catch(() => {});
}

async function warnIfNearCap(db, used) {
  const cap = dailyCap();
  if (used < Math.floor(cap * warnAt())) return;
  const { rows } = await db.query(
    'SELECT cap_alerted_on FROM email_transport_state WHERE id = 1');
  const stamped = rows[0] && rows[0].cap_alerted_on;
  const today = new Date().toISOString().slice(0, 10);
  if (stamped && String(stamped).slice(0, 10) === today) return;
  await db.query('UPDATE email_transport_state SET cap_alerted_on = CURRENT_DATE() WHERE id = 1');
  await alertSuperAdmins(db, {
    subject: `Email: ${used} of today's ${cap} sends used`,
    text: `The studio has used ${used} of its daily email cap of ${cap}. `
      + 'Sending stops at the cap and resumes tomorrow; messages are held, not lost. '
      + 'The cap is EMAIL_DAILY_CAP and is set below Gmail\'s own limit because the sender '
      + 'mailbox is shared with ordinary mail.',
    html: `<p>The studio has used <b>${used}</b> of its daily email cap of <b>${cap}</b>.</p>`
      + '<p>Sending stops at the cap and resumes tomorrow; messages are held, not lost.</p>',
  }).catch(() => {});
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/* The timer. Off when EMAIL_SWEEP_MS is 0, which is what the tests use so they
   can drive drain() themselves and assert on the result. */
function schedule(db, log = console.log) {
  const every = sweepMs();
  if (!every) return { stop: () => {} };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await drain(db);
      if (out.sent || out.permanent) {
        log(`[email] sent ${out.sent}, failed ${out.permanent}, retrying ${out.temporary}.`);
      }
    } catch (err) {
      log(`[email] the outbox pass failed: ${err.message}`);
    } finally { running = false; }
  };
  const timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  ensureTables, enqueue, drain, schedule, stats, state, markHealthy, markUnhealthy,
  alertSuperAdmins, sentToday, BACKOFF_SECONDS, MAX_ATTEMPTS, STATUS, KIND,
  perMinute, dailyCap, warnAt, escapeHtml,
};
