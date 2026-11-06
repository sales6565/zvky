/* PROMPT 67 PART A: ONE WAY TO WORK OUT AN EFFICIENCY, AND IT IS A RATIO.
 *
 * ===========================================================================
 * THE REPORT THAT STARTED IT. Work Efficiency, filtered to one assignee:
 *
 *     26 assets · Man Hours 143.6 · Time Spent 112.3 h · Total efficiency 72431.8%
 *
 * 143.6 / 112.3 x 100 is 127.9. The report said 72431.8 because it never
 * divided those two numbers: it worked out a percentage per asset and took the
 * MEAN. One asset estimated at about 5.22 hours with one second recorded
 * against it scores 1,880,000% on its own, and a mean over 26 assets carries
 * about 72,300 of that into the headline.
 *
 * WHAT THIS FILE GUARDS, beyond "the sums are right":
 *
 *   1. THE IDENTITY, EVERYWHERE. The two hour totals shown on a row are the two
 *      numbers that produced its percentage. That is the property that makes
 *      the figure checkable by eye, and it is what was missing: the operands
 *      were on screen the whole time and had nothing to do with the result. It
 *      is asserted for the KPI strip, every grouping, every trend bucket, every
 *      asset row and the spreadsheet.
 *
 *   2. ONE SET OF ASSETS ON BOTH SIDES. Numerator and denominator over
 *      different sets is the same class of bug wearing different clothes.
 *
 *   3. SHARES ON BOTH OPERANDS. A shared asset splits by the clock, and the
 *      same fraction goes on the estimate as on the time — so the per-user rows
 *      add back up to the asset.
 *
 *   4. ONE UNIT CONVERSION. Estimates are hours, time is seconds, and exactly
 *      one place divides by 3600.
 */
const test = require('node:test');
const assert = require('node:assert');

const efficiency = require('../src/efficiency');
const reports = require('../src/reports');
const exporter = require('../src/report-export');

/* ---- the calculation itself --------------------------------------------- */

test('the sums are divided once, and rounding happens last', () => {
  /* ROUNDING EACH ASSET FIRST GIVES A DIFFERENT ANSWER, and this is a case
     where it does: three assets of a third of an hour each against one hour.
     Rounded per asset to one decimal, 0.3 x 3 = 0.9 and the answer is 90%;
     summed first it is exactly 1 hour and 100%. */
  const third = 1 / 3;
  const agg = efficiency.aggregate([
    { manHours: third, hours: third },
    { manHours: third, hours: third },
    { manHours: third, hours: third },
  ]);
  assert.strictEqual(agg.counted, 3);
  assert.strictEqual(efficiency.round1(agg.manHours), 1);
  assert.strictEqual(agg.percent, 100);
  assert.notStrictEqual(efficiency.round1(agg.percent), 90);

  // The plain cases, so the direction of the division is pinned.
  assert.strictEqual(efficiency.aggregate([{ manHours: 8, hours: 8 }]).percent, 100);
  assert.strictEqual(efficiency.aggregate([{ manHours: 8, hours: 4 }]).percent, 200,
    'under the estimate reads above 100 — bigger is better');
  assert.strictEqual(efficiency.aggregate([{ manHours: 8, hours: 16 }]).percent, 50);
});

test('nothing countable gives null — never NaN, Infinity or a number', () => {
  for (const items of [[], null, undefined,
    [{ manHours: 5, hours: 0 }],
    [{ manHours: 0, hours: 5 }],
    [{ manHours: null, hours: null }],
    [{ manHours: 'nonsense', hours: 'nonsense' }],
    [{ manHours: 5, hours: -3 }],
    [{ manHours: Infinity, hours: 5 }],
    [{ manHours: 5, hours: NaN }]]) {
    const agg = efficiency.aggregate(items);
    assert.strictEqual(agg.percent, null, `${JSON.stringify(items)} has no efficiency`);
    assert.strictEqual(efficiency.displayed(agg).percent, null);
  }
  // And a zero denominator cannot arise: it is refused before the division.
  assert.strictEqual(efficiency.countable(5, 0).ok, false);
  assert.strictEqual(efficiency.countable(5, 0).reason, efficiency.NO_TIME);
  assert.strictEqual(efficiency.countable(0, 5).reason, efficiency.NO_ESTIMATE);
});

