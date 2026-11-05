/* WHICH DISCIPLINE AN ASSET'S WORK BELONGS TO.
 *
 * ===========================================================================
 * ONE RULE, READ IN TWO PLACES: the Dashboard's Art / Animation sub-tabs, and
 * the folder an upload from Submit Work lands in. Those two had better never
 * disagree — an artist who sees an asset under Animation and finds the file in
 * Artist/ has been told two different things about one piece of work — so there
 * is one definition and both call it.
 *
 * THE RULE IS THE TYPE **OR** THE CATEGORY. An asset is ANIMATION when its type
 * is `animation`, or when its category maps to the Animation discipline.
 * Otherwise it is ART. Where the two fields disagree, ANIMATION WINS — a
 * character rigged for animation under a category called Animation is animation
 * work whatever its Scope of Work says, and the studio that filed it that way
 * meant it.
 *
 * ===========================================================================
 * WHY THE CATEGORY IS IN THE RULE NOW, which it was not before.
 *
 * It was left out, deliberately, and the reasoning is worth keeping because it
 * was sound at the time and stopped being true:
 *
 *   `assets.category` comes from the asset categories list, which ships EMPTY —
 *   so a studio that has created none has every asset in one unnamed bucket,
 *   and a rule reading an empty list classifies nothing. The upload folder used
 *   to read this column directly, which is exactly why every upload in the
 *   studio landed in the fallback folder "Work".
 *
 * A LIST THAT SHIPS EMPTY IS NOT A LIST THAT STAYS EMPTY. The studio filled it
 * in, and filled it in with the word Animation, and then reported the bug this
 * change fixes: assets whose CATEGORY is Animation did not appear under the
 * Animation tab, because nothing but the type was ever consulted. The old note
 * here even named the way out — "a discipline column, read here, by both
 * callers at once, and not a second list of strings somewhere else" — and said
 * it should hang off asset_types. It hangs off CATEGORIES instead, because the
 * category is the field a studio can still correct: `assets.type` cannot be
 * edited after an asset is created (there is no `req.body.type` in
 * src/routes/assets.js) while the Category dropdown is right there in the
 * drawer. A rule that only read the type gave an asset filed wrongly on day one
 * no way back.
 *
 * THE OTHER CANDIDATES ARE STILL WRONG, and still worth recording:
 *
 *   `discipline`         exists only as free text on freelancers.
 *   `projects.category`  comes from project_categories, which ships EMPTY, and
 *                        says what kind of JOB a project is, not what a piece of
 *                        work inside it is.
 *   `milestone_types`    does hold exactly {art, animation} — but
 *                        project_milestones joins a type to a PROJECT, never to
 *                        an asset, so it cannot say which of two assets in one
 *                        project is animation.
 *   the assignee's role  would say what somebody usually does, not what this
 *                        piece of work is. A 3D artist animating a rig this
 *                        fortnight is doing animation.
 *
 * THE MAPPING IS DATA, not a list of strings in here: `categories.discipline`,
 * added by the 'asset category disciplines' migration step, defaulting to
 * `art`, with the Discipline dropdown in Settings → Asset Categories to change
 * it. So a studio that calls its animation category "Motion" or "Rigging" says
 * so once, on the screen where it already manages that list, and the rule picks
 * it up — rather than somebody shipping a deploy because a studio chose a
 * different word.
 *
 * A TYPE A STUDIO ADDS LATER IS STILL ART. That decision is untouched:
 * tests/dashboard-lens.test.js has pinned it since the sub-tabs were built, and
 * `animation` remains the one type name the rule knows. What is new is that a
 * category can now put an asset under Animation whatever its type.
 *
 * NOTHING IS REWRITTEN. The discipline is derived at read time, every time, from
 * the two fields the asset already carries — so fixing the rule fixed every
 * existing asset at once, with no pass over `assets` and nothing to undo. The
 * same goes the other way: a category moved back to Art moves its assets back.
 *
 * SAID TWICE, ON PURPOSE. The browser needs this rule to draw the sub-tabs and
 * the server needs it to compute a path, and this application has no build step
 * between src/ and public/index.html — the deploy ships `src public sql app.js`
 * and nothing bundles. So the page carries a copy of BOTH functions below whose
 * bodies are the SAME TEXT, and tests/asset-discipline.test.js compares each
 * pair character for character and runs both over one matrix. A divergence
 * cannot be committed. The same bargain src/server-paths.js and
 * src/server-link.js make with their mirrors, for the same reason.
 *
 * THE MIRROR NOW COVERS TWO FUNCTIONS, not one, and that is the cost of the
 * second field: a rule reading a MAPPING needs the mapping built the same way
 * on both sides, or the page and the server disagree about a category whose
 * discipline is blank, or stored in a different letter case, or keyed by `id`
 * on one side and `key` on the other. disciplineMap() is that construction, and
 * it is mirrored rather than left to each caller for exactly that reason.
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

/* THE CATEGORY -> DISCIPLINE MAPPING, built once and read many times.
 *
 * Takes the category list as the two sides already hold it and returns a Map
 * from category KEY to discipline id. `c.key || c.id` because the server's
 * reference entries carry both (`id` is a uuid, `key` is the stable word) while
 * the page's CATEGORIES entries were built with the key in `id` long before
 * this rule existed; `key` is preferred, so neither side has to be reshaped.
 *
 * ANYTHING UNRECOGNISED BECOMES AN EMPTY STRING rather than being dropped, so a
 * category with no discipline stored reads as "not animation" and the lookup
 * below needs no second branch for a missing row. */
