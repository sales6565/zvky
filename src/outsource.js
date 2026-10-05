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

/* The statuses an assignment may be PUT INTO by hand. 'cancelled' is not among
   them on purpose: it is not a state somebody types, it is what unassigning
   does, and it has its own endpoint so that taking work back from a freelancer
   is a deliberate act with its own permission check and its own audit entry. */
const STATUSES = ['assigned', 'in_progress', 'delivered', 'revision_requested'];
const CANCELLED = 'cancelled';
/* Named, like CANCELLED above, because three files now ask about this one value
   — the bulk action, the edit route's refusal, and the screen — and a string
   spelled out in each is a string one of them will eventually spell wrong. */
const DELIVERED = 'delivered';
const STATUS_LABELS = {
  assigned: 'Assigned',
  in_progress: 'In Progress',
  delivered: 'Delivered',
  revision_requested: 'Revision Requested',
  [CANCELLED]: 'Cancelled',
};
/* WHAT "ACTIVE" MEANS, in one place. A cancelled assignment is history: it no
   longer holds the task against an internal assignee, and it no longer costs
   the project. Every query below that asks "is this task outsourced" or "what
   did outsourcing cost" reads this rather than spelling the four out. */
const isActive = (status) => status !== CANCELLED;
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
  cancelled: row.status === CANCELLED,
  cancelledByName: row.cancelled_by_name || null,
  cancelledAt: row.cancelled_at || null,
  /* Who handed the work back and when. Read by the Outsource tab, which has no
     asset to read the task's own history from — an assignment need not name
     one. Null on everything delivered before these columns existed, which reads
     as "we do not know" rather than as a wrong name or a wrong date. */
  delivered: row.status === DELIVERED,
  deliveredByName: row.delivered_by_name || null,
  deliveredAt: row.delivered_at || null,
});

const ASSIGNMENT_SELECT = `
  SELECT a.*, f.\`name\` AS freelancer_name, f.discipline AS freelancer_discipline,
         p.\`name\` AS project_name,
         s.\`name\` AS asset_name, s.\`code\` AS asset_code, s.man_hours AS asset_man_hours,
         u.\`name\` AS assigned_by_name, x.\`name\` AS cancelled_by_name,
         dv.\`name\` AS delivered_by_name
    FROM outsource_assignments a
    JOIN freelancers f ON f.id = a.freelancer_id
    JOIN projects p    ON p.id = a.project_id
    LEFT JOIN assets s ON s.id = a.asset_id
    LEFT JOIN users u  ON u.id = a.assigned_by
    LEFT JOIN users x  ON x.id = a.cancelled_by
    LEFT JOIN users dv ON dv.id = a.delivered_by`;

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
    /* CANCELLED WORK COSTS NOTHING. An assignment taken back from a freelancer
       is kept for its history, not for its arithmetic — leaving it in would
       charge the project for work it did not buy, which is the same kind of
       silent wrongness the P&L gap this feature closed. */
    `SELECT a.project_id, a.decided_man_hours AS h, f.rate_per_hour AS rate
       FROM outsource_assignments a
       JOIN freelancers f ON f.id = a.freelancer_id
      WHERE a.project_id IN ($1) AND a.status <> '${CANCELLED}'`, [projectIds]
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

/* ---------------------------------------------------------------------------
 * MUTUAL EXCLUSIVITY: a task is somebody's inside the studio, or somebody's
 * outside it, and never both.
 *
 * WHY IT IS ASKED IN TWO DIRECTIONS. The two sides are written by different
 * routes in different files, and each has to refuse the other's state. Putting
 * both questions here rather than one in each file means the rule is one thing
 * that can be read, and a third way of assigning added next year has one
 * function to call rather than a rule to remember.
 *
 * AD HOC WORK IS OUT OF SCOPE OF THE RULE, and necessarily so. An outsource
 * assignment need not name an asset at all — that is the point of the optional
 * link — and an assignment with no asset conflicts with no task, because there
 * is no task. Exclusivity is a fact about a TASK, so it applies exactly where
 * there is one.
 * ------------------------------------------------------------------------- */

/* The live outsource assignment on this task, or null. Cancelled ones do not
   count: taking the work back is what makes the task assignable again. */
async function activeForAsset(db, assetId) {
  if (!assetId) return null;
  const { rows } = await db.query(
    `${ASSIGNMENT_SELECT} WHERE a.asset_id = $1 AND a.status <> $2
      ORDER BY a.assigned_at DESC LIMIT 1`,
    [assetId, CANCELLED]
  );
  return rows.length ? assignmentRow(rows[0]) : null;
}

/* The live outsource assignment on each of a page of tasks, keyed by asset id.
 *
 * Batched for the board, which draws a card per asset: one query for the page
 * rather than one per card. The panel reads this to know whether Section 2 is
 * already committed, and the exclusivity refusals above read the database
 * again on the write — this is what the screen shows, never what it decides. */
async function activeByAsset(db, assetIds) {
  const byAsset = new Map();
  if (!assetIds || !assetIds.length) return byAsset;
  const { rows } = await db.query(
    `${ASSIGNMENT_SELECT} WHERE a.asset_id IN ($1) AND a.status <> $2
      ORDER BY a.assigned_at ASC`,
    [assetIds, CANCELLED]
  );
  // Last one wins, matching activeForAsset's "most recent" above.
  for (const row of rows) byAsset.set(String(row.asset_id), assignmentRow(row));
  return byAsset;
}

