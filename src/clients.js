// Clients, and the projects under them.
//
// The reason this is a module rather than code inside the route: "add a client
// with three projects" and "add three more projects to an existing client" are
// the same operation with a different starting point. Writing them twice would
// mean two sets of validation rules that agree until somebody changes one.
// Everything below is shared; the routes decide only whether a client is being
// created first.

const { v4: uuid } = require('uuid');

const NAME_MAX = 255;
const EMAIL_MAX = 191;

// --- validation ----------------------------------------------------------------
//
// Every check returns a field name alongside its message, so a form can put the
// error on the input that caused it rather than at the top of the page. Project
// rows carry their index too — with five rows on screen, "Project name is
// required" is useless without knowing which one.

function checkName(value, field = 'name', label = 'Name') {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${label} is required`, field };
  }
  if (value.trim().length > NAME_MAX) {
    return { error: `${label} is too long (${NAME_MAX} characters at most)`, field };
  }
  return null;
}

function checkEmail(value, field = 'contactEmail') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > EMAIL_MAX) {
    return { error: `Contact email is too long (${EMAIL_MAX} characters at most)`, field };
  }
  // Deliberately loose. This is a note-to-self field, not a login, and nothing
  // is ever sent to it — refusing an unusual but real address would be worse
  // than accepting a typo.
  if (!/^[^\s@]+@[^\s@]+$/.test(value.trim())) {
    return { error: 'That does not look like an email address', field };
  }
  return null;
}

// The client's own fields. `partial` is for an edit, where sending nothing is
// not the same as sending blank.
function validateClient(body, { partial = false } = {}) {
  const errors = [];
  const values = {};

  if (!partial || body.name !== undefined) {
    const bad = checkName(body.name, 'name', 'Client name');
    if (bad) errors.push(bad);
    else values.name = body.name.trim();
  }
  for (const [key, field] of [['contactName', 'contactName'], ['notes', 'notes']]) {
    if (body[key] !== undefined) {
      if (body[key] !== null && typeof body[key] !== 'string') {
        errors.push({ error: `${field} must be text`, field });
      } else {
        values[key] = body[key] ? String(body[key]).trim() : null;
      }
    }
  }
  if (values.contactName && values.contactName.length > NAME_MAX) {
    errors.push({ error: `Contact name is too long (${NAME_MAX} characters at most)`, field: 'contactName' });
  }
  if (body.contactEmail !== undefined) {
    const bad = checkEmail(body.contactEmail);
    if (bad) errors.push(bad);
    else values.contactEmail = body.contactEmail ? body.contactEmail.trim() : null;
  }

  return { ok: errors.length === 0, errors, values };
}

// The repeatable project rows, validated as a set rather than one at a time.
//
// All of them are checked before any of them is written, and the whole list is
// reported at once — filling in a form five times to be told about five
// separate problems is not a form, it is an interrogation.
function validateProjectRows(rows, { existingNames = [] } = {}) {
  const errors = [];
  const values = [];
  if (rows === undefined || rows === null) return { ok: true, errors, values };
  if (!Array.isArray(rows)) {
    return { ok: false, errors: [{ error: 'projects must be a list', field: 'projects' }], values };
  }

  const seen = new Map();
  for (const name of existingNames) seen.set(name.trim().toLowerCase(), -1);

  rows.forEach((row, index) => {
    const at = (error, field) => errors.push({ ...error, index, field: field || error.field });
    if (!row || typeof row !== 'object') {
      errors.push({ error: 'Each project row must be an object', field: 'name', index });
      return;
    }
    const bad = checkName(row.name, 'name', 'Project name');
    if (bad) { at(bad); return; }

    const name = row.name.trim();
    const key = name.toLowerCase();
    // Two rows of the same form naming the same project is a mistake worth
    // catching before it becomes two projects.
    if (seen.has(key)) {
      const first = seen.get(key);
      errors.push({
        error: first === -1
          ? `${name} already exists under this client`
          : `"${name}" is named twice on this form`,
        field: 'name', index,
      });
      return;
    }
    seen.set(key, index);

    for (const [key2, field] of [['teamLeadIds', 'teamLeadIds'], ['coordinatorIds', 'coordinatorIds']]) {
      if (row[key2] !== undefined && !Array.isArray(row[key2])) {
        errors.push({ error: `${field} must be a list of user ids`, field, index });
      }
    }

    values.push({
      name,
      teamLeadIds: Array.isArray(row.teamLeadIds) ? row.teamLeadIds : [],
      coordinatorIds: Array.isArray(row.coordinatorIds) ? row.coordinatorIds : [],
    });
  });

  return { ok: errors.length === 0, errors, values };
}

// --- writing -------------------------------------------------------------------

// The code shown against a project. Derived, referenced by nothing else.
function codeFor(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 64);
}

// Insert one project row on an open transaction. Not exported: callers go
// through createProjects, which is the thing that has to be all-or-nothing.
async function insertProject(client, { name, teamLeadIds, coordinatorIds }, clientId, ownerId) {
  const id = uuid();
  await client.query(
    'INSERT INTO projects (id, `name`, `code`, client_id, owner_id) VALUES ($1,$2,$3,$4,$5)',
    [id, name, codeFor(name), clientId, ownerId]
  );
  for (const [ids, table] of [[teamLeadIds, 'project_team_leads'], [coordinatorIds, 'project_coordinators']]) {
    for (const userId of ids) {
      await client.query(`INSERT IGNORE INTO ${table} (project_id, user_id) VALUES ($1,$2)`, [id, userId]);
    }
  }
  return { id, name, code: codeFor(name) };
}

// Create a client and, optionally, the projects named on the same form.
//
// One transaction over the lot. A form that produced a client and two of its
// three projects would be worse than one that produced nothing: the person
// would have to work out which row failed and add only that one, and the
// half-made client would already be in everybody else's list.
async function createClientWithProjects(db, body, actor) {
  const client = validateClient(body);
  const projects = validateProjectRows(body.projects);
  if (!client.ok || !projects.ok) {
    return { ok: false, status: 400, errors: [...client.errors, ...projects.errors] };
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const id = uuid();
    await conn.query(
      'INSERT INTO clients (id, `name`, contact_name, contact_email, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, client.values.name, client.values.contactName || null,
        client.values.contactEmail || null, client.values.notes || null, actor.id]
    );
    const created = [];
    for (const row of projects.values) {
      created.push(await insertProject(conn, row, id, actor.id));
    }
    await conn.query('COMMIT');
    return { ok: true, clientId: id, projects: created };
  } catch (err) {
    await conn.query('ROLLBACK');
    if (err.code === 'ER_DUP_ENTRY') {
      return { ok: false, status: 409, errors: [{ error: 'A client with that name already exists', field: 'name' }] };
    }
    throw err;
  } finally {
    conn.release();
  }
}

// Add projects to a client that already exists. The same validation and the
// same insert as above — this is why they live here rather than in a route.
async function addProjectsToClient(db, clientId, rows, actor, { existingNames = [] } = {}) {
  const projects = validateProjectRows(rows, { existingNames });
  if (!projects.ok) return { ok: false, status: 400, errors: projects.errors };
  if (!projects.values.length) return { ok: true, projects: [] };

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const created = [];
    for (const row of projects.values) {
      created.push(await insertProject(conn, row, clientId, actor.id));
    }
    await conn.query('COMMIT');
    return { ok: true, projects: created };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  NAME_MAX,
  validateClient,
  validateProjectRows,
  createClientWithProjects,
  addProjectsToClient,
  codeFor,
};
