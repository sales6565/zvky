const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const lifecycle = require('../lifecycle');
const { visibleProjects, canAccessProject, holds } = require('../permissions');
const { assignableRoles, roleDef, supervisionRoles } = require('../roles');
const referenceData = require('../reference-data');
const assetSchedule = require('../asset-schedule');

/* The three fields a project carries besides its name and its client, checked
 * once for both the create and the edit route.
 *
 * All three are DESCRIPTIVE. Nothing in the pipeline reads them: an End Date
 * that has passed does not warn, block, or move anything, and a project with no
 * category behaves exactly as one with one. That is the studio's decision, and
 * it is written here so a later reader does not take the absence of a rule for
 * an oversight. The asset-level Start Date is the one that gates anything, and
 * it is a different field on a different table.
 *
 * Returns { ok:false, error, field } or { ok:true, sets:[[column, value], …] }
 * holding only the fields this request actually sent — so an edit that names
 * one of them leaves the other two alone, and `null` clears rather than skips.
 */
function checkProjectFields(body) {
  const sets = [];
  const b = body || {};

  if (b.category !== undefined) {
    const value = b.category === null || b.category === '' ? null : String(b.category);
    if (value !== null) {
      /* Against the PROJECT list, never the asset one. Reading the wrong
         collection here is the single mistake that would quietly merge two
         vocabularies that were deliberately kept apart. */
      const entry = referenceData.get('project_categories', value);
      if (!entry || !entry.isActive) {
        return { ok: false, field: 'category',
          error: 'That is not a project category. Add it in Settings first, or pick one from the list.' };
      }
    }
    sets.push(['category', value]);
  }

  // Dates are stored as they are typed. asISODate is the same reader the asset
  // schedule uses, so "2026-03-10" means the tenth here and there alike.
  const dates = {};
  for (const [key, column] of [['startDate', 'start_date'], ['endDate', 'end_date']]) {
    if (b[key] === undefined) continue;
    const raw = b[key];
    if (raw === null || raw === '') { sets.push([column, null]); dates[key] = null; continue; }
    const iso = assetSchedule.asISODate(raw);
    if (!iso) {
      return { ok: false, field: key, error: `That ${key === 'startDate' ? 'start' : 'end'} date is not a date.` };
    }
    sets.push([column, iso]);
    dates[key] = iso;
  }

  /* Only when BOTH are in this request. Checking a new start against an end
     date already stored would refuse an edit for a value the person cannot see
     in the form, which is the same reasoning the bulk asset scheduler uses. */
  if (dates.startDate && dates.endDate && dates.startDate > dates.endDate) {
    return { ok: false, field: 'startDate',
      error: `The start date (${dates.startDate}) is after the end date (${dates.endDate}). `
        + 'A project cannot end before it begins.' };
  }

  return { ok: true, sets };
}

router.use(authenticate);

// GET /api/projects — only the projects this user is allowed to see
//
// Each one also says how much unfinished work in it is this person's, which is
// what lets the app open on a project where they actually have something to do.
// Without it the page opened on the first client that had any work at all, by
// list order — so somebody handed an asset in a project they had not worked in
// before signed in, landed on a different client entirely, and saw an empty
// board. The asset was theirs, the API returned it, and the page was looking
// somewhere else.
router.get('/', async (req, res) => {
  const projects = await visibleProjects(req.user);
  const ids = projects.map((p) => p.id);
  let mine = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `SELECT project_id, COUNT(*) AS n FROM assets
        WHERE assignee_id = $1 AND project_id IN ($2)
          AND \`status\` NOT IN ('delivered', 'approved_for_client')
        GROUP BY project_id`,
      [req.user.id, ids]
    ).catch(() => ({ rows: [] }));
    mine = new Map(rows.map((r) => [r.project_id, Number(r.n) || 0]));
  }
  res.json({ projects: projects.map((p) => ({ ...p, my_open_assets: mine.get(p.id) || 0 })) });
});

