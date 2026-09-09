const { asyncRouter } = require('../async-router');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');
const pnl = require('../pnl');
const snapshots = require('../pnl-snapshots');
const { holds, visibleProjects, canAccessProject } = require('../permissions');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

router.use(authenticate);

/* TWO PERMISSIONS, AND THE SPLIT IS LOAD-BEARING.
 *
 *   pnl.view    read the report — revenue, costs, margin, the breakdown.
 *   pnl.manage  edit the rate cards, assignments, hours, billing and costs.
 *
 * Neither implies the other. Somebody who manages the figures needs to read
 * them back, so a manager can read; but a reader can write nothing at all, and
 * every write route below is behind manage alone. That is the difference
 * between "may see the margin" and "may decide what the margin is".
 */
const mayRead = (req, res, next) => (
  holds(req.user, 'pnl.view') || holds(req.user, 'pnl.manage')
    ? next()
    : res.status(403).json({ error: 'You do not have permission to view Profit & Loss.' })
);

/* The refusal says which of the two situations this is.
 *
 * A single message reading "you can view but not change" was a lie to anybody
 * holding NEITHER permission — these write routes do not run mayRead first, so
 * it was told to them too, and it asserted an access they did not have. Two
 * sentences, because "you have the wrong one of two permissions" and "you have
 * none of them" need different things done about them. */
const mayWrite = (req, res, next) => {
  if (holds(req.user, 'pnl.manage')) return next();
  return res.status(403).json({
    error: holds(req.user, 'pnl.view')
      ? 'You can view Profit & Loss but not change the figures it is computed from.'
      : 'You do not have permission to change Profit & Loss figures.',
  });
};

/* A project the caller may actually reach.
 *
 * Scoped exactly like every other piece of project data: holding pnl.view does
 * not widen anybody's reach, it only decides whether the money is shown for the
 * projects they could already open. 404 rather than 403 for one they cannot
 * see, so the endpoint does not confirm that a project id exists. */
async function reachable(req, res, projectId) {
  const ok = await canAccessProject(req.user, projectId).catch(() => false);
  if (!ok) {
    res.status(404).json({ error: 'That project does not exist, or you cannot see it.' });
    return false;
  }
  return true;
}

// --- rate cards ---------------------------------------------------------------

router.get('/rate-cards', mayRead, async (req, res) => {
  res.json({ rateCards: await pnl.rateCards(db), billingTypes: pnl.BILLING_TYPES });
});

router.post('/rate-cards', mayWrite, async (req, res) => {
  const existing = await pnl.rateCards(db);
  const { errors, values } = pnl.validateRateCard(req.body || {}, { existing });
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  const id = uuid();
  await db.query(
    'INSERT INTO rate_cards (id, `role`, level, rate_per_hour) VALUES ($1,$2,$3,$4)',
    [id, values.role, values.level, values.ratePerHour]
  );
  req.activity({
    module: 'pnl', action: 'pnl.rate_card_added', entityType: 'rate_card', entityId: id,
    entityLabel: `${values.role} — ${values.level}`,
    summary: `Added the rate ${values.role} — ${values.level} at ${values.ratePerHour}/hour`,
    changes: { rate: { from: null, to: String(values.ratePerHour) } },
  });
  return res.status(201).json({ rateCard: { id, ...values, isActive: true } });
});