/* Section 1's guard: may this task be given to somebody inside the studio?
 *
 * Returns a sentence when it may not, null when it may. A sentence rather than
 * a boolean because the refusal has to say WHO holds it and how to get it back
 * — "rejected" on its own leaves a PM staring at a dropdown that will not take. */
async function internalAssignBlocked(db, assetId) {
  const held = await activeForAsset(db, assetId);
  if (!held) return null;
  return `This task is assigned to ${held.freelancerName}, who is a freelancer. `
    + 'Unassign them on the Outsource tab, or in the task panel, before giving it to somebody in the studio.';
}

/* Section 2's guard: may this task be given to a freelancer? */
async function outsourceBlocked(db, assetId) {
  if (!assetId) return null;
  const { rows } = await db.query(
    `SELECT a.assignee_id, u.\`name\` AS assignee_name, a.\`code\`
       FROM assets a LEFT JOIN users u ON u.id = a.assignee_id
      WHERE a.id = $1`, [assetId]
  );
  if (!rows.length) return null;              // a missing asset is checkRefs' refusal, not this one
  if (!rows[0].assignee_id) return null;
  return `${rows[0].code || 'That task'} is assigned to ${rows[0].assignee_name || 'somebody in the studio'}. `
    + 'Clear the internal assignee before sending the work outside.';
}

/* Taking work back from a freelancer.
 *
 * CANCELLED, NEVER DELETED. The agreed hours may already have been quoted to
 * the person doing the work; the record of what was agreed and by whom is the
 * point of keeping it. What cancelling does is release the task — so the
 * internal side becomes assignable again — and stop the hours costing the
 * project. */
async function cancelAssignment(db, id, userId) {
  const current = await getAssignment(db, id);
  if (!current) return { ok: false, status: 404, error: 'No such assignment.' };
  if (current.status === CANCELLED) {
    return { ok: false, status: 409, error: 'That assignment was already cancelled.' };
  }
  await db.query(
    'UPDATE outsource_assignments SET status = $1, cancelled_by = $2, cancelled_at = NOW() WHERE id = $3',
    [CANCELLED, userId || null, id]
  );
  return { ok: true, before: current, assignment: await getAssignment(db, id) };
}

/* HANDING A FREELANCER'S WORK BACK, the assignment half of it.
 *
 * ONE DEFINITION OF "THIS WAS DELIVERED", reached from one place. The status
 * column, the deliverer and the stamp are written together here; the route
 * above it owns the asset's transition. Splitting it the other way round — a
 * generic status edit that also moved the asset — would have made a field edit
 * carry a studio-wide side effect, which is why PUT /assignments/:id now
 * REFUSES a move into 'delivered' and names this action instead. There is one
 * way to deliver outsourced work and it is this one.
 *
 * REFUSALS, each on its own terms and each cleanly rather than silently:
 *
 *   already delivered   409. Delivering twice is not a no-op to be swallowed —
 *                       it would overwrite the first deliverer and the first
 *                       stamp with whoever pressed it second.
 *   cancelled           409. The work was taken back; there is nothing to hand
 *                       in. Reviving it is the assign flow, not this.
 *   no such assignment  404.
 *
 * AN ASSIGNMENT WITH NO ASSET STILL DELIVERS, and that is a decision rather
 * than an oversight. The asset link is optional by design — "outsourced work is
 * sometimes a tracked asset and sometimes a job that never enters the pipeline"
 * — so ad hoc work has no task to move and no review to go into. Its status
 * moves, its deliverer is recorded, and `movedAsset` comes back false so the
 * caller can say so rather than implying a transition that did not happen.
 */
async function deliverAssignment(db, id, userId) {
  const current = await getAssignment(db, id);
  if (!current) return { ok: false, status: 404, error: 'No such assignment.' };
  if (current.status === CANCELLED) {
    return { ok: false, status: 409,
      error: 'That assignment was cancelled, so there is nothing to deliver. '
        + 'Give the work out again if the freelancer is back on it.' };
  }
  if (current.status === DELIVERED) {
    return { ok: false, status: 409,
      error: `${current.freelancerName} already delivered this`
        + `${current.deliveredAt ? ` on ${String(current.deliveredAt).replace('T', ' ').slice(0, 16)}` : ''}.` };
  }
  await db.query(
    `UPDATE outsource_assignments
        SET status = $1, delivered_by = $2, delivered_at = NOW()
      WHERE id = $3`,
    [DELIVERED, userId || null, id]
  );
  return { ok: true, before: current, assignment: await getAssignment(db, id) };
}

/* Is this assignment one the Mark as Delivered action could reach?
 *
 * The page's tick boxes read the same answer off the row, so a box that is
 * offered can be pressed. Spelled here rather than in two places for the reason
 * this codebase keeps rediscovering: a screen and a server that each decide the
 * same thing eventually decide it differently. */
const isDeliverable = (assignment) =>
  Boolean(assignment) && assignment.status !== DELIVERED && assignment.status !== CANCELLED;

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
  STATUSES, STATUS_LABELS, FREELANCER_STATUSES, HOURS_MAX, CANCELLED, DELIVERED, isActive,
  deliverAssignment, isDeliverable,
  validateFreelancer, listFreelancers, getFreelancer, createFreelancer, updateFreelancer,
  validateAssignment, listAssignments, getAssignment, createAssignment, updateAssignment,
  costFor, costForProject, summarise,
  activeForAsset, activeByAsset, internalAssignBlocked, outsourceBlocked, cancelAssignment,
};
