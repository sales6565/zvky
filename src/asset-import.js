// Everything the bulk asset import knows about its own file format: which
// columns exist, what a valid cell looks like, and what a correct file looks
// like. The endpoint, the downloadable sample and the tests all read it from
// here, so the sample can never describe a format the endpoint would reject.

const ASSET_TYPES = ['character', 'prop', 'environment', 'fx', 'animation', 'background'];
const PRIORITIES = ['low', 'med', 'high'];

// A row that fails validation is skipped and reported; it never reaches the
// database. Each check returns either { value } or { error }.
const COLUMNS = [
  {
    name: 'name',
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
    name: 'type',
    required: true,
    describe: `One of ${ASSET_TYPES.join(', ')}`,
    example: ['fx', 'prop', 'environment'],
    parse(raw) {
      const value = String(raw ?? '').trim().toLowerCase();
      if (!value) return { error: 'is required' };
      if (!ASSET_TYPES.includes(value)) return { error: `must be one of ${ASSET_TYPES.join(', ')}` };
      return { value };
    },
  },
  {
    name: 'priority',
    required: false,
    describe: `${PRIORITIES.join(', ')} — defaults to med`,
    example: ['high', 'med', 'low'],
    parse(raw) {
      const value = String(raw ?? '').trim().toLowerCase();
      if (!value) return { value: 'med' };
      if (!PRIORITIES.includes(value)) return { error: `must be one of ${PRIORITIES.join(', ')}` };
      return { value };
    },
  },
  {
    name: 'assignee_email',
    required: false,
    describe: "Email of the person to assign it to; blank leaves it unassigned",
    example: ['', '', ''],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { value: null };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: 'is not a valid email address' };
      return { value };
    },
  },
  {
    name: 'man_hours',
    required: false,
    describe: 'Estimated hours, a number',
    example: ['20', '8', '26'],
    parse(raw) {
      if (raw === '' || raw === null || raw === undefined) return { value: null };
      const value = Number(String(raw).trim());
      // Number('') is 0 and Number('abc') is NaN; NaN reaching the database
      // is what used to abort the whole import with a SQL error.
      if (!Number.isFinite(value)) return { error: `must be a number (got "${raw}")` };
      if (value < 0) return { error: 'cannot be negative' };
      if (value > 99999) return { error: 'is larger than the column allows (max 99999)' };
      return { value: Math.round(value * 10) / 10 }; // DECIMAL(6,1)
    },
  },
  {
    name: 'deadline',
    required: false,
    describe: 'YYYY-MM-DD, or a date cell in Excel',
    example: ['2026-09-15', '2026-09-10', '2026-09-20'],
    parse(raw) {
      if (raw === '' || raw === null || raw === undefined) return { value: null };
      // Excel hands back a real Date when cellDates is on.
      if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) return { error: 'is not a valid date' };
        return { value: raw.toISOString().slice(0, 10) };
      }
      const text = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: `must be written as YYYY-MM-DD (got "${text}")` };
      // Catch 2026-02-31, which matches the pattern but is not a day.
      const [y, m, d] = text.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
        return { error: `is not a real date (${text})` };
      }
      return { value: text };
    },
  },
  {
    name: 'description',
    required: false,
    describe: 'Free text',
    example: [
      'Mist and spray pass for the falls establishing shot',
      'Wooden cart with awning for the market scene',
      'Snow-capped ridge backdrop for the finale',
    ],
    parse(raw) {
      return { value: String(raw ?? '').trim() };
    },
  },
];

const COLUMN_NAMES = COLUMNS.map((c) => c.name);
const REQUIRED_COLUMNS = COLUMNS.filter((c) => c.required).map((c) => c.name);

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
  const missing = REQUIRED_COLUMNS.filter((c) => !present.includes(c));
  const unknown = present.filter((h) => !COLUMN_NAMES.includes(h));
  return { ok: missing.length === 0, present, missing, unknown };
}

// Validate one row. Returns { ok, values } or { ok: false, errors } where each
// error names the row, the column and what is wrong with it.
function validateRow(row, rowNumber) {
  const values = {};
  const errors = [];
  for (const column of COLUMNS) {
    // Tolerate header casing differences by looking the key up loosely.
    const key = Object.keys(row).find((k) => normaliseHeader(k) === column.name);
    const raw = key === undefined ? undefined : row[key];
    const result = column.parse(raw);
    if (result.error) {
      errors.push({
        row: rowNumber,
        column: column.name,
        value: raw === undefined || raw === null ? '' : String(raw).slice(0, 80),
        message: `${column.name} ${result.error}`,
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
    columns: COLUMNS.map((c) => ({ name: c.name, required: c.required, describe: c.describe })),
    required: REQUIRED_COLUMNS,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
    extensions: ['.csv', '.xls', '.xlsx'],
  };
}

module.exports = {
  ASSET_TYPES,
  PRIORITIES,
  COLUMNS,
  COLUMN_NAMES,
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
