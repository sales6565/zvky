// The efficiency report as a document.
//
// This may be the only part of the app somebody outside the studio ever sees —
// a client or a board reading a PDF that was emailed to them — so it wears the
// studio's name and logo, states which slice of the work it covers, and says
// when it was made. A table of numbers with no header is not evidence of
// anything; a reader six weeks later cannot tell whether it covered one project
// or all of them.
//
// Written straight to the response stream rather than buffered: the document is
// built top to bottom and never needs revisiting, so there is nothing to gain
// from holding a whole PDF in memory before the first byte goes out.

const PDFDocument = require('pdfkit');

const MARGIN = 40;
const INK = '#1a1c22';
const MUTED = '#6b7280';
const RULE = '#d8dbe2';
const BRAND = '#7f1416';

/* On paper, not on screen. The app is dark because it is looked at all day; a
 * document is printed, forwarded and read on white, so this is a light
 * palette deliberately rather than by omission. The three efficiency bands are
 * the same three the screen uses, darkened enough to stay legible on white —
 * the reader is meant to recognise them. */
function bandColour(text) {
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return MUTED;
  if (n < 80) return '#b3261e';
  if (n < 100) return '#8a5a00';
  return '#1b6e4b';
}

const isPercentColumn = (header) => /%$/.test(header);

/* Cut a string to what will actually fit, with an ellipsis.
 *
 * pdfkit will happily wrap a long name inside a 16pt row, which draws the
 * second line on top of the row beneath it — the table then looks like a
 * printing fault rather than a report. Measuring and truncating is the only
 * way to guarantee one line per row, so that is what this does. */
