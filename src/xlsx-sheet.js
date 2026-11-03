// THE WORKBOOK WRITER BOTH REPORTS USE.
//
// ===========================================================================
// WHY THIS FILE EXISTS. The Artist Report (Prompts 53–54) learned the hard way
// what Excel insists on, and the lessons are not in its column list — they are
// in the shape of the package: the order of the children inside <worksheet>,
// the relationship that reaches styles.xml, the content types, the absence of
// any <f> element, dates as serials with a date style. Writing a second report
// with its own copy of that would be writing the same bugs again, and Prompt 62
// says so in as many words: reuse the writer, do not write a second one.
//
// So the knowledge lives here and the two reports differ only in what they
// legitimately differ in — their columns, their styles and their title.
//
// WHAT IS SHARED
//   dateSerial      a calendar day as an Excel serial, from a 'YYYY-MM-DD'
//                   string and never from a Date (see the note on it);
//   cell builders   blank, text, number and date, each taking the style index
//                   the caller's own style table assigns;
//   colsXml         the <cols> block;
//   sheet()         the whole worksheet part, with the children in the order
//                   ECMA-376 §18.3.1.99 requires — the order Prompt 53 got
//                   wrong, which Excel rejected and three lenient readers
//                   happily opened;
//   workbook()      the zip: content types, both relationship parts, the
//                   workbook, the styles and the sheet.
//
// WHAT IS NOT SHARED, deliberately: the style table. The two reports draw
// different things — the Artist Report borders every data cell, the Timesheet
// template leaves them bare — and a "universal" style table would be a third
// thing that matched neither template. Each report writes its own cellXfs and
// tells this module which index means what.

const { zip, xmlText } = require('./ooxml-zip');

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

/* An Excel date serial from a 'YYYY-MM-DD' string.
 *
 * A STRING, NOT A Date, AND THAT IS THE POINT. Both reports ask MySQL for
 * DATE_FORMAT(..., '%Y-%m-%d'), so the calendar day in the file is the calendar
 * day the database compared the range against. Handing a JS Date to a serial
 * calculation reintroduces the timezone question this avoids: a line entered at
 * 00:30 local is the previous day in UTC, and the file would then disagree with
 * the filter that selected it.
 *
 * The epoch is 1899-12-30, not 1900-01-01, which absorbs the 1900 leap-year bug
 * Excel keeps for compatibility — correct for every date from 1900-03-01. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function dateSerial(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  const days = (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - EXCEL_EPOCH_UTC) / 86400000;
  return Number.isFinite(days) ? days : null;
}

/* ---- cells ---------------------------------------------------------------
 *
 * TEXT IS ALWAYS A STRING, never a formula. Written as an inline string with
 * t="inlineStr", so a name of "=1+1" or "+cmd" or "@SUM(A1)" is a value: there
 * is no <f> element anywhere in this module, which is a stronger guarantee than
 * escaping a leading character and hoping.
 *
 * A BLANK IS EITHER A STYLED CELL OR NOTHING AT ALL, and which one is the
 * caller's decision rather than this module's. The Artist Report needs the
 * styled kind, because its grid is drawn with borders and a missing cell is a
 * hole in it. The Timesheet template has no borders on its data, so a blank
 * there must be ABSENT from the XML — not an empty <v/>, which is the thing
 * Excel's repair dialog complains about, and not an empty inline string, which
 * is a value that looks blank and sorts and filters as one. */
const blank = (ref, style) => (style === null || style === undefined ? '' : `<c r="${ref}" s="${style}"/>`);
const text = (ref, style, value) => `<c r="${ref}" s="${style}" t="inlineStr">`
  + `<is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
const number = (ref, style, value) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
const dateCell = (ref, style, value) => {
  const serial = dateSerial(value);
  return serial === null ? null : `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
};

const colsXml = (widths) => `<cols>${widths.map((w, i) => {
  const width = typeof w === 'number' ? w : w.width;
  const extra = (typeof w === 'object' && w.bestFit) ? ' bestFit="1"' : '';
  return `<col min="${i + 1}" max="${i + 1}" width="${width}"${extra} customWidth="1"/>`;
}).join('')}</cols>`;

