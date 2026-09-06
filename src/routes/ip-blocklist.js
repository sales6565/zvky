const { asyncRouter } = require('../async-router');
const { authenticate, requirePermission } = require('../middleware/auth');
const blocklist = require('../ip-blocklist');
const allowlist = require('../ip-allowlist');
const ipMatch = require('../ip-match');
const gate = require('../middleware/ip-allowlist');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

// Addresses barred outright.
//
// Its own permission, and a narrower one than the allowlist beside it — see the
// note on settings.ip_blocklist in src/permission-catalog.js for why blocking
// is Super Admin only while allowing is not.
router.use(authenticate);
router.use(requirePermission('settings.ip_blocklist'));

function actorContext(req) {
  return { actor: req.user, actorIp: req.clientIp || gate.clientIP(req) };
}

function storageProblem(status) {
  if (status.state === 'missing-tables') {
    return {
      ...status,
      summary: 'The table this feature stores blocked addresses in does not exist, so nothing is being blocked.',
      cause: 'The startup migration that creates it did not run, or could not — most often because the database user is not allowed to create tables.',
      fix: 'Use Repair below. If that fails, ask your host to grant the database user CREATE privileges and restart the app.',
      repairable: true,
    };
  }
  return {
    ...status,
    summary: 'The blocked addresses could not be read, so nothing is being blocked.',
    cause: 'The database refused or could not answer the query. The exact reason is below and in the server log.',
    fix: 'Check the database connection and the permissions of the database user, then use Repair below.',
    repairable: true,
  };
}

/* GET /api/ip-blocklist
 *
 * The blocks, the caller's own address, and enough of the gate's state for the
 * screen to say something true. That last part matters more here than it looks:
 * a blocklist behaves the same in monitor and enforce mode, which is the
 * opposite of what somebody who has read the allowlist screen will assume, so
 * the screen has to be able to say so.
 */
router.get('/', async (req, res) => {
  const myIp = req.clientIp || gate.clientIP(req);
  const settings = gate.config();
  let entries = null;
  const status = blocklist.storageStatus();
  try {
    entries = await blocklist.listAll(db);
  } catch {
    return res.json({
      entries: null,
      yourAddress: myIp,
      storage: storageProblem(blocklist.storageStatus()),
      gate: gateSummary(settings),
    });
  }

  res.json({
    entries: entries.map((e) => ({
      ...e,
      // Marked rather than hidden: an entry covering the caller is the one they
      // most need to see, and it is how they discover a range block includes
      // them before they wonder why a colleague cannot sign in.
      coversYou: Boolean(myIp && ipMatch.matches(myIp, e.address)),
    })),
    yourAddress: myIp,
    storage: status.ok ? null : storageProblem(status),
    gate: gateSummary(settings),
  });
});

/* What the gate is doing, in the words this screen needs.
 *
 * `blocksApply` is the fact worth stating: it is true whenever the gate is on
 * at all, including in monitor mode, and that is the difference between the two
 * lists. */
function gateSummary(settings) {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    blocksApply: settings.enabled,
    note: settings.enabled
      ? (settings.mode === 'monitor'
        ? 'The allowlist is only monitoring, but blocks still apply — a blocked address is refused now.'
        : 'The allowlist is enforcing, and blocks are checked before it.')
      : 'The whole IP gate is switched off in the environment, so nothing here is being enforced.',
  };
}

/* POST /api/ip-blocklist — block an address.
 *
 * THE SELF-LOCKOUT REFUSAL. Blocking an address that covers your own is refused
 * outright, with no confirm-and-proceed. That is deliberately stricter than the
 * allowlist's equivalent guard, which offers a confirmation, and the difference
 * is the recovery path:
 *
 *   Removing your allowlist entry locks you out, but the list is still there
 *   and a colleague on another allowed address can put it back.
 *
 *   Blocking your own address locks you out of the screen that would unblock
 *   it, immediately, and the only way back is an environment variable on the
 *   server — which is exactly the situation the emergency hatches exist for and
 *   exactly the situation nobody should be able to walk into by pressing a
 *   button twice.
 *
 * And there is no legitimate use for it: an administrator who wants to stop
 * using an address takes it off the allowlist instead. Blocking a RANGE that
 * happens to include you is refused for the same reason and is the likelier
 * mistake of the two.
 */
