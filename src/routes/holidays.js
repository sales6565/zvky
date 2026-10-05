/* Settings -> Holidays. The days the studio is shut.
 *
 * TWO KEYS, AND requirePermission FOR BOTH. The list is behind
 * settings.holidays_view, which every designation holds by default; the three
 * mutations are behind settings.holidays, which only the Super Admin tier
 * holds. The Settings section hides what a person cannot use, and that hiding
 * is a courtesy to the reader and nothing more — somebody who knows the URL
 * gets 403 from these handlers with the page never consulted.
 *
 * requirePermission RATHER THAN requireSuperAdmin, unlike Recording Hours
 * beside it, and the difference is deliberate. requireSuperAdmin passes on the
 * TIER or on the key, which is a predicate the page cannot mirror: can() reads
 * the permission list and knows nothing about tiers, so a page written against
 * it would be the fourth instance of the bug public/index.html already carries
 * a note about — a screen asking caps() about something the API decides from
 * permissions. With requirePermission the two sides evaluate the SAME key
 * against the SAME list, and the Super Admin still passes because every
 * permission is implied for that tier.
 *
 * EVERY MUTATION IS LOGGED, with the holiday as a person reads it on both sides
 * of the change. A row here stops the clock for the whole studio on that day,
 * so "who declared this, and when" is a question somebody will ask.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const holidays = require('../holidays');
const activity = require('../activity');

const VIEW = 'settings.holidays_view';
const MANAGE = 'settings.holidays';

router.use(authenticate);

/* Everything the screen draws, in one read.
 *
 * `editable` is decided HERE rather than in the browser, from the same
 * tomorrow-or-later rule the writes enforce — so the button the page offers and
 * the answer the server gives cannot come apart. A page that worked the date
 * comparison out itself would be doing it in the browser's timezone, which is
 * exactly the off-by-one this feature is otherwise careful about. */
async function payload(req) {
  if (!holidays.isLoaded()) await holidays.load(db).catch(() => {});
  return {
    ...holidays.grouped(),
    today: holidays.todayISO(),
    // What the date box's `min` attribute is set to, so the form cannot even
    // offer a date the server would refuse.
    earliest: holidays.tomorrowISO(),
    timezone: 'IST',
    /* So the section can draw itself read-only for somebody who may see the
       calendar and not change it, without a second request and without
       guessing from the tier. The same key the three writes below are gated
       on, answered by the server rather than worked out by the page. */
    canManage: Boolean(req.permissions && req.permissions.has(MANAGE)),
  };
}

// GET /api/admin/settings/holidays
router.get('/', requirePermission(VIEW), async (req, res) => {
  res.json(await payload(req));
});

/* The audit entry the three mutations share — the before/after map the Activity
   Log renders as two columns, with a create and a delete being the same shape
   with one side empty. Lifted from routes/recording-hours.js on purpose: two
   settings screens whose log entries read differently is a log somebody has to
   learn twice. */
function record(req, action, entry, before = null) {
  const after = entry ? holidays.summarise(entry) : null;
  const was = before ? holidays.summarise(before) : null;
  req.activity({
    module: 'settings',
    action: `settings.holidays.${action}`,
    entityType: 'setting',
    entityId: (entry || before).id || null,
    entityLabel: `Holiday — ${after || was}`,
    summary: action === 'create' ? `Declared a holiday: ${after}`
      : action === 'delete' ? `Removed a holiday: ${was}`
        : `Changed a holiday: ${was} → ${after}`,
    changes: activity.diff({ holiday: was }, { holiday: after }),
  });
}

/* The three writes answer in the shape the row-at-a-time screen reads: the
   field-level `errors` list under the inputs they belong to, plus `error` for
   anything that only shows a toast. Same contract as Recording Hours. */
const refuse = (res, result) =>
  res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });

// POST /api/admin/settings/holidays
router.post('/', requirePermission(MANAGE), async (req, res) => {
  const result = await holidays.create(db, req.body || {}, req.user.id);
  if (!result.ok) return refuse(res, result);
  record(req, 'create', result.entry);
  res.status(201).json({ entry: result.entry, ...(await payload(req)) });
});

// PUT /api/admin/settings/holidays/:id
router.put('/:id', requirePermission(MANAGE), async (req, res) => {
  const result = await holidays.update(db, req.params.id, req.body || {});
  if (!result.ok) return refuse(res, result);
  record(req, 'update', result.entry, result.before);
  res.json({ entry: result.entry, ...(await payload(req)) });
});

// DELETE /api/admin/settings/holidays/:id
router.delete('/:id', requirePermission(MANAGE), async (req, res) => {
  const result = await holidays.remove(db, req.params.id);
  if (!result.ok) return refuse(res, result);
  record(req, 'delete', null, result.before);
  res.json({ removed: result.before.id, ...(await payload(req)) });
});

module.exports = router;
