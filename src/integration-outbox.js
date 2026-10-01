/* The outbox worker: what this application owes the outside world, delivered.
 *
 * A row is written by whatever caused it, inside that change's own transaction —
 * so the fact and the intention to tell somebody about it commit together, or
 * neither does. Delivery happens afterwards, here, on a timer. That separation is
 * the entire point: an HTTP call to somebody else's server cannot be part of a
 * database transaction, and pretending otherwise means either a request that hangs
 * because a third party is slow, or a change that rolls back because they are
 * down.
 *
 * NOTHING HERE CAN REACH THE REQUEST THAT WROTE THE ROW. The writer's only
 * involvement is an INSERT. It does not wait for delivery, learn whether it
 * succeeded, or slow down when the target is unreachable — there is no code path
 * from a delivery attempt back to it. tests/integration-outbox.test.js asserts
 * that against a target that accepts connections and never answers, which is the
 * shape that would actually hurt: a refused connection fails fast, a black hole
 * holds the socket for the full timeout.
 *
 * WHY THIS ONE CLAIMS ITS ROWS, when the chat attachment sweep does not.
 *
 * This deployment runs several Node workers against one database — Passenger and
 * most cPanel setups do, which is what the studio deploys on, and the README says
 * so. src/chat-files.js is safe under that without any claim, but the reason does
 * not carry over: its work is deleting a file, and a file another worker already
 * deleted raises ENOENT, which is the outcome it wanted anyway. Idempotent work
 * needs no claim.
 *
 * Delivering a webhook is not idempotent. Two workers picking up the same due row
 * send the same POST twice, and the receiver is a different system whose
 * deduplication is not ours to assume. So a row is claimed before it is sent, by
 * the same conditional-UPDATE mechanism the inbound side uses in
 * src/integration-idempotency.js: whoever the row matches for first has already
 * changed it by the time the other's WHERE is evaluated. Same problem, same shape,
 * opposite direction.
 */
const crypto = require('node:crypto');

const OUTBOUND_SECRET_VAR = 'INTEGRATION_OUTBOUND_SECRET';
const INBOUND_SECRET_VAR = 'INTEGRATION_INBOUND_SECRET';

/* THE RETRY SCHEDULE, as specified: 1 minute, 5 minutes, 30 minutes, 2 hours,
 * 6 hours, 24 hours, and then the row is failed rather than retried forever.
 *
 * Seven attempts in all — the first, plus these six — spanning a little over a
 * day. That span is the point: a receiver down for an afternoon is covered
 * without anybody intervening, and one down for a week is a thing somebody has to
 * know about rather than something this quietly keeps hammering.
 *
 * Written as the delays themselves rather than as a formula. A doubling with
 * jitter would be fewer characters and would not be this schedule, and this
 * schedule is what the other side has been told to expect.
 */
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 86400];

