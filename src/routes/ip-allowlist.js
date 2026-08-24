const { asyncRouter } = require('../async-router');
const { authenticate, requireCapability } = require('../middleware/auth');
const allowlist = require('../ip-allowlist');
const ipMatch = require('../ip-match');
const gate = require('../middleware/ip-allowlist');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Managing which addresses may reach this application. Super Admin only, via
// the same manageSettings capability the rest of Settings uses — the check is a
// capability lookup rather than a role name compared by hand, so it keeps
// working as roles are added.
router.use(authenticate);
router.use(requireCapability('manageSettings'));

// Reading a request's address the same way the gate does, so what this screen
// reports is what the gate would judge.
function actorContext(req) {
  return { actor: req.user, actorIp: req.clientIp || gate.clientIP(req) };
}

// GET /api/ip-allowlist — the entries, the caller's own address, and how the
// gate is configured. The last part matters: someone editing this list needs to
// know whether it is being enforced at all.
router.get('/', async (req, res) => {
  const settings = gate.config();
  const myIp = req.clientIp || gate.clientIP(req);
  const entries = await allowlist.listAll(db);

  res.json({
    entries: entries.map((entry) => ({
      ...entry,
      // Flagged so the screen can warn before someone removes the entry that is
      // letting them in right now.
      coversYou: Boolean(entry.isActive && ipMatch.matches(myIp, entry.address)),
    })),
    yourAddress: myIp,
    // Would the gate let you in on the strength of the database alone? If you
    // are only here via an emergency address or the bypass token, that is worth
    // seeing before you start editing.
    yourAccess: (req.ipAllowlist && req.ipAllowlist.decision) || 'unknown',
    enforcement: {
      enabled: settings.enabled,
      mode: settings.mode,
      emergencyConfigured: settings.emergency.length > 0,
      bypassTokenConfigured: Boolean(settings.bypassToken),
      // An empty list is treated as "not configured", so say so plainly rather
      // than letting someone believe the app is restricted when it is not.
      effective: settings.enabled && settings.mode === 'enforce' && !allowlist.isEmpty(),
    },
  });
});

// GET /api/ip-allowlist/audit — who changed what, and when.
router.get('/audit', async (req, res) => {
  res.json({ entries: await allowlist.auditTrail(db, req.query.limit) });
});

router.post('/', async (req, res) => {
  const { address, label } = req.body || {};
  const result = await allowlist.create(db, { address, label }, actorContext(req));
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  return res.status(201).json({ entry: result.entry });
});

router.patch('/:id', async (req, res) => {
  const result = await allowlist.update(db, req.params.id, req.body || {}, actorContext(req));
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  return res.json({ entry: result.entry });
});

// DELETE /api/ip-allowlist/:id
//
// Removing the entry that covers your own address is the change most likely to
// lock someone out, so it is refused unless the caller says they mean it. The
// browser asks first; this is the backstop for anything that does not.
router.delete('/:id', async (req, res) => {
  const myIp = req.clientIp || gate.clientIP(req);
  const entries = await allowlist.listAll(db);
  const target = entries.find((e) => e.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'That entry does not exist.' });

  const confirmed = req.query.confirm === 'yes' || (req.body && req.body.confirm === true);
  const settings = gate.config();
  const enforcing = settings.enabled && settings.mode === 'enforce';

  if (!confirmed && enforcing && target.isActive && ipMatch.matches(myIp, target.address)) {
    // Would anything else still let them in?
    const others = entries.filter((e) => e.id !== target.id && e.isActive);
    const stillCovered = Boolean(ipMatch.findMatch(myIp, others));
    return res.status(409).json({
      error: stillCovered
        ? `${target.address} covers your own address (${myIp}), but another entry still does too. Confirm to remove it.`
        : `${target.address} is what is letting you in from ${myIp}. Removing it will lock you out of this application.`,
      requiresConfirmation: true,
      yourAddress: myIp,
      stillCoveredByAnother: stillCovered,
      lastEntry: entries.filter((e) => e.isActive).length === 1,
    });
  }

  const result = await allowlist.remove(db, req.params.id, actorContext(req));
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message });
  return res.json({
    ok: true,
    removed: result.removed,
    // Removing the last entry does not lock the door — an empty list is treated
    // as unconfigured — but whoever did it should know that is what happened.
    nowEmpty: result.nowEmpty,
    ...(result.nowEmpty
      ? { warning: 'That was the last entry, so the allowlist is now empty and every address can reach this app again.' }
      : {}),
  });
});

module.exports = router;
