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

/* THE ARITHMETIC IS NOT HERE. src/efficiency.js owns every sum, every
 * division and the one conversion from seconds to hours, and this module
 * shapes rows for it and groups the answers.
 *
 * It was here, and it was wrong: a percentage per asset and then the MEAN of
 * those percentages. See the note at the top of that module for the 72,431.8%
 * report that found it. */
const efficiency = require('./efficiency');

// Re-exported so the callers that had it from here keep working.
const HOUR = efficiency.HOUR;

/* One asset's efficiency, or null where it cannot honestly be given.
 *
 * Returning null rather than 0 or 100 is the whole point: an asset with no
 * estimate has no efficiency, and an asset with no tracked time would divide by
 * zero. Both are excluded from averages rather than dragging them somewhere
 * arbitrary. The caller is told which, so the report can say how many assets it
 * left out and why instead of quietly reporting on a subset.
 */
function efficiencyOf(manHours, seconds) {
  /* ONE ASSET IS AN AGGREGATE OF ONE. Written this way rather than as its own
     division so there is literally one expression in the codebase that turns a
     pair of hours into a percentage — a second copy here is how the per-asset
     figure and the group figure would come to disagree about rounding, about
     zero, or about which way up the division goes. */
  return efficiency.aggregate([
    { manHours, hours: efficiency.hoursFromSeconds(seconds) },
  ]).percent;
}

/* Why an asset is not in the report. One reason per asset, in the order a
 * person would ask about them. */
function exclusionReason(row) {
  /* OUTSOURCED WORK IS NAMED FIRST, and it is the only one of these that is not
   * a gap in the record.
   *
   * It was already excluded, and correctly: a freelancer has no login and no
   * work session, so totalSeconds is nought and `rounds` is nought — the
   * delivery writes no asset_versions row — and either of the clauses below
   * would have caught it. What it was excluded AS was "never submitted", which
   * reads as somebody having forgotten to hand the work in. The work was handed
   * in; there is simply no measured time to be efficient with, because the
   * studio does not run its clock on somebody it does not employ.
   *
   * So the reason says so. The asset still never reaches the averages or the
   * two hour totals — which is what matters, and is what stops an outsourced
   * estimate sitting in the Man Hours column against nought hours spent — and
   * the Excluded list now explains itself. */
  if (row.outsourced) return 'outsourced \u2014 no tracked time';
  if (!row.submitted) return 'never submitted';
  /* THE TWO ARITHMETIC GAPS COME FROM src/efficiency.js, which is also what
     decides them inside the sums — so "excluded, and here is why" and "not
     counted" can never be two different judgements. */
  const verdict = efficiency.countable(row.manHours,
    efficiency.hoursFromSeconds(row.totalSeconds));
  return verdict.ok ? null : verdict.reason;
}

// Round to one decimal, from src/efficiency.js so the whole report rounds once
// and the same way.
const pct = efficiency.display;

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
      // Carried through from the query as a boolean, so every consumer below
      // can count it without knowing it arrived from MySQL as 1 or 0.
      skippedCd: Boolean(Number(row.skippedCd)),
      firstPass: pct(efficiencyOf(row.manHours, row.firstPassSeconds)),
      total: pct(efficiencyOf(row.manHours, row.totalSeconds)),
      /* ALMOST NO TIME RECORDED, AND STILL COUNTED. Under the mean this was the
         report — an asset with seconds against a real estimate scored in the
         millions and carried the headline with it. Summing first makes it
         harmless to the figures and leaves it worth finding, because a timer
         started and stopped by accident is bad data and only the owner can say
         which. So it stays in the sums and wears a chip in Every Asset. */
      tinyTime: efficiency.tinyTime(efficiency.hoursFromSeconds(row.totalSeconds)),
    });
  }
  return { included, excluded };
}

/* ONE SET OF ASSETS, TWO SUMS, ONE PERCENTAGE — the figures any row shows.
 *
 * THIS REPLACED A MEAN OF PER-ASSET PERCENTAGES, which is the bug that produced
 * a 72,431.8% headline beside totals of 143.6 and 112.3 hours. The mean had a
 * defence written beside it — "one big asset should not speak for somebody's
 * whole quarter; each asset is one observation" — and as a statement about
 * typical assets it is a fair thing to want. It is not what the screen says.
 * The screen names the two totals and calls the percentage theirs, so it has to
 * be theirs, and the mean of a set of ratios is not the ratio of their sums.
 *
 * `which` picks the pair of hours: total time, or first-pass time. First pass
 * counts ONLY the assets that have a first-pass time, on both sides — an asset
 * whose first round predates time recording has no first-pass figure to be in.
 */
