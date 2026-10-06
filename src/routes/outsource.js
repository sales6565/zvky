/* The Outsource tab: freelancers, and the work given to them.
 *
 * THREE PERMISSIONS, AND THE THIRD IS THE INTERESTING ONE. outsource.view
 * shows the tab, outsource.manage edits it, and outsource.rates decides whether
 * money is in the answer at all. That last one is enforced by LEAVING THE FIELD
 * OUT of the response rather than by hiding it on the page: a rate the server
 * still sends to somebody who may not see it is not hidden, it is one request
 * away from being read.
 *
 * REACH IS THE ROLE'S. Holding outsource.view says what somebody may do; which
 * projects' assignments they see is their designation's projectScope, the same
 * rule the rest of the application follows. A lead with the tab sees the
 * outsourced work on their own projects, not the studio's.
 *
 * EVERY CHANGE TO decided_man_hours IS LOGGED with its old value. That number
 * is what a freelancer is paid against, so a silent edit matters here more than
 * on most fields — the studio said so and it is the reason the audit entry
 * below names the figure rather than saying "updated".
 */
const { asyncRouter } = require('../async-router');

const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission, can } = require('../middleware/auth');
const outsource = require('../outsource');
const activity = require('../activity');
const { visibleProjects } = require('../permissions');

router.use(authenticate);
router.use(requirePermission('outsource.view'));

const mayManage = (req) => can(req, 'outsource.manage');
const maySeeRates = (req) => can(req, 'outsource.rates');
/* Marking a freelancer's work delivered. Its own key, not outsource.manage —
   see the catalogue entry: this one moves the TASK into a team lead's review
   queue, which the other three status values do not.

   THE KEY ALONE IS ENOUGH FOR THE SCREEN, and the reach is not missing from it.
   listAssignments() has already narrowed the rows to the projects this reader
   may see, so every row on the page is in reach by construction; the server
   asks canDeliverOutsourced per row anyway, because a request need not come
   from the page. */
const mayDeliver = (req) => can(req, 'outsource.deliver');

/* Undoing a stage. A SEPARATE KEY on purpose, and asked separately here: a
   reader may record every stage all day and still not be somebody who may
   rewrite a recorded one. outsource.reopen is held by the designations that
   hold user.delete — the same small set — because it is the only control on
   this tab that unsays something already written down. */
const mayReopen = (req) => can(req, 'outsource.reopen');

const refuseUnlessManager = (req, res) => {
  if (mayManage(req)) return false;
  res.status(403).json({ error: 'You do not have permission to change outsourced work.' });
  return true;
};

/* Money out of the answer for anybody without outsource.rates.
 *
 * Deleted from the object rather than blanked: a null would say "this
 * freelancer has no rate recorded", which is a different and untrue statement
 * from "you may not see it". */
const hideRates = (freelancer) => {
  const { ratePerHour, ...rest } = freelancer;
  return rest;
};

const projectIdsFor = async (req) => {
  /* A studio-wide designation gets everything, and asking the database for a
     list of every project id to then filter on it would be the same answer with
     more work. Null means "no narrowing". */
  const projects = await visibleProjects(req.user);
  const def = require('../roles').roleDef(req.user.role);
  if (def && def.projectScope === 'all') return null;
  return projects.map((p) => String(p.id));
};

// ------------------------------------------------------------- freelancers

// GET /api/outsource/freelancers
router.get('/freelancers', async (req, res) => {
  const people = await outsource.listFreelancers(db);
  res.json({
    freelancers: maySeeRates(req) ? people : people.map(hideRates),
    canManage: mayManage(req),
    canSeeRates: maySeeRates(req),
  });
});

