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
const fs = require('node:fs');
const path = require('node:path');
const { asyncRouter } = require('../async-router');
const db = require('../db');
const idempotency = require('../integration-idempotency');
const outbox = require('../integration-outbox');
const { UPLOAD_DIR } = require('../upload');
const lifecycle = require('../lifecycle');
const workLog = require('../work-log');
const events = require('../integration-events');
const feedbackLifecycle = require('../feedback-lifecycle');

// Who a game bug can come from. A list rather than free text: these end up in reports,
// and four spellings of "QA" would make those reports lie quietly.
const SOURCES = ['qa', 'dev', 'tech_art', 'client'];

/* IDLE, and the whole rule rests on it: nobody is working on this asset. Delivered or
   Approved for Client, AND no open round. Both halves are needed — a delivered asset
   somebody has reopened and started has an open session, and taking it off them to
   answer a bug report would lose their round. */
const IDLE_STATUSES = ['delivered', 'approved_for_client'];

const router = asyncRouter();

/* THE ACTION NAME IS THE FIRST PATH SEGMENT, and path parameters do not disturb
 * that — checked against a running Express rather than assumed, because the whole
 * permission model here rests on it:
 *
 *   GET  /projects              -> projects
 *   GET  /projects/:id/assets   -> projects   <- note this one
 *   GET  /assets/:id            -> assets
 *   GET  /files/:id             -> files
 *   POST /handoffs/:id/ack      -> handoffs
 *   PUT  /assets/:id/in-game    -> assets
 *
 * The mount point is stripped from req.path before serviceAuth sees it, so /v1 is
 * not an action either.
 *
 * /projects/:id/assets NEEDING "projects" RATHER THAN "assets" is worth saying out
 * loud: it reads a project's contents, so the resource family it enters is projects.
 * A credential granted only "assets" can fetch one asset by id and cannot list a
 * project's. That follows from the rule rather than from a decision here, and
 * special-casing it would mean the permission a URL requires could no longer be read
 * off the URL. If the studio would rather that call needed "assets", the route to
 * move is this one — /assets?project_id= — not the rule.
 */

// Assets, not tasks. Pipeline work is an asset everywhere in this codebase.
const ASSET_FIELDS = `a.id, a.\`code\`, a.\`name\`, a.\`type\`, a.\`status\`, a.priority,
  a.project_id, a.assignee_id, a.routed_to_id, a.man_hours, a.due_date, a.start_date,
  a.description, a.reference_link, a.needs_tech_art, a.created_at`;

const shapeAsset = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  type: row.type,
  status: row.status,
  priority: row.priority,
  projectId: row.project_id,
  assigneeId: row.assignee_id,
  routedToId: row.routed_to_id,
  manHours: row.man_hours === null ? null : Number(row.man_hours),
  dueDate: row.due_date,
  startDate: row.start_date,
  description: row.description,
  referenceLink: row.reference_link,
  needsTechArt: Boolean(Number(row.needs_tech_art)),
  createdAt: row.created_at,
  // The marker a caller pages on. See GET /projects/:id/assets.
  updatedSeq: row.updatedSeq === undefined ? undefined : Number(row.updatedSeq) || 0,
});

/* Opaque cursors: the last row's sort key, base64url JSON. Opaque so a caller cannot
   build one by hand and come to depend on its insides. */
const encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeCursor(raw) {
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return Array.isArray(v) && v.length === 2 ? v : null;
  } catch {
    return null;
  }
}

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
/* THE PROBE IS FOR THE TEST SUITE ONLY. It writes outbox rows on request, which is
   what its tests need and what nobody else should be able to do, so it is mounted only
   when INTEGRATION_TEST_ENDPOINTS=1 (set by tests/helpers.js) and is absent from a
   deployment. */
const TEST_ENDPOINTS = process.env.INTEGRATION_TEST_ENDPOINTS === '1';
if (TEST_ENDPOINTS) {
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
}

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
    /* Every event in the one envelope (src/integration-events.js), in sequence order.
       `events` keeps its original shape for readers built against it. */
    envelopes: page.events.map((e) => e.envelope),
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

/* ---------------------------------------------------------------------------
 * The v1 surface. Everything here reads or writes on the credential's authority
 * alone — there is no req.user on this path, so none of the person-shaped checks
 * (canViewAsset, projectScope, ownership) apply or could. What a credential may
 * reach is decided by allowed_actions and nothing else, which is why those checks
 * are absent rather than merely unused.
 * ------------------------------------------------------------------------- */

/* GET /projects/:id/assets?updated_since=<seq> — a project's assets, newest change
 * last.
 *
 * WHAT "UPDATED" MEANS HERE, because assets has no updated_at column and inventing
 * one would be a second answer to a question this schema has already answered.
 * asset_events carries every transition with a seq BIGINT AUTO_INCREMENT, and its own
 * DDL says why that exists rather than a timestamp: created_at is accurate only to
 * the second, and submit/approve/relay routinely land in the same second, so sorting
 * by time scrambles them. So an asset's change marker is MAX(asset_events.seq), and
 * updated_since is a sequence — the same cursor kind /events uses, so this API has one
 * cursor concept rather than two.
 *
 * ONE CONSEQUENCE, STATED: creating an asset writes no asset_event, so an asset that
 * has never been touched has a marker of 0 and appears only on a full sync
 * (updated_since absent or 0). That is right for this consumer rather than a gap —
 * nothing has happened to it, so there is nothing to integrate.
 */
