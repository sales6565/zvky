/* SETTINGS -> HISTORY TAB. Three values, one row, one PUT.
 *
 * requirePermission AND NOT requireSuperAdmin, for the reason every other
 * settings route in this application gives: the tier passes requireSuperAdmin
 * while the browser's can() asks about a key, so a studio that grants the
 * Settings section to a producer would get a screen that draws and refuses. The
 * key is the gate.
 *
 * settings.permissions IS NOT THE KEY HERE. These three values decide whether a
 * tab exists and how much of somebody's own history it opens with — a
 * presentation decision, not a permission one — so it rides with the timesheet
 * section's own key, which is where the tab's data comes from and who already
 * owns the policy that governs it.
 */
const express = require('express');

const { asyncRouter } = require('../async-router');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const historySettings = require('../history-settings');
const activity = require('../activity');

const router = asyncRouter(express.Router());

router.use(authenticate);
router.use(requirePermission('timesheet.options'));

const payload = () => {
  const s = historySettings.current();
  return {
    settings: {
      enabled: s.enabled,
      defaultDays: s.defaultDays,
      submitFromHistory: s.submitFromHistory,
      updatedByName: s.updatedByName,
      updatedAt: s.updatedAt,
    },
    limits: { minDays: historySettings.MIN_DAYS, maxDays: historySettings.MAX_DAYS },
    defaults: historySettings.DEFAULTS,
  };
};

router.get('/', async (req, res) => res.json(payload()));

router.put('/', async (req, res) => {
  const result = await historySettings.save(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({
      errors: result.errors,
      error: result.errors[0].message,
    });
  }
  req.activity({
    module: 'settings',
    action: 'history_updated',
    entityType: 'setting',
    entityId: 'history_settings',
    entityLabel: 'History tab',
    /* ONLY WHAT MOVED in the summary, which is VARCHAR(500); the whole policy
       goes in `changes`, which is TEXT. The same split every other settings
       route uses, for the same reason. */
    summary: historySettings.describeChange(result.before, result.settings),
    changes: activity.diff(
      { history: historySettings.summarise(result.before) },
      { history: historySettings.summarise(result.settings) }
    ),
  });
  return res.json(payload());
});

module.exports = router;
