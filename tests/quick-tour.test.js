/* The Quick Tour, and the two things that keep it from going stale.
 *
 * This feature's whole risk is drift. A tour is written once, the app keeps
 * changing, and eighteen months later it describes a tab that has moved and
 * omits three that exist. Nothing about running it would fail — a stale tour
 * works perfectly, it just lies — so the guards have to be here.
 *
 * Two of them, and they close the loop in both directions:
 *
 *   every step names a real gate    a step pointing at a permission that no
 *                                   longer exists would silently never show
 *
 *   every gated tab has a step      adding a tab without a tour step fails the
 *                                   suite, which is what makes "add the
 *                                   permission, add the tour step" a checklist
 *                                   the build enforces rather than a habit
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/permission-catalog');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cfg = config('tour');

// The step list as the page declares it, read out of the source.
function tourSteps() {
  const block = /const TOUR_STEPS = \[([\s\S]*?)\n\];/.exec(HTML);
  assert.ok(block, 'TOUR_STEPS should be a literal array in public/index.html');
  /* Tolerates a trailing line comment after target: — the welcome step has one,
     and a regex that quietly skipped a step would make these guards under-count
     rather than fail, which is the worst way for a guard to be wrong. */
  return [...block[1].matchAll(
    /\{\s*\n\s*id: '([^']+)',\s*\n\s*target: ([^,]+),[^\n]*\n\s*gate: ([^,\n]+),/g)]
    .map((m) => ({
      id: m[1],
      target: m[2].trim() === 'null' ? null : m[2].trim().replace(/^'|',?$/g, ''),
      gate: m[3].trim() === 'null' ? null : m[3].trim().replace(/^'|',?$/g, ''),
    }));
}

// The UI_GATES table, which is the app's single answer to "may this be shown".
function uiGateKeys() {
  const block = /const UI_GATES = \{([\s\S]*?)\n\};/.exec(HTML);
  assert.ok(block, 'UI_GATES should be a literal object in public/index.html');
  return [...block[1].matchAll(/^\s{2}([A-Za-z_][\w]*):\s/gm)].map((m) => m[1]);
}

