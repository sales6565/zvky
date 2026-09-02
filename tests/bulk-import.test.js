const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const assetImport = require('../src/asset-import');
const catalog = require('../src/permission-catalog');

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
  /* Only the two mandatory columns. Category and Man Hours became optional
     with the nine-column format, so a sheet without them is a valid sheet and
     naming them here would send somebody to add a column they do not need. */
  assert.deepStrictEqual(check.missing, ['Asset Name', 'Scope of Work']);
});

test('the sample asks for the nine columns the sheet uses, in order', () => {
  const header = assetImport.buildTemplateCsv().split('\n')[0].split(',');
  assert.deepStrictEqual(header, ['No.', 'Asset Name', 'Category', 'Scope of Work', 'Man Hours',
    'Assignee Email', 'Deadline', 'Project Link', 'Lead/Supervisor Notes']);
});

test('the sample carries a row with only the mandatory columns filled in', () => {
  /* The sample is the format's documentation, and the rule most easily got
     wrong is which columns are optional. A sample where every cell is
     populated teaches that all nine are needed, so one row deliberately is
     not — and it has to be a row this importer accepts. */
  const { parse } = require('csv-parse/sync');
  const rows = parse(assetImport.buildTemplateCsv(),
    { bom: true, columns: true, skip_empty_lines: true, trim: true });
  const bare = rows.find((r) => !r.Category && !r['Man Hours'] && !r['Assignee Email']
    && !r.Deadline && !r['Project Link'] && !r['Lead/Supervisor Notes']);
  assert.ok(bare, 'no row in the sample shows the mandatory-only case');
  assert.ok(bare['Asset Name'] && bare['Scope of Work'], 'and it still fills the two that are required');
  assert.strictEqual(assetImport.validateRow(bare, 2).ok, true);
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
  const check = assetImport.validateHeaders(['No.', 'Asset Name', 'Category', 'Scope of Work', 'Man Hours']);
  assert.strictEqual(check.ok, true);
  assert.deepStrictEqual(check.unknown, []);
  const row = assetImport.validateRow(
    { 'No.': '7', 'Asset Name': 'X', Category: 'Slot Game', 'Scope of Work': 'prop', 'Man Hours': '4' }, 2);
  assert.strictEqual(row.ok, true, JSON.stringify(row.errors));
  assert.ok(!('no' in row.values), 'No. must not reach the insert');
  assert.deepStrictEqual(Object.keys(row.values).sort(),
    ['assignee_email', 'category', 'due_date', 'lead_notes', 'man_hours', 'name', 'reference_link', 'type']);
});

test('headers are matched despite case, spacing and a byte-order mark', () => {
  const check = assetImport.validateHeaders(['\ufeffAsset Name', '  CATEGORY  ', 'Scope Of Work', 'man hours']);
  assert.strictEqual(check.ok, true);
  assert.ok(check.present.includes('man_hours'));
});

test('a non-numeric Man Hours costs the value, not the row', () => {
  /* Number('notanumber') is NaN, and NaN reaching mysql2 is what used to abort
     the whole import with ER_BAD_FIELD_ERROR. It is still caught here — but
     Man Hours is optional now, so catching it means dropping the estimate and
     keeping the asset, not throwing away a good name and scope of work. */
  const result = assetImport.validateRow(
    { name: 'X', type: 'prop', category: 'Slot Game', man_hours: 'notanumber' }, 5);
  assert.strictEqual(result.ok, true, 'the row survives');
  assert.strictEqual(result.values.man_hours, null, 'without a number anywhere near the insert');
  const warned = result.warnings.find((w) => w.column === 'Man Hours');
  assert.ok(warned && /not a number/.test(warned.message), JSON.stringify(result.warnings));
});

test('Man Hours is optional, and a nonsense value is a warning', () => {
  const missing = assetImport.validateRow({ name: 'X', type: 'prop', category: 'C' }, 3);
  assert.strictEqual(missing.ok, true, 'no estimate is an ordinary asset');
  assert.strictEqual(missing.values.man_hours, null);
  assert.deepStrictEqual(missing.warnings, [], 'and blank is not worth warning about');

  for (const bad of ['0', '-4']) {
    const result = assetImport.validateRow(
      { name: 'X', type: 'prop', category: 'C', man_hours: bad }, 4);
    assert.strictEqual(result.ok, true, `${bad} should not cost the row`);
    assert.strictEqual(result.values.man_hours, null);
    assert.ok(result.warnings.some((w) => w.column === 'Man Hours'));
  }
  const good = assetImport.validateRow(
    { name: 'X', type: 'prop', category: 'C', man_hours: '7.5' }, 5);
  assert.strictEqual(good.ok, true, JSON.stringify(good.errors));
  assert.strictEqual(good.values.man_hours, 7.5);
});

