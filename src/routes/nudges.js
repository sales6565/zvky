/* SETTINGS -> START-OF-DAY NUDGES. Four switches, and nothing else.
 *
 * THE SECTION IS NEW, not extended. The brief for this change asked for three
 * settings to be ADDED to an existing "Start-of-day nudges" section; there was
 * no such section and there are no automatic nudges in this application at all.
 * See the header of src/reminder-settings.js for what that means and what was
 * and was not built because of it.
 *
 * ITS OWN KEY NOW, AND IT USED TO BE report.remind. The section began as four
 * switches over the reminders that key sends, and was gated on it for exactly
 * that reason. It now also governs the start-of-day BANNER and the top-bar
 * timer INDICATOR, which are not reminders and which every signed-in person
 * sees — so "may send messages to people" is no longer the right thing to be
 * holding in order to switch them off. The practical consequence is stated
 * rather than hidden: a studio that had delegated report.remind to its leads has
 * not thereby delegated this screen. Both default to the Super Admin tier alone,
 * so nothing moves on an install that has changed neither.
 *
 * requirePermission, NOT requireSuperAdmin, because the tier passes
 * requireSuperAdmin while the browser's can() knows nothing about tiers, so a
 * page written against one and a route against the other is the divergence this
 * application has been bitten by before — see the note at the top of
 * src/routes/timesheet-options.js. The Super Admin still passes, because every
 * permission is implied for that tier.
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
const startReminders = require('../start-reminders');
const dayState = require('../day-state');
const workSchedule = require('../work-schedule');
const activity = require('../activity');

const PERMISSION = 'settings.nudges';

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
    /* THE AUTOMATIC HALF EXISTS NOW, which this field said it did not. It was
       false from the day the section shipped because there was no sweep; there
       is one, so the sentence it drove is gone and the screen says what the two
       reminders are instead. */
    automatic: true,
    /* WHEN EACH REMINDER IS DUE, worked out from the studio's own schedule and
       the saved settings — so the screen quotes the times the sweep will
       actually use rather than restating the rule. Null where the studio has no
       recording windows at all. */
    occasions: occasionsFor(),
    /* The ranges the validator holds the numbers to, and the clock format, so
       the form's inputs and the server's refusals agree. */
    ranges: {
      grace: { min: reminderSettings.GRACE_MIN, max: reminderSettings.GRACE_MAX },
      snooze: { min: reminderSettings.SNOOZE_MIN, max: reminderSettings.SNOOZE_MAX },
    },
    secondReminderLabel: reminderSettings.clock(reminderSettings.current().secondReminderMinutes),
    indicatorStates: Object.values(dayState.STATES),
  };
}

/* The two reminder times as the screen shows them. Asked of
   src/start-reminders.js, which owns the window arithmetic, so a change to how
   the first one is derived moves this line with it. */
function occasionsFor(now = Date.now()) {
  const schedule = workSchedule.trackingWindow();
  const w = startReminders.windowsFor({ now, settings: reminderSettings.current(), schedule });
  if (!w) return null;
  const label = reminderSettings.clock;
  return {
    opensAt: label(w.open),
    closesAt: label(w.close),
    first: label(w.windows[startReminders.FIRST].from),
    second: label(w.windows[startReminders.SECOND].from),
  };
}

// GET /api/admin/settings/nudges
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/nudges
router.put('/', async (req, res) => {
  /* THE STUDIO'S OWN SCHEDULE IS HANDED TO THE VALIDATOR, which is what lets it
     refuse a second reminder before the first or outside working hours without
     reading the schedule itself. The two rules are then one comparison each
     against numbers the studio set in Recording Hours. */
  const spans = (() => {
    const schedule = workSchedule.trackingWindow();
    const { day } = require('../working-time').istPartsOf(Date.now());
    const s2 = require('../working-time').spansOn(day, schedule);
    /* A DAY THE STUDIO IS SHUT would answer "no hours", and validating against
       that would refuse every save made on a Sunday. Asked of the longest day
       the week holds instead, through the same schedule the clock uses. */
    if (s2.length) return { openMinute: s2[0][0], closeMinute: s2[s2.length - 1][1] };
    for (let d = 0; d < 7; d += 1) {
      const week = require('../working-time').spansOn(day + d, schedule);
      if (week.length) return { openMinute: week[0][0], closeMinute: week[week.length - 1][1] };
    }
    return null;
  })();
  const result = await reminderSettings.save(db, req.body || {}, req.user.id, { schedule: spans });
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
    /* ONLY THE CLAUSES THAT MOVED — see describeChange() on why: the whole
       policy no longer fits in activity_log.summary, and the clauses that did
       not change are not what anybody came looking for. The full before and
       after are in `changes` below, which is TEXT. */
    summary: reminderSettings.describeChange(result.before, result.settings),
    changes: activity.diff({ nudges: was }, { nudges: now }),
  });
  res.json(await payload());
});

module.exports = router;