// POST /api/projects — anyone whose role can create projects. The creator becomes the owner.
router.post('/', requirePermission('project.add'), async (req, res) => {
  const { name, clientId, teamLeadIds = [], coordinatorIds = [], supervisionIds = [] } = req.body || {};
  const verdict = checkName(name);
  if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: verdict.field });
  const supervision = await checkSupervision(supervisionIds);
  if (!supervision.ok) return res.status(400).json({ error: supervision.error, field: 'supervisionIds' });
  const extras = checkProjectFields(req.body);
  if (!extras.ok) return res.status(400).json({ error: extras.error, field: extras.field });

  // Every project belongs to a client, and the caller has to say which.
  //
  // This used to fall back to the "Unassigned" placeholder when no client was
  // named, which made the requirement true on paper while letting new work pile
  // up in a bucket nobody chose. The placeholder now holds only what predates
  // clients; nothing new lands there by accident.
  if (!clientId) {
    return res.status(400).json({ error: 'Choose a client for this project.', field: 'clientId' });
  }
  const clientRow = await resolveClient(clientId);
  if (!clientRow) return res.status(400).json({ error: 'That client does not exist.', field: 'clientId' });
  const refusal = lifecycle.clientRefusal(clientRow);
  if (refusal) return res.status(409).json({ error: refusal, field: 'clientId' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const id = uuid();
    /* The row first, then whichever of the three optional fields were sent.
       Written as a second statement rather than folded into the INSERT so the
       column list above stays the one every project has ever had — a create
       that names none of them writes exactly what it wrote before. */
    await client.query(
      'INSERT INTO projects (id, name, code, client_id, owner_id) VALUES ($1,$2,$3,$4,$5)',
      [id, verdict.value, codeFor(verdict.value), clientRow.id, req.user.id]
    );
    if (extras.sets.length) {
      const columns = extras.sets.map(([column], i) => `\`${column}\` = $${i + 1}`).join(', ');
      await client.query(`UPDATE projects SET ${columns} WHERE id = $${extras.sets.length + 1}`,
        [...extras.sets.map(([, value]) => value), id]);
    }
    for (const leadId of teamLeadIds) {
      await client.query(
        'INSERT IGNORE INTO project_team_leads (project_id, user_id) VALUES ($1,$2)',
        [id, leadId]
      );
    }
    for (const coordId of coordinatorIds) {
      await client.query(
        'INSERT IGNORE INTO project_coordinators (project_id, user_id) VALUES ($1,$2)',
        [id, coordId]
      );
    }
    for (const userId of supervision.value) {
      await client.query(
        'INSERT IGNORE INTO project_supervision (project_id, user_id) VALUES ($1,$2)',
        [id, userId]
      );
    }
    await client.query('COMMIT');
    const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
    req.activity({
      module: 'projects', action: 'project.create', entityType: 'project',
      entityId: rows[0].id, entityLabel: rows[0].name,
      summary: `Created the project "${rows[0].name}"`,
    });
    res.status(201).json({ project: await withMembers(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the project' });
  } finally {
    client.release();
  }
});

// The named client, or null when it does not exist. The row, not just the id,
// because whether it is archived or its deal is closed decides whether a new
// project may go under it.
async function resolveClient(clientId) {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  return rows.length ? rows[0] : null;
}

// The name rule, in one place, so creating and editing cannot disagree about
// what a valid project name is.
function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Project name is required', field: 'name' };
  }
  if (name.trim().length > 255) {
    return { ok: false, error: 'Project name is too long (255 characters at most)', field: 'name' };
  }
  return { ok: true, value: name.trim() };
}

// How many people may be named under supervision and creative direction. Two,
// because the studio holds one supervisor and one director answerable for a
// project's look; naming a committee makes "who signs this off" unanswerable.
//
// Checked here and not only in the browser. The form disables the boxes past
// two, but a disabled checkbox is a courtesy, not a rule — anything reaching
// this endpoint directly would otherwise write as many rows as it liked.
const SUPERVISION_LIMIT = 2;