test('every row error names the row, the column and the reason', () => {
  const result = assetImport.validateRow({ name: '', type: '', category: '', man_hours: '' }, 7);
  assert.strictEqual(result.ok, false);
  for (const error of result.errors) {
    assert.strictEqual(error.row, 7);
    assert.ok(typeof error.column === 'string' && error.column.length > 0);
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
  }
  // Reported under the headers the sheet uses, not the database keys — and only
  // the two that can actually reject a row.
  assert.deepStrictEqual(result.errors.map((e) => e.column).sort(),
    ['Asset Name', 'Scope of Work']);
});

test('an empty row is refused for the two mandatory columns and no others', () => {
  const result = assetImport.validateRow({}, 2);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.errors.map((e) => e.column).sort(),
    ['Asset Name', 'Scope of Work']);
  assert.deepStrictEqual(result.warnings, [],
    'a blank optional column is not a problem to report');
});

test('a row with only Asset Name and Scope of Work is a complete row', () => {
  const result = assetImport.validateRow({ 'Asset Name': 'Lone Pine', 'Scope of Work': 'prop' }, 2);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.warnings, []);
  assert.strictEqual(result.values.name, 'Lone Pine');
  assert.strictEqual(result.values.type, 'prop');
  for (const optional of ['category', 'man_hours', 'assignee_email', 'due_date',
    'reference_link', 'lead_notes']) {
    assert.strictEqual(result.values[optional], null, `${optional} should come through as nothing`);
  }
});

test('Deadline reads DD-MM-YYYY, and refuses what it cannot read', () => {
  const parse = (raw) => assetImport.validateRow(
    { 'Asset Name': 'X', 'Scope of Work': 'prop', Deadline: raw }, 4);

  assert.strictEqual(parse('31-03-2026').values.due_date, '2026-03-31');
  assert.strictEqual(parse('01-01-2026').values.due_date, '2026-01-01');
  // ISO is unambiguous, so it is accepted alongside — it is what an export gives you.
  assert.strictEqual(parse('2026-04-15').values.due_date, '2026-04-15');
  // Slashes and dots are the same date written by a different export.
  assert.strictEqual(parse('31/03/2026').values.due_date, '2026-03-31');

  /* A day that does not exist. Every bound a month and a day can be checked
     against passes here, which is why this is round-tripped rather than
     range-checked. */
  const impossible = parse('31-02-2026');
  assert.strictEqual(impossible.ok, true, 'still not a reason to lose the asset');
  assert.strictEqual(impossible.values.due_date, null);
  assert.ok(/not a real date/.test(impossible.warnings[0].message), JSON.stringify(impossible.warnings));

  const words = parse('next friday');
  assert.strictEqual(words.ok, true);
  assert.strictEqual(words.values.due_date, null);
  assert.ok(/DD-MM-YYYY/.test(words.warnings[0].message),
    'the warning should say the format it wanted');

  // A real date cell out of a spreadsheet arrives as a Date and needs no parsing.
  assert.strictEqual(parse(new Date(2026, 5, 9)).values.due_date, '2026-06-09');
});

test('Assignee Email is checked for shape here and for a person in the endpoint', () => {
  const parse = (raw) => assetImport.validateRow(
    { 'Asset Name': 'X', 'Scope of Work': 'prop', 'Assignee Email': raw }, 4);

  assert.strictEqual(parse('Priya@Studio.Example').values.assignee_email, 'priya@studio.example',
    'lower-cased, because that is how it will be looked up');
  assert.strictEqual(parse('').values.assignee_email, null);

  const nonsense = parse('not an email');
  assert.strictEqual(nonsense.ok, true, 'an unusable address does not cost the asset');
  assert.strictEqual(nonsense.values.assignee_email, null);
  assert.ok(/not an email address/.test(nonsense.warnings[0].message));

  /* Deliberately NOT rejected here: this address is well-formed and may well
     belong to nobody. That is a database question, and the endpoint answers it
     — with a warning, on the same rule. */
  assert.strictEqual(parse('ghost@nowhere.example').values.assignee_email, 'ghost@nowhere.example');
});

test('Project Link is judged by the same rule the asset panel uses', () => {
  const parse = (raw) => assetImport.validateRow(
    { 'Asset Name': 'X', 'Scope of Work': 'prop', 'Project Link': raw }, 4);

  assert.strictEqual(parse('https://drive.example.com/brief').values.reference_link,
    'https://drive.example.com/brief');
  // The same permissiveness the panel has: a host with no dot in it is the
  // most common case in a building with a NAS.
  assert.strictEqual(parse('http://nas/shots/ep01').values.reference_link, 'http://nas/shots/ep01');
  assert.strictEqual(parse('').values.reference_link, null);

  const bad = parse('drive.example.com/brief');
  assert.strictEqual(bad.ok, true, 'a bad link does not cost the asset');
  assert.strictEqual(bad.values.reference_link, null);
  assert.ok(/No link was set/.test(bad.warnings[0].message));
});

