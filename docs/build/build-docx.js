/* Renders content.js, plus the generated appendices, into the Word manual. */
const fs = require('fs');
const path = require('path');
const d = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, TableOfContents,
  Header, Footer, PageNumber, PageBreak, LevelFormat, convertInchesToTwip,
} = d;

const BRAND = '7F1416';
const INK = '1A1A1A';
const MUTED = '5A5A5A';
const RULE = 'D8CFCF';
const WASH = 'F7F1F1';

const SHOTS = path.join(__dirname, '..', 'shots');
const CONTENT_WIDTH = 9360;   // DXA, inside 1in margins on US Letter
const bands = require('./bands');
const content = require('./content');

// --- images -----------------------------------------------------------------
// PNG dimensions come out of the IHDR chunk; nothing here needs a library.
const pngSize = (file) => {
  const b = fs.readFileSync(file).subarray(16, 24);
  return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
};
const imageFile = (name) => path.join(SHOTS, `${name}.png`);

/* Wide screenshots run the full text column. Narrow ones — the asset panel is
   420px of a 1680px page — would be six inches wide and fourteen inches tall
   at that rule, so they are held to a portrait width instead. */
const picture = (name) => {
  const file = imageFile(name);
  const { w, h } = pngSize(file);
  const target = w < 700 ? 235 : 600;
  const width = Math.min(target, w);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 60 },
    children: [new ImageRun({
      type: 'png',
      data: fs.readFileSync(file),
      transformation: { width, height: Math.round((h / w) * width) },
    })],
  });
};

// --- text blocks ------------------------------------------------------------
const para = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 140, line: 300 },
  children: [new TextRun({ text, size: opts.size ?? 21, color: opts.color ?? INK, italics: opts.italics, bold: opts.bold })],
});

const caption = (text) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 220 },
  children: [new TextRun({ text, size: 17, color: MUTED, italics: true })],
});

const heading = (text, level) => new Paragraph({
  heading: level,
  spacing: { before: level === HeadingLevel.HEADING_1 ? 340 : 280, after: 140 },
  children: [new TextRun({
    text,
    bold: true,
    color: level === HeadingLevel.HEADING_3 ? INK : BRAND,
    size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 25 : 21,
  })],
  border: level === HeadingLevel.HEADING_1
    ? { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND, space: 6 } }
    : undefined,
});

const cell = (text, opts = {}) => new TableCell({
  width: { size: opts.width, type: WidthType.DXA },
  shading: opts.head ? { type: ShadingType.CLEAR, fill: BRAND, color: 'auto' }
    : opts.wash ? { type: ShadingType.CLEAR, fill: WASH, color: 'auto' } : undefined,
  margins: { top: 70, bottom: 70, left: 110, right: 110 },
  children: [new Paragraph({
    spacing: { after: 0, line: 260 },
    children: [new TextRun({
      text: String(text),
      size: 18,
      bold: Boolean(opts.head),
      color: opts.head ? 'FFFFFF' : INK,
    })],
  })],
});

const grid = (head, rows, widths) => {
  const w = widths || head.map(() => Math.floor(CONTENT_WIDTH / head.length));
  return new Table({
    columnWidths: w,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: head.map((t, i) => cell(t, { width: w[i], head: true })),
      }),
      ...rows.map((r, ri) => new TableRow({
        children: r.map((t, i) => cell(t, { width: w[i], wash: ri % 2 === 1 })),
      })),
    ],
  });
};

/* A shaded box with a rule down its brand-coloured left edge. Built as a
   one-cell table, because a paragraph border cannot carry a fill that survives
   a page break cleanly. */
const box = (title, text, opts = {}) => new Table({
  columnWidths: [CONTENT_WIDTH],
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  borders: {
    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
    right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE },
    insideVertical: { style: BorderStyle.NONE },
    left: { style: BorderStyle.SINGLE, size: 18, color: BRAND },
  },
  rows: [new TableRow({
    children: [new TableCell({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: WASH, color: 'auto' },
      margins: { top: 130, bottom: 130, left: 180, right: 160 },
      children: [
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 16, color: BRAND, characterSpacing: 20 })],
        }),
        ...(Array.isArray(text) ? text : [text]).map((t) => new Paragraph({
          spacing: { after: 0, line: 270 },
          children: [new TextRun({ text: t, size: 19, color: INK })],
        })),
      ],
    })],
  })],
});