// POST /api/outsource/freelancers
router.post('/freelancers', async (req, res) => {
  if (refuseUnlessManager(req, res)) return;
  const body = { ...(req.body || {}) };
  /* A rate from somebody who may not see rates is not stored. Refused rather
     than dropped, because silently ignoring half of what somebody typed is
     worse than telling them. */
  if (body.ratePerHour !== undefined && !maySeeRates(req)) {
    return res.status(403).json({
      error: 'You do not have permission to set pay rates.', field: 'ratePerHour' });
  }
  const result = await outsource.createFreelancer(db, body, req.user.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  req.activity({
    module: 'settings', action: 'outsource.freelancer_added',
    entityType: 'freelancer', entityId: result.freelancer.id, entityLabel: result.freelancer.name,
    summary: `Added the freelancer ${result.freelancer.name}`
      + (result.freelancer.discipline ? ` (${result.freelancer.discipline})` : ''),
  });
  res.status(201).json({ freelancer: maySeeRates(req) ? result.freelancer : hideRates(result.freelancer) });
});

// PUT /api/outsource/freelancers/:id
router.put('/freelancers/:id', async (req, res) => {
  if (refuseUnlessManager(req, res)) return;
  const body = { ...(req.body || {}) };
  if (body.ratePerHour !== undefined && !maySeeRates(req)) {
    return res.status(403).json({
      error: 'You do not have permission to set pay rates.', field: 'ratePerHour' });
  }
  const result = await outsource.updateFreelancer(db, req.params.id, body);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });

  const before = result.before;
  const after = result.freelancer;
  /* Deactivation is called out by name. It is the closest thing this feature
     has to removing somebody, and "when did we stop using them" is the question
     the log will be read for. */
  const deactivated = before.status === 'active' && after.status === 'inactive';
  const reactivated = before.status === 'inactive' && after.status === 'active';
  req.activity({
    module: 'settings',
    action: deactivated ? 'outsource.freelancer_deactivated' : 'outsource.freelancer_updated',
    entityType: 'freelancer', entityId: after.id, entityLabel: after.name,
    summary: deactivated ? `Deactivated the freelancer ${after.name}`
      : reactivated ? `Made the freelancer ${after.name} active again`
        : `Updated the freelancer ${after.name}`,
    changes: activity.diff(
      { name: before.name, discipline: before.discipline, status: before.status,
        ...(maySeeRates(req) ? { ratePerHour: before.ratePerHour } : {}) },
      { name: after.name, discipline: after.discipline, status: after.status,
        ...(maySeeRates(req) ? { ratePerHour: after.ratePerHour } : {}) }
    ),
  });
  res.json({ freelancer: maySeeRates(req) ? after : hideRates(after) });
});

// ------------------------------------------------------------- assignments

// GET /api/outsource/assignments
router.get('/assignments', async (req, res) => {
  const scope = await projectIdsFor(req);
  const assignments = await outsource.listAssignments(db, scope);
  res.json({
    assignments,
    summary: outsource.summarise(assignments),
    statuses: outsource.STATUSES.map((key) => ({ key, label: outsource.STATUS_LABELS[key] })),
    canManage: mayManage(req),
    canSeeRates: maySeeRates(req),
    canDeliver: mayDeliver(req),
    canReopen: mayReopen(req),
    /* The stages, named by the server. The page groups and filters by these, so
       taking the list from here rather than repeating it in the page means a
       stage added to src/outsource.js appears on the tab instead of silently
       falling into whichever group the page happened to list last. */
    stages: outsource.STAGES.map((key) => ({ key, label: outsource.STAGE_LABELS[key] })),
    /* The one value the edit form must no longer offer, named by the server
       rather than hardcoded in the page: PUT refuses a move into it and tells
       the reader to use the action instead, so a dropdown that still listed it
       would be a control that cannot be used. */
    deliverViaAction: outsource.DELIVERED,
  });
});

/* Which projects and assets an assignment may name, for the form's dropdowns.
   Narrowed the same way the list is, so the form cannot offer a project whose
   assignments the person would not then be shown. */
router.get('/targets', async (req, res) => {
  const scope = await projectIdsFor(req);
  const where = scope === null ? 'WHERE p.is_active = 1' : 'WHERE p.is_active = 1 AND p.id IN ($1)';
  const params = scope === null ? [] : [scope];
  if (scope !== null && !scope.length) return res.json({ projects: [] });
  const { rows } = await db.query(
    `SELECT p.id, p.\`name\`, c.\`name\` AS client_name
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      ${where} ORDER BY c.\`name\`, p.\`name\``, params);
  res.json({ projects: rows.map((p) => ({ id: p.id, name: p.name, clientName: p.client_name || '' })) });
});

