// The studio in one screen.
//
// A read model and nothing else: every figure here is derived from rows that
// already exist, nothing is stored, and no route built on it writes anything.
// It is a second VIEW of the pipeline, not a second copy of it — the Dashboard
// board, Projects, Assets List and Pending Actions are untouched and remain the
// authority for everything they show.
//
// TWO THINGS THIS FILE HAD TO INVENT, and they are worth reading before
// trusting a number on the screen.
//
//   1. There is no project status in this schema. `projects` carries
//      is_active, archived_at, closed_at, start_date and end_date, and that is
//      all. "Active", "On Track", "At Risk" and "Delivered" are therefore
//      DERIVED here rather than read from a column, and the derivations are
//      spelled out below so a figure that looks wrong can be argued with.
//
//   2. Nothing in this application had a notion of "late" before this screen.
//      No overdue flag, no risk threshold, nothing to copy. So the thresholds
//      below are new, they are named constants rather than numbers buried in a
//      query, and they are stated on the screen itself — a studio reading "3 at
//      risk" is entitled to know what the app means by it.
//
// SCOPED, NOT STUDIO-WIDE-BY-ASSUMPTION. Every count runs over
// permissions.visibleProjects(), the same rule the rest of the app uses. That
// matters because the Admin tier is projectScope:'owned' — it sees the projects
// it created, not the studio — so a studio-wide total shown to an Admin would
// be full of projects they cannot open. Whoever holds projectScope:'all' gets
// the whole studio; everybody else gets their own slice, and every number on
// the screen is one they can click into.

const permissions = require('./permissions');
const workflow = require('./asset-workflow');

/* How close to a deadline counts as "at risk".
 *
 * Seven days because the studio's week is the unit everything else here is
 * planned in, and a warning that arrives the day before is not a warning. It is
 * a constant rather than a literal in a query so that changing it is one edit,
 * and so the screen can say what it currently is. */
const AT_RISK_DAYS = 7;

/* How far ahead the delivery calendar looks, and how many dates it shows. */
const CALENDAR_DAYS = 60;
const CALENDAR_DATES = 5;

/* The stages that mean "this work is finished". Read from the workflow module
   rather than listed again here: a state added to the pipeline next year must
   not silently start counting as unfinished work in a dashboard nobody thought
   to update. */
const DONE_STATES = ['delivered'];

/* The stages where the work is with somebody for a decision rather than being
   made. These drive two of the Attention Required rows. */
const REVIEW_STATES = ['pending_tl_review', 'pending_cd_review'];
const CLIENT_STATES = ['awaiting_client_feedback'];

// Today at midnight, as MySQL sees a DATE. Everything here compares dates, not
// instants: a due date has no time on it, and an asset due today is not late.
function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const asISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/* An empty result, for the two cases that produce one: a role whose scope holds
   no projects at all, and a database that could not answer. Both are honest
   zeroes rather than an error page — an overview screen that refuses to render
   because there is nothing to show is worse than one that says so. */
function empty(reason = null) {
  return {
    counts: { active: 0, onTrack: 0, atRisk: 0, overdue: 0, delivered: 0 },
    pipeline: workflow.STATES.map((s) => ({ id: s.id, label: s.label, color: s.color, count: 0 })),
    calendar: [],
    attention: [],
    scope: { projects: 0 },
    thresholds: { atRiskDays: AT_RISK_DAYS },
    unavailable: reason,
  };
}

/* Everything the screen needs, in one pass.
 *
 * One payload rather than six endpoints: this is a screen somebody opens and
 * reads, and six round trips would let it paint four panels from one moment and
 * two from another — which on a busy afternoon means the cards and the
 * Attention list disagree about the same project. */