router.patch('/rate-cards/:id', mayWrite, async (req, res) => {
  const existing = await pnl.rateCards(db);
  const before = existing.find((c) => c.id === req.params.id);
  if (!before) return res.status(404).json({ error: 'That rate does not exist.' });

  const merged = {
    role: req.body.role === undefined ? before.role : req.body.role,
    level: req.body.level === undefined ? before.level : req.body.level,
    ratePerHour: req.body.ratePerHour === undefined ? before.ratePerHour : req.body.ratePerHour,
  };
  const { errors, values } = pnl.validateRateCard(merged, { existing, id: req.params.id });
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  await db.query(
    'UPDATE rate_cards SET `role` = $1, level = $2, rate_per_hour = $3 WHERE id = $4',
    [values.role, values.level, values.ratePerHour, req.params.id]
  );

  /* Old value to new value, because this is the change most worth being able to
     find later: a rate edited in April changes what every project priced
     against it costs from then on. */
  const changes = {};
  if (before.role !== values.role) changes.role = { from: before.role, to: values.role };
  if (before.level !== values.level) changes.level = { from: before.level, to: values.level };
  if (before.ratePerHour !== values.ratePerHour) {
    changes.rate = { from: String(before.ratePerHour), to: String(values.ratePerHour) };
  }
  req.activity({
    module: 'pnl', action: 'pnl.rate_card_changed', entityType: 'rate_card', entityId: req.params.id,
    entityLabel: `${values.role} — ${values.level}`,
    summary: changes.rate
      ? `Changed the ${values.role} — ${values.level} rate from ${before.ratePerHour} to ${values.ratePerHour}/hour`
      : `Changed the rate card row ${values.role} — ${values.level}`,
    changes: Object.keys(changes).length ? changes : null,
  });
  return res.json({ rateCard: { id: req.params.id, ...values, isActive: before.isActive } });
});

/* DELETE a rate card row.
 *
 * The assignments priced from it are LEFT ALONE. Each one carries its own copy
 * of the rate, so deleting the card cannot rewrite the cost of work already
 * done — and the breakdown table appends any role/level no longer on the card
 * rather than dropping its cost. Removing a row from the price list is not a
 * statement about history. */
router.delete('/rate-cards/:id', mayWrite, async (req, res) => {
  const existing = await pnl.rateCards(db);
  const before = existing.find((c) => c.id === req.params.id);
  if (!before) return res.status(404).json({ error: 'That rate does not exist.' });

  const { rows: used } = await db.query(
    'SELECT COUNT(*) AS n FROM project_team_assignments WHERE rate_card_id = $1', [req.params.id]);

  await db.query('DELETE FROM rate_cards WHERE id = $1', [req.params.id]);
  req.activity({
    module: 'pnl', action: 'pnl.rate_card_removed', entityType: 'rate_card', entityId: req.params.id,
    entityLabel: `${before.role} — ${before.level}`,
    summary: `Removed the rate ${before.role} — ${before.level} (was ${before.ratePerHour}/hour)`,
    changes: { rate: { from: String(before.ratePerHour), to: null } },
  });
  return res.json({
    ok: true,
    ...(Number(used[0].n) ? {
      note: `${used[0].n} assignment${Number(used[0].n) === 1 ? '' : 's'} were priced from this row. `
        + 'They keep the rate they were costed at — removing a row from the price list does not '
        + 'rewrite work already done.',
    } : {}),
  });
});

// --- one project's figures ----------------------------------------------------

router.get('/projects/:id', mayRead, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const data = await pnl.forProject(db, req.params.id);
  return res.json({
    ...data,
    billingTypes: pnl.BILLING_TYPES,
    // What this caller may do here, so the screen does not offer a control the
    // API would refuse.
    canManage: holds(req.user, 'pnl.manage'),
  });
});

// --- team assignments ---------------------------------------------------------

/* HOURS ARE ENTERED BY HAND, per the brief.
 *
 * Worth recording that this application already tracks hours — work_sessions,
 * and the coverage maths behind the Idle Report — so these two numbers can
 * drift apart, and nothing here reconciles them. That was the approved design;
 * a later integration would replace the manual figure with the tracked one, or
 * show both. Until then a manual hour is what the P&L is costed on. */