router.get('/projects/:id/assets', async (req, res) => {
  /* TWO WAYS TO PAGE, one of them safe.
   *
   *   cursor=<opaque>      the way to page. The cursor names the last row returned as
   *                        (change marker, id), and the next page starts strictly after
   *                        it, so rows that share a marker — every never-touched asset
   *                        shares marker 0 — can neither repeat nor be skipped.
   *   updated_since=<seq>  kept for callers built against it: assets whose marker is
   *                        at least <seq>. It is the START of a walk (0, or a marker
   *                        from a previous sync); continue with the cursor it returns.
   *
   * The old walk sent lastSeq back as updated_since, which with more than `limit` assets
   * on one marker returned the same page for ever. */
  const raw = req.query.updated_since;
  let since = 0;
  if (raw !== undefined && raw !== '') {
    since = Number(raw);
    if (!Number.isFinite(since) || since < 0) {
      return res.status(400).json({
        error: 'updated_since must be a sequence number — the updatedSeq of the last asset you '
          + 'received, or 0 for everything. It is asset_events.seq, not a timestamp.',
        field: 'updated_since',
        received: String(raw),
      });
    }
  }
  let after = null;
  if (req.query.cursor) {
    after = decodeCursor(req.query.cursor);
    if (!after || !Number.isFinite(Number(after[0])) || typeof after[1] !== 'string') {
      return res.status(400).json({ error: 'That cursor is not one this API issued.', field: 'cursor' });
    }
  }

  const project = await db.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
  if (!project.rows.length) return res.status(404).json({ error: 'No such project.' });

  // Same bounds as /events and as chat-oversight and activity: 50 by default, 200 at
  // most. One pagination convention, not a third.
  const n = Math.min(Math.max(Number(req.query.limit) || outbox.PAGE_DEFAULT, 1), outbox.PAGE_MAX);

  /* Ordered by the marker, then by id. The marker is computed once per row in the
     derived table, then filtered and ordered on. */
  const params = [req.params.id];
  let where = 'x.updatedSeq >= $2';
  params.push(since);
  if (after) {
    where = '(x.updatedSeq > $2 OR (x.updatedSeq = $3 AND x.id > $4))';
    params.splice(1, 1, Number(after[0]), Number(after[0]), after[1]);
  }
  const { rows } = await db.query(
    `SELECT x.* FROM (
       SELECT ${ASSET_FIELDS},
              COALESCE((SELECT MAX(e.seq) FROM asset_events e WHERE e.asset_id = a.id), 0) AS updatedSeq
         FROM assets a
        WHERE a.project_id = $1
     ) x
     WHERE ${where}
     ORDER BY x.updatedSeq ASC, x.id ASC
     LIMIT ${n + 1}`,
    params
  );
  const more = rows.length > n;
  const assets = rows.slice(0, n).map(shapeAsset);
  const high = await db.query(
    `SELECT COALESCE(MAX(e.seq), 0) AS seq
       FROM asset_events e JOIN assets a ON a.id = e.asset_id
      WHERE a.project_id = $1`,
    [req.params.id]
  );
  const last = assets[assets.length - 1];

  res.json({
    assets,
    updatedSince: since,
    limit: n,
    hasMore: more,
    // Pass this back as ?cursor= for the next page. Null when this was the last page.
    nextCursor: more && last ? encodeCursor([last.updatedSeq, last.id]) : null,
    // What to store for the next incremental sync (as updated_since), once hasMore is false.
    lastSeq: last ? last.updatedSeq : since,
    highWater: Number(high.rows[0].seq) || 0,
  });
});

/* GET /assets/:id — one asset, with where it sits in the build if anything has been
 * reported, and the files it has submitted. */
router.get('/assets/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${ASSET_FIELDS},
            COALESCE((SELECT MAX(e.seq) FROM asset_events e WHERE e.asset_id = a.id), 0) AS updatedSeq
       FROM assets a WHERE a.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such asset.' });

  const ingame = await db.query(
    `SELECT build, cp_stage, engine_status, open_bugs, link, in_game_build_seq, updated_at
       FROM asset_ingame WHERE asset_id = $1`,
    [req.params.id]
  ).catch(() => ({ rows: [] }));

  /* The submissions, which is what /files/:id takes an id from. Newest first, because
     the current one is what anybody integrating wants. */
  const versions = await db.query(
    `SELECT id, version_number, stage, link, description, file_name, created_at
       FROM asset_versions WHERE asset_id = $1 ORDER BY version_number DESC`,
    [req.params.id]
  ).catch(() => ({ rows: [] }));

  const g = ingame.rows[0];
  res.json({
    asset: shapeAsset(rows[0]),
    inGame: g ? {
      build: g.build,
      cpStage: g.cp_stage,
      engineStatus: g.engine_status,
      openBugs: Number(g.open_bugs) || 0,
      link: g.link,
      buildSeq: Number(g.in_game_build_seq) || 0,
      updatedAt: g.updated_at,
    } : null,
    files: versions.rows.map((v) => ({
      id: v.id,
      versionNumber: Number(v.version_number),
      stage: v.stage,
      link: v.link,
      description: v.description,
      // Null when the submission was a link rather than an upload; only a row with a
      // fileName has anything for GET /files/:id to stream.
      fileName: v.file_name || null,
      createdAt: v.created_at,
    })),
  });
});

/* GET /files/:id — stream a submitted file, by its submission id.
 *
 * The same convention as the internal GET /api/assets/versions/:versionId/download,
 * reused rather than re-invented: look the version up, resolve it under the uploads
 * directory, 404 if the row has no file or the file is gone, and hand it to
 * res.download so the filename travels with it.
 *
 * TWO DELIBERATE DIFFERENCES from that route, both because there is no person here.
 * It does not call canViewAsset — there is no req.user to pass it, and a credential's
 * authority is allowed_actions. And it resolves against UPLOAD_DIR from
 * src/upload.js rather than rebuilding that path by hand, which is what the internal
 * route does; one exported constant is the better half of that convention.
 *
 * THE STORED NAME IS NEVER TRUSTED AS A PATH. path.basename strips any directory part
 * before the join, and the resolved path is then checked to be inside the uploads
 * directory. Either alone would do — a mutation removing one survives, because the
 * other catches it — and both are kept because they fail differently: basename is
 * wrong-by-construction protection, the prefix check is wrong-by-result. Removing BOTH
 * is caught.
 *
 * Worth knowing how that got tested: aiming the traversal at ../../etc/passwd proved
 * nothing, because it resolves somewhere that does not exist and the existence check
 * refused it first. The test points at ../package.json, which is certainly there.
 */
