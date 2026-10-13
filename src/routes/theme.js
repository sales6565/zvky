const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const theme = require('../theme');
const tokens = require('../theme-tokens');
const delivery = require('../theme-delivery');
const activity = require('../activity');
const db = require('../db');

const router = asyncRouter();

/* THE STUDIO'S COLOURS.
 *
 * READING IS UNAUTHENTICATED. The sign-in screen wears the studio's theme, and
 * that screen is by definition reached without a token — the same reasoning
 * GET /api/branding already runs on. Nothing here is a secret: it is the colour
 * of the page every visitor is looking at.
 *
 * WRITING IS report-free and settings-gated: requirePermission('settings.theme')
 * on every one of the five write routes, and the page gates the section on the
 * same key through can(). Never on the role's tier — see the note on UI_GATES in
 * public/index.html for the three times that confusion has shipped.
 */

/* GET /api/theme — the validated token values and the version, and NOTHING ELSE.
 *
 * Deliberately not "the theme settings": no history, no presets, no who-changed-
 * it, no other setting that happens to live nearby. This endpoint is reachable
 * without a session, so what it returns is the smallest thing that answers the
 * question "what colour is this application".
 */
router.get('/', async (req, res) => {
  if (!theme.isLoaded()) await theme.load(db).catch(() => {});
  const saved = theme.current();
  const etag = `W/"theme-${saved.version}"`;
  /* REVALIDATED RATHER THAN HELD. A theme changes a few times in the life of a
     deployment and has to arrive within one poll when it does, so a long
     max-age would be wrong; an ETag keyed on the version makes the common case
     a 304 with no body. */
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json({ version: saved.version, values: saved.values });
});

/* GET /api/theme.css — the same thing as a stylesheet.
 *
 * Not used by the page, which gets its theme injected into the HTML before the
 * first paint (see src/theme-delivery.js). It exists for anything that embeds a
 * screen of this application in a frame or a native shell and cannot have HTML
 * rewritten for it, and because a stylesheet with an ETag is the cheapest thing
 * a cache understands.
 */
/* MOUNTED SEPARATELY in src/server.js, at /api/theme.css.
 *
 * Not as a route on this router, which was the first attempt and does not work:
 * app.use('/api/theme', router) matches on whole path SEGMENTS, so
 * /api/theme.css never reaches the router at all and fell through to the SPA
 * catch-all — which answers with the page, at status 200. Caught by the smoke
 * test rather than by reading, which is the only way that kind of mistake
 * surfaces. */
async function cssHandler(req, res) {
  if (!theme.isLoaded()) await theme.load(db).catch(() => {});
  const etag = `W/"theme-css-${theme.version()}"`;
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.send(theme.currentCss());
}

// Everything below changes it, or reads something only an editor needs.
router.use(authenticate);

/* THE SIZE CAP, before the body is looked at. express.json has already parsed
   it, so this is a cap on what was parsed rather than on what was read — the
   body parser's own limit is the first line of defence and this is the one that
   names the theme. */
function tooBig(req, res) {
  const size = Buffer.byteLength(JSON.stringify(req.body || {}));
  if (size <= tokens.MAX_BODY_BYTES) return false;
  res.status(400).json({
    error: `That theme is ${size} bytes; the limit is ${tokens.MAX_BODY_BYTES}. `
      + 'A theme is a hundred or so colours, so something else has been sent.',
  });
  return true;
}

/* GET /api/theme/editor — everything the Theme section needs, in one request.
 *
 * The catalogue, the saved values, the contrast figures, the history and the
 * presets. One round trip because the section draws all of it at once, and the
 * catalogue is what makes the UI build itself: a token added to
 * src/theme-tokens.js appears here and therefore in Settings, with no change to
 * the page.
 */
router.get('/editor', requirePermission('settings.theme'), async (req, res) => {
  if (!theme.isLoaded()) await theme.load(db).catch(() => {});
  const saved = theme.current();
  res.json({
    groups: tokens.GROUPS,
    /* `css` IS SENT, and it is the one implementation detail that has to cross
       the wire. The editor previews unsaved colours by writing a :root block in
       the browser, and it cannot do that without knowing which custom property
       each token writes — the names are the ones the stylesheet already used
       (surface.page is --bg), so they are not derivable from the key. */
    tokens: theme.all().map((tok) => ({
      key: tok.key, css: tok.css, label: tok.label, group: tok.group,
      default: tok.default, describe: tok.describe, alpha: Boolean(tok.alpha),
    })),
    values: saved.values,
    version: saved.version,
    updatedAt: saved.updatedAt,
    contrast: theme.ratios(saved.values),
    focusRing: theme.focusRingWarnings(saved.values),
    /* WHICH PAIRS ARE ALREADY BELOW 3:1 WITH NOTHING SAVED. The shipped palette
       has three, and the editor needs to tell "you made this unreadable" apart
       from "this always was" — otherwise every save demands a confirmation for
       something the admin did not do, which is how people learn to click
       through confirmations. */
    severeByDefault: theme.warningsFor({}).filter((w) => w.severe).map((w) => w.label),
    history: await theme.history(db),
    presets: await theme.presets(db),
    limits: {
      maxPresets: tokens.MAX_PRESETS,
      historyLimit: tokens.HISTORY_LIMIT,
      maxBodyBytes: tokens.MAX_BODY_BYTES,
    },
  });
});

/* PUT /api/theme — save it.
 *
 * `confirmLowContrast` is the editor's answer to the below-3:1 question. The
 * server REPORTS the ratios either way and refuses only when the save would
 * introduce a severe pair the defaults do not already have and the confirmation
 * is absent — so the figures never depend on the browser having computed them,
 * which is the point of computing them here.
 */
