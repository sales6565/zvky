// Reading an uploaded spreadsheet into a header row and a list of rows.
//
// Shared by the user and asset importers because parsing a CSV is parsing a
// CSV. Everything past that — which columns exist, what a valid cell holds,
// what a row becomes — belongs to each importer and is deliberately not here:
// there is no single parser that inspects a file and guesses which entity it
// describes. The caller knows what it asked for.

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');

// Bounds shared by both importers. A file past these is refused before any
// work is done, rather than being discovered part-way through.
const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES || 20 * 1024 * 1024);
const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS || 5000);
// Rows per INSERT: enough that round trips stop dominating, small enough that
// the statement stays well inside max_allowed_packet.
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 200);

// Headers vary in case and stray whitespace between exports; compare normalised.
function normaliseHeader(header) {
  return String(header ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, '_');
}

// Yield to the event loop. Between batches this keeps the server answering
// other requests during a long import instead of appearing hung.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function clientError(message, extra = {}) {
  const err = new Error(message);
  err.status = 400;
  Object.assign(err, extra);
  return err;
}

// Reads the file into { headers, records }. Throws a 400-tagged error for
// anything that makes the file unreadable, so the caller answers 400 rather
// than 500.
function readImportFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const fail = (message) => { throw clientError(message); };

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    fail('The uploaded file could not be read.');
  }
  if (stats.size === 0) fail('That file is empty.');
  if (stats.size > MAX_BYTES) {
    fail(`That file is ${(stats.size / 1048576).toFixed(1)}MB; the limit is ${(MAX_BYTES / 1048576).toFixed(0)}MB.`);
  }

  let headers = [];
  let records = [];
  try {
    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      records = parse(content, {
        bom: true,                // Excel writes a byte-order mark; without this the first header reads as junk
        columns: (found) => { headers = found; return found; },
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // a ragged row becomes a row error, not a dead import
      });
    } else {
      const workbook = XLSX.readFile(filePath, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) fail('That workbook has no sheets.');
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
      if (!grid.length) fail('That sheet is empty.');
      headers = grid[0];
      records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }
  } catch (err) {
    if (err.status) throw err;
    // csv-parse and xlsx both throw on structurally broken files, and their
    // messages name the line, which is worth passing on.
    fail(`That file could not be read: ${err.message}`);
  }

  if (!headers.length) fail('That file has no header row. The first row must name the columns.');
  return { headers, records };
}

// Is this a usable header row for the given spec? Returns the problems, not
// just a boolean, so the caller can name the column to add.
function validateHeaders(headers, { columnNames, requiredColumns }) {
  const present = (headers || []).map(normaliseHeader).filter(Boolean);
  const missing = requiredColumns.filter((c) => !present.includes(c));
  const unknown = present.filter((h) => !columnNames.includes(h));
  return { ok: missing.length === 0, present, missing, unknown };
}

// Validate one row against a column spec. Returns { ok, values } or
// { ok: false, errors } where each error names the row, the column and what is
// wrong with it.
function validateRow(row, rowNumber, columns) {
  const values = {};
  const errors = [];
  for (const column of columns) {
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

// Build a sample file from a column spec, so the sample can never describe a
// format the importer would reject.
function buildTemplateCsv(columns) {
  const escape = (cell) => {
    const text = String(cell ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => c.name).join(',')];
  const exampleCount = Math.max(...columns.map((c) => c.example.length));
  for (let i = 0; i < exampleCount; i++) {
    lines.push(columns.map((c) => escape(c.example[i] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  MAX_BYTES,
  MAX_ROWS,
  BATCH_SIZE,
  normaliseHeader,
  yieldToLoop,
  clientError,
  readImportFile,
  validateHeaders,
  validateRow,
  buildTemplateCsv,
};
