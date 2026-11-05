/* scripts/discipline-audit.js — THE READ-ONLY AUDIT, PROVED READ-ONLY.
 *
 * ===========================================================================
 * WHY A SCRIPT NEEDS A TEST AT ALL.
 *
 * This one is meant to be run on PRODUCTION, by an owner who wants to know how
 * many assets move to the Animation tab before the change that moves them. A
 * script with that job has to be safe in a way that a comment cannot make it:
 * "it only SELECTs" is a claim about every line somebody will ever add to it.
 *
 * SO THE CLAIM IS CHECKED THREE WAYS, and the third is the one that matters:
 *
 *   1. the refusal itself — a non-SELECT handed to its one query function
 *      throws rather than running;
 *   2. the statements it ACTUALLY runs, recorded through an injected handle and
 *      asserted to begin with SELECT;
 *   3. the database, compared before and after a real run: every table's row
 *      count, and every assets.type / assets.category / categories.discipline
 *      value.
 *
 * (1) alone is a regular expression. (2) alone would pass a script that ran
 * `SELECT ... INTO OUTFILE`. (3) is the property the owner actually cares
 * about, and it is why this suite builds a real database rather than a stub.
 *
 * AND THE NUMBERS HAVE TO BE RIGHT, or an owner reads a reassuring report and
 * is surprised on deploy day. So the audit's verdict for every row is compared
 * with the shared rule in src/asset-discipline.js, which is what the
 * application will actually use.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const audit = require('../scripts/discipline-audit.js');
const discipline = require('../src/asset-discipline');

const cfg = config('discaudit');
const PASSWORD = 'Audit-Test-1!';

test('the refusal: nothing but a SELECT gets past it', () => {
  /* THE GUARD, as a value. Every statement in the script goes through one
     function that tests this expression, so a query added carelessly throws
     instead of writing. Asserted on the words rather than on behaviour because
     the point is the LIST — a verb missing from it is the whole failure. */
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE',
    'TRUNCATE', 'REPLACE', 'GRANT']) {
    assert.ok(audit.FORBIDDEN.test(`${verb} INTO x VALUES (1)`), `${verb} is refused`);
    assert.ok(audit.FORBIDDEN.test(`select 1; ${verb.toLowerCase()} x`),
      `${verb} is refused whatever its case or position`);
  }
  assert.ok(!audit.FORBIDDEN.test('SELECT a.id, a.`code` FROM assets a'),
    'and an ordinary read is not');
  /* A WORD THAT MERELY CONTAINS ONE IS NOT ONE — \b, so a column called
     `created_at` or a table called `updates` does not make a read unrunnable. */
  assert.ok(!audit.FORBIDDEN.test('SELECT created_at, updates FROM t'));
});

test('the "before" rule is the rule that produced the bug', () => {
  /* THE HISTORY THE WHOLE SCRIPT COMPARES AGAINST. It is written out in the
     script because it exists nowhere else any more, so it is pinned here: the
     type alone, `animation` and nothing else, which is what put a character
     filed under an animation category under Art. */
  assert.strictEqual(audit.beforeDiscipline({ type: 'animation' }), 'animation');
  assert.strictEqual(audit.beforeDiscipline({ type: 'character' }), 'art');
  assert.strictEqual(audit.beforeDiscipline({ type: 'character', category: 'animation' }), 'art',
    'the bug, in one assertion: the category was never consulted');
  assert.strictEqual(audit.beforeDiscipline({}), 'art');
  assert.strictEqual(audit.beforeDiscipline({ type: ' ANIMATION ' }), 'animation');

  /* AND "AFTER" IS THE SHARED RULE, ASKED — not a second copy of it. */
  const map = discipline.disciplineMap([{ key: 'animation', discipline: 'animation' }]);
  for (const asset of [{ type: 'character', category: 'animation' },
    { type: 'animation', category: null }, { type: 'prop', category: 'nonesuch' }, {}]) {
    assert.strictEqual(audit.afterDiscipline(asset, map),
      discipline.assetDiscipline(asset, map),
      `the audit and the application must agree about ${JSON.stringify(asset)}`);
  }
});