router.put('/', requirePermission('settings.theme'), async (req, res) => {
  if (tooBig(req, res)) return undefined;
  const body = req.body || {};
  const wanted = body.values === undefined ? body : body.values;

  const checked = theme.validate(wanted);
  if (!checked.ok) {
    return res.status(checked.status || 400).json({ errors: checked.errors, error: checked.errors[0].message });
  }

  const already = new Set(theme.warningsFor({}).filter((w) => w.severe).map((w) => w.label));
  const introduced = theme.warningsFor(checked.values)
    .filter((w) => w.severe && !already.has(w.label));
  if (introduced.length && body.confirmLowContrast !== true) {
    return res.status(409).json({
      error: `${introduced.length} pair${introduced.length === 1 ? '' : 's'} would be below 3:1, `
        + 'which is unreadable for everybody and not only for people with low vision. '
        + 'Saving it is recommended against; confirm to do it anyway.',
      requiresConfirmation: true,
      severe: introduced,
    });
  }

  const result = await theme.save(db, checked.values, req.user);
  if (!result.ok) {
    return res.status(result.status || 400).json({ errors: result.errors, error: result.errors[0].message });
  }
  delivery.forget();

  /* THE AUDIT LINE, in the shape every other settings change uses: who, when,
     and old-to-new for each colour that moved. The colours themselves, not a
     count — the whole value of this entry is being able to read what yesterday's
     red was after somebody has changed it. */
  if (result.changed.length) {
    req.activity({
      module: 'settings', action: 'theme.updated',
      entityType: 'setting', entityId: 'studio_theme', entityLabel: 'Theme',
      summary: `Changed ${result.changed.length} colour${result.changed.length === 1 ? '' : 's'} `
        + `(version ${result.version})`,
      changes: Object.fromEntries(result.changed.map((c) => [c.token, { from: c.from, to: c.to }])),
    });
  }
  return res.json(result);
});

/* POST /api/theme/revert — go back to a saved version.
 *
 * REACHABLE EVEN IF THE SCREEN IS UNREADABLE, which is the reason it exists: a
 * theme that made the text the same colour as the page is a theme the admin
 * cannot read their way out of. The Theme section's own controls are drawn on a
 * fixed palette that ignores the theme (see .theme-safe in public/index.html),
 * so this button is legible whatever has been saved.
 */
router.post('/revert', requirePermission('settings.theme'), async (req, res) => {
  const result = await theme.revert(db, (req.body || {}).version, req.user);
  if (!result.ok) {
    return res.status(result.status || 400).json({ errors: result.errors, error: result.errors[0].message });
  }
  delivery.forget();
  req.activity({
    module: 'settings', action: 'theme.reverted',
    entityType: 'setting', entityId: 'studio_theme', entityLabel: 'Theme',
    summary: `Reverted the theme to version ${(req.body || {}).version} `
      + `(saved as version ${result.version})`,
    changes: Object.fromEntries(result.changed.map((c) => [c.token, { from: c.from, to: c.to }])),
  });
  return res.json(result);
});

/* POST /api/theme/presets — save the values under a name.
 * DELETE /api/theme/presets/:id — and remove one.
 *
 * A preset is a theme, so it goes through theme.validate() and not a second,
 * looser rule. Applying one is an ordinary PUT from the editor.
 */
router.post('/presets', requirePermission('settings.theme'), async (req, res) => {
  if (tooBig(req, res)) return undefined;
  const result = await theme.savePreset(db, req.body || {}, req.user);
  if (!result.ok) {
    return res.status(result.status || 400).json({ errors: result.errors, error: result.errors[0].message });
  }
  req.activity({
    module: 'settings', action: 'theme.preset_saved',
    entityType: 'setting', entityId: 'studio_theme_presets', entityLabel: result.name,
    summary: `${result.replaced ? 'Replaced' : 'Saved'} the theme preset "${result.name}"`,
  });
  return res.status(result.replaced ? 200 : 201).json(result);
});

router.delete('/presets/:id', requirePermission('settings.theme'), async (req, res) => {
  const result = await theme.deletePreset(db, req.params.id);
  if (!result.ok) {
    return res.status(result.status || 400).json({ errors: result.errors, error: result.errors[0].message });
  }
  req.activity({
    module: 'settings', action: 'theme.preset_deleted',
    entityType: 'setting', entityId: 'studio_theme_presets', entityLabel: req.params.id,
    summary: 'Deleted a theme preset',
  });
  return res.json(result);
});

/* POST /api/theme/contrast — the ratios for values that have not been saved.
 *
 * SO THE CHECK NEVER RESTS ON THE BROWSER ALONE. The editor computes the same
 * figures as you type, because a round trip per keystroke would be absurd; this
 * is what the Save button's warning is actually drawn from, and what a test can
 * assert without a DOM. Read-only, and still behind the permission: it is an
 * editor endpoint.
 */
router.post('/contrast', requirePermission('settings.theme'), async (req, res) => {
  if (tooBig(req, res)) return undefined;
  const body = req.body || {};
  const checked = theme.validate(body.values === undefined ? body : body.values);
  if (!checked.ok) {
    return res.status(checked.status || 400).json({ errors: checked.errors, error: checked.errors[0].message });
  }
  const merged = { ...theme.current().values, ...checked.values };
  return res.json({
    contrast: theme.ratios(merged),
    focusRing: theme.focusRingWarnings(merged),
    warnings: theme.warningsFor(merged),
  });
});

void activity;
module.exports = router;
module.exports.cssHandler = cssHandler;