async function build(db, user) {
  let projects;
  try {
    projects = await permissions.visibleProjects(user);
  } catch (err) {
    return empty(`The project list could not be read (${err.code || 'error'}).`);
  }
  if (!projects.length) return empty();

  const ids = projects.map((p) => p.id);
  const now = today();
  const horizon = addDays(now, AT_RISK_DAYS);
  const todayISO = asISODate(now);
  const horizonISO = asISODate(horizon);

  /* Which projects hold late work, and which hold work about to be late.
   *
   * Asked of the assets rather than of the projects, because that is where the
   * dates that slip actually live: a project's own end_date is a plan, and an
   * asset's due_date is a commitment somebody is working against. Both are
   * consulted — a project past its own end date is late whatever its assets
   * say. */
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const doneList = DONE_STATES.map((s) => `'${s}'`).join(',');

  const { rows: lateRows } = await db.query(
    `SELECT project_id AS projectId,
            SUM(CASE WHEN due_date < $${ids.length + 1} THEN 1 ELSE 0 END) AS lateCount,
            SUM(CASE WHEN due_date >= $${ids.length + 2} AND due_date <= $${ids.length + 3} THEN 1 ELSE 0 END) AS soonCount
       FROM assets
      WHERE project_id IN (${placeholders})
        AND due_date IS NOT NULL
        AND \`status\` NOT IN (${doneList})
      GROUP BY project_id`,
    [...ids, todayISO, todayISO, horizonISO]
  );
  const late = new Map(lateRows.map((r) => [r.projectId, {
    late: Number(r.lateCount) || 0, soon: Number(r.soonCount) || 0,
  }]));

  /* Sort every visible project into exactly one bucket.
   *
   * Exactly one is the point: the four cards have to add up, or somebody will
   * spend an afternoon working out why Active is not On Track plus At Risk.
   *
   *   delivered   the project has been closed — the studio's own "Mark Client
   *               Closed", which is the only completion this app records.
   *   overdue     past its end date, or holding unfinished work already past
   *               its due date.
   *   at risk     unfinished work due inside the next AT_RISK_DAYS, or an end
   *               date that close, and not already overdue.
   *   on track    everything else that is still open.
   */
  const buckets = { onTrack: [], atRisk: [], overdue: [], delivered: [] };
  for (const p of projects) {
    if (p.closed_at) { buckets.delivered.push(p); continue; }

    const marks = late.get(p.id) || { late: 0, soon: 0 };
    const endsBefore = (iso) => p.end_date && asISODate(new Date(p.end_date)) < iso;
    const endsWithin = (iso) => p.end_date && asISODate(new Date(p.end_date)) <= iso;

    if (marks.late > 0 || endsBefore(todayISO)) buckets.overdue.push(p);
    else if (marks.soon > 0 || endsWithin(horizonISO)) buckets.atRisk.push(p);
    else buckets.onTrack.push(p);
  }

  const active = buckets.onTrack.length + buckets.atRisk.length + buckets.overdue.length;

  /* THE PIPELINE, over open projects only.
   *
   * A closed project's assets are all delivered, and leaving them in would make
   * the last bar dwarf every other one for the rest of the studio's life —
   * turning the panel into a record of how long the studio has existed rather
   * than a picture of what is in flight. */
  const openIds = [...buckets.onTrack, ...buckets.atRisk, ...buckets.overdue].map((p) => p.id);
  const pipeline = await stageCounts(db, openIds);

  /* THE CALENDAR: what is due, and when.
   *
   * Grouped by date rather than listed per asset — the question this panel
   * answers is "how heavy is Thursday", and twelve rows for one day answers a
   * different one. */
  const calendar = await upcoming(db, openIds, todayISO, asISODate(addDays(now, CALENDAR_DAYS)));

  /* ATTENTION REQUIRED. Every row is a count and a destination; nothing here
     is actionable in place, by design — this screen reports, and the screen it
     sends you to is where the work happens. */
  const waiting = await waitingCounts(db, openIds);
  const named = (list) => list.map((p) => ({ id: p.id, name: p.name, count: null }));
  const attention = [
    {
      severity: 'overdue',
      count: buckets.overdue.length,
      label: buckets.overdue.length === 1 ? 'project overdue' : 'projects overdue',
      detail: 'Past its end date, or holding work already past its due date.',
      projects: named(buckets.overdue),
    },
    {
      severity: 'at-risk',
      count: buckets.atRisk.length,
      label: buckets.atRisk.length === 1 ? 'project at risk' : 'projects at risk',
      detail: `Something due inside ${AT_RISK_DAYS} days is not finished.`,
      projects: named(buckets.atRisk),
    },
    {
      severity: 'at-risk',
      count: waiting.review,
      label: waiting.review === 1 ? 'asset waiting on review' : 'assets waiting on review',
      detail: 'Submitted, and sitting with a team lead or the Creative Director.',
      projects: waiting.reviewBy,
    },
    {
      severity: 'client',
      count: waiting.client,
      label: waiting.client === 1 ? 'asset awaiting client feedback' : 'assets awaiting client feedback',
      detail: 'Delivered to the client and waiting on their word.',
      projects: waiting.clientBy,
    },
  ].filter((row) => row.count > 0);

  return {
    counts: {
      active,
      onTrack: buckets.onTrack.length,
      /* Overdue is INSIDE at risk on the card, and on its own in the list
         below it. "Flagged behind or at risk" is one question for a studio
         head deciding where to look; "which of those are already late" is the
         next one, and the Attention panel answers it. */
      atRisk: buckets.atRisk.length + buckets.overdue.length,
      overdue: buckets.overdue.length,
      delivered: buckets.delivered.length,
    },
    pipeline,
    calendar,
    attention,
    scope: { projects: projects.length },
    thresholds: { atRiskDays: AT_RISK_DAYS },
    unavailable: null,
  };
}