router.get('/files/:id', async (req, res) => {
  const { rows } = await db.query(
    'SELECT v.id, v.asset_id, v.file_path, v.file_name FROM asset_versions v WHERE v.id = $1',
    [req.params.id]
  );
  const version = rows[0];
  if (!version) return res.status(404).json({ error: 'No such file.' });
  if (!version.file_path) {
    return res.status(404).json({
      error: 'That submission is a link rather than an upload, so there is no file to stream.',
      assetId: version.asset_id,
    });
  }

  const resolved = path.resolve(UPLOAD_DIR, path.basename(String(version.file_path)));
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return res.status(404).json({ error: 'No such file.' });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File missing from storage.', assetId: version.asset_id });
  }
  return res.download(resolved, version.file_name || path.basename(resolved));
});

/* POST /handoffs/:id/ack — Dev & QA confirming a drop landed, in a named build.
 *
 * body: { build, status?, note? }
 *
 * TWO GUARDS, AND THEY ARE NOT THE SAME GUARD. withIdempotency below handles a
 * repeated CALL: the same Idempotency-Key replays the stored response without the
 * handler running. This handler additionally handles a repeated FACT: a second ack of
 * the same hand-off, with a fresh key, from a caller that lost its bookkeeping.
 *
 * Same build, already acked -> 200 with the record as it stands. Nothing changed and
 * nothing needed to; telling them so is more useful than refusing.
 * A DIFFERENT build -> 409. One drop cannot have landed in two builds, so one of the
 * two calls is about something the studio does not know about, and quietly overwriting
 * the first would destroy the only record of which build actually took it.
 */
router.post('/handoffs/:id/ack', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  const build = req.body && typeof req.body.build === 'string' ? req.body.build.trim() : '';
  if (!build) {
    return { status: 400, body: { error: 'build is required — which build this drop landed in.', field: 'build' } };
  }

  const { rows } = await trx.query(
    'SELECT id, project_id, kind, `status`, build, note FROM handoffs WHERE id = $1',
    [req.params.id]
  );
  const handoff = rows[0];
  if (!handoff) return { status: 404, body: { error: 'No such hand-off.' } };
  if (handoff.status === 'cancelled') {
    return { status: 409, body: { error: 'That hand-off was cancelled in Forge.', code: 'handoff_cancelled' } };
  }

  const shape = (h, extra) => ({
    handoff: {
      id: h.id, projectId: h.project_id, kind: h.kind, status: h.status, build: h.build, note: h.note,
    },
    ...extra,
  });

  if (handoff.build) {
    if (handoff.build === build) {
      // Already acked, same build. The fact is already recorded, so this is a replay
      // of the fact rather than of the call.
      return { status: 200, body: shape(handoff, { acked: true, alreadyAcked: true }) };
    }
    return {
      status: 409,
      body: {
        error: `That hand-off was already acknowledged in build "${handoff.build}". `
          + 'One drop cannot have landed in two builds.',
        code: 'handoff_build_mismatch',
        ackedBuild: handoff.build,
        received: build,
      },
    };
  }

  const status = req.body && typeof req.body.status === 'string' && req.body.status.trim()
    ? req.body.status.trim() : 'received';
  const note = req.body && typeof req.body.note === 'string' ? req.body.note : handoff.note;

  await trx.query(
    'UPDATE handoffs SET build = $1, `status` = $2, note = $3, updated_at = NOW() WHERE id = $4',
    [build, status, note, handoff.id]
  );
  await trx.query("UPDATE handoff_assets SET `status` = 'received' WHERE handoff_id = $1 AND `status` = 'queued'", [handoff.id]);
  await events.emit(trx, {
    type: 'handoff.updated', projectId: handoff.project_id, entityType: 'handoff', entityId: handoff.id,
    payload: { handoffId: handoff.id, projectId: handoff.project_id, status, build, note, ackedBy: req.integration.name },
  });

  return {
    status: 200,
    body: shape({ ...handoff, build, status, note }, { acked: true, alreadyAcked: false }),
  };
}));

/* PUT /assets/:id/in-game — where an asset now sits in the build.
 *
 * body: { build_seq, build?, cp_stage?, engine_status?, open_bugs?, link? }
 *
 * THE STALENESS GUARD. These reports arrive over a network from a system that retries,
 * so they arrive out of order: a report about build 41 can land after one about 42.
 * The write is therefore conditional on the stored sequence — the same shape as the
 * outbox worker's claim, where a conditional UPDATE and its affectedRows decide the
 * outcome rather than a read-then-write that another caller can slip between.
 *
 * An older or equal sequence answers 200 { applied: false } and changes nothing. Not
 * an error: the caller did nothing wrong, and the report simply arrived after a newer
 * one. 4xx would make a retrying client treat a correct outcome as a failure.
 */
