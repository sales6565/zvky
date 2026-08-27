const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, systemClientId } = require('./helpers');
const assetImport = require('../src/asset-import');

const cfg = config('bulk');

// --- pure checks, no database needed ----------------------------------------

test('the generated sample satisfies the importer that validates it', () => {
  const csv = assetImport.buildTemplateCsv();
  const [headerLine, ...dataLines] = csv.trim().split('\n');

  const headers = headerLine.split(',');
  assert.strictEqual(assetImport.validateHeaders(headers).ok, true);
  assert.ok(dataLines.length >= 2, 'the sample should carry a few example rows');

  // Parse it the way the endpoint does and validate each row.
  const { parse } = require('csv-parse/sync');
  const rows = parse(csv, { bom: true, columns: true, skip_empty_lines: true, trim: true });
  rows.forEach((row, i) => {
    const result = assetImport.validateRow(row, i + 2);
    assert.strictEqual(result.ok, true, `sample row ${i + 2} fails validation: ${JSON.stringify(result.errors)}`);
  });
});

test('header validation names what is missing rather than just failing', () => {
  const check = assetImport.validateHeaders(['title', 'nonsense']);
  assert.strictEqual(check.ok, false);
  assert.deepStrictEqual(check.missing, ['Assets Name', 'Category', 'Scope of Work', 'Man Hours']);
});

test('the sample asks for the five columns the sheet uses, and nothing else', () => {
  const header = assetImport.buildTemplateCsv().split('\n')[0].split(',');
  assert.deepStrictEqual(header, ['No.', 'Assets Name', 'Category', 'Scope of Work', 'Man Hours']);
});

test('older spellings of the renamed columns still import', () => {
  /* The screen calls these Assets Name and Scope of Work; the database calls
     them `name` and `type`. A file saved before either rename has to keep
     working, or a display change would have quietly broken imports. */
  for (const [spelling, key] of [
    ['assets_name', 'name'], ['Assets', 'name'], ['name', 'name'],
    ['scope_of_work', 'type'], ['Scope of Work', 'type'], ['type', 'type'],
  ]) {
    const check = assetImport.validateHeaders([spelling, 'category', 'man_hours',
      key === 'name' ? 'scope_of_work' : 'assets_name']);
    assert.deepStrictEqual(check.unknown, [], `${spelling} should not read as an unknown column`);
    const row = assetImport.validateRow(
      { [spelling]: key === 'name' ? 'X' : 'prop', category: 'Slot Game', man_hours: '4',
        ...(key === 'name' ? { type: 'prop' } : { name: 'X' }) }, 2);
    assert.strictEqual(row.ok, true, `${spelling} should parse: ${JSON.stringify(row.errors)}`);
    assert.strictEqual(row.values[key], key === 'name' ? 'X' : 'prop');
  }
});

test('the No. column is accepted and never stored', () => {
  /* It is a line number for whoever fills the sheet in. An asset's own
     reference is its code, which this application generates at creation, so
     there is nothing for No. to map to. */
  const check = assetImport.validateHeaders(['No.', 'Assets Name', 'Category', 'Scope of Work', 'Man Hours']);
  assert.strictEqual(check.ok, true);
  assert.deepStrictEqual(check.unknown, []);
  const row = assetImport.validateRow(
    { 'No.': '7', 'Assets Name': 'X', Category: 'Slot Game', 'Scope of Work': 'prop', 'Man Hours': '4' }, 2);
  assert.strictEqual(row.ok, true, JSON.stringify(row.errors));
  assert.ok(!('no' in row.values), 'No. must not reach the insert');
  assert.deepStrictEqual(Object.keys(row.values).sort(), ['category', 'man_hours', 'name', 'type']);
});

test('headers are matched despite case, spacing and a byte-order mark', () => {
  const check = assetImport.validateHeaders(['\ufeffAssets Name', '  CATEGORY  ', 'Scope Of Work', 'man hours']);
  assert.strictEqual(check.ok, true);
  assert.ok(check.present.includes('man_hours'));
});

test('a non-numeric Man Hours is caught before it reaches SQL', () => {
  // Number('notanumber') is NaN, and NaN reaching mysql2 is what used to abort
  // the whole import with ER_BAD_FIELD_ERROR.
  const result = assetImport.validateRow(
    { name: 'X', type: 'prop', category: 'Slot Game', man_hours: 'notanumber' }, 5);
  assert.strictEqual(result.ok, false);
  const error = result.errors.find((e) => e.column === 'Man Hours');
  assert.ok(error && /not a number/.test(error.message), JSON.stringify(result.errors));
});

