/* Settings -> Recording Hours. The studio's clock, as any number of named
 * windows.
 *
 * SUPER ADMIN ONLY, ENFORCED HERE. Every route below sits behind
 * requireSuperAdmin, which reads the designation the server resolved for the
 * session rather than anything the browser claimed. The Settings page also
 * hides the section, and that hiding is a courtesy to the reader and nothing
 * more: a person who knows the URL gets 403 from these four handlers with the
 * page never consulted.
 *
 * EVERY MUTATION IS LOGGED, with the window as a person reads it on both sides
 * of the change. These rows decide what every timer in the building records, so
 * "who widened the day, and from what" is a question somebody will eventually
 * ask — and unlike most settings, the answer changes figures that have already
 * been reported.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const recordingHours = require('../recording-hours');
const workSchedule = require('../work-schedule');
const activity = require('../activity');

const PERMISSION = 'settings.recording_hours';

router.use(authenticate);
router.use(requireSuperAdmin(PERMISSION));

/* Everything the screen draws, in one read: both lists, the warnings that go
   with them, and the day lengths they come out to. The warnings are computed
   rather than stored, so a window switched off somewhere else is reflected the
   next time anybody opens the page. */
async function payload() {
  if (!recordingHours.isLoaded()) await recordingHours.load(db).catch(() => {});
  const entries = recordingHours.list();
  const workingTime = require('../working-time');
  const schedule = workSchedule.current();
  /* What the week actually comes to under these windows, which is the number an
     admin is really editing towards. Computed from the same function the timer
     uses, so the screen cannot say one thing while the clock does another. */
  const week = [];
  if (Array.isArray(schedule.entries)) {
    for (let d = 0; d < 7; d += 1) {
      const minutes = workingTime.spansFromEntries(d, schedule.entries)
        .reduce((sum, [a, b]) => sum + (b - a), 0);
      week.push({ dow: workingTime.dowOf(d), minutes });
    }
    week.sort((a, b) => a.dow - b.dow);
  }
  return {
    recording: entries.filter((e) => e.type === 'recording'),
    nonRecording: entries.filter((e) => e.type === 'non_recording'),
    warnings: recordingHours.warningsFor(entries),
    week,
    inForce: Array.isArray(schedule.entries),
    dayNames: recordingHours.DAY_SHORT,
  };
}

// GET /api/admin/settings/recording-hours
router.get('/', async (req, res) => {
  res.json(await payload());
});

/* The audit entry the three mutations share.
 *
 * `changes` is a before/after map rather than a sentence, because that is the
 * shape the Activity Log renders as two columns — and a create and a delete are
 * the same shape with one side empty, which is what makes them readable beside
 * each other in the list. */
function record(req, action, entry, before = null) {
  const label = recordingHours.typeLabel((entry || before).type);
  const after = entry ? recordingHours.summarise(entry) : null;
  const was = before ? recordingHours.summarise(before) : null;
  req.activity({
    module: 'settings',
    action: `settings.recording_hours.${action}`,
    entityType: 'setting',
    entityId: (entry || before).id || null,
    entityLabel: `${label} — ${after || was}`,
    summary: action === 'create' ? `Added a ${label} window: ${after}`
      : action === 'delete' ? `Removed a ${label} window: ${was}`
        : `Changed a ${label} window: ${was} → ${after}`,
    changes: activity.diff({ window: was }, { window: after }),
  });
}

// POST /api/admin/settings/recording-hours
router.post('/', async (req, res) => {
  const result = await recordingHours.create(db, req.body || {}, req.user.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  record(req, 'create', result.entry);
  res.status(201).json({ entry: result.entry, ...(await payload()) });
});

// PUT /api/admin/settings/recording-hours/:id
router.put('/:id', async (req, res) => {
  const result = await recordingHours.update(db, req.params.id, req.body || {});
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  record(req, 'update', result.entry, result.before);
  res.json({ entry: result.entry, ...(await payload()) });
});

// DELETE /api/admin/settings/recording-hours/:id
router.delete('/:id', async (req, res) => {
  const result = await recordingHours.remove(db, req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  record(req, 'delete', null, result.before);
  res.json({ removed: result.before.id, ...(await payload()) });
});

module.exports = router;
