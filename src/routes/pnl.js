const { asyncRouter } = require('../async-router');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');
const pnl = require('../pnl');
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
const mayEnterTotalValue = maySeeActual;

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

// --- the Rate Card, the team list and the billing figures: all removed --------
//
// rate_cards was a free-text role/level price list whose only consumer was the
// manual project team assignment. That assignment, the client billing figures
// (contract value, billing type, invoiced to date) and the ad hoc cost lines
// have all been taken out of the product: one price list prices everything now,
// and it is role_rates below — the Rate Card, keyed on the designation a person
// actually holds, which is the only thing a recorded hour can be costed
// against.
//
// The routes are DELETED rather than left answering with an empty list. An
// endpoint that still responds is an endpoint something still calls, and the
// point of this change is that there is nothing left to call.

// --- one project's figures ----------------------------------------------------

router.get('/projects/:id', maySeeEither, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  /* The hours first, then the figures costed from them — the Actual tab's cost
     is the recorded hours priced, so compute() is handed them rather than
     working them out again. Same order, same reason, as the report route. */
  const worked = await hoursFor(req.params.id);
  const data = await pnl.forProject(db, req.params.id, { hours: worked });
  return res.json({
    ...data,
    hours: worked,
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
/* Per-designation rows from several projects, added into one table.
 *
 * Rows are keyed on the designation, so one person's hours on three projects
 * land on one line. `people` is a Set while folding and a sorted array after,
 * because the same person appearing on two projects is still one person and a
 * list that said so twice would be read as two.
 *
 * An UNPRICED row keeps its hours and reports no cost, rather than being
 * dropped: those hours were really worked, and a breakdown that hid them would
 * quietly disagree with the hours figure on the card above it. */
function foldByRole(lists) {
  const rows = new Map();
  for (const list of lists) {
    for (const b of list) {
      const key = b.roleKey || '(none)';
      if (!rows.has(key)) {
        rows.set(key, {
          roleKey: b.roleKey, roleLabel: b.roleLabel, ratePerHour: b.ratePerHour,
          priced: b.priced,
          budgetedHours: 0, budgetedCost: 0,
          recordedHours: 0, recordedCost: 0,
          people: new Set(),
        });
      }
      const row = rows.get(key);
      row.budgetedHours = pnlHours.round2(row.budgetedHours + b.budgetedHours);
      row.budgetedCost = pnl.money(row.budgetedCost + b.budgetedCost);
      row.recordedHours = pnlHours.round2(row.recordedHours + b.recordedHours);
      row.recordedCost = pnl.money(row.recordedCost + b.recordedCost);
      for (const n of (b.people || [])) row.people.add(n);
    }
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      people: [...r.people].sort(),
      /* The same sign convention as the project total: positive is a saving.
         Worked out here so a row and the card above it cannot disagree about
         which way is the good way. */
      variance: pnl.money(r.budgetedCost - r.recordedCost),
      hoursVariance: pnlHours.round2(r.budgetedHours - r.recordedHours),
    }))
    .sort((a, b) => Math.max(b.budgetedHours, b.recordedHours)
      - Math.max(a.budgetedHours, a.recordedHours));
}

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

// --- the Actual tab's entered Total Value --------------------------------------

/* THE ONE FIGURE THE ACTUAL TAB STILL ASKS A PERSON FOR.
 *
 * It replaces the entered Total Cost that used to live here. The cost is no
 * longer typed: it is the hours people actually logged on the project, priced
 * at their designation's rate from Settings → Role Rates. What could not be
 * derived is what the project was SOLD for, so that is what is asked, and
 * nothing else.
 *
 * The old total_cost column is left alone rather than dropped. Figures somebody
 * entered are a record of what they believed at the time, and a migration that
 * deletes them to tidy up a screen is a migration that cannot be undone. It is
 * simply no longer read by this tab.
 *
 * Behind pnl.actual, NOT pnl.manage — see the note beside mayEnterTotalValue.
 * Whoever is given this tab is being asked to keep its one number right. */
router.put('/projects/:id/total-value', mayEnterTotalValue, async (req, res) => {
  if (!await reachable(req, res, req.params.id)) return undefined;
  const before = await pnl.billing(db, req.params.id);

  const raw = req.body ? req.body.totalValue : undefined;
  const clearing = raw === null || raw === '' || raw === undefined;
  let value = null;
  if (!clearing) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: 'The total value must be a number.', field: 'totalValue' });
    }
    if (n < 0) {
      /* A negative contract value is almost always a typed minus sign, and
         silently turning it into a loss is the wrong way to be wrong about
         money. Same rule as every other amount in this module. */
      return res.status(400).json({ error: 'A total value cannot be negative.', field: 'totalValue' });
    }
    if (n > 99999999999.99) {
      return res.status(400).json({ error: 'That total value is too large.', field: 'totalValue' });
    }
    value = pnl.money(n);
  }

  /* The billing row may not exist yet — entering a value before anybody has
     touched Client Billing is perfectly ordinary now that the two are edited on
     different tabs by different people, and refusing it would make this tab
     unusable until somebody else did their half. */
  await db.query(
    `INSERT INTO project_billing (project_id, total_value, updated_by) VALUES ($1,$2,$3)
     ON DUPLICATE KEY UPDATE total_value = VALUES(total_value), updated_by = VALUES(updated_by)`,
    [req.params.id, value, req.user.email]
  );

  req.activity({
    module: 'pnl', action: 'pnl.total_value_changed', entityType: 'project',
    entityId: req.params.id,
    summary: clearing
      ? `Cleared the Actual P&L Total Value (was ${before.totalValue === null ? 'not entered' : before.totalValue})`
      : `Set the Actual P&L Total Value to ${value}`,
    changes: {
      totalValue: {
        from: before.totalValue === null ? null : String(before.totalValue),
        to: clearing ? null : String(value),
      },
    },
  });

  const billing = await pnl.billing(db, req.params.id);
  return res.json({ ok: true, billing });
});

