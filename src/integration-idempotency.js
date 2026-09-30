/* Idempotency for the integration API: the same request twice, one effect.
 *
 * An external caller retrying is not an edge case, it is the normal operation of
 * every queue and every CI job in existence. A network timeout tells the caller
 * nothing about whether the work happened, so the only safe thing it can do is
 * send it again — and the only safe thing this end can do is recognise it.
 *
 * WHY THIS IS NOT A MIDDLEWARE, or not only one.
 *
 * The record of "this request already happened" has to be written in the same
 * transaction as the change it describes. If the change commits and the record
 * does not, a retry does the work twice; if the record commits and the change
 * does not, a retry is answered with a success for work that never happened.
 * Both are worse than having no idempotency at all, because both are silent.
 *
 * A middleware cannot do that. It runs before the handler and again after it,
 * and the handler's writes commit somewhere in between on a connection the
 * middleware does not hold. So the transaction is opened HERE and handed to the
 * caller: withIdempotency gives the handler the connection, and the handler does
 * its writes on it. One transaction, one commit, both facts or neither.
 *
 * What the middleware still does is the part that needs no transaction and must
 * not be forgettable: refusing a mutation that carries no key at all. See
 * requireKey below — a handler that forgets to call withIdempotency must not be
 * able to quietly accept keyless writes.
 *
 * RESERVE, RUN, RECORD — and why not check, run, record.
 *
 * Checking for an existing row before running is a READ, and a read cannot
 * exclude anybody. Two duplicate requests arriving together both found nothing,
 * both entered the handler, and only their commits were deduplicated by the
 * primary key. Exactly one set of database writes survived, which sounds like
 * enough until you notice that everything the handler did OUTSIDE its transaction
 * — an email sent, a file written, somebody else's API called — happened twice
 * and no rollback takes those back.
 *
 * So the row is claimed first, by an INSERT that commits on its own before the
 * handler is entered. The duplicate's INSERT then violates the primary key, and
 * it is turned away without ever reaching the handler. The claim is what makes
 * the key exclusive; the primary key is what makes the claim atomic. There is no
 * moment in between for two requests to occupy.
 *
 * That buys exactly-once execution and costs two things, both of which have to be
 * answered rather than accepted:
 *
 *   A DUPLICATE ARRIVING MID-FLIGHT now finds a claim rather than nothing, and
 *   there is no answer to replay yet. It is told so, distinctly — see
 *   IN_PROGRESS_CODE — because "your first request is still running" and "you
 *   reused a key for different work" are a wait and a bug respectively, and a
 *   client that cannot tell them apart will retry the one it should fix.
 *
 *   A CLAIM CAN OUTLIVE ITS REQUEST. The process holding it can be killed
 *   mid-handler, and nothing then exists to finish or release it. Without a way
 *   out, that key is unusable forever — a crash would permanently poison one
 *   idempotency key, which is a worse failure than the duplicate work this
 *   prevents. So a claim goes stale: see STALE_SECONDS.
 */
const crypto = require('node:crypto');

const KEY_HEADER = 'idempotency-key';
const REPLAY_HEADER = 'Idempotent-Replay';

// The methods this applies to. GET and HEAD change nothing, so a repeat of one
// is not a thing to protect against — and requiring a key on them would make
// every read harder to write for no gain.
const GUARDED_METHODS = new Set(['POST', 'PUT', 'DELETE']);

/* How long a key is remembered, and how often that is enforced.
 *
 * Seven days is long enough to cover any retry a caller will actually make — a
 * job that has been failing for a week is not retrying, it is broken — and short
 * enough that this table does not grow without bound. The window is what makes a
 * key reusable afterwards, which is worth saying plainly: a caller that sends
 * the same key again in a fortnight gets it treated as new.
 */