router.post('/projects/:id/assignments', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const { errors, values } = pnl.validateAssignment(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  const id = uuid();
  await db.query(
    `INSERT INTO project_team_assignments
       (id, project_id, user_id, person_name, rate_card_id, \`role\`, level, rate_per_hour, \`hours\`)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, req.params.id, req.body.userId || null, values.personName,
      req.body.rateCardId || null, values.role, values.level, values.ratePerHour, values.hours]
  );
  const cost = pnl.money(values.ratePerHour * values.hours);
  req.activity({
    module: 'pnl', action: 'pnl.assignment_added', entityType: 'project', entityId: req.params.id,
    entityLabel: values.personName || `${values.role} — ${values.level}`,
    summary: `Added ${values.personName || values.level} to the project team: `
      + `${values.hours}h at ${values.ratePerHour}/hour = ${cost}`,
    changes: { cost: { from: null, to: String(cost) } },
  });
  await snapshots.capture(db, req.params.id);
  return res.status(201).json({ assignment: { id, projectId: req.params.id, ...values, cost } });
});

router.patch('/projects/:id/assignments/:assignmentId', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const team = await pnl.assignments(db, req.params.id);
  const before = team.find((a) => a.id === req.params.assignmentId);
  if (!before) return res.status(404).json({ error: 'That assignment does not exist.' });

  const merged = {
    role: req.body.role === undefined ? before.role : req.body.role,
    level: req.body.level === undefined ? before.level : req.body.level,
    ratePerHour: req.body.ratePerHour === undefined ? before.ratePerHour : req.body.ratePerHour,
    hours: req.body.hours === undefined ? before.hours : req.body.hours,
    personName: req.body.personName === undefined ? before.personName : req.body.personName,
  };
  const { errors, values } = pnl.validateAssignment(merged);
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  await db.query(
    `UPDATE project_team_assignments
        SET person_name = $1, \`role\` = $2, level = $3, rate_per_hour = $4, \`hours\` = $5
      WHERE id = $6 AND project_id = $7`,
    [values.personName, values.role, values.level, values.ratePerHour, values.hours,
      req.params.assignmentId, req.params.id]
  );

  const cost = pnl.money(values.ratePerHour * values.hours);
  const changes = {};
  if (before.hours !== values.hours) changes.hours = { from: String(before.hours), to: String(values.hours) };
  if (before.ratePerHour !== values.ratePerHour) {
    changes.rate = { from: String(before.ratePerHour), to: String(values.ratePerHour) };
  }
  if (before.cost !== cost) changes.cost = { from: String(before.cost), to: String(cost) };

  req.activity({
    module: 'pnl', action: 'pnl.assignment_changed', entityType: 'project', entityId: req.params.id,
    entityLabel: values.personName || `${values.role} — ${values.level}`,
    summary: `Changed ${values.personName || values.level} on the project team — now `
      + `${values.hours}h at ${values.ratePerHour}/hour = ${cost}`,
    changes: Object.keys(changes).length ? changes : null,
  });
  await snapshots.capture(db, req.params.id);
  return res.json({ assignment: { id: req.params.assignmentId, projectId: req.params.id, ...values, cost } });
});

router.delete('/projects/:id/assignments/:assignmentId', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const team = await pnl.assignments(db, req.params.id);
  const before = team.find((a) => a.id === req.params.assignmentId);
  if (!before) return res.status(404).json({ error: 'That assignment does not exist.' });

  await db.query('DELETE FROM project_team_assignments WHERE id = $1 AND project_id = $2',
    [req.params.assignmentId, req.params.id]);
  req.activity({
    module: 'pnl', action: 'pnl.assignment_removed', entityType: 'project', entityId: req.params.id,
    entityLabel: before.personName || `${before.role} — ${before.level}`,
    summary: `Removed ${before.personName || before.level} from the project team `
      + `(was ${before.hours}h at ${before.ratePerHour}/hour = ${before.cost})`,
    changes: { cost: { from: String(before.cost), to: null } },
  });
  await snapshots.capture(db, req.params.id);
  return res.json({ ok: true, removed: before });
});

// --- client billing -----------------------------------------------------------

