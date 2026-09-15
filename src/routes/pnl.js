const { asyncRouter } = require('../async-router');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');
const pnl = require('../pnl');
const snapshots = require('../pnl-snapshots');
const pnlHours = require('../pnl-hours');
const roles = require('../roles');
const { holds, visibleProjects, canAccessProject } = require('../permissions');
const db = require('../db');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();

router.use(authenticate);

/* THREE PERMISSIONS, AND EVERY SPLIT IS LOAD-BEARING.
 *
 *   pnl.actual  the Actual P&L tab: invoiced revenue, the entered Total Cost,
 *               hours consumed, profit, margin, cost per hour. Also the
 *               authority to ENTER that Total Cost — the figure and the tab are
 *               one grant because the tab exists to maintain it.
 *   pnl.fixed   the Fixed P&L tab: contract value, bid hours against delivered
 *               hours, budgeted against actual cost, the role breakdown.
 *   pnl.manage  the underlying data both tabs read: role rates, the rate cards,
 *               team assignments, client billing, ad hoc costs.
 *
 * NONE OF THEM IMPLIES ANOTHER. A user may hold either tab, both, or neither,
 * and holding neither means the Profit & Loss tab does not appear at all.
 * pnl.manage on its own opens neither tab: somebody trusted to set the rate
 * card is not thereby shown every project's margin.
 */
const maySeeActual = (req, res, next) => (
  holds(req.user, 'pnl.actual')
    ? next()
    : res.status(403).json({ error: 'You do not have permission to access Actual P&L.' })
);

const maySeeFixed = (req, res, next) => (
  holds(req.user, 'pnl.fixed')
    ? next()
    : res.status(403).json({ error: 'You do not have permission to access Fixed P&L.' })
);

/* For the routes that serve BOTH tabs — the project list, the filters, the
   figures a screen needs before it knows which tab is showing. Either tab is
   enough; the payload itself is trimmed per tab by the caller. */
const maySeeEither = (req, res, next) => (
  holds(req.user, 'pnl.actual') || holds(req.user, 'pnl.fixed')
    ? next()
    : res.status(403).json({ error: 'You do not have permission to view Profit & Loss.' })
);

/* The refusal says which of the situations this is.
 *
 * A single message reading "you can view but not change" was a lie to anybody
 * holding NEITHER permission — these write routes do not run a read gate first,
 * so it was told to them too, and it asserted an access they did not have. Two
 * sentences, because "you have the wrong permission" and "you have none of
 * them" need different things done about them. */
const mayWrite = (req, res, next) => {
  if (holds(req.user, 'pnl.manage')) return next();
  return res.status(403).json({
    error: holds(req.user, 'pnl.actual') || holds(req.user, 'pnl.fixed')
      ? 'You can view Profit & Loss but not change the figures it is computed from.'
      : 'You do not have permission to change Profit & Loss figures.',
  });
};

/* Entering the Actual tab's Total Cost is pnl.actual, NOT pnl.manage.
 *
 * Deliberate, and the one place the two authorities are not separated. That
 * figure is not shared underlying data like a rate card is — it belongs to the
 * Actual tab, it is the only thing on that tab anybody types, and the brief for
 * this feature put the tab and the figure in one grant. Somebody given the
 * Actual tab is being asked to keep it accurate. */
const mayEnterTotalCost = maySeeActual;

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

