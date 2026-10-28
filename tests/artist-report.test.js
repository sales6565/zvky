/* THE ARTIST REPORT: the rows, the file, and the rules that decide both.
 *
 * ===========================================================================
 * THE FILE IS CHECKED TWICE OVER, and deliberately not once.
 *
 * SheetJS reads it back as a workbook, which proves Excel can open it and that
 * a date is a date and a number is a number. But the community build cannot
 * report a fill colour, a border or an alignment — the very things the attached
 * template specifies — so the parts are ALSO read as XML out of the zip and
 * compared against the template's own styles. A test that only asserted the
 * values would pass on a file with no formatting in it at all, which is exactly
 * the failure this report is most likely to have.
 *
 * THE TEMPLATE IS IN THE TEST, not in a comment: the nine widths, the two fill
 * colours and the two border shapes below were read out of
 * Artist_Report_Download_Format.xlsx.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const xlsx = require('xlsx');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const artistXlsx = require('../src/artist-report-xlsx');
const artistReport = require('../src/artist-report');
const discipline = require('../src/asset-discipline');

const cfg = config('artistreport');
const PASSWORD = 'Artist-Report-1!';

/* ---- the format, with no database in it -------------------------------- */

/* The parts of a generated file, unzipped in memory with the system unzip —
   which also proves the archive is one a real tool can read. */
function partsOf(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artist-xlsx-'));
  const file = path.join(dir, 'book.xlsx');
  fs.writeFileSync(file, buffer);
  execFileSync('unzip', ['-q', '-o', file, '-d', path.join(dir, 'unz')]);
  const read = (name) => fs.readFileSync(path.join(dir, 'unz', name), 'utf8');
  return {
    sheet: read('xl/worksheets/sheet1.xml'),
    styles: read('xl/styles.xml'),
    workbook: read('xl/workbook.xml'),
    types: read('[Content_Types].xml'),
    dir,
  };
}

const SAMPLE = [
  { clientName: 'Acme Pictures', projectName: 'Hero Quest', department: 'Art',
    assetName: 'Hero Idle', resourceName: 'Ana Artist', submitDate: '2026-10-14',
    bidHours: 12, spentHours: 9.5, efficiency: 126.3 },
  { clientName: '', projectName: 'Hero Quest', department: 'Animation',
    assetName: 'Walk Cycle', resourceName: 'Bo Artist', submitDate: '2026-10-02',
    bidHours: null, spentHours: 0, efficiency: null },
];

