/* Hours, and what they cost.
 *
 * EVERY FIGURE HERE IS HAND-CHECKED. The arithmetic is written in the comment
 * beside each case and the assertions quote those numbers rather than asking
 * the code what it thinks — a costing tested against itself agrees with itself
 * perfectly and is wrong in the one way that costs somebody money.
 *
 * The four things worth breaking:
 *
 *   an unpriced hour is NOT free        A designation with no rate contributes
 *                                       hours and no cost, and the hours are
 *                                       REPORTED. Costing them at zero would
 *                                       understate what a project cost, which
 *                                       is the direction that turns a loss into
 *                                       an apparent profit.
 *
 *   delivered is a FILTER, not a tally   Nothing increments when a task is
 *                                       delivered; the figure is derived from
 *                                       each asset's current state every read.
 *
 *   the breakdown adds up                Per-role costs sum to the total, or
 *                                       the table beneath the card is fiction.
 *
 *   bid hours come from the ASSETS       Not from a second budget field that
 *                                       could disagree with the Projects tab.
 */
const test = require('node:test');
const assert = require('node:assert');
const pnlHours = require('../src/pnl-hours');
const workflow = require('../src/asset-workflow');

// --- the costing, with no database at all -------------------------------------

test('hours are priced at the rate of the person\'s designation', () => {
  /* Ana  game_artist 10h at 500 = 5,000
     Bo   game_artist  6h at 500 = 3,000   -> the role totals 16h and 8,000
     Cy   team_lead     4h at 900 = 3,600
     Total 11,600 over 20 priced hours. */
  const rates = new Map([['game_artist', 500], ['team_lead', 900]]);
  const r = pnlHours.priceHours([
    { userId: 'a', userName: 'Ana', roleKey: 'game_artist', hours: 10 },
    { userId: 'b', userName: 'Bo', roleKey: 'game_artist', hours: 6 },
    { userId: 'c', userName: 'Cy', roleKey: 'team_lead', hours: 4 },
  ], rates);

  assert.strictEqual(r.cost, 11600);
  assert.strictEqual(r.pricedHours, 20);
  assert.strictEqual(r.unpricedHours, 0);

  const artist = r.byRole.find((b) => b.roleKey === 'game_artist');
  assert.strictEqual(artist.hours, 16);
  assert.strictEqual(artist.cost, 8000);
  assert.deepStrictEqual(artist.people.sort(), ['Ana', 'Bo'], 'and it says who');
});

test('an unpriced designation costs nothing and is reported, not hidden', () => {
  /* THE ONE THAT MATTERS. Di is a producer, and no producer rate is set.
     Her 5 hours are real. Costing them at zero would say this project cost
     5,000 when nobody knows what it cost. */
  const rates = new Map([['game_artist', 500]]);
  const r = pnlHours.priceHours([
    { userId: 'a', userName: 'Ana', roleKey: 'game_artist', hours: 10 },
    { userId: 'd', userName: 'Di', roleKey: 'producer', hours: 5 },
  ], rates);

  assert.strictEqual(r.cost, 5000, 'only the hours that could be priced');
  assert.strictEqual(r.pricedHours, 10);
  assert.strictEqual(r.unpricedHours, 5, 'and the rest is declared');

  const producer = r.byRole.find((b) => b.roleKey === 'producer');
  assert.strictEqual(producer.priced, false);
  assert.strictEqual(producer.ratePerHour, null, 'null, not 0 — nobody set it');
  assert.strictEqual(producer.cost, 0);
  assert.strictEqual(producer.hours, 5, 'the hours are still counted as hours');
});

test('somebody with no designation at all is unpriced too, not dropped', () => {
  const r = pnlHours.priceHours(
    [{ userId: 'x', userName: 'Ghost', roleKey: null, hours: 3 }], new Map());
  assert.strictEqual(r.cost, 0);
  assert.strictEqual(r.unpricedHours, 3);
  assert.strictEqual(r.byRole[0].roleLabel, 'No designation');
});

test('the breakdown adds up to the cost above it', () => {
  const rates = new Map([['game_artist', 500], ['team_lead', 900], ['game_animator', 640]]);
  const people = [
    { userId: '1', userName: 'A', roleKey: 'game_artist', hours: 12.5 },
    { userId: '2', userName: 'B', roleKey: 'team_lead', hours: 3.25 },
    { userId: '3', userName: 'C', roleKey: 'game_animator', hours: 7 },
    { userId: '4', userName: 'D', roleKey: 'nobody_priced_this', hours: 9 },
  ];
  const r = pnlHours.priceHours(people, rates);
  /* 12.5 x 500 = 6,250; 3.25 x 900 = 2,925; 7 x 640 = 4,480 -> 13,655 */
  assert.strictEqual(r.cost, 13655);
  assert.strictEqual(r.byRole.reduce((t, b) => t + b.cost, 0), r.cost,
    'drop a row and this fails');
  assert.strictEqual(r.byRole.reduce((t, b) => t + b.hours, 0),
    r.pricedHours + r.unpricedHours, 'and every hour appears exactly once');
});

test('seconds become hours to two places', () => {
  assert.strictEqual(pnlHours.toHours(3600), 1);
  assert.strictEqual(pnlHours.toHours(5400), 1.5);
  assert.strictEqual(pnlHours.toHours(0), 0);
  // 1h 23m 20s = 5,000s = 1.39h to two places.
  assert.strictEqual(pnlHours.toHours(5000), 1.39);
});

test('the delivered state this module filters on is a real workflow state', () => {
  /* Stated as a test as well as a require-time throw: renaming the state in the
     workflow must not leave this summing a state that no longer exists, which
     would quietly report every project as having delivered nothing. */
  assert.ok(workflow.STATE_IDS.includes(pnlHours.DELIVERED));
  assert.strictEqual(pnlHours.DELIVERED, 'delivered');
  assert.strictEqual(workflow.label('delivered'), 'Delivered');
});
