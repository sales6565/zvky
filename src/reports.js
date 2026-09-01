// Work-efficiency reporting: what an asset was estimated to take, against how
// long it was open.
//
//   Efficiency % = (Man Hours / Time Spent) x 100
//
// Above 100 means it came in under the estimate; below means it took longer.
// The division is that way round on purpose — estimate over actual — so a
// bigger number is better, which is what "efficiency" reads as.
//
// WHAT TIME SPENT MEANS NOW, AND WHAT THAT COSTS THIS REPORT. Time Spent used
// to be active worked time, measured by a running timer with Pause and Resume.
// The studio removed that: it is now the wall-clock span from Accept and Start
// to Submit for Review (see src/work-log.js), which includes lunch, meetings,
// evenings and weekends if the work was left open across them.
//
// So this is no longer a measure of effort against estimate. It is elapsed
// TURNAROUND against estimate. An asset genuinely worked for four hours but
// accepted on Friday afternoon and handed in on Monday morning scores about 6%,
// and nothing is wrong with either the estimate or the artist.
//
// That is why the over-budget flag was removed rather than re-tuned. It marked
// any group averaging under 80% across three or more assets, which under the
// old definition meant "these consistently take longer than estimated" and
// under this one means "these are usually left open overnight" — which is most
// work in most studios. A flag that fires on the ordinary case is worse than no
// flag, because people learn to ignore it and then miss the real one. The
// percentages are still there to read; what has gone is the app's claim to know
// which of them is a problem.
//
// TWO numbers, because an asset can go round more than once:
//
//   FIRST PASS  the time before the first submission. work_sessions.round is
//               set to (submissions so far + 1), so round 1 IS the first pass —
//               nothing has to be inferred from timestamps.
//   TOTAL       every round, rework included. The honest cost of the asset.
//
// A wide gap between them is the interesting signal: an asset estimated well
// but reworked three times is a review problem, not an estimating problem, and
// one number alone cannot tell those apart.
//
// The maths lives here rather than in the route so it can be checked against
// hand-worked examples without a database.

// Hours, from seconds. Time is tracked in seconds; estimates are in hours.
const HOUR = 3600;

/* One asset's efficiency, or null where it cannot honestly be given.
 *
 * Returning null rather than 0 or 100 is the whole point: an asset with no
 * estimate has no efficiency, and an asset with no tracked time would divide by
 * zero. Both are excluded from averages rather than dragging them somewhere
 * arbitrary. The caller is told which, so the report can say how many assets it
 * left out and why instead of quietly reporting on a subset.
 */
function efficiencyOf(manHours, seconds) {
  const hours = Number(manHours);
  const spent = Number(seconds);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (!Number.isFinite(spent) || spent <= 0) return null;
  return (hours / (spent / HOUR)) * 100;
}

/* Why an asset is not in the report. One reason per asset, in the order a
 * person would ask about them. */
function exclusionReason(row) {
  if (!row.submitted) return 'never submitted';
  if (!(Number(row.manHours) > 0)) return 'no Man Hours estimate';
  if (!(Number(row.totalSeconds) > 0)) return 'no time recorded';
  return null;
}

// Round to one decimal. Percentages to more precision than this are noise.
const pct = (v) => (v === null ? null : Math.round(v * 10) / 10);

/* Turn the raw per-asset rows into the shape every breakdown is built from.
 *
 * `rows` come from the database already joined; this adds the derived numbers
 * and separates what can be reported on from what cannot. */
function prepare(rows) {
  const included = [];
  const excluded = [];
  for (const row of rows) {
    const reason = exclusionReason(row);
    if (reason) {
      excluded.push({ id: row.id, code: row.code, name: row.name, reason });
      continue;
    }
    /* First-pass time can be zero on an asset whose whole first round predates
       time recording, while total time is not. That is not a divide-by-zero to
       hide; it is a first-pass number that does not exist, so it stays null and
       the first-pass average simply has one fewer asset in it. */
    included.push({
      ...row,
      firstPass: pct(efficiencyOf(row.manHours, row.firstPassSeconds)),
      total: pct(efficiencyOf(row.manHours, row.totalSeconds)),
    });
  }
  return { included, excluded };
}

/* The mean of the values that exist, ignoring the ones that do not.
 *
 * A straight average of assets, not weighted by size. Weighting by hours would
 * let one big asset speak for a person's whole quarter; this way each asset is
 * one observation, which is what "they usually run over" means. */
function mean(values) {
  const real = values.filter((v) => v !== null && Number.isFinite(v));
  if (!real.length) return null;
  return pct(real.reduce((a, b) => a + b, 0) / real.length);
}