test('the workbook opens, and is the sheet the template describes', () => {
  const buffer = artistXlsx.build({ rows: SAMPLE, title: 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026' });
  const book = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  assert.deepStrictEqual(book.SheetNames, ['Artist Report'],
    'one sheet, named Artist Report — the template calls it Sheet1 and the brief renamed it');
  const sheet = book.Sheets['Artist Report'];

  // The title, in the merged cell the template merges.
  assert.strictEqual(sheet.D1.v, 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026');
  assert.deepStrictEqual(sheet['!merges'], [{ s: { c: 3, r: 0 }, e: { c: 5, r: 0 } }],
    'D1:F1, and nothing else, is merged');

  /* THE HEADERS, EXACTLY AND IN ORDER. Read out of the template's
     sharedStrings: Client Name, Project Name, Department, Assets Name, Resource
     Name, Submit Date, Bid Hours, Spent Hours, Efficiency (%). */
  const headers = ['A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'H2', 'I2'].map((r) => sheet[r].v);
  assert.deepStrictEqual(headers, [
    'Client Name', 'Project Name', 'Department', 'Assets Name', 'Resource Name',
    'Submit Date', 'Bid Hours', 'Spent Hours', 'Efficiency (%)',
  ]);
  assert.deepStrictEqual(headers, artistXlsx.HEADERS, 'and the module agrees with itself');

  // Row 3: the first data row, with the types the brief asks for.
  assert.strictEqual(sheet.A3.v, 'Acme Pictures');
  assert.strictEqual(sheet.C3.v, 'Art');
  assert.strictEqual(sheet.F3.t, 'd', 'Submit Date is a real date cell, not text');
  assert.strictEqual(sheet.F3.v.toISOString().slice(0, 10), '2026-10-14');
  assert.strictEqual(sheet.G3.t, 'n');
  assert.strictEqual(sheet.G3.v, 12);
  assert.strictEqual(sheet.H3.t, 'n');
  assert.strictEqual(sheet.H3.v, 9.5);
  assert.strictEqual(sheet.I3.t, 'n');
  assert.strictEqual(sheet.I3.v, 126.3, 'the value is 126.3, not 1.263 — the header carries the %');

  /* A ROW WITH NOTHING TO SAY. No client, no bid, no time: three blank cells
     rather than three zeros, and no efficiency. */
  assert.ok(!sheet.A4 || sheet.A4.v === undefined || sheet.A4.v === '', `blank client: ${JSON.stringify(sheet.A4)}`);
  assert.ok(!sheet.G4 || sheet.G4.v === undefined, `blank bid: ${JSON.stringify(sheet.G4)}`);
  assert.ok(!sheet.I4 || sheet.I4.v === undefined, `blank efficiency: ${JSON.stringify(sheet.I4)}`);
  assert.strictEqual(sheet.H4.v, 0, 'but a measured nought is a nought');
});

test('the styling is the template’s, read out of the file', () => {
  const buffer = artistXlsx.build({ rows: SAMPLE, title: 'ARTIST REPORT' });
  const { sheet, styles } = partsOf(buffer);

  /* THE COLOURS, AS EXPLICIT RGB. The template uses theme indices — theme 9 on
     the title and theme 5 on two headers — which resolve through its own
     theme1.xml to accent6 70AD47 and accent2 ED7D31. Written as RGB here so a
     differently-themed Excel cannot render the studio's report in other
     colours, which is what the brief asked for. */
  assert.match(styles, /<fgColor rgb="FF70AD47"\/>/, 'the title fill is green 70AD47');
  assert.match(styles, /<fgColor rgb="FFFFFF00"\/>/, 'the yellow headers are FFFF00');
  assert.match(styles, /<fgColor rgb="FFED7D31"\/>/, 'and Department and Submit Date are orange ED7D31');
  assert.ok(!/theme=/.test(styles), 'no theme colours anywhere in the styles');

  // Calibri 11, and a bold face for the title and the headers.
  assert.match(styles, /<font><sz val="11"\/><color rgb="FF000000"\/><name val="Calibri"\/>/);
  assert.match(styles, /<font><b\/><sz val="11"\/><color rgb="FF000000"\/><name val="Calibri"\/>/);

  /* The two borders the template has: thin on the bottom only, for the title's
     merged cell, and thin on all four sides for everything else. */
  const borders = /<borders count="3">([\s\S]*?)<\/borders>/.exec(styles)[1];
  assert.match(borders, /<border><left\/><right\/><top\/><bottom style="thin">/, 'a bottom-only border');
  assert.match(borders,
    /<border><left style="thin">[\s\S]*?<right style="thin">[\s\S]*?<top style="thin">[\s\S]*?<bottom style="thin">/,
    'and a four-sided one');

  /* WHICH STYLE EACH CELL USES, which is what ties the colours to the columns.
     The style index of a header cell is read out of the sheet and looked up in
     cellXfs; its fill has to be the right one. */
  const cellXfs = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(styles)[1];
  const xfs = cellXfs.match(/<xf [\s\S]*?(?:\/>|<\/xf>)/g);
  const fillOf = (xfIndex) => {
    const m = /fillId="(\d+)"/.exec(xfs[xfIndex]);
    return Number(m ? m[1] : 0);
  };
  const fills = /<fills count="\d+">([\s\S]*?)<\/fills>/.exec(styles)[1].match(/<fill>[\s\S]*?<\/fill>/g);
  const rgbOf = (fillIndex) => {
    const m = /<fgColor rgb="FF([0-9A-F]{6})"\/>/.exec(fills[fillIndex] || '');
    return m ? m[1] : null;
  };
  const styleOf = (ref) => {
    const m = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet);
    assert.ok(m, `${ref} carries a style`);
    return Number(m[1]);
  };

  const YELLOW = ['A2', 'B2', 'D2', 'E2', 'G2', 'H2', 'I2'];
  const ORANGE = ['C2', 'F2'];
  for (const ref of YELLOW) {
    assert.strictEqual(rgbOf(fillOf(styleOf(ref))), 'FFFF00', `${ref} is yellow`);
  }
  for (const ref of ORANGE) {
    assert.strictEqual(rgbOf(fillOf(styleOf(ref))), 'ED7D31', `${ref} is orange`);
  }
  assert.strictEqual(rgbOf(fillOf(styleOf('D1'))), '70AD47', 'the title is green');

  // Bold and centred both ways, on the title and every header.
  for (const ref of [...YELLOW, ...ORANGE, 'D1']) {
    const xf = xfs[styleOf(ref)];
    assert.match(xf, /fontId="1"/, `${ref} is bold`);
    assert.match(xf, /horizontal="center" vertical="center"/, `${ref} is centred both ways`);
  }
  // Text left, numbers and dates centred, in the data.
  assert.match(xfs[styleOf('A3')], /horizontal="left"/, 'text is left-aligned');
  for (const ref of ['F3', 'G3', 'H3', 'I3']) {
    assert.match(xfs[styleOf(ref)], /horizontal="center"/, `${ref} is centred`);
  }
  // And every data cell has the four-sided border.
  for (const ref of ['A3', 'F3', 'I3', 'A4', 'H4']) {
    assert.match(xfs[styleOf(ref)], /borderId="2"/, `${ref} has borders`);
  }

  /* THE NUMBER FORMATS, by name. dd-mmm-yyyy on the date, 0.00 on both hour
     columns, 0.0 on the percentage. */
  const numFmts = /<numFmts count="\d+">([\s\S]*?)<\/numFmts>/.exec(styles)[1];
  assert.match(numFmts, /numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/);
  assert.match(numFmts, /numFmtId="165" formatCode="0\.00"/);
  assert.match(numFmts, /numFmtId="166" formatCode="0\.0"/);
  const fmtOf = (ref) => Number(/numFmtId="(\d+)"/.exec(xfs[styleOf(ref)])[1]);
  assert.strictEqual(fmtOf('F3'), 164);
  assert.strictEqual(fmtOf('G3'), 165);
  assert.strictEqual(fmtOf('H3'), 165);
  assert.strictEqual(fmtOf('I3'), 166);

  // Freeze panes below the headers, and an autofilter on them.
  assert.match(sheet, /<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<autoFilter ref="A2:I4"\/>/);
});

test('the column widths start at the template’s and grow to fit, up to a point', () => {
  /* READ OUT OF THE TEMPLATE: A 12, B 13.140625, C 11.7109375, D 12.42578125,
     E 15, F 11.85546875, G 9.42578125, H 11.7109375, I 13.140625. The report
     may be wider than these, never narrower. */
  const TEMPLATE = [12, 13.14, 11.71, 12.42, 15, 11.85, 9.42, 11.71, 13.14];
  const plain = artistXlsx.widthsFor(SAMPLE);
  plain.forEach((w, i) => {
    assert.ok(w.width >= TEMPLATE[i] - 0.01,
      `column ${i} is ${w.width}, narrower than the template's ${TEMPLATE[i]}`);
    assert.ok(!w.wrapping, `column ${i} should not need wrapping for short names`);
  });

  // A long name widens its column, to the cap, and then wraps instead.
  const long = [{ ...SAMPLE[0], assetName: 'A'.repeat(120) }];
  const wide = artistXlsx.widthsFor(long);
  assert.strictEqual(wide[3].width, artistXlsx.MAX_WIDTH, 'capped at 40 characters');
  assert.strictEqual(wide[3].wrapping, true, 'and the column wraps beyond it');
  const { sheet, styles } = partsOf(artistXlsx.build({ rows: long, title: 'T' }));
  const xfs = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(styles)[1]
    .match(/<xf [\s\S]*?(?:\/>|<\/xf>)/g);
  const style = Number(/<c r="D3" s="(\d+)"/.exec(sheet)[1]);
  assert.match(xfs[style], /wrapText="1"/, 'the long cell wraps');
  // A name just over the template width widens the column rather than wrapping.
  const medium = artistXlsx.widthsFor([{ ...SAMPLE[0], resourceName: 'Bartholomew Fotheringay' }]);
  assert.ok(medium[4].width > 15 && medium[4].width <= artistXlsx.MAX_WIDTH, `${medium[4].width}`);
  assert.strictEqual(medium[4].wrapping, false);
});

test('a name that looks like a formula stays a name', () => {
  /* The four shapes that turn into formulas or commands when a spreadsheet
     decides a string is an expression. There is no <f> element in this writer
     at all, which is what makes this structural rather than a filter. */
  const nasty = ['=1+1', '+cmd|"/c calc"!A1', '@SUM(A1)', '-2+3', '=HYPERLINK("http://x")'];
  const rows = nasty.map((name, i) => ({
    ...SAMPLE[0], assetName: name, resourceName: `R${i}`, clientName: name, projectName: name,
  }));
  const buffer = artistXlsx.build({ rows, title: '=1+1' });
  const { sheet } = partsOf(buffer);
  assert.ok(!/<f[ >]/.test(sheet), 'no formula element anywhere in the sheet');
  const book = xlsx.read(buffer, { type: 'buffer' });
  const read = book.Sheets['Artist Report'];
  nasty.forEach((name, i) => {
    const ref = `D${i + 3}`;
    assert.strictEqual(read[ref].t, 's', `${ref} is a string cell`);
    assert.strictEqual(read[ref].v, name, `${ref} keeps the text exactly`);
    assert.strictEqual(read[ref].f, undefined, `${ref} is not a formula`);
  });
  assert.strictEqual(read.D1.v, '=1+1', 'and so is the title');
});

test('unicode, very long and control-charactered names survive', () => {
  const rows = [
    { ...SAMPLE[0], assetName: 'Zoë Müller — ключ 日本語 🎬', resourceName: 'Søren Ødegård' },
    { ...SAMPLE[0], assetName: 'X'.repeat(500), resourceName: 'Y'.repeat(300) },
    // A vertical tab is legal in a studio's typing and illegal in XML 1.0.
    { ...SAMPLE[0], assetName: `Broken\u000bName`, resourceName: 'Ana' },
  ];
  const buffer = artistXlsx.build({ rows, title: 'T' });
  const book = xlsx.read(buffer, { type: 'buffer' });
  const sheet = book.Sheets['Artist Report'];
  assert.strictEqual(sheet.D3.v, 'Zoë Müller — ключ 日本語 🎬');
  assert.strictEqual(sheet.E3.v, 'Søren Ødegård');
  assert.strictEqual(sheet.D4.v.length, 500, 'a 500-character name is not truncated');
  assert.strictEqual(sheet.D5.v, 'BrokenName', 'and an illegal control character is dropped, not escaped');
});

test('an empty report is still a file with a title and headers', () => {
  const buffer = artistXlsx.build({ rows: [], title: 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026' });
  const book = xlsx.read(buffer, { type: 'buffer' });
  const sheet = book.Sheets['Artist Report'];
  assert.strictEqual(sheet.D1.v, 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026');
  assert.strictEqual(sheet.I2.v, 'Efficiency (%)');
  assert.strictEqual(sheet.A3, undefined, 'and no rows');
  const { sheet: xml } = partsOf(buffer);
  assert.match(xml, /<autoFilter ref="A2:I2"\/>/, 'the header row can still be filtered');
  assert.match(xml, /state="frozen"/);
});

test('the date serial is the calendar day, with no timezone in it', () => {
  /* Checked against arithmetic rather than against a remembered number:
     2026-01-01 is 46023, and 14 October is the 287th day of a non-leap year, so
     46023 + 287 - 1. SheetJS reads the same serial back as 2026-10-14, which is
     the half that actually matters. */
  assert.strictEqual(artistXlsx.dateSerial('2026-01-01'), 46023);
  assert.strictEqual(artistXlsx.dateSerial('2026-10-14'), 46309);
  assert.strictEqual(artistXlsx.dateSerial('2024-02-29'), 45351, 'a leap day is a day');
  /* THE 1899-12-30 EPOCH IS RIGHT FROM 1900-03-01 ONWARDS, which is where
     Excel's deliberate 1900 leap-year bug stops mattering. Submissions are
     modern, so that is not a limitation this report can meet; it is recorded
     here so nobody reuses dateSerial() for a birthdate in 1899 and wonders. */
  assert.strictEqual(artistXlsx.dateSerial('1900-03-01'), 61);
  assert.strictEqual(artistXlsx.dateSerial(''), null);
  assert.strictEqual(artistXlsx.dateSerial('not a date'), null);
  /* AND IT READS BACK AS THE SAME DAY. The query hands over 'YYYY-MM-DD' from
     DATE_FORMAT, so there is no instant to shift: a submission at half past
     midnight is the day the range filter matched. */
  const buffer = artistXlsx.build({ rows: [{ ...SAMPLE[0], submitDate: '2026-01-01' }], title: 'T' });
  const sheet = xlsx.read(buffer, { type: 'buffer', cellDates: true }).Sheets['Artist Report'];
  assert.strictEqual(sheet.F3.v.toISOString().slice(0, 10), '2026-01-01');
});

test('efficiency is the asset’s, rounded to one decimal, and blank where it cannot be given', () => {
  const eff = (bidHours, assetSeconds) => artistReport.assetEfficiency({ bidHours, assetSeconds });
  // 12 bid against 9.5 recorded: 126.3%, faster than bid.
  assert.strictEqual(eff(12, 9.5 * 3600), 126.3);
  // Rounded to one decimal, not truncated.
  assert.strictEqual(eff(10, 3 * 3600), 333.3);
  assert.strictEqual(eff(1, 1.05 * 3600), 95.2);
  // Exactly on the bid.
  assert.strictEqual(eff(8, 8 * 3600), 100);
  // Slower than bid is under 100.
  assert.strictEqual(eff(4, 8 * 3600), 50);
  /* BLANK, NOT ZERO. No recorded time, no estimate, a nought estimate, a
     negative or a missing one: all of them are "cannot be given". */
  for (const args of [[12, 0], [0, 3600], [null, 3600], [undefined, 3600], [-1, 3600], [12, null]]) {
    assert.strictEqual(eff(...args), null, `eff(${JSON.stringify(args)}) must be blank`);
  }
  /* AND IT IS THE EFFICIENCY REPORT'S RULE, not a second one — the same
     function, so the two reports cannot disagree about what 85.5 means. */
  const reports = require('../src/reports');
  assert.strictEqual(Math.round(reports.efficiencyOf(12, 9.5 * 3600) * 10) / 10, eff(12, 9.5 * 3600));
});

test('the title and the file name both carry the range', () => {
  const filters = { from: '2026-10-01', to: '2026-10-31' };
  assert.strictEqual(artistReport.titleFor(filters), 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026');
  assert.strictEqual(artistReport.fileNameFor(filters), 'Artist_Report_2026-10-01_to_2026-10-31.xlsx');
  // The default range is the month we are in.
  assert.deepStrictEqual(artistReport.defaultRange(new Date(2026, 1, 9)),
    { from: '2026-02-01', to: '2026-02-28' }, 'February, which is also the leap-year check');
  assert.deepStrictEqual(artistReport.defaultRange(new Date(2024, 1, 9)),
    { from: '2024-02-01', to: '2024-02-29' });
});

test('the department filter is the shared rule, not a copy of it in SQL', () => {
  /* The predicate and the function have to agree for every type, including the
     ones nobody thought of — a `CASE WHEN type = 'animation'` in a query would
     be the second copy of the rule that Prompt 52 removed. */
  const TYPES = [...require('../src/reference-defaults').ASSET_TYPES.map((t) => t.key),
    'rigging', 'layout', 'ANIMATION', ' animation ', 'animations', '', null];
  for (const id of discipline.DISCIPLINE_IDS) {
    const where = discipline.disciplineWhere(id, 'type');
    assert.ok(where, `${id} has a predicate`);
    for (const type of TYPES) {
      // The predicate, evaluated in JavaScript the way MySQL would evaluate it.
      const value = type === null || type === undefined ? null : String(type).trim().toLowerCase();
      const matches = id === 'animation'
        ? value === where.params[0]
        : (value === null || value !== where.params[0]);
      assert.strictEqual(matches, discipline.assetDiscipline({ type }) === id,
        `${id} disagreed about ${JSON.stringify(type)}`);
    }
  }
  // Anything that is not a discipline is no filter at all, not an empty report.
  assert.strictEqual(discipline.disciplineWhere('rigging'), null);
  assert.strictEqual(discipline.disciplineWhere(''), null);
});

/* ===========================================================================
 * THE ROWS, against a real database and a real server.
 *
 * ONE SUBMISSION IS MADE THROUGH THE API, start to finish, so the report is
 * proved against a genuine asset_versions row written by the application. The
 * rest of the matrix is inserted directly: the workflow allows one asset in
 * progress per person at a time and refuses a submission on an asset that was
 * never started, so building a dozen rounds through the endpoints would be a
 * test of the workflow rather than of this report — and back-dating a
 * submission to last month is not something the API can do at all.
 */
test('the Artist Report, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);

  /* A submission, as a row. `created_at` is the whole point of the fixture —
     the range filter selects on it — so it is given rather than taken from the
     clock. */
  const submission = async (assetId, userId, when, versionNumber = 1) => {
    await q(
      `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, versionNumber, 'tl', 'https://drive.example.com/x', userId, when]
    );
  };
  /* A stretch of recorded work. `seconds` is what close() would have stored —
     working seconds with leave already removed — so the figures below are exact
     rather than wall-clock-dependent. */
  const session = async (assetId, userId, seconds, when = '2026-10-05 10:00:00') => {
    await q(
      `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
       VALUES (?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), assetId, userId, 1, when, when, seconds]
    );
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'ar-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'ar-token', name: 'Root', email: 'root@ar.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@ar.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('ana', 'Ana Artist', 'ana@ar.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@ar.test', 'game_artist');
    await make('lead', 'Lee Lead', 'lead@ar.test', 'team_lead');
    // Somebody who has since left. Their work is still their work.
    await make('gone', 'Gail Gone', 'gone@ar.test', 'game_artist');

    id.acme = (await as('root', '/clients', { method: 'POST', body: { name: 'Acme Pictures' } })).body.client.id;
    id.unassigned = await systemClientId(server.base, token.root);

    const mkProject = async (key, name, clientId) => {
      const r = await as('root', '/projects', { method: 'POST', body: { name, clientId } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('hero', 'Hero Quest', id.acme);
    await mkProject('side', 'Side Job', id.unassigned);

    const mkAsset = async (key, projectKey, type, manHours, assignee) => {
      const r = await as('root', `/assets/project/${id[projectKey]}`, { method: 'POST',
        body: { name: `Asset ${key}`, type, manHours } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.asset.id;
      if (assignee) await as('root', `/assets/${id[key]}`, { method: 'PATCH', body: { assigneeId: id[assignee] } });
    };
    // Art and Animation, by the asset's type — the shared rule, see Prompt 52.
    await mkAsset('live', 'hero', 'character', 12, 'ana');     // submitted through the API below
    await mkAsset('anim', 'hero', 'animation', 6, 'bo');
    await mkAsset('shared', 'hero', 'character', 10, 'ana');   // two resources
    await mkAsset('noBid', 'hero', 'character', 0, 'ana');
    await mkAsset('noTime', 'hero', 'character', 5, 'ana');
    await mkAsset('farmed', 'hero', 'character', 8, 'ana');    // outsourced
    await mkAsset('side1', 'side', 'character', 4, 'gone');

    /* THE REAL ONE: accept, start, submit, through the endpoints. Its version
       row is written by the application, and the report has to pick it up. */
    const started = await as('ana', `/assets/${id.live}/start`, { method: 'POST' });
    assert.ok(started.status === 200 || started.status === 201, JSON.stringify(started.body));
    const submitted = await as('ana', `/assets/${id.live}/submit`, { method: 'POST',
      body: { link: 'https://drive.example.com/hero-idle', description: 'first pass' } });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    await q('UPDATE asset_versions SET created_at = ? WHERE asset_id = ?', ['2026-10-14 09:30:00', id.live]);
    // The session the start/submit pair opened and closed, given an exact length.
    await q('UPDATE work_sessions SET seconds = ?, ended_at = ? WHERE asset_id = ?',
      [Math.round(9.5 * 3600), '2026-10-14 09:30:00', id.live]);

    // An animation asset, in range, with time.
    await submission(id.anim, id.bo, '2026-10-02 11:00:00');
    await session(id.anim, id.bo, 3 * 3600);

    /* TWO RESOURCES ON ONE ASSET. Ana handed it over to Bo, who submitted it
       again: two rows, one bid, one asset-level efficiency. 10 bid against 4+6
       hours is exactly 100%. */
    await submission(id.shared, id.ana, '2026-10-06 10:00:00');
    await submission(id.shared, id.bo, '2026-10-20 10:00:00', 2);
    await session(id.shared, id.ana, 4 * 3600);
    await session(id.shared, id.bo, 6 * 3600);

    // No bid: hours but nothing to compare them against.
    await submission(id.noBid, id.ana, '2026-10-07 10:00:00');
    await session(id.noBid, id.ana, 2 * 3600);
    // A bid but no recorded time at all.
    await submission(id.noTime, id.ana, '2026-10-08 10:00:00');

    /* OUTSOURCED, and submitted — so it would be a row if the report did not
       exclude it. The internal assignee is cleared first, which is what the
       application does when work goes out. */
    await submission(id.farmed, id.ana, '2026-10-09 10:00:00');
    const freelancer = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Fran Freelance', discipline: 'art' } });
    await q('UPDATE assets SET assignee_id = NULL WHERE id = ?', [id.farmed]);
    const sent = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: freelancer.body.freelancer.id, projectId: id.hero, assetId: id.farmed, decidedManHours: 8 } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    // The other project, submitted by somebody who has since been deactivated.
    await submission(id.side1, id.gone, '2026-10-10 10:00:00');
    await session(id.side1, id.gone, 1 * 3600);
    const off = await as('root', `/users/${id.gone}/deactivate`, { method: 'POST', body: {} });
    assert.ok(off.status === 200, JSON.stringify(off.body));

    // Out of range: September, and November.
    await submission(id.live, id.bo, '2026-09-30 23:59:59', 2);
    await session(id.live, id.bo, 7 * 3600);
  });

  t.after(async () => { await stopServer(server); });

  const OCT = 'from=2026-10-01&to=2026-10-31';
  const rowsOf = (body) => body.rows.map((r) =>
    [r.clientName, r.projectName, r.department, r.assetName, r.resourceName,
      r.submitDate, r.bidHours, r.spentHours, r.efficiency]);

  await t.test('one row per asset and resource, in the order the brief asks for', async () => {
    const r = await as('root', `/reports/artist?${OCT}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    /* CLIENT, PROJECT, RESOURCE, SUBMIT DATE — in that order, which is why all
       of Ana's rows precede all of Bo's rather than the whole page being in
       date order. Acme before Unassigned; within Acme, Ana before Bo.
       
       `Asset live` reads 72.7% rather than the 126.3% its 12-against-9.5 might
       suggest: Bo also recorded seven hours on it in September, and the
       efficiency is the asset's. The subtest below is about exactly that. */
    assert.deepStrictEqual(rowsOf(r.body), [
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset shared', 'Ana Artist', '2026-10-06', 10, 4, 100],
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset noBid', 'Ana Artist', '2026-10-07', 0, 2, null],
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset noTime', 'Ana Artist', '2026-10-08', 5, 0, null],
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset live', 'Ana Artist', '2026-10-14', 12, 9.5, 72.7],
      ['Acme Pictures', 'Hero Quest', 'Animation', 'Asset anim', 'Bo Artist', '2026-10-02', 6, 3, 200],
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset shared', 'Bo Artist', '2026-10-20', 10, 6, 100],
      // 4 hours bid, 1 recorded: four times as fast as bid, not a quarter.
      ['Unassigned', 'Side Job', 'Art', 'Asset side1', 'Gail Gone', '2026-10-10', 4, 1, 400],
    ], JSON.stringify(rowsOf(r.body), null, 1));
    assert.strictEqual(r.body.total, 7);
    assert.strictEqual(r.body.outsourcedExcluded, 1, 'and the outsourced asset is counted, not listed');
  });

  await t.test('a resource’s latest submission is the one that dates the row', async () => {
    /* Ana submitted `live` on the 14th. A rejected round and its resubmission
       are ONE row, dated the resubmission — so a second, later round by the
       same person moves the date rather than adding a row. */
    await submission(id.live, id.ana, '2026-10-22 16:00:00', 3);
    const r = await as('root', `/reports/artist?${OCT}`);
    const mine = r.body.rows.filter((x) => x.assetName === 'Asset live' && x.resourceName === 'Ana Artist');
    assert.strictEqual(mine.length, 1, 'still one row');
    assert.strictEqual(mine[0].submitDate, '2026-10-22', 'dated the latest, not the first');
    assert.strictEqual(r.body.total, 7, 'and the row count has not moved');
    // Put it back so the rest of the file sees the fixture it expects.
    await q('DELETE FROM asset_versions WHERE asset_id = ? AND version_number = 3', [id.live]);
  });

  await t.test('the range selects rows by submit date and never clips the hours', async () => {
    /* Bo's September submission on `live` is out of range, so there is no row
       for it — but Bo's seven hours on that asset are still part of what the
       asset cost, which is what the efficiency of Ana's row is measured
       against. 12 bid ÷ (9.5 + 7) hours = 72.7%. */
    const r = await as('root', `/reports/artist?${OCT}`);
    const ana = r.body.rows.find((x) => x.assetName === 'Asset live');
    assert.strictEqual(ana.resourceName, 'Ana Artist');
    assert.strictEqual(ana.spentHours, 9.5, 'her own hours, whole');
    assert.strictEqual(ana.assetSpentHours, 16.5, 'and the asset cost 16.5 across both of them');
    assert.strictEqual(ana.efficiency, 72.7, 'which is what the bid is compared against');
    assert.ok(!r.body.rows.some((x) => x.submitDate < '2026-10-01' || x.submitDate > '2026-10-31'));

    // September alone finds Bo's round, and his hours are still the whole of them.
    const sept = await as('root', '/reports/artist?from=2026-09-01&to=2026-09-30');
    assert.deepStrictEqual(rowsOf(sept.body), [
      ['Acme Pictures', 'Hero Quest', 'Art', 'Asset live', 'Bo Artist', '2026-09-30', 12, 7, 72.7],
    ]);
    assert.strictEqual(sept.body.rows[0].spentHours, 7,
      'not clipped to September — the bid is for the whole asset, so both sides are whole');
  });

  await t.test('a multi-resource asset repeats the bid and shares one efficiency', async () => {
    const r = await as('root', `/reports/artist?${OCT}`);
    const shared = r.body.rows.filter((x) => x.assetName === 'Asset shared');
    assert.strictEqual(shared.length, 2, 'two resources, two rows');
    assert.deepStrictEqual(shared.map((x) => x.resourceName).sort(), ['Ana Artist', 'Bo Artist']);
    assert.deepStrictEqual(shared.map((x) => x.bidHours), [10, 10], 'the bid is the asset’s, on both rows');
    assert.deepStrictEqual(shared.map((x) => x.spentHours).sort((a, b) => a - b), [4, 6],
      'their own hours differ');
    assert.deepStrictEqual(shared.map((x) => x.efficiency), [100, 100],
      'and the efficiency is the asset’s: 10 bid against 10 hours');
    assert.ok(shared.every((x) => x.sharedAsset), 'flagged, so the screen can explain the repeat');
    const single = r.body.rows.find((x) => x.assetName === 'Asset anim');
    assert.strictEqual(single.sharedAsset, false);
    assert.strictEqual(single.efficiency, 200, 'a single-resource asset’s is their own');
  });

  await t.test('no hours or no bid is blank, not nought', async () => {
    const r = await as('root', `/reports/artist?${OCT}`);
    const noBid = r.body.rows.find((x) => x.assetName === 'Asset noBid');
    assert.strictEqual(noBid.bidHours, 0);
    assert.strictEqual(noBid.spentHours, 2);
    assert.strictEqual(noBid.efficiency, null, 'nothing to be efficient against');
    const noTime = r.body.rows.find((x) => x.assetName === 'Asset noTime');
    assert.strictEqual(noTime.spentHours, 0);
    assert.strictEqual(noTime.efficiency, null, 'and nothing to measure');
  });

  await t.test('outsourced work is left out, and said to be left out', async () => {
    const r = await as('root', `/reports/artist?${OCT}`);
    assert.ok(!r.body.rows.some((x) => x.assetName === 'Asset farmed'),
      'a freelancer has no login and no timer, so every row of theirs would be noughts');
    assert.strictEqual(r.body.outsourcedExcluded, 1);
    // And it is excluded from the total, not merely hidden from the page.
    assert.strictEqual(r.body.total, r.body.rows.length);
  });

  await t.test('every filter, and the combinations', async () => {
    const count = async (query) => (await as('root', `/reports/artist?${OCT}&${query}`)).body;
    assert.strictEqual((await count(`resourceId=${id.ana}`)).total, 4);
    assert.strictEqual((await count(`resourceId=${id.ana},${id.bo}`)).total, 6, 'multi-select');
    assert.strictEqual((await count(`projectId=${id.side}`)).total, 1);
    assert.strictEqual((await count(`clientId=${id.acme}`)).total, 6);
    assert.strictEqual((await count('department=animation')).total, 1);
    assert.strictEqual((await count('department=art')).total, 6);
    assert.strictEqual((await count('department=rigging')).total, 7, 'an unknown department is no filter');
    // Combined, they narrow rather than widen.
    assert.strictEqual((await count(`clientId=${id.acme}&department=animation`)).total, 1);
    assert.strictEqual((await count(`projectId=${id.hero}&resourceId=${id.gone}`)).total, 0);
    // An empty result is a real answer, with the note still attached.
    const none = await count(`resourceId=${id.root}`);
    assert.deepStrictEqual(none.rows, []);
    assert.strictEqual(none.total, 0);
  });

  await t.test('an inactive resource is in the report and in the picker', async () => {
    const r = await as('root', `/reports/artist?${OCT}&resourceId=${id.gone}`);
    assert.strictEqual(r.body.total, 1);
    assert.strictEqual(r.body.rows[0].resourceName, 'Gail Gone');
    const picked = r.body.pickers.resources.find((p) => p.id === id.gone);
    assert.ok(picked, 'somebody who left is still selectable — they submitted the work');
    assert.strictEqual(picked.active, false, 'and is marked as gone');
  });

  await t.test('the default range is the current month', async () => {
    const r = await as('root', '/reports/artist');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    assert.strictEqual(r.body.filters.from, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`);
    assert.strictEqual(r.body.filters.to.slice(0, 8), `${now.getFullYear()}-${pad(now.getMonth() + 1)}-`);
  });

  await t.test('the preview is paged in the database, with the whole count', async () => {
    const r = await as('root', `/reports/artist?${OCT}&page=1`);
    assert.strictEqual(r.body.pageSize, 100);
    assert.strictEqual(r.body.pages, 1);
    assert.strictEqual(r.body.page, 1);
    // A page past the end comes back as the last page rather than empty.
    const far = await as('root', `/reports/artist?${OCT}&page=99`);
    assert.strictEqual(far.body.page, 1);
    assert.strictEqual(far.body.rows.length, 7);
  });

  await t.test('the download is the same rows, as the attached format', async () => {
    const res = await fetch(`${server.base}/reports/artist.xlsx?${OCT}`, {
      headers: { Authorization: `Bearer ${token.root}` },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(res.headers.get('content-disposition'),
      /attachment; filename="Artist_Report_2026-10-01_to_2026-10-31\.xlsx"/);
    const buffer = Buffer.from(await res.arrayBuffer());
    const sheet = xlsx.read(buffer, { type: 'buffer', cellDates: true }).Sheets['Artist Report'];
    assert.strictEqual(sheet.D1.v, 'ARTIST REPORT · 01-Oct-2026 to 31-Oct-2026');
    assert.strictEqual(sheet.A2.v, 'Client Name');
    // Row 3 is the first row of the preview, in the same order.
    const preview = (await as('root', `/reports/artist?${OCT}`)).body.rows;
    assert.strictEqual(sheet.A3.v, preview[0].clientName);
    assert.strictEqual(sheet.D3.v, preview[0].assetName);
    assert.strictEqual(sheet.E3.v, preview[0].resourceName);
    assert.strictEqual(sheet.F3.v.toISOString().slice(0, 10), preview[0].submitDate);
    assert.strictEqual(sheet.G3.v, preview[0].bidHours);
    assert.strictEqual(sheet.H3.v, preview[0].spentHours);
    assert.strictEqual(sheet.I3.v, preview[0].efficiency);
    // Seven rows and no more.
    assert.strictEqual(sheet['!ref'], 'A1:I9', `rows 3..9 and nothing else: ${sheet['!ref']}`);
  });

  await t.test('an empty result still downloads a file with the title and the headers', async () => {
    const res = await fetch(`${server.base}/reports/artist.xlsx?from=2030-01-01&to=2030-01-31`, {
      headers: { Authorization: `Bearer ${token.root}` },
    });
    assert.strictEqual(res.status, 200);
    const sheet = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' }).Sheets['Artist Report'];
    assert.match(sheet.D1.v, /^ARTIST REPORT/);
    assert.strictEqual(sheet.I2.v, 'Efficiency (%)');
    assert.strictEqual(sheet.A3, undefined);
  });

  await t.test('both endpoints need the key, and the tab entry is hidden without it', async () => {
    for (const p of [`/reports/artist?${OCT}`, `/reports/artist.xlsx?${OCT}`]) {
      const r = await as('ana', p);
      assert.strictEqual(r.status, 403, `${p}: ${JSON.stringify(r.body)}`);
    }
    /* THE KEY IS NOT report.view. A reader trusted with efficiency does not
       thereby get a per-person file of everybody's hours. */
    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((x) => x.enabled).map((x) => x.key);
    assert.ok(!held.includes('report.artist_report'));
    const withView = await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.view'])] } });
    assert.strictEqual(withView.status, 200, JSON.stringify(withView.body));
    assert.strictEqual((await as('ana', `/reports/artist?${OCT}`)).status, 403,
      'View Reports is not View Artist Report');
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: held } });
  });

  await t.test('the rows are scoped to the projects the reader can see', async () => {
    /* A lead sees their team's projects, not the studio's.
     
       THE LEAD IS PUT ON ONE PROJECT FIRST, and that is the whole point of the
       fixture: a lead who can see NOTHING passes a "sees fewer rows"
       assertion trivially — build() returns early on an empty project list — so
       dropping the scope entirely would not have failed anything. Mutation 8
       found that, and this is the correction. Hero Quest is theirs; Side Job is
       not. */
    const onTeam = await as('root', `/projects/${id.hero}`, { method: 'PATCH',
      body: { teamLeadIds: [id.lead] } });
    assert.strictEqual(onTeam.status, 200, JSON.stringify(onTeam.body));
    const held = (await as('root', '/permissions/roles/team_lead')).body.role.permissions
      .filter((x) => x.enabled).map((x) => x.key);
    await as('root', '/permissions/roles/team_lead', { method: 'PUT',
      body: { permissions: [...new Set([...held, 'report.artist_report'])] } });
    try {
      const all = await as('root', `/reports/artist?${OCT}`);
      const mine = await as('lead', `/reports/artist?${OCT}`);
      assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
      assert.ok(mine.body.total > 0, 'the lead can see their own project\u2019s rows');
      assert.ok(mine.body.total < all.body.total,
        `the lead sees fewer rows than the Super Admin: ${mine.body.total} of ${all.body.total}`);
      /* NAMED, not merely fewer: the other project's row has to be absent. */
      assert.ok(mine.body.rows.every((r) => r.projectName === 'Hero Quest'),
        `only their own project: ${[...new Set(mine.body.rows.map((r) => r.projectName))].join(', ')}`);
      assert.ok(all.body.rows.some((r) => r.projectName === 'Side Job'),
        'and the Super Admin does see the one they cannot');
      const visible = new Set(mine.body.pickers.projects.map((p) => p.id));
      for (const row of mine.body.rows) {
        assert.ok(visible.has(row.projectId), `${row.projectName} is outside the lead’s scope`);
      }
      // And the download is scoped the same way, not merely the preview.
      const res = await fetch(`${server.base}/reports/artist.xlsx?${OCT}`, {
        headers: { Authorization: `Bearer ${token.lead}` },
      });
      const sheet = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' }).Sheets['Artist Report'];
      const names = Object.keys(sheet).filter((k) => /^B\d+$/.test(k) && Number(k.slice(1)) >= 3)
        .map((k) => sheet[k].v);
      assert.ok(names.length, 'the lead\u2019s file has rows in it');
      assert.ok(names.every((n) => n === 'Hero Quest'), `${[...new Set(names)].join(', ')}`);
      assert.strictEqual(names.length, mine.body.total, 'the file has exactly the rows the preview counted');
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: held } });
      await as('root', `/projects/${id.hero}`, { method: 'PATCH', body: { teamLeadIds: [] } });
    }
  });

  await t.test('the grouped hours are the same figure recordedFor gives one at a time', async () => {
    /* THE N+1 THIS REPORT DOES NOT DO, pinned. src/work-log.js's recordedFor()
       is the application's definition of recorded time for one asset and one
       person; the report builds a GROUP BY out of the expressions that module
       exports. If the two ever disagreed, every Spent Hours in the report would
       be wrong in a way no other screen would show. */
    const r = await as('root', `/reports/artist?${OCT}`);
    for (const row of r.body.rows) {
      const [direct] = await q(
        `SELECT COALESCE(SUM(COALESCE(seconds, 0)), 0) AS seconds
           FROM work_sessions WHERE asset_id = ? AND user_id = ?`, [row.assetId, row.resourceId]);
      assert.strictEqual(row.spentHours, Math.round((Number(direct.seconds) / 3600) * 100) / 100,
        `${row.assetName} / ${row.resourceName}`);
    }
  });

  await t.test('the submission record and the status history agree about who submitted', async () => {
    /* Submit Date is read from asset_versions. asset_events records the same
       transition (action='submit', actor_id) in the same request, and this is
       what would notice if the two ever stopped agreeing — in which case the
       report would be dating rows from a table that had drifted. Checked for
       the one submission made through the API, which is the only one with an
       event behind it. */
    const events = await q(
      `SELECT e.actor_id, e.created_at FROM asset_events e
        WHERE e.asset_id = ? AND e.action = 'submit'`, [id.live]);
    assert.strictEqual(events.length, 1, 'one real submission in the fixture');
    const versions = await q(
      'SELECT uploaded_by FROM asset_versions WHERE asset_id = ? AND version_number = 1', [id.live]);
    assert.strictEqual(versions[0].uploaded_by, events[0].actor_id,
      'the version and the event name the same person');
  });

  await t.test('the number of queries does not grow with the number of rows', async () => {
    /* MEASURED AT THE DATABASE, which is the only place it can be: the server
       is a separate process. Com_select counts statements; the suite runs one
       request at a time against an idle server with the sweeps switched off, so
       the delta is this request. The assertion is that the two deltas are
       EQUAL, not that either is under some number — "no N+1" is a statement
       about the shape, and a magic number would also fail the day somebody adds
       a legitimate query. */
      const selects = async () => {
      const [row] = await q("SHOW GLOBAL STATUS LIKE 'Com_select'");
      return Number(row.Value);
    };
    const measure = async (query) => {
      const before = await selects();
      const r = await as('root', `/reports/artist?${query}`);
      assert.strictEqual(r.status, 200);
      const after = await selects();
      // Minus the two SHOW statements' own selects is not needed: SHOW is not
      // a SELECT. The one extra is this measurement's own round trip.
      return { queries: after - before, rows: r.body.rows.length, total: r.body.total };
    };

    /* The download is measured too, and separately: it skips the filter
       pickers, so it legitimately costs fewer queries than the preview. What
       has to hold for both is that the count does not move when the row count
       does. */
    const downloadCost = async () => {
      const before = await selects();
      const res = await fetch(`${server.base}/reports/artist.xlsx?${OCT}`, {
        headers: { Authorization: `Bearer ${token.root}` },
      });
      assert.strictEqual(res.status, 200);
      const rows = xlsx.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
        .Sheets['Artist Report']['!ref'];
      return { queries: (await selects()) - before, ref: rows };
    };

    const small = await measure(OCT);
    assert.strictEqual(small.rows, 7);
    const smallFile = await downloadCost();

    /* FOUR HUNDRED MORE ROWS, inserted in one statement, all in range: a new
       asset per row so each is its own (asset, resource) pair with its own
       recorded time. */
    const values = [];
    const params = [];
    for (let i = 0; i < 400; i += 1) {
      params.push(crypto.randomUUID(), `Bulk ${String(i).padStart(3, '0')}`, `BLK-${i}`, id.hero, 'character', 4);
      values.push('(?,?,?,?,?,?,\'not_started\',\'med\',NOW())');
    }
    await q(`INSERT INTO assets (id, \`name\`, \`code\`, project_id, \`type\`, man_hours, \`status\`, priority, created_at)
             VALUES ${values.join(',')}`, params);
    const bulk = await q('SELECT id FROM assets WHERE `code` LIKE ?', ['BLK-%']);
    const vParams = [];
    const vValues = [];
    const wParams = [];
    const wValues = [];
    bulk.forEach((row, i) => {
      vParams.push(crypto.randomUUID(), row.id, 1, 'tl', 'https://x.test/a', id.ana, '2026-10-15 10:00:00');
      vValues.push('(?,?,?,?,?,?,?)');
      wParams.push(crypto.randomUUID(), row.id, id.ana, 1, '2026-10-15 09:00:00', '2026-10-15 10:00:00', 3600 * (i % 5 + 1));
      wValues.push('(?,?,?,?,?,?,?)');
    });
    await q(`INSERT INTO asset_versions (id, asset_id, version_number, stage, link, uploaded_by, created_at)
             VALUES ${vValues.join(',')}`, vParams);
    await q(`INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
             VALUES ${wValues.join(',')}`, wParams);

    const big = await measure(`${OCT}&page=2`);
    assert.strictEqual(big.total, 407, 'the extra rows are in the report');
    assert.strictEqual(big.rows, 100, 'a full page');
    assert.strictEqual(big.queries, small.queries,
      `7 rows cost ${small.queries} queries and 407 cost ${big.queries} — that is an N+1`);

    // And the download of all 407 costs what the download of 7 cost.
    const bigFile = await downloadCost();
    assert.strictEqual(bigFile.queries, smallFile.queries,
      `7 rows cost ${smallFile.queries} queries to download and 407 cost ${bigFile.queries}`);
    assert.strictEqual(smallFile.ref, 'A1:I9', 'the small file is 7 rows');
    assert.strictEqual(bigFile.ref, 'A1:I409', '407 rows plus the title and the headers');

    // Leave the fixture as it was.
    await q('DELETE FROM assets WHERE `code` LIKE ?', ['BLK-%']);
  });
});