// GET /api/outsource/projects/:projectId/assets — for the optional asset link
router.get('/projects/:projectId/assets', async (req, res) => {
  const scope = await projectIdsFor(req);
  if (scope !== null && !scope.includes(String(req.params.projectId))) {
    return res.status(403).json({ error: 'No access to that project.' });
  }
  const { rows } = await db.query(
    'SELECT id, `code`, `name`, man_hours FROM assets WHERE project_id = $1 ORDER BY `code`',
    [req.params.projectId]
  );
  res.json({
    assets: rows.map((a) => ({
      id: a.id, code: a.code, name: a.name,
      manHours: a.man_hours === null || a.man_hours === undefined ? null : Number(a.man_hours),
    })),
  });
});

const inScope = async (req, projectId) => {
  const scope = await projectIdsFor(req);
  return scope === null || scope.includes(String(projectId));
};

// POST /api/outsource/assignments
router.post('/assignments', async (req, res) => {
  if (refuseUnlessManager(req, res)) return;
  const body = req.body || {};
  if (body.projectId && !(await inScope(req, body.projectId))) {
    return res.status(403).json({ error: 'No access to that project.', field: 'projectId' });
  }
  /* SECTION 2's HALF OF THE EXCLUSIVITY RULE. A task somebody in the studio is
     already on does not also go outside it. Checked before the write, and with
     a sentence naming who holds it. The other half is in src/routes/assets.js,
     on all three of the routes that can set an assignee. */
  if (body.assetId) {
    const blocked = await outsource.outsourceBlocked(db, String(body.assetId));
    if (blocked) return res.status(409).json({ error: blocked, field: 'assetId' });
  }
  const result = await outsource.createAssignment(db, body, req.user.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });
  const a = result.assignment;
  req.activity({
    module: 'settings', action: 'outsource.assigned',
    entityType: 'outsource_assignment', entityId: a.id,
    entityLabel: `${a.freelancerName} — ${a.projectName}`,
    summary: `Gave ${a.freelancerName} ${a.decidedManHours}h on ${a.projectName}`
      + (a.assetCode ? ` (${a.assetCode})` : ''),
    changes: activity.diff({ decidedManHours: null }, { decidedManHours: a.decidedManHours }),
  });
  res.status(201).json({ assignment: a });
});