// Whether this list may be written. Returns the de-duplicated ids on success,
// so the caller writes what was checked rather than what was sent.
async function checkSupervision(ids) {
  if (ids === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(ids)) {
    return { ok: false, error: 'supervisionIds must be a list of user ids' };
  }
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  if (unique.length > SUPERVISION_LIMIT) {
    return {
      ok: false,
      error: `Supervision and Creative Direction takes ${SUPERVISION_LIMIT} people at most — ${unique.length} were named.`,
    };
  }
  if (!unique.length) return { ok: true, value: unique };

  // Every id has to be a real account in one of the designations the section
  // offers. Without this the field would accept any user id at all, and the
  // list the form shows would be the only thing keeping it honest.
  const { rows } = await db.query(
    'SELECT id, `name`, `role` FROM users WHERE id IN ($1)', [unique]
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) return { ok: false, error: 'One of those people no longer exists.' };
  const eligible = new Set(supervisionRoles());
  const wrong = rows.filter((r) => !eligible.has(r.role));
  if (wrong.length) {
    return {
      ok: false,
      error: `${wrong[0].name} is not in a supervision or creative direction designation.`,
    };
  }
  return { ok: true, value: unique };
}

// The code is derived from the name and referenced by nothing else — asset
// codes are built from the asset type's prefix, not from this. Rederiving it on
// rename keeps the column meaning one thing.
function codeFor(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
}

// Whether this caller may change this particular project. The same reach rule
// delete uses: a studio-wide role reaches every project, everyone else only the
// ones they created. The permission says whether they may edit at all; the
// role's scope says which ones — the two are different questions.
function mayChange(user, project) {
  return roleDef(user.role).projectScope === 'all' || project.owner_id === user.id;
}

// PATCH /api/projects/:id — rename a project and change who is attached to it.
//
// Deliberately narrow: it writes the projects row and the two membership
// tables, and nothing else. Assets keep their project_id, their assignees and
// their place in the pipeline; contributors in project_members are not touched,
// because taking a lead off a project is not a statement about the artists
// working on it.
router.patch('/:id', requirePermission('project.edit'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only edit projects you created' });
  }
  const shut = lifecycle.projectRefusal(project);
  if (shut) return res.status(409).json({ error: shut, projectClosed: true });

  const { name, clientId, teamLeadIds, coordinatorIds, supervisionIds } = req.body || {};

  // Every field is optional; only what was sent is written. Sending nothing is
  // not an error, it just changes nothing.
  let newName = null;
  if (name !== undefined) {
    const verdict = checkName(name);
    if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: verdict.field });
    newName = verdict.value;
  }
  for (const [value, label] of [[teamLeadIds, 'teamLeadIds'], [coordinatorIds, 'coordinatorIds']]) {
    if (value !== undefined && !Array.isArray(value)) {
      return res.status(400).json({ error: `${label} must be a list of user ids`, field: label });
    }
  }
  const supervision = await checkSupervision(supervisionIds);
  if (!supervision.ok) return res.status(400).json({ error: supervision.error, field: 'supervisionIds' });
  const extras = checkProjectFields(req.body);
  if (!extras.ok) return res.status(400).json({ error: extras.error, field: extras.field });

  // Moving a project to another client. How the "Unassigned" pile gets sorted
  // out, so it has to be possible from the edit form.
  let newClient = null;
  if (clientId !== undefined) {
    const target = await resolveClient(clientId);
    if (!target) return res.status(400).json({ error: 'That client does not exist.', field: 'clientId' });
    // Moving a project onto a client is the same act as creating one there.
    const blocked = lifecycle.clientRefusal(target);
    if (blocked) return res.status(409).json({ error: blocked, field: 'clientId' });
    newClient = target.id;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (newName !== null) {
      await client.query('UPDATE projects SET `name` = $1, `code` = $2 WHERE id = $3',
        [newName, codeFor(newName), project.id]);
    }
    if (newClient) {
      await client.query('UPDATE projects SET client_id = $1 WHERE id = $2', [newClient, project.id]);
    }
    // Only the ones this request named. An edit form that does not carry these
    // fields therefore cannot blank them by omission.
    if (extras.sets.length) {
      const columns = extras.sets.map(([column], i) => `\`${column}\` = $${i + 1}`).join(', ');
      await client.query(`UPDATE projects SET ${columns} WHERE id = $${extras.sets.length + 1}`,
        [...extras.sets.map(([, value]) => value), project.id]);
    }
    // Replaced wholesale rather than diffed: the form sends the complete list
    // it is showing, so anything missing from it was unticked.
    for (const [ids, table] of [[teamLeadIds, 'project_team_leads'], [coordinatorIds, 'project_coordinators'],
      [supervision.value, 'project_supervision']]) {
      if (ids === undefined) continue;
      await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [project.id]);
      for (const userId of ids) {
        await client.query(`INSERT IGNORE INTO ${table} (project_id, user_id) VALUES ($1,$2)`,
          [project.id, userId]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not save the project' });
  } finally {
    client.release();
  }

  const { rows: saved } = await db.query('SELECT * FROM projects WHERE id = $1', [project.id]);
  console.log(`${req.user.email} updated project "${saved[0].name}".`);
  return res.json({ project: await withMembers(saved[0]) });
});