router.put('/assets/:id/in-game', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  const body = req.body || {};
  const seq = Number(body.build_seq);
  if (!Number.isFinite(seq) || seq < 0) {
    return {
      status: 400,
      body: {
        error: 'build_seq is required, and must be a number — the build\'s own sequence, so a report '
          + 'that arrives late cannot overwrite a newer one.',
        field: 'build_seq',
        received: body.build_seq === undefined ? null : String(body.build_seq),
      },
    };
  }

  const asset = await trx.query('SELECT id FROM assets WHERE id = $1', [req.params.id]);
  if (!asset.rows.length) return { status: 404, body: { error: 'No such asset.' } };

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const values = [
    req.params.id, str(body.build), str(body.cp_stage), str(body.engine_status),
    Number.isFinite(Number(body.open_bugs)) ? Math.max(0, Math.trunc(Number(body.open_bugs))) : 0,
    str(body.link), seq,
  ];

  /* THE STORED SEQUENCE FIRST, inside this handler's transaction, because that is the
     only thing that can tell "applied" from "held back".
     
     MEASURED, NOT ASSUMED, and the assumption was wrong: the documented reading of
     INSERT ... ON DUPLICATE KEY UPDATE is affectedRows 1 for an insert, 2 for a real
     update and 0 for one that assigned what was already there. On this MariaDB a
     no-op reports 1 — the same as an insert — so the statement cannot distinguish a
     row it created from a row the guard held back, and a first version of this told a
     caller its stale report had taken effect. A probe against the real server settled
     it; the tests below pin all four cases.
     
     The read is safe from interleaving because it is inside the transaction, and the
     conditional SET below stays regardless: it is what keeps the DATA right even if
     another writer slipped in, while this read is only what the answer is reported
     from. */
  /* A PLAIN READ, NOT ... FOR UPDATE, and that was a bug worth the finding.
     
     FOR UPDATE on a row that does not exist yet takes a gap lock, so two first reports
     about the same asset deadlock against each other the moment they both try to
     insert — which surfaced as a 500 carrying ER_LOCK_DEADLOCK under the concurrency
     test below. A deadlock is a far worse answer to Dev & QA than a momentarily
     optimistic `applied` flag: they would see a failure for a report that was fine.
     
     Without the lock, two concurrent reports can both read nothing and both decide they
     apply. That is exactly why the IF() guard in the statement below is not decoration:
     the read informs what is REPORTED, the statement decides what is STORED, and only
     the second of those has to be exactly right. */
  const prior = await trx.query(
    'SELECT in_game_build_seq AS seq FROM asset_ingame WHERE asset_id = $1',
    [req.params.id]
  );
  const priorSeq = prior.rows.length ? Number(prior.rows[0].seq) || 0 : null;
  const applied = priorSeq === null || seq > priorSeq;

  if (applied) {
    /* THE GUARD, and it is the authority on what is stored — not a belt-and-braces
       duplicate of the decision above.
       
       Nothing is locked while that decision is made (see the note on the read), so two
       concurrent reports can both conclude they apply. This IF() is then the only thing
       that keeps the NEWER build rather than the one that happened to arrive second.
       The decision reports; this protects. */
    await trx.query(
      `INSERT INTO asset_ingame
         (asset_id, build, cp_stage, engine_status, open_bugs, link, in_game_build_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON DUPLICATE KEY UPDATE
         build             = IF(VALUES(in_game_build_seq) > in_game_build_seq, VALUES(build), build),
         cp_stage          = IF(VALUES(in_game_build_seq) > in_game_build_seq, VALUES(cp_stage), cp_stage),
         engine_status     = IF(VALUES(in_game_build_seq) > in_game_build_seq, VALUES(engine_status), engine_status),
         open_bugs         = IF(VALUES(in_game_build_seq) > in_game_build_seq, VALUES(open_bugs), open_bugs),
         link              = IF(VALUES(in_game_build_seq) > in_game_build_seq, VALUES(link), link),
         in_game_build_seq = IF(VALUES(in_game_build_seq) > in_game_build_seq,
                                VALUES(in_game_build_seq), in_game_build_seq)`,
      values
    );
  }

  const stored = await trx.query(
    `SELECT build, cp_stage, engine_status, open_bugs, link, in_game_build_seq
       FROM asset_ingame WHERE asset_id = $1`,
    [req.params.id]
  );
  const g = stored.rows[0] || {};

  return {
    status: 200,
    body: {
      applied,
      // Why not, when it was not — so a caller reading the log can tell a stale report
      // from a rejected one.
      reason: applied ? null : 'a newer build has already been reported',
      buildSeq: Number(g.in_game_build_seq) || 0,
      inGame: {
        build: g.build,
        cpStage: g.cp_stage,
        engineStatus: g.engine_status,
        openBugs: Number(g.open_bugs) || 0,
        link: g.link,
      },
    },
  };
}));

/* POST /assets/:id/feedback — a bug raised against an asset from outside the studio.
 *
 * body (snake_case, every field validated; an unknown field is refused, never dropped):
 *   source        qa | dev | tech_art | client                          required
 *   description   what is wrong (or `note`, the older name)             required
 *   title, bug_ref, client_bug_id, source_app, severity, checkpoint (or cp_stage),
 *   build, test_ref, sender_name, sender_role, sender_team, link, reported_at,
 *   handoff_id, attachments: [{ name, url }]
 *
 * THE ANSWER SAYS WHAT HAPPENED, in `result`:
 *   created    200  the asset was idle and is now in Game Feedback, with the Team Lead
 *   note_only  200  somebody is working on the asset: recorded against the round in
 *                   progress, nothing moved (reason says why)
 *   duplicate  200  this bug is already open here (same client_bug_id, or same
 *                   bug_ref from the same source); nothing new was recorded
 *   refused    409  a permanent business answer (on hold, project archived or closed);
 *                   `code` says which
 *   rejected   400/404  the request itself is wrong (errors[] says where), or no asset
 * A replay of an earlier call with the same Idempotency-Key returns that call's body
 * with `replayed: true` (and the Idempotent-Replay header).
 *
 * ONE RULE DECIDES WHETHER THE ASSET MOVES: only if it is IDLE — Delivered or Approved
 * for Client with no open round. Anything else takes the bug as a note: work in its first
 * pass, a fix mid-flight, and an asset already carrying an open game bug are the same
 * case, because somebody is already working and a status change would take the asset
 * off them.
 *
 * REFUSALS ARE RETURNED, NOT THROWN: a permanent answer must replay identically; a
 * transient failure throws so no idempotency row is written and the retry runs properly.
 */
const FEEDBACK_FIELDS = {
  source: 'string', description: 'string', note: 'string', title: 'string', bug_ref: 'string',
  client_bug_id: 'string', source_app: 'string', severity: 'string', checkpoint: 'string',
  cp_stage: 'string', build: 'string', test_ref: 'string', sender_name: 'string',
  sender_role: 'string', sender_team: 'string', link: 'string', reported_at: 'string',
  handoff_id: 'string', attachments: 'array',
};
const LIMITS = {
  description: 10000, note: 10000, title: 255, bug_ref: 120, client_bug_id: 64, source_app: 32,
  severity: 24, checkpoint: 32, cp_stage: 32, build: 64, test_ref: 191, sender_name: 191,
  sender_role: 64, sender_team: 64, link: 2048, reported_at: 40, handoff_id: 36,
};
const isHttpUrl = (v) => {
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch { return false; }
};

