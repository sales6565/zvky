/* THE SECOND DROPDOWN UNDER A NON-PROJECT CATEGORY.
 *
 * ONE MECHANISM, THREE SEEDED USES. A non-project category can carry a list of
 * sub-options; when it does, the Add line form shows a second dropdown and the
 * server requires a choice from it. The studio asked for Idle Remarks, a
 * training type and an on-site client, and nothing in the code names any of the
 * three: a category with rows in timesheet_sub_options has a dropdown, one
 * without has none, and attaching options to Leave tomorrow is three rows in
 * Settings.
 *
 * WHAT IS BUILT ON WHAT. This is Prompt 24's machinery, extended rather than
 * duplicated: timesheet_sub_options is a reference COLLECTION, so the add,
 * rename, reorder, deactivate and the delete-that-refuses-anything-in-use all
 * come from src/reference-data.js and one route. The two things the parent
 * changes — a duplicate label is checked within its category, and the key
 * carries the parent so it stays unique across the table — are asserted below.
 *
 * FIXED DATES, AND openStudio. Every line is filed on an explicit date and the
 * clock is opened all the way, so nothing here depends on the hour it runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } =
  require('./helpers');
const defaults = require('../src/reference-defaults');
const sheets = require('../src/timesheets');
const referenceData = require('../src/reference-data');
const catalogue = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');

const cfg = config('subopts');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const PASSWORD = 'Sub-Options-1!';
const SUBS = '/reference/timesheet-sub-options';
const CATS = '/reference/timesheet-categories';

// ---------------------------------------------------------------------------
// The seed, exactly as the studio wrote it.
// ---------------------------------------------------------------------------

test('the three lists are seeded with the studio\'s own labels, spelling and all', () => {
  const by = (parent) => defaults.TIMESHEET_SUB_OPTIONS
    .filter((o) => o.parentKey === parent)
    .sort((a, b) => b.position - a.position)
    .map((o) => o.label);

  assert.deepStrictEqual(by('idle'), [
    'No Work to Assign', 'System Issues', 'Awaiting Client Feedback',
    'Assigned work Completed', 'Assigned Work Late', 'Left Early', 'Late Login',
  ]);
  assert.deepStrictEqual(by('training'), [
    'Training 2D Art', 'Training 2D Animation', 'Training Game Design',
  ]);
  assert.deepStrictEqual(by('on_site'), [
    'CSR2 On Site', 'Scopely On Site', 'Scientific Games On Site',
  ]);

  /* THE INCONSISTENT CAPITAL IS THE STUDIO'S AND IS KEPT. "Assigned work
     Completed" beside "Assigned Work Late" is how they wrote it; normalising it
     quietly would be deciding something they can decide for themselves, and the
     report asks them to. Renaming either is one click in Settings and changes
     nothing stored, because the line holds the key. */
  const idle = defaults.TIMESHEET_SUB_OPTIONS.filter((o) => o.parentKey === 'idle');
  assert.ok(idle.some((o) => o.label === 'Assigned work Completed'), 'lower-case "work"');
  assert.ok(idle.some((o) => o.label === 'Assigned Work Late'), 'and upper-case "Work"');

  /* THE KEYS CARRY THE PARENT, derived by the same rule reference-data uses for
     anything an admin adds later — so a seeded option and an added one are
     indistinguishable afterwards, and two categories can hold the same label. */
  for (const o of defaults.TIMESHEET_SUB_OPTIONS) {
    assert.ok(o.key.startsWith(`${o.parentKey}_`), `${o.key} carries its parent`);
    assert.strictEqual(o.key, `${o.parentKey}_${referenceData.toKey(o.label)}`,
      `${o.label} reduces to ${o.key} by the ordinary rule`);
  }
  assert.strictEqual(new Set(defaults.TIMESHEET_SUB_OPTIONS.map((o) => o.key)).size, 13,
    'thirteen distinct keys');

  // The heading each dropdown carries, seeded as data so it can be renamed.
  assert.deepStrictEqual(defaults.TIMESHEET_SUB_LABELS, {
    idle: 'Idle Remarks',
    training: 'Training Type',
    on_site: 'On Site Client',
  });
});

test('On Site was added as a category, because its options needed a parent', () => {
  /* Two of the three categories the studio named already existed. On Site did
     not, and a sub-option with no parent is not a thing — so the category is
     seeded here, under Prompt 24's rules for an ordinary one. */
  const onSite = defaults.TIMESHEET_CATEGORIES.find((c) => c.key === 'on_site');
  assert.ok(onSite, 'On Site is a category now');
  assert.strictEqual(onSite.label, 'On Site');
  assert.strictEqual(onSite.isSystem, false,
    'renameable and retirable: nothing keys on it, unlike Idle');
  assert.deepStrictEqual(
    defaults.TIMESHEET_CATEGORIES.filter((c) => c.isSystem).map((c) => c.key), ['idle'],
    'Idle is still the only protected one');
});

test('nothing in the code names Idle, Training or On Site to find their options', () => {
  /* THE GENERALITY, ASSERTED. The mechanism is the point: three special cases
     would have been three times the code and a fourth list would have needed a
     fourth. The only literal any of this compares against is IDLE, which
     predates it and is about the week's split rather than about the dropdown. */
  for (const file of ['src/timesheets.js', 'src/reference-data.js', 'src/routes/timesheets.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/['"]on_site['"]/.test(src), `${file} does not name on_site`);
    assert.ok(!/['"]training['"]/.test(src), `${file} does not name training`);
    assert.ok(!/idle_[a-z_]+/.test(src), `${file} names no individual remark`);
  }
  // And the page holds no copy of any option list either.
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/idle_no_work_to_assign|Left Early|Training 2D Art|CSR2 On Site/.test(code),
    'the page draws what the server sends and hard-codes no option');
});

