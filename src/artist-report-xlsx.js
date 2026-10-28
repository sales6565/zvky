/* THE ARTIST REPORT, AS THE ATTACHED SPREADSHEET.
 *
 * ===========================================================================
 * THE FORMAT IS THE SPECIFICATION, and it was read off the file rather than
 * from the brief. Artist_Report_Download_Format.xlsx, unzipped:
 *
 *   row 1    D1:F1 merged, bold, centred both ways, thin BOTTOM border only,
 *            solid fill theme 9. The template's text is the placeholder
 *            "DOWNLOADING FORMAT"; the real title goes here.
 *   row 2    nine headers. Bold Calibri 11, centred both ways, thin border on
 *            all four sides. Solid fill FFFF00 on seven of them; fill theme 5
 *            on Department (C) and Submit Date (F).
 *   widths   A 12, B 13.14, C 11.71, D 12.43, E 15, F 11.86, G 9.43, H 11.71,
 *            I 13.14.
 *
 * THE THEME COLOURS RESOLVED, from the same file's xl/theme/theme1.xml: a
 * fgColor theme index counts lt1, dk1, lt2, dk2, accent1..accent6, so theme 9
 * is accent6 = 70AD47 (green) and theme 5 is accent2 = ED7D31 (orange). Written
 * here as explicit RGB, which the brief asked for and which is the right call
 * regardless: a theme index means whatever the workbook's theme says it means,
 * and a studio opening this in a differently-themed Excel would get different
 * colours for the same report.
 *
 * WRITTEN AS OOXML RATHER THAN THROUGH THE PROJECT'S XLSX LIBRARY, because that
 * library cannot write styles at all — see the header of src/ooxml-zip.js for
 * the measurement. Everything the template needs is a style.
 *
 * WHAT IS DELIBERATELY NOT THE TEMPLATE: the sheet is named "Artist Report"
 * rather than "Sheet1", the title carries the date range, and there are freeze
 * panes and an autofilter. All four were asked for; the first three are
 * cosmetic and the fourth only exists once there are rows to filter.
 */
const { zip, xmlText } = require('./ooxml-zip');

const COLUMNS = [
  { key: 'clientName',   header: 'Client Name',    width: 12,    kind: 'text',   fill: 'yellow' },
  { key: 'projectName',  header: 'Project Name',   width: 13.14, kind: 'text',   fill: 'yellow' },
  { key: 'department',   header: 'Department',     width: 11.71, kind: 'text',   fill: 'orange' },
  { key: 'assetName',    header: 'Assets Name',    width: 12.43, kind: 'text',   fill: 'yellow' },
  { key: 'resourceName', header: 'Resource Name',  width: 15,    kind: 'text',   fill: 'yellow' },
  { key: 'submitDate',   header: 'Submit Date',    width: 11.86, kind: 'date',   fill: 'orange' },
  { key: 'bidHours',     header: 'Bid Hours',      width: 9.43,  kind: 'number', fill: 'yellow' },
  { key: 'spentHours',   header: 'Spent Hours',    width: 11.71, kind: 'number', fill: 'yellow' },
  { key: 'efficiency',   header: 'Efficiency (%)', width: 13.14, kind: 'tenth',  fill: 'yellow' },
];

const SHEET_NAME = 'Artist Report';
const MAX_WIDTH = 40;          // wider than this is wrapped instead
const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/* Style slots, in the order they go into cellXfs. Named rather than numbered at
   the point of use, because an off-by-one in a style index is a bug nobody can
   see in the code and everybody can see in the file. */
const S = {
  DEFAULT: 0,
  TITLE: 1,
  HEAD_YELLOW: 2,
  HEAD_ORANGE: 3,
  TEXT: 4,
  TEXT_WRAP: 5,
  DATE: 6,
  NUMBER: 7,
  TENTH: 8,
  BLANK: 9,
};

/* ---- the fixed parts ---------------------------------------------------- */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/* Fills, borders, fonts and the ten cell formats. The numbers below are the
   indices the sheet refers to; see S above. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/><numFmt numFmtId="165" formatCode="0.00"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts><fonts count="2"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF70AD47"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFED7D31"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/* ---- values ------------------------------------------------------------- */

/* An Excel date serial from a 'YYYY-MM-DD' string.
 *
 * A STRING, NOT A Date, AND THAT IS THE POINT. The query asks MySQL for
 * DATE_FORMAT(..., '%Y-%m-%d'), so the calendar day in the file is the calendar
 * day the database compared the range against. Handing a JS Date to a serial
 * calculation reintroduces the timezone question this avoids: a submission at
 * 00:30 local would be the previous day in UTC and the file would disagree with
 * the filter that selected it.
 *
 * The epoch is 1899-12-30, not 1900-01-01, which absorbs the 1900 leap-year bug
 * Excel keeps for compatibility — correct for every date from 1900-03-01, and
 * this report deals in submissions. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function dateSerial(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  const days = (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - EXCEL_EPOCH_UTC) / 86400000;
  return Number.isFinite(days) ? days : null;
}

/* One cell.
 *
 * TEXT IS ALWAYS A STRING, never a formula. Written as an inline string with
 * t="inlineStr", so a name of "=1+1" or "+cmd" or "@SUM(A1)" is a value: there
 * is no <f> element anywhere in this writer, which is a stronger guarantee than
 * escaping a leading character and hoping. Inline rather than shared strings
 * because the rows are written once and never looked up again, and a shared
 * table would mean holding every distinct name in memory to the end. */
