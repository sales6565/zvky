/* Searching the roster: what the box matches, against what the list shows.
 *
 * THE REPORT WAS "can't search the candidate properly", which names no term and no screen, so
 * every people-search in the app was driven before anything was changed. Three exist:
 *
 *   Users tab      "Search users…" — server-side, GET /users?search=
 *   Chat           "Search people…" — client-side over the full set, name only
 *   Outsource      no search box at all
 *
 * There is no candidate ENTITY in this codebase — the only `candidate` in the source is a
 * local variable in src/reporting.js for a candidate MANAGER — so the roster search is what
 * this file is about, and the other two findings are recorded at the bottom rather than
 * quietly fixed.
 *
 * THE ROOT CAUSE, reproduced: the box's raw text went into %…% against lower(name) and
 * lower(email) and nothing else, so three ordinary terms found nobody who was plainly on
 * screen — a leading space, a doubled inner space, and the DESIGNATION the list displays in
 * its own column. Each is pinned below as itself, not as "search returns something".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

const cfg = config('usersearch');
const PASSWORD = 'UserSearch-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the roster search, field by field', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const found = async (term, { status = 'active', limit = 60, offset = 0 } = {}) => {
    const r = await as('root',
      `/users?search=${encodeURIComponent(term)}&limit=${limit}&offset=${offset}&status=${status}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return { names: (r.body.users || []).map((u) => u.name).sort(), total: Number(r.body.total) };
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'us-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'us-boot', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = (await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;

    const mk = async (name, email, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
      return r.body.user.id;
    };
    await mk('Priya Raman', 'priya.raman@zvky.test', 'game_artist');
    await mk('Arjun Mehta', 'arjun@zvky.test', 'team_lead');
    await mk('Sanjay Kumar', 'sanjay@zvky.test', 'art_supervisor');
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* --- the three that were broken, each as itself ------------------------- */

  await t.test('REGRESSION: a leading space no longer loses the person', async () => {
    /* What pasting a name out of an email gives you. The raw term became "% priya%", which
       asks for a space BEFORE the name — and "Priya Raman" has none, so the search returned
       nothing about somebody sitting in the list behind it. */
    assert.deepStrictEqual((await found(' Priya')).names, ['Priya Raman']);
    assert.deepStrictEqual((await found('Priya ')).names, ['Priya Raman'], 'and a trailing one');
    assert.deepStrictEqual((await found('   Priya Raman   ')).names, ['Priya Raman'], 'and both');
    // Real control characters, via fromCharCode so no escaping layer can turn them into
    // literal backslashes — which is what the first version of this line actually tested.
    const TAB = String.fromCharCode(9); const NL = String.fromCharCode(10);
    assert.deepStrictEqual((await found(`${TAB} Priya ${NL}`)).names, ['Priya Raman'],
      'tabs and newlines too');
  });

  await t.test('REGRESSION: a doubled inner space no longer loses the person', async () => {
    /* The other half of the same paste. The stored name has one space; the term had two, so
       the LIKE could not match however obviously right it looked. */
    assert.deepStrictEqual((await found('Priya  Raman')).names, ['Priya Raman']);
    assert.deepStrictEqual((await found('Priya   Raman')).names, ['Priya Raman'], 'or three');
  });

  await t.test('REGRESSION: the designation is searchable, as the words on the screen', async () => {
    /* The list has a designation column. The query did not look at it, so the one field a
       reader is most likely to search by — "show me the team leads" — returned nothing.
       Matched by LABEL as displayed and by key, because a studio renames labels in Settings
       and either is a reasonable thing to type. */
    assert.deepStrictEqual((await found('Team Lead')).names, ['Arjun Mehta']);
    assert.deepStrictEqual((await found('team_lead')).names, ['Arjun Mehta'], 'by key as well');
    assert.deepStrictEqual((await found('team lead')).names, ['Arjun Mehta'], 'and case-insensitively');
    assert.deepStrictEqual((await found('Art Supervisor')).names, ['Sanjay Kumar']);
    /* A partial designation, since the box filters as you type. "Superv" must not wait for
       the whole word. */
    assert.deepStrictEqual((await found('Superv')).names, ['Sanjay Kumar']);
  });

  /* --- and every field it is meant to cover, positively ------------------- */

  await t.test('name: full, partial, surname, mid-word, any case', async () => {
    for (const term of ['Priya Raman', 'Priya', 'Raman', 'riya', 'PRIYA RAMAN', 'priya raman']) {
      assert.deepStrictEqual((await found(term)).names, ['Priya Raman'], `searching "${term}"`);
    }
  });

  await t.test('email: whole address, local part, and the domain everybody shares', async () => {
    assert.deepStrictEqual((await found('priya.raman@zvky.test')).names, ['Priya Raman']);
    assert.deepStrictEqual((await found('priya.raman')).names, ['Priya Raman']);
    assert.deepStrictEqual((await found('ARJUN@ZVKY.TEST')).names, ['Arjun Mehta'], 'any case');
    // The shared domain finds the roster, which is the honest answer to that term.
    assert.deepStrictEqual((await found('zvky.test')).names,
      ['Arjun Mehta', 'Priya Raman', 'Root', 'Sanjay Kumar']);
  });

  await t.test('a term that matches nothing still matches nothing', async () => {
    /* The point of widening a search is not to make it match everything. */
    assert.deepStrictEqual((await found('zzzzz')).names, []);
    assert.deepStrictEqual((await found('Priya Mehta')).names, [],
      'and it does not start matching across two people');
    assert.strictEqual((await found('zzzzz')).total, 0);
  });

  await t.test('an empty or whitespace-only box is not a filter', async () => {
    /* WHY THE `if (term)` GUARD IS NOT PINNED BEHAVIOURALLY. Removing it is an equivalent
       mutant: an empty term builds `LIKE '%%'`, which matches every row, so the answer is the
       same list either way. The guard earns its place on cost rather than correctness — it
       keeps a whitespace-only box from building a `role IN (…)` over every designation in the
       catalogue plus two LIKEs per row — and a test that asserted the query's SHAPE to catch
       it would be pinning the implementation rather than the behaviour. Recorded instead. */
    /* A box holding one space used to be a filter for " ", which matched every name with a
       space in it — most of them — and looked like it was working. It is now no filter at
       all, which is what an empty box means. */
    const everyone = (await found('')).names;
    assert.ok(everyone.length >= 4, 'an empty term lists the roster');
    assert.deepStrictEqual((await found('   ')).names, everyone, 'and so does whitespace');
    assert.deepStrictEqual(
      (await found(String.fromCharCode(9) + String.fromCharCode(10))).names, everyone,
      'a tab and a newline are whitespace too');
  });

  /* --- the whole set, not the page on screen ------------------------------ */

  await t.test('the search reaches the whole roster, not the page being shown', async () => {
    /* The Users list is paginated — limit and offset go to the server — so the question is
       whether the TERM goes with them or whether the box filters what has already arrived.
       It goes: a term is answered from the whole table even when the page size is one, and
       `total` reports the real count rather than the size of the slice. Asserted because a
       box that searched only the current page would look exactly like this report. */
    const narrow = await found('Sanjay', { limit: 1 });
    assert.deepStrictEqual(narrow.names, ['Sanjay Kumar'],
      'found with a page size of one, so the server did the matching');

    /* And the reverse, which is the real test of it: ask for a page that CANNOT contain the
       match, and the count still knows about them. Sanjay sorts last of the four, so page
       one of one holds Arjun — yet a search for Sanjay answers from the whole table. */
    const firstPage = await found('', { limit: 1, offset: 0 });
    assert.strictEqual(firstPage.names.length, 1, 'one row on the page');
    assert.ok(!firstPage.names.includes('Sanjay Kumar'), 'and it is not Sanjay');
    assert.ok(firstPage.total >= 4, 'while total counts the roster');
    assert.deepStrictEqual((await found('Sanjay', { limit: 1, offset: 0 })).names, ['Sanjay Kumar'],
      'and Sanjay is still findable from that page');
  });

  await t.test('the status filter still governs what a term can reach', async () => {
    /* Widening the fields must not widen the roster: somebody deactivated stays out of the
       default list however precisely they are named. */
    const arjun = await as('root', '/users?search=Arjun&limit=60&offset=0&status=active');
    const id = arjun.body.users[0].id;
    const off = await as('root', `/users/${id}/deactivate`, { method: 'POST' });
    assert.ok(off.status < 400, JSON.stringify(off.body));
    assert.deepStrictEqual((await found('Arjun')).names, [], 'gone from the active roster');
    assert.deepStrictEqual((await found('Arjun', { status: 'inactive' })).names, ['Arjun Mehta'],
      'and one filter away, by the same term');
    assert.deepStrictEqual((await found('Team Lead')).names, [],
      'and the designation term obeys it too');
  });
});