/* Each numbered list is its own instance of the "steps" numbering. Sharing one
   instance makes the count run on across the whole manual — chapter 13 opened
   at "73. Save." until this was separated. */
let listInstance = 0;
const listPara = (text, ref, instance) => new Paragraph({
  numbering: { reference: ref, level: 0, instance },
  spacing: { after: 70, line: 280 },
  children: [new TextRun({ text, size: 21, color: INK })],
});

// --- the body ---------------------------------------------------------------
const body = [];
const push = (...xs) => body.push(...xs);

for (const b of content) {
  switch (b.t) {
    case 'h1': push(heading(b.text, HeadingLevel.HEADING_1)); break;
    case 'h2': push(heading(b.text, HeadingLevel.HEADING_2)); break;
    case 'h3': push(heading(b.text, HeadingLevel.HEADING_3)); break;
    case 'p': push(para(b.text)); break;
    case 'lead': push(para(b.text, { size: 23, color: MUTED, after: 200 })); break;
    case 'steps': { const n = ++listInstance;
      push(...b.items.map((t) => listPara(t, 'steps', n)), para('', { after: 60 })); break; }
    case 'bullets': { const n = ++listInstance;
      push(...b.items.map((t) => listPara(t, 'dots', n)), para('', { after: 60 })); break; }
    case 'shot': push(picture(b.file), caption(b.caption)); break;
    case 'table': push(grid(b.head, b.rows, b.widths), para('', { after: 160 })); break;
    case 'note': push(box(b.title, b.text), para('', { after: 180 })); break;
    case 'roles': push(box('Who can do this', [
      b.text,
      ...b.bands.map((x) => `${x.label} \u2014 ${x.roles.length} designations. ${x.note}`),
    ]), para('', { after: 180 })); break;
    case 'pagebreak': push(new Paragraph({ children: [new PageBreak()] })); break;
    default: throw new Error(`unknown block ${b.t}`);
  }
}

// --- Appendix A: the bands --------------------------------------------------
push(new Paragraph({ children: [new PageBreak()] }));
push(heading('Appendix A. Designations and access bands', HeadingLevel.HEADING_1));
push(para(`The studio ships with ${bands.roles.length} designations. Between them they hold `
  + `${bands.groups.reduce((n, g) => n + g.permissions.length, 0)} permissions, which fall into only `
  + `${bands.count} distinct groups of holders. Those groups are the access bands this manual names. `
  + 'Everything below describes a fresh deployment; a Super Admin may change any of it in Settings.'));

for (const b of Object.values(bands.band)) {
  push(heading(`${b.label} (${b.roles.length} designations)`, HeadingLevel.HEADING_2));
  push(para(b.note, { color: MUTED, size: 19 }));
  push(grid(['Designations in this band'], [[b.roles.join(', ')]], [CONTENT_WIDTH]));
  push(para('', { after: 100 }));
  push(para(`Holds: ${b.permissions.join(', ')}`, { size: 18, color: MUTED }));
}

// --- Appendix B: every permission -------------------------------------------
push(new Paragraph({ children: [new PageBreak()] }));
push(heading('Appendix B. Every permission, and who holds it', HeadingLevel.HEADING_1));
push(para('Read out of a fresh deployment. The right-hand column names the access band from Appendix A, '
  + 'which is where you will find the designations it covers.'));
for (const g of bands.groups) {
  push(heading(g.label, HeadingLevel.HEADING_2));
  push(grid(
    ['Permission', 'Key', 'Held by'],
    g.permissions.map((p) => [p.label, p.key, bands.bandOf[p.key].label]),
    [3000, 2960, 3400]
  ));
  push(para('', { after: 160 }));
}

// --- Appendix C: keeping it current -----------------------------------------
push(new Paragraph({ children: [new PageBreak()] }));
push(heading('Appendix C. Keeping this manual current', HeadingLevel.HEADING_1));
push(para('This document is generated, not typed into Word. Both things most likely to go stale — the screenshots '
  + 'and the permission tables — are produced from a running instance each time it is built, so a rebuild cannot '
  + 'leave a picture of last month behind.'));