function validateFeedback(body) {
  const errors = [];
  const out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: null, code: 'not_an_object', message: 'The body must be a JSON object.' }] };
  }
  for (const key of Object.keys(body)) {
    if (!FEEDBACK_FIELDS[key]) {
      errors.push({ field: key, code: 'unknown_field', message: `"${key}" is not a field this endpoint accepts.` });
      continue;
    }
    const v = body[key];
    if (v === null || v === undefined) continue;
    if (FEEDBACK_FIELDS[key] === 'string') {
      if (typeof v !== 'string') { errors.push({ field: key, code: 'not_a_string', message: `${key} must be a string.` }); continue; }
      const t = v.trim();
      if (t.length > LIMITS[key]) { errors.push({ field: key, code: 'too_long', message: `${key} is longer than ${LIMITS[key]} characters.` }); continue; }
      if (t) out[key] = t;
    }
  }
  if (Array.isArray(body.attachments)) {
    if (body.attachments.length > 20) errors.push({ field: 'attachments', code: 'too_many', message: 'At most 20 attachments.' });
    const list = [];
    body.attachments.slice(0, 20).forEach((a, n) => {
      const name = a && typeof a.name === 'string' ? a.name.trim().slice(0, 255) : '';
      const url = a && typeof a.url === 'string' ? a.url.trim() : '';
      const extra = a && typeof a === 'object' ? Object.keys(a).filter((k) => k !== 'name' && k !== 'url') : [];
      if (!url || url.length > 2048 || !isHttpUrl(url)) {
        errors.push({ field: `attachments[${n}].url`, code: 'invalid_url', message: 'Each attachment needs an http(s) url.' });
      } else if (extra.length) {
        errors.push({ field: `attachments[${n}]`, code: 'unknown_field', message: `Unknown attachment field(s): ${extra.join(', ')}.` });
      } else list.push({ name: name || null, url });
    });
    out.attachments = list;
  } else if (body.attachments !== undefined && body.attachments !== null) {
    errors.push({ field: 'attachments', code: 'not_an_array', message: 'attachments must be an array.' });
  }
  const source = (out.source || '').toLowerCase();
  if (!SOURCES.includes(source)) errors.push({ field: 'source', code: 'invalid', message: `source must be one of: ${SOURCES.join(', ')}.` });
  out.source = source;
  out.description = out.description || out.note || '';
  if (!out.description) errors.push({ field: 'description', code: 'required', message: 'description is required — what is wrong.' });
  if (out.source_app && !/^[a-z0-9_-]+$/i.test(out.source_app)) errors.push({ field: 'source_app', code: 'invalid', message: 'source_app is letters, digits, - and _.' });
  if (out.link && !isHttpUrl(out.link)) errors.push({ field: 'link', code: 'invalid_url', message: 'link must be an http(s) URL.' });
  if (out.reported_at) {
    const d = new Date(out.reported_at);
    if (Number.isNaN(d.getTime())) errors.push({ field: 'reported_at', code: 'invalid_date', message: 'reported_at must be an ISO-8601 date-time.' });
    else out.reported_at = d;
  }
  out.checkpoint = out.checkpoint || out.cp_stage || null;
  return { errors, value: out };
}

const rejected = (status, error, extra = {}) => ({ status, body: { result: 'rejected', error, ...extra } });