/* ---- the worksheet -------------------------------------------------------
 *
 * THE ORDER OF THE CHILDREN IS THE SCHEMA'S, NOT A PREFERENCE.
 *
 * CT_Worksheet (ECMA-376 Part 1 §18.3.1.99) is a SEQUENCE: sheetPr, dimension,
 * sheetViews, sheetFormatPr, cols, sheetData, sheetCalcPr, sheetProtection, …,
 * autoFilter (11th), …, mergeCells (15th), …, pageMargins, pageSetup. Prompt 53
 * wrote the merge before the autofilter; Excel validated the sequence, rejected
 * the whole worksheet part, offered to repair the file and then showed a blank
 * sheet. Nothing caught it, because every reader we had skips to the elements it
 * wants: `unzip` has no opinion, SheetJS finds them by regex, and LibreOffice
 * was built to open other people's broken files.
 *
 * So the pieces arrive here as named fields and this function decides the
 * order. A caller cannot get it wrong without changing this file, and
 * tests/xlsx-validator.js checks the result against the sequence anyway.
 */
function sheet({
  dimension, views, formatPr = '<sheetFormatPr defaultRowHeight="15"/>',
  cols, headRows = [], rowChunks = [], autoFilter = null, mergeCells = [],
  pageMargins = '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
  pageSetup = null,
}) {
  const head = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dimension}"/>`
    + views
    + formatPr
    + cols
    + '<sheetData>'
    + headRows.join(''), 'utf8');
  const tail = Buffer.from('</sheetData>'
    + (autoFilter ? `<autoFilter ref="${autoFilter}"/>` : '')
    + (mergeCells.length
      ? `<mergeCells count="${mergeCells.length}">${mergeCells.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`
      : '')
    + pageMargins
    + (pageSetup || '')
    + '</worksheet>', 'utf8');
  return Buffer.concat([head, ...rowChunks, tail]);
}

/* Data rows, in chunks. Joined every few thousand and turned into a Buffer, so
   the peak is a few megabytes rather than one string holding a 100,000-row
   file. */
function chunkRows(rows, renderRow, perChunk = 2000) {
  const chunks = [];
  let pending = [];
  rows.forEach((row, index) => {
    pending.push(renderRow(row, index));
    if (pending.length >= perChunk) { chunks.push(Buffer.from(pending.join(''), 'utf8')); pending = []; }
  });
  if (pending.length) chunks.push(Buffer.from(pending.join(''), 'utf8'));
  return chunks;
}

/* ---- the package --------------------------------------------------------- */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

/* THE WORKBOOK'S RELATIONSHIPS, AND WHY styles.xml IS HERE.
 *
 * Shipping it without this line is the bug Prompt 54 fixed. xl/styles.xml was
 * in the zip and declared in [Content_Types].xml, and nothing related to it —
 * and Excel reaches the styles part through this relationship, not by its name.
 * An orphaned styles part means every cell's s="4" points into a table Excel
 * never loaded: the repair dialog, and then a blank sheet. Every lenient reader
 * looks the part up by name instead, which is why nothing caught it.
 * tests/xlsx-validator.js walks the whole relationship graph now. */
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

function workbookXml({ sheetName, definedNames = '' }) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + '<bookViews><workbookView/></bookViews>'
    + `<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + definedNames
    + '</workbook>';
}

/* The five parts every workbook this application writes is made of. One sheet,
   because neither report has ever wanted two and an unreferenced part is the
   other half of the Prompt 54 bug. */
function workbook({ sheetName, styles, sheetXml, definedNames = '' }) {
  return zip([
    { name: '[Content_Types].xml', contents: CONTENT_TYPES },
    { name: '_rels/.rels', contents: ROOT_RELS },
    { name: 'xl/workbook.xml', contents: workbookXml({ sheetName, definedNames }) },
    { name: 'xl/_rels/workbook.xml.rels', contents: WORKBOOK_RELS },
    { name: 'xl/styles.xml', contents: styles },
    { name: 'xl/worksheets/sheet1.xml', contents: sheetXml },
  ]);
}

module.exports = {
  LETTERS, dateSerial, blank, text, number, dateCell, colsXml, sheet, chunkRows,
  workbook, workbookXml, CONTENT_TYPES, ROOT_RELS, WORKBOOK_RELS, xmlText,
};
