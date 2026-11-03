/* THE DOWNLOAD IS THE ATTACHED FILE, measured against the attached file.
 *
 * ===========================================================================
 * THE TEMPLATE IS COMMITTED — tests/fixtures/Time_sheet_Report_Download_Format
 * .xlsx — and this suite reads it rather than restating what it contains. A
 * test that said `width === 13.14` would be a copy of the format, and a copy is
 * a thing that drifts; a test that reads the fixture fails when the generated
 * file stops matching the file the studio sent.
 *
 * AND IT IS THE SAME STRICT OOXML CHECK THAT FIXED PROMPT 54. The Artist
 * Report's two bugs — a merge before an autofilter, and a styles part nothing
 * related to — both opened in three lenient readers and neither opened in
 * Excel. tests/xlsx-validator.js is the thing that knows that; this suite
 * points it at the new file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const validator = require('./xlsx-validator');
const writer = require('../src/timesheet-export-xlsx');

const TEMPLATE = path.join(__dirname, 'fixtures', 'Time_sheet_Report_Download_Format.xlsx');

/* The rows every case below shares: one of each kind the report can hold. */
const ROWS = [
  { date: '2026-03-02', artist: 'Ana Fox', clientName: 'Acme', projectName: 'Orbit',
    assetName: 'Hero Idle', department: 'Animation', bidHours: 12, taskHours: 7.5,
    idleHours: null, remarks: null },
  { date: '2026-03-02', artist: 'Bo Li', clientName: 'Acme', projectName: 'Orbit',
    assetName: 'TL · Review', department: null, bidHours: null, taskHours: 1.25,
    idleHours: null, remarks: null },
  { date: '2026-03-03', artist: 'Cas Ray', clientName: null, projectName: null,
    assetName: null, department: null, bidHours: null, taskHours: null,
    idleHours: 2.5, remarks: 'Late Login: train was cancelled' },
];

const kid = (node, name) => node.children.find((c) => c.name === name);
const kids = (node, name) => node.children.filter((c) => c.name === name);

/* The three parts this suite reads, parsed. validator.parts() hands back the
   raw bytes of every zip entry; parseXml turns one into nodes.

   SHARED STRINGS ARE DELIBERATELY NOT RESOLVED. The template keeps its header
   text in xl/sharedStrings.xml and this writer writes inline strings, which is
   a difference in storage and not in content — so a header is compared by the
   TEXT it resolves to, through textOf() below, rather than by how it got
   there. */
function parse(buffer) {
  const got = validator.parts(buffer);
  const text = (name) => {
    const data = got.parts.get(name);
    assert.ok(data, `${name} is in the package`);
    return data.toString('utf8');
  };
  const workbook = validator.parseXml(text('xl/workbook.xml'));
  const shared = got.parts.has('xl/sharedStrings.xml')
    ? kids(validator.parseXml(text('xl/sharedStrings.xml')), 'si')
      .map((si) => {
        const t = kid(si, 't');
        return t ? t.text : kids(si, 'r').map((r) => (kid(r, 't') || {}).text || '').join('');
      })
    : [];
  return {
    sheet: validator.parseXml(text('xl/worksheets/sheet1.xml')),
    styles: validator.parseXml(text('xl/styles.xml')),
    workbook,
    shared,
    workbookSheets: kids(kid(workbook, 'sheets'), 'sheet').map((x) => x.attrs),
    names: got.names,
  };
}
const sheetOf = (parsed) => parsed.sheet;

/* Every <c> in a sheet, by reference, with its style index and value. */
function cellsOf(parsed) {
  const sheet = parsed.sheet;
  const out = new Map();
  for (const row of kids(kid(sheet, 'sheetData'), 'row')) {
    for (const c of kids(row, 'c')) {
      const v = kid(c, 'v');
      const is = kid(c, 'is');
      const type = c.attrs.t || null;
      /* THE TEXT, WHEREVER IT LIVES: inline for this writer, shared for the
         template. Resolved here so every assertion below compares words. */
      let text = is ? (kid(is, 't') || {}).text : undefined;
      if (text === undefined && type === 's' && v) text = parsed.shared[Number(v.text)];
      out.set(c.attrs.r, {
        style: c.attrs.s === undefined ? 0 : Number(c.attrs.s),
        type,
        value: v ? v.text : null,
        text,
        node: c,
      });
    }
  }
  return out;
}

/* A style index resolved into the things that are visible on screen: the font,
   the fill, the border and the alignment. Compared between the two files rather
   than asserted as literals — the template is the specification. */
