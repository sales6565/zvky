// Available, consumed and idle hours across the people who do the work.
//
// A THIRD VIEW OF THE IDLE REPORT'S NUMBERS, and deliberately not a second
// calculation of them. Every figure on this panel comes from
// routes/idle.js's buildIdleReport() — the same function the Idle Report tab,
// the spreadsheet and the PDF are all drawn from — called once per period with
// an explicit range. Nothing here does arithmetic on hours.
//
// That is the whole design, and it is worth being explicit about why:
//
//   The brief asked that a figure shown here match the same person's figure in
//   the Idle Report exactly. Two implementations of one calculation agree until
//   somebody changes one of them, and the disagreement then shows up as a
//   studio-wide capacity number that is quietly wrong. Reusing the builder
//   makes the two agree BY CONSTRUCTION rather than by coincidence, and a test
//   asserting they match is then checking the wiring rather than the maths.
//
//   CONSUMED IS COVERAGE, NOT A SUM. Time Spent is wall-clock between Accept
//   and Start and Submit for Review. Spans overlap when somebody holds three
//   assets open through one afternoon, and they run across nights and weekends
//   — summing them credits one person with 208 hours in a 40-hour week. The
//   union-of-intervals in src/idle.js is the only thing that answers "was
//   anything on this person's desk at 3pm on Tuesday", and it is already
//   written. See the header comment there before changing anything here.
//
// WHO IS COUNTED comes from the same place too: buildIdleReport picks people
// whose designation carries the `assignable` capability — the ones the studio
// gives work to. Not a list of role names, which would go stale the first time
// somebody adds a designation in Settings.

const idle = require('./idle');
const workSchedule = require('./work-schedule');

/* The three periods, all PERIOD-TO-DATE.
 *
 * "Available hours this year" for a year that is three-quarters elapsed blends
 * capacity already spent with capacity not yet reached, and the result is a
 * number nobody can act on: it looks like massive idleness every January and
 * like none at all every December. To-date is the figure a studio head can
 * compare consumed against.
 *
 * Daily is a single day and so the distinction does not arise; it is listed
 * here anyway so all three are resolved the same way. */
const PERIODS = [
  { id: 'day', label: 'Daily', describe: 'Today' },
  { id: 'month', label: 'Monthly', describe: 'This month so far' },
  { id: 'year', label: 'Annually', describe: 'This year so far' },
];

const asISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* The range each period covers, ending today.
 *
 * The start comes from idle.periodRange() rather than being computed again, so
 * "this month" begins on the same day the Idle Report's Month button begins on.
 * Only the END is moved, from the period's last day to today. */
function rangeFor(id, todayISO) {
  const full = idle.periodRange(id, todayISO);
  if (!full) return null;
  return {
    from: full.from,
    // A period-to-date never runs past today, and `day` is already today.
    to: full.to < todayISO ? full.to : todayISO,
  };
}

/* One period's figures, from the Idle Report's own builder.
 *
 * `req` is faked rather than threaded through: buildIdleReport reads exactly
 * two things off it, and constructing those two is honest about the dependency
 * where passing a real request would hide it. The query carries an explicit
 * from/to, which resolvePeriod() accepts — see src/routes/idle.js — so the
 * period-to-date range above is used as given. */
async function forPeriod(buildIdleReport, user, period, todayISO) {
  const range = rangeFor(period.id, todayISO);
  if (!range) return null;

  const report = await buildIdleReport({ user, query: { from: range.from, to: range.to } });
  const totals = report.totals;

  /* No totals means nobody in scope holds an assignable designation, or the
     caller can see no projects. Zeroes with a headcount of zero, rather than
     nulls: "0 people" is the honest reading and it is what makes the panel say
     why the figures are empty. */
  const available = totals ? totals.expectedHours : 0;
  const consumed = totals ? totals.engagedHours : 0;

  return {
    id: period.id,
    label: period.label,
    describe: period.describe,
    from: range.from,
    to: range.to,
    // The Idle Report's own words for the same three numbers.
    availableHours: available,
    consumedHours: consumed,
    idleHours: totals ? totals.idleHours : 0,
    headcount: totals ? totals.people : 0,
    workingDays: report.workingDays,
    /* Consumed over available. Null rather than 0 when a period expects
       nothing — a range that is all weekend, or a studio with nobody in it —
       because "0% utilised" would read as a week of doing nothing. */
    utilisationPercent: available > 0 ? idle.round((consumed / available) * 100) : null,
  };
}

/* All three periods, plus the caveats that make them readable.
 *
 * Returns null when the caller may not see this — the route decides that, and
 * passing null through means the key is absent from the payload rather than
 * present and empty. A panel that renders zeroes for somebody who is not
 * allowed the data has told them the studio has no capacity, which is a
 * different lie from telling them nothing.
 */
async function build(user, { buildIdleReport, now = new Date() } = {}) {
  const todayISO = asISODate(now);
  const schedule = workSchedule.current();

  const periods = [];
  for (const period of PERIODS) {
    const one = await forPeriod(buildIdleReport, user, period, todayISO);
    if (one) periods.push(one);
  }

  return {
    periods,
    schedule: { hoursPerDay: schedule.hoursPerDay, workingDayNames: schedule.workingDayNames },
    /* The honest limitations, from src/idle.js rather than rewritten. An annual
       available-hours figure that silently assumes nobody took a day off all
       year is the specific thing these sentences exist to prevent, and this
       panel is where that assumption does the most damage. */
    caveats: idle.caveats(schedule),
  };
}

module.exports = { build, forPeriod, rangeFor, PERIODS };
