/* WHAT AN ASSET MAY BE CALLED. One rule set, one place, three callers.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Until Prompt 63 a name could only be set at creation, and the rule lived in
 * three places that did not agree:
 *
 *   src/routes/assets.js   `if (!name || !name.trim())`, then `name.trim()`
 *                          into the INSERT. No length check at all, so a
 *                          256-character name was a MySQL error — a 500 on an
 *                          ordinary typo.
 *   src/asset-import.js    trim, required, and a 255 ceiling with the actual
 *                          length in the message. The sheet got the better
 *                          validator.
 *   public/index.html      trim, required, a toast. No ceiling.
 *
 * Renaming had to pick one of the three, and picking one would have made a
 * fourth. So the rule moved HERE and all three ask this module. That is the
 * whole point: a name that the create form accepts is a name the rename
 * accepts, character for character, and a name either refuses is refused with
 * the same sentence. tests/asset-name.test.js compares the page's copy of the
 * messages with the strings below and fails if they drift apart.
 *
 * ===========================================================================
 * UNIQUENESS: THERE IS NONE, AND THAT IS THE RULE RATHER THAN A GAP.
 *
 * `assets` has no unique key on `name` (see sql/schema.sql), creating an asset
 * runs no duplicate query, and the bulk import runs none either. Two assets in
 * one project may be called the same thing today, and on a deployment that has
 * been running for years some of them are.
 *
 * So renaming does not check for duplicates. Not because the check was
 * forgotten, but because the rename must refuse exactly what creation refuses
 * and accept exactly what creation accepts — and a studio with two assets
 * already called "Hero" would otherwise find one of them unrenameable for ever.
 * An asset's identity is its id, and its reference on screen is its CODE
 * (FX-001), which IS generated per project and never changes. The name is a
 * label for people.
 *
 * Adding uniqueness later is a decision about CREATION first. It belongs in
 * this module, applied by both callers at once, with a decision about the rows
 * already in the database. tests/asset-name.test.js pins the current answer in
 * both directions so that change cannot be made by accident on one side only.
 *
 * ===========================================================================
 * NORMALISATION, AND WHY A CONTROL CHARACTER IS NOT ALWAYS DROPPED.
 *
 * A name arrives pasted from a spreadsheet, a chat message or a PDF, and comes
 * with tabs, newlines, double spaces and the occasional zero-width oddity.
 *
 *   a line break or a tab BECOMES A SPACE, then runs of space collapse to one.
 *     Dropping it outright would weld two words together: "Hero\tPose" is two
 *     words however it was typed, and "HeroPose" is not what anybody meant.
 *   any other control character IS REMOVED. There is no word boundary there to
 *     keep, and a stray 0x01 in a name is nothing but a way to make two names
 *     that look identical sort and compare differently.
 *
 * Then trim. The result is what goes in the column — for the rename AND for
 * creation, so the two cannot produce different rows from the same keystrokes.
 */

// The column is VARCHAR(255). The ceiling is the column, not a preference.
const MAX_LENGTH = 255;

/* The sentences. Exported because the page needs the same words and cannot
   require() this file — tests/asset-name.test.js reads both and compares. */
const MESSAGES = {
  required: 'An asset needs a name.',
  tooLong: `An asset name can be at most ${MAX_LENGTH} characters.`,
};

/* Line breaks and tabs, including the three Unicode ones that are not in the
   C0 range: NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR. Converted to a space
   BEFORE the removal below, which would otherwise eat NEL. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// C0, DEL and C1 — what is left of them once the breaks above are spaces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function normalise(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw);
  return text
    .replace(BREAKS, ' ')
    .replace(CONTROL, '')
    /* Every kind of space, not just U+0020: a name pasted from a document
       routinely carries a non-breaking space, and two names differing only by
       which space they used are the same name to everybody looking at them. */
    .replace(/\s+/g, ' ')
    .trim();
}

/* THE RULE, as a verdict with a CODE rather than a sentence.
 *
 * The code is what lets the bulk import keep its own phrasing — its errors read
 * "Asset Name is required", prefixed with the column, and "An asset needs a
 * name." would read as a sentence in the middle of one. So the import maps the
 * code; the API and the page print MESSAGES. One rule, two presentations, and
 * the presentation is the only thing that differs. */
function check(raw) {
  const value = normalise(raw);
  if (!value) return { ok: false, code: 'required', value: '', length: 0 };
  if (value.length > MAX_LENGTH) return { ok: false, code: 'too_long', value, length: value.length };
  return { ok: true, code: null, value, length: value.length };
}

/* The same verdict with the sentence attached, for the two callers that show
   one to a person. `field` is there so a form can mark the box. */
function validate(raw) {
  const verdict = check(raw);
  if (verdict.ok) return verdict;
  return {
    ...verdict,
    field: 'name',
    message: verdict.code === 'required' ? MESSAGES.required : MESSAGES.tooLong,
  };
}

module.exports = { MAX_LENGTH, MESSAGES, normalise, check, validate };