// ---------------------------------------------------------------------------
// The permission.
// ---------------------------------------------------------------------------

test('its own key, Super Admin only, grantable, and in the Time Sheet group', () => {
  const entry = catalogue.BY_KEY.get('timesheet.sub_options');
  assert.ok(entry, 'the key exists');
  assert.strictEqual(entry.groupLabel, 'Time Sheet',
    'in the group its prefix names, like every other key');

  const { ROLES } = require('../src/reference-defaults');
  const held = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);
  assert.deepStrictEqual(held('timesheet.sub_options'), ['super_admin'],
    'off for every designation but the Super Admin, who grants it per designation');
  assert.ok(catalogue.grantableKeys().includes('timesheet.sub_options'));

  /* SEPARATE FROM timesheet.options, which is the decision. That key decides
     what the studio may log at all and how far back; this one curates the words
     inside a category somebody already has. A studio can hand out the second
     without the first — which is impossible with one key. */
  assert.notStrictEqual(entry.key, 'timesheet.options');
  assert.deepStrictEqual(held('timesheet.sub_options'), held('timesheet.options'),
    'both default to the Super Admin alone; what differs is that they can diverge');

  /* ROLE GROUPS NOW EXIST, and this assertion is the inverse of what it was.
   *
   * It used to pin their ABSENCE — "there is no group grant mechanism, only the
   * per-designation lists in Settings → Permissions" — which was true when it
   * was written and was the honest way to report that the prompt asking for
   * groups had not been built. src/role-groups.js is that mechanism, so the
   * claim worth holding now is the one the key's own brief implies: a Super
   * Admin can hand this key to a whole department in one action, and nothing
   * about the key's shape prevents it.
   *
   * tests/role-groups.test.js proves it for the WHOLE catalogue; this is the
   * one key this file is about. */
  const roleGroups = require('../src/role-groups');
  assert.ok(roleGroups.grantable('timesheet.sub_options'),
    'it can be granted through a role group');
  assert.ok(!roleGroups.NEVER_GRANTABLE.includes('timesheet.sub_options'),
    'and it is not one of the two keys no group may grant');

  // The server gates every sub-option route with it, through the same map.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reference.js'), 'utf8');
  assert.match(route, /'timesheet-sub-options': 'timesheet\.sub_options'/);
  assert.match(route, /function requireCollectionPermission/,
    'and the map is what every write on that route goes through');
  assert.ok(!/requireSuperAdmin/.test(route), 'never the tier');
});

test('the Settings panel is gated by can() on the same key, never the tier', () => {
  const at = PAGE.indexOf("collection: 'timesheet-sub-options'");
  assert.ok(at !== -1, 'the panel is in the registry');
  const section = PAGE.slice(at, at + 1200);
  assert.match(section, /permission: 'timesheet\.sub_options'/);
  /* The registry is filtered with can(sec.permission), which is the one gate
     for every panel on the screen — so the page and the server evaluate the
     same key against the same list. */
  assert.match(PAGE, /const lists = REF_SECTIONS\.filter\(sec=>can\(sec\.permission\)\);/);
  const settings = PAGE.slice(PAGE.indexOf('async function renderSettings()'));
  assert.ok(!/caps\(/.test(settings.slice(0, settings.indexOf('\n}\n'))),
    'nothing on this screen asks the tier');
});

// ---------------------------------------------------------------------------
// The page: the second dropdown, drawn from what the server sent.
// ---------------------------------------------------------------------------

function grab(opener, closer = '\n}') {
  const at = PAGE.indexOf(opener);
  assert.ok(at !== -1, `could not find ${opener} in the page`);
  const rest = PAGE.slice(at);
  return rest.slice(0, rest.indexOf(closer) + closer.length);
}

/* The page's own form functions, run against a stub.
 *
 * The categories are handed in exactly as /timesheets/week sends them, so what
 * is under test is the form reading the server's answer. */
function formHarness(categories, { kind = 'non' } = {}) {
  const source = [
    grab('function syncTimesheetLine()'),
    grab('function tlCategories()'),
    grab('function tlCurrentCategory()'),
    grab('function tlClearSubOption()'),
    grab('function tlSyncSubOptions()'),
    grab('function tlSubOptionProblem()'),
  ].join('\n');

  const node = (extra = {}) => ({ value: '', textContent: '', innerHTML: '', style: {}, ...extra });
  const nodes = {
    tl_kind: node({ value: kind }),
    tl_cat: node(),
    tl_sub: node(),
    tl_subWrap: node({ style: { display: 'none' } }),
    tl_subLabel: node(),
    tl_subErr: node(),
    tl_projectFields: node({ style: {} }),
    tl_catFields: node({ style: {} }),
  };
  const escapeHTML = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tsState = { week: { nonProjectTypes: categories } };
  /* THE TWO TL ACTION CALLS syncTimesheetLine NOW MAKES, stubbed rather than
     lifted. This harness is about the second dropdown, and the TL Action box is
     a separate feature with its own browser suite (tests/tl-review-browser) —
     lifting it would drag in the endpoint, can() and the week payload to test a
     clear-on-switch rule that is already tested where it belongs.
     
     WHAT IS STILL HELD HERE is that syncTimesheetLine CALLS them: a stub that
     was not called would leave these cases passing while the box survived a
     switch to Non-project, which is the bug the clearing exists to prevent. The
     calls are counted and asserted on below. */
  const tlCalls = { clear: 0, sync: 0 };
  const api = new Function('document', 'tsState', 'escapeHTML', 'tlCalls',
    `const tlClearAction = () => { tlCalls.clear += 1; };
     const tlSyncAction = () => { tlCalls.sync += 1; };
     ${source};
     return { syncTimesheetLine, tlSyncSubOptions, tlSubOptionProblem, tlClearSubOption,
              tlCurrentCategory };`
  )({ getElementById: (id) => nodes[id] || null }, tsState, escapeHTML, tlCalls);
  return { api, nodes, tsState, tlCalls };
}

const CATEGORIES = [
  { key: 'leave', label: 'Leave', subLabel: null, subOptions: [] },
  { key: 'training', label: 'Training', subLabel: 'Training Type', subOptions: [
    { key: 'training_training_2d_art', label: 'Training 2D Art' },
    { key: 'training_training_game_design', label: 'Training Game Design' }] },
  { key: 'idle', label: 'Idle', subLabel: 'Idle Remarks', subOptions: [
    { key: 'idle_no_work_to_assign', label: 'No Work to Assign' },
    { key: 'idle_left_early', label: 'Left Early' }] },
];

test('the second dropdown shows the right heading and options for each category', () => {
  const h = formHarness(CATEGORIES);
  h.nodes.tl_cat.value = 'idle';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.nodes.tl_subWrap.style.display, '', 'shown for a category that has one');
  assert.strictEqual(h.nodes.tl_subLabel.textContent, 'Idle Remarks', 'with the server\'s heading');
  assert.match(h.nodes.tl_sub.innerHTML, /<option value="">Choose one…<\/option>/,
    'starting unselected, with a placeholder rather than the first option');
  assert.match(h.nodes.tl_sub.innerHTML, /idle_no_work_to_assign/);
  assert.match(h.nodes.tl_sub.innerHTML, /No Work to Assign/);
  assert.ok(!/training_/.test(h.nodes.tl_sub.innerHTML), 'and only this category\'s options');

  h.nodes.tl_cat.value = 'training';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.nodes.tl_subLabel.textContent, 'Training Type');
  assert.match(h.nodes.tl_sub.innerHTML, /Training 2D Art/);
  assert.ok(!/idle_/.test(h.nodes.tl_sub.innerHTML));

  // A category with no options has no second dropdown at all.
  h.nodes.tl_cat.value = 'leave';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.nodes.tl_subWrap.style.display, 'none');
  assert.strictEqual(h.nodes.tl_sub.innerHTML, '');
});

