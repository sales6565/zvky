const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const allowlist = require('../ip-allowlist');
const ipMatch = require('../ip-match');
const gate = require('../middleware/ip-allowlist');
const observations = require('../ip-observations');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Managing which addresses may reach this application.
//
// Gated on manageAccess rather than the manageSettings the rest of Settings
// uses, and that is the whole point of the capability existing: several roles
// now hold every other permission in the studio, and a wrong entry here does
// not misconfigure a dropdown — it locks everyone out of the application.
// Deliberately narrower than "full access".
router.use(authenticate);
router.use(requirePermission('settings.ip_allowlist'));

// Reading a request's address the same way the gate does, so what this screen
// reports is what the gate would judge.
function actorContext(req) {
  return { actor: req.user, actorIp: req.clientIp || gate.clientIP(req) };
}

// What is wrong with the storage, and what to do about it. Returned instead of
// a bare 500 because "a database error" tells a Super Admin nothing they can
// act on, and this is the screen where they would act.
function storageProblem(status) {
  if (status.state === 'missing-tables') {
    return {
      ...status,
      summary: 'The tables this feature stores its addresses in do not exist, so access is NOT being restricted by IP address.',
      cause: 'The startup migration that creates them did not run, or could not — most often because the database user is not allowed to create tables.',
      fix: 'Use Repair below. If that fails, ask your host to grant the database user CREATE privileges and restart the app, or run the two CREATE TABLE statements from sql/schema.sql by hand.',
      repairable: true,
    };
  }
  return {
    ...status,
    summary: 'The addresses this feature stores could not be read, so access is NOT being restricted by IP address.',
    cause: 'The database refused or could not answer the query. The exact reason is below and in the server log.',
    fix: 'Check the database connection and the permissions of the database user, then use Repair below.',
    repairable: true,
  };
}

// Try to put the storage right, then report what happened. Called on demand by
// the Super Admin rather than automatically on every request: a repair that
// retries itself endlessly against a database that is refusing it is how a
// small fault becomes a large one.
async function repair() {
  const before = allowlist.storageStatus();
  const result = await allowlist.install(db, []);
  return { attempted: true, wasState: before.state, ...result };
}

// Read the table, correcting what the module believes about its own storage.
//
// The recorded status can be wrong in both directions and neither can be
// trusted on its own: it says "ready" from a mirror loaded before the tables
// were dropped, and it says "missing" after somebody created them by hand. So
// the read is attempted and the outcome is what settles it.
async function readEntries() {
  try {
    const entries = await allowlist.listAll(db);
    // A successful read from a module that thought it was broken means the
    // fault has been fixed elsewhere; refresh the mirror the gate reads from.
    if (!allowlist.storageStatus().ok) await allowlist.load(db);
    return { entries, status: allowlist.storageStatus() };
  } catch (err) {
    // load() records why, and empties the mirror rather than leaving the gate
    // acting on a copy nobody can verify.
    await allowlist.load(db);
    return { entries: null, status: allowlist.storageStatus() };
  }
}

// GET /api/ip-allowlist — the entries, the caller's own address, and how the
// gate is configured. The last part matters: someone editing this list needs to
// know whether it is being enforced at all.
router.get('/', async (req, res) => {
  const settings = gate.config();
  const myIp = req.clientIp || gate.clientIP(req);

  // If the storage is not readable, say exactly that and why, rather than
  // letting the query throw into a generic database error. The screen stays
  // usable and the problem stays visible.
  const { entries: allEntries, status } = await readEntries();
  if (!status.ok || !allEntries) {
    return res.json({
      entries: [],
      yourAddress: myIp,
      yourAccess: (req.ipAllowlist && req.ipAllowlist.decision) || 'unknown',
      enforcement: {
        enabled: settings.enabled,
        mode: settings.mode,
        emergencyConfigured: settings.emergency.length > 0,
        bypassTokenConfigured: Boolean(settings.bypassToken),
        failClosed: gate.failClosedIsSafe(settings),
        effective: false,
      },
      storage: storageProblem(status),
    });
  }

  const entries = allEntries;

  res.json({
    storage: { ...status, ok: true },
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
      failClosed: gate.failClosedIsSafe(settings),
      // An empty list is treated as "not configured", so say so plainly rather
      // than letting someone believe the app is restricted when it is not.
      effective: settings.enabled && settings.mode === 'enforce' && !allowlist.isEmpty(),
    },
  });
});