test('the audit, against a real database', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  let projectId;
  const call = (p, opts = {}) => api(server.base, p, opts);
  const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
  const q = (text, params) => sql(cfg, text, params);

  /* THE HANDLE THE SCRIPT IS GIVEN: bound to THIS suite's database (src/db's
     pool points at TEST_DB_NAME, not at the suite's copy), translating $n to ?
     the way src/db.js does, and RECORDING every statement. The recording is the
     point: it is the only way to assert on the queries the script really runs
     rather than on the ones its source appears to contain. */
  const ran = [];
  const handle = {
    async query(text, params = []) {
      ran.push(String(text));
      const values = [];
      const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
        values.push(params[Number(n) - 1]);
        return '?';
      });
      const rows = await sql(cfg, translated, values.length ? values : params);
      return { rows: Array.isArray(rows) ? rows : [], result: rows };
    },
  };

  /* EVERY TABLE'S ROW COUNT, plus the three columns this feature reads, so the
     comparison is of the data and not only of the shape. */
  const snapshot = async () => {
    const tables = await q(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
    const counts = {};
    for (const { t } of tables) {
      counts[t] = Number((await q(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
    }
    return {
      counts,
      assets: await q('SELECT id, `type`, category FROM assets ORDER BY `code`'),
      categories: await q('SELECT `key`, label, discipline FROM categories ORDER BY `key`'),
    };
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'da-token',
      WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
    });
    await call('/auth/bootstrap', { method: 'POST', body: {
      token: 'da-token', name: 'Root', email: 'root@da.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@da.test', password: PASSWORD } })).body.token;
    await openStudio(server.base, token.root);

    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Audit Project' } })).body.project.id;

    for (const label of ['Animation', 'Characters', 'Props']) {
      const made = await as('root', '/reference/categories', { method: 'POST', body: { label } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    }
    /* The three cases the brief names, and the ordinary work around them so the
       counts in the report mean something. */
    for (const [name, type, category] of [
      ['River Spirit', 'character', 'animation'],
      ['River Spirit Walk', 'animation', 'animation'],
      ['Villain', 'character', 'animation'],
      ['Hero', 'character', 'characters'],
      ['Hero Run', 'animation', null],
      ['Lantern', 'prop', 'props'],
      ['Opening Beat', 'background', null],
    ]) {
      const made = await as('root', `/assets/project/${projectId}`,
        { method: 'POST', body: { name, type, category } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    }
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('it writes nothing, and every statement it runs is a read', async () => {
    const before = await snapshot();
    ran.length = 0;
    const out = [];
    const report = await audit.main({ db: handle, argv: [], write: (s) => out.push(s),
      databaseName: 'audit-suite' });

    assert.ok(ran.length >= 2, `it ran some queries: ${ran.length}`);
    for (const statement of ran) {
      assert.match(statement.trim(), /^SELECT\b/i,
        `every statement is a read, and this was not: ${statement}`);
      assert.ok(!audit.FORBIDDEN.test(statement),
        `and none of them would have been refused: ${statement}`);
    }

    /* THE DATABASE, COMPARED. The assertion the owner actually wants. */
    assert.deepStrictEqual(await snapshot(), before,
      'the audit left the database exactly as it found it');

    // And it printed something, with the database it was pointed at named.
    assert.ok(out.join('').includes('audit-suite'), 'the output names the database');
    assert.strictEqual(report.assets, 7);
  });

  await t.test('its verdict for every row is the rule the application will use', async () => {
    const report = await audit.main({ db: handle, argv: ['--json'], write: () => {} });

    assert.strictEqual(report.categoriesHaveDisciplineColumn, true,
      'the column is there, so the mapping is read and not guessed');
    for (const c of report.categories) {
      assert.strictEqual(c.source, 'column', `${c.key} is read from the column`);
    }
    const map = discipline.disciplineMap(report.categories);
    assert.strictEqual(map.get('animation'), 'animation');
    assert.strictEqual(map.get('characters'), 'art');

    const rows = await q('SELECT `code`, `type`, category FROM assets ORDER BY `code`');
    /* GROUP BY GROUP: the count, the tab it lands in today, and the tab it lands
       in after — each checked against the rule rather than against a number
       written here, so the report cannot be reassuring and wrong. */
    let counted = 0;
    for (const g of report.groups) {
      const mine = rows.filter((r) => (r.type || null) === g.type
        && (r.category || null) === g.category);
      assert.strictEqual(g.count, mine.length, `the (${g.type}, ${g.category}) group's count`);
      counted += g.count;
      assert.strictEqual(g.before, audit.beforeDiscipline(mine[0]), 'where it lands today');
      assert.strictEqual(g.after, discipline.assetDiscipline(mine[0], map), 'and after');
    }
    assert.strictEqual(counted, rows.length, 'every asset is in exactly one group');

    /* AND THE LIST OF MOVES IS EXACTLY THE ROWS THAT MOVE. Both directions:
       nothing listed that stays put, nothing omitted that moves. */
    const should = rows.filter((r) => audit.beforeDiscipline(r)
      !== discipline.assetDiscipline(r, map)).map((r) => r.code).sort();
    assert.deepStrictEqual(report.moves.map((m) => m.code).sort(), should);
    /* AND THE FIXTURE ACTUALLY CONTAINS SOME. The assertion above is an
       equality between two derived lists, so it would hold perfectly for a
       fixture in which nothing moves — and then this whole test would be
       checking the audit against a bug it never sees. */
    assert.ok(should.length >= 2,
      `the fixture must contain assets that move, and it has ${should.length}`);
    for (const m of report.moves) {
      assert.strictEqual(m.before, 'art');
      assert.strictEqual(m.after, 'animation');
      assert.strictEqual(m.project, 'Audit Project', 'named, so an owner can find it');
    }
  });

  await t.test('--changes-only prints the moves and not the groups', async () => {
    const full = [];
    await audit.main({ db: handle, argv: [], write: (s) => full.push(s) });
    const brief = [];
    await audit.main({ db: handle, argv: ['--changes-only'], write: (s) => brief.push(s) });

    assert.match(full.join(''), /assets by \(type, category\)/);
    assert.ok(!/assets by \(type, category\)/.test(brief.join('')),
      '--changes-only leaves the groups out');
    for (const text of [full.join(''), brief.join('')]) {
      assert.match(text, /assets whose tab changes: 2/,
        'and both say how many move, because that is the number being asked for');
    }
  });

  await t.test('it previews the migration on a database that has not run it', async () => {
    /* THE CASE IT IS MOST LIKELY TO BE USED IN: an owner running it against
       production BEFORE the upgrade. The column is not there, so the mapping is
       the migration's own guess — and the output must say so, or a report whose
       numbers came from a guess reads as one whose numbers came from the data. */
    await q('ALTER TABLE categories DROP COLUMN discipline');
    try {
      const report = await audit.main({ db: handle, argv: ['--json'], write: () => {} });
      assert.strictEqual(report.categoriesHaveDisciplineColumn, false);
      for (const c of report.categories) {
        assert.strictEqual(c.source, 'name-preview', `${c.key} is a preview`);
        assert.strictEqual(c.discipline, discipline.disciplineFromName(c.label),
          'and the preview is the migration\'s own guess, from the shared function');
      }
      assert.strictEqual(report.moves.length, 2,
        'and it still names the assets that will move');

      const out = [];
      await audit.main({ db: handle, argv: [], write: (s) => out.push(s) });
      assert.match(out.join(''), /categories\.discipline column: NOT YET/,
        'the output says the numbers are a preview');
    } finally {
      /* PUT BACK BY RE-RUNNING THE MIGRATION STEP, not by a hand-written ALTER
         — so this also proves the step adds the column to a database that has
         lost it, which is the case /api/health sends somebody to. */
      const step = require('../src/migrate').STEPS
        .find(([name]) => name === 'asset category disciplines')[1];
      await step(handle, () => {});
      const back = await q(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories'
            AND COLUMN_NAME = 'discipline'`);
      assert.strictEqual(Number(back[0].n), 1, 'the step put the column back');
    }
  });
});