const STATUS = {
  pending: 'pending',   // waiting to be sent, or waiting out a backoff
  sending: 'sending',   // claimed by a worker, in flight
  sent: 'sent',         // delivered, and the receiver said so
  failed: 'failed',     // out of attempts, or refused in a way retrying cannot fix
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function config() {
  return {
    url: process.env.INTEGRATION_OUTBOUND_URL || null,
    // Read the way the inbound side is (src/integration-secrets.js): surrounding
    // whitespace ignored; a quoted or broken value counts as not set.
    secret: require('./integration-secrets').read(OUTBOUND_SECRET_VAR).value,
    // 10 seconds, the same deadline src/push-notifications.js holds APNs to. A
    // delivery that has not answered in ten seconds is not about to.
    timeoutMs: num(process.env.INTEGRATION_OUTBOUND_TIMEOUT_MS, 10_000),
    sweepSeconds: num(process.env.INTEGRATION_OUTBOX_SWEEP_SECONDS, 60),
    batch: num(process.env.INTEGRATION_OUTBOX_BATCH, 20),
    /* How long a claim is believed, for the same reason as the inbound side: a
       worker killed mid-delivery leaves a row marked sending that nothing will
       ever finish, and without a way out that row is stuck forever. Two minutes
       is comfortably more than the ten-second delivery deadline, so a claim this
       old is wreckage rather than slow. */
    claimSeconds: num(process.env.INTEGRATION_OUTBOX_CLAIM_SECONDS, 120),
  };
}

const ready = (c) => Boolean(c.url && c.secret);

/* The two directions must not share a secret, and this refuses rather than warns.
 *
 * One secret for both directions means anybody who can VERIFY a message can also
 * FORGE one, which removes the only thing a signature proves. That is not a
 * misconfiguration to log and carry on from: delivering signed messages under a
 * secret the other party can sign with is worse than not delivering them, because
 * it looks like it is working. */
function secretsCollide() {
  const read = require('./integration-secrets').read;
  const out = read(OUTBOUND_SECRET_VAR).value;
  const inb = read(INBOUND_SECRET_VAR).value;
  return Boolean(out && inb && out === inb);
}

/* The signature, deliberately the same construction the inbound side verifies:
 * t=<unix seconds>, v1=<hex HMAC-SHA256 of "t.METHOD.path.rawBody">. One shape for
 * both directions means the other end implements one verifier rather than two, and
 * a mistake in either is a mistake in something already reasoned about. Different
 * key, same envelope. */
const signingPayload = (t, method, path, rawBody) =>
  `${t}.${String(method).toUpperCase()}.${path}.${rawBody}`;

function sign(secret, { t, method = 'POST', path, body }) {
  const v1 = crypto.createHmac('sha256', secret)
    .update(signingPayload(t, method, path, body)).digest('hex');
  return `t=${t}, v1=${v1}`;
}

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
};

/* One delivery. Returns a small string rather than throwing, the same vocabulary
 * src/push-notifications.js uses for the same reason: the caller's next move is a
 * database write either way, and an exception here would only be somewhere else to
 * handle it.
 *
 *   sent      the receiver answered 2xx
 *   retry     anything else worth trying again — 5xx, a timeout, a dead socket
 *   rejected  the receiver said the message itself is wrong (4xx other than 429),
 *             which retrying cannot fix. Sending it another six times would be
 *             noise on their end and a row that fails a day later instead of now.
 */