router.get('/rate-cards', (req, res, next) => (
  holds(req.user, 'pnl.manage') ? next() : maySeeEither(req, res, next)
), async (req, res) => {
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

router.get('/projects/:id', maySeeEither, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const [data, worked] = await Promise.all([
    pnl.forProject(db, req.params.id),
    hoursFor(req.params.id),
  ]);
  return res.json({
    ...data,
    hours: worked,
    billingTypes: pnl.BILLING_TYPES,
    // What this caller may do here, so the screen does not offer a control the
    // API would refuse.
    canManage: holds(req.user, 'pnl.manage'),
    canSeeActual: holds(req.user, 'pnl.actual'),
    canSeeFixed: holds(req.user, 'pnl.fixed'),
  });
});

/* activeRoles() answers from a cache once it is warm, so it returns a plain
   ARRAY then and a promise before that. Promise.resolve flattens both, and the
   try/catch covers the synchronous throw the promise form would have rejected
   with. Getting this wrong is what made every P&L route 500 the first time. */
async function designations() {
  try {
    return await Promise.resolve(roles.activeRoles());
  } catch {
    return [];
  }
}

/* Hours and their cost for one project, with designations labelled.
 *
 * The label lookup is resolved here rather than in pnl-hours because the role
 * catalogue is async and cached, and a domain module that has to be awaited to
 * name a thing is harder to test than one that is handed a naming function. */
async function hoursFor(projectId, rates) {
  const list = await designations();
  const labels = new Map(list.map((r) => [r.key, r.label || r.name || r.key]));
  return pnlHours.forProject(db, projectId, {
    rates,
    roleLabel: (key) => labels.get(key) || key,
  });
}

// --- per-role hourly rates ----------------------------------------------------

/* The rate table, every designation listed — including the ones nobody has
   priced, at null rather than at zero. A Settings screen that showed only the
   priced ones could not be used to price the rest. */
router.get('/role-rates', (req, res, next) => (
  holds(req.user, 'pnl.manage') ? next() : maySeeEither(req, res, next)
), async (req, res) => {
  const [list, rates] = await Promise.all([
    designations(),
    pnlHours.roleRates(db),
  ]);
  return res.json({
    roleRates: list.map((r) => ({
      roleKey: r.key,
      label: r.label || r.name || r.key,
      ratePerHour: rates.has(r.key) ? rates.get(r.key) : null,
      priced: rates.has(r.key),
    })),
    canManage: holds(req.user, 'pnl.manage'),
  });
});

router.put('/role-rates/:roleKey', mayWrite, async (req, res) => {
  const list = await designations();
  const role = list.find((r) => r.key === req.params.roleKey);
  if (!role) return res.status(404).json({ error: 'That designation does not exist.' });

  const raw = req.body ? req.body.ratePerHour : undefined;

  /* CLEARING IS EXPLICIT, and only an explicit null does it.
   *
   * An empty string used to clear the rate as well, which made an emptied box
   * and a press of Save delete a rate and report "Rate saved." — a wipe that
   * looked like a write. Blank is now REFUSED and the caller is told where the
   * deliberate way to unprice a designation is.
   *
   * Clearing is still not the same as setting zero: unpriced means the hours
   * are reported as uncosted, where zero means they genuinely cost nothing. */
  if (raw === '' || (typeof raw === 'string' && raw.trim() === '')) {
    return res.status(400).json({
      error: 'Enter a rate, or use Clear to mark this designation unpriced.',
      field: 'ratePerHour',
    });
  }
  const clearing = raw === null || raw === undefined;
  let value = null;
  if (!clearing) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: 'The rate must be a number.', field: 'ratePerHour' });
    }
    if (n < 0) {
      return res.status(400).json({ error: 'A rate cannot be negative.', field: 'ratePerHour' });
    }
    if (n > 99999999.99) {
      return res.status(400).json({ error: 'That rate is too large.', field: 'ratePerHour' });
    }
    value = pnl.money(n);
  }

  const before = await pnlHours.roleRates(db);
  const had = before.has(req.params.roleKey) ? before.get(req.params.roleKey) : null;

  if (clearing) {
    await db.query('DELETE FROM role_rates WHERE role_key = $1', [req.params.roleKey]);
  } else {
    await db.query(
      `INSERT INTO role_rates (role_key, rate_per_hour, updated_by) VALUES ($1,$2,$3)
       ON DUPLICATE KEY UPDATE rate_per_hour = VALUES(rate_per_hour), updated_by = VALUES(updated_by)`,
      [req.params.roleKey, value, req.user.email]
    );
  }

  req.activity({
    module: 'pnl', action: 'pnl.role_rate_changed', entityType: 'role',
    entityId: req.params.roleKey, entityLabel: role.label || role.name || role.key,
    summary: clearing
      ? `Cleared the hourly rate for ${role.label || role.key} (was ${had === null ? 'unpriced' : had})`
      : `Set the hourly rate for ${role.label || role.key} to ${value}`,
    changes: { ratePerHour: { from: had === null ? null : String(had), to: clearing ? null : String(value) } },
  });

  return res.json({ ok: true, roleKey: req.params.roleKey, ratePerHour: value, priced: !clearing });
});

