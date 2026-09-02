// Everything the bulk asset import knows about its own file format: which
// columns exist, what a valid cell looks like, and what a correct file looks
// like. The endpoint, the downloadable sample and the tests all read it from
// here, so the sample can never describe a format the endpoint would reject.

const referenceData = require('./reference-data');
const defaults = require('./reference-defaults');
// The same validator the asset panel's Requirement / Reference Link box uses.
const submissionLink = require('./submission-link');

// Types and priorities are managed in Settings, so read them at validation
// time rather than capturing a list at import time — a type added this morning
// has to be importable this afternoon. Before the mirror is loaded (a unit test
// with no database) fall back to what a new studio starts with.
function assetTypes() {
  return referenceData.isLoaded()
    ? referenceData.keys('asset_types')
    : defaults.ASSET_TYPES.map((t) => t.key);
}
function priorities() {
  return referenceData.isLoaded()
    ? referenceData.keys('priorities')
    : defaults.PRIORITIES.map((p) => p.key);
}
// Priority is not an imported column. Every imported asset gets this one and
// it is changed afterwards in the asset panel like any other field: whichever
// priority sits in the middle of the list, or the first if there is no middle.
function defaultPriority() {
  const all = priorities();
  return all.includes('med') ? 'med' : all[Math.floor(all.length / 2)] || all[0];
}

/* The Category cells the sample file shows.

   Categories are managed in Settings and the list ships empty, so there is
   often nothing real to demonstrate with. When the studio HAS configured some,
   the sample uses its own — the file it hands out then imports against its own
   list. When it has not, the sample shows plausible names, which the import
   creates on the way in; that is the behaviour, so the sample may as well
   demonstrate it. */
function exampleCategories() {
  return sampleCells(
    referenceData.isLoaded() ? referenceData.list('categories').map((c) => c.label) : [],
    ['Slot Game', 'Table Game', 'Slot Game']
  );
}

/* And the Scope of Work cells. Unlike categories this list is never empty —
   a new studio starts with six — so the sample always shows values that are
   really in the dropdown rather than three names hardcoded here, which is how
   a sample drifts away from the app it describes. */
function exampleScopes() {
  return sampleCells(
    referenceData.isLoaded() ? referenceData.list('asset_types').map((t) => t.key) : [],
    defaults.ASSET_TYPES.slice(0, 3).map((t) => t.key)
  );
}

// Three cells drawn from a live list, cycling if it is shorter than three.
function sampleCells(configured, fallback) {
  if (!configured.length) return fallback;
  return [0, 1, 2].map((n) => configured[n % configured.length]);
}

/* Headers vary between the person filling the sheet in and the sample they were
 * given. Case and stray whitespace were already handled; punctuation was not,
 * and that failed SILENTLY rather than loudly — "Assignee E-mail" normalised to
 * assignee_e-mail, matched nothing, and the column was dropped along with every
 * value in it. No error, no warning: the assets uploaded and nobody was
 * assigned, which is indistinguishable from the feature not working.
 *
 * So any run of anything that is not a letter or a digit becomes one
 * underscore. "Assignee E-mail", "Assignee-Email" and "Assignee's Email" all
 * land on a spelling the importer accepts, and "No." lands on no.
 *
 * The accepted spellings go through this same function (see acceptsOf), because
 * two normalisers that disagree is the bug being replaced here.
 */
