/* scripts/user-sees.js — THE DIAGNOSTIC, PROVED READ-ONLY AND PROVED RIGHT.
 *
 * ===========================================================================
 * WHY A SCRIPT, AND WHY IT IS TESTED LIKE THIS.
 *
 * The complaint behind this task was "the Acting Team Lead cannot see the project's
 * assets", and answering it the first time meant reading three functions in two files and
 * knowing which of them the board actually calls. A diagnostic that prints the verdict AND
 * the reason turns that into one command — but only if the verdict is the application's and
 * not a second copy of the rules, written in a file nobody runs.
 *
 * So the two things asserted here are the two things that could make it worthless:
 *
 *   IT MUST NOT WRITE. It is meant to be run against production while somebody is on the
 *   phone. tests/acting-lead-visibility.test.js already scans the source for writing verbs;
 *   this suite runs it for real against a database it then checks, byte for byte, has not
 *   changed.
 *
 *   IT MUST AGREE WITH THE SERVER. Its lines are compared against what the same people get
 *   from the same routes in the same database. If the script and the board ever disagree,
 *   the board is right and the script is the bug — so a disagreement fails here.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('userseescript');
const PASSWORD = 'UserSees-Test-1!';
const ROOT = path.join(__dirname, '..');

test('scripts/user-sees.js', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: token[who] });

  /* The script in a real process, with the connection settings in the environment variables
     src/db reads — the same shape tests/chat.test.js uses for the sweep. Its own process,
     because the script opens src/db, and this one must not. */
  const runWith = (pre, args) => {
    try {
      return execFileSync(process.execPath, [...pre, path.join('scripts', 'user-sees.js'), ...args], {
        cwd: ROOT,
        env: { ...process.env,
          DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
          DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
      }).toString();
    } catch (err) {
      /* A non-zero exit is an answer too — "nobody matched", "ambiguous" — so the output is
         returned either way and the exit code is asserted where it matters. */
      const e = new Error(`exit ${err.status}: ${(err.stderr || '').toString()}`);
      e.status = err.status;
      e.stdout = (err.stdout || '').toString();
      e.stderr = (err.stderr || '').toString();
      throw e;
    }
  };
  const run = (...args) => runWith([], args);
  /* The same script, in a process that cannot write — see tests/read-only-guard.js. */
  const runReadOnly = (...args) => runWith(['--require', './tests/read-only-guard.js'], args);

  const newAsset = async (project, code, status, assignee = null) => {
    const assetId = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id) VALUES (?,?,?,?,?,?,?)',
      [assetId, project, code, `Asset ${code}`, 'character', status, assignee]);
    return assetId;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'us-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST', body: {
      token: 'us-boot', name: 'Owner', email: 'owner@us.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.owner = await login('owner@us.test');

    /* The display names matter here: the script finds a person the way a human would name
       them, so they are the strings passed to it below. The short keys are only for the
       token table. */
    const make = async (key, name, role) => {
      const email = `${key}@us.test`;
      const r = await as('owner', '/users', { method: 'POST', body: {
        name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
      token[key] = await login(email);
      return r.body.user.id;
    };
    id.acting = await make('acting', 'Stand In', 'game_artist');
    id.plain = await make('plain', 'Plain Artist', 'game_artist');
    id.lead = await make('lead', 'Real Lead', 'team_lead');
    /* A second person whose name contains "Artist", so the ambiguity branch has something
       to be ambiguous about. */
    id.other = await make('other', 'Second Artist', 'game_artist');

    const client = await as('owner', '/clients', { method: 'POST', body: { name: 'US Co' } });
    const a = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Alpha', clientId: client.body.client.id } });
    const b = await as('owner', '/projects', { method: 'POST',
      body: { name: 'Beta', clientId: client.body.client.id } });
    id.A = a.body.project.id;
    id.B = b.body.project.id;
    id.codeA = a.body.project.code;

    for (const [code, status] of [['A-1', 'in_progress'], ['A-2', 'pending_tl_review'],
      ['A-3', 'delivered']]) await newAsset(id.A, code, status);
    await newAsset(id.B, 'B-1', 'in_progress', id.plain);
    await newAsset(id.B, 'B-2', 'in_progress');

    assert.strictEqual((await as('owner', `/projects/${id.A}`, { method: 'PATCH', body: {
      teamLeadIds: [id.lead], actingTeamLeadIds: [id.acting] } })).status, 200);
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* ------------------------------------------------------------------ it writes nothing */

  await t.test('running it changes nothing in the database', async () => {
    /* EVERY TABLE, counted and checksummed before and after — not just the ones the script
       names. A diagnostic that touched `audit_log` or bumped a `last_seen` column would be
       a diagnostic that cannot be run while somebody is waiting, and naming the tables to
       watch would be assuming which ones it could reach. */
    const snapshot = async () => {
      const tables = (await sql(cfg, 'SHOW TABLES')).map((r) => Object.values(r)[0]);
      const out = {};
      for (const table of tables) {
        const [{ n }] = await sql(cfg, `SELECT COUNT(*) AS n FROM \`${table}\``);
        const sum = await sql(cfg, `CHECKSUM TABLE \`${table}\``);
        out[table] = `${n}/${sum[0].Checksum}`;
      }
      return out;
    };

    const before = await snapshot();
    assert.ok(Object.keys(before).length > 20, 'the schema is really there');

    run('Stand In');
    run('Plain Artist', 'Alpha');
    run('Real Lead');
    run('plain@us.test');
    try { run('nobody at all'); } catch (err) { assert.strictEqual(err.status, 1); }

    assert.deepStrictEqual(await snapshot(), before,
      'the diagnostic changed the database');
  });

  await t.test('it still answers in a process that cannot write at all', async () => {
    /* THE CHECKSUM TEST ABOVE IS NOT ENOUGH ON ITS OWN, and a mutation proved it: an
       `UPDATE users SET name = name` changes no bytes, so comparing bytes cannot see it.
       A no-op write is still a write — locks, binary log, triggers, and a flat refusal from
       a replica or a read-only user.
       
       So the script is run again through a guard that replaces src/db's query() and exits
       3 on any statement that is not a read. If it answers, it read only. The two tests are
       complementary: this one proves no write was ISSUED, the one above proves nothing
       changed even by a path this guard cannot see. */
    const out = runReadOnly('Stand In');
    assert.match(out, /sees EVERY asset/, 'it answered');
    assert.match(out, /named on project_acting_team_leads/, 'and with the reason');

    /* THE GUARD ITSELF IS PROVED TO BITE, because a guard that silently never fires is
       worse than no guard: it reads as coverage. A write is attempted through the same
       entry point the script uses, in the same kind of process, and the exit code says 3. */
    const proof = (() => {
      try {
        execFileSync(process.execPath, ['--require', './tests/read-only-guard.js', '-e',
          "require('./src/db').query('UPDATE users SET name = name WHERE id = $1', ['x'])"], {
          cwd: ROOT,
          env: { ...process.env,
            DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
            DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
        });
        return { status: 0, stderr: '' };
      } catch (err) {
        return { status: err.status, stderr: (err.stderr || '').toString() };
      }
    })();
    assert.strictEqual(proof.status, 3, 'the guard stops a write');
    assert.match(proof.stderr, /may only read/);

    // And a read goes through it untouched.
    const reads = execFileSync(process.execPath, ['--require', './tests/read-only-guard.js', '-e',
      "const db=require('./src/db');db.query('SELECT 1 AS n').then(r=>{"
      + "process.stdout.write(String(r.rows[0].n));return db.end();})"], {
      cwd: ROOT,
      env: { ...process.env,
        DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: cfg.database,
        DB_USER: cfg.user, DB_PASSWORD: cfg.password, DATABASE_URL: '' },
    }).toString();
    assert.strictEqual(reads, '1', 'and lets a read through');
  });

  /* ------------------------------------------------- it agrees with the server */

  await t.test('its verdict for the Acting TL matches what the routes give them', async () => {
    const out = run('Stand In');

    assert.match(out, /designation game_artist/);
    assert.match(out, /projectScope own_work\s+leadsTeam false/,
      'the designation facts are printed, because they are what made this confusing');

    /* The two lines about project A, and the reason. */
    const alpha = out.split('\n').find((l) => l.includes('Alpha'));
    const detail = out.split('\n')[out.split('\n').indexOf(alpha) + 1];
    const why = out.split('\n')[out.split('\n').indexOf(alpha) + 2];
    assert.match(detail, /sees EVERY asset/, detail);
    assert.match(detail, /visible 3\/3\s+hidden 0/, detail);
    assert.match(why, /named on project_acting_team_leads/, why);
    assert.match(out, /LEAD-LEVEL VISIBILITY ON: Alpha/);

    /* AND THE SAME NUMBER FROM THE ROUTE. This is the assertion that keeps the script
       honest: if it ever prints a verdict the board does not deliver, it is the script that
       is wrong, and this is where that shows up. */
    const board = await as('acting', `/assets/project/${id.A}`);
    assert.strictEqual(board.status, 200);
    assert.strictEqual((board.body.assets || []).length, 3,
      'the script says 3 of 3 and the route must hand over 3');
  });

  await t.test('and for an artist who is named on nothing', async () => {
    const out = run('Plain Artist');
    const lines = out.split('\n');
    const alpha = lines.findIndex((l) => l.includes('Alpha'));
    assert.match(lines[alpha + 1], /sees only their own assignments/, lines[alpha + 1]);
    assert.match(lines[alpha + 2], /not reachable: scope 'own_work'/, lines[alpha + 2]);

    const beta = lines.findIndex((l) => l.includes('Beta'));
    assert.match(lines[beta + 1], /visible 1\/2\s+hidden 1/, lines[beta + 1]);
    assert.match(out, /LEAD-LEVEL VISIBILITY ON: \(none\)/);

    /* The route agrees: one row on B, and A refused outright. */
    assert.strictEqual((await as('plain', `/assets/project/${id.B}`)).body.assets.length, 1);
    assert.strictEqual((await as('plain', `/assets/project/${id.A}`)).status, 403);
  });

  await t.test('and for the real Team Lead, who gets there another way', async () => {
    const out = run('Real Lead');
    const lines = out.split('\n');
    const alpha = lines.findIndex((l) => l.includes('Alpha'));
    assert.match(lines[alpha + 1], /sees EVERY asset/);
    /* THE REASON IS THE DESIGNATION, NOT THE TABLE, and the script says which — the order
       its lines are written in is the order the functions ask the questions, so "leadsTeam"
       beats "named on", and a reader can tell a lead by designation from a stand-in. */
    assert.match(lines[alpha + 2], /designation leadsTeam/, lines[alpha + 2]);
    assert.match(out, /team lists: project_team_leads/,
      'while still reporting the list they are on');
  });

  await t.test('one project at a time, by name or by code', async () => {
    const byName = run('Stand In', 'Alpha');
    assert.ok(byName.includes('Alpha') && !byName.includes('Beta'),
      'naming a project narrows the report to it');
    const byCode = run('Stand In', id.codeA);
    assert.ok(byCode.includes('Alpha'), 'and a project code works as well as a name');
  });

  /* -------------------------------------------------------- it refuses to guess */

  await t.test('two people matching one term is reported, not guessed at', () => {
    /* Picking one of two people called Artist is how a diagnostic tells somebody the wrong
       thing with confidence. */
    let err = null;
    try { run('Artist'); } catch (e) { err = e; }
    assert.ok(err, 'an ambiguous term must not be answered');
    assert.strictEqual(err.status, 2, 'exit 2 means ambiguous');
    assert.match(err.stderr, /users match/);
    assert.match(err.stderr, /Plain Artist/);

    let missing = null;
    try { run('Nobody Here'); } catch (e) { missing = e; }
    assert.strictEqual(missing.status, 1, 'exit 1 means nobody matched');

    /* An exact email is never ambiguous, whatever else contains the same letters. */
    const exact = run('plain@us.test');
    assert.match(exact, /Plain Artist/);
  });

  await t.test('an unmigrated project list does not take the script down with it', async () => {
    /* The reason an Acting TL's project was invisible in the first place was a table that
       did not exist on older installs. The script reads the list from the application's
       constant, so a missing table is a thrown query — and a diagnostic that dies on the
       install most likely to need it is no use. */
    await sql(cfg, 'DROP TABLE IF EXISTS project_acting_team_leads');
    let out = '';
    let failed = null;
    try { out = run('Real Lead'); } catch (e) { failed = e; }
    if (failed) {
      assert.match(`${failed.stderr}`, /user-sees:/,
        'if it cannot answer it says so in one line rather than printing a stack');
      assert.strictEqual(failed.status, 1);
    } else {
      assert.match(out, /Alpha/, 'or it answers from the tables that are there');
    }
  });
});
