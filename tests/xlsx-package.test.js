/* IS THE FILE A VALID .xlsx — the question Prompt 53's tests never asked.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS.
 *
 * The Artist Report shipped and Excel refused to open it: "We found a problem
 * with some content", then a blank sheet after the repair. Twenty-eight tests
 * had passed. They passed because they all read the file back with a LENIENT
 * reader — the system `unzip`, which has no opinion about XML; SheetJS, which
 * finds the elements it wants with a regex and the parts it wants by name; and
 * LibreOffice, built to open other people's broken files. Excel is the only
 * reader that validates the package, so it was the only one that noticed.
 *
 * Two defects, both invisible to a lenient reader:
 *
 *   1. The worksheet wrote <mergeCells> before <autoFilter>. CT_Worksheet is a
 *      SEQUENCE and autoFilter comes first; Excel rejects the part.
 *   2. xl/styles.xml was in the zip and in [Content_Types].xml and NOTHING
 *      RELATED TO IT. Excel reaches the styles part through the workbook's
 *      relationship, not by its name, so every cell's s="4" pointed into a
 *      table Excel had never loaded.
 *
 * So the tests here do not read the file. They CHECK it, with
 * tests/xlsx-validator.js, which encodes the parts of ECMA-376 Excel enforces.
 * And because a validator that passes everything is worse than none, the first
 * test proves it on the attached template — a file Excel does open — and the
 * mutation checks prove it fails on each defect in turn.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const xlsx = require('xlsx');

const validator = require('./xlsx-validator');
const artistXlsx = require('../src/artist-report-xlsx');

const TEMPLATE = path.join(__dirname, 'fixtures', 'artist-report-format-template.xlsx');

const ROW = {
  clientName: 'Acme Pictures',
  projectName: 'Hero Quest',
  department: 'Art',
  assetName: 'Hero head',
  resourceName: 'Ana Artist',
  submitDate: '2026-09-14',
  bidHours: 12,
  spentHours: 9.5,
  efficiency: 126.3,
};
const build = (rows, title = 'ARTIST REPORT 01-Sep-2026 to 30-Sep-2026') => artistXlsx.build({ rows, title });

/* ---- the validator is worth trusting ----------------------------------- */

test('the attached template passes the validator, so the validator is not vacuous', () => {
  /* THE CONTROL FOR EVERY OTHER TEST HERE. Artist_Report_Download_Format.xlsx
     was written by Excel and opens in Excel. A validator that cannot pass it is
     measuring its author's opinions rather than the format, and every failure it
     reported afterwards would be noise. */
  assert.deepStrictEqual(validator.validate(fs.readFileSync(TEMPLATE)), []);
});

test('the validator catches each thing that made Excel reject the file', () => {
  const good = build([ROW]);
  assert.deepStrictEqual(validator.validate(good), [], 'the report as it is built now');

  /* The two real defects, reproduced by editing the bytes of a good file rather
     than by trusting a comment about what the old code did. */
  const broken = (from, to) => {
    const { parts } = validator.parts(good);
    const edited = new Map(parts);
    for (const [name, data] of parts) {
      const text = data.toString('utf8');
      if (text.includes(from)) edited.set(name, Buffer.from(text.replace(from, to), 'utf8'));
    }
    return rezip(edited);
  };

  const swapped = broken(
    '<autoFilter ref="A2:I3"/><mergeCells count="1"><mergeCell ref="D1:F1"/></mergeCells>',
    '<mergeCells count="1"><mergeCell ref="D1:F1"/></mergeCells><autoFilter ref="A2:I3"/>');
  const order = validator.validate(swapped);
  assert.ok(order.some((p) => /<autoFilter> comes after <mergeCells>/.test(p)),
    `the schema order of the worksheet's children: ${JSON.stringify(order)}`);

  const orphaned = broken(
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '');
  const orphan = validator.validate(orphaned);
  assert.ok(orphan.some((p) => /"xl\/styles\.xml" is in the package but no relationship points at it/.test(p)),
    `an orphaned styles part: ${JSON.stringify(orphan)}`);
});

