const { asyncRouter } = require('../async-router');
const reporting = require('../reporting');
const userProject = require('../user-project');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requireCapability, requirePermission, can } = require('../middleware/auth');
const { roleKeys, activeRoles, isRole, roleDef, capabilitiesFor } = require('../roles');
const passwordPolicy = require('../password-policy');
const fs = require('node:fs');
const importFile = require('../import-file');
const userImport = require('../user-import');
const { uploadImport } = require('../upload');
const { visibleProjects, hasFullAccess, holds } = require('../permissions');

// The cost used everywhere passwords are hashed in this codebase.
const BCRYPT_ROUNDS = 10;

router.use(authenticate);

const DEFAULT_PASSWORD = 'zvky2026'; // demo default; real deployments should force a reset on first login

// Which designations a given manager is allowed to hand out. Super admins can
// assign anything; an admin can staff up their own projects but cannot mint
// another account that manages users or sees the whole studio.
function assignableRolesFor(user) {
  const def = roleDef(user.role);
  // Keyed off the permission rather than the raw capability, so a grant of
  // user.add or user.change_role actually produces a list of roles to pick
  // from. Reading the capability here meant the route let somebody through and
  // then handed them an empty catalogue.
  if (!holds(user, 'user.add') && !holds(user, 'user.change_role')) return [];
  if (!def) return [];
  // Only roles that are still active can be handed out; a deactivated one
  // stays valid for whoever already holds it.
  const available = activeRoles().map((r) => r.key);
  if (def.projectScope === 'all') return available;
  return available.filter((key) => {
    const r = roleDef(key);
    return !r.manageUsers && r.projectScope !== 'all';
  });
}

// GET /api/users?search=&limit=&offset=&role=
// A studio-wide manager sees everyone; an admin sees only users they added.
router.get('/', requirePermission('user.view'), async (req, res) => {
  const { search = '', limit = 60, offset = 0, role } = req.query;
  const params = [];
  let sql = 'SELECT id, name, email, role, manager_id, team_lead_id, reports_to_id, created_at FROM users WHERE 1=1';

  if (roleDef(req.user.role).projectScope !== 'all') {
    params.push(req.user.id);
    sql += ` AND manager_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    sql += ` AND (lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length})`;
  }
  // `role` may be a single key or a comma-separated list, so the frontend can
  // ask for "anyone who can be assigned work" in one call.
  if (role) {
    const wanted = String(role).split(',').map((r) => r.trim()).filter(isRole);
    if (!wanted.length) return res.json({ users: [], total: 0 });
    params.push(wanted);
    sql += ` AND role IN ($${params.length})`;
  }

  const { rows: countRows } = await db.query(`SELECT COUNT(*) AS n FROM (${sql}) x`, params);
  sql += ' ORDER BY name';
  params.push(Number(limit));
  sql += ` LIMIT $${params.length}`;
  params.push(Number(offset));
  sql += ` OFFSET $${params.length}`;

  const { rows } = await db.query(sql, params);

  // Resolve each row's manager name and project for the list, in two queries
  // rather than per row.
  const ids = rows.map((r) => r.id);
  const managerIds = [...new Set(rows.map((r) => r.reports_to_id).filter(Boolean))];
  const projects = await userProject.projectsForUsers(db, ids);
  const managers = new Map();
  if (managerIds.length) {
    const { rows: found } = await db.query('SELECT id, `name` FROM users WHERE id IN (?)', [managerIds]);
    for (const m of found) managers.set(m.id, m.name);
  }

  res.json({
    users: rows.map((row) => {
      const top = reporting.isTopOfHierarchy(row.role);
      const project = projects.get(row.id) || null;
      return {
        ...row,
        topOfHierarchy: top,
        // Leadership has no reporting line at all, rather than an empty one.
        reportsToId: top ? null : row.reports_to_id || null,
        reportsToName: top ? null : (row.reports_to_id ? managers.get(row.reports_to_id) || null : null),
        projectId: project ? project.id : null,
        projectName: project ? project.name : null,
      };
    }),
    total: Number(countRows[0].n),
  });
});

// POST /api/users — create an account with one of the studio's designations.
router.post('/', requirePermission('user.add'), async (req, res) => {
  const { name, email, role, teamLeadId, projectId, password } = req.body || {};
  if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
  if (!isRole(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!assignableRolesFor(req.user).includes(role)) {
    return res.status(403).json({ error: `You cannot create accounts with the ${roleDef(role).label} role` });
  }

  // Only when an administrator types one. The generated default below is a
  // temporary credential the new user is expected to replace on first sign-in.
  if (password !== undefined && password !== '') {
    const verdict = passwordPolicy.check(password);
    if (!verdict.valid) return res.status(400).json({ error: verdict.message, failed: verdict.failed });
  }

  const { rows: existing } = await db.query('SELECT 1 AS ok FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.length) return res.status(409).json({ error: 'That email is already in use' });

  const def = roleDef(role);
  const hash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  const id = uuid();

  // Only contributors report to a lead; a lead or coordinator does not.
  const leadId = def.assignable ? teamLeadId || null : null;

  await db.query(
    `INSERT INTO users (id, name, email, password_hash, role, manager_id, team_lead_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name.trim(), email.trim(), hash, role, req.user.id, leadId]
  );

  // Attach them to the project they were created for, on whichever side of the
  // project their role sits.
  //
  // Through the same helper Edit User uses, so all three tables are covered.
  // This branch used to name only the coordinator and lead tables, so creating
  // a contributor "on" a project attached them to nothing — the account looked
  // staffed and the permission checks disagreed.
  if (projectId) {
    await userProject.setProject(db, id, projectId, role);
  }

  const { rows } = await db.query(
    'SELECT id, name, email, role, manager_id, team_lead_id FROM users WHERE id = $1',
    [id]
  );
  res.status(201).json({
    user: { ...rows[0], capabilities: capabilitiesFor(role) },
    temporaryPassword: password ? undefined : DEFAULT_PASSWORD,
  });
});

