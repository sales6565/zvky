// THE TIMESHEET DOWNLOAD, AS THE ATTACHED SPREADSHEET.
//
// ===========================================================================
// THE FORMAT IS THE SPECIFICATION, and it was measured off the file rather than
// taken from the brief. tests/fixtures/Time_sheet_Report_Download_Format.xlsx,
// unzipped:
//
//   sheet    named "Sheet1". zoomScale and zoomScaleNormal 145. A4 portrait
//            (paperSize 9). The template's own margins, which are Excel's
//            defaults. No autofilter, no freeze panes, no totals row.
//   row 1    D1:F1 merged — bold, centred both ways, solid fill theme 9, thin
//            BOTTOM border only. G1 the same fill and font with NO border at
//            all. A1:C1 and H1:J1 absent and unstyled.
//   row 2    ten headers, bold Calibri 11, centred both ways, thin border on
//            all four sides. A2 fill theme 5; B2..J2 fill FFFF00.
//   widths   12, 13.140625, 13.140625, 12.42578125, 15, 11.85546875,
//            11.85546875, 10.42578125, 11.7109375, 33.85546875 — written to the
//            template's full precision rather than the brief's rounded 13.14,
//            so the comparison against the fixture is exact.
//   column A built-in number format 16 (d-mmm) on every data row.
//
// THE THEME COLOURS RESOLVED, from the same file's xl/theme/theme1.xml: a
// fgColor theme index counts lt1, dk1, lt2, dk2, accent1..accent6, so theme 9
// is accent6 = 70AD47 (green) and theme 5 is accent2 = ED7D31 (orange) — which
// is exactly what the brief asked for in RGB, and exactly what the Artist
// Report already uses. Written as RGB on purpose: a theme index means whatever
// the opening workbook's theme says it means, and a studio with a different
// Office theme would get different colours for the same report.
//
// TWO DELIBERATE DEPARTURES FROM THE TEMPLATE, both from the brief:
//   the title in D1 is "TIME SHEET", where the template carries the
//      placeholder "TIME SHEET DOWNLOADING FORMAT";
//   the eight empty pre-styled rows the template keeps under its headers are
//      not reproduced — a file with no data has no data rows.
//
// EVERY BLANK IS ABSENT FROM THE XML. Not an empty <v/>, which is what Excel's
// repair dialog objects to, and not an empty inline string, which is a value
// that looks blank but sorts and filters as one. The template's own data cells
// carry no borders, so there is nothing for a styled blank to hold up.

const kit = require('./xlsx-sheet');

const SHEET_NAME = 'Sheet1';
const TITLE = 'TIME SHEET';

/* The ten columns, in the template's order, with the fill its header carries
   and how the value is written. `blank` for every one of them, because the
   template draws no grid on the data. */
const COLUMNS = [
  { key: 'date',       header: 'Date',        width: 12,          fill: 'orange', kind: 'date' },
  { key: 'artist',     header: 'Artists',     width: 13.140625,   fill: 'yellow', kind: 'text' },
  { key: 'clientName', header: 'Client Name', width: 13.140625,   fill: 'yellow', kind: 'text' },
  { key: 'projectName', header: 'Project Name', width: 12.42578125, fill: 'yellow', kind: 'text' },
  { key: 'assetName',  header: 'Asset Name',  width: 15,          fill: 'yellow', kind: 'text' },
  { key: 'department', header: 'Department',  width: 11.85546875, fill: 'yellow', kind: 'text' },
  { key: 'bidHours',   header: 'Bid Hours',   width: 11.85546875, fill: 'yellow', kind: 'hours' },
  { key: 'taskHours',  header: 'Task Hours',  width: 10.42578125, fill: 'yellow', kind: 'hours' },
  { key: 'idleHours',  header: 'Idle Hours',  width: 11.7109375,  fill: 'yellow', kind: 'hours' },
  /* THE EXACT STRING FROM THE TEMPLATE, missing space after the comma and
     trailing full stop included. It is what the studio reads across the top of
     the column they fill in by hand, and a tidied-up version would be a
     different file from the one they asked for. */
  { key: 'remarks',    header: 'If idle,Please mention the remarks.', width: 33.85546875,
    fill: 'yellow', kind: 'text' },
];

const COL = kit.LETTERS.slice(0, COLUMNS.length);

/* Style slots, in the order they go into cellXfs. Named rather than numbered at
   the point of use: an off-by-one in a style index is a bug nobody can see in
   the code and everybody can see in the file. */