const RETENTION_DAYS = Number(process.env.INTEGRATION_IDEMPOTENCY_DAYS || 7);
const SWEEP_MINUTES = Number(process.env.INTEGRATION_IDEMPOTENCY_SWEEP_MINUTES || 60);

const MAX_KEY_LENGTH = 191;   // the column's width; see the DDL in src/migrate.js

/* The row's own states. Not an ENUM, matching every other status column in this
 * schema, so a fourth state would be a row's value rather than a migration.
 *
 * pending   claimed, and the handler is running now — or was, when the process
 *           holding it was last alive
 * complete  the handler finished and its answer is stored; this is the only state
 *           a replay can be served from
 * failed    the handler threw, or answered with a refusal of its own. Kept rather
 *           than deleted, so a caller asking "what happened to that key" gets an
 *           answer, and takeable immediately: a failed attempt produced no
 *           response, so there is nothing for a retry to conflict with.
 */
const STATUS = { pending: 'pending', complete: 'complete', failed: 'failed' };

/* HOW LONG A CLAIM IS BELIEVED, and the arithmetic behind the number.
 *
 * Too short and a healthy in-flight request has its key stolen by its own retry,
 * which produces the duplicate execution this exists to prevent — the worst
 * failure available here. Too long and a process killed mid-handler strands that
 * key for the whole window.
 *
 * The outbox's retry cadence has a one-minute floor, so a retrying caller is not
 * expected to come back faster than that. Two minutes is therefore two retry
 * intervals: the first retry after a crash is still told "in progress" and backs
 * off, and the second is past the window and takes the key over. A request that
 * legitimately runs longer than two minutes would need this raised — which is a
 * deployment's decision, so it is an environment variable and not a constant.
 */
const STALE_SECONDS = Number(process.env.INTEGRATION_IDEMPOTENCY_STALE_SECONDS || 120);

/* Codes, not just statuses, because the two 4xx answers here mean opposite things
 * to the machine reading them: one says wait, the other says you have a bug. A
 * caller matching on the number alone cannot tell them apart, and the one that
 * looks more like a failure is the one it should NOT retry. */
const IN_PROGRESS_CODE = 'idempotency_in_progress';
const REUSED_CODE = 'idempotency_key_reused';

/* How long to suggest waiting. The request holding the claim is normally
 * milliseconds from finishing, so this is short on purpose: it is a "come
 * straight back", not a backoff. If the holder died instead, no Retry-After can
 * help — what frees the key is STALE_SECONDS, which the caller's own retries will
 * cross on their own. */
const RETRY_AFTER_SECONDS = 2;

const hashBody = (raw) => crypto.createHash('sha256')
  .update(raw === undefined || raw === null ? '' : String(raw)).digest('hex');

/* WHAT IS HASHED is the raw bytes that arrived, the same string the signature
 * was taken over — not a re-serialization of req.body. Two JSON documents that
 * mean the same thing can differ in key order and whitespace, and hashing a
 * re-serialization would call those the same request. The signature already
 * insists on exact bytes; this agrees with it rather than inventing a second,
 * looser idea of what "the same request" means. */
function requestHash(req) {
  if (typeof req.rawBody === 'string') return hashBody(req.rawBody);
  // No raw body captured (a route mounted outside /api/integration): fall back
  // to the parsed body rather than hashing nothing, which would make every
  // request look identical.
  return hashBody(req.body === undefined ? '' : JSON.stringify(req.body));
}

const keyOf = (req) => {
  const raw = req.get(KEY_HEADER);
  return typeof raw === 'string' ? raw.trim() : '';
};

/* The blanket check: a mutation on this path without a key is refused, whether
 * or not its handler remembers to call withIdempotency.
 *
 * Mounted after serviceAuth so that an unauthenticated caller is told it is not
 * recognised rather than told its header is missing — which would be a way to
 * probe the API's shape without a credential.
 */
