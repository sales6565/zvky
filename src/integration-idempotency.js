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

function replay(res, row) {
  res.set(REPLAY_HEADER, 'true');
  const body = stored(row);
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
 * WHAT IS GUARANTEED, precisely, because the difference matters when you write
 * the handler:
 *
 *   committed effects   EXACTLY ONCE. The primary key on
 *                       (client_id, idempotency_key) is what enforces it, on
 *                       insert, so anything fn wrote on trx either commits with
 *                       the record or rolls back with it.
 *   fn itself           AT LEAST ONCE. Two duplicate requests arriving together
 *                       both miss the lookup and both enter fn; the loser's
 *                       insert then violates the key and its transaction is
 *                       rolled back, and it replays the winner's response.
 *
 * So a side effect fn performs that is NOT on the connection it was handed — an
 * email sent, a file written, somebody else's API called — can happen twice, and
 * no rollback will take it back. Those belong in integration_outbox, written on
 * trx and delivered afterwards, which is the table's whole reason for existing.
 *
 * tests/integration-idempotency.test.js asserts both halves of this, including
 * the second one, rather than only the half that reads well.
 *
 * It could be made exactly-once by inserting the record FIRST, as a placeholder,
 * and updating it with the response before commit: the duplicate then blocks on
 * the key before fn is entered rather than after. That is a deliberate
 * non-choice here — it writes a row for an attempt that has not happened yet,
 * and the order specified for this mechanism is check, run, record. Worth
 * revisiting if a handler ever needs a non-transactional side effect that cannot
 * go through the outbox.
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

  const found = await db.query(
    `SELECT idempotency_key, request_hash, response_status, response_body, created_at
       FROM integration_requests
      WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, key]
  );

  if (found.rows.length) {
    const row = found.rows[0];
    /* SAME KEY, DIFFERENT BODY. Not a retry — a caller reusing a key for new
       work, which means one of the two requests is about to be lost. Answered
       with 422 rather than 409: the request is well-formed and the credential is
       fine, it is the combination that cannot be processed. Logged, because it
       is a bug in the caller and nobody watching this end would otherwise see
       it. Deliberately says nothing about what the first request was. */
    if (row.request_hash !== hash) {
      log(`[integration] ${req.integration ? req.integration.name : 'unknown'} reused `
        + `${KEY_HEADER} "${key}" on ${endpoint} with a different body `
        + `(first seen ${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}).`);
      req.idempotencyHandled = true;
      return res.status(422).json({
        error: `That ${KEY_HEADER} was already used for a request with a different body. `
          + 'Use a new key for new work, or send the original request again unchanged.',
        header: KEY_HEADER,
      });
    }
    // Same key, same body: the caller's logic does not run at all.
    req.idempotencyHandled = true;
    return replay(res, row);
  }

  const conn = await db.connect();
  let outcome;
  try {
    await conn.query('BEGIN');
    outcome = await fn(conn);
    const status = Number(outcome && outcome.status) || 200;
    const body = outcome && outcome.body !== undefined ? outcome.body : null;

    /* The record, inside the same transaction as everything fn just did. Only a
       success is recorded: a 4xx or 5xx that fn chose to return is not a state
       the caller should be stuck with for seven days, and the retry that fixes
       their request must be allowed to run. */
    if (status < 400) {
      await conn.query(
        `INSERT INTO integration_requests
           (idempotency_key, client_id, endpoint, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [key, clientId, endpoint, hash, status, body === null ? null : JSON.stringify(body)]
      );
    }
    await conn.query('COMMIT');
    req.idempotencyHandled = true;
    return body === null ? res.status(status).end() : res.status(status).json(body);
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});

    /* THE RACE, and the reason the primary key matters more than the lookup
       above. Two requests carrying the same key arrive together, both find
       nothing, both run. The second one's insert violates the key, and what
       happens here is that its work is rolled back and it is answered with the
       first one's response — which is exactly what it would have got had it
       arrived a second later. Without this it would be a 500 for a request that
       succeeded. */
    if (err && err.code === 'ER_DUP_ENTRY') {
      const again = await db.query(
        `SELECT request_hash, response_status, response_body
           FROM integration_requests
          WHERE client_id = $1 AND idempotency_key = $2`,
        [clientId, key]
      ).catch(() => ({ rows: [] }));
      if (again.rows.length && again.rows[0].request_hash === hash) {
        req.idempotencyHandled = true;
        return replay(res, again.rows[0]);
      }
    }

    /* Anything else: no row was written, so the caller can send the same key
       again and it will run properly. That is the point of recording only on
       success, and it is why this rethrows rather than inventing a response —
       the error handler in server.js says what went wrong. */
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
  hashBody, requestHash, requireKey, warnIfUnused, changesNothing, withIdempotency, sweep, schedule,
};
