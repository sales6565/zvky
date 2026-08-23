const { asyncRouter } = require('../async-router');
const { authenticate, requireCapability } = require('../middleware/auth');
const referenceData = require('../reference-data');
const { describeTiers } = require('../role-tiers');
const { groupOrder, catalogue } = require('../roles');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

router.use(authenticate);

// The value lists behind the dropdowns — asset types, priorities and roles.
//
// Reading is open to anyone signed in, because every Add Asset and Add User
// form needs these to render. Writing is Super Admin only: the manageSettings
// capability belongs to exactly that tier (src/role-tiers.js), so the check is
// the same capability lookup used everywhere else rather than a role name
// compared by hand.

// URLs use hyphens; the collections are named with underscores.
const COLLECTION_BY_PATH = {
  'asset-types': 'asset_types',
  priorities: 'priorities',
  roles: 'roles',
};

function resolveCollection(req, res) {
  const name = COLLECTION_BY_PATH[req.params.collection];
  if (!name) {
    res.status(404).json({
      error: `Unknown collection "${req.params.collection}".`,
      collections: Object.keys(COLLECTION_BY_PATH),
    });
    return null;
  }
  return name;
}

// GET /api/reference — everything a form needs in one round trip.
router.get('/', (req, res) => {
  res.json({
    assetTypes: referenceData.list('asset_types'),
    priorities: referenceData.list('priorities'),
    roles: catalogue(),
    // Only meaningful to whoever can manage these; harmless to everyone else.
    groups: groupOrder(),
    tiers: describeTiers(),
  });
});

// GET /api/reference/:collection?includeInactive=1
// Deactivated values are only listed when asked for, so the ordinary dropdown
// never offers one, while Settings can still show and reactivate them.
router.get('/:collection', (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
  // Listing what has been retired is a management view, not a dropdown.
  if (includeInactive && !req.user.capabilities.manageSettings) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  return res.json({ entries: referenceData.list(name, { includeInactive }) });
});

// GET /api/reference/:collection/:key/usage — how many records hold this value.
// The Settings screen asks before offering to delete, so it can say "12 assets
// use this" rather than only finding out when the delete is refused.
router.get('/:collection/:key/usage', requireCapability('manageSettings'), async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const entry = referenceData.get(name, req.params.key);
  if (!entry) return res.status(404).json({ error: 'That value does not exist.' });
  const count = await referenceData.usageCount(require('../db'), name, req.params.key);
  return res.json({ key: entry.key, label: entry.label, inUse: count, canDelete: count === 0 && !entry.isSystem });
});

router.post('/:collection', requireCapability('manageSettings'), async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.create(require('../db'), name, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  console.log(`${req.user.email} added ${referenceData.COLLECTIONS[name].singular} "${result.entry.label}".`);
  return res.status(201).json({ entry: result.entry });
});

// Renaming keeps the stored key, so records already holding it are untouched.
router.patch('/:collection/:key', requireCapability('manageSettings'), async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.update(require('../db'), name, req.params.key, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  console.log(`${req.user.email} updated ${referenceData.COLLECTIONS[name].singular} "${result.entry.label}".`);
  return res.json({ entry: result.entry });
});

// Deleting only succeeds when nothing uses the value; otherwise the response
// says how many records do and points at deactivating instead.
router.delete('/:collection/:key', requireCapability('manageSettings'), async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.remove(require('../db'), name, req.params.key);
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.errors[0].message,
      ...(result.inUse !== undefined ? { inUse: result.inUse, alternative: 'deactivate' } : {}),
    });
  }
  console.log(`${req.user.email} deleted ${referenceData.COLLECTIONS[name].singular} "${result.deleted.label}".`);
  return res.json({ ok: true, deleted: result.deleted });
});

module.exports = router;