/* A zip writer for the tests' own use, so a defect can be injected into a built
   file without going through the writer under test. Deliberately separate from
   src/ooxml-zip.js: a test that rebuilt the package with the code it is checking
   could not tell a broken writer from a broken file. */
function rezip(parts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rezip-'));
  try {
    for (const [name, data] of parts) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    const out = path.join(dir, 'out.zip');
    execFileSync('zip', ['-q', '-X', '-r', out, ...[...parts.keys()]], { cwd: dir });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- the reports the studio can actually produce ----------------------- */

const LONG = 'A'.repeat(500);
const UNICODE = 'Ñoño — 日本語 — عربى — 🎬 — ẅ';

const CASES = [
  ['a report with rows in it', [ROW, { ...ROW, clientName: 'Zed Studio', department: 'Animation' }]],
  ['an empty report, headers only', []],
  ['a report with a blank efficiency and a blank client', [
    { ...ROW, clientName: null, efficiency: null, spentHours: 0 },
    { ...ROW, clientName: '', efficiency: null, bidHours: null },
    { ...ROW, submitDate: null },
  ]],
  ['a report with unicode and very long names', [
    { ...ROW, assetName: UNICODE, resourceName: LONG, clientName: `${UNICODE} ${LONG}`, projectName: UNICODE },
  ]],
  ['a report whose names are formulas and markup', [
    { ...ROW, assetName: '=1+1', resourceName: '+1+1', clientName: '-1+1', projectName: '@SUM(A1:A9)' },
    { ...ROW, assetName: 'Fish & Chips', resourceName: '<script>alert(1)</script>', clientName: 'a > b < c', projectName: 'say "hello"' },
    { ...ROW, assetName: "it's a 'quote'", resourceName: 'tab\there', clientName: 'bell\u0007inside', projectName: 'line\nbreak' },
  ]],
];

for (const [label, rows] of CASES) {
  test(`${label} is a valid .xlsx package`, () => {
    validator.assertValid(build(rows), label);
  });
}

test('the maximum-size report is a valid .xlsx package', () => {
  /* THE 50,000-ROW CAP, built in full. The chunking in the writer only happens
     past 2,000 rows, the column widths only cap past 40 characters and the
     dimension and autofilter refs only reach four digits up here — none of which
     the small cases exercise. */
  const rows = [];
  for (let i = 0; i < 50000; i += 1) {
    rows.push({
      clientName: `Client ${i % 50}`,
      projectName: `Project ${i % 200}`,
      department: i % 2 ? 'Art' : 'Animation',
      assetName: i % 997 === 0 ? `${UNICODE} ${i}` : `Asset number ${i}`,
      resourceName: i % 499 === 0 ? LONG : `Resource ${i % 80}`,
      submitDate: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      bidHours: (i % 20) + 1,
      spentHours: Number(((i % 37) / 3).toFixed(2)),
      efficiency: i % 5 ? Number(((i % 300) / 3).toFixed(1)) : null,
    });
  }
  const buffer = build(rows);
  validator.assertValid(buffer, 'the 50,000-row report');
  const { parts } = validator.parts(buffer);
  const sheet = parts.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /<dimension ref="A1:I50002"\/>/, 'the dimension reaches the last row');
  assert.match(sheet, /<autoFilter ref="A2:I50002"\/>/, 'and so does the autofilter');
  assert.match(parts.get('xl/workbook.xml').toString('utf8'), /\$A\$2:\$I\$50002/,
    'and the filter has its defined name');
});

test('a blank cell is an absent value, never an empty or invalid number', () => {
  /* THE SHAPE OF A BLANK, asserted in the XML rather than through a reader,
     because the readers all show "empty" for both an absent <v> and an
     <v></v> and only one of those opens in Excel. */
  const buffer = build([{ ...ROW, clientName: null, submitDate: null, bidHours: null, spentHours: null, efficiency: null }]);
  const sheet = validator.parts(buffer).parts.get('xl/worksheets/sheet1.xml').toString('utf8');
  const row = /<row r="3">([\s\S]*?)<\/row>/.exec(sheet)[1];
  for (const ref of ['A3', 'F3', 'G3', 'H3', 'I3']) {
    const cell = new RegExp(`<c r="${ref}"[^>]*/>|<c r="${ref}"[^>]*>[\\s\\S]*?</c>`).exec(row)[0];
    assert.doesNotMatch(cell, /<v/, `${ref} carries no value element at all: ${cell}`);
    assert.doesNotMatch(cell, /t="/, `${ref} is not typed: ${cell}`);
    assert.match(cell, /^<c r="[A-Z]\d+" s="\d+"\/>$/, `${ref} is a style and nothing else: ${cell}`);
  }
  assert.doesNotMatch(sheet, /NaN|Infinity|<v><\/v>|<v\/>/, 'nowhere in the sheet');
});

test('nothing in the package is a formula, however a name is spelled', () => {
  const buffer = build([{ ...ROW, assetName: '=1+1', clientName: '=cmd|\' /c calc\'!A1' }]);
  const { parts } = validator.parts(buffer);
  for (const [name, data] of parts) {
    assert.doesNotMatch(data.toString('utf8'), /<f[ >\/]/, `${name} has no <f> element`);
  }
  const sheet = parts.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=1\+1</, 'the name is a string');
});

/* ---- the golden skeleton ----------------------------------------------- */

test('the package skeleton is the template’s: its parts, its child order, its styles structure', () => {
  const template = validator.parts(fs.readFileSync(TEMPLATE));
  const ours = validator.parts(build([ROW]));

  /* THE PARTS THE TEMPLATE HAS THAT A WORKBOOK NEEDS. docProps, the theme and
     the shared string table are the template's and not ours on purpose: we
     write no shared strings, reference no theme colour and carry no document
     properties. Everything a reader must have, we have. */
  const required = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'];
  for (const part of required) {
    assert.ok(template.parts.has(part), `the template has ${part}`);
    assert.ok(ours.parts.has(part), `and so do we`);
  }
  assert.deepStrictEqual(ours.names.slice().sort(), required.slice().sort(),
    'and we add nothing else, so there is no part without a relationship');

  const childrenOf = (pkg, part) => validator.parseXml(pkg.parts.get(part).toString('utf8'))
    .children.map((c) => c.name).filter((n) => !n.includes(':'));

  /* THE WORKSHEET'S CHILDREN, IN THE TEMPLATE'S RELATIVE ORDER. Ours has more
     of them — a freeze pane, an autofilter — so this asserts the order rather
     than the list: every child the template has appears in ours in the same
     sequence, and the whole sequence obeys CT_Worksheet. */
  const templateSheet = childrenOf(template, 'xl/worksheets/sheet1.xml');
  const ourSheet = childrenOf(ours, 'xl/worksheets/sheet1.xml');
  const shared = ourSheet.filter((n) => templateSheet.includes(n));
  assert.deepStrictEqual(shared, templateSheet.filter((n) => ourSheet.includes(n)),
    'the children we share with the template come in the template’s order');
  for (const list of [templateSheet, ourSheet]) {
    const positions = list.map((n) => validator.WORKSHEET_ORDER.indexOf(n));
    assert.deepStrictEqual(positions, positions.slice().sort((a, b) => a - b),
      `${JSON.stringify(list)} is in CT_Worksheet order`);
  }
  assert.ok(ourSheet.indexOf('autoFilter') < ourSheet.indexOf('mergeCells'),
    'and autoFilter comes before mergeCells, which is the bug this suite exists for');

  /* THE STYLES STRUCTURE: the same element sequence, each one present, and the
     same kinds of thing inside. Not the same counts — the template has two
     fonts and three fills because it has no data rows to format. */
  const templateStyles = childrenOf(template, 'xl/styles.xml');
  const ourStyles = childrenOf(ours, 'xl/styles.xml');
  /* <extLst> is excluded and only that. The template's holds Microsoft's slicer
     and timeline style defaults, which are extension content for features this
     report does not have; copying them would be inventing a claim about the
     file. Everything that actually holds a style has to be there. */
  for (const element of templateStyles.filter((n) => n !== 'extLst')) {
    assert.ok(ourStyles.includes(element), `xl/styles.xml has <${element}>, as the template does`);
  }
  for (const list of [templateStyles, ourStyles]) {
    const positions = list.map((n) => validator.STYLES_ORDER.indexOf(n));
    assert.deepStrictEqual(positions, positions.slice().sort((a, b) => a - b),
      `${JSON.stringify(list)} is in CT_Stylesheet order`);
  }
  const ourWorkbook = childrenOf(ours, 'xl/workbook.xml');
  const positions = ourWorkbook.map((n) => validator.WORKBOOK_ORDER.indexOf(n));
  assert.deepStrictEqual(positions, positions.slice().sort((a, b) => a - b),
    `${JSON.stringify(ourWorkbook)} is in CT_Workbook order`);
});

/* ---- two readers, not one ---------------------------------------------- */

const SOFFICE = ['/usr/bin/soffice', '/usr/bin/libreoffice'].find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}) || null;