/* How much work is sitting in each stage of the pipeline.
 *
 * Every stage is returned, including the empty ones. A bar chart that hides its
 * zeroes changes shape as work moves through it, and a panel whose axis moves
 * cannot be read at a glance — which is the only way this one is ever read. */
async function stageCounts(db, projectIds) {
  const blank = workflow.STATES.map((s) => ({ id: s.id, label: s.label, color: s.color, count: 0 }));
  if (!projectIds.length) return blank;

  const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT \`status\`, COUNT(*) AS n FROM assets WHERE project_id IN (${placeholders}) GROUP BY \`status\``,
    projectIds
  );
  const counts = new Map(rows.map((r) => [r.status, Number(r.n) || 0]));
  return blank.map((s) => ({ ...s, count: counts.get(s.id) || 0 }));
}

/* The next few dates something is due on, soonest first. */
async function upcoming(db, projectIds, fromISO, toISO) {
  if (!projectIds.length) return [];
  const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
  const doneList = DONE_STATES.map((s) => `'${s}'`).join(',');
  const { rows } = await db.query(
    `SELECT due_date AS due, COUNT(*) AS n
       FROM assets
      WHERE project_id IN (${placeholders})
        AND due_date IS NOT NULL
        AND due_date >= $${projectIds.length + 1}
        AND due_date <= $${projectIds.length + 2}
        AND \`status\` NOT IN (${doneList})
      GROUP BY due_date
      ORDER BY due_date
      LIMIT ${CALENDAR_DATES + 1}`,
    [...projectIds, fromISO, toISO]
  );
  /* One more than we show, so the panel can say "and more beyond these"
     truthfully rather than implying the list is the whole of it. */
  const shown = rows.slice(0, CALENDAR_DATES).map((r) => ({
    date: typeof r.due === 'string' ? r.due : asISODate(new Date(r.due)),
    count: Number(r.n) || 0,
  }));
  return Object.assign(shown, { more: rows.length > CALENDAR_DATES });
}

/* Work sitting with somebody for a decision, and WHICH PROJECTS it is in.
 *
 * The breakdown is the difference between a number and something somebody can
 * act on. This application has no studio-wide list of assets — the Assets List
 * and the board are both per-project — so "6 assets waiting on review" with
 * nowhere to click would be a dead end. Grouped by project, every row on the
 * screen ends at a project somebody can open. */
async function waitingCounts(db, projectIds) {
  if (!projectIds.length) return { review: 0, client: 0, reviewBy: [], clientBy: [] };
  const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
  const wanted = [...REVIEW_STATES, ...CLIENT_STATES];
  const { rows } = await db.query(
    `SELECT a.\`status\`, a.project_id AS projectId, p.\`name\` AS projectName, COUNT(*) AS n
       FROM assets a
       JOIN projects p ON p.id = a.project_id
      WHERE a.project_id IN (${placeholders})
        AND a.\`status\` IN (${wanted.map((s) => `'${s}'`).join(',')})
      GROUP BY a.\`status\`, a.project_id, p.\`name\``,
    projectIds
  );

  const gather = (states) => {
    const per = new Map();
    for (const r of rows) {
      if (!states.includes(r.status)) continue;
      const at = per.get(r.projectId) || { id: r.projectId, name: r.projectName, count: 0 };
      at.count += Number(r.n) || 0;
      per.set(r.projectId, at);
    }
    // Heaviest first: the project holding nine of them is the one to open.
    return [...per.values()].sort((a, b) => b.count - a.count);
  };

  const reviewBy = gather(REVIEW_STATES);
  const clientBy = gather(CLIENT_STATES);
  return {
    review: reviewBy.reduce((sum, r) => sum + r.count, 0),
    client: clientBy.reduce((sum, r) => sum + r.count, 0),
    reviewBy,
    clientBy,
  };
}

module.exports = {
  build, empty, stageCounts, upcoming, waitingCounts,
  AT_RISK_DAYS, CALENDAR_DAYS, CALENDAR_DATES,
  DONE_STATES, REVIEW_STATES, CLIENT_STATES,
};
