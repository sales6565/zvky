/* THE ONE PLACE AN EFFICIENCY PERCENTAGE IS WORKED OUT.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS: THE 72,431.8% REPORT.
 *
 * The owner filtered Work Efficiency to one assignee and got this:
 *
 *     26 assets · Man Hours 143.6 · Time Spent 112.3 h · Total efficiency 72431.8%
 *
 * 143.6 / 112.3 x 100 is 127.9. The report said 72431.8 because it did not
 * divide those two numbers at all: it worked out a percentage PER ASSET and
 * took the mean of them. One asset estimated at about 5.22 hours with one
 * second of recorded time scores 1,880,000% on its own, and a mean over 26
 * assets carries roughly 72,300 of that straight into the headline. The two
 * hour totals beside it were honest sums the whole time, which is what made the
 * figure impossible to sanity-check by eye — the operands were right there and
 * did not produce the result.
 *
 * The old mean had a reasoned defence ("one big asset should not speak for
 * somebody's whole quarter; each asset is one observation"), and as a statement
 * about typical assets that is a fair thing to want. It is not what the screen
 * says. The screen says "Man Hours estimated / Time Spent", shows both totals,
 * and labels the result a percentage of them — so that is what it must be, and
 * an average of ratios is not a ratio of averages.
 *
 * ===========================================================================
 * THE RULE, AND IT IS THE SAME RULE EVERYWHERE.
 *
 *     efficiency % = sum(man hours of the counted assets)
 *                  / sum(time spent on those same assets) x 100
 *
 * SUMS FIRST, DIVISION ONCE, ROUNDING LAST. Rounding each asset before adding
 * it up gives a different answer, and the difference grows with the number of
 * assets — so every figure here is computed from unrounded sums and rounded
 * only by display().
 *
 * THE SAME SET OF ASSETS ON BOTH SIDES. Whatever is left out of the numerator
 * is left out of the denominator. That is what makes the promise the screen now
 * makes keepable: the Man Hours and Time Spent shown ON a row are exactly the
 * two numbers that produced that row's percentage, so a reader can check it.
 * aggregate() returns all three together for precisely that reason — a caller
 * cannot take the percentage from here and the totals from somewhere else.
 *
 * HOURS, BOTH SIDES. Estimates are stored in hours and time in seconds, and
 * every conversion goes through hoursFromSeconds() below. One place, so a
 * factor of 3600 cannot go missing in one view and not another.
 */

// Seconds in an hour. The only unit constant in the efficiency path.
const HOUR = 3600;

/* THE ONE CONVERSION. Nothing else in the efficiency path divides by 3600. */
function hoursFromSeconds(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) ? n / HOUR : 0;
}

/* A POSITIVE, FINITE QUANTITY, or null.
 *
 * Both operands have to clear this bar for an asset to have an efficiency at
 * all: no estimate and no recorded time are different gaps, but neither can be
 * divided with. Returning null rather than 0 or 100 keeps the asset out of the
 * sums instead of dragging them somewhere arbitrary. */
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* AN ASSET WITH ALMOST NO RECORDED TIME IS STILL REAL, AND STILL SUSPICIOUS.
 *
 * Under the old mean, an asset like this WAS the report — a few seconds against
 * a real estimate produced a percentage in the millions and the mean did the
 * rest. Summing first makes it harmless to the headline: 5 hours of estimate
 * against one second adds 5 to one sum and 0.0003 to the other, which moves
 * nothing.
 *
 * It is still worth finding. A timer started and stopped by accident, or a
 * session the database lost, is bad data and the owner is the only person who
 * can say which. So the asset stays IN the figures, where it belongs, and is
 * marked in the Every Asset tab so it can be looked at. A threshold rather than
 * a judgement: six minutes is short enough that no real round of work fits in
 * it and long enough not to flag a genuinely quick fix. */
const TINY_HOURS = 0.1;

const tinyTime = (hours) => {
  const n = Number(hours);
  return Number.isFinite(n) && n > 0 && n < TINY_HOURS;
};

/* WHY AN ASSET HAS NO EFFICIENCY. The strings people read in the Excluded list.
 *
 * Held here rather than beside each test so the report, the exports and the
 * tests all name a gap the same way. src/reports.js adds two reasons of its own
 * that are about the asset's HISTORY rather than its arithmetic (outsourced,
 * never submitted) and are decided before these. */