async function deliver(c, row, { fetchImpl = fetch } = {}) {
  const t = Math.floor(Date.now() / 1000);
  /* A row written through src/integration-events.js is sent as its envelope with its
     sequence filled in. Anything older (and the test probe's rows) goes as it was
     written, so a receiver built against those sees no change. */
  let body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const envelope = require('./integration-events').envelopeOf(row);
  if (envelope.schemaVersion >= 1) body = JSON.stringify(envelope);
  const controller = new AbortController();
  /* An explicit deadline. fetch has none of its own — a hung socket would hold
     this row's claim until the process restarted, which is the failure the claim
     staleness exists to clean up and there is no reason to rely on that here. */
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);

  try {
    const res = await fetchImpl(c.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Signature': sign(c.secret, { t, path: pathOf(c.url), body }),
        /* The row's identity, so the receiver can recognise our retries as
           retries. We cannot assume they deduplicate, but we can make it possible:
           every attempt at this row carries the same delivery id, and the attempt
           number says which try it is. */
        'X-Integration-Delivery': String(row.id),
        'X-Integration-Event-Type': String(envelope.type || ''),
        'X-Integration-Attempt': String(row.attempts),
      },
      body,
      // A redirect is an answer, not an instruction to post our signed body elsewhere.
      redirect: 'manual',
      signal: controller.signal,
    });

    if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status };
    if (res.status === 429 || res.status >= 500) {
      return { outcome: 'retry', status: res.status, error: `the receiver answered ${res.status}` };
    }
    const detail = await res.text().catch(() => '');
    return {
      outcome: 'rejected',
      status: res.status,
      error: `the receiver refused it (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return {
      outcome: 'retry',
      status: 0,
      error: aborted ? `no answer within ${c.timeoutMs}ms` : `could not reach it: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* What happens to a row after an attempt. Pure, so the schedule can be tested
 * without a database or a network — the schedule is the part most worth being sure
 * about, and it is the part hardest to observe through six hours of waiting.
 *
 * `attempts` is the count INCLUDING the attempt just made, because it is
 * incremented when the row is claimed rather than when the outcome is known. That
 * ordering is deliberate: a worker killed mid-delivery has still used an attempt,
 * and counting only completed attempts would let a row that crashes the process
 * every time be retried forever.
 */
function nextState(attempts, outcome) {
  if (outcome === 'sent') return { status: STATUS.sent, delaySeconds: null };
  if (outcome === 'rejected') return { status: STATUS.failed, delaySeconds: null };
  const delay = BACKOFF_SECONDS[Number(attempts) - 1];
  if (delay === undefined) return { status: STATUS.failed, delaySeconds: null, exhausted: true };
  return { status: STATUS.pending, delaySeconds: delay };
}

/* The rows that are due: pending, their backoff elapsed, oldest first. seq rather
 * than created_at for the ordering — two rows written in the same second have no
 * order between them by DATETIME, and an outbox exists to preserve order.
 *
 * The backoff condition is HERE AS WELL AS in claim() below, and both belong: this
 * one keeps the LIMIT spent on rows that are actually deliverable rather than on
 * rows waiting out six hours, and claim()'s is the authority, because this answer
 * is already out of date by the time it is acted on. Removing either alone changes
 * no behaviour, which a mutation test duly reports; removing both delivers rows
 * before they are due. */
async function due(db, c) {
  const { rows } = await db.query(
    `SELECT id, seq, payload, attempts
       FROM integration_outbox
      WHERE \`status\` = $1 AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY seq
      LIMIT ${Number(c.batch)}`,
    [STATUS.pending]
  );
  return rows;
}

/* THE PULL SIDE: the same rows, asked for rather than pushed.
 *
 * A push that never arrived is indistinguishable, from the far end, from nothing
 * having happened — so the receiver needs a way to ask. This is that way, and it
 * reads the same table the worker delivers from, because two sources of truth for
 * "what happened" is how a replay ends up disagreeing with the original.
 *
 * EVERY ROW, WHATEVER ITS STATUS. A row we gave up pushing is precisely the one
 * most worth being able to pull: if a permanently failed delivery also made the
 * data unreachable by replay, the failure would be doubled rather than recovered
 * from. Deduplication is the caller's, by the last seq they have seen — which is
 * their design, and is why status has no bearing on what is returned.
 *
 * The page shape is the one src/chat.js already uses for exactly this — a seq
 * cursor, ascending, with hasMore — rather than a new one. PAGE_MAX matches
 * activity.js and chat-oversight.js at 200; no more generous than those, because
 * an outbox payload is MEDIUMTEXT and so a row here can be larger than a chat
 * message. A caller further behind than one page walks forward with lastSeq.
 */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

// The newest sequence that exists, or 0. Lets a caller see how far behind it is
// without walking the whole way there first.
async function highWater(db) {
  const { rows } = await db.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM integration_outbox');
  return Number(rows[0].seq) || 0;
}

const shapeEvent = (row) => {
  let payload;
  /* Stored as text and given back as JSON. A row that somehow holds something
     unparseable is handed over as the string it is rather than failing the whole
     page — one bad row must not make every row after it unreachable. */
  try { payload = JSON.parse(row.payload); } catch { payload = { unparsed: String(row.payload) }; }
  return {
    seq: Number(row.seq),
    id: row.id,
    payload,
    // The same row in the one event envelope; see src/integration-events.js.
    envelope: require('./integration-events').envelopeOf(row),
    // What became of OUR attempt to push it. The caller does not need this to
    // process the event; it is here so a receiver comparing notes can see that a
    // row it never received was one we failed to deliver rather than one we held.
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error || null,
    createdAt: row.created_at,
  };
};

async function eventsSince(db, { since = 0, limit = PAGE_DEFAULT } = {}) {
  const from = Number(since);
  const n = Math.min(Math.max(Number(limit) || PAGE_DEFAULT, 1), PAGE_MAX);

  const { rows } = await db.query(
    `SELECT id, seq, payload, \`status\`, attempts, last_error, created_at
       FROM integration_outbox
      WHERE seq > $1
      ORDER BY seq ASC
      LIMIT ${n}`,
    [Number.isFinite(from) ? from : 0]
  );

  const events = rows.map(shapeEvent);
  return {
    events,
    limit: n,
    /* A full page is the only case where there might be more, so this costs
       nothing when there is not — the same reasoning chat.js gives for it. */
    hasMore: rows.length === n,
    // What to send as `since` next time. The cursor the caller was already on when
    // the page is empty, so a caught-up caller can keep asking with the same value.
    lastSeq: events.length ? events[events.length - 1].seq : (Number.isFinite(from) ? from : 0),
  };
}

/* Claiming one row, so two workers cannot both deliver it.
 *
 * The WHERE re-checks everything the SELECT matched on, because the SELECT's
 * answer is already out of date by the time this runs — another worker may have
 * taken this row in between. affectedRows is 1 exactly for the worker that won:
 * status moves from pending to sending, so the row genuinely changes, and MySQL
 * reports changed rows rather than matched ones for an UPDATE.
 *
 * attempts is incremented here rather than after the attempt, so that an attempt
 * which kills the process still counts against the schedule.
 */
async function claim(db, c, row) {
  const { result } = await db.query(
    `UPDATE integration_outbox
        SET \`status\` = $1, attempts = attempts + 1, updated_at = NOW()
      WHERE id = $2 AND \`status\` = $3
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`,
    [STATUS.sending, row.id, STATUS.pending]
  );
  return ((result && result.affectedRows) || 0) === 1;
}

/* Rows whose worker died holding them. Returned to pending without touching
 * attempts — the attempt was already counted when it was claimed, so the schedule
 * has already advanced and this only makes the row visible again.
 *
 * Its backoff is applied from now, not from when the dead worker claimed it: a row
 * that took the process down is exactly the one not to retry immediately. */
async function reclaim(db, c) {
  const { result } = await db.query(
    `UPDATE integration_outbox
        SET \`status\` = $1, updated_at = NOW(),
            next_attempt_at = (NOW() + INTERVAL ${Number(BACKOFF_SECONDS[0])} SECOND),
            last_error = $2
      WHERE \`status\` = $3 AND updated_at < (NOW() - INTERVAL ${Number(c.claimSeconds)} SECOND)`,
    [STATUS.pending, 'a worker stopped while this was in flight; returned to the queue', STATUS.sending]
  );
  return (result && result.affectedRows) || 0;
}

async function settle(db, row, outcome, error) {
  const next = nextState(row.attempts, outcome);
  await db.query(
    `UPDATE integration_outbox
        SET \`status\` = $1,
            next_attempt_at = ${next.delaySeconds === null
    ? 'NULL' : `(NOW() + INTERVAL ${Number(next.delaySeconds)} SECOND)`},
            last_error = $2, updated_at = NOW()
      WHERE id = $3`,
    [next.status, error ? String(error).slice(0, 500) : null, row.id]
  );
  return next;
}

/* One pass. Never throws: this runs on a timer with nothing above it to catch, and
 * an unhandled rejection in a background job takes the process down — which would
 * turn a receiver having a bad minute into an outage of the whole application. */
async function sweep(db, { log = console.log, fetchImpl = fetch } = {}) {
  const c = config();
  const tally = { sent: 0, retry: 0, failed: 0, reclaimed: 0, skipped: null };
  if (!require('./integration-events').enabled()) {
    tally.skipped = 'disabled';
    return tally;
  }

  if (secretsCollide()) {
    tally.skipped = 'secrets-collide';
    return tally;
  }
  if (!ready(c)) {
    tally.skipped = 'not-configured';
    return tally;
  }

  tally.reclaimed = await reclaim(db, c).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''))) return 0;
    throw err;
  });

  const rows = await due(db, c).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''))) return [];
    throw err;
  });

  for (const row of rows) {
    if (!(await claim(db, c, row))) continue;   // another worker got there first
    const attempted = { ...row, attempts: Number(row.attempts) + 1 };
    const result = await deliver(c, attempted, { fetchImpl });
    const next = await settle(db, attempted, result.outcome, result.error);

    if (next.status === STATUS.sent) tally.sent += 1;
    else if (next.status === STATUS.failed) {
      tally.failed += 1;
      log(`[outbox] giving up on ${row.id} after ${attempted.attempts} attempt(s): ${result.error}`);
    } else {
      tally.retry += 1;
      log(`[outbox] ${row.id} attempt ${attempted.attempts} failed (${result.error}); `
        + `next try in ${next.delaySeconds}s.`);
    }
  }
  return tally;
}