function requireKey(req, res, next) {
  if (!GUARDED_METHODS.has(String(req.method).toUpperCase())) return next();

  const key = keyOf(req);
  if (!key) {
    return res.status(400).json({
      error: `A ${KEY_HEADER} header is required on ${[...GUARDED_METHODS].join(', ')} requests `
        + 'so that a retry of this request can be told apart from a second request.',
      header: KEY_HEADER,
    });
  }
  if (key.length > MAX_KEY_LENGTH) {
    return res.status(400).json({
      error: `That ${KEY_HEADER} is ${key.length} characters; the limit is ${MAX_KEY_LENGTH}.`,
      header: KEY_HEADER,
    });
  }
  req.idempotencyKey = key;
  return next();
}

/* The safety net for the other half of the problem: a handler that mutates
 * something and never calls withIdempotency. requireKey above makes sure a key
 * arrived; nothing makes sure anybody used it. This says so in the log rather
 * than letting an endpoint be quietly non-idempotent, which is the kind of gap
 * that is only ever found by the retry that duplicated something.
 *
 * A warning and not a refusal: failing the request would mean a bug in one
 * handler took out an endpoint that was otherwise working, and the deployment
 * that most needs this message is the one already in production.
 */
function warnIfUnused(log = console.warn) {
  return (req, res, next) => {
    if (!GUARDED_METHODS.has(String(req.method).toUpperCase())) return next();
    res.on('finish', () => {
      if (req.idempotencyHandled || res.statusCode >= 400) return;
      log(`[integration] ${req.method} ${req.originalUrl.split('?')[0]} changed something without `
        + 'going through withIdempotency, so a retry of it would run twice. '
        + 'See src/integration-idempotency.js.');
    });
    return next();
  };
}

/* A route's own declaration that it changes nothing, which silences the warning
 * above for it.
 *
 * Deliberately said at the route rather than kept as a path list in the
 * middleware. A list here would be edited by whoever is adding a path and read
 * by nobody, and the day somebody adds a mutating endpoint to it the warning
 * that existed to catch exactly that goes quiet. Said at the handler, it is a
 * claim sitting next to the code that either honours it or does not.
 */
function changesNothing(req) {
  req.idempotencyHandled = true;
  return req;
}

const stored = (row) => {
  if (row.response_body === null || row.response_body === undefined) return null;
  try { return JSON.parse(row.response_body); } catch { return { body: String(row.response_body) }; }
};

function replay(res, row, mark = false) {
  res.set(REPLAY_HEADER, 'true');
  let body = stored(row);
  /* mark: the endpoint asked for the replay to say so in the BODY too, for a caller
     that reads bodies and not headers, which would otherwise take a replay for a fresh
     result. Off by default, so every other endpoint replays byte for byte. */
  if (mark && body && typeof body === 'object' && !Array.isArray(body)) body = { ...body, replayed: true };
  return body === null ? res.status(row.response_status).end() : res.status(row.response_status).json(body);
}

/* withIdempotency(req, res, fn)
 *
 * fn receives the transaction's connection and returns { status, body }. Every
 * write it makes must go through that connection — a write made on the pool
 * instead is outside the transaction and will survive a rollback, which is the
 * one mistake this arrangement cannot catch for you.
 *
 * Returns whatever it sent, so a handler can `return withIdempotency(...)`.
 *
 * THREE STEPS, and which transaction each one is in:
 *
 *   RESERVE  a single INSERT on the pool. Autocommit makes it its own
 *            transaction, committed before anything else happens, which is the
 *            whole point — a claim nobody else can see is not a claim.
 *   RUN      fn, inside a transaction of its own on a pooled connection.
 *   RECORD   the UPDATE that moves the row to complete, inside THAT transaction,
 *            so the answer and the work it describes commit together or not at
 *            all. Only the claim moved earlier; the record did not.
 *
 * WHAT IS GUARANTEED. fn runs exactly once per (client, key) — a duplicate is
 * turned away at the reservation, before it is entered. The exception is a claim
 * left stale by a crashed process, which a later retry takes over: fn may then run
 * again, for a request whose first attempt provably did not finish. That is the
 * deliberate trade, and the only one: the alternative is a key poisoned forever by
 * one crash.
 */
