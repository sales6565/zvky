/* Freelancers, and the work the studio gives them.
 *
 * WHAT THIS IS NOT. There is no timer here, no work session, no break window
 * and no measured time of any kind. decided_man_hours is an agreed figure
 * somebody types when the work is handed over, revised by hand if the scope
 * changes, and it is the only hours column in the feature. None of
 * src/work-log.js or src/working-time.js is reachable from anything below.
 *
 * WHY IT IS NOT MEASURED. The studio does not run the clock on somebody it does
 * not employ; what it agrees is a number of hours and a rate, and what it needs
 * to know afterwards is what that came to. Recording a freelancer's real hours
 * would be recording something the studio cannot see, which is worse than
 * recording the number both sides agreed on.
 *
 * WHY IT COSTS INTO THE P&L. The Profit & Loss tabs cost recorded work sessions
 * at the Rate Card rate of the designation that logged them. A freelancer logs
 * no sessions and holds no designation, so before this every project using
 * outsourced labour understated its cost and overstated its profit, silently
 * and with no screen able to say so. costFor() below is what closes that, and
 * it is COMPUTED from these rows rather than typed anywhere — the P&L used to
 * carry hand-entered cost lines and they were removed for exactly the reason
 * that would apply again here.
 */

const crypto = require('crypto');

const STATUSES = ['assigned', 'in_progress', 'delivered', 'revision_requested'];
const STATUS_LABELS = {
  assigned: 'Assigned',
  in_progress: 'In Progress',
  delivered: 'Delivered',
  revision_requested: 'Revision Requested',
};
const FREELANCER_STATUSES = ['active', 'inactive'];
const NAME_MAX = 191;
const DISCIPLINE_MAX = 120;
const DESCRIPTION_MAX = 500;
/* A day has 24 hours and a long outsourced job is weeks of them. This is not a
   policy, it is the point past which a typed figure is a typo — 10,000 hours is
   five person-years on one assignment. */
const HOURS_MAX = 10000;

const trimmed = (value, max) => {
  const text = String(value === null || value === undefined ? '' : value).trim();
  return text.length > max ? text.slice(0, max) : text;
};

// --- freelancers ------------------------------------------------------------

function validateFreelancer(input, { current = null } = {}) {
  const errors = [];
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const name = trimmed(pick('name', current ? current.name : ''), NAME_MAX);
  if (!name) errors.push({ field: 'name', message: 'Give the freelancer a name.' });

  const email = trimmed(pick('email', current ? current.email : ''), NAME_MAX);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: 'email', message: 'That is not an email address.' });
  }

  const status = pick('status', current ? current.status : 'active');
  if (!FREELANCER_STATUSES.includes(status)) {
    errors.push({ field: 'status', message: 'A freelancer is either active or inactive.' });
  }

  /* NULL IS NOT ZERO. A rate nobody has entered must not cost the project
     nothing in the P&L — it has to read as unpriced, the way the Rate Card's
     own missing rates already do. So an empty box stays null rather than
     becoming a number. */
  const rawRate = pick('ratePerHour', current ? current.ratePerHour : null);
  let ratePerHour = null;
  if (rawRate !== null && rawRate !== undefined && String(rawRate).trim() !== '') {
    const n = Number(rawRate);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({ field: 'ratePerHour', message: 'A rate is a number of rupees an hour, or blank if it is not recorded.' });
    } else {
      ratePerHour = Math.round(n * 100) / 100;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      email: email || null,
      phone: trimmed(pick('phone', current ? current.phone : ''), 64) || null,
      discipline: trimmed(pick('discipline', current ? current.discipline : ''), DISCIPLINE_MAX) || null,
      notes: trimmed(pick('notes', current ? current.notes : ''), 2000) || null,
      ratePerHour,
      status,
    },
  };
}

const freelancerRow = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email || '',
  phone: row.phone || '',
  discipline: row.discipline || '',
  notes: row.notes || '',
  ratePerHour: row.rate_per_hour === null || row.rate_per_hour === undefined
    ? null : Number(row.rate_per_hour),
  status: row.status,
  active: row.status === 'active',
  addedBy: row.added_by || null,
  addedByName: row.added_by_name || null,
  createdAt: row.created_at || null,
});