router.put('/projects/:id/billing', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const before = await pnl.billing(db, req.params.id);
  const { errors, warnings, values } = pnl.validateBilling(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  await db.query(
    `INSERT INTO project_billing (project_id, contract_value, billing_type, invoiced_to_date, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON DUPLICATE KEY UPDATE contract_value = VALUES(contract_value),
       billing_type = VALUES(billing_type), invoiced_to_date = VALUES(invoiced_to_date),
       updated_by = VALUES(updated_by)`,
    [req.params.id, values.contractValue, values.billingType, values.invoicedToDate, req.user.email]
  );

  const changes = {};
  if (before.contractValue !== values.contractValue) {
    changes.contractValue = { from: String(before.contractValue), to: String(values.contractValue) };
  }
  if (before.invoicedToDate !== values.invoicedToDate) {
    changes.invoicedToDate = { from: String(before.invoicedToDate), to: String(values.invoicedToDate) };
  }
  if ((before.billingType || null) !== values.billingType) {
    changes.billingType = { from: before.billingType, to: values.billingType };
  }

  /* Invoiced-to-date is REVENUE in the report, so a change to it changes the
     studio's reported profit. That is the single most important line this log
     carries. */
  req.activity({
    module: 'pnl', action: 'pnl.billing_changed', entityType: 'project', entityId: req.params.id,
    entityLabel: 'Client billing',
    summary: changes.invoicedToDate
      ? `Changed invoiced to date from ${before.invoicedToDate} to ${values.invoicedToDate}`
      : 'Changed the client billing details',
    changes: Object.keys(changes).length ? changes : null,
  });
  await snapshots.capture(db, req.params.id);
  return res.json({ billing: { projectId: req.params.id, ...values, configured: true }, warnings });
});

// --- other costs --------------------------------------------------------------

router.post('/projects/:id/other-costs', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const { errors, values } = pnl.validateOtherCost(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  const id = uuid();
  await db.query('INSERT INTO project_other_costs (id, project_id, label, amount) VALUES ($1,$2,$3,$4)',
    [id, req.params.id, values.label, values.amount]);
  req.activity({
    module: 'pnl', action: 'pnl.cost_added', entityType: 'project', entityId: req.params.id,
    entityLabel: values.label,
    summary: `Added the cost "${values.label}" at ${values.amount}`,
    changes: { amount: { from: null, to: String(values.amount) } },
  });
  await snapshots.capture(db, req.params.id);
  return res.status(201).json({ otherCost: { id, projectId: req.params.id, ...values } });
});

router.patch('/projects/:id/other-costs/:costId', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const list = await pnl.otherCosts(db, req.params.id);
  const before = list.find((c) => c.id === req.params.costId);
  if (!before) return res.status(404).json({ error: 'That cost does not exist.' });

  const { errors, values } = pnl.validateOtherCost({
    label: req.body.label === undefined ? before.label : req.body.label,
    amount: req.body.amount === undefined ? before.amount : req.body.amount,
  });
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  await db.query('UPDATE project_other_costs SET label = $1, amount = $2 WHERE id = $3 AND project_id = $4',
    [values.label, values.amount, req.params.costId, req.params.id]);
  req.activity({
    module: 'pnl', action: 'pnl.cost_changed', entityType: 'project', entityId: req.params.id,
    entityLabel: values.label,
    summary: `Changed the cost "${values.label}" from ${before.amount} to ${values.amount}`,
    changes: {
      ...(before.label !== values.label ? { label: { from: before.label, to: values.label } } : {}),
      ...(before.amount !== values.amount
        ? { amount: { from: String(before.amount), to: String(values.amount) } } : {}),
    },
  });
  await snapshots.capture(db, req.params.id);
  return res.json({ otherCost: { id: req.params.costId, projectId: req.params.id, ...values } });
});

router.delete('/projects/:id/other-costs/:costId', mayWrite, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const list = await pnl.otherCosts(db, req.params.id);
  const before = list.find((c) => c.id === req.params.costId);
  if (!before) return res.status(404).json({ error: 'That cost does not exist.' });

  await db.query('DELETE FROM project_other_costs WHERE id = $1 AND project_id = $2',
    [req.params.costId, req.params.id]);
  req.activity({
    module: 'pnl', action: 'pnl.cost_removed', entityType: 'project', entityId: req.params.id,
    entityLabel: before.label,
    summary: `Removed the cost "${before.label}" (was ${before.amount})`,
    changes: { amount: { from: String(before.amount), to: null } },
  });
  await snapshots.capture(db, req.params.id);
  return res.json({ ok: true, removed: before });
});