// --- the Actual tab's entered Total Cost --------------------------------------

/* Behind pnl.actual, NOT pnl.manage — see the note beside mayEnterTotalCost. */
router.put('/projects/:id/total-cost', mayEnterTotalCost, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const before = await pnl.billing(db, req.params.id);

  const raw = req.body ? req.body.totalCost : undefined;
  const clearing = raw === null || raw === '' || raw === undefined;
  let value = null;
  if (!clearing) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: 'The total cost must be a number.', field: 'totalCost' });
    }
    if (n < 0) {
      /* A negative cost is almost always a typed minus sign, and silently
         turning it into extra profit is the wrong way to be wrong about
         money. Same rule as every other amount in this module. */
      return res.status(400).json({ error: 'A total cost cannot be negative.', field: 'totalCost' });
    }
    if (n > 99999999999.99) {
      return res.status(400).json({ error: 'That total cost is too large.', field: 'totalCost' });
    }
    value = pnl.money(n);
  }

  /* The billing row may not exist yet — entering a cost before anybody has set
     a contract value is perfectly ordinary, and refusing it would make the tab
     unusable until somebody else did their half. */
  await db.query(
    `INSERT INTO project_billing (project_id, total_cost, updated_by) VALUES ($1,$2,$3)
     ON DUPLICATE KEY UPDATE total_cost = VALUES(total_cost), updated_by = VALUES(updated_by)`,
    [req.params.id, value, req.user.email]
  );

  req.activity({
    module: 'pnl', action: 'pnl.total_cost_changed', entityType: 'project',
    entityId: req.params.id,
    summary: clearing
      ? `Cleared the entered Total Cost (was ${before.totalCost === null ? 'not entered' : before.totalCost})`
      : `Set the Total Cost to ${value}`,
    changes: {
      totalCost: {
        from: before.totalCost === null ? null : String(before.totalCost),
        to: clearing ? null : String(value),
      },
    },
  });

  await snapshots.capture(db, req.params.id);
  const billing = await pnl.billing(db, req.params.id);
  return res.json({ ok: true, billing });
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
       (id, project_id, user_id, person_name, rate_card_id, \`role\`, level, rate_per_hour,
        assigned_hours, \`hours\`, billed_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, req.params.id, req.body.userId || null, values.personName,
      req.body.rateCardId || null, values.role, values.level, values.ratePerHour,
      values.assignedHours, values.hours, values.billedHours]
  );
  const cost = pnl.money(values.ratePerHour * values.hours);
  req.activity({
    module: 'pnl', action: 'pnl.assignment_added', entityType: 'project', entityId: req.params.id,
    entityLabel: values.personName || `${values.role} — ${values.level}`,
    summary: `Added ${values.personName || values.level} to the project team: `
      + `${values.hours}h worked at ${values.ratePerHour}/hour = ${cost}`
      + ` (planned ${values.assignedHours}h, billed ${values.billedHours}h)`,
    changes: {
      cost: { from: null, to: String(cost) },
      assignedHours: { from: null, to: String(values.assignedHours) },
      billedHours: { from: null, to: String(values.billedHours) },
    },
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
    /* Field by field, so a caller changing only the billed hours does not wipe
       the plan — the three are edited independently on the screen and often
       one at a time. */
    assignedHours: req.body.assignedHours === undefined ? before.assignedHours : req.body.assignedHours,
    billedHours: req.body.billedHours === undefined ? before.billedHours : req.body.billedHours,
    personName: req.body.personName === undefined ? before.personName : req.body.personName,
  };
  const { errors, values } = pnl.validateAssignment(merged);
  if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

  await db.query(
    `UPDATE project_team_assignments
        SET person_name = $1, \`role\` = $2, level = $3, rate_per_hour = $4, \`hours\` = $5,
            assigned_hours = $6, billed_hours = $7
      WHERE id = $8 AND project_id = $9`,
    [values.personName, values.role, values.level, values.ratePerHour, values.hours,
      values.assignedHours, values.billedHours,
      req.params.assignmentId, req.params.id]
  );

  const cost = pnl.money(values.ratePerHour * values.hours);
  const changes = {};
  if (before.hours !== values.hours) changes.hours = { from: String(before.hours), to: String(values.hours) };
  if (before.assignedHours !== values.assignedHours) {
    changes.assignedHours = { from: String(before.assignedHours), to: String(values.assignedHours) };
  }
  if (before.billedHours !== values.billedHours) {
    changes.billedHours = { from: String(before.billedHours), to: String(values.billedHours) };
  }
  if (before.ratePerHour !== values.ratePerHour) {
    changes.rate = { from: String(before.ratePerHour), to: String(values.ratePerHour) };
  }
  if (before.cost !== cost) changes.cost = { from: String(before.cost), to: String(cost) };

  req.activity({
    module: 'pnl', action: 'pnl.assignment_changed', entityType: 'project', entityId: req.params.id,
    entityLabel: values.personName || `${values.role} — ${values.level}`,
    summary: `Changed ${values.personName || values.level} on the project team — now `
      + `${values.hours}h worked at ${values.ratePerHour}/hour = ${cost}`
      + ` (planned ${values.assignedHours}h, billed ${values.billedHours}h)`,
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
router.get('/report', maySeeEither, async (req, res) => {
  const visible = await visibleProjects(req.user);
  let chosen = visible;
  if (req.query.clientId) chosen = chosen.filter((p) => p.client_id === req.query.clientId);
  if (req.query.projectId) chosen = chosen.filter((p) => p.id === req.query.projectId);

  const cards = await pnl.rateCards(db);
  /* The rate table is read ONCE and handed to every project, rather than each
     project fetching it again. With a hundred projects that is one query
     instead of a hundred, and — more importantly — every project on the screen
     is priced against the same rates, so a rate edited while the report is
     being built cannot leave two projects costed differently. */
  const rates = await pnlHours.roleRates(db);
  const perProject = [];
  for (const project of chosen) {
    const [figures, worked] = await Promise.all([
      pnl.forProject(db, project.id, { cards }),
      hoursFor(project.id, rates),
    ]);
    perProject.push({
      ...figures,
      hours: worked,
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
      totals: p.totals, billing: p.billing, hours: p.hours,
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
    /* The rolled-up hours figures, summed across the selected projects the same
       way the money is — from the per-project numbers, so a total can never
       disagree with the rows listed under it.

       unpricedHours is carried all the way up on purpose. A rollup that
       silently dropped it would report a confident cost for a set of projects
       whose people are not all priced, which is the one thing this screen must
       not do. */
    hoursRollup: {
      bidHours: pnlHours.round2(perProject.reduce((t, p) => t + p.hours.bidHours, 0)),
      consumedHours: pnlHours.round2(perProject.reduce((t, p) => t + p.hours.consumedHours, 0)),
      deliveredHours: pnlHours.round2(perProject.reduce((t, p) => t + p.hours.deliveredHours, 0)),
      actualCost: pnl.money(perProject.reduce((t, p) => t + p.hours.actualCost, 0)),
      /* Summed from each project's OWN budgeted cost, not recomputed from the
         summed hours at a global blended rate: a studio-wide blend would price
         one project's bid hours at another project's mix of people. A project
         with nothing delivered has no rate basis and contributes null, which is
         carried as "some of this is unpriced" rather than as zero. */
      budgetedCost: pnl.money(perProject.reduce(
        (t, p) => t + (p.hours.budgetedCost === null ? 0 : p.hours.budgetedCost), 0)),
      projectsWithBudget: perProject.filter((p) => p.hours.budgetedCost !== null).length,
      unpricedHours: pnlHours.round2(perProject.reduce((t, p) => t + p.hours.actualUnpricedHours, 0)),
      /* Entered costs only add up across the projects that have one. How many
         did is reported beside it, so "₹2,00,000 across 3 of 7 projects" cannot
         be misread as the cost of all seven. */
      enteredTotalCost: pnl.money(perProject.reduce(
        (t, p) => t + (p.billing.totalCost === null ? 0 : p.billing.totalCost), 0)),
      projectsWithTotalCost: perProject.filter((p) => p.billing.totalCost !== null).length,
      projects: perProject.length,
    },
    canManage: holds(req.user, 'pnl.manage'),
    canSeeActual: holds(req.user, 'pnl.actual'),
    canSeeFixed: holds(req.user, 'pnl.fixed'),
  });
});

module.exports = router;
