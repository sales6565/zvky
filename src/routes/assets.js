const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { upload, uploadImport } = require('../upload');
const {
  canAccessProject,
  canViewAsset,
  canEditAsset,
  canDeleteAsset,
  canCreateAsset,
  isAssignedArtist,
  isTeamLeadOfAsset,
  canReviewAsCD,
  canOverrideReview,
  canMarkDelivered,
  canOverrideStage,
  mayAssign,
  canHandOverInReview,
  canManageTasks,
  hasFullAccess,
  isAwaitingRework,
  REWORK_STATUSES,
  holds,
} = require('../permissions');
const { assignableRoles, roleDef } = require('../roles');
const lifecycle = require('../lifecycle');
const workLog = require('../work-log');
const assignments = require('../assignments');
const assetImport = require('../asset-import');
const workflow = require('../asset-workflow');
const submissionLink = require('../submission-link');
const referenceData = require('../reference-data');

/* --- the asset's preview image --------------------------------------------

   GET sits ABOVE router.use(authenticate), for the reason the profile photo
   route gives at length: an <img src> cannot send an Authorization header, and
   these appear on every card of every board. The alternatives were inlining
   each image as a data: URI in the board JSON — tens of kilobytes per card —
   or putting the token in the query string, where it lands in every proxy log.

   So what protects a thumbnail is its URL: the asset's id is a version 4 UUID,
   handed out only inside authenticated responses. It is a capability rather
   than a secret, and anyone given the link can load the image.

   Worth stating plainly because this is a step further than a face: these are
   previews of client work. The same trade was already accepted for profile
   photos and the studio logo, and no other route in this application works
   this way. If client artwork should not be reachable by URL, the fix is not a
   tweak here — it is signed, expiring URLs for all three, and it is a
   different piece of work.

   404 when there is none: the page then draws the placeholder, which is the
   documented fallback rather than a broken image icon.
*/
const multer = require('multer');
const assetThumbnail = require('../asset-thumbnail');
const permissions = require('../permissions');

router.get('/:id/thumbnail', async (req, res) => {
  const image = await assetThumbnail.read(db, req.params.id).catch(() => null);
  if (!image) return res.status(404).json({ error: 'This asset has no preview image.' });
  res.setHeader('Content-Type', image.mime);
  /* Revalidated rather than trusted: the page appends the upload time to the
     URL so a replacement is a new URL and appears at once, but a browser
     holding the old URL must not go on showing a deleted image for days. */
  res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
  res.send(image.buffer);
});

router.use(authenticate);

/* Every asset that leaves this router goes through here, which is why the
   Lead/Supervisor Notes redaction lives here and not at seven call sites.
   ASSET_SELECT is `SELECT a.*`, so a column added to the table is in the
   response the moment it exists — convenient until one of those columns is
   meant to be gated, and then it is a leak that no route ever wrote a line of
   code to cause. `viewer` is the request's user; without it, nothing is shown,
   which is the safe end of a mistake. */
async function attachTasksAndNotes(assets, viewer) {
  if (!assets.length) return assets;
  if (!holds(viewer, 'asset.lead_notes')) {
    // Deleted rather than blanked: an absent key and an empty note are
    // different things, and the panel below tells them apart.
    assets.forEach((a) => { delete a.lead_notes; });
  }
  const ids = assets.map((a) => a.id);

  // Everything below decorates an asset for the response. None of it is the
  // point of any request — the work is already done and committed by the time
  // this runs. So a missing enrichment table must never turn a successful write
  // into "the server could not complete that request because of a database
  // error", which is exactly what it did: reassigning an asset updated the row,
  // then threw here while re-reading it, and the page reported a failure over a
  // change that had already happened — and put the old value back on screen.
  //
  // tasks already degraded this way. notes, submissions and feedback did not,
  // and any one of them could turn a good write into a bad answer.
  const enrich = async (what, run) => {
    try {
      return await run();
    } catch (err) {
      console.warn(`[schema] ${what} unavailable (${err.code || err.message}) — see /api/health. Falling back.`);
      return [];
    }
  };

  // Who added each checklist item is an enrichment on top of an enrichment: if
  // only the authorship join fails, the items themselves are still readable.
  const tasks = await enrich('the checklist', async () => {
    try {
      const { rows } = await db.query(
        `SELECT t.*, u.\`name\` AS created_by_name, u.avatar_updated_at AS created_by_photo_at
           FROM tasks t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.asset_id IN ($1) ORDER BY t.\`position\``,
        [ids]
      );
      return rows;
    } catch {
      const { rows } = await db.query(
        'SELECT * FROM tasks WHERE asset_id IN ($1) ORDER BY `position`', [ids]
      );
      return rows.map((t) => ({ ...t, created_by_name: null }));
    }
  });

  const notes = await enrich('asset notes', async () => (await db.query(
    `SELECT n.*, u.name AS author_name FROM notes n
     LEFT JOIN users u ON u.id = n.author_id
     WHERE n.asset_id IN ($1) ORDER BY n.created_at DESC`,
    [ids]
  )).rows);

  const versions = await enrich('submission history', async () => (await db.query(
    `SELECT v.*, u.name AS uploaded_by_name, u.avatar_updated_at AS uploaded_by_photo_at
       FROM asset_versions v
     LEFT JOIN users u ON u.id = v.uploaded_by
     WHERE v.asset_id IN ($1) ORDER BY v.version_number DESC`,
    [ids]
  )).rows);

  const feedback = await enrich('review feedback', async () => (await db.query(
    `SELECT f.*, u.name AS given_by_name FROM feedback f
     LEFT JOIN users u ON u.id = f.given_by
     WHERE f.asset_id IN ($1) ORDER BY f.created_at DESC`,
    [ids]
  )).rows);

  const timeSpent = await workLog.totalsFor(db, ids);
  // Who has held each asset, in order, with the time and submissions from each
  // stretch. The Assets List draws one row per entry here; the dashboard
  // ignores it and keeps drawing one card per asset.
  const episodes = await enrich('assignment history', () => assignments.listFor(db, ids))
    .then((m) => (m instanceof Map ? m : new Map()));
  return assets.map((a) => ({
    ...a,
    time_spent_seconds: (timeSpent.get(a.id) || {}).seconds || 0,
    // What the person holding it now has put in, as distinct from the asset's
    // lifetime above. The panel shows this one; showing the lifetime to a new
    // assignee told them somebody else's hours were theirs, and made the panel
    // hide Accept and Start where it should have offered it.
    round_seconds: (episodes.get(a.id) || []).reduce(
      (n, ep) => (ep.active ? ep.seconds : n),
      (timeSpent.get(a.id) || {}).currentSeconds || 0
    ),
    /* The stamps for the stretch the current holder is on: when they started,
       and when they handed it in. Taken from the open episode where there is
       one, so a new assignee's panel shows their own start rather than the last
       person's. `work_open` is "started and not yet submitted" — a state, not a
       clock; nothing ticks it. */
    work_open: Boolean(currentStamps(episodes, timeSpent, a.id).open),
    started_at: currentStamps(episodes, timeSpent, a.id).startedAt,
    submitted_at: currentStamps(episodes, timeSpent, a.id).submittedAt,
    // How many rounds those two stamps span. Across more than one they are the
    // first start and the last submit, not the ends of a single stretch.
    work_rounds: currentStamps(episodes, timeSpent, a.id).rounds,
    assignments: episodes.get(a.id) || [],
    // MySQL stores the flag as TINYINT(1); hand the browser a real boolean.
    tasks: tasks.filter((t) => t.asset_id === a.id).map((t) => ({ ...t, done: Boolean(t.done) })),
    notes: notes.filter((n) => n.asset_id === a.id),
    versions: versions.filter((v) => v.asset_id === a.id),
    feedback: feedback.filter((f) => f.asset_id === a.id),
  }));
}

/* The start and submit stamps for whoever holds an asset now.
 *
 * Prefers the open assignment episode, because that is the stretch the panel is
 * about. Falls back to the whole-asset figures — which totalsFor already scopes
 * to the current assignee — on a deployment where asset_assignments could not
 * be created. Never falls back to the asset's lifetime: those are somebody
 * else's stamps. */
function currentStamps(episodes, totals, assetId) {
  const open = (episodes.get(assetId) || []).find((ep) => ep.active);
  if (open) {
    return {
      startedAt: open.startedAt, submittedAt: open.submittedAt,
      open: open.workOpen, rounds: open.rounds || 0,
    };
  }
  const t = totals.get(assetId) || {};
  return {
    startedAt: t.startedAt || null, submittedAt: t.submittedAt || null,
    open: Boolean(t.open), rounds: t.rounds || 0,
  };
}

// A user's name for an audit line, from whichever connection the caller is on.
async function nameOfUser(run, userId) {
  if (!userId) return 'nobody';
  const { rows } = await run.query('SELECT `name` FROM users WHERE id = $1', [userId]);
  return rows.length ? rows[0].name : 'somebody who no longer has an account';
}

