/* PROMPT 66: ASSETS IN THE ANIMATION CATEGORY APPEAR UNDER THE ANIMATION TAB.
 *
 * ===========================================================================
 * THE BUG, as the studio reported it: assets whose CATEGORY is Animation did
 * not show under the Dashboard's Animation sub-tab. The cause was one line —
 * the Art / Animation lens was decided by `assets.type` alone, so a character
 * filed under a category called Animation classified as Art.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING, beyond "the new rule works":
 *
 *   1. NOTHING MOVED FOR ANYBODY ELSE. The fix changes a classification that
 *      every board, the upload folder, the Artist Report's Department column and
 *      the Time Sheet export all read. A studio that has not classified a
 *      category must see exactly the board it saw yesterday, and that is
 *      asserted against the OLD rule written out, over a matrix, rather than
 *      against a few examples.
 *
 *   2. THE MAPPING IS DATA, AND THE DATA IS SEEDED ONCE. The migration's guess
 *      ("the name contains animation") and the shared disciplineFromName() must
 *      agree, or a studio's list is classified one way by the upgrade and
 *      another way by the next category somebody adds. And the seed must never
 *      overrule a choice: a category moved to Art on the Settings screen stays
 *      Art across every future boot.
 *
 *   3. NOTHING IS REWRITTEN. The discipline is derived at read time. No asset
 *      row is touched by any of this, and a test says so by comparing the
 *      `assets` table before and after a category is moved between disciplines.
 *
 * THE MIRROR between src/asset-discipline.js and the page is held by
 * tests/asset-discipline.test.js, character for character; the board's own
 * rendering by tests/dashboard-lens.test.js; the SQL predicate against a real
 * database by tests/artist-report.test.js. This file is the feature end to end:
 * the column, the seed, the Settings dropdown, the permission, the audit line,
 * and the asset that started it all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, openStudio, sql,
  systemClientId, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIGRATE = fs.readFileSync(path.join(ROOT, 'src', 'migrate.js'), 'utf8');

const discipline = require('../src/asset-discipline');

const cfg = config('catdiscipline');
const PASSWORD = 'Discipline-Test-1!';

/* ---- the guess, and the two places it is made -------------------------- */

test('the migration\'s guess and disciplineFromName() are the same guess', () => {
  /* TWO EXPRESSIONS OF ONE RULE, which is the shape this whole module exists to
     avoid — but the migration has to run in SQL and cannot call a JavaScript
     function, so there is no way to have one. What there is instead is this
     test: the CASE expression is read out of src/migrate.js, its LIKE semantics
     are applied here, and the answer is compared with the shared function over
     every label shape that has ever caused trouble. */
  const at = MIGRATE.indexOf('async function ensureCategoryDisciplines(');
  assert.ok(at !== -1, 'the migration step is there');
  const step = MIGRATE.slice(at, MIGRATE.indexOf('\n}', at));
  assert.match(step, /LOWER\(label\) LIKE '%animation%'/, 'it tests the label');
  /* The backslash is real: the step's SQL is a template literal, so the
     column's backquotes are escaped in the source this reads. */
  assert.match(step, /LOWER\(\\`key\\`\) LIKE '%animation%'/, 'and the key');
  assert.match(step, /WHERE discipline IS NULL/,
    'and only where nothing has been chosen — this is what makes it idempotent');

  /* The LIKE pattern the step uses, lifted rather than retyped, so a change to
     the word in the migration fails here instead of drifting. */
  const pattern = /LIKE '%(\w+)%'/.exec(step)[1];
  const sqlSaysAnimation = (text) => String(text === null || text === undefined ? '' : text)
    .toLowerCase().includes(pattern);

  for (const label of ['Animation', 'animation', 'ANIMATION', 'FX Animation',
    'Animation Props', 'Character Animation', 'Animations', 'animation_2',
    'Characters', 'Props', 'Environment', 'Layout', 'Rigging', 'Anim', 'anim',
    '', ' ', null, undefined]) {
    assert.strictEqual(discipline.disciplineFromName(label) === 'animation',
      sqlSaysAnimation(label),
      `the migration and disciplineFromName() disagree about ${JSON.stringify(label)}`);
  }

  /* AND IT IS A GUESS ABOUT A NAME, not about an asset: "Animations" (plural)
     contains the word and so is Animation here, while the asset TYPE
     "animations" is deliberately NOT animation — the type is a reference key
     matched exactly, the category name is prose somebody typed. The difference
     is intentional and is stated here so it is not read as a bug later. */
  assert.strictEqual(discipline.disciplineFromName('Animations'), 'animation');
  assert.strictEqual(discipline.assetDiscipline({ type: 'animations' }), 'art');
});

