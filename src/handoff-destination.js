/* WHERE A HAND-OFF IS GOING: Development, or Tech Art.
 *
 * ===========================================================================
 * THIS IS NOT A NEW FIELD. IT IS A NAME FOR ONE THAT EXISTED.
 *
 * `handoffs.kind` has held 'partial_drop' or 'tech_art' since hand-offs were
 * built, and integration.send_to_dev's own description in the permission
 * catalogue says what it is for: "Put assets into a partial drop or a Tech Art
 * hand-off, and send it." The two destinations were already structured, already
 * stored, already in the event payload.
 *
 * What was missing was the word. A reader at the far end had to know that
 * 'partial_drop' means the Development intake and that there is no third kind,
 * which is knowledge that lives in a comment in another repository. So this
 * module names it: `destination` is 'development' or 'tech_art', and it is
 * derived from `kind` rather than stored beside it.
 *
 * ===========================================================================
 * WHY DERIVED AND NOT A SECOND COLUMN.
 *
 * A `handoffs.destination` column was the obvious shape and is the wrong one.
 * Every hand-off already sent would have it NULL, and a NULL read as "the
 * default, Development" would be a LIE for every Tech Art hand-off in the
 * table — the studio has sent those since the feature shipped, and they are
 * exactly the rows whose destination matters. The alternatives were a backfill
 * (rewriting historical records, which the brief rules out) or two fields that
 * can disagree.
 *
 * Derived from `kind`, every historical row reads correctly with no migration
 * and no backfill: a 'tech_art' row from March says tech_art, and a
 * 'partial_drop' row says development. One source of truth, no new column, and
 * backward compatibility is a property of the arithmetic rather than a promise.
 *
 * ===========================================================================
 * DESTINATION IS NOT DISCIPLINE, and in this repository that is not a pedantic
 * distinction — it is a name collision waiting to be made.
 *
 * `external_feedback.destination` ALREADY EXISTS and holds 'art' or
 * 'animation': the department Dev & QA addresses a piece of feedback to, on the
 * way IN. This module's `destination` is 'development' or 'tech_art': the team a
 * hand-off is addressed to, on the way OUT. Same word, two objects, two value
 * spaces, and nothing in either name says which.
 *
 * So the values here are deliberately disjoint from the discipline values. If
 * somebody ever hands a discipline to destinationOf() or a destination to
 * assetDiscipline(), they get null or a thrown mismatch rather than a plausible
 * wrong answer, and tests/handoff-destination.test.js asserts the two sets
 * never overlap.
 *
 * An asset's discipline comes from src/asset-discipline.js and from nowhere
 * else. It is a property of the WORK — an animation is an animation whoever
 * receives it. The destination is a property of the ACT of sending, chosen by
 * whoever pressed the button. Neither is derivable from the other, which is why
 * an Animation asset can go to Development and an Art asset to Tech Art.
 */

/* The two destinations, and the `kind` each one is stored as. The keys are what
   the contract publishes; the values are what the column has always held. */
const DESTINATIONS = [
  {
    id: 'development',
    kind: 'partial_drop',
    label: 'Development',
    /* What the UI calls the act, and what the history says afterwards. Kept
       here so the button, the modal title, the history line and the event all
       come from one place. */
    action: 'Send to Dev',
    sent: 'Sent to Development',
    describe: 'Into the build, for Dev & QA to integrate and test.',
  },
  {
    id: 'tech_art',
    kind: 'tech_art',
    label: 'Tech Art',
    action: 'Send to Tech Art',
    sent: 'Sent to Tech Art',
    describe: 'To Tech Art, for a rigging, shader or pipeline pass before the build.',
  },
];

const IDS = DESTINATIONS.map((d) => d.id);
const KINDS = DESTINATIONS.map((d) => d.kind);

/* THE DEFAULT IS DEVELOPMENT, and it is the default for one reason: that is
   what every hand-off sent before this change was. A request that names no
   destination behaves exactly as it did, which is what keeps the existing
   callers — the page before this release, the test suite, anything a studio
   wired up itself — working unchanged. */
const DEFAULT_ID = 'development';

const byId = new Map(DESTINATIONS.map((d) => [d.id, d]));
const byKind = new Map(DESTINATIONS.map((d) => [d.kind, d]));

const clean = (value) => String(value ?? '').trim().toLowerCase();

/* The destination a stored `kind` means. Anything unrecognised reads as
   Development, because that is what an unrecognised kind has always been
   treated as by the receiving end and a hand-off with no destination at all
   would be worse than one with the historical default. */
function destinationOf(kind) {
  const hit = byKind.get(clean(kind));
  return hit ? hit.id : DEFAULT_ID;
}

/* The `kind` a destination is stored as. */
function kindOf(destination) {
  const hit = byId.get(clean(destination));
  return hit ? hit.kind : byId.get(DEFAULT_ID).kind;
}

/* WHAT THE CALLER ASKED FOR, from either field, with `destination` winning.
 *
 * Both are accepted on the way in: `destination` is what this contract
 * publishes now, `kind` is what the previous one took, and a caller that sends
 * the old field must keep working (the brief's backward-compatibility rule, and
 * the test suite is itself such a caller). They are only ever read through this
 * function, so there is no route that resolves them its own way.
 *
 * Returns null when a value was given and is not one of the two — a typo in a
 * destination is refused rather than quietly sent to Development, because the
 * whole point of the field is that the sender chose. Absent in both: the
 * default, which is the no-change case above. */
function resolve({ destination, kind } = {}) {
  const wantedId = clean(destination);
  if (wantedId) return byId.has(wantedId) ? byId.get(wantedId) : null;
  const wantedKind = clean(kind);
  if (wantedKind) return byKind.has(wantedKind) ? byKind.get(wantedKind) : null;
  return byId.get(DEFAULT_ID);
}

const definitionOf = (destination) => byId.get(clean(destination)) || null;

/* The permission each destination needs. Two keys rather than one, so a studio
   can let a lead drop work into the build without also letting them book Tech
   Art's time — see the catalogue entries for both. The mapping is here because
   the route, the page and the tests must all agree about which key goes with
   which button. */
const PERMISSION = {
  development: 'integration.send_to_dev',
  tech_art: 'integration.send_to_tech_art',
};

const permissionFor = (destination) => PERMISSION[clean(destination)] || null;

module.exports = {
  DESTINATIONS, IDS, KINDS, DEFAULT_ID, PERMISSION,
  destinationOf, kindOf, resolve, definitionOf, permissionFor,
};