// Seconds, for a human reading an audit line. "2h 15m", not "8100".
function fmtSeconds(total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  if (!n) return 'no time';
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${n}s`;
}

/* assignee_photo_at is the assignee's avatar_updated_at: the page turns it
   into a photo URL, and null means draw their initials instead. The image
   bytes are never selected here — this join runs for every asset on the
   board, and a MEDIUMBLOB per row would be paid for on every load. */
/* The board's read. `a.*` is deliberate and load-bearing to leave alone — which
   is why the thumbnail's BYTES live in their own table and only its timestamp
   is joined here. A MEDIUMBLOB on the assets row would arrive in every board
   response as a JSON array of byte values, per asset. The page builds the image
   URL from the id and this stamp, exactly as it does for a profile photo. */
const ASSET_SELECT = `SELECT a.*, u.name AS assignee_name, u.avatar_updated_at AS assignee_photo_at,
    t.updated_at AS thumbnail_at, t.source_url AS thumbnail_url
  FROM assets a
  LEFT JOIN users u ON u.id = a.assignee_id
  LEFT JOIN asset_thumbnails t ON t.asset_id = a.id`;

// Nothing is written to an asset in a closed or archived project.
//
// Reading stays open — the whole point of closing rather than deleting is that
// the work remains there to look at. This guards the writes, and every one of
// them goes through it rather than each remembering for itself.
//
// The default is deliberately strict: a closed project finishes nothing, not
// even a review already in flight. Reopening is one click for whoever holds
// project.close, so the way to finish that review is to say so out loud.
async function projectClosedResponse(res, projectId) {
  const { rows } = await db.query('SELECT id, `name`, is_active, closed_at FROM projects WHERE id = $1', [projectId]);
  const refusal = lifecycle.projectRefusal(rows[0]);
  if (!refusal) return false;
  res.status(409).json({ error: refusal, projectClosed: true });
  return true;
}

// GET /api/assets/project/:projectId — role-scoped list for that project
router.get('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  let sql = `${ASSET_SELECT} WHERE a.project_id = $1`;
  const params = [projectId];

  /* Who sees what, and it must agree with canViewAsset — which is the app's
   * one definition of "may this person see this asset". This list is the
   * dashboard and the Assets List; a narrower rule here means an asset the
   * whole rest of the app agrees you may read, which you cannot find.
   *
   * The route has already refused anyone who cannot reach this project, so by
   * here canAccessProject is true. Reading canViewAsset against that:
   *
   *   projectScope 'all'  everything                        -> no filter
   *   assignable          asset.assignee_id === user.id     -> filter, below
   *   leadsTeam           a report's work OR anything in a
   *                       project they can access           -> no filter
   *   anyone else         anything in a project they can
   *                       access                            -> no filter
   *
   * THE leadsTeam FILTER IS GONE, and it was the bug. It read
   * "assignee_id IN (their direct reports)", which was right when a lead's
   * reach was their reports and nothing else. That stopped being true when the
   * review gate was broadened — isTeamLeadOfAsset now covers work whose author
   * reports to nobody, work handed across teams, and any lead granted review.tl
   * — and canViewAsset was widened to match. This query was not, so it was the
   * last place still enforcing the old model.
   *
   * What it did: a lead NAMED AS THE TEAM LEAD OF A PROJECT, whose own reports
   * happened to be working elsewhere, opened that project and got a completely
   * empty board. The project was in their picker, the request returned 200, and
   * every asset in it answered 200 to a direct read. Only the board was empty,
   * and nothing on screen suggested where the work had gone. */
  const def = roleDef(req.user.role);
  if (def.assignable) {
    // A contributor only ever sees their own work — canViewAsset says the same,
    // so this is the one narrowing that belongs here.
    sql += ' AND a.assignee_id = $2';
    params.push(req.user.id);
  }
  sql += ' ORDER BY a.created_at DESC';

  const { rows } = await db.query(sql, params);
  const withDetails = await attachTasksAndNotes(rows, req.user);
  /* What this person already has open, if anything. Sent with the board rather
     than asked per asset: the answer is the same for every row, and the page
     needs it to decide whether to offer Accept and Start at all. */
  res.json({ assets: withDetails, activeWork: await activeWorkFor(req.user) });
});

/* Category is managed in Settings like Scope of Work and Priority, so an
   incoming value is checked against the live list rather than a fixed one.
   Returns an error body, or null when the value is acceptable.

   Empty means "no category" and is always allowed: the list starts empty, and
   an asset without one is a normal asset, not an incomplete one. */
function validateCategory(value) {
  if (value === null || value === undefined || value === '') return null;
  const entry = referenceData.get('categories', value);
  if (!entry || !entry.isActive) {
    return { error: 'Invalid category', field: 'category', allowed: referenceData.keys('categories') };
  }
  return null;
}

// POST /api/assets/project/:projectId — create a new asset
router.post('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  if (await projectClosedResponse(res, projectId)) return undefined;

  const { name, type, category = null, priority = assetImport.defaultPriority(), assigneeId = null, due = null, description = '', manHours = null } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Asset name is required' });
  /* Category is optional — the list ships empty and a studio that has not set
     one up yet must still be able to add assets. A value that IS given has to
     be one of the managed ones, so the column cannot fill with typos. */
  const categoryError = validateCategory(category);
  if (categoryError) return res.status(400).json(categoryError);
  // Asset types are managed in Settings, so validate against the live list
  // rather than one fixed here.
  const assetType = referenceData.get('asset_types', type);
  if (!assetType || !assetType.isActive) {
    return res.status(400).json({
      error: 'Invalid asset type',
      allowed: referenceData.keys('asset_types'),
    });
  }

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS n FROM assets WHERE project_id = $1 AND `type` = $2',
    [projectId, type]
  );
  const code = `${assetType.codePrefix}-${String(Number(countRows[0].n) + 1).padStart(3, '0')}`;

  // One transaction for the whole creation.
  //
  // These three writes — the asset, the assignment that follows it, and the
  // default checklist — used to run as three unrelated statements. When the
  // middle one failed, the asset row had already been committed and the
  // checklist never ran, so a failed create left a real asset behind: assigned
  // to somebody, status not_started, no tasks, sitting in the Not Assigned
  // column. That is not a hypothetical; it is what a stale status CHECK
  // constraint produced, and it is why "the assigned asset is in the wrong
  // column" survived two fixes to the assignment logic. A create either
  // happens or it does not.
  const id = uuid();
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(
      `INSERT INTO assets (id, \`code\`, \`name\`, \`type\`, category, \`status\`, priority, project_id, assignee_id, created_by, due_date, description, man_hours)
       VALUES ($1,$2,$3,$4,$5,'not_started',$6,$7,$8,$9,$10,$11,$12)`,
      [id, code, name.trim(), type, category || null, priority, projectId, assigneeId, req.user.id, due, description, manHours]
    );
  // Created Not Assigned, as the pipeline says. If it was created with somebody
  // already on it, the same rule that applies to assigning later applies here:
  // assignment is what starts the work.
  if (assigneeId) {
    // The first stretch-with-one-person on this asset.
    await assignments.open(conn, {
      assetId: id, userId: assigneeId, assignedById: req.user.id, status: 'not_started',
    });
    const { rows: fresh } = await conn.query('SELECT * FROM assets WHERE id = $1', [id]);
    const ctx = await contextFor(req, fresh[0]);
    const verdict = workflow.evaluate('assign', ctx);
    if (verdict.ok) {
      await applyTransition(req, res, fresh[0], verdict, { note: verdict.describe, conn });
    } else {
      // This must not happen: the INSERT above has already written the
      // assignee, so skipping the transition leaves an asset that is assigned
      // to somebody and still reads Not Assigned. It did happen — the
      // transition asked for asset.edit while creating asked for asset.add —
      // and the silence is why it took three passes to find. Say so.
      console.error(
        `Asset ${code} was created with an assignee but the assign transition was refused: `
        + `${verdict.error} (actor ${req.user.email}, role ${req.user.role}). `
        + 'The asset is assigned and still reads Not Assigned.'
      );
    }
  }

  const defaultTasks = ['Rough pass', 'Clean line', 'Color / shade'];
    for (let i = 0; i < defaultTasks.length; i++) {
      await conn.query(
        'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ($1,$2,$3,0,$4)',
        [uuid(), id, defaultTasks[i], i]
      );
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
  const [withDetails] = await attachTasksAndNotes(rows, req.user);
  res.status(201).json({ asset: withDetails });
});

