const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects } = require('../permissions');
const clients = require('../clients');
const lifecycle = require('../lifecycle');

router.use(authenticate);

// One shape for every refusal: the first message as `error` so a caller that
// only shows one thing shows something sensible, `field` so a form can mark the
// input, and the whole list as `errors` so a repeatable form can mark every row
// at once instead of making somebody submit five times.
function problem(errors) {
  const first = errors[0] || {};
  return { error: first.error, field: first.field, errors };
}

// Clients are read through the projects the caller can already see.
//
// Reach stays with the role, exactly as it does everywhere else: a contributor
// looking at the client list sees the clients whose projects they have work in,
// not the studio's customer list. A client with no visible projects is only
// shown to somebody who can see the whole studio — otherwise an empty client
// would leak the fact that it exists.
async function clientsFor(user, { includeArchived = false } = {}) {
  const projects = await visibleProjects(user);
  const byClient = new Map();
  for (const project of projects) {
    if (!byClient.has(project.client_id)) byClient.set(project.client_id, []);
    byClient.get(project.client_id).push(project);
  }

  const { roleDef } = require('../roles');
  const seesEverything = roleDef(user.role) && roleDef(user.role).projectScope === 'all';
  const { rows } = await db.query('SELECT * FROM clients ORDER BY is_system, `name`');

  // Archived projects are already out of visibleProjects, so an archived
  // client's live projects are asked for separately when one is being looked
  // at on purpose.
  const archivedProjects = includeArchived ? await archivedProjectsByClient(db) : new Map();

  return rows
    .filter((c) => includeArchived || c.is_active)
    .filter((c) => seesEverything || byClient.has(c.id) || (includeArchived && archivedProjects.has(c.id)))
    .map((c) => {
      const live = byClient.get(c.id) || [];
      const archived = archivedProjects.get(c.id) || [];
      return {
        id: c.id,
        name: c.name,
        contactName: c.contact_name,
        contactEmail: c.contact_email,
        notes: c.notes,
        isSystem: Boolean(c.is_system),
        isActive: Boolean(c.is_active),
        archivedAt: c.archived_at,
        dealClosedAt: c.deal_closed_at,
        // One word for what a badge should say, decided here rather than in
        // three places in the browser.
        status: !c.is_active ? 'archived' : (c.deal_closed_at ? 'deal_closed' : 'active'),
        takesNewProjects: lifecycle.clientTakesNewProjects(c),
        createdAt: c.created_at,
        projects: live.map((p) => ({
          id: p.id, name: p.name, code: p.code,
          isActive: true, closedAt: p.closed_at || null,
          status: p.closed_at ? 'closed' : 'active',
        })),
        archivedProjects: archived.map((p) => ({
          id: p.id, name: p.name, code: p.code, isActive: false,
          closedAt: p.closed_at || null, status: 'archived',
        })),
        projectCount: live.length,
      };
    });
}

// Archived projects, which visibleProjects deliberately leaves out. Only read
// when somebody asks to see archived things, and only for a caller who can see
// the whole studio — a scoped role has no path to a project that is out of
// every scope.
async function archivedProjectsByClient(db) {
  const { rows } = await db.query('SELECT * FROM projects WHERE is_active = 0');
  const byClient = new Map();
  for (const project of rows) {
    if (!byClient.has(project.client_id)) byClient.set(project.client_id, []);
    byClient.get(project.client_id).push(project);
  }
  return byClient;
}

// GET /api/clients — the client list, each with the projects under it.
router.get('/', requirePermission('client.view'), async (req, res) => {
  // Archived clients and projects are only listed when asked for, so the
  // ordinary list stays the live studio.
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  res.json({ clients: await clientsFor(req.user, { includeArchived }), includeArchived });
});

// GET /api/clients/:id — one client and its projects, for the breadcrumb view.
router.get('/:id', requirePermission('client.view'), async (req, res) => {
  const all = await clientsFor(req.user, { includeArchived: true });
  const found = all.find((c) => c.id === req.params.id);
  if (!found) return res.status(404).json({ error: 'Client not found' });
  res.json({ client: found });
});

