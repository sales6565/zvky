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
  canAssignAsset,
  canHandOverInReview,
  canManageTasks,
  hasFullAccess,
  isAwaitingRework,
  REWORK_STATUSES,
  holds,
} = require('../permissions');
const { assignableRoles, roleDef } = require('../roles');
const lifecycle = require('../lifecycle');
const workTimer = require('../work-timer');
const assignments = require('../assignments');
const assetImport = require('../asset-import');
const workflow = require('../asset-workflow');
const submissionLink = require('../submission-link');
const referenceData = require('../reference-data');

router.use(authenticate);

async function attachTasksAndNotes(assets) {
  if (!assets.length) return assets;
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
        `SELECT t.*, u.\`name\` AS created_by_name FROM tasks t
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
    `SELECT v.*, u.name AS uploaded_by_name FROM asset_versions v
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

  const timeSpent = await workTimer.totalsFor(db, ids);
  // Who has held each asset, in order, with the time and submissions from each
  // stretch. The Assets List draws one row per entry here; the dashboard
  // ignores it and keeps drawing one card per asset.
  const episodes = await enrich('assignment history', () => assignments.listFor(db, ids))
    .then((m) => (m instanceof Map ? m : new Map()));
  return assets.map((a) => ({
    ...a,
    time_spent_seconds: (timeSpent.get(a.id) || {}).seconds || 0,
    timer_running: Boolean((timeSpent.get(a.id) || {}).running),
    assignments: episodes.get(a.id) || [],
    // MySQL stores the flag as TINYINT(1); hand the browser a real boolean.
    tasks: tasks.filter((t) => t.asset_id === a.id).map((t) => ({ ...t, done: Boolean(t.done) })),
    notes: notes.filter((n) => n.asset_id === a.id),
    versions: versions.filter((v) => v.asset_id === a.id),
    feedback: feedback.filter((f) => f.asset_id === a.id),
  }));
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

const ASSET_SELECT = `SELECT a.*, u.name AS assignee_name FROM assets a LEFT JOIN users u ON u.id = a.assignee_id`;

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

  const def = roleDef(req.user.role);
  if (def.assignable) {
    // A contributor only ever sees their own work.
    sql += ' AND a.assignee_id = $2';
    params.push(req.user.id);
  } else if (def.leadsTeam) {
    // A lead sees whatever their reports are carrying on this project.
    sql += ' AND a.assignee_id IN (SELECT id FROM users WHERE team_lead_id = $2)';
    params.push(req.user.id);
  }
  sql += ' ORDER BY a.created_at DESC';

  const { rows } = await db.query(sql, params);
  const withDetails = await attachTasksAndNotes(rows);
  res.json({ assets: withDetails });
});

