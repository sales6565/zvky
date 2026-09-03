const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const xlsx = require('xlsx');
const { config, resetSchema, startServer, stopServer, api, raw, sql, systemClientId, pdfText, SKIP_REASON } = require('./helpers');
const exporter = require('../src/report-export');
const reportPdf = require('../src/report-pdf');
const reports = require('../src/reports');

const cfg = config('repexp');

// A report shaped like the real one, without needing a database.
function fakeReport(n = 3) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `a${i}`, code: `AST-${String(i).padStart(3, '0')}`, name: `Asset number ${i}`,
      type: 'prop', category: 'slot_game', categoryLabel: 'Slot Game', typeLabel: 'Prop',
      manHours: 10, status: 'delivered', assigneeId: `u${i % 2}`, assigneeName: i % 2 ? 'Ana Lee' : 'Bo Chen',
      projectId: 'p1', projectName: 'Nightgarden', clientId: 'c1', clientName: 'Acme',
      finishedAt: '2026-03-04 10:00:00', delivered: 1, rounds: 1, contributors: 1,
      totalSeconds: 3600 * (i % 4 === 0 ? 20 : 8), firstPassSeconds: 3600 * 8, submitted: true,
    });
  }
  return reports.build(rows, { grain: 'week' });
}

// --- the columns ---------------------------------------------------------------

