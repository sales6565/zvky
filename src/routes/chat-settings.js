/* Settings -> Chat. How big a group may be, studio-wide.
 *
 * SUPER ADMIN ONLY, ENFORCED HERE. requireSuperAdmin reads the designation the
 * server resolved for the session rather than anything the browser claimed. The
 * Settings page also hides the section, and that hiding is a courtesy to
 * everybody else's page: a person who knows the URL gets 403 from both handlers
 * with the page never consulted.
 *
 * WHY IT IS ITS OWN ROUTE rather than a field on an existing settings screen:
 * this one number changes what every group in the studio may do, and it is the
 * kind of change somebody will later want to find in the Activity Log by name.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const chatSettings = require('../chat-settings');
const activity = require('../activity');

const PERMISSION = 'chat.settings';

router.use(authenticate);
router.use(requireSuperAdmin(PERMISSION));

/* The setting, plus the two figures that make it possible to choose one: how
   many groups the studio actually has, and how big the largest is. A Super
   Admin lowering the cap wants to know what that will close, and counting it
   for them is cheaper than asking them to guess. */
async function payload() {
  if (!chatSettings.isLoaded()) await chatSettings.load(db).catch(() => {});
  const { rows } = await db.query(
    `SELECT COUNT(*) AS groups, COALESCE(MAX(n), 0) AS largest FROM (
        SELECT COUNT(*) AS n
          FROM chat_members m
          JOIN chat_conversations c ON c.id = m.conversation_id
         WHERE c.kind = 'group'
         GROUP BY m.conversation_id
      ) sizes`
  ).catch(() => ({ rows: [{ groups: 0, largest: 0 }] }));
  const limit = chatSettings.maxGroupMembers();
  const largest = Number(rows[0].largest || 0);
  return {
    settings: chatSettings.current(),
    groups: Number(rows[0].groups || 0),
    largest,
    /* Groups already bigger than the cap. Nobody is removed from these — see
       the note in src/chat.js — they simply take no more members. Surfaced so
       the screen can say so with a number rather than in the abstract. */
    overCap: limit === null ? 0 : await overCapCount(limit),
  };
}

async function overCapCount(limit) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM (
        SELECT COUNT(*) AS size
          FROM chat_members m
          JOIN chat_conversations c ON c.id = m.conversation_id
         WHERE c.kind = 'group'
         GROUP BY m.conversation_id
        HAVING size > $1
      ) big`, [limit]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(rows[0].n || 0);
}

// GET /api/admin/settings/chat-group-limit
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/chat-group-limit { maxGroupMembers, unlimited }
router.put('/', async (req, res) => {
  const result = await chatSettings.save(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  }
  const was = chatSettings.describe(result.before.maxGroupMembers);
  const now = chatSettings.describe(result.settings.maxGroupMembers);
  req.activity({
    module: 'settings',
    action: 'settings.chat_group_limit',
    entityType: 'setting',
    entityLabel: 'Max Chat Group Members',
    summary: `Set the largest a chat group may be to ${now} (was ${was})`,
    changes: activity.diff({ maxGroupMembers: was }, { maxGroupMembers: now }),
  });
  res.json(await payload());
});

module.exports = router;
