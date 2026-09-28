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
const crypto = require('node:crypto');
const { asyncRouter } = require('../async-router');
const idempotency = require('../integration-idempotency');
const outbox = require('../integration-outbox');

const router = asyncRouter();

/* POST /api/integration/ping
 *
 * A POST rather than a GET, deliberately: the signature covers the body, so a
 * GET would exercise the empty-body path and prove less. It is also what makes
 * this endpoint visible in the Activity Log, which is where somebody checks
 * that an integration's writes are attributed to the integration. */
router.post('/ping', (req, res) => {
  /* It still needs an Idempotency-Key, like every other POST here, and that is
     not an oversight: generating one is the part of a signed-API integration
     most likely to be left until last, and the endpoint whose whole job is to
     be pointed at first is the right place to find out it is missing.

     But it changes nothing, so it does not open a transaction — and it says so,
     or the "changed something without going through withIdempotency" warning
     would fire on every ping. */
  idempotency.changesNothing(req);
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

/* POST /api/integration/counter — the idempotency probe.
 *
 * There is no real business endpoint on this API yet, and idempotency is not
 * something to take on trust until there is. What has to be observable is
 * whether the caller's work RAN, which a response cannot show: a replay and a
 * fresh execution return the same body, by design. So this counts executions.
 *
 * Two things move when the work runs, on purpose:
 *
 *   the counter    in memory, per process, so a test can see that fn was
 *                  entered — or that it was not
 *   an outbox row  written on the TRANSACTION, so a test can see that a
 *                  rolled-back attempt left nothing behind
 *
 * The second is what proves the atomicity claim rather than just the bookkeeping:
 * an idempotency row that rolls back while the business write commits would pass
 * a test that only counted rows in integration_requests.
 */
const counters = new Map();
const countOf = (name) => counters.get(name) || 0;

router.post('/counter', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  const name = String((req.body && req.body.counter) || 'probe');
  counters.set(name, countOf(name) + 1);

  /* Holds the claim open for a measured moment, so a test can land a second
     request while the first is genuinely mid-flight rather than hoping the
     scheduler interleaves them that way. Without this, "a duplicate arriving
     while the first is still running" is a race the test would sometimes lose and
     silently pass. Bounded well under the staleness window, or it would be testing
     takeover instead. */
  const hold = Math.min(Number((req.body && req.body.hold) || 0), 5000);
  if (hold > 0) await new Promise((done) => { setTimeout(done, hold); });

  /* A considered refusal, RETURNED rather than thrown. The difference matters:
     a thrown error rolls everything back, while a returned 4xx is the handler
     saying "this is my answer" — and either way it is not recorded, so the
     caller's corrected request is free to use the same key. Returned before the
     outbox write so the test for it has nothing to disentangle. */
  if (req.body && req.body.reject) {
    return { status: 409, body: { refused: name, count: countOf(name) } };
  }

  /* THE OUTBOX ROW, written on the transaction — which is the whole reason the
     outbox exists: the change and the intention to tell somebody about it commit
     together or neither does. Delivery happens later, in src/integration-outbox.js,
     and nothing about it can reach this request.

     The payload is the caller's if it supplied one, so a test has something real
     to watch being delivered and retried rather than having to fake a row. `outbox:
     false` writes none at all, for the case where what is under test is this
     request's own speed while a delivery is failing elsewhere. */
  const wants = req.body ? req.body.outbox : undefined;
  if (wants !== false) {
    await trx.query(
      'INSERT INTO integration_outbox (id, payload, `status`) VALUES ($1, $2, $3)',
      [
        crypto.randomUUID(),
        JSON.stringify(wants && typeof wants === 'object' ? wants : { probe: name, at: Date.now() }),
        'pending',
      ]
    );
  }

  /* An asked-for failure, AFTER both writes, which is the only ordering that
     tests what it claims to: failing before them would prove nothing about
     rollback, because there would be nothing to roll back. */
  if (req.body && req.body.fail) {
    const err = new Error('The counter probe was asked to fail after doing its work.');
    err.status = 500;
    throw err;
  }

  return { status: 200, body: { counter: name, count: countOf(name) } };
}));

/* GET /api/integration/counter — read it back without touching it.
 *
 * A GET, so no Idempotency-Key and no transaction: the count has to be readable
 * after a request that was rolled back, and a reader that needed a key of its
 * own would be one more thing to get wrong in the test that matters most.
 */
router.get('/counter', (req, res) => {
  const name = String(req.query.counter || 'probe');
  res.json({ counter: name, count: countOf(name) });
});

/* GET /api/integration/events?since=<seq> — the pull-based recovery path.
 *
 * The rows the outbox worker pushes, asked for instead. A push that never arrived
 * looks, from the far end, exactly like nothing having happened, so the receiver
 * needs to be able to come and check; this reads the same table the worker delivers
 * from, because two sources of truth for what happened is how a replay ends up
 * disagreeing with the original.
 *
 * NO SPECIAL-CASING for it being a read, and none needed. serviceAuth has no method
 * conditional in it: the signature covers t.METHOD.path.rawBody with GET as the
 * method and an empty body, the credential is looked up the same way, and the action
 * is the first path segment either way — so this requires "events" in the client's
 * allowed_actions by the same rule that makes /ping require "ping". The idempotency
 * middleware in front of it applies only to POST, PUT and DELETE, which is right:
 * repeating a read changes nothing, and demanding a key for one would be friction
 * for no gain. The master spec signs both directions without carving out reads, and
 * this endpoint is that spec needing no exception.
 *
 * THE QUERY STRING IS SIGNED, because the signature covers req.originalUrl rather
 * than the path alone — so `since` cannot be altered in flight. Worth knowing when
 * writing the client: sign the URL you actually request, query and all.
 */
router.get('/events', async (req, res) => {
  const db = require('../db');
  const raw = req.query.since;

  /* Absent means from the beginning. MALFORMED IS A 400, and deliberately not
     treated as zero: a client whose cursor arrived as "undefined" would otherwise
     be handed a full replay from the start of time and no indication that anything
     was wrong, which is a worse outcome than being told. */
  let since = 0;
  if (raw !== undefined && raw !== '') {
    since = Number(raw);
    if (!Number.isFinite(since) || since < 0) {
      return res.status(400).json({
        error: 'since must be a sequence number — the seq of the last event you received, or 0 to start.',
        field: 'since',
        received: String(raw),
      });
    }
  }

  const page = await outbox.eventsSince(db, { since, limit: req.query.limit });
  const highWater = await outbox.highWater(db);

  res.json({
    ...page,
    since,
    /* The newest seq that exists, so a caller can tell "caught up" from "one page
       behind" without another request. A since past this is not an error: it comes
       back empty, which is what being up to date looks like. */
    highWater,
    // Every status is included — a row we gave up pushing is the one most worth
    // being able to pull. See src/integration-outbox.js.
    statusesIncluded: Object.values(outbox.STATUS),
  });
});

module.exports = router;
