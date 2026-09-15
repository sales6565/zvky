/* The Level on a user.
 *
 * Two rungs, recorded and nothing more. The tests that matter are not the
 * round trip — that is easy — but the two that keep the field honest:
 *
 *   BOTH OPTIONS ARE ALWAYS OFFERED   The page's markup carries them as literal
 *                                     <option> elements, filtered by nothing.
 *                                     Whatever the user's role, department or
 *                                     anything else, the choice is the same two.
 *
 *   IT DRIVES NOTHING                 Level must not route an approval, widen
 *                                     access or feed a permission check. The
 *                                     guard below fails the moment any module
 *                                     outside user-level.js reads the column,
 *                                     which is where that decision would first
 *                                     show up.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const userLevel = require('../src/user-level');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('userlevel');
const ROOT = path.join(__dirname, '..');

// --- the two options, with no database at all ---------------------------------

test('there are exactly two levels, labelled as the studio named them', () => {
  assert.deepStrictEqual(userLevel.LEVELS.map((l) => l.label),
    ['Level 1 - Team Lead', 'Level 2 - Manager']);
  assert.deepStrictEqual(userLevel.LEVELS.map((l) => l.key), ['level_1', 'level_2']);
});

test('unset is a real state, and is not the bottom rung', () => {
  for (const blank of [null, undefined, '', '   ']) {
    const v = userLevel.validate(blank);
    assert.strictEqual(v.ok, true, `${JSON.stringify(blank)} is allowed`);
    assert.strictEqual(v.value, null, 'and means not set, not level_1');
  }
  assert.strictEqual(userLevel.label(null), null);
});

test('anything that is not one of the two is refused, and says what the two are', () => {
  for (const bad of ['level_3', 'Level 1', 'team_lead', 'LEVEL_1', '1']) {
    const v = userLevel.validate(bad);
    assert.strictEqual(v.ok, false, `"${bad}" should be refused`);
    assert.match(v.error, /Level 1 - Team Lead/);
    assert.match(v.error, /Level 2 - Manager/);
  }
  // Surrounding whitespace is never meant.
  assert.strictEqual(userLevel.validate('  level_2  ').value, 'level_2');
});

/* BOTH OPTIONS, ALWAYS. The brief's first testing step, checked where it can
   actually be guaranteed: the page's markup. They are literal options, so no
   role, department or condition can filter one out — there is no code path that
   builds this list, which is the strongest form the guarantee can take. */
test('the page offers both levels as literal options, filtered by nothing', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = page.indexOf('<select id="eu_level">');
  assert.ok(start > -1, 'the Level select is still on the Edit User form');
  const block = page.slice(start, page.indexOf('</select>', start));

  for (const [value, labelText] of [
    ['level_1', 'Level 1 - Team Lead'],
    ['level_2', 'Level 2 - Manager'],
  ]) {
    assert.ok(block.includes(`<option value="${value}">${labelText}</option>`),
      `${labelText} is a literal option`);
  }
  assert.ok(block.includes('<option value="">'), 'and Not set is offered back');
  /* No template expression anywhere inside the select: the moment one appears,
     the options are being built rather than stated, and "always present" stops
     being something this test can promise. */
  assert.ok(!block.includes('${'), 'the option list is stated, not computed');
});

/* IT DRIVES NOTHING. The column is read by the users routes, which shape it
   onto a payload, and by nothing else. */
