/* The Game Feedback screens: the asset panel, the board column, the pending list.
 *
 * All three read data written by somebody else — Dev & QA through the integration, the
 * state machine through the transition — so what is guarded here is that each of them
 * shows what is actually stored, and stops showing it when it is not.
 *
 * THE ONE THAT MATTERS is the pair of buttons. Pass and Decline are gated by
 * canActAtTlGate, and the panel does not re-derive that: GET /assets/:id/game-feedback
 * asks the state machine and the page renders the answer. The test for it is therefore
 * not "does the array look right" but "does the array agree with what the POST does" —
 * for every viewer, an offered button must be a button the server honours, and a withheld
 * one must be a move the server refuses. A frontend check that had drifted would show as
 * the two disagreeing.
 *
 * The board column and the pending entry are tested by appearing AND disappearing, which
 * is the half that rots: a column populated by a status is easy, and a column that still
 * lists an asset after it left that status is the bug nobody writes a test for.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('gfpanel');
const SECRET = 'inbound-secret-for-the-panel-suite';
const PASSWORD = 'GfPanel-Test-1!';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* One function out of the page, run here. The same mechanism
   tests/asset-workflow.test.js uses on visibleStatuses: the page is not a module, so the
   alternative is asserting on its text, which passes when the code around it has changed
   meaning. */