// PUT /api/outsource/assignments/:id
router.put('/assignments/:id', async (req, res) => {
  if (refuseUnlessManager(req, res)) return;
  const existing = await outsource.getAssignment(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such assignment.' });
  if (!(await inScope(req, existing.projectId))) {
    return res.status(403).json({ error: 'No access to that project.' });
  }
  const body = req.body || {};
  if (body.projectId && !(await inScope(req, body.projectId))) {
    return res.status(403).json({ error: 'No access to that project.', field: 'projectId' });
  }
  /* An edit can MOVE an assignment onto a task, so it asks the same question a
     create does — but only about an asset it is not already on, or re-saving an
     assignment would refuse itself. */
  const movingTo = body.assetId === undefined ? existing.assetId : (body.assetId || null);
  if (movingTo && String(movingTo) !== String(existing.assetId || '')) {
    const blocked = await outsource.outsourceBlocked(db, String(movingTo));
    if (blocked) return res.status(409).json({ error: blocked, field: 'assetId' });
  }

  /* DELIVERY IS NOT A FIELD EDIT, and this is where that is enforced.
   *
   * This route would happily have written status = 'delivered' straight into
   * the column, as it does for the other three — and that is precisely the
   * "direct status write" the task moves away from. Delivery now also sends the
   * TASK into the team lead's review queue, through the outsource_delivered
   * transition, under its own permission and with a deliverer and a stamp
   * recorded. A generic edit that did all of that as a side effect of one
   * dropdown would be a field with a studio-wide consequence; one that did only
   * half of it would leave an assignment claiming delivery of a task nobody had
   * been asked to review. So there is one way to deliver, and it is named here.
   *
   * ONLY A MOVE *INTO* DELIVERED. An assignment that is already delivered stays
   * editable — the agreed hours may still need correcting, and the form sends
   * the status back unchanged with every save, so refusing on the value alone
   * would have frozen those rows entirely.
   *
   * NOTHING IS LOST. Everything outsource.manage could do here it can still do;
   * what was one dropdown is now a button, with the same designations holding
   * it by default. */
  const wantsDelivered = body.status === outsource.DELIVERED
    && existing.status !== outsource.DELIVERED;
  if (wantsDelivered) {
    return res.status(409).json({
      error: 'Use Mark as Delivered to hand a freelancer\u2019s work back. It moves the task to '
        + 'TL Review for a team lead to check, and records who delivered it and when \u2014 which '
        + 'editing the status here would not.',
      field: 'status',
      useAction: 'outsource_deliver',
    });
  }
  const result = await outsource.updateAssignment(db, req.params.id, body);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors, error: result.errors[0].message });

  const before = result.before;
  const after = result.assignment;
  /* THE FIGURE, NAMED. A change to the agreed hours is what somebody is paid
     against, so the summary says the old number and the new one rather than
     leaving a reader to open the diff. */
  const hoursChanged = before.decidedManHours !== after.decidedManHours;
  req.activity({
    module: 'settings',
    action: hoursChanged ? 'outsource.hours_revised' : 'outsource.assignment_updated',
    entityType: 'outsource_assignment', entityId: after.id,
    entityLabel: `${after.freelancerName} — ${after.projectName}`,
    summary: hoursChanged
      ? `Revised ${after.freelancerName}’s agreed hours on ${after.projectName} `
        + `from ${before.decidedManHours}h to ${after.decidedManHours}h`
      : `Updated ${after.freelancerName}’s assignment on ${after.projectName}`,
    changes: activity.diff(
      { decidedManHours: before.decidedManHours, status: before.statusLabel, dueDate: before.dueDate },
      { decidedManHours: after.decidedManHours, status: after.statusLabel, dueDate: after.dueDate }
    ),
  });
  res.json({ assignment: after });
});

/* POST /api/outsource/assignments/:id/cancel — take the work back.
 *
 * WHO MAY. outsource.manage, which is the same permission that gave the work
 * out. The studio flagged the alternative — Super Admin only, once hours are
 * agreed — and this is the narrower reading of the same worry: the number may
 * already have been quoted to the freelancer, so cancelling is deliberate,
 * recorded with the figure, and never deletes anything. But a PM who assigned
 * the wrong type two minutes ago should be able to put it right without
 * escalating, and the record of what was agreed survives either way. Say the
 * word and the gate moves.
 *
 * WHAT IT DOES. Marks the assignment cancelled. The task becomes assignable
 * internally again, and the hours stop costing the project — a cancelled
 * assignment is kept for its history, not for its arithmetic.
 */
router.post('/assignments/:id/cancel', async (req, res) => {
  if (refuseUnlessManager(req, res)) return;
  const existing = await outsource.getAssignment(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such assignment.' });
  if (!(await inScope(req, existing.projectId))) {
    return res.status(403).json({ error: 'No access to that project.' });
  }
  const result = await outsource.cancelAssignment(db, req.params.id, req.user.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  const a = result.assignment;
  req.activity({
    module: 'settings', action: 'outsource.unassigned',
    entityType: 'outsource_assignment', entityId: a.id,
    entityLabel: `${a.freelancerName} \u2014 ${a.projectName}`,
    /* The figure is in the sentence. Somebody reading this later wants to know
       what was agreed before it was taken back, not merely that it was. */
    summary: `Took ${a.decidedManHours}h back from ${a.freelancerName} on ${a.projectName}`
      + (a.assetCode ? ` (${a.assetCode})` : ''),
    changes: activity.diff(
      { status: result.before.statusLabel, decidedManHours: result.before.decidedManHours },
      { status: a.statusLabel, decidedManHours: a.decidedManHours }
    ),
  });
  res.json({ assignment: a });
});

module.exports = router;
