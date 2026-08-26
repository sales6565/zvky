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
  const check = assetImport.validateHeaders(['title', 'category']);
  assert.strictEqual(check.ok, false);
  assert.deepStrictEqual(check.missing, ['name', 'type']);
});

test('headers are matched despite case, spacing and a byte-order mark', () => {
  const check = assetImport.validateHeaders(['﻿Name', '  TYPE  ', 'Man Hours']);
  assert.strictEqual(check.ok, true);
  assert.ok(check.present.includes('man_hours'));
});

test('a non-numeric man_hours is caught before it reaches SQL', () => {
  // Number('notanumber') is NaN, and NaN reaching mysql2 is what used to abort
  // the whole import with ER_BAD_FIELD_ERROR.
  const result = assetImport.validateRow({ name: 'X', type: 'prop', man_hours: 'notanumber' }, 5);
  assert.strictEqual(result.ok, false);
  const error = result.errors.find((e) => e.column === 'man_hours');
  assert.ok(error && /must be a number/.test(error.message));
});

test('a date that matches the pattern but is not a real day is rejected', () => {
  const result = assetImport.validateRow({ name: 'X', type: 'prop', deadline: '2026-02-31' }, 5);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.column === 'deadline' && /not a real date/.test(e.message)));
});

test('every row error names the row, the column and the reason', () => {
  const result = assetImport.validateRow({ name: '', type: 'nope', priority: 'urgent' }, 7);
  assert.strictEqual(result.ok, false);
  for (const error of result.errors) {
    assert.strictEqual(error.row, 7);
    assert.ok(typeof error.column === 'string' && error.column.length > 0);
    assert.ok(typeof error.message === 'string' && error.message.length > 0);
  }
  assert.deepStrictEqual(result.errors.map((e) => e.column).sort(), ['name', 'priority', 'type']);
});

test('optional columns may be absent entirely', () => {
  const result = assetImport.validateRow({ name: 'Only Required', type: 'prop' }, 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.priority, 'med');
  assert.strictEqual(result.values.man_hours, null);
  assert.strictEqual(result.values.deadline, null);
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
    const result = await upload('wrong.csv', 'title,category\nFoo,bar\n');
    assert.strictEqual(result.status, 400);
    assert.deepStrictEqual(result.body.missingColumns, ['name', 'type']);
    assert.ok(Array.isArray(result.body.expectedColumns));
    stillResponsive(result);
  });

  await t.test('bad rows are skipped and reported; good rows still import', async () => {
    const csv = [
      'name,type,priority,assignee_email,man_hours,deadline,description',
      'Keeper One,prop,high,,5,2026-09-01,fine',
      ',prop,high,,5,2026-09-01,no name',
      'Bad Type,notatype,high,,5,2026-09-01,bad type',
      'Bad Hours,prop,high,,notanumber,2026-09-01,bad number',
      'Bad Date,prop,high,,5,31-02-2026,bad date',
      'Bad Priority,prop,urgent,,5,2026-09-01,bad priority',
      'Bad Email,prop,high,not-an-email,5,2026-09-01,bad email',
      'Keeper Two,fx,low,,3,2026-09-02,fine',
      '',
    ].join('\n');

    const result = await upload('mixed.csv', csv);
    assert.strictEqual(result.status, 207, JSON.stringify(result.body));
    assert.strictEqual(result.body.created, 2, 'the two good rows should import');
    assert.strictEqual(result.body.skipped, 6);
    for (const error of result.body.errors) {
      assert.strictEqual(typeof error.row, 'number');
      assert.ok(error.message);
    }
    assert.deepStrictEqual(result.body.errors.map((e) => e.row), [3, 4, 5, 6, 7, 8]);
    stillResponsive(result);
  });

  await t.test('a row repeated inside the file is imported once', async () => {
    const result = await upload('dupes.csv', 'name,type\nTwice Over,prop\nTwice Over,prop\n');
    assert.strictEqual(result.status, 207);
    assert.strictEqual(result.body.created, 1);
    assert.ok(/duplicates row 2/.test(result.body.errors[0].message), result.body.errors[0].message);
  });

  await t.test('re-uploading the same file does not duplicate what is there', async () => {
    const csv = 'name,type\nOnly Once,prop\n';
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
    const result = await upload('headers.csv', 'name,type\n');
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /no data rows/i);
  });

  await t.test('the wrong extension is a client error, not a server error', async () => {
    const result = await upload('notes.txt', 'hello', 'text/plain');
    assert.strictEqual(result.status, 400, 'a bad upload must not be reported as a 500');
    assert.match(result.body.error, /Unsupported file type/);
  });

  await t.test('a structurally broken file is refused with the reason', async () => {
    const result = await upload('broken.csv', 'name,type\n"unterminated,prop\nok,prop\n');
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /could not be read/i);
    stillResponsive(result);
  });

  await t.test('a file past the row limit is refused before any of it is imported', async () => {
    const rows = ['name,type'];
    for (let i = 0; i < assetImport.MAX_ROWS + 1; i++) rows.push(`Over Limit ${i},prop`);
    const result = await upload('huge.csv', rows.join('\n'));
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.maxRows, assetImport.MAX_ROWS);
    assert.match(result.body.error, /limit is/);
    stillResponsive(result);
  });

  await t.test('a large valid file imports without blocking the server', async () => {
    const rows = ['name,type,man_hours'];
    for (let i = 0; i < 2000; i++) rows.push(`Load Test ${i},prop,4`);
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

  await t.test('an imported row that names an assignee lands in Assigned, not Not Assigned', async () => {
    // The bug this covers: the importer wrote 'not_started' for every row, so a
    // row that named an assignee produced an asset with that person's avatar on
    // it sitting in the Not Assigned column, and no history of the assignment.
    const artist = await api(server.base, '/users', {
      method: 'POST', token,
      body: { name: 'Import Artist', email: 'importartist@zvky.test', role: 'game_artist',
              password: PASSWORD, projectId },
    });
    assert.strictEqual(artist.status, 201, JSON.stringify(artist.body));

    const result = await upload('assigned.csv',
      'name,type,assignee_email\nWith An Owner,prop,importartist@zvky.test\nWith No Owner,prop,\n');
    assert.strictEqual(result.status, 201, JSON.stringify(result.body).slice(0, 300));

    const { body } = await api(server.base, `/assets/project/${projectId}`, { token });
    const owned = body.assets.find((a) => a.name === 'With An Owner');
    const bare = body.assets.find((a) => a.name === 'With No Owner');
    assert.strictEqual(owned.assignee_id, artist.body.user.id);
    assert.strictEqual(owned.status, 'assigned', 'an imported assignment is an assignment');
    assert.strictEqual(bare.status, 'not_started', 'a row with no assignee is untouched');

    // And it is in the history, so the assignment is not anonymous.
    const history = await api(server.base, `/assets/${owned.id}/history`, { token });
    assert.strictEqual(history.status, 200, JSON.stringify(history.body));
    const assign = history.body.events.find((e) => e.action === 'assign');
    assert.ok(assign, 'the import wrote an assign event');
    assert.strictEqual(assign.toStatus, 'assigned');
  });

  await t.test('the server is still healthy after every one of those', async () => {
    const health = await api(server.base, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
  });
});
