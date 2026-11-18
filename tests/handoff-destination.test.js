/* WHERE A HAND-OFF GOES, as a rule rather than as a string somebody types.
 *
 * Two things are pinned here, and neither needs a database:
 *
 *   THE RULE ITSELF — that `destination` is derived from the stored `kind`, that a request
 *     naming neither still means Development, and that a typo is refused rather than
 *     silently sent somewhere.
 *
 *   THE PAGE'S COPY — public/index.html carries its own HANDOFF_DESTINATIONS so the two
 *     buttons, the modal title and the results line can be drawn without a round trip.
 *     Two copies of a rule drift; this compares them field for field.
 *
 * AND ONE THING THAT IS NOT A RULE BUT A TRAP: destination and discipline are different
 * questions with different answers, and in this repository the word `destination` is
 * ALREADY used for a discipline — external_feedback.destination holds 'art' or
 * 'animation'. The last test here asserts the two value spaces cannot overlap, so a
 * discipline handed to this module, or a destination handed to the discipline rule, can
 * never produce a plausible wrong answer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dest = require('../src/handoff-destination');
const discipline = require('../src/asset-discipline');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the two destinations, and the kind each is stored as', () => {
  assert.deepStrictEqual(dest.IDS, ['development', 'tech_art']);
  assert.deepStrictEqual(dest.KINDS, ['partial_drop', 'tech_art']);

  /* THE MAPPING THAT MAKES THIS BACKWARD COMPATIBLE WITH NO MIGRATION. Every hand-off
     already in the table has one of these two kinds, so every one of them reads back with
     the right destination — including the Tech Art hand-offs the studio has been sending
     since the feature shipped, which a NULLable new column would have reported as
     Development until somebody backfilled it. */
  assert.strictEqual(dest.destinationOf('partial_drop'), 'development');
  assert.strictEqual(dest.destinationOf('tech_art'), 'tech_art');
  assert.strictEqual(dest.kindOf('development'), 'partial_drop');
  assert.strictEqual(dest.kindOf('tech_art'), 'tech_art');
});

test('an unrecognised stored kind reads as Development, which is what it always was', () => {
  /* Not a guess: a hand-off row whose kind this build does not know is one written by an
     older or newer build, and Development is what every hand-off was before there were
     two. Answering null here would leave the serving code with no destination at all. */
  for (const odd of ['', null, undefined, 'full_drop', 'TECH-ART', 'art']) {
    assert.strictEqual(dest.destinationOf(odd), 'development', JSON.stringify(odd));
  }
});

test('a request may say destination, or the older kind, and destination wins', () => {
  assert.strictEqual(dest.resolve({ destination: 'tech_art' }).id, 'tech_art');
  assert.strictEqual(dest.resolve({ kind: 'tech_art' }).id, 'tech_art');
  assert.strictEqual(dest.resolve({ kind: 'partial_drop' }).id, 'development');

  /* BOTH GIVEN: the new field decides. They cannot disagree in anything this application
     sends — the page sets one — but a caller that sets both has named the destination
     explicitly, and the older field is the one being superseded. */
  assert.strictEqual(dest.resolve({ destination: 'development', kind: 'tech_art' }).id, 'development');

  /* NEITHER GIVEN: Development, so every request written before this change behaves
     exactly as it did. This is the backward-compatibility rule in one line. */
  assert.strictEqual(dest.resolve({}).id, 'development');
  assert.strictEqual(dest.resolve().id, 'development');

  /* Case and whitespace are forgiven; a typo is not. A misspelled destination that fell
     back to Development would send work somewhere nobody chose, which is the one outcome
     this field exists to prevent. */
  assert.strictEqual(dest.resolve({ destination: '  Tech_Art ' }).id, 'tech_art');
  assert.strictEqual(dest.resolve({ destination: 'techart' }), null);
  assert.strictEqual(dest.resolve({ destination: 'tech art' }), null);
  assert.strictEqual(dest.resolve({ kind: 'partial' }), null);
});

test('each destination names its own permission', () => {
  assert.strictEqual(dest.permissionFor('development'), 'integration.send_to_dev');
  assert.strictEqual(dest.permissionFor('tech_art'), 'integration.send_to_tech_art');
  assert.strictEqual(dest.permissionFor('nonsense'), null);
  /* Every destination has one. A destination with no key would be an action nobody can be
     stopped from taking. */
  for (const id of dest.IDS) assert.ok(dest.permissionFor(id), id);
});

test('the page draws from the same list', () => {
  /* MIRROR. public/index.html holds HANDOFF_DESTINATIONS so the buttons and the modal can
     name the destination without asking the server. Compared field for field, because the
     failure this prevents is cosmetic until it is not: a page that calls it "Tech Art" on
     the button and the event that calls it something else are how two teams end up
     describing the same hand-off differently. */
  const from = PAGE.indexOf('const HANDOFF_DESTINATIONS = {');
  assert.ok(from !== -1, 'the page carries the list');
  const to = PAGE.indexOf('};', from);
  const block = PAGE.slice(from, to);

  for (const d of dest.DESTINATIONS) {
    assert.ok(block.includes(`${d.id}:`), `the page knows ${d.id}`);
    for (const [field, value] of [['label', d.label], ['action', d.action], ['sent', d.sent]]) {
      assert.ok(block.includes(`${field}:'${value}'`) || block.includes(`${field}: '${value}'`),
        `the page's ${d.id}.${field} should be ${JSON.stringify(value)}`);
    }
    /* The describe text too: it is what the modal shows under "Going to", and a page that
       described the destination differently from the catalogue would be a third wording. */
    assert.ok(block.includes(d.describe.replace(/&/g, '&')), `the page's ${d.id}.describe`);
  }

  // And nothing else: a third destination on the page and not in the module, or the
  // reverse, is the drift this test exists to catch.
  const idsOnPage = [...block.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
  assert.deepStrictEqual(idsOnPage.sort(), [...dest.IDS].sort());
});

test('a destination is never a discipline, and a discipline is never a destination', () => {
  /* THE NAME COLLISION, PINNED. external_feedback.destination already holds 'art' or
     'animation' — the department Dev & QA addresses inbound feedback to. This module's
     destinations are 'development' and 'tech_art'. The two sets must stay disjoint so
     that handing one to the other's reader produces nothing usable rather than something
     plausible and wrong. */
  const disciplines = discipline.DISCIPLINE_IDS || ['art', 'animation'];
  for (const id of dest.IDS) {
    assert.ok(!disciplines.includes(id), `${id} is also a discipline`);
    assert.strictEqual(dest.permissionFor(id) === null, false);
  }
  for (const id of disciplines) {
    assert.strictEqual(dest.resolve({ destination: id }), null,
      `a discipline (${id}) must not resolve as a destination`);
  }

  /* And the other way: the discipline rule reads an asset's type and category and has no
     opinion about where it is going. An asset is the same discipline whichever button is
     pressed — asserted here on the rule itself, and end to end in
     tests/send-to-tech-art.test.js. */
  const animation = { type: 'animation', category: null };
  assert.strictEqual(discipline.assetDiscipline(animation), 'animation');
  assert.strictEqual(discipline.assetDiscipline({ ...animation, destination: 'development' }), 'animation');
  assert.strictEqual(discipline.assetDiscipline({ type: 'prop', destination: 'tech_art' }), 'art');
});
