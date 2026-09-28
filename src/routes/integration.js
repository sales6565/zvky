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

/* ---------------------------------------------------------------------------
 * The v1 surface. Everything here reads or writes on the credential's authority
 * alone — there is no req.user on this path, so none of the person-shaped checks
 * (canViewAsset, projectScope, ownership) apply or could. What a credential may
 * reach is decided by allowed_actions and nothing else, which is why those checks
 * are absent rather than merely unused.
 * ------------------------------------------------------------------------- */

/* GET /projects — every project, with its client.
 *
 * UNPAGINATED, matching the internal GET /api/projects, which is also unpaginated:
 * a studio has tens of projects, not thousands, and inventing a cursor for this one
 * would be a second pagination shape for no benefit. The internal route scopes to
 * what a person may see; there is no person here, so the whole list is the answer.
 */
router.get('/projects', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.\`name\`, p.client_id, p.owner_id, p.is_active, p.created_at,
            c.\`name\` AS client_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY p.created_at DESC, p.id`
  );
  res.json({
    projects: rows.map((r) => ({
      id: r.id,
      name: r.name,
      clientId: r.client_id,
      clientName: r.client_name,
      ownerId: r.owner_id,
      isActive: Boolean(Number(r.is_active)),
      createdAt: r.created_at,
    })),
  });
});

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

  const project = await db.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
  if (!project.rows.length) return res.status(404).json({ error: 'No such project.' });

  // Same bounds as /events and as chat-oversight and activity: 50 by default, 200 at
  // most. One pagination convention, not a third.
  const n = Math.min(Math.max(Number(req.query.limit) || outbox.PAGE_DEFAULT, 1), outbox.PAGE_MAX);

  /* Ordered by the marker, then by id — the id breaks ties so that two assets sharing
     a marker cannot straddle a page boundary and lose one. Assets with no events share
     marker 0, which is exactly the case that needs the tiebreak. */
  const { rows } = await db.query(
    `SELECT ${ASSET_FIELDS},
            COALESCE((SELECT MAX(e.seq) FROM asset_events e WHERE e.asset_id = a.id), 0) AS updatedSeq
       FROM assets a
      WHERE a.project_id = $1
        AND COALESCE((SELECT MAX(e.seq) FROM asset_events e WHERE e.asset_id = a.id), 0) >= $2
      ORDER BY updatedSeq ASC, a.id ASC
      LIMIT ${n}`,
    [req.params.id, since]
  );

  const assets = rows.map(shapeAsset);
  const high = await db.query(
    `SELECT COALESCE(MAX(e.seq), 0) AS seq
       FROM asset_events e JOIN assets a ON a.id = e.asset_id
      WHERE a.project_id = $1`,
    [req.params.id]
  );

  res.json({
    assets,
    updatedSince: since,
    limit: n,
    hasMore: rows.length === n,
    // What to send next time. `since` itself when the page is empty, so a caught-up
    // caller can keep polling with the same value.
    lastSeq: assets.length ? assets[assets.length - 1].updatedSeq : since,
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

module.exports = router;