// POST /api/assets/project/:projectId — create a new asset
router.post('/project/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!canCreateAsset(req.user)) return res.status(403).json({ error: 'Your role cannot create assets' });
  const allowed = await canAccessProject(req.user, projectId);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  if (await projectClosedResponse(res, projectId)) return undefined;

  const { name, type, priority = assetImport.defaultPriority(), assigneeId = null, due = null, description = '', manHours = null } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Asset name is required' });
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
      `INSERT INTO assets (id, \`code\`, \`name\`, \`type\`, \`status\`, priority, project_id, assignee_id, created_by, due_date, description, man_hours)
       VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10,$11)`,
      [id, code, name.trim(), type, priority, projectId, assigneeId, req.user.id, due, description, manHours]
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
  const [withDetails] = await attachTasksAndNotes(rows);
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
  const EDIT_FIELDS = ['status', 'priority', 'description', 'due', 'manHours', 'referenceLink'];
  const wantsEdit = EDIT_FIELDS.some((k) => req.body && req.body[k] !== undefined);
  const wantsAssign = Boolean(req.body) && req.body.assigneeId !== undefined
    && req.body.assigneeId !== asset.assignee_id;
  const mayEdit = await canEditAsset(req.user, asset);
  if (wantsEdit && !mayEdit) {
    return res.status(403).json({ error: 'You cannot edit this asset' });
  }
  if (wantsAssign && !canAssignAsset(req.user, asset)) {
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

  for (const key of ['status', 'priority', 'description', 'assignee_id', 'due_date', 'man_hours']) {
    const bodyKey = key === 'assignee_id' ? 'assigneeId' : key === 'due_date' ? 'due' : key === 'man_hours' ? 'manHours' : key;
    if (req.body[bodyKey] !== undefined) {
      fields.push(`\`${key}\` = $${i++}`);
      values.push(req.body[bodyKey]);
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

    // Assigning the asset is what starts the work — there is no separate
    // "start" action for someone to forget. Only from Not Assigned:
    // reassigning something already in review must not drag it backwards.
    const assigneeChanged = req.body.assigneeId !== undefined && req.body.assigneeId !== asset.assignee_id;

    // A different person means a different stretch of work. Their clock reads
    // nothing because their episode is new, and the last person's hours stay on
    // theirs. Work coming back to the SAME person changes no assignee, so no
    // episode ends and their number keeps climbing — the two cases separate
    // themselves here, on the one question that actually distinguishes them.
    if (assigneeChanged) {
      await workTimer.pause(conn, req.params.id);
      await assignments.open(conn, {
        assetId: req.params.id, userId: req.body.assigneeId || null,
        assignedById: req.user.id, status: asset.status,
      });
    }
    if (assigneeChanged && req.body.assigneeId && asset.status === 'not_started') {
      const { rows: fresh } = await conn.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
      const ctx = await contextFor(req, fresh[0]);
      const verdict = workflow.evaluate('assign', ctx);
      if (verdict.ok) {
        await applyTransition(req, res, fresh[0], verdict, { note: verdict.describe, conn });
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
      const nameOf = async (userId) => {
        if (!userId) return 'nobody';
        const { rows: who } = await conn.query('SELECT `name` FROM users WHERE id = $1', [userId]);
        return who.length ? who[0].name : 'somebody who no longer has an account';
      };
      const from = await nameOf(asset.assignee_id);
      const to = await nameOf(req.body.assigneeId);
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
  const [withDetails] = await attachTasksAndNotes(updated);
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
      error: 'Only the person who added this asset, whoever it is assigned to, or its reviewer can change its checklist.',
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
    `SELECT t.*, u.\`name\` AS created_by_name FROM tasks t
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
    canAssign: canAssignAsset(req.user, asset),
    // Wider still, and only for handing submitted work on — see
    // canHandOverInReview. The reviewer holding it counts, not just the creator.
    canHandOver: await canHandOverInReview(req.user, asset),
    canDeliver: await canMarkDelivered(req.user, asset),
    // The two halves of the Creative Director's gate, from the role's
    // permissions rather than from its tier.
    canReviewCd: canReviewAsCD(req.user),
    canApproveForClient: holds(req.user, 'review.approve_client'),
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
async function applyTransition(req, res, asset, verdict, { note, versionId, conn } = {}) {
  const run = conn || db;
  await run.query(
    'UPDATE assets SET `status` = $1, routed_to_id = $2 WHERE id = $3',
    [verdict.to, verdict.routedTo, asset.id]
  );
  await run.query(
    `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, version_id, routed_to_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [uuid(), asset.id, verdict.action, asset.status, verdict.to, req.user.id, req.user.email,
     String(note || '').trim() || null, versionId || null, verdict.routedTo]
  );
  const { rows: updated } = await run.query(`${ASSET_SELECT} WHERE a.id = $1`, [asset.id]);
  const [withDetails] = await attachTasksAndNotes(updated);
  return withDetails;
}

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

  // Submitting stops the clock. Before the version row is written, so the
  // closing stretch still counts against the round it belongs to.
  await workTimer.pause(db, req.params.id);

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

// --- the clock ----------------------------------------------------------------
//
// Who may run an asset's timer: the person the asset is assigned to, or a
// full-access role for oversight. Not the creator — the clock measures the
// assignee's own hands-on time, and nobody else should be able to start it
// under their name.
function mayRunTimer(req, asset) {
  if (hasFullAccess(req.user)) return true;
  return Boolean(asset.assignee_id) && asset.assignee_id === req.user.id;
}

// The statuses in which working (and therefore timing) makes sense. The two
// changes-requested states are here because a rework round is the same cycle
// again — accept the rework, pause, resume, submit — with the next round
// number, exactly as the first round was.
const TIMEABLE = ['assigned', 'in_progress', 'tl_changes_requested', 'cd_changes_requested'];

// POST /api/assets/:id/timer/start — Accept and Start, and every Resume.
//
// One endpoint for both, because they are one act: open a session. The only
// difference is that from 'assigned' it also moves the asset to In Progress,
// through the state machine's own accept transition rather than a side door.
router.post('/:id/timer/start', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (await projectClosedResponse(res, asset.project_id)) return undefined;
  if (!mayRunTimer(req, asset)) {
    return res.status(403).json({ error: 'Only the person this asset is assigned to can run its timer.' });
  }
  if (!TIMEABLE.includes(asset.status)) {
    return res.status(409).json({
      error: `The timer only runs while the work is on somebody's desk — this asset is in ${workflow.label(asset.status)}.`,
    });
  }
  // CD Changes sits with the lead until relayed; the assignee cannot start
  // reworking what they have not been handed.
  if (asset.status === 'cd_changes_requested' && asset.routed_to_id !== req.user.id && !hasFullAccess(req.user)) {
    return res.status(409).json({ error: 'The team lead has not passed the Creative Director\'s notes on yet.' });
  }

  // A clock with nowhere to write is a clear refusal, not a database error.
  if (!(await workTimer.available(db))) {
    return res.status(503).json({
      error: 'Time tracking is not available on this deployment yet — its table has not been created. See /api/health.',
    });
  }

  let moved = null;
  if (asset.status === 'assigned') {
    const ctx = await contextFor(req, asset);
    const verdict = workflow.evaluate('accept', ctx);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
    moved = await applyTransition(req, res, asset, verdict, { note: verdict.describe });
  }

  const episode = await assignments.current(db, req.params.id);
  const started = await workTimer.start(db, req.params.id, req.user.id, episode && episode.id);
  if (!started.ok) {
    // The double-click, the second tab, or a colleague a moment faster. The
    // clock is already doing what the click wanted, so say so.
    return res.status(409).json({ error: 'The timer is already running.', running: true, since: started.since });
  }

  const timer = await workTimer.summary(db, req.params.id, episode && episode.id);
  if (moved) return res.status(200).json({ asset: moved, timer, accepted: true });
  const { rows: fresh } = await db.query(`${ASSET_SELECT} WHERE a.id = $1`, [req.params.id]);
  const [withDetails] = await attachTasksAndNotes(fresh);
  return res.json({ asset: withDetails, timer });
});

// POST /api/assets/:id/timer/pause — stop the clock. Idempotent on purpose:
// two people pausing, or one person twice, ends at the same place.
router.post('/:id/timer/pause', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!mayRunTimer(req, asset)) {
    return res.status(403).json({ error: 'Only the person this asset is assigned to can run its timer.' });
  }
  await workTimer.pause(db, req.params.id);
  const paused = await assignments.current(db, req.params.id);
  res.json({ timer: await workTimer.summary(db, req.params.id, paused && paused.id) });
});

// GET /api/assets/:id/timer — the total, the per-round breakdown, and whether
// it is running. Readable by anyone who can see the asset.
router.get('/:id/timer', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  const asset = rows[0];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!(await canViewAsset(req.user, asset))) return res.status(403).json({ error: 'No access to this asset' });
  const held = await assignments.current(db, req.params.id);
  res.json({ timer: await workTimer.summary(db, req.params.id, held && held.id), canRun: mayRunTimer(req, asset) });
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

// POST /api/assets/:id/reassign — hand rework to somebody else.
//
// The pipeline sends changes-requested work back to whoever submitted it. This
// is the way out of that: when an asset is sitting in TL Changes or CD Changes,
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

  // Two different things share this endpoint, and they must not share a branch.
  //
  //   REWORK        the asset is back with the artist after a change request.
  //                 Somebody else picks the rework up. The status does not
  //                 move — it is still rework, just somebody else's.
  //
  //   IN REVIEW     the asset has been SUBMITTED and is sitting in a reviewer's
  //                 queue. Handing it to somebody else means handing them work
  //                 they have not done, so it goes back to Assigned and they
  //                 start from the beginning: their own clock, from nothing.
  //
  // Which one this is decided once, here, and carried through the rest of the
  // handler. Folding them together is what would quietly make a reassignment
  // mid-review look like a continuation of somebody else's round.
  // Whether this person has ANY route to reassigning this asset, asked before
  // the status is looked at. Somebody with no business here is told so, rather
  // than being told which statuses are reassignable — which is not their
  // concern, and which the narrower checks below would otherwise leak.
  const couldEver = canAssignAsset(req.user, asset)
    || await isTeamLeadOfAsset(req.user, asset)
    || (canReviewAsCD(req.user) && await canViewAsset(req.user, asset));
  if (!couldEver) {
    return res.status(403).json({ error: 'You do not have permission to hand this asset to somebody else.' });
  }

  const inReview = ['pending_tl_review', 'pending_cd_review'].includes(asset.status);
  const rework = isAwaitingRework(asset);
  if (!inReview && !rework) {
    return res.status(409).json({
      error: 'Handing an asset to somebody else is only possible while it is waiting on changes or waiting on a reviewer.',
      status: asset.status,
      allowedStatuses: [...REWORK_STATUSES, 'pending_tl_review', 'pending_cd_review'],
    });
  }

  // Each case asks its own question, because the answers differ: rework is the
  // creator's call alone, while submitted work sitting in a reviewer's queue
  // may also be handed on by the reviewer holding it. Both ask for
  // asset.assign — this is about reach, not about a new permission.
  const allowed = inReview
    ? await canHandOverInReview(req.user, asset)
    : canAssignAsset(req.user, asset);
  if (!allowed) {
    return res.status(403).json({
      error: inReview
        ? 'Handing submitted work on is for the person who added the asset or the reviewer holding it.'
        : 'Only the person who added this asset can hand its rework to somebody else.',
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
  if (!(await canAccessProject(next, asset.project_id))) {
    return res.status(400).json({ error: `${next.name} is not on this project.`, field: 'assigneeId' });
  }

  const { rows: previous } = await db.query('SELECT `name` FROM users WHERE id = $1', [asset.assignee_id]);
  const from = previous.length ? previous[0].name : 'nobody';
  const trailer = note && note.trim() ? ` — ${note.trim()}` : '';

  const conn = await db.connect();
  let handedOverSeconds = 0;
  try {
    await conn.query('BEGIN');

    // Stop the outgoing person's clock and read what it finished on, before
    // anything else moves. That number goes in the audit line: "who reassigned,
    // from whom to whom, when, and what the outgoing session finally recorded".
    await workTimer.pause(conn, asset.id);
    const outgoing = await assignments.current(conn, asset.id);
    if (outgoing) {
      const { rows: spent } = await conn.query(
        `SELECT COALESCE(SUM(COALESCE(seconds, 0)), 0) AS s
           FROM work_sessions WHERE assignment_id = $1`,
        [outgoing.id]
      ).catch(() => ({ rows: [{ s: 0 }] }));
      handedOverSeconds = Number(spent[0].s) || 0;
    }

    if (inReview) {
      // --- submitted work, handed to somebody who has not done it -----------
      //
      // The asset goes back to Assigned under the new person. Their clock is a
      // new episode, so it reads nothing — not because anything reset it, but
      // because it is a different stretch of work. The outgoing person's hours
      // stay on their now-closed episode and in the asset's lifetime total, and
      // their submission stays in asset_versions untouched.
      await conn.query('UPDATE assets SET assignee_id = $1 WHERE id = $2', [next.id, asset.id]);
      await assignments.open(conn, {
        assetId: asset.id, userId: next.id, assignedById: req.user.id,
        status: asset.status, reason: 'reassigned_in_review',
      });

      const { rows: fresh } = await conn.query('SELECT * FROM assets WHERE id = $1', [asset.id]);
      const ctx = await contextFor(req, fresh[0]);
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
    } else {
      // --- rework, picked up by somebody else --------------------------------
      //
      // Unchanged behaviour. The status stays where it is: the asset is already
      // back with the artist, and this only says which artist. In CD Changes it
      // sits with the team lead until they relay the notes, so the routing only
      // follows the assignee when it was already pointing at them — reassigning
      // must not steal it off the lead's desk and skip the relay.
      const wasWithAssignee = asset.routed_to_id && asset.routed_to_id === asset.assignee_id;
      const routedTo = wasWithAssignee ? next.id : asset.routed_to_id;

      await conn.query('UPDATE assets SET assignee_id = $1, routed_to_id = $2 WHERE id = $3',
        [next.id, routedTo, asset.id]);
      await assignments.open(conn, {
        assetId: asset.id, userId: next.id, assignedById: req.user.id,
        status: asset.status, reason: 'reassigned_rework',
      });
      await conn.query(
        `INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, routed_to_id)
         VALUES ($1,$2,'reassign',$3,$4,$5,$6,$7,$8)`,
        [uuid(), asset.id, asset.status, asset.status, req.user.id, req.user.email,
         `Rework moved from ${from} to ${next.name}${trailer}. ${from} recorded ${fmtSeconds(handedOverSeconds)}.`,
         routedTo]
      );
      await conn.query('COMMIT');
    }
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
  const [withDetails] = await attachTasksAndNotes(updated);
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
  const mayPick = reviewing
    ? await canHandOverInReview(req.user, asset)
    : canAssignAsset(req.user, asset);
  if (!mayPick) {
    return res.status(403).json({ error: 'You do not have permission to do that' });
  }

  const { rows: people } = await db.query(
    'SELECT id, `name`, `role` FROM users WHERE role IN ($1) ORDER BY `name`',
    [assignableRoles()]
  );
  const options = [];
  for (const person of people) {
    if (person.id === asset.assignee_id) continue;
    if (await canAccessProject(person, asset.project_id)) {
      options.push({ id: person.id, name: person.name, role: person.role,
        roleLabel: (roleDef(person.role) || {}).label || person.role });
    }
  }
  res.json({ options, awaitingRework: isAwaitingRework(asset), inReview: reviewing, status: asset.status });
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
    `SELECT e.*, u.\`name\` AS actor_name, v.version_number, v.link, v.description AS version_description
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

  // --- validate every row up front -----------------------------------------
  // Nothing is written until the whole file has been checked, so an error on
  // the last row is reported the same way as one on the first.
  const errors = [];
  const valid = [];
  const seenInFile = new Map(); // name + type, within this file

  // Existing assets, so re-uploading a file does not silently duplicate them.
  const { rows: existingRows } = await db.query(
    'SELECT `name`, `type` FROM assets WHERE project_id = $1',
    [projectId]
  );
  const existing = new Set(existingRows.map((r) => `${String(r.name).toLowerCase()} ${r.type}`));

  for (let i = 0; i < records.length; i++) {
    const rowNumber = i + 2; // the header is row 1
    const result = assetImport.validateRow(records[i], rowNumber);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    const { values } = result;
    const identity = `${values.name.toLowerCase()} ${values.type}`;

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

  // Resolve assignee emails in one query rather than one per row.
  const emails = [...new Set(valid.map((v) => v.values.assignee_email).filter(Boolean))];
  const assigneeByEmail = new Map();
  if (emails.length) {
    const { rows } = await db.query(
      'SELECT id, email FROM users WHERE lower(email) IN ($1) AND role IN ($2)',
      [emails.map((e) => e.toLowerCase()), assignableRoles()]
    );
    rows.forEach((r) => assigneeByEmail.set(String(r.email).toLowerCase(), r.id));
  }

  const ready = [];
  for (const entry of valid) {
    const email = entry.values.assignee_email;
    if (email && !assigneeByEmail.has(email.toLowerCase())) {
      errors.push({
        row: entry.rowNumber, column: 'assignee_email', value: email,
        message: 'no assignable team member has this email address',
      });
      continue;
    }
    entry.assigneeId = email ? assigneeByEmail.get(email.toLowerCase()) : null;
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
    'INSERT INTO assets (id, `code`, `name`, `type`, `status`, priority, project_id, assignee_id, created_by, due_date, description, man_hours) VALUES ?';
  const TASK_INSERT = 'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ?';
  // Imported assets belong to whoever uploaded the file, same as one added by
  // hand — otherwise a bulk upload would produce a projectful of assets its
  // uploader could not then edit.
  const assetRow = (e) => [
    e.id, e.code, e.values.name, e.values.type, 'not_started', e.values.priority,
    projectId, e.assigneeId, req.user.id, e.values.deadline, e.values.description, e.values.man_hours,
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
  }

  errors.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  // 207 when some rows were skipped, 201 when the whole file went in.
  res.status(errors.length ? 207 : 201).json({
    created: created.length,
    skipped: errors.length,
    totalRows: records.length,
    createdAssets: created,
    errors,
  });
});

module.exports = router;