/* Run it on a timer, and once at startup — the same shape as the chat attachment
 * sweep in src/chat-files.js, which remains the right pattern for the periodic
 * part of this even though the work itself needs a claim the way that one does
 * not. The startup pass matters for the same reason there as here: a process that
 * was restarted comes back holding rows that came due while it was down, and no
 * timer ever fired for those.
 *
 * unref() so a stopped server is not held open by this. Tests start and stop the
 * app constantly, and an interval that keeps the event loop alive turns every one
 * of them into a timeout.
 */
function schedule(db, log = console.log) {
  const c = config();
  if (secretsCollide() || !ready(c)) return null;   // described at startup instead
  if (!require('./integration-events').enabled()) return null;

  const run = () => sweep(db, { log })
    .then((r) => {
      if (r.sent || r.failed || r.reclaimed) {
        log(`[outbox] ${r.sent} delivered, ${r.retry} to retry, ${r.failed} given up`
          + `${r.reclaimed ? `, ${r.reclaimed} reclaimed from a stopped worker` : ''}.`);
      }
    })
    .catch((err) => log(`[outbox] sweep failed: ${err.sqlMessage || err.message}`));

  run();
  const timer = setInterval(run, Math.max(1, c.sweepSeconds) * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

function describeAtStartup(log = console.log) {
  const c = config();
  if (!require('./integration-events').enabled()) {
    log('[outbox] the Dev & QA integration is switched off (INTEGRATION_ENABLED is not true): '
      + 'no events are written or delivered, and the integration API answers 503.');
    return;
  }
  if (secretsCollide()) {
    log(`[outbox] REFUSING TO DELIVER: ${OUTBOUND_SECRET_VAR} and ${INBOUND_SECRET_VAR} are the same `
      + 'value. One secret for both directions means whoever can verify a message can also forge one. '
      + 'Set them to two different random values.');
    return;
  }
  if (!c.url && !c.secret) {
    log('[outbox] not configured, so nothing is delivered (rows still accumulate). '
      + `Set INTEGRATION_OUTBOUND_URL and ${OUTBOUND_SECRET_VAR}.`);
    return;
  }
  if (!c.url || !c.secret) {
    log(`[outbox] HALF configured: ${c.url ? `${OUTBOUND_SECRET_VAR} is missing` : 'INTEGRATION_OUTBOUND_URL is missing'}. `
      + 'Nothing is delivered until both are set.');
    return;
  }
  let where = '(unparseable URL)';
  try { const u = new URL(c.url); where = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* keep the placeholder */ }
  log(`[outbox] delivering to ${where} every ${c.sweepSeconds}s, `
    + `up to ${c.batch} at a time, ${c.timeoutMs}ms each.`);
}

module.exports = {
  STATUS, BACKOFF_SECONDS, OUTBOUND_SECRET_VAR, INBOUND_SECRET_VAR,
  config, ready, secretsCollide, signingPayload, sign, pathOf,
  PAGE_DEFAULT, PAGE_MAX, highWater, eventsSince, shapeEvent,
  nextState, due, claim, reclaim, settle, deliver, sweep, schedule, describeAtStartup,
};
