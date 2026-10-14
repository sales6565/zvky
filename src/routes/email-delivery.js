const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const emailOutbox = require('../email-outbox');
const transport = require('../email-transport');
const gmail = require('../gmail-transport');
const branding = require('../branding');
const db = require('../db');

const router = asyncRouter();

/* IS THE STUDIO'S EMAIL GOING OUT, and a button to find out for certain.
 *
 * GATED ON settings.email_delivery, with requirePermission and not on a tier —
 * see the catalogue entry for why it is its own key rather than part of
 * settings.email_config.
 *
 * NOTHING HERE RETURNS A SECRET. Not the client secret, not the refresh token,
 * not the SMTP password, not a bearer token, and not a message body. What a
 * missing credential produces is its VARIABLE NAME: "GMAIL_REFRESH_TOKEN is not
 * set" is what somebody needs; the value would be a credential in a JSON
 * response, which is a credential in a browser's network tab and in whatever
 * logs it. A test asserts that the response matches no secret this server holds.
 */
router.use(authenticate);
router.use(requirePermission('settings.email_delivery'));

// GET /api/email-delivery — the whole status panel, in one call.
router.get('/', async (req, res) => {
  const stats = await emailOutbox.stats(db);
  const connection = await transport.checkConnection();
  const chosen = transport.chosen();
  const settings = chosen === 'gmail_api' ? gmail.settings() : null;

  res.json({
    transport: chosen,
    /* MASTER ENABLE. The existing email_config.enabled row, which already gates
       every notification — read, not re-invented: a second switch would be a
       second thing to forget. */
    enabled: require('../email-config').current().enabled === true,
    sender: settings
      /* READ-ONLY, FROM CONFIGURATION, as the brief asks. An address editable
         here would be a lie: Gmail rewrites any From that is not the
         authenticated mailbox, so the only honest value is the one the refresh
         token belongs to. */
      ? { address: settings.from || null, name: settings.fromName || null,
          replyTo: settings.replyTo || null }
      : null,
    connection: {
      state: connection.state,
      ok: connection.ok === true,
      assumed: connection.assumed === true,
      /* The names of what is unset — never the values. */
      missing: connection.missing || [],
      /* The transport's own sentence when it has one. gmail-transport.js masks
         the credential inside it before it ever reaches here. */
      error: connection.error || stats.reason || null,
    },
    queue: {
      pending: stats.pending,
      failedLast24h: stats.failedLast24h,
      sentToday: stats.sentToday,
      dailyCap: stats.dailyCap,
      perMinute: stats.perMinute,
      /* The 80% line, so the screen can colour it rather than compute it. */
      warnAt: Math.floor(stats.dailyCap * emailOutbox.warnAt()),
      lastSuccessAt: stats.lastSuccessAt,
      healthy: stats.healthy,
      pausedSince: stats.unhealthySince,
    },
    scope: gmail.SCOPE,
    authorizeCommand: 'node scripts/gmail-authorize.js',
  });
});

/* POST /api/email-delivery/test — send one message, to the caller's own address.
 *
 * TO THEMSELVES AND NOWHERE ELSE. A test button that takes a recipient is a
 * button that sends mail from the studio's address to an address of the
 * presser's choosing, which is a small open relay. req.user.email is what the
 * server resolved for this session, so there is nothing to validate and nothing
 * to abuse.
 *
 * SENT DIRECTLY RATHER THAN QUEUED, deliberately: the person is standing in
 * front of the screen waiting to know whether it works, and a queued message
 * would answer "accepted" and tell them nothing. The real result, or the real
 * error, is what comes back.
 */
router.post('/test', async (req, res) => {
  const to = req.user && req.user.email;
  if (!to) return res.status(400).json({ error: 'Your account has no email address to send to.' });

  const app = (() => { try { return branding.current().appName || 'ZVKY FORGE'; }
    catch { return 'ZVKY FORGE'; } })();
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  const result = await transport.send(db, {
    to,
    subject: `${app}: test email`,
    text: `This is a test from ${app}, sent at ${when}.\n\n`
      + 'If you are reading it, the studio\'s email is working.',
    html: `<p>This is a test from <b>${emailOutbox.escapeHtml(app)}</b>, sent at `
      + `${emailOutbox.escapeHtml(when)}.</p><p>If you are reading it, the studio's email is working.</p>`,
  });

  if (result.ok) {
    await emailOutbox.markHealthy(db).catch(() => {});
    req.activity({
      module: 'settings',
      action: 'email.test',
      entityType: 'email',
      entityLabel: 'Test email',
      summary: `Sent a test email to themselves through the ${result.transport} transport`,
    });
    return res.json({ ok: true, to, transport: result.transport,
      summary: `Sent to ${to}. It should arrive in a moment.` });
  }

  /* THE REAL ERROR, not a tidy one. "Check your settings" is what makes a
     support thread take three days; Google's own sentence is what makes it take
     five minutes. The transport has already masked the credential inside it. */
  if (result.kind === 'reauthorise') await emailOutbox.markUnhealthy(db, result.error).catch(() => {});
  req.activity({
    module: 'settings',
    action: 'email.test',
    entityType: 'email',
    entityLabel: 'Test email',
    summary: `A test email failed (${result.kind || 'error'})`,
  });
  return res.status(result.kind === 'unconfigured' ? 409 : 502).json({
    error: result.error || 'The message could not be sent.',
    kind: result.kind || 'temporary',
    transport: result.transport,
  });
});

/* POST /api/email-delivery/resume — try the connection again now.
 *
 * The queue probes once per pass on its own, so this is only ever impatience
 * after re-authorising — which is a perfectly good reason to have a button. It
 * does not clear the flag by itself: it asks the transport, and only a working
 * answer resumes sending. A button that could mark a dead connection healthy
 * would just empty the queue into failures. */
router.post('/resume', async (req, res) => {
  const probe = await transport.checkConnection();
  if (!probe.ok) {
    return res.status(502).json({
      error: probe.error || 'The connection is still not working.',
      state: probe.state,
    });
  }
  const was = await emailOutbox.markHealthy(db);
  const out = await emailOutbox.drain(db);
  req.activity({
    module: 'settings',
    action: 'email.resume',
    entityType: 'email',
    entityLabel: 'Email sending',
    summary: was ? 'Resumed email sending after a connection failure' : 'Checked the email connection',
  });
  res.json({ ok: true, resumed: was, sent: out.sent, pending: (await emailOutbox.stats(db)).pending });
});

module.exports = router;
