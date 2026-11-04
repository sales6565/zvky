/* SETTINGS -> ASSET NAMES. The studio-wide switch over editing an asset's name.
 *
 * SUPER ADMIN ONLY, ENFORCED HERE, and on its own key —
 * settings.asset_rename, which the catalogue implies for the Super Admin tier
 * alone. requireSuperAdmin reads the designation the server resolved for the
 * session, never anything the browser claimed; the Settings page also hides the
 * section, and that hiding is a courtesy to everybody else's page rather than
 * the gate.
 *
 * WHY A SECOND KEY and not assets.rename: the people who may rename an asset
 * are the people who may already edit one, which is most of the studio. If the
 * switch were behind that key, every one of them could take the feature away
 * from everybody else. Using a feature and deciding whether the studio has it
 * are different acts. See the catalogue entry.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const assetSettings = require('../asset-settings');
const activity = require('../activity');

const PERMISSION = 'settings.asset_rename';

router.use(authenticate);
router.use(requireSuperAdmin(PERMISSION));

/* The switch, and the two figures that let a Super Admin see what it governs:
   how many renames have been made at all, and when the last one was. Switching
   a feature off is easier to decide with the answer to "is anybody using it"
   in front of you, and counting it is cheaper than asking them to guess. */
async function payload() {
  if (!assetSettings.isLoaded()) await assetSettings.load(db).catch(() => {});
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n, MAX(changed_at) AS last FROM asset_name_history'
  ).catch(() => ({ rows: [{ n: 0, last: null }] }));
  return {
    settings: assetSettings.current(),
    renames: Number(rows[0].n || 0),
    lastRenameAt: rows[0].last || null,
  };
}

// GET /api/admin/settings/asset-names
router.get('/', async (req, res) => {
  res.json(await payload());
});

// PUT /api/admin/settings/asset-names { renameEnabled }
router.put('/', async (req, res) => {
  const result = await assetSettings.save(db, req.body || {}, req.user.id);
  if (!result.ok) {
    return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  }
  const was = assetSettings.summarise(result.before);
  const now = assetSettings.summarise(result.settings);
  req.activity({
    module: 'settings',
    action: 'settings.asset_rename',
    entityType: 'setting',
    entityLabel: 'Asset Name Editing',
    summary: `Asset name editing is now ${result.settings.renameEnabled ? 'on' : 'off'} (was ${
      result.before.renameEnabled ? 'on' : 'off'})`,
    changes: activity.diff({ assetNames: was }, { assetNames: now }),
  });
  res.json(await payload());
});

module.exports = router;
