/* HOLD, END TO END, WITH EVERY NATIVE DIALOG THROWING.
 *
 * THE ENVIRONMENT THE FIFTH REPORT CAME FROM, reproduced: in Electron
 * window.prompt() throws `Error: prompt() is not supported.` and confirm()
 * blocks the renderer until a modal nobody can reach is answered. So the three
 * are passed into the lifted page code as functions that THROW — which is
 * exactly what the installed application does — and then Hold is driven against
 * a real server with a real database.
 *
 * WHAT MAKES THIS A TEST AND NOT A SIMULATION:
 *
 *   the code       openAsk, askConfirm, askText and holdAction are LIFTED out of
 *                  public/index.html, not re-implemented. If the page starts
 *                  asking natively again, these tests throw where the browser
 *                  did.
 *   the server     a real one, with a real asset, a real assignee and a real
 *                  running work session opened through POST /:id/start.
 *   the assertion  the work_sessions row, read back out of the database. "The
 *                  request was sent" is not a spy count, it is a clock that
 *                  actually stopped.
 *
 * THE DOM IS A STUB, and a small one on purpose: the dialog touches nine element
 * ids and a handful of properties. A full DOM would mean a dependency in a
 * package.json that ships to shared hosting, for a page with no build step.
 * tests/no-native-dialogs.test.js covers the markup and the keyboard wiring by
 * reading them; this covers the behaviour.
 *
 * FIXED DATES AND openStudio, so no case depends on the hour the suite runs at.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const cfg = config('dialogflow');
const PASSWORD = 'Dialog-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ===========================================================================
// THE STUB. Enough DOM for the shared dialog and two buttons, and no more.
// ===========================================================================

function makeDom({ without = [] } = {}) {
  const nodes = new Map();
  const make = (id) => {
    const el = {
      id,
      textContent: '', value: '', placeholder: '', className: '', type: '',
      disabled: false, tagName: id === 'ask_textarea' ? 'TEXTAREA' : 'DIV',
      style: {},
      _classes: new Set(),
      classList: {
        add: (c) => el._classes.add(c),
        remove: (...c) => c.forEach((x) => el._classes.delete(x)),
        contains: (c) => el._classes.has(c),
      },
      focus() { el._focused = true; },
      select() { el._selected = true; },
      onclick: null,
      click() { if (el.onclick) return el.onclick({ target: el }); return undefined; },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => [],
      appendChild() {}, remove() {},
    };
    return el;
  };
  /* ask_textarea and ask_count arrived with Submit Feedback, which gave openAsk
     a multi-line field, a live character count and "disabled until it is valid".
     This stub stands in for the page's markup, so it has to carry what the
     markup carries: without them openAsk reads style off null and every case
     here fails inside the dialog rather than on its own assertion. */
  for (const id of ['askWrap', 'ask_title', 'ask_message', 'ask_field', 'ask_label',
    'ask_input', 'ask_textarea', 'ask_count', 'ask_err', 'ask_confirm', 'ask_cancel',
    'd_holdBtn', 'd_resumeBtn', 'd_startErr', 'toast']) {
    if (without.includes(id)) continue;
    nodes.set(id, make(id));
  }

  const listeners = {};
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    createElement: make,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    head: { appendChild() {} },
  };
  const key = (k, target) => {
    const ev = { key: k, shiftKey: false, target: target || { tagName: 'BUTTON' },
      preventDefault() { ev.defaulted = true; } };
    for (const fn of listeners.keydown || []) fn(ev);
    return ev;
  };
  return { document, nodes, key, listeners };
}

/* THE DIALOG AND THE HOLD HANDLER, LIFTED. Two slices, with the boundaries
   asserted rather than assumed — a silently empty slice would make every test
   below pass for the wrong reason. */