router.post('/assets/:id/feedback', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  const { errors, value: f } = validateFeedback(req.body);
  if (errors.length) {
    return rejected(400, 'The feedback is not valid; nothing was recorded.', { code: 'validation_failed', errors, field: errors[0].field });
  }

  const { rows } = await trx.query(
    'SELECT id, `code`, `name`, project_id, `status`, assignee_id, routed_to_id FROM assets WHERE id = $1',
    [req.params.id]
  );
  const asset = rows[0];
  if (!asset) return rejected(404, 'No such asset.', { code: 'asset_not_found' });

  if (f.handoff_id) {
    const h = await trx.query('SELECT id FROM handoffs WHERE id = $1 AND project_id = $2', [f.handoff_id, asset.project_id]);
    if (!h.rows.length) {
      return rejected(400, 'handoff_id is not a hand-off of this asset\'s project.', {
        code: 'validation_failed', errors: [{ field: 'handoff_id', code: 'not_found', message: 'No such hand-off on this project.' }], field: 'handoff_id',
      });
    }
  }

  /* --- the permanent refusals, all RETURNED ------------------------------- */
  // Archived and closed are the project's; lifecycle.projectRefusal words both.
  const project = await trx.query(
    'SELECT id, `name`, is_active, closed_at FROM projects WHERE id = $1', [asset.project_id]
  );
  const refusal = lifecycle.projectRefusal(project.rows[0]);
  if (refusal) {
    const row = project.rows[0];
    return {
      status: 409,
      body: { result: 'refused', error: refusal, code: !row ? 'project_missing' : (!row.is_active ? 'project_archived' : 'project_closed') },
    };
  }
  // On hold is derived: the newest session of whoever holds the asset, ended 'held'.
  const held = asset.assignee_id ? await workLog.heldFor(trx, asset.id, asset.assignee_id) : null;
  if (held) {
    return {
      status: 409,
      body: { result: 'refused', error: 'That asset is on hold. Resume it before raising anything against it.', code: 'asset_on_hold' },
    };
  }

  /* --- already open here? -------------------------------------------------- */
  const dupe = await trx.query(
    `SELECT id, round, \`state\` FROM external_feedback
      WHERE asset_id = $1 AND \`state\` IN ($2)
        AND ((source_app <=> $3 AND client_bug_id = $4) OR (source = $5 AND bug_ref <> '' AND bug_ref = $6))
      ORDER BY created_at LIMIT 1`,
    [asset.id, feedbackLifecycle.OPEN, f.source_app || null, f.client_bug_id || '\u0000', f.source, f.bug_ref || '\u0000']
  );
  if (dupe.rows.length) {
    const was = dupe.rows[0];
    return {
      status: 200,
      body: { result: 'duplicate', feedbackId: was.id, round: Number(was.round), state: was.state, alreadyRaised: true, movedAsset: false, assetStatus: asset.status },
    };
  }

  /* --- idle, or not ------------------------------------------------------- */
  const open = await workLog.openSession(trx, asset.id);
  const idle = IDLE_STATUSES.includes(asset.status) && !open;
  const round = await workLog.currentRound(trx, asset.id);
  const state = idle ? 'with_lead' : 'noted';

  const feedbackId = crypto.randomUUID();
  try {
    await trx.query(
      `INSERT INTO external_feedback
         (id, asset_id, round, source, bug_ref, severity, note, sender_name, sender_role,
          build, cp_stage, link, prev_status, prev_routed_to_id,
          \`state\`, title, checkpoint, test_ref, sender_team, source_app, client_bug_id,
          attachments, reported_at, handoff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        feedbackId, asset.id, round, f.source, f.bug_ref || '', f.severity || null, f.description,
        f.sender_name || null, f.sender_role || null, f.build || null, f.checkpoint, f.link || null,
        // The restore pair, only when this round moves the asset: unrecoverable afterwards.
        idle ? asset.status : null, idle ? asset.routed_to_id : null,
        state, f.title || null, f.checkpoint, f.test_ref || null, f.sender_team || null,
        f.source_app || null, f.client_bug_id || null,
        f.attachments && f.attachments.length ? JSON.stringify(f.attachments) : null,
        f.reported_at || null, f.handoff_id || null,
      ]
    );
  } catch (err) {
    /* The unique key on (asset_id, round, source, bug_ref): the same defect raised twice
       at one round, with a fresh idempotency key. Returned, so it replays. */
    if (err && err.code === 'ER_DUP_ENTRY') {
      const existing = await trx.query(
        `SELECT id, round, \`state\` FROM external_feedback
          WHERE asset_id = $1 AND round = $2 AND source = $3 AND bug_ref = $4`,
        [asset.id, round, f.source, f.bug_ref || '']
      );
      const was = existing.rows[0];
      return {
        status: 200,
        body: { result: 'duplicate', feedbackId: was ? was.id : null, round, state: was ? was.state : null, alreadyRaised: true, movedAsset: false, assetStatus: asset.status },
      };
    }
    throw err;
  }

  // A Tech Art return: the hand-off's asset is marked returned.
  if (f.handoff_id) {
    await trx.query("UPDATE handoff_assets SET `status` = 'returned', note = $1 WHERE handoff_id = $2 AND asset_id = $3",
      [f.description.slice(0, 500), f.handoff_id, asset.id]);
  }

  const row = {
    id: feedbackId, round, source: f.source, source_app: f.source_app, client_bug_id: f.client_bug_id,
    bug_ref: f.bug_ref, title: f.title, severity: f.severity, handoff_id: f.handoff_id, state,
    attachments: f.attachments && f.attachments.length ? JSON.stringify(f.attachments) : null,
  };

  if (!idle) {
    /* A NOTE, and nothing moves. Still an asset_events row: Dev & QA's incremental asset
       sync is driven by asset_events.seq. */
    await trx.query(
      `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, note)
       VALUES ($1, $2, 'game_feedback_note', $3, $4, $5)`,
      [crypto.randomUUID(), asset.id, asset.status, asset.status, `${f.source}: ${f.description}`.slice(0, 2000)]
    );
    const reason = open ? 'a round is already open on this asset' : `the asset is in ${asset.status}`;
    await feedbackLifecycle.emitFor(trx, 'feedback.received', row, asset, { result: 'note_only', reason });
    return {
      status: 200,
      body: { result: 'note_only', feedbackId, round, state, movedAsset: false, reason, assetStatus: asset.status },
    };
  }

  /* IDLE: the asset moves, in this same transaction, into the Team Lead's queue. */
  await trx.query('UPDATE assets SET `status` = $1, routed_to_id = NULL WHERE id = $2', ['game_feedback', asset.id]);
  await trx.query(
    `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, note)
     VALUES ($1, $2, 'game_feedback_raised', $3, 'game_feedback', $4)`,
    [crypto.randomUUID(), asset.id, asset.status, `${f.source}: ${f.description}`.slice(0, 2000)]
  );
  await feedbackLifecycle.emitFor(trx, 'feedback.received', row, asset, { result: 'created' });
  await feedbackLifecycle.emitFor(trx, 'feedback.accepted', row, asset, { result: 'created' });

  return {
    status: 200,
    body: {
      result: 'created', feedbackId, round, state, movedAsset: true, assetStatus: 'game_feedback',
      restoredTo: { status: asset.status, routedToId: asset.routed_to_id },
    },
  };
}, { markReplay: true }));

/* POST /assets/:id/feedback/:feedbackId/withdraw — Dev & QA take a bug back.
 *
 * body: { reason? }
 *
 * Allowed while nobody has started on it: still in the Team Lead's queue (the asset
 * goes back to where it was, exactly as a decline restores it), or recorded as a note
 * (nothing moved, so nothing to restore). Once the Team Lead has passed it to an artist
 * it is somebody's work, and withdrawing it here would pull it from under them: that is
 * 409 feedback_in_progress, and the Team Lead can decline it instead.
 */