function cell(ref, column, value, wrapping) {
  if (value === null || value === undefined || value === '') {
    // A blank still carries its border, or the grid has holes in it.
    const style = column.kind === 'text' ? (wrapping ? S.TEXT_WRAP : S.TEXT) : S.BLANK;
    return `<c r="${ref}" s="${style}"/>`;
  }
  if (column.kind === 'date') {
    const serial = dateSerial(value);
    if (serial === null) return `<c r="${ref}" s="${S.BLANK}"/>`;
    return `<c r="${ref}" s="${S.DATE}"><v>${serial}</v></c>`;
  }
  if (column.kind === 'number' || column.kind === 'tenth') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `<c r="${ref}" s="${S.BLANK}"/>`;
    const style = column.kind === 'tenth' ? S.TENTH : S.NUMBER;
    return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
  }
  const style = wrapping ? S.TEXT_WRAP : S.TEXT;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

/* Column widths: the template's, widened to what the content needs, capped.
 *
 * Beyond the cap the column wraps instead of growing — a 200-character asset
 * name would otherwise make one column wider than a screen and push everything
 * else off the page. */
function widthsFor(rows) {
  return COLUMNS.map((col) => {
    let longest = col.header.length;
    for (const row of rows) {
      const value = row[col.key];
      if (value === null || value === undefined) continue;
      const text = col.kind === 'date' ? 11 : String(value).length;
      const length = typeof text === 'number' ? text : text.length;
      if (length > longest) longest = length;
    }
    const wanted = Math.max(col.width, longest + 2);
    return { width: Math.min(MAX_WIDTH, Number(wanted.toFixed(2))), wrapping: wanted > MAX_WIDTH };
  });
}

/* ---- the sheet ---------------------------------------------------------- */

function sheetXml(rows, title) {
  const widths = widthsFor(rows);
  const last = rows.length + 2;
  const parts = [];
  const push = (s) => parts.push(s);

  push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:I${Math.max(last, 2)}"/>`);
  /* FROZEN BELOW THE HEADERS, so scrolling 50,000 rows keeps the column names
     on screen. ySplit="2" with topLeftCell A3 is the two-row freeze. */
  push('<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
    + '<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>');
  push('<sheetFormatPr defaultRowHeight="15"/>');
  push(`<cols>${widths.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w.width}" customWidth="1"/>`).join('')}</cols>`);
  push('<sheetData>');

  // Row 1: the title, in the merged D1:F1. The other cells of the merge carry
  // the style so the fill and the border run the whole width of it.
  push(`<row r="1"><c r="D1" s="${S.TITLE}" t="inlineStr"><is><t xml:space="preserve">${xmlText(title)}</t></is></c>`
    + `<c r="E1" s="${S.TITLE}"/><c r="F1" s="${S.TITLE}"/></row>`);

  // Row 2: the headers.
  push(`<row r="2">${COLUMNS.map((col, i) =>
    `<c r="${COL_LETTERS[i]}2" s="${col.fill === 'orange' ? S.HEAD_ORANGE : S.HEAD_YELLOW}" t="inlineStr">`
    + `<is><t xml:space="preserve">${xmlText(col.header)}</t></is></c>`).join('')}</row>`);

  /* The data, in chunks. Joined every few thousand rows and turned into a
     Buffer, so the peak is a few megabytes rather than one string holding the
     whole 50,000-row file. */
  const chunks = [];
  let pending = [];
  rows.forEach((row, index) => {
    const r = index + 3;
    pending.push(`<row r="${r}">${COLUMNS.map((col, i) =>
      cell(`${COL_LETTERS[i]}${r}`, col, row[col.key], widths[i].wrapping)).join('')}</row>`);
    if (pending.length >= 2000) { chunks.push(Buffer.from(pending.join(''), 'utf8')); pending = []; }
  });
  if (pending.length) chunks.push(Buffer.from(pending.join(''), 'utf8'));

  const head = Buffer.from(parts.join(''), 'utf8');
  const tail = Buffer.from('</sheetData>'
    + `<mergeCells count="1"><mergeCell ref="D1:F1"/></mergeCells>`
    /* THE AUTOFILTER IS ON THE HEADER ROW, and on the data if there is any. An
       empty report still gets one on row 2 alone: the brief asks for a file
       with the title and headers, and a header row that cannot be filtered is a
       different file from the one with rows in it. */
    + `<autoFilter ref="A2:I${Math.max(last, 2)}"/>`
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>', 'utf8');
  return Buffer.concat([head, ...chunks, tail]);
}

/* The whole file. `rows` are already shaped and sorted by src/artist-report.js;
   nothing here decides what is in the report, only what it looks like. */
function build({ rows = [], title = 'ARTIST REPORT' } = {}) {
  return zip([
    { name: '[Content_Types].xml', contents: CONTENT_TYPES },
    { name: '_rels/.rels', contents: ROOT_RELS },
    { name: 'xl/workbook.xml', contents: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', contents: WORKBOOK_RELS },
    { name: 'xl/styles.xml', contents: STYLES },
    { name: 'xl/worksheets/sheet1.xml', contents: sheetXml(rows, title) },
  ]);
}

module.exports = {
  build, sheetXml, dateSerial, widthsFor,
  COLUMNS, SHEET_NAME, MAX_WIDTH, STYLE_INDEX: S,
  HEADERS: COLUMNS.map((c) => c.header),
};
