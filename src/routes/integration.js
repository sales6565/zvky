/* The Dev & QA integration API.
 *
 * WHAT IS HERE SO FAR is one endpoint, and it is the one an integration needs
 * first: a call that proves the whole chain — address, signature, credential
 * and allowed action — without changing anything. Setting up a signed API
 * against a live endpoint means debugging four things at once; this is the
 * thing to point at until it answers 200.
 *
 * Everything in front of it is mounted in server.js and applies to every route
 * added below later:
 *
 *   integrationIpGate   its own address list, in monitor mode by default
 *   integrationLimiter  the same rate limiter the two auth routes use
 *   serviceAuth         signature, credential, allowed action
 *
 * req.integration is what those leave behind. There is no req.user and no
 * req.permissions on this path, on purpose — see src/middleware/service-auth.js.
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();

/* POST /api/integration/ping
 *
 * A POST rather than a GET, deliberately: the signature covers the body, so a
 * GET would exercise the empty-body path and prove less. It is also what makes
 * this endpoint visible in the Activity Log, which is where somebody checks
 * that an integration's writes are attributed to the integration. */
router.post('/ping', (req, res) => {
  res.json({
    ok: true,
    client: req.integration.name,
    action: req.integration.action,
    allowedActions: req.integration.allowedActions,
    // What the address gate made of this caller. In monitor mode a
    // 'would-deny' here is the line somebody is waiting for before switching
    // the list to enforce.
    address: req.integrationIp || null,
    echo: req.body && typeof req.body === 'object' ? req.body : null,
  });
});

module.exports = router;