// GET /api/projects/:id — one project with who is attached to it, for the edit
// form. Readable by anyone who can reach the project; editing is gated above.
router.get('/:id', async (req, res) => {
  const allowed = await canAccessProject(req.user, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: await withMembers(rows[0]) });
});

// A project plus the ids attached to it, which is what the edit form needs to
// tick the right boxes.
async function withMembers(project) {
  const [leads, coords, supervision] = await Promise.all([
    db.query('SELECT user_id FROM project_team_leads WHERE project_id = $1', [project.id]),
    db.query('SELECT user_id FROM project_coordinators WHERE project_id = $1', [project.id]),
    db.query('SELECT user_id FROM project_supervision WHERE project_id = $1', [project.id]),
  ]);
  return {
    ...project,
    teamLeadIds: leads.rows.map((r) => r.user_id),
    coordinatorIds: coords.rows.map((r) => r.user_id),
    supervisionIds: supervision.rows.map((r) => r.user_id),
  };
}

// DELETE /api/projects/:id — a studio-wide role may delete any project,
// everyone else only the ones they own.
router.delete('/:id', requirePermission('project.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only delete projects you created' });
  }
  // Soft by default, following the convention the value lists set: something
  // with records under it is deactivated, never deleted, and everything that
  // depends on it keeps working. A project holds assets, their submissions and
  // their whole review history — none of that is worth destroying to tidy a
  // list. Hard delete survives for the one case where it costs nothing: a
  // project with no assets at all, and only when asked for explicitly.
  const { rows: held } = await db.query('SELECT COUNT(*) AS n FROM assets WHERE project_id = $1', [req.params.id]);
  const assetCount = Number(held[0].n);
  const wantsHardDelete = req.query.purge === '1' || req.query.purge === 'true';

  if (wantsHardDelete) {
    if (assetCount) {
      return res.status(409).json({
        error: `${project.name} holds ${assetCount} asset${assetCount === 1 ? '' : 's'}. Archive it instead — nothing is lost and it can be restored.`,
        assetCount,
      });
    }
    await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    console.log(`${req.user.email} deleted the empty project "${project.name}".`);
    return res.json({ ok: true, deleted: true });
  }

  if (!project.is_active) return res.json({ ok: true, archived: true, alreadyArchived: true });

  // Work still in flight is worth a second look before it disappears from
  // everybody's dashboard.
  const unfinished = await lifecycle.unfinishedAssets(db, req.params.id);
  if (unfinished && req.query.confirm !== '1' && req.query.confirm !== 'true') {
    return res.status(409).json({
      requiresConfirmation: true,
      error: `${project.name} has ${unfinished} asset${unfinished === 1 ? '' : 's'} that ${unfinished === 1 ? 'has' : 'have'} not been delivered. Archiving hides the project and its work from every dashboard until it is restored.`,
      unfinished,
    });
  }

  await db.query('UPDATE projects SET is_active = 0, archived_at = NOW() WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} archived project "${project.name}" (${assetCount} asset(s) kept).`);
  return res.json({ ok: true, archived: true, assetCount });
});

