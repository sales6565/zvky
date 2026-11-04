/* ONE RULE FOR WHAT AN ASSET MAY BE CALLED — asserted from both ends.
 *
 * Prompt 63 added a way to rename an asset, and the one thing a rename must not
 * do is accept or refuse a name differently from creation. Before this, three
 * places held the rule and no two of them agreed:
 *
 *   src/routes/assets.js   trim, required. NO ceiling, so a 256-character name
 *                          was a MySQL error — a 500 on a typo.
 *   src/asset-import.js    trim, required, 255.
 *   public/index.html      trim, required. No ceiling.
 *
 * All three now ask src/asset-name.js. This file is what stops them drifting
 * apart again: the module's own table of inputs, the page's copy of the rule
 * compared with the module's CHARACTER FOR CHARACTER, and structural pins on
 * the two server callers so neither can grow a second validator.
 *
 * It also pins the one rule people will assume is here and is not: there is NO
 * uniqueness check, in any of the three, and the rename therefore has none
 * either. See the module's header for why that is the rule rather than a gap.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const assetName = require('../src/asset-name');
const assetImport = require('../src/asset-import');
const catalog = require('../src/permission-catalog');
const roles = require('../src/roles');
const assetSettings = require('../src/asset-settings');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CREATE = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'assets.js'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'asset-name.js'), 'utf8');

/* ---- the rule itself ---------------------------------------------------- */

test('the validator, over every shape of input the studio will type', () => {
  const cases = [
    // [input, ok, normalised value or null, code]
    ['Hero', true, 'Hero', null],
    // Empty, in all the ways a form can be empty.
    ['', false, '', 'required'],
    ['   ', false, '', 'required'],
    ['\t\n', false, '', 'required'],
    [null, false, '', 'required'],
    [undefined, false, '', 'required'],
    // A name made of nothing but control characters is an empty name.
    ['\u0001\u0002', false, '', 'required'],
    // Leading and trailing space, which is what a paste brings with it.
    ['  Hero  ', true, 'Hero', null],
    // Inner runs collapse — including the non-breaking space a document paste
    // carries, which looks identical on screen and is not the same character.
    ['Hero    Pose', true, 'Hero Pose', null],
    ['Hero  Pose', true, 'Hero Pose', null],
    // A line break or a tab is a word boundary, so it becomes a space rather
    // than disappearing and welding the two words together.
    ['Hero\tPose', true, 'Hero Pose', null],
    ['Hero\nPose', true, 'Hero Pose', null],
    ['Hero\r\nPose', true, 'Hero Pose', null],
    // Any other control character is dropped outright: there is no boundary
    // there to keep, and it only makes two identical-looking names differ.
    ['He\u0001ro', true, 'Hero', null],
    ['Hero\u007f', true, 'Hero', null],
    // Unicode is a name like any other. Nothing here transliterates, strips an
    // accent or refuses a script — an asset called 水の精 is an asset.
    ['水の精', true, '水の精', null],
    ['Søren’s Cart', true, 'Søren’s Cart', null],
    ['Émile — Hero', true, 'Émile — Hero', null],
    ['🦊 Fox', true, '🦊 Fox', null],
    // The ceiling is the column's width, and it is measured AFTER normalising:
    // 255 characters plus a trailing space is a 255-character name.
    ['x'.repeat(255), true, 'x'.repeat(255), null],
    [`${'x'.repeat(255)} `, true, 'x'.repeat(255), null],
    ['x'.repeat(256), false, 'x'.repeat(256), 'too_long'],
    // Punctuation, slashes and quotes are all allowed: there is no character
    // class rule, and inventing one would refuse names studios already use.
    ['FX / Water (v2) "final"', true, 'FX / Water (v2) "final"', null],
    ['../../etc/passwd', true, '../../etc/passwd', null],
  ];
  for (const [input, ok, value, code] of cases) {
    const verdict = assetName.validate(input);
    const label = JSON.stringify(input);
    assert.strictEqual(verdict.ok, ok, `${label} → ok ${ok}`);
    assert.strictEqual(verdict.value, value, `${label} → ${JSON.stringify(value)}`);
    assert.strictEqual(verdict.code, code, `${label} → code ${code}`);
    if (!ok) {
      assert.strictEqual(verdict.field, 'name');
      assert.strictEqual(verdict.message,
        code === 'required' ? assetName.MESSAGES.required : assetName.MESSAGES.tooLong);
    }
  }
});

