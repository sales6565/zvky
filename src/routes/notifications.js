const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const notifications = require('../notifications');

router.use(authenticate);

/* No permission gates anything here, and that is deliberate.
 *
 * A notification is addressed to one person. There is no "may read
 * notifications" question to ask, because the only notifications any request
 * can reach are the caller's own — every query below is scoped by
 * recipient_id = req.user.id, in the WHERE clause rather than checked
 * separately, so there is no path that returns somebody else's and no window in
 * which one could be marked read by the wrong person.
 *
 * Adding a permission would only be able to say "you may not see things
 * addressed to you", which no studio means.
 */

// GET /api/notifications — the header list. Read and unread, newest first.
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const [items, unread, cursor] = await Promise.all([
    notifications.listFor(db, req.user.id, { limit }),
    notifications.unreadCount(db, req.user.id),
    notifications.highWater(db, req.user.id),
  ]);
  res.json({ notifications: items, unread, cursor });
});

/* GET /api/notifications/poll?since=<iso>
 *
 * The cheap one, called every thirty seconds by every open tab, so it does as
 * little as possible: a count, and only the rows raised since the caller last
 * looked. Without `since` it returns the count alone — that is the first call
 * after a page load, where the list endpoint has already supplied the rest.
 *
 * This app has no WebSocket or SSE, and adding one would be worse than polling
 * here rather than better: src/reference-data.js records that running more than
 * one Node worker is the common case in production, and a pushed event raised
 * in one worker cannot reach a browser held by another without a shared bus.
 * Polling is correct under any number of workers and adds no dependency.
 */
router.get('/poll', async (req, res) => {
  const unread = await notifications.unreadCount(db, req.user.id);
  const fresh = req.query.since !== undefined
    ? await notifications.since(db, req.user.id, req.query.since)
    : [];
  /* The next cursor: the last row handed over, or the current high-water mark
     when nothing was. Returned either way so the client never has to guess. */
  const cursor = fresh.length ? fresh[fresh.length - 1].seq : await notifications.highWater(db, req.user.id);
  res.json({ unread, fresh, cursor });
});

// POST /api/notifications/read — mark specific ones read.
router.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'Send the notifications to mark read.', field: 'ids' });
  const marked = await notifications.markRead(db, req.user.id, ids);
  res.json({ marked, unread: await notifications.unreadCount(db, req.user.id) });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  const marked = await notifications.markAllRead(db, req.user.id);
  res.json({ marked, unread: await notifications.unreadCount(db, req.user.id) });
});

module.exports = router;
