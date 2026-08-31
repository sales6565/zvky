const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const multer = require('multer');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const branding = require('../branding');

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

module.exports = router;
