/* SETTINGS -> LEAVE. The master switch and the half-day split.
 *
 * ITS OWN KEY, settings.leave.manage, and deliberately not followup.mark_leave.
 * Recording one person's absence and deciding that the studio has the feature
 * at all — and where its day divides — are different powers, and the second one
 * moves every future half-day in the studio at once. A studio that delegates
 * the marking has not thereby delegated the policy.
 *
 * requirePermission, NOT requireSuperAdmin, for the reason src/routes/nudges.js
 * gives at length: the tier passes requireSuperAdmin while the browser's can()
 * knows nothing about tiers, so a page written against one and a route against
 * the other is a divergence this application has already been bitten by. The
 * Super Admin still passes, because every permission is implied for that tier.
 *
 * EVERY SAVE IS LOGGED, with the policy as a sentence on both sides. One of
 * these fields decides whether anybody's recorded hours can be removed, and
 * "who turned that on" is a question somebody will ask.
 *
 * NO REDEPLOY. save() reloads the in-memory mirror every reader reads, and the
 * switch travels to the page inside the follow-up payload on every draw — so an
 * admin turning it on makes the buttons appear on the next refresh of an open
 * browser, with no restart and no sign-out.
 *
 * Prompt 49 adds further fields to this same group, behind this same key.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const leaveSettings = require('../leave-settings');
const dayStatus = require('../day-status');
const workSchedule = require('../work-schedule');
const activity = require('../activity');

const PERMISSION = 'settings.leave.manage';

router.use(authenticate);
router.use(requirePermission(PERMISSION));

/* Everything the screen draws, in one read.
 *
 * THE PREFILL TRAVELS BESIDE THE SAVED VALUES rather than being folded into
 * them, because the screen has to tell the two apart: it shows the admin what
 * the studio's lunch break would give them on a first run, and the "Reset to
 * lunch times" link needs something to reset TO. A single merged pair of
 * numbers would make "nobody has chosen yet" and "somebody chose 13:00"
 * indistinguishable. */
async function payload() {
  if (!leaveSettings.isLoaded()) await leaveSettings.load(db).catch(() => {});
  const schedule = workSchedule.current();
  const settings = leaveSettings.current();
  const current = leaveSettings.split({ settings, schedule });
  const prefill = leaveSettings.prefill({ schedule });
  return {
    settings,
    defaults: leaveSettings.DEFAULTS,
    /* The split in force, as both numbers and clock labels, so the form's
       <input type="time"> and the Leave menu's "until 13:00" agree. */
    split: {
      ...current,
      firstHalfEnd: leaveSettings.clock(current.firstHalfEndMinutes),
      secondHalfStart: leaveSettings.clock(current.secondHalfStartMinutes),
      /* 'saved' once an admin has agreed to it; 'lunch' or 'midpoint' while
         nothing is stored and the screen is showing a suggestion. */
      source: current.from,
    },
    prefill: {
      ...prefill,
      firstHalfEnd: leaveSettings.clock(prefill.firstHalfEndMinutes),
      secondHalfStart: leaveSettings.clock(prefill.secondHalfStartMinutes),
    },
    /* The studio's own day, so the form can bound its time inputs to exactly
       what the server will accept rather than to a guess. */
    workingDay: {
      from: leaveSettings.clock(schedule.dayStart),
      to: leaveSettings.clock(schedule.dayEnd),
      fromMinutes: schedule.dayStart,
      toMinutes: schedule.dayEnd,
    },
    breaks: workSchedule.breakWindows(schedule).map((w) => ({
      key: w.key, label: w.label,
      start: leaveSettings.clock(w.start), end: leaveSettings.clock(w.end),
    })),
    /* So the section can say what Idle requires without a second copy of the
       list living in the page — tests/… holds the two equal. */
    actionableStatuses: dayStatus.ACTIONABLE_STATUSES,
  };
}

// GET /api/admin/settings/leave
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/leave
router.put('/', async (req, res) => {
  const schedule = workSchedule.current();
  const result = await leaveSettings.save(db, req.body || {}, req.user.id, { schedule });
  if (!result.ok) {
    return res.status(result.status).json({
      errors: result.errors, warnings: result.warnings, error: result.errors[0].message,
    });
  }
  const was = leaveSettings.summarise(result.before, { schedule });
  const now = leaveSettings.summarise(result.settings, { schedule });
  req.activity({
    module: 'settings',
    action: 'leave_updated',
    entityType: 'setting',
    entityId: 'leave_settings',
    entityLabel: 'Leave',
    /* Only the clauses that moved — activity_log.summary is VARCHAR(500) and a
       line that stops mid-word is worse than one that says what changed. The
       whole policy is in `changes`, which is TEXT. */
    summary: leaveSettings.describeChange(result.before, result.settings, { schedule }),
    changes: activity.diff({ leave: was }, { leave: now }),
  });
  res.json({
    ...(await payload()),
    /* NON-BLOCKING, AND SAID AFTER THE SAVE rather than instead of it: a gap
       between the two halves that is ordinary working time is a legitimate
       thing for a studio to want and a surprising thing to do by accident. */
    warnings: result.warnings,
    /* HOW MANY FUTURE HALF-DAYS MOVED WITH THE SPLIT. Today's and every past
       one keep their snapshot, which is what stops a settings change rewriting
       a figure somebody has already seen. */
    resnapshotted: result.resnapshotted,
  });
});

module.exports = router;