test('the exported views match the ones the screen offers', () => {
  /* The sub-tabs are declared in public/index.html; the sheets are declared
     here. If somebody adds a view to one and not the other, a download quietly
     stops covering part of the report — so read the page and compare. */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const block = html.match(/const REPORT_VIEWS = \[([\s\S]*?)\];/);
  assert.ok(block, 'REPORT_VIEWS should still be declared in the page');
  const onScreen = [...block[1].matchAll(/id:'(\w+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(exporter.VIEWS.map((v) => v.id), onScreen,
    'every view on screen needs a sheet, in the same order');

  // And the head column is named the same in both.
  const heads = [...block[1].matchAll(/id:'(\w+)',\s*label:'[^']*',\s*head:'([^']*)'/g)]
    .map((m) => [m[1], m[2]]);
  for (const [id, head] of heads) {
    assert.strictEqual(exporter.viewById(id).head, head, `the head column for ${id}`);
  }
});

test('a missing number is N/A, never zero', () => {
  /* An asset with no tracked time has no efficiency. Writing 0 into a
     spreadsheet would be a number somebody averages, and the average would be
     wrong — so the cell says N/A and stays text. */
  const rows = exporter.groupRows([
    { label: 'Ana', assets: 2, firstPass: null, total: null, manHours: 4, timeSpentHours: 0 },
  ]);
  assert.strictEqual(rows[0]['First-pass %'], 'N/A');
  assert.strictEqual(rows[0]['Total %'], 'N/A');
  assert.notStrictEqual(rows[0]['First-pass %'], 0);
});

test('the export claims no judgement the report can no longer make', () => {
  /* There was an "Over budget" column here, carrying the red chip the screen
     drew for any group averaging under 80% across three or more assets.
     
     Both went when Time Spent became elapsed rather than worked. Under the old
     definition that threshold meant "these consistently take longer than
     estimated". Under this one it means "these are usually left open
     overnight", which is most work in most studios — so the flag would fire on
     the ordinary case, and a flag that always fires is one people stop reading.
     The percentages are still exported; the app's claim to know which of them
     is a problem is not. */
  const [a, b] = exporter.groupRows([
    { label: 'Table Game', assets: 4, firstPass: 40, total: 44, manHours: 29, timeSpentHours: 65 },
    { label: 'Slot Game', assets: 5, firstPass: 140, total: 135, manHours: 54, timeSpentHours: 43 },
  ]);
  assert.ok(!('Over budget' in a), 'no flag column');
  assert.strictEqual(a['Total %'], 44, 'but the number itself is still there to read');
  assert.strictEqual(b['Total %'], 135);
  assert.strictEqual(a['Time Spent (h)'], 65, 'under a heading that says what it measures');
});

test('every export states what Time Spent means, and when it changed', () => {
  /* A spreadsheet outlives the screen it came from. Somebody opening one next
     quarter was never told the definition changed, so the file has to say it. */
  const clean = exporter.timeBasis({ at: null, date: null, legacyRows: 0, mixed: false });
  assert.strictEqual(clean.length, 1, 'a deployment with no old data warns about nothing');
  assert.match(clean[0][1], /elapsed span from Accept and Start to Submit for Review/);
  assert.match(clean[0][1], /Not active worked time/);

  /* The date, not the timestamp. src/work-log.js supplies both, because a
     driver Date String()d and sliced gives "Fri Aug 28" — no year, in a file
     somebody opens next year. */
  const mixed = exporter.timeBasis({
    at: '2026-09-01T10:00:00.000Z', date: '2026-09-01', legacyRows: 12, mixed: true,
  });
  assert.strictEqual(mixed.length, 2, 'and one that does gets the second line');
  assert.match(mixed[1][1], /2026-09-01/, 'naming the date the meaning changed');
  assert.match(mixed[1][1], /not comparable/);
});

test('an empty view still has headers', () => {
  // A blank rectangle with no headings tells a reader nothing about what was
  // searched for and came back empty.
  const empty = reports.build([]);
  for (const view of exporter.VIEWS) {
    const headers = exporter.headersFor(empty, view.id);
    assert.ok(headers.length >= 3, `${view.id} should still name its columns`);
    /* The grouped views lead with their head column, the way the screen's
       <th> does. Every Asset is the exception on screen too — it opens with
       Code, and its `head` is only the sub-tab's label. */
    if (view.id !== 'assets') {
      assert.strictEqual(headers[0], view.head, `${view.id} leads with its own head column`);
    } else {
      assert.strictEqual(headers[0], 'Code');
    }
  }
});

test('the PDF renderer refuses rows it would draw blank', () => {
  /* The Time Sheet and the Activity Log both shipped an export whose table was
     entirely empty: their routes mapped each row object through the header list
     into a positional array, and the renderer reads every cell by header name.
     row['Hours'] on an array is undefined, which is indistinguishable from an
     empty cell, so the document came out valid, correctly totalled, and blank.

     A silent wrong answer is the failure mode worth closing, so the shape is
     now a checked contract. Each case below is one way a caller can get it
     wrong, and each has to raise rather than render. */
  const { checkRows } = require('../src/report-pdf');
  const headers = ['Date', 'Hours', 'Notes'];

  assert.doesNotThrow(() => checkRows(headers, [{ Date: '2026-03-02', Hours: 3, Notes: '' }]),
    'row objects keyed by header are the contract');
  assert.doesNotThrow(() => checkRows(headers, []), 'and no rows at all is a legitimate answer');

  // The bug as it actually shipped.
  assert.throws(() => checkRows(headers, [['2026-03-02', 3, '']]),
    /positional array/, 'positional arrays must be refused, not drawn as blanks');

  // The subtler version: objects, but keyed by something else.
  assert.throws(() => checkRows(headers, [{ date: '2026-03-02', hours: 3 }]),
    /no header matches/, 'a rename on one side of the call must not render an empty table');

  assert.throws(() => checkRows(headers, [null]), /must be an object/);
  assert.throws(() => checkRows(headers, ['2026-03-02']), /must be an object/);
  assert.throws(() => checkRows(headers, null), /must be an array/);
});

test('the filters are described in words, not ids', () => {
  const names = {
    projects: [{ id: 'p1', name: 'Nightgarden' }],
    clients: [{ id: 'c1', name: 'Acme' }],
    users: [{ id: 'u1', name: 'Ana Lee' }],
    categories: [{ key: 'slot_game', label: 'Slot Game' }],
    scopes: [{ key: 'prop', label: 'Prop' }],
  };
  const described = exporter.describeFilters(
    { from: '2026-01-01', to: '2026-03-31', projectId: 'p1', clientId: 'c1', assigneeId: 'u1', category: 'slot_game', scope: 'prop' },
    names
  );
  const asText = described.map(([k, v]) => `${k}: ${v}`).join(' | ');
  assert.match(asText, /Date range: 2026-01-01 to 2026-03-31/);
  assert.match(asText, /Project\/Game: Nightgarden/);
  assert.match(asText, /Client: Acme/);
  assert.match(asText, /User: Ana Lee/);
  assert.match(asText, /Category: Slot Game/);
  assert.match(asText, /Scope of Work: Prop/);
  assert.ok(!/p1|c1|u1|slot_game/.test(asText), 'a reader outside the studio cannot resolve an id');

  // No filters is itself worth stating: "none" and "someone forgot to say" look
  // identical on a page otherwise.
  assert.match(exporter.describeFilters({}, names)[0][1], /None/);
});

test('the filename says whose report it is and when', () => {
  const at = new Date('2026-03-04T00:00:00Z');
  assert.strictEqual(exporter.fileName('ZVKY FORGE', null, 'xlsx', at), 'zvky-forge-efficiency-2026-03-04.xlsx');
  assert.strictEqual(exporter.fileName('ZVKY FORGE', 'byUser', 'pdf', at), 'zvky-forge-efficiency-by-user-2026-03-04.pdf');
  // A studio name full of punctuation must not produce a broken filename.
  assert.match(exporter.fileName('Ácme / Studio™', 'trend', 'pdf', at), /^[a-z0-9.-]+$/);
});

// --- the PDF -------------------------------------------------------------------

async function renderPdf(opts) {
  const chunks = [];
  const sink = { write: (c) => chunks.push(Buffer.from(c)), end: () => {}, on: () => {}, once: () => {}, emit: () => {} };
  await new Promise((resolve) => {
    const doc = reportPdf.write(sink, opts);
    doc.on('end', resolve);
  });
  return Buffer.concat(chunks);
}

const pdfOpts = (report, viewId, extra = {}) => ({
  appName: 'ZVKY FORGE', tagline: 'art asset & animation pipeline', logo: null,
  view: exporter.viewById(viewId),
  headers: exporter.headersFor(report, viewId),
  rows: exporter.rowsFor(report, viewId),
  filters: exporter.describeFilters({ projectId: 'p1' }, { projects: [{ id: 'p1', name: 'Nightgarden' }] }),
  summary: exporter.summaryRows(report),
  excluded: exporter.exclusionRows(report),
  ...extra,
});

test('the PDF carries the branding, the filters and the time it was made', async () => {
  const { text } = pdfText(await renderPdf(pdfOpts(fakeReport(3), 'byUser')));
  assert.match(text, /ZVKY FORGE/, 'the app name from Settings');
  assert.match(text, /art asset & animation pipeline/, 'and the tagline');
  assert.match(text, /Work efficiency — By User/, 'the view it is of');
  assert.match(text, /Project\/Game: Nightgarden/, 'what it was filtered to');
  assert.match(text, /Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, 'and when');
  assert.match(text, /Page 1 of 1/, 'with a page number');
});

test('a long report paginates instead of running off the page', async () => {
  const report = fakeReport(400);
  const buf = await renderPdf(pdfOpts(report, 'assets'));
  const { pages, text } = pdfText(buf);
  assert.ok(pages > 5, `400 assets should need several pages, got ${pages}`);

  // Every row is present — the failure this guards against is a table that
  // simply stops at the bottom of page one.
  const codes = new Set(text.match(/AST-\d{3}/g) || []);
  assert.strictEqual(codes.size, 400, `every asset should appear, found ${codes.size}`);

  // The last page knows how many there are, and the heading repeats.
  assert.match(text, new RegExp(`Page ${pages} of ${pages}`));
  const headings = (text.match(/ASSETS NAME/g) || []).length;
  assert.strictEqual(headings, pages, 'the column headings repeat on every page');
});

test('nothing is silently cut: every heading and every code is complete', async () => {
  /* The Every Asset view is fourteen columns. Two earlier attempts at fitting
     it truncated the wrong thing — first the headings ("SCOPE OF W…"), then the
     asset codes ("PAG-…"), which makes a row unidentifiable. Headings wrap onto
     two lines now and nothing ellipsises. */
  const report = fakeReport(30);
  const { text } = pdfText(await renderPdf(pdfOpts(report, 'assets')));
  for (const h of exporter.headersFor(report, 'assets')) {
    assert.ok(text.includes(h.toUpperCase()), `the "${h}" heading should be complete`);
  }
  assert.strictEqual((text.match(/…/g) || []).length, 0, 'no cell should have been ellipsised');
  assert.strictEqual(new Set(text.match(/AST-\d{3}/g) || []).size, 30, 'every code intact');
});

test('an empty report is a document that says so, not a broken one', async () => {
  const { text, pages } = pdfText(await renderPdf(pdfOpts(reports.build([]), 'byUser')));
  assert.strictEqual(pages, 1);
  assert.match(text, /Nothing to report on with these filters/);
  assert.match(text, /Page 1 of 1/);
});

test('a logo that pdfkit cannot read does not cost you the report', async () => {
  // The branding module accepts SVG, which pdfkit cannot place, and an upload
  // could be corrupt. Neither may turn a download into a 500.
  for (const logo of [
    { mime: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    { mime: 'image/png', buffer: Buffer.from('not really a png') },
  ]) {
    const { text } = pdfText(await renderPdf(pdfOpts(fakeReport(2), 'byUser', { logo })));
    assert.match(text, /ZVKY FORGE/, `the name still carries the header for ${logo.mime}`);
  }
});

// --- against a live server -----------------------------------------------------

test('downloading the report', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Export-Test-1!';
  let server;
  let projectId;
  const token = {};

  const as = (who, path, options = {}) => api(server.base, path, { ...options, token: token[who] });
  const download = async (who, path) => {
    const res = await fetch(server.base + path, { headers: { Authorization: `Bearer ${token[who]}` } });
    return {
      status: res.status,
      type: res.headers.get('content-type') || '',
      disposition: res.headers.get('content-disposition') || '',
      buffer: Buffer.from(await res.arrayBuffer()),
    };
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'export-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST', body: { token: 'export-token', name: 'Root', email: 'root@export.test', password: PASSWORD },
    });
    const sign = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await sign('root@export.test');

    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST', body: { clientId, name: 'Nightgarden' } })).body.project.id;
    const artist = (await as('root', '/users', {
      method: 'POST', body: { name: 'Ana Lee', email: 'ana@export.test', role: 'game_artist', password: PASSWORD, projectId },
    })).body.user.id;
    token.artist = await sign('ana@export.test');

    /* Two assets that can be reported on, in two categories, so a filter has
       something to exclude. The categories have to exist first — they are
       managed reference data, and the API refuses one it does not know. */
    for (const label of ['Slot Game', 'Table Game']) {
      await as('root', '/reference/categories', { method: 'POST', body: { label } });
    }
    const categories = (await as('root', '/reference')).body.categories || [];
    const keyFor = (label) => (categories.find((c) => c.label === label) || {}).key;

    for (const [name, label, hours] of [['Reel Frame', 'Slot Game', 10], ['Card Table', 'Table Game', 6]]) {
      const category = keyFor(label);
      assert.ok(category, `the ${label} category should exist`);
      const created = await as('root', `/assets/project/${projectId}`, {
        method: 'POST',
        body: { name, type: 'prop', category, priority: 'med', assigneeId: artist, manHours: hours },
      });
      assert.strictEqual(created.status, 201, `could not create ${name}: ${JSON.stringify(created.body)}`);
      const asset = created.body.asset;
      await sql(cfg, `INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds)
        VALUES (UUID(), '${asset.id}', '${artist}', 1, NOW(), NOW(), ${hours * 3600})`);
      await sql(cfg, `INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description, uploaded_by)
        VALUES (UUID(), '${asset.id}', 1, 'tl', 'https://example.test/x', 'First pass', '${artist}')`);
    }
  });

  t.after(async () => { await stopServer(server); });

  await t.test('both formats need View Reports, and nothing more', async () => {
    /* Deliberately no separate download permission: reading a report and taking
       a copy of the one you are reading are the same act, and the file holds
       nothing the screen does not already show. */
    for (const ext of ['xlsx', 'pdf']) {
      const denied = await download('artist', `/reports/efficiency.${ext}`);
      assert.strictEqual(denied.status, 403, `a contributor cannot download the ${ext}`);
      const allowed = await download('root', `/reports/efficiency.${ext}`);
      assert.strictEqual(allowed.status, 200, `someone who may read the report may download the ${ext}`);
    }
    // And the same permission the screen itself uses.
    const screen = await as('artist', '/reports/efficiency');
    assert.strictEqual(screen.status, 403, 'the same gate as viewing');
  });

  await t.test('the spreadsheet holds every view', async () => {
    const res = await download('root', '/reports/efficiency.xlsx');
    assert.match(res.type, /spreadsheetml/);
    assert.match(res.disposition, /attachment; filename=".*\.xlsx"/);

    const book = xlsx.read(res.buffer, { type: 'buffer' });
    /* Summary first, then every efficiency view in the order the sub-tabs show
       them. The Idle Report is appended after those for a reader who holds View
       Idle Report, so this asserts the efficiency sheets are all there and in
       order rather than pinning the exact list — which would break again the
       next time the workbook legitimately gains something. */
    assert.deepStrictEqual(
      book.SheetNames.slice(0, exporter.VIEWS.length + 1),
      ['Summary', ...exporter.VIEWS.map((v) => v.sheet)],
      'one sheet per efficiency view, led by the Summary');
    const extra = book.SheetNames.slice(exporter.VIEWS.length + 1);
    assert.ok(extra.every((n) => n === exporter.IDLE_VIEW.sheet),
      `anything after those should be the Idle sheet, got ${extra.join(', ')}`);

    const assets = xlsx.utils.sheet_to_json(book.Sheets['Every Asset']);
    assert.strictEqual(assets.length, 2);
    assert.deepStrictEqual(Object.keys(assets[0]).slice(0, 5),
      ['Code', 'Assets Name', 'Assignee', 'Category', 'Scope of Work'],
      'headers read the way the screen reads');

    const summary = xlsx.utils.sheet_to_json(book.Sheets.Summary, { header: 1 });
    const flat = summary.map((r) => r.join(': ')).join(' | ');
    assert.match(flat, /Generated/, 'the Summary sheet is dated');
    assert.match(flat, /Assets reported: 2/);
  });

  await t.test('a filter narrows the file, and the file says which filter', async () => {
    const tableGame = ((await as('root', '/reference')).body.categories || [])
      .find((c) => c.label === 'Table Game').key;
    const res = await download('root', `/reports/efficiency.xlsx?category=${tableGame}`);
    const book = xlsx.read(res.buffer, { type: 'buffer' });
    const assets = xlsx.utils.sheet_to_json(book.Sheets['Every Asset']);
    assert.strictEqual(assets.length, 1, 'only the filtered asset');
    assert.strictEqual(assets[0]['Assets Name'], 'Card Table');

    const summary = xlsx.utils.sheet_to_json(book.Sheets.Summary, { header: 1 });
    assert.ok(summary.some((r) => r[0] === 'Category' && /Table Game/.test(String(r[1]))),
      'the Summary sheet names the filter, so an emailed file still says what it covers');

    // The same filter, the same answer, through the PDF.
    const pdf = await download('root', `/reports/efficiency.pdf?category=${tableGame}&view=assets`);
    const { text } = pdfText(pdf.buffer);
    assert.match(text, /Card Table/);
    assert.ok(!/Reel Frame/.test(text), 'and nothing the filter excluded');
    assert.match(text, /Category: Table Game/);
  });

  await t.test('the PDF is of the view that was open', async () => {
    for (const view of ['byUser', 'byCategory', 'trend', 'assets']) {
      const res = await download('root', `/reports/efficiency.pdf?view=${view}`);
      assert.strictEqual(res.status, 200);
      assert.match(res.type, /application\/pdf/);
      const { text } = pdfText(res.buffer);
      assert.match(text, new RegExp(`Work efficiency — ${exporter.viewById(view).label}`),
        `the ${view} PDF should be titled as that view`);
      assert.match(res.disposition, new RegExp(exporter.fileName('x', view, 'pdf').replace(/^x-/, '').replace(/-\d{4}-\d{2}-\d{2}\.pdf$/, '')),
        'and named after it');
    }
  });

  await t.test('an unknown view falls back rather than failing', async () => {
    // A stale bookmark or a typed URL must not produce a 500.
    const res = await download('root', '/reports/efficiency.pdf?view=nonsense');
    assert.strictEqual(res.status, 200);
    assert.match(pdfText(res.buffer).text, /Work efficiency — By User/);
  });
});