function fitText(doc, text, maxWidth) {
  const str = String(text ?? '');
  if (!str) return '';
  if (doc.widthOfString(str) <= maxWidth) return str;
  const ell = '…';
  const room = maxWidth - doc.widthOfString(ell);
  if (room <= 0) return '';
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(str.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  return str.slice(0, lo).trimEnd() + ell;
}

function write(stream, opts) {
  const {
    appName, tagline, logo, view, headers, rows, filters, summary, excluded,
  } = opts;

  /* Portrait for the grouped views, which are seven or eight columns and read
     like a page. The Every Asset view is fourteen, and in portrait its last
     five columns fell off the right-hand edge — the efficiency percentages,
     which are the point of the report. So the page turns sideways when the
     table needs it to, rather than the table losing columns. */
  const landscape = headers.length > 8;
  const doc = new PDFDocument({
    size: 'A4', layout: landscape ? 'landscape' : 'portrait',
    margin: MARGIN, bufferPages: true,
  });
  doc.pipe(stream);

  const width = doc.page.width - MARGIN * 2;

  // --- the masthead ----------------------------------------------------------
  let top = MARGIN;
  /* The logo is whatever was uploaded in Settings. PDFKit reads PNG and JPEG;
     an SVG logo — which the branding module does accept — is not something it
     can place, so the name carries the header alone rather than the download
     failing over a picture. */
  if (logo && /png|jpe?g/i.test(logo.mime)) {
    try {
      doc.image(logo.buffer, MARGIN, top, { fit: [110, 34], align: 'left', valign: 'top' });
    } catch { /* a corrupt image must not cost somebody their report */ }
  }
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
    .text(appName || 'Report', MARGIN + 122, top + 2, { width: width - 122 });
  if (tagline) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(tagline, MARGIN + 122, doc.y + 1, { width: width - 122 });
  }
  top = Math.max(doc.y, top + 34) + 10;
  doc.moveTo(MARGIN, top).lineTo(MARGIN + width, top).strokeColor(BRAND).lineWidth(1.5).stroke();
  top += 14;

  // --- what this is ----------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
    .text(`Work efficiency — ${view.label}`, MARGIN, top);
  top = doc.y + 3;
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
    'Man Hours estimated divided by time tracked. Above 100% came in under the estimate. '
    + 'First pass is the work before the first submission; total includes every round of rework.',
    MARGIN, top, { width });
  top = doc.y + 10;

  // --- the filters, spelled out ---------------------------------------------
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('This report covers', MARGIN, top);
  top = doc.y + 2;
  for (const [name, value] of filters) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(`${name}: `, MARGIN, top, { continued: true });
    doc.font('Helvetica').fillColor(INK).text(String(value));
    top = doc.y + 1;
  }
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('Generated: ', MARGIN, top + 1, { continued: true });
  doc.font('Helvetica').fillColor(INK).text(opts.generatedAt || require('./report-export').stamp());
  top = doc.y + 12;

  // --- the headline numbers --------------------------------------------------
  const boxW = width / summary.length;
  doc.rect(MARGIN, top, width, 34).fillColor('#f4f5f7').fill();
  summary.forEach(([label, value], i) => {
    const x = MARGIN + i * boxW;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(String(value), x + 6, top + 6, { width: boxW - 12 });
    doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
      .text(String(label).toUpperCase(), x + 6, top + 21, { width: boxW - 12 });
  });
  top += 46;

  // --- the table -------------------------------------------------------------
  /* Column widths from what the column actually holds.
   *
   * Measured, not guessed from the header's length: "Assets Name" is a short
   * header over long values, and "First-pass hours" is the reverse. Each column
   * asks for the width of its widest cell (sampling the first 200 rows — enough
   * to be representative, cheap enough not to matter), and if the total exceeds
   * the page every column is scaled down together so the table still fits.
   * Nothing is ever dropped off the edge; the longest values ellipsis instead. */
  const numeric = headers.map((h, i) => i > 0);
  const sample = rows.slice(0, 200);

  /* Headings wrap; data does not.
   *
   * Measured on the Every Asset view, which is the widest at fourteen columns:
   * the DATA needs 596pt of the 762 available and fits easily. What does not
   * fit is the headings on one line each — 728pt, because "First-pass hours"
   * is 77pt wide over a column of numbers 25pt wide, and "Contributors" is
   * 66pt over a single digit.
   *
   * Squeezing the columns to make one-line headings fit truncated the asset
   * CODE to "PAG-…", which makes a row unidentifiable. Protecting the headings
   * instead truncated them. Both were the wrong trade, because the real
   * constraint was never the width — it was insisting a heading occupy one
   * line. So a heading may take two lines, and a column only has to be as wide
   * as its longest WORD. Everything then fits, and nothing is cut. */
  doc.font('Helvetica-Bold').fontSize(7);
  const floors = headers.map((h) => Math.max(
    ...String(h).toUpperCase().split(/\s+/).map((word) => doc.widthOfString(word))
  ) + 10);
  doc.font('Helvetica').fontSize(7.5);
  const wanted = headers.map((h, i) => {
    let w = 0;
    for (const row of sample) {
      const v = row[h];
      if (v === null || v === undefined || v === '') continue;
      const text = isPercentColumn(h) && v !== 'N/A' ? `${v}%` : String(v);
      w = Math.max(w, doc.widthOfString(text));
    }
    return Math.max(floors[i], Math.min(220, w + 10));
  });

  const asked = wanted.reduce((a, b) => a + b, 0);
  let colWidths;
  if (asked <= width) {
    // Spare room goes to the first column, which is the one holding names.
    colWidths = wanted.map((w, i) => (i === 0 ? w + (width - asked) : w));
  } else {
    const floorTotal = floors.reduce((a, b) => a + b, 0);
    const slack = asked - floorTotal;          // the part that is not headings
    const over = asked - width;                // what has to come off
    colWidths = slack > over
      ? wanted.map((w, i) => w - ((w - floors[i]) / slack) * over)
      // Even the headings do not fit — nothing left to protect, so scale
      // everything. Fourteen columns of long headings on A5, in practice.
      : wanted.map((w) => (w / asked) * width);
  }

  const rowHeight = 16;
  /* As tall as the tallest heading needs, rather than a fixed 18: a two-line
     heading in an 18pt band would print its second line over the first row. */
  doc.font('Helvetica-Bold').fontSize(7);
  const headerHeight = Math.max(18, Math.max(
    ...headers.map((h, i) => doc.heightOfString(String(h).toUpperCase(), { width: colWidths[i] - 8 }))
  ) + 9);

  function drawHeader(y) {
    doc.rect(MARGIN, y, width, headerHeight).fillColor('#eceef2').fill();
    let x = MARGIN;
    headers.forEach((h, i) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(INK);
      doc.text(String(h).toUpperCase(), x + 4, y + 5,
        { width: colWidths[i] - 8, align: numeric[i] ? 'right' : 'left' });
      x += colWidths[i];
    });
    return y + headerHeight;
  }

  /* The bottom of the printable area, leaving room for the footer rule and the
     page number. Every row checks against this before it is drawn, which is
     what stops a long report from running off the last page instead of
     continuing onto the next one. */
  const bottom = doc.page.height - MARGIN - 22;

  let y = drawHeader(top);
  let banded = false;

  for (const row of rows) {
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = drawHeader(MARGIN);
      banded = false;
    }
    if (banded) doc.rect(MARGIN, y, width, rowHeight).fillColor('#fafbfc').fill();
    banded = !banded;

    let x = MARGIN;
    headers.forEach((h, i) => {
      const raw = row[h];
      const text = raw === null || raw === undefined || raw === '' ? '' : String(raw);
      const value = isPercentColumn(h) && text && text !== 'N/A' ? `${text}%` : text;
      const colour = isPercentColumn(h) ? bandColour(text) : INK;
      const flagged = h === 'Over budget' && text === 'yes';
      doc.font(flagged ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5)
        .fillColor(flagged ? '#b3261e' : colour);
      doc.text(fitText(doc, value, colWidths[i] - 8), x + 4, y + 5,
        { width: colWidths[i] - 8, align: numeric[i] ? 'right' : 'left', lineBreak: false });
      x += colWidths[i];
    });
    doc.moveTo(MARGIN, y + rowHeight).lineTo(MARGIN + width, y + rowHeight)
      .strokeColor(RULE).lineWidth(0.4).stroke();
    y += rowHeight;
  }

  if (!rows.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
      .text('Nothing to report on with these filters.', MARGIN, y + 10, { width });
    y = doc.y;
  }

  // --- what was left out -----------------------------------------------------
  if (excluded && excluded.length) {
    if (y + 40 > bottom) { doc.addPage(); y = MARGIN; }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
      .text('Left out of the numbers', MARGIN, y + 12);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
      excluded.map(([reason, n]) => `${n} ${reason}`).join(' · '),
      MARGIN, doc.y + 2, { width });
  }

  /* Page numbers last, once the page count is known — which is the reason for
     bufferPages. "Page 2" with no total tells a reader nothing about whether
     they have the whole document. */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const footY = doc.page.height - MARGIN - 12;
    doc.moveTo(MARGIN, footY - 6).lineTo(doc.page.width - MARGIN, footY - 6)
      .strokeColor(RULE).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`${appName || 'Report'} · work efficiency`, MARGIN, footY,
        { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + width / 2, footY,
      { width: width / 2, align: 'right', lineBreak: false });
  }

  doc.end();
  return doc;
}

module.exports = { write, bandColour };