function normaliseHeader(header) {
  return String(header ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/* --- the columns -----------------------------------------------------------

   Two mandatory (Asset Name, Scope of Work) and everything else optional, which
   gives each cell three possible outcomes rather than two:

     { value }    good, use it
     { error }    the row is SKIPPED and reported. Mandatory columns only.
     { warning }  the row is IMPORTED WITHOUT THIS VALUE, and reported.

   One rule decides which: a bad value in a mandatory column is an error, a bad
   value in an optional column is a warning. An optional column is one the asset
   is valid without, so a deadline typed as "next friday" cannot be a reason to
   throw away a perfectly good asset name and scope of work — but it must not
   vanish silently either, which is what the warning is for.

   `parse` may return a warning; anything the parser cannot judge on its own —
   whether an email belongs to a real person — is warned about in the endpoint,
   where there is a database. */
const COLUMNS = [
  {
    /* A line number for whoever is filling the sheet in, so they can talk about
       "row 4" with a colleague. Nothing reads it and nothing stores it: an
       asset's own reference is its code (FX-001), which this application
       generates at creation from the scope-of-work prefix and a per-project
       count, so there is no identifier a person could know in advance to put
       here. Accepted and ignored — a sheet that carries it is not "wrong". */
    name: 'no',
    header: 'No.',
    accepts: ['no.', 'no', 'number', 's_no', 'sl_no', 'sr_no', 'serial', '#'],
    required: false,
    ignored: true,
    describe: 'Your own row number. Not stored.',
    example: ['1', '2', '3'],
    parse() { return { value: null }; },
  },
  {
    name: 'name',
    header: 'Asset Name',
    /* The screen and this sheet both say Asset Name. `name` is what it has
       always been in the database; 'assets_name' stays accepted because that is
       the header every sheet saved before this version carries, and a studio
       with a folder of them should not have to re-type any. */
    accepts: ['asset_name', 'assets_name', 'assets', 'name'],
    required: true,
    describe: 'Asset name — required',
    example: ['Waterfall Spray FX', 'Trader Cart', 'Northern Ridge'],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      // The column is VARCHAR(255); a longer value would be a database error
      // rather than a message anyone could act on.
      if (value.length > 255) return { error: `is ${value.length} characters; the limit is 255` };
      return { value };
    },
  },
  {
    /* Unlike Scope of Work, a category the studio has not configured yet is
       CREATED from the sheet rather than refused. So this only checks that the
       value is sane; matching it to an existing category, or adding it to the
       list, happens in the endpoint where there is a database to write to.

       Optional as of the nine-column format: an asset with no category is an
       ordinary asset, and one can be set in the panel afterwards. */
    name: 'category',
    header: 'Category',
    accepts: ['category', 'categories'],
    required: false,
    describe: 'Category — optional; a new one is added to the Settings list',
    /* Blank in the middle row on purpose. Every optional column is empty in
       that row, so the sample does not merely SAY the rule — it carries a row
       that only has the two mandatory columns filled in, and that row imports.
       A sample where every cell is populated teaches the opposite lesson. */
    get example() { const c = exampleCategories(); return [c[0], '', c[2]]; },
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { value: null };
      if (value.length > 100) return { warning: `is ${value.length} characters; the limit is 100, so it was left unset` };
      return { value };
    },
  },
  {
    name: 'type',
    /* The spelling the sample file carries and error messages name. The UI
       calls this attribute Scope of Work, so the column people are asked to
       fill in says the same thing; `name` stays `type` because that is the
       database column and the API field, which the rename did not touch.
       `accepts` keeps the old spelling working, so a file saved before the
       rename still imports. */
    header: 'Scope of Work',
    accepts: ['scope_of_work', 'scope_of_the_work', 'type'],
    required: true,
    /* Like Category, a value Settings does not hold yet is CREATED rather than
       refused, so this checks only that something sane is there. Matching it,
       or adding it, happens in the endpoint where there is a database. */
    get describe() { return `Required — one of ${assetTypes().join(', ')}, or a new one, which is added to the list`; },
    get example() { return exampleScopes(); },
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      if (value.length > 100) return { error: `is ${value.length} characters; the limit is 100` };
      return { value };
    },
  },
  {
    /* The estimate, not tracked time — Time Spent is recorded by the timer and
       never imported. Optional now: an asset without an estimate is one whose
       estimate has not been decided, which is an ordinary thing for it to be. */
    name: 'man_hours',
    header: 'Man Hours',
    accepts: ['man_hours', 'manhours', 'man_hrs', 'hours'],
    required: false,
    describe: 'Estimated hours — optional; a positive number',
    example: ['20', '', '26'],
    parse(raw) {
      const text = String(raw ?? '').trim();
      if (!text) return { value: null };
      const value = Number(text);
      if (!Number.isFinite(value)) return { warning: `is "${text}", which is not a number, so it was left unset` };
      if (value <= 0) return { warning: 'must be greater than zero, so it was left unset' };
      if (value > 100000) return { warning: 'is larger than 100000, which is not a real estimate, so it was left unset' };
      return { value };
    },
  },
  {
    /* Who the asset goes to. Checked here only for the SHAPE of an address —
       whether it belongs to a real person is a database question, answered in
       the endpoint, and an address nobody holds is a warning there rather than
       an error, on the same rule as everything else optional. */
    name: 'assignee_email',
    header: 'Assignee Email',
    accepts: ['assignee_email', 'assignee', 'assignee_e_mail', 'email'],
    required: false,
    describe: 'Assignee\'s sign-in email — optional; a match assigns the asset immediately',
    example: ['priya@studio.example', '', 'lena@studio.example'], // blank: nobody assigned yet
    parse(raw) {
      const text = String(raw ?? '').trim().toLowerCase();
      if (!text) return { value: null };
      if (text.length > 191) return { warning: 'is longer than an email address can be, so nobody was assigned' };
      // Deliberately loose. The real test is whether a user holds this address,
      // and that happens against the database; this only catches a cell that is
      // plainly not an address at all, so the warning can say which of the two
      // went wrong.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return { warning: `is "${String(raw).trim().slice(0, 60)}", which is not an email address, so nobody was assigned` };
      }
      return { value: text };
    },
  },
  {
    /* DD-MM-YYYY, which is what the studio asked for and what the sample shows.
       ISO (YYYY-MM-DD) is accepted alongside it because it is unambiguous and
       is what a database export hands you; a real date cell from Excel arrives
       as a Date and is taken as-is.

       What is NOT accepted is anything else, and that is the point. 03/04/2026
       is the fourth of March to half the world and the third of April to the
       other half, and a deadline quietly read the wrong way round is worse than
       one refused out loud. */
    name: 'due_date',
    header: 'Deadline',
    accepts: ['deadline', 'due_date', 'due', 'delivery_date'],
    required: false,
    describe: 'Deadline as DD-MM-YYYY — optional; YYYY-MM-DD is accepted too',
    example: ['31-03-2026', '', '15-04-2026'],
    parse(raw) {
      // A real date cell out of Excel: readImportFile asks for cellDates, so
      // there is nothing to parse and nothing to get the wrong way round.
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return { value: iso(raw.getFullYear(), raw.getMonth() + 1, raw.getDate()) };
      }
      const text = String(raw ?? '').trim();
      if (!text) return { value: null };

      const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
      const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
      let y; let m; let d;
      if (dmy) { [, d, m, y] = dmy; } else if (ymd) { [, y, m, d] = ymd; } else {
        return { warning: `is "${text}", which is not a date as DD-MM-YYYY, so no deadline was set` };
      }
      y = Number(y); m = Number(m); d = Number(d);
      /* Round-tripped rather than range-checked: 31-02-2026 passes every bound
         a month and a day can be checked against and is still not a day. */
      const when = new Date(Date.UTC(y, m - 1, d));
      if (when.getUTCFullYear() !== y || when.getUTCMonth() !== m - 1 || when.getUTCDate() !== d) {
        return { warning: `is "${text}", which is not a real date, so no deadline was set` };
      }
      return { value: iso(y, m, d) };
    },
  },
  {
    /* The brief: where the requirement, reference art or spec lives. This is
       the asset panel's "Requirement / Reference Link" and not a new field —
       validated by the very same rules a link typed into that box is, so "that
       is not a valid link" means one thing in this application. */
    name: 'reference_link',
    header: 'Project Link',
    accepts: ['project_link', 'reference_link', 'requirement_link', 'link', 'brief_link'],
    required: false,
    describe: 'Link to the brief or reference — optional; shown as Requirement / Reference Link',
    example: ['https://drive.example.com/brief/waterfall', '', 'https://drive.example.com/brief/ridge'],
    parse(raw) {
      const verdict = submissionLink.validate(raw, { optional: true });
      if (!verdict.ok) return { warning: `${verdict.error} No link was set.` };
      return { value: verdict.link };
    },
  },
  {
    /* The lead's own notes. Its own column on the asset, gated on
       asset.lead_notes — see the permission catalogue for why this is not the
       Description field wearing a different name. */
    name: 'lead_notes',
    header: 'Lead/Supervisor Notes',
    accepts: ['lead/supervisor_notes', 'lead_supervisor_notes', 'lead_notes', 'supervisor_notes',
      'lead_/_supervisor_notes'],
    required: false,
    describe: 'Notes from the lead or supervisor — optional; visible to roles holding Lead / Supervisor Notes',
    example: ['Match the ep-02 spray timing.', '', 'Keep the ridge silhouette flat.'],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { value: null };
      // TEXT holds 65535 bytes; a note past that is a pasted document.
      if (value.length > 20000) {
        return { warning: `is ${value.length} characters, which is too long to store, so it was left unset` };
      }
      return { value };
    },
  },
];