test('the numerator and the denominator are over the SAME assets', () => {
  /* An asset missing either operand is out of BOTH sums, and is reported as
     excluded with the reason. The failure this guards is the quiet one: an
     asset whose estimate is counted while its (absent) time is not would
     inflate every figure it touched and look like nothing at all. */
  const agg = efficiency.aggregate([
    { manHours: 10, hours: 5 },
    { manHours: 7, hours: 0 },      // no time
    { manHours: 0, hours: 3 },      // no estimate
    { manHours: 10, hours: 5 },
  ]);
  assert.strictEqual(agg.counted, 2);
  assert.strictEqual(agg.manHours, 20, 'the 7 estimated hours with no time are NOT in here');
  assert.strictEqual(agg.hours, 10, 'nor the 3 hours with no estimate');
  assert.strictEqual(agg.percent, 200);
  assert.deepStrictEqual(agg.excluded.map((e) => e.reason),
    [efficiency.NO_TIME, efficiency.NO_ESTIMATE]);
});

test('very large and very small values stay finite and sane', () => {
  const huge = efficiency.aggregate([{ manHours: 1e9, hours: 1e-6 }]);
  assert.ok(Number.isFinite(huge.percent), 'a huge ratio is still a number');
  const tiny = efficiency.aggregate([{ manHours: 1e-6, hours: 1e9 }]);
  assert.ok(Number.isFinite(tiny.percent) && tiny.percent > 0);
  assert.strictEqual(efficiency.displayed(tiny).percent, 0,
    'and rounds to nought rather than disappearing');
});

test('one conversion from seconds, and it is the only one', () => {
  assert.strictEqual(efficiency.hoursFromSeconds(3600), 1);
  assert.strictEqual(efficiency.hoursFromSeconds(0), 0);
  assert.strictEqual(efficiency.hoursFromSeconds(null), 0);
  assert.strictEqual(efficiency.hoursFromSeconds('nonsense'), 0);
  assert.strictEqual(efficiency.hoursFromSeconds(90 * 60), 1.5, 'minutes-based sources too');

  /* THE MIX-UP THIS PREVENTS: hours against seconds, which is a factor of 3600
     and the difference between 100% and 360000%. The rule takes hours on both
     sides, so a caller that forgot to convert is wrong by exactly that — and
     the only converter in the efficiency path is the one above. */
  assert.strictEqual(efficiency.aggregate([
    { manHours: 2, hours: efficiency.hoursFromSeconds(2 * 3600) }]).percent, 100);
  assert.strictEqual(reports.efficiencyOf(2, 2 * 3600), 100,
    'and the per-asset helper converts in that one place too');

  /* NOWHERE ELSE DIVIDES BY 3600 IN THE EFFICIENCY PATH. Asserted on the source
     because a second conversion is invisible in behaviour until the day one of
     the two is changed. */
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'efficiency.js'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.strictEqual((body.match(/3600/g) || []).length, 1,
    'the constant appears once, in HOUR');
});

/* ---- the "very little time" mark ---------------------------------------- */

test('an asset with almost no time is counted, and marked', () => {
  assert.strictEqual(efficiency.TINY_HOURS, 0.1, 'a named, documented threshold');
  assert.strictEqual(efficiency.tinyTime(efficiency.hoursFromSeconds(1)), true);
  assert.strictEqual(efficiency.tinyTime(0.05), true);
  assert.strictEqual(efficiency.tinyTime(0.1), false, 'the threshold itself is not tiny');
  assert.strictEqual(efficiency.tinyTime(0), false, 'no time at all is a different thing — it is excluded');
  assert.strictEqual(efficiency.tinyTime(null), false);

  /* AND IT IS STILL IN THE FIGURES. Being flagged is not being removed: the
     owner decides whether the data is wrong, and a report that quietly dropped
     assets would be the same class of lie as one that quietly inflated them. */
  const agg = efficiency.aggregate([
    { manHours: 10, hours: 10 },
    { manHours: 5, hours: efficiency.hoursFromSeconds(1) },
  ]);
  assert.strictEqual(agg.counted, 2);
  assert.strictEqual(efficiency.round1(agg.manHours), 15);
});

