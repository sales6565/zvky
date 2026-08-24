// Everything the bulk user import knows about its own file format.
//
// Deliberately separate from src/asset-import.js. The two share the CSV reader
// in src/import-file.js and nothing else: their columns differ, their
// validation differs, and neither endpoint inspects a file to work out which
// entity it holds. A user file uploaded to the asset importer is rejected for
// missing `type`, not quietly reinterpreted.
//
// The columns mirror what POST /api/users actually needs. The form takes ids
// for the lead and the project; a spreadsheet cannot know an id, so the file
// takes an email and a project name and the endpoint resolves them.

const importFile = require('./import-file');
const { roleDef, activeRoles } = require('./roles');
const passwordPolicy = require('./password-policy');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COLUMNS = [
  {
    name: 'name',
    required: true,
    describe: 'Full name',
    example: ['Priya Raman', 'Marco Silva', 'Aiko Tanaka'],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      // users.name is VARCHAR(255); a longer value would be a database error
      // rather than a message anyone could act on.
      if (value.length > 255) return { error: `is ${value.length} characters; the limit is 255` };
      return { value };
    },
  },
  {
    name: 'email',
    required: true,
    describe: 'Work email — this is what they sign in with, and must be unique',
    example: ['priya.raman@zvky.com', 'marco.silva@zvky.com', 'aiko.tanaka@zvky.com'],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { error: 'is required' };
      if (!EMAIL_PATTERN.test(value)) return { error: `is not a valid email address (got "${value}")` };
      // users.email is VARCHAR(191) so the unique index fits on older MySQL.
      if (value.length > 191) return { error: `is ${value.length} characters; the limit is 191` };
      return { value: value.toLowerCase() };
    },
  },
  {
    name: 'role',
    required: true,
    // The list is long and managed in Settings, so point at it rather than
    // printing 57 keys into every error message.
    describe: 'A role key from Settings, e.g. game_artist, team_lead, producer',
    example: ['senior_game_artist', 'team_lead', 'producer'],
    parse(raw) {
      const value = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!value) return { error: 'is required' };
      const def = roleDef(value);
      if (!def) {
        // Suggest the closest label, since people type "Senior Game Artist"
        // where the file wants "senior_game_artist".
        const match = activeRoles().find((r) => r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_') === value);
        if (match) return { value: match.key };
        return { error: `"${raw}" is not a role. Use a key from Settings, e.g. ${activeRoles().slice(0, 3).map((r) => r.key).join(', ')}` };
      }
      if (!def.isActive) return { error: `"${def.label}" has been deactivated and cannot be assigned to new accounts` };
      return { value: def.key };
    },
  },
  {
    name: 'reports_to_email',
    required: false,
    describe: 'For roles that are assigned work: the email of the lead or supervisor they report to',
    example: ['', '', ''],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { value: null };
      if (!EMAIL_PATTERN.test(value)) return { error: `is not a valid email address (got "${value}")` };
      return { value: value.toLowerCase() };
    },
  },
  {
    name: 'project',
    required: false,
    describe: 'For leads and production roles: the name of a project to attach them to',
    example: ['', '', ''],
    parse(raw) {
      const value = String(raw ?? '').trim();
      return { value: value || null };
    },
  },
  {
    name: 'password',
    required: false,
    describe: 'Leave blank to issue the default temporary password, which they replace on first sign-in',
    example: ['', '', ''],
    parse(raw) {
      const value = String(raw ?? '').trim();
      if (!value) return { value: null };
      const verdict = passwordPolicy.check(value);
      if (!verdict.valid) return { error: verdict.message.replace(/^Password /, '') };
      return { value };
    },
  },
];

const COLUMN_NAMES = COLUMNS.map((c) => c.name);
const REQUIRED_COLUMNS = COLUMNS.filter((c) => c.required).map((c) => c.name);

function validateHeaders(headers) {
  return importFile.validateHeaders(headers, { columnNames: COLUMN_NAMES, requiredColumns: REQUIRED_COLUMNS });
}

function validateRow(row, rowNumber) {
  return importFile.validateRow(row, rowNumber, COLUMNS);
}

function buildTemplateCsv() {
  return importFile.buildTemplateCsv(COLUMNS);
}

function describeFormat() {
  return {
    entity: 'users',
    columns: COLUMNS.map((c) => ({ name: c.name, required: c.required, describe: c.describe })),
    required: REQUIRED_COLUMNS,
    maxRows: importFile.MAX_ROWS,
    maxBytes: importFile.MAX_BYTES,
    extensions: ['.csv', '.xls', '.xlsx'],
    roles: activeRoles().map((r) => ({ key: r.key, label: r.label, group: r.group })),
  };
}

module.exports = {
  COLUMNS,
  COLUMN_NAMES,
  REQUIRED_COLUMNS,
  validateHeaders,
  validateRow,
  buildTemplateCsv,
  describeFormat,
};