// PATCH /api/assets/:id — update status / priority / description / assignee
router.patch('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;

  // Two permissions, two questions. Changing who an asset is assigned to is
  // asset.assign; changing the record itself — its priority, its brief, its
  // deadline — is asset.edit. This gate used to demand asset.edit for both, so
  // a role holding asset.assign and not asset.edit was refused the one thing
  // its permission was for, and the panel offered it a dropdown the API then
  // rejected. Ask for what the request actually changes.
  const EDIT_FIELDS = ['status', 'priority', 'description', 'due', 'manHours', 'referenceLink', 'category'];
  const wantsEdit = EDIT_FIELDS.some((k) => req.body && req.body[k] !== undefined);
  const wantsAssign = Boolean(req.body) && req.body.assigneeId !== undefined
    && req.body.assigneeId !== asset.assignee_id;
  const mayEdit = await canEditAsset(req.user, asset);
  if (wantsEdit && !mayEdit) {
    return res.status(403).json({ error: 'You cannot edit this asset' });
  }
  if (wantsAssign && !(await mayAssign(req.user, asset))) {
    return res.status(403).json({ error: 'You do not have permission to assign this asset.', field: 'assigneeId' });
  }
  // A request that changes nothing either way still has to be somebody's to make.
  if (!wantsEdit && !wantsAssign && !mayEdit) {
    return res.status(403).json({ error: 'You cannot edit this asset' });
  }

  // --- work out what to write, and refuse before opening a transaction -------
  //
  // Every refusal has to happen up here. An early return from inside an open
  // transaction hands the pool back a connection with uncommitted work on it,
  // and the next request to borrow that connection inherits it.
  const fields = [];
  const values = [];
  let i = 1;
  let overrideEvent = null;

  if (req.body.status !== undefined) {
    const freeMove = workflow.FREE_STATUSES.includes(req.body.status)
      && workflow.FREE_STATUSES.includes(asset.status);
    // Anything else is a move the pipeline would not make. Allowed only for
    // somebody holding the override permission, and recorded as an event so a
    // status that skipped the review flow is not a mystery later.
    if (!freeMove && !canOverrideStage(req.user)) {
      return res.status(409).json({ error: 'Status moves through review are handled by the submit/review/deliver actions, not a direct edit' });
    }
    if (!freeMove && !workflow.STATE_IDS.includes(req.body.status)) {
      return res.status(400).json({ error: `"${req.body.status}" is not a status.`, field: 'status' });
    }
    if (!freeMove) {
      overrideEvent = [uuid(), asset.id, asset.status, req.body.status, req.user.id, req.user.email,
        'Status forced outside the review flow', asset.routed_to_id];
    }
  }

  // The brief's link. Optional, and validated by the same rules a submission
  // link is — so "that is not a valid link" means the same thing in both
  // places. Clearing it is sending an empty string.
  if (req.body.referenceLink !== undefined) {
    const verdict = submissionLink.validate(req.body.referenceLink, { optional: true });
    if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: 'referenceLink' });
    fields.push(`reference_link = $${i++}`);
    values.push(verdict.link);
  }

  if (req.body.category !== undefined) {
    const categoryError = validateCategory(req.body.category);
    if (categoryError) return res.status(400).json(categoryError);
  }

  /* Lead / Supervisor Notes. Refused rather than ignored: quietly dropping a
     field somebody typed into is how they find out a week later that none of
     it saved. The read side hides the field from these roles anyway, so this
     is the second half of one gate rather than a second gate. */
  if (req.body.leadNotes !== undefined) {
    if (!holds(req.user, 'asset.lead_notes')) {
      return res.status(403).json({
        error: 'Your role does not hold Lead / Supervisor Notes.',
        field: 'leadNotes',
      });
    }
    const text = req.body.leadNotes === null ? null : String(req.body.leadNotes);
    if (text !== null && text.length > 20000) {
      return res.status(400).json({ error: 'Those notes are too long to store.', field: 'leadNotes' });
    }
    fields.push(`lead_notes = $${i++}`);
    values.push(text && text.trim() ? text.trim() : null);
  }

  for (const key of ['status', 'priority', 'description', 'assignee_id', 'due_date', 'man_hours', 'category']) {
    const bodyKey = key === 'assignee_id' ? 'assigneeId' : key === 'due_date' ? 'due' : key === 'man_hours' ? 'manHours' : key;
    if (req.body[bodyKey] !== undefined) {
      fields.push(`\`${key}\` = $${i++}`);
      // Clearing a category comes through as '' from a <select>; store the
      // absence as NULL so "no category" is one value, not two.
      values.push(key === 'category' && req.body[bodyKey] === '' ? null : req.body[bodyKey]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);

  // --- one transaction for every write this request makes --------------------
  //
  // Reassigning an asset is two writes: the row, and the history row saying who
  // moved it. They ran unrelated, so when the history INSERT failed — an
  // asset_events table from an older version, missing routed_to_id or note —
  // the assignment had already committed and the request still answered 500.
  // The user was told the change had failed, over a change that had happened,
  // and the page then put back the value it thought was still current. Wrong in
  // both directions from one unrelated failure. Both halves land, or neither.
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');

    if (overrideEvent) {
      await conn.query(
        `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, routed_to_id)
         VALUES ($1,$2,'override',$3,$4,$5,$6,$7,$8)`,
        overrideEvent
      );
    }

    await conn.query(`UPDATE assets SET ${fields.join(', ')} WHERE id = $${i}`, values);

    // Changing who an asset is assigned to means the same thing however it was
    // asked for. The Hand over button and this panel dropdown are two controls
    // for one operation, and they used to disagree: the button ran the proper
    // transition, while this path only swapped the name when the asset was Not
    // Assigned and otherwise left the status alone. So changing the assignee of
    // SUBMITTED work through the dropdown left it in TL Review with the new
    // person's name on it — assigned to them, and nowhere near the Assigned
    // column they were looking in. One operation, one rule.
    //
    //   from Not Assigned   'assign'          -> Assigned
    //   from a review queue 'reassign_review' -> Assigned, a fresh round
    //   anything else       the status stays; only the routing and the trail move
    const assigneeChanged = req.body.assigneeId !== undefined && req.body.assigneeId !== asset.assignee_id;
    const transitionFor = (status) => {
      if (status === 'not_started') return 'assign';
      if (['pending_tl_review', 'pending_cd_review'].includes(status)) return 'reassign_review';
      return null;
    };

    // A different person means a different stretch of work. Their clock reads
    // nothing because their episode is new, and the last person's hours stay on
    // theirs. Work coming back to the SAME person changes no assignee, so no
    // episode ends and their number keeps climbing — the two cases separate
    // themselves here, on the one question that actually distinguishes them.
    if (assigneeChanged) {
      await workLog.close(conn, req.params.id, req.body.assigneeId ? 'reassigned' : 'unassigned');
      await assignments.open(conn, {
        assetId: req.params.id, userId: req.body.assigneeId || null,
        assignedById: req.user.id, status: asset.status,
      });
    }
    const moveFor = assigneeChanged && req.body.assigneeId ? transitionFor(asset.status) : null;
    if (moveFor) {
      const { rows: fresh } = await conn.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
      const ctx = await contextFor(req, fresh[0]);
      const verdict = workflow.evaluate(moveFor, ctx);
      if (verdict.ok) {
        // Handing submitted work on says so in the trail, and says what the
        // outgoing round finished on — the same record the Hand over button
        // leaves, because it is the same event.
        let note = verdict.describe;
        if (moveFor === 'reassign_review') {
          const outgoing = await assignments.current(conn, req.params.id);
          let spent = 0;
          if (outgoing) {
            const { rows: sec } = await conn.query(
              'SELECT COALESCE(SUM(COALESCE(seconds, 0)), 0) AS s FROM work_sessions WHERE assignment_id = $1',
              [outgoing.id]
            ).catch(() => ({ rows: [{ s: 0 }] }));
            spent = Number(sec[0].s) || 0;
          }
          const outgoingName = await nameOfUser(conn, asset.assignee_id);
          const incomingName = await nameOfUser(conn, req.body.assigneeId);
          note = `Reassigned from ${outgoingName} to ${incomingName} while in ${workflow.label(asset.status)}. `
            + `${outgoingName} recorded ${fmtSeconds(spent)} on their round; ${incomingName} starts a new one.`;
        }
        await applyTransition(req, res, fresh[0], verdict, { note, conn });
      } else {
        // The UPDATE above has already written the assignee, so skipping the
        // transition would leave an asset assigned to somebody and still
        // reading Not Assigned. It did happen once — the transition asked for
        // asset.edit while assigning asked for asset.assign — and the silence
        // is why it took three passes to find. Never pass it unrecorded.
        console.error(
          `Asset ${asset.code} was assigned but the assign transition was refused: `
          + `${verdict.error} (actor ${req.user.email}, role ${req.user.role}). `
          + 'The asset is assigned and still reads Not Assigned.'
        );
      }
    } else if (assigneeChanged) {
      // Still note who it moved to, so the trail does not lose a reassignment
      // made mid-review.
      await conn.query('UPDATE assets SET routed_to_id = $1 WHERE id = $2 AND routed_to_id IS NOT NULL',
        [req.body.assigneeId || null, req.params.id]);

      // And record it. This used to update the routing and say nothing, so an
      // asset could change hands mid-pipeline with no trace of who moved it or
      // when — the one question the history exists to answer.
      const from = await nameOfUser(conn, asset.assignee_id);
      const to = await nameOfUser(conn, req.body.assigneeId);
      await conn.query(
        `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, routed_to_id)
         VALUES ($1,$2,'reassign',$3,$4,$5,$6,$7,$8)`,
        [uuid(), asset.id, asset.status, asset.status, req.user.id, req.user.email,
         `Reassigned from ${from} to ${to}`, req.body.assigneeId || null]
      );
    }

    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // Committed. Nothing past this point may fail the request:
  // attachTasksAndNotes degrades rather than throwing, so building the response
  // cannot report a failure over a change that has already happened.
  const { rows: updated } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(updated, req.user);
  res.json({ asset: withDetails });
});

// DELETE /api/assets/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  if (!(await canDeleteAsset(req.user, asset))) {
    return res.status(403).json({ error: 'You cannot delete this asset' });
  }
  await db.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// The checklist.
//
// Its own permission question — see canManageTasks in src/permissions.js. The
// asset's record belongs to whoever wrote the brief; the checklist belongs to
// the people doing and checking the work.
async function taskGuard(req, res, assetId) {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [assetId]);
  const asset = rows[0];
  if (!asset) { res.status(404).json({ error: 'Asset not found' }); return null; }
  if (await projectClosedResponse(res, asset.project_id)) return null;
  if (!(await canManageTasks(req.user, asset))) {
    res.status(403).json({
      error: 'The checklist is set by whoever added this asset and by its reviewers. '
        + 'Being assigned the work does not carry the right to change what the work is.',
    });
    return null;
  }
  return asset;
}

function checkTaskName(name) {
  if (typeof name !== 'string' || !name.trim()) return { error: 'Task name is required', field: 'name' };
  if (name.trim().length > 255) return { error: 'That task is too long (255 characters at most)', field: 'name' };
  return null;
}

// GET /api/assets/:id/tasks — the checklist, with who added each item.
router.get('/:id/tasks', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const { rows: tasks } = await db.query(
    `SELECT t.*, u.\`name\` AS created_by_name, u.avatar_updated_at AS created_by_photo_at
       FROM tasks t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.asset_id = $1 ORDER BY t.\`position\``,
    [req.params.id]
  );
  res.json({
    tasks: tasks.map((t) => ({ ...t, done: Boolean(t.done) })),
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    canManage: await canManageTasks(req.user, asset),
  });
});

// PATCH /api/assets/tasks/:id — rename a checklist item.
router.patch('/tasks/:id/text', async (req, res) => {
  const { rows } = await db.query('SELECT asset_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  if (!(await taskGuard(req, res, rows[0].asset_id))) return undefined;

  const bad = checkTaskName(req.body && req.body.name);
  if (bad) return res.status(400).json({ error: bad.error, field: bad.field });

  await db.query('UPDATE tasks SET `name` = $1 WHERE id = $2', [req.body.name.trim(), req.params.id]);
  return res.json({ ok: true, name: req.body.name.trim() });
});

// DELETE /api/assets/tasks/:id — remove a checklist item.
router.delete('/tasks/:id', async (req, res) => {
  const { rows } = await db.query('SELECT asset_id, `name` FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  if (!(await taskGuard(req, res, rows[0].asset_id))) return undefined;
  await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  return res.json({ ok: true });
});

// POST /api/assets/:id/tasks — add a checklist item
router.post('/:id/tasks', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await taskGuard(req, res, req.params.id))) return undefined;
  const { name } = req.body || {};
  const bad = checkTaskName(name);
  if (bad) return res.status(400).json({ error: bad.error, field: bad.field });

  const { rows: posRows } = await db.query('SELECT COUNT(*) AS n FROM tasks WHERE asset_id = $1', [req.params.id]);
  const id = uuid();
  await db.query(
    'INSERT INTO tasks (id, asset_id, `name`, done, `position`, created_by) VALUES ($1,$2,$3,0,$4,$5)',
    [id, req.params.id, name.trim(), Number(posRows[0].n), req.user.id]
  );
  return res.status(201).json({
    task: {
      id, asset_id: req.params.id, name: name.trim(), done: false,
      created_by: req.user.id, created_by_name: req.user.name,
      created_by_photo_at: req.user.photoUpdatedAt || null,
    },
  });
});

