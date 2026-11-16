const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const multer = require('multer');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const branding = require('../branding');
const favicon = require('../favicon');
const workSchedule = require('../work-schedule');
const activity = require('../activity');
const recordingHours = require('../recording-hours');

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
  if (!favicon.isLoaded()) await favicon.load(db).catch(() => {});
  /* THE ICON'S VERSION RIDES ALONG HERE RATHER THAN IN A REQUEST OF ITS OWN.
   *
   * The page already fetches this before it paints anything, because the
   * sign-in screen needs the studio's name and logo. The icon needs one string
   * — the digest prefix that goes in its URL — and asking for it separately
   * would put a second round trip on the path to the first paint of every page
   * view, signed in or not, to decide what to put in <head>.
   *
   * Merged flat into the same object so a page served by an older build simply
   * does not find the fields and shows no icon, which is what it does today. */
  res.json({ branding: { ...branding.current(), ...favicon.payload() } });
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

/* ------------------------------------------------------- the browser tab icon */

/* The cap is multer's as well as the module's, so an oversized file is refused
   while it is still arriving rather than after half a megabyte has been read
   into this process. */
const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: favicon.MAX_BYTES, files: 1 },
});

/* multer's own error for an oversized upload is a 500 with a code nobody can
   act on. Turned into the sentence the module would have given, with the limit
   in it — the same shape src/routes/assets.js uses for thumbnails. */
const acceptIcon = (req, res, next) => uploadIcon.single('favicon')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `That file is larger than the ${Math.round(favicon.MAX_BYTES / 1024)}KB limit.`,
      field: 'favicon',
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Upload one image, in the icon field.', field: 'favicon' });
  }
  return res.status(400).json({ error: 'That upload could not be read.', field: 'favicon' });
});

/* How the icon is described in the audit log and in the Settings screen: the
   format, the size it was measured at, and what it weighs. */
const describeIcon = (meta) => (meta
  ? `${String(meta.mime || '').replace('image/', '').replace('vnd.microsoft.icon', 'ico').toUpperCase()} `
    + `${meta.width}x${meta.height}, ${Math.max(1, Math.round((meta.bytes || 0) / 1024))}KB`
  : 'none');

router.post('/favicon', requirePermission('settings.branding'), acceptIcon, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.', field: 'favicon' });

  /* THE SERVER DECIDES. The page checks the same things before it offers Save,
     so somebody choosing a holiday photo is told immediately — but that check
     is a courtesy to whoever is looking at the screen, and this one is the
     rule. src/favicon.js is the only thing either of them asks. */
  const verdict = favicon.validate({ buffer: req.file.buffer, declaredMime: req.file.mimetype });
  if (!verdict.ok) {
    return res.status(verdict.status).json({
      error: verdict.message,
      field: verdict.field,
      errors: [{ field: verdict.field, message: verdict.message }],
    });
  }

  const before = favicon.meta();
  await favicon.save(db, {
    buffer: req.file.buffer,
    mime: verdict.mime,
    sha256: verdict.sha256,
    width: verdict.width,
    height: verdict.height,
    userId: req.user.id,
  });
  const after = favicon.meta();

  /* THE NAME, NEVER THE PATH. favicon.displayName() takes the last segment and
     drops control characters; the comment above it says why the rest of what a
     client sends is not something this studio should keep. */
  const name = favicon.displayName(req.file.originalname);
  req.activity({
    module: 'settings',
    action: 'settings.branding.favicon',
    entityType: 'setting',
    entityLabel: 'Branding',
    summary: `Set the browser tab icon to ${name} (${describeIcon(after)})`,
    changes: activity.diff({ icon: describeIcon(before) }, { icon: describeIcon(after) }),
  });
  /* On the record with no bytes and no path in it. */
  console.log(`${req.user.email} uploaded a new tab icon (${describeIcon(after)}).`);

  res.json({ branding: { ...branding.current(), ...favicon.payload() } });
});