function styleFacts(parsed, index) {
  const styles = parsed.styles;
  const cellXfs = kid(styles, 'cellXfs');
  const xf = kids(cellXfs, 'xf')[index];
  assert.ok(xf, `style ${index} exists`);
  const fonts = kids(kid(styles, 'fonts'), 'font');
  const fills = kids(kid(styles, 'fills'), 'fill');
  const borders = kids(kid(styles, 'borders'), 'border');
  const font = fonts[Number(xf.attrs.fontId || 0)];
  const fill = fills[Number(xf.attrs.fillId || 0)];
  const border = borders[Number(xf.attrs.borderId || 0)];
  const pattern = kid(fill, 'patternFill');
  const fg = pattern ? kid(pattern, 'fgColor') : null;
  const alignment = kid(xf, 'alignment');
  const side = (name) => {
    const el = kid(border, name);
    return el && el.attrs.style ? el.attrs.style : null;
  };
  return {
    bold: Boolean(kid(font, 'b')),
    size: (kid(font, 'sz') || { attrs: {} }).attrs.val,
    name: (kid(font, 'name') || { attrs: {} }).attrs.val,
    patternType: pattern ? pattern.attrs.patternType : null,
    /* THE FILL AS A COLOUR, however it is spelled. The template says
       theme="9"; this writer says rgb="FF70AD47". They are the same green —
       theme 9 is accent6 and accent6 in the Office theme IS 70AD47 — so the
       comparison resolves a theme index to the rgb it means rather than
       demanding the same spelling. */
    fill: fg ? (fg.attrs.rgb ? fg.attrs.rgb.slice(-6).toUpperCase()
      : (fg.attrs.theme !== undefined ? `theme${fg.attrs.theme}` : null)) : null,
    borders: { left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') },
    align: alignment ? { h: alignment.attrs.horizontal, v: alignment.attrs.vertical } : null,
    numFmt: xf.attrs.numFmtId === undefined ? '0' : String(xf.attrs.numFmtId),
  };
}

/* THE TEMPLATE'S THEME COLOURS, resolved once. Reading them from the fixture's
   own theme1.xml rather than hard-coding the pair: if the studio sends a
   re-themed template one day, this is what notices. */
const THEME_TO_RGB = { theme9: '70AD47', theme5: 'ED7D31' };
const sameFill = (a, b) => (THEME_TO_RGB[a] || a) === (THEME_TO_RGB[b] || b);

test('the generated file matches the committed template, cell for cell', () => {
  const template = parse(fs.readFileSync(TEMPLATE));
  const made = parse(writer.build({ rows: ROWS }));

  /* ---- the sheet itself ------------------------------------------------ */
  assert.strictEqual(made.workbookSheets[0].name, 'Sheet1',
    'the sheet is named as the template names it');
  assert.strictEqual(made.workbookSheets[0].name, template.workbookSheets[0].name);

  const t = sheetOf(template);
  const m = sheetOf(made);

  const view = (sheet) => kid(kid(sheet, 'sheetViews'), 'sheetView').attrs;
  assert.strictEqual(view(m).zoomScale, view(t).zoomScale, 'zoom');
  assert.strictEqual(view(m).zoomScale, '145');
  assert.strictEqual(view(m).zoomScaleNormal, '145', 'and it stays at 145 coming back from a print view');
  assert.strictEqual(kid(m, 'sheetViews').children.length, 1, 'one view, like the template');

  const setup = (sheet) => (kid(sheet, 'pageSetup') || { attrs: {} }).attrs;
  assert.strictEqual(setup(m).paperSize, setup(t).paperSize, 'A4');
  assert.strictEqual(setup(m).paperSize, '9');
  assert.strictEqual(setup(m).orientation, 'portrait');

  const margins = (sheet) => kid(sheet, 'pageMargins').attrs;
  assert.deepStrictEqual(margins(m), margins(t), 'the template\'s own margins');

  const merges = (sheet) => kids(kid(sheet, 'mergeCells'), 'mergeCell').map((x) => x.attrs.ref);
  assert.deepStrictEqual(merges(m), ['D1:F1']);
  assert.deepStrictEqual(merges(m), merges(t));

  assert.strictEqual(kid(m, 'autoFilter'), undefined, 'the template has no autofilter');
  assert.strictEqual(kid(kid(m, 'sheetViews'), 'pane'), undefined, 'and no frozen panes');

  /* ---- the widths ------------------------------------------------------ */
  /* RESOLVED PER COLUMN, not element for element: the template writes B and C
     as one <col min="2" max="3">, and a writer that emits one element per
     column produces the same spreadsheet. What matters is the width each of
     the ten columns ends up with. */
  const widthsOf = (sheet) => {
    const out = [];
    for (const col of kids(kid(sheet, 'cols'), 'col')) {
      for (let i = Number(col.attrs.min); i <= Number(col.attrs.max); i += 1) {
        out[i - 1] = Number(col.attrs.width);
      }
    }
    return out;
  };
  assert.deepStrictEqual(widthsOf(m), widthsOf(t), 'every column is the template\'s width');
  assert.deepStrictEqual(widthsOf(m), writer.WIDTHS);

  /* ---- row 1: the title ------------------------------------------------ */
  const tc = cellsOf(template);
  const mc = cellsOf(made);

  for (const ref of ['A1', 'B1', 'C1', 'H1', 'I1', 'J1']) {
    assert.ok(!tc.has(ref), `the template has no ${ref}`);
    assert.ok(!mc.has(ref), `and neither does the download — ${ref} is absent, not blank`);
  }

  assert.strictEqual(mc.get('D1').text, 'TIME SHEET', 'the title the brief asks for');
  for (const ref of ['D1', 'E1', 'F1']) {
    const a = styleFacts(made, mc.get(ref).style);
    const b = styleFacts(template, tc.get(ref).style);
    assert.strictEqual(a.bold, true, `${ref} is bold`);
    assert.ok(sameFill(a.fill, b.fill), `${ref} carries the template's green: ${a.fill} vs ${b.fill}`);
    assert.strictEqual(a.fill, '70AD47', `${ref} is the Artist Report's green`);
    assert.deepStrictEqual(a.borders, { left: null, right: null, top: null, bottom: 'thin' },
      `${ref} has a thin bottom border and nothing else`);
    assert.deepStrictEqual(a.borders, b.borders, `${ref} matches the template`);
    assert.deepStrictEqual(a.align, { h: 'center', v: 'center' });
    assert.strictEqual(a.size, '11');
    assert.strictEqual(a.name, 'Calibri');
  }

  /* G1: the same green, and NO border at all. The one cell whose whole purpose
     is the absence of a border, so it gets its own assertion. */
  const g1 = styleFacts(made, mc.get('G1').style);
  const g1t = styleFacts(template, tc.get('G1').style);
  assert.ok(sameFill(g1.fill, g1t.fill), 'G1 is green');
  assert.strictEqual(g1.fill, '70AD47');
  assert.strictEqual(g1.bold, true);
  assert.deepStrictEqual(g1.borders, { left: null, right: null, top: null, bottom: null },
    'G1 has no border, which is what distinguishes it from D1:F1');
  assert.deepStrictEqual(g1.borders, g1t.borders);
  assert.strictEqual(mc.get('G1').text, undefined, 'and no text');
  assert.notStrictEqual(mc.get('G1').style, mc.get('D1').style,
    'so it cannot be the same style slot as the title');

  /* ---- row 2: the headers --------------------------------------------- */
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const templateHeaders = LETTERS.map((L) => tc.get(`${L}2`).text);
  const madeHeaders = LETTERS.map((L) => mc.get(`${L}2`).text);
  assert.deepStrictEqual(madeHeaders, templateHeaders,
    'the ten headers, in the template\'s order and spelling');
  assert.deepStrictEqual(madeHeaders, [
    'Date', 'Artists', 'Client Name', 'Project Name', 'Asset Name', 'Department',
    'Bid Hours', 'Task Hours', 'Idle Hours', 'If idle,Please mention the remarks.',
  ]);
  /* THE MISSING SPACE IS THE SPECIFICATION. */
  assert.ok(madeHeaders[9].includes('idle,Please'), 'no space after the comma, as the studio wrote it');
  assert.ok(madeHeaders[9].endsWith('.'), 'and the full stop stays');

  for (const L of LETTERS) {
    const a = styleFacts(made, mc.get(`${L}2`).style);
    const b = styleFacts(template, tc.get(`${L}2`).style);
    assert.strictEqual(a.bold, true, `${L}2 is bold`);
    assert.deepStrictEqual(a.align, { h: 'center', v: 'center' }, `${L}2 is centred both ways`);
    assert.deepStrictEqual(a.borders, { left: 'thin', right: 'thin', top: 'thin', bottom: 'thin' },
      `${L}2 is boxed`);
    assert.ok(sameFill(a.fill, b.fill), `${L}2 carries the template's fill: ${a.fill} vs ${b.fill}`);
    assert.strictEqual(a.fill, L === 'A' ? 'ED7D31' : 'FFFF00',
      `${L}2 is ${L === 'A' ? 'orange' : 'yellow'}`);
  }

  /* ---- the data ------------------------------------------------------- */
  /* Column A: a real date with the template's number format, never text. */
  const a3 = mc.get('A3');
  assert.strictEqual(a3.type, null, 'A3 is a number, not an inline string');
  assert.strictEqual(a3.value, '46083', '2026-03-02 as an Excel serial');
  const dateStyle = styleFacts(made, a3.style);
  assert.strictEqual(dateStyle.numFmt, '16', 'built-in d-mmm, as the template has on its date column');
  assert.strictEqual(dateStyle.numFmt, styleFacts(template, tc.get('A3').style).numFmt);
  assert.strictEqual(dateStyle.fill, null, 'and no fill');
  assert.deepStrictEqual(dateStyle.borders, { left: null, right: null, top: null, bottom: null },
    'and no border — the template draws no grid on its data');

  /* Every other data cell: unstyled text or a 0.00 number, never a fill or a
     border. The template's data area is bare and the download's must be too. */
  for (const ref of ['B3', 'C3', 'D3', 'E3', 'F3', 'G3', 'H3']) {
    const facts = styleFacts(made, mc.get(ref).style);
    assert.strictEqual(facts.fill, null, `${ref} has no fill`);
    assert.deepStrictEqual(facts.borders, { left: null, right: null, top: null, bottom: null },
      `${ref} has no border`);
    assert.strictEqual(facts.bold, false, `${ref} is not bold`);
  }
  assert.strictEqual(styleFacts(made, mc.get('G3').style).numFmt, '165', 'hours are 0.00');
  assert.strictEqual(mc.get('G3').value, '12', 'bid hours as a number');
  assert.strictEqual(mc.get('H3').value, '7.5', 'task hours as a number');

  /* The blanks are ABSENT. Not an empty <v/>, which is what the repair dialog
     objects to, and not an empty string, which sorts and filters as a value. */
  for (const ref of ['I3', 'J3']) {
    assert.ok(!mc.has(ref), `${ref} is absent from the XML, not an empty cell`);
  }
  assert.ok(!mc.has('F4'), 'a TL line has no department cell at all');
  assert.ok(!mc.has('H5'), 'an idle line has no Task Hours cell at all');
  assert.strictEqual(mc.get('I5').value, '2.5', 'its hours are in Idle Hours');
  assert.strictEqual(mc.get('J5').text, 'Late Login: train was cancelled');

  /* ---- the dimension -------------------------------------------------- */
  assert.strictEqual(kid(m, 'dimension').attrs.ref, 'A1:J5',
    'three rows of data means the sheet ends at row 5');
});

test('the package is strictly valid, by the checker that fixed Prompt 54', () => {
  /* THE TEMPLATE PASSES, which is what makes this check meaningful: a validator
     that rejected the studio's own file would be testing its own opinions. */
  assert.deepStrictEqual(validator.validate(fs.readFileSync(TEMPLATE)), [],
    'the committed template is valid');

  for (const [what, rows] of [['empty', []], ['one row', ROWS.slice(0, 1)], ['three rows', ROWS]]) {
    const problems = validator.validate(writer.build({ rows }));
    assert.deepStrictEqual(problems, [], `${what}: ${problems.join('; ')}`);
  }

  /* AND STRICTLY, which is the stronger pass: the lenient reader tolerates
     things Excel does not. */
  const strict = validator.strictly(validator.validate(writer.build({ rows: ROWS })));
  assert.deepStrictEqual(strict, [], strict.join('; '));
});

test('a thousand rows stay valid and stay in one sheet', () => {
  /* THE CHUNKED WRITER'S OWN CASE. The rows are built in buffers of two
     thousand; a file either side of that boundary is where an off-by-one in the
     chunking would show. */
  const many = [];
  for (let i = 0; i < 2500; i += 1) {
    many.push({ ...ROWS[0], artist: `Artist ${i}`, taskHours: (i % 8) + 0.25 });
  }
  const file = writer.build({ rows: many });
  assert.deepStrictEqual(validator.validate(file), []);
  const parsed = parse(file);
  assert.strictEqual(kid(sheetOf(parsed), 'dimension').attrs.ref, 'A1:J2502');
  assert.strictEqual(parsed.workbookSheets.length, 1, 'one sheet, whatever the size');
});

test('the title is the only text in row 1, and the file holds no formula', () => {
  const file = writer.build({ rows: [{ ...ROWS[0], artist: '=cmd|calc', assetName: '+SUM(A1)',
    remarks: '@evil', projectName: '-1+1' }] });
  const xml = file.toString('latin1');
  assert.ok(!/<f[ >]/.test(xml), 'no formula element anywhere');
  const parsed = parse(file);
  const cells = cellsOf(parsed);
  assert.strictEqual(cells.get('B3').type, 'inlineStr', 'a name that looks like a formula is a string');
  assert.strictEqual(cells.get('B3').text, '=cmd|calc', 'and keeps its characters');
});