/* Group the prepared assets and average each group.
 *
 * `keyOf` returns null for an asset that does not belong to any group — an
 * asset with no category, when grouping by category — and those are counted
 * separately rather than lumped into a group called "null". */
function groupBy(assets, keyOf, labelOf) {
  const buckets = new Map();
  let ungrouped = 0;
  for (const asset of assets) {
    const key = keyOf(asset);
    if (key === null || key === undefined || key === '') { ungrouped += 1; continue; }
    if (!buckets.has(key)) buckets.set(key, { key, label: labelOf(asset), assets: [] });
    buckets.get(key).assets.push(asset);
  }

  const groups = [...buckets.values()].map((b) => ({
    key: b.key,
    label: b.label,
    assets: b.assets.length,
    firstPass: mean(b.assets.map((a) => a.firstPass)),
    total: mean(b.assets.map((a) => a.total)),
    manHours: Math.round(b.assets.reduce((s, a) => s + Number(a.manHours || 0), 0) * 10) / 10,
    timeSpentHours: Math.round((b.assets.reduce((s, a) => s + Number(a.totalSeconds || 0), 0) / HOUR) * 10) / 10,
    /* How many of these assets passed through more than one pair of hands.
       A By User row covers work the named person may not have done all of, and
       a reader deserves to know that rather than infer it. */
    handedOver: b.assets.filter((a) => Number(a.contributors || 1) > 1).length,
  }));

  // Worst first: the point of the report is to find where estimates are wrong,
  // and nulls last because "unknown" is not a finding.
  groups.sort((a, b) => {
    if (a.total === null) return 1;
    if (b.total === null) return -1;
    return a.total - b.total;
  });
  return { groups, ungrouped };
}

/* The date an asset counts as finished, for the trend.
 *
 * Delivery if it got there, otherwise the last submission — "at least
 * submitted" is the bar for being in this report at all, so that is the moment
 * the work landed. */
function periodKey(row, grain) {
  const when = row.finishedAt ? new Date(row.finishedAt) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  const y = when.getUTCFullYear();
  if (grain === 'month') return `${y}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
  // ISO week, so a week is the same seven days for everybody regardless of
  // where the reader is.
  const d = new Date(Date.UTC(y, when.getUTCMonth(), when.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function trend(assets, grain = 'week') {
  const { groups } = groupBy(assets, (a) => periodKey(a, grain), (a) => periodKey(a, grain));
  // Chronological here, not worst-first: a trend read out of order is not a
  // trend.
  return groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/* Everything the Reports tab draws, from one set of rows. */
function build(rows, { grain = 'week' } = {}) {
  const { included, excluded } = prepare(rows);

  const by = (keyOf, labelOf) => groupBy(included, keyOf, labelOf);

  return {
    summary: {
      assets: included.length,
      excluded: excluded.length,
      firstPass: mean(included.map((a) => a.firstPass)),
      total: mean(included.map((a) => a.total)),
      manHours: Math.round(included.reduce((s, a) => s + Number(a.manHours || 0), 0) * 10) / 10,
      timeSpentHours: Math.round((included.reduce((s, a) => s + Number(a.totalSeconds || 0), 0) / HOUR) * 10) / 10,
    },
    byUser: by((a) => a.assigneeId, (a) => a.assigneeName || 'Unassigned'),
    byCategory: by((a) => a.category, (a) => a.categoryLabel || a.category),
    byScope: by((a) => a.type, (a) => a.typeLabel || a.type),
    byProject: by((a) => a.projectId, (a) => a.projectName),
    byClient: by((a) => a.clientId, (a) => a.clientName),
    trend: trend(included, grain),
    assets: included.map((a) => ({
      id: a.id, code: a.code, name: a.name,
      assignee: a.assigneeName, category: a.categoryLabel || a.category,
      scope: a.typeLabel || a.type, project: a.projectName, client: a.clientName,
      manHours: Number(a.manHours),
      firstPassHours: Math.round((Number(a.firstPassSeconds) / HOUR) * 100) / 100,
      totalHours: Math.round((Number(a.totalSeconds) / HOUR) * 100) / 100,
      firstPass: a.firstPass, total: a.total,
      rounds: Number(a.rounds || 1), contributors: Number(a.contributors || 1),
      delivered: Boolean(a.delivered), finishedAt: a.finishedAt,
    })),
    excluded,
  };
}

module.exports = {
  HOUR,
  efficiencyOf,
  exclusionReason,
  prepare,
  mean,
  groupBy,
  periodKey,
  trend,
  build,
};