router.post('/assets/:id/feedback/:feedbackId/withdraw', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  const body = req.body || {};
  const extra = Object.keys(body).filter((k) => k !== 'reason');
  if (extra.length || (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string')) {
    return rejected(400, 'Only { reason } is accepted.', { code: 'validation_failed',
      errors: extra.map((k) => ({ field: k, code: 'unknown_field', message: `"${k}" is not accepted.` })) });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  const { rows } = await trx.query('SELECT * FROM external_feedback WHERE id = $1 AND asset_id = $2 FOR UPDATE',
    [req.params.feedbackId, req.params.id]);
  const row = rows[0];
  if (!row) return rejected(404, 'No such feedback on that asset.', { code: 'feedback_not_found' });
  const asset = await feedbackLifecycle.assetOf(trx, row.asset_id);

  if (row.state === 'withdrawn') {
    return { status: 200, body: { result: 'withdrawn', feedbackId: row.id, state: 'withdrawn', alreadyWithdrawn: true, assetStatus: asset.status } };
  }
  if (feedbackLifecycle.TERMINAL.includes(row.state) || !feedbackLifecycle.OPEN.includes(row.state)) {
    return { status: 409, body: { result: 'refused', code: 'feedback_closed', state: row.state,
      error: `That bug is already ${String(row.state).replace(/_/g, ' ')}; there is nothing to withdraw.` } };
  }
  if (row.state === 'with_artist' || row.state === 'in_review') {
    return { status: 409, body: { result: 'refused', code: 'feedback_in_progress', state: row.state,
      error: 'An artist is already working on this bug, so it cannot be withdrawn from here. Ask the Team Lead to decline it.' } };
  }

  let restoredTo = null;
  if (row.state === 'with_lead' && asset.status === 'game_feedback' && row.prev_status) {
    await trx.query('UPDATE assets SET `status` = $1, routed_to_id = $2 WHERE id = $3',
      [row.prev_status, row.prev_routed_to_id || null, asset.id]);
    await trx.query(
      `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, note)
       VALUES ($1, $2, 'game_feedback_withdrawn', 'game_feedback', $3, $4)`,
      [crypto.randomUUID(), asset.id, row.prev_status, `Withdrawn by ${req.integration.name}${reason ? `: ${reason}` : ''}`.slice(0, 2000)]
    );
    restoredTo = row.prev_status;
  }
  const next = await feedbackLifecycle.setState(trx, row, 'withdrawn', { resolved: true, note: reason });
  await feedbackLifecycle.emitFor(trx, 'feedback.withdrawn', next, asset, { reason, restoredTo });
  return { status: 200, body: { result: 'withdrawn', feedbackId: row.id, state: 'withdrawn', restoredTo, assetStatus: restoredTo || asset.status } };
}, { markReplay: true }));

/* ---------------------------------------------------------------------------
 * Reads for sync and reconciliation. Paged with an opaque cursor over
 * (updated_at, id); `version` is the entity's event version, the number Dev & QA
 * compares with what it holds.
 * ------------------------------------------------------------------------- */

const pageSize = (q) => Math.min(Math.max(Number(q.limit) || outbox.PAGE_DEFAULT, 1), outbox.PAGE_MAX);

async function pageBy(req, res, { table, alias, select, join = '', filters = [], params = [], shape }) {
  let after = null;
  if (req.query.cursor) {
    after = decodeCursor(req.query.cursor);
    if (!after || typeof after[0] !== 'string' || typeof after[1] !== 'string') {
      res.status(400).json({ error: 'That cursor is not one this API issued.', field: 'cursor' });
      return;
    }
  }
  const n = pageSize(req.query);
  const where = [...filters];
  const values = [...params];
  if (after) {
    values.push(after[0], after[0], after[1]);
    const k = values.length;
    where.push(`(${alias}.updated_at > $${k - 2} OR (${alias}.updated_at = $${k - 1} AND ${alias}.id > $${k}))`);
  }
  const { rows } = await db.query(
    `SELECT ${select}, DATE_FORMAT(${alias}.updated_at, '%Y-%m-%d %H:%i:%s') AS cursor_at,
            COALESCE(v.version, 0) AS entity_version
       FROM ${table} ${alias} ${join}
       LEFT JOIN integration_entity_versions v ON v.entity_type = '${table === 'clients' ? 'client' : 'project'}' AND v.entity_id = ${alias}.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${alias}.updated_at ASC, ${alias}.id ASC
      LIMIT ${n + 1}`,
    values
  );
  const more = rows.length > n;
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return {
    items: page.map(shape),
    limit: n,
    hasMore: more,
    nextCursor: more && last ? encodeCursor([last.cursor_at, last.id]) : null,
  };
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const shapeClient = (c) => ({
  id: c.id, name: c.name, isActive: Boolean(Number(c.is_active)), archivedAt: iso(c.archived_at),
  dealClosedAt: iso(c.deal_closed_at), isSystem: Boolean(Number(c.is_system)),
  updatedAt: iso(c.updated_at), version: Number(c.entity_version) || 0,
});
const shapeProject = (p) => ({
  id: p.id, name: p.name, code: p.code || null, clientId: p.client_id, clientName: p.client_name || null,
  ownerId: p.owner_id, isActive: Boolean(Number(p.is_active)), archivedAt: iso(p.archived_at),
  closedAt: iso(p.closed_at), createdAt: p.created_at, updatedAt: iso(p.updated_at),
  version: Number(p.entity_version) || 0,
});
const CLIENT_SELECT = 'c.id, c.`name`, c.is_active, c.archived_at, c.deal_closed_at, c.is_system, c.updated_at';
const PROJECT_SELECT = `p.id, p.\`name\`, p.\`code\`, p.client_id, p.owner_id, p.is_active, p.archived_at,
  p.closed_at, p.created_at, p.updated_at, c.\`name\` AS client_name`;

/* GET /health — is the integration up, and how far behind is delivery. Signed like
   everything else; says nothing about secrets, hosts or configuration. */
router.get('/health', async (req, res) => {
  const counts = await db.query('SELECT `status`, COUNT(*) AS n FROM integration_outbox GROUP BY `status`');
  const by = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
  res.json({
    ok: true,
    enabled: true,
    time: new Date().toISOString(),
    schemaVersion: events.SCHEMA_VERSION,
    client: req.integration.name,
    highWater: await outbox.highWater(db),
    outbox: { pending: (by.pending || 0) + (by.sending || 0), failed: by.failed || 0 },
  });
});

/* GET /clients?cursor=&limit= — every client, paged. */
router.get('/clients', async (req, res) => {
  const page = await pageBy(req, res, { table: 'clients', alias: 'c', select: CLIENT_SELECT, shape: shapeClient });
  if (page) res.json({ clients: page.items, limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor });
});

router.get('/clients/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${CLIENT_SELECT}, COALESCE(v.version, 0) AS entity_version FROM clients c
       LEFT JOIN integration_entity_versions v ON v.entity_type = 'client' AND v.entity_id = c.id
      WHERE c.id = $1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such client.' });
  return res.json({ client: shapeClient(rows[0]) });
});

