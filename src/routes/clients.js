const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { visibleProjects } = require('../permissions');
const clients = require('../clients');

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
async function clientsFor(user) {
  const projects = await visibleProjects(user);
  const byClient = new Map();
  for (const project of projects) {
    if (!byClient.has(project.client_id)) byClient.set(project.client_id, []);
    byClient.get(project.client_id).push(project);
  }

  const { roleDef } = require('../roles');
  const seesEverything = roleDef(user.role) && roleDef(user.role).projectScope === 'all';
  const { rows } = await db.query('SELECT * FROM clients ORDER BY is_system, `name`');

  return rows
    .filter((c) => seesEverything || byClient.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      contactName: c.contact_name,
      contactEmail: c.contact_email,
      notes: c.notes,
      isSystem: Boolean(c.is_system),
      createdAt: c.created_at,
      projects: (byClient.get(c.id) || []).map((p) => ({ id: p.id, name: p.name, code: p.code })),
      projectCount: (byClient.get(c.id) || []).length,
    }));
}

// GET /api/clients — the client list, each with the projects under it.
router.get('/', requirePermission('client.view'), async (req, res) => {
  res.json({ clients: await clientsFor(req.user) });
});

// GET /api/clients/:id — one client and its projects, for the breadcrumb view.
router.get('/:id', requirePermission('client.view'), async (req, res) => {
  const all = await clientsFor(req.user);
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
  if (count) {
    return res.status(409).json({
      error: `${client.name} still has ${count} project${count === 1 ? '' : 's'}. Move or delete them first.`,
      projectCount: count,
    });
  }
  await db.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
  console.log(`${req.user.email} deleted client "${client.name}".`);
  res.json({ ok: true });
});

module.exports = router;