function pageFunction(name, deps = {}) {
  const at = PAGE.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${name} is not in the page`);
  const rest = PAGE.slice(at);
  const src = rest.slice(0, rest.indexOf('\n}') + 2);
  const names = Object.keys(deps);
  return new Function(...names, `${src}; return ${name};`)(...names.map((n) => deps[n]));
}

/* The page's escapeHTML goes through the DOM — `document.createElement('div')`, set
   textContent, read innerHTML — which is the right way to do it in a browser and is not
   available here. Stubbed rather than replaced with a regex of my own, so what is under
   test below is the page's function and not a second implementation of it that might
   escape a different set of characters. */
const domStub = {
  createElement: () => ({
    textContent: '',
    get innerHTML() {
      return String(this.textContent)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  }),
};

// The helpers the two renderers lean on, as the page defines them.
const pageDeps = () => {
  const escapeHTML = pageFunction('escapeHTML', { document: domStub });
  const deps = {
    escapeHTML,
    fmtDate: (s) => (s ? `at ${s}` : ''),
    renderLink: (raw) => `<a>${raw}</a>`,
  };
  deps.feedbackSource = pageFunction('feedbackSource', {
    FEEDBACK_SOURCES: new Function(
      `${PAGE.slice(PAGE.indexOf('const FEEDBACK_SOURCES = {')).slice(0, PAGE.slice(PAGE.indexOf('const FEEDBACK_SOURCES = {')).indexOf('\n};') + 3)}; return FEEDBACK_SOURCES;`
    )(),
  });
  deps.engineState = pageFunction('engineState', {
    ENGINE_STATES: new Function(
      `${PAGE.slice(PAGE.indexOf('const ENGINE_STATES = {')).slice(0, PAGE.slice(PAGE.indexOf('const ENGINE_STATES = {')).indexOf('\n};') + 3)}; return ENGINE_STATES;`
    )(),
  });
  return deps;
};

// --- the two renderers, with no server ---------------------------------------

test('the In game line says what the build reported, and nothing it did not', () => {
  const deps = pageDeps();
  const inGameLineHTML = pageFunction('inGameLineHTML', deps);

  /* Never been in a build: no line at all, not a line saying so. An asset panel that
     carries an empty "In game" heading on every asset in the studio is a heading people
     learn to skip, and then miss when it fills. */
  assert.strictEqual(inGameLineHTML(null), '', 'nothing reported is nothing drawn');

  const full = inGameLineHTML({
    build: '41', cpStage: 'CP2', engineStatus: 'in', openBugs: 3,
    link: 'https://devqa.example.com/asset/9', buildSeq: 41, at: '2026-09-20T10:00:00Z',
  });
  assert.match(full, /In game/, 'the block is labelled');
  assert.match(full, /In the build/, 'the engine state in words, not its code');
  assert.match(full, /build <strong>41<\/strong>/, 'which build');
  assert.match(full, /CP2/, 'and which checkpoint');
  assert.match(full, /3 open bugs/, 'the open bug count');
  assert.match(full, /devqa\.example\.com/, 'with the way out to Dev & QA');
  assert.match(full, /Open in Dev &amp; QA/, 'labelled, so the link is not a bare URL');

  /* NOUGHT IS NOT NEWS. "0 open bugs" against an asset nobody has filed anything on is a
     reassurance nobody asked for, and it makes the line longer for every asset. */
  const clean = inGameLineHTML({ build: '41', engineStatus: 'in', openBugs: 0 });
  assert.ok(!/open bug/.test(clean), `a clean asset says nothing about bugs: ${clean}`);
  assert.match(inGameLineHTML({ engineStatus: 'in', openBugs: 1 }), /1 open bug\b/,
    'and one bug is singular');

  // A state the engine invented: shown as it arrived rather than dropped.
  assert.match(inGameLineHTML({ engineStatus: 'cooking' }), /cooking/,
    'an unknown engine state is still reported — the column is VARCHAR for that reason');
  assert.match(inGameLineHTML({ openBugs: 0 }), /Unreported/,
    'and a row with no state at all says so');

  // No link, no link markup — not an empty anchor.
  assert.ok(!/Open in Dev/.test(inGameLineHTML({ build: '41', openBugs: 0 })),
    'no link out when the build did not give one');
});

test('a feedback round shows the fields ITS source actually supplies', () => {
  const deps = pageDeps();
  const round = pageFunction('feedbackRoundHTML', deps);

  /* QA and Dev work out of a bug tracker, so the reference is the row's identity. The
     words differ per source on purpose — "Bug QA-1" and "Issue DEV-4" are what those two
     call the same shaped thing, and calling both "Bug" would be wrong for one of them. */
  const qa = round({ id: 'f1', round: 2, source: 'qa', bugRef: 'QA-118', severity: 'blocker',
    note: 'clips through the floor', senderName: 'Priya', senderRole: 'QA Lead',
    build: '41', open: true, at: 'x' });
  assert.match(qa, /QA/, 'the source is named');
  assert.match(qa, /Bug <strong>QA-118<\/strong>/, 'with its bug reference');
  assert.match(qa, /blocker/, 'and its severity');
  assert.match(qa, /Priya \(QA Lead\)/, 'who sent it, as free text — they are not users here');
  assert.match(qa, /round 2/, 'the round it was raised against');
  assert.match(qa, /<strong>open<\/strong>/, 'and that this is the one an answer applies to');
  assert.match(qa, /gf-open/, 'marked for the eye as well as in words');

  const dev = round({ id: 'f2', round: 1, source: 'dev', bugRef: 'DEV-4', note: 'null mesh', at: 'x' });
  assert.match(dev, /Issue <strong>DEV-4<\/strong>/, 'Dev raises issues, not bugs');
  assert.ok(!/<strong>open<\/strong>/.test(dev), 'and this one is not the open round');

  /* A CLIENT HAS NO BUG TRACKER OF OURS. Drawing "Bug —" against their note would invent
     a field they never filled in, which is the failure this per-source table exists to
     stop. */
  const client = round({ id: 'f3', round: 1, source: 'client', bugRef: 'anything',
    note: 'the hat is the wrong red', senderName: 'Acme', at: 'x' });
  assert.ok(!/Bug|Issue|Pass /.test(client),
    `a client note carries no tracker reference: ${client}`);
  assert.match(client, /the hat is the wrong red/, 'but it carries what they said');
  assert.match(client, /Acme/);

  const techArt = round({ id: 'f4', round: 1, source: 'tech_art', bugRef: 'TA-2', note: 'LODs', at: 'x' });
  assert.match(techArt, /Tech Art/);
  assert.match(techArt, /Pass <strong>TA-2<\/strong>/, 'Tech Art refers to a pass, not a ticket');

  // Nothing but a note: no empty meta line under the heading.
  const bare = round({ id: 'f5', round: 1, source: 'qa', note: 'it is broken', at: 'x' });
  assert.ok(!/gf-meta/.test(bare), `no meta row when there is no meta: ${bare}`);

  // Whatever they typed is escaped, like every other free-text field in this panel.
  const nasty = round({ id: 'f6', round: 1, source: 'qa', note: '<img src=x onerror=1>',
    senderName: '<b>x</b>', at: 'x' });
  assert.ok(!/<img/.test(nasty) && !/<b>/.test(nasty), 'feedback from outside is escaped');
});

test('the panel draws Pass and Decline from the server\'s answer and nothing else', () => {
  /* A DRIFT GUARD, and the reason it is worth a test of its own.
   *
   * Everywhere else in the panel a control is gated locally, against the can_review_tl
   * flag the assets list decorates each row with. That flag is deliberately a
   * conservative approximation of canActAtTlGate — it skips the submitted-the-current-
   * version guard and answers true on an unstaffed project — and the standing to answer a
   * bug report is the gate in full.
   *
   * So this function must have no opinion. If somebody later adds `can(...)` or
   * mayActAtTlGate or a status comparison to it "to save a round trip", the page acquires
   * a second copy of the rule, and a copy on the page fails silently: the button appears
   * for somebody the server then refuses, and nothing anywhere goes red. This is what
   * goes red. */
  const at = PAGE.indexOf('async function renderGameFeedbackBlock(');
  assert.ok(at !== -1, 'renderGameFeedbackBlock is in the page');
  const rest = PAGE.slice(at);
  const body = rest.slice(0, rest.indexOf('\n}') + 2);

  assert.match(body, /const may\s*=\s*\(name\)=>actions\.some\(t=>t\.action===name\)/,
    'the gate is membership of the server\'s actions list');
  for (const action of ['game_feedback_pass', 'game_feedback_decline']) {
    assert.match(body, new RegExp(`may\\('${action}'\\)\\?\`<button`),
      `the ${action} button is drawn only when the server listed it`);
  }
  /* Comments mention can_review_tl to explain WHY it is not used, so the check is against
     calls rather than against the word. */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const local of ['can(', 'mayActAtTlGate', 'can_review_tl', 'hasFullAccess']) {
    assert.ok(!code.includes(local),
      `renderGameFeedbackBlock must not decide for itself — found ${local}`);
  }
  assert.ok(!/status\s*===\s*'game_feedback'/.test(code),
    'nor re-derive the stage the actions already account for');

  // And the two actions it names are the two the state machine has.
  const named = workflow.TRANSITIONS.filter((t) => t.action.startsWith('game_feedback_'))
    .map((t) => t.action).sort();
  assert.deepStrictEqual(named, ['game_feedback_decline', 'game_feedback_pass'],
    'the panel names every game feedback transition the machine defines');
});