// PATCH /api/tasks/:id — toggle done
router.patch('/tasks/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.*, a.project_id, a.assignee_id AS asset_assignee_id, a.created_by AS asset_created_by, a.id AS parent_asset_id
     FROM tasks t JOIN assets a ON a.id = t.asset_id WHERE t.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Task not found' });
  if (!(await taskGuard(req, res, row.parent_asset_id))) return undefined;
  const { done } = req.body || {};
  await db.query('UPDATE tasks SET done = $1 WHERE id = $2', [done ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

// POST /api/assets/:id/notes — leave a review note
router.post('/:id/notes', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text is required' });
  const id = uuid();
  await db.query(
    'INSERT INTO notes (id, asset_id, author_id, `text`) VALUES ($1,$2,$3,$4)',
    [id, req.params.id, req.user.id, text.trim()]
  );
  res.status(201).json({ note: { id, asset_id: req.params.id, author_id: req.user.id, author_name: req.user.name, text: text.trim() } });
});

// POST /api/assets/:id/submit — artist uploads a file for review.
// Where it routes depends on what stage the asset is coming from:
//  - fresh work or a team-lead rework request goes to the team lead
//  - a creative-director rework request goes straight back to the CD (already passed TL)
// Everything the state machine needs to judge a move. Gathered once so the
// permission questions are asked the same way for every action.
async function contextFor(req, asset) {
  return {
    user: req.user,
    asset,
    isTeamLead: await isTeamLeadOfAsset(req.user, asset),
    canOverride: canOverrideReview(req.user),
    canEdit: await canEditAsset(req.user, asset),
    // Separate from canEdit on purpose: assigning is its own permission, and
    // the assign transition asks for this one.
    canAssign: await mayAssign(req.user, asset),
    // Wider still, and only for handing submitted work on — see
    // canHandOverInReview. The reviewer holding it counts, not just the creator.
    canHandOver: await canHandOverInReview(req.user, asset),
    canDeliver: await canMarkDelivered(req.user, asset),
    // The two halves of the Creative Director's gate, from the role's
    // permissions rather than from its tier.
    canReviewCd: canReviewAsCD(req.user),
    canApproveForClient: holds(req.user, 'review.approve_client'),
    // The authority to take the Creative Director out of the loop. Separate
    // from review.tl, which is the standing to act at the TL gate at all — a
    // lead needs both to send work straight to the client.
    canSendToClient: holds(req.user, 'review.tl_send_client'),
    /* The client's round. Three separate permissions, because they are three
       separate decisions — see the catalogue. Scope still comes from the role,
       the same way canMarkDelivered pairs review.deliver with project reach. */
    canSendForClientFeedback: holds(req.user, 'review.client_send') && await canAccessProject(req.user, asset.project_id),
    canDeliverFromClient: holds(req.user, 'review.client_deliver') && await canAccessProject(req.user, asset.project_id),
    canReturnFromClient: holds(req.user, 'review.client_return') && await canAccessProject(req.user, asset.project_id),
  };
}

// Apply a transition the state machine has approved: move the asset, record the
// event, and hand back the asset as the API describes it everywhere else.
//
// The event row is the point. Status alone cannot answer "who sent this back
// and what did they say", and that is the question the asset detail view exists
// to answer.
// `conn` runs the writes on a caller's open transaction rather than the pool,
// so a transition that fails takes the rest of that transaction down with it.
async function applyTransition(req, res, asset, verdict, { note, versionId, conn, batchId } = {}) {
  const run = conn || db;
  await run.query(
    'UPDATE assets SET `status` = $1, routed_to_id = $2 WHERE id = $3',
    [verdict.to, verdict.routedTo, asset.id]
  );
  /* batch_id is the only thing a bulk action adds to an event, and it is
     nullable: a bulk delivery writes the SAME row a single delivery writes,
     and additionally says which act it was part of. Falls back to the older
     INSERT on a deployment whose migration has not added the column, so a
     missing repair costs the batch link rather than the delivery. */
  const columns = 'id, asset_id, action, from_status, to_status, actor_id, actor_email, note, version_id, routed_to_id';
  const values = [uuid(), asset.id, verdict.action, asset.status, verdict.to, req.user.id, req.user.email,
    String(note || '').trim() || null, versionId || null, verdict.routedTo];
  try {
    await run.query(
      `INSERT INTO asset_events (${columns}, batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [...values, batchId || null]
    );
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await run.query(
      `INSERT INTO asset_events (${columns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      values
    );
  }
  /* The Activity Log's copy of the same transition.
   *
   * Here rather than in each route because every status change in the
   * application goes through this function — that is what makes the log's
   * coverage of the workflow complete rather than a list of the transitions
   * somebody remembered. asset_events is written above and is untouched; it
   * stays the authority for an asset's own history panel.
   *
   * A bulk action calls this once per asset inside one request, and the
   * middleware writes one entry per request, so the transitions are counted
   * and the last one describes the batch. One line saying "delivered 40
   * assets" is what a person reading a timeline wants; forty identical lines
   * is what would bury everything else that happened that day. */
  if (typeof req.activity === 'function') {
    req._assetMoves = (req._assetMoves || 0) + 1;
    const many = req._assetMoves > 1;
    req.activity({
      module: 'assets',
      action: `asset.${verdict.action}`,
      entityType: 'asset',
      entityId: many ? null : asset.id,
      entityLabel: many ? `${req._assetMoves} assets` : `${asset.code || ''} ${asset.name || ''}`.trim(),
      summary: many
        ? `${verdict.action.replace(/_/g, ' ')} — ${req._assetMoves} assets`
        : `${asset.code || 'Asset'}: ${asset.status} → ${verdict.to}`,
      changes: many ? null : { status: { from: asset.status, to: verdict.to } },
    });
  }

  const { rows: updated } = await run.query(`${ASSET_SELECT} WHERE a.id = $1`, [asset.id]);
  const [withDetails] = await attachTasksAndNotes(updated, req.user);
  return withDetails;
}

/* Declared before every '/:id/...' route below, and it has to stay there.
 * Express matches in definition order: '/:id/deliver' matches '/bulk/deliver'
 * perfectly well, with id = "bulk", and answers "Asset not found". Moving this
 * further down the file breaks it in a way that reads as a missing asset
 * rather than as a routing mistake — tests/bulk-deliver.test.js pins it.
 */
/* POST /api/assets/bulk/deliver — mark several assets delivered at once.
 *
 * body: { assetIds: [...], note? }
 *
 * The whole design of this is "do exactly what the single-asset route does, N
 * times, and say what happened to each". Every asset goes through the same
 * three steps that route uses — contextFor, workflow.evaluate('deliver'),
 * applyTransition — so the permission check, the state-machine guard, the
 * status write and the event row are not reimplemented here and cannot drift
 * from the single case. That is also what makes the workflow safe: `deliver` is
 * defined `from: ['approved_for_client']`, so an asset that has not finished
 * review is refused by the same table that refuses it one at a time. There is
 * no way to bulk-deliver past the review process, and none is added here.
 *
 * Each asset succeeds or fails ON ITS OWN. One refusal does not roll back the
 * rest — a producer delivering twenty assets should not lose nineteen good
 * deliveries because the twentieth was still in review — so the reply is a
 * per-asset result rather than a status code, and the caller is told which is
 * which. The batch row records the act itself: who, when, how many asked for
 * and how many landed.
 */
const BULK_DELIVER_MAX = 200;

router.post('/bulk/deliver', async (req, res) => {
  const { assetIds, note } = req.body || {};
  if (!Array.isArray(assetIds) || !assetIds.length) {
    return res.status(400).json({ error: 'Choose at least one asset to deliver.', field: 'assetIds' });
  }
  // De-duplicated, because a list sent twice should deliver once and report once.
  const ids = [...new Set(assetIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length > BULK_DELIVER_MAX) {
    return res.status(400).json({
      error: `That is ${ids.length} assets. ${BULK_DELIVER_MAX} at a time is the most this will do in one go.`,
      field: 'assetIds',
    });
  }

  const { rows: found } = await db.query(`${ASSET_SELECT} WHERE a.id IN ($1)`, [ids]);
  const byId = new Map(found.map((row) => [row.id, row]));

  const batchId = uuid();
  const results = [];
  for (const id of ids) {
    const asset = byId.get(id);
    if (!asset) {
      results.push({ id, ok: false, error: 'That asset no longer exists.' });
      continue;
    }
    const label = { id, code: asset.code, name: asset.name };
    try {
      // A closed project refuses every write, in bulk as singly. Asked through
      // the same lifecycle module rather than by re-reading the rule.
      const { rows: project } = await db.query('SELECT * FROM projects WHERE id = $1', [asset.project_id]);
      const shut = project.length ? lifecycle.projectRefusal(project[0]) : null;
      if (shut) { results.push({ ...label, ok: false, error: shut }); continue; }

      const ctx = await contextFor(req, asset);
      const verdict = workflow.evaluate('deliver', ctx, { note });
      if (!verdict.ok) { results.push({ ...label, ok: false, error: verdict.error }); continue; }

      await applyTransition(req, res, asset, verdict, { note, batchId });
      results.push({ ...label, ok: true, status: verdict.to });
    } catch (err) {
      // One asset failing on something unforeseen must not take the batch with
      // it. Logged in full server-side; the caller is told which one and that
      // it did not land.
      console.error(`[bulk deliver] ${asset.code} failed: ${err.stack || err.message}`);
      results.push({ ...label, ok: false, error: 'Something went wrong delivering this one.' });
    }
  }

  const delivered = results.filter((r) => r.ok).length;
  /* Written after the fact, holding what actually happened rather than what was
     asked for. Swallowed on failure: a batch whose summary row could not be
     written is still a batch that delivered the work, and the per-asset events
     are the record that matters. */
  try {
    await db.query(
      `INSERT INTO asset_event_batches (id, action, actor_id, actor_email, requested, succeeded)
       VALUES ($1,'deliver',$2,$3,$4,$5)`,
      [batchId, req.user.id, req.user.email, ids.length, delivered]
    );
  } catch (err) {
    console.warn(`[bulk deliver] could not record the batch ${batchId}: ${err.message}`);
  }

  console.log(
    `${req.user.email} delivered ${delivered} of ${ids.length} asset(s) in one action `
    + `(batch ${batchId}${delivered < ids.length ? `; refused: ${results.filter((r) => !r.ok).map((r) => r.code || r.id).join(', ')}` : ''}).`
  );

  res.json({ batchId, requested: ids.length, delivered, failed: ids.length - delivered, results });
});

// POST /api/assets/:id/submit — the assignee sends work for review.
// body: { link (required), description (optional) }; a file may still be
// attached alongside, for studios that were uploading them.
router.post('/:id/submit', upload.single('file'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('submit', ctx);
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

  const link = submissionLink.validate(req.body ? req.body.link : '');
  if (!link.ok) return res.status(400).json({ error: link.error, field: 'link' });
  const description = String((req.body && req.body.description) || '').trim() || null;

  // Which gate this submission is aimed at, so the reviewer sees the round that
  // was meant for them.
  const stage = verdict.to === 'pending_cd_review' ? 'cd' : 'tl';

  // Submitting stamps the end. Before the version row is written, so the round
  // is closed against the round number it belongs to rather than the next one.
  await workLog.close(db, req.params.id, 'submitted');

  const { rows: vCount } = await db.query('SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = $1', [req.params.id]);
  const versionNumber = Number(vCount[0].n) + 1;
  const versionId = uuid();
  await db.query(
    `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description, file_name, file_path, file_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [versionId, req.params.id, versionNumber, stage, link.link, description,
     req.file ? req.file.originalname : null, req.file ? req.file.filename : null,
     req.file ? req.file.size : null, req.user.id]
  );

  // Every round is kept: the submission table is append-only, so a re-submission
  // after changes adds a version rather than replacing the one that was rejected.
  const withDetails = await applyTransition(req, res, asset, verdict, { note: description, versionId });
  res.status(201).json({ asset: withDetails });
});

// --- the work log -------------------------------------------------------------
//
// Who may stamp the start on an asset: the person it is assigned to, or a
// full-access role for oversight. Not the creator — the log records the
// assignee's own stretch of work, and nobody else should be able to open one
// under their name.
function mayStartWork(req, asset) {
  if (hasFullAccess(req.user)) return true;
  return Boolean(asset.assignee_id) && asset.assignee_id === req.user.id;
}

// The statuses in which starting work makes sense. The two changes-requested
// states are here because a rework round is the same cycle again — accept the
// rework, submit — with the next round number, exactly as the first round was.
/* The one task this person has under way, in the shape the page reads.
 *
 * null when they are free. Used by the board, by a single asset's drawer and by
 * the refusal in /start, so "what is holding me up" has one answer everywhere
 * rather than three that can drift. */
async function activeWorkFor(user) {
  const open = await workLog.openForUser(db, user.id).catch(() => null);
  if (!open) return null;
  return {
    assetId: open.assetId,
    code: open.code,
    name: open.name,
    status: open.status,
    since: open.since,
  };
}

/* Setting and removing the preview image.
 *
 * In memory rather than on disk: one small image on its way into a row, so a
 * temp file would only be something to clean up. The cap is set here so multer
 * refuses an oversized upload before it is all read, and again inside
 * src/asset-thumbnail.js for a request that arrives another way.
 */
const uploadThumbnail = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: assetThumbnail.MAX_THUMBNAIL_BYTES, files: 1 },
});

/* multer aborts an oversized upload before the handler runs, and its own error
   is a 500 with a code nobody can act on. Turned into the same sentence the
   module would have given, with the limit in it. */
const acceptThumbnail = (req, res, next) => uploadThumbnail.single('image')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `That image is larger than the ${Math.round(assetThumbnail.MAX_THUMBNAIL_BYTES / (1024 * 1024))}MB limit.`,
      field: 'image',
    });
  }
  return res.status(400).json({ error: 'That upload could not be read.', field: 'image' });
});

// One answer to "may this person change this asset's preview", used by both
// routes below so they cannot come to different conclusions.
async function thumbnailGuard(req, res) {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) { res.status(404).json({ error: 'Asset not found' }); return null; }
  if (await projectClosedResponse(res, asset.project_id)) return null;
  if (!(await assetThumbnail.mayChange(permissions, req.user, asset))) {
    res.status(403).json({
      error: 'Only the person this asset is assigned to, or somebody who can edit it, '
        + 'can change its preview image.',
    });
    return null;
  }
  return asset;
}

/* One endpoint for both ways of setting a preview, because they set the same
   thing. A multipart request carries a file; a JSON one carries a link. Which
   arrived decides which branch runs, and either writes the one row — so
   providing one replaces the other with nothing left to remember. */
router.post('/:id/thumbnail', acceptThumbnail, async (req, res) => {
  const asset = await thumbnailGuard(req, res);
  if (!asset) return undefined;

  const rawUrl = (req.body || {}).sourceUrl;
  const wantsLink = !req.file && rawUrl !== undefined && rawUrl !== null;
  if (!req.file && !wantsLink) {
    return res.status(400).json({ error: 'Choose an image, or paste a link to one.', field: 'image' });
  }

  // What was there before, so the entry can say replaced rather than added,
  // and say what it was replaced FROM.
  const before = await assetThumbnail.describe(db, req.params.id).catch(() => null);

  const saved = wantsLink
    ? await assetThumbnail.saveUrl(db, req.params.id, rawUrl, req.user)
    : await assetThumbnail.save(db, req.params.id,
      { buffer: req.file.buffer, mime: req.file.mimetype }, req.user);
  if (!saved.ok) {
    return res.status(saved.status).json({ error: saved.error, field: wantsLink ? 'sourceUrl' : 'image' });
  }

  const was = before ? (before.source === 'link' ? `a link (${before.url})` : 'an uploaded image') : null;
  const now = saved.source === 'link' ? `a link (${saved.url})` : `an uploaded ${saved.mime}`;
  req.activity({
    module: 'assets', action: 'asset.thumbnail', entityType: 'asset',
    entityId: asset.id, entityLabel: `${asset.code || ''} ${asset.name || ''}`.trim(),
    summary: `${before ? 'Replaced' : 'Added'} the preview image on ${asset.code || 'an asset'}`
      + ` — ${saved.source === 'link' ? 'a pasted link' : 'an uploaded file'}`,
    changes: { thumbnail: { from: was, to: now } },
  });

  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(rows, req.user);
  return res.json({ asset: withDetails });
});

router.delete('/:id/thumbnail', async (req, res) => {
  const asset = await thumbnailGuard(req, res);
  if (!asset) return undefined;
  const had = await assetThumbnail.describe(db, req.params.id).catch(() => null);
  await assetThumbnail.clear(db, req.params.id);
  if (had) {
    req.activity({
      module: 'assets', action: 'asset.thumbnail_removed', entityType: 'asset',
      entityId: asset.id, entityLabel: `${asset.code || ''} ${asset.name || ''}`.trim(),
      summary: `Removed the preview image from ${asset.code || 'an asset'}`,
      changes: {
        thumbnail: { from: had.source === 'link' ? `a link (${had.url})` : 'an uploaded image', to: null },
      },
    });
  } else {
    // Removing what was not there is not an action.
    req.activitySkip();
  }
  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(rows, req.user);
  return res.json({ asset: withDetails });
});

const STARTABLE = ['assigned', 'in_progress', 'tl_changes_requested', 'cd_changes_requested'];

// POST /api/assets/:id/start — Accept and Start.
//
// The only way a session opens. It stamps started_at and, from 'assigned', also
// moves the asset to In Progress through the state machine's own accept
// transition rather than a side door. There is no Resume: a round is one span
// from this click to the submission, and that span is its Time Spent.
router.post('/:id/start', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  if (!mayStartWork(req, asset)) {
    return res.status(403).json({ error: 'Only the person this asset is assigned to can start work on it.' });
  }
  if (!STARTABLE.includes(asset.status)) {
    return res.status(409).json({
      error: `Work can only be started while it is on somebody's desk — this asset is in ${workflow.label(asset.status)}.`,
    });
  }
  // CD Feedbacks sits with the lead until relayed; the assignee cannot start
  // reworking what they have not been handed.
  if (asset.status === 'cd_changes_requested' && asset.routed_to_id !== req.user.id && !hasFullAccess(req.user)) {
    return res.status(409).json({ error: 'The team lead has not passed the Creative Director\'s notes on yet.' });
  }

  /* One active task at a time.
   *
   * Deliberately ABOVE the accept transition rather than beside the session
   * start below it. Accepting moves the asset to In Progress and is the part
   * that cannot be undone; refusing after that would leave somebody holding an
   * asset they were then told they may not start, which is a worse state than
   * either answer. So the rule is applied while nothing has happened yet.
   *
   * Checked against an open work session rather than the in_progress status,
   * because rework after TL or CD Feedbacks is started with this same button
   * and never becomes in_progress — see workLog.openForUser.
   *
   * Scoped to this endpoint and no other: it stops somebody starting a SECOND
   * piece of their own work, and has nothing to say about reviewing, approving,
   * relaying feedback or filling in a timesheet. A lead with their own asset
   * under way still runs their queue.
   */
  const elsewhere = await workLog.openForUser(db, req.user.id, req.params.id);
  if (elsewhere) {
    return res.status(409).json({
      error: `Finish your current task before starting another — `
        + `${elsewhere.code || 'an asset'}${elsewhere.name ? ` (${elsewhere.name})` : ''} `
        + 'is still open. Submit it for review and this one will unlock.',
      activeWork: {
        assetId: elsewhere.assetId,
        code: elsewhere.code,
        name: elsewhere.name,
        since: elsewhere.since,
      },
    });
  }

  // Accepting the work comes first, and happens whether or not the start can
  // be recorded.
  //
  // These were the other way round, with a 503 above the transition — so on a
  // deployment whose work_sessions table could not be created, an artist could
  // not accept an asset, and it could never leave Assigned. Recording the time
  // is the part that degrades; taking the work is not optional. This matters
  // more now that submitting requires the work to have been started.
  let moved = null;
  if (asset.status === 'assigned') {
    const ctx = await contextFor(req, asset);
    const verdict = workflow.evaluate('accept', ctx);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
    moved = await applyTransition(req, res, asset, verdict, { note: verdict.describe });
  }

  // Nowhere to write the stamp says so plainly, rather than answering with a
  // database error — but only after the work has been accepted.
  if (!(await workLog.available(db))) {
    return res.status(moved ? 200 : 503).json({
      asset: moved || undefined,
      accepted: Boolean(moved),
      workLogUnavailable: true,
      error: 'Time recording is not available on this deployment yet — its table has not been created. See /api/health.',
    });
  }

  const episode = await assignments.current(db, req.params.id);
  const started = await workLog.start(db, req.params.id, req.user.id, episode && episode.id);
  if (!started.ok) {
    // The double-click, the second tab, or a colleague a moment faster. The
    // start is already stamped, so say when.
    return res.status(409).json({ error: 'Work has already been started on this asset.', open: true, since: started.since });
  }

  const work = await workLog.summary(db, req.params.id, episode && episode.id, asset.assignee_id);
  if (moved) return res.status(200).json({ asset: moved, work, accepted: true });
  const { rows: fresh } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(fresh, req.user);
  return res.json({ asset: withDetails, work });
});

/* There is deliberately no pause endpoint.
 *
 * Pause and Resume were removed with the running timer: a round is now one span
 * from Accept and Start to Submit for Review, and Time Spent is the difference
 * between those two stamps. Every close of a session happens as a consequence
 * of something else — submitting, being reassigned, being unassigned — so
 * nothing a person clicks can end one on its own. */

// GET /api/assets/:id/worklog — the stamps, the elapsed total and the per-round
// breakdown. Readable by anyone who can see the asset.
router.get('/:id/worklog', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const held = await assignments.current(db, req.params.id);
  res.json({
    work: await workLog.summary(db, req.params.id, held && held.id, asset.assignee_id),
    canStart: mayStartWork(req, asset),
  });
});

// GET /api/assets/versions/:versionId/download — stream the uploaded file
router.get('/versions/:versionId/download', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM asset_versions WHERE id = $1', [req.params.versionId]);
  const version = rows[0];
  if (!version) return res.status(404).json({ error: 'File not found' });
  const { rows: assetRows } = await db.query('SELECT * FROM assets WHERE id = $1', [version.asset_id]);
  const asset = assetRows[0];
  if (!asset || !(await canViewAsset(req.user, asset))) {
    return res.status(403).json({ error: 'No access to this file' });
  }
  const filePath = path.join(__dirname, '..', '..', 'uploads', version.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });
  res.download(filePath, version.file_name);
});