async function listFreelancers(db) {
  const { rows } = await db.query(
    `SELECT f.*, u.\`name\` AS added_by_name
       FROM freelancers f LEFT JOIN users u ON u.id = f.added_by
      ORDER BY f.status, f.\`name\``
  );
  return rows.map(freelancerRow);
}

async function getFreelancer(db, id) {
  const { rows } = await db.query(
    `SELECT f.*, u.\`name\` AS added_by_name
       FROM freelancers f LEFT JOIN users u ON u.id = f.added_by WHERE f.id = $1`, [id]
  );
  return rows.length ? freelancerRow(rows[0]) : null;
}

async function createFreelancer(db, input, userId) {
  const checked = validateFreelancer(input);
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO freelancers (id, \`name\`, email, phone, discipline, rate_per_hour, status, notes, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, v.name, v.email, v.phone, v.discipline, v.ratePerHour, v.status, v.notes, userId || null]
  );
  return { ok: true, freelancer: await getFreelancer(db, id) };
}

async function updateFreelancer(db, id, input) {
  const current = await getFreelancer(db, id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'No such freelancer.' }] };
  const checked = validateFreelancer(input, { current });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  await db.query(
    `UPDATE freelancers SET \`name\`=$1, email=$2, phone=$3, discipline=$4,
            rate_per_hour=$5, status=$6, notes=$7 WHERE id=$8`,
    [v.name, v.email, v.phone, v.discipline, v.ratePerHour, v.status, v.notes, id]
  );
  return { ok: true, before: current, freelancer: await getFreelancer(db, id) };
}

// --- assignments ------------------------------------------------------------

function validateAssignment(input, { current = null } = {}) {
  const errors = [];
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const freelancerId = pick('freelancerId', current ? current.freelancerId : null);
  if (!freelancerId) errors.push({ field: 'freelancerId', message: 'Say who the work is going to.' });
  const projectId = pick('projectId', current ? current.projectId : null);
  if (!projectId) errors.push({ field: 'projectId', message: 'Say which project the work belongs to.' });

  /* THE ONE NUMBER. Zero is allowed and means "agreed at nothing yet" — a real
     state when work is handed over before the hours are settled — but a
     negative is not a number of hours and a five-person-year assignment is a
     typo. */
  const rawHours = pick('decidedManHours', current ? current.decidedManHours : null);
  let decidedManHours = 0;
  if (rawHours === null || rawHours === undefined || String(rawHours).trim() === '') {
    errors.push({ field: 'decidedManHours', message: 'Enter the agreed man hours. 0 is allowed if they are not settled yet.' });
  } else {
    const n = Number(rawHours);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({ field: 'decidedManHours', message: 'Agreed man hours is a number, and cannot be negative.' });
    } else if (n > HOURS_MAX) {
      errors.push({ field: 'decidedManHours', message: `${n} hours is more than five person-years on one assignment. Check the figure.` });
    } else {
      decidedManHours = Math.round(n * 100) / 100;
    }
  }

  const status = pick('status', current ? current.status : 'assigned');
  if (!STATUSES.includes(status)) {
    errors.push({ field: 'status', message: 'That is not one of the assignment statuses.' });
  }

  const rawDue = pick('dueDate', current ? current.dueDate : null);
  let dueDate = null;
  if (rawDue !== null && rawDue !== undefined && String(rawDue).trim() !== '') {
    const text = String(rawDue).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
      errors.push({ field: 'dueDate', message: 'A due date is a calendar date, or blank.' });
    } else {
      dueDate = text;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      freelancerId: String(freelancerId),
      projectId: String(projectId),
      assetId: (() => {
        const raw = pick('assetId', current ? current.assetId : null);
        return raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw);
      })(),
      description: trimmed(pick('description', current ? current.description : ''), DESCRIPTION_MAX) || null,
      notes: trimmed(pick('notes', current ? current.notes : ''), 2000) || null,
      decidedManHours,
      status,
      dueDate,
    },
  };
}