// --- the page's half, and the two findings not fixed here --------------------

test('the roster box has its own term, and the board box says what it is filtering', () => {
  /* THE SECOND DEFECT FOUND IN THE SAME CODE. "Search users…" wrote state.search — the
     variable filteredAssets() reads for the Dashboard and the Assets List — so typing a
     colleague's name in the Users tab filtered the BOARD by it. And because the asset search
     input was only ever read from, never written back, that box looked empty while the board
     sat at "No assets match your filters": a filter nobody could see they had set.
     Reproduced by running the page's own filteredAssets with state.search = 'Priya', which
     returned 0 of 2 assets. */
  assert.match(PAGE, /state\.userSearch=e\.target\.value; renderUsersTab\(\);/,
    'the roster box writes its own term');
  assert.match(PAGE, /search=\$\{encodeURIComponent\(state\.userSearch\)\}/,
    'and the query is built from that term');
  assert.match(PAGE, /let state = \{ view:'board', search:'', userSearch:'',/,
    'which is initialised beside the board\'s own');

  const usersTab = PAGE.slice(PAGE.indexOf('function renderUsersTab'),
    PAGE.indexOf('function renderUsersTab') + 4000);
  assert.ok(!/state\.search\b/.test(usersTab),
    'and the Users tab no longer touches the board\'s term');

  // The board's box is written back, so a term filtering it is always on screen.
  assert.match(PAGE, /getElementById\('search'\)\.value = state\.search \|\| '';/,
    'the asset search box shows the term the board is filtered by');
});

test('the other two people-searches, recorded as found rather than changed', () => {
  /* NOT FIXED HERE, and each for a stated reason — but pinned, so the next person to read
     this file learns what is true rather than assuming all three behave alike.
   *
   * CHAT "Search people…" matches the NAME only, while the picker displays the designation
   * beside it — the same field mismatch the roster had. It does trim, and /chat/people
   * returns the whole set with no LIMIT, so neither of the roster's other two faults is
   * present. Left alone because the report was about searching a person in the roster and
   * widening a second search on the same hunch is how one fix becomes three untested ones.
   *
   * THE OUTSOURCE ROSTER has no search box at all. Worth knowing if "the candidate" turns
   * out to have meant a freelancer: the answer there is not a broken search but a missing
   * one, which is a feature request rather than a bug. */
  const chat = PAGE.slice(PAGE.indexOf('function chatPeopleMatching()'));
  const body = chat.slice(0, chat.indexOf('\n}') + 2);
  assert.match(body, /chatState\.search\.trim\(\)\.toLowerCase\(\)/, 'chat trims its term');
  assert.match(body, /p\.name\|\|''\)\.toLowerCase\(\)\.includes\(q\)/,
    'and matches the name only — designation is shown but not searched');
  assert.ok(!/role|designation/i.test(body),
    'the designation is not among the fields it filters on');

  const chatRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chat.js'), 'utf8');
  const peopleAt = chatRoute.indexOf("GET /api/chat/people");
  assert.ok(!/LIMIT/i.test(chatRoute.slice(peopleAt, peopleAt + 900)),
    'the chat list is the whole set, so its search is not a page-only search');

  const outsource = PAGE.slice(PAGE.indexOf('async function renderOutsource()'),
    PAGE.indexOf('async function renderOutsource()') + 3000);
  assert.ok(!/placeholder="Search/.test(outsource),
    'the freelancer roster has no search box — a missing feature, not a broken one');
});