test('Man Hours is required, and must be a positive number', () => {
  const missing = assetImport.validateRow({ name: 'X', type: 'prop', category: 'C' }, 3);
  assert.ok(missing.errors.some((e) => e.column === 'Man Hours' && /is required/.test(e.message)));

  for (const bad of ['0', '-4']) {
    const result = assetImport.validateRow(
      { name: 'X', type: 'prop', category: 'C', man_hours: bad }, 4);
    assert.strictEqual(result.ok, false, `${bad} should be refused`);
    assert.ok(result.errors.some((e) => e.column === 'Man Hours'));
  }
  const good = assetImport.validateRow(
    { name: 'X', type: 'prop', category: 'C', man_hours: '7.5' }, 5);
  assert.strictEqual(good.ok, true, JSON.stringify(good.errors));
  assert.strictEqual(good.values.man_hours, 7.5);
});

test('every row error names the row, the column and the reason', () => {
  const result = assetImport.validateRow({ name: '', type: 'nope', category: '', man_hours: '' }, 7);
  assert.strictEqual(result.ok, false);
  for (const error of result.errors) {
    assert.strictEqual(error.row, 7);
    assert.ok(typeof error.column === 'string' && error.column.length > 0);
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
  }
  // Reported under the headers the sheet uses, not the database keys.
  assert.deepStrictEqual(result.errors.map((e) => e.column).sort(),
    ['Assets Name', 'Category', 'Man Hours', 'Scope of Work']);
});

test('every required column is refused when blank', () => {
  const result = assetImport.validateRow({}, 2);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.errors.map((e) => e.column).sort(),
    ['Assets Name', 'Category', 'Man Hours', 'Scope of Work']);
});

// --- against a live server ---------------------------------------------------