test('nothing outside the users routes reads the level column', () => {
  const allowed = new Set(['user-level.js', 'routes/users.js', 'migrate.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(path.join(ROOT, 'src'), full);
      if (allowed.has(rel)) continue;
      const text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* The column, not the word: rate cards have their own `level` and the
         idle report has hoursPerDay. Only a read of the users column counts. */
      if (/\buserLevel\b|users?\.level\b|user_level\b/.test(text)) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(offenders, [],
    'Level is informational. If a feature now routes by it, that is a decision to take on purpose.');
});

// --- against a live server ----------------------------------------------------

test('Level end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Level-Test-1!';
  let server;
  const token = {};
  const person = {};
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const levelOf = async (id) => (await as('root', `/users/${id}`)).body.user.level;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'lvl-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'lvl-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token.root = (await call('/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    for (const [key, name, role] of [
      ['lead', 'Lead Person', 'team_lead'],
      ['artist', 'Artist Person', 'game_artist'],
      ['producer', 'Producer Person', 'producer'],
    ]) {
      person[key] = (await as('root', '/users', { method: 'POST',
        body: { name, email: `${key}@zvky.test`, password: PASSWORD, role } })).body.user.id;
    }
  });
  t.after(() => stopServer(server));

  await t.test('every account starts with no level, whatever its designation', async () => {
    /* Testing step 1: the field means the same thing for every user. Nothing is
       back-filled from the designation — "Team Lead" does not imply Level 1. */
    for (const key of ['lead', 'artist', 'producer']) {
      assert.strictEqual(await levelOf(person[key]), null, `${key} starts unset`);
    }
  });

  await t.test('both levels save and come back, and switching works both ways', async () => {
    // Testing steps 2, 3 and 4, on one account, in the order the brief asks.
    for (const value of ['level_1', 'level_2', 'level_1', 'level_2']) {
      const res = await as('root', `/users/${person.artist}`, { method: 'PATCH', body: { level: value } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(await levelOf(person.artist), value, `${value} persisted`);
      // Read it from the database too, not only from the payload that wrote it.
      const [row] = await sql(cfg, `SELECT \`level\` FROM users WHERE id = '${person.artist}'`);
      assert.strictEqual(row.level, value);
    }

    // And it appears on the list the Users tab reads, with its label.
    const listed = (await as('root', '/users?limit=100')).body.users
      .find((u) => u.id === person.artist);
    assert.strictEqual(listed.level, 'level_2');
    assert.strictEqual(listed.levelLabel, 'Level 2 - Manager');

    // Back to unset, which is a real choice and not the bottom rung.
    await as('root', `/users/${person.artist}`, { method: 'PATCH', body: { level: null } });
    assert.strictEqual(await levelOf(person.artist), null);
  });

  await t.test('the same two levels apply to every designation', async () => {
    /* The brief's second suspected cause: filtering by role. There is none —
       the API takes either level for any account. */
    for (const key of ['lead', 'artist', 'producer']) {
      for (const value of ['level_1', 'level_2']) {
        const res = await as('root', `/users/${person[key]}`, { method: 'PATCH', body: { level: value } });
        assert.strictEqual(res.status, 200, `${key} may be ${value}`);
        assert.strictEqual(await levelOf(person[key]), value);
      }
    }
  });

  await t.test('a level that is not one of the two is refused, and nothing is written', async () => {
    await as('root', `/users/${person.lead}`, { method: 'PATCH', body: { level: 'level_1' } });
    for (const bad of ['level_3', 'Manager', '2']) {
      const res = await as('root', `/users/${person.lead}`, { method: 'PATCH', body: { level: bad } });
      assert.strictEqual(res.status, 400, `${bad} should be refused`);
      assert.strictEqual(res.body.field, 'level');
      assert.match(res.body.error, /Level 1 - Team Lead or Level 2 - Manager/);
    }
    assert.strictEqual(await levelOf(person.lead), 'level_1', 'the refusals changed nothing');
  });

  await t.test('editing the level changes nothing else about the account', async () => {
    /* Testing step 5. The whole record before and after, so a level edit cannot
       quietly move a reporting line, a role or an active flag. */
    const before = (await as('root', `/users/${person.producer}`)).body.user;
    await as('root', `/users/${person.producer}`, { method: 'PATCH', body: { level: 'level_2' } });
    const after = (await as('root', `/users/${person.producer}`)).body.user;

    for (const key of Object.keys(before)) {
      if (key === 'level' || key === 'levelLabel') continue;
      assert.deepStrictEqual(after[key], before[key], `${key} was left alone`);
    }
    assert.strictEqual(after.level, 'level_2');
  });

  await t.test('setting a level needs user.edit, like the name beside it', async () => {
    const made = await as('root', '/users', { method: 'POST',
      body: { name: 'No Edit', email: 'noedit@zvky.test', password: PASSWORD, role: 'game_artist' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    token.plain = (await call('/auth/login', { method: 'POST',
      body: { email: 'noedit@zvky.test', password: PASSWORD } })).body.token;

    const res = await as('plain', `/users/${person.artist}`, { method: 'PATCH', body: { level: 'level_1' } });
    assert.ok(res.status === 403 || res.status === 404, `expected a refusal, got ${res.status}`);
  });
});
