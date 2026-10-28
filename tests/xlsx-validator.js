/* A STRICT .xlsx PACKAGE VALIDATOR, because the lenient readers lied to us.
 *
 * ===========================================================================
 * WHY THIS EXISTS.
 *
 * Prompt 53 shipped an Artist Report that Microsoft Excel refused to open: the
 * repair dialog, then a blank sheet. Every test passed, because every test read
 * the file back with a lenient reader. The system `unzip` does not care what
 * order a worksheet's children are in. Neither does SheetJS, which skips
 * straight to the elements it wants with a regex. Neither does LibreOffice,
 * which was built to open other people's broken files. Excel validates the
 * worksheet part against the schema and discards the whole sheet when it does
 * not match — which is exactly the symptom we got.
 *
 * So the file has to be checked against the SCHEMA, not against a reader. This
 * module encodes the parts of ECMA-376 Part 1 that Excel is known to enforce,
 * and fails with a message that names the offending XML.
 *
 * WHAT IT CHECKS — the full list, each with the §  of ECMA-376 it comes from:
 *
 *   the zip        EOCD present; central directory consistent; entry count
 *                  right; no duplicate, absolute, backslashed or `..` names; no
 *                  directory entries; method 0 or 8 only; CRC-32 and
 *                  uncompressed length of every entry verified by inflating it;
 *                  local header present at the stated offset and its name equal
 *                  to the central one.
 *   the package    [Content_Types].xml present, every part covered by a Default
 *                  or an Override, every Override pointing at a part that
 *                  exists; _rels/.rels present with an officeDocument
 *                  relationship; every relationship Target in every .rels
 *                  resolving to a part that exists; every r:id used in
 *                  workbook.xml declared in xl/_rels/workbook.xml.rels.
 *   every part     well-formed XML, checked with a real parser (xmllint), plus
 *                  no XML-1.0-illegal control character and no lone surrogate
 *                  anywhere in the bytes.
 *   workbook.xml   child order per CT_Workbook (18.2.27); sheet names ≤ 31
 *                  chars, free of : \ / ? * [ ], non-blank, not quote-wrapped,
 *                  unique; sheetIds unique; a defined name that parses, whose
 *                  localSheetId exists; _xlnm._FilterDatabase present and
 *                  matching when the sheet carries an autoFilter.
 *   styles.xml     child order per CT_Stylesheet (18.8.39); every count
 *                  attribute equal to its number of children; fill 0 none and
 *                  fill 1 gray125; patternType from the enum; rgb colours eight
 *                  hex digits; custom numFmtIds ≥ 164 and declared in <numFmts>;
 *                  every xf's numFmtId declared or builtin and its fontId,
 *                  fillId, borderId and xfId in range.
 *   worksheet      child order per CT_Worksheet (18.3.1.99) — which is where the
 *                  Prompt 53 bug was: autoFilter comes BEFORE mergeCells, and
 *                  Excel rejects the sheet when it does not; dimension a valid
 *                  range covering every cell written; rows ascending and cells
 *                  ascending within a row, with every ref matching its row;
 *                  every cell's style index inside cellXfs; no t="str" without
 *                  a formula; inlineStr carrying <is><t> and no <v>; a numeric
 *                  cell either absent-valued or holding a finite number — never
 *                  an empty <v/>, never NaN or Infinity, never text; t="s" only
 *                  with a sharedStrings part and an index in range; a
 *                  date-formatted cell numeric; cols with min ≤ max and a
 *                  finite positive width; mergeCells count right, ranges valid,
 *                  non-overlapping and with no VALUE in the cells the merge
 *                  hides; autoFilter ref valid, inside the dimension and on the
 *                  header row; a frozen pane whose splits, topLeftCell,
 *                  activePane and selections agree; finite positive row heights
 *                  and default row height.
 *   sharedStrings  count and uniqueCount consistent with the table, when there
 *                  is one.
 *
 * HOW TO USE IT: assertValid(buffer, 'the empty report') throws on the first
 * problem with all of them listed. validate(buffer) returns the list, which is
 * what the mutation checks read.
 */
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* ---------- the zip ------------------------------------------------------- */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/* CRC-32, the same table the writer uses. Recomputed here on purpose: a
   validator that imported the writer's checksum could not catch a broken one. */
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* Reads the package the way a zip reader has to: from the central directory
   backwards, not by scanning for local headers forwards. A file whose directory
   disagrees with its entries is the shape of a truncated download. */