test('bulk import', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Import-Test-Pass-1!';
  let server;
  let token;
  let projectId;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Import Admin', email: 'admin@zvky.test', password: PASSWORD },
    });
    const login = await api(server.base, '/auth/login', {
      method: 'POST', body: { email: 'admin@zvky.test', password: PASSWORD },
    });
    token = login.body.token;
    const clientId = await systemClientId(server.base, token);
    const project = await api(server.base, '/projects', {
      method: 'POST', token, body: { clientId, name: 'Import Target' },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  // Upload a file and, at the same time, keep asking for /health. If the
  // importer ever blocks the event loop, the health checks stop answering.
  async function upload(filename, content, mimeType = 'text/csv') {
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimeType }), filename);

    // Every started check is tracked as a promise and awaited before the
    // counts are read; counting a check that is still in flight as a miss
    // would report blocking that never happened.
    const checks = [];
    const poll = setInterval(() => {
      checks.push(
        fetch(`${server.base}/health`, { signal: AbortSignal.timeout(10000) })
          .then((res) => res.ok)
          .catch(() => false)
      );
    }, 50);

    let status;
    let body;
    try {
      const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      status = res.status;
      body = await res.json().catch(() => ({}));
    } finally {
      clearInterval(poll);
    }

    const outcomes = await Promise.all(checks);
    return {
      status,
      body,
      healthOk: outcomes.filter(Boolean).length,
      healthTotal: outcomes.length,
    };
  }

  const stillResponsive = (r) =>
    assert.ok(r.healthTotal === 0 || r.healthOk === r.healthTotal,
      `server missed ${r.healthTotal - r.healthOk} of ${r.healthTotal} health checks during the import`);

  await t.test('the sample file imports with no errors', async () => {
    const template = await fetch(`${server.base}/assets/import-template.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(template.status, 200);
    assert.match(template.headers.get('content-type'), /text\/csv/);
    const csv = await template.text();

    const result = await upload('template.csv', csv);
    assert.strictEqual(result.status, 201, JSON.stringify(result.body));
    assert.strictEqual(result.body.skipped, 0);
    assert.strictEqual(result.body.created, csv.trim().split('\n').length - 1);
    assert.deepStrictEqual(result.body.errors, []);
    stillResponsive(result);
  });

  await t.test('a file missing required columns is refused, naming them', async () => {
    const result = await upload('wrong.csv', 'title,nonsense\nFoo,bar\n');
    assert.strictEqual(result.status, 400);
    assert.deepStrictEqual(result.body.missingColumns,
      ['Assets Name', 'Category', 'Scope of Work', 'Man Hours']);
    assert.ok(Array.isArray(result.body.expectedColumns));
    stillResponsive(result);
  });

  await t.test('bad rows are skipped and reported; good rows still import', async () => {
    const csv = [
      'No.,Assets Name,Category,Scope of Work,Man Hours',
      '1,Keeper One,Slot Game,prop,5',
      '2,,Slot Game,prop,5',
      '3,Bad Scope,Slot Game,notatype,5',
      '4,Bad Hours,Slot Game,prop,notanumber',
      '5,No Hours,Slot Game,prop,',
      '6,No Category,,prop,5',
      '7,Keeper Two,Table Game,fx,3',
      '',
    ].join('\n');

    const result = await upload('mixed.csv', csv);
    assert.strictEqual(result.status, 207, JSON.stringify(result.body));
    assert.strictEqual(result.body.created, 2, 'the two good rows should import');
    assert.strictEqual(result.body.skipped, 5);
    for (const error of result.body.errors) {
      assert.strictEqual(typeof error.row, 'number');
      assert.ok(error.message);
    }
    assert.deepStrictEqual(result.body.errors.map((e) => e.row), [3, 4, 5, 6, 7]);
    // Each failure named by the header the sheet uses.
    assert.deepStrictEqual(
      result.body.errors.map((e) => e.column),
      ['Assets Name', 'Scope of Work', 'Man Hours', 'Man Hours', 'Category'],
    );
    stillResponsive(result);
  });

  await t.test('a file using either spelling of the scope column imports', async () => {
    const asNew = await upload('new.csv',
      'assets_name,category,scope_of_work,man_hours\nNew Spelling,Slot Game,prop,4\n');
    assert.strictEqual(asNew.status, 201, JSON.stringify(asNew.body));
    const asOld = await upload('old.csv',
      'name,category,type,man_hours\nOld Spelling,Slot Game,fx,4\n');
    assert.strictEqual(asOld.status, 201, JSON.stringify(asOld.body));
    // Either way the value lands on the `type` column the API reports.
    const { body } = await api(server.base, `/assets/project/${projectId}`, { token });
    const listed = body.assets.filter((a) => /Spelling$/.test(a.name));
    assert.deepStrictEqual(
      listed.map((a) => [a.name, a.type]).sort(),
      [['New Spelling', 'prop'], ['Old Spelling', 'fx']],
    );
  });

  await t.test('a row repeated inside the file is imported once', async () => {
    const result = await upload('dupes.csv',
      'Assets Name,Category,Scope of Work,Man Hours\nTwice Over,Slot Game,prop,4\nTwice Over,Slot Game,prop,4\n');
    assert.strictEqual(result.status, 207);
    assert.strictEqual(result.body.created, 1);
    assert.ok(/duplicates row 2/.test(result.body.errors[0].message), result.body.errors[0].message);
  });

  await t.test('re-uploading the same file does not duplicate what is there', async () => {
    const csv = 'Assets Name,Category,Scope of Work,Man Hours\nOnly Once,Slot Game,prop,4\n';
    const first = await upload('once.csv', csv);
    assert.strictEqual(first.body.created, 1);
    const second = await upload('once.csv', csv);
    assert.strictEqual(second.status, 207);
    assert.strictEqual(second.body.created, 0);
    assert.ok(/already exists/.test(second.body.errors[0].message));
  });

  await t.test('an empty file is refused', async () => {
    const result = await upload('empty.csv', '');
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /empty/i);
  });

  await t.test('a header row with no data is refused', async () => {
    const result = await upload('headers.csv', 'Assets Name,Category,Scope of Work,Man Hours\n');
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /no data rows/i);
  });

  await t.test('the wrong extension is a client error, not a server error', async () => {
    const result = await upload('notes.txt', 'hello', 'text/plain');
    assert.strictEqual(result.status, 400, 'a bad upload must not be reported as a 500');
    assert.match(result.body.error, /Unsupported file type/);
  });

  await t.test('a structurally broken file is refused with the reason', async () => {
    const result = await upload('broken.csv',
      'Assets Name,Category,Scope of Work,Man Hours\n"unterminated,Slot Game,prop,4\nok,Slot Game,prop,4\n');
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /could not be read/i);
    stillResponsive(result);
  });

  await t.test('a file past the row limit is refused before any of it is imported', async () => {
    const rows = ['Assets Name,Category,Scope of Work,Man Hours'];
    for (let i = 0; i < assetImport.MAX_ROWS + 1; i++) rows.push(`Over Limit ${i},Slot Game,prop,4`);
    const result = await upload('huge.csv', rows.join('\n'));
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.maxRows, assetImport.MAX_ROWS);
    assert.match(result.body.error, /limit is/);
    stillResponsive(result);
  });

  await t.test('a large valid file imports without blocking the server', async () => {
    const rows = ['Assets Name,Category,Scope of Work,Man Hours'];
    for (let i = 0; i < 2000; i++) rows.push(`Load Test ${i},Slot Game,prop,4`);
    const started = Date.now();
    const result = await upload('large.csv', rows.join('\n'));
    const elapsed = Date.now() - started;

    assert.strictEqual(result.status, 201, JSON.stringify(result.body).slice(0, 200));
    assert.strictEqual(result.body.created, 2000);
    stillResponsive(result);
    // Generous, but it catches a return to one round trip per row, which took
    // roughly ten times this long.
    assert.ok(elapsed < 30000, `2000 rows took ${elapsed}ms`);
  });

  await t.test('a category the sheet names but Settings does not hold is created', async () => {
    /* The decision here: an unknown Category is added to the list rather than
       refused, so a studio can bring its taxonomy in with its first import.
       Unknown Scope of Work is still refused — only categories are open. */
    const before = (await api(server.base, '/reference/categories', { token })).body.entries;
    assert.ok(!before.some((c) => /Bonus Round/i.test(c.label)));

    const result = await upload('newcat.csv',
      'Assets Name,Category,Scope of Work,Man Hours\n'
      + 'Wheel Spin,Bonus Round,fx,6\n'
      + 'Wheel Frame,bonus round,prop,3\n');   // same category, typed differently
    assert.strictEqual(result.status, 201, JSON.stringify(result.body));

    // Added once, not once per row, and reported rather than added silently.
    assert.deepStrictEqual(result.body.createdCategories.map((c) => c.label), ['Bonus Round']);
    const after = (await api(server.base, '/reference/categories', { token })).body.entries;
    assert.strictEqual(after.filter((c) => /bonus/i.test(c.label)).length, 1,
      'case and spacing differences must not produce two categories');

    // Both assets carry the same key, which is the one the dropdown offers.
    const key = after.find((c) => /bonus/i.test(c.label)).key;
    const { body } = await api(server.base, `/assets/project/${projectId}`, { token });
    for (const name of ['Wheel Spin', 'Wheel Frame']) {
      const asset = body.assets.find((a) => a.name === name);
      assert.strictEqual(asset.category, key, `${name} should hold the new category`);
    }
  });

  await t.test('an unknown Scope of Work is still refused, not created', async () => {
    const result = await upload('newscope.csv',
      'Assets Name,Category,Scope of Work,Man Hours\nOdd One,Slot Game,invented,4\n');
    assert.strictEqual(result.status, 207, JSON.stringify(result.body));
    assert.strictEqual(result.body.created, 0);
    assert.strictEqual(result.body.errors[0].column, 'Scope of Work');
  });

  await t.test('imported assets carry Category, Scope of Work and Man Hours', async () => {
    const result = await upload('full.csv',
      'No.,Assets Name,Category,Scope of Work,Man Hours\n1,Fully Filled,Table Game,environment,12.5\n');
    assert.strictEqual(result.status, 201, JSON.stringify(result.body));

    const { body } = await api(server.base, `/assets/project/${projectId}`, { token });
    const asset = body.assets.find((a) => a.name === 'Fully Filled');
    const cats = (await api(server.base, '/reference/categories', { token })).body.entries;
    assert.strictEqual(asset.category, cats.find((c) => c.label === 'Table Game').key);
    assert.strictEqual(asset.type, 'environment');
    assert.strictEqual(Number(asset.man_hours), 12.5);
    // Not imported, so every imported asset starts unassigned and untimed.
    assert.strictEqual(asset.status, 'not_started');
    assert.strictEqual(asset.assignee_id, null);
    assert.strictEqual(Number(asset.time_spent_seconds || 0), 0);
  });

  await t.test('the server is still healthy after every one of those', async () => {
    const health = await api(server.base, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
  });
});