/* ---- shares ------------------------------------------------------------- */

test('a shared asset splits by the clock, and the same fraction goes on both', () => {
  assert.strictEqual(efficiency.shareOf(3 * 3600, 4 * 3600), 0.75);
  assert.strictEqual(efficiency.shareOf(0, 4 * 3600), 0, 'somebody who logged nothing gets nothing');
  assert.strictEqual(efficiency.shareOf(5, 0), 0, 'an asset with no time has no shares to give');
  assert.strictEqual(efficiency.shareOf(9999, 3600), 1, 'and a share never exceeds the whole');

  /* THE INVARIANT THE SPLIT EXISTS FOR: the per-user rows of a shared asset add
     back up to the asset, on BOTH operands. Splitting only one of them — time
     by share and the estimate in full, which is the shape the brief asks about
     — would make each person look either twice as efficient or half. */
  const asset = { id: 'a1', manHours: 10, totalSeconds: 4 * 3600, firstPassSeconds: 4 * 3600,
    assigneeId: 'u2', assigneeName: 'Bo' };
  const rows = reports.perUser([asset], [
    { assetId: 'a1', userId: 'u1', userName: 'Ana', seconds: 3 * 3600, firstPassSeconds: 3 * 3600 },
    { assetId: 'a1', userId: 'u2', userName: 'Bo', seconds: 1 * 3600, firstPassSeconds: 1 * 3600 },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.reduce((s, r) => s + r.manHours, 0), 10,
    'the per-user man hours add up to the asset\'s');
  assert.strictEqual(rows.reduce((s, r) => s + r.totalSeconds, 0), 4 * 3600,
    'and so does the time');
  // Each person's own ratio is the asset's ratio, because both sides were cut.
  for (const r of rows) {
    assert.strictEqual(
      efficiency.aggregate([{ manHours: r.manHours, hours: efficiency.hoursFromSeconds(r.totalSeconds) }]).percent,
      250, 'the share cancels out, which is what "the same fraction" means');
  }

  /* WITHOUT A BREAKDOWN, the old attribution stands rather than the asset
     vanishing from By User. */
  const fallback = reports.perUser([asset], null);
  assert.strictEqual(fallback.length, 1);
  assert.strictEqual(fallback[0].assigneeId, 'u2');
  assert.strictEqual(fallback[0].manHours, 10);
});

/* ---- the identity, in every view ---------------------------------------- */

/* The screenshot's own shape: 26 assets totalling 143.6 estimated hours and
   112.3 spent, including the asset with one second against it that carried the
   old headline, one asset with no time at all, and a shared asset. */
function screenshotRows() {
  const tiny = { manHours: 5.22, totalSeconds: 1, firstPassSeconds: 1 };
  const man = (143.6 - tiny.manHours) / 25;
  const sec = ((112.3 * 3600) - 1) / 25;
  const rows = [];
  for (let i = 0; i < 25; i += 1) {
    rows.push({
      id: `a${i}`, code: `A-${i}`, name: `Asset ${i}`, submitted: true,
      manHours: man, totalSeconds: sec, firstPassSeconds: sec * 0.95,
      assigneeId: 'u1', assigneeName: 'Aadhil',
      category: i % 2 ? 'chr' : 'env', categoryLabel: i % 2 ? 'Character' : 'Environment',
      type: i % 3 ? 'character' : 'animation', typeLabel: i % 3 ? 'Character' : 'Animation',
      projectId: 'p1', projectName: 'Hero Quest', clientId: 'c1', clientName: 'Acme',
      rounds: 1, contributors: i < 14 ? 2 : 1, skippedCd: 0,
      finishedAt: `2026-0${(i % 3) + 1}-1${i % 9}T10:00:00Z`,
    });
  }
  rows.push({ id: 'tiny', code: 'TINY', name: 'One second', submitted: true,
    assigneeId: 'u1', assigneeName: 'Aadhil', category: 'chr', categoryLabel: 'Character',
    type: 'character', typeLabel: 'Character', projectId: 'p1', projectName: 'Hero Quest',
    clientId: 'c1', clientName: 'Acme', rounds: 1, contributors: 1, skippedCd: 0,
    finishedAt: '2026-02-10T10:00:00Z', ...tiny });
  return rows;
}

test('THE REGRESSION: the screenshot data gives 127.9, not 72431.8', () => {
  const report = reports.build(screenshotRows());
  assert.strictEqual(report.summary.assets, 26);
  assert.strictEqual(report.summary.manHours, 143.6);
  assert.strictEqual(report.summary.timeSpentHours, 112.3);
  assert.strictEqual(report.summary.total, 127.9, 'the owner\'s own arithmetic');
  assert.ok(report.summary.total < 1000, `and nothing in the thousands: ${report.summary.total}`);
  assert.ok(report.summary.firstPass < 1000, `nor on the first pass: ${report.summary.firstPass}`);
});

test('a zero-time asset is excluded, counted, and given its reason', () => {
  const rows = screenshotRows();
  rows.push({ id: 'none', code: 'NONE', name: 'No time at all', submitted: true,
    manHours: 9, totalSeconds: 0, firstPassSeconds: 0,
    assigneeId: 'u1', assigneeName: 'Aadhil', projectId: 'p1', projectName: 'Hero Quest',
    rounds: 1, contributors: 1, skippedCd: 0 });
  const report = reports.build(rows);

  assert.strictEqual(report.summary.assets, 26, 'it is not among the assets reported on');
  assert.strictEqual(report.summary.excluded, 1);
  assert.strictEqual(report.excluded[0].name, 'No time at all');
  assert.strictEqual(report.excluded[0].reason, efficiency.NO_TIME);
  assert.strictEqual(report.summary.manHours, 143.6,
    'and its 9 estimated hours are NOT in the numerator');
  assert.strictEqual(report.summary.total, 127.9);
});

test('every view divides the two numbers it displays', () => {
  const report = reports.build(screenshotRows(), { grain: 'month' });
  const check = (where, man, hours, percent) => {
    if (percent === null) return;
    assert.strictEqual(Math.round((man / hours) * 100 * 10) / 10, percent,
      `${where}: ${man} / ${hours} x 100 should be ${percent}`);
  };

  // The KPI strip, both percentages.
  check('KPI total', report.summary.manHours, report.summary.timeSpentHours, report.summary.total);
  check('KPI first pass', report.summary.firstPassManHours, report.summary.firstPassHours,
    report.summary.firstPass);

  // Every grouping, and every bucket of the trend.
  for (const view of ['byUser', 'byCategory', 'byScope', 'byProject', 'byClient']) {
    assert.ok(report[view].groups.length, `${view} has rows to check`);
    for (const g of report[view].groups) {
      check(`${view}/${g.label} total`, g.manHours, g.timeSpentHours, g.total);
      check(`${view}/${g.label} first pass`, g.firstPassManHours, g.firstPassHours, g.firstPass);
    }
  }
  assert.ok(report.trend.length, 'the trend has buckets to check');
  for (const b of report.trend) {
    check(`trend/${b.key} total`, b.manHours, b.timeSpentHours, b.total);
    check(`trend/${b.key} first pass`, b.firstPassManHours, b.firstPassHours, b.firstPass);
  }

  // Every Asset: the row's own hours are the row's own percentage's operands.
  for (const a of report.assets) {
    check(`asset/${a.code} total`, a.manHours, a.totalHours, a.total);
    check(`asset/${a.code} first pass`, a.manHours, a.firstPassHours, a.firstPass);
  }

  /* AND THE SPREADSHEET SHOWS THE SAME THREE NUMBERS. The Excel is built from
     the same group objects, so this is really a check that it carries the
     first-pass operands too — without them a reader dividing the only hours on
     the row gets the wrong answer for one of the two percentages. */
  const rows = exporter.groupRows(report.byUser.groups, { withShared: true });
  for (const r of rows) {
    check('xlsx total', r['Man Hours'], r['Time Spent (h)'], r['Total %']);
    check('xlsx first pass', r['First-pass Man Hours'], r['First-pass Time (h)'], r['First-pass %']);
  }
  // And the spreadsheet agrees with the screen, row for row.
  assert.deepStrictEqual(rows.map((r) => r['Total %']),
    report.byUser.groups.map((g) => g.total));
  assert.deepStrictEqual(rows.map((r) => r['Man Hours']),
    report.byUser.groups.map((g) => g.manHours));
});

test('first pass counts only the assets that have one, and beats the total', () => {
  /* An asset whose first round predates time recording has no first-pass
     figure, and must be absent from BOTH first-pass sums rather than counted
     with a zero. */
  const rows = [
    { id: 'a', code: 'A', name: 'A', submitted: true, manHours: 10,
      totalSeconds: 10 * 3600, firstPassSeconds: 8 * 3600, rounds: 2, contributors: 1 },
    { id: 'b', code: 'B', name: 'B', submitted: true, manHours: 6,
      totalSeconds: 6 * 3600, firstPassSeconds: 0, rounds: 1, contributors: 1 },
  ];
  const report = reports.build(rows);
  assert.strictEqual(report.summary.manHours, 16);
  assert.strictEqual(report.summary.timeSpentHours, 16);
  assert.strictEqual(report.summary.total, 100);

  assert.strictEqual(report.summary.firstPassAssets, 1, 'only A has a first pass');
  assert.strictEqual(report.summary.firstPassManHours, 10, 'and only A\'s estimate is in it');
  assert.strictEqual(report.summary.firstPassHours, 8);
  assert.strictEqual(report.summary.firstPass, 125);

  /* FIRST PASS IS NEVER WORSE THAN THE TOTAL for the same assets, because the
     first pass is a subset of the time and the estimate is the same. Checked
     over the screenshot shape, where every asset has both. */
  const full = reports.build(screenshotRows());
  assert.ok(full.summary.firstPassHours <= full.summary.timeSpentHours);
  assert.ok(full.summary.firstPass >= full.summary.total,
    `${full.summary.firstPass} should be at least ${full.summary.total}`);
});

test('the page formats the server\'s numbers and works none out itself', () => {
  /* THE RULE: one implementation, on the server. The page's job is to show the
     percentage it was sent and the two numbers beside it — so the cell renderer
     takes its operands as arguments rather than finding them, and there is no
     division in it at all. */
  const fs = require('node:fs');
  const path = require('node:path');
  const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = PAGE.indexOf('function effCell(v, man, hours){');
  assert.ok(at !== -1, 'the cell renderer takes the operands it displays');
  const fn = PAGE.slice(at, PAGE.indexOf('\n}', at));
  assert.ok(!/\/\s*(hours|time|spent)/i.test(fn.replace(/title="[^"]*"/g, '')),
    `the page must not divide anything: ${fn}`);
  assert.match(fn, /title="\$\{man\}h \/ \$\{hours\}h"/,
    'and the tooltip is the division a reader would do');

  // The KPI strip carries both pairs, so both of its percentages are checkable.
  assert.match(PAGE, /title="\$\{s\.firstPassManHours\}h \/ \$\{s\.firstPassHours\}h"/);
  assert.match(PAGE, /title="\$\{s\.manHours\}h \/ \$\{s\.timeSpentHours\}h"/);
  // And every group row passes its own two numbers to its own two cells.
  assert.match(PAGE,
    /effCell\(g\.firstPass, g\.firstPassManHours, g\.firstPassHours\)\}\$\{effCell\(g\.total, g\.manHours, g\.timeSpentHours\)/);
});
