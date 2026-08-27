const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, systemClientId } = require('./helpers');
const userImport = require('../src/user-import');
const assetImport = require('../src/asset-import');

const cfg = config('userimport');

// --- pure checks -------------------------------------------------------------

test('the generated user sample satisfies the importer that validates it', () => {
  const csv = userImport.buildTemplateCsv();
  const [headerLine, ...dataLines] = csv.trim().split('\n');
  assert.strictEqual(userImport.validateHeaders(headerLine.split(',')).ok, true);
  assert.ok(dataLines.length >= 2, 'the sample should carry a few example rows');

  const { parse } = require('csv-parse/sync');
  const rows = parse(csv, { bom: true, columns: true, skip_empty_lines: true, trim: true });
  rows.forEach((row, i) => {
    const result = userImport.validateRow(row, i + 2);
    assert.strictEqual(result.ok, true, `sample row ${i + 2} fails: ${JSON.stringify(result.errors)}`);
  });
});

test('the two importers describe genuinely different files', () => {
  const userColumns = userImport.COLUMN_NAMES;
  const assetColumns = assetImport.COLUMN_NAMES;
  assert.notDeepStrictEqual(userColumns, assetColumns);
  /* No header is shared any more: the asset sheet asks for "Assets Name", the
     way the screen writes it, while the user sheet still asks for `name`. The
     asset importer does still ACCEPT `name` as an older spelling, which is why
     the check below is on the headers each sample hands out. */
  const shared = userColumns.filter((c) => assetColumns.includes(c));
  assert.deepStrictEqual(shared, []);
  assert.notStrictEqual(userImport.buildTemplateCsv(), assetImport.buildTemplateCsv());
});

test('each importer refuses the other one\'s template', () => {
  const assetHeaders = assetImport.buildTemplateCsv().split('\n')[0].split(',');
  const userHeaders = userImport.buildTemplateCsv().split('\n')[0].split(',');

  const assetIntoUsers = userImport.validateHeaders(assetHeaders);
  assert.strictEqual(assetIntoUsers.ok, false);
  // `name` too now: the asset sheet's column is "Assets Name", which the user
  // importer does not recognise as its own `name`.
  assert.deepStrictEqual(assetIntoUsers.missing, ['name', 'email', 'role']);

  const userIntoAssets = assetImport.validateHeaders(userHeaders);
  assert.strictEqual(userIntoAssets.ok, false);
  assert.deepStrictEqual(userIntoAssets.missing, ['Category', 'Scope of Work', 'Man Hours']);
});

test('a user row is validated on its own terms', () => {
  const bad = userImport.validateRow({ name: '', email: 'nope', role: 'wizard' }, 4);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.errors.map((e) => e.column).sort(), ['email', 'name', 'role']);
  for (const error of bad.errors) {
    assert.strictEqual(error.row, 4);
    assert.ok(error.message);
  }
});

test('a role may be given by its label as well as its key', () => {
  const result = userImport.validateRow({ name: 'X', email: 'x@zvky.test', role: 'Senior Game Artist' }, 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.role, 'senior_game_artist');
});

test('emails are lowercased so duplicates cannot slip through on case', () => {
  const result = userImport.validateRow({ name: 'X', email: '  Mixed.Case@ZVKY.com ', role: 'game_artist' }, 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.email, 'mixed.case@zvky.com');
});

test('a password in the file must meet the same policy as one typed in the form', () => {
  const weak = userImport.validateRow({ name: 'X', email: 'x@zvky.test', role: 'game_artist', password: 'short' }, 2);
  assert.strictEqual(weak.ok, false);
  assert.ok(weak.errors.some((e) => e.column === 'password'));

  const strong = userImport.validateRow({ name: 'X', email: 'x@zvky.test', role: 'game_artist', password: 'Strong-Pass-1!' }, 2);
  assert.strictEqual(strong.ok, true);
});

test('optional columns may be absent entirely', () => {
  const result = userImport.validateRow({ name: 'Only Required', email: 'only@zvky.test', role: 'game_artist' }, 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.reports_to_email, null);
  assert.strictEqual(result.values.project, null);
  assert.strictEqual(result.values.password, null);
});

// --- against a live server ---------------------------------------------------