const S = {
  DEFAULT: 0,      // Calibri 11, nothing else — every text data cell
  TITLE: 1,        // D1:F1 — green, bottom border
  TITLE_PLAIN: 2,  // G1 — the same green, no border at all
  HEAD_YELLOW: 3,
  HEAD_ORANGE: 4,
  DATE: 5,         // built-in format 16, d-mmm, no fill and no border
  HOURS: 6,        // 0.00, no fill and no border
};

/* numFmt 16 is built in (d-mmm) and needs no declaration; 165 is ours.
   The empty <dxfs> and <tableStyles> are what Excel's own writer puts in every
   styles part it makes, and tests/xlsx-package.test.js compares the shape of
   this part against a file Excel wrote. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="165" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF70AD47"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFED7D31"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="16" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

/* Hours, to two decimals, as a NUMBER. Rounded here rather than left to the
   number format: 0.00 would DISPLAY 7.5 as 7.50 while the cell still held
   7.499999, and anybody summing the column would get a total that disagreed
   with the column. */
const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
};

function cellFor(ref, column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (column.kind === 'date') {
    return kit.dateCell(ref, S.DATE, value) || '';
  }
  if (column.kind === 'hours') {
    const n = round2(value);
    return n === null ? '' : kit.number(ref, S.HOURS, n);
  }
  return kit.text(ref, S.DEFAULT, value);
}

/* The worksheet. The child order is src/xlsx-sheet.js's business; what is
   decided here is the content of each piece. */
function sheetXml(rows, { title = TITLE } = {}) {
  const last = Math.max(rows.length + 2, 2);
  /* THE TEMPLATE'S WIDTHS, FIXED. The Artist Report widens a column to fit its
     longest value; this one does not, because the studio prints this file and
     a column that moved with the data would not line up with the copy they
     filled in by hand last month. */
  const cols = kit.colsXml(COLUMNS.map((c, i) => ({
    width: c.width,
    /* bestFit on the nine the template marks, which is every one but G. It is
       advisory — Excel uses it to decide whether a double-click resizes — and
       it is in the fixture, so it is here. */
    bestFit: i !== 6,
  })));

  const titleRow = `<row r="1">`
    + kit.text('D1', S.TITLE, title)
    + `<c r="E1" s="${S.TITLE}"/><c r="F1" s="${S.TITLE}"/>`
    + `<c r="G1" s="${S.TITLE_PLAIN}"/>`
    + '</row>';
  const headRow = `<row r="2">${COLUMNS.map((c, i) =>
    kit.text(`${COL[i]}2`, c.fill === 'orange' ? S.HEAD_ORANGE : S.HEAD_YELLOW, c.header)
  ).join('')}</row>`;

  const chunks = kit.chunkRows(rows, (row, index) => {
    const r = index + 3;
    return `<row r="${r}">${COLUMNS.map((c, i) => cellFor(`${COL[i]}${r}`, c, row[c.key])).join('')}</row>`;
  });

  return kit.sheet({
    dimension: `A1:${COL[COL.length - 1]}${last}`,
    /* ZOOM 145, both attributes, as the template has them: zoomScale is what
       this view shows and zoomScaleNormal is what it returns to from a page
       layout view. Excel writes both and a file with only the first opens at
       145 and snaps back to 100. */
    views: '<sheetViews><sheetView tabSelected="1" zoomScale="145" zoomScaleNormal="145" '
      + 'workbookViewId="0"/></sheetViews>',
    cols,
    headRows: [titleRow, headRow],
    rowChunks: chunks,
    mergeCells: ['D1:F1'],
    /* A4 PORTRAIT. paperSize 9 is A4; no r:id, because the template's
       pageSetup points at a printerSettings part this writer does not ship —
       and a relationship to a part that is not in the package is the other half
       of the Prompt 54 bug. */
    pageSetup: '<pageSetup paperSize="9" orientation="portrait"/>',
  });
}

/* The whole file. `rows` are already shaped and sorted by
   src/timesheet-export.js; nothing here decides what is in the report, only
   what it looks like. */
function build({ rows = [], title = TITLE } = {}) {
  return kit.workbook({ sheetName: SHEET_NAME, styles: STYLES, sheetXml: sheetXml(rows, { title }) });
}

module.exports = {
  build, sheetXml, STYLES, COLUMNS, SHEET_NAME, TITLE, STYLE_INDEX: S, round2,
  HEADERS: COLUMNS.map((c) => c.header),
  WIDTHS: COLUMNS.map((c) => c.width),
};