// POST /api/projects/:id/restore — bring an archived project back.
router.post('/:id/restore', requirePermission('project.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only restore projects you created' });
  }
  // Restoring into an archived client would put it somewhere still hidden.
  const { rows: owner } = await db.query('SELECT * FROM clients WHERE id = $1', [project.client_id]);
  if (owner.length && !owner[0].is_active) {
    return res.status(409).json({ error: `${owner[0].name} is archived. Restore the client first.` });
  }
  await db.query('UPDATE projects SET is_active = 1, archived_at = NULL WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} restored project "${project.name}".`);
  res.json({ ok: true, restored: true });
});

// POST /api/projects/:id/close  and  /reopen
//
// Separate from archiving, and from the client's deal status. A closed project
// is finished work that stays visible: it takes no new assets, and its existing
// ones are read-only until somebody reopens it.
router.post('/:id/close', requirePermission('project.close'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only close projects you created' });
  }
  if (project.closed_at) return res.json({ ok: true, closed: true, alreadyClosed: true });

  const unfinished = await lifecycle.unfinishedAssets(db, req.params.id);
  if (unfinished && req.body && req.body.confirm !== true) {
    return res.status(409).json({
      requiresConfirmation: true,
      error: `${project.name} has ${unfinished} asset${unfinished === 1 ? '' : 's'} that ${unfinished === 1 ? 'has' : 'have'} not been delivered. Closing makes ${unfinished === 1 ? 'it' : 'them'} read-only — no submissions, reviews or edits — until the project is reopened.`,
      unfinished,
    });
  }

  await db.query('UPDATE projects SET closed_at = NOW() WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} closed project "${project.name}".`);
  return res.json({ ok: true, closed: true, unfinished });
});

router.post('/:id/reopen', requirePermission('project.close'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!mayChange(req.user, project)) {
    return res.status(403).json({ error: 'You can only reopen projects you created' });
  }
  await db.query('UPDATE projects SET closed_at = NULL WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} reopened project "${project.name}".`);
  res.json({ ok: true, closed: false });
});

/* GET /api/projects/:id/artists — who the New Asset form offers as assignee.
 *
 * Two answers, because two permissions ask different questions.
 *
 * NARROW (the default, unchanged): any contributor designation REPORTING TO one
 * of this project's leads. Note what that filter actually is — a reporting
 * line, not project membership. Somebody on the project who reports to a
 * different lead, or to nobody, was never in this list. That is the whole of
 * the "partial list" this endpoint was reported for. It is kept because it is
 * what the narrow permission is for: a lead staffing their own team's work.
 * When the project has no leads attached there is no line to follow, so it
 * falls back to every contributor rather than offering nobody.
 *
 * WIDE (asset.assign_any): every contributor in the studio. No project, no
 * reporting line — that is what the permission says. It is a list of PEOPLE and
 * says nothing about which assets the holder may touch; the assignment itself
 * is still checked when it is made.
 */
router.get('/:id/artists', async (req, res) => {
  const allowed = await canAccessProject(req.user, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'No access to this project' });

  if (holds(req.user, 'asset.assign_any')) {
    const { rows } = await db.query(
      'SELECT u.id, u.name, u.role FROM users u WHERE u.role IN ($1) ORDER BY u.name',
      [assignableRoles()]
    );
    return res.json({ artists: rows, scope: 'all' });
  }

  const { rows: leads } = await db.query(
    'SELECT user_id FROM project_team_leads WHERE project_id = $1',
    [req.params.id]
  );

  const sql = leads.length
    ? `SELECT u.id, u.name, u.role FROM users u
       WHERE u.role IN ($1) AND u.team_lead_id IN ($2)
       ORDER BY u.name`
    : `SELECT u.id, u.name, u.role FROM users u
       WHERE u.role IN ($1) ORDER BY u.name`;
  const params = leads.length
    ? [assignableRoles(), leads.map((l) => l.user_id)]
    : [assignableRoles()];

  const { rows } = await db.query(sql, params);
  res.json({ artists: rows, scope: leads.length ? 'reports-to-project-leads' : 'all-contributors' });
});

module.exports = router;