push(heading('What is generated', HeadingLevel.HEADING_2));
push(...[
  'Every screenshot is captured by a script that signs in as each demo designation and drives the real buttons.',
  'Every permission table is read out of a pristine deployment, so it says what the software ships with rather than what somebody remembers.',
  'The access bands are derived from those tables. A permission added to the catalogue appears in Appendix B on the next build without anybody editing this document.',
].map(((n) => (t) => listPara(t, 'dots', n))(++listInstance)));
push(heading('What a new feature needs', HeadingLevel.HEADING_2));
push(para('Documenting a change is part of building it, not a separate job afterwards. When a feature ships, four '
  + 'things bring this manual up with it:'));
push(...[
  'A section in the right chapter, written as steps somebody can follow.',
  'A screenshot, added to the capture script so it is re-taken on every build.',
  'A role note, naming the access band — which the permission tables will already know about.',
  'A slide in the deck, if the feature is one a new joiner needs to know exists.',
].map(((n) => (t) => listPara(t, 'steps', n))(++listInstance)));
push(para('', { after: 100 }));
push(box('The standing rule',
  'Every feature prompt from here on should say what this documentation needs added. A feature that ships '
  + 'undocumented is a feature the studio has to be told about person by person.'));

// --- the document -----------------------------------------------------------
const doc = new Document({
  // Without this the table of contents opens blank in Word until somebody
  // knows to press F9.
  features: { updateFields: true },
  creator: 'ZVKY FORGE',
  title: 'ZVKY FORGE - User Manual and Reference',
  description: 'Step-by-step walkthrough of the ZVKY FORGE art asset and animation pipeline.',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 21, color: INK } },
    },
  },
  numbering: {
    config: [
      {
        reference: 'steps',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 300 } } },
        }],
      },
      {
        reference: 'dots',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 300 } } },
        }],
      },
    ],
  },
  sections: [
    // Cover and contents. Its own section so the cover carries no page number.
    {
      properties: {
        titlePage: true,
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1), right: convertInchesToTwip(1) },
        },
      },
      children: [
        new Paragraph({ spacing: { before: 2600, after: 0 }, children: [] }),
        new Paragraph({
          spacing: { after: 0 },
          children: [new TextRun({ text: 'ZVKY FORGE', bold: true, size: 76, color: BRAND, characterSpacing: 40 })],
        }),
        new Paragraph({
          spacing: { after: 300 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: BRAND, space: 10 } },
          children: [new TextRun({ text: 'art asset & animation pipeline', size: 24, color: MUTED })],
        }),
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: 'User Manual and Reference', bold: true, size: 40, color: INK })],
        }),
        new Paragraph({
          spacing: { after: 900 },
          children: [new TextRun({
            text: 'A step-by-step walkthrough of every screen, with role-access notes',
            size: 23, color: MUTED,
          })],
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: 'Internal training and reference document', size: 20, color: INK })],
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({
            text: `Built ${new Date().toISOString().slice(0, 10)} from a running instance`,
            size: 20, color: MUTED,
          })],
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Covers ${bands.roles.length} designations and `
              + `${bands.groups.reduce((n, g) => n + g.permissions.length, 0)} permissions`,
            size: 20, color: MUTED,
          })],
        }),

        new Paragraph({ children: [new PageBreak()] }),
        heading('Contents', HeadingLevel.HEADING_1),
        para('If the page numbers below are blank, press Ctrl+A and then F9 to refresh them.',
          { size: 18, color: MUTED, italics: true }),
        new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
      ],
    },
    // The manual itself.
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1), right: convertInchesToTwip(1) },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND, space: 4 } },
            children: [new TextRun({ text: 'ZVKY FORGE  ·  User Manual and Reference', size: 16, color: BRAND, bold: true })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED })],
          })],
        }),
      },
      children: body,
    },
  ],
});

const out = path.join(__dirname, '..', 'ZVKY-FORGE-User-Manual.docx');
fs.mkdirSync(path.dirname(out), { recursive: true });
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(out, buf);
  console.log('wrote', out, (buf.length / 1024 / 1024).toFixed(2), 'MB');
});