function figures(assets, which = 'total') {
  const hoursOf = (a) => efficiency.hoursFromSeconds(
    which === 'firstPass' ? a.firstPassSeconds : a.totalSeconds);
  return efficiency.displayed(efficiency.aggregate(
    assets.map((a) => ({ manHours: a.manHours, hours: hoursOf(a) }))));
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

  const groups = [...buckets.values()].map((b) => {
    /* THE ROW'S OWN TWO SUMS, and the percentage is theirs. manHours and
       timeSpentHours are no longer computed separately from the percentage:
       they ARE its operands, which is what lets a reader divide the two numbers
       in front of them and get the third. */
    const totals = figures(b.assets, 'total');
    const first = figures(b.assets, 'firstPass');
    return {
    key: b.key,
    label: b.label,
    assets: b.assets.length,
    firstPass: first.percent,
    total: totals.percent,
    /* The first-pass pair travels too, so the tooltip on that cell shows the
       numbers that produced IT rather than the total's. */
    firstPassManHours: first.manHours,
    firstPassHours: first.hours,
    firstPassAssets: first.counted,
    manHours: totals.manHours,
    timeSpentHours: totals.hours,
    countedAssets: totals.counted,
    /* How many of these assets passed through more than one pair of hands.
       A By User row covers work the named person may not have done all of, and
       a reader deserves to know that rather than infer it. */
    handedOver: b.assets.filter((a) => Number(a.contributors || 1) > 1).length,
    /* How many went to the client without the Creative Director seeing them.
       A count rather than a share, because the group's asset count is in the
       next column along and a reader can do that division themselves — while a
       percentage of three assets would read as a trend. */
    skippedCd: b.assets.filter((a) => a.skippedCd).length,
    };
  });

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

/* ONE ROW PER (ASSET, PERSON), for the By User breakdown.
 *
 * ===========================================================================
 * WHAT WAS WRONG. By User grouped each asset by its CURRENT assignee and gave
 * that person the whole of it — every contributor's recorded time, and the
 * whole estimate. The owner's one-person filter therefore reported 112.3 hours
 * of Time Spent with 14 of its 26 assets marked Shared: much of that time was
 * other people's, sitting under one name because that name holds the asset now.
 *
 * WHAT IT DOES INSTEAD. Each person gets the fraction of the asset their own
 * recorded time accounts for, and THE SAME FRACTION GOES ON BOTH SIDES — so the
 * per-user rows of a shared asset add back up to the asset exactly, on man
 * hours and on time alike. The share is measured, not assumed: it is the clock,
 * which is the only split in this data that is not somebody's guess.
 *
 * Time is not multiplied by the share but taken directly, because share x total
 * IS that person's seconds — written out that way so the two can never drift
 * apart through rounding.
 *
 * WITH NO CONTRIBUTION DATA this falls back to what it always did: the whole
 * asset against its current assignee. A caller that cannot supply the
 * breakdown (an older route, a test) therefore still gets a By User tab, and an
 * asset whose time predates per-user recording is not silently dropped. */
function perUser(assets, contributions) {
  if (!contributions || !contributions.length) {
    return assets.map((a) => ({ ...a, userShare: 1 }));
  }
  const byAsset = new Map();
  for (const c of contributions) {
    if (!byAsset.has(c.assetId)) byAsset.set(c.assetId, []);
    byAsset.get(c.assetId).push(c);
  }
  const out = [];
  for (const asset of assets) {
    const mine = byAsset.get(asset.id) || [];
    if (!mine.length) {
      // No per-user rows for it: keep the old attribution rather than lose it.
      out.push({ ...asset, userShare: 1 });
      continue;
    }
    for (const c of mine) {
      const share = efficiency.shareOf(c.seconds, asset.totalSeconds);
      if (share <= 0) continue;
      out.push({
        ...asset,
        assigneeId: c.userId,
        assigneeName: c.userName || asset.assigneeName,
        userShare: share,
        manHours: Number(asset.manHours) * share,
        totalSeconds: Number(c.seconds),
        firstPassSeconds: Number(c.firstPassSeconds || 0),
      });
    }
  }
  return out;
}

/* Everything the Reports tab draws, from one set of rows. */
function build(rows, { grain = 'week', contributions = null } = {}) {
  const { included, excluded } = prepare(rows);

  const by = (keyOf, labelOf) => groupBy(included, keyOf, labelOf);

  /* THE KPI STRIP'S OWN FIGURES, from the same function every row uses. The
     headline is not a different calculation from the rows beneath it — it is
     the same one over every included asset. */
  const totals = figures(included, 'total');
  const first = figures(included, 'firstPass');

  return {
    summary: {
      assets: included.length,
      excluded: excluded.length,
      firstPass: first.percent,
      total: totals.percent,
      firstPassManHours: first.manHours,
      firstPassHours: first.hours,
      firstPassAssets: first.counted,
      manHours: totals.manHours,
      timeSpentHours: totals.hours,
      countedAssets: totals.counted,
      /* The headline answer to "how often does a lead skip the CD gate".
       *
       * Scoped to the assets in this report, like every other number here —
       * which is NOT the same as the studio-wide count. An asset sent to the
       * client but carrying no Man Hours estimate is excluded from this report
       * entirely (see exclusionReason), so it is absent from this figure too.
       * The screen and the exports say so rather than letting the number be
       * read as a total. */
      skippedCd: included.filter((a) => a.skippedCd).length,
    },
    /* THE ONE BREAKDOWN BUILT FROM PER-PERSON ROWS rather than from whole
       assets — see perUser(). Every other grouping is about the WORK, so the
       asset belongs whole to its category, its project and its client. */
    byUser: groupBy(perUser(included, contributions),
      (a) => a.assigneeId, (a) => a.assigneeName || 'Unassigned'),
    byCategory: by((a) => a.category, (a) => a.categoryLabel || a.category),
    byScope: by((a) => a.type, (a) => a.typeLabel || a.type),
    byProject: by((a) => a.projectId, (a) => a.projectName),
    byClient: by((a) => a.clientId, (a) => a.clientName),
    trend: trend(included, grain),
    assets: included.map((a) => {
      /* THE ROW'S PERCENTAGES ARE WORKED OUT FROM THE HOURS THE ROW SHOWS.
       *
       * Every other view in this report promises that the two numbers on the
       * row, divided, give the third — and a reader checking the Every Asset
       * tab is doing exactly what a reader checking a group row does. So the
       * operands are rounded first HERE, and only here, and the percentage is
       * theirs. Computing it from the raw seconds instead left the last digit
       * disagreeing with the division a person would actually perform.
       *
       * Two decimals on the hours because a single asset's time is often
       * minutes, and one decimal would round a 20-minute round to 0.3. */
      const manHours = efficiency.round1(a.manHours);
      const round2 = (v) => Math.round(v * 100) / 100;
      const firstPassHours = round2(efficiency.hoursFromSeconds(a.firstPassSeconds));
      const totalHours = round2(efficiency.hoursFromSeconds(a.totalSeconds));
      return {
      id: a.id, code: a.code, name: a.name,
      assignee: a.assigneeName, category: a.categoryLabel || a.category,
      scope: a.typeLabel || a.type, project: a.projectName, client: a.clientName,
      manHours,
      firstPassHours,
      totalHours,
      firstPass: pct(efficiency.aggregate([{ manHours, hours: firstPassHours }]).percent),
      total: pct(efficiency.aggregate([{ manHours, hours: totalHours }]).percent),
      rounds: Number(a.rounds || 1), contributors: Number(a.contributors || 1),
      /* Whether this one skipped the Creative Director. Comes from the event
         rather than the status — both routes to Approved for Client end in the
         same state, so the status cannot tell them apart. */
      skippedCd: Boolean(Number(a.skippedCd)),
      tinyTime: Boolean(a.tinyTime),
      delivered: Boolean(a.delivered), finishedAt: a.finishedAt,
      };
    }),
    excluded,
  };
}

module.exports = {
  HOUR,
  // From src/efficiency.js, re-exported so a consumer of this module does not
  // need to know which of the two holds the constant.
  TINY_HOURS: efficiency.TINY_HOURS,
  efficiencyOf,
  exclusionReason,
  prepare,
  figures,
  perUser,
  groupBy,
  periodKey,
  trend,
  build,
};
