/* WHICH DISCIPLINE AN ASSET'S WORK BELONGS TO.
 *
 * ===========================================================================
 * ONE RULE, READ IN TWO PLACES: the Dashboard's Art / Animation sub-tabs, and
 * the folder an upload from Submit Work lands in. Those two had better never
 * disagree — an artist who sees an asset under Animation and finds the file in
 * Artist/ has been told two different things about one piece of work — so there
 * is one definition and both call it.
 *
 * THE RULE IS THE ASSET'S TYPE. `animation` is Animation; everything else is
 * Art. That is not a reading of a field called "discipline", because there
 * isn't one: the obvious candidates are all wrong, and this is what the
 * Dashboard has always actually used.
 *
 *   `discipline`         exists only as free text on freelancers.
 *   `projects.category`  comes from project_categories, which ships EMPTY.
 *   `assets.category`    comes from the asset categories list, which also ships
 *                        EMPTY — so a studio that has created none has every
 *                        asset in one unnamed bucket. The upload folder used to
 *                        read this, which is why every upload landed in the
 *                        fallback folder.
 *   `milestone_types`    does hold exactly {art, animation} — but
 *                        project_milestones joins a type to a PROJECT, never to
 *                        an asset, so it cannot say which of two assets in one
 *                        project is animation.
 *   the assignee's role  would say what somebody usually does, not what this
 *                        piece of work is. A 3D artist animating a rig this
 *                        fortnight is doing animation.
 *
 * That leaves `assets.type`, seeded from the asset_types reference table, where
 * `animation` is one of six values.
 *
 * A TYPE A STUDIO ADDS LATER IS ART, and that is a decision rather than an
 * oversight: tests/dashboard-lens.test.js has pinned it since the sub-tabs were
 * built, and the Dashboard must not change behaviour because a folder feature
 * arrived. If "rigging" should be its own discipline one day, the fix is a
 * discipline column on asset_types — read here, by both callers at once — and
 * not a second list of strings somewhere else.
 *
 * SAID TWICE, ON PURPOSE. The browser needs this rule to draw the sub-tabs and
 * the server needs it to compute a path, and this application has no build step
 * between src/ and public/index.html — the deploy ships `src public sql app.js`
 * and nothing bundles. So the page carries a copy of assetDiscipline() whose
 * body is the SAME TEXT, and tests/asset-discipline.test.js compares the two
 * character for character and runs both over one matrix. A divergence cannot be
 * committed. The same bargain src/server-paths.js and src/server-link.js make
 * with their mirrors, for the same reason.
 */

/* The two, in the order the sub-tabs show them. Art first: it is the larger set
   — five of the six seeded types — so a new viewer lands on most of the work. */
const DISCIPLINES = [
  { id: 'art', label: 'Art' },
  { id: 'animation', label: 'Animation' },
];

const DISCIPLINE_IDS = DISCIPLINES.map((d) => d.id);

/* The default folder name per discipline, and the one for anything without a
   name. Both editable in Settings → Server; these are the two words the studio
   used. The fallback is reachable only by clearing a name there — the rule
   above is total over the two disciplines, so no asset falls out of it. */
const DEFAULT_FOLDERS = { art: 'Artist', animation: 'Animator' };
const DEFAULT_FALLBACK = 'Work';

function assetDiscipline(asset) {
  const type = String((asset && asset.type) || '').trim().toLowerCase();
  return type === 'animation' ? 'animation' : 'art';
}

const disciplineLabel = (id) => (DISCIPLINES.find((d) => d.id === id) || {}).label || null;

/* THE ONE TYPE THE RULE NAMES, for callers that have to express the rule in
   something other than JavaScript. Not used inside assetDiscipline() itself —
   that function's body is compared character for character against the page's
   copy, so it keeps the literal. */
const ANIMATION_TYPE = 'animation';

/* The same rule as a SQL predicate, for a report that has to filter thousands
 * of rows by discipline in the database.
 *
 * WRITTEN HERE AND NOWHERE ELSE, for the reason the whole module exists: a
 * `CASE WHEN a.type = 'animation'` in a query is a second copy of the
 * classification, and the Dashboard and the folder drifted apart precisely
 * because there were two. tests/asset-discipline.test.js runs this predicate
 * and assetDiscipline() over the same types and fails on any disagreement.
 *
 * Returns null for anything that is not a discipline, which the caller reads as
 * "no filter" rather than as "no rows" — an unknown value in a query string
 * should not silently empty a report.
 *
 * NULL IS ART, like everything that is not animation, so the art branch has to
 * say so: `type <> 'animation'` alone is UNKNOWN for a NULL type in SQL and
 * would drop a typeless asset that the Dashboard shows under Art. */
function disciplineWhere(disciplineId, column = 'a.`type`') {
  const id = String(disciplineId === undefined || disciplineId === null ? '' : disciplineId)
    .trim().toLowerCase();
  if (!DISCIPLINE_IDS.includes(id)) return null;
  if (id === 'animation') return { sql: `LOWER(TRIM(${column})) = ?`, params: [ANIMATION_TYPE] };
  return { sql: `(${column} IS NULL OR LOWER(TRIM(${column})) <> ?)`, params: [ANIMATION_TYPE] };
}

module.exports = {
  assetDiscipline, disciplineLabel, disciplineWhere,
  DISCIPLINES, DISCIPLINE_IDS, DEFAULT_FOLDERS, DEFAULT_FALLBACK, ANIMATION_TYPE,
};