// POST /api/assets/:id/review — a review decision at whichever gate the asset
// is sitting at. body: { decision: 'approved' | 'changes_requested', text }
//
// Which gate that is, and who may act on it, is the state machine's answer, not
// this handler's: it maps the decision onto a transition and applies whatever
// comes back.
router.post('/:id/review', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;

  const { decision, text } = req.body || {};
  if (!['approved', 'changes_requested'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "changes_requested"' });
  }

  const stage = asset.status === 'pending_cd_review' ? 'cd' : 'tl';
  const action = `${stage}_${decision === 'approved' ? 'approve' : 'request_changes'}`;

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate(action, ctx, { note: text });
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });
  }

  const { rows: latestVersion } = await db.query(
    'SELECT id FROM asset_versions WHERE asset_id = $1 ORDER BY version_number DESC LIMIT 1',
    [req.params.id]
  );
  const versionId = latestVersion.length ? latestVersion[0].id : null;

  await db.query(
    'INSERT INTO feedback (id, asset_id, version_id, stage, decision, given_by, `text`) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuid(), req.params.id, versionId, stage, decision, req.user.id, String(text || '').trim() || null]
  );

  const withDetails = await applyTransition(req, res, asset, verdict, { note: text, versionId });
  res.json({ asset: withDetails });
});

// POST /api/assets/:id/relay — the team lead passes the Creative Director's
// notes to the assignee.
//
// A separate action because the status does not move: the asset stays in CD
// Changes and only changes desk. Without it the assignee could pick work up
// before the lead who relayed the request had said anything about it.
router.post('/:id/relay', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  if (!asset.assignee_id) {
    return res.status(409).json({ error: 'This asset has nobody assigned to pass it to.' });
  }

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('relay', ctx, { note: req.body && req.body.text });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });

  const withDetails = await applyTransition(req, res, asset, verdict, { note: req.body && req.body.text });
  res.json({ asset: withDetails });
});