test('the board has a Game Feedback column, and it is not hidden behind a permission', () => {
  /* The column is whatever visibleStatuses() returns, so this runs the page's own
     function — the same way tests/asset-workflow.test.js checks the CD columns — rather
     than asserting that a list contains a string. */
  const grab = (opener) => {
    const at = PAGE.indexOf(opener);
    assert.ok(at !== -1, `could not find ${opener}`);
    const rest = PAGE.slice(at);
    return rest.slice(0, rest.indexOf('\n}') + 2);
  };
  const source = grab('const RESTRICTED_STATUSES = [') + '\n' + grab('function visibleStatuses()');
  const STATUSES = workflow.STATE_IDS.map((id) => ({ id }));
  const seen = (held) => new Function('STATUSES', 'can', `${source}; return visibleStatuses;`)(
    STATUSES, (p) => held.includes(p))().map((s) => s.id);

  /* Visible to everybody who can see the board at all. A bug from the build concerns the
     artist fixing it as much as the lead answering it, so gating the column would hide
     the asset from the person it is about to be handed to. */
  for (const held of [[], ['asset.add'], ['review.tl'], ['review.cd']]) {
    assert.ok(seen(held).includes('game_feedback'),
      `Game Feedback must be a column for a role holding ${JSON.stringify(held)}`);
  }
  // And it is one column, in the order the server's enum has it.
  assert.deepStrictEqual(seen(['asset.add', 'review.cd', 'review.client_view']),
    workflow.STATE_IDS, 'the board columns are the state machine\'s list, in its order');
});

// --- against a live server ---------------------------------------------------