/* A date as LibreOffice's CSV filter writes it, back to the calendar day. It
   renders with the cell's own format — dd-mmm-yyyy — or, under some locales,
   mm/dd/yyyy; a bare serial is accepted too. All three are the same day or the
   test fails. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function isoDay(text) {
  const value = String(text == null ? '' : text).trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month < 0) return `unknown month ${m[2]}`;
    return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return value;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(Number(value)) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return `unreadable date ${JSON.stringify(value)}`;
}

function throughLibreOffice(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-'));
  try {
    const file = path.join(dir, 'report.xlsx');
    fs.writeFileSync(file, buffer);
    /* Converted to CSV with the serial numbers left as numbers (the trailing 0
       turns the "format as displayed" option off), so what comes back is the
       value in the cell and not LibreOffice's rendering of it. */
    execFileSync(SOFFICE, ['--headless', `-env:UserInstallation=file://${dir}/profile`,
      '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,,,,,,,0', '--outdir', dir, file],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
    const csv = fs.readFileSync(path.join(dir, 'report.csv'), 'utf8');
    return csv.replace(/\r\n/g, '\n').split('\n').filter((l, i, all) => l !== '' || i < all.length - 1)
      .map((line) => {
        const cells = [];
        let cur = '';
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else cur += ch;
          } else if (ch === '"') quoted = true;
          else if (ch === ',') { cells.push(cur); cur = ''; }
          else cur += ch;
        }
        cells.push(cur);
        return cells;
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the file opens in two different readers and says the same thing in both',
  { skip: SOFFICE ? false : 'LibreOffice is not installed in this container.' }, () => {
    const rows = [
      { ...ROW },
      { ...ROW, clientName: 'Zed & Sons', assetName: '=1+1', department: 'Animation', efficiency: null, spentHours: 0 },
      { ...ROW, clientName: null, resourceName: UNICODE, submitDate: '2026-09-30', bidHours: null },
    ];
    const buffer = build(rows);

    /* READER ONE: the library the rest of the application uses. */
    const wb = xlsx.read(buffer, { type: 'buffer' });
    assert.deepStrictEqual(wb.SheetNames, [artistXlsx.SHEET_NAME]);
    const sheetJs = xlsx.utils.sheet_to_json(wb.Sheets[artistXlsx.SHEET_NAME], { header: 1, raw: true, blankrows: true });

    /* READER TWO: LibreOffice, a different implementation entirely. */
    const libre = throughLibreOffice(buffer);

    assert.deepStrictEqual(sheetJs[1], artistXlsx.HEADERS, 'SheetJS reads the headers');
    assert.deepStrictEqual(libre[1], artistXlsx.HEADERS, 'and so does LibreOffice');

    rows.forEach((row, i) => {
      const fromJs = sheetJs[i + 2];
      const fromLibre = libre[i + 2];
      artistXlsx.COLUMNS.forEach((col, c) => {
        const written = row[col.key];
        const blank = written === null || written === undefined || written === '';
        if (blank) {
          assert.ok(fromJs[c] === undefined || fromJs[c] === null, `SheetJS: ${col.header} of row ${i + 1} is blank`);
          assert.strictEqual(fromLibre[c], '', `LibreOffice: ${col.header} of row ${i + 1} is blank`);
          return;
        }
        if (col.kind === 'date') {
          /* SheetJS hands back the serial; LibreOffice renders the cell, which is
             the stronger of the two answers — it proves the serial AND the date
             format together name the right calendar day, which a serial alone
             does not. Either rendering it may choose is accepted, the day is
             not. */
          const serial = artistXlsx.dateSerial(written);
          assert.strictEqual(fromJs[c], serial, `SheetJS: ${col.header} of row ${i + 1}`);
          assert.strictEqual(isoDay(fromLibre[c]), written,
            `LibreOffice: ${col.header} of row ${i + 1} reads as ${fromLibre[c]}`);
        } else if (col.kind === 'text') {
          assert.strictEqual(fromJs[c], written, `SheetJS: ${col.header} of row ${i + 1}`);
          assert.strictEqual(fromLibre[c], written, `LibreOffice: ${col.header} of row ${i + 1}`);
        } else {
          assert.strictEqual(Number(fromJs[c]), Number(written), `SheetJS: ${col.header} of row ${i + 1}`);
          assert.strictEqual(Number(fromLibre[c]), Number(written), `LibreOffice: ${col.header} of row ${i + 1}`);
        }
      });
    });
  });