function disciplineMap(categories) {
  const map = new Map();
  for (const c of categories || []) {
    const key = String((c && (c.key || c.id)) || '').trim().toLowerCase();
    if (key) map.set(key, String((c && c.discipline) || '').trim().toLowerCase());
  }
  return map;
}

/* `categories` may be the Map disciplineMap() returns, or the list itself —
   whichever the caller has. A caller in a loop builds the Map once; a caller
   with one asset passes the list and does not have to know. Omitted, the rule
   reads the type alone, which is what it did before the category joined it. */
function assetDiscipline(asset, categories) {
  const type = String((asset && asset.type) || '').trim().toLowerCase();
  if (type === 'animation') return 'animation';
  const key = String((asset && asset.category) || '').trim().toLowerCase();
  if (!key || !categories) return 'art';
  const map = categories instanceof Map ? categories : disciplineMap(categories);
  return map.get(key) === 'animation' ? 'animation' : 'art';
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
function disciplineWhere(disciplineId, options = {}) {
  const {
    typeColumn = 'a.`type`',
    categoryColumn = 'a.category',
    animationCategories = [],
  } = options;
  const id = String(disciplineId === undefined || disciplineId === null ? '' : disciplineId)
    .trim().toLowerCase();
  if (!DISCIPLINE_IDS.includes(id)) return null;

  /* The keys, folded the way the JavaScript rule folds them, and de-duplicated
     so a list with the same key twice does not widen the parameter array. */
  const keys = [...new Set((animationCategories || [])
    .map((k) => String(k === undefined || k === null ? '' : k).trim().toLowerCase())
    .filter(Boolean))];

  /* ONE EXPRESSION, NEGATED FOR ART, so the two branches cannot drift into
     disagreeing about an asset. Art is "not animation" and says so by wrapping
     the same text in NOT, rather than by spelling out the complement — which is
     where `type <> 'animation'` lost the typeless asset before. */
  const typeIsAnimation = `LOWER(TRIM(${typeColumn})) = ?`;
  const params = [ANIMATION_TYPE];
  let animation = typeIsAnimation;
  if (keys.length) {
    animation = `(${typeIsAnimation} OR LOWER(TRIM(${categoryColumn})) IN (${keys.map(() => '?').join(',')}))`;
    params.push(...keys);
  }

  if (id === 'animation') return { sql: animation, params };
  /* COALESCE, not NOT alone: `NOT (NULL = 'animation')` is UNKNOWN in SQL, so a
     typeless, categoryless asset would be dropped from Art — which is the bug
     the old art branch's IS NULL test existed to avoid, generalised to two
     columns instead of hand-written for one. */
  return { sql: `NOT COALESCE(${animation}, 0)`, params };
}

/* WHICH DISCIPLINE A CATEGORY'S NAME SUGGESTS, and the only place that guess is
 * made.
 *
 * READ BY THREE CALLERS, which is why it is here and not written out in each:
 * the 'asset category disciplines' migration step, which seeds an existing
 * studio's list so the fix lands with the categories already classified;
 * create() in src/reference-data.js, so a category somebody adds tomorrow and
 * calls "Animation Props" is born Animation rather than needing a second visit
 * to the dropdown; and scripts/discipline-audit.js, which previews what the
 * migration would decide on a database that has not run it yet.
 *
 * IT IS A GUESS, AND ONLY EVER A STARTING VALUE. The stored column is what the
 * rule reads; this only decides what that column starts as. A studio whose
 * animation category is called "Motion" sets it on the Settings screen, and
 * nothing here ever overrules a value somebody chose — see the IS NULL guard on
 * the migration's UPDATE and the `payload.discipline !== undefined` test in
 * create(). */
function disciplineFromName(label) {
  return /animation/i.test(String(label === undefined || label === null ? '' : label))
    ? 'animation' : 'art';
}

/* The animation-side category keys, out of the category list a caller already
   has. The one place that answers "which categories count as animation", so a
   SQL caller and a JavaScript caller cannot disagree about it. */
function animationCategoryKeys(categories) {
  return [...disciplineMap(categories).entries()]
    .filter(([, id]) => id === 'animation')
    .map(([key]) => key);
}

module.exports = {
  assetDiscipline, disciplineMap, animationCategoryKeys, disciplineFromName,
  disciplineLabel, disciplineWhere,
  DISCIPLINES, DISCIPLINE_IDS, DEFAULT_FOLDERS, DEFAULT_FALLBACK, ANIMATION_TYPE,
};