router.delete('/favicon', requirePermission('settings.branding'), async (req, res) => {
  const before = favicon.meta();
  const { removed } = await favicon.clear(db);
  /* Logged whether or not there was one to remove, because "they pressed it and
     nothing happened" is a thing somebody will ask about; the summary says
     which it was. */
  req.activity({
    module: 'settings',
    action: 'settings.branding.favicon',
    entityType: 'setting',
    entityLabel: 'Branding',
    summary: removed
      ? `Removed the browser tab icon (was ${describeIcon(before)}); the default is back`
      : 'Removed the browser tab icon; there was none set',
    changes: activity.diff({ icon: describeIcon(before) }, { icon: 'none' }),
  });
  console.log(`${req.user.email} removed the tab icon.`);
  res.json({ branding: { ...branding.current(), ...favicon.payload() }, removed });
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

/* "Lunch 13:00–14:00, Morning break 11:00–11:15" — or "none". One line for the
   audit entry, so a reader can see at a glance what the studio's unpaid time
   was before and after. */
const describeBreaks = (sched) => ((sched.breaks || []).length
  ? sched.breaks.map((b) => `${b.label} ${b.startLabel}–${b.endLabel}`).join(', ')
  : 'none');

router.put('/schedule', requirePermission('settings.working_hours'), async (req, res) => {
  const {
    hoursPerDay, workingDays, dayStart, dayEnd, lunchStart, lunchEnd,
    morningStart, morningEnd, eveningStart, eveningEnd,
  } = req.body || {};
  const before = workSchedule.current();
  /* WINDOWS WIN. Once the studio has named its recording windows, they are the
     schedule — Settings → Recording Hours owns when the clock runs, and this
     screen shows what those windows come to. So the window fields are ignored
     here rather than stored: accepting them would let a second screen write a
     day nothing reads, which is the disagreement the move to named windows
     exists to end. hoursPerDay is untouched by any of that. It is what a full
     day is EXPECTED to be, which the Idle Report divides by, and it is not a
     window. */
  /* WINDOWS WIN, BUT THIS STILL WORKS WHILE IT CAN SAY WHAT IT MEANS.
   *
   * Settings → Recording Hours owns when the clock runs. This endpoint is what
   * every existing caller uses, though — the Settings screen before this
   * release, the test suite, anything a studio wired up itself — so it keeps
   * working by WRITING THROUGH to the windows rather than to a second table
   * nothing reads. One source of truth, two doors into it.
   *
   * It stops being a door the moment the windows outgrow the four time pairs it
   * can hold: a second recording window, a night shift, a blackout on some days
   * and not others. Accepting the write then would throw all of that away
   * without saying so, which is worse than refusing it — so the window fields
   * are ignored and only hoursPerDay is taken. The screen says the same thing
   * in words, and the section it points at is where the change belongs.
   *
   * hoursPerDay is untouched by any of this. It is what a full day is EXPECTED
   * to be, which the Idle Report divides by, and it is not a window. */
  const canWriteThrough = !Array.isArray(before.entries) || recordingHours.isSimpleShape();
  const result = await workSchedule.save(db, canWriteThrough
    ? {
      hoursPerDay, workingDays, dayStart, dayEnd, lunchStart, lunchEnd,
      morningStart, morningEnd, eveningStart, eveningEnd,
    }
    : { hoursPerDay });
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  /* The windows follow the row that was just validated and saved, so the two
     cannot drift. Done after save() rather than instead of it: save() is where
     the studio's rules about a legal window live — the eight loggable hours, a
     break inside the day — and those still apply to anything written here. */
  if (canWriteThrough && Array.isArray(before.entries)) {
    await recordingHours.syncFromLegacy(db, workSchedule.rawWindow(), req.user.id);
  }
  const s = workSchedule.current();
  req.activity({
    module: 'settings', action: 'settings.working_hours', entityType: 'setting',
    entityLabel: 'Working Hours',
    summary: `Set the working day to ${s.dayStartLabel}–${s.dayEndLabel} ${s.timezone}, `
      + `${s.hoursPerDay}h, ${s.workingDayNames.join('/')}`,
    /* Every break, not lunch alone: all three now come off everybody's tracked
       hours, so a change to any of them changes what the studio's reports say
       people worked — which is exactly the kind of change this log exists for. */
    changes: activity.diff(
      { day: `${before.dayStartLabel}–${before.dayEndLabel}`,
        breaks: describeBreaks(before),
        hoursPerDay: before.hoursPerDay, workingDays: before.workingDayNames.join(', ') },
      { day: `${s.dayStartLabel}–${s.dayEndLabel}`,
        breaks: describeBreaks(s),
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
