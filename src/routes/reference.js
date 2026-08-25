const { asyncRouter } = require('../async-router');
const { authenticate, requireCapability, can } = require('../middleware/auth');
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

// Each list is its own permission, so somebody can be trusted with priorities
// without being trusted with the role catalogue.
const PERMISSION_BY_PATH = {
  'asset-types': 'settings.asset_types',
  priorities: 'settings.priorities',
  roles: 'settings.roles',
};

// Writing to one collection. Replaces the single manageSettings gate that used
// to cover all three.
function requireCollectionPermission(req, res, next) {
  const key = PERMISSION_BY_PATH[req.params.collection];
  if (!key || !can(req, key)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  return next();
}

// Whether this caller may manage any of the lists — for the read that includes
// deactivated values, which is a management view rather than a dropdown.
function managesAnyList(req) {
  return Object.values(PERMISSION_BY_PATH).some((key) => can(req, key));
}

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

// Reads are authoritative.
//
// These used to answer straight from the in-memory mirror, which is only
// refreshed at startup and after a write made through this same process. Rows
// added any other way — a SQL script, a migration, or a write handled by a
// sibling worker — were invisible until a restart, so Settings showed a list
// that did not match the table. Reloading first costs one small query for
// tables of a few dozen rows, and concurrent callers share it.
const db = require('../db');

// GET /api/reference — everything a form needs in one round trip.
router.get('/', async (req, res) => {
  await referenceData.refresh(db);
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
router.get('/:collection', async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  await referenceData.refresh(db);
  const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
  // Listing what has been retired is a management view, not a dropdown.
  if (includeInactive && !managesAnyList(req)) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }
  return res.json({ entries: referenceData.list(name, { includeInactive }) });
});

// GET /api/reference/:collection/:key/usage — how many records hold this value.
// The Settings screen asks before offering to delete, so it can say "12 assets
// use this" rather than only finding out when the delete is refused.
router.get('/:collection/:key/usage', requireCollectionPermission, async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const entry = referenceData.get(name, req.params.key);
  if (!entry) return res.status(404).json({ error: 'That value does not exist.' });
  const count = await referenceData.usageCount(db, name, req.params.key);
  return res.json({ key: entry.key, label: entry.label, inUse: count, canDelete: count === 0 && !entry.isSystem });
});

router.post('/:collection', requireCollectionPermission, async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.create(db, name, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  console.log(`${req.user.email} added ${referenceData.COLLECTIONS[name].singular} "${result.entry.label}".`);
  return res.status(201).json({ entry: result.entry });
});

// Renaming keeps the stored key, so records already holding it are untouched.
router.patch('/:collection/:key', requireCollectionPermission, async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.update(db, name, req.params.key, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  console.log(`${req.user.email} updated ${referenceData.COLLECTIONS[name].singular} "${result.entry.label}".`);
  return res.json({ entry: result.entry });
});

// Deleting only succeeds when nothing uses the value; otherwise the response
// says how many records do and points at deactivating instead.
router.delete('/:collection/:key', requireCollectionPermission, async (req, res) => {
  const name = resolveCollection(req, res);
  if (!name) return undefined;
  const result = await referenceData.remove(db, name, req.params.key);
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