// POST /api/clients — a client, and any projects named on the same form.
//
// Creating projects here needs the project permission as well: "add a client"
// and "add a project" are different things to be trusted with, and a form that
// does both should not be a way around the second.
router.post('/', requirePermission('client.add'), async (req, res) => {
  const wantsProjects = Array.isArray(req.body && req.body.projects) && req.body.projects.length > 0;
  if (wantsProjects && !req.permissions.has('project.add')) {
    return res.status(403).json({
      error: 'You can add a client, but not projects under it.', field: 'projects',
    });
  }

  const result = await clients.createClientWithProjects(db, req.body || {}, req.user);
  if (!result.ok) return res.status(result.status).json(problem(result.errors));
  console.log(`${req.user.email} added client "${(req.body || {}).name}" with ${result.projects.length} project(s).`);
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [result.clientId]);
  res.status(201).json({
    client: { id: rows[0].id, name: rows[0].name, isSystem: Boolean(rows[0].is_system) },
    projects: result.projects,
  });
});

// PATCH /api/clients/:id — edit the client, and/or add more projects under it.
//
// The same two operations the create form does, in the same transaction rules,
// through the same module. Adding projects later is not a different feature.
router.patch('/:id', requirePermission('client.edit'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const body = req.body || {};
  const wantsProjects = Array.isArray(body.projects) && body.projects.length > 0;
  if (wantsProjects && !req.permissions.has('project.add')) {
    return res.status(403).json({
      error: 'You can edit this client, but not add projects under it.', field: 'projects',
    });
  }
  // A closed deal or an archived client takes no new projects, whichever form
  // the request arrives through.
  if (wantsProjects) {
    const refusal = lifecycle.clientRefusal(client);
    if (refusal) return res.status(409).json({ error: refusal, field: 'projects' });
  }

  // Validate everything before writing anything, so a bad project row cannot
  // leave the client renamed and the projects missing.
  const details = clients.validateClient(body, { partial: true });
  const { rows: siblings } = await db.query('SELECT `name` FROM projects WHERE client_id = $1', [req.params.id]);
  const rowCheck = clients.validateProjectRows(body.projects, {
    existingNames: siblings.map((p) => p.name),
  });
  if (!details.ok || !rowCheck.ok) {
    return res.status(400).json(problem([...details.errors, ...rowCheck.errors]));
  }

  const fields = [];
  const values = [];
  for (const [key, column] of [['name', 'name'], ['contactName', 'contact_name'],
    ['contactEmail', 'contact_email'], ['notes', 'notes']]) {
    if (details.values[key] !== undefined) {
      fields.push(`\`${column}\` = $${fields.length + 1}`);
      values.push(details.values[key]);
    }
  }
  if (fields.length) {
    values.push(req.params.id);
    try {
      await db.query(`UPDATE clients SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A client with that name already exists', field: 'name' });
      }
      throw err;
    }
  }

  const added = await clients.addProjectsToClient(db, req.params.id, body.projects, req.user, {
    existingNames: siblings.map((p) => p.name),
  });
  if (!added.ok) return res.status(added.status).json(problem(added.errors));

  console.log(`${req.user.email} updated client "${client.name}"${added.projects.length ? ` and added ${added.projects.length} project(s)` : ''}.`);
  const all = await clientsFor(req.user);
  res.json({ client: all.find((c) => c.id === req.params.id), added: added.projects });
});

// DELETE /api/clients/:id — only when it is empty, and never the system one.
router.delete('/:id', requirePermission('client.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.is_system) {
    return res.status(409).json({
      error: 'Unassigned is where projects go when they have no client yet, so it cannot be deleted. Rename it if you like.',
    });
  }
  const { rows: held } = await db.query('SELECT COUNT(*) AS n FROM projects WHERE client_id = $1', [req.params.id]);
  const count = Number(held[0].n);
  const wantsHardDelete = req.query.purge === '1' || req.query.purge === 'true';

  // Hard delete only for a client holding nothing — the same rule a value list
  // applies to a value nothing uses. Anything else is archived, so the projects
  // under it, their assets and every review decision stay exactly where they
  // are and come back intact when the client is restored.
  if (wantsHardDelete) {
    if (count) {
      return res.status(409).json({
        error: `${client.name} still has ${count} project${count === 1 ? '' : 's'}. Archive it instead — nothing is lost and it can be restored.`,
        projectCount: count,
      });
    }
    await db.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    console.log(`${req.user.email} deleted the empty client "${client.name}".`);
    return res.json({ ok: true, deleted: true });
  }

  if (!client.is_active) return res.json({ ok: true, archived: true, alreadyArchived: true });

  // Live projects underneath are the case worth stopping. Somebody archiving a
  // client with work still running almost always means "the engagement is
  // over", which is the deal status rather than this — so say so, and let them
  // go ahead deliberately if they really do mean to hide the lot.
  const live = await lifecycle.activeProjectsUnder(db, req.params.id);
  const confirmed = req.query.confirm === '1' || req.query.confirm === 'true';
  if (live.length && !confirmed) {
    return res.status(409).json({
      requiresConfirmation: true,
      error: `${client.name} has ${live.length} project${live.length === 1 ? '' : 's'} still open. Close or move ${live.length === 1 ? 'it' : 'them'} first, mark the deal closed instead, or confirm to archive the client and everything under it.`,
      activeProjects: live.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  // Archiving the client archives its projects too — a project whose client is
  // hidden has nowhere to be reached from, so leaving them behind would put
  // them in a picker under a client that is no longer listed.
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('UPDATE clients SET is_active = 0, archived_at = NOW() WHERE id = $1', [req.params.id]);
    // Stamped from the client's own row, so "archived with the client" is an
    // exact match rather than two NOW() calls that may land either side of a
    // second boundary.
    await conn.query(
      `UPDATE projects p JOIN clients c ON c.id = p.client_id
          SET p.is_active = 0, p.archived_at = c.archived_at
        WHERE p.client_id = $1 AND p.is_active = 1`,
      [req.params.id]
    );
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
  console.log(`${req.user.email} archived client "${client.name}" and ${count} project(s) under it.`);
  return res.json({ ok: true, archived: true, projectCount: count });
});

// POST /api/clients/:id/restore — bring an archived client back.
//
// Its projects come back with it, because they went with it. A project that was
// already archived on its own before the client was stays archived: it was a
// separate decision and this is not the place to undo it.
router.post('/:id/restore', requirePermission('client.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.is_active) return res.json({ ok: true, restored: true, alreadyActive: true });

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    // The projects first, and matched against the client's own archived_at
    // inside the database rather than by sending the timestamp out to JavaScript
    // and back. A DATETIME that round-trips through a Date can come back a
    // fraction different, and "the same moment" then quietly matches nothing.
    await conn.query(
      `UPDATE projects p JOIN clients c ON c.id = p.client_id
          SET p.is_active = 1, p.archived_at = NULL
        WHERE p.client_id = $1 AND p.is_active = 0 AND p.archived_at = c.archived_at`,
      [req.params.id]
    );
    await conn.query('UPDATE clients SET is_active = 1, archived_at = NULL WHERE id = $1', [req.params.id]);
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
  console.log(`${req.user.email} restored client "${client.name}".`);
  res.json({ ok: true, restored: true });
});

// POST /api/clients/:id/close-deal  and  /reopen-deal
//
// The engagement, not the work. A closed deal takes no new projects and shows a
// badge wherever the client appears; the projects already under it are left
// running. Closing a deal is a commercial fact, and whether the work on it
// should stop is a separate call, made per project by whoever is running it.
router.post('/:id/close-deal', requirePermission('client.close'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.is_system) {
    return res.status(409).json({ error: `${client.name} is where projects go when they have no client yet — it has no deal to close.` });
  }
  if (client.deal_closed_at) return res.json({ ok: true, dealClosed: true, alreadyClosed: true });

  await db.query('UPDATE clients SET deal_closed_at = NOW() WHERE id = $1', [req.params.id]);
  const live = await lifecycle.activeProjectsUnder(db, req.params.id);
  console.log(`${req.user.email} closed the deal with "${client.name}" (${live.length} project(s) left running).`);
  res.json({
    ok: true,
    dealClosed: true,
    // Named so the browser can say "3 projects are still running" rather than
    // leaving somebody to wonder whether closing the deal stopped the work.
    stillRunning: live.map((p) => ({ id: p.id, name: p.name })),
  });
});

router.post('/:id/reopen-deal', requirePermission('client.close'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  await db.query('UPDATE clients SET deal_closed_at = NULL WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} reopened the deal with "${client.name}".`);
  res.json({ ok: true, dealClosed: false });
});

module.exports = router;