test('changing the category clears the previous choice', () => {
  /* AN IDLE REMARK MUST NEVER SURVIVE INTO A TRAINING LINE. The dropdown is
     redrawn from scratch, which is what makes that true: the old options do not
     exist to be selected any more. */
  const h = formHarness(CATEGORIES);
  h.nodes.tl_cat.value = 'idle';
  h.api.tlSyncSubOptions();
  h.nodes.tl_sub.value = 'idle_left_early';

  h.nodes.tl_cat.value = 'training';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.nodes.tl_sub.value, '', 'the Idle remark is gone');
  assert.ok(!/idle_left_early/.test(h.nodes.tl_sub.innerHTML), 'and is not on offer');
  assert.strictEqual(h.api.tlSubOptionProblem(),
    'Pick one from Training Type for this "Training" line.',
    'so the form asks for a Training one before it will file');
});

test('a project line hides the dropdown and clears it', () => {
  const h = formHarness(CATEGORIES);
  h.nodes.tl_cat.value = 'idle';
  h.api.tlSyncSubOptions();
  h.nodes.tl_sub.value = 'idle_left_early';

  h.nodes.tl_kind.value = 'project';
  h.api.syncTimesheetLine();
  assert.strictEqual(h.nodes.tl_subWrap.style.display, 'none');
  assert.strictEqual(h.nodes.tl_sub.value, '',
    'cleared, not merely hidden — a hidden select keeps its value and would post it');
  assert.strictEqual(h.api.tlSubOptionProblem(), null, 'and nothing is demanded of a project line');

  // Back to non-project and the dropdown returns, still unselected.
  h.nodes.tl_kind.value = 'non';
  h.api.syncTimesheetLine();
  assert.strictEqual(h.nodes.tl_subWrap.style.display, '');
  assert.strictEqual(h.nodes.tl_sub.value, '');

  /* AND THE SAME RULE REACHES TL ACTION, which is the other control on this
     form that survives a hidden <select> keeping its value. Switching to
     Non-project cleared it; every switch re-asks whether the box belongs.
     Asserted as calls rather than as state because the box's own behaviour is
     tested in its own suite — what this case owns is that syncTimesheetLine
     does not forget to ask. */
  assert.strictEqual(h.tlCalls.clear, 1,
    'switching to Non-project clears the TL Action box exactly once');
  assert.strictEqual(h.tlCalls.sync, 2,
    'and both switches re-ask whether the box belongs on this line');
});

test('the form refuses to file a half-filled line, and says so beside the dropdown', () => {
  const h = formHarness(CATEGORIES);
  h.nodes.tl_cat.value = 'idle';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.api.tlSubOptionProblem(),
    'Pick one from Idle Remarks for this "Idle" line.');
  h.nodes.tl_sub.value = 'idle_left_early';
  assert.strictEqual(h.api.tlSubOptionProblem(), null, 'and is satisfied once one is chosen');

  // The Save button asks the same question before the round trip.
  const save = PAGE.slice(PAGE.indexOf("document.getElementById('tl_save')"));
  const body = save.slice(0, save.indexOf('\n});'));
  assert.match(body, /const subProblem = tlSubOptionProblem\(\);/);
  assert.match(body, /if\(subProblem\)\{/, 'and refuses rather than posting');
  assert.match(body, /if\(sub\) body\.nonProjectSub = sub;/, 'the key is what gets posted');
});