// One shape for a user everywhere: the row plus the two things this screen
// edits, resolved to names rather than ids so the caller does not have to look
// them up again.
const USER_COLUMNS =
  'u.id, u.`name`, u.email, u.`role`, u.manager_id, u.team_lead_id, u.reports_to_id, u.created_at';

async function describeUser(row) {
  const project = await userProject.currentProject(db, row.id);
  const top = reporting.isTopOfHierarchy(row.role);
  let manager = null;
  if (!top && row.reports_to_id) {
    const { rows } = await db.query('SELECT id, `name`, email, `role` FROM users WHERE id = $1', [row.reports_to_id]);
    if (rows.length) manager = { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role };
  }
  return {
    ...row,
    capabilities: capabilitiesFor(row.role),
    // Leadership reports to no one, so the field is absent rather than empty —
    // an empty dropdown reads as "not filled in yet", which is a different
    // thing and the one that invites somebody to fill it in.
    topOfHierarchy: top,
    reportsTo: manager,
    reportsToId: top ? null : row.reports_to_id || null,
    project: project ? { id: project.id, name: project.name, code: project.code } : null,
    projectId: project ? project.id : null,
  };
}

// PATCH /api/users/:id — change someone's designation (or their reporting line).
router.patch('/:id', requirePermission('user.edit'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (roleDef(req.user.role).projectScope !== 'all' && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only change users you added' });
  }

  const { role, teamLeadId, reportsToId, projectId } = req.body || {};

  // Editing a user and changing their role, project or reporting line are
  // separate permissions: somebody may be trusted to correct a name without
  // being trusted to promote people.
  for (const [field, key, present] of [
    ['role', 'user.change_role', role !== undefined],
    ['projectId', 'user.change_project', projectId !== undefined],
    ['reportsToId', 'user.change_reporting', reportsToId !== undefined],
  ]) {
    if (present && !can(req, key)) {
      return res.status(403).json({ error: `You do not have permission to change ${field}.`, field });
    }
  }
  const fields = [];
  const values = [];

  // The role after this edit, which is what every rule below is judged against
  // — not the one the account holds now.
  const nextRole = role === undefined ? target.role : role;

  if (role !== undefined) {
    if (!isRole(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!assignableRolesFor(req.user).includes(role)) {
      return res.status(403).json({ error: `You cannot assign the ${roleDef(role).label} role` });
    }
    fields.push(`role = $${fields.length + 1}`);
    values.push(role);
    // A designation that isn't assigned work has no reporting lead.
    if (!roleDef(role).assignable) {
      fields.push('team_lead_id = NULL');
    }
  }
  if (teamLeadId !== undefined && (role === undefined || roleDef(role).assignable)) {
    fields.push(`team_lead_id = $${fields.length + 1}`);
    values.push(teamLeadId || null);
  }

  // --- the reporting line ---------------------------------------------------
  const movingToTop = reporting.isTopOfHierarchy(nextRole);

  if (movingToTop) {
    // Promoted to the top of the hierarchy: whatever reporting line they had is
    // cleared here rather than left for the form to remember to send. Sending
    // one anyway is refused below, so the two cannot disagree.
    if (reportsToId) {
      return res.status(400).json({
        error: `${roleDef(nextRole).label} sits at the top of the hierarchy and does not report to anyone.`,
        field: 'reportsToId',
      });
    }
    if (target.reports_to_id) fields.push('reports_to_id = NULL');
  } else if (reportsToId !== undefined) {
    const verdict = await reporting.validateManager(db, { ...target, role: nextRole }, reportsToId || null);
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error, field: verdict.field, chain: verdict.chain });
    }
    fields.push(`reports_to_id = $${fields.length + 1}`);
    values.push(verdict.managerId);
  }

  // --- the project ----------------------------------------------------------
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    if (!(await userProject.exists(db, projectId))) {
      return res.status(400).json({ error: 'That project does not exist.', field: 'projectId' });
    }
  }

  if (!fields.length && projectId === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (fields.length) {
    values.push(req.params.id);
    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
  }

  if (projectId !== undefined) {
    await userProject.setProject(db, req.params.id, projectId || null, nextRole);
  } else if (role !== undefined) {
    // The designation changed but the project did not. Move the membership to
    // the side of the project the new designation belongs on, so a coordinator
    // promoted to lead does not keep a coordinator row the permission checks
    // would still honour.
    await userProject.moveForRole(db, req.params.id, nextRole);
  }

  const { rows: updated } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [req.params.id]);
  res.json({ user: await describeUser(updated[0]) });
});

