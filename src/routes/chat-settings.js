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
const { authenticate, requireSuperAdmin, requirePermission } = require('../middleware/auth');
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

/* ---------------------------------------------------------------------------
 * Settings -> Chat: attachment retention, and the two Prompt 58 switches.
 *
 * ITS OWN PERMISSION, settings.chat_retention, and NOT the router-wide
 * requireSuperAdmin above. How big a group may be is a matter of taste; how
 * long a file is kept before it is DELETED is a matter of somebody's work
 * disappearing, and a studio that delegates the first has not thereby
 * delegated the second.
 *
 * SO IT IS A SECOND ROUTER, mounted at its own path, rather than two more
 * handlers below. The router.use(requireSuperAdmin) at the top of this file
 * applies to every route declared on `router`, so a holder of
 * settings.chat_retention who is not a Super Admin would be turned away by it
 * before their own permission was ever consulted — the grant would be real in
 * the catalogue and worth nothing in practice. Same file, because this is
 * where somebody looking for "the chat settings" will look; different router,
 * because they are different gates.
 */
const policy = asyncRouter();
policy.use(authenticate);
policy.use(requirePermission('settings.chat_retention'));

const policyPayload = () => ({
  settings: chatSettings.current(),
  /* WHAT IS ACTUALLY OUT THERE, so a Super Admin shortening the retention can
     see what it will and will not touch. Live attachments keep the expiry they
     were uploaded with, which is the whole promise of the screen's note. */
  live: null,
});

/* THE HEALTH PANEL'S FIGURES. Read-only, behind the same permission as the
 * retention itself, and deliberately the smallest set of facts that answers the
 * question the studio actually asked twice: "where did the files go?"
 *
 *   the folder, and where it came from — because the first thing to establish
 *      is whether the server agrees with the owner about where files live;
 *   writable, outside the app, outside temp — the three ways it is wrong,
 *      each said separately so the fix is obvious;
 *   live attachments — a number that makes "they are all gone" checkable;
 *   missing before expiry, last seven days, with the latest time — the fault
 *      that should never happen, counted rather than guessed at.
 *
 * NO PATHS BEYOND THE UPLOAD ROOTS and no environment values: this is a screen
 * about storage, not a window onto the filesystem. */
async function storageHealth() {
  const storage = require('../chat-files').storage.status({ refresh: true });
  const files = require('../chat-files');
  const live = await files.liveAttachmentCount(db);
  const { rows: inc } = await db.query(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM chat_file_incidents
      WHERE kind = 'missing_before_expiry' AND created_at >= NOW() - INTERVAL 7 DAY`
  ).catch(() => ({ rows: [{ n: 0, latest: null }] }));
  const { rows: halted } = await db.query(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM chat_file_incidents
      WHERE kind LIKE 'sweep_halted%' AND created_at >= NOW() - INTERVAL 7 DAY`
  ).catch(() => ({ rows: [{ n: 0, latest: null }] }));
  return {
    path: storage.path,
    source: storage.source,
    envName: storage.envName,
    hint: storage.hint,
    legacyPath: storage.legacyPath,
    legacyExists: storage.legacyExists,
    ok: storage.ok,
    acceptingUploads: files.acceptingUploads(),
    problems: storage.problems,
    insideApp: storage.problems.some((p) => p.code === 'inside-app'),
    inTemp: storage.problems.some((p) => p.code === 'temp'),
    writable: !storage.problems.some((p) => p.code === 'not-writable' || p.code === 'missing'),
    liveAttachments: live,
    missingLast7Days: Number(inc[0].n) || 0,
    missingLatest: inc[0].latest || null,
    sweepsHaltedLast7Days: Number(halted[0].n) || 0,
    sweepHaltedLatest: halted[0].latest || null,
  };
}

policy.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM chat_attachments
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at > NOW()`
  ).catch(() => ({ rows: [{ n: 0 }] }));
  res.json({ ...policyPayload(), live: Number(rows[0].n || 0), storage: await storageHealth() });
});

policy.put('/', async (req, res) => {
  const result = await chatSettings.saveAttachmentPolicy(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  }
  const was = chatSettings.describeAttachmentPolicy(result.before);
  const now = chatSettings.describeAttachmentPolicy(result.settings);
  /* WHO, OLD, NEW, WHEN — through the mechanism every other setting in this
     application uses, so it reads in the Activity Log beside them rather than
     in a log of its own. */
  req.activity({
    module: 'settings',
    action: 'settings.chat_retention',
    entityType: 'setting',
    entityLabel: 'Chat attachment retention',
    summary: was === now ? 'Saved the chat attachment settings with no change'
      : `Changed the chat attachment settings: ${was} → ${now}`,
    changes: activity.diff({ policy: was }, { policy: now }),
  });
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM chat_attachments
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at > NOW()`
  ).catch(() => ({ rows: [{ n: 0 }] }));
  res.json({ ...policyPayload(), live: Number(rows[0].n || 0), storage: await storageHealth() });
});

module.exports = router;
module.exports.policy = policy;
