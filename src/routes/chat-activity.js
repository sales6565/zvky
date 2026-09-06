/* Chat Activity — reading every conversation in the studio.
 *
 * A ROUTER OF ITS OWN, mounted separately from /api/chat, and that separation
 * is the design rather than tidiness. src/routes/chat.js is behind chat.use and
 * behind membership on every conversation route; nothing here touches those
 * gates and nothing there reads this permission. Granting settings.chat_activity
 * changes what this router will answer and nothing else in the application.
 *
 * WHAT IT IS FOR, said once so the code and the screen agree: oversight. The
 * studio asked for it deliberately, after being told what it costs — see the
 * header of src/routes/chat.js, which used to promise the opposite and now says
 * what is actually true.
 *
 * THREE THINGS ARE TRUE OF EVERY ROUTE BELOW.
 *
 *   IT IS READ-ONLY. There is no endpoint here that writes, edits or deletes a
 *   message, and that is deliberate in the same way the Activity Log's absence
 *   of a delete endpoint is: a record somebody with access can edit is not a
 *   record. Nor is there any way to reply, join, or otherwise appear in a
 *   conversation from here — reading is not taking part.
 *
 *   IT IS RECORDED. Every read writes a line to the Activity Log naming who
 *   looked and what they filtered by. The Activity Log middleware only records
 *   state changes, so a GET would slip past it — these routes record
 *   themselves. Reading other people's messages leaves a trace; taking part in
 *   your own does not.
 *
 *   IT PRESERVES NOTHING. An attachment is deleted twelve hours after it was
 *   sent, here as everywhere. This screen shows the same placeholder the panel
 *   does once that has happened, and cannot be used to keep a file alive.
 */
const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const oversight = require('../chat-oversight');
const files = require('../chat-files');
const activity = require('../activity');

router.use(authenticate);
/* One gate, and NOT chat.use beside it. Whether somebody uses chat themselves
   is a different question from whether they oversee it: a studio may well close
   chat for an administrator's designation and still want them able to read the
   record. Requiring both would make that combination impossible to express. */
router.use(requirePermission('settings.chat_activity'));

/* What was asked for, in one short line, for the Activity Log entry.
 *
 * The FILTER is recorded, never the result. "Read Chat Activity — searched for
 * 'contract', 1 Mar to 7 Mar" is what makes the record useful for the question
 * it exists to answer: not that somebody looked, but what they went looking
 * for. Recording the messages returned would put chat content into a second
 * table with a different permission on it, which is the one thing this feature
 * must not quietly do. */
function describeFilter(query = {}, people = []) {
  const bits = [];
  if (query.personId) {
    const who = people.find((p) => String(p.id) === String(query.personId));
    bits.push(`about ${who ? who.name : query.personId}`);
  }
  if (query.conversationId) bits.push('one conversation');
  if (query.kind === 'group') bits.push('groups only');
  if (query.kind === 'direct') bits.push('one-to-one only');
  if (query.q) bits.push(`searching "${String(query.q).slice(0, 60)}"`);
  if (query.from || query.to) bits.push(`${query.from || 'the beginning'} to ${query.to || 'today'}`);
  if (query.withFiles) bits.push('with a file');
  return bits.length ? bits.join(', ') : 'everything';
}

/* GET /api/chat-activity — the page.
 *
 * Filters by person, conversation, kind, date range, free text and whether
 * there is a file; pages; and returns the total, because "1–50 of 12,431" is
 * the number that tells somebody whether their filter did anything. Deliberately
 * the same shape as GET /api/activity, so the two screens are one thing to
 * learn.
 */
router.get('/', async (req, res) => {
  const result = await oversight.page(db, req.query);
  const people = await oversight.people(db);

  if (result.unavailable) {
    return res.status(503).json({
      error: 'Chat is not available on this deployment yet — the database is missing the chat '
        + 'tables. See /api/health.',
    });
  }

  /* Recorded BEFORE the response goes out, and not awaited into failure: a log
     write that fails must not turn a successful read into an error the person
     retries — which would leave the read done and unlogged either way. The
     failure is printed by activity.record itself. */
  activity.record(db, {
    actor: req.user,
    module: 'settings',
    action: 'chat.activity_viewed',
    entityType: 'chat',
    entityLabel: 'Chat Activity',
    summary: `Read Chat Activity — ${describeFilter(req.query, people)}`,
    /* How much was shown. Enough to tell a large trawl from a targeted look,
       which is the difference somebody reviewing this record cares about. */
    changes: { shown: { from: null, to: `${result.messages.length} of ${result.total}` } },
    method: 'GET',
    path: '/api/chat-activity',
  }).catch(() => {});

  res.json({
    ...result,
    people,
    /* The screen prints this rather than holding its own copy of the sentence,
       so the disclosure and the behaviour cannot drift apart. */
    notice: 'Every visit to this screen is recorded in the Activity Log, naming you and what you '
      + 'searched for. Chat files are deleted '
      + `${files.HOURS} hours after they are sent and cannot be recovered from here.`,
  });
});

/* GET /api/chat-activity/summary — the headline figures, for the section
   header. Its own endpoint so the page can show them before anybody filters,
   and so paging does not recount the whole table every time. */
router.get('/summary', async (req, res) => {
  res.json(await oversight.summary(db));
});

/* GET /api/chat-activity/attachments/:attachmentId — the bytes.
 *
 * A separate path from the panel's, pointing at files.forOversight, which has
 * no membership join. Authorisation is this router's gate and nothing else,
 * which is exactly why it is not the same URL: an attachment link that worked
 * for two different reasons depending on who clicked it would be one link
 * nobody could reason about.
 *
 * Expiry is unchanged — the same 410, after the same twelve hours.
 */
router.get('/attachments/:attachmentId', async (req, res) => {
  const found = await files.forOversight(db, req.params.attachmentId);
  if (!found.ok) return res.status(found.status).json({ error: found.error });

  activity.record(db, {
    actor: req.user,
    module: 'settings',
    action: 'chat.activity_file_opened',
    entityType: 'chat',
    entityId: req.params.attachmentId,
    entityLabel: found.fileName,
    summary: `Opened a chat file from Chat Activity — ${found.fileName}`,
    method: 'GET',
    path: '/api/chat-activity/attachments',
  }).catch(() => {});

  res.setHeader('Content-Type', found.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (found.scriptable) {
    /* The same treatment the panel gives an SVG, and for the same reason: a
       forced download plus a sandbox CSP, so a file carrying a script never
       becomes a page on this origin. Oversight is not a reason to relax it. */
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(found.fileName)}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(found.fileName)}"`);
  }
  res.sendFile(found.path);
});

module.exports = router;
