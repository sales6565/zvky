const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const adminDashboard = require('../admin-dashboard');
const teamCapacity = require('../team-capacity');
const { holds } = require('../permissions');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// The studio in one screen.
//
// READ-ONLY, and there is exactly one verb here to keep it that way. Every row
// the screen draws is a link into the tab that already owns that work; nothing
// is edited, approved or reassigned from the overview. A dashboard that can
// change things is a second place the studio's rules have to be enforced, and
// this one deliberately is not.
router.use(authenticate);
router.use(requirePermission('report.admin_dashboard'));

/* GET /api/admin-dashboard
 *
 * One payload rather than one endpoint per panel — see the note on build() in
 * src/admin-dashboard.js for why the panels have to be drawn from a single
 * moment.
 *
 * What it returns is SCOPED by the caller's own projectScope, not by this
 * permission. Holding the permission opens the tab; it does not widen anybody's
 * reach. An Admin (projectScope 'owned') sees the projects they created, a
 * Super Admin sees the studio, and neither is shown a figure they could not
 * click through to.
 */
router.get('/', async (req, res) => {
  const data = await adminDashboard.build(db, req.user);

  /* TEAM CAPACITY IS GATED TWICE, and the second gate is the one that matters.
   *
   * The block shows exactly what report.idle already gates: standard working
   * hours against hours actually tracked, aggregated. A studio that withheld
   * the Idle Report from a designation and then granted them this dashboard
   * would have handed over the same numbers by another door.
   *
   * So the key is ABSENT from the payload rather than present and empty. An
   * empty capacity block tells somebody the studio has no capacity, which is a
   * different untruth from telling them nothing; and a zeroed one would still
   * disclose the headcount. The browser hides the panel on the key's absence.
   */
  const capacity = holds(req.user, 'report.idle')
    ? await teamCapacity.build(req.user, {
      buildIdleReport: require('./idle').buildIdleReport,
    })
    : null;

  res.json({
    ...data,
    ...(capacity ? { capacity } : {}),
    /* Said back, so the screen can be honest about whose numbers these are.
       "12 active" means something different to an Admin than to a Super Admin,
       and a panel that does not say which is inviting a misreading. */
    viewer: { name: req.user.name, role: req.user.role },
  });
});

module.exports = router;