// A date the way the database wants it, from parts already known to be a day.
function iso(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* A column is identified to people by its header — the spelling the sample
   file carries and error messages use — and matched in a file by any of the
   spellings it accepts. The two differ because the headers people read are
   written the way the screen writes them ("Assets Name"), while `name` stays
   the database key it has always been. */
const headerOf = (c) => c.header || c.name;
/* Normalised on the way out, so a spelling listed here is compared exactly as
   a spelling read from a file is. They used to be compared raw against
   normalised, which held only while every entry happened to already be in
   normal form — and 'lead/supervisor_notes' and 'no.' were not. */
const acceptsOf = (c) => (c.accepts || [c.name]).map(normaliseHeader);

const COLUMN_NAMES = COLUMNS.map(headerOf);
const ACCEPTED_HEADERS = COLUMNS.flatMap(acceptsOf);
const REQUIRED_COLUMNS = COLUMNS.filter((c) => c.required).map(headerOf);

// Bounds. A file past these is rejected before any work is done, rather than
// being discovered halfway through a long import.
const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS || 5000);
const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES || 20 * 1024 * 1024);
// Rows per INSERT. Large enough that the round trips stop dominating, small
// enough that the statement stays well inside max_allowed_packet.
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 200);

// Headers vary in case and stray whitespace between exports; compare normalised.