// DELETE /api/users/:id
router.delete('/:id', requirePermission('user.delete'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(403).json({ error: 'You cannot remove your own account' });
  // Anyone at the full-access tier, not only the Super Admin role: these
  // accounts can undo any change made here, so removing one is a deliberate
  // act rather than a row in a list.
  if (hasFullAccess(target)) {
    return res.status(403).json({ error: 'Accounts with full studio access cannot be removed here' });
  }
  if (roleDef(req.user.role).projectScope !== 'all' && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only remove users you added' });
  }
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/users/import-template.csv — the sample file for the user import.
// Generated from the same column definitions the import validates against, so
// it cannot describe a format that would then be rejected.
router.get('/import-template.csv', requirePermission('user.bulk_upload'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="zvky-user-import-template.csv"');
  res.send(userImport.buildTemplateCsv());
});

// GET /api/users/import-format — what the user importer expects, for the UI.
router.get('/import-format', requirePermission('user.bulk_upload'), (req, res) => {
  res.json(userImport.describeFormat());
});

// A file whose headers are the *other* importer's template. Saying so by name
// is more use than listing missing columns and leaving someone to work out
// that they picked the wrong button.
function looksLikeAssetFile(present) {
  const assetOnly = ['type', 'priority', 'man_hours', 'deadline', 'assignee_email'];
  return assetOnly.filter((c) => present.includes(c)).length >= 2;
}

// POST /api/users/bulk — create many accounts from a CSV or Excel file.
//
// Its own endpoint with its own validation, sharing only the CSV reader with
// the asset importer. Errors follow the same shape the asset import returns —
// {row, column, value, message} — so the browser renders both in one table.
router.post('/bulk', requirePermission('user.bulk_upload'), uploadImport.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A CSV or Excel file is required' });

  let headers;
  let records;
  try {
    ({ headers, records } = importFile.readImportFile(req.file.path, req.file.originalname));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // staging file, nothing to keep
  }

  // --- file-level checks, before any row is touched -------------------------
  const headerCheck = userImport.validateHeaders(headers);
  if (!headerCheck.ok) {
    const wrongFile = looksLikeAssetFile(headerCheck.present);
    return res.status(400).json({
      error: wrongFile
        ? 'That looks like the asset import file, not the user one. Upload it under Bulk Upload Assets, or download the user sample format here.'
        : `That file is missing required column${headerCheck.missing.length > 1 ? 's' : ''}: ${headerCheck.missing.join(', ')}.`,
      wrongTemplate: wrongFile ? 'assets' : undefined,
      missingColumns: headerCheck.missing,
      foundColumns: headerCheck.present,
      expectedColumns: userImport.COLUMN_NAMES,
      hint: 'Download the sample file for the exact format.',
    });
  }
  if (!records.length) {
    return res.status(400).json({
      error: 'That file has a header row but no data rows.',
      expectedColumns: userImport.COLUMN_NAMES,
    });
  }
  if (records.length > importFile.MAX_ROWS) {
    return res.status(400).json({
      error: `That file has ${records.length} rows; the limit is ${importFile.MAX_ROWS} per import. Split it and upload again.`,
      rowCount: records.length,
      maxRows: importFile.MAX_ROWS,
    });
  }

  // --- validate every row up front -----------------------------------------
  // Nothing is written until the whole file has been checked, so an error on
  // the last row is reported the same way as one on the first.
  const errors = [];
  const valid = [];
  const seenEmails = new Map();

  const allowedRoles = assignableRolesFor(req.user);

  for (let i = 0; i < records.length; i++) {
    const rowNumber = i + 2; // the header is row 1
    const result = userImport.validateRow(records[i], rowNumber);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    const { values } = result;

    // The same rule the Add User form enforces: an admin cannot create an
    // account more powerful than their own.
    if (!allowedRoles.includes(values.role)) {
      errors.push({
        row: rowNumber, column: 'role', value: values.role,
        message: `you cannot create accounts with the ${roleDef(values.role).label} role`,
      });
      continue;
    }
    if (seenEmails.has(values.email)) {
      errors.push({
        row: rowNumber, column: 'email', value: values.email,
        message: `duplicates row ${seenEmails.get(values.email)} in this file`,
      });
      continue;
    }
    seenEmails.set(values.email, rowNumber);
    valid.push({ rowNumber, values });

    if (i % 500 === 499) await importFile.yieldToLoop(); // stay responsive on a big file
  }

  // --- resolve against what already exists ----------------------------------
  const ready = [];
  if (valid.length) {
    const emails = valid.map((v) => v.values.email);

    // Accounts that already exist. Checked in one query rather than per row.
    const { rows: taken } = await db.query(
      'SELECT lower(email) AS email FROM users WHERE lower(email) IN ($1)',
      [emails]
    );
    const existing = new Set(taken.map((r) => r.email));

    // Leads named in reports_to_email. Only a role that runs a team can be one.
    const leadEmails = [...new Set(valid.map((v) => v.values.reports_to_email).filter(Boolean))];
    const leadsByEmail = new Map();
    if (leadEmails.length) {
      const { rows } = await db.query(
        'SELECT id, lower(email) AS email, `role` FROM users WHERE lower(email) IN ($1)',
        [leadEmails]
      );
      rows.forEach((r) => leadsByEmail.set(r.email, r));
    }

    // Projects named in `project`, restricted to the ones this user can see.
    const wantedProjects = valid.map((v) => v.values.project).filter(Boolean);
    const projectsByName = new Map();
    if (wantedProjects.length) {
      for (const project of await visibleProjects(req.user)) {
        projectsByName.set(String(project.name).trim().toLowerCase(), project);
      }
    }

    for (const entry of valid) {
      const { values, rowNumber } = entry;
      const rowErrors = [];

      if (existing.has(values.email)) {
        rowErrors.push({
          row: rowNumber, column: 'email', value: values.email,
          message: 'an account with this email already exists',
        });
      }

      const def = roleDef(values.role);

      if (values.reports_to_email) {
        const lead = leadsByEmail.get(values.reports_to_email);
        if (!lead) {
          rowErrors.push({
            row: rowNumber, column: 'reports_to_email', value: values.reports_to_email,
            message: 'no account has this email address',
          });
        } else if (!roleDef(lead.role) || !roleDef(lead.role).leadsTeam) {
          rowErrors.push({
            row: rowNumber, column: 'reports_to_email', value: values.reports_to_email,
            message: `${lead.email} does not run a team, so nobody can report to them`,
          });
        } else if (!def.assignable) {
          rowErrors.push({
            row: rowNumber, column: 'reports_to_email', value: values.reports_to_email,
            message: `a ${def.label} is not assigned work, so it has no reporting line — leave this blank`,
          });
        } else {
          entry.teamLeadId = lead.id;
        }
      }

      if (values.project) {
        const project = projectsByName.get(values.project.toLowerCase());
        if (!project) {
          rowErrors.push({
            row: rowNumber, column: 'project', value: values.project,
            message: 'no project you can see has that name',
          });
        } else if (def.projectScope !== 'assigned' && !def.leadsTeam) {
          rowErrors.push({
            row: rowNumber, column: 'project', value: values.project,
            message: `a ${def.label} is not attached to projects — leave this blank`,
          });
        } else {
          entry.projectId = project.id;
          entry.attachAs = def.projectScope === 'assigned' ? 'coordinator' : 'lead';
        }
      }

      if (rowErrors.length) errors.push(...rowErrors);
      else ready.push(entry);
    }
  }

  // --- hashing --------------------------------------------------------------
  // bcrypt is intentionally slow. Rows without a password all get the same
  // temporary one, so hash it once rather than once per row — the difference
  // between a second and several minutes on a large file.
  const sharedHash = ready.some((e) => !e.values.password)
    ? await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS)
    : null;
  for (const entry of ready) {
    entry.hash = entry.values.password ? await bcrypt.hash(entry.values.password, BCRYPT_ROUNDS) : sharedHash;
    entry.id = uuid();
  }

  // --- insert in batches ----------------------------------------------------
  const USER_INSERT =
    'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id, team_lead_id) VALUES ?';
  const userRow = (e) => [
    e.id, e.values.name, e.values.email, e.hash, e.values.role, req.user.id, e.teamLeadId || null,
  ];

  const created = [];
  for (let i = 0; i < ready.length; i += importFile.BATCH_SIZE) {
    const batch = ready.slice(i, i + importFile.BATCH_SIZE);
    try {
      await db.query(USER_INSERT, [batch.map(userRow)]);
      batch.forEach((e) => created.push(e));
    } catch (batchErr) {
      // The batch failed as a unit, so retry row by row to find which rows are
      // actually at fault and let the rest through.
      console.error(`Bulk user import batch failed (${batchErr.code || batchErr.message}); retrying row by row.`);
      for (const entry of batch) {
        try {
          await db.query(USER_INSERT, [[userRow(entry)]]);
          created.push(entry);
        } catch (rowErr) {
          errors.push({
            row: entry.rowNumber, column: null, value: entry.values.email,
            message: `could not be saved (${rowErr.code || 'database error'})`,
          });
        }
      }
    }
    await importFile.yieldToLoop();
  }

  // Project memberships, for the rows that named one.
  for (const entry of created.filter((e) => e.projectId)) {
    const table = entry.attachAs === 'coordinator' ? 'project_coordinators' : 'project_team_leads';
    try {
      await db.query(`INSERT IGNORE INTO ${table} (project_id, user_id) VALUES ($1,$2)`, [entry.projectId, entry.id]);
    } catch (err) {
      errors.push({
        row: entry.rowNumber, column: 'project', value: entry.values.project,
        message: `the account was created but could not be attached to the project (${err.code || 'database error'})`,
      });
    }
  }

  errors.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  const usedDefault = created.some((e) => !e.values.password);
  res.status(errors.length ? 207 : 201).json({
    created: created.length,
    skipped: errors.length,
    totalRows: records.length,
    createdUsers: created.map((e) => ({ id: e.id, name: e.values.name, email: e.values.email, role: e.values.role })),
    errors,
    ...(usedDefault ? { temporaryPassword: DEFAULT_PASSWORD } : {}),
  });
});