test('Lead/Supervisor Notes come through under any of the spellings a sheet uses', () => {
  for (const header of ['Lead/Supervisor Notes', 'lead_supervisor_notes', 'Lead Notes',
    'Supervisor Notes']) {
    const row = assetImport.validateRow(
      { 'Asset Name': 'X', 'Scope of Work': 'prop', [header]: '  Watch the silhouette.  ' }, 2);
    assert.strictEqual(row.ok, true, `${header}: ${JSON.stringify(row.errors)}`);
    assert.strictEqual(row.values.lead_notes, 'Watch the silhouette.', `${header} should be read`);
  }
  assert.deepStrictEqual(assetImport.validateHeaders(
    ['Asset Name', 'Scope of Work', 'Lead/Supervisor Notes']).unknown, []);
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
    assert.deepStrictEqual(result.body.missingColumns, ['Asset Name', 'Scope of Work']);
    assert.ok(Array.isArray(result.body.expectedColumns));
    stillResponsive(result);
  });

  await t.test('bad rows are skipped and reported; good rows still import', async () => {
    /* The same file the five-column format was tested with, and it now says
       something different — which is the whole change. Only a blank Asset Name
       or Scope of Work throws a row away; a bad Man Hours or a missing Category
       costs that value and keeps the asset. */
    const csv = [
      'No.,Asset Name,Category,Scope of Work,Man Hours',
      '1,Keeper One,Slot Game,prop,5',
      '2,,Slot Game,prop,5',
      '3,Bad Hours,Slot Game,prop,notanumber',
      '4,No Hours,Slot Game,prop,',
      '5,No Category,,prop,5',
      '6,No Scope,Slot Game,,5',
      '7,Keeper Two,Table Game,fx,3',
      '',
    ].join('\n');

    const result = await upload('mixed.csv', csv);
    assert.strictEqual(result.status, 207, JSON.stringify(result.body));
    assert.strictEqual(result.body.created, 5, 'only the two truly incomplete rows are lost');
    assert.strictEqual(result.body.skipped, 2);
    for (const error of result.body.errors) {
      assert.strictEqual(typeof error.row, 'number');
      assert.ok(error.message);
    }
    // Row 3 has no Asset Name; row 7 has no Scope of Work.
    assert.deepStrictEqual(result.body.errors.map((e) => e.row), [3, 7]);
    assert.deepStrictEqual(
      result.body.errors.map((e) => e.column),
      ['Asset Name', 'Scope of Work'],
    );

    /* Row 4's unreadable Man Hours is the one thing that changed shape rather
       than disappearing: it is now a warning, the asset exists, and the sheet's
       author is still told. A dropped value that nobody is told about would be
       worse than the rejection it replaced. */
    const hours = result.body.warnings.find((w) => w.row === 4);
    assert.ok(hours, `no warning for row 4: ${JSON.stringify(result.body.warnings)}`);
    assert.strictEqual(hours.column, 'Man Hours');
    assert.ok(/not a number/.test(hours.message));
    assert.ok(result.body.createdAssets.some((a) => a.name === 'Bad Hours'),
      'and the asset itself is there');

    // Rows 5 and 6 — no hours at all, no category — are ordinary now: imported,
    // and not worth a word.
    assert.ok(!result.body.warnings.some((w) => w.row === 5 || w.row === 6),
      `a blank optional column should be silent: ${JSON.stringify(result.body.warnings)}`);
    stillResponsive(result);
  });

  await t.test('a file using either spelling of the scope column imports', async () => {
    const asNew = await upload('new.csv',
      'asset_name,category,scope_of_work,man_hours\nNew Spelling,Slot Game,prop,4\n');
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

  await t.test('a Scope of Work the sheet names but Settings does not hold is created', async () => {
    const before = (await api(server.base, '/reference/asset-types', { token })).body.entries;
    assert.ok(!before.some((t2) => /Storyboard/i.test(t2.label)));

    const result = await upload('newscope.csv',
      'Assets Name,Category,Scope of Work,Man Hours\n'
      + 'Opening Titles,Slot Game,Storyboard,4\n'
      + 'Closing Titles,Slot Game,storyboard,4\n'   // same scope, typed differently
      + 'Stone Arch,Slot Game,Stone Wall,4\n');     // first three letters collide with STO
    assert.strictEqual(result.status, 201, JSON.stringify(result.body));

    assert.deepStrictEqual(result.body.createdScopes.map((t2) => t2.label).sort(),
      ['Stone Wall', 'Storyboard']);

    const after = (await api(server.base, '/reference/asset-types', { token })).body.entries;
    assert.strictEqual(after.filter((t2) => /^storyboard$/i.test(t2.label)).length, 1,
      'case differences must not produce two scopes');

    /* code_prefix is UNIQUE and both of these start STO. Deriving the prefix
       blindly is what used to make the second one a 500. */
    const prefixes = after.map((t2) => t2.codePrefix);
    assert.strictEqual(new Set(prefixes).size, prefixes.length, `prefixes collided: ${prefixes}`);

    const key = after.find((t2) => /^storyboard$/i.test(t2.label)).key;
    const assets = (await api(server.base, `/assets/project/${projectId}`, { token })).body.assets;
    for (const name of ['Opening Titles', 'Closing Titles']) {
      assert.strictEqual(assets.find((a) => a.name === name).type, key);
    }
    // And the asset code is built from the newly derived prefix.
    const arch = assets.find((a) => a.name === 'Stone Arch');
    const archPrefix = after.find((t2) => t2.key === arch.type).codePrefix;
    assert.ok(arch.code.startsWith(`${archPrefix}-`), `${arch.code} should start with ${archPrefix}`);
  });

  await t.test('a blank Scope of Work is still an error, not a new scope', async () => {
    const result = await upload('blankscope.csv',
      'Assets Name,Category,Scope of Work,Man Hours\nNo Scope At All,Slot Game,,4\n');
    assert.strictEqual(result.status, 207, JSON.stringify(result.body));
    assert.strictEqual(result.body.created, 0);
    assert.strictEqual(result.body.errors[0].column, 'Scope of Work');
  });

  await t.test('re-uploading matches on the resolved scope, not the raw text', async () => {
    /* The sheet says "FX"; the database holds "fx". Compared as raw strings,
       the second upload would find no match and duplicate every asset. */
    const csv = 'Assets Name,Category,Scope of Work,Man Hours\nCase Test,Slot Game,FX,4\n';
    const first = await upload('case1.csv', csv);
    assert.strictEqual(first.body.created, 1, JSON.stringify(first.body));
    const second = await upload('case2.csv',
      'Assets Name,Category,Scope of Work,Man Hours\nCase Test,Slot Game,fx,4\n');
    assert.strictEqual(second.body.created, 0, 'the same asset must not import twice');
    assert.ok(/already exists/.test(second.body.errors[0].message), second.body.errors[0].message);
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

test('every distinct new category in a sheet is added, not just the first', {
  skip: config('manycat') ? false : SKIP_REASON,
}, async (t) => {
  /* "Add all of them" is the point: a sheet bringing in a studio's whole
     taxonomy at once has to end with the whole taxonomy in Settings, with each
     asset pointing at its own category — not with one category created and the
     rest of the rows sharing it or failing. */
  const cfg2 = config('manycat');
  const PASSWORD = 'Many-Cat-1!';
  let server; let token; let projectId;

  t.before(async () => {
    await resetSchema(cfg2);
    server = await startServer(cfg2, { BOOTSTRAP_TOKEN: 'tok' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const clientId = await systemClientId(server.base, token);
    projectId = (await api(server.base, '/projects', { method: 'POST', token,
      body: { clientId, name: 'Many Categories' } })).body.project.id;
  });
  t.after(() => stopServer(server));

  await t.test('a sheet of many different categories brings all of them in', async () => {
    const N = 40;
    const rows = ['No.,Assets Name,Category,Scope of Work,Man Hours'];
    for (let i = 0; i < N; i++) {
      rows.push(`${i + 1},Asset ${i},Category ${String(i).padStart(2, '0')},prop,4`);
    }
    // Two more rows repeating categories already named above, differently cased,
    // so "all of them" cannot be read as "one per row".
    rows.push(`${N + 1},Repeat A,category 00,prop,4`);
    rows.push(`${N + 2},Repeat B,CATEGORY 01,prop,4`);

    const form = new FormData();
    form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'many.csv');
    const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(120000),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(body).slice(0, 300));
    assert.strictEqual(body.created, N + 2);

    // N created — the two repeats matched existing ones rather than adding more.
    assert.strictEqual(body.createdCategories.length, N,
      'each distinct category added once, repeats matched to what was already there');

    const entries = (await api(server.base, '/reference/categories', { token })).body.entries;
    assert.strictEqual(entries.length, N);

    // Every asset points at its own category, and the repeats share theirs.
    const assets = (await api(server.base, `/assets/project/${projectId}`, { token })).body.assets;
    assert.strictEqual(assets.filter((a) => a.category).length, N + 2);
    assert.strictEqual(new Set(assets.map((a) => a.category)).size, N);
    const byName = Object.fromEntries(assets.map((a) => [a.name, a.category]));
    assert.strictEqual(byName['Repeat A'], byName['Asset 0']);
    assert.strictEqual(byName['Repeat B'], byName['Asset 1']);
  });
});

test('an import appends to the value lists rather than reordering them', {
  skip: config('appendpos') ? false : SKIP_REASON,
}, async (t) => {
  /* The seeded scopes of work carry deliberate positions, and that is the
     order the dropdowns show. A value created by an import takes position 0 so
     it lands after them — otherwise importing eleven new scopes scattered them
     through the curated list. */
  const cfg2 = config('appendpos');
  const PASSWORD = 'Append-Pos-1!';
  let server; let token; let projectId;

  t.before(async () => {
    await resetSchema(cfg2);
    server = await startServer(cfg2, { BOOTSTRAP_TOKEN: 'tok' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const clientId = await systemClientId(server.base, token);
    projectId = (await api(server.base, '/projects', { method: 'POST', token,
      body: { clientId, name: 'Append Target' } })).body.project.id;
  });
  t.after(() => stopServer(server));

  await t.test('seeded scopes keep their order; imported ones follow', async () => {
    const before = (await api(server.base, '/reference/asset-types', { token }))
      .body.entries.map((e) => e.key);

    const form = new FormData();
    form.append('file', new Blob([
      'Assets Name,Category,Scope of Work,Man Hours\n'
      + 'A,Slot Game,Aardvark Pass,4\n'   // sorts first alphabetically
      + 'B,Slot Game,Rigging,4\n',
    ], { type: 'text/csv' }), 'append.csv');
    const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(await res.json()).slice(0, 200));

    const after = (await api(server.base, '/reference/asset-types', { token }))
      .body.entries.map((e) => e.key);
    // The originals, in their original order, then the new ones.
    assert.deepStrictEqual(after.slice(0, before.length), before,
      'an import must not reorder the list somebody curated');
    assert.strictEqual(after.length, before.length + 2);
  });
});

/* --- the nine-column format against a live server --------------------------

   Everything below is about the four columns the format gained. The parsers
   are covered above; these are the questions only a database can answer —
   whether an address belongs to somebody, what an assignment does to an asset,
   and whether the notes gate holds. */
test('the imported assignee, deadline, link and notes', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Import-Test-Pass-1!';
  let server;
  let token;
  let projectId;
  const people = {};

  const as = (who, path, opts = {}) => api(server.base, path, { ...opts, token: who });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tok' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const clientId = await systemClientId(server.base, token);
    projectId = (await api(server.base, '/projects', { method: 'POST', token,
      body: { clientId, name: 'Nine Columns' } })).body.project.id;

    for (const [name, email, role] of [
      ['Ana Diaz', 'ana@zvky.test', 'game_artist'],
      ['Lee Park', 'lee@zvky.test', 'team_lead'],
      // A designation the studio does not give work to, so the sheet can name
      // somebody real who still cannot be assigned.
      ['Fin Ops', 'fin@zvky.test', 'finance_manager'],
    ]) {
      const made = await as(token, '/users', { method: 'POST',
        body: { name, email, role, password: PASSWORD, projectId } });
      if (made.status < 400) people[email.split('@')[0]] = made.body.user.id;
    }
  });
  t.after(() => stopServer(server));

  const upload = async (content, who = token) => {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/csv' }), 'nine.csv');
    const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
      method: 'POST', headers: { Authorization: `Bearer ${who}` }, body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const assetNamed = async (name) => (await as(token, `/assets/project/${projectId}`))
    .body.assets.find((a) => a.name === name);

  await t.test('a row with only the two mandatory columns imports', async () => {
    const res = await upload('Asset Name,Scope of Work\nBare Minimum,prop\n');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.created, 1);
    assert.deepStrictEqual(res.body.warnings, [], 'and nothing to report about it');

    const made = await assetNamed('Bare Minimum');
    assert.ok(made, 'the asset exists');
    assert.strictEqual(made.status, 'not_started', 'with nobody on it');
    assert.strictEqual(made.assignee_id, null);
    assert.strictEqual(made.due_date, null);
    assert.strictEqual(made.man_hours, null);
    assert.strictEqual(made.category, null);
    assert.strictEqual(made.reference_link, null);
  });

  await t.test('a registered assignee is assigned on arrival, with a round open', async () => {
    const res = await upload(
      'Asset Name,Scope of Work,Assignee Email,Deadline,Project Link,Lead/Supervisor Notes\n'
      + 'Fully Loaded,character,ANA@zvky.test,31-03-2026,https://drive.example.com/brief,Keep it flat.\n');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.warnings, []);
    assert.strictEqual(res.body.assigned, 1);

    const made = await assetNamed('Fully Loaded');
    /* The same destination adding one by hand with an assignee reaches. An
       imported asset used to show its assignee's avatar while sitting in Not
       Assigned; the address is matched case-insensitively because a sheet is
       typed by a person. */
    assert.strictEqual(made.assignee_id, people.ana, 'matched despite the capitals');
    assert.strictEqual(made.status, 'assigned');
    assert.strictEqual(made.routed_to_id, people.ana, 'and on their desk');
    assert.strictEqual(String(made.due_date).slice(0, 10), '2026-03-31');
    assert.strictEqual(made.reference_link, 'https://drive.example.com/brief');
    assert.strictEqual(made.lead_notes, 'Keep it flat.');

    // The history says who put them on it, rather than the asset simply being theirs.
    const events = await sql(cfg,
      `SELECT action, to_status, note FROM asset_events WHERE asset_id = '${made.id}'`);
    assert.ok(events.some((e) => e.action === 'assign' && e.to_status === 'assigned'),
      `no assign event: ${JSON.stringify(events)}`);

    /* And the first Round. The Assets List is built from asset_assignments, so
       an assignment with no episode is an asset that is somebody's and shows
       nowhere — which is what this path did before the sheet had the column. */
    const rounds = await sql(cfg,
      `SELECT user_id, ended_at, status_at_assignment FROM asset_assignments WHERE asset_id = '${made.id}'`);
    assert.strictEqual(rounds.length, 1, `expected one open round, got ${JSON.stringify(rounds)}`);
    assert.strictEqual(rounds[0].user_id, people.ana);
    assert.strictEqual(rounds[0].ended_at, null, 'and it is still open');
  });

  await t.test('the assignee is told, exactly as a manual assignment tells them', async () => {
    const inbox = (await as(
      (await api(server.base, '/auth/login', { method: 'POST',
        body: { email: 'ana@zvky.test', password: PASSWORD } })).body.token,
      '/notifications')).body.notifications || [];
    assert.ok(inbox.some((n) => n.kind === 'assigned'),
      `an imported assignment should reach the bell: ${JSON.stringify(inbox.slice(0, 3))}`);
  });

  await t.test('an address nobody holds costs the assignee, not the asset', async () => {
    const res = await upload(
      'Asset Name,Scope of Work,Assignee Email\nOrphan,prop,ghost@nowhere.example\n');
    assert.strictEqual(res.status, 201, 'the row is not a failure');
    assert.strictEqual(res.body.created, 1);
    assert.strictEqual(res.body.skipped, 0);

    const warned = res.body.warnings.find((w) => w.column === 'Assignee Email');
    assert.ok(warned, JSON.stringify(res.body.warnings));
    assert.ok(/does not match anyone here/.test(warned.message));
    assert.strictEqual(warned.row, 2, 'and it names the row to fix');

    const made = await assetNamed('Orphan');
    assert.strictEqual(made.assignee_id, null);
    assert.strictEqual(made.status, 'not_started', 'Not Assigned, which is what it is');
  });

  await t.test('a real person whose designation is not given work is refused by name', async () => {
    if (!people.fin) return; // that designation is not in this studio's list
    const res = await upload(
      'Asset Name,Scope of Work,Assignee Email\nWrong Desk,prop,fin@zvky.test\n');
    assert.strictEqual(res.status, 201);
    const warned = res.body.warnings.find((w) => w.column === 'Assignee Email');
    assert.ok(warned && /not assigned work/.test(warned.message),
      `expected the same answer the assignee picker gives: ${JSON.stringify(res.body.warnings)}`);
    assert.strictEqual((await assetNamed('Wrong Desk')).assignee_id, null);
  });

  await t.test('an unreadable Deadline is flagged and the rest of the file is untouched', async () => {
    const res = await upload([
      'Asset Name,Scope of Work,Deadline',
      'Good Date,prop,15-04-2026',
      'Bad Date,prop,next friday',
      'Impossible Date,prop,31-02-2026',
      'Another Good One,prop,2026-05-01',
      '',
    ].join('\n'));
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.created, 4, 'every row still imports');
    assert.strictEqual(res.body.skipped, 0);

    assert.deepStrictEqual(res.body.warnings.map((w) => w.row), [3, 4],
      `only the two bad dates: ${JSON.stringify(res.body.warnings)}`);
    assert.ok(res.body.warnings.every((w) => w.column === 'Deadline'));

    assert.strictEqual(String((await assetNamed('Good Date')).due_date).slice(0, 10), '2026-04-15');
    assert.strictEqual(String((await assetNamed('Another Good One')).due_date).slice(0, 10), '2026-05-01');
    assert.strictEqual((await assetNamed('Bad Date')).due_date, null);
    assert.strictEqual((await assetNamed('Impossible Date')).due_date, null);
  });

  await t.test('Lead/Supervisor Notes need the permission, on the way in and on the way out',
    async () => {
      const perms = async (role) => (await as(token, `/permissions/roles/${role}`))
        .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
      const grant = async (role, keys) => as(token, `/permissions/roles/${role}`,
        { method: 'PUT', body: { permissions: keys } });

      /* A Production Coordinator: somebody who really does bulk uploads and is
         not a lead. An artist would have made the point too, but artists cannot
         create assets at all, so the upload would have been refused a step
         earlier and proved nothing about this gate. */
      const coordPerms = await perms('coordinator');
      await grant('coordinator', [...new Set([...coordPerms, 'asset.bulk_upload'])]);
      const made = await as(token, '/users', { method: 'POST',
        body: { name: 'Cory Ng', email: 'cory@zvky.test', role: 'coordinator',
          password: PASSWORD, projectId } });
      assert.ok(made.status < 400, JSON.stringify(made.body));
      const cory = (await api(server.base, '/auth/login', { method: 'POST',
        body: { email: 'cory@zvky.test', password: PASSWORD } })).body.token;

      const res = await upload(
        'Asset Name,Scope of Work,Lead/Supervisor Notes\nArtist Upload,prop,Should not land\n', cory);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const warned = res.body.warnings.find((w) => w.column === 'Lead/Supervisor Notes');
      assert.ok(warned && /does not hold Lead \/ Supervisor Notes/.test(warned.message),
        `the column must be refused out loud: ${JSON.stringify(res.body.warnings)}`);

      // Not written — checked in the database, not through the API that hides it.
      const stored = await sql(cfg,
        "SELECT lead_notes FROM assets WHERE `name` = 'Artist Upload'");
      assert.strictEqual(stored[0].lead_notes, null, 'the gate holds on the way in');

      /* And on the way out: the notes on Fully Loaded are real, and an artist
         reading that asset must not receive them. Absent, not blank — the panel
         tells those apart. */
      const seen = (await as(cory, `/assets/project/${projectId}`)).body.assets
        .find((a) => a.name === 'Fully Loaded');
      assert.ok(seen, 'they can see the asset itself');
      assert.ok(!('lead_notes' in seen), `the notes leaked: ${JSON.stringify(seen.lead_notes)}`);

      // Writing them through the panel is refused too, rather than ignored.
      const patched = await as(cory, `/assets/${seen.id}`,
        { method: 'PATCH', body: { leadNotes: 'sneaking in' } });
      assert.strictEqual(patched.status, 403, JSON.stringify(patched.body));
      assert.strictEqual((await sql(cfg,
        "SELECT lead_notes FROM assets WHERE `name` = 'Fully Loaded'"))[0].lead_notes,
      'Keep it flat.', 'and nothing changed');

      // A lead holds it by default and sees the notes.
      const lee = (await api(server.base, '/auth/login', { method: 'POST',
        body: { email: 'lee@zvky.test', password: PASSWORD } })).body.token;
      const leadSees = (await as(lee, `/assets/project/${projectId}`)).body.assets
        .find((a) => a.name === 'Fully Loaded');
      assert.strictEqual(leadSees.lead_notes, 'Keep it flat.');

      await grant('coordinator', coordPerms);
    });

  await t.test('the permission is in the catalogue and Super Admin has it untouched', async () => {
    const listed = (await as(token, '/permissions/roles/game_artist')).body.role.permissions
      .find((p) => p.key === 'asset.lead_notes');
    assert.ok(listed, 'Settings → Permissions must offer it');
    assert.strictEqual(listed.enabled, false, 'and it starts off for an artist');
    // The label the screen prints comes from the catalogue, so check it there.
    assert.strictEqual(catalog.KEYS.includes('asset.lead_notes'), true);
    assert.strictEqual(
      catalog.GROUPS.flatMap((g) => g.permissions).find((p) => p.key === 'asset.lead_notes').label,
      'Lead / Supervisor Notes');

    const superAdmin = (await as(token, '/permissions/roles/super_admin')).body.role.permissions
      .find((p) => p.key === 'asset.lead_notes');
    assert.ok(superAdmin && superAdmin.enabled, 'Super Admin holds every new permission');
  });
});