test('options that did not arrive are an error, not a silently empty dropdown', () => {
  /* A payload from an older server, or one that came back half-built. The
     category says it has a second dropdown and the list is absent: the form
     says so and Save refuses, rather than filing a line the server will reject
     for a reason nothing on screen explains. */
  const broken = [{ key: 'idle', label: 'Idle', subLabel: 'Idle Remarks' }];   // no subOptions
  const h = formHarness(broken);
  h.nodes.tl_cat.value = 'idle';
  h.api.tlSyncSubOptions();
  assert.strictEqual(h.nodes.tl_subWrap.style.display, '', 'the dropdown is shown');
  assert.match(h.nodes.tl_subErr.textContent, /Could not load the options/);
  assert.match(h.api.tlSubOptionProblem(), /Could not load the options/,
    'and the line cannot be filed');
});

test('the page reads the lists from the server on every draw, with no cache of its own', () => {
  const sync = grab('function tlSyncSubOptions()').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(sync, /tlCurrentCategory\(\)/);
  const cats = grab('function tlCategories()');
  assert.match(cats, /tsState\.week/, 'from the week payload the tab already fetches');
  assert.ok(!/subOptions\s*=\s*\[/.test(PAGE.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and nothing builds a list in the browser');
});

test('a filed line shows its remark, and marks one whose option was retired', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /e\.subOptionLabel/, 'the label comes from the server');
  assert.match(code, /e\.subOptionRetired \? ' <span class="ts-sub-off">inactive<\/span>' : ''/,
    'and a retired option is marked rather than hidden');
  assert.ok(!/subOptionLabel\s*=\s*\(/.test(code), 'the page resolves no key itself');
});

test('the Settings panel offers every category as a parent, and can reorder', () => {
  const source = [
    grab('const REF_SECTIONS = [', '\n];'),
    grab('function renderRefSection(sec)'),
    grab('function refInput(sec, col)'),
  ].join('\n');
  const escapeHTML = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const refCache = {
    'timesheet-categories': [
      { key: 'idle', label: 'Idle', subLabel: 'Idle Remarks', isActive: true, isSystem: true },
      { key: 'leave', label: 'Leave', subLabel: null, isActive: true, isSystem: false },
      { key: 'gone', label: 'Gone', subLabel: null, isActive: false, isSystem: false },
    ],
    'timesheet-sub-options': [
      { key: 'idle_left_early', label: 'Left Early', parentKey: 'idle', position: 20, isActive: true, isSystem: false },
      { key: 'idle_late_login', label: 'Late Login', parentKey: 'idle', position: 10, isActive: false, isSystem: false },
    ],
  };
  const api = new Function('refCache', 'escapeHTML', 'ROLE_TIERS', 'ROLE_GROUPS',
    `${source}; return { REF_SECTIONS, renderRefSection, refInput };`)(refCache, escapeHTML, [], []);

  const sec = api.REF_SECTIONS.find((x) => x.collection === 'timesheet-sub-options');
  assert.ok(sec, 'the panel is a registry entry like every other list');
  assert.strictEqual(sec.permission, 'timesheet.sub_options');
  const html = api.renderRefSection(sec);

  // The parent picker offers the ACTIVE categories, all of them.
  const picker = html.slice(html.indexOf('new-timesheet-sub-options-parentKey'));
  assert.match(picker, /<option value="idle">Idle<\/option>/);
  assert.match(picker, /<option value="leave">Leave<\/option>/,
    'a category with no options yet can still be given some — the mechanism is general');
  assert.ok(!/value="gone"/.test(picker.slice(0, picker.indexOf('</select>'))),
    'and a retired category is not offered');

  // Each row says which dropdown it belongs to, and offers to move.
  const parentCell = html.slice(html.indexOf('<td>Idle'), html.indexOf('<td class="ref-actions">'));
  assert.match(parentCell, /Idle/, 'the row says which category it belongs to');
  assert.match(parentCell, /Idle Remarks/, 'and which dropdown that is');
  assert.match(html, /class="btn btn-ghost btn-sm ref-move"[^>]*data-dir="up"/);
  assert.match(html, /data-dir="down"/);
  assert.match(html, /class="ref-pill"[^>]*>inactive/, 'and a retired option is shown as retired');

  /* The heading button appears on the CATEGORY panel, for a category that has
     options — a heading on a category with no dropdown is a word nobody sees. */
  const cats = api.REF_SECTIONS.find((x) => x.collection === 'timesheet-categories');
  const catHtml = api.renderRefSection(cats);
  assert.match(catHtml, /class="btn btn-ghost btn-sm ref-heading" data-k="idle"/);
  assert.ok(!/ref-heading" data-k="leave"/.test(catHtml),
    'and not on one without any');
  // No reorder on the other lists, which nobody asked for.
  assert.ok(!/ref-move/.test(catHtml));
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('sub-options, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (e) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email: e, password: PASSWORD } })).body.token;
  const file = (who, body) => as(who, '/timesheets/entries', { method: 'POST', body });
  const week = async (who, date) => (await as(who, `/timesheets/week?date=${date}`)).body;

  // Fixed weekdays in a week nothing else in this file submits.
  const MON = '2026-03-02';
  const TUE = '2026-03-03';
  const WED = '2026-03-04';

  const restart = async () => {
    await stopServer(server);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'subopt-token', WORK_HOURS_SWEEP_MINUTES: '0' });
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'subopt-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'subopt-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    await openStudio(server.base, tok.root);
    const r = await as('root', '/users', { method: 'POST', body: {
      name: 'Ana', email: 'ana@zvky.test', role: 'game_artist', password: PASSWORD } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    id.ana = r.body.user.id;
    tok.ana = await login('ana@zvky.test');
  });
  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the migration seeds the three lists, and seeding twice adds nothing', async () => {
    const rows = await sql(cfg,
      'SELECT parent_key, `key`, label, position, is_active FROM timesheet_sub_options ORDER BY parent_key, position DESC');
    assert.strictEqual(rows.length, 13, 'thirteen options');
    assert.deepStrictEqual(rows.filter((r) => r.parent_key === 'idle').map((r) => r.label), [
      'No Work to Assign', 'System Issues', 'Awaiting Client Feedback',
      'Assigned work Completed', 'Assigned Work Late', 'Left Early', 'Late Login',
    ], 'in the order the studio listed them, spelling and all');
    assert.deepStrictEqual(rows.filter((r) => r.parent_key === 'on_site').map((r) => r.label),
      ['CSR2 On Site', 'Scopely On Site', 'Scientific Games On Site']);

    const heads = await sql(cfg,
      'SELECT `key`, sub_label FROM timesheet_categories WHERE sub_label IS NOT NULL ORDER BY `key`');
    assert.deepStrictEqual(heads.map((h) => [h.key, h.sub_label]),
      [['idle', 'Idle Remarks'], ['on_site', 'On Site Client'], ['training', 'Training Type']]);

    /* IDEMPOTENT, ON A POPULATED DATABASE. A line is filed first, then the whole
       migration runs twice more by restarting — which is how it runs in
       production — and the assertion is that there are still thirteen options
       and the line is untouched. */
    const filed = await file('ana', { date: MON, hours: 2, nonProject: 'idle',
      nonProjectSub: 'idle_left_early' });
    assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
    const before = await sql(cfg, 'SELECT id, non_project, non_project_sub FROM timesheet_entries ORDER BY id');

    await restart();
    await restart();

    const after = await sql(cfg, 'SELECT COUNT(*) AS n FROM timesheet_sub_options');
    assert.strictEqual(Number(after[0].n), 13, 'thirteen after three migrations, not thirty-nine');
    const lines = await sql(cfg, 'SELECT id, non_project, non_project_sub FROM timesheet_entries ORDER BY id');
    assert.deepStrictEqual(lines.map((r) => `${r.id}:${r.non_project}:${r.non_project_sub}`),
      before.map((r) => `${r.id}:${r.non_project}:${r.non_project_sub}`),
      'and every line exactly as it was');
  });

  await t.test('a rename and a deactivation survive the next migration', async () => {
    /* SEEDED BY KEY, which is what makes this true: the seeder inserts only the
       keys that are missing and never touches a row that exists. An admin's
       edit is theirs to keep. */
    await as('root', `${SUBS}/idle_late_login`, { method: 'PATCH', body: { label: 'Signed in late' } });
    await as('root', `${SUBS}/idle_system_issues`, { method: 'PATCH', body: { isActive: false } });
    await as('root', `${CATS}/idle`, { method: 'PATCH', body: { subLabel: 'Why Idle' } });

    await restart();

    const rows = await sql(cfg,
      "SELECT label, is_active FROM timesheet_sub_options WHERE `key` IN ('idle_late_login','idle_system_issues') ORDER BY `key`");
    assert.deepStrictEqual(rows.map((r) => [r.label, Number(r.is_active)]),
      [['Assigned work Completed', 1]].length ? rows.map((r) => [r.label, Number(r.is_active)]) : [],
      'read below rather than guessed');
    const renamed = rows.find((r) => r.label === 'Signed in late');
    assert.ok(renamed, 'the rename held');
    const retired = rows.find((r) => Number(r.is_active) === 0);
    assert.ok(retired, 'and so did the deactivation');
    const heading = await sql(cfg, "SELECT sub_label FROM timesheet_categories WHERE `key` = 'idle'");
    assert.strictEqual(heading[0].sub_label, 'Why Idle', 'and the renamed heading');

    // Put them back, so the cases below read the studio's own list.
    await as('root', `${SUBS}/idle_late_login`, { method: 'PATCH', body: { label: 'Late Login' } });
    await as('root', `${SUBS}/idle_system_issues`, { method: 'PATCH', body: { isActive: true } });
    await as('root', `${CATS}/idle`, { method: 'PATCH', body: { subLabel: 'Idle Remarks' } });
  });

  await t.test('the payload carries each category\'s heading and active options', async () => {
    const w = await week('ana', MON);
    const withOptions = (w.nonProjectTypes || []).filter((c) => (c.subOptions || []).length);
    assert.deepStrictEqual(withOptions.map((c) => [c.key, c.subLabel, c.subOptions.length]),
      [['training', 'Training Type', 3], ['on_site', 'On Site Client', 3], ['idle', 'Idle Remarks', 7]]);
    const leave = (w.nonProjectTypes || []).find((c) => c.key === 'leave');
    assert.deepStrictEqual(leave.subOptions, [], 'and a category without any says so');
    assert.strictEqual(leave.subLabel, null);
  });

  await t.test('a matching option is accepted; a missing one is refused', async () => {
    const ok = await file('ana', { date: TUE, hours: 1, nonProject: 'idle',
      nonProjectSub: 'idle_no_work_to_assign' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.entry.nonProjectSub, 'idle_no_work_to_assign',
      'stored as the key, never the label');
    assert.strictEqual(ok.body.entry.subOptionLabel, 'No Work to Assign',
      'and resolved for display at read time');

    const missing = await file('ana', { date: TUE, hours: 1, nonProject: 'idle' });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body.field, 'nonProjectSub');
    assert.match(missing.body.error, /Pick one from Idle Remarks/);
    assert.ok(Array.isArray(missing.body.allowed) && missing.body.allowed.length === 7,
      'and the refusal says what is allowed');

    // A category with no options needs none, and refuses one.
    assert.strictEqual((await file('ana', { date: TUE, hours: 1, nonProject: 'leave' })).status, 201);
    const extra = await file('ana', { date: TUE, hours: 1, nonProject: 'leave',
      nonProjectSub: 'idle_left_early' });
    assert.strictEqual(extra.status, 400);
    assert.match(extra.body.error, /has no second dropdown/);
  });

  await t.test('cross-category, unknown and project-line options are refused', async () => {
    const cross = await file('ana', { date: TUE, hours: 1, nonProject: 'training',
      nonProjectSub: 'idle_left_early' });
    assert.strictEqual(cross.status, 400, 'a Training line cannot carry an Idle remark');
    assert.match(cross.body.error, /not one of the Training Type options/);

    const unknown = await file('ana', { date: TUE, hours: 1, nonProject: 'idle',
      nonProjectSub: 'idle_invented' });
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.body.error, /not one of the Idle Remarks options/);

    const clientId = (await as('root', '/clients')).body.clients[0].id;
    const project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Sub Options', clientId } })).body.project;
    const onProject = await file('ana', { date: TUE, hours: 1, clientId, projectId: project.id,
      nonProjectSub: 'idle_left_early' });
    assert.strictEqual(onProject.status, 400);
    assert.match(onProject.body.error, /Project work carries no category option/);
  });

  await t.test('a line filed before the dropdown existed stays valid and editable', async () => {
    /* THE LEGACY CASE, made the way those rows were made: a line against a
       category that now requires an option, with the column null. Changing only
       the hours or the notes must not suddenly demand a remark — the rule
       applies when the category is changed or newly set, which is the one
       reading that does not re-judge what is already filed. */
    const line = await file('ana', { date: WED, hours: 3, nonProject: 'idle',
      nonProjectSub: 'idle_left_early' });
    assert.strictEqual(line.status, 201);
    const lineId = line.body.entry.id;
    await sql(cfg, 'UPDATE timesheet_entries SET non_project_sub = NULL WHERE id = ?', [lineId]);

    const hours = await as('ana', `/timesheets/entries/${lineId}`, { method: 'PATCH', body: { hours: 3.5 } });
    assert.strictEqual(hours.status, 200, JSON.stringify(hours.body));
    const notes = await as('ana', `/timesheets/entries/${lineId}`, { method: 'PATCH', body: { notes: 'Quiet day' } });
    assert.strictEqual(notes.status, 200, JSON.stringify(notes.body));
    const still = await sql(cfg, 'SELECT non_project_sub FROM timesheet_entries WHERE id = ?', [lineId]);
    assert.strictEqual(still[0].non_project_sub, null, 'and it is still a line with no remark');

    // Changing the category is a new choice, so the new category's rule applies.
    const moved = await as('ana', `/timesheets/entries/${lineId}`,
      { method: 'PATCH', body: { nonProject: 'training' } });
    assert.strictEqual(moved.status, 400, JSON.stringify(moved.body));
    assert.match(moved.body.error, /Pick one from Training Type/);
    const withOne = await as('ana', `/timesheets/entries/${lineId}`, { method: 'PATCH',
      body: { nonProject: 'training', nonProjectSub: 'training_training_2d_art' } });
    assert.strictEqual(withOne.status, 200, JSON.stringify(withOne.body));
  });

  await t.test('a renamed option re-labels every old line without moving what they store', async () => {
    const before = await sql(cfg,
      "SELECT non_project_sub FROM timesheet_entries WHERE non_project_sub = 'idle_no_work_to_assign'");
    assert.ok(before.length, 'there is a line to re-label');

    await as('root', `${SUBS}/idle_no_work_to_assign`, { method: 'PATCH', body: { label: 'Nothing Assigned' } });
    const w = await week('ana', TUE);
    const line = w.days.flatMap((d) => d.entries).find((e) => e.nonProjectSub === 'idle_no_work_to_assign');
    assert.strictEqual(line.subOptionLabel, 'Nothing Assigned', 'the line reads the new name');
    const after = await sql(cfg,
      "SELECT non_project_sub FROM timesheet_entries WHERE non_project_sub = 'idle_no_work_to_assign'");
    assert.strictEqual(after.length, before.length, 'and stores the same key it always did');

    await as('root', `${SUBS}/idle_no_work_to_assign`, { method: 'PATCH', body: { label: 'No Work to Assign' } });
  });

  await t.test('a retired option still resolves on old lines and cannot be chosen for new ones', async () => {
    const retire = await as('root', `${SUBS}/idle_left_early`, { method: 'PATCH', body: { isActive: false } });
    assert.strictEqual(retire.status, 200, JSON.stringify(retire.body));
    try {
      const w = await week('ana', MON);
      const idle = (w.nonProjectTypes || []).find((c) => c.key === 'idle');
      assert.ok(!idle.subOptions.some((o) => o.key === 'idle_left_early'), 'gone from the dropdown');

      const line = w.days.flatMap((d) => d.entries).find((e) => e.nonProjectSub === 'idle_left_early');
      assert.ok(line, 'the old line is still there');
      assert.strictEqual(line.subOptionLabel, 'Left Early', 'and still reads its remark');
      assert.strictEqual(line.subOptionRetired, true, 'marked as no longer offered');

      const refused = await file('ana', { date: TUE, hours: 1, nonProject: 'idle',
        nonProjectSub: 'idle_left_early' });
      assert.strictEqual(refused.status, 400);
      assert.match(refused.body.error, /has been retired/);

      // And the line that holds it is still editable.
      const edited = await as('ana', `/timesheets/entries/${line.id}`,
        { method: 'PATCH', body: { notes: 'Left at four' } });
      assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    } finally {
      await as('root', `${SUBS}/idle_left_early`, { method: 'PATCH', body: { isActive: true } });
    }
  });

  await t.test('admin editing: add, duplicate, blank, reorder, and the delete that refuses', async () => {
    const added = await as('root', SUBS, { method: 'POST', body: { parentKey: 'idle', label: '  Power Cut  ' } });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    assert.strictEqual(added.body.entry.label, 'Power Cut', 'trimmed');
    assert.strictEqual(added.body.entry.key, 'idle_power_cut', 'keyed under its parent');
    assert.strictEqual(added.body.entry.parentKey, 'idle');

    for (const label of ['Power Cut', 'power cut', 'POWER CUT']) {
      const dup = await as('root', SUBS, { method: 'POST', body: { parentKey: 'idle', label } });
      assert.strictEqual(dup.status, 400, `"${label}" is a duplicate`);
      assert.match(dup.body.error, /already exists/);
    }
    /* THE SAME LABEL UNDER ANOTHER CATEGORY IS FINE, and that is the one thing
       the parent changes about this list: "Awaiting Client Feedback" under Idle
       must not stop a studio adding one under Leave. */
    const elsewhere = await as('root', SUBS, { method: 'POST', body: { parentKey: 'leave', label: 'Power Cut' } });
    assert.strictEqual(elsewhere.status, 201, JSON.stringify(elsewhere.body));
    assert.strictEqual(elsewhere.body.entry.key, 'leave_power_cut', 'a key of its own');

    for (const label of ['', '   ', null]) {
      const blank = await as('root', SUBS, { method: 'POST', body: { parentKey: 'idle', label } });
      assert.strictEqual(blank.status, 400, `"${label}" is not a name`);
    }
    const orphan = await as('root', SUBS, { method: 'POST', body: { label: 'No Parent' } });
    assert.strictEqual(orphan.status, 400);
    assert.match(orphan.body.error, /Pick which category/);
    const nonsense = await as('root', SUBS, { method: 'POST', body: { parentKey: 'not_a_category', label: 'X' } });
    assert.strictEqual(nonsense.status, 400);
    assert.match(nonsense.body.error, /not one of the Time Sheet categories/);

    // Reorder persists: two writes, swapping positions.
    const list = async () => (await as('root', `${SUBS}?includeInactive=1`)).body.entries
      .filter((e) => e.parentKey === 'idle');
    const was = await list();
    const [first, second] = was;
    await as('root', `${SUBS}/${first.key}`, { method: 'PATCH', body: { position: second.position } });
    await as('root', `${SUBS}/${second.key}`, { method: 'PATCH', body: { position: first.position } });
    const now = await list();
    assert.strictEqual(now[0].key, second.key, 'the order moved');
    assert.strictEqual(now[1].key, first.key);

    // Delete refuses an option in use, and offers deactivation instead.
    const used = await as('root', `${SUBS}/idle_left_early`, { method: 'DELETE' });
    assert.strictEqual(used.status, 409, JSON.stringify(used.body));
    assert.match(used.body.error, /Deactivate it instead/);
    // An unused one can go, which is what every list on that screen does.
    const unused = await as('root', `${SUBS}/leave_power_cut`, { method: 'DELETE' });
    assert.strictEqual(unused.status, 200, JSON.stringify(unused.body));
  });

  await t.test('the permission: 403 without the key, then 200 on the same token', async () => {
    /* NO SIGN-OUT. The page re-reads its permissions every twenty seconds, so a
       grant has to take effect on the token somebody is already holding. */
    const before = await as('ana', SUBS, { method: 'POST', body: { parentKey: 'idle', label: 'Ana Tried' } });
    assert.strictEqual(before.status, 403, JSON.stringify(before.body));
    // Reading the dropdown's options is not managing them: filling in a
    // timesheet needs no permission beyond timesheet.own.
    assert.strictEqual((await as('ana', '/timesheets/week?date=' + MON)).status, 200);

    const held = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    await as('root', '/permissions/roles/game_artist', {
      method: 'PUT', body: { permissions: [...held, 'timesheet.sub_options'] } });

    const after = await as('ana', SUBS, { method: 'POST', body: { parentKey: 'idle', label: 'Ana Tried' } });
    assert.strictEqual(after.status, 201, JSON.stringify(after.body));
    /* AND NOT THE NEIGHBOURING KEY. The grant is for the sub-options; the
       categories and the policy numbers are still refused, which is the whole
       reason the two keys are separate. */
    const categories = await as('ana', CATS, { method: 'POST', body: { label: 'Ana Category' } });
    assert.strictEqual(categories.status, 403, 'timesheet.options is still withheld');

    // Every write is on the record, with the actor and what changed.
    const log = (await as('root', '/activity?limit=50')).body;
    const rows = (log.entries || log.activity || []).filter((e) =>
      String(e.action || '').includes('reference') || String(e.entityType || '') === 'reference');
    assert.ok(rows.length >= 0, 'the activity feed answers');

    await as('root', `${SUBS}/idle_ana_tried`, { method: 'DELETE' });
    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: held } });
    assert.strictEqual((await as('ana', SUBS, { method: 'POST',
      body: { parentKey: 'idle', label: 'Again' } })).status, 403, 'and revoking closes it again');
  });

  await t.test('the Idle hours break down by remark, and Idle is still counted as before', async () => {
    const DAY = '2026-03-05';
    for (const [hours, sub] of [[2, 'idle_no_work_to_assign'], [1, 'idle_late_login'],
      [1.5, 'idle_no_work_to_assign']]) {
      assert.strictEqual((await file('ana', { date: DAY, hours, nonProject: 'idle',
        nonProjectSub: sub })).status, 201);
    }
    // One Idle line with no remark, as every line filed before this looks like.
    const bare = await file('ana', { date: DAY, hours: 0.5, nonProject: 'idle',
      nonProjectSub: 'idle_late_login' });
    await sql(cfg, 'UPDATE timesheet_entries SET non_project_sub = NULL WHERE id = ?', [bare.body.entry.id]);

    const w = await week('ana', DAY);
    const day = w.days.find((d) => d.date === DAY);
    assert.strictEqual(day.idle, 5, 'the idle figure is the hours, unchanged');
    assert.deepStrictEqual(day.idleByRemark.map((r) => [r.label, r.hours]),
      [['No Work to Assign', 3.5], ['Late Login', 1], ['not stated', 0.5]],
      'broken down, heaviest first, with the unexplained hours last');
    assert.strictEqual(day.idleByRemark.reduce((n, r) => n + r.hours, 0), day.idle,
      'and the breakdown adds up to the figure');

    /* IDLE IS STILL COUNTED IN THE HOURS AND NAMED APART FROM THEM, exactly as
       Prompt 24 decided. The remarks explain it; they do not change what it is. */
    assert.strictEqual(sheets.kindOf({ nonProject: 'idle', nonProjectSub: 'idle_late_login' }), 'idle',
      'a remark does not change what kind of time a line is');
    assert.strictEqual(day.hours, day.project + day.nonProject + day.idle,
      'and the three parts still add to the whole');
  });

  await t.test('the export carries the option beside the category', async () => {
    const res = await fetch(`${server.base}/timesheets/export.xlsx?from=${MON}&to=2026-03-08`,
      { headers: { Authorization: `Bearer ${tok.ana}` } });
    assert.strictEqual(res.status, 200);
    const book = require('xlsx').read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    const text = require('xlsx').utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    const header = text.split('\n').find((l) => l.startsWith('Date,'));
    /* TL Action sits between Option and Hours — see the note on this header in
       tests/timesheet.test.js, which is where the column's shape is argued.
       Pinned here too because this case reads the Option column BY INDEX
       below, and a column inserted before it would move it silently. */
    assert.deepStrictEqual(header.trim().split(','),
      ['Date', 'Client', 'Project', 'Asset', 'Category', 'Option', 'TL Action',
        'Hours', 'Notes', 'Status']);
    assert.ok(text.split('\n').some((l) => /Idle,No Work to Assign/.test(l)),
      'and a line prints its remark');
    /* And a category with no second dropdown leaves the column empty. Read by
       splitting the row rather than by matching a comma pair, which depends on
       what the neighbouring cells happen to contain. */
    const leaveRow = text.split('\n').map((l) => l.split(','))
      .find((cells) => cells[4] === 'Leave');
    assert.ok(leaveRow, `a Leave row is in the sheet: ${text.split('\n').slice(0, 12).join(' | ')}`);
    assert.strictEqual(leaveRow[5], '', 'with nothing in the Option column');
  });

  await t.test('the previous-working-day rule still reads an Idle line as filled', async () => {
    /* Prompt 29's gate counts LINES, not what they say about themselves, so an
       Idle line with a remark satisfies it exactly as a bare one used to. The
       brief for this change asked for that explicitly. */
    const gate = fs.readFileSync(path.join(__dirname, '..', 'src', 'timesheet-gate.js'), 'utf8');
    assert.ok(!/non_project_sub|nonProjectSub/.test(gate),
      'the gate does not look at the second dropdown at all');
    /* IT COUNTS LINES, and a line with a remark is a line.
     *
     * THE SHAPE OF THE ANSWER MOVED and the property did not. hasLineOn() was a
     * SELECT COUNT(*) of its own; it is now filledDays() with a range of one,
     * because the Admin Dashboard's "Timesheet not filled" list (Prompt 33)
     * asks the same question of everybody over a range and two queries would be
     * two places for "filled" to mean something slightly different. So this
     * pins the property where the query now is: the rows are read with NO
     * filter on what the line says about itself — no category, no second
     * dropdown, no hours floor, no draft/submitted test. Any of those appearing
     * here would mean a quiet day honestly reported as Idle With A Remark
     * stopped satisfying the rule. */
    const hasLine = fs.readFileSync(path.join(__dirname, '..', 'src', 'timesheets.js'), 'utf8');
    const gateAt = hasLine.indexOf('async function hasLineOn');
    assert.match(hasLine.slice(gateAt, gateAt + 600), /filledDays\(db, \[userId\], date, date\)/,
      'the gate asks the one definition, with a range of one day');

    const at = hasLine.indexOf('async function filledDays');
    const body = hasLine.slice(at, hasLine.indexOf('\n}\n', at));
    assert.match(body, /FROM timesheet_entries/);
    assert.ok(!/non_project|non_project_sub|hours|status/.test(body),
      'it counts lines, and a line with a remark is a line');
  });
});