const assignmentRow = (row) => ({
  id: row.id,
  freelancerId: row.freelancer_id,
  freelancerName: row.freelancer_name || '',
  freelancerDiscipline: row.freelancer_discipline || '',
  projectId: row.project_id,
  projectName: row.project_name || '',
  assetId: row.asset_id || null,
  assetName: row.asset_name || null,
  assetCode: row.asset_code || null,
  /* The asset's OWN estimate, carried beside the decided hours rather than
     merged with it. They are two different numbers about the same work — what
     the studio budgeted, and what the freelancer was engaged for — and showing
     one where the other is meant is how a figure becomes wrong quietly. */
  assetManHours: row.asset_man_hours === null || row.asset_man_hours === undefined
    ? null : Number(row.asset_man_hours),
  description: row.description || '',
  notes: row.notes || '',
  decidedManHours: Number(row.decided_man_hours),
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
  assignedBy: row.assigned_by || null,
  assignedByName: row.assigned_by_name || null,
  assignedAt: row.assigned_at || null,
});

const ASSIGNMENT_SELECT = `
  SELECT a.*, f.\`name\` AS freelancer_name, f.discipline AS freelancer_discipline,
         p.\`name\` AS project_name,
         s.\`name\` AS asset_name, s.\`code\` AS asset_code, s.man_hours AS asset_man_hours,
         u.\`name\` AS assigned_by_name
    FROM outsource_assignments a
    JOIN freelancers f ON f.id = a.freelancer_id
    JOIN projects p    ON p.id = a.project_id
    LEFT JOIN assets s ON s.id = a.asset_id
    LEFT JOIN users u  ON u.id = a.assigned_by`;

/* Assignments, narrowed to the projects this reader may see.
 *
 * REACH IS THE ROLE'S, NOT THE PERMISSION'S. Holding outsource.view says what
 * somebody may do; which projects they may do it to is their designation's
 * scope, exactly as it is everywhere else in this application. A lead granted
 * the tab sees the outsourced work on their own projects and not the studio's. */
async function listAssignments(db, projectIds = null) {
  if (projectIds !== null && !projectIds.length) return [];
  const where = projectIds === null ? '' : ' WHERE a.project_id IN ($1)';
  const params = projectIds === null ? [] : [projectIds];
  const { rows } = await db.query(
    `${ASSIGNMENT_SELECT}${where} ORDER BY a.assigned_at DESC`, params);
  return rows.map(assignmentRow);
}

async function getAssignment(db, id) {
  const { rows } = await db.query(`${ASSIGNMENT_SELECT} WHERE a.id = $1`, [id]);
  return rows.length ? assignmentRow(rows[0]) : null;
}

/* The freelancer has to exist and be active, the project has to exist, and an
   asset — if one is named — has to be IN that project. The last of those is the
   one worth checking: an assignment pointing at an asset in some other client's
   project would cost the wrong project in the P&L. */
async function checkRefs(db, v) {
  const { rows: fl } = await db.query('SELECT status FROM freelancers WHERE id = $1', [v.freelancerId]);
  if (!fl.length) return { field: 'freelancerId', message: 'No such freelancer.' };
  if (fl[0].status !== 'active') {
    return { field: 'freelancerId', message: 'That freelancer is inactive. Make them active again to give them work.' };
  }
  const { rows: pr } = await db.query('SELECT id FROM projects WHERE id = $1', [v.projectId]);
  if (!pr.length) return { field: 'projectId', message: 'No such project.' };
  if (v.assetId) {
    const { rows: asset } = await db.query('SELECT project_id FROM assets WHERE id = $1', [v.assetId]);
    if (!asset.length) return { field: 'assetId', message: 'No such asset.' };
    if (String(asset[0].project_id) !== String(v.projectId)) {
      return { field: 'assetId', message: 'That asset belongs to a different project.' };
    }
  }
  return null;
}

async function createAssignment(db, input, userId) {
  const checked = validateAssignment(input);
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  const bad = await checkRefs(db, v);
  if (bad) return { ok: false, status: 422, errors: [bad] };

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO outsource_assignments
       (id, freelancer_id, project_id, asset_id, description, decided_man_hours,
        status, due_date, notes, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, v.freelancerId, v.projectId, v.assetId, v.description, v.decidedManHours,
      v.status, v.dueDate, v.notes, userId || null]
  );
  return { ok: true, assignment: await getAssignment(db, id) };
}