test('the other spreadsheet exports in the application go through the same check', () => {
  /* THE SHARED WRITER QUESTION, answered rather than assumed. Every other export
     — the activity log, the idle report, the efficiency report, the timesheet —
     is written with SheetJS, which is a different writer from this one, so a
     defect here cannot be a defect there. What they DO share is nothing, and
     this test pins that: if somebody ever routes one of them through
     src/artist-report-xlsx.js, it will be covered by the suite above.
     SheetJS's own output is checked below for the two things the validator is
     stricter than Excel about, so the difference is on the record. */
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
  for (const file of ['activity.js', 'idle.js', 'timesheets.js', 'assets.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /artist-report-xlsx/, `${file} does not use the hand-written writer`);
    assert.match(source, /require\('xlsx'\)/, `${file} writes its spreadsheet with SheetJS`);
  }
  /* reports.js holds both, because the Artist Report lives beside the Efficiency
     report: the one route uses the hand-written writer and the other SheetJS. */
  const reports = read('reports.js');
  assert.match(reports, /artist-report-xlsx/, 'the Artist Report route uses the hand-written writer');
  assert.match(reports, /require\('xlsx'\)/, 'and the Efficiency report still uses SheetJS');
  assert.match(reports.slice(reports.indexOf("router.get('/efficiency.xlsx'")), /xlsx\.write\(/,
    'the Efficiency download is SheetJS output, so this fix did not reach it');

  const ws = xlsx.utils.aoa_to_sheet([['Name', 'Hours'], ['Ana', 9.5]]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const problems = validator.validate(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  /* SheetJS's packages are relationship-complete and schema-ordered — the two
     things that broke the Artist Report — so the exports built with it were
     never affected. They do trip two checks this validator is deliberately
     stricter than Excel about, and naming them here keeps that an informed
     choice rather than a surprise. */
  assert.deepStrictEqual(validator.strictly(problems), [],
    `SheetJS output, ignoring the two known-tolerated strictnesses: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => validator.SHEETJS_TOLERATED.test(p)),
    'and those two really are what SheetJS does, so the exception is not dead code');
});