function harness({ api: apiFn, onRender = async () => {}, toast = [], without = [] } = {}) {
  const dialogFrom = PAGE.indexOf("const askWrap = document.getElementById('askWrap');");
  const dialogTo = PAGE.indexOf('/* ---------- login/session ----------');
  assert.ok(dialogFrom !== -1 && dialogTo > dialogFrom, 'the shared dialog is in the page');
  const dialog = PAGE.slice(dialogFrom, dialogTo);
  assert.match(dialog, /function openAsk\(\{/, 'and the slice contains it');
  assert.match(dialog, /function guarded\(what, fn\)\{/, 'and the guard');

  const holdFrom = PAGE.indexOf('  const holdAction = (button, path, ask) => {');
  const tail = "  holdAction(document.getElementById('d_resumeBtn'), '/resume', false);";
  const holdTo = PAGE.indexOf(tail, holdFrom);
  assert.ok(holdFrom !== -1 && holdTo > holdFrom, 'the hold handler is in the page');
  const hold = PAGE.slice(holdFrom, holdTo + tail.length);
  assert.match(hold, /await openAsk\(\{/, 'and it asks through the shared dialog');

  const dom = makeDom({ without });
  const calls = [];
  const api = async (p, o = {}) => {
    calls.push({ path: p, method: (o && o.method) || 'GET', body: o && o.body });
    return apiFn(p, o);
  };

  /* THE THREE, THROWING — which is what Electron does. Passed as parameters so
     that a bare `confirm(...)` in the lifted code resolves to one of these and
     fails the test, exactly as it fails in the application. */
  const notSupported = (name) => () => { throw new Error(`${name}() is not supported.`); };

  const built = new Function(
    'document', 'window', 'api', 'render', 'openDrawer', 'showToast', 'id',
    'prompt', 'confirm', 'alert', 'console',
    `${dialog}
     ${hold}
     return { openAsk, askConfirm, askText, guarded, askClose,
       activeQuestion: () => askActive, reportUnexpected };`
  )(
    dom.document,
    { addEventListener: (t, fn) => dom.document.addEventListener(t, fn),
      prompt: notSupported('prompt'), confirm: notSupported('confirm'),
      alert: notSupported('alert') },
    api,
    onRender,
    () => {},
    (m) => toast.push(m),
    'asset-1',
    notSupported('prompt'), notSupported('confirm'), notSupported('alert'),
    { error() {}, warn() {} },
  );
  return { ...built, dom, calls, toast };
}

// ===========================================================================
// 1. THE DIALOG ITSELF, against the stub.
// ===========================================================================

test('the three native dialogs throw in this harness, as they do in the application', () => {
  const h = harness({ api: async () => ({}) });
  /* THE PREMISE, ASSERTED. If these ever stop throwing, every test below
     becomes a test of nothing. */
  for (const name of ['prompt', 'confirm', 'alert']) {
    assert.throws(() => new Function(name, `${name}('x')`)(
      () => { throw new Error(`${name}() is not supported.`); }
    ), new RegExp(`${name}\\(\\) is not supported`));
  }
  assert.ok(h.openAsk, 'and the page has its own way to ask');
});

test('a question appears in the page, and Escape cancels it', async () => {
  const h = harness({ api: async () => ({}) });
  const answer = h.askConfirm({ title: 'Remove this?', message: 'It cannot be undone.' });

  assert.ok(h.dom.nodes.get('askWrap').classList.contains('show'),
    'the modal is on screen');
  assert.strictEqual(h.dom.nodes.get('ask_title').textContent, 'Remove this?');
  assert.strictEqual(h.dom.nodes.get('ask_message').textContent, 'It cannot be undone.');
  assert.strictEqual(h.dom.nodes.get('ask_field').style.display, 'none',
    'a yes/no question has no input');

  const ev = h.dom.key('Escape');
  assert.ok(ev.defaulted, 'Escape is handled rather than left to the browser');
  assert.strictEqual(await answer, false, 'and answers no');
  assert.ok(!h.dom.nodes.get('askWrap').classList.contains('show'), 'and closes');
  assert.strictEqual(h.activeQuestion(), null, 'and lets go of the keyboard');
});

test('Enter confirms, and a text question gives back what was typed', async () => {
  const h = harness({ api: async () => ({}) });
  const answer = h.askText({ title: 'Rename', label: 'Name', value: 'Before' });
  assert.strictEqual(h.dom.nodes.get('ask_input').value, 'Before', 'prefilled');
  assert.strictEqual(h.dom.nodes.get('ask_label').textContent, 'Name');
  h.dom.nodes.get('ask_input').value = 'After';
  h.dom.key('Enter');
  assert.strictEqual(await answer, 'After');

  /* CANCEL IS null, NOT AN EMPTY STRING. Every call site tells them apart —
     `if(next===null) return` — and conflating them would turn a cancelled
     rename into a rename to nothing. */
  const second = h.askText({ title: 'Rename', label: 'Name', value: 'X' });
  h.dom.key('Escape');
  assert.strictEqual(await second, null);
});

test('Enter inside a textarea is a new line, not an answer', async () => {
  const h = harness({ api: async () => ({}) });
  const answer = h.askConfirm({ title: 'Go?' });
  const ev = h.dom.key('Enter', { tagName: 'TEXTAREA' });
  assert.ok(!ev.defaulted, 'the keypress is left alone');
  assert.ok(h.dom.nodes.get('askWrap').classList.contains('show'), 'the question stays up');
  h.dom.key('Escape');
  await answer;
});

test('a missing dialog is a loud failure, never a silent no', async () => {
  /* THE ONE WAY THIS COULD HAVE REPRODUCED THE ORIGINAL BUG. If openAsk
     answered "cancelled" when its markup was missing, every destructive action
     in the application would quietly do nothing — which is the shape of the bug
     this whole change is a fix for. It rejects instead, and the page-level guard
     turns that into something on screen. */
  /* The element has to be absent WHEN THE DIALOG IS BUILT: `const askWrap =
     document.getElementById('askWrap')` runs once at page load, so deleting it
     from the stub afterwards would leave the captured handle intact and the
     promise would simply never settle — which is how the first version of this
     test hung. */
  const broken = harness({ api: async () => ({}), without: ['askWrap'] });
  await assert.rejects(() => broken.openAsk({ title: 'x' }), /askWrap is missing/);
  assert.ok(broken.toast.length, 'and the person is told');
  assert.match(broken.toast.join(' '), /could not open its dialog/i);
});

// ===========================================================================
// 2. HOLD, END TO END, AGAINST A LIVE SERVER.
// ===========================================================================

test('Hold, with every native dialog throwing', { skip: cfg ? false : SKIP_REASON },
  async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'df', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'df', name: 'Root', email: 'root@df.test', password: PASSWORD } });
    tok.root = await login('root@df.test');
    await openStudio(server.base, tok.root);

    const mk = async (who, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@df.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      tok[who] = await login(`${who}@df.test`);
      return r.body.user.id;
    };
    id.ana = await mk('ana', 'game_artist');
    const clients = await as('root', '/clients');
    const pr = await as('root', '/projects', { method: 'POST',
      body: { name: 'Dialogs', clientId: clients.body.clients[0].id } });
    id.project = pr.body.project.id;
  });
  t.after(async () => { if (server) await stopServer(server); });

  /* A fresh asset with a real running session, opened through the app. */
  const running = async (name) => {
    await sql(cfg, 'UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()), '
      + "seconds = COALESCE(seconds, 0), ended_reason = 'submitted' "
      + 'WHERE user_id = ? AND (ended_at IS NULL OR ended_reason = \'held\')', [id.ana]);
    const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: id.ana } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    const s = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    return assetId;
  };
  /* THE CURRENT SESSION: the open row if there is one, else the last to start.
   *
   * The open row FIRST, and that ordering is the whole of a flake this suite
   * failed twice on under a loaded full run and never alone. started_at is a
   * DATETIME — one-second resolution — and a case that starts a clock, holds it
   * and resumes it runs in about 130 ms, so the held row and the row the resume
   * opened share a started_at and `ORDER BY started_at DESC LIMIT 1` was free to
   * return either. It returned the held one, and the assertion read a clock that
   * was in fact running. Production never had this ambiguity: openSession()
   * filters on ended_at IS NULL rather than ordering by time. */
  const session = async (assetId) => (await sql(cfg,
    'SELECT ended_reason, hold_note FROM work_sessions WHERE asset_id = ? '
    + 'ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1',
    [assetId]))[0];

  /* The page's own api(), pointed at the real server with ana's real token —
     so a request the handler sends is a request the server answers. */
  const liveApi = (assetId) => async (p, o = {}) => {
    const r = await api(server.base, p, { ...o, token: tok.ana });
    if (r.status >= 400) {
      const err = new Error((r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`);
      err.status = r.status; err.body = r.body;
      throw err;
    }
    void assetId;
    return r.body;
  };

  await t.test('the question appears, and the clock stops once it is confirmed', async () => {
    const assetId = await running('Held Through The Modal');
    let redrawn = 0;
    const h = harness({ api: liveApi(assetId), onRender: async () => { redrawn += 1; },
      toast: [] });
    /* The handler closes over `id`, which the harness supplies — so it has to be
       built for this asset. Rebuilt rather than parameterised, because that is
       what openDrawer does on every open. */
    const hh = harnessFor(assetId, liveApi(assetId), () => { redrawn += 1; });

    hh.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();

    /* NOTHING IS SENT YET. The question is up and that is all. */
    assert.ok(hh.dom.nodes.get('askWrap').classList.contains('show'),
      'the in-page question is on screen');
    assert.deepStrictEqual(hh.calls, [], 'and no request has been sent');
    assert.strictEqual((await session(assetId)).ended_reason, null, 'the clock is still running');

    hh.dom.nodes.get('ask_input').value = '  waiting on the brief  ';
    await hh.dom.nodes.get('ask_confirm').click();

    assert.deepStrictEqual(hh.calls.map((c) => `${c.method} ${c.path}`),
      [`POST /assets/${assetId}/hold`], 'exactly one request, after confirming');
    assert.deepStrictEqual(hh.calls[0].body, { note: 'waiting on the brief' },
      'carrying the trimmed note');

    const row = await session(assetId);
    assert.strictEqual(row.ended_reason, 'held', 'and the clock actually stopped');
    assert.strictEqual(row.hold_note, 'waiting on the brief', 'with the reason recorded');

    assert.ok(!hh.dom.nodes.get('askWrap').classList.contains('show'),
      'the question closes on success');
    assert.ok(redrawn > 0, 'and the card is redrawn');
    assert.ok(hh.toast.some((m) => /on hold/i.test(m)), 'and the result is said out loud');

    void h;
  });

  await t.test('Cancel sends nothing at all', async () => {
    const assetId = await running('Cancelled');
    const hh = harnessFor(assetId, liveApi(assetId), () => {});
    hh.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();
    assert.ok(hh.dom.nodes.get('askWrap').classList.contains('show'));

    hh.dom.key('Escape');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(hh.calls, [], 'no request');
    assert.strictEqual((await session(assetId)).ended_reason, null,
      'and the clock is still running — cancelling means cancel the hold');
    assert.ok(!hh.dom.nodes.get('askWrap').classList.contains('show'));
  });

  await t.test('a refused request is shown, and the question stays up', async () => {
    /* HOLD IT TWICE. The second is a real 409 from the real server —
       HOLD_ALREADY_HELD — which is the ordinary way this fails. */
    const assetId = await running('Already Held');
    const first = harnessFor(assetId, liveApi(assetId), () => {});
    first.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();
    await first.dom.nodes.get('ask_confirm').click();
    assert.strictEqual((await session(assetId)).ended_reason, 'held');

    const second = harnessFor(assetId, liveApi(assetId), () => {});
    second.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();
    await second.dom.nodes.get('ask_confirm').click();

    assert.ok(second.dom.nodes.get('askWrap').classList.contains('show'),
      'the question is still on screen, so the answer is not lost');
    assert.match(second.dom.nodes.get('ask_err').textContent, /already on hold/i,
      'and the reason is IN the question, where the person is looking');
    assert.strictEqual(second.dom.nodes.get('ask_confirm').disabled, false,
      'and the button is live again');
    assert.notStrictEqual(second.dom.nodes.get('ask_confirm').textContent, 'Holding…',
      'with its own label back');
    /* AND IN THE PANEL TOO, for the redrawn case. */
    assert.match(second.dom.nodes.get('d_startErr').textContent, /already on hold/i);
  });

  await t.test('the button goes busy while the request is in flight', async () => {
    const assetId = await running('Busy While Sending');
    let release;
    const slow = async (p, o) => {
      await new Promise((r) => { release = r; });
      return liveApi(assetId)(p, o);
    };
    const hh = harnessFor(assetId, slow, () => {});
    hh.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();
    const done = hh.dom.nodes.get('ask_confirm').click();
    await Promise.resolve();

    assert.strictEqual(hh.dom.nodes.get('ask_confirm').textContent, 'Holding…',
      'the button says what it is doing');
    assert.strictEqual(hh.dom.nodes.get('ask_confirm').disabled, true,
      'and cannot be pressed twice');
    assert.strictEqual(hh.dom.nodes.get('ask_cancel').disabled, true,
      'and the way out is closed while the request is in flight');

    release();
    await done;
    assert.strictEqual((await session(assetId)).ended_reason, 'held');
  });

  await t.test('Resume asks nothing, and still works with the dialogs throwing', async () => {
    /* RESUME WAS NEVER BROKEN — it passes `ask: false` and never reached the
       prompt, which is why the report named Hold alone. Asserted anyway: the
       fix must not have made it ask. */
    const assetId = await running('Resumed');
    const held = harnessFor(assetId, liveApi(assetId), () => {});
    held.dom.nodes.get('d_holdBtn').click();
    await Promise.resolve();
    await held.dom.nodes.get('ask_confirm').click();
    assert.strictEqual((await session(assetId)).ended_reason, 'held');

    const back = harnessFor(assetId, liveApi(assetId), () => {});
    await back.dom.nodes.get('d_resumeBtn').click();
    assert.ok(!back.dom.nodes.get('askWrap').classList.contains('show'),
      'Resume asks nothing');
    assert.deepStrictEqual(back.calls.map((c) => `${c.method} ${c.path}`),
      [`POST /assets/${assetId}/resume`]);
    /* AND IF IT DID NOT RESUME, SAY WHY. The handler puts a refusal in the
       panel, so a failure here reads "the server said: …" rather than leaving
       the next person to guess — this case failed once in a loaded full run
       and passed standalone, and a message is how that gets diagnosed rather
       than re-run. */
    const refusal = back.dom.nodes.get('d_startErr').textContent;
    assert.strictEqual((await session(assetId)).ended_reason, null,
      `and the clock is running again${refusal ? ` (the server said: ${refusal})` : ''}`);
    assert.ok(back.toast.some((m) => /under way/i.test(m)));
  });

  await t.test('a refusal goes in the panel; anything else goes to the guard', async () => {
    /* TWO KINDS OF FAILURE, TOLD APART — and the distinction is the fix for the
       bug one level down from the reported one.
     *
     * A REFUSAL carries a status. The server said no, send() has already put its
     * sentence in the panel's error line, and a toast on top would be the same
     * news twice. */
    const refused = harnessFor('asset-x', async () => {
      const err = new Error('This task is not on hold — use Accept and Start to begin work on it.');
      err.status = 409; err.body = { code: 'HOLD_NOT_HELD' };
      throw err;
    }, () => {});
    await refused.dom.nodes.get('d_resumeBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(refused.dom.nodes.get('d_startErr').textContent, /not on hold/,
      'the reason is in the panel');
    assert.strictEqual(refused.dom.nodes.get('d_resumeBtn').disabled, false,
      'and the button is live again');
    assert.deepStrictEqual(refused.toast, [], 'and not announced twice');

    /* ANYTHING ELSE has no status: a renamed element, a redraw that threw, a
       wrapper that does not implement something — the shape of the original bug.
       It reaches the page guard and the person is told. A bare `catch{}` here is
       what made Hold silent, and leaving one would be the same mistake. */
    const broke = harnessFor('asset-y', async () => { throw new Error('kaboom'); }, () => {});
    await broke.dom.nodes.get('d_resumeBtn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(broke.toast.some((m) => /kaboom/.test(m)),
      `an unexpected throw is on screen: ${JSON.stringify(broke.toast)}`);
    assert.strictEqual(broke.dom.nodes.get('d_resumeBtn').disabled, false,
      'and the button is not left dead');
  });

  /* One harness per asset, because the lifted handler closes over `id` the way
     openDrawer does. */
  function harnessFor(assetId, apiFn, onRender) {
    const toast = [];
    const dom = makeDom();
    const calls = [];
    const dialogFrom = PAGE.indexOf("const askWrap = document.getElementById('askWrap');");
    const dialog = PAGE.slice(dialogFrom, PAGE.indexOf('/* ---------- login/session ----------'));
    const holdFrom = PAGE.indexOf('  const holdAction = (button, path, ask) => {');
    const tailLine = "  holdAction(document.getElementById('d_resumeBtn'), '/resume', false);";
    const hold = PAGE.slice(holdFrom, PAGE.indexOf(tailLine, holdFrom) + tailLine.length);
    const notSupported = (name) => () => { throw new Error(`${name}() is not supported.`); };
    const wrapped = async (p, o = {}) => {
      calls.push({ path: p, method: (o && o.method) || 'GET', body: o && o.body });
      return apiFn(p, o);
    };
    const built = new Function(
      'document', 'window', 'api', 'render', 'openDrawer', 'showToast', 'id',
      'prompt', 'confirm', 'alert', 'console',
      `${dialog}\n${hold}\n return { activeQuestion: () => askActive };`
    )(
      dom.document,
      { addEventListener: (t2, fn) => dom.document.addEventListener(t2, fn),
        prompt: notSupported('prompt'), confirm: notSupported('confirm'),
        alert: notSupported('alert') },
      wrapped, async () => onRender(), () => {}, (m) => toast.push(m), assetId,
      notSupported('prompt'), notSupported('confirm'), notSupported('alert'),
      { error() {}, warn() {} },
    );
    return { ...built, dom, calls, toast };
  }
});