// --- the report ---------------------------------------------------------------

/* GET /api/pnl/report
 *
 * Filterable by client and project. Returns each project's figures, the rollup
 * across them, the labour breakdown and the margin trend.
 *
 * The rollup is summed from the per-project numbers rather than recomputed from
 * a wider query, so a client total can never disagree with the projects listed
 * beneath it — see rollup() in src/pnl.js for why the margin is recomputed from
 * the sums rather than averaged.
 */
router.get('/report', mayRead, async (req, res) => {
  const visible = await visibleProjects(req.user);
  let chosen = visible;
  if (req.query.clientId) chosen = chosen.filter((p) => p.client_id === req.query.clientId);
  if (req.query.projectId) chosen = chosen.filter((p) => p.id === req.query.projectId);

  const cards = await pnl.rateCards(db);
  const perProject = [];
  for (const project of chosen) {
    const figures = await pnl.forProject(db, project.id, { cards });
    perProject.push({
      ...figures,
      name: project.name,
      code: project.code,
      clientId: project.client_id,
    });
  }

  /* The breakdown across everything selected — every rate card row, so the
     table's shape does not change from one project to the next and two can be
     read side by side. */
  const allAssignments = perProject.flatMap((p) => p.assignments);
  const byRoleLevel = pnl.labourByRoleLevel(cards, allAssignments);

  /* THE CLIENT ROLLUP IS GROUPED HERE, not in the browser.
   *
   * The page could group by clientId itself and look up the names from the
   * clients it has already loaded, but those two lists are fetched at different
   * moments and filtered by different rules — a client archived between the two
   * calls would leave its projects under a blank heading, and a client the
   * caller cannot list would leave them under no heading at all. Grouping
   * beside the figures means the rollup and the projects under it are always
   * the same set of rows. */
  const clientIds = [...new Set(perProject.map((p) => p.clientId).filter(Boolean))];
  const names = new Map();
  if (clientIds.length) {
    const { rows: clientRows } = await db.query(
      `SELECT id, \`name\` FROM clients WHERE id IN ($1)`, [clientIds]);
    clientRows.forEach((c) => names.set(c.id, c.name));
  }
  const byClient = clientIds.map((id) => {
    const mine = perProject.filter((p) => p.clientId === id);
    return {
      clientId: id,
      /* Named rather than left blank when the client row has gone: the figures
         are still real and still have to be attributable to something. */
      name: names.get(id) || 'Unknown client',
      rollup: pnl.rollup(mine),
      projects: mine.map((p) => ({ projectId: p.projectId, name: p.name, code: p.code })),
    };
  }).sort((a, b) => b.rollup.revenue - a.rollup.revenue || a.name.localeCompare(b.name));

  /* Projects with no client at all, kept visible rather than dropped — their
     costs are in the rollup above, so hiding the projects would leave a total
     nobody can account for. */
  const unassigned = perProject.filter((p) => !p.clientId);
  if (unassigned.length) {
    byClient.push({
      clientId: null,
      name: 'No client',
      rollup: pnl.rollup(unassigned),
      projects: unassigned.map((p) => ({ projectId: p.projectId, name: p.name, code: p.code })),
    });
  }

  return res.json({
    projects: perProject.map((p) => ({
      projectId: p.projectId, name: p.name, code: p.code, clientId: p.clientId,
      totals: p.totals, billing: p.billing,
    })),
    rollup: pnl.rollup(perProject),
    byClient,
    byRoleLevel,
    trend: await snapshots.trend(db, perProject.map((p) => p.projectId), {
      from: req.query.from, to: req.query.to,
    }),
    rateCards: cards,
    filters: {
      clientId: req.query.clientId || null,
      projectId: req.query.projectId || null,
      from: req.query.from || null,
      to: req.query.to || null,
    },
    scope: { projects: chosen.length, ofVisible: visible.length },
    canManage: holds(req.user, 'pnl.manage'),
  });
});

module.exports = router;