// POST /api/ip-allowlist/repair — create the missing tables and reload.
//
// The same work startup does, on demand. It exists because startup is the one
// moment a Super Admin cannot retry: if the tables were not created then, the
// only remedies were a redeploy or database access, neither of which the person
// looking at this screen necessarily has.
router.post('/repair', async (req, res) => {
  const result = await repair();
  if (!result.ok) {
    return res.status(503).json({
      error: result.state === 'missing-tables'
        ? 'The tables still could not be created. The database user is most likely not allowed to create tables.'
        : 'The allowlist storage still could not be read.',
      storage: storageProblem(allowlist.storageStatus()),
    });
  }
  await allowlist.record(db, {
    action: 'repaired',
    actor: req.user,
    actorIp: req.clientIp || gate.clientIP(req),
    detail: `storage was ${result.wasState}`,
  }).catch(() => {}); // the repair is what matters; a missing audit row is not worth failing it
  res.json({ ok: true, storage: allowlist.storageStatus(), entries: await allowlist.listAll(db) });
});

// GET /api/ip-allowlist/observed — the addresses this server has judged.
//
// The question a monitor-mode rollout has to answer before enforcement goes on:
// who would this have refused? Reading that out of the server log means
// scrolling a stream and hoping nothing important scrolled past. This is the
// same information, aggregated, with the caller's own address marked.
router.get('/observed', async (req, res) => {
  const myIp = req.clientIp || gate.clientIP(req);
  const settings = gate.config();
  const summary = observations.summary();

  const mark = (entry) => ({
    ...entry,
    isYou: entry.address === myIp,
    // Whether an entry on the list already covers it — so an address that was
    // refused earlier but has since been allowed does not read as a problem.
    coveredNow: Boolean(allowlist.findMatch(entry.address)),
  });

  res.json({
    mode: settings.mode,
    enforcing: settings.enabled && settings.mode === 'enforce',
    yourAddress: myIp,
    since: summary.since,
    scope: summary.scope,
    truncated: summary.truncated,
    limit: summary.limit,
    // The two lists a rollout is read from.
    wouldBeRefused: summary.refused.map(mark),
    reaching: summary.allowed.map(mark),
    // Safe to enforce only when nothing still-uncovered would be turned away.
    unresolved: summary.refused.filter((e) => !allowlist.findMatch(e.address)).length,
  });
});

// GET /api/ip-allowlist/audit — who changed what, and when.
router.get('/audit', async (req, res) => {
  // An unreadable trail is not worth a 500 on a screen whose job is to explain
  // that the storage is unreadable.
  try {
    res.json({ entries: await allowlist.auditTrail(db, req.query.limit) });
  } catch (err) {
    await allowlist.load(db);
    res.json({ entries: [], unavailable: true, detail: err.sqlMessage || err.message });
  }
});

router.post('/', async (req, res) => {
  const { address, label } = req.body || {};
  const result = await allowlist.create(db, { address, label }, actorContext(req));
  if (!result.ok) return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  // It has been dealt with, so drop it from the observed list rather than
  // leaving a warning about an address that is now allowed.
  if (result.entry) observations.forget(result.entry.address);
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
  const { entries, status } = await readEntries();
  if (!entries) {
    return res.status(503).json({
      error: 'The allowlist storage cannot be read, so nothing can be removed from it.',
      storage: storageProblem(status),
    });
  }
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