test('the sample file and the New Asset form cannot drift apart', () => {
  /* The sample's columns are maintained in src/asset-import.js and the form's
     fields in public/index.html, and nothing but this test connects them. It
     failing means somebody changed one — added a field, renamed a label — and
     the two now describe different things, which is exactly how the sample got
     out of date before.

     Fixing it is a decision, not a formality: either the importer gains the
     column, or the field goes in NOT_IMPORTED below with the reason. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const form = page.slice(page.indexOf('<h2>New Asset</h2>'));
  const modal = form.slice(0, form.indexOf('modal-actions'));
  const formFields = [...modal.matchAll(/<label>([^<]+)<\/label>/g)].map((m) => m[1].trim());
  assert.ok(formFields.length >= 4, `only found ${formFields.length} fields in the New Asset form`);

  /* Fields the form collects that the sheet deliberately does not. Every one
     needs a reason, so removing a column is a decision somebody made rather
     than something that quietly happened. */
  const NOT_IMPORTED = {
    Priority: 'imported assets take the default priority and are changed in the panel',
    Description: 'the brief is written per asset; the sheet carries Lead/Supervisor Notes instead',
  };
  /* The same field under two names. The form picks a person from a list, the
     sheet can only carry text, so the column says which text — but it is one
     field and a rename on either side should show up here, not as two
     unrelated things that happen to work. */
  const RENAMED = { Assignee: 'Assignee Email' };
  // Columns the sheet has that the New Asset form has no field for.
  const NOT_ON_FORM = {
    'No.': 'a line number for whoever fills the sheet in; never stored',
    'Project Link': 'the asset panel’s Requirement / Reference Link; not on the create form',
    'Lead/Supervisor Notes': 'edited in the asset panel behind asset.lead_notes; not on the create form',
  };

  const sampleColumns = assetImport.buildTemplateCsv().split('\n')[0].split(',');
  assert.deepStrictEqual(sampleColumns, assetImport.COLUMN_NAMES,
    'the sample header must be the importer’s own column list, not a second copy');

  /* Compared as sets, with the ORDER checked separately against the studio's
     own list of nine — because the sheet's order is what the studio asked for
     and is not derivable from the order of the fields on a modal. */
  const expected = new Set([
    ...Object.keys(NOT_ON_FORM),
    ...formFields.filter((f) => !(f in NOT_IMPORTED)).map((f) => RENAMED[f] || f),
  ]);
  assert.deepStrictEqual([...expected].sort(), [...sampleColumns].sort(),
    'the sample columns no longer match the New Asset form — add the column, or list the field '
    + 'in NOT_IMPORTED / NOT_ON_FORM with a reason');

  // And every excuse still refers to a field that exists, so the lists cannot
  // rot into exemptions for fields nobody has any more.
  for (const field of [...Object.keys(NOT_IMPORTED), ...Object.keys(RENAMED)]) {
    assert.ok(formFields.includes(field), `"${field}" is exempted here but the form no longer has it`);
  }
  for (const column of Object.keys(NOT_ON_FORM)) {
    assert.ok(sampleColumns.includes(column), `NOT_ON_FORM names "${column}", which the sheet no longer has`);
  }
});