router.post('/', async (req, res) => {
  const myIp = req.clientIp || gate.clientIP(req);
  const { address, label, reason, expiresAt } = req.body || {};

  const text = String(address ?? '').trim();
  if (text && ipMatch.isValidEntry(text) && myIp && ipMatch.matches(myIp, text)) {
    return res.status(409).json({
      error: `${ipMatch.normaliseEntry(text)} covers the address you are connecting from (${myIp}). `
        + 'Blocking it would lock you out of this application immediately, and out of the screen that '
        + 'would undo it. If you mean to stop using this address, remove it from the allowlist instead.',
      wouldLockYouOut: true,
      yourAddress: myIp,
    });
  }

  const result = await blocklist.create(db, { address, label, reason, expiresAt }, actorContext(req));
  if (!result.ok) {
    return res.status(result.status).json({ error: result.errors[0].message, errors: result.errors });
  }

  /* Enriched rather than left to the generic backstop, because the generic one
     would read "Created: ip-blocklist" — and the single most useful thing this
     log can answer later is which address, blocked by whom, and why. */
  req.activity({
    module: 'settings', action: 'ip.blocked', entityType: 'ip', entityId: result.entry.id,
    entityLabel: result.entry.address,
    summary: `Blocked ${result.entry.address}`
      + (result.entry.reason ? ` — ${result.entry.reason}` : '')
      + (result.entry.expiresAt ? ' (temporary)' : ''),
    changes: {
      address: { from: null, to: result.entry.address },
      ...(result.entry.expiresAt ? { expires: { from: null, to: String(result.entry.expiresAt) } } : {}),
      ...(result.entry.reason ? { reason: { from: null, to: result.entry.reason } } : {}),
    },
  });

  /* Said back, because it is the thing most likely to surprise: an address on
     the allowlist that has just been blocked is now refused, and whoever did it
     should not have to work that out from two screens. */
  const alsoAllowed = allowlist.isLoaded() ? allowlist.findMatch(result.entry.address) : null;
  return res.status(201).json({
    entry: result.entry,
    ...(alsoAllowed
      ? { note: `${result.entry.address} is also covered by the allowlist entry ${alsoAllowed.address}. The block wins — that address is refused from now on.` }
      : {}),
  });
});

// DELETE /api/ip-blocklist/:id — unblock.
//
// No confirmation. Unblocking cannot lock anybody out; the worst it does is let
// somebody in who should not be, which is visible, reversible and recorded.
router.delete('/:id', async (req, res) => {
  const result = await blocklist.remove(db, req.params.id, actorContext(req));
  if (!result.ok) {
    return res.status(result.status).json({ error: result.errors[0].message });
  }
  req.activity({
    module: 'settings', action: 'ip.unblocked', entityType: 'ip', entityId: req.params.id,
    entityLabel: result.removed.address,
    summary: `Unblocked ${result.removed.address}`,
    changes: { address: { from: result.removed.address, to: null } },
  });
  return res.json({ ok: true, removed: result.removed });
});

/* POST /api/ip-blocklist/repair — create the table and reload.
 *
 * The same escape hatch the allowlist screen has, for the same reason: the
 * likeliest cause of a missing table is a database user without CREATE at the
 * moment the migration ran, and asking somebody to redeploy for that is worse
 * than offering the button.
 */
router.post('/repair', async (req, res) => {
  const result = await blocklist.install(db);
  if (!result.ok) {
    return res.status(500).json({ error: 'The table could not be created.', storage: storageProblem(result) });
  }
  return res.json({ ok: true, storage: null });
});

module.exports = router;
