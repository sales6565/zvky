/* SETTINGS -> START-OF-DAY NUDGES. Four switches, and nothing else.
 *
 * THE SECTION IS NEW, not extended. The brief for this change asked for three
 * settings to be ADDED to an existing "Start-of-day nudges" section; there was
 * no such section and there are no automatic nudges in this application at all.
 * See the header of src/reminder-settings.js for what that means and what was
 * and was not built because of it.
 *
 * requirePermission, NOT requireSuperAdmin, and the key is the one that sends
 * reminders rather than a settings key of its own.
 *
 * TWO DECISIONS THERE, both worth stating. It is report.remind because these
 * four values govern exactly one thing — the reminders that key sends — and a
 * fifth settings key for four switches would be a key a studio has to remember
 * to grant alongside the one it actually meant. And it is requirePermission
 * because the tier passes requireSuperAdmin while the browser's can() knows
 * nothing about tiers, so a page written against one and a route against the
 * other is the divergence this application has been bitten by before — see the
 * note at the top of src/routes/timesheet-options.js. The Super Admin still
 * passes, because every permission is implied for that tier.
 *
 * EVERY SAVE IS LOGGED, with the policy as a sentence on both sides. One of
 * these switches decides whether email leaves the building, and "who turned
 * that on" is a question somebody will ask.
 *
 * NO REDEPLOY. save() reloads the in-memory mirror, which is what every reader
 * reads — the next draw of the follow-up section and the next reminder sent see
 * the new values on the same process, and other workers pick them up on their
 * next load. The values are never baked into a page: the streak threshold and
 * the cap travel in the follow-up payload, so a change reaches an open browser
 * on its next refresh rather than on a restart.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const reminderSettings = require('../reminder-settings');
const lastActivity = require('../last-activity');
const reminders = require('../reminders');
const activity = require('../activity');

const PERMISSION = 'report.remind';

router.use(authenticate);
router.use(requirePermission(PERMISSION));

/* Everything the screen draws, in one read: the four values, the ceilings the
   validator will hold them to, and the two sentences that explain what the
   section governs — both from the modules that own them, so the screen cannot
   describe a rule the code does not follow. */
async function payload() {
  if (!reminderSettings.isLoaded()) await reminderSettings.load(db).catch(() => {});
  return {
    settings: reminderSettings.current(),
    defaults: reminderSettings.DEFAULTS,
    limits: { cap: reminderSettings.CAP_CEILING, streak: reminderSettings.STREAK_CEILING },
    /* So the section can say what "activity" means without a second copy of the
       sentence living in the page. */
    activityExplainer: lastActivity.EXPLAINER,
    lookBack: lastActivity.LOOKBACK_WORKING_DAYS,
    blackoutMinutes: reminders.BLACKOUT_MIN_BREAK_MINUTES,
    /* STATED ON THE SCREEN, because a settings section for a feature half of
       which does not exist would otherwise be read as a promise. */
    automatic: false,
  };
}

// GET /api/admin/settings/nudges
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/nudges
router.put('/', async (req, res) => {
  const result = await reminderSettings.save(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  }
  const was = reminderSettings.summarise(result.before);
  const now = reminderSettings.summarise(result.settings);
  req.activity({
    module: 'settings',
    action: 'nudges_updated',
    entityType: 'setting',
    entityId: 'reminder_settings',
    entityLabel: 'Start-of-day nudges',
    summary: was === now ? 'Saved the Start-of-day nudge settings with no change'
      : `Changed the Start-of-day nudges: ${was} → ${now}`,
    changes: activity.diff({ nudges: was }, { nudges: now }),
  });
  res.json(await payload());
});

module.exports = router;