test('a name that is already normalised comes back unchanged, twice', () => {
  // Normalisation is idempotent, which is what makes "the stored name equals
  // the normalised input" a safe no-op test rather than a race.
  for (const input of ['Hero', 'Hero Pose', '水の精', 'x'.repeat(255)]) {
    const once = assetName.normalise(input);
    assert.strictEqual(once, input);
    assert.strictEqual(assetName.normalise(once), once);
  }
});

/* ---- no uniqueness, and that is the rule ------------------------------- */

test('nothing anywhere makes an asset name unique', () => {
  /* THE DATABASE. assets has no unique key on `name`, in the file a fresh
     installation is built from. If one is ever added, this test fails and
     whoever added it has to decide what happens to the duplicate rows already
     in every deployment — which is the conversation this assertion exists to
     force. */
  const table = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS assets ('));
  const body = table.slice(0, table.indexOf('ENGINE=InnoDB'));
  assert.ok(!/UNIQUE/i.test(body), 'assets has no UNIQUE key at all, let alone on the name');

  /* THE MODULE. check() takes one argument and reaches no database: it cannot
     be asking about other rows. */
  assert.strictEqual(assetName.check.length, 1);
  assert.ok(!/SELECT|db\.query|require\('\.\/db'\)/.test(MODULE_SRC),
    'src/asset-name.js never reads the database, so it cannot be checking for duplicates');

  /* THE CREATE ROUTE. Between the permission gate and the INSERT there is no
     query against `name` — which is what "creation does not refuse a duplicate"
     means in the code. */
  const from = CREATE.indexOf("router.post('/project/:projectId'");
  const to = CREATE.indexOf('res.status(201).json({ asset: withDetails });', from);
  assert.ok(from !== -1 && to > from);
  const create = CREATE.slice(from, to);
  assert.ok(!/FROM assets WHERE[^$]*`name`/.test(create),
    'creating an asset runs no duplicate-name query');

  /* AND THE RENAME DOES THE SAME. The one thing it may not do is be stricter
     than creation: a studio with two assets already called the same thing would
     otherwise find one of them unrenameable for ever. */
  const rFrom = CREATE.indexOf("router.patch('/:id/name'");
  const rTo = CREATE.indexOf('async function lastRenameOf', rFrom);
  assert.ok(rFrom !== -1 && rTo > rFrom);
  const rename = CREATE.slice(rFrom, rTo);
  assert.ok(!/already called|duplicate|ER_DUP/i.test(rename),
    'the rename has no duplicate rule either');
  assert.ok(!/SELECT[^;]*FROM assets[^;]*`name` = /.test(rename),
    'and no query looking for another asset with this name');
});

/* ---- the three callers all ask this module ----------------------------- */

test('creating an asset validates through src/asset-name.js and stores its value', () => {
  const from = CREATE.indexOf("router.post('/project/:projectId'");
  const to = CREATE.indexOf('res.status(201).json({ asset: withDetails });', from);
  const create = CREATE.slice(from, to);

  assert.match(create, /const checkedName = assetName\.validate\(name\);/,
    'the rule comes from the module');
  assert.match(create, /error: checkedName\.message, field: 'name'/,
    'and so does the sentence the create form shows');
  assert.match(create, /checkedName\.value, type, category/,
    'and the NORMALISED name is what goes in the row');
  /* The old rule, gone. `name.trim()` in the INSERT was the second validator —
     it decided what was stored while the line above decided what was accepted.
     Matched on the parameter list rather than on the call, because the comment
     above the gate quotes the old code on purpose. */
  assert.ok(!create.includes('name.trim(), type,'),
    'and the route does not normalise a second time, its own way');
  assert.strictEqual((CREATE.match(/require\('\.\.\/asset-name'\)/g) || []).length, 1);
});

test('the bulk import uses the same rule, with its own phrasing', () => {
  // The sheet's errors are printed after the column heading — "Asset Name is
  // required" — so this caller maps the module's CODE rather than printing its
  // sentence. The rule is still the module's.
  const column = assetImport.describeFormat().columns.find((c) => c.name === 'Asset Name');
  assert.ok(column && column.required, 'Asset Name is a required column');

  const rows = assetImport.validateRow({ 'Asset Name': '  Spray   FX  ', 'Scope of Work': 'prop' }, 2);
  assert.strictEqual(rows.values.name, 'Spray FX',
    'the sheet is normalised by the same function the form is');

  const empty = assetImport.validateRow({ 'Asset Name': '   ', 'Scope of Work': 'prop' }, 2);
  assert.ok(empty.errors.some((e) => /Asset Name is required/.test(e.message)), empty.errors);

  const long = assetImport.validateRow(
    { 'Asset Name': 'x'.repeat(300), 'Scope of Work': 'prop' }, 2
  );
  assert.ok(long.errors.some((e) => e.message.includes(`the limit is ${assetName.MAX_LENGTH}`)),
    long.errors);

  // A control character in a cell is cleaned rather than refused, exactly as in
  // the form — a sheet exported from another tool routinely carries one.
  const dirty = assetImport.validateRow(
    { 'Asset Name': 'Trader\u0001 Cart', 'Scope of Work': 'prop' }, 2
  );
  assert.strictEqual(dirty.values.name, 'Trader Cart');
});

/* ---- the page's copy is the module's copy ------------------------------- */

/* THE PAGE CANNOT require() ANYTHING: public/index.html is served as it is,
   with no build step, so the rule has to be written there a second time. This
   is the assertion that makes the second copy safe — every part of it compared
   with the module's source, not with a paraphrase of it. */
test('the page validates names with the module\'s rule, character for character', () => {
  const from = PAGE.indexOf('const ASSET_NAME_MAX = 255;');
  assert.ok(from !== -1, 'the page carries the rule');
  const to = PAGE.indexOf('function mayRenameAssets(', from);
  assert.ok(to > from);
  const copy = PAGE.slice(from, to);

  // The ceiling, as a number, from the module.
  assert.ok(copy.includes(`const ASSET_NAME_MAX = ${assetName.MAX_LENGTH};`),
    'the page\'s ceiling is the module\'s');

  /* THE TWO MESSAGES, character for character. The page builds the long one by
     concatenation so the number cannot be typed twice; both are compared
     against what the module would actually produce. */
  assert.ok(copy.includes(`required: '${assetName.MESSAGES.required}',`),
    `the page must carry exactly: ${assetName.MESSAGES.required}`);
  assert.ok(copy.includes("tooLong: 'An asset name can be at most ' + ASSET_NAME_MAX + ' characters.',"),
    'and build the other from the same number');
  assert.strictEqual(
    `An asset name can be at most ${assetName.MAX_LENGTH} characters.`,
    assetName.MESSAGES.tooLong,
    'which must be what the module says, word for word'
  );

  /* THE NORMALISATION, COMPARED BY RUNNING IT. The page's copy is lifted out of
     public/index.html and evaluated, then asked the same questions as the
     module over every input in the table above and a few more besides. This is
     stronger than comparing the two texts — the module names its character
     classes as constants and the page writes them inline, so the sources differ
     by design while the behaviour must not differ at all. */
  const pageRule = new Function(`${copy}\nreturn { assetNameNormalise, assetNameCheck, ASSET_NAME_MESSAGES, ASSET_NAME_MAX };`)();
  assert.strictEqual(pageRule.ASSET_NAME_MAX, assetName.MAX_LENGTH);
  assert.deepStrictEqual(pageRule.ASSET_NAME_MESSAGES, assetName.MESSAGES,
    'the page\'s two messages ARE the module\'s two messages');

  const inputs = ['Hero', '', '   ', '\t\n', '\u0001\u0002', '  Hero  ', 'Hero    Pose',
    'Hero\u00a0\u00a0Pose', 'Hero\tPose', 'Hero\nPose', 'Hero\r\nPose', 'He\u0001ro',
    'Hero\u007f', '水の精', 'Søren’s Cart', 'Émile — Hero', '🦊 Fox', 'x'.repeat(255),
    `${'x'.repeat(255)} `, 'x'.repeat(256), 'FX / Water (v2) "final"', '../../etc/passwd',
    'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u3000b', ' \u200b ', null, undefined];
  for (const input of inputs) {
    const label = JSON.stringify(input);
    assert.strictEqual(pageRule.assetNameNormalise(input), assetName.normalise(input),
      `${label} normalises the same in the page as on the server`);
    const here = pageRule.assetNameCheck(input);
    const there = assetName.validate(input);
    assert.strictEqual(here.ok, there.ok, `${label} → the same verdict`);
    assert.strictEqual(here.value, there.value, `${label} → the same value`);
    assert.strictEqual(here.code, there.code, `${label} → the same code`);
    assert.strictEqual(here.message, there.ok ? '' : there.message,
      `${label} → the same sentence, character for character`);
  }
  assert.ok(copy.includes('.trim();'), 'and both trim');

  // The order of the two refusals matters: an empty name is "required", never
  // "too long", and a 300-character name is too long rather than accepted.
  assert.ok(copy.indexOf("code:'required'") < copy.indexOf("code:'too_long'"),
    'the page asks the two questions in the module\'s order');
});

test('the page gates the control on the key and the switch, and on nothing else', () => {
  const from = PAGE.indexOf('function mayRenameAssets(');
  const to = PAGE.indexOf('const anState =', from);
  const gate = PAGE.slice(from, to);
  assert.match(gate, /state\.assetRenameEnabled !== false && can\('assets\.rename'\)/,
    'the switch and the permission, both');
  // Never a tier, never ownership, never a status. UI_GATES' rule.
  for (const forbidden of ['caps(', 'ownsAsset', 'a.status', 'tier']) {
    assert.ok(!gate.includes(forbidden), `the gate does not read ${forbidden}`);
  }
  /* And the pencil is drawn through that one predicate wherever it appears, so
     a screen cannot forget half of the condition. Three call sites: the
     function itself, the asset panel and the Assets List. */
  assert.strictEqual((PAGE.match(/nameEditPencil\(/g) || []).length, 3);
  const pencil = PAGE.slice(PAGE.indexOf('function nameEditPencil('));
  assert.match(pencil.slice(0, 400), /if\(!mayRenameAssets\(\)\) return '';/);
});

test('the modal is in the page, in-page, with the sentence about files', () => {
  assert.strictEqual((PAGE.match(/id="assetNameWrap"/g) || []).length, 1);
  assert.strictEqual((PAGE.match(/id="assetHistoryWrap"/g) || []).length, 1);
  for (const id of ['an_name', 'an_err', 'an_save', 'an_cancel', 'ah_body', 'ah_close']) {
    assert.ok(PAGE.includes(`id="${id}"`), `the modal has #${id}`);
  }
  assert.ok(PAGE.includes('Files already stored are not renamed or moved.'),
    'the note the brief asks for, in the modal');

  /* NO NATIVE DIALOGS, anywhere near this feature. The block between the rule
     and the history list is the whole of it. */
  const from = PAGE.indexOf('const ASSET_NAME_MAX = 255;');
  const to = PAGE.indexOf('/* ---------- drawer ---------- */', from);
  const block = PAGE.slice(from, to);
  for (const native of ['prompt(', 'confirm(', 'alert(']) {
    assert.ok(!block.includes(native), `no ${native} in the rename feature`);
  }
  // Save is disabled while the name is invalid OR unchanged.
  assert.match(block, /save\.disabled = Boolean\(anState\.busy \|\| !verdict\.ok \|\| verdict\.value === anState\.current\)/);
  // The conflict is shown in the modal, with the offer to reload.
  assert.match(block, /body\.code === 'name_changed'/);
  assert.match(block, /an_reload/);
});

/* ---- the route, structurally ------------------------------------------- */

test('the rename writes the name and its history in one transaction, and nothing else', () => {
  const from = CREATE.indexOf("router.patch('/:id/name'");
  const to = CREATE.indexOf('async function lastRenameOf', from);
  const route = CREATE.slice(from, to);

  // ONE transaction, both writes inside it.
  const begin = route.indexOf("await conn.query('BEGIN')");
  const commit = route.indexOf("await conn.query('COMMIT')");
  assert.ok(begin !== -1 && commit > begin, 'there is a transaction');
  const inside = route.slice(begin, commit);
  assert.match(inside, /UPDATE assets SET `name`/, 'the name is written inside it');
  assert.match(inside, /INSERT INTO asset_name_history/, 'and so is the history row');
  assert.match(route, /ROLLBACK/, 'and it rolls back');

  /* THE ONLY UPDATE IN THE WHOLE ROUTE IS TO assets.name. This is the
     assertion that keeps "historical text keeps the old name" true: nothing
     here rewrites an activity_log label, a chat message, an email body or an
     integration payload. */
  const updates = route.match(/UPDATE [a-z_]+ SET/g) || [];
  assert.deepStrictEqual(updates, ['UPDATE assets SET'], 'one UPDATE, to one table');
  const inserts = route.match(/INSERT INTO [a-z_]+/g) || [];
  assert.deepStrictEqual(inserts, ['INSERT INTO asset_name_history']);

  // NOTHING ON DISK. No file module, no gateway call, no path arithmetic.
  for (const forbidden of ['fs.', 'path.join', 'serverPaths', 'serverLink', 'gateway', 'unlink']) {
    assert.ok(!route.includes(forbidden), `the rename never touches ${forbidden}`);
  }

  // The gates, in order: the key on the route, the switch, the asset, scope.
  assert.match(route, /requirePermission\('assets\.rename'\)/);
  assert.match(route, /assetSettings\.renameEnabled\(\)/);
  assert.match(route, /canViewAsset\(req\.user, asset\)/);
  assert.ok(route.indexOf('renameEnabled()') < route.indexOf('assetName.validate'),
    'the switch is asked before the name is even looked at');

  /* THE CURRENT NAME IS READ UNDER A ROW LOCK, INSIDE THE TRANSACTION. Written
     the obvious way first — compare the name read at the top of the handler —
     and the concurrency test failed on the first run: two simultaneous renames
     both passed their expected_name check and wrote a history chain that did
     not join up. */
  assert.match(inside, /SELECT `name` FROM assets WHERE id = \$1 FOR UPDATE/,
    'the name the decision is made on is read under a lock');
  assert.ok(route.indexOf('FOR UPDATE') < route.indexOf('expected_name !== undefined'),
    'and the conflict check reads THAT name, not the one from the top of the handler');

  // The no-op, and the audit line.
  assert.match(route, /if \(checked\.value === currentName\)/);
  assert.match(route, /req\.activitySkip\(\)/);
  assert.match(route, /action: 'asset\.rename'/);
  // The conflict check.
  assert.match(route, /body\.expected_name !== undefined/);
  assert.match(route, /code: 'name_changed'/);
});

test('the history route is behind the same key and is not behind the switch', () => {
  const from = CREATE.indexOf("router.get('/:id/name-history'");
  assert.ok(from !== -1);
  const to = CREATE.indexOf('// DELETE /api/assets/:id', from);
  const route = CREATE.slice(from, to);
  assert.match(route, /requirePermission\('assets\.rename'\)/);
  assert.match(route, /canViewAsset\(req\.user, asset\)/);
  assert.ok(!route.includes('renameEnabled()'),
    'switching the feature off does not hide the renames already made');
});

/* ---- the key and the switch, with their defaults ----------------------- */

test('the two new permissions, and who holds them on a fresh installation', () => {
  const rename = catalog.BY_KEY.get('assets.rename');
  const manage = catalog.BY_KEY.get('settings.asset_rename');
  assert.ok(rename && manage, 'both keys are in the catalogue');
  assert.strictEqual(rename.label, 'Edit Asset Name');
  assert.strictEqual(manage.label, 'Manage Asset Name Editing');

  const holdersOf = (key) => roles.roleKeys().filter((k) => {
    const def = roles.roleDef(k);
    return def && catalog.BY_KEY.get(key).impliedBy(def);
  });

  /* THE DEFAULT IS asset.edit's DEFAULT — asserted as a set comparison rather
     than a list, so the two cannot drift apart without this failing. "Nobody
     gains anything on the day this ships, and nobody loses anything either." */
  assert.deepStrictEqual(holdersOf('assets.rename'), holdersOf('asset.edit'),
    'Edit Asset Name starts with exactly the designations that may edit an asset');
  assert.ok(holdersOf('assets.rename').includes('super_admin'));
  assert.ok(holdersOf('assets.rename').length > 1, 'and that is more than the Super Admin');
  // The two designations that may not edit an asset may not rename one either.
  assert.ok(!holdersOf('assets.rename').includes('art_director'),
    'Creative Direction gives direction as feedback; it does not edit the record');
  assert.ok(!holdersOf('assets.rename').includes('mis_analyst'),
    'and a designation with no pipeline access holds nothing here');

  // The switch is Super Admin alone, like every other settings.* key of its kind.
  assert.deepStrictEqual(holdersOf('settings.asset_rename'), ['super_admin']);

  // It is grouped under Assets on the Role Permissions screen.
  const group = catalog.GROUPS.find((g) => g.permissions.some((p) => p.key === 'assets.rename'));
  assert.strictEqual(group.key, 'assets');
  const settingsGroup = catalog.GROUPS.find((g) => g.permissions.some((p) => p.key === 'settings.asset_rename'));
  assert.strictEqual(settingsGroup.key, 'settings');
});

test('the studio switch ships on, and an absent row or table does not mean off', async () => {
  assert.strictEqual(assetSettings.DEFAULTS.renameEnabled, true);
  // Before anything has loaded — which is what a request arriving during boot
  // sees — the answer is the shipped default rather than false.
  assert.strictEqual(assetSettings.renameEnabled(), true);
  assert.strictEqual(assetSettings.summarise({ renameEnabled: true }), 'asset name editing on');
  assert.strictEqual(assetSettings.summarise({ renameEnabled: false }), 'asset name editing off');

  // A database with no table at all: still on, and marked loaded so nothing
  // retries it on every request.
  const broken = { query: async () => { throw new Error('no such table'); } };
  await assetSettings.load(broken);
  assert.strictEqual(assetSettings.renameEnabled(), true, 'an unmigrated schema is not "off"');

  // A PUT that forgot the field must not switch a feature off.
  assert.strictEqual(assetSettings.validate({}).ok, false);
  assert.strictEqual(assetSettings.validate({ renameEnabled: null }).ok, false);
  assert.strictEqual(assetSettings.validate({ renameEnabled: false }).value, false);
  assert.strictEqual(assetSettings.validate({ renameEnabled: true }).value, true);
  assert.strictEqual(assetSettings.validate({ renameEnabled: 'true' }).value, true);
});

test('the Settings section is listed, so the tab opens for a role granted only it', () => {
  const from = PAGE.indexOf('const SETTINGS_SECTIONS = [');
  const to = PAGE.indexOf('\n];', from);
  const list = PAGE.slice(from, to);
  assert.match(list, /permission:'settings\.asset_rename', label:'Asset Names'/);
  // And it is drawn, and its section div exists.
  assert.ok(PAGE.includes("${can('settings.asset_rename') ? '<div id=\"assetNamesSection\"></div>' : ''}"));
  assert.ok(PAGE.includes("if(can('settings.asset_rename')) renderAssetNameSettings();"));
});

test('every module that shows an asset name reads it live, by id', () => {
  /* THE SURVEY THIS FEATURE RESTS ON, pinned so it cannot quietly stop being
     true. There is NO denormalised copy of an asset's name in this schema — no
     column anywhere is called asset_name — so a rename needs to update exactly
     one row and every screen in the studio moves with it.

     The modules below are the ones that print a name. Each is asserted to get
     it from a JOIN on assets by id. The day somebody adds a `name` column to
     one of these tables for speed, this test fails and they have to come and
     put the update in the rename's transaction. */
  const joins = [
    ['src/routes/timesheets.js', /a\.\\`name\\` AS assetName/, /LEFT JOIN assets\s+a ON a\.id = e\.asset_id/,
      'the timesheet lines list'],
    ['src/timesheet-export.js', /a\.\\`name\\`\s+AS assetName/, /LEFT JOIN assets\s+a ON a\.id = e\.asset_id/,
      'the timesheet download'],
    ['src/artist-report.js', /a\.\\`name\\` AS assetName/, /JOIN assets\s+a/, 'the Artist Report'],
    ['src/outsource.js', /s\.\\`name\\` AS asset_name/, /JOIN assets\s+s ON s\.id = a\.asset_id/,
      'the Outsource and delivery screens'],
    ['src/notifications.js', /a\.\\`name\\` AS asset_name/, /LEFT JOIN assets a ON a\.id = n\.asset_id/,
      'the notification bell'],
    /* THE ADMIN DASHBOARD's "work waiting on this person" panel, which is the
       one dashboard that names assets rather than counting them. */
    ['src/waiting-work.js', /SELECT a\.id, a\.\\`code\\`, a\.\\`name\\`/, /FROM assets a/,
      'the Admin Dashboard\'s waiting-work panel'],
  ];
  for (const [file, select, join, what] of joins) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, select, `${what} selects the name`);
    assert.match(source, join, `${what} joins assets by id to get it`);
  }

  /* THE BOARD, THE ASSETS LIST AND THE DRAWER are one query, and it is
     `SELECT a.*` — so the name on a card is the name in the row, always. */
  assert.match(CREATE, /const ASSET_SELECT = `SELECT a\.\*,/);

  /* AND THE HEADER'S SEARCH filters the rows the board already has, in the
     browser. There is no search index to keep in step. */
  assert.match(PAGE, /pool = pool\.filter\(a=>a\.name\.toLowerCase\(\)\.includes\(q\)\|\|a\.code\.toLowerCase\(\)\.includes\(q\)\)/);

  /* THE ONE PLACE A NAME IS COPIED rather than read: activity_log.entity_label,
     which is a SNAPSHOT column by design — src/activity.js says so — and the
     integration event payloads in src/feedback-lifecycle.js, which are records
     of a moment that has already been sent. Both keep the old name, which is
     what "historical text stays as it was written" means. Asserted here so the
     two are named rather than discovered. */
  const activity = fs.readFileSync(path.join(ROOT, 'src', 'activity.js'), 'utf8');
  assert.match(activity, /entry\.entityLabel \? String\(entry\.entityLabel\)\.slice\(0, 255\) : null/,
    'the label is whatever the route passed, stored as given');
  const lifecycle = fs.readFileSync(path.join(ROOT, 'src', 'feedback-lifecycle.js'), 'utf8');
  assert.match(lifecycle, /assetName: asset\.name \|\| null/,
    'an integration event carries the name it was raised with');
});

test('no asset name appears in any stored path, which is why nothing is moved', () => {
  /* THE SURVEY, PINNED. An upload's path is project folder / discipline /
     person / subpath — see uploadPathFor in src/server-link.js — and a local
     upload is a uuid plus the extension. No part of either is an asset's name,
     which is what makes "renaming never touches a file" a fact about the
     layout rather than a promise about this route. */
  const link = fs.readFileSync(path.join(ROOT, 'src', 'server-link.js'), 'utf8');
  const from = link.indexOf('function uploadPathFor(');
  const body = link.slice(from, link.indexOf('\n}', from));
  assert.match(body, /const segments = \[base, disciplineFolder\(disciplineId, discipline\), userFolder\]/,
    'the path is built from the project, the discipline and the person');
  assert.ok(!/asset/i.test(body.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and from nothing about the asset at all');

  const upload = fs.readFileSync(path.join(ROOT, 'src', 'upload.js'), 'utf8');
  assert.match(upload, /cb\(null, `\$\{uuid\(\)\}\$\{ext\}`\)/,
    'a stored file is named by a uuid, never by anything a person typed');
});
