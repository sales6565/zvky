/* Settings -> Time Sheet. The studio's own policy for the Time Sheet.
 *
 * WHAT IS HERE AND WHAT IS NOT. This route owns the POLICY NUMBERS — how long a
 * normal day is, the smallest and largest a line can be, how far back and ahead
 * a line may be filed, and which days hours can be logged on. The non-project
 * CATEGORY LIST is not here: it is reference data now, so it is served by
 * /api/reference/timesheet-categories with the add, rename, reorder, deactivate
 * and refuse-to-delete-what-is-in-use that every other list already has. Both
 * are gated on the same key, timesheet.options, so the Settings section is one
 * thing to grant.
 *
 * requirePermission, NOT requireSuperAdmin. The tier passes requireSuperAdmin
 * and can() in the browser knows nothing about tiers, so a page written against
 * it would be another instance of the bug public/index.html carries a note
 * about. With requirePermission both sides evaluate the SAME key against the
 * SAME list, and the Super Admin still passes because every permission is
 * implied for that tier.
 *
 * EVERY SAVE IS LOGGED, with the policy as a sentence on both sides. These
 * numbers decide whether somebody can correct last month, so "who closed the
 * window, and to what" is a question that will be asked.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const timesheetSettings = require('../timesheet-settings');
const referenceData = require('../reference-data');
const activity = require('../activity');

const PERMISSION = 'timesheet.options';

router.use(authenticate);
router.use(requirePermission(PERMISSION));

/* Everything the screen draws, in one read: the policy, and the category list
   beside it so the section can show what it governs without a second request.
   Inactive categories included — this is the management view, and retiring one
   is reversible only if you can see it. */
async function payload() {
  if (!timesheetSettings.isLoaded()) await timesheetSettings.load(db).catch(() => {});
  await referenceData.refresh(db).catch(() => {});
  return {
    settings: timesheetSettings.current(),
    categories: referenceData.list('timesheet_categories', { includeInactive: true }),
    /* So the screen can label the one row it must not offer to retire, and say
       why, rather than drawing a button the server would refuse. */
    systemKeys: referenceData.list('timesheet_categories', { includeInactive: true })
      .filter((e) => e.isSystem).map((e) => e.key),
    dayNames: timesheetSettings.DAY_SHORT,
    limits: { hours: timesheetSettings.HOURS_CEILING, window: timesheetSettings.WINDOW_CEILING },
  };
}

// GET /api/admin/settings/timesheet
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/timesheet
router.put('/', async (req, res) => {
  const result = await timesheetSettings.save(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  }
  const was = timesheetSettings.summarise(result.before);
  const now = timesheetSettings.summarise(result.settings);
  /* THE THREE FIELDS THE HOURS RULE TURNS ON, NAMED SEPARATELY, and that is not
   * duplication of the sentence beside them.
   *
   * src/activity.js clips every recorded value at 200 characters. The policy
   * sentence is longer than that, and the hours rule is at the end of it — so
   * "turned the exact-hours rule on, from the 7th" was being clipped out of the
   * one record that exists of it. A test caught it; the fix is to record the
   * three values as their own short fields, which cannot be clipped, rather
   * than to shuffle the sentence and hope the next setting added goes after it.
   *
   * The sentence stays as well: it is what a person reads in the log, and the
   * fields are what an auditor compares. */
  const ruleFields = (settings) => ({
    requiredHoursPerDay: settings.maxDayHours,
    exactHoursRule: settings.hoursRuleEnabled,
    exactHoursRuleFrom: settings.hoursRuleFrom,
  });
  req.activity({
    module: 'settings',
    action: 'timesheet.options_updated',
    entityType: 'setting',
    entityId: 'timesheet_settings',
    entityLabel: 'Time Sheet options',
    summary: was === now ? 'Saved the Time Sheet options with no change'
      : `Changed the Time Sheet options: ${was} → ${now}`,
    changes: {
      ...(activity.diff({ policy: was }, { policy: now }) || {}),
      ...(activity.diff(ruleFields(result.before), ruleFields(result.settings)) || {}),
    },
  });
  res.json(await payload());
});

module.exports = router;