/* POST /api/assets/:id/send-to-client — the team lead skips the CD gate.
 *
 * Its own endpoint rather than a third `decision` on /review, for the same
 * reason /relay is its own: it is a different act, not a third opinion. The
 * review route writes a row into `feedback` describing a judgement of the work
 * at a stage; this records that a stage was skipped, which belongs in the event
 * history and nowhere else. Folding it into /review would also have meant
 * widening that table's decision values for something no reviewer ever said.
 *
 * The state machine decides whether it is allowed — both halves of it, the TL
 * standing and review.tl_send_client — so this route only carries the note.
 */
router.post('/:id/send-to-client', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('tl_send_to_client', ctx, { note: req.body && req.body.text });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });

  const withDetails = await applyTransition(req, res, asset, verdict, { note: req.body && req.body.text });
  console.log(`${req.user.email} sent ${asset.code} straight to the client, skipping CD review.`);
  res.json({ asset: withDetails });
});

// POST /api/assets/:id/deliver — mark a client-approved asset as delivered.
router.post('/:id/deliver', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;

  const ctx = await contextFor(req, asset);
  const verdict = workflow.evaluate('deliver', ctx, { note: req.body && req.body.text });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

  const withDetails = await applyTransition(req, res, asset, verdict, { note: req.body && req.body.text });
  res.json({ asset: withDetails });
});

/* The client's round: three endpoints, one per transition.
 *
 * Each is the deliver route with a different action name — load, contextFor,
 * evaluate, applyTransition — so the permission check, the state guard and the
 * audit row are the machinery every other transition already uses. Writing them
 * out rather than folding them into one parameterised handler keeps each URL
 * saying what it does, which is how the rest of this file reads.
 */
function clientStep(action) {
  return async (req, res) => {
    const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
    const asset = rows[0];
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (await projectClosedResponse(res, asset.project_id)) return undefined;

    const note = req.body && req.body.text;
    const ctx = await contextFor(req, asset);
    const verdict = workflow.evaluate(action, ctx, { note });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, field: verdict.field });

    const withDetails = await applyTransition(req, res, asset, verdict, { note });
    console.log(`${req.user.email} ${action} on ${asset.code} (${asset.status} -> ${verdict.to}).`);
    return res.json({ asset: withDetails });
  };
}

// POST /api/assets/:id/send-to-client-review — Approved for Client -> Awaiting Client Feedback.
router.post('/:id/send-to-client-review', clientStep('client_sent'));

// POST /api/assets/:id/client-approved — the client said yes; close it off as Delivered.
router.post('/:id/client-approved', clientStep('client_approved'));

// POST /api/assets/:id/client-changes — the client asked for changes; back to TL Feedbacks.
// body: { text } — required, and it is what the artist will be working from.
router.post('/:id/client-changes', clientStep('client_changes'));

// POST /api/assets/:id/reassign — hand rework to somebody else.
//
// The pipeline sends changes-requested work back to whoever submitted it. This
// is the way out of that: when an asset is sitting in TL Feedbacks or CD Feedbacks,
// the person who added it can put a different artist on the rework instead.
//
// Deliberately not part of PATCH. Reassigning mid-review is a different act
// from correcting a due date — it moves whose desk the asset is on, it belongs
// in the history where the next reviewer will read it, and it is legal in
// exactly two states rather than at every stage.
//
// Nothing is copied to the new assignee, because nothing needs to be: the
// feedback, the submission history and the last link and description all hang
// off the asset, not off the person. Once the asset is theirs they can view it,
// and viewing it brings the whole thread with it.
router.post('/:id/reassign', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;

  // All four stages hand over the same way.
  //
  // Whether the asset is sitting in a review queue or waiting on changes, the
  // person receiving it has not done the work in front of them — so it returns
  // to Assigned and they start from the beginning: their own episode, their own
  // clock from nothing, with everything the previous person did still on the
  // record.
  //
  // The rework stages had a branch of their own that left the status where it
  // was. That made the incoming person the owner of a stage mid-flight: no
  // Accept and Start, and a round already carrying somebody else's history.
  // They take this path now — the one already built and debugged for review
  // handover — rather than a second implementation of the same idea.
  // Whether this person has ANY route to reassigning this asset, asked before
  // the status is looked at. Somebody with no business here is told so, rather
  // than being told which statuses are reassignable — which is not their
  // concern, and which the narrower checks below would otherwise leak.
  const couldEver = await mayAssign(req.user, asset)
    || await isTeamLeadOfAsset(req.user, asset)
    || (canReviewAsCD(req.user) && await canViewAsset(req.user, asset));
  if (!couldEver) {
    return res.status(403).json({ error: 'You do not have permission to hand this asset to somebody else.' });
  }

  // The stages an asset can be handed on from — the workflow's own list, so
  // this cannot drift from what the transition will actually accept.
  const HAND_OVER_STATUSES = workflow.transitionFor('reassign_review').from;
  // Only for wording — the trail and the log read better saying which kind of
  // handover this was. Both take the same path.
  const inReview = ['pending_tl_review', 'pending_cd_review'].includes(asset.status);
  if (!HAND_OVER_STATUSES.includes(asset.status)) {
    return res.status(409).json({
      error: 'Handing an asset to somebody else is only possible while it is waiting on changes or waiting on a reviewer.',
      status: asset.status,
      allowedStatuses: HAND_OVER_STATUSES,
    });
  }

  // One question for all four stages: the person who added the asset, or
  // whoever is holding it right now. Both ask for asset.assign — this is about
  // reach, not about a new permission.
  const allowed = await canHandOverInReview(req.user, asset);
  if (!allowed) {
    return res.status(403).json({
      error: 'Handing this on is for the person who added the asset or whoever is holding it now.',
    });
  }

  const { assigneeId, note } = req.body || {};
  if (!assigneeId) return res.status(400).json({ error: 'Choose who should pick this up.', field: 'assigneeId' });
  if (assigneeId === asset.assignee_id) {
    return res.status(400).json({ error: 'That is already who it is assigned to.', field: 'assigneeId' });
  }

  const { rows: candidate } = await db.query('SELECT id, `name`, `role` FROM users WHERE id = $1', [assigneeId]);
  if (!candidate.length) return res.status(400).json({ error: 'That person no longer exists.', field: 'assigneeId' });
  const next = candidate[0];
  const def = roleDef(next.role);
  if (!def || !def.assignable) {
    return res.status(400).json({
      error: `${next.name} holds a designation that is not assigned work.`,
      field: 'assigneeId',
    });
  }
  /* Deliberately NOT checked: whether this person is on the project.
   *
   * It was, and it is what "Ankita Das is not on this project" was. Handing
   * work on is the one moment the studio reaches outside a project on purpose
   * — the reviewer wants somebody free, and whether that person happens to be
   * attached to this project is not a fact about whether they can do the work.
   *
   * The check also disagreed with the picker in front of it. When "Assign Work
   * to Anyone" arrived, the two assignee dropdowns were taught to honour it and
   * this line was not, so a holder of that permission was offered the whole
   * studio and then refused for choosing from it — a dropdown that lies.
   *
   * Being handed the asset is itself what puts them on the project: an assignee
   * sees their own asset (canViewAsset), and a project with their work in it is
   * in their project list (visibleProjects). So there is nothing to grant.
   *
   * Everything else here stands. Who may hand this on is still checked, three
   * ways, above; the asset must still be in a stage that can be handed on; and
   * the person receiving it must still hold a designation that is given work. */

  const { rows: previous } = await db.query('SELECT `name` FROM users WHERE id = $1', [asset.assignee_id]);
  const from = previous.length ? previous[0].name : 'nobody';
  const trailer = note && note.trim() ? ` — ${note.trim()}` : '';

  const conn = await db.connect();
  let handedOverSeconds = 0;
  try {
    await conn.query('BEGIN');

    // Stamp the end of the outgoing person's stretch and read what it came to,
    // before anything else moves. That number goes in the audit line: "who
    // reassigned, from whom to whom, when, and what the outgoing stretch came
    // to".
    await workLog.close(conn, asset.id, 'reassigned');
    const outgoing = await assignments.current(conn, asset.id);
    if (outgoing) {
      const { rows: spent } = await conn.query(
        `SELECT COALESCE(SUM(COALESCE(seconds, 0)), 0) AS s
           FROM work_sessions WHERE assignment_id = $1`,
        [outgoing.id]
      ).catch(() => ({ rows: [{ s: 0 }] }));
      handedOverSeconds = Number(spent[0].s) || 0;
    }

    /* The asset goes back to Assigned under the new person. Their clock is a
       new episode, so it reads nothing — not because anything reset it, but
       because it is a different stretch of work. The outgoing person's hours
       stay on their now-closed episode and in the asset's lifetime total, and
       their submission stays in asset_versions untouched. */
    await conn.query('UPDATE assets SET assignee_id = $1 WHERE id = $2', [next.id, asset.id]);
    await assignments.open(conn, {
      assetId: asset.id, userId: next.id, assignedById: req.user.id,
      status: asset.status, reason: inReview ? 'reassigned_in_review' : 'reassigned_rework',
    });

    /* The transition needs the fresh row so the routing lands on the new
       assignee — but the actor check must be judged against the asset as it
       WAS. contextFor recomputes canHandOver from whatever row it is given,
       and the row now names the incoming person, so re-deriving it here asked
       "is this lead in charge of the person receiving it" instead of "of the
       person handing it over". Hand work to somebody on another team and the
       handover was refused after the assignee had already been written — a
       rollback, and a refusal message that made no sense to the lead reading
       it. `allowed` is that same question, answered above against the row
       before it changed, so carry it rather than asking again. */
    const { rows: fresh } = await conn.query('SELECT * FROM assets WHERE id = $1', [asset.id]);
    const ctx = { ...(await contextFor(req, fresh[0])), canHandOver: allowed };
    const verdict = workflow.evaluate('reassign_review', ctx);
    if (!verdict.ok) {
      await conn.query('ROLLBACK');
      conn.release();
      return res.status(verdict.status).json({ error: verdict.error });
    }
    await applyTransition(req, res, fresh[0], verdict, {
      conn,
      // The reason, where a person reading the trail would look for it, and
      // then what the outgoing round finally recorded — which is the number
      // the handover is answerable for.
      note: `Reassigned from ${from} to ${next.name} while in ${workflow.label(asset.status)}${trailer}. `
        + `${from} recorded ${fmtSeconds(handedOverSeconds)} on their round; ${next.name} starts a new one.`,
    });
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  console.log(
    `${req.user.email} reassigned ${asset.code} from ${from} to ${next.name}`
    + ` (${inReview ? `in ${asset.status}, back to assigned` : 'rework'};`
    + ` ${from} recorded ${fmtSeconds(handedOverSeconds)}).`
  );

  const { rows: updated } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [asset.id]);
  const [withDetails] = await attachTasksAndNotes(updated, req.user);
  res.json({ asset: withDetails, reassigned: { inReview, from, to: next.name, handedOverSeconds } });
});