/* ---- the Settings panel, read off the page ------------------------------ */

test('the Settings panel offers a Discipline dropdown per category', () => {
  const at = PAGE.indexOf("collection: 'categories',");
  assert.ok(at !== -1, 'the Asset Categories section is there');
  const section = PAGE.slice(at, PAGE.indexOf('\n  },', at));
  assert.match(section, /permission: 'settings\.categories'/,
    'under the permission that already manages this list — no new key');
  assert.match(section, /key:'discipline', label:'Counts as', input:'discipline'/,
    'with the Counts as column in the Add row');
  assert.match(section, /Counts as" decides which Dashboard tab/,
    'and the note says what it does');

  /* THE ROW'S OWN CONTROL, drawn from ASSET_DISCIPLINES rather than from two
     literals — so a third discipline would appear here without a page change,
     and more to the point the two that exist cannot be spelled differently
     here than in the rule. */
  const rows = PAGE.slice(PAGE.indexOf('function renderRefSection(sec){'),
    PAGE.indexOf('const heads = [\'Name\'];'));
  assert.match(rows, /sec\.collection==='categories'/, 'the cell is drawn for categories');
  assert.match(rows, /class="ref-discipline" data-k="\$\{escapeHTML\(e\.key\)\}"/,
    'keyed by the category, so the handler knows which one changed');
  assert.match(rows, /ASSET_DISCIPLINES\.map\(d=>`<option value="\$\{escapeHTML\(d\.id\)\}"/,
    'with one option per discipline, from the shared list');

  /* AND SOMETHING LISTENS TO IT. A select nobody wired is the easiest version
     of this feature to ship broken: it renders, it shows the right value, and
     changing it does nothing. The handler lives in wireSettings(), which
     renderSettings() calls immediately after writing the markup that contains
     these rows — the same order .ref-rename has always relied on. */
  const wiring = PAGE.slice(PAGE.indexOf('function wireSettings(){'),
    PAGE.indexOf("document.querySelectorAll('.ref-rename')"));
  assert.match(wiring, /querySelectorAll\('\.ref-discipline'\)[\s\S]*?addEventListener\('change'/,
    'the dropdown saves on change');
  assert.match(wiring, /method:'PATCH', body:\{ discipline: sel\.value \}/,
    'through the route that already manages this list');
  assert.match(wiring, /sel\.value = was;/,
    'and a refusal puts the row back, so it never shows a value the server does not hold');
  const renderTail = PAGE.slice(PAGE.indexOf("el.querySelectorAll('.sii-link')"));
  assert.match(renderTail.slice(0, 200), /wireSettings\(\);/,
    'and wireSettings() runs after the markup, so the rows are there to wire');

  /* THE BLANK FIRST OPTION ON THE ADD ROW, which is the default and means "work
     it out from the name". A select defaulting to Art would send Art with every
     new category and defeat the guess entirely. */
  const input = PAGE.slice(PAGE.indexOf("if(col.input==='discipline'){"),
    PAGE.indexOf("if(col.input==='tier')"));
  assert.match(input, /<option value="" selected>/,
    'the Add row defaults to sending nothing, so the server decides from the name');

  /* THE HINT ON BOTH ASSET FORMS. The rule reads two fields and Animation wins
     a disagreement; a studio should not have to infer that from a board. */
  assert.match(PAGE, /<div id="f_disciplineHint" class="discipline-hint"><\/div>/,
    'the Add Asset form carries the line');
  assert.match(PAGE, /<div id="d_disciplineHint" class="discipline-hint">\$\{disciplineHint\(a\.type, a\.category\|\|''\)\}<\/div>/,
    'and the asset drawer draws it inline, so it is refreshed with the panel');
  const hint = new Function('assetDiscipline', 'ASSET_DISCIPLINES', 'CATEGORY_DISCIPLINE',
    'escapeHTML', 'categoryLabel',
    `${(() => {
      const from = PAGE.indexOf('function disciplineHint(type, category){');
      return PAGE.slice(from, PAGE.indexOf('\n}', from) + 2);
    })()} return disciplineHint;`)(
    discipline.assetDiscipline, discipline.DISCIPLINES,
    discipline.disciplineMap([{ key: 'animation', label: 'Animation', discipline: 'animation' }]),
    (x) => String(x), (x) => (x === 'animation' ? 'Animation' : String(x || '')));

  assert.match(hint('character', 'animation'), /Counts as <strong>Animation<\/strong>/);
  assert.match(hint('character', 'animation'), /because the "Animation" category counts as Animation/,
    'and it says WHY when the category is what decided it');
  assert.match(hint('animation', ''), /Counts as <strong>Animation<\/strong>/);
  assert.ok(!/because/.test(hint('animation', '')),
    'but not when the Scope of Work already said so');
  assert.match(hint('character', ''), /Counts as <strong>Art<\/strong>/);
  assert.ok(!/because/.test(hint('character', '')), 'and Art needs no explanation');
});

/* ===========================================================================
 * THE FEATURE, AGAINST A REAL DATABASE AND A REAL SERVER.
 */
test('a category can count as Animation, end to end',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
    let server;
    const token = {};
    const people = {};
    let projectId;
    const call = (p, opts = {}) => api(server.base, p, opts);
    const as = (who, p, opts = {}) => api(server.base, p, { ...opts, token: token[who] });
    const q = (text, params) => sql(cfg, text, params);

    const addCategory = (body) => as('root', '/reference/categories', { method: 'POST', body });
    const setDiscipline = (key, value, who = 'root') => as(who,
      `/reference/categories/${encodeURIComponent(key)}`,
      { method: 'PATCH', body: { discipline: value } });
    const newAsset = async (name, type, category) => {
      const res = await as('root', `/assets/project/${projectId}`,
        { method: 'POST', body: { name, type, category } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.asset;
    };
    /* The board's own classification, computed by the page's own code over the
       rows the API actually sends it — which is the whole chain the studio
       reported as broken: column, migration, route, reference payload, lens. */
    const lensFor = async (who = 'root') => {
      const assets = (await as(who, `/assets/project/${projectId}`)).body.assets;
      /* categoryDisciplines, NOT categories — the page reads the same field, and
         the difference is every asset filed under a retired category. */
      const categories = (await as(who, '/reference')).body.categoryDisciplines;
      const grab = (opener, closer = '\n}') => {
        const at = PAGE.indexOf(opener);
        assert.ok(at !== -1, `could not find ${opener}`);
        return PAGE.slice(at).slice(0, PAGE.slice(at).indexOf(closer) + closer.length);
      };
      const built = new Function('CATEGORIES', `${grab('const ASSET_DISCIPLINES = [', '\n];')}
        ${grab('function disciplineMap(categories) {')}
        ${grab('let CATEGORY_DISCIPLINE = new Map();', ';')}
        ${grab('function assetDiscipline(asset, categories) {')}
        ${grab('const BOARD_LENS = [', '\n];')}
        CATEGORY_DISCIPLINE = disciplineMap(CATEGORIES);
        return BOARD_LENS;`)(categories);
      const out = {};
      for (const l of built) out[l.id] = assets.filter(l.match).map((a) => a.code).sort();
      return out;
    };
    const grant = async (role, keys) => {
      const held = (await as('root', `/permissions/roles/${role}`)).body.role.permissions
        .filter((p) => p.enabled).map((p) => p.key);
      const r = await as('root', `/permissions/roles/${role}`, { method: 'PUT',
        body: { permissions: [...new Set([...held, ...keys])] } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    };

    t.before(async () => {
      await resetSchema(cfg);
      server = await startServer(cfg, {
        BOOTSTRAP_TOKEN: 'cd-token',
        WORK_HOURS_SWEEP_MINUTES: '0', EMAIL_SWEEP_MS: '0', EMAIL_BATCH_MS: '0',
      });
      await call('/auth/bootstrap', { method: 'POST', body: {
        token: 'cd-token', name: 'Root', email: 'root@cd.test', password: PASSWORD } });
      const login = async (email) => (await call('/auth/login', {
        method: 'POST', body: { email, password: PASSWORD } })).body.token;
      token.root = await login('root@cd.test');
      await openStudio(server.base, token.root);

      const clientId = await systemClientId(server.base, token.root);
      projectId = (await as('root', '/projects', { method: 'POST',
        body: { clientId, name: 'Discipline Project' } })).body.project.id;

      for (const [who, role] of [['ana', 'game_artist'], ['lee', 'team_lead']]) {
        const made = await call('/users', { token: token.root, method: 'POST',
          body: { name: who, email: `${who}@cd.test`, role, password: PASSWORD, projectId } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        people[who] = made.body.user.id;
        token[who] = await login(`${who}@cd.test`);
      }
    });
    t.after(async () => { if (server) await stopServer(server); });

    await t.test('the list ships empty, and the column ships with it', async () => {
      /* THE PREMISE THE OLD RULE RESTED ON, asserted rather than assumed: the
         asset categories list is EMPTY on a fresh studio. That is why reading
         the category was dismissed when the lens was built, and why the bug
         took a studio filling the list in to appear. */
      const listed = (await as('root', '/reference/categories')).body.entries;
      assert.deepStrictEqual(listed, [], 'no categories until somebody adds one');

      const columns = await q(
        `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories'
            AND COLUMN_NAME = 'discipline'`);
      assert.strictEqual(columns.length, 1, 'the migration added categories.discipline');
      /* NULLABLE, DELIBERATELY. NULL is "never classified", which is the only
         state the seed may write to — a NOT NULL DEFAULT 'art' column could not
         tell a seeded Art from a chosen one, and the seed could then never be
         made idempotent. */
      assert.strictEqual(columns[0].n, 'YES', 'nullable: NULL means never classified');

      // And the health check names the step to re-run if it is missing.
      const need = require('../src/schema-check').REQUIRED
        .find((r) => r.table === 'categories' && r.column === 'discipline');
      assert.ok(need, 'categories.discipline is declared');
      assert.ok(require('../src/migrate').STEPS.some(([name]) => name === need.step),
        `${need.step} is a real migration step`);
    });

    await t.test('a new category is classified from its name, and an explicit value wins', async () => {
      const made = {};
      for (const label of ['Animation', 'Characters', 'FX Animation', 'Props']) {
        const res = await addCategory({ label });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        made[res.body.entry.key] = res.body.entry;
      }
      assert.strictEqual(made.animation.discipline, 'animation',
        'a category called Animation counts as Animation without anybody saying so twice');
      assert.strictEqual(made.fx_animation.discipline, 'animation');
      assert.strictEqual(made.characters.discipline, 'art');
      assert.strictEqual(made.props.discipline, 'art');

      /* AN EXPLICIT VALUE WINS, both ways round — a studio whose animation
         category is called "Motion" says so once, and one with an art category
         called "Animation Reference" can say that too. */
      const motion = await addCategory({ label: 'Motion', discipline: 'animation' });
      assert.strictEqual(motion.body.entry.discipline, 'animation');
      const reference = await addCategory({ label: 'Animation Reference', discipline: 'art' });
      assert.strictEqual(reference.body.entry.discipline, 'art',
        'an explicit Art beats the name');

      // And a word that is not a discipline is refused rather than coerced.
      const bad = await addCategory({ label: 'Rigging Pass', discipline: 'rigging' });
      assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
      assert.match(bad.body.error, /counts as art or animation/i);
      const none = (await as('root', '/reference/categories')).body.entries
        .find((e) => e.key === 'rigging_pass');
      assert.ok(!none, 'and nothing was created');
    });

    await t.test('THE BUG: a character filed under Animation is on the Animation tab', async () => {
      const made = {
        both: await newAsset('River Spirit Walk', 'animation', 'animation'),
        byCategory: await newAsset('River Spirit', 'character', 'animation'),
        byNeither: await newAsset('Hero', 'character', 'characters'),
        byType: await newAsset('Hero Run', 'animation', null),
        effects: await newAsset('Water Splash', 'fx', 'fx_animation'),
        plain: await newAsset('Lantern', 'prop', 'props'),
      };

      const lens = await lensFor();
      assert.ok(lens.animation.includes(made.byCategory.code),
        'the asset the studio reported: category Animation, Scope of Work Character');
      assert.ok(!lens.art.includes(made.byCategory.code), 'and it is not under Art');

      // The whole board, so nothing else moved and nothing is in both tabs.
      assert.deepStrictEqual(lens, {
        art: [made.byNeither.code, made.plain.code].sort(),
        animation: [made.both.code, made.byCategory.code,
          made.byType.code, made.effects.code].sort(),
      });
      const all = [...lens.art, ...lens.animation];
      assert.strictEqual(new Set(all).size, Object.keys(made).length,
        'every asset in exactly one tab, none in both, none in neither');
    });

    await t.test('moving a category moves its assets, and writes nothing to them', async () => {
      /* THE PROMISE THE WHOLE DESIGN RESTS ON: the discipline is derived when
         the board is drawn, so a category moved between the two tabs moves its
         assets immediately and no asset row is touched. Asserted by comparing
         the `assets` table before and after, byte for byte. */
      const snapshot = () => q(
        'SELECT id, `code`, `type`, category, status, priority FROM assets ORDER BY `code`');
      const before = await snapshot();
      const lensBefore = await lensFor();

      const moved = await setDiscipline('animation', 'art');
      assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
      assert.strictEqual(moved.body.entry.discipline, 'art');

      const lensAfter = await lensFor();
      assert.deepStrictEqual(await snapshot(), before,
        'not one asset row changed — the tab is worked out, never stored');
      assert.notDeepStrictEqual(lensAfter, lensBefore, 'but the board did move');
      const character = before.find((r) => r.category === 'animation' && r.type === 'character');
      assert.ok(lensAfter.art.includes(character.code),
        'the character is back under Art, because its category is Art again');

      // And back, which is the same operation in the other direction.
      assert.strictEqual((await setDiscipline('animation', 'animation')).status, 200);
      assert.deepStrictEqual(await lensFor(), lensBefore, 'exactly where it was');
      assert.deepStrictEqual(await snapshot(), before, 'and still nothing written');
    });

    await t.test('a retired category still classifies the assets already filed under it', async () => {
      /* DEACTIVATING A CATEGORY TIDIES THE DROPDOWN. It must not move anybody's
         work: every asset already filed against it still HOLDS it, and the
         reference mirror is read with includeInactive for exactly this reason.
         The failure this guards is silent — the assets would quietly drift to
         Art and nothing would say why. */
      const lensBefore = await lensFor();
      const off = await as('root', '/reference/categories/fx_animation',
        { method: 'PATCH', body: { isActive: false } });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assert.ok(!(await as('root', '/reference/categories')).body.entries
        .some((e) => e.key === 'fx_animation'), 'gone from the dropdown');

      assert.deepStrictEqual(await lensFor(), lensBefore,
        'and nobody\'s work moved tab because the list was tidied');
      assert.strictEqual((await as('root', '/reference/categories/fx_animation',
        { method: 'PATCH', body: { isActive: true } })).status, 200);
    });

    await t.test('it needs the permission that already manages this list, and nothing new', async () => {
      /* NO NEW KEY. Whoever can rename a category can say which tab its assets
         appear under: it is the same screen, the same list and the same
         decision, and a second key beside it is a key somebody grants and then
         wonders why half the screen is still refused. */
      const refused = await setDiscipline('animation', 'art', 'ana');
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      const unchanged = (await as('root', '/reference/categories')).body.entries
        .find((e) => e.key === 'animation');
      assert.strictEqual(unchanged.discipline, 'animation', 'and nothing changed');

      await grant('team_lead', ['settings.categories']);
      const allowed = await setDiscipline('characters', 'animation', 'lee');
      assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
      assert.strictEqual((await setDiscipline('characters', 'art', 'lee')).body.entry.discipline, 'art');
    });

    await t.test('the change is recorded, and a save that changes nothing is not', async () => {
      const lines = () => q(
        `SELECT action, entity_label, summary, changes FROM activity_log
          WHERE action = 'settings.categories.discipline' ORDER BY created_at, id`);
      const before = (await lines()).length;

      assert.strictEqual((await setDiscipline('props', 'animation')).status, 200);
      const after = await lines();
      assert.strictEqual(after.length, before + 1, 'one line for one move');
      /* FOUND BY ITS LABEL, NOT BY BEING LAST. activity_log.created_at is
         second-granular and the id is a random uuid, so two lines written in
         the same second have no reliable order — asserting on "the latest row"
         is a test that passes until the machine is fast enough to write the
         previous subtest's line in the same second as this one. It did. */
      const row = after.find((r) => r.entity_label === 'Props');
      assert.ok(row, `the Props move was recorded: ${JSON.stringify(after)}`);
      assert.match(row.summary, /Assets in the "Props" category now count as Animation \(was Art\)/);
      const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;
      assert.deepStrictEqual(changes, { discipline: { from: 'art', to: 'animation' } });

      /* A SAVE THAT CHANGES NOTHING IS NOT AN EVENT. The Settings screen sends
         the whole row on some saves, and a log line per recolour would bury the
         one that matters. */
      assert.strictEqual((await setDiscipline('props', 'animation')).status, 200);
      assert.strictEqual((await lines()).length, before + 1, 'and re-sending the same value is not');

      /* NOR IS A RENAME, which changes a word and moves nobody's work. */
      assert.strictEqual((await as('root', '/reference/categories/props',
        { method: 'PATCH', body: { label: 'Props & Set Dressing' } })).status, 200);
      assert.strictEqual((await lines()).length, before + 1);
      assert.strictEqual((await as('root', '/reference/categories')).body.entries
        .find((e) => e.key === 'props').discipline, 'animation',
      'and the rename left the classification alone');
      assert.strictEqual((await setDiscipline('props', 'art')).status, 200);
    });

    await t.test('the migration seeds an existing list, is idempotent, and overrules nobody', async () => {
      /* THE UPGRADE PATH, driven directly: a studio whose categories predate the
         column has them all NULL. The step classifies each by its name, exactly
         once, and never touches one again. */
      const handle = {
        async query(text, params = []) {
          const values = [];
          const translated = String(text).replace(/\$(\d+)/g, (_, n) => {
            values.push(params[Number(n) - 1]);
            return '?';
          });
          const rows = await sql(cfg, translated, values.length ? values : params);
          return { rows: Array.isArray(rows) ? rows : [], result: rows };
        },
      };
      const step = require('../src/migrate').STEPS
        .find(([name]) => name === 'asset category disciplines')[1];
      const stored = () => q('SELECT `key`, label, discipline FROM categories ORDER BY `key`');

      /* A CHOICE SOMEBODY MADE, to prove the seed cannot overrule it: Animation
         is deliberately set to Art before the column is blanked. */
      await q("UPDATE categories SET discipline = 'art' WHERE `key` = 'animation'");
      await q("UPDATE categories SET discipline = NULL WHERE `key` <> 'animation'");

      const said = [];
      await step(handle, (m) => said.push(m));
      const seeded = await stored();
      for (const row of seeded) {
        const expected = row.key === 'animation' ? 'art'
          : require('../src/asset-discipline').disciplineFromName(`${row.label} ${row.key}`);
        assert.strictEqual(row.discipline, expected,
          `${row.key} ("${row.label}") was classified ${row.discipline}`);
      }
      assert.ok(said.some((m) => /classified \d+ asset categor/.test(m)),
        `the step says what it did: ${JSON.stringify(said)}`);

      // TWICE CHANGES NOTHING, and says nothing.
      const twice = [];
      await step(handle, (m) => twice.push(m));
      assert.deepStrictEqual(await stored(), seeded, 'running it again is a no-op');
      assert.deepStrictEqual(twice, [], 'and it is silent about it');

      // Put the fixture back the way the tests above left it.
      await q("UPDATE categories SET discipline = 'animation' WHERE `key` = 'animation'");
    });

    await t.test('nothing moves for a studio that has classified nothing', async () => {
      /* THE DEPLOY-DAY PROMISE, against a real board: with every category on
         the Art side, the lens classifies exactly as the old type-only rule
         did. Compared against that rule written out, over every asset in the
         fixture, rather than against a handful of codes. */
      const before = (a) => (String((a && a.type) || '').trim().toLowerCase() === 'animation'
        ? 'animation' : 'art');
      const was = (await as('root', '/reference/categories')).body.entries
        .map((e) => [e.key, e.discipline]);
      for (const [key] of was) await setDiscipline(key, 'art');

      const lens = await lensFor();
      const assets = (await as('root', `/assets/project/${projectId}`)).body.assets;
      assert.ok(assets.length >= 6, 'there are assets to compare');
      for (const a of assets) {
        const now = lens.animation.includes(a.code) ? 'animation' : 'art';
        assert.strictEqual(now, before(a),
          `${a.code} (type ${a.type}, category ${a.category}) must land where it always did`);
      }

      for (const [key, value] of was) await setDiscipline(key, value);
    });
  });