async function updateAssignment(db, id, input) {
  const current = await getAssignment(db, id);
  if (!current) return { ok: false, status: 404, errors: [{ field: null, message: 'No such assignment.' }] };
  const checked = validateAssignment(input, { current });
  if (!checked.ok) return { ok: false, status: 422, errors: checked.errors };
  const v = checked.value;
  const bad = await checkRefs(db, v);
  if (bad) return { ok: false, status: 422, errors: [bad] };

  await db.query(
    `UPDATE outsource_assignments
        SET freelancer_id=$1, project_id=$2, asset_id=$3, description=$4,
            decided_man_hours=$5, status=$6, due_date=$7, notes=$8
      WHERE id=$9`,
    [v.freelancerId, v.projectId, v.assetId, v.description, v.decidedManHours,
      v.status, v.dueDate, v.notes, id]
  );
  return { ok: true, before: current, assignment: await getAssignment(db, id) };
}

// --- what it comes to -------------------------------------------------------

/* Outsourced hours and cost per project, for the P&L.
 *
 * COST IS HOURS x THE FREELANCER'S OWN RATE, which is the one place this
 * feature departs from the Rate Card: that table is keyed on a designation, and
 * a freelancer holds none. A freelancer with no rate recorded contributes HOURS
 * but no cost, and is counted separately as unpriced — never folded in at zero,
 * because a zero there makes the project look cheaper than it was, which is the
 * exact failure the P&L's unpriced-hours reporting already exists to prevent.
 *
 * EVERY assignment counts, whatever its status. The studio has agreed those
 * hours; a job still in progress is a cost it has taken on, and waiting for
 * 'delivered' would make the figure lag reality in the one direction that
 * flatters it.
 */
async function costFor(db, projectIds) {
  const empty = { hours: 0, cost: 0, unpricedHours: 0, assignments: 0 };
  if (!projectIds || !projectIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT a.project_id, a.decided_man_hours AS h, f.rate_per_hour AS rate
       FROM outsource_assignments a
       JOIN freelancers f ON f.id = a.freelancer_id
      WHERE a.project_id IN ($1)`, [projectIds]
  );
  const byProject = new Map();
  for (const row of rows) {
    const key = String(row.project_id);
    if (!byProject.has(key)) byProject.set(key, { ...empty });
    const acc = byProject.get(key);
    const hours = Number(row.h) || 0;
    acc.assignments += 1;
    acc.hours = Math.round((acc.hours + hours) * 100) / 100;
    if (row.rate === null || row.rate === undefined) {
      acc.unpricedHours = Math.round((acc.unpricedHours + hours) * 100) / 100;
    } else {
      acc.cost = Math.round((acc.cost + hours * Number(row.rate)) * 100) / 100;
    }
  }
  return byProject;
}

/* The same figure for one project, already shaped the way compute() wants it. */
async function costForProject(db, projectId) {
  const map = await costFor(db, [projectId]);
  return map.get(String(projectId)) || { hours: 0, cost: 0, unpricedHours: 0, assignments: 0 };
}

/* Totals for the tab's own summary: per freelancer, and per freelancer within a
   project. Computed here so the screen and any later invoice read one sum. */
function summarise(assignments) {
  const byFreelancer = new Map();
  for (const a of assignments) {
    if (!byFreelancer.has(a.freelancerId)) {
      byFreelancer.set(a.freelancerId, {
        freelancerId: a.freelancerId, freelancerName: a.freelancerName,
        hours: 0, assignments: 0, projects: new Map(),
      });
    }
    const f = byFreelancer.get(a.freelancerId);
    f.hours = Math.round((f.hours + a.decidedManHours) * 100) / 100;
    f.assignments += 1;
    if (!f.projects.has(a.projectId)) {
      f.projects.set(a.projectId, { projectId: a.projectId, projectName: a.projectName, hours: 0 });
    }
    const p = f.projects.get(a.projectId);
    p.hours = Math.round((p.hours + a.decidedManHours) * 100) / 100;
  }
  return [...byFreelancer.values()]
    .map((f) => ({ ...f, projects: [...f.projects.values()].sort((a, b) => b.hours - a.hours) }))
    .sort((a, b) => b.hours - a.hours);
}

module.exports = {
  STATUSES, STATUS_LABELS, FREELANCER_STATUSES, HOURS_MAX,
  validateFreelancer, listFreelancers, getFreelancer, createFreelancer, updateFreelancer,
  validateAssignment, listAssignments, getAssignment, createAssignment, updateAssignment,
  costFor, costForProject, summarise,
};