test('the sample shows values that are really in the configured lists', () => {
  /* A sample quoting scope-of-work values hardcoded in the importer is a
     sample that stops matching the dropdown the moment somebody edits the list
     in Settings. These are read from the live list instead. */
  const { parse } = require('csv-parse/sync');
  const rows = parse(assetImport.buildTemplateCsv(),
    { bom: true, columns: true, skip_empty_lines: true, trim: true });
  const live = assetImport.assetTypes();
  for (const row of rows) {
    // The two mandatory columns, filled in every row — including the bare one.
    assert.ok(row['Asset Name'], 'every sample row needs an asset name');
    assert.ok(live.includes(row['Scope of Work']),
      `sample offers "${row['Scope of Work']}", which is not in ${live.join(', ')}`);
    /* The optional ones: blank, or good. Blank is not a gap in the sample — it
       is the sample demonstrating that the column is optional, which is the
       thing about this format most easily got wrong. */
    if (row['Man Hours']) assert.ok(Number(row['Man Hours']) > 0, 'a shown estimate should be sensible');
    if (row.Deadline) assert.ok(/^\d{2}-\d{2}-\d{4}$/.test(row.Deadline),
      `the sample must show the documented DD-MM-YYYY, not "${row.Deadline}"`);
    if (row['Assignee Email']) assert.ok(/@/.test(row['Assignee Email']));
  }
  assert.ok(rows.length >= 2, 'the sample needs example rows, not just a header');
});