function readZip(buffer, problems) {
  const out = { entries: [], byName: new Map() };
  if (buffer.length < 22) { problems.push(`zip: only ${buffer.length} bytes, too short to be a zip`); return out; }
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) { problems.push('zip: no end-of-central-directory record'); return out; }
  const stated = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirStart = buffer.readUInt32LE(eocd + 16);
  if (dirStart + dirSize > buffer.length) {
    problems.push(`zip: the central directory claims to end at ${dirStart + dirSize} but the file is ${buffer.length} bytes`);
    return out;
  }
  let p = dirStart;
  let seen = 0;
  while (p < dirStart + dirSize) {
    if (buffer.readUInt32LE(p) !== CEN_SIG) { problems.push(`zip: bad central directory signature at ${p}`); break; }
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressed = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    seen += 1;

    if (out.byName.has(name)) problems.push(`zip: "${name}" appears twice`);
    if (name.endsWith('/')) problems.push(`zip: "${name}" is a directory entry; an .xlsx has none`);
    if (name.startsWith('/')) problems.push(`zip: "${name}" is an absolute path`);
    if (name.includes('\\')) problems.push(`zip: "${name}" uses a backslash; zip names use "/"`);
    if (name.split('/').includes('..')) problems.push(`zip: "${name}" escapes the package`);
    if (method !== 0 && method !== 8) problems.push(`zip: "${name}" uses compression method ${method}; only stored (0) and deflate (8) are allowed`);

    if (buffer.readUInt32LE(offset) !== LOC_SIG) {
      problems.push(`zip: "${name}" has no local header at the offset its directory entry gives (${offset})`);
      continue;
    }
    const locNameLen = buffer.readUInt16LE(offset + 26);
    const locExtraLen = buffer.readUInt16LE(offset + 28);
    const locName = buffer.slice(offset + 30, offset + 30 + locNameLen).toString('utf8');
    if (locName !== name) problems.push(`zip: the directory calls an entry "${name}" and its local header calls it "${locName}"`);
    const body = buffer.slice(offset + 30 + locNameLen + locExtraLen, offset + 30 + locNameLen + locExtraLen + compressed);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    } catch (err) {
      problems.push(`zip: "${name}" will not inflate (${err.message})`);
      continue;
    }
    if (data.length !== size) problems.push(`zip: "${name}" inflates to ${data.length} bytes, its header says ${size}`);
    if (crc32(data) !== crc) problems.push(`zip: "${name}" fails its CRC-32`);
    const entry = { name, method, data };
    out.entries.push(entry);
    out.byName.set(name, entry);
  }
  if (seen !== stated) problems.push(`zip: the end record counts ${stated} entries, the directory holds ${seen}`);
  return out;
}

/* ---------- XML ----------------------------------------------------------- */

/* WELL-FORMEDNESS COMES FROM A REAL PARSER, not from the walker below. xmllint
   is libxml2; it rejects what a hand-rolled scan would wave through — a stray
   "&", a mismatched tag, a duplicate attribute, a bad encoding. The walker
   afterwards only needs to describe XML that already parsed. */
let XMLLINT = null;
function xmllintPath() {
  if (XMLLINT === null) {
    try { XMLLINT = execFileSync('sh', ['-c', 'command -v xmllint'], { encoding: 'utf8' }).trim(); }
    catch { XMLLINT = ''; }
  }
  return XMLLINT;
}