// Is this a usable header row? Returns the problems, not just a boolean, so the
// caller can tell someone exactly which column to add.
function validateHeaders(headers) {
  const present = (headers || []).map(normaliseHeader).filter(Boolean);
  // A required column is present under any spelling it accepts, but it is
  // reported missing under the one the sample file uses — naming the old
  // spelling in the error would send someone to fix the wrong thing.
  const missing = COLUMNS.filter((c) => c.required && !acceptsOf(c).some((h) => present.includes(h)))
    .map(headerOf);
  const unknown = present.filter((h) => !ACCEPTED_HEADERS.includes(h));
  return { ok: missing.length === 0, present, missing, unknown };
}

/* Validate one row.
 *
 * Returns { ok: true, values, warnings } or { ok: false, errors, warnings }.
 * Warnings come back either way and are always about a value that was DROPPED,
 * never about one that was changed — so a row that imports with three warnings
 * has imported exactly what it said, minus three cells nobody could read.
 *
 * A row is only rejected by an error, and only a mandatory column can raise
 * one. That keeps "which rows did I lose" answerable by looking at two columns
 * rather than at nine. */
function validateRow(row, rowNumber) {
  const values = {};
  const errors = [];
  const warnings = [];
  for (const column of COLUMNS) {
    if (column.ignored) continue;
    // Tolerate header casing differences by looking the key up loosely.
    const key = Object.keys(row).find((k) => acceptsOf(column).includes(normaliseHeader(k)));
    const raw = key === undefined ? undefined : row[key];
    const result = column.parse(raw);
    const seen = raw === undefined || raw === null ? ''
      : (raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 80));
    if (result.error) {
      errors.push({
        row: rowNumber,
        column: headerOf(column),
        value: seen,
        message: `${headerOf(column)} ${result.error}`,
      });
    } else if (result.warning) {
      /* The value is dropped, the row is not. Recorded against the same column
         so the results table reads the same whichever kind of line it is. */
      values[column.name] = null;
      warnings.push({
        row: rowNumber,
        column: headerOf(column),
        value: seen,
        message: `${headerOf(column)} ${result.warning}`,
      });
    } else {
      values[column.name] = result.value;
    }
  }
  return errors.length
    ? { ok: false, errors, warnings }
    : { ok: true, values, warnings };
}

// The sample file. Built from the same COLUMNS the endpoint validates against,
// so it cannot drift into describing a format that would be rejected.
function buildTemplateCsv() {
  const escape = (cell) => {
    const text = String(cell ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [COLUMN_NAMES.join(',')];
  const exampleCount = Math.max(...COLUMNS.map((c) => c.example.length));
  for (let i = 0; i < exampleCount; i++) {
    lines.push(COLUMNS.map((c) => escape(c.example[i] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

// A short description of the format, for the UI to show beside the upload.
function describeFormat() {
  return {
    columns: COLUMNS.map((c) => ({ name: headerOf(c), required: c.required, describe: c.describe })),
    assetTypes: assetTypes(),
    priorities: priorities(),
    required: REQUIRED_COLUMNS,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
    extensions: ['.csv', '.xls', '.xlsx'],
  };
}

module.exports = {
  assetTypes,
  priorities,
  defaultPriority,
  COLUMNS,
  COLUMN_NAMES,
  ACCEPTED_HEADERS,
  REQUIRED_COLUMNS,
  MAX_ROWS,
  MAX_BYTES,
  BATCH_SIZE,
  normaliseHeader,
  validateHeaders,
  validateRow,
  buildTemplateCsv,
  describeFormat,
};