// The routes below take a user id in the path, so they are registered last:
// Express matches in registration order, and a '/:id' declared above would read
// '/import-format' as somebody's id and answer "User not found".
// GET /api/users/:id — one user, with their manager and project resolved.
// The detail view reads this; the edit form reads it to fill its fields.
router.get('/:id', requirePermission('user.view'), async (req, res) => {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: await describeUser(rows[0]) });
});

// GET /api/users/:id/manager-options — who this person could report to.
//
// Excludes themselves and everyone already beneath them, so the dropdown cannot
// offer a choice the API would refuse. The API checks it again regardless: this
// is a convenience, not the rule.
router.get('/:id/manager-options', requirePermission('user.view'), async (req, res) => {
  const { rows } = await db.query('SELECT id, `name`, `role` FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const user = rows[0];

  if (reporting.isTopOfHierarchy(user.role)) {
    return res.json({
      topOfHierarchy: true,
      reason: `${roleDef(user.role).label} sits at the top of the hierarchy and does not report to anyone.`,
      options: [],
    });
  }

  const options = await reporting.eligibleManagers(db, user);
  res.json({
    topOfHierarchy: false,
    options: options.map((o) => ({
      id: o.id,
      name: o.name,
      email: o.email,
      role: o.role,
      roleLabel: (roleDef(o.role) || {}).label || o.role,
    })),
  });
});

module.exports = router;