test('bulk user upload', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'User-Import-1!';
  let server;
  let token;
  let projectName;

  const call = (path, options) => api(server.base, path, options);

  const upload = async (path, tok, filename, content, mimeType = 'text/csv') => {
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimeType }), filename);
    const res = await fetch(server.base + path, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: form,
      signal: AbortSignal.timeout(60000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const template = async (path, tok) =>
    (await fetch(server.base + path, { headers: { Authorization: `Bearer ${tok}` } })).text();

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Import Admin', email: 'super@zvky.test', password: PASSWORD },
    });
    token = (await call('/auth/login', { method: 'POST', body: { email: 'super@zvky.test', password: PASSWORD } })).body.token;
    const clientId = await systemClientId(server.base, token);
    const project = await call('/projects', { method: 'POST', token, body: { clientId, name: 'Staffing Target' } });
    projectName = project.body.project.name;
  });

  t.after(() => stopServer(server));

  await t.test('the user sample uploads cleanly to the user endpoint', async () => {
    const csv = await template('/users/import-template.csv', token);
    const result = await upload('/users/bulk', token, 'users.csv', csv);
    assert.strictEqual(result.status, 201, JSON.stringify(result.body));
    assert.strictEqual(result.body.skipped, 0);
    assert.strictEqual(result.body.created, 3);
    assert.ok(result.body.temporaryPassword, 'rows without a password should report the temporary one');
  });

  await t.test('an imported account can sign in with the role from the file', async () => {
    const login = await call('/auth/login', {
      method: 'POST', body: { email: 'priya.raman@zvky.com', password: 'zvky2026' },
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    assert.strictEqual(login.body.user.role, 'senior_game_artist');
  });

  await t.test('the asset sample is refused by the user endpoint, by name', async () => {
    const csv = await template('/assets/import-template.csv', token);
    const result = await upload('/users/bulk', token, 'assets.csv', csv);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.wrongTemplate, 'assets');
    assert.match(result.body.error, /Bulk Upload Assets/);
    assert.strictEqual(result.body.created, undefined, 'nothing should have been created');
  });

  await t.test('the user sample is refused by the asset endpoint, by name', async () => {
    const project = await call('/projects', { token });
    const projectId = project.body.projects[0].id;
    const csv = await template('/users/import-template.csv', token);
    const result = await upload(`/assets/project/${projectId}/bulk`, token, 'users.csv', csv);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.wrongTemplate, 'users');
    assert.match(result.body.error, /Bulk Upload Users/);
  });

  await t.test('bad rows are skipped and reported; good rows still import', async () => {
    const csv = [
      'name,email,role,reports_to_email,project,password',
      'Keeper,keeper@zvky.test,game_artist,,,',
      ',blank@zvky.test,game_artist,,,',
      'Bad Email,not-an-email,game_artist,,,',
      'Bad Role,badrole@zvky.test,wizard,,,',
      'Weak Password,weak@zvky.test,game_artist,,,short',
      'Duplicate,keeper@zvky.test,game_artist,,,',
      'Already Exists,super@zvky.test,game_artist,,,',
      'Ghost Lead,ghost@zvky.test,game_artist,nobody@nowhere.test,,',
      'Bad Project,badproject@zvky.test,producer,,No Such Project,',
    ].join('\n');
    const result = await upload('/users/bulk', token, 'messy.csv', csv);
    assert.strictEqual(result.status, 207, JSON.stringify(result.body).slice(0, 200));
    assert.strictEqual(result.body.created, 1, 'only the good row should land');
    assert.strictEqual(result.body.skipped, 8);
    assert.deepStrictEqual(result.body.errors.map((e) => e.row), [3, 4, 5, 6, 7, 8, 9, 10]);
    for (const error of result.body.errors) {
      assert.strictEqual(typeof error.row, 'number');
      assert.ok(error.message);
    }
  });

  await t.test('a reporting line must point at someone who runs a team', async () => {
    const setup = await upload('/users/bulk', token, 'leads.csv', [
      'name,email,role,reports_to_email,project',
      `Lead Person,lead.person@zvky.test,team_lead,,${projectName}`,
    ].join('\n'));
    assert.strictEqual(setup.body.created, 1, JSON.stringify(setup.body));

    const result = await upload('/users/bulk', token, 'reports.csv', [
      'name,email,role,reports_to_email',
      'Good Report,good.report@zvky.test,game_artist,lead.person@zvky.test',
      'Reports To Artist,bad.report@zvky.test,game_artist,keeper@zvky.test',
      'Lead With Lead,lead.with.lead@zvky.test,team_lead,lead.person@zvky.test',
    ].join('\n'));
    assert.strictEqual(result.body.created, 1);
    assert.ok(result.body.errors.some((e) => e.row === 3 && /does not run a team/.test(e.message)));
    assert.ok(result.body.errors.some((e) => e.row === 4 && /no reporting line/.test(e.message)));
  });

  await t.test('a project named in the file actually attaches the account', async () => {
    const login = await call('/auth/login', {
      method: 'POST', body: { email: 'lead.person@zvky.test', password: 'zvky2026' },
    });
    const projects = await call('/projects', { token: login.body.token });
    assert.ok(projects.body.projects.some((p) => p.name === projectName),
      `expected the lead to see ${projectName}, saw ${JSON.stringify(projects.body.projects.map((p) => p.name))}`);
  });

  await t.test('file-level failures are refused with a reason', async () => {
    for (const [name, content, pattern] of [
      ['empty.csv', '', /empty/i],
      ['headers.csv', 'name,email,role\n', /no data rows/i],
      ['wrong.csv', 'full_name,contact\nX,Y\n', /missing required column/i],
      ['broken.csv', 'name,email,role\n"unterminated,a@b.c,game_artist\n', /could not be read/i],
    ]) {
      const result = await upload('/users/bulk', token, name, content);
      assert.strictEqual(result.status, 400, `${name}: ${result.status}`);
      assert.match(result.body.error, pattern);
    }
    const wrongExt = await upload('/users/bulk', token, 'notes.txt', 'hello', 'text/plain');
    assert.strictEqual(wrongExt.status, 400, 'a bad upload must not be reported as a 500');
    assert.match(wrongExt.body.error, /Unsupported file type/);
  });

  await t.test('an admin cannot create an account more powerful than their own', async () => {
    const made = await call('/users', {
      method: 'POST', token,
      body: { name: 'Plain Admin', email: 'plain.admin@zvky.test', role: 'admin', password: 'Admin-Pass-1!' },
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const adminToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'plain.admin@zvky.test', password: 'Admin-Pass-1!' },
    })).body.token;

    const allowed = await upload('/users/bulk', adminToken, 'users.csv',
      'name,email,role\nOrdinary Hire,ordinary@zvky.test,game_artist\n');
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));

    const escalation = await upload('/users/bulk', adminToken, 'users.csv',
      'name,email,role\nSneaky,sneaky@zvky.test,super_admin\n');
    assert.strictEqual(escalation.body.created, 0);
    assert.ok(escalation.body.errors.some((e) => /cannot create accounts/.test(e.message)),
      JSON.stringify(escalation.body.errors));
  });

  await t.test('someone who cannot manage users cannot use the endpoint at all', async () => {
    const made = await call('/users', {
      method: 'POST', token,
      body: { name: 'Plain Artist', email: 'plain.artist@zvky.test', role: 'game_artist', password: 'Artist-Pass-1!' },
    });
    assert.strictEqual(made.status, 201);
    const artistToken = (await call('/auth/login', {
      method: 'POST', body: { email: 'plain.artist@zvky.test', password: 'Artist-Pass-1!' },
    })).body.token;

    const upload403 = await upload('/users/bulk', artistToken, 'users.csv',
      'name,email,role\nNope,nope@zvky.test,game_artist\n');
    assert.strictEqual(upload403.status, 403);

    const templateRes = await fetch(`${server.base}/users/import-template.csv`, {
      headers: { Authorization: `Bearer ${artistToken}` },
    });
    assert.strictEqual(templateRes.status, 403, 'the template is a management view');
  });

  await t.test('a large user file imports without blocking the server', async () => {
    const rows = ['name,email,role'];
    for (let i = 0; i < 400; i++) rows.push(`Load User ${i},load.user.${i}@zvky.test,game_artist`);

    const checks = [];
    const poll = setInterval(() => {
      checks.push(fetch(`${server.base}/health`, { signal: AbortSignal.timeout(10000) }).then((r) => r.ok).catch(() => false));
    }, 50);
    let result;
    try {
      result = await upload('/users/bulk', token, 'load.csv', rows.join('\n'));
    } finally {
      clearInterval(poll);
    }
    const outcomes = await Promise.all(checks);

    assert.strictEqual(result.status, 201, JSON.stringify(result.body).slice(0, 200));
    assert.strictEqual(result.body.created, 400);
    assert.ok(outcomes.length === 0 || outcomes.every(Boolean),
      `server missed ${outcomes.filter((o) => !o).length} of ${outcomes.length} health checks during the import`);
  });
});