function checkWellFormed(entries, problems) {
  const lint = xmllintPath();
  if (!lint) { problems.push('xmllint is not installed, so XML well-formedness cannot be checked'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxcheck-'));
  try {
    for (const entry of entries) {
      if (!/\.(xml|rels)$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name.replace(/[^A-Za-z0-9._-]/g, '_'));
      fs.writeFileSync(file, entry.data);
      try {
        execFileSync(lint, ['--noout', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        const why = String(err.stderr || err.message).split('\n').filter(Boolean).slice(0, 3).join(' / ');
        problems.push(`${entry.name}: not well-formed XML — ${why}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function checkCharacters(entries, problems) {
  for (const entry of entries) {
    if (!/\.(xml|rels)$/.test(entry.name)) continue;
    const text = entry.data.toString('utf8');
    const bad = ILLEGAL_XML.exec(text);
    if (bad) {
      problems.push(`${entry.name}: holds U+${bad[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}, `
        + 'which XML 1.0 cannot carry, at byte ' + bad.index);
    }
    if (LONE_SURROGATE.test(text)) problems.push(`${entry.name}: holds a lone surrogate`);
  }
}

/* A walker over XML that has already been proved well-formed. Builds
   {name, attrs, children} and nothing else — no text nodes except where asked,
   because every part here is element-structured. */
function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  let last = 0;
  let m = tag.exec(text);
  while (m) {
    const between = text.slice(last, m.index);
    if (between) stack[stack.length - 1].text += between;
    last = m.index + m[0].length;
    if (m[2]) {
      if (m[1]) {
        stack.pop();
      } else {
        const attrs = {};
        const an = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a = an.exec(m[3] || '');
        while (a) { attrs[a[1]] = unescapeXml(a[2] !== undefined ? a[2] : a[3]); a = an.exec(m[3] || ''); }
        const node = { name: m[2], attrs, children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!m[4]) stack.push(node);
      }
    }
    m = tag.exec(text);
  }
  return root.children.find((c) => c.name) || root;
}

function unescapeXml(s) {
  return String(s).replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e[1] === 'x') return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(Number(e.slice(1)));
  });
}

const kid = (node, name) => node.children.find((c) => c.name === name);
const kids = (node, name) => node.children.filter((c) => c.name === name);

/* ---------- the schema orders -------------------------------------------- */

/* ECMA-376 Part 1 §18.3.1.99, CT_Worksheet. THE ORDER IS THE SPECIFICATION and
   Excel enforces it: autoFilter is element 11 and mergeCells element 15, so a
   sheet that writes the merge first is rejected whole. That is the Prompt 53
   bug, and this list is why it cannot come back. */
const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState',
  'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting',
  'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter',
  'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

/* §18.8.39, CT_Stylesheet. */
const STYLES_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles',
  'dxfs', 'tableStyles', 'colors', 'extLst'];

/* §18.2.27, CT_Workbook. */
const WORKBOOK_ORDER = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews',
  'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize',
  'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing',
  'fileRecoveryPr', 'webPublishObjects', 'extLst'];

function checkOrder(label, order, names, problems) {
  let highest = -1;
  let highestName = null;
  for (const name of names) {
    /* A PREFIXED ELEMENT IS EXTENSION CONTENT, not a schema child: the
       Markup Compatibility rules let <mc:AlternateContent> stand anywhere, and
       the attached template uses one. Skipped rather than rejected — measured
       against that template, which Excel opens. */
    if (name.includes(':')) continue;
    const at = order.indexOf(name);
    if (at < 0) { problems.push(`${label}: <${name}> is not a child the schema allows here`); continue; }
    if (at < highest) {
      problems.push(`${label}: <${name}> comes after <${highestName}>, but the schema orders `
        + `<${name}> (position ${at + 1}) before <${highestName}> (position ${highest + 1}). `
        + 'Excel rejects the part and offers to repair the file.');
    } else { highest = at; highestName = name; }
  }
}

/* ---------- references --------------------------------------------------- */

const colToNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const CELL_REF = /^([A-Z]{1,3})([1-9]\d*)$/;

function parseRef(ref) {
  const m = CELL_REF.exec(String(ref || ''));
  return m ? { col: colToNumber(m[1]), row: Number(m[2]) } : null;
}

function parseRange(ref) {
  const [a, b] = String(ref || '').split(':');
  const from = parseRef(a);
  const to = b === undefined ? from : parseRef(b);
  if (!from || !to) return null;
  if (to.col < from.col || to.row < from.row) return null;
  return { from, to };
}

const PATTERN_TYPES = new Set(['none', 'solid', 'mediumGray', 'darkGray', 'lightGray', 'darkHorizontal',
  'darkVertical', 'darkDown', 'darkUp', 'darkGrid', 'darkTrellis', 'lightHorizontal', 'lightVertical',
  'lightDown', 'lightUp', 'lightGrid', 'lightTrellis', 'gray125', 'gray0625']);

const ILLEGAL_SHEET_NAME = /[:\\/?*[\]]/;

/* ---------- the parts ---------------------------------------------------- */

function checkContentTypes(pkg, problems) {
  const entry = pkg.byName.get('[Content_Types].xml');
  if (!entry) { problems.push('the package has no [Content_Types].xml'); return; }
  const root = parseXml(entry.data.toString('utf8'));
  const defaults = new Map(kids(root, 'Default').map((d) => [String(d.attrs.Extension || '').toLowerCase(), d.attrs.ContentType]));
  const overrides = new Map(kids(root, 'Override').map((o) => [o.attrs.PartName, o.attrs.ContentType]));
  for (const [part, type] of overrides) {
    if (!part || !part.startsWith('/')) problems.push(`[Content_Types].xml: Override PartName "${part}" must start with "/"`);
    else if (!pkg.byName.has(part.slice(1))) problems.push(`[Content_Types].xml: Override names "${part}", which is not in the package`);
    if (!type) problems.push(`[Content_Types].xml: Override for "${part}" has no ContentType`);
  }
  for (const e of pkg.entries) {
    if (e.name === '[Content_Types].xml') continue;
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    if (!overrides.has(`/${e.name}`) && !defaults.has(ext)) {
      problems.push(`[Content_Types].xml: nothing gives a content type for "${e.name}"`);
    }
  }
  const want = [
    ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
    ['xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
  ];
  for (const [part, type] of want) {
    if (pkg.byName.has(part) && overrides.get(`/${part}`) !== type) {
      problems.push(`[Content_Types].xml: ${part} needs the content type ${type}, it has "${overrides.get(`/${part}`) || 'none'}"`);
    }
  }
  for (const e of pkg.entries) {
    if (!/^xl\/worksheets\/.*\.xml$/.test(e.name)) continue;
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
    if (overrides.get(`/${e.name}`) !== type) problems.push(`[Content_Types].xml: ${e.name} needs the worksheet content type`);
  }
}

function relationshipsIn(pkg, name, problems) {
  const entry = pkg.byName.get(name);
  if (!entry) return new Map();
  const root = parseXml(entry.data.toString('utf8'));
  const base = name === '_rels/.rels' ? '' : `${name.replace(/_rels\/[^/]*$/, '')}`;
  const out = new Map();
  for (const rel of kids(root, 'Relationship')) {
    const target = String(rel.attrs.Target || '');
    if (!rel.attrs.Id) problems.push(`${name}: a Relationship has no Id`);
    if (!rel.attrs.Type) problems.push(`${name}: relationship ${rel.attrs.Id} has no Type`);
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(base + target);
    if (String(rel.attrs.TargetMode) !== 'External' && !pkg.byName.has(resolved)) {
      problems.push(`${name}: relationship ${rel.attrs.Id} points at "${target}", which resolves to `
        + `"${resolved}" and is not in the package`);
    }
    out.set(rel.attrs.Id, { type: rel.attrs.Type, target: resolved });
  }
  return out;
}

function checkStyles(pkg, problems) {
  const entry = pkg.byName.get('xl/styles.xml');
  if (!entry) { problems.push('the package has no xl/styles.xml'); return { cellXfs: [], dateFormats: new Set() }; }
  const root = parseXml(entry.data.toString('utf8'));
  checkOrder('xl/styles.xml', STYLES_ORDER, root.children.map((c) => c.name), problems);

  const counted = {
    numFmts: 'numFmt', fonts: 'font', fills: 'fill', borders: 'border',
    cellStyleXfs: 'xf', cellXfs: 'xf', cellStyles: 'cellStyle', dxfs: 'dxf', tableStyles: 'tableStyle',
  };
  for (const [parent, child] of Object.entries(counted)) {
    const node = kid(root, parent);
    if (!node) continue;
    const actual = kids(node, child).length;
    if (node.attrs.count === undefined) problems.push(`xl/styles.xml: <${parent}> has no count attribute`);
    else if (Number(node.attrs.count) !== actual) {
      problems.push(`xl/styles.xml: <${parent} count="${node.attrs.count}"> holds ${actual} <${child}> children. `
        + 'Excel reads the count and then reads that many children.');
    }
  }

  const fills = kid(root, 'fills') ? kids(kid(root, 'fills'), 'fill') : [];
  const patternOf = (fill) => (kid(fill, 'patternFill') || { attrs: {} }).attrs.patternType;
  if (fills.length < 2) problems.push('xl/styles.xml: Excel needs at least two fills, "none" then "gray125"');
  else {
    if (patternOf(fills[0]) !== 'none') problems.push(`xl/styles.xml: fill 0 must be patternType="none", it is "${patternOf(fills[0])}"`);
    if (patternOf(fills[1]) !== 'gray125') problems.push(`xl/styles.xml: fill 1 must be patternType="gray125", it is "${patternOf(fills[1])}"`);
  }
  fills.forEach((fill, i) => {
    const pattern = kid(fill, 'patternFill');
    if (pattern && pattern.attrs.patternType !== undefined && !PATTERN_TYPES.has(pattern.attrs.patternType)) {
      problems.push(`xl/styles.xml: fill ${i} has patternType="${pattern.attrs.patternType}", which is not in the enumeration`);
    }
  });

  const walk = (node, fn) => { fn(node); node.children.forEach((c) => walk(c, fn)); };
  walk(root, (node) => {
    if (node.attrs.rgb !== undefined && !/^[0-9A-Fa-f]{8}$/.test(node.attrs.rgb)) {
      problems.push(`xl/styles.xml: <${node.name} rgb="${node.attrs.rgb}"> is not eight hex digits (AARRGGBB)`);
    }
  });

  const declared = new Set();
  const dateFormats = new Set();
  const numFmtsNode = kid(root, 'numFmts');
  for (const fmt of numFmtsNode ? kids(numFmtsNode, 'numFmt') : []) {
    const id = Number(fmt.attrs.numFmtId);
    if (!Number.isInteger(id)) { problems.push(`xl/styles.xml: numFmt has numFmtId="${fmt.attrs.numFmtId}"`); continue; }
    if (id < 164) problems.push(`xl/styles.xml: numFmtId ${id} is below 164, which is reserved for Excel's built-in formats`);
    if (declared.has(id)) problems.push(`xl/styles.xml: numFmtId ${id} is declared twice`);
    declared.add(id);
    if (/[ymd]/.test(String(fmt.attrs.formatCode || '').replace(/\\./g, '').replace(/"[^"]*"/g, ''))) dateFormats.add(id);
  }

  const counts = {
    font: kid(root, 'fonts') ? kids(kid(root, 'fonts'), 'font').length : 0,
    fill: fills.length,
    border: kid(root, 'borders') ? kids(kid(root, 'borders'), 'border').length : 0,
    xf: kid(root, 'cellStyleXfs') ? kids(kid(root, 'cellStyleXfs'), 'xf').length : 0,
  };
  const cellXfs = kid(root, 'cellXfs') ? kids(kid(root, 'cellXfs'), 'xf') : [];
  cellXfs.forEach((xf, i) => {
    const numFmtId = Number(xf.attrs.numFmtId || 0);
    if (numFmtId >= 164 && !declared.has(numFmtId)) {
      problems.push(`xl/styles.xml: cellXfs[${i}] uses numFmtId ${numFmtId}, which no <numFmt> declares. `
        + 'Excel treats an undeclared custom format as a broken style.');
    }
    const range = [['fontId', counts.font], ['fillId', counts.fill], ['borderId', counts.border], ['xfId', counts.xf]];
    for (const [attr, total] of range) {
      if (xf.attrs[attr] === undefined) continue;
      const value = Number(xf.attrs[attr]);
      if (!Number.isInteger(value) || value < 0 || value >= total) {
        problems.push(`xl/styles.xml: cellXfs[${i}] has ${attr}="${xf.attrs[attr]}" but there are ${total} of them`);
      }
    }
  });
  return {
    cellXfs: cellXfs.map((xf) => ({ numFmtId: Number(xf.attrs.numFmtId || 0) })),
    dateFormats,
  };
}

function checkWorkbook(pkg, problems, worksheetFacts) {
  const entry = pkg.byName.get('xl/workbook.xml');
  if (!entry) { problems.push('the package has no xl/workbook.xml'); return; }
  const root = parseXml(entry.data.toString('utf8'));
  checkOrder('xl/workbook.xml', WORKBOOK_ORDER, root.children.map((c) => c.name), problems);

  const rels = relationshipsIn(pkg, 'xl/_rels/workbook.xml.rels', problems);
  const sheetsNode = kid(root, 'sheets');
  if (!sheetsNode || !kids(sheetsNode, 'sheet').length) { problems.push('xl/workbook.xml: no <sheet>'); return; }
  const names = new Set();
  const ids = new Set();
  const sheets = kids(sheetsNode, 'sheet');
  sheets.forEach((sheet, index) => {
    const name = String(sheet.attrs.name === undefined ? '' : sheet.attrs.name);
    if (!name) problems.push(`xl/workbook.xml: sheet ${index + 1} has no name`);
    if (name.length > 31) problems.push(`xl/workbook.xml: sheet name "${name}" is ${name.length} characters; Excel allows 31`);
    if (ILLEGAL_SHEET_NAME.test(name)) problems.push(`xl/workbook.xml: sheet name "${name}" uses one of : \\ / ? * [ ]`);
    if (name.startsWith("'") || name.endsWith("'")) problems.push(`xl/workbook.xml: sheet name "${name}" may not start or end with an apostrophe`);
    if (names.has(name.toLowerCase())) problems.push(`xl/workbook.xml: two sheets are called "${name}"`);
    names.add(name.toLowerCase());
    if (ids.has(String(sheet.attrs.sheetId))) problems.push(`xl/workbook.xml: sheetId ${sheet.attrs.sheetId} is used twice`);
    ids.add(String(sheet.attrs.sheetId));
    const rid = sheet.attrs['r:id'];
    if (!rid) problems.push(`xl/workbook.xml: sheet "${name}" has no r:id`);
    else if (!rels.has(rid)) problems.push(`xl/workbook.xml: sheet "${name}" uses ${rid}, which xl/_rels/workbook.xml.rels does not declare`);
  });

  const definedNames = kid(root, 'definedNames');
  const filters = new Map();
  for (const dn of definedNames ? kids(definedNames, 'definedName') : []) {
    const name = String(dn.attrs.name || '');
    if (!name) problems.push('xl/workbook.xml: a definedName has no name');
    if (dn.attrs.localSheetId !== undefined) {
      const at = Number(dn.attrs.localSheetId);
      if (!Number.isInteger(at) || at < 0 || at >= sheets.length) {
        problems.push(`xl/workbook.xml: definedName "${name}" has localSheetId ${dn.attrs.localSheetId} and there are ${sheets.length} sheets`);
      }
    }
    if (name === '_xlnm._FilterDatabase') filters.set(Number(dn.attrs.localSheetId), dn.text.trim());
  }
  /* AN AUTOFILTER COMES WITH A HIDDEN DEFINED NAME, which is what Excel's own
     writer does and what SheetJS copies. The sheet opens without it, but the
     filter then has no stored range, so this holds the pair together. */
  worksheetFacts.forEach((facts, sheetIndex) => {
    if (!facts || !facts.autoFilterRef) return;
    const expected = `'${sheets[sheetIndex] ? sheets[sheetIndex].attrs.name : ''}'!`
      + facts.autoFilterRef.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
    if (!filters.has(sheetIndex)) {
      problems.push(`xl/workbook.xml: sheet ${sheetIndex + 1} has an autoFilter on ${facts.autoFilterRef} `
        + 'but no _xlnm._FilterDatabase defined name for it');
    } else if (filters.get(sheetIndex) !== expected) {
      problems.push(`xl/workbook.xml: _xlnm._FilterDatabase is "${filters.get(sheetIndex)}", the autoFilter is on ${expected}`);
    }
  });
}

function checkSharedStrings(pkg, problems) {
  const entry = pkg.byName.get('xl/sharedStrings.xml');
  if (!entry) return null;
  const root = parseXml(entry.data.toString('utf8'));
  const items = kids(root, 'si').length;
  const unique = Number(root.attrs.uniqueCount);
  const count = Number(root.attrs.count);
  if (root.attrs.uniqueCount !== undefined && unique !== items) {
    problems.push(`xl/sharedStrings.xml: uniqueCount="${root.attrs.uniqueCount}" but the table holds ${items} <si>`);
  }
  if (root.attrs.count !== undefined && count < items) {
    problems.push(`xl/sharedStrings.xml: count="${root.attrs.count}" is fewer than the ${items} <si> in the table`);
  }
  return items;
}

/* ---------- the worksheet ------------------------------------------------ */

/* READ IN ONE PASS, holding aggregates rather than a tree, because a sheet at
   the Artist Report's 50,000-row cap is 450,000 cells and a validator that
   needs two hundred megabytes to check a file is a validator nobody runs. */
function checkWorksheet(name, text, styles, sharedCount, problems) {
  const facts = { autoFilterRef: null };
  const sheetDataAt = text.indexOf('<sheetData');
  const sheetDataEnd = text.indexOf('</sheetData>');
  const selfClosing = sheetDataAt >= 0 && sheetDataEnd < 0;
  if (sheetDataAt < 0) { problems.push(`${name}: no <sheetData>`); return facts; }

  const body = selfClosing ? '' : text.slice(text.indexOf('>', sheetDataAt) + 1, sheetDataEnd);
  const skeleton = text.slice(0, sheetDataAt) + '<sheetData/>'
    + (selfClosing ? text.slice(text.indexOf('>', sheetDataAt) + 1) : text.slice(sheetDataEnd + 12));
  const root = parseXml(skeleton);
  if (root.name !== 'worksheet') problems.push(`${name}: the root element is <${root.name}>, not <worksheet>`);
  checkOrder(name, WORKSHEET_ORDER, root.children.map((c) => c.name), problems);

  const dimension = kid(root, 'dimension');
  const dim = dimension ? parseRange(dimension.attrs.ref) : null;
  if (dimension && !dim) problems.push(`${name}: <dimension ref="${dimension.attrs.ref}"> is not a range`);

  const colsNode = kid(root, 'cols');
  for (const col of colsNode ? kids(colsNode, 'col') : []) {
    const min = Number(col.attrs.min);
    const max = Number(col.attrs.max);
    if (!Number.isInteger(min) || min < 1) problems.push(`${name}: <col min="${col.attrs.min}">`);
    if (!Number.isInteger(max) || max < min) problems.push(`${name}: <col min="${col.attrs.min}" max="${col.attrs.max}"> is back to front`);
    if (col.attrs.width !== undefined) {
      const width = Number(col.attrs.width);
      if (!Number.isFinite(width) || width <= 0) problems.push(`${name}: <col min="${col.attrs.min}" width="${col.attrs.width}"> is not a positive number`);
    }
  }

  const formatPr = kid(root, 'sheetFormatPr');
  if (formatPr && formatPr.attrs.defaultRowHeight !== undefined) {
    const h = Number(formatPr.attrs.defaultRowHeight);
    if (!Number.isFinite(h) || h <= 0) problems.push(`${name}: defaultRowHeight="${formatPr.attrs.defaultRowHeight}"`);
  }

  /* The frozen pane, and the selections that have to agree with it. A pane whose
     activePane names a quadrant its splits do not create is the kind of thing
     Excel repairs by throwing the sheetView away. */
  const views = kid(root, 'sheetViews');
  for (const view of views ? kids(views, 'sheetView') : []) {
    const pane = kid(view, 'pane');
    if (!pane) continue;
    const xSplit = Number(pane.attrs.xSplit || 0);
    const ySplit = Number(pane.attrs.ySplit || 0);
    if (!Number.isFinite(xSplit) || xSplit < 0 || !Number.isFinite(ySplit) || ySplit < 0) {
      problems.push(`${name}: <pane xSplit="${pane.attrs.xSplit}" ySplit="${pane.attrs.ySplit}">`);
    }
    if (!xSplit && !ySplit) problems.push(`${name}: <pane> splits nothing`);
    const expected = xSplit && ySplit ? 'bottomRight' : (ySplit ? 'bottomLeft' : 'topRight');
    if (pane.attrs.activePane && pane.attrs.activePane !== expected) {
      problems.push(`${name}: <pane> splits ${xSplit ? 'columns' : 'no columns'} and ${ySplit ? 'rows' : 'no rows'}, `
        + `so its activePane is "${expected}", not "${pane.attrs.activePane}"`);
    }
    const topLeft = pane.attrs.topLeftCell ? parseRef(pane.attrs.topLeftCell) : null;
    if (pane.attrs.topLeftCell && !topLeft) problems.push(`${name}: <pane topLeftCell="${pane.attrs.topLeftCell}">`);
    else if (topLeft && pane.attrs.state === 'frozen' && (topLeft.row !== ySplit + 1 || topLeft.col !== xSplit + 1)) {
      problems.push(`${name}: a frozen <pane> with xSplit ${xSplit} and ySplit ${ySplit} starts at `
        + `column ${xSplit + 1} row ${ySplit + 1}, not "${pane.attrs.topLeftCell}"`);
    }
    for (const selection of kids(view, 'selection')) {
      if (selection.attrs.pane && !['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].includes(selection.attrs.pane)) {
        problems.push(`${name}: <selection pane="${selection.attrs.pane}">`);
      }
      if (selection.attrs.pane && selection.attrs.pane !== expected) {
        problems.push(`${name}: <selection pane="${selection.attrs.pane}"> names a pane the splits do not create (${expected})`);
      }
    }
  }

  const merges = [];
  const mergeNode = kid(root, 'mergeCells');
  if (mergeNode) {
    const list = kids(mergeNode, 'mergeCell');
    if (mergeNode.attrs.count === undefined) problems.push(`${name}: <mergeCells> has no count`);
    else if (Number(mergeNode.attrs.count) !== list.length) {
      problems.push(`${name}: <mergeCells count="${mergeNode.attrs.count}"> holds ${list.length} ranges`);
    }
    for (const merge of list) {
      const range = parseRange(merge.attrs.ref);
      if (!range) { problems.push(`${name}: <mergeCell ref="${merge.attrs.ref}"> is not a range`); continue; }
      if (range.from.col === range.to.col && range.from.row === range.to.row) {
        problems.push(`${name}: <mergeCell ref="${merge.attrs.ref}"> merges one cell with itself`);
      }
      for (const other of merges) {
        if (range.from.col <= other.to.col && other.from.col <= range.to.col
          && range.from.row <= other.to.row && other.from.row <= range.to.row) {
          problems.push(`${name}: merged ranges ${merge.attrs.ref} and ${other.ref} overlap`);
        }
      }
      merges.push({ ...range, ref: merge.attrs.ref });
    }
  }

  const filter = kid(root, 'autoFilter');
  if (filter) {
    const range = parseRange(filter.attrs.ref);
    if (!range) problems.push(`${name}: <autoFilter ref="${filter.attrs.ref}"> is not a range`);
    else {
      facts.autoFilterRef = filter.attrs.ref;
      if (dim && (range.from.row < dim.from.row || range.to.row > dim.to.row
        || range.from.col < dim.from.col || range.to.col > dim.to.col)) {
        problems.push(`${name}: <autoFilter ref="${filter.attrs.ref}"> reaches outside the dimension ${dimension.attrs.ref}`);
      }
    }
  }

  /* The cells. One regex pass, in document order, holding only what the checks
     above and below need. */
  const xfCount = styles.cellXfs.length;
  const dateStyles = new Set();
  styles.cellXfs.forEach((xf, i) => { if (styles.dateFormats.has(xf.numFmtId)) dateStyles.add(i); });
  let lastRow = 0;
  let maxRow = 0;
  let maxCol = 0;
  const seenRows = new Set();
  const rowRe = /<row\b([^>]*?)(\/?)>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const attrRe = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
  const attrsOf = (s) => {
    const out = {};
    attrRe.lastIndex = 0;
    let a = attrRe.exec(s);
    while (a) { out[a[1]] = a[2]; a = attrRe.exec(s); }
    return out;
  };
  const rowStarts = [];
  let rm = rowRe.exec(body);
  while (rm) { rowStarts.push({ at: rm.index, end: rm.index + rm[0].length, attrs: attrsOf(rm[1]), closed: rm[2] === '/' }); rm = rowRe.exec(body); }
  rowStarts.forEach((row, i) => {
    const r = Number(row.attrs.r);
    if (!Number.isInteger(r) || r < 1) { problems.push(`${name}: <row r="${row.attrs.r}">`); return; }
    if (seenRows.has(r)) problems.push(`${name}: row ${r} is written twice`);
    seenRows.add(r);
    if (r <= lastRow) problems.push(`${name}: row ${r} comes after row ${lastRow}; rows must ascend`);
    lastRow = r;
    if (r > maxRow) maxRow = r;
    if (row.attrs.ht !== undefined) {
      const h = Number(row.attrs.ht);
      if (!Number.isFinite(h) || h <= 0) problems.push(`${name}: <row r="${r}" ht="${row.attrs.ht}">`);
    }
    if (row.attrs.spans !== undefined && !/^\d+:\d+$/.test(row.attrs.spans)) problems.push(`${name}: <row r="${r}" spans="${row.attrs.spans}">`);
    if (row.closed) return;
    const until = i + 1 < rowStarts.length ? rowStarts[i + 1].at : body.length;
    const inner = body.slice(row.end, until);
    let lastCol = 0;
    cellRe.lastIndex = 0;
    let cm = cellRe.exec(inner);
    while (cm) {
      const attrs = attrsOf(cm[1]);
      const inside = cm[2] || '';
      const ref = parseRef(attrs.r);
      if (!ref) problems.push(`${name}: <c r="${attrs.r}"> in row ${r} is not a cell reference`);
      else {
        if (ref.row !== r) problems.push(`${name}: <c r="${attrs.r}"> sits in <row r="${r}">`);
        if (ref.col <= lastCol) problems.push(`${name}: <c r="${attrs.r}"> comes after column ${lastCol}; cells must ascend`);
        lastCol = ref.col;
        if (ref.col > maxCol) maxCol = ref.col;
        if (dim && (ref.row < dim.from.row || ref.row > dim.to.row || ref.col < dim.from.col || ref.col > dim.to.col)) {
          problems.push(`${name}: <c r="${attrs.r}"> is outside the dimension ${dimension.attrs.ref}`);
        }
        for (const merge of merges) {
          const inside2 = ref.col >= merge.from.col && ref.col <= merge.to.col && ref.row >= merge.from.row && ref.row <= merge.to.row;
          const anchor = ref.col === merge.from.col && ref.row === merge.from.row;
          if (inside2 && !anchor && /<(v|is|f)\b/.test(inside)) {
            problems.push(`${name}: <c r="${attrs.r}"> holds a value inside the merge ${merge.ref}; `
              + 'only its top-left cell may');
          }
        }
      }
      const style = attrs.s === undefined ? 0 : Number(attrs.s);
      if (!Number.isInteger(style) || style < 0 || style >= xfCount) {
        problems.push(`${name}: <c r="${attrs.r}" s="${attrs.s}"> and cellXfs holds ${xfCount} styles`);
      }
      const type = attrs.t;
      const vMatch = /<v(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inside);
      const hasV = Boolean(vMatch);
      const value = vMatch ? (vMatch[1] === undefined ? '' : vMatch[1]) : null;
      const hasFormula = /<f\b/.test(inside);
      if (type === 'str' && !hasFormula) {
        problems.push(`${name}: <c r="${attrs.r}" t="str"> has no <f>; t="str" is a formula's cached string. `
          + 'Plain text is t="inlineStr" or t="s".');
      }
      if (type === 'inlineStr') {
        if (!/<is\b/.test(inside)) problems.push(`${name}: <c r="${attrs.r}" t="inlineStr"> has no <is>`);
        if (hasV) problems.push(`${name}: <c r="${attrs.r}" t="inlineStr"> also has a <v>`);
      } else if (type === 's') {
        if (sharedCount === null) problems.push(`${name}: <c r="${attrs.r}" t="s"> and the package has no sharedStrings.xml`);
        else if (!hasV || !/^\d+$/.test(value.trim()) || Number(value) >= sharedCount) {
          problems.push(`${name}: <c r="${attrs.r}" t="s"> points at shared string ${value} of ${sharedCount}`);
        }
      } else if (type === undefined || type === 'n') {
        if (hasV) {
          const text = value.trim();
          if (text === '') {
            problems.push(`${name}: <c r="${attrs.r}"> is a numeric cell with an empty <v/>. `
              + 'A blank number is a cell with NO value element at all; Excel rejects the empty one.');
          } else if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
            problems.push(`${name}: <c r="${attrs.r}"> is a numeric cell holding "${text}"`);
          } else if (!Number.isFinite(Number(text))) {
            problems.push(`${name}: <c r="${attrs.r}"> is a numeric cell holding "${text}"`);
          }
        }
        if (dateStyles.has(style) && type !== undefined && type !== 'n') {
          problems.push(`${name}: <c r="${attrs.r}"> carries a date format but is typed "${type}"`);
        }
      } else if (['b', 'e', 'd', 'str'].includes(type)) {
        if (dateStyles.has(style) && type !== 'd') problems.push(`${name}: <c r="${attrs.r}"> carries a date format and is typed "${type}"`);
      } else {
        problems.push(`${name}: <c r="${attrs.r}" t="${type}"> is not a cell type the schema knows`);
      }
      if (dateStyles.has(style) && type === 'inlineStr') {
        problems.push(`${name}: <c r="${attrs.r}"> is formatted as a date but written as text. `
          + 'Excel shows the text and cannot sort or filter it as a date.');
      }
      cm = cellRe.exec(inner);
    }
  });
  if (dim && maxRow && (dim.to.row < maxRow || dim.to.col < maxCol)) {
    problems.push(`${name}: <dimension ref="${dimension.attrs.ref}"> does not cover the data, which reaches row ${maxRow} column ${maxCol}`);
  }
  return facts;
}

/* EVERY PART HAS TO BE REACHABLE FROM _rels/.rels, which is the OPC rule and
 * the one the shipped Artist Report broke: xl/styles.xml was in the zip and in
 * [Content_Types].xml, and nothing related to it. Excel finds the styles part
 * through the workbook's relationship of type .../styles, so an orphan styles
 * part means every cell's s="4" refers to a style table Excel never loaded —
 * which is a repair, and then a sheet with nothing in it.
 *
 * No lenient reader notices. The system `unzip` does not read relationships at
 * all; SheetJS and LibreOffice look parts up by their conventional NAME. Only
 * Excel insists on the graph, so only this check stands in for it.
 */
const RELS_FOR = {
  'xl/styles.xml': 'styles',
  'xl/sharedStrings.xml': 'sharedStrings',
  'xl/theme/theme1.xml': 'theme',
};

function checkReachable(pkg, problems) {
  const seen = new Set();
  const queue = [];
  const relsOf = (part) => {
    const dir = part.includes('/') ? part.replace(/[^/]*$/, '') : '';
    return part === '' ? '_rels/.rels' : `${dir}_rels/${part.slice(dir.length)}.rels`;
  };
  const follow = (relsName) => {
    if (!pkg.byName.has(relsName)) return;
    seen.add(relsName);
    for (const rel of relationshipsIn(pkg, relsName, []).values()) {
      if (!rel.target || !pkg.byName.has(rel.target) || seen.has(rel.target)) continue;
      seen.add(rel.target);
      queue.push(rel.target);
    }
  };
  follow('_rels/.rels');
  while (queue.length) follow(relsOf(queue.shift()));
  for (const e of pkg.entries) {
    if (e.name === '[Content_Types].xml' || /(^|\/)_rels\//.test(e.name)) continue;
    if (seen.has(e.name)) continue;
    const type = RELS_FOR[e.name];
    problems.push(`"${e.name}" is in the package but no relationship points at it`
      + (type ? `; xl/_rels/workbook.xml.rels needs a Relationship of type .../${type} targeting it. `
        + 'Excel loads that part through the relationship and not by its name, so without it the part '
        + 'is invisible and the file needs repairing.' : '.'));
  }
}

/* ---------- the entry points -------------------------------------------- */

function validate(buffer) {
  const problems = [];
  if (!Buffer.isBuffer(buffer)) { problems.push(`not a Buffer but a ${typeof buffer}`); return problems; }
  const pkg = readZip(buffer, problems);
  if (!pkg.entries.length) return problems;
  checkWellFormed(pkg.entries, problems);
  checkCharacters(pkg.entries, problems);
  if (problems.some((p) => /not well-formed/.test(p))) return problems;
  checkContentTypes(pkg, problems);
  const rootRels = relationshipsIn(pkg, '_rels/.rels', problems);
  if (!pkg.byName.has('_rels/.rels')) problems.push('the package has no _rels/.rels');
  else if (![...rootRels.values()].some((r) => /officeDocument$/.test(String(r.type)))) {
    problems.push('_rels/.rels: no officeDocument relationship');
  }
  checkReachable(pkg, problems);
  const styles = checkStyles(pkg, problems);
  const sharedCount = checkSharedStrings(pkg, problems);
  const facts = [];
  pkg.entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .forEach((e, i) => { facts[i] = checkWorksheet(e.name, e.data.toString('utf8'), styles, sharedCount, problems); });
  checkWorkbook(pkg, problems, facts);
  return problems;
}

function assertValid(buffer, label = 'the workbook') {
  const problems = validate(buffer);
  if (problems.length) {
    throw new Error(`${label} is not a valid .xlsx package — Excel would offer to repair it:\n`
      + problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n'));
  }
}

/* The package as a map, for tests that compare skeletons rather than validate. */
function parts(buffer) {
  const problems = [];
  const pkg = readZip(buffer, problems);
  const out = new Map();
  for (const e of pkg.entries) out.set(e.name, e.data);
  return { parts: out, names: pkg.entries.map((e) => e.name), problems };
}

/* THE TWO CHECKS THIS VALIDATOR IS STRICTER ABOUT THAN EXCEL, named once so
 * every caller that has to forgive them forgives the same two.
 *
 * SheetJS — which writes every other spreadsheet in this application — emits
 * t="str" for plain text (that is the formula-string type; Excel accepts it and
 * shows the text) and re-declares built-in number formats below id 164 in
 * <numFmts> (Excel ignores the redefinition). Both are in the brief's list of
 * things to check and both are worth refusing in OUR writer, where they would
 * be mistakes rather than quirks. Neither is the kind of defect that broke the
 * Artist Report: those were schema order and a missing relationship, and
 * SheetJS gets both right.
 *
 * So the exports built with SheetJS are checked with everything except these,
 * which keeps the exception explicit instead of turning the check off. */
const SHEETJS_TOLERATED = /t="str"|numFmtId \d+ is below 164/;

/* The problems that would stop Excel opening a file written by any writer. */
const strictly = (problems) => problems.filter((p) => !SHEETJS_TOLERATED.test(p));

module.exports = {
  validate, assertValid, parts, parseXml, readZip, crc32,
  WORKSHEET_ORDER, STYLES_ORDER, WORKBOOK_ORDER,
  SHEETJS_TOLERATED, strictly,
};