test('every tour step is gated by a real UI_GATES entry', () => {
  const steps = tourSteps();
  const gates = new Set(uiGateKeys());
  assert.ok(steps.length >= 10, `expected the tour to have steps, found ${steps.length}`);

  for (const step of steps) {
    if (step.gate === null) continue;
    assert.ok(gates.has(step.gate),
      `tour step "${step.id}" is gated on "${step.gate}", which is not in UI_GATES — `
      + 'it would never be shown to anybody');
  }

  // And no step invents a permission of its own instead of naming a gate.
  const block = /const TOUR_STEPS = \[([\s\S]*?)\n\];/.exec(HTML)[1];
  assert.ok(!/can\(/.test(block),
    'a step should name a UI_GATES key, not call can() — two copies of one '
    + 'visibility rule is the bug UI_GATES exists to prevent');
});

test('every permission-gated top-level tab has a tour step', () => {
  /* The half that catches the omission rather than the typo. A tab added to
     UI_GATES with no step here means a feature nobody is ever told about. */
  const tabs = uiGateKeys().filter((k) => k.endsWith('TabBtn'));
  assert.ok(tabs.length >= 7, `expected the app's gated tabs, found ${tabs.length}`);

  const covered = new Set(tourSteps().map((s) => s.gate).filter(Boolean));
  const missing = tabs.filter((t) => !covered.has(t));
  assert.deepStrictEqual(missing, [],
    `these tabs have no Quick Tour step: ${missing.join(', ')}. Add one to TOUR_STEPS `
    + 'beside the permission that opens the tab.');
});

test('the two ungated tabs are in the tour, and are the only ungated steps', () => {
  /* Dashboard and Assets List are not permission questions — everybody gets
     them — which is why they carry no gate. Asserted so that "gate: null"
     stays a deliberate statement about those two rather than a way to skip
     thinking about a new step's permission. */
  const ungated = tourSteps().filter((s) => s.gate === null).map((s) => s.id);
  assert.deepStrictEqual(ungated.sort(),
    ['board', 'bell', 'list', 'tourBtn', 'welcome'].sort(),
    'an ungated step shows for every account, so the list of them is deliberate');
});

test('the tour button is not permission-gated', () => {
  /* Point 5: the tour itself is available to everybody and only its CONTENT
     varies. A gate on the button would be the one thing that breaks that. */
  const gates = uiGateKeys();
  assert.ok(!gates.includes('tourBtn'),
    'the Quick Tour button must not be in UI_GATES — a help screen somebody '
    + 'can be denied is not a help screen');
  assert.match(HTML, /id="tourBtn"[^>]*aria-label="Quick Tour"/,
    'the header button should be there and labelled for a screen reader');
  // And it is not hidden by default the way every gated control in the header is.
  const btn = /<button[^>]*id="tourBtn"[^>]*>/.exec(HTML)[0];
  assert.ok(!/display:\s*none/.test(btn), 'it starts visible for everyone');
});

test('the tour is an overlay and changes nothing underneath it', () => {
  /* The requirement that "no existing tab, button or workflow was altered".
     The engine may read the page and write one flag; if it ever starts calling
     setTab() or applyGate(), it has stopped being an overlay. */
  const engine = /const tour = \{ open:false[\s\S]*?\nfunction startTour\(/.exec(HTML);
  assert.ok(engine, 'the engine should be findable');
  for (const forbidden of ['setTab(', 'applyGate(', 'logout(', 'state.currentProjectId']) {
    assert.ok(!engine[0].includes(forbidden),
      `the tour engine calls ${forbidden} — it is meant to sit on top of the app, not drive it`);
  }
});

test('the tour step content covers the features it was asked to cover', () => {
  const ids = new Set(tourSteps().map((s) => s.id));
  for (const need of ['board', 'list', 'projects', 'pending', 'timesheet',
    'reports', 'users', 'settings', 'bell']) {
    assert.ok(ids.has(need), `no tour step for ${need}`);
  }
  // The Assets List step earns its place by naming the four sub-tabs, which
  // are not permission-gated and so get no step of their own.
  const listStep = /id: 'list',[\s\S]*?body: ([\s\S]*?)\n  \},/.exec(HTML)[1];
  for (const sub of ['Active', 'Inactive', 'Archived', 'History']) {
    assert.ok(listStep.includes(sub), `the Assets List step should mention ${sub}`);
  }
});

test('tour_seen_at is a real column somebody remembered to ship', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  assert.match(schema, /tour_seen_at\s+DATETIME\s+NULL/);
  const fields = fs.readFileSync(path.join(__dirname, '..', 'src', 'user-fields.js'), 'utf8');
  assert.match(fields, /tour_seen_at AS `tourSeenAt`/,
    'the flag has to reach the browser or the tour cannot know whether to open');
});

test('the tour', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Quick-Tour-1!';
  let server;
  const token = {};
  const people = {};
  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tour-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'tour-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = (await as('root', '/clients')).body.clients[0].id;
    const projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId, name: 'Nightgarden' } })).body.project.id;
    for (const [who, role] of [['ana', 'game_artist']]) {
      const made = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId } });
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      people[who] = made.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
  });
  t.after(() => stopServer(server));

  await t.test('a new account has never seen it', async () => {
    const me = (await as('ana', '/auth/me')).body.user;
    assert.strictEqual(me.tourSeenAt, null, 'which is what makes it open by itself once');
    // And the flag rides along on sign-in too, so the first page load knows.
    const fresh = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@zvky.test', password: PASSWORD } })).body;
    assert.strictEqual(fresh.user.tourSeenAt, null);
    assert.ok(!('password_hash' in fresh.user), 'and nothing else came along with it');
  });

  await t.test('finishing or skipping it is recorded, once', async () => {
    const done = await as('ana', '/auth/tour-seen', { method: 'POST' });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.tourSeenAt, 'a timestamp comes back');

    const first = (await as('ana', '/auth/me')).body.user.tourSeenAt;
    assert.ok(first, 'and it sticks across a fresh request');

    /* Relaunching it by hand must not move the date. The question this column
       answers is "has this person been shown the tour", not "when did they
       last watch it" — and a column that moves is one somebody will later
       mistake for activity. */
    await new Promise((r) => setTimeout(r, 1100));
    await as('ana', '/auth/tour-seen', { method: 'POST' });
    assert.strictEqual((await as('ana', '/auth/me')).body.user.tourSeenAt, first,
      'the first time is kept');
  });

  await t.test('every signed-in account may mark it, and nobody may do it for anyone else', async () => {
    // No permission gate at all — point 5, asserted against the API rather
    // than only against the page.
    assert.strictEqual((await as('root', '/auth/tour-seen', { method: 'POST' })).status, 200);

    // It takes no id, so there is no one else's flag to reach.
    const before = (await as('ana', '/auth/me')).body.user.tourSeenAt;
    await as('root', '/auth/tour-seen', { method: 'POST', body: { userId: people.ana } });
    assert.strictEqual((await as('ana', '/auth/me')).body.user.tourSeenAt, before,
      'Root marking their own tour did not touch Ana\'s');

    // And signed out, it is refused like everything else.
    assert.strictEqual((await call('/auth/tour-seen', { method: 'POST' })).status, 401);
  });

  await t.test('an account that has seen it keeps that across sign-ins', async () => {
    /* The behaviour of test step 3: log out, log back in, no auto-launch. The
       flag is on the account rather than in the browser, so a second device
       and a cleared browser both still know. */
    const again = (await call('/auth/login', { method: 'POST',
      body: { email: 'ana@zvky.test', password: PASSWORD } })).body;
    assert.ok(again.user.tourSeenAt, 'a fresh sign-in still knows');
    const row = await sql(cfg, `SELECT tour_seen_at FROM users WHERE id = '${people.ana}'`);
    assert.ok(row[0].tour_seen_at, 'and it is on the account, not in a browser');
  });

  await t.test('the permissions the tour filters on are the real ones', async () => {
    /* The tour reads the same permission list the tabs do, straight off the
       signed-in user. If that list stopped arriving, every gated step would
       silently vanish for everybody — so this asserts the supply, which is the
       thing the browser test cannot see. */
    const me = (await as('ana', '/auth/me')).body.user;
    assert.ok(Array.isArray(me.permissions) && me.permissions.length,
      'the browser needs the permission list to filter the tour');
    for (const key of me.permissions) {
      assert.ok(catalog.BY_KEY.has(key), `${key} is not a permission in the catalogue`);
    }
  });
});