test('the panel, the pending list and the board, end to end',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEY = 'gfp-key-0123456789abcdef';
  const tokens = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });
  const signed = async (method, target, payload) => {
    const stamp = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.${method}.${target}.${payload}`).digest('hex');
    const res = await fetch(`${server.base}${target.replace('/api', '')}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': KEY,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: payload,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const inGame = (assetId, body) => signed('PUT',
    `/api/integration/v1/assets/${assetId}/in-game`, JSON.stringify(body));
  const raise = (assetId, body) => signed('POST',
    `/api/integration/v1/assets/${assetId}/feedback`, JSON.stringify(body));

  const panel = async (who, assetId) => (await as(who, `/assets/${assetId}/game-feedback`)).body;
  const pending = async (who) => (await as(who, '/project-reviews/pending-actions')).body;
  const statusOf = async (assetId) =>
    (await sql(cfg, 'SELECT `status`, routed_to_id AS routed FROM assets WHERE id = ?', [assetId]))[0];

  /* An asset the studio has finished with, which is what makes it idle and therefore
     what a bug from the build can pull back in. */
  const idleAsset = async (name) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id, routed_to_id) '
      + 'VALUES (?,?,?,?,?,?,?,?)',
      [id, ids.project, `GFP-${id.slice(0, 6)}`, name, 'character', 'delivered', ids.artist, null]);
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'gfp-bootstrap',
      INTEGRATION_INBOUND_SECRET: SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'assets,projects']);

    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'gfp-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    tokens.root = await login('root@zvky.test');

    const make = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tokens[who] = await login(email);
      return r.body.user.id;
    };
    ids.artist = await make('artist', 'artist@zvky.test', 'game_artist');
    ids.lead = await make('lead', 'lead@zvky.test', 'team_lead');
    /* A SECOND LEAD, on nothing. Holds review.tl and is not on this project's review
       team, which is the case the gate exists to refuse and the one a permission-only
       check would wave through. */
    ids.other = await make('other', 'other@zvky.test', 'team_lead');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Shipped Game', clientId: client.body.client.id, teamLeadIds: [ids.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('an asset the build has never seen reports nothing', async () => {
    const id = await idleAsset('Never Shipped');
    const p = await panel('lead', id);
    assert.strictEqual(p.inGame, null, 'no in-game row');
    assert.deepStrictEqual(p.rounds, [], 'and nothing raised against it');
    assert.deepStrictEqual(p.actions, [], 'and nothing to answer');
  });

  await t.test('the In game line follows what Dev & QA report, including a stale report', async () => {
    const id = await idleAsset('In The Build');

    const first = await inGame(id, { build_seq: 41, build: '41', cp_stage: 'CP2',
      engine_status: 'in', open_bugs: 0, link: 'https://devqa.example.com/a/1' });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    let p = await panel('lead', id);
    assert.strictEqual(p.inGame.build, '41');
    assert.strictEqual(p.inGame.engineStatus, 'in');
    assert.strictEqual(p.inGame.openBugs, 0);
    assert.strictEqual(p.inGame.link, 'https://devqa.example.com/a/1');
    assert.strictEqual(p.inGame.buildSeq, 41);

    // A newer build: the panel moves with it.
    const second = await inGame(id, { build_seq: 42, build: '42', cp_stage: 'CP3',
      engine_status: 'broken', open_bugs: 2 });
    assert.strictEqual(second.body.applied, true, JSON.stringify(second.body));
    p = await panel('lead', id);
    assert.strictEqual(p.inGame.build, '42', 'the line updates when the data changes');
    assert.strictEqual(p.inGame.engineStatus, 'broken');
    assert.strictEqual(p.inGame.openBugs, 2);
    assert.strictEqual(p.inGame.buildSeq, 42);

    /* AND NOT BACKWARDS. A report about build 40 arriving after one about 42 is the
       normal behaviour of a system that retries, and the panel must not show it: this is
       the staleness guard, read from the screen's end rather than from the endpoint's. */
    const stale = await inGame(id, { build_seq: 40, build: '40', engine_status: 'in', open_bugs: 0 });
    assert.strictEqual(stale.body.applied, false, JSON.stringify(stale.body));
    p = await panel('lead', id);
    assert.strictEqual(p.inGame.build, '42', 'a late report about an older build changes nothing');
    assert.strictEqual(p.inGame.openBugs, 2);
  });

  await t.test('every round is listed, with the open one marked', async () => {
    const id = await idleAsset('Buggy');
    const qa = await raise(id, { source: 'qa', bug_ref: 'QA-900', severity: 'blocker',
      note: 'clips through the floor', sender_name: 'Priya', sender_role: 'QA Lead', build: '42' });
    assert.strictEqual(qa.status, 200, JSON.stringify(qa.body));
    assert.strictEqual((await statusOf(id)).status, 'game_feedback', 'an idle asset moves');

    /* A second bug while the first is open. The asset is no longer idle, so this is taken
       as a NOTE and moves nothing — and the panel must still show it, because "what has
       been said about this asset" is the question the block answers. */
    const client = await raise(id, { source: 'client', note: 'the hat is the wrong red',
      sender_name: 'Acme' });
    assert.strictEqual(client.status, 200, JSON.stringify(client.body));

    const p = await panel('lead', id);
    assert.strictEqual(p.rounds.length, 2, 'both are listed');
    const byRef = Object.fromEntries(p.rounds.map((r) => [r.source, r]));
    assert.strictEqual(byRef.qa.bugRef, 'QA-900');
    assert.strictEqual(byRef.qa.severity, 'blocker');
    assert.strictEqual(byRef.qa.senderName, 'Priya');
    assert.strictEqual(byRef.qa.senderRole, 'QA Lead');
    assert.strictEqual(byRef.qa.open, true, 'the one that moved the asset is the open one');
    assert.strictEqual(byRef.client.bugRef, null,
      'a client note has no tracker reference, and null is not an empty string');
    assert.strictEqual(byRef.client.open, false, 'a note moved nothing, so it is not open');
    /* NEWEST FIRST, as far as the column can say. external_feedback.created_at is a
       DATETIME and has one-second granularity, and the table carries no sequence — so two
       rows written inside the same second have no order between them, which is the same
       limitation src/integration-outbox.js documents where it explains why replay is
       ordered by seq and not by a timestamp. Asserted as a set plus the ordering column,
       rather than as a position that a fast test machine decides. */
    const ats = p.rounds.map((r) => new Date(r.at).getTime());
    assert.ok(ats[0] >= ats[1], `ordered by created_at descending: ${JSON.stringify(ats)}`);
    assert.deepStrictEqual(p.rounds.map((r) => r.source).sort(), ['client', 'qa'],
      'and both are there, whichever way a same-second tie fell');
  });

  /* --- the buttons, against what the server actually does -------------------- */

  await t.test('an offered button is a move the server honours; a withheld one is not', async () => {
    /* THE CENTRAL TEST. For each viewer, the panel's `actions` and the POST's answer are
       compared against each other — not against a hand-written expectation of who ought
       to be able to act. That is what makes this a check on drift rather than a second
       statement of the rule: if the two ever disagree, one of them is wrong and this
       fails, whichever it is. */
    const check = async (who, note) => {
      const id = await idleAsset(`Answered by ${who}`);
      const r = await raise(id, { source: 'qa', bug_ref: `QA-${id.slice(0, 6)}`, note: 'broken' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await statusOf(id)).status, 'game_feedback');

      /* A 403 from the panel is the same answer as an empty list — this viewer is offered
         nothing — and it is the honest one for somebody who cannot see the asset at all.
         Read as [] rather than crashing, because what is being compared is what the
         SCREEN would offer. */
      const read = await as(who, `/assets/${id}/game-feedback`);
      const offered = (read.body.actions || []).map((a) => a.action).sort();
      const attempt = await as(who, `/assets/${id}/game-feedback`,
        { method: 'POST', body: { decision: 'pass' } });
      const honoured = attempt.status === 200;
      assert.strictEqual(offered.includes('game_feedback_pass'), honoured,
        `${note}: the panel offered ${JSON.stringify(offered)} and the server answered `
        + `${attempt.status} ${JSON.stringify(attempt.body)}`);
      return { offered, status: attempt.status };
    };

    const lead = await check('lead', 'the project\'s own lead');
    assert.deepStrictEqual(lead.offered, ['game_feedback_decline', 'game_feedback_pass'],
      'the lead gets both answers');

    /* The assignee, who is also the person the bug is about. Nobody reviews their own
       work, whatever they hold — so no buttons, and the server refuses. */
    const artist = await check('artist', 'the artist the asset is assigned to');
    assert.deepStrictEqual(artist.offered, [], 'and is offered neither');
    assert.strictEqual(artist.status, 403);

    /* A lead on another project. Holds review.tl, which is exactly what a
       permission-only check would stop at, and has no standing on this project's work. */
    const other = await check('other', 'a team lead who is not on this project');
    assert.deepStrictEqual(other.offered, [], 'a permission is not standing');
    assert.strictEqual(other.status, 403);

    // Full access reaches a gate nobody staffed them on, and the panel says so.
    const root = await check('root', 'full access');
    assert.ok(root.offered.includes('game_feedback_pass'), 'full access reaches this gate');
  });

  await t.test('nothing is offered on an asset that is not in Game Feedback', async () => {
    const id = await idleAsset('Quiet');
    const p = await panel('lead', id);
    assert.deepStrictEqual(p.actions, [],
      'the machine has no game feedback move from Delivered, so the panel offers none');
    // And the server agrees, which is the same pairing as above.
    const refused = await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  });

  await t.test('declining names the status it would restore to', async () => {
    /* The decline transition's target is `(ctx) => ctx.restoreStatus`, stored per round.
       Without the context the endpoint hands in, the action would come back describing a
       move to nowhere — which is what the panel would then print. */
    const id = await idleAsset('Restorable');
    await raise(id, { source: 'qa', bug_ref: `QA-r-${id.slice(0, 6)}`, note: 'broken' });
    const decline = (await panel('lead', id)).actions.find((a) => a.action === 'game_feedback_decline');
    assert.ok(decline, 'decline is offered');
    assert.strictEqual(decline.to, 'delivered', 'back to where the bug found it');
    assert.strictEqual(decline.requiresNote, true, 'and it needs a reason');
  });

  /* --- the pending list ----------------------------------------------------- */

  /* THE TAB'S OWN GATE, and a Team Lead does not hold it.
   *
   * pending.view is what decides whether there IS a Pending Actions tab, described in
   * src/routes/project-reviews.js as "the studio's own toggle, so the tab can be given or
   * withheld on its own". It ships to Super Admin and not to team_lead — asserted below
   * rather than assumed, because it means a Team Lead sees none of this until a Super
   * Admin switches the tab on for that designation in Settings > Permissions.
   *
   * That is the studio's decision and not this change's to make, so the group is built and
   * the switch is left where it is. Every case below grants it first, the way a studio
   * would, so what is under test is the group and not the gate. */
  await t.test('the Pending Actions tab is the studio\'s switch, and a Team Lead is not given it', async () => {
    const closed = await as('lead', '/project-reviews/pending-actions');
    assert.strictEqual(closed.status, 403,
      'a Team Lead cannot open Pending Actions until the studio grants pending.view');

    const held = await as('root', '/permissions/roles/team_lead');
    const current = held.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(!current.includes('pending.view'), 'and it is not in the designation\'s baseline');

    const grant = await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: [...current, 'pending.view'] } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    tokens.lead = await api(server.base, '/auth/login',
      { method: 'POST', body: { email: 'lead@zvky.test', password: PASSWORD } }).then((r) => r.body.token);
    assert.strictEqual((await as('lead', '/project-reviews/pending-actions')).status, 200,
      'granted, the tab opens');
  });

  await t.test('a bug waiting on the lead appears in Pending Actions, and leaves when answered', async () => {
    /* PER ASSET, NOT PER GROUP. Cases above leave their own bugs open in this queue — the
       two refused viewers could not answer theirs, and nothing tidies them away — so the
       group is already there and asserting on its existence would be asserting on the
       order this file happens to run in. What is under test is whether THIS asset arrives
       and leaves. */
    const listed = async (who) => {
      const p = await pending(who);
      const g = (p.groups || []).find((x) => x.key === 'game_feedback_lead');
      return { ids: (g ? g.items : []).map((i) => i.id), group: g || null, count: p.count };
    };

    const before = await listed('lead');
    const countBefore = before.count;

    const id = await idleAsset('Waiting On The Lead');
    await raise(id, { source: 'qa', bug_ref: `QA-p-${id.slice(0, 6)}`, severity: 'major',
      note: 'falls through the world', sender_name: 'Priya', sender_role: 'QA' });
    /* NOT ROUTED TO ANYBODY, and the list is built on that rather than in spite of it:
       src/routes/integration.js raises a bug with routed_to_id = NULL because Game
       Feedback is a queue and canActAtTlGate is a predicate, not a resolver. "Waiting on
       me" is therefore "in the queue, and I may stand at that gate". */
    const raised = await statusOf(id);
    assert.strictEqual(raised.status, 'game_feedback');
    assert.strictEqual(raised.routed, null, 'a raised bug is a queue, not an assignment');

    const during = await listed('lead');
    assert.ok(during.group, 'the group is there');
    assert.strictEqual(during.group.phase, 'active', 'it is waiting on them, so it is Active');
    assert.strictEqual(during.group.act, 'open',
      'and it opens the asset rather than asking them to type');
    assert.ok(during.ids.includes(id), 'and this asset is in it');
    const item = during.group.items.find((i) => i.id === id);
    assert.strictEqual(item.source, 'qa', 'and the bug that is being answered');
    assert.strictEqual(item.bugRef, `QA-p-${id.slice(0, 6)}`);
    assert.strictEqual(item.senderName, 'Priya');
    assert.strictEqual(item.assigneeName, 'artist', 'and who it would be passed to');
    assert.strictEqual(item.projectName, 'Shipped Game');
    assert.strictEqual(during.count, countBefore + 1, 'and the badge counts it');

    /* NOT ON SOMEBODY ELSE'S LIST, and this is the gate doing the work rather than a
       routing column: the asset is routed to nobody, so what keeps it off these two lists
       is canActAtTlGate refusing a lead who is not on the project and refusing the artist
       the asset is assigned to. Both hold no pending.view either, so the tab is closed to
       them twice over — which is why this reads the status as well as the list. */
    for (const who of ['other', 'artist']) {
      const seen = await as(who, '/project-reviews/pending-actions');
      if (seen.status === 200) {
        const g = (seen.body.groups || []).find((x) => x.key === 'game_feedback_lead');
        assert.ok(!(g ? g.items : []).some((i) => i.id === id), `${who} is not asked to answer it`);
      } else {
        assert.strictEqual(seen.status, 403, `${who} cannot open the tab at all`);
      }
    }

    /* Answered: passing routes the asset to the artist, which is what takes it out of the
       queue. The status is still game_feedback — the bug is still open — so a list built
       on the status alone would go on asking the lead to answer something they already
       have. That is the case this assertion is really about. */
    const passed = await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(passed.status, 200, JSON.stringify(passed.body));
    const answered = await statusOf(id);
    assert.strictEqual(answered.routed, ids.artist, 'it is with the artist now');
    assert.strictEqual(answered.status, 'game_feedback', 'and the bug is still open');

    const after = await listed('lead');
    assert.ok(!after.ids.includes(id), 'and it leaves the lead\'s list');
    assert.strictEqual(after.count, countBefore, 'and the badge drops back');
  });

  await t.test('declining takes it off the list too, by putting the asset back', async () => {
    const inList = async () => {
      const g = ((await pending('lead')).groups || []).find((x) => x.key === 'game_feedback_lead');
      return (g ? g.items : []).map((i) => i.id);
    };
    const id = await idleAsset('Declined');
    await raise(id, { source: 'qa', bug_ref: `QA-d-${id.slice(0, 6)}`, note: 'not our asset' });
    assert.ok((await inList()).includes(id), 'it is waiting');

    const declined = await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'decline', reason: 'that is the engine\'s shader' } });
    assert.strictEqual(declined.status, 200, JSON.stringify(declined.body));
    assert.strictEqual((await statusOf(id)).status, 'delivered', 'back where the bug found it');
    assert.ok(!(await inList()).includes(id), 'and off the list');
  });

  await t.test('the lead is told although they hold none of the project review permissions', async () => {
    /* THE ORDERING, and it is the whole reason gameFeedbackAwaiting is called before the
       early return rather than beside the other groups.
     *
     * A Team Lead holds NONE of project.review_respond, _queue or _mine — checked here
     * rather than assumed, because the first version of this test assumed the opposite and
     * tried to take them away. So that early return, which answers "nothing is waiting on
     * you" to anybody outside the project review workflow, covers every Team Lead in the
     * studio. Built inside it, this group would have been invisible to precisely the
     * designation it is addressed to, on every deployment, and the tab would have looked
     * like it was working. */
    const held = await as('root', '/permissions/roles/team_lead');
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    const current = held.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.deepStrictEqual(current.filter((k) => k.startsWith('project.review_')), [],
      'a Team Lead is outside the project review workflow, which is what makes the ordering matter');
    assert.ok(current.includes('review.tl'), 'and holds the review standing this group asks for');
    assert.ok(current.includes('pending.view'), 'and the tab, granted by the case above');

    const id = await idleAsset('Still Told');
    await raise(id, { source: 'qa', bug_ref: `QA-s-${id.slice(0, 6)}`, note: 'broken' });
    const p = await pending('lead');
    const group = (p.groups || []).find((g) => g.key === 'game_feedback_lead');
    assert.ok(group, 'game feedback is not the project review workflow\'s to withhold');
    assert.ok(group.items.some((i) => i.id === id));
    assert.ok(p.count >= 1, 'and it counts toward the badge');

    /* review.tl IS the switch, though: a lead whose review standing has been withdrawn is
       not asked to answer. Put back in the finally, because every later case in this file
       reads the lead's list. */
    const without = current.filter((k) => k !== 'review.tl');
    const off = await as('root', '/permissions/roles/team_lead',
      { method: 'PUT', body: { permissions: without } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    try {
      assert.ok(!((await pending('lead')).groups || []).some((g) => g.key === 'game_feedback_lead'),
        'without review.tl there is nothing to ask them');
    } finally {
      await as('root', '/permissions/roles/team_lead', { method: 'PUT', body: { permissions: current } });
    }
    // And back on again once it is restored, so the revoke is not a one-way door.
    assert.ok(((await pending('lead')).groups || []).some((g) => g.key === 'game_feedback_lead'),
      'and it comes back when the permission does');
    await as('lead', `/assets/${id}/game-feedback`, { method: 'POST', body: { decision: 'pass' } });
  });

  /* --- the board ------------------------------------------------------------ */

  await t.test('the board column fills and empties as the asset moves through it', async () => {
    /* The column is rendered from the asset list the board reads, so what is asserted is
       that list: an asset in game_feedback is in it with that status, and is not once it
       has left. Rendering is the page's, and is covered without a server above. */
    const id = await idleAsset('On The Board');
    const inColumn = async (who) => {
      const r = await as(who, `/assets/project/${ids.project}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      return r.body.assets.filter((a) => a.status === 'game_feedback').map((a) => a.id);
    };
    assert.ok(!(await inColumn('lead')).includes(id), 'not there while it is Delivered');

    await raise(id, { source: 'qa', bug_ref: `QA-b-${id.slice(0, 6)}`, note: 'broken' });
    assert.ok((await inColumn('lead')).includes(id), 'in the column once the bug lands');
    assert.ok((await inColumn('artist')).includes(id),
      'and the artist sees it too — the column is not gated, and they are about to be handed it');

    const passed = await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(passed.status, 200, JSON.stringify(passed.body));
    assert.ok((await inColumn('lead')).includes(id),
      'a pass keeps it in the column — the status says a bug is open, routing says whose move it is');

    /* HOW IT LEAVES THE COLUMN: the artist hands the fix in, like any other round.
     *
     * This case used to assert the opposite, because it used to be true — submit had no
     * transition from game_feedback and the lead could not hand the round on either, so
     * an artist holding a passed-along bug had no move at all. Both are now transitions
     * the machine defines, and this is the case that went red when they were added. */
    const fixed = await as('artist', `/assets/${id}/submit`,
      { method: 'POST', body: { link: 'https://example.com/fixed' } });
    assert.strictEqual(fixed.status, 201, JSON.stringify(fixed.body));
    assert.ok(!(await inColumn('lead')).includes(id), 'and it leaves the column');
    assert.strictEqual((await statusOf(id)).status, 'pending_tl_review',
      'back at the gate that answered the bug in the first place');
  });
});
