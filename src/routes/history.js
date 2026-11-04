/* THE MY HISTORY TAB. ONE ENDPOINT.
 *
 * ===========================================================================
 * GET /api/history?from&to&days&userId
 *
 * ONE ENDPOINT AND NOT SEVERAL, which is the brief's instruction and worth the
 * sentence: a card carries recorded time, the day's status, the day's events and
 * the day's timesheet, and assembling those in the browser would mean four
 * requests per screen, four chances for one of them to fail, and four places the
 * page could start deciding things. It gets one payload and draws it.
 *
 * TWO KEYS:
 *   history.view          your own. Implied by timesheet.own, so every role that
 *                         can fill a timesheet today can read its own history
 *                         today — nothing changes for anybody on deploy.
 *   history.view_others   somebody else's, Super Admin by default.
 *
 * AND THE SCOPE IS NEITHER KEY'S. readableUserIds() decides whose history may be
 * read, which is the same union the Time Sheet tab and the export use. Holding
 * history.view_others adds a selector; it does not add people to it.
 *
 * THE SWITCH IS CHECKED ON THE SERVER. With the tab off the page hides it; this
 * is what makes that a rule rather than a decoration, and it answers 409
 * feature_disabled exactly as every other switched-off feature in this
 * application does.
 */
const express = require('express');

const { asyncRouter } = require('../async-router');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const history = require('../history');
const historySettings = require('../history-settings');
const { readableUserIds } = require('../timesheet-visibility');
const permissions = require('../permissions');

const router = asyncRouter(express.Router());

router.use(authenticate);

/* GET /api/history — the cards. */
router.get('/', requirePermission('history.view'), async (req, res) => {
  if (!historySettings.enabled()) {
    return res.status(409).json({
      error: 'The My History tab is switched off in Settings.',
      code: 'feature_disabled',
    });
  }

  const asked = String((req.query && req.query.userId) || '') || null;
  const mine = !asked || asked === req.user.id;

  if (!mine) {
    /* SOMEBODY ELSE'S NEEDS THE KEY *AND* THE SCOPE, and the two refusals are
       deliberately the same shape: a narrow holder must not be able to tell
       "that person exists but is not yours" from "you may not do this at all",
       because the difference is itself a disclosure. */
    if (!permissions.holds(req.user, 'history.view_others')) {
      return res.status(403).json({
        error: 'You can only read your own history.',
        code: 'not_yours',
      });
    }
    const allowed = await readableUserIds(req.user);
    if (!allowed.includes(asked)) {
      return res.status(403).json({
        error: 'That is not somebody whose history you can see.',
        code: 'out_of_scope',
      });
    }
  }

  const built = await history.build(db, {
    viewer: req.user,
    userId: asked || req.user.id,
    from: (req.query && req.query.from) || null,
    to: (req.query && req.query.to) || null,
    days: (req.query && req.query.days) || null,
  });
  if (!built.ok) {
    return res.status(built.status || 400).json({ error: built.error });
  }
  return res.json(built);
});

/* GET /api/history/people — who the selector may offer.
 *
 * ITS OWN ROUTE rather than a field on the payload above, because the tab draws
 * the selector before it knows which person to ask about, and because a reader
 * without history.view_others must never receive a list of names at all: the
 * route answers with just themselves, which is the honest answer and not a
 * filtered version of a longer one.
 *
 * THE SAME LIST THE TIME SHEET TAB OFFERS, from the same function, so the two
 * selectors cannot disagree about who somebody may look at.
 */
router.get('/people', requirePermission('history.view'), async (req, res) => {
  if (!historySettings.enabled()) {
    return res.status(409).json({ error: 'The My History tab is switched off in Settings.',
      code: 'feature_disabled' });
  }
  if (!permissions.holds(req.user, 'history.view_others')) {
    return res.json({ users: [{ id: req.user.id, name: req.user.name || 'You' }], scope: 'own' });
  }
  const ids = await readableUserIds(req.user);
  if (!ids.length) return res.json({ users: [], scope: 'own' });
  const { rows } = await db.query(
    `SELECT id, \`name\`, email, \`role\` FROM users WHERE id IN ($1) ORDER BY \`name\``, [ids]
  );
  return res.json({
    users: rows,
    scope: permissions.holds(req.user, 'timesheet.all') ? 'all'
      : (permissions.holds(req.user, 'timesheet.team') ? 'team' : 'own'),
  });
});

module.exports = router;
