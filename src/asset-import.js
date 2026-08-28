// Everything the bulk asset import knows about its own file format: which
// columns exist, what a valid cell looks like, and what a correct file looks
// like. The endpoint, the downloadable sample and the tests all read it from
// here, so the sample can never describe a format the endpoint would reject.

const referenceData = require('./reference-data');
const defaults = require('./reference-defaults');

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

// A row that fails validation is skipped and reported; it never reaches the
// database. Each check returns either { value } or { error }.
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
    header: 'Assets Name',
    // The screen calls this Assets Name; `name` is what it has always been in
    // the database and in files saved before the rename.
    accepts: ['assets_name', 'assets', 'name'],
    required: true,
    describe: 'Asset name',
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
       CREATED from the sheet rather than refused. So this only checks that a
       value is present and sane; matching it to an existing category, or
       adding it to the list, happens in the endpoint where there is a database
       to write to. */
    name: 'category',
    header: 'Category',
    accepts: ['category', 'categories'],
    required: true,
    describe: 'Category — added to the Settings list if it is a new one',
    get example() { return exampleCategories(); },
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      if (value.length > 100) return { error: `is ${value.length} characters; the limit is 100` };
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
    get describe() { return `One of ${assetTypes().join(', ')} — a new one is added to the list`; },
    get example() { return exampleScopes(); },
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      if (value.length > 100) return { error: `is ${value.length} characters; the limit is 100` };
      return { value };
    },
  },
  {
    /* The estimate, not tracked time. Required, so no imported asset arrives
       without one — Time Spent is recorded by the timer and never imported. */
    name: 'man_hours',
    header: 'Man Hours',
    accepts: ['man_hours', 'manhours', 'man_hrs', 'hours'],
    required: true,
    describe: 'Estimated hours — a positive number',
    example: ['20', '8', '26'],
    parse(raw) {
      const text = String(raw ?? '').trim();
      if (!text) return { error: 'is required' };
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: `is "${text}", which is not a number` };
      if (value <= 0) return { error: 'must be greater than zero' };
      if (value > 100000) return { error: 'is larger than 100000, which is not a real estimate' };
      return { value };
    },
  },
];

/* A column is identified to people by its header — the spelling the sample
   file carries and error messages use — and matched in a file by any of the
   spellings it accepts. The two differ because the headers people read are
   written the way the screen writes them ("Assets Name"), while `name` stays
   the database key it has always been. */
const headerOf = (c) => c.header || c.name;
const acceptsOf = (c) => c.accepts || [c.name];

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
function normaliseHeader(header) {
  return String(header ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, '_');
}

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

// Validate one row. Returns { ok, values } or { ok: false, errors } where each
// error names the row, the column and what is wrong with it.
function validateRow(row, rowNumber) {
  const values = {};
  const errors = [];
  for (const column of COLUMNS) {
    if (column.ignored) continue;
    // Tolerate header casing differences by looking the key up loosely.
    const key = Object.keys(row).find((k) => acceptsOf(column).includes(normaliseHeader(k)));
    const raw = key === undefined ? undefined : row[key];
    const result = column.parse(raw);
    if (result.error) {
      errors.push({
        row: rowNumber,
        column: headerOf(column),
        value: raw === undefined || raw === null ? '' : String(raw).slice(0, 80),
        message: `${headerOf(column)} ${result.error}`,
      });
    } else {
      values[column.name] = result.value;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
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