// --- the report ---------------------------------------------------------------

/* GET /api/pnl/report
 *
 * Filterable by client and project. Returns each project's figures, the rollup
 * across them, and the breakdown by designation.
 *
 * THE MARGIN TREND IS GONE, and with it the monthly snapshots behind it. It was
 * drawn from rows written whenever somebody saved on this screen, so with both
 * tabs now computed from recorded hours there was nothing left to trigger a
 * write — the chart would have frozen at whatever the last manual edit left
 * behind and gone on looking live. A chart that stops moving without saying so
 * is worse than no chart. The pnl_snapshots table is left in place with its
 * history; nothing reads or writes it.
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

  /* The rate table is read ONCE and handed to every project, rather than each
     project fetching it again. With a hundred projects that is one query
     instead of a hundred, and — more importantly — every project on the screen
     is priced against the same rates, so a rate edited while the report is
     being built cannot leave two projects costed differently. */
  const rates = await pnlHours.roleRates(db);
  const perProject = [];
  for (const project of chosen) {
    /* The hours FIRST, then the figures costed from them. They used to be
       fetched in parallel because neither needed the other; the Actual tab's
       cost is now the recorded hours priced, so compute() has to be handed them
       rather than working them out a second time from a second query. */
    const worked = await hoursFor(project.id, rates);
    const figures = await pnl.forProject(db, project.id, { hours: worked });
    perProject.push({
      ...figures,
      hours: worked,
      name: project.name,
      code: project.code,
      clientId: project.client_id,
    });
  }

  /* THE BREAKDOWN ACROSS EVERYTHING SELECTED: budgeted and recorded, side by
     side, per designation. Folded here rather than in the browser so this table
     and the cards above it are made from one set of numbers — two folds of two
     different sets is how a table stops adding up to the total beside it. */
  const byRole = foldByRole(perProject.map((p) => p.byRole || []));

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
  /* Biggest first, by what has actually been spent. This sorted on revenue
     before, which the feature no longer has. */
  }).sort((a, b) => b.rollup.recordedCost - a.rollup.recordedCost || a.name.localeCompare(b.name));

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
      totals: p.totals, billing: p.billing, byRole: p.byRole,
    })),
    rollup: pnl.rollup(perProject),
    byClient,
    byRole,
    filters: {
      clientId: req.query.clientId || null,
      projectId: req.query.projectId || null,
    },
    scope: { projects: chosen.length, ofVisible: visible.length },
    canManage: holds(req.user, 'pnl.manage'),
    canSeeActual: holds(req.user, 'pnl.actual'),
    canSeeFixed: holds(req.user, 'pnl.fixed'),
  });
});

module.exports = router;