async function withIdempotency(req, res, fn, deps = {}) {
  const db = deps.db || require('./db');
  const log = deps.log || console.log;

  const key = req.idempotencyKey || keyOf(req);
  if (!key) {
    // Reachable only if this is called on a route requireKey does not cover.
    return res.status(400).json({ error: `A ${KEY_HEADER} header is required.`, header: KEY_HEADER });
  }

  const clientId = req.integration ? req.integration.id : null;
  const endpoint = `${String(req.method).toUpperCase()} ${req.originalUrl.split('?')[0]}`;
  const hash = requestHash(req);
  const who = req.integration ? req.integration.name : 'unknown';

  const read = async () => {
    const found = await db.query(
      `SELECT idempotency_key, request_hash, \`status\`, response_status, response_body,
              created_at, updated_at,
              TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age
         FROM integration_requests
        WHERE client_id = $1 AND idempotency_key = $2`,
      [clientId, key]
    );
    return found.rows[0] || null;
  };

  /* THE CLAIM. One INSERT, and the primary key on (client_id, idempotency_key) is
     what makes it exclusive — a duplicate gets ER_DUP_ENTRY here and never reaches
     fn. Nothing is wrapped around it: a lone INSERT under autocommit already is
     its own transaction, committed by the time this returns, which is exactly what
     was wanted and one fewer moving part than BEGIN/COMMIT around it. */
  const claim = async () => {
    try {
      await db.query(
        `INSERT INTO integration_requests
           (idempotency_key, client_id, endpoint, request_hash, \`status\`)
         VALUES ($1, $2, $3, $4, $5)`,
        [key, clientId, endpoint, hash, STATUS.pending]
      );
      return true;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  };

  /* TAKING OVER a claim that is finished with or abandoned, in one conditional
     UPDATE so that two callers racing to reclaim the same dead key cannot both
     win — whoever the row matches for first has already changed it by the time the
     other's WHERE is evaluated.
     
     The hash and endpoint are overwritten, because this is now a different
     request's claim. response_status and response_body are cleared so a crash
     before the next completion cannot leave a previous attempt's answer sitting
     under a pending row.
     
     affectedRows is 1 exactly when the WHERE matched, which holds here because
     every branch changes something: a failed row's status changes, and a stale
     pending row's updated_at moves by at least STALE_SECONDS. (MySQL reports
     CHANGED rows for an UPDATE, not matched ones, so a no-op UPDATE would report
     0 — worth knowing, since a condition that changed nothing would read as a
     lost race.) */
  const takeOver = async () => {
    const { result } = await db.query(
      `UPDATE integration_requests
          SET \`status\` = $1, request_hash = $2, endpoint = $3,
              response_status = NULL, response_body = NULL, updated_at = NOW()
        WHERE client_id = $4 AND idempotency_key = $5
          AND (\`status\` = $6
               OR (\`status\` = $7 AND updated_at < (NOW() - INTERVAL ${Number(STALE_SECONDS)} SECOND)))`,
      [STATUS.pending, hash, endpoint, clientId, key, STATUS.failed, STATUS.pending]
    );
    return ((result && result.affectedRows) || 0) === 1;
  };

  // Releasing a claim we could not honour. Its own short write, deliberately
  // outside fn's rolled-back transaction — that rollback is what makes this
  // necessary, since the claim was committed separately and rollback cannot reach
  // it. Never allowed to throw: the response has already been decided, and losing
  // a release only means the staleness window frees the key instead.
  const release = async () => {
    await db.query(
      `UPDATE integration_requests SET \`status\` = $1, updated_at = NOW()
        WHERE client_id = $2 AND idempotency_key = $3 AND \`status\` = $4`,
      [STATUS.failed, clientId, key, STATUS.pending]
    ).catch((err) => log(`[integration] could not release ${KEY_HEADER} "${key}": ${err.message}`));
  };

  const inProgress = (row) => {
    req.idempotencyHandled = true;
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    return res.status(409).json({
      error: 'A request with this Idempotency-Key is still being processed. '
        + 'Retry with the same key and body; you will get its result once it finishes.',
      code: IN_PROGRESS_CODE,
      header: KEY_HEADER,
      startedSecondsAgo: row && Number.isFinite(Number(row.age)) ? Number(row.age) : null,
    });
  };

  const reused = (row) => {
    /* Not a retry — a caller reusing a key for new work, which means one of the
       two requests is about to be lost. 422 rather than 409: the request is
       well-formed and the credential is fine, it is the combination that cannot be
       processed. Logged, because it is a bug in the caller and nobody watching
       this end would otherwise see it. Deliberately says nothing about what the
       first request was. */
    log(`[integration] ${who} reused ${KEY_HEADER} "${key}" on ${endpoint} with a different body `
      + `(first seen ${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}).`);
    req.idempotencyHandled = true;
    return res.status(422).json({
      error: `That ${KEY_HEADER} was already used for a request with a different body. `
        + 'Use a new key for new work, or send the original request again unchanged.',
      code: REUSED_CODE,
      header: KEY_HEADER,
    });
  };

  /* Deciding what an existing row means. Order matters, and it is not the obvious
     one: STATUS FIRST, then the hash.
     
     A hash mismatch is only a conflict against a row that ANSWERED something —
     that is what "you already used this key for a different request" means. A
     pending or failed row produced no answer, so there is nothing to conflict
     with, and a caller correcting the body that just failed must be allowed to use
     the same key. Checking the hash first would refuse exactly that, which is the
     normal way a caller recovers. */
  const decide = async (row) => {
    if (row.status === STATUS.complete) {
      if (row.request_hash !== hash) return { answer: () => reused(row) };
      return { answer: () => { req.idempotencyHandled = true; return replay(res, row, Boolean(deps.markReplay)); } };
    }
    /* A FAST PATH, not the guard. takeOver's WHERE clause enforces the same
       staleness condition and is the authority on it — removing this line changes
       no answer, only the number of round trips, which a mutation test duly
       reports as equivalent. It is here because the mid-flight duplicate is the
       common case and there is no reason to make it attempt an UPDATE and a second
       SELECT to be told what this row already says. */
    if (row.status === STATUS.pending && Number(row.age) < STALE_SECONDS) {
      return { answer: () => inProgress(row) };
    }
    // Failed, or pending and abandoned: ours to take, if nobody beats us to it.
    if (await takeOver()) return { owned: true };

    /* Lost the reclaim. Whoever won either finished while we looked — in which
       case their answer is the right one to hand back — or is running now. Read
       once more rather than guessing, and fall back to "in progress", which is
       the answer that asks the caller to come back rather than one that asserts
       anything untrue. */
    const now = await read();
    if (now && now.status === STATUS.complete && now.request_hash === hash) {
      req.idempotencyHandled = true;
      return { answer: () => replay(res, now, Boolean(deps.markReplay)) };
    }
    if (now && now.status === STATUS.complete) return { answer: () => reused(now) };
    return { answer: () => inProgress(now) };
  };

  let owned = await claim();
  if (!owned) {
    const row = await read();
    /* The row vanished between our failed INSERT and this read — swept for age,
       or deleted by hand. Try the claim once more; if that fails too, something is
       contending for it and "in progress" is the honest answer. */
    if (!row) {
      owned = await claim();
      if (!owned) return inProgress(null);
    } else {
      const outcome = await decide(row);
      if (!outcome.owned) return outcome.answer();
      owned = true;
    }
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const outcome = await fn(conn);
    const status = Number(outcome && outcome.status) || 200;
    const body = outcome && outcome.body !== undefined ? outcome.body : null;

    if (status < 400) {
      /* THE RECORD, in the same transaction as everything fn just did — the claim
         moved earlier, this did not. An UPDATE rather than an INSERT now, of the
         row we already own.
         
         ON conn, NOT db, AND NO TEST CAN PROVE IT. Both spellings leave the same
         rows behind whenever the commit below succeeds, which it does in every
         reachable test, so a mutation swapping them survives — this note is the
         only thing standing between that line and somebody "simplifying" it.
         
         Where they differ is the COMMIT failing: a deadlock, a lost connection, a
         server going down between here and the next line. On db the row is already
         marked complete on its own connection, so fn's writes roll back while a
         stored success stays — and the caller's retry is handed that success for
         work that never happened. Which is the precise failure this mechanism
         exists to prevent, arrived at from the other direction. Testing it would
         need fault injection at the commit, and a test-only hook in this path
         would be a worse risk than the one it covers. */
      await conn.query(
        `UPDATE integration_requests
            SET \`status\` = $1, response_status = $2, response_body = $3, updated_at = NOW()
          WHERE client_id = $4 AND idempotency_key = $5`,
        [STATUS.complete, status, body === null ? null : JSON.stringify(body), clientId, key]
      );
      await conn.query('COMMIT');
    } else {
      /* A refusal fn chose to RETURN rather than throw. Its writes stand — it
         decided what to write and what to answer — but the outcome is not recorded
         as an answer to replay, because a 4xx is not a state to hold the caller in
         for seven days: their corrected request has to be allowed to run, and it
         will usually carry the same key. So the claim is released instead. */
      await conn.query('COMMIT');
      await release();
    }
    req.idempotencyHandled = true;
    return body === null ? res.status(status).end() : res.status(status).json(body);
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    /* Everything fn did is gone. The claim is not — it was committed on its own —
       so it has to be released by hand, or this key would be unusable until it
       went stale. Marked failed rather than deleted: a caller asking what became
       of that key gets an answer, and a failed row is takeable immediately. */
    await release();
    throw err;
  } finally {
    conn.release();
  }
}

/* The seven-day sweep.
 *
 * Same shape as the chat attachment sweep in src/chat-files.js, deliberately:
 * a run now, then a timer, unref'd so a stopped server is not held open by it,
 * and a missing table treated as nothing to do rather than as a failure. The
 * startup pass is the one that matters — a process restarted after a week down
 * comes back holding keys no timer ever fired for.
 */
async function sweep(db, days = RETENTION_DAYS) {
  const window = Number.isFinite(days) && days > 0 ? days : 7;
  const { result } = await db.query(
    `DELETE FROM integration_requests WHERE created_at < (NOW() - INTERVAL ${Number(window)} DAY)`
  ).catch((err) => {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''))) {
      return { result: { affectedRows: 0 } };
    }
    throw err;
  });
  return { removed: (result && result.affectedRows) || 0, days: window };
}

function schedule(db, log = console.log) {
  const run = () => sweep(db)
    .then((r) => {
      if (r.removed) log(`[integration] forgot ${r.removed} idempotency key(s) older than ${r.days} days.`);
    })
    .catch((err) => log(`[integration] idempotency sweep failed: ${err.sqlMessage || err.message}`));

  run();
  const timer = setInterval(run, Math.max(1, SWEEP_MINUTES) * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  KEY_HEADER, REPLAY_HEADER, GUARDED_METHODS, RETENTION_DAYS, SWEEP_MINUTES, MAX_KEY_LENGTH,
  STATUS, STALE_SECONDS, IN_PROGRESS_CODE, REUSED_CODE, RETRY_AFTER_SECONDS,
  hashBody, requestHash, requireKey, warnIfUnused, changesNothing, withIdempotency, sweep, schedule,
};