/* GET /projects — every project, with its client.
 *
 * With ?cursor= or ?limit= it is paged like /clients (and can be narrowed with
 * ?client_id=). Without either it answers the whole list in one response, as it always
 * has, for callers built against that. */
router.get('/projects', async (req, res) => {
  const paged = req.query.cursor !== undefined || req.query.limit !== undefined;
  const filters = [];
  const params = [];
  if (req.query.client_id) { params.push(String(req.query.client_id)); filters.push(`p.client_id = $${params.length}`); }
  if (paged) {
    const page = await pageBy(req, res, {
      table: 'projects', alias: 'p', select: PROJECT_SELECT, join: 'LEFT JOIN clients c ON c.id = p.client_id',
      filters, params, shape: shapeProject,
    });
    if (page) res.json({ projects: page.items, limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor });
    return;
  }
  const { rows } = await db.query(
    `SELECT ${PROJECT_SELECT}, COALESCE(v.version, 0) AS entity_version
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN integration_entity_versions v ON v.entity_type = 'project' AND v.entity_id = p.id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC, p.id`, params
  );
  res.json({ projects: rows.map(shapeProject) });
});

router.get('/projects/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${PROJECT_SELECT}, COALESCE(v.version, 0) AS entity_version
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN integration_entity_versions v ON v.entity_type = 'project' AND v.entity_id = p.id
      WHERE p.id = $1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such project.' });
  return res.json({ project: shapeProject(rows[0]) });
});

/* GET /handoffs/:id — one hand-off and its assets, for reconciliation. */
router.get('/handoffs/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, project_id, kind, label, \`status\`, build, cp_stage, note, sent_at, created_at, updated_at
       FROM handoffs WHERE id = $1`, [req.params.id]
  );
  const h = rows[0];
  if (!h) return res.status(404).json({ error: 'No such hand-off.' });
  const items = await db.query(
    `SELECT ha.asset_id, ha.round, ha.bug_refs, ha.\`status\`, a.\`code\`, a.\`name\`
       FROM handoff_assets ha LEFT JOIN assets a ON a.id = ha.asset_id
      WHERE ha.handoff_id = $1 ORDER BY a.\`code\`, ha.asset_id`, [h.id]
  );
  return res.json({
    handoff: {
      id: h.id, projectId: h.project_id, kind: h.kind, label: h.label, status: h.status, build: h.build,
      cpStage: h.cp_stage, note: h.note, sentAt: iso(h.sent_at), updatedAt: iso(h.updated_at),
      version: await events.currentVersion(db, 'handoff', h.id),
      assets: items.rows.map((r) => ({
        id: r.asset_id, code: r.code, name: r.name, round: Number(r.round), status: r.status,
        bugRefs: r.bug_refs ? String(r.bug_refs).split(',').filter(Boolean) : [],
      })),
    },
  });
});

/* GET /handoffs?project_id=&since=<ISO> — hand-offs of one project, newest last, for a
   reconciliation to catch a handoff.created it never received. */
router.get('/handoffs', async (req, res) => {
  if (!req.query.project_id) return res.status(400).json({ error: 'project_id is required.', field: 'project_id' });
  const n = pageSize(req.query);
  const { rows } = await db.query(
    `SELECT id, kind, label, \`status\`, build, sent_at, updated_at FROM handoffs
      WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT ${n}`, [String(req.query.project_id)]
  );
  res.json({ handoffs: rows.map((h) => ({ id: h.id, kind: h.kind, label: h.label, status: h.status, build: h.build, sentAt: iso(h.sent_at), updatedAt: iso(h.updated_at) })) });
});

const shapeFeedback = (r) => ({
  id: r.id, assetId: r.asset_id, assetCode: r.asset_code || null, projectId: r.project_id || null,
  state: r.state, round: Number(r.round), source: r.source, sourceApp: r.source_app || null,
  clientBugId: r.client_bug_id || null, bugRef: r.bug_ref || null, title: r.title || null,
  severity: r.severity || null, handoffId: r.handoff_id || null, createdAt: iso(r.created_at),
  resolvedAt: iso(r.resolved_at), resolutionNote: r.resolution_note || null,
  version: Number(r.entity_version) || 0,
});
const FEEDBACK_SELECT = `SELECT f.*, a.\`code\` AS asset_code, a.project_id, COALESCE(v.version, 0) AS entity_version
   FROM external_feedback f JOIN assets a ON a.id = f.asset_id
   LEFT JOIN integration_entity_versions v ON v.entity_type = 'feedback' AND v.entity_id = f.id`;

/* GET /feedback/:id — where one bug is now. */
router.get('/feedback/:id', async (req, res) => {
  const { rows } = await db.query(`${FEEDBACK_SELECT} WHERE f.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such feedback.' });
  return res.json({ feedback: shapeFeedback(rows[0]) });
});

/* GET /feedback?source_app=&client_bug_id= — find a bug by the sender's own id, for a
   sender that lost track of a call's answer (a timeout) and must not send it twice. */
router.get('/feedback', async (req, res) => {
  const bugId = String(req.query.client_bug_id || '').trim();
  if (!bugId) return res.status(400).json({ error: 'client_bug_id is required.', field: 'client_bug_id' });
  const { rows } = await db.query(
    `${FEEDBACK_SELECT} WHERE f.client_bug_id = $1 AND f.source_app <=> $2 ORDER BY f.created_at, f.id LIMIT 50`,
    [bugId, req.query.source_app ? String(req.query.source_app) : null]
  );
  res.json({ feedback: rows.map(shapeFeedback) });
});

module.exports = router;