// GET /api/assets/:id/reassign-options — who could pick this rework up.
//
// The assignable contributors on the project, minus whoever holds it now, so
// the picker cannot offer a choice the endpoint above would refuse.
router.get('/:id/reassign-options', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  // The same reach the handover itself uses, asked the same way — a picker that
  // opens for somebody the endpoint would refuse is a promise the app breaks.
  const reviewing = ['pending_tl_review', 'pending_cd_review'].includes(asset.status);
  // One question, the same one the handover itself asks, for all four stages.
  const mayPick = await canHandOverInReview(req.user, asset);
  if (!mayPick) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }

  /* Who to offer: everybody the studio gives work to, minus whoever holds it
     now. No project filter, and none by permission either.
     
     It used to offer the people who could reach this project, widening to the
     whole studio for a holder of "Assign Work to Anyone". Two problems with
     that, and the second is why it is not simply being widened again. The
     first: the endpoint that receives the choice did not widen with it, so the
     permission's holders were shown names their own submission would refuse.
     The second: scoping the list by permission is what produced the narrow
     list in the first place, and doing it again only moves the same complaint
     to whichever role is next to be missed.
     
     Reaching outside the project is the point of this control. The gate is on
     who may hand work on — asked above, and unchanged — not on who may
     receive it. */
  const { rows: people } = await db.query(
    'SELECT id, `name`, `role` FROM users WHERE role IN ($1) ORDER BY `name`',
    [assignableRoles()]
  );
  const options = people
    .filter((person) => person.id !== asset.assignee_id)
    .map((person) => ({ id: person.id, name: person.name, role: person.role,
      roleLabel: (roleDef(person.role) || {}).label || person.role }));
  res.json({ options, awaitingRework: isAwaitingRework(asset), inReview: reviewing,
    status: asset.status, scope: 'all' });
});

// GET /api/assets/:id/history — the whole back-and-forth, in order.
//
// Submissions, review decisions and status changes are three tables; this
// stitches them into the one sequence a person actually wants to read.
router.get('/:id/history', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) {
    return res.status(403).json({ error: 'No access to this asset' });
  }

  const { rows: events } = await db.query(
    `SELECT e.*, u.\`name\` AS actor_name, u.avatar_updated_at AS actor_photo_at,
            v.version_number, v.link, v.description AS version_description
       FROM asset_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN asset_versions v ON v.id = e.version_id
      WHERE e.asset_id = $1
      ORDER BY e.seq`,
    [req.params.id]
  );

  res.json({
    assetId: asset.id,
    status: asset.status,
    statusLabel: workflow.label(asset.status),
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.from_status,
      fromLabel: e.from_status ? workflow.label(e.from_status) : null,
      toStatus: e.to_status,
      toLabel: workflow.label(e.to_status),
      actor: e.actor_name || e.actor_email || 'system',
      actorId: e.actor_id || null,
      actorPhotoAt: e.actor_photo_at || null,
      note: e.note,
      link: e.link,
      versionNumber: e.version_number,
      at: e.created_at,
    })),
  });
});

// GET /api/assets/import-template.csv — the sample file for the bulk import.
// Generated from the same column definitions the import validates against, so
// it cannot describe a format that would then be rejected.
router.get('/import-template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="zvky-asset-import-template.csv"');
  res.send(assetImport.buildTemplateCsv());
});

// GET /api/assets/import-format — what the importer expects, for the UI to show.
router.get('/import-format', (req, res) => res.json(assetImport.describeFormat()));

// Read the uploaded file into rows plus its header row. Throws a tagged error
// for anything that makes the file unreadable, so the caller answers 400
// rather than 500.
function readImportFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const fail = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    fail('The uploaded file could not be read.');
  }
  if (stats.size === 0) fail('That file is empty.');
  if (stats.size > assetImport.MAX_BYTES) {
    fail(`That file is ${(stats.size / 1048576).toFixed(1)}MB; the limit is ${(assetImport.MAX_BYTES / 1048576).toFixed(0)}MB.`);
  }

  let headers = [];
  let records = [];
  try {
    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      records = parse(content, {
        bom: true,                // Excel writes a byte-order mark; without this the first header reads as junk
        columns: (found) => { headers = found; return found; },
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // a ragged row becomes a row error, not a dead import
      });
    } else {
      const workbook = XLSX.readFile(filePath, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) fail('That workbook has no sheets.');
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
      if (!grid.length) fail('That sheet is empty.');
      headers = grid[0];
      records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }
  } catch (err) {
    if (err.status) throw err;
    // csv-parse and xlsx both throw on structurally broken files, and their
    // messages name the line, which is worth passing on.
    fail(`That file could not be read: ${err.message}`);
  }

  if (!headers.length) fail('That file has no header row. The first row must name the columns.');
  return { headers, records };
}