const NO_ESTIMATE = 'no Man Hours estimate';
const NO_TIME = 'no time recorded';

/* ONE ITEM'S CONTRIBUTION, or null if it cannot be counted.
 *
 * `manHours` and `hours` are both HOURS and both already carry whatever share
 * of the asset belongs to this row — see shareOf() below. */
function countable(manHours, hours) {
  const man = positive(manHours);
  if (man === null) return { ok: false, reason: NO_ESTIMATE };
  const spent = positive(hours);
  if (spent === null) return { ok: false, reason: NO_TIME };
  return { ok: true, manHours: man, hours: spent };
}

/* THE WHOLE OF THE CALCULATION.
 *
 * Takes items of { manHours, hours } — hours on both sides, shares already
 * applied — and returns the two sums and the percentage they produce, all
 * unrounded, plus how many items went in and which were left out and why.
 *
 * EMPTY IS null, NOT NaN, NOT Infinity, NOT 0. A group with nothing countable
 * in it has no efficiency, and every screen renders null as an em dash. 0/0 and
 * x/0 cannot arise because countable() refuses a non-positive denominator
 * before it reaches the division. */
function aggregate(items) {
  let manHours = 0;
  let hours = 0;
  let counted = 0;
  const excluded = [];
  for (const item of items || []) {
    const verdict = countable(item && item.manHours, item && item.hours);
    if (!verdict.ok) {
      excluded.push({ item, reason: verdict.reason });
      continue;
    }
    manHours += verdict.manHours;
    hours += verdict.hours;
    counted += 1;
  }
  return {
    manHours,
    hours,
    counted,
    excluded,
    percent: counted && hours > 0 ? (manHours / hours) * 100 : null,
  };
}

/* ROUNDING, AND THE ONLY PLACE IT HAPPENS.
 *
 * One decimal for a percentage — more is noise — and one for the hour totals
 * shown beside it, which is what the screen has always shown. The percentage is
 * rounded from the unrounded sums, so round(man)/round(time) can differ from
 * the displayed percentage in the last digit; the identity the tests assert is
 * the one a reader can perform, round(round(man) / round(time) x 100, 1), and
 * displayed() below gives the three numbers together so that holds. */
const round1 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? null : Math.round(Number(v) * 10) / 10);

const display = (v) => round1(v);

/* THE THREE NUMBERS A ROW SHOWS, derived from one aggregate so they cannot
 * disagree. `percent` is computed from the ROUNDED hour totals, which is the
 * division a reader does with the two numbers in front of them — the whole
 * point of the promise this report now makes. The unrounded percentage is kept
 * as `exact` for anything that needs to compare or sort. */
function displayed(agg) {
  const manHours = round1(agg.manHours);
  const hours = round1(agg.hours);
  return {
    manHours,
    hours,
    exact: agg.percent,
    percent: agg.counted && hours > 0 ? round1((manHours / hours) * 100) : null,
    counted: agg.counted,
  };
}

/* ONE USER'S SHARE OF ONE ASSET, as a fraction between 0 and 1.
 *
 * THE SHARE IS THE TIME THEY RECORDED. An asset two people worked on is not
 * half each — it is whatever the clock says — and that is the only split in
 * this data that is measured rather than assumed.
 *
 * THE SAME FRACTION GOES ON BOTH SIDES, which is the point. Applied to time it
 * returns exactly that person's own seconds; applied to the estimate it gives
 * them the part of it their work accounts for. So the per-user rows of a shared
 * asset add back up to the asset: sum of shares is 1, so sum of man hours is
 * the asset's man hours and sum of time is the asset's time.
 *
 * Before this, By User attributed the WHOLE asset — every contributor's hours —
 * to whoever happened to hold it now. That is how a one-person filter showed
 * 112.3 hours with 14 of its 26 assets marked Shared.
 *
 * A zero-time asset has no shares to give out; the caller excludes it anyway
 * for having no time recorded. */
function shareOf(userSeconds, totalSeconds) {
  const total = positive(totalSeconds);
  if (total === null) return 0;
  const mine = Number(userSeconds);
  if (!Number.isFinite(mine) || mine <= 0) return 0;
  return Math.min(mine / total, 1);
}

module.exports = {
  HOUR,
  TINY_HOURS,
  NO_ESTIMATE,
  NO_TIME,
  hoursFromSeconds,
  positive,
  tinyTime,
  countable,
  aggregate,
  display,
  displayed,
  round1,
  shareOf,
};
