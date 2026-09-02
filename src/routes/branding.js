const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const multer = require('multer');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const branding = require('../branding');
const workSchedule = require('../work-schedule');
const activity = require('../activity');

/* The logo arrives in memory, not on disk. It is one small image on its way
 * into a table, so writing it to a temp file first would only create something
 * to clean up. The size cap is enforced here as well as in branding.js — multer
 * stops the upload, and the module refuses anything that gets past it. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: branding.MAX_LOGO_BYTES, files: 1 },
});

/* GET /api/branding — the name, tagline and whether a logo is set.
 *
 * Deliberately unauthenticated. The sign-in screen wears the studio's name and
 * logo, and that screen is by definition reached without a token. Nothing here
 * is a secret: it is what every visitor sees at the top of the page. */
router.get('/', async (req, res) => {
  if (!branding.isLoaded()) await branding.load(db).catch(() => {});
  res.json({ branding: branding.current() });
});

/* GET /api/branding/logo — the image itself, or 404 when none is set.
 *
 * Also unauthenticated, for the same reason. Cached for a few minutes but
 * revalidated, so a new logo appears without anyone clearing their cache: the
 * URL carries the upload time, which changes when the image does. */
router.get('/logo', async (req, res) => {
  const logo = await branding.readLogo(db).catch(() => null);
  if (!logo) return res.status(404).json({ error: 'No logo has been uploaded.' });
  res.setHeader('Content-Type', logo.mime);
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.send(logo.buffer);
});

// Everything below changes it.
router.use(authenticate);

router.put('/', requirePermission('settings.branding'), async (req, res) => {
  const { appName, tagline } = req.body || {};
  const result = await branding.save(db, { appName, tagline });
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  console.log(`${req.user.email} set the application name to "${result.branding.appName}".`);
  res.json(result.branding && { branding: result.branding });
});

router.post('/logo', requirePermission('settings.branding'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.', field: 'logo' });
  const result = await branding.saveLogo(db, { buffer: req.file.buffer, mime: req.file.mimetype });
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  console.log(`${req.user.email} uploaded a new logo (${req.file.mimetype}, ${req.file.size} bytes).`);
  res.json({ branding: result.branding });
});

router.delete('/logo', requirePermission('settings.branding'), async (req, res) => {
  const result = await branding.clearLogo(db);
  console.log(`${req.user.email} removed the logo.`);
  res.json({ branding: result.branding });
});

/* The standard working day, which the Idle Report measures against.
 *
 * It lives on the branding router because both are one-row studio-wide settings
 * edited on the same Settings screen, and because giving a single field its own
 * file and mount would be more moving parts than the thing is worth. Read by
 * anyone signed in — a report that shows the number has to be able to say what
 * the number was, and the Time Sheet form has to be able to draw the window it
 * accepts — and written behind settings.working_hours, which is its own
 * permission rather than branding's: changing the studio's clock changes what
 * every account may record, and that is not the same authority as changing a
 * logo. */
router.get('/schedule', async (req, res) => {
  if (!workSchedule.isLoaded()) await workSchedule.load(db).catch(() => {});
  res.json({ schedule: workSchedule.current() });
});

router.put('/schedule', requirePermission('settings.working_hours'), async (req, res) => {
  const { hoursPerDay, workingDays, dayStart, dayEnd, lunchStart, lunchEnd } = req.body || {};
  const before = workSchedule.current();
  const result = await workSchedule.save(db,
    { hoursPerDay, workingDays, dayStart, dayEnd, lunchStart, lunchEnd });
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  const s = result.schedule;
  req.activity({
    module: 'settings', action: 'settings.working_hours', entityType: 'setting',
    entityLabel: 'Working Hours',
    summary: `Set the working day to ${s.dayStartLabel}–${s.dayEndLabel} ${s.timezone}, `
      + `${s.hoursPerDay}h, ${s.workingDayNames.join('/')}`,
    changes: activity.diff(
      { day: `${before.dayStartLabel}–${before.dayEndLabel}`,
        lunch: before.hasLunch ? `${before.lunchStartLabel}–${before.lunchEndLabel}` : 'none',
        hoursPerDay: before.hoursPerDay, workingDays: before.workingDayNames.join(', ') },
      { day: `${s.dayStartLabel}–${s.dayEndLabel}`,
        lunch: s.hasLunch ? `${s.lunchStartLabel}–${s.lunchEndLabel}` : 'none',
        hoursPerDay: s.hoursPerDay, workingDays: s.workingDayNames.join(', ') }
    ),
  });
  /* On the record with the times in it. This setting decides what everybody's
     Time Sheet will accept, so "who changed the studio's hours, and to what"
     is a question somebody will eventually ask. */
  console.log(`${req.user.email} set the working day to ${s.hoursPerDay}h, `
    + `${s.workingDayNames.join('/')}, ${s.dayStartLabel}-${s.dayEndLabel}, `
    + `lunch ${s.hasLunch ? `${s.lunchStartLabel}-${s.lunchEndLabel}` : 'none'}.`);
  res.json({ schedule: s });
});

module.exports = router;