// Yield to the event loop. Between batches this keeps the server answering
// other requests during a long import instead of appearing hung.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// POST /api/assets/project/:projectId/bulk — CSV or Excel (.xls/.xlsx) import.
//
// Nothing here can take the server down: the file is checked before it is
// parsed, every row is validated before it reaches the database, inserts go in
// batches with a row-by-row fallback so one bad row cannot fail its batch, and
// the loop yields between batches. A row that fails is reported with its row
// number, the column at fault and why; the rest of the file still imports.
router.post('/project/:projectId/bulk', requirePermission('asset.bulk_upload'), uploadImport.single('file'), async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  if (await projectClosedResponse(res, projectId)) return undefined;
  if (!req.file) return res.status(400).json({ error: 'A CSV or Excel file is required' });
  // Whether the Lead/Supervisor Notes column in this file means anything.
  const mayWriteLeadNotes = holds(req.user, 'asset.lead_notes');

  let headers;
  let records;
  try {
    ({ headers, records } = readImportFile(req.file.path, req.file.originalname));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // staging file, not a review asset
  }

  // --- file-level checks, before any row is touched -------------------------
  const headerCheck = assetImport.validateHeaders(headers);
  if (!headerCheck.ok) {
    // A file whose headers are the user importer's template. Saying so by name
    // is more use than listing missing columns and leaving someone to work out
    // that they picked the wrong button.
    const userOnly = ['email', 'role', 'reports_to_email', 'password'];
    const wrongFile = userOnly.filter((c) => headerCheck.present.includes(c)).length >= 2;
    return res.status(400).json({
      error: wrongFile
        ? 'That looks like the user import file, not the asset one. Upload it under Bulk Upload Users, or download the asset sample format here.'
        : `That file is missing required column${headerCheck.missing.length > 1 ? 's' : ''}: ${headerCheck.missing.join(', ')}.`,
      wrongTemplate: wrongFile ? 'users' : undefined,
      missingColumns: headerCheck.missing,
      foundColumns: headerCheck.present,
      expectedColumns: assetImport.COLUMN_NAMES,
      hint: 'Download the sample file for the exact format.',
    });
  }
  if (!records.length) {
    return res.status(400).json({
      error: 'That file has a header row but no data rows.',
      expectedColumns: assetImport.COLUMN_NAMES,
    });
  }
  if (records.length > assetImport.MAX_ROWS) {
    return res.status(400).json({
      error: `That file has ${records.length} rows; the limit is ${assetImport.MAX_ROWS} per import. Split it and upload again.`,
      rowCount: records.length,
      maxRows: assetImport.MAX_ROWS,
    });
  }

  /* Columns nobody asked for, said out loud.
   *
   * validateHeaders has always worked this out and nothing has ever shown it.
   * A missing REQUIRED column stops the upload with a message naming it; an
   * unrecognised OPTIONAL one was dropped in silence — the file imported, the
   * column did nothing, and there was no way to tell that from the feature
   * being broken. That is exactly how "Assignee Email is not assigning
   * anybody" looks from the outside, whether the cause is a header this
   * importer does not know or a deployment too old to have the column at all.
   *
   * Reported against row 1, which is where the headers are. */
  const unknownColumns = headerCheck.unknown.map((column) => ({
    row: 1,
    column,
    value: '',
    message: 'is not a column this importer knows, so everything in it was ignored. '
      + `Expected: ${assetImport.COLUMN_NAMES.join(', ')}.`,
  }));

  // --- validate every row up front -----------------------------------------
  // Nothing is written until the whole file has been checked, so an error on
  // the last row is reported the same way as one on the first.
  const errors = [];
  /* Warnings are the other half of the per-row contract: an ERROR skips the
     row, a WARNING drops one optional value and keeps the row. Both name the
     row and the column, so the results table reads the same either way, and
     neither ever fails the file. */
  const warnings = [...unknownColumns];
  const valid = [];
  const seenInFile = new Map(); // name + type, within this file

  // Existing assets, so re-uploading a file does not silently duplicate them.
  const { rows: existingRows } = await db.query(
    'SELECT `name`, `type` FROM assets WHERE project_id = $1',
    [projectId]
  );
  /* Compare loosely on both halves. The sheet carries whatever somebody typed
     into Scope of Work ("FX", "fx", "F X"); the database holds the key. Left
     as a raw string comparison, re-uploading the same file would have found no
     match and created every asset a second time. */
  const flatten = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const identityOf = (name, type) => `${String(name).trim().toLowerCase()}|${flatten(type)}`;
  const existing = new Set(existingRows.map((r) => identityOf(r.name, r.type)));

  for (let i = 0; i < records.length; i++) {
    const rowNumber = i + 2; // the header is row 1
    const result = assetImport.validateRow(records[i], rowNumber);
    /* Kept even when the row is about to be skipped for an error. Somebody
       fixing row 12's missing Asset Name should be told in the same pass that
       its deadline was unreadable, rather than uploading again to find out. */
    warnings.push(...result.warnings);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    const { values } = result;
    const identity = identityOf(values.name, values.type);

    if (seenInFile.has(identity)) {
      errors.push({
        row: rowNumber, column: 'name', value: values.name,
        message: `duplicates row ${seenInFile.get(identity)} in this file (same name and type)`,
      });
      continue;
    }
    if (existing.has(identity)) {
      errors.push({
        row: rowNumber, column: 'name', value: values.name,
        message: 'an asset with this name and type already exists in this project',
      });
      continue;
    }
    seenInFile.set(identity, rowNumber);
    valid.push({ rowNumber, values });

    if (i % 500 === 499) await yieldToLoop(); // stay responsive on a big file
  }

  /* --- the two open value lists ------------------------------------------

     A Category or a Scope of Work the sheet names but Settings does not yet
     hold is CREATED rather than refused, so a studio can bring its taxonomy in
     with its first import instead of typing it twice.

     Matching is case- and punctuation-insensitive against both the label
     people read and the key the database stores, so "Slot Game", "slot game"
     and "slot_game" are one value and not three. A name genuinely not seen
     before is added once, however many rows use it, under the first spelling
     in the file — and the response says what was added, because adding to a
     list somebody else maintains should never be silent. */
  async function resolveList(collection, field) {
    const byName = new Map();
    const index = (entry) => {
      byName.set(flatten(entry.label), entry.key);
      byName.set(flatten(entry.key), entry.key);
    };
    referenceData.list(collection, { includeInactive: true }).forEach(index);

    // First spelling in the file wins, so the label reads the way it was
    // first written rather than the way the last row happened to type it.
    const wanted = new Map();
    for (const v of valid) {
      /* An empty cell is not a value to go looking for. Category became
         optional with the nine-column format, and without this a blank one
         reduced to "" and asked the reference list to create a category out of
         nothing — once per import, silently, from every sheet with a gap in
         that column. */
      if (v.values[field] === null || v.values[field] === undefined || v.values[field] === '') continue;
      const flat = flatten(v.values[field]);
      if (!wanted.has(flat)) wanted.set(flat, v.values[field]);
    }

    const created = [];
    for (const [flat, label] of wanted) {
      if (byName.has(flat)) continue;
      /* Position 0 so an import appends to the list rather than landing in the
         middle of it. The seeded scopes of work carry deliberate positions
         (Character 60 … Background 10) and that is the order the dropdown
         shows; without this, eleven imported values sorted in among them and
         the curated order was gone. */
      const made = await referenceData.create(db, collection, { label, position: 0 });
      if (made.ok) {
        index(made.entry);
        created.push({ key: made.entry.key, label: made.entry.label });
      }
      /* One that could not be created — a name that reduces to nothing, or an
         asset type with no free code prefix left — leaves its rows to fail
         below with a per-row message, rather than failing the whole file. */
    }
    return { byName, created };
  }

  const categories = await resolveList('categories', 'category');
  // Asset types carry a UNIQUE code prefix, which is derived here; the asset
  // codes built further down read the list again, so a type added just now is
  // already in it.
  const scopes = await resolveList('asset_types', 'type');

  /* --- who the sheet names ------------------------------------------------

     One query for every address in the file rather than one per row. An
     address that matches a real person assigns the asset immediately, which is
     what adding one by hand with an assignee does — the machinery for it is
     already below, and used to sit unreachable because there was no column
     feeding it.

     Everything that can go wrong here is a WARNING and not an error: the asset
     is valid without an assignee, so an address with a typo in it costs the
     row its assignee and nothing else. */
  const wantedEmails = [...new Set(valid.map((v) => v.values.assignee_email).filter(Boolean))];
  const peopleByEmail = new Map();
  if (wantedEmails.length) {
    const holes = wantedEmails.map((_, n) => `$${n + 1}`).join(',');
    const { rows: found } = await db.query(
      `SELECT id, \`name\`, email, \`role\` FROM users WHERE LOWER(email) IN (${holes})`,
      wantedEmails
    );
    found.forEach((u) => peopleByEmail.set(String(u.email).toLowerCase(), u));
  }

  const ready = [];
  for (const entry of valid) {
    const categoryKey = entry.values.category === null || entry.values.category === undefined
      ? null
      : categories.byName.get(flatten(entry.values.category));
    /* Category is optional now, so "no category given" and "a category given
       that could not be matched or created" are different things: the first is
       an ordinary asset, the second is a value somebody typed that has gone
       nowhere, and only the second is worth saying anything about. Neither
       costs the row. */
    if (entry.values.category && !categoryKey) {
      warnings.push({
        row: entry.rowNumber, column: 'Category', value: entry.values.category,
        message: 'could not be matched to a category or added as a new one, so it was left unset',
      });
    }
    const scopeKey = scopes.byName.get(flatten(entry.values.type));
    if (!scopeKey) {
      errors.push({
        row: entry.rowNumber, column: 'Scope of Work', value: entry.values.type,
        message: 'could not be matched to a scope of work, and could not be added as a new one',
      });
      continue;
    }
    // The row carried whatever the sheet said; from here on it is the key.
    entry.values.type = scopeKey;
    entry.category = categoryKey || null;

    /* The assignee. Three ways it can come to nothing, each said differently,
       because "I left it blank", "I typed it wrong" and "that person is not
       given work" are three different things to have to fix. */
    entry.assigneeId = null;
    const email = entry.values.assignee_email;
    if (email) {
      const person = peopleByEmail.get(email);
      if (!person) {
        warnings.push({
          row: entry.rowNumber, column: 'Assignee Email', value: email,
          message: 'does not match anyone here, so the asset was created with nobody on it',
        });
      } else {
        /* The same rule assigning by hand applies: some designations are not
           given work. Checked here rather than left to the database so the
           sheet gets the same answer the picker would. */
        const def = roleDef(person.role);
        if (!def || !def.assignable) {
          warnings.push({
            row: entry.rowNumber, column: 'Assignee Email', value: email,
            message: `belongs to ${person.name}, who holds a designation that is not assigned work, `
              + 'so the asset was created with nobody on it',
          });
        } else {
          entry.assigneeId = person.id;
        }
      }
    }

    /* Lead / Supervisor Notes are gated on the permission that shows them.
       Somebody who cannot see the field must not be able to write it from a
       sheet either — a gate on one side only is not a gate. Said out loud
       rather than dropped quietly, so the uploader knows the column did
       nothing. */
    if (entry.values.lead_notes && !mayWriteLeadNotes) {
      warnings.push({
        row: entry.rowNumber, column: 'Lead/Supervisor Notes', value: entry.values.lead_notes,
        message: 'was not imported — your role does not hold Lead / Supervisor Notes',
      });
      entry.values.lead_notes = null;
    }

    // Priority is still not an imported column: every imported asset starts
    // with the default and is changed in the panel like any other field.
    ready.push(entry);
  }

  // --- asset codes ---------------------------------------------------------
  const codeMap = Object.fromEntries(
    referenceData.list('asset_types', { includeInactive: true }).map((t) => [t.key, t.codePrefix])
  );
  const typeCounters = {};
  for (const t of assetImport.assetTypes()) {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM assets WHERE project_id = $1 AND `type` = $2',
      [projectId, t]
    );
    typeCounters[t] = Number(rows[0].n);
  }
  for (const entry of ready) {
    typeCounters[entry.values.type] += 1;
    entry.id = uuid();
    entry.code = `${codeMap[entry.values.type]}-${String(typeCounters[entry.values.type]).padStart(3, '0')}`;
  }

  // --- insert in batches ---------------------------------------------------
  const DEFAULT_TASKS = ['Rough pass', 'Clean line', 'Color / shade'];
  const ASSET_INSERT =
    'INSERT INTO assets (id, `code`, `name`, `type`, category, `status`, priority, project_id, '
    + 'assignee_id, created_by, due_date, description, man_hours, reference_link, lead_notes) VALUES ?';
  const TASK_INSERT = 'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ?';
  // Imported assets belong to whoever uploaded the file, same as one added by
  // hand — otherwise a bulk upload would produce a projectful of assets its
  // uploader could not then edit.
  const assetRow = (e) => [
    e.id, e.code, e.values.name, e.values.type, e.category, 'not_started',
    assetImport.defaultPriority(), projectId, e.assigneeId, req.user.id,
    e.values.due_date, '', e.values.man_hours,
    e.values.reference_link, e.values.lead_notes,
    /* Description stays empty and is NOT what Lead/Supervisor Notes writes.
       They are two fields on purpose: Description is the brief everyone on the
       asset reads and edits, these notes are gated. Folding the sheet's notes
       into Description would have made the gate meaningless. */
  ];
  const taskRows = (e) => DEFAULT_TASKS.map((name, position) => [uuid(), e.id, name, 0, position]);

  const created = [];
  for (let i = 0; i < ready.length; i += assetImport.BATCH_SIZE) {
    const batch = ready.slice(i, i + assetImport.BATCH_SIZE);
    try {
      await db.query(ASSET_INSERT, [batch.map(assetRow)]);
      await db.query(TASK_INSERT, [batch.flatMap(taskRows)]);
      batch.forEach((e) => created.push({ id: e.id, code: e.code, name: e.values.name }));
    } catch (batchErr) {
      // The batch failed as a unit, so retry row by row to find which rows are
      // actually at fault and let the rest through.
      console.error(`Bulk import batch failed (${batchErr.code || batchErr.message}); retrying row by row.`);
      for (const entry of batch) {
        try {
          await db.query(ASSET_INSERT, [[assetRow(entry)]]);
          await db.query(TASK_INSERT, [taskRows(entry)]);
          created.push({ id: entry.id, code: entry.code, name: entry.values.name });
        } catch (rowErr) {
          errors.push({
            row: entry.rowNumber,
            column: null,
            value: entry.values.name,
            message: `could not be saved (${rowErr.code || 'database error'})`,
          });
        }
      }
    }
    await yieldToLoop();
  }

  // An imported row that names an assignee is an assignment, and assignment is
  // what moves an asset out of Not Assigned. Adding one by hand goes through
  // the workflow's 'assign' transition; this path used to write 'not_started'
  // and stop there, so a bulk-imported asset showed its assignee's avatar while
  // sitting in the Not Assigned column, and nothing in its history said who put
  // them on it. Same destination, same event, one statement per batch.
  const assignedByImport = ready.filter(
    (e) => e.assigneeId && created.some((c) => c.id === e.id)
  );
  if (assignedByImport.length) {
    const ids = assignedByImport.map((e) => e.id);
    const holes = ids.map((_, n) => `$${n + 1}`).join(',');
    await db.query(
      `UPDATE assets SET \`status\` = 'assigned', routed_to_id = assignee_id WHERE id IN (${holes})`,
      ids
    );
    const eventRows = assignedByImport.map((e) => [
      uuid(), e.id, 'assign', 'not_started', 'assigned', req.user.id, req.user.email,
      'Assigned on import', e.assigneeId,
    ]);
    await db.query(
      `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, routed_to_id)
       VALUES ?`,
      [eventRows]
    );

    /* And the first Round.
     *
     * The Assets List is built from asset_assignments — one row per stretch of
     * time an asset sat with one person — so an asset that is assigned without
     * an episode is assigned to somebody and shows no round at all. Adding one
     * by hand opens the episode (see the create route); this path had no
     * assignee to open one for until the sheet gained the column, so the gap
     * only becomes reachable now.
     *
     * One call per asset rather than one INSERT for all of them, because open()
     * is what enforces "at most one open episode per asset" and what tells the
     * person they have been given work — the same two things a manual
     * assignment gets. Yielding every so often keeps a long file from holding
     * the loop. */
    for (let i = 0; i < assignedByImport.length; i++) {
      const e = assignedByImport[i];
      try {
        await assignments.open(db, {
          assetId: e.id, userId: e.assigneeId, assignedById: req.user.id, status: 'not_started',
        });
      } catch (err) {
        /* The asset exists and is assigned; only its history is missing. Worth
           a line in the log and not worth failing an import over — the same
           bargain assignments.js makes everywhere else. */
        console.warn(`[import] could not open the first round on ${e.code}: ${err.message}`);
      }
      if (i % 50 === 49) await yieldToLoop();
    }
  }

  errors.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  // 207 when some rows were skipped, 201 when the whole file went in.
  warnings.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  res.status(errors.length ? 207 : 201).json({
    created: created.length,
    skipped: errors.length,
    totalRows: records.length,
    createdAssets: created,
    /* Rows that imported with something dropped. Deliberately not counted as
       skipped and deliberately not silent: the import did less than the sheet
       asked for, and the only honest place to say so is next to the result. */
    warnings,
    assigned: assignedByImport.length,
    // Named so a value the sheet invented is visible, not a silent edit to a
    // Settings list.
    createdCategories: categories.created,
    createdScopes: scopes.created,
    errors,
  });
});

module.exports = router;
